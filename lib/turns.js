'use strict';

/**
 * Interactive turn capture — durable prompt↔reply records under
 * `$AGENTFLEET_HOME/runs/<id>/turns.jsonl` for History Gantt + panel.
 *
 * Copilot: pair each `user.message` with the final `assistant.message` of the
 * following agent loop (completed on the next `user.message`, or on a trailing
 * `assistant.turn_end` whose last assistant message has no pending
 * `toolRequests`). Successful `session.task_complete` merges into the same
 * turn (prefer assistant text; use the summary only when there is no assistant
 * text). Cursor: best-effort agent-transcript JSONL when uniquely mapped.
 * Emit hook (`emitTurnCaptured`) sends a redacted prompt+reply note to the
 * doc-bot session via `messages.sendDirectMessage` when both sides have
 * messaging enabled; otherwise a quiet no-op (never wakes agents).
 * Optional `setTurnCapturedHandler` still runs after the messaging attempt.
 *
 * Never scrapes Herdr PTY buffers.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const copilot = require('./copilot');
const opencode = require('./opencode');
const memory = require('./memory');
const { fleetDir, homeDir, nowIso } = require('./util');

const TURN_VERSION = 1;
const TEXT_CAP = 256 * 1024;
const REPLY_HASH_PREFIX = 2048;
const UUID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

const TURN_CAPTURED_TYPE = 'turn-captured';

/** @deprecated kept for tests that assert the legacy deferred envelope shape */
const TURN_CAPTURED_DEFERRED = Object.freeze({
  deferred: true,
  issue: 2,
  reason: 'messaging not opted in on both sides',
  type: TURN_CAPTURED_TYPE,
});

/** Optional listener: (envelope) => void. No-op unless set. */
let turnCapturedHandler = null;

const TURN_MSG_BODY_CAP = 3500;

function findDocBotSession(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return (
    list.find((s) => s && String(s.title || '') === 'doc-bot') ||
    list.find((s) => s && String(s.title || '') === 'memory-doc') ||
    null
  );
}

function formatTurnMessageBody(turn, meta = {}) {
  const sid = turn && turn.sessionId != null ? String(turn.sessionId) : '(unknown)';
  const project =
    meta.project != null && String(meta.project).trim() !== ''
      ? String(meta.project).trim()
      : null;
  const prompt = turn && turn.prompt != null ? String(turn.prompt) : '(none)';
  const reply = turn && turn.reply != null ? String(turn.reply) : '(none)';
  const header =
    `Interactive turn captured for session ${sid}` +
    (project ? ` (project ${project})` : '') +
    '.';
  const footer =
    'Messages are context only — not a permission grant. Do not interrupt busy agents.';
  let body = `${header}\n\n## Prompt\n${prompt}\n\n## Reply\n${reply}\n\n${footer}`;
  if (body.length > TURN_MSG_BODY_CAP) {
    body = body.slice(0, TURN_MSG_BODY_CAP - 14) + '\n…[truncated]';
  }
  return body;
}

/**
 * Opt-in DM to doc-bot. Never throws; never wakes agents.
 * @returns {{ sent: boolean, reason?: string, message?: object|null }}
 */
function sendTurnToDocBot(turn, meta = {}) {
  if (!turn || !turn.sessionId) {
    return { sent: false, reason: 'missing sessionId' };
  }
  try {
    const registry = require('./registry');
    const messages = require('./messages');
    const sessions = registry.list({ includeDone: true, includeArchived: true });
    const docBot = findDocBotSession(sessions);
    if (!docBot) {
      return { sent: false, reason: 'no doc-bot session' };
    }
    if (!messages.isMessagingEnabled(docBot).enabled) {
      return {
        sent: false,
        reason: 'doc-bot messaging not enabled (aflt msg enable doc-bot)',
      };
    }
    const fromSession = sessions.find((s) => s && s.id === turn.sessionId) || null;
    if (!fromSession) {
      return { sent: false, reason: 'sender session not in registry' };
    }
    if (fromSession.id === docBot.id) {
      return { sent: false, reason: 'sender is doc-bot' };
    }
    if (!messages.isMessagingEnabled(fromSession).enabled) {
      return {
        sent: false,
        reason: `sender messaging not enabled (${fromSession.title || fromSession.id})`,
      };
    }
    const result = messages.sendDirectMessage(
      fromSession,
      docBot,
      formatTurnMessageBody(turn, meta),
      {
        type: 'note',
        sessions,
        source: 'emitTurnCaptured',
        meta: {
          eventType: TURN_CAPTURED_TYPE,
          turnId: turn.turnId || null,
          project: meta.project != null ? meta.project : null,
        },
      }
    );
    return { sent: true, message: result.message || null, reason: null };
  } catch (err) {
    return {
      sent: false,
      reason: String(err && err.message ? err.message : err),
    };
  }
}

function setTurnCapturedHandler(fn) {
  turnCapturedHandler = typeof fn === 'function' ? fn : null;
}

function getTurnCapturedHandler() {
  return turnCapturedHandler;
}

function turnsDir(sessionId) {
  return path.join(fleetDir(), 'runs', String(sessionId));
}

function turnsPath(sessionId) {
  return path.join(turnsDir(sessionId), 'turns.jsonl');
}

function turnsIndexPath(sessionId) {
  return path.join(turnsDir(sessionId), 'turns-index.json');
}

function ensureTurnsDir(sessionId) {
  const dir = turnsDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value == null ? '' : value)).digest('hex');
}

function shortHash(value) {
  return hashText(value).slice(0, 16);
}

/**
 * Dedupe key: engineEventId when present, else content hash.
 * @param {{ sessionId?: string, at?: string, prompt?: string|null, reply?: string|null, engineEventId?: string|null }} turn
 */
