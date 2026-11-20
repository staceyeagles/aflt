'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const orchestrate = require('../lib/orchestrate');

describe('orchestrate pure helpers', () => {
  it('defaultResultPath uses fleet home / results / <id>.md', () => {
    const p = orchestrate.defaultResultPath('auth-w1', { home: '/tmp/fleet' });
    assert.equal(p, path.join('/tmp/fleet', 'results', 'auth-w1.md'));
  });

  it('taskFromPrompt collapses whitespace and truncates', () => {
    assert.equal(orchestrate.taskFromPrompt('  hello   world  '), 'hello world');
    const long = 'x'.repeat(100);
    const t = orchestrate.taskFromPrompt(long, 80);
    assert.ok(t.length <= 80);
    assert.ok(t.endsWith('…'));
  });

  it('nextWorkerTitle uses childCount+1 and ensures uniqueness', () => {
    assert.equal(orchestrate.nextWorkerTitle('auth', 0), 'auth-w1');
    assert.equal(orchestrate.nextWorkerTitle('auth', 2), 'auth-w3');
    assert.equal(
      orchestrate.nextWorkerTitle('auth', 0, ['auth-w1', 'auth-w2']),
      'auth-w3'
    );
  });

  it('wrapWorkerPrompt includes master, task, result sections, and body', () => {
    const wrapped = orchestrate.wrapWorkerPrompt({
      parentTitle: 'Auth',
      parentId: 'auth-aaa',
      task: 'Extract helpers',
      resultPath: '/tmp/fleet/results/w1.md',
      prompt: 'Do the work',
    });
    assert.ok(wrapped.includes('master "Auth"'));
    assert.ok(wrapped.includes('id: auth-aaa'));
    assert.ok(wrapped.includes('Your task: Extract helpers'));
    assert.ok(wrapped.includes('/tmp/fleet/results/w1.md'));
    assert.ok(wrapped.includes('## Summary'));
    assert.ok(wrapped.includes('## Files changed'));
    assert.ok(wrapped.includes('## Open questions'));
    assert.ok(wrapped.includes('Do not commit or push'));
    assert.ok(wrapped.includes('Do the work'));
  });

  it('deriveWorkerStatus follows Herdr runtime when present', () => {
    const session = { workerStatus: 'running' };
    assert.equal(
      orchestrate.deriveWorkerStatus(session, { runtime: 'running' }),
      'running'
    );
    assert.equal(
      orchestrate.deriveWorkerStatus(session, { runtime: 'exited', exitCode: 0 }),
      'done'
    );
    assert.equal(
      orchestrate.deriveWorkerStatus(session, { runtime: 'exited', exitCode: 2 }),
      'failed'
    );
    assert.equal(
      orchestrate.deriveWorkerStatus(session, { runtime: 'exited' }),
      'stopped'
    );
    assert.equal(
      orchestrate.deriveWorkerStatus(session, { runtime: 'missing' }),
      'stopped'
    );
    assert.equal(
      orchestrate.deriveWorkerStatus(session, { runtime: 'unknown' }),
      'running'
    );
    assert.equal(orchestrate.deriveWorkerStatus(session, null), 'running');
    assert.equal(orchestrate.deriveWorkerStatus({ workerStatus: 'done' }, { runtime: '-' }), 'done');
  });

  it('deriveWorkerStatus uses headless liveness (injectable isAlive)', () => {
    const base = {
      workerStatus: 'running',
      runPid: 4242,
      runHost: 'box',
      stopRequested: false,
    };
    assert.equal(
      orchestrate.deriveWorkerStatus(base, null, {
        isAlive: () => true,
        hostname: 'box',
      }),
      'running'
    );
    assert.equal(
      orchestrate.deriveWorkerStatus(base, null, {
        isAlive: () => false,
        hostname: 'box',
      }),
      'failed'
    );
    assert.equal(
      orchestrate.deriveWorkerStatus(
        { ...base, stopRequested: true },
        null,
        { isAlive: () => false, hostname: 'box' }
      ),
      'stopped'
    );
    // Different host: do not declare dead.
    assert.equal(
      orchestrate.deriveWorkerStatus(base, null, {
        isAlive: () => false,
        hostname: 'other',
      }),
      'running'
    );
  });

  it('dead runPid + fresh worker handoff → done (stateSource handoff)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-recon-'));
    try {
      const resultPath = path.join(dir, 'w1.md');
      const started = Date.now() - 60_000;
      fs.writeFileSync(resultPath, '## Summary\nworker wrote this\n');
      // Ensure mtime is after runStartedAt
      const after = new Date();
      fs.utimesSync(resultPath, after, after);
      const session = {
        id: 'w1',
        workerStatus: 'running',
        runPid: 99999,
        runHost: 'box',
        lastExit: null,
        stopRequested: false,
        runStartedAt: new Date(started).toISOString(),
        result: resultPath,
        resultSource: null,
      };
      const recon = orchestrate.reconcileDeadRunPid(session, {
        isAlive: () => false,
        hostname: 'box',
      });
      assert.ok(recon);
      assert.equal(recon.status, 'done');
      assert.equal(recon.stateSource, 'handoff');
      assert.equal(recon.persist, true);
      assert.equal(
        orchestrate.deriveWorkerStatus(session, null, {
          isAlive: () => false,
          hostname: 'box',
        }),
        'done'
      );
      const meta = orchestrate.waitOutcomeMeta(session, {
        derivedStatus: 'done',
        isAlive: () => false,
        hostname: 'box',
      });
      assert.equal(meta.stateSource, 'handoff');

      // Fallback marker must not count as success
      fs.writeFileSync(
        resultPath,
        `${orchestrate.FALLBACK_HANDOFF_MARKER}\n## Summary\nfallback\n`
      );
      fs.utimesSync(resultPath, after, after);
      const bad = orchestrate.reconcileDeadRunPid(
        { ...session, resultSource: null },
        { isAlive: () => false, hostname: 'box' }
      );
      assert.equal(bad.status, 'failed');
      assert.equal(bad.stateSource, 'pid');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('deriveWorkerStatus honors waitingHint for live Herdr', () => {
    assert.equal(
      orchestrate.deriveWorkerStatus(
        { workerStatus: 'running' },
        { runtime: 'running', waitingHint: 'waiting' }
      ),
      'waiting'
    );
  });

  it('agentStateFromHerdr reads OSC 7501 status', () => {
    assert.equal(orchestrate.agentStateFromHerdr(null), null);
    assert.equal(orchestrate.agentStateFromHerdr({ status: null }), null);
    assert.equal(orchestrate.agentStateFromHerdr({ status: { state: 'working' } }), 'working');
    assert.equal(orchestrate.agentStateFromHerdr({ status: { state: 'Idle' } }), 'idle');
    assert.equal(orchestrate.agentStateFromHerdr({ status: 'blocked' }), 'blocked');
  });

  it('detectWaitingTransition: working then idle ≥1 tick → waiting; blocked → waiting', () => {
    let st = orchestrate.detectWaitingTransition({ agentState: null });
    assert.equal(st.hint, null);
    st = orchestrate.detectWaitingTransition({
      agentState: 'working',
      seenWorking: st.seenWorking,
      idleTicks: st.idleTicks,
    });
    assert.equal(st.hint, 'running');
    assert.equal(st.seenWorking, true);
    st = orchestrate.detectWaitingTransition({
      agentState: 'idle',
      seenWorking: st.seenWorking,
      idleTicks: st.idleTicks,
    });
    assert.equal(st.hint, 'waiting');
    assert.equal(
      orchestrate.detectWaitingTransition({ agentState: 'blocked' }).hint,
      'waiting'
    );
    // Idle without ever seeing working stays null.
    assert.equal(
      orchestrate.detectWaitingTransition({ agentState: 'idle', seenWorking: false }).hint,
      null
    );
  });

  it('waitExitCode precedence: timeout > failed/stopped > waiting > 0', () => {
    assert.equal(orchestrate.waitExitCode(['done', 'done']), 0);
    assert.equal(orchestrate.waitExitCode(['done', 'waiting']), 3);
    assert.equal(orchestrate.waitExitCode(['done', 'failed']), 1);
    assert.equal(orchestrate.waitExitCode(['waiting', 'stopped']), 1);
    assert.equal(orchestrate.waitExitCode(['done'], { timedOut: true }), 2);
    assert.equal(orchestrate.waitExitCode(['failed'], { timedOut: true }), 2);
    assert.equal(orchestrate.isWaitTerminalStatus('waiting'), true);
    assert.equal(orchestrate.isWaitTerminalStatus('running'), false);
  });

  it('continueWorkerPrompt reminds about handoff without full preamble', () => {
    const p = orchestrate.continueWorkerPrompt('/tmp/r.md', 'Do more');
    assert.ok(p.includes('/tmp/r.md'));
    assert.ok(p.includes('Do more'));
    assert.ok(!p.includes('## Summary'));
  });

  it('validateRole and validateWorkerStatus', () => {
    assert.equal(orchestrate.validateRole(null), null);
    assert.equal(orchestrate.validateRole('master'), 'master');
    assert.equal(orchestrate.validateRole('docs'), 'docs');
    assert.throws(() => orchestrate.validateRole('boss'), /invalid role/);
    assert.equal(orchestrate.validateWorkerStatus('queued'), 'queued');
    assert.throws(() => orchestrate.validateWorkerStatus('nope'), /invalid workerStatus/);
  });
});

