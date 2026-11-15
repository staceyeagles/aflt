'use strict';

/**
 * Opt-in project memory repo: sync per-project session timelines into a
 * registered git working tree. Never commits, never adds remotes, never
 * auto-syncs. Read-only on the af registry.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const projectLib = require('./project');
const timeline = require('./timeline');
const { envNonEmpty, homeDir, expandUserPath, nowIso } = require('./util');

/** Generated per-project folder (underscore keeps it distinct from a project named `aflt`). */
const GENERATED_DIR = '_aflt';

const MARKER_NAME = '.aflt-memory.json';
const MARKER_VERSION = 1;
const GITIGNORE_LINES = ['.DS_Store', 'memory/'];

const ROOT_README = `# aflt project memory

This is an **aflt project memory** git repo. AgentFleet keeps per-project
session timelines here when you run \`aflt memory sync\`.

## Layout

- One top-level folder per aflt **project** (folder name = project name).
- \`<project>/_aflt/\` is **generated** by \`aflt memory sync\` — do not edit by hand.
- \`<project>/README.md\` and \`<project>/status-notes/\` are for humans and agents.
- Commits are made by **humans** (aflt never commits, never adds a remote).

## Sync

\`\`\`bash
aflt memory sync              # cwd / AFLT_PROJECT project
aflt memory sync --all        # every registry project except adhoc
aflt memory sync --all --include-adhoc
\`\`\`

\`adhoc\` (one-off home/tmp prompts) is excluded from \`--all\` by default because
those sessions are often personal.
`;

/**
 * Redact secrets / PII from a string written into the memory repo.
 * Commit hashes (7–12 hex) are preserved. Absolute home paths → `~`.
 * @param {string} input
 * @returns {string}
 */
