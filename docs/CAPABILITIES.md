# Engine capability matrix

How `af` observes liveness, completion, blocked/needs-input, handoffs, and continuation for each engine × mode. Linked from the [README](../README.md).

| Capability | Cursor headless | Cursor interactive (Herdr) | Copilot headless | Copilot interactive (Herdr) |
|---|---|---|---|---|
| **Liveness** | `runPid` / process group on same host | Herdr terminal `state=live` labeled `af_id=<id>` with non-shell agent (`env` / engine). `runtime=shell` = live tab, agent stopped. Agents list titles come from session-group `herdr.space` + `space.rename` / `tab.rename` (not the repo folder) | same as Cursor headless | same as Cursor interactive |
| **Completion** | Engine process exit code (`lastExit`) | Terminal exit (`runtime=exited` + exit code), or shell-only (`runtime=shell` → derived `stopped`). **No** turn-complete signal while engine live | Engine exit code | OSC 7501 agent state via Herdr (`idle` / `working` / `done` / `blocked` / `error`) **or** terminal exit / shell-only |
| **Blocked / needs-input** | Not detectable (headless run blocks or exits) | **Not detectable** — Cursor does not emit OSC 7501 (`status` stays null) | Not detectable in print mode beyond exit | `blocked` → waiting immediately; after `working`, sustained `idle` or `done` → waiting (`aflt wait`) |
| **Handoff** | Worker should write `$AGENTFLEET_RESULT`; af may write **af-fallback** from stdout when missing/stale after a successful run. Copilot gets `--allow-tool=write(…)` for result/plan dirs without `--force` | Same path convention; no automatic fallback (interactive). Freshness uses `runId` / `runStartedAt` / `resultMtimeAtStart` | Same as Cursor headless | Same as Cursor interactive |
| **Continuation (`aflt send`)** | Headless continue: new print-mode run with short reminder; refuses if `runPid` still alive | `hc send` to live terminal; records `lastSendAt` + new `runId` (prior handoff becomes stale until rewritten) | same pattern | same pattern |
| **Task messaging** | Off by default; `aflt msg` / inbox / thread + MCP tools when session or `.agentfleet.json` enables it. Same JSONL team log for all engines; identity via `AGENTFLEET_SESSION`/`AGENTFLEET_ID` injected on launch | same | same | same |
| **Project / timeline** | Optional `session.project` (no git required). Create: `--project` → parent → `AFLT_PROJECT` → `.agentfleet.json` → `config.json` → basename/`adhoc`. Read-time derive cwd-only (never env/global; never backfill). `aflt ls --project` / `--json` project+parent. `aflt timeline` read-only tree + best-effort commits per session cwd (skip when not-git) | same | same | same |
| **Live dashboard** | `aflt dashboard --serve` / `--snapshot` — local read-only activity graph (registry + optional memory jsonl + Herdr when available). Default bind `127.0.0.1:8787`. Not `aflt memory dashboard` | same | same | same |
| **Project memory** | Opt-in `aflt memory` local git repo (`AFLT_MEMORY_REPO` / `config.json` `memoryRepo`). `sync` writes `<project>/_aflt/timeline.md` + `sessions.jsonl` and regenerates root `DASHBOARD.md` (Active/Dormant; `--active-days` / `memoryActiveDays`, default 14 ET days; doc-bot summary block preserved). `aflt memory dashboard` regenerates `DASHBOARD.md` only. Registry read-only; no auto-sync. Optional `--commit` stages `DASHBOARD.md` + `*/_aflt/**`; `--push` requires `--commit` (upstream only; never force). Nightly: `aflt memory sync --all --commit --push`. `aflt memory doc [--engine cursor|copilot]` launches the portable Doc Bot (`DOC-AGENT.md`) as an `aflt run` session in the memory repo. `--all` skips `adhoc` unless `--include-adhoc`. Redaction ON by default. `status`/`where` read-only | same | same | same |
| **Documentarian** | Off by default; `.agentfleet.json` `{"docs": true}` enables `aflt docs` (role=`docs`). Default docsPaths = README + docs/ (+ CHANGELOG.md only if present). Optional `docsInstructions` file path(s) injected into the prompt. Prompt may include a compact session timeline since last docs run (`timelineBytes`, ~8KB cap). `aflt docs --status` is read-only. Force/write ON by default (`--no-force` / `docsForce:false` opt out). Auto-runs once after headless master / `aflt wait --docs` (guard: `docsTriggeredRunId`); docs failure → WARNING + JSON `docs:{ok:false}` but master exit 0; wait --docs errors if no master. Warns on non-doc edits (incl. disallowed new CHANGELOG); no revert | same | same | same |
| **MCP wiring** | Cursor: project/user `.cursor/mcp.json` + `--approve-mcps` when messaging enabled and `af` server present | same | Copilot: per-run `--additional-mcp-config` + `--allow-tool=af` (no `~/.copilot` write) | same |
| **Detached spawn** | `aflt spawn --detach` supervisor records exit/handoff; dead `runPid` + fresh worker handoff → `done` (`stateSource: handoff`) | n/a (interactive) | same as Cursor headless | n/a |

