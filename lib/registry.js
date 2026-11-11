'use strict';

const fs = require('fs');
const path = require('path');
const { fleetDir, registryPath, nowIso, makeId } = require('./util');

const STATUSES = new Set(['active', 'paused', 'done']);
const ENGINES = new Set(['cursor', 'copilot']);

function emptyRegistry() {
  return { version: 1, sessions: [] };
}

function ensureDir() {
  const dir = fleetDir();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function load() {
  const p = registryPath();
  if (!fs.existsSync(p)) return emptyRegistry();
  const raw = fs.readFileSync(p, 'utf8');
  if (!raw.trim()) return emptyRegistry();
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.sessions)) {
    throw new Error(`Invalid registry at ${p}: expected { sessions: [] }`);
  }
  return data;
}

/**
 * Atomic write: temp file in same directory then rename.
 */
function save(data) {
  ensureDir();
  const p = registryPath();
  const dir = path.dirname(p);
  const tmp = path.join(dir, `.sessions.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
}

function normalizeEntry(partial) {
  const now = nowIso();
  const title = String(partial.title || '').trim();
  if (!title) throw new Error('title is required');
  if (!partial.chatId) throw new Error('chatId is required');

  const status = partial.status || 'active';
  if (!STATUSES.has(status)) {
    throw new Error(`invalid status: ${status}`);
  }
  const engine = partial.engine || 'cursor';
  if (!ENGINES.has(engine)) {
    throw new Error(`invalid engine: ${engine} (want cursor or copilot)`);
  }

  const entry = {
    id: partial.id || makeId(title),
    title,
    chatId: String(partial.chatId).trim(),
    cwd: partial.cwd ? path.resolve(partial.cwd) : process.cwd(),
    branch: partial.branch ?? null,
    model: partial.model ?? null,
    engine,
    created: partial.created || now,
    lastUsed: partial.lastUsed || now,
    status,
    tags: Array.isArray(partial.tags) ? partial.tags.map(String) : [],
    notes: partial.notes != null ? String(partial.notes) : '',
    prompt: partial.prompt != null ? String(partial.prompt) : '',
    lastRunAt: partial.lastRunAt || null,
    lastExit: partial.lastExit != null ? partial.lastExit : null,
    lastOutput: partial.lastOutput || null,
    lastPrompt: partial.lastPrompt != null ? String(partial.lastPrompt) : '',
  };
  if (partial.herdr != null && typeof partial.herdr === 'object' && !Array.isArray(partial.herdr)) {
    entry.herdr = { ...partial.herdr };
  }
  return entry;
}

function list(opts = {}) {
  const data = load();
  let sessions = data.sessions.slice();
  if (opts.status) {
    sessions = sessions.filter((s) => s.status === opts.status);
  }
  if (opts.tag) {
    sessions = sessions.filter((s) => (s.tags || []).includes(opts.tag));
  }
  if (opts.includeDone === false) {
    sessions = sessions.filter((s) => s.status !== 'done');
  }
  sessions.sort((a, b) => String(b.lastUsed).localeCompare(String(a.lastUsed)));
  return sessions;
}

function find(query) {
  if (!query) return null;
  const q = String(query).toLowerCase();
  const sessions = load().sessions;
  // Exact id or chatId first
  let hit = sessions.find((s) => s.id === query || s.chatId === query);
  if (hit) return hit;
  // Exact title
  hit = sessions.find((s) => s.title.toLowerCase() === q);
  if (hit) return hit;
  // Prefix id / short id
  hit = sessions.find(
    (s) =>
      s.id.toLowerCase().startsWith(q) ||
      s.chatId.toLowerCase().startsWith(q)
  );
  if (hit) return hit;
  // Title contains
  const matches = sessions.filter((s) => s.title.toLowerCase().includes(q));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const err = new Error(
      `ambiguous match for "${query}": ${matches.map((m) => m.title).join(', ')}`
    );
    err.code = 'AMBIGUOUS';
    err.matches = matches;
    throw err;
  }
  return null;
}

function add(partial) {
  const data = load();
  const entry = normalizeEntry(partial);
  if (data.sessions.some((s) => s.id === entry.id)) {
    throw new Error(`session id already exists: ${entry.id}`);
  }
  if (data.sessions.some((s) => s.chatId === entry.chatId)) {
    throw new Error(`chatId already registered: ${entry.chatId}`);
  }
  data.sessions.push(entry);
  save(data);
  return entry;
}

function update(query, patch) {
  const data = load();
  const current = find(query);
  if (!current) throw new Error(`session not found: ${query}`);
  const idx = data.sessions.findIndex((s) => s.id === current.id);
  const next = { ...data.sessions[idx], ...patch };
  if (patch.status && !STATUSES.has(patch.status)) {
    throw new Error(`invalid status: ${patch.status}`);
  }
  if (patch.engine && !ENGINES.has(patch.engine)) {
    throw new Error(`invalid engine: ${patch.engine} (want cursor or copilot)`);
  }
  if (patch.title != null) next.title = String(patch.title).trim();
  if (patch.notes != null) next.notes = String(patch.notes);
  if (patch.tags != null) next.tags = Array.isArray(patch.tags) ? patch.tags.map(String) : [];
  data.sessions[idx] = next;
  save(data);
  return next;
}

function touch(query) {
  return update(query, { lastUsed: nowIso() });
}

function remove(query) {
  const data = load();
  const current = find(query);
  if (!current) throw new Error(`session not found: ${query}`);
  data.sessions = data.sessions.filter((s) => s.id !== current.id);
  save(data);
  return current;
}

function exportAll() {
  return load();
}

function importAll(payload, { merge = true } = {}) {
  if (!payload || !Array.isArray(payload.sessions)) {
    throw new Error('import file must contain { sessions: [] }');
  }
  if (!merge) {
    const data = { version: 1, sessions: payload.sessions.map((s) => normalizeEntry(s)) };
    save(data);
    return data;
  }
  const data = load();
  const byChat = new Map(data.sessions.map((s) => [s.chatId, s]));
  const byId = new Map(data.sessions.map((s) => [s.id, s]));
  let added = 0;
  let updated = 0;
  for (const raw of payload.sessions) {
    const entry = normalizeEntry(raw);
    if (byChat.has(entry.chatId)) {
      const existing = byChat.get(entry.chatId);
      const idx = data.sessions.findIndex((s) => s.id === existing.id);
      data.sessions[idx] = { ...existing, ...entry, id: existing.id };
      updated++;
    } else if (byId.has(entry.id)) {
      entry.id = makeId(entry.title);
      data.sessions.push(entry);
      added++;
    } else {
      data.sessions.push(entry);
      added++;
    }
  }
  save(data);
  return { added, updated, total: data.sessions.length };
}

module.exports = {
  STATUSES,
  ENGINES,
  load,
  save,
  list,
  find,
  add,
  update,
  touch,
  remove,
  exportAll,
  importAll,
  normalizeEntry,
  emptyRegistry,
  ensureDir,
};