it('worker sessions get --add-dir for their result folder (copilot + cursor)', () => {
  const copilot = require('../lib/copilot');
  const cursor = require('../lib/cursor');
  const w = { chatId: 'abc', cwd: '/tmp/x', result: '/tmp/fleet/results/w1.md' };
  const plain = { chatId: 'abc', cwd: '/tmp/x' };
  const has = (a) => a.includes('--add-dir') && a[a.indexOf('--add-dir') + 1] === '/tmp/fleet/results';
  assert.ok(has(copilot.buildPrintArgs(w, { prompt: 'hi' })));
  assert.ok(has(copilot.buildInteractiveArgs(w, {})));
  assert.ok(has(cursor.buildPrintArgs(w, { prompt: 'hi' })));
  assert.ok(has(cursor.buildResumeArgs(w, {})));
  assert.ok(!copilot.buildPrintArgs(plain, { prompt: 'hi' }).includes('--add-dir'));
  assert.ok(!cursor.buildPrintArgs(plain, { prompt: 'hi' }).includes('--add-dir'));
});

it('copilot pre-approves write(result) and write(plan) without --allow-all-tools', () => {
  const copilot = require('../lib/copilot');
  const w = {
    chatId: 'abc',
    cwd: '/tmp/x',
    result: '/tmp/fleet/results/w1.md',
  };
  const args = copilot.buildPrintArgs(w, { prompt: 'hi', force: false });
  assert.ok(args.includes('--allow-tool=write(/tmp/fleet/results/w1.md)'));
  assert.ok(!args.includes('--allow-all-tools'));
  const m = {
    chatId: 'def',
    cwd: '/tmp/x',
    result: '/tmp/fleet/results/m1.md',
    plan: '/tmp/fleet/plans/m1.md',
  };
  const mArgs = copilot.buildInteractiveArgs(m, {});
  assert.ok(mArgs.includes('--allow-tool=write(/tmp/fleet/results/m1.md)'));
  assert.ok(mArgs.includes('--allow-tool=write(/tmp/fleet/plans/m1.md)'));
  assert.ok(mArgs.includes('--add-dir'));
  const addDirs = mArgs.filter((a, i) => mArgs[i - 1] === '--add-dir');
  assert.ok(addDirs.includes('/tmp/fleet/results'));
  assert.ok(addDirs.includes('/tmp/fleet/plans'));
});