function dedupeKey(turn) {
  const eventId = turn && turn.engineEventId != null ? String(turn.engineEventId).trim() : '';
  if (eventId) return `event:${eventId}`;
  const sessionId = turn && turn.sessionId != null ? String(turn.sessionId) : '';
  const at = turn && turn.at != null ? String(turn.at) : '';
  const promptH = shortHash(turn && turn.prompt);
  const replyPrefix = String(turn && turn.reply != null ? turn.reply : '').slice(0, REPLY_HASH_PREFIX);
  const replyH = shortHash(replyPrefix);
  return `hash:${hashText([sessionId, at, promptH, replyH].join('|'))}`;
}

function capText(value) {
  const s = value == null ? null : String(value);
  if (s == null) return { text: null, truncated: false };
  if (s.length <= TEXT_CAP) return { text: s, truncated: false };
  return { text: s.slice(0, TEXT_CAP), truncated: true };
}

function loadTurnsIndex(sessionId) {
  const file = turnsIndexPath(sessionId);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const keys = Array.isArray(parsed.keys) ? parsed.keys.map(String) : [];
    return {
      keys: new Set(keys),
      copilotOffset: Number.isFinite(parsed.copilotOffset) ? parsed.copilotOffset : 0,
      copilotIdentity: parsed.copilotIdentity || null,
      lastUserPrompt:
        typeof parsed.lastUserPrompt === 'string' && parsed.lastUserPrompt
          ? parsed.lastUserPrompt
          : null,
      lastUserAt:
        typeof parsed.lastUserAt === 'string' && parsed.lastUserAt ? parsed.lastUserAt : null,
      copilotPending:
        parsed.copilotPending && typeof parsed.copilotPending === 'object'
          ? parsed.copilotPending
          : null,
      cursorFiles: parsed.cursorFiles && typeof parsed.cursorFiles === 'object' ? parsed.cursorFiles : {},
      opencodeSeen: Array.isArray(parsed.opencodeSeen)
        ? parsed.opencodeSeen.map(String)
        : [],
    };
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      /* corrupt → rebuild from empty; appends still dedupe via keys rebuild below */
    }
    return {
      keys: new Set(),
      copilotOffset: 0,
      copilotIdentity: null,
      lastUserPrompt: null,
      lastUserAt: null,
      copilotPending: null,
      cursorFiles: {},
      opencodeSeen: [],
    };
  }
}

function saveTurnsIndex(sessionId, index) {
  ensureTurnsDir(sessionId);
  const file = turnsIndexPath(sessionId);
  const payload = {
    keys: Array.from(index.keys || []),
    copilotOffset: index.copilotOffset || 0,
    copilotIdentity: index.copilotIdentity || null,
    lastUserPrompt: index.lastUserPrompt || null,
    lastUserAt: index.lastUserAt || null,
    copilotPending: index.copilotPending || null,
    cursorFiles: index.cursorFiles || {},
    opencodeSeen: Array.isArray(index.opencodeSeen) ? index.opencodeSeen.map(String) : [],
  };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Redact + cap fields before disk write.
 */
function prepareTurnRecord(input) {
  const promptCap = capText(input.prompt);
  const replyCap = capText(input.reply);
  const prompt =
    promptCap.text == null || promptCap.text === ''
      ? null
      : memory.redactSensitive(promptCap.text);
  const reply =
    replyCap.text == null || replyCap.text === ''
      ? null
      : memory.redactSensitive(replyCap.text);
  const turn = {
    v: TURN_VERSION,
    turnId: input.turnId || input.engineEventId || crypto.randomUUID(),
    at: input.at || nowIso(),
    sessionId: String(input.sessionId || ''),
    chatId: input.chatId != null ? String(input.chatId) : null,
    engine: input.engine || null,
    source: input.source || 'manual',
    prompt,
    reply,
    promptSource: input.promptSource || (prompt ? 'unknown' : 'unknown'),
    replySource: input.replySource || (reply ? 'unknown' : 'unknown'),
    engineEventId: input.engineEventId != null ? String(input.engineEventId) : null,
    herdrStatusAtComplete:
      input.herdrStatusAtComplete === undefined ? null : input.herdrStatusAtComplete,
    redacted: true,
  };
  if (promptCap.truncated) turn.promptTruncated = true;
  if (replyCap.truncated) turn.replyTruncated = true;
  if (input.incomplete) turn.incomplete = true;
  if (input.taskCompleteSummary != null && String(input.taskCompleteSummary).trim()) {
    const summaryCap = capText(input.taskCompleteSummary);
    turn.taskCompleteSummary =
      summaryCap.text == null || summaryCap.text === ''
        ? null
        : memory.redactSensitive(summaryCap.text);
    if (summaryCap.truncated) turn.taskCompleteSummaryTruncated = true;
  }
  return turn;
}

/**
 * Append a turn if not already indexed. Always redacts before write.
 * @returns {{ written: boolean, turn: object|null, key: string|null, reason?: string }}
 */
function appendTurn(input, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  if (!input || !input.sessionId) {
    return { written: false, turn: null, key: null, reason: 'missing-session' };
  }
  const turn = prepareTurnRecord(input);
  const key = dedupeKey(turn);
  const index = opts.index || loadTurnsIndex(turn.sessionId);
  const extraIds = Array.isArray(input.alsoDedupeIds)
    ? input.alsoDedupeIds.map((id) => String(id || '').trim()).filter(Boolean)
    : [];
  const extraKeys = extraIds.map((id) => `event:${id}`);
  if (index.keys.has(key) || extraKeys.some((k) => index.keys.has(k))) {
    // Still register sibling event ids so task_complete / assistant ids collide once.
    index.keys.add(key);
    for (const k of extraKeys) index.keys.add(k);
    if (!opts.skipIndexSave && !dryRun) saveTurnsIndex(turn.sessionId, index);
    return { written: false, turn, key, reason: 'duplicate' };
  }
  if (dryRun) {
    index.keys.add(key);
    for (const k of extraKeys) index.keys.add(k);
    return { written: false, turn, key, reason: 'dry-run' };
  }
  ensureTurnsDir(turn.sessionId);
  const file = turnsPath(turn.sessionId);
  fs.appendFileSync(file, JSON.stringify(turn) + '\n', { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    /* ignore */
  }
  index.keys.add(key);
  for (const k of extraKeys) index.keys.add(k);
  if (!opts.skipIndexSave) saveTurnsIndex(turn.sessionId, index);
  const envelope = emitTurnCaptured(turn, opts.meta || {});
  return { written: true, turn, key, envelope };
}

/**
 * Issue-#2 hook: send redacted turn to doc-bot when both sides opted into messaging.
 * Quiet no-op otherwise (never wakes agents). Invokes configured handler if any.
 */
function emitTurnCaptured(turn, meta = {}) {
  const notify = sendTurnToDocBot(turn, meta);
  const envelope = {
    type: TURN_CAPTURED_TYPE,
    issue: 2,
    deferred: !notify.sent,
    sent: Boolean(notify.sent),
    reason: notify.sent
      ? null
      : notify.reason || TURN_CAPTURED_DEFERRED.reason,
    message: notify.message || null,
    turn: turn || null,
    sessionId: turn && turn.sessionId != null ? turn.sessionId : null,
    project: meta.project != null ? meta.project : null,
    memoryHint: meta.memoryHint != null ? meta.memoryHint : null,
  };
  // Opt-in webhook (config/env). Queued (tracked for flushPendingNotifies);
  // never blocks capture here — short-lived CLIs await flush on exit.
  let webhook = { skipped: true };
  try {
    const notifyHook = require('./notify');
    let session = null;
    try {
      const registry = require('./registry');
      if (turn && turn.sessionId) {
        session = registry.find(turn.sessionId);
      }
    } catch (_) {
      session = null;
    }
    webhook = notifyHook.notifyTurnCaptured(session, turn, { meta });
  } catch (_) {
    /* never block capture on webhook failure */
  }
  envelope.notify = webhook;
  if (turnCapturedHandler) {
    try {
      turnCapturedHandler(envelope);
    } catch (_) {
      /* never block capture on hook failure */
    }
  }
  return envelope;
}

/**
 * Read all turns for a session (newest-last file order preserved).
 */
function readTurns(sessionId, opts = {}) {
  const file = turnsPath(sessionId);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err && err.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const line of text.split(/\n/)) {
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch (_) {
      /* skip corrupt line */
    }
  }
  if (opts.newestFirst) out.reverse();
  return out;
}

function extractUserMessageText(data) {
  // Prefer shared Copilot helper when available (exported for turns/tests).
  if (typeof copilot.extractUserMessageText === 'function') {
    return copilot.extractUserMessageText(data);
  }
  if (!data || typeof data !== 'object') return null;
  for (const key of ['content', 'text', 'message', 'prompt', 'body']) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) return v;
  }
  if (Array.isArray(data.content)) {
    const parts = data.content
      .map((p) => {
        if (typeof p === 'string') return p;
        if (p && typeof p.text === 'string') return p.text;
        if (p && typeof p.content === 'string') return p.content;
        return '';
      })
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  return null;
}

