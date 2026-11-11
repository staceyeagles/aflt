'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { fleetDir, nowIso, escapeShellArg } = require('./util');

function runLogDir(sessionId) {
  return path.join(fleetDir(), 'runs', String(sessionId));
}

function newRunLogPath(sessionId, engine) {
  const dir = runLogDir(sessionId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const safeEngine = String(engine || 'cursor').replace(/[^a-z0-9_-]+/gi, '') || 'run';
  return path.join(dir, `${stamp}.${safeEngine}.txt`);
}

function writeRunLog(file, { argv, cwd, stdout, stderr, code, signal, timedOut }) {
  const parts = [];
  parts.push(`# cwd: ${cwd || ''}`);
  parts.push(`# argv: ${(argv || []).map(escapeShellArg).join(' ')}`);
  parts.push(`# exit: ${code}`);
  parts.push(`# signal: ${signal || ''}`);
  parts.push(`# timedOut: ${timedOut ? 'yes' : 'no'}`);
  parts.push('# --- stdout ---');
  parts.push(stdout || '');
  if (stderr) {
    parts.push('# --- stderr ---');
    parts.push(stderr);
  }
  parts.push('');
  fs.writeFileSync(file, parts.join('\n'), { encoding: 'utf8', mode: 0o600 });
  return file;
}

/**
 * Spawn a CLI, capture stdout/stderr, optionally time out.
 * stdin is ignored so a headless run cannot hang waiting for a TTY prompt.
 */
function spawnCaptured(bin, argv, { cwd, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, {
        cwd: cwd || process.cwd(),
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            try {
              child.kill('SIGTERM');
            } catch (_) {
              /* ignore */
            }
          }, timeoutMs)
        : null;

    child.stdout.on('data', (buf) => {
      stdout += buf.toString('utf8');
    });
    child.stderr.on('data', (buf) => {
      stderr += buf.toString('utf8');
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

function commandString(bin, argv) {
  return [bin, ...argv].map(escapeShellArg).join(' ');
}

module.exports = {
  runLogDir,
  newRunLogPath,
  writeRunLog,
  spawnCaptured,
  commandString,
};
