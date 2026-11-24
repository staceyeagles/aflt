'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fleetDir, registryPath, nowIso, makeId } = require('./util');
const orchestrate = require('./orchestrate');

const STATUSES = new Set(['active', 'paused', 'done']);
const ENGINES = new Set(['cursor', 'copilot', 'opencode']);

/** Max wait to acquire `<sessions.json>.lock`. */
const LOCK_WAIT_MS = 10000;
/** Break a lock whose mtime is older than this. */
const LOCK_STALE_MS = 30000;
const LOCK_BACKOFF_MS = 25;

/** Process-local reentrancy for nested withLock (e.g. future helpers). */
let lockDepth = 0;

function emptyRegistry() {
  return { version: 1, sessions: [] };
}

function ensureDir() {
  const dir = fleetDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function load() {
  const p = registryPath();
  if (!fs.existsSync(p)) return emptyRegistry();
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return emptyRegistry();
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.sessions)) {
    throw new Error(`Invalid registry at ${p}: expected { sessions: [] }`);
  }
  return data;
}

/**
 * Atomic write: temp file in same directory then rename.
 * Callers that read-modify-write must hold withLock (add/update/remove/importAll do).
 */
function save(data) {
  ensureDir();
  const p = registryPath();
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.sessions.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
}

function lockPath() {
  return registryPath() + '.lock';
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

/**
 * Remove a lock file if mtime is older than staleMs, or if it records a dead
 * pid on this host. Returns true if the file was unlinked.
 */
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

function acquireLock({ timeoutMs = LOCK_WAIT_MS, staleMs = LOCK_STALE_MS } = {}) {
  ensureDir();
  const lp = lockPath();
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
  throw new Error(`could not acquire registry lock at ${lp} after ${timeoutMs}ms`);
}

function releaseLock(lp) {
  try {
    fs.unlinkSync(lp || lockPath());
  } catch (_) {
    /* ignore */
  }
}

/**
 * Cross-process exclusive lock around a read-modify-write of sessions.json.
 * Re-entrant within the same process. Reads (list/find) stay lock-free.
 */
function withLock(fn, opts) {
  if (typeof fn !== 'function') throw new Error('withLock requires a function');
  if (lockDepth > 0) {
    lockDepth++;
    try {
      return fn();
    } finally {
      lockDepth--;
    }
  }
  const lp = acquireLock(opts);
  lockDepth = 1;
  try {
    return fn();
  } finally {
    lockDepth = 0;
    releaseLock(lp);
  }
}

function normalizeEntry(partial) {
  const now = nowIso();
  const title = String(partial.title || '').trim();
  if (!title) throw new Error('title is required');
  if (!partial.chatId) throw new Error('chatId is required');

  const status = partial.status || 'active';
  if (!STATUSES.has(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const engine = partial.engine || 'cursor';
  if (!ENGINES.has(engine)) {
    throw new Error(`invalid engine: ${engine} (want cursor, copilot, or opencode)`);
  }

  const id = partial.id || makeId(title);
  const role = orchestrate.validateRole(partial.role);
  const workerStatus = orchestrate.validateWorkerStatus(partial.workerStatus);
  const parent =
    partial.parent != null && String(partial.parent).trim() !== ''
      ? String(partial.parent).trim()
      : null;
  const task = partial.task != null ? String(partial.task) : '';
  let result = null;
  if (partial.result != null && String(partial.result).trim() !== '') {
    result = path.resolve(String(partial.result).trim());
  } else if (role === 'worker' || role === 'master' || role === 'docs') {
    result = orchestrate.defaultResultPath(id);
  }
  let plan = null;
  if (partial.plan != null && String(partial.plan).trim() !== '') {
    plan = path.resolve(String(partial.plan).trim());
  } else if (role === 'master') {
    plan = orchestrate.defaultPlanPath(id);
  }
  let resultSource = null;
  if (partial.resultSource != null && String(partial.resultSource).trim() !== '') {
    const rs = String(partial.resultSource).trim();
    if (rs !== 'worker' && rs !== 'af-fallback') {
      throw new Error(`invalid resultSource: ${rs} (want worker or af-fallback)`);
    }
    resultSource = rs;
  }

  let project = null;
  if (partial.project != null && String(partial.project).trim() !== '') {
    project = String(partial.project).trim();
  }

  const entry = {
    id,
    title,
    chatId: String(partial.chatId).trim(),
    cwd: partial.cwd ? path.resolve(partial.cwd) : process.cwd(),
    branch: partial.branch ?? null,
    model: partial.model ?? null,
    engine,
    created: partial.created || now,
    lastUsed: partial.lastUsed || now,
    status,
    tags: Array.isArray(partial.tags) ? partial.tags.map(String) : [],
    notes: partial.notes != null ? String(partial.notes) : '',
    prompt: partial.prompt != null ? String(partial.prompt) : '',
    lastRunAt: partial.lastRunAt || null,
    lastExit: partial.lastExit != null ? partial.lastExit : null,
    lastOutput: partial.lastOutput || null,
    lastPrompt: partial.lastPrompt != null ? String(partial.lastPrompt) : '',
    project,
    parent,
    role,
    task,
    result,
    plan,
    resultSource,
    workerStatus,
    // Stage 2 headless run tracking / orchestration
    runPid: partial.runPid != null ? Number(partial.runPid) : null,
    runPgid: partial.runPgid != null ? Number(partial.runPgid) : null,
    runHost: partial.runHost != null ? String(partial.runHost) : null,
    runStartedAt: partial.runStartedAt || null,
    stopRequested: Boolean(partial.stopRequested),
    force: partial.force != null ? Boolean(partial.force) : null,
    // Stage 3: interactive af send timestamp (stale done/idle grace for af wait)
    lastSendAt: partial.lastSendAt || null,
    // Hardening: run identity + handoff freshness
    runId: partial.runId != null ? String(partial.runId) : null,
    resultMtimeAtStart:
      partial.resultMtimeAtStart != null ? Number(partial.resultMtimeAtStart) : null,
    resultRunId: partial.resultRunId != null ? String(partial.resultRunId) : null,
    lastError: partial.lastError != null ? String(partial.lastError) : null,
    messaging:
      partial.messaging === true ? true : partial.messaging === false ? false : null,
    // Documentarian: one-shot guard per master headless run
    docsTriggeredRunId:
      partial.docsTriggeredRunId != null && String(partial.docsTriggeredRunId).trim() !== ''
        ? String(partial.docsTriggeredRunId).trim()
        : null,
    archived: Boolean(partial.archived),
    archivedAt:
      partial.archived && partial.archivedAt != null && String(partial.archivedAt).trim() !== ''
        ? String(partial.archivedAt)
        : null,
  };
  if (!entry.archived) entry.archivedAt = null;
  if (Number.isNaN(entry.resultMtimeAtStart)) entry.resultMtimeAtStart = null;
  if (Number.isNaN(entry.runPid)) entry.runPid = null;
  if (Number.isNaN(entry.runPgid)) entry.runPgid = null;
  if (partial.herdr != null && typeof partial.herdr === 'object' && !Array.isArray(partial.herdr)) {
    entry.herdr = { ...partial.herdr };
  }
  return entry;
}

function list(opts = {}) {
  const data = load();
  let sessions = data.sessions.slice();
  if (opts.status) {
    sessions = sessions.filter((s) => s.status === opts.status);
  }
  if (opts.tag) {
    sessions = sessions.filter((s) => (s.tags || []).includes(opts.tag));
  }
  if (opts.includeDone === false) {
    sessions = sessions.filter((s) => s.status !== 'done');
  }
  // Archived sessions are hidden unless explicitly requested.
  if (opts.includeArchived !== true && opts.archivedOnly !== true) {
    sessions = sessions.filter((s) => !s.archived);
  }
  if (opts.archivedOnly === true) {
    sessions = sessions.filter((s) => Boolean(s.archived));
  }
  sessions.sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));
  return sessions;
}

/**
 * Exact lookup only: id, chatId, or title (title case-insensitive).
 * No prefix, hex-suffix, or substring matching.
 */
function findExactInSessions(sessions, query) {
  if (query == null || query === '') return null;
  const raw = String(query).trim();
  if (!raw) return null;
  const q = raw.toLowerCase();
  const list = Array.isArray(sessions) ? sessions : [];
  let hit = list.find((s) => s.id === raw || s.chatId === raw || s.id === query || s.chatId === query);
  if (hit) return hit;
  hit = list.find((s) => String(s.title || '').toLowerCase() === q);
  return hit || null;
}

/**
 * Find within an in-memory sessions array (used under lock so we do not re-load).
 * Queries containing whitespace only allow exact id/chatId/title (no fuzzy fallbacks).
 */
function findInSessions(sessions, query) {
  if (!query) return null;
  const raw = String(query).trim();
  const q = raw.toLowerCase();
  const list = Array.isArray(sessions) ? sessions : [];
  let hit = list.find((s) => s.id === query || s.chatId === query);
  if (hit) return hit;
  hit = list.find((s) => s.title.toLowerCase() === q);
  if (hit) return hit;

  // Space-joined / multi-token queries must not fall through to prefix/hex/substring
  // (e.g. pasted "id1 id2 …-94d940" must not hex-match a session ending in -94d940).
  if (/\s/.test(raw)) return null;

  // Unique id / chatId prefix (at least 4 chars to avoid accidental matches).
  if (q.length >= 4) {
    const idPrefix = list.filter(
      (s) =>
        s.id.toLowerCase().startsWith(q) ||
        s.chatId.toLowerCase().startsWith(q)
    );
    if (idPrefix.length === 1) return idPrefix[0];
    if (idPrefix.length > 1) {
      const err = new Error(
        `ambiguous match for "${query}": ${idPrefix.map((m) => m.title).join(', ')}`
      );
      err.code = 'AMBIGUOUS';
      err.matches = idPrefix;
      throw err;
    }
  }

  // Trailing hex6 from displayId (`…-a05f23`, `-a05f23`, or `a05f23`).
  const hexMatch = q.match(/(?:^|\u2026|-)([0-9a-f]{6})$/i) || q.match(/^([0-9a-f]{6})$/i);
  if (hexMatch) {
    const hex = hexMatch[1].toLowerCase();
    const byHex = list.filter((s) => s.id.toLowerCase().endsWith(`-${hex}`));
    if (byHex.length === 1) return byHex[0];
    if (byHex.length > 1) {
      const err = new Error(
        `ambiguous match for "${query}": ${byHex.map((m) => m.title).join(', ')}`
      );
      err.code = 'AMBIGUOUS';
      err.matches = byHex;
      throw err;
    }
  }

  const matches = list.filter((s) => s.title.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const err = new Error(
      `ambiguous match for "${query}": ${matches.map((m) => m.title).join(', ')}`
    );
    err.code = 'AMBIGUOUS';
    err.matches = matches;
    throw err;
  }
  return null;
}

function find(query) {
  return findInSessions(load().sessions, query);
}

function findExact(query) {
  return findExactInSessions(load().sessions, query);
}

/**
 * @param {object} partial
 * @param {object} [opts]
 * @param {(data: {version:number, sessions: object[]}) => string} [opts.titleFn]
 * @param {{ parentTitle: string, parentId: string }} [opts.autoTitle]
 *   Recompute nextWorkerTitle from locked registry data (for concurrent af spawn).
 */
function add(partial, opts = {}) {
  return withLock(() => {
    const data = load();
    const toAdd = { ...partial };
    if (typeof opts.titleFn === 'function') {
      toAdd.title = opts.titleFn(data);
    } else if (opts.autoTitle && opts.autoTitle.parentTitle != null) {
      const parentId = opts.autoTitle.parentId;
      const childCount = parentId
        ? data.sessions.filter((s) => s.parent === parentId).length
        : 0;
      toAdd.title = orchestrate.nextWorkerTitle(
        opts.autoTitle.parentTitle,
        childCount,
        data.sessions.map((s) => s.title)
      );
    }
    const entry = normalizeEntry(toAdd);
    if (data.sessions.some((s) => s.id === entry.id)) {
      throw new Error(`session id already exists: ${entry.id}`);
    }
    if (data.sessions.some((s) => s.chatId === entry.chatId)) {
      throw new Error(`chatId already registered: ${entry.chatId}`);
    }
    data.sessions.push(entry);
    save(data);
    return entry;
  });
}

function update(query, patch) {
  return withLock(() => {
    const data = load();
    const current = findInSessions(data.sessions, query);
    if (!current) throw new Error(`session not found: ${query}`);
    const idx = data.sessions.findIndex((s) => s.id === current.id);
    const next = { ...data.sessions[idx], ...patch };
    if (patch.status && !STATUSES.has(patch.status)) {
      throw new Error(`invalid status: ${patch.status}`);
    }
    if (patch.engine && !ENGINES.has(patch.engine)) {
      throw new Error(`invalid engine: ${patch.engine} (want cursor, copilot, or opencode)`);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'role')) {
      next.role = orchestrate.validateRole(patch.role);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'workerStatus')) {
      next.workerStatus = orchestrate.validateWorkerStatus(patch.workerStatus);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'parent')) {
      next.parent =
        patch.parent != null && String(patch.parent).trim() !== ''
          ? String(patch.parent).trim()
          : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'project')) {
      next.project =
        patch.project != null && String(patch.project).trim() !== ''
          ? String(patch.project).trim()
          : null;
    }
    if (patch.task != null) next.task = String(patch.task);
    if (Object.prototype.hasOwnProperty.call(patch, 'result')) {
      next.result =
        patch.result != null && String(patch.result).trim() !== ''
          ? path.resolve(String(patch.result).trim())
          : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'plan')) {
      next.plan =
        patch.plan != null && String(patch.plan).trim() !== ''
          ? path.resolve(String(patch.plan).trim())
          : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'resultSource')) {
      if (patch.resultSource == null || patch.resultSource === '') {
        next.resultSource = null;
      } else {
        const rs = String(patch.resultSource).trim();
        if (rs !== 'worker' && rs !== 'af-fallback') {
          throw new Error(`invalid resultSource: ${rs} (want worker or af-fallback)`);
        }
        next.resultSource = rs;
      }
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'runPid')) {
      next.runPid = patch.runPid != null ? Number(patch.runPid) : null;
      if (Number.isNaN(next.runPid)) next.runPid = null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'runPgid')) {
      next.runPgid = patch.runPgid != null ? Number(patch.runPgid) : null;
      if (Number.isNaN(next.runPgid)) next.runPgid = null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'runHost')) {
      next.runHost = patch.runHost != null ? String(patch.runHost) : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'runStartedAt')) {
      next.runStartedAt = patch.runStartedAt || null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'stopRequested')) {
      next.stopRequested = Boolean(patch.stopRequested);
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'force')) {
      next.force = patch.force != null ? Boolean(patch.force) : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastSendAt')) {
      next.lastSendAt = patch.lastSendAt || null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'runId')) {
      next.runId = patch.runId != null ? String(patch.runId) : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'resultMtimeAtStart')) {
      next.resultMtimeAtStart =
        patch.resultMtimeAtStart != null ? Number(patch.resultMtimeAtStart) : null;
      if (Number.isNaN(next.resultMtimeAtStart)) next.resultMtimeAtStart = null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'resultRunId')) {
      next.resultRunId = patch.resultRunId != null ? String(patch.resultRunId) : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'lastError')) {
      next.lastError = patch.lastError != null ? String(patch.lastError) : null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'messaging')) {
      if (patch.messaging === true) next.messaging = true;
      else if (patch.messaging === false) next.messaging = false;
      else next.messaging = null;
    }
    if (Object.prototype.hasOwnProperty.call(patch, 'archived')) {
      next.archived = Boolean(patch.archived);
      if (!next.archived) {
        next.archivedAt = null;
      } else if (Object.prototype.hasOwnProperty.call(patch, 'archivedAt')) {
        next.archivedAt =
          patch.archivedAt != null && String(patch.archivedAt).trim() !== ''
            ? String(patch.archivedAt)
            : nowIso();
      } else if (!next.archivedAt) {
        next.archivedAt = nowIso();
      }
    } else if (Object.prototype.hasOwnProperty.call(patch, 'archivedAt')) {
      next.archivedAt =
        patch.archivedAt != null && String(patch.archivedAt).trim() !== ''
          ? String(patch.archivedAt)
          : null;
    }
    if (patch.title != null) next.title = String(patch.title).trim();
    if (patch.notes != null) next.notes = String(patch.notes);
    if (patch.tags != null) next.tags = Array.isArray(patch.tags) ? patch.tags.map(String) : [];
    data.sessions[idx] = next;
    save(data);
    return next;
  });
}

