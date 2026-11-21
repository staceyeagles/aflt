'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..');
const afJs = path.join(repoRoot, 'bin', 'af.js');
const tutorialDir = path.join(repoRoot, 'docs', 'tutorial');

function readUsage() {
  const src = fs.readFileSync(afJs, 'utf8');
  const m = src.match(/const USAGE = `([\s\S]*?)`;/);
  assert.ok(m, 'USAGE string not found in bin/af.js');
  return m[1];
}

/**
 * Build the set of command paths documented in USAGE (1–3 levels).
 * Examples: "loop", "loop validate", "eval measure", "docs notify flush",
 * "space create", "herdr-app install", "memory sync".
 */
function extractUsageCommandPaths(usageText) {
  const paths = new Set();

  function addPath(parts) {
    for (let i = 1; i <= parts.length; i++) {
      paths.add(parts.slice(0, i).join(' '));
    }
  }

  function expandAlts(tok) {
    return String(tok)
      .split('|')
      .map((t) => t.trim())
      .filter((t) => /^[a-z][\w-]*$/i.test(t));
  }

  // Every "aflt …" occurrence (including "| aflt pick" mid-line).
  const re = /\baflt\s+/g;
  const text = String(usageText);
  let match;
  while ((match = re.exec(text)) !== null) {
    const start = match.index + match[0].length;
    const lineEnd = text.indexOf('\n', start);
    const slice = text.slice(start, lineEnd === -1 ? text.length : lineEnd);
    const rawTokens = slice.trim().split(/\s+/).filter(Boolean);
    const cmdTokens = [];
    for (const raw of rawTokens) {
      let t = raw.replace(/[,.:]+$/, '');
      if (
        t.startsWith('[') ||
        t.startsWith('<') ||
        t.startsWith('-') ||
        t.startsWith('"') ||
        t.startsWith('`') ||
        t.includes('"') ||
        t.includes('<') ||
        t.includes('[')
      ) {
        break;
      }
      const alts = expandAlts(t);
      if (!alts.length) break;
      if (alts.length === 1) {
        cmdTokens.push(alts[0].toLowerCase());
        addPath(cmdTokens);
      } else {
        for (const alt of alts) {
          addPath([...cmdTokens, alt.toLowerCase()]);
        }
        break;
      }
      if (cmdTokens.length >= 3) break;
    }
  }

  // Thin / switch aliases that may not get a full USAGE path line
  for (const extra of [
    'list',
    'remove',
    'set-cwd',
    'pick',
    'cursor',
    'copilot',
    'opencode',
    'version',
    'help',
  ]) {
    paths.add(extra);
  }
  return paths;
}

/** Flags that take a following value — skipped when parsing tutorial invocations. */
const VALUE_FLAGS = new Set([
  '--space',
  '--cwd',
  '--engine',
  '--project',
  '--timeout',
  '--prompt',
  '--mode',
  '--via',
  '--host',
  '--port',
  '--out',
  '--status',
  '--tag',
  '--from',
  '--type',
  '--reply',
  '--base',
  '--paths',
  '--history',
  '--baseline',
  '--results',
  '--results-dir',
  '--write-baseline',
  '--max-rounds',
  '--rounds',
  '--limit',
  '--days',
  '--ids',
  '--memory',
  '--parent',
  '--title',
  '--chat',
  '--model',
  '--output-format',
  '--active-days',
  '--since',
  '--note',
  '--reason',
  '--id',
  '--interval',
  '--send-grace',
  '--worker-engine',
  '--task',
  '--header',
  '--snapshot',
  '--goal',
]);

/**
 * Collect fenced code blocks and inline backtick spans from markdown.
 */
