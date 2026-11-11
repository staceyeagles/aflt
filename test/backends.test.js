'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const backends = require('../lib/backends');
const cursor = require('../lib/cursor');

const sample = [
  {
    id: 'auth-aaa',
    title: 'Auth refactor',
    chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: '/tmp/wt-auth',
    model: 'gpt-5',
    prompt: '',
    status: 'active',
  },
  {
    id: 'pay-bbb',
    title: 'Payments',
    chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: '/tmp/wt-pay',
    model: null,
    prompt: '',
    status: 'active',
  },
];

describe('command building', () => {
  it('buildResumeArgs includes --resume and optional model/workspace', () => {
    const args = cursor.buildResumeArgs(sample[0], { prompt: '' });
    assert.deepEqual(args.slice(0, 2), ['--resume', sample[0].chatId]);
    assert.ok(args.includes('--model'));
    assert.ok(args.includes('gpt-5'));
    assert.ok(args.includes('--workspace'));
    assert.ok(args.includes('/tmp/wt-auth'));
    assert.ok(args.includes('--trust'));
    assert.ok(!args.includes(''));
  });

  it('buildResumeArgs appends prompt when provided', () => {
    const args = cursor.buildResumeArgs(sample[1], { prompt: 'continue' });
    assert.equal(args[args.length - 1], 'continue');
  });

  it('tmux plan creates new-window argv with cursor-agent --resume', () => {
    const plan = backends.buildResumeAllPlan(sample, { via: 'tmux', tmuxSession: 'fleet-test' });
    assert.equal(plan.backend, 'tmux');
    const windows = plan.commands.filter((c) => c.kind === 'window');
    assert.equal(windows.length, 2);
    for (const w of windows) {
      assert.equal(w.argv[0], 'tmux');
      assert.equal(w.argv[1], 'new-window');
      assert.ok(w.argv.includes('--resume'));
      assert.ok(w.shell.includes('tmux new-window'));
    }
    const attach = plan.commands.find((c) => c.kind === 'attach-hint');
    assert.ok(attach.shell.includes('tmux attach -t'));
  });

  it('wezterm plan uses cli spawn --cwd and set-tab-title', () => {
    const plan = backends.buildResumeAllPlan(sample, { via: 'wezterm' });
    assert.equal(plan.backend, 'wezterm');
    assert.equal(plan.commands.length, 2);
    const c0 = plan.commands[0];
    assert.deepEqual(c0.spawnArgv.slice(0, 4), ['wezterm', 'cli', 'spawn', '--cwd']);
    assert.equal(c0.spawnArgv[4], '/tmp/wt-auth');
    assert.ok(c0.spawnArgv.includes('--resume'));
    assert.ok(c0.shell.includes('wezterm cli spawn'));
    assert.ok(c0.shell.includes('set-tab-title'));
  });

  it('iterm2 plan emits AppleScript with tab titles and write text', () => {
    const plan = backends.buildResumeAllPlan(sample, { via: 'iterm2' });
    assert.equal(plan.backend, 'iterm2');
    assert.ok(plan.applescript.includes('tell application "iTerm"'));
    assert.ok(plan.applescript.includes('create tab with default profile'));
    assert.ok(plan.applescript.includes('Auth refactor'));
    assert.ok(plan.applescript.includes('Payments'));
    assert.ok(plan.applescript.includes('--resume'));
    assert.ok(plan.applescript.includes('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    assert.ok(plan.applescript.includes('write text'));
  });

  it('plain plan prints cd + resume commands', () => {
    const plan = backends.buildResumeAllPlan(sample, { via: 'plain' });
    assert.equal(plan.backend, 'plain');
    assert.equal(plan.commands.length, 2);
    assert.ok(plan.commands[0].shell.includes('cd '));
    assert.ok(plan.commands[0].shell.includes('--resume'));
  });

  it('sanitizeTmuxName strips odd characters', () => {
    assert.equal(backends.sanitizeTmuxName('Auth / refactor!'), 'Auth-refactor');
  });
});

describe('herdr backend', () => {
  it('herdr plan uses hc run --bg with name, cwd, labels and no -- separator', () => {
    const plan = backends.buildResumeAllPlan(sample, { via: 'herdr' });
    assert.equal(plan.backend, 'herdr');
    assert.equal(plan.commands.length, 2);
    const c0 = plan.commands[0];
    assert.deepEqual(c0.argv.slice(0, 5), ['hc', 'run', '--bg', '--no-parent', '--outlive-parent']);
    assert.deepEqual(c0.argv.slice(5, 9), ['--name', 'auth-refactor', '--cwd', '/tmp/wt-auth']);
    assert.ok(c0.argv.includes('af_id=auth-aaa'));
    assert.ok(c0.argv.includes('title=Auth refactor'));
    // Verified 2026-11-10 on Mini hc 0.1.16: a `--` token is treated as the
    // program name and fails with spawn_failed ("cannot start \"--\"").
    assert.ok(!c0.argv.includes('--'));
    const resume = cursor.buildResumeCommand(sample[0]);
    assert.deepEqual(c0.argv.slice(-resume.length), resume);
    assert.ok(c0.shell.startsWith('hc run --bg'));
    assert.ok(!c0.shell.includes(' -- -- '));
  });

  it('sanitizeHerdrName lowercases, strips, truncates to 32', () => {
    assert.equal(backends.sanitizeHerdrName('Auth Refactor!! (v2)'), 'auth-refactor-v2');
    assert.equal(backends.sanitizeHerdrName('***'), 'agent');
    const long = backends.sanitizeHerdrName('x'.repeat(50));
    assert.equal(long.length, 32);
    assert.match(backends.sanitizeHerdrName('Ünïcode — title'), /^[a-z0-9_-]{1,32}$/);
  });

  it('de-duplicates names, including against live terminals', () => {
    const dup = [sample[0], { ...sample[1], id: 'x2', title: 'Auth refactor' }];
    const plan = backends.buildResumeAllPlan(dup, {
      via: 'herdr',
      herdrLive: [{ name: 'auth-refactor', labels: {} }],
    });
    assert.equal(plan.commands[0].name, 'auth-refactor-2');
    assert.equal(plan.commands[1].name, 'auth-refactor-3');
    const t = new Set(['y'.repeat(32)]);
    const n = backends.uniqueHerdrName('y'.repeat(40), t);
    assert.ok(n.length <= 32 && n.endsWith('-2'));
  });

  it('skips sessions already live by af_id label', () => {
    const live = backends.parseHerdrList(JSON.stringify([{ name: 'foo', labels: { af_id: 'pay-bbb' } }]));
    const plan = backends.buildResumeAllPlan(sample, { via: 'herdr', herdrLive: live });
    assert.ok(!plan.commands[0].skip);
    assert.ok(plan.commands[1].skip);
  });

  it('parseHerdrList tolerates bad JSON and alternate shapes', () => {
    assert.deepEqual(backends.parseHerdrList('not json'), []);
    assert.deepEqual(backends.parseHerdrList('{"terminals":[{"name":"a","labels":["af_id=z"]}]}'), [
      { name: 'a', labels: { af_id: 'z' } },
    ]);
  });

  it('insideHerdr checks env', () => {
    assert.equal(backends.insideHerdr({}), false);
    assert.equal(backends.insideHerdr({ HERDR: '1' }), true);
    assert.equal(backends.insideHerdr({ HC_TERMINAL: 'abc' }), true);
  });
});
