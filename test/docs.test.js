'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

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

function git(cwd, args) {
  return spawnSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'af-test',
      GIT_AUTHOR_EMAIL: 'af-test@example.com',
      GIT_COMMITTER_NAME: 'af-test',
      GIT_COMMITTER_EMAIL: 'af-test@example.com',
    },
  });
}

describe('af docs (documentarian)', () => {
  let home;
  let project;
  let stubDir;
  let stubCursor;
  let envFile;
  let promptFile;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-docs-stub-'));
    envFile = path.join(stubDir, 'env.json');
    promptFile = path.join(stubDir, 'prompt.txt');
    stubCursor = path.join(stubDir, 'cursor-agent');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  # Unique id per call (master + docs both create chats in one trigger test).
  node -e 'const c=require("crypto"); const a=c.randomBytes(16); a[6]=(a[6]&0x0f)|0x40; a[8]=(a[8]&0x3f)|0x80; const h=a.toString("hex"); console.log(h.slice(0,8)+"-"+h.slice(8,12)+"-"+h.slice(12,16)+"-"+h.slice(16,20)+"-"+h.slice(20));'
  exit 0
fi
# Cursor print-mode: prompt is the trailing positional arg (after -p flags).
PROMPT="\${@: -1}"
printf '%s' "\$PROMPT" > "${promptFile}"
node -e 'const fs=require("fs"); fs.writeFileSync(process.argv[1], JSON.stringify({
  id: process.env.AGENTFLEET_ID || null,
  role: process.env.AGENTFLEET_ROLE || null,
  result: process.env.AGENTFLEET_RESULT || null,
  cwd: process.cwd(),
  argv: process.argv.slice(2),
}, null, 2));' "${envFile}" "\$@"
if [[ "\${AF_DOCS_EDIT_CODE:-}" == "1" ]]; then
  mkdir -p lib
  echo "patched" > lib/hacked.js
fi
if [[ "\${AF_DOCS_EDIT_README:-}" == "1" ]]; then
  echo "# updated by docs stub" > README.md
fi
if [[ "\${AF_DOCS_EDIT_CHANGELOG:-}" == "1" ]]; then
  echo "# Changelog" > CHANGELOG.md
fi
# Fail only the docs worker (leave master stub successful).
if [[ "\${AGENTFLEET_ROLE:-}" == "docs" && "\${AF_DOCS_FAIL:-}" == "1" ]]; then
  exit 7
fi
if [[ "\${AF_STUB_EXIT:-0}" != "0" ]]; then
  exit "\$AF_STUB_EXIT"
