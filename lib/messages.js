'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { fleetDir, nowIso, homeDir } = require('./util');

const MSG_TYPES = new Set(['question', 'answer', 'note', 'blocked']);
const TEXT_MAX = 4000;
const DEFAULT_MAX_THREAD = 6;
const DEFAULT_RATE = 10;
const RATE_WINDOW_MS = 60_000;

const LOCK_WAIT_MS = 10000;
const LOCK_STALE_MS = 30000;
const LOCK_BACKOFF_MS = 25;

const MESSAGING_NOT_ENABLED = (title) =>
  `messaging not enabled for ${title} (enable with: af msg enable ${title}, or add {"messaging": true} to .agentfleet.json in the project)`;

const MESSAGING_PROMPT_LINES_WORKER = [
  'You can message your master or siblings with `af msg` or MCP tools `post_message` / `read_inbox` / `list_team` (when wired) for questions and blockers; use sparingly.',
  'Check `af inbox` before finishing. Max 6 messages per thread — summarize and continue, or ask the master.',
].join('\n');

const MESSAGING_PROMPT_LINES_MASTER = [
  'You can message your workers with `af msg` (or af MCP tools if available) for questions and blockers; use sparingly. Workers inherit messaging when you have it enabled.',
  'Check `af inbox` before finishing. Max 6 messages per thread.',
].join('\n');

/** @deprecated alias — worker lines */
const MESSAGING_PROMPT_LINES = MESSAGING_PROMPT_LINES_WORKER;

function messagesDir() {
  return path.join(fleetDir(), 'messages');
}

function teamLogPath(teamId) {
  return path.join(messagesDir(), `${String(teamId)}.jsonl`);
}

function teamLockPath(teamId) {
  return teamLogPath(teamId) + '.lock';
}

function syncSleep(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, Math.max(1, Math.floor(ms)));
}

