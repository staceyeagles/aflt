'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const orchestrate = require('../lib/orchestrate');

describe('handoff freshness', () => {
  it('isHandoffFresh / handoffDisplay stale vs yes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-fresh-'));
    const file = path.join(dir, 'r.md');
    fs.writeFileSync(file, 'old\n');
    const oldMtime = fs.statSync(file).mtimeMs;
    const session = {
      result: file,
      runStartedAt: new Date(Date.now() + 60000).toISOString(), // started in the future vs file
      resultMtimeAtStart: oldMtime,
    };
    assert.equal(orchestrate.isHandoffFresh(session, file), false);
    assert.equal(orchestrate.handoffDisplay(session, file), 'stale');

    // bump mtime after start
    const start = Date.now();
    fs.writeFileSync(file, 'new\n');
    const s2 = { result: file, runStartedAt: new Date(start - 1000).toISOString(), resultMtimeAtStart: start - 500 };
    assert.equal(orchestrate.isHandoffFresh(s2, file), true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ensureResultHandoff writes fallback when stale and embeds runId', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-fb-'));
    const file = path.join(dir, 'out.md');
    fs.writeFileSync(file, 'stale body\n');
    const m0 = fs.statSync(file).mtimeMs;
    const session = {
      result: file,
      runId: 'run-abc',
      runStartedAt: new Date().toISOString(),
      resultMtimeAtStart: m0,
    };
    // ensure file is older than start
    const src = orchestrate.ensureResultHandoff(session, {
      code: 0,
      timedOut: false,
      stdout: 'fallback stdout',
      resultPath: file,
      runId: 'run-abc',
    });
    assert.equal(src, 'af-fallback');
    const body = fs.readFileSync(file, 'utf8');
    assert.match(body, /af runId: run-abc/);
    assert.match(body, /fallback stdout/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  let home;
  let stubDir;
  let stubCursor;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hfresh-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then echo "deadbeef-1111-4111-8111-ffffffffffff"; exit 0; fi
# Optionally write handoff if AF_STUB_WRITE_RESULT set
if [[ -n "\${AF_STUB_WRITE_RESULT:-}" ]]; then
  printf '## Summary\\nstub handoff\\n## Files changed\\nnone\\n## Open questions\\nnone\\n' > "\$AF_STUB_WRITE_RESULT"
fi
echo "engine-out"
exit 0
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      path.join(stubDir, 'hc'),
      `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ terminals: [], hidden_finished: 0 }));
process.exit(0);
`,
      { mode: 0o755 }
    );
  });
  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hfresh-home-'));
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }
  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], { encoding: 'utf8', env: env(extra) });
  }
  function loadReg() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  it('stale handoff from previous run; fresh after worker rewrite; result --require-fresh', () => {
    const registry = loadReg();
    const parent = registry.add({
      title: 'FreshM',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: home,
      role: 'master',
    });
    // First spawn writes fallback (stub does not write result)
    let r = af([
      'spawn',
      '--parent',
      parent.title,
      '--prompt',
      'first',
      '--json',
    ]);
    assert.equal(r.status, 0, r.stderr);
    const body1 = JSON.parse(r.stdout);
    const workerId = body1.worker.id;
    const resultPath = body1.worker.result;
    assert.ok(fs.existsSync(resultPath));

    // Age the handoff and set resultMtimeAtStart to now so it looks stale for a new run
    const staleTime = Date.now() - 10000;
    fs.utimesSync(resultPath, new Date(staleTime / 1000), new Date(staleTime / 1000));
    registry.update(workerId, {
      workerStatus: 'done',
      runStartedAt: new Date().toISOString(),
      resultMtimeAtStart: Date.now(),
      resultSource: 'worker',
    });

    const kids = af(['children', parent.title, '--json']);
    const rows = JSON.parse(kids.stdout);
    const row = rows.find((x) => x.id === workerId);
    assert.equal(row.handoff, 'stale');
    assert.equal(row.stale, true);
    assert.equal(row.fresh, false);

    const res = af(['result', workerId, '--json', '--require-fresh']);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /stale/);

    // Rerun via send continue with stub writing result
    r = af(['send', workerId, 'again', '--json'], {
      AF_STUB_WRITE_RESULT: resultPath,
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const after = registry.find(workerId);
    const info = orchestrate.handoffInfo(after, resultPath);
    assert.equal(info.fresh, true);
    assert.equal(info.stale, false);

    const res2 = af(['result', workerId, '--require-fresh']);
    assert.equal(res2.status, 0, res2.stderr);
  });
});
