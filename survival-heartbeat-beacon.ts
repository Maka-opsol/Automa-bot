// Resilience R6: External Liveness Beacon — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// survival-heartbeat-beacon.ts — P2 External Liveness Beacon
// ═══════════════════════════════════════════════════════════════
// If the bot dies and stays dead, nobody knows. This module sends
// periodic liveness pings to an external endpoint so an operator
// (or UptimeRobot / healthchecks.io) can detect bot death.
//
// Features:
//   1. POST timestamp to BEACON_URL every 5 minutes (configurable)
//   2. Supports multiple beacon formats:
//      - UptimeRobot: simple GET to any URL (200 = alive)
//      - healthchecks.io: GET/POST with /fail path for "down" signal
//      - Discord webhook: POST JSON with status embed
//      - Generic HTTP POST: JSON body with timestamp + metadata
//   3. Stale beacon detection on startup:
//      If BEACON_AUTO_RESTART=true and last beacon in DB is >30 min
//      old, the bot died between restarts — trigger process.exit(1)
//      for a clean Render auto-restart cycle.
//   4. On shutdown (SIGTERM/SIGINT): send "down" signal to beacon
//      so monitoring system immediately marks bot as offline
//      instead of waiting for timeout.
//
// Integration:
//   - container-subsystem-runner.ts calls start() at boot
//   - render-free-plan.ts SIGTERM handler calls sendDownSignal()
//   - runtime-heap-guardian.ts calls sendDownSignal() before OOM exit
//
// Config:
//   BEACON_URL — external URL to ping (required for beacon to activate)
//   BEACON_INTERVAL_MS — ping interval (default 300000 = 5 min)
//   BEACON_AUTO_RESTART — exit on stale beacon detection (default false)
//   BEACON_STALE_THRESHOLD_MS — how old before beacon is stale (default 1800000 = 30 min)
//   BEACON_FORMAT — 'uptime' | 'healthchecks' | 'discord' | 'generic' (auto-detected)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'heartbeat-beacon') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

function logError(msg: string, err: Error) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  console.error(`[ERROR] [heartbeat-beacon] ${msg}`, err);
}

// ─── Constants ───
const DEFAULT_BEACON_INTERVAL_MS = 5 * 60 * 1000;       // 5 minutes
const DEFAULT_STALE_THRESHOLD_MS = 30 * 60 * 1000;     // 30 minutes
const BEACON_DB_KEY = 'last_beacon_ts';
const BEACON_START_DB_KEY = 'last_beacon_start_ts';
const BEACON_COUNT_KEY = 'beacon_ping_count';

// ─── State ───
let _beaconInterval: ReturnType<typeof setInterval> | null = null;
let _pingCount = 0;
let _consecutiveFailures = 0;
let _lastPingSuccess = false;
let _lastPingTime = 0;
let _started = false;
let _shutdownHookInstalled = false;

// ─── Beacon Format Detection ───

type BeaconFormat = 'uptime' | 'healthchecks' | 'discord' | 'generic';

/**
 * Auto-detect beacon format from URL pattern.
 */
function detectBeaconFormat(url: string): BeaconFormat {
  const lower = url.toLowerCase();

  // Discord webhook: discord.com/api/webhooks/...
  if (lower.includes('discord.com') || lower.includes('discordapp.com')) {
    return 'discord';
  }

  // healthchecks.io: hc-ping.io/<uuid> or healthchecks.io/...
  if (lower.includes('hc-ping.io') || lower.includes('healthchecks.io') || lower.includes('hcping')) {
    return 'healthchecks';
  }

  // UptimeRobot: anything else is a simple ping
  // UptimeRobot just needs a GET to any URL, 200 = success
  return 'uptime';
}

// ─── Ping Implementations ───

/**
 * Send a simple GET ping (UptimeRobot style).
 * Any 2xx response = alive.
 */
async function pingUptime(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(15000),
    });
    return response.ok;
  } catch (e: any) {
    logError('UptimeRobot ping failed', e);
    return false;
  }
}

/**
 * Send a healthchecks.io style ping.
 * POST to base URL = success, GET to base URL = success.
 * POST to base_url/fail = failure signal.
 */
async function pingHealthchecks(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ts: Date.now(), pid: process.pid }),
      signal: AbortSignal.timeout(15000),
    });
    return response.ok;
  } catch (e: any) {
    logError('Healthchecks.io ping failed', e);
    return false;
  }
}

