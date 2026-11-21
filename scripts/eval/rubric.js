'use strict';

/**
 * Criterion ids, weights, and thresholds matching eval/RUBRIC.md.
 * Protected by RUBRIC GUARD — do not edit from improvement loops.
 */

const RUBRIC_VERSION = 1;

/** @type {{ id: string, weight: number }[]} */
const CRITERIA = [
  { id: 'suite_green', weight: 25 },
  { id: 'coverage', weight: 10 },
  { id: 'cli_smoke', weight: 20 },
  { id: 'docs_commands', weight: 15 },
  { id: 'loop_examples', weight: 10 },
  { id: 'dashboard_api', weight: 10 },
  { id: 'error_quality', weight: 10 },
];

const COVERAGE_LINES_THRESHOLD = 70;

/** Paths relative to repo root that improvement loops must not change. */
const PROTECTED_PATHS = [
  'eval/RUBRIC.md',
  'scripts/eval/score.js',
  'scripts/eval/rubric.js',
];

function weightSum() {
  return CRITERIA.reduce((n, c) => n + c.weight, 0);
}

module.exports = {
  RUBRIC_VERSION,
  CRITERIA,
  COVERAGE_LINES_THRESHOLD,
  PROTECTED_PATHS,
  weightSum,
};
