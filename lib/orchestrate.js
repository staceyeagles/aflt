'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fleetDir, slugify, homeDir, which } = require('./util');
const messages = require('./messages');

const ROLES = new Set(['master', 'worker', 'docs']);
const WORKER_STATUSES = new Set(['queued', 'running', 'waiting', 'done', 'failed', 'stopped']);
const WAIT_TERMINAL = new Set(['done', 'failed', 'stopped', 'waiting']);
/** Default seconds to ignore stale Herdr done/idle after interactive `aflt send`. */
const DEFAULT_SEND_GRACE_SEC = 15;

/**
 * Default handoff path for a worker: $AGENTFLEET_HOME/results/<id>.md
 */
function defaultResultPath(id, { home } = {}) {
  const base = home || fleetDir();
  return path.join(base, 'results', `${String(id)}.md`);
}

/**
 * Default master plan path: $AGENTFLEET_HOME/plans/<id>.md
 */
function defaultPlanPath(id, { home } = {}) {
  const base = home || fleetDir();
  return path.join(base, 'plans', `${String(id)}.md`);
}

const FALLBACK_HANDOFF_MARKER =
  '<!-- written by af from final output (worker did not write a handoff) -->';

/**
 * Build a markdown handoff from final engine stdout when the worker/master
 * did not write the result file. Keeps the last maxLines of stdout.
 */
function buildFallbackHandoff(stdout, { maxLines = 200 } = {}) {
  let text = String(stdout == null ? '' : stdout).replace(/\s+$/, '');
  const lines = text.length ? text.split(/\r?\n/) : [];
  if (lines.length > maxLines) {
    text = lines.slice(-maxLines).join('\n');
  }
  if (!text.trim()) text = '(no stdout captured)';
  return [
    FALLBACK_HANDOFF_MARKER,
    '',
    '## Summary',
    text,
    '',
    '## Files changed',
    'unknown (af fallback)',
    '',
    '## Open questions',
    'none recorded',
    '',
  ].join('\n');
}

function resultFileMissingOrEmpty(resultPath) {
  if (!resultPath) return true;
  try {
    if (!fs.existsSync(resultPath)) return true;
    return fs.statSync(resultPath).size === 0;
  } catch (_) {
    return true;
  }
}

/**
 * Write fallback handoff to resultPath. Returns the body written.
 */
function writeFallbackHandoff(resultPath, stdout, opts = {}) {
  let body = buildFallbackHandoff(stdout, opts);
  const runId = opts.runId != null ? String(opts.runId) : '';
  const writtenAt = opts.writtenAt != null ? String(opts.writtenAt) : new Date().toISOString();
  if (runId || writtenAt) {
    const prov = [
      FALLBACK_HANDOFF_MARKER,
      runId ? `<!-- af runId: ${runId} -->` : null,
      `<!-- af writtenAt: ${writtenAt} -->`,
      '',
    ]
      .filter((x) => x != null)
      .join('\n');
    body = body.replace(FALLBACK_HANDOFF_MARKER, prov.trimEnd());
  }
  fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(resultPath, body, { encoding: 'utf8', mode: 0o600 });
  return body;
}

/**
 * mtimeMs of a result file, or null if missing/unreadable.
 */
function resultMtimeMs(resultPath) {
  if (!resultPath) return null;
  try {
    if (!fs.existsSync(resultPath)) return null;
    return fs.statSync(resultPath).mtimeMs;
  } catch (_) {
    return null;
  }
}

/**
 * A handoff is fresh iff it exists and mtime is strictly after runStartedAt
 * (ISO) or resultMtimeAtStart (epoch ms), when those are known.
 * @returns {boolean|null} true/false, or null when freshness cannot be judged
 */
function isHandoffFresh(session, resultPath) {
  const dest =
    resultPath ||
    (session && session.result) ||
    (session && session.id ? defaultResultPath(session.id) : null);
  const mtime = resultMtimeMs(dest);
  if (mtime == null) return null;
  const startMs =
    session && session.resultMtimeAtStart != null && Number.isFinite(Number(session.resultMtimeAtStart))
      ? Number(session.resultMtimeAtStart)
      : null;
  if (startMs != null) return mtime > startMs;
  const started = session && session.runStartedAt ? Date.parse(String(session.runStartedAt)) : NaN;
  if (Number.isFinite(started)) return mtime > started;
  return null;
}

