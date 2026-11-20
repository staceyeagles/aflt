'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
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

function initGitRepo(dir, { remote } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const init = git(dir, ['init']);
  assert.equal(init.status, 0, init.stderr);
  git(dir, ['config', 'user.email', 'af-test@example.com']);
  git(dir, ['config', 'user.name', 'af-test']);
  if (remote) {
    const r = git(dir, ['remote', 'add', 'origin', remote]);
    assert.equal(r.status, 0, r.stderr);
  }
  return dir;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

function loadFresh(home) {
  for (const mod of [
    '../lib/util',
    '../lib/config',
    '../lib/project',
    '../lib/project-meta',
    '../lib/memory',
    '../lib/timeline',
    '../lib/dashboard',
    '../lib/registry',
  ]) {
    try {
      delete require.cache[require.resolve(mod)];
    } catch (_) {
      /* ignore */
    }
  }
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  return {
    projectMeta: require('../lib/project-meta'),
    project: require('../lib/project'),
    timeline: require('../lib/timeline'),
    dashboard: require('../lib/dashboard'),
    config: require('../lib/config'),
    memory: require('../lib/memory'),
  };
}

describe('project-repo metadata (issue #1)', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevMem;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevMem = process.env.AFLT_MEMORY_REPO;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-pmeta-'));
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

  function af(args, env = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      cwd: home,
      env: {
        ...process.env,
        HOME: home,
        AGENTFLEET_HOME: home,
        AFLT_MEMORY_REPO: '',
        AGENTFLEET_SESSION: '',
        AGENTFLEET_ID: '',
        ...env,
      },
    });
  }

  it('normalizeRemote strips protocols and .git', () => {
    const { projectMeta } = loadFresh(home);
    assert.equal(
      projectMeta.normalizeRemote('https://github.com/wwlib/lab-assistant.git'),
      'github.com/wwlib/lab-assistant'
    );
    assert.equal(
      projectMeta.normalizeRemote('git@github.com:wwlib/lab-assistant.git'),
      'github.com/wwlib/lab-assistant'
    );
    assert.equal(
      projectMeta.normalizeRemote('ssh://git@github.com/wwlib/lab-assistant'),
      'github.com/wwlib/lab-assistant'
    );
  });

  it('parses memory metadata and keeps legacy project-only configs', () => {
    const { projectMeta } = loadFresh(home);
    const full = projectMeta.parseMemoryProjectConfig(
      {
        id: 'lab-assistant',
        name: 'Lab',
        repositories: [
          {
            remote: 'https://github.com/wwlib/lab-assistant.git',
            locations: ['.'],
          },
          {
            url: 'git@github.com:wwlib/master-copilot-directory.git',
            locations: ['docs/lab-assistant'],
          },
        ],
        relationships: [{ type: 'related', project: 'graph-memory' }],
      },
      { folder: 'lab-assistant' }
    );
    assert.equal(full.id, 'lab-assistant');
    assert.equal(full.repositories.length, 2);
    assert.equal(full.repositories[0].remote, 'github.com/wwlib/lab-assistant');
    assert.deepEqual(full.repositories[1].locations, ['docs/lab-assistant']);
    assert.equal(full.relationships[0].project, 'graph-memory');

    const legacy = projectMeta.parseMemoryProjectConfig(
      { project: 'my-app' },
      { folder: 'my-app' }
    );
    assert.equal(legacy.id, 'my-app');
    assert.equal(legacy.repositories.length, 0);
  });

  it('infers project only when mapping is unambiguous', () => {
    const memRepo = path.join(home, 'memory');
    const checkout = path.join(home, 'src', 'solo');
    initGitRepo(checkout, { remote: 'https://github.com/example/solo.git' });
    fs.writeFileSync(path.join(checkout, 'README.md'), '# solo\n');
    git(checkout, ['add', '.']);
    git(checkout, ['commit', '-m', 'init']);

    fs.mkdirSync(path.join(memRepo, 'solo-app'), { recursive: true });
    writeJson(path.join(memRepo, 'solo-app', '.agentfleet.json'), {
      id: 'solo-app',
      repositories: [
        { remote: 'github.com/example/solo', locations: ['.'] },
      ],
    });
    fs.writeFileSync(path.join(memRepo, '.aflt-memory.json'), '{"version":1}\n');

    writeJson(path.join(home, 'config.json'), {
      memoryRepo: memRepo,
      repositories: {
        'github.com/example/solo': { path: checkout },
      },
    });

    const { project, projectMeta } = loadFresh(home);
    const inferred = projectMeta.inferProjectFromMappings(checkout, {
      memoryRepo: memRepo,
      env: process.env,
    });
    assert.equal(inferred.project, 'solo-app');
    assert.equal(
      project.resolveProjectForCreate({ cwd: checkout, env: process.env }),
      'solo-app'
    );
  });

  it('does not infer when two projects share the same whole-repo remote', () => {
    const memRepo = path.join(home, 'memory');
    const checkout = path.join(home, 'src', 'shared');
    initGitRepo(checkout, { remote: 'https://github.com/example/monorepo.git' });
    fs.writeFileSync(path.join(checkout, 'README.md'), '# mono\n');
    git(checkout, ['add', '.']);
    git(checkout, ['commit', '-m', 'init']);

    for (const id of ['pkg-a', 'pkg-b']) {
      fs.mkdirSync(path.join(memRepo, id), { recursive: true });
      writeJson(path.join(memRepo, id, '.agentfleet.json'), {
        id,
        repositories: [
          { remote: 'github.com/example/monorepo', locations: ['.'] },
        ],
      });
    }
    fs.writeFileSync(path.join(memRepo, '.aflt-memory.json'), '{"version":1}\n');
    writeJson(path.join(home, 'config.json'), {
      memoryRepo: memRepo,
      repositories: {
        'github.com/example/monorepo': { path: checkout },
      },
    });

    const { project, projectMeta } = loadFresh(home);
    const hit = projectMeta.inferProjectFromMappings(checkout, {
      memoryRepo: memRepo,
    });
    assert.equal(hit.confidence, 'ambiguous');
    assert.equal(hit.project, null);
    // Falls through to git basename
    assert.equal(
      project.resolveProjectForCreate({ cwd: checkout, env: process.env }),
      'shared'
    );
  });

  it('location slices disambiguate monorepo packages', () => {
    const memRepo = path.join(home, 'memory');
    const checkout = path.join(home, 'src', 'mono');
    initGitRepo(checkout, { remote: 'https://github.com/example/mono.git' });
    fs.mkdirSync(path.join(checkout, 'packages', 'a'), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'packages', 'b'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'packages', 'a', 'x.txt'), 'a\n');
    fs.writeFileSync(path.join(checkout, 'packages', 'b', 'x.txt'), 'b\n');
    fs.writeFileSync(path.join(checkout, 'README.md'), '# mono\n');
    git(checkout, ['add', '.']);
    git(checkout, ['commit', '-m', 'init']);

    writeJson(path.join(memRepo, 'pkg-a', '.agentfleet.json'), {
      id: 'pkg-a',
      repositories: [
        {
          remote: 'github.com/example/mono',
          locations: ['packages/a'],
        },
      ],
    });
    writeJson(path.join(memRepo, 'pkg-b', '.agentfleet.json'), {
      id: 'pkg-b',
      repositories: [
        {
          remote: 'github.com/example/mono',
          locations: ['packages/b'],
        },
      ],
    });
    fs.writeFileSync(path.join(memRepo, '.aflt-memory.json'), '{"version":1}\n');
    writeJson(path.join(home, 'config.json'), {
      memoryRepo: memRepo,
      repositories: {
        'github.com/example/mono': { path: checkout },
      },
    });

    const { project } = loadFresh(home);
    assert.equal(
      project.resolveProjectForCreate({
        cwd: path.join(checkout, 'packages', 'a'),
        env: process.env,
      }),
      'pkg-a'
    );
    assert.equal(
      project.resolveProjectForCreate({
        cwd: path.join(checkout, 'packages', 'b'),
        env: process.env,
      }),
      'pkg-b'
    );
  });

  it('never rewrites a stored session.project', () => {
    const { project } = loadFresh(home);
    const session = {
      id: 's1',
      project: 'historical-name',
      cwd: path.join(home, 'somewhere-else'),
    };
    assert.equal(project.resolveProjectName(session), 'historical-name');
  });

  it('source projectId is a launch default synonym for project', () => {
    const repo = path.join(home, 'src', 'app');
    initGitRepo(repo);
    writeJson(path.join(repo, '.agentfleet.json'), { projectId: 'named-app' });
    const { project } = loadFresh(home);
    assert.equal(
      project.resolveProjectForCreate({ cwd: repo, env: process.env }),
      'named-app'
    );
  });

  it('reports unavailable checkouts via aflt projects --json', () => {
    const memRepo = path.join(home, 'memory');
    writeJson(path.join(memRepo, 'gone', '.agentfleet.json'), {
      id: 'gone',
      repositories: [
        { remote: 'github.com/example/gone', locations: ['.'] },
      ],
    });
    fs.writeFileSync(path.join(memRepo, '.aflt-memory.json'), '{"version":1}\n');
    writeJson(path.join(home, 'config.json'), {
      memoryRepo: memRepo,
      repositories: {
        'github.com/example/gone': { path: path.join(home, 'missing-checkout') },
      },
    });

    const r = af(['projects', '--json'], { AFLT_MEMORY_REPO: memRepo });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.projects.length, 1);
    assert.equal(payload.projects[0].id, 'gone');
    assert.ok(
      payload.projects[0].problems.some((p) => p.code === 'unavailable-checkout')
    );
  });

  it('works with no memory repo (backward compatible)', () => {
    const { projectMeta, project } = loadFresh(home);
    const report = projectMeta.buildProjectsReport({ memoryRepo: null });
    assert.equal(report.ok, true);
    assert.equal(report.projects.length, 0);
    const repo = path.join(home, 'src', 'plain');
    initGitRepo(repo);
    assert.equal(
      project.resolveProjectForCreate({ cwd: repo, env: process.env }),
      'plain'
    );
  });

  it('filters commits by locations and marks inferred attribution', () => {
    const memRepo = path.join(home, 'memory');
    const checkout = path.join(home, 'src', 'mono');
    initGitRepo(checkout, { remote: 'https://github.com/example/mono.git' });
    fs.mkdirSync(path.join(checkout, 'packages', 'a'), { recursive: true });
    fs.mkdirSync(path.join(checkout, 'packages', 'b'), { recursive: true });
    fs.writeFileSync(path.join(checkout, 'packages', 'a', 'a.txt'), 'a1\n');
    fs.writeFileSync(path.join(checkout, 'packages', 'b', 'b.txt'), 'b1\n');
    fs.writeFileSync(path.join(checkout, 'README.md'), '# mono\n');
    git(checkout, ['add', '.']);
    const c0 = git(checkout, ['commit', '-m', 'init both']);
    assert.equal(c0.status, 0, c0.stderr);

    fs.writeFileSync(path.join(checkout, 'packages', 'a', 'a.txt'), 'a2\n');
    git(checkout, ['add', 'packages/a/a.txt']);
    const cA = git(checkout, ['commit', '-m', 'only a']);
    assert.equal(cA.status, 0, cA.stderr);

    fs.writeFileSync(path.join(checkout, 'packages', 'b', 'b.txt'), 'b2\n');
    git(checkout, ['add', 'packages/b/b.txt']);
    const cB = git(checkout, ['commit', '-m', 'only b']);
    assert.equal(cB.status, 0, cB.stderr);

    writeJson(path.join(memRepo, 'pkg-a', '.agentfleet.json'), {
      id: 'pkg-a',
      repositories: [
        { remote: 'github.com/example/mono', locations: ['packages/a'] },
      ],
    });
    fs.writeFileSync(path.join(memRepo, '.aflt-memory.json'), '{"version":1}\n');
    writeJson(path.join(home, 'config.json'), {
      memoryRepo: memRepo,
      repositories: {
        'github.com/example/mono': { path: checkout },
      },
    });

    const { timeline } = loadFresh(home);
    const session = {
      id: 's-a',
      title: 'work-a',
      project: 'pkg-a',
      cwd: path.join(checkout, 'packages', 'a'),
      created: '2020-01-01T00:00:00.000Z',
      lastUsed: '2099-01-01T00:00:00.000Z',
      status: 'done',
      runStartedAt: '2020-01-01T00:00:00.000Z',
      lastRunAt: '2099-01-01T00:00:00.000Z',
    };
    const record = timeline.buildSessionRecord(session, {
      memoryRepo: memRepo,
      env: process.env,
    });
    assert.equal(record.commitsAttribution, 'confirmed');
    const subjects = (record.commits || []).map((l) => l.replace(/^[0-9a-f]+ /, ''));
    assert.ok(subjects.some((s) => /only a/.test(s)), subjects.join(','));
    assert.ok(!subjects.some((s) => /only b/.test(s)), subjects.join(','));
  });

  it('dashboard aggregate attaches repository metadata', () => {
    const memRepo = path.join(home, 'memory');
    writeJson(path.join(memRepo, 'dash-app', '.agentfleet.json'), {
      id: 'dash-app',
      name: 'Dash App',
      repositories: [
        { remote: 'github.com/example/dash-app', locations: ['.'] },
      ],
    });
    fs.writeFileSync(path.join(memRepo, '.aflt-memory.json'), '{"version":1}\n');
    writeJson(path.join(home, 'config.json'), { memoryRepo: memRepo });

    const { dashboard, projectMeta } = loadFresh(home);
    const report = projectMeta.buildProjectsReport({ memoryRepo: memRepo });
    const byId = {};
    for (const p of report.projects) byId[p.id] = p;
    const state = dashboard.aggregateDashboard({
      sessions: [],
      memoryProjects: [{ project: 'dash-app', folder: 'dash-app', documents: [], summary: null, errors: [] }],
      projectMetaById: byId,
      now: '2026-01-01T00:00:00.000Z',
    });
    const proj = state.projects.find((p) => p.name === 'dash-app');
    assert.ok(proj);
    assert.equal(proj.displayName, 'Dash App');
    assert.ok((proj.repositories || []).length >= 1);
  });
});
