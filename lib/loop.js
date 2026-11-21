'use strict';

/**
 * `aflt loop` — long-running plan→develop→eval→revise runner.
 *
 * Milestone 1: validate / run / status / stop / resume.
 * Milestone 2: start / pause for the dashboard scheduler; opt-in heartbeat.
 * Milestone 3: dashboard UI, definition save (safe dirs), approval gates.
 *
 * Opt-in, never destructive by default (onPass actions require loop-level
 * `allow` flags). State lives under `$AGENTFLEET_HOME/loops/<name>/`.
 * Notify + memory writes are best-effort and never break the loop.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const config = require('./config');
const cursor = require('./cursor');
const copilot = require('./copilot');
const opencode = require('./opencode');
const registry = require('./registry');
const runlib = require('./run');
const notify = require('./notify');
const memory = require('./memory');
const projectLib = require('./project');
const {
  fleetDir,
  nowIso,
  slugify,
  expandUserPath,
  gitBranch,
  resolveCwd,
  envNonEmpty,
} = require('./util');

const STATE_VERSION = 1;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const ON_PASS_ACTIONS = new Set(['none', 'commit', 'merge', 'push']);
const LOOP_STATUSES = new Set([
  'pending',
  'running',
  'paused',
  'waiting',
  'completed',
  'failed',
  'stopped',
]);
const PHASE_STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'skipped']);
const PHASE_GATES = new Set(['approve', 'none']);
const LOCK_STALE_MS = 60_000;
const EVAL_OUTPUT_CAP = 12_000;
const FIX_OUTPUT_CAP = 8000;
const EVAL_TAIL_CAP = 2000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'stopped']);
/** Reserved API path segments that are not loop names. */
const RESERVED_LOOP_ROUTE_NAMES = new Set(['start', 'save', 'definitions']);

function loopsRoot() {
  return path.join(fleetDir(), 'loops');
}

function safeLoopName(name) {
  const s = slugify(String(name || '').trim());
  if (!s || s === 'session') {
    const err = new Error('loop name is required');
    err.code = 'LOOP_NAME';
    throw err;
  }
  return s;
}

function loopDir(name) {
  return path.join(loopsRoot(), safeLoopName(name));
}

function statePath(name) {
  return path.join(loopDir(name), 'state.json');
}

function lockPath(name) {
  return path.join(loopDir(name), 'runner.lock');
}

function definitionSnapshotPath(name) {
  return path.join(loopDir(name), 'definition.json');
}

function ensureLoopDir(name) {
  const dir = loopDir(name);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  const body = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
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

/**
 * Exclusive runner lock. Returns lock path; throws err.code === 'LOOP_BUSY'.
 */
function acquireRunnerLock(name, { staleMs = LOCK_STALE_MS } = {}) {
  ensureLoopDir(name);
  const lp = lockPath(name);
  for (let attempt = 0; attempt < 3; attempt++) {
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
      if (tryBreakStaleLock(lp, staleMs)) continue;
      const busy = new Error(`loop "${safeLoopName(name)}" is already running`);
      busy.code = 'LOOP_BUSY';
      throw busy;
    }
  }
  const busy = new Error(`loop "${safeLoopName(name)}" is already running`);
  busy.code = 'LOOP_BUSY';
  throw busy;
}

function releaseRunnerLock(nameOrPath) {
  const lp =
    nameOrPath && String(nameOrPath).includes(path.sep)
      ? nameOrPath
      : lockPath(nameOrPath);
  try {
    fs.unlinkSync(lp);
  } catch (_) {
    /* ignore */
  }
}

function readLockInfo(name) {
  const lp = lockPath(name);
  try {
    if (!fs.existsSync(lp)) return null;
    const raw = fs.readFileSync(lp, 'utf8');
    const lines = String(raw).split(/\n/);
    const pid = Number(String(lines[0] || '').trim());
    const host = String(lines[1] || '').trim() || null;
    const at = String(lines[2] || '').trim() || null;
    return {
      path: lp,
      pid: Number.isFinite(pid) && pid > 0 ? pid : null,
      host,
      at,
      alive: Number.isFinite(pid) && pid > 0 ? isPidAlive(pid) : false,
    };
  } catch (_) {
    return null;
  }
}

function loadState(name) {
  const p = statePath(name);
  if (!fs.existsSync(p)) return null;
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return null;
  const data = JSON.parse(raw);
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error(`invalid loop state at ${p}`);
  }
  return data;
}

function saveState(state) {
  if (!state || !state.name) throw new Error('loop state requires name');
  state.updatedAt = nowIso();
  atomicWriteJson(statePath(state.name), state);
  return state;
}

function listLoopNames() {
  const root = loopsRoot();
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => fs.existsSync(statePath(n)))
    .sort();
}

function resolveDefinitionPath(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    const err = new Error('loop definition file is required');
    err.code = 'LOOP_DEF';
    throw err;
  }
  const abs = path.resolve(expandUserPath(raw));
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    const err = new Error(`loop definition not found: ${abs}`);
    err.code = 'LOOP_DEF';
    throw err;
  }
  return abs;
}

function loadDefinitionFile(filePath) {
  const abs = resolveDefinitionPath(filePath);
  const raw = fs.readFileSync(abs, 'utf8');
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    const e = new Error(`invalid JSON in ${abs}: ${err.message}`);
    e.code = 'LOOP_DEF';
    throw e;
  }
  return { path: abs, definition: data };
}

function asNonEmptyString(value, label) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s;
}

function normalizeAllow(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    commit: Boolean(src.commit),
    merge: Boolean(src.merge),
    push: Boolean(src.push),
  };
}

function normalizeBudget(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const maxRuns =
    src.maxRuns != null && Number.isFinite(Number(src.maxRuns)) && Number(src.maxRuns) > 0
      ? Math.floor(Number(src.maxRuns))
      : null;
  const maxHours =
    src.maxHours != null && Number.isFinite(Number(src.maxHours)) && Number(src.maxHours) > 0
      ? Number(src.maxHours)
      : null;
  return { maxRuns, maxHours };
}

