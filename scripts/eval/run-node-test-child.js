'use strict';

/**
 * Child entry for `scripts/eval/suite.js` `runNodeTest`.
 * Uses node:test programmatic `run()` and prints NDJSON events to stdout
 * (replaces the broken named "json" reporter on Node 24).
 *
 * Parent argv shape:
 *   node [--experimental-test-coverage] --import <setup> this-script.js <testFile>...
 */

const { run } = require('node:test');
const path = require('path');

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

  const stream = run({
    files,
    concurrency: 1,
  });

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

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exitCode = 1;
});
