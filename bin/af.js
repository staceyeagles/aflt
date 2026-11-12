#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const registry = require('../lib/registry');
const cursor = require('../lib/cursor');
const copilot = require('../lib/copilot');
const backends = require('../lib/backends');
const runlib = require('../lib/run');
const herdr = require('../lib/herdr');
const herdrapp = require('../lib/herdrapp');
const {
  parseArgs,
  resolveCwd,
  gitBranch,
  nowIso,
  shortId,
  pad,
  oscTitle,
  fleetDir,
  registryPath,
} = require('../lib/util');

const USAGE = `agentfleet (af) — track & resume Cursor CLI agent sessions

Usage:
  af new "<title>" [--cwd DIR] [--prompt "..."] [--model X] [--tag T]... [--dry-run]
  af add "<title>" --chat <id> [--cwd DIR] [--model X] [--tag T]... [--prompt "..."]
  af import                 List recent chats from ~/.cursor/chats for registration
  af ls [--status S] [--tag T] [--all] [--json]
                            STATUS is lifecycle; HERDR is live runtime (running|exited|missing|unknown|-)
  af sync [--dry-run] [--json]
                            Persist last-known Herdr runtime evidence (does not change status/lastUsed)
  af run "<title>" --prompt "..." [--cwd DIR] [--model X] [--engine cursor|copilot]
                            [--mode ask|plan] [--force] [--output-format text|json]
                            [--timeout SEC] [--dry-run]
                            Headless one-shot: create or resume, capture output, exit
  af run <title|id> --prompt "..." [...]
                            Same, resuming an existing tracked session
  af log <title|id> [--path]  Print last captured run output (or its path)
  af resume <title|id> [--via herdr|plain] [--here] [--open|--no-open]
                            [--prompt "..."] [--dry-run] [--no-herdr-app]
                            Resume one session. Default: Herdr when hc is on PATH
                            (prints Attach: hc attach <name>). --here / --via plain:
                            this terminal. --open: new iTerm2 tab running hc attach
                            (default in an iTerm TTY; --no-open disables).
                            Herdr launches also label herdr.space / herdr.tab (and
                            --keep) so the desktop app shows the tab; --no-herdr-app
                            disables that.
  af resume | af resume -i | af pick
                            Interactive multi-select (TTY only); resume via Herdr
  af resume --all [--tag T] [--via tmux|iterm2|wezterm|herdr|plain]
                            [--open|--no-open] [--dry-run] [--no-herdr-app]
  af adopt <title|id ...> | af adopt --all [--dry-run] [--json]
                            Label live af Herdr terminals with herdr.space/tab +
                            enable keep so they appear in the Herdr desktop app
  af rename <title|id> "<new title>"
  af done <title|id>
  af rm <title|id>
  af note <title|id> "<text>"
  af export [file]          Write registry JSON (default: stdout)
  af import-file <file>     Merge sessions from a backup file
  af which-backend          Show auto-detected resume --all backend
  af herdr-templates [--force]
                            Install Cursor/OpenCode templates into ~/.config/herdr-core/templates
  af herdr-app install [--copy] [--force] [--dry-run]
                            Symlink (default) or copy the af-sessions Herdr panel
                            + af layout into ~/.config/herdr-app (or $HERDR_APP_HOME)
  af herdr-app status       Report linked/copied/missing for the panel + layout
  af help

Environment:
  AGENTFLEET_HOME         Registry dir (default: ~/.agentfleet)
  AGENTFLEET_REGISTRY     Override sessions.json path
  AGENTFLEET_CURSOR_BIN   Override cursor-agent binary
  AGENTFLEET_VIA          Default --via backend (resume --all; also overrides
                            single-session default: herdr vs plain)
  AGENTFLEET_TMUX_SESSION tmux session name (default: agentfleet)
  AGENTFLEET_HERDR_APP    Set to 0/false/off/no to skip herdr.space/tab labels
  AGENTFLEET_HERDR_APP_BIN Override herdr-app binary (default: herdr-app on PATH)
  HERDR_APP_HOME          Herdr app config dir (default: ~/.config/herdr-app)
`;

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help' || argv[0] === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  switch (cmd) {
    case 'new':
      await cmdNew(rest);
      break;
    case 'run':
      await cmdRun(rest);
      break;
    case 'log':
      cmdLog(rest);
      break;
    case 'herdr-templates':
      cmdHerdrTemplates(rest);
      break;
    case 'herdr-app':
      cmdHerdrApp(rest);
      break;
    case 'add':
      cmdAdd(rest);
      break;
    case 'import':
      cmdImport(rest);
      break;
    case 'ls':
    case 'list':
      cmdLs(rest);
      break;
    case 'sync':
      cmdSync(rest);
      break;
    case 'adopt':
      cmdAdopt(rest);
      break;
    case 'resume':
      await cmdResume(rest);
      break;
    case 'pick':
      await cmdResume(['-i', ...rest]);
      break;
    case 'rename':
      cmdRename(rest);
      break;
    case 'done':
      cmdDone(rest);
      break;
    case 'rm':
    case 'remove':
      cmdRm(rest);
      break;
    case 'note':
      cmdNote(rest);
      break;
    case 'export':
      cmdExport(rest);
      break;
    case 'import-file':
      cmdImportFile(rest);
      break;
    case 'which-backend':
      process.stdout.write(backends.detectBackend() + '\n');
      break;
    default:
      fail(`unknown command: ${cmd}\n\n${USAGE}`);
  }
}

