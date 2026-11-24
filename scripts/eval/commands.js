'use strict';

/**
 * Smoke-command catalog for `aflt eval measure`.
 * Derived from top-level USAGE entries in bin/af.js; mutating / networked /
 * blocking commands are skipped or forced to --dry-run.
 */

const path = require('path');

/** @typedef {'run'|'dry-run'|'skip'} SmokeMode */

/**
 * @typedef {object} SmokeCommand
 * @property {string} id
 * @property {string[]} argv
 * @property {SmokeMode} mode
 * @property {string} [reason]
 */

/**
 * Parse top-level `aflt <cmd>` names from USAGE text.
 * @param {string} usageText
 * @returns {string[]}
 */
function listTopLevelCommands(usageText) {
  const cmds = new Set();
  for (const line of String(usageText || '').split('\n')) {
    const m = line.match(/^\s*aflt\s+([a-z][\w-]*)\b/);
    if (m) cmds.add(m[1]);
  }
  // Aliases / short forms that appear in the switch but may be thin USAGE lines
  for (const extra of ['list', 'remove', 'set-cwd', 'pick', 'cursor', 'copilot', 'opencode']) {
    cmds.add(extra);
  }
  return [...cmds].sort();
}

/**
 * Build the hermetic smoke plan. Never touches live engines, Herdr, or network.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.loopExample]
 * @returns {SmokeCommand[]}
 */
