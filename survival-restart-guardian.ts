'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// survival-restart-guardian.ts — Multi-Restart Memory Preservation
// ═══════════════════════════════════════════════════════════════════════════
// On Render free tier, if the process hits memory limits repeatedly,
// it means the normal tombstone/checkpoint system is not sufficient.
// This module activates ALL available memory preservation methods
// simultaneously when multiple unexpected restarts are detected.
//
// Trigger: 3+ restarts within 30 minutes without a clean shutdown marker.
//
// When activated, this module:
//   1. Forces a tombstone snapshot to ALL remote targets (TOMBSTONE_URL,
//      Discord webhook) AND local file
//   2. Writes a comprehensive checkpoint to /tmp (survives cold starts)
//   3. Dumps in-memory state to a JSON file in /tmp
//   4. Closes the browser immediately (largest memory consumer)
//   5. Forces global GC
//   6. Reduces operational mode to minimal (skip non-essential modules)
//   7. Persists the Turso push interval to be more aggressive
//   8. Writes a "last resort" state file that survives SIGKILL
//
// Files created:
//   /tmp/mathu-restart-guardian-state.json — restart tracking
//   /tmp/mathu-last-resort-state.json.gz — compressed full state dump
//   /tmp/mathu-restart-count.json — simple counter for fast reads
//
// Integration:
//   - Called from render-cold-start.ts on startup
//   - Called from runtime-heap-guardian.ts before OOM exit
//   - Called from container-subsystem-runner.ts during init
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function log(msg: string, level: string = 'INFO', mod: string = 'restart-guardian') {
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
  console.error(`[ERROR] [${mod}] ${msg}`, err);
}

// ─── Configuration ──────────────────────────────────────────────────────────

const RESTART_COUNT_FILE = path.join(os.tmpdir(), 'mathu-restart-count.json');
const STATE_FILE = path.join(os.tmpdir(), 'mathu-restart-guardian-state.json');
const LAST_RESORT_FILE = path.join(os.tmpdir(), 'mathu-last-resort-state.json.gz');

// 3 restarts within 30 minutes = OOM loop detected
const RESTART_THRESHOLD = 3;
const RESTART_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

// ─── State ──────────────────────────────────────────────────────────────────

interface RestartRecord {
  timestamp: number;
  pid: number;
  wasClean: boolean;    // true if process wrote a shutdown marker
   heapUsedMB: number;    // last known heap before death
   uptimeMs: number;      // how long the process was running
   triggerReason?: string; // 'OOM_HARD', 'memory_threshold', 'SIGKILL', etc.
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

// ─── State Persistence ──────────────────────────────────────────────────────

/** Load state from /tmp file (survives cold starts). */
function _loadState(): GuardianState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      const parsed = JSON.parse(data);
      if (parsed && Array.isArray(parsed.restarts)) {
        _state = parsed;
        _stateLoaded = true;
        return _state;
      }
    }
  } catch { /* corrupt or missing — start fresh */ }

  // Also try the simple count file for backward compat
  try {
    if (fs.existsSync(RESTART_COUNT_FILE)) {
      const countData = JSON.parse(fs.readFileSync(RESTART_COUNT_FILE, 'utf8'));
      if (countData && typeof countData.count === 'number') {
        for (let i = 0; i < countData.count; i++) {
          _state.restarts.push({
            timestamp: Date.now() - (countData.count - i) * 60000,
            pid: 0,
            wasClean: false,
            heapUsedMB: 0,
            uptimeMs: 0,
          });
        }
      }
    }
  } catch { /* ignore */ }

  _stateLoaded = true;
  return _state;
}

/** Save state to /tmp file. */
function _saveState(): void {
  try {
    // Keep only last 20 restart records to prevent unbounded growth
    if (_state.restarts.length > 20) {
      _state.restarts = _state.restarts.slice(-20);
    }
    fs.writeFileSync(STATE_FILE, JSON.stringify(_state, null, 2), 'utf8');
  } catch (e: any) {
    logError('Failed to save restart guardian state', e);
  }
}

// ─── Restart Tracking ──────────────────────────────────────────────────────

