'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

/** True when Cursor left an unresolved `${env:NAME}` literal (treat as unset). */
function isUnresolvedEnvInterpolation(value) {
  const s = String(value == null ? '' : value).trim();
  return /^\$\{env:[^}]*\}$/.test(s);
}

/**
 * Non-empty trimmed env value, or null.
 * Empty string / whitespace / unresolved `${env:…}` literals count as unset.
 */
function envNonEmpty(env, key) {
  if (!env || key == null) return null;
  const raw = env[key];
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '' || isUnresolvedEnvInterpolation(s)) return null;
  return s;
}

function homeDir() {
  return (
    envNonEmpty(process.env, 'HOME') ||
    envNonEmpty(process.env, 'USERPROFILE') ||
    os.homedir()
  );
}

function fleetDir() {
  return envNonEmpty(process.env, 'AGENTFLEET_HOME') || path.join(homeDir(), '.agentfleet');
}

function registryPath() {
  return envNonEmpty(process.env, 'AGENTFLEET_REGISTRY') || path.join(fleetDir(), 'sessions.json');
}

function nowIso() {
  return new Date().toISOString();
}

function shortId(id) {
  if (!id) return '';
  return String(id).slice(0, 8);
}

/**
 * Table display for af ids (`<slug>-<hex6>`). Prefer keeping the trailing
 * `-hex6` so siblings that share a slug prefix stay distinguishable within
 * `width` (default 16). Example: `hello-af-w1-250815` → `hello-af…-250815`.
 */
function displayId(id, width = 16) {
  const s = String(id || '');
  const w = Math.max(8, Number(width) || 16);
  if (!s) return '';
  if (s.length <= w) return s;
  const m = s.match(/-([0-9a-f]{6})$/i);
  if (m) {
    const suffix = `-${m[1]}`;
    const budget = w - suffix.length;
    if (budget <= 0) return s.slice(-w);
    const slug = s.slice(0, s.length - suffix.length);
    if (slug.length <= budget) return slug + suffix;
    if (budget === 1) return `…${suffix}`.slice(-w);
    return `${slug.slice(0, budget - 1)}…${suffix}`;
  }
  return s.slice(0, w - 1) + '…';
}

function slugify(title) {
  return String(title)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'session';
}

function makeId(title) {
  const slug = slugify(title);
  const suffix = crypto.randomBytes(3).toString('hex');
  return `${slug}-${suffix}`;
}

/** Expand a leading `~` / `~/…` to the user home directory. */
function expandUserPath(p) {
  const s = String(p == null ? '' : p);
  if (s === '~') return homeDir();
  if (s.startsWith('~/') || s.startsWith('~' + path.sep)) {
    return path.join(homeDir(), s.slice(2));
  }
  return s;
}

/**
 * Resolve a cwd for registration/filters: expand ~, realpath when the path
 * exists, otherwise path.resolve. Trailing separators stripped (except root).
 */
function resolveCwd(cwd) {
  const raw = expandUserPath(cwd || process.cwd());
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
  if (resolved.length > 1 && (resolved.endsWith('/') || resolved.endsWith('\\'))) {
    resolved = resolved.replace(/[/\\]+$/, '');
  }
  return resolved;
}

function gitBranch(cwd) {
  try {
    const r = spawnSync('git', ['-C', cwd, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0) return (r.stdout || '').trim() || null;
  } catch (_) {
    /* ignore */
  }
  return null;
}

function which(cmd) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
  });
  if (r.status === 0) return (r.stdout || '').trim().split('\n')[0];
  return null;
}

function escapeShellArg(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function oscTitle(title) {
  // OSC 0 ; title BEL — widely supported (iTerm2, WezTerm, most terminals)
  return `\x1b]0;${String(title).replace(/[\x00-\x1f]/g, '')}\x07`;
}

function parseArgs(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next && !next.startsWith('-')) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a.slice(1);
      const next = argv[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      args.push(a);
    }
  }
  return { args, flags };
}

function pad(s, n) {
  s = String(s ?? '');
  if (s.length > n) return s.slice(0, n - 1) + '…';
  return s + ' '.repeat(n - s.length);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  envNonEmpty,
  isUnresolvedEnvInterpolation,
  homeDir,
  fleetDir,
  registryPath,
  nowIso,
  shortId,
  displayId,
  slugify,
  makeId,
  expandUserPath,
  resolveCwd,
  gitBranch,
  which,
  escapeShellArg,
  oscTitle,
  parseArgs,
  pad,
  sleep,
};
