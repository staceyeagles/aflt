'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('aflt purge + orphans', () => {
  let home;
  let cursorHome;
  let copilotHome;
  let stubDir;
  let stubHc;
  let prevHome;
  let prevAfHome;
  let prevCursor;
  let prevCopilot;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-purge-stub-'));
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
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-purge-home-'));
    cursorHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-purge-cursor-'));
    copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-purge-copilot-'));
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevCursor = process.env.AGENTFLEET_CURSOR_HOME;
    prevCopilot = process.env.AGENTFLEET_COPILOT_HOME;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    process.env.AGENTFLEET_CURSOR_HOME = cursorHome;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cursorHome, { recursive: true, force: true });
    fs.rmSync(copilotHome, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevCursor === undefined) delete process.env.AGENTFLEET_CURSOR_HOME;
    else process.env.AGENTFLEET_CURSOR_HOME = prevCursor;
    if (prevCopilot === undefined) delete process.env.AGENTFLEET_COPILOT_HOME;
    else process.env.AGENTFLEET_COPILOT_HOME = prevCopilot;
    clearMods();
  });

  function clearMods() {
    for (const m of [
      '../lib/util',
      '../lib/registry',
      '../lib/orchestrate',
      '../lib/archive',
      '../lib/purge',
      '../lib/cursor',
      '../lib/copilot',
      '../lib/turns',
      '../lib/project',
      '../lib/resolve-session',
      '../lib/herdr',
    ]) {
      try {
        delete require.cache[require.resolve(m)];
      } catch (_) {
        /* ignore */
      }
    }
  }

  function afEnv(extra = {}) {
    return {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_HOME: cursorHome,
      AGENTFLEET_COPILOT_HOME: copilotHome,
      AGENTFLEET_HC_BIN: stubHc,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: afEnv(extraEnv),
      timeout: 20000,
    });
  }

  function loadRegistry() {
    clearMods();
    process.env.AGENTFLEET_HOME = home;
    process.env.HOME = home;
    process.env.AGENTFLEET_CURSOR_HOME = cursorHome;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    return require('../lib/registry');
  }

  function loadPurge() {
    clearMods();
    process.env.AGENTFLEET_HOME = home;
    process.env.HOME = home;
    process.env.AGENTFLEET_CURSOR_HOME = cursorHome;
    process.env.AGENTFLEET_COPILOT_HOME = copilotHome;
    return require('../lib/purge');
  }

  function seedCursorChat(cwd, chatId) {
    const cursor = require('../lib/cursor');
    const hash = cursor.workspaceHash(cwd);
    const dir = path.join(cursorHome, 'chats', hash, chatId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'store.db'), 'fake\n');
    return dir;
  }

  function seedCopilotSession(chatId) {
    const dir = path.join(copilotHome, 'session-state', chatId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspace.yaml'), 'cwd: ' + home + '\n');
    return dir;
  }

  it('purge dry-run lists paths and does not mutate', () => {
    const registry = loadRegistry();
    const chatId = '11111111-2222-4333-8444-555555555501';
    const session = registry.add({
      title: 'PurgeDry',
      chatId,
      cwd: home,
      engine: 'cursor',
      status: 'done',
      role: 'worker',
      parent: 'master-placeholder',
      task: 't',
      workerStatus: 'done',
    });
    const chatDir = seedCursorChat(home, chatId);
    const runDir = path.join(home, 'runs', session.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'log.txt'), 'x\n');
    fs.mkdirSync(path.dirname(session.result), { recursive: true });
    fs.writeFileSync(session.result, '## Summary\nok\n');

    const r = af(['purge', session.id, '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.apply, false);
    assert.ok(payload.results[0].results[0].pathResults.some((p) => /would-delete/.test(p.action)));

    assert.ok(fs.existsSync(chatDir));
    assert.ok(fs.existsSync(runDir));
    assert.ok(loadRegistry().findExact(session.id));
  });

  it('purge --apply removes registry, runs/, and cursor chat', () => {
    const registry = loadRegistry();
    const chatId = '11111111-2222-4333-8444-555555555502';
    const session = registry.add({
      title: 'PurgeApply',
      chatId,
      cwd: home,
      engine: 'cursor',
      status: 'done',
      role: 'worker',
      parent: 'master-placeholder',
      task: 't',
      workerStatus: 'done',
    });
    const chatDir = seedCursorChat(home, chatId);
    const runDir = path.join(home, 'runs', session.id);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(path.join(runDir, 'turns.jsonl'), '{}\n');
    fs.mkdirSync(path.dirname(session.result), { recursive: true });
    fs.writeFileSync(session.result, '## Summary\nok\n');

    const r = af(['purge', session.id, '--apply', '--yes', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.apply, true);
    assert.equal(payload.ok, true);

    assert.equal(fs.existsSync(chatDir), false);
    assert.equal(fs.existsSync(runDir), false);
    assert.equal(fs.existsSync(session.result), false);
    assert.equal(loadRegistry().findExact(session.id), null);
  });

  it('rm --purge is a synonym and keeps soft rm unchanged without --purge', () => {
    const registry = loadRegistry();
    const chatId = '11111111-2222-4333-8444-555555555503';
    const soft = registry.add({
      title: 'SoftRm',
      chatId: '11111111-2222-4333-8444-555555555504',
      cwd: home,
      engine: 'cursor',
      status: 'done',
      role: 'worker',
      parent: 'master-placeholder',
      task: 't',
      workerStatus: 'done',
    });
    const softRun = path.join(home, 'runs', soft.id);
    fs.mkdirSync(softRun, { recursive: true });
    fs.writeFileSync(path.join(softRun, 'log.txt'), 'keep\n');
    fs.mkdirSync(path.dirname(soft.result), { recursive: true });
    fs.writeFileSync(soft.result, 'r\n');

    const softRm = af(['rm', soft.id]);
    assert.equal(softRm.status, 0, softRm.stderr + softRm.stdout);
    assert.ok(fs.existsSync(softRun), 'soft rm keeps runs/');
    assert.equal(fs.existsSync(soft.result), false);

    const session = loadRegistry().add({
      title: 'RmPurge',
      chatId,
      cwd: home,
      engine: 'copilot',
      status: 'done',
    });
    const chatDir = seedCopilotSession(chatId);
    const runDir = path.join(home, 'runs', session.id);
    fs.mkdirSync(runDir, { recursive: true });

    const r = af(['rm', '--purge', session.id, '--apply', '--yes', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(fs.existsSync(chatDir), false);
    assert.equal(fs.existsSync(runDir), false);
    assert.equal(loadRegistry().findExact(session.id), null);
  });

  it('refuses busy sessions unless --force', () => {
    const registry = loadRegistry();
    const session = registry.add({
      title: 'BusyPurge',
      chatId: '11111111-2222-4333-8444-555555555505',
      cwd: home,
      engine: 'cursor',
      status: 'active',
      runPid: process.pid,
      runHost: os.hostname(),
    });
    const purge = loadPurge();
    const denied = purge.purgeSession(session, {
      apply: true,
      force: false,
      home,
      env: process.env,
      isAlive: () => true,
    });
    assert.equal(denied.ok, false);
    assert.match(denied.error, /running|busy|Stop/i);
    assert.ok(loadRegistry().findExact(session.id));

    const forced = purge.purgeSession(session, {
      apply: true,
      force: true,
      home,
      env: process.env,
      isAlive: () => true,
      noEngine: true,
    });
    assert.equal(forced.ok, true, forced.error);
    assert.equal(loadRegistry().findExact(session.id), null);
  });

  it('orphans scan lists orphan-runs and purge --ids --apply removes them', () => {
    const orphanId = 'orphan-run-' + crypto.randomBytes(3).toString('hex');
    const orphanDir = path.join(home, 'runs', orphanId);
    fs.mkdirSync(orphanDir, { recursive: true });
    fs.writeFileSync(path.join(orphanDir, 'log.txt'), 'leftover\n');

    const scan = af(['orphans', '--json']);
    assert.equal(scan.status, 0, scan.stderr + scan.stdout);
    const payload = JSON.parse(scan.stdout);
    assert.ok(payload.items.some((i) => i.category === 'orphan-runs' && i.afId === orphanId));

    const dry = af(['orphans', '--purge', '--ids', orphanId, '--json']);
    assert.equal(dry.status, 0, dry.stderr + dry.stdout);
    assert.ok(fs.existsSync(orphanDir));

    const applied = af(['orphans', '--purge', '--ids', orphanId, '--apply', '--yes', '--json']);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    assert.equal(fs.existsSync(orphanDir), false);
  });

  it('orphans missing-cwd is selectable; herdr panes are never purgeable', () => {
    const registry = loadRegistry();
    const missing = path.join(home, 'does-not-exist-' + Date.now());
    const session = registry.add({
      title: 'MissingCwd',
      chatId: '11111111-2222-4333-8444-555555555506',
      cwd: missing,
      engine: 'cursor',
      status: 'done',
    });
    const purge = loadPurge();
    const scan = purge.scanOrphans({
      home,
      env: process.env,
      days: 0,
      herdrFetch: () => ({
        ok: true,
        terminals: [{ name: 't1', afId: 'ghost-af-id', labels: { af_id: 'ghost-af-id' } }],
      }),
    });
    assert.ok(scan.items.some((i) => i.category === 'missing-cwd' && i.afId === session.id));
    const herdr = scan.items.find((i) => i.category === 'herdr-orphan-pane');
    assert.ok(herdr);
    assert.equal(herdr.purgeable, false);

    const purged = purge.purgeOrphanItems(scan.items, {
      apply: false,
      ids: ['ghost-af-id'],
      home,
      env: process.env,
    });
    assert.equal(purged.selected, 0);
  });

  it('never uses real ~/.agentfleet ~/.cursor ~/.copilot in this suite', () => {
    assert.ok(home.startsWith(os.tmpdir()) || home.includes('af-purge-home'));
    assert.ok(cursorHome.includes('af-purge-cursor'));
    assert.ok(copilotHome.includes('af-purge-copilot'));
    assert.notEqual(home, path.join(os.homedir(), '.agentfleet'));
    assert.notEqual(cursorHome, path.join(os.homedir(), '.cursor'));
    assert.notEqual(copilotHome, path.join(os.homedir(), '.copilot'));
  });
});
