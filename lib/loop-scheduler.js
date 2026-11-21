'use strict';

/**
 * In-process loop scheduler for `aflt dashboard --serve`.
 *
 * Picks up loops marked `active`, runs one runner per loop (lock respected),
 * resumes in-progress loops on start, and survives runner crashes by
 * re-queueing on the next tick.
 */

const loop = require('./loop');

const DEFAULT_POLL_MS = 2000;

/**
 * @param {object} [opts]
 * @param {number} [opts.pollMs]
 * @param {typeof loop.resumeLoop} [opts.resumeLoop]
 * @param {typeof loop.listSchedulerCandidates} [opts.listCandidates]
 * @param {typeof loop.statusReport} [opts.statusReport]
 * @param {Function} [opts.onError]
 * @param {object} [opts.runOpts] extra opts forwarded to resumeLoop
 */
function createLoopScheduler(opts = {}) {
  const pollMs =
    opts.pollMs != null && Number.isFinite(Number(opts.pollMs)) && Number(opts.pollMs) > 0
      ? Math.floor(Number(opts.pollMs))
      : DEFAULT_POLL_MS;
  const resumeFn = typeof opts.resumeLoop === 'function' ? opts.resumeLoop : loop.resumeLoop;
  const listFn =
    typeof opts.listCandidates === 'function' ? opts.listCandidates : loop.listSchedulerCandidates;
  const statusFn = typeof opts.statusReport === 'function' ? opts.statusReport : loop.statusReport;
  const onError = typeof opts.onError === 'function' ? opts.onError : null;
  const runOpts = opts.runOpts && typeof opts.runOpts === 'object' ? opts.runOpts : {};

  /** @type {Map<string, { promise: Promise<any>, startedAt: string }>} */
  const runners = new Map();
  let timer = null;
  let closed = false;
  let ticking = false;

  function logError(err, context) {
    const msg = err && err.message ? err.message : String(err || 'unknown');
    if (onError) {
      try {
        onError(err, context);
      } catch (_) {
        /* ignore */
      }
      return;
    }
    try {
      process.stderr.write(`aflt loop-scheduler: ${context || 'error'}: ${msg}\n`);
    } catch (_) {
      /* ignore */
    }
  }

  function isRunning(name) {
    return runners.has(name);
  }

  function runnerSnapshot() {
    const out = [];
    for (const [name, info] of runners.entries()) {
      out.push({ name, startedAt: info.startedAt });
    }
    return out;
  }

  function startRunner(name) {
    if (closed || runners.has(name)) return false;
    const startedAt = new Date().toISOString();
    const promise = Promise.resolve()
      .then(() =>
        resumeFn(name, {
          ...runOpts,
          resume: true,
        })
      )
      .catch((err) => {
        if (err && err.code === 'LOOP_BUSY') {
          return { ok: false, code: 'LOOP_BUSY', error: err.message };
        }
        logError(err, `runner ${name}`);
        return {
          ok: false,
          error: err && err.message ? err.message : String(err),
        };
      })
      .finally(() => {
        runners.delete(name);
      });
    runners.set(name, { promise, startedAt });
    return true;
  }

  async function tick() {
    if (closed || ticking) return { started: [], skipped: [] };
    ticking = true;
    const started = [];
    const skipped = [];
    try {
      let candidates = [];
      try {
        candidates = listFn() || [];
      } catch (err) {
        logError(err, 'listCandidates');
        return { started, skipped };
      }
      for (const row of candidates) {
        const name = row && row.name ? String(row.name) : null;
        if (!name) continue;
        if (runners.has(name)) {
          skipped.push({ name, reason: 'in-process' });
          continue;
        }
        if (startRunner(name)) started.push(name);
        else skipped.push({ name, reason: 'busy' });
      }
    } finally {
      ticking = false;
    }
    return { started, skipped };
  }

  function start() {
    if (closed) return;
    if (timer) return;
    // Kick immediately so server-start resumes in-progress loops.
    Promise.resolve()
      .then(() => tick())
      .catch((err) => logError(err, 'initial tick'));
    timer = setInterval(() => {
      Promise.resolve()
        .then(() => tick())
        .catch((err) => logError(err, 'tick'));
    }, pollMs);
    if (typeof timer.unref === 'function') timer.unref();
  }

  async function stop() {
    closed = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Do not kill in-flight runners — state stays running/active so the next
    // dashboard start can resume. Await briefly so tests can drain.
    const pending = [...runners.values()].map((r) => r.promise);
    runners.clear();
    await Promise.allSettled(pending);
  }

  function getStatus() {
    const report = statusFn(null);
    return {
      ok: true,
      closed,
      pollMs,
      runners: runnerSnapshot(),
      loops: report && report.loops ? report.loops : [],
    };
  }

  return {
    start,
    stop,
    tick,
    getStatus,
    isRunning,
    runnerSnapshot,
    get closed() {
      return closed;
    },
    get pollMs() {
      return pollMs;
    },
  };
}

module.exports = {
  DEFAULT_POLL_MS,
  createLoopScheduler,
};
