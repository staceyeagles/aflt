'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const cursor = require('../lib/cursor');
const copilot = require('../lib/copilot');
const runlib = require('../lib/run');

const sample = {
  id: 'auth-aaa',
  title: 'Auth refactor',
  chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  cwd: '/tmp/wt-auth',
  model: 'gpt-5',
  engine: 'cursor',
};

describe('headless command builders', () => {
  it('cursor print args include -p, resume, workspace, mode, force, trust, prompt', () => {
    const args = cursor.buildPrintArgs(sample, {
      prompt: 'Reply pong',
      mode: 'ask',
      force: true,
      outputFormat: 'text',
      trust: true,
    });
    assert.equal(args[0], '-p');
    assert.deepEqual(args.slice(1, 3), ['--output-format', 'text']);
    assert.ok(args.includes('--resume'));
    assert.ok(args.includes(sample.chatId));
    assert.ok(args.includes('--workspace'));
    assert.ok(args.includes('/tmp/wt-auth'));
    assert.ok(args.includes('--mode'));
    assert.ok(args.includes('ask'));
    assert.ok(args.includes('--force'));
    assert.ok(args.includes('--trust'));
    assert.equal(args[args.length - 1], 'Reply pong');
  });

  it('cursor print args omit --force and --trust when disabled', () => {
    const args = cursor.buildPrintArgs(sample, {
      prompt: 'hi',
      force: false,
      trust: false,
    });
    assert.ok(!args.includes('--force'));
    assert.ok(!args.includes('--trust'));
  });

  it('cursor print args reject empty prompt and bad mode', () => {
    assert.throws(() => cursor.buildPrintArgs(sample, { prompt: '' }), /prompt is required/);
    assert.throws(() => cursor.buildPrintArgs(sample, { prompt: 'x', mode: 'yolo' }), /unsupported --mode/);
  });

  it('copilot print args use -p, -C, --session-id=, and --allow-all-tools only with force', () => {
    const args = copilot.buildPrintArgs(sample, { prompt: 'Reply pong', force: true, silent: true });
    assert.deepEqual(args.slice(0, 4), ['-p', 'Reply pong', '--output-format', 'text']);
    assert.ok(args.includes('--silent'));
    assert.ok(args.includes('-C'));
    assert.ok(args.includes('/tmp/wt-auth'));
    assert.ok(args.includes('--session-id=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    assert.ok(args.includes('--allow-all-tools'));
    const noForce = copilot.buildPrintArgs(sample, { prompt: 'Reply pong', force: false });
    assert.ok(!noForce.includes('--allow-all-tools'));
  });

  it('copilot newSessionId is a UUID', () => {
    assert.match(copilot.newSessionId(), /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });
});

describe('spawnCaptured', () => {
  it('captures stdout and exit code', async () => {
    const r = await runlib.spawnCaptured(process.execPath, ['-e', 'process.stdout.write("hi\\n")']);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, 'hi\n');
    assert.equal(r.timedOut, false);
  });

  it('times out and kills a hanging process', async () => {
    const r = await runlib.spawnCaptured(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], {
      timeoutMs: 200,
    });
    assert.equal(r.timedOut, true);
    assert.ok(r.signal === 'SIGTERM' || r.code !== 0);
  });
});

describe('af run CLI dry-run', () => {
  let tmp;
  before(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cli-'));
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('prints a cursor print-mode command without creating a registry row', () => {
    const r = spawnSync(process.execPath, [afJs, 'run', 'probe-dry', '--prompt', 'Reply pong', '--cwd', tmp, '--mode', 'ask', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTFLEET_HOME: tmp, AGENTFLEET_CURSOR_BIN: 'cursor-agent' },
    });
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.includes('-p'));
    assert.ok(r.stdout.includes('--output-format'));
    assert.ok(r.stdout.includes('--mode'));
    assert.ok(r.stdout.includes('Reply pong'));
    assert.ok(!fs.existsSync(path.join(tmp, 'sessions.json')));
  });

  it('prints a copilot command on dry-run and adds --allow-all-tools only with --force', () => {
    const dry = spawnSync(process.execPath, [afJs, 'run', 'copilot-dry', '--engine', 'copilot', '--prompt', 'Reply pong', '--cwd', tmp, '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTFLEET_HOME: tmp, AGENTFLEET_COPILOT_BIN: 'copilot' },
    });
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(dry.stdout.includes('-p'));
    assert.ok(dry.stdout.includes('Reply pong'));
    assert.ok(!dry.stdout.includes('--allow-all-tools'));

    const forced = spawnSync(process.execPath, [afJs, 'run', 'copilot-force', '--engine', 'copilot', '--prompt', 'Reply pong', '--cwd', tmp, '--force', '--dry-run'], {
      encoding: 'utf8',
      env: { ...process.env, AGENTFLEET_HOME: tmp, AGENTFLEET_COPILOT_BIN: 'copilot' },
    });
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(forced.stdout.includes('--allow-all-tools'));
    assert.ok(!forced.stdout.includes('--allow-all ') && !forced.stdout.includes('--yolo'));
  });

  it('help mentions run, log, and herdr-templates', () => {
    const r = spawnSync(process.execPath, [afJs, 'help'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.ok(r.stdout.includes('af run'));
    assert.ok(r.stdout.includes('af log'));
    assert.ok(r.stdout.includes('herdr-templates'));
  });
});
