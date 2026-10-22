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
  const minH = Number(CONFIG.SLEEP_MIN_HOURS) || 0.1;
  const maxH = Number(CONFIG.SLEEP_MAX_HOURS) || 1;
  const minMs = minH * 60 * 60 * 1000;
  const maxMs = maxH * 60 * 60 * 1000;
  if (minMs <= 0 || maxMs <= 0 || maxMs <= minMs) return 5 * 60 * 1000; // 5min safe default
  return minMs + Math.random() * (maxMs - minMs);
}

function getRandomStartupDelay() {
  const CONFIG = getCONFIG();
  const minM = Number(CONFIG.STARTUP_DELAY_MIN_MINUTES) || 5;
  const maxM = Number(CONFIG.STARTUP_DELAY_MAX_MINUTES) || 30;
  const minMs = minM * 60 * 1000;
  const maxMs = maxM * 60 * 1000;
  if (minMs <= 0 || maxMs <= 0 || maxMs <= minMs) return 5 * 60 * 1000; // 5min safe default
  return minMs + Math.random() * (maxMs - minMs);
}

// ── BUG FIX (2026-09-04): Timezone-aware hour getter ──
// The old code used `new Date().getHours()` which returns server-local hours.
// On Render/HF Spaces, the server is UTC, so ALLOWED_ACTIVITY_START_HOUR=1
// and ALLOWED_ACTIVITY_END_HOUR=23 were interpreted as UTC hours (SAST 3am to
// SAST 1am next day) instead of SAST hours (SAST 1am to SAST 11pm).
//
// This function returns the current hour in the configured timezone
// (CONFIG.TIMEZONE, default 'Africa/Johannesburg' = SAST UTC+2), so the
// allowed-hours check matches the user's intent.
//
// TASK 123 (2026-10-22): Fixed hour=24 bug. The toLocaleString with
// hour: 'numeric', hour12: false returns "24" for midnight (00:00) in some
// ICU configurations. getHours() returns 0-23, but toLocaleString can return
// "24" — which breaks the allowed-hours check. Now we use hour: '2-digit'
// and normalize "24" to "0".
function _getCurrentHourInTimezone(): number {
  const CONFIG = getCONFIG();
  const tz = CONFIG.TIMEZONE || process.env.TZ || 'Africa/Johannesburg';
  try {
    const hourStr = new Date().toLocaleString('en-US', {
      timeZone: tz,
      hour: '2-digit',
      hour12: false,
    });
    let hour = parseInt(hourStr.replace(/\D/g, ''), 10);
    // TASK 123: Some ICU versions return "24" for midnight instead of "00".
    // Normalize to 0-23 range.
    if (isNaN(hour) || hour < 0) hour = new Date().getHours();
    if (hour >= 24) hour = hour - 24;
    if (hour < 0) hour = 0;
    return hour;
  } catch {
    // Invalid timezone string — fall back to server-local hour.
    return new Date().getHours();
  }
}

// ── BUG FIX (2026-09-04): Timezone-aware "next allowed start" computation ──
// Computes the next SAST hour at which the bot should become active, as a
// UTC epoch-millisecond timestamp (so it can be compared to Date.now()).
function _getNextAllowedStartInTimezone(): number {
  const CONFIG = getCONFIG();
  const tz = CONFIG.TIMEZONE || process.env.TZ || 'Africa/Johannesburg';
  const startH = Number(CONFIG.ALLOWED_ACTIVITY_START_HOUR);
  const endH = Number(CONFIG.ALLOWED_ACTIVITY_END_HOUR);
  if (!Number.isFinite(startH) || !Number.isFinite(endH) || startH === endH) {
    return Date.now(); // no window configured — always active
  }

  const currentHour = _getCurrentHourInTimezone();

  const isWrap = startH > endH;
  // BUG FIX (2026-09-05): Changed endH check from < to <= so the end hour is
  // INCLUSIVE. With ALLOWED_ACTIVITY_END_HOUR=23, the bot should be active
  // DURING hour 23 (11pm), not stop at 23:00. The old < comparison meant
  // hour 23 was excluded — the bot stopped at 23:00 and waited until 01:00.
  const inWindow = isWrap
    ? (currentHour >= startH || currentHour <= endH)
    : (currentHour >= startH && currentHour <= endH);
  if (inWindow) return Date.now();

  // Compute how many hours until the next startH in SAST.
  let hoursUntilStart: number;
  if (isWrap) {
    // Window is e.g. 23-5. We're currently in 6-22 (outside). Next start is at 23.
    hoursUntilStart = (startH - currentHour + 24) % 24;
  } else {
    // Window is e.g. 1-23. We're currently in 0 (midnight) or 24 (after 23).
    // Next start is at 1am.
    if (currentHour > endH) {
      // After end hour (e.g. hour 0 with end=23 → wait 1 hour)
      hoursUntilStart = (startH - currentHour + 24) % 24;
    } else {
      // Before start hour (e.g. hour 0 with start=1 → wait 1 hour)
      hoursUntilStart = startH - currentHour;
    }
  }
  if (hoursUntilStart <= 0) hoursUntilStart += 24;
  return Date.now() + hoursUntilStart * 60 * 60 * 1000;
}

