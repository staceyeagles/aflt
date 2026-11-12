#!/usr/bin/env node
'use strict';

const fs = require('fs');
const crypto = require('crypto');
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
const launch = require('../lib/launch');
const {
  parseArgs,
  resolveCwd,
  gitBranch,
  nowIso,
  shortId,
  displayId,
  pad,
  oscTitle,
  fleetDir,
  registryPath,
  sleep,
  slugify,
} = require('../lib/util');

const ID_COL = 16;

const USAGE = `agentfleet (af) — track & resume Cursor / Copilot CLI agent sessions

Usage:
  af new "<title>" [--cwd DIR] [--prompt "..."] [--model X] [--engine cursor|copilot]
                            [--force] [--tag T]... [--dry-run]
  af add "<title>" --chat <id> [--cwd DIR] [--model X] [--engine cursor|copilot]
                            [--tag T]... [--prompt "..."]
                            For --engine copilot, --chat is the Copilot session UUID
  af import [--engine cursor|copilot] [cursor|copilot]
                            List local chats/sessions to register. Default engine
                            follows AGENTFLEET_ENGINE/config (builtin: cursor).
                            Cursor: scan ~/.cursor/chats (unchanged). Copilot:
                            list ~/.copilot/session-state (or import by id).
  af import --engine copilot [<id|prefix>...] [--title T] [--tag T]...
                            [--cwd DIR] [--limit N] [--json] [--all] [--dry-run]
                            [--allow-missing] [-i|--pick]
                            Copilot: list (newest first) or register by UUID/prefix.
                            --title only with a single id. -i requires a TTY.
  af ls [--status S] [--tag T] [--all] [--json]
                            STATUS is lifecycle; HERDR is live runtime (running|exited|missing|unknown|-)
  af sync [--dry-run] [--json]
                            Persist last-known Herdr runtime evidence (does not change status/lastUsed)
  af run "<title>" --prompt "..." [--cwd DIR] [--model X] [--engine cursor|copilot]
                            [--mode ask|plan] [--force] [--output-format text|json]
                            [--timeout SEC] [--dry-run] [--json]
                            Headless one-shot: create or resume, capture output, exit
  af run <title|id> --prompt "..." [...]
                            Same, resuming an existing tracked session
  af log <title|id> [--path]  Print last captured run output (or its path)
  af spawn --parent <id|title> --prompt TEXT [--engine cursor|copilot] [--cwd DIR]
                            [--title T] [--task TEXT] [--model X] [--timeout SEC]
                            [--force] [--interactive] [--dry-run] [--json]
                            Create a worker under a master; headless by default
                            (same machinery as af run). --interactive launches via Herdr.
  af master --goal TEXT [--engine cursor|copilot] [--cwd DIR] [--title T] [--model X]
                            [--worker-engine copilot|cursor] [--headless] [--timeout SEC]
                            [--force] [--dry-run] [--json]
                            Create a master session with the orchestrator template as
                            the initial prompt. Default: interactive via Herdr.
                            --headless uses af run machinery (workerStatus tracked).
  af children [<id|title>] [--json] [--all]
                            List a master's workers, or (no arg) resolve master from
                            AGENTFLEET_ID / AGENTFLEET_PARENT, or summarize all masters.
                            --all includes lifecycle-done masters in the summary.
  af result <id|title> [--path]
                            Print a worker's handoff file (or its path). If missing,
                            stderr note + last ~40 lines of the run log; exit 1.
  af wait [<id|title>...] [--parent <master>] [--any] [--timeout SEC] [--interval SEC]
                            [--send-grace SEC] [--json]
                            Block until listed workers reach done|failed|stopped|waiting.
                            Explicit ids/titles win over --parent. No ids: --parent children,
                            else children of AGENTFLEET_ID (master) or AGENTFLEET_PARENT.
                            Exit: 0 ok, 1 failed/stopped, 2 timeout, 3 waiting.
                            --send-grace: ignore stale Herdr done/idle after af send
                            (default 15; env AGENTFLEET_SEND_GRACE).
  af tail <id|title> [-n N] [-f]
                            Last N lines of run log (or hc read for live Herdr). -f follows
                            until the worker leaves running (or Ctrl-C).
  af send <id|title> "text" [--timeout SEC] [--force] [--json]
                            Interactive: hc send (records lastSendAt; workerStatus=running).
                            Headless (not running): continue chat with a short handoff
                            reminder. Refuses if headless runPid live.
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
  af rm <title|id> [--keep-files] [--force] [--dry-run]
                            Remove a session and its af-owned files under
                            $AGENTFLEET_HOME (results/, runs/<id>/, plans/).
                            Prefer --dry-run first. --keep-files: registry only
                            (keeps handoffs/logs). Refuses if running unless
                            --force (does not stop the process — af stop first).
  af rm --children <master> [--with-master] [--keep-files] [--force] [--dry-run]
                            Remove all workers of a master; --with-master also
                            removes the master. --dry-run lists actions only.
  af note <title|id> "<text>"
  af export [file]          Write registry JSON (default: stdout)
  af import-file <file>     Merge sessions from a backup file
  af which-backend          Show auto-detected resume --all backend
  af herdr-templates [--force] [--dry-run]
                            Install Cursor/OpenCode/Copilot templates into
                            ~/.config/herdr-core/templates
  af herdr-app install [--copy] [--force] [--dry-run]
                            Symlink (default) or copy the af-sessions Herdr panel
                            + af layout into ~/.config/herdr-app (or $HERDR_APP_HOME)
  af herdr-app status       Report linked/copied/missing for the panel + layout
  af doctor [--json]
                            Read-only environment checks (hc, engines, home)
  af help
                            Exit: 0 ok, 1 error, 2 wait timeout, 3 waiting,
                            75 critical registry write failed after a run

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
  AGENTFLEET_RESULT       Set on spawned workers / masters (handoff or summary path)
  AGENTFLEET_PLAN         Set on masters (plan file under $AGENTFLEET_HOME/plans/)
  AGENTFLEET_ROLE         Set on masters (master) when launched via af master
  AGENTFLEET_SEND_GRACE   Seconds for af wait to ignore stale done/idle after send
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
    case 'master':
      await cmdMaster(rest);
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
      await cmdImport(rest);
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
    case 'doctor':
      cmdDoctor(rest);
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
  registry.bestEffortTouch(saved.id);
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

/**
 * Cursor import — kept byte-for-byte in behavior from the pre-Copilot path.
 * Explicit `af import cursor` / `--engine cursor` always lands here.
 */
function cmdImportCursor() {
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

function uniqueImportTitle(base, taken, { slug = true } = {}) {
  let candidate = slug
    ? slugify(base).slice(0, 40) || 'copilot'
    : String(base || '').trim() || 'copilot';
  if (!taken.has(candidate)) return candidate;
  let n = 2;
  let title = `${candidate}-${n}`;
  while (taken.has(title)) {
    n++;
    title = `${candidate}-${n}`;
  }
  return title;
}

function formatUpdatedShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso).slice(0, 19);
  return d.toISOString().replace(/\.\d+Z$/, 'Z');
}

function printCopilotSessionTable(sessions, tracked) {
  process.stdout.write(
    `${pad('ID', 8)} ${pad('UPDATED', 20)} ${pad('FOLDER', 20)} ${pad('TRACKED', 7)} TITLE\n`
  );
  for (const s of sessions) {
    const mark = tracked.has(s.id) ? '✓' : '';
    const folder = s.cwd ? path.basename(s.cwd) : '';
    process.stdout.write(
      `${pad(shortId(s.id), 8)} ${pad(formatUpdatedShort(s.updated), 20)} ${pad(folder, 20)} ${pad(mark, 7)} ${s.title || ''}\n`
    );
  }
}

async function cmdImportCopilot(argv, flags) {
  const pick = Boolean(flags.pick || flags.i || flags.interactive);
  const asJson = Boolean(flags.json);
  const dryRun = Boolean(flags['dry-run']);
  const allowMissing = Boolean(flags['allow-missing']);
  const importAll = Boolean(flags.all);
  const limitRaw = flags.limit != null && flags.limit !== true ? Number(flags.limit) : 20;
  const limit = Number.isFinite(limitRaw) && limitRaw >= 0 ? limitRaw : 20;
  const cwdFilter = flags.cwd || flags.C || null;
  const titleFlag = flags.title != null && flags.title !== true ? String(flags.title) : null;
  const tags = collectTags(flags);

  let ids = Array.isArray(argv) ? [...argv] : [];

  if (pick) {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      fail('interactive import requires a TTY (or pass session id(s) / --all)');
    }
    const sessions = copilot.listLocalSessions({
      limit: Math.max(limit, 50),
      cwd: cwdFilter || undefined,
    });
    if (sessions.length === 0) {
      process.stdout.write('No Copilot sessions found under session-state.\n');
      return;
    }
    const tracked = new Set(registry.list({ includeDone: true }).map((s) => s.chatId));
    process.stdout.write(
      `    ${pad('#', 3)} ${pad('ID', 8)} ${pad('UPDATED', 20)} ${pad('FOLDER', 20)} ${pad('TRACKED', 7)} TITLE\n`
    );
    sessions.forEach((s, i) => {
      const mark = tracked.has(s.id) ? '✓' : '';
      const folder = s.cwd ? path.basename(s.cwd) : '';
      process.stdout.write(
        `    ${pad(String(i + 1), 3)} ${pad(shortId(s.id), 8)} ${pad(formatUpdatedShort(s.updated), 20)} ${pad(folder, 20)} ${pad(mark, 7)} ${s.title || ''}\n`
      );
    });
    const readline = require('readline/promises');
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await rl.question('Select sessions to import (e.g. 1,3 or 1-3; a = all): ');
    } finally {
      rl.close();
    }
    let indexes;
    try {
      indexes = backends.parseResumeSelection(answer, sessions.length);
    } catch (err) {
      fail(err.message);
    }
    ids = indexes.map((i) => sessions[i].id);
    if (ids.length === 0) {
      process.stdout.write('No sessions selected.\n');
      return;
    }
  }

  // List mode: no ids and not --all / not post-pick
  if (ids.length === 0 && !importAll) {
    const sessions = copilot.listLocalSessions({
      limit,
      cwd: cwdFilter || undefined,
    });
    const tracked = new Set(registry.list({ includeDone: true }).map((s) => s.chatId));
    if (asJson) {
      emitJson({
            engine: 'copilot',
            sessions: sessions.map((s) => ({
              id: s.id,
              updated: s.updated,
              cwd: s.cwd,
              folder: s.cwd ? path.basename(s.cwd) : null,
              tracked: tracked.has(s.id),
              title: s.title,
              branch: s.branch,
              repository: s.repository,
              model: s.model,
              created: s.created,
            })),
          });
      return;
    }
    if (sessions.length === 0) {
      process.stdout.write(
        'No Copilot sessions found under ~/.copilot/session-state/.\n' +
          'Tips:\n' +
          '  • set AGENTFLEET_COPILOT_HOME if sessions live elsewhere\n' +
          '  • import by id: af import --engine copilot <uuid>\n' +
          '  • or: af add "<title>" --chat <uuid> --engine copilot --cwd <dir>\n'
      );
      return;
    }
    printCopilotSessionTable(sessions, tracked);
    process.stdout.write(
      `\nImport with:\n  af import --engine copilot <id|prefix> [...]\n  af import --engine copilot --all\n`
    );
    return;
  }

  if (importAll) {
    if (titleFlag) {
      fail('--title is only valid when importing a single session id');
    }
    const sessions = copilot.listLocalSessions({
      limit: limit || 10000,
      cwd: cwdFilter || undefined,
    });
    const tracked = new Set(registry.list({ includeDone: true }).map((s) => s.chatId));
    ids = sessions.filter((s) => !tracked.has(s.id)).map((s) => s.id);
    if (ids.length === 0) {
      process.stdout.write('No untracked Copilot sessions to import.\n');
      return;
    }
  }

  if (titleFlag && ids.length !== 1) {
    fail('--title is only valid when importing a single session id');
  }

  const tracked = new Set(registry.list({ includeDone: true }).map((s) => s.chatId));
  const takenTitles = new Set(registry.list({ includeDone: true }).map((s) => s.title));
  const unknown = [];
  let imported = 0;
  let skipped = 0;
  // --cwd overrides registered cwd for explicit id imports / --allow-missing.
  // For --all it only filters the candidate list (metadata cwd wins).
  const cwdOverrides = Boolean(cwdFilter) && !importAll;

  for (const rawId of ids) {
    let local = null;
    try {
      local = copilot.getLocalSession(rawId);
    } catch (err) {
      if (err.code === 'PREFIX_TOO_SHORT' || err.code === 'AMBIGUOUS_PREFIX') {
        fail(err.message);
      }
      throw err;
    }

    if (!local) {
      if (!allowMissing) {
        unknown.push(rawId);
        continue;
      }
      const fullId = String(rawId).trim();
      if (tracked.has(fullId)) {
        process.stdout.write(`already tracked: ${fullId} (skip)\n`);
        skipped++;
        continue;
      }
      const cwd = resolveCwd(cwdFilter);
      const title = titleFlag
        ? uniqueImportTitle(titleFlag, takenTitles, { slug: false })
        : uniqueImportTitle(`copilot-${shortId(fullId)}`, takenTitles, { slug: false });
      takenTitles.add(title);
      const entry = {
        title,
        chatId: fullId,
        cwd,
        branch: gitBranch(cwd),
        model: null,
        prompt: '',
        tags,
        status: 'active',
        engine: 'copilot',
      };
      if (dryRun) {
        process.stdout.write(`[dry-run] would import ${fullId} as ${title} cwd=${cwd}\n`);
        imported++;
        continue;
      }
      const saved = registry.add(entry);
      tracked.add(saved.chatId);
      printSession(saved, 'imported');
      imported++;
      continue;
    }

    if (tracked.has(local.id)) {
      process.stdout.write(`already tracked: ${local.id} (skip)\n`);
      skipped++;
      continue;
    }

    const cwd = cwdOverrides
      ? resolveCwd(cwdFilter)
      : local.cwd
        ? copilot.realpathSafe(local.cwd)
        : resolveCwd();
    const model = typeof local.model === 'string' ? local.model : null;
    let title;
    if (titleFlag) {
      title = uniqueImportTitle(titleFlag, takenTitles, { slug: false });
    } else {
      const base =
        (local.title && String(local.title).trim()) || `copilot-${shortId(local.id)}`;
      title = uniqueImportTitle(base, takenTitles, { slug: true });
    }
    takenTitles.add(title);

    const entry = {
      title,
      chatId: local.id,
      cwd,
      branch: local.branch || gitBranch(cwd),
      model,
      prompt: local.firstPrompt || '',
      tags,
      status: 'active',
      engine: 'copilot',
    };

    if (dryRun) {
      process.stdout.write(
        `[dry-run] would import ${local.id} as ${title} cwd=${cwd}` +
          (model ? ` model=${model}` : '') +
          `\n`
      );
      imported++;
      continue;
    }

    const saved = registry.add(entry);
    tracked.add(saved.chatId);
    printSession(saved, 'imported');
    imported++;
  }

  if (unknown.length) {
    process.stderr.write(
      `unknown Copilot session id(s): ${unknown.join(', ')}\n` +
        `(use --allow-missing to register anyway)\n`
    );
    process.exitCode = 1;
  }
}

async function cmdImport(argv) {
  const { args, flags } = parseArgs(argv || []);
  const positional = [...args];

  let engineFlag = flags.engine;
  if (
    (engineFlag == null || engineFlag === true || engineFlag === '') &&
    positional[0] &&
    (positional[0] === 'cursor' || positional[0] === 'copilot')
  ) {
    engineFlag = positional.shift();
  }

  let resolved;
  try {
    resolved = engine.resolveEngine({ flag: engineFlag });
  } catch (err) {
    fail(err.message);
  }

  if (resolved.engine === 'cursor') {
    // Preserve exact Cursor behavior (ignore copilot-only flags/ids).
    return cmdImportCursor();
  }
  if (resolved.engine !== 'copilot') {
    fail(`unsupported engine for import: ${resolved.engine}`);
  }
  return cmdImportCopilot(positional, flags);
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
    emitJson({ sessions: rows, queryOk: Boolean(fetchResult.ok) });
    return;
  }

  process.stdout.write(
    `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('CHAT', 10)} ${pad('ENGINE', 8)} ${pad('FOLDER', 24)} ${pad('BRANCH', 12)} ${pad('STATUS', 8)} ${pad('HERDR', 8)} LAST USED\n`
  );
  for (const e of enriched) {
    const s = e.session;
    const folder = s.cwd ? path.basename(s.cwd) : '';
    process.stdout.write(
      `${pad(s.title, 24)} ${pad(displayId(s.id, ID_COL), ID_COL)} ${pad(shortId(s.chatId), 10)} ${pad(s.engine || 'cursor', 8)} ${pad(folder, 24)} ${pad(s.branch || '', 12)} ${pad(s.status, 8)} ${pad(herdr.displayRuntime(e.runtime), 8)} ${s.lastUsed || ''}\n`
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
      emitJson({ ok: false, error: fetchResult.error, dryRun, updated: [] });
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
    let cosmeticWarned = false;
    for (const e of toPersist) {
      const wr = registry.bestEffortUpdate(e.session.id, { herdr: herdr.herdrEvidence(e) });
      if (!wr.ok && !cosmeticWarned) {
        cosmeticWarned = true;
        if (!asJson) {
          process.stderr.write(`warning: cosmetic registry write failed: ${wr.error}\n`);
        }
      }
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
    emitJson({
          ok: true,
          dryRun,
          checkedAt: fetchResult.checkedAt,
          updated: rows,
        });
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
    const plan = launchViaHerdr([session], {
      dryRun: Boolean(flags['dry-run']),
      resumeOpts,
      flags,
      json: Boolean(flags.json),
    });
    reportHerdr(plan, flags);
    return;
  }

  if (flags['dry-run']) {
    process.stderr.write(
      `Resuming "${session.title}" (${shortId(session.chatId)}, ${session.engine || 'cursor'}) in ${session.cwd}\n`
    );
    process.stdout.write(
      `cd ${JSON.stringify(session.cwd)} && ${engine.buildInteractiveCommandString(session, resumeOpts)}\n`
    );
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
  registry.bestEffortTouch(session.id);
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

  const resumeOpts = buildResumeOpts(flags);
  const detected = via || backends.detectBackend();
  const planDry = dryRun || detected === 'plain';
  let plan;
  if (detected === 'herdr') {
    plan = launchViaHerdr(sessions, {
      dryRun: planDry,
      resumeOpts,
      flags,
      json: Boolean(flags.json),
    });
  } else {
    plan = backends.executeResumeAll(sessions, {
      via,
      tmuxSession: flags['tmux-session'],
      dryRun: planDry,
      resumeOpts,
    });
  }

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
      registry.bestEffortTouch(s.id);
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
  const asJson = Boolean(flags.json);
  if (dryRun || !plan.executed) {
    if (!asJson) {
      for (const c of plan.commands || []) {
        process.stdout.write(c.shell + '\n');
        if (c.name) process.stdout.write(backends.herdrAttachLine(c.name) + '\n');
      }
      maybeOpenITermAttach(plan, flags, { executed: false, dryRun: true });
    }
    return;
  }
  let ok = 0;
  for (const r of plan.results || []) {
    if (r.busy) {
      process.stderr.write(`skip "${r.title}": already running/launching\n`);
      continue;
    }
    if (r.skipped) {
      process.stderr.write(`skip "${r.title}": already live in herdr\n`);
      if (!asJson && r.name) process.stdout.write(backends.herdrAttachLine(r.name) + '\n');
    } else if (r.status === 0) {
      ok++;
      try {
        const cmd = (plan.commands || []).find((c) => c.title === r.title);
        if (cmd && cmd.id) {
          const runId = crypto.randomUUID();
          const runStartedAt = nowIso();
          let resultMtimeAtStart = null;
          try {
            const sess = registry.find(cmd.id);
            const rp = sess && (sess.result || orchestrate.defaultResultPath(sess.id));
            if (rp && fs.existsSync(rp)) resultMtimeAtStart = fs.statSync(rp).mtimeMs;
          } catch (_) {}
          registry.criticalUpdate(
            cmd.id,
            { runId, runStartedAt, resultMtimeAtStart, resultRunId: null },
            { phase: 'after-spawn' }
          );
          registry.bestEffortTouch(cmd.id);
        }
      } catch (_) { /* ignore */ }
      if (!asJson && r.name) process.stdout.write(backends.herdrAttachLine(r.name) + '\n');
      if (r.tabRename && r.tabRename.ok === false) {
        process.stderr.write(
          `herdr-app tab.rename failed for "${r.title}": ${r.tabRename.reason || r.tabRename.error || ''}\n`
        );
      }
    } else process.stderr.write(`hc run failed for "${r.title}": ${r.stderr || ''}\n`);
  }
  if (!asJson) {
    process.stdout.write(`Launched ${ok} Herdr terminal(s).\n`);
    maybeOpenITermAttach(plan, flags, { executed: true, dryRun: false });
  }
  if ((plan.results || []).some((r) => r.busy || (!r.skipped && r.status != null && r.status !== 0))) {
    process.exitCode = 1;
  }
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
  const plan = launchViaHerdr(selected, {
    dryRun: Boolean(flags['dry-run']),
    resumeOpts,
    flags,
    json: Boolean(flags.json),
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
    fail(launch.discoveryRefuseMessage(fetchResult.error), { json: asJson });
  }

  const plan = herdrapp.planAdopt(sessions, fetchResult.terminals || []);
  if (!plan.ok) fail(plan.error || 'adopt failed', { json: asJson });

  if (plan.items.length === 0) {
    if (asJson) {
      emitJson({ ok: true, dryRun, adopted: [] });
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
      ok: true,
      error: null,
      tabRename: null,
    };

    if (item.alreadyAdopted) {
      if (!dryRun) {
        const renamed = herdrapp.nameHerdrAppTab(item.tabId, item.title);
        row.renamed = Boolean(renamed && renamed.ok);
        row.tabRename = {
          ok: Boolean(renamed && renamed.ok),
          error: renamed && renamed.ok ? null : (renamed && renamed.reason) || 'rename failed',
        };
        if (!row.tabRename.ok) {
          process.stderr.write(
            `herdr-app tab.rename failed for ${item.title}: ${row.tabRename.error}\n`
          );
        }
      }
      row.ok = true;
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
    if (!row.labeled || !row.kept) {
      row.ok = false;
      const parts = [];
      if (!row.labeled) parts.push(`label: ${(lab.stderr || lab.stdout || '').trim() || lab.status}`);
      if (!row.kept) parts.push(`keep: ${(kep.stderr || kep.stdout || '').trim() || kep.status}`);
      row.error = parts.join('; ');
    }
    const renamed = herdrapp.nameHerdrAppTab(item.tabId, item.title);
    row.renamed = Boolean(renamed && renamed.ok);
    row.tabRename = {
      ok: Boolean(renamed && renamed.ok),
      error: renamed && renamed.ok ? null : (renamed && renamed.reason) || 'rename failed',
    };
    if (!row.tabRename.ok) {
      process.stderr.write(
        `herdr-app tab.rename failed for ${item.title}: ${row.tabRename.error}\n`
      );
    }
    rows.push(row);
    if (!asJson) {
      process.stdout.write(
        `adopted  ${item.address}  ${item.title}  ${item.spaceId}  ${item.tabId}\n`
      );
    }
  }

  const anyFail = rows.some((r) => r.ok === false);
  if (asJson) {
    emitJson({ ok: !anyFail, dryRun, adopted: rows });
    if (anyFail) process.exitCode = 1;
    return;
  }

  if (!dryRun) {
    process.stdout.write(
      'Hint: labeled terminals now show in the Herdr desktop app (open Herdr if it is not running).\n'
    );
  }
  if (anyFail) {
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

function sessionLooksRunning(session) {
  const fetchResult = herdr.fetchHerdrTerminals();
  if (resolveLiveHerdrForSession(session, fetchResult)) return { running: true, via: 'herdr' };
  const derived = orchestrate.deriveWorkerStatus(session, null, {
    isAlive: orchestrate.defaultIsAlive,
    hostname: os.hostname(),
  });
  if (
    derived === 'running' &&
    session.runPid != null &&
    (!session.runHost || session.runHost === os.hostname()) &&
    orchestrate.defaultIsAlive(session.runPid)
  ) {
    return { running: true, via: 'headless' };
  }
  return { running: false, via: null };
}

function collectRmTargets(argvFlags, args) {
  const childrenFlag = argvFlags.children;
  const withMaster = Boolean(argvFlags['with-master']);
  if (childrenFlag && childrenFlag !== true) {
    const master = requireSession(String(childrenFlag));
    const kids = listChildrenOf(master.id);
    const targets = kids.slice();
    if (withMaster) targets.push(master);
    if (targets.length === 0 && !withMaster) {
      fail(`af rm --children: master "${master.title}" has no workers`);
    }
    return { targets, master };
  }
  if (!args[0]) {
    fail(
      'usage: af rm <title|id> [--keep-files] [--force] [--dry-run]\n' +
        '       af rm --children <master> [--with-master] [--keep-files] [--force] [--dry-run]'
    );
  }
  if (withMaster) {
    fail('--with-master requires --children <master>');
  }
  return { targets: [requireSession(args[0])], master: null };
}

function cmdRm(argv) {
  const { args, flags } = parseArgs(argv);
  const keepFiles = Boolean(flags['keep-files']);
  const force = Boolean(flags.force || flags.f);
  const dryRun = Boolean(flags['dry-run']);
  const { targets } = collectRmTargets(flags, args);

  const home = fleetDir();
  const plan = [];
  for (const s of targets) {
    const run = sessionLooksRunning(s);
    if (run.running && !force) {
      fail(
        `af rm: "${s.title}" appears to be running (${run.via}). ` +
          `Stop it first with \`af stop ${s.title}\`, or pass --force to remove the record/files without stopping.`
      );
    }
    const owned = keepFiles
      ? { files: [], dirs: [], skipped: [] }
      : orchestrate.sessionOwnedPaths(s, { home });
    plan.push({ session: s, owned, running: run.running });
  }

  if (dryRun) {
    for (const item of plan) {
      const s = item.session;
      process.stdout.write(`[dry-run] would remove session ${s.title} (${s.id})\n`);
      if (item.running) process.stdout.write(`[dry-run]   (currently running; --force would be required)\n`);
      for (const f of item.owned.files) process.stdout.write(`[dry-run]   file ${f}\n`);
      for (const d of item.owned.dirs) process.stdout.write(`[dry-run]   dir  ${d}\n`);
      for (const sk of item.owned.skipped) {
        process.stderr.write(`[dry-run]   skip ${sk.path} (${sk.reason})\n`);
      }
    }
    return;
  }

  for (const item of plan) {
    const s = item.session;
    for (const sk of item.owned.skipped) {
      process.stderr.write(`af rm: skip ${sk.path} (${sk.reason})\n`);
    }
    for (const f of item.owned.files) {
      try {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      } catch (err) {
        process.stderr.write(`af rm: could not remove ${f}: ${err.message}\n`);
      }
    }
    for (const d of item.owned.dirs) {
      try {
        if (fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true });
      } catch (err) {
        process.stderr.write(`af rm: could not remove ${d}: ${err.message}\n`);
      }
    }
    const removed = registry.remove(s.id);
    process.stdout.write(`removed ${removed.title} (${removed.id})\n`);
  }
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