async function cmdNew(argv) {
  const { args, flags } = parseArgs(argv);
  const title = args[0];
  if (!title) fail('usage: af new "<title>" [--cwd DIR] [--prompt "..."] [--model X]');

  const cwd = resolveCwd(flags.cwd || flags.C);
  const prompt = flags.prompt || '';
  const model = flags.model || null;
  const tags = collectTags(flags);
  const dryRun = Boolean(flags['dry-run']);

  let chatId;
  if (dryRun) {
    chatId = '00000000-0000-4000-8000-000000000000';
    process.stderr.write(`[dry-run] would run: ${cursor.resolveCursorBin()} create-chat\n`);
  } else {
    process.stderr.write(`Creating chat via ${cursor.resolveCursorBin()} create-chat…\n`);
    chatId = await cursor.createChat();
  }

  const entry = {
    title,
    chatId,
    cwd,
    branch: gitBranch(cwd),
    model,
    prompt,
    tags,
    status: 'active',
  };

  if (dryRun) {
    process.stderr.write(`[dry-run] would register: ${JSON.stringify(entry, null, 2)}\n`);
    const cmd = cursor.buildResumeCommandString({ ...entry, chatId }, { prompt });
    process.stdout.write(`cd ${JSON.stringify(cwd)} && ${cmd}\n`);
    return;
  }

  const saved = registry.add(entry);
  printSession(saved, 'registered');

  // Set tab title then exec into interactive resume
  try {
    process.stdout.write(oscTitle(saved.title));
  } catch (_) {
    /* ignore */
  }

  const resumeArgs = cursor.buildResumeArgs(saved, { prompt: prompt || undefined, trust: !flags['no-trust'] });
  // If a prompt was stored, pass it only on first launch
  const { code } = await cursor.spawnCursorInteractive(resumeArgs, { cwd });
  registry.touch(saved.id);
  process.exitCode = code || 0;
}

function cmdAdd(argv) {
  const { args, flags } = parseArgs(argv);
  const title = args[0];
  const chatId = flags.chat || flags.c;
  if (!title || !chatId) fail('usage: af add "<title>" --chat <id> [--cwd DIR]');

  const cwd = resolveCwd(flags.cwd || flags.C);
  const saved = registry.add({
    title,
    chatId: String(chatId),
    cwd,
    branch: gitBranch(cwd),
    model: flags.model || null,
    prompt: flags.prompt || '',
    tags: collectTags(flags),
    status: 'active',
  });
  printSession(saved, 'added');
}

function cmdImport() {
  process.stdout.write(
    'Note: `cursor-agent ls` is interactive-only (no --print/--output-format).\n' +
      'Scanning local store ~/.cursor/chats/ instead.\n\n'
  );
  const chats = cursor.listLocalChats({ limit: 40 });
  if (chats.length === 0) {
    process.stdout.write(
      'No chats found under ~/.cursor/chats/.\n' +
        'Tips:\n' +
        '  • create-chat alone may not write files until a prompt is sent\n' +
        '  • use: af add "<title>" --chat <id> --cwd <dir>\n' +
        '  • or:  af new "<title>" to create + register in one step\n'
    );
    return;
  }
  const existing = new Set(registry.list().map((s) => s.chatId));
  process.stdout.write(
    `${pad('CHAT ID', 38)} ${pad('CWD', 40)} ${pad('MTIME', 20)} REG?\n`
  );
  for (const c of chats) {
    const reg = existing.has(c.chatId) ? 'yes' : 'no';
    const when = c.mtime ? new Date(c.mtime).toISOString() : '';
    process.stdout.write(
      `${pad(c.chatId, 38)} ${pad(c.cwd || '(unknown)', 40)} ${pad(when, 20)} ${reg}\n`
    );
  }
  process.stdout.write(
    `\nRegister one with:\n  af add "<title>" --chat <chatId> --cwd <dir>\n`
  );
}

