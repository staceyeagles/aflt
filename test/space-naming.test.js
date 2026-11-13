'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const afJs = path.join(__dirname, '..', 'bin', 'af.js');
const herdrapp = require('../lib/herdrapp');

/** Shared fake hc + herdr-app that model park → label → keep adoption. */
function writeFakeBins(stubDir) {
  fs.writeFileSync(
    path.join(stubDir, 'cursor-agent'),
    '#!/usr/bin/env bash\necho ok\nexit 0\n',
    { mode: 0o755 }
  );

  fs.writeFileSync(
    path.join(stubDir, 'hc'),
    `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const log = process.env.AF_HC_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const statePath = process.env.AF_HERDR_STATE;
const cmd = process.argv[2];

function load() {
  if (!statePath || !fs.existsSync(statePath)) {
    return { spaces: [], labels: {}, parked: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function save(st) {
  if (!statePath) return;
  fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
}
function removeTerminal(st, addr) {
  for (const sp of st.spaces || []) {
    for (const tab of sp.tabs || []) {
      tab.terminals = (tab.terminals || []).filter((t) => t.terminal !== addr);
    }
  }
}
function adopt(st, addr) {
  const labels = st.labels[addr] || {};
  const spaceId = labels['herdr.space'];
  const tabId = labels['herdr.tab'];
  if (!spaceId || !tabId) return;
  removeTerminal(st, addr);
  st.parked = (st.parked || []).filter((a) => a !== addr);
  let sp = (st.spaces || []).find((s) => s.id === spaceId);
  if (!sp) {
    sp = { id: spaceId, name: 'folder-default', folder: '/tmp', tabs: [] };
    st.spaces = st.spaces || [];
    st.spaces.push(sp);
  }
  let tab = (sp.tabs || []).find((t) => t.id === tabId);
  if (!tab) {
    tab = { id: tabId, name: '1', terminals: [] };
    sp.tabs = sp.tabs || [];
    sp.tabs.push(tab);
  }
  if (!(tab.terminals || []).some((t) => t.terminal === addr)) {
    tab.terminals = tab.terminals || [];
    tab.terminals.push({ terminal: addr, pane: 'p1' });
  }
}

if (cmd === 'ls') {
  process.stdout.write(process.env.AF_HC_LS_JSON || JSON.stringify({ terminals: [], hidden_finished: 0 }));
  process.exit(0);
}
if (cmd === 'label') {
  const addr = process.argv[3];
  const st = load();
  st.labels = st.labels || {};
  st.labels[addr] = st.labels[addr] || {};
  for (const kv of process.argv.slice(4)) {
    const i = kv.indexOf('=');
    if (i > 0) st.labels[addr][kv.slice(0, i)] = kv.slice(i + 1);
  }
  save(st);
  process.exit(0);
}
if (cmd === 'keep') {
  const addr = process.argv[3];
  const st = load();
  adopt(st, addr);
  save(st);
  process.exit(0);
}
if (cmd === 'run' || cmd === 'send') process.exit(0);
process.exit(0);
`,
    { mode: 0o755 }
  );

  fs.writeFileSync(
    path.join(stubDir, 'herdr-app'),
    `#!/usr/bin/env node
'use strict';
const fs = require('fs');
const log = process.env.AF_HERDR_APP_LOG;
if (log) fs.appendFileSync(log, JSON.stringify({ argv: process.argv.slice(2) }) + '\\n');
const statePath = process.env.AF_HERDR_STATE;
const cmd = process.argv[2];

function load() {
  if (!statePath || !fs.existsSync(statePath)) {
    return { spaces: [], labels: {}, parked: [] };
  }
  return JSON.parse(fs.readFileSync(statePath, 'utf8'));
}
function save(st) {
  if (!statePath) return;
  fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
}
function flag(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : null;
}

if (process.env.AF_HERDR_APP_DOWN === '1') {
  process.stderr.write('herdr app not running\\n');
  process.exit(1);
}

if (cmd === 'status') process.exit(0);

if (cmd === 'ls') {
  const st = load();
  process.stdout.write(JSON.stringify({ spaces: st.spaces || [], recent: [] }));
  process.exit(0);
}

if (cmd === 'do') {
  const sub = process.argv[3];
  const st = load();
  if (sub === 'terminal.park') {
    const addr = flag('--terminal');
    for (const sp of st.spaces || []) {
      for (const tab of sp.tabs || []) {
        tab.terminals = (tab.terminals || []).filter((t) => t.terminal !== addr);
      }
    }
    st.parked = st.parked || [];
    if (addr && !st.parked.includes(addr)) st.parked.push(addr);
    save(st);
    process.stdout.write(JSON.stringify({ pending: true, terminal: addr }) + '\\n');
    process.exit(0);
  }
  if (sub === 'space.rename') {
    const id = flag('--id');
    const name = flag('--name');
    const sp = (st.spaces || []).find((s) => s.id === id);
    if (!sp) {
      process.stdout.write(JSON.stringify({ error: 'no space "' + id + '"' }) + '\\n');
      process.exit(1);
    }
    sp.name = name;
    save(st);
    process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
    process.exit(0);
  }
  if (sub === 'tab.rename') {
    const id = flag('--id');
    const name = flag('--name');
    let found = null;
    for (const sp of st.spaces || []) {
      for (const tab of sp.tabs || []) {
        if (tab.id === id) found = tab;
      }
    }
    if (!found) {
      process.stdout.write(JSON.stringify({ error: 'no tab "' + id + '"' }) + '\\n');
      process.exit(1);
    }
    if (process.env.AF_TAB_RENAME_FAIL === '1') {
      process.stderr.write('rename boom\\n');
      process.exit(1);
    }
    found.name = name;
    save(st);
    process.stdout.write(JSON.stringify({ ok: true }) + '\\n');
    process.exit(0);
  }
  process.exit(0);
}
process.exit(0);
`,
    { mode: 0o755 }
  );
}

