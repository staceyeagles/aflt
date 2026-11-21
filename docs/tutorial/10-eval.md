# 10 — Eval and self-improvement

**Goals**

- Run hermetic `measure` / `score` / `report` / `gate` / `plateau` as documented
- Treat `eval/RUBRIC.md` as human-owned (improvement loops must not edit it)
- Know RUBRIC GUARD and the self-improve example loop
- Never game the checklist

Do **not** edit `eval/RUBRIC.md`, `scripts/eval/score.js`, or `scripts/eval/rubric.js` in this worktree as part of following the tutorial.

## Commands

```bash
aflt eval measure [--json] [--out DIR]
aflt eval score [results-file] [--json] [--history PATH] [--qualitative] \
  [--results-dir DIR] [--write-baseline PATH] [--max-rounds N]
aflt eval report [--json] [--history PATH] [--limit N]
aflt eval gate [--json] [--base REF] [--paths a,b] \
  [--improve] [--baseline PATH] [--results PATH] [--results-dir DIR] \
  [--history PATH] [--score N]
aflt eval plateau [--json] [--baseline PATH] [--history PATH] \
  [--max-rounds N] [--rounds N]
```

Measure never touches real `~/.agentfleet`, live engines, or Herdr. It writes `eval/results/<timestamp>.json` (gitignored; override with `--out DIR`).

Score is deterministic 0–100 from measure JSON + `eval/RUBRIC.md`. Appends one line to `eval/history.jsonl` (override with `--history`). `--qualitative` is opt-in and always skipped when `AGENTFLEET_TEST=1` or `AFLT_EVAL_SKIP_QUALITATIVE=1`; default path never calls live engines.

`--write-baseline` records improve baseline (bare flag → `eval/improve-baseline.json`).

Text measure summary shape:

```text
eval measure ok: eval/results/<timestamp>.json
  suite: pass=… fail=… skip=… flakes=… hardFails=…
  coverage: available|unavailable …
  cliSmoke: ok|FAILED commands=…
  dashboardApi: ok|FAILED …
```

## RUBRIC GUARD and safety

`aflt eval gate` fails if protected paths changed vs `--base` (default `HEAD`):

- `eval/RUBRIC.md`
- `scripts/eval/score.js`
- `scripts/eval/rubric.js`

With `--improve`, also require suite green and score ≥ baseline (self-improve gate).

`aflt eval plateau` reports `stop=true` when the score plateaued vs previous round/baseline or rounds ≥ max (default 3).

**Rules for humans and agents**

- Do not edit the rubric or scoring implementation to raise the score
- Merge / land work only if the full test suite stays green and the score does not drop
- Do not game checklist wording; fix the product under test

## Self-improve example

`examples/loops/self-improve.json`: measure → score + baseline → plan-next (one small fix) → build → `aflt eval gate --improve`. Autonomous profile: `plannedPhaseGate: "none"`, `allow.commit/merge/push: false`. Helpers: `scripts/eval/improve.js`.

```bash
aflt --space tutorial loop validate examples/loops/self-improve.json --json
aflt --space tutorial loop run examples/loops/self-improve.json --dry-run --json
```

Inspect only — do not launch an unattended improve loop against a shared machine from this chapter.

## Try it

Cheap, hermetic checks (no nested full measure required for the exercise):

```bash
aflt space create tutorial   # if needed
aflt --space tutorial eval report --json
aflt --space tutorial eval plateau --json
aflt eval gate --json        # RUBRIC GUARD vs HEAD; run from a clean tree when possible
```

When you intentionally measure in a checkout, prefer a throwaway `--out` dir and never point measure at a live fleet home (measure uses its own sandbox `AGENTFLEET_HOME`).
