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
    '../scripts/eval/index',
    '../lib/dashboard',
    '../lib/registry',
    '../lib/config',
    '../lib/util',
    '../lib/loop',
  ]) {
    try {
      delete require.cache[require.resolve(m)];
    } catch (_) {
      /* ignore */
    }
  }
}

function fixtureSuiteResult() {
  return {
    ok: true,
    pass: 3,
    fail: 0,
    skip: 1,
    durationMs: 42,
    files: [
      {
        file: path.join(repoRoot, 'test', 'eval-e1.test.js'),
        durationMs: 42,
        pass: 3,
        fail: 0,
        skip: 1,
      },
    ],
    flakes: [],
    hardFails: [],
    coverage: {
      available: true,
      reason: null,
      totals: {
        lines: { total: 100, covered: 80, percent: 80 },
        functions: { total: 50, covered: 40, percent: 80 },
        branches: { total: 20, covered: 10, percent: 50 },
      },
    },
  };
}

describe('aflt eval measure (E1)', () => {
  let prevHome;
  let prevAfHome;
  let home;
  let outDir;

  beforeEach(() => {
    clearEvalMods();
    prevHome = process.env.HOME;
    prevAfHome = process.env.AGENTFLEET_HOME;
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-eval-e1-'));
    outDir = path.join(home, 'results');
    fs.mkdirSync(path.join(home, '.agentfleet'), { recursive: true });
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = path.join(home, '.agentfleet');
  });

  afterEach(() => {
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAfHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAfHome;
    clearEvalMods();
  });

  it('parseCoverageFixture and summarizeEvents helpers', () => {
    const suite = require('../scripts/eval/suite');
    const cov = suite.parseCoverageFixture({
      available: true,
      totals: {
        lines: { total: 10, covered: 5, percent: 50 },
        functions: { total: 4, covered: 2, percent: 50 },
        branches: { total: 2, covered: 1, percent: 50 },
      },
    });
    assert.equal(cov.available, true);
    assert.equal(cov.totals.lines.percent, 50);

    const unavailable = suite.parseCoverageFixture({
      available: false,
      reason: 'fixture',
    });
    assert.equal(unavailable.available, false);

    const events = [
      {
        type: 'test:pass',
        data: {
          name: 'a',
          file: '/tmp/a.test.js',
          details: { duration_ms: 11 },
        },
      },
      {
        type: 'test:fail',
        data: {
          name: 'b',
          file: '/tmp/a.test.js',
          details: { duration_ms: 5 },
        },
      },
      { type: 'test:skip', data: { name: 'c', file: '/tmp/b.test.js' } },
    ];
    const summary = suite.summarizeEvents(events);
    assert.equal(summary.pass, 1);
    assert.equal(summary.fail, 1);
    assert.equal(summary.skip, 1);
    assert.equal(summary.files.length, 2);
  });

  it('listTopLevelCommands reads USAGE-like text', () => {
    const commands = require('../scripts/eval/commands');
    const names = commands.listTopLevelCommands(
      'aflt ls [--json]\n  aflt doctor [--json]\n  aflt loop validate <file>\n'
    );
    assert.ok(names.includes('ls'));
    assert.ok(names.includes('doctor'));
    assert.ok(names.includes('loop'));
    const plan = commands.buildSmokePlan({ repoRoot });
    assert.ok(plan.some((p) => p.id === 'doctor' && p.mode === 'run'));
    assert.ok(plan.some((p) => p.id === 'setup-apply' && p.mode === 'skip'));
    assert.ok(plan.some((p) => p.id === 'run-dry' && p.mode === 'dry-run'));
  });

  it('writes results JSON with stubbed suite + live smoke/API helpers', async () => {
    const { measure } = require('../scripts/eval/measure');
    const result = await measure({
      repoRoot,
      outDir,
      suiteResult: fixtureSuiteResult(),
      useInProcessDashboard: true,
      sandboxHome: home,
      smokeTimeoutMs: 20_000,
    });

    assert.ok(result.path);
    assert.ok(fs.existsSync(result.path));
    assert.match(path.basename(result.path), /^\d{4}-\d{2}-\d{2}T.*Z\.json$/);

    const written = JSON.parse(fs.readFileSync(result.path, 'utf8'));
    assert.equal(written.version, 1);
    assert.ok(written.measuredAt);
    assert.equal(written.suite.pass, 3);
    assert.equal(written.suite.skip, 1);
    assert.equal(written.coverage.available, true);
    assert.equal(written.coverage.totals.lines.percent, 80);
    assert.ok(Array.isArray(written.cliSmoke.commands));
    assert.ok(written.cliSmoke.commands.length > 5);
    assert.ok(written.cliSmoke.commands.some((c) => c.id === 'version' && c.exitCode === 0));
    assert.ok(written.cliSmoke.commands.some((c) => c.mode === 'skip'));
    assert.ok(written.dashboardApi.routes.some((r) => r.path === '/api/state' && r.ok));
    assert.ok(written.dashboardApi.routes.some((r) => r.path === '/api/loops' && r.ok));
    assert.equal(written.ok, true);
  });

  it('measureSuite flake detection via injected runner', async () => {
    const suite = require('../scripts/eval/suite');
    let calls = 0;
    const runNodeTest = async ({ testFiles, coverage }) => {
      calls += 1;
      if (calls === 1) {
        // First suite pass (with coverage flag): one fail + coverage summary
        assert.equal(coverage, true);
        return {
          code: 1,
          stdout: '',
          stderr: '',
          events: [
            {
              type: 'test:fail',
              data: {
                name: 'flaky one',
                file: '/tmp/flake.test.js',
                details: { duration_ms: 3 },
              },
            },
            {
              type: 'test:pass',
              data: {
                name: 'stable',
                file: '/tmp/ok.test.js',
                details: { duration_ms: 1 },
              },
            },
          ],
          coverageSummary: {
            lines: { total: 1, covered: 1, percent: 100 },
            functions: { total: 1, covered: 1, percent: 100 },
            branches: { total: 1, covered: 1, percent: 100 },
          },
          coverageError: null,
        };
      }
      // Rerun of failed file → pass (flake)
      assert.equal(coverage, false);
      assert.deepEqual(testFiles, ['/tmp/flake.test.js']);
      return {
        code: 0,
        stdout: '',
        stderr: '',
        events: [
          {
            type: 'test:pass',
            data: {
              name: 'flaky one',
              file: '/tmp/flake.test.js',
              details: { duration_ms: 2 },
            },
          },
        ],
        coverageSummary: null,
        coverageError: null,
      };
    };

    const result = await suite.measureSuite({
      repoRoot,
      runNodeTest,
      skipCoverage: false,
    });
    assert.equal(result.ok, true);
    assert.equal(result.flakes.length, 1);
    assert.equal(result.flakes[0].name, 'flaky one');
    assert.equal(result.hardFails.length, 0);
    assert.equal(result.coverage.available, true);
  });

  it('measureSuite: reporter/runner error → suite.ok false (not pass=0 fail=0 green)', async () => {
    const suite = require('../scripts/eval/suite');
    const runNodeTest = async () => ({
      code: 7,
      stdout: '',
      stderr:
        "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'json' imported from /tmp/",
      events: [],
      coverageSummary: null,
      coverageError: null,
    });
    const result = await suite.measureSuite({
      repoRoot,
      runNodeTest,
      skipCoverage: true,
      skipFlakeRerun: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.pass, 0);
    assert.equal(result.fail, 0);
    assert.equal(result.exitCode, 7);
    assert.match(String(result.error || ''), /exited 7|ERR_MODULE_NOT_FOUND|0 tests/i);
  });

  it('measureSuite: 0 tests ran → suite.ok false', async () => {
    const suite = require('../scripts/eval/suite');
    const runNodeTest = async () => ({
      code: 0,
      stdout: '',
      stderr: '',
      events: [],
      coverageSummary: null,
      coverageError: null,
    });
    const result = await suite.measureSuite({
      repoRoot,
      runNodeTest,
      skipCoverage: true,
      skipFlakeRerun: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.pass, 0);
    assert.equal(result.fail, 0);
    assert.match(String(result.error || ''), /0 tests|missing test reporter/i);
  });

  it('measureSuite: nonzero exit with no test failures → suite.ok false', async () => {
    const suite = require('../scripts/eval/suite');
    const runNodeTest = async () => ({
      code: 1,
      stdout: '',
      stderr: 'fatal: unexpected runner crash',
      events: [
        {
          type: 'test:pass',
          data: {
            name: 'looks fine',
            file: '/tmp/ok.test.js',
            details: { duration_ms: 1 },
          },
        },
      ],
      coverageSummary: null,
      coverageError: null,
    });
    const result = await suite.measureSuite({
      repoRoot,
      runNodeTest,
      skipCoverage: true,
      skipFlakeRerun: true,
    });
    assert.equal(result.ok, false);
    assert.equal(result.pass, 1);
    assert.equal(result.fail, 0);
    assert.equal(result.exitCode, 1);
    assert.match(String(result.error || ''), /exited 1|runner crash/i);
  });

  it('runNodeTest uses programmatic child (not --test-reporter=json)', () => {
    const suite = require('../scripts/eval/suite');
    assert.ok(suite.RUN_NODE_TEST_CHILD);
    assert.match(suite.RUN_NODE_TEST_CHILD, /run-node-test-child\.js$/);
    assert.ok(fs.existsSync(suite.RUN_NODE_TEST_CHILD));
    const childSrc = fs.readFileSync(suite.RUN_NODE_TEST_CHILD, 'utf8');
    assert.match(childSrc, /require\(['"]node:test['"]\)/);
    assert.match(childSrc, /\brun\s*\(/);
    const suiteSrc = fs.readFileSync(require.resolve('../scripts/eval/suite'), 'utf8');
    assert.doesNotMatch(suiteSrc, /--test-reporter=/);
    assert.match(suiteSrc, /run-node-test-child/);
  });

  it('dashboard API contract against in-process server', async () => {
    const api = require('../scripts/eval/dashboard-api');
    const checked = await api.runDashboardApiChecks({
      startServer: () => api.startInProcessDashboard(),
    });
    assert.equal(checked.ok, true, JSON.stringify(checked.routes, null, 2));
    assert.ok(checked.port > 0);
    const state = checked.routes.find((r) => r.path === '/api/state');
    assert.ok(state && state.ok);
    const loops = checked.routes.find((r) => r.path === '/api/loops');
    assert.ok(loops && loops.ok);
  });

  it('CLI: aflt eval measure --json with suite stubbed via env', () => {
    const env = {
      ...process.env,
      HOME: home,
      AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      AFLT_EVAL_SKIP_SUITE: '1',
      AFLT_EVAL_INPROCESS_DASHBOARD: '1',
      AFLT_EVAL_SKIP_COVERAGE: '1',
    };
    const r = spawnSync(
      process.execPath,
      [afJs, 'eval', 'measure', '--json', '--out', outDir],
      { encoding: 'utf8', env, cwd: repoRoot, timeout: 60_000 }
    );
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.ok, true);
    assert.ok(payload.path);
    assert.ok(fs.existsSync(payload.path));
    assert.equal(payload.suite.skipped, true);
    assert.equal(payload.cliSmoke.ok, true);
    assert.equal(payload.dashboardApi.ok, true);
  });

  it('CLI usage error for unknown eval subcommand', () => {
    const r = spawnSync(process.execPath, [afJs, 'eval', 'nope', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        AGENTFLEET_HOME: path.join(home, '.agentfleet'),
      },
      cwd: repoRoot,
      timeout: 10_000,
    });
    assert.notEqual(r.status, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /unknown eval subcommand/);
  });
});
