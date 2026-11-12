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

/**
 * Header + stdout marker. Exit/signal/timedOut and stderr are appended later
 * so `af tail -f` can follow stdout while the engine is still running.
 */
function writeRunLogHeader(file, { argv, cwd }) {
  const parts = [];
  parts.push(`# cwd: ${cwd || ''}`);
  parts.push(`# argv: ${(argv || []).map(escapeShellArg).join(' ')}`);
  parts.push('# --- stdout ---');
  parts.push('');
  fs.writeFileSync(file, parts.join('\n'), { encoding: 'utf8', mode: 0o600 });
  return file;
}

function appendRunLog(file, chunk) {
  if (chunk == null || chunk === '') return;
  fs.appendFileSync(file, String(chunk), { encoding: 'utf8' });
}

/**
 * Append stderr (if any) and exit footer after the live stdout section.
 */
function writeRunLogFooter(file, { stderr, code, signal, timedOut }) {
  const parts = [];
  if (stderr) {
    parts.push('# --- stderr ---');
    parts.push(stderr.endsWith('\n') ? stderr.slice(0, -1) : stderr);
  }
  parts.push(`# exit: ${code}`);
  parts.push(`# signal: ${signal || ''}`);
  parts.push(`# timedOut: ${timedOut ? 'yes' : 'no'}`);
  parts.push('');
  fs.appendFileSync(file, parts.join('\n'), { encoding: 'utf8' });
  return file;
}

/**
 * Write a complete run log in one shot (same layout as streaming: header,
 * stdout, optional stderr, exit footer). Used by callers that already have
 * the full capture.
 */
function writeRunLog(file, { argv, cwd, stdout, stderr, code, signal, timedOut }) {
  writeRunLogHeader(file, { argv, cwd });
  if (stdout) {
    const body = stdout.endsWith('\n') ? stdout : stdout + '\n';
    appendRunLog(file, body);
  }
  writeRunLogFooter(file, { stderr, code, signal, timedOut });
  return file;
}

function signalExitCode(sig) {
  if (sig === 'SIGINT') return 130;
  if (sig === 'SIGTERM') return 143;
  if (sig === 'SIGHUP') return 129;
  return 1;
}

function killProcessGroup(pgid, signal) {
  if (pgid == null) return false;
  try {
    process.kill(-Number(pgid), signal);
    return true;
  } catch (_) {
    return false;
  }
}

function isPidAlive(pid) {
  if (pid == null || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Spawn a CLI, capture stdout/stderr, optionally time out.
 * stdin is ignored so a headless run cannot hang waiting for a TTY prompt.
 * Optional `env` replaces process.env entirely when provided; use
 * `{ ...process.env, KEY: val }` for overlays.
 *
 * When `detached` is true the child is placed in its own process group
 * (still awaited; do not unref) so `af stop` can signal the whole group.
 * `onSpawn({ pid, pgid, child })` fires once the child has a pid.
 * Optional `logPath` streams stdout into the run log as data arrives
 * (header must already be written, or pass `logHeader: true`).
 *
 * When `forwardSignals` is true (default for detached), SIGINT/SIGTERM/SIGHUP
 * on this process are forwarded as SIGTERM to the child's process group so
 * interrupting af does not orphan the engine. Resolves with `interruptedBy`.
 */
function spawnCaptured(bin, argv, opts = {}) {
  const {
    cwd,
    timeoutMs,
    env,
    detached = false,
    onSpawn = null,
    logPath = null,
    logHeader = false,
    onStdout = null,
    onStderr = null,
    forwardSignals = Boolean(opts.detached),
    signalKillAfterMs = 2000,
  } = opts;

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, argv, {
        cwd: cwd || process.cwd(),
        env: env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: Boolean(detached),
      });
    } catch (err) {
      reject(err);
      return;
    }

    const pid = child.pid != null ? child.pid : null;
    // Detached child is the process-group leader on Unix; pgid === pid.
    const pgid = detached && pid != null ? pid : null;
    if (typeof onSpawn === 'function') {
      try {
        onSpawn({ pid, pgid, child });
      } catch (_) {
        /* ignore callback errors */
      }
    }

    if (logPath && logHeader) {
      writeRunLogHeader(logPath, { argv: [bin, ...argv], cwd: cwd || process.cwd() });
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    let interruptedBy = null;
    let killTimer = null;
    const signalHandlers = {};

    function cleanupSignals() {
      for (const [sig, fn] of Object.entries(signalHandlers)) {
        try {
          process.removeListener(sig, fn);
        } catch (_) {
          /* ignore */
        }
      }
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    }

    function terminateChild(sigName) {
      try {
        if (detached && pgid != null) {
          killProcessGroup(pgid, 'SIGTERM');
        } else {
          child.kill('SIGTERM');
        }
      } catch (_) {
        try {
          child.kill('SIGTERM');
        } catch (__) {
          /* ignore */
        }
      }
      if (signalKillAfterMs > 0 && pid != null) {
        killTimer = setTimeout(() => {
          if (!isPidAlive(pid)) return;
          try {
            if (detached && pgid != null) killProcessGroup(pgid, 'SIGKILL');
            else child.kill('SIGKILL');
          } catch (_) {
            try {
              process.kill(pid, 'SIGKILL');
            } catch (__) {
              /* ignore */
            }
          }
        }, signalKillAfterMs);
        if (typeof killTimer.unref === 'function') killTimer.unref();
      }
    }

    function onParentSignal(sig) {
      if (interruptedBy || settled) return;
      interruptedBy = sig;
      terminateChild(sig);
    }

    if (forwardSignals) {
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
        const fn = () => onParentSignal(sig);
        signalHandlers[sig] = fn;
        try {
          process.on(sig, fn);
        } catch (_) {
          /* Windows may not support all signals */
        }
      }
    }

    const timer =
      timeoutMs && timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminateChild('SIGTERM');
          }, timeoutMs)
        : null;

    child.stdout.on('data', (buf) => {
      const text = buf.toString('utf8');
      stdout += text;
      if (logPath) appendRunLog(logPath, text);
      if (typeof onStdout === 'function') {
        try {
          onStdout(text);
        } catch (_) {
          /* ignore */
        }
      }
    });
    child.stderr.on('data', (buf) => {
      const text = buf.toString('utf8');
      stderr += text;
      if (typeof onStderr === 'function') {
        try {
          onStderr(text);
        } catch (_) {
          /* ignore */
        }
      }
    });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanupSignals();
      reject(err);
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      cleanupSignals();
      if (logPath) {
        writeRunLogFooter(logPath, {
          stderr,
          code: interruptedBy ? signalExitCode(interruptedBy) : code,
          signal: interruptedBy || signal,
          timedOut,
        });
      }
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        pid,
        pgid,
        interruptedBy,
      });
    });
  });
}

function commandString(bin, argv) {
  return [bin, ...argv].map(escapeShellArg).join(' ');
}

/**
 * Tail-capped excerpt of engine/run output for --json payloads.
 * Caps at max chars (default 2000), preferring the end of the text.
 */
function outputExcerpt(text, max = 2000) {
  const s = String(text == null ? '' : text);
  const n = Math.max(0, Number(max) || 2000);
  if (s.length <= n) return s;
  return s.slice(s.length - n);
}

module.exports = {
  runLogDir,
  newRunLogPath,
  writeRunLogHeader,
  appendRunLog,
  writeRunLogFooter,
  writeRunLog,
  spawnCaptured,
  commandString,
  outputExcerpt,
  signalExitCode,
  killProcessGroup,
  isPidAlive,
};
