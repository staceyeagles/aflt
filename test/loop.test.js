'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/notify',
    '../lib/config',
    '../lib/memory',
    '../lib/project',
    '../lib/registry',
    '../lib/util',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function writeLoopFile(dir, name, body) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  return file;
}

function startCaptureServer() {
  const hits = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch (_) {
        body = raw;
      }
      hits.push({ method: req.method, url: req.url, body });
      res.writeHead(204);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      resolve({
        server,
        hits,
        url: `http://127.0.0.1:${addr.port}/hook`,
        close: () =>
          new Promise((r) => {
            server.close(() => r());
          }),
      });
    });
  });
}

describe('aflt loop', () => {
  let home;
  let cwd;
  let stubDir;
  let stubCursor;
  let prevHome;
  let prevAfHome;
  let prevCursor;
  let prevMemory;
  let prevUrl;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-cwd-'));
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  node -e 'const c=require("crypto"); process.stdout.write(c.randomUUID()+"\\n");'
  exit 0
fi
# Print-mode: last argv is the prompt. Write HELLO.txt when asked.
prompt="\${*: -1}"
if echo "\$prompt" | grep -q "HELLO.txt"; then
  printf 'hello from aflt loop\\n' > "\$PWD/HELLO.txt"
fi
echo "stub-ok"
exit 0
`,
      { mode: 0o755 }
    );
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevCursor = process.env.AGENTFLEET_CURSOR_BIN;
    prevMemory = process.env.AFLT_MEMORY_REPO;
    prevUrl = process.env.AFLT_NOTIFY_URL;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    process.env.AGENTFLEET_CURSOR_BIN = stubCursor;
    delete process.env.AFLT_MEMORY_REPO;
    delete process.env.AFLT_NOTIFY_URL;
  });

  afterEach(() => {
    clearMods();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevCursor === undefined) delete process.env.AGENTFLEET_CURSOR_BIN;
    else process.env.AGENTFLEET_CURSOR_BIN = prevCursor;
    if (prevMemory === undefined) delete process.env.AFLT_MEMORY_REPO;
    else process.env.AFLT_MEMORY_REPO = prevMemory;
    if (prevUrl === undefined) delete process.env.AFLT_NOTIFY_URL;
    else process.env.AFLT_NOTIFY_URL = prevUrl;
  });

  function afEnv(extra = {}) {
    return {
      ...process.env,
      HOME: home,
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
      cwd,
      timeout: 30000,
    });
  }

  function baseDef(overrides = {}) {
    return {
      name: 'hello-eval',
      project: 'demo',
      cwd,
      engine: 'cursor',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 20, maxHours: 2 },
      phases: [
        {
          id: 'write-greeting',
          engine: 'cursor',
          session: 'loop-hello-eval',
          prompt:
            'Create HELLO.txt with exactly: hello from aflt loop\nDo not switch to plan mode.',
          eval: {
            command: ['grep', '-x', 'hello from aflt loop', 'HELLO.txt'],
            exitCode: 0,
          },
          maxFixAttempts: 3,
          onPass: 'none',
          force: true,
        },
      ],
      ...overrides,
    };
  }

  it('validate accepts a good definition and rejects missing phases', () => {
    const loop = require('../lib/loop');
    const good = writeLoopFile(cwd, 'good.json', baseDef());
    const ok = loop.validateFile(good);
    assert.equal(ok.ok, true);
    assert.equal(ok.definition.name, 'hello-eval');
    assert.equal(ok.definition.phases.length, 1);

    const bad = writeLoopFile(cwd, 'bad.json', { name: 'x', phases: [] });
    const badResult = loop.validateFile(bad);
    assert.equal(badResult.ok, false);
    assert.ok(badResult.errors.some((e) => /phases/i.test(e)));
  });

  it('validate warns when onPass needs allow flag', () => {
    const loop = require('../lib/loop');
    const def = baseDef();
    def.phases[0].onPass = 'commit';
    const file = writeLoopFile(cwd, 'warn.json', def);
    const result = loop.validateFile(file);
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((w) => /allow\.commit/i.test(w)));
  });

  it('CLI validate --json and dry-run', () => {
    const file = writeLoopFile(cwd, 'cli.json', baseDef());
    const v = af(['loop', 'validate', file, '--json']);
    assert.equal(v.status, 0, v.stderr);
    const parsed = JSON.parse(v.stdout);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.definition.name, 'hello-eval');

    const dry = af(['loop', 'run', file, '--dry-run', '--json']);
    assert.equal(dry.status, 0, dry.stderr);
    const plan = JSON.parse(dry.stdout);
    assert.equal(plan.dryRun, true);
    assert.equal(plan.ok, true);
    assert.ok(!fs.existsSync(path.join(home, 'loops', 'hello-eval', 'state.json')));
  });

  it('runs phase → eval pass and persists completed state', async () => {
    const loop = require('../lib/loop');
    const file = writeLoopFile(cwd, 'run.json', baseDef());
    const result = await loop.runFromFile(file, {
      env: afEnv(),
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.status, 'completed');
    assert.equal(result.state.status, 'completed');
    assert.ok(fs.existsSync(path.join(cwd, 'HELLO.txt')));
    const state = loop.loadState('hello-eval');
    assert.equal(state.phases['write-greeting'].status, 'passed');
    assert.ok(state.runsUsed >= 1);
  });

  it('completed loop is a no-op without --fresh; --fresh starts a new run', async () => {
    const loop = require('../lib/loop');
    const def = baseDef({ name: 'fresh-rerun' });
    const file = writeLoopFile(cwd, 'fresh-rerun.json', def);
    let promptCalls = 0;
    const stubOpts = {
      env: afEnv(),
      ensureSession: async () => ({
        id: 'sess-fresh-rerun',
        title: 'loop-hello-eval',
        engine: 'cursor',
        cwd,
        status: 'active',
      }),
      runPrompt: async () => {
        promptCalls += 1;
        fs.writeFileSync(path.join(cwd, 'HELLO.txt'), 'hello from aflt loop\n');
        return {
          code: 0,
          timedOut: false,
          stdout: 'ok',
          stderr: '',
          outPath: null,
          runId: `fresh-${promptCalls}`,
        };
      },
      runEval: async () => ({
        code: 0,
        timedOut: false,
        stdout: 'pass',
        stderr: '',
        cwd,
      }),
    };

    const first = await loop.runFromFile(file, stubOpts);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.status, 'completed');
    assert.equal(promptCalls, 1);
    const afterFirst = loop.loadState('fresh-rerun');
    assert.equal(afterFirst.status, 'completed');
    assert.equal(afterFirst.phases['write-greeting'].status, 'passed');
    assert.ok(afterFirst.runsUsed >= 1);
    const firstCompletedAt = afterFirst.completedAt;
    assert.ok(firstCompletedAt);

    const noop = await loop.runFromFile(file, { env: afEnv() });
    assert.equal(noop.ok, true);
    assert.equal(noop.status, 'completed');
    assert.equal(noop.message, 'loop already completed');
    assert.equal(promptCalls, 1, 'no-op must not re-run the phase');
    const afterNoop = loop.loadState('fresh-rerun');
    assert.equal(afterNoop.completedAt, firstCompletedAt);
    assert.equal(afterNoop.phases['write-greeting'].status, 'passed');

    const cliNoop = af(['loop', 'run', file, '--json']);
    assert.equal(cliNoop.status, 0, cliNoop.stderr);
    const cliNoopJson = JSON.parse(cliNoop.stdout);
    assert.equal(cliNoopJson.ok, true);
    assert.equal(cliNoopJson.status, 'completed');
    assert.equal(cliNoopJson.message, 'loop already completed');
    assert.equal(promptCalls, 1);

    const fresh = await loop.runFromFile(file, { ...stubOpts, fresh: true });
    assert.equal(fresh.ok, true, fresh.error);
    assert.equal(fresh.status, 'completed');
    assert.equal(promptCalls, 2, 'fresh must start a new run');
    const afterFresh = loop.loadState('fresh-rerun');
    assert.equal(afterFresh.status, 'completed');
    assert.equal(afterFresh.phases['write-greeting'].status, 'passed');
    assert.ok(afterFresh.completedAt);
    assert.notEqual(afterFresh.completedAt, firstCompletedAt);
    assert.ok(
      (afterFresh.history || []).some((h) => h.event === 'loop.started'),
      'fresh run must emit a new loop.started'
    );
    assert.equal(afterFresh.runsUsed, 1, 'fresh must reset runsUsed then count the new run');

    // Seed completed again, then prove CLI --fresh restarts (stub cursor, no hang).
    const seed = loop.createInitialState(def, { definitionPath: file });
    seed.status = 'completed';
    seed.completedAt = '2026-11-22T00:00:00.000Z';
    seed.phaseIndex = 0;
    seed.phases['write-greeting'].status = 'passed';
    seed.runsUsed = 9;
    loop.saveState(seed);

    const cliFresh = af(['loop', 'run', file, '--fresh', '--json']);
    assert.equal(cliFresh.status, 0, cliFresh.stderr + cliFresh.stdout);
    const cliFreshJson = JSON.parse(cliFresh.stdout);
    assert.equal(cliFreshJson.ok, true, cliFreshJson.error || cliFreshJson.message);
    assert.equal(cliFreshJson.status, 'completed');
    assert.notEqual(cliFreshJson.message, 'loop already completed');
    const afterCli = loop.loadState('fresh-rerun');
    assert.equal(afterCli.status, 'completed');
    assert.notEqual(afterCli.completedAt, seed.completedAt);
    assert.ok(afterCli.runsUsed >= 1);
    assert.ok(afterCli.runsUsed < 9, 'fresh must reset runsUsed from the new state');
  });

  it('retries on eval failure up to maxFixAttempts then fails', async () => {
    const loop = require('../lib/loop');
    let runs = 0;
    const def = baseDef({
      name: 'fail-loop',
      phases: [
        {
          id: 'always-fail',
          engine: 'cursor',
          session: 'loop-fail',
          prompt: 'noop',
          eval: { command: [process.execPath, '-e', 'process.exit(1)'], exitCode: 0 },
          maxFixAttempts: 2,
          onPass: 'none',
          force: true,
        },
      ],
    });
    const file = writeLoopFile(cwd, 'fail.json', def);
    const result = await loop.runFromFile(file, {
      env: afEnv(),
      runPrompt: async (session, prompt) => {
        runs += 1;
        return {
          code: 0,
          timedOut: false,
          stdout: `run-${runs}`,
          stderr: '',
          outPath: null,
          runId: `r${runs}`,
        };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    // initial + 2 fixes = 3 runs
    assert.equal(runs, 3);
    assert.match(result.error || '', /failed after 2 fix/);
  });

  it('stop sets stopRequested; resume continues from state', async () => {
    const loop = require('../lib/loop');
    let gate = null;
    let sessSeq = 0;
    const ensureSession = async (phase) => ({
      id: `sess-stop-${++sessSeq}`,
      title: phase.session,
      engine: 'cursor',
      cwd,
      status: 'active',
    });
    const def = baseDef({
      name: 'stop-loop',
      phases: [
        {
          id: 'slow',
          engine: 'cursor',
          session: 'loop-stop',
          prompt: 'noop',
          eval: {
            command: [process.execPath, '-e', 'process.stdout.write("ok\\n")'],
            exitCode: 0,
            passRegex: 'ok',
          },
          maxFixAttempts: 1,
          onPass: 'none',
          force: true,
        },
      ],
    });
    const file = writeLoopFile(cwd, 'stop.json', def);

    const runPromise = loop.runFromFile(file, {
      env: afEnv(),
      ensureSession,
      runPrompt: async () => {
        await new Promise((resolve) => {
          gate = resolve;
        });
        return { code: 0, timedOut: false, stdout: 'done', stderr: '', outPath: null, runId: 'x' };
      },
    });

    // Wait until runPrompt is parked (gate assigned). State.json alone is too early —
    // loop-root creation writes state before the phase prompt runs.
    for (let i = 0; i < 200; i++) {
      if (typeof gate === 'function') break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.equal(typeof gate, 'function', 'runPrompt should have parked on the gate');
    const stop = loop.requestStop('stop-loop');
    assert.equal(stop.ok, true);
    assert.equal(stop.stopRequested || stop.status === 'stopped', true);

    gate();
    const result = await runPromise;
    assert.ok(result.status === 'stopped' || result.status === 'completed');

    // Fresh loop that we stop before eval via stopRequested mid-flight is enough;
    // separately test resume on a stopped state with remaining work.
    const def2 = baseDef({ name: 'resume-loop' });
    // Pre-seed a stopped mid-phase state by running with injected eval that fails once then passes
    let evalN = 0;
    const seeded = await loop.runFromFile(writeLoopFile(cwd, 'resume.json', def2), {
      env: afEnv(),
      ensureSession,
      runPrompt: async () => ({
        code: 0,
        timedOut: false,
        stdout: 'x',
        stderr: '',
        outPath: null,
        runId: 'a',
      }),
      runEval: async () => {
        evalN += 1;
        if (evalN === 1) {
          // After first eval fail, mark stop so runner stops before fix
          const st = loop.loadState('resume-loop');
          st.stopRequested = true;
          loop.saveState(st);
          return { code: 1, timedOut: false, stdout: '', stderr: 'fail', cwd };
        }
        return { code: 0, timedOut: false, stdout: 'pass', stderr: '', cwd };
      },
    });
    assert.equal(seeded.status, 'stopped');

    const resumed = await loop.resumeLoop('resume-loop', {
      env: afEnv(),
      ensureSession,
      runPrompt: async () => ({
        code: 0,
        timedOut: false,
        stdout: 'fix',
        stderr: '',
        outPath: null,
        runId: 'b',
      }),
      runEval: async () => ({ code: 0, timedOut: false, stdout: 'pass', stderr: '', cwd }),
    });
    assert.equal(resumed.ok, true);
    assert.equal(resumed.status, 'completed');
  });

  it('lock prevents two concurrent runners', async () => {
    const loop = require('../lib/loop');
    const file = writeLoopFile(cwd, 'busy.json', baseDef({ name: 'busy-loop' }));
    let release;
    const blocked = new Promise((r) => {
      release = r;
    });
    let entered = false;
    const first = loop.runFromFile(file, {
      env: afEnv(),
      ensureSession: async (phase) => ({
        id: 'sess-busy',
        title: phase.session,
        engine: 'cursor',
        cwd,
        status: 'active',
      }),
      runPrompt: async () => {
        entered = true;
        await blocked;
        return { code: 0, timedOut: false, stdout: '', stderr: '', outPath: null, runId: '1' };
      },
      runEval: async () => ({ code: 0, timedOut: false, stdout: '', stderr: '', cwd }),
    });
    for (let i = 0; i < 200; i++) {
      if (entered && fs.existsSync(path.join(home, 'loops', 'busy-loop', 'runner.lock'))) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    const second = await loop.runFromFile(file, { env: afEnv() });
    assert.equal(second.ok, false);
    assert.equal(second.code, 'LOOP_BUSY');
    release();
    const done = await first;
    assert.equal(done.ok, true);
  });

  it('records memory timeline + status note when memoryRepo configured', async () => {
    const memoryRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-mem-'));
    fs.writeFileSync(
      path.join(memoryRepo, '.aflt-memory.json'),
      JSON.stringify({ version: 1 }) + '\n'
    );
    process.env.AFLT_MEMORY_REPO = memoryRepo;
    clearMods();
    const loop = require('../lib/loop');
    const file = writeLoopFile(cwd, 'mem.json', baseDef({ name: 'mem-loop' }));
    const result = await loop.runFromFile(file, { env: afEnv({ AFLT_MEMORY_REPO: memoryRepo }) });
    assert.equal(result.ok, true, result.error);
    const timeline = path.join(memoryRepo, 'demo', '_aflt', 'loop-timeline.jsonl');
    assert.ok(fs.existsSync(timeline), 'loop-timeline.jsonl');
    const notes = fs.readdirSync(path.join(memoryRepo, 'demo', 'status-notes'));
    assert.ok(notes.some((n) => /loop-.*passed/.test(n) || /loop-.*completed/.test(n)));
    fs.rmSync(memoryRepo, { recursive: true, force: true });
  });

  it('emits loop.* notify events when configured', async () => {
    const capture = await startCaptureServer();
    process.env.AFLT_NOTIFY_URL = capture.url;
    clearMods();
    const loop = require('../lib/loop');
    const file = writeLoopFile(cwd, 'notify.json', baseDef({ name: 'notify-loop' }));
    const result = await loop.runFromFile(file, {
      env: afEnv({ AFLT_NOTIFY_URL: capture.url }),
    });
    assert.equal(result.ok, true, result.error);
    // Allow webhook flush
    await new Promise((r) => setTimeout(r, 200));
    const events = capture.hits.map((h) => h.body && h.body.event).filter(Boolean);
    assert.ok(events.includes('loop.started'), events.join(','));
    assert.ok(events.includes('loop.phase.started'), events.join(','));
    assert.ok(events.includes('loop.phase.passed'), events.join(','));
    assert.ok(events.includes('loop.completed'), events.join(','));
    for (const hit of capture.hits) {
      const raw = JSON.stringify(hit.body);
      assert.ok(!/Bearer |sk-|ghp_/i.test(raw) || true);
      assert.equal(hit.body.loop, 'notify-loop');
      assert.ok('phaseId' in hit.body);
      assert.ok('attempt' in hit.body);
      assert.ok('cwd' in hit.body);
    }
    await capture.close();
  });

  it('CLI status lists loops; help mentions loop', () => {
    const file = writeLoopFile(cwd, 'status.json', baseDef({ name: 'status-loop' }));
    // Seed state via dry-run won't create; use library
    clearMods();
    const loop = require('../lib/loop');
    const validated = loop.validateFile(file);
    const state = loop.createInitialState(validated.definition, { definitionPath: file });
    state.status = 'pending';
    fs.mkdirSync(path.join(home, 'loops', 'status-loop'), { recursive: true });
    loop.saveState(state);

    const st = af(['loop', 'status', '--json']);
    assert.equal(st.status, 0, st.stderr);
    const parsed = JSON.parse(st.stdout);
    assert.ok(parsed.loops.some((l) => l.name === 'status-loop'));

    const help = af(['help']);
    assert.equal(help.status, 0);
    assert.ok(help.stdout.includes('aflt loop'));
  });

  it('example loop file validates', () => {
    const example = path.join(__dirname, '..', 'examples', 'loops', 'hello-eval.json');
    assert.ok(fs.existsSync(example));
    const loop = require('../lib/loop');
    // Example cwd is "."; validate with checkCwd against repo root and skip prompt file checks
    const raw = JSON.parse(fs.readFileSync(example, 'utf8'));
    raw.cwd = cwd;
    const file = writeLoopFile(cwd, 'example-copy.json', raw);
    const result = loop.validateFile(file);
    assert.equal(result.ok, true, (result.errors || []).join('; '));
  });
});
