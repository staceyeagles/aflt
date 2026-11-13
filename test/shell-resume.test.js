'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const herdr = require('../lib/herdr');
const herdrapp = require('../lib/herdrapp');
const backends = require('../lib/backends');
const orchestrate = require('../lib/orchestrate');

describe('shell-only detection', () => {
  const base = {
    address: 't9',
    name: 'shell-sess',
    state: 'live',
    labels: { af_id: 'shell-sess-aaaaaa' },
    afId: 'shell-sess-aaaaaa',
  };

  for (const agent of ['zsh', '-zsh', 'bash', '/bin/zsh', 'fish', 'nu']) {
    it(`agent ${JSON.stringify(agent)} → runtime shell`, () => {
      const t = herdr.normalizeTerminal({ ...base, agent });
      assert.equal(herdr.isShellOnlyTerminal(t), true);
      const c = herdr.classifySession(
        { id: base.afId, title: 'Shell', cwd: '/tmp' },
        [t]
      );
      assert.equal(c.runtime, 'shell');
    });
  }

  it('null/empty agent everywhere → running (not shell)', () => {
    for (const agent of [null, '', undefined]) {
      const t = herdr.normalizeTerminal({ ...base, agent });
      assert.equal(herdr.isShellOnlyTerminal(t), false);
      const c = herdr.classifySession({ id: base.afId, title: 'R', cwd: '/tmp' }, [t]);
      assert.equal(c.runtime, 'running');
    }
  });

  it('agent env / cursor-agent / copilot → running (not shell)', () => {
    for (const agent of ['env', 'cursor-agent', 'copilot']) {
      const t = herdr.normalizeTerminal({ ...base, agent });
      assert.equal(herdr.isShellOnlyTerminal(t), false);
      const c = herdr.classifySession({ id: base.afId, title: 'R', cwd: '/tmp' }, [t]);
      assert.equal(c.runtime, 'running');
    }
  });

  it('foreground.name zsh with no non-shell evidence → shell', () => {
    const t = herdr.normalizeTerminal({
      ...base,
      agent: null,
      foreground: { name: 'zsh', argv: ['/bin/zsh', '-l'] },
    });
    assert.equal(herdr.isShellOnlyTerminal(t), true);
  });

  it('agent env wins over shell foreground → running', () => {
    const t = herdr.normalizeTerminal({
      ...base,
      agent: 'env',
      foreground: { name: 'zsh', argv: ['/bin/zsh', '-l'] },
    });
    assert.equal(herdr.isShellOnlyTerminal(t), false);
  });

  it('merge: ls agent env + get agent null / foreground node → running', () => {
    const fromLs = herdr.normalizeTerminal({
      ...base,
      agent: 'env',
      argv: ['env', '-u', 'NO_COLOR', 'cursor-agent', '--resume', 'x'],
    });
    const fromGet = herdr.normalizeTerminal({
      address: 't9',
      name: 'shell-sess',
      state: 'live',
      agent: null,
      argv: ['env', '-u', 'NO_COLOR', '.../cursor-agent'],
      foreground: {
        name: 'node',
        argv: ['.../cursor-agent', '--resume', 'x'],
        cwd: '/tmp/proj',
        pid: 1234,
      },
      labels: { af_id: base.afId },
    });
    const merged = herdr.mergeTerminalEvidence(fromLs, fromGet);
    assert.equal(merged.agent, 'env');
    assert.equal(merged.foreground.name, 'node');
    assert.equal(herdr.isShellOnlyTerminal(merged), false);
    const c = herdr.classifySession({ id: base.afId, title: 'Live', cwd: '/tmp' }, [merged]);
    assert.equal(c.runtime, 'running');
  });

  it('merge: ls agent zsh + get foreground zsh → shell', () => {
    const fromLs = herdr.normalizeTerminal({ ...base, agent: 'zsh' });
    const fromGet = herdr.normalizeTerminal({
      ...base,
      agent: null,
      foreground: { name: 'zsh', argv: ['/bin/zsh', '-l'] },
      argv: ['/bin/zsh', '-l'],
    });
    const merged = herdr.mergeTerminalEvidence(fromLs, fromGet);
    assert.equal(merged.agent, 'zsh');
    assert.equal(herdr.isShellOnlyTerminal(merged), true);
    const c = herdr.classifySession({ id: base.afId, title: 'Shell', cwd: '/tmp' }, [merged]);
    assert.equal(c.runtime, 'shell');
  });

  it('merge: both null → running', () => {
    const fromLs = herdr.normalizeTerminal({ ...base, agent: null });
    const fromGet = herdr.normalizeTerminal({
      ...base,
      agent: null,
      foreground: null,
      argv: null,
    });
    const merged = herdr.mergeTerminalEvidence(fromLs, fromGet);
    assert.equal(merged.agent, null);
    assert.equal(herdr.isShellOnlyTerminal(merged), false);
    const c = herdr.classifySession({ id: base.afId, title: 'Unk', cwd: '/tmp' }, [merged]);
    assert.equal(c.runtime, 'running');
  });

  it('fetchHerdrTerminals merge: get null agent does not wipe ls env', () => {
    const lsPayload = {
      terminals: [
        {
          address: 't9',
          name: 'live-cursor',
          state: 'live',
          agent: 'env',
          // no af_id in ls → triggers get
        },
      ],
    };
    const getPayload = {
      address: 't9',
      name: 'live-cursor',
      state: 'live',
      agent: null,
      argv: ['env', '-u', 'NO_COLOR', '/path/cursor-agent'],
      foreground: { name: 'node', argv: ['/path/cursor-agent'], pid: 1 },
      labels: { af_id: base.afId },
    };
    const runHc = (argv) => {
      if (argv[0] === 'ls') {
        return { status: 0, stdout: JSON.stringify(lsPayload), stderr: '' };
      }
      if (argv[0] === 'get') {
        return { status: 0, stdout: JSON.stringify(getPayload), stderr: '' };
      }
      return { status: 1, stdout: '', stderr: 'nope' };
    };
    const r = herdr.fetchHerdrTerminals({ runHc });
    assert.equal(r.ok, true);
    assert.equal(r.terminals[0].agent, 'env');
    assert.equal(r.terminals[0].foreground.name, 'node');
    assert.equal(r.terminals[0].afId, base.afId);
    assert.equal(herdr.isShellOnlyTerminal(r.terminals[0]), false);
  });

  it('deriveWorkerStatus shell → stopped; waitOutcomeMeta conclusive shell', () => {
    const derived = orchestrate.deriveWorkerStatus(
      { workerStatus: 'running' },
      { runtime: 'shell' }
    );
    assert.equal(derived, 'stopped');
    const meta = orchestrate.waitOutcomeMeta(
      { workerStatus: 'running' },
      { runtime: 'shell', derivedStatus: 'stopped' }
    );
    assert.equal(meta.stateSource, 'shell');
    assert.equal(meta.conclusive, true);
    assert.equal(orchestrate.waitExitCode(['stopped']), 1);
  });
});

