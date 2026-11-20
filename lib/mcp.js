'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { homeDir, fleetDir } = require('./util');
const messages = require('./messages');
const registry = require('./registry');
const packageJson = require('../package.json');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'af', version: String(packageJson.version || '0.0.0') };

const TOOL_DEFS = [
  {
    name: 'post_message',
    description:
      'Send an opted-in message to master, all-siblings, or any session (exact id / unique exact title). Both sides must have messaging enabled. Messages are context only — not permission grants. Does not wake agents.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description:
            'Recipient: exact session id or unique exact title, or master / all-siblings (team only)',
        },
        text: { type: 'string', description: 'Message text' },
        type: {
          type: 'string',
          enum: ['question', 'answer', 'note', 'blocked'],
          description: 'Message type (default note)',
        },
        reply_to: { type: 'string', description: 'Optional parent message id' },
      },
      required: ['to', 'text'],
    },
  },
  {
    name: 'read_inbox',
    description:
      'Read messages addressed to this session (team + direct). Status: queued | read | completed.',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Only queued (unread) messages' },
        status: {
          type: 'string',
          enum: ['queued', 'read', 'completed'],
          description: 'Filter by delivery status',
        },
        mark_read: {
          type: 'boolean',
          description: 'Append read receipts for returned messages (default true)',
        },
        mark_complete: {
          type: 'boolean',
          description: 'Mark returned messages completed (implies read)',
        },
      },
    },
  },
  {
    name: 'list_team',
    description: 'List this session\'s team (master + workers)',
    inputSchema: { type: 'object', properties: {} },
  },
];

function logErr(...args) {
  try {
    process.stderr.write(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' ') + '\n');
  } catch (_) {
    /* ignore */
  }
}

