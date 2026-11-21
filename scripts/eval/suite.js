'use strict';

/**
 * Hermetic test-suite measurement for `aflt eval measure`.
 * Spawns `node --test` with a path-based NDJSON reporter (not the named
 * `json` reporter, which Node 24.7 resolves as a package → ERR_MODULE_NOT_FOUND).
 * Reruns failed files once for flake detection. Coverage via
 * `--experimental-test-coverage` when supported (`test:coverage` flows through
 * the same reporter).
 *
 * Avoids programmatic `run()` in a child: under Node 24 that path can warn
 * "run() is being called recursively… skipping running files" and drop coverage.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

/** Path-based reporter that writes NDJSON test events to stdout. */
const NDJSON_REPORTER = path.join(__dirname, 'ndjson-reporter.js');

/** @deprecated Legacy programmatic child; measure uses --test + NDJSON_REPORTER. */
const RUN_NODE_TEST_CHILD = path.join(__dirname, 'run-node-test-child.js');

/**
 * @param {string} repoRoot
 * @returns {string[]}
 */
function listTestFiles(repoRoot) {
  const dir = path.join(repoRoot, 'test');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.test.js'))
      .map((f) => path.join(dir, f))
      .sort();
  } catch (_) {
    return [];
  }
}

/**
 * Make a nested measure spawn look like a top-level runner.
 * Node sets `NODE_TEST_CONTEXT` while inside `--test`; inheriting it makes the
 * child warn "run() is being called recursively… skipping running files" and
 * drop all events/coverage. Also strip parent `--test` flags from NODE_OPTIONS.
 * @param {NodeJS.ProcessEnv} env
 */
function scrubEnvForNestedTestRunner(env) {
  if (!env || typeof env !== 'object') return;
  delete env.NODE_TEST_CONTEXT;
  if (env.NODE_OPTIONS == null || env.NODE_OPTIONS === '') return;
  const scrubbed = String(env.NODE_OPTIONS)
    .replace(/(^|\s)--experimental-test-coverage(?:=\S*)?(?=\s|$)/g, ' ')
    .replace(/(^|\s)--test-reporter(?:=\S*)?(?=\s|$)/g, ' ')
    .replace(/(^|\s)--test-concurrency(?:=\S*)?(?=\s|$)/g, ' ')
    .replace(/(^|\s)--test(?:=\S*)?(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (scrubbed) env.NODE_OPTIONS = scrubbed;
  else delete env.NODE_OPTIONS;
}

/** @deprecated Use scrubEnvForNestedTestRunner */
function scrubNodeOptionsForNestedRunner(env) {
  scrubEnvForNestedTestRunner(env);
}

/**
 * @param {object} opts
 * @param {string} opts.repoRoot
 * @param {string[]} [opts.testFiles]
 * @param {boolean} [opts.coverage]
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {number} [opts.timeoutMs]
 * @param {string} [opts.reporterPath] override NDJSON reporter path (tests)
 * @param {string} [opts.childScript] ignored (legacy)
 */
function runNodeTest(opts) {
  const repoRoot = opts.repoRoot;
  const testFiles =
    opts.testFiles && opts.testFiles.length ? opts.testFiles : listTestFiles(repoRoot);
  const reporterPath = path.resolve(opts.reporterPath || NDJSON_REPORTER);

  const args = [];
  if (opts.coverage) {
    args.push('--experimental-test-coverage');
  }
  args.push(
    '--import',
    path.join(repoRoot, 'test', '_setup.js'),
    '--test',
    '--test-concurrency=1',
    `--test-reporter=${reporterPath}`,
    ...testFiles
  );

  const env = {
    ...process.env,
    ...(opts.env || {}),
    AFLT_EVAL_MEASURING: '1',
  };
  scrubEnvForNestedTestRunner(env);
  if (opts.coverage) {
    env.AFLT_EVAL_COVERAGE = '1';
  } else {
    delete env.AFLT_EVAL_COVERAGE;
  }

  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, {
      cwd: repoRoot,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer =
      opts.timeoutMs && opts.timeoutMs > 0
        ? setTimeout(() => {
            try {
              child.kill('SIGTERM');
            } catch (_) {
              /* ignore */
            }
          }, opts.timeoutMs)
        : null;

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      stdout += d;
    });
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        code: 1,
        stdout,
        stderr: stderr + String(err.message || err),
        events: [],
        coverageSummary: null,
        coverageError: String(err.message || err),
      });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      const parsed = parseTestReporterOutput(stdout);
      resolve({
        code,
        stdout,
        stderr,
        events: parsed.events,
        coverageSummary: parsed.coverageSummary,
        coverageError: null,
      });
    });
  });
}

