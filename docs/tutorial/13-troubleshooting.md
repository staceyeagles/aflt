# 13 — Troubleshooting and FAQ

**Goals**

- Start with `aflt doctor` and run logs
- Avoid PATH, timeout, help, and process-kill pitfalls from real use
- Keep secrets out of shells and commits

## First stops

```bash
aflt --space tutorial doctor
aflt --space tutorial doctor --json
aflt --space tutorial ls --json
aflt --space tutorial log <title|id> --path
```

Deeper environment notes: [SETUP.md](../SETUP.md). Engine wait/completion: [CAPABILITIES.md](../CAPABILITIES.md).

## Lessons from real use

### Timeouts on `aflt run`

Without `--timeout`, the CLI does not impose its own time limit (internal default `0` — wait until the engine exits). Long or unattended work should pass an explicit `--timeout SEC`. Examples in [AGENTS.md](../../AGENTS.md) often use `180` or `600`. On timeout, exit code is **124**.

```bash
aflt --space tutorial run "long-job" --prompt "$(cat prompt.txt)" --force --timeout 600 --json
```

### Wrong `agent` on PATH

Some machines have a different binary named `agent` (for example a Grok TUI) ahead of Cursor’s CLI. Prefer the Cursor binary explicitly and put `~/.local/bin` early on PATH:

```bash
export PATH="$HOME/.local/bin:$PATH"
export AGENTFLEET_CURSOR_BIN="$HOME/.local/bin/cursor-agent"
aflt doctor --json   # confirm cursor_bin detail
```

### Never pattern-matched kills

Do **not** use `pkill`, `killall`, or broad pattern kills for agents or Herdr. Only stop PIDs you started, via:

```bash
aflt stop <exact-id-or-title> --json
aflt stop --all-children <master> --json
```

### Prompts from files

Prefer file-backed prompts over embedding large text in double-quoted shell strings (quoting, history, and secret leakage):

```bash
aflt --space tutorial run "task" --prompt "$(cat ./prompts/task.txt)" --mode ask --timeout 180
```

### Never run subcommand `--help`

Use `aflt help` or `aflt` with no args. `aflt <command> --help` is **not** a dedicated help path — some commands print a short usage error; others (`ls`, `sync`, `import`, `doctor`, `setup`, `version`, …) may **run the command**.

### Never print secrets

Do not print `CURSOR_API_KEY`, notify keys, MCP auth, or `.env` values. `aflt doctor` reports notify status without printing the key. Do not commit webhook URLs or keys.

## More FAQs

**Why is `STATUS` still `active` after the process exited?**  
Lifecycle is separate from process exit. Use `aflt done` when the task is finished.

**Why does interactive Cursor `aflt wait` time out?**  
Cursor does not emit OSC 7501. Wait stays `running` until timeout (exit 2) or the terminal exits. Use `aflt tail` / `aflt result`, or Copilot interactive when you need `waiting`. Details: [CAPABILITIES.md](../CAPABILITIES.md).

**Shell-only Herdr tab after reboot?**  
`runtime=shell` → derived stopped for wait. Fix with `aflt resume <id>` (relaunches into the existing tab).

**Copilot folder-trust prompt?**  
Answer with `aflt send <id> "1"`.

**`aflt rm` / `purge` / `stop` fuzzy match?**  
Prefer exact id or title. Agents and `--json` / non-TTY never get interactive pickers — exact-only with a did-you-mean hint.

**Dashboard vs memory dashboard?**  
The live activity UI is `aflt dashboard --serve`. Regenerating memory-repo `DASHBOARD.md` only is `aflt memory dashboard`.

**Notify firing from a lab space?**  
New spaces start with notify off. Do not set `AFLT_NOTIFY_URL` globally while using a tutorial space unless you intend webhooks there.

**Where is token usage?**  
Recorded on turns under `runs/<id>/turns.jsonl` and rolled up in `usage-summary.json` (History + memory show compact counts). There is no dedicated `usage` subcommand — see [12 — Token usage](12-token-usage.md).

## Try it

```bash
aflt space create tutorial   # if needed
aflt --space tutorial doctor
aflt help | head -n 20
aflt --space tutorial space current
```

When finished with the whole tutorial, remove the throwaway space only after confirming the target name:

```bash
aflt space remove tutorial --force
```
