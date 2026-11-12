'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('registry critical vs cosmetic writes', () => {
  let home;
  let stubDir;
  let stubCursor;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-regwrite-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  echo "deadbeef-1111-4111-8111-ffffffffffff"
  exit 0
fi
echo "ok-from-stub"
exit 0
`,
      { mode: 0o755 }
    );
  });

  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-regwrite-home-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function env(extra = {}) {
    return {
      ...process.env,
      NODE_ENV: 'test',
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: env(extra),
    });
  }

  it('criticalUpdate / bestEffortUpdate helpers', () => {
    process.env.AGENTFLEET_HOME = home;
    process.env.NODE_ENV = 'test';
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    const reg = require('../lib/registry');
    const s = reg.add({
      title: 'Helper',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
    });
    const ok = reg.criticalUpdate(s.id, { workerStatus: 'running', runId: 'r1' });
    assert.equal(ok.ok, true);
    assert.equal(ok.session.workerStatus, 'running');

    process.env.AGENTFLEET_TEST_FAIL_WRITE = 'critical';
    const bad = reg.criticalUpdate(s.id, { workerStatus: 'failed' }, { phase: 'after-exit' });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /injected/);
    delete process.env.AGENTFLEET_TEST_FAIL_WRITE;

    process.env.AGENTFLEET_TEST_FAIL_WRITE = 'cosmetic';
    const cos = reg.bestEffortUpdate(s.id, { lastUsed: new Date().toISOString() });
    assert.equal(cos.ok, false);
    delete process.env.AGENTFLEET_TEST_FAIL_WRITE;
    assert.equal(reg.REGISTRY_WRITE_EXIT, 75);
  });

  it('before-launch critical failure aborts with nonzero', () => {
    const r = af(['run', 'AbortBefore', '--prompt', 'hi', '--cwd', home, '--json'], {
      AGENTFLEET_TEST_FAIL_WRITE: 'before-launch',
    });
    assert.notEqual(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.match(body.error, /critical registry write failed before launch/);
    const data = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'));
    const s = data.sessions.find((x) => x.title === 'AbortBefore');
    assert.ok(s);
    assert.equal(s.lastExit, null);
  });

  it('after-exit critical failure emits result, registryWriteError, exit 75', () => {
    delete require.cache[require.resolve('../lib/registry')];
    const reg = require('../lib/registry');
    const r = af(['run', 'AfterExit', '--prompt', 'hi', '--cwd', home, '--json'], {
      AGENTFLEET_TEST_FAIL_WRITE: 'after-exit',
    });
    assert.equal(r.status, reg.REGISTRY_WRITE_EXIT, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.ok(body.outputPath);
    assert.ok(body.registryWriteError);
    assert.match(r.stderr, /critical registry write failed after run/);
  });

  it('cosmetic failure warns but keeps exit 0', () => {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const reg = require('../lib/registry');
    const READY = 'video-production-readiness-herdr-a1679d';
    reg.add({
      title: 'Cosme',
      chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      id: READY,
      herdr: { runtime: 'exited', checkedAt: '2026-11-01T00:00:00.000Z' },
    });

    const READY_JSON = JSON.stringify({
      terminals: [
        {
          address: 't6',
          name: 'cosme',
          state: 'finished',
          exit_code: 0,
          reason: 'exited',
          labels: { af_id: READY },
        },
      ],
      hidden_finished: 0,
    });
    fs.writeFileSync(
      path.join(stubDir, 'hc'),
      `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(READY_JSON)});\nprocess.exit(0);\n`,
      { mode: 0o755 }
    );

    const r = af(['sync'], { AGENTFLEET_TEST_FAIL_WRITE: 'cosmetic' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stderr, /cosmetic registry write failed/);
  });
});