/**
 * Send a Discord webhook ping with status embed.
 */
async function pingDiscord(url: string): Promise<boolean> {
  try {
    const mem = process.memoryUsage();
    const uptimeMin = Math.round(process.uptime() / 60);

    const payload = {
      username: 'MathU Beacon',
      embeds: [{
        title: 'Heartbeat',
        color: 0x00FF00, // green = alive
        fields: [
          { name: 'Time', value: new Date().toISOString(), inline: true },
          { name: 'PID', value: String(process.pid), inline: true },
          { name: 'Uptime', value: `${uptimeMin}m`, inline: true },
          { name: 'Heap', value: `${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB`, inline: true },
          { name: 'Pings', value: String(_pingCount), inline: true },
        ],
        timestamp: new Date().toISOString(),
      }],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    return response.ok || response.status === 204;
  } catch (e: any) {
    logError('Discord beacon ping failed', e);
    return false;
  }
}

/**
 * Send a generic JSON POST with timestamp + metadata.
 */
async function pingGeneric(url: string): Promise<boolean> {
  try {
    const mem = process.memoryUsage();
    const payload = {
      beacon: 'mathu-bot-heartbeat',
      timestamp: Date.now(),
      pid: process.pid,
      uptime_s: Math.round(process.uptime()),
      heap_mb: +(mem.heapUsed / 1024 / 1024).toFixed(1),
      ping_count: _pingCount,
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000),
    });

    return response.ok;
  } catch (e: any) {
    logError('Generic beacon ping failed', e);
    return false;
  }
}

// ─── "Down" Signal (graceful shutdown) ───

/**
 * Send a "down" signal to healthchecks.io or Discord.
 * Called on SIGTERM/SIGINT or before OOM exit.
 */
async function sendDownSignal(reason: string = 'shutdown'): Promise<boolean> {
  const CONFIG = getCONFIG();
  const beaconUrl = (CONFIG.BEACON_URL as string) || process.env.BEACON_URL;
  if (!beaconUrl) return false;

  const format = (CONFIG.BEACON_FORMAT as BeaconFormat) || detectBeaconFormat(beaconUrl);

  // healthchecks.io: POST to /fail path
  if (format === 'healthchecks') {
    try {
      const failUrl = beaconUrl.endsWith('/fail') ? beaconUrl : beaconUrl + '/fail';
      const response = await fetch(failUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ down: true, reason, ts: Date.now() }),
        signal: AbortSignal.timeout(5000),
      });
      log(`Sent DOWN signal to healthchecks.io (status ${response.status})`, 'WARN');
      return response.ok;
    } catch (e: any) {
      logError('Failed to send DOWN signal to healthchecks.io', e);
      return false;
    }
  }

  // Discord: send red embed
  if (format === 'discord') {
    try {
      const payload = {
        username: 'MathU Beacon',
        embeds: [{
          title: 'Bot Offline',
          color: 0xFF0000, // red = dead
          description: reason,
          fields: [
            { name: 'Time', value: new Date().toISOString(), inline: true },
            { name: 'PID', value: String(process.pid), inline: true },
            { name: 'Total Pings', value: String(_pingCount), inline: true },
          ],
          timestamp: new Date().toISOString(),
        }],
      };
      const response = await fetch(beaconUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      log(`Sent DOWN signal to Discord webhook (status ${response.status})`, 'WARN');
      return response.ok || response.status === 204;
    } catch (e: any) {
      logError('Failed to send DOWN signal to Discord', e);
      return false;
    }
  }

  // uptime/generic: no "down" signal concept — just log
  log(`No DOWN signal for format '${format}' — monitoring will detect via timeout`, 'INFO');
  return false;
}

// ─── DB Persistence ───

/**
 * Record last beacon timestamp in DB.
 */
function recordBeaconInDb(): void {
  try {
    const db = (_deps as any).database;
    if (!db?.database) return;

    const now = Date.now();
    db.database.prepare(
      "INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)"
    ).run(BEACON_DB_KEY, String(now), now);

    // Also track ping count
    db.database.prepare(
      "INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)"
    ).run(BEACON_COUNT_KEY, String(_pingCount), now);
  } catch { /* non-critical */ }
}

