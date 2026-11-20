'use strict';

/**
 * Project ↔ repository metadata (issue #1).
 *
 * Memory:  <memoryRepo>/<folder>/.agentfleet.json
 * Source:  checkout .agentfleet.json "project" / "projectId" (launch default)
 * Local:   ~/.agentfleet/config.json "repositories" → checkout paths
 *
 * Never rewrites registry session.project. Inference only when unambiguous.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const messages = require('./messages');
const projectLib = require('./project');
const { expandUserPath, homeDir } = require('./util');

const AGENTFLEET_JSON = '.agentfleet.json';

/** Lazy to avoid circular init with lib/memory.js ↔ lib/project.js. */
function memoryLib() {
  return require('./memory');
}

/**
 * Normalize a git remote URL / SCP-ish form to `host/owner/repo` (no .git).
 * @param {unknown} raw
 * @returns {string|null}
 */
function normalizeRemote(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (!s) return null;
  // file:// or absolute local paths — keep as resolved path key
  if (s.startsWith('/') || s.startsWith('file://')) {
    try {
      const p = s.startsWith('file://') ? s.replace(/^file:\/\//, '') : s;
      return path.resolve(expandUserPath(p));
    } catch (_) {
      return s;
    }
  }
  // git@host:owner/repo.git
  const scp = s.match(/^[^@\s]+@([^:]+):(.+)$/);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    // protocol://user@host/path
    s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
    s = s.replace(/^[^/@]+@/, '');
  }
  s = s.replace(/\.git$/i, '');
  s = s.replace(/\/+$/, '');
  // lowercase host only
  const slash = s.indexOf('/');
  if (slash === -1) return s.toLowerCase() || null;
  const host = s.slice(0, slash).toLowerCase();
  const rest = s.slice(slash + 1).replace(/^\/+/, '');
  if (!host || !rest) return null;
  return `${host}/${rest}`;
}

/**
 * @param {unknown} entry
 * @returns {string[]}
 */
