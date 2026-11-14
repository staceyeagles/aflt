'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const copilot = require('../lib/copilot');

const ID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const ID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
const ID_C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
const ID_D = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
const ID_E = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5';
const ID_MISS = 'ffffffff-ffff-4fff-8fff-fffffffffff6';

function writeSession(root, id, { workspace, events, mtimeMs } = {}) {
  const dir = path.join(root, 'session-state', id);
  fs.mkdirSync(dir, { recursive: true });
  if (workspace != null) {
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), workspace);
  }
  if (events != null) {
    const body = Array.isArray(events)
      ? events.map((e) => (typeof e === 'string' ? e : JSON.stringify(e))).join('\n') + '\n'
      : String(events);
    fs.writeFileSync(path.join(dir, 'events.jsonl'), body);
  }
  if (mtimeMs != null) {
    const t = new Date(mtimeMs);
    fs.utimesSync(dir, t, t);
  }
  return dir;
}

function workerName(task) {
  return [
    'You are a worker agent for master "demo-master" (id: demo-master-abc123).',
    'Your task: do a thing',
    'When finished, you MUST write a markdown handoff to /tmp/out.md with these sections:',
    '',
    '## Summary',
    '## Files changed',
    '## Open questions',
    '',
    'Do not commit or push.',
    '',
    '---',
    '',
    task,
  ].join('\n');
}

function setupFixtures(copilotHome, { projectA, projectB } = {}) {
  const a = projectA || path.join(copilotHome, 'proj-a');
  const b = projectB || path.join(copilotHome, 'proj-b');
  fs.mkdirSync(a, { recursive: true });
  fs.mkdirSync(b, { recursive: true });

  // Newest: user-named block scalar, model changes
  writeSession(copilotHome, ID_A, {
    workspace: [
      `id: ${ID_A}`,
      `cwd: ${a}`,
      'git_root: ' + a,
      'branch: main',
      'repository: wwlib/af',
      'name: |-',
      '  Fix the importer',
      '  with two lines',
      'user_named: true',
      'created_at: 2026-11-12T10:00:00.000Z',
      'updated_at: 2026-11-12T12:00:00.000Z',
      '',
    ].join('\n'),
    events: [
      {
        type: 'session.start',
        data: {
          sessionId: ID_A,
          copilotVersion: '1.0.109',
          startTime: '2026-11-12T10:00:00.000Z',
          context: { cwd: a },
        },
      },
      { type: 'session.model_change', data: { newModel: 'gpt-4.1' } },
      { type: 'session.model_change', data: { newModel: 'claude-haiku-4.5' } },
      { type: 'user.message', data: { content: 'Fix the importer\nwith two lines' } },
    ],
  });

  // Worker preamble → title from after ---
  writeSession(copilotHome, ID_B, {
    workspace: [
      `id: ${ID_B}`,
      `cwd: ${b}`,
      'name: |-',
      ...workerName('List files in the folder carefully.').split('\n').map((l) => '  ' + l),
      'user_named: false',
      'created_at: 2026-11-12T09:00:00.000Z',
      'updated_at: 2026-11-12T11:00:00.000Z',
      '',
    ].join('\n'),
    events: [
      {
        type: 'session.start',
        data: { sessionId: ID_B, startTime: '2026-11-12T09:00:00.000Z', context: { cwd: b } },
      },
      { type: 'session.model_change', data: { newModel: 'gpt-5' } },
      {
        type: 'user.message',
        data: { content: workerName('List files in the folder carefully.') },
      },
    ],
  });

  // No name in workspace — first prompt from events; summary absent
  writeSession(copilotHome, ID_C, {
    workspace: [
      `id: ${ID_C}`,
      `cwd: ${a}`,
      'user_named: false',
      'created_at: 2026-11-12T08:00:00.000Z',
      'updated_at: 2026-11-12T10:30:00.000Z',
      '',
    ].join('\n'),
    events: [
      {
        type: 'session.start',
        data: { sessionId: ID_C, startTime: '2026-11-12T08:00:00.000Z', context: { cwd: a } },
      },
      { type: 'user.message', data: { content: 'Explain the build graph' } },
    ],
  });

  // Missing events.jsonl — still listable
  writeSession(copilotHome, ID_D, {
    workspace: [
      `id: ${ID_D}`,
      `cwd: ${b}`,
      'name: "Quoted title session"',
      'user_named: true',
      'created_at: 2026-11-12T07:00:00.000Z',
      'updated_at: 2026-11-12T09:00:00.000Z',
      '',
    ].join('\n'),
  });

  // Empty dir (no workspace, no events) — skipped
  fs.mkdirSync(path.join(copilotHome, 'session-state', ID_E), { recursive: true });

  return { projectA: a, projectB: b };
}

