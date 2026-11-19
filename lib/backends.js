'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { which, escapeShellArg } = require('./util');
const engine = require('./engine');
const herdr = require('./herdr');
const herdrapp = require('./herdrapp');
const messages = require('./messages');

const BACKENDS = ['tmux', 'iterm2', 'wezterm', 'herdr', 'plain'];
const DEFAULT_TMUX_SESSION = 'agentfleet';

function detectBackend() {
  if (process.env.AGENTFLEET_VIA) return process.env.AGENTFLEET_VIA;
  // Inside Herdr → prefer herdr (only when hc is available)
  if (insideHerdr() && herdr.hcOnPath()) return 'herdr';
  // Inside tmux already → prefer tmux
  if (process.env.TMUX && which('tmux')) return 'tmux';
  // WezTerm sets WEZTERM_EXECUTABLE / TERM_PROGRAM
  if (process.env.TERM_PROGRAM === 'WezTerm' && which('wezterm')) return 'wezterm';
  if (process.env.WEZTERM_EXECUTABLE && which('wezterm')) return 'wezterm';
  // iTerm2
  if (process.env.TERM_PROGRAM === 'iTerm.app') return 'iterm2';
  // Fallbacks by availability (macOS-first order for Andrew)
  if (process.platform === 'darwin' && process.env.TERM_PROGRAM === 'iTerm.app') return 'iterm2';
  if (which('tmux')) return 'tmux';
  if (which('wezterm')) return 'wezterm';
  return 'plain';
}

function insideHerdr(env = process.env) {
  return Boolean(env.HERDR || env.HC_TERMINAL || env.HERDR_TERMINAL || env.HC_TERMINAL_ID || env.HERDR_SOCKET);
}

/** Herdr terminal names: 1-32 chars of [a-z0-9_-], unique among live terminals. */
function sanitizeHerdrName(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 32)
    .replace(/[-_]+$/g, '') || 'agent';
}

function uniqueHerdrName(title, taken) {
  const base = sanitizeHerdrName(title);
  let name = base;
  for (let n = 2; taken.has(name); n++) {
    const suf = `-${n}`;
    name = base.slice(0, 32 - suf.length).replace(/[-_]+$/g, '') + suf;
  }
  taken.add(name);
  return name;
}

/** Parse `hc ls --json` output; tolerant of shape and parse failure. */
function parseHerdrList(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch (_) {
    return [];
  }
  if (data && !Array.isArray(data)) data = data.terminals || data.items || data.data || [];
  if (!Array.isArray(data)) return [];
  return data
    .filter((t) => t && typeof t === 'object')
    .map((t) => {
      let labels = t.labels || {};
      if (Array.isArray(labels)) {
        const o = {};
        for (const l of labels) {
          if (typeof l === 'string' && l.includes('=')) o[l.slice(0, l.indexOf('='))] = l.slice(l.indexOf('=') + 1);
          else if (l && l.key) o[l.key] = l.value;
        }
        labels = o;
      }
      return { name: t.name || null, labels };
    });
}

/**
 * Live Herdr terminals for skip-if-already-live. Never silently returns []
 * on failure — callers must check `ok` before launching.
 * @returns {{ ok: boolean, terminals: object[], error: string|null, checkedAt?: string }}
 */
function fetchHerdrLive(opts = {}) {
  try {
    const fetched = herdr.fetchHerdrTerminals(opts);
    if (!fetched.ok) {
      return {
        ok: false,
        terminals: [],
        error: fetched.error || 'query failed',
        checkedAt: fetched.checkedAt,
      };
    }
    const terminals = (fetched.terminals || [])
      .filter((t) => herdr.isLiveTerminal(t))
      .map((t) => ({
        name: t.name || null,
        labels: {
          ...(t.labels || {}),
          ...(t.afId ? { af_id: t.afId } : {}),
        },
        address: t.address || null,
        afId: t.afId || null,
        agent: t.agent != null ? t.agent : null,
        argv: Array.isArray(t.argv) ? t.argv : null,
        foreground: t.foreground || null,
        state: t.state || null,
        reason: t.reason || null,
        exitCode: t.exitCode != null ? t.exitCode : null,
      }));
    return {
      ok: true,
      terminals,
      error: null,
      checkedAt: fetched.checkedAt,
    };
  } catch (err) {
    return {
      ok: false,
      terminals: [],
      error: err && err.message ? err.message : String(err),
    };
  }
}

