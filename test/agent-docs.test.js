'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const agentDocs = require('../lib/agent-docs');
const memory = require('../lib/memory');
const dashboard = require('../lib/dashboard');
const cursor = require('../lib/cursor');
const copilot = require('../lib/copilot');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function mkTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function af(args, env) {
  return spawnSync(process.execPath, [afJs, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

function writeNote(memRepo, project, filename, body = '# note\n') {
  const dir = path.join(memRepo, project, 'status-notes');
  fs.mkdirSync(dir, { recursive: true });
  const abs = path.join(dir, filename);
  fs.writeFileSync(abs, body);
  return abs;
}

describe('agentDocs (issue #3 lifecycle)', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevMem;
  let prevRegistry;

  beforeEach(() => {
    home = mkTmp('af-agent-docs-');
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevMem = process.env.AFLT_MEMORY_REPO;
    prevRegistry = process.env.AGENTFLEET_REGISTRY;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    delete process.env.AFLT_MEMORY_REPO;
    delete process.env.AGENTFLEET_REGISTRY;
    fs.mkdirSync(process.env.AGENTFLEET_HOME, { recursive: true, mode: 0o700 });
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevMem === undefined) delete process.env.AFLT_MEMORY_REPO;
    else process.env.AFLT_MEMORY_REPO = prevMem;
    if (prevRegistry === undefined) delete process.env.AGENTFLEET_REGISTRY;
    else process.env.AGENTFLEET_REGISTRY = prevRegistry;
    try {
      fs.rmSync(home, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  });

  it('ships shared process doc and AGENT-DOCS template with archive + batch guidance', () => {
    const processDoc = agentDocs.packageTemplatePath(agentDocs.PROCESS_DOC_REL);
    const agentTpl = agentDocs.packageTemplatePath(agentDocs.AGENT_DOCS_REL);
    assert.ok(fs.existsSync(processDoc));
    assert.ok(fs.existsSync(agentTpl));
    const body = fs.readFileSync(processDoc, 'utf8');
    assert.match(body, /never auto-moves or deletes/i);
    assert.match(body, /Archive convention/i);
    assert.match(body, /status-notes\/archive/i);
    assert.match(body, /batched/i);
    assert.match(body, /Completion capture vs this lifecycle/i);
    assert.match(body, /requireNote/i);
  });

  it('memory init copies DOCUMENTATION-PROCESS.md when missing', () => {
    const repo = path.join(home, 'mem');
    const result = memory.initMemoryRepo(repo);
    assert.equal(result.ok, true);
    const dest = path.join(result.repo, agentDocs.PROCESS_DOC_REL);
    assert.ok(fs.existsSync(dest));
    const before = fs.readFileSync(dest, 'utf8');
    fs.writeFileSync(dest, before + '\n# keep\n');
    memory.initMemoryRepo(repo);
    assert.equal(fs.readFileSync(dest, 'utf8'), before + '\n# keep\n');
  });

  it('resolves context without memory and reports missing when agentDocs enabled', () => {
    const project = path.join(home, 'proj');
    fs.mkdirSync(project, { recursive: true });
    writeJson(path.join(project, '.agentfleet.json'), { agentDocs: true, project: 'demo' });
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# agents\n');
    fs.writeFileSync(path.join(project, 'AGENT-DOCS.md'), '# pointers\n');

    const ctx = agentDocs.resolveAgentDocsContext({ cwd: project, project: 'demo' });
    assert.equal(ctx.enabled, true);
    assert.equal(ctx.project, 'demo');
    assert.equal(ctx.memoryRepo, null);
    assert.ok(ctx.missing.includes('memoryRepo'));
    assert.ok(ctx.agentsMdPath);
    assert.ok(ctx.agentDocsPath);
    assert.ok(ctx.processDocPath); // package fallback
    assert.equal(ctx.archivePolicy, 'never-auto-move-or-delete');
    assert.ok(Array.isArray(ctx.boundaries));
    assert.ok(ctx.boundaries.includes('turn-complete'));
    assert.equal(ctx.requireNote, true);
  });

  it('delivers env + preamble for cursor and copilot when enabled', () => {
    const project = path.join(home, 'proj2');
    const mem = path.join(home, 'memory');
    fs.mkdirSync(project, { recursive: true });
    memory.initMemoryRepo(mem);
    process.env.AFLT_MEMORY_REPO = mem;
    writeJson(path.join(project, '.agentfleet.json'), { agentDocs: true, project: 'fleet' });
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# keep me\n');
    fs.writeFileSync(path.join(project, 'AGENT-DOCS.md'), '# docs\n');

    const session = {
      id: 'sess-1',
      title: 't',
      cwd: project,
      project: 'fleet',
      chatId: '11111111-1111-4111-8111-111111111111',
      engine: 'cursor',
    };
    const prepared = agentDocs.prepareLaunch(session, {
      prompt: 'Do the work.',
      autoRequest: false,
    });
    assert.equal(prepared.env.AFLT_PROJECT, 'fleet');
    assert.equal(prepared.env.AFLT_MEMORY_REPO, path.resolve(mem));
    assert.ok(prepared.env.AFLT_DOCS_PROCESS);
    assert.ok(prepared.env.AFLT_AGENT_DOCS);
    assert.ok(prepared.env.AFLT_AGENTS_MD);
    assert.match(prepared.prompt, /\[aflt agentDocs\]/);
    assert.match(prepared.prompt, /Do the work/);
    assert.match(prepared.prompt, /preserve/i);
    assert.match(prepared.prompt, /batched/i);

    const cursorArgs = cursor.buildPrintArgs(session, { prompt: prepared.prompt });
    assert.ok(cursorArgs.includes(prepared.prompt));

    session.engine = 'copilot';
    const copilotArgs = copilot.buildPrintArgs(session, { prompt: prepared.prompt });
    assert.ok(copilotArgs.includes('-p'));
    assert.ok(copilotArgs.includes(prepared.prompt));
  });

  it('does not inject when agentDocs is off', () => {
    const project = path.join(home, 'plain');
    fs.mkdirSync(project, { recursive: true });
    writeJson(path.join(project, '.agentfleet.json'), { project: 'plain' });
    const session = { id: 's2', cwd: project, project: 'plain', chatId: 'x' };
    const prepared = agentDocs.prepareLaunch(session, { prompt: 'hello' });
    assert.equal(prepared.prompt, 'hello');
    assert.equal(prepared.env.AFLT_DOCS_PROCESS, undefined);
  });

  it('prepareLaunch does not auto-request unless session-launch boundary enabled', () => {
    const project = path.join(home, 'no-launch');
    fs.mkdirSync(project, { recursive: true });
    writeJson(path.join(project, '.agentfleet.json'), { agentDocs: true, project: 'no-launch' });
    const session = { id: 's-nl', cwd: project, project: 'no-launch', chatId: 'x' };
    const prepared = agentDocs.prepareLaunch(session, { prompt: 'hi' });
    assert.ok(prepared.checkpoint);
    assert.equal(prepared.checkpoint.progress, 'none');
  });

  it('tracks checkpoint request/complete; overdue uses age for status only', () => {
    const mem = path.join(home, 'mem-cp');
    memory.initMemoryRepo(mem);
    process.env.AFLT_MEMORY_REPO = mem;
    const project = 'cp-demo';
    writeNote(mem, project, '2026-11-19T1200-landed.md');

    const t0 = '2026-11-19T12:00:00.000Z';
    const req = agentDocs.requestCheckpoint(project, {
      sessionId: 's1',
      reason: 'test',
      now: t0,
    });
    assert.equal(req.progress, 'requested');
    assert.equal(req.missing, true);
    assert.equal(req.overdue, false);

    const mid = agentDocs.summarizeCheckpoint(project, {
      hours: 4,
      now: '2026-11-19T15:00:00.000Z',
    });
    assert.equal(mid.missing, true);
    assert.equal(mid.overdue, false);
    assert.ok(mid.ageHours >= 2.9 && mid.ageHours < 3.1);

    const late = agentDocs.summarizeCheckpoint(project, {
      hours: 4,
      now: '2026-11-19T17:00:00.000Z',
    });
    assert.equal(late.overdue, true);
    assert.equal(late.progress, 'requested'); // age is not progress

    const done = agentDocs.completeCheckpoint(project, {
      sessionId: 's1',
      notePath: 'status-notes/2026-11-19T1200-landed.md',
      now: '2026-11-19T17:30:00.000Z',
    });
    assert.equal(done.progress, 'completed');
    assert.equal(done.missing, false);
    assert.equal(done.overdue, false);
    assert.ok(done.lastCompleted);
    assert.ok(done.docBotNotify && done.docBotNotify.queued);
  });

  it('completeCheckpoint requires a real live note (not archive)', () => {
    const mem = path.join(home, 'mem-note');
    memory.initMemoryRepo(mem);
    process.env.AFLT_MEMORY_REPO = mem;
    const project = 'note-proj';
    fs.mkdirSync(path.join(mem, project, 'status-notes', 'archive'), { recursive: true });
    fs.writeFileSync(
      path.join(mem, project, 'status-notes', 'archive', '2026-11-01T1000-old.md'),
      '# old\n'
    );

    agentDocs.requestCheckpoint(project, { now: '2026-11-19T12:00:00.000Z' });

    assert.throws(
      () => agentDocs.completeCheckpoint(project, {}),
      (err) => err && err.code === 'NOTE_REQUIRED'
    );
    assert.throws(
      () =>
        agentDocs.completeCheckpoint(project, {
          notePath: 'status-notes/archive/2026-11-01T1000-old.md',
        }),
      (err) => err && /archiv/i.test(err.message)
    );
    assert.throws(
      () =>
        agentDocs.completeCheckpoint(project, {
          notePath: 'status-notes/missing.md',
        }),
      (err) => err && /not found/i.test(err.message)
    );
  });

  it('maybeRequestAtBoundary only at configured safe boundaries and never when busy', () => {
    const projectDir = path.join(home, 'bound');
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, '.agentfleet.json'), {
      agentDocs: true,
      project: 'bound',
    });
    const session = {
      id: 'bound-1',
      cwd: projectDir,
      project: 'bound',
      chatId: 'c1',
      engine: 'cursor',
      status: 'active',
    };

    const skip = agentDocs.maybeRequestAtBoundary(session, 'session-launch');
    assert.equal(skip.requested, false);
    assert.match(String(skip.reason), /not enabled/i);

    const ok = agentDocs.maybeRequestAtBoundary(session, 'turn-complete', {
      now: '2026-11-19T12:00:00.000Z',
    });
    assert.equal(ok.requested, true);
    assert.equal(ok.checkpoint.progress, 'requested');

    const again = agentDocs.maybeRequestAtBoundary(session, 'run-exit');
    assert.equal(again.requested, false); // onlyIfNoneOpen

    const busy = {
      ...session,
      id: 'bound-2',
      runPid: process.pid,
      runHost: os.hostname(),
    };
    // Clear open so busy path is tested for a fresh request
    agentDocs.completeCheckpoint('bound', {
      notePath: null,
      requireNote: false,
      now: '2026-11-19T13:00:00.000Z',
    });
    const busyHit = agentDocs.maybeRequestAtBoundary(busy, 'turn-complete');
    assert.equal(busyHit.requested, false);
    assert.equal(busyHit.reason, 'busy');
  });

  it('bounded retry with backoff for unacknowledged checkpoints', () => {
    writeJson(path.join(process.env.AGENTFLEET_HOME, 'config.json'), {
      agentDocs: {
        checkpointHours: 1,
        retryMax: 2,
        retryBackoffMinutes: [10, 20],
      },
    });
    const project = 'retry-proj';
    agentDocs.requestCheckpoint(project, {
      now: '2026-11-19T10:00:00.000Z',
      reason: 'stale',
    });

    const first = agentDocs.processCheckpointRetries({
      now: '2026-11-19T12:00:00.000Z',
      projects: [project],
    });
    assert.equal(first.results[0].retried, true);
    assert.equal(first.results[0].checkpoint.notifyAttempts, 1);
    assert.ok(first.results[0].checkpoint.nextRetryAt);

    const tooSoon = agentDocs.processCheckpointRetries({
      now: '2026-11-19T12:05:00.000Z',
      projects: [project],
    });
    assert.equal(tooSoon.results[0].retried, false);

    const second = agentDocs.processCheckpointRetries({
      now: '2026-11-19T12:20:00.000Z',
      projects: [project],
    });
    assert.equal(second.results[0].retried, true);
    assert.equal(second.results[0].checkpoint.notifyAttempts, 2);
    assert.equal(second.results[0].checkpoint.retriesExhausted, true);
  });

  it('batches Doc Bot notify after note written; ack records completion', () => {
    delete require.cache[require.resolve('../lib/registry')];
    delete require.cache[require.resolve('../lib/messages')];
    delete require.cache[require.resolve('../lib/agent-docs')];
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    const registry = require('../lib/registry');
    const messages = require('../lib/messages');
    const agentDocs2 = require('../lib/agent-docs');

    const mem = path.join(home, 'mem-batch');
    memory.initMemoryRepo(mem);
    process.env.AFLT_MEMORY_REPO = mem;
    const project = 'batch-proj';
    writeNote(mem, project, '2026-11-19T1400-done.md');

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
      title: 'chk-worker',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0d02',
      cwd: home,
      engine: 'cursor',
      status: 'active',
      messaging: true,
      project,
    });

    // Turn enqueue alone must not send
    const turnQ = agentDocs2.enqueueTurnCaptured(
      {
        sessionId: worker.id,
        turnId: 't1',
        prompt: 'p',
        reply: 'r',
      },
      { project }
    );
    assert.equal(turnQ.queued, true);
    assert.equal(messages.inboxForSession(doc, { unreadOnly: true }).length, 0);

    agentDocs2.requestCheckpoint(project, {
      sessionId: worker.id,
      now: '2026-11-19T13:00:00.000Z',
    });
    const done = agentDocs2.completeCheckpoint(project, {
      sessionId: worker.id,
      notePath: 'status-notes/2026-11-19T1400-done.md',
      now: '2026-11-19T14:00:00.000Z',
    });
    assert.equal(done.docBotNotify.sent, true, done.docBotNotify.reason);
    assert.ok(done.docBotNotify.batchId);

    const inbox = messages.inboxForSession(doc, { unreadOnly: true });
    assert.ok(inbox.length >= 1);
    const hit = inbox.find((m) => m.meta && m.meta.source === 'flushDocBotBatch');
    assert.ok(hit);
    assert.match(hit.text, /batch/i);
    assert.match(hit.text, /2026-11-19T1400-done/);

    const ack = agentDocs2.ackDocBotBatch(done.docBotNotify.batchId);
    assert.equal(ack.ok, true);
    assert.equal(ack.batch.status, 'acked');
    const queue = agentDocs2.summarizeDocBotQueue();
    assert.ok(queue.batchesAcked >= 1);
  });

  it('notifyDocBot queues without requiring messaging; useful offline', () => {
    const queued = agentDocs.notifyDocBot({
      type: 'checkpoint-requested',
      project: 'offline',
      checkpoint: { sessionId: null, reason: 'x' },
    });
    assert.equal(queued.queued, true);
    assert.equal(queued.sent, false);
    assert.match(String(queued.reason), /note|queued/i);
    const q = agentDocs.summarizeDocBotQueue();
    assert.ok(q.pending >= 1);
  });

  it('listLiveStatusNotes ignores archive/; listArchived labels history', () => {
    const notes = path.join(home, 'notes');
    fs.mkdirSync(path.join(notes, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(notes, '2026-11-19T1000-live.md'), '# live\n');
    fs.writeFileSync(path.join(notes, 'archive', '2026-11-01T1000-old.md'), '# old\n');
    const live = agentDocs.listLiveStatusNotes(notes);
    assert.deepEqual(live, ['2026-11-19T1000-live.md']);
    const archived = agentDocs.listArchivedStatusNotes(notes);
    assert.deepEqual(archived, ['2026-11-01T1000-old.md']);
    const summary = agentDocs.summarizeStatusNotesDir(notes);
    assert.equal(summary.archivedCount, 1);
    assert.equal(summary.latestLive, '2026-11-19T1000-live.md');
    assert.ok(fs.existsSync(path.join(notes, 'archive', '2026-11-01T1000-old.md')));
    assert.ok(fs.existsSync(path.join(notes, '2026-11-19T1000-live.md')));
  });

  it('fleet config.json agentDocs knobs are readable', () => {
    writeJson(path.join(process.env.AGENTFLEET_HOME, 'config.json'), {
      agentDocs: {
        boundaries: ['turn-complete'],
        requireNote: false,
        retryMax: 5,
        retryBackoffMinutes: [1, 2],
        batchNotify: false,
      },
    });
    const fleet = agentDocs.resolveFleetAgentDocsConfig();
    assert.deepEqual(fleet.boundaries, ['turn-complete']);
    assert.equal(fleet.requireNote, false);
    assert.equal(fleet.retryMax, 5);
    assert.equal(fleet.batchNotify, false);
    assert.equal(fleet.source, 'config');
  });

  it('docs --status --json includes agentDocs checkpoint + archive fields', () => {
    const project = path.join(home, 'status-proj');
    fs.mkdirSync(project, { recursive: true });
    spawnSync('git', ['init'], { cwd: project, encoding: 'utf8' });
    spawnSync('git', ['-C', project, 'config', 'user.email', 't@example.com']);
    spawnSync('git', ['-C', project, 'config', 'user.name', 't']);
    fs.writeFileSync(path.join(project, 'README.md'), '# r\n');
    writeJson(path.join(project, '.agentfleet.json'), {
      docs: true,
      agentDocs: true,
      project: 'status-proj',
      docCheckpointHours: 1,
    });
    spawnSync('git', ['-C', project, 'add', '.'], { encoding: 'utf8' });
    spawnSync('git', ['-C', project, 'commit', '-m', 'init'], { encoding: 'utf8' });

    agentDocs.requestCheckpoint('status-proj', {
      now: '2026-11-01T00:00:00.000Z',
      reason: 'stale',
    });

    const r = af(['docs', '--status', '--json', project], {
      HOME: home,
      AGENTFLEET_HOME: process.env.AGENTFLEET_HOME,
    });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    assert.equal(json.ok, true);
    assert.ok(json.projects.length >= 1);
    const row = json.projects.find((p) => p.root === path.resolve(project)) || json.projects[0];
    assert.equal(row.agentDocs.enabled, true);
    assert.equal(row.agentDocs.checkpoint.missing, true);
    assert.equal(row.agentDocs.checkpoint.overdue, true);
    assert.equal(row.agentDocs.archivePolicy, 'never-auto-move-or-delete');
    assert.ok(row.agentDocs.docBotQueue);
    assert.ok(Array.isArray(row.agentDocs.boundaries));
  });

  it('docs checkpoint CLI complete requires --note; notify flush/ack work', () => {
    const project = path.join(home, 'cli-proj');
    const mem = path.join(home, 'cli-mem');
    fs.mkdirSync(project, { recursive: true });
    memory.initMemoryRepo(mem);
    writeNote(mem, 'cli-proj', '2026-11-19T1500-cli.md');
    writeJson(path.join(project, '.agentfleet.json'), {
      agentDocs: true,
      project: 'cli-proj',
    });
    const env = {
      HOME: home,
      AGENTFLEET_HOME: process.env.AGENTFLEET_HOME,
      AFLT_MEMORY_REPO: mem,
    };

    const req = af(
      ['docs', 'checkpoint', 'request', project, '--json', '--reason', 'manual'],
      env
    );
    assert.equal(req.status, 0, req.stderr);
    const reqJson = JSON.parse(req.stdout);
    assert.equal(reqJson.ok, true);
    assert.equal(reqJson.checkpoint.progress, 'requested');
    assert.equal(reqJson.docBotNotify.sent, false);

    const missingNote = af(
      ['docs', 'checkpoint', 'complete', project, '--json'],
      env
    );
    assert.notEqual(missingNote.status, 0);

    const done = af(
      [
        'docs',
        'checkpoint',
        'complete',
        project,
        '--json',
        '--note',
        'status-notes/2026-11-19T1500-cli.md',
      ],
      env
    );
    assert.equal(done.status, 0, done.stderr);
    const doneJson = JSON.parse(done.stdout);
    assert.equal(doneJson.checkpoint.progress, 'completed');

    const status = af(['docs', 'notify', 'status', '--json'], env);
    assert.equal(status.status, 0, status.stderr);
    const st = JSON.parse(status.stdout);
    assert.equal(st.ok, true);
    assert.ok(st.queue);

    if (doneJson.docBotNotify && doneJson.docBotNotify.batchId) {
      const ack = af(
        ['docs', 'notify', 'ack', '--id', doneJson.docBotNotify.batchId, '--json'],
        env
      );
      assert.equal(ack.status, 0, ack.stderr);
      assert.equal(JSON.parse(ack.stdout).batch.status, 'acked');
    }
  });

  it('dashboard JSON exposes checkpoints + docBotQueue without treating age as progress', () => {
    const projectDir = path.join(home, 'dash-proj');
    fs.mkdirSync(projectDir, { recursive: true });
    writeJson(path.join(projectDir, '.agentfleet.json'), {
      agentDocs: true,
      project: 'dash-proj',
      docCheckpointHours: 1,
    });
    agentDocs.requestCheckpoint('dash-proj', {
      now: '2026-11-01T00:00:00.000Z',
      reason: 'old',
    });
    const sessions = [
      {
        id: 'dash-1',
        title: 'dash',
        cwd: projectDir,
        project: 'dash-proj',
        status: 'active',
        engine: 'cursor',
        created: '2026-11-19T00:00:00.000Z',
        lastUsed: '2026-11-19T00:00:00.000Z',
      },
    ];
    const state = dashboard.aggregateDashboard({
      sessions,
      memoryRecords: [],
      memoryProjects: [],
      memoryErrors: [],
      memoryConfigured: false,
      enrichmentById: {},
      sessionActivityById: {},
      completionsById: {},
      completionErrors: [],
      checkpoints: agentDocs.collectCheckpointStatuses(sessions, {
        now: '2026-11-19T12:00:00.000Z',
      }),
      docBotQueue: agentDocs.summarizeDocBotQueue(),
      now: '2026-11-19T12:00:00.000Z',
    });
    assert.ok(state.checkpoints);
    assert.ok(state.checkpoints.missing >= 1);
    assert.ok(state.checkpoints.overdue >= 1);
    assert.ok(state.checkpoints.docBotQueue);
    assert.equal(state.checkpoints.docBotNotify.issue, 2);
    const proj = state.projects.find((p) => p.name === 'dash-proj');
    assert.ok(proj);
    assert.equal(proj.checkpoint.progress, 'requested');
  });

  it('doctor reports agent_docs check', () => {
    const r = af(['doctor', '--json'], {
      HOME: home,
      AGENTFLEET_HOME: process.env.AGENTFLEET_HOME,
    });
    assert.equal(r.status, 0, r.stderr);
    const json = JSON.parse(r.stdout);
    const hit = (json.checks || []).find((c) => c.name === 'agent_docs');
    assert.ok(hit);
    assert.equal(hit.ok, true);
    assert.match(String(hit.detail), /boundaries=/);
  });
});
