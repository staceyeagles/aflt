'use strict';

/**
 * Full session purge + orphan scanner.
 *
 * Purge deletes (when mapping is certain): engine chat dirs, optional Cursor
 * transcripts, runs/<id>/, results/plans, master message logs, then the
 * registry row. Never touches Herdr panes. Dry-run by default; mutations
 * require apply:true.
 *
 * Orphans: scan-only by default; selective purge with explicit ids + apply.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const archiveLib = require('./archive');
const copilot = require('./copilot');
const cursor = require('./cursor');
const orchestrate = require('./orchestrate');
const registry = require('./registry');
const turns = require('./turns');
const { fleetDir, homeDir, nowIso } = require('./util');

const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const DEFAULT_ORPHAN_DAYS = 30;
const ORPHAN_CATEGORIES = Object.freeze([
  'missing-cwd',
  'stale-empty',
  'orphan-runs',
  'archived-old',
  'orphan-engine-chat',
  'herdr-orphan-pane',
]);

function isSafeChatId(chatId) {
  return typeof chatId === 'string' && UUID_RE.test(chatId);
}

function cursorHome(env = process.env) {
  if (typeof turns.cursorHome === 'function') return turns.cursorHome(env);
  if (env.AGENTFLEET_CURSOR_HOME) return path.resolve(String(env.AGENTFLEET_CURSOR_HOME));
  return path.join(homeDir(), '.cursor');
}

function isDir(p) {
  try {
    const st = fs.lstatSync(p);
    return !st.isSymbolicLink() && st.isDirectory();
  } catch (_) {
    return false;
  }
}

function isFile(p) {
  try {
    const st = fs.lstatSync(p);
    return !st.isSymbolicLink() && st.isFile();
  } catch (_) {
    return false;
  }
}

/**
 * Resolve Cursor CLI chat directory for a session (certain mapping only).
 * @returns {{ status: 'found'|'missing'|'ambiguous'|'invalid'|'skipped', path: string|null, hits?: string[] }}
 */
function resolveCursorChatDir(session, env = process.env) {
  const chatId = session && session.chatId != null ? String(session.chatId) : '';
  if (!isSafeChatId(chatId)) {
    return { status: 'invalid', path: null };
  }
  const root = path.join(cursorHome(env), 'chats');
  const cwd = session.cwd != null ? String(session.cwd) : '';
  if (cwd) {
    const expected = path.join(root, cursor.workspaceHash(cwd), chatId);
    if (isDir(expected)) return { status: 'found', path: expected };
  }
  if (!isDir(root)) return { status: 'missing', path: null };
  const hits = [];
  let hashes;
  try {
    hashes = fs.readdirSync(root);
  } catch (_) {
    return { status: 'missing', path: null };
  }
  for (const hash of hashes) {
    if (!hash || hash.startsWith('.')) continue;
    const candidate = path.join(root, hash, chatId);
    if (isDir(candidate)) hits.push(candidate);
  }
  if (hits.length === 0) return { status: 'missing', path: null };
  if (hits.length > 1) return { status: 'ambiguous', path: null, hits };
  return { status: 'found', path: hits[0] };
}

/**
 * Resolve Copilot session-state directory (certain UUID mapping only).
 * @returns {{ status: 'found'|'missing'|'invalid'|'skipped', path: string|null, lockPath?: string|null }}
 */
function resolveCopilotSessionDir(session, env = process.env) {
  const chatId = session && session.chatId != null ? String(session.chatId) : '';
  if (!isSafeChatId(chatId)) {
    return { status: 'invalid', path: null };
  }
  const dir = path.join(copilot.sessionStateRoot(env), chatId);
  const lockPath = path.join(
    copilot.sessionStateRoot(env),
    '.session-operation-locks',
    `${chatId}.lock`
  );
  if (!isDir(dir)) {
    return {
      status: 'missing',
      path: null,
      lockPath: isFile(lockPath) ? lockPath : null,
    };
  }
  return {
    status: 'found',
    path: dir,
    lockPath: isFile(lockPath) ? lockPath : null,
  };
}

/**
 * Resolve optional Cursor agent-transcripts/<chatId>/ (unique only).
 */
function resolveCursorTranscriptDir(session, env = process.env) {
  const chatId = session && session.chatId != null ? String(session.chatId) : '';
  if (!isSafeChatId(chatId)) return { status: 'invalid', path: null };
  if (typeof turns.findCursorTranscriptDir === 'function') {
    return turns.findCursorTranscriptDir(chatId, env);
  }
  return { status: 'missing', path: null };
}