/** @deprecated Prefer fetchHerdrLive; returns live terminals only when discovery ok. */
function listHerdrLive(opts = {}) {
  const r = fetchHerdrLive(opts);
  return r.ok ? r.terminals : [];
}

function shq(a) {
  return /^[A-Za-z0-9_\-.,/:=@%+]+$/.test(a) ? a : escapeShellArg(a);
}

/** Copy-pasteable Herdr attach hint for a terminal name. */
function herdrAttachLine(name) {
  return `Attach: hc attach ${shq(name)}`;
}

function resolveHcBin(env = process.env) {
  return herdr.resolveHcBin(env);
}

/**
 * Resolve the backend for a single-session `af resume <title>` (not --all).
 * Default is Herdr when `hc` is on PATH. --here / --via plain keeps the
 * in-current-terminal TUI. AGENTFLEET_VIA overrides the default:
 *   herdr → Herdr (falls back to plain + note if hc is missing)
 *   plain or any other value (tmux, iterm2, wezterm, …) → in-terminal plain
 * --all continues to use detectBackend(); do not call this for --all.
 */
function resolveSingleResumeVia(flags = {}, { env = process.env, hasHc } = {}) {
  const hcAvailable = typeof hasHc === 'boolean' ? hasHc : herdr.hcOnPath(env);
  const viaFlag = typeof flags.via === 'string' ? flags.via : undefined;
  const here = Boolean(flags.here) || viaFlag === 'plain' || viaFlag === 'here';

  if (here && viaFlag && viaFlag !== 'plain' && viaFlag !== 'here') {
    const err = new Error(`cannot combine --here with --via ${viaFlag}`);
    err.code = 'USAGE';
    throw err;
  }
  if (here) return { via: 'plain', note: null };

  if (viaFlag) {
    if (viaFlag === 'herdr') return { via: 'herdr', note: null };
    return { via: 'plain', note: null };
  }

  const pref = env.AGENTFLEET_VIA;
  if (pref && pref !== 'herdr') {
    return { via: 'plain', note: null };
  }
  if (hcAvailable) return { via: 'herdr', note: null };
  return {
    via: 'plain',
    note: 'hc not found on PATH; resuming in this terminal',
  };
}

/**
 * Parse a picker reply like "1,3", "1-3", "1 3", "all" / "a" / "*".
 * Returns 0-based unique sorted indices. Throws on invalid tokens or range.
 */
function parseResumeSelection(input, count) {
  const n = Number(count);
  if (!Number.isInteger(n) || n < 0) throw new Error('invalid selection count');
  const raw = String(input ?? '').trim();
  if (!raw) return [];
  if (/^(all|a|\*)$/i.test(raw)) {
    return Array.from({ length: n }, (_, i) => i);
  }
  const indices = new Set();
  for (const part of raw.split(/[\s,]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      let a = Number(range[1]);
      let b = Number(range[2]);
      if (a > b) [a, b] = [b, a];
      for (let i = a; i <= b; i++) {
        if (i < 1 || i > n) throw new Error(`selection out of range: ${i}`);
        indices.add(i - 1);
      }
      continue;
    }
    if (!/^\d+$/.test(part)) throw new Error(`invalid selection: ${part}`);
    const i = Number(part);
    if (i < 1 || i > n) throw new Error(`selection out of range: ${i}`);
    indices.add(i - 1);
  }
  return [...indices].sort((a, b) => a - b);
}

/**
 * Whether the user wants iTerm2 tabs opened to `hc attach`.
 * Default: yes on a macOS iTerm2 TTY. --open forces; --no-open disables.
 * Callers still no-op when osascript/iTerm is unavailable (print attach lines).
 */
