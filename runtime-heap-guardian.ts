// Resilience R1: Pre-OOM Euthanasia — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// runtime-heap-guardian.ts — P0 Pre-OOM Euthanasia
// ═══════════════════════════════════════════════════════════════
// On Render free tier (512MB RAM), a runaway heap means SIGKILL
// with no recovery. This module monitors heap usage and performs
// graceful euthanasia BEFORE the OOM killer strikes.
//
// v3 FIX: Thresholds are now MODE-AWARE. Previously used hardcoded
//   soft=380MB/hard=450MB which ignored memory-mode entirely.
//   Now reads from memory-mode thresholds:
//     full_power:       soft=350MB, hard=400MB
//     memory_protection: soft=250MB, hard=280MB
//   This ensures the heap guardian reacts much earlier in protection
//   mode, instead of letting memory climb to 380MB while protection
//   mode thinks it should restart at 280MB.
//
// v3 FIX: On soft threshold, also calls memoryMode.shedMemory() for
//   more aggressive recovery than just GC + browser close.
//
// v3 FIX: On hard threshold, records OOM exit to DB BEFORE attempting
//   recovery (not after). Previously if recovery freed enough memory
//   to avoid the exit path, the OOM event was never recorded, and the
//   next restart wouldn't know it was in danger.
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'heap-guardian') {
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
  console.error(`[ERROR] [heap-guardian] ${msg}`, err);
}

// ─── Fallback thresholds (used only if memory-mode unavailable) ───
const FALLBACK_SOFT_THRESHOLD_MB = 350;
const FALLBACK_HARD_THRESHOLD_MB = 400;
const CHECK_INTERVAL_MS = 10000;

// ─── State ───
let _monitorInterval: ReturnType<typeof setInterval> | null = null;
let _softTriggered = false;
let _hardTriggerCount = 0;
const MAX_HARD_TRIGGERS = 3;

/**
 * Get mode-aware thresholds from memory-mode, with fallbacks.
 * v3 FIX: This is the key change — previously used hardcoded 380/450.
 */
function _getThresholds(): { softMB: number; hardMB: number } {
  try {
    const memoryMode = require('./memory-mode');
    const t = memoryMode.getThresholds();
    return {
      // Soft = warn threshold (first recovery attempt)
      softMB: t.warnHeapMB || FALLBACK_SOFT_THRESHOLD_MB,
      // Hard = restart threshold (euthanasia)
      hardMB: t.restartHeapMB || FALLBACK_HARD_THRESHOLD_MB,
    };
  } catch {
    return { softMB: FALLBACK_SOFT_THRESHOLD_MB, hardMB: FALLBACK_HARD_THRESHOLD_MB };
  }
}

/**
 * Get current heap usage in MB.
 */
function getHeapUsedMB(): number {
  const mem = process.memoryUsage();
  return mem.heapUsed / 1024 / 1024;
}

/**
 * Get a human-readable memory snapshot for logging.
 */
