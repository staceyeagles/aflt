'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const setup = require('../lib/setup');

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function snapshotTree(root) {
  const files = [];
  function walk(dir, rel = '') {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? path.join(rel, name) : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full, r);
      else if (st.isSymbolicLink()) {
        files.push({ path: r, type: 'symlink', target: fs.readlinkSync(full) });
      } else {
        files.push({ path: r, type: 'file', hash: hashFile(full), size: st.size });
      }
    }
  }
  walk(root);
  return files;
}

describe('aflt setup', () => {
  let home;
  let stubDir;
  let prevHome;
  let prevAfHome;
  let prevMem;
  let prevPath;

  beforeEach(() => {
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevMem = process.env.AFLT_MEMORY_REPO;
    prevPath = process.env.PATH;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-setup-home-'));
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-setup-stub-'));
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    delete process.env.AFLT_MEMORY_REPO;
    // Stub dir first (no engines); keep system PATH so `git` works for memory init.
    process.env.PATH = `${stubDir}${path.delimiter}${prevPath || '/usr/bin:/bin'}`;
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevMem === undefined) delete process.env.AFLT_MEMORY_REPO;
    else process.env.AFLT_MEMORY_REPO = prevMem;
    process.env.PATH = prevPath;
  });

  function basePath(extraPath) {
    if (extraPath != null) return extraPath;
    return `${stubDir}${path.delimiter}${prevPath || '/usr/bin:/bin'}`;
  }

  function env(extra = {}) {
    const { PATH: pathOverride, ...rest } = extra;
    return {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      AFLT_MEMORY_REPO: '',
      PATH: basePath(pathOverride),
      AGENTFLEET_SESSION: '',
      AGENTFLEET_ID: '',
      // Keep hermetic Herdr stubs unless a test overrides
      ...rest,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      cwd: home,
      env: env(extraEnv),
    });
  }

  it('default setup is preview-only (no writes under temp home)', () => {
    const before = snapshotTree(home);
    const r = af(['setup', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.ok, true);
    assert.equal(j.mode, 'preview');
    assert.equal(j.apply, false);
    assert.ok(Array.isArray(j.actions));
    assert.ok(j.node && j.node.ok);
    assert.ok(j.engines);
    assert.equal(j.herdr.requested, false);
    assert.deepEqual(snapshotTree(home), before);
    assert.equal(fs.existsSync(path.join(home, '.agentfleet')), false);
    assert.equal(fs.existsSync(path.join(home, '.config')), false);
  });

  it('--apply is idempotent and creates home without clobbering sessions', () => {
    const fleet = path.join(home, '.agentfleet');
    fs.mkdirSync(fleet, { recursive: true });
    const sessionsPath = path.join(fleet, 'sessions.json');
    const sessionsBody = JSON.stringify(
      {
        version: 1,
        sessions: [
          {
            id: 'keep-me-aaaaaa',
            title: 'keep-me',
            chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
            cwd: home,
            engine: 'cursor',
            status: 'active',
          },
        ],
      },
      null,
      2
    ) + '\n';
    fs.writeFileSync(sessionsPath, sessionsBody, 'utf8');
    const cfgPath = path.join(fleet, 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ defaultEngine: 'cursor' }, null, 2) + '\n');

    const r1 = af(['setup', '--apply', '--json']);
    assert.equal(r1.status, 0, r1.stderr + r1.stdout);
    const j1 = JSON.parse(r1.stdout);
    assert.equal(j1.ok, true);
    assert.equal(j1.mode, 'apply');
    assert.equal(fs.readFileSync(sessionsPath, 'utf8'), sessionsBody);
    assert.equal(
      fs.readFileSync(cfgPath, 'utf8'),
      JSON.stringify({ defaultEngine: 'cursor' }, null, 2) + '\n'
    );

    const snap = snapshotTree(home);
    const r2 = af(['setup', '--apply', '--json']);
    assert.equal(r2.status, 0, r2.stderr + r2.stdout);
    const j2 = JSON.parse(r2.stdout);
    assert.equal(j2.ok, true);
    assert.deepEqual(snapshotTree(home), snap);
    assert.equal(fs.readFileSync(sessionsPath, 'utf8'), sessionsBody);
  });

  it('reports missing engines without installing anything', () => {
    // Isolate from any real cursor-agent/copilot on the machine PATH.
    const isolated = stubDir;
    const before = snapshotTree(home);
    const beforeStub = snapshotTree(stubDir);
    const r = af(['setup', '--json'], {
      PATH: isolated,
      AGENTFLEET_CURSOR_BIN: '',
      AGENTFLEET_COPILOT_BIN: '',
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.equal(j.engines.cursor.present, false);
    assert.equal(j.engines.copilot.present, false);
    assert.match(j.engines.cursor.detail, /not on PATH/);
    assert.match(j.engines.copilot.detail, /not on PATH/);
    assert.deepEqual(snapshotTree(home), before);
    assert.deepEqual(snapshotTree(stubDir), beforeStub);
  });

  it('preserves existing config/sessions unless --memory requests a change', () => {
    const fleet = path.join(home, '.agentfleet');
    fs.mkdirSync(fleet, { recursive: true });
    const sessionsPath = path.join(fleet, 'sessions.json');
    fs.writeFileSync(sessionsPath, '{"version":1,"sessions":[]}\n');
    const cfgPath = path.join(fleet, 'config.json');
    fs.writeFileSync(cfgPath, '{"defaultEngine":"copilot"}\n');

    const r = af(['setup', '--apply', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.equal(fs.readFileSync(sessionsPath, 'utf8'), '{"version":1,"sessions":[]}\n');
    assert.equal(fs.readFileSync(cfgPath, 'utf8'), '{"defaultEngine":"copilot"}\n');
  });

  it('without --herdr does not write Herdr paths; with --herdr can apply into temp config', () => {
    const before = snapshotTree(home);
    const noHerdr = af(['setup', '--apply', '--json']);
    assert.equal(noHerdr.status, 0, noHerdr.stderr + noHerdr.stdout);
    const j0 = JSON.parse(noHerdr.stdout);
    assert.equal(j0.herdr.requested, false);
    assert.equal(fs.existsSync(path.join(home, '.config', 'herdr-core')), false);
    assert.equal(fs.existsSync(path.join(home, '.config', 'herdr-app')), false);

    // Stub hc so --herdr considers Herdr present
    const hc = path.join(stubDir, 'hc');
    fs.writeFileSync(hc, '#!/bin/sh\necho ok\n', { mode: 0o755 });
    const herdrApp = path.join(stubDir, 'herdr-app');
    fs.writeFileSync(herdrApp, '#!/bin/sh\necho ok\n', { mode: 0o755 });

    const herdrEnv = {
      PATH: `${stubDir}${path.delimiter}${prevPath || '/usr/bin:/bin'}`,
      AGENTFLEET_HC_BIN: hc,
      AGENTFLEET_HERDR_APP_BIN: herdrApp,
    };
    const preview = af(['setup', '--herdr', '--json'], herdrEnv);
    assert.equal(preview.status, 0, preview.stderr + preview.stdout);
    const jp = JSON.parse(preview.stdout);
    assert.equal(jp.herdr.requested, true);
    assert.equal(jp.mode, 'preview');
    assert.ok(jp.herdr.templates);
    assert.ok(jp.herdr.panel);
    assert.equal(fs.existsSync(path.join(home, '.config', 'herdr-core')), false);
    assert.equal(fs.existsSync(path.join(home, '.config', 'herdr-app')), false);

    const applied = af(['setup', '--apply', '--herdr', '--json'], herdrEnv);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    const ja = JSON.parse(applied.stdout);
    assert.equal(ja.ok, true);
    assert.ok(fs.existsSync(path.join(home, '.config', 'herdr-core', 'templates', 'cursor.md')));
    assert.ok(fs.existsSync(path.join(home, '.config', 'herdr-core', 'templates', 'copilot.md')));
    assert.ok(fs.existsSync(path.join(home, '.config', 'herdr-core', 'templates', 'opencode.md')));
    assert.ok(fs.existsSync(path.join(home, '.config', 'herdr-app', 'mods', 'af-sessions')));
    assert.ok(fs.existsSync(path.join(home, '.config', 'herdr-app', 'layouts', 'af.json')));

    // Second apply idempotent for herdr files
    const snap = snapshotTree(path.join(home, '.config'));
    const again = af(['setup', '--apply', '--herdr', '--json'], herdrEnv);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    assert.deepEqual(snapshotTree(path.join(home, '.config')), snap);

    // Ensure the earlier no-herdr apply did not require herdr dirs from before stub
    void before;
  });

  it('--memory registers only on --apply; preview creates nothing', () => {
    const memRepo = path.join(home, 'memory-repo');
    const preview = af(['setup', '--memory', memRepo, '--json']);
    assert.equal(preview.status, 0, preview.stderr + preview.stdout);
    const jp = JSON.parse(preview.stdout);
    assert.equal(jp.memory.status, 'would_init');
    assert.equal(fs.existsSync(memRepo), false);
    assert.equal(fs.existsSync(path.join(home, '.agentfleet', 'config.json')), false);

    const applied = af(['setup', '--apply', '--memory', memRepo, '--json']);
    assert.equal(applied.status, 0, applied.stderr + applied.stdout);
    const ja = JSON.parse(applied.stdout);
    assert.ok(ja.memory.status === 'created' || ja.memory.status === 'registered');
    assert.ok(fs.existsSync(path.join(memRepo, '.aflt-memory.json')));
    const cfg = JSON.parse(fs.readFileSync(path.join(home, '.agentfleet', 'config.json'), 'utf8'));
    assert.equal(cfg.memoryRepo, fs.realpathSync(memRepo));

    const again = af(['setup', '--apply', '--memory', memRepo, '--json']);
    assert.equal(again.status, 0, again.stderr + again.stdout);
    const j2 = JSON.parse(again.stdout);
    assert.equal(j2.memory.status, 'registered');
  });

  it('--json shape is stable', () => {
    const r = af(['setup', '--json']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    for (const key of [
      'ok',
      'mode',
      'apply',
      'node',
      'path',
      'binaries',
      'home',
      'sessions',
      'config',
      'memory',
      'engines',
      'herdr',
      'actions',
      'errors',
    ]) {
      assert.ok(key in j, `missing key ${key}`);
    }
    assert.equal(typeof j.ok, 'boolean');
    assert.ok(j.mode === 'preview' || j.mode === 'apply');
    assert.ok(Array.isArray(j.binaries));
    assert.equal(j.binaries.length, 3);
    assert.ok(Array.isArray(j.actions));
    assert.ok(Array.isArray(j.errors));
    assert.equal(typeof j.node.ok, 'boolean');
    assert.equal(typeof j.engines.cursor.present, 'boolean');
    assert.equal(typeof j.engines.copilot.present, 'boolean');
    assert.equal(typeof j.herdr.requested, 'boolean');
  });

  it('USAGE documents setup', () => {
    const r = af(['help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /aflt setup/);
    assert.match(r.stdout, /--apply/);
    assert.match(r.stdout, /--herdr/);
    assert.match(r.stdout, /--memory/);
  });

  it('lib runSetup preview does not create memory without flag', () => {
    const result = setup.runSetup({
      apply: false,
      env: env(),
    });
    assert.equal(result.ok, true);
    assert.equal(result.memory.status, 'none');
    assert.equal(fs.existsSync(path.join(home, 'memory-repo')), false);
  });
});
