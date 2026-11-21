'use strict';

/**
 * Milestone E3 helpers for the self-improve loop:
 * record a score baseline, compose the improve gate (suite green + score
 * not lower than baseline + RUBRIC GUARD), and detect plateau / max rounds.
 *
 * Never edits the rubric or scoring implementation. Opt-in; hermetic-friendly
 * (injectable paths / scores / changedFiles).
 */

const fs = require('fs');
const path = require('path');
const { gate } = require('./gate');
const { loadResults, findLatestResults } = require('./score');
const { readHistory } = require('./report');

const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_BASELINE_NAME = 'improve-baseline.json';

function repoRootFromModule() {
  return path.resolve(__dirname, '..', '..');
}

function defaultBaselinePath(repoRoot) {
  return path.join(repoRoot || repoRootFromModule(), 'eval', DEFAULT_BASELINE_NAME);
}

/**
 * @param {object} baseline
 * @param {string} filePath
 */
function writeBaselineFile(filePath, baseline) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = {
    version: 1,
    overall: baseline.overall,
    scoredAt: baseline.scoredAt || new Date().toISOString(),
    resultsPath: baseline.resultsPath || null,
    rubricVersion: baseline.rubricVersion != null ? baseline.rubricVersion : null,
    maxRounds:
      baseline.maxRounds != null && Number.isFinite(Number(baseline.maxRounds))
        ? Math.max(1, Math.floor(Number(baseline.maxRounds)))
        : DEFAULT_MAX_ROUNDS,
    rounds:
      baseline.rounds != null && Number.isFinite(Number(baseline.rounds))
        ? Math.max(0, Math.floor(Number(baseline.rounds)))
        : 0,
  };
  if (typeof baseline.overall !== 'number' || !Number.isFinite(baseline.overall)) {
    const err = new Error('baseline.overall must be a finite number');
    err.code = 'EBADBASELINE';
    throw err;
  }
  fs.writeFileSync(filePath, JSON.stringify(body, null, 2) + '\n', { mode: 0o600 });
  return { ...body, path: filePath };
}

/**
 * Read baseline JSON from disk.
 * @param {string} filePath
 * @returns {object|null}
 */
function readBaseline(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!raw || typeof raw !== 'object' || typeof raw.overall !== 'number') {
    const err = new Error(`invalid baseline file: ${filePath}`);
    err.code = 'EBADBASELINE';
    throw err;
  }
  return raw;
}

/**
 * Record a baseline from a score result object or latest history entry.
 * @param {object} opts
 * @param {string} [opts.baselinePath]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.historyPath]
 * @param {object} [opts.score] score() result
 * @param {number} [opts.overall]
 * @param {number} [opts.maxRounds]
 * @returns {object}
 */
function recordBaseline(opts = {}) {
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const baselinePath = opts.baselinePath
    ? path.resolve(opts.baselinePath)
    : defaultBaselinePath(repoRoot);

  let overall = opts.overall;
  let scoredAt = opts.scoredAt;
  let resultsPath = opts.resultsPath || null;
  let rubricVersion = opts.rubricVersion;

  if (opts.score && typeof opts.score === 'object') {
    overall = opts.score.overall;
    scoredAt = opts.score.scoredAt;
    resultsPath = opts.score.resultsPath != null ? opts.score.resultsPath : resultsPath;
    rubricVersion = opts.score.rubricVersion;
  }

  if (overall == null) {
    const historyPath = opts.historyPath
      ? path.resolve(opts.historyPath)
      : path.join(repoRoot, 'eval', 'history.jsonl');
    const rows = readHistory(historyPath);
    const latest = rows.length ? rows[rows.length - 1] : null;
    if (!latest || typeof latest.overall !== 'number') {
      const err = new Error(
        `no score available to record baseline (history: ${historyPath})`
      );
      err.code = 'ENOBASELINE';
      throw err;
    }
    overall = latest.overall;
    scoredAt = latest.scoredAt;
    resultsPath = latest.resultsPath || null;
    rubricVersion = latest.rubricVersion;
  }

  return writeBaselineFile(baselinePath, {
    overall,
    scoredAt,
    resultsPath,
    rubricVersion,
    maxRounds: opts.maxRounds,
    rounds: opts.rounds != null ? opts.rounds : 0,
  });
}