function redactSensitive(input) {
  if (input == null) return '';
  let s = String(input);

  const home = homeDir();
  if (home) {
    const esc = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    s = s.replace(new RegExp(esc, 'g'), '~');
    // Also cover unresolved / alternate home spellings via ~/ already handled
  }

  // Private / loopback IPv4
  s = s.replace(
    /\b(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2})\b/g,
    '[redacted]'
  );

  // *.local hostnames (not email)
  s = s.replace(/\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.local\b/gi, '[redacted]');

  // Emails
  s = s.replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, '[redacted]');

  // Token-like prefixes
  s = s.replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[redacted]');
  s = s.replace(/\b(?:ghp_|gho_|github_pat_)[A-Za-z0-9_]+/g, '[redacted]');
  s = s.replace(/\bxox[abp]-[A-Za-z0-9-]+/g, '[redacted]');
  s = s.replace(/\b(?:key_|crsr_)[A-Za-z0-9_-]{8,}\b/g, '[redacted]');

  // key=/token=/secret=/password= values (to whitespace or end / quote)
  s = s.replace(
    /\b(?:key|token|secret|password)\s*=\s*([^\s"'`]+)/gi,
    (m, _val) => m.replace(_val, '[redacted]')
  );

  // Long hex (≥32) — skip short commit hashes (7–12)
  s = s.replace(/\b[0-9a-fA-F]{32,}\b/g, '[redacted]');

  // Base64-ish ≥40 (alphanumeric + /+=)
  s = s.replace(/\b[A-Za-z0-9+/]{40,}={0,2}\b/g, '[redacted]');

  return s;
}

/**
 * Sanitize a project name into a single path segment.
 * Unsafe chars → `-`. Throws if result is empty.
 * @param {string} name
 * @returns {string}
 */
function sanitizeFolderName(name) {
  let s = String(name == null ? '' : name);
  // Path separators and Windows/macOS-invalid
  s = s.replace(/[<>:"/\\|?*\x00-\x1f\x7f]/g, '-');
  // Collapse `..` path traversal residue
  while (s.includes('..')) s = s.replace(/\.\./g, '-');
  // Leading dots (hidden / relative)
  s = s.replace(/^\.+/, (dots) => '-'.repeat(dots.length));
  // Trailing dots/spaces (Windows)
  s = s.replace(/[.\s]+$/g, (m) => '-'.repeat(m.length));
  if (!s || s === '-' || /^-+$/.test(s)) {
    const err = new Error(`project name sanitizes to empty: ${JSON.stringify(name)}`);
    err.code = 'BAD_FOLDER';
    throw err;
  }
  return s;
}

/**
 * Resolve memory repo path. AFLT_MEMORY_REPO > config.json memoryRepo.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ path: string, source: 'env'|'config' }|null}
 */
function resolveMemoryRepo(env = process.env) {
  const fromEnv = envNonEmpty(env, 'AFLT_MEMORY_REPO');
  if (fromEnv) {
    return { path: path.resolve(expandUserPath(fromEnv)), source: 'env' };
  }
  const data = config.load();
  const raw = data && typeof data.memoryRepo === 'string' ? data.memoryRepo.trim() : '';
  if (raw) {
    return { path: path.resolve(expandUserPath(raw)), source: 'config' };
  }
  return null;
}

function markerPath(repoDir) {
  return path.join(repoDir, MARKER_NAME);
}

function isMemoryRepo(dir) {
  try {
    return fs.existsSync(markerPath(dir));
  } catch (_) {
    return false;
  }
}

function isGitRepo(dir) {
  try {
    const r = spawnSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return r.status === 0 && String(r.stdout || '').trim() === 'true';
  } catch (_) {
    return false;
  }
}

function dirNonEmpty(dir) {
  try {
    if (!fs.existsSync(dir)) return false;
    const entries = fs.readdirSync(dir);
    return entries.length > 0;
  } catch (_) {
    return false;
  }
}

function ensureGitignore(repoDir) {
  const p = path.join(repoDir, '.gitignore');
  if (!fs.existsSync(p)) {
    fs.writeFileSync(p, GITIGNORE_LINES.join('\n') + '\n', 'utf8');
    return { created: true, appended: [] };
  }
  const raw = fs.readFileSync(p, 'utf8');
  const existing = new Set(
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
  );
  const missing = GITIGNORE_LINES.filter((l) => !existing.has(l));
  if (missing.length) {
    const needsNl = raw.length > 0 && !raw.endsWith('\n');
    fs.writeFileSync(p, (needsNl ? '\n' : '') + missing.join('\n') + '\n', {
      flag: 'a',
      encoding: 'utf8',
    });
  }
  return { created: false, appended: missing };
}

function registerMemoryRepo(absPath) {
  const data = config.load();
  data.memoryRepo = absPath;
  config.save(data);
  return absPath;
}

/**
 * `aflt memory init <path>`
 * @param {string} targetPath
 * @param {{ force?: boolean }} [opts]
 */
function initMemoryRepo(targetPath, opts = {}) {
  const force = Boolean(opts.force);
  const expanded = path.resolve(expandUserPath(String(targetPath || '').trim() || '.'));

  if (!fs.existsSync(expanded)) {
    fs.mkdirSync(expanded, { recursive: true });
  }

  let abs;
  try {
    abs = fs.realpathSync(expanded);
  } catch (_) {
    abs = expanded;
  }

  const hasMarker = isMemoryRepo(abs);
  if (!hasMarker && dirNonEmpty(abs) && !force) {
    const err = new Error(
      `refusing to init: ${abs} is non-empty and is not an aflt memory repo (missing ${MARKER_NAME}). Use --force to add marker files without overwriting existing README/.gitignore content.`
    );
    err.code = 'NOT_EMPTY';
    throw err;
  }

  if (!isGitRepo(abs)) {
    const r = spawnSync('git', ['init'], {
      cwd: abs,
      encoding: 'utf8',
      timeout: 15000,
    });
    if (r.status !== 0) {
      const err = new Error(`git init failed: ${(r.stderr || r.stdout || '').trim() || 'unknown'}`);
      err.code = 'GIT_INIT';
      throw err;
    }
  }

  const readmePath = path.join(abs, 'README.md');
  if (!fs.existsSync(readmePath)) {
    fs.writeFileSync(readmePath, ROOT_README, 'utf8');
  }

  ensureGitignore(abs);

  const marker = markerPath(abs);
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(
      marker,
      JSON.stringify({ version: MARKER_VERSION, createdAt: nowIso() }, null, 2) + '\n',
      'utf8'
    );
  }

  registerMemoryRepo(abs);
  return { ok: true, repo: abs, created: !hasMarker, registered: true };
}

function cwdDisplay(cwd, redact) {
  if (cwd == null || cwd === '') return null;
  let s = String(cwd);
  const home = homeDir();
  if (home && (s === home || s.startsWith(home + path.sep) || s.startsWith(home + '/'))) {
    s = '~' + s.slice(home.length);
  }
  return redact ? redactSensitive(s) : s;
}

function parseCommitLine(line) {
  const raw = String(line || '');
  const m = raw.match(/^([0-9a-f]{7,12})\s+(.*)$/i);
  if (m) return { hash: m[1], subject: m[2] };
  return { hash: '', subject: raw };
}

function applyRedactToRecord(rec, doRedact) {
  const commits = (rec.commits || []).map((c) => {
    const parsed = typeof c === 'string' ? parseCommitLine(c) : c;
    return {
      hash: parsed.hash,
      subject: doRedact ? redactSensitive(parsed.subject) : String(parsed.subject || ''),
    };
  });
  return {
    id: rec.id,
    title: doRedact ? redactSensitive(rec.title) : rec.title,
    project: rec.project,
    parent: rec.parent || null,
    role: rec.role || null,
    engine: rec.engine || 'cursor',
    status: rec.status || null,
    workerStatus: rec.workerStatus || null,
    start: rec.start || null,
    end: rec.end || null,
    lastUsed: rec.lastUsed || null,
    cwd: cwdDisplay(rec.cwd, doRedact),
    promptSummary: doRedact ? redactSensitive(rec.promptSummary || '') : rec.promptSummary || '',
    commits,
    commitsReason: rec.commitsReason || null,
  };
}

/** Stable JSON object with fixed key order. */
function sessionJsonLine(rec) {
  const ordered = {
    id: rec.id,
    title: rec.title,
    project: rec.project,
    parent: rec.parent,
    role: rec.role,
    engine: rec.engine,
    status: rec.status,
    workerStatus: rec.workerStatus,
    start: rec.start,
    end: rec.end,
    lastUsed: rec.lastUsed,
    cwd: rec.cwd,
    promptSummary: rec.promptSummary,
    commits: rec.commits,
    commitsReason: rec.commitsReason,
  };
  return JSON.stringify(ordered);
}

function formatMemoryTimelineMd(group, sessionCount, doRedact) {
  const projectName = doRedact ? redactSensitive(group.project) : group.project;
  // Clone tree with redacted string fields for text rendering
  function cloneNode(r) {
    const commits = (r.commits || []).map((line) => {
      if (!doRedact) return line;
      const { hash, subject } = parseCommitLine(line);
      return hash ? `${hash} ${redactSensitive(subject)}` : redactSensitive(String(line));
    });
    return {
      ...r,
      title: doRedact ? redactSensitive(r.title) : r.title,
      promptSummary: doRedact ? redactSensitive(r.promptSummary || '') : r.promptSummary,
      cwd: cwdDisplay(r.cwd, doRedact),
      commits,
      children: (r.children || []).map(cloneNode),
    };
  }
  const redactedGroup = {
    project: projectName,
    sessions: (group.sessions || []).map(cloneNode),
  };
  const body = timeline.formatProjectText(redactedGroup);
  const lines = body.split('\n');
  const header = lines[0] || `# ${projectName}`;
  const rest = lines.slice(1).join('\n').replace(/^\n+/, '');
  return `${header}\n\n${sessionCount} sessions\n\n${rest}`.replace(/\s+$/, '') + '\n';
}

function projectStubReadme(projectName) {
  return `# ${projectName}\n\nHuman/agent notes go here; \`_aflt/\` is generated by \`aflt memory sync\` — do not edit it by hand.\n`;
}

/**
 * Write file only when content differs (preserve mtime when unchanged).
 * @returns {{ path: string, changed: boolean, bytes: number }}
 */
function writeIfChanged(filePath, content, { dryRun = false } = {}) {
  const bytes = Buffer.byteLength(content, 'utf8');
  let changed = true;
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf8');
      if (existing === content) changed = false;
    }
  } catch (_) {
    changed = true;
  }
  if (!dryRun && changed) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { path: filePath, changed, bytes };
}

