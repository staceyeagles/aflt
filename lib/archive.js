'use strict';

/**
 * Archive / unarchive sessions (registry flag only). Shared by CLI and dashboard.
 * Does not touch run logs, results, or plans.
 */

const os = require('os');
const registry = require('./registry');
const orchestrate = require('./orchestrate');
const { nowIso } = require('./util');

/**
 * True when the session should refuse archive/delete without --force:
 * live headless runPid, or Herdr OSC status working / blocked (waiting).
 * Idle live panes do not block.
 *
 * @param {object} session
 * @param {{ enrichment?: object|null, isAlive?: (pid:number)=>boolean, hostname?: string }} [opts]
 * @returns {{ busy: boolean, via: string|null, reason: string|null }}
 */
function sessionBusyForMutation(session, opts = {}) {
  if (!session) return { busy: false, via: null, reason: null };
  const isAlive = typeof opts.isAlive === 'function' ? opts.isAlive : orchestrate.defaultIsAlive;
  const hostname = opts.hostname != null ? String(opts.hostname) : os.hostname();

  if (
    session.runPid != null &&
    (!session.runHost || session.runHost === hostname) &&
    isAlive(session.runPid)
  ) {
    return { busy: true, via: 'headless', reason: 'running' };
  }

  const enrichment = opts.enrichment || null;
  let status =
    enrichment && enrichment.status != null
      ? String(enrichment.status)
      : session.herdr && session.herdr.status != null
        ? String(session.herdr.status)
        : null;
  if (status === 'working') {
    return { busy: true, via: 'herdr', reason: 'running' };
  }
  if (status === 'blocked') {
    return { busy: true, via: 'herdr', reason: 'waiting' };
  }

  // Enrichment may nest status under the raw terminal; also accept activity-like fields.
  const runtime = enrichment && enrichment.runtime != null ? String(enrichment.runtime) : null;
  if (runtime === 'running' && session.workerStatus === 'waiting') {
    return { busy: true, via: 'herdr', reason: 'waiting' };
  }

  return { busy: false, via: null, reason: null };
}

function isArchived(session) {
  return Boolean(session && session.archived);
}

/**
 * Direct children of a parent id (includes archived).
 * @param {string} parentId
 * @param {object[]} [sessions]
 */
function listDirectChildren(parentId, sessions) {
  const all =
    sessions != null ? sessions : registry.list({ includeDone: true, includeArchived: true });
  return all
    .filter((s) => s && s.parent === parentId)
    .sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
}

/**
 * Session plus recursive descendants (depth-first, parent before children).
 * @param {object} root
 * @param {object[]} [sessions]
 */
function collectWithDescendants(root, sessions) {
  const all =
    sessions != null ? sessions : registry.list({ includeDone: true, includeArchived: true });
  const byParent = new Map();
  for (const s of all) {
    if (!s || !s.parent) continue;
    if (!byParent.has(s.parent)) byParent.set(s.parent, []);
    byParent.get(s.parent).push(s);
  }
  const out = [];
  const seen = new Set();
  function walk(s) {
    if (!s || seen.has(s.id)) return;
    seen.add(s.id);
    out.push(s);
    const kids = (byParent.get(s.id) || []).slice().sort((a, b) =>
      String(a.title || '').localeCompare(String(b.title || ''))
    );
    for (const k of kids) walk(k);
  }
  walk(root);
  return out;
}

/**
 * @param {object} session
 * @param {{ withChildren?: boolean, force?: boolean, enrichmentById?: object, isAlive?: Function, hostname?: string, dryRun?: boolean, now?: string }} [opts]
 * @returns {{ ok: boolean, sessions: object[], skipped: object[], error?: string }}
 */
function archiveSessions(session, opts = {}) {
  if (!session) return { ok: false, sessions: [], skipped: [], error: 'session required' };
  const targets = opts.withChildren
    ? collectWithDescendants(session)
    : [session];
  return applyArchiveFlag(targets, true, opts);
}

/**
 * @param {object} session
 * @param {{ withChildren?: boolean, dryRun?: boolean, now?: string }} [opts]
 */
function unarchiveSessions(session, opts = {}) {
  if (!session) return { ok: false, sessions: [], skipped: [], error: 'session required' };
  const targets = opts.withChildren
    ? collectWithDescendants(session).filter((s) => isArchived(s) || s.id === session.id)
    : [session];
  return applyArchiveFlag(targets, false, { ...opts, force: true });
}

/**
 * Archive idle/done (non-busy) sessions under a project. Skips running/waiting/failed
 * and already-archived. Does not archive the project itself (projects are not sessions).
 *
 * @param {string} projectName
 * @param {{ sessions?: object[], enrichmentById?: object, force?: boolean, dryRun?: boolean, filterStateOf?: (s:object)=>string, now?: string }} [opts]
 */
