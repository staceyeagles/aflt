'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const herdrapp = require('../lib/herdrapp');
const backends = require('../lib/backends');

describe('herdrSpaceId / herdrTabId', () => {
  it('formats as sp/tb + 32 lowercase hex', () => {
    const space = herdrapp.herdrSpaceId('/tmp/wt-auth');
    const tab = herdrapp.herdrTabId({ id: 'auth-aaa', title: 'Auth' });
    assert.match(space, /^sp[0-9a-f]{32}$/);
    assert.match(tab, /^tb[0-9a-f]{32}$/);
  });

  it('is stable for the same inputs', () => {
    assert.equal(herdrapp.herdrSpaceId('/tmp/wt-auth'), herdrapp.herdrSpaceId('/tmp/wt-auth'));
    assert.equal(
      herdrapp.herdrTabId({ id: 'auth-aaa' }),
      herdrapp.herdrTabId({ id: 'auth-aaa', title: 'other' })
    );
  });

  it('same cwd => same space; different session => different tab', () => {
    const a = { id: 'auth-aaa', title: 'Auth', cwd: '/tmp/same-repo' };
    const b = { id: 'pay-bbb', title: 'Pay', cwd: '/tmp/same-repo' };
    assert.equal(herdrapp.herdrSpaceId(a.cwd), herdrapp.herdrSpaceId(b.cwd));
    assert.notEqual(herdrapp.herdrTabId(a), herdrapp.herdrTabId(b));
  });

  it('strips trailing slash and uses realpath when path exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-herdrapp-'));
    const withSlash = tmp.endsWith(path.sep) ? tmp : tmp + path.sep;
    assert.equal(herdrapp.herdrSpaceId(tmp), herdrapp.herdrSpaceId(withSlash));
    const expected =
      'sp' +
      crypto
        .createHash('md5')
        .update('agentfleet:space:' + fs.realpathSync(tmp))
        .digest('hex');
    assert.equal(herdrapp.herdrSpaceId(tmp), expected);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('falls back to title when session has no id', () => {
    const tab = herdrapp.herdrTabId({ title: 'solo-title' });
    const expected =
      'tb' + crypto.createHash('md5').update('agentfleet:tab:solo-title').digest('hex');
    assert.equal(tab, expected);
  });

  it('herdrAppLabels returns space and tab label strings', () => {
    const s = { id: 'auth-aaa', title: 'Auth', cwd: '/tmp/wt-auth' };
    const labels = herdrapp.herdrAppLabels(s);
    assert.equal(labels.length, 2);
    assert.equal(labels[0], `herdr.space=${herdrapp.herdrSpaceId(s.cwd)}`);
    assert.equal(labels[1], `herdr.tab=${herdrapp.herdrTabId(s)}`);
  });
});

describe('herdrAppEnabled', () => {
  it('defaults to enabled', () => {
    assert.equal(herdrapp.herdrAppEnabled({}, {}), true);
  });

  it('disables via --no-herdr-app flag', () => {
    assert.equal(herdrapp.herdrAppEnabled({ 'no-herdr-app': true }, {}), false);
  });

  it('disables via AGENTFLEET_HERDR_APP env', () => {
    for (const v of ['0', 'false', 'off', 'no', 'FALSE', 'Off']) {
      assert.equal(herdrapp.herdrAppEnabled({}, { AGENTFLEET_HERDR_APP: v }), false, v);
    }
    assert.equal(herdrapp.herdrAppEnabled({}, { AGENTFLEET_HERDR_APP: '1' }), true);
  });
});

describe('buildHerdrCommands herdr-app wiring', () => {
  const session = {
    id: 'auth-aaa',
    title: 'Auth refactor',
    chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: '/tmp/wt-auth',
    model: null,
    prompt: '',
    status: 'active',
  };

  it('inserts --keep and herdr labels before env when enabled', () => {
    const cmds = backends.buildHerdrCommands([session], { resumeOpts: { herdrApp: true } });
    const argv = cmds[0].argv;
    const envIdx = argv.indexOf('env');
    const before = argv.slice(0, envIdx);
    assert.ok(before.includes('--keep'));
    assert.ok(before.some((a) => String(a).startsWith('herdr.space=')));
    assert.ok(before.some((a) => String(a).startsWith('herdr.tab=')));
    assert.match(cmds[0].tabId, /^tb[0-9a-f]{32}$/);
    assert.match(cmds[0].spaceId, /^sp[0-9a-f]{32}$/);
  });

  it('omits keep/labels when disabled', () => {
    const cmds = backends.buildHerdrCommands([session], { resumeOpts: { herdrApp: false } });
    assert.ok(!cmds[0].argv.includes('--keep'));
    assert.ok(!cmds[0].argv.some((a) => String(a).startsWith('herdr.')));
  });
});

