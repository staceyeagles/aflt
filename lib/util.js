'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

function homeDir() {
  return process.env.HOME || process.env.USERPROFILE || os.homedir();
}

function fleetDir() {
  return process.env.AGENTFLEET_HOME || path.join(homeDir(), '.agentfleet');
}

function registryPath() {
  return process.env.AGENTFLEET_REGISTRY || path.join(fleetDir(), 'sessions.json');
}

function nowIso() {
  return new Date().toISOString();
}

function shortId(id) {
  if (!id) return '';
  return String(id).slice(0, 8);
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

function resolveCwd(cwd) {
  const raw = cwd || process.cwd();
  return path.resolve(raw);
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

module.exports = {
  homeDir,
  fleetDir,
  registryPath,
  nowIso,
  shortId,
  slugify,
  makeId,
  resolveCwd,
  gitBranch,
  which,
  escapeShellArg,
  oscTitle,
  parseArgs,
  pad,
};
