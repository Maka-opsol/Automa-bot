
'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Survival Hang Watchdog — independent heartbeat-stall detector
// ═══════════════════════════════════════════════════════════════════════
//
// Problem:
//   The bot writes a heartbeat file (.heartbeat) every 60s via setInterval
//   (agent.ts:676) AND every cycle iteration (cycle-cycle-manager.ts:1845).
//   But NOTHING READS that file to detect a hang. If the process deadlocks
//   (stuck Playwright call, infinite synchronous loop, blocked I/O), the
//   heartbeat goes stale but the process stays "alive" — burning uptime
//   with zero progress, exactly the state the user wants to eliminate.
//
//   The cycle-watchdog (cycle-watchdog.ts) only watches WITHIN the cycle
//   loop. If the hang is outside the cycle loop (in self-heal codegen,
//   in a Playwright navigation, in a DB operation), it never fires.
//
//   The cycle's own progress-timeout (E_PROGRESS_STALL) only fires if the
//   cycle loop is ITERATING. If the loop is stuck on a single `await`
//   that never resolves, the timeout never checks.
//
// Solution:
//   An INDEPENDENT watchdog timer that checks the heartbeat file's mtime
//   every 5 minutes. If the heartbeat is stale (> STALE_THRESHOLD_MS,
//   default 30 min — 30x the write interval), the process is hung and the
//   watchdog forces process.exit(1):
//     - On Render: exit(1) = "crashed" = auto-restart (free plan)
//     - On HF Spaces: process stays up but all in-memory state resets
//
//   The watchdog is deliberately SIMPLE and INDEPENDENT:
//     - Uses setInterval().unref() so it doesn't block graceful shutdown
//     - Has its own try/catch — never crashes the bot
//     - 10-min boot grace period (don't check during initialization)
//     - Self-disables during last-resort mode (expected to look "stuck"
//       while actually working aggressively — though it still writes
//       heartbeats, so this is just belt-and-suspenders)
//     - Sends an alert before restarting (if alerting is configured)
//
// Limitation:
//   This is an IN-PROCESS watchdog. If the Node event loop itself is
//   blocked (synchronous infinite loop, deadlock), this watchdog's
//   setInterval won't fire either. For that case, the platform-level
//   health check (Render's HTTP health probe, HF Spaces' liveness check)
//   is the backstop. This watchdog catches the more common case: the
//   event loop is alive but the cycle is stuck on an `await` that never
//   resolves, so the heartbeat stops being written.
//
// API:
//   start()              — begin the watchdog interval (checks every 5 min)
//   stop()               — clear the interval
//   checkNow()           — run one check immediately (returns {stale, ageMs})
//   getStatus()          — last check time, heartbeat age, restart count
//   selfTest()           — verify wiring
// ═══════════════════════════════════════════════════════════════════════

const CHECK_INTERVAL_MS = 5 * 60 * 1000;        // check every 5 min
const STALE_THRESHOLD_MS = 30 * 60 * 1000;       // 30 min (30x the 60s write interval)
const BOOT_GRACE_MS = 10 * 60 * 1000;            // don't check during first 10 min

let _interval: any = null;
let _startedAt = 0;
let _lastCheckTime = 0;
let _lastHeartbeatAge = 0;
let _restartCount = 0;
let _deps: any = {};

function _injectDependencies(deps: any) { _deps = deps || {}; }

function _log(msg: string, level: string = 'INFO'): void {
  try {
    const logger = _deps.logger || (require('./logger').log ? require('./logger') : null);
    if (logger?.log) { logger.log(msg, level, 'survival-hang-watchdog'); return; }
  } catch {}
  const fn = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
  (console as any)[fn](`[survival-hang-watchdog] ${msg}`);
}

function _getHeartbeatFile(): string {
  try {
    const config = _deps.config || require('./config').CONFIG || require('./config');
    return config.HEARTBEAT_FILE || config.HEARTBEAT_FILE;
  } catch {
    return '/tmp/.heartbeat'; // fallback
  }
}

