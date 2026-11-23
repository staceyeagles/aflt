'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/loop-scheduler',
    '../lib/notify',
    '../lib/config',
    '../lib/memory',
    '../lib/dashboard',
    '../lib/registry',
    '../lib/util',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function writeLoopFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return file;
}

function httpRequest(port, pathname, opts = {}) {
  const method = opts.method || 'GET';
  const body = opts.body != null ? JSON.stringify(opts.body) : null;
  const headers = Object.assign(
    {
      Host: '127.0.0.1',
      Accept: 'application/json',
    },
    opts.headers || {}
  );
  if (body) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: pathname,
        method,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8'),
            headers: res.headers,
          });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function startCaptureServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch (_) {
        body = raw;
      }
      hits.push({ method: req.method, url: req.url, body });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        hits,
        url: `http://127.0.0.1:${addr.port}/hook`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('aflt loop milestone 3', () => {
  let home;
  let cwd;
  let prevHome;
  let prevAfHome;
  let prevUrl;

  function afEnv(extra) {
    return Object.assign(
      {
        HOME: home,
        AGENTFLEET_HOME: path.join(home, '.agentfleet'),
        PATH: process.env.PATH,
      },
      extra || {}
    );
  }

  /** Hermetic session factory — never calls a real engine create-chat. */
  function fakeEnsureSession(phase) {
    return {
      id: 'sess-fake-' + String(phase.id || 'phase'),
      title: phase.session || 'fake-session',
      engine: phase.engine || 'cursor',
      chatId: 'chat-fake-' + String(phase.id || 'phase'),
      cwd,
      status: 'active',
    };
  }

  function runOpts(extra) {
    return Object.assign(
      {
        env: afEnv(),
        ensureSession: fakeEnsureSession,
      },
      extra || {}
    );
  }

  function baseDef(overrides) {
    return Object.assign(
      {
        name: 'm3-loop',
        project: 'demo',
        cwd: cwd,
        engine: 'cursor',
        allow: { commit: false, merge: false, push: false },
        budget: { maxRuns: 10, maxHours: 1 },
        phases: [
          {
            id: 'gated',
            engine: 'cursor',
            session: 'm3-sess',
            prompt: 'Create HELLO.txt with exactly: hello from aflt loop',
            gate: 'approve',
            eval: {
              command: ['grep', '-x', 'hello from aflt loop', 'HELLO.txt'],
              exitCode: 0,
            },
            maxFixAttempts: 1,
            onPass: 'none',
            force: true,
          },
        ],
      },
      overrides || {}
    );
  }

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-m3-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-m3-cwd-'));
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevUrl = process.env.AFLT_NOTIFY_URL;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    fs.mkdirSync(process.env.AGENTFLEET_HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    if (prevAfHome == null) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevUrl == null) delete process.env.AFLT_NOTIFY_URL;
    else process.env.AFLT_NOTIFY_URL = prevUrl;
    clearMods();
  });

  it('validates gate: approve on phases', () => {
    const loop = require('../lib/loop');
    const ok = loop.validateDefinition(baseDef());
    assert.equal(ok.ok, true);
    assert.equal(ok.definition.phases[0].gate, 'approve');

    const bad = loop.validateDefinition(
      baseDef({
        phases: [
          {
            id: 'x',
            prompt: 'hi',
            gate: 'rubber-stamp',
            eval: { command: 'true', exitCode: 0 },
          },
        ],
      })
    );
    assert.equal(bad.ok, false);
    assert.ok(bad.errors.some((e) => /gate/.test(e)));
  });

  it('pauses at approval gate, emits loop.gate.waiting, approve resumes', async () => {
    const capture = await startCaptureServer();
    process.env.AFLT_NOTIFY_URL = capture.url;
    clearMods();
    const loop = require('../lib/loop');
    const file = writeLoopFile(cwd, 'gate.json', baseDef({ name: 'gate-loop' }));

    try {
      const first = await loop.runFromFile(
        file,
        runOpts({
          env: afEnv({ AFLT_NOTIFY_URL: capture.url }),
          runPrompt: async () => {
            throw new Error('should not run prompt before approve');
          },
        })
      );
      assert.equal(first.status, 'waiting', first.error || first.status);
      assert.equal(first.state.step, 'gate');
      assert.equal(first.state.gate.waiting, true);
      assert.equal(first.state.phases.gated.gateApproved, false);
      assert.equal(loop.isSchedulerCandidate(first.state), false);

      await new Promise((r) => setTimeout(r, 40));
      const events = capture.hits.map((h) => h.body && h.body.event).filter(Boolean);
      assert.ok(events.includes('loop.gate.waiting'), events.join(','));

      const approved = loop.requestApprove('gate-loop', {
        env: afEnv({ AFLT_NOTIFY_URL: capture.url }),
      });
      assert.equal(approved.ok, true);
      assert.equal(approved.status, 'pending');
      assert.equal(approved.state.phases.gated.gateApproved, true);
      assert.equal(approved.state.gate.waiting, false);
      if (approved.notify) await approved.notify;

      const second = await loop.resumeLoop(
        'gate-loop',
        runOpts({
          env: afEnv({ AFLT_NOTIFY_URL: capture.url }),
          runPrompt: async () => {
            fs.writeFileSync(path.join(cwd, 'HELLO.txt'), 'hello from aflt loop\n');
            return { code: 0, timedOut: false };
          },
        })
      );
      assert.equal(second.ok, true, second.error || second.status);
      assert.equal(second.status, 'completed');
    } finally {
      await capture.close();
    }
  });

  it('saves definitions only under allowed loops dir', () => {
    const loop = require('../lib/loop');
    const saved = loop.saveDefinition(baseDef({ name: 'saved-loop' }));
    assert.equal(saved.ok, true, (saved.errors || []).join('; '));
    assert.ok(fs.existsSync(saved.path));
    assert.ok(saved.path.includes(path.join('.agentfleet', 'loops', 'definitions')));
    assert.equal(JSON.parse(fs.readFileSync(saved.path, 'utf8')).phases[0].gate, 'approve');

    const listed = loop.listSavedDefinitions();
    assert.ok(listed.definitions.some((d) => d.name === 'saved-loop'));

    const outside = path.join(cwd, 'evil.json');
    assert.throws(
      () => loop.assertPathInAllowedRoots(outside),
      (err) => err && err.code === 'LOOP_PATH'
    );
  });

  it('status report includes pipeline, budget, elapsed, eval tail', async () => {
    const loop = require('../lib/loop');
    const file = writeLoopFile(
      cwd,
      'status.json',
      baseDef({
        name: 'status-loop',
        phases: [
          {
            id: 'plain',
            prompt: 'Create HELLO.txt with exactly: hello from aflt loop',
            eval: {
              command: ['grep', '-x', 'hello from aflt loop', 'HELLO.txt'],
              exitCode: 0,
            },
            maxFixAttempts: 0,
            onPass: 'none',
            force: true,
          },
        ],
      })
    );
    const result = await loop.runFromFile(
      file,
      runOpts({
        runPrompt: async () => {
          fs.writeFileSync(path.join(cwd, 'HELLO.txt'), 'hello from aflt loop\n');
          return { code: 0, timedOut: false };
        },
      })
    );
    assert.equal(result.ok, true, result.error || result.status);
    const report = loop.statusReport('status-loop');
    assert.equal(report.ok, true);
    assert.ok(Array.isArray(report.pipeline));
    assert.ok(Array.isArray(report.steps));
    assert.ok(report.budget);
    assert.equal(report.budget.runsUsed, 1);
    assert.ok(report.elapsedMs >= 0);
    assert.ok(report.steps.some((s) => s.id === 'develop' || s.id === 'evaluate'));
  });

  it('dashboard API: save, start, approve, and state.loops', async () => {
    const loop = require('../lib/loop');
    const dash = require('../lib/dashboard');

    const handle = dash.createDashboardServer({
      loopScheduler: false,
      sseIntervalMs: 60_000,
      registryPollMs: 60_000,
      captureTurns: false,
    });
    await new Promise((resolve) => handle.server.listen(0, '127.0.0.1', resolve));
    const port = handle.server.address().port;
    try {
      const state = JSON.parse((await httpRequest(port, '/api/state')).body);
      assert.ok(Array.isArray(state.views) && state.views.includes('loops'));
      assert.ok(state.loops && Array.isArray(state.loops.loops));
      const token = state.actions.actionToken;
      const headers = { 'x-aflt-action-token': token };

      const save = await httpRequest(port, '/api/loops', {
        method: 'POST',
        headers,
        body: { definition: baseDef({ name: 'api-m3' }) },
      });
      assert.equal(save.status, 200, save.body);
      const saved = JSON.parse(save.body);
      assert.equal(saved.ok, true);
      assert.ok(saved.path);

      const start = await httpRequest(port, '/api/loops/start', {
        method: 'POST',
        headers,
        body: { path: saved.path },
      });
      assert.equal(start.status, 200, start.body);

      // Run until gate waiting (inject via library with same home).
      const runResult = await loop.resumeLoop(
        'api-m3',
        runOpts({
          runPrompt: async () => {
            throw new Error('should wait at gate');
          },
        })
      );
      assert.equal(runResult.status, 'waiting', runResult.error || runResult.status);

      const detail = await httpRequest(port, '/api/loops/api-m3');
      assert.equal(detail.status, 200, detail.body);
      const body = JSON.parse(detail.body);
      assert.equal(body.status, 'waiting');
      assert.ok(body.pipeline);
      assert.ok(body.steps);

      const approve = await httpRequest(port, '/api/loops/api-m3/approve', {
        method: 'POST',
        headers,
        body: {},
      });
      assert.equal(approve.status, 200, approve.body);
      assert.equal(JSON.parse(approve.body).status, 'pending');

      const defs = await httpRequest(port, '/api/loops/definitions');
      assert.equal(defs.status, 200);
      assert.ok(JSON.parse(defs.body).definitions.some((d) => d.name === 'api-m3'));

      // Refuse start from path outside allowed roots.
      const evil = writeLoopFile(cwd, 'evil.json', baseDef({ name: 'evil' }));
      const denied = await httpRequest(port, '/api/loops/start', {
        method: 'POST',
        headers,
        body: { path: evil },
      });
      assert.equal(denied.status, 403, denied.body);
    } finally {
      await handle.close();
    }
  });

  it('pure UI helpers render loop list, pipeline, and detail', () => {
    const ui = require('../templates/dashboard/dashboard.js');
    assert.equal(ui.formatLoopElapsed(0), '—');
    assert.match(ui.formatLoopElapsed(65_000), /1m/);
    assert.match(
      ui.formatLoopBudget({ maxRuns: 10, runsUsed: 3, maxHours: 2, hoursUsed: 0.4 }),
      /3\/10 runs/
    );
    assert.equal(ui.loopStatusClass('waiting'), 'waiting');

    const list = ui.renderLoopsListHtml(
      [
        {
          name: 'demo',
          status: 'waiting',
          phaseId: 'gated',
          attempt: 0,
          elapsedMs: 1200,
          budget: { maxRuns: 5, runsUsed: 0 },
        },
      ],
      'demo'
    );
    assert.match(list, /data-loop-name="demo"/);
    assert.match(list, /waiting/);
    assert.match(list, /active/);

    const pipe = ui.renderLoopStepPipeline([
      { id: 'plan', label: 'plan', done: true },
      { id: 'develop', label: 'develop', done: true },
      { id: 'evaluate', label: 'evaluate', active: true },
      { id: 'revise', label: 'revise' },
      { id: 'approve', label: 'approve' },
      { id: 'next', label: 'next' },
    ]);
    assert.match(pipe, /evaluate/);
    assert.match(pipe, /aria-current="step"/);

    const detail = ui.renderLoopDetailHtml({
      name: 'demo',
      status: 'waiting',
      phaseId: 'gated',
      attempt: 0,
      step: 'gate',
      elapsedMs: 5000,
      budget: { maxRuns: 5, runsUsed: 0, maxHours: 1, hoursUsed: 0 },
      usage: { totalTokens: 1200, turnCount: 2, accuracy: 'reported' },
      loopRootSessionId: 'root-1',
      loopRootSessionTitle: 'loop-demo',
      gate: { phaseId: 'gated', waiting: true },
      steps: [
        { id: 'develop', label: 'develop', done: true },
        { id: 'approve', label: 'approve', active: true },
        { id: 'next', label: 'next' },
      ],
      pipeline: [
        {
          id: 'gated',
          status: 'running',
          current: true,
          gate: 'approve',
          sessionId: 'sess-1',
          sessionTitle: 'loop-demo',
          evalScore: 88.5,
          lastEval: { text: 'fail output', code: 1 },
        },
      ],
      currentEval: { text: 'fail output' },
    });
    assert.match(detail, /data-loop-action="approve"/);
    assert.match(detail, /data-session-id="sess-1"/);
    assert.match(detail, /fail output/);
    assert.match(detail, /Phase tree/);
    assert.match(detail, /88\.5/);
    assert.match(detail, /1\.2k tok|1200 tok|Tokens/);
    assert.equal(typeof ui.formatLoopUsage, 'function');
    assert.equal(typeof ui.renderLoopPhaseTree, 'function');
  });
});
