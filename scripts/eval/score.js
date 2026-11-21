'use strict';

/**
 * `aflt eval score` — deterministic scoring from measure JSON + repo files.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync: defaultSpawnSync } = require('child_process');
const {
  RUBRIC_VERSION,
  CRITERIA,
  COVERAGE_LINES_THRESHOLD,
} = require('./rubric');
const { listTopLevelCommands } = require('./commands');

function repoRootFromModule() {
  return path.resolve(__dirname, '..', '..');
}

/**
 * Probe a few deliberate bad CLI invocations for error_quality.
 * Hermetic: throwaway HOME / AGENTFLEET_HOME; never touches live engines.
 * @param {object} [opts]
 * @returns {{ message: string, command: string, expectCommand: boolean }[]}
 */
function collectErrorSamples(opts = {}) {
  if (Array.isArray(opts.errorSamples)) return opts.errorSamples;
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const afJs = opts.afJsPath || path.join(repoRoot, 'bin', 'af.js');
  const spawn = opts.spawnSync || defaultSpawnSync;
  const sandbox =
    opts.sandboxHome || fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-eval-err-'));
  const afHome = path.join(sandbox, '.agentfleet');
  fs.mkdirSync(afHome, { recursive: true });
  const env = {
    ...(opts.env || process.env),
    HOME: sandbox,
    AGENTFLEET_HOME: afHome,
  };
  const probes = [
    { argv: ['eval', 'nope'], command: 'eval', expectCommand: true },
    { argv: ['loop', 'validate'], command: 'loop', expectCommand: true },
    { argv: ['rm'], command: 'rm', expectCommand: true },
  ];
  const samples = [];
  for (const p of probes) {
    const r = spawn(process.execPath, [afJs, ...p.argv], {
      encoding: 'utf8',
      env,
      cwd: repoRoot,
      timeout: opts.timeoutMs || 15_000,
    });
    const message = String(r.stderr || '') + String(r.stdout || '');
    samples.push({
      message,
      command: p.command,
      expectCommand: p.expectCommand,
      exitCode: r.status,
    });
  }
  return samples;
}

/**
 * Newest *.json under resultsDir by filename (ISO-ish timestamps sort
 * lexicographically); fall back to mtime when names tie.
 * @param {string} resultsDir
 * @returns {string|null}
 */
function findLatestResults(resultsDir) {
  if (!resultsDir || !fs.existsSync(resultsDir)) return null;
  const entries = fs
    .readdirSync(resultsDir)
    .filter((n) => n.endsWith('.json'))
    .map((name) => {
      const full = path.join(resultsDir, name);
      let mtime = 0;
      try {
        mtime = fs.statSync(full).mtimeMs;
      } catch (_) {
        /* ignore */
      }
      return { name, full, mtime };
    });
  if (!entries.length) return null;
  entries.sort((a, b) => {
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return a.mtime - b.mtime;
  });
  return entries[entries.length - 1].full;
}

/**
 * Load measure results JSON from a path or latest under resultsDir.
 * @param {object} opts
 * @param {string} [opts.resultsPath]
 * @param {string} [opts.resultsDir]
 * @param {string} [opts.repoRoot]
 * @param {object} [opts.results] inject parsed object (skip disk)
 */
function loadResults(opts = {}) {
  if (opts.results && typeof opts.results === 'object') {
    return { results: opts.results, resultsPath: opts.resultsPath || null };
  }
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const resultsDir = opts.resultsDir
    ? path.resolve(opts.resultsDir)
    : path.join(repoRoot, 'eval', 'results');
  let resultsPath = opts.resultsPath ? path.resolve(opts.resultsPath) : null;
  if (!resultsPath) {
    resultsPath = findLatestResults(resultsDir);
  }
  if (!resultsPath || !fs.existsSync(resultsPath)) {
    const err = new Error(
      `no measure results found` +
        (resultsPath ? `: ${resultsPath}` : ` under ${resultsDir}`)
    );
    err.code = 'ENORESULTS';
    throw err;
  }
  const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
  return { results, resultsPath };
}

function scoreSuiteGreen(suite) {
  const s = suite || {};
  if (s.skipped) {
    return {
      score: 0,
      detail: 'suite skipped (incomplete measure)',
    };
  }
  const hardFails = Array.isArray(s.hardFails) ? s.hardFails.length : 0;
  const fail = Number(s.fail) || 0;
  if (s.ok && fail === 0 && hardFails === 0) {
    const flakes = Array.isArray(s.flakes) ? s.flakes.length : 0;
    return {
      score: 100,
      detail:
        `suite ok pass=${s.pass || 0} fail=0` +
        (flakes ? ` flakes=${flakes}` : ''),
    };
  }
  return {
    score: 0,
    detail: `suite not green ok=${Boolean(s.ok)} fail=${fail} hardFails=${hardFails}`,
  };
}

