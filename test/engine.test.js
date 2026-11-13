'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const config = require('../lib/config');
const engine = require('../lib/engine');
const copilot = require('../lib/copilot');
const backends = require('../lib/backends');
const registry = require('../lib/registry');

const sampleCopilot = {
  id: 'copilot-aaa',
  title: 'Copilot probe',
  chatId: '11111111-2222-4333-8444-555555555555',
  cwd: '/tmp/wt-copilot',
  model: 'gpt-5',
  engine: 'copilot',
};

function withHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-engine-'));
  const prevHome = process.env.AGENTFLEET_HOME;
  const prevEngine = process.env.AGENTFLEET_ENGINE;
  process.env.AGENTFLEET_HOME = tmp;
  delete process.env.AGENTFLEET_ENGINE;
  try {
    return fn(tmp);
  } finally {
    if (prevHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevHome;
    if (prevEngine === undefined) delete process.env.AGENTFLEET_ENGINE;
    else process.env.AGENTFLEET_ENGINE = prevEngine;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function runAf(args, envExtra = {}) {
  const env = { ...process.env, ...envExtra };
  // Avoid leaking a parent AGENTFLEET_ENGINE into precedence tests unless set.
  if (!Object.prototype.hasOwnProperty.call(envExtra, 'AGENTFLEET_ENGINE')) {
    delete env.AGENTFLEET_ENGINE;
  }
  return spawnSync(process.execPath, [afJs, ...args], {
    encoding: 'utf8',
    env,
  });
}

describe('lib/config', () => {
  it('persists defaultEngine and tolerates missing/corrupt config', () => {
    withHome((tmp) => {
      assert.equal(config.getDefaultEngineFromConfig(), null);
      assert.deepEqual(config.load(), {});

      config.setDefaultEngine('copilot');
      assert.equal(config.getDefaultEngineFromConfig(), 'copilot');
      const raw = JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8'));
      assert.equal(raw.defaultEngine, 'copilot');

      fs.writeFileSync(path.join(tmp, 'config.json'), '{not json', 'utf8');
      assert.deepEqual(config.load(), {});
      assert.equal(config.getDefaultEngineFromConfig(), null);

      fs.writeFileSync(path.join(tmp, 'config.json'), JSON.stringify({ defaultEngine: 'nope' }), 'utf8');
      assert.equal(config.getDefaultEngineFromConfig(), null);

      assert.throws(() => config.setDefaultEngine('claude'), /invalid engine/);
    });
  });
});

describe('engine resolve precedence', () => {
  it('flag > env > config > builtin', () => {
    withHome(() => {
      assert.deepEqual(engine.resolveEngine({}), { engine: 'cursor', source: 'builtin' });

      config.setDefaultEngine('copilot');
      assert.deepEqual(engine.resolveEngine({}), { engine: 'copilot', source: 'config' });

      assert.deepEqual(engine.resolveEngine({ env: { AGENTFLEET_ENGINE: 'cursor' } }), {
        engine: 'cursor',
        source: 'env',
      });

      assert.deepEqual(
        engine.resolveEngine({ flag: 'copilot', env: { AGENTFLEET_ENGINE: 'cursor' } }),
        { engine: 'copilot', source: 'flag' }
      );

      assert.throws(() => engine.resolveEngine({ flag: 'nope' }), /invalid engine/);
      assert.throws(
        () => engine.resolveEngine({ env: { AGENTFLEET_ENGINE: 'nope' } }),
        /invalid engine/
      );
    });
  });
});

describe('copilot interactive argv', () => {
  it('builds --session-id, -C, model, optional -i prompt, and --allow-all-tools only with force', () => {
    const base = copilot.buildInteractiveArgs(sampleCopilot, {});
    assert.equal(base[0], '--session-id=11111111-2222-4333-8444-555555555555');
    assert.ok(base.includes('-C'));
    assert.ok(base.includes('/tmp/wt-copilot'));
    assert.ok(base.includes('--model'));
    assert.ok(base.includes('gpt-5'));
    assert.ok(!base.includes('-i'));
    assert.ok(!base.includes('--allow-all-tools'));
    assert.ok(!base.includes('--trust'));
    assert.ok(!base.includes('--workspace'));
    assert.ok(!base.includes('--resume'));

    const withPrompt = copilot.buildInteractiveArgs(sampleCopilot, {
      prompt: 'Reply pong',
      force: true,
    });
    assert.ok(withPrompt.includes('-i'));
    assert.ok(withPrompt.includes('Reply pong'));
    assert.ok(withPrompt.includes('--allow-all-tools'));

    const cmd = engine.buildInteractiveCommand(sampleCopilot, { prompt: 'hi' });
    assert.equal(cmd[0], copilot.resolveCopilotBin());
    assert.ok(cmd.includes('--session-id=11111111-2222-4333-8444-555555555555'));

    const cursorSess = { ...sampleCopilot, engine: 'cursor', chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' };
    const cursorCmd = engine.buildInteractiveCommand(cursorSess, { force: true, trust: true });
    assert.ok(cursorCmd.includes('--resume'));
    assert.ok(cursorCmd.includes('--trust'));
    assert.ok(!cursorCmd.includes('--allow-all-tools'));
    assert.ok(!cursorCmd.includes('--force'));
  });

  it('does not fall back to session.prompt', () => {
    const s = { ...sampleCopilot, prompt: 'DO_NOT_RESEND' };
    const args = copilot.buildInteractiveArgs(s, {});
    assert.ok(!args.includes('DO_NOT_RESEND'));
  });
});

describe('af engine / cursor / copilot CLI', () => {
  let tmp;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cli-engine-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('af cursor / af copilot / af engine set and print with temp AGENTFLEET_HOME', () => {
    const env = { AGENTFLEET_HOME: tmp };
    delete env.AGENTFLEET_ENGINE;

    let r = runAf(['engine'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /default engine: cursor \(from builtin\)/);
    assert.ok(r.stdout.includes(path.join(tmp, 'config.json')));

    r = runAf(['copilot'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /default engine set to copilot/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'config.json'), 'utf8')).defaultEngine, 'copilot');

    r = runAf(['engine'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /default engine: copilot \(from config\)/);

    r = runAf(['engine'], { ...env, AGENTFLEET_ENGINE: 'cursor' });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /default engine: cursor \(from env\)/);

    r = runAf(['engine', 'cursor'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /default engine set to cursor/);

    r = runAf(['cursor'], env);
    assert.equal(r.status, 0, r.stderr);

    r = runAf(['engine', 'nope'], env);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /invalid engine/);
  });
});

describe('af add engine default', () => {
  it('af add follows the default engine; --engine overrides', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-add-engine-'));
    try {
      const env = { AGENTFLEET_HOME: tmp };
      let r = runAf(['copilot'], env);
      assert.equal(r.status, 0, r.stderr);
      r = runAf(['add', 'cop-row', '--chat', '11111111-2222-4333-8444-555555555555', '--cwd', tmp], env);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /engine:\s+copilot/);
      r = runAf(['add', 'cur-row', '--engine', 'cursor', '--chat', 'abc', '--cwd', tmp], env);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /engine:\s+cursor/);
      r = runAf(['add', 'env-row', '--chat', 'def', '--cwd', tmp], { ...env, AGENTFLEET_ENGINE: 'cursor' });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /engine:\s+cursor/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('af new / resume / ls / run with copilot', () => {
  let tmp;
  let stubDir;
  let fakePath;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-copilot-stub-'));
    const stubCopilot = path.join(stubDir, 'copilot');
    const stubCursor = path.join(stubDir, 'cursor-agent');
    const stubHc = path.join(stubDir, 'hc');
    fs.writeFileSync(stubCopilot, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(stubCursor, '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env node
if (process.argv[2] === 'ls') {
  process.stdout.write(JSON.stringify({ terminals: [] }));
  process.exit(0);
}
process.exit(1);
`,
      { mode: 0o755 }
    );
    fakePath = `${stubDir}${path.delimiter}${process.env.PATH || ''}`;
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-copilot-home-'));
  });
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function env(extra = {}) {
    return {
      AGENTFLEET_HOME: tmp,
      AGENTFLEET_COPILOT_BIN: path.join(stubDir, 'copilot'),
      AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
      AGENTFLEET_HC_BIN: path.join(stubDir, 'hc'),
      PATH: fakePath,
      ...extra,
    };
  }

  it('af new --engine copilot --dry-run prints interactive argv', () => {
    const r = runAf(
      ['new', 'copilot-new', '--engine', 'copilot', '--cwd', tmp, '--prompt', 'Reply pong', '--dry-run'],
      env()
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('would mint a Copilot session id'));
    assert.ok(r.stdout.includes('--session-id='));
    assert.ok(r.stdout.includes('-C'));
    assert.ok(r.stdout.includes('-i'));
    assert.ok(r.stdout.includes('Reply pong'));
    assert.ok(!r.stdout.includes('--trust'));
    assert.ok(!r.stdout.includes('--workspace'));
    assert.ok(!r.stdout.includes('create-chat'));
    assert.ok(!fs.existsSync(path.join(tmp, 'sessions.json')));
  });

  it('af new --engine copilot --force --dry-run adds --allow-all-tools', () => {
    const r = runAf(
      ['new', 'copilot-force-new', '--engine', 'copilot', '--cwd', tmp, '--force', '--dry-run'],
      env()
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('--allow-all-tools'));
  });

  it('resume dry-run via herdr and plain for a copilot session', () => {
    process.env.AGENTFLEET_HOME = tmp;
    registry.add({
      title: 'copilot-resume',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      engine: 'copilot',
      id: 'copilot-resume-test',
    });
    delete process.env.AGENTFLEET_HOME;

    const herdr = runAf(['resume', 'copilot-resume', '--via', 'herdr', '--dry-run', '--no-open'], env());
    assert.equal(herdr.status, 0, herdr.stderr);
    assert.match(herdr.stdout, /^hc run --bg /m);
    assert.ok(herdr.stdout.includes('env -u NO_COLOR -u FORCE_COLOR'));
    assert.ok(herdr.stdout.includes('--session-id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    assert.ok(herdr.stdout.includes('-C'));
    assert.ok(!herdr.stdout.includes('--trust'));
    assert.ok(!herdr.stdout.includes('--workspace'));
    assert.ok(!herdr.stdout.includes('--resume'));
    assert.match(herdr.stdout, /herdr\.space=sp[0-9a-f]{32}/);
    assert.match(herdr.stdout, /herdr\.tab=tb[0-9a-f]{32}/);
    assert.match(herdr.stdout, /^Attach: hc attach /m);

    const plain = runAf(['resume', 'copilot-resume', '--via', 'plain', '--dry-run'], env());
    assert.equal(plain.status, 0, plain.stderr);
    assert.ok(plain.stdout.includes('--session-id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    assert.ok(!plain.stdout.includes('hc run'));
    assert.ok(!plain.stdout.includes('--trust'));
  });

  it('resume --all mixing engines builds per-session argv', () => {
    process.env.AGENTFLEET_HOME = tmp;
    registry.add({
      title: 'mix-cursor',
      chatId: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      engine: 'cursor',
      id: 'mix-cursor-test',
    });
    registry.add({
      title: 'mix-copilot',
      chatId: 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      engine: 'copilot',
      id: 'mix-copilot-test',
    });
    delete process.env.AGENTFLEET_HOME;

    const r = runAf(['resume', '--all', '--via', 'plain', '--dry-run'], env());
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('--resume'));
    assert.ok(r.stdout.includes('cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee'));
    assert.ok(r.stdout.includes('--session-id=dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee'));
  });

  it('ls --json includes engine for every row (default cursor)', () => {
    process.env.AGENTFLEET_HOME = tmp;
    registry.add({
      title: 'legacy-cursor',
      chatId: 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      id: 'legacy-cursor-test',
    });
    registry.add({
      title: 'json-copilot',
      chatId: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      engine: 'copilot',
      id: 'json-copilot-test',
    });
    delete process.env.AGENTFLEET_HOME;

    const r = runAf(['ls', '--json', '--all'], env());
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const byTitle = Object.fromEntries(out.sessions.map((s) => [s.title, s]));
    assert.equal(byTitle['legacy-cursor'].engine, 'cursor');
    assert.equal(byTitle['json-copilot'].engine, 'copilot');
  });

  it('af run picks default engine for new sessions but keeps existing session engine', () => {
    // Config default copilot → new dry-run uses copilot
    runAf(['copilot'], env());
    const created = runAf(
      ['run', 'default-eng', '--prompt', 'Reply pong', '--cwd', tmp, '--dry-run'],
      env()
    );
    assert.equal(created.status, 0, created.stderr);
    assert.ok(created.stderr.includes('would create a copilot session'));
    assert.ok(created.stdout.includes('--session-id='));
    assert.ok(created.stdout.includes('-p'));

    // Existing cursor session with config default copilot: no --engine → still cursor
    process.env.AGENTFLEET_HOME = tmp;
    registry.add({
      title: 'keep-cursor',
      chatId: 'aaaaaaaa-1111-4222-8333-bbbbbbbbbbbb',
      cwd: tmp,
      engine: 'cursor',
      id: 'keep-cursor-test',
    });
    delete process.env.AGENTFLEET_HOME;

    const kept = runAf(['run', 'keep-cursor', '--prompt', 'Reply pong', '--dry-run'], env());
    assert.equal(kept.status, 0, kept.stderr);
    assert.ok(kept.stdout.includes('--resume'));
    assert.ok(kept.stdout.includes('--workspace'));
    assert.ok(!kept.stdout.includes('--session-id='));

    const mismatch = runAf(
      ['run', 'keep-cursor', '--engine', 'copilot', '--prompt', 'Reply pong', '--dry-run'],
      env()
    );
    assert.notEqual(mismatch.status, 0);
    assert.match(mismatch.stderr, /engine=cursor, not copilot/);
  });

  it('help mentions engine commands and AGENTFLEET_ENGINE', () => {
    const r = runAf(['help'], env());
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('af engine'));
    assert.ok(r.stdout.includes('af cursor'));
    assert.ok(r.stdout.includes('af copilot'));
    assert.ok(r.stdout.includes('AGENTFLEET_ENGINE'));
    assert.ok(r.stdout.includes('AGENTFLEET_COPILOT_BIN'));
  });
});

describe('backends mixed engines', () => {
  it('herdr plan uses copilot argv for copilot sessions', () => {
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const cwdA = fs.mkdtempSync(path.join(os.tmpdir(), 'af-eng-a-'));
    const cwdB = fs.mkdtempSync(path.join(os.tmpdir(), 'af-eng-b-'));
    const sessions = [
      {
        id: 'c1',
        title: 'Cursor one',
        chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        cwd: cwdA,
        engine: 'cursor',
      },
      {
        id: 'p1',
        title: 'Copilot one',
        chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
        cwd: cwdB,
        engine: 'copilot',
      },
    ];
    try {
      const plan = backends.buildResumeAllPlan(sessions, {
        via: 'herdr',
        resumeOpts: { herdrApp: true, env: { TERM: 'xterm-256color' }, force: true },
      });
      assert.equal(plan.commands.length, 2);
      const cursorArgv = plan.commands[0].argv.join(' ');
      const copilotArgv = plan.commands[1].argv.join(' ');
      assert.ok(cursorArgv.includes('--resume'));
      assert.ok(cursorArgv.includes('--trust'));
      assert.ok(copilotArgv.includes('--session-id=bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee'));
      assert.ok(copilotArgv.includes('--allow-all-tools'));
      assert.ok(!copilotArgv.includes('--trust'));
      assert.ok(!copilotArgv.includes('--workspace'));
    } finally {
      fs.rmSync(cwdA, { recursive: true, force: true });
      fs.rmSync(cwdB, { recursive: true, force: true });
    }
  });
});
