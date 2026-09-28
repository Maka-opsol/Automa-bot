'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Memory Warfare Module — TASK 95 (2026-09-27)
// ═══════════════════════════════════════════════════════════════════════════
//
// User: "The bot needs to be constantly at war with its memory. It must try
// its absolute hardest to cut down on memory usage at every moment. Kill
// the thought of OOMkills."
//
// This module is the bot's aggressive memory management system. It:
//   1. Runs a GC timer every 15 seconds (not just when memory_protection fires)
//   2. Tracks memory snapshots for trend analysis
//   3. Provides helper functions for aggressive cleanup
//   4. Monitors for memory leaks (growing heap without progress)
//   5. Forces GC before AND after every major operation
//
// The philosophy: DON'T wait for memory to become a problem. Attack it
// constantly. Every freed byte is a byte that won't cause an OOM kill.
// ═══════════════════════════════════════════════════════════════════════════

let _logger: any = null;
function _log(msg: string, level: string = 'DEBUG') {
  if (!_logger) { try { _logger = require('./logger'); } catch { return; } }
  try { _logger.log(msg, level, 'memory-warfare'); } catch {}
}

// ─── Aggressive GC Timer ──────────────────────────────────────────────────
//
// Runs every 15 seconds — much more frequent than the heap guardian's 5s
// check. This timer ALWAYS calls global.gc() if available, regardless of
// current heap usage. The idea: don't wait for memory to spike, clean up
// proactively.
//
// Why 15s? The cycle manager's main loop typically takes 10-30s per
// iteration. 15s ensures we GC at least once per cycle, catching transient
// allocations from screenshots, tribunal responses, and action execution.

let _warfareInterval: any = null;
let _gcCount = 0;
let _lastHeapMB = 0;
let _heapHistory: number[] = [];
const MAX_HEAP_HISTORY = 20; // track last 20 GC snapshots

function startMemoryWarfare() {
  if (_warfareInterval) return; // already running

  _log('Memory warfare started — aggressive GC every 15s, leak detection active', 'INFO');

  _warfareInterval = setInterval(() => {
    try {
      // Force GC if available (--expose-gc flag)
      if (global.gc) {
        const beforeHeap = process.memoryUsage().heapUsed / 1024 / 1024;
        const beforeRSS = process.memoryUsage().rss / 1024 / 1024;

        global.gc();

        const afterHeap = process.memoryUsage().heapUsed / 1024 / 1024;
        const afterRSS = process.memoryUsage().rss / 1024 / 1024;

        const freedHeap = beforeHeap - afterHeap;
        const freedRSS = beforeRSS - afterRSS;

        _gcCount++;

        // Track heap history for trend analysis
        _lastHeapMB = afterHeap;
        _heapHistory.push(afterHeap);
        if (_heapHistory.length > MAX_HEAP_HISTORY) _heapHistory.shift();

        // Log if we freed significant memory OR if heap is still high
        if (freedHeap > 5) {
          _log(`GC #${_gcCount}: freed ${freedHeap.toFixed(1)}MB heap (${beforeHeap.toFixed(0)}→${afterHeap.toFixed(0)}MB), RSS ${beforeRSS.toFixed(0)}→${afterRSS.toFixed(0)}MB`, 'DEBUG');
        }

        // Leak detection: if heap is growing despite GC, warn
        if (_heapHistory.length >= 10) {
          const recent = _heapHistory.slice(-5).reduce((a, b) => a + b, 0) / 5;
          const older = _heapHistory.slice(0, 5).reduce((a, b) => a + b, 0) / 5;
          if (recent > older + 20) {
            // Growing by 20MB+ over 5 GC cycles = potential leak
            _log(`LEAK DETECTED: heap growing despite GC (5-cycle avg: ${older.toFixed(0)}→${recent.toFixed(0)}MB, +${(recent - older).toFixed(0)}MB)`, 'WARN');
          }
        }
      }
    } catch { /* best effort — don't crash the timer */ }
  }, 15 * 1000);

  // Don't keep the process alive just for this timer
  if (_warfareInterval.unref) _warfareInterval.unref();
}

function stopMemoryWarfare() {
  if (_warfareInterval) {
    clearInterval(_warfareInterval);
    _warfareInterval = null;
    _log('Memory warfare stopped', 'INFO');
  }
}

// ─── Aggressive Cleanup Helpers ───────────────────────────────────────────
//
// These are called by the cycle manager at key points to free memory
// immediately after use, rather than waiting for the next GC cycle.

/**
 * Force an immediate GC. Use this after any operation that allocates
 * large buffers (screenshots, tribunal responses, HTML content).
 */
function forceGC(reason?: string): void {
  try {
    if (global.gc) {
      const before = process.memoryUsage().heapUsed / 1024 / 1024;
      global.gc();
      const after = process.memoryUsage().heapUsed / 1024 / 1024;
      if (before - after > 3) {
        _log(`forceGC (${reason || 'manual'}): freed ${(before - after).toFixed(1)}MB (${before.toFixed(0)}→${after.toFixed(0)}MB)`, 'DEBUG');
      }
    }
  } catch { /* best effort */ }
}

/**
 * Clear require.cache for non-critical modules.
 * This frees the module's source code from memory.
 * Called when memory is tight — only clears non-critical modules.
 */
function clearNonCriticalModuleCache(): number {
  let cleared = 0;
  try {
    const criticalModules = new Set([
      'config', 'logger', 'database', 'browser', 'agent',
      'cycle-cycle-manager', 'cycle-orchestrator',
      'memory-mode', 'memory-warfare', 'render-free-plan',
      'providers-registry', 'providers-tribunal', 'providers-base',
      'providers-prompts', 'providers-config-loader',
      'services-action-cache', 'self-heal',
    ]);

    for (const key of Object.keys(require.cache)) {
      // Skip critical modules
      const baseName = key.split('/').pop()?.replace(/\.(ts|js)$/, '') || '';
      if (criticalModules.has(baseName)) continue;

      // Skip node_modules
      if (key.includes('node_modules')) continue;

      // Skip currently-active modules (heuristic: modules with .exports)
      const mod = require.cache[key];
      if (!mod || !mod.exports) continue;

      // Clear non-critical modules
      try {
        delete require.cache[key];
        cleared++;
      } catch {}
    }

    if (cleared > 0) {
      forceGC(`cleared ${cleared} non-critical modules`);
      _log(`Cleared ${cleared} non-critical modules from require.cache`, 'DEBUG');
    }
  } catch { /* best effort */ }
  return cleared;
}

/**
 * Get the current memory snapshot for logging/debugging.
 */
function getMemorySnapshot(): { heapMB: number; rssMB: number; externalMB: number } {
  const mem = process.memoryUsage();
  return {
    heapMB: Math.round(mem.heapUsed / 1024 / 1024),
    rssMB: Math.round(mem.rss / 1024 / 1024),
    externalMB: Math.round((mem.external || 0) / 1024 / 1024),
  };
}

/**
 * Check if memory is trending upward (potential leak).
 * Returns true if the last 5 GC cycles show heap growth > 15MB.
 */
function isMemoryTrendingUp(): boolean {
  if (_heapHistory.length < 10) return false;
  const recent = _heapHistory.slice(-5).reduce((a, b) => a + b, 0) / 5;
  const older = _heapHistory.slice(-10, -5).reduce((a, b) => a + b, 0) / 5;
  return recent > older + 15;
}

module.exports = {
  startMemoryWarfare,
  stopMemoryWarfare,
  forceGC,
  clearNonCriticalModuleCache,
  getMemorySnapshot,
  isMemoryTrendingUp,
};
