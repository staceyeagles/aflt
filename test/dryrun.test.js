'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

const MUTATING_HC = new Set(['run', 'send', 'keys', 'kill', 'interrupt', 'label', 'keep', 'rm']);

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

function assertNoOsc(stdout, stderr) {
  const blob = String(stdout || '') + String(stderr || '');
  assert.ok(!blob.includes('\x1b]'), 'stdout/stderr must not contain OSC escapes');
}

function assertNoMutatingHc(logPath) {
  if (!fs.existsSync(logPath)) return;
  const lines = fs.readFileSync(logPath, 'utf8').split(/\n/).filter(Boolean);
  for (const line of lines) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const cmd = entry.argv && entry.argv[0];
    assert.ok(!MUTATING_HC.has(cmd), `unexpected mutating hc subcommand: ${cmd}`);
  }
}

describe('dry-run strictly non-mutating (table)', () => {
  let home;
  let stubDir;
  let stubCursor;
  let stubHc;
  let hcLog;
  let fakeHome;
  let herdrAppHome;
  let copilotHome;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dryrun-stub-'));
    stubCursor = path.join(stubDir, 'cursor-agent');
    stubHc = path.join(stubDir, 'hc');
    hcLog = path.join(stubDir, 'hc.log');
    fs.writeFileSync(
      stubCursor,
      `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-}" == "create-chat" ]]; then
  echo "deadbeef-1111-4111-8111-ffffffffffff"
  exit 0
fi
echo "engine-should-not-run-on-dry-run"
exit 0
`,
      { mode: 0o755 }
    );
    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env node
const fs = require('fs');
const log = process.env.AF_HC_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const cmd = process.argv[2];
if (cmd === 'ls') {
  process.stdout.write(JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
if (cmd === 'get') {
  process.stdout.write(JSON.stringify({ address: 't1', state: 'live', labels: {} }));
  process.exit(0);
}
process.stderr.write('unexpected hc ' + process.argv.slice(2).join(' ') + '\\n');
process.exit(1);
`,
      { mode: 0o755 }
    );
  });

  after(() => {
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dryrun-home-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dryrun-user-'));
    herdrAppHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dryrun-herdrapp-'));
    copilotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'af-dryrun-copilot-'));
    try {
      fs.unlinkSync(hcLog);
    } catch (_) {
      /* ignore */
    }
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    fs.rmSync(herdrAppHome, { recursive: true, force: true });
    fs.rmSync(copilotHome, { recursive: true, force: true });
  });

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: stubCursor,
      HOME: fakeHome,
      HERDR_APP_HOME: herdrAppHome,
      AGENTFLEET_COPILOT_HOME: copilotHome,
      AF_HC_LOG: hcLog,
      AGENTFLEET_HC_BIN: stubHc,
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }

  function af(args, extraEnv = {}) {
    return spawnSync(process.execPath, [afJs, ...args], {
      encoding: 'utf8',
      env: env(extraEnv),
    });
  }

  function seedSession(partial = {}) {
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    const registry = require('../lib/registry');
    return registry.add({
      title: partial.title || 'DrySeed',
      chatId: partial.chatId || 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: partial.cwd || home,
      engine: partial.engine || 'cursor',
      status: 'active',
      id: partial.id,
      ...partial,
    });
  }

  function seedCopilotSession() {
    const id = 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4';
    const dir = path.join(copilotHome, 'session-state', id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'workspace.yaml'),
      [
        `id: ${id}`,
        `cwd: ${home}`,
        `git_root: ${home}`,
        'branch: main',
        'name: Dry Import',
        'user_named: true',
        'created_at: 2026-11-12T10:00:00.000Z',
        'updated_at: 2026-11-12T12:00:00.000Z',
        '',
      ].join('\n')
    );
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '');
    return id;
  }

  const cases = [
    {
      name: 'new',
      setup: () => {},
      args: () => ['new', 'DryNew', '--cwd', home, '--dry-run'],
    },
    {
      name: 'run',
      setup: () => {},
      args: () => ['run', 'DryRun', '--prompt', 'Reply pong', '--cwd', home, '--dry-run'],
    },
    {
      name: 'resume herdr',
      setup: () => seedSession({ title: 'DryResume' }),
      args: () => ['resume', 'DryResume', '--via', 'herdr', '--dry-run', '--no-open', '--no-herdr-app'],
    },
    {
      name: 'resume plain',
      setup: () => seedSession({ title: 'DryPlain', chatId: 'bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      args: () => ['resume', 'DryPlain', '--via', 'plain', '--dry-run'],
    },
    {
      name: 'resume --all herdr',
      setup: () => seedSession({ title: 'DryAll' }),
      args: () => ['resume', '--all', '--via', 'herdr', '--dry-run', '--no-open', '--no-herdr-app'],
    },
    {
      name: 'spawn',
      setup: () => seedSession({ title: 'DryParent', chatId: 'cccccccc-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      args: () => ['spawn', '--parent', 'DryParent', '--prompt', 'Do work', '--dry-run'],
    },
    {
      name: 'master',
      setup: () => {},
      args: () => ['master', '--goal', 'Ship it', '--cwd', home, '--dry-run'],
    },
    {
      name: 'docs',
      setup: () => {
        spawnSync('git', ['init'], { cwd: home, encoding: 'utf8' });
        spawnSync('git', ['-C', home, 'config', 'user.email', 'af-test@example.com'], {
          encoding: 'utf8',
        });
        spawnSync('git', ['-C', home, 'config', 'user.name', 'af-test'], { encoding: 'utf8' });
        fs.writeFileSync(path.join(home, '.agentfleet.json'), '{"docs":true}\n');
        spawnSync('git', ['-C', home, 'add', '.agentfleet.json'], { encoding: 'utf8' });
        spawnSync(
          'git',
          [
            '-C',
            home,
            '-c',
            'user.email=af-test@example.com',
            '-c',
            'user.name=af-test',
            'commit',
            '-m',
            'init',
          ],
          { encoding: 'utf8' }
        );
      },
      args: () => ['docs', home, '--dry-run'],
    },
    {
      name: 'adopt',
      setup: () => seedSession({ title: 'DryAdopt', chatId: 'dddddddd-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      args: () => ['adopt', 'DryAdopt', '--dry-run'],
    },
    {
      name: 'sync',
      setup: () => seedSession({ title: 'DrySync', chatId: 'eeeeeeee-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      args: () => ['sync', '--dry-run'],
    },
    {
      name: 'rm',
      setup: () => seedSession({ title: 'DryRm', chatId: 'ffffffff-bbbb-cccc-dddd-eeeeeeeeeeee' }),
      args: () => ['rm', 'DryRm', '--dry-run'],
    },
    {
      name: 'import copilot',
      setup: () => seedCopilotSession(),
      args: (id) => ['import', '--engine', 'copilot', id, '--dry-run', '--cwd', home],
      argsFromSetup: true,
    },
    {
      name: 'herdr-app install',
      setup: () => {},
      args: () => ['herdr-app', 'install', '--dry-run'],
    },
    {
      name: 'herdr-templates',
      setup: () => {},
      args: () => ['herdr-templates', '--dry-run'],
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      const setupRet = c.setup();
      const before = snapshotTree(home);
      const beforeUser = snapshotTree(fakeHome);
      const beforeApp = snapshotTree(herdrAppHome);
      const beforeCopilot = snapshotTree(copilotHome);
      try {
        fs.unlinkSync(hcLog);
      } catch (_) {
        /* ignore */
      }

      const args = c.argsFromSetup ? c.args(setupRet) : c.args();
      const r = af(args);
      assert.equal(r.status, 0, `${c.name} failed: ${r.stderr}\n${r.stdout}`);
      assertNoOsc(r.stdout, r.stderr);
      assertNoMutatingHc(hcLog);

      const after = snapshotTree(home);
      assert.deepEqual(after, before, `${c.name}: AGENTFLEET_HOME changed`);
      assert.deepEqual(snapshotTree(fakeHome), beforeUser, `${c.name}: HOME changed`);
      assert.deepEqual(snapshotTree(herdrAppHome), beforeApp, `${c.name}: HERDR_APP_HOME changed`);
      assert.deepEqual(snapshotTree(copilotHome), beforeCopilot, `${c.name}: COPILOT_HOME changed`);
    });
  }
});
