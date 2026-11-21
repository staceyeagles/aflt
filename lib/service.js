'use strict';

/**
 * `aflt service` — macOS LaunchAgent for the dashboard server (loop scheduler host).
 *
 * Writes ~/Library/LaunchAgents/dev.aflt.dashboard.plist. Never touches launchctl
 * in tests — inject `opts.launchctl`. Non-macOS returns a clear unsupported result.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { fleetDir, homeDir, envNonEmpty } = require('./util');
const dashboard = require('./dashboard');

const LABEL = 'dev.aflt.dashboard';
const PLIST_BASENAME = 'dev.aflt.dashboard.plist';

function packageRoot() {
  return path.resolve(__dirname, '..');
}

function afJsPath(root = packageRoot()) {
  return path.join(root, 'bin', 'af.js');
}

function launchAgentsDir(env = process.env) {
  const home =
    envNonEmpty(env, 'HOME') ||
    envNonEmpty(env, 'USERPROFILE') ||
    homeDir();
  return path.join(home, 'Library', 'LaunchAgents');
}

function plistPath(env = process.env) {
  return path.join(launchAgentsDir(env), PLIST_BASENAME);
}

function logsDir(env = process.env) {
  return path.join(fleetDir(), 'logs');
}

function isDarwin(platform = process.platform) {
  return platform === 'darwin';
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlStringArray(values) {
  return values
    .map((v) => `    <string>${escapeXml(v)}</string>`)
    .join('\n');
}

/**
 * Build LaunchAgent plist XML for the dashboard server.
 */
function buildPlist(opts = {}) {
  const host = opts.host != null ? String(opts.host) : dashboard.DEFAULT_HOST;
  const port =
    opts.port != null && Number.isFinite(Number(opts.port))
      ? Math.floor(Number(opts.port))
      : dashboard.DEFAULT_PORT;
  const nodeBin = opts.nodeBin || process.execPath;
  const script = opts.afJs || afJsPath(opts.packageRoot || packageRoot());
  const env = opts.env || process.env;
  const outLog = opts.stdoutLog || path.join(logsDir(env), 'dashboard.out.log');
  const errLog = opts.stderrLog || path.join(logsDir(env), 'dashboard.err.log');
  const workingDir = opts.workingDirectory || packageRoot();
  const afHome = opts.agentfleetHome || fleetDir();

  const programArgs = [
    nodeBin,
    script,
    'dashboard',
    '--serve',
    '--host',
    host,
    '--port',
    String(port),
  ];

  const envEntries = [
    ['AGENTFLEET_HOME', afHome],
    ['HOME', envNonEmpty(env, 'HOME') || homeDir()],
    ['PATH', env.PATH || '/usr/local/bin:/usr/bin:/bin'],
  ];
  if (envNonEmpty(env, 'AFLT_MEMORY_REPO')) {
    envEntries.push(['AFLT_MEMORY_REPO', envNonEmpty(env, 'AFLT_MEMORY_REPO')]);
  }
  if (envNonEmpty(env, 'AFLT_NOTIFY_URL')) {
    envEntries.push(['AFLT_NOTIFY_URL', envNonEmpty(env, 'AFLT_NOTIFY_URL')]);
  }

  const envXml = envEntries
    .map(
      ([k, v]) =>
        `    <key>${escapeXml(k)}</key>\n    <string>${escapeXml(v)}</string>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
${xmlStringArray(programArgs)}
  </array>
  <key>WorkingDirectory</key>
  <string>${escapeXml(workingDir)}</string>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(outLog)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(errLog)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${envXml}
  </dict>
</dict>
</plist>
`;
}

function defaultLaunchctl() {
  return {
    load(plist, env) {
      return spawnSync('launchctl', ['load', '-w', plist], {
        encoding: 'utf8',
        env: env || process.env,
      });
    },
    unload(plist, env) {
      return spawnSync('launchctl', ['unload', '-w', plist], {
        encoding: 'utf8',
        env: env || process.env,
      });
    },
    list(label, env) {
      return spawnSync('launchctl', ['list', label], {
        encoding: 'utf8',
        env: env || process.env,
      });
    },
  };
}

function unsupportedResult(action) {
  return {
    ok: false,
    supported: false,
    action,
    error: `aflt service is only supported on macOS (LaunchAgent); this platform is ${process.platform}`,
    platform: process.platform,
  };
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.print] — return plist text without writing
 * @param {boolean} [opts.apply] — write + load (default true unless print)
 * @param {object} [opts.launchctl] — injectable launchctl adapter
 */
function install(opts = {}) {
  const action = 'install';
  if (!isDarwin(opts.platform || process.platform)) {
    return unsupportedResult(action);
  }

  const env = opts.env || process.env;
  const host = opts.host != null ? String(opts.host) : dashboard.DEFAULT_HOST;
  const port =
    opts.port != null && Number.isFinite(Number(opts.port))
      ? Math.floor(Number(opts.port))
      : dashboard.DEFAULT_PORT;
  const plist = buildPlist({ ...opts, host, port, env });
  const dest = opts.plistPath || plistPath(env);
  const printOnly = Boolean(opts.print);

  if (printOnly) {
    return {
      ok: true,
      supported: true,
      action,
      print: true,
      label: LABEL,
      path: dest,
      host,
      port,
      plist,
    };
  }

  const apply = opts.apply !== false;
  const plan = {
    ok: true,
    supported: true,
    action,
    label: LABEL,
    path: dest,
    host,
    port,
    logsDir: logsDir(env),
    written: false,
    loaded: false,
  };

  if (!apply) {
    plan.dryRun = true;
    plan.plist = plist;
    return plan;
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o755 });
  fs.mkdirSync(logsDir(env), { recursive: true, mode: 0o700 });
  fs.writeFileSync(dest, plist, { encoding: 'utf8', mode: 0o644 });
  plan.written = true;

  const launchctl = opts.launchctl || defaultLaunchctl();
  // Prefer unload-then-load so reinstall refreshes the definition.
  try {
    launchctl.unload(dest, env);
  } catch (_) {
    /* ignore */
  }
  const loadResult = launchctl.load(dest, env);
  plan.loaded = !(loadResult && loadResult.status);
  if (loadResult && loadResult.status) {
    plan.ok = false;
    plan.error =
      (loadResult.stderr || loadResult.stdout || 'launchctl load failed').trim() ||
      'launchctl load failed';
  }
  return plan;
}