/**
 * After a successful headless run: if result is missing/empty OR stale,
 * write fallback from stdout. Returns 'worker' | 'af-fallback' | null.
 */
function ensureResultHandoff(session, { code, timedOut, stdout, resultPath, runId } = {}) {
  const dest = resultPath || (session && session.result) || null;
  if (!dest) return null;
  if (timedOut || (code != null && code !== 0)) return null;
  const fresh = isHandoffFresh(
    {
      ...(session || {}),
      runStartedAt: session && session.runStartedAt,
      resultMtimeAtStart: session && session.resultMtimeAtStart,
    },
    dest
  );
  const missing = resultFileMissingOrEmpty(dest);
  const stale = fresh === false;
  if (!missing && !stale) return 'worker';
  writeFallbackHandoff(dest, stdout, {
    runId: runId || (session && session.runId) || null,
    writtenAt: new Date().toISOString(),
  });
  return 'af-fallback';
}

/**
 * HANDOFF column: yes | af | stale | no
 */
function handoffDisplay(session, resultPath) {
  const dest =
    resultPath ||
    (session && session.result) ||
    (session && session.id ? defaultResultPath(session.id) : null);
  if (resultFileMissingOrEmpty(dest)) return 'no';
  const fresh = isHandoffFresh(session, dest);
  if (fresh === false) return 'stale';
  if (session && session.resultSource === 'af-fallback') return 'af';
  return 'yes';
}

/**
 * Structured handoff fields for JSON rows.
 */
function handoffInfo(session, resultPath) {
  const dest =
    resultPath ||
    (session && session.result) ||
    (session && session.id ? defaultResultPath(session.id) : null);
  const exists = !resultFileMissingOrEmpty(dest);
  const fresh = exists ? isHandoffFresh(session, dest) : null;
  const source = session && session.resultSource ? session.resultSource : null;
  return {
    resultExists: exists,
    fresh,
    stale: exists && fresh === false,
    resultSource: source,
    handoff: handoffDisplay(session, dest),
    result: dest,
  };
}

/**
 * Wait/outcome metadata for interactive vs headless.
 * @returns {{ outcome, stateSource, conclusive, agentState }}
 */
function waitOutcomeMeta(
  session,
  { runtime, exitCode, agentState, derivedStatus, isAlive, hostname } = {}
) {
  const status = derivedStatus || null;
  let stateSource = 'stored';
  let conclusive = true;
  if (runtime === 'running') {
    if (agentState == null || agentState === '') {
      stateSource = 'none';
      conclusive = false;
    } else {
      stateSource = 'herdr';
      conclusive = status === 'waiting' || status === 'done' || status === 'failed' || status === 'stopped';
    }
  } else if (runtime === 'shell') {
    // Shell-only: conclusive stopped; stateSource distinguishes from exit/missing.
    stateSource = 'shell';
    conclusive = true;
  } else if (runtime === 'exited') {
    stateSource = 'exit';
    conclusive = true;
  } else if (runtime === 'missing') {
    stateSource = 'herdr';
    conclusive = true;
  } else if (session && session.runPid != null) {
    const recon = reconcileDeadRunPid(session, { isAlive, hostname });
    if (recon && recon.stateSource === 'handoff' && (status === 'done' || recon.status === 'done')) {
      stateSource = 'handoff';
    } else {
      stateSource = 'pid';
    }
  }
  return {
    outcome: status,
    stateSource,
    conclusive,
    agentState: agentState != null ? agentState : null,
    lastExit: session && session.lastExit != null ? session.lastExit : exitCode != null ? exitCode : null,
  };
}

/**
 * True if resolved `filePath` is inside `dir` (or equal to it).
 */
function isPathInside(filePath, dir) {
  if (!filePath || !dir) return false;
  const parent = path.resolve(String(dir));
  const target = path.resolve(String(filePath));
  if (target === parent) return true;
  const prefix = parent.endsWith(path.sep) ? parent : parent + path.sep;
  return target.startsWith(prefix);
}

/**
 * Af-owned files/dirs safe to delete with `aflt rm` (under AGENTFLEET_HOME only).
 * @returns {{ files: string[], dirs: string[], skipped: { path: string, reason: string }[] }}
 */