describe('Herdr launch --cwd + herdr.space (table-driven paths)', () => {
  let home;
  let stubDir;
  let stubCursor;
  let stubHc;
  let stubCopilot;
  let hcLog;
  let sessionCwd;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cwd-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    stubCopilot = path.join(stubDir, 'copilot');
    stubHc = path.join(stubDir, 'hc');
    hcLog = path.join(stubDir, 'hc-cwd.log');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
if [[ "\${1:-}" == "create-chat" ]]; then echo "deadbeef-1111-4111-8111-ffffffffffff"; exit 0; fi
echo ok; exit 0
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      stubCopilot,
      '#!/usr/bin/env bash\necho ok\nexit 0\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.AF_HC_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const cmd = process.argv[2];
if (cmd === 'ls') {
  process.stdout.write(process.env.AF_HC_LS_JSON || JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
if (cmd === 'get') {
  process.stdout.write(JSON.stringify({ address: 't1', state: 'live', agent: 'env', labels: {} }));
  process.exit(0);
}
if (cmd === 'run' || cmd === 'send' || cmd === 'label' || cmd === 'keep') process.exit(0);
if (cmd === '--version' || process.argv.includes('--version')) {
  process.stdout.write(process.env.AF_HC_VERSION || 'herdr-core 0.1.20\\n');
  process.exit(0);
}
if (cmd === 'server') { process.stdout.write('ok\\n'); process.exit(0); }
process.exit(0);
`,
      { mode: 0o755 }
    );
  });
  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cwd-home-'));
    sessionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cwd-sess-'));
    try {
      fs.unlinkSync(hcLog);
    } catch (_) {}
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sessionCwd, { recursive: true, force: true });
  });

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      AGENTFLEET_COPILOT_BIN: stubCopilot,
      AF_HC_LOG: hcLog,
      AGENTFLEET_HC_BIN: stubHc,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }
  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], { encoding: 'utf8', env: env(extra) });
  }
  function seed(title, extra = {}) {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    return registry.add({
      title,
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: sessionCwd,
      engine: 'cursor',
      status: 'active',
      ...extra,
    });
  }
  function readLog() {
    if (!fs.existsSync(hcLog)) return [];
    return fs
      .readFileSync(hcLog, 'utf8')
      .split(/\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  function assertRunCwdAndSpace(runArgv, cwd) {
    const norm = herdrapp.normalizeCwd(cwd);
    const cwdIdx = runArgv.indexOf('--cwd');
    assert.ok(cwdIdx >= 0, `missing --cwd in ${JSON.stringify(runArgv)}`);
    assert.equal(runArgv[cwdIdx + 1], norm);
    // Space is session-group based (not cwd); just assert a herdr.space=sp… label exists.
    assert.ok(
      runArgv.some((a) => String(a).startsWith('herdr.space=sp')),
      `missing herdr.space in ${JSON.stringify(runArgv)}`
    );
    // engine workspace matches
    const wsIdx = runArgv.indexOf('--workspace');
    assert.ok(wsIdx >= 0);
    assert.equal(runArgv[wsIdx + 1], norm);
  }

  const cases = [
    {
      name: 'resume single',
      run: (s) => af(['resume', s.title, '--via', 'herdr', '--no-open'], {}),
    },
    {
      name: 'resume --all',
      run: () => af(['resume', '--all', '--via', 'herdr', '--no-open'], {}),
    },
    {
      name: 'spawn --interactive',
      run: (s) => {
        delete require.cache[require.resolve('../lib/registry')];
        process.env.AGENTFLEET_HOME = home;
        const registry = require('../lib/registry');
        const parent = registry.add({
          title: 'CwdParent',
          chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
          cwd: sessionCwd,
          role: 'master',
          status: 'active',
        });
        return af(
          [
            'spawn',
            '--parent',
            parent.title,
            '--prompt',
            'do work',
            '--interactive',
            '--cwd',
            sessionCwd,
            '--no-open',
          ],
          {}
        );
      },
    },
    {
      name: 'master interactive',
      run: () =>
        af(
          ['master', '--goal', 'Ship cwd check', '--cwd', sessionCwd, '--no-open'],
          {}
        ),
    },
  ];

  for (const c of cases) {
    it(`${c.name}: hc run has --cwd <folder> and matching herdr.space`, () => {
      const s = seed('CwdLaunch');
      const r = c.run(s);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const log = readLog();
      const runs = log.filter((e) => e.argv && e.argv[0] === 'run');
      assert.ok(runs.length >= 1, `expected hc run: ${JSON.stringify(log)}`);
      assertRunCwdAndSpace(runs[0].argv, sessionCwd);
    });
  }

  it('buildHerdrCommands fails clearly when session folder missing', () => {
    assert.throws(
      () =>
        backends.buildHerdrCommands(
          [
            {
              id: 'gone-aaa',
              title: 'Gone',
              chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
              cwd: path.join(sessionCwd, 'does-not-exist'),
            },
          ],
          { resumeOpts: { herdrApp: true } }
        ),
      /session folder does not exist/
    );
  });

  it('af doctor warns when herdr-core < 0.1.20', () => {
    const r = af(['doctor', '--json'], { AF_HC_VERSION: 'herdr-core 0.1.16\n' });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    const ver = body.checks.find((c) => c.name === 'herdr_core_version');
    assert.ok(ver);
    assert.equal(ver.ok, false);
    assert.match(ver.detail, /0\.1\.16/);
    assert.match(ver.detail, /hc update/);
  });

  it('af doctor ok when herdr-core >= 0.1.20', () => {
    const r = af(['doctor', '--json'], { AF_HC_VERSION: 'herdr-core 0.1.20\n' });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    const ver = body.checks.find((c) => c.name === 'herdr_core_version');
    assert.equal(ver.ok, true);
    assert.equal(ver.detail, '0.1.20');
  });
});

describe('resume into shell-only Herdr tab', () => {
  let home;
  let stubDir;
  let stubCursor;
  let stubHc;
  let hcLog;
  let sessionCwd;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-shell-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    stubHc = path.join(stubDir, 'hc');
    hcLog = path.join(stubDir, 'hc-shell.log');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
if [[ "\${1:-}" == "create-chat" ]]; then echo "deadbeef-1111-4111-8111-ffffffffffff"; exit 0; fi
echo ok; exit 0
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.AF_HC_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const cmd = process.argv[2];
if (cmd === 'ls') {
  process.stdout.write(process.env.AF_HC_LS_JSON || JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
if (cmd === 'get') {
  process.stdout.write(process.env.AF_HC_LS_JSON
    ? JSON.parse(process.env.AF_HC_LS_JSON).terminals[0]
    : JSON.stringify({ address: 't1', state: 'live', agent: 'zsh', labels: {} }));
  process.exit(0);
}
if (cmd === 'run' || cmd === 'send') process.exit(0);
process.exit(0);
`,
      { mode: 0o755 }
    );
  });
  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-shell-home-'));
    sessionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-shell-cwd-'));
    try {
      fs.unlinkSync(hcLog);
    } catch (_) {}
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sessionCwd, { recursive: true, force: true });
  });

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      AF_HC_LOG: hcLog,
      AGENTFLEET_HC_BIN: stubHc,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }
  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], { encoding: 'utf8', env: env(extra) });
  }
  function seed(title) {
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry').add({
      title,
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: sessionCwd,
      engine: 'cursor',
      status: 'active',
      herdr: { runtime: 'running', checkedAt: '2026-11-01T00:00:00.000Z' },
    });
  }
  function readLog() {
    if (!fs.existsSync(hcLog)) return [];
    return fs
      .readFileSync(hcLog, 'utf8')
      .split(/\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  function shellLs(s, agent = 'zsh') {
    return JSON.stringify({
      terminals: [
        {
          address: 't9',
          name: 'shell-tab',
          state: 'live',
          agent,
          cwd: sessionCwd,
          labels: { af_id: s.id, title: s.title },
        },
      ],
      hidden_finished: 0,
    });
  }
  function runningLs(s) {
    return JSON.stringify({
      terminals: [
        {
          address: 't9',
          name: 'shell-tab',
          state: 'live',
          agent: 'env',
          cwd: sessionCwd,
          labels: { af_id: s.id, title: s.title },
        },
      ],
      hidden_finished: 0,
    });
  }

  it('live shell-only → exactly one hc send with cd+command, zero hc run', () => {
    const s = seed('ShellResume');
    const r = af(['resume', s.title, '--via', 'herdr', '--no-open', '--no-herdr-app'], {
      AF_HC_LS_JSON: shellLs(s, 'zsh'),
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const log = readLog();
    const runs = log.filter((e) => e.argv[0] === 'run');
    const sends = log.filter((e) => e.argv[0] === 'send');
    assert.equal(runs.length, 0, JSON.stringify(log));
    assert.equal(sends.length, 1, JSON.stringify(log));
    assert.equal(sends[0].argv[1], 't9');
    const text = sends[0].argv[2];
    const norm = herdrapp.normalizeCwd(sessionCwd);
    assert.match(text, new RegExp(`cd '${norm.replace(/'/g, `'\\''`)}' &&`));
    assert.match(text, /cursor-agent/);
    assert.match(text, /--resume/);
    assert.match(text, /--workspace/);
  });

  it('dry-run prints hc send without executing', () => {
    const s = seed('ShellDry');
    const r = af(['resume', s.title, '--via', 'herdr', '--dry-run', '--no-herdr-app'], {
      AF_HC_LS_JSON: shellLs(s),
    });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /hc send/);
    assert.match(r.stdout, /cd /);
    const log = readLog().filter((e) => e.argv[0] === 'send' || e.argv[0] === 'run');
    assert.equal(log.length, 0);
  });

  it('live running terminal → no send, skip/attach as today', () => {
    const s = seed('StillRunning');
    const r = af(['resume', s.title, '--via', 'herdr', '--no-open', '--no-herdr-app'], {
      AF_HC_LS_JSON: runningLs(s),
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stderr + r.stdout, /already live|Attach:/i);
    const log = readLog();
    assert.equal(log.filter((e) => e.argv[0] === 'send').length, 0);
    assert.equal(log.filter((e) => e.argv[0] === 'run').length, 0);
  });

  it('af ls shows HERDR=shell for shell-only', () => {
    const s = seed('LsShell');
    const r = af(['ls', '--json', '--all'], { AF_HC_LS_JSON: shellLs(s, '-zsh') });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.sessions[0].herdr.runtime, 'shell');
  });

  it('af wait on shell-only exits 1 with clear message', () => {
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    const parent = registry.add({
      title: 'WaitShellM',
      chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: sessionCwd,
      role: 'master',
    });
    const w = registry.add({
      title: 'WaitShell-w1',
      chatId: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: sessionCwd,
      role: 'worker',
      parent: parent.id,
      workerStatus: 'running',
    });
    const r = af(
      ['wait', w.title, '--timeout', '1', '--interval', '0.05'],
      {
        AF_HC_LS_JSON: JSON.stringify({
          terminals: [
            {
              address: 't1',
              name: 'waitshell-w1',
              state: 'live',
              agent: 'bash',
              labels: { af_id: w.id },
            },
          ],
          hidden_finished: 0,
        }),
      }
    );
    assert.equal(r.status, 1, r.stderr + r.stdout);
    assert.match(r.stderr, /shell only/i);
    assert.match(r.stderr, /af resume/);
  });

  it('concurrent resumes of shell-only → exactly one send', async () => {
    const s = seed('ConcurrentShell');
    const ls = shellLs(s);
    const e = env({ AF_HC_LS_JSON: ls });
    // Slow send so the second hits the launch lock.
    fs.writeFileSync(
      path.join(stubDir, 'hc'),
      `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.AF_HC_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const cmd = process.argv[2];
if (cmd === 'ls') {
  process.stdout.write(process.env.AF_HC_LS_JSON || '{\"terminals\":[]}');
  process.exit(0);
}
if (cmd === 'send') {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, 600);
  process.exit(0);
}
if (cmd === 'run') process.exit(0);
process.exit(0);
`,
      { mode: 0o755 }
    );
    function start() {
      return spawn(process.execPath, [afJs, 'resume', s.title, '--via', 'herdr', '--no-open', '--no-herdr-app'], {
        encoding: 'utf8',
        env: e,
      });
    }
    const a = start();
    await new Promise((r) => setTimeout(r, 80));
    const b = start();
    const results = await Promise.all(
      [a, b].map(
        (child) =>
          new Promise((resolve) => {
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (d) => (stdout += d));
            child.stderr.on('data', (d) => (stderr += d));
            child.on('close', (code) => resolve({ code, stdout, stderr }));
          })
      )
    );
    const log = readLog();
    const sends = log.filter((e) => e.argv && e.argv[0] === 'send');
    const runs = log.filter((e) => e.argv && e.argv[0] === 'run');
    assert.equal(sends.length, 1, JSON.stringify({ log, results }));
    assert.equal(runs.length, 0);
  });
});
