'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const backends = require('../lib/backends');
const cursor = require('../lib/cursor');

const SAVED_PROMPT = 'DO_NOT_RESEND unique task prompt';

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

const sampleWithPrompt = [
  {
    id: 'img-ccc',
    title: 'Img2img upscale',
    chatId: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: '/tmp/wt-img',
    model: 'gpt-5',
    prompt: SAVED_PROMPT,
    status: 'active',
  },
  {
    id: 'vid-ddd',
    title: 'Video production',
    chatId: 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: '/tmp/wt-vid',
    model: null,
    prompt: SAVED_PROMPT,
    status: 'active',
  },
];

function assertNoSavedPrompt(textOrArgs) {
  const s = Array.isArray(textOrArgs) ? textOrArgs.join(' ') : String(textOrArgs);
  assert.ok(!s.includes(SAVED_PROMPT), `saved prompt must not appear: ${s}`);
}

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

  it('buildResumeArgs does not fall back to session.prompt', () => {
    const withSaved = {
      chatId: 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: '/tmp/wt',
      model: null,
      prompt: SAVED_PROMPT,
    };
    const omitted = cursor.buildResumeArgs(withSaved);
    assert.ok(!omitted.includes(SAVED_PROMPT));
    assert.equal(omitted[omitted.length - 1], '--trust');

    const empty = cursor.buildResumeArgs(withSaved, { prompt: '' });
    assert.ok(!empty.includes(SAVED_PROMPT));

    const explicit = cursor.buildResumeArgs(withSaved, { prompt: 'explicit follow-up' });
    assert.ok(!explicit.includes(SAVED_PROMPT));
    assert.equal(explicit[explicit.length - 1], 'explicit follow-up');

    const cmd = cursor.buildResumeCommand(withSaved);
    assert.ok(!cmd.includes(SAVED_PROMPT));
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

  it('resume plans never resend a non-empty saved session.prompt', () => {
    for (const via of ['herdr', 'tmux', 'wezterm', 'iterm2', 'plain']) {
      const plan = backends.buildResumeAllPlan(sampleWithPrompt, { via, tmuxSession: 'fleet-test' });
      if (via === 'iterm2') {
        assertNoSavedPrompt(plan.applescript);
      }
      for (const c of plan.commands) {
        if (c.argv) assertNoSavedPrompt(c.argv);
        if (c.spawnArgv) assertNoSavedPrompt(c.spawnArgv);
        if (c.shell) assertNoSavedPrompt(c.shell);
        if (c.command) assertNoSavedPrompt(c.command);
        if (c.sendKeysArgv) assertNoSavedPrompt(c.sendKeysArgv);
      }
    }
  });

  it('sanitizeTmuxName strips odd characters', () => {
    assert.equal(backends.sanitizeTmuxName('Auth / refactor!'), 'Auth-refactor');
  });
});

