'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { which, homeDir, expandUserPath } = require('./util');

const OFF_VALUES = new Set(['0', 'false', 'off', 'no']);

/** Strip trailing slash/sep except for filesystem root. */
function stripTrailingSep(p) {
  let s = String(p);
  if (s.length > 1 && (s.endsWith('/') || s.endsWith('\\'))) {
    s = s.replace(/[/\\]+$/, '');
  }
  return s;
}

/**
 * Normalize cwd for legacy space id: realpath when the path exists, else resolve;
 * trailing slash stripped.
 */
function normalizeCwd(cwd) {
  const raw =
    cwd == null || cwd === '' ? process.cwd() : expandUserPath(String(cwd));
  let resolved;
  try {
    if (fs.existsSync(raw)) {
      resolved = fs.realpathSync(path.resolve(raw));
    } else {
      resolved = path.resolve(raw);
    }
  } catch (_) {
    resolved = path.resolve(raw);
  }
  return stripTrailingSep(resolved);
}

/**
 * Realpath-normalize a session folder that must already exist as a directory.
 * Expands ~, resolves against the caller's cwd, then realpath.
 * Used for Herdr `--cwd`, engine `-C`/`--workspace`.
 * @throws {Error} when missing or not a directory
 */
function requireSessionCwd(cwd) {
  if (cwd == null || String(cwd).trim() === '') {
    throw new Error('session folder is missing');
  }
  const raw = path.resolve(expandUserPath(String(cwd)));
  let st;
  try {
    st = fs.statSync(raw);
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      throw new Error(`session folder does not exist: ${raw}`);
    }
    throw new Error(`session folder not accessible: ${raw} (${err && err.message ? err.message : err})`);
  }
  if (!st.isDirectory()) {
    throw new Error(`session folder is not a directory: ${raw}`);
  }
  return normalizeCwd(raw);
}

function md5hex(s) {
  return crypto.createHash('md5').update(String(s)).digest('hex');
}

/**
 * Group key for a Herdr space: top-level session id, or parent id for workers.
 */
function spaceGroupKey(session) {
  if (session && session.parent != null && String(session.parent) !== '') {
    return String(session.parent);
  }
  if (session && session.id != null && String(session.id) !== '') {
    return String(session.id);
  }
  if (session && session.title != null && String(session.title) !== '') {
    return String(session.title);
  }
  return '';
}

/**
 * Session-group Herdr space id: sp + md5('agentfleet:space:session:' + groupKey).
 * Workers join their master's space; solo sessions get their own.
 */
function herdrSpaceId(session) {
  return 'sp' + md5hex('agentfleet:space:session:' + spaceGroupKey(session));
}

/**
 * Legacy cwd-based space id (pre session-group scheme). Kept for adopt/status
 * detection of terminals that still need relabeling.
 */
function legacyHerdrSpaceId(cwd) {
  return 'sp' + md5hex('agentfleet:space:' + normalizeCwd(cwd));
}

/**
 * Title used for herdr-app space.rename: master's title for workers, else own title.
 * @param {object} session
 * @param {{ sessions?: object[] }} [opts] pool for parent title lookup
 */
function resolveSpaceTitle(session, opts = {}) {
  if (session && session.parent != null && String(session.parent) !== '') {
    if (session.parentTitle) return String(session.parentTitle);
    const pool = opts.sessions || [];
    const parent = pool.find((s) => s && s.id === session.parent);
    if (parent && parent.title) return String(parent.title);
  }
  if (session && session.title != null && String(session.title) !== '') {
    return String(session.title);
  }
  return 'agent';
}

/**
 * Stable Herdr-app tab id for an af session: tb + 32 lowercase hex.
 * Prefers session.id; falls back to title.
 */
function herdrTabId(session) {
  const key =
    session && session.id != null && String(session.id) !== ''
      ? String(session.id)
      : session && session.title != null
        ? String(session.title)
        : '';
  return 'tb' + md5hex('agentfleet:tab:' + key);
}