it('buildFallbackHandoff / ensureResultHandoff / handoffDisplay', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const body = orchestrate.buildFallbackHandoff('line1\nline2\n');
  assert.ok(body.includes(orchestrate.FALLBACK_HANDOFF_MARKER));
  assert.ok(body.includes('## Summary'));
  assert.ok(body.includes('line2'));
  assert.ok(body.includes('unknown (af fallback)'));
  const long = Array.from({ length: 250 }, (_, i) => `L${i}`).join('\n');
  const capped = orchestrate.buildFallbackHandoff(long, { maxLines: 200 });
  assert.ok(capped.includes('L249'));
  assert.ok(!capped.includes('L0\n'));

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-handoff-'));
  const dest = path.join(dir, 'r.md');
  assert.equal(
    orchestrate.ensureResultHandoff({ result: dest }, { code: 0, timedOut: false, stdout: 'ok' }),
    'af-fallback'
  );
  assert.ok(fs.existsSync(dest));
  assert.equal(
    orchestrate.ensureResultHandoff({ result: dest }, { code: 0, timedOut: false, stdout: 'x' }),
    'worker'
  );
  assert.equal(orchestrate.handoffDisplay({ resultSource: 'af-fallback' }, dest), 'af');
  assert.equal(orchestrate.handoffDisplay({ resultSource: 'worker' }, dest), 'yes');
  fs.rmSync(dir, { recursive: true, force: true });
});