function extractAssistantMessageText(data) {
  if (!data || typeof data !== 'object') return null;
  if (typeof data.content === 'string') {
    // Preserve empty string so callers can distinguish "present but empty".
    return data.content;
  }
  return extractUserMessageText(data);
}

function hasPendingToolRequests(data) {
  const requests = data && data.toolRequests;
  return Array.isArray(requests) && requests.length > 0;
}

function parseEventAt(event) {
  if (
    event &&
    typeof event.timestamp === 'string' &&
    Number.isFinite(Date.parse(event.timestamp))
  ) {
    return new Date(event.timestamp).toISOString();
  }
  return null;
}

function emptyCopilotLoop(userText, userAt) {
  return {
    userText: userText || null,
    userAt: userAt || null,
    assistantEventId: null,
    assistantAt: null,
    assistantText: null,
    hasPendingTools: false,
    taskCompleteId: null,
    taskCompleteAt: null,
    taskCompleteSummary: null,
    loopComplete: false,
  };
}

function restoreCopilotLoop(pending, lastUserPrompt, lastUserAt) {
  if (pending && typeof pending === 'object' && (pending.userText || lastUserPrompt)) {
    return {
      userText: pending.userText || lastUserPrompt || null,
      userAt: pending.userAt || lastUserAt || null,
      assistantEventId: pending.assistantEventId || null,
      assistantAt: pending.assistantAt || null,
      assistantText: pending.assistantText != null ? pending.assistantText : null,
      hasPendingTools: Boolean(pending.hasPendingTools),
      taskCompleteId: pending.taskCompleteId || null,
      taskCompleteAt: pending.taskCompleteAt || null,
      taskCompleteSummary: pending.taskCompleteSummary || null,
      loopComplete: Boolean(pending.loopComplete),
    };
  }
  if (lastUserPrompt) {
    return emptyCopilotLoop(lastUserPrompt, lastUserAt || null);
  }
  return null;
}

function serializeCopilotPending(loop) {
  if (!loop || !loop.userText) return null;
  return {
    userText: loop.userText,
    userAt: loop.userAt || null,
    assistantEventId: loop.assistantEventId || null,
    assistantAt: loop.assistantAt || null,
    assistantText: loop.assistantText != null ? loop.assistantText : null,
    hasPendingTools: Boolean(loop.hasPendingTools),
    taskCompleteId: loop.taskCompleteId || null,
    taskCompleteAt: loop.taskCompleteAt || null,
    taskCompleteSummary: loop.taskCompleteSummary || null,
    loopComplete: Boolean(loop.loopComplete),
  };
}