function uninstall(opts = {}) {
  const action = 'uninstall';
  if (!isDarwin(opts.platform || process.platform)) {
    return unsupportedResult(action);
  }

  const env = opts.env || process.env;
  const dest = opts.plistPath || plistPath(env);
  const apply = opts.apply !== false;
  const printOnly = Boolean(opts.print);
  const exists = fs.existsSync(dest);

  if (printOnly) {
    return {
      ok: true,
      supported: true,
      action,
      print: true,
      label: LABEL,
      path: dest,
      exists,
    };
  }

  const plan = {
    ok: true,
    supported: true,
    action,
    label: LABEL,
    path: dest,
    exists,
    unloaded: false,
    removed: false,
  };

  if (!apply) {
    plan.dryRun = true;
    return plan;
  }

  const launchctl = opts.launchctl || defaultLaunchctl();
  if (exists) {
    try {
      const unloadResult = launchctl.unload(dest, env);
      plan.unloaded = !(unloadResult && unloadResult.status);
      if (unloadResult && unloadResult.status) {
        plan.unloadError = (unloadResult.stderr || unloadResult.stdout || '').trim();
      }
    } catch (err) {
      plan.unloadError = err && err.message ? err.message : String(err);
    }
    try {
      fs.unlinkSync(dest);
      plan.removed = true;
    } catch (err) {
      plan.ok = false;
      plan.error = err && err.message ? err.message : String(err);
    }
  } else {
    plan.removed = false;
    plan.message = 'plist not present';
  }
  return plan;
}

function status(opts = {}) {
  const action = 'status';
  if (!isDarwin(opts.platform || process.platform)) {
    return unsupportedResult(action);
  }

  const env = opts.env || process.env;
  const dest = opts.plistPath || plistPath(env);
  const exists = fs.existsSync(dest);
  const launchctl = opts.launchctl || defaultLaunchctl();
  let listed = null;
  let loaded = false;
  let listError = null;
  try {
    const result = launchctl.list(LABEL, env);
    if (result && result.status === 0) {
      loaded = true;
      listed = (result.stdout || '').trim();
    } else {
      listError = result
        ? (result.stderr || result.stdout || '').trim()
        : 'launchctl list failed';
    }
  } catch (err) {
    listError = err && err.message ? err.message : String(err);
  }

  return {
    ok: true,
    supported: true,
    action,
    label: LABEL,
    path: dest,
    exists,
    loaded,
    listed,
    listError,
    logsDir: logsDir(env),
  };
}

module.exports = {
  LABEL,
  PLIST_BASENAME,
  packageRoot,
  afJsPath,
  launchAgentsDir,
  plistPath,
  logsDir,
  isDarwin,
  buildPlist,
  install,
  uninstall,
  status,
  escapeXml,
};