function cmdLs(argv) {
  const { flags } = parseArgs(argv);
  const opts = {};
  if (flags.status) opts.status = flags.status;
  if (flags.tag) opts.tag = flags.tag;
  if (!flags.all && !flags.status) opts.includeDone = false;

  const sessions = registry.list(opts);
  if (sessions.length === 0 && !flags.json) {
    process.stdout.write('(no sessions)\n');
    return;
  }

  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    process.stderr.write(`herdr: ${fetchResult.error || 'query failed'} (showing unknown/-)\n`);
  }
  const enriched = herdr.enrichSessions(sessions, fetchResult);

  if (flags.json) {
    const rows = enriched.map((e) => ({
      id: e.session.id,
      title: e.session.title,
      chatId: e.session.chatId,
      engine: e.session.engine || 'cursor',
      cwd: e.session.cwd,
      branch: e.session.branch || null,
      status: e.session.status,
      lastUsed: e.session.lastUsed || null,
      herdr: {
        runtime: herdr.displayRuntime(e.runtime),
        address: e.address,
        name: e.name,
        exitCode: e.exitCode,
        reason: e.reason,
        checkedAt: e.checkedAt,
      },
      herdrApp: {
        space: herdrapp.herdrSpaceId(e.session.cwd),
        tab: herdrapp.herdrTabId(e.session),
      },
    }));
    process.stdout.write(JSON.stringify({ sessions: rows, queryOk: Boolean(fetchResult.ok) }, null, 2) + '\n');
    return;
  }

  process.stdout.write(
    `${pad('TITLE', 24)} ${pad('ID', 10)} ${pad('CHAT', 10)} ${pad('ENGINE', 8)} ${pad('FOLDER', 24)} ${pad('BRANCH', 12)} ${pad('STATUS', 8)} ${pad('HERDR', 8)} LAST USED\n`
  );
  for (const e of enriched) {
    const s = e.session;
    const folder = s.cwd ? path.basename(s.cwd) : '';
    process.stdout.write(
      `${pad(s.title, 24)} ${pad(shortId(s.id), 10)} ${pad(shortId(s.chatId), 10)} ${pad(s.engine || 'cursor', 8)} ${pad(folder, 24)} ${pad(s.branch || '', 12)} ${pad(s.status, 8)} ${pad(herdr.displayRuntime(e.runtime), 8)} ${s.lastUsed || ''}\n`
    );
  }
}

function backupRegistryPath() {
  // YYYYMMDDTHHMMSSZ
  const compact = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const dir = path.dirname(registryPath());
  let candidate = path.join(dir, `sessions.json.bak-${compact}`);
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `sessions.json.bak-${compact}-${n}`);
    n++;
  }
  return candidate;
}

function cmdSync(argv) {
  const { flags } = parseArgs(argv);
  const dryRun = Boolean(flags['dry-run']);
  const asJson = Boolean(flags.json);

  const sessions = registry.list({ includeDone: true });
  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    process.stderr.write(`herdr sync failed: ${fetchResult.error || 'query failed'}\n`);
    process.exitCode = 1;
    if (asJson) {
      process.stdout.write(JSON.stringify({ ok: false, error: fetchResult.error, dryRun, updated: [] }, null, 2) + '\n');
    }
    return;
  }

  const enriched = herdr.enrichSessions(sessions, fetchResult);
  const toPersist = enriched.filter((e) => e.persistable);

  if (!dryRun && toPersist.length > 0) {
    const bak = backupRegistryPath();
    fs.mkdirSync(path.dirname(bak), { recursive: true });
    fs.copyFileSync(registryPath(), bak);
    process.stderr.write(`backup: ${bak}\n`);
    for (const e of toPersist) {
      registry.update(e.session.id, { herdr: herdr.herdrEvidence(e) });
    }
  }

  const rows = toPersist.map((e) => ({
    title: e.session.title,
    id: e.session.id,
    runtime: e.runtime,
    address: e.address,
    name: e.name,
    exitCode: e.exitCode,
    reason: e.reason,
    status: e.session.status,
    lastUsed: e.session.lastUsed,
    checkedAt: e.checkedAt,
  }));

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          ok: true,
          dryRun,
          checkedAt: fetchResult.checkedAt,
          updated: rows,
        },
        null,
        2
      ) + '\n'
    );
    return;
  }

  if (rows.length === 0) {
    process.stdout.write(dryRun ? '(nothing would be persisted)\n' : '(nothing to sync)\n');
    return;
  }

  process.stdout.write(
    `${dryRun ? '[dry-run] would persist' : 'synced'} ${rows.length} session${rows.length === 1 ? '' : 's'}:\n`
  );
  for (const r of rows) {
    const where = r.address || r.name || '-';
    const exit =
      r.runtime === 'exited' && (r.exitCode != null || r.reason)
        ? ` exit=${r.exitCode != null ? r.exitCode : '?'} reason=${r.reason || '?'}`
        : '';
    process.stdout.write(
      `  ${r.title} (${shortId(r.id)})  ${r.runtime}  ${where}${exit}\n`
    );
  }
}