function wantITermOpen(flags = {}, { env = process.env, isTTY, platform = process.platform } = {}) {
  if (flags['no-open']) return false;
  if (flags.open) return true;
  const tty = typeof isTTY === 'boolean' ? isTTY : Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return Boolean(tty && platform === 'darwin' && env.TERM_PROGRAM === 'iTerm.app');
}

function canOpenITerm({ platform = process.platform, hasOsascript } = {}) {
  if (platform !== 'darwin') return false;
  return typeof hasOsascript === 'boolean' ? hasOsascript : Boolean(which('osascript'));
}

/**
 * AppleScript: one new iTerm2 tab per Herdr terminal, running `hc attach <name>`.
 * Uses an absolute hc path so the new tab does not depend on PATH.
 */
function buildITermAttachAppleScript(entries, { hcBin } = {}) {
  const bin = hcBin || resolveHcBin();
  const items = (entries || [])
    .map((e) => (typeof e === 'string' ? { name: e, title: e } : e))
    .filter((e) => e && e.name);
  const lines = [];
  lines.push('tell application "iTerm"');
  lines.push('  activate');
  lines.push('  if (count of windows) = 0 then');
  lines.push('    create window with default profile');
  lines.push('  end if');
  lines.push('  tell current window');
  for (const item of items) {
    const cmd = `${escapeShellArg(bin)} attach ${escapeShellArg(item.name)}`;
    const title = appleScriptString(item.title || item.name);
    const command = appleScriptString(cmd);
    lines.push('    set newTab to (create tab with default profile)');
    lines.push('    tell current session of newTab');
    lines.push(`      set name to ${title}`);
    lines.push(`      write text ${command}`);
    lines.push('    end tell');
  }
  lines.push('  end tell');
  lines.push('end tell');
  return lines.join('\n') + '\n';
}

function herdrAttachEntries(plan, { executed } = {}) {
  if (!executed) {
    return (plan.commands || [])
      .filter((c) => c.name)
      .map((c) => ({ name: c.name, title: c.title || c.name }));
  }
  const entries = [];
  for (const r of plan.results || []) {
    if ((r.skipped || r.status === 0) && r.name) {
      entries.push({ name: r.name, title: r.title || r.name });
    }
  }
  return entries;
}

/**
 * Program argv prefix for Herdr launches: clear NO_COLOR/FORCE_COLOR, and if
 * the caller TERM is unset/empty/dumb, set a color-capable TERM/COLORTERM so
 * Cursor's TUI is not stuck without color when af is invoked from a non-TTY.
 * Optional envOverlay adds KEY=VAL pairs (e.g. AGENTFLEET_ID) after TERM fixes.
 * @param {NodeJS.ProcessEnv|object} [env]
 * @param {object} [envOverlay]
 * @returns {string[]} e.g. ['env','-u','NO_COLOR','-u','FORCE_COLOR', ...]
 */
function herdrEnvArgs(env = process.env, envOverlay = null) {
  const args = ['env', '-u', 'NO_COLOR', '-u', 'FORCE_COLOR'];
  const term = env && env.TERM != null ? String(env.TERM) : '';
  if (!term || term === 'dumb') {
    args.push('TERM=xterm-256color', 'COLORTERM=truecolor');
  }
  if (envOverlay && typeof envOverlay === 'object') {
    for (const [k, v] of Object.entries(envOverlay)) {
      if (v == null) continue;
      args.push(`${k}=${v}`);
    }
  }
  return args;
}

/**
 * Text typed into a live shell-only Herdr terminal to relaunch the engine.
 * POSIX shells: `cd 'folder' && <cmd>`; fish: `cd 'folder'; <cmd>`.
 */
function buildHerdrRelaunchSendText(cwd, programArgv, { shellAgent } = {}) {
  const folder = escapeShellArg(cwd);
  const cmd = (programArgv || []).map(escapeShellArg).join(' ');
  const fish = herdr.shellAgentBasename(shellAgent) === 'fish';
  if (fish) return `cd ${folder}; ${cmd}`;
  return `cd ${folder} && ${cmd}`;
}

