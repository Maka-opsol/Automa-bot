// Resilience R4: Remote State Backup — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// survival-tombstone.ts — P1 Remote State Backup
// ═══════════════════════════════════════════════════════════════
// On Render free tier, all progress is lost if the SQLite DB gets
// corrupted or the process is SIGKILL'd before checkpoint writes.
// This module periodically pushes a compressed state snapshot to
// remote storage, and restores from it on cold start if needed.
//
// Push targets (tried in order):
//   1. TOMBSTONE_URL env var — generic HTTP POST (JSON body)
//   2. TOMBSTONE_DISCORD_URL — Discord webhook (multipart messages)
//   3. Local file backup (data/tombstone_latest.json.gz)
//
// Snapshot contents:
//   - Checkpoint data (questionsCompleted, state, URL, currentModule)
//   - Provider health scores (from provider_registry table)
//   - Calibration data (from calibration table)
//   - Completed modules (from completed_modules table)
//   - Last state (from last_state table)
//   - Tombstone metadata (timestamp, version, trigger reason)
//
// Compression: gzip via Node.js built-in zlib
// Rate-limited: max 1 push per TOMBSTONE_PUSH_INTERVAL_MS (default 60s)
//
// Integration:
//   - runtime-heap-guardian.ts calls pushTombstone('OOM') before exit
//   - container-subsystem-runner.ts calls checkAndRestore() at startup
//   - cycle-cycle-manager.ts calls pushTombstone('cycle_end') on cycle end
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'tombstone') {
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
  console.error(`[ERROR] [tombstone] ${msg}`, err);
}

// ─── Constants ───
const DEFAULT_PUSH_INTERVAL_MS = 60 * 1000; // 60 seconds
const DEFAULT_MAX_SNAPSHOT_SIZE_BYTES = 100000; // 100KB
const TOMBSTONE_VERSION = 1;
const TOMBSTONE_DB_KEY = 'last_tombstone_ts';
const LOCAL_BACKUP_FILE = 'data/tombstone_latest.json.gz';

// ─── State ───
let _pushInterval: ReturnType<typeof setInterval> | null = null;
let _lastPushTime = 0;
let _lastPushSuccess = false;
let _pushCount = 0;
let _restoreChecked = false;

// ─── Snapshot Builder ───

/**
 * Gather a state snapshot from DB and in-memory deps.
 */
function buildSnapshot(triggerReason: string): Record<string, any> {
  const snapshot: Record<string, any> = {
    version: TOMBSTONE_VERSION,
    timestamp: Date.now(),
    triggerReason,
    pid: process.pid,
    heapUsedMB: 0,
    uptimeMs: 0,
    checkpoint: null,
    providerHealth: [],
    calibration: {},
    completedModules: [],
    lastState: null,
  };

  // Memory info
  try {
    const mem = process.memoryUsage();
    snapshot.heapUsedMB = +(mem.heapUsed / 1024 / 1024).toFixed(1);
    snapshot.uptimeMs = process.uptime() * 1000;
  } catch { /* non-critical */ }

  // Checkpoint data from statePersist
  try {
    const statePersist = (_deps as any).statePersist;
    if (statePersist?.loadCheckpoint) {
      snapshot.checkpoint = statePersist.loadCheckpoint();
    }
  } catch { /* non-critical */ }

  // DB data
  try {
    const db = (_deps as any).database;
    if (!db?.database) return snapshot;

    // Provider health from provider_registry
    try {
      const providers = db.database.prepare(
        'SELECT provider_name, endpoint, model, success_count, failure_count, total_latency, last_check FROM provider_registry'
      ).all() as any[];
      snapshot.providerHealth = providers.map((p: any) => ({
        name: p.provider_name,
        model: p.model,
        successCount: p.success_count,
        failureCount: p.failure_count,
        totalLatency: p.total_latency,
        lastCheck: p.last_check,
      }));
    } catch { /* table may not exist */ }

    // Calibration data (selective — only important keys)
    try {
      const importantKeys = [
        'env_var_hash', 'env_var_map', 'last_tombstone_ts',
        'current_module_index', 'best_provider', 'fallback_chain',
      ];
      const placeholders = importantKeys.map(() => '?').join(',');
      const rows = db.database.prepare(
        `SELECT k, v FROM calibration WHERE k IN (${placeholders})`
      ).all(...importantKeys) as any[];
      for (const row of rows) {
        snapshot.calibration[row.k] = row.v;
      }
    } catch { /* non-critical */ }

    // Completed modules
    try {
      snapshot.completedModules = db.database.prepare(
        'SELECT name, completed_at, attempts, completion_time_ms FROM completed_modules'
      ).all() as any[];
    } catch { /* non-critical */ }

    // Last state
    try {
      const lastState = db.database.prepare('SELECT url, state, timestamp FROM last_state LIMIT 1').get() as any;
      if (lastState) snapshot.lastState = lastState;
    } catch { /* non-critical */ }

  } catch (e: any) {
    logError('Failed to read DB for snapshot', e);
  }

  return snapshot;
}

