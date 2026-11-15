'use strict';

/**
 * Read-only session timeline for a project (or all projects).
 *
 * Does not write the registry/state, launch engines, or call Herdr.
 *
 * Session window:
 *   start = runStartedAt || created
 *   end   = null while still running (workerStatus in queued|running|waiting,
 *           or lifecycle status active with a live-ish run);
 *           otherwise lastRunAt || lastUsed || null when finished
 *           (status done, or workerStatus done|failed|stopped).
 *
 * Commits: best-effort `git log --since=<start> --until=<end|now>` capped at 10
 * from each session's own cwd. Projects may span several cwds and need no git.
 * When cwd is missing / not a git repo: commits=[] and commitsReason set
 * (`missing-cwd` | `not-git`). Open-ended rows that are not a live run use
 * lastUsed as the window end, or skip with `open-ended` when lastUsed <= start. Subjects are scrubbed of newlines/control chars.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const projectLib = require('./project');

const PROMPT_SUMMARY_MAX = 100;
const COMMITS_PER_SESSION_MAX = 10;
const TIMELINE_DOCS_SECTION_MAX = 8 * 1024;

const FINISHED_WORKER = new Set(['done', 'failed', 'stopped']);
const RUNNING_WORKER = new Set(['queued', 'running', 'waiting']);

/**
 * @param {string|null|undefined} iso
 * @returns {number|null} epoch ms
 */
function parseTimeMs(iso) {
  if (!iso) return null;
  const t = Date.parse(String(iso));
  return Number.isFinite(t) ? t : null;
}

/**
 * Parse --since as ISO or YYYY-MM-DD (UTC midnight for date-only).
 * @param {string} raw
 * @returns {Date}
 */
function parseSinceDate(raw) {
  const s = String(raw || '').trim();
  if (!s) {
    const err = new Error('--since requires an ISO datetime or YYYY-MM-DD');
    err.code = 'BAD_SINCE';
    throw err;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const d = new Date(`${s}T00:00:00.000Z`);
    if (Number.isNaN(d.getTime())) {
      const err = new Error(`invalid --since date: ${s}`);
      err.code = 'BAD_SINCE';
      throw err;
    }
    return d;
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    const err = new Error(`invalid --since date: ${s}`);
    err.code = 'BAD_SINCE';
    throw err;
  }
  return d;
}

/**
 * Strip newlines and other control characters.
 * @param {string} s
 */