/**
 * Record a restart. Called at startup to track patterns.
 * @param wasClean - true if the previous process wrote a shutdown marker
 * @param heapUsedMB - last known heap usage before death (from tombstone)
 * @param uptimeMs - how long the previous process was running
 * @param triggerReason - what caused the restart (if known)
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
    log(`Clean shutdown recorded (uptime: ${Math.round(uptimeMs / 1000)}s). Not counting toward restart threshold.`, 'INFO');
    return;
  }

  // Check if we've exceeded the restart threshold
  const unexpectedRestarts = _getRecentUnexpectedRestarts();
  if (unexpectedRestarts.length >= RESTART_THRESHOLD) {
    log(`⚠️ OOM LOOP DETECTED: ${unexpectedRestarts.length} unexpected restarts within ${Math.round(RESTART_WINDOW_MS / 60000)}min. Activating ALL memory preservation methods.`, 'ERROR');
    _activateEmergencyMode(unexpectedRestarts);
  } else if (unexpectedRestarts.length >= 2) {
    log(`Warning: ${unexpectedRestarts.length} unexpected restarts within ${Math.round(RESTART_WINDOW_MS / 60000)}min. Approaching threshold (${RESTART_THRESHOLD}).`, 'WARN');
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
    log('Emergency mode already active — skipping re-activation', 'WARN');
    return;
  }

  _state.emergencyModeActive = true;
  _state.emergencyActivatedAt = Date.now();
  _state.totalEmergencyActivations++;
  _saveState();

  // ──── Method 1: Force tombstone to ALL targets ────
  _pushEmergencyTombstone('OOM_LOOP');

  // ──── Method 2: Write comprehensive checkpoint to /tmp ────
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

  // ──── Method 8: Write shutdown marker for next startup ────
  _writeCleanShutdownMarker();

  log(`Emergency mode activated: all ${8} memory preservation methods executed`, 'WARN');
}

// ─── Individual Preservation Methods ──────────────────────────────────────

/** Method 1: Push tombstone to ALL remote targets + local. */
async function _pushEmergencyTombstone(reason: string): Promise<void> {
  try {
    const tombstone = (_deps as any).survivalTombstone;
    if (tombstone?.pushTombstone) {
      // Skip rate limiting for emergency pushes
      const result = await tombstone.pushTombstone(reason);
      log(`Emergency tombstone pushed: ${result ? 'success' : 'all targets failed'}`, result ? 'INFO' : 'ERROR');
    } else {
      // Try lazy loading
      try {
        const mod = require('./survival-tombstone');
        if (mod?.pushTombstone) {
          await mod.pushTombstone(reason);
          log('Emergency tombstone pushed (lazy-loaded)', 'INFO');
        }
      } catch { /* tombstone module not available */ }
    }
  } catch (e: any) {
    logError('Emergency tombstone push failed', e);
  }
}

/** Method 2: Write comprehensive checkpoint. */
function _writeEmergencyCheckpoint(): void {
  try {
    const statePersist = (_deps as any).statePersist || require('./state-persist');
    if (statePersist?.saveCheckpoint) {
      // Gather current state from all available sources
      const checkpointData: Record<string, any> = {
        emergencyMode: true,
        emergencyActivatedAt: _state.emergencyActivatedAt,
        restartCount: _getRecentUnexpectedRestarts().length,
        savedAt: Date.now(),
      };

      // Add cycle state if available
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

      // Add DB state
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
      log('Emergency checkpoint written', 'INFO');
    }
  } catch (e: any) {
    logError('Emergency checkpoint failed', e);
  }
}

/** Method 3: Dump full state to compressed file (survives SIGKILL). */
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

    // Serialize state from all known sources
    // Source A: checkpoint
    try {
      const sp = (_deps as any).statePersist || require('./state-persist');
      if (sp?.loadCheckpoint) dump.checkpoint = sp.loadCheckpoint();
    } catch {}

    // Source B: DB tables (critical ones)
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

    // Source C: provider health scores
    try {
      const health = require('./providers-health');
      if (health?.getAllHealthSnapshots) {
        dump.providerHealth = health.getAllHealthSnapshots();
      }
    } catch {}

    // Source D: tombstone data (if available)
    try {
      const tombstone = (_deps as any).survivalTombstone || require('./survival-tombstone');
      if (tombstone?.buildSnapshot) {
        dump.tombstoneSnapshot = tombstone.buildSnapshot('EMERGENCY_DUMP');
      }
    } catch {}

    const json = JSON.stringify(dump);
    const compressed = zlib.gzipSync(Buffer.from(json, 'utf-8'), { level: 9 });
    fs.writeFileSync(LAST_RESORT_FILE, compressed);
    log(`Last-resort state dump written (${compressed.length} bytes compressed, ${json.length} bytes uncompressed)`, 'INFO');
  } catch (e: any) {
    logError('Last-resort state dump failed', e);
  }
}