function normalizeEval(raw, phaseLabel) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${phaseLabel}: eval object is required` };
  }
  let command = raw.command;
  if (typeof command === 'string') {
    command = command.trim();
    if (!command) return { ok: false, error: `${phaseLabel}: eval.command is empty` };
  } else if (Array.isArray(command)) {
    if (!command.length || command.some((c) => typeof c !== 'string' || !String(c).trim())) {
      return { ok: false, error: `${phaseLabel}: eval.command array must be non-empty strings` };
    }
    command = command.map((c) => String(c));
  } else {
    return { ok: false, error: `${phaseLabel}: eval.command must be a string or string array` };
  }

  let passRegex = null;
  if (raw.passRegex != null && raw.passRegex !== '') {
    try {
      // Validate compile; store source string.
      // eslint-disable-next-line no-new
      new RegExp(String(raw.passRegex));
      passRegex = String(raw.passRegex);
    } catch (err) {
      return { ok: false, error: `${phaseLabel}: invalid eval.passRegex: ${err.message}` };
    }
  }

  let exitCode = 0;
  if (raw.exitCode != null || raw.exit != null) {
    const n = Number(raw.exitCode != null ? raw.exitCode : raw.exit);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      return { ok: false, error: `${phaseLabel}: eval.exitCode must be an integer` };
    }
    exitCode = n;
  }

  const cwd =
    raw.cwd != null && String(raw.cwd).trim() !== '' ? String(raw.cwd).trim() : null;
  const timeoutSec =
    raw.timeoutSec != null && Number.isFinite(Number(raw.timeoutSec)) && Number(raw.timeoutSec) > 0
      ? Math.floor(Number(raw.timeoutSec))
      : 300;

  return {
    ok: true,
    value: { command, passRegex, exitCode, cwd, timeoutSec },
  };
}

function normalizeOnPass(raw) {
  if (raw == null || raw === '') return 'none';
  const s = String(raw).trim().toLowerCase();
  if (!ON_PASS_ACTIONS.has(s)) {
    return { error: `onPass must be one of: ${[...ON_PASS_ACTIONS].join(', ')}` };
  }
  return s;
}

function normalizePhase(raw, index, defaults) {
  const label = `phases[${index}]`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: `${label}: must be an object` };
  }
  const id = asNonEmptyString(raw.id, 'id');
  if (!id) return { ok: false, error: `${label}: id is required` };
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    return { ok: false, error: `${label}: id must match [A-Za-z0-9._-]+` };
  }

  const session =
    asNonEmptyString(raw.session, 'session') ||
    asNonEmptyString(raw.sessionName, 'sessionName') ||
    `loop-${defaults.loopName}-${id}`;

  let engineName = asNonEmptyString(raw.engine, 'engine') || defaults.engine;
  try {
    engineName = config.validateEngine(engineName);
  } catch (err) {
    return { ok: false, error: `${label}: ${err.message}` };
  }

  const prompt = raw.prompt != null ? String(raw.prompt) : null;
  const promptFile =
    raw.promptFile != null && String(raw.promptFile).trim() !== ''
      ? String(raw.promptFile).trim()
      : null;
  if ((prompt == null || !String(prompt).trim()) && !promptFile) {
    return { ok: false, error: `${label}: prompt or promptFile is required` };
  }
  if (prompt != null && promptFile) {
    return { ok: false, error: `${label}: provide prompt or promptFile, not both` };
  }

  const evalNorm = normalizeEval(raw.eval, label);
  if (!evalNorm.ok) return evalNorm;

  let maxFixAttempts = DEFAULT_MAX_FIX_ATTEMPTS;
  if (raw.maxFixAttempts != null) {
    const n = Number(raw.maxFixAttempts);
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) {
      return { ok: false, error: `${label}: maxFixAttempts must be an integer >= 0` };
    }
    maxFixAttempts = n;
  }

  const onPassRaw = normalizeOnPass(raw.onPass);
  if (onPassRaw && onPassRaw.error) {
    return { ok: false, error: `${label}: ${onPassRaw.error}` };
  }

  const force = raw.force == null ? true : Boolean(raw.force);
  const mode =
    raw.mode != null && String(raw.mode).trim() !== '' ? String(raw.mode).trim() : null;
  if (mode && mode !== 'ask' && mode !== 'plan') {
    return { ok: false, error: `${label}: mode must be ask or plan when set` };
  }
  if (mode && engineName !== 'cursor') {
    return { ok: false, error: `${label}: --mode is Cursor-only` };
  }

  const timeoutSec =
    raw.timeoutSec != null && Number.isFinite(Number(raw.timeoutSec)) && Number(raw.timeoutSec) > 0
      ? Math.floor(Number(raw.timeoutSec))
      : null;

  let gate = null;
  if (raw.gate != null && String(raw.gate).trim() !== '') {
    const g = String(raw.gate).trim().toLowerCase();
    if (!PHASE_GATES.has(g)) {
      return { ok: false, error: `${label}: gate must be "approve" or "none"` };
    }
    gate = g === 'approve' ? 'approve' : null;
  }

  return {
    ok: true,
    value: {
      id,
      engine: engineName,
      session,
      prompt: prompt != null && String(prompt).trim() ? String(prompt) : null,
      promptFile,
      eval: evalNorm.value,
      maxFixAttempts,
      onPass: onPassRaw,
      force,
      mode,
      timeoutSec,
      gate,
    },
  };
}

/**
 * Validate and normalize a loop definition object.
 * @returns {{ ok: true, definition: object, warnings: string[] }|{ ok: false, errors: string[], warnings: string[] }}
 */
function validateDefinition(raw, opts = {}) {
  const errors = [];
  const warnings = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['definition must be a JSON object'], warnings };
  }

  const name = asNonEmptyString(raw.name, 'name');
  if (!name) errors.push('name is required');
  let safeName = null;
  if (name) {
    try {
      safeName = safeLoopName(name);
      if (safeName !== slugify(name) && safeName !== name) {
        warnings.push(`name will be stored as "${safeName}"`);
      }
    } catch (err) {
      errors.push(err.message);
    }
  }

  const project =
    asNonEmptyString(raw.project, 'project') ||
    asNonEmptyString(raw.projectId, 'projectId') ||
    null;

  let defEngine = asNonEmptyString(raw.engine, 'engine') || 'cursor';
  try {
    defEngine = config.validateEngine(defEngine);
  } catch (err) {
    errors.push(err.message);
  }

  const cwdRaw = asNonEmptyString(raw.cwd, 'cwd');
  let cwd;
  if (cwdRaw) {
    const expanded = expandUserPath(cwdRaw);
    cwd = path.isAbsolute(expanded)
      ? resolveCwd(expanded)
      : resolveCwd(path.resolve(opts.baseDir || process.cwd(), expanded));
    if (opts.checkCwd !== false && !fs.existsSync(cwd)) {
      errors.push(`cwd does not exist: ${cwd}`);
    }
  } else {
    cwd = resolveCwd(opts.baseDir || process.cwd());
  }

  const allow = normalizeAllow(raw.allow);
  const budget = normalizeBudget(raw.budget);

  if (!Array.isArray(raw.phases) || raw.phases.length === 0) {
    errors.push('phases must be a non-empty array');
  }

  const phases = [];
  const seenIds = new Set();
  if (Array.isArray(raw.phases)) {
    for (let i = 0; i < raw.phases.length; i++) {
      const norm = normalizePhase(raw.phases[i], i, {
        loopName: safeName || name || 'loop',
        engine: defEngine,
      });
      if (!norm.ok) {
        errors.push(norm.error);
        continue;
      }
      if (seenIds.has(norm.value.id)) {
        errors.push(`duplicate phase id: ${norm.value.id}`);
        continue;
      }
      seenIds.add(norm.value.id);

      if (norm.value.promptFile) {
        const pf = path.resolve(cwd, expandUserPath(norm.value.promptFile));
        if (opts.checkPromptFiles !== false && !fs.existsSync(pf)) {
          errors.push(`phases[${i}]: promptFile not found: ${pf}`);
        } else {
          norm.value.promptFile = pf;
        }
      }

      if (norm.value.onPass !== 'none' && !allow[norm.value.onPass]) {
        warnings.push(
          `phases[${i}] onPass=${norm.value.onPass} requires allow.${norm.value.onPass}=true (will skip action)`
        );
      }
      phases.push(norm.value);
    }
  }

  if (errors.length) return { ok: false, errors, warnings };

  const definition = {
    name: safeName,
    displayName: name,
    project,
    cwd,
    engine: defEngine,
    allow,
    budget,
    phases,
  };
  return { ok: true, definition, warnings };
}

function validateFile(filePath, opts = {}) {
  const loaded = loadDefinitionFile(filePath);
  const baseDir = path.dirname(loaded.path);
  const result = validateDefinition(loaded.definition, { ...opts, baseDir });
  return { ...result, path: loaded.path };
}

function resolvePhasePrompt(phase) {
  if (phase.prompt != null && String(phase.prompt).trim()) {
    return String(phase.prompt);
  }
  if (phase.promptFile) {
    return fs.readFileSync(phase.promptFile, 'utf8');
  }
  throw new Error(`phase ${phase.id}: missing prompt`);
}

function emptyPhaseState(phase) {
  return {
    id: phase.id,
    status: 'pending',
    attempts: 0,
    sessionId: null,
    sessionTitle: phase.session,
    lastEval: null,
    lastRun: null,
    passedAt: null,
    failedAt: null,
    onPass: null,
    gateApproved: false,
  };
}

function createInitialState(definition, opts = {}) {
  const phases = {};
  for (const p of definition.phases) {
    phases[p.id] = emptyPhaseState(p);
  }
  return {
    version: STATE_VERSION,
    name: definition.name,
    status: 'pending',
    /** When true, the dashboard loop scheduler may pick this loop up. */
    active: Boolean(opts.active),
    definitionPath: opts.definitionPath || null,
    definition,
    phaseIndex: 0,
    phaseId: definition.phases[0] ? definition.phases[0].id : null,
    attempt: 0,
    step: 'run',
    runsUsed: 0,
    startedAt: null,
    updatedAt: nowIso(),
    completedAt: null,
    stoppedAt: null,
    failedAt: null,
    pausedAt: null,
    stopRequested: false,
    pauseRequested: false,
    lastError: null,
    /** @type {{ phaseId: string, waiting: boolean, at?: string, approvedAt?: string }|null} */
    gate: null,
    phases,
    history: [],
  };
}

/**
 * Opt-in heartbeat interval in ms. Default off (0).
 * Env `AFLT_LOOP_HEARTBEAT_SECONDS` overrides `config.json`
 * `loop.heartbeatSeconds` (or `notify.loopHeartbeatSeconds`).
 */
function resolveHeartbeatMs(env = process.env) {
  const envVal = envNonEmpty(env, 'AFLT_LOOP_HEARTBEAT_SECONDS');
  if (envVal != null) {
    const n = Number(envVal);
    if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
    return 0;
  }
  const data = config.load();
  const loopCfg =
    data && data.loop && typeof data.loop === 'object' && !Array.isArray(data.loop)
      ? data.loop
      : {};
  const notifyCfg =
    data && data.notify && typeof data.notify === 'object' && !Array.isArray(data.notify)
      ? data.notify
      : {};
  const sec =
    loopCfg.heartbeatSeconds != null
      ? loopCfg.heartbeatSeconds
      : notifyCfg.loopHeartbeatSeconds != null
        ? notifyCfg.loopHeartbeatSeconds
        : 0;
  const n = Number(sec);
  if (Number.isFinite(n) && n > 0) return Math.floor(n * 1000);
  return 0;
}

/**
 * Whether the dashboard scheduler should start/resume this loop now.
 * Requires `active`, non-terminal/non-paused/non-waiting status, and no live runner lock.
 */
function isSchedulerCandidate(state, lock = null) {
  if (!state || !state.active) return false;
  if (
    TERMINAL_STATUSES.has(state.status) ||
    state.status === 'paused' ||
    state.status === 'waiting'
  ) {
    return false;
  }
  if (state.stopRequested || state.pauseRequested) return false;
  if (state.gate && state.gate.waiting) return false;
  const info = lock || readLockInfo(state.name);
  if (info && info.alive) return false;
  return state.status === 'pending' || state.status === 'running';
}

function listSchedulerCandidates() {
  const out = [];
  for (const name of listLoopNames()) {
    try {
      const state = loadState(name);
      const lock = readLockInfo(name);
      if (isSchedulerCandidate(state, lock)) {
        out.push({ name, state, lock });
      }
    } catch (_) {
      /* ignore corrupt rows */
    }
  }
  return out;
}

function appendHistory(state, entry) {
  if (!Array.isArray(state.history)) state.history = [];
  state.history.push({
    at: nowIso(),
    ...entry,
  });
  if (state.history.length > 500) {
    state.history = state.history.slice(-500);
  }
}

function hoursElapsed(state) {
  if (!state.startedAt) return 0;
  const t = Date.parse(state.startedAt);
  if (!Number.isFinite(t)) return 0;
  return (Date.now() - t) / (3600 * 1000);
}

function budgetExceeded(state) {
  const budget = (state.definition && state.definition.budget) || {};
  if (budget.maxRuns != null && state.runsUsed >= budget.maxRuns) {
    return `budget maxRuns exceeded (${state.runsUsed}/${budget.maxRuns})`;
  }
  if (budget.maxHours != null && hoursElapsed(state) >= budget.maxHours) {
    return `budget maxHours exceeded (${hoursElapsed(state).toFixed(2)}/${budget.maxHours})`;
  }
  return null;
}

/** Pick up stop requested by `requestStop` / CLI while async steps run. */
function mergeStopRequestedFromDisk(state, name) {
  try {
    const disk = loadState(name);
    if (disk && disk.stopRequested) state.stopRequested = true;
    if (disk && disk.pauseRequested) state.pauseRequested = true;
  } catch (_) {
    /* ignore */
  }
  return Boolean(state.stopRequested);
}

function mergePauseRequestedFromDisk(state, name) {
  try {
    const disk = loadState(name);
    if (disk && disk.pauseRequested) state.pauseRequested = true;
    if (disk && disk.stopRequested) state.stopRequested = true;
  } catch (_) {
    /* ignore */
  }
  return Boolean(state.pauseRequested);
}

async function finishIfStopRequested(state, name, env) {
  mergeStopRequestedFromDisk(state, name);
  if (!state.stopRequested) return null;
  await markLoopStopped(state, 'stop requested', { env });
  return { ok: false, status: 'stopped', state };
}

async function finishIfPauseRequested(state, name, env) {
  mergePauseRequestedFromDisk(state, name);
  if (state.stopRequested) {
    await markLoopStopped(state, 'stop requested', { env });
    return { ok: false, status: 'stopped', state };
  }
  if (!state.pauseRequested) return null;
  await markLoopPaused(state, 'pause requested', { env });
  return { ok: true, status: 'paused', state };
}

function truncateText(text, max = EVAL_OUTPUT_CAP) {
  const s = String(text == null ? '' : text);
  if (s.length <= max) return s;
  return s.slice(0, max - 14) + '\n…[truncated]';
}

function buildFixPrompt(phase, evalResult) {
  const out = truncateText(
    [evalResult.stdout, evalResult.stderr].filter(Boolean).join('\n'),
    FIX_OUTPUT_CAP
  );
  return [
    'The previous evaluation for this loop phase failed. Fix the issues so the eval passes.',
    'Do not switch to plan mode. Do not commit, push, stash, reset, or delete files unless the phase prompt explicitly requires it.',
    '',
    `## Phase`,
    phase.id,
    '',
    `## Eval exit code`,
    String(evalResult.code),
    '',
    `## Eval timed out`,
    evalResult.timedOut ? 'yes' : 'no',
    '',
    `## Eval output`,
    out || '(no output)',
    '',
  ].join('\n');
}

