'use strict';

/**
 * Interactive turn capture — durable prompt↔reply records under
 * `$AGENTFLEET_HOME/runs/<id>/turns.jsonl` for History Gantt + panel.
 *
 * Copilot: pair each `user.message` with the final `assistant.message` of the
 * following agent loop (completed on the next *new* turn's `user.message`, or
 * on a trailing `assistant.turn_end` whose last assistant message has no pending
 * `toolRequests`). Mid-turn steering `user.message` events join onto the open
 * loop prompt. Successful `session.task_complete` merges into the same turn
 * (prefer assistant text; use the summary only when there is no assistant text)
 * and always pairs with the most recent preceding `user.message`. Re-backfill
 * patches existing turns.jsonl rows that lack a prompt (no duplicates).
 * Cursor: best-effort agent-transcript JSONL when uniquely mapped.
 * Emit hook (`emitTurnCaptured`) enqueues a redacted turn for batched Doc Bot
 * notify (`agentDocs.enqueueTurnCaptured` → flush after a dated note is written).
 * Immediate per-turn DMs are replaced by batches; messaging stays optional.
 * Optional `setTurnCapturedHandler` still runs after enqueue.
 *
 * Never scrapes Herdr PTY buffers.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const copilot = require('./copilot');
const opencode = require('./opencode');
const memory = require('./memory');
const usage = require('./usage');
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
 * Queue turn for batched Doc Bot notify (notes-before-notify). Never throws;
 * never wakes agents. Immediate per-turn DMs are intentionally not sent here.
 * @returns {{ sent: boolean, queued?: boolean, reason?: string, message?: object|null, pending?: object|null }}
 */
function sendTurnToDocBot(turn, meta = {}) {
  if (!turn || !turn.sessionId) {
    return { sent: false, queued: false, reason: 'missing sessionId' };
  }
  try {
    const agentDocs = require('./agent-docs');
    const result = agentDocs.enqueueTurnCaptured(turn, meta);
    return {
      sent: false,
      queued: Boolean(result && result.queued),
      pending: result && result.pending ? result.pending : null,
      boundary: result && result.boundary ? result.boundary : null,
      reason: result && result.queued
        ? 'queued for batched Doc Bot notify after note written'
        : (result && result.reason) || 'enqueue failed',
      message: null,
    };
  } catch (err) {
    return {
      sent: false,
      queued: false,
      reason: String(err && err.message ? err.message : err),
      message: null,
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

function usageSummaryPath(sessionId) {
  return path.join(turnsDir(sessionId), 'usage-summary.json');
}

function ensureTurnsDir(sessionId) {
  const dir = turnsDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Atomically write runs/<id>/usage-summary.json (mode 0600).
 */
function writeUsageSummary(sessionId, summary) {
  if (!sessionId) return null;
  ensureTurnsDir(sessionId);
  const file = usageSummaryPath(sessionId);
  const payload = summary && typeof summary === 'object' ? summary : usage.summarizeSessionUsage([]);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', {
    encoding: 'utf8',
    mode: 0o600,
  });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    /* ignore */
  }
  return payload;
}

/**
 * Rebuild usage-summary.json from turns.jsonl.
 */
function rebuildUsageSummary(sessionId, opts = {}) {
  const turns = opts.turns || readTurns(sessionId);
  const summary = usage.summarizeSessionUsage(turns, {
    updatedAt: opts.updatedAt || nowIso(),
  });
  if (opts.dryRun) return summary;
  return writeUsageSummary(sessionId, summary);
}

/**
 * Read usage-summary.json, falling back to summarizing turns.jsonl.
 */
function readUsageSummary(sessionId) {
  if (!sessionId) return null;
  const file = usageSummaryPath(sessionId);
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      /* corrupt → fall through */
    }
  }
  try {
    return usage.summarizeSessionUsage(readTurns(sessionId));
  } catch (_) {
    return usage.summarizeSessionUsage([]);
  }
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
  if (input.usage != null && typeof input.usage === 'object') {
    const normalized =
      input.usage.v === usage.USAGE_VERSION && input.usage.accuracy
        ? usage.finalizeUsage(input.usage)
        : usage.normalizeUsage(input.usage, {
            cli: input.engine || input.usage.cli,
            source: input.usage.source,
            model: input.usage.model,
            accuracy: input.usage.accuracy,
          });
    if (normalized) turn.usage = normalized;
  }
  return turn;
}

/**
 * Rewrite turns.jsonl atomically (preserve order). Used to backfill missing prompts.
 * Also rebuilds usage-summary.json unless opts.skipUsageSummary.
 */
function rewriteTurnsFile(sessionId, rows, opts = {}) {
  ensureTurnsDir(sessionId);
  const file = turnsPath(sessionId);
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const body =
    (Array.isArray(rows) ? rows : []).map((row) => JSON.stringify(row)).join('\n') +
    (rows && rows.length ? '\n' : '');
  fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch (_) {
    /* ignore */
  }
  if (!opts.skipUsageSummary) {
    rebuildUsageSummary(sessionId, { turns: rows });
  }
}