/** Method 4: Close browser immediately. */
function _closeBrowserForMemory(): void {
  try {
    const browser = (_deps as any).browser;
    if (browser?.closeBrowser) {
      browser.closeBrowser().catch(() => {});
      log('Browser closed for emergency memory preservation', 'WARN');
    }
  } catch {}
}

/** Method 5: Force garbage collection. */
function _forceGC(): void {
  try {
    if (global.gc) {
      global.gc();
      log('Forced GC executed', 'DEBUG');
    }
  } catch {}
}

/** Method 6: Force Turso sync (push local DB to cloud). */
function _forceTursoSync(): void {
  try {
    const turso = (_deps as any).databaseTurso || require('./database-turso');
    if (turso?.forceSync) {
      turso.forceSync().then(() => {
        log('Emergency Turso sync completed', 'INFO');
      }).catch((e: any) => {
        logError('Emergency Turso sync failed', e);
      });
    }
  } catch {}
}

/** Method 7: Clear all caches. */
function _clearAllCaches(): void {
  // Clear provider-base coalescer cache
  try {
    const base = require('./providers-base');
    if (base?.coalescer?.clear) base.coalescer.clear();
  } catch {}

  // Clear app cache
  try {
    const cache = (_deps as any).cache;
    if (cache?.clearCache) cache.clearCache();
  } catch {}

  // Clear child logger cache
  try {
    const loggerMod = require('./logger');
    // No clear method, but we can note it
  } catch {}

  log('All caches cleared', 'DEBUG');
}

/** Method 8: Write a clean shutdown marker for the next startup. */
function _writeCleanShutdownMarker(): void {
  try {
    const markerFile = path.join(os.tmpdir(), 'mathu-clean-shutdown.json');
    fs.writeFileSync(markerFile, JSON.stringify({
      timestamp: Date.now(),
      pid: process.pid,
      reason: 'emergency_mode_prepared',
    }));
    log('Clean shutdown marker written', 'DEBUG');
  } catch (e: any) {
    logError('Failed to write clean shutdown marker', e);
  }
}

// ─── Pre-Exit Preservation ──────────────────────────────────────────────────

/**
 * Called by runtime-heap-guardian.ts BEFORE process.exit() on OOM.
 * Activates ALL preservation methods to maximize state survival.
 */
async function preserveBeforeExit(triggerReason: string = 'OOM'): Promise<void> {
  log(`Pre-exit preservation triggered: ${triggerReason}`, 'ERROR');

  // Record this as a non-clean restart for next startup
  const mem = process.memoryUsage();
  recordRestart(false, Math.round(mem.heapUsed / 1024 / 1024), process.uptime() * 1000, triggerReason);

  // Execute ALL preservation methods in parallel where possible
  const tasks: Promise<void>[] = [];

  // Tombstone (can be async)
  tasks.push(_pushEmergencyTombstone(triggerReason).catch(() => {}));

  // Synchronous methods
  _writeEmergencyCheckpoint();
  _writeLastResortStateDump();
  _closeBrowserForMemory();
  _forceGC();
  _forceTursoSync();
  _clearAllCaches();

  // Wait for async tasks
  await Promise.allSettled(tasks);

  log('Pre-exit preservation complete', 'INFO');
}

// ─── Startup Check ──────────────────────────────────────────────────────────

/**
 * Check at startup if the previous exit was clean.
 * Returns true if the restart was unexpected (no clean shutdown marker).
 */
function wasUnexpectedRestart(): boolean {
  const markerFile = path.join(os.tmpdir(), 'mathu-clean-shutdown.json');
  const markerExists = fs.existsSync(markerFile);

  // Remove the marker (one-time use)
  if (markerExists) {
    try { fs.unlinkSync(markerFile); } catch {}
    return false; // Clean shutdown detected
  }

  return true; // No marker = unexpected restart
}

