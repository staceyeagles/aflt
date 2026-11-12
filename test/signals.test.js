'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('headless signal forwarding', () => {
  let home;
  let stubDir;
  let stubCursor;
  let sleepMsFile;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sig-stub-'));
    sleepMsFile = path.join(stubDir, 'sleep-ms');
    stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'const c=require("crypto"); process.stdout.write(c.randomUUID()+"\\n");'
  exit 0
fi
ms=8000
if [[ -f "${sleepMsFile}" ]]; then
  ms=\$(cat "${sleepMsFile}" 2>/dev/null || echo 8000)
fi
node -e "setTimeout(()=>{}, Number(process.argv[1]))" "\$ms"
echo "should-not-finish"
exit 0
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-sig-home-'));
    fs.writeFileSync(sleepMsFile, '8000', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function afEnv() {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
    };
  }

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  it('SIGINT on af spawn forwards SIGTERM to engine group; exit 130; worker stopped', async () => {
    const registry = loadRegistry();
    const parent = registry.add({
      title: 'SigM',
      chatId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      cwd: home,
      engine: 'cursor',
      status: 'active',
    });

    const child = spawn(
      process.execPath,
      [afJs, 'spawn', '--parent', parent.title, '--prompt', 'sleep', '--title', 'SigM-w1'],
      { env: afEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
    );

    let w = null;
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        w = loadRegistry().find('SigM-w1');
      } catch (_) {
        w = null;
      }
      if (w && w.runPid && w.workerStatus === 'running') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(w && w.runPid, 'worker should be running with runPid');
    const enginePid = w.runPid;

    child.kill('SIGINT');
    const exit = await new Promise((resolve) => {
      const t = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch (_) {
          /* ignore */
        }
        resolve({ code: 'timeout', signal: null });
      }, 8000);
      child.on('close', (code, signal) => {
        clearTimeout(t);
        resolve({ code, signal });
      });
    });

    assert.notEqual(exit.code, 'timeout', 'af should exit after SIGINT');
    // Node may report exit 130 or null+SIGINT depending on platform/handler.
    assert.ok(
      exit.code === 130 || exit.signal === 'SIGINT' || exit.code === 0,
      `expected 130 or SIGINT, got code=${exit.code} signal=${exit.signal}`
    );
    // Prefer 130 when process.exitCode was set and main completed cleanly.
    if (exit.signal == null) {
      assert.equal(exit.code, 130);
    }

    // Engine should be dead.
    let alive = true;
    try {
      process.kill(enginePid, 0);
    } catch (_) {
      alive = false;
    }
    assert.equal(alive, false, 'engine pid should be gone');

    const after = loadRegistry().find('SigM-w1');
    assert.ok(after);
    assert.equal(after.workerStatus, 'stopped');
    assert.equal(after.runPid, null);
  });
});
