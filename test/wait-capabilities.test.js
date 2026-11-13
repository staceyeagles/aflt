'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const orchestrate = require('../lib/orchestrate');

describe('wait inconclusive agent state + capabilities helpers', () => {
  it('waitOutcomeMeta: running + null agent state is inconclusive', () => {
    const meta = orchestrate.waitOutcomeMeta(
      { workerStatus: 'running' },
      { runtime: 'running', agentState: null, derivedStatus: 'running' }
    );
    assert.equal(meta.stateSource, 'none');
    assert.equal(meta.conclusive, false);
    assert.equal(meta.outcome, 'running');
  });

  it('waitOutcomeMeta: exited is conclusive', () => {
    const meta = orchestrate.waitOutcomeMeta(
      { workerStatus: 'done', lastExit: 0 },
      { runtime: 'exited', exitCode: 0, agentState: null, derivedStatus: 'done' }
    );
    assert.equal(meta.stateSource, 'exit');
    assert.equal(meta.conclusive, true);
  });

  let home;
  let stubDir;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-waitcap-stub-'));
    fs.writeFileSync(
      path.join(stubDir, 'cursor-agent'),
      '#!/usr/bin/env bash\necho ok\nexit 0\n',
      { mode: 0o755 }
    );
  });
  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-waitcap-home-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function seedWorker(statusJson) {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    const parent = registry.add({
      title: 'WaitCapM',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      role: 'master',
    });
    const w = registry.add({
      title: 'WaitCap-w1',
      chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      role: 'worker',
      parent: parent.id,
      workerStatus: 'running',
    });
    fs.writeFileSync(
      path.join(stubDir, 'hc'),
      `#!/usr/bin/env node
const cmd = process.argv[2];
const payload = ${JSON.stringify(statusJson)};
if (cmd === 'ls') {
  process.stdout.write(JSON.stringify({
    terminals: [{
      address: 't1', name: 'waitcap-w1', state: 'live',
      labels: { af_id: ${JSON.stringify('__ID__')} },
      status: payload.status,
    }],
    hidden_finished: 0,
  }).replace('__ID__', ${JSON.stringify('PLACEHOLDER')}));
}
`.replace('PLACEHOLDER', 'willfix'),
      { mode: 0o755 }
    );
    // rewrite hc properly with worker id
    fs.writeFileSync(
      path.join(stubDir, 'hc'),
      `#!/usr/bin/env node
const fs = require('fs');
const cmd = process.argv[2];
const id = ${JSON.stringify(w.id)};
const status = ${JSON.stringify(statusJson.status)};
if (cmd === 'ls' || cmd === 'get') {
  const term = {
    address: 't1', name: 'waitcap-w1', state: 'live', agent: 'env',
    labels: { af_id: id },
    status,
  };
  process.stdout.write(JSON.stringify(cmd === 'ls' ? { terminals: [term], hidden_finished: 0 } : term));
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 }
    );
    return w;
  }

  function af(args) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFLEET_HOME: home,
        AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
        AGENTFLEET_HC_BIN: path.join(stubDir, 'hc'),
        PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
  }

  it('af wait: live + null status stays running, stateSource none, exit 2 on timeout', () => {
    seedWorker({ status: null });
    const r = af([
      'wait',
      'WaitCap-w1',
      '--interval',
      '0.05',
      '--timeout',
      '0.3',
      '--json',
    ]);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].workerStatus, 'running');
    assert.equal(rows[0].stateSource, 'none');
    assert.equal(rows[0].conclusive, false);
    assert.match(r.stderr, /no agent state from Herdr/);
  });

  it('af wait: live + done status → waiting conclusive', () => {
    seedWorker({ status: { state: 'done' } });
    const r = af([
      'wait',
      'WaitCap-w1',
      '--interval',
      '0.05',
      '--timeout',
      '2',
      '--json',
    ]);
    assert.equal(r.status, 3, r.stderr + r.stdout);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].workerStatus, 'waiting');
    assert.equal(rows[0].stateSource, 'herdr');
  });
});