it('sessionOwnedPaths includes results/plans but never runs/', () => {
  const home = '/tmp/fleet-home';
  const owned = orchestrate.sessionOwnedPaths(
    {
      id: 'w1',
      result: '/tmp/fleet-home/results/w1.md',
      plan: '/tmp/elsewhere/plan.md',
    },
    { home }
  );
  assert.deepEqual(owned.files, ['/tmp/fleet-home/results/w1.md']);
  assert.deepEqual(owned.dirs, []);
  assert.equal(owned.skipped.length, 1);
  assert.ok(owned.skipped[0].reason.includes('plan outside'));
});

it('displayId keeps trailing -hex6 so sibling slugs differ', () => {
  const { displayId } = require('../lib/util');
  assert.equal(displayId('hello-af-1a2b3c', 16), 'hello-af-1a2b3c');
  const a = displayId('hello-af-w1-250815', 16);
  const b = displayId('hello-af-1a2b3c', 16);
  assert.notEqual(a, b);
  assert.ok(a.endsWith('-250815'), a);
  assert.ok(b.includes('1a2b3c'), b);
  const c = displayId('orch-s2-headless-1b643b', 16);
  const d = displayId('orch-s2-interactive-a05f23', 16);
  assert.notEqual(c, d);
  assert.ok(c.endsWith('-1b643b'), c);
  assert.ok(d.endsWith('-a05f23'), d);
});

it('detectWaitingTransition: Herdr "done" is waiting even without a prior working sighting', () => {
  assert.equal(orchestrate.detectWaitingTransition({ agentState: 'done' }).hint, 'waiting');
  assert.equal(orchestrate.detectWaitingTransition({ agentState: 'idle' }).hint, null);
});

