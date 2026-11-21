'use strict';

/**
 * Human-readable / JSON report from eval/history.jsonl.
 */

const fs = require('fs');
const path = require('path');

/**
 * Read JSONL history (skip blank / invalid lines).
 * @param {string} historyPath
 * @returns {object[]}
 */
function readHistory(historyPath) {
  if (!historyPath || !fs.existsSync(historyPath)) return [];
  const text = fs.readFileSync(historyPath, 'utf8');
  const rows = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      rows.push(JSON.parse(t));
    } catch (_) {
      /* skip bad lines */
    }
  }
  return rows;
}

/**
 * @param {object} [opts]
 * @param {string} [opts.historyPath]
 * @param {string} [opts.repoRoot]
 * @param {number} [opts.limit] max history entries to consider (default 20)
 * @returns {{
 *   ok: boolean,
 *   latest: object|null,
 *   previous: object|null,
 *   trend: { delta: number|null, count: number },
 *   entries: object[],
 *   historyPath: string,
 *   text: string
 * }}
 */
function report(opts = {}) {
  const repoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..');
  const historyPath = opts.historyPath
    ? path.resolve(opts.historyPath)
    : path.join(repoRoot, 'eval', 'history.jsonl');
  const limit =
    opts.limit != null && Number.isFinite(Number(opts.limit))
      ? Math.max(1, Math.floor(Number(opts.limit)))
      : 20;

  const all = readHistory(historyPath);
  const entries = all.slice(-limit);
  const latest = entries.length ? entries[entries.length - 1] : null;
  const previous = entries.length >= 2 ? entries[entries.length - 2] : null;

  let delta = null;
  if (
    latest &&
    previous &&
    typeof latest.overall === 'number' &&
    typeof previous.overall === 'number'
  ) {
    delta = latest.overall - previous.overall;
  }

  const lines = [];
  if (!latest) {
    lines.push('eval report: no scores in history');
    lines.push(`  history: ${historyPath}`);
  } else {
    lines.push(
      `eval report: overall=${latest.overall}` +
        (delta != null ? ` (Δ ${delta >= 0 ? '+' : ''}${delta})` : '') +
        ` scoredAt=${latest.scoredAt || '?'}`
    );
    lines.push(`  history: ${historyPath} (entries=${all.length})`);
    if (latest.resultsPath) lines.push(`  results: ${latest.resultsPath}`);
    const criteria = latest.criteria || [];
    for (const c of criteria) {
      lines.push(
        `  ${c.id}: ${c.score}` +
          (c.weight != null ? ` (w=${c.weight})` : '') +
          (c.detail ? ` — ${c.detail}` : '')
      );
    }
    if (latest.qualitative) {
      const q = latest.qualitative;
      if (q.skipped) lines.push(`  qualitative: skipped (${q.reason || 'n/a'})`);
      else lines.push(`  qualitative: ${JSON.stringify(q)}`);
    }
  }

  return {
    ok: true,
    latest,
    previous,
    trend: { delta, count: all.length },
    entries,
    historyPath,
    text: lines.join('\n') + '\n',
  };
}

module.exports = {
  report,
  readHistory,
};
