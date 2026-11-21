'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const afJs = path.join(repoRoot, 'bin', 'af.js');

function clearEvalMods() {
  for (const m of [
    '../scripts/eval/measure',
    '../scripts/eval/suite',
    '../scripts/eval/smoke',
    '../scripts/eval/dashboard-api',
    '../scripts/eval/commands',
    '../scripts/eval/score',
    '../scripts/eval/gate',
    '../scripts/eval/report',
    '../scripts/eval/rubric',
    '../scripts/eval/index',
    '../lib/loop',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function fixtureMeasureResults(overrides = {}) {
  return {
    version: 1,
    measuredAt: '2026-11-21T12:00:00.000Z',
    ok: true,
    suite: {
      ok: true,
      pass: 10,
      fail: 0,
      skip: 0,
      flakes: [],
      hardFails: [],
      skipped: false,
    },
    coverage: {
      available: true,
      reason: null,
      totals: {
        lines: { total: 100, covered: 80, percent: 80 },
        functions: { total: 50, covered: 40, percent: 80 },
        branches: { total: 20, covered: 10, percent: 50 },
      },
    },
    cliSmoke: {
      ok: true,
      failures: 0,
      commandCount: 5,
      commands: [
        { id: 'version', mode: 'run', ok: true, exitCode: 0 },
        { id: 'help', mode: 'run', ok: true, exitCode: 0 },
      ],
    },
    dashboardApi: {
      ok: true,
      routes: [{ path: '/api/state', ok: true }],
    },
    ...overrides,
  };
}

describe('aflt eval score / report / gate (E2)', () => {
  let prevHome;
  let prevAfHome;
  let prevTest;
  let home;
  let tmp;

  beforeEach(() => {
    clearEvalMods();
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    prevTest = process.env.AGENTFLEET_TEST;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-eval-e2-'));
    tmp = path.join(home, 'work');
    fs.mkdirSync(tmp, { recursive: true });
    fs.mkdirSync(path.join(home, '.agentfleet'), { recursive: true });
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
    process.env.AGENTFLEET_TEST = '1';
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    if (prevTest === undefined) delete process.env.AGENTFLEET_TEST;
    else process.env.AGENTFLEET_TEST = prevTest;
    clearEvalMods();
  });

  it('deterministic scoring from fixtures', () => {
    const { score, scoreCoverage, gradeErrorSample } = require('../scripts/eval/score');
    const historyPath = path.join(tmp, 'history.jsonl');
    const results = fixtureMeasureResults();
    fs.writeFileSync(
      path.join(tmp, 'README.md'),
      'aflt eval measure\naflt loop\naflt doctor\n'
    );

    const stackOnly = gradeErrorSample({
      message: 'Error\n    at Object.<anonymous> (/tmp/x.js:1:1)\n    at Module._compile',
      command: 'rm',
      expectCommand: true,
    });
    assert.equal(stackOnly.ok, false);

    const out = score({
      repoRoot,
      results,
      historyPath,
      skipErrorProbes: true,
      errorSamples: [
        {
          message: 'unknown eval subcommand: nope\nusage: aflt eval …',
          command: 'eval',
          expectCommand: true,
        },
        {
          message: 'usage: aflt loop validate <file.json>',
          command: 'loop',
          expectCommand: true,
        },
        {
          message: 'missing title for rm',
          command: 'rm',
          expectCommand: true,
        },
      ],
      // Inject docs/commands so score is stable without every USAGE alias.
      commands: ['eval', 'loop', 'doctor'],
      usageText: 'aflt eval measure\naflt loop validate\naflt doctor [--json]\n',
      readmePath: path.join(tmp, 'README.md'),
      examplesDir: path.join(repoRoot, 'examples', 'loops'),
      env: { ...process.env, AGENTFLEET_TEST: '1' },
    });

    assert.equal(out.ok, true);
    assert.equal(out.rubricVersion, 1);
    assert.equal(typeof out.overall, 'number');
    assert.ok(out.overall >= 0 && out.overall <= 100);

    const byId = Object.fromEntries(out.criteria.map((c) => [c.id, c]));
    assert.equal(byId.suite_green.score, 100);
    assert.equal(byId.coverage.score, 100); // 80/70 → capped 100
    assert.equal(byId.cli_smoke.score, 100);
    assert.equal(byId.docs_commands.score, 100);
    assert.equal(byId.loop_examples.score, 100);
    assert.equal(byId.dashboard_api.score, 100);
    assert.equal(byId.error_quality.score, 100);
    // 25+10+20+15+10+10+10 = 100
    assert.equal(out.overall, 100);
    assert.ok(out.qualitative.skipped);

    // suite skipped → 0
    const skipped = score({
      results: fixtureMeasureResults({
        suite: {
          ok: true,
          pass: 0,
          fail: 0,
          skip: 0,
          flakes: [],
          hardFails: [],
          skipped: true,
        },
      }),
      historyPath: path.join(tmp, 'h2.jsonl'),
      skipErrorProbes: true,
      errorSamples: [
        { message: 'usage: aflt eval score', command: 'eval', expectCommand: true },
      ],
      commands: ['eval'],
      usageText: 'aflt eval\n',
      readmePath: path.join(tmp, 'README.md'),
      examplesDir: path.join(repoRoot, 'examples', 'loops'),
      env: process.env,
    });
    const sg = skipped.criteria.find((c) => c.id === 'suite_green');
    assert.equal(sg.score, 0);

    // coverage unavailable → 50; linear below threshold
    assert.equal(scoreCoverage({ available: false, reason: 'n/a' }).score, 50);
    assert.equal(
      scoreCoverage({
        available: true,
        totals: { lines: { percent: 35 } },
      }).score,
      50
    ); // 35/70*100 = 50
  });

  it('appends history.jsonl and report shows trend', () => {
    const { score } = require('../scripts/eval/score');
    const { report } = require('../scripts/eval/report');
    const historyPath = path.join(tmp, 'history.jsonl');

    const common = {
      repoRoot,
      historyPath,
      skipErrorProbes: true,
      errorSamples: [
        { message: 'usage: aflt eval score', command: 'eval', expectCommand: true },
      ],
      commands: ['eval'],
      usageText: 'aflt eval measure\n',
      readmePath: path.join(tmp, 'README.md'),
      examplesDir: path.join(repoRoot, 'examples', 'loops'),
      env: process.env,
    };
    fs.writeFileSync(path.join(tmp, 'README.md'), 'aflt eval\n');

    const a = score({
      ...common,
      results: fixtureMeasureResults({
        coverage: { available: false, reason: 'fixture' },
      }),
    });
    const b = score({
      ...common,
      results: fixtureMeasureResults(),
    });

    assert.ok(fs.existsSync(historyPath));
    const lines = fs
      .readFileSync(historyPath, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean);
    assert.equal(lines.length, 2);
    const row = JSON.parse(lines[1]);
    assert.equal(row.overall, b.overall);
    assert.ok(row.scoredAt);

    const rep = report({ historyPath, limit: 10 });
    assert.equal(rep.ok, true);
    assert.equal(rep.latest.overall, b.overall);
    assert.equal(rep.previous.overall, a.overall);
    assert.equal(rep.trend.delta, b.overall - a.overall);
    assert.match(rep.text, /eval report: overall=/);
    assert.ok(a.overall < b.overall || a.overall === b.overall);
  });

  it('qualitative path is skipped under AGENTFLEET_TEST', () => {
    const { score, resolveQualitative } = require('../scripts/eval/score');
    const historyPath = path.join(tmp, 'q-history.jsonl');
    fs.writeFileSync(path.join(tmp, 'README.md'), 'aflt eval\n');

    let qualitativeCalled = false;
    const out = score({
      repoRoot,
      results: fixtureMeasureResults(),
      historyPath,
      qualitative: true,
      skipErrorProbes: true,
      errorSamples: [
        { message: 'usage: aflt eval', command: 'eval', expectCommand: true },
      ],
      commands: ['eval'],
      usageText: 'aflt eval\n',
      readmePath: path.join(tmp, 'README.md'),
      examplesDir: path.join(repoRoot, 'examples', 'loops'),
      env: { ...process.env, AGENTFLEET_TEST: '1' },
      runQualitative: () => {
        qualitativeCalled = true;
        return { grade: 'A' };
      },
    });
    assert.equal(out.qualitative.skipped, true);
    assert.match(out.qualitative.reason, /test|SKIP_QUALITATIVE/i);
    assert.equal(qualitativeCalled, false);

    const skippedEnv = resolveQualitative({
      qualitative: true,
      env: { AFLT_EVAL_SKIP_QUALITATIVE: '1' },
      runQualitative: () => {
        qualitativeCalled = true;
        return { grade: 'A' };
      },
    });
    assert.equal(skippedEnv.skipped, true);

    // Without test env, still skips when evaluator not configured
    const notConfigured = resolveQualitative({
      qualitative: true,
      env: {},
    });
    assert.equal(notConfigured.skipped, true);
    assert.match(notConfigured.reason, /not configured/);
  });

  it('rubric-guard pass/fail with injectable changedFiles', () => {
    const { gate } = require('../scripts/eval/gate');
    const fail = gate({
      repoRoot,
      changedFiles: ['eval/RUBRIC.md', 'README.md'],
    });
    assert.equal(fail.ok, false);
    assert.deepEqual(fail.violations, ['eval/RUBRIC.md']);

    const failScore = gate({
      repoRoot,
      changedFiles: ['scripts/eval/score.js'],
    });
    assert.equal(failScore.ok, false);
    assert.ok(failScore.violations.includes('scripts/eval/score.js'));

    const failRubricJs = gate({
      repoRoot,
      changedFiles: ['scripts/eval/rubric.js', 'test/eval-e2.test.js'],
    });
    assert.equal(failRubricJs.ok, false);

    const pass = gate({
      repoRoot,
      changedFiles: ['README.md', 'test/eval-e2.test.js', 'lib/loop.js'],
    });
    assert.equal(pass.ok, true);
    assert.deepEqual(pass.violations, []);
    assert.ok(pass.protectedPaths.includes('eval/RUBRIC.md'));
  });

  it('findLatestResults picks newest by filename', () => {
    const { findLatestResults } = require('../scripts/eval/score');
    const dir = path.join(tmp, 'results');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '2026-11-20T10-00-00-000Z.json'), '{}');
    fs.writeFileSync(path.join(dir, '2026-11-21T12-00-00-000Z.json'), '{"ok":true}');
    fs.writeFileSync(path.join(dir, '2026-11-21T09-00-00-000Z.json'), '{}');
    const latest = findLatestResults(dir);
    assert.equal(path.basename(latest), '2026-11-21T12-00-00-000Z.json');
  });

  it('CLI: eval score --json + report + gate', () => {
    const resultsDir = path.join(tmp, 'results');
    fs.mkdirSync(resultsDir, { recursive: true });
    const resultsPath = path.join(resultsDir, '2026-11-21T15-00-00-000Z.json');
    fs.writeFileSync(
      resultsPath,
      JSON.stringify(
        fixtureMeasureResults({
          errorSamples: [
            {
              message: 'unknown eval subcommand: nope\nusage: aflt eval',
              command: 'eval',
              expectCommand: true,
            },
          ],
        }),
        null,
        2
      ) + '\n'
    );
    const historyPath = path.join(tmp, 'cli-history.jsonl');

    const env = {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      AGENTFLEET_TEST: '1',
      AFLT_EVAL_SKIP_QUALITATIVE: '1',
    };

    const scoreRun = spawnSync(
      process.execPath,
      [
        afJs,
        'eval',
        'score',
        resultsPath,
        '--json',
        '--history',
        historyPath,
        '--qualitative',
      ],
      { encoding: 'utf8', env, cwd: repoRoot, timeout: 60_000 }
    );
    assert.equal(scoreRun.status, 0, scoreRun.stderr + scoreRun.stdout);
    const scored = JSON.parse(scoreRun.stdout);
    assert.equal(scored.ok, true);
    assert.ok(typeof scored.overall === 'number');
    assert.equal(scored.qualitative.skipped, true);
    assert.ok(fs.existsSync(historyPath));

    const reportRun = spawnSync(
      process.execPath,
      [afJs, 'eval', 'report', '--json', '--history', historyPath],
      { encoding: 'utf8', env, cwd: repoRoot, timeout: 15_000 }
    );
    assert.equal(reportRun.status, 0, reportRun.stderr + reportRun.stdout);
    const reported = JSON.parse(reportRun.stdout);
    assert.equal(reported.ok, true);
    assert.equal(reported.latest.overall, scored.overall);

    const gatePass = spawnSync(
      process.execPath,
      [afJs, 'eval', 'gate', '--json'],
      { encoding: 'utf8', env, cwd: repoRoot, timeout: 15_000 }
    );
    // May pass or fail depending on working tree; just ensure JSON shape
    assert.ok(gatePass.stdout);
    const gatePayload = JSON.parse(gatePass.stdout);
    assert.ok('ok' in gatePayload);
    assert.ok(Array.isArray(gatePayload.violations));
    assert.ok(Array.isArray(gatePayload.protectedPaths));
  });

  it('CLI: report with empty history is ok', () => {
    const historyPath = path.join(tmp, 'empty-history.jsonl');
    const env = {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      AGENTFLEET_TEST: '1',
    };
    const r = spawnSync(
      process.execPath,
      [afJs, 'eval', 'report', '--json', '--history', historyPath],
      { encoding: 'utf8', env, cwd: repoRoot, timeout: 10_000 }
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.ok, true);
    assert.equal(payload.latest, null);
  });
});
