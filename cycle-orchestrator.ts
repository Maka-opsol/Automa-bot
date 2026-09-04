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
function _getCurrentHourInTimezone(): number {
  const CONFIG = getCONFIG();
  const tz = CONFIG.TIMEZONE || process.env.TZ || 'Africa/Johannesburg';
  try {
    const hourStr = new Date().toLocaleString('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    });
    return parseInt(hourStr, 10);
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

  // Get current SAST hour, minute, and date parts.
  const nowParts = new Date().toLocaleString('en-US', {
    timeZone: tz,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false,
  }).split(/[/,\s:]+/).map((s: string) => parseInt(s, 10));
  // nowParts = [month, day, year, hour, minute] (en-US format: M/D/YYYY, h:mm)
  // We only need hour for the window check.
  const currentHour = _getCurrentHourInTimezone();

  const isWrap = startH > endH;
  const inWindow = isWrap
    ? (currentHour >= startH || currentHour < endH)
    : (currentHour >= startH && currentHour < endH);
  if (inWindow) return Date.now();

  // Compute how many hours until the next startH in SAST.
  let hoursUntilStart: number;
  if (isWrap) {
    // Window is e.g. 23-5. We're currently in 5-23 (outside). Next start is at 23.
    hoursUntilStart = (startH - currentHour + 24) % 24;
  } else {
    // Window is e.g. 1-23. We're currently in 23-1 (outside). Next start is at 1.
    if (currentHour >= endH) {
      hoursUntilStart = (startH - currentHour + 24) % 24;
    } else {
      // currentHour < startH (shouldn't happen since we're outside window, but just in case)
      hoursUntilStart = startH - currentHour;
    }
  }
  if (hoursUntilStart < 0) hoursUntilStart += 24;
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
      log(`Outside allowed hours (current ${tz} hour: ${currentTzHour}, window: ${CONFIG.ALLOWED_ACTIVITY_START_HOUR}-${CONFIG.ALLOWED_ACTIVITY_END_HOUR}). Waiting ${waitMin} mins until ${_nowIsoInTimezone()}...`, 'INFO', 'orchestrator');
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
      const sleepMs = isHFSpaces
        ? (15 * 60 * 1000 + Math.random() * 15 * 60 * 1000) // 15-30 min on HF Spaces
        : getRandomSleepTime();
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
