# agentfleet (`af`)

Track Cursor CLI (`cursor-agent` / `agent`) and optional GitHub Copilot CLI chat sessions so you can resume a whole fleet after a restart or reboot, and run headless prompts from a controller (Grok Bot, scripts) that collects the output without babysitting a TUI.

Built for a macOS workflow (Herdr / iTerm2 / tmux / WezTerm / Zellij-as-plain) with **one git worktree per agent**. Sessions launched in Herdr also show up in the native Herdr desktop app (one space per repo, one tab per session).

## Why Node?

Zero runtime dependencies beyond Node ≥18. A single `npm i -g .` installs both `agentfleet` and the short alias `af`. The Cursor CLI itself ships as a Node binary, so the toolchain is already familiar.

## Install

```bash
# requires Node 18+
cd agentfleet
npm install -g .

# or without global install:
npm link
# or:
alias af='node /path/to/agentfleet/bin/af.js'
```

Requires the Cursor CLI:

```bash
curl https://cursor.com/install -fsS | bash
# provides `agent` and `cursor-agent`
```

Optional shell completion (bash):

```bash
source /path/to/agentfleet/completions/af.bash
```

## Verified Cursor CLI facts

| Fact | Source | Notes |
|------|--------|-------|
| `agent` / `cursor-agent` are the same binary | Installer on Linux x64 (2026.10.22-27dcf5f) | Both symlinked from `~/.local/bin` |
| `create-chat` prints a UUID and exits (may linger briefly) | Ran on box; also [docs parameters](https://cursor.com/docs/cli/reference/parameters) | Wrapper takes the first line then SIGTERM |
| `--resume [chatId]` resumes a session | Official docs + `--help` | Also `agent resume` (latest) and `--continue` (`--resume=-1`) |
| `ls` is interactive-only | `--help` has no flags; [forum confirmation](https://forum.cursor.com/t/cli-headless-doesnt-work-with-ls-no-way-to-get-a-list-of-chat-ids/151821) | `af import` scans `~/.cursor/chats/` instead |
| `--output-format json\|stream-json` works with `--print` | Official docs | **Unverified here:** community reports `session_id` on stream-json events; we prefer `create-chat` so we never depend on scraping streams |
| Local store `~/.cursor/chats/<md5(cwd)>/<chatId>/` | Community research (deja-vu / DoubleAgent) | **Partially unverified on this box:** `create-chat` alone did not create `~/.cursor/chats/` until a prompt was sent |
| Resume is workspace-scoped | [Forum](https://forum.cursor.com/t/cli-agent-in-one-session-forgets-everything-when-switching-to-new-root/162955) | `af` always passes `--workspace` / launches in the recorded cwd |

## Quick start

```bash
# New tracked session (creates chat id, registers, launches interactively)
af new "auth-refactor" --cwd ~/src/app-wt-auth --prompt "Refactor auth to JWT" --model gpt-5

# Copilot interactive (mints a UUID, uses --session-id=; no Cursor create-chat)
af new "copilot-probe" --engine copilot --cwd ~/src/app --prompt "Reply pong"
af copilot   # set default engine so --engine is optional for new sessions

# Register an existing chat id
af add "payments" --chat aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee --cwd ~/src/app-wt-pay
af add "copilot-existing" --engine copilot --chat <uuid> --cwd ~/src/app

# List (STATUS = lifecycle; HERDR = live process: running|exited|missing|unknown|-)
af ls
af ls --json
af sync --dry-run          # show Herdr runtime that would be persisted
af sync                    # persist herdr evidence (does not change status/lastUsed)

# Headless one-shot for a controller (create or resume, capture output, exit)
af run "auth-refactor" --prompt "Summarize the current branch" --mode ask --cwd ~/src/app-wt-auth
af log auth-refactor            # last captured output
af log auth-refactor --path

# Resume one (default: Herdr when hc is on PATH; prints Attach: hc attach <name>)
af resume auth-refactor
af resume auth-refactor --open      # also open an iTerm2 tab running hc attach
af resume auth-refactor --here      # old behavior: Cursor TUI in this terminal

# Interactive multi-select (TTY only)
af resume                           # or: af resume -i  /  af pick

# After reboot: reopen every active session
af resume --all --via tmux          # window per session in tmux session "agentfleet"
af resume --all --via iterm2        # AppleScript → new iTerm2 tab per session
af resume --all --via wezterm       # wezterm cli spawn + set-tab-title
af resume --all --via herdr         # hc run --bg … per session (skips ones already live)
af resume auth --via herdr          # one session in Herdr (same as the default)
af resume --all --via plain         # just print the commands
af resume --all --dry-run           # show plan without executing
af adopt --all                      # label already-live af terminals for the Herdr app
```

## Reboot-recovery workflow

1. Boot, open your terminal multiplexer (tmux / iTerm2 / WezTerm).
2. `af ls` — confirm active sessions and worktree paths still exist.
3. `af resume --all` — auto-detects backend (`tmux` if `$TMUX` is set, else `TERM_PROGRAM`, else availability).
4. Attach / focus tabs and continue chatting. Context comes back via `--resume <chatId>`.

**Important:** resuming restores the **chat context** (Cursor `--resume <chatId>`, Copilot `--session-id=<uuid>`) and does **not** resend the saved original task prompt. A prompt is sent only on first launch (`af new --prompt`) or if you pass an explicit `--prompt` on that resume command. `af resume --all` relaunches each session with its recorded engine only — it does not restart in-flight shell processes, servers, or watchers. Restart those yourself (or encode them in the session notes: `af note <id> "…"`).

## Commands

| Command | Purpose |
|---------|---------|
| `af new "<title>" [--engine …]` | Create chat / mint Copilot UUID → register → interactive launch |
| `af add "<title>" --chat <id> [--engine …]` | Register an existing chat (Copilot: `--chat` is the session UUID) |
| `af import` | List `~/.cursor/chats` entries to pick from |
| `af ls [--json]` | Table: title, short id, ENGINE, folder, branch, STATUS, HERDR, last used (`--json` always includes `engine`, default `cursor`) |
| `af sync [--dry-run] [--json]` | Query `hc ls --all --json`; persist last-known Herdr runtime (not status) |
| `af run "<title>" --prompt "…"` | Headless create-or-resume; capture stdout to `~/.agentfleet/runs/` |
| `af log <title\|id>` | Print last captured run (or `--path`) |
| `af spawn --parent … --prompt …` | Create a worker under a master (headless by default; `--interactive` → Herdr) |
| `af children [<id\|title>]` | List workers for a master, or summarize masters |
| `af result <id\|title>` | Print a worker handoff file (or `--path`) |
| `af resume <title\|id>` | Resume one (argv from `session.engine`). Default: Herdr when `hc` is on PATH; prints `Attach: hc attach <name>`. `--here` / `--via plain` = this terminal. `--open` = new iTerm2 attach tab (default in an iTerm TTY). `--force` → Copilot `--allow-all-tools` only. |
| `af resume` / `af pick` | Interactive multi-select (TTY only; shows ENGINE); resume via Herdr |
| `af resume --all [--tag X] [--via …]` | Fleet reopen (mixed engines OK; `--all` still auto-detects backend; not default-Herdr) |
| `af adopt <title\|id …>` / `af adopt --all` | Label live af Herdr terminals with `herdr.space` / `herdr.tab` + `hc keep` so they appear in the desktop app |
| `af cursor` / `af copilot` | Set default engine for **new** sessions (`~/.agentfleet/config.json`) |
| `af engine [cursor\|copilot]` | Print default engine + source (flag/env/config/builtin), or set it |
| `af herdr-templates` | Install Cursor/OpenCode/Copilot templates into `~/.config/herdr-core/templates` |
| `af herdr-app install` / `status` | Install the af-sessions Herdr panel + `af` layout (symlink by default) |
| `af rename` / `af done` / `af rm` / `af note` | Metadata |
| `af export [file]` / `af import-file <file>` | Backup / restore registry |

Registry file: `~/.agentfleet/sessions.json` (atomic write: temp + rename). Override with `AGENTFLEET_HOME` or `AGENTFLEET_REGISTRY`. Default engine config: `~/.agentfleet/config.json` (separate file).

Each entry stores: `id`, `title`, `chatId`, `cwd`, `branch`, `model`, `engine` (`cursor`\|`copilot`, default `cursor`), `created`, `lastUsed`, `status` (`active`\|`paused`\|`done`), `tags`, `notes`, `prompt`, and optionally `herdr` (last-known runtime evidence from `af sync`). Orchestrator fields (stage 1): `parent`, `role`, `task`, `result`, `workerStatus` (see below).

### Default engine

For **new** sessions (`af new`, `af add`, `af run` when the title is not already registered), engine resolution is:

1. Explicit `--engine cursor|copilot`
2. `AGENTFLEET_ENGINE` env
3. `defaultEngine` in `$AGENTFLEET_HOME/config.json`
4. Builtin `cursor`

Existing sessions always keep their recorded `engine`. `af run` on an existing session without `--engine` is never blocked by a differing default; only an explicit `--engine` that mismatches the session errors.

### STATUS vs HERDR

- **STATUS** is the saved task lifecycle: `active` / `paused` / `done`. A process exit does **not** mark the task done — use `af done` when the work is finished.
- **HERDR** is read-only runtime enrichment on `af ls` (refetched each call from official `hc ls --all --json`):
  - `running` — exactly one live Herdr terminal labeled `af_id=<session.id>` (finished history with the same id is ignored)
  - `exited` — no live match, but one or more finished terminals for that `af_id` (uses the most recent / highest address)
  - `missing` — session was Herdr-involved (live match or prior `herdr` evidence) but no terminal matches now
  - `unknown` — several live matches, or `hc` failed/timeout/malformed for a Herdr-involved session
  - `-` — not Herdr-involved (plain/tmux/iterm/wezterm/copilot, or never launched via herdr)
- `af ls` never writes the registry. `af sync` persists `herdr: { runtime, address, name, exitCode, reason, checkedAt }` without changing `status`, `lastUsed`, identity fields, or history. `--dry-run` prints the plan with no backup/write. On `hc` failure, sync exits nonzero and does not mutate the registry.
- Default `hc ls` hides finished terminals; `af` uses `hc ls --all` so finished shows as `exited`, not `missing`. Attach with `~/.local/bin/hc attach <name>`.

## Backends for `resume --all`

- **tmux** — windows in a named session (`agentfleet` by default; `AGENTFLEET_TMUX_SESSION` / `--tmux-session`).
- **iterm2** — `osascript` creates a titled tab per session (macOS).
- **wezterm** — `wezterm cli spawn --cwd … -- <engine argv>` then `set-tab-title`.
- **herdr** — `hc run --bg --no-parent --outlive-parent --name <slug> --cwd <cwd> --label af_id=<id> --label title=<title> [--keep --label herdr.space=… --label herdr.tab=…] env -u NO_COLOR -u FORCE_COLOR <engine argv>`. Cursor sessions use `cursor-agent --resume … --workspace … --trust`; Copilot sessions use `copilot --session-id=<uuid> -C <cwd>` (no `--trust`/`--workspace`). **Do not insert a `--` separator:** on herdr-core 0.1.16 (`hc run`, verified 2026-11-10 on the Mini) a `--` token is treated as the program name and fails with `spawn_failed` / `cannot start "--"`. The `env -u …` prefix clears Herdr/parent `NO_COLOR` / `FORCE_COLOR` so the TUI can use color; if the caller's `TERM` is unset, empty, or `dumb` (common for non-TTY af callers), it also sets `TERM=xterm-256color` and `COLORTERM=truecolor`. Names are lowercased, sanitized to `[a-z0-9_-]`, truncated to 32 chars and de-duplicated. Sessions whose `af_id` label already appears in `hc ls --json` are skipped. After launch or skip, `af resume` (default Herdr when `hc` is on PATH) and `af resume --via herdr` print a copy-pasteable `Attach: hc attach <name>`. In an iTerm2 TTY, `--open` is the default and opens a new tab running `hc attach` with an absolute `hc` path (pass `--no-open` to only print the line). Works for `resume --all --via herdr` and `resume <id>`. Bundled interactive templates (`af herdr-templates`) are `cursor`, `opencode`, and `copilot` (`ready: quiet`, because those CLIs do not speak Herdr's OSC 7501 status protocol).
- **plain** — print shell commands (use this under Zellij or anything else).

### Herdr app

The Herdr desktop app (herdr-app) shows any core terminal that carries labels `herdr.space=<id>` and `herdr.tab=<id>`. Unknown ids become a new space/tab automatically.

- **Ids:** `sp` + md5hex(`agentfleet:space:` + normalized cwd) and `tb` + md5hex(`agentfleet:tab:` + session id). Same repo/cwd → same space; one tab per af session (stable across resumes).
- **On launch:** `af resume` / `--via herdr` / interactive pick / `resume --all --via herdr` add `--keep` plus those labels (before the `env -u …` argv), then best-effort `herdr-app do tab.rename` to the af title (retries ~3s; never fails the resume if rename misses).
- **Opt out:** `--no-herdr-app`, or `AGENTFLEET_HERDR_APP=0|false|off|no`. Override the app binary with `AGENTFLEET_HERDR_APP_BIN`.
- **Already-running terminals:** `af adopt <title|id …>` or `af adopt --all` runs `hc label` + `hc keep` (skips label/keep when labels already match; still tries tab rename).
- **Agents panel:** Cursor does not report OSC 7501, so the app's Agents panel stays empty for these sessions.
- **Keep:** core `--keep` / `hc keep` means a lost program is replaced with a shell — Cursor is **not** re-run. Use `af resume` again to relaunch the agent.

Auto-detect order: `$AGENTFLEET_VIA` → inside Herdr (`$HERDR`/`$HC_TERMINAL` set and `hc` on PATH) → inside tmux → `TERM_PROGRAM` (WezTerm / iTerm) → `tmux` on PATH → `wezterm` → plain.

### Herdr app panel

The repo ships an **af sessions** panel (`herdr/mods/af-sessions`) and an `af` layout (`herdr/layouts/af.json`) that adds it under Agents in a clone of `main`.

```bash
af herdr-app install              # symlink into ~/.config/herdr-app
af herdr-app install --copy       # copy instead of symlink
af herdr-app status               # linked / copied / missing
# Override target: HERDR_APP_HOME=/path af herdr-app install
```

Switch layouts with `ctrl-shift-l`, or:

```bash
herdr-app do layout.switch --name af
herdr-app do layout.switch --name main
```

Symlinked edits are not hot-reloaded (the app watches `~/.config/herdr-app`, not the link targets): after editing the repo copy, switch layouts away and back (`ctrl-shift-l`) or restart the app. Verified on herdr-app 0.1.15.

Escape hatch (always works): `ctrl-alt-shift-escape` restores the default `main` layout. The panel lists sessions from `af ls --json` (title, folder, branch, engine, lifecycle, Herdr runtime dot, last used; Copilot rows show a small `copilot` marker); click a running row to focus its space/tab, or a stopped one to `af resume … --no-open` (`af` picks the session engine).

## Master and worker agents (stage 1)

A session can act as a **master** that spawns **worker** agents. Lifecycle `status` (`active`|`paused`|`done`) is unchanged. Workers add a separate run-state field.

**Registry fields** (backward compatible; absent on older rows):

| Field | Values | Notes |
|-------|--------|-------|
| `parent` | af id \| `null` | Master session id for workers |
| `role` | `master` \| `worker` \| `null` | Set to `master` automatically on first `af spawn` |
| `task` | string | Short goal; defaults to first ~80 chars of `--prompt` |
| `result` | absolute path \| `null` | Worker handoff file; default `$AGENTFLEET_HOME/results/<id>.md` |
| `workerStatus` | `queued`\|`running`\|`waiting`\|`done`\|`failed`\|`stopped` \| `null` | Headless: queued → running → done/failed. Interactive: stored `running` at launch; `af children` derives from Herdr when possible |

**Commands:**

```bash
# Headless worker (same print-mode machinery as af run)
af spawn --parent auth-refactor --prompt "Extract JWT helpers into lib/auth.js" --task "JWT helpers"

# Interactive worker in Herdr (wrapped prompt as initial message)
af spawn --parent auth-refactor --prompt "…" --interactive

# List workers / masters
af children auth-refactor
af children auth-refactor --json
af children                 # masters summary, or AGENTFLEET_ID / AGENTFLEET_PARENT
af children --all           # include lifecycle-done masters in the summary

# Read handoff (exit 1 if missing; falls back to last ~40 lines of run log)
af result auth-refactor-w1
af result auth-refactor-w1 --path
```

**Env vars set on spawned workers** (headless child and Herdr `env …` prefix): `AGENTFLEET_ID` (worker id), `AGENTFLEET_PARENT` (master id), `AGENTFLEET_RESULT` (handoff path). Ordinary `af run` / `af new` also set `AGENTFLEET_ID` when launching.

The worker prompt is wrapped with instructions to write a markdown handoff (`Summary`, `Files changed`, `Open questions`) to `result` and not to commit/push.

Because the handoff lives outside the worker's folder, af passes `--add-dir <results dir>` to Copilot and Cursor for any session with a `result` path (Copilot otherwise refuses to write there). `workerStatus` reflects the exit code only; the `HANDOFF` column in `af children` (and `resultExists` in `--json`) shows whether the worker actually wrote its handoff.

## Master and worker agents (stage 2)

Stage 2 adds wait / tail / send / stop so a master (or script) can drive workers without babysitting TUIs.

**Extra registry fields** (set on headless runs): `runPid`, `runPgid`, `runHost`, `runStartedAt`, `stopRequested`, `force` (spawn's `--force`, reused by `af send`). Headless engines spawn detached in their own process group (still awaited) so `af stop` can SIGTERM/SIGKILL the group. Run logs stream stdout while the engine runs (`lastOutput` is set at start) so `af tail -f` works mid-flight. A stored `workerStatus: running` whose `runPid` is dead on the same host is derived as `failed` (or `stopped` if `stopRequested`).

**Commands:**

```bash
# Block until workers finish (default: all listed; --any: first terminal status)
af wait auth-refactor-w1 auth-refactor-w2
af wait --any --timeout 600 --interval 2
af wait --json                 # children of AGENTFLEET_ID / AGENTFLEET_PARENT

# Follow output
af tail auth-refactor-w1 -n 80
af tail auth-refactor-w1 -f    # until worker leaves running (or Ctrl-C)

# Continue / nudge
af send auth-refactor-w1 "Also cover the error path"   # headless: resume chat
af send auth-refactor-w1 "looks good, ship notes"      # interactive: hc send

# Stop
af stop auth-refactor-w1
af stop --all-children auth-refactor
```

**`af wait` exit codes** (precedence: timeout → failed/stopped → waiting → ok):

| Code | Meaning |
|------|---------|
| 0 | All watched workers `done` (none failed/stopped/waiting) |
| 1 | At least one `failed` or `stopped` |
| 2 | `--timeout` elapsed |
| 3 | At least one `waiting` (needs input) and none failed/stopped |

Interactive `waiting` is best-effort from Herdr agent state (`hc get --json` → `status.state`: `idle`\|`working`\|`done`\|`blocked`\|`error`, via OSC 7501). Cursor does **not** emit OSC 7501 (`status` stays null). When status is present: `blocked` → `waiting`; after a `working` sighting, `idle` for ≥ one `--interval` → `waiting`.

**Master loop example:**

```bash
af spawn --parent auth-refactor --prompt "Extract JWT helpers" --task "JWT"
af spawn --parent auth-refactor --prompt "Add unit tests for auth" --task "tests"
af wait --any --timeout 900
af result auth-refactor-w1          # or whichever finished
af send auth-refactor-w1 "Tighten the Open questions section"
af wait auth-refactor-w1
af stop --all-children auth-refactor   # cancel stragglers
```

`af send` on a non-worker session is allowed (headless continue / `hc send` when live). Headless send refuses with exit 1 while `runPid` is alive.

## Headless / controller usage

`af new` / `af resume` start the **interactive** Cursor or Copilot TUI (or hand a TUI to Herdr/tmux). That is the right path when a person will attach and chat.

`af run` is the path for a controller that must launch a prompt, wait, and collect the result:

```bash
# Read-only Q&A (Cursor --mode ask; no --force)
af run "probe" --prompt "Reply with the single word pong." --mode ask --cwd "$PWD"

# Read-only plan
af run "probe" --prompt "Outline a fix for the failing test." --mode plan --cwd "$PWD"

# Editing run: --force maps to cursor-agent --force (allow commands unless denied).
# Only use this when the task is supposed to edit or run tools.
af run "probe" --prompt "Fix the failing unit test." --force --cwd "$PWD"

# Optional Copilot CLI engine (see caveats below)
af run "probe" --engine copilot --prompt "Reply pong." --cwd "$PWD" --dry-run
af run "probe" --engine copilot --prompt "Reply pong." --cwd "$PWD" --force

# Last output is also on disk
af log probe
```

Stdout is the agent's print-mode output. Stderr has progress, the agent's own stderr, and a final `output: <path>` line. Exit status is the CLI's (124 on `--timeout`). `af` always records `--workspace` / `-C` from the session cwd.

Headless Cursor flags actually used (verified against `cursor-agent --help` on the Mini, 2026.11.10-731fb78): `-p`, `--output-format`, `--resume`, `--workspace`, `--model`, `--mode ask|plan`, `--force`, `--trust`.

**`--trust` (Cursor only, documented default):** `af run`, `af new`, and `af resume` (including `--via herdr`) pass `--trust` unless you pass `--no-trust`. That only skips Cursor's "Workspace Trust Required" dialog in a cwd already stored in the registry. It does **not** auto-approve tool or shell calls. Dry-run prints the flag so the caller can see it. `--force` is a separate, off-by-default grant (Cursor `--force`).

**Do not** send `af run` through Herdr. Herdr's own skill tells agents to keep TUIs interactive and watchable (`hc --skill`). Use `af resume --via herdr` or `hc run cursor "task"` for a long-lived terminal; use `af run` for a one-shot that returns output.

### Copilot CLI (interactive + headless)

These are different tools. `af --engine copilot` wraps the **GitHub Copilot CLI** (`copilot` / `gh copilot` preview wrapper). It is **not** `gh` repository tooling (`gh pr`, `gh issue`, `gh repo`) and **not** `gh agent-task` (cloud agent tasks that can open PRs). `af` does not wrap `gh` and will not commit, push, or create agent tasks.

**Interactive** (verified Copilot CLI 1.0.109): `af new --engine copilot` mints a UUID locally, records `engine: 'copilot'`, and launches `copilot --session-id=<uuid> -C <cwd> [-i <prompt>]`. Resume uses the same `--session-id=` flag (create-or-resume). Do **not** use Copilot `--resume=` for a freshly minted id — it fails. Cursor flags `--trust` / `--workspace` do not apply. `--force` on resume/new adds only `--allow-all-tools`.

**Headless:** `-p/--prompt` and `--session-id=` (same create-or-resume). Copilot `--help` says **`--allow-all-tools` is required for non-interactive mode**, but a no-tool text prompt (`-p` "reply pong") **succeeded without it** on Copilot CLI 1.0.83 (Mini, 2026-11-10). `af run --engine copilot` therefore runs **without** `--allow-all-tools` unless you pass `--force`. `--force` adds only `--allow-all-tools` (not `--allow-all` / `--yolo`). There is no Copilot equivalent of Cursor `--mode ask|plan` in the flags `af` uses.

`af` does not change account login state. Cursor must already be signed in (`cursor-agent status`). Copilot: run `copilot` once to sign in (or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`); there is no `copilot status`/`whoami` command.

Optional: Cursor also has `cursor-agent persist` (sessions that survive disconnects). `af` does not wrap it.

## Supported vs verified (home Mini, 2026-11-10 / 2026-11-11)

| Path | Status |
|------|--------|
| Cursor `af run` (headless `-p`, including `--mode ask`) and output/`af log` | **Verified** live |
| Cursor `af resume --via herdr` (no `--` separator; default `--trust`) | **Verified** live |
| Copilot `af run --engine copilot` without `--force` (no-tool text prompt) | **Verified** live (see engine notes above) |
| Copilot interactive `af new` / `af resume` (`--session-id=`, CLI 1.0.109) | Supported (argv builders + dry-run tests); live interactive not required for CI |
| Copilot `--force` / `--allow-all-tools` | Supported, **not** live-tested here (broad tool grant) |
| OpenCode | Herdr **template only**; not wrapped by `af run`; first-message send not live-tested |
| Herdr desktop app (0.1.15, herdr-core 0.1.16): af sessions appear as space/tab via `herdr.space`/`herdr.tab` labels, tab renamed to af title | **Verified** live (2026-11-11) |
| `af adopt` on an already-live terminal | **Verified** live on a throwaway terminal |
| Cursor color in Herdr from a non-TTY / `TERM=dumb` caller (`TERM=xterm-256color` fallback) | **Verified** live |
| Herdr app Agents panel status for Cursor | **Not supported** (Cursor does not emit OSC 7501) |
| Reboot persistence of resumed terminals | **Not tested** |

## Tests

```bash
npm test
```

Unit tests cover the registry, command builders (tmux / WezTerm / AppleScript / Herdr), headless Cursor and Copilot argv, captured-process helpers, and `af run --dry-run`. A stub `cursor-agent` records arguments; if a real binary is present, `create-chat` is smoke-tested.

## Caveats

- `cursor-agent ls` cannot be scraped; import is best-effort from the local chat store.
- Empty chats from `create-chat` may not appear under `~/.cursor/chats/` until the first prompt.
- Always resume with the **same cwd/workspace** the chat was created in.
- iTerm2 / WezTerm backends need those apps installed; on Linux CI only tmux/plain are exercised.
- This tool does not implement Zellij integration beyond `--via plain`.
