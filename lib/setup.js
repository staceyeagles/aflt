'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { homeDir, expandUserPath, envNonEmpty } = require('./util');
const memory = require('./memory');
const herdr = require('./herdr');
const herdrapp = require('./herdrapp');
const herdrappinstall = require('./herdrappinstall');
const BIN_NAMES = Object.freeze(['aflt', 'af', 'agentfleet']);
const MIN_NODE_MAJOR = 18;

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function ourAfJs(root = packageRoot()) {
  return path.join(root, 'bin', 'af.js');
}

function realpathOrNull(p) {
  try {
    if (p == null) return null;
    return fs.realpathSync(p);
  } catch (_) {
    return null;
  }
}

function existsPath(p) {
  try {
    fs.lstatSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

function parseNodeMajor(version = process.version) {
  const m = String(version || '').match(/^v?(\d+)/);
  return m ? Number(m[1]) : null;
}

function localBinDir(env = process.env) {
  return path.join(homeDirFromEnv(env), '.local', 'bin');
}

function homeDirFromEnv(env = process.env) {
  return (
    envNonEmpty(env, 'HOME') ||
    envNonEmpty(env, 'USERPROFILE') ||
    homeDir()
  );
}

function pathEntries(env = process.env) {
  return String(env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .map((p) => {
      try {
        return path.resolve(expandUserPath(p));
      } catch (_) {
        return p;
      }
    });
}

function isDirOnPath(dir, env = process.env) {
  let want;
  try {
    want = fs.realpathSync(dir);
  } catch (_) {
    want = path.resolve(dir);
  }
  return pathEntries(env).some((p) => {
    try {
      return fs.realpathSync(p) === want;
    } catch (_) {
      return path.resolve(p) === want;
    }
  });
}

function whichInEnv(cmd, env = process.env) {
  const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], {
    encoding: 'utf8',
    env,
  });
  if (r.status === 0) return (r.stdout || '').trim().split('\n')[0] || null;
  return null;
}

function sameFile(a, b) {
  const ra = realpathOrNull(a);
  const rb = realpathOrNull(b);
  if (ra && rb) return ra === rb;
  return path.resolve(String(a || '')) === path.resolve(String(b || ''));
}

function pointsAtOurBin(candidate, ourBin) {
  if (!candidate || !ourBin) return false;
  if (sameFile(candidate, ourBin)) return true;
  try {
    const st = fs.lstatSync(candidate);
    if (st.isSymbolicLink()) {
      const target = path.resolve(path.dirname(candidate), fs.readlinkSync(candidate));
      return sameFile(target, ourBin);
    }
  } catch (_) {
    /* ignore */
  }
  return false;
}

function classifyLocalLink(name, localBin, ourBin, env) {
  const dest = path.join(localBin, name);
  const onPath = whichInEnv(name, env);
  const result = {
    name,
    dest,
    onPath: onPath || null,
    status: 'missing',
    detail: null,
    action: null,
  };

  if (onPath && pointsAtOurBin(onPath, ourBin)) {
    result.status = 'ok';
    result.detail = `resolves to this package (${onPath})`;
    result.action = 'none';
    return result;
  }

  if (existsPath(dest)) {
    if (pointsAtOurBin(dest, ourBin)) {
      result.status = 'ok';
      result.detail = `~/.local/bin/${name} already links to this package`;
      result.action = 'none';
      if (onPath && !pointsAtOurBin(onPath, ourBin)) {
        result.detail += `; PATH resolves elsewhere first (${onPath})`;
      }
      return result;
    }
    result.status = 'foreign';
    result.detail = `~/.local/bin/${name} exists and is not this package`;
    result.action = 'refuse';
    return result;
  }

  if (onPath && !pointsAtOurBin(onPath, ourBin)) {
    result.status = 'foreign';
    result.detail = `PATH resolves ${name} to ${onPath} (not this package); no ~/.local/bin/${name} to create`;
    result.action = 'none';
    return result;
  }

  result.status = 'needed';
  result.detail = `would link ~/.local/bin/${name} → ${ourBin}`;
  result.action = 'link';
  return result;
}

function enginePresence(env = process.env) {
  const cursorOverride = envNonEmpty(env, 'AGENTFLEET_CURSOR_BIN');
  const cursorBin =
    cursorOverride || whichInEnv('cursor-agent', env) || whichInEnv('agent', env) || null;
  const cursorPresent = Boolean(
    cursorOverride ||
      whichInEnv('cursor-agent', env) ||
      whichInEnv('agent', env) ||
      (cursorBin && existsPath(cursorBin))
  );

  const copilotOverride = envNonEmpty(env, 'AGENTFLEET_COPILOT_BIN');
  const copilotBin = copilotOverride || whichInEnv('copilot', env) || null;
  const copilotPresent = Boolean(
    copilotOverride || whichInEnv('copilot', env) || (copilotBin && existsPath(copilotBin))
  );

  return {
    cursor: {
      present: cursorPresent,
      path: cursorBin || 'cursor-agent',
      detail: cursorPresent
        ? cursorBin || 'cursor-agent'
        : 'not on PATH — install: curl https://cursor.com/install -fsS | bash',
    },
    copilot: {
      present: copilotPresent,
      path: copilotBin || 'copilot',
      detail: copilotPresent
        ? copilotBin || 'copilot'
        : 'not on PATH (optional) — install: npm install -g @github/copilot',
    },
  };
}

function installTemplates({ dryRun, force, home }) {
  const srcDir = path.join(packageRoot(), 'templates');
  const destDir = path.join(home, '.config', 'herdr-core', 'templates');
  const files = herdr.HERDR_TEMPLATE_FILES;
  const results = [];
  let installed = 0;
  let skipped = 0;
  let would = 0;

  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });

  for (const f of files) {
    const src = path.join(srcDir, f);
    const dest = path.join(destDir, f);
    if (!fs.existsSync(src)) {
      results.push({ file: f, status: 'error', detail: `missing source ${src}` });
      continue;
    }
    if (existsPath(dest) && !force) {
      results.push({ file: f, status: 'skipped', detail: 'exists' });
      skipped++;
      continue;
    }
    if (dryRun) {
      results.push({ file: f, status: 'would_install', dest });
      would++;
      continue;
    }
    fs.copyFileSync(src, dest);
    results.push({ file: f, status: 'installed', dest });
    installed++;
  }

  return {
    destDir,
    results,
    installed,
    skipped,
    would,
    ok: results.every((r) => r.status !== 'error'),
  };
}

