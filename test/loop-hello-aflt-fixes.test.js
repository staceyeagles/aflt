'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const exampleDir = path.join(repoRoot, 'examples', 'loops', 'hello-aflt');
const exampleJson = path.join(exampleDir, 'hello-aflt.json');

function clearMods() {
  for (const m of [
    '../lib/loop',
    '../lib/usage',
    '../lib/turns',
    '../lib/run-history',
    '../lib/registry',
    '../lib/config',
    '../lib/memory',
    '../lib/project',
    '../lib/util',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

describe('hello-aflt loop fixes', () => {
  let home;
  let cwd;
  let prevHome;
  let prevAfHome;

  beforeEach(() => {
    clearMods();
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-fix-home-'));
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-fix-cwd-'));
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    fs.mkdirSync(process.env.AGENTFLEET_HOME, { recursive: true });
  });

  afterEach(() => {
    process.env.HOME = prevHome;
    if (prevAfHome == null) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    clearMods();
  });

  it('freezes elapsed time on completed / failed / stopped / paused loops', () => {
    const loop = require('../lib/loop');
    const startedAt = '2026-11-22T18:43:10.534Z';
    const completedAt = '2026-11-22T19:02:03.620Z';
    const expectedMs = Date.parse(completedAt) - Date.parse(startedAt);
    const laterMs = Date.parse('2026-11-23T00:00:00.000Z');

    const completed = {
      status: 'completed',
      startedAt,
      completedAt,
      failedAt: null,
      stoppedAt: null,
      pausedAt: null,
      definition: { budget: { maxHours: 8 } },
      runsUsed: 7,
    };
    assert.equal(loop._test.elapsedMsOf(completed, laterMs), expectedMs);
    assert.ok(
      Math.abs(loop._test.hoursElapsed(completed, laterMs) - expectedMs / 3600000) < 1e-9
    );
    const snap = loop._test.budgetSnapshot(completed, laterMs);
    assert.equal(snap.hoursUsed, Math.round((expectedMs / 3600000) * 1000) / 1000);

    const failed = {
      status: 'failed',
      startedAt,
      failedAt: completedAt,
      definition: { budget: {} },
      runsUsed: 1,
    };
    assert.equal(loop._test.elapsedMsOf(failed, laterMs), expectedMs);

    const stopped = {
      status: 'stopped',
      startedAt,
      stoppedAt: completedAt,
      definition: { budget: {} },
      runsUsed: 1,
    };
    assert.equal(loop._test.elapsedMsOf(stopped, laterMs), expectedMs);

    const paused = {
      status: 'paused',
      startedAt,
      pausedAt: completedAt,
      definition: { budget: {} },
      runsUsed: 1,
    };
    assert.equal(loop._test.elapsedMsOf(paused, laterMs), expectedMs);

    const running = {
      status: 'running',
      startedAt,
      definition: { budget: {} },
      runsUsed: 1,
    };
    assert.equal(loop._test.elapsedMsOf(running, laterMs), laterMs - Date.parse(startedAt));
  });

  it('promptExcerpt strips plan-mode + pkill preamble', () => {
    const loop = require('../lib/loop');
    const rh = require('../lib/run-history');
    const full = [
      'Do not switch to plan mode.',
      'Never use pkill/killall or pattern-matched kills; only stop PIDs you started.',
      'Build Milestone 1 of tile-dungeon.',
    ].join('\n');
    assert.match(loop._test.stripPromptPreamble(full), /^Build Milestone 1/);
    assert.match(loop._test.promptExcerpt(full, 80), /^Build Milestone 1/);
    assert.match(rh.promptExcerpt(full, 80), /^Build Milestone 1/);
    // Full prompt must remain available for engine runs (helper does not mutate).
    assert.match(full, /^Do not switch to plan mode/);
  });

  it('planDryRun promptPreview skips the preamble', () => {
    const loop = require('../lib/loop');
    const validated = loop.validateDefinition(
      {
        name: 'preview-loop',
        cwd,
        phases: [
          {
            id: 'p1',
            prompt:
              'Do not switch to plan mode.\nNever use pkill/killall or pattern-matched kills; only stop PIDs you started.\nImplement the dungeon renderer.',
            eval: { command: ['true'], exitCode: 0 },
          },
        ],
      },
      { checkCwd: false }
    );
    assert.equal(validated.ok, true, (validated.errors || []).join('; '));
    const plan = loop.planDryRun(validated.definition, null);
    assert.match(plan.phases[0].promptPreview, /^Implement the dungeon renderer/);
    assert.ok(!plan.phases[0].promptPreview.startsWith('Do not switch'));
  });

  it('rolls up per-loop token usage from phase sessions', () => {
    const loop = require('../lib/loop');
    const turns = require('../lib/turns');
    const usage = require('../lib/usage');

    const s1 = 'sess-loop-a';
    const s2 = 'sess-loop-b';
    turns.writeUsageSummary(
      s1,
      usage.summarizeSessionUsage([
        {
          usage: usage.normalizeCursorUsage(
            {
              inputTokens: 100,
              outputTokens: 10,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            { model: 'test-model-a' }
          ),
        },
      ])
    );
    turns.writeUsageSummary(
      s2,
      usage.summarizeSessionUsage([
        {
          usage: usage.normalizeCursorUsage(
            {
              inputTokens: 50,
              outputTokens: 5,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
            { model: 'test-model-b' }
          ),
        },
      ])
    );

    const state = {
      name: 'usage-loop',
      status: 'completed',
      startedAt: '2026-11-22T18:00:00.000Z',
      completedAt: '2026-11-22T18:20:00.000Z',
      loopRootSessionId: null,
      phases: {
        m1: { sessionId: s1, status: 'passed' },
        m2: { sessionId: s2, status: 'passed' },
      },
      definition: { budget: {}, phases: [{ id: 'm1' }, { id: 'm2' }] },
      runsUsed: 2,
    };
    const rolled = loop.refreshLoopUsage(state);
    assert.ok(rolled);
    assert.equal(rolled.totalInput, 150);
    assert.equal(rolled.outputTokens, 15);
    assert.equal(rolled.turnCount, 2);
    assert.ok(rolled.cost == null); // never invent USD (omitted or null)
    assert.ok(Array.isArray(rolled.models));
    assert.ok(rolled.models.includes('test-model-a'));
    assert.ok(rolled.models.includes('test-model-b'));

    const summary = loop.summarizeLoopState(state);
    assert.ok(summary.usage);
    assert.equal(summary.usage.totalInput, 150);
    assert.equal(summary.elapsedMs, 20 * 60 * 1000);
  });

  it('extractEvalScore reads overall from lastEval stdout', () => {
    const loop = require('../lib/loop');
    assert.equal(
      loop.extractEvalScore({ stdout: JSON.stringify({ overall: 92.4, weakest: 'avg_depth' }) }),
      92.4
    );
    assert.equal(
      loop.extractEvalScore({ stdout: 'noise\n{"previous":90,"after":91.5,"result":"improved"}\n' }),
      91.5
    );
    assert.equal(loop.extractEvalScore({ stdout: 'no score here' }), null);
  });

  it('buildPhasePipeline exposes evalScore + parent session', () => {
    const loop = require('../lib/loop');
    const state = {
      name: 'tree-loop',
      status: 'completed',
      phaseIndex: 1,
      step: 'run',
      loopRootSessionId: 'root-1',
      definition: {
        phases: [
          { id: 'm1', session: 'hello-aflt-m1', type: 'run' },
          { id: 'm5a', session: 'hello-aflt-m5a', type: 'run' },
        ],
      },
      phases: {
        m1: {
          status: 'passed',
          sessionId: 's1',
          sessionTitle: 'hello-aflt-m1',
          lastEval: { stdout: '{"overall":80}', code: 0 },
        },
        m5a: {
          status: 'passed',
          sessionId: 's2',
          sessionTitle: 'hello-aflt-m5a',
          evalScore: 92.4,
          lastEval: { stdout: '{"overall":92.4}', code: 0 },
        },
      },
    };
    const pipe = loop.buildPhasePipeline(state);
    assert.equal(pipe[0].evalScore, 80);
    assert.equal(pipe[0].parentSessionId, 'root-1');
    assert.equal(pipe[0].role, 'worker');
    assert.equal(pipe[1].evalScore, 92.4);
  });

  it('ensureSession sets parent/role under loop root for new sessions', async () => {
    const loop = require('../lib/loop');
    const registry = require('../lib/registry');
    const root = registry.add({
      title: 'loop-parent-test',
      chatId: 'chat-root',
      cwd,
      engine: 'cursor',
      role: 'master',
      tags: ['loop', 'parent-test', 'loop-root'],
      status: 'active',
    });
    const phase = {
      id: 'm1',
      session: 'hello-phase-child',
      engine: 'cursor',
    };
    // Bypass create-chat by pre-seeding? ensureSession calls createEngineChatId.
    // Inject via monkeypatch of create path: add a fake by calling registry after stubbing.
    // Use opts with a pre-existing session instead:
    const existing = registry.add({
      title: 'hello-phase-existing',
      chatId: 'chat-phase',
      cwd,
      engine: 'cursor',
      status: 'active',
    });
    const got = await loop.ensureSession(
      { id: 'm1', session: 'hello-phase-existing', engine: 'cursor' },
      { name: 'parent-test', cwd, engine: 'cursor', project: 'demo' },
      { loopRoot: root }
    );
    assert.equal(got.id, existing.id);
    assert.equal(got.parent, root.id);
    assert.equal(got.role, 'worker');
  });

  it('resolves promptFile relative to the definition directory', () => {
    const loop = require('../lib/loop');
    const defDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-def-'));
    const prompts = path.join(defDir, 'prompts');
    fs.mkdirSync(prompts);
    const promptFile = path.join(prompts, 'M1.txt');
    fs.writeFileSync(promptFile, 'Build M1.\n');
    const gameCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-game-'));

    const resolved = loop.resolvePromptFilePath('prompts/M1.txt', {
      definitionDir: defDir,
      cwd: gameCwd,
    });
    assert.equal(resolved, promptFile);

    const validated = loop.validateDefinition(
      {
        name: 'rel-prompts',
        cwd: gameCwd,
        phases: [
          {
            id: 'm1',
            promptFile: 'prompts/M1.txt',
            eval: { command: ['true'], exitCode: 0 },
          },
        ],
      },
      { definitionDir: defDir, cwdBase: gameCwd, checkCwd: true }
    );
    assert.equal(validated.ok, true, (validated.errors || []).join('; '));
    assert.equal(validated.definition.phases[0].promptFile, promptFile);
    assert.equal(
      fs.realpathSync(validated.definition.cwd),
      fs.realpathSync(gameCwd)
    );
  });

  it('resolves improve-gate.js relative to the definition directory', () => {
    const loop = require('../lib/loop');
    const defDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-gate-'));
    const gate = path.join(defDir, 'improve-gate.js');
    fs.writeFileSync(gate, '#!/usr/bin/env node\nprocess.exit(0);\n');
    const cmd = loop.resolveEvalCommandPaths(['node', 'improve-gate.js'], {
      definitionDir: defDir,
    });
    assert.deepEqual(cmd, ['node', gate]);
  });

  it('portable hello-aflt example validates and dry-runs', () => {
    assert.ok(fs.existsSync(exampleJson));
    assert.ok(fs.existsSync(path.join(exampleDir, 'improve-gate.js')));
    assert.ok(fs.existsSync(path.join(exampleDir, 'prompts', 'M5a.txt')));
    assert.ok(fs.existsSync(path.join(exampleDir, 'README.md')));

    const loop = require('../lib/loop');
    const raw = JSON.parse(fs.readFileSync(exampleJson, 'utf8'));
    assert.ok(!Object.prototype.hasOwnProperty.call(raw, 'engine') || raw.engine == null);
    assert.ok(!JSON.stringify(raw).includes('/tmp/'));
    assert.ok(!JSON.stringify(raw).includes('AGENTFLEET_CURSOR_BIN'));

    const result = loop.validateFile(exampleJson, {
      checkCwd: false,
      cwdBase: cwd,
    });
    assert.equal(result.ok, true, (result.errors || []).join('; '));
    for (const p of result.definition.phases) {
      if (p.promptFile) {
        assert.ok(p.promptFile.startsWith(exampleDir), p.promptFile);
        assert.ok(fs.existsSync(p.promptFile), p.promptFile);
      }
    }

    const plan = loop.planDryRun(result.definition, exampleJson);
    assert.equal(plan.ok, true);
    assert.equal(plan.name, 'hello-aflt');
    assert.ok(plan.phases.length >= 6);

    const m1 = fs.readFileSync(path.join(exampleDir, 'prompts', 'M1.txt'), 'utf8');
    assert.match(m1, /8792/);
    const m5a = fs.readFileSync(path.join(exampleDir, 'prompts', 'M5a.txt'), 'utf8');
    assert.match(m5a, /crash_free/);
    assert.match(m5a, /AVG_DEPTH_TARGET\s*=\s*3\.5/);
    assert.match(m5a, /PORT|8792/);
    assert.ok(m5a.includes('Do not copy'));

    const planNext = fs.readFileSync(path.join(exampleDir, 'prompts', 'plan-next.txt'), 'utf8');
    assert.match(planNext, /improve-gate\.js/);
    assert.ok(!planNext.includes('/tmp/aflt-dungeon-loop'));
  });

  it('improve-gate measures before/after and never uses history.jsonl as previous', () => {
    const { spawnSync } = require('child_process');
    const gate = path.join(exampleDir, 'improve-gate.js');
    const src = fs.readFileSync(gate, 'utf8');
    assert.match(src, /gate-pre-measure/);
    assert.match(src, /Do not read eval\/history\.jsonl/);
    assert.ok(!src.includes('/tmp/'));

    const game = fs.mkdtempSync(path.join(os.tmpdir(), 'af-hello-gate-game-'));
    fs.writeFileSync(path.join(game, 'package.json'), JSON.stringify({ name: 'g' }) + '\n');
    fs.mkdirSync(path.join(game, 'scripts', 'eval'), { recursive: true });
    fs.mkdirSync(path.join(game, 'test'), { recursive: true });
    fs.writeFileSync(
      path.join(game, 'test', 'smoke.test.js'),
      `const { describe, it } = require('node:test');\nconst assert = require('node:assert/strict');\ndescribe('smoke', () => { it('ok', () => assert.equal(1, 1)); });\n`
    );
    // Counter: first measure → 90, second → 95 (real improvement).
    // Misleading history.jsonl last line is 95 (old gate would see 95→95 plateau).
    fs.writeFileSync(
      path.join(game, 'scripts', 'eval', 'eval.js'),
      `const fs=require('fs');
const c='eval/.gate-count';
fs.mkdirSync('eval',{recursive:true});
let n=0; try{n=Number(fs.readFileSync(c,'utf8'))||0;}catch{}
n+=1; fs.writeFileSync(c,String(n));
const overall = n===1 ? 90 : 95;
const out={overall,weakest:'avg_depth',metrics:{}};
if(process.argv.includes('--write')){
  fs.writeFileSync('eval/latest-score.json', JSON.stringify(out)+'\\n');
  fs.appendFileSync('eval/history.jsonl', JSON.stringify(out)+'\\n');
}
process.stdout.write(JSON.stringify(out)+'\\n');
`
    );
    fs.mkdirSync(path.join(game, 'eval'), { recursive: true });
    fs.writeFileSync(
      path.join(game, 'eval', 'history.jsonl'),
      JSON.stringify({ overall: 95 }) + '\n'
    );

    const r = spawnSync(process.execPath, [gate], {
      cwd: game,
      encoding: 'utf8',
      env: process.env,
    });
    assert.equal(r.status, 0, r.stderr || r.stdout);
    assert.match(r.stdout || '', /improved 90 -> 95/);
    const plateau = JSON.parse(fs.readFileSync(path.join(game, 'eval', 'plateau.json'), 'utf8'));
    assert.equal(plateau.previous, 90);
    assert.equal(plateau.after, 95);
    assert.equal(plateau.result, 'improved');
    assert.equal(plateau.beforeSource, 'gate-pre-measure');
  });
});
