'use strict';

/**
 * Project name derivation for session grouping (`session.project`).
 *
 * A project never requires git — one-off agents in /tmp or $HOME can share a
 * name via `--project`, `AFLT_PROJECT`, or global config.
 *
 * NEW sessions (resolveProjectForCreate) — store the result on the row:
 *   1. `--project` flag
 *   2. parent/master's project (stored, else cwd-derived for that parent)
 *   3. `AFLT_PROJECT` env
 *   4. `.agentfleet.json` `"project"` (cwd → ancestors until git root / fs root)
 *   5. `$AGENTFLEET_HOME/config.json` `"project"`
 *   6. git root basename
 *   7. cwd basename — except $HOME, os.tmpdir() (+ realpath), /tmp, /private/tmp
 *      → `"adhoc"`
 *
 * EXISTING rows without stored `project` (resolveProjectName read path):
 *   stored project → `.agentfleet.json` → git basename → cwd basename / adhoc.
 *   Never use env or global config; never rewrite the registry to backfill.
 *
 * Git-root lookups are cached per cwd for one `createLookupCache()` (one command).
 * Missing cwd must not throw.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const messages = require('./messages');
const config = require('./config');
const { homeDir, envNonEmpty } = require('./util');

const ADHOC_NAME = 'adhoc';

/**
 * Legacy project names → canonical display / grouping / memory-folder names.
 * Registry rows are never rewritten; aliases apply at read/group time only.
 */
const PROJECT_ALIASES = Object.freeze({
  af: 'aflt',
});

/**
 * Map a legacy alias to its canonical project name (e.g. `af` → `aflt`).
 * Unknown / empty names pass through unchanged.
 * @param {unknown} name
 * @returns {string|null|undefined}
 */
function canonicalProjectName(name) {
  if (name == null) return name;
  const s = String(name).trim();
  if (!s) return s;
  return PROJECT_ALIASES[s] || s;
}

/**
 * @returns {{ gitRoot: Map<string, string|null>, projectConfig: Map<string, string|null> }}
 */
function createLookupCache() {
  return {
    gitRoot: new Map(),
    projectConfig: new Map(),
  };
}

function safeResolve(p) {
  try {
    return path.resolve(String(p || ''));
  } catch (_) {
    return null;
  }
}

function safeRealpath(p) {
  const resolved = safeResolve(p);
  if (!resolved) return null;
  try {
    if (fs.existsSync(resolved)) return fs.realpathSync(resolved);
  } catch (_) {
    /* ignore */
  }
  return resolved;
}

/**
 * Best-effort git toplevel for cwd. Returns null when missing/not-git.
 * Never throws.
 * @param {string} cwd
 * @param {{ gitRoot?: Map<string, string|null> }} [cache]
 */
function gitRootForCwd(cwd, cache) {
  const key = safeResolve(cwd);
  if (!key) return null;
  const map = cache && cache.gitRoot;
  if (map && map.has(key)) return map.get(key);

  let result = null;
  try {
    if (!fs.existsSync(key)) {
      result = null;
    } else {
      const r = spawnSync('git', ['-C', key, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
        timeout: 5000,
      });
      if (r.status === 0) {
        const root = String(r.stdout || '').trim();
        if (root) result = path.resolve(root);
      }
    }
  } catch (_) {
    result = null;
  }
  if (map) map.set(key, result);
  return result;
}

/**
 * Read `.agentfleet.json` "project" for a cwd (ancestor walk). Never throws.
 * @param {string} cwd
 * @param {{ projectConfig?: Map<string, string|null> }} [cache]
 */
function projectFromConfig(cwd, cache) {
  const key = safeResolve(cwd);
  if (!key) return null;
  const map = cache && cache.projectConfig;
  if (map && map.has(key)) return map.get(key);

  let name = null;
  try {
    const hit = messages.findProjectConfig(key, { key: 'project' });
    if (hit && hit.data && typeof hit.data.project === 'string') {
      const trimmed = hit.data.project.trim();
      if (trimmed) name = trimmed;
    }
  } catch (_) {
    name = null;
  }
  if (map) map.set(key, name);
  return name;
}

/**
 * Global `$AGENTFLEET_HOME/config.json` `"project"`. Never throws.
 * @returns {string|null}
 */
function projectFromGlobalConfig() {
  try {
    const data = config.load();
    if (data && typeof data.project === 'string') {
      const trimmed = data.project.trim();
      if (trimmed) return trimmed;
    }
  } catch (_) {
    /* ignore */
  }
  return null;
}

/**
 * `AFLT_PROJECT` env (create-time only).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string|null}
 */
function projectFromEnv(env = process.env) {
  return envNonEmpty(env, 'AFLT_PROJECT');
}

/**
 * True when cwd is $HOME, os.tmpdir() (and realpath), /tmp, or /private/tmp.
 * Never throws.
 * @param {string} cwd
 */
