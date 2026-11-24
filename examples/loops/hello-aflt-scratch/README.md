# hello-aflt-scratch — tile dungeon from a docs-only seed

A variant of [`hello-aflt`](../hello-aflt/README.md) where the seed contains
**no code and no HTML**. The game repo starts with instructions only, and an
agent writes every file, including the M0 scaffold.

| | `hello-aflt` | `hello-aflt-scratch` |
|---|---|---|
| Seed copied into the repo | `m0-seed/`: `package.json`, `server.js`, `public/index.html`, `src/main.js`, `test/smoke.test.js`, docs | `seed/`: `AGENTS.md`, `SPEC.md`, `.agentfleet.json`, `.gitignore` |
| M0 phase | Agent told to "do nothing heavy"; `seed-m0.js` copies the scaffold | Real agent build of the scaffold from `SPEC.md` § M0 |
| M0 eval | `seed-m0.js` (copy + smoke test) | `m0-check.js` (structural check + `node --test` + server boot; never copies code) |
| M1–M5a, plan-next | Same milestones | Same milestones; prompts say there is no seed code and to work only in the repo |
| Improve gate | `improve-gate.js` | Shared: `../hello-aflt/improve-gate.js` |

Use it to see what an engine builds with nothing but a spec, and to compare
engines/models on the same docs-only starting point.

## Quick start

```bash
mkdir tile-dungeon-scratch && cd tile-dungeon-scratch && git init
aflt loop run /path/to/aflt/examples/loops/hello-aflt-scratch/hello-aflt-scratch.json
```

The M0 prompt carries the full scaffold contract, so the agent can start in a
truly empty repo. Right after the agent's first pass, `m0-check.js` installs
the seed docs (`AGENTS.md`, `SPEC.md`, `.agentfleet.json`, `.gitignore`,
never overwriting) and then verifies the scaffold; they are committed with M0,
and every later phase (and any M0 fix attempt) reads them.

Want the M0 agent to read `AGENTS.md` / `SPEC.md` on its very first attempt?
Pre-seed the docs, then pass `--allow-existing` (the folder is no longer an
empty repo, which `aflt loop run` otherwise refuses):

```bash
node /path/to/aflt/examples/loops/hello-aflt-scratch/m0-check.js --seed-docs
aflt loop run /path/to/aflt/examples/loops/hello-aflt-scratch/hello-aflt-scratch.json --allow-existing
```

Pick an engine as for `hello-aflt` (`AGENTFLEET_ENGINE=cursor` or `copilot`,
optional `COPILOT_MODEL` / definition `model`). Watch it live with a matching
space:

```bash
export AFLT_SPACE=scratch-run   # optional: keep this run in its own space
aflt loop start /path/to/aflt/examples/loops/hello-aflt-scratch/hello-aflt-scratch.json --json
aflt dashboard --serve --port 8787   # same AFLT_SPACE; open http://127.0.0.1:8787/
aflt loop status hello-aflt-scratch --json
```

## Seed

`seed/` may hold only instructions and config: `*.md`, `*.txt`,
`.agentfleet.json`, `.gitignore`. `m0-check.js` refuses to install anything
else, and `test/loop-hello-aflt-scratch.test.js` fails if a code or HTML file
(`.js`, `.mjs`, `.cjs`, `.ts`, `.html`, `.css`, other `.json`, …) is added.

- `seed/AGENTS.md` — stack, safety and workflow rules, milestone list.
- `seed/SPEC.md` — the M0 scaffold contract (files, routes, port, tests) and the M1–M5a plan.

## M0 check

`node m0-check.js` (run by the loop in the game cwd) fails with a list of
problems unless:

- `package.json` is valid JSON with `"type": "module"`, `test` running `node --test`, `start` running `node server.js`, and no dependencies;
- `server.js` is ESM, exports `createServer`, defaults to `127.0.0.1:8792`;
- `public/index.html` has `<canvas id="game">` and loads `/src/main.js` as a module;
- `src/main.js`, `test/smoke.test.js` (node:test, exercises `createServer`), `README.md` (mentions 8792), `AGENTS.md`, `SPEC.md` exist;
- every `test/*.test.js` passes;
- `node server.js` on a free port answers `/health` with `{"ok":true}`, `/` with the canvas page, and `/src/main.js` with 200 (it stops only the PID it started).

A failure goes back to the M0 agent as a fix attempt (up to 3).

## More improve rounds

After a finished run, the original continue loop works on this game too:

```bash
aflt loop run /path/to/aflt/examples/loops/hello-aflt/hello-aflt-improve.json --allow-existing
```

All other planner rules (3 kept rounds max, plateau stop, locked scorer) are the
same as [`hello-aflt`](../hello-aflt/README.md).
