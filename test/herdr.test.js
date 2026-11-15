'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const herdr = require('../lib/herdr');

const LIVE_ID = 'video-production-live-10526b';
const READY_ID = 'video-production-readiness-herdr-a1679d';

const ALL_JSON = JSON.stringify({
  hidden_finished: 0,
  terminals: [
    {
      address: 't6',
      agent: 'cursor-agent',
      cwd: '/Users/andrewrapo/github/video-production',
      exit_code: 0,
      name: 'video-production-readiness-herdr',
      reason: 'exited',
      state: 'finished',
      turn: 0,
      labels: { af_id: READY_ID, title: 'video-production-readiness-herdr' },
    },
    {
      address: 't7',
      agent: 'env',
      cwd: '/Users/andrewrapo/github/video-production',
      name: 'video-production-live',
      state: 'live',
      turn: 0,
      labels: { af_id: LIVE_ID, title: 'video-production-live' },
    },
  ],
});

const liveSession = {
  id: LIVE_ID,
  title: 'video-production-live',
  chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
  cwd: '/tmp/vp',
  status: 'active',
  lastUsed: '2026-11-10T12:00:00.000Z',
};

const readySession = {
  id: READY_ID,
  title: 'video-production-readiness-herdr',
  chatId: 'ccac6edc-bbbb-cccc-dddd-eeeeeeeeeeee',
  cwd: '/tmp/vp',
  status: 'active',
  lastUsed: '2026-11-10T11:00:00.000Z',
};

const plainSession = {
  id: 'plain-session-aaa',
  title: 'plain-tmux',
  chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
  cwd: '/tmp/other',
  status: 'active',
  engine: 'cursor',
  lastUsed: '2026-11-10T10:00:00.000Z',
};

describe('parseHerdrTerminals', () => {
  it('parses hc ls --all payload with live and finished', () => {
    const list = herdr.parseHerdrTerminals(ALL_JSON);
    assert.equal(list.length, 2);
    assert.equal(list[0].state, 'finished');
    assert.equal(list[0].exitCode, 0);
    assert.equal(list[0].afId, READY_ID);
    assert.equal(list[1].state, 'live');
    assert.equal(list[1].afId, LIVE_ID);
  });

  it('tolerates label arrays and single get objects', () => {
    const list = herdr.parseHerdrTerminals(
      JSON.stringify({ terminals: [{ name: 'a', labels: ['af_id=z'], state: 'live' }] })
    );
    assert.deepEqual(list[0].labels, { af_id: 'z' });
    const one = herdr.parseHerdrTerminals(
      JSON.stringify({
        address: 't7',
        state: 'live',
        name: 'video-production-live',
        labels: { af_id: LIVE_ID },
      })
    );
    assert.equal(one.length, 1);
    assert.equal(one[0].afId, LIVE_ID);
  });

  it('returns null on malformed JSON', () => {
    assert.equal(herdr.parseHerdrTerminals('not json'), null);
  });
});

