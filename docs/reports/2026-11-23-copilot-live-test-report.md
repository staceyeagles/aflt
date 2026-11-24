# aflt Copilot live-test report

The hello-aflt loop completed in 16 minutes with all eight phases passed and a game eval of 87, but only after two workarounds. The first attempt failed immediately, yet marked four phases as passed.

## Verdict

**Do not trust loop pass or fail until agent exit codes are checked.** A fresh Copilot loop also fails unless the `results/` folder is created by hand, and loops cannot select a model. Once those issues were worked around, the orchestrator did what the test plan describes.

## What was tested

- **Plan:** `docs/copilot-live-test.md` on aflt 1.5.0
- **Repo:** `/Users/estella/github/wwlib/aflt`, branch `main`, HEAD `69e9736`
- **When:** Monday, Nov 23, 2026 (America/New_York)
- **Machine:** Mac Mini, Node v25.5.0, Copilot CLI 1.0.114
- **Unit tests:** 669 of 670 passed in 95 seconds; the one skip is an optional Cursor live check
- **How it was run:** PATH shim to `node bin/af.js`; no global npm install
- **Engine and space:** `AGENTFLEET_ENGINE=copilot`, `AFLT_SPACE=copilot-live`, `COPILOT_MODEL=auto`

## Successful live run

The second attempt ran from a new empty git repo at `~/tmp/tile-dungeon-live-2`, starting at 7:45:56 AM ET and finishing at 8:01:58 AM ET. The improve gate stopped after one round at a plateau of 87, as designed. There were no commits for improve-1 or plan-next.

- **Elapsed:** 16 min 2 s (0.27 of 8 hours budgeted)
- **Phases passed:** 8 of 8 (plan-next took 2 attempts)
- **Game eval:** 87 (no gain on improve-1)
- **Runs used:** 9 of 40

| Phase | Result | Time (ET) | Notes |
|---|---|---:|---|
| m0 | passed | 7:46:21 AM | 1 of 1 tests; seed commit `6b2ac8e` |
| m1 | passed | 7:47:46 AM | 9 of 9 tests; 361 lines added, commit `f3dea28` |
| m2 | passed | 7:50:26 AM | 14 of 14 tests; commit `04ef131` |
| m3 | passed | 7:54:16 AM | 18 of 18 tests; commit `5f1231d` |
| m4 | passed | 7:56:39 AM | 23 of 23 tests; commit `ae32f46` |
| m5a | passed | 8:00:42 AM | Eval 87; commit `34d9bde` |
| improve-1 | passed | 8:01:45 AM | Still 87; plateau, no commit |
| plan-next | passed | 8:01:58 AM | 2 attempts; eval is `true`, no commit |

After m5a, the project's own tests were 27 of 27 passing. The eval harness ran 20 seeds.

| Eval metric | Score |
|---|---:|
| crash_free | 100 |
| solvability | 100 |
| balance_sanity | 98.6 |
| turns_survived | 72.6 |
| avg_depth | 57.1 |

Token usage was logged as 7,252 estimated tokens across 9 turns. That figure is labeled estimated and appears far too low: a one-line Copilot pong alone used about 20,900 credits, and an M1 run that wrote 361 lines was recorded as 577 tokens.

## Failed first attempt

The first live run, from `~/tmp/tile-dungeon-live`, reported `loop failed: phase m5a failed after 3 fix attempt(s)` after about 2 seconds and 9 runs. Every Copilot call exited with the error below, because `lib/loop.js` never creates the `results/` folder it passes to Copilot. `aflt run` and `aflt spawn` do create that folder; loop sessions do not.

```
error: option '--add-dir …/spaces/copilot-live/results' is invalid. Directory does not exist
```

Despite those failures, milestones M1 through M4 were marked passed and would have been eligible to commit, because the loop never checks the agent's exit code. The tests copied in by the M0 seed were already green, so those phases looked successful even though Copilot had done no work. Only M5a failed, because its eval needs files the agent never wrote. The token counter still logged 503 estimated tokens for runs that never started.

This first run was kept as evidence. The second run started only after creating `~/.agentfleet/spaces/copilot-live/results` by hand.

## Findings to fix

Ranked by importance. File references are from commit `69e9736`.

1. **Loops treat a failed agent run as a pass whenever the eval is already green.**
   - Location: `lib/loop.js` around lines 2347–2362.
   - Fix: fail or retry the phase when the agent exits non-zero or times out, and add a hermetic test with a stub that exits 1.
