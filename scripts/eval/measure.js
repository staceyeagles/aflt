'use strict';

/**
 * `aflt eval measure` — hermetic self-measurement harness.
 * Suite + flaky detection + coverage (best-effort) + CLI smoke + dashboard API.
 */

const fs = require('fs');
const path = require('path');
const { measureSuite, parseCoverageFixture } = require('./suite');
const { runCliSmoke } = require('./smoke');
const { runDashboardApiChecks, startInProcessDashboard } = require('./dashboard-api');
const { listTopLevelCommands, buildSmokePlan } = require('./commands');

function repoRootFromModule() {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Filename-safe ISO-like timestamp: 2026-11-21T17-01-00-123Z
 * @param {Date} [date]
 */
function resultsTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.outDir] default <repoRoot>/eval/results
 * @param {boolean} [opts.skipSuite]
 * @param {object} [opts.suiteResult] inject suite section
 * @param {Function} [opts.measureSuite]
 * @param {boolean} [opts.skipSmoke]
 * @param {object} [opts.smokeResult]
 * @param {Function} [opts.runCliSmoke]
 * @param {boolean} [opts.skipDashboardApi]
 * @param {object} [opts.dashboardApiResult]
 * @param {Function} [opts.runDashboardApiChecks]
 * @param {boolean} [opts.useInProcessDashboard] default true when AGENTFLEET_TEST / measuring nested
 * @param {object} [opts.coverageFixture]
 * @param {boolean} [opts.skipCoverage]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
async function measure(opts = {}) {
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const outDir = opts.outDir
    ? path.resolve(opts.outDir)
    : path.join(repoRoot, 'eval', 'results');
  const measuredAt = new Date().toISOString();
  const stamp = resultsTimestamp(new Date(measuredAt));

  // --- suite ---
  let suite;
  if (opts.suiteResult) {
    suite = opts.suiteResult;
  } else if (opts.skipSuite || process.env.AFLT_EVAL_SKIP_SUITE === '1') {
    suite = {
      ok: true,
      pass: 0,
      fail: 0,
      skip: 0,
      durationMs: 0,
      files: [],
      flakes: [],
      hardFails: [],
      coverage: opts.coverageFixture
        ? parseCoverageFixture(opts.coverageFixture)
        : { available: false, reason: 'suite skipped', totals: null },
      skipped: true,
      reason: 'suite skipped (stub/fixture path)',
    };
  } else {
    const runSuite = opts.measureSuite || measureSuite;
    suite = await runSuite({
      repoRoot,
      skipCoverage: opts.skipCoverage,
      coverageFixture: opts.coverageFixture,
      env: opts.env,
      timeoutMs: opts.suiteTimeoutMs,
      skipFlakeRerun: opts.skipFlakeRerun,
      testFiles: opts.testFiles,
      runNodeTest: opts.runNodeTest,
    });
  }

  // --- CLI smoke ---
  let cliSmoke;
  if (opts.smokeResult) {
    cliSmoke = opts.smokeResult;
  } else if (opts.skipSmoke) {
    cliSmoke = { ok: true, skipped: true, commands: [], failures: 0 };
  } else {
    const smokeFn = opts.runCliSmoke || runCliSmoke;
    cliSmoke = smokeFn({
      repoRoot,
      env: opts.env,
      plan: opts.smokePlan,
      sandboxHome: opts.sandboxHome,
      timeoutMs: opts.smokeTimeoutMs,
      spawnSync: opts.spawnSync,
    });
  }

  // --- dashboard API ---
  let dashboardApi;
  if (opts.dashboardApiResult) {
    dashboardApi = opts.dashboardApiResult;
  } else if (opts.skipDashboardApi) {
    dashboardApi = { ok: true, skipped: true, routes: [] };
  } else {
    const apiFn = opts.runDashboardApiChecks || runDashboardApiChecks;
    const useInProcess =
      opts.useInProcessDashboard === true ||
      process.env.AFLT_EVAL_INPROCESS_DASHBOARD === '1';

    if (useInProcess) {
      const os = require('os');
      const sandboxHome =
        opts.sandboxHome ||
        (cliSmoke && cliSmoke.sandboxHome) ||
        fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-eval-api-'));
      const afHome =
        (cliSmoke && cliSmoke.agentfleetHome) || path.join(sandboxHome, '.agentfleet');
      fs.mkdirSync(afHome, { recursive: true });
      const prevHome = process.env.AGENTFLEET_HOME;
      const prevUserHome = process.env.HOME;
      process.env.AGENTFLEET_HOME = afHome;
      process.env.HOME = sandboxHome;
      try {
        dashboardApi = await apiFn({
          startServer: () => startInProcessDashboard(opts),
          routes: opts.dashboardRoutes,
        });
      } finally {
        if (prevHome === undefined) delete process.env.AGENTFLEET_HOME;
        else process.env.AGENTFLEET_HOME = prevHome;
        if (prevUserHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevUserHome;
      }
    } else {
      dashboardApi = await apiFn({
        repoRoot,
        env: opts.env,
        sandboxHome: (cliSmoke && cliSmoke.sandboxHome) || opts.sandboxHome,
        routes: opts.dashboardRoutes,
      });
    }
  }

  const result = {
    version: 1,
    measuredAt,
    node: process.version,
    repoRoot,
    suite,
    coverage: suite.coverage || { available: false, reason: 'missing', totals: null },
    cliSmoke: {
      ok: Boolean(cliSmoke.ok),
      skipped: Boolean(cliSmoke.skipped),
      failures: cliSmoke.failures || 0,
      commandCount: (cliSmoke.commands || []).length,
      commands: cliSmoke.commands || [],
    },
    dashboardApi: {
      ok: Boolean(dashboardApi.ok),
      skipped: Boolean(dashboardApi.skipped),
      port: dashboardApi.port != null ? dashboardApi.port : null,
      routes: dashboardApi.routes || [],
    },
  };

  result.ok = Boolean(
    (suite.skipped || suite.ok) && result.cliSmoke.ok && result.dashboardApi.ok
  );

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `${stamp}.json`);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  result.path = outPath;

  return result;
}

module.exports = {
  measure,
  resultsTimestamp,
  repoRootFromModule,
  listTopLevelCommands,
  buildSmokePlan,
  measureSuite,
  parseCoverageFixture,
  runCliSmoke,
  runDashboardApiChecks,
};