/**
 * Compress a JSON string using gzip.
 */
function gzipCompress(data: string): Buffer {
  const zlib = require('zlib');
  return zlib.gzipSync(Buffer.from(data, 'utf-8'), { level: 9 });
}

/**
 * Decompress a gzip buffer back to string.
 */
function gzipDecompress(buffer: Buffer): string {
  const zlib = require('zlib');
  return zlib.gunzipSync(buffer).toString('utf-8');
}

// ─── Remote Push Targets ───

/**
 * Push to a generic TOMBSTONE_URL via HTTP POST.
 */
async function pushToGenericUrl(snapshotJson: string, triggerReason: string): Promise<boolean> {
  const url = (getCONFIG().TOMBSTONE_URL as string) || process.env.TOMBSTONE_URL;
  if (!url) return false;

  try {
    const compressed = gzipCompress(snapshotJson);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Encoding': 'gzip',
        'X-Tombstone-Reason': triggerReason,
        'X-Tombstone-Version': String(TOMBSTONE_VERSION),
        'X-Tombstone-PID': String(process.pid),
      },
      body: compressed,
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok) {
      log(`Pushed tombstone to TOMBSTONE_URL (status ${response.status}, ${compressed.length} bytes compressed)`, 'DEBUG');
      return true;
    }
    log(`TOMBSTONE_URL returned ${response.status}`, 'WARN');
    return false;
  } catch (e: any) {
    logError('Failed to push tombstone to TOMBSTONE_URL', e);
    return false;
  }
}

/**
 * Push to Discord webhook. Discord has a 2000 char limit per field,
 * so we split the snapshot into multiple embed fields if needed.
 */
async function pushToDiscord(snapshotJson: string, triggerReason: string): Promise<boolean> {
  const url = (getCONFIG().TOMBSTONE_DISCORD_URL as string) || process.env.TOMBSTONE_DISCORD_URL;
  if (!url) return false;

  try {
    const compressed = gzipCompress(snapshotJson);
    const compressedB64 = compressed.toString('base64');

    // Discord webhook payload
    const payload: Record<string, any> = {
      username: 'MathU Tombstone',
      embeds: [{
        title: `Tombstone: ${triggerReason}`,
        color: triggerReason.includes('OOM') || triggerReason.includes('CRASH') ? 0xFF0000 : 0xFFAA00,
        fields: [
          { name: 'Time', value: new Date().toISOString(), inline: true },
          { name: 'PID', value: String(process.pid), inline: true },
          { name: 'Size', value: `${compressed.length} bytes (compressed)`, inline: true },
          { name: 'Version', value: String(TOMBSTONE_VERSION), inline: true },
        ],
        description: '```\n' + compressedB64.substring(0, 1500) + (compressedB64.length > 1500 ? '...[truncated]' : '') + '\n```',
        timestamp: new Date().toISOString(),
      }],
    };

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });

    if (response.ok || response.status === 204) {
      log(`Pushed tombstone to Discord webhook (status ${response.status})`, 'DEBUG');
      return true;
    }
    log(`Discord webhook returned ${response.status}`, 'WARN');
    return false;
  } catch (e: any) {
    logError('Failed to push tombstone to Discord', e);
    return false;
  }
}

/**
 * Save tombstone to local file as gzip.
 */
function pushToLocalFile(snapshotJson: string): boolean {
  try {
    const fs = require('fs');
    const path = require('path');
    const dataDir = path.join(process.env.TMPDIR || '/tmp', 'mathu-data');

    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }

    const compressed = gzipCompress(snapshotJson);
    const filePath = path.join(dataDir, LOCAL_BACKUP_FILE);
    fs.writeFileSync(filePath, compressed);
    log(`Tombstone saved locally (${compressed.length} bytes at ${filePath})`, 'DEBUG');
    return true;
  } catch (e: any) {
    logError('Failed to save tombstone locally', e);
    return false;
  }
}

// ─── Public API ───

/**
 * Push a tombstone snapshot to all configured targets.
 * Called by heap guardian before OOM exit, and periodically.
 */