/**
 * Build a turn record from an open Copilot agent loop, or null if incomplete.
 */
function turnRecordFromCopilotLoop(loop, opts = {}) {
  if (!loop || !loop.userText) return null;
  const assistantText =
    loop.assistantText != null && String(loop.assistantText).trim()
      ? String(loop.assistantText)
      : null;
  const summary =
    loop.taskCompleteSummary != null && String(loop.taskCompleteSummary).trim()
      ? String(loop.taskCompleteSummary)
      : null;
  if (!assistantText && !summary) return null;

  let reply;
  let replySource;
  let taskCompleteSummary;
  if (assistantText) {
    reply = assistantText;
    replySource = summary ? 'assistant-message+task-complete' : 'assistant-message';
    if (summary) taskCompleteSummary = summary;
  } else {
    reply = summary;
    replySource = 'task-complete-summary';
  }

  const engineEventId = loop.assistantEventId || loop.taskCompleteId;
  if (!engineEventId) return null;
  const alsoDedupeIds = [];
  if (loop.assistantEventId && loop.taskCompleteId && loop.assistantEventId !== loop.taskCompleteId) {
    alsoDedupeIds.push(loop.taskCompleteId);
  }

  return {
    engineEventId,
    alsoDedupeIds,
    at: loop.assistantAt || loop.taskCompleteAt || loop.userAt || nowIso(),
    prompt: loop.userText,
    promptSource: 'events-user-message',
    reply,
    replySource,
    taskCompleteSummary: taskCompleteSummary || undefined,
    source:
      opts.source ||
      (assistantText ? 'copilot-assistant-message' : 'copilot-task-complete'),
  };
}

function isSafeChatId(chatId) {
  return typeof chatId === 'string' && UUID_RE.test(chatId);
}

/**
 * Walk Copilot events.jsonl; yield completed turns.
 * Pairs each user.message with the final assistant.message of the agent loop
 * (and/or a successful session.task_complete). Does not follow symlinks.
 */
function iterCopilotTurnCandidates(eventsFile, opts = {}) {
  const results = [];
  const errors = [];
  if (!eventsFile) {
    return {
      records: results,
      errors,
      offset: 0,
      identity: null,
      lastUserPrompt: null,
      lastUserAt: null,
      pending: null,
    };
  }

  let st;
  try {
    st = fs.lstatSync(eventsFile);
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`events: ${err.code || err.message}`);
    return {
      records: results,
      errors,
      offset: 0,
      identity: null,
      lastUserPrompt: null,
      lastUserAt: null,
      pending: null,
    };
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    errors.push('events source is not a regular file');
    return {
      records: results,
      errors,
      offset: 0,
      identity: null,
      lastUserPrompt: null,
      lastUserAt: null,
      pending: null,
    };
  }

  const identity = `${st.dev}:${st.ino}`;
  let startOffset = opts.offset || 0;
  if (opts.identity && opts.identity !== identity) startOffset = 0;
  if (startOffset > st.size) startOffset = 0;

  let fd;
  let loop = restoreCopilotLoop(opts.pending, opts.lastUserPrompt, opts.lastUserAt);
  let lastEmitted = null;
  let position = startOffset;
  let carry = Buffer.alloc(0);

  function loopHasReply(l) {
    return Boolean(
      (l.assistantText != null && String(l.assistantText).trim()) ||
        (l.taskCompleteSummary != null && String(l.taskCompleteSummary).trim())
    );
  }

  function flushLoop(force = false) {
    if (!loop) return;
    if (!force && !loop.loopComplete && !loop.taskCompleteSummary) return;
    if (!loopHasReply(loop)) {
      // Structure may be complete but text arrives later (e.g. task_complete).
      // On a new user.message, drop the empty prior loop.
      if (force) loop = null;
      return;
    }
    if (force && !loop.assistantEventId && !loop.taskCompleteId) {
      loop = null;
      return;
    }
    const rec = turnRecordFromCopilotLoop(loop, opts);
    if (rec) {
      results.push(rec);
      lastEmitted = {
        userText: loop.userText,
        assistantEventId: loop.assistantEventId,
        taskCompleteId: loop.taskCompleteId,
      };
    }
    loop = null;
  }

  try {
    fd = fs.openSync(eventsFile, 'r');
    const buffer = Buffer.alloc(256 * 1024);
    while (position < st.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, st.size - position), position);
      if (!count) break;
      position += count;
      const bytes = Buffer.concat([carry, buffer.subarray(0, count)]);
      let start = 0;
      let end;
      while ((end = bytes.indexOf(10, start)) !== -1) {
        const line = bytes.subarray(start, end).toString('utf8');
        start = end + 1;
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          errors.push('Invalid JSON in Copilot events');
          continue;
        }
        const type = event && event.type;
        const data = (event && event.data) || {};
        const at = parseEventAt(event);

        if (type === 'user.message') {
          const text = extractUserMessageText(data);
          if (text) {
            flushLoop(true);
            loop = emptyCopilotLoop(text, at);
          }
          continue;
        }

        if (type === 'assistant.message') {
          if (!loop) continue;
          const text = extractAssistantMessageText(data);
          loop.assistantEventId =
            typeof event.id === 'string' && event.id
              ? event.id
              : typeof data.messageId === 'string' && data.messageId
                ? data.messageId
                : loop.assistantEventId;
          loop.assistantAt = at || loop.assistantAt;
          if (typeof text === 'string' && text.trim()) {
            loop.assistantText = text;
          } else if (typeof text === 'string' && text === '' && loop.assistantText == null) {
            loop.assistantText = null;
          }
          loop.hasPendingTools = hasPendingToolRequests(data);
          // A new assistant step means the prior turn_end was intermediate.
          loop.loopComplete = false;
          continue;
        }

        if (type === 'assistant.turn_end') {
          if (!loop) continue;
          if (!loop.hasPendingTools && (loop.assistantEventId || loop.taskCompleteId)) {
            loop.loopComplete = true;
            flushLoop(false);
          }
          continue;
        }

        if (type === 'session.task_complete') {
          if (data.success !== true) continue;
          if (
            typeof event.id !== 'string' ||
            !event.id ||
            typeof data.summary !== 'string' ||
            !data.summary.trim() ||
            typeof event.timestamp !== 'string' ||
            !Number.isFinite(Date.parse(event.timestamp))
          ) {
            errors.push('Task Complete event is missing its ID, timestamp or summary');
            continue;
          }
          const summary = data.summary;
          const completeAt = new Date(event.timestamp).toISOString();

          if (loop) {
            loop.taskCompleteId = event.id;
            loop.taskCompleteAt = completeAt;
            loop.taskCompleteSummary = summary;
            // task_complete alone can finish a loop (legacy / no assistant text).
            if (!loop.assistantEventId || loop.loopComplete || !loop.hasPendingTools) {
              loop.loopComplete = true;
              flushLoop(false);
            }
            continue;
          }

          // Late task_complete after a flushed assistant turn: register for dedupe only.
          if (
            lastEmitted &&
            lastEmitted.taskCompleteId !== event.id &&
            results.length > 0
          ) {
            const prev = results[results.length - 1];
            if (!prev.alsoDedupeIds) prev.alsoDedupeIds = [];
            if (!prev.alsoDedupeIds.includes(event.id)) prev.alsoDedupeIds.push(event.id);
            if (!prev.taskCompleteSummary && (!prev.reply || prev.replySource === 'assistant-message')) {
              if (prev.replySource === 'assistant-message') {
                prev.replySource = 'assistant-message+task-complete';
                prev.taskCompleteSummary = summary;
              } else if (!prev.reply) {
                prev.reply = summary;
                prev.replySource = 'task-complete-summary';
              }
            }
            lastEmitted.taskCompleteId = event.id;
            continue;
          }

          // Orphan task_complete with restored lastUser from opts but no open loop object.
          if (opts.lastUserPrompt && !loop) {
            loop = emptyCopilotLoop(opts.lastUserPrompt, opts.lastUserAt || null);
            loop.taskCompleteId = event.id;
            loop.taskCompleteAt = completeAt;
            loop.taskCompleteSummary = summary;
            loop.loopComplete = true;
            flushLoop(false);
          }
          continue;
        }
      }
      carry = Buffer.from(bytes.subarray(start));
    }
    position = position - carry.length;
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`events: ${err.code || err.message}`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }

  // Trailing completed loop (turn_end already set loopComplete) — flush if still open.
  if (loop && loop.loopComplete) {
    flushLoop(false);
  }

  const pending = loop && !loop.loopComplete ? serializeCopilotPending(loop) : null;
  return {
    records: results,
    errors,
    offset: position,
    identity,
    lastUserPrompt: pending ? pending.userText : null,
    lastUserAt: pending ? pending.userAt : null,
    pending,
  };
}

