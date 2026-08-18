'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const safeLog = (...args: any[]) => _deps.logger?.safeLog?.(...args) ?? log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);
const CONFIG = require('./get-config');

const fs = require('fs');
const path = require('path');

const _os = require('os');
const _CHECKPOINT_PATH = (() => {
  // Priority: env var > config > /tmp default
  let p = process.env.CHECKPOINT_FILE || (CONFIG && CONFIG.CHECKPOINT_FILE) || '';
  if (!p) p = path.join(_os.tmpdir(), 'checkpoint.json');
  // v12-FIX: Ensure absolute path. On Render, the source dir is read-only
  // and a relative 'checkpoint.json' would fail with EACCES.
  if (!path.isAbsolute(p)) {
    p = path.join(_os.tmpdir(), p);
  }
  return p;
})();

function saveCheckpoint(data: any) { 
  const tmp = _CHECKPOINT_PATH + '.tmp';
  try {
    const json = JSON.stringify({ ...data, savedAt: Date.now() }, null, 2);
    if (json.length > 5 * 1024 * 1024) { log('Checkpoint data too large, skipping', 'WARN', 'state-persist'); return; }
    fs.writeFileSync(tmp, json); fs.renameSync(tmp, _CHECKPOINT_PATH);
  } catch (e: any) { logError('Checkpoint save failed', e); }
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(_CHECKPOINT_PATH)) {
      const stats = fs.statSync(_CHECKPOINT_PATH);
      if (stats.size > 5 * 1024 * 1024) {
        log('Checkpoint file too large, skipping load', 'WARN', 'state-persist');
        return null;
      }
      return JSON.parse(fs.readFileSync(_CHECKPOINT_PATH, 'utf8'));
    }
  } catch (e: any) { if (fs.existsSync(_CHECKPOINT_PATH)) { console.warn('Checkpoint file exists but could not be parsed:', e.message); } }
  return null;
}

module.exports = { saveCheckpoint, loadCheckpoint, _injectDependencies };