function archiveIdleDoneInProject(projectName, opts = {}) {
  const name = String(projectName || '').trim();
  if (!name) return { ok: false, sessions: [], skipped: [], error: 'project required' };
  const all =
    opts.sessions != null
      ? opts.sessions
      : registry.list({ includeDone: true, includeArchived: true });
  const members = all.filter((s) => {
    if (!s || isArchived(s)) return false;
    const p = s.project != null && String(s.project).trim() !== '' ? String(s.project).trim() : null;
    return p === name;
  });
  const toArchive = [];
  const skipped = [];
  for (const s of members) {
    const enrichment =
      opts.enrichmentById && opts.enrichmentById[s.id] ? opts.enrichmentById[s.id] : null;
    const busy = sessionBusyForMutation(s, {
      enrichment,
      isAlive: opts.isAlive,
      hostname: opts.hostname,
    });
    if (busy.busy && !opts.force) {
      skipped.push({ id: s.id, title: s.title, reason: busy.reason || 'busy' });
      continue;
    }
    let filterState = null;
    if (typeof opts.filterStateOf === 'function') {
      filterState = opts.filterStateOf(s);
    } else {
      filterState = s.displayState || s.activityState || s.status || 'idle';
      if (s.awaitingInput) filterState = 'waiting';
    }
    if (filterState === 'running' || filterState === 'waiting' || filterState === 'failed') {
      skipped.push({ id: s.id, title: s.title, reason: filterState });
      continue;
    }
    // idle / done (and anything else quiet)
    toArchive.push(s);
  }
  if (toArchive.length === 0) {
    return { ok: true, sessions: [], skipped };
  }
  return applyArchiveFlag(toArchive, true, { ...opts, force: Boolean(opts.force) });
}

function applyArchiveFlag(targets, archived, opts = {}) {
  const skipped = [];
  const eligible = [];
  for (const s of targets) {
    if (!s) continue;
    if (archived && isArchived(s)) {
      skipped.push({ id: s.id, title: s.title, reason: 'already-archived' });
      continue;
    }
    if (!archived && !isArchived(s)) {
      skipped.push({ id: s.id, title: s.title, reason: 'not-archived' });
      continue;
    }
    if (archived && !opts.force) {
      const enrichment =
        opts.enrichmentById && opts.enrichmentById[s.id] ? opts.enrichmentById[s.id] : null;
      const busy = sessionBusyForMutation(s, {
        enrichment,
        isAlive: opts.isAlive,
        hostname: opts.hostname,
      });
      if (busy.busy) {
        skipped.push({
          id: s.id,
          title: s.title,
          reason: busy.reason || 'busy',
          via: busy.via,
        });
        continue;
      }
    }
    eligible.push(s);
  }

  if (opts.dryRun) {
    return { ok: true, sessions: eligible.map((s) => ({ ...s })), skipped, dryRun: true };
  }

  if (eligible.length === 0) {
    const blocked = skipped.filter((x) => x.reason === 'running' || x.reason === 'waiting');
    if (blocked.length) {
      const first = blocked[0];
      return {
        ok: false,
        sessions: [],
        skipped,
        error: `"${first.title}" appears to be ${first.reason}${first.via ? ` (${first.via})` : ''}`,
      };
    }
    return { ok: true, sessions: [], skipped };
  }

  const stamp = opts.now != null ? String(opts.now) : nowIso();
  const updated = [];
  // Single lock via sequential updates (each update locks); prefer one withLock batch.
  registry.withLock(() => {
    const data = registry.load();
    for (const s of eligible) {
      const idx = data.sessions.findIndex((row) => row.id === s.id);
      if (idx < 0) continue;
      const next = { ...data.sessions[idx] };
      if (archived) {
        next.archived = true;
        next.archivedAt = stamp;
      } else {
        next.archived = false;
        next.archivedAt = null;
      }
      data.sessions[idx] = next;
      updated.push(next);
    }
    registry.save(data);
  });
  return { ok: true, sessions: updated, skipped };
}

/**
 * Remove a session from the registry (and optional owned files). Always keeps runs/<id>/.
 * Clears parent links on remaining children.
 *
 * @param {object} session
 * @param {{ keepFiles?: boolean, force?: boolean, enrichment?: object, isAlive?: Function, hostname?: string, dryRun?: boolean, home?: string }} [opts]
 */
function removeSession(session, opts = {}) {
  if (!session) return { ok: false, error: 'session required' };
  if (!opts.force) {
    const busy = sessionBusyForMutation(session, {
      enrichment: opts.enrichment,
      isAlive: opts.isAlive,
      hostname: opts.hostname,
    });
    if (busy.busy) {
      return {
        ok: false,
        error: `"${session.title}" appears to be ${busy.reason} (${busy.via}). Stop it first or pass --force.`,
        busy,
      };
    }
  }

  const home = opts.home;
  const owned = opts.keepFiles
    ? { files: [], dirs: [], skipped: [] }
    : orchestrate.sessionOwnedPaths(session, { home });

  if (opts.dryRun) {
    return { ok: true, dryRun: true, session, owned };
  }

  const fs = require('fs');
  for (const f of owned.files || []) {
    try {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch (_) {
      /* reported by caller if needed */
    }
  }
  for (const d of owned.dirs || []) {
    try {
      if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
  }
  const removed = registry.remove(session.id);
  return { ok: true, session: removed, owned };
}

module.exports = {
  sessionBusyForMutation,
  isArchived,
  listDirectChildren,
  collectWithDescendants,
  archiveSessions,
  unarchiveSessions,
  archiveIdleDoneInProject,
  removeSession,
};
