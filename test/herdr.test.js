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
      agent: 'cursor-agent',
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

  it('ambiguous same af_id → unknown', () => {
    const dup = [
      ...terminals,
      { ...terminals[1], address: 't8', name: 'dup' },
    ];
    const c = herdr.classifySession(liveSession, dup);
    assert.equal(c.runtime, 'unknown');
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

describe('af sync / af ls CLI', () => {
  let tmp;
  let registry;
  let savedPath;
  const afJs = path.join(__dirname, '..', 'bin', 'af.js');

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'af-herdr-'));
    process.env.AGENTFLEET_HOME = tmp;
    savedPath = process.env.PATH;
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/registry')];
    registry = require('../lib/registry');
  });

  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
    delete process.env.AGENTFLEET_HOME;
    if (savedPath == null) delete process.env.PATH;
    else process.env.PATH = savedPath;
  });

  function stubHc(scriptBody) {
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const hc = path.join(bin, 'hc');
    fs.writeFileSync(hc, `#!/usr/bin/env node\n${scriptBody}\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${path.delimiter}${savedPath || ''}`;
    return hc;
  }

  function runAf(args) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: { ...process.env, AGENTFLEET_HOME: tmp },
    });
  }

  it('af sync --dry-run does not write or change lastUsed/status', () => {
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

  it('af sync persists herdr without changing lastUsed/status; failure does not write', () => {
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

  it('af ls --json includes HERDR runtimes', () => {
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
    const r = runAf(['ls', '--json', '--all']);
    assert.equal(r.status, 0, r.stderr);
    const out = JSON.parse(r.stdout);
    const byId = Object.fromEntries(out.sessions.map((s) => [s.id, s]));
    assert.equal(byId[LIVE_ID].herdr.runtime, 'running');
    assert.equal(byId[plainSession.id].herdr.runtime, '-');
    assert.equal(byId[LIVE_ID].status, 'active');
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