/**
 * If an existing turn matched by dedupe key lacks a prompt and `prepared` has one,
 * patch the row in place. Idempotent; never inserts a duplicate row.
 * @returns {boolean} true when a row was updated (or would be, when dryRun)
 */
function patchTurnPromptIfMissing(sessionId, prepared, matchKeys, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  const prompt =
    prepared && prepared.prompt != null && String(prepared.prompt).trim()
      ? String(prepared.prompt)
      : null;
  if (!sessionId || !prompt) return false;
  const keys = Array.isArray(matchKeys) ? matchKeys : preparedOrMatchKeysToArray(prepared, matchKeys);
  const keySet = new Set(keys.map(String).filter(Boolean));
  if (!keySet.size) keySet.add(dedupeKey(prepared));
  const rows = readTurns(sessionId);
  let changed = false;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rowKey = dedupeKey(row);
    const eventKey =
      row.engineEventId != null && String(row.engineEventId).trim()
        ? `event:${String(row.engineEventId).trim()}`
        : null;
    if (!keySet.has(rowKey) && !(eventKey && keySet.has(eventKey))) continue;
    if (row.prompt != null && String(row.prompt).trim()) continue;
    row.prompt = prompt;
    row.promptSource =
      prepared.promptSource || row.promptSource || 'events-user-message';
    if (prepared.promptTruncated) row.promptTruncated = true;
    changed = true;
  }
  if (changed && !dryRun) rewriteTurnsFile(sessionId, rows);
  return changed;
}

function preparedOrMatchKeysToArray(prepared, matchKeys) {
  if (Array.isArray(matchKeys)) return matchKeys;
  if (matchKeys == null) return [];
  return [matchKeys];
}

/**
 * Idempotent usage patch: never overwrites reported with estimated;
 * upgrades estimated → reported when real usage arrives.
 * `preparedOrMatchKeys` may be a prepared turn, a dedupe key string, or key array.
 * @returns {{ updated: boolean, turn?: object|null }}
 */
function patchTurnUsageIfMissing(sessionId, preparedOrMatchKeys, incomingUsage, opts = {}) {
  const dryRun = Boolean(opts.dryRun);
  if (!sessionId || !incomingUsage) return { updated: false };
  const normalized =
    incomingUsage.v === usage.USAGE_VERSION && incomingUsage.accuracy
      ? usage.finalizeUsage(incomingUsage)
      : usage.normalizeUsage(incomingUsage, {
          cli: opts.cli || incomingUsage.cli,
          source: incomingUsage.source || opts.source,
          model: incomingUsage.model || opts.model,
          accuracy: incomingUsage.accuracy || opts.accuracy,
        });
  if (!normalized) return { updated: false };

  let keys = [];
  let prepared = null;
  if (preparedOrMatchKeys && typeof preparedOrMatchKeys === 'object' && !Array.isArray(preparedOrMatchKeys)) {
    prepared = preparedOrMatchKeys;
    keys = [dedupeKey(prepared)];
    if (prepared.engineEventId) keys.push(`event:${String(prepared.engineEventId).trim()}`);
    if (Array.isArray(prepared.alsoDedupeIds)) {
      for (const id of prepared.alsoDedupeIds) {
        if (id) keys.push(`event:${String(id).trim()}`);
      }
    }
  } else if (Array.isArray(preparedOrMatchKeys)) {
    keys = preparedOrMatchKeys.map(String);
  } else if (preparedOrMatchKeys != null) {
    keys = [String(preparedOrMatchKeys)];
  }
  const keySet = new Set(keys.filter(Boolean));
  if (!keySet.size) return { updated: false };

  const rows = readTurns(sessionId);
  let changed = false;
  let matched = null;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const rowKey = dedupeKey(row);
    const eventKey =
      row.engineEventId != null && String(row.engineEventId).trim()
        ? `event:${String(row.engineEventId).trim()}`
        : null;
    if (!keySet.has(rowKey) && !(eventKey && keySet.has(eventKey))) continue;
    if (!usage.shouldReplaceUsage(row.usage || null, normalized)) continue;
    row.usage = normalized;
    matched = row;
    changed = true;
  }
  if (changed && !dryRun) rewriteTurnsFile(sessionId, rows);
  return { updated: changed, turn: matched };
}

