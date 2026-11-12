'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { homeDir, which, escapeShellArg } = require('./util');

/**
 * Prefer `cursor-agent`, fall back to `agent` (both are official install names).
 * Override with AGENTFLEET_CURSOR_BIN.
 */
function resolveCursorBin() {
  if (process.env.AGENTFLEET_CURSOR_BIN) return process.env.AGENTFLEET_CURSOR_BIN;
  return which('cursor-agent') || which('agent') || 'cursor-agent';
}

/**
 * Create an empty chat and return its UUID.
 * Verified: `cursor-agent create-chat` prints a UUID on stdout.
 * Note: on some installs the process may linger after printing the ID;
 * we take the first non-empty line and then kill the child.
 */
function createChat({ timeoutMs = 25000 } = {}) {
  const bin = resolveCursorBin();
  return new Promise((resolve, reject) => {
    const child = spawn(bin, ['create-chat'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      child.kill('SIGTERM');
      const id = firstLine(stdout);
      if (id) {
        settled = true;
        resolve(id);
      } else {
        settled = true;
        reject(
          new Error(
            `create-chat timed out after ${timeoutMs}ms with no ID. stderr: ${stderr.trim()}`
          )
        );
      }
    }, timeoutMs);

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
      const id = firstLine(stdout);
      if (id && !settled) {
        settled = true;
        clearTimeout(timer);
        try {
          child.kill('SIGTERM');
        } catch (_) {
          /* ignore */
        }
        resolve(id);
      }
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const id = firstLine(stdout);
      if (id) resolve(id);
      else
        reject(
          new Error(
            `create-chat exited ${code} without an ID. stderr: ${stderr.trim() || '(empty)'}`
          )
        );
    });
  });
}

function firstLine(s) {
  const line = String(s)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  // UUID or opaque chat id
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(line)) {
    return line;
  }
  // Accept other non-empty tokens that look like ids
  if (/^[A-Za-z0-9._:-]{8,}$/.test(line)) return line;
  return null;
}

/**
 * Build the argv for launching/resuming cursor-agent interactively.
 * Verified flags from cursor.com/docs/cli/reference/parameters:
 *   --resume [chatId], --model, --workspace, prompt args
 *
 * Does NOT fall back to session.prompt. Resume restores chat context via
 * --resume <chatId> only; appending the saved original task prompt would
 * inject a new user turn and can re-trigger the original work. Pass a
 * non-empty opts.prompt only for first launch (`af new --prompt`) or an
 * explicit `--prompt` on that resume invocation.
 */
function buildResumeArgs(session, { prompt, trust = true } = {}) {
  const args = ['--resume', session.chatId];
  if (session.model) args.push('--model', session.model);
  if (session.cwd) args.push('--workspace', session.cwd);
  if (session.result) args.push('--add-dir', path.dirname(String(session.result)));
  // Default --trust so a registered workspace does not stall on the
  // "Workspace Trust Required" dialog (seen on Mini 2026-11-10 during
  // `af resume --via herdr`). Pass trust: false / --no-trust to keep the prompt.
  if (trust) args.push('--trust');
  // Only append when the caller explicitly provides a non-empty prompt.
  if (typeof prompt === 'string' && prompt) args.push(prompt);
  return args;
}

function buildResumeCommand(session, opts = {}) {
  const bin = resolveCursorBin();
  const args = buildResumeArgs(session, opts);
  return [bin, ...args];
}

function buildResumeCommandString(session, opts = {}) {
  return buildResumeCommand(session, opts).map(escapeShellArg).join(' ');
}

/**
 * Headless print-mode argv. Flags verified against cursor-agent --help
 * (2026.11.05-86047df on Mini, 2026-11-10):
 *   -p/--print, --output-format text|json|stream-json,
 *   --resume [chatId], --model, --workspace, --mode plan|ask, --force/--yolo, --trust.
 * Prompt is a trailing positional argument.
 * --trust is included unless trust === false, so a workspace trust prompt
 * cannot hang a non-interactive controller run.
 */