describe('detectWaitingTransition send-grace', () => {
  const sendAt = '2026-11-12T12:00:00.000Z';
  const t0 = Date.parse(sendAt);

  it('ignores done/idle within grace until working is seen', () => {
    const base = {
      lastSendAt: sendAt,
      sendGraceMs: 15000,
      seenWorking: false,
      now: t0 + 1000,
    };
    assert.equal(
      orchestrate.detectWaitingTransition({ ...base, agentState: 'done' }).hint,
      null
    );
    assert.equal(
      orchestrate.detectWaitingTransition({ ...base, agentState: 'idle' }).hint,
      null
    );
    const working = orchestrate.detectWaitingTransition({
      ...base,
      agentState: 'working',
    });
    assert.equal(working.hint, 'running');
    assert.equal(working.seenWorking, true);
    assert.equal(
      orchestrate.detectWaitingTransition({
        ...base,
        agentState: 'done',
        seenWorking: true,
        now: t0 + 2000,
      }).hint,
      'waiting'
    );
  });

  it('after grace with no working, done/idle count as waiting', () => {
    const past = {
      lastSendAt: sendAt,
      sendGraceMs: 15000,
      seenWorking: false,
      now: t0 + 16000,
    };
    assert.equal(
      orchestrate.detectWaitingTransition({ ...past, agentState: 'done' }).hint,
      'waiting'
    );
    assert.equal(
      orchestrate.detectWaitingTransition({ ...past, agentState: 'idle' }).hint,
      'waiting'
    );
  });

  it('blocked is always immediate waiting even within grace', () => {
    assert.equal(
      orchestrate.detectWaitingTransition({
        agentState: 'blocked',
        lastSendAt: sendAt,
        sendGraceMs: 15000,
        seenWorking: false,
        now: t0 + 500,
      }).hint,
      'waiting'
    );
  });

  it('resolveSendGraceMs: flag overrides env; default 15s', () => {
    assert.equal(orchestrate.resolveSendGraceMs({}), 15000);
    assert.equal(
      orchestrate.resolveSendGraceMs({ env: { AGENTFLEET_SEND_GRACE: '8' } }),
      8000
    );
    assert.equal(
      orchestrate.resolveSendGraceMs({
        flag: '3',
        env: { AGENTFLEET_SEND_GRACE: '8' },
      }),
      3000
    );
  });

  it('nextMasterTitle and renderTemplate / loadOrchestratorTemplate', () => {
    assert.equal(orchestrate.nextMasterTitle('Auth Refactor'), 'master-auth-refactor');
    assert.equal(
      orchestrate.nextMasterTitle('Auth Refactor', ['master-auth-refactor']),
      'master-auth-refactor-2'
    );
    const rendered = orchestrate.renderTemplate('Hi {{GOAL}} / {{MISSING}}', {
      GOAL: 'ship it',
    });
    assert.equal(rendered, 'Hi ship it / {{MISSING}}');
    const tpl = orchestrate.loadOrchestratorTemplate();
    assert.ok(tpl.includes('{{GOAL}}'));
    assert.ok(tpl.includes('aflt spawn'));
    assert.ok(tpl.includes('{{MESSAGING}}'));
    const full = orchestrate.renderTemplate(tpl, {
      GOAL: 'Do the thing',
      MASTER_ID: 'm1',
      MASTER_TITLE: 'master-do-the-thing',
      CWD: '/tmp/proj',
      DEFAULT_WORKER_ENGINE: 'copilot',
      PLAN: '/tmp/fleet/plans/m1.md',
      MESSAGING: '',
    });
    assert.ok(full.includes('Do the thing'));
    assert.ok(full.includes('m1'));
    assert.ok(full.includes('master-do-the-thing'));
    assert.ok(full.includes('/tmp/proj'));
    assert.ok(full.includes('copilot'));
    assert.ok(full.includes('/tmp/fleet/plans/m1.md'));
    assert.ok(full.includes('AGENTFLEET_PLAN'));
    assert.ok(!full.includes('{{GOAL}}'));
    assert.ok(!full.includes('{{MASTER_ID}}'));
    assert.ok(!full.includes('{{MASTER_TITLE}}'));
    assert.ok(!full.includes('{{CWD}}'));
    assert.ok(!full.includes('{{DEFAULT_WORKER_ENGINE}}'));
    assert.ok(!full.includes('{{PLAN}}'));
    assert.ok(!full.includes('{{MESSAGING}}'));
  });
});
