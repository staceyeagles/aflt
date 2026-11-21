'use strict';

/**
 * Opt-in agent documentation: shared process doc, project AGENT-DOCS.md,
 * launch/resume path delivery, documentation checkpoint tracking (cadence,
 * note acknowledgement, bounded retry), and batched Doc Bot notifications.
 *
 * Enable with `.agentfleet.json` `{ "agentDocs": true }`.
 * Fleet knobs live in `$AGENTFLEET_HOME/config.json` under `"agentDocs"`.
 *
 * Distinction vs Copilot completion capture (`aflt dashboard --capture-completions`
 * / `lib/task-completions.js`): that path writes redacted Task Complete events
 * into memory status-notes. This module is the broader lifecycle process
 * (instructions on launch, checkpoints, archive convention, batched Doc Bot
 * inbox context). They share the memory folder but are independent.
 *
 * Doc Bot notifications are context only (never permissions). Messaging is
 * optional — checkpoint / pending / batch state stay useful with messaging off.
 *
 * Never auto-moves or deletes documents (archive convention is human/Doc Bot).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('./config');
const messages = require('./messages');
const memory = require('./memory');
const projectLib = require('./project');
const { fleetDir, nowIso, envNonEmpty } = require('./util');

const PROCESS_DOC_REL = 'DOCUMENTATION-PROCESS.md';
const AGENT_DOCS_REL = 'AGENT-DOCS.md';
const AGENTS_MD_REL = 'AGENTS.md';
const DEFAULT_CHECKPOINT_HOURS = 4;
const DEFAULT_RETRY_MAX = 3;
const DEFAULT_RETRY_BACKOFF_MINUTES = Object.freeze([30, 120, 360]);
const DEFAULT_BOUNDARIES = Object.freeze(['turn-complete', 'run-exit']);
const SAFE_BOUNDARIES = new Set([
  'turn-complete',
  'run-exit',
  'session-launch',
  'manual',
]);

/** Legacy constant — notifications enqueue/batch; messaging remains opt-in. */
const DOC_BOT_NOTIFY_DEFERRED = Object.freeze({
  deferred: false,
  issue: 2,
  reason:
    'Doc Bot inbox notifications are batched after notes are written; messaging stays optional (context only).',
});

function packageTemplatePath(name) {
  return path.join(__dirname, '..', 'templates', name);
}

function readPackageTemplate(name) {
  const p = packageTemplatePath(name);
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch (_) {
    /* ignore */
  }
  return null;
}

/**
 * Write DOCUMENTATION-PROCESS.md into a memory repo when missing (like DOC-AGENT.md).
 * Never overwrites. Never deletes/moves anything.
 * @param {string} repoDir
 * @returns {{ path: string, created: boolean }|null}
 */
function ensureProcessDocInMemoryRepo(repoDir) {
  if (!repoDir) return null;
  const dest = path.join(repoDir, PROCESS_DOC_REL);
  try {
    if (fs.existsSync(dest)) return { path: dest, created: false };
    const md = readPackageTemplate(PROCESS_DOC_REL);
    if (!md) return null;
    fs.writeFileSync(dest, md, 'utf8');
    return { path: dest, created: true };
  } catch (_) {
    return null;
  }
}

function checkpointsDir() {
  return path.join(fleetDir(), 'doc-checkpoints');
}

function checkpointSafeName(project) {
  const raw = projectLib.canonicalProjectName(String(project || '').trim()) || 'adhoc';
  return (
    String(raw)
      .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-')
      .replace(/^\.+/, '-')
      .slice(0, 120) || 'adhoc'
  );
}

function checkpointPath(project) {
  return path.join(checkpointsDir(), `${checkpointSafeName(project)}.json`);
}

function pendingPath() {
  return path.join(fleetDir(), 'doc-bot-pending.json');
}

function emptyCheckpointState(project) {
  return {
    project: projectLib.canonicalProjectName(project) || String(project || 'adhoc'),
    open: null,
    history: [],
    updatedAt: null,
  };
}

function emptyPendingState() {
  return {
    pending: [],
    batches: [],
    updatedAt: null,
  };
}

function loadCheckpointState(project) {
  const p = checkpointPath(project);
  try {
    if (!fs.existsSync(p)) return emptyCheckpointState(project);
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return emptyCheckpointState(project);
    }
    return {
      project: data.project || emptyCheckpointState(project).project,
      open: data.open && typeof data.open === 'object' ? data.open : null,
      history: Array.isArray(data.history) ? data.history : [],
      updatedAt: data.updatedAt || null,
    };
  } catch (_) {
    return emptyCheckpointState(project);
  }
}

