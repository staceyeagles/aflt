'use strict';

/**
 * OpenCode CLI engine (`opencode` from https://opencode.ai / sst/opencode).
 *
 * Verified against local install layout (OpenCode 1.19.x):
 *   binary: opencode on PATH (override AGENTFLEET_OPENCODE_BIN)
 *   data:   ~/.local/share/opencode/opencode.db (+ log/, storage/)
 *   session ids: ses_* (not UUIDs)
 *
 * Headless: `opencode run [--session <id>] [--model <provider/model>]
 *   [--format default|json] <prompt>` (cwd via spawn cwd).
 * Interactive: `opencode [--session <id>] [--model …] [--prompt …]`.
 * Resume / continue: `--session <id>` (same as Copilot --session-id);
 *   `--continue` is available for “last session” but aflt always prefers an
 *   explicit recorded chatId.
 *
 * Turn capture reads opencode.db READ-ONLY via node:sqlite when available.
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { which, homeDir, escapeShellArg, shortId } = require('./util');

const SESSION_ID_RE = /^ses_[A-Za-z0-9]+$/;
const DEFAULT_SERVE_HOST = '127.0.0.1';

function resolveOpencodeBin() {
  if (process.env.AGENTFLEET_OPENCODE_BIN) return process.env.AGENTFLEET_OPENCODE_BIN;
  return which('opencode') || 'opencode';
}

function opencodeAvailable() {
  return Boolean(which('opencode') || process.env.AGENTFLEET_OPENCODE_BIN);
}

/**
 * OpenCode data home (`~/.local/share/opencode`).
 * Precedence: AGENTFLEET_OPENCODE_HOME > XDG_DATA_HOME/opencode > ~/.local/share/opencode
 */
function resolveOpencodeHome(env = process.env) {
  if (env.AGENTFLEET_OPENCODE_HOME) {
    return path.resolve(String(env.AGENTFLEET_OPENCODE_HOME));
  }
  if (env.XDG_DATA_HOME) {
    return path.join(path.resolve(String(env.XDG_DATA_HOME)), 'opencode');
  }
  return path.join(homeDir(), '.local', 'share', 'opencode');
}

function resolveDbPath(env = process.env) {
  if (env.AGENTFLEET_OPENCODE_DB) {
    return path.resolve(String(env.AGENTFLEET_OPENCODE_DB));
  }
  return path.join(resolveOpencodeHome(env), 'opencode.db');
}

function isSafeSessionId(id) {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

function dryRunSessionId() {
  return 'ses_dryrun00000000000000000000';
}

/**
 * Map aflt --output-format to OpenCode --format.
 * text → omit / default; json → json.
 */
function mapOutputFormat(outputFormat) {
  const fmt = outputFormat || 'text';
  if (fmt === 'text' || fmt === 'default') return 'default';
  if (fmt === 'json') return 'json';
  throw new Error(`unsupported opencode --output-format: ${fmt} (want text or json)`);
}

/**
 * Headless argv (without binary): `opencode run … <prompt>`.
 */
function buildPrintArgs(session, { prompt, force = false, outputFormat = 'text' } = {}) {
  if (!prompt) throw new Error('prompt is required for an OpenCode headless run');
  const args = ['run'];
  const fmt = mapOutputFormat(outputFormat);
  if (fmt !== 'default') args.push('--format', fmt);
  if (session && session.chatId) {
    if (!isSafeSessionId(session.chatId)) {
      throw new Error(`invalid OpenCode session id: ${session.chatId}`);
    }
    args.push('--session', session.chatId);
  }
  if (session && session.model) args.push('--model', String(session.model));
  // OpenCode permission grants vary by version; do not invent CLI flags.
  // Callers may warn that --force is a no-op for OpenCode headless.
  void force;
  args.push(String(prompt));
  return args;
}

function buildPrintCommand(session, opts = {}) {
  return [resolveOpencodeBin(), ...buildPrintArgs(session, opts)];
}

/**
 * Interactive argv (without binary).
 * Does NOT fall back to session.prompt — pass opts.prompt only for first
 * launch (`af new --prompt`) or an explicit `--prompt` on that resume.
 */
function buildInteractiveArgs(session, { prompt, force = false } = {}) {
  if (!session || !session.chatId) {
    throw new Error('chatId (OpenCode session id) is required for interactive launch');
  }
  if (!isSafeSessionId(session.chatId)) {
    throw new Error(`invalid OpenCode session id: ${session.chatId}`);
  }
  const args = ['--session', session.chatId];
  if (session.model) args.push('--model', String(session.model));
  if (typeof prompt === 'string' && prompt) args.push('--prompt', prompt);
  // Same as Cursor interactive: --force does not change OpenCode argv yet.
  void force;
  return args;
}

function buildInteractiveCommand(session, opts = {}) {
  return [resolveOpencodeBin(), ...buildInteractiveArgs(session, opts)];
}

function buildInteractiveCommandString(session, opts = {}) {
  return buildInteractiveCommand(session, opts).map(escapeShellArg).join(' ');
}

/**
 * Parse a session id from OpenCode `--format json` stdout (JSONL or single JSON).
 */
function extractSessionIdFromOutput(text) {
  const s = String(text || '');
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch (_) {
      continue;
    }
    const id =
      (obj && obj.sessionID) ||
      (obj && obj.sessionId) ||
      (obj && obj.session && obj.session.id) ||
      (obj && obj.properties && (obj.properties.sessionID || obj.properties.sessionId)) ||
      (obj && obj.part && (obj.part.sessionID || obj.part.sessionId)) ||
      null;
    if (isSafeSessionId(id)) return id;
  }
  const m = s.match(/\bses_[A-Za-z0-9]+\b/);
  return m && isSafeSessionId(m[0]) ? m[0] : null;
}