function createIfMissing(filePath, content, { dryRun = false } = {}) {
  if (fs.existsSync(filePath)) {
    return { path: filePath, changed: false, bytes: 0, skipped: true };
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (!dryRun) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
  }
  return { path: filePath, changed: true, bytes, skipped: false };
}

/**
 * Collect project names to sync.
 */
function resolveSyncProjects(sessions, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  const named = Array.isArray(opts.projects) ? opts.projects.filter(Boolean) : [];
  const wantAll = Boolean(opts.all);
  const includeAdhoc = Boolean(opts.includeAdhoc);

  if (named.length) {
    return named.map((p) => String(p).trim()).filter(Boolean);
  }
  if (wantAll) {
    const set = new Set();
    for (const s of sessions) {
      const name = projectLib.resolveProjectName(s, { cache });
      if (name === projectLib.ADHOC_NAME && !includeAdhoc) continue;
      set.add(name);
    }
    return [...set].sort();
  }
  // Default: cwd project (same as timeline — honor AFLT_PROJECT)
  const fromEnv = projectLib.projectFromEnv(opts.env || process.env);
  const want =
    fromEnv ||
    projectLib.resolveProjectName({ cwd: opts.cwd || process.cwd() }, { cache });
  return [want];
}

/**
 * Build generated contents for one project (no I/O).
 */
