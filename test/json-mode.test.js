'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('JSON mode: exact one JSON value + excerpts', () => {
  let home;
  let stubDir;
  let stubCursor;
  let stubHc;
  let hcLog;
  let herdrAppBin;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-json-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    stubHc = path.join(stubDir, 'hc');
    hcLog = path.join(stubDir, 'hc.log');
    herdrAppBin = path.join(stubDir, 'herdr-app');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  echo "deadbeef-1111-4111-8111-ffffffffffff"
  exit 0
fi
# Noisy multi-line engine output (must NOT appear on af stdout in --json)
echo "LINE1 noisy engine"
echo "LINE2 more noise"
echo "LINE3 final answer"
if [[ "\${AF_STUB_EXIT:-0}" != "0" ]]; then
  exit "\$AF_STUB_EXIT"
fi
exit 0
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.AF_HC_LOG;
const failCmd = process.env.AF_HC_FAIL || '';
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const cmd = process.argv[2];
if (failCmd && cmd === failCmd) {
  process.stderr.write('hc ' + cmd + ' failed by test\\n');
  process.exit(2);
}
if (cmd === 'ls') {
  const raw = process.env.AF_HC_LS_JSON;
  process.stdout.write(raw || JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
if (cmd === 'get') {
  process.stdout.write(JSON.stringify({ address: 't1', state: 'finished', labels: {} }));
  process.exit(0);
}
if (cmd === 'run') process.exit(0);
if (cmd === 'label' || cmd === 'keep') process.exit(0);
process.exit(0);
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      herdrAppBin,
      `#!/usr/bin/env node
if (process.argv[2] === 'status') process.exit(0);
if (process.argv[2] === 'do' && process.argv[3] === 'tab.rename') {
  if (process.env.AF_TAB_RENAME_FAIL === '1') {
    process.stderr.write('tab.rename denied\\n');
    process.exit(1);
  }
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-json-home-'));
    try {
      fs.unlinkSync(hcLog);
    } catch (_) {}
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      AGENTFLEET_HERDR_APP_BIN: herdrAppBin,
      AF_HC_LOG: hcLog,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: env(extraEnv),
    });
  }

  function seed(partial = {}) {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    return registry.add({
      title: partial.title || 'JsonSeed',
      chatId: partial.chatId || 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      engine: 'cursor',
      status: 'active',
      role: partial.role,
      parent: partial.parent,
      workerStatus: partial.workerStatus,
      ...partial,
    });
  }

  function assertExactJson(r, fields = []) {
    assert.equal(r.status, 0, r.stderr + r.stdout);
    let body;
    assert.doesNotThrow(() => {
      body = JSON.parse(r.stdout);
    }, `stdout not exact JSON: ${JSON.stringify(r.stdout)}`);
    // Engine lines may appear inside outputExcerpt JSON string; raw prelude must not.
    const prelude = String(r.stdout).trimStart();
    assert.ok(prelude.startsWith('{') || prelude.startsWith('['), 'stdout must start with JSON');
    for (const f of fields) assert.ok(f in body, `missing field ${f}`);
    if ('outputPath' in body) {
      assert.ok(body.outputPath);
      assert.ok(fs.existsSync(body.outputPath));
      const log = fs.readFileSync(body.outputPath, 'utf8');
      assert.ok(log.includes('LINE1 noisy'), 'engine output should be in run log');
      assert.ok(typeof body.outputExcerpt === 'string');
      assert.ok(body.outputExcerpt.length <= 2000);
      assert.ok(body.outputExcerpt.includes('LINE3') || body.outputExcerpt.includes('noisy'));
    }
    return body;
  }

  it('af run --json', () => {
    const r = af(['run', 'JsonRun', '--prompt', 'Reply pong', '--cwd', home, '--json']);
    const body = assertExactJson(r, ['ok', 'outputPath', 'outputExcerpt', 'session']);
    assert.equal(body.ok, true);
  });

  it('af spawn --json (headless)', () => {
    seed({ title: 'JsonParent', chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' });
    const r = af([
      'spawn',
      '--parent',
      'JsonParent',
      '--prompt',
      'Do work',
      '--json',
    ]);
    const body = assertExactJson(r, ['ok', 'outputPath', 'outputExcerpt', 'worker']);
    assert.equal(body.ok, true);
    assert.equal(body.worker.workerStatus, 'done');
  });

  it('af master --headless --json', () => {
    const r = af([
      'master',
      '--goal',
      'Ship it',
      '--headless',
      '--cwd',
      home,
      '--title',
      'JsonMaster',
      '--json',
      '--force',
    ]);
    const body = assertExactJson(r, ['ok', 'outputPath', 'outputExcerpt', 'master']);
    assert.equal(body.ok, true);
    assert.equal(body.master.role, 'master');
  });

  it('af send --json headless continue', () => {
    const parent = seed({
      title: 'SendParent',
      chatId: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
      role: 'master',
    });
    const worker = seed({
      title: 'SendWorker',
      chatId: 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee',
      role: 'worker',
      parent: parent.id,
      workerStatus: 'done',
    });
    const r = af(['send', worker.title, 'continue please', '--json'], {
      AF_HC_LS_JSON: JSON.stringify({ terminals: [], hidden_finished: 0 }),
    });
    const body = assertExactJson(r, ['ok', 'outputPath', 'outputExcerpt']);
    assert.equal(body.ok, true);
  });
});

describe('JSON/human shared failure + adopt ok', () => {
  let home;
  let stubDir;
  let stubCursor;
  let stubHc;
  let herdrAppBin;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-fail-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    stubHc = path.join(stubDir, 'hc');
    herdrAppBin = path.join(stubDir, 'herdr-app');
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
const failCmd = process.env.AF_HC_FAIL || '';
const cmd = process.argv[2];
if (failCmd && cmd === failCmd) {
  process.stderr.write('forced fail ' + cmd + '\\n');
  process.exit(2);
}
if (cmd === 'ls') {
  const raw = process.env.AF_HC_LS_JSON;
  if (raw) {
    process.stdout.write(raw);
    process.exit(0);
  }
  process.stdout.write(JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
if (cmd === 'get') {
  process.stdout.write(JSON.stringify({ address: 't9', state: 'live', labels: {} }));
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      herdrAppBin,
      `#!/usr/bin/env node
if (process.argv[2] === 'status') process.exit(0);
if (process.argv[2] === 'do' && process.argv[3] === 'tab.rename') {
  if (process.env.AF_TAB_RENAME_FAIL === '1') {
    process.stderr.write('rename boom\\n');
    process.exit(1);
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
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-fail-home-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      AGENTFLEET_HERDR_APP_BIN: herdrAppBin,
      AF_HERDR_APP_RENAME_WAIT_MS: '0',
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }
  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], { encoding: 'utf8', env: env(extra) });
  }
  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  it('spawn --interactive --json fails when hc run fails; not left running', () => {
    const registry = loadRegistry();
    registry.add({
      title: 'FailParent',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      engine: 'cursor',
    });
    const r = af(
      [
        'spawn',
        '--parent',
        'FailParent',
        '--prompt',
        'x',
        '--interactive',
        '--json',
        '--no-herdr-app',
      ],
      { AF_HC_FAIL: 'run', AF_HC_LS_JSON: JSON.stringify({ terminals: [], hidden_finished: 0 }) }
    );
    assert.notEqual(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    assert.ok(body.error);
    const workers = registry.list({ includeDone: true }).filter((s) => s.role === 'worker');
    assert.equal(workers.length, 1);
    assert.equal(workers[0].workerStatus, 'failed');
    assert.ok(workers[0].lastError);
  });

  it('master --json fails when hc run fails; not left running', () => {
    const r = af(
      [
        'master',
        '--goal',
        'Boom',
        '--cwd',
        home,
        '--title',
        'FailMaster',
        '--json',
        '--no-herdr-app',
      ],
      { AF_HC_FAIL: 'run', AF_HC_LS_JSON: JSON.stringify({ terminals: [], hidden_finished: 0 }) }
    );
    assert.notEqual(r.status, 0);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, false);
    const registry = loadRegistry();
    const m = registry.find('FailMaster');
    assert.equal(m.workerStatus, 'failed');
    assert.ok(m.lastError);
  });

  it('adopt --json: label failure => ok:false; tab rename failure does not flip ok', () => {
    const registry = loadRegistry();
    const s = registry.add({
      title: 'AdoptMe',
      chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      engine: 'cursor',
    });
    const lsLabelFail = JSON.stringify({
      terminals: [
        {
          address: 't1',
          name: 'adoptme',
          state: 'live',
          labels: { af_id: s.id, title: s.title },
        },
      ],
      hidden_finished: 0,
    });
    const failLabel = af(['adopt', 'AdoptMe', '--json'], {
      AF_HC_FAIL: 'label',
      AF_HC_LS_JSON: lsLabelFail,
    });
    assert.notEqual(failLabel.status, 0);
    const bodyFail = JSON.parse(failLabel.stdout);
    assert.equal(bodyFail.ok, false);
    assert.equal(bodyFail.adopted[0].ok, false);
    assert.ok(bodyFail.adopted[0].error);

    const okRenameFail = af(['adopt', 'AdoptMe', '--json'], {
      AF_HC_LS_JSON: lsLabelFail,
      AF_TAB_RENAME_FAIL: '1',
    });
    assert.equal(okRenameFail.status, 0, okRenameFail.stderr);
    const bodyOk = JSON.parse(okRenameFail.stdout);
    assert.equal(bodyOk.ok, true);
    assert.equal(bodyOk.adopted[0].ok, true);
    assert.equal(bodyOk.adopted[0].tabRename.ok, false);
    assert.ok(bodyOk.adopted[0].tabRename.error);
    assert.match(okRenameFail.stderr, /tab\.rename/);
  });
});
