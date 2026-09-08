'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Work Shift System — Cron-Based Scheduling with Resource-Aware Shift Selection
//
// Instead of binary "inside/outside allowed hours", the bot operates in
// one of 4 work shifts that determine pacing, module activation, and budget usage:
//
//   ACTIVE     — Peak productive hours, full speed, all modules enabled
//   CONSERVING — Off-peak but still working, reduced pacing, skip optional modules
//   REST       — Outside productive hours, minimal activity (keepalive only)
//   RECOVERY   — Budget exhausted / degradation high, cooldown and heal
//
// Shift selection is driven by 3 signals:
//   1. Time-of-day (configurable productive hours, default 6am-10pm SAST)
//   2. Degradation level (Response 3 — resource pressure overrides time)
//   3. Rate limiter pacing (if pacing > 20 min → force conserving or rest)
//
// Integration:
//   - cycle-orchestrator.ts: uses getShift() instead of raw activity window check
//   - cycle-cycle-manager.ts: respects shift for optional module activation
//   - render-free-plan.ts: starts periodic shift evaluator + exposes in /api/full-status
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Types ───────────────────────────────────────────────────────────────────

type ShiftName = 'ACTIVE' | 'CONSERVING' | 'REST' | 'RECOVERY';

interface ShiftConfig {
  name: ShiftName;
  /** Multiplier applied to cycle sleep (1.0 = normal, 2.0 = 2x slower) */
  cycleSleepMultiplier: number;
  /** Whether to skip optional/experimental modules */
  skipOptional: boolean;
  /** Whether to skip self-heal activities */
  skipSelfHeal: boolean;
  /** Whether to skip budget-burning activities (bargain hunting, model evolution) */
  skipBudgetBurners: boolean;
  /** Whether the bot should execute a full cycle or just keepalive ping */
  fullCycle: boolean;
  /** Description for logging */
  description: string;
}

interface ShiftState {
  current: ShiftName;
  previous: ShiftName;
  enteredAt: number;     // Date.now() when shift was entered
  reason: string;         // Why this shift was selected
  timeSignal: ShiftName;  // What time-of-day alone would suggest
  resourceSignal: ShiftName; // What resources alone would suggest
  totalActiveMs: number;  // Cumulative ms in ACTIVE shift today
  totalCyclesActive: number;
  cyclesInCurrentShift: number;
  lastEvalAt: number;
}

// ─── Dependencies ───────────────────────────────────────────────────────────

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function getCONFIG(): any { return _deps.config || {}; }

// ─── Shift Definitions ───────────────────────────────────────────────────────

const SHIFTS: Record<ShiftName, ShiftConfig> = {
  ACTIVE: {
    name: 'ACTIVE',
    cycleSleepMultiplier: 1.0,
    skipOptional: false,
    skipSelfHeal: false,
    skipBudgetBurners: false,
    fullCycle: true,
    description: 'Peak productive hours — full speed, all modules',
  },
  CONSERVING: {
    name: 'CONSERVING',
    cycleSleepMultiplier: 2.0,
    skipOptional: true,
    skipSelfHeal: false,
    skipBudgetBurners: true,
    fullCycle: true,
    description: 'Off-peak or tight budget — reduced pacing, skip experiments',
  },
  REST: {
    name: 'REST',
    cycleSleepMultiplier: 4.0,
    skipOptional: true,
    skipSelfHeal: true,
    skipBudgetBurners: true,
    fullCycle: false,
    description: 'Outside productive hours — keepalive only',
  },
  RECOVERY: {
    name: 'RECOVERY',
    cycleSleepMultiplier: 3.0,
    skipOptional: true,
    skipSelfHeal: true,
    skipBudgetBurners: true,
    fullCycle: false,
    description: 'Budget exhausted / high degradation — cooldown and heal',
  },
};

// ─── State ────────────────────────────────────────────────────────────────────

let _state: ShiftState = {
  current: 'ACTIVE',
  previous: 'ACTIVE',
  enteredAt: Date.now(),
  reason: 'initial',
  timeSignal: 'ACTIVE',
  resourceSignal: 'ACTIVE',
  totalActiveMs: 0,
  totalCyclesActive: 0,
  cyclesInCurrentShift: 0,
  lastEvalAt: 0,
};

let _evalInterval: ReturnType<typeof setInterval> | null = null;
let _initialized = false;

// ─── Time Signal ─────────────────────────────────────────────────────────────