function resolveEnginePaths(session, opts = {}) {
  const env = opts.env || process.env;
  const engine = session && session.engine ? String(session.engine) : 'cursor';
  const out = {
    engine,
    chat: { status: 'skipped', path: null },
    transcript: { status: 'skipped', path: null },
    locks: [],
  };
  if (opts.noEngine || opts.afltOnly) {
    out.chat = { status: 'skipped', path: null, reason: 'no-engine' };
    out.transcript = { status: 'skipped', path: null, reason: 'no-engine' };
    return out;
  }
  if (engine === 'copilot') {
    const cop = resolveCopilotSessionDir(session, env);
    out.chat = { status: cop.status, path: cop.path };
    if (cop.lockPath) out.locks.push(cop.lockPath);
  } else {
    out.chat = resolveCursorChatDir(session, env);
    if (!opts.noTranscripts) {
      out.transcript = resolveCursorTranscriptDir(session, env);
    } else {
      out.transcript = { status: 'skipped', path: null, reason: 'no-transcripts' };
    }
  }
  return out;
}

/**
 * Paths a full purge would delete for one session.
 * @returns {{
 *   files: string[],
 *   dirs: string[],
 *   engine: object,
 *   skipped: { path?: string, reason: string }[],
 *   registryId: string|null
 * }}
 */
function sessionPurgePaths(session, opts = {}) {
  const home = path.resolve(opts.home || fleetDir());
  const files = [];
  const dirs = [];
  const skipped = [];
  const engineOnly = Boolean(opts.engineOnly);
  const afltOnly = Boolean(opts.afltOnly) || Boolean(opts.noEngine);

  const engine = resolveEnginePaths(session, {
    env: opts.env,
    noEngine: afltOnly,
    noTranscripts: opts.noTranscripts,
    afltOnly,
  });

  if (!engineOnly) {
    const owned = orchestrate.sessionOwnedPaths(session, { home });
    for (const f of owned.files || []) files.push(f);
    for (const d of owned.dirs || []) dirs.push(d);
    for (const sk of owned.skipped || []) skipped.push(sk);

    const runDir = path.join(home, 'runs', String(session.id));
    if (isDir(runDir)) dirs.push(runDir);
    else skipped.push({ path: runDir, reason: 'runs dir missing' });

    // Master team message log (id is the team root)
    if (session.role === 'master') {
      const msg = path.join(home, 'messages', `${session.id}.jsonl`);
      if (isFile(msg)) files.push(msg);
      const msgLock = msg + '.lock';
      if (isFile(msgLock)) files.push(msgLock);
    }
  }

  if (engine.chat.status === 'found' && engine.chat.path) {
    dirs.push(engine.chat.path);
  } else if (engine.chat.status === 'ambiguous') {
    skipped.push({
      path: (engine.chat.hits || []).join(', '),
      reason: 'engine chat ambiguous',
    });
  } else if (engine.chat.status === 'missing') {
    skipped.push({ path: null, reason: 'engine chat missing' });
  } else if (engine.chat.status === 'invalid') {
    skipped.push({ path: null, reason: 'engine chat id invalid' });
  } else if (engine.chat.status === 'skipped') {
    skipped.push({ path: null, reason: engine.chat.reason || 'engine skipped' });
  }

  if (engine.transcript && engine.transcript.status === 'found' && engine.transcript.path) {
    dirs.push(engine.transcript.path);
  } else if (engine.transcript && engine.transcript.status === 'ambiguous') {
    skipped.push({ path: null, reason: 'cursor transcript ambiguous' });
  }

  for (const lock of engine.locks || []) {
    if (lock && isFile(lock)) files.push(lock);
  }

  // Dedupe
  const uniq = (arr) => [...new Set(arr.map((p) => path.resolve(String(p))))];
  return {
    files: uniq(files),
    dirs: uniq(dirs),
    engine,
    skipped,
    registryId: session && session.id ? String(session.id) : null,
  };
}

function unlinkPath(target, { recursive = false } = {}) {
  try {
    if (recursive) {
      if (isDir(target) || fs.existsSync(target)) {
        fs.rmSync(target, { recursive: true, force: true });
      }
    } else if (fs.existsSync(target)) {
      fs.unlinkSync(target);
    }
    return { ok: true, path: target };
  } catch (err) {
    return {
      ok: false,
      path: target,
      error: String(err && err.message ? err.message : err),
    };
  }
}

