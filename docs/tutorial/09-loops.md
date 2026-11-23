# 09 — Loops

**Goals**

- Validate and dry-run loop definitions without launching unattended work against a real fleet
- Know CLI vs dashboard scheduler / Loops UI at a high level
- Recognize approval gates and plan-next
- Inspect the shipped examples under `examples/loops/`

## Commands

```bash
aflt --space tutorial loop validate <file.json> [--json]
aflt --space tutorial loop run <file.json> [--dry-run] [--json] [--fresh] [--force] [--allow-existing]
aflt --space tutorial loop start <file.json> [--json]    # register active for dashboard scheduler
aflt --space tutorial loop pause <name> [--json]
aflt --space tutorial loop status [name] [--json]
aflt --space tutorial loop stop <name> [--json]
aflt --space tutorial loop resume <name> [--json]        # runs in this process from saved state
aflt --space tutorial loop approve <name> [--json]       # release gate: "approve"
```

State lives under `$AGENTFLEET_HOME/loops/<name>/` (`state.json` + runner lock). Definitions you save from the UI go only under `$AGENTFLEET_HOME/loops/definitions` (or configured loops dir).

## Examples in the repo

| File / dir | Role |
|------|------|
| `examples/loops/hello-eval.json` | Single phase: write HELLO.txt, grep eval |
| `examples/loops/plan-next.json` | Seed phases + `type: "plan-next"` planner |
| `examples/loops/self-improve.json` | Eval measure → score/baseline → plan-next → gate `--improve` |
| `examples/loops/hello-aflt/` | Portable tile-dungeon: empty-repo M0 seed → M1–M5a → ≤3 improve rounds (Copilot-friendly) |
| `examples/loops/hello-aflt/hello-aflt-improve.json` | Continue improve-only on an existing M5a game (loop name `hello-aflt-improve`) |

Validate (safe; no engines):

```bash
aflt --space tutorial loop validate examples/loops/hello-eval.json --json
aflt --space tutorial loop validate examples/loops/plan-next.json --json
aflt --space tutorial loop validate examples/loops/self-improve.json --json
aflt --space tutorial loop validate examples/loops/hello-aflt/hello-aflt.json --json
aflt --space tutorial loop validate examples/loops/hello-aflt/hello-aflt-improve.json --json
```

**hello-aflt one-liner** (work Mac / Copilot; no Grok Bot): create a folder, `git init`, then `aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt.json` — see [`examples/loops/hello-aflt/README.md`](../../examples/loops/hello-aflt/README.md). Optional once: `export AGENTFLEET_ENGINE=copilot`.

Success text shape:

```text
ok: loop "hello-eval" (1 phase(s))
```

JSON includes `ok`, `path`, `errors`, `warnings`, and `definition` when valid.

Dry-run (plan only; no lock / no phases executed):

`hello-eval.json` sets `"cwd": "."`. From this checkout that folder is the product repo, so the run is refused unless you pass `--allow-existing`. A clean empty `git init` directory is accepted without the flag.

```bash
aflt --space tutorial loop run examples/loops/hello-eval.json --dry-run --allow-existing --json
```

Text dry-run (cwd, permission mode, model):

```text
dry-run: loop "hello-eval" — 1 phase(s)
  cwd: …
  permissions: force
  model: (engine default)
  - write-greeting engine=cursor session=loop-hello-eval maxFix=3 onPass=none force=true permission=force model=-
```

`force` defaults to false. hello-eval sets `"force": true` on the phase. `--force` on `loop run` grants tools for every phase in that invocation. Model: phase `model`, definition `model`, `COPILOT_MODEL` (Copilot), then `config.json` `defaultModel`.

## Approval gates and plan-next

- Phase `gate: "approve"` → runner `status=waiting`, notify `loop.gate.waiting`; release with `aflt loop approve` or dashboard `POST /api/loops/:name/approve`
- `type: "plan-next"`: planner must write `$AGENTFLEET_HOME/loops/<name>/plan-next.json` as `{ "done": true }` or `{ "phases": [ … ] }`
- Newly planned phases get `gate: "approve"` unless the phase sets `gate` or the loop sets `plannedPhaseGate: "none"`
- Cap growth with `budget.maxPhases`
- `onPass` (`none`|`commit`|`merge`|`push`) only runs when loop-level `allow` flags permit (default all false)

## Dashboard scheduler / Loops UI

`aflt loop start` registers a loop as `active` without running phases in that process. `aflt dashboard --serve` hosts an in-process scheduler (one runner per name; lock respected). Loops view: list, phase pipeline, eval tails, History links, start/pause/resume/stop/approve, define/edit form.

This tutorial stops at **validate / dry-run / status**. Do not start an unattended loop against a production fleet from these pages.

## Try it

```bash
aflt space create tutorial   # if needed
aflt --space tutorial loop validate examples/loops/hello-eval.json
aflt --space tutorial loop run examples/loops/hello-eval.json --dry-run
aflt --space tutorial loop status --json
```

Confirm validate exits 0 and dry-run does not create a runner lock under a real default home (you are on `--space tutorial`).