function buildPrintArgs(session, { prompt, mode, force = false, outputFormat = 'text', trust = true } = {}) {
  if (!prompt) throw new Error('prompt is required for a headless cursor run');
  const fmt = outputFormat || 'text';
  if (fmt !== 'text' && fmt !== 'json' && fmt !== 'stream-json') {
    throw new Error(`unsupported --output-format: ${fmt}`);
  }
  if (mode && mode !== 'ask' && mode !== 'plan') {
    throw new Error(`unsupported --mode: ${mode} (want ask or plan)`);
  }
  const args = ['-p', '--output-format', fmt];
  if (session && session.chatId) args.push('--resume', session.chatId);
  if (session && session.model) args.push('--model', session.model);
  if (session && session.cwd) args.push('--workspace', session.cwd);
  // Worker handoff lives outside the workspace ($AGENTFLEET_HOME/results).
  if (session && session.result) args.push('--add-dir', path.dirname(String(session.result)));
  if (mode) args.push('--mode', mode);
  if (force) args.push('--force');
  if (trust) args.push('--trust');
  args.push(String(prompt));
  return args;
}

function buildPrintCommand(session, opts = {}) {
  return [resolveCursorBin(), ...buildPrintArgs(session, opts)];
}

function buildPrintCommandString(session, opts = {}) {
  return buildPrintCommand(session, opts).map(escapeShellArg).join(' ');
}

/**
 * Scan local CLI chat store.
 * Community/docs research: ~/.cursor/chats/<md5(workspacePath)>/<chatId>/{meta.json,store.db}
 * Marked: path layout observed by third parties; create-chat alone may not write
 * files until a prompt is sent. We still try to read what exists.
 */
function listLocalChats({ limit = 50 } = {}) {
  const root = path.join(homeDir(), '.cursor', 'chats');
  if (!fs.existsSync(root)) return [];
  const out = [];
  let hashes;
  try {
    hashes = fs.readdirSync(root);
  } catch (_) {
    return [];
  }
  for (const hash of hashes) {
    const hashDir = path.join(root, hash);
    let chatIds;
    try {
      if (!fs.statSync(hashDir).isDirectory()) continue;
      chatIds = fs.readdirSync(hashDir);
    } catch (_) {
      continue;
    }
    for (const chatId of chatIds) {
      const chatDir = path.join(hashDir, chatId);
      const metaPath = path.join(chatDir, 'meta.json');
      let meta = {};
      let mtime = 0;
      try {
        const st = fs.statSync(chatDir);
        mtime = st.mtimeMs;
        if (fs.existsSync(metaPath)) {
          meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        }
      } catch (_) {
        continue;
      }
      out.push({
        chatId,
        cwd: meta.cwd || meta.workspacePath || null,
        workspaceHash: hash,
        meta,
        mtime,
        path: chatDir,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, limit);
}

/**
 * md5 of workspace path — used by Cursor CLI for ~/.cursor/chats/<hash>/.
 * UNVERIFIED on this box (no chats/ written after create-chat alone);
 * matches community reports.
 */
function workspaceHash(cwd) {
  return crypto.createHash('md5').update(path.resolve(cwd)).digest('hex');
}

/**
 * `cursor-agent ls` is interactive and ignores --print/--output-format json
 * (confirmed: forum.cursor.com + local --help shows no flags). So we cannot
 * reliably scrape it; import uses the local store instead.
 */
function lsIsInteractiveOnly() {
  return true;
}

function spawnCursorInteractive(argv, { cwd } = {}) {
  const bin = resolveCursorBin();
  const child = spawn(bin, argv, {
    cwd: cwd || process.cwd(),
    stdio: 'inherit',
    env: process.env,
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

function cursorAvailable() {
  return Boolean(which('cursor-agent') || which('agent') || process.env.AGENTFLEET_CURSOR_BIN);
}

module.exports = {
  resolveCursorBin,
  createChat,
  buildResumeArgs,
  buildResumeCommand,
  buildResumeCommandString,
  buildPrintArgs,
  buildPrintCommand,
  buildPrintCommandString,
  listLocalChats,
  workspaceHash,
  lsIsInteractiveOnly,
  spawnCursorInteractive,
  cursorAvailable,
  firstLine,
};
