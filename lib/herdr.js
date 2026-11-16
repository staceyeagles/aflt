'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { which, nowIso, homeDir } = require('./util');

const DEFAULT_TIMEOUT_MS = 7000;
const RUNTIMES = new Set(['running', 'shell', 'exited', 'missing', 'unknown', '-']);

/** Real Herdr templates only — not aflt prompt files (DOC-AGENT, documentarian, orchestrator). */
const HERDR_TEMPLATE_FILES = Object.freeze(['copilot.md', 'cursor.md', 'opencode.md']);

/**
 * Resolve the `hc` binary. Honors AGENTFLEET_HC_BIN first; never falls back to
 * ~/.local/bin/hc when that env var is set (or under AGENTFLEET_TEST_HERMETIC).
 */
function resolveHcBin(env = process.env) {
  if (env && env.AGENTFLEET_HC_BIN) return env.AGENTFLEET_HC_BIN;
  const found = which('hc');
  if (found) return found;
  if (env && env.AGENTFLEET_TEST_HERMETIC === '1') return 'hc';
  const fallback = path.join(homeDir(), '.local', 'bin', 'hc');
  try {
    if (fs.existsSync(fallback)) return fallback;
  } catch (_) {
    /* ignore */
  }
  return 'hc';
}

function hcOnPath(env = process.env) {
  if (env && env.AGENTFLEET_HC_BIN) {
    try {
      return fs.existsSync(env.AGENTFLEET_HC_BIN);
    } catch (_) {
      return true;
    }
  }
  return Boolean(which('hc'));
}

/** Foreground program names that mean "login/interactive shell only" (agent not running). */
const SHELL_AGENT_NAMES = new Set([
  'zsh',
  'bash',
  'fish',
  'sh',
  'nu',
  'dash',
  'tcsh',
  'csh',
  'ksh',
]);

/**
 * Parse `hc ls --all --json` (or get) payload into full terminal records.
 * Tolerant of array or {terminals|items|data}, and labels as object or ["af_id=z"].
 */
function parseHerdrTerminals(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return null;
  }
  let list = data;
  if (data && !Array.isArray(data)) {
    if (Array.isArray(data.terminals) || Array.isArray(data.items) || Array.isArray(data.data)) {
      list = data.terminals || data.items || data.data;
    } else if (data.address || data.name || data.labels || data.state) {
      // Single terminal object from `hc get --json`
      list = [data];
    } else {
      list = null;
    }
  }
  if (!Array.isArray(list)) return null;
  return list
    .filter((t) => t && typeof t === 'object')
    .map((t) => normalizeTerminal(t));
}

function normalizeLabels(raw) {
  if (!raw) return {};
  if (Array.isArray(raw)) {
    const o = {};
    for (const l of raw) {
      if (typeof l === 'string' && l.includes('=')) {
        o[l.slice(0, l.indexOf('='))] = l.slice(l.indexOf('=') + 1);
      } else if (l && l.key) {
        o[l.key] = l.value;
      }
    }
    return o;
  }
  if (typeof raw === 'object') return { ...raw };
  return {};
}

function normalizeTerminal(t) {
  const labels = normalizeLabels(t.labels);
  const exitCode =
    t.exit_code != null
      ? t.exit_code
      : t.exitCode != null
        ? t.exitCode
        : null;
  let foreground = null;
  if (t.foreground && typeof t.foreground === 'object') {
    foreground = {
      name: t.foreground.name != null ? String(t.foreground.name) : null,
      cwd: t.foreground.cwd != null ? String(t.foreground.cwd) : null,
      pid: t.foreground.pid != null ? t.foreground.pid : null,
      argv: Array.isArray(t.foreground.argv) ? t.foreground.argv.map(String) : null,
    };
  }
  return {
    address: t.address || null,
    name: t.name || null,
    state: t.state != null ? String(t.state) : null,
    reason: t.reason != null ? String(t.reason) : null,
    exitCode: exitCode,
    cwd: t.cwd || null,
    agent: t.agent != null ? String(t.agent) : null,
    argv: Array.isArray(t.argv) ? t.argv.map(String) : null,
    foreground,
    labels,
    afId: labels.af_id || null,
    // OSC 7501 agent status (idle|working|done|blocked|error); null if never reported.
    status: t.status != null ? t.status : null,
    statusMs: t.status_ms != null ? t.status_ms : t.statusMs != null ? t.statusMs : null,
    turn: t.turn != null ? t.turn : null,
    reported: Boolean(t.reported),
  };
}