function saveCheckpointState(state) {
  const dir = checkpointsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = checkpointPath(state.project);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(
    {
      project: state.project,
      open: state.open || null,
      history: Array.isArray(state.history) ? state.history.slice(-50) : [],
      updatedAt: nowIso(),
    },
    null,
    2
  );
  fs.writeFileSync(tmp, body + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

function loadPendingState() {
  const p = pendingPath();
  try {
    if (!fs.existsSync(p)) return emptyPendingState();
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return emptyPendingState();
    }
    return {
      pending: Array.isArray(data.pending) ? data.pending : [],
      batches: Array.isArray(data.batches) ? data.batches : [],
      updatedAt: data.updatedAt || null,
    };
  } catch (_) {
    return emptyPendingState();
  }
}

function savePendingState(state) {
  const dir = fleetDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = pendingPath();
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(
    {
      pending: Array.isArray(state.pending) ? state.pending.slice(-200) : [],
      batches: Array.isArray(state.batches) ? state.batches.slice(-50) : [],
      updatedAt: nowIso(),
    },
    null,
    2
  );
  fs.writeFileSync(tmp, body + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

function positiveInt(raw, fallback) {
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return fallback;
}

function parseBackoffMinutes(raw) {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_RETRY_BACKOFF_MINUTES.slice();
  const out = [];
  for (const x of raw) {
    const n = Number(x);
    if (Number.isFinite(n) && n > 0) out.push(Math.floor(n));
  }
  return out.length ? out : DEFAULT_RETRY_BACKOFF_MINUTES.slice();
}

function parseBoundaries(raw) {
  if (!Array.isArray(raw) || !raw.length) return DEFAULT_BOUNDARIES.slice();
  const out = [];
  for (const x of raw) {
    const s = String(x || '')
      .trim()
      .toLowerCase();
    if (SAFE_BOUNDARIES.has(s) && !out.includes(s)) out.push(s);
  }
  return out.length ? out : DEFAULT_BOUNDARIES.slice();
}

/**
 * Fleet-level agentDocs knobs from config.json (opt-in, simple defaults).
 * Project `.agentfleet.json` still gates enablement via `agentDocs: true`.
 * @param {NodeJS.ProcessEnv} [env]
 */
function resolveFleetAgentDocsConfig(env = process.env) {
  const data = config.load();
  const raw =
    data && data.agentDocs && typeof data.agentDocs === 'object' && !Array.isArray(data.agentDocs)
      ? data.agentDocs
      : {};

  let checkpointHours = null;
  if (raw.checkpointHours != null || raw.docCheckpointHours != null) {
    const n = Number(raw.checkpointHours != null ? raw.checkpointHours : raw.docCheckpointHours);
    if (Number.isFinite(n) && n > 0) checkpointHours = n;
  }

  const requireNote = raw.requireNote !== false;
  const batchNotify = raw.batchNotify !== false;
  const retryMax = positiveInt(raw.retryMax, DEFAULT_RETRY_MAX);
  const retryBackoffMinutes = parseBackoffMinutes(raw.retryBackoffMinutes);
  const boundaries = parseBoundaries(raw.boundaries);

  // Env overrides for tests / one-offs (optional).
  const hoursEnv = envNonEmpty(env, 'AFLT_DOC_CHECKPOINT_HOURS');
  if (hoursEnv && Number.isFinite(Number(hoursEnv)) && Number(hoursEnv) > 0) {
    checkpointHours = Number(hoursEnv);
  }

  return {
    checkpointHours,
    requireNote,
    batchNotify,
    retryMax,
    retryBackoffMinutes,
    boundaries,
    source: Object.keys(raw).length ? 'config' : 'defaults',
  };
}

/**
 * Read agentDocs opt-in from nearest `.agentfleet.json` with that key.
 * Merges fleet config.json knobs (hours / requireNote / retry / boundaries).
 * @param {string} cwd
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {object}
 */
function readAgentDocsConfig(cwd, opts = {}) {
  const fleet = resolveFleetAgentDocsConfig(opts.env || process.env);
  const hit = messages.findProjectConfig(cwd, { key: 'agentDocs' });
  if (!hit || !hit.data) {
    return {
      enabled: false,
      checkpointHours: fleet.checkpointHours || DEFAULT_CHECKPOINT_HOURS,
      requireNote: fleet.requireNote,
      batchNotify: fleet.batchNotify,
      retryMax: fleet.retryMax,
      retryBackoffMinutes: fleet.retryBackoffMinutes,
      boundaries: fleet.boundaries,
      configPath: null,
      fleetSource: fleet.source,
      data: null,
    };
  }
  const enabled = hit.data.agentDocs === true;
  let hours = fleet.checkpointHours || DEFAULT_CHECKPOINT_HOURS;
  const raw = hit.data.docCheckpointHours;
  if (raw != null && raw !== true) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) hours = n;
  }
  return {
    enabled,
    checkpointHours: hours,
    requireNote: fleet.requireNote,
    batchNotify: fleet.batchNotify,
    retryMax: fleet.retryMax,
    retryBackoffMinutes: fleet.retryBackoffMinutes,
    boundaries: fleet.boundaries,
    configPath: hit.path,
    fleetSource: fleet.source,
    data: hit.data,
  };
}

function fileIfExists(abs) {
  try {
    if (abs && fs.existsSync(abs) && fs.statSync(abs).isFile()) return abs;
  } catch (_) {
    /* ignore */
  }
  return null;
}

/**
 * Resolve project identity + instruction paths for a session/cwd.
 * Works with or without a memory repo. When agentDocs is enabled and memory
 * is missing, `missing` includes `memoryRepo`.
 *
 * @param {{ id?: string, cwd?: string, project?: string }|null} session
 * @param {{ cwd?: string, project?: string, env?: NodeJS.ProcessEnv, cache?: object }} [opts]
 */
function resolveAgentDocsContext(session, opts = {}) {
  const env = opts.env || process.env;
  const cwd =
    (opts.cwd != null && String(opts.cwd)) ||
    (session && session.cwd) ||
    process.cwd();
  const cache = opts.projectCache || projectLib.createLookupCache();
  const project =
    (opts.project != null && String(opts.project).trim()) ||
    (session && session.project && String(session.project).trim()) ||
    projectLib.resolveProjectName(session || { cwd }, { cache }) ||
    projectLib.ADHOC_NAME;
  const canonical = projectLib.canonicalProjectName(project) || project;

  const cfg = readAgentDocsConfig(cwd, { env });
  const mem = memory.resolveMemoryRepo(env);
  const memoryRepo = mem ? mem.path : null;
  const memorySource = mem ? mem.source : null;

  const agentsMdPath = fileIfExists(path.join(cwd, AGENTS_MD_REL));
  const agentDocsPath = fileIfExists(path.join(cwd, AGENT_DOCS_REL));

  let processDocPath = null;
  let processDocSource = null;
  if (memoryRepo) {
    const inMem = fileIfExists(path.join(memoryRepo, PROCESS_DOC_REL));
    if (inMem) {
      processDocPath = inMem;
      processDocSource = 'memory';
    }
  }
  if (!processDocPath) {
    const pkg = fileIfExists(packageTemplatePath(PROCESS_DOC_REL));
    if (pkg) {
      processDocPath = pkg;
      processDocSource = 'package';
    }
  }

  const memoryProjectFolder = memoryRepo
    ? path.join(memoryRepo, memory.sanitizeFolderName(canonical))
    : null;

  const missing = [];
  const warnings = [];
  if (cfg.enabled && !memoryRepo) {
    missing.push('memoryRepo');
    warnings.push(
      'agentDocs enabled but no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
  }
  if (cfg.enabled && memoryRepo && !fileIfExists(path.join(memoryRepo, PROCESS_DOC_REL))) {
    warnings.push(
      `missing ${PROCESS_DOC_REL} in memory repo (will fall back to package template until init/sync copies it)`
    );
  }
  if (cfg.enabled && !agentDocsPath) {
    warnings.push(
      `missing ${AGENT_DOCS_REL} in ${cwd} (copy templates/${AGENT_DOCS_REL} from the aflt package)`
    );
  }

  let statusNotes = { live: [], archived: [], archivedCount: 0 };
  if (memoryProjectFolder) {
    const notesDir = path.join(memoryProjectFolder, 'status-notes');
    statusNotes = summarizeStatusNotesDir(notesDir);
  }

  return {
    enabled: cfg.enabled,
    project: canonical,
    cwd: path.resolve(cwd),
    memoryRepo,
    memorySource,
    memoryProjectFolder,
    processDocPath,
    processDocSource,
    agentDocsPath,
    agentsMdPath,
    checkpointHours: cfg.checkpointHours,
    requireNote: cfg.requireNote,
    batchNotify: cfg.batchNotify,
    retryMax: cfg.retryMax,
    retryBackoffMinutes: cfg.retryBackoffMinutes,
    boundaries: cfg.boundaries,
    configPath: cfg.configPath,
    fleetSource: cfg.fleetSource,
    missing,
    warnings,
    statusNotes,
    // Archive convention: aflt never auto-moves/deletes; live notes ignore archive/.
    archivePolicy: 'never-auto-move-or-delete',
  };
}

/**
 * Env overlay with project identity + instruction paths.
 * @param {ReturnType<typeof resolveAgentDocsContext>} ctx
 * @returns {Record<string, string>}
 */
function agentDocsLaunchEnv(ctx) {
  const overlay = {};
  if (!ctx || !ctx.enabled) return overlay;
  if (ctx.project) overlay.AFLT_PROJECT = String(ctx.project);
  if (ctx.memoryRepo) overlay.AFLT_MEMORY_REPO = String(ctx.memoryRepo);
  if (ctx.processDocPath) overlay.AFLT_DOCS_PROCESS = String(ctx.processDocPath);
  if (ctx.agentDocsPath) overlay.AFLT_AGENT_DOCS = String(ctx.agentDocsPath);
  if (ctx.agentsMdPath) overlay.AFLT_AGENTS_MD = String(ctx.agentsMdPath);
  if (ctx.memoryProjectFolder) {
    overlay.AFLT_MEMORY_PROJECT = String(ctx.memoryProjectFolder);
  }
  if (ctx.missing && ctx.missing.includes('memoryRepo')) {
    overlay.AFLT_MEMORY_MISSING = '1';
  }
  return overlay;
}

/**
 * Short preamble for prompts. Preserves existing project instructions by
 * pointing at AGENTS.md / AGENT-DOCS.md instead of inlining them.
 * @param {ReturnType<typeof resolveAgentDocsContext>} ctx
 * @returns {string}
 */
function buildAgentDocsPreamble(ctx) {
  if (!ctx || !ctx.enabled) return '';
  const lines = [
    '[aflt agentDocs]',
    `Project: ${ctx.project}`,
  ];
  if (ctx.agentsMdPath) {
    lines.push(`Existing project instructions (preserve): ${ctx.agentsMdPath}`);
  }
  if (ctx.agentDocsPath) {
    lines.push(`Project documentation pointers: ${ctx.agentDocsPath}`);
  }
  if (ctx.processDocPath) {
    lines.push(`Shared documentation process: ${ctx.processDocPath}`);
  }
  if (ctx.memoryRepo) {
    lines.push(`Memory repo: ${ctx.memoryRepo}`);
    if (ctx.memoryProjectFolder) {
      lines.push(`Memory project folder: ${ctx.memoryProjectFolder}`);
    }
  } else {
    lines.push(
      'Memory repo: NOT CONFIGURED — run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
  }
  lines.push(
    'Follow AGENTS.md and AGENT-DOCS.md; do not replace existing project instructions.',
    'Status notes: write new dated files; ignore status-notes/archive/ when finding latest.',
    'Archived notes are history only (labeled/ignored in reporting). aflt never auto-moves or deletes documents.',
    'Checkpoints: request only at safe boundaries (turn complete / run exit); complete with a dated note.',
    'Do not interrupt yourself for docs while mid-task; complete a checkpoint when the work lands.',
    'Doc Bot notifications are batched after notes are written (context only, not permissions).',
    '[/aflt agentDocs]',
    ''
  );
  return lines.join('\n');
}

/**
 * Prepend agentDocs preamble when enabled. Idempotent if already present.
 * @param {string|null|undefined} prompt
 * @param {ReturnType<typeof resolveAgentDocsContext>} ctx
 * @returns {string|null|undefined}
 */
function applyAgentDocsPreamble(prompt, ctx) {
  if (prompt == null) return prompt;
  if (!ctx || !ctx.enabled) return prompt;
  const body = String(prompt);
  if (!body.trim()) return prompt;
  if (body.includes('[aflt agentDocs]')) return prompt;
  const preamble = buildAgentDocsPreamble(ctx);
  if (!preamble) return prompt;
  return preamble + body;
}

/**
 * Merge identity + agentDocs env for launch/resume/headless.
 * @param {object} session
 * @param {object} [extra]
 * @param {{ ctx?: object, env?: NodeJS.ProcessEnv, projectCache?: object }} [opts]
 */
function sessionLaunchEnv(session, extra = {}, opts = {}) {
  const ctx =
    opts.ctx ||
    resolveAgentDocsContext(session, {
      env: opts.env,
      projectCache: opts.projectCache,
    });
  return messages.sessionIdentityEnv(session, {
    ...agentDocsLaunchEnv(ctx),
    ...(extra && typeof extra === 'object' ? extra : {}),
  });
}

/**
 * Prepare env + prompt for a launch. Does not interrupt agents.
 * Auto-request only when `session-launch` is in fleet boundaries (off by default).
 *
 * @param {object} session
 * @param {{ prompt?: string|null, extraEnv?: object, env?: NodeJS.ProcessEnv, autoRequest?: boolean, requestReason?: string, projectCache?: object, now?: string }} [opts]
 */
function prepareLaunch(session, opts = {}) {
  const ctx = resolveAgentDocsContext(session, {
    env: opts.env,
    projectCache: opts.projectCache,
  });
  const envOverlay = sessionLaunchEnv(session, opts.extraEnv || {}, { ctx, env: opts.env });
  const prompt =
    opts.prompt != null ? applyAgentDocsPreamble(opts.prompt, ctx) : opts.prompt;

  let checkpoint = null;
  const launchInBoundaries = (ctx.boundaries || []).includes('session-launch');
  const autoRequest =
    opts.autoRequest != null ? Boolean(opts.autoRequest) : launchInBoundaries;
  if (ctx.enabled && autoRequest) {
    checkpoint = requestCheckpoint(ctx.project, {
      sessionId: session && session.id,
      reason: opts.requestReason || 'session-launch',
      now: opts.now,
      onlyIfNoneOpen: true,
      boundary: 'session-launch',
      skipBusyCheck: true,
    });
  } else if (ctx.enabled) {
    checkpoint = summarizeCheckpoint(ctx.project, {
      hours: ctx.checkpointHours,
      now: opts.now,
      retryMax: ctx.retryMax,
      retryBackoffMinutes: ctx.retryBackoffMinutes,
    });
  }

  return {
    ctx,
    env: envOverlay,
    prompt,
    checkpoint,
    warnings: ctx.warnings.slice(),
    missing: ctx.missing.slice(),
  };
}

function makeCheckpointId() {
  return crypto.randomUUID();
}

function parseNowMs(now) {
  if (now == null) return Date.now();
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number') return now;
  const ms = Date.parse(String(now));
  return Number.isFinite(ms) ? ms : Date.now();
}

function isSessionBusy(session, opts = {}) {
  if (!session) return false;
  try {
    const archiveLib = require('./archive');
    const hit = archiveLib.sessionBusyForMutation(session, opts);
    return Boolean(hit && hit.busy);
  } catch (_) {
    if (session.runPid != null) {
      try {
        process.kill(Number(session.runPid), 0);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }
}

/**
 * Resolve a dated status note path under the project's memory folder.
 * Rejects archive/ paths. Never moves or deletes anything.
 *
 * @param {string} project
 * @param {string} notePath
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string }} [opts]
 * @returns {{ ok: boolean, abs: string|null, rel: string|null, reason?: string }}
 */
function resolveNotePath(project, notePath, opts = {}) {
  if (!notePath || !String(notePath).trim()) {
    return { ok: false, abs: null, rel: null, reason: 'note path required' };
  }
  const name = projectLib.canonicalProjectName(project) || String(project || 'adhoc');
  const mem = memory.resolveMemoryRepo(opts.env || process.env);
  if (!mem || !mem.path) {
    // Allow absolute existing files outside memory when no repo (still reject archive/).
    const raw = String(notePath).trim();
    const abs = path.isAbsolute(raw) ? raw : path.resolve(opts.cwd || process.cwd(), raw);
    if (/[/\\]archive[/\\]/i.test(abs) || /(^|[/\\])archive[/\\]/i.test(raw)) {
      return { ok: false, abs: null, rel: null, reason: 'archived notes cannot acknowledge a checkpoint' };
    }
    if (!fileIfExists(abs)) {
      return { ok: false, abs: null, rel: null, reason: `note not found: ${raw}` };
    }
    return { ok: true, abs, rel: raw };
  }
  const folder = path.join(mem.path, memory.sanitizeFolderName(name));
  const notesDir = path.join(folder, 'status-notes');
  const raw = String(notePath).trim();
  let abs;
  if (path.isAbsolute(raw)) {
    abs = path.resolve(raw);
  } else if (raw.startsWith('status-notes/') || raw.startsWith('status-notes\\')) {
    abs = path.resolve(folder, raw);
  } else {
    abs = path.resolve(notesDir, raw);
  }
  const notesRoot = path.resolve(notesDir);
  if (!abs.startsWith(notesRoot + path.sep) && abs !== notesRoot) {
    return {
      ok: false,
      abs: null,
      rel: null,
      reason: 'note must live under the project memory status-notes/ folder',
    };
  }
  const relFromNotes = path.relative(notesRoot, abs);
  if (relFromNotes.split(path.sep)[0] === 'archive' || /[/\\]archive[/\\]/.test(abs)) {
    return {
      ok: false,
      abs: null,
      rel: null,
      reason: 'archived notes cannot acknowledge a checkpoint (move back to live first)',
    };
  }
  if (!fileIfExists(abs)) {
    return { ok: false, abs: null, rel: null, reason: `note not found: ${raw}` };
  }
  return {
    ok: true,
    abs,
    rel: path.join('status-notes', path.relative(notesRoot, abs)).replace(/\\/g, '/'),
  };
}

/**
 * Record a documentation checkpoint request.
 * Prefer safe boundaries via maybeRequestAtBoundary; manual CLI still allowed.
 *
 * @param {string} project
 * @param {{ sessionId?: string, reason?: string, now?: string, onlyIfNoneOpen?: boolean, boundary?: string, skipBusyCheck?: boolean, session?: object, hours?: number }} [opts]
 */
function requestCheckpoint(project, opts = {}) {
  const name = projectLib.canonicalProjectName(project) || String(project || 'adhoc');
  const fleet = resolveFleetAgentDocsConfig(opts.env || process.env);
  const hours =
    opts.hours != null && Number.isFinite(Number(opts.hours)) && Number(opts.hours) > 0
      ? Number(opts.hours)
      : fleet.checkpointHours || DEFAULT_CHECKPOINT_HOURS;

  if (!opts.skipBusyCheck && opts.session && isSessionBusy(opts.session, opts)) {
    const summary = summarizeCheckpoint(name, {
      hours,
      now: opts.now,
      retryMax: fleet.retryMax,
      retryBackoffMinutes: fleet.retryBackoffMinutes,
    });
    summary.skipped = true;
    summary.skipReason = 'busy';
    return summary;
  }

  const state = loadCheckpointState(name);
  if (opts.onlyIfNoneOpen && state.open) {
    const summary = summarizeCheckpoint(name, {
      hours,
      now: opts.now,
      state,
      retryMax: fleet.retryMax,
      retryBackoffMinutes: fleet.retryBackoffMinutes,
    });
    summary.skipped = true;
    summary.skipReason = 'open';
    return summary;
  }
  const at = opts.now || nowIso();
  const entry = {
    id: makeCheckpointId(),
    at,
    sessionId: opts.sessionId || (opts.session && opts.session.id) || null,
    reason: opts.reason ? String(opts.reason).slice(0, 200) : 'request',
    boundary: opts.boundary ? String(opts.boundary).slice(0, 40) : 'manual',
    notifyAttempts: 0,
    lastNotifyAt: null,
    nextRetryAt: null,
    retriesExhausted: false,
  };
  state.open = entry;
  state.updatedAt = at;
  saveCheckpointState(state);

  // Request events are bookkeeping; Doc Bot notify waits for a written note
  // (or retry reminders via processCheckpointRetries). Enqueue a non-ready item
  // so status can show pending request context without sending yet.
  const queued = enqueueDocBotPending({
    type: 'checkpoint-requested',
    project: name,
    sessionId: entry.sessionId,
    checkpointId: entry.id,
    reason: entry.reason,
    boundary: entry.boundary,
    noteReady: false,
    at,
  });

  const summary = summarizeCheckpoint(name, {
    hours,
    now: at,
    state,
    retryMax: fleet.retryMax,
    retryBackoffMinutes: fleet.retryBackoffMinutes,
  });
  summary.docBotNotify = {
    sent: false,
    queued: true,
    pendingId: queued && queued.id,
    issue: 2,
    reason: 'queued; notify after dated note is written (batched)',
  };
  return summary;
}

/**
 * Safe-boundary checkpoint request. Never interrupts a busy agent.
 * Elapsed time alone never triggers a request (only an allowed boundary does).
 *
 * @param {object|null} session
 * @param {string} boundary  turn-complete | run-exit | session-launch | manual
 * @param {{ now?: string, env?: NodeJS.ProcessEnv, projectCache?: object, reason?: string }} [opts]
 */
function maybeRequestAtBoundary(session, boundary, opts = {}) {
  const b = String(boundary || '')
    .trim()
    .toLowerCase();
  if (!SAFE_BOUNDARIES.has(b)) {
    return { requested: false, reason: `unknown boundary: ${boundary}` };
  }
  if (!session) {
    return { requested: false, reason: 'no session' };
  }
  const ctx = resolveAgentDocsContext(session, {
    env: opts.env,
    projectCache: opts.projectCache,
  });
  if (!ctx.enabled) {
    return { requested: false, reason: 'agentDocs disabled', ctx };
  }
  if (!(ctx.boundaries || []).includes(b) && b !== 'manual') {
    return { requested: false, reason: `boundary ${b} not enabled`, ctx };
  }
  if (isSessionBusy(session, opts)) {
    return { requested: false, reason: 'busy', ctx };
  }
  const summary = requestCheckpoint(ctx.project, {
    sessionId: session.id,
    session,
    reason: opts.reason || b,
    boundary: b,
    now: opts.now,
    onlyIfNoneOpen: true,
    skipBusyCheck: true,
    hours: ctx.checkpointHours,
    env: opts.env,
  });
  return {
    requested: summary.progress === 'requested' && !summary.skipped,
    checkpoint: summary,
    ctx,
  };
}

/**
 * Mark the open checkpoint completed. Acknowledgement = a dated note that
 * exists under the project memory status-notes/ (not archive/), when requireNote.
 *
 * @param {string} project
 * @param {{ sessionId?: string, notePath?: string, now?: string, env?: NodeJS.ProcessEnv, cwd?: string, requireNote?: boolean }} [opts]
 */
function completeCheckpoint(project, opts = {}) {
  const name = projectLib.canonicalProjectName(project) || String(project || 'adhoc');
  const fleet = resolveFleetAgentDocsConfig(opts.env || process.env);
  const requireNote = opts.requireNote != null ? Boolean(opts.requireNote) : fleet.requireNote;
  const hours = fleet.checkpointHours || DEFAULT_CHECKPOINT_HOURS;

  let note = null;
  if (requireNote || (opts.notePath && String(opts.notePath).trim())) {
    if (!opts.notePath || !String(opts.notePath).trim()) {
      const err = new Error(
        'checkpoint acknowledgement requires a dated note (--note PATH under status-notes/)'
      );
      err.code = 'NOTE_REQUIRED';
      throw err;
    }
    note = resolveNotePath(name, opts.notePath, {
      env: opts.env,
      cwd: opts.cwd,
    });
    if (!note.ok) {
      const err = new Error(note.reason || 'invalid note path');
      err.code = 'NOTE_INVALID';
      throw err;
    }
  }

  const state = loadCheckpointState(name);
  const at = opts.now || nowIso();
  const open = state.open;
  const completion = {
    id: makeCheckpointId(),
    at,
    sessionId: opts.sessionId || null,
    notePath: note ? note.rel || note.abs : opts.notePath ? String(opts.notePath) : null,
    noteAbs: note ? note.abs : null,
    requestedId: open ? open.id : null,
    requestedAt: open ? open.at : null,
  };
  state.history.push({
    requested: open,
    completed: completion,
  });
  state.open = null;
  state.updatedAt = at;
  saveCheckpointState(state);

  // Drop non-ready request placeholders for this checkpoint; enqueue note-ready notify.
  dropPendingForCheckpoint(open && open.id);
  const queued = enqueueDocBotPending({
    type: 'checkpoint-completed',
    project: name,
    sessionId: completion.sessionId,
    checkpointId: completion.id,
    requestedId: completion.requestedId,
    notePath: completion.notePath,
    noteAbs: completion.noteAbs,
    noteReady: Boolean(completion.notePath),
    at,
  });

  // Mark sibling turn-captured items for this project ready once a note exists.
  if (completion.notePath) {
    markProjectTurnsNoteReady(name, completion.notePath, at);
  }

  let flushResult = null;
  if (fleet.batchNotify && completion.notePath) {
    flushResult = flushDocBotBatch({
      project: name,
      sessionId: completion.sessionId,
      now: at,
      env: opts.env,
    });
  }

  const summary = summarizeCheckpoint(name, {
    hours,
    now: at,
    state,
    retryMax: fleet.retryMax,
    retryBackoffMinutes: fleet.retryBackoffMinutes,
  });
  summary.docBotNotify = {
    sent: Boolean(flushResult && flushResult.sent),
    queued: true,
    pendingId: queued && queued.id,
    batchId: flushResult && flushResult.batch && flushResult.batch.id,
    issue: 2,
    reason:
      flushResult && flushResult.reason
        ? flushResult.reason
        : completion.notePath
          ? 'queued/flushed after note written'
          : 'queued (no note)',
    flush: flushResult,
  };
  return summary;
}

/**
 * Status view for one project. Elapsed time is reported for overdue labeling only —
 * it is never treated as progress (progress = requested → completed).
 *
 * @param {string} project
 * @param {{ hours?: number, now?: string|number|Date, state?: object, retryMax?: number, retryBackoffMinutes?: number[] }} [opts]
 */
function summarizeCheckpoint(project, opts = {}) {
  const name = projectLib.canonicalProjectName(project) || String(project || 'adhoc');
  const fleet = resolveFleetAgentDocsConfig();
  const state = opts.state || loadCheckpointState(name);
  const hours =
    opts.hours != null && Number.isFinite(Number(opts.hours)) && Number(opts.hours) > 0
      ? Number(opts.hours)
      : fleet.checkpointHours || DEFAULT_CHECKPOINT_HOURS;
  const retryMax =
    opts.retryMax != null ? positiveInt(opts.retryMax, DEFAULT_RETRY_MAX) : fleet.retryMax;
  const backoff =
    opts.retryBackoffMinutes || fleet.retryBackoffMinutes || DEFAULT_RETRY_BACKOFF_MINUTES;
  const nowMs = parseNowMs(opts.now);
  const open = state.open || null;
  let ageHours = null;
  let overdue = false;
  let missing = false;
  let retryDue = false;
  if (open && open.at) {
    missing = true;
    const requestedMs = Date.parse(String(open.at));
    if (Number.isFinite(requestedMs) && Number.isFinite(nowMs)) {
      ageHours = Math.max(0, (nowMs - requestedMs) / (60 * 60 * 1000));
      overdue = ageHours >= hours;
    }
    if (open.nextRetryAt) {
      const nextMs = Date.parse(String(open.nextRetryAt));
      if (Number.isFinite(nextMs) && nowMs >= nextMs && !open.retriesExhausted) {
        retryDue = true;
      }
    } else if (overdue && !open.retriesExhausted) {
      retryDue = true;
    }
  }
  const lastCompleted =
    state.history && state.history.length
      ? state.history[state.history.length - 1].completed || null
      : null;
  return {
    project: name,
    open,
    missing,
    overdue,
    ageHours,
    checkpointHours: hours,
    // Explicit: age is not a progress metric
    progress: open ? 'requested' : lastCompleted ? 'completed' : 'none',
    lastCompleted,
    updatedAt: state.updatedAt || null,
    notifyAttempts: open && open.notifyAttempts != null ? open.notifyAttempts : 0,
    nextRetryAt: open && open.nextRetryAt ? open.nextRetryAt : null,
    retriesExhausted: Boolean(open && open.retriesExhausted),
    retryDue,
    retryMax,
    retryBackoffMinutes: backoff.slice(),
  };
}

/**
 * Bounded retry with backoff for unacknowledged (open) checkpoints.
 * Only enqueues reminder notifications — never interrupts a busy agent.
 * Elapsed time gates retry timing only; progress remains requested→completed.
 *
 * @param {{ now?: string|number|Date, env?: NodeJS.ProcessEnv, projects?: string[] }} [opts]
 */
function processCheckpointRetries(opts = {}) {
  const fleet = resolveFleetAgentDocsConfig(opts.env || process.env);
  const nowMs = parseNowMs(opts.now);
  const now = opts.now || nowIso();
  const dir = checkpointsDir();
  let names = [];
  if (Array.isArray(opts.projects) && opts.projects.length) {
    names = opts.projects.map((p) => projectLib.canonicalProjectName(p) || String(p));
  } else {
    try {
      if (fs.existsSync(dir)) {
        names = fs
          .readdirSync(dir)
          .filter((f) => f.endsWith('.json'))
          .map((f) => f.replace(/\.json$/, ''));
      }
    } catch (_) {
      names = [];
    }
  }

  const results = [];
  for (const name of names) {
    const state = loadCheckpointState(name);
    const open = state.open;
    if (!open) continue;
    const summary = summarizeCheckpoint(name, {
      hours: fleet.checkpointHours || DEFAULT_CHECKPOINT_HOURS,
      now: nowMs,
      state,
      retryMax: fleet.retryMax,
      retryBackoffMinutes: fleet.retryBackoffMinutes,
    });
    if (!summary.retryDue || summary.retriesExhausted) {
      results.push({ project: name, retried: false, reason: 'not-due', checkpoint: summary });
      continue;
    }
    const attempts = Number(open.notifyAttempts) || 0;
    if (attempts >= fleet.retryMax) {
      open.retriesExhausted = true;
      open.nextRetryAt = null;
      state.open = open;
      state.updatedAt = typeof now === 'string' ? now : nowIso();
      saveCheckpointState(state);
      results.push({
        project: name,
        retried: false,
        reason: 'exhausted',
        checkpoint: summarizeCheckpoint(name, { now: nowMs, state, retryMax: fleet.retryMax }),
      });
      continue;
    }

    const backoffMin =
      fleet.retryBackoffMinutes[
        Math.min(attempts, fleet.retryBackoffMinutes.length - 1)
      ] || 30;
    const nextAt = new Date(nowMs + backoffMin * 60 * 1000).toISOString();
    open.notifyAttempts = attempts + 1;
    open.lastNotifyAt = typeof now === 'string' ? now : nowIso();
    open.nextRetryAt = nextAt;
    if (open.notifyAttempts >= fleet.retryMax) {
      open.retriesExhausted = true;
    }
    state.open = open;
    state.updatedAt = open.lastNotifyAt;
    saveCheckpointState(state);

    const queued = enqueueDocBotPending({
      type: 'checkpoint-retry',
      project: name,
      sessionId: open.sessionId,
      checkpointId: open.id,
      reason: open.reason,
      attempt: open.notifyAttempts,
      noteReady: false,
      reminder: true,
      at: open.lastNotifyAt,
    });

    // Reminders may flush without a new note (context only) when messaging on.
    const flush = flushDocBotBatch({
      project: name,
      sessionId: open.sessionId,
      now: open.lastNotifyAt,
      includeReminders: true,
      env: opts.env,
    });

    results.push({
      project: name,
      retried: true,
      pendingId: queued && queued.id,
      flush,
      checkpoint: summarizeCheckpoint(name, {
        now: nowMs,
        state,
        retryMax: fleet.retryMax,
        retryBackoffMinutes: fleet.retryBackoffMinutes,
      }),
    });
  }
  return { ok: true, results, at: typeof now === 'string' ? now : nowIso() };
}

/**
 * Collect checkpoint summaries for enabled projects (from sessions + optional names).
 * Never interrupts agents. May process due retries when `processRetries` is true.
 *
 * @param {Array<object>} sessions
 * @param {{ now?: string|number|Date, env?: NodeJS.ProcessEnv, projectCache?: object, processRetries?: boolean }} [opts]
 */
function collectCheckpointStatuses(sessions, opts = {}) {
  if (opts.processRetries) {
    try {
      processCheckpointRetries({ now: opts.now, env: opts.env });
    } catch (_) {
      /* status path must not throw */
    }
  }
  const cache = opts.projectCache || projectLib.createLookupCache();
  const byProject = new Map();
  for (const s of sessions || []) {
    if (!s) continue;
    const cwd = s.cwd || process.cwd();
    const cfg = readAgentDocsConfig(cwd, { env: opts.env });
    if (!cfg.enabled) continue;
    const name =
      projectLib.canonicalProjectName(projectLib.resolveProjectName(s, { cache })) ||
      projectLib.ADHOC_NAME;
    if (byProject.has(name)) continue;
    byProject.set(
      name,
      summarizeCheckpoint(name, {
        hours: cfg.checkpointHours,
        now: opts.now,
        retryMax: cfg.retryMax,
        retryBackoffMinutes: cfg.retryBackoffMinutes,
      })
    );
  }
  return [...byProject.values()].sort((a, b) => a.project.localeCompare(b.project));
}

/**
 * List live status-note filenames under a notes directory (ignore archive/ and subdirs).
 * Never moves or deletes anything.
 * @param {string} notesDir
 * @returns {string[]}
 */
function listLiveStatusNotes(notesDir) {
  let entries = [];
  try {
    if (!notesDir || !fs.existsSync(notesDir)) return [];
    entries = fs.readdirSync(notesDir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name || name.startsWith('.')) continue;
    if (name === 'archive') continue;
    const abs = path.join(notesDir, name);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch (_) {
      continue;
    }
    if (!/\.md$/i.test(name)) continue;
    out.push(name);
  }
  out.sort();
  return out;
}

/**
 * List archived status-note filenames (status-notes/archive/). Read-only.
 * @param {string} notesDir  parent status-notes/ directory
 * @returns {string[]}
 */
function listArchivedStatusNotes(notesDir) {
  const archiveDir = path.join(notesDir || '', 'archive');
  let entries = [];
  try {
    if (!archiveDir || !fs.existsSync(archiveDir)) return [];
    entries = fs.readdirSync(archiveDir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of entries) {
    if (!name || name.startsWith('.')) continue;
    const abs = path.join(archiveDir, name);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch (_) {
      continue;
    }
    if (!/\.md$/i.test(name)) continue;
    out.push(name);
  }
  out.sort();
  return out;
}

/**
 * Live + archived listing for reporting (labels archived; never moves/deletes).
 * @param {string} notesDir
 */
function summarizeStatusNotesDir(notesDir) {
  const live = listLiveStatusNotes(notesDir);
  const archived = listArchivedStatusNotes(notesDir);
  return {
    live,
    archived,
    archivedCount: archived.length,
    latestLive: live.length ? live[live.length - 1] : null,
  };
}

function enqueueDocBotPending(item) {
  const state = loadPendingState();
  const entry = {
    id: makeCheckpointId(),
    type: item.type || 'note',
    project: item.project || null,
    sessionId: item.sessionId || null,
    checkpointId: item.checkpointId || null,
    requestedId: item.requestedId || null,
    turnId: item.turnId || null,
    notePath: item.notePath || null,
    noteAbs: item.noteAbs || null,
    noteReady: Boolean(item.noteReady),
    reminder: Boolean(item.reminder),
    reason: item.reason || null,
    boundary: item.boundary || null,
    attempt: item.attempt != null ? item.attempt : null,
    prompt: item.prompt != null ? String(item.prompt).slice(0, 500) : null,
    reply: item.reply != null ? String(item.reply).slice(0, 500) : null,
    at: item.at || nowIso(),
  };
  state.pending.push(entry);
  savePendingState(state);
  return entry;
}

function dropPendingForCheckpoint(checkpointId) {
  if (!checkpointId) return;
  const state = loadPendingState();
  const before = state.pending.length;
  state.pending = state.pending.filter(
    (p) =>
      !(
        p &&
        (p.checkpointId === checkpointId || p.requestedId === checkpointId) &&
        (p.type === 'checkpoint-requested' || p.type === 'checkpoint-retry') &&
        !p.noteReady
      )
  );
  if (state.pending.length !== before) savePendingState(state);
}

function markProjectTurnsNoteReady(project, notePath, at) {
  const name = projectLib.canonicalProjectName(project) || String(project || 'adhoc');
  const state = loadPendingState();
  let changed = false;
  for (const p of state.pending) {
    if (!p || p.project !== name) continue;
    if (p.type !== 'turn-captured') continue;
    if (p.noteReady) continue;
    p.noteReady = true;
    p.notePath = notePath;
    p.readyAt = at || nowIso();
    changed = true;
  }
  if (changed) savePendingState(state);
}

/**
 * Enqueue a captured turn for batched Doc Bot notify (no immediate DM).
 * Also attempts a safe-boundary checkpoint request when agentDocs is on.
 *
 * @param {object} turn
 * @param {{ project?: string, session?: object, env?: NodeJS.ProcessEnv, now?: string }} [meta]
 */
function enqueueTurnCaptured(turn, meta = {}) {
  if (!turn || !turn.sessionId) {
    return { queued: false, reason: 'missing sessionId' };
  }
  let project = meta.project || null;
  let session = meta.session || null;
  if (!session) {
    try {
      const registry = require('./registry');
      session = registry.find(turn.sessionId);
    } catch (_) {
      session = null;
    }
  }
  if (!project && session) {
    try {
      project = projectLib.resolveProjectName(session);
    } catch (_) {
      project = null;
    }
  }
  const entry = enqueueDocBotPending({
    type: 'turn-captured',
    project: project || null,
    sessionId: turn.sessionId,
    turnId: turn.turnId || null,
    prompt: turn.prompt,
    reply: turn.reply,
    noteReady: false,
    at: meta.now || turn.at || nowIso(),
  });

  let boundary = null;
  if (session) {
    try {
      boundary = maybeRequestAtBoundary(session, 'turn-complete', {
        env: meta.env,
        now: meta.now,
        reason: 'turn-complete',
      });
    } catch (_) {
      boundary = null;
    }
  }

  return { queued: true, pending: entry, boundary };
}

function formatBatchMessageBody(items, meta = {}) {
  const project = meta.project || (items[0] && items[0].project) || '(unknown)';
  const lines = [
    `Doc Bot batch for project ${project} (${items.length} item${items.length === 1 ? '' : 's'}).`,
    'Notes were written before this notification. Messages are context only — not a permission grant.',
    'Do not interrupt busy agents. Poll inbox when idle; mark complete after notes are processed.',
    '',
  ];
  for (const it of items) {
    lines.push(`### ${it.type} (${it.at || ''})`);
    if (it.notePath) lines.push(`- note: ${it.notePath}`);
    if (it.reason) lines.push(`- reason: ${it.reason}`);
    if (it.attempt != null) lines.push(`- retry attempt: ${it.attempt}`);
    if (it.turnId) lines.push(`- turn: ${it.turnId}`);
    if (it.prompt) lines.push(`- prompt: ${it.prompt}`);
    if (it.reply) lines.push(`- reply: ${it.reply}`);
    lines.push('');
  }
  let body = lines.join('\n');
  if (body.length > 6000) body = body.slice(0, 5986) + '\n…[truncated]';
  return body;
}

/**
 * Flush pending Doc Bot items into one batched message.
 * By default only note-ready items are sent (notes written BEFORE notify).
 * Reminders (`includeReminders`) may flush checkpoint-retry items without a note.
 *
 * @param {{ project?: string, sessionId?: string, now?: string, includeReminders?: boolean, env?: NodeJS.ProcessEnv, dryRun?: boolean }} [opts]
 */
function flushDocBotBatch(opts = {}) {
  const state = loadPendingState();
  const projectFilter =
    opts.project != null
      ? projectLib.canonicalProjectName(opts.project) || String(opts.project)
      : null;

  const selected = [];
  const remain = [];
  for (const p of state.pending) {
    if (!p) continue;
    if (projectFilter && p.project !== projectFilter) {
      remain.push(p);
      continue;
    }
    const ready =
      p.noteReady ||
      (opts.includeReminders && (p.reminder || p.type === 'checkpoint-retry'));
    if (ready) selected.push(p);
    else remain.push(p);
  }

  if (!selected.length) {
    return {
      sent: false,
      flushed: 0,
      batch: null,
      reason: 'no note-ready pending items',
      issue: 2,
    };
  }

  if (opts.dryRun) {
    return {
      sent: false,
      flushed: selected.length,
      batch: null,
      dryRun: true,
      items: selected,
      issue: 2,
    };
  }

  const at = opts.now || nowIso();
  const batch = {
    id: makeCheckpointId(),
    at,
    project: projectFilter || selected[0].project || null,
    itemIds: selected.map((s) => s.id),
    items: selected.map((s) => ({
      id: s.id,
      type: s.type,
      notePath: s.notePath || null,
      turnId: s.turnId || null,
      checkpointId: s.checkpointId || null,
    })),
    messageId: null,
    status: 'pending',
    ackedAt: null,
    sent: false,
    reason: null,
  };

  const sendResult = sendBatchToDocBot(selected, {
    project: batch.project,
    sessionId: opts.sessionId || selected[0].sessionId,
  });

  batch.sent = Boolean(sendResult.sent);
  batch.messageId = sendResult.message && sendResult.message.id ? sendResult.message.id : null;
  batch.status = sendResult.sent ? 'sent' : sendResult.reason === 'messaging disabled' ||
    (sendResult.reason && /messaging not enabled|no doc-bot/i.test(sendResult.reason))
      ? 'recorded-no-messaging'
      : 'failed';
  batch.reason = sendResult.reason || null;

  state.pending = remain;
  state.batches.push(batch);
  savePendingState(state);

  return {
    sent: batch.sent,
    flushed: selected.length,
    batch,
    message: sendResult.message || null,
    reason: sendResult.reason || null,
    issue: 2,
  };
}

function sendBatchToDocBot(items, opts = {}) {
  try {
    const registry = require('./registry');
    const sessions = registry.list({ includeDone: true, includeArchived: true });
    const docBot =
      sessions.find((s) => s && String(s.title || '') === 'doc-bot') ||
      sessions.find((s) => s && String(s.title || '') === 'memory-doc') ||
      null;
    if (!docBot) {
      return { sent: false, reason: 'no doc-bot session', message: null };
    }
    if (!messages.isMessagingEnabled(docBot).enabled) {
      return {
        sent: false,
        reason: 'doc-bot messaging not enabled (aflt msg enable doc-bot)',
        message: null,
      };
    }

    let fromSession = null;
    if (opts.sessionId) {
      fromSession = sessions.find((s) => s && s.id === opts.sessionId) || null;
    }
    if (!fromSession) {
      for (const it of items) {
        if (it.sessionId) {
          fromSession = sessions.find((s) => s && s.id === it.sessionId) || null;
          if (fromSession) break;
        }
      }
    }
    if (!fromSession) {
      return { sent: false, reason: 'no sender session on batch', message: null };
    }
    if (fromSession.id === docBot.id) {
      return { sent: false, reason: 'sender is doc-bot', message: null };
    }
    if (!messages.isMessagingEnabled(fromSession).enabled) {
      return {
        sent: false,
        reason: `sender messaging not enabled (${fromSession.title || fromSession.id})`,
        message: null,
      };
    }

    const body = formatBatchMessageBody(items, { project: opts.project });
    const result = messages.sendDirectMessage(fromSession, docBot, body, {
      type: 'note',
      sessions,
      source: 'flushDocBotBatch',
      meta: {
        eventType: 'doc-bot-batch',
        project: opts.project || null,
        itemCount: items.length,
      },
    });
    return { sent: true, message: result.message || null, reason: null };
  } catch (err) {
    return {
      sent: false,
      reason: String(err && err.message ? err.message : err),
      message: null,
    };
  }
}

/**
 * Record acknowledgement after Doc Bot reports notes written / marks handled.
 * @param {string} batchIdOrMessageId
 * @param {{ now?: string }} [opts]
 */
function ackDocBotBatch(batchIdOrMessageId, opts = {}) {
  const id = String(batchIdOrMessageId || '').trim();
  if (!id) {
    return { ok: false, reason: 'batch id or message id required' };
  }
  const state = loadPendingState();
  const batch = state.batches.find(
    (b) => b && (b.id === id || b.messageId === id)
  );
  if (!batch) {
    return { ok: false, reason: `batch not found: ${id}` };
  }
  if (batch.status === 'acked') {
    return { ok: true, already: true, batch };
  }
  batch.status = 'acked';
  batch.ackedAt = opts.now || nowIso();
  savePendingState(state);
  return { ok: true, batch };
}

/**
 * Summarize pending / batch Doc Bot queue for doctor / docs status / dashboard.
 */
function summarizeDocBotQueue() {
  const state = loadPendingState();
  const pending = state.pending || [];
  const batches = state.batches || [];
  return {
    pending: pending.length,
    pendingNoteReady: pending.filter((p) => p && p.noteReady).length,
    pendingWaitingNote: pending.filter((p) => p && !p.noteReady).length,
    batches: batches.length,
    batchesSent: batches.filter((b) => b && (b.status === 'sent' || b.sent)).length,
    batchesAcked: batches.filter((b) => b && b.status === 'acked').length,
    batchesNoMessaging: batches.filter((b) => b && b.status === 'recorded-no-messaging')
      .length,
    latestBatch: batches.length ? batches[batches.length - 1] : null,
    updatedAt: state.updatedAt || null,
  };
}

/**
 * Notify Doc Bot — enqueues for batched send. Prefer completeCheckpoint /
 * flushDocBotBatch so notes exist before a DM is sent.
 *
 * @param {object} event
 * @returns {object}
 */
function notifyDocBot(event) {
  const ev = event || {};
  const type = ev.type || 'note';
  const notePath = ev.notePath || (ev.checkpoint && ev.checkpoint.notePath) || null;
  const noteReady =
    type === 'checkpoint-completed' && Boolean(notePath)
      ? true
      : Boolean(ev.noteReady);

  const queued = enqueueDocBotPending({
    type,
    project: ev.project || null,
    sessionId:
      (ev.checkpoint && ev.checkpoint.sessionId) || ev.sessionId || null,
    checkpointId: ev.checkpoint && (ev.checkpoint.id || ev.checkpoint.requestedId),
    notePath,
    noteReady,
    reason: ev.checkpoint && ev.checkpoint.reason,
    at: nowIso(),
  });

  let flush = null;
  if (noteReady) {
    flush = flushDocBotBatch({
      project: ev.project,
      sessionId: queued.sessionId,
    });
  }

  return {
    sent: Boolean(flush && flush.sent),
    queued: true,
    pendingId: queued.id,
    batchId: flush && flush.batch && flush.batch.id,
    issue: 2,
    deferred: !(flush && flush.sent),
    reason:
      flush && flush.sent
        ? null
        : noteReady
          ? (flush && flush.reason) || 'batched'
          : 'queued; waiting for dated note before notify',
    message: flush && flush.message,
    event: ev,
    flush,
  };
}

/**
 * Doctor check for agentDocs fleet config + pending queue (never prints secrets).
 * @param {NodeJS.ProcessEnv} [env]
 */
function doctorAgentDocsStatus(env = process.env) {
  const fleet = resolveFleetAgentDocsConfig(env);
  const queue = summarizeDocBotQueue();
  const detail =
    `boundaries=${fleet.boundaries.join(',')} requireNote=${fleet.requireNote}` +
    ` retryMax=${fleet.retryMax} batchNotify=${fleet.batchNotify}` +
    ` pending=${queue.pending} (ready=${queue.pendingNoteReady})` +
    ` batchesAcked=${queue.batchesAcked}/${queue.batches}` +
    ` (${fleet.source})`;
  return {
    name: 'agent_docs',
    ok: true,
    detail,
    fleet,
    queue,
  };
}

/**
 * Report missing required memory config for stderr / dry-run.
 * @param {ReturnType<typeof resolveAgentDocsContext>} ctx
 * @returns {string[]}
 */
function formatContextWarnings(ctx) {
  if (!ctx) return [];
  return Array.isArray(ctx.warnings) ? ctx.warnings.slice() : [];
}

module.exports = {
  PROCESS_DOC_REL,
  AGENT_DOCS_REL,
  AGENTS_MD_REL,
  DEFAULT_CHECKPOINT_HOURS,
  DEFAULT_RETRY_MAX,
  DEFAULT_RETRY_BACKOFF_MINUTES,
  DEFAULT_BOUNDARIES,
  DOC_BOT_NOTIFY_DEFERRED,
  packageTemplatePath,
  readPackageTemplate,
  ensureProcessDocInMemoryRepo,
  checkpointsDir,
  checkpointPath,
  pendingPath,
  resolveFleetAgentDocsConfig,
  readAgentDocsConfig,
  resolveAgentDocsContext,
  agentDocsLaunchEnv,
  buildAgentDocsPreamble,
  applyAgentDocsPreamble,
  sessionLaunchEnv,
  prepareLaunch,
  requestCheckpoint,
  maybeRequestAtBoundary,
  completeCheckpoint,
  summarizeCheckpoint,
  processCheckpointRetries,
  collectCheckpointStatuses,
  listLiveStatusNotes,
  listArchivedStatusNotes,
  summarizeStatusNotesDir,
  resolveNotePath,
  enqueueDocBotPending,
  enqueueTurnCaptured,
  flushDocBotBatch,
  ackDocBotBatch,
  summarizeDocBotQueue,
  notifyDocBot,
  doctorAgentDocsStatus,
  formatContextWarnings,
  loadCheckpointState,
  loadPendingState,
  isSessionBusy,
};