describe('planAdopt', () => {
  const sessions = [
    {
      id: 'auth-aaa',
      title: 'Auth refactor',
      cwd: '/tmp/wt-auth',
      status: 'active',
    },
    {
      id: 'pay-bbb',
      title: 'Payments',
      cwd: '/tmp/wt-pay',
      status: 'active',
    },
  ];

  it('plans label+keep argv for live af terminals; skips finished and unrelated', () => {
    const space = herdrapp.herdrSpaceId('/tmp/wt-auth');
    const tab = herdrapp.herdrTabId(sessions[0]);
    const terminals = [
      {
        address: 't1',
        name: 'auth-refactor',
        state: 'live',
        afId: 'auth-aaa',
        labels: { af_id: 'auth-aaa' },
      },
      {
        address: 't2',
        name: 'other',
        state: 'finished',
        afId: 'auth-aaa',
        labels: { af_id: 'auth-aaa' },
      },
      {
        address: 't3',
        name: 'stranger',
        state: 'live',
        labels: {},
      },
    ];
    const plan = herdrapp.planAdopt(sessions, terminals);
    assert.equal(plan.items.length, 1);
    const item = plan.items[0];
    assert.equal(item.address, 't1');
    assert.equal(item.alreadyAdopted, false);
    assert.deepEqual(item.labelArgv, [
      'label',
      't1',
      `herdr.space=${space}`,
      `herdr.tab=${tab}`,
    ]);
    assert.deepEqual(item.keepArgv, ['keep', 't1']);
  });

  it('marks already adopted when labels match; still returns rename ids', () => {
    const space = herdrapp.herdrSpaceId('/tmp/wt-auth');
    const tab = herdrapp.herdrTabId(sessions[0]);
    const terminals = [
      {
        address: 't1',
        name: 'auth-refactor',
        state: 'live',
        afId: 'auth-aaa',
        labels: {
          af_id: 'auth-aaa',
          'herdr.space': space,
          'herdr.tab': tab,
        },
      },
    ];
    const plan = herdrapp.planAdopt(sessions, terminals);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].alreadyAdopted, true);
    assert.equal(plan.items[0].spaceId, space);
    assert.equal(plan.items[0].tabId, tab);
  });

  it('matches by sanitized name when af_id is missing', () => {
    const terminals = [
      {
        address: 't9',
        name: 'payments',
        state: 'live',
        labels: {},
      },
    ];
    const plan = herdrapp.planAdopt(sessions, terminals);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].id, 'pay-bbb');
    assert.deepEqual(plan.items[0].keepArgv, ['keep', 't9']);
  });

  it('only considers the provided session pool', () => {
    const terminals = [
      {
        address: 't1',
        name: 'auth-refactor',
        state: 'live',
        afId: 'auth-aaa',
        labels: { af_id: 'auth-aaa' },
      },
      {
        address: 't2',
        name: 'payments',
        state: 'live',
        afId: 'pay-bbb',
        labels: { af_id: 'pay-bbb' },
      },
    ];
    const plan = herdrapp.planAdopt([sessions[1]], terminals);
    assert.equal(plan.items.length, 1);
    assert.equal(plan.items[0].id, 'pay-bbb');
  });
});

describe('nameHerdrAppTab', () => {
  it('returns not running without throwing when status fails', () => {
    const calls = [];
    const r = herdrapp.nameHerdrAppTab('tbabc', 'Title', {
      runApp: (argv) => {
        calls.push(argv);
        return { status: 1, stdout: '', stderr: 'not running' };
      },
      sleep: () => {
        throw new Error('should not sleep');
      },
    });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'app not running');
    assert.deepEqual(calls, [['status']]);
  });

  it('retries rename and succeeds without throwing', () => {
    let renames = 0;
    const sleeps = [];
    const r = herdrapp.nameHerdrAppTab('tbdeadbeef', 'Auth', {
      maxWaitMs: 1500,
      intervalMs: 500,
      sleep: (ms) => sleeps.push(ms),
      runApp: (argv) => {
        if (argv[0] === 'status') return { status: 0, stdout: '', stderr: '' };
        renames++;
        if (renames < 3) return { status: 1, stdout: '', stderr: 'not yet' };
        return { status: 0, stdout: '{"ok":true}\n', stderr: '' };
      },
    });
    assert.equal(r.ok, true);
    assert.equal(r.reason, null);
    assert.equal(renames, 3);
    assert.ok(sleeps.length >= 2);
  });

  it('swallows runner exceptions and returns ok:false', () => {
    const r = herdrapp.nameHerdrAppTab('tbx', 'N', {
      runApp: () => {
        throw new Error('boom');
      },
      sleep: () => {},
    });
    assert.equal(r.ok, false);
    assert.match(r.reason, /boom/);
  });
});