/** Labels that make a core terminal appear in the Herdr desktop app. */
function herdrAppLabels(session) {
  return [
    `herdr.space=${herdrSpaceId(session)}`,
    `herdr.tab=${herdrTabId(session)}`,
  ];
}

/**
 * Describe expected vs live herdr.space/tab labels for status / ls --json.
 * @returns {{ space, tab, spaceTitle, ok, legacy, needsAdopt }}
 */
function herdrAppStatus(session, terminal, opts = {}) {
  const space = herdrSpaceId(session);
  const tab = herdrTabId(session);
  const spaceTitle = resolveSpaceTitle(session, opts);
  const labels = (terminal && terminal.labels) || {};
  const liveSpace = labels['herdr.space'] || null;
  const liveTab = labels['herdr.tab'] || null;
  const ok = liveSpace === space && liveTab === tab;
  const legacySpace = session && session.cwd != null ? legacyHerdrSpaceId(session.cwd) : null;
  const legacy =
    !ok &&
    Boolean(liveSpace) &&
    liveSpace === legacySpace &&
    (liveTab == null || liveTab === tab);
  const needsAdopt = Boolean(liveSpace || liveTab) && !ok;
  return {
    space,
    tab,
    spaceTitle,
    ok,
    legacy: Boolean(legacy),
    needsAdopt,
    liveSpace,
    liveTab,
  };
}

/**
 * Herdr-app labeling is on by default.
 * Disabled by --no-herdr-app, or AGENTFLEET_HERDR_APP=0|false|off|no.
 */
function herdrAppEnabled(flags = {}, env = process.env) {
  if (flags && (flags['no-herdr-app'] || flags.noHerdrApp)) return false;
  if (flags && flags.herdrApp === false) return false;
  const v = env && env.AGENTFLEET_HERDR_APP;
  if (v != null && String(v) !== '') {
    if (OFF_VALUES.has(String(v).toLowerCase().trim())) return false;
  }
  return true;
}

/**
 * Best-effort space/tab renames are on by default.
 * Disabled by AGENTFLEET_HERDR_NAMES=0|false|off|no (labels still applied).
 */
function herdrNamesEnabled(env = process.env) {
  const v = env && env.AGENTFLEET_HERDR_NAMES;
  if (v != null && String(v) !== '') {
    if (OFF_VALUES.has(String(v).toLowerCase().trim())) return false;
  }
  return true;
}

function resolveHerdrAppBin(env = process.env) {
  if (env && env.AGENTFLEET_HERDR_APP_BIN) return env.AGENTFLEET_HERDR_APP_BIN;
  const found = which('herdr-app');
  if (found) return found;
  // Never fall through to ~/.local/bin under hermetic tests (or when BIN is set above).
  if (env && env.AGENTFLEET_TEST_HERMETIC === '1') return 'herdr-app';
  const fallback = path.join(homeDir(), '.local', 'bin', 'herdr-app');
  try {
    if (fs.existsSync(fallback)) return fallback;
  } catch (_) {
    /* ignore */
  }
  return 'herdr-app';
}

/**
 * Poll/rename wait budget. AGENTFLEET_HERDR_APP_WAIT_MS (default 5000) is canonical.
 * Legacy AF_HERDR_APP_*_WAIT_MS keys are still read by call sites that set them.
 */
function herdrAppWaitMs(env = process.env, defaultMs = 5000) {
  const canon = env && env.AGENTFLEET_HERDR_APP_WAIT_MS;
  if (canon != null && String(canon) !== '') return Number(canon);
  const adopt = env && env.AF_HERDR_APP_ADOPT_WAIT_MS;
  if (adopt != null && String(adopt) !== '') return Number(adopt);
  const rename = env && env.AF_HERDR_APP_RENAME_WAIT_MS;
  if (rename != null && String(rename) !== '') return Number(rename);
  return defaultMs;
}

function defaultRunApp(argv, { bin, env } = {}) {
  const app = bin || resolveHerdrAppBin(env || process.env);
  try {
    const r = spawnSync(app, argv, { encoding: 'utf8' });
    return {
      status: r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      error: r.error || null,
    };
  } catch (err) {
    return { status: null, stdout: '', stderr: '', error: err };
  }
}