function pickFreePort() {
  return 41000 + Math.floor(Math.random() * 20000);
}

function httpJson(method, url, body, { timeoutMs = 5000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body == null ? null : JSON.stringify(body);
    const req = http.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method,
        headers: {
          Accept: 'application/json',
          ...(payload
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
        },
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          let parsed = null;
          if (data.trim()) {
            try {
              parsed = JSON.parse(data);
            } catch (_) {
              parsed = data;
            }
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, body: parsed });
          } else {
            const err = new Error(
              `OpenCode HTTP ${res.statusCode}: ${typeof parsed === 'string' ? parsed : JSON.stringify(parsed)}`
            );
            err.status = res.statusCode;
            err.body = parsed;
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('OpenCode HTTP request timed out'));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Create an empty OpenCode session via a short-lived `opencode serve` + POST /session.
 * Returns the engine session id (`ses_…`).
 */
function createSession({ cwd, title, timeoutMs = 25000 } = {}) {
  const bin = resolveOpencodeBin();
  const directory = cwd ? path.resolve(String(cwd)) : process.cwd();
  const port = pickFreePort();
  const host = DEFAULT_SERVE_HOST;

  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['serve', `--hostname=${host}`, `--port=${port}`], {
      cwd: directory,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let settled = false;
    let output = '';
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGTERM');
      } catch (_) {
        /* ignore */
      }
      reject(
        new Error(
          `opencode serve timed out after ${timeoutMs}ms while creating a session. stderr/stdout: ${output.trim().slice(0, 400)}`
        )
      );
    }, timeoutMs);

    const finish = (err, id) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill('SIGTERM');
      } catch (_) {
        /* ignore */
      }
      if (err) reject(err);
      else resolve(id);
    };

    const onChunk = (buf) => {
      output += buf.toString('utf8');
      if (settled) return;
      if (!/opencode server listening/i.test(output)) return;
      const match = output.match(/on\s+(https?:\/\/[^\s]+)/i);
      const base = match ? match[1].replace(/\/$/, '') : `http://${host}:${port}`;
      const q = new URLSearchParams({ directory });
      const url = `${base}/session?${q.toString()}`;
      httpJson('POST', url, title ? { title: String(title) } : {}, { timeoutMs: 8000 })
        .then((res) => {
          const id =
            (res.body && res.body.id) ||
            (res.body && res.body.session && res.body.session.id) ||
            null;
          if (!isSafeSessionId(id)) {
            finish(
              new Error(
                `opencode session create returned no ses_* id: ${JSON.stringify(res.body).slice(0, 200)}`
              )
            );
            return;
          }
          finish(null, id);
        })
        .catch((err) => finish(err));
    };

    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    child.on('error', (err) => finish(err));
    child.on('close', (code) => {
      if (settled) return;
      finish(
        new Error(
          `opencode serve exited ${code} before session create. output: ${output.trim().slice(0, 400)}`
        )
      );
    });
  });
}