/**
 * Append a turn if not already indexed. Always redacts before write.
 * When a duplicate exists but lacks a prompt and the new record has one, patches
 * the existing turns.jsonl row (idempotent; no duplicate insert).
 * @returns {{ written: boolean, updated?: boolean, turn: object|null, key: string|null, reason?: string }}
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
    const patched = patchTurnPromptIfMissing(turn.sessionId, turn, [key, ...extraKeys], {
      dryRun,
    });
    let usagePatched = false;
    if (turn.usage) {
      const ur = patchTurnUsageIfMissing(turn.sessionId, turn, turn.usage, { dryRun });
      usagePatched = Boolean(ur.updated);
    }
    if (!opts.skipIndexSave && !dryRun) saveTurnsIndex(turn.sessionId, index);
    if (patched || usagePatched) {
      return {
        written: false,
        updated: true,
        turn,
        key,
        reason: patched && usagePatched
          ? 'updated-prompt+usage'
          : patched
            ? 'updated-prompt'
            : 'updated-usage',
      };
    }
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
  if (!opts.skipUsageSummary) rebuildUsageSummary(turn.sessionId);
  let envelope = null;
  if (!opts.skipEmit) {
    envelope = emitTurnCaptured(turn, opts.meta || {});
  }
  return { written: true, turn, key, envelope };
}

/**
 * Issue #3 lifecycle hook: enqueue redacted turn for batched Doc Bot notify
 * (and maybe request a checkpoint at the turn-complete boundary). Notes must
 * be written before a batch flush sends. Messaging optional. Never wakes agents.
 */
function emitTurnCaptured(turn, meta = {}) {
  const notify = sendTurnToDocBot(turn, meta);
  const envelope = {
    type: TURN_CAPTURED_TYPE,
    issue: 2,
    deferred: !notify.sent,
    sent: Boolean(notify.sent),
    queued: Boolean(notify.queued),
    pendingId: notify.pending && notify.pending.id ? notify.pending.id : null,
    reason: notify.sent
      ? null
      : notify.reason || TURN_CAPTURED_DEFERRED.reason,
    message: notify.message || null,
    turn: turn || null,
    sessionId: turn && turn.sessionId != null ? turn.sessionId : null,
    project: meta.project != null ? meta.project : null,
    memoryHint: meta.memoryHint != null ? meta.memoryHint : null,
    boundary: notify.boundary || null,
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
    usageRecords: [],
    usageRecordKeys: new Set(),
    checkpointBefore: null,
    checkpointAfter: null,
    shutdownMetrics: null,
    resultUsage: null,
  };
}

function restoreCopilotLoop(pending, lastUserPrompt, lastUserAt) {
  if (pending && typeof pending === 'object' && (pending.userText || lastUserPrompt)) {
    const loop = {
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
      usageRecords: Array.isArray(pending.usageRecords) ? pending.usageRecords.slice() : [],
      usageRecordKeys: new Set(
        Array.isArray(pending.usageRecordKeys) ? pending.usageRecordKeys.map(String) : []
      ),
      checkpointBefore: pending.checkpointBefore || null,
      checkpointAfter: pending.checkpointAfter || null,
      shutdownMetrics: pending.shutdownMetrics || null,
      resultUsage: pending.resultUsage || null,
    };
    return loop;
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
    usageRecords: Array.isArray(loop.usageRecords) ? loop.usageRecords.slice() : [],
    usageRecordKeys: loop.usageRecordKeys
      ? Array.from(loop.usageRecordKeys)
      : [],
    checkpointBefore: loop.checkpointBefore || null,
    checkpointAfter: loop.checkpointAfter || null,
    shutdownMetrics: loop.shutdownMetrics || null,
    resultUsage: loop.resultUsage || null,
  };
}

function copilotUsageRecordKey(event, data) {
  const accounting = (data && data.accounting) || {};
  const sourceSessionId =
    accounting.sourceSessionId ||
    accounting.sessionId ||
    (data && data.sourceSessionId) ||
    null;
  const sequence =
    accounting.sequence != null
      ? accounting.sequence
      : data && data.sequence != null
        ? data.sequence
        : null;
  if (sourceSessionId != null && sequence != null) {
    return `acct:${sourceSessionId}:${sequence}`;
  }
  if (event && typeof event.id === 'string' && event.id) return `id:${event.id}`;
  return null;
}

/**
 * Resolve best Copilot usage for a completed loop.
 * Prefer usage_record events; else checkpoint/shutdown modelMetrics delta;
 * else chars/4 estimate when prompt/reply exist.
 */
