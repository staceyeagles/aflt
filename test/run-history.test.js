'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('run-history', () => {
  let home;
  let runHistory;
  let runlib;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-runhist-'));
    process.env.AGENTFLEET_HOME = home;
    process.env.HOME = home;
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/run')];
    delete require.cache[require.resolve('../lib/run-history')];
    delete require.cache[require.resolve('../lib/memory')];
    runlib = require('../lib/run');
    runHistory = require('../lib/run-history');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('parses legacy headless logs and extracts Cursor trailing prompts', () => {
    const file = path.join(home, 'legacy.txt');
    runlib.writeRunLog(file, {
      argv: ['/bin/cursor-agent', '-p', '--output-format', 'text', '--resume', 'abc', '--trust', 'Reply with pong'],
      cwd: '/tmp/proj',
      stdout: 'pong\n',
      stderr: '',
      code: 0,
      signal: null,
      timedOut: false,
    });
    const parsed = runHistory.parseRunLog(fs.readFileSync(file, 'utf8'), { engine: 'cursor' });
    assert.equal(parsed.cwd, '/tmp/proj');
    assert.equal(parsed.prompt, 'Reply with pong');
    assert.equal(parsed.stdout, 'pong');
    assert.equal(parsed.exit, 0);
    assert.equal(parsed.kind, 'headless');
  });

  it('parses Copilot -p prompts and optional # prompt / # kind headers', () => {
    const file = path.join(home, 'copilot.txt');
    runlib.writeRunLogHeader(file, {
      argv: ['copilot', '-p', 'do the thing', '--output-format', 'text', '--session-id=uuid'],
      cwd: '/work',
      kind: 'headless',
      prompt: 'do the thing',
    });
    runlib.appendRunLog(file, 'done\n');
    runlib.writeRunLogFooter(file, { stderr: '', code: 0, signal: null, timedOut: false });
    const parsed = runHistory.parseRunLog(fs.readFileSync(file, 'utf8'), { engine: 'copilot' });
    assert.equal(parsed.kind, 'headless');
    assert.equal(parsed.prompt, 'do the thing');
    assert.equal(parsed.stdout, 'done');
  });

  it('records interactive launch receipts without breaking existing layout', () => {
    const out = runlib.recordInteractiveLaunch('sess-1', {
      engine: 'cursor',
      argv: ['cursor-agent', '--resume', 'chat', '--trust', 'hello there'],
      cwd: '/proj',
      prompt: 'hello there',
      kind: 'interactive',
    });
    assert.ok(out && fs.existsSync(out));
    const text = fs.readFileSync(out, 'utf8');
    assert.match(text, /# argv:/);
    assert.match(text, /# kind: interactive/);
    assert.match(text, /# prompt: hello there/);
    assert.match(text, /# --- stdout ---/);
    assert.match(text, /# exit: n\/a/);
    const parsed = runHistory.parseRunLog(text, { engine: 'cursor' });
    assert.equal(parsed.prompt, 'hello there');
    assert.equal(parsed.kind, 'interactive');
    assert.equal(parsed.stdout, '');
  });

  it('lists run logs newest-first and builds redacted history events', () => {
    const session = { id: 'sess-hist', title: 'Hist', engine: 'cursor' };
    const dir = runHistory.runLogDir(session.id);
    fs.mkdirSync(dir, { recursive: true });
    const older = path.join(dir, '2026-01-01T00-00-00-000Z.cursor.txt');
    const newer = path.join(dir, '2026-01-02T00-00-00-000Z.cursor.txt');
    runlib.writeRunLog(older, {
      argv: ['bin', '-p', `token=sk-secret1234567890abcdef`],
      cwd: home,
      stdout: 'ok',
      code: 0,
    });
    // Ensure newer mtime
    runlib.writeRunLog(newer, {
      argv: ['bin', '-p', 'second prompt'],
      cwd: home,
      stdout: 'second reply\nline2\nline3\nline4\nline5\nline6\nline7\n',
      code: 0,
    });
    const files = runHistory.listRunLogFiles(session.id);
    assert.equal(files[0].name.startsWith('2026-01-02'), true);
    const events = runHistory.historyEventsFromRunLogs(session, { project: 'demo', redact: true });
    assert.ok(events.length >= 2);
    assert.equal(events[0].type, 'prompt-reply');
    assert.equal(events[0].prompt, 'second prompt');
    assert.equal(events[0].replyTruncated, true);
    assert.match(events[1].prompt || '', /\[redacted\]/);
  });

  it('splitShellArgv round-trips escapeShellArg embedding', () => {
    const { escapeShellArg } = require('../lib/util');
    const prompt = "it's a test";
    const line = ['bin', '-p', prompt].map(escapeShellArg).join(' ');
    const tokens = runHistory.splitShellArgv('# argv: ' + line);
    assert.deepEqual(tokens, ['bin', '-p', prompt]);
  });

  it('sessionActivityMarkers emits completed/failed finished-turn points only', () => {
    const session = { id: 'marker-sess', title: 'Markers', engine: 'cursor' };
    const dir = runHistory.runLogDir(session.id);
    fs.mkdirSync(dir, { recursive: true });
    runlib.writeRunLog(path.join(dir, '2026-01-01T00-00-00-000Z.cursor.txt'), {
      argv: ['bin', '-p', 'ok prompt'],
      cwd: home,
      stdout: 'all good\n',
      code: 0,
      prompt: 'ok prompt',
    });
    runlib.writeRunLog(path.join(dir, '2026-01-02T00-00-00-000Z.cursor.txt'), {
      argv: ['bin', '-p', `secret=sk-abcdefghijklmnopqrstuvwxyz012345`],
      cwd: home,
      stdout: 'boom\n',
      code: 1,
      prompt: 'secret=sk-abcdefghijklmnopqrstuvwxyz012345',
    });
    // Interactive receipt without exit/reply must not become a marker.
    runlib.recordInteractiveLaunch(session.id, {
      engine: 'cursor',
      argv: ['cursor-agent', '--resume', 'chat', '--trust', 'pending'],
      cwd: home,
      prompt: 'pending',
      kind: 'interactive',
    });

    const markers = runHistory.sessionActivityMarkers(session, { redact: true });
    assert.equal(runHistory.sessionActivitySegments(session).length, 0);
    assert.ok(markers.length >= 2);
    assert.ok(markers.every((m) => m.state === 'completed' || m.state === 'failed'));
    const failed = markers.find((m) => m.state === 'failed');
    const ok = markers.find((m) => m.state === 'completed');
    assert.ok(failed);
    assert.ok(ok);
    assert.match(ok.prompt || '', /ok prompt/);
    assert.match(ok.reply || '', /all good/);
    assert.match(failed.prompt || '', /\[redacted\]/);
    assert.equal(failed.sessionId, session.id);
    assert.ok(String(ok.prompt || '').length <= runHistory.MARKER_TEXT_MAX + 1);
  });
});