/**
 * Basename of an agent/argv token, stripping a leading "-" (login shells like -zsh).
 */
function shellAgentBasename(raw) {
  if (raw == null) return '';
  let s = String(raw).trim();
  if (!s) return '';
  // First token only (e.g. "/bin/zsh -l" → "/bin/zsh")
  s = s.split(/\s+/)[0];
  if (s.startsWith('-') && s.length > 1 && s[1] !== '/') s = s.slice(1);
  try {
    s = path.basename(s);
  } catch (_) {
    /* keep s */
  }
  if (s.startsWith('-') && s.length > 1) s = s.slice(1);
  return s.toLowerCase();
}

/** True when the name refers to a plain shell (not env / engine / other program). */
function isShellAgentName(raw) {
  const n = shellAgentBasename(raw);
  return Boolean(n) && SHELL_AGENT_NAMES.has(n);
}

/**
 * Collect non-empty program-name tokens from ls/get evidence (agent, foreground, argv).
 */
function terminalProgramNames(t) {
  const names = [];
  if (!t) return names;
  if (t.agent != null && String(t.agent).trim() !== '') names.push(t.agent);
  if (t.foreground) {
    if (t.foreground.name != null && String(t.foreground.name).trim() !== '') {
      names.push(t.foreground.name);
    }
    if (Array.isArray(t.foreground.argv) && t.foreground.argv[0]) {
      names.push(t.foreground.argv[0]);
    }
  }
  if (Array.isArray(t.argv) && t.argv[0]) names.push(t.argv[0]);
  return names;
}

/**
 * Live terminal whose foreground is only a shell (agent stopped after --keep restore).
 *
 * Classify as `shell` ONLY when a known shell name is positively observed and no
 * non-shell evidence contradicts it. Examples:
 *   - agent "zsh" / foreground zsh → shell
 *   - agent "env" or "cursor-agent", or foreground "node" → running
 *   - agent "env" even if get also reports a shell foreground → running (non-shell wins)
 *   - null/missing everywhere → running (alive, agent unknown) — never shell
 */
function isShellOnlyTerminal(t) {
  if (!t || !isLiveTerminal(t)) return false;
  let sawShell = false;
  let sawNonShell = false;
  for (const raw of terminalProgramNames(t)) {
    const base = shellAgentBasename(raw);
    if (!base) continue;
    if (SHELL_AGENT_NAMES.has(base)) sawShell = true;
    else sawNonShell = true;
  }
  if (sawNonShell) return false;
  return sawShell;
}

/** Prefer a non-empty string from `a`, else `b` (null in one never overrides a value). */
function coalesceNonEmpty(a, b) {
  if (a != null && String(a).trim() !== '') return a;
  if (b != null && String(b).trim() !== '') return b;
  return a != null ? a : b;
}

function mergeForeground(base, detail) {
  if (!detail && !base) return null;
  if (!detail) return base;
  if (!base) return detail;
  return {
    name: coalesceNonEmpty(detail.name, base.name),
    cwd: coalesceNonEmpty(detail.cwd, base.cwd),
    pid: detail.pid != null ? detail.pid : base.pid,
    argv:
      Array.isArray(detail.argv) && detail.argv.length
        ? detail.argv
        : Array.isArray(base.argv) && base.argv.length
          ? base.argv
          : detail.argv || base.argv || null,
  };
}

/**
 * Merge hc ls and hc get terminal records. Null/empty fields in either side never
 * wipe a value present on the other (fixes get agent:null overwriting ls agent:"env").
 */
