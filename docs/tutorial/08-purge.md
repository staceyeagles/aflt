# 08 — Purge, archive, and orphans

**Goals**

- Prefer soft archive and dry-run before any delete
- Know what `purge` removes vs what `rm` keeps
- Never run a worked example that deletes your real default space

All examples below use `--space tutorial` (or `AFLT_SPACE=tutorial`). Do not copy them against the default home.

## Soft hide: archive / unarchive

```bash
aflt --space tutorial archive <title|id> --dry-run --json
aflt --space tutorial unarchive <title|id> --dry-run --json
```

Sets `archived` + `archivedAt` (status and `runs/` untouched). `--with-children` includes descendants. Refuses running/waiting (live `runPid` or Herdr working/blocked) unless `--force` (force does **not** stop the process — `aflt stop` first).

Archived sessions are hidden from `aflt ls` by default; use `--archived` or `--all`.

## Registry remove (`rm`)

```bash
aflt --space tutorial rm <title|id> --dry-run
aflt --space tutorial rm --children <master> --dry-run
```

Removes registry rows and af-owned files under `$AGENTFLEET_HOME` (`results/`, `plans/`). **Never** deletes `runs/<id>/`. `--keep-files`: registry only. Prefer exact ids/titles (agents: non-TTY / `--json` stay exact-only).

## Full delete: purge

```bash
# Dry-run by default (no --apply)
aflt --space tutorial purge <title|id> --json
aflt --space tutorial rm --purge <title|id> --json   # synonym

# Mutate only when intentional:
# aflt --space tutorial purge <title|id> --apply --yes --json
```

Removes: registry row, `runs/<id>/`, results/plans, master messages log, and engine Copilot/Cursor chat dir when mapping is certain. Never touches Herdr panes. OpenCode’s shared sqlite is not deleted on purge. Refuses busy sessions unless `--force`. `--yes` skips typed confirm (required for non-TTY apply). Optional: `--with-children`, `--no-engine` / `--aflt-only`, `--engine-only`, `--no-transcripts`.

Dry-run JSON includes `dryRun: true`, `apply: false`, and path actions such as `would-delete` (from the purge planner).

## Orphans scan

```bash
aflt --space tutorial orphans --json
aflt --space tutorial orphans --days 30 --engine all --json

# Selective purge of scan hits — still dry-run unless --apply
aflt --space tutorial orphans --purge --ids id1,id2 --json
# aflt --space tutorial orphans --purge --ids id1 --apply --yes --json
```

Non-destructive by default. `--purge` requires `--ids` (or TTY pick). Never auto-kills `herdr-orphan-pane`.

## Try it

Scan orphans in the **tutorial** space only (empty space → empty/harmless report):

```bash
aflt space create tutorial   # if needed
aflt --space tutorial orphans --json
aflt --space tutorial ls --archived --json
```

Do **not** run `purge --apply` or `space remove` against your default home as part of this exercise. Space removal is covered in [11 — Named spaces](11-spaces.md).
