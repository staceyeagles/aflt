'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { fleetDir, nowIso, resolveCwd } = require('./util');
const messages = require('./messages');
const orchestrate = require('./orchestrate');

/** Base defaults; CHANGELOG.md is added only when present or explicitly listed. */
const DEFAULT_DOCS_PATHS_BASE = ['README.md', 'docs/'];
/** @deprecated alias — prefer resolveDocsPaths() which may omit CHANGELOG.md */
const DEFAULT_DOCS_PATHS = ['README.md', 'docs/', 'CHANGELOG.md'];
const CHANGELOG_NAMES = new Set(['CHANGELOG.md', 'CHANGELOG', 'changelog.md', 'Changelog.md']);
const DIFF_TRUNCATE_BYTES = 60 * 1024;
const EXCERPT_MAX = 800;
/** Per-file cap for docsInstructions injection (bytes). */
const DOCS_INSTRUCTIONS_FILE_MAX = 16 * 1024;
/** Total cap across all docsInstructions files (bytes). */
const DOCS_INSTRUCTIONS_TOTAL_MAX = 48 * 1024;
/** Max short commit subjects shown in `aflt docs --status`. */
const STATUS_COMMIT_LIST_MAX = 10;

const DOCS_NOT_ENABLED = (dir) =>
  `docs not enabled for ${dir} (add {"docs": true} to .agentfleet.json)`;

function changelogExists(projectRoot) {
  try {
    const p = path.join(path.resolve(projectRoot), 'CHANGELOG.md');
    return fs.existsSync(p) && fs.statSync(p).isFile();
  } catch (_) {
    return false;
  }
}

function isChangelogPath(relPath) {
  const base = path.basename(String(relPath || '').replace(/\\/g, '/'));
  return CHANGELOG_NAMES.has(base) || /^changelog(\.|$)/i.test(base);
}

/**
 * Resolve effective docsPaths for a project.
 * - Explicit `docsPaths` in config wins as-is (including CHANGELOG.md if listed).
 * - Default: README.md + docs/ + CHANGELOG.md only if CHANGELOG.md already exists.
 */
function resolveDocsPaths(projectRoot, { explicitPaths } = {}) {
  if (Array.isArray(explicitPaths) && explicitPaths.length) {
    return explicitPaths.map((p) => String(p).trim()).filter(Boolean);
  }
  const paths = DEFAULT_DOCS_PATHS_BASE.slice();
  if (changelogExists(projectRoot)) paths.push('CHANGELOG.md');
  return paths;
}

/**
 * Whether the worker may create/edit a changelog under the effective docsPaths.
 */
function changelogAllowed(docsPaths) {
  return (docsPaths || []).some((p) => isChangelogPath(p) || String(p).replace(/\\/g, '/') === 'CHANGELOG.md');
}

function docsDir() {
  return path.join(fleetDir(), 'docs');
}

function projectRootHash(projectRoot) {
  return crypto.createHash('sha256').update(path.resolve(String(projectRoot))).digest('hex').slice(0, 16);
}

function statePath(projectRoot) {
  return path.join(docsDir(), `${projectRootHash(projectRoot)}.json`);
}

function git(cwd, args, { timeoutMs = 30000 } = {}) {
  const r = spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 20 * 1024 * 1024,
  });
  return {
    status: r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || '',
    error: r.error || null,
  };
}

function resolveGitRoot(cwd) {
  const dir = resolveCwd(cwd || process.cwd());
  const r = git(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 5000 });
  if (r.status !== 0) {
    const err = new Error(`not a git repository: ${dir}`);
    err.code = 'NOT_GIT';
    throw err;
  }
  return path.resolve(String(r.stdout).trim());
}

function headCommit(cwd) {
  const r = git(cwd, ['rev-parse', 'HEAD'], { timeoutMs: 5000 });
  if (r.status !== 0) return null;
  return String(r.stdout).trim() || null;
}

function commitCount(cwd) {
  const r = git(cwd, ['rev-list', '--count', 'HEAD'], { timeoutMs: 10000 });
  if (r.status !== 0) return 0;
  const n = Number(String(r.stdout).trim());
  return Number.isFinite(n) ? n : 0;
}