/**
 * Parse node test-reporter NDJSON (and tolerate trailing garbage).
 * @param {string} text
 */
function parseTestReporterOutput(text) {
  const events = [];
  let coverageSummary = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed[0] !== '{') continue;
    try {
      const ev = JSON.parse(trimmed);
      events.push(ev);
      if (ev.type === 'test:coverage' && ev.data) {
        const summary = ev.data.summary || ev.data;
        const normalized = normalizeCoverageSummary(summary);
        if (normalized) coverageSummary = normalized;
      }
    } catch (_) {
      /* ignore non-json lines */
    }
  }
  return { events, coverageSummary };
}

function normalizeCoverageSummary(summary) {
  if (!summary || typeof summary !== 'object') return null;
  const totals = summary.totals || summary;

  // Node 24+ flat shape from --experimental-test-coverage:
  // { totalLineCount, coveredLineCount, coveredLinePercent, ... }
  if (
    totals &&
    typeof totals === 'object' &&
    (totals.totalLineCount != null ||
      totals.coveredLinePercent != null ||
      totals.coveredLineCount != null)
  ) {
    const flat = (kind) => {
      const totalKey = `total${kind}Count`;
      const coveredKey = `covered${kind}Count`;
      const percentKey = `covered${kind}Percent`;
      if (totals[totalKey] == null && totals[percentKey] == null && totals[coveredKey] == null) {
        return null;
      }
      const total = Number(totals[totalKey]) || 0;
      const covered = Number(totals[coveredKey]) || 0;
      // Node reports covered*Percent=100 when nothing was instrumented; treat as 0.
      const percent =
        total <= 0
          ? 0
          : totals[percentKey] != null
            ? Number(totals[percentKey])
            : Math.round((covered / total) * 10000) / 100;
      return { total, covered, percent };
    };
    const lines = flat('Line');
    const functions = flat('Function');
    const branches = flat('Branch');
    if (lines || functions || branches) {
      return { lines, functions, branches };
    }
  }

  const pick = (key) => {
    const row = totals[key] || totals[key.replace(/s$/, '')];
    if (!row || typeof row !== 'object') return null;
    const total = Number(row.total != null ? row.total : row.count) || 0;
    const covered = Number(row.covered != null ? row.covered : row.coveredCount) || 0;
    const percent =
      row.percent != null
        ? Number(row.percent)
        : total > 0
          ? Math.round((covered / total) * 10000) / 100
          : 0;
    return { total, covered, percent };
  };
  const lines = pick('lines');
  if (!lines && !pick('functions') && !pick('branches')) {
    // Fixture may already be { lines: {...}, ... }
    if (summary.lines || summary.functions || summary.branches) {
      return {
        lines: summary.lines || null,
        functions: summary.functions || null,
        branches: summary.branches || null,
      };
    }
    return null;
  }
  return {
    lines: lines,
    functions: pick('functions'),
    branches: pick('branches'),
  };
}

/**
 * Summarize pass/fail/skip + per-file durations from reporter events.
 * @param {object[]} events
 */
function summarizeEvents(events) {
  let pass = 0;
  let fail = 0;
  let skip = 0;
  let durationMs = 0;
  let hasSummary = false;
  /** @type {Map<string, { file: string, durationMs: number, pass: number, fail: number, skip: number, failedNames: string[] }>} */
  const byFile = new Map();

  const ensure = (file) => {
    const key = file || '(unknown)';
    if (!byFile.has(key)) {
      byFile.set(key, {
        file: key,
        durationMs: 0,
        pass: 0,
        fail: 0,
        skip: 0,
        failedNames: [],
      });
    }
    return byFile.get(key);
  };

  for (const ev of events) {
    const type = ev && ev.type;
    const data = (ev && ev.data) || {};
    const file = data.file || data.filename || null;
    const name = data.name || data.title || '';
    const details = data.details || {};
    const dur =
      typeof details.duration_ms === 'number'
        ? details.duration_ms
        : typeof data.duration_ms === 'number'
          ? data.duration_ms
          : 0;

    // Only count leaf tests (nesting === 0 or undefined for some reporters; prefer !data.nesting || leaf)
    // Node's JSON reporter includes suite containers; count entries with type pass/fail that have a name.
    if (type === 'test:pass') {
      if (data.skip || data.todo) {
        skip += 1;
        const row = ensure(file);
        row.skip += 1;
        row.durationMs += dur;
      } else {
        pass += 1;
        const row = ensure(file);
        row.pass += 1;
        row.durationMs += dur;
      }
      durationMs += dur;
    } else if (type === 'test:fail') {
      fail += 1;
      durationMs += dur;
      const row = ensure(file);
      row.fail += 1;
      row.durationMs += dur;
      if (name) row.failedNames.push(name);
    } else if (type === 'test:skip' || type === 'test:todo') {
      skip += 1;
      const row = ensure(file);
      row.skip += 1;
    }
  }

  for (const ev of events) {
    if (ev.type === 'test:summary' && ev.data && typeof ev.data.counts === 'object') {
      hasSummary = true;
      const c = ev.data.counts;
      if (c.pass != null) pass = Number(c.pass) || pass;
      if (c.fail != null) fail = Number(c.fail) || fail;
      if (c.skip != null || c.todo != null || c.cancelled != null) {
        skip = Number(c.skip || 0) + Number(c.todo || 0) + Number(c.cancelled || 0);
      }
      if (typeof ev.data.duration_ms === 'number') durationMs = ev.data.duration_ms;
    }
  }

  const files = [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file));
  const testsRan = pass + fail + skip > 0;
  return { pass, fail, skip, durationMs, files, hasSummary, testsRan };
}

