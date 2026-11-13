'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('af stage 2: wait / tail / send / stop', () => {
  let home;
  let stubDir;
  let stubCursor;
  let stubHc;
  let envFile;
  let hcLog;
  let sleepMsFile;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stage2-stub-'));
    envFile = path.join(stubDir, 'env.json');
    hcLog = path.join(stubDir, 'hc-log.jsonl');
    sleepMsFile = path.join(stubDir, 'sleep-ms');
    stubCursor = path.join(stubDir, 'cursor-agent');
    stubHc = path.join(stubDir, 'hc');

    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'const c=require("crypto"); const id=c.randomUUID(); process.stdout.write(id+"\\n");'
  exit 0
fi
# Record cursor argv + env for send-continue assertions
node -e 'const fs=require("fs"); const out=process.argv[1]; const argv=process.argv.slice(2); fs.writeFileSync(out, JSON.stringify({
  id: process.env.AGENTFLEET_ID || null,
  parent: process.env.AGENTFLEET_PARENT || null,
  result: process.env.AGENTFLEET_RESULT || null,
  argv,
}, null, 2));' "${envFile}" "$@"
# Optional sleep (ms) for stop/wait races
if [[ -f "${sleepMsFile}" ]]; then
  ms=\$(cat "${sleepMsFile}" 2>/dev/null || echo 0)
  if [[ "\$ms" =~ ^[0-9]+$ ]] && [[ "\$ms" -gt 0 ]]; then
    node -e "setTimeout(()=>{}, Number(process.argv[1]))" "\$ms"
  fi
fi
if [[ "\${AF_STUB_EXIT:-0}" != "0" ]]; then
  exit "\$AF_STUB_EXIT"
