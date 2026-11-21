'use strict';

/**
 * RUBRIC GUARD — fail when protected eval/scoring paths change.
 * changedFiles is injectable for hermetic tests (no real git required).
 */

const path = require('path');
const { spawnSync: defaultSpawnSync } = require('child_process');
const { PROTECTED_PATHS } = require('./rubric');

/**
 * Normalize a path relative to repo root (posix-style separators).
 * @param {string} file
 * @param {string} repoRoot
 */
function normalizeRelPath(file, repoRoot) {
  let p = String(file || '').replace(/\\/g, '/');
  const root = path.resolve(repoRoot).replace(/\\/g, '/').replace(/\/$/, '');
  if (path.isAbsolute(p) || p.startsWith('/')) {
    const abs = path.resolve(p).replace(/\\/g, '/');
    if (abs === root) return '';
    if (abs.startsWith(root + '/')) p = abs.slice(root.length + 1);
    else p = abs.replace(/^\//, '');
  }
  // Strip leading ./
  p = p.replace(/^\.\//, '');
  return p;
}

/**
 * Collect changed files via git when not injected.
 * Default: names of files that differ from base (HEAD) in the working tree
 * (staged + unstaged) plus untracked when supported.
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string} [opts.base] default 'HEAD'
 * @param {Function} [opts.spawnSync]
 * @returns {string[]}
 */
function collectChangedFilesFromGit(opts = {}) {
  const repoRoot = opts.repoRoot;
  const base = opts.base || 'HEAD';
  const spawn = opts.spawnSync || defaultSpawnSync;
  const files = new Set();

  const run = (args) => {
    const r = spawn('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      env: opts.env || process.env,
    });
    if (r.error) return '';
    if (r.status !== 0 && r.status != null) return String(r.stdout || '');
    return String(r.stdout || '');
  };

  // Diff vs base (committed tree)
  for (const line of run(['diff', '--name-only', base]).split('\n')) {
    const t = line.trim();
    if (t) files.add(t);
  }
  // Staged vs base
  for (const line of run(['diff', '--name-only', '--cached', base]).split('\n')) {
    const t = line.trim();
    if (t) files.add(t);
  }
  // Untracked (optional; ignore errors)
  for (const line of run(['ls-files', '--others', '--exclude-standard']).split('\n')) {
    const t = line.trim();
    if (t) files.add(t);
  }

  return [...files];
}

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.base]
 * @param {string[]} [opts.changedFiles] injectable list (relative or absolute)
 * @param {string[]} [opts.protectedPaths] override PROTECTED_PATHS
 * @param {Function} [opts.spawnSync]
 * @returns {{ ok: boolean, violations: string[], protectedPaths: string[], changedFiles: string[] }}
 */
function gate(opts = {}) {
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const protectedPaths = (opts.protectedPaths || PROTECTED_PATHS).map((p) =>
    normalizeRelPath(p, repoRoot)
  );

  let changed =
    opts.changedFiles != null
      ? opts.changedFiles
      : collectChangedFilesFromGit({
          repoRoot,
          base: opts.base,
          spawnSync: opts.spawnSync,
          env: opts.env,
        });

  const changedNorm = changed
    .map((f) => normalizeRelPath(f, repoRoot))
    .filter(Boolean);

  const protectedSet = new Set(protectedPaths);
  const violations = changedNorm.filter((f) => protectedSet.has(f));

  return {
    ok: violations.length === 0,
    violations,
    protectedPaths,
    changedFiles: changedNorm,
  };
}

module.exports = {
  gate,
  normalizeRelPath,
  collectChangedFilesFromGit,
  PROTECTED_PATHS,
};
