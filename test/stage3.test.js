'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('af stage 3: send-grace wait + af master', () => {
  let home;
  let stubDir;
  let stubCursor;
  let stubHc;
  let envFile;
  let hcLog;
  let statusSeqFile;
  let getCountFile;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stage3-stub-'));
    envFile = path.join(stubDir, 'env.json');
    hcLog = path.join(stubDir, 'hc-log.jsonl');
    statusSeqFile = path.join(stubDir, 'status-seq.json');
    getCountFile = path.join(stubDir, 'get-count');
    stubCursor = path.join(stubDir, 'cursor-agent');
    stubHc = path.join(stubDir, 'hc');

    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'const c=require("crypto"); process.stdout.write(c.randomUUID()+"\\n");'
  exit 0
fi
node -e 'const fs=require("fs"); const out=process.argv[1]; fs.writeFileSync(out, JSON.stringify({
  id: process.env.AGENTFLEET_ID || null,
  parent: process.env.AGENTFLEET_PARENT || null,
  result: process.env.AGENTFLEET_RESULT || null,
  plan: process.env.AGENTFLEET_PLAN || null,
  role: process.env.AGENTFLEET_ROLE || null,
  path: process.env.PATH || null,
  argv: process.argv.slice(2),
}, null, 2));' "${envFile}" "$@"
echo "stub-ok final answer from engine"
exit 0
`,
      { mode: 0o755 }
    );

    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env bash
set -euo pipefail
log="${hcLog}"
seqf="${statusSeqFile}"
cntf="${getCountFile}"
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
    if [[ -f "\$seqf" ]]; then
      node -e '
        const fs=require("fs");
        const seqf=process.argv[1];
        const cntf=process.argv[2];
        const seq=JSON.parse(fs.readFileSync(seqf,"utf8"));
        let n=0;
        try { n=Number(fs.readFileSync(cntf,"utf8"))||0; } catch(_) {}
        const state=seq[Math.min(n, seq.length-1)];
        fs.writeFileSync(cntf, String(n+1));
        process.stdout.write(JSON.stringify({
          address:"t99", name:"stub", state:"live",
          status: state ? { state } : null,
          labels:{}
        })+"\\n");
      ' "\$seqf" "\$cntf"
      exit 0
    fi
    if [[ -n "\${AF_HC_GET_JSON:-}" ]]; then
      printf '%s\\n' "\$AF_HC_GET_JSON"
    else
      echo '{"address":"t99","name":"stub","state":"live","status":null,"labels":{}}'
    fi
    exit 0
    ;;
  run|send|interrupt|kill)
    exit 0
    ;;
  *)
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
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stage3-home-'));
    for (const f of [envFile, hcLog, statusSeqFile, getCountFile]) {
      try {
        fs.unlinkSync(f);
      } catch (_) {
        /* ignore */
      }
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

  function af(args, extraEnv = {}, opts = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: afEnv(extraEnv),
      timeout: opts.timeout != null ? opts.timeout : 20000,
    });
  }

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function readHcLog() {
    if (!fs.existsSync(hcLog)) return [];
    return fs
      .readFileSync(hcLog, 'utf8')
      .split(/\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }

  it('wait send-grace: ignores stale done until working then waiting on done', () => {
    const registry = loadRegistry();
    const w = registry.add({
      title: 'Grace-w1',
      chatId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      cwd: home,
      engine: 'cursor',
      role: 'worker',
      task: 't',
      workerStatus: 'running',
      lastSendAt: new Date().toISOString(),
    });

    fs.writeFileSync(statusSeqFile, JSON.stringify(['done', 'working', 'done']), 'utf8');
    fs.writeFileSync(getCountFile, '0', 'utf8');

    const lsJson = JSON.stringify({
      terminals: [
        {
          address: 't99',
          name: 'Grace-w1',
          state: 'live',
          status: { state: 'done' },
          labels: { af_id: w.id },
        },
      ],
      hidden_finished: 0,
      machines: [],
    });

    const r = af(
      [
        'wait',
        'Grace-w1',
        '--interval',
        '0.05',
        '--timeout',
        '20', // generous: full suite runs files in parallel and each poll spawns the hc stub
        '--send-grace',
        '60', // longer than the timeout, so 'waiting' can only come from a working sighting
        '--json',
      ],
      { AF_HC_LS_JSON: lsJson }
    );
    assert.equal(r.status, 3, r.stderr + r.stdout);
    const rows = JSON.parse(r.stdout);
    assert.equal(rows[0].workerStatus, 'waiting');
    // get should have advanced through the sequence
    const gets = Number(fs.readFileSync(getCountFile, 'utf8'));
    assert.ok(gets >= 3, `expected >=3 get calls, got ${gets}`);
  });

  it('af master --dry-run does not write registry', () => {
    const r = af([
      'master',
      '--goal',
      'Ship the feature',
      '--dry-run',
      '--cwd',
      home,
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('[dry-run]'), r.stderr);
    assert.ok(!fs.existsSync(path.join(home, 'sessions.json')) || (() => {
      const data = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'));
      return (data.sessions || []).length === 0;
    })());
  });

  it('af master --headless: role master, env, prompt, add-dir, plan', () => {
    const r = af([
      'master',
      '--goal',
      'Extract helpers and add tests',
      '--headless',
      '--force',
      '--cwd',
      home,
      '--title',
      'HeadlessMaster',
    ]);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(/master:|role:\s*master|HeadlessMaster/i.test(r.stdout + r.stderr), r.stdout + r.stderr);

    const registry = loadRegistry();
    const m = registry.find('HeadlessMaster');
    assert.ok(m);
    assert.equal(m.role, 'master');
    assert.equal(m.workerStatus, 'done');
    assert.ok(m.result);
    assert.ok(m.plan);
    assert.ok(m.plan.includes(path.join('plans', `${m.id}.md`)));
    assert.ok(m.prompt.includes('Extract helpers and add tests'));
    assert.ok(m.prompt.includes('af spawn'));
    assert.ok(m.prompt.includes(m.id));
    assert.ok(m.prompt.includes(m.plan));
    assert.ok(!m.prompt.includes('{{GOAL}}'));
    assert.ok(!m.prompt.includes('{{PLAN}}'));

    assert.ok(fs.existsSync(envFile), 'stub should record env');
    const seen = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(seen.id, m.id);
    assert.equal(seen.result, m.result);
    assert.equal(seen.plan, m.plan);
    assert.equal(seen.role, 'master');
    assert.ok(seen.path, 'PATH should be set');
    const pathParts = String(seen.path).split(path.delimiter);
    const afDir = path.dirname(fs.realpathSync(afJs));
    const localBin = path.join(os.homedir(), '.local', 'bin');
    assert.ok(
      pathParts.includes(afDir) || pathParts.some((p) => p.endsWith(`${path.sep}bin`) || p.endsWith('/bin')),
      `PATH should include af bin dir; got ${seen.path}`
    );
    assert.ok(pathParts.includes(localBin), `PATH should include ~/.local/bin; got ${seen.path}`);
    assert.ok(seen.argv.includes('--add-dir'));
    const addDirs = [];
    for (let i = 0; i < seen.argv.length; i++) {
      if (seen.argv[i] === '--add-dir') addDirs.push(seen.argv[i + 1]);
    }
    assert.ok(addDirs.includes(path.dirname(m.result)));
    assert.ok(addDirs.includes(path.dirname(m.plan)));
  });

  it('af master interactive: hc run labels + env prefix', () => {
    const r = af(
      [
        'master',
        '--goal',
        'Orchestrate the fleet',
        '--cwd',
        home,
        '--title',
        'MasterFleet',
        '--json',
        '--no-herdr-app',
      ],
      { AF_HC_LS_JSON: JSON.stringify({ terminals: [], hidden_finished: 0, machines: [] }) }
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.master.role, 'master');
    assert.equal(body.master.title, 'MasterFleet');
    assert.equal(body.master.workerStatus, 'running');

    const log = readHcLog();
    const runs = log.filter((e) => e.argv[0] === 'run');
    assert.ok(runs.length >= 1, JSON.stringify(log));
    const argv = runs[0].argv;
    assert.ok(argv.includes('--bg'));
    assert.ok(argv.some((a) => String(a).startsWith('af_id=')));
    assert.ok(argv.some((a) => String(a) === `AGENTFLEET_ID=${body.master.id}`));
    assert.ok(argv.some((a) => String(a) === 'AGENTFLEET_ROLE=master'));
    assert.ok(argv.some((a) => String(a).startsWith('AGENTFLEET_RESULT=')));
    assert.ok(argv.some((a) => String(a).startsWith('AGENTFLEET_PLAN=')));
    assert.ok(argv.some((a) => String(a).startsWith('PATH=')));
  });

  it('headless spawn writes af-fallback handoff when worker omits result file', () => {
    const registry = loadRegistry();
    const parent = registry.add({
      title: 'FbMaster',
      chatId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      cwd: home,
      engine: 'cursor',
      status: 'active',
    });
    const r = af([
      'spawn',
      '--parent',
      parent.title,
      '--prompt',
      'count words',
      '--title',
      'FbMaster-w1',
    ]);
    assert.equal(r.status, 0, r.stderr);
    const w = loadRegistry().find('FbMaster-w1');
    assert.equal(w.resultSource, 'af-fallback');
    assert.ok(fs.existsSync(w.result));
    const body = fs.readFileSync(w.result, 'utf8');
    assert.ok(body.includes('written by af from final output'));
    assert.ok(body.includes('stub-ok final answer'));
    const kids = af(['children', parent.title, '--json']);
    assert.equal(kids.status, 0, kids.stderr);
    const rows = JSON.parse(kids.stdout);
    assert.equal(rows[0].handoff, 'af');
    assert.equal(rows[0].resultSource, 'af-fallback');
  });

  it('af wait --parent waits on children; bare wait hints when one active master', () => {
    const registry = loadRegistry();
    const parent = registry.add({
      title: 'WaitParent',
      chatId: 'cccccccc-dddd-4eee-8fff-aaaaaaaaaaaa',
      cwd: home,
      engine: 'cursor',
      role: 'master',
      status: 'active',
    });
    af(['spawn', '--parent', parent.title, '--prompt', 'x', '--title', 'WaitParent-w1']);
    const ok = af(['wait', '--parent', parent.title, '--interval', '0.05', '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    const bare = af(['wait']);
    assert.equal(bare.status, 1);
    assert.ok(/nothing to wait on/i.test(bare.stderr), bare.stderr);
    // After spawn finished, workers are done — hint only when queued/running/waiting.
    // Seed a running worker to trigger the hint.
    loadRegistry().update('WaitParent-w1', { workerStatus: 'running', runPid: 999999, runHost: 'other-host' });
    const hint = af(['wait']);
    assert.equal(hint.status, 1);
    assert.ok(/e\.g\. af wait --parent WaitParent/i.test(hint.stderr), hint.stderr);
  });

  it('af ls ID column distinguishes sibling slug ids; find accepts hex suffix', () => {
    const registry = loadRegistry();
    const a = registry.add({
      title: 'hello-af',
      chatId: '11111111-1111-4111-8111-111111111111',
      cwd: home,
      id: 'hello-af-1a2b3c',
    });
    const b = registry.add({
      title: 'hello-af-w1',
      chatId: '22222222-2222-4222-8222-222222222222',
      cwd: home,
      id: 'hello-af-w1-250815',
      parent: a.id,
      role: 'worker',
    });
    const ls = af(['ls']);
    assert.equal(ls.status, 0, ls.stderr);
    assert.ok(ls.stdout.includes('1a2b3c'), ls.stdout);
    assert.ok(ls.stdout.includes('250815'), ls.stdout);
    // First 8 chars alone would collide on "hello-af"; display must differ.
    const lines = ls.stdout.split('\n').filter((l) => /hello-af/.test(l));
    assert.ok(lines.length >= 2);
    const idCells = lines.map((l) => l.trim().split(/\s+/)[1]);
    assert.notEqual(idCells[0], idCells[1], ls.stdout);

    assert.equal(loadRegistry().find('1a2b3c').id, a.id);
    assert.equal(loadRegistry().find('-250815').id, b.id);
    assert.equal(loadRegistry().find('hello-af-w1-250815').id, b.id);
  });
});