/**
 * Purge one session. Default is dry-run (apply:false).
 * Busy sessions refuse unless force:true. Never touches Herdr.
 *
 * @param {object} session
 * @param {{
 *   apply?: boolean,
 *   force?: boolean,
 *   withChildren?: boolean,
 *   enrichment?: object,
 *   enrichmentById?: object,
 *   isAlive?: Function,
 *   hostname?: string,
 *   home?: string,
 *   env?: object,
 *   noEngine?: boolean,
 *   noTranscripts?: boolean,
 *   afltOnly?: boolean,
 *   engineOnly?: boolean,
 *   sessions?: object[],
 * }} [opts]
 */
function purgeSession(session, opts = {}) {
  if (!session) return { ok: false, error: 'session required', results: [] };
  const apply = Boolean(opts.apply);
  const force = Boolean(opts.force);
  const allSessions =
    opts.sessions != null
      ? opts.sessions
      : registry.list({ includeDone: true, includeArchived: true });

  const targets = opts.withChildren
    ? archiveLib.collectWithDescendants(session, allSessions)
    : [session];

  const busyBlocked = [];
  for (const s of targets) {
    const enrichment =
      (opts.enrichmentById && opts.enrichmentById[s.id]) ||
      (s.id === session.id ? opts.enrichment : null) ||
      null;
    const busy = archiveLib.sessionBusyForMutation(s, {
      enrichment,
      isAlive: opts.isAlive,
      hostname: opts.hostname,
    });
    if (busy.busy && !force) {
      busyBlocked.push({
        id: s.id,
        title: s.title,
        reason: busy.reason || 'busy',
        via: busy.via,
      });
    }
  }
  if (busyBlocked.length) {
    const first = busyBlocked[0];
    return {
      ok: false,
      error: `"${first.title}" appears to be ${first.reason}${
        first.via ? ` (${first.via})` : ''
      }. Stop it first with \`aflt stop\`, or pass --force.`,
      busy: busyBlocked,
      apply,
      dryRun: !apply,
      results: [],
    };
  }

  // Ambiguous engine chat: refuse whole purge unless aflt-only / no-engine
  if (!opts.afltOnly && !opts.noEngine && !opts.engineOnly) {
    for (const s of targets) {
      const eng = resolveEnginePaths(s, {
        env: opts.env,
        noTranscripts: opts.noTranscripts,
      });
      if (eng.chat.status === 'ambiguous') {
        return {
          ok: false,
          error: `engine chat for "${s.title}" is ambiguous (${(eng.chat.hits || []).length} paths). Use --aflt-only or resolve manually.`,
          apply,
          dryRun: !apply,
          results: [],
        };
      }
    }
  }

  const results = [];
  let anyFailed = false;

  for (const s of targets) {
    const paths = sessionPurgePaths(s, {
      home: opts.home,
      env: opts.env,
      noEngine: opts.noEngine || opts.afltOnly,
      noTranscripts: opts.noTranscripts,
      afltOnly: opts.afltOnly,
      engineOnly: opts.engineOnly,
    });
    const pathResults = [];
    if (!apply) {
      for (const f of paths.files) pathResults.push({ action: 'would-delete-file', path: f, ok: true });
      for (const d of paths.dirs) pathResults.push({ action: 'would-delete-dir', path: d, ok: true });
      for (const sk of paths.skipped) {
        pathResults.push({
          action: 'skip',
          path: sk.path || null,
          ok: true,
          reason: sk.reason,
        });
      }
      pathResults.push({
        action: 'would-remove-registry',
        path: s.id,
        ok: true,
      });
      results.push({
        session: { id: s.id, title: s.title, engine: s.engine, chatId: s.chatId },
        paths,
        pathResults,
        removed: false,
      });
      continue;
    }

    for (const f of paths.files) {
      const r = unlinkPath(f, { recursive: false });
      pathResults.push({ action: 'delete-file', ...r });
      if (!r.ok) anyFailed = true;
    }
    for (const d of paths.dirs) {
      const r = unlinkPath(d, { recursive: true });
      pathResults.push({ action: 'delete-dir', ...r });
      if (!r.ok) anyFailed = true;
    }
    for (const sk of paths.skipped) {
      pathResults.push({
        action: 'skip',
        path: sk.path || null,
        ok: true,
        reason: sk.reason,
      });
    }

    if (!opts.engineOnly) {
      try {
        const removed = registry.remove(s.id);
        pathResults.push({
          action: 'remove-registry',
          path: s.id,
          ok: true,
          title: removed && removed.title,
        });
      } catch (err) {
        anyFailed = true;
        pathResults.push({
          action: 'remove-registry',
          path: s.id,
          ok: false,
          error: String(err && err.message ? err.message : err),
        });
      }
    }

    results.push({
      session: { id: s.id, title: s.title, engine: s.engine, chatId: s.chatId },
      paths,
      pathResults,
      removed: !opts.engineOnly,
    });
  }

  return {
    ok: !anyFailed,
    apply,
    dryRun: !apply,
    error: anyFailed ? 'one or more purge paths failed' : null,
    results,
    at: nowIso(),
  };
}

