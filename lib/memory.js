'use strict';

/**
 * Opt-in project memory repo: sync per-project session timelines into a
 * registered git working tree. Never auto-syncs, never adds remotes.
 * Optional `commitGenerated` (via `aflt memory sync --commit` or
 * `aflt memory config --commit`) stages eligible generated / managed-root
 * paths and root `DASHBOARD.md`. Read-only on the af registry.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const config = require('./config');
const displayStateLib = require('./display-state');
const herdr = require('./herdr');
const projectLib = require('./project');
const timeline = require('./timeline');
const { envNonEmpty, homeDir, expandUserPath, nowIso } = require('./util');

/** Generated per-project folder (underscore keeps it distinct from a project named `aflt`). */
const GENERATED_DIR = '_aflt';

/** Root dashboard filename (uppercase; per-project files stay `dashboard.md`). */
const DASHBOARD_REL = 'DASHBOARD.md';
const DOC_AGENT_REL = 'DOC-AGENT.md';
/** Shared agent documentation process (opt-in agentDocs; issue #3). */
const PROCESS_DOC_REL = 'DOCUMENTATION-PROCESS.md';

const DEFAULT_ACTIVE_DAYS = 14;
const MEMORY_TZ = 'America/New_York';

const DOC_BOT_SUMMARY_START = '<!-- doc-bot:summary:start -->';
const DOC_BOT_SUMMARY_END = '<!-- doc-bot:summary:end -->';
const DOC_BOT_SUMMARY_PLACEHOLDER = '_No Doc Bot summary yet._';

const MARKER_NAME = '.aflt-memory.json';
const MARKER_VERSION = 1;
const GITIGNORE_LINES = ['.DS_Store', 'memory/'];

