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
const FALLBACK_SOFT_THRESHOLD_MB = 200;
const FALLBACK_HARD_THRESHOLD_MB = 220;
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
 * v5 FIX: Now async — awaits shedMemory so browser cleanup actually completes.
 * v5 FIX: Does a second GC after 1s delay to reclaim objects freed by async cleanup.
 * v6 FIX: Accepts preserveBrowser option to avoid closing browser mid-quiz.
 * Returns true if memory dropped below soft threshold after recovery.
 */
async function attemptMemoryRecovery(options?: { preserveBrowser?: boolean }): Promise<boolean> {
  const preserveBrowser = options?.preserveBrowser ?? false;
  const beforeMB = getHeapUsedMB();
  log(`Memory recovery started at ${beforeMB.toFixed(1)}MB, preserveBrowser=${preserveBrowser}`, 'WARN');

  // Step 1: Use memory-mode's graduated shed
  // v6: Pass preserveBrowser and targetMB to stop early if we free enough
  const thresholds = _getThresholds();
  try {
    const memoryMode = require('./memory-mode');
    if (memoryMode.shedMemory) {
      await memoryMode.shedMemory('heap-guardian-soft', {
        preserveBrowser,
        targetMB: thresholds.softMB - 20, // aim 20MB below soft threshold
      });
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

  // Step 3: v5 FIX — Second GC after brief pause.
  // Browser cleanup and cache clearing free objects asynchronously.
  // A second GC pass after 1s catches stragglers that the first pass missed.
  // This replaces the old 3s .unref() timeout that NEVER fired on the
  // hard-threshold exit path.
  await new Promise(resolve => setTimeout(resolve, 1000));
  try {
    if (global.gc) {
      global.gc();
      log('Second GC pass (post-async-cleanup)', 'DEBUG');
    }
  } catch { /* ignore */ }

  const afterMB = getHeapUsedMB();
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
 * v5 FIX: Now async — awaits memory recovery so browser is actually freed.
 * v6 FIX: Accepts preserveBrowser option for mid-quiz protection.
 * Returns true if hard threshold was hit (caller should abort).
 */
async function checkMemory(options?: { preserveBrowser?: boolean }): Promise<boolean> {
  const preserveBrowser = options?.preserveBrowser ?? false;
  const mem = process.memoryUsage();
  const heapMB = mem.heapUsed / 1024 / 1024;
  const rssMB = mem.rss / 1024 / 1024;
  const thresholds = _getThresholds();
  const softThreshold = (getCONFIG().HEAP_GUARDIAN_SOFT_THRESHOLD_MB as number) || thresholds.softMB;
  const hardThreshold = (getCONFIG().HEAP_GUARDIAN_HARD_THRESHOLD_MB as number) || thresholds.hardMB;

  // v8: RSS-based hard kill. On 512MB, if RSS > 430MB, the kernel OOM
  // killer is imminent. Close the browser immediately regardless of heap.
  // RSS includes Chromium native memory that heap monitoring can't see.
  const RSS_HARD_KILL_MB = 430;
  if (rssMB >= RSS_HARD_KILL_MB) {
    log(`RSS HARD LIMIT: ${getMemorySnapshot()} (rss=${rssMB.toFixed(1)}MB > ${RSS_HARD_KILL_MB}MB)`, 'FATAL');
    try {
      const memoryMode = require('./memory-mode');
      memoryMode.recordOOMExit(heapMB, rssMB);
      // Force L3 (close browser) — don't preserve it, kernel is about to kill us
      await memoryMode.shedMemory(`rss-hard-limit:${rssMB.toFixed(0)}MB`, { preserveBrowser: false, maxLevel: 3 });
      if (global.gc) { try { global.gc(); } catch {} }
    } catch { /* best effort */ }
    const afterMB = getHeapUsedMB();
    const afterRSS = process.memoryUsage().rss / 1024 / 1024;
    if (afterRSS >= RSS_HARD_KILL_MB - 30) {
      // Still critical after browser close — preserve and exit
      log(`RSS still critical after browser close: ${afterRSS.toFixed(1)}MB. Preserving and exiting.`, 'FATAL');
      try {
        const guardian = require('./survival-restart-guardian');
        if (guardian?.preserveBeforeExit) {
          guardian.preserveBeforeExit('OOM_RSS_HARD_LIMIT').finally(() => {
            const origExit = (process as any)._originalExit || process.exit.bind(process);
            origExit(137);
          });
          return true;
        }
      } catch {}
      const origExit = (process as any)._originalExit || process.exit.bind(process);
      origExit(137);
    }
    log(`RSS recovered after browser close: ${afterRSS.toFixed(1)}MB`, 'INFO');
  }

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
      // v4: Run full preservation before exiting (tombstone, checkpoint, Turso sync, caches)
      try {
        const guardian = require('./survival-restart-guardian');
        if (guardian?.preserveBeforeExit) {
          guardian.preserveBeforeExit('OOM_HARD_THRESHOLD_3x').finally(() => {
            const origExit = (process as any)._originalExit || process.exit.bind(process);
            origExit(137);
          });
          return true; // Don't fall through to recovery
        }
      } catch { /* guardian not available */ }
      const origExit = (process as any)._originalExit || process.exit.bind(process);
      origExit(137);
    }

    // v5 FIX: await the recovery so browser actually closes BEFORE we check
    // if memory is still critical. Old code fire-and-forget'd this, so heap
    // was still at 300MB+ when the "still critical" check ran.
    // v6 FIX: pass preserveBrowser — on hard threshold, still try to save the page
    // unless the caller explicitly said not to. But if we're on the 3rd
    // hard trigger, preserveBrowser is overridden (bot is dying anyway).
    const hardPreserve = _hardTriggerCount >= MAX_HARD_TRIGGERS - 1 ? false : preserveBrowser;
    await attemptMemoryRecovery({ preserveBrowser: hardPreserve });

    const afterRecoveryMB = getHeapUsedMB();
    if (afterRecoveryMB >= hardThreshold) {
      log(`Memory still critical after recovery: ${afterRecoveryMB.toFixed(1)}MB. Exiting for Render restart.`, 'FATAL');
      // v4: Use restart guardian's comprehensive preservation (includes tombstone + more)
      try {
        const guardian = require('./survival-restart-guardian');
        if (guardian?.preserveBeforeExit) {
          guardian.preserveBeforeExit('OOM_RECOVERY_FAILED').finally(() => {
            const origExit = (process as any)._originalExit || process.exit.bind(process);
            origExit(1);
          });
          return true;
        }
      } catch { /* guardian not available, fall through to original logic */ }
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
    // v5 FIX: await the recovery
    // v6 FIX: pass preserveBrowser for soft threshold too
    const recovered = await attemptMemoryRecovery({ preserveBrowser });
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
      checkMemory().catch((e: any) => logError('Async heap guardian check failed', e));
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