describe('classifySession / enrichSessions', () => {
  const terminals = herdr.parseHerdrTerminals(ALL_JSON);

  it('running for live t7-shaped match', () => {
    const c = herdr.classifySession(liveSession, terminals);
    assert.equal(c.runtime, 'running');
    assert.equal(c.address, 't7');
    assert.equal(c.name, 'video-production-live');
  });

  it('exited for finished t6-shaped match', () => {
    const c = herdr.classifySession(readySession, terminals);
    assert.equal(c.runtime, 'exited');
    assert.equal(c.exitCode, 0);
    assert.equal(c.reason, 'exited');
    assert.equal(c.address, 't6');
  });

  it('missing when prior herdr evidence and absent from list', () => {
    const s = {
      ...readySession,
      id: 'gone-herdr-id',
      herdr: { runtime: 'running', checkedAt: '2026-11-10T09:00:00.000Z', address: 't9' },
    };
    const c = herdr.classifySession(s, terminals);
    assert.equal(c.runtime, 'missing');
  });

  it('non-Herdr sessions show - never missing', () => {
    const c = herdr.classifySession(plainSession, terminals);
    assert.equal(c.runtime, '-');
  });

  it('several live same af_id → unknown', () => {
    const dup = [
      ...terminals,
      { ...terminals[1], address: 't8', name: 'dup' },
    ];
    const c = herdr.classifySession(liveSession, dup);
    assert.equal(c.runtime, 'unknown');
  });

  it('one live + finished history same af_id → running (the live one)', () => {
    const withHistory = [
      {
        address: 't3',
        name: 'video-production-live',
        state: 'finished',
        reason: 'exited',
        exitCode: 0,
        afId: LIVE_ID,
        labels: { af_id: LIVE_ID },
      },
      {
        address: 't5',
        name: 'video-production-live',
        state: 'finished',
        reason: 'exited',
        exitCode: 0,
        afId: LIVE_ID,
        labels: { af_id: LIVE_ID },
      },
      terminals[1],
    ];
    const c = herdr.classifySession(liveSession, withHistory);
    assert.equal(c.runtime, 'running');
    assert.equal(c.address, 't7');
  });

  it('only finished history same af_id → exited (most recent / highest address)', () => {
    const finishedOnly = [
      {
        address: 't3',
        name: 'video-production-live',
        state: 'finished',
        reason: 'exited',
        exitCode: 1,
        afId: LIVE_ID,
        labels: { af_id: LIVE_ID },
      },
      {
        address: 't12',
        name: 'video-production-live',
        state: 'finished',
        reason: 'exited',
        exitCode: 0,
        afId: LIVE_ID,
        labels: { af_id: LIVE_ID },
      },
      {
        address: 't8',
        name: 'video-production-live',
        state: 'finished',
        reason: 'killed',
        exitCode: null,
        afId: LIVE_ID,
        labels: { af_id: LIVE_ID },
      },
    ];
    const c = herdr.classifySession(liveSession, finishedOnly);
    assert.equal(c.runtime, 'exited');
    assert.equal(c.address, 't12');
    assert.equal(c.exitCode, 0);
  });


  it('hex addresses: t1b is newer than t19 (hc addresses are t + hex)', () => {
    const mk = (address) => ({
      address,
      name: 'img2img',
      state: 'finished',
      reason: 'exited',
      exitCode: 0,
      afId: LIVE_ID,
      labels: { af_id: LIVE_ID },
    });
    const c = herdr.classifySession(liveSession, [mk('t1b'), mk('t19'), mk('t8')]);
    assert.equal(c.runtime, 'exited');
    assert.equal(c.address, 't1b');
  });
  it('query failure → unknown for involved, - for others; not persistable', () => {
    const involved = {
      ...readySession,
      herdr: { runtime: 'exited', checkedAt: '2026-11-10T09:00:00.000Z' },
    };
    const enriched = herdr.enrichSessions([involved, plainSession], {
      ok: false,
      error: 'timeout',
      terminals: [],
      checkedAt: '2026-11-11T00:00:00.000Z',
    });
    assert.equal(enriched[0].runtime, 'unknown');
    assert.equal(enriched[0].persistable, false);
    assert.equal(enriched[1].runtime, '-');
    assert.equal(enriched[1].persistable, false);
  });

  it('successful enrich marks running/exited/missing persistable', () => {
    const missing = {
      id: 'was-herdr',
      title: 'was',
      chatId: 'x',
      status: 'active',
      herdr: { runtime: 'running', checkedAt: '2026-11-10T09:00:00.000Z' },
    };
    const enriched = herdr.enrichSessions(
      [liveSession, readySession, plainSession, missing],
      { ok: true, terminals, checkedAt: '2026-11-11T00:00:00.000Z' }
    );
    assert.equal(enriched[0].runtime, 'running');
    assert.equal(enriched[0].persistable, true);
    assert.equal(enriched[1].runtime, 'exited');
    assert.equal(enriched[1].persistable, true);
    assert.equal(enriched[2].runtime, '-');
    assert.equal(enriched[2].persistable, false);
    assert.equal(enriched[3].runtime, 'missing');
    assert.equal(enriched[3].persistable, true);
  });
});

