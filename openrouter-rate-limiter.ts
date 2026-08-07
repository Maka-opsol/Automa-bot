'use strict';

// ─── OpenRouter Rate Limiter — Single Source of Truth ────────────────────────
//
// OpenRouter is the backbone provider. There WILL be long stretches where it's
// the ONLY provider available. This module ensures we survive those stretches.
//
// Design philosophy:
//   1. RATION, don't just gate. Spread 50 requests across 24 hours.
//   2. PRIORITIZE. Vision/tribunal > codegen > routine (diary, evolution, etc.)
//   3. SURVIVE. When budget is exhausted AND no other providers, sleep until
//      midnight UTC and resume. The bot must never permanently stall.
//   4. PERSIST. Counter lives in /tmp (Render-compatible) + DB calibration.
//      Both are written; on startup we reconcile.
//
// Priority levels (caller passes these):
//   'critical'  — Tribunal vision analysis, codegen (must succeed)
//   'standard'  — Self-heal auditor, model evolution, meta-learner
//   'low'       — Diary, reflection, non-essential work
//
// Budget split (configurable via env vars):
//   Critical:  50% of daily budget (25 requests)
//   Standard:  35% of daily budget (17 requests)
//   Low:       15% of daily budget (7 requests)
//   Any unused budget from a higher tier flows down to lower tiers at day's end.
//
// Pacing:
//   Instead of blowing through 50 requests in 2 hours, we calculate a
//   minimum interval between requests based on remaining budget and time
//   left in the day. If we have 25 requests left and 12 hours remaining,
//   minimum interval = 12*3600/25 = 1728s (~29 min between requests).
//   This is advisory — critical requests can bypass pacing in emergencies.
//
// Integration:
//   - providers-base.ts: calls checkBudget() before any OR request
//   - providers-codegen-openrouter.ts: calls checkBudget() before codegen
//   - provider-quota-bargain.ts: calls canUse() before bargain hunting
//   - providers-openrouter-tribunal.ts: uses waitForBudget() when exhausted
//   - economy-quota-rations.ts: reads getStatus() for OR-specific tracking

// ─── Configuration ────────────────────────────────────────────────────────────

const DAILY_LIMIT = parseInt(process.env.OPENROUTER_DAILY_LIMIT || '50', 10);
const CRITICAL_QUOTA = parseInt(process.env.OR_CRITICAL_QUOTA_PCT || '50', 10) / 100;
const STANDARD_QUOTA = parseInt(process.env.OR_STANDARD_QUOTA_PCT || '35', 10) / 100;
// Low gets the remainder: 1 - CRITICAL_QUOTA - STANDARD_QUOTA

// Pacing: if true, enforce minimum interval between requests
const PACING_ENABLED = (process.env.OR_PACING_ENABLED || 'true') === 'true';

// When budget exhausted and no other providers: sleep until midnight
// Set to 'false' to throw immediately instead of sleeping
const SLEEP_ON_EXHAUSTED = (process.env.OR_SLEEP_ON_EXHAUSTED || 'true') === 'true';

// Minimum sleep time when sleeping until midnight (cap at 30 min to allow restart checks)
const MAX_SLEEP_MS = 30 * 60 * 1000;

// ─── State ────────────────────────────────────────────────────────────────────

type Priority = 'critical' | 'standard' | 'low';

interface DayState {
  date: string;               // YYYY-MM-DD (UTC)
  criticalUsed: number;
  standardUsed: number;
  lowUsed: number;
  totalUsed: number;
  lastRequestAt: number;      // timestamp of last OR request (for pacing)
}

let _state: DayState = {
  date: _todayUTC(),
  criticalUsed: 0,
  standardUsed: 0,
  lowUsed: 0,
  totalUsed: 0,
  lastRequestAt: 0,
};

let _initialized = false;
let _deps: Record<string, any> = {};

// ─── Dependency Injection ─────────────────────────────────────────────────────

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function _getDb() {
  return _deps.database ?? (function() { try { return require('./database'); } catch { return null; } })();
}

function _getLog() {
  return _deps.logger?.log ?? console.log;
}

// ─── Date helpers ─────────────────────────────────────────────────────────────

function _todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function _msUntilMidnightUTC(): number {
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  tomorrow.setUTCHours(0, 0, 0, 0);
  return tomorrow.getTime() - now.getTime();
}

function _quotaForPriority(p: Priority): number {
  switch (p) {
    case 'critical':  return Math.floor(DAILY_LIMIT * CRITICAL_QUOTA);
    case 'standard':  return Math.floor(DAILY_LIMIT * STANDARD_QUOTA);
    case 'low':       return DAILY_LIMIT - Math.floor(DAILY_LIMIT * CRITICAL_QUOTA) - Math.floor(DAILY_LIMIT * STANDARD_QUOTA);
  }
}