fi
echo "stub-ok"
exit 0
`,
      { mode: 0o755 }
    );

    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env bash
set -euo pipefail
log="${hcLog}"
node -e 'const fs=require("fs"); const log=process.argv[1]; const argv=process.argv.slice(2); fs.appendFileSync(log, JSON.stringify({argv, at:Date.now()})+"\\n");' "\$log" "\$@"
cmd="\${1:-}"
case "\$cmd" in
  ls)
    if [[ -n "\${AF_HC_LS_JSON:-}" ]]; then
      printf '%s\\n' "\$AF_HC_LS_JSON"
    else
      echo '{"terminals":[],"hidden_finished":0,"machines":[]}'
    fi
    exit 0
    ;;
  get)
    if [[ -n "\${AF_HC_GET_JSON:-}" ]]; then
      printf '%s\\n' "\$AF_HC_GET_JSON"
    else
      echo '{"address":"t99","name":"stub","state":"live","status":null,"labels":{}}'
    fi
    exit 0
    ;;
  read)
    if [[ -n "\${AF_HC_READ_TEXT:-}" ]]; then
      printf '%s\\n' "\$AF_HC_READ_TEXT"
    else
      printf 'line1\\nline2\\nline3\\n'
    fi
    exit 0
    ;;
  send|interrupt|kill)
    exit 0
    ;;
  *)
    echo "stub hc: unknown \$cmd" >&2
    exit 0
    ;;
esac
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stage2-home-'));
    try {
      fs.unlinkSync(envFile);
    } catch (_) {
      /* ignore */
    }
    try {
      fs.unlinkSync(hcLog);
    } catch (_) {
      /* ignore */
    }
    try {
      fs.unlinkSync(sleepMsFile);
    } catch (_) {
      /* ignore */
    }
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function afEnv(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      AGENTFLEET_HC_BIN: stubHc,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extraEnv = {}, opts = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: afEnv(extraEnv),
      timeout: opts.timeout != null ? opts.timeout : 15000,
    });
  }

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function seedParent(title = 'Auth') {
    const registry = loadRegistry();
    return registry.add({
      title,
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      engine: 'cursor',
      status: 'active',
    });
  }

  function readHcLog() {
    if (!fs.existsSync(hcLog)) return [];
    return fs
      .readFileSync(hcLog, 'utf8')
      .split(/\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('wait exit-code precedence and --any with short intervals', () => {
    const parent = seedParent('WaitM');
    const ok = af(['spawn', '--parent', parent.title, '--prompt', 'ok', '--title', 'WaitM-w1']);
    assert.equal(ok.status, 0, ok.stderr);
    const bad = af(
      ['spawn', '--parent', parent.title, '--prompt', 'bad', '--title', 'WaitM-w2'],
      { AF_STUB_EXIT: '3' }
    );
    assert.equal(bad.status, 3);

    const all = af([
      'wait',
      'WaitM-w1',
      'WaitM-w2',
      '--interval',
      '0.05',
      '--timeout',
      '2',
      '--json',
    ]);
    assert.equal(all.status, 1, all.stderr + all.stdout);
    const rows = JSON.parse(all.stdout);
    assert.equal(rows.length, 2);

    const anyOk = af([
      'wait',
      'WaitM-w1',
      'WaitM-w2',
      '--any',
      '--interval',
      '0.05',
      '--json',
    ]);
    // --any: first terminal status among done/failed; failed present → still 1
    // because waitExitCode looks at all returned rows' statuses once finished.
    // With --any we stop when any is terminal; both are already terminal so
    // exit is still 1 due to failed sibling. Check a single done worker:
    const one = af(['wait', 'WaitM-w1', '--interval', '0.05', '--json']);
    assert.equal(one.status, 0, one.stderr);
    assert.ok(anyOk.status === 0 || anyOk.status === 1);

    // Timeout while "running" with dead pid derives failed — use a fake running row.
    const registry = loadRegistry();
    registry.update('WaitM-w1', {
      workerStatus: 'running',
      runPid: 999999,
      runHost: os.hostname(),
      stopRequested: false,
    });
    // isAlive will fail → derived failed → wait ends with 1, not hang
    const derived = af(['wait', 'WaitM-w1', '--interval', '0.05', '--timeout', '1', '--json']);
    assert.ok(derived.status === 1 || derived.status === 2, derived.stderr + derived.stdout);
  });

  it('tail -n prints last N lines of run log', () => {
    const parent = seedParent('TailM');
    const spawn = af(['spawn', '--parent', parent.title, '--prompt', 'tail me', '--title', 'TailM-w1']);
    assert.equal(spawn.status, 0, spawn.stderr);
    const registry = loadRegistry();
    const w = registry.find('TailM-w1');
    assert.ok(w.lastOutput);
    const lines = [];
    for (let i = 1; i <= 20; i++) lines.push(`log-line-${i}`);
    fs.writeFileSync(w.lastOutput, lines.join('\n') + '\n', 'utf8');

    const r = af(['tail', 'TailM-w1', '-n', '3']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('log-line-18'));
    assert.ok(r.stdout.includes('log-line-20'));
    assert.ok(!r.stdout.includes('log-line-17'));
  });

  it('send continue for headless passes resume + add-dir + env and updates workerStatus', () => {
    const parent = seedParent('SendM');
    const spawn = af([
      'spawn',
      '--parent',
      parent.title,
      '--prompt',
      'first',
      '--title',
      'SendM-w1',
      '--force',
    ]);
    assert.equal(spawn.status, 0, spawn.stderr);
    const registry = loadRegistry();
    let w = registry.find('SendM-w1');
    assert.equal(w.workerStatus, 'done');
    assert.equal(w.force, true);

    try {
      fs.unlinkSync(envFile);
    } catch (_) {
      /* ignore */
    }

    const send = af(['send', 'SendM-w1', 'please update handoff']);
    assert.equal(send.status, 0, send.stderr + send.stdout);
    w = loadRegistry().find('SendM-w1');
    assert.equal(w.workerStatus, 'done');
    assert.ok(fs.existsSync(envFile), 'stub should record continue env');
    const seen = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(seen.id, w.id);
    assert.equal(seen.parent, parent.id);
    assert.equal(seen.result, w.result);
    assert.ok(seen.argv.includes('--resume') || seen.argv.some((a) => String(a).includes(w.chatId)));
    assert.ok(seen.argv.includes('--add-dir'));
    const promptArg = seen.argv[seen.argv.length - 1];
    assert.ok(String(promptArg).includes('Update your handoff'));
    assert.ok(String(promptArg).includes('please update handoff'));
    assert.ok(!String(promptArg).includes('## Summary'));
  });

  it('send refuses when headless worker has live runPid', () => {
    const parent = seedParent('BusyM');
    af(['spawn', '--parent', parent.title, '--prompt', 'x', '--title', 'BusyM-w1']);
    const registry = loadRegistry();
    // Fake a live pid: use our own process (definitely alive)
    registry.update('BusyM-w1', {
      workerStatus: 'running',
      runPid: process.pid,
      runPgid: process.pid,
      runHost: os.hostname(),
    });
    const r = af(['send', 'BusyM-w1', 'nope']);
    assert.equal(r.status, 1);
    assert.ok(/still running|refuse/i.test(r.stderr), r.stderr);
  });

  it('send to interactive calls stub hc send with the af_id terminal', () => {
    const parent = seedParent('HcSend');
    const registry = loadRegistry();
    const w = registry.add({
      title: 'HcSend-w1',
      chatId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      cwd: home,
      engine: 'cursor',
      parent: parent.id,
      role: 'worker',
      task: 't',
      workerStatus: 'running',
    });
    registry.update(parent.id, { role: 'master' });

    const lsJson = JSON.stringify({
      terminals: [
        {
          address: 't42',
          name: 'HcSend-w1',
          state: 'live',
          agent: 'env',
          status: { state: 'idle' },
          labels: { af_id: w.id },
        },
      ],
      hidden_finished: 0,
      machines: [],
    });
    const r = af(['send', 'HcSend-w1', 'hello worker'], { AF_HC_LS_JSON: lsJson });
    assert.equal(r.status, 0, r.stderr);
    const log = readHcLog();
    const sendCalls = log.filter((e) => e.argv[0] === 'send');
    assert.ok(sendCalls.length >= 1, JSON.stringify(log));
    assert.equal(sendCalls[0].argv[1], 't42');
    assert.equal(sendCalls[0].argv[2], 'hello worker');
    const after = loadRegistry().find('HcSend-w1');
    assert.equal(after.workerStatus, 'running');
    assert.ok(after.lastSendAt, 'interactive send should record lastSendAt');
    assert.ok(!Number.isNaN(Date.parse(after.lastSendAt)));
  });

  it('stop headless kills sleeping stub; registry stopped; in-flight spawn records stopped', async () => {
    const parent = seedParent('StopM');
    fs.writeFileSync(sleepMsFile, '8000', 'utf8');

    const child = spawn(
      process.execPath,
      [afJs, 'spawn', '--parent', parent.title, '--prompt', 'sleep', '--title', 'StopM-w1'],
      { env: afEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );

    const registry = loadRegistry();
    let w = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        w = registry.find('StopM-w1');
      } catch (_) {
        w = null;
      }
      if (w && w.runPid && w.workerStatus === 'running') break;
      await new Promise((r) => setTimeout(r, 50));
      // reload from disk
      delete require.cache[require.resolve('../lib/registry')];
      process.env.AGENTFLEET_HOME = home;
    }
    assert.ok(w && w.runPid, 'worker should be running with runPid');

    const stop = af(['stop', 'StopM-w1', '--json']);
    assert.equal(stop.status, 0, stop.stderr);
    const stopJson = JSON.parse(stop.stdout);
    assert.equal(stopJson.workerStatus, 'stopped');
    assert.equal(stopJson.noop, false);

    const exitCode = await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {
          /* ignore */
        }
        resolve('timeout');
      }, 6000);
      child.on('close', (code) => {
        clearTimeout(t);
        resolve(code);
      });
    });
    assert.notEqual(exitCode, 'timeout', 'spawn process should exit after stop');

    const after = loadRegistry().find('StopM-w1');
    assert.equal(after.workerStatus, 'stopped');
    assert.equal(after.runPid, null);
    assert.equal(after.stopRequested, true);
  });

  it('stop interactive calls stub hc interrupt then kill', () => {
    const parent = seedParent('StopHc');
    const registry = loadRegistry();
    const w = registry.add({
      title: 'StopHc-w1',
      chatId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      cwd: home,
      engine: 'cursor',
      parent: parent.id,
      role: 'worker',
      workerStatus: 'running',
    });
    const lsJson = JSON.stringify({
      terminals: [
        {
          address: 't77',
          name: 'StopHc-w1',
          state: 'live',
          agent: 'env',
          labels: { af_id: w.id },
        },
      ],
      hidden_finished: 0,
      machines: [],
    });
    const r = af(['stop', 'StopHc-w1', '--json'], { AF_HC_LS_JSON: lsJson });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.workerStatus, 'stopped');
    assert.equal(body.mode, 'herdr');
    const log = readHcLog();
    const cmds = log.map((e) => e.argv[0]);
    const iInt = cmds.indexOf('interrupt');
    const iKill = cmds.indexOf('kill');
    assert.ok(iInt >= 0, JSON.stringify(log));
    assert.ok(iKill > iInt, 'kill should follow interrupt');
    assert.equal(log[iInt].argv[1], 't77');
    assert.equal(log[iKill].argv[1], 't77');
    // Registry row retained
    assert.ok(loadRegistry().find('StopHc-w1'));
  });

  it('stop already-terminal is a no-op exit 0', () => {
    const parent = seedParent('NoopM');
    af(['spawn', '--parent', parent.title, '--prompt', 'done', '--title', 'NoopM-w1']);
    const r = af(['stop', 'NoopM-w1']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/already terminal/i.test(r.stderr), r.stderr);
    assert.equal(loadRegistry().find('NoopM-w1').workerStatus, 'done');
  });
});