const ROOT_README = `# aflt project memory

This is an **aflt project memory** git repo. AgentFleet keeps per-project
session timelines here when you run \`aflt memory sync\`.

## Layout

- One top-level folder per aflt **project** (folder name = project name).
- \`DASHBOARD.md\` (repo root) is **generated** by \`aflt memory sync\` /
  \`aflt memory dashboard\` — Active/Dormant project table (default 14 days ET).
  Do not put \`DASHBOARD.md\` inside a project folder (per-project files stay
  \`dashboard.md\`).
- \`<project>/_aflt/\` is **generated** by \`aflt memory sync\` — do not edit by hand.
- \`<project>/README.md\`, \`<project>/dashboard.md\`, and \`<project>/status-notes/\`
  are for humans and Doc Bot.
- Optional \`aflt memory sync --commit\` stages \`DASHBOARD.md\` and per-project
  \`_aflt/\` trees (never human files / per-project \`dashboard.md\`). Nightly:
  \`aflt memory sync --all --commit --push\`. aflt never adds a remote.

## Sync

\`\`\`bash
aflt memory sync              # cwd / AFLT_PROJECT project (+ root DASHBOARD.md)
aflt memory sync --all        # every registry project except adhoc
aflt memory sync --all --include-adhoc
aflt memory dashboard         # regenerate root DASHBOARD.md only
aflt memory config [--apply]  # refresh DOC-AGENT.md / DOCUMENTATION-PROCESS.md
aflt memory doc [--engine cursor|copilot]  # launch Doc Bot (see DOC-AGENT.md)
aflt memory sync --all --commit --push   # nightly: commit generated files + push
\`\`\`

\`DOC-AGENT.md\` is the portable documentarian prompt (Cursor CLI or Copilot CLI).
\`DOCUMENTATION-PROCESS.md\` is the shared agent documentation process (opt-in
\`agentDocs\`). \`aflt memory init\` writes both when missing; refresh them after
an aflt upgrade with \`aflt memory config\` (dry-run) / \`--apply\` (never touches
per-project human README / status-notes / the Doc Bot summary block).

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
 * Packaged template under templates/ (DOC-AGENT.md, DOCUMENTATION-PROCESS.md, …).
 * @param {string} relName
 * @returns {string|null}
 */
function readPackageTemplate(relName) {
  const p = path.join(__dirname, '..', 'templates', relName);
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  } catch (_) {
    /* ignore */
  }
  return null;
}

/**
 * Packaged DOC-AGENT.md template (portable Doc Bot prompt).
 * @returns {string|null}
 */
function readDocAgentTemplate() {
  return readPackageTemplate(DOC_AGENT_REL);
}

/**
 * Packaged DOCUMENTATION-PROCESS.md template.
 * @returns {string|null}
 */
function readProcessDocTemplate() {
  return readPackageTemplate(PROCESS_DOC_REL);
}

/**
 * Root files that init seeds from package templates and that
 * `aflt memory config` may refresh. Never includes per-project human files
 * (README.md / dashboard.md / status-notes/) or DASHBOARD.md's doc-bot block.
 */
const MANAGED_ROOT_FILES = Object.freeze([DOC_AGENT_REL, PROCESS_DOC_REL]);

/**
 * Short human-readable diff summary for dry-run / JSON reports.
 * @param {string|null|undefined} existing
 * @param {string} desired
 * @returns {string}
 */
function shortDiffSummary(existing, desired) {
  if (existing == null) {
    const lines = String(desired || '').split(/\r?\n/).length;
    return `missing → ${lines} line(s)`;
  }
  if (existing === desired) return 'identical';
  const before = String(existing).split(/\r?\n/);
  const after = String(desired).split(/\r?\n/);
  let first = null;
  const max = Math.max(before.length, after.length);
  for (let i = 0; i < max; i++) {
    if (before[i] !== after[i]) {
      first = i + 1;
      break;
    }
  }
  return `lines ${before.length}→${after.length}; first diff @${first != null ? first : '?'}`;
}

/**
 * Compare one managed root file against its package template.
 * @param {string} repoPath
 * @param {string} relName
 * @param {string|null} template
 * @returns {{
 *   path: string,
 *   status: 'up-to-date'|'would-update'|'missing'|'no-template',
 *   diff: string,
 *   bytes: number|null,
 * }}
 */
function inspectManagedRootFile(repoPath, relName, template) {
  const abs = path.join(repoPath, relName);
  if (template == null) {
    return {
      path: relName,
      status: 'no-template',
      diff: 'package template missing',
      bytes: null,
    };
  }
  const bytes = Buffer.byteLength(template, 'utf8');
  if (!fs.existsSync(abs)) {
    return {
      path: relName,
      status: 'missing',
      diff: shortDiffSummary(null, template),
      bytes,
    };
  }
  let existing;
  try {
    existing = fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return {
      path: relName,
      status: 'would-update',
      diff: `unreadable: ${err.message || err}`,
      bytes,
    };
  }
  if (existing === template) {
    return { path: relName, status: 'up-to-date', diff: 'identical', bytes };
  }
  return {
    path: relName,
    status: 'would-update',
    diff: shortDiffSummary(existing, template),
    bytes,
  };
}

/**
 * Inspect all template-managed memory-repo root files (read-only).
 * @param {{ env?: NodeJS.ProcessEnv, repo?: { path: string, source: string }|null }} [opts]
 */
function inspectMemoryConfig(opts = {}) {
  const resolved = opts.repo || resolveMemoryRepo(opts.env || process.env);
  if (!resolved) {
    const err = new Error(
      'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
    err.code = 'NO_REPO';
    throw err;
  }
  if (!fs.existsSync(resolved.path)) {
    const err = new Error(`memory repo does not exist: ${resolved.path}`);
    err.code = 'MISSING_REPO';
    throw err;
  }

  const templates = {
    [DOC_AGENT_REL]: readDocAgentTemplate(),
    [PROCESS_DOC_REL]: readProcessDocTemplate(),
  };
  const files = MANAGED_ROOT_FILES.map((rel) =>
    inspectManagedRootFile(resolved.path, rel, templates[rel])
  );
  const needsUpdate = files.some(
    (f) => f.status === 'missing' || f.status === 'would-update'
  );
  return {
    ok: true,
    repo: resolved.path,
    source: resolved.source,
    files,
    needsUpdate,
  };
}

/**
 * Doctor hint for DOC-AGENT.md vs package template (soft; does not fail doctor exit).
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ name: string, ok: boolean, detail: string }}
 */
function doctorDocAgentStatus(env = process.env) {
  const name = 'memory_doc_agent';
  const resolved = resolveMemoryRepo(env);
  if (!resolved) {
    return { name, ok: true, detail: 'no memory repo configured' };
  }
  if (!fs.existsSync(resolved.path)) {
    return {
      name,
      ok: false,
      detail: `memory repo missing: ${resolved.path}`,
    };
  }
  const template = readDocAgentTemplate();
  if (template == null) {
    return { name, ok: true, detail: 'package template unavailable' };
  }
  const row = inspectManagedRootFile(resolved.path, DOC_AGENT_REL, template);
  if (row.status === 'up-to-date') {
    return { name, ok: true, detail: `${DOC_AGENT_REL} up to date` };
  }
  if (row.status === 'missing') {
    return {
      name,
      ok: false,
      detail: `${DOC_AGENT_REL} missing; run \`aflt memory config --apply\``,
    };
  }
  return {
    name,
    ok: false,
    detail: `${DOC_AGENT_REL} outdated; run \`aflt memory config\` (preview) or \`aflt memory config --apply\``,
  };
}

/**
 * Refresh template-managed root files in the memory repo.
 * Dry-run by default; `--apply` writes. Never touches per-project human files
 * or the Doc Bot summary block (dashboard regen preserves it).
 *
 * @param {object[]} sessions
 * @param {{
 *   apply?: boolean,
 *   dryRun?: boolean,
 *   redact?: boolean,
 *   activeDays?: number,
 *   includeAdhoc?: boolean,
 *   now?: Date,
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   repo?: { path: string, source: string }|null,
 * }} [opts]
 */
