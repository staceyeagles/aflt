'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function clearMods() {
  for (const m of [
    '../lib/util',
    '../lib/memory',
    '../lib/copilot',
    '../lib/turns',
    '../lib/run-history',
    '../lib/registry',
    '../lib/config',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function loadTurns(home) {
  clearMods();
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  return require('../lib/turns');
}

function loadRunHistory(home) {
  clearMods();
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  require('../lib/turns');
  return require('../lib/run-history');
}

describe('interactive turn capture', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevCopilot;
  let prevCursor;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevCopilot = process.env.AGENTFLEET_COPILOT_HOME;
    prevCursor = process.env.AGENTFLEET_CURSOR_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-turns-'));
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AGENTFLEET_COPILOT_HOME;
    delete process.env.AGENTFLEET_CURSOR_HOME;
  });

  afterEach(() => {
    turnsCleanup();
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevCopilot === undefined) delete process.env.AGENTFLEET_COPILOT_HOME;
    else process.env.AGENTFLEET_COPILOT_HOME = prevCopilot;
    if (prevCursor === undefined) delete process.env.AGENTFLEET_CURSOR_HOME;
    else process.env.AGENTFLEET_CURSOR_HOME = prevCursor;
    clearMods();
  });

  function turnsCleanup() {
    try {
      const turns = require('../lib/turns');
      turns.setTurnCapturedHandler(null);
    } catch (_) {
      /* ignore */
    }
  }

  const fixtureDir = path.join(__dirname, 'fixtures', 'copilot-turns');

  function writeCopilotEvents(chatId, lines) {
    const copilotHome = path.join(home, 'copilot');
    const file = path.join(copilotHome, 'session-state', chatId, 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join('\n') + '\n');
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    return { copilotHome, file };
  }

  function writeCopilotFixture(chatId, fixtureName) {
    const copilotHome = path.join(home, 'copilot');
    const file = path.join(copilotHome, 'session-state', chatId, 'events.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.copyFileSync(path.join(fixtureDir, fixtureName), file);
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    return { copilotHome, file };
  }

  function appendCopilotFixture(chatId, fixtureName) {
    const file = path.join(home, 'copilot', 'session-state', chatId, 'events.jsonl');
    const extra = fs.readFileSync(path.join(fixtureDir, fixtureName), 'utf8');
    fs.appendFileSync(file, extra.endsWith('\n') ? extra : extra + '\n');
    return file;
  }

  function event(id, summary, ts = '2026-11-19T22:00:00.000Z') {
    return JSON.stringify({
      id,
      type: 'session.task_complete',
      timestamp: ts,
      data: { success: true, summary },
    });
  }

  function userMsg(text, ts = '2026-11-19T21:59:00.000Z') {
    return JSON.stringify({
      id: `user-${text.slice(0, 8)}`,
      type: 'user.message',
      timestamp: ts,
      data: { content: text },
    });
  }

  it('pairs Copilot user.message with task_complete, redacts, dedupes', () => {
    const turns = loadTurns(home);
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz123456';
    writeCopilotEvents(chatId, [
      userMsg(`Please ship feature with ${secret}`),
      event('evt-1', `Shipped with ${secret}`),
      userMsg('second prompt'),
      event('evt-2', 'Second done', '2026-11-19T22:05:00.000Z'),
    ]);

    const session = {
      id: 'sess-copilot-1',
      title: 'Main',
      engine: 'copilot',
      chatId,
    };

    const first = turns.syncCopilotSession(session, {
      env: process.env,
      apply: true,
      fullScan: true,
    });
    assert.equal(first.written, 2);
    assert.equal(first.errors.length, 0);

    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].prompt.includes(secret), false);
    assert.match(rows[0].prompt, /\[redacted\]/);
    assert.match(rows[0].reply, /\[redacted\]/);
    assert.equal(rows[0].source, 'copilot-events-backfill');
    assert.equal(rows[0].promptSource, 'events-user-message');
    assert.equal(rows[0].engineEventId, 'evt-1');
    assert.equal(rows[1].prompt, 'second prompt');
    assert.equal(rows[1].engineEventId, 'evt-2');
    assert.equal(rows[0].redacted, true);

    const again = turns.syncCopilotSession(session, {
      env: process.env,
      apply: true,
      fullScan: true,
    });
    assert.equal(again.written, 0);
    assert.equal(again.skipped, 2);
    assert.equal(turns.readTurns(session.id).length, 2);
  });

  it('captures plain Copilot assistant turns without task_complete', () => {
    const turns = loadTurns(home);
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001';
    writeCopilotFixture(chatId, 'plain-turns.jsonl');
    const session = { id: 'plain-1', title: 'Plain', engine: 'copilot', chatId };

    const out = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: true });
    assert.equal(out.written, 2);
    const rows = turns.readTurns(session.id);
    assert.equal(rows[0].prompt, 'What is 2+2?');
    assert.equal(rows[0].reply, '2+2 is 4.');
    assert.equal(rows[0].engineEventId, 'a-plain-1');
    assert.equal(rows[0].replySource, 'assistant-message');
    assert.equal(rows[1].prompt, 'Thanks');
    assert.equal(rows[1].reply, 'You are welcome.');
    assert.equal(rows[1].engineEventId, 'a-plain-2');
  });

  it('captures tool-loop turns using final assistant.message only', () => {
    const turns = loadTurns(home);
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0002';
    writeCopilotFixture(chatId, 'tool-loop.jsonl');
    const session = { id: 'tool-1', title: 'Tools', engine: 'copilot', chatId };

    const out = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: true });
    assert.equal(out.written, 1);
    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prompt, 'List the cwd and summarize');
    assert.equal(rows[0].reply, 'cwd is /tmp/demo. Done.');
    assert.equal(rows[0].engineEventId, 'a-tool-1');
  });

  it('does not record in-progress trailing loops; resumes incrementally', () => {
    const turns = loadTurns(home);
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0003';
    writeCopilotFixture(chatId, 'in-progress.jsonl');
    const session = { id: 'prog-1', title: 'Progress', engine: 'copilot', chatId };

    const first = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: false });
    assert.equal(first.written, 0);
    assert.equal(turns.readTurns(session.id).length, 0);
    const index = turns.loadTurnsIndex(session.id);
    assert.ok(index.copilotPending);
    assert.equal(index.lastUserPrompt, 'Start a long task');
    assert.ok(index.copilotOffset > 0);

    appendCopilotFixture(chatId, 'in-progress-complete-tail.jsonl');
    const second = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: false });
    assert.equal(second.written, 1);
    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reply, 'Finished the long task.');
    assert.equal(rows[0].engineEventId, 'a-prog-1');
    const index2 = turns.loadTurnsIndex(session.id);
    assert.equal(index2.copilotPending, null);
    assert.equal(index2.lastUserPrompt, null);
  });

  it('dedupes task_complete with assistant turn; prefers assistant text', () => {
    const turns = loadTurns(home);
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0004';
    writeCopilotFixture(chatId, 'task-complete-dedupe.jsonl');
    const session = { id: 'dedupe-1', title: 'Dedupe', engine: 'copilot', chatId };

    const out = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: true });
    assert.equal(out.written, 1);
    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].reply, 'Shipped the feature with tests.');
    assert.equal(rows[0].engineEventId, 'a-dedupe-1');
    assert.equal(rows[0].replySource, 'assistant-message+task-complete');
    assert.equal(rows[0].taskCompleteSummary, 'Feature shipped (task_complete summary)');

    const again = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: true });
    assert.equal(again.written, 0);
    assert.equal(again.skipped, 1);
    assert.equal(turns.readTurns(session.id).length, 1);
  });

  it('pairs orphan task_complete with the preceding user.message prompt', () => {
    const turns = loadTurns(home);
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0005';
    writeCopilotFixture(chatId, 'task-complete-orphan.jsonl');
    const session = { id: 'orphan-tc-1', title: 'Orphan TC', engine: 'copilot', chatId };

    const out = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: true });
    assert.equal(out.written, 1);
    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].prompt, 'Please finish the auth refactor');
    assert.equal(rows[0].promptSource, 'events-user-message');
    assert.equal(rows[0].reply, 'Auth refactor complete');
    assert.equal(rows[0].engineEventId, 'tc-orphan-1');
    assert.equal(rows[0].replySource, 'task-complete-summary');
  });

  it('joins mid-turn steering user.message into the same turn prompt', () => {
    const turns = loadTurns(home);
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0006';
    writeCopilotFixture(chatId, 'mid-turn-steer.jsonl');
    const session = { id: 'steer-1', title: 'Steer', engine: 'copilot', chatId };

    const out = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: true });
    assert.equal(out.written, 1);
    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1);
    assert.match(rows[0].prompt, /Ship the feature with tests/);
    assert.match(rows[0].prompt, /Also cover the logout edge case/);
    assert.equal(rows[0].reply, 'Shipped with logout coverage.');
    assert.equal(rows[0].engineEventId, 'a-steer-1');
  });

  it('backfill updates existing turns.jsonl rows that lack a prompt (no duplicates)', () => {
    const turns = loadTurns(home);
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0007';
    writeCopilotFixture(chatId, 'task-complete-orphan.jsonl');
    const session = { id: 'patch-prompt-1', title: 'Patch', engine: 'copilot', chatId };

    // Simulate a legacy row: task_complete reply with no prompt.
    turns.appendTurn({
      sessionId: session.id,
      chatId,
      engine: 'copilot',
      engineEventId: 'tc-orphan-1',
      at: '2026-11-19T22:40:10.000Z',
      prompt: null,
      reply: 'Auth refactor complete',
      promptSource: 'unknown',
      replySource: 'task-complete-summary',
      source: 'copilot-events-backfill',
    });
    assert.equal(turns.readTurns(session.id).length, 1);
    assert.equal(turns.readTurns(session.id)[0].prompt, null);

    const out = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: true });
    assert.equal(out.written, 0);
    assert.equal(out.updated, 1);
    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1, 'no duplicate rows');
    assert.equal(rows[0].prompt, 'Please finish the auth refactor');
    assert.equal(rows[0].promptSource, 'events-user-message');
    assert.equal(rows[0].reply, 'Auth refactor complete');
    assert.equal(rows[0].engineEventId, 'tc-orphan-1');

    const again = turns.syncCopilotSession(session, { env: process.env, apply: true, fullScan: true });
    assert.equal(again.written, 0);
    assert.equal(again.updated, 0);
    assert.equal(again.skipped, 1);
    assert.equal(turns.readTurns(session.id).length, 1);
  });

  it('emitTurnCaptured queues for batch (no immediate DM); invokes configured handler', () => {
    const turns = loadTurns(home);
    const agentDocs = require('../lib/agent-docs');
    const seen = [];
    const envelope = turns.emitTurnCaptured(
      { sessionId: 's1', turnId: 't1', prompt: 'p', reply: 'r' },
      { project: 'demo' }
    );
    assert.equal(envelope.deferred, true);
    assert.equal(envelope.sent, false);
    assert.equal(envelope.queued, true);
    assert.ok(envelope.pendingId);
    assert.equal(envelope.issue, 2);
    assert.equal(envelope.type, 'turn-captured');
    assert.equal(envelope.project, 'demo');
    assert.match(String(envelope.reason || ''), /queued|batch|note/i);
    assert.equal(seen.length, 0);
    assert.ok(agentDocs.summarizeDocBotQueue().pending >= 1);

    turns.setTurnCapturedHandler((e) => seen.push(e));
    turns.emitTurnCaptured({ sessionId: 's1', turnId: 't2' }, { project: 'x' });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sessionId, 's1');
    turns.setTurnCapturedHandler(null);
  });

  it('emitTurnCaptured batches to doc-bot only after a dated note is written', () => {
    clearMods();
    for (const m of [
      '../lib/messages',
      '../lib/registry',
      '../lib/project',
      '../lib/agent-docs',
      '../lib/memory',
    ]) {
      try {
        delete require.cache[require.resolve(m)];
      } catch (_) {
        /* ignore */
      }
    }
    process.env.AGENTFLEET_HOME = home;
    process.env.HOME = home;
    const registry = require('../lib/registry');
    const messages = require('../lib/messages');
    const turns = require('../lib/turns');
    const agentDocs = require('../lib/agent-docs');
    const memory = require('../lib/memory');

    const mem = path.join(home, 'turn-mem');
    memory.initMemoryRepo(mem);
    process.env.AFLT_MEMORY_REPO = mem;
    const project = 'demo';
    fs.mkdirSync(path.join(mem, project, 'status-notes'), { recursive: true });
    fs.writeFileSync(
      path.join(mem, project, 'status-notes', '2026-11-19T1600-landed.md'),
      '# landed\n'
    );

    const doc = registry.add({
      title: 'doc-bot',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0d01',
      cwd: home,
      engine: 'cursor',
      status: 'active',
      project: 'aflt-memory',
      messaging: true,
    });
    const worker = registry.add({
      title: 'turn-worker',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0d02',
      cwd: home,
      engine: 'copilot',
      status: 'active',
      messaging: true,
      project,
    });

    const envelope = turns.emitTurnCaptured(
      {
        sessionId: worker.id,
        turnId: 'turn-1',
        prompt: 'do the thing',
        reply: 'done the thing',
      },
      { project }
    );
    assert.equal(envelope.sent, false);
    assert.equal(envelope.queued, true);
    assert.equal(messages.inboxForSession(doc, { unreadOnly: true }).length, 0);

    const done = agentDocs.completeCheckpoint(project, {
      sessionId: worker.id,
      notePath: 'status-notes/2026-11-19T1600-landed.md',
      requireNote: true,
    });
    assert.equal(done.docBotNotify.sent, true, done.docBotNotify.reason);

    const inbox = messages.inboxForSession(doc, { unreadOnly: true });
    const hit = inbox.find((m) => m.meta && m.meta.source === 'flushDocBotBatch');
    assert.ok(hit);
    assert.match(hit.text, /do the thing|turn-captured|batch/i);
  });

  it('backfill dry-run does not write; --apply writes', () => {
    const turns = loadTurns(home);
    const chatId = '11111111-2222-3333-4444-555555555555';
    writeCopilotEvents(chatId, [userMsg('hello'), event('e1', 'done')]);
    const session = { id: 'bf-1', title: 'BF', engine: 'copilot', chatId };

    const dry = turns.backfillTurns([session], { apply: false, env: process.env });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.totals.wouldWrite, 1);
    assert.equal(dry.totals.written, 0);
    assert.equal(fs.existsSync(turns.turnsPath(session.id)), false);

    const applied = turns.backfillTurns([session], { apply: true, env: process.env });
    assert.equal(applied.apply, true);
    assert.equal(applied.totals.written, 1);
    assert.equal(turns.readTurns(session.id).length, 1);
  });

  it('history markers include interactive turns with prompt+reply hover text', () => {
    const turns = loadTurns(home);
    const runHistory = loadRunHistory(home);
    const session = { id: 'hist-1', title: 'Hist', engine: 'copilot', chatId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff' };
    turns.appendTurn({
      sessionId: session.id,
      chatId: session.chatId,
      engine: 'copilot',
      source: 'copilot-task-complete',
      at: '2026-11-19T22:00:00.000Z',
      prompt: 'interactive prompt',
      reply: 'completed summary',
      promptSource: 'events-user-message',
      replySource: 'task-complete-summary',
      engineEventId: 'evt-hist',
    });

    const markers = runHistory.sessionActivityMarkers(session, { redact: true });
    assert.ok(markers.length >= 1);
    const m = markers.find((x) => /interactive prompt/.test(x.prompt || ''));
    assert.ok(m);
    assert.equal(m.state, 'completed');
    assert.match(m.reply || '', /completed summary/);

    const events = runHistory.historyEventsFromTurns(session, { redact: true });
    assert.equal(events[0].type, 'turn');
    assert.equal(events[0].prompt, 'interactive prompt');
  });

  it('Cursor transcript backfill when uniquely mapped', () => {
    const turns = loadTurns(home);
    const chatId = 'cccccccc-dddd-eeee-ffff-000000000001';
    const cursorHome = path.join(home, '.cursor');
    process.env.AGENTFLEET_CURSOR_HOME = cursorHome;
    const dir = path.join(cursorHome, 'projects', 'Users-test-proj', 'agent-transcripts', chatId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${chatId}.jsonl`),
      [
        JSON.stringify({
          role: 'user',
          id: 'u1',
          timestamp: '2026-11-19T10:00:00.000Z',
          message: { content: [{ type: 'text', text: 'cursor prompt' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          id: 'a1',
          timestamp: '2026-11-19T10:01:00.000Z',
          message: { content: [{ type: 'text', text: 'cursor reply' }] },
        }),
      ].join('\n') + '\n'
    );

    const session = { id: 'cur-1', title: 'Cursor', engine: 'cursor', chatId };
    const result = turns.syncCursorSession(session, {
      env: process.env,
      apply: true,
      fullScan: true,
    });
    assert.equal(result.written, 1);
    const rows = turns.readTurns(session.id);
    assert.equal(rows[0].prompt, 'cursor prompt');
    assert.equal(rows[0].reply, 'cursor reply');
    assert.equal(rows[0].source, 'cursor-transcript');
  });

  it('suppresses cursor-transcript duplicate of a headless-run turn (wrapped <user_query>)', () => {
    const turns = loadTurns(home);
    const usage = require('../lib/usage');
    const chatId = 'dddddddd-eeee-ffff-0000-111111111111';
    const cursorHome = path.join(home, '.cursor');
    process.env.AGENTFLEET_CURSOR_HOME = cursorHome;
    const dir = path.join(cursorHome, 'projects', 'Users-test-proj', 'agent-transcripts', chatId);
    fs.mkdirSync(dir, { recursive: true });

    const barePrompt = 'Reply with the single word OK. Do not edit files.';
    const reported = usage.normalizeCursorUsage({
      inputTokens: 6187,
      outputTokens: 40,
      cacheReadTokens: 3968,
      cacheWriteTokens: 0,
      reasoningTokens: 39,
    });
    const session = { id: 'cur-headless-dup', title: 'Dup', engine: 'cursor', chatId };

    // Simulate aflt run capturing the headless turn first (reported usage).
    const written = turns.appendTurn({
      sessionId: session.id,
      chatId,
      engine: 'cursor',
      source: 'headless-run',
      at: '2026-11-21T18:13:07.552Z',
      prompt: barePrompt,
      reply: 'OK',
      promptSource: 'headless-prompt',
      replySource: 'headless-stdout',
      engineEventId: `headless:${session.id}:run-1`,
      usage: reported,
    });
    assert.equal(written.written, true);
    assert.equal(written.turn.usage.accuracy, 'reported');

    // Cursor agent-transcript wraps the same prompt; at is ~13s later (mtime-ish).
    const wrappedPrompt =
      '<timestamp>Saturday, Nov 21, 2026, 1:13 PM (UTC-5)</timestamp>\n' +
      '<user_query>\n' +
      barePrompt +
      '\n</user_query>';
    fs.writeFileSync(
      path.join(dir, `${chatId}.jsonl`),
      [
        JSON.stringify({
          role: 'user',
          id: 'u-wrapped',
          timestamp: '2026-11-21T18:13:20.402Z',
          message: { content: [{ type: 'text', text: wrappedPrompt }] },
        }),
        JSON.stringify({
          role: 'assistant',
          id: 'a-wrapped',
          timestamp: '2026-11-21T18:13:20.402Z',
          message: { content: [{ type: 'text', text: 'OK' }] },
        }),
      ].join('\n') + '\n'
    );

    assert.equal(
      turns.normalizeCursorTranscriptPrompt(wrappedPrompt),
      barePrompt
    );

    const sync = turns.syncCursorSession(session, {
      env: process.env,
      apply: true,
      fullScan: true,
    });
    assert.equal(sync.written, 0, 'must not insert a second turn');
    assert.ok(sync.skipped >= 1);

    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'headless-run');
    assert.equal(rows[0].usage.accuracy, 'reported');
    assert.equal(rows[0].usage.totalInput, 10155);

    const summary = turns.readUsageSummary(session.id);
    assert.equal(summary.turnCount, 1);
    assert.equal(summary.accuracy, 'reported');
    assert.equal(summary.reportedTurns, 1);

    // Re-sync must stay idempotent (cursorFiles advanced).
    const again = turns.syncCursorSession(session, {
      env: process.env,
      apply: true,
      fullScan: false,
    });
    assert.equal(again.written, 0);
    assert.equal(again.scanned, 0);
    assert.equal(turns.readTurns(session.id).length, 1);
  });

  it('aggregates multi-step Cursor assistant + tool_use into one turn', () => {
    const turns = loadTurns(home);
    const chatId = 'eeeeeeee-ffff-0000-1111-222222222222';
    const cursorHome = path.join(home, '.cursor');
    process.env.AGENTFLEET_CURSOR_HOME = cursorHome;
    const dir = path.join(cursorHome, 'projects', 'Users-test-proj', 'agent-transcripts', chatId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `${chatId}.jsonl`),
      [
        JSON.stringify({
          role: 'user',
          id: 'u-multi',
          timestamp: '2026-11-23T02:10:18.000Z',
          message: { content: [{ type: 'text', text: 'Improve round 2' }] },
        }),
        JSON.stringify({
          role: 'assistant',
          id: 'a1',
          timestamp: '2026-11-23T02:10:19.000Z',
          message: {
            content: [
              { type: 'text', text: 'Looking at items first.' },
              { type: 'tool_use', name: 'Read', input: { path: 'src/items.js' } },
            ],
          },
        }),
        JSON.stringify({
          role: 'assistant',
          id: 'a2',
          timestamp: '2026-11-23T02:11:00.000Z',
          message: {
            content: [
              { type: 'text', text: 'Applying DEF +1.' },
              {
                type: 'tool_use',
                name: 'StrReplace',
                input: { path: 'src/items.js', old_string: 'a', new_string: 'b' },
              },
            ],
          },
        }),
        JSON.stringify({ type: 'turn_ended', status: 'error', error: 'resource_exhausted' }),
      ].join('\n') + '\n'
    );

    const walked = turns.iterCursorTranscriptTurns(dir, { source: 'cursor-transcript' });
    assert.equal(walked.records.length, 1);
    assert.match(walked.records[0].reply, /Looking at items first/);
    assert.match(walked.records[0].reply, /Applying DEF \+1/);
    assert.match(walked.records[0].reply, /\[tool_use Read\]/);
    assert.match(walked.records[0].reply, /\[tool_use StrReplace\]/);
    assert.equal(walked.records[0].usage.accuracy, 'estimated');
    assert.ok(walked.records[0].usage.outputTokens > 0);
  });

  it('upgrades sparse headless estimated turn from Cursor transcript aggregate', () => {
    const turns = loadTurns(home);
    const usage = require('../lib/usage');
    const chatId = 'ffffffff-0000-1111-2222-333333333333';
    const cursorHome = path.join(home, '.cursor');
    process.env.AGENTFLEET_CURSOR_HOME = cursorHome;
    const dir = path.join(cursorHome, 'projects', 'Users-test-proj', 'agent-transcripts', chatId);
    fs.mkdirSync(dir, { recursive: true });

    const barePrompt = 'Do not switch to plan mode. You are running improve-r2.';
    const session = { id: 'cur-sparse-r2', title: 'Sparse', engine: 'cursor', chatId };
    const sparse = usage.estimateUsageFromText({
      prompt: barePrompt,
      reply: '',
      cli: 'cursor',
    });
    assert.equal(sparse.outputTokens, 0);

    turns.appendTurn({
      sessionId: session.id,
      chatId,
      engine: 'cursor',
      source: 'headless-run',
      at: '2026-11-23T02:10:18.610Z',
      prompt: barePrompt,
      reply: '',
      promptSource: 'headless-prompt',
      replySource: 'headless-stdout',
      engineEventId: `headless:${session.id}:run-1`,
      usage: sparse,
    });

    const wrapped =
      '<user_query>\n' + barePrompt + '\n</user_query>';
    fs.writeFileSync(
      path.join(dir, `${chatId}.jsonl`),
      [
        JSON.stringify({
          role: 'user',
          id: 'u-s',
          timestamp: '2026-11-23T02:10:20.000Z',
          message: { content: [{ type: 'text', text: wrapped }] },
        }),
        JSON.stringify({
          role: 'assistant',
          id: 'a-s1',
          timestamp: '2026-11-23T02:10:21.000Z',
          message: {
            content: [
              { type: 'text', text: 'Baseline first.' },
              { type: 'tool_use', name: 'Shell', input: { command: 'node scripts/eval/eval.js --json' } },
            ],
          },
        }),
        JSON.stringify({
          role: 'assistant',
          id: 'a-s2',
          timestamp: '2026-11-23T02:15:00.000Z',
          message: { content: [{ type: 'text', text: 'Done with items tweak.' }] },
        }),
        JSON.stringify({ type: 'turn_ended', status: 'error' }),
      ].join('\n') + '\n'
    );

    const sync = turns.syncCursorSession(session, {
      env: process.env,
      apply: true,
      fullScan: true,
      headlessMatchWindowMs: 60 * 60 * 1000,
    });
    assert.equal(sync.written, 0, 'must not insert a duplicate turn');
    assert.ok((sync.updated || 0) >= 1);

    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].source, 'headless-run');
    assert.match(rows[0].reply, /Baseline first/);
    assert.match(rows[0].reply, /\[tool_use Shell\]/);
    assert.equal(rows[0].usage.accuracy, 'estimated');
    assert.ok(rows[0].usage.outputTokens > 0);
    assert.ok(rows[0].usage.totalTokens > sparse.totalTokens);
    // Never invent reported tokens from a transcript estimate.
    assert.notEqual(rows[0].usage.accuracy, 'reported');
  });

  it('OSC candidate never invents prompt/reply text', () => {
    const turns = loadTurns(home);
    const session = { id: 'osc-1', engine: 'copilot', chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    const out = turns.appendOscCandidate(session, { at: '2026-11-19T23:00:00.000Z' });
    assert.equal(out.written, true);
    const row = turns.readTurns(session.id)[0];
    assert.equal(row.prompt, null);
    assert.equal(row.reply, null);
    assert.equal(row.incomplete, true);
    assert.equal(row.source, 'herdr-osc');
  });

  it('aflt turns backfill CLI is dry-run by default', () => {
    const registry = (() => {
      clearMods();
      process.env.AGENTFLEET_HOME = home;
      process.env.HOME = home;
      return require('../lib/registry');
    })();
    const chatId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
    writeCopilotEvents(chatId, [userMsg('cli prompt'), event('cli-1', 'cli done')]);
    registry.add({
      title: 'cli-session',
      chatId,
      cwd: path.join(home, 'proj'),
      engine: 'copilot',
      status: 'active',
    });

    const dry = spawnSync(process.execPath, [afJs, 'turns', 'backfill', 'cli-session', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTFLEET_HOME: home, HOME: home, AGENTFLEET_COPILOT_HOME: process.env.AGENTFLEET_COPILOT_HOME },
    });
    assert.equal(dry.status, 0, dry.stderr);
    const dryJson = JSON.parse(dry.stdout);
    assert.equal(dryJson.dryRun, true);
    assert.ok(dryJson.totals.wouldWrite >= 1);
    assert.equal(dryJson.totals.written, 0);

    const applied = spawnSync(
      process.execPath,
      [afJs, 'turns', 'backfill', 'cli-session', '--apply', '--json'],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTFLEET_HOME: home,
          HOME: home,
          AGENTFLEET_COPILOT_HOME: process.env.AGENTFLEET_COPILOT_HOME,
        },
      }
    );
    assert.equal(applied.status, 0, applied.stderr);
    const appliedJson = JSON.parse(applied.stdout);
    assert.equal(appliedJson.apply, true);
    assert.ok(appliedJson.totals.written >= 1);

    const turns = loadTurns(home);
    const sess = registry.findExact('cli-session');
    assert.ok(turns.readTurns(sess.id).length >= 1);
  });

  it('stores usage on turns and writes usage-summary.json', () => {
    const turns = loadTurns(home);
    const usage = require('../lib/usage');
    const sessionId = 'sess-usage-1';
    const u = usage.normalizeCursorUsage({
      inputTokens: 6187,
      outputTokens: 40,
      cacheReadTokens: 3968,
      cacheWriteTokens: 0,
      reasoningTokens: 39,
    });
    const written = turns.appendTurn({
      sessionId,
      engine: 'cursor',
      source: 'headless-run',
      prompt: 'ping',
      reply: 'pong',
      usage: u,
    });
    assert.equal(written.written, true);
    assert.equal(written.turn.usage.totalInput, 10155);
    const summary = turns.readUsageSummary(sessionId);
    assert.equal(summary.turnCount, 1);
    assert.equal(summary.totalTokens, 10195);
    assert.ok(fs.existsSync(turns.usageSummaryPath(sessionId)));

    // Estimated must not overwrite reported.
    const estimated = usage.estimateUsageFromText({
      prompt: 'ping',
      reply: 'pong',
      cli: 'cursor',
    });
    const patched = turns.patchTurnUsageIfMissing(sessionId, written.turn, estimated);
    assert.equal(patched.updated, false);
  });

  it('attaches Copilot usage_record inside a turn window', () => {
    const turns = loadTurns(home);
    const chatId = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
    writeCopilotEvents(chatId, [
      userMsg('count tokens', '2026-11-21T12:00:00.000Z'),
      JSON.stringify({
        id: 'asst-1',
        type: 'assistant.message',
        timestamp: '2026-11-21T12:00:01.000Z',
        data: { content: 'done' },
      }),
      JSON.stringify({
        id: 'usage-1',
        type: 'session.usage_record',
        timestamp: '2026-11-21T12:00:02.000Z',
        data: {
          usage: {
            model: 'claude-haiku-4.5',
            inputTokens: 16130,
            outputTokens: 56,
            cacheReadTokens: 0,
            cacheWriteTokens: 16120,
            reasoningTokens: 49,
            cost: 0.33,
            duration: 1008,
          },
          accounting: { sourceSessionId: chatId, sequence: 1 },
        },
      }),
      JSON.stringify({
        id: 'end-1',
        type: 'assistant.turn_end',
        timestamp: '2026-11-21T12:00:03.000Z',
        data: {},
      }),
    ]);
    const session = {
      id: 'sess-copilot-usage',
      title: 'Usage',
      engine: 'copilot',
      chatId,
    };
    const sync = turns.syncCopilotSession(session, {
      env: process.env,
      apply: true,
      fullScan: true,
    });
    assert.equal(sync.written, 1);
    const rows = turns.readTurns(session.id);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].usage);
    assert.equal(rows[0].usage.inputTokens, 10);
    assert.equal(rows[0].usage.totalInput, 16130);
    assert.equal(rows[0].usage.premiumRequests, 0.33);
    assert.equal(rows[0].usage.cost, null);
    assert.equal(rows[0].usage.source, 'copilot-usage-record');
  });
});
