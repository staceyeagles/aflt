#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../lib/registry');
const cursor = require('../lib/cursor');
const copilot = require('../lib/copilot');
const engine = require('../lib/engine');
const config = require('../lib/config');
const backends = require('../lib/backends');
const runlib = require('../lib/run');
const herdr = require('../lib/herdr');
const herdrapp = require('../lib/herdrapp');
const orchestrate = require('../lib/orchestrate');
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
  sleep,
} = require('../lib/util');

const USAGE = `agentfleet (af) — track & resume Cursor / Copilot CLI agent sessions

Usage:
  af new "<title>" [--cwd DIR] [--prompt "..."] [--model X] [--engine cursor|copilot]
                            [--force] [--tag T]... [--dry-run]
  af add "<title>" --chat <id> [--cwd DIR] [--model X] [--engine cursor|copilot]
                            [--tag T]... [--prompt "..."]
                            For --engine copilot, --chat is the Copilot session UUID
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
  af spawn --parent <id|title> --prompt TEXT [--engine cursor|copilot] [--cwd DIR]
                            [--title T] [--task TEXT] [--model X] [--timeout SEC]
                            [--force] [--interactive] [--dry-run] [--json]
                            Create a worker under a master; headless by default
                            (same machinery as af run). --interactive launches via Herdr.
  af children [<id|title>] [--json] [--all]
                            List a master's workers, or (no arg) resolve master from
                            AGENTFLEET_ID / AGENTFLEET_PARENT, or summarize all masters.
                            --all includes lifecycle-done masters in the summary.
  af result <id|title> [--path]
                            Print a worker's handoff file (or its path). If missing,
                            stderr note + last ~40 lines of the run log; exit 1.
  af wait [<id|title>...] [--any] [--timeout SEC] [--interval SEC] [--json]
                            Block until listed workers reach done|failed|stopped|waiting.
                            No ids: children of AGENTFLEET_ID (master) or AGENTFLEET_PARENT.
                            Exit: 0 ok, 1 failed/stopped, 2 timeout, 3 waiting.
  af tail <id|title> [-n N] [-f]
                            Last N lines of run log (or hc read for live Herdr). -f follows
                            until the worker leaves running (or Ctrl-C).
  af send <id|title> "text" [--timeout SEC] [--force]
                            Interactive: hc send. Headless (not running): continue chat
                            with a short handoff reminder. Refuses if headless runPid live.
  af stop <id|title> | af stop --all-children <master> [--json]
                            Stop a running worker (SIGTERM process group / hc interrupt+kill).
  af resume <title|id> [--via herdr|plain] [--here] [--open|--no-open]
                            [--prompt "..."] [--force] [--dry-run] [--no-herdr-app]
                            Resume one session (argv from session.engine). Default:
                            Herdr when hc is on PATH (prints Attach: hc attach <name>).
                            --here / --via plain: this terminal. --open: new iTerm2 tab
                            running hc attach (default in an iTerm TTY; --no-open disables).
                            --force: Copilot --allow-all-tools only (Cursor unchanged).
                            Herdr launches also label herdr.space / herdr.tab (and
                            --keep) so the desktop app shows the tab; --no-herdr-app
                            disables that.
  af resume | af resume -i | af pick
                            Interactive multi-select (TTY only); resume via Herdr
  af resume --all [--tag T] [--via tmux|iterm2|wezterm|herdr|plain]
                            [--open|--no-open] [--force] [--dry-run] [--no-herdr-app]
  af adopt <title|id ...> | af adopt --all [--dry-run] [--json]
                            Label live af Herdr terminals with herdr.space/tab +
                            enable keep so they appear in the Herdr desktop app
  af cursor | af copilot    Set default engine for new sessions (config.json)
  af engine [cursor|copilot]
                            Print default engine + source, or set it
  af rename <title|id> "<new title>"
  af done <title|id>
  af rm <title|id>
  af note <title|id> "<text>"
  af export [file]          Write registry JSON (default: stdout)
  af import-file <file>     Merge sessions from a backup file
  af which-backend          Show auto-detected resume --all backend
  af herdr-templates [--force]
                            Install Cursor/OpenCode/Copilot templates into
                            ~/.config/herdr-core/templates
  af herdr-app install [--copy] [--force] [--dry-run]
                            Symlink (default) or copy the af-sessions Herdr panel
                            + af layout into ~/.config/herdr-app (or $HERDR_APP_HOME)
  af herdr-app status       Report linked/copied/missing for the panel + layout
  af help

Environment:
  AGENTFLEET_HOME         Registry dir (default: ~/.agentfleet)
  AGENTFLEET_REGISTRY     Override sessions.json path
  AGENTFLEET_ENGINE       Default engine for NEW sessions (cursor|copilot);
                            after --engine flag, before config.json / builtin
  AGENTFLEET_CURSOR_BIN   Override cursor-agent binary
  AGENTFLEET_COPILOT_BIN  Override copilot binary
  AGENTFLEET_VIA          Default --via backend (resume --all; also overrides
                            single-session default: herdr vs plain)
  AGENTFLEET_TMUX_SESSION tmux session name (default: agentfleet)
  AGENTFLEET_HERDR_APP    Set to 0/false/off/no to skip herdr.space/tab labels
  AGENTFLEET_HERDR_APP_BIN Override herdr-app binary (default: herdr-app on PATH)
  HERDR_APP_HOME          Herdr app config dir (default: ~/.config/herdr-app)
  AGENTFLEET_ID           Set on launched sessions (af id); used by af children
  AGENTFLEET_PARENT       Set on spawned workers (master af id)
  AGENTFLEET_RESULT       Set on spawned workers (handoff file path)
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
    case 'spawn':
      await cmdSpawn(rest);
      break;
    case 'children':
      cmdChildren(rest);
      break;
    case 'result':
      cmdResult(rest);
      break;
    case 'wait':
      await cmdWait(rest);
      break;
    case 'tail':
      await cmdTail(rest);
      break;
    case 'send':
      await cmdSend(rest);
      break;
    case 'stop':
      await cmdStop(rest);
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
    case 'cursor':
    case 'copilot':
      cmdSetDefaultEngine(cmd, rest);
      break;
    case 'engine':
      cmdEngine(rest);
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
  if (!title) {
    fail('usage: af new "<title>" [--cwd DIR] [--prompt "..."] [--model X] [--engine cursor|copilot]');
  }

  const cwd = resolveCwd(flags.cwd || flags.C);
  const prompt = flags.prompt || '';
  const model = flags.model || null;
  const tags = collectTags(flags);
  const dryRun = Boolean(flags['dry-run']);
  const force = Boolean(flags.force);
  const trust = !flags['no-trust'];

  let resolved;
  try {
    resolved = engine.resolveEngine({ flag: flags.engine });
  } catch (err) {
    fail(err.message);
  }
  const engineName = resolved.engine;

  let chatId;
  if (engineName === 'copilot') {
    if (dryRun) {
      chatId = '00000000-0000-4000-8000-000000000000';
      process.stderr.write('[dry-run] would mint a Copilot session id\n');
    } else {
      chatId = copilot.newSessionId();
      process.stderr.write(`Minted Copilot session id ${chatId}\n`);
    }
  } else if (dryRun) {
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
    engine: engineName,
  };

  const launchOpts = {
    prompt: prompt || undefined,
    trust,
    force,
  };

  if (dryRun) {
    process.stderr.write(`[dry-run] would register: ${JSON.stringify(entry, null, 2)}\n`);
    const cmd = engine.buildInteractiveCommandString({ ...entry, chatId }, launchOpts);
    process.stdout.write(`cd ${JSON.stringify(cwd)} && ${cmd}\n`);
    return;
  }

  try {
    engine.assertEngineAvailable(entry);
  } catch (err) {
    fail(err.message);
  }

  const saved = registry.add(entry);
  printSession(saved, 'registered');

  // Set tab title then exec into interactive launch
  try {
    process.stdout.write(oscTitle(saved.title));
  } catch (_) {
    /* ignore */
  }

  const argvLaunch = engine.buildInteractiveCommand(saved, launchOpts);
  const launchEnv = { ...process.env, AGENTFLEET_ID: saved.id };
  const { code } = await engine.spawnInteractive(argvLaunch, { cwd, env: launchEnv });
  registry.touch(saved.id);
  process.exitCode = code || 0;
}

function cmdAdd(argv) {
  const { args, flags } = parseArgs(argv);
  const title = args[0];
  const chatId = flags.chat || flags.c;
  if (!title || !chatId) {
    fail('usage: af add "<title>" --chat <id> [--cwd DIR] [--engine cursor|copilot]');
  }

  // New row: same precedence as af new/run (--engine > AGENTFLEET_ENGINE > config > cursor).
  let engineName;
  try {
    engineName = engine.resolveEngine({ flag: flags.engine }).engine;
  } catch (err) {
    fail(err.message);
  }

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
    engine: engineName,
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
    if (!flags['dry-run']) {
      try {
        engine.assertEngineAvailable(session);
      } catch (err) {
        fail(err.message);
      }
    }
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
    `Resuming "${session.title}" (${shortId(session.chatId)}, ${session.engine || 'cursor'}) in ${session.cwd}\n`
  );
  registry.touch(session.id);
  if (flags['dry-run']) {
    process.stdout.write(
      `cd ${JSON.stringify(session.cwd)} && ${engine.buildInteractiveCommandString(session, resumeOpts)}\n`
    );
    return;
  }
  try {
    engine.assertEngineAvailable(session);
  } catch (err) {
    fail(err.message);
  }
  const argvLaunch = engine.buildInteractiveCommand(session, resumeOpts);
  const { code } = await engine.spawnInteractive(argvLaunch, { cwd: session.cwd });
  process.exitCode = code || 0;
}

function buildResumeOpts(flags = {}) {
  const resumeOpts = {
    trust: !flags['no-trust'],
    force: Boolean(flags.force),
    herdrApp: herdrapp.herdrAppEnabled(flags),
  };
  if (typeof flags.prompt === 'string' && flags.prompt) resumeOpts.prompt = flags.prompt;
  return resumeOpts;
}

function cmdSetDefaultEngine(name, argv) {
  const { args } = parseArgs(argv);
  if (args.length > 0) fail(`usage: af ${name}`);
  let engineName;
  try {
    engineName = config.setDefaultEngine(name);
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(`default engine set to ${engineName} (${config.configPath()})\n`);
}

function cmdEngine(argv) {
  const { args } = parseArgs(argv);
  if (args.length === 0) {
    let resolved;
    try {
      resolved = engine.resolveEngine({});
    } catch (err) {
      fail(err.message);
    }
    process.stdout.write(
      `default engine: ${resolved.engine} (from ${resolved.source})\n` +
        `config: ${config.configPath()}\n`
    );
    return;
  }
  if (args.length !== 1) fail('usage: af engine [cursor|copilot]');
  let engineName;
  try {
    engineName = config.setDefaultEngine(args[0]);
  } catch (err) {
    fail(err.message);
  }
  process.stdout.write(`default engine set to ${engineName} (${config.configPath()})\n`);
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

  if (!dryRun) {
    for (const s of sessions) {
      try {
        engine.assertEngineAvailable(s);
      } catch (err) {
        fail(`${s.title}: ${err.message}`);
      }
    }
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
    `    ${pad('#', 3)} ${pad('TITLE', 24)} ${pad('ENGINE', 8)} ${pad('FOLDER', 24)} ${pad('HERDR', 8)} LAST USED\n`
  );
  enriched.forEach((e, i) => {
    const s = e.session;
    const folder = s.cwd ? path.basename(s.cwd) : '';
    process.stdout.write(
      `    ${pad(String(i + 1), 3)} ${pad(s.title, 24)} ${pad(s.engine || 'cursor', 8)} ${pad(folder, 24)} ${pad(herdr.displayRuntime(e.runtime), 8)} ${s.lastUsed || ''}\n`
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
  if (!flags['dry-run']) {
    for (const s of selected) {
      try {
        engine.assertEngineAvailable(s);
      } catch (err) {
        fail(`${s.title}: ${err.message}`);
      }
    }
  }
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

/**
 * Headless print-mode run for an already-registered session.
 * Shared by `af run`, `af spawn`, and headless `af send` continuations.
 * Spawns the engine detached in its own process group (still awaited; not
 * unref'd) and records runPid/runPgid/runHost so `af stop` can kill the group.
 * Streams stdout into the run log as data arrives.
 * @returns {{ code, timedOut, outPath, result, stopped }}
 */
async function executeHeadlessRun(session, opts = {}) {
  const {
    prompt,
    mode = null,
    force = false,
    outputFormat = 'text',
    trust = true,
    timeoutSec = 0,
    silent = true,
    env = null,
    quietCopilotHints = false,
    trackRun = true,
  } = opts;

  const engineName = session.engine || 'cursor';
  if (mode && engineName === 'copilot') {
    fail('--mode ask|plan is a Cursor flag; Copilot has no equivalent here');
  }

  let bin;
  let argvRun;
  if (engineName === 'cursor') {
    bin = cursor.resolveCursorBin();
    argvRun = cursor.buildPrintArgs(session, { prompt, mode, force, outputFormat, trust });
  } else if (engineName === 'copilot') {
    bin = copilot.resolveCopilotBin();
    argvRun = copilot.buildPrintArgs(session, { prompt, force, outputFormat, silent });
  } else {
    fail(`unsupported engine: ${engineName}`);
  }

  if (!quietCopilotHints) {
    if (engineName === 'copilot' && force) {
      process.stderr.write(
        'warning: --force adds Copilot --allow-all-tools (tools run without confirmation; not --allow-all/--yolo).\n'
      );
    } else if (engineName === 'copilot') {
      process.stderr.write(
        'Copilot run without --force: no --allow-all-tools. Tool calls will not auto-approve.\n'
      );
    }
  }

  process.stderr.write(
    `Running "${session.title}" via ${bin} (${engineName}${mode ? `, mode=${mode}` : ''}${force ? ', force' : ''}) in ${session.cwd}\n`
  );
  const childEnv = env || { ...process.env, AGENTFLEET_ID: session.id };
  const outPath = runlib.newRunLogPath(session.id, engineName);
  runlib.writeRunLogHeader(outPath, { argv: [bin, ...argvRun], cwd: session.cwd });

  if (trackRun) {
    try {
      registry.update(session.id, {
        lastOutput: outPath,
        lastPrompt: prompt,
        runHost: os.hostname(),
        runStartedAt: nowIso(),
        stopRequested: false,
        runPid: null,
        runPgid: null,
      });
    } catch (_) {
      /* ignore */
    }
  }

  const result = await runlib.spawnCaptured(bin, argvRun, {
    cwd: session.cwd,
    timeoutMs: timeoutSec ? timeoutSec * 1000 : 0,
    env: childEnv,
    detached: true,
    logPath: outPath,
    onSpawn: ({ pid, pgid }) => {
      if (!trackRun) return;
      try {
        registry.update(session.id, {
          runPid: pid,
          runPgid: pgid,
          runHost: os.hostname(),
          runStartedAt: nowIso(),
          lastOutput: outPath,
        });
      } catch (_) {
        /* ignore */
      }
    },
  });

  let stopped = false;
  try {
    const fresh = registry.find(session.id);
    if (fresh && fresh.stopRequested) stopped = true;
  } catch (_) {
    /* ignore */
  }

  try {
    registry.update(session.id, {
      lastUsed: nowIso(),
      lastRunAt: nowIso(),
      lastExit: result.timedOut ? 124 : result.code,
      lastOutput: outPath,
      lastPrompt: prompt,
      runPid: null,
      runPgid: null,
    });
  } catch (_) {
    /* ignore */
  }

  if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
  if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  process.stderr.write(`output: ${outPath}\n`);
  const code = result.timedOut ? 124 : result.code || 0;
  if (result.timedOut) {
    process.stderr.write(`timed out after ${timeoutSec}s (signal ${result.signal || 'SIGTERM'})\n`);
  }
  return { code, timedOut: result.timedOut, outPath, result, stopped };
}

function headlessCommandPreview(session, { prompt, mode, force, outputFormat, trust, silent }) {
  const engineName = session.engine || 'cursor';
  let bin;
  let argvRun;
  if (engineName === 'cursor') {
    bin = cursor.resolveCursorBin();
    argvRun = cursor.buildPrintArgs(session, { prompt, mode, force, outputFormat, trust });
  } else if (engineName === 'copilot') {
    bin = copilot.resolveCopilotBin();
    argvRun = copilot.buildPrintArgs(session, { prompt, force, outputFormat, silent });
  } else {
    fail(`unsupported engine: ${engineName}`);
  }
  return runlib.commandString(bin, argvRun);
}

async function cmdRun(argv) {
  const { args, flags } = parseArgs(argv);
  const titleOrId = args[0];
  const prompt = flags.prompt;
  if (!titleOrId || !prompt || prompt === true) {
    fail('usage: af run "<title>" --prompt "..." [--cwd DIR] [--engine cursor|copilot] [--mode ask|plan] [--force]');
  }

  const engineFlag = flags.engine ? String(flags.engine) : null;
  if (engineFlag) {
    try {
      config.validateEngine(engineFlag);
    } catch (err) {
      fail(err.message);
    }
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
    let resolved;
    try {
      resolved = engine.resolveEngine({ flag: engineFlag });
    } catch (err) {
      fail(err.message);
    }
    const engineName = resolved.engine;
    if (mode && engineName === 'copilot') {
      fail('--mode ask|plan is a Cursor flag; Copilot has no equivalent here');
    }
    const cwd = resolveCwd(flags.cwd || flags.C);
    let chatId;
    if (dryRun) {
      chatId = '00000000-0000-4000-8000-000000000000';
      process.stderr.write(`[dry-run] would create a ${engineName} session in ${cwd}\n`);
    } else if (engineName === 'cursor') {
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
      engine: engineName,
    };
    if (dryRun) {
      session = { ...entry, id: 'dry-run' };
    } else {
      session = registry.add(entry);
      printSession(session, 'registered');
    }
  }

  const engineName = session.engine || 'cursor';
  if (mode && engineName === 'copilot') {
    fail('--mode ask|plan is a Cursor flag; Copilot has no equivalent here');
  }

  const runOpts = {
    prompt,
    mode,
    force,
    outputFormat,
    trust,
    timeoutSec,
    silent: !flags['no-silent'],
  };

  if (dryRun) {
    const shell = headlessCommandPreview(session, runOpts);
    process.stdout.write(`cd ${JSON.stringify(session.cwd)} && ${shell}\n`);
    return;
  }

  // Copilot --help says --allow-all-tools is required for non-interactive mode,
  // but a no-tool text prompt succeeded without it (Mini, 2026-11-10, 1.0.83).
  // Do not add that grant unless the caller passes --force.
  const { code } = await executeHeadlessRun(session, runOpts);
  process.exitCode = code;
}

async function cmdSpawn(argv) {
  const { flags } = parseArgs(argv);
  const parentQuery = flags.parent;
  const prompt = flags.prompt;
  if (!parentQuery || parentQuery === true || !prompt || prompt === true) {
    fail(
      'usage: af spawn --parent <id|title> --prompt TEXT [--engine cursor|copilot] [--cwd DIR] [--title T] [--task TEXT] [--interactive] [--dry-run]'
    );
  }

  let parent;
  try {
    parent = registry.find(String(parentQuery));
  } catch (err) {
    fail(err.message);
  }
  if (!parent) fail(`parent session not found: ${parentQuery}`);

  const engineFlag = flags.engine ? String(flags.engine) : null;
  if (engineFlag) {
    try {
      config.validateEngine(engineFlag);
    } catch (err) {
      fail(err.message);
    }
  }
  let resolved;
  try {
    resolved = engine.resolveEngine({ flag: engineFlag });
  } catch (err) {
    fail(err.message);
  }
  const engineName = resolved.engine;

  const force = Boolean(flags.force);
  const dryRun = Boolean(flags['dry-run']);
  const interactive = Boolean(flags.interactive);
  const trust = !flags['no-trust'];
  const asJson = Boolean(flags.json);
  const timeoutSec = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }

  const cwd = flags.cwd || flags.C ? resolveCwd(flags.cwd || flags.C) : parent.cwd;
  const task =
    typeof flags.task === 'string' && flags.task
      ? String(flags.task)
      : orchestrate.taskFromPrompt(prompt);

  const allSessions = registry.list({ includeDone: true });
  const children = allSessions.filter((s) => s.parent === parent.id);
  const title =
    typeof flags.title === 'string' && flags.title
      ? String(flags.title)
      : orchestrate.nextWorkerTitle(
          parent.title,
          children.length,
          allSessions.map((s) => s.title)
        );

  if (!parent.role && !dryRun) {
    try {
      parent = registry.update(parent.id, { role: 'master' });
    } catch (err) {
      fail(err.message);
    }
  }

  if (dryRun) {
    const dryId = 'dry-run-worker';
    const previewEntry = {
      id: dryId,
      title,
      chatId: '00000000-0000-4000-8000-000000000000',
      cwd,
      engine: engineName,
      model: flags.model || null,
      parent: parent.id,
      role: 'worker',
      task,
      result: orchestrate.defaultResultPath(dryId),
      workerStatus: interactive ? 'running' : 'queued',
    };
    const previewWrapped = orchestrate.wrapWorkerPrompt({
      parentTitle: parent.title,
      parentId: parent.id,
      task,
      resultPath: previewEntry.result,
      prompt,
    });
    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          {
            dryRun: true,
            parent: { id: parent.id, title: parent.title, role: parent.role || 'master' },
            worker: previewEntry,
            interactive,
            prompt: previewWrapped,
          },
          null,
          2
        ) + '\n'
      );
    } else {
      process.stderr.write(
        `[dry-run] would spawn worker "${title}" under "${parent.title}" (${parent.id})\n` +
          `[dry-run] engine=${engineName} cwd=${cwd} interactive=${interactive}\n` +
          `[dry-run] result=${previewEntry.result}\n`
      );
      if (interactive) {
        const cmd = engine.buildInteractiveCommandString(previewEntry, {
          prompt: previewWrapped,
          trust,
          force,
        });
        process.stdout.write(`cd ${JSON.stringify(cwd)} && ${cmd}\n`);
      } else {
        const shell = headlessCommandPreview(previewEntry, {
          prompt: previewWrapped,
          force,
          outputFormat: 'text',
          trust,
          silent: true,
        });
        process.stdout.write(`cd ${JSON.stringify(cwd)} && ${shell}\n`);
      }
    }
    return;
  }

  let chatId;
  if (engineName === 'cursor') {
    process.stderr.write(`Creating chat via ${cursor.resolveCursorBin()} create-chat…\n`);
    chatId = await cursor.createChat();
  } else {
    chatId = copilot.newSessionId();
  }

  const resultsDir = path.join(fleetDir(), 'results');
  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });

  // Create with role=worker so normalizeEntry sets default result path from id.
  let worker;
  try {
    worker = registry.add({
      title,
      chatId,
      cwd,
      branch: gitBranch(cwd),
      model: flags.model || null,
      prompt: '',
      tags: [],
      status: 'active',
      engine: engineName,
      parent: parent.id,
      role: 'worker',
      task,
      workerStatus: 'queued',
    });
  } catch (err) {
    fail(err.message);
  }

  const finalResult = worker.result || orchestrate.defaultResultPath(worker.id);
  const finalWrapped = orchestrate.wrapWorkerPrompt({
    parentTitle: parent.title,
    parentId: parent.id,
    task,
    resultPath: finalResult,
    prompt,
  });
  worker = registry.update(worker.id, {
    prompt: finalWrapped,
    result: finalResult,
    force,
    stopRequested: false,
  });

  const envOverlay = {
    AGENTFLEET_ID: worker.id,
    AGENTFLEET_PARENT: parent.id,
    AGENTFLEET_RESULT: finalResult,
  };

  if (interactive) {
    try {
      engine.assertEngineAvailable(worker);
    } catch (err) {
      fail(err.message);
    }
    worker = registry.update(worker.id, {
      workerStatus: 'running',
      lastUsed: nowIso(),
      force,
      stopRequested: false,
    });
    const resumeOpts = {
      prompt: finalWrapped,
      trust,
      force,
      herdrApp: herdrapp.herdrAppEnabled(flags),
      envOverlay,
    };
    const plan = backends.executeResumeAll([worker], {
      via: 'herdr',
      dryRun: false,
      resumeOpts,
    });
    if (asJson) {
      process.stdout.write(
        JSON.stringify(
          {
            worker: {
              id: worker.id,
              title: worker.title,
              engine: worker.engine,
              result: finalResult,
              workerStatus: worker.workerStatus,
            },
            parent: { id: parent.id, title: parent.title },
            herdr: plan,
          },
          null,
          2
        ) + '\n'
      );
    } else {
      printSession(worker, 'spawned');
      process.stdout.write(`  result:  ${finalResult}\n`);
      reportHerdr(plan, flags);
    }
    return;
  }

  worker = registry.update(worker.id, {
    workerStatus: 'running',
    lastUsed: nowIso(),
    force,
    stopRequested: false,
  });
  const { code, timedOut, outPath, stopped } = await executeHeadlessRun(worker, {
    prompt: finalWrapped,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: false,
  });

  let workerStatus;
  if (stopped) workerStatus = 'stopped';
  else if (!timedOut && code === 0) workerStatus = 'done';
  else workerStatus = 'failed';
  try {
    worker = registry.update(worker.id, { workerStatus, runPid: null, runPgid: null });
  } catch (_) {
    /* ignore */
  }

  if (asJson) {
    process.stdout.write(
      JSON.stringify(
        {
          worker: {
            id: worker.id,
            title: worker.title,
            engine: worker.engine,
            result: finalResult,
            workerStatus,
            lastExit: timedOut ? 124 : code,
            lastOutput: outPath,
          },
          parent: { id: parent.id, title: parent.title },
        },
        null,
        2
      ) + '\n'
    );
  } else {
    process.stderr.write(
      `worker: ${worker.title} (${worker.id})\n` +
        `result: ${finalResult}\n` +
        `log: ${outPath}\n`
    );
  }
  process.exitCode = code;
}

function listChildrenOf(masterId) {
  return registry
    .list({ includeDone: true })
    .filter((s) => s.parent === masterId)
    .sort((a, b) => String(a.title).localeCompare(String(b.title)));
}

function resolveChildrenMaster(args, flags) {
  if (args[0]) {
    let s;
    try {
      s = registry.find(args[0]);
    } catch (err) {
      fail(err.message);
    }
    if (!s) fail(`session not found: ${args[0]}`);
    return s;
  }
  const idEnv = process.env.AGENTFLEET_ID;
  if (idEnv) {
    const self = registry.find(idEnv);
    if (self && (self.role === 'master' || listChildrenOf(self.id).length > 0)) {
      return self;
    }
  }
  const parentEnv = process.env.AGENTFLEET_PARENT;
  if (parentEnv) {
    const p = registry.find(parentEnv);
    if (p) return p;
  }
  return null;
}

function cmdChildren(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const includeDoneMasters = Boolean(flags.all);

  const master = resolveChildrenMaster(args, flags);
  if (!master && !args[0]) {
    // Summarize all masters
    const sessions = registry.list({ includeDone: true });
    const childParentIds = new Set(sessions.filter((s) => s.parent).map((s) => s.parent));
    let masters = sessions.filter(
      (s) => s.role === 'master' || childParentIds.has(s.id)
    );
    if (!includeDoneMasters) {
      masters = masters.filter((s) => s.status !== 'done');
    }
    masters.sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));

    const rows = masters.map((m) => {
      const kids = listChildrenOf(m.id);
      const counts = { queued: 0, running: 0, waiting: 0, done: 0, failed: 0, stopped: 0 };
      for (const k of kids) {
        const st = k.workerStatus || 'stopped';
        if (counts[st] != null) counts[st]++;
        else counts.stopped++;
      }
      return {
        id: m.id,
        title: m.title,
        engine: m.engine || 'cursor',
        status: m.status,
        childCount: kids.length,
        workerStatusCounts: counts,
      };
    });

    if (asJson) {
      process.stdout.write(JSON.stringify({ masters: rows }, null, 2) + '\n');
      return;
    }
    if (rows.length === 0) {
      process.stdout.write('(no masters)\n');
      return;
    }
    process.stdout.write(
      `${pad('TITLE', 24)} ${pad('ID', 10)} ${pad('ENGINE', 8)} ${pad('KIDS', 5)} ${pad('RUN', 4)} ${pad('DONE', 5)} ${pad('FAIL', 5)} STATUS\n`
    );
    for (const r of rows) {
      process.stdout.write(
        `${pad(r.title, 24)} ${pad(shortId(r.id), 10)} ${pad(r.engine, 8)} ${pad(String(r.childCount), 5)} ${pad(String(r.workerStatusCounts.running), 4)} ${pad(String(r.workerStatusCounts.done), 5)} ${pad(String(r.workerStatusCounts.failed), 5)} ${r.status}\n`
      );
    }
    return;
  }

  if (!master) fail(`session not found: ${args[0]}`);

  const children = listChildrenOf(master.id);
  const fetchResult = herdr.fetchHerdrTerminals();
  if (!fetchResult.ok) {
    process.stderr.write(`herdr: ${fetchResult.error || 'query failed'} (showing stored workerStatus)\n`);
  }
  const enriched = herdr.enrichSessions(children, fetchResult);

  const rows = enriched.map((e) => {
    const s = e.session;
    const agentState = orchestrate.agentStateFromHerdr(e);
    const waitInfo = orchestrate.detectWaitingTransition({
      agentState,
      seenWorking: Boolean(s._seenWorking),
      idleTicks: 0,
    });
    const derived = orchestrate.deriveWorkerStatus(
      s,
      {
        runtime: e.runtime,
        exitCode: e.exitCode,
        waitingHint: waitInfo.hint === 'waiting' ? 'waiting' : null,
      },
      { isAlive: orchestrate.defaultIsAlive, hostname: os.hostname() }
    );
    const resultPath = s.result || orchestrate.defaultResultPath(s.id);
    return {
      id: s.id,
      title: s.title,
      engine: s.engine || 'cursor',
      cwd: s.cwd,
      task: s.task || '',
      workerStatus: derived,
      result: resultPath,
      resultExists: Boolean(resultPath && fs.existsSync(resultPath)),
      lastExit: s.lastExit != null ? s.lastExit : null,
      lastOutput: s.lastOutput || null,
      herdr: {
        runtime: herdr.displayRuntime(e.runtime),
        address: e.address,
        name: e.name,
        exitCode: e.exitCode,
        agentState,
      },
    };
  });

  if (asJson) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`(no workers under "${master.title}")\n`);
    return;
  }
  process.stdout.write(
    `${pad('TITLE', 24)} ${pad('ID', 10)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} ${pad('FOLDER', 20)} TASK\n`
  );
  for (const r of rows) {
    const folder = r.cwd ? path.basename(r.cwd) : '';
    process.stdout.write(
      `${pad(r.title, 24)} ${pad(shortId(r.id), 10)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.resultExists ? 'yes' : 'no', 7)} ${pad(folder, 20)} ${r.task || ''}\n`
    );
  }
}

function cmdResult(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: af result <id|title> [--path]');
  let session;
  try {
    session = registry.find(args[0]);
  } catch (err) {
    fail(err.message);
  }
  if (!session) fail(`session not found: ${args[0]}`);

  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  if (flags.path) {
    process.stdout.write(resultPath + '\n');
    return;
  }

  if (fs.existsSync(resultPath)) {
    const body = fs.readFileSync(resultPath, 'utf8');
    process.stdout.write(body.endsWith('\n') ? body : body + '\n');
    process.exitCode = 0;
    return;
  }

  process.stderr.write(`no handoff yet at ${resultPath}\n`);
  const logFile = session.lastOutput;
  if (logFile && fs.existsSync(logFile)) {
    const text = fs.readFileSync(logFile, 'utf8');
    const lines = text.split(/\r?\n/);
    const tail = lines.slice(-40).join('\n');
    process.stdout.write(tail.endsWith('\n') ? tail : tail + '\n');
  }
  process.exitCode = 1;
}

function requireSession(query) {
  let session;
  try {
    session = registry.find(query);
  } catch (err) {
    fail(err.message);
  }
  if (!session) fail(`session not found: ${query}`);
  return session;
}

function runHcCli(argv, { timeoutMs } = {}) {
  return herdr.defaultRunHc(argv, { timeoutMs });
}

/**
 * Resolve the live Herdr terminal for a session by af_id (same as af ls/resume).
 * Never falls back to an unrelated terminal.
 * @returns {{ key: string, address: string|null, name: string|null, enriched: object }|null}
 */
function resolveLiveHerdrForSession(session, fetchResult) {
  if (!fetchResult || !fetchResult.ok) return null;
  const enriched = herdr.enrichSessions([session], fetchResult)[0];
  if (!enriched || enriched.runtime !== 'running') return null;
  const key = enriched.address || enriched.name;
  if (!key) return null;
  return { key, address: enriched.address, name: enriched.name, enriched };
}

function snapshotWorkerRow(session, { herdrInfo = null, waitingHint = null } = {}) {
  const derived = orchestrate.deriveWorkerStatus(
    session,
    {
      runtime: herdrInfo ? herdrInfo.runtime : null,
      exitCode: herdrInfo ? herdrInfo.exitCode : null,
      waitingHint,
    },
    { isAlive: orchestrate.defaultIsAlive, hostname: os.hostname() }
  );
  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  return {
    id: session.id,
    title: session.title,
    engine: session.engine || 'cursor',
    workerStatus: derived,
    resultExists: Boolean(resultPath && fs.existsSync(resultPath)),
    result: resultPath,
    lastExit: session.lastExit != null ? session.lastExit : null,
    lastOutput: session.lastOutput || null,
  };
}

function resolveWaitTargets(args) {
  if (args.length > 0) {
    return args.map((q) => requireSession(q));
  }
  const master = resolveChildrenMaster([], {});
  if (!master) {
    fail(
      'af wait: no workers specified and no master from AGENTFLEET_ID / AGENTFLEET_PARENT'
    );
  }
  const kids = listChildrenOf(master.id);
  if (kids.length === 0) {
    fail(`af wait: master "${master.title}" has no workers`);
  }
  return kids;
}

async function cmdWait(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const anyMode = Boolean(flags.any);
  const timeoutSec =
    flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  const intervalSec =
    flags.interval != null && flags.interval !== true ? Number(flags.interval) : 2;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }
  if (Number.isNaN(intervalSec) || intervalSec <= 0) {
    fail('--interval must be a positive number of seconds');
  }

  const targets = resolveWaitTargets(args);
  const waitState = new Map(); // id -> { seenWorking, idleTicks }
  const lastPrinted = new Map();
  const started = Date.now();
  const deadline = timeoutSec > 0 ? started + timeoutSec * 1000 : null;

  function pollOnce() {
    const fetchResult = herdr.fetchHerdrTerminals();
    const enrichedList = fetchResult.ok
      ? herdr.enrichSessions(targets.map((t) => registry.find(t.id) || t), fetchResult)
      : targets.map((t) => ({
          session: registry.find(t.id) || t,
          runtime: '-',
          exitCode: null,
          status: null,
        }));

    const rows = [];
    for (const e of enrichedList) {
      const s = registry.find(e.session.id) || e.session;
      let st = waitState.get(s.id) || { seenWorking: false, idleTicks: 0 };
      let waitingHint = null;
      if (e.runtime === 'running') {
        // Prefer a fresh hc get for agent status when ls omitted it.
        let statusObj = e.status;
        if (statusObj == null && (e.address || e.name) && fetchResult.ok) {
          const got = runHcCli(['get', '--json', e.address || e.name], { timeoutMs: 3000 });
          if (got.status === 0 && got.stdout) {
            try {
              statusObj = JSON.parse(got.stdout).status;
            } catch (_) {
              /* ignore */
            }
          }
        }
        const agentState = orchestrate.agentStateFromHerdr({ status: statusObj });
        const next = orchestrate.detectWaitingTransition({
          agentState,
          seenWorking: st.seenWorking,
          idleTicks: st.idleTicks,
        });
        st = { seenWorking: next.seenWorking, idleTicks: next.idleTicks };
        waitingHint = next.hint === 'waiting' ? 'waiting' : null;
      }
      waitState.set(s.id, st);
      const row = snapshotWorkerRow(s, {
        herdrInfo: { runtime: e.runtime, exitCode: e.exitCode },
        waitingHint,
      });
      rows.push(row);

      if (!asJson) {
        const prev = lastPrinted.get(s.id);
        if (prev !== row.workerStatus) {
          process.stderr.write(
            `wait: ${row.title} → ${row.workerStatus || '-'}\n`
          );
          lastPrinted.set(s.id, row.workerStatus);
        }
      }
    }
    return rows;
  }

  let rows = pollOnce();
  for (;;) {
    const statuses = rows.map((r) => r.workerStatus);
    const doneCount = statuses.filter((s) => orchestrate.isWaitTerminalStatus(s)).length;
    const finished = anyMode
      ? doneCount > 0
      : doneCount === statuses.length;
    if (finished) {
      const code = orchestrate.waitExitCode(statuses, { timedOut: false });
      if (asJson) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      } else {
        process.stdout.write(
          `${pad('TITLE', 24)} ${pad('ID', 10)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} EXIT\n`
        );
        for (const r of rows) {
          process.stdout.write(
            `${pad(r.title, 24)} ${pad(shortId(r.id), 10)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.resultExists ? 'yes' : 'no', 7)} ${r.lastExit != null ? r.lastExit : '-'}\n`
          );
        }
      }
      process.exitCode = code;
      return;
    }
    if (deadline != null && Date.now() >= deadline) {
      const code = orchestrate.waitExitCode(
        rows.map((r) => r.workerStatus),
        { timedOut: true }
      );
      if (asJson) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
      } else {
        process.stderr.write(`wait: timed out after ${timeoutSec}s\n`);
        process.stdout.write(
          `${pad('TITLE', 24)} ${pad('ID', 10)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} EXIT\n`
        );
        for (const r of rows) {
          process.stdout.write(
            `${pad(r.title, 24)} ${pad(shortId(r.id), 10)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.resultExists ? 'yes' : 'no', 7)} ${r.lastExit != null ? r.lastExit : '-'}\n`
          );
        }
      }
      process.exitCode = code;
      return;
    }
    await sleep(Math.max(50, intervalSec * 1000));
    // Refresh target list from registry (status fields change)
    for (let i = 0; i < targets.length; i++) {
      const fresh = registry.find(targets[i].id);
      if (fresh) targets[i] = fresh;
    }
    rows = pollOnce();
  }
}

function lastNLines(text, n) {
  const lines = String(text || '').split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(-Math.max(0, n));
}

async function cmdTail(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: af tail <id|title> [-n N] [-f]');
  const session = requireSession(args[0]);
  const n =
    flags.n != null && flags.n !== true
      ? Number(flags.n)
      : flags.lines != null && flags.lines !== true
        ? Number(flags.lines)
        : 50;
  if (Number.isNaN(n) || n < 0) fail('-n must be a non-negative number');
  const follow = Boolean(flags.f || flags.follow);

  const fetchResult = herdr.fetchHerdrTerminals();
  const live = resolveLiveHerdrForSession(session, fetchResult);

  if (live) {
    let lastLineCount = 0;
    let lastTail = '';
    const readOnce = (printAll) => {
      const r = runHcCli(['read', live.key, '--lines', String(Math.max(n, 200))], {
        timeoutMs: 5000,
      });
      if (r.status !== 0) {
        if (!follow) fail(`hc read failed: ${(r.stderr || '').trim() || r.status}`);
        return null;
      }
      const text = r.stdout || '';
      const lines = text.split(/\r?\n/);
      if (lines.length && lines[lines.length - 1] === '') lines.pop();
      if (printAll || lastLineCount === 0) {
        const out = lines.slice(-n);
        if (out.length) process.stdout.write(out.join('\n') + '\n');
      } else if (lines.length > lastLineCount) {
        const neu = lines.slice(lastLineCount);
        if (neu.length) process.stdout.write(neu.join('\n') + '\n');
      } else if (lines.length === lastLineCount && lines.join('\n') !== lastTail) {
        // Same count but content shifted: print last line if new.
        const curTail = lines.slice(-1).join('\n');
        if (curTail && curTail !== lastTail.split(/\r?\n/).slice(-1)[0]) {
          process.stdout.write(curTail + '\n');
        }
      }
      lastLineCount = lines.length;
      lastTail = lines.join('\n');
      return text;
    };

    readOnce(true);
    if (!follow) return;

    while (true) {
      await sleep(1000);
      const fresh = registry.find(session.id) || session;
      const fr = herdr.fetchHerdrTerminals();
      const still = resolveLiveHerdrForSession(fresh, fr);
      if (!still) {
        readOnce(false);
        return;
      }
      live.key = still.key;
      readOnce(false);
    }
  }

  // Headless (or interactive with no live Herdr terminal): follow run log.
  const logPath = () => {
    const s = registry.find(session.id) || session;
    return s.lastOutput;
  };
  let file = logPath();
  if (!file || !fs.existsSync(file)) {
    fail(`no run log for "${session.title}" (lastOutput unset or missing)`);
  }

  const printTail = (fromStart) => {
    const text = fs.readFileSync(file, 'utf8');
    if (fromStart) {
      const lines = lastNLines(text, n);
      if (lines.length) process.stdout.write(lines.join('\n') + '\n');
      return text.length;
    }
    return text.length;
  };

  let pos = 0;
  const initial = fs.readFileSync(file, 'utf8');
  const lines = lastNLines(initial, n);
  if (lines.length) process.stdout.write(lines.join('\n') + '\n');
  pos = initial.length;

  if (!follow) return;

  while (true) {
    await sleep(500);
    const s = registry.find(session.id) || session;
    file = s.lastOutput || file;
    if (file && fs.existsSync(file)) {
      const st = fs.statSync(file);
      if (st.size < pos) pos = 0; // truncated / new file
      if (st.size > pos) {
        const fd = fs.openSync(file, 'r');
        try {
          const buf = Buffer.alloc(st.size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          process.stdout.write(buf.toString('utf8'));
          pos = st.size;
        } finally {
          fs.closeSync(fd);
        }
      }
    }
    const derived = orchestrate.deriveWorkerStatus(s, null, {
      isAlive: orchestrate.defaultIsAlive,
      hostname: os.hostname(),
    });
    if (derived !== 'running' && derived !== 'queued') {
      // Drain any remaining bytes once more.
      if (file && fs.existsSync(file)) {
        const st = fs.statSync(file);
        if (st.size > pos) {
          const fd = fs.openSync(file, 'r');
          try {
            const buf = Buffer.alloc(st.size - pos);
            fs.readSync(fd, buf, 0, buf.length, pos);
            process.stdout.write(buf.toString('utf8'));
          } finally {
            fs.closeSync(fd);
          }
        }
      }
      return;
    }
  }
}

async function cmdSend(argv) {
  const { args, flags } = parseArgs(argv);
  if (args.length < 2) fail('usage: af send <id|title> "text" [--timeout SEC] [--force]');
  const session = requireSession(args[0]);
  const text = args.slice(1).join(' ');
  if (!text) fail('usage: af send <id|title> "text" [--timeout SEC] [--force]');
  const forceFlag = flags.force != null ? Boolean(flags.force) : null;
  const timeoutSec =
    flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }

  const fetchResult = herdr.fetchHerdrTerminals();
  const live = resolveLiveHerdrForSession(session, fetchResult);
  if (live) {
    const r = runHcCli(['send', live.key, text], { timeoutMs: 15000 });
    if (r.status !== 0) {
      fail(`hc send failed: ${(r.stderr || r.stdout || '').trim() || r.status}`);
    }
    try {
      registry.update(session.id, { workerStatus: 'running', lastUsed: nowIso() });
    } catch (_) {
      /* ignore */
    }
    process.stderr.write(`sent to ${session.title} via hc send ${live.key}\n`);
    return;
  }

  // Headless path (or interactive with no live terminal).
  const alive =
    session.runPid != null &&
    (!session.runHost || session.runHost === os.hostname()) &&
    orchestrate.defaultIsAlive(session.runPid);
  const status = orchestrate.deriveWorkerStatus(session, null, {
    isAlive: orchestrate.defaultIsAlive,
    hostname: os.hostname(),
  });
  if (alive || status === 'running') {
    fail(
      `worker "${session.title}" is still running (pid ${session.runPid}); refuse send. Use af stop first or wait.`
    );
  }

  const force = forceFlag != null ? forceFlag : Boolean(session.force);
  const trust = !flags['no-trust'];
  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  const prompt =
    session.role === 'worker'
      ? orchestrate.continueWorkerPrompt(resultPath, text)
      : text;

  const envOverlay = { AGENTFLEET_ID: session.id };
  if (session.parent) envOverlay.AGENTFLEET_PARENT = session.parent;
  if (resultPath) envOverlay.AGENTFLEET_RESULT = resultPath;

  registry.update(session.id, {
    workerStatus: session.role === 'worker' ? 'running' : session.workerStatus,
    lastUsed: nowIso(),
    stopRequested: false,
    force,
  });

  const { code, timedOut, outPath, stopped } = await executeHeadlessRun(session, {
    prompt,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: session.engine === 'copilot',
  });

  if (session.role === 'worker') {
    let workerStatus;
    if (stopped) workerStatus = 'stopped';
    else if (!timedOut && code === 0) workerStatus = 'done';
    else workerStatus = 'failed';
    try {
      registry.update(session.id, { workerStatus, runPid: null, runPgid: null });
    } catch (_) {
      /* ignore */
    }
    process.stderr.write(`send: ${session.title} → ${workerStatus} (log ${outPath})\n`);
  }
  process.exitCode = code;
}

function signalProcessGroup(pgid, signal) {
  if (pgid == null) return false;
  try {
    process.kill(-Number(pgid), signal);
    return true;
  } catch (_) {
    return false;
  }
}

async function stopOneSession(session, { asJson } = {}) {
  const fresh = registry.find(session.id) || session;
  const fetchResult = herdr.fetchHerdrTerminals();
  const live = resolveLiveHerdrForSession(fresh, fetchResult);

  const derived = orchestrate.deriveWorkerStatus(fresh, live ? { runtime: 'running' } : null, {
    isAlive: orchestrate.defaultIsAlive,
    hostname: os.hostname(),
  });

  if (
    derived === 'done' ||
    derived === 'failed' ||
    derived === 'stopped' ||
    (derived !== 'running' && derived !== 'queued' && derived !== 'waiting' && !live && !fresh.runPid)
  ) {
    const msg = `already terminal: ${fresh.title} (${derived || fresh.workerStatus || 'unknown'})`;
    if (asJson) {
      return { id: fresh.id, title: fresh.title, workerStatus: derived || fresh.workerStatus, noop: true, message: msg };
    }
    process.stderr.write(msg + '\n');
    return { id: fresh.id, title: fresh.title, workerStatus: derived || fresh.workerStatus, noop: true };
  }

  if (live) {
    runHcCli(['interrupt', live.key], { timeoutMs: 15000 });
    const kill = runHcCli(['kill', live.key], { timeoutMs: 15000 });
    if (kill.status !== 0) {
      process.stderr.write(
        `hc kill warning: ${(kill.stderr || kill.stdout || '').trim() || kill.status}\n`
      );
    }
    const updated = registry.update(fresh.id, {
      workerStatus: 'stopped',
      stopRequested: true,
      lastUsed: nowIso(),
    });
    return {
      id: updated.id,
      title: updated.title,
      workerStatus: 'stopped',
      mode: 'herdr',
      terminal: live.key,
      noop: false,
    };
  }

  // Headless
  if (fresh.runHost && fresh.runHost !== os.hostname()) {
    fail(
      `cannot stop "${fresh.title}": runHost ${fresh.runHost} ≠ this host ${os.hostname()}`
    );
  }

  registry.update(fresh.id, { stopRequested: true });

  const pgid = fresh.runPgid != null ? fresh.runPgid : fresh.runPid;
  const pid = fresh.runPid;
  if (pid != null && orchestrate.defaultIsAlive(pid)) {
    signalProcessGroup(pgid, 'SIGTERM');
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline && orchestrate.defaultIsAlive(pid)) {
      await sleep(100);
    }
    if (orchestrate.defaultIsAlive(pid)) {
      signalProcessGroup(pgid, 'SIGKILL');
      try {
        process.kill(pid, 'SIGKILL');
      } catch (_) {
        /* ignore */
      }
    }
  }

  const updated = registry.update(fresh.id, {
    workerStatus: 'stopped',
    stopRequested: true,
    runPid: null,
    runPgid: null,
    lastUsed: nowIso(),
  });
  return {
    id: updated.id,
    title: updated.title,
    workerStatus: 'stopped',
    mode: 'headless',
    noop: false,
  };
}

async function cmdStop(argv) {
  const { args, flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const allChildren = Boolean(flags['all-children']);

  let targets = [];
  if (allChildren) {
    const masterQuery = args[0] || flags['all-children'];
    if (!masterQuery || masterQuery === true) {
      fail('usage: af stop --all-children <master>');
    }
    const master = requireSession(String(masterQuery));
    targets = listChildrenOf(master.id);
    if (targets.length === 0) {
      fail(`no workers under "${master.title}"`);
    }
  } else {
    if (!args[0]) fail('usage: af stop <id|title> | af stop --all-children <master>');
    targets = [requireSession(args[0])];
  }

  const results = [];
  for (const t of targets) {
    results.push(await stopOneSession(t, { asJson }));
  }

  if (asJson) {
    process.stdout.write(JSON.stringify(allChildren ? results : results[0], null, 2) + '\n');
  } else if (!results.every((r) => r.noop)) {
    for (const r of results) {
      if (r.noop) continue;
      process.stderr.write(`stopped: ${r.title} (${r.workerStatus})\n`);
    }
  }
  process.exitCode = 0;
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