/**
 * Decide whether the suite measurement is green, and an error string when not.
 * Nonzero exit / 0 tests ran / missing usable summary must not look like suite.ok.
 * Flake recovery may leave first.code !== 0 while final fail===0 — that stays ok.
 *
 * @param {object} opts
 * @param {ReturnType<typeof summarizeEvents>} opts.summary
 * @param {number|null} opts.exitCode
 * @param {string} [opts.stderr]
 * @param {number} [opts.eventCount]
 * @param {{ file: string, name: string }[]} opts.hardFails
 * @param {{ file: string, name: string }[]} opts.flakes
 */
function evaluateSuiteOk(opts) {
  const summary = opts.summary || {
    pass: 0,
    fail: 0,
    skip: 0,
    testsRan: false,
    hasSummary: false,
  };
  const hardFails = opts.hardFails || [];
  const flakes = opts.flakes || [];
  const exitCode = opts.exitCode;
  const stderr = opts.stderr || '';
  const eventCount = Number(opts.eventCount) || 0;
  const testsRan = Boolean(summary.testsRan);
  const fail = Number(summary.fail) || 0;
  const stderrBit = stderr ? `: ${excerpt(stderr, 240)}` : '';

  // No leaf tests and no test:summary counts → missing/unusable summary.
  if (!testsRan) {
    if (exitCode && exitCode !== 0) {
      return {
        ok: false,
        error: `test runner exited ${exitCode} with 0 tests run${stderrBit}`,
      };
    }
    if (eventCount === 0) {
      return {
        ok: false,
        error: `missing test reporter summary (0 events)${stderrBit}`,
      };
    }
    return {
      ok: false,
      error: '0 tests ran (empty suite or reporter produced no pass/fail/skip)',
    };
  }

  if (hardFails.length > 0 || fail > 0) {
    return {
      ok: false,
      error: `suite failures fail=${fail} hardFails=${hardFails.length}`,
    };
  }

  // Nonzero exit with no recorded test failures and no flake recovery → runner error
  if (exitCode && exitCode !== 0 && flakes.length === 0) {
    return {
      ok: false,
      error: `test runner exited ${exitCode}${stderrBit}`,
    };
  }

  return { ok: true, error: null };
}

/**
 * Run suite (+ optional coverage) with one flake rerun of failed files.
 * Does not fail the measure run when coverage is unavailable.
 * @param {object} [opts]
 */