function sessionOwnedPaths(session, { home } = {}) {
  const base = path.resolve(home || fleetDir());
  const resultsDir = path.join(base, 'results');
  const plansDir = path.join(base, 'plans');
  const files = [];
  const dirs = [];
  const skipped = [];

  if (session && session.result) {
    const r = path.resolve(String(session.result));
    if (isPathInside(r, resultsDir)) files.push(r);
    else skipped.push({ path: r, reason: 'result outside $AGENTFLEET_HOME/results' });
  }
  if (session && session.plan) {
    const p = path.resolve(String(session.plan));
    if (isPathInside(p, plansDir)) files.push(p);
    else skipped.push({ path: p, reason: 'plan outside $AGENTFLEET_HOME/plans' });
  }
  if (session && session.id) {
    const runDir = path.join(base, 'runs', String(session.id));
    if (isPathInside(runDir, path.join(base, 'runs'))) dirs.push(runDir);
  }
  return { files, dirs, skipped };
}

/**
 * First ~maxLen chars of prompt as a single-line task summary.
 */
function taskFromPrompt(prompt, maxLen = 80) {
  const line = String(prompt || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!line) return '';
  if (line.length <= maxLen) return line;
  return line.slice(0, Math.max(1, maxLen - 1)).trimEnd() + '…';
}

/**
 * Default worker title: <parentTitle>-w<N> where N = childCount + 1.
 * Bumps N until unique among existingTitles.
 */
function nextWorkerTitle(parentTitle, childCount, existingTitles = []) {
  const base = String(parentTitle || 'worker').trim() || 'worker';
  const taken = new Set((existingTitles || []).map(String));
  let n = Math.max(1, Number(childCount) + 1 || 1);
  let title = `${base}-w${n}`;
  while (taken.has(title)) {
    n++;
    title = `${base}-w${n}`;
  }
  return title;
}

/**
 * Wrap a user prompt with worker handoff instructions.
 * When messagingEnabled, appends short task-scoped messaging guidance.
 */
function wrapWorkerPrompt({ parentTitle, parentId, task, resultPath, prompt, messagingEnabled }) {
  const master = String(parentTitle || '').trim() || '(untitled)';
  const id = String(parentId || '').trim() || '(unknown)';
  const taskLine = String(task || '').trim() || '(none)';
  const result = String(resultPath || '').trim() || '(unset)';
  const body = String(prompt || '');
  const headerLines = [
    'You are a worker agent for master "' + master + '" (id: ' + id + ').',
    'Your task: ' + taskLine,
    'When finished, you MUST write a markdown handoff to ' + result + ' with these sections:',
    '',
    '## Summary',
    '## Files changed',
    '## Open questions',
    '',
    'Do not commit or push.',
  ];
  if (messagingEnabled) {
    headerLines.push('', messages.MESSAGING_PROMPT_LINES_WORKER);
  }
  headerLines.push('', '---', '');
  return headerLines.join('\n') + body;
}

/**
 * Short reminder for headless `aflt send` continuations (do not re-wrap the full preamble).
 */
function continueWorkerPrompt(resultPath, text) {
  const result = String(resultPath || '').trim() || '(unset)';
  return `(Update your handoff at ${result} when done.)\n\n${String(text || '')}`;
}

/**
 * process.kill(pid, 0) probe. Injectable for tests.
 */
