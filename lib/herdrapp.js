'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { which, homeDir } = require('./util');

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Strip trailing slash/sep except for filesystem root. */
function stripTrailingSep(p) {
  let s = String(p);
  if (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) {
    s = s.replace(/[/\\]+$/, '');
  }
  return s;
}

/**
 * Normalize cwd for space id: realpath when the path exists, else resolve;
 * trailing slash stripped.
 */
function normalizeCwd(cwd) {
  const raw = cwd == null || cwd === '' ? process.cwd() : String(cwd);
  let resolved;
  try {
    if (fs.existsSync(raw)) {
      resolved = fs.realpathSync(raw);
    } else {
      resolved = path.resolve(raw);
    }
  } catch (_) {
    resolved = path.resolve(raw);
  }
  return stripTrailingSep(resolved);
}

function md5hex(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

/** Stable Herdr-app space id for a cwd: sp + 32 lowercase hex. */
function herdrSpaceId(cwd) {
  return 'sp' + md5hex('agentfleet:space:' + normalizeCwd(cwd));
}

/**
 * Stable Herdr-app tab id for an af session: tb + 32 lowercase hex.
 * Prefers session.id; falls back to title.
 */
function herdrTabId(session) {
  const key =
    session && session.id != null && String(session.id) !== ''
      ? String(session.id)
      : session && session.title != null
        ? String(session.title)
        : '';
  return 'tb' + md5hex('agentfleet:tab:' + key);
}

/** Labels that make a core terminal appear in the Herdr desktop app. */
function herdrAppLabels(session) {
  return [
    `herdr.space=${herdrSpaceId(session && session.cwd)}`,
    `herdr.tab=${herdrTabId(session)}`,
  ];
}

/**
 * Herdr-app labeling is on by default.
 * Disabled by --no-herdr-app, or AGENTFLEET_HERDR_APP=0|false|off|no.
 */
function herdrAppEnabled(flags = {}, env = process.env) {
  if (flags && (flags['no-herdr-app'] || flags.noHerdrApp)) return false;
  if (flags && flags.herdrApp === false) return false;
  const v = env && env.AGENTFLEET_HERDR_APP;
  if (v != null && String(v) !== '') {
    if (OFF_VALUES.has(String(v).toLowerCase().trim())) return false;
  }
  return true;
}

function resolveHerdrAppBin(env = process.env) {
  if (env && env.AGENTFLEET_HERDR_APP_BIN) return env.AGENTFLEET_HERDR_APP_BIN;
  const found = which('herdr-app');
  if (found) return found;
  const fallback = path.join(homeDir(), '.local', 'bin', 'herdr-app');
  try {
    if (fs.existsSync(fallback)) return fallback;
  } catch (_) {
    /* ignore */
  }
  return 'herdr-app';
}

function defaultRunApp(argv, { bin, env } = {}) {
  const app = bin || resolveHerdrAppBin(env || process.env);
  try {
    const r = spawnSync(app, argv, { encoding: 'utf8' });
    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      error: r.error || null,
    };
  } catch (err) {
    return { status: null, stdout: '', stderr: '', error: err };
  }
}

function defaultSleep(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n <= 0) return;
  try {
    // Atomics.wait is a sync sleep when available (Node worker / main on many builds).
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, n);
  } catch (_) {
    const end = Date.now() + n;
    while (Date.now() < end) {
      /* spin — only used when Atomics.wait unavailable; tests inject sleep */
    }
  }
}

/**
 * Best-effort rename of a Herdr-app tab. Never throws.
 * Checks `herdr-app status`, then retries tab.rename for up to ~3s.
 * @returns {{ ok: boolean, reason: string|null }}
 */
