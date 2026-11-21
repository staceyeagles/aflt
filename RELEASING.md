# Releasing aflt

aflt follows [Semantic Versioning](https://semver.org/).

| Bump | When | Example |
|------|------|---------|
| patch | Bug fixes only | 1.4.0 → 1.4.1 |
| minor | New, backward-compatible features | 1.4.1 → 1.5.0 |
| major | Breaking changes: removed/renamed commands or flags, incompatible registry/config formats | 1.5.0 → 2.0.0 |

## Day to day

- Every merged change adds a line under `## Unreleased` in `CHANGELOG.md`.
- Feature branches never bump `package.json`.

## Cutting a release

1. On a clean, up-to-date `main`, run the full suite: `npm test`.
2. In `CHANGELOG.md`, rename `## Unreleased` to `## X.Y.Z (YYYY-MM-DD)` and add a fresh empty `## Unreleased` above it.
3. Commit the changelog: `git commit -am "docs: changelog for X.Y.Z"`.
4. Bump and tag: `npm version patch|minor|major -m "release: v%s"` (updates `package.json`, commits, and creates tag `vX.Y.Z`).
5. Push: `git push origin main --follow-tags`.
6. Create the GitHub release from the tag, using the changelog section as notes:
   `gh release create vX.Y.Z --title vX.Y.Z --notes-file <section.md>`.
7. Publish to npm (once the package name is settled): `npm publish --access public`.

Installed commands link straight to the checkout, so `git pull` on each machine picks up a release; confirm with `aflt --version`.
