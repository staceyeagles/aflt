'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
});
