'use strict';

/**
 * Child entry for `scripts/eval/suite.js` `runNodeTest`.
 * Uses node:test programmatic `run()` and prints NDJSON events to stdout
 * (replaces the broken named "json" reporter on Node 24).
 *
 * Parent argv shape:
 *   node [--experimental-test-coverage] --import <setup> this-script.js <testFile>...
 *
 * Coverage: on Node 24 the CLI `--experimental-test-coverage` flag alone does
 * not make programmatic `run()` emit `test:coverage`. Pass `coverage: true`
 * when the parent requested coverage (flag in `process.execArgv` and/or
 * `AFLT_EVAL_COVERAGE=1`). Best-effort: if the option is rejected, fall back
 * without it so the parent can mark coverage unavailable.
 */

const { run } = require('node:test');
const path = require('path');

/**
 * @returns {boolean}
 */
function coverageRequested() {
  if (process.env.AFLT_EVAL_COVERAGE === '1') return true;
  const argv = Array.isArray(process.execArgv) ? process.execArgv : [];
  return argv.some(
    (a) =>
      a === '--experimental-test-coverage' ||
      String(a).startsWith('--experimental-test-coverage=')
  );
}

/**
 * @param {string[]} files
 * @param {boolean} withCoverage
 */
function startRun(files, withCoverage) {
  const opts = { files, concurrency: 1 };
  if (withCoverage) opts.coverage = true;
  return run(opts);
}

async function main() {
  const files = process.argv
    .slice(2)
    .filter((a) => a && !a.startsWith('-'))
    .map((a) => path.resolve(a));

  if (!files.length) {
    process.stderr.write('run-node-test-child: no test files\n');
    process.exitCode = 1;
    return;
  }

  const wantCoverage = coverageRequested();
  let stream;
  try {
    stream = startRun(files, wantCoverage);
  } catch (err) {
    if (wantCoverage) {
      process.stderr.write(
        'run-node-test-child: coverage option failed; retrying without: ' +
          String(err && err.message ? err.message : err) +
          '\n'
      );
      stream = startRun(files, false);
    } else {
      throw err;
    }
  }

  let failed = 0;
  for await (const event of stream) {
    try {
      process.stdout.write(JSON.stringify(event) + '\n');
    } catch (_) {
      /* ignore broken pipe */
    }
    if (event && event.type === 'test:fail') failed += 1;
    if (
      event &&
      event.type === 'test:summary' &&
      event.data &&
      event.data.counts &&
      Number(event.data.counts.fail) > 0
    ) {
      failed = Math.max(failed, Number(event.data.counts.fail) || 0);
    }
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

module.exports = {
  coverageRequested,
  startRun,
};

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
    process.exitCode = 1;
  });
}
