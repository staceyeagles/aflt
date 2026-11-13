# Engine capability matrix

How `af` observes liveness, completion, blocked/needs-input, handoffs, and continuation for each engine × mode. Linked from the [README](../README.md).

| Capability | Cursor headless | Cursor interactive (Herdr) | Copilot headless | Copilot interactive (Herdr) |
|---|---|---|---|---|
| **Liveness** | `runPid` / process group on same host | Herdr terminal `state=live` labeled `af_id=<id>` with non-shell agent (`env` / engine). `runtime=shell` = live tab, agent stopped. Agents list titles come from session-group `herdr.space` + `space.rename` / `tab.rename` (not the repo folder) | same as Cursor headless | same as Cursor interactive |
| **Completion** | Engine process exit code (`lastExit`) | Terminal exit (`runtime=exited` + exit code), or shell-only (`runtime=shell` → derived `stopped`). **No** turn-complete signal while engine live | Engine exit code | OSC 7501 agent state via Herdr (`idle` / `working` / `done` / `blocked` / `error`) **or** terminal exit / shell-only |
| **Blocked / needs-input** | Not detectable (headless run blocks or exits) | **Not detectable** — Cursor does not emit OSC 7501 (`status` stays null) | Not detectable in print mode beyond exit | `blocked` → waiting immediately; after `working`, sustained `idle` or `done` → waiting (`af wait`) |
| **Handoff** | Worker should write `$AGENTFLEET_RESULT`; af may write **af-fallback** from stdout when missing/stale after a successful run. Copilot gets `--allow-tool=write(…)` for result/plan dirs without `--force` | Same path convention; no automatic fallback (interactive). Freshness uses `runId` / `runStartedAt` / `resultMtimeAtStart` | Same as Cursor headless | Same as Cursor interactive |
| **Continuation (`af send`)** | Headless continue: new print-mode run with short reminder; refuses if `runPid` still alive | `hc send` to live terminal; records `lastSendAt` + new `runId` (prior handoff becomes stale until rewritten) | same pattern | same pattern |

## What `af wait` concludes

| Situation | `workerStatus` / `outcome` | `stateSource` | `conclusive` | Exit when all terminal |
|---|---|---|---|---|
| Headless: process exited 0 / non-zero / stopped | `done` / `failed` / `stopped` | `pid` or `stored` | true | 0 / 1 |
| Interactive: terminal exited | `done` / `failed` / `stopped` from exit code | `exit` | true | 0 / 1 |
| Interactive **shell-only** (live tab; known shell name positively observed, no non-shell evidence) | `stopped` (not a distinct workerStatus) | `shell` | **true** | **1** — stderr: `agent not running in its terminal (shell only); run af resume <id>` |
| Interactive **alive, agent null/unknown** (no shell name observed) | stays `running` | depends | depends | not treated as shell |
| Interactive Copilot: agent `done`/`blocked`/post-work `idle` | `waiting` | `herdr` | true (for wait) | 3 |
| Interactive **alive, agent state null** (typical Cursor) | stays `running` | `none` | **false** | never “done” from state — wait until timeout → **exit 2** |
| Herdr discovery failed | stored status; runtime shown unknown on `ls` | stored | depends | — |

**Shell-only choice:** Herdr runtime `shell` maps to derived `workerStatus=stopped` with `stateSource=shell` and `conclusive=true`, so `af wait` terminates (exit 1) instead of hanging. Fix with `af resume <id>` (relaunches into the existing tab). Classification requires a **positive** shell name (`zsh`/`bash`/… from `hc ls` `agent` or `hc get` `foreground`); null/missing agent is **not** shell. Non-shell evidence (`env`, engine, `node`, …) wins over a shell foreground. `hc ls` + `hc get` are merged so a null field never overrides a value from the other.

Stderr (once per worker): `no agent state from Herdr for <id>; cannot detect completion — use af tail / af result`.

## Handoff freshness (summary)

See README “Handoff freshness”. A file is **fresh** iff it exists and `mtime` is after `runStartedAt` or `resultMtimeAtStart`. Tables show HANDOFF as `yes` / `af` / `stale` / `no`.
