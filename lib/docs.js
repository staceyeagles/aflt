'use strict';

const fs = require('fs');
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
 * @returns {{
 *   enabled: boolean,
 *   docsPaths: string[],
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
  return {
    enabled: data.docs === true,
    docsPaths,
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
  const prompt = orchestrate.renderTemplate(tpl, {
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
  return {
    prompt,
    sinceInfo,
    diffs,
    handoffNotes: notes,
    promptBytes: Buffer.byteLength(prompt, 'utf8'),
    changelogAllowed: changelogOk,
    docsPaths,
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
  classifyChangedFiles,
  gatherHandoffNotes,
  formatHandoffNotes,
  changelogPolicyText,
  buildPrompt,
  warningsForNonDocs,
  git,
};