function remotesFromRepoEntry(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
  const out = [];
  const push = (v) => {
    if (Array.isArray(v)) {
      for (const x of v) {
        const n = normalizeRemote(x);
        if (n) out.push(n);
      }
    } else if (v != null) {
      const n = normalizeRemote(v);
      if (n) out.push(n);
    }
  };
  push(entry.remote);
  push(entry.url);
  push(entry.remotes);
  push(entry.urls);
  return [...new Set(out)];
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeLocations(raw) {
  if (raw == null) return ['.'];
  const list = Array.isArray(raw) ? raw : [raw];
  const out = [];
  for (const item of list) {
    let s = String(item == null ? '' : item).trim().replace(/\\/g, '/');
    if (!s) continue;
    s = s.replace(/^\.\//, '');
    if (s === '') s = '.';
    // reject absolute / traversal
    if (path.isAbsolute(s) || s.startsWith('/') || s.split('/').includes('..')) continue;
    out.push(s);
  }
  return out.length ? [...new Set(out)] : ['.'];
}

/**
 * Parse one memory-side (or inline) project metadata object.
 * @param {object|null} data
 * @param {{ folder?: string, configPath?: string|null }} [opts]
 * @returns {object|null}
 */
function parseMemoryProjectConfig(data, opts = {}) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const folder = opts.folder != null ? String(opts.folder) : null;
  let id = null;
  if (typeof data.id === 'string' && data.id.trim()) id = data.id.trim();
  else if (typeof data.project === 'string' && data.project.trim()) id = data.project.trim();
  else if (folder) id = folder;
  if (!id) return null;
  id = projectLib.canonicalProjectName(id);

  const name =
    typeof data.name === 'string' && data.name.trim() ? data.name.trim() : null;

  const repositories = [];
  const problems = [];
  const repoEntries = Array.isArray(data.repositories) ? data.repositories : [];
  for (let i = 0; i < repoEntries.length; i++) {
    const entry = repoEntries[i];
    const remotes = remotesFromRepoEntry(entry);
    if (!remotes.length) {
      problems.push({
        code: 'invalid-repository',
        message: `repositories[${i}] missing remote/url`,
      });
      continue;
    }
    const locations = normalizeLocations(entry && entry.locations);
    const repoId =
      entry && typeof entry.id === 'string' && entry.id.trim()
        ? entry.id.trim()
        : remotes[0];
    repositories.push({
      id: repoId,
      remotes,
      remote: remotes[0],
      locations,
    });
  }

  const relationships = [];
  if (Array.isArray(data.relationships)) {
    for (const rel of data.relationships) {
      if (!rel || typeof rel !== 'object') continue;
      const project =
        typeof rel.project === 'string' && rel.project.trim()
          ? projectLib.canonicalProjectName(rel.project.trim())
          : null;
      if (!project) continue;
      relationships.push({
        type: typeof rel.type === 'string' && rel.type.trim() ? rel.type.trim() : 'related',
        project,
      });
    }
  }

  return {
    id,
    name,
    folder: folder || id,
    configPath: opts.configPath || null,
    repositories,
    relationships,
    problems,
    hasExplicitMeta: Boolean(
      data.id != null ||
        data.repositories != null ||
        data.relationships != null ||
        (typeof data.project === 'string' && data.project.trim())
    ),
  };
}

/**
 * Read JSON object from path; null on missing/corrupt.
 * @param {string} filePath
 * @returns {object|null}
 */
function readJsonObject(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/**
 * Load all memory project metadata folders.
 * @param {string|null} memoryRepo
 * @returns {{ projects: object[], errors: string[], memoryRepo: string|null }}
 */
function loadMemoryProjectMeta(memoryRepo) {
  const result = { projects: [], errors: [], memoryRepo: memoryRepo || null };
  if (!memoryRepo) return result;
  let root;
  let folders;
  try {
    root = fs.realpathSync(memoryRepo);
    folders = fs
      .readdirSync(root, { withFileTypes: true })
      .filter(
        (e) =>
          !e.name.startsWith('.') && (e.isDirectory() || e.isSymbolicLink())
      )
      .map((e) => e.name)
      .sort();
  } catch (err) {
    result.errors.push(`Cannot read memory repo (${err.code || err.message})`);
    return result;
  }

  const byId = new Map();
  for (const folder of folders) {
    const cfgPath = path.join(root, folder, AGENTFLEET_JSON);
    const data = readJsonObject(cfgPath);
    let parsed;
    if (data) {
      parsed = parseMemoryProjectConfig(data, { folder, configPath: cfgPath });
      if (!parsed) {
        result.errors.push(`${folder}: invalid ${AGENTFLEET_JSON}`);
        continue;
      }
    } else {
      // Folder-only project (no metadata file) — still listable
      parsed = parseMemoryProjectConfig({ project: folder }, { folder, configPath: null });
    }
    if (!parsed) continue;
    const canonFolder = projectLib.canonicalProjectName(folder);
    if (canonFolder !== folder && folders.includes(canonFolder)) {
      // Prefer canonical folder when both af/ and aflt/ exist
      continue;
    }
    if (byId.has(parsed.id)) {
      parsed.problems.push({
        code: 'duplicate-id',
        message: `project id ${parsed.id} also used by folder ${byId.get(parsed.id).folder}`,
      });
      byId.get(parsed.id).problems.push({
        code: 'duplicate-id',
        message: `project id ${parsed.id} also used by folder ${parsed.folder}`,
      });
    }
    byId.set(parsed.id, parsed);
    result.projects.push(parsed);
  }
  return result;
}

/**
 * Local checkout map from config.json.
 * @param {object} [cfg]
 * @returns {Map<string, { path: string, remote: string }>}
 */
function loadLocalRepositoryMap(cfg) {
  const data = cfg && typeof cfg === 'object' ? cfg : config.load();
  const map = new Map();
  const raw = data && data.repositories;
  if (!raw) return map;

  const add = (remoteKey, pathVal) => {
    const remote = normalizeRemote(remoteKey);
    if (!remote) return;
    let p = null;
    if (typeof pathVal === 'string') p = pathVal.trim();
    else if (pathVal && typeof pathVal === 'object' && typeof pathVal.path === 'string') {
      p = pathVal.path.trim();
    }
    if (!p) return;
    map.set(remote, { remote, path: expandUserPath(p) });
  };

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const remotes = remotesFromRepoEntry(entry);
      for (const r of remotes) add(r, entry);
    }
  } else if (typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw)) add(k, v);
  }
  return map;
}

