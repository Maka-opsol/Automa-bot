'use strict';

// ─── BazaarLink Rate Limiter ─────────────────────────────────────────────
//
// 50 free requests/day for codegen. Simpler than OpenRouter limiter
// since BazaarLink is ONLY used for codegen (single priority tier).
//
// Persistence: /tmp/bazaarlink-rate-limit.json + DB calibration.
// On startup, reconciles whichever has the higher count.

const DAILY_LIMIT = parseInt(process.env.BAZAARLINK_DAILY_LIMIT || '50', 10);

// ─── State ──────────────────────────────────────────────────────────────

interface DayState {
  date: string;          // YYYY-MM-DD (UTC)
  used: number;
  lastRequestAt: number; // timestamp of last request (for pacing)
}

let _state: DayState = {
  date: _todayUTC(),
  used: 0,
  lastRequestAt: 0,
};

let _initialized = false;
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

function _getDb() {
  return _deps.database ?? (function() { try { return require('./database'); } catch { return null; } })();
}

function _getLog() {
  return _deps.logger?.log ?? console.log;
}

// ─── Date helpers ──────────────────────────────────────────────────────

function _todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

// ─── Persistence ──────────────────────────────────────────────────────

const _TMP_FILE = '/tmp/bazaarlink-rate-limit.json';

function _persist() {
  try {
    require('fs').writeFileSync(_TMP_FILE, JSON.stringify(_state), 'utf8');
  } catch {}
  try {
    const db = _getDb();
    if (!db?.upsertCalibration) return;
    db.upsertCalibration.run('bl_rl_state', JSON.stringify(_state), Date.now());
  } catch {}
}

function _restore(): void {
  const log = _getLog();

  // Try /tmp first (fastest)
  try {
    const fs = require('fs');
    if (fs.existsSync(_TMP_FILE)) {
      const data = JSON.parse(fs.readFileSync(_TMP_FILE, 'utf8') || '{}');
      if (data.date === _todayUTC()) {
        _state = data;
        log(`BazaarLink rate limiter restored from /tmp: ${_state.used}/${DAILY_LIMIT} used`, 'INFO', 'bl-limiter');
        return;
      }
    }
  } catch {}

  // Try DB
  try {
    const db = _getDb();
    const row = db?.selectCalibration?.get('bl_rl_state');
    if (row?.value) {
      const data = JSON.parse(row.value);
      if (data.date === _todayUTC()) {
        _state = data;
        log(`BazaarLink rate limiter restored from DB: ${_state.used}/${DAILY_LIMIT} used`, 'INFO', 'bl-limiter');
        return;
      }
    }
  } catch {}

  // Fresh day
  _state = { date: _todayUTC(), used: 0, lastRequestAt: 0 };
  log(`BazaarLink rate limiter: fresh day, budget ${DAILY_LIMIT} requests`, 'INFO', 'bl-limiter');
}

function _ensureInitialized(): void {
  if (!_initialized) { _initialized = true; _restore(); }
}

function _resetForNewDay(): void {
  const log = _getLog();
  const yesterday = _state.date;
  _state = { date: _todayUTC(), used: 0, lastRequestAt: 0 };
  _persist();
  log(`BazaarLink rate limiter: new day reset (${yesterday} -> ${_state.date}). Budget: ${DAILY_LIMIT} requests`, 'INFO', 'bl-limiter');
}

// ─── Core: Check Budget ───────────────────────────────────────────────
// Throws if budget exhausted. Caller MUST call recordUsage() after success.

function checkBudget(): boolean {
  if (DAILY_LIMIT <= 0) return true;
  _ensureInitialized();
  if (_state.date !== _todayUTC()) _resetForNewDay();

  const remaining = DAILY_LIMIT - _state.used;
  if (remaining <= 0) {
    const log = _getLog();
    const msg = `BAZAARLINK_DAILY_LIMIT: ${_state.used}/${DAILY_LIMIT} used. Resumes at UTC midnight.`;
    log(msg, 'WARN', 'bl-limiter');
    throw new Error(msg);
  }

  return true;
}

// ─── Core: Record Usage ───────────────────────────────────────────────

function recordUsage(): void {
  if (DAILY_LIMIT <= 0) return;
  _ensureInitialized();
  _state.used++;
  _state.lastRequestAt = Date.now();
  _persist();

  const log = _getLog();
  const remaining = DAILY_LIMIT - _state.used;
  if (remaining <= 5) {
    log(`BazaarLink budget LOW: ${remaining}/${DAILY_LIMIT} remaining`, 'WARN', 'bl-limiter');
  } else {
    log(`BazaarLink usage: ${_state.used}/${DAILY_LIMIT}`, 'DEBUG', 'bl-limiter');
  }
}

// ─── Query API ────────────────────────────────────────────────────────

function getRemaining(): number {
  _ensureInitialized();
  if (_state.date !== _todayUTC()) _resetForNewDay();
  return Math.max(0, DAILY_LIMIT - _state.used);
}

function getStatus() {
  _ensureInitialized();
  if (_state.date !== _todayUTC()) _resetForNewDay();
  return {
    dailyLimit: DAILY_LIMIT,
    used: _state.used,
    remaining: Math.max(0, DAILY_LIMIT - _state.used),
    date: _state.date,
  };
}

// ─── Force Exhaust ───────────────────────────────────────────────────
// Sync internal counter to reality when BazaarLink returns 429.

function forceExhaust(reason: string): void {
  const log = _getLog();
  _ensureInitialized();
  if (_state.date !== _todayUTC()) _resetForNewDay();
  const wasUsed = _state.used;
  _state.used = DAILY_LIMIT;
  _persist();
  log(`BazaarLink rate limit FORCE EXHAUSTED. Was ${wasUsed}/${DAILY_LIMIT}, now ${DAILY_LIMIT}/${DAILY_LIMIT}. Reason: ${reason}`, 'WARN', 'bl-limiter');
}

module.exports = { checkBudget, recordUsage, getRemaining, getStatus, forceExhaust, _injectDependencies, DAILY_LIMIT };