function evalPassed(evalSpec, result) {
  if (result.timedOut) return false;
  if (result.code !== evalSpec.exitCode) return false;
  if (evalSpec.passRegex) {
    const combined = `${result.stdout || ''}\n${result.stderr || ''}`;
    const re = new RegExp(evalSpec.passRegex);
    if (!re.test(combined)) return false;
  }
  return true;
}

/**
 * Run eval command. `command` is argv data (string → sh -c with one data arg).
 */
async function runEval(evalSpec, opts = {}) {
  const cwd = evalSpec.cwd
    ? path.resolve(opts.baseCwd || process.cwd(), expandUserPath(evalSpec.cwd))
    : opts.baseCwd || process.cwd();
  const timeoutMs = (evalSpec.timeoutSec || 300) * 1000;
  let bin;
  let argv;
  if (Array.isArray(evalSpec.command)) {
    bin = evalSpec.command[0];
    argv = evalSpec.command.slice(1);
  } else {
    bin = '/bin/sh';
    argv = ['-c', String(evalSpec.command)];
  }
  const result = await runlib.spawnCaptured(bin, argv, {
    cwd,
    timeoutMs,
    env: opts.env || process.env,
    detached: false,
    forwardSignals: true,
  });
  return {
    code: result.timedOut ? 124 : result.code == null ? 1 : result.code,
    timedOut: Boolean(result.timedOut),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    command: Array.isArray(evalSpec.command) ? evalSpec.command : ['/bin/sh', '-c', evalSpec.command],
    cwd,
  };
}

async function createEngineChatId(engineName, { cwd, title } = {}) {
  if (engineName === 'copilot') return copilot.newSessionId();
  if (engineName === 'opencode') return opencode.createSession({ cwd, title });
  return cursor.createChat();
}

/**
 * Ensure a registry session exists for the phase session title.
 */
async function ensureSession(phase, definition, opts = {}) {
  let session = null;
  try {
    session = registry.find(phase.session);
  } catch (_) {
    session = null;
  }
  if (session) {
    if ((session.engine || 'cursor') !== phase.engine) {
      throw new Error(
        `session "${phase.session}" is engine=${session.engine || 'cursor'}, phase wants ${phase.engine}`
      );
    }
    return session;
  }

  const cwd = definition.cwd;
  const chatId = await createEngineChatId(phase.engine, {
    cwd,
    title: phase.session,
  });
  const entry = {
    title: phase.session,
    chatId,
    cwd,
    branch: gitBranch(cwd),
    model: null,
    prompt: null,
    tags: ['loop', definition.name],
    status: 'active',
    engine: phase.engine,
  };
  if (definition.project) {
    entry.project = projectLib.canonicalProjectName(definition.project);
  } else {
    entry.project = projectLib.resolveProjectForCreate({
      cwd,
      cache: opts.projectCache || projectLib.createLookupCache(),
    });
  }
  return registry.add(entry);
}

/**
 * Headless one-shot for a loop phase (create/resume via registry + engine print).
 */
async function runSessionPrompt(session, prompt, phase, opts = {}) {
  const engineName = session.engine || phase.engine || 'cursor';
  const force = phase.force !== false;
  const mode = phase.mode || null;
  const timeoutSec = phase.timeoutSec || opts.timeoutSec || 0;
  const outputFormat = 'text';

  let bin;
  let argvRun;
  if (engineName === 'cursor') {
    bin = cursor.resolveCursorBin();
    argvRun = cursor.buildPrintArgs(session, {
      prompt,
      mode,
      force,
      outputFormat,
      trust: true,
    });
  } else if (engineName === 'copilot') {
    bin = copilot.resolveCopilotBin();
    argvRun = copilot.buildPrintArgs(session, {
      prompt,
      force,
      outputFormat,
      silent: true,
    });
  } else if (engineName === 'opencode') {
    bin = opencode.resolveOpencodeBin();
    argvRun = opencode.buildPrintArgs(session, {
      prompt,
      force,
      outputFormat,
    });
  } else {
    throw new Error(`unsupported engine: ${engineName}`);
  }

  const outPath = runlib.newRunLogPath(session.id, engineName);
  runlib.writeRunLogHeader(outPath, {
    argv: [bin, ...argvRun],
    cwd: session.cwd,
    kind: 'headless',
    prompt,
  });

  const runId = crypto.randomUUID();
  const runStartedAt = nowIso();
  registry.bestEffortUpdate(session.id, {
    lastOutput: outPath,
    lastPrompt: prompt,
    runHost: os.hostname(),
    runStartedAt,
    runId,
    stopRequested: false,
    runPid: null,
    runPgid: null,
    lastUsed: runStartedAt,
  });

  const result = await runlib.spawnCaptured(bin, argvRun, {
    cwd: session.cwd,
    timeoutMs: timeoutSec ? timeoutSec * 1000 : 0,
    env: opts.env || process.env,
    detached: true,
    forwardSignals: true,
    logPath: outPath,
    onSpawn: ({ pid, pgid }) => {
      registry.bestEffortUpdate(session.id, {
        runPid: pid,
        runPgid: pgid,
        runHost: os.hostname(),
        runStartedAt,
        runId,
        lastOutput: outPath,
      });
    },
  });

  const lastExit = result.timedOut
    ? 124
    : result.interruptedBy
      ? runlib.signalExitCode(result.interruptedBy)
      : result.code == null
        ? 1
        : result.code;

  registry.bestEffortUpdate(session.id, {
    lastRunAt: nowIso(),
    lastExit,
    lastOutput: outPath,
    lastPrompt: prompt,
    runPid: null,
    runPgid: null,
    runId,
    runStartedAt,
    lastUsed: nowIso(),
  });

  return {
    code: lastExit,
    timedOut: Boolean(result.timedOut),
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    outPath,
    runId,
    interruptedBy: result.interruptedBy || null,
  };
}

