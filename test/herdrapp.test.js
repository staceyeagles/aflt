'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const herdrapp = require('../lib/herdrapp');
const backends = require('../lib/backends');

describe('herdrSpaceId / herdrTabId (session-group)', () => {
  it('formats as sp/tb + 32 lowercase hex', () => {
    const space = herdrapp.herdrSpaceId({ id: 'auth-aaa', title: 'Auth' });
    const tab = herdrapp.herdrTabId({ id: 'auth-aaa', title: 'Auth' });
    assert.match(space, /^sp[0-9a-f]{32}$/);
    assert.match(tab, /^tb[0-9a-f]{32}$/);
  });

  it('solo sessions get a space keyed by their own id', () => {
    const expected =
      'sp' +
      crypto
        .createHash('md5')
        .update('agentfleet:space:session:auth-aaa')
        .digest('hex');
    assert.equal(herdrapp.herdrSpaceId({ id: 'auth-aaa', title: 'Auth' }), expected);
  });

  it('workers join the master space; different workers share space, different tabs', () => {
    const master = { id: 'master-1', title: 'Master Goal', role: 'master' };
    const w1 = { id: 'master-1-w1', title: 'w1', parent: master.id, role: 'worker' };
    const w2 = { id: 'master-1-w2', title: 'w2', parent: master.id, role: 'worker' };
    assert.equal(herdrapp.herdrSpaceId(w1), herdrapp.herdrSpaceId(master));
    assert.equal(herdrapp.herdrSpaceId(w2), herdrapp.herdrSpaceId(master));
    assert.notEqual(herdrapp.herdrTabId(w1), herdrapp.herdrTabId(w2));
    assert.equal(
      herdrapp.resolveSpaceTitle(w1, { sessions: [master, w1, w2] }),
      'Master Goal'
    );
  });

  it('different solo sessions get different spaces even with same cwd', () => {
    const a = { id: 'auth-aaa', title: 'Auth', cwd: '/tmp/same-repo' };
    const b = { id: 'pay-bbb', title: 'Pay', cwd: '/tmp/same-repo' };
    assert.notEqual(herdrapp.herdrSpaceId(a), herdrapp.herdrSpaceId(b));
    assert.equal(herdrapp.legacyHerdrSpaceId(a.cwd), herdrapp.legacyHerdrSpaceId(b.cwd));
  });

  it('legacyHerdrSpaceId is cwd-based and stable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-herdrapp-'));
    const withSlash = tmp.endsWith(path.sep) ? tmp : tmp + path.sep;
    assert.equal(herdrapp.legacyHerdrSpaceId(tmp), herdrapp.legacyHerdrSpaceId(withSlash));
    const expected =
      'sp' +
      crypto
        .createHash('md5')
        .update('agentfleet:space:' + fs.realpathSync(tmp))
        .digest('hex');
    assert.equal(herdrapp.legacyHerdrSpaceId(tmp), expected);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('falls back to title when session has no id', () => {
    const tab = herdrapp.herdrTabId({ title: 'solo-title' });
    const expected =
      'tb' + crypto.createHash('md5').update('agentfleet:tab:solo-title').digest('hex');
    assert.equal(tab, expected);
  });

  it('herdrAppLabels returns session-group space and tab label strings', () => {
    const s = { id: 'auth-aaa', title: 'Auth', cwd: '/tmp/wt-auth' };
    const labels = herdrapp.herdrAppLabels(s);
    assert.equal(labels.length, 2);
    assert.equal(labels[0], `herdr.space=${herdrapp.herdrSpaceId(s)}`);
    assert.equal(labels[1], `herdr.tab=${herdrapp.herdrTabId(s)}`);
  });

  it('herdrAppStatus marks legacy cwd labels as needsAdopt', () => {
    const s = { id: 'auth-aaa', title: 'Auth', cwd: '/tmp/wt-auth' };
    const legacy = herdrapp.legacyHerdrSpaceId(s.cwd);
    const tab = herdrapp.herdrTabId(s);
    const st = herdrapp.herdrAppStatus(s, {
      labels: { 'herdr.space': legacy, 'herdr.tab': tab },
    });
    assert.equal(st.ok, false);
    assert.equal(st.legacy, true);
    assert.equal(st.needsAdopt, true);
    assert.equal(st.space, herdrapp.herdrSpaceId(s));
  });
});

