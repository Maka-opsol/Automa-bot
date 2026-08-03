'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }
function getInsertBlackbox() { return _deps.database?.insertBlackbox; }
function getGetBlackbox() { return _deps.database?.getBlackbox; }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

class BlackBoxRecorder {
  maxEntries: any;

  constructor() {
    this.maxEntries = CONFIG.BLACKBOX_MAX_ENTRIES || 50;
  }

  record(entry: any) { 
    if (!CONFIG.ENABLE_BLACKBOX) return;
    try {
      const { insertBlackbox } = require('./database');
      getInsertBlackbox()?.run(Date.now(), entry.state || '', entry.action || '', entry.semantics || '{}', entry.hash || '', entry.success ? 1 : 0, entry.reasoning || '', entry.latency || 0, entry.provider_used || '');
      const count = getDb()?.prepare('SELECT COUNT(*) as c FROM blackbox').get().c;
      if (count > this.maxEntries) {
        const toDelete = count - this.maxEntries;
        getDb()?.prepare(`DELETE FROM blackbox WHERE id IN (SELECT id FROM blackbox ORDER BY timestamp ASC LIMIT ?)`).run(toDelete);
      }
    } catch (e: any) { logError('Blackbox record failed', e); }
  }

  getRecent() { 
    try {
      const { getBlackbox } = require('./database');
      return getGetBlackbox()?.all(this.maxEntries);
    } catch (e: any) { return []; }
  }
}

module.exports = Object.assign(new BlackBoxRecorder(), { _injectDependencies });