function ageDays(iso, nowMs = Date.now()) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  if (!Number.isFinite(t)) return null;
  return Math.floor((nowMs - t) / (24 * 60 * 60 * 1000));
}

function runsDirEmpty(runDir) {
  if (!isDir(runDir)) return true;
  try {
    const names = fs.readdirSync(runDir).filter((n) => n !== '.' && n !== '..');
    return names.length === 0;
  } catch (_) {
    return true;
  }
}

/**
 * Scan for orphan / stale artifacts. Never mutates.
 *
 * @param {{
 *   days?: number,
 *   engine?: 'cursor'|'copilot'|'all',
 *   categories?: string[],
 *   home?: string,
 *   env?: object,
 *   sessions?: object[],
 *   includeInteractive?: boolean,
 *   allowUncertainEngine?: boolean,
 *   herdrFetch?: Function|null,
 *   now?: number,
 * }} [opts]
 */
function scanOrphans(opts = {}) {
  const home = path.resolve(opts.home || fleetDir());
  const days = Number.isFinite(Number(opts.days)) ? Math.max(0, Number(opts.days)) : DEFAULT_ORPHAN_DAYS;
  const nowMs = opts.now != null ? Number(opts.now) : Date.now();
  const engineFilter = opts.engine && opts.engine !== 'all' ? String(opts.engine) : 'all';
  const want = new Set(
    Array.isArray(opts.categories) && opts.categories.length
      ? opts.categories.map(String)
      : ORPHAN_CATEGORIES
  );
  const sessions =
    opts.sessions != null
      ? opts.sessions
      : registry.list({ includeDone: true, includeArchived: true });
  const byId = new Map(sessions.filter(Boolean).map((s) => [s.id, s]));
  const items = [];

  function push(item) {
    if (!want.has(item.category)) return;
    if (engineFilter !== 'all' && item.engine && item.engine !== engineFilter) return;
    items.push(item);
  }

  // missing-cwd / stale-empty / archived-old
  for (const s of sessions) {
    if (!s || !s.id) continue;
    const cwdMissing = !s.cwd || !fs.existsSync(String(s.cwd));
    if (cwdMissing) {
      push({
        category: 'missing-cwd',
        afId: s.id,
        engine: s.engine || null,
        chatId: s.chatId || null,
        ageDays: ageDays(s.lastUsed || s.created, nowMs),
        paths: [s.cwd || null].filter(Boolean),
        risk: 'low',
        notes: 'registry cwd path does not exist',
        purgeable: true,
        session: s,
      });
    }

    const runDir = path.join(home, 'runs', s.id);
    const emptyRuns = runsDirEmpty(runDir);
    const age = ageDays(s.lastUsed || s.created, nowMs);
    if (
      emptyRuns &&
      age != null &&
      age >= days &&
      !archiveLib.sessionBusyForMutation(s).busy
    ) {
      const interactiveLikely =
        !s.workerStatus && s.role !== 'worker' && s.role !== 'docs' && s.role !== 'master';
      if (!interactiveLikely || opts.includeInteractive) {
        push({
          category: 'stale-empty',
          afId: s.id,
          engine: s.engine || null,
          chatId: s.chatId || null,
          ageDays: age,
          paths: [runDir],
          risk: 'medium',
          notes: interactiveLikely
            ? 'no runs/ and older than threshold (interactive may have no runs by design)'
            : 'no runs/ (or empty) and older than threshold',
          purgeable: true,
          session: s,
        });
      }
    }

    if (s.archived && s.archivedAt) {
      const a = ageDays(s.archivedAt, nowMs);
      if (a != null && a >= days) {
        push({
          category: 'archived-old',
          afId: s.id,
          engine: s.engine || null,
          chatId: s.chatId || null,
          ageDays: a,
          paths: [runDir],
          risk: 'low',
          notes: `archivedAt older than ${days} days`,
          purgeable: true,
          session: s,
        });
      }
    }
  }

  // orphan-runs: runs/<id>/ with no registry row
  const runsRoot = path.join(home, 'runs');
  if (isDir(runsRoot)) {
    let names = [];
    try {
      names = fs.readdirSync(runsRoot);
    } catch (_) {
      names = [];
    }
    for (const name of names) {
      if (!name || name.startsWith('.')) continue;
      const dir = path.join(runsRoot, name);
      if (!isDir(dir)) continue;
      if (byId.has(name)) continue;
      let mtimeIso = null;
      try {
        mtimeIso = new Date(fs.statSync(dir).mtimeMs).toISOString();
      } catch (_) {
        /* ignore */
      }
      push({
        category: 'orphan-runs',
        afId: name,
        engine: null,
        chatId: null,
        ageDays: ageDays(mtimeIso, nowMs),
        paths: [dir],
        risk: 'low',
        notes: 'runs/<id>/ with no registry row',
        purgeable: true,
        session: null,
      });
    }
  }

  // orphan-engine-chat: best-effort from leftover runs headers mentioning chat ids
  // Report-only unless allowUncertainEngine
  if (want.has('orphan-engine-chat')) {
    const mentioned = new Map(); // chatId -> { engine, afId?, paths }
    const knownChatIds = new Set(
      sessions.filter((s) => s && s.chatId).map((s) => String(s.chatId))
    );
    if (isDir(runsRoot)) {
      let runIds = [];
      try {
        runIds = fs.readdirSync(runsRoot);
      } catch (_) {
        runIds = [];
      }
      for (const rid of runIds) {
        const dir = path.join(runsRoot, rid);
        if (!isDir(dir)) continue;
        let files = [];
        try {
          files = fs.readdirSync(dir);
        } catch (_) {
          continue;
        }
        for (const f of files) {
          if (!/\.(txt|jsonl)$/i.test(f)) continue;
          let text = '';
          try {
            text = fs.readFileSync(path.join(dir, f), 'utf8').slice(0, 64 * 1024);
          } catch (_) {
            continue;
          }
          const resume = text.match(/--resume[=\s]+([0-9a-f-]{36})/i);
          const sid = text.match(/--session-id=([0-9a-f-]{36})/i);
          const hit = (resume && resume[1]) || (sid && sid[1]);
          if (!hit || knownChatIds.has(hit)) continue;
          const eng = sid ? 'copilot' : 'cursor';
          if (!mentioned.has(hit)) {
            mentioned.set(hit, {
              chatId: hit,
              engine: eng,
              afId: byId.has(rid) ? rid : null,
              paths: [],
            });
          }
          mentioned.get(hit).paths.push(path.join(dir, f));
        }
      }
    }

    for (const info of mentioned.values()) {
      let enginePath = null;
      let status = 'missing';
      if (info.engine === 'copilot') {
        const r = resolveCopilotSessionDir({ chatId: info.chatId }, opts.env || process.env);
        status = r.status;
        enginePath = r.path;
      } else {
        const r = resolveCursorChatDir(
          { chatId: info.chatId, cwd: null, engine: 'cursor' },
          opts.env || process.env
        );
        status = r.status;
        enginePath = r.path;
      }
      if (status !== 'found') continue;
      push({
        category: 'orphan-engine-chat',
        afId: info.afId,
        engine: info.engine,
        chatId: info.chatId,
        ageDays: null,
        paths: [enginePath, ...info.paths].filter(Boolean),
        risk: 'medium',
        notes: opts.allowUncertainEngine
          ? 'chat id referenced in leftover runs/ but not in registry'
          : 'uncertain — report only unless --allow-uncertain-engine',
        purgeable: Boolean(opts.allowUncertainEngine),
        session: null,
        enginePath,
      });
    }
  }

  // herdr-orphan-pane: report only
  if (want.has('herdr-orphan-pane')) {
    let fetch = null;
    try {
      const herdr = require('./herdr');
      const fn = typeof opts.herdrFetch === 'function' ? opts.herdrFetch : herdr.fetchHerdrTerminals;
      fetch = fn ? fn() : null;
    } catch (_) {
      fetch = null;
    }
    const terminals =
      fetch && fetch.ok && Array.isArray(fetch.terminals) ? fetch.terminals : [];
    for (const t of terminals) {
      const labels = (t && t.labels) || {};
      const afId =
        (t && t.afId) ||
        labels.af_id ||
        labels.afId ||
        null;
      const id = afId != null ? String(afId) : null;
      if (!id) continue;
      if (byId.has(id)) continue;
      push({
        category: 'herdr-orphan-pane',
        afId: id,
        engine: null,
        chatId: null,
        ageDays: null,
        paths: [t.name || t.address || null].filter(Boolean),
        risk: 'medium',
        notes: 'live Herdr terminal with af_id not in registry (report only; never auto-killed)',
        purgeable: false,
        session: null,
      });
    }
  }

  items.sort((a, b) => {
    const c = String(a.category).localeCompare(String(b.category));
    if (c) return c;
    return String(a.afId || '').localeCompare(String(b.afId || ''));
  });

  return {
    days,
    engine: engineFilter,
    categories: [...want],
    count: items.length,
    items,
    at: nowIso(),
  };
}