function defaultSleep(ms) {
  const n = Math.max(0, Number(ms) || 0);
  if (n <= 0) return;
  try {
    const buf = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(buf, 0, 0, n);
  } catch (_) {
    const end = Date.now() + n;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

/**
 * Best-effort rename helper for space.rename / tab.rename. Never throws.
 * @returns {{ ok: boolean, reason: string|null, skipped?: boolean }}
 */
function nameHerdrAppEntity(kind, id, name, opts = {}) {
  const runApp = opts.runApp || defaultRunApp;
  const sleep = opts.sleep || defaultSleep;
  const env = opts.env || process.env;
  const maxWaitMs =
    opts.maxWaitMs != null
      ? opts.maxWaitMs
      : env.AF_HERDR_APP_RENAME_WAIT_MS != null && env.AF_HERDR_APP_RENAME_WAIT_MS !== ''
        ? Number(env.AF_HERDR_APP_RENAME_WAIT_MS)
        : herdrAppWaitMs(env, 5000);
  const intervalMs =
    opts.intervalMs != null
      ? opts.intervalMs
      : Math.min(500, Math.max(10, Math.floor(maxWaitMs / 2) || 10));
  const doCmd = kind === 'space' ? 'space.rename' : 'tab.rename';

  try {
    if (!id) return { ok: false, reason: `missing ${kind} id` };
    const st = runApp(['status']);
    if (!st || st.status !== 0) {
      return { ok: false, reason: 'app not running' };
    }

    const attempts = Math.max(1, Math.floor(maxWaitMs / intervalMs) + 1);
    let reason = 'rename failed';
    for (let i = 0; i < attempts; i++) {
      if (i > 0) sleep(intervalMs);
      try {
        const r = runApp(['do', doCmd, '--id', String(id), '--name', String(name)]);
        if (r && r.status === 0) return { ok: true, reason: null };
        const msg = r && (r.stderr || r.stdout) ? String(r.stderr || r.stdout).trim() : '';
        reason = msg || (r && r.error && r.error.message) || `exit ${r && r.status}`;
      } catch (err) {
        reason = err && err.message ? err.message : String(err);
      }
    }
    return { ok: false, reason };
  } catch (err) {
    return { ok: false, reason: err && err.message ? err.message : String(err) };
  }
}

/** Best-effort rename of a Herdr-app tab. Never throws. */
function nameHerdrAppTab(tabId, name, opts = {}) {
  return nameHerdrAppEntity('tab', tabId, name, opts);
}

/** Best-effort rename of a Herdr-app space. Never throws. */
function nameHerdrAppSpace(spaceId, name, opts = {}) {
  return nameHerdrAppEntity('space', spaceId, name, opts);
}

/**
 * Rename space (group title) + tab (session title) when names are enabled.
 * Optionally wait until the target space appears in `herdr-app ls` first
 * (fresh keep/adopt creates the space asynchronously).
 * @returns {{ tabRename, spaceRename, waited?: boolean }}
 */
function nameHerdrAppViews({ spaceId, spaceTitle, tabId, tabTitle }, opts = {}) {
  const env = opts.env || process.env;
  if (!herdrNamesEnabled(env)) {
    return {
      tabRename: { ok: true, reason: null, skipped: true },
      spaceRename: { ok: true, reason: null, skipped: true },
    };
  }
  let waited = false;
  // Opt-in: fresh launches pass waitForSpace so rename runs after the app
  // creates the labeled space. Adopt waits separately before calling this.
  if (opts.waitForSpace && spaceId) {
    const w = waitForSpaceInApp(spaceId, opts);
    waited = Boolean(w && w.ok);
  }
  const spaceRename = spaceId
    ? nameHerdrAppSpace(spaceId, spaceTitle || tabTitle || 'agent', opts)
    : { ok: false, reason: 'missing space id' };
  const tabRename = tabId
    ? nameHerdrAppTab(tabId, tabTitle || 'agent', opts)
    : { ok: false, reason: 'missing tab id' };
  return { tabRename, spaceRename, waited };
}

/**
 * Parse `herdr-app ls` JSON into a list of spaces with tabs/terminals.
 * Defensive about shape variants.
 * @returns {object[]|null}
 */
function parseHerdrAppLs(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return null;
  }
  let spaces = null;
  if (Array.isArray(data)) spaces = data;
  else if (data && Array.isArray(data.spaces)) spaces = data.spaces;
  else if (data && Array.isArray(data.data)) spaces = data.data;
  if (!spaces) return null;
  return spaces
    .filter((s) => s && typeof s === 'object')
    .map((s) => ({
      id: s.id != null ? String(s.id) : null,
      name: s.name != null ? String(s.name) : null,
      folder: s.folder != null ? String(s.folder) : null,
      tabs: Array.isArray(s.tabs)
        ? s.tabs
            .filter((t) => t && typeof t === 'object')
            .map((t) => ({
              id: t.id != null ? String(t.id) : null,
              name: t.name != null ? String(t.name) : null,
              terminals: normalizeAppTerminals(t),
            }))
        : [],
    }));
}

function normalizeAppTerminals(tab) {
  const raw =
    (tab && Array.isArray(tab.terminals) && tab.terminals) ||
    (tab && Array.isArray(tab.panes) && tab.panes) ||
    [];
  return raw
    .filter((x) => x && typeof x === 'object')
    .map((x) => ({
      terminal:
        x.terminal != null
          ? String(x.terminal)
          : x.address != null
            ? String(x.address)
            : x.id != null
              ? String(x.id)
              : null,
      pane: x.pane != null ? String(x.pane) : null,
      name: x.name != null ? String(x.name) : null,
    }))
    .filter((x) => x.terminal);
}

/**
 * Find which space/tab currently shows a core terminal address in the app layout.
 * @returns {{ spaceId, spaceName, tabId, tabName, terminal }|null}
 */
function findTerminalPlacement(spaces, address) {
  if (!address || !spaces) return null;
  const key = String(address);
  for (const sp of spaces) {
    for (const tab of sp.tabs || []) {
      for (const term of tab.terminals || []) {
        if (term.terminal === key) {
          return {
            spaceId: sp.id,
            spaceName: sp.name,
            tabId: tab.id,
            tabName: tab.name,
            terminal: term.terminal,
          };
        }
      }
    }
  }
  return null;
}

function spaceExistsInApp(spaces, spaceId) {
  if (!spaceId || !spaces) return false;
  return spaces.some((s) => s && s.id === String(spaceId));
}

function fetchHerdrAppLayout(opts = {}) {
  const runApp = opts.runApp || defaultRunApp;
  const r = runApp(['ls']);
  if (!r || r.status !== 0) {
    return {
      ok: false,
      spaces: [],
      error: (r && (r.stderr || r.stdout || (r.error && r.error.message))) || 'herdr-app ls failed',
    };
  }
  const spaces = parseHerdrAppLs(r.stdout || '');
  if (!spaces) {
    return { ok: false, spaces: [], error: 'malformed herdr-app ls JSON' };
  }
  return { ok: true, spaces, error: null };
}

/**
 * Poll herdr-app ls until spaceId appears (or timeout).
 * @returns {{ ok: boolean, spaces: object[], reason?: string }}
 */
function waitForSpaceInApp(spaceId, opts = {}) {
  const sleep = opts.sleep || defaultSleep;
  const env = opts.env || process.env;
  const maxWaitMs =
    opts.maxWaitMs != null
      ? opts.maxWaitMs
      : env.AF_HERDR_APP_ADOPT_WAIT_MS != null && env.AF_HERDR_APP_ADOPT_WAIT_MS !== ''
        ? Number(env.AF_HERDR_APP_ADOPT_WAIT_MS)
        : herdrAppWaitMs(env, 5000);
  const intervalMs =
    opts.intervalMs != null
      ? opts.intervalMs
      : Math.min(250, Math.max(10, Math.floor(maxWaitMs / 5) || 10));
  const attempts = Math.max(1, Math.floor(maxWaitMs / intervalMs) + 1);
  let last = { ok: false, spaces: [], error: null };
  for (let i = 0; i < attempts; i++) {
    if (i > 0) sleep(intervalMs);
    last = fetchHerdrAppLayout(opts);
    if (last.ok && spaceExistsInApp(last.spaces, spaceId)) {
      return { ok: true, spaces: last.spaces };
    }
  }
  return {
    ok: false,
    spaces: last.spaces || [],
    reason: last.error || `space ${spaceId} not visible in herdr-app ls yet`,
  };
}

function defaultRunHc(argv, opts = {}) {
  const herdr = require('./herdr');
  return herdr.defaultRunHc(argv, opts);
}

/**
 * Dry-run / execute plan steps for adopting one af terminal into the app.
 * When the pane is already in a different space, park → label → keep so the
 * app re-adopts into the target session-group space, then rename.
 *
 * @returns {{ steps: string[][], needPark: boolean, appRunning: boolean, placement }}
 */
function planAdoptMove(item, { appRunning, placement, env } = {}) {
  const steps = [];
  const namesOn = herdrNamesEnabled(env || process.env);
  const inRightPlace =
    Boolean(placement) &&
    placement.spaceId === item.spaceId &&
    placement.tabId === item.tabId;
  const needPark =
    Boolean(appRunning) &&
    Boolean(placement) &&
    (placement.spaceId !== item.spaceId || placement.tabId !== item.tabId);
  // Core labels already match and the pane is not known to be elsewhere:
  // rename only (matches prior adopt --all behavior; park path still runs
  // when placement shows a different space/tab).
  const renameOnly =
    Boolean(appRunning) && !needPark && (inRightPlace || Boolean(item.alreadyAdopted));

  function pushRenames() {
    if (!namesOn) return;
    steps.push([
      'herdr-app',
      'do',
      'space.rename',
      '--id',
      item.spaceId,
      '--name',
      item.spaceTitle || item.title,
    ]);
    steps.push(['herdr-app', 'do', 'tab.rename', '--id', item.tabId, '--name', item.title]);
  }

  if (!appRunning) {
    steps.push(['hc', ...item.labelArgv]);
    steps.push(['hc', ...item.keepArgv]);
    return {
      steps,
      needPark: false,
      appRunning: false,
      placement: placement || null,
      inRightPlace: false,
      renameOnly: false,
    };
  }

  if (renameOnly) {
    pushRenames();
    return {
      steps,
      needPark: false,
      appRunning: true,
      placement: placement || null,
      inRightPlace: Boolean(inRightPlace),
      renameOnly: true,
    };
  }

  if (needPark) {
    steps.push(['herdr-app', 'do', 'terminal.park', '--terminal', String(item.address)]);
  }
  steps.push(['hc', ...item.labelArgv]);
  steps.push(['hc', ...item.keepArgv]);
  pushRenames();
  return {
    steps,
    needPark,
    appRunning: true,
    placement: placement || null,
    inRightPlace: false,
    renameOnly: false,
  };
}

/**
 * Execute adopt (and optional park/move) for one planAdopt item.
 * Never throws.
 */
function executeAdoptItem(item, opts = {}) {
  const runApp = opts.runApp || defaultRunApp;
  const runHc = opts.runHc || defaultRunHc;
  const dryRun = Boolean(opts.dryRun);
  const env = opts.env || process.env;

  const row = {
    title: item.title,
    id: item.id,
    address: item.address,
    name: item.name,
    spaceId: item.spaceId,
    tabId: item.tabId,
    spaceTitle: item.spaceTitle,
    alreadyAdopted: Boolean(item.alreadyAdopted),
    legacy: Boolean(item.legacy),
    labeled: false,
    kept: false,
    parked: false,
    ok: true,
    error: null,
    tabRename: null,
    spaceRename: null,
    appMove: null,
    steps: null,
  };

  const st = runApp(['status']);
  const appRunning = Boolean(st && st.status === 0);
  let placement = null;
  if (appRunning) {
    const layout = fetchHerdrAppLayout({ runApp, ...opts });
    if (layout.ok) placement = findTerminalPlacement(layout.spaces, item.address);
  }

  const planned = planAdoptMove(item, { appRunning, placement, env });
  row.steps = planned.steps;

  if (dryRun) {
    row.appMove = {
      ok: appRunning,
      skipped: !appRunning,
      reason: appRunning ? null : 'herdr app not running',
      parked: planned.needPark,
      from: placement
        ? { spaceId: placement.spaceId, spaceName: placement.spaceName }
        : null,
      to: { spaceId: item.spaceId },
    };
    return row;
  }

  if (!appRunning) {
    const lab = runHc(item.labelArgv);
    const kep = runHc(item.keepArgv);
    row.labeled = lab.status === 0;
    row.kept = kep.status === 0;
    if (!row.labeled || !row.kept) {
      row.ok = false;
      const parts = [];
      if (!row.labeled) parts.push(`label: ${(lab.stderr || lab.stdout || '').trim() || lab.status}`);
      if (!row.kept) parts.push(`keep: ${(kep.stderr || kep.stdout || '').trim() || kep.status}`);
      row.error = parts.join('; ');
    }
    row.appMove = {
      ok: false,
      skipped: true,
      reason: 'herdr app not running',
      parked: false,
      from: null,
      to: { spaceId: item.spaceId },
      hint: 'Start the Herdr app and re-run aflt adopt --all to move panes into session spaces.',
    };
    row.tabRename = { ok: true, reason: null, skipped: true };
    row.spaceRename = { ok: true, reason: null, skipped: true };
    return row;
  }

  if (planned.renameOnly) {
    row.labeled = true;
    row.kept = true;
    row.appMove = {
      ok: true,
      parked: false,
      from: placement
        ? { spaceId: placement.spaceId, spaceName: placement.spaceName }
        : null,
      to: { spaceId: item.spaceId },
    };
    const named = nameHerdrAppViews(
      {
        spaceId: item.spaceId,
        spaceTitle: item.spaceTitle || item.title,
        tabId: item.tabId,
        tabTitle: item.title,
      },
      { ...opts, runApp, env, waitForSpace: false }
    );
    row.tabRename = renameResult(named.tabRename);
    row.spaceRename = renameResult(named.spaceRename);
    return row;
  }

  const from = placement
    ? { spaceId: placement.spaceId, spaceName: placement.spaceName }
    : null;

  if (planned.needPark) {
    const park = runApp(['do', 'terminal.park', '--terminal', String(item.address)]);
    row.parked = park.status === 0;
    if (!row.parked) {
      row.ok = false;
      row.error =
        `park: ${(park.stderr || park.stdout || (park.error && park.error.message) || park.status)}`.trim();
      row.appMove = {
        ok: false,
        parked: false,
        from,
        to: { spaceId: item.spaceId },
        reason: row.error,
      };
      return row;
    }
  }

  const lab = runHc(item.labelArgv);
  const kep = runHc(item.keepArgv);
  row.labeled = lab.status === 0;
  row.kept = kep.status === 0;
  if (!row.labeled || !row.kept) {
    row.ok = false;
    const parts = [];
    if (!row.labeled) parts.push(`label: ${(lab.stderr || lab.stdout || '').trim() || lab.status}`);
    if (!row.kept) parts.push(`keep: ${(kep.stderr || kep.stdout || '').trim() || kep.status}`);
    row.error = parts.join('; ');
  }

  const waited = waitForSpaceInApp(item.spaceId, { ...opts, runApp });
  const named = nameHerdrAppViews(
    {
      spaceId: item.spaceId,
      spaceTitle: item.spaceTitle || item.title,
      tabId: item.tabId,
      tabTitle: item.title,
    },
    { ...opts, runApp, env, waitForSpace: false }
  );
  row.tabRename = renameResult(named.tabRename);
  row.spaceRename = renameResult(named.spaceRename);

  row.appMove = {
    ok: Boolean(row.labeled && row.kept && waited.ok),
    parked: Boolean(row.parked),
    from,
    to: { spaceId: item.spaceId },
    reason: waited.ok ? null : waited.reason || null,
  };
  if (!waited.ok && row.ok) {
    // Pane may still land; rename may have failed — keep ok false only if label/keep failed.
    if (row.spaceRename && !row.spaceRename.ok && !row.spaceRename.skipped) {
      /* already recorded */
    }
  }
  return row;
}

function renameResult(r) {
  if (!r) return { ok: false, error: 'rename failed', skipped: false };
  return {
    ok: Boolean(r.ok),
    error: r.ok ? null : r.reason || 'rename failed',
    skipped: Boolean(r.skipped),
  };
}

/** Same sanitization as backends.sanitizeHerdrName (kept local to avoid require cycles). */
function sanitizeName(title) {
  return (
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '')
      .slice(0, 32)
      .replace(/[-_]+$/g, '') || 'agent'
  );
}