function buildSmokePlan(opts = {}) {
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const loopExample =
    opts.loopExample || path.join(repoRoot, 'examples', 'loops', 'hello-eval.json');

  /** @type {SmokeCommand[]} */
  const plan = [
    { id: 'version', argv: ['version', '--json'], mode: 'run' },
    { id: 'help', argv: ['help'], mode: 'run' },
    { id: 'ls', argv: ['ls', '--json'], mode: 'run' },
    { id: 'doctor', argv: ['doctor', '--json'], mode: 'run' },
    { id: 'timeline', argv: ['timeline', '--json'], mode: 'run' },
    { id: 'projects', argv: ['projects', '--json'], mode: 'run' },
    { id: 'orphans', argv: ['orphans', '--json'], mode: 'run' },
    { id: 'children', argv: ['children', '--json'], mode: 'run' },
    { id: 'which-backend', argv: ['which-backend'], mode: 'run' },
    { id: 'engine', argv: ['engine'], mode: 'run' },
    {
      id: 'sync-dry-run',
      argv: ['sync', '--dry-run', '--json'],
      mode: 'skip',
      reason: 'needs Herdr (hc ls); not available in hermetic sandbox',
    },
    { id: 'setup-preview', argv: ['setup', '--json'], mode: 'run' },
    { id: 'memory-where', argv: ['memory', 'where', '--json'], mode: 'run' },
    { id: 'memory-status', argv: ['memory', 'status', '--json'], mode: 'run' },
    { id: 'loop-status', argv: ['loop', 'status', '--json'], mode: 'run' },
    { id: 'loop-validate', argv: ['loop', 'validate', loopExample, '--json'], mode: 'run' },
    {
      id: 'loop-run-dry',
      argv: ['loop', 'run', loopExample, '--dry-run', '--allow-existing', '--json'],
      mode: 'dry-run',
    },
    { id: 'turns-backfill', argv: ['turns', 'backfill', '--json'], mode: 'run' },
    { id: 'export', argv: ['export'], mode: 'run' },
    { id: 'service-status', argv: ['service', 'status', '--json'], mode: 'run' },
    { id: 'service-print', argv: ['service', 'install', '--print', '--json'], mode: 'run' },
    { id: 'herdr-app-status', argv: ['herdr-app', 'status'], mode: 'run' },
    { id: 'herdr-templates-dry', argv: ['herdr-templates', '--dry-run'], mode: 'dry-run' },
    { id: 'docs-status', argv: ['docs', '--status', '--json'], mode: 'run' },
    { id: 'purge-dry', argv: ['purge', 'missing-eval-id', '--json'], mode: 'run', reason: 'dry-run default (no --apply)' },
    // Eval report/plateau are cheap + empty-history safe; measure/score/gate skipped
    { id: 'eval-report', argv: ['eval', 'report', '--json'], mode: 'run' },
    { id: 'eval-plateau', argv: ['eval', 'plateau', '--json'], mode: 'run' },
    {
      id: 'eval-gate',
      argv: ['eval', 'gate', '--json'],
      mode: 'skip',
      reason: 'RUBRIC GUARD fails on dirty/untracked protected paths; covered by eval-e2',
    },
    {
      id: 'eval-measure',
      argv: ['eval', 'measure'],
      mode: 'skip',
      reason: 'expensive nested suite; covered by eval-e1 tests',
    },
    {
      id: 'eval-score',
      argv: ['eval', 'score'],
      mode: 'skip',
      reason: 'needs measure results; covered by eval-e2 tests',
    },

    // Mutating — dry-run only
    {
      id: 'new-dry',
      argv: ['new', 'eval-smoke-new', '--dry-run', '--prompt', 'noop'],
      mode: 'dry-run',
    },
    {
      id: 'run-dry',
      argv: ['run', 'eval-smoke-run', '--prompt', 'noop', '--dry-run', '--json'],
      mode: 'dry-run',
    },
    {
      id: 'master-dry',
      argv: ['master', '--goal', 'noop', '--dry-run', '--json'],
      mode: 'dry-run',
    },
    {
      id: 'rm-dry',
      argv: ['rm', 'missing-eval-id', '--dry-run'],
      mode: 'dry-run',
    },
    {
      id: 'archive-dry',
      argv: ['archive', 'missing-eval-id', '--dry-run', '--json'],
      mode: 'dry-run',
    },

    // Skip: destructive apply, network, interactive, blocking, live engines
    { id: 'setup-apply', argv: ['setup', '--apply'], mode: 'skip', reason: 'mutates machine; use preview only' },
    { id: 'service-install', argv: ['service', 'install'], mode: 'skip', reason: 'writes LaunchAgent' },
    { id: 'service-uninstall', argv: ['service', 'uninstall'], mode: 'skip', reason: 'mutates LaunchAgent' },
    { id: 'loop-start', argv: ['loop', 'start'], mode: 'skip', reason: 'registers active loop' },
    { id: 'loop-run', argv: ['loop', 'run'], mode: 'skip', reason: 'live engine; use --dry-run entry' },
    { id: 'dashboard-serve', argv: ['dashboard', '--serve'], mode: 'skip', reason: 'covered by dashboardApi section' },
    { id: 'notify-test', argv: ['notify', 'test'], mode: 'skip', reason: 'network webhook' },
    { id: 'mcp', argv: ['mcp'], mode: 'skip', reason: 'stdio server blocks' },
    { id: 'send', argv: ['send'], mode: 'skip', reason: 'mutates / needs live session' },
    { id: 'wait', argv: ['wait'], mode: 'skip', reason: 'blocks on workers' },
    { id: 'resume', argv: ['resume'], mode: 'skip', reason: 'live engine / Herdr' },
    { id: 'new', argv: ['new'], mode: 'skip', reason: 'live engine; use new-dry' },
    { id: 'run', argv: ['run'], mode: 'skip', reason: 'live engine; use run-dry' },
    { id: 'spawn', argv: ['spawn'], mode: 'skip', reason: 'live engine' },
    { id: 'import', argv: ['import'], mode: 'skip', reason: 'scans real engine homes' },
    { id: 'memory-doc', argv: ['memory', 'doc'], mode: 'skip', reason: 'live engine' },
    { id: 'purge-apply', argv: ['purge', '--apply'], mode: 'skip', reason: 'destructive' },
  ];

  return plan;
}

module.exports = {
  listTopLevelCommands,
  buildSmokePlan,
};
