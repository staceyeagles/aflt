# aflt tutorial

A beginner-to-advanced walkthrough of **aflt** (AgentFleet): install, first run, dashboard, Herdr, memory, notify, messaging, cleanup, loops, eval, and named spaces.

This tutorial is for humans and for agents that help humans. Flag lists and defaults come from `aflt help` (`bin/af.js` USAGE) and the implementation — not from guesswork. Prefer **`aflt help`** (or `aflt` with no args) for the full usage text. **Do not run `aflt <command> --help`** — that is not a dedicated help path and may run the command.

## How to follow along

Create a **throwaway space** first so you never touch your real fleet home:

```bash
aflt space create tutorial
# then either:
export AFLT_SPACE=tutorial
# or pass --space tutorial on every command
```

That isolates registry, config, memory, dashboard port, and LaunchAgent label under `~/.agentfleet/spaces/tutorial`. Notify starts **off**. When you are done, see [11 — Named spaces](11-spaces.md) for safe removal (`aflt space remove tutorial --force` only after you intend to delete that throwaway tree).

## Suggested reading order

| # | Chapter | Topics |
|---|---------|--------|
| 00 | [Overview](00-overview.md) | What aflt is / is not; sessions, engines, spaces, memory, dashboard, loops, eval |
| 01 | [Install and setup](01-install.md) | npm install, PATH, `aflt doctor`, `aflt setup`, engines, completion |
| 02 | [First session and run](02-first-run.md) | `new` / `run` / `resume` / `ls` / logs / timeouts / headless vs interactive |
| 03 | [Dashboard](03-dashboard.md) | `dashboard --serve`, History/Graph/Gantt, snapshot, `aflt service` |
| 04 | [Herdr](04-herdr.md) | Panel, mod/layout paths, registry relationship; link to SETUP / RECIPE |
| 05 | [Memory and docs](05-memory.md) | Memory repo, timeline, turns backfill, Doc Bot, documentarian / agentDocs |
| 06 | [Notify](06-notify.md) | Webhooks, events, secrets, space default off |
| 07 | [Messaging](07-messaging.md) | Opt-in `msg` / `inbox` / `thread` / MCP |
| 08 | [Purge and orphans](08-purge.md) | `purge` / `archive` / `orphans`; dry-run first |
| 09 | [Loops](09-loops.md) | validate / dry-run / status; examples; gates; plan-next |
| 10 | [Eval](10-eval.md) | measure / score / report / gate / plateau; RUBRIC GUARD |
| 11 | [Named spaces](11-spaces.md) | `--space` / `AFLT_SPACE`; create / list / current / remove |
| 12 | [Token usage](12-token-usage.md) | Per-turn `usage`, `usage-summary.json`, engines, History, memory rollup |
| 13 | [Troubleshooting](13-troubleshooting.md) | Timeouts, PATH, no pkill, prompts from files, FAQ |

## Deeper docs (do not duplicate here)

- [docs/SETUP.md](../SETUP.md) — environment, Herdr, work-computer install, troubleshooting depth
- [docs/CAPABILITIES.md](../CAPABILITIES.md) — engine × mode matrix and `aflt wait` outcomes
- [docs/PROJECT-REPO-METADATA.md](../PROJECT-REPO-METADATA.md) — project↔repo schema
- [docs/copilot-live-test.md](../copilot-live-test.md) — Copilot-only work Mac: validate / dry-run / live `hello-aflt`
- [AGENTS.md](../../AGENTS.md) — agent-oriented command guide
- [CHANGELOG.md](../../CHANGELOG.md) — release notes
- [README.md](../../README.md) — product overview; dashboard screenshots in [docs/images/](../images/)

Screenshots that may help while you read:

- [dashboard-graph.png](../images/dashboard-graph.png) — Graph view
- [dashboard-history.png](../images/dashboard-history.png) — History Gantt
- [dashboard-sessions.png](../images/dashboard-sessions.png) — Sessions overview
- [herdr.png](../images/herdr.png) — Herdr with the af sessions panel