function extractCodeSnippets(md) {
  const snippets = [];
  const fenced = /```[\w]*\n([\s\S]*?)```/g;
  let m;
  while ((m = fenced.exec(md)) !== null) {
    snippets.push(m[1]);
  }
  const inline = /`([^`]+)`/g;
  while ((m = inline.exec(md)) !== null) {
    snippets.push(m[1]);
  }
  return snippets;
}

/** Top-level verbs that may follow the product name in prose, not in USAGE paths. */
const PROSE_AFTER_AFLT = new Set([
  'does',
  'never',
  'is',
  'was',
  'will',
  'can',
  'should',
  'keeps',
  'labels',
  'tracks',
  'reports',
  'stays',
  'may',
  'itself',
]);

/**
 * From a snippet that may contain shell lines, yield command-word sequences after each `aflt`.
 */
function commandWordsAfterAflt(snippet) {
  const sequences = [];
  const re = /\baflt\b/g;
  let m;
  while ((m = re.exec(snippet)) !== null) {
    // Ignore path segments like /path/to/aflt/completions
    if (m.index > 0) {
      const prev = snippet[m.index - 1];
      if (prev === '/' || prev === '\\' || /[A-Za-z0-9_-]/.test(prev)) continue;
    }
    const after = snippet.slice(m.index + m[0].length);
    // Stop at newline or shell operators for this invocation
    const line = after.split(/[\n|&;]/)[0];
    const tokens = line.trim().split(/\s+/).filter(Boolean);
    const words = [];
    let i = 0;
    while (i < tokens.length) {
      let t = tokens[i].replace(/[,:;]+$/, '');
      if (VALUE_FLAGS.has(t)) {
        i += 2;
        continue;
      }
      if (t.startsWith('--') || (t.startsWith('-') && t.length > 1 && t !== '-')) {
        i += 1;
        continue;
      }
      if (t === '-' || t === '\\') {
        i += 1;
        continue;
      }
      if (
        t.startsWith('<') ||
        t.startsWith('[') ||
        t.startsWith('"') ||
        t.startsWith("'") ||
        t.startsWith('$') ||
        t.startsWith('(') ||
        t.includes('/') ||
        t.includes('=') ||
        t.includes('.json') ||
        t.includes('.md') ||
        t.includes('.txt') ||
        t.includes('.html') ||
        t.includes('.svg')
      ) {
        break;
      }
      if (!/^[a-z][\w-]*$/i.test(t)) break;
      words.push(t.toLowerCase());
      i += 1;
      if (words.length >= 4) break;
    }
    if (!words.length) continue;
    if (PROSE_AFTER_AFLT.has(words[0])) continue;
    sequences.push(words);
  }
  return sequences;
}

/**
 * Longest prefix of words that exists in usagePaths (greedy).
 * Returns null if even the top-level command is unknown.
 */
function resolveCommandPath(words, usagePaths) {
  if (!words.length) return null;
  let best = null;
  const acc = [];
  for (const w of words) {
    const candidate = [...acc, w].join(' ');
    if (usagePaths.has(candidate)) {
      acc.push(w);
      best = candidate;
    } else {
      break;
    }
  }
  return best;
}

function listTutorialMarkdownFiles() {
  assert.ok(fs.existsSync(tutorialDir), `missing ${tutorialDir}`);
  const out = [];
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) walk(full);
      else if (name.endsWith('.md')) out.push(full);
    }
  }
  walk(tutorialDir);
  return out;
}

function assertRelativeLinksResolve(filePath, content) {
  const linkRe = /\[([^\]]*)\]\(([^)]+)\)/g;
  let m;
  while ((m = linkRe.exec(content)) !== null) {
    let target = m[2].trim();
    if (!target || target.startsWith('#')) continue;
    if (/^[a-z][a-z0-9+.-]*:/i.test(target)) continue; // http:, mailto:, etc.
    target = target.split('#')[0].split('?')[0];
    if (!target) continue;
    const resolved = path.resolve(path.dirname(filePath), target);
    assert.ok(
      fs.existsSync(resolved),
      `broken relative link in ${path.relative(repoRoot, filePath)}: (${m[2]}) -> ${resolved}`
    );
  }
}

describe('docs/tutorial', () => {
  it('every aflt command path in tutorial code/backticks exists in USAGE', () => {
    const usage = readUsage();
    const usagePaths = extractUsageCommandPaths(usage);
    assert.ok(usagePaths.has('loop validate'), 'USAGE should document loop validate');
    assert.ok(usagePaths.has('eval measure'), 'USAGE should document eval measure');
    assert.ok(usagePaths.has('space create'), 'USAGE should document space create');

    const missing = [];
    const seen = new Set();

    for (const file of listTutorialMarkdownFiles()) {
      const md = fs.readFileSync(file, 'utf8');
      for (const snippet of extractCodeSnippets(md)) {
        for (const words of commandWordsAfterAflt(snippet)) {
          const resolved = resolveCommandPath(words, usagePaths);
          if (!resolved) {
            // Top-level token is not a USAGE command (and not filtered as prose).
            missing.push({
              file: path.relative(repoRoot, file),
              words: words.join(' '),
            });
            continue;
          }
          seen.add(resolved);
          // If tutorial continued with another command-like word that is NOT
          // a valid extension, that is fine (args). If the top-level was wrong,
          // resolveCommandPath already returned null.
          assert.ok(
            usagePaths.has(resolved),
            `${path.relative(repoRoot, file)}: command path "${resolved}" not in USAGE`
          );
        }
      }
    }

    assert.deepEqual(
      missing,
      [],
      `tutorial mentions aflt commands not in USAGE: ${JSON.stringify(missing, null, 2)}`
    );
    assert.ok(seen.has('space create') || seen.has('space'), 'tutorial should mention space commands');
    assert.ok(seen.size > 10, `expected many command paths, got ${seen.size}`);
  });

  it('relative markdown links in tutorial files resolve', () => {
    for (const file of listTutorialMarkdownFiles()) {
      const md = fs.readFileSync(file, 'utf8');
      assertRelativeLinksResolve(file, md);
    }
  });

  it('README.md and AGENTS.md link to the tutorial index', () => {
    const readme = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');
    const agents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
    assert.match(readme, /docs\/tutorial\/README\.md/);
    assert.match(agents, /docs\/tutorial\/README\.md/);
  });

  it('expected chapter files exist', () => {
    const expected = [
      'README.md',
      '00-overview.md',
      '01-install.md',
      '02-first-run.md',
      '03-dashboard.md',
      '04-herdr.md',
      '05-memory.md',
      '06-notify.md',
      '07-messaging.md',
      '08-purge.md',
      '09-loops.md',
      '10-eval.md',
      '11-spaces.md',
      '12-token-usage.md',
      '13-troubleshooting.md',
    ];
    for (const name of expected) {
      assert.ok(
        fs.existsSync(path.join(tutorialDir, name)),
        `missing docs/tutorial/${name}`
      );
    }
  });
});