async function pushTombstone(triggerReason: string = 'periodic'): Promise<boolean> {
  // Rate limiting: don't push more than once per interval
  const now = Date.now();
  const interval = (getCONFIG().TOMBSTONE_PUSH_INTERVAL_MS as number) || DEFAULT_PUSH_INTERVAL_MS;
  if (now - _lastPushTime < interval && triggerReason === 'periodic') {
    return false;
  }

  // Build snapshot
  const snapshot = buildSnapshot(triggerReason);
  let snapshotJson: string;

  try {
    snapshotJson = JSON.stringify(snapshot);
  } catch (e: any) {
    logError('Failed to serialize snapshot', e);
    return false;
  }

  // Check size
  if (snapshotJson.length > DEFAULT_MAX_SNAPSHOT_SIZE_BYTES) {
    log(`Snapshot too large (${snapshotJson.length} bytes), truncating provider health`, 'WARN');
    snapshot.providerHealth = snapshot.providerHealth.map((p: any) => ({
      name: p.name, model: p.model, successCount: p.successCount, failureCount: p.failureCount,
    }));
    snapshotJson = JSON.stringify(snapshot);
  }

  _lastPushTime = now;
  _pushCount++;

  let anySuccess = false;

  // Try all targets (independent — one failure doesn't block others)
  const results = await Promise.allSettled([
    pushToGenericUrl(snapshotJson, triggerReason),
    pushToDiscord(snapshotJson, triggerReason),
  ]);

  for (const r of results) {
    if (r.status === 'fulfilled' && r.value) anySuccess = true;
  }

  // Always save locally as fallback
  const localOk = pushToLocalFile(snapshotJson);
  if (localOk) anySuccess = true;

  // Record timestamp in DB
  try {
    const db = (_deps as any).database;
    if (db?.database) {
      db.database.prepare(
        "INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)"
      ).run(TOMBSTONE_DB_KEY, String(now), now);
    }
  } catch { /* non-critical */ }

  _lastPushSuccess = anySuccess;
  log(`Tombstone push #${_pushCount} (reason: ${triggerReason}) — ${anySuccess ? 'success' : 'all targets failed'}`, anySuccess ? 'DEBUG' : 'WARN');

  return anySuccess;
}

/**
 * Check if a remote/local tombstone exists that's newer than local state,
 * and restore from it if needed. Called once at startup.
 */
async function checkAndRestore(): Promise<{ restored: boolean; details: string }> {
  if (_restoreChecked) return { restored: false, details: 'Already checked' };
  _restoreChecked = true;

  log('Checking for restorable tombstone...', 'INFO');

  // Check 1: Local file backup
  try {
    const fs = require('fs');
    const path = require('path');
    const dataDir = path.join(process.env.TMPDIR || '/tmp', 'mathu-data');
    const filePath = path.join(dataDir, LOCAL_BACKUP_FILE);

    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      const fileAgeMs = Date.now() - stat.mtimeMs;

      // Only consider if less than 24 hours old
      if (fileAgeMs < 24 * 60 * 60 * 1000) {
        const compressed = fs.readFileSync(filePath);
        const json = gzipDecompress(compressed);
        const snapshot = JSON.parse(json) as any;

        log(`Found local tombstone (${(fileAgeMs / 1000).toFixed(0)}s ago, v${snapshot.version}, trigger: ${snapshot.triggerReason})`, 'INFO');

        // Check if local checkpoint is older than tombstone
        const statePersist = (_deps as any).statePersist;
        const localCheckpoint = statePersist?.loadCheckpoint?.();

        if (!localCheckpoint || (snapshot.checkpoint?.savedAt && localCheckpoint.savedAt < snapshot.checkpoint.savedAt)) {
          // Restore checkpoint from tombstone
          if (snapshot.checkpoint && statePersist?.saveCheckpoint) {
            statePersist.saveCheckpoint(snapshot.checkpoint);
            log(`Restored checkpoint from tombstone (questionsCompleted: ${snapshot.checkpoint.questionsCompleted || 0})`, 'WARN');

            // Restore DB data if available
            await restoreDbFromSnapshot(snapshot);

            return { restored: true, details: `Restored from local tombstone (${(fileAgeMs / 1000).toFixed(0)}s old, ${snapshot.triggerReason})` };
          }
        } else {
          log('Local checkpoint is newer than tombstone — skipping restore', 'INFO');
        }
      } else {
        log(`Local tombstone too old (${(fileAgeMs / 1000 / 3600).toFixed(1)}h), ignoring`, 'DEBUG');
      }
    } else {
      log('No local tombstone found', 'DEBUG');
    }
  } catch (e: any) {
    logError('Failed to check local tombstone', e);
  }

  return { restored: false, details: 'No restorable tombstone found' };
}

