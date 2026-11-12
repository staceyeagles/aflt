'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-stub-'));
const stubLog = path.join(stubDir, 'args.log');
const stubBin = path.join(stubDir, 'cursor-agent');

before(() => {
  fs.writeFileSync(
    stubBin,
    `#!/usr/bin/env bash
echo "$@" >> "${stubLog}"
if [[ "$1" == "create-chat" ]]; then
  echo "deadbeef-0000-4000-8000-ffffffffffff"
  exit 0
fi
if [[ "$1" == "ls" ]]; then
  echo "interactive-only" >&2
  exit 0
fi
exit 0
`,
    { mode: 0o755 }
  );
  process.env.AGENTFLEET_CURSOR_BIN = stubBin;
  delete require.cache[require.resolve('../lib/cursor')];
});

after(() => {
  delete process.env.AGENTFLEET_CURSOR_BIN;
  fs.rmSync(stubDir, { recursive: true, force: true });
});

describe('cursor wrapper with stub', () => {
  it('createChat returns stub UUID and records args', async () => {
    const cursor = require('../lib/cursor');
    const id = await cursor.createChat({ timeoutMs: 5000 });
    assert.equal(id, 'deadbeef-0000-4000-8000-ffffffffffff');
    const log = fs.readFileSync(stubLog, 'utf8');
    assert.ok(log.includes('create-chat'));
  });

  it('firstLine parses UUID', () => {
    const cursor = require('../lib/cursor');
    assert.equal(
      cursor.firstLine('  \n  abcdef01-2345-6789-abcd-ef0123456789\n'),
      'abcdef01-2345-6789-abcd-ef0123456789'
    );
    assert.equal(cursor.firstLine('not an id'), null);
  });

  it('buildResumeCommandString uses stub bin', () => {
    const cursor = require('../lib/cursor');
    const cmd = cursor.buildResumeCommandString({
      chatId: 'deadbeef-0000-4000-8000-ffffffffffff',
      cwd: '/tmp/x',
      model: null,
      prompt: '',
    });
    assert.ok(cmd.includes(stubBin) || cmd.includes('cursor-agent') || cmd.startsWith("'"));
    assert.ok(cmd.includes('--resume'));
    assert.ok(cmd.includes('deadbeef-0000-4000-8000-ffffffffffff'));
  });

  it('buildResumeArgs omits saved session.prompt unless opts.prompt is set', () => {
    const cursor = require('../lib/cursor');
    const session = {
      chatId: 'deadbeef-0000-4000-8000-ffffffffffff',
      cwd: '/tmp/x',
      model: null,
      prompt: 'DO_NOT_RESEND unique task prompt',
    };
    const args = cursor.buildResumeArgs(session);
    assert.ok(!args.includes('DO_NOT_RESEND unique task prompt'));
    const empty = cursor.buildResumeArgs(session, { prompt: '' });
    assert.ok(!empty.includes('DO_NOT_RESEND unique task prompt'));
    const firstLaunch = cursor.buildResumeCommand(session, {
      prompt: 'Refactor auth to JWT',
    });
    assert.ok(!firstLaunch.includes('DO_NOT_RESEND unique task prompt'));
    assert.equal(firstLaunch[firstLaunch.length - 1], 'Refactor auth to JWT');
  });
});

describe('live cursor-agent (optional)', () => {
  it('create-chat returns a UUID when available', async (t) => {
    // Prefer real binary if present and not overridden — use a one-off spawn
    const which = spawnSync('bash', ['-lc', 'which cursor-agent || which agent'], {
      encoding: 'utf8',
    });
    const real = (which.stdout || '').trim().split('\n')[0];
    if (!real || real === stubBin) {
      t.skip('no real cursor-agent on PATH');
      return;
    }
    // Call the real binary directly (ignore AGENTFLEET_CURSOR_BIN stub)
    const r = spawnSync(real, ['create-chat'], {
      encoding: 'utf8',
      timeout: 25000,
      env: { ...process.env, AGENTFLEET_CURSOR_BIN: undefined },
    });
    // timeout may kill after print — still check stdout
    const line = (r.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean);
    if (!line) {
      t.skip(`create-chat produced no output (status=${r.status}, signal=${r.signal})`);
      return;
    }
    assert.match(line, /^[0-9a-f-]{36}$/i);
  });
});