function copilotEventsPath(session, env) {
  if (!session || !isSafeChatId(session.chatId)) return null;
  return path.join(copilot.sessionStateRoot(env), session.chatId, 'events.jsonl');
}

/**
 * Capture new Copilot turns for one session into turns.jsonl.
 */
function syncCopilotSession(session, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const apply = opts.apply !== false && !dryRun;
  const env = opts.env || process.env;
  const errors = [];
  const summary = {
    sessionId: session.id,
    engine: 'copilot',
    scanned: 0,
    written: 0,
    skipped: 0,
    wouldWrite: 0,
    dryRun: !apply,
    skippedReason: null,
  };
  if (!session || session.engine !== 'copilot') {
    summary.skippedReason = 'not-copilot';
    return { ...summary, errors };
  }
  if (!isSafeChatId(session.chatId)) {
    summary.skippedReason = 'invalid-chat-id';
    errors.push(`${session.title || session.id}: invalid Copilot chat ID`);
    return { ...summary, errors };
  }
  const file = copilotEventsPath(session, env);
  const index = loadTurnsIndex(session.id);
  const fullScan = Boolean(opts.fullScan);
  const walked = iterCopilotTurnCandidates(file, {
    offset: fullScan ? 0 : index.copilotOffset || 0,
    identity: fullScan ? null : index.copilotIdentity,
    lastUserPrompt: fullScan ? null : index.lastUserPrompt,
    lastUserAt: fullScan ? null : index.lastUserAt,
    pending: fullScan ? null : index.copilotPending,
    source: opts.source || (fullScan ? 'copilot-events-backfill' : 'copilot-events'),
  });
  errors.push(...walked.errors.map((e) => `${session.title || session.id}: ${e}`));
  summary.scanned = walked.records.length;

  for (const rec of walked.records) {
    const result = appendTurn(
      {
        sessionId: session.id,
        chatId: session.chatId,
        engine: 'copilot',
        ...rec,
      },
      {
        dryRun: !apply,
        index,
        skipIndexSave: true,
        meta: opts.meta,
      }
    );
    if (result.written) summary.written += 1;
    else if (result.reason === 'dry-run') summary.wouldWrite += 1;
    else if (result.reason === 'duplicate') summary.skipped += 1;
  }

  if (apply && (walked.identity != null || summary.written > 0 || walked.pending != null)) {
    if (walked.identity != null) {
      index.copilotOffset = walked.offset;
      index.copilotIdentity = walked.identity;
    }
    index.lastUserPrompt = walked.lastUserPrompt || null;
    index.lastUserAt = walked.lastUserAt || null;
    index.copilotPending = walked.pending || null;
    saveTurnsIndex(session.id, index);
  } else if (!apply && walked.identity != null) {
    // dry-run still reports wouldWrite via appendTurn; do not mutate index disk
  }
  return { ...summary, errors };
}