/**
 * Get last beacon timestamp from DB. Returns 0 if not found.
 */
function getLastBeaconTs(): number {
  try {
    const db = (_deps as any).database;
    if (!db?.database) return 0;

    const row = db.database.prepare(
      "SELECT value FROM calibration WHERE key = ?"
    ).get(BEACON_DB_KEY) as any;

    return row ? parseInt(row.value, 10) || 0 : 0;
  } catch { return 0; }
}

// ─── Stale Beacon Detection ───

/**
 * Check if the last beacon is stale (> threshold).
 * If auto-restart is enabled, exit the process.
 */
function checkStaleBeacon(): { isStale: boolean; lastBeaconAgeMs: number; action: string } {
  const CONFIG = getCONFIG();
  const autoRestart = (CONFIG.BEACON_AUTO_RESTART as string) === 'true' || process.env.BEACON_AUTO_RESTART === 'true';
  const staleThreshold = (CONFIG.BEACON_STALE_THRESHOLD_MS as number) || parseInt(process.env.BEACON_STALE_THRESHOLD_MS || String(DEFAULT_STALE_THRESHOLD_MS), 10);

  const lastTs = getLastBeaconTs();
  if (lastTs === 0) {
    // No previous beacon — first run
    return { isStale: false, lastBeaconAgeMs: -1, action: 'no_previous_beacon' };
  }

  const ageMs = Date.now() - lastTs;

  if (ageMs > staleThreshold) {
    const ageMin = Math.round(ageMs / 60000);
    log(`Last beacon was ${ageMin} minutes ago (threshold: ${Math.round(staleThreshold / 60000)} min)`, 'WARN');

    if (autoRestart) {
      log(`BEACON_AUTO_RESTART=true — bot was dead for ${ageMin} min, triggering clean restart`, 'ERROR');
      return { isStale: true, lastBeaconAgeMs: ageMs, action: 'auto_restart' };
    }

    return { isStale: true, lastBeaconAgeMs: ageMs, action: 'logged_only' };
  }

  log(`Last beacon was ${Math.round(ageMs / 1000)}s ago — within threshold, OK`, 'DEBUG');
  return { isStale: false, lastBeaconAgeMs: ageMs, action: 'ok' };
}

// ─── Main Ping Logic ───

/**
 * Send a single beacon ping.
 */
async function sendPing(): Promise<boolean> {
  const CONFIG = getCONFIG();
  const beaconUrl = (CONFIG.BEACON_URL as string) || process.env.BEACON_URL;
  if (!beaconUrl) return false;

  const format = (CONFIG.BEACON_FORMAT as BeaconFormat) || detectBeaconFormat(beaconUrl);

  let success = false;

  switch (format) {
    case 'uptime':
      success = await pingUptime(beaconUrl);
      break;
    case 'healthchecks':
      success = await pingHealthchecks(beaconUrl);
      break;
    case 'discord':
      success = await pingDiscord(beaconUrl);
      break;
    case 'generic':
      success = await pingGeneric(beaconUrl);
      break;
    default:
      success = await pingGeneric(beaconUrl);
  }

  _pingCount++;
  _lastPingTime = Date.now();

  if (success) {
    _consecutiveFailures = 0;
    _lastPingSuccess = true;
    recordBeaconInDb();
  } else {
    _consecutiveFailures++;
    _lastPingSuccess = false;
    if (_consecutiveFailures <= 3) {
      log(`Beacon ping failed (${_consecutiveFailures} consecutive)`, 'WARN');
    } else if (_consecutiveFailures % 10 === 0) {
      // Log every 10th failure to avoid spam
      log(`Beacon ping failed ${_consecutiveFailures} times total`, 'WARN');
    }
  }

  return success;
}

// ─── Shutdown Hooks ───

/**
 * Install SIGTERM/SIGINT handlers to send "down" signal before exit.
 * Only installs once — called from start().
 */
function installShutdownHooks(): void {
  if (_shutdownHookInstalled) return;
  _shutdownHookInstalled = true;

  const cleanup = async (signal: string) => {
    log(`Received ${signal} — sending beacon down signal...`, 'WARN');
    try {
      await sendDownSignal(signal);
    } catch { /* best effort */ }
  };

  process.on('SIGTERM', () => {
    cleanup('SIGTERM').finally(() => process.exit(0));
  });

  process.on('SIGINT', () => {
    cleanup('SIGINT').finally(() => process.exit(0));
  });
}

