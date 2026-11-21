# 05 — Memory, timeline, turns, and docs

**Goals**

- Resolve and init a memory repo
- Sync timelines vs regenerate root `DASHBOARD.md`
- Backfill interactive turns (dry-run vs `--apply`)
- Know documentarian / agentDocs / Doc Bot boundaries
- Know what is committed and what is never staged

Project↔repo mappings: [PROJECT-REPO-METADATA.md](../PROJECT-REPO-METADATA.md).

## Memory repo

Opt-in. Resolution: `AFLT_MEMORY_REPO` → `config.json` `memoryRepo`. New named spaces get an isolated `memoryRepo` under the space home (notify still off).

```bash
aflt --space tutorial memory              # path or hint to init
aflt --space tutorial memory where --json
aflt --space tutorial memory init ~/path-or-space-memory --json
aflt --space tutorial memory status --json
```

`init` creates/registers a local git repo (never adds a remote, never commits). Writes README / `.gitignore` / `.aflt-memory.json` / `DOC-AGENT.md` / `DOCUMENTATION-PROCESS.md` when missing.

### Sync vs dashboard vs config

```bash
aflt --space tutorial memory sync --dry-run --json
aflt --space tutorial memory sync --all --dry-run
aflt --space tutorial memory dashboard --dry-run --json
aflt --space tutorial memory config --json          # dry-run default
# aflt --space tutorial memory config --apply       # write templates when ready
```

| Command | Writes |
|---------|--------|
| `memory sync` | `<project>/_aflt/timeline.md` + `sessions.jsonl`, then root `DASHBOARD.md` |
| `memory dashboard` | Root `DASHBOARD.md` only |
| `memory config` | Template-managed roots (`DOC-AGENT.md`, `DOCUMENTATION-PROCESS.md`); then regenerates root `DASHBOARD.md` |

**Committed only when you ask:** `--commit` stages root `DASHBOARD.md` + `*/_aflt/**` (and managed roots for `config --apply --commit`). Never stages human `README.md`, per-project `dashboard.md`, or `status-notes/`. `--push` requires `--commit`. `--commit --dry-run` is an error on sync.

Redaction is **on** by default for generated files (`--no-redact` to disable). `--all` skips `adhoc` unless `--include-adhoc` or named.

### Doc Bot

```bash
aflt --space tutorial memory doc --dry-run --json
# launches portable doc-bot via aflt run when not dry-run; needs DOC-AGENT.md
```

## Timeline (read-only)

```bash
aflt --space tutorial timeline
aflt --space tutorial timeline --all --json
aflt --space tutorial timeline --since 2026-11-01
```

No registry/Herdr writes. Default project: arg → `AFLT_PROJECT` → cwd project. Exit 0 when empty.

## Turns backfill

Interactive turns land in `runs/<id>/turns.jsonl` (History Gantt). Import from engine stores:

```bash
aflt --space tutorial turns backfill --json                 # dry-run counts
aflt --space tutorial turns backfill --engine all --json
# aflt --space tutorial turns backfill --apply --json       # write when ready
```

- Dry-run by default; pass **`--apply`** to write
- Idempotent (dedupe); can patch existing rows missing a prompt
- Does **not** write memory status-notes (that stays `dashboard --serve --capture-completions`)
- Copilot: events.jsonl; Cursor: unique transcript when mapped; OpenCode: read-only `opencode.db`

## Project status notes

Human / Doc Bot dated notes live under `<memoryRepo>/<project>/status-notes/`. Live pickup ignores `status-notes/archive/`. aflt **never** auto-moves or deletes documents. Copilot Task Complete → notes only with `--capture-completions` on the live dashboard.

## Documentarian and agentDocs

Both **opt-in** via project `.agentfleet.json`:

```json
{
  "docs": true,
  "docsPaths": ["README.md", "docs/"],
  "agentDocs": true,
  "docCheckpointHours": 4
}
```

```bash
aflt --space tutorial docs --status --json
aflt --space tutorial docs --dry-run --json
aflt --space tutorial docs checkpoint request --json
aflt --space tutorial docs notify status --json
```

- Documentarian updates **only** configured docs paths; force/write is on by default (`--no-force` / `docsForce: false` to opt out)
- `docs --status`: Doc Bot rule — skip when docs paths are dirty (`skipReason: "dirty-docs"`); act only when `ready` (`needsDocs && !skip`)
- agentDocs: checkpoints at safe boundaries; `complete` needs a dated live note; batched Doc Bot notify via `docs notify flush|ack|status|retry`
- Messaging optional for Doc Bot inbox (context only; never a permission grant)

## Try it

In the tutorial space (which already has an isolated memory path after `space create`):

```bash
aflt space create tutorial   # if needed
aflt --space tutorial memory where --json
aflt --space tutorial memory status --json
aflt --space tutorial turns backfill --json
aflt --space tutorial timeline --json
```

Confirm backfill reports counts without `--apply`, and that sync/config stay dry-run until you intentionally write.