function isLiveLike(t) {
  if (!t) return false;
  if (t.state === 'finished') return false;
  if (t.reason === 'exited' || t.reason === 'killed') {
    if (t.state === 'finished' || t.exitCode != null) return false;
  }
  if (t.state === 'live') return true;
  if (t.state && t.state !== 'finished') return true;
  if (!t.state && !t.reason) return true;
  return false;
}

/**
 * Match a live Herdr terminal to a tracked af session by af_id label or name.
 */
function matchSessionForTerminal(terminal, sessions) {
  if (!terminal || !sessions || !sessions.length) return null;
  const afId =
    terminal.afId ||
    (terminal.labels && (terminal.labels.af_id || terminal.labels.afId)) ||
    null;
  if (afId) {
    const byId = sessions.find((s) => s && s.id === afId);
    if (byId) return byId;
  }
  const name = terminal.name || null;
  if (name) {
    for (const s of sessions) {
      if (!s) continue;
      if (sanitizeName(s.title) === name) return s;
      if (terminal.labels && terminal.labels.title && terminal.labels.title === s.title) return s;
    }
  }
  return null;
}

/**
 * Plan adoption of live af Herdr terminals into the desktop app.
 * Pure: matches terminals to the given session pool; returns exact hc argv.
 * Uses session-group space ids; marks legacy cwd-based labels as needing relabel.
 *
 * @param {object[]} sessions tracked af sessions to consider
 * @param {object[]} terminals from fetchHerdrTerminals (normalized)
 * @returns {{ ok: boolean, items: object[] }}
 */
