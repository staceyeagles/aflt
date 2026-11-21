# 00 — Overview

**Goals**

- Know what aflt tracks and what it does not replace
- Learn the main nouns: sessions, runs, engines, projects, spaces, memory, dashboard, loops, eval
- See how the rest of this tutorial maps onto those pieces

## What aflt is

**aflt** (AgentFleet) is a local CLI that tracks, resumes, and orchestrates **Cursor CLI**, **GitHub Copilot CLI**, and **OpenCode** sessions. Chat IDs live in engine-local stores and terminals die on reboot; aflt keeps a small registry under `$AGENTFLEET_HOME` (default `~/.agentfleet`), launches or resumes the right engine into Herdr/tmux/iTerm/WezTerm (or this terminal), runs headless one-shots that capture output, and can run a master → workers fleet.

Aliases: `af` and `agentfleet` run the same CLI as `aflt`.

## What aflt is not

- Not a replacement for Cursor, Copilot, or OpenCode — you still install and authenticate those engines yourself
- Not a cloud orchestrator — registry and runs stay on your machine
- Not automatic documentation, messaging, or notify — those features are **opt-in**
- Not a Herdr replacement — Herdr (`hc` + optional desktop app) hosts interactive terminals; aflt labels and resumes them

## Core concepts

| Concept | Meaning |
|---------|---------|
| **Session** | A tracked row in `sessions.json` (id, title, chatId, cwd, engine, lifecycle status, optional project/parent/role) |
| **Run** | One headless (or captured) execution; logs under `$AGENTFLEET_HOME/runs/<id>/` |
| **Engine** | `cursor`, `copilot`, or `opencode` — default for *new* sessions: `--engine` → `AGENTFLEET_ENGINE` → `config.json` `defaultEngine` → builtin `cursor` |
| **Project** | Optional grouping name (`session.project`). Projects need **no git**. See [PROJECT-REPO-METADATA.md](../PROJECT-REPO-METADATA.md) |
| **Space** | Opt-in isolated fleet home under `~/.agentfleet/spaces/<name>` via `--space` / `AFLT_SPACE` |
| **Memory** | Opt-in local git repo for timelines and `DASHBOARD.md` (`aflt memory …`) |
| **Dashboard** | Live local UI: `aflt dashboard --serve` (not the same as `aflt memory dashboard`) |
| **Loop** | Multi-phase plan→develop→eval→fix runner (`aflt loop …`) |
| **Eval** | Hermetic self-measurement and scoring (`aflt eval measure` / `score` / `gate` / …) |

Lifecycle `STATUS` on `aflt ls` is saved state (`active` | `paused` | `done`). A process exit does **not** mark a task done — use `aflt done`. `HERDR` is live runtime from `hc ls` when available.

## Map of this tutorial

1. [Install](01-install.md) — get `aflt` on PATH and run `doctor` / `setup`
2. [First run](02-first-run.md) — register, headless `run`, resume, logs
3. [Dashboard](03-dashboard.md) — History, Graph, Gantt, optional LaunchAgent
4. [Herdr](04-herdr.md) — interactive front end and af-sessions panel
5. [Memory](05-memory.md) — timelines, turns, Doc Bot, docs automation
6. [Notify](06-notify.md) — opt-in webhooks
7. [Messaging](07-messaging.md) — opt-in agent-to-agent messages
8. [Purge](08-purge.md) — safe cleanup (dry-run first)
9. [Loops](09-loops.md) — validate and inspect multi-phase definitions
10. [Eval](10-eval.md) — measure, score, RUBRIC GUARD
11. [Spaces](11-spaces.md) — throwaway isolation for this tutorial
12. [Token usage](12-token-usage.md) — turns + usage-summary, History, memory rollup
13. [Troubleshooting](13-troubleshooting.md) — real-world pitfalls

Deeper matrices and setup: [CAPABILITIES.md](../CAPABILITIES.md), [SETUP.md](../SETUP.md). Agent-oriented detail: [AGENTS.md](../../AGENTS.md).

## Try it

In your throwaway space, confirm you are isolated and see an empty registry:

```bash
aflt space create tutorial          # skip if it already exists
aflt --space tutorial space current
aflt --space tutorial ls
```

Expected shapes (from the CLI implementation):

```text
tutorial
```

```text
space: tutorial
(no sessions)
```

Or with JSON:

```bash
aflt --space tutorial ls --json
```

```json
{ "space": "tutorial", "home": "…/.agentfleet/spaces/tutorial", "sessions": [], "queryOk": true }
```

(`queryOk` reflects Herdr discovery; missing `hc` still lists sessions.)
