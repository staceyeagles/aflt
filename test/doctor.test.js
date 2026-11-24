'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');

describe('af doctor', () => {
  let home;
  let stubDir;
  let stubHc;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-doctor-home-'));
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-doctor-stub-'));
    stubHc = path.join(stubDir, 'hc');
    fs.writeFileSync(
      path.join(stubDir, 'cursor-agent'),
      '#!/usr/bin/env bash\necho ok\nexit 0\n',
      { mode: 0o755 }
    );
    fs.writeFileSync(
      stubHc,
      `#!/usr/bin/env node
const cmd = process.argv[2];
if (cmd === '--version' || cmd === 'version') {
  process.stdout.write('herdr-core 0.1.20\\n');
  process.exit(0);
}
if (cmd === 'server') { process.stdout.write('ok\\n'); process.exit(0); }
if (cmd === 'ls') {
  process.stdout.write(JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 }
    );
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(stubDir, { recursive: true, force: true });
  });

  it('is read-only and returns json checks', () => {
    const before = fs.readdirSync(home);
    const r = spawnSync(process.execPath, [afJs, 'doctor', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        AGENTFLEET_HOME: home,
        AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
        AGENTFLEET_HC_BIN: stubHc,
        PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      },
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    const hcLs = body.checks.find((c) => c.name === 'hc_ls');
    assert.ok(hcLs && hcLs.ok, JSON.stringify(body.checks));
    assert.deepEqual(fs.readdirSync(home), before);
  });

  it('does not treat an unrelated agent binary as Cursor', () => {
    const only = fs.mkdtempSync(path.join(os.tmpdir(), 'af-fake-agent-'));
    const cursorOnly = fs.mkdtempSync(path.join(os.tmpdir(), 'af-cursor-agent-'));
    try {
      fs.writeFileSync(
        path.join(only, 'agent'),
        '#!/bin/sh\necho "acme vendor cli 9.9.9"\nexit 0\n',
        { mode: 0o755 }
      );
      const rejected = spawnSync(process.execPath, [afJs, 'doctor', '--json'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTFLEET_HOME: home,
          AGENTFLEET_HC_BIN: stubHc,
          PATH: `${only}${path.delimiter}${process.env.PATH || ''}`,
          AGENTFLEET_CURSOR_BIN: '',
        },
      });
      assert.ok(rejected.status === 0 || rejected.status === 1, rejected.stdout + rejected.stderr);
      const rejectedBody = JSON.parse(rejected.stdout);
      const rejectedBin = rejectedBody.checks.find((c) => c.name === 'cursor_bin');
      assert.equal(rejectedBin.ok, false);
      assert.match(rejectedBin.detail, /not Cursor/);
      assert.match(rejectedBin.detail, /agent/);
      assert.doesNotMatch(rejectedBin.detail, /^acme/);

      fs.writeFileSync(
        path.join(cursorOnly, 'agent'),
        '#!/bin/sh\necho "Cursor Agent CLI 2026.11.1"\nexit 0\n',
        { mode: 0o755 }
      );
      const accepted = spawnSync(process.execPath, [afJs, 'doctor', '--json'], {
        encoding: 'utf8',
        env: {
          ...process.env,
          AGENTFLEET_HOME: home,
          AGENTFLEET_HC_BIN: stubHc,
          PATH: `${cursorOnly}${path.delimiter}${process.env.PATH || ''}`,
          AGENTFLEET_CURSOR_BIN: '',
        },
      });
      const acceptedBody = JSON.parse(accepted.stdout);
      const acceptedBin = acceptedBody.checks.find((c) => c.name === 'cursor_bin');
      assert.equal(acceptedBin.ok, true, JSON.stringify(acceptedBin));
      assert.match(acceptedBin.detail, /agent$/);
    } finally {
      fs.rmSync(only, { recursive: true, force: true });
      fs.rmSync(cursorOnly, { recursive: true, force: true });
    }
  });
});