function defaultIsAlive(pid) {
  if (pid == null || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * True when a result file looks like an af-fallback handoff (not worker-written).
 */
function isFallbackHandoffFile(resultPath) {
  if (!resultPath) return false;
  try {
    if (!fs.existsSync(resultPath)) return false;
    const head = fs.readFileSync(resultPath, 'utf8').slice(0, 240);
    return (
      head.includes(FALLBACK_HANDOFF_MARKER) ||
      /written by af from final output/i.test(head)
    );
  } catch (_) {
    return false;
  }
}

/**
 * When a headless runPid is dead but lastExit was never recorded (e.g. the af
 * spawn wrapper was killed while the detached engine finished), reconcile:
 * - stopRequested → stopped
 * - fresh worker handoff (not fallback) after runStartedAt → done (handoff)
 * - otherwise → failed (pid)
 *
 * @returns {null|{ status, stateSource, persist, patch }}
 */
function reconcileDeadRunPid(session, opts = {}) {
  const isAlive = typeof opts.isAlive === 'function' ? opts.isAlive : defaultIsAlive;
  const hostname = opts.hostname != null ? String(opts.hostname) : os.hostname();
  if (!session || session.runPid == null) return null;
  const stored =
    session.workerStatus != null && session.workerStatus !== ''
      ? String(session.workerStatus)
      : null;
  if (stored !== 'running') return null;
  const sameHost = !session.runHost || String(session.runHost) === hostname;
  if (!sameHost || isAlive(session.runPid)) return null;
  if (session.stopRequested) {
    return {
      status: 'stopped',
      stateSource: 'pid',
      persist: true,
      patch: { workerStatus: 'stopped', runPid: null, runPgid: null },
    };
  }
  if (session.lastExit != null) {
    return { status: 'failed', stateSource: 'pid', persist: false, patch: null };
  }
  const resultPath = session.result || defaultResultPath(session.id);
  const hand = handoffInfo(session, resultPath);
  const fallback =
    hand.resultSource === 'af-fallback' || isFallbackHandoffFile(resultPath);
  if (hand.resultExists && hand.fresh === true && !fallback) {
    return {
      status: 'done',
      stateSource: 'handoff',
      persist: true,
      patch: {
        workerStatus: 'done',
        runPid: null,
        runPgid: null,
        resultSource: hand.resultSource === 'worker' ? 'worker' : 'worker',
      },
    };
  }
  return { status: 'failed', stateSource: 'pid', persist: false, patch: null };
}

/**
 * Best-effort workerStatus for display.
 * 1) Herdr runtime when present (interactive): running → running; shell →
 *    stopped (conclusive; agent not in terminal); exited → done/failed/stopped;
 *    missing → stopped; unknown / absent → keep stored.
 * 2) Headless liveness: stored `running` with a runPid that is not alive on
 *    the same host → reconcile via handoff (done) / stopRequested / failed.
 * 3) Optional Herdr agent-state hint (`waiting`) from detectWaitingTransition.
 *
 * Choice for shell-only terminals: derive `stopped` (not a distinct workerStatus)
 * with waitOutcomeMeta conclusive=true and stateSource `shell`, so `aflt wait`
 * exits 1. Callers should print a clear "shell only; run aflt resume" hint.
 */
function deriveWorkerStatus(session, herdrInfo = null, opts = {}) {
  const isAlive = typeof opts.isAlive === 'function' ? opts.isAlive : defaultIsAlive;
  const hostname = opts.hostname != null ? String(opts.hostname) : os.hostname();
  const stored =
    session && session.workerStatus != null && session.workerStatus !== ''
      ? String(session.workerStatus)
      : null;
  const runtime = herdrInfo && herdrInfo.runtime != null ? String(herdrInfo.runtime) : null;

  if (runtime === 'running') {
    if (herdrInfo && herdrInfo.waitingHint === 'waiting') return 'waiting';
    return 'running';
  }
  if (runtime === 'shell') {
    // Alive tab, agent not running — treat as stopped so wait terminates.
    return 'stopped';
  }
  if (runtime === 'exited') {
    const code = herdrInfo && herdrInfo.exitCode;
    if (code === 0) return 'done';
    if (code != null) return 'failed';
    return 'stopped';
  }
  if (runtime === 'missing') return 'stopped';

  // Headless (or no useful Herdr runtime): dead runPid while still "running".
  const recon = reconcileDeadRunPid(session, { isAlive, hostname });
  if (recon) return recon.status;

  return stored;
}

/**
 * Extract Herdr agent state from `hc get --json` / terminal object.
 *
 * Herdr (herdr-core ≥0.1.20) exposes OSC 7501 via terminal.status:
 *   { state: 'idle'|'working'|'done'|'blocked'|'error', ... } or null when
 * the program never reported (Cursor does not emit OSC 7501 → status is null).
 * `hc send --if idle|working` uses the same words.
 *
 * @returns {'idle'|'working'|'done'|'blocked'|'error'|null}
 */
function agentStateFromHerdr(terminalOrGet) {
  if (!terminalOrGet || typeof terminalOrGet !== 'object') return null;
  const status = terminalOrGet.status;
  if (status == null || status === '') return null;
  if (typeof status === 'string') {
    const s = status.trim().toLowerCase();
    return s || null;
  }
  if (typeof status === 'object' && status.state != null) {
    const s = String(status.state).trim().toLowerCase();
    return s || null;
  }
  return null;
}

/**
 * Resolve send-grace duration in ms. Flag overrides env; default 15s.
 * @param {{ flag?: string|number|boolean, env?: NodeJS.ProcessEnv }} [opts]
 */
function resolveSendGraceMs({ flag, env = process.env } = {}) {
  let sec = DEFAULT_SEND_GRACE_SEC;
  const fromEnv = env && env.AGENTFLEET_SEND_GRACE;
  if (fromEnv != null && fromEnv !== '') {
    const n = Number(fromEnv);
    if (!Number.isNaN(n) && n >= 0) sec = n;
  }
  if (flag != null && flag !== true && flag !== '') {
    const n = Number(flag);
    if (!Number.isNaN(n) && n >= 0) sec = n;
  }
  return sec * 1000;
}

/**
 * Pure waiting detection across poll ticks for interactive workers.
 *
 * If Herdr shows the agent `working`, remember that. Once it has been seen
 * working, an `idle` state that persists for >= one poll interval
 * is treated as `waiting` (needs input). `blocked` is always immediate
 * `waiting`. `done` is immediate `waiting` unless a recent interactive
 * `aflt send` left `lastSendAt` and we have not yet seen `working` this wait —
 * then ignore `done`/`idle` until `working` appears or the send-grace window
 * (default 15s) expires (instant turn → treat as waiting after grace).
 * When status is null (e.g. Cursor), returns no hint.
 *
 * @param {{ now?: number }} [opts] injectable clock (ms since epoch)
 * @returns {{ hint: 'running'|'waiting'|null, seenWorking: boolean, idleTicks: number }}
 */
function detectWaitingTransition({
  agentState,
  seenWorking = false,
  idleTicks = 0,
  lastSendAt = null,
  sendGraceMs = DEFAULT_SEND_GRACE_SEC * 1000,
  now = Date.now(),
} = {}) {
  const state = agentState != null ? String(agentState).toLowerCase() : null;
  if (state === 'working') {
    return { hint: 'running', seenWorking: true, idleTicks: 0 };
  }
  if (state === 'blocked') {
    return { hint: 'waiting', seenWorking: true, idleTicks };
  }

  const sendAtMs = lastSendAt ? Date.parse(String(lastSendAt)) : NaN;
  const graceMs = Number(sendGraceMs);
  const hasSend = Number.isFinite(sendAtMs) && Number.isFinite(graceMs) && graceMs >= 0;
  const withinGrace = hasSend && !seenWorking && now < sendAtMs + graceMs;
  const pastGraceNoWorking = hasSend && !seenWorking && now >= sendAtMs + graceMs;

  // After aflt send, Herdr may still report the previous turn's done/idle.
  if (withinGrace && (state === 'done' || state === 'idle')) {
    return { hint: null, seenWorking: false, idleTicks: 0 };
  }

  // 'done' means the agent explicitly reported its turn finished (Copilot
  // emits this via OSC 7501). Treat it as waiting-for-input right away, even
  // if this aflt wait never saw it working (it may have finished before wait
  // started; seen live on the Mini 2026-11-12). After send-grace with no
  // working sighting, same (turn may have been instant).
  if (state === 'done') {
    return { hint: 'waiting', seenWorking: true, idleTicks: (Number(idleTicks) || 0) + 1 };
  }
  if (state === 'idle') {
    // Post-send grace expired without seeing working: idle counts as waiting.
    if (pastGraceNoWorking) {
      return { hint: 'waiting', seenWorking: true, idleTicks: (Number(idleTicks) || 0) + 1 };
    }
    // Plain idle still needs a prior working sighting (fresh session is idle).
    if (!seenWorking) {
      return { hint: null, seenWorking: false, idleTicks: 0 };
    }
    const next = idleTicks + 1;
    if (next >= 1) {
      return { hint: 'waiting', seenWorking: true, idleTicks: next };
    }
    return { hint: null, seenWorking: true, idleTicks: next };
  }
  return { hint: null, seenWorking: Boolean(seenWorking), idleTicks: Number(idleTicks) || 0 };
}

/**
 * Default master title: master-<slug(goal)>, unique among existingTitles.
 */
function nextMasterTitle(goal, existingTitles = []) {
  const slug = slugify(goal || 'goal').slice(0, 40) || 'goal';
  const base = `master-${slug}`;
  const taken = new Set((existingTitles || []).map(String));
  if (!taken.has(base)) return base;
  let n = 2;
  let title = `${base}-${n}`;
  while (taken.has(title)) {
    n++;
    title = `${base}-${n}`;
  }
  return title;
}

/**
 * Replace {{KEY}} placeholders. Unknown keys are left unchanged.
 */
function renderTemplate(template, vars = {}) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return vars[key] == null ? '' : String(vars[key]);
    }
    return match;
  });
}

