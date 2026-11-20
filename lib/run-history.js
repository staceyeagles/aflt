'use strict';

/**
 * Parse aflt run logs and assemble dashboard history (prompt ↔ reply pairs,
 * status notes, completions). Read-only; never mutates registry/Herdr.
 *
 * Run file layout (lib/run.js) — keep backward compatible:
 *   # cwd: …
 *   # argv: …
 *   # kind: headless|interactive   (optional, newer)
 *   # prompt: …                    (optional, newer; may be multi-line via \n)
 *   # --- stdout ---
 *   <body>
 *   # --- stderr ---               (optional)
 *   # exit: …
 */

const fs = require('fs');
const path = require('path');
const memory = require('./memory');
const { fleetDir } = require('./util');

const REPLY_PREVIEW_LINES = 6;
const HISTORY_BODY_MAX = 64 * 1024;
const HISTORY_EVENTS_MAX = 200;

/**
 * Unescape a single POSIX-style shell token produced by escapeShellArg.
 * Handles `'…'` with `'\''` embedded quotes and bare tokens.
 */
function unescapeShellToken(token) {
  const s = String(token == null ? '' : token);
  if (!s) return '';
  if (s[0] !== "'") return s;
  // 'foo'\''bar' → foo'bar
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === "'") {
      i += 1;
      while (i < s.length) {
        if (s[i] === "'" && s.slice(i, i + 4) === "'\\''") {
          out += "'";
          i += 4;
          continue;
        }
        if (s[i] === "'") {
          i += 1;
          break;
        }
        out += s[i];
        i += 1;
      }
      continue;
    }
    out += s[i];
    i += 1;
  }
  return out;
}

/**
 * Split an `# argv:` line into tokens. Robust to shell-quoted values.
 * @param {string} line
 * @returns {string[]}
 */