function scrubControl(s) {
  return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * First non-empty line of task || prompt, truncated.
 * @param {object} session
 */
function promptSummary(session, max = PROMPT_SUMMARY_MAX) {
  const raw = session.task || session.prompt || session.lastPrompt || '';
  const line = String(raw)
    .split(/\r?\n/)
    .map((l) => scrubControl(l))
    .find((l) => l.length > 0);
  if (!line) return '';
  if (line.length <= max) return line;
  return line.slice(0, Math.max(1, max - 1)) + '…';
}

/**
 * Pragmatic end time: null if still running; otherwise lastRunAt/lastUsed.
 * @param {object} session
 * @returns {string|null} ISO or null
 */
function sessionEndIso(session) {
  const ws = session.workerStatus || null;
  const status = session.status || 'active';
  if (ws && RUNNING_WORKER.has(ws)) return null;
  if (ws && FINISHED_WORKER.has(ws)) {
    return session.lastRunAt || session.lastUsed || null;
  }
  if (status === 'done' || status === 'paused') {
    return session.lastRunAt || session.lastUsed || null;
  }
  // Active, no workerStatus (plain interactive / never run as worker):
  // treat as open-ended (still "running") unless lastRunAt exists and
  // there is no indication of a current run.
  if (session.runPid != null || session.runStartedAt) {
    // Has run metadata but no finished workerStatus → still open if active
    if (status === 'active' && !ws) {
      // Headless run may have completed without workerStatus; prefer lastRunAt
      if (session.lastRunAt && session.lastExit != null) {
        return session.lastRunAt;
      }
      return null;
    }
  }
  if (session.lastRunAt && session.lastExit != null) {
    return session.lastRunAt;
  }
  // Plain active session with no finished signal → open-ended
  if (status === 'active') return null;
  return session.lastRunAt || session.lastUsed || null;
}

/**
 * @param {object} session
 * @returns {string|null}
 */
function sessionStartIso(session) {
  return session.runStartedAt || session.created || null;
}

/**
 * Best-effort commits in the session window. Never throws.
 * @param {object} session
 * @param {{ start: string|null, end: string|null }} window
 * @param {number} [cap]
 * @returns {{ commits: string[], reason: string|null }}
 */
function commitsInWindow(session, window, cap = COMMITS_PER_SESSION_MAX) {
  const cwd = session.cwd;
  if (!cwd) return { commits: [], reason: 'missing-cwd' };
  try {
    if (!fs.existsSync(cwd)) return { commits: [], reason: 'missing-cwd' };
  } catch (_) {
    return { commits: [], reason: 'missing-cwd' };
  }
  // Quick not-git check (avoid noisy git log failure)
  const gitRoot = projectLib.gitRootForCwd(cwd);
  if (!gitRoot) return { commits: [], reason: 'not-git' };

  const start = window.start;
  if (!start) return { commits: [], reason: null };
  let end = window.end;
  if (!end) {
    // Open-ended session. A live headless run (worker running/queued or a runPid)
    // gets commits until now; otherwise bound the window at lastUsed so an idle,
    // never-finished interactive row does not claim every later commit.
    const ws = session.workerStatus || null;
    const live = (ws && RUNNING_WORKER.has(ws)) || session.runPid != null;
    if (live) {
      end = new Date().toISOString();
    } else {
      const lu = parseTimeMs(session.lastUsed);
      const st = parseTimeMs(start);
      if (lu == null || st == null || lu <= st) return { commits: [], reason: 'open-ended' };
      end = new Date(lu).toISOString();
    }
  }
  try {
    const r = spawnSync(
      'git',
      [
        '-C',
        cwd,
        'log',
        `--since=${start}`,
        `--until=${end}`,
        `--format=%h %s`,
        '-n',
        String(cap),
      ],
      { encoding: 'utf8', timeout: 8000, maxBuffer: 2 * 1024 * 1024 }
    );
    if (r.status !== 0) return { commits: [], reason: 'not-git' };
    const commits = String(r.stdout || '')
      .split(/\r?\n/)
      .map((line) => scrubControl(line))
      .filter(Boolean)
      .slice(0, cap);
    return { commits, reason: null };
  } catch (_) {
    return { commits: [], reason: 'not-git' };
  }
}

/**
 * Build a flat session record for timeline output.
 * @param {object} session
 * @param {{ cache?: object, includeCommits?: boolean }} [opts]
 */
function buildSessionRecord(session, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  const includeCommits = opts.includeCommits !== false;
  const start = sessionStartIso(session);
  const end = sessionEndIso(session);
  const project = projectLib.resolveProjectName(session, { cache });
  let commits = [];
  let commitsReason = null;
  if (includeCommits) {
    const hit = commitsInWindow(session, { start, end });
    commits = hit.commits;
    commitsReason = hit.reason;
  }
  const record = {
    id: session.id,
    title: session.title,
    role: session.role || null,
    parent: session.parent || null,
    project,
    start,
    end,
    status: session.status || null,
    workerStatus: session.workerStatus || null,
    engine: session.engine || 'cursor',
    cwd: session.cwd || null,
    promptSummary: promptSummary(session),
    commits,
    commitsReason,
    children: [],
  };
  return record;
}

/**
 * Sort sessions chronologically by start (then created, then id).
 * @param {object[]} records
 */
function sortByStart(records) {
  return records.slice().sort((a, b) => {
    const ta = parseTimeMs(a.start) ?? 0;
    const tb = parseTimeMs(b.start) ?? 0;
    if (ta !== tb) return ta - tb;
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
}

/**
 * Build a forest: top-level sessions (no parent, or parent not in the set)
 * with children indented under them. Children sorted by start under each parent.
 *
 * @param {object[]} records  flat records (mutated: children filled)
 * @returns {object[]} roots
 */
function buildTree(records) {
  const byId = new Map(records.map((r) => [r.id, r]));
  for (const r of records) r.children = [];
  const roots = [];
  for (const r of records) {
    const parentId = r.parent;
    if (parentId && byId.has(parentId) && parentId !== r.id) {
      byId.get(parentId).children.push(r);
    } else {
      roots.push(r);
    }
  }
  const sortRec = (nodes) => {
    nodes.sort((a, b) => {
      const ta = parseTimeMs(a.start) ?? 0;
      const tb = parseTimeMs(b.start) ?? 0;
      if (ta !== tb) return ta - tb;
      return String(a.id || '').localeCompare(String(b.id || ''));
    });
    for (const n of nodes) sortRec(n.children || []);
  };
  sortRec(roots);
  return roots;
}

/**
 * Unique git roots (or cwd basenames) for sessions in a project group.
 * @param {object[]} sessions raw sessions
 * @param {object} cache
 */
function collectRoots(sessions, cache) {
  const seen = new Set();
  const roots = [];
  for (const s of sessions) {
    const cwd = s.cwd;
    if (!cwd) continue;
    const gitRoot = projectLib.gitRootForCwd(cwd, cache);
    const key = gitRoot || path.resolve(String(cwd));
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(key);
  }
  roots.sort();
  return roots;
}

/**
 * Filter sessions whose end (or start if no end) is on/after sinceDate.
 * @param {object[]} records
 * @param {Date|null} sinceDate
 */
function filterSince(records, sinceDate) {
  if (!sinceDate) return records;
  const sinceMs = sinceDate.getTime();
  return records.filter((r) => {
    const endMs = parseTimeMs(r.end);
    const startMs = parseTimeMs(r.start);
    const t = endMs != null ? endMs : startMs;
    if (t == null) return true; // open-ended / unknown → keep
    return t >= sinceMs;
  });
}

/**
 * Build the full timeline payload (read-only).
 *
 * @param {object[]} sessions  registry sessions (includeDone recommended)
 * @param {{
 *   project?: string|null,
 *   all?: boolean,
 *   since?: string|Date|null,
 *   cwd?: string,
 *   cache?: object,
 *   includeCommits?: boolean,
 * }} [opts]
 * @returns {{ ok: true, projects: Array<{ project: string, roots: string[], sessions: object[] }> }}
 */
function buildTimeline(sessions, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  const includeCommits = opts.includeCommits !== false;
  let sinceDate = null;
  if (opts.since != null && opts.since !== false && opts.since !== '') {
    sinceDate =
      opts.since instanceof Date ? opts.since : parseSinceDate(String(opts.since));
  }

  const list = Array.isArray(sessions) ? sessions : [];
  const withProject = list.map((s) => ({
    session: s,
    project: projectLib.resolveProjectName(s, { cache }),
  }));

  let projectNames;
  if (opts.all) {
    projectNames = [...new Set(withProject.map((x) => x.project))].sort();
  } else {
    const want =
      opts.project != null && String(opts.project).trim() !== ''
        ? String(opts.project).trim()
        : projectLib.resolveProjectName({ cwd: opts.cwd || process.cwd() }, { cache });
    projectNames = [want];
  }

  const projects = [];
  for (const name of projectNames) {
    const matched = withProject.filter((x) => x.project === name).map((x) => x.session);
    const records = matched.map((s) => buildSessionRecord(s, { cache, includeCommits }));
    const filtered = filterSince(records, sinceDate);
    // Rebuild tree only among filtered set (parent may drop out → become root)
    const tree = buildTree(filtered);
    projects.push({
      project: name,
      roots: collectRoots(matched, cache),
      sessions: tree,
    });
  }

  // Drop empty project groups when --all (keep empty for explicit single project)
  const out = opts.all ? projects.filter((p) => p.sessions.length > 0 || p.roots.length > 0) : projects;
  // If --all and everything empty, still return [] projects
  return { ok: true, projects: out };
}

/**
 * Flatten a tree of session records (depth-first) for text rendering.
 * @param {object[]} roots
 * @param {number} [depth]
 * @returns {Array<{ record: object, depth: number }>}
 */
function flattenTree(roots, depth = 0) {
  const out = [];
  for (const r of roots || []) {
    out.push({ record: r, depth });
    if (r.children && r.children.length) {
      out.push(...flattenTree(r.children, depth + 1));
    }
  }
  return out;
}

/**
 * Local wall-clock time for text output: `YYYY-MM-DD HH:MM` (JSON keeps ISO UTC).
 * @param {string} iso
 */
function formatLocalTime(iso) {
  const t = parseTimeMs(iso);
  if (t == null) return String(iso);
  const d = new Date(t);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Compact text tree for one project.
 * @param {{ project: string, sessions: object[] }} group
 */
function formatProjectText(group) {
  const lines = [];
  lines.push(`# ${group.project}`);
  const flat = flattenTree(group.sessions);
  if (flat.length === 0) {
    lines.push('(no sessions)');
    return lines.join('\n');
  }
  for (const { record: r, depth } of flat) {
    const indent = '  '.repeat(depth);
    const role = r.role || '-';
    const start = r.start ? formatLocalTime(r.start) : '-';
    const end = r.end ? formatLocalTime(r.end) : '…';
    const ws = r.workerStatus || '-';
    const summary = r.promptSummary ? scrubControl(r.promptSummary) : '';
    const summaryBit = summary ? ` — ${summary}` : '';
    lines.push(
      `${indent}${r.title} (${r.id}) [${role}] ${start} → ${end} ${r.status || '-'}/${ws} ${r.engine}${summaryBit}`
    );
    for (const c of r.commits || []) {
      lines.push(`${indent}  · ${c}`);
    }
  }
  return lines.join('\n');
}

/**
 * Format full timeline as text.
 * @param {{ projects: object[] }} payload
 */
function formatTimelineText(payload) {
  const groups = (payload && payload.projects) || [];
  if (groups.length === 0) return '(no sessions)\n';
  return groups.map((g) => formatProjectText(g)).join('\n\n') + '\n';
}

/**
 * Compact "Session timeline since last docs run" section for the documentarian
 * prompt. Caps at TIMELINE_DOCS_SECTION_MAX bytes; truncates with a marker.
 *
 * @param {object[]} sessions
 * @param {{
 *   projectRoot?: string,
 *   project?: string,
 *   sinceIso?: string|null,
 *   cache?: object,
 * }} [opts]
 * @returns {{ section: string, timelineBytes: number, truncated: boolean }}
 */
function buildDocsTimelineSection(sessions, opts = {}) {
  const cache = opts.cache || projectLib.createLookupCache();
  const cwd = opts.projectRoot || opts.cwd || process.cwd();
  const projectName =
    opts.project || projectLib.resolveProjectName({ cwd }, { cache });
  const since = opts.sinceIso || null;
  const payload = buildTimeline(sessions, {
    project: projectName,
    since,
    cwd,
    cache,
    includeCommits: opts.includeCommits !== false,
  });
  const group = (payload.projects || [])[0];
  if (!group || !group.sessions || group.sessions.length === 0) {
    return { section: '', timelineBytes: 0, truncated: false };
  }
  const body = formatProjectText(group);
  let section =
    '## Session timeline since last docs run\n\n' + body.trimEnd() + '\n';
  let truncated = false;
  const bytes = Buffer.byteLength(section, 'utf8');
  if (bytes > TIMELINE_DOCS_SECTION_MAX) {
    // Truncate by characters approximating byte budget
    let cut = section;
    while (Buffer.byteLength(cut, 'utf8') > TIMELINE_DOCS_SECTION_MAX - 20 && cut.length > 0) {
      cut = cut.slice(0, Math.floor(cut.length * 0.9));
    }
    section = cut.replace(/\s*$/, '') + '\n\n[truncated]\n';
    truncated = true;
  }
  return {
    section,
    timelineBytes: Buffer.byteLength(section, 'utf8'),
    truncated,
  };
}

module.exports = {
  PROMPT_SUMMARY_MAX,
  COMMITS_PER_SESSION_MAX,
  TIMELINE_DOCS_SECTION_MAX,
  parseTimeMs,
  parseSinceDate,
  scrubControl,
  promptSummary,
  sessionStartIso,
  sessionEndIso,
  commitsInWindow,
  buildSessionRecord,
  buildTree,
  buildTimeline,
  flattenTree,
  formatProjectText,
  formatTimelineText,
  buildDocsTimelineSection,
  filterSince,
  collectRoots,
  sortByStart,
};