/**
 * Load templates/orchestrator.md (or an override path).
 */
function loadOrchestratorTemplate({ templatePath } = {}) {
  const p =
    templatePath || path.join(__dirname, '..', 'templates', 'orchestrator.md');
  return fs.readFileSync(p, 'utf8');
}

/**
 * Load templates/documentarian.md (or an override path).
 */
function loadDocumentarianTemplate({ templatePath } = {}) {
  const p =
    templatePath || path.join(__dirname, '..', 'templates', 'documentarian.md');
  return fs.readFileSync(p, 'utf8');
}

/**
 * Directory containing the `af` executable (PATH lookup, else argv[1]).
 */
function resolveAfBinDir() {
  const fromPath = which('af');
  if (fromPath) {
    try {
      return path.dirname(fs.realpathSync(fromPath));
    } catch (_) {
      return path.dirname(fromPath);
    }
  }
  const argv1 = process.argv[1];
  if (argv1) {
    try {
      return path.dirname(fs.realpathSync(argv1));
    } catch (_) {
      return path.dirname(path.resolve(argv1));
    }
  }
  return null;
}

/**
 * PATH with af's bin dir and ~/.local/bin prepended (deduped).
 */
function pathWithAf(env = process.env) {
  const parts = [];
  const afDir = resolveAfBinDir();
  if (afDir) parts.push(afDir);
  parts.push(path.join(homeDir(), '.local', 'bin'));
  const existing = env && env.PATH != null ? String(env.PATH) : '';
  const seen = new Set();
  const out = [];
  for (const p of [...parts, ...existing.split(path.delimiter)]) {
    if (!p || seen.has(p)) continue;
    seen.add(p);
    out.push(p);
  }
  return out.join(path.delimiter);
}