function _sendAlert(msg: string): void {
  try {
    const alerting = require('./alerting');
    if (alerting?.sendAlert) { alerting.sendAlert(msg); return; }
  } catch {}
  try {
    const { sendAlert } = require('./alerting');
    if (sendAlert) sendAlert(msg);
  } catch {}
}

function _isLastResortActive(): boolean {
  try { return require('./last-resort-mode').isLastResortActive(); } catch { return false; }
}

function _gracefulShutdown(reason: string): Promise<void> {
  try {
    const shutdown = _deps.shutdown?.gracefulShutdown;
    if (shutdown) return Promise.resolve(shutdown(reason));
  } catch {}
  return Promise.resolve();
}

// ═══════════════════════════════════════════════════════════════════════
// Core check — read heartbeat mtime, return staleness info
// ═══════════════════════════════════════════════════════════════════════

function checkNow(): { stale: boolean; ageMs: number; heartbeatFile: string; reason: string } {
  const heartbeatFile = _getHeartbeatFile();
  let ageMs = Infinity;
  let reason = '';

  try {
    const fs = require('fs');
    const stat = fs.statSync(heartbeatFile);
    ageMs = Date.now() - stat.mtimeMs;

    if (ageMs > STALE_THRESHOLD_MS) {
      // Don't trigger during last-resort mode (expected to look "stuck")
      if (_isLastResortActive()) {
        return { stale: false, ageMs, heartbeatFile, reason: 'last-resort-mode-active (stale expected)' };
      }
      return {
        stale: true,
        ageMs,
        heartbeatFile,
        reason: `heartbeat stale: ${Math.round(ageMs / 60000)}min since last write (threshold: ${STALE_THRESHOLD_MS / 60000}min)`,
      };
    }
    return { stale: false, ageMs, heartbeatFile, reason: 'fresh' };
  } catch (err: any) {
    // Heartbeat file doesn't exist or can't be stat'd
    const ageSinceStart = Date.now() - _startedAt;
    if (ageSinceStart < BOOT_GRACE_MS) {
      return { stale: false, ageMs: Infinity, heartbeatFile, reason: `boot grace (${Math.round((BOOT_GRACE_MS - ageSinceStart) / 60000)}min remaining)` };
    }
    // Past boot grace and heartbeat file is missing/unreadable — the bot
    // has been running long enough that the file SHOULD exist. Its absence
    // means either the disk is full (can't write) or the bot never started
    // its cycle loop. Either way, restart.
    return {
      stale: true,
      ageMs: Infinity,
      heartbeatFile,
      reason: `heartbeat file inaccessible: ${err?.message || err} (past boot grace)`,
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Watchdog tick — check heartbeat, force restart if stale
// ═══════════════════════════════════════════════════════════════════════

async function _tick(): Promise<void> {
  _lastCheckTime = Date.now();

  // Boot grace period — don't check during the first 10 min
  if (Date.now() - _startedAt < BOOT_GRACE_MS) {
    _lastHeartbeatAge = -1; // sentinel: in grace period
    return;
  }

  const result = checkNow();
  _lastHeartbeatAge = result.ageMs;

  if (result.stale) {
    _restartCount++;
    _log(
      `⚠️ HEARTBEAT STALL DETECTED — ${result.reason}. ` +
      `Forcing process restart (#${_restartCount}). ` +
      `The bot has been hung for at least ${Math.round((result.ageMs === Infinity ? BOOT_GRACE_MS : result.ageMs) / 60000)}min.`,
      'ERROR'
    );

    // Send alert before restarting (best-effort)
    _sendAlert(
      `MathU bot heartbeat stall: ${result.reason}. ` +
      `Watchdog forcing restart (#${_restartCount}). ` +
      `The process was alive but not making progress.`
    );

    // Graceful shutdown (flushes logs, saves state) — but don't wait forever
    try {
      await Promise.race([
        _gracefulShutdown('heartbeat-stall-watchdog'),
        new Promise(r => setTimeout(r, 10 * 1000)), // 10s max
      ]);
    } catch {}

    // Force restart. exit(1) = Render auto-restart; HF Spaces intercepts.
    _log('Forcing process.exit(1) — Render will auto-restart; HF Spaces resets in-memory state.', 'ERROR');
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════

function start(): void {
  if (_interval) return; // already running
  _startedAt = Date.now();
  _log(
    `Starting hang watchdog — checks heartbeat every ${CHECK_INTERVAL_MS / 60000}min, ` +
    `stale threshold: ${STALE_THRESHOLD_MS / 60000}min, boot grace: ${BOOT_GRACE_MS / 60000}min.`,
    'INFO'
  );

  // First check after boot grace + a buffer (don't check during init)
  const firstCheckDelay = BOOT_GRACE_MS + 60 * 1000;
  const firstTimer = setTimeout(() => {
    _tick().catch((e: any) => _log(`First watchdog tick failed: ${e?.message || e}`, 'WARN'));
  }, firstCheckDelay);
  if (typeof firstTimer.unref === 'function') firstTimer.unref();

  // Then every 5 min
  _interval = setInterval(() => {
    _tick().catch((e: any) => _log(`Watchdog tick failed: ${e?.message || e}`, 'WARN'));
  }, CHECK_INTERVAL_MS);
  if (typeof _interval.unref === 'function') _interval.unref();
}

function stop(): void {
  if (_interval) { clearInterval(_interval); _interval = null; }
  _log('Hang watchdog stopped.', 'DEBUG');
}

// ═══════════════════════════════════════════════════════════════════════
// Diagnostics
// ═══════════════════════════════════════════════════════════════════════

function getStatus(): Record<string, any> {
  const uptime = _startedAt ? Date.now() - _startedAt : 0;
  const inBootGrace = uptime < BOOT_GRACE_MS;
  return {
    running: !!_interval,
    startedAt: _startedAt,
    uptimeMs: uptime,
    inBootGrace,
    lastCheckTime: _lastCheckTime,
    lastHeartbeatAgeMs: _lastHeartbeatAge,
    lastHeartbeatAgeMin: _lastHeartbeatAge === Infinity ? null : _lastHeartbeatAge === -1 ? 'grace' : Math.round(_lastHeartbeatAge / 60000),
    staleThresholdMs: STALE_THRESHOLD_MS,
    staleThresholdMin: STALE_THRESHOLD_MS / 60000,
    checkIntervalMs: CHECK_INTERVAL_MS,
    restartCount: _restartCount,
    heartbeatFile: _getHeartbeatFile(),
  };
}

function selfTest(): Record<string, any> {
  const checks: string[] = [];
  if (CHECK_INTERVAL_MS >= 2147483647) checks.push('check interval would overflow 32-bit timer');
  if (STALE_THRESHOLD_MS <= 0) checks.push('stale threshold must be positive');
  if (BOOT_GRACE_MS <= 0) checks.push('boot grace must be positive');
  if (STALE_THRESHOLD_MS < CHECK_INTERVAL_MS) checks.push('stale threshold should exceed check interval');
  return {
    ok: checks.length === 0,
    checks,
    checkIntervalMs: CHECK_INTERVAL_MS,
    staleThresholdMs: STALE_THRESHOLD_MS,
    bootGraceMs: BOOT_GRACE_MS,
  };
}

function _resetForTest(): void {
  if (_interval) clearInterval(_interval);
  _interval = null;
  _startedAt = 0;
  _lastCheckTime = 0;
  _lastHeartbeatAge = 0;
  _restartCount = 0;
}

module.exports = {
  start,
  stop,
  checkNow,
  getStatus,
  selfTest,
  _injectDependencies,
  _resetForTest,
  CHECK_INTERVAL_MS,
  STALE_THRESHOLD_MS,
  BOOT_GRACE_MS,
};
