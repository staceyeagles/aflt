'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const http = require('http');
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

function clearDashboardModules() {
  const mods = [
    '../lib/util',
    '../lib/config',
    '../lib/project',
    '../lib/registry',
    '../lib/memory',
    '../lib/herdr',
    '../lib/orchestrate',
    '../lib/dashboard',
  ];
  for (const m of mods) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function loadDashboard(home) {
  clearDashboardModules();
  process.env.AGENTFLEET_HOME = home;
  process.env.HOME = home;
  delete process.env.AFLT_MEMORY_REPO;
  return require('../lib/dashboard');
}

function loadRegistry(home) {
  clearDashboardModules();
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
    cwd: partial.cwd || path.join(home, 'proj'),
    engine: partial.engine || 'cursor',
    status: partial.status || 'done',
    created: partial.created || '2024-06-01T00:00:00.000Z',
    lastUsed: partial.lastUsed || '2024-06-02T00:00:00.000Z',
    ...partial,
  });
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: pathname, timeout: 5000 },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

function httpSseOneEvent(port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: '127.0.0.1', port, path: '/events', timeout: 5000 },
      (res) => {
        assert.equal(res.statusCode, 200);
        assert.match(String(res.headers['content-type'] || ''), /text\/event-stream/);
        let buf = '';
        res.on('data', (c) => {
          buf += c.toString('utf8');
          if (buf.includes('\n\n')) {
            req.destroy();
            resolve({ headers: res.headers, body: buf });
          }
        });
        res.on('error', () => {});
      }
    );
    req.on('error', (err) => {
      if (err && err.code === 'ECONNRESET') return;
      reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('sse timeout'));
    });
  });
}

