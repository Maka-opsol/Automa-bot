'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getInsertProgress() { return _deps.database?.insertProgress; }

const fs = require('fs');
const CONFIG = require('./get-config');
const { log, logError } = require('./logger');
const PROGRESS_LOG_PATH = CONFIG.PROGRESS_LOG_PATH;
const LAST_STATE_PATH = CONFIG.LAST_STATE_PATH;

function trackProgress(entry: any) { 
  if (!PROGRESS_LOG_PATH) return;
  try {
    // Validate entry fields before writing
    if (!entry || typeof entry.action !== 'string' || entry.action.trim().length === 0) {
      log('trackProgress: invalid or missing action field', 'WARN', 'progress-tracker');
      return;
    }
    if (entry.state !== undefined && typeof entry.state !== 'string') {
      log('trackProgress: state must be a string', 'WARN', 'progress-tracker');
      return;
    }
    if (entry.questions_completed !== undefined && (typeof entry.questions_completed !== 'number' || entry.questions_completed < 0 || !Number.isFinite(entry.questions_completed))) {
      log('trackProgress: questions_completed must be a non-negative number', 'WARN', 'progress-tracker');
      return;
    }
    const line = JSON.stringify({ ...entry, timestamp: new Date().toISOString() }) + '\n';
    fs.appendFileSync(PROGRESS_LOG_PATH, line);
// @ts-expect-error
    getInsertProgress(entry.action, entry.state, entry.questions_completed);
  } catch (e: any) { logError('Failed to write progress', e); }
}

function loadLastState() { 
  try { if (fs.existsSync(LAST_STATE_PATH)) { const data = fs.readFileSync(LAST_STATE_PATH, 'utf8'); return JSON.parse(data); } } catch (e: any) { logError('Failed to load last state', e); }
  return null;
}

function saveLastState(state: any) { 
  const tmp = LAST_STATE_PATH + '.tmp';
  try { fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, LAST_STATE_PATH); } catch (e: any) { logError('Failed to save last state', e); }
}

module.exports = { trackProgress, loadLastState, saveLastState, _injectDependencies };
