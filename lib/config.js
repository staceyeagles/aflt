'use strict';

const fs = require('fs');
const path = require('path');
const { fleetDir } = require('./util');

const ENGINES = new Set(['cursor', 'copilot', 'opencode']);

function configPath() {
  return path.join(fleetDir(), 'config.json');
}

function emptyConfig() {
  return {};
}

/**
 * Load `$AGENTFLEET_HOME/config.json`. Missing or corrupt files yield {}.
 * Never throws for I/O/parse errors.
 */
function load() {
  const p = configPath();
  try {
    if (!fs.existsSync(p)) return emptyConfig();
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return emptyConfig();
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return emptyConfig();
    return data;
  } catch (_) {
    return emptyConfig();
  }
}

/**
 * Atomic write: temp file in same directory then rename.
 */
function save(data) {
  const dir = fleetDir();
  fs.mkdirSync(dir, { recursive: true });
  const p = configPath();
  const tmp = path.join(dir, `.config.${process.pid}.${Date.now()}.tmp`);
  const payload = JSON.stringify(data, null, 2) + '\n';
  fs.writeFileSync(tmp, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, p);
}

function validateEngine(value) {
  const engine = String(value || '').trim();
  if (!ENGINES.has(engine)) {
    throw new Error(`invalid engine: ${value} (want cursor, copilot, or opencode)`);
  }
  return engine;
}

/**
 * Persist defaultEngine in config.json. Returns the stored value.
 */
function setDefaultEngine(value) {
  const engine = validateEngine(value);
  const data = load();
  data.defaultEngine = engine;
  save(data);
  return engine;
}

/**
 * Read defaultEngine from config only (no env/flag). Invalid values ignored.
 */
function getDefaultEngineFromConfig() {
  const data = load();
  const raw = data.defaultEngine;
  if (raw == null || raw === '') return null;
  try {
    return validateEngine(raw);
  } catch (_) {
    return null;
  }
}

module.exports = {
  ENGINES,
  configPath,
  load,
  save,
  validateEngine,
  setDefaultEngine,
  getDefaultEngineFromConfig,
};