function writeMessage(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function rpcResult(id, result) {
  writeMessage({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  writeMessage({ jsonrpc: '2.0', id, error: { code, message: String(message) } });
}

function toolErrorText(text) {
  return {
    isError: true,
    content: [{ type: 'text', text: String(text) }],
  };
}

function toolOkText(text) {
  return {
    content: [{ type: 'text', text: String(text) }],
  };
}

function resolveCallerSession() {
  const id = messages.resolveEnvSessionId(process.env);
  if (!id) return { error: 'AGENTFLEET_SESSION / AGENTFLEET_ID not set; launch via aflt so identity is injected' };
  let session;
  try {
    session = registry.find(id);
  } catch (err) {
    return { error: err.message };
  }
  if (!session) return { error: `session not found for AGENTFLEET_SESSION/ID: ${id}` };
  return { session };
}

function toolsAvailable() {
  const { session, error } = resolveCallerSession();
  if (error || !session) return [];
  const eff = messages.isMessagingEnabled(session);
  if (!eff.enabled) return [];
  return TOOL_DEFS;
}

function callPostMessage(args) {
  const { session, error } = resolveCallerSession();
  if (error) return toolErrorText(error);
  try {
    messages.assertEnabled(session);
  } catch (err) {
    return toolErrorText(err.message);
  }
  try {
    const result = messages.postMessage({
      fromSession: session,
      to: args && args.to,
      text: args && args.text,
      type: args && args.type,
      replyTo: args && (args.reply_to || args.replyTo),
      sessions: registry.list({ includeDone: true, includeArchived: true }),
    });
    return toolOkText(JSON.stringify(result, null, 2));
  } catch (err) {
    return toolErrorText(err.message);
  }
}

function callReadInbox(args) {
  const { session, error } = resolveCallerSession();
  if (error) return toolErrorText(error);
  try {
    messages.assertEnabled(session);
  } catch (err) {
    return toolErrorText(err.message);
  }
  const unreadOnly = Boolean(args && args.unread_only);
  const status =
    args && args.status != null && args.status !== '' ? String(args.status) : null;
  if (status && !messages.MSG_STATUSES.has(status)) {
    return toolErrorText('invalid status (want queued|read|completed)');
  }
  const markComplete = Boolean(args && args.mark_complete);
  const markRead = markComplete
    ? true
    : args && Object.prototype.hasOwnProperty.call(args, 'mark_read')
      ? Boolean(args.mark_read)
      : true;
  const inbox = messages.inboxForSession(session, { unreadOnly, status });
  if ((markRead || markComplete) && inbox.length) {
    messages.markMessages(
      inbox.map((m) => m.id),
      session.id,
      { complete: markComplete }
    );
    for (const m of inbox) {
      m.status = markComplete ? 'completed' : 'read';
      m.read = true;
    }
  }
  return toolOkText(JSON.stringify({ messages: inbox }, null, 2));
}

function callListTeam() {
  const { session, error } = resolveCallerSession();
  if (error) return toolErrorText(error);
  try {
    messages.assertEnabled(session);
  } catch (err) {
    return toolErrorText(err.message);
  }
  const teamId = messages.teamIdOf(session);
  if (!teamId) return toolErrorText(`session "${session.title}" has no team`);
  const sessions = registry.list({ includeDone: true });
  const { all } = messages.teamMembers(teamId, sessions);
  const rows = all.map((s) => ({
    id: s.id,
    title: s.title,
    role: s.role || null,
    engine: s.engine || 'cursor',
    workerStatus: s.workerStatus || null,
  }));
  return toolOkText(JSON.stringify({ team: teamId, sessions: rows }, null, 2));
}

function handleToolsCall(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  if (name === 'post_message') return callPostMessage(args);
  if (name === 'read_inbox') return callReadInbox(args);
  if (name === 'list_team') return callListTeam(args);
  return toolErrorText(`unknown tool: ${name}`);
}

function handleRequest(msg) {
  const { id, method, params } = msg;
  if (method === 'initialize') {
    const clientVersion = params && params.protocolVersion;
    rpcResult(id, {
      protocolVersion: clientVersion || PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }
  if (method === 'notifications/initialized' || method === 'initialized') {
    // notification — no reply
    return;
  }
  if (method === 'ping') {
    rpcResult(id, {});
    return;
  }
  if (method === 'tools/list') {
    rpcResult(id, { tools: toolsAvailable() });
    return;
  }
  if (method === 'tools/call') {
    try {
      const result = handleToolsCall(params || {});
      rpcResult(id, result);
    } catch (err) {
      rpcResult(id, toolErrorText(err.message || String(err)));
    }
    return;
  }
  if (id !== undefined) {
    rpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function runServer() {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = String(line || '').trim();
    if (!trimmed) continue;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch (err) {
      logErr('mcp: invalid JSON:', err.message);
      continue;
    }
    if (!msg || typeof msg !== 'object') continue;
    // Notifications have no id; requests have id.
    if (msg.method) {
      try {
        handleRequest(msg);
      } catch (err) {
        logErr('mcp: handler error:', err.message || err);
        if (msg.id !== undefined) rpcError(msg.id, -32603, err.message || String(err));
      }
    }
  }
}

function mcpConfigPath(engine, env = process.env) {
  const home = env.HOME || homeDir();
  if (engine === 'copilot') return path.join(home, '.copilot', 'mcp-config.json');
  if (engine === 'cursor') return path.join(home, '.cursor', 'mcp.json');
  throw new Error(`unknown engine: ${engine} (want copilot|cursor)`);
}

function afJsPath({ afPath } = {}) {
  return afPath || path.resolve(__dirname, '..', 'bin', 'af.js');
}

/** Keys Cursor must forward into the af MCP child via mcp.json interpolation. */
const CURSOR_MCP_ENV_KEYS = [
  'AGENTFLEET_SESSION',
  'AGENTFLEET_ID',
  'AGENTFLEET_MASTER',
  'AGENTFLEET_PARENT',
  'AGENTFLEET_HOME',
];

/**
 * Cursor does not pass its process env to MCP stdio servers. mcp.json `env`
 * values like `${env:AGENTFLEET_SESSION}` are interpolated from cursor-agent's
 * environment at load time (verified live).
 */
function cursorEnvInterpolation() {
  const env = {};
  for (const k of CURSOR_MCP_ENV_KEYS) {
    env[k] = `\${env:${k}}`;
  }
  return env;
}

function afEntryHasCursorEnvMapping(entry) {
  if (!entry || !entry.env || typeof entry.env !== 'object') return false;
  for (const k of CURSOR_MCP_ENV_KEYS) {
    const v = entry.env[k];
    if (typeof v !== 'string' || !v.includes(`\${env:${k}}`)) return false;
  }
  return true;
}

function buildAfServerEntry(engine, { nodePath, afPath, env } = {}) {
  const command = nodePath || process.execPath;
  const script = afJsPath({ afPath });
  const entry = {
    command,
    args: [script, 'mcp'],
  };
  if (engine === 'copilot') {
    entry.type = 'local';
    entry.tools = ['*'];
  }
  if (engine === 'cursor') {
    // Always emit interpolation block so cursor-agent can forward identity.
    entry.env = cursorEnvInterpolation();
  } else if (env && typeof env === 'object') {
    const cleaned = {};
    for (const [k, v] of Object.entries(env)) {
      if (v == null || v === '') continue;
      cleaned[k] = String(v);
    }
    if (Object.keys(cleaned).length) entry.env = cleaned;
  }
  return entry;
}

function buildInstallSnippet(engine, opts = {}) {
  return { mcpServers: { af: buildAfServerEntry(engine, opts) } };
}

/**
 * Env for an af MCP child so identity / home are explicit (also inherited from
 * af-launched engines that already set AGENTFLEET_*).
 */
function sessionMcpEnv(session, env = process.env) {
  const { envNonEmpty } = require('./util');
  return messages.sessionIdentityEnv(session, {
    AGENTFLEET_HOME: envNonEmpty(env, 'AGENTFLEET_HOME') || fleetDir(),
  });
}

/**
 * Copilot per-run MCP wiring (never writes ~/.copilot). Empty when messaging off.
 */
function copilotMcpLaunchArgs(session, opts = {}) {
  if (!session || !messages.isMessagingEnabled(session).enabled) return [];
  const entry = buildAfServerEntry('copilot', {
    nodePath: opts.nodePath,
    afPath: opts.afPath,
    env: sessionMcpEnv(session, opts.env),
  });
  const config = { mcpServers: { af: entry } };
  return ['--additional-mcp-config', JSON.stringify(config), '--allow-tool=af'];
}

function readMcpServersFile(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data.mcpServers && typeof data.mcpServers === 'object' ? data.mcpServers : null;
  } catch (_) {
    return null;
  }
}

/**
 * First project-then-user Cursor mcp.json that defines `af`.
 * @returns {{ path: string, entry: object }|null}
 */
function findCursorAfEntry(cwd, env = process.env) {
  const candidates = [];
  if (cwd) candidates.push(path.join(path.resolve(String(cwd)), '.cursor', 'mcp.json'));
  const home = (env && env.HOME) || homeDir();
  candidates.push(path.join(home, '.cursor', 'mcp.json'));
  for (const p of candidates) {
    const servers = readMcpServersFile(p);
    if (servers && servers.af) return { path: p, entry: servers.af };
  }
  return null;
}

/** True when project or user Cursor mcp.json defines an `af` server. */
function cursorHasAfMcp(cwd, env = process.env) {
  return Boolean(findCursorAfEntry(cwd, env));
}

/** True when the af entry has full `${env:…}` identity mapping. */
function cursorHasAfMcpEnvMapping(cwd, env = process.env) {
  const hit = findCursorAfEntry(cwd, env);
  return hit ? afEntryHasCursorEnvMapping(hit.entry) : false;
}

/** Process-local: warn at most once per af process about missing cursor env mapping. */
let warnedCursorMcpEnv = false;

function warnCursorMcpEnvIfNeeded(session, env = process.env) {
  if (warnedCursorMcpEnv) return false;
  if (!session || !messages.isMessagingEnabled(session).enabled) return false;
  const hit = findCursorAfEntry(session.cwd, env);
  if (!hit) return false;
  if (afEntryHasCursorEnvMapping(hit.entry)) return false;
  warnedCursorMcpEnv = true;
  try {
    process.stderr.write(
      'aflt: cursor mcp.json af entry missing env "${env:…}" mapping ' +
        `(${hit.path}); re-run aflt mcp install --engine cursor --project\n`
    );
  } catch (_) {
    /* ignore */
  }
  return true;
}

/**
 * Cursor: `--approve-mcps` when messaging is enabled and an af server is
 * present in project or user mcp.json. Cursor has no per-run MCP inject flag.
 * Warns once if the af entry lacks `${env:…}` identity mapping.
 */
function cursorMcpLaunchArgs(session, opts = {}) {
  if (!session || !messages.isMessagingEnabled(session).enabled) return [];
  const env = opts.env || process.env;
  if (!cursorHasAfMcp(session.cwd, env)) return [];
  warnCursorMcpEnvIfNeeded(session, env);
  return ['--approve-mcps'];
}

/** Doctor/info summary for messaging-enabled sessions. */
function doctorMcpWiring(sessions, env = process.env) {
  const list = Array.isArray(sessions) ? sessions : [];
  const enabled = list.filter((s) => messages.isMessagingEnabled(s).enabled);
  if (enabled.length === 0) return null;
  const copilotSessions = enabled.filter((s) => (s.engine || 'cursor') === 'copilot');
  const cursorSessions = enabled.filter((s) => (s.engine || 'cursor') === 'cursor');
  const cursorPresent = cursorSessions.filter((s) => cursorHasAfMcp(s.cwd, env));
  const cursorWired = cursorSessions.filter((s) => cursorHasAfMcpEnvMapping(s.cwd, env));
  const missingEnv = cursorPresent.length - cursorWired.length;
  let detail;
  if (cursorSessions.length === 0) {
    detail = 'no messaging-enabled cursor sessions';
  } else if (cursorWired.length === cursorSessions.length) {
    detail = `af in project/user mcp.json with \${env:…} mapping; --approve-mcps on launch (${cursorWired.length}/${cursorSessions.length})`;
  } else if (missingEnv > 0) {
    detail = `${missingEnv} cursor session(s) have aflt mcp without \${env:…} mapping — re-run: aflt mcp install --engine cursor --project`;
  } else {
    detail = `${cursorPresent.length}/${cursorSessions.length} have af in mcp.json — run: aflt mcp install --engine cursor --project`;
  }
  return {
    enabledCount: enabled.length,
    copilot: {
      sessions: copilotSessions.length,
      detail:
        'per-run --additional-mcp-config + --allow-tool=af (no ~/.copilot write)',
    },
    cursor: {
      sessions: cursorSessions.length,
      present: cursorPresent.length,
      wired: cursorWired.length,
      ok: cursorSessions.length === 0 || cursorWired.length === cursorSessions.length,
      detail,
    },
  };
}

function atomicWriteJson(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = path.join(dir, `.mcp.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, filePath);
}

function backupPath(filePath) {
  const compact = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let candidate = `${filePath}.bak-${compact}`;
  let n = 2;
  while (fs.existsSync(candidate)) {
    candidate = `${filePath}.bak-${compact}-${n}`;
    n++;
  }
  return candidate;
}

function installMcp({
  engine,
  write = false,
  dryRun = false,
  project = false,
  cwd = null,
  nodePath,
  afPath,
  env,
} = {}) {
  const eng = String(engine || '').trim();
  if (eng !== 'copilot' && eng !== 'cursor') {
    throw new Error(`--engine must be copilot or cursor (got ${engine})`);
  }
  if (project && eng !== 'cursor') {
    throw new Error('--project is only supported for --engine cursor');
  }
  let filePath;
  if (project) {
    const base = path.resolve(cwd || process.cwd());
    filePath = path.join(base, '.cursor', 'mcp.json');
  } else {
    filePath = mcpConfigPath(eng, env || process.env);
  }
  const snippet = buildInstallSnippet(eng, { nodePath, afPath });
  // --project always intends to write the project file; --write for user home.
  const doWrite = project ? !dryRun : Boolean(write) && !dryRun;
  if (!doWrite) {
    return {
      ok: true,
      dryRun: Boolean(dryRun) || !write,
      path: filePath,
      snippet,
      wrote: false,
      project: Boolean(project),
    };
  }
  let existing = { mcpServers: {} };
  if (fs.existsSync(filePath)) {
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') existing = parsed;
      }
    } catch (err) {
      throw new Error(`could not parse existing MCP config at ${filePath}: ${err.message}`);
    }
  }
  if (!existing.mcpServers || typeof existing.mcpServers !== 'object') {
    existing.mcpServers = {};
  }
  const bak = fs.existsSync(filePath) ? backupPath(filePath) : null;
  if (bak) fs.copyFileSync(filePath, bak);
  existing.mcpServers.af = snippet.mcpServers.af;
  atomicWriteJson(filePath, existing);
  return {
    ok: true,
    path: filePath,
    snippet,
    wrote: true,
    backup: bak,
    project: Boolean(project),
  };
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_INFO,
  TOOL_DEFS,
  CURSOR_MCP_ENV_KEYS,
  runServer,
  handleRequest,
  mcpConfigPath,
  afJsPath,
  cursorEnvInterpolation,
  afEntryHasCursorEnvMapping,
  buildAfServerEntry,
  buildInstallSnippet,
  sessionMcpEnv,
  copilotMcpLaunchArgs,
  findCursorAfEntry,
  cursorHasAfMcp,
  cursorHasAfMcpEnvMapping,
  warnCursorMcpEnvIfNeeded,
  cursorMcpLaunchArgs,
  doctorMcpWiring,
  installMcp,
};
