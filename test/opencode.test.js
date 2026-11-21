'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const opencode = require('../lib/opencode');
const engine = require('../lib/engine');
const config = require('../lib/config');
const turns = require('../lib/turns');
const registry = require('../lib/registry');

const sample = {
  id: 'oc-sess-1',
  title: 'OpenCode probe',
  chatId: 'ses_fixture00000000000000001',
  cwd: '/tmp/wt-opencode',
  model: 'ai-lb/gemma4:12b-16k',
  engine: 'opencode',
};

function withHome(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-opencode-'));
  const prevHome = process.env.AGENTFLEET_HOME;
  const prevEngine = process.env.AGENTFLEET_ENGINE;
  const prevOcHome = process.env.AGENTFLEET_OPENCODE_HOME;
  const prevOcDb = process.env.AGENTFLEET_OPENCODE_DB;
  const prevOcBin = process.env.AGENTFLEET_OPENCODE_BIN;
  process.env.AGENTFLEET_HOME = tmp;
  delete process.env.AGENTFLEET_ENGINE;
  delete process.env.AGENTFLEET_OPENCODE_HOME;
  delete process.env.AGENTFLEET_OPENCODE_DB;
  delete process.env.AGENTFLEET_OPENCODE_BIN;
  try {
    return fn(tmp);
  } finally {
    if (prevHome === undefined) delete process.env.AGENTFLEET_HOME;
    else process.env.AGENTFLEET_HOME = prevHome;
    if (prevEngine === undefined) delete process.env.AGENTFLEET_ENGINE;
    else process.env.AGENTFLEET_ENGINE = prevEngine;
    if (prevOcHome === undefined) delete process.env.AGENTFLEET_OPENCODE_HOME;
    else process.env.AGENTFLEET_OPENCODE_HOME = prevOcHome;
    if (prevOcDb === undefined) delete process.env.AGENTFLEET_OPENCODE_DB;
    else process.env.AGENTFLEET_OPENCODE_DB = prevOcDb;
    if (prevOcBin === undefined) delete process.env.AGENTFLEET_OPENCODE_BIN;
    else process.env.AGENTFLEET_OPENCODE_BIN = prevOcBin;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

function sqliteAvailable() {
  try {
    opencode.loadSqliteSync();
    return true;
  } catch (_) {
    return false;
  }
}

describe('opencode argv builders', () => {
  it('builds headless run args with --session and prompt', () => {
    const args = opencode.buildPrintArgs(sample, { prompt: 'Reply pong' });
    assert.equal(args[0], 'run');
    assert.ok(args.includes('--session'));
    assert.ok(args.includes(sample.chatId));
    assert.ok(args.includes('--model'));
    assert.ok(args.includes(sample.model));
    assert.equal(args[args.length - 1], 'Reply pong');
    assert.ok(!args.includes('--format'));
  });

  it('maps json output-format; --force is currently a no-op for OpenCode argv', () => {
    const args = opencode.buildPrintArgs(sample, {
      prompt: 'hi',
      outputFormat: 'json',
      force: true,
    });
    assert.ok(args.includes('--format'));
    assert.ok(args.includes('json'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
    assert.ok(!args.includes('--force'));
  });

  it('builds interactive --session / --prompt', () => {
    const args = opencode.buildInteractiveArgs(sample, { prompt: 'go', force: true });
    assert.equal(args[0], '--session');
    assert.equal(args[1], sample.chatId);
    assert.ok(args.includes('--prompt'));
    assert.ok(args.includes('go'));
    assert.ok(!args.includes('--dangerously-skip-permissions'));
  });

  it('engine.buildInteractiveCommand routes to opencode', () => {
    const cmd = engine.buildInteractiveCommand(sample, {});
    assert.equal(cmd[0], opencode.resolveOpencodeBin());
    assert.ok(cmd.includes('--session'));
    assert.ok(cmd.includes(sample.chatId));
  });

  it('rejects invalid session ids', () => {
    assert.throws(
      () =>
        opencode.buildPrintArgs(
          { ...sample, chatId: 'not-a-session' },
          { prompt: 'x' }
        ),
      /invalid OpenCode session id/
    );
  });

  it('extractSessionIdFromOutput finds ses_* in JSONL', () => {
    const id = opencode.extractSessionIdFromOutput(
      '{"type":"text","sessionID":"ses_abc123XYZ00000000000001","part":{"text":"hi"}}\n'
    );
    assert.equal(id, 'ses_abc123XYZ00000000000001');
  });
});

describe('opencode config + doctor soft check', () => {
  it('accepts opencode as defaultEngine', () => {
    withHome(() => {
      assert.equal(config.setDefaultEngine('opencode'), 'opencode');
      assert.equal(config.getDefaultEngineFromConfig(), 'opencode');
      assert.deepEqual(engine.resolveEngine({}), { engine: 'opencode', source: 'config' });
    });
  });

  it('doctor reports opencode_bin without failing when missing', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-oc-doctor-'));
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-oc-stub-'));
    try {
      fs.writeFileSync(path.join(stubDir, 'cursor-agent'), '#!/bin/sh\necho ok\n', { mode: 0o755 });
      const r = spawnSync(process.execPath, [afJs, 'doctor', '--json'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTFLEET_HOME: home,
          AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
          PATH: stubDir, // no opencode / hc / copilot
        },
      });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      const body = JSON.parse(r.stdout);
      const oc = body.checks.find((c) => c.name === 'opencode_bin');
      assert.ok(oc, JSON.stringify(body.checks));
      assert.equal(oc.ok, false);
      assert.equal(body.ok, true);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('dry-run new --engine opencode does not touch real OpenCode home', () => {
    withHome((tmp) => {
      const fakeOcHome = path.join(tmp, 'oc-home');
      fs.mkdirSync(fakeOcHome, { recursive: true });
      const r = spawnSync(
        process.execPath,
        [afJs, 'new', 'oc-dry', '--engine', 'opencode', '--dry-run', '--cwd', tmp],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            AGENTFLEET_HOME: tmp,
            AGENTFLEET_OPENCODE_HOME: fakeOcHome,
            AGENTFLEET_OPENCODE_BIN: path.join(tmp, 'missing-opencode'),
          },
        }
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.match(r.stderr, /would create an OpenCode session/);
      assert.ok(r.stdout.includes('opencode') || r.stdout.includes('--session'));
      assert.deepEqual(fs.readdirSync(fakeOcHome), []);
    });
  });
});

describe('opencode turn capture from fixture sqlite', () => {
  it('pairs user/assistant text parts and dedupes on backfill', () => {
    if (!sqliteAvailable()) {
      // Node <22.5: capture degrades; assert the clear error path.
      const missing = opencode.iterSessionTurns('ses_fixture00000000000000001', {
        env: { AGENTFLEET_OPENCODE_DB: path.join(os.tmpdir(), 'nope.db') },
      });
      assert.ok(missing.unavailable || (missing.errors && missing.errors.length));
      return;
    }

    withHome((tmp) => {
      const dbPath = path.join(tmp, 'fixture.db');
      const fixture = opencode.writeFixtureDb(dbPath, {
        sessionId: sample.chatId,
        directory: tmp,
        turns: [
          { prompt: 'ping', reply: 'pong' },
          { prompt: 'second', reply: 'reply-two' },
        ],
      });
      process.env.AGENTFLEET_OPENCODE_DB = fixture.path;

      const session = registry.add({
        title: 'oc-turns',
        chatId: sample.chatId,
        cwd: tmp,
        engine: 'opencode',
        status: 'active',
      });

      const dry = turns.syncOpencodeSession(session, {
        apply: false,
        dryRun: true,
        fullScan: true,
        dbPath: fixture.path,
      });
      assert.equal(dry.scanned, 2);
      assert.equal(dry.wouldWrite, 2);

      const first = turns.syncOpencodeSession(session, {
        apply: true,
        fullScan: true,
        dbPath: fixture.path,
      });
      assert.equal(first.written, 2);

      const again = turns.syncOpencodeSession(session, {
        apply: true,
        fullScan: true,
        dbPath: fixture.path,
      });
      assert.equal(again.written, 0);
      assert.ok(again.skipped >= 2);

      const rows = turns.readTurns(session.id);
      assert.equal(rows.length, 2);
      assert.equal(rows[0].prompt, 'ping');
      assert.equal(rows[0].reply, 'pong');
      assert.equal(rows[0].engine, 'opencode');
      assert.equal(rows[1].prompt, 'second');
    });
  });

  it('never opens the real ~/.local/share/opencode path in tests', () => {
    withHome((tmp) => {
      const sentinel = path.join(tmp, 'sentinel-oc');
      fs.mkdirSync(sentinel, { recursive: true });
      process.env.AGENTFLEET_OPENCODE_HOME = sentinel;
      assert.equal(opencode.resolveOpencodeHome(process.env), sentinel);
      assert.equal(
        opencode.resolveDbPath(process.env),
        path.join(sentinel, 'opencode.db')
      );
      // list with missing db → empty, no throw
      assert.deepEqual(opencode.listLocalSessions({ env: process.env }), []);
    });
  });
});