function scoreCoverage(coverage) {
  const c = coverage || {};
  if (!c.available) {
    return {
      score: 50,
      detail: `coverage unavailable${c.reason ? ` (${c.reason})` : ''}; availability credit`,
    };
  }
  const linesPercent =
    c.totals && c.totals.lines && typeof c.totals.lines.percent === 'number'
      ? c.totals.lines.percent
      : 0;
  const score = Math.min(
    100,
    Math.round((linesPercent / COVERAGE_LINES_THRESHOLD) * 100)
  );
  return {
    score,
    detail: `lines ${linesPercent}% vs threshold ${COVERAGE_LINES_THRESHOLD}%`,
  };
}

function scoreCliSmoke(cliSmoke) {
  const smoke = cliSmoke || {};
  if (smoke.ok && (smoke.failures || 0) === 0) {
    return {
      score: 100,
      detail: `cliSmoke ok commands=${smoke.commandCount || (smoke.commands || []).length}`,
    };
  }
  const cmds = Array.isArray(smoke.commands) ? smoke.commands : [];
  const runnable = cmds.filter((c) => c && c.mode !== 'skip');
  if (!runnable.length) {
    return { score: 0, detail: 'cliSmoke failed with no runnable commands' };
  }
  const passed = runnable.filter(
    (c) => c.ok === true || (c.exitCode === 0 && c.ok !== false)
  ).length;
  const score = Math.round((passed / runnable.length) * 100);
  return {
    score,
    detail: `cliSmoke pass-rate ${passed}/${runnable.length} (failures=${smoke.failures || 0})`,
  };
}

/**
 * Extract USAGE block text from bin/af.js source (template literal after USAGE =).
 * @param {string} afSource
 */
function extractUsageText(afSource) {
  const src = String(afSource || '');
  const marker = 'const USAGE = `';
  const start = src.indexOf(marker);
  if (start < 0) return src;
  const from = start + marker.length;
  const end = src.indexOf('`;', from);
  if (end < 0) return src.slice(from);
  return src.slice(from, end);
}

function scoreDocsCommands(opts = {}) {
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const readmePath = opts.readmePath || path.join(repoRoot, 'README.md');
  const afPath = opts.afJsPath || path.join(repoRoot, 'bin', 'af.js');
  const readme = fs.existsSync(readmePath)
    ? fs.readFileSync(readmePath, 'utf8')
    : '';
  const afSource = fs.existsSync(afPath) ? fs.readFileSync(afPath, 'utf8') : '';
  const usageText = opts.usageText != null ? opts.usageText : extractUsageText(afSource);
  const commands =
    opts.commands || listTopLevelCommands(usageText);
  if (!commands.length) {
    return { score: 0, detail: 'no top-level commands found in USAGE' };
  }
  const missing = [];
  for (const cmd of commands) {
    // Require the command token to appear in both docs surfaces.
    // Prefer "aflt <cmd>" when present; fall back to word-boundary mention.
    const inReadme =
      readme.includes(`aflt ${cmd}`) ||
      new RegExp(`\\b${escapeRegExp(cmd)}\\b`).test(readme);
    const inUsage =
      usageText.includes(`aflt ${cmd}`) ||
      new RegExp(`\\b${escapeRegExp(cmd)}\\b`).test(usageText);
    if (!inReadme || !inUsage) missing.push(cmd);
  }
  const present = commands.length - missing.length;
  const score = Math.round((present / commands.length) * 100);
  return {
    score,
    detail:
      `${present}/${commands.length} commands in README+USAGE` +
      (missing.length
        ? `; missing: ${missing.slice(0, 12).join(',')}` +
          (missing.length > 12 ? '…' : '')
        : ''),
  };
}

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function scoreLoopExamples(opts = {}) {
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const dir = opts.examplesDir || path.join(repoRoot, 'examples', 'loops');
  const validate =
    opts.validateDefinition ||
    require('../../lib/loop').validateDefinition;

  if (!fs.existsSync(dir)) {
    return { score: 0, detail: `examples dir missing: ${dir}` };
  }
  const files = fs
    .readdirSync(dir)
    .filter((n) => n.endsWith('.json'))
    .sort();
  if (!files.length) {
    return { score: 0, detail: 'no examples/loops/*.json' };
  }
  const failed = [];
  for (const name of files) {
    const full = path.join(dir, name);
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (err) {
      failed.push(`${name}: parse error`);
      continue;
    }
    const result = validate(raw, {
      checkCwd: false,
      baseDir: path.dirname(full),
    });
    if (!result.ok) {
      failed.push(`${name}: ${(result.errors || []).join('; ') || 'invalid'}`);
    }
  }
  const okCount = files.length - failed.length;
  const score = Math.round((okCount / files.length) * 100);
  return {
    score,
    detail:
      `${okCount}/${files.length} loop examples valid` +
      (failed.length ? `; failed: ${failed.slice(0, 5).join(' | ')}` : ''),
  };
}

