'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const herdr = require('../lib/herdr');
const herdrapp = require('../lib/herdrapp');

const hermeticDir = path.join(__dirname, 'fixtures', 'hermetic');
const home = os.homedir();

describe('hermetic test setup', () => {
  it('resolves hc and herdr-app to suite stubs, not ~/.local/bin', () => {
    assert.equal(process.env.AGENTFLEET_TEST_HERMETIC, '1');
    const hc = herdr.resolveHcBin();
    const app = herdrapp.resolveHerdrAppBin();
    assert.equal(hc, path.join(hermeticDir, 'hc'));
    assert.equal(app, path.join(hermeticDir, 'herdr-app'));
    assert.ok(fs.existsSync(hc));
    assert.ok(fs.existsSync(app));
    const localBin = path.join(home, '.local', 'bin');
    assert.ok(!hc.startsWith(localBin + path.sep), hc);
    assert.ok(!app.startsWith(localBin + path.sep), app);
  });

  it('keeps Herdr-app wait budget short for the suite', () => {
    assert.ok(Number(process.env.AGENTFLEET_HERDR_APP_WAIT_MS) <= 100);
    assert.ok(herdrapp.herdrAppWaitMs(process.env, 5000) <= 100);
  });
});