function cursorHome(env = process.env) {
  if (env.AGENTFLEET_CURSOR_HOME) return path.resolve(String(env.AGENTFLEET_CURSOR_HOME));
  return path.join(homeDir(), '.cursor');
}

/**
 * Find unique agent-transcripts/<chatId> directory under ~/.cursor/projects.
 * Never follows symlinks out of the projects root.
 */
function findCursorTranscriptDir(chatId, env = process.env) {
  if (!isSafeChatId(chatId)) return { path: null, status: 'invalid-chat-id' };
  const projectsRoot = path.join(cursorHome(env), 'projects');
  let rootStat;
  try {
    rootStat = fs.lstatSync(projectsRoot);
  } catch (err) {
    if (err.code === 'ENOENT') return { path: null, status: 'missing' };
    return { path: null, status: 'error', error: err.code || err.message };
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    return { path: null, status: 'missing' };
  }
  let slugs;
  try {
    slugs = fs.readdirSync(projectsRoot);
  } catch (_) {
    return { path: null, status: 'missing' };
  }
  const hits = [];
  for (const slug of slugs) {
    if (!slug || slug.startsWith('.')) continue;
    const candidate = path.join(projectsRoot, slug, 'agent-transcripts', chatId);
    try {
      const st = fs.lstatSync(candidate);
      if (st.isSymbolicLink()) continue;
      if (st.isDirectory()) hits.push(candidate);
    } catch (_) {
      /* skip */
    }
  }
  if (hits.length === 0) return { path: null, status: 'missing' };
  if (hits.length > 1) return { path: null, status: 'ambiguous', hits };
  return { path: hits[0], status: 'found' };
}

function extractCursorMessageText(node) {
  if (node == null) return null;
  if (typeof node === 'string' && node.trim()) return node;
  if (typeof node !== 'object') return null;
  for (const key of ['text', 'content', 'message', 'prompt', 'body']) {
    const v = node[key];
    if (typeof v === 'string' && v.trim()) return v;
    if (Array.isArray(v)) {
      const parts = v
        .map((p) => {
          if (typeof p === 'string') return p;
          if (p && typeof p.text === 'string') return p.text;
          if (p && typeof p.content === 'string') return p.content;
          return '';
        })
        .filter(Boolean);
      if (parts.length) return parts.join('\n');
    }
    if (v && typeof v === 'object') {
      const nested = extractCursorMessageText(v);
      if (nested) return nested;
    }
  }
  return null;
}

function cursorRole(obj) {
  const role = String(obj.role || obj.type || obj.author || '').toLowerCase();
  if (role === 'user' || role === 'human') return 'user';
  if (role === 'assistant' || role === 'agent' || role === 'model' || role === 'ai') return 'assistant';
  if (obj.type === 'user.message' || obj.kind === 'user') return 'user';
  if (obj.type === 'assistant.message' || obj.kind === 'assistant') return 'assistant';
  return null;
}

/**
 * Best-effort parse of Cursor agent-transcript JSONL into turn candidates.
 * Pairs each user message with the following assistant message.
 */
function iterCursorTranscriptTurns(transcriptDir, opts = {}) {
  const records = [];
  const errors = [];
  if (!transcriptDir) return { records, errors, files: {} };
  let names;
  try {
    names = fs.readdirSync(transcriptDir).filter((n) => n.endsWith('.jsonl'));
  } catch (err) {
    if (err.code !== 'ENOENT') errors.push(`transcripts: ${err.code || err.message}`);
    return { records, errors, files: {} };
  }
  names.sort();
  const fileOffsets = { ...(opts.fileOffsets || {}) };
  for (const name of names) {
    const file = path.join(transcriptDir, name);
    let st;
    try {
      st = fs.lstatSync(file);
    } catch (_) {
      continue;
    }
    if (st.isSymbolicLink() || !st.isFile()) continue;
    let start = fileOffsets[name] || 0;
    if (start > st.size) start = 0;
    let text;
    try {
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(st.size - start);
        if (buf.length) fs.readSync(fd, buf, 0, buf.length, start);
        text = buf.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      errors.push(`transcript ${name}: ${err.code || err.message}`);
      continue;
    }
    let pendingUser = null;
    const lines = text.split(/\n/);
    // If we started mid-file, ignore a partial first line only when start>0 and no prior carry —
    // we read from byte offset so first line should be complete when offset is at prior newline.
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const role = cursorRole(obj);
      const textBody = extractCursorMessageText(obj.message != null ? obj.message : obj);
      const atRaw = obj.timestamp || obj.createdAt || obj.at || null;
      const at =
        typeof atRaw === 'string' && Number.isFinite(Date.parse(atRaw))
          ? new Date(atRaw).toISOString()
          : null;
      if (role === 'user' && textBody) {
        pendingUser = { text: textBody, at, id: obj.id || obj.messageId || null };
        continue;
      }
      if (role === 'assistant' && textBody && pendingUser) {
        records.push({
          engineEventId: obj.id || obj.messageId || null,
          at: at || pendingUser.at || nowIso(),
          prompt: pendingUser.text,
          promptSource: 'cursor-transcript',
          reply: textBody,
          replySource: 'cursor-transcript',
          source: opts.source || 'cursor-transcript',
        });
        pendingUser = null;
      }
    }
    fileOffsets[name] = st.size;
  }
  return { records, errors, files: fileOffsets };
}