function touch(query) {
  return update(query, { lastUsed: nowIso() });
}

function remove(query) {
  return withLock(() => {
    const data = load();
    const current = findInSessions(data.sessions, query);
    if (!current) throw new Error(`session not found: ${query}`);
    const removedId = current.id;
    data.sessions = data.sessions.filter((s) => s.id !== removedId);
    // Keep parent links consistent: orphan remaining children of this session.
    for (const s of data.sessions) {
      if (s.parent === removedId) s.parent = null;
    }
    save(data);
    return current;
  });
}

function exportAll() {
  return load();
}

function importAll(payload, { merge = true } = {}) {
  if (!payload || !Array.isArray(payload.sessions)) {
    throw new Error('import file must contain { sessions: [] }');
  }
  return withLock(() => {
    if (!merge) {
      const data = { version: 1, sessions: payload.sessions.map((s) => normalizeEntry(s)) };
      save(data);
      return data;
    }
    const data = load();
    const byChat = new Map(data.sessions.map((s) => [s.chatId, s]));
    const byId = new Map(data.sessions.map((s) => [s.id, s]));
    let added = 0;
    let updated = 0;
    for (const raw of payload.sessions) {
      const entry = normalizeEntry(raw);
      if (byChat.has(entry.chatId)) {
        const existing = byChat.get(entry.chatId);
        const idx = data.sessions.findIndex((s) => s.id === existing.id);
        data.sessions[idx] = { ...existing, ...entry, id: existing.id };
        updated++;
      } else if (byId.has(entry.id)) {
        entry.id = makeId(entry.title);
        data.sessions.push(entry);
        added++;
      } else {
        data.sessions.push(entry);
        added++;
      }
    }
    save(data);
    return { added, updated, total: data.sessions.length };
  });
}


