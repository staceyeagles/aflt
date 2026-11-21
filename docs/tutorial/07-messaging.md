# 07 — Direct messaging

**Goals**

- Enable messaging only when both sides opt in
- Use the real `msg` / `inbox` / `thread` / `mcp` commands from USAGE
- Treat messages as durable context — never as permissions or wake-ups

## Opt-in

Off by default. Enable with any of:

- `aflt msg enable <session>`
- `--messaging` on `new` / `run` / `master` / `spawn`
- Project `.agentfleet.json` `{"messaging": true}` (ancestor walk to git root)

Session `messaging: false` always wins. Messaging-enabled masters pass `messaging: true` to workers unless `--no-messaging`. **Both sender and recipient must be opted in.**

Limits: `AGENTFLEET_MSG_MAX_THREAD` (default 6), `AGENTFLEET_MSG_RATE` (default 10 per 60s).

## Commands

```bash
# Per-session toggle
aflt --space tutorial msg enable <session> --json --dry-run
aflt --space tutorial msg disable <session> --json

# Send (types: question | answer | note | blocked; default note)
aflt --space tutorial msg <to> <text...> [--type T] [--reply <msgId>] [--from S] [--json] [--dry-run]

# Inbox / thread
aflt --space tutorial inbox [<session>] [--unread] [--status queued|read|completed] \
  [--mark-read|--mark-complete] [--json]
aflt --space tutorial thread <msgId|master> [--json]
```

`<to>` = exact id, unique exact title, or team aliases `master` / `all-siblings`. With `--reply` and no `<to>`, defaults to the reply sender. From a non-af shell, pass `--from <session>`. Inside an af-launched session, identity comes from `AGENTFLEET_SESSION` / `AGENTFLEET_ID`.

Statuses: `queued` → `read` → `completed`.

Messages never wake agents, inject prompts, change lifecycle/role/parent/project, or grant permissions.

## MCP

```bash
aflt mcp
# Stdio server; tools advertised only when messaging is enabled for the identity.
# Server name: af. Tools: post_message, read_inbox, list_team

aflt mcp install --engine cursor --project --cwd "$PWD" --dry-run --json
aflt mcp install --engine copilot --dry-run --json
# --write merges user config (backs up first); Cursor --project → <cwd>/.cursor/mcp.json
```

## Try it

Without live agents, dry-run enable and confirm USAGE-backed flags:

```bash
aflt space create tutorial   # if needed
aflt --space tutorial msg enable tutorial-session --dry-run --json
aflt --space tutorial inbox --json
```

Expect a clear error if the session does not exist or messaging is off — do not invent session ids from another space.
