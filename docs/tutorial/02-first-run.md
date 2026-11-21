# 02 — First session and run

**Goals**

- Distinguish interactive sessions from headless `aflt run`
- Register or create a session, list it, capture a run log
- Understand `--timeout`, `--dry-run`, and `--force`
- Know when to use `new` / `add` / `import`

Stay in the throwaway space: `--space tutorial` or `AFLT_SPACE=tutorial`. Do not call live engines from CI or hermetic tests; the dry-run examples below are safe.

## Headless vs interactive (high level)

| Mode | How | Notes |
|------|-----|--------|
| **Headless** | `aflt run`, `aflt spawn` (default), `aflt master --headless` | Print-mode; output under `runs/<id>/`; do **not** send `aflt run` through Herdr |
| **Interactive** | `aflt new`, `aflt resume`, `aflt master` (default), `aflt spawn --interactive` | TUI; Herdr when `hc` is on PATH |

Engine × mode behavior (liveness, wait, handoffs): [CAPABILITIES.md](../CAPABILITIES.md).

## Create / register

```bash
# Interactive: create-chat / mint UUID → register → launch
aflt --space tutorial new "pong-check" --cwd "$PWD" --dry-run

# Register an existing chat id (no launch of a new chat)
aflt --space tutorial add "my-chat" --chat <uuid> --cwd "$PWD"

# List local engine chats to register (Cursor / Copilot / OpenCode)
aflt --space tutorial import --engine cursor
```

`aflt new` with `--dry-run` prints the planned register + launch command without mutating when dry-run paths apply (see USAGE). Prefer `--dry-run` while learning.

Import scans engine homes (`~/.cursor/chats`, Copilot session-state, OpenCode). Default engine follows `AGENTFLEET_ENGINE` / config (builtin: cursor).

## Headless run

```bash
# Read-only probe (Cursor --mode ask). Omit --force.
aflt --space tutorial run "pong-check" \
  --prompt "Reply with the single word pong and nothing else." \
  --mode ask --cwd "$PWD" --timeout 180 --dry-run --json
```

Dry-run JSON includes `ok`, `dryRun: true`, `session`, and a `command` preview. Text dry-run prints a `cd "…" && …` line.

Editing work needs an explicit write grant:

```bash
# Only when you intend tools/writes. Include --force.
# Do not switch to plan mode; do not commit unless authorized.
aflt --space tutorial run "fix-tests" \
  --prompt "$(cat prompts/fix.txt)" \
  --force --cwd "$PWD" --timeout 600 --json
```

`--force` is a tool/write grant (Cursor auto-approves tools; Copilot maps to `--allow-all-tools`), not “skip the prompt.” Omit it for text-only / ask-mode work. Cursor workspace trust is `--trust` by default on `run` / `resume`; use `--no-trust` to keep the dialog.

### Timeouts

`aflt run` accepts `--timeout SEC`. If you omit `--timeout`, the CLI does **not** apply its own time limit (internal default is `0` — wait until the engine exits). Bound long or unattended work with an explicit `--timeout` (examples in [AGENTS.md](../../AGENTS.md) often use `180` or `600`). Timeout exits **124**.

## List, status, logs, resume

```bash
aflt --space tutorial ls
aflt --space tutorial ls --json
aflt --space tutorial ls --status active
aflt --space tutorial log pong-check          # last captured stdout
aflt --space tutorial log pong-check --path   # path under runs/<id>/
```

Empty registry:

```text
space: tutorial
(no sessions)
```

Table header (when sessions exist):

```text
TITLE                    ID       CHAT       ENGINE   FOLDER                   BRANCH       STATUS   HERDR    LAST USED
```

Resume interactive:

```bash
aflt --space tutorial resume pong-check --dry-run
# Default: Herdr when hc is on PATH (prints Attach: hc attach <name>)
# --here / --via plain: this terminal
```

Mark lifecycle done when the *task* is finished (process exit alone does not):

```bash
aflt --space tutorial done pong-check
```

## Detach (workers)

`aflt spawn` blocks until a headless worker finishes unless you pass **`--detach`**. Prefer `--detach` over shell `&`.

```bash
aflt --space tutorial spawn --parent <master> --prompt "…" --force --detach --dry-run --json
```

## Try it

Without calling a live engine, dry-run a headless run in the tutorial space and list sessions:

```bash
aflt space create tutorial   # if needed
aflt --space tutorial run "tutorial-dry" \
  --prompt "noop" --mode ask --cwd "$PWD" --dry-run --json
aflt --space tutorial ls --json
```

Confirm `"dryRun": true` and that you never pointed these commands at your default space.