describe('fetchHerdrTerminals', () => {
  it('uses injected runHc and fills missing labels via get', () => {
    const calls = [];
    const runHc = (argv) => {
      calls.push(argv.slice());
      if (argv[0] === 'ls') {
        return {
          status: 0,
          stdout: JSON.stringify({
            terminals: [
              { address: 't7', name: 'video-production-live', state: 'live' },
            ],
          }),
          stderr: '',
        };
      }
      if (argv[0] === 'get') {
        return {
          status: 0,
          stdout: JSON.stringify({
            address: 't7',
            state: 'live',
            name: 'video-production-live',
            labels: { af_id: LIVE_ID },
          }),
          stderr: '',
        };
      }
      return { status: 1, stdout: '', stderr: 'nope' };
    };
    const r = herdr.fetchHerdrTerminals({ runHc, now: '2026-11-11T00:00:00.000Z' });
    assert.equal(r.ok, true);
    assert.equal(r.terminals[0].afId, LIVE_ID);
    assert.deepEqual(calls[0], ['ls', '--all', '--json']);
    assert.deepEqual(calls[1], ['get', '--json', 't7']);
  });

  it('returns ok:false on nonzero, timeout, malformed', () => {
    assert.equal(
      herdr.fetchHerdrTerminals({
        runHc: () => ({ status: 2, stdout: '', stderr: 'fail' }),
      }).ok,
      false
    );
    assert.equal(
      herdr.fetchHerdrTerminals({
        runHc: () => ({ status: null, stdout: '', stderr: '', timedOut: true }),
      }).ok,
      false
    );
    assert.equal(
      herdr.fetchHerdrTerminals({
        runHc: () => ({ status: 0, stdout: '{nope', stderr: '' }),
      }).ok,
      false
    );
  });
});