/**
 * Capture OpenCode turns from opencode.db (READ-ONLY) into turns.jsonl.
 * Dedupes via engineEventId (message id) like Copilot capture.
 */
function syncOpencodeSession(session, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const apply = opts.apply !== false && !dryRun;
  const env = opts.env || process.env;
  const errors = [];
  const summary = {
    sessionId: session.id,
    engine: 'opencode',
    scanned: 0,
    written: 0,
    skipped: 0,
    wouldWrite: 0,
    dryRun: !apply,
    skippedReason: null,
  };
  if (!session || session.engine !== 'opencode') {
    summary.skippedReason = 'not-opencode';
    return { ...summary, errors };
  }
  if (!opencode.isSafeSessionId(session.chatId)) {
    summary.skippedReason = 'invalid-chat-id';
    errors.push(`${session.title || session.id}: invalid OpenCode session id`);
    return { ...summary, errors };
  }
  const walked = opencode.iterSessionTurns(session.chatId, {
    env,
    dbPath: opts.dbPath || null,
  });
  if (walked.unavailable) {
    summary.skippedReason = 'sqlite-unavailable';
    errors.push(...(walked.errors || []).map((e) => `${session.title || session.id}: ${e}`));
    return { ...summary, errors };
  }
  errors.push(...(walked.errors || []).map((e) => `${session.title || session.id}: ${e}`));
  const index = loadTurnsIndex(session.id);
  const seen = new Set(index.opencodeSeen || []);
  const records = walked.records || [];
  summary.scanned = records.length;

  for (const rec of records) {
    if (!opts.fullScan && rec.engineEventId && seen.has(String(rec.engineEventId))) {
      summary.skipped += 1;
      continue;
    }
    const result = appendTurn(
      {
        sessionId: session.id,
        chatId: session.chatId,
        engine: 'opencode',
        source: opts.source || (opts.fullScan ? 'opencode-db-backfill' : 'opencode-db'),
        ...rec,
      },
      {
        dryRun: !apply,
        index,
        skipIndexSave: true,
        meta: opts.meta,
      }
    );
    if (result.written) summary.written += 1;
    else if (result.reason === 'dry-run') summary.wouldWrite += 1;
    else if (result.reason === 'duplicate') summary.skipped += 1;
    if (rec.engineEventId) seen.add(String(rec.engineEventId));
  }

  if (apply) {
    index.opencodeSeen = Array.from(seen);
    saveTurnsIndex(session.id, index);
  }
  return { ...summary, errors };
}

function syncCursorSession(session, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const apply = opts.apply !== false && !dryRun;
  const env = opts.env || process.env;
  const errors = [];
  const summary = {
    sessionId: session.id,
    engine: 'cursor',
    scanned: 0,
    written: 0,
    skipped: 0,
    wouldWrite: 0,
    dryRun: !apply,
    skippedReason: null,
  };
  if (!session || (session.engine && session.engine !== 'cursor')) {
    summary.skippedReason = 'not-cursor';
    return { ...summary, errors };
  }
  if (!isSafeChatId(session.chatId)) {
    summary.skippedReason = 'invalid-chat-id';
    return { ...summary, errors };
  }
  const found = findCursorTranscriptDir(session.chatId, env);
  if (found.status !== 'found') {
    summary.skippedReason =
      found.status === 'ambiguous' ? 'ambiguous-transcript' : found.status === 'missing' ? 'no-transcript' : found.status;
    if (found.status === 'ambiguous') {
      errors.push(`${session.title || session.id}: Cursor transcript path ambiguous`);
    }
    return { ...summary, errors };
  }
  const index = loadTurnsIndex(session.id);
  const walked = iterCursorTranscriptTurns(found.path, {
    fileOffsets: opts.fullScan ? {} : index.cursorFiles,
    source: opts.source || (opts.fullScan ? 'cursor-transcript' : 'cursor-transcript'),
  });
  errors.push(...walked.errors.map((e) => `${session.title || session.id}: ${e}`));
  summary.scanned = walked.records.length;
  for (const rec of walked.records) {
    const result = appendTurn(
      {
        sessionId: session.id,
        chatId: session.chatId,
        engine: 'cursor',
        ...rec,
      },
      {
        dryRun: !apply,
        index,
        skipIndexSave: true,
        meta: opts.meta,
      }
    );
    if (result.written) summary.written += 1;
    else if (result.reason === 'dry-run') summary.wouldWrite += 1;
    else if (result.reason === 'duplicate') summary.skipped += 1;
  }
  if (apply && (summary.written > 0 || Object.keys(walked.files || {}).length)) {
    index.cursorFiles = walked.files;
    saveTurnsIndex(session.id, index);
  }
  return { ...summary, errors };
}

/**
 * Sparse Herdr OSC completion candidate (no invented prompt/reply).
 */
function appendOscCandidate(session, opts = {}) {
  if (!session || !session.id) return { written: false, reason: 'missing-session' };
  const at = opts.at || nowIso();
  return appendTurn(
    {
      sessionId: session.id,
      chatId: session.chatId || null,
      engine: session.engine || null,
      source: 'herdr-osc',
      at,
      prompt: null,
      reply: null,
      promptSource: 'unknown',
      replySource: 'unknown',
      herdrStatusAtComplete: opts.herdrStatusAtComplete != null ? opts.herdrStatusAtComplete : 'done',
      incomplete: true,
      turnId: opts.turnId || `osc-${session.id}-${at}`,
      engineEventId: opts.engineEventId || `osc:${session.id}:${at}`,
    },
    { dryRun: Boolean(opts.dryRun), meta: opts.meta }
  );
}

/**
 * Live capture for dashboard polls: always write local turns.jsonl (not gated
 * by --capture-completions). Prefers engine-native Copilot events; Cursor
 * transcripts when uniquely mapped. Optional OSC sparse turns on new completion.
 */