/** Exit code when a critical registry write fails after the engine has already exited. */
const REGISTRY_WRITE_EXIT = 75;

const CRITICAL_PATCH_KEYS = new Set([
  'runPid',
  'runPgid',
  'runHost',
  'runStartedAt',
  'runId',
  'workerStatus',
  'lastExit',
  'lastOutput',
  'resultSource',
  'resultRunId',
  'resultMtimeAtStart',
  'stopRequested',
  'lastError',
]);

function testHooksEnabled() {
  return (
    process.env.NODE_ENV === 'test' ||
    process.env.AGENTFLEET_ALLOW_TEST_HOOKS === '1' ||
    process.env.AGENTFLEET_ALLOW_TEST_HOOKS === 'true'
  );
}

/**
 * Test-only injection: AGENTFLEET_TEST_FAIL_WRITE=<token>
 * Tokens: before-launch | after-exit | critical | cosmetic | <field name>
 */
function maybeInjectWriteFailure(kind, patch, phase) {
  if (!testHooksEnabled()) return;
  const token = process.env.AGENTFLEET_TEST_FAIL_WRITE;
  if (!token) return;
  const t = String(token);
  const keys = patch && typeof patch === 'object' ? Object.keys(patch) : [];
  let hit = false;
  if (t === kind) hit = true;
  else if (t === phase) hit = true;
  else if (keys.includes(t)) hit = true;
  else if (t === 'critical' && kind === 'critical') hit = true;
  else if (t === 'cosmetic' && kind === 'cosmetic') hit = true;
  if (hit) {
    const err = new Error(`injected registry write failure (${t})`);
    err.code = 'AF_TEST_FAIL_WRITE';
    throw err;
  }
}

