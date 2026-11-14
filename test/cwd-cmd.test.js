'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('af cwd / set-cwd', () => {
  let home;
  let stubDir;
  let oldCwd;
  let newCwd;
  let hcLog;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cwdcmd-stub-'));
    hcLog = path.join(stubDir, 'hc.log');
    fs.writeFileSync(
      path.join(stubDir, 'cursor-agent'),
      '#!/usr/bin/env bash\necho ok\nexit 0\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(stubDir, 'hc'),
      `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.AF_HC_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const cmd = process.argv[2];
if (cmd === 'ls') {
  process.stdout.write(process.env.AF_HC_LS_JSON || JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
if (cmd === 'get') process.exit(0);
if (cmd === 'run' || cmd === 'send' || cmd === 'label' || cmd === 'keep') process.exit(0);
process.exit(0);
`,
      { mode: 0o755 }
    );
  });
  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cwdcmd-home-'));
    oldCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cwdcmd-old-'));
    newCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cwdcmd-new-'));
    try {
      fs.unlinkSync(hcLog);
    } catch (_) {}
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(oldCwd, { recursive: true, force: true });
    fs.rmSync(newCwd, { recursive: true, force: true });
  });

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
      AF_HC_LOG: hcLog,
      AGENTFLEET_HC_BIN: path.join(stubDir, 'hc'),
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }
  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], { encoding: 'utf8', env: env(extra) });
  }
  function seed(title = 'CwdSess', extra = {}) {
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry').add({
      title,
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: oldCwd,
      engine: 'copilot',
      status: 'active',
      branch: 'old-branch',
      ...extra,
    });
  }
  function load() {
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }
  function mutatingHcCalls() {
    if (!fs.existsSync(hcLog)) return [];
    return fs
      .readFileSync(hcLog, 'utf8')
      .split(/\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.argv && ['run', 'send', 'label', 'keep', 'kill', 'interrupt'].includes(e.argv[0]));
  }

  it('prints current folder with only title', () => {
    const s = seed();
    const r = af(['cwd', s.title]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), oldCwd);
  });

  it('prints json cwd with only title', () => {
    const s = seed();
    const r = af(['cwd', s.title, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.id, s.id);
    assert.equal(body.title, s.title);
    assert.equal(body.cwd, oldCwd);
  });

  it('valid change updates cwd and branch', () => {
    const s = seed();
    // init a git repo in newCwd with a commit so rev-parse HEAD works
    spawnSync('git', ['init', '-b', 'main'], { cwd: newCwd, encoding: 'utf8' });
    spawnSync('git', ['-C', newCwd, 'config', 'user.email', 'af@test'], { encoding: 'utf8' });
    spawnSync('git', ['-C', newCwd, 'config', 'user.name', 'af test'], { encoding: 'utf8' });
    fs.writeFileSync(path.join(newCwd, 'README'), 'x');
    spawnSync('git', ['-C', newCwd, 'add', 'README'], { encoding: 'utf8' });
    spawnSync('git', ['-C', newCwd, 'commit', '-m', 'init'], { encoding: 'utf8' });
    const r = af(['cwd', s.title, newCwd]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, new RegExp(`${oldCwd} →`));
    const after = load().find(s.id);
    assert.equal(after.cwd, fs.realpathSync(newCwd));
    assert.equal(after.branch, 'main');
    assert.equal(after.engine, 'copilot');
    assert.equal(after.chatId, s.chatId);
  });

  it('set-cwd alias works', () => {
    const s = seed('AliasSess');
    const r = af(['set-cwd', s.title, newCwd, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.cwd, fs.realpathSync(newCwd));
  });

  it('nonexistent path errors', () => {
    const s = seed();
    const missing = path.join(newCwd, 'nope-missing');
    const r = af(['cwd', s.title, missing]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /does not exist/);
  });

  it('file-not-dir errors', () => {
    const s = seed();
    const file = path.join(newCwd, 'not-a-dir');
    fs.writeFileSync(file, 'x');
    const r = af(['cwd', s.title, file]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /not a directory/);
  });

  it('expands ~', () => {
    const s = seed();
    // Use a real dir under HOME via symlink into our temp newCwd is hard;
    // instead create under home and pass ~/relative — use AGENTFLEET-free path
    // under os.homedir that we create and remove.
    const rel = `.af-cwd-tilde-test-${Date.now()}`;
    const underHome = path.join(os.homedir(), rel);
    fs.mkdirSync(underHome, { recursive: true });
    try {
      const r = af(['cwd', s.title, `~/${rel}`, '--json']);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const body = JSON.parse(r.stdout);
      assert.equal(body.cwd, fs.realpathSync(underHome));
    } finally {
      fs.rmSync(underHome, { recursive: true, force: true });
    }
  });

  it('dry-run writes nothing', () => {
    const s = seed();
    const before = fs.readFileSync(path.join(home, 'sessions.json'), 'utf8');
    const r = af(['cwd', s.title, newCwd, '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /→/);
    assert.equal(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'), before);
    assert.equal(load().find(s.id).cwd, oldCwd);
  });

  it('json shape on change', () => {
    const s = seed();
    const r = af(['cwd', s.title, newCwd, '--json']);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.id, s.id);
    assert.equal(body.title, s.title);
    assert.equal(body.engine, 'copilot');
    assert.equal(body.oldCwd, oldCwd);
    assert.equal(body.cwd, fs.realpathSync(newCwd));
    assert.ok(Array.isArray(body.notes));
    assert.ok(body.notes.length >= 1);
    assert.ok('herdr' in body);
  });

  it('unchanged is a no-op', () => {
    const s = seed();
    const r = af(['cwd', s.title, oldCwd]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /unchanged/);
  });

  it('live Herdr terminal adds resume note without mutating hc', () => {
    const s = seed('LiveCwd');
    const ls = JSON.stringify({
      terminals: [
        {
          address: 't1',
          name: 'livecwd',
          state: 'live',
          agent: 'env',
          labels: { af_id: s.id },
        },
      ],
      hidden_finished: 0,
    });
    const r = af(['cwd', s.title, newCwd, '--json'], { AF_HC_LS_JSON: ls });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.herdr.runtime, 'running');
    assert.ok(body.notes.some((n) => /aflt stop|aflt resume/i.test(n)));
    assert.ok(body.notes.some((n) => /session-based|not folder-based|adopt is not required/i.test(n)));
    assert.equal(mutatingHcCalls().length, 0, JSON.stringify(mutatingHcCalls()));
  });

  it('shell-only live terminal suggests resume (not stop) without mutating hc', () => {
    const s = seed('ShellCwd');
    const ls = JSON.stringify({
      terminals: [
        {
          address: 't2',
          name: 'shellcwd',
          state: 'live',
          agent: 'zsh',
          labels: { af_id: s.id },
        },
      ],
      hidden_finished: 0,
    });
    const r = af(['cwd', s.title, newCwd], { AF_HC_LS_JSON: ls });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /aflt resume/);
    assert.doesNotMatch(r.stderr, /aflt stop/);
    assert.match(r.stderr, /session-based|not folder-based|adopt is not required/i);
    assert.equal(mutatingHcCalls().length, 0);
  });
});