/**
 * Suite-green check from measure results (same rules as suite_green criterion
 * for a hard pass: ok, fail===0, no hardFails, not skipped).
 * @param {object} [suite]
 */
function suiteIsGreen(suite) {
  const s = suite || {};
  if (s.skipped) {
    return { ok: false, detail: 'suite skipped' };
  }
  const hardFails = Array.isArray(s.hardFails) ? s.hardFails.length : 0;
  const fail = Number(s.fail) || 0;
  if (s.ok && fail === 0 && hardFails === 0) {
    return {
      ok: true,
      detail: `suite ok pass=${s.pass || 0} fail=0`,
    };
  }
  return {
    ok: false,
    detail: `suite not green ok=${Boolean(s.ok)} fail=${fail} hardFails=${hardFails}`,
  };
}

/**
 * Resolve current overall score from opts / history / injected value.
 * @param {object} opts
 * @returns {{ overall: number|null, source: string, scoredAt?: string, resultsPath?: string|null }}
 */
function resolveCurrentScore(opts = {}) {
  if (typeof opts.overall === 'number' && Number.isFinite(opts.overall)) {
    return {
      overall: opts.overall,
      source: 'injected',
      scoredAt: opts.scoredAt,
      resultsPath: opts.resultsPath || null,
    };
  }
  if (opts.score && typeof opts.score.overall === 'number') {
    return {
      overall: opts.score.overall,
      source: 'score',
      scoredAt: opts.score.scoredAt,
      resultsPath: opts.score.resultsPath || null,
    };
  }
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const historyPath = opts.historyPath
    ? path.resolve(opts.historyPath)
    : path.join(repoRoot, 'eval', 'history.jsonl');
  const rows = readHistory(historyPath);
  const latest = rows.length ? rows[rows.length - 1] : null;
  if (latest && typeof latest.overall === 'number') {
    return {
      overall: latest.overall,
      source: 'history',
      scoredAt: latest.scoredAt,
      resultsPath: latest.resultsPath || null,
    };
  }
  return { overall: null, source: 'none' };
}

/**
 * Compose improve-loop gate checks.
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.baselinePath]
 * @param {object} [opts.baseline] inject parsed baseline
 * @param {string} [opts.resultsPath]
 * @param {string} [opts.resultsDir]
 * @param {object} [opts.results] inject measure JSON
 * @param {string} [opts.historyPath]
 * @param {number} [opts.overall]
 * @param {object} [opts.score]
 * @param {string[]} [opts.changedFiles]
 * @param {string} [opts.base]
 * @param {string[]} [opts.protectedPaths]
 * @param {boolean} [opts.skipRubricGuard] test-only
 * @param {boolean} [opts.skipSuite] test-only
 * @param {boolean} [opts.skipScore] test-only
 * @returns {object}
 */
