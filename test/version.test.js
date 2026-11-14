'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const PKG_VERSION = require('../package.json').version;

function runAf(args, envExtra = {}) {
  return spawnSync(process.execPath, [afJs, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...envExtra },
  });
}

describe('aflt version', () => {
  it('--version prints aflt <version>', () => {
    const r = runAf(['--version']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `aflt ${PKG_VERSION}`);
  });

  it('-v prints the same', () => {
    const r = runAf(['-v']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `aflt ${PKG_VERSION}`);
  });

  it('version subcommand prints the same', () => {
    const r = runAf(['version']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), `aflt ${PKG_VERSION}`);
  });

  it('version --json prints {"version":"..."}', () => {
    const r = runAf(['version', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { version: PKG_VERSION });
  });

  it('--version --json works', () => {
    const r = runAf(['--version', '--json']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), { version: PKG_VERSION });
  });
});

describe('aflt help branding', () => {
  it('USAGE leads with aflt and mentions af / agentfleet aliases', () => {
    const r = runAf(['help']);
    assert.equal(r.status, 0, r.stderr);
    const lines = r.stdout.split('\n');
    assert.match(lines[0], /^aflt \(AgentFleet\)/);
    assert.match(r.stdout, /Aliases:\s*af,\s*agentfleet/);
    assert.match(r.stdout, /aflt --version/);
    assert.ok(r.stdout.includes(`aflt ${PKG_VERSION}`));
  });
});
