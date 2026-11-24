# Kick off loop development from the CLI (no assistant)

Copy-paste paths for a **fresh Mac**: install AgentFleet, sign in to an engine, run the **hello-aflt** tile-dungeon loop, and watch it in the dashboard. Aligned with [tutorial/01-install.md](tutorial/01-install.md), [SETUP.md](SETUP.md), and [tutorial/09-loops.md](tutorial/09-loops.md).

Self-improve loop (worktree + verify tiers): [self-improve-runbook.md](self-improve-runbook.md).

## 1. Install aflt

```bash
git clone https://github.com/wwlib/aflt.git ~/github/wwlib/aflt
cd ~/github/wwlib/aflt
npm link
# or: npm install -g .
# or: ln -sfn "$(pwd)/bin/af.js" ~/.local/bin/{aflt,af,agentfleet}
```

Ensure the npm global bin dir and `~/.local/bin` are on `PATH` (`which aflt`).

```bash
aflt --version
aflt setup --apply
```

## 2. Install and sign in to an engine

Add `~/.local/bin` to PATH if Cursor installed `cursor-agent` there:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Copilot (recommended for hello-aflt)

```bash
npm install -g @github/copilot
copilot
# complete browser / device sign-in
```

### Cursor

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent status
```

### Preflight

```bash
aflt doctor --strict
```

## 3. Model selection

Precedence for loop workers: phase `model` → definition `model` → `COPILOT_MODEL` (Copilot only) → `config.json` `defaultModel`. Example:

```bash
export COPILOT_MODEL=claude-sonnet-4.5
# or set "model" on the loop JSON / phase
```

## 4. Empty repo + isolated space

```bash
mkdir -p ~/tmp/td && cd ~/tmp/td
git init -b main
export AFLT_SPACE=td-copilot
export AGENTFLEET_ENGINE=copilot
```

## 5. Validate and run hello-aflt

Replace `AFLT_HOME` with your clone path.

```bash
AFLT_HOME=~/github/wwlib/aflt

aflt loop validate "$AFLT_HOME/examples/loops/hello-aflt/hello-aflt.json" --json
aflt loop run "$AFLT_HOME/examples/loops/hello-aflt/hello-aflt.json" --dry-run --json

aflt loop run "$AFLT_HOME/examples/loops/hello-aflt/hello-aflt.json"
```

### Background / scheduler (optional)

Does not block this terminal; dashboard scheduler runs phases when the server is up:

```bash
aflt loop start "$AFLT_HOME/examples/loops/hello-aflt/hello-aflt.json" --json
aflt dashboard --serve --port 8787
```

Then `aflt loop status hello-aflt --json`, `aflt loop pause hello-aflt`, `aflt loop resume hello-aflt`, `aflt loop stop hello-aflt`.

### Variant: build M0 from scratch (no seed code)

`examples/loops/hello-aflt-scratch/` runs the same milestones, but the seed is
instructions only (`AGENTS.md`, `SPEC.md`, `.agentfleet.json`, `.gitignore`):
no code, no HTML. M0 is a real agent build of the scaffold, checked by
`m0-check.js` (structure + `node --test` + server boot). Use a separate folder
and space so it does not collide with a `hello-aflt` run:

```bash
mkdir -p ~/tmp/td-scratch && cd ~/tmp/td-scratch && git init -b main
export AFLT_SPACE=td-scratch
aflt loop validate "$AFLT_HOME/examples/loops/hello-aflt-scratch/hello-aflt-scratch.json" --json
aflt loop run "$AFLT_HOME/examples/loops/hello-aflt-scratch/hello-aflt-scratch.json"
```

A `seed-docs` script phase (no AI call) copies the docs in and commits them before the M0 agent starts.

Status: `aflt loop status hello-aflt-scratch --json`. Details:
[examples/loops/hello-aflt-scratch/README.md](../examples/loops/hello-aflt-scratch/README.md).

## 6. Watch the dashboard

```bash
AFLT_SPACE=td-copilot aflt dashboard --serve --port 8787
```

Open `http://127.0.0.1:8787/` → Loops tab. Each loop has a **Making of** button (`http://127.0.0.1:8787/making-of/hello-aflt`).

