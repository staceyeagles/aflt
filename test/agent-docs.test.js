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

describe('agentDocs (issue #3 phase 1)', () => {
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

  it('ships shared process doc and AGENT-DOCS template', () => {
    const processDoc = agentDocs.packageTemplatePath(agentDocs.PROCESS_DOC_REL);
    const agentTpl = agentDocs.packageTemplatePath(agentDocs.AGENT_DOCS_REL);
    assert.ok(fs.existsSync(processDoc));
    assert.ok(fs.existsSync(agentTpl));
    const body = fs.readFileSync(processDoc, 'utf8');
    assert.match(body, /never auto-moves or deletes/i);
    assert.match(body, /issue #2/i);
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

  it('tracks checkpoint request/complete; overdue uses age for status only', () => {
    const project = 'cp-demo';
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
  });

  it('notifyDocBot is deferred to issue #2 and never sends', () => {
    const hook = agentDocs.notifyDocBot({ type: 'checkpoint-requested', project: 'x' });
    assert.equal(hook.deferred, true);
    assert.equal(hook.issue, 2);
    assert.match(hook.reason, /issue #2/i);
  });

  it('listLiveStatusNotes ignores archive/ and never moves files', () => {
    const notes = path.join(home, 'notes');
    fs.mkdirSync(path.join(notes, 'archive'), { recursive: true });
    fs.writeFileSync(path.join(notes, '2026-11-19T1000-live.md'), '# live\n');
    fs.writeFileSync(path.join(notes, 'archive', '2026-11-01T1000-old.md'), '# old\n');
    const live = agentDocs.listLiveStatusNotes(notes);
    assert.deepEqual(live, ['2026-11-19T1000-live.md']);
    assert.ok(fs.existsSync(path.join(notes, 'archive', '2026-11-01T1000-old.md')));
    assert.ok(fs.existsSync(path.join(notes, '2026-11-19T1000-live.md')));
  });

  it('docs --status --json includes agentDocs checkpoint fields', () => {
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
    assert.equal(row.agentDocs.docBotNotify.issue, 2);
  });

  it('docs checkpoint CLI request/complete is hermetic', () => {
    const project = path.join(home, 'cli-proj');
    fs.mkdirSync(project, { recursive: true });
    writeJson(path.join(project, '.agentfleet.json'), {
      agentDocs: true,
      project: 'cli-proj',
    });
    const req = af(
      ['docs', 'checkpoint', 'request', project, '--json', '--reason', 'manual'],
      { HOME: home, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME }
    );
    assert.equal(req.status, 0, req.stderr);
    const reqJson = JSON.parse(req.stdout);
    assert.equal(reqJson.ok, true);
    assert.equal(reqJson.checkpoint.progress, 'requested');
    assert.equal(reqJson.docBotNotify.deferred, true);

    const done = af(
      [
        'docs',
        'checkpoint',
        'complete',
        project,
        '--json',
        '--note',
        'status-notes/x.md',
      ],
      { HOME: home, AGENTFLEET_HOME: process.env.AGENTFLEET_HOME }
    );
    assert.equal(done.status, 0, done.stderr);
    const doneJson = JSON.parse(done.stdout);
    assert.equal(doneJson.checkpoint.progress, 'completed');
  });

  it('dashboard JSON exposes checkpoints without treating age as progress', () => {
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
      now: '2026-11-19T12:00:00.000Z',
    });
    assert.ok(state.checkpoints);
    assert.ok(state.checkpoints.missing >= 1);
    assert.ok(state.checkpoints.overdue >= 1);
    assert.equal(state.checkpoints.docBotNotify.issue, 2);
    const proj = state.projects.find((p) => p.name === 'dash-proj');
    assert.ok(proj);
    assert.equal(proj.checkpoint.progress, 'requested');
  });
});
