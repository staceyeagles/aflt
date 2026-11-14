'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('orphan runPid handoff reconcile via CLI', () => {
  let home;
  let project;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-recon-cli-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'af-recon-proj-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFLEET_HOME: home,
        HOME: home,
        AGENTFLEET_SESSION: '',
        AGENTFLEET_ID: '',
        ...extra,
      },
    });
  }

  it('af children reports done + handoff when dead pid has fresh worker handoff', () => {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    const master = registry.add({
      title: 'ReconMaster',
      chatId: 'cccccccc-bbbb-cccc-dddd-eeeeeeee0001',
      cwd: project,
      engine: 'cursor',
      role: 'master',
      status: 'active',
    });
    const worker = registry.add({
      title: 'ReconMaster-w1',
      chatId: 'cccccccc-bbbb-cccc-dddd-eeeeeeee0002',
      cwd: project,
      engine: 'cursor',
      role: 'worker',
      parent: master.id,
      status: 'active',
      workerStatus: 'running',
      runPid: 424242,
      runHost: os.hostname(),
      lastExit: null,
      stopRequested: false,
      runStartedAt: new Date(Date.now() - 120_000).toISOString(),
    });
    const resultPath = worker.result;
    fs.mkdirSync(path.dirname(resultPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(resultPath, '## Summary\nok from orphaned engine\n');
    const now = new Date();
    fs.utimesSync(resultPath, now, now);

    const r = af(['children', master.title, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workerStatus, 'done');
    assert.equal(rows[0].stateSource, 'handoff');

    // Persist best-effort
    const refreshed = registry.find(worker.id);
    assert.equal(refreshed.workerStatus, 'done');
    assert.equal(refreshed.runPid, null);
    assert.equal(refreshed.resultSource, 'worker');
  });

  it('help/usage mentions --detach and messaging flags', () => {
    const help = af(['help']);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /--detach/);
    assert.match(help.stdout, /--messaging/);

    const spawnUsage = af(['spawn']);
    assert.equal(spawnUsage.status, 1);
    assert.match(spawnUsage.stderr, /--detach/);
    assert.match(spawnUsage.stderr, /--messaging/);

    const masterUsage = af(['master']);
    assert.equal(masterUsage.status, 1);
    assert.match(masterUsage.stderr, /--messaging/);

    const runUsage = af(['run']);
    assert.equal(runUsage.status, 1);
    assert.match(runUsage.stderr, /--messaging/);
  });
});
