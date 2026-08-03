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
  const now = new Date();
  const startHour = CONFIG.ALLOWED_ACTIVITY_START_HOUR;
  const endHour = CONFIG.ALLOWED_ACTIVITY_END_HOUR;
  const currentHour = now.getHours();
  if (startHour === undefined || endHour === undefined) return now.getTime();
  const startH = Number(startHour);
  const endH = Number(endHour);
  if (startH === endH) return now.getTime();
  const isWrap = startH > endH;
  const inWindow = isWrap
    ? (currentHour >= startH || currentHour < endH)
    : (currentHour >= startH && currentHour < endH);
  if (inWindow) return now.getTime();
  const next = new Date(now);
  next.setHours(startH, 0, 0, 0);
  if (!isWrap && currentHour >= endH) next.setDate(next.getDate() + 1);
  return next.getTime();
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

  while (!stopRequested) {
    // HF Spaces: Reduce startup delay (already have keepalive covering activity)
    let nextStart = getNextAllowedStart();
    const now = Date.now();
    if (nextStart > now) {
      const waitMs = isHFSpaces ? Math.min(nextStart - now, 30 * 60 * 1000) : (nextStart - now);
      const waitMin = (waitMs / 60000).toFixed(0);
      log(`Outside allowed hours. Waiting ${waitMin} mins...`, 'INFO', 'orchestrator');
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
      log(`Cycle ${cyclesRun} done. Sleeping ${sleepMin} mins...`, 'INFO', 'orchestrator');
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
