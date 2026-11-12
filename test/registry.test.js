'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

let tmp;
let registry;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agentfleet-'));
  process.env.AGENTFLEET_HOME = tmp;
  // Fresh module load so paths pick up env
  delete require.cache[require.resolve('../lib/util')];
  delete require.cache[require.resolve('../lib/registry')];
  registry = require('../lib/registry');
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
  delete process.env.AGENTFLEET_HOME;
});

describe('registry', () => {
  it('starts empty', () => {
    assert.deepEqual(registry.list(), []);
  });

  it('adds and lists a session', () => {
    const s = registry.add({
      title: 'Auth refactor',
      chatId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
      cwd: tmp,
      branch: 'main',
      model: 'gpt-5',
      prompt: 'refactor auth',
      tags: ['api'],
    });
    assert.equal(s.title, 'Auth refactor');
    assert.ok(s.id);
    assert.equal(s.status, 'active');
    const listed = registry.list();
    assert.equal(listed.length, 1);
    assert.equal(listed[0].chatId, s.chatId);
  });

  it('writes atomically via temp+rename', () => {
    registry.add({
      title: 'One',
      chatId: '11111111-1111-1111-1111-111111111111',
      cwd: tmp,
    });
    const p = path.join(tmp, 'sessions.json');
    assert.ok(fs.existsSync(p));
    const raw = fs.readFileSync(p, 'utf8');
    const data = JSON.parse(raw);
    assert.equal(data.sessions.length, 1);
    // no leftover temps
    const leftovers = fs.readdirSync(tmp).filter((f) => f.includes('.tmp'));
    assert.deepEqual(leftovers, []);
  });

  it('finds by title, id prefix, and chatId', () => {
    const s = registry.add({
      title: 'Payments',
      chatId: '22222222-2222-2222-2222-222222222222',
      cwd: tmp,
    });
    assert.equal(registry.find('Payments').id, s.id);
    assert.equal(registry.find(s.id).id, s.id);
    assert.equal(registry.find(s.id.slice(0, 8)).id, s.id);
    assert.equal(registry.find(s.chatId).id, s.id);
    assert.equal(registry.find('nope'), null);
  });

  it('renames, notes, done, remove', () => {
    const s = registry.add({
      title: 'Old',
      chatId: '33333333-3333-3333-3333-333333333333',
      cwd: tmp,
    });
    registry.update(s.id, { title: 'New' });
    assert.equal(registry.find(s.id).title, 'New');
    registry.update(s.id, { notes: 'hello' });
    assert.equal(registry.find(s.id).notes, 'hello');
    registry.update(s.id, { status: 'done' });
    assert.equal(registry.list({ includeDone: false }).length, 0);
    assert.equal(registry.list({ status: 'done' }).length, 1);
    registry.remove(s.id);
    assert.equal(registry.list({ includeDone: true }).length, 0);
  });

  it('rejects duplicate chatId', () => {
    registry.add({
      title: 'A',
      chatId: '44444444-4444-4444-4444-444444444444',
      cwd: tmp,
    });
    assert.throws(
      () =>
        registry.add({
          title: 'B',
          chatId: '44444444-4444-4444-4444-444444444444',
          cwd: tmp,
        }),
      /already registered/
    );
  });

  it('export and import-file merge', () => {
    registry.add({
      title: 'Keep',
      chatId: '55555555-5555-5555-5555-555555555555',
      cwd: tmp,
    });
    const exported = registry.exportAll();
    const other = {
      version: 1,
      sessions: [
        {
          title: 'Imported',
          chatId: '66666666-6666-6666-6666-666666666666',
          cwd: tmp,
          status: 'active',
        },
        {
          title: 'Keep updated',
          chatId: '55555555-5555-5555-5555-555555555555',
          cwd: tmp,
          status: 'paused',
          notes: 'from backup',
        },
      ],
    };
    const result = registry.importAll(other, { merge: true });
    assert.equal(result.added, 1);
    assert.equal(result.updated, 1);
    assert.equal(registry.find('Imported').chatId, '66666666-6666-6666-6666-666666666666');
    assert.equal(registry.find('Keep').status, 'paused');
    assert.equal(exported.sessions.length, 1);
  });

  it('filters by tag', () => {
    registry.add({
      title: 'Tagged',
      chatId: '77777777-7777-7777-7777-777777777777',
      cwd: tmp,
      tags: ['fleet'],
    });
    registry.add({
      title: 'Other',
      chatId: '88888888-8888-8888-8888-888888888888',
      cwd: tmp,
      tags: ['solo'],
    });
    assert.equal(registry.list({ tag: 'fleet' }).length, 1);
    assert.equal(registry.list({ tag: 'fleet' })[0].title, 'Tagged');
  });

  it('normalizes orchestrator fields and defaults worker/master result path', () => {
    const master = registry.add({
      title: 'Master',
      chatId: 'aaaaaaaa-1111-1111-1111-111111111111',
      cwd: tmp,
      role: 'master',
    });
    assert.equal(master.role, 'master');
    assert.equal(master.parent, null);
    assert.equal(master.task, '');
    assert.equal(master.result, path.join(tmp, 'results', `${master.id}.md`));
    assert.equal(master.plan, path.join(tmp, 'plans', `${master.id}.md`));
    assert.equal(master.workerStatus, null);

    const worker = registry.add({
      title: 'Master-w1',
      chatId: 'bbbbbbbb-2222-2222-2222-222222222222',
      cwd: tmp,
      parent: master.id,
      role: 'worker',
      task: 'do thing',
      workerStatus: 'queued',
    });
    assert.equal(worker.parent, master.id);
    assert.equal(worker.role, 'worker');
    assert.equal(worker.task, 'do thing');
    assert.equal(worker.workerStatus, 'queued');
    assert.equal(worker.result, path.join(tmp, 'results', `${worker.id}.md`));
  });

  it('loads old rows without orchestrator fields unchanged', () => {
    const p = path.join(tmp, 'sessions.json');
    fs.writeFileSync(
      p,
      JSON.stringify({
        version: 1,
        sessions: [
          {
            id: 'legacy-1',
            title: 'Legacy',
            chatId: 'cccccccc-3333-3333-3333-333333333333',
            cwd: tmp,
            engine: 'cursor',
            status: 'active',
            created: '2026-01-01T00:00:00.000Z',
            lastUsed: '2026-01-01T00:00:00.000Z',
            tags: [],
            notes: '',
            prompt: '',
          },
        ],
      }) + '\n',
      'utf8'
    );
    const s = registry.find('Legacy');
    assert.equal(s.id, 'legacy-1');
    assert.equal(s.parent, undefined);
    assert.equal(s.role, undefined);
    assert.equal(s.workerStatus, undefined);
  });

  it('rejects invalid role and workerStatus', () => {
    assert.throws(
      () =>
        registry.add({
          title: 'Bad role',
          chatId: 'dddddddd-4444-4444-4444-444444444444',
          cwd: tmp,
          role: 'boss',
        }),
      /invalid role/
    );
    const s = registry.add({
      title: 'Ok',
      chatId: 'eeeeeeee-5555-5555-5555-555555555555',
      cwd: tmp,
    });
    assert.throws(() => registry.update(s.id, { workerStatus: 'nope' }), /invalid workerStatus/);
  });

  it('breaks a stale lock (old mtime + dead pid) and add succeeds', () => {
    registry.ensureDir();
    const lp = registry.lockPath();
    fs.writeFileSync(lp, `999999999\n${os.hostname()}\n${new Date().toISOString()}\n`, 'utf8');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lp, old, old);
    const s = registry.add({
      title: 'After-stale',
      chatId: 'ffffffff-6666-4666-8666-666666666666',
      cwd: tmp,
    });
    assert.equal(s.title, 'After-stale');
    assert.ok(!fs.existsSync(lp), 'lock should be released after add');
  });

  it('breaks a recent lock held by a dead pid on this host', () => {
    registry.ensureDir();
    const lp = registry.lockPath();
    fs.writeFileSync(lp, `999999999\n${os.hostname()}\n${new Date().toISOString()}\n`, 'utf8');
    const s = registry.add({
      title: 'After-dead-pid',
      chatId: 'ffffffff-7777-4777-8777-777777777777',
      cwd: tmp,
    });
    assert.equal(s.title, 'After-dead-pid');
    assert.ok(!fs.existsSync(lp));
  });

  it('concurrent child processes add with autoTitle without losing rows', async () => {
    const parent = registry.add({
      title: 'RaceMaster',
      chatId: 'aaaaaaaa-8888-4888-8888-888888888888',
      cwd: tmp,
      role: 'master',
    });
    const n = 8;
    const registryPath = path.join(__dirname, '..', 'lib', 'registry.js');
    const children = [];
    for (let i = 0; i < n; i++) {
      const chatId = `bbbbbbbb-9999-4999-8999-${String(i).padStart(12, '0')}`;
      const code = `
        process.env.AGENTFLEET_HOME = ${JSON.stringify(tmp)};
        const registry = require(${JSON.stringify(registryPath)});
        const entry = registry.add(
          {
            title: 'placeholder',
            chatId: ${JSON.stringify(chatId)},
            cwd: ${JSON.stringify(tmp)},
            parent: ${JSON.stringify(parent.id)},
            role: 'worker',
            task: 't${i}',
            workerStatus: 'queued',
          },
          { autoTitle: { parentTitle: ${JSON.stringify(parent.title)}, parentId: ${JSON.stringify(parent.id)} } }
        );
        process.stdout.write(JSON.stringify({ id: entry.id, title: entry.title }) + '\\n');
      `;
      children.push(
        new Promise((resolve, reject) => {
          const child = spawn(process.execPath, ['-e', code], {
            encoding: 'utf8',
            env: { ...process.env, AGENTFLEET_HOME: tmp },
          });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (b) => {
            stdout += b;
          });
          child.stderr.on('data', (b) => {
            stderr += b;
          });
          child.on('error', reject);
          child.on('close', (status) => {
            resolve({ status, stdout, stderr, chatId });
          });
        })
      );
    }
    const results = await Promise.all(children);
    for (const r of results) {
      assert.equal(r.status, 0, r.stderr || r.stdout);
    }
    // Reload module against same home
    delete require.cache[require.resolve('../lib/util')];
    delete require.cache[require.resolve('../lib/orchestrate')];
    delete require.cache[require.resolve('../lib/registry')];
    process.env.AGENTFLEET_HOME = tmp;
    const fresh = require('../lib/registry');
    const workers = fresh
      .list({ includeDone: true })
      .filter((s) => s.parent === parent.id);
    assert.equal(workers.length, n, JSON.stringify(workers.map((w) => w.title)));
    const ids = new Set(workers.map((w) => w.id));
    const titles = new Set(workers.map((w) => w.title));
    assert.equal(ids.size, n);
    assert.equal(titles.size, n);
    for (const w of workers) {
      assert.ok(/^RaceMaster-w\d+$/.test(w.title), w.title);
    }
  });
});