// ─── Public API ───

/**
 * Start the heartbeat beacon.
 * Returns stale beacon check result (for caller to decide on auto-restart).
 */
function start(): { isStale: boolean; action: string } {
  if (_started) {
    log('Heartbeat beacon already running', 'WARN');
    return { isStale: false, action: 'already_running' };
  }
  _started = true;

  const CONFIG = getCONFIG();
  const beaconUrl = (CONFIG.BEACON_URL as string) || process.env.BEACON_URL;
  const intervalMs = (CONFIG.BEACON_INTERVAL_MS as number) || parseInt(process.env.BEACON_INTERVAL_MS || String(DEFAULT_BEACON_INTERVAL_MS), 10);

  if (!beaconUrl) {
    log('No BEACON_URL configured — heartbeat beacon disabled', 'INFO');
    return { isStale: false, action: 'no_url_configured' };
  }

  const format = (CONFIG.BEACON_FORMAT as BeaconFormat) || detectBeaconFormat(beaconUrl);
  log(`Heartbeat beacon starting (format: ${format}, interval: ${Math.round(intervalMs / 1000)}s, url: ${beaconUrl.substring(0, 50)}...)`, 'INFO');

  // Check stale beacon from previous session
  const staleCheck = checkStaleBeacon();
  if (staleCheck.isStale && staleCheck.action === 'auto_restart') {
    sendDownSignal('stale_beacon_auto_restart').finally(() => {
      process.exit(1);
    });
    return staleCheck;
  }

  // Record startup time
  try {
    const db = (_deps as any).database;
    if (db?.database) {
      db.database.prepare(
        "INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)"
      ).run(BEACON_START_DB_KEY, String(Date.now()), Date.now());
    }
  } catch { /* non-critical */ }

  // Send first ping immediately
  sendPing().catch((e: any) => logError('First beacon ping failed', e));

  // Periodic ping
  _beaconInterval = setInterval(() => {
    try {
      sendPing().catch((e: any) => logError('Periodic beacon ping failed', e));
    } catch (e: any) {
      logError('Beacon interval error', e);
    }
  }, intervalMs);

  if (_beaconInterval && typeof _beaconInterval.unref === 'function') {
    _beaconInterval.unref();
  }

  // Install shutdown hooks
  installShutdownHooks();

  return staleCheck;
}

/**
 * Stop the heartbeat beacon.
 */
function stop(): void {
  if (_beaconInterval) {
    clearInterval(_beaconInterval);
    _beaconInterval = null;
  }
  _started = false;
  log('Heartbeat beacon stopped', 'INFO');
}

/**
 * Get beacon status for diagnostics.
 */
function getStatus(): Record<string, any> {
  const CONFIG = getCONFIG();
  const beaconUrl = (CONFIG.BEACON_URL as string) || process.env.BEACON_URL;
  const format = beaconUrl ? ((CONFIG.BEACON_FORMAT as BeaconFormat) || detectBeaconFormat(beaconUrl)) : 'none';

  const lastTs = getLastBeaconTs();
  const lastAgeMs = lastTs > 0 ? Date.now() - lastTs : -1;

  return {
    started: _started,
    beaconUrl: beaconUrl ? beaconUrl.substring(0, 60) + (beaconUrl.length > 60 ? '...' : '') : 'none',
    format,
    pingCount: _pingCount,
    consecutiveFailures: _consecutiveFailures,
    lastPingSuccess: _lastPingSuccess,
    lastPingTime: _lastPingTime > 0 ? new Date(_lastPingTime).toISOString() : 'never',
    lastPingAgeMs: lastAgeMs,
    lastDbBeaconAgeMs: lastAgeMs,
    autoRestart: (CONFIG.BEACON_AUTO_RESTART as string) === 'true' || process.env.BEACON_AUTO_RESTART === 'true',
    intervalRunning: _beaconInterval !== null,
    shutdownHookInstalled: _shutdownHookInstalled,
  };
}

module.exports = {
  start,
  stop,
  sendPing,
  sendDownSignal,
  checkStaleBeacon,
  detectBeaconFormat,
  getStatus,
  _injectDependencies,
};