function scoreDashboardApi(dashboardApi) {
  const d = dashboardApi || {};
  if (d.ok) {
    return {
      score: 100,
      detail: `dashboardApi ok routes=${(d.routes && d.routes.length) || 0}`,
    };
  }
  return { score: 0, detail: 'dashboardApi not ok' };
}

/**
 * Stack-only: every non-empty line looks like a stack frame or "Error:".
 * @param {string} message
 */
function isStackOnly(message) {
  const lines = String(message || '')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return true;
  const nonStack = lines.filter((l) => {
    if (/^at\s+/.test(l)) return false;
    if (/^\s*at\s+/.test(l)) return false;
    if (/^Error:?\s*$/i.test(l)) return false;
    if (/^[A-Za-z]*Error:/.test(l) && lines.length === 1) return true; // single Error: msg is ok content
    if (/^\s*\/.+:\d+:\d+/.test(l)) return false;
    return true;
  });
  // Treat as stack-only when no substantive non-frame line remains
  // (allowing a lone "Error: …" first line as content).
  const contentLines = lines.filter((l) => !/^at\s+/.test(l) && !/^\s*\/.+:\d+/.test(l));
  if (!contentLines.length) return true;
  // If the only content is a bare "Error" with no message and rest is frames
  if (
    contentLines.length === 1 &&
    /^(Error|TypeError|RangeError)$/i.test(contentLines[0])
  ) {
    return true;
  }
  return nonStack.length === 0;
}

/**
 * @param {object} sample
 * @param {string} sample.message
 * @param {string} [sample.command] expected command mention
 * @param {boolean} [sample.expectCommand]
 */
function gradeErrorSample(sample) {
  const message = sample && sample.message != null ? String(sample.message) : '';
  if (!message.trim()) {
    return { ok: false, reason: 'empty message' };
  }
  if (isStackOnly(message)) {
    return { ok: false, reason: 'stack-only' };
  }
  const expectCommand = sample.expectCommand !== false && sample.command;
  if (expectCommand) {
    const cmd = String(sample.command);
    const lower = message.toLowerCase();
    if (!lower.includes(cmd.toLowerCase()) && !lower.includes(`aflt ${cmd}`.toLowerCase())) {
      return { ok: false, reason: `missing command mention: ${cmd}` };
    }
  }
  return { ok: true };
}

function scoreErrorQuality(opts = {}) {
  const samples = Array.isArray(opts.errorSamples) ? opts.errorSamples : [];
  if (!samples.length) {
    // Without probes, give neutral-low credit only when measure had smoke failure
    // excerpts; otherwise score 0 so the criterion cannot be gamed by omission.
    return {
      score: 0,
      detail: 'no errorSamples provided',
    };
  }
  let ok = 0;
  const notes = [];
  for (let i = 0; i < samples.length; i++) {
    const g = gradeErrorSample(samples[i]);
    if (g.ok) ok += 1;
    else notes.push(`#${i}:${g.reason}`);
  }
  const score = Math.round((ok / samples.length) * 100);
  return {
    score,
    detail:
      `${ok}/${samples.length} error samples ok` +
      (notes.length ? `; ${notes.slice(0, 6).join(', ')}` : ''),
  };
}

/**
 * Default qualitative path: never spawn engines.
 * @param {object} opts
 */
