'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// survival-restart-guardian.ts — Multi-Restart Memory Preservation
// ═══════════════════════════════════════════════════════════════════════════
// On Render free tier, if the process hits memory limits repeatedly,
// it means the normal tombstone/checkpoint system is not sufficient.
// This module activates ALL available memory preservation methods
// simultaneously when multiple unexpected restarts are detected.
//
// Trigger: 2+ restarts within 30 minutes without a clean shutdown marker.
// (Lowered from 3 because /tmp/ wipes make every OOM look like the first.)
//
// v4 REWRITE: DB-backed restart counting
//   Previous version stored all state in /tmp/ files which are wiped
//   on Render OOM restart, making restart counting impossible.
//   Now uses the calibration DB (synced via Turso) as the primary
//   restart counter, with /tmp/ as a secondary fast-read cache.
//
// v4: Also switches to memory_protection mode on OOM loop detection,
//   closes the browser, and forces aggressive Turso sync.
//
// When activated, this module:
//   1. Switches to memory_protection mode (disables heavy modules)
//   2. Forces a tombstone snapshot to ALL remote targets
//   3. Writes a comprehensive checkpoint
//   4. Dumps in-memory state to a compressed file
//   5. Closes the browser immediately (largest memory consumer)
//   6. Forces global GC
//   7. Forces Turso sync (push local DB to cloud)
//   8. Clears all caches
//
// Integration points:
//   - render-free-plan.ts: init() at startup, clean shutdown marker on exit
//   - runtime-heap-guardian.ts: preserveBeforeExit() before OOM exits
//   - container-subsystem-runner.ts: _injectDependencies() during init
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function _log(msg: string, level: string = 'INFO') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, 'restart-guardian'); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [restart-guardian] ${msg}`);
}

function _logError(msg: string, err: Error) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  console.error(`[ERROR] [restart-guardian] ${msg}`, err);
}

// ─── Configuration ──────────────────────────────────────────────────────────

const STATE_FILE = path.join(os.tmpdir(), 'mathu-restart-guardian-state.json');
const LAST_RESORT_FILE = path.join(os.tmpdir(), 'mathu-last-resort-state.json.gz');
const CLEAN_SHUTDOWN_MARKER = path.join(os.tmpdir(), 'mathu-clean-shutdown.json');

// v4: Lowered from 3 to 2 because /tmp/ wipes on Render OOM make every
// crash look like the first one. With DB backing, we can trust the count.
const RESTART_THRESHOLD = 2;
const RESTART_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// DB calibration key for restart history (survives /tmp/ wipes via Turso)
const DB_KEY_RESTART_HISTORY = 'restart_guardian_history';

// ─── State ──────────────────────────────────────────────────────────────────

interface RestartRecord {
  timestamp: number;
  pid: number;
  wasClean: boolean;
  heapUsedMB: number;
  uptimeMs: number;
  triggerReason?: string;
}

interface GuardianState {
  restarts: RestartRecord[];
  emergencyModeActive: boolean;
  emergencyActivatedAt: number | null;
  totalEmergencyActivations: number;
}

let _state: GuardianState = {
  restarts: [],
  emergencyModeActive: false,
  emergencyActivatedAt: null,
  totalEmergencyActivations: 0,
};

let _stateLoaded = false;
let _monitoringInterval: ReturnType<typeof setInterval> | null = null;

// ─── DB-backed Restart History ─────────────────────────────────────────────

/**
 * Load restart history from the calibration DB (primary source).
 * This survives /tmp/ wipes because Turso syncs the calibration table.
 */
function _loadRestartHistoryFromDB(): RestartRecord[] {
  try {
    const dbMod = require('./database');
    const selectCalibration = dbMod?.selectCalibration || dbMod?.db?.prepare?.('SELECT value FROM calibration WHERE key = ?')?.get;
    
    // Try the prepared statement approach first (unified-db pattern)
    if (dbMod?.selectCalibration) {
      const row = dbMod.selectCalibration.get(DB_KEY_RESTART_HISTORY);
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) return parsed;
      }
    }
    
    // Fallback: direct db.prepare
    if (dbMod?.db?.prepare) {
      const row = dbMod.db.prepare('SELECT value FROM calibration WHERE key = ?').get(DB_KEY_RESTART_HISTORY);
      if (row?.value) {
        const parsed = JSON.parse(row.value);
        if (Array.isArray(parsed)) return parsed;
      }
    }
  } catch { /* DB not ready or corrupt */ }
  return [];
}

/**
 * Save restart history to the calibration DB (sync write, guaranteed).
 */
function _saveRestartHistoryToDB(): void {
  try {
    const dbMod = require('./database');
    const value = JSON.stringify(_state.restarts.slice(-20)); // Keep last 20
    const now = Date.now();

    if (dbMod?.upsertCalibration) {
      dbMod.upsertCalibration.run(DB_KEY_RESTART_HISTORY, value, now);
    } else if (dbMod?.db?.prepare) {
      dbMod.db.prepare(
        'INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)'
      ).run(DB_KEY_RESTART_HISTORY, value, now);
    }
  } catch { /* DB not available — non-critical, /tmp/ file is the fallback */ }
}

// ─── State Persistence ──────────────────────────────────────────────────────

/** Load state from DB (primary) + /tmp file (secondary). */
function _loadState(): GuardianState {
  if (_stateLoaded) return _state;

  // Primary: load from DB (survives /tmp/ wipes via Turso)
  const dbRestarts = _loadRestartHistoryFromDB();
  if (dbRestarts.length > 0) {
    _state.restarts = dbRestarts;
    _log(`Loaded ${dbRestarts.length} restart records from DB`);
  }

  // Secondary: load emergency mode state from /tmp (same-instance only)
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (parsed) {
        // Merge: DB has authoritative restart history, /tmp has emergency state
        if (parsed.emergencyModeActive) {
          _state.emergencyModeActive = true;
          _state.emergencyActivatedAt = parsed.emergencyActivatedAt;
          _state.totalEmergencyActivations = parsed.totalEmergencyActivations || 0;
        }
        // If DB had no records but /tmp file does (shouldn't happen, but safety)
        if (_state.restarts.length === 0 && Array.isArray(parsed.restarts)) {
          _state.restarts = parsed.restarts;
        }
      }
    }
  } catch { /* corrupt or missing — DB data is sufficient */ }

  _stateLoaded = true;
  return _state;
}

/** Save state to both DB and /tmp file. */
function _saveState(): void {
  // Keep only last 20 restart records
  if (_state.restarts.length > 20) {
    _state.restarts = _state.restarts.slice(-20);
  }

  // Save to DB (primary — survives /tmp/ wipes)
  _saveRestartHistoryToDB();

  // Save to /tmp (secondary — fast reads, emergency mode state)
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2), 'utf8');
  } catch { /* best-effort */ }
}

// ─── Restart Tracking ──────────────────────────────────────────────────────

/**
 * Record a restart. Called at startup to track patterns.
 */
function recordRestart(wasClean: boolean = false, heapUsedMB: number = 0, uptimeMs: number = 0, triggerReason?: string): void {
  if (!_stateLoaded) _loadState();

  const record: RestartRecord = {
    timestamp: Date.now(),
    pid: process.pid,
    wasClean,
    heapUsedMB,
    uptimeMs,
    triggerReason,
  };

  _state.restarts.push(record);
  _saveState();

  // Clean shutdowns don't count toward the OOM threshold
  if (wasClean) {
    _log(`Clean shutdown recorded (uptime: ${Math.round(uptimeMs / 1000)}s). Not counting toward restart threshold.`);
    return;
  }

  // Check if we've exceeded the restart threshold
  const unexpectedRestarts = _getRecentUnexpectedRestarts();
  if (unexpectedRestarts.length >= RESTART_THRESHOLD) {
    _log(`OOM LOOP DETECTED: ${unexpectedRestarts.length} unexpected restarts within ${Math.round(RESTART_WINDOW_MS / 60000)}min. Activating emergency mode + memory protection.`, 'ERROR');
    _activateEmergencyMode(unexpectedRestarts);
  } else if (unexpectedRestarts.length >= 1) {
    _log(`Warning: ${unexpectedRestarts.length} unexpected restart(s) within ${Math.round(RESTART_WINDOW_MS / 60000)}min. Approaching threshold (${RESTART_THRESHOLD}).`, 'WARN');
  }
}

/** Get recent unexpected (non-clean) restarts within the window. */
function _getRecentUnexpectedRestarts(): RestartRecord[] {
  const now = Date.now();
  const windowStart = now - RESTART_WINDOW_MS;
  return _state.restarts.filter(r => !r.wasClean && r.timestamp >= windowStart);
}

// ─── Emergency Mode Activation ──────────────────────────────────────────────

/**
 * Activate ALL memory preservation methods when OOM loop is detected.
 * This is the nuclear option — it does everything possible to preserve state.
 */
function _activateEmergencyMode(recentRestarts: RestartRecord[]): void {
  if (_state.emergencyModeActive) {
    _log('Emergency mode already active — skipping re-activation', 'WARN');
    return;
  }

  _state.emergencyModeActive = true;
  _state.emergencyActivatedAt = Date.now();
  _state.totalEmergencyActivations++;
  _saveState();

  // ──── Method 0: Switch to memory_protection mode ────
  // This is the MOST IMPORTANT change. Previously the guardian
  // did preservation but never told memory-mode to switch,
  // so the bot kept OOMing even after detecting the loop.
  _switchToMemoryProtection('oom_loop_detected');

  // ──── Method 1: Force tombstone to ALL targets ────
  _pushEmergencyTombstone('OOM_LOOP');

  // ──── Method 2: Write comprehensive checkpoint ────
  _writeEmergencyCheckpoint();

  // ──── Method 3: Dump full in-memory state to compressed file ────
  _writeLastResortStateDump();

  // ──── Method 4: Close browser immediately ────
  _closeBrowserForMemory();

  // ──── Method 5: Force GC ────
  _forceGC();

  // ──── Method 6: Aggressive Turso sync ────
  _forceTursoSync();

  // ──── Method 7: Clear all caches ────
  _clearAllCaches();

  _log(`Emergency mode activated: memory_protection + ${7} preservation methods executed`, 'WARN');
}

/**
 * Switch to memory_protection mode via memory-mode module.
 * This disables heavy subsystems and tightens memory thresholds.
 */
function _switchToMemoryProtection(reason: string): void {
  try {
    const memoryMode = require('./memory-mode');
    if (memoryMode.getMode() !== 'memory_protection') {
      memoryMode.switchMode('memory_protection', reason);
      _log(`Switched to MEMORY PROTECTION mode: ${reason}`, 'WARN');
    }
  } catch (e: any) {
    _log(`Failed to switch to memory_protection: ${e.message}`, 'ERROR');
    // Fallback: set env vars directly
    const HEAVY_KEYS = [
      'BLACKBOX_FULL_ENABLED', 'ENABLE_EXPLORATION_PASS', 'ENABLE_ADAPTIVE_PERFORMANCE',
      'PROMPT_EVOLUTION_ENABLED', 'REGRESSION_BANK_ENABLED', 'PATCH_MEMORY_ENABLED',
      'HEAL_REWARD_TRACKER_ENABLED', 'SELF_HEAL_TIMELINE_ENABLED', 'EXTENDED_CHECKPOINT_ENABLED',
      'CANARY_ROLLOUT_ENABLED', 'DIFF_MINIMIZER_ENABLED', 'ENABLE_BLACKBOX',
      'POLICY_ACTION_VALIDATOR_ENABLED',
    ];
    for (const key of HEAVY_KEYS) process.env[key] = 'false';
  }
}

// ─── Individual Preservation Methods ──────────────────────────────────────

/** Method 1: Push tombstone to ALL remote targets + local. */
async function _pushEmergencyTombstone(reason: string): Promise<void> {
  try {
    const tombstone = (_deps as any).survivalTombstone;
    if (tombstone?.pushTombstone) {
      const result = await tombstone.pushTombstone(reason);
      _log(`Emergency tombstone pushed: ${result ? 'success' : 'all targets failed'}`, result ? 'INFO' : 'ERROR');
    } else {
      try {
        const mod = require('./survival-tombstone');
        if (mod?.pushTombstone) {
          await mod.pushTombstone(reason);
          _log('Emergency tombstone pushed (lazy-loaded)', 'INFO');
        }
      } catch { /* tombstone module not available */ }
    }
  } catch (e: any) {
    _logError('Emergency tombstone push failed', e);
  }
}

/** Method 2: Write comprehensive checkpoint. */
function _writeEmergencyCheckpoint(): void {
  try {
    const statePersist = (_deps as any).statePersist || require('./state-persist');
    if (statePersist?.saveCheckpoint) {
      const checkpointData: Record<string, any> = {
        emergencyMode: true,
        emergencyActivatedAt: _state.emergencyActivatedAt,
        restartCount: _getRecentUnexpectedRestarts().length,
        savedAt: Date.now(),
      };

      try {
        const existingCheckpoint = statePersist.loadCheckpoint?.();
        if (existingCheckpoint) {
          checkpointData.previousState = {
            questionsCompleted: existingCheckpoint.questionsCompleted || 0,
            currentState: existingCheckpoint.currentState,
            currentModule: existingCheckpoint.currentModule,
            url: existingCheckpoint.url,
          };
        }
      } catch {}

      try {
        const db = (_deps as any).database;
        if (db?.database) {
          try {
            const lastState = db.database.prepare('SELECT url, state, timestamp FROM last_state LIMIT 1').get();
            if (lastState) checkpointData.lastState = lastState;
          } catch {}
          try {
            const completed = db.database.prepare('SELECT COUNT(*) as count FROM completed_modules').get();
            if (completed) checkpointData.completedModulesCount = completed.count;
          } catch {}
        }
      } catch {}

      statePersist.saveCheckpoint(checkpointData);
      _log('Emergency checkpoint written', 'INFO');
    }
  } catch (e: any) {
    _logError('Emergency checkpoint failed', e);
  }
}

/** Method 3: Dump full state to compressed file. */
function _writeLastResortStateDump(): void {
  try {
    const dump: Record<string, any> = {
      version: 2,
      timestamp: Date.now(),
      pid: process.pid,
      heapUsedMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      restartHistory: _state.restarts.slice(-10),
      emergencyMode: true,
    };

    try {
      const sp = (_deps as any).statePersist || require('./state-persist');
      if (sp?.loadCheckpoint) dump.checkpoint = sp.loadCheckpoint();
    } catch {}

    try {
      const db = (_deps as any).database;
      if (db?.database) {
        try { dump.calibration = db.database.prepare('SELECT k, v FROM calibration').all(); } catch {}
        try { dump.completedModules = db.database.prepare('SELECT * FROM completed_modules').all(); } catch {}
        try { dump.lastState = db.database.prepare('SELECT * FROM last_state LIMIT 1').get(); } catch {}
        try { dump.providerRegistry = db.database.prepare('SELECT * FROM provider_registry').all(); } catch {}
        try { dump.modelRegistry = db.database.prepare('SELECT * FROM model_registry').all(); } catch {}
      }
    } catch {}

    try {
      const health = require('./providers-health');
      if (health?.getAllHealthSnapshots) dump.providerHealth = health.getAllHealthSnapshots();
    } catch {}

    try {
      const tombstone = (_deps as any).survivalTombstone || require('./survival-tombstone');
      if (tombstone?.buildSnapshot) dump.tombstoneSnapshot = tombstone.buildSnapshot('EMERGENCY_DUMP');
    } catch {}

    const json = JSON.stringify(dump);
    const compressed = zlib.gzipSync(Buffer.from(json, 'utf-8'), { level: 9 });
    fs.writeFileSync(LAST_RESORT_FILE, compressed);
    _log(`Last-resort state dump written (${compressed.length} bytes compressed, ${json.length} bytes uncompressed)`, 'INFO');
  } catch (e: any) {
    _logError('Last-resort state dump failed', e);
  }
}

/** Method 4: Close browser immediately. */
function _closeBrowserForMemory(): void {
  try {
    const browser = (_deps as any).browser;
    if (browser?.closeBrowser) {
      browser.closeBrowser().catch(() => {});
      _log('Browser closed for emergency memory preservation', 'WARN');
    }
  } catch {}
}

/** Method 5: Force garbage collection. */
function _forceGC(): void {
  try {
    if (global.gc) {
      global.gc();
      _log('Forced GC executed', 'DEBUG');
    }
  } catch {}
}

/** Method 6: Force Turso sync (push local DB to cloud). */
function _forceTursoSync(): void {
  try {
    const turso = (_deps as any).databaseTurso || require('./database-turso');
    if (turso?.forceSync) {
      turso.forceSync().then(() => {
        _log('Emergency Turso sync completed', 'INFO');
      }).catch((e: any) => {
        _logError('Emergency Turso sync failed', e);
      });
    }
  } catch {}
}

/** Method 7: Clear all caches. */
function _clearAllCaches(): void {
  try {
    const base = require('./providers-base');
    if (base?.coalescer?.clear) base.coalescer.clear();
  } catch {}
  try {
    const cache = (_deps as any).cache;
    if (cache?.clearCache) cache.clearCache();
  } catch {}
  _log('All caches cleared', 'DEBUG');
}

// ─── Pre-Exit Preservation ──────────────────────────────────────────────────

/**
 * Called by runtime-heap-guardian.ts BEFORE process.exit() on OOM.
 * Records the restart, activates emergency preservation, and pushes state to Turso.
 */
async function preserveBeforeExit(triggerReason: string = 'OOM'): Promise<void> {
  _log(`Pre-exit preservation triggered: ${triggerReason}`, 'ERROR');

  // Record this as a non-clean restart for next startup (writes to DB + /tmp)
  const mem = process.memoryUsage();
  recordRestart(false, Math.round(mem.heapUsed / 1024 / 1024), process.uptime() * 1000, triggerReason);

  // Execute ALL preservation methods
  const tasks: Promise<void>[] = [];
  tasks.push(_pushEmergencyTombstone(triggerReason).catch(() => {}));

  // Synchronous methods
  _writeEmergencyCheckpoint();
  _writeLastResortStateDump();
  _closeBrowserForMemory();
  _forceGC();
  _forceTursoSync();
  _clearAllCaches();

  // Wait for async tasks (with timeout)
  await Promise.race([
    Promise.allSettled(tasks),
    new Promise<void>(resolve => setTimeout(resolve, 5000)),
  ]);

  _log('Pre-exit preservation complete', 'INFO');
}

// ─── Clean Shutdown Marker ──────────────────────────────────────────────────

/**
 * Write a clean shutdown marker to /tmp. Called on graceful shutdown (SIGTERM).
 * The next startup reads this to distinguish clean vs OOM kills.
 * Note: This only works for same-instance restarts (SIGTERM spin-down).
 * For OOM kills (SIGKILL), the DB-backed restart history is used instead.
 */
function writeCleanShutdownMarker(): void {
  try {
    fs.writeFileSync(CLEAN_SHUTDOWN_MARKER, JSON.stringify({
      timestamp: Date.now(),
      pid: process.pid,
      reason: 'graceful_shutdown',
    }));
  } catch { /* best-effort */ }
}

/**
 * Check at startup if the previous exit was clean.
 * Returns true if the restart was unexpected (no clean shutdown marker).
 */
function wasUnexpectedRestart(): boolean {
  const markerExists = fs.existsSync(CLEAN_SHUTDOWN_MARKER);

  if (markerExists) {
    try { fs.unlinkSync(CLEAN_SHUTDOWN_MARKER); } catch {}
    return false;
  }

  return true;
}

// ─── Startup Init ───────────────────────────────────────────────────────────

/**
 * Initialize the restart guardian. Called once at startup from render-free-plan.ts.
 * Checks restart history (from DB + /tmp) and activates emergency mode if needed.
 *
 * @param deps - Optional dependencies (logger, database, browser, cache, etc.)
 * @returns {{ wasUnexpected, emergencyMode, recentRestartCount }}
 */
function init(deps?: Record<string, any>): { wasUnexpected: boolean; emergencyMode: boolean; recentRestartCount: number } {
  if (deps) _injectDependencies(deps);

  _loadState();

  const wasUnexpected = wasUnexpectedRestart();
  const mem = process.memoryUsage();

  if (wasUnexpected) {
    recordRestart(false, Math.round(mem.heapUsed / 1024 / 1024), 0, 'unexpected_restart');
  } else {
    recordRestart(true, Math.round(mem.heapUsed / 1024 / 1024), process.uptime() * 1000, 'clean_shutdown');
  }

  // Re-check after recording
  const updatedRestarts = _getRecentUnexpectedRestarts();
  if (updatedRestarts.length >= RESTART_THRESHOLD) {
    _log(`Startup: ${updatedRestarts.length} unexpected restarts in DB — emergency mode activating`, 'ERROR');
    _activateEmergencyMode(updatedRestarts);
  } else if (updatedRestarts.length >= 1) {
    // BUG FIX (2026-09-05): Do NOT switch to memory_protection on 1 restart.
    // The old code did `switchToMemoryProtection` as a "precaution" after just 1
    // unexpected restart. But this caused a death loop:
    //   1. Bot crashes (OOM or Render kernel kill)
    //   2. Restart guardian detects 1 unexpected restart → memory_protection
    //   3. memory_protection disables 20 modules but doesn't prevent the crash
    //   4. Bot crashes again (same root cause) → now 2 restarts → emergency mode
    //   5. Emergency mode makes things worse (more disabled modules, different code paths)
    // Now: only warn on 1 restart. Wait for 2+ before taking action.
    _log(`Startup: ${updatedRestarts.length} unexpected restart(s) in DB — monitoring (threshold: ${RESTART_THRESHOLD}). NOT switching to memory_protection yet — waiting for ${RESTART_THRESHOLD}+ restarts.`, 'WARN');
  }

  // Try to restore from last-resort dump if emergency mode is active
  if (_state.emergencyModeActive) {
    _attemptRestoreFromDump();
  }

  // Start periodic monitoring
  _startMonitoring();

  return {
    wasUnexpected,
    emergencyMode: _state.emergencyModeActive,
    recentRestartCount: updatedRestarts.length,
  };
}

/**
 * Attempt to restore state from the last-resort dump file.
 */
function _attemptRestoreFromDump(): void {
  try {
    if (!fs.existsSync(LAST_RESORT_FILE)) {
      _log('No last-resort dump found for restoration', 'DEBUG');
      return;
    }

    const compressed = fs.readFileSync(LAST_RESORT_FILE);
    const json = zlib.gunzipSync(compressed).toString('utf-8');
    const dump = JSON.parse(json);

    _log(`Found last-resort dump (from ${new Date(dump.timestamp).toISOString()})`, 'INFO');

    if (dump.checkpoint) {
      try {
        const sp = (_deps as any).statePersist || require('./state-persist');
        if (sp?.saveCheckpoint) {
          sp.saveCheckpoint(dump.checkpoint);
          _log('Restored checkpoint from last-resort dump', 'WARN');
        }
      } catch {}
    }

    try {
      const tombstone = (_deps as any).survivalTombstone || require('./survival-tombstone');
      if (tombstone?.restoreDbFromSnapshot) {
        tombstone.restoreDbFromSnapshot(dump);
        _log('Restored DB from last-resort dump', 'WARN');
      }
    } catch {}
  } catch (e: any) {
    _logError('Failed to restore from last-resort dump', e);
  }
}

/**
 * Start periodic monitoring.
 */
function _startMonitoring(): void {
  if (_monitoringInterval) return;

  _monitoringInterval = setInterval(() => {
    try {
      if (_state.emergencyModeActive) {
        _writeEmergencyCheckpoint();

        // Deactivate after 1 hour without further crashes
        const recent = _getRecentUnexpectedRestarts();
        const timeSinceActivation = Date.now() - (_state.emergencyActivatedAt || 0);
        if (timeSinceActivation > 60 * 60 * 1000 && recent.length < RESTART_THRESHOLD) {
          _state.emergencyModeActive = false;
          _saveState();
          _log('Emergency mode deactivated — stable for 1 hour', 'INFO');
        }
      }
    } catch (e: any) {
      _logError('Monitor tick failed', e);
    }
  }, 30000);

  if (_monitoringInterval?.unref) _monitoringInterval.unref();
}

/** Stop periodic monitoring. */
function stop(): void {
  if (_monitoringInterval) {
    clearInterval(_monitoringInterval);
    _monitoringInterval = null;
  }
}

// ─── Status / Query ──────────────────────────────────────────────────────────

/** Get diagnostic info. */
function getStatus(): Record<string, any> {
  const recent = _getRecentUnexpectedRestarts();
  return {
    emergencyModeActive: _state.emergencyModeActive,
    emergencyActivatedAt: _state.emergencyActivatedAt ? new Date(_state.emergencyActivatedAt).toISOString() : 'never',
    totalEmergencyActivations: _state.totalEmergencyActivations,
    recentUnexpectedRestarts: recent.length,
    restartThreshold: RESTART_THRESHOLD,
    restartWindowMinutes: RESTART_WINDOW_MS / 60000,
    lastResortDumpExists: fs.existsSync(LAST_RESORT_FILE),
    lastResortDumpSize: fs.existsSync(LAST_RESORT_FILE) ? fs.statSync(LAST_RESORT_FILE).size : 0,
    monitoringActive: _monitoringInterval !== null,
    totalRestartsRecorded: _state.restarts.length,
    dbBacked: true,
    recentRestartDetails: recent.slice(-5).map(r => ({
      time: new Date(r.timestamp).toISOString(),
      heapMB: r.heapUsedMB,
      trigger: r.triggerReason || 'unknown',
    })),
  };
}

/** Check if emergency mode is currently active. */
function isEmergencyMode(): boolean {
  return _state.emergencyModeActive;
}

/** Manually clear the restart history. */
function clearRestartHistory(): void {
  _state.restarts = [];
  _state.emergencyModeActive = false;
  _state.emergencyActivatedAt = null;
  _saveState();
  _log('Restart history cleared', 'INFO');
}

/**
 * Re-check restart history AFTER Turso sync has populated the local DB.
 *
 * On Render free tier, the local SQLite is empty after an OOM restart
 * (ephemeral disk wiped). init() runs before Turso sync, so it sees 0
 * restart records. This function is called after Turso pulls data from
 * the cloud, so the restart_guardian_history calibration entry is now
 * available.
 *
 * Returns true if emergency mode was activated by this recheck.
 */
function recheckAfterTursoSync(): { activated: boolean; recentCount: number } {
  // Force reload from DB (bypass _stateLoaded cache)
  _stateLoaded = false;
  _loadState();

  const recent = _getRecentUnexpectedRestarts();
  if (recent.length >= RESTART_THRESHOLD) {
    _log(`Post-Turso recheck: ${recent.length} unexpected restarts found in DB — activating emergency mode`, 'ERROR');
    _activateEmergencyMode(recent);
    return { activated: true, recentCount: recent.length };
  } else if (recent.length >= 1) {
    // BUG FIX (2026-09-05): Do NOT switch to memory_protection on 1 restart.
    // See init() for the full explanation.
    _log(`Post-Turso recheck: ${recent.length} unexpected restart(s) found — monitoring (NOT switching to memory_protection yet)`, 'WARN');
    return { activated: false, recentCount: recent.length };
  }

  return { activated: false, recentCount: 0 };
}

module.exports = {
  // Lifecycle
  init,
  stop,

  // Recording
  recordRestart,
  wasUnexpectedRestart,
  writeCleanShutdownMarker,

  // Emergency
  preserveBeforeExit,
  isEmergencyMode,
  activateEmergencyMode: () => _activateEmergencyMode(_getRecentUnexpectedRestarts()),

  // Post-Turso recheck
  recheckAfterTursoSync,

  // Status
  getStatus,
  clearRestartHistory,

  // DI
  _injectDependencies,
};
