# hello-aflt — portable tile-dungeon loop example

Multi-phase `aflt loop` that builds a tile dungeon (M1–M4), adds an M5a eval harness, then runs at most three eval-gated improve rounds via `plan-next`.

Works on a **work Mac with Copilot CLI** (no Cursor, no Grok Bot required).

## Prerequisites

- Node ≥ 18
- `aflt` on `PATH` (`npm install -g aflt` or a linked checkout)
- An engine CLI: **GitHub Copilot CLI** recommended for this README (`npm install -g @github/copilot`). Cursor / OpenCode also work if configured as the default.
- A game repo checkout that starts from the M0 tile-dungeon scaffold (your working tree; not copied from another machine’s paths)

Not required: Cursor CLI, `AGENTFLEET_CURSOR_BIN`, Herdr, notify / Grok Bot webhooks.

## Engine default

This definition **omits** `engine` so phases inherit:

`--` (n/a) → `AGENTFLEET_ENGINE` → `$AGENTFLEET_HOME/config.json` `defaultEngine` → builtin `cursor`

On a Copilot-only Mac:

```bash
export AGENTFLEET_ENGINE=copilot
# or: aflt engine copilot
```

## Run from your game repo

`promptFile` and `improve-gate.js` resolve **relative to this definition directory**, while `"cwd": "."` follows your **shell cwd** (the game repo).

```bash
cd /path/to/your-tile-dungeon
aflt loop validate /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --json
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --dry-run --json

# Unattended (dashboard scheduler) or in-process:
aflt loop start /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --json
# or:
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --json
```

Optional: use a named space so the loop never writes the default home:

```bash
aflt space create hello-demo   # once
aflt --space hello-demo loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json
```

## Improve gate

`improve-gate.js` (Node, no bash/`/tmp` paths):

1. Measures overall with `node scripts/eval/eval.js --json` **before** comparison
2. Runs the game test suite
3. Measures again with `--json --write` **after** worker changes
4. Compares gate-owned before vs after — **never** the last line of `eval/history.jsonl`
5. On improvement → exit 0, keep changes  
   On plateau/regression → restore gameplay paths to `HEAD`, keep gate records, exit 0  
   On test failure or edits to locked `scripts/eval/eval.js` / `scorer.js` → exit 1

Plan-next instructs planned improve phases to use:

```json
"eval": { "command": ["node", "improve-gate.js"], "exitCode": 0 }
```

## Server port

Prompts discuss default **PORT 8792** for the comparison tree (8790/8791 often taken). Override with `PORT` in the game repo when needed.

## M5a metrics (do not invent)

The M5a prompt requires the same metric names, weights, and constants as the original tile-dungeon harness (`crash_free` 0.25, `solvability` 0.20, `avg_depth` 0.20, `turns_survived` 0.15, `balance_sanity` 0.20; `AVG_DEPTH_TARGET = 3.5`). Do not copy files from other checkouts — implement the harness in the game repo.

## Notify / Grok Bot

Optional. Point `notify.url` / `AFLT_NOTIFY_URL` at a webhook if you want progress events; the loop does not need a bot to continue.
