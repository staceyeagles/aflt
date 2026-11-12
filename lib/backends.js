'use strict';

const { spawnSync } = require('child_process');
const { which, escapeShellArg, oscTitle } = require('./util');
const { buildResumeCommand, buildResumeCommandString, resolveCursorBin } = require('./cursor');

const BACKENDS = ['tmux', 'iterm2', 'wezterm', 'herdr', 'plain'];
const DEFAULT_TMUX_SESSION = 'agentfleet';

function detectBackend() {
  if (process.env.AGENTFLEET_VIA) return process.env.AGENTFLEET_VIA;
  // Inside Herdr → prefer herdr (only when hc is available)
  if (insideHerdr() && which('hc')) return 'herdr';
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

function listHerdrLive() {
  try {
    const r = spawnSync('hc', ['ls', '--json'], { encoding: 'utf8' });
    if (r.status !== 0) return [];
    return parseHerdrList(r.stdout || '');
  } catch (_) {
    return [];
  }
}

function shq(a) {
  return /^[A-Za-z0-9_\-.,/:=@%+]+$/.test(a) ? a : escapeShellArg(a);
}

function buildHerdrCommands(sessions, { live = [], resumeOpts } = {}) {
  const liveIds = new Set(live.map((t) => t.labels && t.labels.af_id).filter(Boolean));
  const taken = new Set(live.map((t) => t.name).filter(Boolean));
  return sessions.map((s) => {
    if (liveIds.has(s.id)) {
      return { title: s.title, id: s.id, skip: true, shell: `# skip ${s.title} (${s.id}): already live in herdr` };
    }
    const name = uniqueHerdrName(s.title, taken);
    const resume = buildResumeCommand(s, resumeOpts || {});
    // Clear Herdr/parent NO_COLOR and FORCE_COLOR so Cursor TUI can use color.
    // Verified hc 0.1.16: no `--` separator; env -u … is the program argv.
    const argv = [
      'hc', 'run', '--bg', '--no-parent', '--outlive-parent',
      '--name', name,
      '--cwd', s.cwd,
      '--label', `af_id=${s.id}`,
      '--label', `title=${s.title}`,
      'env', '-u', 'NO_COLOR', '-u', 'FORCE_COLOR',
      ...resume,
    ];
    return { title: s.title, id: s.id, name, cwd: s.cwd, argv, shell: argv.map(shq).join(' ') };
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
        command: buildResumeCommandString(s),
        shell: `cd ${escapeShellArg(s.cwd)} && printf '%s' ${escapeShellArg(oscTitle(s.title))} && ${buildResumeCommandString(s)}`,
      })),
    };
  }

  if (backend === 'tmux') {
    return {
      backend,
      tmuxSession: sessionName,
      commands: buildTmuxCommands(sessions, sessionName),
    };
  }

  if (backend === 'wezterm') {
    return {
      backend,
      commands: buildWezTermCommands(sessions),
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
      commands: buildITermCommands(sessions),
      applescript: buildITermAppleScript(sessions),
    };
  }

  throw new Error(`unhandled backend: ${backend}`);
}

function buildTmuxCommands(sessions, sessionName) {
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
    const resume = buildResumeCommand(s);
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

function buildWezTermCommands(sessions) {
  return sessions.map((s) => {
    const resume = buildResumeCommand(s);
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

function buildITermCommands(sessions) {
  // High-level description; actual execution uses osascript.
  return sessions.map((s) => ({
    title: s.title,
    cwd: s.cwd,
    command: buildResumeCommandString(s),
    shell: `# iTerm2 tab: ${s.title}\n# ${buildResumeCommandString(s)}`,
  }));
}

/**
 * AppleScript that opens one new tab per session in the current iTerm2 window.
 * Verified against common iTerm2 AppleScript patterns; run on macOS only.
 */
function buildITermAppleScript(sessions) {
  const lines = [];
  lines.push('tell application "iTerm"');
  lines.push('  activate');
  lines.push('  if (count of windows) = 0 then');
  lines.push('    create window with default profile');
  lines.push('  end if');
  lines.push('  tell current window');
  sessions.forEach((s, idx) => {
    const cmd = `cd ${escapeShellArg(s.cwd)} && ${buildResumeCommandString(s)}`;
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
function executeResumeAll(sessions, { via, tmuxSession, dryRun = false, resumeOpts } = {}) {
  const backend = via || detectBackend();
  const herdrLive = backend === 'herdr' ? listHerdrLive() : undefined;
  const plan = buildResumeAllPlan(sessions, { via, tmuxSession, herdrLive, resumeOpts });
  if (dryRun || plan.backend === 'plain') {
    return { ...plan, executed: false, results: [] };
  }

  const results = [];

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
      const resume = buildResumeCommand(first);
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
        results.push(tmuxNewWindow(sessionName, sessions[i]));
      }
    } else {
      for (const s of sessions) {
        results.push(tmuxNewWindow(sessionName, s));
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
    for (const item of plan.commands) {
      if (item.skip) {
        results.push({ title: item.title, skipped: true });
        continue;
      }
      const r = spawnSync(item.argv[0], item.argv.slice(1), { encoding: 'utf8' });
      results.push({ title: item.title, name: item.name, status: r.status, stdout: r.stdout, stderr: r.stderr || (r.error && r.error.message) });
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

function tmuxNewWindow(sessionName, s) {
  const resume = buildResumeCommand(s);
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
  sanitizeHerdrName,
  uniqueHerdrName,
  parseHerdrList,
  insideHerdr,
  appleScriptString,
};
