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

const CHECKPOINT_FILE = CONFIG.CHECKPOINT_FILE || './checkpoint.json';

function saveCheckpoint(data: any) { 
  const tmp = CHECKPOINT_FILE + '.tmp';
  try {
    const json = JSON.stringify({ ...data, savedAt: Date.now() }, null, 2);
    if (json.length > 5 * 1024 * 1024) { log('Checkpoint data too large, skipping', 'WARN', 'state-persist'); return; }
    fs.writeFileSync(tmp, json); fs.renameSync(tmp, CHECKPOINT_FILE);
  } catch (e: any) { logError('Checkpoint save failed', e); }
}

function loadCheckpoint() {
  try {
    if (fs.existsSync(CHECKPOINT_FILE)) {
      const stats = fs.statSync(CHECKPOINT_FILE);
      if (stats.size > 5 * 1024 * 1024) {
        log('Checkpoint file too large, skipping load', 'WARN', 'state-persist');
        return null;
      }
      return JSON.parse(fs.readFileSync(CHECKPOINT_FILE, 'utf8'));
    }
  } catch (e: any) { if (fs.existsSync(CHECKPOINT_FILE)) { console.warn('Checkpoint file exists but could not be parsed:', e.message); } }
  return null;
}

module.exports = { saveCheckpoint, loadCheckpoint, _injectDependencies };
