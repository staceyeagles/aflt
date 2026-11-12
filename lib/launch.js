'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { fleetDir, nowIso } = require('./util');

/** Break a launch lock whose mtime is older than this. */
const LAUNCH_LOCK_STALE_MS = 60000;

function locksDir() {
  return path.join(fleetDir(), 'locks');
}

function launchLockPath(sessionId) {
  const safe = String(sessionId || '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .slice(0, 120);
  return path.join(locksDir(), `launch-${safe || 'unknown'}.lock`);
}

function syncSleep(ms) {
  const sab = new SharedArrayBuffer(4);
  const ia = new Int32Array(sab);
  Atomics.wait(ia, 0, 0, Math.max(1, Math.floor(ms)));
}

function isPidAlive(pid) {
  if (pid == null || !Number.isFinite(Number(pid)) || Number(pid) <= 0) return false;
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Remove a launch lock if mtime is older than staleMs, or if it records a dead
 * pid on this host. Returns true if the file was unlinked.
 */
function tryBreakStaleLaunchLock(lp, staleMs = LAUNCH_LOCK_STALE_MS) {
  let st;
  try {
    st = fs.statSync(lp);
  } catch (_) {
    return false;
  }
  let stale = Date.now() - st.mtimeMs > staleMs;
  if (!stale) {
    try {
      const raw = fs.readFileSync(lp, 'utf8');
      const lines = String(raw).split(/\n/);
      const pid = Number(String(lines[0] || '').trim());
      const host = String(lines[1] || '').trim();
      if (host === os.hostname() && Number.isFinite(pid) && pid > 0 && !isPidAlive(pid)) {
        stale = true;
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (!stale) return false;
  try {
    fs.unlinkSync(lp);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * Try exclusive create of launch-<id>.lock. Returns lock path on success,
 * null if another live holder owns it.
 */
function tryAcquireLaunchLock(sessionId, { staleMs = LAUNCH_LOCK_STALE_MS } = {}) {
  fs.mkdirSync(locksDir(), { recursive: true, mode: 0o700 });
  const lp = launchLockPath(sessionId);
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = fs.openSync(lp, 'wx');
      try {
        fs.writeFileSync(fd, `${process.pid}\n${os.hostname()}\n${nowIso()}\n`);
      } finally {
        fs.closeSync(fd);
      }
      return lp;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      if (tryBreakStaleLaunchLock(lp, staleMs)) continue;
      return null;
    }
  }
  return null;
}

function releaseLaunchLock(sessionIdOrPath) {
  const lp =
    sessionIdOrPath && String(sessionIdOrPath).includes(path.sep)
      ? sessionIdOrPath
      : launchLockPath(sessionIdOrPath);
  try {
    fs.unlinkSync(lp);
  } catch (_) {
    /* ignore */
  }
}

/**
 * Run fn while holding an exclusive per-session launch lock.
 * Throws err.code === 'LAUNCH_BUSY' if another process holds a fresh lock.
 */
function withLaunchLock(sessionId, fn, opts) {
  if (typeof fn !== 'function') throw new Error('withLaunchLock requires a function');
  const lp = tryAcquireLaunchLock(sessionId, opts);
  if (!lp) {
    const err = new Error(`session ${sessionId} is already running/launching`);
    err.code = 'LAUNCH_BUSY';
    throw err;
  }
  try {
    return fn();
  } finally {
    releaseLaunchLock(lp);
  }
}

function discoveryRefuseMessage(error) {
  const detail = error ? String(error) : 'query failed';
  return (
    `herdr discovery failed: ${detail}. ` +
    `Check with: hc server status. Or use --via plain / --here, or --no-herdr / --no-herdr-app.`
  );
}

module.exports = {
  LAUNCH_LOCK_STALE_MS,
  locksDir,
  launchLockPath,
  tryAcquireLaunchLock,
  releaseLaunchLock,
  tryBreakStaleLaunchLock,
  withLaunchLock,
  discoveryRefuseMessage,
  syncSleep,
};