describe('herdrAppEnabled / herdrNamesEnabled', () => {
  it('defaults to enabled', () => {
    assert.equal(herdrapp.herdrAppEnabled({}, {}), true);
    assert.equal(herdrapp.herdrNamesEnabled({}), true);
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

  it('disables renames via AGENTFLEET_HERDR_NAMES env', () => {
    for (const v of ['0', 'false', 'off', 'no']) {
      assert.equal(herdrapp.herdrNamesEnabled({ AGENTFLEET_HERDR_NAMES: v }), false, v);
    }
    assert.equal(herdrapp.herdrNamesEnabled({ AGENTFLEET_HERDR_NAMES: '1' }), true);
  });
});

describe('buildHerdrCommands herdr-app wiring', () => {
  const sessionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-happ-cwd-'));
  const session = {
    id: 'auth-aaa',
    title: 'Auth refactor',
    chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    cwd: sessionCwd,
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
    assert.ok(before.some((a) => a === `herdr.space=${herdrapp.herdrSpaceId(session)}`));
    assert.ok(before.some((a) => a === `herdr.tab=${herdrapp.herdrTabId(session)}`));
    assert.equal(cmds[0].spaceId, herdrapp.herdrSpaceId(session));
    assert.equal(cmds[0].tabId, herdrapp.herdrTabId(session));
    assert.equal(cmds[0].spaceTitle, 'Auth refactor');
  });

  it('omits keep/labels when disabled', () => {
    const cmds = backends.buildHerdrCommands([session], { resumeOpts: { herdrApp: false } });
    assert.ok(!cmds[0].argv.includes('--keep'));
    assert.ok(!cmds[0].argv.some((a) => String(a).startsWith('herdr.')));
  });

  it('worker launch labels use master space id', () => {
    const master = { id: 'master-1', title: 'Master Goal', cwd: sessionCwd };
    const worker = {
      id: 'master-1-w1',
      title: 'Worker One',
      parent: master.id,
      role: 'worker',
      chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: sessionCwd,
    };
    const cmds = backends.buildHerdrCommands([worker], {
      resumeOpts: { herdrApp: true, sessions: [master, worker] },
    });
    assert.equal(cmds[0].spaceId, herdrapp.herdrSpaceId(master));
    assert.equal(cmds[0].spaceTitle, 'Master Goal');
    assert.ok(cmds[0].argv.includes(`herdr.space=${herdrapp.herdrSpaceId(master)}`));
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
    const space = herdrapp.herdrSpaceId(sessions[0]);
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

  it('marks already adopted when labels match new scheme', () => {
    const space = herdrapp.herdrSpaceId(sessions[0]);
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
    assert.equal(plan.items[0].legacy, false);
  });

  it('detects legacy cwd-based labels as needing adopt', () => {
    const legacy = herdrapp.legacyHerdrSpaceId(sessions[0].cwd);
    const tab = herdrapp.herdrTabId(sessions[0]);
    const terminals = [
      {
        address: 't1',
        name: 'auth-refactor',
        state: 'live',
        afId: 'auth-aaa',
        labels: {
          af_id: 'auth-aaa',
          'herdr.space': legacy,
          'herdr.tab': tab,
        },
      },
    ];
    const plan = herdrapp.planAdopt(sessions, terminals);
    assert.equal(plan.items[0].alreadyAdopted, false);
    assert.equal(plan.items[0].legacy, true);
    assert.equal(plan.items[0].needsAdopt, true);
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

describe('nameHerdrAppTab / space / views', () => {
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

  it('space.rename uses do space.rename', () => {
    const calls = [];
    const r = herdrapp.nameHerdrAppSpace('spabc', 'Master', {
      runApp: (argv) => {
        calls.push(argv);
        if (argv[0] === 'status') return { status: 0, stdout: '', stderr: '' };
        return { status: 0, stdout: '', stderr: '' };
      },
      sleep: () => {},
      maxWaitMs: 0,
      intervalMs: 500,
    });
    assert.equal(r.ok, true);
    assert.ok(
      calls.some(
        (a) => a[0] === 'do' && a[1] === 'space.rename' && a.includes('spabc') && a.includes('Master')
      )
    );
  });

  it('nameHerdrAppViews skips when AGENTFLEET_HERDR_NAMES=0', () => {
    const calls = [];
    const named = herdrapp.nameHerdrAppViews(
      { spaceId: 'sp1', spaceTitle: 'S', tabId: 'tb1', tabTitle: 'T' },
      {
        env: { AGENTFLEET_HERDR_NAMES: '0' },
        runApp: (argv) => {
          calls.push(argv);
          return { status: 0, stdout: '', stderr: '' };
        },
      }
    );
    assert.equal(named.tabRename.skipped, true);
    assert.equal(named.spaceRename.skipped, true);
    assert.equal(calls.length, 0);
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