function nameHerdrAppTab(tabId, name, opts = {}) {
  const runApp = opts.runApp || defaultRunApp;
  const sleep = opts.sleep || defaultSleep;
  const envWait = process.env.AF_HERDR_APP_RENAME_WAIT_MS;
  const maxWaitMs =
    opts.maxWaitMs != null
      ? opts.maxWaitMs
      : envWait != null && envWait !== ''
        ? Number(envWait)
        : 3000;
  const intervalMs = opts.intervalMs != null ? opts.intervalMs : 500;

  try {
    if (!tabId) return { ok: false, reason: 'missing tab id' };
    const st = runApp(['status']);
    if (!st || st.status !== 0) {
      return { ok: false, reason: 'app not running' };
    }

    const attempts = Math.max(1, Math.floor(maxWaitMs / intervalMs) + 1);
    let reason = 'rename failed';
    for (let i = 0; i < attempts; i++) {
      if (i > 0) sleep(intervalMs);
      try {
        const r = runApp(['do', 'tab.rename', '--id', String(tabId), '--name', String(name)]);
        if (r && r.status === 0) return { ok: true, reason: null };
        const msg = r && (r.stderr || r.stdout) ? String(r.stderr || r.stdout).trim() : '';
        reason = msg || (r && r.error && r.error.message) || `exit ${r && r.status}`;
      } catch (err) {
        reason = err && err.message ? err.message : String(err);
      }
    }
    return { ok: false, reason };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

/** Same sanitization as backends.sanitizeHerdrName (kept local to avoid require cycles). */
function sanitizeName(title) {
  return (
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 32)
      .replace(/[-_]+$/g, '') || 'agent'
  );
}

function isLiveLike(t) {
  if (!t) return false;
  if (t.state === 'finished') return false;
  if (t.reason === 'exited' || t.reason === 'killed') {
    if (t.state === 'finished' || t.exitCode != null) return false;
  }
  if (t.state === 'live') return true;
  if (t.state && t.state !== 'finished') return true;
  if (!t.state && !t.reason) return true;
  return false;
}

/**
 * Match a live Herdr terminal to a tracked af session by af_id label or name.
 */
function matchSessionForTerminal(terminal, sessions) {
  if (!terminal || !sessions || !sessions.length) return null;
  const afId =
    terminal.afId ||
    (terminal.labels && (terminal.labels.af_id || terminal.labels.afId)) ||
    null;
  if (afId) {
    const byId = sessions.find((s) => s && s.id === afId);
    if (byId) return byId;
  }
  const name = terminal.name || null;
  if (name) {
    for (const s of sessions) {
      if (!s) continue;
      if (sanitizeName(s.title) === name) return s;
      if (terminal.labels && terminal.labels.title && terminal.labels.title === s.title) return s;
    }
  }
  return null;
}

/**
 * Plan adoption of live af Herdr terminals into the desktop app.
 * Pure: matches terminals to the given session pool; returns exact hc argv.
 * Caller selects the session pool (--all vs title/id queries).
 *
 * @param {object[]} sessions tracked af sessions to consider
 * @param {object[]} terminals from fetchHerdrTerminals (normalized)
 * @returns {{ ok: boolean, items: object[] }}
 */
function planAdopt(sessions, terminals) {
  const pool = sessions || [];
  const items = [];
  for (const t of terminals || []) {
    if (!isLiveLike(t)) continue;
    const session = matchSessionForTerminal(t, pool);
    if (!session) continue;

    const spaceId = herdrSpaceId(session.cwd);
    const tabId = herdrTabId(session);
    const labels = t.labels || {};
    const already =
      labels['herdr.space'] === spaceId && labels['herdr.tab'] === tabId;
    const address = t.address || t.name;
    if (!address) continue;

    items.push({
      title: session.title,
      id: session.id,
      address,
      name: t.name || null,
      spaceId,
      tabId,
      alreadyAdopted: already,
      labelArgv: ['label', address, `herdr.space=${spaceId}`, `herdr.tab=${tabId}`],
      keepArgv: ['keep', address],
    });
  }

  return { ok: true, items };
}

module.exports = {
  normalizeCwd,
  herdrSpaceId,
  herdrTabId,
  herdrAppLabels,
  herdrAppEnabled,
  resolveHerdrAppBin,
  nameHerdrAppTab,
  planAdopt,
  matchSessionForTerminal,
  defaultRunApp,
  defaultSleep,
};