function getTimeSignal(): ShiftName {
  const CONFIG = getCONFIG();
  // BUG FIX (2026-09-08): Use CONFIG.TIMEZONE (not process.env.TZ) to match
  // the orchestrator's timezone. The old code used process.env.TZ which may
  // not be set, causing the hour check to use UTC instead of SAST.
  const tz = CONFIG.TIMEZONE || process.env.TZ || 'Africa/Johannesburg';
  const productiveStart = Number(CONFIG.ALLOWED_ACTIVITY_START_HOUR ?? 1);
  const productiveEnd = Number(CONFIG.ALLOWED_ACTIVITY_END_HOUR ?? 23);

  const now = new Date();
  const currentHour = parseInt(
    now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }),
    10
  );

  // Peak zone: first 60% of productive hours = ACTIVE, last 40% = CONSERVING
  // Example: 7-22 (15 hours) → 7-16 (9h) = ACTIVE, 16-22 (6h) = CONSERVING
  const totalProductiveHours = productiveStart <= productiveEnd
    ? (productiveEnd - productiveStart)
    : (24 - productiveStart + productiveEnd);

  const peakEndHour = productiveStart <= productiveEnd
    ? (productiveStart + Math.floor(totalProductiveHours * 0.6))
    : ((productiveStart + Math.floor(totalProductiveHours * 0.6)) % 24);

  const isWrap = productiveStart > productiveEnd;
  // BUG FIX (2026-09-05): Changed endH check from < to <= so the end hour is
  // INCLUSIVE. With ALLOWED_ACTIVITY_END_HOUR=23, the bot should be active
  // DURING hour 23 (11pm), not stop at 23:00.
  const inWindow = isWrap
    ? (currentHour >= productiveStart || currentHour <= productiveEnd)
    : (currentHour >= productiveStart && currentHour <= productiveEnd);

  if (!inWindow) return 'REST';

  // Inside productive window — check if in peak or tail end
  const isPeak = productiveStart <= productiveEnd
    ? (currentHour < peakEndHour)
    : (currentHour >= productiveStart || currentHour < peakEndHour);

  return isPeak ? 'ACTIVE' : 'CONSERVING';
}

// ─── Resource Signal ──────────────────────────────────────────────────────────

function getResourceSignal(): ShiftName {
  try {
    // Check degradation ladder first
    const ladder = _deps.degradationLadder;
    if (ladder && typeof ladder.getLastCalculation === 'function') {
      const calc = ladder.getLastCalculation();
      if (calc) {
        // DORMANT → RECOVERY, SURVIVAL → CONSERVING, CONSERVING → CONSERVING
        if (calc.level >= 4) return 'RECOVERY';
        if (calc.level >= 3) return 'CONSERVING';
        if (calc.level >= 2) return 'CONSERVING';
      }
    }

    // Check rate limiter pacing
    const rateLimiter = _deps.openRouterRateLimiter;
    if (rateLimiter && typeof rateLimiter.getStatus === 'function') {
      const status = rateLimiter.getStatus();
      if (status && status.pacingIntervalMs) {
        // If pacing says wait > 20 min → conserving; > 40 min → rest
        if (status.pacingIntervalMs > 40 * 60 * 1000) return 'RECOVERY';
        if (status.pacingIntervalMs > 20 * 60 * 1000) return 'CONSERVING';
      }
    }
  } catch (e: any) {
    // Non-critical — if we can't read resources, don't downgrade
    log(`Work shifts: resource signal check failed: ${e.message}`, 'DEBUG', 'work-shifts');
  }

  return 'ACTIVE';
}

// ─── Shift Resolution ────────────────────────────────────────────────────────

// Priority: resource signal overrides time signal
// Exception: REST from time always wins (don't burn budget at 3am)
function resolveShift(timeSignal: ShiftName, resourceSignal: ShiftName): ShiftName {
  // Time says rest → always rest (don't override with resource "active")
  if (timeSignal === 'REST') {
    // Unless resource says recovery (even more urgent)
    return resourceSignal === 'RECOVERY' ? 'RECOVERY' : 'REST';
  }

  // Resource says recovery → always recovery
  if (resourceSignal === 'RECOVERY') return 'RECOVERY';

  // Both agree → use either
  if (timeSignal === resourceSignal) return timeSignal;

  // Conflict: take the more conservative one
  const priority: Record<ShiftName, number> = {
    RECOVERY: 0,
    REST: 1,
    CONSERVING: 2,
    ACTIVE: 3,
  };
  return (priority[timeSignal] < priority[resourceSignal]) ? timeSignal : resourceSignal;
}

// ─── Public API ──────────────────────────────────────────────────────────────