function configMemory(sessions, opts = {}) {
  const apply = Boolean(opts.apply);
  // Default is dry-run; explicit dryRun:true with apply:true is refused by CLI.
  const dryRun = apply ? false : opts.dryRun !== false;

  const resolved = opts.repo || resolveMemoryRepo(opts.env || process.env);
  if (!resolved) {
    const err = new Error(
      'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
    err.code = 'NO_REPO';
    throw err;
  }
  if (!fs.existsSync(resolved.path)) {
    const err = new Error(`memory repo does not exist: ${resolved.path}`);
    err.code = 'MISSING_REPO';
    throw err;
  }

  const templates = {
    [DOC_AGENT_REL]: readDocAgentTemplate(),
    [PROCESS_DOC_REL]: readProcessDocTemplate(),
  };

  const files = [];
  for (const rel of MANAGED_ROOT_FILES) {
    const template = templates[rel];
    const inspected = inspectManagedRootFile(resolved.path, rel, template);
    const entry = {
      path: rel,
      status: inspected.status,
      diff: inspected.diff,
      bytes: inspected.bytes,
      backedUp: false,
      bak: null,
      written: false,
    };

    if (template == null) {
      files.push(entry);
      continue;
    }

    if (!dryRun && inspected.status !== 'up-to-date') {
      const abs = path.join(resolved.path, rel);
      if (inspected.status === 'would-update') {
        // Local edits that do not match the package template → keep .bak
        const bakAbs = `${abs}.bak`;
        let existing = null;
        try {
          existing = fs.readFileSync(abs, 'utf8');
        } catch (_) {
          existing = null;
        }
        if (existing != null && existing !== template) {
          fs.writeFileSync(bakAbs, existing, 'utf8');
          entry.backedUp = true;
          entry.bak = `${rel}.bak`;
        }
      }
      fs.writeFileSync(abs, template, 'utf8');
      entry.written = true;
      entry.status = inspected.status === 'missing' ? 'created' : 'updated';
      entry.diff =
        inspected.status === 'missing'
          ? shortDiffSummary(null, template)
          : inspected.diff;
    }

    files.push(entry);
  }

  const dashboard = writeDashboard(sessions, {
    ...opts,
    repo: resolved,
    dryRun,
  });

  return {
    ok: true,
    repo: resolved.path,
    source: resolved.source,
    apply: !dryRun,
    dryRun,
    files,
    dashboard,
    needsUpdate: files.some(
      (f) => f.status === 'missing' || f.status === 'would-update'
    ),
  };
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

  const docAgentPath = path.join(abs, DOC_AGENT_REL);
  if (!fs.existsSync(docAgentPath)) {
    const md = readDocAgentTemplate();
    if (md) fs.writeFileSync(docAgentPath, md, 'utf8');
  }

  // Shared documentation-process doc (issue #3 / agentDocs). Never overwrite.
  try {
    require('./agent-docs').ensureProcessDocInMemoryRepo(abs);
  } catch (_) {
    /* optional; package template may be absent in odd installs */
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
    return [
      ...new Set(
        named
          .map((p) => projectLib.canonicalProjectName(String(p).trim()))
          .filter(Boolean)
      ),
    ];
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
  const want = projectLib.canonicalProjectName(
    fromEnv ||
      projectLib.resolveProjectName({ cwd: opts.cwd || process.cwd() }, { cache })
  );
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
 * Format a Date as YYYY-MM-DD in America/New_York (ET). Host TZ independent.
 * @param {Date|number|string} [input]
 * @returns {string}
 */
function etDateYmd(input = new Date()) {
  const d = input instanceof Date ? input : new Date(input);
  if (!Number.isFinite(d.getTime())) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: MEMORY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * Calendar-day arithmetic on a YYYY-MM-DD string (UTC date parts; no TZ drift).
 * @param {string} ymd
 * @param {number} deltaDays
 * @returns {string}
 */
function addCalendarDaysYmd(ymd, deltaDays) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + deltaDays));
  const p = (n) => String(n).padStart(2, '0');
  return `${dt.getUTCFullYear()}-${p(dt.getUTCMonth() + 1)}-${p(dt.getUTCDate())}`;
}

/**
 * Resolve active-days threshold: opts.activeDays > config.memoryActiveDays > 14.
 * @param {{ activeDays?: number, config?: object }} [opts]
 * @returns {number}
 */
function resolveActiveDays(opts = {}) {
  if (opts.activeDays != null && opts.activeDays !== '') {
    const n = Number(opts.activeDays);
    if (Number.isInteger(n) && n > 0) return n;
  }
  const data = opts.config != null ? opts.config : config.load();
  const raw = data && data.memoryActiveDays;
  if (raw != null && raw !== '') {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  return DEFAULT_ACTIVE_DAYS;
}

/**
 * @param {string|null|undefined} value
 * @returns {{ ms: number, ymd: string }|null}
 */
function activityFromTimestamp(value) {
  if (value == null || value === '') return null;
  const s = String(value).trim();
  if (!s) return null;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return null;
  const ymd = etDateYmd(new Date(ms));
  if (!ymd) return null;
  return { ms, ymd };
}

/**
 * @param {string} ymd
 * @returns {{ ms: number, ymd: string }|null}
 */
function activityFromYmd(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  return { ms, ymd: `${m[1]}-${m[2]}-${m[3]}` };
}

function newerActivity(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if (a.ms !== b.ms) return a.ms > b.ms ? a : b;
  return a.ymd >= b.ymd ? a : b;
}

/**
 * Newest of lastUsed / end / start / created on a registry session.
 * @param {object} session
 * @returns {{ ms: number, ymd: string }|null}
 */
function sessionLastActivity(session) {
  let best = null;
  for (const key of ['lastUsed', 'end', 'start', 'created']) {
    best = newerActivity(best, activityFromTimestamp(session && session[key]));
  }
  return best;
}

/**
 * Top-level project folders in the memory repo (dirs only; skip .git / hidden).
 * @param {string} repoPath
 * @returns {string[]}
 */
function listRepoProjectFolders(repoPath) {
  const out = [];
  try {
    if (!fs.existsSync(repoPath)) return out;
    for (const name of fs.readdirSync(repoPath)) {
      if (!name || name === '.git' || name.startsWith('.')) continue;
      try {
        if (fs.statSync(path.join(repoPath, name)).isDirectory()) out.push(name);
      } catch (_) {
        /* skip */
      }
    }
  } catch (_) {
    /* ignore */
  }
  return out.sort();
}

/**
 * Canonical folder name for a session's project (after sanitize).
 * @param {object} session
 * @param {object} [cache]
 * @returns {string|null}
 */
function sessionProjectFolder(session, cache) {
  try {
    return sanitizeFolderName(projectLib.resolveProjectName(session, { cache }));
  } catch (_) {
    return null;
  }
}

/**
 * Project folder names for the complete dashboard (repo folders ∪ registry).
 * Keys are sanitized folder names so `weird:name` and `weird-name` do not duplicate.
 * Excludes adhoc unless includeAdhoc or an adhoc folder already exists.
 * @param {object[]} sessions
 * @param {string} repoPath
 * @param {{ includeAdhoc?: boolean, cache?: object }} [opts]
 * @returns {string[]}
 */
function resolveDashboardProjects(sessions, repoPath, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  const includeAdhoc = Boolean(opts.includeAdhoc);
  const names = new Set(listRepoProjectFolders(repoPath));

  let adhocFolderExists = false;
  try {
    adhocFolderExists = names.has(sanitizeFolderName(projectLib.ADHOC_NAME));
  } catch (_) {
    adhocFolderExists = names.has(projectLib.ADHOC_NAME);
  }

  for (const s of sessions || []) {
    const raw = projectLib.resolveProjectName(s, { cache });
    if (raw === projectLib.ADHOC_NAME && !includeAdhoc && !adhocFolderExists) continue;
    const folder = sessionProjectFolder(s, cache);
    if (folder) names.add(folder);
  }

  return [...names].sort();
}

/**
 * Parse leading YYYY-MM-DD or YYYY-MM-DDTHHMM[SS] from a status-note filename.
 * @param {string} filename
 * @returns {{ ymd: string, sortKey: string }|null}
 */
function parseStatusNoteFilenameDate(filename) {
  const base = path.basename(String(filename || ''));
  const m = base.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?/);
  if (!m) return null;
  const ymd = m[1];
  const hh = m[2] || '00';
  const mm = m[3] || '00';
  const ss = m[4] || '00';
  return { ymd, sortKey: `${ymd}T${hh}${mm}${ss}\0${base}` };
}

function prettifyNoteSlug(filename) {
  let base = path.basename(String(filename || ''), '.md');
  base = base.replace(/^\d{4}-\d{2}-\d{2}(?:T\d{4,6})?-?/, '');
  base = base.replace(/[-_]+/g, ' ').trim();
  if (!base) return path.basename(String(filename || ''), '.md') || 'note';
  return base.charAt(0).toUpperCase() + base.slice(1);
}

/**
 * First markdown heading in file, else prettified filename slug.
 * @param {string} filePath
 * @param {string} filename
 * @returns {string}
 */
function statusNoteTitle(filePath, filename) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const m = raw.match(/^#\s+(.+?)\s*$/m);
    if (m) return m[1].trim();
  } catch (_) {
    /* ignore */
  }
  return prettifyNoteSlug(filename);
}