/**
 * Normalize session cwd for Herdr launch (realpath + must exist) and build a
 * session clone so engine `-C` / `--workspace` match `--cwd` / herdr.space.
 */
function sessionForHerdrLaunch(s) {
  const cwd = herdrapp.requireSessionCwd(s && s.cwd);
  return { session: { ...s, cwd }, cwd };
}

function buildHerdrCommands(sessions, { live = [], resumeOpts } = {}) {
  const opts = resumeOpts || {};
  const appOn =
    opts.herdrApp !== undefined
      ? Boolean(opts.herdrApp)
      : herdrapp.herdrAppEnabled({}, process.env);
  const callerEnv = opts.env || process.env;
  const taken = new Set(live.map((t) => t.name).filter(Boolean));
  const sessionPool = opts.sessions || sessions;
  return sessions.map((s) => {
    const match = live.find((t) => t.labels && t.labels.af_id === s.id);
    const { session: launchSession, cwd } = sessionForHerdrLaunch(s);
    const spaceId = appOn ? herdrapp.herdrSpaceId(launchSession) : null;
    const tabId = appOn ? herdrapp.herdrTabId(launchSession) : null;
    const spaceTitle = appOn
      ? herdrapp.resolveSpaceTitle(launchSession, { sessions: sessionPool })
      : null;

    if (match) {
      const shellOnly = herdr.isShellOnlyTerminal(match);
      if (!shellOnly) {
        return {
          title: s.title,
          id: s.id,
          skip: true,
          name: match.name || undefined,
          cwd,
          herdrApp: appOn,
          tabId,
          spaceId,
          spaceTitle,
          shell: `# skip ${s.title} (${s.id}): already live in herdr`,
        };
      }
      // Shell-only: relaunch engine inside the existing tab (no hc run).
      const resume = engine.buildInteractiveCommand(launchSession, opts);
      const agentDocs = require('./agent-docs');
      const overlay = {
        ...agentDocs.sessionLaunchEnv(s, opts.envOverlay || {}),
        ...(opts.envOverlay || {}),
      };
      const program = [...herdrEnvArgs(callerEnv, overlay), ...resume];
      const address = match.address || match.name;
      if (!address) {
        throw new Error(`shell-only Herdr terminal for "${s.title}" has no address/name`);
      }
      const sendText = buildHerdrRelaunchSendText(cwd, program, { shellAgent: match.agent });
      const sendArgv = ['hc', 'send', String(address), sendText];
      return {
        title: s.title,
        id: s.id,
        relaunch: true,
        address: String(address),
        name: match.name || undefined,
        cwd,
        sendArgv,
        sendText,
        argv: sendArgv,
        shell: sendArgv.map(shq).join(' '),
        herdrApp: appOn,
        tabId,
        spaceId,
        spaceTitle,
      };
    }

    const name = uniqueHerdrName(s.title, taken);
    const resume = engine.buildInteractiveCommand(launchSession, opts);
    // Clear Herdr/parent NO_COLOR and FORCE_COLOR so Cursor TUI can use color.
    // Verified hc 0.1.16: no `--` separator; env -u … is the program argv.
    // When Herdr-app labeling is on: --keep + herdr.space / herdr.tab so the
    // desktop app shows the terminal (before the env -u … program argv).
    const argv = [
      'hc', 'run', '--bg', '--no-parent', '--outlive-parent',
      '--name', name,
      '--cwd', cwd,
      '--label', `af_id=${s.id}`,
      '--label', `title=${s.title}`,
    ];
    if (appOn) {
      argv.push('--keep');
      // Session-group space id (workers join master); not cwd-based.
      const labels = herdrapp.herdrAppLabels(launchSession);
      for (const lab of labels) {
        argv.push('--label', lab);
      }
    }
    const agentDocs = require('./agent-docs');
    const overlay = {
      ...agentDocs.sessionLaunchEnv(s, opts.envOverlay || {}),
      ...(opts.envOverlay || {}),
    };
    argv.push(...herdrEnvArgs(callerEnv, overlay), ...resume);
    return {
      title: s.title,
      id: s.id,
      name,
      cwd,
      argv,
      shell: argv.map(shq).join(' '),
      herdrApp: appOn,
      tabId,
      spaceId,
      spaceTitle,
    };
  });
}