/**
 * Critical registry write (process identity / final run state).
 * Returns { ok, session, error }. Never throws.
 */
function criticalUpdate(query, patch, { phase } = {}) {
  try {
    maybeInjectWriteFailure('critical', patch, phase || null);
    const session = update(query, patch);
    return { ok: true, session, error: null };
  } catch (err) {
    return {
      ok: false,
      session: null,
      error: err && err.message ? err.message : String(err),
    };
  }
}

/**
 * Cosmetic registry write (lastUsed/touch, herdr cache, notes, titles).
 * Returns { ok, session, error }. Never throws; caller may warn.
 */
function bestEffortUpdate(query, patch) {
  try {
    maybeInjectWriteFailure('cosmetic', patch, null);
    const session = update(query, patch);
    return { ok: true, session, error: null };
  } catch (err) {
    return {
      ok: false,
      session: null,
      error: err && err.message ? err.message : String(err),
    };
  }
}

function bestEffortTouch(query) {
  return bestEffortUpdate(query, { lastUsed: nowIso() });
}

module.exports = {
  STATUSES,
  ENGINES,
  LOCK_WAIT_MS,
  LOCK_STALE_MS,
  REGISTRY_WRITE_EXIT,
  CRITICAL_PATCH_KEYS,
  load,
  save,
  list,
  find,
  findExact,
  findInSessions,
  findExactInSessions,
  add,
  update,
  touch,
  remove,
  exportAll,
  importAll,
  normalizeEntry,
  emptyRegistry,
  ensureDir,
  withLock,
  lockPath,
  acquireLock,
  releaseLock,
  tryBreakStaleLock,
  criticalUpdate,
  bestEffortUpdate,
  bestEffortTouch,
  ROLES: orchestrate.ROLES,
  WORKER_STATUSES: orchestrate.WORKER_STATUSES,
};
