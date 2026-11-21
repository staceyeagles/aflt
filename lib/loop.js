'use strict';

/**
 * `aflt loop` — long-running plan→develop→eval→revise runner (milestone 1).
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
} = require('./util');

const STATE_VERSION = 1;
const DEFAULT_MAX_FIX_ATTEMPTS = 3;
const ON_PASS_ACTIONS = new Set(['none', 'commit', 'merge', 'push']);
const LOOP_STATUSES = new Set([
  'pending',
  'running',
  'completed',
  'failed',
  'stopped',
]);
const PHASE_STATUSES = new Set(['pending', 'running', 'passed', 'failed', 'skipped']);
const LOCK_STALE_MS = 60_000;
const EVAL_OUTPUT_CAP = 12_000;
const FIX_OUTPUT_CAP = 8000;

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
    stopRequested: false,
    lastError: null,
    phases,
    history: [],
  };
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
  } catch (_) {
    /* ignore */
  }
  return Boolean(state.stopRequested);
}

async function finishIfStopRequested(state, name, env) {
  mergeStopRequestedFromDisk(state, name);
  if (!state.stopRequested) return null;
  await markLoopStopped(state, 'stop requested', { env });
  return { ok: false, status: 'stopped', state };
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
  state.failedAt = nowIso();
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
  state.stoppedAt = nowIso();
  state.stopRequested = false;
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

function markLoopCompleted(state, opts = {}) {
  state.status = 'completed';
  state.completedAt = nowIso();
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

    if (state.stopRequested && state.status === 'running') {
      await markLoopStopped(state, 'stop requested before resume', { env });
      return { ok: false, status: 'stopped', state };
    }

    const starting = state.status !== 'running' || !state.startedAt;
    state.status = 'running';
    state.stopRequested = false;
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

    const phases = state.definition.phases;
    while (state.phaseIndex < phases.length) {
      const stoppedEarly = await finishIfStopRequested(state, name, env);
      if (stoppedEarly) return stoppedEarly;

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

      let session;
      try {
        session = await ensureSession(phase, state.definition, { env });
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
  // Clear failed → allow resume after stop; for failed need opts.force
  if (state.status === 'stopped' || state.status === 'failed') {
    state.status = 'running';
    state.stopRequested = false;
    state.lastError = null;
    saveState(state);
  }
  return runLoop(definition, {
    ...opts,
    resume: true,
    definitionPath: state.definitionPath,
  });
}

function requestStop(name, opts = {}) {
  const safe = safeLoopName(name);
  const state = loadState(safe);
  if (!state) {
    return { ok: false, error: `no loop state for "${safe}"` };
  }
  if (state.status === 'completed' || state.status === 'failed' || state.status === 'stopped') {
    return { ok: true, status: state.status, state, message: `loop already ${state.status}` };
  }
  state.stopRequested = true;
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

function statusReport(name, opts = {}) {
  if (name) {
    const safe = safeLoopName(name);
    const state = loadState(safe);
    if (!state) {
      return { ok: false, error: `no loop state for "${safe}"` };
    }
    const lock = readLockInfo(safe);
    return {
      ok: true,
      name: safe,
      status: state.status,
      phaseId: state.phaseId,
      phaseIndex: state.phaseIndex,
      attempt: state.attempt,
      step: state.step,
      runsUsed: state.runsUsed,
      startedAt: state.startedAt,
      updatedAt: state.updatedAt,
      completedAt: state.completedAt,
      failedAt: state.failedAt,
      stoppedAt: state.stoppedAt,
      stopRequested: Boolean(state.stopRequested),
      lastError: state.lastError,
      lock,
      phases: state.phases,
      definitionPath: state.definitionPath,
      project: state.definition && state.definition.project,
      cwd: state.definition && state.definition.cwd,
      historyTail: Array.isArray(state.history) ? state.history.slice(-10) : [],
    };
  }

  const names = listLoopNames();
  const loops = names.map((n) => {
    try {
      const s = loadState(n);
      const lock = readLockInfo(n);
      return {
        name: n,
        status: s ? s.status : 'unknown',
        phaseId: s ? s.phaseId : null,
        updatedAt: s ? s.updatedAt : null,
        stopRequested: s ? Boolean(s.stopRequested) : false,
        lockAlive: Boolean(lock && lock.alive),
      };
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
  loopsRoot,
  safeLoopName,
  loopDir,
  statePath,
  lockPath,
  acquireRunnerLock,
  releaseRunnerLock,
  readLockInfo,
  loadState,
  saveState,
  listLoopNames,
  loadDefinitionFile,
  validateDefinition,
  validateFile,
  createInitialState,
  planDryRun,
  runLoop,
  runFromFile,
  resumeLoop,
  requestStop,
  statusReport,
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
  // test hooks
  _test: {
    normalizeAllow,
    normalizeBudget,
    normalizePhase,
    truncateText,
    hoursElapsed,
    tryBreakStaleLock,
  },
};