function noteStamp(at = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at instanceof Date ? at : new Date(at));
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}T${value('hour')}${value('minute')}${value('second')}`;
}

/**
 * Append loop transition + optional status note. No-op without memoryRepo.
 */
function recordMemoryTransition(state, entry, opts = {}) {
  const resolved = memory.resolveMemoryRepo(opts.env || process.env);
  if (!resolved || !resolved.path) {
    return { skipped: true, reason: 'no-memory-repo' };
  }
  let root;
  try {
    root = fs.realpathSync(resolved.path);
  } catch (_) {
    return { skipped: true, reason: 'memory-repo-missing' };
  }

  const project =
    (state.definition && state.definition.project) ||
    projectLib.resolveProjectForCreate({
      cwd: state.definition && state.definition.cwd,
    }) ||
    'adhoc';
  const folder = memory.sanitizeFolderName(projectLib.canonicalProjectName(project));
  const projectDir = path.join(root, folder);
  const afltDir = path.join(projectDir, memory.GENERATED_DIR);
  const notesDir = path.join(projectDir, 'status-notes');
  fs.mkdirSync(afltDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(notesDir, { recursive: true, mode: 0o700 });

  const event = {
    at: entry.at || nowIso(),
    loop: state.name,
    event: entry.event,
    phaseId: entry.phaseId || null,
    attempt: entry.attempt != null ? entry.attempt : null,
    summary: memory.redactSensitive(String(entry.summary || '')),
    status: state.status,
  };
  const timelinePath = path.join(afltDir, 'loop-timeline.jsonl');
  fs.appendFileSync(timelinePath, JSON.stringify(event) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });

  let notePath = null;
  if (entry.writeNote) {
    const slug = String(entry.noteSlug || entry.event || 'event')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    const filename = `${noteStamp(event.at)}-loop-${slug}.md`;
    const body = memory.redactSensitive(
      [
        `# Loop ${state.name}: ${entry.event}`,
        '',
        `At: ${event.at}`,
        `Project: ${folder}`,
        `Phase: ${event.phaseId || '—'}`,
        `Attempt: ${event.attempt != null ? event.attempt : '—'}`,
        `Loop status: ${state.status}`,
        '',
        event.summary || '_No summary._',
        '',
      ].join('\n')
    );
    notePath = path.join(notesDir, filename);
    fs.writeFileSync(notePath, body, { encoding: 'utf8', mode: 0o600 });
  }

  return {
    skipped: false,
    timelinePath,
    notePath: notePath
      ? path.relative(root, notePath).split(path.sep).join('/')
      : null,
    project: folder,
  };
}

function buildLoopNotifyPayload(event, state, opts = {}) {
  const def = state.definition || {};
  const cwdRaw = def.cwd != null ? String(def.cwd) : null;
  const phaseId = opts.phaseId != null ? opts.phaseId : state.phaseId;
  return {
    event: String(event),
    sessionId: opts.sessionId != null ? String(opts.sessionId) : null,
    title: state.name,
    project: def.project || null,
    engine: opts.engine || def.engine || null,
    cwd: cwdRaw ? memory.redactSensitive(cwdRaw) : null,
    exitStatus: opts.exitStatus != null ? opts.exitStatus : null,
    timestamp: opts.timestamp || nowIso(),
    summary: notify.summarize(opts.summary != null ? opts.summary : ''),
    loop: state.name,
    phaseId: phaseId != null ? String(phaseId) : null,
    attempt: opts.attempt != null ? opts.attempt : state.attempt,
  };
}

async function emitLoopNotify(event, state, opts = {}) {
  try {
    const cfg = opts.config || notify.resolveNotifyConfig(opts.env || process.env);
    if (!cfg.enabled) return { skipped: true };
    const payload = buildLoopNotifyPayload(event, state, opts);
    const queued = notify.enqueue(cfg, payload, {
      timeoutMs: opts.timeoutMs,
      unref: opts.unref === undefined ? false : opts.unref,
    });
    await notify.settleNotify(queued);
    return { ...queued, event, payload };
  } catch (err) {
    return {
      skipped: true,
      error: err && err.message ? err.message : String(err),
    };
  }
}

function runOnPassAction(action, definition, phase, opts = {}) {
  if (!action || action === 'none') {
    return { ok: true, skipped: true, action: 'none' };
  }
  const allow = definition.allow || {};
  if (!allow[action]) {
    return {
      ok: true,
      skipped: true,
      action,
      reason: `allow.${action} is false`,
    };
  }
  const cwd = definition.cwd;
  const msg = `aflt loop ${definition.name} phase ${phase.id} passed`;
  if (action === 'commit') {
    const add = spawnSync('git', ['-C', cwd, 'add', '-A'], {
      encoding: 'utf8',
      env: opts.env || process.env,
      timeout: 60_000,
    });
    if (add.status !== 0) {
      return {
        ok: false,
        action,
        error: (add.stderr || add.stdout || 'git add failed').trim(),
      };
    }
    const commit = spawnSync('git', ['-C', cwd, 'commit', '-m', msg], {
      encoding: 'utf8',
      env: opts.env || process.env,
      timeout: 60_000,
    });
    // exit 1 with "nothing to commit" is fine
    const out = `${commit.stdout || ''}\n${commit.stderr || ''}`;
    if (commit.status !== 0 && !/nothing to commit/i.test(out)) {
      return { ok: false, action, error: out.trim() || 'git commit failed' };
    }
    return { ok: true, action, skipped: false };
  }
  if (action === 'push') {
    const push = spawnSync('git', ['-C', cwd, 'push'], {
      encoding: 'utf8',
      env: opts.env || process.env,
      timeout: 120_000,
    });
    if (push.status !== 0) {
      return {
        ok: false,
        action,
        error: (push.stderr || push.stdout || 'git push failed').trim(),
      };
    }
    return { ok: true, action, skipped: false };
  }
  if (action === 'merge') {
    // Conservative: only merge when allow.merge; caller must be on a feature branch.
    const merge = spawnSync('git', ['-C', cwd, 'merge', '--no-edit'], {
      encoding: 'utf8',
      env: opts.env || process.env,
      timeout: 120_000,
    });
    if (merge.status !== 0) {
      return {
        ok: false,
        action,
        error: (merge.stderr || merge.stdout || 'git merge failed').trim(),
      };
    }
    return { ok: true, action, skipped: false };
  }
  return { ok: false, action, error: `unknown onPass action: ${action}` };
}

function markLoopFailed(state, reason, opts = {}) {
  state.status = 'failed';
  state.active = false;
  state.failedAt = nowIso();
  state.pauseRequested = false;
  state.stopRequested = false;
  if (state.gate) state.gate = { ...state.gate, waiting: false };
  state.lastError = reason;
  appendHistory(state, {
    event: 'loop.failed',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: reason,
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.failed',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: reason,
      writeNote: true,
      noteSlug: 'failed',
    },
    opts
  );
  return emitLoopNotify(notify.EVENTS.LOOP_FAILED, state, {
    summary: reason,
    exitStatus: 1,
    ...opts,
  });
}

function markLoopStopped(state, reason, opts = {}) {
  state.status = 'stopped';
  state.active = false;
  state.stoppedAt = nowIso();
  state.stopRequested = false;
  state.pauseRequested = false;
  if (state.gate) state.gate = { ...state.gate, waiting: false };
  state.lastError = reason || 'stopped';
  appendHistory(state, {
    event: 'loop.stopped',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: reason || 'stopped',
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.stopped',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: reason || 'stopped',
      writeNote: false,
    },
    opts
  );
  return emitLoopNotify(notify.EVENTS.LOOP_STOPPED, state, {
    summary: reason || 'stopped',
    exitStatus: null,
    ...opts,
  });
}

function markLoopPaused(state, reason, opts = {}) {
  state.status = 'paused';
  state.pausedAt = nowIso();
  state.pauseRequested = false;
  state.lastError = reason || 'paused';
  appendHistory(state, {
    event: 'loop.paused',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: reason || 'paused',
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.paused',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: reason || 'paused',
      writeNote: false,
    },
    opts
  );
  return { ok: true, status: 'paused', state };
}

function markLoopCompleted(state, opts = {}) {
  state.status = 'completed';
  state.active = false;
  state.completedAt = nowIso();
  state.pauseRequested = false;
  state.stopRequested = false;
  state.lastError = null;
  appendHistory(state, {
    event: 'loop.completed',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: 'all phases passed',
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.completed',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: 'all phases passed',
      writeNote: true,
      noteSlug: 'completed',
    },
    opts
  );
  return emitLoopNotify(notify.EVENTS.LOOP_COMPLETED, state, {
    summary: 'all phases passed',
    exitStatus: 0,
    ...opts,
  });
}

/**
 * Dry-run plan for a validated definition.
 */
function planDryRun(definition, definitionPath) {
  return {
    ok: true,
    dryRun: true,
    name: definition.name,
    definitionPath: definitionPath || null,
    cwd: definition.cwd,
    project: definition.project,
    engine: definition.engine,
    allow: definition.allow,
    budget: definition.budget,
    phases: definition.phases.map((p) => ({
      id: p.id,
      engine: p.engine,
      session: p.session,
      maxFixAttempts: p.maxFixAttempts,
      onPass: p.onPass,
      eval: {
        command: p.eval.command,
        exitCode: p.eval.exitCode,
        passRegex: p.eval.passRegex,
      },
      promptPreview: p.prompt
        ? truncateText(p.prompt, 200)
        : p.promptFile
          ? `(file) ${p.promptFile}`
          : null,
    })),
  };
}

/**
 * Core runner. Holds the runner lock for the duration.
 */
