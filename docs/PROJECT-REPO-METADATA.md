# Project ↔ repository metadata

Issue #1: portable project identity, many-to-many project↔repo mappings, and
machine-local checkout paths — without rewriting historical `session.project`
assignments.

Projects still need **no git**. Metadata is opt-in. With no memory repo and no
mappings, behavior matches the pre-issue-#1 basename / `.agentfleet.json`
`"project"` rules.

## Three layers

| Layer | Where | Portable? | Role |
|-------|--------|-----------|------|
| **Memory project** | `<memoryRepo>/<folder>/.agentfleet.json` | yes (commit with memory) | Stable project `id`, repository identities, repo-relative `locations`, optional `relationships` |
| **Source checkout** | `<checkout>/.agentfleet.json` | yes (lives in the code repo) | Optional **launch default** only: `"project"` / `"projectId"` → project id (plus existing messaging/docs keys) |
| **Local checkouts** | `~/.agentfleet/config.json` → `"repositories"` | **no** (per machine) | Absolute/`~` paths for each remote identity |

Assigned project identity (`session.project`, `--project`, `AFLT_PROJECT`, source
`"project"`) stays separate from cwd. Mappings are used to **infer** a project
only when the match is unambiguous. Unavailable checkouts are reported, never
invented. Existing registry rows are never rewritten to backfill `project`.

## Memory-side schema

Path: `<memoryRepo>/<folder>/.agentfleet.json`  
Folder name should match the project id (same sanitization as memory sync).

```json
{
  "id": "lab-assistant",
  "name": "Lab Assistant",
  "repositories": [
    {
      "id": "lab-assistant",
      "remote": "github.com/wwlib/lab-assistant",
      "locations": ["."]
    },
    {
      "id": "hub-docs",
      "remote": "github.com/wwlib/master-copilot-directory",
      "locations": ["docs/lab-assistant"]
    }
  ],
  "relationships": [
    { "type": "related", "project": "graph-memory" }
  ]
}
```

| Field | Required | Meaning |
|-------|----------|---------|
| `id` | recommended | Stable project id (grouping / memory folder / `--project`). If omitted, falls back to `"project"` then the folder name. |
| `name` | no | Display label (dashboard / `aflt projects`); does not replace `id`. |
| `project` | no | Legacy alias for `id` when `id` is absent (same string form as today's source config). |
| `repositories` | no | Many repos per project; the same remote may appear under many projects. |
| `repositories[].id` | no | Stable repo key within the project (defaults to normalized remote). |
| `repositories[].remote` | yes\* | Canonical remote identity (see normalization). Aliases: `url`, or `remotes` / `urls` (arrays). |
| `repositories[].locations` | no | Repo-relative path prefixes owned by this project. Default `["."]`. Use subpaths for monorepos / hub layouts. |
| `relationships` | no | Soft links to other project ids (`type` + `project`). |

\*Each repository entry needs at least one remote/url string.

**Backward compatible:** a folder with no `.agentfleet.json`, or only
`{"project":"my-app"}`, is still a valid project (id = folder / that string) with
zero repository mappings.

See `templates/project-agentfleet.example.json` for a copy-paste template.
Do **not** commit real private mappings into a shared memory repo from this
package — examples stay in-repo / in tests.

## Source-side schema (unchanged role)

Path: walk cwd → ancestors for `.agentfleet.json` (git root / fs root).

```json
{
  "project": "lab-assistant",
  "messaging": true,
  "docs": true
}
```

Optional synonym:

```json
{ "projectId": "lab-assistant" }
```

`"project"` / `"projectId"` remain an optional **create-time default** referencing
the project id. They do not store checkout paths. Other keys (`messaging`,
`docs`, `agentDocs`, …) are unchanged.

## Local config: checkout paths

`~/.agentfleet/config.json` (never the memory repo):

```json
{
  "defaultEngine": "cursor",
  "memoryRepo": "/path/to/aflt-memory",
  "repositories": {
    "github.com/wwlib/lab-assistant": {
      "path": "~/github/wwlib/lab-assistant"
    },
    "github.com/wwlib/master-copilot-directory": {
      "path": "~/github/master-copilot-directory"
    }
  }
}
```

Keys are **normalized remote identities**. Values are `{ "path": "…" }` (string
path also accepted). Paths may use `~`. Missing paths → checkout status
`unavailable` (visible in `aflt projects` / dashboard), not a hard failure.

## Remote identity normalization

Inputs such as:

- `https://github.com/wwlib/lab-assistant.git`
- `git@github.com:wwlib/lab-assistant.git`
- `ssh://git@github.com/wwlib/lab-assistant`

all normalize to `github.com/wwlib/lab-assistant` (lowercase host, strip
userinfo / `.git` / trailing slashes).

## Resolution rules

### Create (`resolveProjectForCreate`)

1. `--project`
2. parent/master project
3. `AFLT_PROJECT`
4. source `.agentfleet.json` `"project"` / `"projectId"`
5. `$AGENTFLEET_HOME/config.json` `"project"`
6. **Unambiguous mapping inference** (memory metadata + local checkouts + git remotes / location containment) — only when exactly one project matches
7. git-root basename
8. cwd basename / `adhoc`

Ambiguous matches skip inference (fall through to basename). No memory repo →
skip step 6.

### Read (`resolveProjectName`)

Stored `session.project` always wins (canonicalized via legacy aliases only).
Rows without `project` use cwd rules including unambiguous mapping inference.
**Never** rewrite the registry to backfill.

### Commits (timeline / memory sync)

- When a session's git remote maps to the project's `locations`, `git log` uses
  those pathspecs (`confirmed` attribution).
- Whole-repo windows on a remote shared by multiple projects are marked
  `inferred` and deduped so the same SHA is not claimed by every sharing project
  as exclusive fact.
- Unavailable checkouts yield empty commits with reason `unavailable-checkout`.

## CLI

```bash
aflt projects              # table: id, repos, checkout status, problems
aflt projects --json       # full validation payload
aflt projects <id>         # one project (exact id / folder)
```

Read-only: no registry or memory writes.

## Many-to-many

- One project → many repositories (and location slices).
- One repository → many projects (different `locations`, or shared `.` with
  `inferred` commit attribution).
- Non-git / adhoc projects remain first-class with empty `repositories`.