async function cmdResume(argv) {
  const { args, flags } = parseArgs(argv);
  if (flags.all) {
    await cmdResumeAll(flags);
    return;
  }

  const pick = Boolean(flags.i || flags.interactive || flags.pick);
  if (pick || args.length === 0) {
    await cmdResumePick(flags);
    return;
  }

  const query = args[0];
  if (!query) fail('usage: af resume <title|id>  OR  af resume --all [--via …]');

  const session = registry.find(query);
  if (!session) fail(`session not found: ${query}`);

  // Resume restores chat context via --resume; do not resend session.prompt.
  // An explicit --prompt on this invocation may still be passed.
  const resumeOpts = buildResumeOpts(flags);

  let resolved;
  try {
    resolved = backends.resolveSingleResumeVia(flags);
  } catch (err) {
    fail(err.message);
  }
  if (resolved.note) process.stderr.write(`${resolved.note}\n`);

  if (resolved.via === 'herdr') {
    const plan = backends.executeResumeAll([session], {
      via: 'herdr',
      dryRun: Boolean(flags['dry-run']),
      resumeOpts,
    });
    reportHerdr(plan, flags);
    return;
  }

  try {
    process.stdout.write(oscTitle(session.title));
  } catch (_) {
    /* ignore */
  }

  process.stderr.write(
    `Resuming "${session.title}" (${shortId(session.chatId)}) in ${session.cwd}\n`
  );
  registry.touch(session.id);
  const resumeArgs = cursor.buildResumeArgs(session, resumeOpts);
  if (flags['dry-run']) {
    process.stdout.write(
      `cd ${JSON.stringify(session.cwd)} && ${cursor.buildResumeCommandString(session, resumeOpts)}\n`
    );
    return;
  }
  const { code } = await cursor.spawnCursorInteractive(resumeArgs, { cwd: session.cwd });
  process.exitCode = code || 0;
}

function buildResumeOpts(flags = {}) {
  const resumeOpts = {
    trust: !flags['no-trust'],
    herdrApp: herdrapp.herdrAppEnabled(flags),
  };
  if (typeof flags.prompt === 'string' && flags.prompt) resumeOpts.prompt = flags.prompt;
  return resumeOpts;
}

async function cmdResumeAll(flags) {
  const via = flags.via || undefined;
  const tag = flags.tag || undefined;
  const dryRun = Boolean(flags['dry-run']);
  let sessions = registry.list({ status: 'active', tag });
  if (sessions.length === 0) {
    process.stdout.write('No active sessions to resume.\n');
    return;
  }

  const plan = backends.executeResumeAll(sessions, {
    via,
    tmuxSession: flags['tmux-session'],
    dryRun: dryRun || (via || backends.detectBackend()) === 'plain',
    resumeOpts: buildResumeOpts(flags),
  });

  process.stderr.write(
    `resume --all via ${plan.backend} (${sessions.length} session${sessions.length === 1 ? '' : 's'})${dryRun || !plan.executed ? ' [dry]' : ''}\n`
  );

  if (plan.backend === 'herdr') {
    reportHerdr(plan, { ...flags, 'dry-run': dryRun || !plan.executed });
    return;
  }

  if (plan.backend === 'plain' || dryRun) {
    if (plan.backend === 'iterm2' && plan.applescript) {
      process.stdout.write('# AppleScript:\n');
      process.stdout.write(plan.applescript);
      process.stdout.write('\n# Or per-session:\n');
    }
    for (const c of plan.commands) {
      if (c.shell) process.stdout.write(c.shell + '\n');
      else if (c.command) process.stdout.write(c.command + '\n');
    }
    if (plan.backend === 'tmux') {
      const attach = plan.commands.find((c) => c.kind === 'attach-hint');
      if (attach) process.stdout.write(`# then: ${attach.shell}\n`);
    }
    return;
  }

  // Mark lastUsed
  for (const s of sessions) {
    try {
      registry.touch(s.id);
    } catch (_) {
      /* ignore */
    }
  }

  if (plan.backend === 'tmux') {
    const hint = (plan.results || []).find((r) => r.step === 'attach-hint');
    process.stdout.write(
      `Opened ${sessions.length} window(s) in tmux session "${plan.tmuxSession}".\n` +
        `Attach with: tmux attach -t ${plan.tmuxSession}\n`
    );
    if (hint?.message) process.stderr.write(`${hint.message}\n`);
  } else if (plan.backend === 'wezterm') {
    process.stdout.write(`Spawned ${sessions.length} WezTerm tab(s).\n`);
  } else if (plan.backend === 'iterm2') {
    process.stdout.write(`Opened ${sessions.length} iTerm2 tab(s).\n`);
  }
}

