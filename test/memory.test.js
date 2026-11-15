'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function af(args, env, opts = {}) {
  return spawnSync(process.execPath, [afJs, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || env.HOME,
    env: { ...process.env, ...env },
  });
}

function loadMemory(home) {
  delete require.cache[require.resolve('../lib/util')];
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/project')];
  delete require.cache[require.resolve('../lib/timeline')];
  delete require.cache[require.resolve('../lib/memory')];
  delete require.cache[require.resolve('../lib/registry')];
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  return require('../lib/memory');
}

function loadRegistry(home) {
  delete require.cache[require.resolve('../lib/util')];
  delete require.cache[require.resolve('../lib/config')];
  delete require.cache[require.resolve('../lib/registry')];
  delete require.cache[require.resolve('../lib/project')];
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  return require('../lib/registry');
}

function seedSession(home, partial) {
  const registry = loadRegistry(home);
  return registry.add({
    title: partial.title || 'Seed',
    chatId:
      partial.chatId ||
      `aaaaaaaa-bbbb-cccc-dddd-${String(Math.random()).slice(2, 14).padEnd(12, '0')}`,
    cwd: partial.cwd || home,
    engine: 'cursor',
    status: partial.status || 'done',
    created: partial.created || '2024-01-01T00:00:00.000Z',
    lastUsed: partial.lastUsed || '2024-01-02T00:00:00.000Z',
    ...partial,
  });
}