/**
 * Purge selected orphan items. Never purges herdr-orphan-pane.
 * Default dry-run; require apply:true.
 *
 * @param {object[]} items from scanOrphans
 * @param {{ apply?: boolean, force?: boolean, home?: string, env?: object, ids?: string[] }} [opts]
 */
function purgeOrphanItems(items, opts = {}) {
  const apply = Boolean(opts.apply);
  const idFilter =
    Array.isArray(opts.ids) && opts.ids.length
      ? new Set(opts.ids.map(String))
      : null;
  const selected = (items || []).filter((it) => {
    if (!it || !it.purgeable) return false;
    if (it.category === 'herdr-orphan-pane') return false;
    if (idFilter) {
      const keys = [it.afId, it.chatId].filter(Boolean).map(String);
      if (!keys.some((k) => idFilter.has(k))) return false;
    }
    return true;
  });

  const results = [];
  let anyFailed = false;

  for (const it of selected) {
    if (it.session) {
      const r = purgeSession(it.session, {
        apply,
        force: opts.force,
        home: opts.home,
        env: opts.env,
        isAlive: opts.isAlive,
      });
      results.push({ item: summarizeOrphan(it), purge: r });
      if (!r.ok) anyFailed = true;
      continue;
    }

    // orphan-runs / orphan-engine-chat without session: delete listed paths only
    const pathResults = [];
    const paths = (it.paths || []).filter(Boolean);
    // For orphan-runs, only delete the runs dir (first path); ignore evidence files for engine-chat evidence
    const toDelete =
      it.category === 'orphan-runs'
        ? paths.slice(0, 1)
        : it.category === 'orphan-engine-chat'
          ? it.enginePath
            ? [it.enginePath]
            : paths.filter((p) => !String(p).includes(`${path.sep}runs${path.sep}`))
          : paths;

    for (const p of toDelete) {
      if (!apply) {
        pathResults.push({
          action: isDir(p) ? 'would-delete-dir' : 'would-delete-file',
          path: p,
          ok: true,
        });
        continue;
      }
      const r = unlinkPath(p, { recursive: isDir(p) });
      pathResults.push({ action: isDir(p) ? 'delete-dir' : 'delete-file', ...r });
      if (!r.ok) anyFailed = true;
    }
    results.push({
      item: summarizeOrphan(it),
      purge: { ok: !pathResults.some((x) => x.ok === false), apply, dryRun: !apply, pathResults },
    });
  }

  return {
    ok: !anyFailed,
    apply,
    dryRun: !apply,
    selected: selected.length,
    results,
    error: anyFailed ? 'one or more orphan purge paths failed' : null,
  };
}

function summarizeOrphan(it) {
  if (!it) return null;
  return {
    category: it.category,
    afId: it.afId || null,
    engine: it.engine || null,
    chatId: it.chatId || null,
    ageDays: it.ageDays != null ? it.ageDays : null,
    paths: it.paths || [],
    risk: it.risk || null,
    notes: it.notes || null,
    purgeable: Boolean(it.purgeable),
  };
}

module.exports = {
  UUID_RE,
  DEFAULT_ORPHAN_DAYS,
  ORPHAN_CATEGORIES,
  isSafeChatId,
  cursorHome,
  resolveCursorChatDir,
  resolveCopilotSessionDir,
  resolveCursorTranscriptDir,
  resolveEnginePaths,
  sessionPurgePaths,
  purgeSession,
  scanOrphans,
  purgeOrphanItems,
  summarizeOrphan,
  ageDays,
};