async function runLoop(definition, opts = {}) {
  const name = definition.name;
  const dryRun = Boolean(opts.dryRun);
  if (dryRun) {
    return planDryRun(definition, opts.definitionPath);
  }

  let lock = null;
  try {
    lock = acquireRunnerLock(name);
  } catch (err) {
    if (err && err.code === 'LOOP_BUSY') throw err;
    throw err;
  }

  const env = opts.env || process.env;
  const runPromptFn = typeof opts.runPrompt === 'function' ? opts.runPrompt : runSessionPrompt;
  const runEvalFn = typeof opts.runEval === 'function' ? opts.runEval : runEval;
  const ensureSessionFn =
    typeof opts.ensureSession === 'function' ? opts.ensureSession : ensureSession;

  try {
    ensureLoopDir(name);
    if (opts.definitionPath) {
      try {
        atomicWriteJson(definitionSnapshotPath(name), definition);
      } catch (_) {
        /* ignore */
      }
    }

    let state = loadState(name);
    const resuming = Boolean(opts.resume) || (state && state.status === 'running');
    if (!state || opts.fresh) {
      state = createInitialState(definition, { definitionPath: opts.definitionPath });
    } else {
      // Keep definition from the new file when explicitly re-running; resume keeps stored def.
      if (!opts.resume && opts.definitionPath) {
        state.definition = definition;
        state.definitionPath = opts.definitionPath;
        // Ensure phase map covers new phases
        for (const p of definition.phases) {
          if (!state.phases[p.id]) state.phases[p.id] = emptyPhaseState(p);
        }
      }
    }

    if (state.status === 'completed' && !opts.fresh && !opts.forceRerun) {
      return { ok: true, status: 'completed', state, message: 'loop already completed' };
    }

    if (state.stopRequested && (state.status === 'running' || state.status === 'paused')) {
      await markLoopStopped(state, 'stop requested before resume', { env });
      return { ok: false, status: 'stopped', state };
    }

    if (state.pauseRequested && state.status !== 'paused') {
      await markLoopPaused(state, 'pause requested before resume', { env });
      return { ok: true, status: 'paused', state };
    }

    const starting = state.status !== 'running' || !state.startedAt;
    state.status = 'running';
    state.stopRequested = false;
    state.pauseRequested = false;
    state.lastError = null;
    if (starting || !state.startedAt) state.startedAt = state.startedAt || nowIso();
    appendHistory(state, {
      event: starting && !resuming ? 'loop.started' : 'loop.resumed',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: starting && !resuming ? 'loop started' : 'loop resumed',
    });
    saveState(state);

    if (starting && !resuming) {
      recordMemoryTransition(
        state,
        {
          event: 'loop.started',
          phaseId: state.phaseId,
          attempt: 0,
          summary: 'loop started',
          writeNote: false,
        },
        { env }
      );
      await emitLoopNotify(notify.EVENTS.LOOP_STARTED, state, {
        summary: 'loop started',
        env,
      });
    }

    const heartbeatMs =
      opts.heartbeatMs != null ? Number(opts.heartbeatMs) : resolveHeartbeatMs(env);
    let heartbeatTimer = null;
    if (Number.isFinite(heartbeatMs) && heartbeatMs > 0) {
      const tick = () => {
        emitLoopNotify(notify.EVENTS.LOOP_HEARTBEAT, state, {
          summary: `heartbeat phase=${state.phaseId || '-'} attempt=${state.attempt} step=${state.step}`,
          env,
          unref: true,
        }).catch(() => {});
      };
      heartbeatTimer = setInterval(tick, heartbeatMs);
      if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();
    }

    try {
    const phases = state.definition.phases;
    while (state.phaseIndex < phases.length) {
      const stoppedEarly = await finishIfStopRequested(state, name, env);
      if (stoppedEarly) return stoppedEarly;
      const pausedEarly = await finishIfPauseRequested(state, name, env);
      if (pausedEarly) return pausedEarly;

      const budgetErr = budgetExceeded(state);
      if (budgetErr) {
        await markLoopFailed(state, budgetErr, { env });
        return { ok: false, status: 'failed', state, error: budgetErr };
      }

      const phase = phases[state.phaseIndex];
      state.phaseId = phase.id;
      const phaseState = state.phases[phase.id] || emptyPhaseState(phase);
      state.phases[phase.id] = phaseState;

      if (phaseState.status === 'passed') {
        state.phaseIndex += 1;
        state.attempt = 0;
        state.step = 'run';
        saveState(state);
        continue;
      }

      if (phaseState.status !== 'running') {
        phaseState.status = 'running';
        appendHistory(state, {
          event: 'loop.phase.started',
          phaseId: phase.id,
          attempt: state.attempt,
          summary: `phase ${phase.id} started`,
        });
        saveState(state);
        recordMemoryTransition(
          state,
          {
            event: 'loop.phase.started',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: `phase ${phase.id} started`,
            writeNote: false,
          },
          { env }
        );
        await emitLoopNotify(notify.EVENTS.LOOP_PHASE_STARTED, state, {
          phaseId: phase.id,
          attempt: state.attempt,
          summary: `phase ${phase.id} started`,
          engine: phase.engine,
          env,
        });
      }

      // --- approval gate (before run/fix/eval for this phase) ---
      if (phase.gate === 'approve' && !phaseState.gateApproved) {
        try {
          const disk = loadState(name);
          if (
            disk &&
            disk.phases &&
            disk.phases[phase.id] &&
            disk.phases[phase.id].gateApproved
          ) {
            phaseState.gateApproved = true;
            if (disk.gate) state.gate = disk.gate;
          }
        } catch (_) {
          /* ignore */
        }
      }
      if (phase.gate === 'approve' && !phaseState.gateApproved) {
        const stoppedAtGate = await finishIfStopRequested(state, name, env);
        if (stoppedAtGate) return stoppedAtGate;
        const pausedAtGate = await finishIfPauseRequested(state, name, env);
        if (pausedAtGate) return pausedAtGate;

        state.status = 'waiting';
        state.step = 'gate';
        state.gate = {
          phaseId: phase.id,
          waiting: true,
          at: nowIso(),
        };
        state.active = true;
        appendHistory(state, {
          event: 'loop.gate.waiting',
          phaseId: phase.id,
          attempt: state.attempt,
          summary: `waiting for approval before phase ${phase.id}`,
        });
        saveState(state);
        recordMemoryTransition(
          state,
          {
            event: 'loop.gate.waiting',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: `waiting for approval before phase ${phase.id}`,
            writeNote: false,
          },
          { env }
        );
        await emitLoopNotify(notify.EVENTS.LOOP_GATE_WAITING, state, {
          phaseId: phase.id,
          attempt: state.attempt,
          summary: `waiting for approval before phase ${phase.id}`,
          engine: phase.engine,
          env,
        });
        return { ok: true, status: 'waiting', state, gate: state.gate };
      }

      let session;
      try {
        session = await ensureSessionFn(phase, state.definition, { env });
        phaseState.sessionId = session.id;
        phaseState.sessionTitle = session.title;
        saveState(state);
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        phaseState.status = 'failed';
        phaseState.failedAt = nowIso();
        await markLoopFailed(state, `phase ${phase.id}: session error: ${msg}`, { env });
        return { ok: false, status: 'failed', state, error: msg };
      }

      // After gate approval, continue from run (not gate).
      if (state.step === 'gate') {
        state.step = 'run';
        saveState(state);
      }

      // --- run / fix prompt ---
      if (state.step === 'run' || state.step === 'fix') {
        let prompt;
        try {
          prompt =
            state.step === 'fix' && phaseState.lastEval
              ? buildFixPrompt(phase, phaseState.lastEval)
              : resolvePhasePrompt(phase);
        } catch (err) {
          const msg = err && err.message ? err.message : String(err);
          phaseState.status = 'failed';
          phaseState.failedAt = nowIso();
          await markLoopFailed(state, msg, { env });
          return { ok: false, status: 'failed', state, error: msg };
        }

        const runResult = await runPromptFn(session, prompt, phase, { env });
        const stoppedAfterRun = await finishIfStopRequested(state, name, env);
        if (stoppedAfterRun) return stoppedAfterRun;
        const pausedAfterRun = await finishIfPauseRequested(state, name, env);
        if (pausedAfterRun) return pausedAfterRun;
        state.runsUsed += 1;
        phaseState.attempts = (phaseState.attempts || 0) + 1;
        phaseState.lastRun = {
          at: nowIso(),
          code: runResult.code,
          timedOut: runResult.timedOut,
          outPath: runResult.outPath || null,
          runId: runResult.runId || null,
          kind: state.step,
        };
        state.step = 'eval';
        saveState(state);

        if (runResult.interruptedBy) {
          await markLoopStopped(state, `interrupted (${runResult.interruptedBy})`, { env });
          return { ok: false, status: 'stopped', state };
        }
      }

      // --- eval ---
      if (state.step === 'eval') {
        const evalResult = await runEvalFn(phase.eval, {
          baseCwd: state.definition.cwd,
          env,
        });
        const stoppedAfterEval = await finishIfStopRequested(state, name, env);
        if (stoppedAfterEval) return stoppedAfterEval;
        const pausedAfterEval = await finishIfPauseRequested(state, name, env);
        if (pausedAfterEval) return pausedAfterEval;
        phaseState.lastEval = {
          at: nowIso(),
          code: evalResult.code,
          timedOut: evalResult.timedOut,
          stdout: truncateText(evalResult.stdout, 4000),
          stderr: truncateText(evalResult.stderr, 2000),
          cwd: evalResult.cwd,
        };
        saveState(state);

        if (evalPassed(phase.eval, evalResult)) {
          // onPass
          const onPassResult = runOnPassAction(phase.onPass, state.definition, phase, {
            env,
          });
          phaseState.onPass = onPassResult;
          phaseState.status = 'passed';
          phaseState.passedAt = nowIso();
          appendHistory(state, {
            event: 'loop.phase.passed',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: `phase ${phase.id} passed`,
          });
          saveState(state);
          recordMemoryTransition(
            state,
            {
              event: 'loop.phase.passed',
              phaseId: phase.id,
              attempt: state.attempt,
              summary: `phase ${phase.id} passed` +
                (onPassResult.skipped
                  ? onPassResult.reason
                    ? ` (onPass skipped: ${onPassResult.reason})`
                    : ''
                  : ` (onPass=${onPassResult.action})`),
              writeNote: true,
              noteSlug: `${phase.id}-passed`,
            },
            { env }
          );
          await emitLoopNotify(notify.EVENTS.LOOP_PHASE_PASSED, state, {
            phaseId: phase.id,
            attempt: state.attempt,
            summary: `phase ${phase.id} passed`,
            engine: phase.engine,
            sessionId: session.id,
            exitStatus: 0,
            env,
          });

          state.phaseIndex += 1;
          state.attempt = 0;
          state.step = 'run';
          state.phaseId =
            state.phaseIndex < phases.length ? phases[state.phaseIndex].id : phase.id;
          saveState(state);
          continue;
        }

        // eval failed
        const attemptNumber = state.attempt;
        if (attemptNumber < phase.maxFixAttempts) {
          state.attempt = attemptNumber + 1;
          state.step = 'fix';
          appendHistory(state, {
            event: 'loop.phase.eval_failed',
            phaseId: phase.id,
            attempt: attemptNumber,
            summary: `eval failed (exit ${evalResult.code}); fix attempt ${state.attempt}/${phase.maxFixAttempts}`,
          });
          saveState(state);
          continue;
        }

        phaseState.status = 'failed';
        phaseState.failedAt = nowIso();
        const failSummary = `phase ${phase.id} failed after ${phase.maxFixAttempts} fix attempt(s); last eval exit ${evalResult.code}`;
        appendHistory(state, {
          event: 'loop.phase.failed',
          phaseId: phase.id,
          attempt: state.attempt,
          summary: failSummary,
        });
        saveState(state);
        recordMemoryTransition(
          state,
          {
            event: 'loop.phase.failed',
            phaseId: phase.id,
            attempt: state.attempt,
            summary: failSummary,
            writeNote: true,
            noteSlug: `${phase.id}-failed`,
          },
          { env }
        );
        await emitLoopNotify(notify.EVENTS.LOOP_PHASE_FAILED, state, {
          phaseId: phase.id,
          attempt: state.attempt,
          summary: failSummary,
          engine: phase.engine,
          sessionId: session.id,
          exitStatus: evalResult.code,
          env,
        });
        await markLoopFailed(state, failSummary, { env });
        return { ok: false, status: 'failed', state, error: failSummary };
      }
    }

    await markLoopCompleted(state, { env });
    return { ok: true, status: 'completed', state };
    } finally {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    }
  } finally {
    releaseRunnerLock(lock || name);
  }
}