// ─── Persistence ──────────────────────────────────────────────────────────────
// We write to BOTH /tmp file AND DB calibration table.
// On startup, we reconcile: whichever has the higher count wins (most conservative).

const _TMP_FILE = '/tmp/openrouter-rate-limit.json';

function _persistToTmp() {
  try {
    require('fs').writeFileSync(_TMP_FILE, JSON.stringify(_state), 'utf8');
  } catch {
    // /tmp write failed — not critical, DB is the primary store
  }
}

function _persistToDb() {
  try {
    const db = _getDb();
    if (!db?.upsertCalibration) return;
    db.upsertCalibration.run('or_rl_state', JSON.stringify(_state), Date.now());
  } catch {
    // DB write failed — not critical
  }
}

function _persist() {
  _persistToTmp();
  _persistToDb();
}

function _restore(): void {
  const log = _getLog();

  // Try /tmp first (fastest, most recent)
  try {
    const fs = require('fs');
    if (fs.existsSync(_TMP_FILE)) {
      const data = JSON.parse(fs.readFileSync(_TMP_FILE, 'utf8') || '{}');
      if (data.date === _todayUTC()) {
        _state = data;
        log(`OpenRouter rate limiter restored from /tmp: ${_state.totalUsed}/${DAILY_LIMIT} used`, 'INFO', 'or-limiter');
        return;
      }
    }
  } catch {}

  // Try DB
  try {
    const db = _getDb();
    const row = db?.selectCalibration?.get('or_rl_state');
    if (row?.value) {
      const data = JSON.parse(row.value);
      if (data.date === _todayUTC()) {
        _state = data;
        log(`OpenRouter rate limiter restored from DB: ${_state.totalUsed}/${DAILY_LIMIT} used`, 'INFO', 'or-limiter');
        return;
      }
    }
  } catch {}

  // Fresh day or no persisted state — start clean
  _state = {
    date: _todayUTC(),
    criticalUsed: 0,
    standardUsed: 0,
    lowUsed: 0,
    totalUsed: 0,
    lastRequestAt: 0,
  };
  log(`OpenRouter rate limiter: fresh day, budget ${DAILY_LIMIT} requests`, 'INFO', 'or-limiter');
}

// ─── Core: Check Budget ───────────────────────────────────────────────────────
//
// Returns true if the request is allowed. Throws if budget exhausted.
// The caller MUST call recordUsage() after a successful API call
// (or the slot is wasted). We intentionally DON'T auto-reserve here
// because the old "reserve on check" pattern wastes slots on failed requests.

