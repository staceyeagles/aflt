'use strict';

/**
 * Exact-first session resolution with an optional TTY picker for fuzzy candidates.
 * Used by destructive commands (rm, stop) so scripts/agents never get prompts.
 */

const readline = require('node:readline');
const registry = require('./registry');
const project = require('./project');

/**
 * Collect fuzzy candidates the same way findInSessions would (unique hit or
 * all ambiguous matches). Empty when nothing fuzzy-matches.
 * @param {string} query
 * @param {object[]} [sessions]
 * @returns {object[]}
 */
function collectFuzzyCandidates(query, sessions) {
  const list = Array.isArray(sessions) ? sessions : registry.list({ includeDone: true });
  try {
    const hit = registry.findInSessions(list, query);
    return hit ? [hit] : [];
  } catch (err) {
    if (err && err.code === 'AMBIGUOUS' && Array.isArray(err.matches)) {
      return err.matches.slice();
    }
    throw err;
  }
}

/**
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [io]
 * @param {{ json?: boolean }} [opts]
 */
function isInteractiveResolve(io = {}, opts = {}) {
  if (opts.json) return false;
  // Test-only hook: honored only under the test harness (NODE_ENV=test), never in
  // normal CLI use. Not a user setting.
  if (process.env.NODE_ENV === 'test') {
    const forced = process.env.AFLT_TEST_TTY;
    if (forced === '1' || forced === 'true') return true;
  }
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  return Boolean(input.isTTY && output.isTTY);
}

function formatCandidateHint(candidates) {
  return candidates.map((s) => `${s.title} (${s.id})`).join(', ');
}

function formatCandidateRow(s, index, cache) {
  const proj = project.resolveProjectName(s, { cache }) || '-';
  const status = s.status || '-';
  const cwd = s.cwd || '-';
  return `  ${index}  ${s.id}  ${s.title}  ${status}  ${proj}  ${cwd}`;
}

/**
 * Read one line; always closes the readline interface.
 * @param {string} question
 * @param {{ input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream }} [io]
 * @returns {Promise<string|null>} null on EOF
 */
function promptLine(question, io = {}) {
  const input = io.input || process.stdin;
  const output = io.output || process.stdout;
  const rl = readline.createInterface({ input, output, terminal: false });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        rl.removeAllListeners();
        rl.close();
      } catch (_) {
        /* ignore */
      }
      resolve(value);
    };
    // EOF / closed stdin with no line → cancel (null).
    rl.once('close', () => finish(null));
    rl.question(question, (answer) => finish(answer == null ? null : String(answer)));
  });
}

function cancelledError() {
  const err = new Error('cancelled');
  err.code = 'CANCELLED';
  return err;
}

function notFoundError(query, candidates, command) {
  let msg = `no session matches "${query}"`;
  if (candidates && candidates.length) {
    msg += ` (did you mean ${formatCandidateHint(candidates)}? ${command} requires an exact id or title)`;
  }
  const err = new Error(msg);
  err.code = 'NOT_FOUND';
  err.candidates = candidates || [];
  return err;
}

/**
 * Resolve a session for a destructive command.
 * Exact id/chatId/title wins. Otherwise, on an interactive TTY (and not --json),
 * prompt to confirm a single fuzzy candidate or pick among several. Non-TTY / --json
 * keep exact-only behavior with a did-you-mean hint (all candidates listed).
 *
 * @param {string} query
 * @param {{
 *   verb?: string,
 *   json?: boolean,
 *   command?: string,
 *   io?: { input?: NodeJS.ReadableStream, output?: NodeJS.WritableStream },
 *   sessions?: object[],
 * }} [opts]
 * @returns {Promise<object>}
 */
async function resolveSessionInteractive(query, opts = {}) {
  const verb = opts.verb || 'Select';
  const command = opts.command || 'this command';
  const io = opts.io || {};
  const sessions = opts.sessions;

  let exact;
  try {
    exact = sessions
      ? registry.findExactInSessions(sessions, query)
      : registry.findExact(query);
  } catch (err) {
    throw err;
  }
  if (exact) return exact;

  const candidates = collectFuzzyCandidates(query, sessions);
  if (candidates.length === 0) {
    throw notFoundError(query, [], command);
  }

  if (!isInteractiveResolve(io, { json: opts.json })) {
    throw notFoundError(query, candidates, command);
  }

  const output = io.output || process.stdout;
  const cache = project.createLookupCache();

  if (candidates.length === 1) {
    const s = candidates[0];
    const answer = await promptLine(`${verb} ${s.title} (${s.id})? [y/N] `, io);
    if (answer == null) throw cancelledError();
    const normalized = String(answer).trim().toLowerCase();
    if (normalized === 'y' || normalized === 'yes') return s;
    throw cancelledError();
  }

  for (let i = 0; i < candidates.length; i++) {
    output.write(formatCandidateRow(candidates[i], i + 1, cache) + '\n');
  }
  const answer = await promptLine(`${verb} which? [1-${candidates.length}, Enter to cancel] `, io);
  if (answer == null || String(answer).trim() === '') throw cancelledError();
  const n = Number.parseInt(String(answer).trim(), 10);
  if (!Number.isInteger(n) || n < 1 || n > candidates.length) throw cancelledError();
  return candidates[n - 1];
}

module.exports = {
  collectFuzzyCandidates,
  isInteractiveResolve,
  resolveSessionInteractive,
  promptLine,
  formatCandidateHint,
};
