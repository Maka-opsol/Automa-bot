// Resilience R1: Pre-OOM Euthanasia — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════
// runtime-heap-guardian.ts — P0 Pre-OOM Euthanasia
// ═══════════════════════════════════════════════════
// On Render free tier (512MB RAM), a runaway heap means SIGKILL
// with no recovery. This module monitors heap usage and performs
// graceful euthanasia BEFORE the OOM killer strikes.
//
// Two thresholds:
//   SOFT (380MB): force GC, close browser, clear caches → survive
//   HARD (450MB): force GC + tombstone checkpoint + process.exit(1)
//     → Render auto-restarts the service with clean state
//
// Integration:
//   - Started via container-subsystem-runner.ts (survival subsystem)
//   - survival-tombstone.pushTombstone() called before exit (if available)
//   - survival-restart-guardian.preserveBeforeExit() called for ALL methods
//   - cycle-cycle-manager.ts calls checkMemory() each loop iteration
// ═══════════════════════════════════════════════════

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

// ─── Thresholds (bytes) ───
const SOFT_THRESHOLD_MB = 380;
const HARD_THRESHOLD_MB = 450;
const CHECK_INTERVAL_MS = 10000;

// ─── State ───
let _monitorInterval: ReturnType<typeof setInterval> | null = null;
let _softTriggered = false;
let _hardTriggerCount = 0;
const MAX_HARD_TRIGGERS = 3; // If we keep hitting hard, something is deeply wrong

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
 * Attempt to free memory: GC, close browser, clear caches.
 * Returns true if memory dropped below soft threshold.
 */
function attemptMemoryRecovery(): boolean {
  const beforeMB = getHeapUsedMB();
  log(`Memory recovery started at ${beforeMB.toFixed(1)}MB`, 'WARN');

  // Step 1: Force GC if exposed
  try {
    if (global.gc) {
      global.gc();
      log('Forced garbage collection', 'DEBUG');
    }
  } catch (e: any) {
    logError('GC failed', e);
  }

  // Step 2: Close browser (biggest memory consumer)
  try {
    const browser = (_deps as any).browser;
    if (browser?.closeBrowser) {
      browser.closeBrowser().catch((e: any) => logError('Browser close during recovery failed', e));
      log('Browser close initiated for memory recovery', 'WARN');
    }
  } catch (e: any) {
    logError('Failed to close browser during recovery', e);
  }

  // Step 3: Clear caches
  try {
    const cache = (_deps as any).cache;
    if (cache?.clearCache) {
      cache.clearCache();
      log('Cache cleared for memory recovery', 'DEBUG');
    }
  } catch (e: any) {
    logError('Cache clear during recovery failed', e);
  }

  const afterMB = getHeapUsedMB();
  const freed = beforeMB - afterMB;
  log(`Memory recovery: ${beforeMB.toFixed(1)}MB → ${afterMB.toFixed(1)}MB (${freed >= 0 ? freed.toFixed(1) : '0'}MB freed)`, 'INFO');

  return afterMB < SOFT_THRESHOLD_MB;
}

/**
 * Push tombstone checkpoint before dying (if tombstone module available).
 * Lazy-loads to avoid hard dependency.
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
 * Activate ALL memory preservation methods via restart guardian.
 * This is the nuclear option — used when the process is about to die
 * from OOM and has had multiple unexpected restarts.
 */
async function _preserveWithAllMethods(triggerReason: string): Promise<void> {
  try {
    // Try the DI-injected dep first, then lazy-load
    const restartGuardian = (_deps as any).survivalRestartGuardian || require('./survival-restart-guardian');
    if (restartGuardian?.preserveBeforeExit) {
      await restartGuardian.preserveBeforeExit(triggerReason);
      log('ALL memory preservation methods activated via restart guardian', 'WARN');
      return;
    }
  } catch (e: any) {
    logError('Restart guardian preservation failed, falling back to tombstone only', e);
  }
  // Fallback to tombstone-only
  await pushTombstoneBeforeDeath();
}

/**
 * Check memory and take action. Called by interval monitor AND cycle loop.
 * Returns true if hard threshold was hit (caller should abort).
 */
function checkMemory(): boolean {
  const heapMB = getHeapUsedMB();
  const CONFIG = getCONFIG();
  const softThreshold = (CONFIG.HEAP_GUARDIAN_SOFT_THRESHOLD_MB as number) || SOFT_THRESHOLD_MB;
  const hardThreshold = (CONFIG.HEAP_GUARDIAN_HARD_THRESHOLD_MB as number) || HARD_THRESHOLD_MB;

  // Hard threshold — euthanasia
  if (heapMB >= hardThreshold) {
    _hardTriggerCount++;
    log(`HARD OOM THRESHOLD HIT: ${getMemorySnapshot()} (trigger #${_hardTriggerCount})`, 'FATAL');

    if (_hardTriggerCount >= MAX_HARD_TRIGGERS) {
      log(`Hard threshold hit ${MAX_HARD_TRIGGERS} times. Permanent shutdown.`, 'FATAL');
      // Don't restart — something is fundamentally broken
      process.exit(137); // SIGKILL equivalent
    }

    attemptMemoryRecovery();

    // Check if recovery helped
    const afterRecoveryMB = getHeapUsedMB();
    if (afterRecoveryMB >= hardThreshold) {
      log(`Memory still critical after recovery: ${afterRecoveryMB.toFixed(1)}MB. Exiting for Render restart.`, 'FATAL');
      // FIX: Use _preserveWithAllMethods instead of just tombstone.
      // This activates ALL memory preservation (tombstone + checkpoint +
      // compressed dump + Turso sync + cache clear) when OOM kills are
      // happening repeatedly, maximizing state survival across restarts.
      _preserveWithAllMethods('OOM_HARD_THRESHOLD').finally(() => {
        process.exit(1);
      });
      // Block the caller — we are about to die
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
    log(`SOFT OOM THRESHOLD HIT: ${getMemorySnapshot()}`, 'WARN');
    const recovered = attemptMemoryRecovery();
    if (!recovered) {
      log('Memory still above soft threshold after recovery. Continuing with reduced operations.', 'WARN');
    } else {
      log('Memory recovered below soft threshold.', 'INFO');
      _softTriggered = false;
    }
  } else if (heapMB < softThreshold - 20) {
    // Hysteresis: reset soft flag when well below threshold
    _softTriggered = false;
  }

  return false;
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

  const actualSoft = (getCONFIG().HEAP_GUARDIAN_SOFT_THRESHOLD_MB as number) || SOFT_THRESHOLD_MB;
  const actualHard = (getCONFIG().HEAP_GUARDIAN_HARD_THRESHOLD_MB as number) || HARD_THRESHOLD_MB;
  log(`Starting heap guardian (soft=${actualSoft}MB, hard=${actualHard}MB, interval=${intervalMs}ms)`, 'INFO');

  _monitorInterval = setInterval(() => {
    try {
      checkMemory();
    } catch (e: any) {
      logError('Heap guardian check failed', e);
    }
  }, intervalMs);

  // Don't prevent process exit
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
  return {
    heapUsedMB: getHeapUsedMB().toFixed(1),
    softTriggered: _softTriggered,
    hardTriggerCount: _hardTriggerCount,
    monitorRunning: _monitorInterval !== null,
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