function evaluateShift(): ShiftState {
  const timeSig = getTimeSignal();
  const resSig = getResourceSignal();
  const resolved = resolveShift(timeSig, resSig);

  const previous = _state.current;

  // Update cumulative ACTIVE time
  if (_state.current === 'ACTIVE' && _state.enteredAt > 0) {
    _state.totalActiveMs += Date.now() - _state.enteredAt;
  }

  if (resolved !== _state.current) {
    log(
      `Shift transition: ${_state.current} → ${resolved} (time=${timeSig}, resource=${resSig})`,
      'INFO',
      'work-shifts'
    );

    // Try to persist to DB
    try {
      const db = _deps.database;
      if (db && typeof db.setCalibration === 'function') {
        db.setCalibration('work_shift', resolved);
        db.setCalibration('work_shift_entered_at', Date.now().toString());
      }
    } catch (e: any) { /* non-critical */ }

    _state.previous = previous;
    _state.current = resolved;
    _state.enteredAt = Date.now();
    _state.cyclesInCurrentShift = 0;

    // Build reason string
    const reasons: string[] = [];
    if (timeSig === 'REST') reasons.push('outside productive hours');
    else if (timeSig === 'CONSERVING') reasons.push('tail end of productive window');
    else reasons.push('peak productive hours');

    if (resSig === 'RECOVERY') reasons.push('budget exhausted or high degradation');
    else if (resSig === 'CONSERVING') reasons.push('rate limiter pacing high');

    _state.reason = reasons.join(', ');

    // Notify contextual alert manager (Response 8)
    try {
      const alerts = require('./services-ntfy-alerts');
      alerts.alertShiftTransition?.(previous, resolved, _state.reason).catch(() => {});
    } catch { /* non-critical */ }
  }

  _state.timeSignal = timeSig;
  _state.resourceSignal = resSig;
  _state.lastEvalAt = Date.now();

  return { ..._state };
}

function getShift(): ShiftState {
  if (!_initialized) {
    evaluateShift();
    _initialized = true;
  }
  return { ..._state };
}

function getShiftConfig(shift?: ShiftName): ShiftConfig {
  return SHIFTS[shift || _state.current];
}

function notifyCycleCompleted(): void {
  _state.cyclesInCurrentShift++;
  if (_state.current === 'ACTIVE') {
    _state.totalCyclesActive++;
  }
}

function shouldRunFullCycle(): boolean {
  return getShiftConfig().fullCycle;
}

function shouldSkipOptional(): boolean {
  return getShiftConfig().skipOptional;
}

function shouldSkipSelfHeal(): boolean {
  return getShiftConfig().skipSelfHeal;
}

function shouldSkipBudgetBurners(): boolean {
  return getShiftConfig().skipBudgetBurners;
}

function getCycleSleepMultiplier(): number {
  return getShiftConfig().cycleSleepMultiplier;
}

function resetDailyCounters(): void {
  _state.totalActiveMs = 0;
  _state.totalCyclesActive = 0;
  log('Work shifts: daily counters reset', 'INFO', 'work-shifts');
}

// ─── Start / Stop ────────────────────────────────────────────────────────────

function start(intervalMs: number = 60000): void {
  if (_evalInterval) clearInterval(_evalInterval);

  // Evaluate immediately
  evaluateShift();
  _initialized = true;

  log(`Work shifts started (eval every ${intervalMs / 1000}s, current: ${_state.current})`, 'INFO', 'work-shifts');

  _evalInterval = setInterval(() => {
    try {
      evaluateShift();
    } catch (e: any) {
      logError('Work shift eval error', e);
    }
  }, intervalMs);

  // Reset daily counters at midnight SAST
  const tz = process.env.TZ || 'Africa/Johannesburg';
  const scheduleMidnightReset = () => {
    const now = new Date();
    const localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
    localNow.setHours(24, 0, 0, 1); // 00:00:00.001 tomorrow
    const utcTarget = new Date(localNow.toLocaleString('en-US', { timeZone: 'UTC' }));
    const msUntilMidnight = utcTarget.getTime() - now.getTime();
    setTimeout(() => {
      resetDailyCounters();
      scheduleMidnightReset(); // Re-schedule for next midnight
    }, Math.max(msUntilMidnight, 1000));
  };
  scheduleMidnightReset();
}

function stop(): void {
  if (_evalInterval) {
    clearInterval(_evalInterval);
    _evalInterval = null;
  }
  log('Work shifts stopped', 'INFO', 'work-shifts');
}

// ─── Recovery from persisted state ───────────────────────────────────────────

function recoverFromDB(): void {
  try {
    const db = _deps.database;
    if (db && typeof db.getCalibration === 'function') {
      const savedShift = db.getCalibration('work_shift');
      const savedEnteredAt = db.getCalibration('work_shift_entered_at');

      if (savedShift && Object.keys(SHIFTS).includes(savedShift)) {
        _state.current = savedShift as ShiftName;
        _state.enteredAt = savedEnteredAt ? parseInt(savedEnteredAt, 10) : Date.now();
        _state.reason = 'recovered from database';
        log(`Work shifts: recovered ${savedShift} from database`, 'INFO', 'work-shifts');
      }
    }
  } catch (e: any) {
    log(`Work shifts: DB recovery failed: ${e.message}`, 'DEBUG', 'work-shifts');
  }
}

module.exports = {
  _injectDependencies,
  start,
  stop,
  evaluateShift,
  getShift,
  getShiftConfig,
  notifyCycleCompleted,
  shouldRunFullCycle,
  shouldSkipOptional,
  shouldSkipSelfHeal,
  shouldSkipBudgetBurners,
  getCycleSleepMultiplier,
  resetDailyCounters,
  recoverFromDB,
  SHIFTS,
};
