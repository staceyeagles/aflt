'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const loopVerify = require('../lib/loop-verify');
const commitGate = require('../lib/commit-gate');

describe('loop-verify helpers', () => {
  it('isPortBlocked respects reserved ports', () => {
    assert.equal(loopVerify.isPortBlocked(8787), true);
    assert.equal(loopVerify.isPortBlocked(8792), true);
    assert.equal(loopVerify.isPortBlocked(8810), true);
    assert.equal(loopVerify.isPortBlocked(8790), false);
  });

  it('normalizeVerify accepts tier shapes', () => {
    const ok = loopVerify.normalizeVerify({
      tier1: ['npm', 'test'],
      tier2: { loop: 'examples/loops/hello-eval.json', timeoutSec: 60 },
      tier3: { tileDungeon: true, trials: 2 },
      dashboard: { routes: ['/api/state'] },
    });
    assert.equal(ok.ok, true);
    assert.deepEqual(ok.value.tier1.command, ['npm', 'test']);
    assert.equal(ok.value.tier2.loop, 'examples/loops/hello-eval.json');
    assert.equal(ok.value.tier3.trials, 2);
  });

  it('tier ordering stops at first failure', async () => {
    const calls = [];
    const phaseState = { verification: [] };
    const r = await loopVerify.runAfterEvalVerify({
      state: { verifyCheckpoints: {} },
      definition: {
        name: 'x',
        cwd: process.cwd(),
        verify: { tier1: ['false'], tier2: { loop: 'a.json', timeoutSec: 1 } },
      },
      phase: {},
      phaseState,
      recordVerification: (e) => commitGate.recordVerification(phaseState, e),
      saveState: () => {},
      env: process.env,
      runCommand: async () => ({ code: 1, stdout: '', stderr: 'fail' }),
      tierRunners: {
        tier1: async (spec, ctx) => {
          calls.push('tier1');
          return { ok: false, summary: 'tier1 red' };
        },
        tier2: async () => {
          calls.push('tier2');
          return { ok: true, summary: 'tier2 ok' };
        },
        tier3: async () => ({ ok: true, summary: 'tier3 ok' }),
      },
    });
    assert.equal(r.ok, false);
    assert.deepEqual(calls, ['tier1']);
    assert.equal(phaseState.verification.filter((v) => v.tier === 'tier2').length, 0);
  });

  it('mergeVerify honors explicit null to skip inherited tiers', () => {
    const merged = loopVerify.mergeVerify(
      {
        tier1: { command: ['npm', 'test'] },
        tier2: { loop: 'x.json' },
        tier3: { tileDungeon: true, trials: 2 },
      },
      { tier3: null }
    );
    assert.ok(merged.tier1);
    assert.ok(merged.tier2);
    assert.equal(merged.tier3, null);
    const onlyT3 = loopVerify.mergeVerify(
      {
        tier1: { command: ['npm', 'test'] },
        tier2: { loop: 'x.json' },
        tier3: { tileDungeon: true, trials: 2 },
      },
      { tier1: null, tier2: null, tier3: { tileDungeon: true, trials: 1 } }
    );
    assert.equal(onlyT3.tier1, null);
    assert.equal(onlyT3.tier2, null);
    assert.equal(onlyT3.tier3.trials, 1);
  });

  it('checkpoint skip on resume for same SHA', async () => {
    const sha = 'abc123def456789012345678901234567890';
    const state = {
      verifyCheckpoints: {
        [sha]: { tiers: { tier1: { ok: true, summary: 'cached green' } } },
      },
    };
    const phaseState = { verification: [] };
    let ran = false;
    const r = await loopVerify.runAfterEvalVerify({
      state,
      definition: {
        name: 'x',
        cwd: '/tmp',
        verify: { tier1: ['npm', 'test'] },
      },
      phase: {},
      phaseState,
      recordVerification: (e) => commitGate.recordVerification(phaseState, e),
      saveState: () => {},
      env: process.env,
      headSha: () => sha,
      runCommand: async () => {
        ran = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(ran, false);
    assert.match(
      phaseState.verification.find((v) => v.tier === 'tier1').summary,
      /checkpoint/
    );
  });
});

describe('dashboard checker', () => {
  let tiny;
  let port;

  before(() => {
    tiny = http.createServer((req, res) => {
      if (req.url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ sessions: [], projects: [], loops: { ok: true, loops: [] } }));
        return;
      }
      if (req.url === '/api/loops') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, loops: [] }));
        return;
      }
      if (req.url === '/api/loops/definitions') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ definitions: [] }));
        return;
      }
      if (req.url === '/api/loops/demo') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: 'demo', status: 'running', phases: [{ id: 'a' }] }));
        return;
      }
      if (req.url === '/') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<html><body>ok</body></html>');
        return;
      }
      res.writeHead(404);
      res.end('missing');
    });
  });

  after(() => {
    if (tiny) tiny.close();
  });

  it('passes on healthy tiny server', async () => {
    await new Promise((resolve) => tiny.listen(0, '127.0.0.1', resolve));
    port = tiny.address().port;
    const r = await loopVerify.runDashboardUiCheck({ port, loopName: 'demo' });
    assert.equal(r.ok, true);
  });

  it('fails when loop detail missing', async () => {
    const r = await loopVerify.runDashboardUiCheck({
      port,
      loopName: 'missing',
      dashboard: { routes: [{ method: 'GET', path: '/api/loops/:name', shape: 'loopDetail' }] },
    });
    assert.equal(r.ok, false);
  });
});