/**
 * Latest live status note (ignore archive/ and subdirs). Newest filename date wins.
 * @param {string} projectFolderAbs
 * @returns {{ file: string, ymd: string, title: string, activity: {ms:number,ymd:string} }|null}
 */
function latestStatusNote(projectFolderAbs) {
  const notesDir = path.join(projectFolderAbs, 'status-notes');
  let entries = [];
  try {
    if (!fs.existsSync(notesDir)) return null;
    entries = fs.readdirSync(notesDir);
  } catch (_) {
    return null;
  }
  let best = null;
  for (const name of entries) {
    if (!name || name.startsWith('.')) continue;
    if (name === 'archive') continue;
    const abs = path.join(notesDir, name);
    try {
      if (!fs.statSync(abs).isFile()) continue;
    } catch (_) {
      continue;
    }
    if (!/\.md$/i.test(name)) continue;
    const parsed = parseStatusNoteFilenameDate(name);
    if (!parsed) continue;
    const activity = activityFromYmd(parsed.ymd);
    if (!activity) continue;
    const cand = {
      file: name,
      ymd: parsed.ymd,
      sortKey: parsed.sortKey,
      activity,
      title: statusNoteTitle(abs, name),
    };
    if (
      !best ||
      cand.sortKey > best.sortKey ||
      (cand.sortKey === best.sortKey && cand.file < best.file)
    ) {
      best = cand;
    }
  }
  if (!best) return null;
  return {
    file: best.file,
    ymd: best.ymd,
    title: best.title,
    activity: best.activity,
  };
}

/**
 * Read `updated: YYYY-MM-DD` from per-project dashboard.md YAML frontmatter.
 * @param {string} projectFolderAbs
 * @returns {{ ms: number, ymd: string }|null}
 */
function readDashboardUpdatedActivity(projectFolderAbs) {
  const p = path.join(projectFolderAbs, 'dashboard.md');
  try {
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.startsWith('---')) return null;
    const end = raw.indexOf('\n---', 3);
    if (end === -1) return null;
    const fm = raw.slice(3, end);
    const m = fm.match(/^updated:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?\s*$/m);
    if (!m) return null;
    return activityFromYmd(m[1]);
  } catch (_) {
    return null;
  }
}