function runAf(args, envExtra = {}) {
  return spawnSync(process.execPath, [afJs, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envExtra },
  });
}

describe('lib/copilot local sessions', () => {
  let home;
  let copilotHome;
  let fixtures;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-import-home-'));
    copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-import-copilot-'));
    process.env.AGENTFLEET_HOME = home;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    delete process.env.AGENTFLEET_ENGINE;
    delete process.env.COPILOT_HOME;
    fixtures = setupFixtures(copilotHome);
  });

  afterEach(() => {
    delete process.env.AGENTFLEET_HOME;
    delete process.env.AGENTFLEET_COPILOT_HOME;
    delete process.env.AGENTFLEET_ENGINE;
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(copilotHome, { recursive: true, force: true });
  });

  it('parseWorkspaceYaml handles block scalars, quotes, bools', () => {
    const doc = [
      'id: x',
      'name: |-',
      '  line one',
      '  line two',
      'user_named: false',
      'title: "hello world"',
      'empty:',
      '',
    ].join('\n');
    const y = copilot.parseWorkspaceYaml(doc);
    assert.equal(y.name, 'line one\nline two');
    assert.equal(y.user_named, false);
    assert.equal(y.title, 'hello world');
  });

  it('listLocalSessions sorts newest first and skips empty dirs', () => {
    const list = copilot.listLocalSessions({ limit: 20 });
    assert.equal(list.length, 4);
    assert.equal(list[0].id, ID_A);
    assert.equal(list[1].id, ID_B);
    assert.equal(list[0].title, 'Fix the importer');
    assert.equal(list[0].model, 'claude-haiku-4.5');
    assert.match(list[1].title, /List files in the folder carefully/);
    assert.equal(list[2].id, ID_C);
    assert.equal(list[2].title, 'Explain the build graph');
    assert.equal(list[3].title, 'Quoted title session');
    assert.ok(!list.some((s) => s.id === ID_E));
  });

  it('getLocalSession accepts full id and unique prefix ≥8', () => {
    const full = copilot.getLocalSession(ID_A);
    assert.equal(full.id, ID_A);
    const pref = copilot.getLocalSession(ID_A.slice(0, 8));
    assert.equal(pref.id, ID_A);
    assert.equal(copilot.getLocalSession(ID_MISS), null);
    assert.throws(() => copilot.getLocalSession('aabbcc'), /≥8|too short/);
  });

  it('--cwd filter resolves symlink paths', () => {
    const id = 'abababab-abab-4aba-8aba-abababababab';
    const viaTmp = path.join(os.tmpdir(), `af-import-link-${process.pid}`);
    fs.mkdirSync(viaTmp, { recursive: true });
    // Store cwd as realpath form; filter via /tmp or /private/tmp alias when they differ
    writeSession(copilotHome, id, {
      workspace: [
        `id: ${id}`,
        `cwd: ${fs.realpathSync(viaTmp)}`,
        'name: symlink cwd',
        'user_named: true',
        'updated_at: 2026-11-12T13:00:00.000Z',
        'created_at: 2026-11-12T13:00:00.000Z',
        '',
      ].join('\n'),
    });
    const filtered = copilot.listLocalSessions({ limit: 50, cwd: viaTmp });
    assert.ok(filtered.some((s) => s.id === id));
    fs.rmSync(viaTmp, { recursive: true, force: true });
  });
});

