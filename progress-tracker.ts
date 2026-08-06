'use strict';
// Last modified: 2026-08-05 — Response 20: Fixed ENOENT — mkdir error now logged with early return
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getInsertProgress() { return _deps.database?.insertProgress; }

const fs = require('fs');
const path = require('path');
const os = require('os');
const CONFIG = require('./get-config');
const { log, logError } = require('./logger');

// Lazy path resolution — ensures we pick up env vars set by render-free-plan.ts
// before any module load, not the frozen default from config.ts.
// On Render free tier, env vars from render-free-plan.ts point to /tmp which is
// always writable. The fallback also uses /tmp to avoid EACCES on read-only CWD.
function getProgressLogPath() { return process.env.PROGRESS_LOG_PATH || CONFIG.PROGRESS_LOG_PATH || path.join(os.tmpdir(), 'mathu-logs', 'progress.jsonl'); }
function getLastStatePath() { return process.env.LAST_STATE_PATH || CONFIG.LAST_STATE_PATH || path.join(os.tmpdir(), 'last-state.json'); }

function trackProgress(entry: any) { 
  const PROGRESS_LOG_PATH = getProgressLogPath();
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
    const dir = path.dirname(PROGRESS_LOG_PATH);
    // Ensure directory exists BEFORE writing — ENOENT fix for ./logs/progress.jsonl
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (mkdirErr: any) {
      log(`trackProgress: failed to create directory ${dir}: ${mkdirErr.message}`, 'WARN', 'progress-tracker');
      return; // Don't try to write if we can't create the directory
    }
    fs.appendFileSync(PROGRESS_LOG_PATH, line);
// @ts-expect-error
    getInsertProgress(entry.action, entry.state, entry.questions_completed);
  } catch (e: any) { logError('Failed to write progress', e); }
}

function loadLastState() { 
  const LAST_STATE_PATH = getLastStatePath();
  try { if (fs.existsSync(LAST_STATE_PATH)) { const data = fs.readFileSync(LAST_STATE_PATH, 'utf8'); return JSON.parse(data); } } catch (e: any) { logError('Failed to load last state', e); }
  return null;
}

function saveLastState(state: any) { 
  const LAST_STATE_PATH = getLastStatePath();
  const tmp = LAST_STATE_PATH + '.tmp';
  try { const dir = path.dirname(LAST_STATE_PATH); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(tmp, JSON.stringify(state, null, 2)); fs.renameSync(tmp, LAST_STATE_PATH); } catch (e: any) { logError('Failed to save last state', e); }
}

module.exports = { trackProgress, loadLastState, saveLastState, _injectDependencies };