/**
 * Git last commit date touching project folder excluding `_aflt/`.
 * Uses %cI then converts to ET so host TZ does not affect the YMD.
 * @param {string} repoPath
 * @param {string} folder
 * @returns {{ ms: number, ymd: string }|null}
 */
function gitFolderLastActivity(repoPath, folder) {
  try {
    const r = gitRun(
      repoPath,
      [
        'log',
        '-1',
        '--format=%cI',
        '--',
        folder,
        `:!${folder}/${GENERATED_DIR}`,
        `:!${folder}/${GENERATED_DIR}/**`,
      ],
      { timeout: 15000 }
    );
    if (r.status !== 0) return null;
    const iso = String(r.stdout || '').trim();
    if (!iso) return null;
    return activityFromTimestamp(iso);
  } catch (_) {
    return null;
  }
}

/**
 * Deterministic last-activity for one project (no mtimes).
 * @returns {{ ms: number, ymd: string }|null}
 */
function computeProjectLastActivity(sessions, repoPath, projectName, folder, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  const folderAbs = path.join(repoPath, folder);
  const wantFolder = folder || (() => {
    try {
      return sanitizeFolderName(projectName);
    } catch (_) {
      return projectName;
    }
  })();
  let best = null;

  for (const s of sessions || []) {
    if (sessionProjectFolder(s, cache) !== wantFolder) continue;
    best = newerActivity(best, sessionLastActivity(s));
  }

  const note = latestStatusNote(folderAbs);
  if (note) best = newerActivity(best, note.activity);

  best = newerActivity(best, readDashboardUpdatedActivity(folderAbs));

  if (!best) {
    best = gitFolderLastActivity(repoPath, folder);
  }
  return best;
}

/**
 * Session counts using the same display-state rules as the live dashboard.
 * open = actually working (Herdr OSC status working, or live runPid); idle =
 * paused or active-but-not-working (including pane-alive herdr.runtime without
 * a working signal); total = all including done/failed.
 * Does not mutate the registry. Enrichment is optional (map or session.herdr).
 */
function projectSessionCounts(sessions, projectName, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  const enrichmentById = opts.enrichmentById || {};
  const isAlive = opts.isAlive;
  const wantName = projectLib.canonicalProjectName(projectName);
  let wantFolder;
  try {
    wantFolder = sanitizeFolderName(wantName);
  } catch (_) {
    wantFolder = wantName;
  }
  let open = 0;
  let idle = 0;
  let total = 0;
  for (const s of sessions || []) {
    if (sessionProjectFolder(s, cache) !== wantFolder) continue;
    total++;
    const enrichment = displayStateLib.enrichmentForSession(s, enrichmentById);
    const display = displayStateLib.deriveDisplayState(s, enrichment, { isAlive });
    if (display === 'running') open++;
    else if (display === 'idle') idle++;
  }
  return { open, idle, total };
}

/**
 * Best-effort read-only Herdr enrichment map. Never throws; never writes.
 * @param {object[]} sessions
 * @param {{ herdrFetch?: object, herdrOpts?: object }} [opts]
 * @returns {Record<string, object>}
 */
function loadEnrichmentById(sessions, opts = {}) {
  if (opts.enrichmentById && typeof opts.enrichmentById === 'object') {
    return opts.enrichmentById;
  }
  const out = {};
  try {
    let fetchResult = opts.herdrFetch;
    if (fetchResult == null) {
      fetchResult = herdr.fetchHerdrTerminals(opts.herdrOpts || {});
    }
    if (fetchResult && fetchResult.ok) {
      const enriched = herdr.enrichSessions(sessions || [], fetchResult);
      for (const e of enriched) {
        if (e && e.session && e.session.id) out[e.session.id] = e;
      }
    }
  } catch (_) {
    /* ignore — fall back to session.herdr / pid in counters */
  }
  return out;
}

/**
 * Extract doc-bot summary inner content (byte-for-byte) or null if markers missing.
 * @param {string|null|undefined} content
 * @returns {string|null}
 */
function extractDocBotSummaryInner(content) {
  if (content == null) return null;
  const text = String(content);
  const start = text.indexOf(DOC_BOT_SUMMARY_START);
  const end = text.indexOf(DOC_BOT_SUMMARY_END);
  if (start === -1 || end === -1 || end < start) return null;
  return text.slice(start + DOC_BOT_SUMMARY_START.length, end);
}

function docBotSummaryBlock(existingContent) {
  const inner = extractDocBotSummaryInner(existingContent);
  if (inner != null) {
    return `${DOC_BOT_SUMMARY_START}${inner}${DOC_BOT_SUMMARY_END}`;
  }
  return `${DOC_BOT_SUMMARY_START}\n${DOC_BOT_SUMMARY_PLACEHOLDER}\n${DOC_BOT_SUMMARY_END}`;
}

function compareProjectRows(a, b) {
  const aMs = a.activityMs;
  const bMs = b.activityMs;
  if (aMs == null && bMs == null) {
    return String(a.project).localeCompare(String(b.project));
  }
  if (aMs == null) return 1;
  if (bMs == null) return -1;
  if (aMs !== bMs) return bMs - aMs;
  return String(a.project).localeCompare(String(b.project));
}