/**
 * Statuses that end `aflt wait` for a worker (including waiting-for-input).
 */
function isWaitTerminalStatus(status) {
  return WAIT_TERMINAL.has(String(status || ''));
}

/**
 * Exit-code precedence for `aflt wait`:
 *   2 timeout; else 1 any failed/stopped; else 3 any waiting; else 0.
 */
function waitExitCode(statuses, { timedOut = false } = {}) {
  if (timedOut) return 2;
  const list = Array.isArray(statuses) ? statuses.map((s) => String(s || '')) : [];
  if (list.some((s) => s === 'failed' || s === 'stopped')) return 1;
  if (list.some((s) => s === 'waiting')) return 3;
  return 0;
}

function validateRole(role) {
  if (role == null || role === '') return null;
  const r = String(role);
  if (!ROLES.has(r)) throw new Error(`invalid role: ${role} (want master, worker, or docs)`);
  return r;
}

function validateWorkerStatus(status) {
  if (status == null || status === '') return null;
  const s = String(status);
  if (!WORKER_STATUSES.has(s)) {
    throw new Error(
      `invalid workerStatus: ${status} (want ${[...WORKER_STATUSES].join('|')})`
    );
  }
  return s;
}

module.exports = {
  ROLES,
  WORKER_STATUSES,
  WAIT_TERMINAL,
  DEFAULT_SEND_GRACE_SEC,
  FALLBACK_HANDOFF_MARKER,
  defaultResultPath,
  defaultPlanPath,
  buildFallbackHandoff,
  resultFileMissingOrEmpty,
  writeFallbackHandoff,
  ensureResultHandoff,
  handoffDisplay,
  handoffInfo,
  resultMtimeMs,
  isHandoffFresh,
  waitOutcomeMeta,
  isPathInside,
  sessionOwnedPaths,
  taskFromPrompt,
  nextWorkerTitle,
  nextMasterTitle,
  wrapWorkerPrompt,
  continueWorkerPrompt,
  defaultIsAlive,
  deriveWorkerStatus,
  reconcileDeadRunPid,
  isFallbackHandoffFile,
  agentStateFromHerdr,
  resolveSendGraceMs,
  detectWaitingTransition,
  isWaitTerminalStatus,
  waitExitCode,
  validateRole,
  validateWorkerStatus,
  renderTemplate,
  loadOrchestratorTemplate,
  loadDocumentarianTemplate,
  resolveAfBinDir,
  pathWithAf,
};