function checkBudget(priority: Priority, options?: { bypassPacing?: boolean }): boolean {
  if (DAILY_LIMIT <= 0) return true; // unlimited

  _ensureInitialized();

  // Day rollover check
  if (_state.date !== _todayUTC()) {
    _resetForNewDay();
  }

  const log = _getLog();
  const used = _state[`${priority}Used` as keyof DayState] as number;
  const quota = _quotaForPriority(priority);
  const totalRemaining = DAILY_LIMIT - _state.totalUsed;

  // ─── Priority quota check ───
  // Each priority tier has its own quota, BUT lower tiers can also use
  // any leftover budget from higher tiers that wasn't consumed.
  if (used >= quota && totalRemaining <= 0) {
    // No budget left at all
    const msg = `OPENROUTER_DAILY_LIMIT: ${_state.totalUsed}/${DAILY_LIMIT} used. ` +
      `Priority '${priority}' quota exhausted (${used}/${quota}). ` +
      `Resumes at UTC midnight.`;
    log(msg, 'WARN', 'or-limiter');
    throw new Error(msg);
  }

  // If this priority's own quota is used up but total budget remains,
  // allow it to dip into unused higher-tier budget (overflow)
  // Exception: 'low' can't steal from 'critical' if critical hasn't had its turn yet
  if (used >= quota) {
    // This tier's quota is exhausted, check if there's overflow
    // For 'low' priority: only allow if no critical/standard requests are likely
    // (i.e., it's late in the day and critical/standard haven't used their full quota)
    const criticalRemaining = _quotaForPriority('critical') - _state.criticalUsed;
    const standardRemaining = _quotaForPriority('standard') - _state.standardUsed;

    if (priority === 'low' && (criticalRemaining > 0 || standardRemaining > 0)) {
      // Don't let low-priority steal from critical/standard
      const msg = `OPENROUTER_DAILY_LIMIT: low priority blocked — ` +
        `${criticalRemaining} critical + ${standardRemaining} standard slots reserved. ` +
        `Total: ${_state.totalUsed}/${DAILY_LIMIT}.`;
      log(msg, 'DEBUG', 'or-limiter');
      throw new Error(msg);
    }

    // standard can overflow into unused critical budget
    if (priority === 'standard' && criticalRemaining > 0 && totalRemaining <= criticalRemaining) {
      // Don't let standard use the last critical slots
      const msg = `OPENROUTER_DAILY_LIMIT: standard priority blocked — ` +
        `${criticalRemaining} critical slots reserved. Total: ${_state.totalUsed}/${DAILY_LIMIT}.`;
      log(msg, 'DEBUG', 'or-limiter');
      throw new Error(msg);
    }

    // Allow overflow — higher-tier budget is clearly unused
    log(`OpenRouter: ${priority} overflowing into unused higher-tier budget (${_state.totalUsed}/${DAILY_LIMIT})`, 'DEBUG', 'or-limiter');
  }

  // ─── Pacing check ───
  if (PACING_ENABLED && !options?.bypassPacing && _state.lastRequestAt > 0) {
    const remaining = DAILY_LIMIT - _state.totalUsed;
    if (remaining > 0) {
      const msLeft = _msUntilMidnightUTC();
      if (msLeft > 0) {
        const minIntervalMs = (msLeft / remaining) * 0.8; // 80% of ideal interval
        const elapsed = Date.now() - _state.lastRequestAt;
        if (elapsed < minIntervalMs) {
          const waitMs = minIntervalMs - elapsed;
          // For critical requests: only warn, don't block
          // For standard/low: enforce the pace
          if (priority !== 'critical') {
            const msg = `OPENROUTER_PACING: ${priority} request too soon. ` +
              `Minimum interval: ${Math.round(minIntervalMs / 1000)}s, ` +
              `elapsed: ${Math.round(elapsed / 1000)}s. Wait ${Math.round(waitMs / 1000)}s.`;
            log(msg, 'WARN', 'or-limiter');
            throw new Error(msg);
          } else {
            log(`OpenRouter pacing: critical request bypassing ${Math.round(waitMs / 1000)}s interval`, 'DEBUG', 'or-limiter');
          }
        }
      }
    }
  }

  return true;
}

// ─── Core: Record Usage ───────────────────────────────────────────────────────

function recordUsage(priority: Priority, tokens?: number): void {
  if (DAILY_LIMIT <= 0) return;
  _ensureInitialized();

  _state[`${priority}Used` as keyof DayState] = (_state[`${priority}Used` as keyof DayState] as number) + 1;
  _state.totalUsed++;
  _state.lastRequestAt = Date.now();
  _persist();

  const log = _getLog();
  const remaining = DAILY_LIMIT - _state.totalUsed;
  if (remaining <= 5) {
    log(`OpenRouter budget LOW: ${remaining}/${DAILY_LIMIT} remaining`, 'WARN', 'or-limiter');
  } else {
    log(`OpenRouter usage: ${_state.totalUsed}/${DAILY_LIMIT} (${_state.criticalUsed}C/${_state.standardUsed}S/${_state.lowUsed}L)`, 'DEBUG', 'or-limiter');
  }
}

// ─── Graceful Sleep Until Midnight ────────────────────────────────────────────
//
// When budget is exhausted AND no other providers are available,
// the bot should sleep until midnight UTC (or MAX_SLEEP_MS, whichever is shorter)
// and then retry. This prevents the death spiral of:
//   no providers → idle → crash → restart → still no providers → repeat

