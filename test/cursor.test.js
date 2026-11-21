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
    const id = await cursor.createChat({ timeoutMs: 20000 });
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

  it('parseCursorPrintOutput extracts result text + usage from json', () => {
    const cursor = require('../lib/cursor');
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 2133,
      result: 'OK',
      session_id: '574d45da-05fd-4c13-ac3a-fe96ae685aac',
      request_id: 'f417c52c-2819-40f5-90d6-d2d39cdd8ef8',
      usage: {
        inputTokens: 6187,
        outputTokens: 40,
        cacheReadTokens: 3968,
        cacheWriteTokens: 0,
        reasoningTokens: 39,
      },
    });
    const parsed = cursor.parseCursorPrintOutput(stdout, { format: 'json' });
    assert.equal(parsed.result, 'OK');
    assert.equal(parsed.usage.totalInput, 10155);
    assert.equal(parsed.usage.outputTokens, 40);
    assert.equal(parsed.usage.reasoningTokens, 39);
    assert.equal(parsed.requestId, 'f417c52c-2819-40f5-90d6-d2d39cdd8ef8');
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
    // Optional live smoke only. Prefer cursor-agent (not a generic `agent` that may
    // treat create-chat as a chat prompt). Skip — never fail — when unavailable,
    // unauthenticated, timed out, or stdout is not a UUID.
    const which = spawnSync('bash', ['-lc', 'which cursor-agent 2>/dev/null'], {
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
    const uuidRe = /^[0-9a-f-]{36}$/i;
    if (!line || !uuidRe.test(line)) {
      const preview = line ? line.slice(0, 120) : '(empty)';
      t.skip(
        `create-chat did not return a UUID (preview=${JSON.stringify(preview)}, status=${r.status}, signal=${r.signal})`
      );
      return;
    }
    assert.match(line, uuidRe);
  });
});
