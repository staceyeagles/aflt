'use strict';

const os = require('os');
const path = require('path');
const { fleetDir } = require('./util');

const ROLES = new Set(['master', 'worker']);
const WORKER_STATUSES = new Set(['queued', 'running', 'waiting', 'done', 'failed', 'stopped']);
const WAIT_TERMINAL = new Set(['done', 'failed', 'stopped', 'waiting']);

/**
 * Default handoff path for a worker: $AGENTFLEET_HOME/results/<id>.md
 */
function defaultResultPath(id, { home } = {}) {
  const base = home || fleetDir();
  return path.join(base, 'results', `${String(id)}.md`);
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
 */
function wrapWorkerPrompt({ parentTitle, parentId, task, resultPath, prompt }) {
  const master = String(parentTitle || '').trim() || '(untitled)';
  const id = String(parentId || '').trim() || '(unknown)';
  const taskLine = String(task || '').trim() || '(none)';
  const result = String(resultPath || '').trim() || '(unset)';
  const body = String(prompt || '');
  const header = [
    'You are a worker agent for master "' + master + '" (id: ' + id + ').',
    'Your task: ' + taskLine,
    'When finished, you MUST write a markdown handoff to ' + result + ' with these sections:',
    '',
    '## Summary',
    '## Files changed',
    '## Open questions',
    '',
    'Do not commit or push.',
    '',
    '---',
    '',
  ].join('\n');
  return header + body;
}

/**
 * Short reminder for headless `af send` continuations (do not re-wrap the full preamble).
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
 * Best-effort workerStatus for display.
 * 1) Herdr runtime when present (interactive): running → running; exited →
 *    done/failed/stopped; missing → stopped; unknown / absent → keep stored.
 * 2) Headless liveness: stored `running` with a runPid that is not alive on
 *    the same host → `failed`, or `stopped` if stopRequested.
 * 3) Optional Herdr agent-state hint (`waiting`) from detectWaitingTransition.
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
  if (runtime === 'exited') {
    const code = herdrInfo && herdrInfo.exitCode;
    if (code === 0) return 'done';
    if (code != null) return 'failed';
    return 'stopped';
  }
  if (runtime === 'missing') return 'stopped';

  // Headless (or no useful Herdr runtime): dead runPid while still "running".
  if (stored === 'running' && session && session.runPid != null) {
    const sameHost = !session.runHost || String(session.runHost) === hostname;
    if (sameHost && !isAlive(session.runPid)) {
      return session.stopRequested ? 'stopped' : 'failed';
    }
  }

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
 * Pure waiting detection across poll ticks for interactive workers.
 *
 * If Herdr shows the agent `working`, remember that. Once it has been seen
 * working, an `idle` state that persists for >= one poll interval
 * is treated as `waiting` (needs input). `blocked` and `done` are immediately `waiting`.
 * When status is null (e.g. Cursor), returns no hint.
 *
 * @returns {{ hint: 'running'|'waiting'|null, seenWorking: boolean, idleTicks: number }}
 */
function detectWaitingTransition({ agentState, seenWorking = false, idleTicks = 0 } = {}) {
  const state = agentState != null ? String(agentState).toLowerCase() : null;
  if (state === 'working') {
    return { hint: 'running', seenWorking: true, idleTicks: 0 };
  }
  if (state === 'blocked') {
    return { hint: 'waiting', seenWorking: true, idleTicks };
  }
  // 'done' means the agent explicitly reported its turn finished (Copilot
  // emits this via OSC 7501). Treat it as waiting-for-input right away, even
  // if this af wait never saw it working (it may have finished before wait
  // started; seen live on the Mini 2026-11-12). Plain 'idle' still needs a
  // prior 'working' sighting, since a fresh session also reports idle.
  if (state === 'done') {
    return { hint: 'waiting', seenWorking: true, idleTicks: (Number(idleTicks) || 0) + 1 };
  }
  if (state === 'idle' || state === 'done') {
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
 * Statuses that end `af wait` for a worker (including waiting-for-input).
 */
function isWaitTerminalStatus(status) {
  return WAIT_TERMINAL.has(String(status || ''));
}

/**
 * Exit-code precedence for `af wait`:
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
  if (!ROLES.has(r)) throw new Error(`invalid role: ${role} (want master or worker)`);
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
  defaultResultPath,
  taskFromPrompt,
  nextWorkerTitle,
  wrapWorkerPrompt,
  continueWorkerPrompt,
  defaultIsAlive,
  deriveWorkerStatus,
  agentStateFromHerdr,
  detectWaitingTransition,
  isWaitTerminalStatus,
  waitExitCode,
  validateRole,
  validateWorkerStatus,
};
