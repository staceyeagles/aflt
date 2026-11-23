# hello-aflt — portable tile-dungeon loop example

## Quick start (one command)

From scratch on a work Mac (Copilot CLI is enough; no Grok Bot, no Cursor pin):

```bash
mkdir tile-dungeon && cd tile-dungeon && git init
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json
```

That single command scaffolds M0 if the tree is empty, then drives M1–M4, M5a, and up to 3 plan-next improve rounds. `aflt loop` is the orchestrator; Copilot/Cursor are only workers.

Copilot default (once per machine):

```bash
export AGENTFLEET_ENGINE=copilot
# or: aflt engine copilot
```

Then the same `aflt loop run …/hello-aflt.json` command.

Already have M5a and want more improve rounds (distinct loop name, no collision with a finished `hello-aflt`):

```bash
cd /path/to/existing-game
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt-improve.json
```

---

Multi-phase `aflt loop` that builds a tile dungeon (M0 seed → M1–M4 → M5a eval harness → at most three eval-gated improve rounds via `plan-next`).

Works on a **work Mac with Copilot CLI** (no Cursor, no Grok Bot required).

## Prerequisites

- Node ≥ 18
- `aflt` on `PATH` (`npm install -g aflt` or a linked checkout)
- An engine CLI: **GitHub Copilot CLI** recommended (`npm install -g @github/copilot`). Cursor / OpenCode also work if configured as the default.
- An empty git repo (or an existing game tree). M0 is seeded automatically when `package.json` is missing.

Not required: Cursor CLI, `AGENTFLEET_CURSOR_BIN`, Herdr, notify / Grok Bot webhooks, `/tmp` paths, or a pre-copied game scaffold.

## Engine default

This definition **omits** `engine` so phases inherit:

`--` (n/a) → `AGENTFLEET_ENGINE` → `$AGENTFLEET_HOME/config.json` `defaultEngine` → builtin `cursor`

## How paths resolve

`promptFile`, `seed-m0.js`, and `improve-gate.js` resolve **relative to this definition directory**, while `"cwd": "."` follows your **shell cwd** (the game repo).

Optional validate / dry-run / named space:

```bash
aflt loop validate /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --json
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json --dry-run --json
aflt space create hello-demo   # once
aflt --space hello-demo loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json
```

## M0 seed

`m0-seed/` is a portable zero-dependency scaffold (default **PORT 8792**). Phase `m0` runs `seed-m0.js`, which copies that tree into an empty cwd and runs `test/smoke.test.js`. If `package.json` already exists, the seed leaves the tree alone and only re-checks smoke.

## Improve gate

`improve-gate.js` (Node, no bash/`/tmp` paths):

1. Measures overall with `node scripts/eval/eval.js --json` **before** comparison
2. Runs the game test suite
3. Measures again with `--json --write` **after** worker changes
4. Compares gate-owned before vs after — **never** the last line of `eval/history.jsonl`
5. Prints a JSON line with `overall` / `after` so the Loops phase tree can show the score
6. On improvement → exit 0, keep changes (`keep_changes: true`)  
   On plateau/regression → restore gameplay paths to `HEAD`, keep gate records (`keep_changes: false`), exit 0  
   On test failure or edits to locked `scripts/eval/eval.js` / `scorer.js` → exit 1

Plan-next instructs planned improve phases to use (definition-dir resolved):

```json
"eval": { "command": ["node", "improve-gate.js"], "exitCode": 0 }
```

### How plan-next counts rounds / scores

- Completed improve rounds = **this loop’s** passed `improve-*` phases in loop state — **not** the number of `eval/history.jsonl` lines (the gate / `--write` can append several lines per round).
- Live overall = `node scripts/eval/eval.js --json` (no `--write`), or this loop’s own gate before/after. Do **not** treat leftover `eval/latest-score.json` / `eval/plateau.json` from a prior loop as the live score.
- `plateau.json` with `keep_changes: false` means gameplay was reverted; that score is **not** a kept round.
- `hello-aflt-improve.json` always starts at **0 of 3** rounds for that loop name, ignoring a prior `hello-aflt` loop’s history/plateau stop flag. Stop only for this loop’s own gate plateau/regression, 3 kept rounds, or live overall ≥ 99.


## Server port

Default **PORT 8792** for the comparison tree (8790/8791 often taken). Override with `PORT` in the game repo when needed.

## M5a metrics (do not invent)

The M5a prompt requires the same metric names, weights, and constants as the original tile-dungeon harness (`crash_free` 0.25, `solvability` 0.20, `avg_depth` 0.20, `turns_survived` 0.15, `balance_sanity` 0.20; `AVG_DEPTH_TARGET = 3.5`). Do not copy files from other checkouts — implement the harness in the game repo.

## Notify / Grok Bot

Optional. Point `notify.url` / `AFLT_NOTIFY_URL` at a webhook if you want progress events; the loop does not need a bot to continue.