function resolveCopilotLoopUsage(loop, opts = {}) {
  if (!loop) return null;
  const records = Array.isArray(loop.usageRecords) ? loop.usageRecords : [];
  if (records.length) {
    // Sum multiple usage_record events in the window (multi-model steps).
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheReadTokens = 0;
    let cacheWriteTokens = 0;
    let reasoningTokens = 0;
    let cost = 0;
    let duration = 0;
    let model = null;
    for (const raw of records) {
      inputTokens += Number(raw.inputTokens) || 0;
      outputTokens += Number(raw.outputTokens) || 0;
      cacheReadTokens +=
        Number(raw.cacheReadTokens != null ? raw.cacheReadTokens : raw.cacheRead) || 0;
      cacheWriteTokens +=
        Number(raw.cacheWriteTokens != null ? raw.cacheWriteTokens : raw.cacheWrite) || 0;
      reasoningTokens += Number(raw.reasoningTokens) || 0;
      if (raw.cost != null) cost += Number(raw.cost) || 0;
      if (raw.duration != null) duration += Number(raw.duration) || 0;
      if (!model && raw.model) model = raw.model;
    }
    return usage.normalizeCopilotUsage(
      {
        model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        cost: cost || null,
        duration: duration || null,
      },
      { source: 'copilot-usage-record' }
    );
  }

  if (loop.checkpointAfter || loop.shutdownMetrics) {
    const after = loop.checkpointAfter || loop.shutdownMetrics;
    const before = loop.checkpointBefore || null;
    const delta = before
      ? usage.deltaCopilotModelMetrics(after, before)
      : usage.sumCopilotModelMetrics(after);
    if (delta) {
      return usage.normalizeCopilotUsage(delta, {
        source: loop.checkpointAfter
          ? 'copilot-usage-checkpoint'
          : 'copilot-shutdown',
      });
    }
  }

  if (loop.resultUsage) {
    return usage.normalizeCopilotUsage(loop.resultUsage, { source: 'copilot-result' });
  }

  const reply =
    (loop.assistantText != null && String(loop.assistantText).trim()
      ? String(loop.assistantText)
      : null) ||
    (loop.taskCompleteSummary != null && String(loop.taskCompleteSummary).trim()
      ? String(loop.taskCompleteSummary)
      : null);
  if (loop.userText || reply) {
    return usage.estimateUsageFromText({
      prompt: loop.userText,
      reply,
      cli: 'copilot',
      accuracy: opts.estimateAccuracy || 'estimated',
    });
  }
  return null;
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

  const rec = {
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
  const resolvedUsage = resolveCopilotLoopUsage(loop, opts);
  if (resolvedUsage) rec.usage = resolvedUsage;
  return rec;
}

function isSafeChatId(chatId) {
  return typeof chatId === 'string' && UUID_RE.test(chatId);
}

/**
 * Walk Copilot events.jsonl; yield completed turns.
 * Pairs each user.message with the final assistant.message of the agent loop
 * (and/or a successful session.task_complete). Mid-turn steering user.messages
 * join onto the open loop's prompt (keep the first + append). Orphan
 * task_complete events pair with the most recent preceding user.message.
 * Does not follow symlinks.
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
  // Most recent preceding user.message in this walk (and restored prior prompt).
  let lastSeenUserText =
    (loop && loop.userText) ||
    (typeof opts.lastUserPrompt === 'string' && opts.lastUserPrompt
      ? opts.lastUserPrompt
      : null);
  let lastSeenUserAt =
    (loop && loop.userAt) ||
    (typeof opts.lastUserAt === 'string' && opts.lastUserAt ? opts.lastUserAt : null);
  // Latest Copilot accounting snapshot seen (for checkpoint deltas across turns).
  let lastCheckpointMetrics = (loop && loop.checkpointBefore) || null;
  let position = startOffset;
  let carry = Buffer.alloc(0);

  function attachUsageRecord(event, data) {
    if (!loop) return;
    const rawUsage = data && data.usage && typeof data.usage === 'object' ? data.usage : data;
    if (!rawUsage || typeof rawUsage !== 'object') return;
    if (rawUsage.inputTokens == null && rawUsage.outputTokens == null) return;
    const key = copilotUsageRecordKey(event, data);
    if (!loop.usageRecordKeys) loop.usageRecordKeys = new Set();
    if (!loop.usageRecords) loop.usageRecords = [];
    if (key && loop.usageRecordKeys.has(key)) return;
    if (key) loop.usageRecordKeys.add(key);
    loop.usageRecords.push(rawUsage);
  }

  function noteCheckpointMetrics(data) {
    const snap =
      (data && data.accountingSnapshot && data.accountingSnapshot.modelMetrics) ||
      (data && data.accountingSnapshot && data.accountingSnapshot.providerModelMetrics) ||
      (data && data.modelMetrics) ||
      (data && data.providerModelMetrics) ||
      null;
    if (!snap || typeof snap !== 'object') return null;
    lastCheckpointMetrics = snap;
    if (loop) {
      if (!loop.checkpointBefore) loop.checkpointBefore = snap;
      loop.checkpointAfter = snap;
    }
    return snap;
  }

  function loopHasReply(l) {
    return Boolean(
      (l.assistantText != null && String(l.assistantText).trim()) ||
        (l.taskCompleteSummary != null && String(l.taskCompleteSummary).trim())
    );
  }

  function ensureLoopPrompt(l) {
    if (!l) return;
    if (l.userText != null && String(l.userText).trim()) return;
    if (lastSeenUserText) {
      l.userText = lastSeenUserText;
      if (!l.userAt && lastSeenUserAt) l.userAt = lastSeenUserAt;
    }
  }

  function flushLoop(force = false) {
    if (!loop) return;
    if (!force && !loop.loopComplete && !loop.taskCompleteSummary) return;
    ensureLoopPrompt(loop);
    if (!loopHasReply(loop)) {
      // Structure may be complete but text arrives later (e.g. task_complete).
      // On a forced flush with no reply yet, drop the empty prior loop.
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
            lastSeenUserText = text;
            lastSeenUserAt = at;
            // Mid-turn steering: keep the prompt that started the turn, join extras.
            if (loop && !loop.loopComplete) {
              if (loop.userText != null && String(loop.userText).trim()) {
                if (String(loop.userText) !== text) {
                  loop.userText = `${loop.userText}\n${text}`;
                }
              } else {
                loop.userText = text;
                if (at && !loop.userAt) loop.userAt = at;
              }
              continue;
            }
            flushLoop(true);
            loop = emptyCopilotLoop(text, at);
            if (lastCheckpointMetrics) loop.checkpointBefore = lastCheckpointMetrics;
          }
          continue;
        }

        if (type === 'session.usage_record') {
          attachUsageRecord(event, data);
          continue;
        }

        if (type === 'session.usage_checkpoint') {
          noteCheckpointMetrics(data);
          continue;
        }

        if (type === 'session.shutdown') {
          const snap =
            (data && data.modelMetrics) ||
            (data && data.providerModelMetrics) ||
            null;
          if (snap && typeof snap === 'object') {
            lastCheckpointMetrics = snap;
            if (loop) loop.shutdownMetrics = snap;
          }
          continue;
        }

        if (type === 'result' || type === 'session.result') {
          if (loop && data && data.usage && typeof data.usage === 'object') {
            loop.resultUsage = data.usage;
          }
          continue;
        }

        if (type === 'assistant.message') {
          if (!loop) {
            // Assistant without a captured user.message — open a loop from the
            // most recent preceding user prompt when known.
            if (!lastSeenUserText) continue;
            loop = emptyCopilotLoop(lastSeenUserText, lastSeenUserAt);
          }
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
            ensureLoopPrompt(loop);
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
            if (!prev.prompt && lastSeenUserText) {
              prev.prompt = lastSeenUserText;
              prev.promptSource = 'events-user-message';
            }
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

          // Orphan task_complete: pair with the most recent preceding user.message
          // (from this walk or a restored lastUserPrompt).
          const orphanPrompt = lastSeenUserText || opts.lastUserPrompt || null;
          if (orphanPrompt) {
            loop = emptyCopilotLoop(
              orphanPrompt,
              lastSeenUserAt || opts.lastUserAt || null
            );
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
    updated: 0,
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

  const existingTurns = readTurns(session.id);
  for (const rec of walked.records) {
    // A loop / aflt run already stored this prompt as headless-run. Upgrade
    // its usage instead of inserting a second turn (which would double-count).
    const headlessMatch = findMatchingHeadlessRunTurn(existingTurns, rec, {
      ignoreReply: true,
      windowMs: 6 * 60 * 60 * 1000,
    });
    if (headlessMatch) {
      let didUpdate = false;
      if (rec.usage && apply) {
        const patched = patchTurnUsageIfMissing(session.id, headlessMatch, rec.usage, {
          dryRun: false,
          cli: 'copilot',
          source: rec.usage && rec.usage.source,
        });
        if (patched.updated) {
          didUpdate = true;
          headlessMatch.usage =
            patched.turn && patched.turn.usage ? patched.turn.usage : rec.usage;
          summary.updated += 1;
        }
      }
      if (!didUpdate) summary.skipped += 1;
      continue;
    }
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
        skipUsageSummary: true,
        meta: opts.meta,
      }
    );
    if (result.written) summary.written += 1;
    else if (result.updated) summary.updated += 1;
    else if (result.reason === 'dry-run') summary.wouldWrite += 1;
    else if (result.reason === 'duplicate') summary.skipped += 1;
  }

  if (
    apply &&
    (walked.identity != null ||
      summary.written > 0 ||
      summary.updated > 0 ||
      walked.pending != null)
  ) {
    if (walked.identity != null) {
      index.copilotOffset = walked.offset;
      index.copilotIdentity = walked.identity;
    }
    index.lastUserPrompt = walked.lastUserPrompt || null;
    index.lastUserAt = walked.lastUserAt || null;
    index.copilotPending = walked.pending || null;
    saveTurnsIndex(session.id, index);
    rebuildUsageSummary(session.id);
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

/**
 * Extract assistant text + tool_use payloads for multi-step Cursor turns.
 * Tool inputs are included so chars/4 estimates cover tool-heavy replies
 * (still `accuracy: "estimated"` — never invents reported API tokens).
 */
function extractCursorAssistantAggregate(node) {
  if (node == null) return null;
  if (typeof node === 'string' && node.trim()) return node;
  if (typeof node !== 'object') return null;
  const content = Array.isArray(node.content)
    ? node.content
    : Array.isArray(node.message && node.message.content)
      ? node.message.content
      : null;
  if (content) {
    const parts = [];
    for (const p of content) {
      if (typeof p === 'string' && p.trim()) {
        parts.push(p);
        continue;
      }
      if (!p || typeof p !== 'object') continue;
      const typ = String(p.type || '').toLowerCase();
      if (typ === 'text' || typ === 'output_text') {
        if (typeof p.text === 'string' && p.text.trim()) parts.push(p.text);
        else if (typeof p.content === 'string' && p.content.trim()) parts.push(p.content);
      } else if (typ === 'tool_use' || typ === 'tool_call' || typ === 'function_call') {
        const name = p.name || (p.function && p.function.name) || 'tool';
        let input = p.input != null ? p.input : p.arguments != null ? p.arguments : null;
        if (input && typeof input === 'object') {
          try {
            input = JSON.stringify(input);
          } catch (_) {
            input = String(input);
          }
        } else if (input != null) {
          input = String(input);
        }
        parts.push(`[tool_use ${name}] ${input || ''}`.trim());
      } else if (typeof p.text === 'string' && p.text.trim()) {
        parts.push(p.text);
      }
    }
    if (parts.length) return parts.join('\n');
  }
  return extractCursorMessageText(node);
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
 * Cursor CLI often wraps the user prompt in agent-transcript JSONL as:
 *   <timestamp>…</timestamp>\n<user_query>\n…\n</user_query>
 * Headless `aflt run` stores the bare prompt. Normalize for comparison so
 * syncCursorSession does not append a duplicate cursor-transcript turn.
 */
function normalizeCursorTranscriptPrompt(text) {
  let s = String(text == null ? '' : text);
  // Drop timestamp markers (any content).
  s = s.replace(/<timestamp\b[^>]*>[\s\S]*?<\/timestamp>/gi, '');
  // Prefer the inner <user_query> body when present.
  const queryMatch = s.match(/<user_query\b[^>]*>([\s\S]*?)<\/user_query>/i);
  if (queryMatch) {
    s = queryMatch[1];
  } else {
    s = s.replace(/<\/?user_query\b[^>]*>/gi, '');
  }
  // Collapse whitespace for stable equality with headless prompts.
  return s.replace(/\r\n/g, '\n').replace(/[ \t]+\n/g, '\n').trim();
}

function normalizeTurnReply(text) {
  return String(text == null ? '' : text)
    .replace(/\r\n/g, '\n')
    .trim();
}

const HEADLESS_TRANSCRIPT_MATCH_WINDOW_MS = 5 * 60 * 1000;

/**
 * Find an existing headless-run turn that matches a cursor-transcript candidate
 * (normalized prompt + reply, within a short time window).
 * When the headless row has an empty/missing reply and estimated/zero output
 * (e.g. resource_exhausted before result.usage), match on prompt alone so the
 * transcript can upgrade the sparse estimate.
 * @returns {object|null} the matching turns.jsonl row
 */
function findMatchingHeadlessRunTurn(existingTurns, candidate, opts = {}) {
  const windowMs =
    opts.windowMs != null && Number.isFinite(Number(opts.windowMs))
      ? Math.max(0, Number(opts.windowMs))
      : HEADLESS_TRANSCRIPT_MATCH_WINDOW_MS;
  const ignoreReply = Boolean(opts.ignoreReply);
  const candPrompt = normalizeCursorTranscriptPrompt(candidate && candidate.prompt);
  const candReply = normalizeTurnReply(candidate && candidate.reply);
  if (!candPrompt && !candReply) return null;
  const candAt = candidate && candidate.at ? Date.parse(candidate.at) : NaN;

  const list = Array.isArray(existingTurns) ? existingTurns : [];
  for (let i = list.length - 1; i >= 0; i--) {
    const row = list[i];
    if (!row || row.source !== 'headless-run') continue;
    const rowPrompt = normalizeCursorTranscriptPrompt(row.prompt);
    const rowReply = normalizeTurnReply(row.reply);
    if (ignoreReply && !candPrompt) continue;
    if (candPrompt && rowPrompt !== candPrompt) continue;
    if (!ignoreReply) {
      const sparseHeadless =
        !rowReply &&
        row.usage &&
        row.usage.accuracy === 'estimated' &&
        !(row.usage.outputTokens > 0);
      if (!sparseHeadless && rowReply !== candReply) continue;
    }
    if (Number.isFinite(candAt) && row.at) {
      const rowAt = Date.parse(row.at);
      if (Number.isFinite(rowAt) && Math.abs(candAt - rowAt) > windowMs) continue;
    }
    return row;
  }
  return null;
}

/**
 * Flush a pending multi-step assistant aggregate into a turn record.
 */
function finalizeCursorPendingTurn(pendingUser, assistantParts, opts = {}) {
  if (!pendingUser || !assistantParts || !assistantParts.length) return null;
  const reply = assistantParts
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n');
  if (!reply) return null;
  const last = assistantParts[assistantParts.length - 1];
  const rec = {
    engineEventId: last.id || null,
    at: last.at || pendingUser.at || nowIso(),
    prompt: pendingUser.text,
    promptSource: 'cursor-transcript',
    reply,
    replySource: 'cursor-transcript',
    source: opts.source || 'cursor-transcript',
  };
  // Prefer any reported usage blob from the assistant steps; else estimate.
  let normalized = null;
  for (let i = assistantParts.length - 1; i >= 0; i--) {
    const rawUsage = assistantParts[i].rawUsage;
    if (!rawUsage) continue;
    normalized = usage.normalizeCursorUsage(rawUsage, {
      source: 'cursor-transcript',
      model: assistantParts[i].model || null,
    });
    if (normalized) break;
  }
  if (normalized) {
    rec.usage = normalized;
  } else {
    const estimated = usage.estimateUsageFromText({
      prompt: pendingUser.text,
      reply,
      cli: 'cursor',
    });
    if (estimated) rec.usage = estimated;
  }
  return rec;
}

/**
 * Best-effort parse of Cursor agent-transcript JSONL into turn candidates.
 * Aggregates multi-step assistant replies + tool_use until the next user
 * message or a turn_ended marker (instead of stopping at the first text).
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
    let assistantParts = [];
    const flush = () => {
      const rec = finalizeCursorPendingTurn(pendingUser, assistantParts, opts);
      if (rec) records.push(rec);
      pendingUser = null;
      assistantParts = [];
    };
    const lines = text.split(/\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }
      const typ = String(obj.type || obj.kind || '').toLowerCase();
      if (typ === 'turn_ended' || typ === 'turn-ended' || typ === 'agent_end') {
        flush();
        continue;
      }
      const role = cursorRole(obj);
      const node = obj.message != null ? obj.message : obj;
      const atRaw = obj.timestamp || obj.createdAt || obj.at || null;
      const at =
        typeof atRaw === 'string' && Number.isFinite(Date.parse(atRaw))
          ? new Date(atRaw).toISOString()
          : null;
      if (role === 'user') {
        const textBody = extractCursorMessageText(node);
        if (!textBody) continue;
        if (pendingUser && assistantParts.length) flush();
        else {
          pendingUser = null;
          assistantParts = [];
        }
        pendingUser = { text: textBody, at, id: obj.id || obj.messageId || null };
        continue;
      }
      if (role === 'assistant' && pendingUser) {
        const agg = extractCursorAssistantAggregate(node);
        if (!agg) continue;
        const rawUsage =
          obj.usage ||
          (obj.message && obj.message.usage) ||
          (obj.result && obj.result.usage) ||
          null;
        assistantParts.push({
          text: agg,
          at,
          id: obj.id || obj.messageId || null,
          rawUsage,
          model: obj.model || (obj.message && obj.message.model) || null,
        });
      }
    }
    // EOF: flush any open multi-step turn.
    flush();
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
    let turnUsage = null;
    if (rec.tokens || rec.cost != null) {
      turnUsage = usage.normalizeOpenCodeUsage(
        { tokens: rec.tokens, cost: rec.cost },
        { source: 'opencode-db', model: session.model || null }
      );
    }
    if (!turnUsage && (rec.prompt || rec.reply)) {
      turnUsage = usage.estimateUsageFromText({
        prompt: rec.prompt,
        reply: rec.reply,
        cli: 'opencode',
        model: session.model || null,
      });
    }
    const { tokens: _t, cost: _c, ...rest } = rec;
    void _t;
    void _c;
    const result = appendTurn(
      {
        sessionId: session.id,
        chatId: session.chatId,
        engine: 'opencode',
        source: opts.source || (opts.fullScan ? 'opencode-db-backfill' : 'opencode-db'),
        ...rest,
        usage: turnUsage || undefined,
      },
      {
        dryRun: !apply,
        index,
        skipIndexSave: true,
        skipUsageSummary: true,
        meta: opts.meta,
      }
    );
    if (result.written) summary.written += 1;
    else if (result.updated) summary.updated = (summary.updated || 0) + 1;
    else if (result.reason === 'dry-run') summary.wouldWrite += 1;
    else if (result.reason === 'duplicate') summary.skipped += 1;
    if (rec.engineEventId) seen.add(String(rec.engineEventId));
  }

  if (apply) {
    index.opencodeSeen = Array.from(seen);
    saveTurnsIndex(session.id, index);
    rebuildUsageSummary(session.id);
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
  // Load existing turns once so headless-run rows can suppress transcript dupes.
  const existingTurns = readTurns(session.id);
  let usagePatched = false;
  for (const rec of walked.records) {
    const headlessMatch = findMatchingHeadlessRunTurn(existingTurns, rec, {
      windowMs: opts.headlessMatchWindowMs,
    });
    if (headlessMatch) {
      // Same turn already captured by aflt run — do not insert a second row.
      // Upgrade sparse estimated usage / missing reply from the transcript
      // (still estimated — never invents reported API tokens).
      let didUpdate = false;
      if (apply && rec.reply && !normalizeTurnReply(headlessMatch.reply)) {
        const rows = readTurns(session.id);
        for (const row of rows) {
          if (!row || row.source !== 'headless-run') continue;
          if (dedupeKey(row) !== dedupeKey(headlessMatch)) continue;
          row.reply = rec.reply;
          row.replySource = rec.replySource || 'cursor-transcript';
          if (row.incomplete) row.incomplete = false;
          headlessMatch.reply = row.reply;
          headlessMatch.replySource = row.replySource;
          didUpdate = true;
          break;
        }
        if (didUpdate) rewriteTurnsFile(session.id, rows);
      }
      if (rec.usage && apply) {
        const patched = patchTurnUsageIfMissing(session.id, headlessMatch, rec.usage, {
          dryRun: false,
          cli: 'cursor',
          source: rec.usage.source || 'cursor-transcript',
        });
        if (patched.updated) {
          usagePatched = true;
          didUpdate = true;
          // Keep in-memory list current for later candidates in this walk.
          headlessMatch.usage = patched.turn && patched.turn.usage
            ? patched.turn.usage
            : rec.usage;
        }
      }
      if (didUpdate) {
        usagePatched = true;
        summary.updated = (summary.updated || 0) + 1;
      } else {
        summary.skipped += 1;
      }
      continue;
    }
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
        skipUsageSummary: true,
        meta: opts.meta,
      }
    );
    if (result.written) {
      summary.written += 1;
      if (result.turn) existingTurns.push(result.turn);
    } else if (result.updated) summary.updated = (summary.updated || 0) + 1;
    else if (result.reason === 'dry-run') summary.wouldWrite += 1;
    else if (result.reason === 'duplicate') summary.skipped += 1;
  }
  // Always advance cursorFiles after a successful read so suppressed
  // headless-run matches are not re-scanned on the next dashboard poll.
  if (apply && (summary.written > 0 || usagePatched || Object.keys(walked.files || {}).length)) {
    index.cursorFiles = walked.files;
    saveTurnsIndex(session.id, index);
    rebuildUsageSummary(session.id);
  }
  return { ...summary, errors };
}

/**
 * Sparse Herdr OSC completion candidate (no invented prompt/reply).
 */
function appendOscCandidate(session, opts = {}) {
  if (!session || !session.id) return { written: false, reason: 'missing-session' };
  const at = opts.at || nowIso();
  const prompt = opts.prompt != null ? opts.prompt : null;
  const reply = opts.reply != null ? opts.reply : null;
  let oscUsage = opts.usage || null;
  if (!oscUsage && (prompt || reply)) {
    oscUsage = usage.estimateUsageFromText({
      prompt,
      reply,
      cli: session.engine || 'unknown',
    });
  }
  return appendTurn(
    {
      sessionId: session.id,
      chatId: session.chatId || null,
      engine: session.engine || null,
      source: 'herdr-osc',
      at,
      prompt,
      reply,
      promptSource: prompt ? opts.promptSource || 'unknown' : 'unknown',
      replySource: reply ? opts.replySource || 'unknown' : 'unknown',
      herdrStatusAtComplete: opts.herdrStatusAtComplete != null ? opts.herdrStatusAtComplete : 'done',
      incomplete: true,
      turnId: opts.turnId || `osc-${session.id}-${at}`,
      engineEventId: opts.engineEventId || `osc:${session.id}:${at}`,
      usage: oscUsage || undefined,
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
    if (apply) {
      // Ensure usage-summary.json exists/refreshed even when no new turns written
      // (e.g. patching estimated → reported on existing rows).
      try {
        rebuildUsageSummary(session.id);
      } catch (_) {
        /* ignore */
      }
    }

    out.push({
      id: session.id,
      title: session.title || session.id,
      engine: eng,
      chatId: session.chatId || null,
      scanned: summary.scanned,
      wouldWrite: dryRun ? summary.wouldWrite || 0 : undefined,
      written: apply ? summary.written : 0,
      updated: apply ? summary.updated || 0 : 0,
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
      updated: out.reduce((n, s) => n + (s.updated || 0), 0),
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
  usageSummaryPath,
  writeUsageSummary,
  rebuildUsageSummary,
  readUsageSummary,
  dedupeKey,
  prepareTurnRecord,
  appendTurn,
  patchTurnPromptIfMissing,
  patchTurnUsageIfMissing,
  rewriteTurnsFile,
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
  normalizeCursorTranscriptPrompt,
  findMatchingHeadlessRunTurn,
  extractCursorAssistantAggregate,
  HEADLESS_TRANSCRIPT_MATCH_WINDOW_MS,
  appendOscCandidate,
  captureSessions,
  backfillTurns,
  extractUserMessageText,
  isSafeChatId,
  cursorHome,
  resolveCopilotLoopUsage,
};