function splitShellArgv(line) {
  const raw = String(line == null ? '' : line).replace(/^#\s*argv:\s*/i, '').trim();
  if (!raw) return [];
  const tokens = [];
  let i = 0;
  while (i < raw.length) {
    while (i < raw.length && /\s/.test(raw[i])) i += 1;
    if (i >= raw.length) break;
    if (raw[i] === "'") {
      // escapeShellArg embeds quotes as '\'' (close, \', reopen). After
      // consuming that sequence we are already inside the next quoted piece,
      // so keep reading content — do not require another opening quote.
      let end = i + 1;
      let piece = '';
      while (true) {
        const start = end;
        while (end < raw.length && raw[end] !== "'") end += 1;
        piece += raw.slice(start, end);
        if (end >= raw.length) break;
        end += 1; // closing '
        if (raw.slice(end, end + 3) === "\\''") {
          piece += "'";
          end += 3; // \, ', and reopening '
          continue;
        }
        break;
      }
      tokens.push(piece);
      i = end;
      continue;
    }
    let end = i;
    while (end < raw.length && !/\s/.test(raw[end])) end += 1;
    tokens.push(raw.slice(i, end));
    i = end;
  }
  return tokens;
}

/**
 * Extract the user prompt from engine argv tokens.
 * Cursor print: trailing positional. Copilot print: value after -p.
 * Copilot interactive: value after -i. Cursor interactive: trailing if present.
 */
function extractPromptFromArgv(argv, engineHint) {
  const args = Array.isArray(argv) ? argv.map(String) : [];
  if (!args.length) return null;
  const engine = String(engineHint || '').toLowerCase();
  const isCopilot =
    engine === 'copilot' ||
    /copilot/i.test(args[0] || '') ||
    args.some((a) => a.startsWith('--session-id='));

  if (isCopilot) {
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '-p' || args[i] === '-i') {
        const next = args[i + 1];
        if (next != null && !String(next).startsWith('-')) return String(next);
      }
      const m = String(args[i]).match(/^-(?:p|i)=(.*)$/);
      if (m) return m[1];
    }
    return null;
  }

  // Cursor: prompt is the last non-flag token that is not a flag value.
  // Prefer the trailing positional after known flags.
  const flagTakesValue = new Set([
    '--resume',
    '--model',
    '--workspace',
    '--mode',
    '--output-format',
    '--api-key',
  ]);
  let i = 0;
  // skip binary
  if (args.length && !args[0].startsWith('-')) i = 1;
  let lastPositional = null;
  let sawPrint = false;
  while (i < args.length) {
    const a = args[i];
    if (a === '-p' || a === '--print') {
      sawPrint = true;
      i += 1;
      continue;
    }
    if (a.startsWith('-')) {
      const key = a.includes('=') ? a.slice(0, a.indexOf('=')) : a;
      if (flagTakesValue.has(key) && !a.includes('=')) {
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    lastPositional = a;
    i += 1;
  }
  if (sawPrint || lastPositional) return lastPositional;
  return null;
}

/**
 * Decode a `# prompt:` header value (supports literal \n sequences).
 */
function decodePromptHeader(value) {
  return String(value == null ? '' : value).replace(/\\n/g, '\n').replace(/\\r/g, '\r');
}

function encodePromptHeader(value) {
  return String(value == null ? '' : value)
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Parse a run log file body into structured fields.
 * @param {string} text
 * @param {{ engine?: string, file?: string }} [opts]
 */
function parseRunLog(text, opts = {}) {
  const raw = String(text == null ? '' : text);
  const lines = raw.split(/\n/);
  let cwd = null;
  let argvRaw = null;
  let kind = null;
  let promptHeader = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('# cwd:')) {
      cwd = line.slice('# cwd:'.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('# argv:')) {
      argvRaw = line.slice('# argv:'.length).trim();
      i += 1;
      continue;
    }
    if (line.startsWith('# kind:')) {
      kind = line.slice('# kind:'.length).trim() || null;
      i += 1;
      continue;
    }
    if (line.startsWith('# prompt:')) {
      promptHeader = decodePromptHeader(line.slice('# prompt:'.length).replace(/^\s/, ''));
      i += 1;
      continue;
    }
    if (line === '# --- stdout ---' || line.startsWith('# --- stdout')) {
      i += 1;
      break;
    }
    if (line.startsWith('#') && !line.startsWith('# ---')) {
      i += 1;
      continue;
    }
    break;
  }

  const stdoutLines = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line === '# --- stderr ---' || line.startsWith('# --- stderr')) break;
    if (line.startsWith('# exit:') || line.startsWith('# signal:') || line.startsWith('# timedOut:')) break;
    stdoutLines.push(line);
    i += 1;
  }
  // trim trailing blank from stdout section
  while (stdoutLines.length && stdoutLines[stdoutLines.length - 1] === '') stdoutLines.pop();

  let stderr = null;
  if (i < lines.length && (lines[i] === '# --- stderr ---' || lines[i].startsWith('# --- stderr'))) {
    i += 1;
    const stderrLines = [];
    while (i < lines.length) {
      const line = lines[i];
      if (line.startsWith('# exit:') || line.startsWith('# signal:') || line.startsWith('# timedOut:')) break;
      stderrLines.push(line);
      i += 1;
    }
    while (stderrLines.length && stderrLines[stderrLines.length - 1] === '') stderrLines.pop();
    stderr = stderrLines.join('\n');
  }

  let exit = null;
  let signal = null;
  let timedOut = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('# exit:')) {
      const v = line.slice('# exit:'.length).trim();
      exit = v === '' || v === 'n/a' || v === 'pending' ? null : Number(v);
      if (v !== '' && v !== 'n/a' && v !== 'pending' && !Number.isFinite(exit)) exit = v;
    } else if (line.startsWith('# signal:')) {
      signal = line.slice('# signal:'.length).trim() || null;
    } else if (line.startsWith('# timedOut:')) {
      timedOut = /yes/i.test(line.slice('# timedOut:'.length));
    }
    i += 1;
  }

  const argv = argvRaw != null ? splitShellArgv('# argv: ' + argvRaw) : [];
  const promptFromArgv = extractPromptFromArgv(argv, opts.engine);
  const prompt =
    promptHeader != null && promptHeader !== ''
      ? promptHeader
      : promptFromArgv;
  const stdout = stdoutLines.join('\n');
  const inferredKind =
    kind ||
    (stdout.trim() === '' && (exit == null || exit === '') ? 'interactive' : 'headless');

  return {
    file: opts.file || null,
    cwd,
    argvRaw,
    argv,
    kind: inferredKind,
    prompt: prompt || null,
    stdout,
    stderr,
    exit,
    signal,
    timedOut,
  };
}