function resolveQualitative(opts = {}) {
  const env = opts.env || process.env;
  const want =
    opts.qualitative === true ||
    opts.flagsQualitative === true ||
    env.AFLT_EVAL_QUALITATIVE === '1';

  if (!want) {
    return { skipped: true, reason: 'qualitative disabled (default)' };
  }
  if (env.AGENTFLEET_TEST === '1' || env.AFLT_EVAL_SKIP_QUALITATIVE === '1') {
    return { skipped: true, reason: 'skipped in test / AFLT_EVAL_SKIP_QUALITATIVE' };
  }
  if (typeof opts.runQualitative === 'function') {
    return opts.runQualitative(opts);
  }
  return { skipped: true, reason: 'qualitative evaluator not configured' };
}

/**
 * Append one JSON line to history.
 * @param {string} historyPath
 * @param {object} row
 */
function appendHistory(historyPath, row) {
  fs.mkdirSync(path.dirname(historyPath), { recursive: true });
  fs.appendFileSync(historyPath, JSON.stringify(row) + '\n', { mode: 0o600 });
}

/**
 * @param {object} [opts]
 * @param {string} [opts.repoRoot]
 * @param {string} [opts.resultsPath]
 * @param {string} [opts.resultsDir]
 * @param {object} [opts.results]
 * @param {string} [opts.historyPath]
 * @param {boolean} [opts.qualitative]
 * @param {object[]} [opts.errorSamples]
 * @param {boolean} [opts.skipHistory]
 * @param {Function} [opts.validateDefinition]
 * @param {Function} [opts.runQualitative]
 * @param {NodeJS.ProcessEnv} [opts.env]
 */
function score(opts = {}) {
  const repoRoot = opts.repoRoot || repoRootFromModule();
  const { results, resultsPath } = loadResults({
    repoRoot,
    resultsPath: opts.resultsPath,
    resultsDir: opts.resultsDir,
    results: opts.results,
  });

  const historyPath = opts.historyPath
    ? path.resolve(opts.historyPath)
    : path.join(repoRoot, 'eval', 'history.jsonl');

  const errorSamples =
    opts.errorSamples ||
    results.errorSamples ||
    (opts.skipErrorProbes
      ? []
      : collectErrorSamples({
          repoRoot,
          afJsPath: opts.afJsPath,
          spawnSync: opts.spawnSync,
          sandboxHome: opts.sandboxHome,
          env: opts.env,
          timeoutMs: opts.errorProbeTimeoutMs,
        }));

  const byId = {
    suite_green: scoreSuiteGreen(results.suite),
    coverage: scoreCoverage(results.coverage || (results.suite && results.suite.coverage)),
    cli_smoke: scoreCliSmoke(results.cliSmoke),
    docs_commands: scoreDocsCommands({
      repoRoot,
      readmePath: opts.readmePath,
      afJsPath: opts.afJsPath,
      usageText: opts.usageText,
      commands: opts.commands,
    }),
    loop_examples: scoreLoopExamples({
      repoRoot,
      examplesDir: opts.examplesDir,
      validateDefinition: opts.validateDefinition,
    }),
    dashboard_api: scoreDashboardApi(results.dashboardApi),
    error_quality: scoreErrorQuality({ errorSamples }),
  };

  const criteria = CRITERIA.map((c) => {
    const part = byId[c.id] || { score: 0, detail: 'missing' };
    return {
      id: c.id,
      weight: c.weight,
      score: part.score,
      detail: part.detail,
    };
  });

  let weighted = 0;
  for (const c of criteria) {
    weighted += (c.weight / 100) * c.score;
  }
  const overall = Math.round(weighted);

  const qualitative = resolveQualitative({
    qualitative: opts.qualitative,
    flagsQualitative: opts.flagsQualitative,
    runQualitative: opts.runQualitative,
    env: opts.env,
  });

  const scoredAt = new Date().toISOString();
  const out = {
    ok: true,
    overall,
    criteria,
    qualitative,
    historyPath,
    scoredAt,
    resultsPath: resultsPath || null,
    rubricVersion: RUBRIC_VERSION,
  };

  if (!opts.skipHistory) {
    appendHistory(historyPath, {
      scoredAt,
      overall,
      rubricVersion: RUBRIC_VERSION,
      resultsPath: resultsPath || null,
      criteria,
      qualitative,
    });
  }

  return out;
}

module.exports = {
  score,
  findLatestResults,
  loadResults,
  scoreSuiteGreen,
  scoreCoverage,
  scoreCliSmoke,
  scoreDocsCommands,
  scoreLoopExamples,
  scoreDashboardApi,
  scoreErrorQuality,
  gradeErrorSample,
  isStackOnly,
  resolveQualitative,
  appendHistory,
  extractUsageText,
  collectErrorSamples,
  repoRootFromModule,
};
