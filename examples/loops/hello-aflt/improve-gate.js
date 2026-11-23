#!/usr/bin/env node
'use strict';

/**
 * Improve-round eval gate for the hello-aflt loop (portable Node).
 *
 * Measures the score BEFORE comparing to baseline and AFTER the worker's
 * changes by running `node scripts/eval/eval.js --json` itself.
 * NEVER uses the last line of eval/history.jsonl as "previous" — that bug
 * compared a post-write history line to itself (e.g. 92.4 → 92.4) and
 * reverted real improvements.
 *
 * Exit codes:
 *   0 — improved (keep changes) OR plateau/regression (gameplay restored to
 *       HEAD; gate measurements preserved) so plan-next can stop.
 *   1 — test failure or locked scorer edits (scripts/eval/eval.js,
 *       scripts/eval/scorer.js) → fix attempt.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const LOCKED = ['scripts/eval/eval.js', 'scripts/eval/scorer.js'];
const RESTORE = [
  'src',
  'test',
  'public',
  'scripts/eval/bot.js',
  'README.md',
  'AGENTS.md',
  'package.json',
];
const PRESERVE = ['eval/history.jsonl', 'eval/latest-score.json', 'eval/plateau.json'];

function die(msg, code = 1) {
  process.stderr.write(`improve-gate: ${msg}\n`);
  process.exit(code);
}

function run(cmd, args) {
  return spawnSync(cmd, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env,
    shell: false,
  });
}

function parseOverall(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    if (obj && obj.overall != null && Number.isFinite(Number(obj.overall))) {
      return Number(obj.overall);
    }
  } catch (_) {
    /* fall through */
  }
  const m = raw.match(/"overall"\s*:\s*(-?\d+(?:\.\d+)?)/);
  if (m) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function measureOverall(write) {
  const args = write
    ? ['scripts/eval/eval.js', '--json', '--write']
    : ['scripts/eval/eval.js', '--json'];
  const r = run('node', args);
  if (r.status !== 0) {
    die(
      `eval.js failed (exit ${r.status}): ${(r.stderr || r.stdout || '').slice(0, 800)}`,
      1
    );
  }
  let overall = parseOverall(r.stdout);
  if (overall == null && write && fs.existsSync('eval/latest-score.json')) {
    try {
      overall = parseOverall(fs.readFileSync('eval/latest-score.json', 'utf8'));
    } catch (_) {
      overall = null;
    }
  }
  if (overall == null) {
    die('eval.js produced no overall score', 1);
  }
  return { overall, stdout: r.stdout };
}

function listTestFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    let st;
    try {
      st = fs.statSync(full);
    } catch (_) {
      continue;
    }
    if (st.isDirectory()) out.push(...listTestFiles(full));
    else if (name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

function main() {
  if (!fs.existsSync('package.json')) {
    die('must run from the tile-dungeon (game) repo root');
  }

  if (fs.existsSync('.git')) {
    const dirty = run('git', ['diff', '--name-only', 'HEAD', '--', ...LOCKED]);
    const names = String(dirty.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (names.length) {
      die(`locked scorer files were modified: ${names.join(', ')}`, 1);
    }
  }

  // BEFORE measurement — capture baseline before any history write from this gate.
  // Do not read eval/history.jsonl for "previous".
  const before = measureOverall(false);

  const testFiles = listTestFiles('test');
  const testArgs = testFiles.length ? ['--test', ...testFiles] : ['--test', 'test'];
  const testRun = run('node', testArgs);
  if (testRun.status !== 0) {
    die(`tests failed (exit ${testRun.status})`, 1);
  }

  // AFTER measurement — write history/latest via --write for the project record,
  // but compare against the gate's own before-measurement only.
  fs.mkdirSync('eval', { recursive: true });
  const after = measureOverall(true);

  const prev = before.overall;
  const next = after.overall;
  const payload = {
    previous: prev,
    after: next,
    measuredBy: 'improve-gate',
    beforeSource: 'gate-pre-measure',
    afterSource: 'gate-post-measure',
  };

  if (next > prev) {
    payload.result = 'improved';
    payload.keep_changes = true;
    payload.stop = false;
    fs.writeFileSync('eval/plateau.json', JSON.stringify(payload, null, 2) + '\n');
    process.stdout.write(`improve-gate: improved ${prev} -> ${next}\n`);
    process.exit(0);
  }

  payload.result = next === prev ? 'plateau' : 'regressed';
  payload.keep_changes = false;
  payload.stop = true;

  // Preserve gate measurements / history written by this run, then restore gameplay.
  const preserved = {};
  for (const rel of PRESERVE) {
    if (fs.existsSync(rel)) preserved[rel] = fs.readFileSync(rel);
  }
  preserved['eval/plateau.json'] = Buffer.from(JSON.stringify(payload, null, 2) + '\n');

  if (fs.existsSync('.git')) {
    const existing = [];
    for (const rel of RESTORE) {
      const ls = run('git', ['ls-files', '--', rel]);
      if (String(ls.stdout || '').trim()) existing.push(rel);
    }
    if (existing.length) {
      run('git', ['checkout', '--', ...existing]);
    }
  }

  for (const [rel, blob] of Object.entries(preserved)) {
    fs.mkdirSync(path.dirname(rel), { recursive: true });
    fs.writeFileSync(rel, blob);
  }

  process.stdout.write(
    `improve-gate: ${payload.result} ${prev} -> ${next}; gameplay changes reverted\n`
  );
  process.exit(0);
}

main();