/* ─── Read-only SQLite helpers (node:sqlite) ─── */

function loadSqliteSync() {
  try {
    // Node ≥22.5 (stable node:sqlite); may be missing on Node 18/20.
    return require('node:sqlite');
  } catch (err) {
    const e = new Error(
      'OpenCode turn capture requires Node.js built-in node:sqlite (Node ≥22.5). ' +
        `This runtime (${process.version}) does not provide it. Upgrade Node, or skip OpenCode backfill.`
    );
    e.code = 'OPENCODE_SQLITE_UNAVAILABLE';
    e.cause = err;
    throw e;
  }
}

/**
 * Open opencode.db read-only. Never writes.
 * @returns {{ db: object, close: function }}
 */
function openDatabaseReadonly(dbPath, opts = {}) {
  const file = dbPath || resolveDbPath(opts.env || process.env);
  if (!file || !fs.existsSync(file)) {
    const err = new Error(`OpenCode database not found: ${file || '(unset)'}`);
    err.code = 'OPENCODE_DB_MISSING';
    throw err;
  }
  const { DatabaseSync } = loadSqliteSync();
  let db;
  try {
    db = new DatabaseSync(file, { readOnly: true });
  } catch (err) {
    // Some Node builds want URI mode for read-only with WAL.
    try {
      const uri = file.startsWith('file:') ? file : `file:${file}?mode=ro`;
      db = new DatabaseSync(uri, { readOnly: true });
    } catch (err2) {
      const e = new Error(`failed to open OpenCode db read-only: ${err2.message || err.message}`);
      e.code = 'OPENCODE_DB_OPEN';
      e.cause = err2;
      throw e;
    }
  }
  return {
    db,
    path: file,
    close() {
      try {
        db.close();
      } catch (_) {
        /* ignore */
      }
    },
  };
}

