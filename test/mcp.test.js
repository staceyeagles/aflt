'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

function rpc(proc, msg) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      const lines = buf.split(/\n/);
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.id === msg.id) {
            proc.stdout.off('data', onData);
            resolve(obj);
            return;
          }
        } catch (err) {
          proc.stdout.off('data', onData);
          reject(new Error(`bad JSON from mcp: ${line}`));
          return;
        }
      }
    };
    proc.stdout.on('data', onData);
    proc.stdin.write(JSON.stringify(msg) + '\n');
    setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`timeout waiting for id=${msg.id}; buf=${buf}`));
    }, 5000);
  });
}

describe('af mcp', () => {
  let home;
  let project;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mcp-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mcp-proj-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/messages')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function seed(messaging = true) {
    const registry = loadRegistry();
    const master = registry.add({
      title: 'McpMaster',
      chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeee0001',
      cwd: project,
      engine: 'cursor',
      role: 'master',
      status: 'active',
      messaging,
    });
    const w1 = registry.add({
      title: 'McpMaster-w1',
      chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeee0002',
      cwd: project,
      engine: 'cursor',
      role: 'worker',
      parent: master.id,
      status: 'active',
      messaging,
    });
    return { master, w1 };
  }

  function startMcp(extraEnv = {}) {
    const stdoutChunks = [];
    const proc = spawn(process.execPath, [afJs, 'mcp'], {
      env: {
        ...process.env,
        AGENTFLEET_HOME: home,
        HOME: home,
        AGENTFLEET_SESSION: '',
        AGENTFLEET_ID: '',
        AGENTFLEET_MASTER: '',
        AGENTFLEET_PARENT: '',
        ...extraEnv,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    proc.stdout.on('data', (d) => stdoutChunks.push(d.toString()));
    return { proc, stdoutChunks };
  }

  it('stdio: initialize → tools/list → tools/call; stdout only JSON-RPC', async () => {
    const { master, w1 } = seed(true);
    const { proc, stdoutChunks } = startMcp({ AGENTFLEET_SESSION: w1.id });
    try {
      const init = await rpc(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
      });
      assert.equal(init.result.protocolVersion, '2024-11-05');
      assert.equal(init.result.serverInfo.name, 'af');
      assert.deepEqual(init.result.capabilities, { tools: {} });

      proc.stdin.write(
        JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'
      );

      const listed = await rpc(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const names = (listed.result.tools || []).map((t) => t.name).sort();
      assert.deepEqual(names, ['list_team', 'post_message', 'read_inbox']);

      const posted = await rpc(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'post_message',
          arguments: { to: 'master', text: 'mcp hello', type: 'note' },
        },
      });
      assert.ok(!posted.result.isError, JSON.stringify(posted));
      assert.match(posted.result.content[0].text, /m-[0-9a-f]{8}/);

      const inbox = await rpc(proc, {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: { name: 'read_inbox', arguments: { unread_only: false, mark_read: true } },
      });
      assert.ok(!inbox.result.isError);

      const team = await rpc(proc, {
        jsonrpc: '2.0',
        id: 5,
        method: 'tools/call',
        params: { name: 'list_team', arguments: {} },
      });
      assert.ok(!team.result.isError);
      const teamBody = JSON.parse(team.result.content[0].text);
      assert.equal(teamBody.team, master.id);
      assert.ok(teamBody.sessions.some((s) => s.id === w1.id));

      const ping = await rpc(proc, { jsonrpc: '2.0', id: 6, method: 'ping' });
      assert.ok(ping.result);

      // All stdout lines must be JSON-RPC
      const all = stdoutChunks.join('');
      for (const line of all.split(/\n/).filter((l) => l.trim())) {
        const obj = JSON.parse(line);
        assert.equal(obj.jsonrpc, '2.0');
      }
    } finally {
      proc.kill('SIGTERM');
    }
  });

  it('default-off: tools/list empty; tools/call isError', async () => {
    const { w1 } = seed(false);
    const { proc } = startMcp({ AGENTFLEET_SESSION: w1.id });
    try {
      await rpc(proc, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } },
      });
      const listed = await rpc(proc, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      assert.deepEqual(listed.result.tools, []);

      const call = await rpc(proc, {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'post_message', arguments: { to: 'master', text: 'x' } },
      });
      assert.equal(call.result.isError, true);
      assert.match(call.result.content[0].text, /messaging not enabled/);
    } finally {
      proc.kill('SIGTERM');
    }
  });

  it('copilot launch args inject additional-mcp-config when messaging enabled', () => {
    const { w1 } = seed(true);
    delete require.cache[require.resolve('../lib/copilot')];
    delete require.cache[require.resolve('../lib/mcp')];
    const copilot = require('../lib/copilot');
    const args = copilot.buildPrintArgs(w1, { prompt: 'hi', force: false });
    const idx = args.indexOf('--additional-mcp-config');
    assert.ok(idx >= 0, args.join(' '));
    const cfg = JSON.parse(args[idx + 1]);
    assert.ok(cfg.mcpServers.af);
    assert.equal(cfg.mcpServers.af.env.AGENTFLEET_SESSION, w1.id);
    assert.ok(args.includes('--allow-tool=af'));

    const off = { ...w1, messaging: false };
    const argsOff = copilot.buildPrintArgs(off, { prompt: 'hi' });
    assert.ok(!argsOff.includes('--additional-mcp-config'));
  });

  it('cursor launch args pass --approve-mcps when project mcp has af', () => {
    const { w1 } = seed(true);
    delete require.cache[require.resolve('../lib/cursor')];
    delete require.cache[require.resolve('../lib/mcp')];
    const cursor = require('../lib/cursor');
    const mcp = require('../lib/mcp');

    assert.ok(!cursor.buildPrintArgs(w1, { prompt: 'hi' }).includes('--approve-mcps'));

    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mcp-proj2-'));
    try {
      mcp.installMcp({
        engine: 'cursor',
        project: true,
        cwd: proj,
        env: { HOME: home },
      });
      const session = { ...w1, cwd: proj, messaging: true };
      const args = cursor.buildPrintArgs(session, { prompt: 'hi' });
      assert.ok(args.includes('--approve-mcps'), args.join(' '));
      const interactive = cursor.buildResumeArgs(session, {});
      assert.ok(interactive.includes('--approve-mcps'));
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it('mcp install --project writes .cursor/mcp.json with backup', () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mcp-proj3-'));
    try {
      const cursorDir = path.join(proj, '.cursor');
      fs.mkdirSync(cursorDir, { recursive: true });
      const cfgPath = path.join(cursorDir, 'mcp.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ mcpServers: { other: { command: 'echo', args: ['x'] } } }, null, 2)
      );
      const r = spawnSync(
        process.execPath,
        [afJs, 'mcp', 'install', '--engine', 'cursor', '--project', '--cwd', proj, '--json'],
        { encoding: 'utf8', env: { ...process.env, AGENTFLEET_HOME: home, HOME: home } }
      );
      assert.equal(r.status, 0, r.stderr);
      const body = JSON.parse(r.stdout);
      assert.equal(body.wrote, true);
      assert.equal(body.project, true);
      assert.ok(body.backup);
      const merged = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.ok(merged.mcpServers.other);
      assert.ok(merged.mcpServers.af);
      assert.ok(!merged.mcpServers.af.type);
      assert.equal(merged.mcpServers.af.env.AGENTFLEET_SESSION, '${env:AGENTFLEET_SESSION}');
      assert.equal(merged.mcpServers.af.env.AGENTFLEET_ID, '${env:AGENTFLEET_ID}');
      assert.equal(merged.mcpServers.af.env.AGENTFLEET_MASTER, '${env:AGENTFLEET_MASTER}');
      assert.equal(merged.mcpServers.af.env.AGENTFLEET_PARENT, '${env:AGENTFLEET_PARENT}');
      assert.equal(merged.mcpServers.af.env.AGENTFLEET_HOME, '${env:AGENTFLEET_HOME}');
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it('cursor install merges env mapping into existing af entry; warns/doctor when missing', () => {
    delete require.cache[require.resolve('../lib/mcp')];
    delete require.cache[require.resolve('../lib/util')];
    const mcp = require('../lib/mcp');
    const util = require('../lib/util');

    // Empty / unresolved ${env:…} treated as unset
    const prevHome = process.env.AGENTFLEET_HOME;
    process.env.AGENTFLEET_HOME = '';
    assert.equal(util.fleetDir(), path.join(util.homeDir(), '.agentfleet'));
    process.env.AGENTFLEET_HOME = '${env:AGENTFLEET_HOME}';
    assert.equal(util.fleetDir(), path.join(util.homeDir(), '.agentfleet'));
    process.env.AGENTFLEET_HOME = prevHome;
    assert.ok(util.isUnresolvedEnvInterpolation('${env:AGENTFLEET_PARENT}'));
    assert.equal(util.envNonEmpty({ AGENTFLEET_MASTER: '${env:AGENTFLEET_MASTER}' }, 'AGENTFLEET_MASTER'), null);
    const messages = require('../lib/messages');
    assert.equal(messages.resolveEnvSessionId({ AGENTFLEET_SESSION: '' }), null);
    assert.equal(messages.resolveEnvSessionId({ AGENTFLEET_ID: '  ' }), null);
    assert.equal(
      messages.resolveEnvSessionId({ AGENTFLEET_SESSION: '${env:AGENTFLEET_SESSION}' }),
      null
    );

    const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mcp-proj4-'));
    try {
      const cfgPath = path.join(proj, '.cursor', 'mcp.json');
      fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
      // Legacy af entry without env mapping
      fs.writeFileSync(
        cfgPath,
        JSON.stringify(
          {
            mcpServers: {
              af: { command: 'node', args: [afJs, 'mcp'] },
            },
          },
          null,
          2
        )
      );
      assert.equal(mcp.cursorHasAfMcp(proj, { HOME: home }), true);
      assert.equal(mcp.cursorHasAfMcpEnvMapping(proj, { HOME: home }), false);

      const { w1 } = seed(true);
      const session = { ...w1, cwd: proj, messaging: true, engine: 'cursor' };
      const wiringBad = mcp.doctorMcpWiring([session], { HOME: home });
      assert.equal(wiringBad.cursor.ok, false);
      assert.match(wiringBad.cursor.detail, /\$\{env:/);

      assert.equal(mcp.warnCursorMcpEnvIfNeeded(session, { HOME: home }), true);
      assert.equal(mcp.warnCursorMcpEnvIfNeeded(session, { HOME: home }), false);

      delete require.cache[require.resolve('../lib/cursor')];
      const cursor = require('../lib/cursor');
      const args = cursor.buildPrintArgs(session, { prompt: 'hi' });
      assert.ok(args.includes('--approve-mcps'));

      // Re-install updates af entry with env mapping
      const updated = mcp.installMcp({
        engine: 'cursor',
        project: true,
        cwd: proj,
        env: { HOME: home },
      });
      assert.equal(updated.wrote, true);
      assert.ok(updated.backup);
      const merged = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.ok(mcp.afEntryHasCursorEnvMapping(merged.mcpServers.af));
      assert.equal(mcp.cursorHasAfMcpEnvMapping(proj, { HOME: home }), true);
      const wiringOk = mcp.doctorMcpWiring([session], { HOME: home });
      assert.equal(wiringOk.cursor.ok, true);
    } finally {
      fs.rmSync(proj, { recursive: true, force: true });
    }
  });

  it('mcp install print / --write backup merge with temp HOME', () => {
    const userHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-mcp-user-'));
    try {
      const print = spawnSync(
        process.execPath,
        [afJs, 'mcp', 'install', '--engine', 'copilot', '--json'],
        { encoding: 'utf8', env: { ...process.env, AGENTFLEET_HOME: home, HOME: userHome } }
      );
      assert.equal(print.status, 0, print.stderr);
      const printed = JSON.parse(print.stdout);
      assert.equal(printed.ok, true);
      assert.equal(printed.wrote, false);
      assert.equal(printed.snippet.mcpServers.af.type, 'local');
      assert.deepEqual(printed.snippet.mcpServers.af.tools, ['*']);
      assert.ok(printed.snippet.mcpServers.af.args.includes('mcp'));

      const cfgDir = path.join(userHome, '.copilot');
      fs.mkdirSync(cfgDir, { recursive: true });
      const cfgPath = path.join(cfgDir, 'mcp-config.json');
      fs.writeFileSync(
        cfgPath,
        JSON.stringify({ mcpServers: { other: { command: 'echo', args: ['hi'] } } }, null, 2)
      );

      const write = spawnSync(
        process.execPath,
        [afJs, 'mcp', 'install', '--engine', 'copilot', '--write', '--json'],
        { encoding: 'utf8', env: { ...process.env, AGENTFLEET_HOME: home, HOME: userHome } }
      );
      assert.equal(write.status, 0, write.stderr);
      const wrote = JSON.parse(write.stdout);
      assert.equal(wrote.wrote, true);
      assert.ok(wrote.backup);
      assert.ok(fs.existsSync(wrote.backup));

      const merged = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      assert.ok(merged.mcpServers.other);
      assert.ok(merged.mcpServers.af);
      assert.equal(merged.mcpServers.af.type, 'local');

      const cursorPrint = spawnSync(
        process.execPath,
        [afJs, 'mcp', 'install', '--engine', 'cursor', '--dry-run', '--json'],
        { encoding: 'utf8', env: { ...process.env, AGENTFLEET_HOME: home, HOME: userHome } }
      );
      assert.equal(cursorPrint.status, 0, cursorPrint.stderr);
      const cbody = JSON.parse(cursorPrint.stdout);
      assert.ok(!cbody.snippet.mcpServers.af.type);
      assert.ok(!cbody.snippet.mcpServers.af.tools);
      assert.equal(
        cbody.snippet.mcpServers.af.env.AGENTFLEET_SESSION,
        '${env:AGENTFLEET_SESSION}'
      );
      assert.equal(cbody.snippet.mcpServers.af.env.AGENTFLEET_HOME, '${env:AGENTFLEET_HOME}');
    } finally {
      fs.rmSync(userHome, { recursive: true, force: true });
    }
  });
});