function isAdhocCwd(cwd) {
  const resolved = safeRealpath(cwd);
  if (!resolved) return false;
  const adhocPaths = new Set();
  const add = (p) => {
    const r = safeRealpath(p);
    if (r) adhocPaths.add(r);
  };
  add(homeDir());
  add(os.homedir());
  add(os.tmpdir());
  add('/tmp');
  add('/private/tmp');
  // Literal tmpdir string even when realpath differs
  try {
    adhocPaths.add(path.resolve(os.tmpdir()));
  } catch (_) {
    /* ignore */
  }
  return adhocPaths.has(resolved);
}

/**
 * Basename fallback; adhoc for HOME/tmpdir. Never throws.
 * @param {string} cwd
 */
function cwdBasenameOrAdhoc(cwd) {
  if (isAdhocCwd(cwd)) return ADHOC_NAME;
  try {
    const resolved = path.resolve(String(cwd || process.cwd() || '.'));
    const base = path.basename(resolved);
    return base || ADHOC_NAME;
  } catch (_) {
    return ADHOC_NAME;
  }
}

/** @deprecated use cwdBasenameOrAdhoc */
function cwdBasename(cwd) {
  return cwdBasenameOrAdhoc(cwd);
}

/**
 * Cwd-based derivation only (read path / parent fallback).
 * Never uses env or global config.
 *
 * @param {string} cwd
 * @param {ReturnType<typeof createLookupCache>} cache
 * @returns {string}
 */
function deriveFromCwd(cwd, cache) {
  const fromCfg = projectFromConfig(cwd, cache);
  if (fromCfg) return fromCfg;

  const root = gitRootForCwd(cwd, cache);
  if (root) {
    const base = path.basename(root);
    if (base) return base;
  }
  return cwdBasenameOrAdhoc(cwd);
}

/**
 * Effective project for a session or cwd (read / list / timeline).
 * Prefer stored `session.project`; else cwd-based rules only.
 *
 * @param {object|string|null} sessionOrCwd
 * @param {{ cache?: ReturnType<typeof createLookupCache>, preferStored?: boolean }} [opts]
 * @returns {string}
 */
function resolveProjectName(sessionOrCwd, opts = {}) {
  const cache = opts.cache || createLookupCache();
  const preferStored = opts.preferStored !== false;

  let cwd = null;
  if (sessionOrCwd != null && typeof sessionOrCwd === 'object' && !Array.isArray(sessionOrCwd)) {
    const session = sessionOrCwd;
    cwd = session.cwd != null ? session.cwd : process.cwd();
    if (preferStored && session.project != null && String(session.project).trim() !== '') {
      return canonicalProjectName(String(session.project).trim());
    }
  } else if (typeof sessionOrCwd === 'string') {
    cwd = sessionOrCwd;
  } else {
    cwd = process.cwd();
  }

  return canonicalProjectName(deriveFromCwd(cwd, cache));
}

/**
 * Project name to store on a newly created session row.
 *
 * @param {{
 *   flag?: string|null,
 *   parent?: object|null,
 *   cwd?: string,
 *   cache?: ReturnType<typeof createLookupCache>,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 * @returns {string}
 */
function resolveProjectForCreate(opts = {}) {
  const cache = opts.cache || createLookupCache();
  const env = opts.env || process.env;

  if (opts.flag != null && String(opts.flag).trim() !== '' && opts.flag !== true) {
    return canonicalProjectName(String(opts.flag).trim());
  }

  if (opts.parent) {
    // Inherit parent's stored or cwd-derived name (never env/global for the parent look-up).
    return resolveProjectName(opts.parent, { cache });
  }

  const fromEnv = projectFromEnv(env);
  if (fromEnv) return canonicalProjectName(fromEnv);

  const cwd = opts.cwd != null ? opts.cwd : process.cwd();

  const fromAgentfleet = projectFromConfig(cwd, cache);
  if (fromAgentfleet) return canonicalProjectName(fromAgentfleet);

  const fromGlobal = projectFromGlobalConfig();
  if (fromGlobal) return canonicalProjectName(fromGlobal);

  const root = gitRootForCwd(cwd, cache);
  if (root) {
    const base = path.basename(root);
    if (base) return canonicalProjectName(base);
  }
  return canonicalProjectName(cwdBasenameOrAdhoc(cwd));
}

/**
 * Normalize a project filter string for comparison (trim; empty → null).
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeProjectFilter(raw) {
  if (raw == null || raw === true || raw === false) return null;
  const s = String(raw).trim();
  if (!s) return null;
  return canonicalProjectName(s);
}

module.exports = {
  ADHOC_NAME,
  PROJECT_ALIASES,
  canonicalProjectName,
  createLookupCache,
  gitRootForCwd,
  projectFromConfig,
  projectFromGlobalConfig,
  projectFromEnv,
  isAdhocCwd,
  cwdBasename,
  cwdBasenameOrAdhoc,
  deriveFromCwd,
  resolveProjectName,
  resolveProjectForCreate,
  normalizeProjectFilter,
};
