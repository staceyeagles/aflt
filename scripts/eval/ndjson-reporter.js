'use strict';

/**
 * Custom node:test reporter for `aflt eval measure`.
 * Writes one NDJSON event per line to stdout (same shape as the programmatic
 * `run()` stream). Used instead of the named `json` reporter, which Node 24.7
 * resolves as a package name (ERR_MODULE_NOT_FOUND).
 *
 * Coverage events (`test:coverage`) flow through this reporter when the process
 * is started with `--experimental-test-coverage` (or equivalent).
 *
 * @param {AsyncIterable<object>} source
 */
module.exports = async function* ndjsonReporter(source) {
  for await (const event of source) {
    // Yielded chunks are written to the reporter destination (stdout by default).
    yield `${JSON.stringify(event)}\n`;
  }
};