describe('aflt memory', () => {
  let home;
  let memRepo;
  let prevHome;
  let prevAfHome;
  let prevMem;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevMem = process.env.AFLT_MEMORY_REPO;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mem-home-'));
    memRepo = path.join(home, 'memory-repo');
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AFLT_MEMORY_REPO;
    delete process.env.AFLT_PROJECT;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevMem === undefined) delete process.env.AFLT_MEMORY_REPO;
    else process.env.AFLT_MEMORY_REPO = prevMem;
    delete process.env.AFLT_PROJECT;
  });

  function env(extra = {}) {
    return {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: home,
      AFLT_MEMORY_REPO: '',
      AGENTFLEET_SESSION: '',
      AGENTFLEET_ID: '',
      ...extra,
    };
  }

  it('init creates git repo + files + registers memoryRepo', () => {
    const r = af(['memory', 'init', memRepo, '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.repo, fs.realpathSync(memRepo));
    assert.ok(fs.existsSync(path.join(memRepo, '.aflt-memory.json')));
    assert.ok(fs.existsSync(path.join(memRepo, 'README.md')));
    assert.ok(fs.existsSync(path.join(memRepo, '.gitignore')));
    const gi = fs.readFileSync(path.join(memRepo, '.gitignore'), 'utf8');
    assert.match(gi, /\.DS_Store/);
    assert.match(gi, /memory\//);
    const git = spawnSync('git', ['-C', memRepo, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
    });
    assert.equal(git.status, 0);
    assert.equal(String(git.stdout).trim(), 'true');
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json'), 'utf8'));
    assert.equal(cfg.memoryRepo, fs.realpathSync(memRepo));
    // never committed
    const log = spawnSync('git', ['-C', memRepo, 'log', '--oneline'], { encoding: 'utf8' });
    assert.notEqual(log.status, 0);
  });

  it('init is idempotent and re-registers', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const marker1 = fs.readFileSync(path.join(memRepo, '.aflt-memory.json'), 'utf8');
    const r2 = af(['memory', 'init', memRepo, '--json'], env());
    assert.equal(r2.status, 0, r2.stderr);
    const j = JSON.parse(r2.stdout);
    assert.equal(j.created, false);
    assert.equal(fs.readFileSync(path.join(memRepo, '.aflt-memory.json'), 'utf8'), marker1);
  });

  it('refuses non-empty foreign dir without --force', () => {
    fs.mkdirSync(memRepo, { recursive: true });
    fs.writeFileSync(path.join(memRepo, 'notes.txt'), 'keep me\n');
    const r = af(['memory', 'init', memRepo], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /refusing|non-empty|not an aflt memory/i);
    const forced = af(['memory', 'init', memRepo, '--force', '--json'], env());
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(fs.readFileSync(path.join(memRepo, 'notes.txt'), 'utf8'), 'keep me\n');
    assert.ok(fs.existsSync(path.join(memRepo, '.aflt-memory.json')));
  });

  it('AFLT_MEMORY_REPO overrides config; where prints path + source', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const other = path.join(home, 'other-mem');
    fs.mkdirSync(other, { recursive: true });
    // where from config
    const w1 = af(['memory', 'where', '--json'], env());
    assert.equal(w1.status, 0);
    const j1 = JSON.parse(w1.stdout);
    assert.equal(j1.source, 'config');
    assert.equal(j1.repo, fs.realpathSync(memRepo));
    // env override
    const w2 = af(['memory', 'where', '--json'], env({ AFLT_MEMORY_REPO: other }));
    assert.equal(w2.status, 0);
    const j2 = JSON.parse(w2.stdout);
    assert.equal(j2.source, 'env');
    assert.equal(j2.repo, path.resolve(other));
    // bare memory
    const w3 = af(['memory'], env());
    assert.equal(w3.status, 0);
    assert.match(w3.stdout, /config/);
  });

  it('where exits 1 with hint when unset', () => {
    const r = af(['memory', 'where'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /memory init/);
  });

  it('sync layout: folders, sessions.jsonl shape/order, idempotent, stubs', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const projDir = path.join(home, 'workspace', 'alpha-app');
    fs.mkdirSync(projDir, { recursive: true });

    seedSession(home, {
      title: 'later-session',
      project: 'alpha-app',
      cwd: projDir,
      created: '2024-06-02T00:00:00.000Z',
      runStartedAt: '2024-06-02T00:00:00.000Z',
      lastUsed: '2024-06-02T12:00:00.000Z',
      lastRunAt: '2024-06-02T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'second prompt',
    });
    // Add earlier session with explicit earlier start
    seedSession(home, {
      title: 'earlier-session',
      project: 'alpha-app',
      cwd: projDir,
      created: '2024-06-01T00:00:00.000Z',
      runStartedAt: '2024-06-01T00:00:00.000Z',
      lastUsed: '2024-06-01T12:00:00.000Z',
      lastRunAt: '2024-06-01T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'first prompt',
      role: 'master',
    });
    // non-repo --project ops
    seedSession(home, {
      title: 'ops-task',
      project: 'ops',
      cwd: home,
      created: '2024-05-01T00:00:00.000Z',
      runStartedAt: '2024-05-01T00:00:00.000Z',
      lastUsed: '2024-05-01T01:00:00.000Z',
      lastRunAt: '2024-05-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'ops work',
    });

    const sync1 = af(['memory', 'sync', '--all', '--json'], env());
    assert.equal(sync1.status, 0, sync1.stderr + sync1.stdout);
    const j1 = JSON.parse(sync1.stdout);
    assert.equal(j1.ok, true);
    const folders = j1.projects.map((p) => p.folder).sort();
    assert.deepEqual(folders, ['alpha-app', 'ops']);

    const jsonlPath = path.join(memRepo, 'alpha-app', '_aflt', 'sessions.jsonl');
    const mdPath = path.join(memRepo, 'alpha-app', '_aflt', 'timeline.md');
    assert.ok(fs.existsSync(jsonlPath));
    assert.ok(fs.existsSync(mdPath));
    assert.ok(fs.existsSync(path.join(memRepo, 'alpha-app', 'README.md')));
    assert.ok(fs.existsSync(path.join(memRepo, 'alpha-app', 'status-notes', '.gitkeep')));
    assert.ok(fs.existsSync(path.join(memRepo, 'ops', '_aflt', 'sessions.jsonl')));

    const lines = fs
      .readFileSync(jsonlPath, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    // sorted by start then id
    assert.ok(
      Date.parse(lines[0].start) <= Date.parse(lines[1].start) ||
        (lines[0].start === lines[1].start && lines[0].id <= lines[1].id)
    );
    const keys = Object.keys(lines[0]);
    assert.deepEqual(keys, [
      'id',
      'title',
      'project',
      'parent',
      'role',
      'engine',
      'status',
      'workerStatus',
      'start',
      'end',
      'lastUsed',
      'cwd',
      'promptSummary',
      'commits',
      'commitsReason',
    ]);
    assert.equal(lines[0].project, 'alpha-app');
    assert.ok(Array.isArray(lines[0].commits));
    assert.match(fs.readFileSync(mdPath, 'utf8'), /2 sessions/);

    const md1 = fs.readFileSync(mdPath, 'utf8');
    const jl1 = fs.readFileSync(jsonlPath, 'utf8');
    const mtime1 = fs.statSync(jsonlPath).mtimeMs;

    // human-edited README must not be overwritten
    const humanReadme = '# alpha-app\n\nmy notes\n';
    fs.writeFileSync(path.join(memRepo, 'alpha-app', 'README.md'), humanReadme);
    fs.writeFileSync(path.join(memRepo, 'alpha-app', 'status-notes', 'note.md'), 'keep\n');

    // second sync: idempotent (no content change for aflt files)
    const sync2 = af(['memory', 'sync', '--all', '--json'], env());
    assert.equal(sync2.status, 0, sync2.stderr);
    const j2 = JSON.parse(sync2.stdout);
    const alpha = j2.projects.find((p) => p.project === 'alpha-app');
    const afltFiles = alpha.files.filter((f) => f.path.includes('/_aflt/'));
    assert.ok(afltFiles.every((f) => f.changed === false));
    assert.equal(fs.readFileSync(jsonlPath, 'utf8'), jl1);
    assert.equal(fs.readFileSync(mdPath, 'utf8'), md1);
    assert.equal(fs.statSync(jsonlPath).mtimeMs, mtime1);
    assert.equal(fs.readFileSync(path.join(memRepo, 'alpha-app', 'README.md'), 'utf8'), humanReadme);
    assert.equal(
      fs.readFileSync(path.join(memRepo, 'alpha-app', 'status-notes', 'note.md'), 'utf8'),
      'keep\n'
    );
  });

  it('adhoc excluded from --all unless --include-adhoc', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    seedSession(home, {
      title: 'personal',
      project: 'adhoc',
      cwd: home,
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });
    seedSession(home, {
      title: 'real',
      project: 'widget',
      cwd: path.join(home, 'widget'),
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });
    fs.mkdirSync(path.join(home, 'widget'), { recursive: true });

    const r1 = af(['memory', 'sync', '--all', '--json'], env());
    assert.equal(r1.status, 0, r1.stderr);
    const j1 = JSON.parse(r1.stdout);
    assert.deepEqual(
      j1.projects.map((p) => p.project),
      ['widget']
    );
    assert.ok(!fs.existsSync(path.join(memRepo, 'adhoc')));

    const r2 = af(['memory', 'sync', '--all', '--include-adhoc', '--json'], env());
    assert.equal(r2.status, 0, r2.stderr);
    const j2 = JSON.parse(r2.stdout);
    assert.ok(j2.projects.some((p) => p.project === 'adhoc'));
    assert.ok(fs.existsSync(path.join(memRepo, 'adhoc', '_aflt', 'sessions.jsonl')));
  });

  it('dry-run writes nothing', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    seedSession(home, {
      title: 'x',
      project: 'dryproj',
      cwd: home,
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });
    const before = fs.readdirSync(memRepo);
    const r = af(['memory', 'sync', 'dryproj', '--dry-run', '--json'], env());
    assert.equal(r.status, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.ok(j.projects[0].files.some((f) => f.changed));
    assert.deepEqual(fs.readdirSync(memRepo).sort(), before.sort());
    assert.ok(!fs.existsSync(path.join(memRepo, 'dryproj')));
  });

  it('redaction cases + commit hash preserved + --no-redact', () => {
    const mem = loadMemory(home);
    const cases = [
      ['host 10.0.0.5 inside', /\[redacted\]/],
      ['loop 127.0.0.1', /\[redacted\]/],
      ['lan 192.168.1.9', /\[redacted\]/],
      ['priv 172.16.4.1', /\[redacted\]/],
      ['printer.local says hi', /\[redacted\]/],
      ['mail me@example.com please', /\[redacted\]/],
      ['sk-abc1234567890xyz', /\[redacted\]/],
      ['ghp_ABCDEFGHIJKLMNOPQRSTUV', /\[redacted\]/],
      ['gho_ABCDEFGHIJKLMNOPQRSTUV', /\[redacted\]/],
      ['github_pat_ABCDEFGHIJKLMNOP', /\[redacted\]/],
      ['xoxb-1234-5678-abcdef', /\[redacted\]/],
      ['token=supersecretvalue', /\[redacted\]/],
      ['key=abc123secret', /\[redacted\]/],
      ['password=hunter2', /\[redacted\]/],
      ['secret=shh', /\[redacted\]/],
      ['key_ABCDEFGHIJKLMNOP', /\[redacted\]/],
      ['crsr_ABCDEFGHIJKLMNOP', /\[redacted\]/],
      ['deadbeefdeadbeefdeadbeefdeadbeef', /\[redacted\]/], // 32 hex
      [
        'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        /\[redacted\]/,
      ], // 40 base64-ish
    ];
    for (const [input, re] of cases) {
      assert.match(mem.redactSensitive(input), re, input);
    }
    // home → ~
    const homePath = path.join(home, 'src', 'app');
    assert.equal(mem.redactSensitive(homePath), path.join('~', 'src', 'app'));

    // commit hash 7–12 hex must NOT be redacted when alone / as hash field
    const hash = 'abc1234';
    assert.equal(mem.redactSensitive(hash), hash);
    assert.equal(mem.redactSensitive('abcdef1'), 'abcdef1');
    assert.equal(mem.redactSensitive('abcd1234abcd'), 'abcd1234abcd');

    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    seedSession(home, {
      title: 'leak sk-abc1234567890xyz to me@example.com',
      project: 'sec',
      cwd: path.join(home, 'sec'),
      prompt: 'token=supersecretvalue at 10.1.2.3',
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });
    fs.mkdirSync(path.join(home, 'sec'), { recursive: true });

    const r1 = af(['memory', 'sync', 'sec', '--json'], env());
    assert.equal(r1.status, 0, r1.stderr);
    const row = JSON.parse(
      fs.readFileSync(path.join(memRepo, 'sec', '_aflt', 'sessions.jsonl'), 'utf8').trim()
    );
    assert.match(row.title, /\[redacted\]/);
    assert.match(row.promptSummary, /\[redacted\]/);
    assert.equal(row.cwd, path.join('~', 'sec'));

    // --no-redact
    fs.rmSync(path.join(memRepo, 'sec'), { recursive: true, force: true });
    const r2 = af(['memory', 'sync', 'sec', '--no-redact', '--json'], env());
    assert.equal(r2.status, 0, r2.stderr);
    const row2 = JSON.parse(
      fs.readFileSync(path.join(memRepo, 'sec', '_aflt', 'sessions.jsonl'), 'utf8').trim()
    );
    assert.match(row2.title, /sk-abc1234567890xyz/);
    assert.match(row2.promptSummary, /token=supersecretvalue/);
  });

  it('status: stale before sync / not after / stale after new session', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    seedSession(home, {
      title: 's1',
      project: 'statproj',
      cwd: home,
      created: '2024-01-01T00:00:00.000Z',
      runStartedAt: '2024-01-01T00:00:00.000Z',
      lastUsed: '2024-01-01T01:00:00.000Z',
      lastRunAt: '2024-01-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });

    const st0 = af(['memory', 'status', '--json'], env());
    assert.equal(st0.status, 0, st0.stderr);
    const j0 = JSON.parse(st0.stdout);
    assert.equal(j0.repo, fs.realpathSync(memRepo));
    assert.equal(j0.source, 'config');
    assert.equal(j0.isGit, true);
    const p0 = j0.projects.find((p) => p.project === 'statproj');
    assert.ok(p0);
    assert.equal(p0.stale, true);
    assert.equal(p0.folderExists, false);

    assert.equal(af(['memory', 'sync', 'statproj'], env()).status, 0);

    const st1 = af(['memory', 'status', '--json'], env());
    assert.equal(st1.status, 0, st1.stderr);
    const p1 = JSON.parse(st1.stdout).projects.find((p) => p.project === 'statproj');
    assert.equal(p1.stale, false);
    assert.equal(p1.folderExists, true);
    assert.ok(p1.lastSync);

    seedSession(home, {
      title: 's2',
      project: 'statproj',
      cwd: home,
      created: '2024-02-01T00:00:00.000Z',
      runStartedAt: '2024-02-01T00:00:00.000Z',
      lastUsed: '2024-02-01T01:00:00.000Z',
      lastRunAt: '2024-02-01T01:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });

    const st2 = af(['memory', 'status', '--json'], env());
    assert.equal(st2.status, 0, st2.stderr);
    const p2 = JSON.parse(st2.stdout).projects.find((p) => p.project === 'statproj');
    assert.equal(p2.stale, true);
    assert.equal(p2.sessions, 2);
  });

  it('folder sanitization', () => {
    const mem = loadMemory(home);
    assert.equal(mem.sanitizeFolderName('ops'), 'ops');
    assert.equal(mem.sanitizeFolderName('a/b'), 'a-b');
    assert.equal(mem.sanitizeFolderName('..evil'), '-evil');
    assert.equal(mem.sanitizeFolderName('foo/../bar'), 'foo---bar');
    assert.equal(mem.sanitizeFolderName('.hidden'), '-hidden');
    assert.equal(mem.sanitizeFolderName('bad:name*here'), 'bad-name-here');
    assert.throws(() => mem.sanitizeFolderName('...'), /empty/);
    assert.throws(() => mem.sanitizeFolderName('///'), /empty/);
  });

  function git(repo, args) {
    return spawnSync('git', ['-C', repo, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'aflt-test',
        GIT_AUTHOR_EMAIL: 'aflt-test@example.com',
        GIT_COMMITTER_NAME: 'aflt-test',
        GIT_COMMITTER_EMAIL: 'aflt-test@example.com',
      },
    });
  }

  function configureGitIdentity(repo) {
    assert.equal(git(repo, ['config', 'user.name', 'aflt-test']).status, 0);
    assert.equal(git(repo, ['config', 'user.email', 'aflt-test@example.com']).status, 0);
  }

  function seedProjAndInit() {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    configureGitIdentity(memRepo);
    const projDir = path.join(home, 'workspace', 'commit-app');
    fs.mkdirSync(projDir, { recursive: true });
    seedSession(home, {
      title: 'commit-session',
      project: 'commit-app',
      cwd: projDir,
      created: '2024-06-01T00:00:00.000Z',
      runStartedAt: '2024-06-01T00:00:00.000Z',
      lastUsed: '2024-06-01T12:00:00.000Z',
      lastRunAt: '2024-06-01T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'do work',
    });
    return projDir;
  }

  it('--push without --commit errors', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const r = af(['memory', 'sync', '--push'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /--push requires --commit/);
  });

  it('--commit --dry-run errors', () => {
    assert.equal(af(['memory', 'init', memRepo], env()).status, 0);
    const r = af(['memory', 'sync', '--commit', '--dry-run'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr + r.stdout, /--commit cannot be used with --dry-run/);
  });

  it('--commit stages only _aflt paths; leaves dirty human files unstaged', () => {
    seedProjAndInit();
    const sync1 = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(sync1.status, 0, sync1.stderr + sync1.stdout);
    const j1 = JSON.parse(sync1.stdout);
    assert.equal(j1.ok, true);
    assert.equal(j1.commit.committed, true);
    assert.ok(j1.commit.hash);
    assert.ok(j1.commit.files >= 2);
    assert.match(j1.commit.message, /^memory: sync \d{4}-\d{2}-\d{2}$/);

    const show = git(memRepo, ['show', '--name-only', '--pretty=format:', 'HEAD']);
    assert.equal(show.status, 0, show.stderr);
    const committed = show.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    assert.ok(committed.every((p) => /^[^/]+\/_aflt\//.test(p)));
    assert.ok(committed.some((p) => p.endsWith('_aflt/timeline.md')));
    assert.ok(committed.some((p) => p.endsWith('_aflt/sessions.jsonl')));
    assert.ok(!committed.some((p) => p.endsWith('README.md')));
    assert.ok(!committed.some((p) => p.includes('status-notes')));

    // Dirty human files must stay unstaged / uncommitted on next sync --commit
    const readme = path.join(memRepo, 'commit-app', 'README.md');
    const dash = path.join(memRepo, 'commit-app', 'dashboard.md');
    const note = path.join(memRepo, 'commit-app', 'status-notes', '2024-06-01.md');
    fs.writeFileSync(readme, '# commit-app\n\nhuman edit\n');
    fs.writeFileSync(dash, '# dashboard dirty\n');
    fs.writeFileSync(note, 'untracked note\n');

    // Change generated content so there is something to commit
    seedSession(home, {
      title: 'commit-session-2',
      project: 'commit-app',
      cwd: path.join(home, 'workspace', 'commit-app'),
      created: '2024-06-02T00:00:00.000Z',
      runStartedAt: '2024-06-02T00:00:00.000Z',
      lastUsed: '2024-06-02T12:00:00.000Z',
      lastRunAt: '2024-06-02T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      prompt: 'more work',
    });

    const head1 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    const sync2 = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(sync2.status, 0, sync2.stderr + sync2.stdout);
    const j2 = JSON.parse(sync2.stdout);
    assert.equal(j2.commit.committed, true);
    const head2 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    assert.notEqual(head1, head2);

    const staged = git(memRepo, ['diff', '--cached', '--name-only']);
    assert.equal(String(staged.stdout).trim(), '');
    const porcelain = git(memRepo, ['status', '--porcelain', '-uall']);
    assert.match(porcelain.stdout, /README\.md/);
    assert.match(porcelain.stdout, /dashboard\.md/);
    assert.match(porcelain.stdout, /status-notes\/2024-06-01\.md/);
    // Human files must not be in the new commit
    const show2 = git(memRepo, ['show', '--name-only', '--pretty=format:', 'HEAD']);
    const committed2 = show2.stdout
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    assert.ok(committed2.every((p) => /^[^/]+\/_aflt\//.test(p)));
    assert.equal(fs.readFileSync(readme, 'utf8'), '# commit-app\n\nhuman edit\n');
    assert.equal(fs.readFileSync(dash, 'utf8'), '# dashboard dirty\n');
    assert.equal(fs.readFileSync(note, 'utf8'), 'untracked note\n');
  });

  it('--commit with no changes reports committed:false', () => {
    seedProjAndInit();
    assert.equal(af(['memory', 'sync', 'commit-app', '--commit'], env()).status, 0);
    const head1 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    const r = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.commit.committed, false);
    assert.equal(j.commit.reason, 'no changes');
    assert.equal(j.commit.hash, null);
    const text = af(['memory', 'sync', 'commit-app', '--commit'], env());
    assert.equal(text.status, 0);
    assert.match(text.stdout, /memory commit: no changes/);
    const head2 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    assert.equal(head1, head2);
  });

  it('pre-staged human file refuses commit', () => {
    seedProjAndInit();
    assert.equal(af(['memory', 'sync', 'commit-app'], env()).status, 0);
    // Make an initial commit of generated files so repo has history, then stage a human file
    configureGitIdentity(memRepo);
    assert.equal(
      git(memRepo, ['add', '-A', '--', ':(glob)*/_aflt/**']).status,
      0
    );
    assert.equal(git(memRepo, ['commit', '-m', 'seed']).status, 0);

    fs.writeFileSync(path.join(memRepo, 'commit-app', 'README.md'), '# staged human\n');
    assert.equal(git(memRepo, ['add', '--', 'commit-app/README.md']).status, 0);
    const stagedBefore = git(memRepo, ['diff', '--cached', '--name-only']);
    assert.match(stagedBefore.stdout, /README\.md/);

    seedSession(home, {
      title: 'commit-session-3',
      project: 'commit-app',
      cwd: path.join(home, 'workspace', 'commit-app'),
      created: '2024-06-03T00:00:00.000Z',
      runStartedAt: '2024-06-03T00:00:00.000Z',
      lastUsed: '2024-06-03T12:00:00.000Z',
      lastRunAt: '2024-06-03T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });

    const head1 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    const r = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(r.status, 1);
    const out = r.stderr + r.stdout;
    assert.match(out, /refusing to commit|staged changes/i);
    assert.match(out, /README\.md/);
    const head2 = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    assert.equal(head1, head2);
    // Still staged (we refused before touching the index)
    const stagedAfter = git(memRepo, ['diff', '--cached', '--name-only']);
    assert.match(stagedAfter.stdout, /README\.md/);
  });

  it('--push pushes to bare upstream', () => {
    seedProjAndInit();
    const bare = path.join(home, 'memory-bare.git');
    assert.equal(
      spawnSync('git', ['init', '--bare', bare], { encoding: 'utf8' }).status,
      0
    );
    configureGitIdentity(memRepo);
    assert.equal(git(memRepo, ['remote', 'add', 'origin', bare]).status, 0);
    // First sync+commit so we have a branch tip, then set upstream via push -u once… but
    // aflt never passes remote/branch args. Establish upstream with a seed commit + push -u.
    assert.equal(af(['memory', 'sync', 'commit-app'], env()).status, 0);
    assert.equal(git(memRepo, ['add', '-A', '--', ':(glob)*/_aflt/**']).status, 0);
    assert.equal(git(memRepo, ['commit', '-m', 'seed']).status, 0);
    const branch = String(git(memRepo, ['branch', '--show-current']).stdout).trim() || 'main';
    assert.equal(git(memRepo, ['push', '-u', 'origin', branch]).status, 0);

    seedSession(home, {
      title: 'push-session-2',
      project: 'commit-app',
      cwd: path.join(home, 'workspace', 'commit-app'),
      created: '2024-07-01T00:00:00.000Z',
      runStartedAt: '2024-07-01T00:00:00.000Z',
      lastUsed: '2024-07-01T12:00:00.000Z',
      lastRunAt: '2024-07-01T12:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
    });

    const r = af(['memory', 'sync', 'commit-app', '--commit', '--push', '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.commit.committed, true);
    assert.equal(j.push.pushed, true);
    assert.ok(j.push.upstream);
    const local = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    const remote = String(
      spawnSync('git', ['-C', bare, 'rev-parse', branch], { encoding: 'utf8' }).stdout
    ).trim();
    assert.equal(local, remote);
  });

  it('--push without upstream keeps commit and exits non-zero', () => {
    seedProjAndInit();
    const r = af(['memory', 'sync', 'commit-app', '--commit', '--push', '--json'], env());
    assert.equal(r.status, 1, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, false);
    assert.equal(j.commit.committed, true);
    assert.ok(j.commit.hash);
    assert.equal(j.push.pushed, false);
    assert.equal(j.push.reason, 'no upstream');
    const head = String(git(memRepo, ['rev-parse', 'HEAD']).stdout).trim();
    assert.ok(head);
    assert.ok(head.startsWith(j.commit.hash) || j.commit.hash === head.slice(0, j.commit.hash.length));
  });

  it('commit message uses local date format', () => {
    seedProjAndInit();
    const mem = loadMemory(home);
    const fixed = new Date(2026, 10, 15, 12, 0, 0); // local Nov 15, 2026
    assert.equal(mem.localDateYmd(fixed), '2026-11-15');
    // CLI uses Date.now(); assert message pattern from a real commit
    const r = af(['memory', 'sync', 'commit-app', '--commit', '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.match(j.commit.message, /^memory: sync \d{4}-\d{2}-\d{2}$/);
    const log = git(memRepo, ['log', '-1', '--pretty=%s']);
    assert.equal(String(log.stdout).trim(), j.commit.message);
  });
});