describe('session-group space naming + adopt', () => {
  let home;
  let stubDir;
  let sessionCwd;
  let hcLog;
  let appLog;
  let statePath;

  before(() => {
    stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'af-space-stub-'));
    hcLog = path.join(stubDir, 'hc.log');
    appLog = path.join(stubDir, 'app.log');
    writeFakeBins(stubDir);
  });
  after(() => fs.rmSync(stubDir, { recursive: true, force: true }));

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'af-space-home-'));
    sessionCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'af-space-cwd-'));
    statePath = path.join(home, 'herdr-state.json');
    fs.writeFileSync(statePath, JSON.stringify({ spaces: [], labels: {}, parked: [] }));
    try {
      fs.unlinkSync(hcLog);
    } catch (_) {}
    try {
      fs.unlinkSync(appLog);
    } catch (_) {}
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(sessionCwd, { recursive: true, force: true });
  });

  function env(extra = {}) {
    return {
      ...process.env,
      AGENTFLEET_HOME: home,
      AGENTFLEET_CURSOR_BIN: path.join(stubDir, 'cursor-agent'),
      AGENTFLEET_HERDR_APP_BIN: path.join(stubDir, 'herdr-app'),
      AF_HC_LOG: hcLog,
      AF_HERDR_APP_LOG: appLog,
      AF_HERDR_STATE: statePath,
      AF_HERDR_APP_RENAME_WAIT_MS: '0',
      AF_HERDR_APP_ADOPT_WAIT_MS: '0',
      AGENTFLEET_HC_BIN: path.join(stubDir, 'hc'),
      PATH: `${stubDir}${path.delimiter}${process.env.PATH || ''}`,
      ...extra,
    };
  }
  function af(args, extra = {}) {
    return spawnSync(process.execPath, [afJs, ...args], { encoding: 'utf8', env: env(extra) });
  }
  function seed(title, extra = {}) {
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = home;
    return require('../lib/registry').add({
      title,
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: sessionCwd,
      engine: 'cursor',
      status: 'active',
      ...extra,
    });
  }
  function readHc() {
    if (!fs.existsSync(hcLog)) return [];
    return fs
      .readFileSync(hcLog, 'utf8')
      .split(/\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  function readApp() {
    if (!fs.existsSync(appLog)) return [];
    return fs
      .readFileSync(appLog, 'utf8')
      .split(/\n/)
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  }
  function readState() {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  }
  function writeState(st) {
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2));
  }

  it('adopt relabels legacy cwd space + calls space.rename and tab.rename', () => {
    const s = seed('DxS');
    const legacy = herdrapp.legacyHerdrSpaceId(sessionCwd);
    const newSpace = herdrapp.herdrSpaceId(s);
    const tab = herdrapp.herdrTabId(s);
    // Pane still sits in the legacy space in the app layout.
    writeState({
      spaces: [
        {
          id: legacy,
          name: 'old-folder',
          folder: sessionCwd,
          tabs: [{ id: tab, name: 'DxS', terminals: [{ terminal: 't1', pane: 'p0' }] }],
        },
      ],
      labels: {
        t1: { 'herdr.space': legacy, 'herdr.tab': tab },
      },
      parked: [],
    });
    const ls = JSON.stringify({
      terminals: [
        {
          address: 't1',
          name: 'dxs',
          state: 'live',
          agent: 'env',
          labels: {
            af_id: s.id,
            'herdr.space': legacy,
            'herdr.tab': tab,
          },
        },
      ],
      hidden_finished: 0,
    });
    const r = af(['adopt', s.title, '--json'], { AF_HC_LS_JSON: ls });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.ok, true);
    assert.equal(body.adopted[0].legacy, true);
    assert.equal(body.adopted[0].spaceId, newSpace);
    assert.equal(body.adopted[0].parked, true);
    assert.equal(body.adopted[0].appMove.ok, true);
    assert.equal(body.adopted[0].appMove.parked, true);
    assert.equal(body.adopted[0].appMove.from.spaceId, legacy);
    assert.equal(body.adopted[0].appMove.to.spaceId, newSpace);
    assert.equal(body.adopted[0].tabRename.ok, true);
    assert.equal(body.adopted[0].spaceRename.ok, true);

    const hc = readHc();
    const labels = hc.filter((e) => e.argv[0] === 'label');
    assert.equal(labels.length, 1);
    assert.ok(labels[0].argv.includes(`herdr.space=${newSpace}`));
    assert.ok(!labels[0].argv.includes(`herdr.space=${legacy}`));

    const app = readApp();
    assert.ok(
      app.some(
        (e) =>
          e.argv[0] === 'do' &&
          e.argv[1] === 'terminal.park' &&
          e.argv.includes('t1')
      ),
      JSON.stringify(app)
    );
    assert.ok(
      app.some(
        (e) =>
          e.argv[0] === 'do' &&
          e.argv[1] === 'space.rename' &&
          e.argv.includes(newSpace) &&
          e.argv.includes('DxS')
      ),
      JSON.stringify(app)
    );
    assert.ok(
      app.some(
        (e) =>
          e.argv[0] === 'do' && e.argv[1] === 'tab.rename' && e.argv.includes(tab) && e.argv.includes('DxS')
      ),
      JSON.stringify(app)
    );

    const st = readState();
    const target = st.spaces.find((sp) => sp.id === newSpace);
    assert.ok(target, JSON.stringify(st));
    assert.equal(target.name, 'DxS');
    assert.equal(target.tabs[0].name, 'DxS');
    assert.ok(target.tabs[0].terminals.some((t) => t.terminal === 't1'));
  });

  it('adopt parks and moves when pane is in the wrong space (human moved line)', () => {
    const s = seed('shell-live');
    const oldSpace = 'spOLDSPACE00000000000000000000000';
    const newSpace = herdrapp.herdrSpaceId(s);
    const tab = herdrapp.herdrTabId(s);
    writeState({
      spaces: [
        {
          id: oldSpace,
          name: 'af-shell-live',
          folder: sessionCwd,
          tabs: [{ id: 'tbOLD', name: '1', terminals: [{ terminal: 't1r', pane: 'p9' }] }],
        },
      ],
      labels: {},
      parked: [],
    });
    const ls = JSON.stringify({
      terminals: [
        {
          address: 't1r',
          name: 'shell-live',
          state: 'live',
          agent: 'env',
          labels: { af_id: s.id },
        },
      ],
      hidden_finished: 0,
    });
    const r = af(['adopt', s.title], { AF_HC_LS_JSON: ls });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stdout, /moved t1r shell-live: af-shell-live → shell-live/);
    const st = readState();
    const target = st.spaces.find((sp) => sp.id === newSpace);
    assert.ok(target);
    assert.equal(target.name, 'shell-live');
    assert.ok(target.tabs.some((t) => t.id === tab && t.name === 'shell-live'));
  });

  it('adopt --all skips label/keep for already-correct terminals but may rename', () => {
    const s = seed('AlreadyOk');
    const space = herdrapp.herdrSpaceId(s);
    const tab = herdrapp.herdrTabId(s);
    writeState({
      spaces: [
        {
          id: space,
          name: 'folder-default',
          folder: sessionCwd,
          tabs: [{ id: tab, name: '1', terminals: [{ terminal: 't9', pane: 'p1' }] }],
        },
      ],
      labels: { t9: { 'herdr.space': space, 'herdr.tab': tab } },
      parked: [],
    });
    const ls = JSON.stringify({
      terminals: [
        {
          address: 't9',
          name: 'alreadyok',
          state: 'live',
          agent: 'env',
          labels: {
            af_id: s.id,
            'herdr.space': space,
            'herdr.tab': tab,
          },
        },
      ],
      hidden_finished: 0,
    });
    const r = af(['adopt', '--all', '--json'], { AF_HC_LS_JSON: ls });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.adopted[0].alreadyAdopted, true);
    assert.equal(body.adopted[0].appMove.parked, false);
    const hc = readHc().filter((e) => e.argv[0] === 'label' || e.argv[0] === 'keep');
    assert.equal(hc.length, 0, JSON.stringify(hc));
    assert.equal(readState().spaces.find((sp) => sp.id === space).name, 'AlreadyOk');
  });

  it('adopt --dry-run lists park/label/keep/renames and makes none', () => {
    const s = seed('DryAdopt');
    const oldSpace = 'spDRYOLD000000000000000000000000';
    const newSpace = herdrapp.herdrSpaceId(s);
    const tab = herdrapp.herdrTabId(s);
    writeState({
      spaces: [
        {
          id: oldSpace,
          name: 'old',
          folder: sessionCwd,
          tabs: [{ id: 'tbx', name: '1', terminals: [{ terminal: 't3' }] }],
        },
      ],
      labels: {},
      parked: [],
    });
    const ls = JSON.stringify({
      terminals: [
        {
          address: 't3',
          name: 'dry',
          state: 'live',
          agent: 'env',
          labels: { af_id: s.id },
        },
      ],
      hidden_finished: 0,
    });
    const r = af(['adopt', s.title, '--dry-run', '--json'], { AF_HC_LS_JSON: ls });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.dryRun, true);
    const steps = body.adopted[0].steps.map((s) => s.join(' '));
    assert.ok(steps.some((x) => x.includes('terminal.park') && x.includes('t3')), JSON.stringify(steps));
    assert.ok(steps.some((x) => x.startsWith('hc label')), JSON.stringify(steps));
    assert.ok(steps.some((x) => x.startsWith('hc keep')), JSON.stringify(steps));
    assert.ok(steps.some((x) => x.includes('space.rename') && x.includes(newSpace)), JSON.stringify(steps));
    assert.ok(steps.some((x) => x.includes('tab.rename') && x.includes(tab)), JSON.stringify(steps));
    assert.equal(
      readHc().filter((e) => ['label', 'keep', 'run', 'send'].includes(e.argv[0])).length,
      0
    );
    assert.equal(readApp().filter((e) => e.argv[0] === 'do').length, 0);
  });

  it('AGENTFLEET_HERDR_NAMES=0 skips renames on adopt', () => {
    const s = seed('NoNames');
    const ls = JSON.stringify({
      terminals: [
        {
          address: 't4',
          name: 'nonames',
          state: 'live',
          agent: 'env',
          labels: { af_id: s.id },
        },
      ],
      hidden_finished: 0,
    });
    const r = af(['adopt', s.title, '--json'], {
      AF_HC_LS_JSON: ls,
      AGENTFLEET_HERDR_NAMES: '0',
    });
    assert.equal(r.status, 0, r.stderr);
    const body = JSON.parse(r.stdout);
    assert.equal(body.adopted[0].tabRename.skipped, true);
    assert.equal(body.adopted[0].spaceRename.skipped, true);
    assert.equal(readApp().filter((e) => e.argv[0] === 'do' && e.argv[1] !== 'terminal.park').length, 0);
    assert.ok(readHc().some((e) => e.argv[0] === 'label'));
  });

  it('adopt when herdr-app is down: label+keep only, appMove skipped', () => {
    const s = seed('NoApp');
    const ls = JSON.stringify({
      terminals: [
        {
          address: 't5',
          name: 'noapp',
          state: 'live',
          agent: 'env',
          labels: { af_id: s.id },
        },
      ],
      hidden_finished: 0,
    });
    const r = af(['adopt', s.title, '--json'], {
      AF_HC_LS_JSON: ls,
      AF_HERDR_APP_DOWN: '1',
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const body = JSON.parse(r.stdout);
    assert.equal(body.adopted[0].labeled, true);
    assert.equal(body.adopted[0].kept, true);
    assert.equal(body.adopted[0].appMove.ok, false);
    assert.equal(body.adopted[0].appMove.skipped, true);
    assert.equal(body.adopted[0].appMove.reason, 'herdr app not running');
    assert.ok(body.adopted[0].appMove.hint);
    assert.equal(body.adopted[0].tabRename.skipped, true);
  });

  it('resume launch waits then renames space/tab after adopt into new space', () => {
    const s = seed('LaunchSpace');
    // Simulate app: empty layout until hc keep/run would adopt — for resume we
    // only get hc run; fake hc run does not auto-adopt. Seed the target space
    // so waitForSpace sees it (as the real app would after keep labels).
    const space = herdrapp.herdrSpaceId(s);
    const tab = herdrapp.herdrTabId(s);
    writeState({
      spaces: [
        {
          id: space,
          name: path.basename(sessionCwd),
          folder: sessionCwd,
          tabs: [{ id: tab, name: '1', terminals: [{ terminal: 'tNew' }] }],
        },
      ],
      labels: {},
      parked: [],
    });
    const r = af(['resume', s.title, '--via', 'herdr', '--no-open'], {
      AF_HC_LS_JSON: JSON.stringify({ terminals: [], hidden_finished: 0 }),
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const runs = readHc().filter((e) => e.argv[0] === 'run');
    assert.equal(runs.length, 1);
    assert.ok(runs[0].argv.includes(`herdr.space=${space}`));
    const st = readState();
    assert.equal(st.spaces.find((sp) => sp.id === space).name, 'LaunchSpace');
    assert.equal(st.spaces[0].tabs[0].name, 'LaunchSpace');
  });

  it('resume rename failures are non-fatal', () => {
    const s = seed('LaunchFail');
    // No matching space in layout → space.rename fails after wait
    writeState({ spaces: [], labels: {}, parked: [] });
    const r = af(['resume', s.title, '--via', 'herdr', '--no-open'], {
      AF_HC_LS_JSON: JSON.stringify({ terminals: [], hidden_finished: 0 }),
    });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stderr, /space\.rename failed|tab\.rename failed/);
  });
});

describe('herdrapp layout parse + planAdoptMove + executeAdoptItem', () => {
  it('parseHerdrAppLs + findTerminalPlacement are defensive', () => {
    const spaces = herdrapp.parseHerdrAppLs(
      JSON.stringify({
        spaces: [
          {
            id: 'sp1',
            name: 'A',
            tabs: [{ id: 'tb1', name: 'T', terminals: [{ terminal: 't1r', pane: 'p' }] }],
          },
        ],
      })
    );
    assert.equal(spaces.length, 1);
    const p = herdrapp.findTerminalPlacement(spaces, 't1r');
    assert.deepEqual(p, {
      spaceId: 'sp1',
      spaceName: 'A',
      tabId: 'tb1',
      tabName: 'T',
      terminal: 't1r',
    });
    assert.equal(herdrapp.parseHerdrAppLs('not-json'), null);
    const viaPanes = herdrapp.parseHerdrAppLs(
      JSON.stringify({
        spaces: [{ id: 'sp2', tabs: [{ id: 'tb2', panes: [{ address: 't9' }] }] }],
      })
    );
    assert.equal(herdrapp.findTerminalPlacement(viaPanes, 't9').spaceId, 'sp2');
  });

  it('planAdoptMove includes park when placement is wrong space', () => {
    const item = {
      address: 't1r',
      spaceId: 'spNEW',
      tabId: 'tbNEW',
      title: 'shell-live',
      spaceTitle: 'shell-live',
      alreadyAdopted: false,
      labelArgv: ['label', 't1r', 'herdr.space=spNEW', 'herdr.tab=tbNEW'],
      keepArgv: ['keep', 't1r'],
    };
    const planned = herdrapp.planAdoptMove(item, {
      appRunning: true,
      placement: { spaceId: 'spOLD', spaceName: 'af-shell-live', tabId: 'tbOLD', tabName: '1' },
      env: {},
    });
    assert.equal(planned.needPark, true);
    assert.ok(planned.steps.some((s) => s.includes('terminal.park')));
  });

  it('executeAdoptItem parks, keeps, renames via injectable runners', () => {
    const spaceId = 'spTARGET';
    const tabId = 'tbTARGET';
    let spaces = [
      {
        id: 'spOLD',
        name: 'old-name',
        tabs: [{ id: 'tbOLD', name: '1', terminals: [{ terminal: 't1r' }] }],
      },
    ];
    const labels = {};
    const item = {
      title: 'shell-live',
      id: 'sid',
      address: 't1r',
      name: 'shell-live',
      spaceId,
      tabId,
      spaceTitle: 'shell-live',
      alreadyAdopted: false,
      legacy: false,
      labelArgv: ['label', 't1r', `herdr.space=${spaceId}`, `herdr.tab=${tabId}`],
      keepArgv: ['keep', 't1r'],
    };

    const row = herdrapp.executeAdoptItem(item, {
      maxWaitMs: 0,
      intervalMs: 10,
      sleep: () => {},
      runApp: (argv) => {
        if (argv[0] === 'status') return { status: 0, stdout: '', stderr: '' };
        if (argv[0] === 'ls') {
          return { status: 0, stdout: JSON.stringify({ spaces }), stderr: '' };
        }
        if (argv[0] === 'do' && argv[1] === 'terminal.park') {
          for (const sp of spaces) {
            for (const tab of sp.tabs || []) {
              tab.terminals = (tab.terminals || []).filter((t) => t.terminal !== 't1r');
            }
          }
          return { status: 0, stdout: '{"pending":true}', stderr: '' };
        }
        if (argv[0] === 'do' && argv[1] === 'space.rename') {
          const id = argv[argv.indexOf('--id') + 1];
          const name = argv[argv.indexOf('--name') + 1];
          const sp = spaces.find((s) => s.id === id);
          if (!sp) return { status: 1, stdout: JSON.stringify({ error: 'no space' }), stderr: '' };
          sp.name = name;
          return { status: 0, stdout: '{"ok":true}', stderr: '' };
        }
        if (argv[0] === 'do' && argv[1] === 'tab.rename') {
          const id = argv[argv.indexOf('--id') + 1];
          const name = argv[argv.indexOf('--name') + 1];
          for (const sp of spaces) {
            for (const tab of sp.tabs || []) {
              if (tab.id === id) tab.name = name;
            }
          }
          return { status: 0, stdout: '{"ok":true}', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'unknown' };
      },
      runHc: (argv) => {
        if (argv[0] === 'label') {
          labels.t1r = {
            'herdr.space': argv.find((a) => a.startsWith('herdr.space=')).split('=')[1],
            'herdr.tab': argv.find((a) => a.startsWith('herdr.tab=')).split('=')[1],
          };
          return { status: 0, stdout: '', stderr: '' };
        }
        if (argv[0] === 'keep') {
          spaces = [
            {
              id: spaceId,
              name: 'folder-default',
              tabs: [{ id: tabId, name: '1', terminals: [{ terminal: 't1r' }] }],
            },
          ];
          return { status: 0, stdout: '', stderr: '' };
        }
        return { status: 1, stdout: '', stderr: 'bad hc' };
      },
      env: {},
    });

    assert.equal(row.ok, true);
    assert.equal(row.parked, true);
    assert.equal(row.labeled, true);
    assert.equal(row.kept, true);
    assert.equal(row.appMove.ok, true);
    assert.equal(row.appMove.parked, true);
    assert.equal(row.appMove.from.spaceName, 'old-name');
    assert.equal(row.spaceRename.ok, true);
    assert.equal(row.tabRename.ok, true);
    assert.equal(spaces[0].name, 'shell-live');
    assert.equal(spaces[0].tabs[0].name, 'shell-live');
  });
});