## What `aflt wait` concludes

| Situation | `workerStatus` / `outcome` | `stateSource` | `conclusive` | Exit when all terminal |
|---|---|---|---|---|
| Headless: process exited 0 / non-zero / stopped | `done` / `failed` / `stopped` | `pid` or `stored` | true | 0 / 1 |
| Interactive: terminal exited | `done` / `failed` / `stopped` from exit code | `exit` | true | 0 / 1 |
| Interactive **shell-only** (live tab; known shell name positively observed, no non-shell evidence) | `stopped` (not a distinct workerStatus) | `shell` | **true** | **1** — stderr: `agent not running in its terminal (shell only); run aflt resume <id>` |
| Interactive **alive, agent null/unknown** (no shell name observed) | stays `running` | depends | depends | not treated as shell |
| Interactive Copilot: agent `done`/`blocked`/post-work `idle` | `waiting` | `herdr` | true (for wait) | 3 |
| Interactive **alive, agent state null** (typical Cursor) | stays `running` | `none` | **false** | never “done” from state — wait until timeout → **exit 2** |
| Herdr discovery failed | stored status; runtime shown unknown on `ls` | stored | depends | — |

**Shell-only choice:** Herdr runtime `shell` maps to derived `workerStatus=stopped` with `stateSource=shell` and `conclusive=true`, so `aflt wait` terminates (exit 1) instead of hanging. Fix with `aflt resume <id>` (relaunches into the existing tab). Classification requires a **positive** shell name (`zsh`/`bash`/… from `hc ls` `agent` or `hc get` `foreground`); null/missing agent is **not** shell. Non-shell evidence (`env`, engine, `node`, …) wins over a shell foreground. `hc ls` + `hc get` are merged so a null field never overrides a value from the other.

Stderr (once per worker): `no agent state from Herdr for <id>; cannot detect completion — use aflt tail / aflt result`.

## Handoff freshness (summary)

See README “Handoff freshness”. A file is **fresh** iff it exists and `mtime` is after `runStartedAt` or `resultMtimeAtStart`. Tables show HANDOFF as `yes` / `af` / `stale` / `no`.

## Session lookup (destructive vs fuzzy)

Most commands resolve sessions with fuzzy matching (exact id/chatId/title → unique id/chatId prefix ≥4 → trailing hex6 → unique title substring). Queries that contain whitespace skip the fuzzy fallbacks (exact title with spaces still works).

**`aflt rm` and `aflt stop` prefer an exact id, chatId, or title.** When there is no exact match but fuzzy candidates exist:

- **Interactive TTY** (stdin and stdout are TTYs, and not `--json`): prompt to confirm a single candidate (`Stop|Remove <title> (<id>)? [y/N]`) or pick among several (`Stop|Remove which? [1-N, Enter to cancel]`). Enter / `n` / invalid / EOF prints `cancelled` and exits 1 with nothing changed. There is no `--yes` auto-pick.
- **Non-TTY, `--json`, or agents/scripts:** exact-only — exit 1 with a “did you mean …?” hint listing all candidates. Never prompts.

`aflt rm` accepts multiple ids as separate args and resolves all (prompting as needed) before removing any; a cancel aborts everything. `--dry-run` still prompts on a TTY for resolution only. The same picker applies to `rm --children <master>` and `stop --all-children <master>` master resolution.
