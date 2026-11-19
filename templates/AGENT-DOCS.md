# AGENT-DOCS.md — project documentation pointers

Copy this file to the project repo root (next to `AGENTS.md`) when enabling
opt-in agent documentation (`.agentfleet.json`: `"agentDocs": true`).

Keep this file **small**. Point at paths; do not duplicate `AGENTS.md`.

## Project

- **aflt project name:** `<project>` (must match memory folder / `--project`)
- **Memory folder:** `<memory-repo>/<project>/` (when a memory repo is configured)

## Read first

1. `AGENTS.md` in this repo (existing instructions — follow them)
2. Shared process: `$AFLT_DOCS_PROCESS` (usually `<memory-repo>/DOCUMENTATION-PROCESS.md`)
3. Latest live status note in the memory folder (`status-notes/*.md`, ignore `archive/`)
4. `<project>/dashboard.md` in memory (summary only)

## When to write

After a milestone or substantial session:

1. New note: `status-notes/YYYY-MM-DDTHHMM-<slug>.md` in the memory project folder
   (or this repo's `docs/status-notes/` if that is the project convention)
2. Update the project `dashboard.md` summary when the note changes where-we-were
3. Mark the checkpoint complete: `aflt docs checkpoint complete --note <path>`

## Archive

Move obsolete notes to `status-notes/archive/` (same filename). Never delete.
aflt never auto-moves or deletes documents.

## Checkpoints

```bash
aflt docs checkpoint request
aflt docs --status --json
aflt docs checkpoint complete --note path/to/note.md
```