function tableNames(db) {
  try {
    return db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`)
      .all()
      .map((r) => String(r.name));
  } catch (_) {
    return [];
  }
}

function tableColumns(db, table) {
  const name = String(table || '').replace(/[^A-Za-z0-9_]/g, '');
  if (!name) return [];
  try {
    return db.prepare(`PRAGMA table_info(${name})`).all().map((r) => String(r.name));
  } catch (_) {
    return [];
  }
}

function parseJsonColumn(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') return raw;
  try {
    return JSON.parse(String(raw));
  } catch (_) {
    return null;
  }
}

function msToIso(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return null;
  // OpenCode stores ms since epoch; tolerate seconds.
  const msVal = n < 1e12 ? n * 1000 : n;
  try {
    return new Date(msVal).toISOString();
  } catch (_) {
    return null;
  }
}

/**
 * List sessions from opencode.db (read-only).
 */
function listLocalSessions({ limit = 50, cwd = null, env = process.env } = {}) {
  let handle;
  try {
    handle = openDatabaseReadonly(resolveDbPath(env), { env });
  } catch (err) {
    if (err && (err.code === 'OPENCODE_DB_MISSING' || err.code === 'OPENCODE_SQLITE_UNAVAILABLE')) {
      return [];
    }
    throw err;
  }
  try {
    const db = handle.db;
    const names = tableNames(db);
    if (!names.includes('session')) return [];
    const cols = tableColumns(db, 'session');
    const hasData = cols.includes('data');
    let rows;
    if (hasData) {
      rows = db.prepare(`SELECT * FROM session ORDER BY rowid DESC`).all();
    } else {
      const orderCol = cols.includes('time_updated')
        ? 'time_updated'
        : cols.includes('time_created')
          ? 'time_created'
          : 'rowid';
      rows = db.prepare(`SELECT * FROM session ORDER BY ${orderCol} DESC`).all();
    }
    const out = [];
    for (const row of rows) {
      const sess = normalizeSessionRow(row);
      if (!sess || !sess.id) continue;
      if (cwd) {
        const want = path.resolve(String(cwd));
        const got = sess.cwd ? path.resolve(String(sess.cwd)) : null;
        if (!got || got !== want) continue;
      }
      out.push(sess);
      if (out.length >= Math.max(0, Number(limit) || 0)) break;
    }
    return out;
  } finally {
    handle.close();
  }
}

function normalizeSessionRow(row) {
  if (!row) return null;
  const data = parseJsonColumn(row.data);
  const id = row.id || (data && data.id) || null;
  if (!id) return null;
  const directory =
    row.directory ||
    (data && data.directory) ||
    row.cwd ||
    (data && data.path && data.path.cwd) ||
    null;
  const title = row.title || (data && data.title) || `opencode-${shortId(id)}`;
  const created =
    msToIso(row.time_created) ||
    (data && data.time && msToIso(data.time.created)) ||
    null;
  const updated =
    msToIso(row.time_updated) ||
    (data && data.time && msToIso(data.time.updated)) ||
    created;
  return {
    id: String(id),
    cwd: directory ? path.resolve(String(directory)) : null,
    title: String(title),
    created,
    updated,
  };
}

function getLocalSession(id, { env = process.env } = {}) {
  const q = String(id || '').trim();
  if (!q) return null;
  const all = listLocalSessions({ limit: 500, env });
  if (isSafeSessionId(q)) {
    return all.find((s) => s.id === q) || null;
  }
  if (q.length < 8) {
    const err = new Error(`session id prefix too short (need ≥8 chars): ${q}`);
    err.code = 'PREFIX_TOO_SHORT';
    throw err;
  }
  const ql = q.toLowerCase();
  const matches = all.filter((s) => s.id.toLowerCase().startsWith(ql));
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    const err = new Error(
      `ambiguous session id prefix ${q}: ${matches
        .slice(0, 5)
        .map((s) => s.id)
        .join(', ')}${matches.length > 5 ? '…' : ''}`
    );
    err.code = 'AMBIGUOUS_PREFIX';
    throw err;
  }
  return matches[0];
}

function partTextFromData(data) {
  if (!data || typeof data !== 'object') return null;
  if (data.type === 'text' && typeof data.text === 'string') {
    if (data.synthetic === true || data.ignored === true) return null;
    return data.text;
  }
  if (typeof data.text === 'string' && data.text.trim() && !data.type) return data.text;
  return null;
}

function messageRoleFromData(data, row) {
  if (data && typeof data.role === 'string') return String(data.role).toLowerCase();
  if (row && typeof row.role === 'string') return String(row.role).toLowerCase();
  return null;
}

/**
 * Read user↔assistant turns for one OpenCode session from sqlite (read-only).
 * Pairs each user text part with the following assistant text (final reply).
 */
function iterSessionTurns(sessionId, { env = process.env, dbPath = null } = {}) {
  const records = [];
  const errors = [];
  if (!isSafeSessionId(sessionId)) {
    return { records, errors: [`invalid session id: ${sessionId}`] };
  }
  let handle;
  try {
    handle = openDatabaseReadonly(dbPath || resolveDbPath(env), { env });
  } catch (err) {
    return {
      records,
      errors: [err.message || String(err)],
      unavailable: err.code === 'OPENCODE_SQLITE_UNAVAILABLE',
      code: err.code || null,
    };
  }
  try {
    const db = handle.db;
    const names = tableNames(db);
    if (!names.includes('message') || !names.includes('part')) {
      return {
        records,
        errors: [`unexpected OpenCode schema (need message+part tables); found: ${names.join(',')}`],
      };
    }
    const msgCols = tableColumns(db, 'message');
    const partCols = tableColumns(db, 'part');
    const sessionCol = msgCols.includes('session_id')
      ? 'session_id'
      : msgCols.includes('sessionID')
        ? 'sessionID'
        : null;
    if (!sessionCol) {
      return { records, errors: ['message table missing session_id column'] };
    }

    const messages = db
      .prepare(
        `SELECT * FROM message WHERE ${sessionCol} = ? ORDER BY ${
          msgCols.includes('time_created') ? 'time_created' : 'rowid'
        } ASC`
      )
      .all(sessionId);

    const partSessionCol = partCols.includes('session_id')
      ? 'session_id'
      : partCols.includes('sessionID')
        ? 'sessionID'
        : null;
    const partMsgCol = partCols.includes('message_id')
      ? 'message_id'
      : partCols.includes('messageID')
        ? 'messageID'
        : null;
    if (!partMsgCol) {
      return { records, errors: ['part table missing message_id column'] };
    }

    let parts;
    if (partSessionCol) {
      parts = db
        .prepare(
          `SELECT * FROM part WHERE ${partSessionCol} = ? ORDER BY ${
            partCols.includes('time_created') ? 'time_created' : 'rowid'
          } ASC`
        )
        .all(sessionId);
    } else {
      parts = db
        .prepare(
          `SELECT * FROM part ORDER BY ${partCols.includes('time_created') ? 'time_created' : 'rowid'} ASC`
        )
        .all()
        .filter((p) => {
          const mid = p[partMsgCol];
          return messages.some((m) => m.id === mid);
        });
    }

    const partsByMessage = new Map();
    for (const p of parts) {
      const mid = p[partMsgCol];
      if (!mid) continue;
      if (!partsByMessage.has(mid)) partsByMessage.set(mid, []);
      partsByMessage.get(mid).push(p);
    }

    let pendingUser = null;
    for (const msg of messages) {
      const data = parseJsonColumn(msg.data) || {};
      const role = messageRoleFromData(data, msg);
      const msgParts = partsByMessage.get(msg.id) || [];
      const texts = [];
      let stepFinishTokens = null;
      let stepFinishCost = null;
      for (const p of msgParts) {
        const pdata = parseJsonColumn(p.data) || p;
        const text = partTextFromData(pdata);
        if (text != null && String(text).trim()) texts.push(String(text));
        const ptype = String(pdata.type || pdata.part || '').toLowerCase();
        if (
          (ptype === 'step-finish' || ptype === 'step_finish') &&
          pdata.tokens &&
          typeof pdata.tokens === 'object'
        ) {
          stepFinishTokens = pdata.tokens;
          if (pdata.cost != null) stepFinishCost = pdata.cost;
        }
      }
      // Fallback: some schemas embed text on the message itself.
      if (!texts.length && typeof data.text === 'string' && data.text.trim()) {
        texts.push(data.text);
      }
      // Message-level tokens (some OpenCode schemas).
      if (!stepFinishTokens && data.tokens && typeof data.tokens === 'object') {
        stepFinishTokens = data.tokens;
        if (data.cost != null) stepFinishCost = data.cost;
      }
      const joined = texts.join('\n').trim();
      const at =
        msToIso(msg.time_created) ||
        (data.time && msToIso(data.time.completed || data.time.created)) ||
        null;

      if (role === 'user') {
        if (joined) pendingUser = { text: joined, at, id: msg.id };
        continue;
      }
      if (role === 'assistant' && joined && pendingUser) {
        const rec = {
          engineEventId: msg.id,
          at: at || pendingUser.at || null,
          prompt: pendingUser.text,
          promptSource: 'opencode-db-user',
          reply: joined,
          replySource: 'opencode-db-assistant',
          source: 'opencode-db',
        };
        if (stepFinishTokens) {
          rec.tokens = stepFinishTokens;
          if (stepFinishCost != null) rec.cost = stepFinishCost;
        } else if (data.cost != null) {
          rec.cost = data.cost;
        }
        records.push(rec);
        pendingUser = null;
      }
    }
    return { records, errors };
  } finally {
    handle.close();
  }
}

/**
 * Build a minimal OpenCode-compatible sqlite fixture for hermetic tests.
 * Requires node:sqlite. Creates session/message/part with JSON `data` columns.
 */
function writeFixtureDb(dbPath, { sessionId, directory, turns } = {}) {
  const { DatabaseSync } = loadSqliteSync();
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
  const db = new DatabaseSync(dbPath);
  try {
    db.exec(`
      CREATE TABLE session (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL,
        directory TEXT NOT NULL,
        parent_id TEXT,
        title TEXT NOT NULL,
        version TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        time_updated INTEGER NOT NULL
      );
      CREATE TABLE message (
        id TEXT PRIMARY KEY NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE part (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        time_created INTEGER,
        data TEXT NOT NULL
      );
    `);
    const now = Date.now();
    const sid = sessionId || 'ses_fixture00000000000000001';
    db.prepare(
      `INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(sid, 'test', directory || '/tmp/opencode-fixture', 'fixture', '1.19.5', now, now);

    let t = now;
    let n = 0;
    for (const turn of turns || []) {
      n += 1;
      const userId = `msg_user${String(n).padStart(4, '0')}000000000000`;
      const asstId = `msg_asst${String(n).padStart(4, '0')}000000000000`;
      t += 1000;
      db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
        userId,
        sid,
        t,
        JSON.stringify({ id: userId, sessionID: sid, role: 'user', time: { created: t } })
      );
      db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`
      ).run(
        `prt_u${n}`,
        userId,
        sid,
        t,
        JSON.stringify({
          id: `prt_u${n}`,
          sessionID: sid,
          messageID: userId,
          type: 'text',
          text: String(turn.prompt || ''),
        })
      );
      t += 1000;
      db.prepare(`INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)`).run(
        asstId,
        sid,
        t,
        JSON.stringify({
          id: asstId,
          sessionID: sid,
          role: 'assistant',
          parentID: userId,
          time: { created: t, completed: t + 10 },
        })
      );
      db.prepare(
        `INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)`
      ).run(
        `prt_a${n}`,
        asstId,
        sid,
        t,
        JSON.stringify({
          id: `prt_a${n}`,
          sessionID: sid,
          messageID: asstId,
          type: 'text',
          text: String(turn.reply || ''),
        })
      );
    }
    return { sessionId: sid, path: dbPath };
  } finally {
    db.close();
  }
}

/**
 * Parse `opencode run --format json` stdout (JSONL events).
 * Extracts assistant text parts and step_finish / step-finish tokens + cost.
 *
 * @returns {{
 *   result: string,
 *   usage: object|null,
 *   model: string|null,
 *   sessionId: string|null,
 *   events: object[]
 * }}
 */
function parseOpenCodeJsonOutput(stdout, opts = {}) {
  const usageLib = require('./usage');
  const text = String(stdout == null ? '' : stdout);
  const events = [];
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t[0] !== '{') continue;
    try {
      events.push(JSON.parse(t));
    } catch (_) {
      /* skip */
    }
  }
  if (!events.length && text.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(text.trim());
      if (Array.isArray(parsed)) events.push(...parsed);
      else if (parsed && typeof parsed === 'object') events.push(parsed);
    } catch (_) {
      /* ignore */
    }
  }

  const textParts = [];
  let usage = null;
  let model = opts.model != null ? String(opts.model) : null;
  let sessionId = null;
  let lastCost = null;

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue;
    const part = ev.part && typeof ev.part === 'object' ? ev.part : ev;
    const type = String(part.type || ev.type || '').toLowerCase();
    if (part.sessionID || part.sessionId || ev.sessionID || ev.sessionId) {
      sessionId = String(part.sessionID || part.sessionId || ev.sessionID || ev.sessionId);
    }
    if (type === 'text' && typeof part.text === 'string' && part.synthetic !== true) {
      if (String(part.text).trim()) textParts.push(String(part.text));
    }
    if (type === 'step-finish' || type === 'step_finish') {
      const tokens = part.tokens || (ev.tokens && typeof ev.tokens === 'object' ? ev.tokens : null);
      const cost = part.cost != null ? part.cost : ev.cost;
      if (cost != null) lastCost = cost;
      if (tokens) {
        const normalized = usageLib.normalizeOpenCodeUsage(
          { tokens, cost: cost != null ? cost : lastCost },
          {
            source: 'opencode-run-json',
            model,
          }
        );
        if (normalized) usage = normalized;
      }
    }
    if (ev.model || part.model) model = String(ev.model || part.model);
  }

  const result = textParts.length ? textParts.join('') : text;
  if (!usage && lastCost != null) {
    usage = usageLib.normalizeOpenCodeUsage(
      { tokens: { input: 0, output: 0, reasoning: 0, total: 0, cache: { read: 0, write: 0 } }, cost: lastCost },
      { source: 'opencode-run-json', model, allowZero: true, accuracy: 'partial' }
    );
  }

  return { result, usage, model, sessionId, events };
}

module.exports = {
  SESSION_ID_RE,
  resolveOpencodeBin,
  opencodeAvailable,
  resolveOpencodeHome,
  resolveDbPath,
  isSafeSessionId,
  dryRunSessionId,
  mapOutputFormat,
  buildPrintArgs,
  buildPrintCommand,
  buildInteractiveArgs,
  buildInteractiveCommand,
  buildInteractiveCommandString,
  extractSessionIdFromOutput,
  createSession,
  openDatabaseReadonly,
  listLocalSessions,
  getLocalSession,
  iterSessionTurns,
  writeFixtureDb,
  loadSqliteSync,
  parseOpenCodeJsonOutput,
};
