'use strict';

/**
 * Reward tracker — lightweight proxy that delegates to the
 * reward-tracker-worker thread via the worker manager.
 *
 * If the worker manager is unavailable (e.g. during early init or tests),
 * operations silently no-op and return safe defaults.
 */

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; _ensureLogger(); }

let _workerMgr: any = null;
let _loggerReady = false;
let _log: (msg: string, level?: string) => void = (msg, level) => console.log(`[${level || 'WARN'}] ${msg}`);

function _ensureLogger() {
  if (_loggerReady) return;
  _loggerReady = true;
  if (_deps.logger) { _log = _deps.logger.log; return; }
  try { const logger = require('./logger'); _log = logger.log; } catch (_: any) { /* keep console fallback */ }
}

function _getMgr() {
  if (!_workerMgr) {
    try { _workerMgr = require('./workers').workerManager; } catch (_: any) { /* unavailable */ }
  }
  _ensureLogger();
  return _workerMgr;
}

function recordStagingResult(modelName: string, patchId: string, passed: number): boolean {
  try {
    const mgr = _getMgr();
    if (mgr && typeof mgr.callWorker === 'function') {
      mgr.callWorker('reward-tracker', 'recordStagingResult', { modelName, patchId, passed });
      return true;
    }
    _log(`[reward-tracker] Worker unavailable — skipping recordStagingResult(${modelName}, ${patchId})`, 'WARN');
  } catch (_: any) { _log(`[reward-tracker] Worker error in recordStagingResult: ${_?.message || _}`, 'WARN'); }
  return false;
}

function recordPatchGeneration(modelName: string, patchId: string): boolean {
  try {
    const mgr = _getMgr();
    if (mgr && typeof mgr.callWorker === 'function') {
      mgr.callWorker('reward-tracker', 'recordPatchGeneration', { modelName, patchId });
      return true;
    }
    _log(`[reward-tracker] Worker unavailable — skipping recordPatchGeneration(${modelName}, ${patchId})`, 'WARN');
  } catch (_: any) { _log(`[reward-tracker] Worker error in recordPatchGeneration: ${_?.message || _}`, 'WARN'); }
  return false;
}

function recordProdSurvival(modelName: string, survived: boolean): boolean {
  try {
    const mgr = _getMgr();
    if (mgr && typeof mgr.callWorker === 'function') {
      mgr.callWorker('reward-tracker', 'recordProdSurvival', { modelName, survived });
      return true;
    }
    _log(`[reward-tracker] Worker unavailable — skipping recordProdSurvival(${modelName})`, 'WARN');
  } catch (_: any) { _log(`[reward-tracker] Worker error in recordProdSurvival: ${_?.message || _}`, 'WARN'); }
  return false;
}

module.exports = { recordStagingResult, recordPatchGeneration, recordProdSurvival, _injectDependencies };