function buildProjectArtifacts(sessions, projectName, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  const doRedact = opts.redact !== false;
  const payload = timeline.buildTimeline(sessions, {
    project: projectName,
    cwd: opts.cwd || process.cwd(),
    cache,
  });
  const group = (payload.projects && payload.projects[0]) || {
    project: projectName,
    sessions: [],
  };

  const byId = new Map(sessions.map((s) => [s.id, s]));
  const flat = timeline
    .flattenTree(group.sessions || [])
    .map(({ record }) => {
      const orig = byId.get(record.id);
      return {
        ...record,
        lastUsed: (orig && orig.lastUsed) || null,
        children: undefined,
      };
    });
  const sorted = timeline.sortByStart(flat);

  const rows = sorted.map((r) => applyRedactToRecord(r, doRedact));
  const jsonl = rows.map(sessionJsonLine).join('\n') + (rows.length ? '\n' : '');
  const md = formatMemoryTimelineMd(group, rows.length, doRedact);

  return { group, rows, jsonl, md, sessionCount: rows.length };
}

/**
 * Sync projects into the memory repo.
 * @param {object[]} sessions
 * @param {{
 *   projects?: string[],
 *   all?: boolean,
 *   includeAdhoc?: boolean,
 *   dryRun?: boolean,
 *   redact?: boolean,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   repo?: { path: string, source: string }|null,
 * }} [opts]
 */