/**
 * @param {string} checkoutPath
 * @returns {'ok'|'unavailable'|'unmapped'}
 */
function checkoutStatus(checkoutPath) {
  if (!checkoutPath) return 'unmapped';
  try {
    if (fs.existsSync(checkoutPath) && fs.statSync(checkoutPath).isDirectory()) {
      return 'ok';
    }
  } catch (_) {
    /* ignore */
  }
  return 'unavailable';
}

/**
 * Git remotes for a working tree. Never throws.
 * @param {string} cwdOrRoot
 * @param {object} [cache]
 * @returns {string[]} normalized remotes
 */
function gitRemotesForCwd(cwdOrRoot, cache) {
  const root = projectLib.gitRootForCwd(cwdOrRoot, cache);
  if (!root) return [];
  const map = cache && cache.gitRemotes;
  if (map && map.has(root)) return map.get(root);
  let remotes = [];
  try {
    const r = spawnSync('git', ['-C', root, 'remote', '-v'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    if (r.status === 0) {
      const seen = new Set();
      for (const line of String(r.stdout || '').split(/\r?\n/)) {
        const m = line.match(/^\S+\s+(\S+)/);
        if (!m) continue;
        const n = normalizeRemote(m[1]);
        if (n && !seen.has(n)) {
          seen.add(n);
          remotes.push(n);
        }
      }
    }
  } catch (_) {
    remotes = [];
  }
  if (map) map.set(root, remotes);
  return remotes;
}

/**
 * Relative path of cwd within git root (posix-ish). Null if outside / missing.
 * @param {string} cwd
 * @param {string} gitRoot
 * @returns {string|null}
 */
function relPathInRepo(cwd, gitRoot) {
  try {
    const absCwd = fs.existsSync(cwd) ? fs.realpathSync(cwd) : path.resolve(cwd);
    const absRoot = fs.existsSync(gitRoot)
      ? fs.realpathSync(gitRoot)
      : path.resolve(gitRoot);
    const rel = path.relative(absRoot, absCwd);
    if (!rel || rel === '') return '.';
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return rel.split(path.sep).join('/');
  } catch (_) {
    return null;
  }
}

/**
 * True when relPath is `.` or under location prefix.
 * @param {string} relPath
 * @param {string} location
 */
function locationContains(relPath, location) {
  const loc = location === '' ? '.' : location;
  if (loc === '.') return true;
  if (relPath === '.') return false; // repo root cwd is not inside a subpath location
  if (relPath === loc) return true;
  return relPath.startsWith(loc.endsWith('/') ? loc : loc + '/');
}

/**
 * Match projects whose repository mappings cover cwd.
 * @returns {Array<{ project: object, repo: object, remote: string, checkout: object|null, confidence: 'confirmed'|'inferred' }>}
 */
function matchProjectsForCwd(cwd, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  if (!cache.gitRemotes) cache.gitRemotes = new Map();

  const memoryRepo =
    opts.memoryRepo !== undefined
      ? opts.memoryRepo
      : (memoryLib().resolveMemoryRepo(opts.env || process.env) || {}).path || null;
  const meta =
    opts.memoryMeta ||
    loadMemoryProjectMeta(memoryRepo);
  const localMap = opts.localMap || loadLocalRepositoryMap(opts.config);

  const gitRoot = projectLib.gitRootForCwd(cwd, cache);
  const remotes = gitRoot ? gitRemotesForCwd(gitRoot, cache) : [];
  const rel = gitRoot ? relPathInRepo(cwd, gitRoot) : null;

  const matches = [];
  for (const project of meta.projects || []) {
    for (const repo of project.repositories || []) {
      for (const remote of repo.remotes) {
        const local = localMap.get(remote) || null;
        const status = local ? checkoutStatus(local.path) : 'unmapped';

        // Match via live git remotes
        let hit = remotes.includes(remote);

        // Or via local checkout path containment when remotes unavailable
        if (!hit && local && status === 'ok') {
          try {
            const checkoutRoot = projectLib.gitRootForCwd(local.path, cache) || path.resolve(local.path);
            const absCwd = path.resolve(cwd);
            const absCheckout = path.resolve(checkoutRoot);
            if (absCwd === absCheckout || absCwd.startsWith(absCheckout + path.sep)) {
              hit = true;
            }
          } catch (_) {
            /* ignore */
          }
        }

        if (!hit) continue;

        const locs = repo.locations && repo.locations.length ? repo.locations : ['.'];
        const whole = locs.length === 1 && locs[0] === '.';
        let locOk = whole;
        if (!whole && rel != null) {
          locOk = locs.some((loc) => locationContains(rel, loc));
        } else if (!whole && rel == null && local && status === 'ok') {
          // cwd may be the mapped checkout root with locations — require `.` or empty rel
          locOk = locs.some((loc) => locationContains('.', loc) || loc === '.');
        }

        if (!locOk) continue;

        // Shared remote among multiple projects → inferred unless location is exclusive subpath
        const shared = countProjectsForRemote(meta.projects, remote) > 1;
        const confidence =
          !shared || !whole ? 'confirmed' : 'inferred';

        matches.push({
          project,
          repo,
          remote,
          checkout: local
            ? { path: local.path, status }
            : { path: null, status: 'unmapped' },
          confidence,
        });
      }
    }
  }
  return matches;
}

function countProjectsForRemote(projects, remote) {
  let n = 0;
  for (const p of projects || []) {
    if ((p.repositories || []).some((r) => (r.remotes || []).includes(remote))) n += 1;
  }
  return n;
}

/**
 * Infer project id from mappings when exactly one unambiguous match.
 * @returns {{ project: string|null, confidence: string, matches: object[] }}
 */
function inferProjectFromMappings(cwd, opts = {}) {
  const matches = matchProjectsForCwd(cwd, opts);
  const ids = [...new Set(matches.map((m) => m.project.id))];
  if (ids.length === 1) {
    const confidence = matches.every((m) => m.confidence === 'confirmed')
      ? 'confirmed'
      : 'inferred';
    // Prefer confirmed-only single id
    return { project: ids[0], confidence, matches };
  }
  if (ids.length > 1) {
    return { project: null, confidence: 'ambiguous', matches };
  }
  return { project: null, confidence: 'none', matches: [] };
}

/**
 * Locations for a project + remote (for git log pathspecs).
 * @returns {{ locations: string[], attribution: 'confirmed'|'inferred', shared: boolean }|null}
 */
function locationsForProjectRemote(projectId, remote, opts = {}) {
  const id = projectLib.canonicalProjectName(projectId);
  const norm = normalizeRemote(remote);
  if (!id || !norm) return null;
  const memoryRepo =
    opts.memoryRepo !== undefined
      ? opts.memoryRepo
      : (memoryLib().resolveMemoryRepo(opts.env || process.env) || {}).path || null;
  const meta = opts.memoryMeta || loadMemoryProjectMeta(memoryRepo);
  const project = (meta.projects || []).find((p) => p.id === id);
  if (!project) return null;
  const repo = (project.repositories || []).find((r) =>
    (r.remotes || []).includes(norm)
  );
  if (!repo) return null;
  const shared = countProjectsForRemote(meta.projects, norm) > 1;
  const locations = repo.locations && repo.locations.length ? repo.locations : ['.'];
  const whole = locations.length === 1 && locations[0] === '.';
  const attribution = shared && whole ? 'inferred' : 'confirmed';
  return { locations, attribution, shared };
}

/**
 * Resolve checkout for remote via local map.
 */
function resolveCheckoutForRemote(remote, opts = {}) {
  const norm = normalizeRemote(remote);
  const localMap = opts.localMap || loadLocalRepositoryMap(opts.config);
  const hit = norm ? localMap.get(norm) : null;
  if (!hit) return { remote: norm, path: null, status: 'unmapped' };
  return { remote: norm, path: hit.path, status: checkoutStatus(hit.path) };
}

/**
 * Build validation / listing payload for `aflt projects`.
 */
function buildProjectsReport(opts = {}) {
  const memoryRepo =
    opts.memoryRepo !== undefined
      ? opts.memoryRepo
      : (memoryLib().resolveMemoryRepo(opts.env || process.env) || {}).path || null;
  const meta = loadMemoryProjectMeta(memoryRepo);
  const localMap = loadLocalRepositoryMap(opts.config);
  const filterId =
    opts.project != null && String(opts.project).trim() !== ''
      ? projectLib.canonicalProjectName(String(opts.project).trim())
      : null;

  const remoteOwners = new Map(); // remote → project ids
  for (const p of meta.projects) {
    for (const r of p.repositories || []) {
      for (const remote of r.remotes) {
        if (!remoteOwners.has(remote)) remoteOwners.set(remote, new Set());
        remoteOwners.get(remote).add(p.id);
      }
    }
  }

  const projects = [];
  for (const p of meta.projects) {
    if (filterId && p.id !== filterId && p.folder !== filterId) continue;
    const problems = [...(p.problems || [])];
    const repositories = [];
    for (const r of p.repositories || []) {
      for (const remote of r.remotes) {
        const checkout = resolveCheckoutForRemote(remote, { localMap });
        if (checkout.status === 'unavailable') {
          problems.push({
            code: 'unavailable-checkout',
            remote,
            path: checkout.path,
            message: `checkout missing: ${checkout.path}`,
          });
        } else if (checkout.status === 'unmapped') {
          problems.push({
            code: 'unmapped-checkout',
            remote,
            message: `no local path in config.repositories for ${remote}`,
          });
        }
        const owners = remoteOwners.get(remote) || new Set();
        if (owners.size > 1) {
          const whole =
            (r.locations || ['.']).length === 1 && (r.locations || ['.'])[0] === '.';
          if (whole) {
            problems.push({
              code: 'shared-remote',
              remote,
              message: `remote shared by projects: ${[...owners].sort().join(', ')} (whole-repo locations → inferred commits)`,
            });
          }
        }
        repositories.push({
          id: r.id,
          remote,
          remotes: r.remotes,
          locations: r.locations,
          checkout,
        });
      }
    }
    projects.push({
      id: p.id,
      name: p.name,
      folder: p.folder,
      configPath: p.configPath,
      repositories,
      relationships: p.relationships || [],
      problems,
    });
  }

  if (filterId && projects.length === 0) {
    return {
      ok: false,
      error: `unknown project: ${filterId}`,
      memoryRepo,
      memoryRepoSource: memoryRepo
        ? (memoryLib().resolveMemoryRepo(opts.env || process.env) || {}).source || null
        : null,
      projects: [],
      errors: meta.errors,
    };
  }

  return {
    ok: true,
    memoryRepo,
    memoryRepoSource: memoryRepo
      ? (memoryLib().resolveMemoryRepo(opts.env || process.env) || {}).source || null
      : null,
    projects,
    errors: meta.errors,
  };
}

/**
 * Source-side project id from cwd `.agentfleet.json` (`project` or `projectId`).
 * @param {string} cwd
 * @param {object} [cache]
 * @returns {string|null}
 */
function projectIdFromSourceConfig(cwd, cache) {
  const key = (() => {
    try {
      return path.resolve(String(cwd || ''));
    } catch (_) {
      return null;
    }
  })();
  const map = cache && cache.projectConfig;
  // Reuse project.js cache when present — but that only stores "project".
  // Read fresh for projectId support.
  try {
    let hit = messages.findProjectConfig(cwd, { key: 'projectId' });
    if (hit && hit.data && typeof hit.data.projectId === 'string' && hit.data.projectId.trim()) {
      return projectLib.canonicalProjectName(hit.data.projectId.trim());
    }
    hit = messages.findProjectConfig(cwd, { key: 'project' });
    if (hit && hit.data && typeof hit.data.project === 'string' && hit.data.project.trim()) {
      return projectLib.canonicalProjectName(hit.data.project.trim());
    }
  } catch (_) {
    /* ignore */
  }
  if (map && key && map.has(key)) {
    const cached = map.get(key);
    return cached ? projectLib.canonicalProjectName(cached) : null;
  }
  return null;
}

/**
 * Text table for `aflt projects`.
 */
function formatProjectsText(report) {
  const lines = [];
  if (!report.memoryRepo) {
    lines.push('No memory repo configured (AFLT_MEMORY_REPO / config.memoryRepo).');
    lines.push('Project↔repo mappings live under <memoryRepo>/<project>/.agentfleet.json.');
    lines.push('See docs/PROJECT-REPO-METADATA.md');
    return lines.join('\n') + '\n';
  }
  lines.push(`Memory repo: ${report.memoryRepo}${report.memoryRepoSource ? ` (${report.memoryRepoSource})` : ''}`);
  if (report.errors && report.errors.length) {
    for (const e of report.errors) lines.push(`error: ${e}`);
  }
  if (!report.projects.length) {
    lines.push('(no projects)');
    return lines.join('\n') + '\n';
  }
  const idW = Math.max(8, ...report.projects.map((p) => String(p.id).length));
  lines.push(
    `${'PROJECT'.padEnd(idW)}  REPOS                                      CHECKOUTS         PROBLEMS`
  );
  for (const p of report.projects) {
    const repoBits = (p.repositories || [])
      .map((r) => {
        const locs = (r.locations || ['.']).join(',');
        return `${r.remote} (${locs})`;
      })
      .join('; ');
    const checkoutBits = (p.repositories || [])
      .map((r) => {
        if (!r.checkout || r.checkout.status === 'unmapped') return 'unmapped';
        const short =
          r.checkout.path && homeDir() && r.checkout.path.startsWith(homeDir())
            ? '~' + r.checkout.path.slice(homeDir().length)
            : r.checkout.path || '-';
        return `${short} [${r.checkout.status}]`;
      })
      .join('; ');
    const probs = (p.problems || []).map((x) => x.code).join(',') || '-';
    const repoCol = (repoBits || '-').slice(0, 42).padEnd(42);
    const coCol = (checkoutBits || '-').slice(0, 16).padEnd(16);
    lines.push(`${String(p.id).padEnd(idW)}  ${repoCol}  ${coCol}  ${probs}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  AGENTFLEET_JSON,
  normalizeRemote,
  normalizeLocations,
  remotesFromRepoEntry,
  parseMemoryProjectConfig,
  loadMemoryProjectMeta,
  loadLocalRepositoryMap,
  checkoutStatus,
  gitRemotesForCwd,
  relPathInRepo,
  locationContains,
  matchProjectsForCwd,
  inferProjectFromMappings,
  locationsForProjectRemote,
  resolveCheckoutForRemote,
  buildProjectsReport,
  projectIdFromSourceConfig,
  formatProjectsText,
};
