'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('af spawn / children / result', () => {
  let home;
  let stubDir;
  let stubCursor;
  let envFile;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-spawn-stub-'));
    envFile = path.join(stubDir, 'env.json');
    stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  echo "deadbeef-1111-4111-8111-ffffffffffff"
  exit 0
fi
# Headless print-mode: record env and exit
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({
  id: process.env.AGENTFLEET_ID || null,
  parent: process.env.AGENTFLEET_PARENT || null,
  result: process.env.AGENTFLEET_RESULT || null,
  argv: process.argv.slice(2),
}, null, 2));' "${envFile}"
if [[ "\${AF_STUB_EXIT:-0}" != "0" ]]; then
  exit "\$AF_STUB_EXIT"
fi
echo "stub-ok"
exit 0
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-spawn-home-'));
    try {
      fs.unlinkSync(envFile);
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
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: afEnv(extraEnv),
    });
  }

  function seedParent(title = 'Auth') {
    const registry = (() => {
      delete require.cache[require.resolve('../lib/util')];
      delete require.cache[require.resolve('../lib/orchestrate')];
      delete require.cache[require.resolve('../lib/registry')];
      process.env.AGENTFLEET_HOME = home;
      return require('../lib/registry');
    })();
    return registry.add({
      title,
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      engine: 'cursor',
      status: 'active',
    });
  }

  it('spawn --dry-run does not write registry and prints a command', () => {
    const parent = seedParent();
    const r = af([
      'spawn',
      '--parent',
      parent.title,
      '--prompt',
      'Extract helpers',
      '--dry-run',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('[dry-run]'), r.stderr);
    assert.ok(r.stdout.includes('-p') || r.stdout.includes('Extract'), r.stdout);
    const sessions = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'));
    assert.equal(sessions.sessions.length, 1);
    assert.ok(!sessions.sessions[0].role);
  });

  it('spawn headless creates worker, sets parent role, updates workerStatus, passes env', () => {
    const parent = seedParent();
    const r = af([
      'spawn',
      '--parent',
      parent.id,
      '--prompt',
      'Extract JWT helpers into lib/auth.js please',
      '--task',
      'JWT helpers',
    ]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(r.stderr.includes('worker:') || r.stderr.includes('result:'), r.stderr);

    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    const master = registry.find(parent.id);
    assert.equal(master.role, 'master');

    const kids = registry.list({ includeDone: true }).filter((s) => s.parent === parent.id);
    assert.equal(kids.length, 1);
    const w = kids[0];
    assert.equal(w.role, 'worker');
    assert.equal(w.task, 'JWT helpers');
    assert.equal(w.workerStatus, 'done');
    assert.equal(w.parent, parent.id);
    assert.ok(w.result.endsWith(path.join('results', `${w.id}.md`)));
    assert.ok(fs.existsSync(path.join(home, 'results')));
    assert.ok(w.prompt.includes('## Summary'));
    assert.ok(w.prompt.includes('Extract JWT helpers'));

    assert.ok(fs.existsSync(envFile), 'stub should have written env file');
    const seen = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(seen.id, w.id);
    assert.equal(seen.parent, parent.id);
    assert.equal(seen.result, w.result);
  });

  it('spawn headless marks workerStatus failed on nonzero exit', () => {
    const parent = seedParent('FailMaster');
    const r = af(
      ['spawn', '--parent', parent.title, '--prompt', 'will fail', '--title', 'FailMaster-w1'],
      { AF_STUB_EXIT: '7' }
    );
    assert.equal(r.status, 7, r.stderr);

    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    const w = registry.find('FailMaster-w1');
    assert.ok(w);
    assert.equal(w.workerStatus, 'failed');
    assert.equal(w.lastExit, 7);
  });

  it('children lists workers (table + json) and no-arg masters summary', () => {
    const parent = seedParent('Fleet');
    const spawn = af(['spawn', '--parent', parent.title, '--prompt', 'child work']);
    assert.equal(spawn.status, 0, spawn.stderr);

    const table = af(['children', parent.title]);
    assert.equal(table.status, 0, table.stderr);
    assert.ok(table.stdout.includes('TITLE'));
    assert.ok(table.stdout.includes('WORKER'));
    assert.ok(table.stdout.includes('Fleet-w1'));

    const json = af(['children', parent.title, '--json']);
    assert.equal(json.status, 0, json.stderr);
    const rows = JSON.parse(json.stdout);
    assert.ok(Array.isArray(rows));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].workerStatus, 'done');
    assert.ok('resultExists' in rows[0]);
    assert.ok('herdr' in rows[0]);

    const summary = af(['children']);
    assert.equal(summary.status, 0, summary.stderr);
    assert.ok(summary.stdout.includes('Fleet') || summary.stdout.includes('KIDS'), summary.stdout);

    const summaryJson = af(['children', '--json']);
    assert.equal(summaryJson.status, 0);
    const masters = JSON.parse(summaryJson.stdout);
    assert.ok(masters.masters);
    assert.ok(masters.masters.some((m) => m.title === 'Fleet'));
  });

  it('children with AGENTFLEET_PARENT resolves master', () => {
    const parent = seedParent('EnvParent');
    af(['spawn', '--parent', parent.title, '--prompt', 'x']);
    const r = af(['children', '--json'], { AGENTFLEET_PARENT: parent.id });
    assert.equal(r.status, 0, r.stderr);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows.length, 1);
    assert.ok(rows[0].title.startsWith('EnvParent-w'));
  });

  it('result prints handoff, --path, and missing fallback', () => {
    const parent = seedParent('Res');
    const spawn = af(['spawn', '--parent', parent.title, '--prompt', 'make handoff']);
    assert.equal(spawn.status, 0, spawn.stderr);

    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    const w = registry.list({ includeDone: true }).find((s) => s.parent === parent.id);
    assert.ok(w);

    const pathOnly = af(['result', w.title, '--path']);
    assert.equal(pathOnly.status, 0);
    assert.equal(pathOnly.stdout.trim(), w.result);

    // Headless spawn now writes an af-fallback handoff when the worker omits the file.
    assert.ok(fs.existsSync(w.result));
    const afterSpawn = af(['result', w.title]);
    assert.equal(afterSpawn.status, 0, afterSpawn.stderr);
    assert.ok(afterSpawn.stdout.includes('## Summary'));

    fs.unlinkSync(w.result);
    const missing = af(['result', w.title]);
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes('no handoff yet'), missing.stderr);
    assert.ok(missing.stdout.length > 0 || missing.stderr.includes(w.result));

    fs.mkdirSync(path.dirname(w.result), { recursive: true, mode: 0o700 });
    fs.writeFileSync(w.result, '## Summary\nok\n', 'utf8');
    const ok = af(['result', w.title]);
    assert.equal(ok.status, 0, ok.stderr);
    assert.ok(ok.stdout.includes('## Summary'));
    assert.ok(ok.stdout.includes('ok'));
  });

  it('spawn fails clearly when parent is missing', () => {
    const r = af(['spawn', '--parent', 'no-such-master', '--prompt', 'x']);
    assert.equal(r.status, 1);
    assert.ok(/not found/i.test(r.stderr));
  });

  it('spawn --detach returns immediately; supervisor records done + handoff', async () => {
    const parent = seedParent('DetachMaster');
    const writeStub = path.join(stubDir, 'cursor-agent-write');
    fs.writeFileSync(
      writeStub,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  echo "deadbeef-3333-4333-8333-$(printf '%012x' $RANDOM$RANDOM)"
  exit 0
fi
if [[ -n "\${AGENTFLEET_RESULT:-}" ]]; then
  printf '%s\\n' '## Summary' 'detached ok' '## Files changed' 'none' '## Open questions' 'none' > "\$AGENTFLEET_RESULT"
fi
sleep 0.2
echo stub-ok
exit 0
`,
      { mode: 0o755 }
    );
    const r = af(
      [
        'spawn',
        '--parent',
        parent.title,
        '--prompt',
        'Detach work',
        '--detach',
        '--json',
      ],
      { AGENTFLEET_CURSOR_BIN: writeStub }
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.detached, true);
    assert.ok(body.worker.id);
    assert.equal(body.worker.workerStatus, 'running');

    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');

    let worker = null;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      worker = registry.find(body.worker.id);
      // Wait for terminal status AND handoff attribution (same critical write).
      if (
        worker &&
        worker.workerStatus === 'done' &&
        (worker.resultRunId || worker.resultSource === 'worker' || worker.resultSource === 'af-fallback')
      ) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(worker, 'worker missing');
    assert.equal(worker.workerStatus, 'done', JSON.stringify(worker));
    assert.equal(worker.lastExit, 0);
    assert.equal(worker.runPid, null);
    assert.ok(
      worker.resultRunId || worker.resultSource === 'worker' || worker.resultSource === 'af-fallback',
      JSON.stringify({
        resultRunId: worker.resultRunId,
        resultSource: worker.resultSource,
      })
    );
    assert.ok(fs.existsSync(worker.result));
    assert.match(fs.readFileSync(worker.result, 'utf8'), /detached ok/);
  });

  it('spawn --detach refuses --interactive', () => {
    const parent = seedParent('NoCombo');
    const r = af([
      'spawn',
      '--parent',
      parent.title,
      '--prompt',
      'x',
      '--detach',
      '--interactive',
    ]);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /detach.*headless|interactive/i);
  });
});