function mergeTerminalEvidence(base, detail) {
  if (!detail) return base;
  if (!base) return detail;
  const labels = { ...(base.labels || {}), ...(detail.labels || {}) };
  return {
    ...base,
    ...detail,
    address: coalesceNonEmpty(detail.address, base.address),
    name: coalesceNonEmpty(detail.name, base.name),
    state: coalesceNonEmpty(detail.state, base.state),
    reason: coalesceNonEmpty(detail.reason, base.reason),
    exitCode: detail.exitCode != null ? detail.exitCode : base.exitCode,
    cwd: coalesceNonEmpty(detail.cwd, base.cwd),
    agent: coalesceNonEmpty(detail.agent, base.agent),
    argv:
      Array.isArray(detail.argv) && detail.argv.length
        ? detail.argv
        : Array.isArray(base.argv) && base.argv.length
          ? base.argv
          : detail.argv || base.argv || null,
    foreground: mergeForeground(base.foreground, detail.foreground),
    labels,
    afId: coalesceNonEmpty(detail.afId, base.afId) || labels.af_id || null,
    status: detail.status != null ? detail.status : base.status,
    statusMs: detail.statusMs != null ? detail.statusMs : base.statusMs,
    turn: detail.turn != null ? detail.turn : base.turn,
    reported: Boolean(detail.reported || base.reported),
  };
}

function isFinishedTerminal(t) {
  if (!t) return false;
  if (t.state === 'finished') return true;
  if (t.reason === 'exited' || t.reason === 'killed') {
    if (t.state === 'finished' || t.exitCode != null || t.reason) return true;
  }
  return false;
}

function isLiveTerminal(t) {
  if (!t) return false;
  if (isFinishedTerminal(t)) return false;
  if (t.state === 'live') return true;
  // "not finished" counts as live when state is present or omitted but not finished
  if (t.state && t.state !== 'finished') return true;
  if (!t.state && !t.reason) return true;
  return false;
}

function hasAfIdLabel(t) {
  return Boolean(t && t.afId);
}

/**
 * Default hc runner for production. Tests inject a stub via opts.runHc.
 * Uses AGENTFLEET_HC_BIN / resolveHcBin() — never hardcodes a bare PATH lookup only.
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error, timedOut?: boolean }}
 */
function defaultRunHc(argv, { timeoutMs, env } = {}) {
  const bin = resolveHcBin(env || process.env);
  try {
    const r = spawnSync(bin, argv, {
      encoding: 'utf8',
      timeout: timeoutMs || DEFAULT_TIMEOUT_MS,
    });
    if (r.error && r.error.code === 'ETIMEDOUT') {
      return {
        status: r.status,
        stdout: r.stdout || '',
        stderr: r.stderr || '',
        error: r.error,
        timedOut: true,
      };
    }
    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      error: r.error || null,
      timedOut: false,
    };
  } catch (err) {
    return { status: null, stdout: '', stderr: '', error: err, timedOut: false };
  }
}

/**
 * Fetch all Herdr terminals (`hc ls --all --json`), filling missing labels via
 * `hc get --json` when needed. Bounded by total timeoutMs.
 */