function syncMemory(sessions, opts = {}) {
  const resolved = opts.repo || resolveMemoryRepo(opts.env || process.env);
  if (!resolved) {
    const err = new Error(
      'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
    err.code = 'NO_REPO';
    throw err;
  }
  const repoPath = resolved.path;
  if (!fs.existsSync(repoPath)) {
    const err = new Error(`memory repo does not exist: ${repoPath}`);
    err.code = 'MISSING_REPO';
    throw err;
  }

  const cache = projectLib.createLookupCache();
  const projectNames = resolveSyncProjects(sessions, {
    ...opts,
    cache,
  });
  const dryRun = Boolean(opts.dryRun);
  const doRedact = opts.redact !== false;

  const projectsOut = [];
  for (const projectName of projectNames) {
    let folder;
    try {
      folder = sanitizeFolderName(projectName);
    } catch (err) {
      throw err;
    }
    const folderAbs = path.join(repoPath, folder);
    const afltDir = path.join(folderAbs, GENERATED_DIR);
    const artifacts = buildProjectArtifacts(sessions, projectName, {
      cache,
      redact: doRedact,
      cwd: opts.cwd,
    });

    const files = [];
    const timelineRel = path.join(folder, GENERATED_DIR, 'timeline.md');
    const sessionsRel = path.join(folder, GENERATED_DIR, 'sessions.jsonl');
    const readmeRel = path.join(folder, 'README.md');
    const keepRel = path.join(folder, 'status-notes', '.gitkeep');

    const mdWrite = writeIfChanged(path.join(repoPath, timelineRel), artifacts.md, { dryRun });
    files.push({ path: timelineRel, changed: mdWrite.changed, bytes: mdWrite.bytes });

    const jlWrite = writeIfChanged(path.join(repoPath, sessionsRel), artifacts.jsonl, {
      dryRun,
    });
    files.push({ path: sessionsRel, changed: jlWrite.changed, bytes: jlWrite.bytes });

    const stub = createIfMissing(path.join(repoPath, readmeRel), projectStubReadme(projectName), {
      dryRun,
    });
    if (stub.changed) {
      files.push({ path: readmeRel, changed: true, bytes: stub.bytes });
    }

    const keep = createIfMissing(path.join(repoPath, keepRel), '', { dryRun });
    if (keep.changed) {
      files.push({ path: keepRel, changed: true, bytes: keep.bytes });
    }

    // Ensure aflt dir exists even when dry-run false and both files unchanged
    if (!dryRun) fs.mkdirSync(afltDir, { recursive: true });

    projectsOut.push({
      project: projectName,
      folder,
      sessions: artifacts.sessionCount,
      files,
    });
  }

  return {
    ok: true,
    repo: repoPath,
    source: resolved.source,
    projects: projectsOut,
  };
}

function gitPorcelainCount(repoPath) {
  try {
    const r = spawnSync('git', ['-C', repoPath, 'status', '--porcelain'], {
      encoding: 'utf8',
      timeout: 10000,
    });
    if (r.status !== 0) return null;
    const lines = String(r.stdout || '')
      .split(/\r?\n/)
      .filter((l) => l.length > 0);
    return lines.length;
  } catch (_) {
    return null;
  }
}

/**
 * Read-only status of memory repo vs registry.
 */
function memoryStatus(sessions, opts = {}) {
  const resolved = opts.repo || resolveMemoryRepo(opts.env || process.env);
  if (!resolved) {
    const err = new Error(
      'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
    err.code = 'NO_REPO';
    throw err;
  }
  const repoPath = resolved.path;
  const cache = projectLib.createLookupCache();
  const doRedact = opts.redact !== false;

  const registryProjects = new Set();
  for (const s of sessions) {
    const name = projectLib.resolveProjectName(s, { cache });
    if (name === projectLib.ADHOC_NAME) continue;
    registryProjects.add(name);
  }

  // Include adhoc if folder present in repo (excluded from registry set above)
  try {
    const adhocFolder = sanitizeFolderName(projectLib.ADHOC_NAME);
    if (fs.existsSync(path.join(repoPath, adhocFolder))) {
      registryProjects.add(projectLib.ADHOC_NAME);
    }
  } catch (_) {
    /* ignore */
  }

  const names = [...registryProjects].sort();
  const projects = [];
  for (const projectName of names) {
    let folder;
    try {
      folder = sanitizeFolderName(projectName);
    } catch (_) {
      continue;
    }
    const folderAbs = path.join(repoPath, folder);
    const folderExists = fs.existsSync(folderAbs);
    const sessionsPath = path.join(folderAbs, GENERATED_DIR, 'sessions.jsonl');
    let lastSync = null;
    try {
      if (fs.existsSync(sessionsPath)) {
        lastSync = fs.statSync(sessionsPath).mtime.toISOString();
      }
    } catch (_) {
      lastSync = null;
    }

    const matched = sessions.filter(
      (s) => projectLib.resolveProjectName(s, { cache }) === projectName
    );
    const artifacts = buildProjectArtifacts(sessions, projectName, {
      cache,
      redact: doRedact,
      cwd: opts.cwd,
    });

    let stale = true;
    try {
      if (fs.existsSync(sessionsPath)) {
        const onDisk = fs.readFileSync(sessionsPath, 'utf8');
        const timelinePath = path.join(folderAbs, GENERATED_DIR, 'timeline.md');
        const mdDisk = fs.existsSync(timelinePath) ? fs.readFileSync(timelinePath, 'utf8') : null;
        stale = onDisk !== artifacts.jsonl || mdDisk !== artifacts.md;
      } else {
        stale = true;
      }
    } catch (_) {
      stale = true;
    }

    projects.push({
      project: projectName,
      folder,
      folderExists,
      lastSync,
      sessions: matched.length,
      stale,
    });
  }

  return {
    ok: true,
    repo: repoPath,
    source: resolved.source,
    exists: fs.existsSync(repoPath),
    isGit: isGitRepo(repoPath),
    dirtyCount: fs.existsSync(repoPath) && isGitRepo(repoPath) ? gitPorcelainCount(repoPath) : null,
    projects,
  };
}

module.exports = {
  GENERATED_DIR,
  MARKER_NAME,
  MARKER_VERSION,
  ROOT_README,
  redactSensitive,
  sanitizeFolderName,
  resolveMemoryRepo,
  isMemoryRepo,
  isGitRepo,
  initMemoryRepo,
  registerMemoryRepo,
  syncMemory,
  memoryStatus,
  buildProjectArtifacts,
  writeIfChanged,
  resolveSyncProjects,
  cwdDisplay,
  parseCommitLine,
};
