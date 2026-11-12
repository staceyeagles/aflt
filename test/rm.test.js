'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('af rm cleanup', () => {
  let home;
  let stubDir;
  let stubHc;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rm-stub-'));
    stubHc = path.join(stubDir, 'hc');
    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  ls) echo '{"terminals":[],"hidden_finished":0,"machines":[]}'; exit 0 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rm-home-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function afEnv(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: afEnv(extraEnv),
      timeout: 15000,
    });
  }

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function seedWorker(title = 'RmW1') {
    const registry = loadRegistry();
    const parent = registry.add({
      title: 'RmMaster',
      chatId: 'aaaaaaaa-1111-4111-8111-111111111111',
      cwd: home,
      role: 'master',
      status: 'active',
    });
    const w = registry.add({
      title,
      chatId: 'bbbbbbbb-2222-4222-8222-222222222222',
      cwd: home,
      parent: parent.id,
      role: 'worker',
      task: 't',
      workerStatus: 'done',
    });
    fs.mkdirSync(path.dirname(w.result), { recursive: true, mode: 0o700 });
    fs.writeFileSync(w.result, '## Summary\nok\n', 'utf8');
    const runDir = path.join(home, 'runs', w.id);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runDir, 'log.txt'), 'log\n', 'utf8');
    return { registry: loadRegistry(), parent, worker: loadRegistry().find(w.id) };
  }

  it('removes result file and runs/<id>/ dir', () => {
    const { worker } = seedWorker();
    assert.ok(fs.existsSync(worker.result));
    assert.ok(fs.existsSync(path.join(home, 'runs', worker.id)));
    const r = af(['rm', worker.title]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!loadRegistry().find(worker.id));
    assert.ok(!fs.existsSync(worker.result));
    assert.ok(!fs.existsSync(path.join(home, 'runs', worker.id)));
  });

  it('--keep-files leaves files, removes registry row', () => {
    const { worker } = seedWorker('KeepW');
    const r = af(['rm', 'KeepW', '--keep-files']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!loadRegistry().find('KeepW'));
    assert.ok(fs.existsSync(worker.result));
    assert.ok(fs.existsSync(path.join(home, 'runs', worker.id)));
  });

  it('--dry-run lists actions and changes nothing', () => {
    const { worker } = seedWorker('DryW');
    const r = af(['rm', 'DryW', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/\[dry-run\]/.test(r.stdout), r.stdout);
    assert.ok(loadRegistry().find('DryW'));
    assert.ok(fs.existsSync(worker.result));
  });

  it('--children removes workers; --with-master removes master too', () => {
    const { parent, worker } = seedWorker('ChildW');
    const registry = loadRegistry();
    const planPath = parent.plan || path.join(home, 'plans', `${parent.id}.md`);
    registry.update(parent.id, { plan: planPath });
    fs.mkdirSync(path.dirname(planPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(planPath, '# plan\n', 'utf8');

    const kidsOnly = af(['rm', '--children', parent.title, '--dry-run']);
    assert.equal(kidsOnly.status, 0, kidsOnly.stderr);
    assert.ok(kidsOnly.stdout.includes('ChildW'));
    assert.ok(!kidsOnly.stdout.includes(`would remove session ${parent.title}`));

    const r = af(['rm', '--children', parent.title, '--with-master']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!loadRegistry().find(worker.id));
    assert.ok(!loadRegistry().find(parent.id));
    assert.ok(!fs.existsSync(worker.result));
    assert.ok(!fs.existsSync(planPath));
  });

  it('refuses running headless worker unless --force', () => {
    const { worker } = seedWorker('RunW');
    loadRegistry().update(worker.id, {
      workerStatus: 'running',
      runPid: process.pid,
      runPgid: process.pid,
      runHost: os.hostname(),
    });
    const denied = af(['rm', 'RunW']);
    assert.equal(denied.status, 1);
    assert.ok(/running/i.test(denied.stderr), denied.stderr);
    assert.ok(/af stop/i.test(denied.stderr), denied.stderr);
    assert.ok(loadRegistry().find('RunW'));

    const forced = af(['rm', 'RunW', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(!loadRegistry().find('RunW'));
  });

  it('skips result paths outside $AGENTFLEET_HOME/results', () => {
    const { worker } = seedWorker('OutW');
    const outside = path.join(os.tmpdir(), `af-rm-outside-${process.pid}.md`);
    fs.writeFileSync(outside, 'keep me\n', 'utf8');
    loadRegistry().update(worker.id, { result: outside });
    const r = af(['rm', 'OutW']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/skip/i.test(r.stderr), r.stderr);
    assert.ok(fs.existsSync(outside));
    fs.unlinkSync(outside);
  });
});
