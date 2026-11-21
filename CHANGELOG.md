# Changelog

All notable changes to **aflt** / AgentFleet are documented here.

## 2026-11-20

- **Direct messaging** — opt-in `aflt msg` / `aflt inbox` / `aflt thread` and MCP `read_inbox` / `post_message` / `list_team` (enable with `aflt msg enable`, `--messaging`, or `.agentfleet.json` `{"messaging": true}`). Cross-session DMs use `messages/dm__<idA>__<idB>.jsonl`.
- **Project↔repo metadata** — portable mappings in `<memoryRepo>/<project>/.agentfleet.json` plus local `config.json` `repositories`; inspect with `aflt projects [--json]` (see `docs/PROJECT-REPO-METADATA.md`).
- **Interactive turn capture** — redacted prompt/reply rows in `$AGENTFLEET_HOME/runs/<id>/turns.jsonl` for the live dashboard History Gantt; import with `aflt turns backfill [--apply]`.
- **`aflt purge` / `aflt orphans`** — full delete (registry + `runs/<id>/` + engine chat when mapping is certain; dry-run unless `--apply`) and orphan/stale artifact scan (`aflt orphans --purge --ids … [--apply]`).
- **Turns → Doc Bot** — `turns.emitTurnCaptured` sends each captured turn to `doc-bot` via `messages.sendDirectMessage` when both sides have messaging enabled (otherwise a quiet no-op).
- **Notify webhook** — opt-in `config.json` `notify` or `AFLT_NOTIFY_URL` / `AFLT_NOTIFY_KEY` / `AFLT_NOTIFY_HEADER`; events `run.completed`, `run.failed`, `turn.captured`; probe with `aflt notify test`; `aflt doctor` reports status without printing the key; headless `aflt run` awaits the webhook before exit and pending notifies flush on CLI shutdown.
- **Dashboard UX** — Graph zoom / pan / Fit-to-view / Spread slider; History Gantt time presets (24h / 7d / 30d / all), zoom / scroll / pan, overlapping marker stacking and count badges (`aflt dashboard --serve`).
- **`aflt memory config`** — dry-run by default; compares template-managed memory-repo root files (`DOC-AGENT.md`, `DOCUMENTATION-PROCESS.md`) to package templates; `--apply` writes (`.bak` only for local edits), then regenerates root `DASHBOARD.md` (doc-bot summary preserved); optional `--commit`/`--push`; `aflt doctor` hints when `DOC-AGENT.md` is outdated.
