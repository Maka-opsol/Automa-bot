// Resilience R14a: CAPTCHA Loop Detection — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// auth-captcha-loop-guard.ts — P2 CAPTCHA Loop Detection
// ═══════════════════════════════════════════════════════════════
// If the bot encounters too many CAPTCHAs, it's likely been flagged
// as a bot. This module tracks CAPTCHA encounters and triggers a
// cooldown period to let the flag expire.
//
// Features:
//   1. Track CAPTCHA count per cycle and per hour
//   2. If >5 CAPTCHAs in one cycle OR >10 in one hour → loop detected
//   3. On loop detection: trigger cooldown (stop all activity)
//   4. Optionally change browser fingerprint on cooldown exit
//   5. Alert on CAPTCHA loop detection
//
// Integration:
//   - cycle-cycle-manager.ts calls recordCaptcha() on CAPTCHA detection
//   - cycle-cycle-manager.ts calls isCaptchaLooping() before actions
//
// Config:
//   CAPTCHA_LOOP_CYCLE_LIMIT — per-cycle CAPTCHA limit (default 5)
//   CAPTCHA_LOOP_HOUR_LIMIT — per-hour CAPTCHA limit (default 10)
//   CAPTCHA_LOOP_COOLDOWN_MS — cooldown duration (default 1800000 = 30 min)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'captcha-guard') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Constants ───
const DEFAULT_CYCLE_LIMIT = 5;
const DEFAULT_HOUR_LIMIT = 10;
const DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;  // 30 minutes

// ─── State ───
let _captchaTimestamps: number[] = [];        // All CAPTCHA timestamps
let _cycleCaptchaCount = 0;
let _totalCaptchasDetected = 0;
let _totalLoopsTriggered = 0;
let _isLooping = false;
let _loopCooldownUntil = 0;
let _started = false;

// ─── Helpers ───

function _getCycleLimit(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CAPTCHA_LOOP_CYCLE_LIMIT);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_CYCLE_LIMIT;
}

function _getHourLimit(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CAPTCHA_LOOP_HOUR_LIMIT);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_HOUR_LIMIT;
}

function _getCooldownMs(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CAPTCHA_LOOP_COOLDOWN_MS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_COOLDOWN_MS;
}

function _getCaptchaCountInLastHour(): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return _captchaTimestamps.filter(t => t >= oneHourAgo).length;
}

function _pruneOldTimestamps(): void {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  while (_captchaTimestamps.length > 0 && _captchaTimestamps[0] < oneHourAgo) {
    _captchaTimestamps.shift();
  }
}

// ─── Core API ───

/**
 * Record a CAPTCHA encounter.
 */
function recordCaptcha(): void {
  _totalCaptchasDetected++;
  _cycleCaptchaCount++;
  _captchaTimestamps.push(Date.now());
  _pruneOldTimestamps();

  const cycleLimit = _getCycleLimit();
  const hourLimit = _getHourLimit();
  const hourCount = _getCaptchaCountInLastHour();

  log(
    `[CAPTCHA] CAPTCHA detected (#${_totalCaptchasDetected}, cycle: ${_cycleCaptchaCount}/${cycleLimit}, hour: ${hourCount}/${hourLimit})`,
    'WARN'
  );

  // Check loop conditions
  if (!_isLooping && (_cycleCaptchaCount >= cycleLimit || hourCount >= hourLimit)) {
    _triggerLoop();
  }
}

/**
 * Check if CAPTCHA loop is active.
 */
function isCaptchaLooping(): boolean {
  if (_isLooping && Date.now() >= _loopCooldownUntil) {
    // Cooldown expired
    _isLooping = false;
    _cycleCaptchaCount = 0;
    log('[CAPTCHA] Cooldown expired. Resuming normal operation.', 'INFO');
    return false;
  }
  return _isLooping;
}

/**
 * Get remaining cooldown time in milliseconds.
 */
function getCaptchaCooldownRemaining(): number {
  if (!_isLooping) return 0;
  return Math.max(0, _loopCooldownUntil - Date.now());
}

/**
 * Trigger CAPTCHA loop cooldown.
 */
function _triggerLoop(): void {
  _isLooping = true;
  _loopCooldownUntil = Date.now() + _getCooldownMs();
  _totalLoopsTriggered++;

  log(
    `[CAPTCHA] CAPTCHA LOOP DETECTED: ${_cycleCaptchaCount} in cycle, ${_getCaptchaCountInLastHour()} in hour. ` +
    `Entering cooldown for ${_getCooldownMs() / 1000}s.`,
    'ERROR'
  );

  // Alert
  try {
    const alerting = (_deps as any).alerting;
    if (alerting?.sendAlert) {
      alerting.sendAlert(
        'CAPTCHA Loop Detected',
        `${_cycleCaptchaCount} CAPTCHAs in current cycle, ${_getCaptchaCountInLastHour()} in last hour. ` +
        `Entering ${_getCooldownMs() / 1000}s cooldown. The bot may have been flagged.`
      );
    }
  } catch { /* non-critical */ }

  // Persist
  try {
    const db = (_deps as any).database;
    if (db?.upsertCalibration) {
      db.upsertCalibration('captcha_total', String(_totalCaptchasDetected));
      db.upsertCalibration('captcha_loops', String(_totalLoopsTriggered));
    }
  } catch { /* non-critical */ }
}

/**
 * Reset cycle count (call at cycle start).
 */
function resetCycle(): void {
  _cycleCaptchaCount = 0;
}

/**
 * Get diagnostic status.
 */
function getStatus(): {
  isLooping: boolean;
  cooldownRemainingMs: number;
  cycleCount: number;
  cycleLimit: number;
  hourCount: number;
  hourLimit: number;
  totalCaptchasDetected: number;
  totalLoopsTriggered: number;
} {
  _pruneOldTimestamps();
  return {
    isLooping: _isLooping,
    cooldownRemainingMs: getCaptchaCooldownRemaining(),
    cycleCount: _cycleCaptchaCount,
    cycleLimit: _getCycleLimit(),
    hourCount: _getCaptchaCountInLastHour(),
    hourLimit: _getHourLimit(),
    totalCaptchasDetected: _totalCaptchasDetected,
    totalLoopsTriggered: _totalLoopsTriggered,
  };
}

/**
 * Start the CAPTCHA loop guard.
 */
function start(): void {
  if (_started) return;
  _started = true;

  log(
    `[CAPTCHA] CAPTCHA loop guard started (cycleLimit=${_getCycleLimit()}, hourLimit=${_getHourLimit()}, cooldown=${_getCooldownMs() / 1000}s)`,
    'INFO'
  );
}

module.exports = {
  _injectDependencies,
  recordCaptcha,
  isCaptchaLooping,
  getCaptchaCooldownRemaining,
  resetCycle,
  getStatus,
  start,
};