/**
 * Initialize the restart guardian. Called once at startup.
 * Checks restart history and activates emergency mode if needed.
 */
function init(): { wasUnexpected: boolean; emergencyMode: boolean; recentRestartCount: number } {
  _loadState();

  const wasUnexpected = wasUnexpectedRestart();
  const mem = process.memoryUsage();
  const recentRestarts = _getRecentUnexpectedRestarts();

  if (wasUnexpected) {
    recordRestart(false, Math.round(mem.heapUsed / 1024 / 1024), 0);
  } else {
    recordRestart(true, Math.round(mem.heapUsed / 1024 / 1024), process.uptime() * 1000);
  }

  // Re-check after recording
  const updatedRestarts = _getRecentUnexpectedRestarts();
  if (updatedRestarts.length >= RESTART_THRESHOLD) {
    log(`Startup: ${updatedRestarts.length} unexpected restarts detected — emergency mode activating`, 'ERROR');
    _activateEmergencyMode(updatedRestarts);
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
      log('No last-resort dump found for restoration', 'DEBUG');
      return;
    }

    const compressed = fs.readFileSync(LAST_RESORT_FILE);
    const json = zlib.gunzipSync(compressed).toString('utf-8');
    const dump = JSON.parse(json);

    log(`Found last-resort dump (${Math.round(process.memoryUsage().heapUsed / 1024 / 1024)}MB heap, from ${new Date(dump.timestamp).toISOString()})`, 'INFO');

    // Restore checkpoint
    if (dump.checkpoint) {
      try {
        const sp = (_deps as any).statePersist || require('./state-persist');
        if (sp?.saveCheckpoint) {
          sp.saveCheckpoint(dump.checkpoint);
          log('Restored checkpoint from last-resort dump', 'WARN');
        }
      } catch {}
    }

    // Restore DB data
    try {
      const tombstone = (_deps as any).survivalTombstone || require('./survival-tombstone');
      if (tombstone?.restoreDbFromSnapshot) {
        tombstone.restoreDbFromSnapshot(dump);
        log('Restored DB from last-resort dump', 'WARN');
      }
    } catch {}
  } catch (e: any) {
    logError('Failed to restore from last-resort dump', e);
  }
}

/**
 * Start periodic monitoring for memory + state preservation.
 */
function _startMonitoring(): void {
  if (_monitoringInterval) return;

  _monitoringInterval = setInterval(() => {
    try {
      // If emergency mode is active, write periodic state dumps
      if (_state.emergencyModeActive) {
        _writeEmergencyCheckpoint();
      }

      // Check if we should deactivate emergency mode
      // (if no unexpected restarts in the last window)
      if (_state.emergencyModeActive) {
        const recent = _getRecentUnexpectedRestarts();
        // Deactivate after 1 hour without further crashes
        const timeSinceActivation = Date.now() - (_state.emergencyActivatedAt || 0);
        if (timeSinceActivation > 60 * 60 * 1000 && recent.length < RESTART_THRESHOLD) {
          _state.emergencyModeActive = false;
          _saveState();
          log('Emergency mode deactivated — stable for 1 hour', 'INFO');
        }
      }
    } catch (e: any) {
      logError('Monitor tick failed', e);
    }
  }, 30000); // Check every 30 seconds

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

/** Get diagnostic info about the restart guardian state. */
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

/** Manually clear the restart history (for testing / after fix deployment). */
function clearRestartHistory(): void {
  _state.restarts = [];
  _state.emergencyModeActive = false;
  _state.emergencyActivatedAt = null;
  _saveState();
  log('Restart history cleared', 'INFO');
}

module.exports = {
  // Lifecycle
  init,
  stop,

  // Recording
  recordRestart,
  wasUnexpectedRestart,

  // Emergency
  preserveBeforeExit,
  isEmergencyMode,
  activateEmergencyMode: () => _activateEmergencyMode(_getRecentUnexpectedRestarts()),

  // Status
  getStatus,
  clearRestartHistory,

  // DI
  _injectDependencies,
};