function reportHerdr(plan, flags = {}) {
  const dryRun = Boolean(flags['dry-run'] || flags.dryRun) || !plan.executed;
  if (dryRun || !plan.executed) {
    for (const c of plan.commands) {
      process.stdout.write(c.shell + '\n');
      if (c.name) process.stdout.write(backends.herdrAttachLine(c.name) + '\n');
    }
    maybeOpenITermAttach(plan, flags, { executed: false, dryRun: true });
    return;
  }
  let ok = 0;
  for (const r of plan.results) {
    if (r.skipped) {
      process.stderr.write(`skip "${r.title}": already live in herdr\n`);
      if (r.name) process.stdout.write(backends.herdrAttachLine(r.name) + '\n');
    } else if (r.status === 0) {
      ok++;
      try { registry.touch(plan.commands.find((c) => c.title === r.title).id); } catch (_) { /* ignore */ }
      if (r.name) process.stdout.write(backends.herdrAttachLine(r.name) + '\n');
    } else process.stderr.write(`hc run failed for "${r.title}": ${r.stderr || ''}\n`);
  }
  process.stdout.write(`Launched ${ok} Herdr terminal(s).\n`);
  maybeOpenITermAttach(plan, flags, { executed: true, dryRun: false });
  if (plan.results.some((r) => !r.skipped && r.status !== 0)) process.exitCode = 1;
}

function maybeOpenITermAttach(plan, flags, { executed, dryRun }) {
  if (!backends.wantITermOpen(flags)) return;
  const entries = backends.herdrAttachEntries(plan, { executed });
  if (entries.length === 0) return;
  const script = backends.buildITermAttachAppleScript(entries);
  if (dryRun) {
    process.stdout.write('# would open iTerm2 tab(s) running hc attach (absolute hc path):\n');
    process.stdout.write(script);
    return;
  }
  if (!backends.canOpenITerm()) {
    process.stderr.write('iTerm/osascript unavailable; printed attach commands instead\n');
    return;
  }
  const { spawnSync } = require('child_process');
  const r = spawnSync('osascript', ['-e', script], { encoding: 'utf8' });
  if (r.status !== 0) {
    process.stderr.write(`osascript failed; printed attach commands instead: ${r.stderr || r.stdout || ''}\n`);
  } else {
    process.stdout.write(`Opened ${entries.length} iTerm2 tab(s).\n`);
  }
}

async function cmdResumePick(flags) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    fail(
      'usage: af resume <title|id>  OR  af resume --all [--via …]\n' +
        'interactive selection requires a TTY (or pass a title / --all)'
    );
  }

  let resolved;
  try {
    resolved = backends.resolveSingleResumeVia({ ...flags, here: false, via: flags.via });
  } catch (err) {
    fail(err.message);
  }
  // Picker always uses the Herdr path (skip if already live, print attach lines).
  if (flags.here || flags.via === 'plain' || flags.via === 'here') {
    fail('interactive resume uses Herdr; drop --here / --via plain, or resume one title with --here');
  }
  if (resolved.via !== 'herdr') {
    fail('interactive resume requires Herdr (hc on PATH); use af resume <title> --here for this terminal');
  }

  const sessions = registry.list({ status: 'active', tag: flags.tag });
  if (sessions.length === 0) {
    process.stdout.write('No active sessions to resume.\n');
    return;
  }

  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    process.stderr.write(`herdr: ${fetchResult.error || 'query failed'} (showing unknown/-)\n`);
  }
  const enriched = herdr.enrichSessions(sessions, fetchResult);

  process.stdout.write(
    `    ${pad('#', 3)} ${pad('TITLE', 24)} ${pad('FOLDER', 24)} ${pad('HERDR', 8)} LAST USED\n`
  );
  enriched.forEach((e, i) => {
    const s = e.session;
    const folder = s.cwd ? path.basename(s.cwd) : '';
    process.stdout.write(
      `    ${pad(String(i + 1), 3)} ${pad(s.title, 24)} ${pad(folder, 24)} ${pad(herdr.displayRuntime(e.runtime), 8)} ${s.lastUsed || ''}\n`
    );
  });

  const readline = require('readline/promises');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let answer;
  try {
    answer = await rl.question('Select sessions (e.g. 1,3 or 1-3; a = all): ');
  } finally {
    rl.close();
  }

  let indexes;
  try {
    indexes = backends.parseResumeSelection(answer, sessions.length);
  } catch (err) {
    fail(err.message);
  }
  const selected = indexes.map((i) => sessions[i]);
  if (selected.length === 0) {
    process.stdout.write('No sessions selected.\n');
    return;
  }

  const resumeOpts = buildResumeOpts(flags);
  const plan = backends.executeResumeAll(selected, {
    via: 'herdr',
    dryRun: Boolean(flags['dry-run']),
    resumeOpts,
  });
  reportHerdr(plan, flags);
}