describe('aflt dashboard', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevMem;
  let prevReg;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevMem = process.env.AFLT_MEMORY_REPO;
    prevReg = process.env.AGENTFLEET_REGISTRY;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dash-home-'));
    fs.mkdirSync(path.join(home, 'proj'), { recursive: true });
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AFLT_MEMORY_REPO;
    delete process.env.AGENTFLEET_REGISTRY;
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
    if (prevReg === undefined) delete process.env.AGENTFLEET_REGISTRY;
    else process.env.AGENTFLEET_REGISTRY = prevReg;
    delete process.env.AFLT_PROJECT;
    clearDashboardModules();
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

  it('aggregates counts, derived states, grouping, sparklines, and timeline', () => {
    const dash = loadDashboard(home);
    const now = '2024-06-10T12:00:00.000Z';
    const master = {
      id: 'master-aaaaaaaaaaaa',
      title: 'orch-master',
      project: 'alpha',
      engine: 'cursor',
      status: 'active',
      role: 'master',
      created: '2024-06-10T10:00:00.000Z',
      lastUsed: '2024-06-10T11:55:00.000Z',
      lastRunAt: '2024-06-10T11:50:00.000Z',
      runPid: process.pid,
      cwd: path.join(home, 'proj'),
    };
    const worker = {
      id: 'worker-bbbbbbbbbbbb',
      title: 'helper-worker',
      project: 'alpha',
      engine: 'copilot',
      status: 'done',
      parent: master.id,
      role: 'worker',
      created: '2024-06-10T10:05:00.000Z',
      lastUsed: '2024-06-10T10:30:00.000Z',
      lastRunAt: '2024-06-10T10:20:00.000Z',
      lastExit: 0,
      cwd: path.join(home, 'proj'),
    };
    const failed = {
      id: 'fail-cccccccccccc',
      title: 'broke-session',
      project: 'beta',
      engine: 'cursor',
      status: 'done',
      created: '2024-06-09T08:00:00.000Z',
      lastUsed: '2024-06-09T09:00:00.000Z',
      lastExit: 2,
      lastError: 'boom',
      cwd: path.join(home, 'proj'),
    };
    const idle = {
      id: 'idle-dddddddddddd',
      title: 'paused-one',
      project: 'beta',
      engine: 'cursor',
      status: 'paused',
      created: '2024-06-08T00:00:00.000Z',
      lastUsed: '2024-06-08T01:00:00.000Z',
      cwd: path.join(home, 'proj'),
    };

    const payload = dash.aggregateDashboard({
      sessions: [master, worker, failed, idle],
      memoryRecords: [],
      enrichmentById: {
        [master.id]: { runtime: 'running', address: 't1', name: 'af-master', checkedAt: now },
      },
      now,
      isAlive: (pid) => Number(pid) === process.pid,
    });

    assert.equal(payload.stats.sessions, 4);
    assert.equal(payload.stats.runningSessions, 1);
    assert.equal(payload.stats.engines.cursor, 3);
    assert.equal(payload.stats.engines.copilot, 1);
    assert.equal(payload.stats.failed, 1);
    assert.ok(payload.stats.activeProjects >= 1);

    const byId = Object.fromEntries(payload.sessions.map((s) => [s.id, s]));
    assert.equal(byId[master.id].displayState, 'running');
    assert.equal(byId[worker.id].displayState, 'done');
    assert.equal(byId[failed.id].displayState, 'failed');
    assert.equal(byId[idle.id].displayState, 'idle');
    assert.equal(byId[worker.id].project, 'alpha');
    assert.deepEqual(byId[master.id].children, [worker.id]);

    const projects = Object.fromEntries(payload.projects.map((p) => [p.name, p]));
    assert.ok(projects.alpha);
    assert.ok(projects.beta);
    assert.equal(projects.alpha.displayState, 'running');
    assert.ok(payload.links.some((l) => l.kind === 'parent' && l.from === master.id));
    assert.equal(payload.sparkline24h.length, 24);
    assert.equal(payload.sparkline7d.length, 7);
    assert.ok(payload.sparkline24h.some((n) => n > 0) || payload.sparkline7d.some((n) => n > 0));
    assert.ok(payload.events.length > 0);
    assert.ok(payload.events[0].at >= payload.events[payload.events.length - 1].at);
  });

  it('merges optional memory sessions.jsonl and ignores when absent', () => {
    const dash = loadDashboard(home);
    const memRepo = path.join(home, 'memory-repo');
    fs.mkdirSync(path.join(memRepo, 'gamma', '_aflt'), { recursive: true });
    fs.writeFileSync(
      path.join(memRepo, 'gamma', '_aflt', 'sessions.jsonl'),
      JSON.stringify({
        id: 'hist-1',
        title: 'old-gamma',
        project: 'gamma',
        start: '2024-06-01T00:00:00.000Z',
        lastUsed: '2024-06-01T01:00:00.000Z',
      }) + '\n'
    );

    const withMem = dash.aggregateDashboard({
      sessions: [
        {
          id: 's1',
          title: 'live',
          project: 'alpha',
          engine: 'cursor',
          status: 'done',
          created: '2024-06-10T00:00:00.000Z',
          lastUsed: '2024-06-10T01:00:00.000Z',
          lastExit: 0,
        },
      ],
      memoryRecords: dash.loadMemoryRecords(memRepo),
      now: '2024-06-10T12:00:00.000Z',
    });
    assert.equal(withMem.memory.present, true);
    assert.ok(withMem.memory.recordCount >= 1);
    assert.ok(withMem.projects.some((p) => p.name === 'gamma'));

    const noMem = dash.aggregateDashboard({
      sessions: [
        {
          id: 's1',
          title: 'live',
          project: 'alpha',
          engine: 'cursor',
          status: 'done',
          created: '2024-06-10T00:00:00.000Z',
          lastUsed: '2024-06-10T01:00:00.000Z',
          lastExit: 0,
        },
      ],
      memoryRecords: dash.loadMemoryRecords(path.join(home, 'missing-memory')),
      now: '2024-06-10T12:00:00.000Z',
    });
    assert.equal(noMem.memory.present, false);
    assert.equal(noMem.memory.recordCount, 0);
  });

  it('HTTP serve: /, /api/state, /events; read-only on registry', async () => {
    seedSession(home, {
      title: 'dash-alpha',
      project: 'alpha',
      engine: 'cursor',
      status: 'active',
      lastUsed: new Date().toISOString(),
      created: new Date().toISOString(),
    });
    seedSession(home, {
      title: 'dash-beta-fail',
      project: 'beta',
      engine: 'copilot',
      status: 'done',
      lastExit: 1,
      lastError: 'nope',
      lastUsed: '2024-01-01T00:00:00.000Z',
      created: '2024-01-01T00:00:00.000Z',
    });

    const dash = loadDashboard(home);
    const registry = require('../lib/registry');
    let saveCalls = 0;
    let updateCalls = 0;
    let addCalls = 0;
    const origSave = registry.save;
    const origUpdate = registry.update;
    const origAdd = registry.add;
    registry.save = (...args) => {
      saveCalls += 1;
      return origSave(...args);
    };
    registry.update = (...args) => {
      updateCalls += 1;
      return origUpdate(...args);
    };
    registry.add = (...args) => {
      addCalls += 1;
      return origAdd(...args);
    };

    const handle = dash.createDashboardServer({
      sseIntervalMs: 60_000,
      registryPollMs: 60_000,
      herdrFetch: { ok: false, error: 'stub', terminals: [], checkedAt: new Date().toISOString() },
    });

    await new Promise((resolve, reject) => {
      handle.server.once('error', reject);
      handle.server.listen(0, '127.0.0.1', resolve);
    });
    const port = handle.server.address().port;

    try {
      const index = await httpGet(port, '/');
      assert.equal(index.status, 200);
      assert.match(index.body, /aflt live/);
      assert.match(index.headers['content-type'] || '', /text\/html/);

      const api = await httpGet(port, '/api/state');
      assert.equal(api.status, 200);
      const payload = JSON.parse(api.body);
      assert.ok(payload.sessions.some((s) => s.title === 'dash-alpha'));
      assert.ok(payload.sessions.some((s) => s.title === 'dash-beta-fail'));
      assert.ok(payload.projects.some((p) => p.name === 'alpha'));

      const sse = await httpSseOneEvent(port);
      assert.match(sse.body, /^data: /m);
      const line = sse.body.split('\n').find((l) => l.startsWith('data: '));
      const ssePayload = JSON.parse(line.slice(6));
      assert.ok(ssePayload.sessions.some((s) => s.title === 'dash-alpha'));

      assert.equal(saveCalls, 0);
      assert.equal(updateCalls, 0);
      assert.equal(addCalls, 0);
    } finally {
      registry.save = origSave;
      registry.update = origUpdate;
      registry.add = origAdd;
      await handle.close();
    }
  });

  it('snapshot stamp is America/New_York (ET), not UTC', () => {
    const dash = loadDashboard(home);
    const utcWinter = '2026-11-16T00:52:17.000Z'; // 19:52:17 ET (EST, UTC-5)
    const utcSummer = '2026-06-15T00:52:17.000Z'; // 20:52:17 ET (EDT, UTC-4)
    assert.equal(dash.formatSnapshotStamp(utcWinter), '2026-11-15 19:52:17 ET');
    assert.equal(dash.formatSnapshotStamp(utcSummer), '2026-06-14 20:52:17 ET');
    assert.equal(dash.formatSnapshotStamp(new Date(utcWinter)), '2026-11-15 19:52:17 ET');
    assert.equal(dash.formatSnapshotStamp('not-a-date'), '');

    const svg = dash.renderSvg({
      generatedAt: utcWinter,
      stats: { activeProjects: 0, runningSessions: 0, engines: {} },
      projects: [],
      sessions: [],
      events: [],
      sparkline24h: [],
      sparkline7d: [],
      links: [],
    });
    assert.match(svg, /local · snapshot 2026-11-15 19:52:17 ET/);
    assert.doesNotMatch(svg, /2026-11-16 00:52:17/);
  });

  it('snapshot writes .svg and .html with seeded labels', () => {
    seedSession(home, {
      title: 'snap-session',
      project: 'snapproj',
      engine: 'cursor',
      status: 'done',
      lastExit: 0,
      lastUsed: '2024-06-01T00:00:00.000Z',
      created: '2024-06-01T00:00:00.000Z',
    });
    const dash = loadDashboard(home);
    const state = dash.collectState({
      herdrFetch: { ok: false, error: 'stub', terminals: [], checkedAt: '2024-06-01T00:00:00.000Z' },
    });

    const svgPath = path.join(home, 'out', 'dash.svg');
    const htmlPath = path.join(home, 'out', 'dash.html');
    dash.writeSnapshot(svgPath, state);
    dash.writeSnapshot(htmlPath, state);

    const svg = fs.readFileSync(svgPath, 'utf8');
    const html = fs.readFileSync(htmlPath, 'utf8');
    assert.ok(svg.length > 100);
    assert.ok(html.length > 100);
    assert.match(svg, /snapproj/);
    assert.match(svg, /aflt live/);
    assert.match(html, /snapproj|snap-session/);
    assert.match(html, /<svg/);

    assert.throws(
      () => dash.writeSnapshot(path.join(home, 'out', 'dash.png'), state),
      /unsupported snapshot extension/
    );
  });

  it('CLI snapshot via aflt dashboard --snapshot', () => {
    seedSession(home, {
      title: 'cli-snap',
      project: 'cliproj',
      status: 'done',
      lastExit: 0,
      lastUsed: '2024-06-01T00:00:00.000Z',
      created: '2024-06-01T00:00:00.000Z',
    });
    const out = path.join(home, 'cli.svg');
    const r = af(['dashboard', '--snapshot', out, '--json'], env());
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.ok(fs.existsSync(out));
    assert.match(fs.readFileSync(out, 'utf8'), /cliproj/);
  });

  it('CLI usage error without --serve or --snapshot', () => {
    const r = af(['dashboard'], env());
    assert.equal(r.status, 1);
    assert.match(r.stderr, /--serve|--snapshot/);
  });
});