function planAdopt(sessions, terminals) {
  const pool = sessions || [];
  const items = [];
  for (const t of terminals || []) {
    if (!isLiveLike(t)) continue;
    const session = matchSessionForTerminal(t, pool);
    if (!session) continue;

    const spaceId = herdrSpaceId(session);
    const tabId = herdrTabId(session);
    const spaceTitle = resolveSpaceTitle(session, { sessions: pool });
    const labels = t.labels || {};
    const st = herdrAppStatus(session, t, { sessions: pool });
    const already = st.ok;
    const address = t.address || t.name;
    if (!address) continue;

    items.push({
      title: session.title,
      id: session.id,
      address,
      name: t.name || null,
      spaceId,
      tabId,
      spaceTitle,
      alreadyAdopted: already,
      legacy: st.legacy,
      needsAdopt: st.needsAdopt,
      labelArgv: ['label', address, `herdr.space=${spaceId}`, `herdr.tab=${tabId}`],
      keepArgv: ['keep', address],
    });
  }

  return { ok: true, items };
}

module.exports = {
  normalizeCwd,
  requireSessionCwd,
  spaceGroupKey,
  herdrSpaceId,
  legacyHerdrSpaceId,
  resolveSpaceTitle,
  herdrTabId,
  herdrAppLabels,
  herdrAppStatus,
  herdrAppEnabled,
  herdrNamesEnabled,
  resolveHerdrAppBin,
  herdrAppWaitMs,
  nameHerdrAppTab,
  nameHerdrAppSpace,
  nameHerdrAppViews,
  parseHerdrAppLs,
  findTerminalPlacement,
  fetchHerdrAppLayout,
  waitForSpaceInApp,
  planAdoptMove,
  executeAdoptItem,
  planAdopt,
  matchSessionForTerminal,
  defaultRunApp,
  defaultRunHc,
  defaultSleep,
};