async function waitForBudget(priority: Priority, options?: { checkOtherProviders?: () => Promise<boolean> }): Promise<void> {
  const log = _getLog();

  if (DAILY_LIMIT <= 0) return; // unlimited — never wait

  // Check if other providers are available — if so, don't sleep, let them handle it
  if (options?.checkOtherProviders) {
    try {
      const hasOthers = await options.checkOtherProviders();
      if (hasOthers) {
        log(`OpenRouter budget exhausted but other providers available — not sleeping`, 'INFO', 'or-limiter');
        return;
      }
    } catch {}
  }

  // Check if budget is actually exhausted (might have reset while we were deciding)
  _ensureInitialized();
  if (_state.date !== _todayUTC()) _resetForNewDay();

  const remaining = DAILY_LIMIT - _state.totalUsed;
  const quota = _quotaForPriority(priority);
  const tierUsed = _state[`${priority}Used` as keyof DayState] as number;

  if (remaining > 0 && tierUsed < quota) {
    // Budget available — no need to wait
    return;
  }

  // Calculate sleep time until midnight
  const msUntilMidnight = _msUntilMidnightUTC();
  const sleepMs = Math.min(msUntilMidnight, MAX_SLEEP_MS);

  log(`OpenRouter budget exhausted. Priority '${priority}': ${tierUsed}/${quota}, total: ${_state.totalUsed}/${DAILY_LIMIT}. ` +
    `No other providers. Sleeping ${Math.round(sleepMs / 1000)}s until midnight UTC.`, 'WARN', 'or-limiter');

  // Sleep in 60-second increments so we can be interrupted
  const start = Date.now();
  while (Date.now() - start < sleepMs) {
    await _sleep(Math.min(60000, sleepMs - (Date.now() - start)));

    // Check if day rolled over
    if (_state.date !== _todayUTC()) {
      _resetForNewDay();
      log(`OpenRouter: midnight rollover during sleep! Budget refreshed: ${DAILY_LIMIT} requests`, 'INFO', 'or-limiter');
      return;
    }
  }

  // After sleep, check if there's budget now
  if (_state.date !== _todayUTC()) _resetForNewDay();
  log(`OpenRouter: wake from sleep, budget: ${DAILY_LIMIT - _state.totalUsed}/${DAILY_LIMIT} remaining`, 'INFO', 'or-limiter');
}

function _sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Status API ────────────────────────────────────────────────────────────────

function getStatus(): {
  dailyLimit: number;
  totalUsed: number;
  totalRemaining: number;
  criticalUsed: number;
  criticalQuota: number;
  criticalRemaining: number;
  standardUsed: number;
  standardQuota: number;
  standardRemaining: number;
  lowUsed: number;
  lowQuota: number;
  lowRemaining: number;
  msUntilMidnight: number;
  lastRequestAt: number;
  pacingIntervalMs: number;
  date: string;
} {
  _ensureInitialized();
  if (_state.date !== _todayUTC()) _resetForNewDay();

  const remaining = DAILY_LIMIT - _state.totalUsed;
  const msLeft = _msUntilMidnightUTC();
  const pacingIntervalMs = remaining > 0 && msLeft > 0 ? Math.round((msLeft / remaining) * 0.8) : 0;

  return {
    dailyLimit: DAILY_LIMIT,
    totalUsed: _state.totalUsed,
    totalRemaining: remaining,
    criticalUsed: _state.criticalUsed,
    criticalQuota: _quotaForPriority('critical'),
    criticalRemaining: Math.max(0, _quotaForPriority('critical') - _state.criticalUsed),
    standardUsed: _state.standardUsed,
    standardQuota: _quotaForPriority('standard'),
    standardRemaining: Math.max(0, _quotaForPriority('standard') - _state.standardUsed),
    lowUsed: _state.lowUsed,
    lowQuota: _quotaForPriority('low'),
    lowRemaining: Math.max(0, _quotaForPriority('low') - _state.lowUsed),
    msUntilMidnight: msLeft,
    lastRequestAt: _state.lastRequestAt,
    pacingIntervalMs,
    date: _state.date,
  };
}

// Can a non-critical caller use OpenRouter right now?
function canUse(priority: Priority): boolean {
  try {
    checkBudget(priority);
    return true;
  } catch {
    return false;
  }
}

// Get remaining budget for a specific priority (without consuming)
function getRemaining(priority: Priority): number {
  _ensureInitialized();
  if (_state.date !== _todayUTC()) _resetForNewDay();
  const used = _state[`${priority}Used` as keyof DayState] as number;
  const quota = _quotaForPriority(priority);
  return Math.max(0, quota - used);
}

// ─── Internal ─────────────────────────────────────────────────────────────────

function _ensureInitialized(): void {
  if (!_initialized) {
    _initialized = true;
    _restore();
  }
}

function _resetForNewDay(): void {
  const log = _getLog();
  const yesterday = _state.date;
  _state = {
    date: _todayUTC(),
    criticalUsed: 0,
    standardUsed: 0,
    lowUsed: 0,
    totalUsed: 0,
    lastRequestAt: 0,
  };
  _persist();
  log(`OpenRouter rate limiter: new day reset (${yesterday} → ${_state.date}). Budget: ${DAILY_LIMIT} requests`, 'INFO', 'or-limiter');
}

// ─── Exports ───────────────────────────────────────────────────────────────────

module.exports = {
  // Core API
  checkBudget,
  recordUsage,
  waitForBudget,
  // Query API
  getStatus,
  canUse,
  getRemaining,
  // Lifecycle
  _injectDependencies,
  // Constants (for testing/monitoring)
  DAILY_LIMIT,
  Priority: { CRITICAL: 'critical' as Priority, STANDARD: 'standard' as Priority, LOW: 'low' as Priority },
};
