'use strict';

const { it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

it('af ls piped into a reader that closes early exits quietly (no EPIPE crash)', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-epipe-'));
  const sessions = [];
  for (let i = 0; i < 400; i++) {
    sessions.push({ id: `s${i}-abcdef`, title: `s${i}`, chatId: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, cwd: home, engine: 'cursor', status: 'active' });
  }
  fs.writeFileSync(path.join(home, 'sessions.json'), JSON.stringify({ version: 1, sessions }));
  const af = path.join(__dirname, '..', 'bin', 'af.js');
  const r = spawnSync('/bin/sh', ['-c', `"${process.execPath}" "${af}" ls --all | head -1`], {
    env: { ...process.env, AGENTFLEET_HOME: home, AGENTFLEET_REGISTRY: path.join(home, 'sessions.json'), PATH: '/usr/bin:/bin' },
    encoding: 'utf8',
  });
  assert.ok(!/EPIPE/.test(r.stderr), r.stderr);
  assert.match(r.stdout, /TITLE/);
});