/**
 * Build (but do not necessarily execute) commands/scripts for resume --all.
 */
function buildResumeAllPlan(sessions, { via, tmuxSession, herdrLive, resumeOpts } = {}) {
  const backend = via || detectBackend();
  if (!BACKENDS.includes(backend)) {
    throw new Error(`unknown backend: ${backend} (want one of ${BACKENDS.join(', ')})`);
  }
  const sessionName = tmuxSession || process.env.AGENTFLEET_TMUX_SESSION || DEFAULT_TMUX_SESSION;

  if (backend === 'plain') {
    return {
      backend,
      commands: sessions.map((s) => ({
        title: s.title,
        cwd: s.cwd,
        command: engine.buildInteractiveCommandString(s, resumeOpts),
        shell: `cd ${escapeShellArg(s.cwd)} && ${engine.buildInteractiveCommandString(s, resumeOpts)}`,
      })),
    };
  }

  if (backend === 'tmux') {
    return {
      backend,
      tmuxSession: sessionName,
      commands: buildTmuxCommands(sessions, sessionName, resumeOpts),
    };
  }

  if (backend === 'wezterm') {
    return {
      backend,
      commands: buildWezTermCommands(sessions, resumeOpts),
    };
  }

  if (backend === 'herdr') {
    return {
      backend,
      commands: buildHerdrCommands(sessions, { live: herdrLive || [], resumeOpts }),
    };
  }

  if (backend === 'iterm2') {
    return {
      backend,
      commands: buildITermCommands(sessions, resumeOpts),
      applescript: buildITermAppleScript(sessions, resumeOpts),
    };
  }

  throw new Error(`unhandled backend: ${backend}`);
}

function buildTmuxCommands(sessions, sessionName, resumeOpts) {
  const opts = resumeOpts || {};
  const cmds = [];
  const sn = escapeShellArg(sessionName);
  // Create session with first window, or new-session -d if missing
  cmds.push({
    kind: 'ensure-session',
    argv: ['tmux', 'has-session', '-t', sessionName],
    createArgv: [
      'tmux',
      'new-session',
      '-d',
      '-s',
      sessionName,
      '-n',
      sanitizeTmuxName(sessions[0]?.title || 'agent'),
      '-c',
      sessions[0]?.cwd || process.cwd(),
    ],
    shell: `tmux has-session -t ${sn} 2>/dev/null || tmux new-session -d -s ${sn} -n ${escapeShellArg(sanitizeTmuxName(sessions[0]?.title || 'agent'))} -c ${escapeShellArg(sessions[0]?.cwd || process.cwd())}`,
  });

  sessions.forEach((s, idx) => {
    const win = sanitizeTmuxName(s.title);
    const resume = engine.buildInteractiveCommand(s, opts);
    const bin = resume[0];
    const args = resume.slice(1);
    if (idx === 0) {
      // Rename first window and send keys if we just created, or always new-window for extras.
      // Simpler uniform approach: for idx 0, try new-window; if session was empty use send-keys.
      cmds.push({
        kind: 'window',
        title: s.title,
        argv: [
          'tmux',
          'new-window',
          '-t',
          sessionName,
          '-n',
          win,
          '-c',
          s.cwd,
          bin,
          ...args,
        ],
        // For the very first window of a brand-new session, new-window still works
        // (adds a second window). To avoid an empty first window, we also provide
        // a send-keys variant used by the executor when the session was just created.
        sendKeysArgv: [
          'tmux',
          'send-keys',
          '-t',
          `${sessionName}:0`,
          `${bin} ${args.map(escapeShellArg).join(' ')}`,
          'C-m',
        ],
        renameArgv: ['tmux', 'rename-window', '-t', `${sessionName}:0`, win],
        shell: `tmux new-window -t ${sn} -n ${escapeShellArg(win)} -c ${escapeShellArg(s.cwd)} -- ${resume.map(escapeShellArg).join(' ')}`,
      });
    } else {
      cmds.push({
        kind: 'window',
        title: s.title,
        argv: [
          'tmux',
          'new-window',
          '-t',
          sessionName,
          '-n',
          win,
          '-c',
          s.cwd,
          bin,
          ...args,
        ],
        shell: `tmux new-window -t ${sn} -n ${escapeShellArg(win)} -c ${escapeShellArg(s.cwd)} -- ${resume.map(escapeShellArg).join(' ')}`,
      });
    }
  });

  cmds.push({
    kind: 'attach-hint',
    shell: `tmux attach -t ${sn}`,
    argv: ['tmux', 'attach', '-t', sessionName],
  });

  return cmds;
}