function fetchHerdrTerminals(opts = {}) {
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : DEFAULT_TIMEOUT_MS;
  const runHc = opts.runHc || defaultRunHc;
  const checkedAt = opts.now || nowIso();
  const started = Date.now();

  if (!opts.runHc && !hcOnPath(opts.env || process.env)) {
    return {
      ok: false,
      error: 'hc not found on PATH',
      terminals: [],
      checkedAt,
    };
  }

  const remaining = () => Math.max(50, timeoutMs - (Date.now() - started));

  const ls = runHc(['ls', '--all', '--json'], { timeoutMs: remaining() });
  if (ls.timedOut) {
    return { ok: false, error: 'hc ls timed out', terminals: [], checkedAt };
  }
  if (ls.error && ls.error.code === 'ENOENT') {
    return { ok: false, error: 'hc not found on PATH', terminals: [], checkedAt };
  }
  if (ls.status !== 0) {
    return {
      ok: false,
      error: `hc ls exited ${ls.status}${ls.stderr ? `: ${String(ls.stderr).trim()}` : ''}`,
      terminals: [],
      checkedAt,
    };
  }

  const parsed = parseHerdrTerminals(ls.stdout || '');
  if (!parsed) {
    return { ok: false, error: 'malformed hc ls JSON', terminals: [], checkedAt };
  }

  const terminals = parsed.slice();
  for (let i = 0; i < terminals.length; i++) {
    if (hasAfIdLabel(terminals[i])) continue;
    if (remaining() < 100) break;
    const key = terminals[i].address || terminals[i].name;
    if (!key) continue;
    const got = runHc(['get', '--json', key], { timeoutMs: remaining() });
    if (got.timedOut || got.status !== 0 || got.error) continue;
    const one = parseHerdrTerminals(got.stdout || '');
    // hc get returns a single object; parseHerdrTerminals expects list wrapper or array
    let detail = null;
    if (one && one.length === 1) {
      detail = one[0];
    } else {
      try {
        const obj = JSON.parse(got.stdout || '');
        if (obj && typeof obj === 'object' && !Array.isArray(obj) && (obj.address || obj.name || obj.labels)) {
          detail = normalizeTerminal(obj);
        }
      } catch (_) {
        /* ignore */
      }
    }
    if (detail) {
      terminals[i] = mergeTerminalEvidence(terminals[i], detail);
    }
  }

  return { ok: true, error: null, terminals, checkedAt };
}

function isHerdrInvolved(session, matches) {
  if (matches && matches.length > 0) return true;
  const h = session && session.herdr;
  if (!h || typeof h !== 'object') return false;
  if (h.checkedAt) return true;
  if (h.runtime && h.runtime !== '-') return true;
  return false;
}

/**
 * Pick the most recent finished terminal among matches. hc addresses are
 * t + hex (t19, t1b, t1c), so compare them numerically as hex; when they
 * aren't comparable, the later entry in hc's list order wins.
 */
function addressOrdinal(address) {
  const m = /^t([0-9a-f]+)$/i.exec(String(address || ''));
  return m ? parseInt(m[1], 16) : null;
}

function pickMostRecentFinished(finished) {
  if (!finished || finished.length === 0) return null;
  let best = finished[0];
  for (let i = 1; i < finished.length; i++) {
    const a = addressOrdinal(finished[i].address);
    const b = addressOrdinal(best.address);
    if (a == null || b == null || a >= b) best = finished[i];
  }
  return best;
}

function classifyOneTerminal(t, matches) {
  const agent = {
    status: t && t.status != null ? t.status : null,
    turn: t && t.turn != null ? t.turn : null,
    reported: Boolean(t && t.reported),
    agent: t && t.agent != null ? t.agent : null,
  };
  if (isFinishedTerminal(t)) {
    return {
      runtime: 'exited',
      address: t.address,
      name: t.name,
      exitCode: t.exitCode,
      reason: t.reason,
      matches,
      ...agent,
    };
  }
  if (isLiveTerminal(t)) {
    const runtime = isShellOnlyTerminal(t) ? 'shell' : 'running';
    return {
      runtime,
      address: t.address,
      name: t.name,
      exitCode: t.exitCode,
      reason: t.reason,
      matches,
      ...agent,
    };
  }
  return {
    runtime: 'unknown',
    address: t.address,
    name: t.name,
    exitCode: t.exitCode,
    reason: t.reason,
    matches,
    ...agent,
  };
}

/**
 * Classify one session against a successful terminal list.
 * Multiple terminals can share the same af_id (resume history). Prefer:
 * exactly one live → running; several live → unknown; none live but some
 * finished → exited (most recent finished).
 * @returns {{ runtime, address, name, exitCode, reason, matches }}
 */
