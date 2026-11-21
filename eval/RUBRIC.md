# Eval rubric (milestone E2)

Human-owned scoring criteria for `aflt eval score`. Agents and improvement
loops must **not** edit this file or the scoring implementation (see
**RUBRIC GUARD** below).

Overall score is an integer **0–100**. Each criterion contributes
`weight / 100 * score` where `score` is also **0–100**. Weights sum to 100.

```
overall = round(sum_i (weight_i / 100 * score_i))
```

`rubricVersion` in scored JSON is `1` (this document).

## Criteria

| id | weight | how scored |
|----|--------|------------|
| `suite_green` | 25 | **100** if measure `suite.ok` and `fail === 0` and no `hardFails` and not `suite.skipped`; **0** if skipped or hard-failed. Flakes alone do not zero the score when `suite.ok` and `fail === 0`. |
| `coverage` | 10 | If coverage available: `min(100, round(linesPercent / 70 * 100))` (100 at ≥70% lines). If unavailable: **50** (availability recorded; threshold not met). |
| `cli_smoke` | 20 | **100** if `cliSmoke.ok` and `failures === 0`; else pass-rate of non-skipped commands × 100 (0 if none ran). |
| `docs_commands` | 15 | Fraction of top-level commands (from USAGE via `listTopLevelCommands`) mentioned in **both** `README.md` and `bin/af.js` USAGE text × 100. Concrete string match; padding docs without the command name does not count. |
| `loop_examples` | 10 | Fraction of `examples/loops/*.json` that pass `validateDefinition` (`checkCwd: false`) × 100. |
| `dashboard_api` | 10 | **100** if `dashboardApi.ok`; else **0**. |
| `error_quality` | 10 | For each error sample: non-empty message, not only a stack dump (at least one non-stack line), and mentions a command name when the sample expects one. Score = fraction × 100. Samples come from deliberate bad CLI probes or injected `errorSamples` (tests). |

## Qualitative grade (opt-in)

Default **off**. Enable only with `--qualitative` or explicit config. Must never
run in tests (`AGENTFLEET_TEST=1` or `AFLT_EVAL_SKIP_QUALITATIVE=1`). The
default path does not spawn engines; if requested without a configured
evaluator it records `{ skipped: true, reason: "…" }` and does not affect the
deterministic overall score.

## RUBRIC GUARD

Improvement-loop / `eval-improve` runs **must fail** if a change touches any
protected path:

- `eval/RUBRIC.md`
- `scripts/eval/score.js`
- `scripts/eval/rubric.js`

Enforce with `aflt eval gate` (or `scripts/eval/gate.js`). The rubric is
protected and may only be edited by a **human outside the loop**.