async function runFromFile(filePath, opts = {}) {
  const validated = validateFile(filePath, opts);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors,
      warnings: validated.warnings || [],
      path: validated.path,
    };
  }
  for (const w of validated.warnings || []) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }
  try {
    const result = await runLoop(validated.definition, {
      ...opts,
      definitionPath: validated.path,
    });
    return { ...result, warnings: validated.warnings || [], path: validated.path };
  } catch (err) {
    if (err && err.code === 'LOOP_BUSY') {
      return { ok: false, error: err.message, code: 'LOOP_BUSY', path: validated.path };
    }
    throw err;
  }
}

/**
 * Register a loop as active for the dashboard scheduler (does not run phases).
 */
function startFromFile(filePath, opts = {}) {
  const validated = validateFile(filePath, opts);
  if (!validated.ok) {
    return {
      ok: false,
      errors: validated.errors,
      warnings: validated.warnings || [],
      path: validated.path,
    };
  }
  for (const w of validated.warnings || []) {
    try {
      process.stderr.write(`WARNING: ${w}\n`);
    } catch (_) {
      /* ignore */
    }
  }

  const definition = validated.definition;
  const name = definition.name;
  ensureLoopDir(name);
  try {
    atomicWriteJson(definitionSnapshotPath(name), definition);
  } catch (_) {
    /* ignore */
  }

  let state = loadState(name);
  const lock = readLockInfo(name);
  if (lock && lock.alive && state && state.status === 'running') {
    state.active = true;
    state.definition = definition;
    state.definitionPath = validated.path;
    state.pauseRequested = false;
    state.stopRequested = false;
    appendHistory(state, {
      event: 'loop.activated',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: 'marked active for scheduler (runner already live)',
    });
    saveState(state);
    return {
      ok: true,
      status: state.status,
      state,
      path: validated.path,
      message: 'marked active; runner already live',
      warnings: validated.warnings || [],
    };
  }

  if (!state || TERMINAL_STATUSES.has(state.status) || opts.fresh) {
    state = createInitialState(definition, {
      definitionPath: validated.path,
      active: true,
    });
  } else {
    state.definition = definition;
    state.definitionPath = validated.path;
    for (const p of definition.phases) {
      if (!state.phases[p.id]) state.phases[p.id] = emptyPhaseState(p);
    }
    state.active = true;
    state.pauseRequested = false;
    state.stopRequested = false;
    if (state.status === 'paused') {
      state.status = 'pending';
      state.pausedAt = null;
    }
  }

  appendHistory(state, {
    event: 'loop.activated',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: 'registered as active for scheduler',
  });
  saveState(state);

  return {
    ok: true,
    status: state.status,
    state,
    path: validated.path,
    message: 'registered as active for scheduler',
    warnings: validated.warnings || [],
  };
}

async function resumeLoop(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (state.status === 'completed') {
    return { ok: true, status: 'completed', state, message: 'loop already completed' };
  }
  if (state.status === 'failed' && !opts.force) {
    return {
      ok: false,
      status: 'failed',
      state,
      error: 'loop failed; re-run with the definition file or pass force via API',
    };
  }
  const definition = state.definition;
  if (!definition || !Array.isArray(definition.phases)) {
    return { ok: false, error: `loop "${safe}" state is missing definition` };
  }
  // Clear failed/stopped/paused → allow resume; for failed need opts.force
  if (state.status === 'stopped' || state.status === 'failed' || state.status === 'paused') {
    state.status = state.status === 'paused' ? 'pending' : 'running';
    state.stopRequested = false;
    state.pauseRequested = false;
    state.active = opts.active != null ? Boolean(opts.active) : state.active;
    state.lastError = null;
    state.pausedAt = null;
    saveState(state);
  }
  return runLoop(definition, {
    ...opts,
    resume: true,
    definitionPath: state.definitionPath,
  });
}

/**
 * Mark a paused/pending loop active again without running phases (scheduler path).
 */
function requestResume(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (state.status === 'completed') {
    return { ok: true, status: 'completed', state, message: 'loop already completed' };
  }
  if (state.status === 'waiting' || (state.gate && state.gate.waiting)) {
    return {
      ok: false,
      status: 'waiting',
      state,
      error: 'loop is waiting for approval; use approve',
    };
  }
  if (state.status === 'failed' && !opts.force) {
    return {
      ok: false,
      status: 'failed',
      state,
      error: 'loop failed; pass force to resume',
    };
  }
  if (state.status === 'stopped' && !opts.force) {
    return {
      ok: false,
      status: 'stopped',
      state,
      error: 'loop stopped; pass force to resume or re-start the definition',
    };
  }

  state.active = true;
  state.pauseRequested = false;
  state.stopRequested = false;
  state.lastError = null;
  if (state.status === 'paused' || state.status === 'stopped' || state.status === 'failed') {
    state.status = 'pending';
    state.pausedAt = null;
  }
  appendHistory(state, {
    event: 'loop.resume_requested',
    phaseId: state.phaseId,
    attempt: state.attempt,
    summary: 'resume requested for scheduler',
  });
  saveState(state);
  return { ok: true, status: state.status, state, active: true };
}

/**
 * Release an approval gate (`gate: "approve"`). Marks the phase approved and
 * re-activates the loop for the dashboard scheduler.
 */
function requestApprove(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  const waiting =
    state.status === 'waiting' || Boolean(state.gate && state.gate.waiting);
  if (!waiting && !opts.force) {
    return {
      ok: false,
      status: state.status,
      state,
      error: 'loop is not waiting for approval',
    };
  }

  const phaseId =
    (opts.phaseId != null && String(opts.phaseId).trim()) ||
    (state.gate && state.gate.phaseId) ||
    state.phaseId;
  if (!phaseId || !state.phases || !state.phases[phaseId]) {
    return { ok: false, error: `unknown phase for approval: ${phaseId || '(none)'}`, state };
  }

  state.phases[phaseId].gateApproved = true;
  state.gate = {
    phaseId,
    waiting: false,
    at: state.gate && state.gate.at ? state.gate.at : null,
    approvedAt: nowIso(),
  };
  state.status = 'pending';
  state.active = true;
  state.pauseRequested = false;
  state.stopRequested = false;
  state.lastError = null;
  if (state.step === 'gate') state.step = 'run';
  appendHistory(state, {
    event: 'loop.gate.approved',
    phaseId,
    attempt: state.attempt,
    summary: `approval granted for phase ${phaseId}`,
  });
  saveState(state);
  recordMemoryTransition(
    state,
    {
      event: 'loop.gate.approved',
      phaseId,
      attempt: state.attempt,
      summary: `approval granted for phase ${phaseId}`,
      writeNote: false,
    },
    opts
  );
  const notifyPromise = emitLoopNotify(notify.EVENTS.LOOP_GATE_APPROVED, state, {
    phaseId,
    attempt: state.attempt,
    summary: `approval granted for phase ${phaseId}`,
    env: opts.env,
    ...opts,
  });
  return {
    ok: true,
    status: state.status,
    state,
    active: true,
    phaseId,
    notify: notifyPromise,
  };
}

function requestPause(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (TERMINAL_STATUSES.has(state.status)) {
    return { ok: true, status: state.status, state, message: `loop already ${state.status}` };
  }
  if (state.status === 'paused') {
    return { ok: true, status: 'paused', state, message: 'loop already paused' };
  }

  state.pauseRequested = true;
  saveState(state);

  const lock = readLockInfo(safe);
  let signaled = false;
  // Soft signal: do not SIGTERM on pause (runner yields between steps).
  if (!lock || !lock.alive) {
    markLoopPaused(state, 'paused (no live runner)', opts);
  }

  return {
    ok: true,
    status: state.status,
    pauseRequested: state.pauseRequested,
    signaled,
    lock,
    state,
  };
}