function getMemorySnapshot(): string {
  const mem = process.memoryUsage();
  return `heap=${(mem.heapUsed / 1024 / 1024).toFixed(1)}MB ` +
    `rss=${(mem.rss / 1024 / 1024).toFixed(1)}MB ` +
    `arrayBuffers=${(mem.arrayBuffers / 1024 / 1024).toFixed(1)}MB ` +
    `external=${(mem.external / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * Attempt to free memory: GC, close browser, clear caches, shed.
 * v3: Now also calls memoryMode.shedMemory() for comprehensive cleanup.
 * Returns true if memory dropped below soft threshold after recovery.
 */
function attemptMemoryRecovery(): boolean {
  const beforeMB = getHeapUsedMB();
  log(`Memory recovery started at ${beforeMB.toFixed(1)}MB`, 'WARN');

  // Step 1: Use memory-mode's comprehensive shed (browser, caches, GC, etc.)
  try {
    const memoryMode = require('./memory-mode');
    if (memoryMode.shedMemory) {
      memoryMode.shedMemory('heap-guardian-soft');
    }
  } catch { /* memory-mode not available, fall through to manual steps */ }

  // Step 2: Force GC if exposed (shedMemory already does this, but double-check)
  try {
    if (global.gc) {
      global.gc();
      log('Forced garbage collection (backup)', 'DEBUG');
    }
  } catch (e: any) {
    logError('GC failed', e);
  }

  const afterMB = getHeapUsedMB();
  const thresholds = _getThresholds();
  const freed = beforeMB - afterMB;
  log(`Memory recovery: ${beforeMB.toFixed(1)}MB → ${afterMB.toFixed(1)}MB (${freed >= 0 ? freed.toFixed(1) : '0'}MB freed, soft threshold=${thresholds.softMB}MB)`, 'INFO');

  return afterMB < thresholds.softMB;
}

/**
 * Push tombstone checkpoint before dying (if tombstone module available).
 */
async function pushTombstoneBeforeDeath(): Promise<void> {
  try {
    const tombstone = (_deps as any).survivalTombstone;
    if (tombstone?.pushTombstone) {
      await tombstone.pushTombstone('OOM_HARD_THRESHOLD');
      log('Tombstone pushed before OOM exit', 'INFO');
    }
  } catch (e: any) {
    logError('Failed to push tombstone before OOM exit', e);
  }
}

/**
 * Check memory and take action. Called by interval monitor AND cycle loop.
 * Returns true if hard threshold was hit (caller should abort).
 */
function checkMemory(): boolean {
  const heapMB = getHeapUsedMB();
  const thresholds = _getThresholds();
  const softThreshold = (getCONFIG().HEAP_GUARDIAN_SOFT_THRESHOLD_MB as number) || thresholds.softMB;
  const hardThreshold = (getCONFIG().HEAP_GUARDIAN_HARD_THRESHOLD_MB as number) || thresholds.hardMB;

  // Hard threshold — euthanasia
  if (heapMB >= hardThreshold) {
    _hardTriggerCount++;
    log(`HARD OOM THRESHOLD HIT: ${getMemorySnapshot()} (trigger #${_hardTriggerCount}, mode=${_getModeName()})`, 'FATAL');

    // v3 FIX: Record OOM BEFORE attempting recovery.
    // Previously, if recovery succeeded, the OOM event was never recorded,
    // so the next restart wouldn't know it was in danger.
    try {
      const memoryMode = require('./memory-mode');
      const mem = process.memoryUsage();
      memoryMode.recordOOMExit(mem.heapUsed / 1024 / 1024, mem.rss / 1024 / 1024);
    } catch { /* best-effort */ }

    if (_hardTriggerCount >= MAX_HARD_TRIGGERS) {
      log(`Hard threshold hit ${MAX_HARD_TRIGGERS} times. Permanent shutdown.`, 'FATAL');
      const origExit = (process as any)._originalExit || process.exit.bind(process);
      origExit(137);
    }

    attemptMemoryRecovery();

    const afterRecoveryMB = getHeapUsedMB();
    if (afterRecoveryMB >= hardThreshold) {
      log(`Memory still critical after recovery: ${afterRecoveryMB.toFixed(1)}MB. Exiting for Render restart.`, 'FATAL');
      pushTombstoneBeforeDeath().finally(() => {
        const origExit = (process as any)._originalExit || process.exit.bind(process);
        origExit(1);
      });
      return true;
    } else {
      log(`Memory recovered below hard threshold: ${afterRecoveryMB.toFixed(1)}MB`, 'INFO');
      _softTriggered = true;
    }
    return false;
  }

  // Soft threshold — recovery attempt
  if (heapMB >= softThreshold && !_softTriggered) {
    _softTriggered = true;
    log(`SOFT OOM THRESHOLD HIT: ${getMemorySnapshot()} (mode=${_getModeName()})`, 'WARN');
    const recovered = attemptMemoryRecovery();
    if (!recovered) {
      log('Memory still above soft threshold after recovery. Continuing with reduced operations.', 'WARN');
    } else {
      log('Memory recovered below soft threshold.', 'INFO');
      _softTriggered = false;
    }
  } else if (heapMB < softThreshold - 20) {
    _softTriggered = false;
  }

  return false;
}

/** Get current mode name for logging */
function _getModeName(): string {
  try {
    const memoryMode = require('./memory-mode');
    return memoryMode.getMode();
  } catch { return 'unknown'; }
}

/**
 * Start the periodic memory monitor.
 */
function start(): void {
  const CONFIG = getCONFIG();
  const intervalMs = (CONFIG.HEAP_GUARDIAN_CHECK_INTERVAL_MS as number) || CHECK_INTERVAL_MS;

  if (_monitorInterval) {
    log('Heap guardian already running', 'WARN');
    return;
  }

  const actualThresholds = _getThresholds();
  log(`Starting heap guardian (soft=${actualThresholds.softMB}MB, hard=${actualThresholds.hardMB}MB, interval=${intervalMs}ms, mode=${_getModeName()})`, 'INFO');

  _monitorInterval = setInterval(() => {
    try {
      checkMemory();
    } catch (e: any) {
      logError('Heap guardian check failed', e);
    }
  }, intervalMs);

  if (_monitorInterval && typeof _monitorInterval.unref === 'function') {
    _monitorInterval.unref();
  }
}

/**
 * Stop the periodic memory monitor.
 */
function stop(): void {
  if (_monitorInterval) {
    clearInterval(_monitorInterval);
    _monitorInterval = null;
    log('Heap guardian stopped', 'INFO');
  }
}

/**
 * Get diagnostic info about heap guardian state.
 */
function getStatus(): Record<string, any> {
  const thresholds = _getThresholds();
  return {
    heapUsedMB: getHeapUsedMB().toFixed(1),
    softThresholdMB: thresholds.softMB,
    hardThresholdMB: thresholds.hardMB,
    softTriggered: _softTriggered,
    hardTriggerCount: _hardTriggerCount,
    monitorRunning: _monitorInterval !== null,
    mode: _getModeName(),
    snapshot: getMemorySnapshot(),
  };
}

module.exports = {
  checkMemory,
  start,
  stop,
  getStatus,
  getHeapUsedMB,
  _injectDependencies,
};