2. **A fresh Copilot loop breaks because the `results/` folder is never created.**
   - Location: `lib/loop.js` around line 1461, and `lib/copilot.js` lines 35–43.
   - Fix: create it with `mkdir` the way `bin/af.js` around line 4424 already does, and add a test that starts from an empty `AGENTFLEET_HOME`. The 670 unit tests do not cover this path.
3. **There is no way to choose the Copilot model for a loop.**
   - A plain `copilot -p` pong failed here with `Model "claude-opus-4.6" is not available`. Adding `--model auto` worked. Loops always pass `model: null` (`lib/loop.js` around lines 1376 and 1439).
   - Fix: honor `model` in the loop definition or a default in config, and mention `COPILOT_MODEL` in `docs/copilot-live-test.md`. Without that env var, every phase on this machine would have failed.
4. **Copilot token usage is off by orders of magnitude.**
   - The dashboard total after this successful run was 7,252 estimated tokens across 9 turns.
   - Fix: read Copilot's JSON output or session metrics instead of the current estimate.
5. **Loops default to full tool permissions, and nothing checks where they run.**
   - Every phase is force unless a definition opts out (`lib/loop.js` around lines 480 and 1463), which for Copilot means `--allow-all-tools`. A passing phase then runs `git add -A` and commits in the resolved folder (around line 1792).
   - `loop validate` and `--dry-run` accepted `cwd: /Users/estella/tmp` with no warning. A real run from there would give the agent full tool access to that folder.
   - Fix: default `force` to false or require an explicit allow; refuse a non-empty or dirty folder unless `--allow-existing` is passed; print the resolved folder and permission mode in `--dry-run`.
6. **`aflt doctor` treats any binary named `agent` as Cursor.**
   - Location: `lib/cursor.js` lines 15 and 284. On this Mac the first `agent` on PATH is another CLI, so doctor reported Cursor as present and printed that path as `cursor_bin`.
   - Fix: check the binary's identity, or drop the bare `agent` fallback, and have doctor print the resolved path only after that check.
7. **The documented install command does not work, and the live-test guide is missing two prerequisites.**
   - `npm install -g aflt` 404s because the package is not on the npm registry. RELEASING.md says publishing waits until the package name is settled.
   - The guide does not mention `COPILOT_MODEL`, and it has no detached or background launch recipe; `aflt loop run` stays in the foreground.
   - Fix: document `npm link` or `npm install -g github:wwlib/aflt` until the package is published, and add the model and detach notes to the live-test doc.
8. **There is no CI, lint, or type checking, and a few files are very large.**
   - `engines` claims Node 18 or newer, but `npm test` needs about Node 20.10 or newer.
   - `bin/af.js` is about 8,600 lines; `runLoop` is about 680 lines. About 336 empty `catch` blocks swallow errors.
   - Fix: add a GitHub Actions workflow for `npm test` on Node 20, 22, and 24; add `// @ts-check` with `tsc --noEmit`; bump `engines` to `>=20.10`. Split the large command handlers when there is time.

## What worked well

- Zero npm dependencies, no shell-string execution, and careful locking and process handling.
- The unit suite is hermetic and broad: 669 tests passed here in 95 seconds, and the repo was still clean afterward.
- Once the two blockers were worked around, the loop matched the test plan: clean per-phase commits, real feature work, a stable eval of 87, and an improve gate that stopped on a plateau.
- All live writes stayed inside the scratch repo and the space under `~/.agentfleet`. Nothing was pushed or installed globally, and the aflt checkout was left untouched.

## Suggested next work

1. Patch the exit-code check and the missing `results/` folder first. Those two bugs make a fresh Copilot loop either fail outright or report false passes.
2. Add a loop-level model setting, or document `COPILOT_MODEL`, so accounts whose default model is unavailable can still run.
3. Tighten the safety defaults: no implicit `--allow-all-tools`, and a folder guard on `loop run`.
4. Fix Cursor detection in `aflt doctor`, Copilot token accounting, and the install and live-test docs.
5. Add CI for `npm test`, then consider `// @ts-check` and splitting the largest files.

Evidence from this run is still on the Mac Mini:

- Failed repo: `~/tmp/tile-dungeon-live`
- Successful repo: `~/tmp/tile-dungeon-live-2`
- Logs: `~/tmp/aflt-copilot-live-run.log` and `~/tmp/aflt-copilot-live-run-2.log`
- Space state: `~/.agentfleet/spaces/copilot-live`