function cmdAdopt(argv) {
  const { args, flags } = parseArgs(argv);
  const dryRun = Boolean(flags['dry-run']);
  const asJson = Boolean(flags.json);
  const all = Boolean(flags.all);

  if (!all && args.length === 0) {
    fail('usage: af adopt <title|id ...> | af adopt --all [--dry-run] [--json]');
  }

  let sessions;
  if (all) {
    sessions = registry.list({ includeDone: true });
  } else {
    sessions = [];
    const seen = new Set();
    for (const q of args) {
      let s;
      try {
        s = registry.find(q);
      } catch (err) {
        fail(err.message);
      }
      if (!s) fail(`session not found: ${q}`);
      if (!seen.has(s.id)) {
        seen.add(s.id);
        sessions.push(s);
      }
    }
  }

  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    fail(`herdr adopt failed: ${fetchResult.error || 'query failed'}`);
  }

  const plan = herdrapp.planAdopt(sessions, fetchResult.terminals || []);
  if (!plan.ok) fail(plan.error || 'adopt failed');

  if (plan.items.length === 0) {
    if (asJson) {
      process.stdout.write(JSON.stringify({ ok: true, dryRun, adopted: [] }, null, 2) + '\n');
      return;
    }
    process.stdout.write('(no live af Herdr terminals to adopt)\n');
    return;
  }

  const { spawnSync } = require('child_process');
  const rows = [];
  for (const item of plan.items) {
    const row = {
      title: item.title,
      id: item.id,
      address: item.address,
      name: item.name,
      spaceId: item.spaceId,
      tabId: item.tabId,
      alreadyAdopted: item.alreadyAdopted,
      labeled: false,
      kept: false,
      renamed: false,
    };

    if (item.alreadyAdopted) {
      if (!dryRun) {
        const renamed = herdrapp.nameHerdrAppTab(item.tabId, item.title);
        row.renamed = Boolean(renamed && renamed.ok);
      }
      rows.push(row);
      if (!asJson) {
        process.stdout.write(
          `already adopted  ${item.address}  ${item.title}  ${item.spaceId}  ${item.tabId}\n`
        );
      }
      continue;
    }

    if (dryRun) {
      rows.push(row);
      if (!asJson) {
        process.stdout.write(
          `[dry-run] adopt  ${item.address}  ${item.title}  ${item.spaceId}  ${item.tabId}\n`
        );
        process.stdout.write(`  hc ${item.labelArgv.join(' ')}\n`);
        process.stdout.write(`  hc ${item.keepArgv.join(' ')}\n`);
      }
      continue;
    }

    const lab = spawnSync('hc', item.labelArgv, { encoding: 'utf8' });
    const kep = spawnSync('hc', item.keepArgv, { encoding: 'utf8' });
    row.labeled = lab.status === 0;
    row.kept = kep.status === 0;
    if (lab.status !== 0) {
      process.stderr.write(
        `hc label failed for ${item.address}: ${lab.stderr || lab.stdout || ''}\n`
      );
    }
    if (kep.status !== 0) {
      process.stderr.write(
        `hc keep failed for ${item.address}: ${kep.stderr || kep.stdout || ''}\n`
      );
    }
    const renamed = herdrapp.nameHerdrAppTab(item.tabId, item.title);
    row.renamed = Boolean(renamed && renamed.ok);
    rows.push(row);
    if (!asJson) {
      process.stdout.write(
        `adopted  ${item.address}  ${item.title}  ${item.spaceId}  ${item.tabId}\n`
      );
    }
  }

  if (asJson) {
    process.stdout.write(JSON.stringify({ ok: true, dryRun, adopted: rows }, null, 2) + '\n');
    return;
  }

  if (!dryRun) {
    process.stdout.write(
      'Hint: labeled terminals now show in the Herdr desktop app (open Herdr if it is not running).\n'
    );
  }
  if (rows.some((r) => !r.alreadyAdopted && !dryRun && (!r.labeled || !r.kept))) {
    process.exitCode = 1;
  }
}

function cmdRename(argv) {
  const { args } = parseArgs(argv);
  if (args.length < 2) fail('usage: af rename <title|id> "<new title>"');
  const updated = registry.update(args[0], { title: args[1] });
  printSession(updated, 'renamed');
}

function cmdDone(argv) {
  const { args } = parseArgs(argv);
  if (!args[0]) fail('usage: af done <title|id>');
  const updated = registry.update(args[0], { status: 'done', lastUsed: nowIso() });
  printSession(updated, 'done');
}

function cmdRm(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: af rm <title|id>');
  if (!flags.force && !flags.f) {
    // non-interactive: require --force only if we want; for CLI simplicity just delete
  }
  const removed = registry.remove(args[0]);
  process.stdout.write(`removed ${removed.title} (${removed.id})\n`);
}

function cmdNote(argv) {
  const { args } = parseArgs(argv);
  if (args.length < 2) fail('usage: af note <title|id> "<text>"');
  const updated = registry.update(args[0], { notes: args.slice(1).join(' ') });
  printSession(updated, 'noted');
}

function cmdExport(argv) {
  const { args } = parseArgs(argv);
  const data = registry.exportAll();
  const json = JSON.stringify(data, null, 2) + '\n';
  if (args[0]) {
    fs.writeFileSync(args[0], json, 'utf8');
    process.stderr.write(`wrote ${args[0]} (${data.sessions.length} sessions)\n`);
  } else {
    process.stdout.write(json);
  }
}

