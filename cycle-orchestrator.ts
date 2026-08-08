'use strict';

import type { Deps } from './types/di-types';
let _deps: Deps = {};

function _injectDependencies(deps: Deps) { _deps = deps; }
function getCONFIG(): any { return _deps.config || {}; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

let stopRequested = false;
let cyclesRun = 0;

function requestStop() {
  stopRequested = true;
  try { const { requestStop: cycleStop } = require('./cycle-cycle-manager'); cycleStop(); } catch (e: any) { /* cycle-manager not loaded yet */ }
}

function getRandomSleepTime() { 
  const CONFIG = getCONFIG();
  const minMs = CONFIG.SLEEP_MIN_HOURS * 60 * 60 * 1000;
  const maxMs = CONFIG.SLEEP_MAX_HOURS * 60 * 60 * 1000;
  return minMs + Math.random() * (maxMs - minMs);
}

function getRandomStartupDelay() { 
  const CONFIG = getCONFIG();
  const minMs = CONFIG.STARTUP_DELAY_MIN_MINUTES * 60 * 1000;
  const maxMs = CONFIG.STARTUP_DELAY_MAX_MINUTES * 60 * 1000;
  return minMs + Math.random() * (maxMs - minMs);
}

function getNextAllowedStart() { 
  const CONFIG = getCONFIG();
  const tz = process.env.TZ || 'Africa/Johannesburg';
  const now = new Date();
  const startHour = CONFIG.ALLOWED_ACTIVITY_START_HOUR;
  const endHour = CONFIG.ALLOWED_ACTIVITY_END_HOUR;
  // Use timezone-aware hour (Render defaults to UTC; config hours are in local time)
  const currentHour = parseInt(
    now.toLocaleString('en-US', { timeZone: tz, hour: 'numeric', hour12: false }),
    10
  );
  if (startHour === undefined || endHour === undefined) return now.getTime();
  const startH = Number(startHour);
  const endH = Number(endHour);
  if (startH === endH) return now.getTime();
  const isWrap = startH > endH;
  const inWindow = isWrap
    ? (currentHour >= startH || currentHour < endH)
    : (currentHour >= startH && currentHour < endH);
  if (inWindow) return now.getTime();
  // Calculate next window start in local timezone
  const localNow = new Date(now.toLocaleString('en-US', { timeZone: tz }));
  localNow.setHours(startH, 0, 0, 0);
  // Convert back to UTC for correct Date.now() comparison
  const nextStart = new Date(localNow.toLocaleString('en-US', { timeZone: 'UTC' }));
  if (nextStart.getTime() <= now.getTime()) nextStart.setDate(nextStart.getDate() + 1);
  return nextStart.getTime();
}

/**
 * Lazy-load the work shifts module (Response 7).
 * Avoids circular dependency — only loaded when needed.
 */
function _getWorkShifts(): any {
  try {
    const mod = require('./services-work-shifts');
    return mod;
  } catch (e: any) {
    return null;
  }
}

function sleep(ms: any) {  return new Promise(resolve => setTimeout(resolve, ms)); }

async function startDaemon() {
  // v6-fix: Removed CONFIG.validateConfig?.() here — it was already
  // called in agent.ts/hf-spaces.ts. Running it again inside the daemon loop
  // caused wasteful backoff retries if it threw.
  const CONFIG = getCONFIG();
  log('MathU Bot starting', 'INFO', 'orchestrator');
  const sendAlert = _deps.alerting?.sendAlert || (() => {});
  let backoffMs = 1000;
  const isHFSpaces = !!(process.env.PORT || process.env.SPACE_ID || process.env.SPACE_AUTHOR_NAME);

  // Response 7: Lazy-load work shifts for shift-aware scheduling
  const workShifts = _getWorkShifts();

  while (!stopRequested) {
    // ── Work Shifts: REST/RECOVERY → keepalive sleep instead of full cycle ──
    if (workShifts && typeof workShifts.getShift === 'function') {
      const shift = workShifts.getShift();

      if (!workShifts.shouldRunFullCycle()) {
        // In REST or RECOVERY: sleep for a while, then re-evaluate
        const restMs = workShifts.getCycleSleepMultiplier() > 2
          ? (10 * 60 * 1000 + Math.random() * 10 * 60 * 1000) // 10-20 min in REST
          : (5 * 60 * 1000 + Math.random() * 5 * 60 * 1000);  // 5-10 min in RECOVERY

        log(`Shift ${shift.current}: keepalive mode (${shift.reason}). Sleeping ${(restMs / 60000).toFixed(0)} mins...`, 'INFO', 'orchestrator');

        // In REST, still ping keepalive to prevent Render spin-down
        if (shift.current === 'REST' && !isHFSpaces) {
          try {
            const healthWatchdog = _getHealthWatchdog();
            if (healthWatchdog && typeof healthWatchdog.checkNow === 'function') {
              healthWatchdog.checkNow();
            }
          } catch (e: any) { /* non-critical */ }
        }

        await sleep(restMs);
        continue;
      }
    }

    // ── Original activity window check (kept as hard gate) ──
    let nextStart = getNextAllowedStart();
    const now = Date.now();
    if (nextStart > now) {
      const waitMs = isHFSpaces ? Math.min(nextStart - now, 30 * 60 * 1000) : (nextStart - now);
      const waitMin = (waitMs / 60000).toFixed(0);
      log(`Outside allowed hours. Waiting ${waitMin} mins...`, 'INFO', 'orchestrator');
      await sleep(waitMs);
      continue;
    }

    const delayMs = isHFSpaces ? 5000 : getRandomStartupDelay();
    if (delayMs > 10000) log(`Waking up, waiting ${(delayMs/60000).toFixed(0)} mins...`, 'INFO', 'orchestrator');
    await sleep(delayMs);

    try {
      await _deps.cycleManager?.runCycle?.();
      cyclesRun++;

      // Response 7: Notify work shifts of cycle completion
      if (workShifts && typeof workShifts.notifyCycleCompleted === 'function') {
        workShifts.notifyCycleCompleted();
      }

      backoffMs = 1000;

      // HF Spaces: NEVER process.exit — reset counter and continue
      if (cyclesRun >= CONFIG.MAX_CYCLES_BEFORE_RESTART) {
        if (isHFSpaces) {
          log(`Reached ${cyclesRun} cycles (HF Spaces mode) — resetting counter, NOT exiting`, 'INFO', 'orchestrator');
          cyclesRun = 0;
        } else {
          log(`Reached ${cyclesRun} cycles -- restarting process`, 'INFO', 'orchestrator');
          await (_deps.shutdown?.gracefulShutdown || (() => {}))('scheduled');
          process.exit(1);
        }
      }

      // Response 7: Apply shift-aware sleep multiplier
      let baseSleepMs: number;
      if (isHFSpaces) {
        baseSleepMs = 15 * 60 * 1000 + Math.random() * 15 * 60 * 1000;
      } else {
        baseSleepMs = getRandomSleepTime();
      }

      const shiftMultiplier = (workShifts && typeof workShifts.getCycleSleepMultiplier === 'function')
        ? workShifts.getCycleSleepMultiplier()
        : 1.0;
      const sleepMs = Math.round(baseSleepMs * shiftMultiplier);
      const sleepMin = (sleepMs / 60000).toFixed(0);
      const shiftName = workShifts?.getShift?.()?.current || 'N/A';
      log(`Cycle ${cyclesRun} done. Sleeping ${sleepMin} mins (shift=${shiftName}, x${shiftMultiplier})`, 'INFO', 'orchestrator');
      await sleep(sleepMs);
    } catch (err: any) {
      logError('Daemon error', err);
      if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Daemon error: ${err instanceof Error ? err.message : String(err)}`); } catch (e: any) {}
      const maxBackoff = isHFSpaces ? 5 * 60 * 1000 : 60000 * 10;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoff);
    }
  }
  log('Daemon stopped gracefully', 'INFO', 'orchestrator');
}

function _getHealthWatchdog(): any {
  try {
    return require('./longevity-self-ping');
  } catch (e: any) {
    return null;
  }
}

function resumeDaemon() {
  stopRequested = false;
}

module.exports = { startDaemon, requestStop, resumeDaemon, _injectDependencies };
