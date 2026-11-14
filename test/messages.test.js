'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, spawn } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('task-scoped messaging', () => {
  let home;
  let project;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-msg-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'af-msg-proj-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function afEnv(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      HOME: home,
      // Do not inherit identity from the developer shell.
      AGENTFLEET_SESSION: '',
      AGENTFLEET_ID: '',
      AGENTFLEET_MASTER: '',
      AGENTFLEET_PARENT: '',
      ...extra,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: afEnv(extraEnv),
    });
  }

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/messages')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function seedTeam({ messaging = true, otherTeam = false } = {}) {
    const registry = loadRegistry();
    const master = registry.add({
      title: 'MsgMaster',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0001',
      cwd: project,
      engine: 'cursor',
      status: 'active',
      role: 'master',
      messaging: messaging === null ? null : messaging,
    });
    const w1 = registry.add({
      title: 'MsgMaster-w1',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0002',
      cwd: project,
      engine: 'cursor',
      status: 'active',
      role: 'worker',
      parent: master.id,
      messaging: messaging === null ? null : messaging,
    });
    const w2 = registry.add({
      title: 'MsgMaster-w2',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0003',
      cwd: project,
      engine: 'cursor',
      status: 'active',
      role: 'worker',
      parent: master.id,
      messaging: messaging === null ? null : messaging,
    });
    let outsider = null;
    if (otherTeam) {
      const m2 = registry.add({
        title: 'OtherMaster',
        chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0099',
        cwd: project,
        engine: 'cursor',
        status: 'active',
        role: 'master',
        messaging: true,
      });
      outsider = registry.add({
        title: 'OtherMaster-w1',
        chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0098',
        cwd: project,
        engine: 'cursor',
        status: 'active',
        role: 'worker',
        parent: m2.id,
        messaging: true,
      });
    }
    const lone = registry.add({
      title: 'LoneSession',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0044',
      cwd: project,
      engine: 'cursor',
      status: 'active',
    });
    return { master, w1, w2, outsider, lone };
  }

  it('default-off: msg/inbox refuse until enabled', () => {
    const { master, w1 } = seedTeam({ messaging: null });
    const r = af(['msg', 'master', 'hello'], { AGENTFLEET_SESSION: w1.id });
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /messaging not enabled/);

    const inbox = af(['inbox'], { AGENTFLEET_SESSION: w1.id });
    assert.equal(inbox.status, 1, inbox.stderr);
    assert.match(inbox.stderr, /messaging not enabled/);

    // Human viewing master log is allowed
    const view = af(['inbox', master.title]);
    assert.equal(view.status, 0, view.stderr);
  });

  it('per-session enable/disable and --json/--dry-run', () => {
    const { master } = seedTeam({ messaging: null });
    const dry = af(['msg', 'enable', master.title, '--dry-run', '--json']);
    assert.equal(dry.status, 0, dry.stderr);
    const dryBody = JSON.parse(dry.stdout);
    assert.equal(dryBody.dryRun, true);
    assert.equal(dryBody.messaging, true);
    const reg1 = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'));
    assert.equal(reg1.sessions.find((s) => s.id === master.id).messaging, null);

    const en = af(['msg', 'enable', master.title, '--json']);
    assert.equal(en.status, 0, en.stderr);
    assert.equal(JSON.parse(en.stdout).messaging, true);

    const dis = af(['msg', 'disable', master.title]);
    assert.equal(dis.status, 0, dis.stderr);
    const reg2 = JSON.parse(fs.readFileSync(path.join(home, 'sessions.json'), 'utf8'));
    assert.equal(reg2.sessions.find((s) => s.id === master.id).messaging, false);
  });

  it('project .agentfleet.json opt-in including ancestor; explicit false overrides', () => {
    const nested = path.join(project, 'apps', 'web');
    fs.mkdirSync(nested, { recursive: true });
    fs.writeFileSync(path.join(project, '.agentfleet.json'), JSON.stringify({ messaging: true }));
    const registry = loadRegistry();
    const master = registry.add({
      title: 'ProjMaster',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0101',
      cwd: nested,
      engine: 'cursor',
      role: 'master',
      status: 'active',
      messaging: null,
    });
    const w = registry.add({
      title: 'ProjMaster-w1',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0102',
      cwd: nested,
      engine: 'cursor',
      role: 'worker',
      parent: master.id,
      status: 'active',
      messaging: null,
    });
    const ok = af(['msg', 'master', 'from project'], { AGENTFLEET_SESSION: w.id });
    assert.equal(ok.status, 0, ok.stderr);

    registry.update(w.id, { messaging: false });
    const blocked = af(['msg', 'master', 'nope'], { AGENTFLEET_SESSION: w.id });
    assert.equal(blocked.status, 1, blocked.stderr);
    assert.match(blocked.stderr, /messaging not enabled/);
  });

  it('sibling ok; other team refused; no-team refused', () => {
    const { master, w1, w2, outsider, lone } = seedTeam({ messaging: true, otherTeam: true });
    const ok = af(['msg', w2.title, 'hi sib', '--from', w1.id, '--json']);
    assert.equal(ok.status, 0, ok.stderr);
    const body = JSON.parse(ok.stdout);
    assert.equal(body.ok, true);
    assert.ok(body.message.id.startsWith('m-'));
    assert.equal(body.message.to, w2.id);

    const cross = af(['msg', outsider.title, 'nope', '--from', w1.id]);
    assert.equal(cross.status, 1, cross.stderr);
    assert.match(cross.stderr, /not in the same team/);

    const none = af(['msg', master.title, 'nope', '--from', lone.id]);
    assert.equal(none.status, 1, none.stderr);
    assert.match(none.stderr, /no team/);
  });

  it('master and all-siblings aliases; partial delivery when some disabled', () => {
    const { master, w1, w2 } = seedTeam({ messaging: true });
    const toMaster = af(['msg', 'master', 'need help', '--type', 'question', '--from', w1.id]);
    assert.equal(toMaster.status, 0, toMaster.stderr);

    const inbox = af(['inbox', master.title, '--json']);
    assert.equal(inbox.status, 0, inbox.stderr);
    const msgs = JSON.parse(inbox.stdout).messages;
    assert.ok(msgs.some((m) => m.to === 'master' || m.to === master.id));

    // disable w2; all-siblings from w1 should deliver to none left → refuse, OR if we had w3...
    // With only w2 as sibling, disabling w2 → refuse.
    af(['msg', 'disable', w2.title]);
    const none = af(['msg', 'all-siblings', 'ping', '--from', w1.id]);
    assert.equal(none.status, 1, none.stderr);
    assert.match(none.stderr, /no enabled siblings|messaging not enabled/);

    // re-enable w2; disable a third path: master sends all-siblings with one disabled
    af(['msg', 'enable', w2.title]);
    const w3reg = loadRegistry();
    const w3 = w3reg.add({
      title: 'MsgMaster-w3',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0004',
      cwd: project,
      engine: 'cursor',
      role: 'worker',
      parent: master.id,
      status: 'active',
      messaging: false,
    });
    const partial = af(['msg', 'all-siblings', 'hello workers', '--from', master.id, '--json']);
    assert.equal(partial.status, 0, partial.stderr);
    const pbody = JSON.parse(partial.stdout);
    assert.equal(pbody.message.to, 'all-siblings');
    assert.ok(pbody.skipped.some((s) => s.id === w3.id));

    const w1inbox = af(['inbox', '--json', '--unread'], { AGENTFLEET_SESSION: w1.id });
    assert.equal(w1inbox.status, 0, w1inbox.stderr);
    const w1msgs = JSON.parse(w1inbox.stdout).messages;
    assert.ok(w1msgs.some((m) => m.to === 'all-siblings'));
  });

  it('loop guard and rate limit', () => {
    const { master, w1, w2 } = seedTeam({ messaging: true });
    const env = { AGENTFLEET_MSG_MAX_THREAD: '3', AGENTFLEET_MSG_RATE: '100' };
    let lastId = null;
    for (let i = 0; i < 3; i++) {
      const r = af(
        lastId ? ['msg', '--reply', lastId, `n${i}`] : ['msg', w2.title, `n${i}`],
        { ...env, AGENTFLEET_SESSION: i % 2 === 0 ? w1.id : w2.id }
      );
      assert.equal(r.status, 0, r.stderr + r.stdout);
      lastId = r.stdout.trim();
    }
    const over = af(['msg', w2.title, '--reply', lastId, 'too many'], {
      ...env,
      AGENTFLEET_SESSION: w1.id,
    });
    assert.equal(over.status, 1, over.stderr);
    assert.match(over.stderr, /thread limit reached/);

    // Master has not sent yet — rate-limit that sender independently
    const rateEnv = {
      AGENTFLEET_SESSION: master.id,
      AGENTFLEET_MSG_RATE: '2',
      AGENTFLEET_MSG_MAX_THREAD: '50',
    };
    assert.equal(af(['msg', w1.title, 'r1'], rateEnv).status, 0);
    assert.equal(af(['msg', w1.title, 'r2'], rateEnv).status, 0);
    const rate = af(['msg', w1.title, 'r3'], rateEnv);
    assert.equal(rate.status, 1, rate.stderr);
    assert.match(rate.stderr, /rate limit/);
  });

  it('read receipts / unread; --dry-run writes nothing; --json single value', () => {
    const { master, w1 } = seedTeam({ messaging: true });
    const sent = af(['msg', 'master', 'please look', '--from', w1.id, '--json']);
    assert.equal(sent.status, 0, sent.stderr);
    const msg = JSON.parse(sent.stdout).message;

    const dry = af(['msg', 'master', 'dry', '--from', w1.id, '--dry-run', '--json']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.equal(JSON.parse(dry.stdout).dryRun, true);

    const logPath = path.join(home, 'messages', `${master.id}.jsonl`);
    const before = fs.readFileSync(logPath, 'utf8');
    assert.ok(!before.includes('"text":"dry"'));

    const ls = af(['ls', '--json', '--all']);
    assert.equal(ls.status, 0, ls.stderr);
    const rows = JSON.parse(ls.stdout).sessions;
    const mrow = rows.find((r) => r.id === master.id);
    assert.equal(mrow.messaging, true);
    assert.equal(mrow.messagingSource, 'session');
    assert.ok(mrow.unread >= 1);

    const inbox = af(['inbox', '--unread', '--mark-read', '--json'], {
      AGENTFLEET_SESSION: master.id,
    });
    assert.equal(inbox.status, 0, inbox.stderr);
    const after = JSON.parse(inbox.stdout).messages;
    assert.ok(after.some((m) => m.id === msg.id));
    const again = af(['inbox', '--unread', '--json'], { AGENTFLEET_SESSION: master.id });
    assert.equal(JSON.parse(again.stdout).messages.length, 0);
  });

  it('concurrent appends produce valid JSONL with all lines', () => {
    const { master, w1, w2 } = seedTeam({ messaging: true });
    const n = 8;
    const children = [];
    for (let i = 0; i < n; i++) {
      const from = i % 2 === 0 ? w1.id : w2.id;
      const to = i % 2 === 0 ? w2.title : w1.title;
      children.push(
        new Promise((resolve) => {
          const child = spawn(
            process.execPath,
            [afJs, 'msg', to, `concurrent-${i}`, '--from', from],
            { env: afEnv(), stdio: ['ignore', 'pipe', 'pipe'] }
          );
          let out = '';
          let err = '';
          child.stdout.on('data', (d) => (out += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('close', (code) => resolve({ code, out, err, i }));
        })
      );
    }
    return Promise.all(children).then((results) => {
      for (const r of results) {
        assert.equal(r.code, 0, `i=${r.i} ${r.err}`);
        assert.match(r.out.trim(), /^m-[0-9a-f]{8}$/);
      }
      const raw = fs.readFileSync(path.join(home, 'messages', `${master.id}.jsonl`), 'utf8');
      const lines = raw.split(/\n/).filter((l) => l.trim());
      assert.equal(lines.length, n);
      const ids = new Set();
      for (const line of lines) {
        const obj = JSON.parse(line);
        assert.equal(obj.kind, 'msg');
        ids.add(obj.id);
      }
      assert.equal(ids.size, n);
    });
  });

  it('spawn inherits messaging from master; --no-messaging opts out; prompts only when enabled', () => {
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-msg-stub-'));
    const stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  echo "deadbeef-2222-4222-8222-$(printf '%012x' $RANDOM$RANDOM)"
  exit 0
fi
echo stub-ok
exit 0
`,
      { mode: 0o755 }
    );
    try {
      const registry = loadRegistry();
      const master = registry.add({
        title: 'InheritMaster',
        chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0201',
        cwd: project,
        engine: 'cursor',
        role: 'master',
        status: 'active',
        messaging: true,
      });
      const r = af(
        ['spawn', '--parent', master.title, '--prompt', 'Do work', '--task', 't', '--json'],
        { AGENTFLEET_CURSOR_BIN: stubCursor, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` }
      );
      assert.equal(r.status, 0, r.stderr);
      const body = JSON.parse(r.stdout);
      const worker = registry.find(body.worker.id);
      assert.equal(worker.messaging, true);
      assert.match(worker.prompt || '', /af msg|af inbox|Max 6/);
      assert.match(worker.prompt || '', /post_message|read_inbox|list_team/);

      const masterOff = registry.add({
        title: 'OffMaster',
        chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeee0202',
        cwd: project,
        engine: 'cursor',
        role: 'master',
        status: 'active',
        messaging: true,
      });
      const r2 = af(
        [
          'spawn',
          '--parent',
          masterOff.title,
          '--prompt',
          'Do work',
          '--no-messaging',
          '--json',
        ],
        { AGENTFLEET_CURSOR_BIN: stubCursor, PATH: `${stubDir}${path.delimiter}${process.env.PATH}` }
      );
      assert.equal(r2.status, 0, r2.stderr);
      const body2 = JSON.parse(r2.stdout);
      const worker2 = registry.find(body2.worker.id);
      assert.equal(worker2.messaging, false);
      assert.doesNotMatch(worker2.prompt || '', /af inbox/);
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('sessionIdentityEnv always sets HOME/SESSION/ID and MASTER; omits empty PARENT', () => {
    delete require.cache[require.resolve('../lib/messages')];
    delete require.cache[require.resolve('../lib/util')];
    process.env.AGENTFLEET_HOME = home;
    const messages = require('../lib/messages');
    const master = {
      id: 'master-aaa',
      title: 'M',
      role: 'master',
      cwd: project,
    };
    const mEnv = messages.sessionIdentityEnv(master);
    assert.equal(mEnv.AGENTFLEET_ID, 'master-aaa');
    assert.equal(mEnv.AGENTFLEET_SESSION, 'master-aaa');
    assert.equal(mEnv.AGENTFLEET_MASTER, 'master-aaa');
    assert.equal(mEnv.AGENTFLEET_HOME, home);
    assert.ok(!Object.prototype.hasOwnProperty.call(mEnv, 'AGENTFLEET_PARENT'));

    const worker = {
      id: 'worker-bbb',
      title: 'W',
      role: 'worker',
      parent: 'master-aaa',
      cwd: project,
    };
    const wEnv = messages.sessionIdentityEnv(worker, {
      AGENTFLEET_PARENT: '${env:AGENTFLEET_PARENT}',
      AGENTFLEET_HOME: '',
    });
    assert.equal(wEnv.AGENTFLEET_PARENT, 'master-aaa');
    assert.equal(wEnv.AGENTFLEET_MASTER, 'master-aaa');
    assert.equal(wEnv.AGENTFLEET_HOME, home);
    assert.equal(wEnv.AGENTFLEET_SESSION, 'worker-bbb');
  });

  it('master prompt says workers; worker prompt names MCP tools', () => {
    const messages = require('../lib/messages');
    const master = messages.messagingPromptBlock(true, { role: 'master' });
    assert.match(master, /message your workers/);
    assert.match(master, /Workers inherit messaging/);
    assert.doesNotMatch(master, /message your master or siblings/);
    const worker = messages.messagingPromptBlock(true, { role: 'worker' });
    assert.match(worker, /post_message/);
    assert.match(worker, /read_inbox/);
    assert.match(worker, /list_team/);
  });

  it('recipient not enabled refuses direct send', () => {
    const { w1, w2 } = seedTeam({ messaging: true });
    af(['msg', 'disable', w2.title]);
    const r = af(['msg', w2.title, 'hello', '--from', w1.id]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /messaging not enabled/);
  });
});