/**
 * Restore DB tables from a tombstone snapshot.
 * Writes back completed_modules and calibration data.
 */
async function restoreDbFromSnapshot(snapshot: Record<string, any>): Promise<void> {
  try {
    const db = (_deps as any).database;
    if (!db?.database) return;

    // Restore completed_modules
    if (snapshot.completedModules && Array.isArray(snapshot.completedModules)) {
      const insert = db.database.prepare(
        'INSERT OR REPLACE INTO completed_modules (name, completed_at, attempts, completion_time_ms) VALUES (?, ?, ?, ?)'
      );
      for (const mod of snapshot.completedModules) {
        insert.run(mod.name, mod.completed_at, mod.attempts || 0, mod.completion_time_ms || 0);
      }
      log(`Restored ${snapshot.completedModules.length} completed modules from tombstone`, 'INFO');
    }

    // Restore calibration data
    if (snapshot.calibration && typeof snapshot.calibration === 'object') {
      const insert = db.database.prepare(
        'INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)'
      );
      const now = Date.now();
      for (const [k, v] of Object.entries(snapshot.calibration)) {
        insert.run(k, v as string, now);
      }
      log(`Restored ${Object.keys(snapshot.calibration).length} calibration entries from tombstone`, 'INFO');
    }

    // Restore last_state
    if (snapshot.lastState) {
      db.database.prepare(
        'INSERT OR REPLACE INTO last_state (url, state, timestamp) VALUES (?, ?, ?)'
      ).run(snapshot.lastState.url, snapshot.lastState.state, snapshot.lastState.timestamp);
    }
  } catch (e: any) {
    logError('Failed to restore DB from tombstone snapshot', e);
  }
}

/**
 * Start periodic tombstone pushing.
 */
function start(): void {
  const CONFIG = getCONFIG();
  const intervalMs = (CONFIG.TOMBSTONE_PUSH_INTERVAL_MS as number) || DEFAULT_PUSH_INTERVAL_MS;

  if (_pushInterval) {
    log('Tombstone pusher already running', 'WARN');
    return;
  }

  // Check if any push target is configured
  const hasTargets = !!(
    (CONFIG.TOMBSTONE_URL as string) || process.env.TOMBSTONE_URL ||
    (CONFIG.TOMBSTONE_DISCORD_URL as string) || process.env.TOMBSTONE_DISCORD_URL
  );

  log(`Starting tombstone pusher (interval=${intervalMs}ms, targets=${hasTargets ? 'remote+local' : 'local-only'})`, 'INFO');

  _pushInterval = setInterval(() => {
    try {
      pushTombstone('periodic').catch((e: any) => logError('Periodic tombstone push failed', e));
    } catch (e: any) {
      logError('Tombstone interval error', e);
    }
  }, intervalMs);

  if (_pushInterval && typeof _pushInterval.unref === 'function') {
    _pushInterval.unref();
  }
}

/**
 * Stop periodic tombstone pushing.
 */
function stop(): void {
  if (_pushInterval) {
    clearInterval(_pushInterval);
    _pushInterval = null;
    log('Tombstone pusher stopped', 'INFO');
  }
}

/**
 * Get tombstone status for diagnostics.
 */
function getStatus(): Record<string, any> {
  const fs = require('fs');
  const path = require('path');
  const filePath = path.join(process.cwd(), LOCAL_BACKUP_FILE);
  let localExists = false;
  let localSize = 0;
  let localAge = 0;
  try {
    if (fs.existsSync(filePath)) {
      const stat = fs.statSync(filePath);
      localExists = true;
      localSize = stat.size;
      localAge = Date.now() - stat.mtimeMs;
    }
  } catch { /* ok */ }

  return {
    pushIntervalRunning: _pushInterval !== null,
    pushCount: _pushCount,
    lastPushTime: _lastPushTime > 0 ? new Date(_lastPushTime).toISOString() : 'never',
    lastPushSuccess: _lastPushSuccess,
    lastPushAgeMs: _lastPushTime > 0 ? Date.now() - _lastPushTime : -1,
    restoreChecked: _restoreChecked,
    localBackup: { exists: localExists, sizeBytes: localSize, ageMs: localAge },
    hasRemoteTarget: !!(
      (getCONFIG().TOMBSTONE_URL as string) || process.env.TOMBSTONE_URL ||
      (getCONFIG().TOMBSTONE_DISCORD_URL as string) || process.env.TOMBSTONE_DISCORD_URL
    ),
  };
}

module.exports = {
  pushTombstone,
  checkAndRestore,
  buildSnapshot,
  restoreDbFromSnapshot,
  start,
  stop,
  getStatus,
  _injectDependencies,
};
