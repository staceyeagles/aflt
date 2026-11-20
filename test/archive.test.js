'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('aflt archive / unarchive', () => {
  let home;
  let stubDir;
  let stubHc;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-archive-stub-'));
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
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-archive-home-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function afEnv(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_HC_BIN: stubHc,
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
    delete require.cache[require.resolve('../lib/archive')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function seedPair() {
    const registry = loadRegistry();
    const parent = registry.add({
      title: 'ArchMaster',
      chatId: 'aaaaaaaa-1111-4111-8111-111111111111',
      cwd: home,
      project: 'archproj',
      role: 'master',
      status: 'active',
    });
    const child = registry.add({
      title: 'ArchChild',
      chatId: 'bbbbbbbb-2222-4222-8222-222222222222',
      cwd: home,
      project: 'archproj',
      parent: parent.id,
      role: 'worker',
      status: 'done',
      workerStatus: 'done',
    });
    const runDir = path.join(home, 'runs', child.id);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runDir, 'log.txt'), 'kept\n', 'utf8');
    return { parent: loadRegistry().find(parent.id), child: loadRegistry().find(child.id) };
  }

  it('archives and unarchives without touching status or run logs', () => {
    const { child } = seedPair();
    const beforeStatus = child.status;
    const r = af(['archive', child.title, '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.archived.length, 1);
    const archived = loadRegistry().find(child.id);
    assert.equal(archived.archived, true);
    assert.ok(archived.archivedAt);
    assert.equal(archived.status, beforeStatus);
    assert.ok(fs.existsSync(path.join(home, 'runs', child.id, 'log.txt')));

    const lsHidden = af(['ls', '--json', '--all']);
    assert.equal(lsHidden.status, 0, lsHidden.stderr);
    const hidden = JSON.parse(lsHidden.stdout).sessions;
    // --all includes archived
    assert.ok(hidden.some((s) => s.id === child.id && s.archived === true));

    const lsDefault = af(['ls', '--json', '--status', 'done']);
    assert.equal(lsDefault.status, 0, lsDefault.stderr);
    const def = JSON.parse(lsDefault.stdout).sessions;
    assert.ok(!def.some((s) => s.id === child.id));

    const withArchived = af(['ls', '--json', '--archived', '--all']);
    assert.equal(withArchived.status, 0, withArchived.stderr);
    assert.ok(JSON.parse(withArchived.stdout).sessions.some((s) => s.id === child.id && s.archived));

    const u = af(['unarchive', child.id, '--json']);
    assert.equal(u.status, 0, u.stderr + u.stdout);
    const after = loadRegistry().find(child.id);
    assert.equal(after.archived, false);
    assert.equal(after.archivedAt, null);
    assert.equal(after.status, beforeStatus);
  });

  it('--with-children archives descendants; children links stay consistent on delete', () => {
    const { parent, child } = seedPair();
    const r = af(['archive', parent.title, '--with-children', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.ok(body.archived.length >= 2);
    assert.equal(loadRegistry().find(parent.id).archived, true);
    assert.equal(loadRegistry().find(child.id).archived, true);

    af(['unarchive', parent.id, '--with-children']);
    const grand = loadRegistry().add({
      title: 'ArchGrand',
      chatId: 'cccccccc-3333-4333-8333-333333333333',
      cwd: home,
      parent: child.id,
      status: 'done',
    });
    // Delete child → grandchild parent cleared
    const rm = af(['rm', child.id, '--keep-files']);
    assert.equal(rm.status, 0, rm.stderr);
    assert.ok(!loadRegistry().find(child.id));
    const orphan = loadRegistry().find(grand.id);
    assert.equal(orphan.parent, null);
    assert.ok(loadRegistry().find(parent.id));
  });

  it('refuses archive of live runPid unless --force', () => {
    const { child } = seedPair();
    loadRegistry().update(child.id, {
      workerStatus: 'running',
      runPid: process.pid,
      runPgid: process.pid,
      runHost: os.hostname(),
      status: 'active',
    });
    const denied = af(['archive', child.title]);
    assert.equal(denied.status, 1);
    assert.ok(/running/i.test(denied.stderr), denied.stderr);
    assert.equal(loadRegistry().find(child.id).archived, false);

    const forced = af(['archive', child.title, '--force', '--json']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.equal(loadRegistry().find(child.id).archived, true);
  });

  it('sessionBusyForMutation treats herdr working/blocked as busy', () => {
    process.env.AGENTFLEET_HOME = home;
    delete require.cache[require.resolve('../lib/archive')];
    const archive = require('../lib/archive');
    const session = { id: 'x', title: 'x', runPid: null };
    assert.equal(archive.sessionBusyForMutation(session).busy, false);
    assert.equal(
      archive.sessionBusyForMutation(session, { enrichment: { status: 'working' } }).reason,
      'running'
    );
    assert.equal(
      archive.sessionBusyForMutation(session, { enrichment: { status: 'blocked' } }).reason,
      'waiting'
    );
    assert.equal(
      archive.sessionBusyForMutation(session, { enrichment: { status: 'idle', runtime: 'running' } })
        .busy,
      false
    );
  });
});
