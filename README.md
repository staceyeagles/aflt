# agentfleet (`af`)

Track Cursor CLI (`cursor-agent` / `agent`) chat sessions so you can resume a whole fleet after a restart or reboot, and run headless prompts from a controller (Grok Bot, scripts) that collects the output without babysitting a TUI.

Built for a macOS workflow (iTerm2 / tmux / WezTerm / Zellij-as-plain) with **one git worktree per agent**.

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

# Register an existing chat id
af add "payments" --chat aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee --cwd ~/src/app-wt-pay

# List (STATUS = lifecycle; HERDR = live process: running|exited|missing|unknown|-)
af ls
af ls --json
af sync --dry-run          # show Herdr runtime that would be persisted
af sync                    # persist herdr evidence (does not change status/lastUsed)

# Headless one-shot for a controller (create or resume, capture output, exit)
af run "auth-refactor" --prompt "Summarize the current branch" --mode ask --cwd ~/src/app-wt-auth
af log auth-refactor            # last captured output
af log auth-refactor --path

# Resume one in this terminal (sets OSC tab title)
af resume auth-refactor

# After reboot: reopen every active session
af resume --all --via tmux          # window per session in tmux session "agentfleet"
af resume --all --via iterm2        # AppleScript → new iTerm2 tab per session
af resume --all --via wezterm       # wezterm cli spawn + set-tab-title
af resume --all --via herdr         # hc run --bg … per session (skips ones already live)
af resume auth --via herdr          # one session in Herdr
af resume --all --via plain         # just print the commands
af resume --all --dry-run           # show plan without executing
```

## Reboot-recovery workflow

1. Boot, open your terminal multiplexer (tmux / iTerm2 / WezTerm).
2. `af ls` — confirm active sessions and worktree paths still exist.
3. `af resume --all` — auto-detects backend (`tmux` if `$TMUX` is set, else `TERM_PROGRAM`, else availability).
4. Attach / focus tabs and continue chatting. Context comes back via `--resume <chatId>`.

**Important:** resuming restores the **chat context** via `--resume <chatId>` and does **not** resend the saved original task prompt. A prompt is sent only on first launch (`af new --prompt`) or if you pass an explicit `--prompt` on that resume command. `af resume --all` relaunches `cursor-agent --resume …` only — it does not restart in-flight shell processes, servers, or watchers. Restart those yourself (or encode them in the session notes: `af note <id> "…"`).

## Commands

| Command | Purpose |
|---------|---------|
| `af new "<title>"` | `create-chat` → register → interactive `--resume` |
| `af add "<title>" --chat <id>` | Register an existing chat |
| `af import` | List `~/.cursor/chats` entries to pick from |
| `af ls [--json]` | Table: title, short id, folder, branch, STATUS, HERDR, last used |
| `af sync [--dry-run] [--json]` | Query `hc ls --all --json`; persist last-known Herdr runtime (not status) |
| `af run "<title>" --prompt "…"` | Headless create-or-resume; capture stdout to `~/.agentfleet/runs/` |
| `af log <title\|id>` | Print last captured run (or `--path`) |
| `af resume <title\|id>` | cd + resume one (interactive TUI) |
| `af resume --all [--tag X] [--via …]` | Fleet reopen (interactive) |
| `af herdr-templates` | Install Cursor/OpenCode templates into `~/.config/herdr-core/templates` |
| `af rename` / `af done` / `af rm` / `af note` | Metadata |
| `af export [file]` / `af import-file <file>` | Backup / restore registry |

Registry file: `~/.agentfleet/sessions.json` (atomic write: temp + rename). Override with `AGENTFLEET_HOME` or `AGENTFLEET_REGISTRY`.

Each entry stores: `id`, `title`, `chatId`, `cwd`, `branch`, `model`, `created`, `lastUsed`, `status` (`active`\|`paused`\|`done`), `tags`, `notes`, `prompt`, and optionally `herdr` (last-known runtime evidence from `af sync`).

### STATUS vs HERDR

- **STATUS** is the saved task lifecycle: `active` / `paused` / `done`. A process exit does **not** mark the task done — use `af done` when the work is finished.
- **HERDR** is read-only runtime enrichment on `af ls` (refetched each call from official `hc ls --all --json`):
  - `running` — exactly one live Herdr terminal labeled `af_id=<session.id>`
  - `exited` — exactly one finished terminal for that `af_id` (shows exit/reason when present)
  - `missing` — session was Herdr-involved (live match or prior `herdr` evidence) but no terminal matches now
  - `unknown` — ambiguous matches, or `hc` failed/timeout/malformed for a Herdr-involved session
  - `-` — not Herdr-involved (plain/tmux/iterm/wezterm/copilot, or never launched via herdr)
- `af ls` never writes the registry. `af sync` persists `herdr: { runtime, address, name, exitCode, reason, checkedAt }` without changing `status`, `lastUsed`, identity fields, or history. `--dry-run` prints the plan with no backup/write. On `hc` failure, sync exits nonzero and does not mutate the registry.
- Default `hc ls` hides finished terminals; `af` uses `hc ls --all` so finished shows as `exited`, not `missing`. Attach with `~/.local/bin/hc attach <name>`.

## Backends for `resume --all`

- **tmux** — windows in a named session (`agentfleet` by default; `AGENTFLEET_TMUX_SESSION` / `--tmux-session`).
- **iterm2** — `osascript` creates a titled tab per session (macOS).
- **wezterm** — `wezterm cli spawn --cwd … -- cursor-agent --resume …` then `set-tab-title`.
- **herdr** — `hc run --bg --no-parent --outlive-parent --name <slug> --cwd <cwd> --label af_id=<id> --label title=<title> env -u NO_COLOR -u FORCE_COLOR cursor-agent --resume …`. **Do not insert a `--` separator:** on herdr-core 0.1.16 (`hc run`, verified 2026-11-10 on the Mini) a `--` token is treated as the program name and fails with `spawn_failed` / `cannot start "--"`. The `env -u …` prefix clears Herdr/parent `NO_COLOR` / `FORCE_COLOR` so the Cursor TUI can use color. Names are lowercased, sanitized to `[a-z0-9_-]`, truncated to 32 chars and de-duplicated. Sessions whose `af_id` label already appears in `hc ls --json` are skipped. Works for `resume --all` and `resume <id>`. Bundled interactive templates (`af herdr-templates`) are `cursor` and `opencode` (`ready: quiet`, because those CLIs do not speak Herdr's OSC 7501 status protocol).
- **plain** — print shell commands (use this under Zellij or anything else).

Auto-detect order: `$AGENTFLEET_VIA` → inside Herdr (`$HERDR`/`$HC_TERMINAL` set and `hc` on PATH) → inside tmux → `TERM_PROGRAM` (WezTerm / iTerm) → `tmux` on PATH → `wezterm` → plain.

## Headless / controller usage

`af new` / `af resume` start the **interactive** Cursor TUI (or hand a TUI to Herdr/tmux). That is the right path when a person will attach and chat.

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

### Copilot CLI vs `gh`

These are different tools. `af --engine copilot` wraps the **GitHub Copilot CLI** (`copilot` / `gh copilot` preview wrapper), which has `-p/--prompt` and `--session-id=` (create or resume; `af` uses this, not `--resume=`, because a new UUID fails `--resume=`). It is **not** `gh` repository tooling (`gh pr`, `gh issue`, `gh repo`) and **not** `gh agent-task` (cloud agent tasks that can open PRs). `af` does not wrap `gh` and will not commit, push, or create agent tasks.

Copilot `--help` says **`--allow-all-tools` is required for non-interactive mode**, but a no-tool text prompt (`-p` "reply pong") **succeeded without it** on Copilot CLI 1.0.83 (Mini, 2026-11-10). `af run --engine copilot` therefore runs **without** `--allow-all-tools` unless you pass `--force`. `--force` adds only `--allow-all-tools` (not `--allow-all` / `--yolo`, which also disable path and URL checks). That `--force` grant is real: tools may edit files and run shell commands in the session cwd. Do not pass `--force` for a read-only/no-tool prompt. There is no Copilot equivalent of Cursor `--mode ask|plan` in the flags `af` uses. `--available-tools` / `--deny-tool` exist on `copilot` but are not wrapped by `af`.

`af` does not change account login state. Cursor must already be signed in (`cursor-agent status`). Copilot uses `copilot login` (or `COPILOT_GITHUB_TOKEN` / `GH_TOKEN` / `GITHUB_TOKEN`); there is no `copilot status`/`whoami` command. Auth for Copilot was confirmed by a successful live `-p` run, not by reading credential files.

Optional: Cursor also has `cursor-agent persist` (sessions that survive disconnects). `af` does not wrap it.

## Supported vs verified (home Mini, 2026-11-10)

| Path | Status |
|------|--------|
| Cursor `af run` (headless `-p`, including `--mode ask`) and output/`af log` | **Verified** live |
| Cursor `af resume --via herdr` (no `--` separator; default `--trust`) | **Verified** live |
| Copilot `af run --engine copilot` without `--force` (no-tool text prompt) | **Verified** live (see engine notes above) |
| Copilot `--force` / `--allow-all-tools` | Supported, **not** live-tested here (broad tool grant) |
| OpenCode | Herdr **template only**; not wrapped by `af run`; first-message send not live-tested |
| Herdr desktop app Cursor/OpenCode integrations | **Unconfigured** (`~/Applications/Herdr.app` present; `~/.config/herdr-app` absent) |
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
