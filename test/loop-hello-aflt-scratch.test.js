'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const repoRoot = path.join(__dirname, '..');
const scratchDir = path.join(repoRoot, 'examples', 'loops', 'hello-aflt-scratch');
const scratchJson = path.join(scratchDir, 'hello-aflt-scratch.json');
const seedDir = path.join(scratchDir, 'seed');
const checkScript = path.join(scratchDir, 'm0-check.js');
const originalDir = path.join(repoRoot, 'examples', 'loops', 'hello-aflt');

/** Extensions that mean "code or markup", banned from the docs-only seed. */
const CODE_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.html', '.htm', '.css', '.svg', '.json', '.sh', '.py', '.wasm',
]);
/** The only .json allowed in the seed (config, not code). */
const CONFIG_JSON = new Set(['.agentfleet.json']);

function listFiles(dir, prefix = '') {
  const out = [];
  for (const name of fs.readdirSync(dir).sort()) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    if (fs.statSync(abs).isDirectory()) out.push(...listFiles(abs, rel));
    else out.push(rel);
  }
  return out;
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aflt-scratch-'));
}

function runCheck(cwd, args = []) {
  return spawnSync(process.execPath, [checkScript, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: 60000,
  });
}

describe('hello-aflt-scratch example (docs-only seed)', () => {
  it('definition validates and dry-runs with the same milestones as hello-aflt', () => {
    const loop = require('../lib/loop');
    const raw = JSON.parse(fs.readFileSync(scratchJson, 'utf8'));
    const original = JSON.parse(fs.readFileSync(path.join(originalDir, 'hello-aflt.json'), 'utf8'));
    assert.equal(raw.name, 'hello-aflt-scratch');
    assert.ok(!Object.prototype.hasOwnProperty.call(raw, 'engine') || raw.engine == null);
    assert.ok(!JSON.stringify(raw).includes('/tmp/'));
    assert.ok(!JSON.stringify(raw).includes('m0-seed'));
    assert.ok(!JSON.stringify(raw).includes('seed-m0'));
    assert.deepEqual(
      raw.phases.map((p) => p.id),
      original.phases.map((p) => p.id)
    );
    for (const p of raw.phases) {
      assert.match(p.session, /^hello-aflt-scratch-/, p.id);
    }
    assert.equal(raw.allow.push, false);
    assert.equal(raw.allow.merge, false);

    const result = loop.validateFile(scratchJson, { checkCwd: false, cwdBase: tmpDir() });
    assert.equal(result.ok, true, (result.errors || []).join('; '));
    for (const p of result.definition.phases) {
      assert.ok(p.promptFile && p.promptFile.startsWith(scratchDir), p.promptFile);
      assert.ok(fs.existsSync(p.promptFile), p.promptFile);
    }
    const m0 = result.definition.phases.find((p) => p.id === 'm0');
    assert.deepEqual(m0.eval.command, ['node', checkScript]);
    assert.ok(m0.maxFixAttempts >= 1);

    const plan = loop.planDryRun(result.definition, scratchJson);
    assert.equal(plan.ok, true);
    assert.equal(plan.name, 'hello-aflt-scratch');
    assert.ok(plan.phases.length >= 7);
  });

  it('seed contains only instructions and config: no code, no HTML', () => {
    const files = listFiles(seedDir);
    assert.deepEqual(files, ['.agentfleet.json', '.gitignore', 'AGENTS.md', 'SPEC.md']);
    for (const rel of files) {
      const base = path.basename(rel);
      const ext = path.extname(base).toLowerCase();
      if (CONFIG_JSON.has(base)) {
        // Config only: a flat object of strings, nothing executable.
        const cfg = JSON.parse(fs.readFileSync(path.join(seedDir, rel), 'utf8'));
        for (const v of Object.values(cfg)) assert.equal(typeof v, 'string', rel);
        continue;
      }
      assert.ok(!CODE_EXTS.has(ext), `code/markup file in seed: ${rel}`);
      assert.ok(base === '.gitignore' || ext === '.md' || ext === '.txt', `unexpected seed file: ${rel}`);
    }
    // Markdown must not smuggle a full scaffold in as fenced code.
    for (const rel of files.filter((f) => f.endsWith('.md'))) {
      const text = fs.readFileSync(path.join(seedDir, rel), 'utf8');
      assert.ok(!/```(js|javascript|html|mjs|ts)\b/i.test(text), `${rel} embeds code`);
      assert.ok(!/<!DOCTYPE html>/i.test(text), `${rel} embeds HTML`);
    }
    const spec = fs.readFileSync(path.join(seedDir, 'SPEC.md'), 'utf8');
    assert.match(spec, /M0 — Scaffold/);
    assert.match(spec, /8792/);
    assert.match(spec, /createServer/);
  });

  it('m0-check guards the seed allowlist', () => {
    const { isAllowedSeedFile } = require(checkScript);
    for (const ok of ['AGENTS.md', 'SPEC.md', 'notes.txt', '.gitignore', '.agentfleet.json']) {
      assert.equal(isAllowedSeedFile(ok), true, ok);
    }
    for (const bad of ['server.js', 'src/main.js', 'public/index.html', 'package.json', 'a.ts', 'x.css', 'm.mjs']) {
      assert.equal(isAllowedSeedFile(bad), false, bad);
    }
  });

  it('prompts make M0 a real build and never assume seed code', () => {
    const read = (n) => fs.readFileSync(path.join(scratchDir, 'prompts', n), 'utf8');
    const m0 = read('M0.txt');
    assert.ok(!/do nothing heavy/i.test(m0));
    assert.ok(!/seed-m0/.test(m0));
    assert.ok(!/m0-seed/.test(m0));
    assert.match(m0, /FROM SCRATCH/);
    assert.match(m0, /package\.json/);
    assert.match(m0, /"type": "module"/);
    assert.match(m0, /8792/);
    assert.match(m0, /public\/index\.html/);
    assert.match(m0, /<canvas id="game"/);
    assert.match(m0, /src\/main\.js/);
    assert.match(m0, /test\/smoke\.test\.js/);
    assert.match(m0, /node:test/);
    assert.match(m0, /Work only inside this repo/);
    assert.match(m0, /Do not commit/);
    for (const n of ['M1.txt', 'M2.txt', 'M3.txt', 'M4.txt', 'M5a.txt']) {
      const text = read(n);
      assert.match(text, /no seed code/, n);
      assert.match(text, /SPEC\.md/, n);
      assert.ok(!/seed-m0/.test(text), n);
      assert.match(text, /Do not commit/, n);
    }
    const m5a = read('M5a.txt');
    assert.match(m5a, /crash_free/);
    assert.match(m5a, /AVG_DEPTH_TARGET\s*=\s*3\.5/);

    const planNext = read('plan-next.txt');
    assert.match(planNext, /hello-aflt-scratch-rN/);
    assert.match(planNext, /\.\.\/hello-aflt\/improve-gate\.js/);
    const loop = require('../lib/loop');
    const resolved = loop.resolveEvalCommandPaths(['node', '../hello-aflt/improve-gate.js'], {
      definitionDir: scratchDir,
    });
    assert.deepEqual(resolved, ['node', path.join(originalDir, 'improve-gate.js')]);
  });

  it('m0-check --seed-docs installs only the docs and never overwrites', () => {
    const cwd = tmpDir();
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# mine\n');
    const r = runCheck(cwd, ['--seed-docs']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(listFiles(cwd), ['.agentfleet.json', '.gitignore', 'AGENTS.md', 'SPEC.md']);
    assert.equal(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8'), '# mine\n');
  });

  it('m0-check fails on a docs-only tree and copies no code in', () => {
    const cwd = tmpDir();
    const r = runCheck(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /missing package\.json/);
    assert.match(r.stderr, /missing server\.js/);
    assert.ok(!fs.existsSync(path.join(cwd, 'package.json')));
    assert.ok(!fs.existsSync(path.join(cwd, 'server.js')));
  });

  it('m0-check flags a scaffold that breaks the spec', () => {
    const cwd = tmpDir();
    fs.mkdirSync(path.join(cwd, 'test'));
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'x', scripts: { test: 'jest' }, dependencies: { express: '1' } })
    );
    fs.writeFileSync(path.join(cwd, 'server.js'), "const http = require('http');\n");
    fs.writeFileSync(path.join(cwd, 'test', 'smoke.test.js'), '// empty\n');
    const r = runCheck(cwd);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /"type" must be "module"/);
    assert.match(r.stderr, /must run node --test/);
    assert.match(r.stderr, /dependencies must be empty/);
    assert.match(r.stderr, /8792/);
    assert.match(r.stderr, /export createServer/);
  });

  it('m0-check passes an agent-built scaffold (tests + server boot)', () => {
    // Stand-in for what an M0 agent writes: the original hello-aflt scaffold.
    const cwd = tmpDir();
    fs.cpSync(path.join(originalDir, 'm0-seed'), cwd, { recursive: true });
    fs.rmSync(path.join(cwd, 'AGENTS.md'));
    const r = runCheck(cwd);
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /installed seed docs: AGENTS\.md, SPEC\.md/);
    assert.match(r.stdout, /m0-check: ok/);
  });

  it('docs point at the scratch variant', () => {
    const quick = fs.readFileSync(path.join(repoRoot, 'docs', 'cli-quickstart-loops.md'), 'utf8');
    assert.match(quick, /hello-aflt-scratch\/hello-aflt-scratch\.json/);
    assert.match(quick, /m0-check\.js" --seed-docs/);
    assert.match(quick, /--allow-existing/);
    const readme = fs.readFileSync(path.join(scratchDir, 'README.md'), 'utf8');
    assert.match(readme, /git init/);
    assert.match(readme, /aflt loop run .*hello-aflt-scratch\.json/);
    assert.match(readme, /no code and no HTML/);
    const orig = fs.readFileSync(path.join(originalDir, 'README.md'), 'utf8');
    assert.match(orig, /hello-aflt-scratch/);
  });
});
