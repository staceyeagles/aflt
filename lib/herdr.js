'use strict';

const { spawnSync } = require('child_process');
const { which, nowIso } = require('./util');

const DEFAULT_TIMEOUT_MS = 7000;
const RUNTIMES = new Set(['running', 'exited', 'missing', 'unknown', '-']);

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
  return {
    address: t.address || null,
    name: t.name || null,
    state: t.state != null ? String(t.state) : null,
    reason: t.reason != null ? String(t.reason) : null,
    exitCode: exitCode,
    cwd: t.cwd || null,
    labels,
    afId: labels.af_id || null,
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
 * @returns {{ status: number|null, stdout: string, stderr: string, error?: Error, timedOut?: boolean }}
 */
function defaultRunHc(argv, { timeoutMs } = {}) {
  try {
    const r = spawnSync('hc', argv, {
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

  if (!opts.runHc && !which('hc')) {
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
      terminals[i] = {
        ...terminals[i],
        ...detail,
        address: detail.address || terminals[i].address,
        name: detail.name || terminals[i].name,
        labels: { ...terminals[i].labels, ...detail.labels },
        afId: detail.afId || terminals[i].afId,
      };
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
  if (isFinishedTerminal(t)) {
    return {
      runtime: 'exited',
      address: t.address,
      name: t.name,
      exitCode: t.exitCode,
      reason: t.reason,
      matches,
    };
  }
  if (isLiveTerminal(t)) {
    return {
      runtime: 'running',
      address: t.address,
      name: t.name,
      exitCode: t.exitCode,
      reason: t.reason,
      matches,
    };
  }
  return {
    runtime: 'unknown',
    address: t.address,
    name: t.name,
    exitCode: t.exitCode,
    reason: t.reason,
    matches,
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
      };
    }
    return {
      runtime: '-',
      address: null,
      name: null,
      exitCode: null,
      reason: null,
      matches,
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
        checkedAt,
        queryOk: false,
        persistable: false,
      };
    });
  }

  return sessions.map((s) => {
    const c = classifySession(s, fetchResult.terminals);
    const involved = isHerdrInvolved(s, c.matches);
    const persistable = involved || c.runtime === 'running' || c.runtime === 'exited';
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
  parseHerdrTerminals,
  normalizeTerminal,
  normalizeLabels,
  isFinishedTerminal,
  isLiveTerminal,
  isHerdrInvolved,
  fetchHerdrTerminals,
  classifySession,
  enrichSessions,
  herdrEvidence,
  displayRuntime,
  defaultRunHc,
};