function cmdImportFile(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: af import-file <file>');
  const payload = JSON.parse(fs.readFileSync(args[0], 'utf8'));
  const result = registry.importAll(payload, { merge: !flags.replace });
  process.stdout.write(`import-file: added ${result.added}, updated ${result.updated}, total ${result.total}\n`);
}

function collectTags(flags) {
  const tags = [];
  if (flags.tag === true) return tags;
  if (typeof flags.tag === 'string') tags.push(flags.tag);
  // parseArgs only keeps last --tag; support comma-separated
  if (tags.length === 1 && tags[0].includes(',')) {
    return tags[0].split(',').map((t) => t.trim()).filter(Boolean);
  }
  return tags;
}

function printSession(s, verb) {
  process.stdout.write(
    `${verb}: ${s.title}\n` +
      `  id:      ${s.id}\n` +
      `  chatId:  ${s.chatId}\n` +
      `  engine:  ${s.engine || 'cursor'}\n` +
      `  cwd:     ${s.cwd}\n` +
      `  branch:  ${s.branch || '(none)'}\n` +
      `  status:  ${s.status}\n` +
      (s.lastOutput ? `  output:  ${s.lastOutput}\n` : '') +
      `  registry:${fleetDir()}/sessions.json\n`
  );
}

async function cmdRun(argv) {
  const { args, flags } = parseArgs(argv);
  const titleOrId = args[0];
  const prompt = flags.prompt;
  if (!titleOrId || !prompt || prompt === true) {
    fail('usage: af run "<title>" --prompt "..." [--cwd DIR] [--engine cursor|copilot] [--mode ask|plan] [--force]');
  }

  const engineFlag = flags.engine ? String(flags.engine) : null;
  if (engineFlag && engineFlag !== 'cursor' && engineFlag !== 'copilot') {
    fail(`unknown engine: ${engineFlag} (want cursor or copilot)`);
  }
  const mode = flags.mode ? String(flags.mode) : null;
  if (mode && mode !== 'ask' && mode !== 'plan') {
    fail(`unknown --mode: ${mode} (want ask or plan)`);
  }
  const outputFormat = flags['output-format'] ? String(flags['output-format']) : 'text';
  const force = Boolean(flags.force);
  const dryRun = Boolean(flags['dry-run']);
  const trust = !flags['no-trust'];
  const timeoutSec = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }

  let session = null;
  try {
    session = registry.find(titleOrId);
  } catch (err) {
    fail(err.message);
  }

  if (session) {
    if (engineFlag && (session.engine || 'cursor') !== engineFlag) {
      fail(`session "${session.title}" is engine=${session.engine || 'cursor'}, not ${engineFlag}`);
    }
  } else {
    const engine = engineFlag || 'cursor';
    if (mode && engine === 'copilot') {
      fail('--mode ask|plan is a Cursor flag; Copilot has no equivalent here');
    }
    const cwd = resolveCwd(flags.cwd || flags.C);
    let chatId;
    if (dryRun) {
      chatId = engine === 'copilot' ? '00000000-0000-4000-8000-000000000000' : '00000000-0000-4000-8000-000000000000';
      process.stderr.write(`[dry-run] would create a ${engine} session in ${cwd}\n`);
    } else if (engine === 'cursor') {
      process.stderr.write(`Creating chat via ${cursor.resolveCursorBin()} create-chat…\n`);
      chatId = await cursor.createChat();
    } else {
      chatId = copilot.newSessionId();
    }
    const entry = {
      title: titleOrId,
      chatId,
      cwd,
      branch: gitBranch(cwd),
      model: flags.model || null,
      prompt,
      tags: collectTags(flags),
      status: 'active',
      engine,
    };
    if (dryRun) {
      session = { ...entry, id: 'dry-run' };
    } else {
      session = registry.add(entry);
      printSession(session, 'registered');
    }
  }

  const engine = session.engine || 'cursor';
  if (mode && engine === 'copilot') {
    fail('--mode ask|plan is a Cursor flag; Copilot has no equivalent here');
  }

  let bin;
  let argvRun;
  if (engine === 'cursor') {
    bin = cursor.resolveCursorBin();
    argvRun = cursor.buildPrintArgs(session, { prompt, mode, force, outputFormat, trust });
  } else if (engine === 'copilot') {
    bin = copilot.resolveCopilotBin();
    argvRun = copilot.buildPrintArgs(session, { prompt, force, outputFormat, silent: !flags['no-silent'] });
  } else {
    fail(`unsupported engine: ${engine}`);
  }

  const shell = runlib.commandString(bin, argvRun);
  if (dryRun) {
    process.stdout.write(`cd ${JSON.stringify(session.cwd)} && ${shell}\n`);
    return;
  }

  // Copilot --help says --allow-all-tools is required for non-interactive mode,
  // but a no-tool text prompt succeeded without it (Mini, 2026-11-10, 1.0.83).
  // Do not add that grant unless the caller passes --force.
  if (engine === 'copilot' && force) {
    process.stderr.write(
      'warning: --force adds Copilot --allow-all-tools (tools run without confirmation; not --allow-all/--yolo).\n'
    );
  } else if (engine === 'copilot') {
    process.stderr.write(
      'Copilot run without --force: no --allow-all-tools. Tool calls will not auto-approve.\n'
    );
  }

  process.stderr.write(`Running "${session.title}" via ${bin} (${engine}${mode ? `, mode=${mode}` : ''}${force ? ', force' : ''}) in ${session.cwd}\n`);
  const result = await runlib.spawnCaptured(bin, argvRun, {
    cwd: session.cwd,
    timeoutMs: timeoutSec ? timeoutSec * 1000 : 0,
  });
  const outPath = runlib.newRunLogPath(session.id, engine);
  runlib.writeRunLog(outPath, {
    argv: [bin, ...argvRun],
    cwd: session.cwd,
    stdout: result.stdout,
    stderr: result.stderr,
    code: result.code,
    signal: result.signal,
    timedOut: result.timedOut,
  });
  try {
    registry.update(session.id, {
      lastUsed: nowIso(),
      lastRunAt: nowIso(),
      lastExit: result.timedOut ? 124 : result.code,
      lastOutput: outPath,
      lastPrompt: prompt,
    });
  } catch (_) {
    /* ignore */
  }

  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  process.stderr.write(`output: ${outPath}\n`);
  if (result.timedOut) {
    process.stderr.write(`timed out after ${timeoutSec}s (signal ${result.signal || 'SIGTERM'})\n`);
    process.exitCode = 124;
  } else {
    process.exitCode = result.code || 0;
  }
}