/**
 * Plan and optionally apply machine setup.
 * Preview (apply=false) never writes. Apply is idempotent.
 *
 * @param {object} opts
 * @param {boolean} [opts.apply]
 * @param {boolean} [opts.herdr]
 * @param {string|null} [opts.memory]
 * @param {boolean} [opts.force]  overwrite foreign ~/.local/bin links
 * @param {NodeJS.ProcessEnv} [opts.env]
 * @returns {object}
 */
function runSetup(opts = {}) {
  const apply = Boolean(opts.apply);
  const wantHerdr = Boolean(opts.herdr);
  const force = Boolean(opts.force);
  const memoryPath =
    opts.memory != null && opts.memory !== true && opts.memory !== false
      ? String(opts.memory)
      : null;
  const env = opts.env || process.env;
  const root = packageRoot();
  const ourBin = ourAfJs(root);
  const home = homeDirFromEnv(env);
  const fleet = envNonEmpty(env, 'AGENTFLEET_HOME') || path.join(home, '.agentfleet');
  const sessionsFile =
    envNonEmpty(env, 'AGENTFLEET_REGISTRY') || path.join(fleet, 'sessions.json');
  const configFile = path.join(fleet, 'config.json');
  const localBin = localBinDir(env);
  const localBinOnPath = isDirOnPath(localBin, env);

  const actions = [];
  const errors = [];
  let ok = true;

  // --- Node ---
  const nodeMajor = parseNodeMajor(process.version);
  const nodeOk = nodeMajor != null && nodeMajor >= MIN_NODE_MAJOR;
  const node = {
    ok: nodeOk,
    version: process.version,
    detail: nodeOk
      ? process.version
      : `Node ${process.version} is below required >= ${MIN_NODE_MAJOR}`,
  };
  actions.push({
    id: 'node',
    status: nodeOk ? 'ok' : 'error',
    detail: node.detail,
  });
  if (!nodeOk) {
    ok = false;
    errors.push(node.detail);
  }

  // --- PATH / binaries ---
  const pathInfo = {
    localBin,
    localBinOnPath,
    detail: localBinOnPath
      ? `${localBin} is on PATH`
      : `${localBin} is not on PATH — add it manually to your shell rc (setup never edits shell startup files)`,
  };
  actions.push({
    id: 'path',
    status: localBinOnPath ? 'ok' : 'warn',
    detail: pathInfo.detail,
  });

  const binaries = BIN_NAMES.map((name) => classifyLocalLink(name, localBin, ourBin, env));
  for (const b of binaries) {
    if (b.action === 'link') {
      if (apply) {
        try {
          fs.mkdirSync(localBin, { recursive: true });
          fs.symlinkSync(ourBin, b.dest);
          b.status = 'linked';
          b.detail = `linked ${b.dest} → ${ourBin}`;
          b.action = 'linked';
          actions.push({ id: `link:${b.name}`, status: 'applied', detail: b.detail });
        } catch (err) {
          ok = false;
          b.status = 'error';
          b.detail = err.message || String(err);
          errors.push(`link ${b.name}: ${b.detail}`);
          actions.push({ id: `link:${b.name}`, status: 'error', detail: b.detail });
        }
      } else {
        actions.push({ id: `link:${b.name}`, status: 'would', detail: b.detail });
      }
    } else if (b.action === 'refuse') {
      if (force && apply) {
        try {
          fs.mkdirSync(localBin, { recursive: true });
          fs.rmSync(b.dest, { force: true });
          fs.symlinkSync(ourBin, b.dest);
          b.status = 'linked';
          b.detail = `replaced and linked ${b.dest} → ${ourBin}`;
          b.action = 'linked';
          actions.push({ id: `link:${b.name}`, status: 'applied', detail: b.detail });
        } catch (err) {
          ok = false;
          b.status = 'error';
          b.detail = err.message || String(err);
          errors.push(`link ${b.name}: ${b.detail}`);
          actions.push({ id: `link:${b.name}`, status: 'error', detail: b.detail });
        }
      } else if (force && !apply) {
        b.detail = `would replace foreign ${b.dest} with link to this package (--force)`;
        actions.push({ id: `link:${b.name}`, status: 'would', detail: b.detail });
      } else {
        ok = false;
        errors.push(
          `refusing to overwrite ${b.dest} (not this package); pass --force to replace`
        );
        actions.push({
          id: `link:${b.name}`,
          status: 'refused',
          detail: b.detail,
        });
      }
    } else {
      actions.push({
        id: `bin:${b.name}`,
        status: b.status === 'ok' ? 'ok' : 'skip',
        detail: b.detail,
      });
    }
  }

  // --- Config home (never rewrite sessions/config contents) ---
  const homeExisted = existsPath(fleet);
  const sessionsExisted = existsPath(sessionsFile);
  const configExisted = existsPath(configFile);
  let sessionsBefore = null;
  let configBefore = null;
  if (sessionsExisted) {
    try {
      sessionsBefore = fs.readFileSync(sessionsFile);
    } catch (_) {
      /* ignore */
    }
  }
  if (configExisted) {
    try {
      configBefore = fs.readFileSync(configFile);
    } catch (_) {
      /* ignore */
    }
  }

  const homeInfo = {
    path: fleet,
    exists: homeExisted,
    status: homeExisted ? 'ok' : apply ? 'created' : 'would_create',
  };
  if (!homeExisted) {
    if (apply) {
      try {
        fs.mkdirSync(fleet, { recursive: true, mode: 0o700 });
        homeInfo.exists = true;
        homeInfo.status = 'created';
        actions.push({ id: 'home', status: 'applied', detail: `created ${fleet}` });
      } catch (err) {
        ok = false;
        homeInfo.status = 'error';
        const msg = err.message || String(err);
        errors.push(`create home: ${msg}`);
        actions.push({ id: 'home', status: 'error', detail: msg });
      }
    } else {
      actions.push({ id: 'home', status: 'would', detail: `would create ${fleet}` });
    }
  } else {
    actions.push({ id: 'home', status: 'ok', detail: `exists ${fleet}` });
  }

  // Preserve check (read-only assertion after apply)
  if (apply && sessionsBefore) {
    try {
      const after = fs.readFileSync(sessionsFile);
      if (!after.equals(sessionsBefore)) {
        ok = false;
        errors.push('sessions.json changed unexpectedly during setup');
      }
    } catch (_) {
      /* ignore */
    }
  }
  if (apply && configBefore && !memoryPath) {
    try {
      const after = fs.readFileSync(configFile);
      if (!after.equals(configBefore)) {
        ok = false;
        errors.push('config.json changed unexpectedly during setup');
      }
    } catch (_) {
      /* ignore */
    }
  }

  const sessionsInfo = {
    path: sessionsFile,
    exists: sessionsExisted || existsPath(sessionsFile),
    preserved: true,
  };
  const configInfo = {
    path: configFile,
    exists: configExisted || existsPath(configFile),
    preserved: !memoryPath || !apply,
  };

  // --- Memory ---
  let registered = null;
  try {
    // resolveMemoryRepo reads config via AGENTFLEET_HOME / HOME
    const prevHome = process.env.HOME;
    const prevAf = process.env.AGENTFLEET_HOME;
    const prevMem = process.env.AFLT_MEMORY_REPO;
    process.env.HOME = home;
    process.env.AGENTFLEET_HOME = fleet;
    if (env.AFLT_MEMORY_REPO) process.env.AFLT_MEMORY_REPO = env.AFLT_MEMORY_REPO;
    else delete process.env.AFLT_MEMORY_REPO;
    registered = memory.resolveMemoryRepo(process.env);
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
    if (prevAf === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevAf;
    if (prevMem === undefined) delete process.env.AFLT_MEMORY_REPO;
    else process.env.AFLT_MEMORY_REPO = prevMem;
  } catch (_) {
    registered = null;
  }

  const memoryInfo = {
    registered,
    flag: memoryPath,
    status: 'none',
    detail: null,
    repo: null,
  };

  if (memoryPath) {
    if (apply) {
      const prevHome = process.env.HOME;
      const prevAf = process.env.AGENTFLEET_HOME;
      process.env.HOME = home;
      process.env.AGENTFLEET_HOME = fleet;
      try {
        const result = memory.initMemoryRepo(memoryPath, { force });
        memoryInfo.status = result.created ? 'created' : 'registered';
        memoryInfo.repo = result.repo;
        memoryInfo.detail = result.created
          ? `initialized memory repo ${result.repo}`
          : `registered memory repo ${result.repo}`;
        actions.push({ id: 'memory', status: 'applied', detail: memoryInfo.detail });
        configInfo.preserved = false;
      } catch (err) {
        ok = false;
        memoryInfo.status = 'error';
        memoryInfo.detail = err.message || String(err);
        errors.push(`memory: ${memoryInfo.detail}`);
        actions.push({ id: 'memory', status: 'error', detail: memoryInfo.detail });
      } finally {
        if (prevHome === undefined) delete process.env.HOME;
        else process.env.HOME = prevHome;
        if (prevAf === undefined) delete process.env.AGENTFLEET_HOME;
        else process.env.AGENTFLEET_HOME = prevAf;
      }
    } else {
      memoryInfo.status = 'would_init';
      memoryInfo.detail = `would init/register memory repo at ${memoryPath}`;
      actions.push({ id: 'memory', status: 'would', detail: memoryInfo.detail });
    }
  } else if (registered) {
    memoryInfo.status = 'ok';
    memoryInfo.detail = `already registered (${registered.source}): ${registered.path}`;
    actions.push({ id: 'memory', status: 'ok', detail: memoryInfo.detail });
  } else {
    memoryInfo.status = 'none';
    memoryInfo.detail = 'no memory repo; pass --memory <path> to init (opt-in)';
    actions.push({ id: 'memory', status: 'skip', detail: memoryInfo.detail });
  }

  // --- Engines (report only) ---
  const engines = enginePresence(env);
  actions.push({
    id: 'engine:cursor',
    status: engines.cursor.present ? 'ok' : 'warn',
    detail: engines.cursor.detail,
  });
  actions.push({
    id: 'engine:copilot',
    status: engines.copilot.present ? 'ok' : 'warn',
    detail: engines.copilot.detail,
  });

  // --- Herdr (opt-in) ---
  const prevHc = process.env.AGENTFLEET_HC_BIN;
  const prevApp = process.env.AGENTFLEET_HERDR_APP_BIN;
  const prevPath = process.env.PATH;
  if (env.AGENTFLEET_HC_BIN) process.env.AGENTFLEET_HC_BIN = env.AGENTFLEET_HC_BIN;
  if (env.AGENTFLEET_HERDR_APP_BIN) {
    process.env.AGENTFLEET_HERDR_APP_BIN = env.AGENTFLEET_HERDR_APP_BIN;
  }
  if (env.PATH != null) process.env.PATH = env.PATH;

  const hcPresent = herdr.hcOnPath(env);
  const hcPath = herdr.resolveHcBin(env);
  const appBin = herdrapp.resolveHerdrAppBin(env);
  const appPresent = Boolean(
    (env.AGENTFLEET_HERDR_APP_BIN && existsPath(env.AGENTFLEET_HERDR_APP_BIN)) ||
      whichInEnv('herdr-app', env) ||
      (appBin && appBin !== 'herdr-app' && existsPath(appBin))
  );

  if (prevHc === undefined) delete process.env.AGENTFLEET_HC_BIN;
  else process.env.AGENTFLEET_HC_BIN = prevHc;
  if (prevApp === undefined) delete process.env.AGENTFLEET_HERDR_APP_BIN;
  else process.env.AGENTFLEET_HERDR_APP_BIN = prevApp;
  process.env.PATH = prevPath;

  const herdrInfo = {
    requested: wantHerdr,
    hc: { present: hcPresent, path: hcPath },
    herdrApp: { present: appPresent, path: appBin },
    templates: null,
    panel: null,
    status: wantHerdr ? 'pending' : 'skipped',
    detail: wantHerdr ? null : 'pass --herdr to install templates/panel',
  };

  if (!wantHerdr) {
    actions.push({ id: 'herdr', status: 'skip', detail: herdrInfo.detail });
  } else if (!hcPresent && !appPresent) {
    herdrInfo.status = 'absent';
    herdrInfo.detail = 'hc / herdr-app not found; skipped Herdr setup';
    actions.push({ id: 'herdr', status: 'skip', detail: herdrInfo.detail });
  } else {
    if (hcPresent) {
      const tpl = installTemplates({
        dryRun: !apply,
        force: false,
        home,
      });
      herdrInfo.templates = tpl;
      actions.push({
        id: 'herdr:templates',
        status: apply
          ? tpl.installed
            ? 'applied'
            : 'ok'
          : tpl.would
            ? 'would'
            : 'ok',
        detail: apply
          ? `templates installed=${tpl.installed} skipped=${tpl.skipped}`
          : `templates would_install=${tpl.would} skipped=${tpl.skipped}`,
      });
    } else {
      herdrInfo.templates = { skipped: true, detail: 'hc not present' };
      actions.push({
        id: 'herdr:templates',
        status: 'skip',
        detail: 'hc not on PATH; skipped templates',
      });
    }

    if (appPresent || hcPresent) {
      // Panel install only needs HERDR_APP_HOME / ~/.config/herdr-app; do not
      // require herdr-app binary to write files (status still reported).
      const panel = herdrappinstall.install({
        dryRun: !apply,
        force: false,
        home: path.join(home, '.config', 'herdr-app'),
        root,
      });
      herdrInfo.panel = {
        ok: panel.ok,
        dryRun: panel.dryRun,
        home: panel.home,
        actions: panel.actions,
        error: panel.error,
      };
      if (!panel.ok) {
        ok = false;
        errors.push(panel.error || 'herdr-app install refused');
        actions.push({
          id: 'herdr:panel',
          status: 'refused',
          detail: panel.error || 'refused',
        });
      } else {
        actions.push({
          id: 'herdr:panel',
          status: apply ? 'applied' : 'would',
          detail: panel.actions.map((a) => `${a.action}:${a.kind}`).join(', '),
        });
      }
    }

    herdrInfo.status = apply ? 'applied' : 'preview';
    herdrInfo.detail = apply ? 'Herdr setup applied' : 'Herdr setup preview';
  }

  return {
    ok,
    mode: apply ? 'apply' : 'preview',
    apply,
    force,
    packageRoot: root,
    node,
    path: pathInfo,
    binaries,
    home: homeInfo,
    sessions: sessionsInfo,
    config: configInfo,
    memory: memoryInfo,
    engines,
    herdr: herdrInfo,
    actions,
    errors,
  };
}

function formatText(result) {
  const lines = [];
  lines.push(`aflt setup (${result.mode})`);
  lines.push('');
  for (const a of result.actions) {
    const mark =
      a.status === 'ok' || a.status === 'applied' || a.status === 'already'
        ? 'ok'
        : a.status === 'would' || a.status === 'warn' || a.status === 'skip'
          ? '..'
          : a.status === 'refused' || a.status === 'error'
            ? '!!'
            : '..';
    lines.push(`${mark} ${a.id}: ${a.detail || a.status}`);
  }
  if (!result.apply) {
    lines.push('');
    lines.push('Preview only. Re-run with --apply to perform needed actions.');
  } else if (result.ok && result.errors.length === 0) {
    lines.push('');
    lines.push('Setup complete (idempotent; existing sessions/settings preserved).');
  }
  if (result.errors.length) {
    lines.push('');
    for (const e of result.errors) lines.push(`error: ${e}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = {
  BIN_NAMES,
  MIN_NODE_MAJOR,
  packageRoot,
  ourAfJs,
  runSetup,
  formatText,
  parseNodeMajor,
  localBinDir,
  isDirOnPath,
  classifyLocalLink,
  installTemplates,
};
