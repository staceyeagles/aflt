'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

/**
 * Async spawn so the parent event loop can still serve an in-process
 * capture HTTP server (spawnSync would deadlock the webhook POST).
 */
function spawnAfAsync(args, env, timeoutMs = 10000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [afJs, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c.toString('utf8');
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString('utf8');
    });
    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch (_) {
        /* ignore */
      }
      resolve({ status: null, stdout, stderr, timedOut: true });
    }, timeoutMs);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ status: code, stdout, stderr, timedOut: false });
    });
  });
}

function clearNotifyMods() {
  for (const m of [
    '../lib/notify',
    '../lib/config',
    '../lib/memory',
    '../lib/project',
    '../lib/registry',
    '../lib/turns',
    '../lib/messages',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function writeConfig(home, data) {
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(data, null, 2) + '\n');
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
      hits.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body,
        raw,
      });
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
        port: addr.port,
        url: `http://127.0.0.1:${addr.port}/hook`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('lib/notify', () => {
  let home;
  let prevHome;
  let prevAfHome;
  let prevUrl;
  let prevKey;
  let prevHeader;
  let capture;

  beforeEach(async () => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-notify-'));
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevUrl = process.env.AFLT_NOTIFY_URL;
    prevKey = process.env.AFLT_NOTIFY_KEY;
    prevHeader = process.env.AFLT_NOTIFY_HEADER;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    delete process.env.AFLT_NOTIFY_URL;
    delete process.env.AFLT_NOTIFY_KEY;
    delete process.env.AFLT_NOTIFY_HEADER;
    clearNotifyMods();
    capture = await startCaptureServer();
  });

  afterEach(async () => {
    if (capture) await capture.close();
    clearNotifyMods();
    fs.rmSync(home, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevUrl === undefined) delete process.env.AFLT_NOTIFY_URL;
    else process.env.AFLT_NOTIFY_URL = prevUrl;
    if (prevKey === undefined) delete process.env.AFLT_NOTIFY_KEY;
    else process.env.AFLT_NOTIFY_KEY = prevKey;
    if (prevHeader === undefined) delete process.env.AFLT_NOTIFY_HEADER;
    else process.env.AFLT_NOTIFY_HEADER = prevHeader;
  });

  it('is off unless url configured', () => {
    const notify = require('../lib/notify');
    const cfg = notify.resolveNotifyConfig(process.env);
    assert.equal(cfg.enabled, false);
    const r = notify.notifyRunFinished(
      { id: 's1', title: 't', engine: 'cursor', cwd: home },
      { exitStatus: 0, summary: 'hi' }
    );
    assert.equal(r.skipped, true);
    assert.equal(capture.hits.length, 0);
  });

  it('resolves config.json notify and env overrides', () => {
    writeConfig(home, {
      notify: {
        url: 'http://127.0.0.1:9/from-config',
        key: 'cfg-secret',
        header: 'X-Api-Key',
      },
    });
    clearNotifyMods();
    const notify = require('../lib/notify');
    const fromCfg = notify.resolveNotifyConfig({ ...process.env });
    assert.equal(fromCfg.enabled, true);
    assert.equal(fromCfg.url, 'http://127.0.0.1:9/from-config');
    assert.equal(fromCfg.key, 'cfg-secret');
    assert.equal(fromCfg.headerName, 'X-Api-Key');
    assert.equal(fromCfg.source.url, 'config');

    const fromEnv = notify.resolveNotifyConfig({
      ...process.env,
      AFLT_NOTIFY_URL: capture.url,
      AFLT_NOTIFY_KEY: 'env-secret',
      AFLT_NOTIFY_HEADER: 'Authorization',
    });
    assert.equal(fromEnv.url, capture.url);
    assert.equal(fromEnv.key, 'env-secret');
    assert.equal(fromEnv.headerName, 'Authorization');
    assert.equal(fromEnv.source.url, 'env');
    assert.equal(fromEnv.source.key, 'env');
  });

  it('POSTs run.completed / run.failed with Bearer header and redacted summary', async () => {
    const notify = require('../lib/notify');
    const session = {
      id: 'run-1',
      title: 'Headless',
      project: 'demo',
      engine: 'cursor',
      cwd: path.join(home, 'src'),
    };
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz012345';
    const cfg = {
      enabled: true,
      url: capture.url,
      key: 'test-key',
      headerName: 'Authorization',
      timeoutMs: 2000,
    };

    const ok = notify.notifyRunFinished(session, {
      config: cfg,
      exitStatus: 0,
      summary: `done token=${secret} at 10.0.0.5`,
      unref: false,
    });
    assert.equal(ok.event, 'run.completed');
    await ok.promise;
    assert.equal(capture.hits.length, 1);
    const hit = capture.hits[0];
    assert.equal(hit.method, 'POST');
    assert.equal(hit.headers.authorization, 'Bearer test-key');
    assert.equal(hit.body.event, 'run.completed');
    assert.equal(hit.body.sessionId, 'run-1');
    assert.equal(hit.body.title, 'Headless');
    assert.equal(hit.body.project, 'demo');
    assert.equal(hit.body.engine, 'cursor');
    assert.equal(hit.body.exitStatus, 0);
    assert.ok(hit.body.timestamp);
    assert.match(hit.body.summary, /\[redacted\]/);
    assert.doesNotMatch(hit.body.summary, /sk-abcdefghijklmnopqrstuvwxyz012345/);
    assert.doesNotMatch(JSON.stringify(hit.body), /test-key/);

    const fail = notify.notifyRunFinished(session, {
      config: cfg,
      exitStatus: 2,
      summary: 'boom',
      unref: false,
    });
    assert.equal(fail.event, 'run.failed');
    await fail.promise;
    assert.equal(capture.hits.length, 2);
    assert.equal(capture.hits[1].body.event, 'run.failed');
    assert.equal(capture.hits[1].body.exitStatus, 2);
  });

  it('supports custom header name without Bearer prefix', async () => {
    const notify = require('../lib/notify');
    const r = notify.notifyRunFinished(
      { id: 'x', title: 't', engine: 'copilot', cwd: home, project: 'p' },
      {
        config: {
          enabled: true,
          url: capture.url,
          key: 'raw-secret',
          headerName: 'X-Webhook-Key',
          timeoutMs: 2000,
        },
        exitStatus: 0,
        summary: 'ok',
        unref: false,
      }
    );
    await r.promise;
    assert.equal(capture.hits[0].headers['x-webhook-key'], 'raw-secret');
    assert.equal(capture.hits[0].headers.authorization, undefined);
  });

  it('turn.captured posts from emitTurnCaptured when configured', async () => {
    process.env.AFLT_NOTIFY_URL = capture.url;
    process.env.AFLT_NOTIFY_KEY = 'turn-key';
    clearNotifyMods();
    const registry = require('../lib/registry');
    const turns = require('../lib/turns');
    const session = registry.add({
      title: 'interactive',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001',
      cwd: home,
      engine: 'copilot',
      status: 'active',
      project: 'demo',
    });
    turns.emitTurnCaptured(
      {
        sessionId: session.id,
        turnId: 't1',
        prompt: 'say hi key=supersecretvalue',
        reply: 'hello from 192.168.1.9',
        capturedAt: '2026-01-02T03:04:05.000Z',
      },
      { project: 'demo' }
    );
    // Wait briefly for fire-and-forget
    const deadline = Date.now() + 3000;
    while (capture.hits.length < 1 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.equal(capture.hits.length, 1, 'expected webhook hit');
    const body = capture.hits[0].body;
    assert.equal(body.event, 'turn.captured');
    assert.equal(body.sessionId, session.id);
    assert.equal(body.title, 'interactive');
    assert.equal(body.project, 'demo');
    assert.equal(body.exitStatus, null);
    assert.match(body.summary, /prompt:/);
    assert.match(body.summary, /\[redacted\]/);
    assert.doesNotMatch(body.summary, /supersecretvalue/);
    assert.equal(capture.hits[0].headers.authorization, 'Bearer turn-key');
  });

  it('webhook failures are logged and do not throw', async () => {
    const notify = require('../lib/notify');
    const r = notify.notifyRunFinished(
      { id: 's', title: 't', engine: 'cursor', cwd: home },
      {
        config: {
          enabled: true,
          url: 'http://127.0.0.1:1/nope',
          key: null,
          headerName: 'Authorization',
          timeoutMs: 300,
        },
        exitStatus: 1,
        summary: 'x',
        unref: false,
      }
    );
    assert.equal(r.queued, true);
    const result = await r.promise;
    assert.equal(result.ok, false);
  });

  it('doctorStatus never includes the key', () => {
    writeConfig(home, {
      notify: { url: capture.url, key: 'should-not-appear', header: 'Authorization' },
    });
    clearNotifyMods();
    const notify = require('../lib/notify');
    const st = notify.doctorStatus(process.env);
    assert.equal(st.ok, true);
    assert.equal(st.configured, true);
    assert.match(st.detail, /key=set/);
    assert.doesNotMatch(st.detail, /should-not-appear/);
    assert.match(st.detail, /header=Authorization/);
  });

  it('aflt notify test posts a sample event', async () => {
    // Must use async spawn: spawnSync blocks the event loop and the in-process
    // capture server cannot answer the child's webhook POST (deadlock → timeout).
    const r = await spawnAfAsync(
      ['notify', 'test', '--json'],
      {
        ...process.env,
        AGENTFLEET_HOME: home,
        HOME: home,
        AFLT_NOTIFY_URL: capture.url,
        AFLT_NOTIFY_KEY: 'cli-key',
      },
      10000
    );
    assert.equal(r.timedOut, false, 'notify test should not hang');
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.event, 'run.completed');
    assert.equal(body.config.key, 'set');
    assert.doesNotMatch(r.stdout, /cli-key/);
    assert.equal(capture.hits.length, 1);
    assert.equal(capture.hits[0].headers.authorization, 'Bearer cli-key');
    assert.equal(capture.hits[0].body.sessionId, 'notify-test');
  });

  it('aflt doctor reports notify without printing the key', () => {
    writeConfig(home, {
      notify: { url: capture.url, key: 'doctor-secret-key' },
    });
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-notify-doc-'));
    try {
      fs.writeFileSync(
        path.join(stubDir, 'cursor-agent'),
        '#!/usr/bin/env bash\necho ok\nexit 0\n',
        { mode: 0o755 }
      );
      fs.writeFileSync(
        path.join(stubDir, 'hc'),
        `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === '--version' || cmd === 'version') {
  process.stdout.write('herdr-core 0.1.20\\n');
  process.exit(0);
}
if (cmd === 'server') { process.stdout.write('ok\\n'); process.exit(0); }
if (cmd === 'ls') {
  process.stdout.write(JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
process.exit(0);
`,
        { mode: 0o755 }
      );
      const r = spawnSync(process.execPath, [afJs, 'doctor', '--json'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTFLEET_HOME: home,
          HOME: home,
          AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
          AGENTFLEET_HC_BIN: path.join(stubDir, 'hc'),
          PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
        },
      });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const body = JSON.parse(r.stdout);
      const row = body.checks.find((c) => c.name === 'notify');
      assert.ok(row, JSON.stringify(body.checks));
      assert.equal(row.ok, true);
      assert.match(row.detail, /configured/);
      assert.match(row.detail, /key=set/);
      assert.doesNotMatch(row.detail, /doctor-secret-key/);
      assert.doesNotMatch(r.stdout, /doctor-secret-key/);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('aflt help documents notify', () => {
    const r = spawnSync(process.execPath, [afJs, 'help'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTFLEET_HOME: home, HOME: home },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /aflt notify test/);
    assert.match(r.stdout, /AFLT_NOTIFY_URL/);
    assert.match(r.stdout, /AFLT_NOTIFY_KEY/);
  });
});