describe('af import CLI', () => {
  let home;
  let copilotHome;
  let fixtures;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-import-cli-'));
    copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-import-cp-'));
    fixtures = setupFixtures(copilotHome);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(copilotHome, { recursive: true, force: true });
  });

  function env(extra = {}) {
    return {
      AGENTFLEET_HOME: home,
      AGENTFLEET_COPILOT_HOME: copilotHome,
      ...extra,
    };
  }

  it('Cursor path unchanged when default engine is cursor', () => {
    const r = runAf(['import'], env());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /cursor-agent ls/);
    assert.match(r.stdout, /~\/\.cursor\/chats/);
    assert.doesNotMatch(r.stdout, /\bTRACKED\b/);
  });

  it('af import cursor / --engine cursor always uses Cursor path', () => {
    const a = runAf(['import', 'cursor'], env({ AGENTFLEET_ENGINE: 'copilot' }));
    assert.equal(a.status, 0, a.stderr);
    assert.match(a.stdout, /~\/\.cursor\/chats/);
    const b = runAf(['import', '--engine', 'cursor'], env({ AGENTFLEET_ENGINE: 'copilot' }));
    assert.equal(b.status, 0, b.stderr);
    assert.match(b.stdout, /cursor-agent ls/);
  });

  it('default engine copilot switches import listing', () => {
    const r = runAf(['import'], env({ AGENTFLEET_ENGINE: 'copilot' }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\bTRACKED\b/);
    assert.match(r.stdout, /aaaaaaaa/);
    assert.doesNotMatch(r.stdout, /cursor-agent ls/);
  });

  it('list json + tracked marker via CLI', () => {
    const add = runAf(
      ['add', 'pre-tracked', '--chat', ID_A, '--engine', 'copilot', '--cwd', fixtures.projectA],
      env()
    );
    assert.equal(add.status, 0, add.stderr);

    const list = runAf(['import', '--engine', 'copilot', '--limit', '10'], env());
    assert.equal(list.status, 0, list.stderr);
    assert.match(list.stdout, /ID\s+UPDATED\s+FOLDER\s+TRACKED\s+TITLE/);
    assert.match(list.stdout, /✓/);
    assert.match(list.stdout, /Fix the importer/);

    const js = runAf(['import', 'copilot', '--json', '--limit', '5'], env());
    assert.equal(js.status, 0, js.stderr);
    const payload = JSON.parse(js.stdout);
    assert.equal(payload.engine, 'copilot');
    assert.ok(payload.sessions.length >= 1);
    const row = payload.sessions.find((s) => s.id === ID_A);
    assert.equal(row.tracked, true);
    assert.equal(row.title, 'Fix the importer');
  });

  it('--cwd filters listing', () => {
    const r = runAf(
      ['import', '--engine', 'copilot', '--cwd', fixtures.projectB, '--json'],
      env()
    );
    assert.equal(r.status, 0, r.stderr);
    const payload = JSON.parse(r.stdout);
    assert.ok(payload.sessions.every((s) => s.id === ID_B || s.id === ID_D));
    assert.ok(!payload.sessions.some((s) => s.id === ID_A));
  });

  it('imports by full id and prefix; skips already tracked', () => {
    const one = runAf(
      ['import', '--engine', 'copilot', ID_A, '--title', 'my-import'],
      env()
    );
    assert.equal(one.status, 0, one.stderr);
    assert.match(one.stdout, /imported: my-import/);
    assert.match(one.stdout, new RegExp(ID_A));

    const again = runAf(['import', '--engine', 'copilot', ID_A.slice(0, 8)], env());
    assert.equal(again.status, 0, again.stderr);
    assert.match(again.stdout, /already tracked/);

    const pref = runAf(['import', 'copilot', ID_B.slice(0, 10)], env());
    assert.equal(pref.status, 0, pref.stderr);
    assert.match(pref.stdout, /imported:/);
    assert.match(pref.stdout, /list-files|List files/i);
  });

  it('unknown id errors but still imports others', () => {
    const r = runAf(
      ['import', '--engine', 'copilot', ID_C, ID_MISS],
      env()
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /imported:/);
    assert.match(r.stderr, /unknown Copilot session id/);
    assert.match(r.stderr, new RegExp(ID_MISS));
  });

  it('--allow-missing registers missing id', () => {
    const r = runAf(
      [
        'import',
        '--engine',
        'copilot',
        ID_MISS,
        '--allow-missing',
        '--cwd',
        fixtures.projectA,
      ],
      env()
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /imported: copilot-ffffffff/);
    const ls = runAf(['ls', '--json'], env());
    const data = JSON.parse(ls.stdout);
    assert.ok(data.sessions.some((s) => s.chatId === ID_MISS && s.engine === 'copilot'));
  });

  it('--all imports untracked respecting --cwd and --limit', () => {
    runAf(
      ['add', 'keep-a', '--chat', ID_A, '--engine', 'copilot', '--cwd', fixtures.projectA],
      env()
    );
    const r = runAf(
      ['import', '--engine', 'copilot', '--all', '--cwd', fixtures.projectA, '--limit', '20'],
      env()
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /imported:/);
    assert.doesNotMatch(r.stdout, new RegExp(ID_B));
    // ID_C is under projectA and untracked
    assert.match(r.stdout, new RegExp(ID_C));
  });

  it('--title with multiple ids is rejected', () => {
    const r = runAf(
      ['import', '--engine', 'copilot', ID_A, ID_B, '--title', 'nope'],
      env()
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--title is only valid/);
  });

  it('--dry-run shows plan without writing registry', () => {
    const r = runAf(['import', '--engine', 'copilot', ID_D, '--dry-run'], env());
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /\[dry-run\] would import/);
    const ls = runAf(['ls', '--json'], env());
    const data = JSON.parse(ls.stdout);
    assert.equal((data.sessions || []).length, 0);
  });

  it('-i without TTY fails cleanly', () => {
    const r = runAf(['import', '--engine', 'copilot', '-i'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TTY/);
  });

  it('help mentions copilot import', () => {
    const r = runAf(['help'], env());
    assert.equal(r.status, 0);
    assert.match(r.stdout, /aflt import/);
    assert.match(r.stdout, /copilot/);
  });
});
