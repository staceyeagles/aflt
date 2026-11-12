'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
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

it('detectWaitingTransition: Herdr "done" is waiting even without a prior working sighting', () => {
  assert.equal(orchestrate.detectWaitingTransition({ agentState: 'done' }).hint, 'waiting');
  assert.equal(orchestrate.detectWaitingTransition({ agentState: 'idle' }).hint, null);
});
