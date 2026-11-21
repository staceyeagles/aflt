'use strict';

/**
 * Sandboxed CLI smoke runner for `aflt eval measure`.
 * Uses a throwaway AGENTFLEET_HOME (+ HOME). Never touches ~/.agentfleet or Herdr.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { buildSmokePlan } = require('./commands');

const STDERR_EXCERPT = 200;

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.afJs]
 * @param {string} [opts.sandboxHome] existing temp dir (created if omitted)
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @param {ReturnType<typeof buildSmokePlan>} [opts.plan]
 * @param {number} [opts.timeoutMs] per-command
 * @param {Function} [opts.spawnSync] inject for tests
 */
function runCliSmoke(opts = {}) {
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const afJs = opts.afJs || path.join(repoRoot, 'bin', 'af.js');
  const createdHome = !opts.sandboxHome;
  const sandboxHome =
    opts.sandboxHome || fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-eval-smoke-'));
  const afHome = path.join(sandboxHome, '.agentfleet');
  fs.mkdirSync(afHome, { recursive: true });

  const hermeticDir = path.join(repoRoot, 'test', 'fixtures', 'hermetic');
  const plan = opts.plan || buildSmokePlan({ repoRoot });
  const spawn = opts.spawnSync || spawnSync;
  const timeoutMs = opts.timeoutMs != null ? opts.timeoutMs : 30_000;

  const baseEnv = {
    ...process.env,
    ...(opts.env || {}),
    HOME: sandboxHome,
    AGENTFLEET_HOME: afHome,
    AFLT_EVAL_MEASURING: '1',
    // Prefer hermetic stubs when present
    AGENTFLEET_HC_BIN:
      process.env.AGENTFLEET_HC_BIN || path.join(hermeticDir, 'hc'),
    AGENTFLEET_HERDR_APP_BIN:
      process.env.AGENTFLEET_HERDR_APP_BIN || path.join(hermeticDir, 'herdr-app'),
  };

  const commands = [];
  for (const entry of plan) {
    if (entry.mode === 'skip') {
      commands.push({
        id: entry.id,
        argv: entry.argv,
        mode: 'skip',
        reason: entry.reason || 'skipped',
        exitCode: null,
        stdoutBytes: 0,
        stderrBytes: 0,
        stderrExcerpt: '',
        skipped: true,
      });
      continue;
    }

    const result = spawn(process.execPath, [afJs, ...entry.argv], {
      cwd: repoRoot,
      env: baseEnv,
      encoding: 'utf8',
      timeout: timeoutMs,
      maxBuffer: 2 * 1024 * 1024,
    });

    const stdout = result.stdout == null ? '' : String(result.stdout);
    const stderr = result.stderr == null ? '' : String(result.stderr);
    const exitCode =
      result.error && result.error.code === 'ETIMEDOUT'
        ? 124
        : result.status == null
          ? 1
          : result.status;

    commands.push({
      id: entry.id,
      argv: entry.argv,
      mode: entry.mode,
      reason: entry.reason || null,
      exitCode,
      stdoutBytes: Buffer.byteLength(stdout, 'utf8'),
      stderrBytes: Buffer.byteLength(stderr, 'utf8'),
      stderrExcerpt: excerpt(stderr, STDERR_EXCERPT),
      skipped: false,
      signal: result.signal || null,
      error: result.error ? String(result.error.message || result.error) : null,
    });
  }

  // Smoke "ok" means every non-skipped command exited 0, or exited non-zero
  // only when that is an expected empty-sandbox / usage path.
  const expectedNonZero = new Set([
    'purge-dry',
    'rm-dry',
    'archive-dry',
    'memory-where',
    'memory-status',
    'service-status', // unsupported off macOS; unloaded when no LaunchAgent
    'herdr-app-status', // panel may be missing
    'docs-status', // may skip when not a docs-enabled project
  ]);
  let failures = 0;
  for (const c of commands) {
    if (c.skipped) continue;
    if (c.exitCode === 0) continue;
    if (expectedNonZero.has(c.id)) continue;
    failures += 1;
    c.unexpectedFailure = true;
  }

  return {
    ok: failures === 0,
    sandboxHome: createdHome ? sandboxHome : opts.sandboxHome,
    agentfleetHome: afHome,
    commands,
    failures,
  };
}

function excerpt(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

module.exports = {
  runCliSmoke,
  excerpt,
};
