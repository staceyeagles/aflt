'use strict';

const path = require('path');

const crypto = require('crypto');
const { which } = require('./util');

/**
 * GitHub Copilot CLI (`copilot`), verified on this machine 2026-11-11:
 *   /usr/local/bin/copilot  version 1.0.109
 * Headless: -p/--prompt, --output-format text|json, --silent,
 *   -C <dir>, --session-id=<uuid> (create or resume), --model,
 *   --allow-all-tools (required for non-interactive mode per --help; af only
 *   adds it with --force).
 * Interactive: `copilot` (no -p); -i/--interactive <prompt> starts interactive
 *   and auto-executes that prompt; --session-id=<uuid> create-or-resume
 *   (do not use --resume= for a freshly minted id — it fails);
 *   -C <dir>, --model, --allow-all-tools only when --force.
 * Cursor --trust/--workspace do not apply.
 * `gh copilot` is a preview wrapper around the same CLI; af calls `copilot` directly.
 * This is not `gh` repository tooling (issue/pr/repo) and not `gh agent-task`.
 */
function resolveCopilotBin() {
  if (process.env.AGENTFLEET_COPILOT_BIN) return process.env.AGENTFLEET_COPILOT_BIN;
  return which('copilot') || 'copilot';
}

/**
 * Extra workspace roots for handoff/plan files outside -C.
 * Dedupes --add-dir for result and plan parent dirs.
 */
function extraDirArgs(session) {
  const dirs = [];
  const seen = new Set();
  for (const p of [session && session.result, session && session.plan]) {
    if (!p) continue;
    const dir = path.dirname(path.resolve(String(p)));
    if (seen.has(dir)) continue;
    seen.add(dir);
    dirs.push('--add-dir', dir);
  }
  return dirs;
}

/**
 * Pre-approve writes to the handoff / plan files without --allow-all-tools.
 * Copilot: `--allow-tool=write(/abs/path)` scopes file create/modify only
 * (does not approve shell). Used for workers and masters with result/plan.
 */
function writeAllowArgs(session) {
  const args = [];
  if (session && session.result) {
    args.push(`--allow-tool=write(${path.resolve(String(session.result))})`);
  }
  if (session && session.plan) {
    args.push(`--allow-tool=write(${path.resolve(String(session.plan))})`);
  }
  return args;
}

/** @deprecated use extraDirArgs */
function resultDirArgs(session) {
  return extraDirArgs(session);
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
  args.push(...extraDirArgs(session));
  args.push(...writeAllowArgs(session));
  if (force) args.push('--allow-all-tools');
  return args;
}

function buildPrintCommand(session, opts = {}) {
  return [resolveCopilotBin(), ...buildPrintArgs(session, opts)];
}

/**
 * Interactive argv (without binary).
 * Does NOT fall back to session.prompt — pass opts.prompt only for first
 * launch (`af new --prompt`) or an explicit `--prompt` on that resume.
 */
function buildInteractiveArgs(session, { prompt, force = false } = {}) {
  if (!session || !session.chatId) {
    throw new Error('chatId (copilot session id) is required for interactive launch');
  }
  const args = [`--session-id=${session.chatId}`];
  const cwd = session.cwd;
  if (cwd) args.push('-C', cwd);
  if (session.model) args.push('--model', session.model);
  args.push(...extraDirArgs(session));
  args.push(...writeAllowArgs(session));
  if (typeof prompt === 'string' && prompt) args.push('-i', prompt);
  if (force) args.push('--allow-all-tools');
  return args;
}

function buildInteractiveCommand(session, opts = {}) {
  return [resolveCopilotBin(), ...buildInteractiveArgs(session, opts)];
}

function copilotAvailable() {
  return Boolean(which('copilot') || process.env.AGENTFLEET_COPILOT_BIN);
}

module.exports = {
  resolveCopilotBin,
  newSessionId,
  extraDirArgs,
  writeAllowArgs,
  resultDirArgs,
  buildPrintArgs,
  buildPrintCommand,
  buildInteractiveArgs,
  buildInteractiveCommand,
  copilotAvailable,
};