/**
 * Build root DASHBOARD.md markdown (deterministic; no wall-clock stamp).
 * @param {object[]} sessions
 * @param {{
 *   repo?: { path: string, source?: string }|null,
 *   env?: NodeJS.ProcessEnv,
 *   redact?: boolean,
 *   activeDays?: number,
 *   now?: Date,
 *   includeAdhoc?: boolean,
 *   cache?: object,
 *   syncedFolders?: string[]|Set<string>,
 *   existingContent?: string|null,
 * }} [opts]
 * @returns {{
 *   md: string,
 *   path: string,
 *   activeDays: number,
 *   active: object[],
 *   dormant: object[],
 *   rows: object[],
 * }}
 */
function buildDashboard(sessions, opts = {}) {
  const resolved = opts.repo || resolveMemoryRepo(opts.env || process.env);
  if (!resolved) {
    const err = new Error(
      'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
    err.code = 'NO_REPO';
    throw err;
  }
  const repoPath = resolved.path;
  const cache = opts.cache || projectLib.createLookupCache();
  const doRedact = opts.redact !== false;
  const now = opts.now || new Date();
  const activeDays = resolveActiveDays(opts);
  const nowYmd = etDateYmd(now);
  const thresholdYmd = addCalendarDaysYmd(nowYmd, -activeDays);
  const syncedFolders = new Set(opts.syncedFolders || []);
  const enrichmentById = loadEnrichmentById(sessions, opts);
  const isAlive = opts.isAlive;

  let existingContent = opts.existingContent;
  if (existingContent === undefined) {
    try {
      const p = path.join(repoPath, DASHBOARD_REL);
      existingContent = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null;
    } catch (_) {
      existingContent = null;
    }
  }

  // Folder names are the canonical project keys (already sanitized).
  // Legacy alias folders (e.g. `af`) may still appear from the repo listing;
  // registry sessions alias to `aflt` and do not rewrite/delete `af/`.
  const projectFolders = resolveDashboardProjects(sessions, repoPath, {
    includeAdhoc: opts.includeAdhoc,
    cache,
  });

  const rows = [];
  for (const folder of projectFolders) {
    const projectName = folder;
    const folderAbs = path.join(repoPath, folder);
    const activity = computeProjectLastActivity(sessions, repoPath, projectName, folder, {
      cache,
    });
    const counts = projectSessionCounts(sessions, projectName, {
      cache,
      enrichmentById,
      isAlive,
    });
    const note = latestStatusNote(folderAbs);
    const timelineRel = path.join(folder, GENERATED_DIR, 'timeline.md').replace(/\\/g, '/');
    const timelineExists =
      syncedFolders.has(folder) || fs.existsSync(path.join(repoPath, timelineRel));

    const displayName = doRedact ? redactSensitive(projectName) : projectName;
    let noteTitle = null;
    let noteYmd = null;
    let noteFile = null;
    if (note) {
      noteTitle = doRedact ? redactSensitive(note.title) : note.title;
      noteYmd = note.ymd;
      noteFile = note.file;
    }

    const isActive = Boolean(activity && activity.ymd >= thresholdYmd);
    rows.push({
      project: projectName,
      displayName,
      folder,
      activityYmd: activity ? activity.ymd : null,
      activityMs: activity ? activity.ms : null,
      section: isActive ? 'active' : 'dormant',
      open: counts.open,
      idle: counts.idle,
      total: counts.total,
      noteTitle,
      noteYmd,
      noteFile,
      timelineRel: timelineExists ? timelineRel : null,
    });
  }

  const active = rows.filter((r) => r.section === 'active').sort(compareProjectRows);
  const dormant = rows.filter((r) => r.section === 'dormant').sort(compareProjectRows);

  const lines = [];
  lines.push('# aflt project memory dashboard');
  lines.push('');
  lines.push(
    `Active = activity within the last ${activeDays} days. Dates are America/New_York (ET).`
  );
  lines.push('');
  lines.push(docBotSummaryBlock(existingContent));
  lines.push('');
  lines.push('## Active');
  lines.push('');
  if (!active.length) {
    lines.push('_None._');
    lines.push('');
  } else {
    lines.push('| Project | Last activity (ET) | Sessions (open/idle/total) | Latest status note | Timeline |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of active) {
      const projCell = `[${r.displayName}](${r.folder}/)`;
      const last = r.activityYmd || 'no recorded activity';
      const sess = `${r.open}/${r.idle}/${r.total}`;
      let noteCell = '—';
      if (r.noteFile && r.noteTitle && r.noteYmd) {
        const href = `${r.folder}/status-notes/${r.noteFile}`;
        noteCell = `[${r.noteTitle}](${href}) (${r.noteYmd})`;
      }
      const tl = r.timelineRel ? `[timeline](${r.timelineRel})` : '—';
      lines.push(`| ${projCell} | ${last} | ${sess} | ${noteCell} | ${tl} |`);
    }
    lines.push('');
  }

  lines.push('## Dormant');
  lines.push('');
  if (!dormant.length) {
    lines.push('_None._');
    lines.push('');
  } else {
    lines.push('| Project | Last activity (ET) |');
    lines.push('| --- | --- |');
    for (const r of dormant) {
      const projCell = `[${r.displayName}](${r.folder}/)`;
      const last = r.activityYmd || 'no recorded activity';
      lines.push(`| ${projCell} | ${last} |`);
    }
    lines.push('');
  }

  const md = lines.join('\n').replace(/\s+$/, '') + '\n';
  return {
    md,
    path: DASHBOARD_REL,
    activeDays,
    active,
    dormant,
    rows,
  };
}

/**
 * Write root DASHBOARD.md (or dry-run).
 * @returns {{ path: string, changed: boolean, bytes: number, activeDays: number, active: number, dormant: number }}
 */
function writeDashboard(sessions, opts = {}) {
  const resolved = opts.repo || resolveMemoryRepo(opts.env || process.env);
  if (!resolved) {
    const err = new Error(
      'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
    err.code = 'NO_REPO';
    throw err;
  }
  if (!fs.existsSync(resolved.path)) {
    const err = new Error(`memory repo does not exist: ${resolved.path}`);
    err.code = 'MISSING_REPO';
    throw err;
  }
  const built = buildDashboard(sessions, { ...opts, repo: resolved });
  const abs = path.join(resolved.path, DASHBOARD_REL);
  const wrote = writeIfChanged(abs, built.md, { dryRun: Boolean(opts.dryRun) });
  return {
    path: DASHBOARD_REL,
    changed: wrote.changed,
    bytes: wrote.bytes,
    activeDays: built.activeDays,
    active: built.active.length,
    dormant: built.dormant.length,
  };
}

/**
 * Regenerate root DASHBOARD.md only (no per-project `_aflt/` writes).
 */
function syncDashboard(sessions, opts = {}) {
  const resolved = opts.repo || resolveMemoryRepo(opts.env || process.env);
  if (!resolved) {
    const err = new Error(
      'no memory repo configured. Run `aflt memory init <path>` or set AFLT_MEMORY_REPO.'
    );
    err.code = 'NO_REPO';
    throw err;
  }
  if (!fs.existsSync(resolved.path)) {
    const err = new Error(`memory repo does not exist: ${resolved.path}`);
    err.code = 'MISSING_REPO';
    throw err;
  }
  const dashboard = writeDashboard(sessions, { ...opts, repo: resolved });
  return {
    ok: true,
    repo: resolved.path,
    source: resolved.source,
    dashboard,
  };
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
 *   activeDays?: number,
 *   now?: Date,
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

  const syncedFolders = projectsOut.map((p) => p.folder);
  const dashboard = writeDashboard(sessions, {
    ...opts,
    repo: resolved,
    cache,
    syncedFolders,
    includeAdhoc: Boolean(opts.includeAdhoc),
  });

  return {
    ok: true,
    repo: repoPath,
    source: resolved.source,
    projects: projectsOut,
    dashboard,
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

function gitRun(repoPath, args, opts = {}) {
  return spawnSync('git', ['-C', repoPath, ...args], {
    encoding: 'utf8',
    timeout: opts.timeout != null ? opts.timeout : 30000,
    env: opts.env || process.env,
  });
}

function gitNameOnlyLines(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** Local calendar date YYYY-MM-DD for commit messages. */
function localDateYmd(now = new Date()) {
  const d = now instanceof Date ? now : new Date(now);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * True iff path is root `DASHBOARD.md` or `<one-segment>/_aflt/...` (posix separators).
 * Per-project `dashboard.md` is never generated/commit-eligible.
 * @param {string} relPath
 */
function isGeneratedRelPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (p === DASHBOARD_REL) return true;
  return new RegExp(`^[^/]+/${GENERATED_DIR}/`).test(p);
}

/**
 * True iff path is eligible for `aflt memory config --commit`
 * (root DASHBOARD.md or a template-managed root file). Never `.bak`.
 * @param {string} relPath
 */
function isConfigCommitRelPath(relPath) {
  const p = String(relPath || '').replace(/\\/g, '/');
  if (p === DASHBOARD_REL) return true;
  return MANAGED_ROOT_FILES.includes(p);
}

function stagedPaths(repoPath) {
  const r = gitRun(repoPath, ['diff', '--cached', '--name-only'], { timeout: 10000 });
  if (r.status !== 0) {
    const err = new Error(
      `git diff --cached failed: ${(r.stderr || r.stdout || '').trim() || 'unknown'}`
    );
    err.code = 'GIT_DIFF';
    throw err;
  }
  return gitNameOnlyLines(r.stdout);
}

function resolveUpstream(repoPath) {
  const r = gitRun(repoPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
    timeout: 10000,
  });
  if (r.status !== 0) return null;
  const name = String(r.stdout || '').trim();
  return name || null;
}

function aheadOfUpstreamCount(repoPath) {
  const r = gitRun(repoPath, ['rev-list', '--count', '@{u}..HEAD'], { timeout: 10000 });
  if (r.status !== 0) return null;
  const n = parseInt(String(r.stdout || '').trim(), 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * After sync or config: optionally commit eligible paths, then push.
 * Never stages human per-project README / dashboard.md / status-notes / .bak.
 * Never uses --no-verify / force / remote args.
 *
 * @param {string} repoPath
 * @param {{
 *   push?: boolean,
 *   now?: Date,
 *   mode?: 'generated'|'config',
 * }} [opts]
 * mode `generated` (default, sync): DASHBOARD.md + per-project generated `_aflt` trees.
 * mode `config`: DASHBOARD.md + template-managed root files.
 * @returns {{
 *   committed: boolean,
 *   hash: string|null,
 *   files: number|null,
 *   message: string|null,
 *   reason: string|null,
 *   push: null|{ pushed: boolean, upstream: string|null, reason: string|null },
 * }}
 */
function commitGenerated(repoPath, opts = {}) {
  const wantPush = Boolean(opts.push);
  const now = opts.now || new Date();
  const mode = opts.mode === 'config' ? 'config' : 'generated';

  if (!isGitRepo(repoPath)) {
    const err = new Error(`memory repo is not a git work tree: ${repoPath}`);
    err.code = 'NOT_GIT';
    throw err;
  }

  const preStaged = stagedPaths(repoPath);
  if (preStaged.length) {
    const err = new Error(
      `refusing to commit: index already has staged changes:\n${preStaged.map((p) => `  ${p}`).join('\n')}`
    );
    err.code = 'STAGED';
    err.staged = preStaged;
    throw err;
  }

  const pathspecs =
    mode === 'config'
      ? [DASHBOARD_REL, ...MANAGED_ROOT_FILES]
      : [`:(glob)*/${GENERATED_DIR}/**`, DASHBOARD_REL];
  const eligible =
    mode === 'config' ? isConfigCommitRelPath : isGeneratedRelPath;
  const expectedHint =
    mode === 'config'
      ? `${DASHBOARD_REL} or ${MANAGED_ROOT_FILES.join(' / ')}`
      : `${DASHBOARD_REL} or <project>/${GENERATED_DIR}/…`;

  const add = gitRun(repoPath, ['add', '-A', '--', ...pathspecs], { timeout: 30000 });
  if (add.status !== 0) {
    const err = new Error(
      `git add failed: ${(add.stderr || add.stdout || '').trim() || 'unknown'}`
    );
    err.code = 'GIT_ADD';
    throw err;
  }

  const staged = stagedPaths(repoPath);
  const unsafe = staged.filter((p) => !eligible(p));
  if (unsafe.length) {
    if (staged.length) {
      gitRun(repoPath, ['reset', '-q', '--', ...staged], { timeout: 15000 });
    }
    const err = new Error(
      `refusing to commit: unexpected staged paths (expected ${expectedHint}):\n${unsafe
        .map((p) => `  ${p}`)
        .join('\n')}`
    );
    err.code = 'UNSAFE_STAGED';
    err.staged = unsafe;
    throw err;
  }

  const message =
    mode === 'config'
      ? `memory: config ${localDateYmd(now)}`
      : `memory: sync ${localDateYmd(now)}`;
  let committed = false;
  let hash = null;
  let files = null;
  let reason = null;

  if (staged.length === 0) {
    committed = false;
    reason = 'no changes';
  } else {
    const commit = gitRun(repoPath, ['commit', '-m', message], { timeout: 60000 });
    if (commit.status !== 0) {
      // Leave index as-is so the operator can inspect; paths are eligible-only.
      const err = new Error(
        `git commit failed: ${(commit.stderr || commit.stdout || '').trim() || 'unknown'}`
      );
      err.code = 'GIT_COMMIT';
      throw err;
    }
    const rev = gitRun(repoPath, ['rev-parse', '--short', 'HEAD'], { timeout: 10000 });
    hash = rev.status === 0 ? String(rev.stdout || '').trim() || null : null;
    committed = true;
    files = staged.length;
    reason = null;
  }

  let pushResult = null;
  if (wantPush) {
    const upstream = resolveUpstream(repoPath);
    const ahead = upstream != null ? aheadOfUpstreamCount(repoPath) : null;
    const shouldPush = committed || (ahead != null && ahead > 0);

    if (!upstream) {
      pushResult = { pushed: false, upstream: null, reason: 'no upstream' };
    } else if (!shouldPush) {
      pushResult = { pushed: false, upstream, reason: 'nothing to push' };
    } else {
      const push = gitRun(repoPath, ['push'], { timeout: 120000 });
      if (push.status !== 0) {
        const summary = (push.stderr || push.stdout || '').trim() || 'git push failed';
        pushResult = { pushed: false, upstream, reason: summary };
      } else {
        pushResult = { pushed: true, upstream, reason: null };
      }
    }
  }

  return {
    committed,
    hash,
    files,
    message: committed ? message : null,
    reason,
    push: pushResult,
  };
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
    registryProjects.add(projectLib.canonicalProjectName(name));
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
  DASHBOARD_REL,
  DOC_AGENT_REL,
  PROCESS_DOC_REL,
  MANAGED_ROOT_FILES,
  DEFAULT_ACTIVE_DAYS,
  MEMORY_TZ,
  DOC_BOT_SUMMARY_START,
  DOC_BOT_SUMMARY_END,
  DOC_BOT_SUMMARY_PLACEHOLDER,
  MARKER_NAME,
  MARKER_VERSION,
  ROOT_README,
  redactSensitive,
  sanitizeFolderName,
  resolveMemoryRepo,
  isMemoryRepo,
  isGitRepo,
  initMemoryRepo,
  readDocAgentTemplate,
  readProcessDocTemplate,
  readPackageTemplate,
  shortDiffSummary,
  inspectManagedRootFile,
  inspectMemoryConfig,
  doctorDocAgentStatus,
  configMemory,
  registerMemoryRepo,
  syncMemory,
  syncDashboard,
  buildDashboard,
  writeDashboard,
  resolveActiveDays,
  resolveDashboardProjects,
  etDateYmd,
  addCalendarDaysYmd,
  extractDocBotSummaryInner,
  memoryStatus,
  commitGenerated,
  isGeneratedRelPath,
  isConfigCommitRelPath,
  localDateYmd,
  buildProjectArtifacts,
  writeIfChanged,
  resolveSyncProjects,
  cwdDisplay,
  parseCommitLine,
  listRepoProjectFolders,
  latestStatusNote,
  computeProjectLastActivity,
  projectSessionCounts,
  loadEnrichmentById,
};