describe('herdr backend', () => {
  it('herdr plan uses hc run --bg with name, cwd, labels, keep, herdr app labels, env color clear, and no -- separator', () => {
    const plan = backends.buildResumeAllPlan(sample, {
      via: 'herdr',
      resumeOpts: { herdrApp: true, env: { TERM: 'xterm-256color' } },
    });
    assert.equal(plan.backend, 'herdr');
    assert.equal(plan.commands.length, 2);
    const c0 = plan.commands[0];
    assert.deepEqual(c0.argv.slice(0, 5), ['hc', 'run', '--bg', '--no-parent', '--outlive-parent']);
    assert.deepEqual(c0.argv.slice(5, 9), ['--name', 'auth-refactor', '--cwd', '/tmp/wt-auth']);
    assert.ok(c0.argv.includes('af_id=auth-aaa'));
    assert.ok(c0.argv.includes('title=Auth refactor'));
    assert.ok(c0.argv.includes('--keep'));
    assert.ok(c0.argv.some((a) => String(a).startsWith('herdr.space=sp')));
    assert.ok(c0.argv.some((a) => String(a).startsWith('herdr.tab=tb')));
    const keepIdx = c0.argv.indexOf('--keep');
    const envIdx = c0.argv.indexOf('env');
    assert.ok(keepIdx > 0 && keepIdx < envIdx);
    // Verified 2026-11-10 on Mini hc 0.1.16: a `--` token is treated as the
    // program name and fails with spawn_failed ("cannot start \"--\"").
    assert.ok(!c0.argv.includes('--'));
    const resume = cursor.buildResumeCommand(sample[0]);
    const wrapped = ['env', '-u', 'NO_COLOR', '-u', 'FORCE_COLOR', ...resume];
    assert.deepEqual(c0.argv.slice(-wrapped.length), wrapped);
    assert.deepEqual(c0.argv.slice(envIdx, envIdx + 5), ['env', '-u', 'NO_COLOR', '-u', 'FORCE_COLOR']);
    assert.equal(c0.argv[envIdx + 5], resume[0]);
    assert.ok(!c0.argv.includes('TERM=xterm-256color'));
    assert.ok(c0.shell.startsWith('hc run --bg'));
    assert.ok(c0.shell.includes('env -u NO_COLOR -u FORCE_COLOR'));
    assert.ok(c0.shell.includes('--keep'));
    assert.ok(!c0.shell.includes(' -- -- '));
  });

  it('herdrEnvArgs sets TERM/COLORTERM when TERM is dumb, empty, or unset', () => {
    const expected = [
      'env',
      '-u',
      'NO_COLOR',
      '-u',
      'FORCE_COLOR',
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
    ];
    assert.deepEqual(backends.herdrEnvArgs({ TERM: 'dumb' }), expected);
    assert.deepEqual(backends.herdrEnvArgs({ TERM: '' }), expected);
    assert.deepEqual(backends.herdrEnvArgs({}), expected);
    assert.deepEqual(backends.herdrEnvArgs({ TERM: 'xterm-256color' }), [
      'env',
      '-u',
      'NO_COLOR',
      '-u',
      'FORCE_COLOR',
    ]);
  });

  it('buildHerdrCommands inserts TERM assignments for dumb caller env', () => {
    const cmds = backends.buildHerdrCommands(sample.slice(0, 1), {
      resumeOpts: { herdrApp: false, env: { TERM: 'dumb' } },
    });
    const argv = cmds[0].argv;
    const envIdx = argv.indexOf('env');
    assert.deepEqual(argv.slice(envIdx, envIdx + 7), [
      'env',
      '-u',
      'NO_COLOR',
      '-u',
      'FORCE_COLOR',
      'TERM=xterm-256color',
      'COLORTERM=truecolor',
    ]);
  });

  it('herdr plan omits --keep and herdr.space/tab when herdrApp disabled', () => {
    const plan = backends.buildResumeAllPlan(sample, {
      via: 'herdr',
      resumeOpts: { herdrApp: false },
    });
    const c0 = plan.commands[0];
    assert.ok(!c0.argv.includes('--keep'));
    assert.ok(!c0.argv.some((a) => String(a).startsWith('herdr.space=')));
    assert.ok(!c0.argv.some((a) => String(a).startsWith('herdr.tab=')));
    assert.equal(c0.herdrApp, false);
    assert.equal(c0.tabId, null);
  });

  it('herdr plan does not include saved session.prompt', () => {
    const plan = backends.buildResumeAllPlan(sampleWithPrompt, { via: 'herdr' });
    const c0 = plan.commands[0];
    assertNoSavedPrompt(c0.argv);
    assertNoSavedPrompt(c0.shell);
    assert.ok(c0.argv.includes('--resume'));
    assert.ok(c0.argv.includes(sampleWithPrompt[0].chatId));
  });

  it('herdr plan can pass an explicit resumeOpts.prompt', () => {
    const plan = backends.buildResumeAllPlan(sampleWithPrompt.slice(0, 1), {
      via: 'herdr',
      resumeOpts: { prompt: 'explicit follow-up' },
    });
    const c0 = plan.commands[0];
    assertNoSavedPrompt(c0.argv);
    assert.equal(c0.argv[c0.argv.length - 1], 'explicit follow-up');
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
    // Use a de-duplicated live name so skip.name comes from live, not a regenerated slug.
    const live = backends.parseHerdrList(
      JSON.stringify([{ name: 'auth-refactor-2', labels: { af_id: 'pay-bbb' } }])
    );
    const plan = backends.buildResumeAllPlan(sample, { via: 'herdr', herdrLive: live });
    assert.ok(!plan.commands[0].skip);
    assert.equal(plan.commands[0].name, 'auth-refactor');
    assert.equal(backends.herdrAttachLine(plan.commands[0].name), 'Attach: hc attach auth-refactor');
    assert.ok(plan.commands[1].skip);
    assert.equal(plan.commands[1].name, 'auth-refactor-2');
    assert.equal(backends.herdrAttachLine(plan.commands[1].name), 'Attach: hc attach auth-refactor-2');
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

describe('single-session resume helpers', () => {
  it('resolveSingleResumeVia defaults to herdr when hc is present', () => {
    assert.deepEqual(
      backends.resolveSingleResumeVia({}, { env: {}, hasHc: true }),
      { via: 'herdr', note: null }
    );
  });

  it('resolveSingleResumeVia falls back to plain with a note when hc is missing', () => {
    const r = backends.resolveSingleResumeVia({}, { env: {}, hasHc: false });
    assert.equal(r.via, 'plain');
    assert.match(r.note, /hc not found/);
  });

  it('resolveSingleResumeVia honors --here, --via plain, and AGENTFLEET_VIA', () => {
    assert.equal(backends.resolveSingleResumeVia({ here: true }, { hasHc: true }).via, 'plain');
    assert.equal(backends.resolveSingleResumeVia({ via: 'plain' }, { hasHc: true }).via, 'plain');
    assert.equal(backends.resolveSingleResumeVia({ via: 'here' }, { hasHc: true }).via, 'plain');
    assert.equal(backends.resolveSingleResumeVia({ via: 'herdr' }, { hasHc: true }).via, 'herdr');
    assert.equal(
      backends.resolveSingleResumeVia({}, { env: { AGENTFLEET_VIA: 'plain' }, hasHc: true }).via,
      'plain'
    );
    assert.equal(
      backends.resolveSingleResumeVia({}, { env: { AGENTFLEET_VIA: 'tmux' }, hasHc: true }).via,
      'plain'
    );
    assert.equal(
      backends.resolveSingleResumeVia({}, { env: { AGENTFLEET_VIA: 'herdr' }, hasHc: true }).via,
      'herdr'
    );
    const missing = backends.resolveSingleResumeVia({}, { env: { AGENTFLEET_VIA: 'herdr' }, hasHc: false });
    assert.equal(missing.via, 'plain');
    assert.match(missing.note, /hc not found/);
    assert.throws(
      () => backends.resolveSingleResumeVia({ here: true, via: 'herdr' }, { hasHc: true }),
      /cannot combine --here/
    );
  });

  it('parseResumeSelection accepts lists, ranges, all, and rejects bad input', () => {
    assert.deepEqual(backends.parseResumeSelection('', 4), []);
    assert.deepEqual(backends.parseResumeSelection('  ', 4), []);
    assert.deepEqual(backends.parseResumeSelection('1,3', 4), [0, 2]);
    assert.deepEqual(backends.parseResumeSelection('1 3', 4), [0, 2]);
    assert.deepEqual(backends.parseResumeSelection('1-3', 4), [0, 1, 2]);
    assert.deepEqual(backends.parseResumeSelection('3-1', 4), [0, 1, 2]);
    assert.deepEqual(backends.parseResumeSelection('1,2,2,1', 4), [0, 1]);
    assert.deepEqual(backends.parseResumeSelection('all', 3), [0, 1, 2]);
    assert.deepEqual(backends.parseResumeSelection('a', 2), [0, 1]);
    assert.deepEqual(backends.parseResumeSelection('*', 2), [0, 1]);
    assert.throws(() => backends.parseResumeSelection('0', 3), /out of range/);
    assert.throws(() => backends.parseResumeSelection('4', 3), /out of range/);
    assert.throws(() => backends.parseResumeSelection('1-9', 3), /out of range/);
    assert.throws(() => backends.parseResumeSelection('foo', 3), /invalid selection/);
  });

  it('wantITermOpen defaults on iTerm TTY, honors --open / --no-open', () => {
    const iterm = { env: { TERM_PROGRAM: 'iTerm.app' }, isTTY: true, platform: 'darwin' };
    assert.equal(backends.wantITermOpen({}, iterm), true);
    assert.equal(backends.wantITermOpen({ 'no-open': true }, iterm), false);
    assert.equal(backends.wantITermOpen({ open: true }, { env: {}, isTTY: false, platform: 'darwin' }), true);
    assert.equal(backends.wantITermOpen({}, { env: { TERM_PROGRAM: 'iTerm.app' }, isTTY: false, platform: 'darwin' }), false);
    assert.equal(backends.wantITermOpen({}, { env: { TERM_PROGRAM: 'iTerm.app' }, isTTY: true, platform: 'linux' }), false);
    assert.equal(backends.canOpenITerm({ platform: 'linux' }), false);
    assert.equal(backends.canOpenITerm({ platform: 'darwin', hasOsascript: true }), true);
    assert.equal(backends.canOpenITerm({ platform: 'darwin', hasOsascript: false }), false);
  });

  it('buildITermAttachAppleScript uses an absolute hc path and tab name', () => {
    const script = backends.buildITermAttachAppleScript(
      [{ name: 'img2img-upscale-workflow', title: 'img2img-upscale-workflow' }],
      { hcBin: '/Users/andrewrapo/.local/bin/hc' }
    );
    assert.ok(script.includes('tell application "iTerm"'));
    assert.ok(script.includes('create tab with default profile'));
    assert.ok(script.includes('write text'));
    assert.ok(script.includes('/Users/andrewrapo/.local/bin/hc'));
    assert.ok(script.includes('attach'));
    assert.ok(script.includes('img2img-upscale-workflow'));
    assert.ok(!script.includes('cursor-agent'));
  });
});
