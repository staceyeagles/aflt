'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const herdr = require('../lib/herdr');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const PROMPT_NAMES = ['DOC-AGENT', 'documentarian', 'orchestrator'];

function hashFile(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function snapshotTree(root) {
  const files = [];
  function walk(dir, rel = '') {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      const r = rel ? path.join(rel, name) : name;
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full, r);
      else if (st.isSymbolicLink()) files.push({ path: r, type: 'symlink', target: fs.readlinkSync(full) });
      else files.push({ path: r, type: 'file', hash: hashFile(full), size: st.size });
    }
  }
  walk(root);
  return files;
}

describe('herdr-templates allowlist', () => {
  let home;
  let fakeHome;
  let destDir;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-herdr-tpl-home-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-herdr-tpl-user-'));
    destDir = path.join(fakeHome, '.config', 'herdr-core', 'templates');
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  });

  function af(args) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFLEET_HOME: home,
        HOME: fakeHome,
      },
    });
  }

  it('exports HERDR_TEMPLATE_FILES as the three real Herdr templates', () => {
    assert.deepEqual([...herdr.HERDR_TEMPLATE_FILES], ['copilot.md', 'cursor.md', 'opencode.md']);
  });

  it('--dry-run would install only copilot/cursor/opencode; no files written', () => {
    const beforeHome = snapshotTree(home);
    const beforeUser = snapshotTree(fakeHome);
    const r = af(['herdr-templates', '--dry-run']);
    assert.equal(r.status, 0, r.stderr);
    const out = `${r.stdout}\n${r.stderr}`;
    for (const f of herdr.HERDR_TEMPLATE_FILES) {
      assert.ok(out.includes(f), `dry-run should mention ${f}: ${out}`);
    }
    for (const name of PROMPT_NAMES) {
      assert.ok(!out.includes(name), `dry-run must not mention ${name}: ${out}`);
    }
    assert.match(r.stderr, /herdr templates: would install 3, skipped 0/);
    assert.deepEqual(snapshotTree(home), beforeHome);
    assert.deepEqual(snapshotTree(fakeHome), beforeUser);
    assert.equal(fs.existsSync(destDir), false);
  });

  it('install copies exactly the three Herdr templates, not aflt prompt files', () => {
    const r = af(['herdr-templates']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /herdr templates: installed 3, skipped 0/);
    assert.ok(fs.existsSync(destDir));
    const installed = fs.readdirSync(destDir).sort();
    assert.deepEqual(installed, [...herdr.HERDR_TEMPLATE_FILES].sort());
    for (const f of herdr.HERDR_TEMPLATE_FILES) {
      const src = path.join(__dirname, '..', 'templates', f);
      assert.equal(fs.readFileSync(path.join(destDir, f), 'utf8'), fs.readFileSync(src, 'utf8'));
    }
    for (const name of ['DOC-AGENT.md', 'documentarian.md', 'orchestrator.md']) {
      assert.equal(fs.existsSync(path.join(destDir, name)), false);
    }
  });

  it('skips existing dest without --force; overwrites with --force', () => {
    fs.mkdirSync(destDir, { recursive: true });
    const cursorDest = path.join(destDir, 'cursor.md');
    fs.writeFileSync(cursorDest, 'OLD_CURSOR\n');

    const skip = af(['herdr-templates']);
    assert.equal(skip.status, 0, skip.stderr);
    assert.match(skip.stderr, /skip .*cursor\.md/);
    assert.match(skip.stderr, /herdr templates: installed 2, skipped 1/);
    assert.equal(fs.readFileSync(cursorDest, 'utf8'), 'OLD_CURSOR\n');
    assert.ok(fs.existsSync(path.join(destDir, 'copilot.md')));
    assert.ok(fs.existsSync(path.join(destDir, 'opencode.md')));

    const forced = af(['herdr-templates', '--force']);
    assert.equal(forced.status, 0, forced.stderr);
    assert.match(forced.stderr, /herdr templates: installed 3, skipped 0/);
    const src = path.join(__dirname, '..', 'templates', 'cursor.md');
    assert.equal(fs.readFileSync(cursorDest, 'utf8'), fs.readFileSync(src, 'utf8'));
  });
});
