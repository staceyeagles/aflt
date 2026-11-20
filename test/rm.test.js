'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('af rm cleanup', () => {
  let home;
  let stubDir;
  let stubHc;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rm-stub-'));
    stubHc = path.join(stubDir, 'hc');
    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env bash
set -euo pipefail
case "\${1:-}" in
  ls) echo '{"terminals":[],"hidden_finished":0,"machines":[]}'; exit 0 ;;
  *) exit 0 ;;
esac
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-rm-home-'));
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  function afEnv(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_HC_BIN: stubHc,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extraEnv = {}, opts = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: afEnv(extraEnv),
      timeout: 15000,
      input: opts.input,
    });
  }

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    delete require.cache[require.resolve('../lib/project')];
    delete require.cache[require.resolve('../lib/resolve-session')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function seedWorker(title = 'RmW1') {
    const registry = loadRegistry();
    const parent = registry.add({
      title: 'RmMaster',
      chatId: 'aaaaaaaa-1111-4111-8111-111111111111',
      cwd: home,
      role: 'master',
      status: 'active',
    });
    const w = registry.add({
      title,
      chatId: 'bbbbbbbb-2222-4222-8222-222222222222',
      cwd: home,
      parent: parent.id,
      role: 'worker',
      task: 't',
      workerStatus: 'done',
    });
    fs.mkdirSync(path.dirname(w.result), { recursive: true, mode: 0o700 });
    fs.writeFileSync(w.result, '## Summary\nok\n', 'utf8');
    const runDir = path.join(home, 'runs', w.id);
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(runDir, 'log.txt'), 'log\n', 'utf8');
    return { registry: loadRegistry(), parent, worker: loadRegistry().find(w.id) };
  }

  it('removes result file but keeps runs/<id>/ logs', () => {
    const { worker } = seedWorker();
    assert.ok(fs.existsSync(worker.result));
    assert.ok(fs.existsSync(path.join(home, 'runs', worker.id)));
    const r = af(['rm', worker.title]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!loadRegistry().find(worker.id));
    assert.ok(!fs.existsSync(worker.result));
    assert.ok(fs.existsSync(path.join(home, 'runs', worker.id, 'log.txt')));
  });

  it('--keep-files leaves files, removes registry row', () => {
    const { worker } = seedWorker('KeepW');
    const r = af(['rm', 'KeepW', '--keep-files']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!loadRegistry().find('KeepW'));
    assert.ok(fs.existsSync(worker.result));
    assert.ok(fs.existsSync(path.join(home, 'runs', worker.id)));
  });

  it('--dry-run lists actions and changes nothing', () => {
    const { worker } = seedWorker('DryW');
    const r = af(['rm', 'DryW', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/\[dry-run\]/.test(r.stdout), r.stdout);
    assert.ok(loadRegistry().find('DryW'));
    assert.ok(fs.existsSync(worker.result));
  });

  it('--children removes workers; --with-master removes master too', () => {
    const { parent, worker } = seedWorker('ChildW');
    const registry = loadRegistry();
    const planPath = parent.plan || path.join(home, 'plans', `${parent.id}.md`);
    registry.update(parent.id, { plan: planPath });
    fs.mkdirSync(path.dirname(planPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(planPath, '# plan\n', 'utf8');

    const kidsOnly = af(['rm', '--children', parent.title, '--dry-run']);
    assert.equal(kidsOnly.status, 0, kidsOnly.stderr);
    assert.ok(kidsOnly.stdout.includes('ChildW'));
    assert.ok(!kidsOnly.stdout.includes(`would remove session ${parent.title}`));

    const r = af(['rm', '--children', parent.title, '--with-master']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!loadRegistry().find(worker.id));
    assert.ok(!loadRegistry().find(parent.id));
    assert.ok(!fs.existsSync(worker.result));
    assert.ok(!fs.existsSync(planPath));
  });

  it('refuses running headless worker unless --force', () => {
    const { worker } = seedWorker('RunW');
    loadRegistry().update(worker.id, {
      workerStatus: 'running',
      runPid: process.pid,
      runPgid: process.pid,
      runHost: os.hostname(),
    });
    const denied = af(['rm', 'RunW']);
    assert.equal(denied.status, 1);
    assert.ok(/running/i.test(denied.stderr), denied.stderr);
    assert.ok(/aflt stop/i.test(denied.stderr), denied.stderr);
    assert.ok(loadRegistry().find('RunW'));

    const forced = af(['rm', 'RunW', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.ok(!loadRegistry().find('RunW'));
  });

  it('skips result paths outside $AGENTFLEET_HOME/results', () => {
    const { worker } = seedWorker('OutW');
    const outside = path.join(os.tmpdir(), `af-rm-outside-${process.pid}.md`);
    fs.writeFileSync(outside, 'keep me\n', 'utf8');
    loadRegistry().update(worker.id, { result: outside });
    const r = af(['rm', 'OutW']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(/skip/i.test(r.stderr), r.stderr);
    assert.ok(fs.existsSync(outside));
    fs.unlinkSync(outside);
  });

  it('nonexistent id: nonzero exit, clear message, registry unchanged', () => {
    const { worker } = seedWorker('MissW');
    const before = loadRegistry().list({ includeDone: true }).length;
    const r = af(['rm', 'definitely-not-a-session-zzzz']);
    assert.equal(r.status, 1);
    assert.ok(/no session matches/i.test(r.stderr), r.stderr);
    assert.equal(loadRegistry().list({ includeDone: true }).length, before);
    assert.ok(loadRegistry().find(worker.id));
  });

  it('space-joined multi-id string does not hex-suffix match (registry unchanged)', () => {
    const registry = loadRegistry();
    const docs = registry.add({
      title: 'docs-af-docs-live',
      chatId: 'cccccccc-3333-4333-8333-333333333333',
      cwd: home,
      id: 'docs-af-docs-live-94d940',
    });
    const joined =
      'orch-test-master-52e80e s3-master-940fc7 other-id-abcdef docs-af-docs-live-94d940';
    const before = loadRegistry().list({ includeDone: true }).map((s) => s.id).sort();
    const r = af(['rm', joined]);
    assert.equal(r.status, 1);
    assert.ok(/no session matches/i.test(r.stderr), r.stderr);
    assert.ok(loadRegistry().findExact(docs.id));
    const after = loadRegistry().list({ includeDone: true }).map((s) => s.id).sort();
    assert.deepEqual(after, before);
  });

  it('exact id and exact title still remove', () => {
    const { worker } = seedWorker('ExactTitleW');
    const byTitle = af(['rm', 'ExactTitleW']);
    assert.equal(byTitle.status, 0, byTitle.stderr);
    assert.ok(!loadRegistry().findExact('ExactTitleW'));

    const w2 = loadRegistry().add({
      title: 'ExactIdW',
      chatId: 'bbbbbbbb-2222-4222-8222-222222222299',
      cwd: home,
      id: 'exact-id-w-112233',
    });
    const byId = af(['rm', w2.id]);
    assert.equal(byId.status, 0, byId.stderr);
    assert.ok(!loadRegistry().findExact(w2.id));
  });

  it('multiple separate args remove all; --keep-files does not swallow ids', () => {
    const registry = loadRegistry();
    const a = registry.add({
      title: 'MultiA',
      chatId: 'dddddddd-4444-4444-8444-444444444444',
      cwd: home,
      id: 'multi-a-111111',
    });
    const b = registry.add({
      title: 'MultiB',
      chatId: 'eeeeeeee-5555-4555-8555-555555555555',
      cwd: home,
      id: 'multi-b-222222',
    });
    const c = registry.add({
      title: 'MultiC',
      chatId: 'ffffffff-6666-4666-8666-666666666666',
      cwd: home,
      id: 'multi-c-333333',
    });
    const r = af(['rm', '--keep-files', a.id, b.title, c.id]);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!loadRegistry().findExact(a.id));
    assert.ok(!loadRegistry().findExact(b.id));
    assert.ok(!loadRegistry().findExact(c.id));
  });

  it('one bad id among several removes nothing', () => {
    const registry = loadRegistry();
    const a = registry.add({
      title: 'KeepA',
      chatId: 'aaaa1111-7777-4777-8777-777777777777',
      cwd: home,
      id: 'keep-a-aaaaaa',
    });
    const b = registry.add({
      title: 'KeepB',
      chatId: 'bbbb2222-8888-4888-8888-888888888888',
      cwd: home,
      id: 'keep-b-bbbbbb',
    });
    const r = af(['rm', a.id, 'no-such-session-zzzzzz', b.id]);
    assert.equal(r.status, 1);
    assert.ok(/no session matches/i.test(r.stderr), r.stderr);
    assert.ok(loadRegistry().findExact(a.id));
    assert.ok(loadRegistry().findExact(b.id));
  });

  it('prefix/hex-only query to rm is refused with a hint', () => {
    const registry = loadRegistry();
    const s = registry.add({
      title: 'HintTarget',
      chatId: 'hint0000-9999-4999-8999-999999999999',
      cwd: home,
      id: 'hint-target-abcdef',
    });
    const hexOnly = af(['rm', 'abcdef']);
    assert.equal(hexOnly.status, 1);
    assert.ok(/no session matches/i.test(hexOnly.stderr), hexOnly.stderr);
    assert.ok(/did you mean/i.test(hexOnly.stderr), hexOnly.stderr);
    assert.ok(/HintTarget/.test(hexOnly.stderr), hexOnly.stderr);
    assert.ok(/exact id or title/i.test(hexOnly.stderr), hexOnly.stderr);
    assert.ok(loadRegistry().findExact(s.id));

    const prefix = af(['rm', s.id.slice(0, 8)]);
    assert.equal(prefix.status, 1);
    assert.ok(/did you mean/i.test(prefix.stderr), prefix.stderr);
    assert.ok(loadRegistry().findExact(s.id));
  });

  it('fuzzy lookup still works for non-destructive note; whitespace find refuses hex', () => {
    const registry = loadRegistry();
    const s = registry.add({
      title: 'NoteFuzzy',
      chatId: 'note0000-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cwd: home,
      id: 'note-fuzzy-c0ffee',
    });
    const noted = af(['note', 'c0ffee', 'hello from prefix/hex']);
    assert.equal(noted.status, 0, noted.stderr);
    assert.equal(loadRegistry().findExact(s.id).notes, 'hello from prefix/hex');

    const byPrefix = af(['note', s.id.slice(0, 10), 'via prefix']);
    assert.equal(byPrefix.status, 0, byPrefix.stderr);
    assert.equal(loadRegistry().findExact(s.id).notes, 'via prefix');

    // Direct findInSessions: space-joined query must not hex-match.
    const joined = `orch-x-111111 other-y-222222 note-fuzzy-c0ffee`;
    assert.equal(loadRegistry().find(joined), null);
    assert.equal(loadRegistry().findExact(joined), null);
    assert.equal(loadRegistry().findExact(s.id).id, s.id);
    assert.equal(loadRegistry().findExact('NoteFuzzy').id, s.id);
  });

  function startFakeRun() {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1e6)'], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    return child;
  }

  function stopFakeRun(child) {
    if (!child || child.pid == null) return;
    try {
      process.kill(child.pid, 'SIGKILL');
    } catch (_) {
      /* ignore */
    }
  }

  it('TTY ambiguous pick #2 stops the chosen session', () => {
    const registry = loadRegistry();
    const childA = startFakeRun();
    const childB = startFakeRun();
    try {
      const a = registry.add({
        title: 'AlphaPickAmb',
        chatId: 'pick0001-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        cwd: home,
        id: 'alpha-pick-amb-111111',
        workerStatus: 'running',
        runPid: childA.pid,
        runPgid: childA.pid,
        runHost: os.hostname(),
        lastUsed: '2026-01-02T00:00:00.000Z',
      });
      const b = registry.add({
        title: 'BetaPickAmb',
        chatId: 'pick0002-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        cwd: home,
        id: 'beta-pick-amb-222222',
        workerStatus: 'running',
        runPid: childB.pid,
        runPgid: childB.pid,
        runHost: os.hostname(),
        lastUsed: '2026-01-01T00:00:00.000Z',
      });
      const r = af(['stop', 'PickAmb'], { AFLT_TEST_TTY: '1', NODE_ENV: 'test' }, { input: '2\n' });
      assert.equal(r.status, 0, r.stderr + r.stdout);
      assert.ok(/Stop which\?/i.test(r.stdout), r.stdout);
      assert.equal(loadRegistry().findExact(a.id).workerStatus, 'running');
      assert.equal(loadRegistry().findExact(b.id).workerStatus, 'stopped');
      assert.equal(loadRegistry().findExact(a.id).runPid, childA.pid);
      assert.equal(loadRegistry().findExact(b.id).runPid, null);
    } finally {
      stopFakeRun(childA);
      stopFakeRun(childB);
    }
  });

  it('TTY Enter cancels stop; registry unchanged', () => {
    const registry = loadRegistry();
    const childA = startFakeRun();
    const childB = startFakeRun();
    try {
      const a = registry.add({
        title: 'CancelAlphaAmb',
        chatId: 'canc0001-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
        cwd: home,
        id: 'cancel-alpha-amb-aaaaaa',
        workerStatus: 'running',
        runPid: childA.pid,
        runPgid: childA.pid,
        runHost: os.hostname(),
      });
      const b = registry.add({
        title: 'CancelBetaAmb',
        chatId: 'canc0002-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
        cwd: home,
        id: 'cancel-beta-amb-bbbbbb',
        workerStatus: 'running',
        runPid: childB.pid,
        runPgid: childB.pid,
        runHost: os.hostname(),
      });
      const before = [a, b].map((s) => {
        const row = loadRegistry().findExact(s.id);
        return { workerStatus: row.workerStatus, runPid: row.runPid };
      });
      const r = af(['stop', 'Cancel'], { AFLT_TEST_TTY: '1', NODE_ENV: 'test' }, { input: '\n' });
      assert.equal(r.status, 1);
      assert.ok(/cancelled/i.test(r.stderr + r.stdout), r.stderr + r.stdout);
      assert.deepEqual(
        [a, b].map((s) => {
          const row = loadRegistry().findExact(s.id);
          return { workerStatus: row.workerStatus, runPid: row.runPid };
        }),
        before
      );
    } finally {
      stopFakeRun(childA);
      stopFakeRun(childB);
    }
  });

  it('TTY single fuzzy candidate y confirms stop; n cancels', () => {
    const registry = loadRegistry();
    const childYes = startFakeRun();
    const childNo = startFakeRun();
    try {
      const s = registry.add({
        title: 'SingleFuzzyStop',
        chatId: 'sing0000-cccc-4ccc-8ccc-cccccccccccc',
        cwd: home,
        id: 'single-fuzzy-stop-abcdef',
        workerStatus: 'running',
        runPid: childYes.pid,
        runPgid: childYes.pid,
        runHost: os.hostname(),
      });
      const yes = af(['stop', 'abcdef'], { AFLT_TEST_TTY: '1', NODE_ENV: 'test' }, { input: 'y\n' });
      assert.equal(yes.status, 0, yes.stderr + yes.stdout);
      assert.ok(/Stop SingleFuzzyStop/i.test(yes.stdout), yes.stdout);
      assert.equal(loadRegistry().findExact(s.id).workerStatus, 'stopped');

      const s2 = loadRegistry().add({
        title: 'SingleFuzzyNo',
        chatId: 'sing0001-dddd-4ddd-8ddd-dddddddddddd',
        cwd: home,
        id: 'single-fuzzy-no-fedcba',
        workerStatus: 'running',
        runPid: childNo.pid,
        runPgid: childNo.pid,
        runHost: os.hostname(),
      });
      const no = af(['stop', 'fedcba'], { AFLT_TEST_TTY: '1', NODE_ENV: 'test' }, { input: 'n\n' });
      assert.equal(no.status, 1);
      assert.ok(/cancelled/i.test(no.stderr + no.stdout), no.stderr + no.stdout);
      assert.equal(loadRegistry().findExact(s2.id).workerStatus, 'running');
      assert.equal(loadRegistry().findExact(s2.id).runPid, childNo.pid);
    } finally {
      stopFakeRun(childYes);
      stopFakeRun(childNo);
    }
  });

  it('non-TTY fuzzy stop stays exact-only with hint; no prompt', () => {
    const registry = loadRegistry();
    const child = startFakeRun();
    try {
      const s = registry.add({
        title: 'HintStopTarget',
        chatId: 'hintstop-eeee-4eee-8eee-eeeeeeeeeeee',
        cwd: home,
        id: 'hint-stop-target-a1b2c3',
        workerStatus: 'running',
        runPid: child.pid,
        runPgid: child.pid,
        runHost: os.hostname(),
      });
      const r = af(['stop', 'a1b2c3']);
      assert.equal(r.status, 1);
      assert.ok(/did you mean/i.test(r.stderr), r.stderr);
      assert.ok(/HintStopTarget/.test(r.stderr), r.stderr);
      assert.ok(!/Stop which\?/i.test(r.stdout + r.stderr));
      assert.ok(!/\[y\/N\]/i.test(r.stdout + r.stderr));
      assert.equal(loadRegistry().findExact(s.id).workerStatus, 'running');
    } finally {
      stopFakeRun(child);
    }
  });

  it('--json fuzzy stop does not prompt', () => {
    const registry = loadRegistry();
    const child = startFakeRun();
    try {
      const s = registry.add({
        title: 'JsonStopTarget',
        chatId: 'jsonstop-ffff-4fff-8fff-ffffffffffff',
        cwd: home,
        id: 'json-stop-target-d4e5f6',
        workerStatus: 'running',
        runPid: child.pid,
        runPgid: child.pid,
        runHost: os.hostname(),
      });
      const r = af(['stop', 'd4e5f6', '--json'], { AFLT_TEST_TTY: '1', NODE_ENV: 'test' }, { input: 'y\n' });
      assert.equal(r.status, 1);
      assert.ok(/did you mean|no session matches/i.test(r.stdout + r.stderr), r.stdout + r.stderr);
      assert.ok(!/\[y\/N\]/i.test(r.stdout + r.stderr));
      assert.equal(loadRegistry().findExact(s.id).workerStatus, 'running');
    } finally {
      stopFakeRun(child);
    }
  });

  it('AFLT_TEST_TTY is ignored outside the test harness (no NODE_ENV=test)', () => {
    const registry = loadRegistry();
    const s = registry.add({
      title: 'HookIgnoredTarget',
      chatId: 'hookign0-aaaa-4aaa-8aaa-aaaaaaaaaaa9',
      cwd: home,
      id: 'hook-ignored-target-9a8b7c',
    });
    const r = af(['rm', '9a8b7c'], { AFLT_TEST_TTY: '1', NODE_ENV: 'production' }, { input: 'y\n' });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout + r.stderr, /no session matches "9a8b7c" \(did you mean/);
    assert.ok(!/\[y\/N\]/i.test(r.stdout + r.stderr), r.stdout + r.stderr);
    assert.ok(loadRegistry().findExact(s.id), 'session must not be removed');
  });

  it('TTY rm ambiguous pick #2 removes the chosen session', () => {
    const registry = loadRegistry();
    const a = registry.add({
      title: 'RmAlphaAmb',
      chatId: 'rmamb001-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      cwd: home,
      id: 'rm-alpha-amb-111111',
      lastUsed: '2026-01-02T00:00:00.000Z',
    });
    const b = registry.add({
      title: 'RmBetaAmb',
      chatId: 'rmamb002-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      cwd: home,
      id: 'rm-beta-amb-222222',
      lastUsed: '2026-01-01T00:00:00.000Z',
    });
    const r = af(['rm', 'RmAmb'], { AFLT_TEST_TTY: '1', NODE_ENV: 'test' }, { input: '2\n' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(/Remove which\?/i.test(r.stdout), r.stdout);
    assert.ok(loadRegistry().findExact(a.id));
    assert.ok(!loadRegistry().findExact(b.id));
  });

  it('rm with exact + fuzzy cancel removes nothing', () => {
    const registry = loadRegistry();
    const keep = registry.add({
      title: 'KeepExactRm',
      chatId: 'keeprm00-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      cwd: home,
      id: 'keep-exact-rm-111111',
    });
    const a = registry.add({
      title: 'MultiCancelAlpha',
      chatId: 'mcanc001-bbbb-4bbb-8bbb-bbbbbbbbbbb1',
      cwd: home,
      id: 'multi-cancel-alpha-aaaaaa',
    });
    const b = registry.add({
      title: 'MultiCancelBeta',
      chatId: 'mcanc002-cccc-4ccc-8ccc-ccccccccccc2',
      cwd: home,
      id: 'multi-cancel-beta-bbbbbb',
    });
    const r = af(
      ['rm', keep.id, 'MultiCancel'],
      { AFLT_TEST_TTY: '1', NODE_ENV: 'test' },
      { input: '\n' }
    );
    assert.equal(r.status, 1);
    assert.ok(/cancelled/i.test(r.stderr + r.stdout), r.stderr + r.stdout);
    assert.ok(loadRegistry().findExact(keep.id));
    assert.ok(loadRegistry().findExact(a.id));
    assert.ok(loadRegistry().findExact(b.id));
  });

  it('non-TTY ambiguous rm lists all candidates in hint', () => {
    const registry = loadRegistry();
    registry.add({
      title: 'HintListAlpha',
      chatId: 'hintl001-aaaa-4aaa-8aaa-aaaaaaaaaaa1',
      cwd: home,
      id: 'hint-list-alpha-111111',
    });
    registry.add({
      title: 'HintListBeta',
      chatId: 'hintl002-bbbb-4bbb-8bbb-bbbbbbbbbbb2',
      cwd: home,
      id: 'hint-list-beta-222222',
    });
    const r = af(['rm', 'HintList']);
    assert.equal(r.status, 1);
    assert.ok(/did you mean/i.test(r.stderr), r.stderr);
    assert.ok(/HintListAlpha/.test(r.stderr), r.stderr);
    assert.ok(/HintListBeta/.test(r.stderr), r.stderr);
    assert.ok(!/Remove which\?/i.test(r.stdout + r.stderr));
  });
});
