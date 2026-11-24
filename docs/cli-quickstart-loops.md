# Kick off loop development from the CLI (no assistant)

Copy-paste paths for a **fresh Mac**: install AgentFleet, sign in to an engine, run the **hello-aflt** tile-dungeon loop, and watch it in the dashboard. Aligned with [tutorial/01-install.md](tutorial/01-install.md), [SETUP.md](SETUP.md), and [tutorial/09-loops.md](tutorial/09-loops.md).

Self-improve loop (worktree + verify tiers): [self-improve-runbook.md](self-improve-runbook.md).

## 1. Install aflt

```bash
git clone https://github.com/wwlib/aflt.git ~/github/wwlib/aflt
cd ~/github/wwlib/aflt
npm link
# or: npm install -g .
# or: ln -sfn "$(pwd)/bin/af.js" ~/.local/bin/{aflt,af,agentfleet}
```

Ensure the npm global bin dir and `~/.local/bin` are on `PATH` (`which aflt`).

```bash
aflt --version
aflt setup --apply
```

## 2. Install and sign in to an engine

Add `~/.local/bin` to PATH if Cursor installed `cursor-agent` there:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

### Copilot (recommended for hello-aflt)

```bash
npm install -g @github/copilot
copilot
# complete browser / device sign-in
```

### Cursor

```bash
curl https://cursor.com/install -fsS | bash
cursor-agent status
```

### Preflight

```bash
aflt doctor --strict
```

## 3. Model selection

Precedence for loop workers: phase `model` → definition `model` → `COPILOT_MODEL` (Copilot only) → `config.json` `defaultModel`. Example:

```bash
export COPILOT_MODEL=claude-sonnet-4.5
# or set "model" on the loop JSON / phase
```

## 4. Empty repo + isolated space

```bash
mkdir -p ~/tmp/td && cd ~/tmp/td
git init -b main
export AFLT_SPACE=td-copilot
export AGENTFLEET_ENGINE=copilot
```

## 5. Validate and run hello-aflt

Replace `AFLT_HOME` with your clone path.

```bash
AFLT_HOME=~/github/wwlib/aflt

aflt loop validate "$AFLT_HOME/examples/loops/hello-aflt/hello-aflt.json" --json
aflt loop run "$AFLT_HOME/examples/loops/hello-aflt/hello-aflt.json" --dry-run --json

aflt loop run "$AFLT_HOME/examples/loops/hello-aflt/hello-aflt.json"
```

### Background / scheduler (optional)

Does not block this terminal; dashboard scheduler runs phases when the server is up:

```bash
aflt loop start "$AFLT_HOME/examples/loops/hello-aflt/hello-aflt.json" --json
aflt dashboard --serve --port 8787
```

Then `aflt loop status hello-aflt --json`, `aflt loop pause hello-aflt`, `aflt loop resume hello-aflt`, `aflt loop stop hello-aflt`.

## 6. Watch the dashboard

```bash
AFLT_SPACE=td-copilot aflt dashboard --serve --port 8787
```

Open `http://127.0.0.1:8787/` → Loops tab.

---

## Copilot one block

```bash
git clone https://github.com/wwlib/aflt.git ~/github/wwlib/aflt
cd ~/github/wwlib/aflt && npm link
npm install -g @github/copilot && copilot
export PATH="$HOME/.local/bin:$PATH"
aflt doctor --strict
mkdir -p ~/tmp/td && cd ~/tmp/td && git init -b main
export AFLT_SPACE=td-copilot AGENTFLEET_ENGINE=copilot
# optional: export COPILOT_MODEL=...
aflt loop run ~/github/wwlib/aflt/examples/loops/hello-aflt/hello-aflt.json
# another terminal:
AFLT_SPACE=td-copilot aflt dashboard --serve --port 8787
```

## Cursor one block

```bash
git clone https://github.com/wwlib/aflt.git ~/github/wwlib/aflt
cd ~/github/wwlib/aflt && npm link
curl https://cursor.com/install -fsS | bash
export PATH="$HOME/.local/bin:$PATH"
cursor-agent status
aflt doctor --strict
mkdir -p ~/tmp/td && cd ~/tmp/td && git init -b main
export AFLT_SPACE=td-cursor AGENTFLEET_ENGINE=cursor
aflt loop run ~/github/wwlib/aflt/examples/loops/hello-aflt/hello-aflt.json
# another terminal:
AFLT_SPACE=td-cursor aflt dashboard --serve --port 8787
```