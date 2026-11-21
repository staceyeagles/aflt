'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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

describe('aflt loop milestone 4 (plan-next)', () => {
  let home;
  let cwd;
  let prevHome;
  let prevAfHome;
  let prevMemory;
  let prevUrl;
  let memoryRepo;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-m4-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-m4-cwd-'));
    memoryRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'af-loop-m4-mem-'));
    fs.writeFileSync(
      path.join(memoryRepo, '.aflt-memory.json'),
      JSON.stringify({ version: 1 }) + '\n'
    );
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevMemory = process.env.AFLT_MEMORY_REPO;
    prevUrl = process.env.AFLT_NOTIFY_URL;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = home;
    process.env.AFLT_MEMORY_REPO = memoryRepo;
    delete process.env.AFLT_NOTIFY_URL;
  });

  afterEach(() => {
    clearMods();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(memoryRepo, { recursive: true, force: true });
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
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
      AFLT_MEMORY_REPO: memoryRepo,
      ...extra,
    };
  }

  function baseDef(overrides = {}) {
    return {
      name: 'm4-loop',
      project: 'demo',
      cwd,
      engine: 'cursor',
      goal: 'Ship alpha then a planned gamma phase.',
      acceptance: 'ALPHA.txt and GAMMA.txt exist with expected contents.',
      plannedPhaseGate: 'none',
      allow: { commit: false, merge: false, push: false },
      budget: { maxRuns: 40, maxHours: 2, maxPhases: 10 },
      phases: [
        {
          id: 'phase-a',
          session: 'loop-m4-a',
          prompt: 'Create ALPHA.txt with exactly: alpha',
          eval: {
            command: [process.execPath, '-e', 'process.exit(require("fs").existsSync("ALPHA.txt")?0:1)'],
            exitCode: 0,
          },
          maxFixAttempts: 1,
          onPass: 'none',
          force: true,
        },
        {
          id: 'phase-b',
          session: 'loop-m4-b',
          prompt: 'Create BETA.txt with exactly: beta',
          eval: {
            command: [process.execPath, '-e', 'process.exit(require("fs").existsSync("BETA.txt")?0:1)'],
            exitCode: 0,
          },
          maxFixAttempts: 1,
          onPass: 'none',
          force: true,
        },
        {
          id: 'plan-next',
          type: 'plan-next',
          session: 'loop-m4-planner',
          maxFixAttempts: 2,
          onPass: 'none',
          force: true,
        },
      ],
      ...overrides,
    };
  }

  function makeFakeEngine(opts = {}) {
    let planRounds = 0;
    let crashOnce = Boolean(opts.crashOnce);
    let crashed = false;
    const touch = (file, body) => {
      fs.writeFileSync(path.join(cwd, file), body);
    };
    return {
      stats: { runs: 0, byPhase: {} },
      async runPrompt(session, prompt, phase) {
        const loop = require('../lib/loop');
        this.stats.runs += 1;
        this.stats.byPhase[phase.id] = (this.stats.byPhase[phase.id] || 0) + 1;

        if (crashOnce && !crashed && phase.id === 'phase-b') {
          crashed = true;
          // Simulate a runner crash mid-phase: persist running state and drop the lock.
          const st = loop.loadState('m4-loop');
          assert.ok(st);
          st.status = 'running';
          st.phaseId = 'phase-b';
          st.step = 'run';
          st.phases['phase-a'].status = 'passed';
          st.phases['phase-a'].passedAt = new Date().toISOString();
          st.phaseIndex = 1;
          loop.saveState(st);
          loop.releaseRunnerLock('m4-loop');
          const err = new Error('simulated crash');
          err.code = 'SIMULATED_CRASH';
          throw err;
        }

        if (phase.type === 'plan-next') {
          planRounds += 1;
          const out = loop.planNextOutputPath('m4-loop');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          if (planRounds === 1) {
            fs.writeFileSync(
              out,
              JSON.stringify(
                {
                  done: false,
                  phases: [
                    {
                      id: 'phase-gamma',
                      session: 'loop-m4-gamma',
                      prompt: 'Create GAMMA.txt with exactly: gamma',
                      eval: {
                        command: [
                          process.execPath,
                          '-e',
                          'process.exit(require("fs").existsSync("GAMMA.txt")?0:1)',
                        ],
                        exitCode: 0,
                      },
                      maxFixAttempts: 1,
                      onPass: 'none',
                      force: true,
                    },
                  ],
                },
                null,
                2
              ) + '\n'
            );
          } else {
            fs.writeFileSync(out, JSON.stringify({ done: true }, null, 2) + '\n');
          }
          assert.ok(String(prompt).includes('Goal'), 'plan-next prompt includes goal');
          assert.ok(String(prompt).includes(out), 'plan-next prompt includes output path');
          return {
            code: 0,
            timedOut: false,
            stdout: 'planned',
            stderr: '',
            outPath: null,
            runId: `plan-${planRounds}`,
          };
        }

        if (phase.id === 'phase-a') touch('ALPHA.txt', 'alpha\n');
        else if (phase.id === 'phase-b') touch('BETA.txt', 'beta\n');
        else if (phase.id === 'phase-gamma') touch('GAMMA.txt', 'gamma\n');

        return {
          code: 0,
          timedOut: false,
          stdout: `ok:${phase.id}`,
          stderr: '',
          outPath: null,
          runId: `r-${phase.id}-${this.stats.runs}`,
        };
      },
    };
  }

  it('validate accepts plan-next, goal, acceptance, maxPhases', () => {
    const loop = require('../lib/loop');
    const file = writeLoopFile(cwd, 'ok.json', baseDef());
    const ok = loop.validateFile(file);
    assert.equal(ok.ok, true, (ok.errors || []).join('; '));
    assert.equal(ok.definition.goal, 'Ship alpha then a planned gamma phase.');
    assert.equal(ok.definition.acceptance, 'ALPHA.txt and GAMMA.txt exist with expected contents.');
    assert.equal(ok.definition.plannedPhaseGate, 'none');
    assert.equal(ok.definition.budget.maxPhases, 10);
    const plan = ok.definition.phases.find((p) => p.type === 'plan-next');
    assert.ok(plan);

    const noCap = baseDef({
      name: 'warn-loop',
      budget: { maxRuns: 10, maxHours: 1 },
    });
    const warned = loop.validateFile(writeLoopFile(cwd, 'warn.json', noCap));
    assert.equal(warned.ok, true);
    assert.ok(warned.warnings.some((w) => /maxPhases/i.test(w)));
  });

  it('planned phases default to gate approve', () => {
    const loop = require('../lib/loop');
    const def = baseDef({
      name: 'gate-default',
      plannedPhaseGate: 'approve',
      phases: [
        {
          id: 'seed',
          prompt: 'noop',
          eval: { command: ['true'], exitCode: 0 },
          maxFixAttempts: 0,
          onPass: 'none',
        },
        {
          id: 'plan-next',
          type: 'plan-next',
          maxFixAttempts: 1,
          onPass: 'none',
        },
      ],
    });
    const validated = loop.validateDefinition(def);
    assert.equal(validated.ok, true, (validated.errors || []).join('; '));
    const state = loop.createInitialState(validated.definition);
    const inserted = loop.insertPlannedPhases(state, 1, [
      {
        id: 'new-work',
        prompt: 'do it',
        eval: { command: ['true'], exitCode: 0 },
      },
    ]);
    assert.equal(inserted.ok, true, inserted.error);
    const planned = state.definition.phases.find((p) => p.id === 'new-work');
    assert.equal(planned.gate, 'approve');
    assert.equal(planned.planned, true);
  });

  it('e2e: 2 seed phases + planned phase to completion, resume after crash', async () => {
    const loop = require('../lib/loop');
    const fake = makeFakeEngine({ crashOnce: true });
    const file = writeLoopFile(cwd, 'e2e.json', baseDef());

    let first;
    try {
      first = await loop.runFromFile(file, {
        env: afEnv(),
        ensureSession: async (phase) => ({
          id: `sess-${phase.id}`,
          title: phase.session,
          engine: phase.engine || 'cursor',
          cwd,
        }),
        runPrompt: (...args) => fake.runPrompt(...args),
      });
      assert.fail('expected simulated crash');
    } catch (err) {
      assert.equal(err && err.code, 'SIMULATED_CRASH');
    }

    // Crash left running state + no live lock.
    const mid = loop.loadState('m4-loop');
    assert.equal(mid.status, 'running');
    assert.equal(mid.phases['phase-a'].status, 'passed');
    assert.equal(mid.phaseId, 'phase-b');
    assert.equal(loop.readLockInfo('m4-loop'), null);

    const resumed = await loop.resumeLoop('m4-loop', {
      env: afEnv(),
      ensureSession: async (phase) => ({
        id: `sess-${phase.id}`,
        title: phase.session,
        engine: phase.engine || 'cursor',
        cwd,
      }),
      runPrompt: (...args) => fake.runPrompt(...args),
    });
    assert.equal(resumed.ok, true, resumed.error);
    assert.equal(resumed.status, 'completed');

    assert.ok(fs.existsSync(path.join(cwd, 'ALPHA.txt')));
    assert.ok(fs.existsSync(path.join(cwd, 'BETA.txt')));
    assert.ok(fs.existsSync(path.join(cwd, 'GAMMA.txt')));

    const state = loop.loadState('m4-loop');
    assert.equal(state.status, 'completed');
    assert.equal(state.phases['phase-a'].status, 'passed');
    assert.equal(state.phases['phase-b'].status, 'passed');
    assert.equal(state.phases['phase-gamma'].status, 'passed');
    assert.equal(state.phases['plan-next'].status, 'passed');
    assert.ok(
      state.definition.phases.some((p) => p.id === 'phase-gamma' && p.planned),
      'planned phase recorded on definition'
    );
    assert.ok(fake.stats.byPhase['phase-gamma'] >= 1);
    assert.ok(fake.stats.byPhase['plan-next'] >= 2);

    const timeline = path.join(memoryRepo, 'demo', '_aflt', 'loop-timeline.jsonl');
    assert.ok(fs.existsSync(timeline));
    const lines = fs
      .readFileSync(timeline, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    assert.ok(lines.some((e) => e.event === 'loop.phase.planned'));
    assert.ok(lines.some((e) => e.event === 'loop.completed'));

    const notesDir = path.join(memoryRepo, 'demo', 'status-notes');
    const notes = fs.readdirSync(notesDir);
    assert.ok(
      notes.some((n) => /acceptance-summary|completed|planned/.test(n)),
      notes.join(',')
    );

    // Silence unused first binding for linters
    void first;
  });

  it('maxPhases blocks unbounded planning', async () => {
    const loop = require('../lib/loop');
    const def = baseDef({
      name: 'cap-loop',
      budget: { maxRuns: 20, maxHours: 1, maxPhases: 3 },
      // seed (2) + plan-next (1) = 3; inserting another would exceed
    });
    const file = writeLoopFile(cwd, 'cap.json', def);
    let planCalls = 0;
    const result = await loop.runFromFile(file, {
      env: afEnv(),
      ensureSession: async (phase) => ({
        id: `sess-${phase.id}`,
        title: phase.session,
        engine: 'cursor',
        cwd,
      }),
      runPrompt: async (session, prompt, phase) => {
        if (phase.id === 'phase-a') {
          fs.writeFileSync(path.join(cwd, 'ALPHA.txt'), 'alpha\n');
        } else if (phase.id === 'phase-b') {
          fs.writeFileSync(path.join(cwd, 'BETA.txt'), 'beta\n');
        } else if (phase.type === 'plan-next') {
          planCalls += 1;
          const out = loop.planNextOutputPath('cap-loop');
          fs.mkdirSync(path.dirname(out), { recursive: true });
          fs.writeFileSync(
            out,
            JSON.stringify({
              done: false,
              phases: [
                {
                  id: 'too-many',
                  prompt: 'x',
                  eval: { command: ['true'], exitCode: 0 },
                },
              ],
            }) + '\n'
          );
        }
        return { code: 0, timedOut: false, stdout: 'x', stderr: '', outPath: null, runId: 'r' };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'failed');
    assert.match(result.error || '', /maxPhases/i);
    assert.ok(planCalls >= 1);
  });

  it('example plan-next.json validates', () => {
    const example = path.join(__dirname, '..', 'examples', 'loops', 'plan-next.json');
    assert.ok(fs.existsSync(example));
    const loop = require('../lib/loop');
    const raw = JSON.parse(fs.readFileSync(example, 'utf8'));
    raw.cwd = cwd;
    const file = writeLoopFile(cwd, 'example-plan-next.json', raw);
    const result = loop.validateFile(file);
    assert.equal(result.ok, true, (result.errors || []).join('; '));
    assert.equal(result.definition.phases.filter((p) => p.type === 'plan-next').length, 1);
  });
});