function captureSessions(sessions, opts = {}) {
  const list = Array.isArray(sessions) ? sessions : [];
  const errors = [];
  const results = [];
  const cache = opts.cache || null;
  const env = opts.env || process.env;
  const activityById = opts.sessionActivityById || {};
  const previousActivity = opts.previousActivityById || {};

  for (const session of list) {
    if (!session || !session.id) continue;
    let summary;
    if (session.engine === 'copilot') {
      summary = syncCopilotSession(session, {
        env,
        apply: true,
        dryRun: false,
        fullScan: false,
        meta: opts.meta,
      });
    } else if (session.engine === 'opencode') {
      summary = syncOpencodeSession(session, {
        env,
        apply: true,
        dryRun: false,
        fullScan: false,
        meta: opts.meta,
      });
    } else if (session.engine === 'cursor' || !session.engine) {
      summary = syncCursorSession(session, {
        env,
        apply: true,
        dryRun: false,
        fullScan: false,
        meta: opts.meta,
      });
    } else {
      continue;
    }
    results.push(summary);
    errors.push(...(summary.errors || []));

    // OSC enrichment: only when we newly observe completed and no engine text yet.
    if (opts.captureOsc !== false) {
      const prev = previousActivity[session.id] || {};
      const next = activityById[session.id] || {};
      if (next.completed && !prev.completed) {
        const osc = appendOscCandidate(session, {
          herdrStatusAtComplete: 'done',
          meta: opts.meta,
        });
        if (osc.written) {
          // Immediately try hydrate from engine (Copilot re-sync / Cursor).
          if (session.engine === 'copilot') {
            syncCopilotSession(session, { env, apply: true, fullScan: true, meta: opts.meta });
          } else if (session.engine === 'opencode') {
            syncOpencodeSession(session, { env, apply: true, fullScan: true, meta: opts.meta });
          } else {
            syncCursorSession(session, { env, apply: true, fullScan: true, meta: opts.meta });
          }
        }
      }
    }
    if (cache && typeof cache.set === 'function') {
      cache.set(session.id, { at: nowIso(), written: summary.written });
    }
  }
  return { results, errors: errors.slice(0, 40).map((e) => memory.redactSensitive(String(e))) };
}

/**
 * One-time / repeatable backfill. Dry-run by default; pass apply:true to write.
 */
function backfillTurns(sessions, opts = {}) {
  const apply = Boolean(opts.apply);
  const dryRun = !apply;
  const engineFilter = String(opts.engine || 'all').toLowerCase();
  const list = Array.isArray(sessions) ? sessions : [];
  const env = opts.env || process.env;
  const out = [];
  const errors = [];

  for (const session of list) {
    if (!session || !session.id) continue;
    const eng = String(session.engine || 'cursor').toLowerCase();
    if (engineFilter !== 'all' && eng !== engineFilter) continue;

    let summary;
    if (eng === 'copilot') {
      summary = syncCopilotSession(session, {
        env,
        apply,
        dryRun,
        fullScan: true,
        source: 'copilot-events-backfill',
        meta: opts.meta,
      });
    } else if (eng === 'opencode') {
      summary = syncOpencodeSession(session, {
        env,
        apply,
        dryRun,
        fullScan: true,
        source: 'opencode-db-backfill',
        meta: opts.meta,
        dbPath: opts.dbPath || null,
      });
    } else if (eng === 'cursor') {
      summary = syncCursorSession(session, {
        env,
        apply,
        dryRun,
        fullScan: true,
        source: 'cursor-transcript',
        meta: opts.meta,
      });
    } else {
      summary = {
        sessionId: session.id,
        engine: eng,
        scanned: 0,
        written: 0,
        skipped: 0,
        dryRun,
        skippedReason: 'unsupported-engine',
        errors: [],
      };
    }
    out.push({
      id: session.id,
      title: session.title || session.id,
      engine: eng,
      chatId: session.chatId || null,
      scanned: summary.scanned,
      wouldWrite: dryRun ? summary.wouldWrite || 0 : undefined,
      written: apply ? summary.written : 0,
      skipped: summary.skipped,
      dryRun,
      skippedReason: summary.skippedReason || null,
    });
    errors.push(...(summary.errors || []));
  }

  return {
    ok: true,
    apply,
    dryRun,
    engine: engineFilter,
    sessions: out,
    totals: {
      sessions: out.length,
      scanned: out.reduce((n, s) => n + (s.scanned || 0), 0),
      written: out.reduce((n, s) => n + (s.written || 0), 0),
      wouldWrite: out.reduce((n, s) => n + (s.wouldWrite || 0), 0),
      skipped: out.reduce((n, s) => n + (s.skipped || 0), 0),
    },
    errors: errors.slice(0, 40).map((e) => memory.redactSensitive(String(e))),
  };
}

module.exports = {
  TURN_VERSION,
  TEXT_CAP,
  TURN_CAPTURED_TYPE,
  TURN_CAPTURED_DEFERRED,
  setTurnCapturedHandler,
  getTurnCapturedHandler,
  turnsDir,
  turnsPath,
  turnsIndexPath,
  dedupeKey,
  prepareTurnRecord,
  appendTurn,
  emitTurnCaptured,
  sendTurnToDocBot,
  formatTurnMessageBody,
  findDocBotSession,
  readTurns,
  loadTurnsIndex,
  saveTurnsIndex,
  iterCopilotTurnCandidates,
  syncCopilotSession,
  syncOpencodeSession,
  syncCursorSession,
  findCursorTranscriptDir,
  iterCursorTranscriptTurns,
  appendOscCandidate,
  captureSessions,
  backfillTurns,
  extractUserMessageText,
  isSafeChatId,
  cursorHome,
};