async function measureSuite(opts = {}) {
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const runner = opts.runNodeTest || runNodeTest;

  // Prefer a single pass with coverage; if the flag is rejected, retry without.
  let first;
  let coverage = { available: false, reason: 'not collected', totals: null };

  if (opts.skipCoverage) {
    first = await runner({
      repoRoot,
      testFiles: opts.testFiles,
      coverage: false,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      childScript: opts.childScript,
    });
    if (opts.coverageFixture) {
      coverage = parseCoverageFixture(opts.coverageFixture);
    } else {
      coverage = { available: false, reason: 'coverage skipped', totals: null };
    }
  } else {
    first = await runner({
      repoRoot,
      testFiles: opts.testFiles,
      coverage: true,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      childScript: opts.childScript,
    });
    if (first.coverageSummary) {
      const lineTotal =
        first.coverageSummary.lines && Number(first.coverageSummary.lines.total);
      if (lineTotal != null && lineTotal <= 0) {
        // Event present but nothing instrumented (e.g. tests outside cwd) —
        // do not claim availability with a fake 100% from Node.
        coverage = {
          available: false,
          reason: 'coverage event present but no instrumented lines',
          totals: first.coverageSummary,
        };
      } else {
        coverage = { available: true, reason: null, totals: first.coverageSummary };
      }
    } else if (
      first.events.length === 0 &&
      /experimental-test-coverage|ERR_UNKNOWN|bad option|not support/i.test(
        first.stderr || ''
      )
    ) {
      first = await runner({
        repoRoot,
        testFiles: opts.testFiles,
        coverage: false,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
        childScript: opts.childScript,
      });
      coverage = {
        available: false,
        reason: 'node --experimental-test-coverage unsupported on this runtime',
        totals: null,
        stderrExcerpt: excerpt(first.stderr, 240),
      };
    } else if (first.events.length === 0) {
      coverage = {
        available: false,
        reason: 'suite runner produced no events (coverage not collected)',
        totals: null,
        stderrExcerpt: excerpt(first.stderr, 240),
      };
    } else {
      coverage = {
        available: false,
        reason: 'coverage summary missing from test reporter output',
        totals: null,
      };
    }
  }

  const summary = summarizeEvents(first.events);
  const failedFiles = summary.files.filter((f) => f.fail > 0).map((f) => f.file);

  /** @type {{ file: string, name: string }[]} */
  const flakes = [];
  /** @type {{ file: string, name: string }[]} */
  const hardFails = [];

  if (failedFiles.length > 0 && !opts.skipFlakeRerun) {
    const second = await runner({
      repoRoot,
      testFiles: failedFiles,
      coverage: false,
      env: opts.env,
      timeoutMs: opts.timeoutMs,
      childScript: opts.childScript,
    });
    const secondSummary = summarizeEvents(second.events);
    const stillFail = new Set(
      secondSummary.files.filter((f) => f.fail > 0).map((f) => f.file)
    );
    for (const file of failedFiles) {
      const firstRow = summary.files.find((f) => f.file === file);
      const names = (firstRow && firstRow.failedNames.length
        ? firstRow.failedNames
        : [path.basename(file)]);
      if (stillFail.has(file)) {
        for (const name of names) hardFails.push({ file, name });
      } else {
        for (const name of names) flakes.push({ file, name });
        if (firstRow) {
          summary.fail = Math.max(0, summary.fail - firstRow.fail);
          summary.pass += firstRow.fail;
          firstRow.pass += firstRow.fail;
          firstRow.fail = 0;
          firstRow.failedNames = [];
        }
      }
    }
  } else if (failedFiles.length > 0) {
    for (const file of failedFiles) {
      const firstRow = summary.files.find((f) => f.file === file);
      const names = (firstRow && firstRow.failedNames.length
        ? firstRow.failedNames
        : [path.basename(file)]);
      for (const name of names) hardFails.push({ file, name });
    }
  }

  // Recompute testsRan after flake bookkeeping (pass/fail may have shifted).
  summary.testsRan = summary.pass + summary.fail + summary.skip > 0;

  const verdict = evaluateSuiteOk({
    summary,
    exitCode: first.code,
    stderr: first.stderr,
    eventCount: (first.events && first.events.length) || 0,
    hardFails,
    flakes,
  });

  return {
    ok: verdict.ok,
    error: verdict.error,
    pass: summary.pass,
    fail: summary.fail,
    skip: summary.skip,
    durationMs: Math.round(summary.durationMs),
    files: summary.files.map(({ failedNames, ...rest }) => rest),
    flakes,
    hardFails,
    coverage,
    exitCode: first.code,
  };
}

/**
 * Parse a coverage fixture (for hermetic tests that skip spawning the suite).
 * @param {object|string} fixture
 */
function parseCoverageFixture(fixture) {
  const raw = typeof fixture === 'string' ? JSON.parse(fixture) : fixture;
  if (!raw || raw.available === false) {
    return {
      available: false,
      reason: (raw && raw.reason) || 'unavailable',
      totals: null,
    };
  }
  const totals = normalizeCoverageSummary(raw.summary || raw.totals || raw);
  return {
    available: Boolean(totals),
    reason: totals ? null : 'invalid coverage fixture',
    totals,
  };
}

function excerpt(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

module.exports = {
  listTestFiles,
  runNodeTest,
  parseTestReporterOutput,
  summarizeEvents,
  evaluateSuiteOk,
  measureSuite,
  parseCoverageFixture,
  normalizeCoverageSummary,
  scrubEnvForNestedTestRunner,
  scrubNodeOptionsForNestedRunner,
  NDJSON_REPORTER,
  RUN_NODE_TEST_CHILD,
};