function printSession(s, verb, { stream } = {}) {
  const out = stream || process.stdout;
  out.write(
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
      if (session.result || session.plan) {
        process.stderr.write(
          'Copilot run without --force: no --allow-all-tools. Handoff/plan write path(s) are pre-approved via --allow-tool=write(…); other tools need confirmation or --force.\n'
        );
      } else {
        process.stderr.write(
          'Copilot run without --force: no --allow-all-tools. Tool calls will not auto-approve.\n'
        );
      }
    }
  }

  process.stderr.write(
    `Running "${session.title}" via ${bin} (${engineName}${mode ? `, mode=${mode}` : ''}${force ? ', force' : ''}) in ${session.cwd}\n`
  );
  const childEnv = env || { ...process.env, AGENTFLEET_ID: session.id };
  const outPath = runlib.newRunLogPath(session.id, engineName);
  runlib.writeRunLogHeader(outPath, { argv: [bin, ...argvRun], cwd: session.cwd });

  const asJson = Boolean(opts.json);
  const runId = crypto.randomUUID();
  const runStartedAt = nowIso();
  let resultMtimeAtStart = null;
  const resultPathHint = session.result || null;
  if (resultPathHint) {
    try {
      if (fs.existsSync(resultPathHint)) resultMtimeAtStart = fs.statSync(resultPathHint).mtimeMs;
    } catch (_) {
      resultMtimeAtStart = null;
    }
  }

  let registryWriteError = null;
  if (trackRun) {
    const before = registry.criticalUpdate(
      session.id,
      {
        lastOutput: outPath,
        lastPrompt: prompt,
        runHost: os.hostname(),
        runStartedAt,
        runId,
        resultMtimeAtStart,
        resultRunId: null,
        stopRequested: false,
        runPid: null,
        runPgid: null,
      },
      { phase: 'before-launch' }
    );
    if (!before.ok) {
      fail(
        `critical registry write failed before launch: ${before.error}`,
        { json: asJson }
      );
    }
  }

  let spawnIdentityError = null;
  const result = await runlib.spawnCaptured(bin, argvRun, {
    cwd: session.cwd,
    timeoutMs: timeoutSec ? timeoutSec * 1000 : 0,
    env: childEnv,
    detached: true,
    forwardSignals: true,
    logPath: outPath,
    onSpawn: ({ pid, pgid }) => {
      if (!trackRun) return;
      const idWrite = registry.criticalUpdate(
        session.id,
        {
          runPid: pid,
          runPgid: pgid,
          runHost: os.hostname(),
          runStartedAt,
          runId,
          lastOutput: outPath,
        },
        { phase: 'after-spawn' }
      );
      if (!idWrite.ok) spawnIdentityError = idWrite.error;
    },
  });

  let stopped = false;
  try {
    const fresh = registry.find(session.id);
    if (fresh && fresh.stopRequested) stopped = true;
  } catch (_) {
    /* ignore */
  }
  if (result.interruptedBy) stopped = true;

  const exitFromSignal = result.interruptedBy
    ? runlib.signalExitCode(result.interruptedBy)
    : null;
  const lastExit = result.timedOut ? 124 : exitFromSignal != null ? exitFromSignal : result.code;

  const patch = {
    lastRunAt: nowIso(),
    lastExit,
    lastOutput: outPath,
    lastPrompt: prompt,
    runPid: null,
    runPgid: null,
    runId,
    runStartedAt,
    resultMtimeAtStart,
  };
  if (result.interruptedBy && (session.role === 'worker' || session.role === 'master')) {
    patch.workerStatus = 'stopped';
    patch.stopRequested = true;
  }
  registry.bestEffortUpdate(session.id, { lastUsed: nowIso() });
  if (trackRun) {
    const after = registry.criticalUpdate(session.id, patch, { phase: 'after-exit' });
    if (!after.ok) {
      registryWriteError = after.error;
      process.stderr.write(
        `ERROR: critical registry write failed after run (exit will be ${registry.REGISTRY_WRITE_EXIT}): ${after.error}\n`
      );
    }
  }
  if (spawnIdentityError && !registryWriteError) {
    registryWriteError = spawnIdentityError;
    process.stderr.write(
      `ERROR: critical registry write failed recording runPid (exit will be ${registry.REGISTRY_WRITE_EXIT}): ${spawnIdentityError}\n`
    );
  }

  if (!asJson) {
    if (result.stdout) process.stdout.write(result.stdout.endsWith('\n') ? result.stdout : result.stdout + '\n');
    if (result.stderr) process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  } else if (result.stderr) {
    process.stderr.write(result.stderr.endsWith('\n') ? result.stderr : result.stderr + '\n');
  }
  process.stderr.write(`output: ${outPath}\n`);
  if (result.interruptedBy) {
    process.stderr.write(
      `interrupted (${result.interruptedBy}): forwarded SIGTERM to engine process group\n`
    );
  }
  let code = result.timedOut ? 124 : exitFromSignal != null ? exitFromSignal : result.code || 0;
  if (result.timedOut) {
    process.stderr.write(`timed out after ${timeoutSec}s (signal ${result.signal || 'SIGTERM'})\n`);
  }
  if (registryWriteError) {
    code = registry.REGISTRY_WRITE_EXIT;
  }
  return {
    code,
    timedOut: result.timedOut,
    outPath,
    result,
    stopped,
    interruptedBy: result.interruptedBy || null,
    registryWriteError,
    runId,
    runStartedAt,
    resultMtimeAtStart,
  };
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
  const asJson = Boolean(flags.json);
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
      if (!asJson) printSession(session, 'registered');
      else printSession(session, 'registered', { stream: process.stderr });
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
    if (asJson) {
      emitJson({
        ok: true,
        dryRun: true,
        session: { id: session.id, title: session.title, engine: session.engine || 'cursor' },
        command: headlessCommandPreview(session, runOpts),
      });
      return;
    }
    const shell = headlessCommandPreview(session, runOpts);
    process.stdout.write(`cd ${JSON.stringify(session.cwd)} && ${shell}\n`);
    return;
  }

  // Copilot --help says --allow-all-tools is required for non-interactive mode,
  // but a no-tool text prompt succeeded without it (Mini, 2026-11-10, 1.0.83).
  // Do not add that grant unless the caller passes --force.
  const { code, timedOut, outPath, result, registryWriteError } = await executeHeadlessRun(session, {
    ...runOpts,
    json: asJson,
  });
  if (asJson) {
    const excerptSrc = (result && result.stdout) || '';
    const payload = {
      ok: code === 0 && !timedOut && !registryWriteError,
      session: {
        id: session.id,
        title: session.title,
        engine: session.engine || 'cursor',
      },
      lastExit: timedOut ? 124 : code,
      outputPath: outPath,
      outputExcerpt: runlib.outputExcerpt(excerptSrc),
    };
    if (registryWriteError) payload.registryWriteError = registryWriteError;
    emitJson(payload);
  }
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

  const explicitTitle =
    typeof flags.title === 'string' && flags.title ? String(flags.title) : null;
  // Preview / dry-run title only; real uniqueness for default titles is decided
  // inside registry.add under the cross-process lock (autoTitle).
  const allSessions = registry.list({ includeDone: true });
  const children = allSessions.filter((s) => s.parent === parent.id);
  const title =
    explicitTitle ||
    orchestrate.nextWorkerTitle(
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
      emitJson({
            dryRun: true,
            parent: { id: parent.id, title: parent.title, role: parent.role || 'master' },
            worker: previewEntry,
            interactive,
            prompt: previewWrapped,
          });
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
  // Default titles are finalized under the registry lock so parallel
  // `af spawn ... &` cannot collide on `<master>-wN`.
  let worker;
  try {
    const addOpts = explicitTitle
      ? {}
      : { autoTitle: { parentTitle: parent.title, parentId: parent.id } };
    worker = registry.add(
      {
        title: explicitTitle || title,
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
      },
      addOpts
    );
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
      fail(err.message, { json: asJson });
    }
    const resumeOpts = {
      prompt: finalWrapped,
      trust,
      force,
      herdrApp: herdrapp.herdrAppEnabled(flags),
      envOverlay,
    };
    const plan = launchViaHerdr([worker], {
      dryRun: false,
      resumeOpts,
      flags,
      json: asJson,
    });
    const launchErr = herdrLaunchFailed(plan);
    if (launchErr) {
      try {
        worker = registry.update(worker.id, {
          workerStatus: 'failed',
          lastError: launchErr,
          lastUsed: nowIso(),
        });
      } catch (_) { /* ignore */ }
      if (asJson) {
        emitJson({
          ok: false,
          error: launchErr,
          worker: {
            id: worker.id,
            title: worker.title,
            engine: worker.engine,
            result: finalResult,
            workerStatus: 'failed',
            lastError: launchErr,
          },
          parent: { id: parent.id, title: parent.title },
          herdr: plan,
        });
      } else {
        process.stderr.write(`spawn failed: ${launchErr}\n`);
        reportHerdr(plan, flags);
      }
      process.exitCode = 1;
      return;
    }
    try {
      worker = registry.update(worker.id, {
        workerStatus: 'running',
        lastUsed: nowIso(),
        force,
        stopRequested: false,
        lastError: null,
      });
    } catch (_) { /* ignore */ }
    if (asJson) {
      emitJson({
        ok: true,
        worker: {
          id: worker.id,
          title: worker.title,
          engine: worker.engine,
          result: finalResult,
          workerStatus: 'running',
        },
        parent: { id: parent.id, title: parent.title },
        herdr: plan,
      });
      reportHerdr(plan, { ...flags, json: true });
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
  const { code, timedOut, outPath, stopped, result, runId, registryWriteError } = await executeHeadlessRun(worker, {
    prompt: finalWrapped,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: false,
    json: asJson,
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
  worker = applyResultHandoffFallback(worker, {
    code,
    timedOut,
    stopped,
    stdout: result && result.stdout,
    resultPath: finalResult,
    runId,
  });

  if (asJson) {
    emitJson({
      ok: code === 0 && !timedOut,
      worker: {
        id: worker.id,
        title: worker.title,
        engine: worker.engine,
        result: finalResult,
        workerStatus,
        resultSource: worker.resultSource || null,
        lastExit: timedOut ? 124 : code,
        lastOutput: outPath,
      },
      parent: { id: parent.id, title: parent.title },
      outputPath: outPath,
      outputExcerpt: runlib.outputExcerpt((result && result.stdout) || ''),
    });
  } else {
    process.stderr.write(
      `worker: ${worker.title} (${worker.id})\n` +
        `result: ${finalResult}\n` +
        `log: ${outPath}\n`
    );
  }
  process.exitCode = code;
}

async function cmdMaster(argv) {
  const { flags } = parseArgs(argv);
  const goal = flags.goal;
  if (!goal || goal === true) {
    fail(
      'usage: af master --goal TEXT [--engine cursor|copilot] [--cwd DIR] [--title T] [--model X] [--worker-engine copilot|cursor] [--headless] [--timeout SEC] [--force] [--dry-run] [--json]'
    );
  }
  const goalText = String(goal);

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

  let workerEngine = flags['worker-engine'] ? String(flags['worker-engine']) : 'copilot';
  try {
    config.validateEngine(workerEngine);
  } catch (err) {
    fail(`--worker-engine: ${err.message}`);
  }

  const force = Boolean(flags.force);
  const dryRun = Boolean(flags['dry-run']);
  const headless = Boolean(flags.headless);
  const trust = !flags['no-trust'];
  const asJson = Boolean(flags.json);
  const timeoutSec = flags.timeout != null && flags.timeout !== true ? Number(flags.timeout) : 0;
  if (flags.timeout && (Number.isNaN(timeoutSec) || timeoutSec < 0)) {
    fail('--timeout must be a number of seconds');
  }

  const cwd = resolveCwd(flags.cwd || flags.C);
  const task = orchestrate.taskFromPrompt(goalText);
  const allSessions = dryRun ? [] : registry.list({ includeDone: true });
  const title =
    typeof flags.title === 'string' && flags.title
      ? String(flags.title)
      : orchestrate.nextMasterTitle(
          goalText,
          allSessions.map((s) => s.title)
        );

  const resultsDir = path.join(fleetDir(), 'results');
  const previewId = 'dry-run-master';
  const previewResult = orchestrate.defaultResultPath(previewId);

  function buildPromptFor(masterId, masterTitle, resultPath, planPath) {
    const tpl = orchestrate.loadOrchestratorTemplate();
    return orchestrate.renderTemplate(tpl, {
      GOAL: goalText,
      MASTER_ID: masterId,
      MASTER_TITLE: masterTitle,
      CWD: cwd,
      DEFAULT_WORKER_ENGINE: workerEngine,
      PLAN: planPath || '',
    });
  }

  function masterEnvOverlay(session) {
    const overlay = {
      AGENTFLEET_ID: session.id,
      AGENTFLEET_RESULT: session.result,
      AGENTFLEET_ROLE: 'master',
      PATH: orchestrate.pathWithAf(process.env),
    };
    if (session.plan) overlay.AGENTFLEET_PLAN = session.plan;
    return overlay;
  }

  const previewPlan = orchestrate.defaultPlanPath(previewId);

  if (dryRun) {
    const prompt = buildPromptFor(previewId, title, previewResult, previewPlan);
    const previewEntry = {
      id: previewId,
      title,
      chatId: '00000000-0000-4000-8000-000000000000',
      cwd,
      engine: engineName,
      model: flags.model || null,
      role: 'master',
      task,
      result: previewResult,
      plan: previewPlan,
      workerStatus: headless ? 'queued' : 'running',
      prompt,
    };
    if (asJson) {
      emitJson({
            dryRun: true,
            master: previewEntry,
            headless,
            prompt,
          });
    } else {
      process.stderr.write(
        `[dry-run] would create master "${title}" (${engineName})\n` +
          `[dry-run] cwd=${cwd} headless=${headless}\n` +
          `[dry-run] result=${previewResult}\n` +
          `[dry-run] plan=${previewPlan}\n` +
          `[dry-run] worker-engine=${workerEngine}\n`
      );
      if (headless) {
        const shell = headlessCommandPreview(previewEntry, {
          prompt,
          force,
          outputFormat: 'text',
          trust,
          silent: true,
        });
        process.stdout.write(`cd ${JSON.stringify(cwd)} && ${shell}\n`);
      } else {
        const cmd = engine.buildInteractiveCommandString(previewEntry, {
          prompt,
          trust,
          force,
        });
        process.stdout.write(`cd ${JSON.stringify(cwd)} && ${cmd}\n`);
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

  fs.mkdirSync(resultsDir, { recursive: true, mode: 0o700 });
  const plansDir = path.join(fleetDir(), 'plans');
  fs.mkdirSync(plansDir, { recursive: true, mode: 0o700 });

  let master;
  try {
    master = registry.add({
      title,
      chatId,
      cwd,
      branch: gitBranch(cwd),
      model: flags.model || null,
      prompt: '',
      tags: [],
      status: 'active',
      engine: engineName,
      role: 'master',
      task,
      workerStatus: 'queued',
      force,
      stopRequested: false,
    });
  } catch (err) {
    fail(err.message);
  }

  const finalResult = master.result || orchestrate.defaultResultPath(master.id);
  const finalPlan = master.plan || orchestrate.defaultPlanPath(master.id);
  const finalPrompt = buildPromptFor(master.id, master.title, finalResult, finalPlan);
  master = registry.update(master.id, {
    prompt: finalPrompt,
    result: finalResult,
    plan: finalPlan,
    force,
    stopRequested: false,
  });

  const envOverlay = masterEnvOverlay(master);

  try {
    engine.assertEngineAvailable(master);
  } catch (err) {
    fail(err.message);
  }

  if (!headless) {
    const resumeOpts = {
      prompt: finalPrompt,
      trust,
      force,
      herdrApp: herdrapp.herdrAppEnabled(flags),
      envOverlay,
    };
    const plan = launchViaHerdr([master], {
      dryRun: false,
      resumeOpts,
      flags,
      json: asJson,
    });
    const launchErr = herdrLaunchFailed(plan);
    if (launchErr) {
      try {
        master = registry.update(master.id, {
          workerStatus: 'failed',
          lastError: launchErr,
          lastUsed: nowIso(),
        });
      } catch (_) { /* ignore */ }
      if (asJson) {
        emitJson({
          ok: false,
          error: launchErr,
          master: {
            id: master.id,
            title: master.title,
            engine: master.engine,
            result: finalResult,
            plan: finalPlan,
            workerStatus: 'failed',
            role: 'master',
            lastError: launchErr,
          },
          herdr: plan,
        });
      } else {
        process.stderr.write(`master launch failed: ${launchErr}\n`);
        reportHerdr(plan, flags);
      }
      process.exitCode = 1;
      return;
    }
    try {
      master = registry.update(master.id, {
        workerStatus: 'running',
        lastUsed: nowIso(),
        lastError: null,
      });
    } catch (_) { /* ignore */ }
    if (asJson) {
      emitJson({
        ok: true,
        master: {
          id: master.id,
          title: master.title,
          engine: master.engine,
          result: finalResult,
          plan: finalPlan,
          workerStatus: 'running',
          role: 'master',
        },
        herdr: plan,
      });
      reportHerdr(plan, { ...flags, json: true });
    } else {
      printSession(master, 'master');
      process.stdout.write(`  result:  ${finalResult}\n`);
      process.stdout.write(`  plan:    ${finalPlan}\n`);
      process.stdout.write(`  role:    master\n`);
      reportHerdr(plan, flags);
    }
    return;
  }

  master = registry.update(master.id, {
    workerStatus: 'running',
    lastUsed: nowIso(),
  });
  const { code, timedOut, outPath, stopped, result, runId, registryWriteError } = await executeHeadlessRun(master, {
    prompt: finalPrompt,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: false,
    json: asJson,
  });

  let workerStatus;
  if (stopped) workerStatus = 'stopped';
  else if (!timedOut && code === 0) workerStatus = 'done';
  else workerStatus = 'failed';
  try {
    master = registry.update(master.id, { workerStatus, runPid: null, runPgid: null });
  } catch (_) {
    /* ignore */
  }
  master = applyResultHandoffFallback(master, {
    code,
    timedOut,
    stopped,
    stdout: result && result.stdout,
    resultPath: finalResult,
    runId,
  });

  if (asJson) {
    emitJson({
      ok: code === 0 && !timedOut,
      master: {
        id: master.id,
        title: master.title,
        engine: master.engine,
        result: finalResult,
        plan: finalPlan,
        workerStatus,
        role: 'master',
        resultSource: master.resultSource || null,
        lastExit: timedOut ? 124 : code,
        lastOutput: outPath,
      },
      outputPath: outPath,
      outputExcerpt: runlib.outputExcerpt((result && result.stdout) || ''),
    });
  } else {
    printSession(master, 'master');
    process.stdout.write(`  result:  ${finalResult}\n`);
    process.stdout.write(`  plan:    ${finalPlan}\n`);
    process.stdout.write(`  role:    master\n`);
    process.stderr.write(`log: ${outPath}\n`);
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
      emitJson({ masters: rows });
      return;
    }
    if (rows.length === 0) {
      process.stdout.write('(no masters)\n');
      return;
    }
    process.stdout.write(
      `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('ENGINE', 8)} ${pad('KIDS', 5)} ${pad('RUN', 4)} ${pad('DONE', 5)} ${pad('FAIL', 5)} STATUS\n`
    );
    for (const r of rows) {
      process.stdout.write(
        `${pad(r.title, 24)} ${pad(displayId(r.id, ID_COL), ID_COL)} ${pad(r.engine, 8)} ${pad(String(r.childCount), 5)} ${pad(String(r.workerStatusCounts.running), 4)} ${pad(String(r.workerStatusCounts.done), 5)} ${pad(String(r.workerStatusCounts.failed), 5)} ${r.status}\n`
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
    const hand = orchestrate.handoffInfo(s, resultPath);
    const meta = orchestrate.waitOutcomeMeta(s, {
      runtime: e.runtime,
      exitCode: e.exitCode,
      agentState,
      derivedStatus: derived,
    });
    return {
      id: s.id,
      title: s.title,
      engine: s.engine || 'cursor',
      cwd: s.cwd,
      task: s.task || '',
      workerStatus: derived,
      outcome: meta.outcome,
      stateSource: meta.stateSource,
      conclusive: meta.conclusive,
      result: hand.result,
      resultExists: hand.resultExists,
      fresh: hand.fresh,
      stale: hand.stale,
      resultSource: hand.resultSource,
      handoff: hand.handoff,
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
    emitJson(rows);
    return;
  }
  if (rows.length === 0) {
    process.stdout.write(`(no workers under "${master.title}")\n`);
    return;
  }
  process.stdout.write(
    `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} ${pad('FOLDER', 20)} TASK\n`
  );
  for (const r of rows) {
    const folder = r.cwd ? path.basename(r.cwd) : '';
    process.stdout.write(
      `${pad(r.title, 24)} ${pad(displayId(r.id, ID_COL), ID_COL)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.handoff, 7)} ${pad(folder, 20)} ${r.task || ''}\n`
    );
  }
}

function cmdResult(argv) {
  const { args, flags } = parseArgs(argv);
  if (!args[0]) fail('usage: af result <id|title> [--path] [--json] [--require-fresh]');
  let session;
  try {
    session = registry.find(args[0]);
  } catch (err) {
    fail(err.message);
  }
  if (!session) fail(`session not found: ${args[0]}`);

  const asJson = Boolean(flags.json);
  const requireFresh = Boolean(flags['require-fresh']);
  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  const hand = orchestrate.handoffInfo(session, resultPath);

  if (flags.path) {
    if (asJson) emitJson({ path: resultPath, ...hand });
    else process.stdout.write(resultPath + '\n');
    return;
  }

  if (hand.resultExists) {
    if (hand.stale) {
      process.stderr.write(
        `warning: handoff at ${resultPath} is stale (mtime not after latest run)\n`
      );
    }
    const body = fs.readFileSync(resultPath, 'utf8');
    if (asJson) {
      emitJson({
        ok: !(requireFresh && hand.stale),
        path: resultPath,
        body,
        ...hand,
      });
    } else {
      process.stdout.write(body.endsWith('\n') ? body : body + '\n');
    }
    process.exitCode = requireFresh && hand.stale ? 1 : 0;
    return;
  }

  process.stderr.write(`no handoff yet at ${resultPath}\n`);
  const logFile = session.lastOutput;
  let tail = '';
  if (logFile && fs.existsSync(logFile)) {
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split(/\r?\n/);
    tail = lines.slice(-40).join('\n');
    if (!asJson) process.stdout.write(tail.endsWith('\n') ? tail : tail + '\n');
  }
  if (asJson) {
    emitJson({ ok: false, path: resultPath, body: tail || null, ...hand });
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

function snapshotWorkerRow(session, { herdrInfo = null, waitingHint = null, agentState = null } = {}) {
  const runtime = herdrInfo ? herdrInfo.runtime : null;
  const effectiveHint =
    runtime === 'running' && (agentState == null || agentState === '') ? null : waitingHint;
  const derived = orchestrate.deriveWorkerStatus(
    session,
    {
      runtime,
      exitCode: herdrInfo ? herdrInfo.exitCode : null,
      waitingHint: effectiveHint,
    },
    { isAlive: orchestrate.defaultIsAlive, hostname: os.hostname() }
  );
  const resultPath = session.result || orchestrate.defaultResultPath(session.id);
  const hand = orchestrate.handoffInfo(session, resultPath);
  const meta = orchestrate.waitOutcomeMeta(session, {
    runtime,
    exitCode: herdrInfo ? herdrInfo.exitCode : null,
    agentState,
    derivedStatus: derived,
  });
  return {
    id: session.id,
    title: session.title,
    engine: session.engine || 'cursor',
    workerStatus: derived,
    outcome: meta.outcome,
    stateSource: meta.stateSource,
    conclusive: meta.conclusive,
    agentState: meta.agentState,
    resultExists: hand.resultExists,
    fresh: hand.fresh,
    stale: hand.stale,
    resultSource: hand.resultSource,
    handoff: hand.handoff,
    result: hand.result,
    lastExit: session.lastExit != null ? session.lastExit : null,
    lastOutput: session.lastOutput || null,
  };
}

function waitNothingError() {
  let msg =
    'af wait: nothing to wait on. Pass worker ids/titles, or --parent <master>, or run inside a master (AGENTFLEET_ID) / worker (AGENTFLEET_PARENT).';
  try {
    const sessions = registry.list({ includeDone: true });
    const childParentIds = new Set(sessions.filter((s) => s.parent).map((s) => s.parent));
    const masters = sessions.filter(
      (s) => s.role === 'master' || childParentIds.has(s.id)
    );
    const active = [];
    for (const m of masters) {
      const kids = listChildrenOf(m.id);
      if (
        kids.some((k) => {
          const st = k.workerStatus || '';
          return st === 'queued' || st === 'running' || st === 'waiting';
        })
      ) {
        active.push(m);
      }
    }
    if (active.length === 1) {
      msg += `\ne.g. af wait --parent ${active[0].title}`;
    }
  } catch (_) {
    /* ignore */
  }
  fail(msg);
}

function resolveWaitTargets(args, flags = {}) {
  // Explicit worker ids/titles win over --parent.
  if (args.length > 0) {
    return args.map((q) => requireSession(q));
  }
  if (flags.parent && flags.parent !== true) {
    const master = requireSession(String(flags.parent));
    const kids = listChildrenOf(master.id);
    if (kids.length === 0) {
      fail(`af wait: master "${master.title}" has no workers`);
    }
    return kids;
  }
  const master = resolveChildrenMaster([], {});
  if (!master) {
    waitNothingError();
  }
  const kids = listChildrenOf(master.id);
  if (kids.length === 0) {
    fail(`af wait: master "${master.title}" has no workers`);
  }
  return kids;
}

/**
 * After a successful headless worker/master run, ensure a result handoff exists
 * (af writes a fallback from stdout when the agent did not).
 */
function applyResultHandoffFallback(session, { code, timedOut, stopped, stdout, resultPath, runId }) {
  if (stopped || timedOut || code !== 0) return session;
  const dest = resultPath || session.result;
  const source = orchestrate.ensureResultHandoff(session, {
    code,
    timedOut,
    stdout,
    resultPath: dest,
    runId: runId || session.runId,
  });
  if (!source) return session;
  const patch = { resultSource: source };
  if (source === 'worker' || source === 'af-fallback') {
    patch.resultRunId = runId || session.runId || null;
  }
  const wr = registry.criticalUpdate(session.id, patch, { phase: 'after-exit' });
  return wr.ok && wr.session ? wr.session : session;
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
  let sendGraceMs;
  try {
    sendGraceMs = orchestrate.resolveSendGraceMs({
      flag: flags['send-grace'],
      env: process.env,
    });
  } catch (_) {
    sendGraceMs = orchestrate.DEFAULT_SEND_GRACE_SEC * 1000;
  }
  if (flags['send-grace'] != null && flags['send-grace'] !== true) {
    const n = Number(flags['send-grace']);
    if (Number.isNaN(n) || n < 0) fail('--send-grace must be a non-negative number of seconds');
  }

  const targets = resolveWaitTargets(args, flags);
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
      let st = waitState.get(s.id) || { seenWorking: false, idleTicks: 0, noStateWarned: false };
      let waitingHint = null;
      let agentState = null;
      if (e.runtime === 'running') {
        let statusObj = e.status;
        if ((e.address || e.name) && fetchResult.ok) {
          const got = runHcCli(['get', '--json', e.address || e.name], { timeoutMs: 3000 });
          if (got.status === 0 && got.stdout) {
            try {
              const parsed = JSON.parse(got.stdout);
              if (parsed && Object.prototype.hasOwnProperty.call(parsed, 'status')) {
                statusObj = parsed.status;
              }
            } catch (_) {
              /* ignore */
            }
          }
        }
        agentState = orchestrate.agentStateFromHerdr({ status: statusObj });
        const next = orchestrate.detectWaitingTransition({
          agentState,
          seenWorking: st.seenWorking,
          idleTicks: st.idleTicks,
          lastSendAt: s.lastSendAt || null,
          sendGraceMs,
          now: Date.now(),
        });
        st = {
          seenWorking: next.seenWorking,
          idleTicks: next.idleTicks,
          noStateWarned: st.noStateWarned,
        };
        waitingHint = next.hint === 'waiting' ? 'waiting' : null;
      }
      waitState.set(s.id, st);
      const row = snapshotWorkerRow(s, {
        herdrInfo: { runtime: e.runtime, exitCode: e.exitCode },
        waitingHint,
        agentState,
      });
      rows.push(row);

      if (row.stateSource === 'none' && !st.noStateWarned) {
        process.stderr.write(
          `no agent state from Herdr for ${s.id}; cannot detect completion — use af tail / af result\n`
        );
        st.noStateWarned = true;
        waitState.set(s.id, st);
      }

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
        emitJson(rows);
      } else {
        process.stdout.write(
          `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} EXIT\n`
        );
        for (const r of rows) {
          process.stdout.write(
            `${pad(r.title, 24)} ${pad(displayId(r.id, ID_COL), ID_COL)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.handoff || (r.resultExists ? 'yes' : 'no'), 7)} ${r.lastExit != null ? r.lastExit : '-'}\n`
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
        emitJson(rows);
      } else {
        process.stderr.write(`wait: timed out after ${timeoutSec}s\n`);
        process.stdout.write(
          `${pad('TITLE', 24)} ${pad('ID', ID_COL)} ${pad('ENGINE', 8)} ${pad('WORKER', 8)} ${pad('HANDOFF', 7)} EXIT\n`
        );
        for (const r of rows) {
          process.stdout.write(
            `${pad(r.title, 24)} ${pad(displayId(r.id, ID_COL), ID_COL)} ${pad(r.engine, 8)} ${pad(r.workerStatus || '-', 8)} ${pad(r.handoff || (r.resultExists ? 'yes' : 'no'), 7)} ${r.lastExit != null ? r.lastExit : '-'}\n`
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
  const asJsonEarly = Boolean(flags.json);
  if (args.length < 2) fail('usage: af send <id|title> "text" [--timeout SEC] [--force] [--json]', { json: asJsonEarly });
  const session = requireSession(args[0]);
  const text = args.slice(1).join(' ');
  if (!text) fail('usage: af send <id|title> "text" [--timeout SEC] [--force] [--json]', { json: asJsonEarly });
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
    const runId = crypto.randomUUID();
    const runStartedAt = nowIso();
    let resultMtimeAtStart = null;
    const rp = session.result || orchestrate.defaultResultPath(session.id);
    try {
      if (fs.existsSync(rp)) resultMtimeAtStart = fs.statSync(rp).mtimeMs;
    } catch (_) {}
    const wr = registry.criticalUpdate(
      session.id,
      {
        workerStatus: 'running',
        lastSendAt: nowIso(),
        runId,
        runStartedAt,
        resultMtimeAtStart,
        resultRunId: null,
      },
      { phase: 'before-launch' }
    );
    registry.bestEffortUpdate(session.id, { lastUsed: nowIso() });
    if (!wr.ok) {
      fail(`critical registry write failed before send: ${wr.error}`, { json: asJsonEarly });
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

  const asJson = Boolean(flags.json);

  registry.update(session.id, {
    workerStatus: session.role === 'worker' ? 'running' : session.workerStatus,
    lastUsed: nowIso(),
    stopRequested: false,
    force,
  });

  const { code, timedOut, outPath, stopped, result, runId, registryWriteError } = await executeHeadlessRun(session, {
    prompt,
    force,
    outputFormat: 'text',
    trust,
    timeoutSec,
    silent: true,
    env: { ...process.env, ...envOverlay },
    quietCopilotHints: session.engine === 'copilot',
    json: asJson,
  });

  let workerStatus = null;
  if (session.role === 'worker' || session.role === 'master') {
    if (stopped) workerStatus = 'stopped';
    else if (!timedOut && code === 0) workerStatus = 'done';
    else workerStatus = 'failed';
    try {
      registry.update(session.id, { workerStatus, runPid: null, runPgid: null });
    } catch (_) {
      /* ignore */
    }
    applyResultHandoffFallback(session, {
      code,
      timedOut,
      stopped,
      stdout: result && result.stdout,
      resultPath,
      runId,
    });
    if (session.role === 'worker' && !asJson) {
      process.stderr.write(`send: ${session.title} → ${workerStatus} (log ${outPath})\n`);
    }
  }
  if (asJson) {
    emitJson({
      ok: code === 0 && !timedOut,
      session: {
        id: session.id,
        title: session.title,
        engine: session.engine || 'cursor',
        workerStatus,
      },
      lastExit: timedOut ? 124 : code,
      outputPath: outPath,
      outputExcerpt: runlib.outputExcerpt((result && result.stdout) || ''),
    });
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
    emitJson(allChildren ? results : results[0]);
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
  const dryRun = Boolean(flags['dry-run']);
  const srcDir = path.join(__dirname, '..', 'templates');
  const destDir = path.join(require('../lib/util').homeDir(), '.config', 'herdr-core', 'templates');
  if (!fs.existsSync(srcDir)) fail(`bundled templates not found at ${srcDir}`);
  const files = fs.readdirSync(srcDir).filter((f) => f.endsWith('.md'));
  let copied = 0;
  let skipped = 0;
  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
  for (const f of files) {
    const dest = path.join(destDir, f);
    if (fs.existsSync(dest) && !flags.force) {
      process.stderr.write(`skip ${dest} (exists; pass --force to overwrite)\n`);
      skipped++;
      continue;
    }
    if (dryRun) {
      process.stdout.write(`[dry-run] would install ${dest}\n`);
      copied++;
      continue;
    }
    fs.copyFileSync(path.join(srcDir, f), dest);
    process.stdout.write(`installed ${dest}\n`);
    copied++;
  }
  process.stderr.write(
    `herdr templates: ${dryRun ? 'would install' : 'installed'} ${copied}, skipped ${skipped}. Then: hc templates\n`
  );
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


function cmdDoctor(argv) {
  const { flags } = parseArgs(argv);
  const asJson = Boolean(flags.json);
  const checks = [];
  function add(name, ok, detail) {
    checks.push({ name, ok: Boolean(ok), detail: detail || null });
  }
  add('node', true, process.version);
  add('agentfleet_home', true, fleetDir());
  add('registry', true, fs.existsSync(registryPath()) ? registryPath() : `${registryPath()} (will create on first write)`);
  try {
    const eng = engine.resolveEngine({});
    add('default_engine', true, `${eng.engine} (from ${eng.source})`);
  } catch (err) {
    add('default_engine', false, err.message);
  }
  const hcPath = backends.resolveHcBin();
  const hcWhich = require('../lib/util').which('hc');
  add('hc_on_path', Boolean(hcWhich), hcWhich || hcPath);
  if (hcWhich) {
    const st = herdr.defaultRunHc(['server', 'status'], { timeoutMs: 3000 });
    add(
      'hc_server_status',
      st.status === 0,
      st.status === 0 ? (st.stdout || '').trim().slice(0, 200) : (st.stderr || st.stdout || `exit ${st.status}`).trim().slice(0, 200)
    );
    const ls = herdr.fetchHerdrTerminals({ timeoutMs: 3000 });
    add('hc_ls', ls.ok, ls.ok ? `${(ls.terminals || []).length} terminals` : ls.error);
  } else {
    add('hc_server_status', false, 'hc not on PATH');
    add('hc_ls', false, 'hc not on PATH');
  }
  try {
    const bin = cursor.resolveCursorBin();
    const present = Boolean(bin) && (fs.existsSync(bin) || Boolean(require('../lib/util').which(bin)));
    add('cursor_bin', present, bin);
  } catch (err) {
    add('cursor_bin', false, err.message);
  }
  try {
    const bin = copilot.resolveCopilotBin();
    const present = Boolean(
      process.env.AGENTFLEET_COPILOT_BIN || require('../lib/util').which('copilot') || (bin && fs.existsSync(bin))
    );
    add('copilot_bin', present, bin);
  } catch (err) {
    add('copilot_bin', false, err.message);
  }
  // copilot is optional; hc optional for plain-only workflows — still report but only fail on home/node/cursor when missing
  const ok = checks
    .filter((c) => !['copilot_bin', 'hc_on_path', 'hc_server_status', 'hc_ls'].includes(c.name))
    .every((c) => c.ok);
  if (asJson) {
    emitJson({ ok, checks });
  } else {
    for (const c of checks) {
      process.stdout.write(`${c.ok ? 'ok ' : '!! '} ${c.name}: ${c.detail || ''}\n`);
    }
    process.stdout.write(
      '\nHerdr smoke: hc server status && hc ls --json | head -c 200 && af ls\n'
    );
  }
  process.exitCode = ok ? 0 : 1;
}

function emitJson(value) {
  process.stdout.write(JSON.stringify(value, null, 2) + '\n');
}

function fail(msg, opts = {}) {
  const asJson = Boolean(opts && opts.json);
  if (asJson) {
    emitJson({ ok: false, error: String(msg) });
  } else {
    process.stderr.write(String(msg) + '\n');
  }
  process.exit(1);
}

/**
 * Launch sessions via Herdr with discovery refuse + per-id launch locks.
 * Dry-run never executes hc run / labels; discovery failure on dry-run plans as empty live.
 */
function launchViaHerdr(sessions, { dryRun = false, resumeOpts, flags = {}, json = false } = {}) {
  const discovery = herdr.fetchHerdrTerminals();
  if (!discovery.ok) {
    if (!dryRun) {
      fail(launch.discoveryRefuseMessage(discovery.error), { json });
    }
    process.stderr.write(`herdr: ${discovery.error || 'query failed'} (dry-run assuming none live)\n`);
  }
  const live = discovery.ok
    ? (discovery.terminals || [])
        .filter((t) => herdr.isLiveTerminal(t))
        .map((t) => ({
          name: t.name || null,
          labels: {
            ...(t.labels || {}),
            ...(t.afId ? { af_id: t.afId } : {}),
          },
          address: t.address || null,
          afId: t.afId || null,
        }))
    : [];

  if (dryRun) {
    return backends.executeResumeAll(sessions, {
      via: 'herdr',
      dryRun: true,
      resumeOpts,
      herdrLive: live,
    });
  }

  const allResults = [];
  const allCommands = [];
  for (const s of sessions) {
    let held = null;
    try {
      held = launch.tryAcquireLaunchLock(s.id);
      if (!held) {
        allResults.push({
          title: s.title,
          id: s.id,
          skipped: true,
          busy: true,
          name: null,
          error: 'already running/launching',
        });
        process.stderr.write(`skip "${s.title}": already running/launching\n`);
        continue;
      }
      const again = backends.fetchHerdrLive();
      if (!again.ok) {
        fail(launch.discoveryRefuseMessage(again.error), { json });
      }
      const plan = backends.executeResumeAll([s], {
        via: 'herdr',
        dryRun: false,
        resumeOpts,
        herdrLive: again.terminals,
      });
      if (plan.commands) allCommands.push(...plan.commands);
      if (plan.results) allResults.push(...plan.results);
    } finally {
      if (held) launch.releaseLaunchLock(held);
    }
  }
  return {
    backend: 'herdr',
    executed: true,
    commands: allCommands,
    results: allResults,
    discoveryOk: true,
    discoveryError: null,
  };
}

function herdrLaunchFailed(plan) {
  if (!plan || !plan.results) return null;
  for (const r of plan.results) {
    if (r.busy) return r.error || 'already running/launching';
    if (!r.skipped && r.status != null && r.status !== 0) {
      return (r.stderr && String(r.stderr).trim()) || `hc run failed (exit ${r.status})`;
    }
  }
  return null;
}

// `af ls | head` closes stdout early; exit quietly instead of crashing with EPIPE.
process.stdout.on('error', (err) => {
  if (err && err.code === 'EPIPE') process.exit(0);
  throw err;
});

main().catch((err) => {
  process.stderr.write(String(err && err.stack ? err.stack : err) + '\n');
  process.exit(1);
});