function improveGate(opts = {}) {
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const checks = [];
  const failures = [];

  // --- RUBRIC GUARD ---
  let rubric = { ok: true, violations: [], protectedPaths: [], changedFiles: [] };
  if (!opts.skipRubricGuard) {
    rubric = gate({
      repoRoot,
      base: opts.base,
      changedFiles: opts.changedFiles,
      protectedPaths: opts.protectedPaths,
      spawnSync: opts.spawnSync,
      env: opts.env,
    });
    checks.push({
      id: 'rubric_guard',
      ok: rubric.ok,
      detail: rubric.ok
        ? 'no protected-path changes'
        : `protected paths changed: ${rubric.violations.join(', ')}`,
      violations: rubric.violations,
    });
    if (!rubric.ok) failures.push('rubric_guard');
  } else {
    checks.push({ id: 'rubric_guard', ok: true, detail: 'skipped', skipped: true });
  }

  // --- suite green ---
  let suiteCheck = { ok: true, detail: 'skipped' };
  let results = opts.results || null;
  let resultsPath = opts.resultsPath || null;
  if (!opts.skipSuite) {
    try {
      if (!results) {
        const loaded = loadResults({
          repoRoot,
          resultsPath: opts.resultsPath,
          resultsDir: opts.resultsDir,
          results: opts.results,
        });
        results = loaded.results;
        resultsPath = loaded.resultsPath;
      }
      suiteCheck = suiteIsGreen(results && results.suite);
    } catch (err) {
      suiteCheck = {
        ok: false,
        detail: err && err.message ? err.message : String(err),
      };
    }
    checks.push({ id: 'suite_green', ok: suiteCheck.ok, detail: suiteCheck.detail });
    if (!suiteCheck.ok) failures.push('suite_green');
  } else {
    checks.push({ id: 'suite_green', ok: true, detail: 'skipped', skipped: true });
  }

  // --- score >= baseline ---
  let scoreCheck = { ok: true, detail: 'skipped' };
  let baseline = opts.baseline || null;
  const baselinePath = opts.baselinePath
    ? path.resolve(opts.baselinePath)
    : defaultBaselinePath(repoRoot);
  if (!opts.skipScore) {
    try {
      if (!baseline) baseline = readBaseline(baselinePath);
      if (!baseline) {
        scoreCheck = {
          ok: false,
          detail: `baseline missing: ${baselinePath}`,
        };
      } else {
        const current = resolveCurrentScore({
          repoRoot,
          historyPath: opts.historyPath,
          overall: opts.overall,
          score: opts.score,
          scoredAt: opts.scoredAt,
          resultsPath,
        });
        if (current.overall == null) {
          scoreCheck = {
            ok: false,
            detail: 'no current score (run aflt eval score first)',
          };
        } else if (current.overall < baseline.overall) {
          scoreCheck = {
            ok: false,
            detail: `score ${current.overall} < baseline ${baseline.overall}`,
            overall: current.overall,
            baseline: baseline.overall,
            delta: current.overall - baseline.overall,
          };
        } else {
          scoreCheck = {
            ok: true,
            detail: `score ${current.overall} >= baseline ${baseline.overall}`,
            overall: current.overall,
            baseline: baseline.overall,
            delta: current.overall - baseline.overall,
          };
        }
      }
    } catch (err) {
      scoreCheck = {
        ok: false,
        detail: err && err.message ? err.message : String(err),
      };
    }
    checks.push({
      id: 'score_vs_baseline',
      ok: scoreCheck.ok,
      detail: scoreCheck.detail,
      overall: scoreCheck.overall,
      baseline: scoreCheck.baseline,
      delta: scoreCheck.delta,
    });
    if (!scoreCheck.ok) failures.push('score_vs_baseline');
  } else {
    checks.push({ id: 'score_vs_baseline', ok: true, detail: 'skipped', skipped: true });
  }

  const ok = failures.length === 0;
  return {
    ok,
    improve: true,
    failures,
    checks,
    baseline: baseline
      ? {
          overall: baseline.overall,
          scoredAt: baseline.scoredAt,
          path: baselinePath,
          rounds: baseline.rounds,
          maxRounds: baseline.maxRounds,
        }
      : null,
    resultsPath: resultsPath || null,
    rubric,
  };
}

/**
 * Decide whether the improve loop should stop (plateau or max rounds).
 * Plateau: latest overall is not strictly greater than the previous round
 * (or the baseline when only one post-baseline score exists).
 *
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.historyPath]
 * @param {string} [opts.baselinePath]
 * @param {object} [opts.baseline]
 * @param {object[]} [opts.history] inject history rows
 * @param {number} [opts.maxRounds]
 * @param {number} [opts.rounds] explicit round count (else derived)
 * @returns {{
 *   stop: boolean,
 *   reason: 'plateau'|'max-rounds'|null,
 *   rounds: number,
 *   maxRounds: number,
 *   latest: number|null,
 *   previous: number|null,
 *   baseline: number|null,
 *   detail: string
 * }}
 */