function runLogDir(sessionId) {
  return path.join(fleetDir(), 'runs', String(sessionId));
}

/**
 * List run log files for a session, newest first.
 * @returns {{ path: string, mtimeMs: number, name: string }[]}
 */
function listRunLogFiles(sessionId) {
  const dir = runLogDir(sessionId);
  let names;
  try {
    names = fs.readdirSync(dir);
  } catch (_) {
    return [];
  }
  const out = [];
  for (const name of names) {
    if (!name.endsWith('.txt')) continue;
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      out.push({ path: file, name, mtimeMs: st.mtimeMs });
    } catch (_) {
      /* skip */
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return out;
}

function stampFromRunFileName(name) {
  // 2026-11-19T16-54-01-123Z.cursor.txt → ISO-ish
  const m = String(name).match(
    /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d+)Z\./
  );
  if (!m) return null;
  const iso = `${m[1]}:${m[2]}:${m[3]}.${m[4]}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function engineFromRunFileName(name) {
  const m = String(name).match(/\.([a-z0-9_-]+)\.txt$/i);
  return m ? m[1] : null;
}

function previewText(text, maxLines = REPLY_PREVIEW_LINES) {
  const s = String(text == null ? '' : text);
  const lines = s.split(/\n/);
  if (lines.length <= maxLines) {
    return { preview: s, truncated: false, lineCount: lines.length };
  }
  return {
    preview: lines.slice(0, maxLines).join('\n'),
    truncated: true,
    lineCount: lines.length,
  };
}

function readRunLogBounded(filePath, limit = HISTORY_BODY_MAX) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const st = fs.fstatSync(fd);
    const size = st.size;
    const buf = Buffer.alloc(Math.min(size, limit + 1));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    const truncated = n > limit || size > limit;
    const text = buf.subarray(0, Math.min(n, limit)).toString('utf8');
    return { text, truncated, size };
  } catch (_) {
    return null;
  } finally {
    if (fd != null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

/**
 * Build prompt/reply history events from run logs for one session.
 */
function historyEventsFromRunLogs(session, opts = {}) {
  const redact = opts.redact !== false;
  const apply = (s) => (redact ? memory.redactSensitive(String(s == null ? '' : s)) : String(s == null ? '' : s));
  const files = listRunLogFiles(session.id);
  const events = [];
  for (const f of files) {
    const read = readRunLogBounded(f.path, opts.bodyMax || HISTORY_BODY_MAX);
    if (!read) continue;
    const engine = engineFromRunFileName(f.name) || session.engine || 'cursor';
    const parsed = parseRunLog(read.text, { engine, file: f.path });
    const at = stampFromRunFileName(f.name) || new Date(f.mtimeMs).toISOString();
    const replyRaw = parsed.stdout || '';
    const preview = previewText(replyRaw);
    events.push({
      type: 'prompt-reply',
      at,
      sessionId: session.id,
      sessionTitle: session.title || session.id,
      project: opts.project || null,
      engine,
      kind: parsed.kind,
      source: 'run-log',
      path: f.path,
      prompt: parsed.prompt != null ? apply(parsed.prompt) : null,
      reply: apply(replyRaw),
      replyPreview: apply(preview.preview),
      replyTruncated: preview.truncated || read.truncated,
      replyLineCount: preview.lineCount,
      exit: parsed.exit,
      timedOut: parsed.timedOut,
      // Issue #2: reserved for future cross-session message markers.
      messageMarkers: [],
    });
  }
  return events;
}

/**
 * Status-note events from a project memory context (already redacted).
 */
function historyEventsFromStatusNotes(projectContext, opts = {}) {
  const events = [];
  const docs = (projectContext && projectContext.documents) || [];
  for (const doc of docs) {
    if (!doc || doc.kind !== 'status') continue;
    const at = doc.date ? `${doc.date}T12:00:00.000Z` : null;
    events.push({
      type: 'status-note',
      at: at || opts.fallbackAt || new Date().toISOString(),
      sessionId: null,
      sessionTitle: null,
      project: projectContext.project || opts.project || null,
      source: 'status-note',
      path: doc.path,
      title: doc.title,
      reply: doc.content,
      replyPreview: previewText(doc.content).preview,
      replyTruncated: Boolean(doc.truncated) || previewText(doc.content).truncated,
      replyLineCount: previewText(doc.content).lineCount,
      messageMarkers: [],
    });
  }
  return events;
}

function historyEventsFromCompletions(session, completion, opts = {}) {
  if (!completion) return [];
  const redact = opts.redact !== false;
  const apply = (s) => (redact ? memory.redactSensitive(String(s == null ? '' : s)) : String(s == null ? '' : s));
  return [
    {
      type: 'task-complete',
      at: completion.at,
      sessionId: session.id,
      sessionTitle: session.title || session.id,
      project: opts.project || null,
      source: 'copilot-completion',
      prompt: null,
      reply: apply(completion.summary || ''),
      replyPreview: apply(previewText(completion.summary || '').preview),
      replyTruncated: Boolean(completion.truncated) || previewText(completion.summary || '').truncated,
      replyLineCount: previewText(completion.summary || '').lineCount,
      notePath: completion.notePath || null,
      messageMarkers: [],
    },
  ];
}

/**
 * History events from interactive turn capture (`runs/<id>/turns.jsonl`).
 */
function historyEventsFromTurns(session, opts = {}) {
  if (!session || !session.id) return [];
  const redact = opts.redact !== false;
  const apply = (s) => (redact ? memory.redactSensitive(String(s == null ? '' : s)) : String(s == null ? '' : s));
  let turnsLib;
  try {
    turnsLib = require('./turns');
  } catch (_) {
    return [];
  }
  let turns;
  try {
    turns = turnsLib.readTurns(session.id);
  } catch (_) {
    return [];
  }
  const events = [];
  for (const turn of turns) {
    if (!turn || !turn.at) continue;
    const prompt = turn.prompt != null ? apply(turn.prompt) : null;
    const replyRaw = turn.reply != null ? apply(turn.reply) : '';
    // Skip empty OSC stubs from the history panel list (markers still include them).
    if (!String(prompt || '').trim() && !String(replyRaw || '').trim()) continue;
    const preview = previewText(replyRaw);
    events.push({
      type: 'turn',
      at: turn.at,
      sessionId: session.id,
      sessionTitle: session.title || session.id,
      project: opts.project || null,
      engine: turn.engine || session.engine || null,
      kind: 'interactive',
      source: turn.source || 'turn',
      turnId: turn.turnId || null,
      engineEventId: turn.engineEventId || null,
      prompt,
      reply: replyRaw,
      replyPreview: apply(preview.preview),
      replyTruncated: Boolean(turn.replyTruncated) || preview.truncated,
      replyLineCount: preview.lineCount,
      incomplete: Boolean(turn.incomplete),
      exit: 0,
      timedOut: false,
      messageMarkers: [],
    });
  }
  // Newest first to match run-log listing order before merge sorts.
  events.reverse();
  return events;
}

/**
 * Merge + sort history for a session or project (newest first).
 */
function mergeHistoryEvents(lists, opts = {}) {
  const max = opts.max != null ? opts.max : HISTORY_EVENTS_MAX;
  const all = [];
  for (const list of lists) {
    if (Array.isArray(list)) all.push(...list);
  }
  all.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return all.slice(0, max);
}

/**
 * "Where we left off" summary for a session or project.
 */
function buildLeftOff({
  sessions = [],
  completionsById = {},
  projectMemory = null,
  checkpoint = null,
} = {}) {
  const latestCompletion = sessions
    .map((s) => completionsById[s.id])
    .filter(Boolean)
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))[0] || null;

  const statusNotes = ((projectMemory && projectMemory.documents) || [])
    .filter((d) => d && d.kind === 'status');
  const latestNote = statusNotes[0] || null;

  const openCheckpoint =
    checkpoint &&
    checkpoint.state === 'requested' &&
    !checkpoint.completedAt
      ? checkpoint
      : checkpoint && checkpoint.missing
        ? checkpoint
        : checkpoint && checkpoint.overdue
          ? checkpoint
          : null;

  return {
    completion: latestCompletion,
    statusNote: latestNote
      ? {
          path: latestNote.path,
          title: latestNote.title,
          date: latestNote.date || null,
          preview: previewText(latestNote.content, 8).preview,
        }
      : null,
    checkpoint: openCheckpoint,
  };
}

const MARKER_TEXT_MAX = 280;
const MARKERS_PER_SESSION_MAX = 40;

function truncateEllipsis(text, max = MARKER_TEXT_MAX) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, Math.max(1, max - 1)).trimEnd() + '…';
}

/**
 * Finished-turn markers for the History Gantt (completed / failed only).
 * Built from run logs + interactive turns.jsonl (redacted); no working/idle span bars.
 * @returns {{ at: string, state: 'completed'|'failed', prompt: string, reply: string, sessionId?: string }[]}
 */
function sessionActivityMarkers(session, opts = {}) {
  if (!session || !session.id) return [];
  const max = opts.maxMarkers != null ? Number(opts.maxMarkers) : MARKERS_PER_SESSION_MAX;
  const limit = Number.isFinite(max) && max > 0 ? Math.floor(max) : MARKERS_PER_SESSION_MAX;
  const runEvents = historyEventsFromRunLogs(session, {
    redact: opts.redact !== false,
    bodyMax: opts.bodyMax || HISTORY_BODY_MAX,
  });
  const turnEvents = historyEventsFromTurns(session, {
    redact: opts.redact !== false,
  });
  // Prefer run-log markers; add turns that are not headless duplicates of the same stamp.
  const seen = new Set();
  const markers = [];

  function consider(ev, { requireExitOrReply = true, allowIncomplete = false } = {}) {
    if (!ev || !ev.at) return;
    if (markers.length >= limit) return;
    const exitNum = ev.exit != null && ev.exit !== '' ? Number(ev.exit) : null;
    const hasExit = exitNum != null && Number.isFinite(exitNum);
    const hasReply = Boolean(String(ev.reply || '').trim());
    const hasPrompt = Boolean(String(ev.prompt || '').trim());
    if (requireExitOrReply && !hasExit && !hasReply) {
      // Interactive turns with only a completion marker still count when allowIncomplete
      // or when we have a prompt (turn capture) / incomplete OSC stub for Gantt.
      if (!(allowIncomplete && (ev.incomplete || hasPrompt || ev.type === 'turn'))) return;
    }
    // Deduplicate headless-run turns against run-log events at the same timestamp.
    const dedupe = `${ev.at}|${truncateEllipsis(ev.prompt)}|${truncateEllipsis(ev.replyPreview || ev.reply)}`;
    if (seen.has(dedupe)) return;
    // Also skip turn events that duplicate a run-log stamp when source is headless-run.
    if (ev.source === 'headless-run' && seen.has(`run:${ev.at}`)) return;
    seen.add(dedupe);
    if (ev.source === 'run-log') seen.add(`run:${ev.at}`);
    const failed = Boolean(ev.timedOut) || (hasExit && exitNum !== 0);
    markers.push({
      at: ev.at,
      state: failed ? 'failed' : 'completed',
      prompt: truncateEllipsis(ev.prompt),
      reply: truncateEllipsis(ev.replyPreview || ev.reply),
      sessionId: session.id,
      source: ev.source || null,
    });
  }

  for (const ev of runEvents) consider(ev, { requireExitOrReply: true });
  for (const ev of turnEvents) {
    // Include turns even when prompt is null (reply from task_complete summary).
    // Sparse OSC stubs (no prompt/reply) still get a completed marker.
    consider(ev, { requireExitOrReply: false, allowIncomplete: true });
  }

  markers.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return markers.slice(0, limit);
}

/**
 * @deprecated Prefer sessionActivityMarkers (activity-only finished turns).
 * Kept for any external callers; returns [] (no span bars).
 */
function sessionActivitySegments(_session, _opts = {}) {
  return [];
}

module.exports = {
  REPLY_PREVIEW_LINES,
  HISTORY_BODY_MAX,
  HISTORY_EVENTS_MAX,
  MARKER_TEXT_MAX,
  MARKERS_PER_SESSION_MAX,
  unescapeShellToken,
  splitShellArgv,
  extractPromptFromArgv,
  encodePromptHeader,
  decodePromptHeader,
  parseRunLog,
  runLogDir,
  listRunLogFiles,
  stampFromRunFileName,
  engineFromRunFileName,
  previewText,
  truncateEllipsis,
  readRunLogBounded,
  historyEventsFromRunLogs,
  historyEventsFromStatusNotes,
  historyEventsFromCompletions,
  historyEventsFromTurns,
  mergeHistoryEvents,
  buildLeftOff,
  sessionActivityMarkers,
  sessionActivitySegments,
};
