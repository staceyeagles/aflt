'use strict';

const crypto = require('crypto');
const { which } = require('./util');

/**
 * GitHub Copilot CLI (`copilot`), verified on Mini 2026-11-10:
 *   /usr/local/bin/copilot  version 1.0.83
 * Headless: -p/--prompt, --output-format text|json, --silent,
 *   -C <dir>, --session-id=<uuid> (create or resume), --model,
 *   --allow-all-tools (required for non-interactive mode per --help).
 * `gh copilot` is a preview wrapper around the same CLI; af calls `copilot` directly.
 * This is not `gh` repository tooling (issue/pr/repo) and not `gh agent-task`.
 */
function resolveCopilotBin() {
  if (process.env.AGENTFLEET_COPILOT_BIN) return process.env.AGENTFLEET_COPILOT_BIN;
  return which('copilot') || 'copilot';
}

function newSessionId() {
  return crypto.randomUUID();
}

function buildPrintArgs(session, { prompt, force = false, outputFormat = 'text', silent = true } = {}) {
  if (!prompt) throw new Error('prompt is required for a Copilot headless run');
  const fmt = outputFormat || 'text';
  if (fmt !== 'text' && fmt !== 'json') {
    throw new Error(`unsupported copilot --output-format: ${fmt} (want text or json)`);
  }
  const args = ['-p', String(prompt), '--output-format', fmt];
  if (silent) args.push('--silent');
  const cwd = session && session.cwd;
  if (cwd) args.push('-C', cwd);
  if (session && session.model) args.push('--model', session.model);
  // --session-id sets the UUID for a new session or resumes that id later
  // (copilot --help). Using --resume= on a freshly minted id fails with
  // "No session, task, or name matched".
  if (session && session.chatId) args.push(`--session-id=${session.chatId}`);
  if (force) args.push('--allow-all-tools');
  return args;
}

function buildPrintCommand(session, opts = {}) {
  return [resolveCopilotBin(), ...buildPrintArgs(session, opts)];
}

function copilotAvailable() {
  return Boolean(which('copilot') || process.env.AGENTFLEET_COPILOT_BIN);
}

module.exports = {
  resolveCopilotBin,
  newSessionId,
  buildPrintArgs,
  buildPrintCommand,
  copilotAvailable,
};
