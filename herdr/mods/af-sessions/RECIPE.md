# af sessions

![af sessions](preview.png)

A Herdr sidebar panel that lists agentfleet (`af`) tracked sessions, shows
lifecycle and live Herdr runtime, and focuses or resumes them.

## What you see

A chrome-background panel under Agents (in the `af` layout). Header: “af
sessions”, session count, a refresh control, and a subtle “refreshing”
indicator while `af ls --json` runs. Rows show title, folder basename, branch,
lifecycle status, a colored runtime dot, and relative last-used. Group headers
“Running” / “Other”. Narrower than 160px: a compact rail of dots only.

## How it behaves

- Refresh every 8s and on the header button.
- Sort: running first, then lastUsed descending.
- Dot colors: running = working/accent; exited = muted; missing/unknown =
  blocked-ish; otherwise dim.
- Click a running row: `space.select` + `tab.select` via `herdrApp` ids. If the
  tab is absent, `af adopt <title>` then retry focus.
- Click a non-running row: `af resume <title> --no-open`, show “starting…”,
  poll `spaces()` ~1s for up to ~15s, then focus; toast on failure.
- Read-only: no done/delete/rename controls.
- Selected when `focused().tab` matches the row’s tab id.

## Built from

- Layout `layouts/af.json`: clone of `main` with an `af-sessions` block after
  `agents` in `sidebar-lists`.
- Mod `mods/af-sessions/` (`place: none`): gpui-kit `View`, `exec`/`run`/
  `spaces`/`focused`/`theme`/`notify`/`home` from `herdr`.
- Runs `af ls --json --all` (prefer `~/.local/bin/af`, else `/bin/zsh -lc`).

## Watch out

- App PATH may omit `af` / `node`; resolve via `~/.local/bin/af` then zsh `-lc`.
- Never keep a `cx`; use `cx.timer.every` (no `setTimeout`).
- Animate “refreshing” with `.loop`, not a notify timer.
- Do not dock into shipped `main`; use the `af` layout (`layout.switch`).

## Done when

- `herdr-app check herdr/mods/af-sessions` passes.
- `npm test` passes in the af repo.
- `af herdr-app install --dry-run` plans links into `$HERDR_APP_HOME`.