function sanitizeTmuxName(title) {
  return String(title)
    .replace(/[^A-Za-z0-9._+-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24) || 'agent';
}

function buildWezTermCommands(sessions, resumeOpts) {
  const opts = resumeOpts || {};
  return sessions.map((s) => {
    const resume = engine.buildInteractiveCommand(s, opts);
    const spawnArgv = [
      'wezterm',
      'cli',
      'spawn',
      '--cwd',
      s.cwd,
      '--',
      ...resume,
    ];
    // set-tab-title needs the pane id from spawn; document as two-step.
    // wezterm cli spawn prints the pane id.
    const shell = [
      `pane=$(wezterm cli spawn --cwd ${escapeShellArg(s.cwd)} -- ${resume.map(escapeShellArg).join(' ')})`,
      `wezterm cli set-tab-title --pane-id "$pane" ${escapeShellArg(s.title)}`,
    ].join(' && ');
    return {
      title: s.title,
      cwd: s.cwd,
      spawnArgv,
      setTitleArgv: ['wezterm', 'cli', 'set-tab-title', /* pane filled at runtime */ s.title],
      shell,
    };
  });
}

function buildITermCommands(sessions, resumeOpts) {
  const opts = resumeOpts || {};
  // High-level description; actual execution uses osascript.
  return sessions.map((s) => ({
    title: s.title,
    cwd: s.cwd,
    command: engine.buildInteractiveCommandString(s, opts),
    shell: `# iTerm2 tab: ${s.title}\n# ${engine.buildInteractiveCommandString(s, opts)}`,
  }));
}

/**
 * AppleScript that opens one new tab per session in the current iTerm2 window.
 * Verified against common iTerm2 AppleScript patterns; run on macOS only.
 */
function buildITermAppleScript(sessions, resumeOpts) {
  const opts = resumeOpts || {};
  const lines = [];
  lines.push('tell application "iTerm"');
  lines.push('  activate');
  lines.push('  if (count of windows) = 0 then');
  lines.push('    create window with default profile');
  lines.push('  end if');
  lines.push('  tell current window');
  sessions.forEach((s, idx) => {
    const cmd = `cd ${escapeShellArg(s.cwd)} && ${engine.buildInteractiveCommandString(s, opts)}`;
    const title = appleScriptString(s.title);
    const command = appleScriptString(cmd);
    if (idx === 0) {
      // Reuse current tab for the first session, or always create new tabs —
      // create a new tab for every session so existing work isn't clobbered.
    }
    lines.push('    set newTab to (create tab with default profile)');
    lines.push('    tell current session of newTab');
    lines.push(`      set name to ${title}`);
    lines.push(`      write text ${command}`);
    lines.push('    end tell');
  });
  lines.push('  end tell');
  lines.push('end tell');
  return lines.join('\n') + '\n';
}

function appleScriptString(s) {
  // AppleScript quoted string with backslash and quote escapes
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * Execute resume --all for a backend. Returns { backend, results }.
 * For plain: does not run, only returns commands.
 * dryRun: never execute, only return the plan.
 */
function executeResumeAll(sessions, { via, tmuxSession, dryRun = false, resumeOpts, herdrLive, skipDiscovery = false } = {}) {
  const backend = via || detectBackend();
  let discovery = null;
  let live = herdrLive;
  if (backend === 'herdr' && live === undefined && !skipDiscovery) {
    discovery = fetchHerdrLive();
    if (!discovery.ok) {
      return {
        backend: 'herdr',
        commands: [],
        executed: false,
        results: [],
        discoveryOk: false,
        discoveryError: discovery.error || 'query failed',
      };
    }
    live = discovery.terminals;
  }
  const plan = buildResumeAllPlan(sessions, { via, tmuxSession, herdrLive: live || [], resumeOpts });
  if (discovery) {
    plan.discoveryOk = true;
    plan.discoveryError = null;
  }
  if (dryRun || plan.backend === 'plain') {
    return { ...plan, executed: false, results: [], discoveryOk: discovery ? true : plan.discoveryOk, discoveryError: discovery ? null : plan.discoveryError };
  }

  const results = [];
  const opts = resumeOpts || {};

  if (plan.backend === 'tmux') {
    const sessionName = plan.tmuxSession;
    const has = spawnSync('tmux', ['has-session', '-t', sessionName], { encoding: 'utf8' });
    let created = false;
    if (has.status !== 0) {
      const first = sessions[0];
      const create = spawnSync(
        'tmux',
        [
          'new-session',
          '-d',
          '-s',
          sessionName,
          '-n',
          sanitizeTmuxName(first.title),
          '-c',
          first.cwd,
        ],
        { encoding: 'utf8' }
      );
      results.push({ step: 'new-session', status: create.status, stderr: create.stderr });
      if (create.status !== 0) {
        throw new Error(`tmux new-session failed: ${create.stderr || create.stdout}`);
      }
      created = true;
      // Launch first agent in window 0
      const resume = engine.buildInteractiveCommand(first, opts);
      const send = spawnSync(
        'tmux',
        [
          'send-keys',
          '-t',
          `${sessionName}:0`,
          resume.map(escapeShellArg).join(' '),
          'C-m',
        ],
        { encoding: 'utf8' }
      );
      results.push({ step: `send-keys:${first.title}`, status: send.status, stderr: send.stderr });
      // Remaining sessions as new windows
      for (let i = 1; i < sessions.length; i++) {
        results.push(tmuxNewWindow(sessionName, sessions[i], opts));
      }
    } else {
      for (const s of sessions) {
        results.push(tmuxNewWindow(sessionName, s, opts));
      }
    }
    results.push({
      step: 'attach-hint',
      message: `tmux attach -t ${sessionName}`,
      created,
    });
    return { ...plan, executed: true, results };
  }

  if (plan.backend === 'wezterm') {
    for (const item of plan.commands) {
      const r = spawnSync(item.spawnArgv[0], item.spawnArgv.slice(1), { encoding: 'utf8' });
      const paneId = (r.stdout || '').trim();
      let titleStatus = null;
      if (r.status === 0 && paneId) {
        const t = spawnSync(
          'wezterm',
          ['cli', 'set-tab-title', '--pane-id', paneId, item.title],
          { encoding: 'utf8' }
        );
        titleStatus = t.status;
      }
      results.push({
        title: item.title,
        status: r.status,
        paneId,
        titleStatus,
        stderr: r.stderr,
      });
    }
    return { ...plan, executed: true, results };
  }

  if (plan.backend === 'herdr') {
    const nameOpts = (resumeOpts && resumeOpts.herdrAppOpts) || {};
    for (const item of plan.commands) {
      if (item.skip) {
        results.push({
          title: item.title,
          name: item.name,
          id: item.id,
          skipped: true,
          tabId: item.tabId,
          spaceId: item.spaceId,
          herdrApp: item.herdrApp,
        });
        continue;
      }
      if (item.relaunch) {
        const sendBin =
          item.sendArgv[0] === 'hc' ? resolveHcBin() : item.sendArgv[0];
        const r = spawnSync(sendBin, item.sendArgv.slice(1), { encoding: 'utf8' });
        let tabRename = null;
        let spaceRename = null;
        if (r.status === 0 && item.herdrApp && (item.tabId || item.spaceId)) {
          // Relaunch stays in the existing pane; wait/rename best-effort.
          const named = herdrapp.nameHerdrAppViews(
            {
              spaceId: item.spaceId,
              spaceTitle: item.spaceTitle || item.title,
              tabId: item.tabId,
              tabTitle: item.title,
            },
            { ...nameOpts, waitForSpace: true }
          );
          tabRename = named.tabRename;
          spaceRename = named.spaceRename;
        }
        results.push({
          title: item.title,
          name: item.name,
          id: item.id,
          relaunch: true,
          address: item.address,
          status: r.status,
          stdout: r.stdout,
          stderr: r.stderr || (r.error && r.error.message),
          tabId: item.tabId,
          spaceId: item.spaceId,
          herdrApp: item.herdrApp,
          tabRename,
          spaceRename,
        });
        continue;
      }
      const runBin = item.argv[0] === 'hc' ? resolveHcBin() : item.argv[0];
      const r = spawnSync(runBin, item.argv.slice(1), { encoding: 'utf8' });
      let tabRename = null;
      let spaceRename = null;
      if (r.status === 0 && item.herdrApp && (item.tabId || item.spaceId)) {
        // Fresh hc run: app adopts into a new space named after the folder until
        // we wait for that space id then space.rename + tab.rename.
        const named = herdrapp.nameHerdrAppViews(
          {
            spaceId: item.spaceId,
            spaceTitle: item.spaceTitle || item.title,
            tabId: item.tabId,
            tabTitle: item.title,
          },
          { ...nameOpts, waitForSpace: true }
        );
        tabRename = named.tabRename;
        spaceRename = named.spaceRename;
      }
      results.push({
        title: item.title,
        name: item.name,
        id: item.id,
        status: r.status,
        stdout: r.stdout,
        stderr: r.stderr || (r.error && r.error.message),
        tabId: item.tabId,
        spaceId: item.spaceId,
        herdrApp: item.herdrApp,
        tabRename,
        spaceRename,
      });
    }
    return { ...plan, executed: true, results };
  }

  if (plan.backend === 'iterm2') {
    if (process.platform !== 'darwin') {
      throw new Error('iterm2 backend requires macOS (osascript)');
    }
    const script = plan.applescript;
    const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
    results.push({ status: r.status, stdout: r.stdout, stderr: r.stderr });
    if (r.status !== 0) {
      throw new Error(`osascript failed: ${r.stderr || r.stdout}`);
    }
    return { ...plan, executed: true, results };
  }

  return { ...plan, executed: false, results };
}

function tmuxNewWindow(sessionName, s, resumeOpts) {
  const resume = engine.buildInteractiveCommand(s, resumeOpts || {});
  const r = spawnSync(
    'tmux',
    [
      'new-window',
      '-t',
      sessionName,
      '-n',
      sanitizeTmuxName(s.title),
      '-c',
      s.cwd,
      ...resume,
    ],
    { encoding: 'utf8' }
  );
  return {
    step: `new-window:${s.title}`,
    status: r.status,
    stderr: r.stderr,
    argv: ['tmux', 'new-window', '-t', sessionName, '-n', sanitizeTmuxName(s.title), '-c', s.cwd, ...resume],
  };
}

module.exports = {
  BACKENDS,
  DEFAULT_TMUX_SESSION,
  detectBackend,
  buildResumeAllPlan,
  buildTmuxCommands,
  buildWezTermCommands,
  buildITermAppleScript,
  executeResumeAll,
  sanitizeTmuxName,
  buildHerdrCommands,
  buildHerdrRelaunchSendText,
  sessionForHerdrLaunch,
  herdrEnvArgs,
  herdrAttachLine,
  resolveHcBin,
  resolveSingleResumeVia,
  parseResumeSelection,
  wantITermOpen,
  canOpenITerm,
  buildITermAttachAppleScript,
  herdrAttachEntries,
  sanitizeHerdrName,
  uniqueHerdrName,
  parseHerdrList,
  fetchHerdrLive,
  listHerdrLive,
  insideHerdr,
  appleScriptString,
};