function isPidAlive(pid) {
  if (pid == null || !Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

function tryBreakStaleLock(lp, staleMs = LOCK_STALE_MS) {
  let st;
  try {
    st = fs.statSync(lp);
  } catch (_) {
    return false;
  }
  let stale = Date.now() - st.mtimeMs > staleMs;
  if (!stale) {
    try {
      const raw = fs.readFileSync(lp, 'utf8');
      const lines = String(raw).split(/\n/);
      const pid = Number(String(lines[0] || '').trim());
      const host = String(lines[1] || '').trim();
      if (host === os.hostname() && Number.isFinite(pid) && pid > 0 && !isPidAlive(pid)) {
        stale = true;
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!stale) return false;
  try {
    fs.unlinkSync(lp);
    return true;
  } catch (_) {
    return false;
  }
}

function acquireTeamLock(teamId, { timeoutMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  fs.mkdirSync(messagesDir(), { recursive: true, mode: 0o700 });
  const lp = teamLockPath(teamId);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const fd = fs.openSync(lp, 'wx');
      try {
        fs.writeFileSync(fd, `${process.pid}\n${os.hostname()}\n${nowIso()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return lp;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      tryBreakStaleLock(lp, staleMs);
      const jitter = Math.floor(Math.random() * 15);
      syncSleep(LOCK_BACKOFF_MS + jitter);
    }
  }
  throw new Error(`could not acquire message lock for team ${teamId} after ${timeoutMs}ms`);
}

function releaseTeamLock(lp) {
  try {
    fs.unlinkSync(lp);
  } catch (_) {
    /* ignore */
  }
}

function withTeamLock(teamId, fn, opts) {
  const lp = acquireTeamLock(teamId, opts);
  try {
    return fn();
  } finally {
    releaseTeamLock(lp);
  }
}

/**
 * Team id for a session: worker → parent; master → self; else null (no team).
 */
function teamIdOf(session) {
  if (!session) return null;
  if (session.parent != null && String(session.parent).trim() !== '') {
    return String(session.parent).trim();
  }
  if (session.role === 'master') return session.id;
  return null;
}

/**
 * Walk cwd → ancestors for `.agentfleet.json` until git root or fs root.
 * When `key` is set, returns the first readable file that has that own property;
 * otherwise returns the first readable `.agentfleet.json`.
 * @returns {{ path: string, dir: string, data: object }|null}
 */
function findProjectConfig(cwd, { key } = {}) {
  let dir;
  try {
    dir = path.resolve(cwd || process.cwd());
  } catch (_) {
    return null;
  }
  const root = path.parse(dir).root;
  while (true) {
    const cfgPath = path.join(dir, '.agentfleet.json');
    try {
      if (fs.existsSync(cfgPath) && fs.statSync(cfgPath).isFile()) {
        const raw = fs.readFileSync(cfgPath, 'utf8');
        if (raw.trim()) {
          const data = JSON.parse(raw);
          if (data && typeof data === 'object' && !Array.isArray(data)) {
            if (key == null || Object.prototype.hasOwnProperty.call(data, key)) {
              return { path: cfgPath, dir, data };
            }
          }
        }
      }
    } catch (_) {
      /* ignore corrupt; keep walking */
    }
    if (fs.existsSync(path.join(dir, '.git'))) break;
    if (dir === root) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Walk cwd → ancestors for `.agentfleet.json` until git root or fs root.
 * Returns true only when the nearest file with a `messaging` key has messaging===true.
 */
function readProjectMessaging(cwd) {
  const hit = findProjectConfig(cwd, { key: 'messaging' });
  return Boolean(hit && hit.data && hit.data.messaging === true);
}

/**
 * Pure enablement helper.
 * enabled = session.messaging === true || (session.messaging !== false && project opt-in)
 * @returns {{ enabled: boolean, source: 'session'|'project'|'default' }}
 */
function isMessagingEnabled(session, { readProjectConfig } = {}) {
  if (!session) return { enabled: false, source: 'default' };
  if (session.messaging === true) return { enabled: true, source: 'session' };
  if (session.messaging === false) return { enabled: false, source: 'session' };
  const reader = typeof readProjectConfig === 'function' ? readProjectConfig : readProjectMessaging;
  let project = false;
  try {
    project = Boolean(reader(session.cwd));
  } catch (_) {
    project = false;
  }
  if (project) return { enabled: true, source: 'project' };
  return { enabled: false, source: 'default' };
}

function normalizeMessagingFlag(flags, { inheritFrom } = {}) {
  if (!flags) return null;
  if (flags['no-messaging']) return false;
  if (flags.messaging === true || flags.messaging === '') return true;
  if (typeof flags.messaging === 'string') return true;
  if (inheritFrom) {
    const eff = isMessagingEnabled(inheritFrom);
    if (eff.enabled) return true;
  }
  return null;
}

function makeMsgId() {
  return 'm-' + crypto.randomBytes(4).toString('hex');
}

function maxThread() {
  const raw = process.env.AGENTFLEET_MSG_MAX_THREAD;
  const n = raw != null && raw !== '' ? Number(raw) : DEFAULT_MAX_THREAD;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_THREAD;
}

function rateLimit() {
  const raw = process.env.AGENTFLEET_MSG_RATE;
  const n = raw != null && raw !== '' ? Number(raw) : DEFAULT_RATE;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_RATE;
}

function ensureLogFile(teamId) {
  const dir = messagesDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = teamLogPath(teamId);
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, '', { encoding: 'utf8', mode: 0o600 });
  }
  return p;
}

function readLog(teamId) {
  const p = teamLogPath(teamId);
  if (!fs.existsSync(p)) return [];
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return [];
  const out = [];
  for (const line of raw.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch (_) {
      /* skip corrupt lines */
    }
  }
  return out;
}

function appendRecord(teamId, record) {
  return withTeamLock(teamId, () => {
    const p = ensureLogFile(teamId);
    const line = JSON.stringify(record) + '\n';
    fs.appendFileSync(p, line, { encoding: 'utf8' });
    try {
      fs.chmodSync(p, 0o600);
    } catch (_) {
      /* ignore */
    }
    return record;
  });
}

function validateType(type) {
  const t = type == null || type === '' || type === true ? 'note' : String(type).trim();
  if (!MSG_TYPES.has(t)) {
    throw Object.assign(new Error(`invalid message type: ${type} (want question|answer|note|blocked)`), {
      code: 'BAD_TYPE',
    });
  }
  return t;
}

function validateText(text) {
  const s = String(text == null ? '' : text);
  if (!s.trim()) {
    throw Object.assign(new Error('message text is required'), { code: 'NO_TEXT' });
  }
  if (s.length > TEXT_MAX) {
    throw Object.assign(new Error(`message text too long (${s.length}; max ${TEXT_MAX})`), {
      code: 'TEXT_TOO_LONG',
    });
  }
  return s;
}

/**
 * Resolve CLI/MCP `from`: --from > AGENTFLEET_SESSION > AGENTFLEET_ID.
 */
function resolveFromId(flags = {}, env = process.env) {
  const { envNonEmpty } = require('./util');
  if (flags.from != null && flags.from !== true && String(flags.from).trim()) {
    return String(flags.from).trim();
  }
  return envNonEmpty(env, 'AGENTFLEET_SESSION') || envNonEmpty(env, 'AGENTFLEET_ID') || null;
}

function resolveEnvSessionId(env = process.env) {
  const { envNonEmpty } = require('./util');
  return envNonEmpty(env, 'AGENTFLEET_SESSION') || envNonEmpty(env, 'AGENTFLEET_ID') || null;
}

/**
 * Env overlay for launched sessions (headless / interactive / Herdr / resume).
 * Always sets AGENTFLEET_ID, AGENTFLEET_SESSION, and resolved AGENTFLEET_HOME.
 * Sets AGENTFLEET_MASTER when the team is known (master → own id; worker → parent).
 * Sets AGENTFLEET_PARENT only for workers (omit rather than empty — Cursor leaves
 * unresolved `${env:PARENT}` literals that would poison the MCP child).
 */
function sessionIdentityEnv(session, extra = {}) {
  const { fleetDir, envNonEmpty } = require('./util');
  const overlay = { ...(extra && typeof extra === 'object' ? extra : {}) };
  // Drop empty / unresolved interpolation leftovers from callers.
  for (const k of [
    'AGENTFLEET_HOME',
    'AGENTFLEET_SESSION',
    'AGENTFLEET_ID',
    'AGENTFLEET_MASTER',
    'AGENTFLEET_PARENT',
  ]) {
    if (!envNonEmpty(overlay, k)) delete overlay[k];
  }
  if (!session || !session.id) {
    if (!overlay.AGENTFLEET_HOME) overlay.AGENTFLEET_HOME = fleetDir();
    return overlay;
  }
  overlay.AGENTFLEET_ID = session.id;
  overlay.AGENTFLEET_SESSION = session.id;
  overlay.AGENTFLEET_HOME = envNonEmpty(overlay, 'AGENTFLEET_HOME') || fleetDir();
  const team = teamIdOf(session);
  if (team) overlay.AGENTFLEET_MASTER = team;
  else delete overlay.AGENTFLEET_MASTER;
  if (session.parent != null && String(session.parent).trim() !== '') {
    overlay.AGENTFLEET_PARENT = String(session.parent).trim();
  } else {
    delete overlay.AGENTFLEET_PARENT;
  }
  return overlay;
}

function teamMembers(teamId, sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const master = list.find((s) => s.id === teamId);
  const workers = list.filter((s) => s.parent === teamId);
  return { master: master || null, workers, all: [master, ...workers].filter(Boolean) };
}

function messageAddressedTo(msg, session, teamId) {
  if (!msg || msg.kind !== 'msg' || !session) return false;
  const to = String(msg.to || '');
  if (to === session.id) return true;
  if (to === 'master' && session.id === teamId) return true;
  if (to === 'all-siblings' && session.parent === teamId && msg.from !== session.id) return true;
  return false;
}

function isReadBy(records, msgId, sessionId) {
  return records.some(
    (r) => r && r.kind === 'read' && r.msgId === msgId && r.by === sessionId
  );
}

function inboxFor(session, records, { unreadOnly = false } = {}) {
  const teamId = teamIdOf(session);
  if (!teamId) return [];
  const msgs = records.filter((r) => r && r.kind === 'msg' && messageAddressedTo(r, session, teamId));
  const withRead = msgs.map((m) => ({
    ...m,
    read: isReadBy(records, m.id, session.id),
  }));
  let out = withRead;
  if (unreadOnly) out = out.filter((m) => !m.read);
  return out;
}

function countUnread(session, records) {
  return inboxFor(session, records, { unreadOnly: true }).length;
}

/**
 * Unread counts keyed by session id (cached per team log).
 */
function unreadBySessionId(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  const cache = new Map();
  const out = {};
  for (const s of list) {
    const team = teamIdOf(s);
    if (!team) {
      out[s.id] = 0;
      continue;
    }
    if (!cache.has(team)) cache.set(team, readLog(team));
    out[s.id] = countUnread(s, cache.get(team));
  }
  return out;
}

function findMessageInTeam(teamId, msgId) {
  const records = readLog(teamId);
  const msg = records.find((r) => r && r.kind === 'msg' && r.id === msgId);
  return msg ? { msg, records, teamId } : null;
}

function findMessageAnywhere(msgId) {
  const dir = messagesDir();
  if (!fs.existsSync(dir)) return null;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch (_) {
    return null;
  }
  for (const name of entries) {
    if (!name.endsWith('.jsonl')) continue;
    const teamId = name.slice(0, -'.jsonl'.length);
    const hit = findMessageInTeam(teamId, msgId);
    if (hit) return hit;
  }
  return null;
}

function threadMessages(records, threadId) {
  return records
    .filter((r) => r && r.kind === 'msg' && r.thread === threadId)
    .sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
}

/**
 * Resolve `to` target within a team.
 * @returns {{ mode: 'direct'|'master'|'all-siblings', to: string, recipients: object[], skipped: object[] }}
 */
function resolveTo(toRaw, { fromSession, teamId, sessions, find }) {
  const raw = String(toRaw || '').trim();
  if (!raw) {
    throw Object.assign(new Error('message recipient (to) is required'), { code: 'NO_TO' });
  }
  const { master, workers } = teamMembers(teamId, sessions);
  if (!master && workers.length === 0) {
    throw Object.assign(new Error(`team not found: ${teamId}`), { code: 'NO_TEAM' });
  }

  if (raw === 'master') {
    if (!master) {
      throw Object.assign(new Error(`master session not found for team ${teamId}`), {
        code: 'NO_MASTER',
      });
    }
    return { mode: 'master', to: 'master', recipients: [master], skipped: [] };
  }

  if (raw === 'all-siblings') {
    let candidates;
    if (fromSession.id === teamId || fromSession.role === 'master') {
      candidates = workers.slice();
    } else {
      candidates = workers.filter((w) => w.id !== fromSession.id);
    }
    const recipients = [];
    const skipped = [];
    for (const s of candidates) {
      const eff = isMessagingEnabled(s);
      if (eff.enabled) recipients.push(s);
      else skipped.push(s);
    }
    if (recipients.length === 0) {
      throw Object.assign(
        new Error(
          candidates.length === 0
            ? 'no siblings to message'
            : `no enabled siblings (skipped: ${skipped.map((s) => s.title).join(', ') || 'none'})`
        ),
        { code: 'NO_RECIPIENTS', skipped }
      );
    }
    return { mode: 'all-siblings', to: 'all-siblings', recipients, skipped };
  }

  let target;
  try {
    target = find(raw);
  } catch (err) {
    throw err;
  }
  if (!target) {
    throw Object.assign(new Error(`recipient not found: ${raw}`), { code: 'NOT_FOUND' });
  }
  const targetTeam = teamIdOf(target);
  if (targetTeam !== teamId && target.id !== teamId) {
    throw Object.assign(
      new Error(`recipient "${target.title}" is not in the same team as sender`),
      { code: 'SCOPE' }
    );
  }
  // Direct to master id/title → store as master id (not alias) for clarity; inbox also matches id.
  return { mode: 'direct', to: target.id, recipients: [target], skipped: [] };
}

function assertEnabled(session) {
  const eff = isMessagingEnabled(session);
  if (!eff.enabled) {
    throw Object.assign(new Error(MESSAGING_NOT_ENABLED(session.title || session.id)), {
      code: 'NOT_ENABLED',
      session,
    });
  }
  return eff;
}

function checkRateLimit(records, fromId) {
  const limit = rateLimit();
  const cutoff = Date.now() - RATE_WINDOW_MS;
  const recent = records.filter((r) => {
    if (!r || r.kind !== 'msg' || r.from !== fromId) return false;
    const t = Date.parse(String(r.ts || ''));
    return Number.isFinite(t) && t >= cutoff;
  });
  if (recent.length >= limit) {
    throw Object.assign(
      new Error(`rate limit reached (${limit} messages per 60s); wait and retry`),
      { code: 'RATE_LIMIT' }
    );
  }
}

function checkThreadLimit(records, threadId) {
  const limit = maxThread();
  const n = records.filter((r) => r && r.kind === 'msg' && r.thread === threadId).length;
  if (n >= limit) {
    throw Object.assign(
      new Error(`thread limit reached (${limit}); summarize and continue, or ask the master`),
      { code: 'THREAD_LIMIT' }
    );
  }
}

/**
 * Post a message. opts.dryRun validates only.
 * @param {object} opts
 * @param {object} opts.fromSession
 * @param {string} opts.to
 * @param {string} opts.text
 * @param {string} [opts.type]
 * @param {string|null} [opts.replyTo]
 * @param {object[]} opts.sessions
 * @param {(q:string)=>object|null} opts.find
 * @param {boolean} [opts.dryRun]
 */
function postMessage(opts) {
  const fromSession = opts.fromSession;
  if (!fromSession) {
    throw Object.assign(new Error('sender session required (--from or AGENTFLEET_SESSION/AGENTFLEET_ID)'), {
      code: 'NO_FROM',
    });
  }
  const teamId = teamIdOf(fromSession);
  if (!teamId) {
    throw Object.assign(
      new Error(
        `session "${fromSession.title || fromSession.id}" has no team (set role=master or parent); messaging refused`
      ),
      { code: 'NO_TEAM' }
    );
  }

  assertEnabled(fromSession);

  const type = validateType(opts.type);
  const text = validateText(opts.text);
  const sessions = opts.sessions || [];
  const find = typeof opts.find === 'function' ? opts.find : () => null;

  let replyTo = opts.replyTo != null && opts.replyTo !== '' ? String(opts.replyTo) : null;
  let thread = null;
  let toRaw = opts.to;

  // Under lock for rate/thread checks + append atomicity.
  const result = withTeamLock(teamId, () => {
    const records = readLog(teamId);

    if (replyTo) {
      const parent = records.find((r) => r && r.kind === 'msg' && r.id === replyTo);
      if (!parent) {
        throw Object.assign(new Error(`reply target not found: ${replyTo}`), { code: 'BAD_REPLY' });
      }
      thread = parent.thread || parent.id;
      if (!toRaw || toRaw === true) {
        toRaw = parent.from;
      }
    }

    if (!toRaw || toRaw === true) {
      throw Object.assign(new Error('message recipient (to) is required'), { code: 'NO_TO' });
    }

    const resolved = resolveTo(toRaw, {
      fromSession,
      teamId,
      sessions,
      find,
    });

    for (const recip of resolved.recipients) {
      if (recip.id === fromSession.id && resolved.mode === 'direct') {
        throw Object.assign(new Error('cannot message yourself'), { code: 'SELF' });
      }
      assertEnabled(recip);
    }

    if (thread) checkThreadLimit(records, thread);
    checkRateLimit(records, fromSession.id);

    const id = makeMsgId();
    const finalThread = thread || id;

    const message = {
      kind: 'msg',
      id,
      ts: nowIso(),
      team: teamId,
      from: fromSession.id,
      to: resolved.to,
      type,
      text,
      replyTo,
      thread: finalThread,
    };

    if (opts.dryRun) {
      return { ok: true, dryRun: true, message, skipped: resolved.skipped };
    }

    ensureLogFile(teamId);
    const line = JSON.stringify(message) + '\n';
    fs.appendFileSync(teamLogPath(teamId), line, { encoding: 'utf8' });
    try {
      fs.chmodSync(teamLogPath(teamId), 0o600);
    } catch (_) {
      /* ignore */
    }
    return { ok: true, message, skipped: resolved.skipped };
  });

  return result;
}

function markRead(teamId, msgIds, bySessionId) {
  const ids = Array.isArray(msgIds) ? msgIds.filter(Boolean) : [];
  if (ids.length === 0) return [];
  return withTeamLock(teamId, () => {
    ensureLogFile(teamId);
    const records = readLog(teamId);
    const written = [];
    for (const msgId of ids) {
      if (isReadBy(records, msgId, bySessionId)) continue;
      const rec = { kind: 'read', msgId, by: bySessionId, ts: nowIso() };
      fs.appendFileSync(teamLogPath(teamId), JSON.stringify(rec) + '\n', { encoding: 'utf8' });
      records.push(rec);
      written.push(rec);
    }
    try {
      fs.chmodSync(teamLogPath(teamId), 0o600);
    } catch (_) {
      /* ignore */
    }
    return written;
  });
}

function messagingPromptBlock(enabled, { role } = {}) {
  if (!enabled) return '';
  const lines =
    role === 'master' ? MESSAGING_PROMPT_LINES_MASTER : MESSAGING_PROMPT_LINES_WORKER;
  return (
    lines
      .split('\n')
      .filter(Boolean)
      .map((line) => `- ${line}`)
      .join('\n') + '\n'
  );
}

module.exports = {
  MSG_TYPES,
  TEXT_MAX,
  DEFAULT_MAX_THREAD,
  DEFAULT_RATE,
  MESSAGING_NOT_ENABLED,
  MESSAGING_PROMPT_LINES,
  MESSAGING_PROMPT_LINES_WORKER,
  MESSAGING_PROMPT_LINES_MASTER,
  messagesDir,
  teamLogPath,
  teamIdOf,
  findProjectConfig,
  readProjectMessaging,
  isMessagingEnabled,
  normalizeMessagingFlag,
  makeMsgId,
  maxThread,
  rateLimit,
  readLog,
  appendRecord,
  withTeamLock,
  validateType,
  validateText,
  resolveFromId,
  resolveEnvSessionId,
  sessionIdentityEnv,
  teamMembers,
  messageAddressedTo,
  inboxFor,
  countUnread,
  unreadBySessionId,
  findMessageInTeam,
  findMessageAnywhere,
  threadMessages,
  resolveTo,
  assertEnabled,
  postMessage,
  markRead,
  messagingPromptBlock,
  homeDir,
};
