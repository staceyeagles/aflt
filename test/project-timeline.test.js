'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'af-test',
      GIT_AUTHOR_EMAIL: 'af-test@example.com',
      GIT_COMMITTER_NAME: 'af-test',
      GIT_COMMITTER_EMAIL: 'af-test@example.com',
    },
  });
}

function initGitRepo(dir, { name } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const init = git(dir, ['init']);
  assert.equal(init.status, 0, init.stderr);
  git(dir, ['config', 'user.email', 'af-test@example.com']);
  git(dir, ['config', 'user.name', 'af-test']);
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name || path.basename(dir)}\n`);
  git(dir, ['add', '.']);
  const c = git(dir, ['commit', '-m', 'initial']);
  assert.equal(c.status, 0, c.stderr + c.stdout);
  return dir;
}

describe('project derivation + aflt timeline', () => {
  let home;
  let stubDir;
  let stubCursor;
  let repoA;
  let repoB;
  let nonGit;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proj-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'const c=require("crypto"); const a=c.randomBytes(16); a[6]=(a[6]&0x0f)|0x40; a[8]=(a[8]&0x3f)|0x80; const h=a.toString("hex"); console.log(h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20));'
  exit 0
fi
echo "stub-ok"
exit 0
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-proj-home-'));
    repoA = initGitRepo(path.join(home, 'workspace', 'alpha-repo'), { name: 'alpha-repo' });
    repoB = initGitRepo(path.join(home, 'workspace', 'beta-repo'), { name: 'beta-repo' });
    nonGit = path.join(home, 'workspace', 'loose-folder');
    fs.mkdirSync(nonGit, { recursive: true });
    fs.writeFileSync(path.join(nonGit, 'note.txt'), 'hi\n');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    delete process.env.AFLT_PROJECT;
  });

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      AGENTFLEET_SESSION: '',
      AGENTFLEET_ID: '',
      AGENTFLEET_MASTER: '',
      AGENTFLEET_PARENT: '',
      ...extra,
    };
  }

  function af(args, extraEnv = {}, opts = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      cwd: opts.cwd || home,
      env: env(extraEnv),
    });
  }

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/registry')];
    delete require.cache[require.resolve('../lib/project')];
    delete require.cache[require.resolve('../lib/timeline')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function seed(partial) {
    const registry = loadRegistry();
    return registry.add({
      title: partial.title || 'Seed',
      chatId: partial.chatId || `aaaaaaaa-bbbb-cccc-dddd-${String(Math.random()).slice(2, 14).padEnd(12, '0')}`,
      cwd: partial.cwd || repoA,
      engine: 'cursor',
      status: partial.status || 'active',
      ...partial,
    });
  }

  describe('resolveProjectName', () => {
    it('aliases legacy project af → aflt without rewriting the session record', () => {
      delete require.cache[require.resolve('../lib/util')];
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../lib/project')];
      process.env.AGENTFLEET_HOME = home;
      process.env.HOME = home;
      const project = require('../lib/project');
      const session = { project: 'af', cwd: repoA };
      assert.equal(project.canonicalProjectName('af'), 'aflt');
      assert.equal(project.resolveProjectName(session), 'aflt');
      assert.equal(session.project, 'af');
      assert.equal(project.normalizeProjectFilter('af'), 'aflt');
      assert.equal(project.resolveProjectForCreate({ flag: 'af' }), 'aflt');
    });

    it('derives: explicit → .agentfleet.json → git basename → non-git / missing cwd / adhoc', () => {
      delete require.cache[require.resolve('../lib/util')];
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../lib/project')];
      process.env.AGENTFLEET_HOME = home;
      process.env.HOME = home;
      const project = require('../lib/project');
      const cache = project.createLookupCache();

      assert.equal(
        project.resolveProjectName({ project: 'explicit-name', cwd: repoA }, { cache }),
        'explicit-name'
      );

      fs.writeFileSync(
        path.join(repoA, '.agentfleet.json'),
        JSON.stringify({ project: 'from-config' }) + '\n'
      );
      assert.equal(
        project.resolveProjectName({ cwd: repoA }, { cache: project.createLookupCache() }),
        'from-config'
      );

      fs.unlinkSync(path.join(repoA, '.agentfleet.json'));
      assert.equal(
        project.resolveProjectName({ cwd: repoA }, { cache: project.createLookupCache() }),
        'alpha-repo'
      );

      assert.equal(
        project.resolveProjectName({ cwd: nonGit }, { cache: project.createLookupCache() }),
        'loose-folder'
      );

      const missing = path.join(home, 'does-not-exist-xyz');
      assert.equal(
        project.resolveProjectName({ cwd: missing }, { cache: project.createLookupCache() }),
        path.basename(missing)
      );

      // Read path ignores AFLT_PROJECT / global config
      process.env.AFLT_PROJECT = 'from-env-should-not-apply';
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ project: 'from-global' }) + '\n');
      assert.equal(
        project.resolveProjectName({ cwd: nonGit }, { cache: project.createLookupCache() }),
        'loose-folder'
      );
      delete process.env.AFLT_PROJECT;

      assert.equal(project.isAdhocCwd(os.tmpdir()), true);
      assert.equal(project.isAdhocCwd(home), true);
      assert.equal(
        project.resolveProjectName({ cwd: os.tmpdir() }, { cache: project.createLookupCache() }),
        'adhoc'
      );
      // Clear global config so create falls through to adhoc for tmpdir
      fs.writeFileSync(path.join(home, 'config.json'), '{}\n');
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../lib/project')];
      const project2 = require('../lib/project');
      assert.equal(
        project2.resolveProjectForCreate({ cwd: os.tmpdir(), env: {} }),
        'adhoc'
      );
    });

    it('create precedence: flag > env > global config', () => {
      delete require.cache[require.resolve('../lib/util')];
      delete require.cache[require.resolve('../lib/config')];
      delete require.cache[require.resolve('../lib/project')];
      process.env.AGENTFLEET_HOME = home;
      process.env.HOME = home;
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ project: 'from-global' }) + '\n');
      const project = require('../lib/project');

      assert.equal(
        project.resolveProjectForCreate({
          flag: 'from-flag',
          cwd: nonGit,
          env: { AFLT_PROJECT: 'from-env' },
        }),
        'from-flag'
      );
      assert.equal(
        project.resolveProjectForCreate({
          cwd: nonGit,
          env: { AFLT_PROJECT: 'from-env' },
        }),
        'from-env'
      );
      assert.equal(
        project.resolveProjectForCreate({ cwd: nonGit, env: {} }),
        'from-global'
      );
    });
  });

  it('docs timeline section truncates at ~8KB with marker', () => {
    delete require.cache[require.resolve('../lib/timeline')];
    const timelineLib = require('../lib/timeline');
    const sessions = [];
    for (let i = 0; i < 80; i++) {
      sessions.push({
        id: `sess-${String(i).padStart(4, '0')}-aaaaaa`,
        title: `Session-${i}-${'x'.repeat(40)}`,
        cwd: repoA,
        project: 'alpha',
        role: i === 0 ? 'master' : 'worker',
        parent: i === 0 ? null : 'sess-0000-aaaaaa',
        created: `2026-01-01T${String(10 + (i % 10)).padStart(2, '0')}:00:00.000Z`,
        runStartedAt: `2026-01-01T${String(10 + (i % 10)).padStart(2, '0')}:00:00.000Z`,
        lastRunAt: `2026-01-01T${String(10 + (i % 10)).padStart(2, '0')}:30:00.000Z`,
        lastUsed: `2026-01-01T${String(10 + (i % 10)).padStart(2, '0')}:30:00.000Z`,
        lastExit: 0,
        workerStatus: 'done',
        status: 'done',
        task: `task line ${i} ${'y'.repeat(80)}`,
        engine: 'cursor',
      });
    }
    const info = timelineLib.buildDocsTimelineSection(sessions, {
      projectRoot: repoA,
      project: 'alpha',
      includeCommits: false,
    });
    assert.ok(info.section);
    assert.ok(info.timelineBytes <= timelineLib.TIMELINE_DOCS_SECTION_MAX);
    assert.equal(info.truncated, true);
    assert.match(info.section, /\[truncated\]/);
  });

  it('ls/timeline do not rewrite the registry (mtime + content)', () => {
    const s = seed({
      title: 'NoBackfill',
      chatId: '11111111-1111-4111-8111-111111111111',
      cwd: repoA,
    });
    assert.equal(s.project, null);
    const regPath = path.join(home, 'sessions.json');
    const before = fs.readFileSync(regPath);
    const beforeMtime = fs.statSync(regPath).mtimeMs;

    // Touch clock slightly so a rewrite would bump mtime
    spawnSync('sleep', ['0.05']);
    const ls = af(['ls', '--json', '--all'], {}, { cwd: repoA });
    assert.equal(ls.status, 0, ls.stderr);
    const lsBody = JSON.parse(ls.stdout);
    assert.equal(lsBody.sessions.length, 1);
    assert.equal(lsBody.sessions[0].project, 'alpha-repo');
    assert.equal(lsBody.sessions[0].parent, null);

    const tl = af(['timeline', '--json'], {}, { cwd: repoA });
    assert.equal(tl.status, 0, tl.stderr);

    const after = fs.readFileSync(regPath);
    assert.ok(before.equals(after), 'registry content must be unchanged');
    assert.equal(fs.statSync(regPath).mtimeMs, beforeMtime);
    const raw = JSON.parse(after.toString('utf8'));
    assert.equal(raw.sessions[0].project, null);
  });

  it('--project on run is stored; spawned worker inherits it', () => {
    const run = af(
      [
        'run',
        'ProjRun',
        '--prompt',
        'Reply pong',
        '--cwd',
        repoA,
        '--project',
        'fleet-alpha',
        '--json',
      ],
      {},
      { cwd: repoA }
    );
    assert.equal(run.status, 0, run.stderr + run.stdout);
    const registry = loadRegistry();
    const masterish = registry.find('ProjRun');
    assert.ok(masterish);
    assert.equal(masterish.project, 'fleet-alpha');

    // Promote to master parent for spawn
    registry.update(masterish.id, { role: 'master' });

    const sp = af(
      [
        'spawn',
        '--parent',
        'ProjRun',
        '--prompt',
        'Do the thing',
        '--task',
        'helpers',
        '--json',
      ],
      {},
      { cwd: repoA }
    );
    assert.equal(sp.status, 0, sp.stderr + sp.stdout);
    const body = JSON.parse(sp.stdout);
    assert.ok(body.worker && body.worker.id);
    const worker = registry.find(body.worker.id);
    assert.equal(worker.project, 'fleet-alpha');
    assert.equal(worker.parent, masterish.id);
  });

  it('ls --project filters; ls --json includes project + parent', () => {
    seed({
      title: 'A1',
      chatId: '22222222-2222-4222-8222-222222222222',
      cwd: repoA,
      project: 'group-a',
    });
    seed({
      title: 'B1',
      chatId: '33333333-3333-4333-8333-333333333333',
      cwd: repoB,
      project: 'group-b',
    });
    seed({
      title: 'A2',
      chatId: '44444444-4444-4444-8444-444444444444',
      cwd: repoA,
      project: 'group-a',
      parent: 'fake-parent',
    });

    const filtered = af(['ls', '--all', '--json', '--project', 'group-a']);
    assert.equal(filtered.status, 0, filtered.stderr);
    const body = JSON.parse(filtered.stdout);
    assert.equal(body.sessions.length, 2);
    for (const row of body.sessions) {
      assert.equal(row.project, 'group-a');
      assert.ok('parent' in row);
    }
    const a2 = body.sessions.find((s) => s.title === 'A2');
    assert.equal(a2.parent, 'fake-parent');

    const other = af(['ls', '--all', '--json', '--project', 'group-b']);
    assert.equal(JSON.parse(other.stdout).sessions.length, 1);
  });

  it('timeline tree ordering, children, commits, --since, --all, --json shape; writes nothing', () => {
    const t0 = '2026-01-01T10:00:00.000Z';
    const t1 = '2026-01-01T11:00:00.000Z';
    const t2 = '2026-01-01T12:00:00.000Z';
    const t3 = '2026-01-01T13:00:00.000Z';

    const master = seed({
      title: 'MasterAlpha',
      chatId: '55555555-5555-4555-8555-555555555555',
      cwd: repoA,
      project: 'alpha',
      role: 'master',
      created: t0,
      runStartedAt: t0,
      lastRunAt: t3,
      lastUsed: t3,
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      task: 'orchestrate auth',
    });
    const worker = seed({
      title: 'MasterAlpha-w1',
      chatId: '66666666-6666-4666-8666-666666666666',
      cwd: repoA,
      project: 'alpha',
      role: 'worker',
      parent: master.id,
      created: t1,
      runStartedAt: t1,
      lastRunAt: t2,
      lastUsed: t2,
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      task: 'split helpers',
    });
    seed({
      title: 'OtherProj',
      chatId: '77777777-7777-4777-8777-777777777777',
      cwd: repoB,
      project: 'beta',
      created: t0,
      runStartedAt: t0,
      lastRunAt: t1,
      lastUsed: t1,
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      task: 'beta work',
    });

    // Commit inside worker window
    fs.writeFileSync(path.join(repoA, 'helpers.js'), 'module.exports = 1;\n');
    git(repoA, ['add', '.']);
    // Fix commit time inside [t1, t2]
    const commitEnv = {
      ...process.env,
      GIT_AUTHOR_NAME: 'af-test',
      GIT_AUTHOR_EMAIL: 'af-test@example.com',
      GIT_COMMITTER_NAME: 'af-test',
      GIT_COMMITTER_EMAIL: 'af-test@example.com',
      GIT_AUTHOR_DATE: '2026-01-01T11:30:00Z',
      GIT_COMMITTER_DATE: '2026-01-01T11:30:00Z',
    };
    const c = spawnSync('git', ['-C', repoA, 'commit', '-m', 'add helpers'], {
      encoding: 'utf8',
      env: commitEnv,
    });
    assert.equal(c.status, 0, c.stderr + c.stdout);

    const regPath = path.join(home, 'sessions.json');
    const before = fs.readFileSync(regPath);
    const beforeMtime = fs.statSync(regPath).mtimeMs;

    const tl = af(['timeline', 'alpha', '--json'], {}, { cwd: repoA });
    assert.equal(tl.status, 0, tl.stderr);
    const body = JSON.parse(tl.stdout);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.projects));
    assert.equal(body.projects.length, 1);
    assert.equal(body.projects[0].project, 'alpha');
    assert.ok(Array.isArray(body.projects[0].roots));
    assert.ok(Array.isArray(body.projects[0].sessions));
    assert.equal(body.projects[0].sessions.length, 1);
    const root = body.projects[0].sessions[0];
    assert.equal(root.id, master.id);
    assert.equal(root.children.length, 1);
    assert.equal(root.children[0].id, worker.id);
    assert.ok(root.children[0].promptSummary.includes('split helpers'));
    assert.ok(
      root.children[0].commits.some((line) => /add helpers/.test(line)),
      `expected commit in worker window, got ${JSON.stringify(root.children[0].commits)}`
    );

    // --since filters out older finished sessions
    const since = af(['timeline', 'alpha', '--json', '--since', '2026-01-02'], {}, { cwd: repoA });
    assert.equal(since.status, 0, since.stderr);
    const sinceBody = JSON.parse(since.stdout);
    assert.equal(sinceBody.projects[0].sessions.length, 0);

    const sinceOk = af(['timeline', 'alpha', '--json', '--since', '2026-01-01'], {}, { cwd: repoA });
    assert.ok(JSON.parse(sinceOk.stdout).projects[0].sessions.length >= 1);

    const all = af(['timeline', '--all', '--json'], {}, { cwd: home });
    assert.equal(all.status, 0, all.stderr);
    const allBody = JSON.parse(all.stdout);
    assert.equal(allBody.ok, true);
    const names = allBody.projects.map((p) => p.project).sort();
    assert.deepEqual(names, ['alpha', 'beta']);

    const text = af(['timeline', 'alpha'], {}, { cwd: repoA });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /MasterAlpha/);
    assert.match(text.stdout, /MasterAlpha-w1/);

    const empty = af(['timeline', 'no-such-project', '--json']);
    assert.equal(empty.status, 0, empty.stderr);
    assert.equal(JSON.parse(empty.stdout).projects[0].sessions.length, 0);

    assert.ok(before.equals(fs.readFileSync(regPath)));
    assert.equal(fs.statSync(regPath).mtimeMs, beforeMtime);
  });

  it('docs prompt includes timeline section with cap; dry-run reports timelineBytes', () => {
    fs.writeFileSync(
      path.join(repoA, '.agentfleet.json'),
      JSON.stringify({ docs: true, project: 'alpha' }) + '\n'
    );
    fs.mkdirSync(path.join(repoA, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(repoA, 'docs', 'NOTES.md'), 'notes\n');
    git(repoA, ['add', '.']);
    git(repoA, ['commit', '-m', 'enable docs']);

    seed({
      title: 'WorkSession',
      chatId: '88888888-8888-4888-8888-888888888888',
      cwd: repoA,
      project: 'alpha',
      role: 'worker',
      created: '2026-01-01T10:00:00.000Z',
      runStartedAt: '2026-01-01T10:00:00.000Z',
      lastRunAt: '2026-01-01T11:00:00.000Z',
      lastUsed: '2026-01-01T11:00:00.000Z',
      lastExit: 0,
      workerStatus: 'done',
      status: 'done',
      task: 'implement feature X',
    });

    const dry = af(['docs', repoA, '--dry-run', '--json', '--anyway'], {}, { cwd: repoA });
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    const dryBody = JSON.parse(dry.stdout);
    assert.ok('timelineBytes' in dryBody);
    assert.ok(dryBody.timelineBytes > 0, `expected timelineBytes > 0, got ${dryBody.timelineBytes}`);
    assert.ok(dryBody.promptBytes >= dryBody.timelineBytes);

    const dryText = af(['docs', repoA, '--dry-run', '--anyway'], {}, { cwd: repoA });
    assert.equal(dryText.status, 0, dryText.stderr);
    assert.match(dryText.stderr, /timelineBytes=\d+/);

    const run = af(['docs', repoA, '--anyway', '--force', '--json'], {}, { cwd: repoA });
    assert.equal(run.status, 0, run.stderr + run.stdout);
    // Prompt is stored on the docs session row — assert timeline section landed there.
    const registry = loadRegistry();
    const docsSession = registry.list({ includeDone: true }).find((s) => s.role === 'docs');
    assert.ok(docsSession);
    assert.equal(docsSession.project, 'alpha');
    assert.match(docsSession.prompt, /Session timeline since last docs run/);
    assert.match(docsSession.prompt, /WorkSession|implement feature/);
  });

  it('non-repo project: --project / AFLT_PROJECT / global config; timeline skips commits', () => {
    const dir1 = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ops-1-'));
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ops-2-'));
    const dir3 = fs.mkdtempSync(path.join(os.tmpdir(), 'af-ops-3-'));
    try {
      // Explicit --project
      const r1 = af(
        ['run', 'OpsOne', '--prompt', 'one', '--cwd', dir1, '--project', 'ops', '--json'],
        {},
        { cwd: dir1 }
      );
      assert.equal(r1.status, 0, r1.stderr + r1.stdout);

      // AFLT_PROJECT
      const r2 = af(
        ['run', 'OpsTwo', '--prompt', 'two', '--cwd', dir2, '--json'],
        { AFLT_PROJECT: 'ops' },
        { cwd: dir2 }
      );
      assert.equal(r2.status, 0, r2.stderr + r2.stdout);

      // Global config.json project
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ project: 'ops' }) + '\n');
      const r3 = af(
        ['run', 'OpsThree', '--prompt', 'three', '--cwd', dir3, '--json'],
        {},
        { cwd: dir3 }
      );
      assert.equal(r3.status, 0, r3.stderr + r3.stdout);

      const registry = loadRegistry();
      for (const title of ['OpsOne', 'OpsTwo', 'OpsThree']) {
        const s = registry.find(title);
        assert.ok(s, title);
        assert.equal(s.project, 'ops', title);
      }

      const ls = af(['ls', '--all', '--json', '--project', 'ops']);
      assert.equal(ls.status, 0, ls.stderr);
      const lsBody = JSON.parse(ls.stdout);
      assert.equal(lsBody.sessions.length, 3);
      for (const row of lsBody.sessions) {
        assert.equal(row.project, 'ops');
      }

      const tl = af(['timeline', 'ops', '--json'], {}, { cwd: dir1 });
      assert.equal(tl.status, 0, tl.stderr + tl.stdout);
      const tlBody = JSON.parse(tl.stdout);
      assert.equal(tlBody.ok, true);
      assert.equal(tlBody.projects.length, 1);
      assert.equal(tlBody.projects[0].project, 'ops');
      const flat = [];
      const walk = (nodes) => {
        for (const n of nodes || []) {
          flat.push(n);
          walk(n.children);
        }
      };
      walk(tlBody.projects[0].sessions);
      assert.equal(flat.length, 3);
      for (const s of flat) {
        assert.ok(Array.isArray(s.commits));
        assert.equal(s.commits.length, 0);
        assert.equal(s.commitsReason, 'not-git');
      }
    } finally {
      fs.rmSync(dir1, { recursive: true, force: true });
      fs.rmSync(dir2, { recursive: true, force: true });
      fs.rmSync(dir3, { recursive: true, force: true });
    }
  });
});

describe('timeline open-ended commit window', () => {
  it('idle open-ended row is bounded at lastUsed (or skipped); live run goes to now', () => {
    const timeline = require('../lib/timeline');
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'af-tl-open-'));
    try {
      initGitRepo(repo, { name: 'open' });
      const commitAt = (msg, when) => {
        fs.writeFileSync(path.join(repo, `${msg}.txt`), msg + '\n');
        git(repo, ['add', '.']);
        const r = spawnSync('git', ['-C', repo, 'commit', '-m', msg], {
          encoding: 'utf8',
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: 'af-test',
            GIT_AUTHOR_EMAIL: 'af-test@example.com',
            GIT_COMMITTER_NAME: 'af-test',
            GIT_COMMITTER_EMAIL: 'af-test@example.com',
            GIT_AUTHOR_DATE: when,
            GIT_COMMITTER_DATE: when,
          },
        });
        assert.equal(r.status, 0, r.stderr + r.stdout);
      };
      commitAt('inside', '2026-02-01T10:30:00Z');
      commitAt('later', '2026-02-05T10:00:00Z');
      const base = { cwd: repo, status: 'active', created: '2026-02-01T10:00:00.000Z' };

      const idle = { ...base, lastUsed: '2026-02-01T11:00:00.000Z' };
      assert.equal(timeline.sessionEndIso(idle), null);
      const a = timeline.commitsInWindow(idle, { start: idle.created, end: null });
      assert.ok(a.commits.some((c) => /inside/.test(c)));
      assert.ok(!a.commits.some((c) => /later/.test(c)), JSON.stringify(a.commits));

      const never = { ...base, lastUsed: base.created };
      const b = timeline.commitsInWindow(never, { start: never.created, end: null });
      assert.deepEqual(b.commits, []);
      assert.equal(b.reason, 'open-ended');

      const live = { ...base, lastUsed: base.created, workerStatus: 'running' };
      const c = timeline.commitsInWindow(live, { start: live.created, end: null });
      assert.ok(c.commits.some((x) => /later/.test(x)));
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
