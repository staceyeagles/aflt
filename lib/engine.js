'use strict';

const { spawn } = require('child_process');
const cursor = require('./cursor');
const copilot = require('./copilot');
const opencode = require('./opencode');
const config = require('./config');
const { escapeShellArg } = require('./util');

/**
 * Resolve engine for NEW sessions.
 * Precedence: explicit flag > AGENTFLEET_ENGINE env > config default > 'cursor'.
 * Existing sessions always keep their recorded engine (callers must not use this
 * to override a registry row).
 */
function resolveEngine({ flag, env = process.env } = {}) {
  if (flag != null && flag !== '' && flag !== true) {
    const engine = config.validateEngine(flag);
    return { engine, source: 'flag' };
  }
  const fromEnv = env.AGENTFLEET_ENGINE;
  if (fromEnv != null && String(fromEnv).trim() !== '') {
    const engine = config.validateEngine(fromEnv);
    return { engine, source: 'env' };
  }
  const fromConfig = config.getDefaultEngineFromConfig();
  if (fromConfig) {
    return { engine: fromConfig, source: 'config' };
  }
  return { engine: 'cursor', source: 'builtin' };
}

function sessionEngine(session) {
  return (session && session.engine) || 'cursor';
}

/**
 * Interactive argv (without binary) for the session's engine.
 * Copilot: --session-id=, -C, --model, optional -i prompt, --allow-all-tools if force.
 * OpenCode: --session, --model, optional --prompt (force currently ignored).
 * Cursor: --resume … (existing); force is ignored so cursor behavior stays unchanged.
 */
function buildInteractiveArgs(session, opts = {}) {
  const engine = sessionEngine(session);
  if (engine === 'copilot') {
    return copilot.buildInteractiveArgs(session, opts);
  }
  if (engine === 'opencode') {
    return opencode.buildInteractiveArgs(session, opts);
  }
  if (engine !== 'cursor') {
    throw new Error(`unsupported engine: ${engine}`);
  }
  const { prompt, trust } = opts;
  return cursor.buildResumeArgs(session, { prompt, trust });
}

function buildInteractiveCommand(session, opts = {}) {
  const engine = sessionEngine(session);
  if (engine === 'copilot') {
    return copilot.buildInteractiveCommand(session, opts);
  }
  if (engine === 'opencode') {
    return opencode.buildInteractiveCommand(session, opts);
  }
  if (engine !== 'cursor') {
    throw new Error(`unsupported engine: ${engine}`);
  }
  const { prompt, trust } = opts;
  return cursor.buildResumeCommand(session, { prompt, trust });
}

function buildInteractiveCommandString(session, opts = {}) {
  return buildInteractiveCommand(session, opts).map(escapeShellArg).join(' ');
}

function engineAvailable(engine) {
  const e = engine || 'cursor';
  if (e === 'copilot') return copilot.copilotAvailable();
  if (e === 'opencode') return opencode.opencodeAvailable();
  if (e === 'cursor') return cursor.cursorAvailable();
  return false;
}

/**
 * Clear error when the session's engine binary is missing (like hc-missing notes).
 */
function missingEngineMessage(engine) {
  const e = engine || 'cursor';
  if (e === 'copilot') {
    return (
      'copilot not found on PATH; install with `npm install -g @github/copilot` ' +
      'or set AGENTFLEET_COPILOT_BIN'
    );
  }
  if (e === 'opencode') {
    return (
      'opencode not found on PATH; install from https://opencode.ai ' +
      '(curl -fsSL https://opencode.ai/v2/install | bash) or set AGENTFLEET_OPENCODE_BIN'
    );
  }
  return (
    'cursor-agent/agent not found on PATH; install Cursor CLI or set AGENTFLEET_CURSOR_BIN'
  );
}

function assertEngineAvailable(session) {
  const engine = sessionEngine(session);
  if (!engineAvailable(engine)) {
    const err = new Error(missingEngineMessage(engine));
    err.code = 'ENGINE_MISSING';
    throw err;
  }
}

function spawnInteractive(argv, { cwd, env } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return Promise.reject(new Error('interactive argv is required'));
  }
  const bin = argv[0];
  const args = argv.slice(1);
  const child = spawn(bin, args, {
    cwd: cwd || process.cwd(),
    stdio: 'inherit',
    env: env || process.env,
  });
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      resolve({ code, signal });
    });
  });
}

module.exports = {
  resolveEngine,
  sessionEngine,
  buildInteractiveArgs,
  buildInteractiveCommand,
  buildInteractiveCommandString,
  engineAvailable,
  missingEngineMessage,
  assertEngineAvailable,
  spawnInteractive,
};