function cmdLog(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: af log <title|id> [--path]');
  const session = registry.find(args[0]);
  if (!session) fail(`session not found: ${args[0]}`);
  const file = session.lastOutput;
  if (!file) fail(`no captured run output for "${session.title}"`);
  if (flags.path) {
    process.stdout.write(file + '\n');
    return;
  }
  if (!fs.existsSync(file)) fail(`output file missing: ${file}`);
  process.stdout.write(fs.readFileSync(file, 'utf8'));
}

function cmdHerdrTemplates(argv) {
  const { flags } = parseArgs(argv);
  const srcDir = path.join(__dirname, '..', 'templates');
  const destDir = path.join(require('../lib/util').homeDir(), '.config', 'herdr-core', 'templates');
  if (!fs.existsSync(srcDir)) fail(`bundled templates not found at ${srcDir}`);
  fs.mkdirSync(destDir, { recursive: true });
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md'));
  let copied = 0;
  let skipped = 0;
  for (const f of files) {
    const dest = path.join(destDir, f);
    if (fs.existsSync(dest) && !flags.force) {
      process.stderr.write(`skip ${dest} (exists; pass --force to overwrite)\n`);
      skipped++;
      continue;
    }
    fs.copyFileSync(path.join(srcDir, f), dest);
    process.stdout.write(`installed ${dest}\n`);
    copied++;
  }
  process.stderr.write(`herdr templates: installed ${copied}, skipped ${skipped}. Then: hc templates\n`);
}

function cmdHerdrApp(argv) {
  const herdrappinstall = require('../lib/herdrappinstall');
  const { args, flags } = parseArgs(argv);
  const sub = args[0];
  if (!sub || sub === 'help' || sub === '-h' || sub === '--help') {
    process.stdout.write(
      'usage: af herdr-app install [--copy] [--force] [--dry-run]\n' +
        '       af herdr-app status\n'
    );
    return;
  }
  if (sub === 'status') {
    const st = herdrappinstall.status();
    for (const item of st.items) {
      process.stdout.write(`${item.kind.padEnd(8)} ${item.state.padEnd(10)} ${item.dest}\n`);
      if (item.detail) process.stdout.write(`         ${item.detail}\n`);
    }
    process.stdout.write(`home: ${st.home}\n`);
    return;
  }
  if (sub === 'install') {
    const result = herdrappinstall.install({
      copy: Boolean(flags.copy),
      force: Boolean(flags.force),
      dryRun: Boolean(flags['dry-run']),
    });
    for (const a of result.actions) {
      const prefix = result.dryRun ? '[dry-run] ' : '';
      process.stdout.write(`${prefix}${a.action}  ${a.kind}  ${a.dest}\n`);
      if (a.detail) process.stdout.write(`  ${a.detail}\n`);
    }
    if (!result.ok) {
      process.exitCode = 1;
      if (result.error) process.stderr.write(`${result.error}\n`);
    }
    return;
  }
  fail(`unknown herdr-app subcommand: ${sub}\nusage: af herdr-app install|status`);
}

function fail(msg) {
  process.stderr.write(msg + '\n');
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