fi
echo "docs-stub-ok"
exit 0
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-docs-home-'));
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'af-docs-proj-'));
    try {
      fs.unlinkSync(envFile);
    } catch (_) {
      /* ignore */
    }
    try {
      fs.unlinkSync(promptFile);
    } catch (_) {
      /* ignore */
    }
    const init = git(project, ['init']);
    assert.equal(init.status, 0, init.stderr);
    git(project, ['config', 'user.email', 'af-test@example.com']);
    git(project, ['config', 'user.name', 'af-test']);
    fs.writeFileSync(path.join(project, 'README.md'), '# proj\n');
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(project, 'docs', 'NOTES.md'), 'notes\n');
    fs.mkdirSync(path.join(project, 'lib'), { recursive: true });
    fs.writeFileSync(path.join(project, 'lib', 'app.js'), 'module.exports = 1;\n');
    git(project, ['add', '.']);
    const c1 = git(project, ['commit', '-m', 'initial']);
    assert.equal(c1.status, 0, c1.stderr + c1.stdout);
    fs.writeFileSync(path.join(project, 'lib', 'app.js'), 'module.exports = 2;\n');
    git(project, ['add', '.']);
    const c2 = git(project, ['commit', '-m', 'bump']);
    assert.equal(c2.status, 0, c2.stderr + c2.stdout);
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(project, { recursive: true, force: true });
  });

  function afEnv(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      AGENTFLEET_SESSION: '',
      AGENTFLEET_ID: '',
      AGENTFLEET_MASTER: '',
      AGENTFLEET_PARENT: '',
      ...extra,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      cwd: project,
      env: afEnv(extraEnv),
    });
  }

  function enableDocs(extra = {}) {
    fs.writeFileSync(
      path.join(project, '.agentfleet.json'),
      JSON.stringify({ docs: true, ...extra }, null, 2) + '\n'
    );
  }

  function loadRegistry() {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/messages')];
    delete require.cache[require.resolve('../lib/docs')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry');
  }

  function headSha() {
    const r = git(project, ['rev-parse', 'HEAD']);
    assert.equal(r.status, 0, r.stderr);
    return String(r.stdout).trim();
  }

  function parentSha() {
    const r = git(project, ['rev-parse', 'HEAD~1']);
    assert.equal(r.status, 0, r.stderr);
    return String(r.stdout).trim();
  }

  it('default-off: refuses unless enabled', () => {
    const r = af(['docs', project]);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /docs not enabled/);
    assert.match(r.stderr, /\.agentfleet\.json/);
    assert.ok(!fs.existsSync(path.join(home, 'docs')));
  });

  it('enabled run with fake engine creates docs session + state', () => {
    enableDocs();
    const r = af(['docs', project, '--force'], { AF_DOCS_EDIT_README: '1' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout + r.stderr, /docs-/);

    const registry = loadRegistry();
    const folder = path.basename(project);
    const s = registry.find(`docs-${folder}`);
    assert.ok(s, 'docs session should exist');
    assert.equal(s.role, 'docs');
    assert.equal(s.workerStatus, 'done');
    assert.ok(s.result);
    assert.ok(fs.existsSync(s.result));

    assert.ok(fs.existsSync(envFile));
    const seen = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.equal(seen.role, 'docs');
    assert.equal(seen.id, s.id);

    const docsDir = path.join(home, 'docs');
    assert.ok(fs.existsSync(docsDir));
    const stateFiles = fs.readdirSync(docsDir).filter((f) => f.endsWith('.json'));
    assert.equal(stateFiles.length, 1);
    const state = JSON.parse(fs.readFileSync(path.join(docsDir, stateFiles[0]), 'utf8'));
    assert.equal(state.projectRoot, fs.realpathSync(project));
    assert.equal(state.lastCommit, headSha());
    assert.equal(state.lastSessionId, s.id);
    assert.ok(Array.isArray(state.lastChangedFiles));
  });

  it('--anyway runs once without enabling in config', () => {
    assert.ok(!fs.existsSync(path.join(project, '.agentfleet.json')));
    const r = af(['docs', project, '--anyway', '--force']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const registry = loadRegistry();
    const s = registry.find(`docs-${path.basename(project)}`);
    assert.ok(s);
    assert.equal(s.role, 'docs');
  });

  it('since-tracking: second run uses recorded commit; --since overrides', () => {
    enableDocs();
    const firstHead = headSha();
    const r1 = af(['docs', project, '--force']);
    assert.equal(r1.status, 0, r1.stderr);

    fs.writeFileSync(path.join(project, 'lib', 'app.js'), 'module.exports = 3;\n');
    git(project, ['add', '.']);
    const c3 = git(project, ['commit', '-m', 'third']);
    assert.equal(c3.status, 0, c3.stderr);
    const secondHead = headSha();
    assert.notEqual(secondHead, firstHead);

    try {
      fs.unlinkSync(promptFile);
    } catch (_) {
      /* ignore */
    }
    const r2 = af(['docs', project, '--force']);
    assert.equal(r2.status, 0, r2.stderr);
    const prompt2 = fs.readFileSync(promptFile, 'utf8');
    assert.ok(prompt2.includes(firstHead), 'second run should use lastCommit from state');
    assert.ok(!prompt2.includes(`Since commit: \`${parentSha()}\``) || prompt2.includes(firstHead));

    try {
      fs.unlinkSync(promptFile);
    } catch (_) {
      /* ignore */
    }
    const override = parentSha();
    const r3 = af(['docs', project, '--since', override, '--force']);
    assert.equal(r3.status, 0, r3.stderr);
    const prompt3 = fs.readFileSync(promptFile, 'utf8');
    assert.ok(prompt3.includes(override), ' --since should win');
  });

  it('docs-only warning when worker edits a code file (no revert)', () => {
    enableDocs();
    const codePath = path.join(project, 'lib', 'hacked.js');
    assert.ok(!fs.existsSync(codePath));
    const r = af(['docs', project, '--force', '--json'], { AF_DOCS_EDIT_CODE: '1' });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.ok(fs.existsSync(codePath), 'non-doc edit must not be reverted');
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.warnings));
    assert.ok(body.warnings.some((w) => /non-doc|hacked/i.test(w)));
    assert.match(r.stderr, /WARNING/);
  });

  it('trigger fires once after successful headless master; --no-docs skips; disabled skips', () => {
    enableDocs();
    const r = af([
      'master',
      '--goal',
      'Ship docs trigger',
      '--headless',
      '--force',
      '--cwd',
      project,
      '--title',
      'DocsTrigMaster',
      '--json',
    ]);
    assert.equal(r.status, 0, `master failed: ${r.stderr}\n${r.stdout}`);
    let body;
    try {
      body = JSON.parse(r.stdout);
    } catch (err) {
      assert.fail(`master stdout not JSON: ${err.message}\nstdout=${r.stdout}\nstderr=${r.stderr}`);
    }
    assert.equal(body.ok, true, JSON.stringify(body));
    assert.ok(body.docs, `docs trigger summary expected: ${JSON.stringify(body)}`);
    assert.equal(body.docs.ok, true, JSON.stringify(body.docs));

    const registry = loadRegistry();
    const master = registry.find('DocsTrigMaster');
    assert.ok(master);
    assert.ok(master.docsTriggeredRunId);
    const docsSessions = registry.list({ includeDone: true }).filter((s) => s.role === 'docs');
    assert.equal(docsSessions.length, 1);

    // Second master run should create a new master; trigger again is once per runId
    const r2 = af([
      'master',
      '--goal',
      'Again',
      '--headless',
      '--force',
      '--cwd',
      project,
      '--title',
      'DocsTrigMaster2',
      '--no-docs',
      '--json',
    ]);
    assert.equal(r2.status, 0, r2.stderr);
    const body2 = JSON.parse(r2.stdout);
    assert.ok(!body2.docs, '--no-docs should skip trigger');
    const afterNoDocs = registry.list({ includeDone: true }).filter((s) => s.role === 'docs');
    assert.equal(afterNoDocs.length, 1);

    // Disabled project: no trigger
    fs.writeFileSync(path.join(project, '.agentfleet.json'), JSON.stringify({ docs: false }) + '\n');
    const r3 = af([
      'master',
      '--goal',
      'Disabled',
      '--headless',
      '--force',
      '--cwd',
      project,
      '--title',
      'DocsTrigMaster3',
      '--json',
    ]);
    assert.equal(r3.status, 0, r3.stderr);
    const body3 = JSON.parse(r3.stdout);
    assert.ok(body3.docs);
    assert.equal(body3.docs.skipped, true);
    assert.equal(body3.docs.reason, 'disabled');
    const afterDisabled = loadRegistry()
      .list({ includeDone: true })
      .filter((s) => s.role === 'docs');
    assert.equal(afterDisabled.length, 1);
  });

  it('auto-triggered docs failure: master exit 0, WARNING, docs:{ok:false,error}', () => {
    enableDocs();
    const r = af(
      [
        'master',
        '--goal',
        'Docs will fail',
        '--headless',
        '--force',
        '--cwd',
        project,
        '--title',
        'DocsFailMaster',
        '--json',
      ],
      { AF_DOCS_FAIL: '1' }
    );
    assert.equal(r.status, 0, `master should stay 0: ${r.stderr}\n${r.stdout}`);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.ok(body.docs);
    assert.equal(body.docs.ok, false);
    assert.ok(body.docs.error);
    assert.match(r.stderr, /WARNING: docs run failed:/);
  });

  it('af wait --docs errors when master cannot be resolved', () => {
    const registry = loadRegistry();
    const lone = registry.add({
      title: 'OrphanWorker',
      chatId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeee0101',
      cwd: project,
      engine: 'cursor',
      status: 'active',
      role: 'worker',
      workerStatus: 'done',
      parent: null,
    });
    const r = af(['wait', lone.title, '--docs', '--json']);
    assert.notEqual(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stderr + r.stdout, /could not resolve a master|wait --docs/i);
  });

  it('CHANGELOG: omitted by default; new file warns; existing/explicit allowed', () => {
    enableDocs();
    assert.ok(!fs.existsSync(path.join(project, 'CHANGELOG.md')));

    const dry = af(['docs', project, '--dry-run', '--json']);
    assert.equal(dry.status, 0, dry.stderr);
    const dryBody = JSON.parse(dry.stdout);
    assert.ok(!dryBody.docsPaths.includes('CHANGELOG.md'));
    assert.equal(dryBody.changelogAllowed, false);
    assert.equal(dryBody.force, true);

    const create = af(['docs', project, '--json'], { AF_DOCS_EDIT_CHANGELOG: '1' });
    assert.equal(create.status, 0, create.stderr);
    assert.ok(fs.existsSync(path.join(project, 'CHANGELOG.md')));
    const createBody = JSON.parse(create.stdout);
    assert.ok(createBody.warnings.some((w) => /CHANGELOG/i.test(w)));
    assert.match(create.stderr, /WARNING/);
    const prompt1 = fs.readFileSync(promptFile, 'utf8');
    assert.match(prompt1, /CHANGELOG: \*\*not allowed\*\*/);

    // Existing CHANGELOG.md is included in defaults
    fs.rmSync(path.join(home, 'docs'), { recursive: true, force: true });
    try {
      fs.unlinkSync(promptFile);
    } catch (_) {
      /* ignore */
    }
    const dry2 = af(['docs', project, '--dry-run', '--json']);
    assert.equal(dry2.status, 0, dry2.stderr);
    const dry2Body = JSON.parse(dry2.stdout);
    assert.ok(dry2Body.docsPaths.includes('CHANGELOG.md'));
    assert.equal(dry2Body.changelogAllowed, true);

    // Explicit docsPaths can allow CHANGELOG even after removing the file
    fs.unlinkSync(path.join(project, 'CHANGELOG.md'));
    enableDocs({ docsPaths: ['README.md', 'docs/', 'CHANGELOG.md'] });
    try {
      fs.unlinkSync(promptFile);
    } catch (_) {
      /* ignore */
    }
    const explicit = af(['docs', project, '--json'], { AF_DOCS_EDIT_CHANGELOG: '1' });
    assert.equal(explicit.status, 0, explicit.stderr);
    const explicitBody = JSON.parse(explicit.stdout);
    assert.ok(explicitBody.docsPaths.includes('CHANGELOG.md'));
    assert.equal(explicitBody.changelogAllowed, true);
    assert.ok(!explicitBody.warnings.some((w) => /CHANGELOG/i.test(w)));
    const prompt2 = fs.readFileSync(promptFile, 'utf8');
    assert.match(prompt2, /CHANGELOG: \*\*allowed\*\*/);
  });

  it('force defaults on; --no-force and docsForce:false opt out', () => {
    enableDocs();
    const r1 = af(['docs', project, '--json']);
    assert.equal(r1.status, 0, r1.stderr);
    const body1 = JSON.parse(r1.stdout);
    assert.equal(body1.force, true);
    const seen1 = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.ok(seen1.argv.includes('--force'), `expected --force in ${JSON.stringify(seen1.argv)}`);

    try {
      fs.unlinkSync(envFile);
    } catch (_) {
      /* ignore */
    }
    const r2 = af(['docs', project, '--no-force', '--json']);
    assert.equal(r2.status, 0, r2.stderr);
    const body2 = JSON.parse(r2.stdout);
    assert.equal(body2.force, false);
    const seen2 = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.ok(!seen2.argv.includes('--force'), `did not expect --force: ${JSON.stringify(seen2.argv)}`);

    enableDocs({ docsForce: false });
    try {
      fs.unlinkSync(envFile);
    } catch (_) {
      /* ignore */
    }
    const r3 = af(['docs', project, '--json']);
    assert.equal(r3.status, 0, r3.stderr);
    const body3 = JSON.parse(r3.stdout);
    assert.equal(body3.force, false);
    const seen3 = JSON.parse(fs.readFileSync(envFile, 'utf8'));
    assert.ok(!seen3.argv.includes('--force'));
  });

  it('dry-run purity: no registry/state/session writes', () => {
    enableDocs();
    const beforeHome = snapshotTree(home);
    const beforeProj = snapshotTree(project);
    const r = af(['docs', project, '--dry-run', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.dryRun, true);
    assert.ok(body.since);
    assert.ok(Array.isArray(body.docsPaths));
    assert.ok(typeof body.promptBytes === 'number');
    assert.equal(body.engine, 'cursor');
    assert.equal(body.force, true);
    assert.equal(body.changelogAllowed, false);
    assert.deepEqual(snapshotTree(home), beforeHome);
    assert.deepEqual(snapshotTree(project), beforeProj);
    assert.ok(!fs.existsSync(envFile), 'engine must not run on dry-run');
  });

  it('--json output shape on success', () => {
    enableDocs();
    const r = af(['docs', project, '--json'], { AF_DOCS_EDIT_README: '1' });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.ok(body.projectRoot);
    assert.ok('since' in body);
    assert.ok('sinceSource' in body);
    assert.ok('head' in body);
    assert.ok(Array.isArray(body.docsPaths));
    assert.ok(Array.isArray(body.docFilesChanged));
    assert.ok(Array.isArray(body.warnings));
    assert.equal(typeof body.force, 'boolean');
    assert.equal(typeof body.changelogAllowed, 'boolean');
    assert.ok(body.session);
    assert.equal(body.session.role, 'docs');
    assert.ok(body.handoff);
    assert.ok('lastExit' in body);
  });

  it('af ls --json includes role for docs sessions', () => {
    enableDocs();
    const run = af(['docs', project]);
    assert.equal(run.status, 0, run.stderr);
    const ls = af(['ls', '--json', '--all']);
    assert.equal(ls.status, 0, ls.stderr);
    const body = JSON.parse(ls.stdout);
    const docsRow = (body.sessions || []).find((s) => s.role === 'docs');
    assert.ok(docsRow);
    assert.match(docsRow.title, /^docs-/);
  });
});