function requestStop(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'stopped') {
    state.active = false;
    saveState(state);
    return { ok: true, status: state.status, state, message: `loop already ${state.status}` };
  }
  state.stopRequested = true;
  state.pauseRequested = false;
  state.active = false;
  saveState(state);

  const lock = readLockInfo(safe);
  let signaled = false;
  if (lock && lock.alive && lock.pid && lock.pid !== process.pid) {
    try {
      process.kill(lock.pid, 'SIGTERM');
      signaled = true;
    } catch (_) {
      /* ignore */
    }
  }

  // If no runner holds the lock, mark stopped immediately.
  if (!lock || !lock.alive) {
    state.status = 'stopped';
    state.stoppedAt = nowIso();
    state.stopRequested = false;
    state.active = false;
    appendHistory(state, {
      event: 'loop.stopped',
      phaseId: state.phaseId,
      attempt: state.attempt,
      summary: 'stopped (no live runner)',
    });
    saveState(state);
  }

  return {
    ok: true,
    status: state.status,
    stopRequested: state.stopRequested,
    signaled,
    lock,
    state,
  };
}

function formatEvalTail(lastEval, cap = EVAL_TAIL_CAP) {
  if (!lastEval || typeof lastEval !== 'object') return null;
  const parts = [];
  if (lastEval.stdout) parts.push(String(lastEval.stdout));
  if (lastEval.stderr) parts.push(String(lastEval.stderr));
  const combined = parts.join('\n').trim();
  if (!combined) {
    return {
      at: lastEval.at || null,
      code: lastEval.code != null ? lastEval.code : null,
      timedOut: Boolean(lastEval.timedOut),
      text: '',
    };
  }
  return {
    at: lastEval.at || null,
    code: lastEval.code != null ? lastEval.code : null,
    timedOut: Boolean(lastEval.timedOut),
    text: truncateText(combined, cap),
  };
}

function buildStepPipeline(state) {
  const phases = (state.definition && state.definition.phases) || [];
  const phase = phases[state.phaseIndex] || null;
  const step = state.step || 'run';
  const mode = phase && phase.mode === 'plan' ? 'plan' : 'develop';
  const hasGate = Boolean(phase && phase.gate === 'approve');
  const waitingGate = Boolean(state.gate && state.gate.waiting) || step === 'gate';
  const stages = [
    {
      id: 'plan',
      label: 'plan',
      active: step === 'run' && mode === 'plan' && !waitingGate,
      done: false,
    },
    {
      id: 'develop',
      label: 'develop',
      active: step === 'run' && mode !== 'plan' && !waitingGate,
      done: step === 'eval' || step === 'fix' || (step === 'gate' && false),
    },
    {
      id: 'evaluate',
      label: 'evaluate',
      active: step === 'eval',
      done: step === 'fix',
    },
    {
      id: 'revise',
      label: 'revise',
      active: step === 'fix',
      done: false,
    },
  ];
  if (hasGate || waitingGate) {
    stages.push({
      id: 'approve',
      label: 'approve',
      active: waitingGate,
      done: Boolean(phase && state.phases && state.phases[phase.id] && state.phases[phase.id].gateApproved),
    });
  }
  stages.push({
    id: 'next',
    label: 'next',
    active: false,
    done: false,
  });
  // Mark earlier stages done when later ones are active.
  const activeIdx = stages.findIndex((s) => s.active);
  if (activeIdx > 0) {
    for (let i = 0; i < activeIdx; i++) {
      if (stages[i].id === 'plan' && mode !== 'plan') continue;
      if (stages[i].id === 'develop' && mode === 'plan' && step === 'run') continue;
      stages[i].done = true;
      stages[i].active = false;
    }
  }
  return stages;
}

function buildPhasePipeline(state) {
  const phases = (state.definition && state.definition.phases) || [];
  return phases.map((p, i) => {
    const ps = (state.phases && state.phases[p.id]) || {};
    const current = i === state.phaseIndex;
    return {
      id: p.id,
      index: i,
      status: ps.status || 'pending',
      gate: p.gate || null,
      gateApproved: Boolean(ps.gateApproved),
      sessionId: ps.sessionId || null,
      sessionTitle: ps.sessionTitle || p.session || null,
      attempts: ps.attempts || 0,
      current,
      step: current ? state.step : ps.status === 'passed' ? 'done' : 'pending',
      lastEval: formatEvalTail(ps.lastEval),
    };
  });
}

function budgetSnapshot(state) {
  const budget = (state.definition && state.definition.budget) || {};
  const hoursUsed = hoursElapsed(state);
  return {
    maxRuns: budget.maxRuns != null ? budget.maxRuns : null,
    maxHours: budget.maxHours != null ? budget.maxHours : null,
    runsUsed: state.runsUsed || 0,
    hoursUsed: Math.round(hoursUsed * 1000) / 1000,
  };
}

function elapsedMsOf(state) {
  if (!state || !state.startedAt) return 0;
  const t = Date.parse(state.startedAt);
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Date.now() - t);
}

function summarizeLoopState(state, lock = null) {
  const info = lock || (state ? readLockInfo(state.name) : null);
  const budget = budgetSnapshot(state);
  return {
    name: state.name,
    status: state.status,
    active: Boolean(state.active),
    phaseId: state.phaseId,
    phaseIndex: state.phaseIndex,
    attempt: state.attempt,
    step: state.step,
    runsUsed: state.runsUsed,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    completedAt: state.completedAt || null,
    failedAt: state.failedAt || null,
    stoppedAt: state.stoppedAt || null,
    pausedAt: state.pausedAt || null,
    elapsedMs: elapsedMsOf(state),
    budget,
    gate: state.gate || null,
    project: state.definition && state.definition.project,
    cwd: state.definition && state.definition.cwd
      ? memory.redactSensitive(String(state.definition.cwd))
      : null,
    phaseCount: state.definition && Array.isArray(state.definition.phases)
      ? state.definition.phases.length
      : 0,
    stopRequested: Boolean(state.stopRequested),
    pauseRequested: Boolean(state.pauseRequested),
    lastError: state.lastError
      ? memory.redactSensitive(String(state.lastError))
      : null,
    lockAlive: Boolean(info && info.alive),
    schedulerCandidate: isSchedulerCandidate(state, info),
    definitionPath: state.definitionPath || null,
  };
}

/**
 * Resolve the directory where UI-saved loop definitions are written.
 * Default: `$AGENTFLEET_HOME/loops/definitions`. Override with
 * `config.json` `loop.definitionsDir` / `loop.dir` / top-level `loopsDir`,
 * or `opts.definitionsDir`.
 */
function resolveDefinitionsDir(opts = {}) {
  if (opts.definitionsDir != null && String(opts.definitionsDir).trim()) {
    return path.resolve(expandUserPath(String(opts.definitionsDir).trim()));
  }
  const data = config.load();
  const loopCfg =
    data && data.loop && typeof data.loop === 'object' && !Array.isArray(data.loop)
      ? data.loop
      : {};
  const configured =
    (loopCfg.definitionsDir != null && String(loopCfg.definitionsDir).trim()) ||
    (loopCfg.dir != null && String(loopCfg.dir).trim()) ||
    (data && data.loopsDir != null && String(data.loopsDir).trim()) ||
    null;
  if (configured) {
    return path.resolve(expandUserPath(configured));
  }
  return path.join(loopsRoot(), 'definitions');
}

function allowedLoopRoots(opts = {}) {
  const roots = [];
  const add = (p) => {
    if (!p) return;
    const abs = path.resolve(p);
    if (!roots.includes(abs)) roots.push(abs);
  };
  add(loopsRoot());
  add(resolveDefinitionsDir(opts));
  return roots;
}

/**
 * Resolve a path for containment checks. Walks up to an existing ancestor so
 * not-yet-created files still normalize like their parent (macOS /var →
 * /private/var via realpath).
 */
function realpathOrSelf(p) {
  const abs = path.resolve(p);
  try {
    return fs.realpathSync(abs);
  } catch (_) {
    /* fall through */
  }
  let cur = abs;
  const parts = [];
  while (cur && cur !== path.dirname(cur)) {
    parts.unshift(path.basename(cur));
    cur = path.dirname(cur);
    try {
      return path.join(fs.realpathSync(cur), ...parts);
    } catch (_) {
      /* keep walking */
    }
  }
  return abs;
}

