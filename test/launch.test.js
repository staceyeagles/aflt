'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('Herdr discovery refuse + launch lock', () => {
  let home;
  let stubDir;
  let stubCursor;
  let stubHc;
  let hcLog;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-launch-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    stubHc = path.join(stubDir, 'hc');
    hcLog = path.join(stubDir, 'hc.log');
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
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2), t: Date.now() }) + '\\n');
const cmd = process.argv[2];
if (process.env.AF_HC_LS_FAIL === '1' && (cmd === 'ls' || cmd === undefined)) {
  process.stderr.write('ls boom\\n');
  process.exit(3);
}
if (cmd === 'ls') {
  if (process.env.AF_HC_LS_JSON) {
    process.stdout.write(process.env.AF_HC_LS_JSON);
    process.exit(0);
  }
  // After a run, report the session live so the second resume can skip.
  const liveId = process.env.AF_HC_LIVE_ID || '';
  if (liveId && fs.existsSync(process.env.AF_HC_RAN_FLAG || '')) {
    process.stdout.write(JSON.stringify({
      terminals: [{ address: 't1', name: 'locked', state: 'live', labels: { af_id: liveId } }],
      hidden_finished: 0,
    }));
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
if (cmd === 'get') {
  process.stdout.write(JSON.stringify({ address: 't1', state: 'live', labels: {} }));
  process.exit(0);
}
if (cmd === 'run') {
  const flag = process.env.AF_HC_RAN_FLAG;
  if (flag) fs.writeFileSync(flag, '1');
  const sleepMs = Number(process.env.AF_HC_RUN_SLEEP_MS || '0');
  if (sleepMs > 0) {
    const sab = new SharedArrayBuffer(4);
    Atomics.wait(new Int32Array(sab), 0, 0, sleepMs);
  }
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 }
    );
  });

  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-launch-home-'));
    try {
      fs.unlinkSync(hcLog);
    } catch (_) {}
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      AF_HC_LOG: hcLog,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }
  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], { encoding: 'utf8', env: env(extra) });
  }
  function seed(title = 'LockMe') {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    return registry.add({
      title,
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      engine: 'cursor',
      status: 'active',
      // mark herdr-involved so ls shows unknown on discovery failure
      herdr: { runtime: 'running', checkedAt: '2026-11-01T00:00:00.000Z' },
    });
  }

  it('discovery fail refuses launch with hint; ls shows unknown', () => {
    const s = seed('DiscFail');
    const r = af(['resume', s.title, '--via', 'herdr', '--no-open', '--no-herdr-app'], {
      AF_HC_LS_FAIL: '1',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /herdr discovery failed/i);
    assert.match(r.stderr + r.stdout, /hc server status/);
    assert.match(r.stderr + r.stdout, /--via plain/);

    const ls = af(['ls', '--json', '--all'], { AF_HC_LS_FAIL: '1' });
    assert.equal(ls.status, 0, ls.stderr);
    const body = JSON.parse(ls.stdout);
    assert.equal(body.queryOk, false);
    assert.equal(body.sessions[0].herdr.runtime, 'unknown');
  });

  it('two concurrent resumes of same id → exactly one hc run', async () => {
    const s = seed('Concurrent');
    const ranFlag = path.join(home, 'ran.flag');
    const e = env({
      AF_HC_RUN_SLEEP_MS: '800',
      AF_HC_RAN_FLAG: ranFlag,
      AF_HC_LIVE_ID: s.id,
      AF_HC_LS_JSON: JSON.stringify({ terminals: [], hidden_finished: 0 }),
    });
    // Clear ls json after first run so subsequent ls can use live reporting —
    // actually launchViaHerdr re-fetches; first holds lock during run sleep.
    delete e.AF_HC_LS_JSON;

    function start() {
      return spawn(process.execPath, [afJs, 'resume', s.title, '--via', 'herdr', '--no-open', '--no-herdr-app'], {
        encoding: 'utf8',
        env: e,
      });
    }
    const a = start();
    await new Promise((r) => setTimeout(r, 100));
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
    const log = fs.existsSync(hcLog)
      ? fs
          .readFileSync(hcLog, 'utf8')
          .split(/\n/)
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    const runs = log.filter((e) => e.argv && e.argv[0] === 'run');
    assert.equal(runs.length, 1, `expected 1 run, got ${runs.length}: ${JSON.stringify(log)}\n${JSON.stringify(results)}`);
    const texts = results.map((r) => r.stderr + r.stdout).join('\\n');
    assert.ok(
      /already running\/launching|already live|Launched 1|Attach:/i.test(texts),
      texts
    );
  });
});