function rootCommit(cwd) {
  const r = git(cwd, ['rev-list', '--max-parents=0', 'HEAD'], { timeoutMs: 10000 });
  if (r.status !== 0) return null;
  const lines = String(r.stdout)
    .trim()
    .split(/\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[0] || null;
}

function loadState(projectRoot) {
  const p = statePath(projectRoot);
  try {
    if (!fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    return data;
  } catch (_) {
    return null;
  }
}

function saveState(projectRoot, state) {
  const dir = docsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = statePath(projectRoot);
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify(
    {
      projectRoot: path.resolve(String(projectRoot)),
      lastRunAt: state.lastRunAt || nowIso(),
      lastCommit: state.lastCommit || null,
      lastSessionId: state.lastSessionId || null,
      lastChangedFiles: Array.isArray(state.lastChangedFiles) ? state.lastChangedFiles.map(String) : [],
      lastWarnings: Array.isArray(state.lastWarnings) ? state.lastWarnings.map(String) : [],
    },
    null,
    2
  );
  fs.writeFileSync(tmp, body + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
  return p;
}

/**
 * Normalize raw `docsInstructions` from config: string → one-element array; array as-is.
 * @returns {string[]}
 */
function normalizeDocsInstructionsList(raw) {
  if (raw == null) return [];
  if (typeof raw === 'string') {
    const s = raw.trim();
    return s ? [s] : [];
  }
  if (Array.isArray(raw)) {
    return raw.map((p) => String(p == null ? '' : p).trim()).filter(Boolean);
  }
  return [];
}

/**
 * Expand `~` / `~/…` via os.homedir() (respects HOME in tests), then resolve
 * relative paths against projectRoot. Absolute paths are path.resolve'd.
 */
function resolveInstructionPath(entry, projectRoot) {
  let s = String(entry == null ? '' : entry).trim();
  if (!s) return '';
  if (s === '~') {
    s = os.homedir();
  } else if (s.startsWith('~/') || s.startsWith('~' + path.sep)) {
    s = path.join(os.homedir(), s.slice(2));
  }
  if (path.isAbsolute(s)) return path.resolve(s);
  return path.resolve(String(projectRoot), s);
}

function truncateUtf8(text, maxBytes) {
  const s = String(text == null ? '' : text);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) {
    return { text: s, truncated: false, bytes: buf.length };
  }
  let cut = s;
  while (Buffer.from(cut, 'utf8').length > maxBytes) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  // Leave room for the marker when possible
  const marker = '\n\n[truncated]\n';
  const markerBytes = Buffer.byteLength(marker, 'utf8');
  const budget = Math.max(0, maxBytes - markerBytes);
  while (Buffer.from(cut, 'utf8').length > budget) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return { text: cut + marker, truncated: true, bytes: buf.length };
}

/**
 * Resolve and read docsInstructions files for prompt injection / status / dry-run.
 * Missing/unreadable/non-file entries are skipped with a WARNING (never fail).
 * Per-file and total size caps apply; truncated content gets a visible [truncated] marker.
 *
 * @param {string} projectRoot
 * @param {string|string[]|null|undefined} rawList
 * @param {{ warn?: (msg: string) => void, fileMax?: number, totalMax?: number }} [opts]
 * @returns {{
 *   used: Array<{ path: string, bytes: number, truncated: boolean, content: string }>,
 *   skipped: Array<{ path: string, reason: string }>,
 *   section: string
 * }}
 */
function resolveDocsInstructions(projectRoot, rawList, opts = {}) {
  const warn =
    typeof opts.warn === 'function'
      ? opts.warn
      : (msg) => {
          try {
            process.stderr.write(`WARNING: ${msg}\n`);
          } catch (_) {
            /* ignore */
          }
        };
  const fileMax =
    opts.fileMax != null && Number.isFinite(Number(opts.fileMax))
      ? Math.max(0, Number(opts.fileMax))
      : DOCS_INSTRUCTIONS_FILE_MAX;
  const totalMax =
    opts.totalMax != null && Number.isFinite(Number(opts.totalMax))
      ? Math.max(0, Number(opts.totalMax))
      : DOCS_INSTRUCTIONS_TOTAL_MAX;

  const entries = normalizeDocsInstructionsList(rawList);
  const used = [];
  const skipped = [];
  let totalUsed = 0;

  for (const entry of entries) {
    let abs;
    try {
      abs = resolveInstructionPath(entry, projectRoot);
    } catch (err) {
      const reason = `unresolvable: ${err && err.message ? err.message : String(err)}`;
      skipped.push({ path: entry, reason });
      warn(`docsInstructions skipped (${entry}): ${reason}`);
      continue;
    }
    if (!abs) {
      skipped.push({ path: entry, reason: 'empty path' });
      warn(`docsInstructions skipped (${entry}): empty path`);
      continue;
    }
    let st;
    try {
      if (!fs.existsSync(abs)) {
        skipped.push({ path: abs, reason: 'missing' });
        warn(`docsInstructions skipped (${abs}): missing`);
        continue;
      }
      st = fs.statSync(abs);
    } catch (err) {
      const reason = `unreadable: ${err && err.message ? err.message : String(err)}`;
      skipped.push({ path: abs, reason });
      warn(`docsInstructions skipped (${abs}): ${reason}`);
      continue;
    }
    if (!st.isFile()) {
      skipped.push({ path: abs, reason: 'not a file' });
      warn(`docsInstructions skipped (${abs}): not a file`);
      continue;
    }
    if (totalUsed >= totalMax) {
      const reason = `total cap (${totalMax} bytes) exceeded`;
      skipped.push({ path: abs, reason });
      warn(`docsInstructions skipped (${abs}): ${reason}`);
      continue;
    }
    let raw;
    try {
      raw = fs.readFileSync(abs, 'utf8');
    } catch (err) {
      const reason = `unreadable: ${err && err.message ? err.message : String(err)}`;
      skipped.push({ path: abs, reason });
      warn(`docsInstructions skipped (${abs}): ${reason}`);
      continue;
    }
    const remaining = totalMax - totalUsed;
    const cap = Math.min(fileMax, remaining);
    const trunc = truncateUtf8(raw, cap);
    if (trunc.truncated) {
      warn(
        `docsInstructions truncated (${abs}): original ${trunc.bytes} bytes, cap ${cap} (fileMax=${fileMax}, remaining=${remaining})`
      );
    }
    const contentBytes = Buffer.byteLength(trunc.text, 'utf8');
    totalUsed += contentBytes;
    used.push({
      path: abs,
      bytes: trunc.bytes, // original file size (utf8); truncated content may be smaller
      truncated: trunc.truncated,
      content: trunc.text,
    });
  }

  let section = '';
  if (used.length) {
    const parts = [
      '## Project-specific documentation instructions',
      '',
      'These supplement the built-in documentarian rules. The worker must still only edit files under docsPaths.',
      '',
    ];
    for (const u of used) {
      parts.push(`### From \`${u.path}\``);
      parts.push('');
      parts.push(u.content);
      parts.push('');
    }
    section = parts.join('\n');
  }

  return { used, skipped, section };
}

/**
 * @returns {{
 *   enabled: boolean,
 *   docsPaths: string[],
 *   docsInstructions: string[],
 *   docsEngine: string|null,
 *   docsForce: boolean|null,
 *   changelogAllowed: boolean,
 *   explicitDocsPaths: boolean,
 *   configDir: string|null,
 *   configPath: string|null
 * }}
 */
function readProjectDocs(cwd) {
  let projectRoot;
  try {
    projectRoot = resolveGitRoot(cwd);
  } catch (_) {
    try {
      projectRoot = path.resolve(cwd || process.cwd());
    } catch (_) {
      projectRoot = process.cwd();
    }
  }
  const hit = messages.findProjectConfig(cwd, { key: 'docs' });
  if (!hit) {
    const docsPaths = resolveDocsPaths(projectRoot);
    return {
      enabled: false,
      docsPaths,
      docsInstructions: [],
      docsEngine: null,
      docsForce: null,
      changelogAllowed: changelogAllowed(docsPaths),
      explicitDocsPaths: false,
      configDir: null,
      configPath: null,
    };
  }
  const data = hit.data;
  const explicit =
    Array.isArray(data.docsPaths) && data.docsPaths.length
      ? data.docsPaths.map((p) => String(p).trim()).filter(Boolean)
      : null;
  const docsPaths = resolveDocsPaths(projectRoot, { explicitPaths: explicit });
  let docsEngine = null;
  if (data.docsEngine != null && String(data.docsEngine).trim() !== '') {
    docsEngine = String(data.docsEngine).trim();
  }
  let docsForce = null;
  if (Object.prototype.hasOwnProperty.call(data, 'docsForce')) {
    docsForce = data.docsForce === true ? true : data.docsForce === false ? false : null;
  }
  const docsInstructions = normalizeDocsInstructionsList(data.docsInstructions);
  return {
    enabled: data.docs === true,
    docsPaths,
    docsInstructions,
    docsEngine,
    docsForce,
    changelogAllowed: changelogAllowed(docsPaths),
    explicitDocsPaths: Boolean(explicit),
    configDir: hit.dir,
    configPath: hit.path,
  };
}

/**
 * Resolve force for a docs run.
 * Precedence: --no-force → false; --force → true; project docsForce === false → false; else true.
 */
function resolveDocsForce(flags = {}, project = {}) {
  if (flags['no-force']) return false;
  if (flags.force === true || flags.force === '') return true;
  if (project && project.docsForce === false) return false;
  if (project && project.docsForce === true) return true;
  return true;
}

function isDocsEnabled(cwd) {
  return readProjectDocs(cwd).enabled;
}

function docsTitleFor(projectRoot) {
  const base = path.basename(path.resolve(projectRoot)) || 'project';
  return `docs-${base}`;
}

/**
 * Resolve since commit: --since wins; else lastCommit from state; else HEAD~1 / root.
 * @returns {{ since: string|null, source: 'flag'|'state'|'parent'|'root'|'none', head: string|null }}
 */
function resolveSince(projectRoot, { sinceFlag, state } = {}) {
  const head = headCommit(projectRoot);
  if (sinceFlag != null && String(sinceFlag).trim() !== '' && sinceFlag !== true) {
    return { since: String(sinceFlag).trim(), source: 'flag', head };
  }
  const st = state || loadState(projectRoot);
  if (st && st.lastCommit) {
    return { since: String(st.lastCommit), source: 'state', head };
  }
  const n = commitCount(projectRoot);
  if (n <= 1) {
    const root = rootCommit(projectRoot);
    return { since: root || head, source: n <= 0 ? 'none' : 'root', head };
  }
  const r = git(projectRoot, ['rev-parse', 'HEAD~1'], { timeoutMs: 5000 });
  if (r.status === 0 && String(r.stdout).trim()) {
    return { since: String(r.stdout).trim(), source: 'parent', head };
  }
  return { since: rootCommit(projectRoot) || head, source: 'root', head };
}

function truncateText(text, maxBytes = DIFF_TRUNCATE_BYTES) {
  const s = String(text == null ? '' : text);
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) {
    return { text: s, truncated: false, bytes: buf.length };
  }
  let cut = s;
  while (Buffer.from(cut, 'utf8').length > maxBytes) {
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return {
    text: cut + '\n\n… [truncated; run `git diff` yourself for the rest]\n',
    truncated: true,
    bytes: buf.length,
  };
}

function gatherDiffs(projectRoot, since) {
  let diffStat = '(no since commit — showing uncommitted only)\n';
  let diffBody = '';
  let diffNote = '';
  if (since) {
    const st = git(projectRoot, ['diff', '--stat', `${since}..HEAD`]);
    diffStat = st.status === 0 ? st.stdout || '(empty)\n' : `(git diff --stat failed: ${st.stderr.trim() || st.status})\n`;
    const full = git(projectRoot, ['diff', `${since}..HEAD`]);
    const raw = full.status === 0 ? full.stdout || '' : `(git diff failed: ${full.stderr.trim() || full.status})\n`;
    const trunc = truncateText(raw);
    diffBody = trunc.text || '(empty)\n';
    if (trunc.truncated) {
      diffNote = `Diff truncated to ~${DIFF_TRUNCATE_BYTES} bytes (full was ${trunc.bytes} bytes). Run \`git diff ${since}..HEAD\` yourself for the rest.`;
    }
  }
  const unc = git(projectRoot, ['diff', 'HEAD']);
  const uncRaw = unc.status === 0 ? unc.stdout || '' : `(git diff HEAD failed: ${unc.stderr.trim() || unc.status})\n`;
  const uncTrunc = truncateText(uncRaw);
  return {
    diffStat,
    diff: diffBody,
    diffNote,
    uncommitted: uncTrunc.text || '(empty)\n',
    uncommittedTruncated: uncTrunc.truncated,
  };
}

function fileSha256(filePath) {
  try {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  } catch (_) {
    return null;
  }
}

/**
 * Snapshot working tree: porcelain lines + hashes of dirty paths.
 */
function snapshotWorkingTree(projectRoot) {
  const r = git(projectRoot, ['status', '--porcelain', '-uall']);
  const porcelain = r.status === 0 ? String(r.stdout || '') : '';
  const files = {};
  for (const line of porcelain.split(/\n/)) {
    if (!line.trim()) continue;
    // XY PATH or XY ORIG -> PATH
    let rel = line.slice(3);
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop();
    rel = rel.replace(/^"|"$/g, '').trim();
    if (!rel) continue;
    const abs = path.join(projectRoot, rel);
    files[rel] = fileSha256(abs);
  }
  return { porcelain, files, at: nowIso() };
}

/**
 * Paths whose content/presence changed vs a prior snapshot (relative to projectRoot).
 */
function changedPathsSince(projectRoot, before) {
  const after = snapshotWorkingTree(projectRoot);
  const keys = new Set([
    ...Object.keys((before && before.files) || {}),
    ...Object.keys(after.files || {}),
  ]);
  const changed = [];
  for (const rel of keys) {
    const a = before && before.files ? before.files[rel] : undefined;
    const b = after.files[rel];
    if (a !== b) changed.push(rel);
  }
  return { changed, after };
}

function normalizeDocsPathEntry(entry) {
  let s = String(entry || '').trim().replace(/\\/g, '/');
  if (!s) return '';
  return s;
}

/**
 * True if relPath is covered by a docsPaths entry (file or directory prefix).
 */
function isDocsPath(relPath, docsPaths) {
  const rel = String(relPath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '');
  if (!rel) return false;
  for (const raw of docsPaths || []) {
    let p = normalizeDocsPathEntry(raw);
    if (!p) continue;
    if (p.endsWith('/')) {
      const prefix = p;
      if (rel === p.slice(0, -1) || rel.startsWith(prefix)) return true;
    } else if (rel === p) {
      return true;
    } else if (rel.startsWith(p + '/')) {
      // treat bare "docs" as directory too when matching nested files
      return true;
    }
  }
  return false;
}

function classifyChangedFiles(changedRels, docsPaths) {
  const docFiles = [];
  const nonDocFiles = [];
  for (const rel of changedRels || []) {
    if (isDocsPath(rel, docsPaths)) docFiles.push(rel);
    else nonDocFiles.push(rel);
  }
  return { docFiles, nonDocFiles };
}

function shortExcerpt(text, max = EXCERPT_MAX) {
  const s = String(text == null ? '' : text).trim();
  if (!s) return '(empty)';
  if (s.length <= max) return s;
  return s.slice(0, max) + '\n…';
}

/**
 * Sessions whose cwd is inside projectRoot and whose result file changed since lastRunAt.
 */
function gatherHandoffNotes(projectRoot, { lastRunAt, sessions } = {}) {
  const root = path.resolve(projectRoot);
  const list = Array.isArray(sessions) ? sessions : [];
  const cutoff = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const notes = [];
  for (const s of list) {
    if (!s || !s.cwd) continue;
    const cwd = path.resolve(String(s.cwd));
    if (cwd !== root && !orchestrate.isPathInside(cwd, root)) continue;
    if (s.role === 'docs') continue;
    const resultPath = s.result;
    if (!resultPath || !fs.existsSync(resultPath)) continue;
    let mtimeMs;
    try {
      mtimeMs = fs.statSync(resultPath).mtimeMs;
    } catch (_) {
      continue;
    }
    if (Number.isFinite(cutoff) && mtimeMs < cutoff) continue;
    let body = '';
    try {
      body = fs.readFileSync(resultPath, 'utf8');
    } catch (_) {
      body = '';
    }
    notes.push({
      id: s.id,
      title: s.title,
      role: s.role || null,
      result: resultPath,
      excerpt: shortExcerpt(body),
    });
  }
  return notes;
}

function formatHandoffNotes(notes) {
  if (!notes || !notes.length) return '(none)\n';
  return (
    notes
      .map(
        (n) =>
          `#### ${n.title || n.id} (${n.id}${n.role ? `, role=${n.role}` : ''})\n` +
          `- path: \`${n.result}\`\n\n${n.excerpt}\n`
      )
      .join('\n') + '\n'
  );
}

function changelogPolicyText(allowed) {
  if (allowed) {
    return [
      'CHANGELOG: **allowed**. `CHANGELOG.md` is in the docs paths (or already existed and was included).',
      'You may add a factual entry when the since..HEAD changes warrant it. Do not invent releases.',
    ].join(' ');
  }
  return [
    'CHANGELOG: **not allowed**. Do **not** create or edit `CHANGELOG.md` (or any changelog).',
    'It is not in the docs paths for this run.',
  ].join(' ');
}

function buildPrompt(projectRoot, opts = {}) {
  const docsPaths =
    opts.docsPaths ||
    resolveDocsPaths(projectRoot, { explicitPaths: opts.explicitDocsPaths || null });
  const changelogOk =
    opts.changelogAllowed != null ? Boolean(opts.changelogAllowed) : changelogAllowed(docsPaths);
  const sinceInfo = opts.sinceInfo || resolveSince(projectRoot, { sinceFlag: opts.since, state: opts.state });
  const diffs = opts.diffs || gatherDiffs(projectRoot, sinceInfo.since);
  const notes =
    opts.handoffNotes ||
    gatherHandoffNotes(projectRoot, {
      lastRunAt: opts.state && opts.state.lastRunAt,
      sessions: opts.sessions,
    });
  const resultPath = opts.resultPath || '';
  const tpl = opts.template || orchestrate.loadDocumentarianTemplate();
  let prompt = orchestrate.renderTemplate(tpl, {
    CWD: projectRoot,
    DOCS_PATHS: docsPaths.map((p) => `\`${p}\``).join(', '),
    CHANGELOG_POLICY: changelogPolicyText(changelogOk),
    SINCE: sinceInfo.since || '(none)',
    RESULT: resultPath,
    DIFF_STAT: diffs.diffStat.trimEnd(),
    DIFF: String(diffs.diff || '').trimEnd() || '(empty)',
    DIFF_NOTE: diffs.diffNote || '',
    UNCOMMITTED: String(diffs.uncommitted || '').trimEnd() || '(empty)',
    HANDOFF_NOTES: formatHandoffNotes(notes).trimEnd(),
  });
  const instructions =
    opts.instructions ||
    resolveDocsInstructions(projectRoot, opts.docsInstructions || [], {
      warn: opts.warn,
    });
  if (instructions && instructions.section) {
    prompt = String(prompt).replace(/\s*$/, '') + '\n\n' + instructions.section.replace(/^\s+/, '');
  }
  return {
    prompt,
    sinceInfo,
    diffs,
    handoffNotes: notes,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    changelogAllowed: changelogOk,
    docsPaths,
    instructions,
  };
}

/**
 * True if git can resolve `commit` (object exists) in this repo.
 */
function commitExists(cwd, commit) {
  if (!commit) return false;
  const r = git(cwd, ['cat-file', '-e', `${commit}^{commit}`], { timeoutMs: 5000 });
  return r.status === 0;
}

/**
 * Commits after `since` (exclusive) up to HEAD.
 * When `since` is null/empty: counts all commits on HEAD (no prior docs run).
 * When `since` is unknown to git: `{ unknown: true, count: null, commits: [] }`.
 *
 * @returns {{
 *   count: number|null,
 *   commits: string[],
 *   unknown: boolean,
 *   source: 'since'|'all'|'none'
 * }}
 */
function listCommitsSince(projectRoot, since) {
  const head = headCommit(projectRoot);
  if (!head) {
    return { count: 0, commits: [], unknown: false, source: 'none' };
  }
  if (since != null && String(since).trim() !== '') {
    const rev = String(since).trim();
    if (!commitExists(projectRoot, rev)) {
      return { count: null, commits: [], unknown: true, source: 'since' };
    }
    const range = `${rev}..HEAD`;
    const countR = git(projectRoot, ['rev-list', '--count', range], { timeoutMs: 10000 });
    const count =
      countR.status === 0 ? Number(String(countR.stdout).trim()) : null;
    const logR = git(
      projectRoot,
      ['log', `--max-count=${STATUS_COMMIT_LIST_MAX}`, '--format=%h %s', range],
      { timeoutMs: 10000 }
    );
    const commits =
      logR.status === 0
        ? String(logR.stdout)
            .trim()
            .split(/\n/)
            .map((l) => l.trim())
            .filter(Boolean)
        : [];
    return {
      count: Number.isFinite(count) ? count : null,
      commits,
      unknown: false,
      source: 'since',
    };
  }
  // No last run: count all commits on HEAD (documentarian has never recorded a since).
  const countR = git(projectRoot, ['rev-list', '--count', 'HEAD'], { timeoutMs: 10000 });
  const count = countR.status === 0 ? Number(String(countR.stdout).trim()) : null;
  const logR = git(
    projectRoot,
    ['log', `--max-count=${STATUS_COMMIT_LIST_MAX}`, '--format=%h %s', 'HEAD'],
    { timeoutMs: 10000 }
  );
  const commits =
    logR.status === 0
      ? String(logR.stdout)
          .trim()
          .split(/\n/)
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  return {
    count: Number.isFinite(count) ? count : null,
    commits,
    unknown: false,
    source: 'all',
  };
}

/**
 * Uncommitted / untracked paths under docsPaths (`git status --porcelain`).
 * @returns {string[]}
 */
function dirtyDocsPaths(projectRoot, docsPaths) {
  const r = git(projectRoot, ['status', '--porcelain', '-uall'], { timeoutMs: 10000 });
  if (r.status !== 0) return [];
  const dirty = [];
  for (const line of String(r.stdout || '').split(/\n/)) {
    if (!line.trim()) continue;
    let rel = line.slice(3);
    if (rel.includes(' -> ')) rel = rel.split(' -> ').pop();
    rel = rel.replace(/^"|"$/g, '').trim();
    if (!rel) continue;
    // Finder metadata is never a real docs edit.
    if (path.posix.basename(rel.replace(/\\/g, '/')) === '.DS_Store') continue;
    if (isDocsPath(rel, docsPaths)) dirty.push(rel);
  }
  return dirty;
}

/**
 * Distinct project directories from registry sessions (session.cwd), resolved to
 * git roots when possible. Missing / non-git paths are still returned as
 * resolved cwd strings for status error reporting.
 * @param {Array<{ cwd?: string }>} sessions
 * @returns {string[]}
 */
function projectDirsFromSessions(sessions) {
  const seen = new Set();
  const out = [];
  for (const s of sessions || []) {
    if (!s || !s.cwd) continue;
    let abs;
    try {
      abs = path.resolve(String(s.cwd));
    } catch (_) {
      continue;
    }
    let key = abs;
    try {
      if (fs.existsSync(abs)) {
        key = resolveGitRoot(abs);
      }
    } catch (_) {
      /* keep abs */
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

/**
 * Read-only docs status for one project directory.
 * Dirty docs under docsPaths are reported but do **not** set needsDocs (and
 * do not block `aflt docs` — the current documentarian has no dirty-tree guard).
 *
 * needsDocs = docsEnabled && (no lastRun || commitsSince.count > 0 || unknown lastCommit)
 *
 * When there is no last run, commitsSince counts all commits on HEAD (`source: 'all'`).
 *
 * @returns {object}
 */
function collectProjectDocsStatus(dir, opts = {}) {
  const warn = typeof opts.warn === 'function' ? opts.warn : () => {};
  let resolved;
  try {
    resolved = path.resolve(dir || process.cwd());
  } catch (err) {
    return {
      root: String(dir || ''),
      error: err && err.message ? err.message : String(err),
    };
  }
  if (!fs.existsSync(resolved)) {
    return { root: resolved, error: `path does not exist: ${resolved}` };
  }
  let projectRoot;
  try {
    projectRoot = resolveGitRoot(resolved);
  } catch (err) {
    return {
      root: resolved,
      error: err && err.message ? err.message : String(err),
    };
  }

  const project = readProjectDocs(projectRoot);
  const instructions = resolveDocsInstructions(projectRoot, project.docsInstructions, {
    warn,
  });
  const state = loadState(projectRoot);
  const head = headCommit(projectRoot);
  const lastRun = state
    ? {
        at: state.lastRunAt || null,
        commit: state.lastCommit || null,
      }
    : null;
  const sinceList = listCommitsSince(projectRoot, lastRun && lastRun.commit ? lastRun.commit : null);
  const dirtyDocs = dirtyDocsPaths(projectRoot, project.docsPaths);
  const docsEnabled = project.enabled === true;
  const needsDocs =
    docsEnabled &&
    (!lastRun ||
      sinceList.unknown === true ||
      (sinceList.count != null && sinceList.count > 0));
  const skip = dirtyDocs.length > 0;

  return {
    root: projectRoot,
    docsEnabled,
    docsPaths: project.docsPaths,
    docsInstructions: {
      raw: project.docsInstructions.slice(),
      used: instructions.used.map((u) => ({
        path: u.path,
        bytes: u.bytes,
        truncated: u.truncated,
      })),
      skipped: instructions.skipped.map((s) => ({
        path: s.path,
        reason: s.reason,
      })),
    },
    lastRun,
    headCommit: head,
    commitsSince: {
      count: sinceList.count,
      commits: sinceList.commits,
      unknown: sinceList.unknown,
      source: sinceList.source,
    },
    dirtyDocs,
    needsDocs,
    // Doc Bot rule: never run a docs pass over uncommitted docs edits.
    skip,
    skipReason: skip ? 'dirty-docs' : null,
    skipFiles: skip ? dirtyDocs.slice() : [],
    ready: needsDocs && !skip,
  };
}

function warningsForNonDocs(nonDocFiles) {
  if (!nonDocFiles || !nonDocFiles.length) return [];
  return [
    `docs worker changed non-doc files (not reverted): ${nonDocFiles.join(', ')}`,
  ];
}

module.exports = {
  DEFAULT_DOCS_PATHS,
  DEFAULT_DOCS_PATHS_BASE,
  DIFF_TRUNCATE_BYTES,
  DOCS_INSTRUCTIONS_FILE_MAX,
  DOCS_INSTRUCTIONS_TOTAL_MAX,
  STATUS_COMMIT_LIST_MAX,
  DOCS_NOT_ENABLED,
  docsDir,
  projectRootHash,
  statePath,
  resolveGitRoot,
  headCommit,
  loadState,
  saveState,
  readProjectDocs,
  isDocsEnabled,
  docsTitleFor,
  resolveSince,
  truncateText,
  gatherDiffs,
  snapshotWorkingTree,
  changedPathsSince,
  isDocsPath,
  isChangelogPath,
  changelogExists,
  changelogAllowed,
  resolveDocsPaths,
  resolveDocsForce,
  normalizeDocsInstructionsList,
  resolveInstructionPath,
  resolveDocsInstructions,
  classifyChangedFiles,
  gatherHandoffNotes,
  formatHandoffNotes,
  changelogPolicyText,
  buildPrompt,
  warningsForNonDocs,
  commitExists,
  listCommitsSince,
  dirtyDocsPaths,
  projectDirsFromSessions,
  collectProjectDocsStatus,
  git,
};