// ── BUG FIX (2026-09-04): Timezone-aware timestamp for log messages ──
// Returns an ISO 8601 string in the configured timezone (e.g. "2026-09-04T04:38:00.000+02:00")
// instead of always-UTC "2026-09-04T02:38:00.000Z".
// Accepts an optional epoch-millis timestamp; defaults to Date.now().
function _nowIsoInTimezone(epochMs?: number): string {
  const CONFIG = getCONFIG();
  const tz = CONFIG.TIMEZONE || process.env.TZ || 'Africa/Johannesburg';
  try {
    const when = (epochMs !== undefined) ? new Date(epochMs) : new Date();
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    });
    const parts = formatter.formatToParts(when);
    const get = (type: string) => parts.find(p => p.type === type)?.value || '00';
    const yyyy = get('year'); const mm = get('month'); const dd = get('day');
    const hh = get('hour') === '24' ? '00' : get('hour'); // 24-hour edge case
    const mi = get('minute'); const ss = get('second');
    // Compute UTC offset for the timezone (same for any timestamp in non-DST TZs)
    const nowUtc = when.getTime();
    const offsetMs = nowUtc - new Date(when.toLocaleString('en-US', { timeZone: tz })).getTime();
    const offsetMin = Math.round(offsetMs / 60000);
    const sign = offsetMin >= 0 ? '+' : '-';
    const absMin = Math.abs(offsetMin);
    const offsetStr = `${sign}${String(Math.floor(absMin / 60)).padStart(2, '0')}:${String(absMin % 60).padStart(2, '0')}`;
    return `${yyyy}-${mm}-${dd}T${hh}:${mi}:${ss}.000${offsetStr}`;
  } catch {
    return new Date(epochMs).toISOString();
  }
}

function getNextAllowedStart() {
  // BUG FIX (2026-09-04): Delegate to the timezone-aware implementation.
  // The old code used `new Date().getHours()` which is UTC on Render/HF Spaces.
  return _getNextAllowedStartInTimezone();
}

function sleep(ms: any) {  return new Promise(resolve => setTimeout(resolve, ms)); }