## 7. See exactly how it was built (making of)

After (or during) a run, one command writes a self-contained page with every AI call in order — the prompt, the reply, reasoning, every tool call with its result, tokens, and Copilot AI credits / dollars as Copilot recorded them — plus every commit in the game repo with its phase, files and diff, the M0 seed files, files changed per phase, eval outputs and the final build:

```bash
AFLT_SPACE=td-copilot aflt making-of hello-aflt
# → ~/.agentfleet/spaces/td-copilot/loops/hello-aflt/making-of.html (open it in a browser)

AFLT_SPACE=td-copilot aflt making-of hello-aflt --out ~/Desktop/hello-aflt-making-of.html \
  --build-url http://127.0.0.1:8792/          # link the playable build
AFLT_SPACE=td-copilot aflt making-of hello-aflt --serve --port 8797   # live page + raw diffs
AFLT_SPACE=td-copilot aflt making-of hello-aflt --out site/making-of.html --with-files
# → site/making-of.html + site/making-of-files/ (every commit diff and seed/eval/tracked file
#   as a small HTML page, all linked) for any static host
```

What aflt records for this (per phase session, `$AGENTFLEET_HOME/runs/<session>/`):

| File | Contents |
|------|----------|
| `engine/copilot-<chatId>.events.jsonl` | Copy of Copilot's own session log (messages, tool calls + results, per-call usage and AI credits) |
| `engine/cursor-<chatId>-<time>.stream.jsonl` | Every Cursor `--output-format stream-json` event (loop phases now run Cursor in stream-json) |
| `engine/cursor-<chatId>.transcript.jsonl` | Copy of Cursor's agent transcript |
| `calls.jsonl` | One normalized line per model call: `phase, index, timestamp, engine, model, input, output, toolCalls, tokens, cost, costBasis` |
| `session-context.json` | System prompt(s), runtime instructions, tool-definition size — once per session |
| `usage-summary.json` | Token rollup; a headless run is counted once (Copilot `credits` / `usd` + `costBasis` when reported) |

Costs are never estimated: Copilot credits come from its usage records (1e9 nano-AIU = 1 credit = $0.01); Cursor reports tokens per run and no cost, so its page shows tokens only.

---

## Copilot one block

```bash
git clone https://github.com/wwlib/aflt.git ~/github/wwlib/aflt
cd ~/github/wwlib/aflt && npm link
npm install -g @github/copilot && copilot
export PATH="$HOME/.local/bin:$PATH"
aflt doctor --strict
mkdir -p ~/tmp/td && cd ~/tmp/td && git init -b main
export AFLT_SPACE=td-copilot AGENTFLEET_ENGINE=copilot
# optional: export COPILOT_MODEL=...
aflt loop run ~/github/wwlib/aflt/examples/loops/hello-aflt/hello-aflt.json
# another terminal:
AFLT_SPACE=td-copilot aflt dashboard --serve --port 8787
```

## Cursor one block

```bash
git clone https://github.com/wwlib/aflt.git ~/github/wwlib/aflt
cd ~/github/wwlib/aflt && npm link
curl https://cursor.com/install -fsS | bash
export PATH="$HOME/.local/bin:$PATH"
cursor-agent status
aflt doctor --strict
mkdir -p ~/tmp/td && cd ~/tmp/td && git init -b main
export AFLT_SPACE=td-cursor AGENTFLEET_ENGINE=cursor
aflt loop run ~/github/wwlib/aflt/examples/loops/hello-aflt/hello-aflt.json
# another terminal:
AFLT_SPACE=td-cursor aflt dashboard --serve --port 8787
```