function shouldStopImprove(opts = {}) {
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const baselinePath = opts.baselinePath
    ? path.resolve(opts.baselinePath)
    : defaultBaselinePath(repoRoot);
  let baseline = opts.baseline || null;
  if (!baseline) {
    try {
      baseline = readBaseline(baselinePath);
    } catch (_) {
      baseline = null;
    }
  }

  const maxRounds =
    opts.maxRounds != null && Number.isFinite(Number(opts.maxRounds))
      ? Math.max(1, Math.floor(Number(opts.maxRounds)))
      : baseline && baseline.maxRounds != null
        ? Math.max(1, Math.floor(Number(baseline.maxRounds)))
        : DEFAULT_MAX_ROUNDS;

  const historyPath = opts.historyPath
    ? path.resolve(opts.historyPath)
    : path.join(repoRoot, 'eval', 'history.jsonl');
  const rows = Array.isArray(opts.history) ? opts.history : readHistory(historyPath);

  // Scores at/after baseline timestamp (inclusive) count as improve rounds.
  let postBaseline = rows.filter((r) => typeof r.overall === 'number');
  if (baseline && baseline.scoredAt) {
    const after = postBaseline.filter(
      (r) => !r.scoredAt || String(r.scoredAt) >= String(baseline.scoredAt)
    );
    // Keep at least the scores we have if filtering emptied the list oddly.
    if (after.length) postBaseline = after;
  }

  const rounds =
    opts.rounds != null && Number.isFinite(Number(opts.rounds))
      ? Math.max(0, Math.floor(Number(opts.rounds)))
      : // Number of improve attempts ≈ post-baseline scores after the baseline itself.
        Math.max(0, postBaseline.length > 0 ? postBaseline.length - 1 : 0);

  const latest =
    postBaseline.length > 0
      ? postBaseline[postBaseline.length - 1].overall
      : null;
  const previous =
    postBaseline.length >= 2
      ? postBaseline[postBaseline.length - 2].overall
      : baseline && typeof baseline.overall === 'number'
        ? baseline.overall
        : null;

  if (rounds >= maxRounds) {
    return {
      stop: true,
      reason: 'max-rounds',
      rounds,
      maxRounds,
      latest,
      previous,
      baseline: baseline ? baseline.overall : null,
      detail: `max rounds reached (${rounds}/${maxRounds})`,
    };
  }

  // Plateau only after at least one improve round (a score after baseline).
  if (rounds >= 1 && latest != null && previous != null && latest <= previous) {
    return {
      stop: true,
      reason: 'plateau',
      rounds,
      maxRounds,
      latest,
      previous,
      baseline: baseline ? baseline.overall : null,
      detail: `score plateaued (${latest} <= ${previous})`,
    };
  }

  return {
    stop: false,
    reason: null,
    rounds,
    maxRounds,
    latest,
    previous,
    baseline: baseline ? baseline.overall : null,
    detail:
      latest != null
        ? `continue (round ${rounds}/${maxRounds}, latest=${latest})`
        : `continue (round ${rounds}/${maxRounds})`,
  };
}

/**
 * Increment baseline.rounds after a successful improve gate (optional bookkeeping).
 * @param {string} baselinePath
 * @returns {object|null}
 */
function bumpBaselineRound(baselinePath) {
  const b = readBaseline(baselinePath);
  if (!b) return null;
  b.rounds = (Number(b.rounds) || 0) + 1;
  return writeBaselineFile(baselinePath, b);
}

module.exports = {
  DEFAULT_MAX_ROUNDS,
  DEFAULT_BASELINE_NAME,
  defaultBaselinePath,
  writeBaselineFile,
  readBaseline,
  recordBaseline,
  suiteIsGreen,
  resolveCurrentScore,
  improveGate,
  shouldStopImprove,
  bumpBaselineRound,
  findLatestResults,
  repoRootFromModule,
};