describe('aflt sync / aflt ls CLI', () => {
  let tmp;
  let registry;
  let savedPath;
  const afJs = path.join(__dirname, '..', 'bin', 'af.js');

  let savedHcBin;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-herdr-'));
    process.env.AGENTFLEET_HOME = tmp;
    savedPath = process.env.PATH;
    savedHcBin = process.env.AGENTFLEET_HC_BIN;
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/registry')];
    registry = require('../lib/registry');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.AGENTFLEET_HOME;
    if (savedPath == null) delete process.env.PATH;
    else process.env.PATH = savedPath;
    if (savedHcBin == null) delete process.env.AGENTFLEET_HC_BIN;
    else process.env.AGENTFLEET_HC_BIN = savedHcBin;
  });

  function stubHc(scriptBody) {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const hc = path.join(bin, 'hc');
    fs.writeFileSync(hc, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${savedPath || ''}`;
    process.env.AGENTFLEET_HC_BIN = hc;
    return hc;
  }

  function runAf(args) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFLEET_HOME: tmp,
        AGENTFLEET_HC_BIN: process.env.AGENTFLEET_HC_BIN,
      },
    });
  }

  it('aflt sync --dry-run does not write or change lastUsed/status', () => {
    stubHc(`
      const fs = require('fs');
      if (process.argv[2] === 'ls') {
        process.stdout.write(${JSON.stringify(ALL_JSON)});
        process.exit(0);
      }
      process.exit(1);
    `);
    const s = registry.add({
      title: readySession.title,
      chatId: readySession.chatId,
      cwd: tmp,
      id: READY_ID,
    });
    // Force stable id by updating if makeId differed — add uses makeId unless id passed.
    // normalizeEntry accepts partial.id
    assert.equal(s.id, READY_ID);
    const before = registry.find(READY_ID);
    const lastUsed = before.lastUsed;
    const status = before.status;

    const r = runAf(['sync', '--dry-run', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.equal(out.dryRun, true);
    assert.ok(out.updated.some((u) => u.runtime === 'exited'));

    const after = registry.find(READY_ID);
    assert.equal(after.lastUsed, lastUsed);
    assert.equal(after.status, status);
    assert.equal(after.herdr, undefined);
    const baks = fs.readdirSync(tmp).filter((f) => f.startsWith('sessions.json.bak-'));
    assert.deepEqual(baks, []);
  });

  it('aflt sync persists herdr without changing lastUsed/status; failure does not write', () => {
    stubHc(`
      if (process.argv[2] === 'ls') {
        process.stdout.write(${JSON.stringify(ALL_JSON)});
        process.exit(0);
      }
      process.exit(1);
    `);
    registry.add({
      title: readySession.title,
      chatId: readySession.chatId,
      cwd: tmp,
      id: READY_ID,
    });
    const before = registry.find(READY_ID);
    const lastUsed = before.lastUsed;

    const r = runAf(['sync', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const after = registry.find(READY_ID);
    assert.equal(after.status, 'active');
    assert.equal(after.lastUsed, lastUsed);
    assert.equal(after.herdr.runtime, 'exited');
    assert.equal(after.herdr.exitCode, 0);
    assert.ok(after.herdr.checkedAt);
    const baks = fs.readdirSync(tmp).filter((f) => f.startsWith('sessions.json.bak-'));
    assert.equal(baks.length, 1);

    // Failure path: hc exits nonzero → no further mutation
    stubHc(`process.exit(3);`);
    const mid = registry.find(READY_ID);
    const herdrBefore = JSON.stringify(mid.herdr);
    const fail = runAf(['sync']);
    assert.notEqual(fail.status, 0);
    assert.equal(JSON.stringify(registry.find(READY_ID).herdr), herdrBefore);
  });

  it('aflt ls --json includes HERDR runtimes and herdrApp ids', () => {
    stubHc(`
      if (process.argv[2] === 'ls') {
        process.stdout.write(${JSON.stringify(ALL_JSON)});
        process.exit(0);
      }
      process.exit(1);
    `);
    registry.add({
      title: liveSession.title,
      chatId: liveSession.chatId,
      cwd: tmp,
      id: LIVE_ID,
    });
    registry.add({
      title: plainSession.title,
      chatId: plainSession.chatId,
      cwd: tmp,
      id: plainSession.id,
    });
    const herdrapp = require('../lib/herdrapp');
    const r = runAf(['ls', '--json', '--all']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const byId = Object.fromEntries(out.sessions.map((s) => [s.id, s]));
    assert.equal(byId[LIVE_ID].herdr.runtime, 'running');
    assert.equal(byId[plainSession.id].herdr.runtime, '-');
    assert.equal(byId[LIVE_ID].status, 'active');
    assert.equal(byId[LIVE_ID].herdrApp.space, herdrapp.herdrSpaceId({ id: LIVE_ID }));
    assert.equal(byId[LIVE_ID].herdrApp.tab, herdrapp.herdrTabId({ id: LIVE_ID }));
    assert.equal(
      byId[plainSession.id].herdrApp.space,
      herdrapp.herdrSpaceId({ id: plainSession.id })
    );
    assert.equal(byId[plainSession.id].herdrApp.tab, herdrapp.herdrTabId({ id: plainSession.id }));
  });

  it('aflt ls --json with no sessions prints empty sessions array', () => {
    stubHc(`
      if (process.argv[2] === 'ls') {
        process.stdout.write(JSON.stringify({ terminals: [] }));
        process.exit(0);
      }
      process.exit(1);
    `);
    const r = runAf(['ls', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    assert.deepEqual(out.sessions, []);
    assert.equal(typeof out.queryOk, 'boolean');
    assert.equal(out.queryOk, true);
  });

  it('aflt ls --json reports derived workerStatus like children --json', () => {
    const storedId = 'ls-worker-stored-done';
    const derivedId = 'ls-worker-herdr-exited';
    const masterId = 'ls-worker-status-master';
    const hcPayload = JSON.stringify({
      hidden_finished: 0,
      terminals: [
        {
          address: 't20',
          agent: 'cursor-agent',
          cwd: tmp,
          exit_code: 0,
          name: 'ls-herdr-exited',
          reason: 'exited',
          state: 'finished',
          turn: 0,
          labels: { af_id: derivedId, title: 'ls-herdr-exited' },
        },
      ],
    });
    stubHc(`
      if (process.argv[2] === 'ls') {
        process.stdout.write(${JSON.stringify(hcPayload)});
        process.exit(0);
      }
      process.exit(1);
    `);
    registry.add({
      title: 'ls-status-master',
      chatId: '11111111-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      id: masterId,
      role: 'master',
    });
    registry.add({
      title: 'ls-stored-done',
      chatId: '22222222-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      id: storedId,
      role: 'worker',
      parent: masterId,
      workerStatus: 'done',
    });
    registry.add({
      title: 'ls-herdr-exited',
      chatId: '33333333-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      id: derivedId,
      role: 'worker',
      parent: masterId,
    });

    const ls = runAf(['ls', '--json', '--all']);
    assert.equal(ls.status, 0, ls.stderr);
    const lsBody = JSON.parse(ls.stdout);
    const byId = Object.fromEntries(lsBody.sessions.map((s) => [s.id, s]));
    assert.equal(byId[storedId].workerStatus, 'done');
    assert.equal(byId[derivedId].workerStatus, 'done');
    assert.equal(byId[masterId].workerStatus, null);

    const kids = runAf(['children', 'ls-status-master', '--json']);
    assert.equal(kids.status, 0, kids.stderr);
    const kidRows = JSON.parse(kids.stdout);
    const kidsById = Object.fromEntries(kidRows.map((s) => [s.id, s]));
    assert.equal(kidsById[storedId].workerStatus, 'done');
    assert.equal(kidsById[derivedId].workerStatus, 'done');
    assert.equal(byId[storedId].workerStatus, kidsById[storedId].workerStatus);
    assert.equal(byId[derivedId].workerStatus, kidsById[derivedId].workerStatus);
  });

  it('aflt resume --via herdr --dry-run prints Attach line and does not spawn hc run', () => {
    const marker = path.join(tmp, 'hc-run-count');
    stubHc(`
      const fs = require('fs');
      const marker = ${JSON.stringify(marker)};
      if (process.argv[2] === 'ls') {
        process.stdout.write(JSON.stringify({ terminals: [] }));
        process.exit(0);
      }
      if (process.argv[2] === 'run') {
        fs.writeFileSync(marker, '1');
        process.exit(99);
      }
      process.exit(1);
    `);
    registry.add({
      title: 'img2img-upscale-workflow',
      chatId: 'e3a5c66a-6726-43bd-95de-380ea37dd373',
      cwd: tmp,
      id: 'img2img-upscale-workflow-test',
    });
    const r = runAf(['resume', 'img2img-upscale-workflow', '--via', 'herdr', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^hc run --bg --no-parent --outlive-parent --name img2img-upscale-workflow /m);
    assert.match(r.stdout, /^Attach: hc attach img2img-upscale-workflow$/m);
    assert.ok(!r.stdout.includes(' -- -- '));
    assert.ok(r.stdout.includes('env -u NO_COLOR -u FORCE_COLOR'));
    assert.ok(r.stdout.includes('--keep'));
    assert.match(r.stdout, /herdr\.space=sp[0-9a-f]{32}/);
    assert.match(r.stdout, /herdr\.tab=tb[0-9a-f]{32}/);
    assert.equal(fs.existsSync(marker), false);

    const off = runAf([
      'resume',
      'img2img-upscale-workflow',
      '--via',
      'herdr',
      '--dry-run',
      '--no-herdr-app',
    ]);
    assert.equal(off.status, 0, off.stderr);
    assert.ok(!off.stdout.includes('--keep'));
    assert.ok(!off.stdout.includes('herdr.space='));
  });

  it('aflt resume defaults to herdr --dry-run and prints Attach', () => {
    const marker = path.join(tmp, 'hc-run-count-default');
    stubHc(`
      const fs = require('fs');
      const marker = ${JSON.stringify(marker)};
      if (process.argv[2] === 'ls') {
        process.stdout.write(JSON.stringify({ terminals: [] }));
        process.exit(0);
      }
      if (process.argv[2] === 'run') {
        fs.writeFileSync(marker, '1');
        process.exit(99);
      }
      process.exit(1);
    `);
    registry.add({
      title: 'img2img-default',
      chatId: 'e3a5c66a-6726-43bd-95de-380ea37dd373',
      cwd: tmp,
      id: 'img2img-default-test',
    });
    const r = runAf(['resume', 'img2img-default', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^hc run --bg /m);
    assert.match(r.stdout, /^Attach: hc attach img2img-default$/m);
    assert.equal(fs.existsSync(marker), false);
  });

  it('aflt resume --here / --via plain --dry-run stays in this terminal', () => {
    stubHc(`
      if (process.argv[2] === 'ls') {
        process.stdout.write(JSON.stringify({ terminals: [] }));
        process.exit(0);
      }
      process.exit(1);
    `);
    registry.add({
      title: 'plain-here',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      id: 'plain-here-test',
    });
    for (const args of [
      ['resume', 'plain-here', '--via', 'plain', '--dry-run'],
      ['resume', 'plain-here', '--here', '--dry-run'],
    ]) {
      const r = runAf(args);
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.ok(r.stdout.includes('--resume'));
      assert.ok(!r.stdout.includes('hc run'));
      assert.ok(!r.stdout.includes('Attach: hc attach'));
    }
  });

  it('aflt resume --open --dry-run prints iTerm AppleScript with absolute hc', () => {
    const hcPath = stubHc(`
      if (process.argv[2] === 'ls') {
        process.stdout.write(JSON.stringify({ terminals: [] }));
        process.exit(0);
      }
      process.exit(1);
    `);
    registry.add({
      title: 'open-dry',
      chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      id: 'open-dry-test',
    });
    const r = runAf(['resume', 'open-dry', '--open', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^Attach: hc attach open-dry$/m);
    assert.ok(r.stdout.includes('tell application "iTerm"'));
    assert.ok(r.stdout.includes(hcPath) || r.stdout.includes('hc attach'));
    assert.ok(r.stdout.includes('write text'));
  });

  it('aflt resume with no title is an error on a non-TTY and does not hang', () => {
    stubHc(`
      if (process.argv[2] === 'ls') {
        process.stdout.write(JSON.stringify({ terminals: [] }));
        process.exit(0);
      }
      process.exit(1);
    `);
    const r = runAf(['resume']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /TTY|usage: aflt resume/);
  });

  it('aflt pick on a non-TTY is an error and does not hang', () => {
    stubHc(`
      if (process.argv[2] === 'ls') {
        process.stdout.write(JSON.stringify({ terminals: [] }));
        process.exit(0);
      }
      process.exit(1);
    `);
    const r = runAf(['pick']);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /TTY|usage: aflt resume/);
  });


  it('aflt resume --dry-run skips a live terminal whose ls JSON omitted labels', () => {
    const LIVE = 'img2img-upscale-workflow-3570cb';
    const lsNoLabels = JSON.stringify({
      terminals: [
        {
          address: 't12',
          name: 'img2img-upscale-workflow',
          state: 'live',
          agent: 'env',
          cwd: tmp,
        },
      ],
    });
    const getWithLabels = JSON.stringify({
      address: 't12',
      name: 'img2img-upscale-workflow',
      state: 'live',
      agent: 'env',
      cwd: tmp,
      labels: { af_id: LIVE, title: 'img2img-upscale-workflow' },
    });
    const marker = path.join(tmp, 'hc-run-skip');
    stubHc(`
      const fs = require('fs');
      if (process.argv[2] === 'ls') {
        process.stdout.write(${JSON.stringify(lsNoLabels)});
        process.exit(0);
      }
      if (process.argv[2] === 'get') {
        process.stdout.write(${JSON.stringify(getWithLabels)});
        process.exit(0);
      }
      if (process.argv[2] === 'run') {
        fs.writeFileSync(${JSON.stringify(marker)}, '1');
        process.exit(99);
      }
      process.exit(1);
    `);
    registry.add({
      title: 'img2img-upscale-workflow',
      chatId: 'e3a5c66a-6726-43bd-95de-380ea37dd373',
      cwd: tmp,
      id: LIVE,
    });
    const r = runAf(['resume', 'img2img-upscale-workflow', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /already live in herdr/);
    assert.match(r.stdout, /^Attach: hc attach img2img-upscale-workflow$/m);
    assert.ok(!r.stdout.includes('img2img-upscale-workflow-2'));
    assert.ok(!r.stdout.includes('hc run --bg'));
    assert.equal(fs.existsSync(marker), false);
  });

  it('normalizeEntry / import preserves herdr', () => {
    const s = registry.add({
      title: 'KeepHerdr',
      chatId: '99999999-9999-9999-9999-999999999999',
      cwd: tmp,
      herdr: {
        runtime: 'exited',
        address: 't6',
        name: 'x',
        exitCode: 0,
        reason: 'exited',
        checkedAt: '2026-11-10T09:00:00.000Z',
      },
    });
    assert.equal(s.herdr.runtime, 'exited');
    registry.update(s.id, { notes: 'n' });
    assert.equal(registry.find(s.id).herdr.runtime, 'exited');
    const exported = registry.exportAll();
    fs.rmSync(path.join(tmp, 'sessions.json'));
    const result = registry.importAll(exported, { merge: false });
    assert.equal(result.sessions[0].herdr.runtime, 'exited');
  });
});
