'use strict';

/**
 * Opt-in agent documentation: shared process doc, project AGENT-DOCS.md,
 * launch/resume path delivery, and documentation checkpoint tracking.
 *
 * Enable with `.agentfleet.json` `{ "agentDocs": true }`.
 * Doc Bot notifications via messaging are deferred to issue #2
 * (`notifyDocBot` is an intentional no-op hook).
 *
 * Never auto-moves or deletes documents (archive convention is human/Doc Bot).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const messages = require('./messages');
const memory = require('./memory');
const projectLib = require('./project');
const { fleetDir, nowIso, envNonEmpty } = require('./util');

const PROCESS_DOC_REL = 'DOCUMENTATION-PROCESS.md';
const AGENT_DOCS_REL = 'AGENT-DOCS.md';
const AGENTS_MD_REL = 'AGENTS.md';
const DEFAULT_CHECKPOINT_HOURS = 4;

/** Issue #2 hook — cross-session Doc Bot notifications (not implemented in phase 1). */
const DOC_BOT_NOTIFY_DEFERRED = Object.freeze({
  deferred: true,
  issue: 2,
  reason:
    'Doc Bot notifications require cross-session messaging (GitHub issue #2). Phase 1 records checkpoints only.',
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
  return String(raw)
    .replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-')
    .replace(/^\.+/, '-')
    .slice(0, 120) || 'adhoc';
}

function checkpointPath(project) {
  return path.join(checkpointsDir(), `${checkpointSafeName(project)}.json`);
}

function emptyCheckpointState(project) {
  return {
    project: projectLib.canonicalProjectName(project) || String(project || 'adhoc'),
    open: null,
    history: [],
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

/**
 * Read agentDocs opt-in from nearest `.agentfleet.json` with that key.
 * @param {string} cwd
 * @returns {{ enabled: boolean, checkpointHours: number, configPath: string|null, data: object|null }}
 */
function readAgentDocsConfig(cwd) {
  const hit = messages.findProjectConfig(cwd, { key: 'agentDocs' });
  if (!hit || !hit.data) {
    return {
      enabled: false,
      checkpointHours: DEFAULT_CHECKPOINT_HOURS,
      configPath: null,
      data: null,
    };
  }
  const enabled = hit.data.agentDocs === true;
  let hours = DEFAULT_CHECKPOINT_HOURS;
  const raw = hit.data.docCheckpointHours;
  if (raw != null && raw !== true) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) hours = n;
  }
  return {
    enabled,
    checkpointHours: hours,
    configPath: hit.path,
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

  const cfg = readAgentDocsConfig(cwd);
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
    configPath: cfg.configPath,
    missing,
    warnings,
    // Archive convention: aflt never auto-moves/deletes; live notes ignore archive/.
    archivePolicy: 'never-auto-move-or-delete',
  };
}

/**
 * Env overlay with project identity + instruction paths.
 * Safe when agentDocs is off (still sets AFLT_PROJECT when known for opted-in only).
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
    'aflt never auto-moves or deletes documents. Checkpoints: `aflt docs checkpoint` / `aflt docs --status`.',
    'Do not interrupt yourself for docs while mid-task; complete a checkpoint when the work lands.',
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
 * Prepare env + prompt for a launch. Does not interrupt agents; may auto-request
 * a checkpoint for bookkeeping when agentDocs is enabled and none is open.
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
  const autoRequest = opts.autoRequest !== false;
  if (ctx.enabled && autoRequest) {
    checkpoint = requestCheckpoint(ctx.project, {
      sessionId: session && session.id,
      reason: opts.requestReason || 'session-launch',
      now: opts.now,
      // Do not replace an already-open request
      onlyIfNoneOpen: true,
    });
  } else if (ctx.enabled) {
    checkpoint = summarizeCheckpoint(ctx.project, { hours: ctx.checkpointHours, now: opts.now });
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

/**
 * Record a documentation checkpoint request.
 * @param {string} project
 * @param {{ sessionId?: string, reason?: string, now?: string, onlyIfNoneOpen?: boolean }} [opts]
 */
function requestCheckpoint(project, opts = {}) {
  const name = projectLib.canonicalProjectName(project) || String(project || 'adhoc');
  const state = loadCheckpointState(name);
  if (opts.onlyIfNoneOpen && state.open) {
    return summarizeCheckpoint(name, { hours: DEFAULT_CHECKPOINT_HOURS, now: opts.now, state });
  }
  const at = opts.now || nowIso();
  const entry = {
    id: makeCheckpointId(),
    at,
    sessionId: opts.sessionId || null,
    reason: opts.reason ? String(opts.reason).slice(0, 200) : 'request',
  };
  state.open = entry;
  state.updatedAt = at;
  saveCheckpointState(state);

  // Hook for issue #2 — intentionally deferred (no messaging send).
  notifyDocBot({ type: 'checkpoint-requested', project: name, checkpoint: entry });

  return summarizeCheckpoint(name, { hours: DEFAULT_CHECKPOINT_HOURS, now: at, state });
}

/**
 * Mark the open checkpoint completed (or record a completion with no open request).
 * @param {string} project
 * @param {{ sessionId?: string, notePath?: string, now?: string }} [opts]
 */
function completeCheckpoint(project, opts = {}) {
  const name = projectLib.canonicalProjectName(project) || String(project || 'adhoc');
  const state = loadCheckpointState(name);
  const at = opts.now || nowIso();
  const open = state.open;
  const completion = {
    id: makeCheckpointId(),
    at,
    sessionId: opts.sessionId || null,
    notePath: opts.notePath ? String(opts.notePath) : null,
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

  notifyDocBot({ type: 'checkpoint-completed', project: name, checkpoint: completion });

  return summarizeCheckpoint(name, { hours: DEFAULT_CHECKPOINT_HOURS, now: at, state });
}

/**
 * Status view for one project. Elapsed time is reported for overdue labeling only —
 * it is never treated as progress (progress = requested → completed).
 *
 * @param {string} project
 * @param {{ hours?: number, now?: string|number|Date, state?: object }} [opts]
 */
function summarizeCheckpoint(project, opts = {}) {
  const name = projectLib.canonicalProjectName(project) || String(project || 'adhoc');
  const state = opts.state || loadCheckpointState(name);
  const hours =
    opts.hours != null && Number.isFinite(Number(opts.hours)) && Number(opts.hours) > 0
      ? Number(opts.hours)
      : DEFAULT_CHECKPOINT_HOURS;
  const nowMs =
    opts.now != null
      ? opts.now instanceof Date
        ? opts.now.getTime()
        : typeof opts.now === 'number'
          ? opts.now
          : Date.parse(String(opts.now))
      : Date.now();
  const open = state.open || null;
  let ageHours = null;
  let overdue = false;
  let missing = false;
  if (open && open.at) {
    missing = true;
    const requestedMs = Date.parse(String(open.at));
    if (Number.isFinite(requestedMs) && Number.isFinite(nowMs)) {
      ageHours = Math.max(0, (nowMs - requestedMs) / (60 * 60 * 1000));
      overdue = ageHours >= hours;
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
  };
}

/**
 * Collect checkpoint summaries for enabled projects (from sessions + optional names).
 * Never interrupts agents.
 *
 * @param {Array<object>} sessions
 * @param {{ now?: string|number|Date, env?: NodeJS.ProcessEnv, projectCache?: object }} [opts]
 */
function collectCheckpointStatuses(sessions, opts = {}) {
  const cache = opts.projectCache || projectLib.createLookupCache();
  const byProject = new Map();
  for (const s of sessions || []) {
    if (!s) continue;
    const cwd = s.cwd || process.cwd();
    const cfg = readAgentDocsConfig(cwd);
    if (!cfg.enabled) continue;
    const name =
      projectLib.canonicalProjectName(
        projectLib.resolveProjectName(s, { cache })
      ) || projectLib.ADHOC_NAME;
    if (byProject.has(name)) continue;
    byProject.set(
      name,
      summarizeCheckpoint(name, { hours: cfg.checkpointHours, now: opts.now })
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
 * Intentionally deferred hook for issue #2 (cross-session messaging → Doc Bot).
 * Phase 1 must not send messages or interrupt agents.
 * @param {object} event
 * @returns {{ deferred: true, issue: 2, reason: string, event: object }}
 */
function notifyDocBot(event) {
  return { ...DOC_BOT_NOTIFY_DEFERRED, event: event || null };
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
  DOC_BOT_NOTIFY_DEFERRED,
  packageTemplatePath,
  readPackageTemplate,
  ensureProcessDocInMemoryRepo,
  checkpointsDir,
  checkpointPath,
  readAgentDocsConfig,
  resolveAgentDocsContext,
  agentDocsLaunchEnv,
  buildAgentDocsPreamble,
  applyAgentDocsPreamble,
  sessionLaunchEnv,
  prepareLaunch,
  requestCheckpoint,
  completeCheckpoint,
  summarizeCheckpoint,
  collectCheckpointStatuses,
  listLiveStatusNotes,
  notifyDocBot,
  formatContextWarnings,
  loadCheckpointState,
};