function isPathInsideRoot(filePath, rootPath) {
  const file = realpathOrSelf(filePath);
  const root = realpathOrSelf(rootPath);
  if (file === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return file.startsWith(prefix);
}

function assertPathInAllowedRoots(filePath, opts = {}) {
  const abs = path.resolve(expandUserPath(String(filePath || '')));
  const roots = allowedLoopRoots(opts);
  if (roots.some((root) => isPathInsideRoot(abs, root))) {
    return abs;
  }
  const err = new Error(
    'path must be under $AGENTFLEET_HOME/loops or the configured loops/definitions dir'
  );
  err.code = 'LOOP_PATH';
  throw err;
}

/**
 * Serialize a validated definition to a portable JSON object for disk.
 */
function definitionToWritable(definition, raw) {
  const phases = (definition.phases || []).map((p, i) => {
    const src = raw && Array.isArray(raw.phases) ? raw.phases[i] : null;
    const out = {
      id: p.id,
      engine: p.engine,
      session: p.session,
      eval: {
        command: p.eval.command,
        exitCode: p.eval.exitCode,
      },
      maxFixAttempts: p.maxFixAttempts,
      onPass: p.onPass,
      force: p.force,
    };
    if (p.eval.passRegex) out.eval.passRegex = p.eval.passRegex;
    if (p.eval.cwd) out.eval.cwd = p.eval.cwd;
    if (p.eval.timeoutSec != null && p.eval.timeoutSec !== 300) {
      out.eval.timeoutSec = p.eval.timeoutSec;
    }
    if (p.mode) out.mode = p.mode;
    if (p.timeoutSec != null) out.timeoutSec = p.timeoutSec;
    if (p.gate) out.gate = p.gate;
    if (p.prompt != null) {
      out.prompt = p.prompt;
    } else if (p.promptFile) {
      // Prefer the original relative promptFile when provided.
      if (src && src.promptFile) out.promptFile = String(src.promptFile);
      else {
        try {
          out.promptFile = path.relative(definition.cwd, p.promptFile) || p.promptFile;
        } catch (_) {
          out.promptFile = p.promptFile;
        }
      }
    }
    return out;
  });

  const out = {
    name: definition.name,
    engine: definition.engine,
    allow: definition.allow,
    budget: definition.budget,
    phases,
  };
  if (definition.project) out.project = definition.project;
  if (raw && raw.cwd != null && String(raw.cwd).trim()) out.cwd = String(raw.cwd).trim();
  else if (definition.cwd) out.cwd = definition.cwd;
  return out;
}

/**
 * Validate and write a loop definition under the allowed loops/definitions dir.
 * Never writes outside those roots.
 */
function saveDefinition(raw, opts = {}) {
  const validated = validateDefinition(raw, {
    ...opts,
    // Saving from the UI may happen before cwd exists on another machine; still
    // require a resolvable shape but allow missing cwd when checkCwd is false.
    checkCwd: opts.checkCwd !== undefined ? opts.checkCwd : true,
    checkPromptFiles:
      opts.checkPromptFiles !== undefined ? opts.checkPromptFiles : true,
  });
  if (!validated.ok) {
    return { ok: false, errors: validated.errors, warnings: validated.warnings || [] };
  }
  const dir = resolveDefinitionsDir(opts);
  // Ensure the resolved dir itself is under an allowed root (or *is* the configured root).
  const roots = allowedLoopRoots(opts);
  const dirAllowed = roots.some(
    (root) => isPathInsideRoot(dir, root) || path.resolve(dir) === path.resolve(root)
  );
  if (!dirAllowed) {
    return {
      ok: false,
      errors: ['definitions directory is outside the allowed loops roots'],
    };
  }
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${validated.definition.name}.json`);
  try {
    assertPathInAllowedRoots(file, opts);
  } catch (err) {
    return { ok: false, errors: [err.message] };
  }
  const body = definitionToWritable(validated.definition, raw);
  atomicWriteJson(file, body);
  // Also refresh the per-loop snapshot when state already exists.
  try {
    if (fs.existsSync(statePath(validated.definition.name))) {
      atomicWriteJson(definitionSnapshotPath(validated.definition.name), validated.definition);
    }
  } catch (_) {
    /* ignore */
  }
  return {
    ok: true,
    path: file,
    definition: validated.definition,
    writable: body,
    warnings: validated.warnings || [],
  };
}

function listSavedDefinitions(opts = {}) {
  const dir = resolveDefinitionsDir(opts);
  const out = [];
  if (!fs.existsSync(dir)) {
    return { ok: true, dir, definitions: out };
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    return { ok: false, error: err.message, dir, definitions: out };
  }
  for (const ent of entries) {
    if (!ent.isFile() || !/\.json$/i.test(ent.name)) continue;
    const file = path.join(dir, ent.name);
    try {
      assertPathInAllowedRoots(file, opts);
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      out.push({
        name: raw && raw.name ? String(raw.name) : path.basename(ent.name, '.json'),
        path: file,
        phaseCount: raw && Array.isArray(raw.phases) ? raw.phases.length : 0,
        project: raw && raw.project ? String(raw.project) : null,
        engine: raw && raw.engine ? String(raw.engine) : null,
        updatedAt: (() => {
          try {
            return fs.statSync(file).mtime.toISOString();
          } catch (_) {
            return null;
          }
        })(),
      });
    } catch (_) {
      /* skip unreadable */
    }
  }
  out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { ok: true, dir, definitions: out };
}

function loadSavedDefinition(name, opts = {}) {
  const safe = safeLoopName(name);
  const file = path.join(resolveDefinitionsDir(opts), `${safe}.json`);
  try {
    assertPathInAllowedRoots(file, opts);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!fs.existsSync(file)) {
    // Fall back to per-loop snapshot.
    const snap = definitionSnapshotPath(safe);
    if (fs.existsSync(snap)) {
      try {
        const raw = JSON.parse(fs.readFileSync(snap, 'utf8'));
        return { ok: true, path: snap, definition: raw, source: 'snapshot' };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    return { ok: false, error: `no saved definition for "${safe}"` };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { ok: true, path: file, definition: raw, source: 'definitions' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Start a loop from a definition path. When `opts.requireAllowedPath` is true
 * (dashboard), the file must live under an allowed loops root.
 */
function startFromPath(filePath, opts = {}) {
  let abs;
  try {
    abs =
      opts.requireAllowedPath === false
        ? resolveDefinitionPath(filePath)
        : assertPathInAllowedRoots(resolveDefinitionPath(filePath), opts);
  } catch (err) {
    return { ok: false, error: err.message, code: err.code || 'LOOP_PATH' };
  }
  return startFromFile(abs, opts);
}

function statusReport(name, opts = {}) {
  if (name) {
    const safe = safeLoopName(name);
    const state = loadState(safe);
    if (!state) {
      return { ok: false, error: `no loop state for "${safe}"` };
    }
    const lock = readLockInfo(safe);
    const summary = summarizeLoopState(state, lock);
    const currentPhase =
      state.definition &&
      Array.isArray(state.definition.phases) &&
      state.definition.phases[state.phaseIndex]
        ? state.definition.phases[state.phaseIndex]
        : null;
    const currentPhaseState =
      currentPhase && state.phases ? state.phases[currentPhase.id] : null;
    return {
      ok: true,
      ...summary,
      lock,
      phases: state.phases,
      pipeline: buildPhasePipeline(state),
      steps: buildStepPipeline(state),
      currentEval: formatEvalTail(currentPhaseState && currentPhaseState.lastEval),
      historyTail: Array.isArray(state.history) ? state.history.slice(-10) : [],
      definition: state.definition
        ? {
            name: state.definition.name,
            project: state.definition.project,
            cwd: state.definition.cwd
              ? memory.redactSensitive(String(state.definition.cwd))
              : null,
            engine: state.definition.engine,
            allow: state.definition.allow,
            budget: state.definition.budget,
            phases: (state.definition.phases || []).map((p) => ({
              id: p.id,
              engine: p.engine,
              session: p.session,
              gate: p.gate || null,
              maxFixAttempts: p.maxFixAttempts,
              onPass: p.onPass,
              mode: p.mode || null,
              force: p.force,
              hasPrompt: Boolean(p.prompt),
              promptFile: p.promptFile || null,
              eval: p.eval
                ? {
                    command: p.eval.command,
                    exitCode: p.eval.exitCode,
                    passRegex: p.eval.passRegex || null,
                  }
                : null,
            })),
          }
        : null,
    };
  }

  const names = listLoopNames();
  const loops = names.map((n) => {
    try {
      const s = loadState(n);
      if (!s) return { name: n, status: 'unknown' };
      return summarizeLoopState(s, readLockInfo(n));
    } catch (err) {
      return { name: n, status: 'error', error: err.message };
    }
  });
  return { ok: true, loops };
}

module.exports = {
  STATE_VERSION,
  DEFAULT_MAX_FIX_ATTEMPTS,
  ON_PASS_ACTIONS,
  LOOP_STATUSES,
  PHASE_STATUSES,
  PHASE_GATES,
  TERMINAL_STATUSES,
  RESERVED_LOOP_ROUTE_NAMES,
  EVAL_TAIL_CAP,
  loopsRoot,
  safeLoopName,
  loopDir,
  statePath,
  lockPath,
  definitionSnapshotPath,
  acquireRunnerLock,
  releaseRunnerLock,
  readLockInfo,
  loadState,
  saveState,
  listLoopNames,
  listSchedulerCandidates,
  isSchedulerCandidate,
  loadDefinitionFile,
  validateDefinition,
  validateFile,
  createInitialState,
  planDryRun,
  runLoop,
  runFromFile,
  startFromFile,
  startFromPath,
  resumeLoop,
  requestResume,
  requestPause,
  requestStop,
  requestApprove,
  statusReport,
  summarizeLoopState,
  buildPhasePipeline,
  buildStepPipeline,
  formatEvalTail,
  resolveDefinitionsDir,
  allowedLoopRoots,
  assertPathInAllowedRoots,
  saveDefinition,
  listSavedDefinitions,
  loadSavedDefinition,
  definitionToWritable,
  resolveHeartbeatMs,
  resolvePhasePrompt,
  buildFixPrompt,
  evalPassed,
  runEval,
  runSessionPrompt,
  ensureSession,
  recordMemoryTransition,
  buildLoopNotifyPayload,
  emitLoopNotify,
  runOnPassAction,
  budgetExceeded,
  markLoopPaused,
  // test hooks
  _test: {
    normalizeAllow,
    normalizeBudget,
    normalizePhase,
    truncateText,
    hoursElapsed,
    tryBreakStaleLock,
    isPathInsideRoot,
    budgetSnapshot,
    elapsedMsOf,
  },
};