function classifySession(session, terminals) {
  const matches = (terminals || []).filter((t) => t.afId && t.afId === session.id);

  if (matches.length === 0) {
    if (isHerdrInvolved(session, matches)) {
      return {
        runtime: 'missing',
        address: null,
        name: null,
        exitCode: null,
        reason: null,
        matches,
        status: null,
        turn: null,
        reported: false,
      };
    }
    return {
      runtime: '-',
      address: null,
      name: null,
      exitCode: null,
      reason: null,
      matches,
      status: null,
      turn: null,
      reported: false,
    };
  }

  if (matches.length === 1) {
    return classifyOneTerminal(matches[0], matches);
  }

  const live = matches.filter((t) => isLiveTerminal(t));
  const finished = matches.filter((t) => isFinishedTerminal(t));

  if (live.length === 1) {
    return classifyOneTerminal(live[0], matches);
  }
  if (live.length > 1) {
    return {
      runtime: 'unknown',
      address: null,
      name: null,
      exitCode: null,
      reason: null,
      matches,
      status: null,
      turn: null,
      reported: false,
    };
  }

  // No live matches: use most recent finished if any.
  if (finished.length > 0) {
    return classifyOneTerminal(pickMostRecentFinished(finished), matches);
  }

  return {
    runtime: 'unknown',
    address: null,
    name: null,
    exitCode: null,
    reason: null,
    matches,
    status: null,
    turn: null,
    reported: false,
  };
}

/**
 * Enrich sessions with live Herdr runtime. Read-only; never writes.
 * On query failure: herdr-involved → unknown; others → `-`.
 */
function enrichSessions(sessions, fetchResult) {
  const checkedAt = (fetchResult && fetchResult.checkedAt) || nowIso();
  if (!fetchResult || !fetchResult.ok) {
    return sessions.map((s) => {
      const involved = isHerdrInvolved(s, []);
      return {
        session: s,
        runtime: involved ? 'unknown' : '-',
        address: null,
        name: null,
        exitCode: null,
        reason: null,
        status: null,
        turn: null,
        reported: false,
        checkedAt,
        queryOk: false,
        persistable: false,
      };
    });
  }

  return sessions.map((s) => {
    const c = classifySession(s, fetchResult.terminals);
    const involved = isHerdrInvolved(s, c.matches);
    const persistable =
      involved ||
      c.runtime === 'running' ||
      c.runtime === 'shell' ||
      c.runtime === 'exited';
    // unknown is persistable only when query succeeded and session is herdr-involved
    const canPersist =
      persistable ||
      (c.runtime === 'unknown' && involved) ||
      (c.runtime === 'missing' && involved);
    return {
      session: s,
      runtime: c.runtime,
      address: c.address,
      name: c.name,
      exitCode: c.exitCode,
      reason: c.reason,
      status: c.status != null ? c.status : null,
      turn: c.turn != null ? c.turn : null,
      reported: Boolean(c.reported),
      agent: c.agent != null ? c.agent : null,
      checkedAt,
      queryOk: true,
      persistable: Boolean(canPersist && c.runtime !== '-'),
    };
  });
}

function herdrEvidence(enriched) {
  return {
    runtime: enriched.runtime,
    address: enriched.address,
    name: enriched.name,
    exitCode: enriched.exitCode,
    reason: enriched.reason,
    checkedAt: enriched.checkedAt,
  };
}

function displayRuntime(runtime) {
  return RUNTIMES.has(runtime) ? runtime : 'unknown';
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  RUNTIMES,
  HERDR_TEMPLATE_FILES,
  SHELL_AGENT_NAMES,
  resolveHcBin,
  hcOnPath,
  parseHerdrTerminals,
  normalizeTerminal,
  normalizeLabels,
  isFinishedTerminal,
  isLiveTerminal,
  isShellAgentName,
  shellAgentBasename,
  terminalProgramNames,
  isShellOnlyTerminal,
  coalesceNonEmpty,
  mergeTerminalEvidence,
  isHerdrInvolved,
  fetchHerdrTerminals,
  classifySession,
  enrichSessions,
  herdrEvidence,
  displayRuntime,
  defaultRunHc,
};