async function startDaemon() {
  // v6-fix: Removed CONFIG.validateConfig?.() here — it was already
  // called in agent.ts/hf-spaces.ts. Running it again inside the daemon loop
  // caused wasteful backoff retries if it threw.
  const CONFIG = getCONFIG();
  const tz = CONFIG.TIMEZONE || process.env.TZ || 'Africa/Johannesburg';
  // BUG FIX (2026-09-04): Log the configured timezone on startup so the user
  // can verify allowed-hours checks and log timestamps are using SAST.
  log(`MathU Bot starting (timezone: ${tz}, allowed hours: ${CONFIG.ALLOWED_ACTIVITY_START_HOUR}-${
    CONFIG.ALLOWED_ACTIVITY_END_HOUR} ${tz === 'Africa/Johannesburg' ? 'SAST' : tz})`, 'INFO', 'orchestrator');
  const sendAlert = _deps.alerting?.sendAlert || (() => {});
  let backoffMs = 1000;
  const isHFSpaces = !!(process.env.PORT || process.env.SPACE_ID || process.env.SPACE_AUTHOR_NAME);

  while (!stopRequested) {
    // HF Spaces: Reduce startup delay (already have keepalive covering activity)
    let nextStart = getNextAllowedStart();
    const now = Date.now();
    if (nextStart > now) {
      const waitMs = isHFSpaces ? Math.min(nextStart - now, 30 * 60 * 1000) : (nextStart - now);
      const waitMin = (waitMs / 60000).toFixed(0);
      // BUG FIX (2026-09-04): Log the current SAST hour so the user can verify
      // the bot is correctly outside its allowed window (not just using UTC).
      const currentTzHour = _getCurrentHourInTimezone();
      // BUG FIX (2026-09-05): Pass nextStart to _nowIsoInTimezone so the log
      // shows the FUTURE wake time, not the current time. The old code showed
      // "Waiting 30 mins until [current time]" which was confusing.
      log(`Outside allowed hours (current ${tz} hour: ${currentTzHour}, window: ${CONFIG.ALLOWED_ACTIVITY_START_HOUR}-${CONFIG.ALLOWED_ACTIVITY_END_HOUR}). Waiting ${waitMin} mins until ${_nowIsoInTimezone(nextStart)}...`, 'INFO', 'orchestrator');
      await sleep(waitMs);
      continue;
    }
    const delayMs = isHFSpaces ? 5000 : getRandomStartupDelay(); // 5s on HF Spaces vs 15-45min
    if (delayMs > 10000) log(`Waking up, waiting ${(delayMs/60000).toFixed(0)} mins...`, 'INFO', 'orchestrator');
    await sleep(delayMs);
    try {
      await _deps.cycleManager?.runCycle?.();
      cyclesRun++;
      backoffMs = 1000;
      // HF Spaces: NEVER process.exit — reset counter and continue
      if (cyclesRun >= CONFIG.MAX_CYCLES_BEFORE_RESTART) {
        if (isHFSpaces) {
          log(`Reached ${cyclesRun} cycles (HF Spaces mode) — resetting counter, NOT exiting`, 'INFO', 'orchestrator');
          cyclesRun = 0;
        } else {
          log(`Reached ${cyclesRun} cycles -- restarting process`, 'INFO', 'orchestrator');
          await (_deps.shutdown?.gracefulShutdown || (() => {}))('scheduled');
          // v6-fix: CRITICAL — exit(1) so Render auto-restarts.
          // On Render free plan, exit(0) = "clean exit" = service STOPS permanently.
          // exit(1) = "crashed" = Render auto-restarts the service.
          // Note: hf-spaces.ts intercepts process.exit to prevent actual exit.
          process.exit(1);
        }
      }
      // HF Spaces: Much shorter sleep between cycles (keep the space active)
      let sleepMs = isHFSpaces
        ? (15 * 60 * 1000 + Math.random() * 15 * 60 * 1000) // 15-30 min on HF Spaces
        : getRandomSleepTime();

      // TASK 83 (2026-09-25): If the cycle ended with 0 questions completed
      // (e.g., all vision providers were rate-limited), use a SHORT 2-minute
      // sleep instead of the normal 15-30 min. This lets the bot retry
      // quickly when providers might have recovered, instead of sleeping
      // for 23 minutes while the bot is stuck.
      if ((globalThis as any).__cycleZeroQuestions) {
        sleepMs = 2 * 60 * 1000; // 2 minutes
        (globalThis as any).__cycleZeroQuestions = false; // reset for next cycle
        log(`Cycle ended with 0 questions — using SHORT retry delay (${sleepMs / 60000} min) instead of normal sleep. Vision providers may have recovered.`, 'INFO', 'orchestrator');
      }

      const sleepMin = (sleepMs / 60000).toFixed(0);
      const wakeIso = _nowIsoInTimezone(Date.now() + sleepMs);
      // BUG FIX (2026-09-04): Show SAST wake time so the user knows when the
      // bot will next be active (and can see if it falls inside/outside the
      // allowed-hours window).
      log(`Cycle ${cyclesRun} done. Sleeping ${sleepMin} mins (will wake at ${wakeIso} ${tz}).`, 'INFO', 'orchestrator');
      await sleep(sleepMs);
    } catch (err: any) {
      logError('Daemon error', err);
      if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Daemon error: ${err instanceof Error ? err.message : String(err)}`); } catch (e: any) {}
      // HF Spaces: Cap backoff at 5 minutes (not 10 minutes)
      const maxBackoff = isHFSpaces ? 5 * 60 * 1000 : 60000 * 10;
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, maxBackoff);
    }
  }
  log('Daemon stopped gracefully', 'INFO', 'orchestrator');
}

function resumeDaemon() {
  stopRequested = false;
}

module.exports = { startDaemon, requestStop, resumeDaemon, _injectDependencies };
