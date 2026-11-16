'use strict';

/**
 * Shared display-state derivation for live dashboard + memory DASHBOARD.md counts.
 * Registry `status` is unchanged; this is read-only presentation / counting.
 */

const orchestrate = require('./orchestrate');

/**
 * @param {unknown} pid
 * @param {(pid: number) => boolean} [isAlive]
 * @returns {boolean}
 */
function isPidAlive(pid, isAlive) {
  const probe = typeof isAlive === 'function' ? isAlive : orchestrate.defaultIsAlive;
  return probe(pid);
}

/**
 * Derive visual / count state from lifecycle + optional Herdr enrichment + pid liveness.
 * Pure: no I/O.
 *
 * - running — Herdr runtime is `running` or `shell`, or `runPid` is alive
 * - idle — registry `paused`, or `active` but not live (exited/missing/no pid)
 * - done / failed — from registry `done` (+ lastExit / lastError)
 *
 * @param {object|null|undefined} session
 * @param {object|null|undefined} enrichment  Herdr enrichment or session.herdr
 * @param {{ isAlive?: (pid: number) => boolean }} [opts]
 * @returns {'running'|'idle'|'done'|'failed'}
 */
function deriveDisplayState(session, enrichment, opts = {}) {
  const status = session && session.status ? String(session.status) : 'done';
  const lastExit = session && session.lastExit != null ? Number(session.lastExit) : null;
  const lastError =
    session && session.lastError != null && String(session.lastError).trim() !== ''
      ? String(session.lastError).trim()
      : null;

  if (status === 'done') {
    if (lastError) return 'failed';
    if (lastExit != null && Number.isFinite(lastExit) && lastExit !== 0) return 'failed';
    return 'done';
  }

  if (status === 'paused') return 'idle';

  // active
  const runtime = enrichment && enrichment.runtime != null ? enrichment.runtime : null;
  const herdrLive = runtime === 'running' || runtime === 'shell';
  const pidLive = isPidAlive(session && session.runPid, opts.isAlive);
  if (herdrLive || pidLive) return 'running';
  return 'idle';
}

/**
 * Resolve enrichment for a session: explicit map entry, else persisted session.herdr.
 * @param {object} session
 * @param {Record<string, object>|null|undefined} enrichmentById
 * @returns {object|null}
 */
function enrichmentForSession(session, enrichmentById) {
  if (session && session.id && enrichmentById && enrichmentById[session.id]) {
    return enrichmentById[session.id];
  }
  if (session && session.herdr && typeof session.herdr === 'object') {
    return session.herdr;
  }
  return null;
}

module.exports = {
  deriveDisplayState,
  enrichmentForSession,
  isPidAlive,
};
