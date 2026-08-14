'use strict';

const { classifyError } = require('./errors');

// NOTE: Logger is required lazily inside event handlers because this module
// is loaded FIRST (before DI container initializes logger) via require('./error-handler')
// at the top of agent.ts. This is intentional — do not convert to top-level require.

const isHFSpaces = !!(process.env.PORT || process.env.SPACE_ID || process.env.SPACE_AUTHOR_NAME);

process.on('uncaughtException', (err: Error, origin: string): void => {
  // MUST NOT throw — this is the last line of defense.
  // Any exception here becomes a true unhandleable crash.
  try {
    const { safeLog } = require('./logger');
    let classified;
    try {
      classified = classifyError(err);
    } catch {
      // classifyError itself crashed (corrupted prototypes under memory pressure)
      classified = null;
    }
    if (classified) {
      safeLog({
        type: 'UNCAUGHT_EXCEPTION',
        error: {
          name: classified.name,
          code: classified.code,
          message: classified.message,
          stack: classified.stack?.split?.('\n')?.slice?.(0, 10),
        },
        classified: typeof classified.toJSON === 'function' ? classified.toJSON() : { name: 'unknown', message: String(err), code: 'E_UNKNOWN' },
        origin,
      }, 'FATAL', 'error-handler');
    } else {
      safeLog({
        type: 'UNCAUGHT_EXCEPTION',
        error: { name: err?.name || 'Unknown', message: String(err?.message ?? err), code: 'E_UNKNOWN' },
        origin,
      }, 'FATAL', 'error-handler');
    }
  } catch {
    // Last resort — logger itself is broken
    console.error('uncaughtException (logger broken):', String(err));
  }
  if (isHFSpaces) {
    try {
      const { safeLog } = require('./logger');
      safeLog({ message: 'HF Spaces: uncaughtException intercepted — NOT shutting down (HTTP server must stay alive)' }, 'WARN', 'error-handler');
    } catch { console.warn('HF Spaces: uncaughtException intercepted — NOT shutting down'); }
  } else {
    setTimeout(() => { gracefulShutdown('uncaughtException'); }, 1000);
  }
});

process.on('unhandledRejection', (reason: unknown, _promise: Promise<unknown>): void => {
  try {
    const { safeLog } = require('./logger');
    let classified;
    try {
      classified = classifyError(reason instanceof Error ? reason : new Error(String(reason)));
    } catch {
      classified = null;
    }
    if (classified) {
      safeLog({
        type: 'UNHANDLED_REJECTION',
        reason: typeof classified.toJSON === 'function' ? classified.toJSON() : { name: 'unknown', message: String(reason) },
      }, 'ERROR', 'error-handler');
    } else {
      safeLog({ type: 'UNHANDLED_REJECTION', reason: { message: String(reason) } }, 'ERROR', 'error-handler');
    }
  } catch {
    console.error('unhandledRejection (logger broken):', String(reason));
  }
});

process.on('warning', (warning: Error): void => {
  if (warning.name === 'ExperimentalWarning') return;
  const { safeLog } = require('./logger');
  safeLog({
    type: 'PROCESS_WARNING',
    name: warning.name,
    message: warning.message,
    stack: warning.stack?.split('\n')?.slice(0, 5),
  }, 'WARN', 'error-handler');
});

// ─── Coordinated shutdown ───
// Uses a global flag (global.__isShuttingDown) so both error-handler and agent.ts
// share the same shutdown state — eliminates the race condition from separate flags.
let isShuttingDown: boolean = false;

/** Check if a shutdown is already in progress (shared across modules) */
function _isShuttingDown(): boolean {
  return isShuttingDown || !!(global as any).__isShuttingDown;
}

/** Mark shutdown as in-progress (shared across modules) */
function _markShuttingDown(): void {
  isShuttingDown = true;
  (global as any).__isShuttingDown = true;
}

function gracefulShutdown(signal: string): void {
  if (_isShuttingDown()) { process.exit(1); }
  _markShuttingDown();
  const { log, logError } = require('./logger');
  log(`Received ${signal}, starting graceful shutdown...`, 'INFO', 'error-handler');
  const shutdownTimeout: NodeJS.Timeout = setTimeout(() => {
    log('Graceful shutdown timeout, forcing exit', 'WARN', 'error-handler');
    process.exit(1);
  }, 10000);
  // Use registered shutdown hooks from cycle/shutdown.js for proper cleanup order
  Promise.resolve()
    .then(() => {
      try {
        const { gracefulShutdown: runHooks } = require('./cycle-shutdown');
        return runHooks(signal);
      } catch (e: any) {
        // v5-fix H5: Fallback — close database directly if shutdown
        // module unavailable. Guard against db being undefined (e.g.
        // if initDatabase() was never called before an early crash).
        log('Shutdown hooks unavailable, closing DB directly', 'WARN', 'error-handler');
        try {
          const dbMod = require('./database');
          if (dbMod.db && typeof dbMod.closeDatabase === 'function') {
            dbMod.closeDatabase();
          } else {
            log('Database not initialized — skipping DB close', 'DEBUG', 'error-handler');
          }
        } catch (err: any) { logError('Error closing database during shutdown', err); }
      }
    })
    .then(() => { log('Cleanup complete, exiting', 'INFO', 'error-handler'); clearTimeout(shutdownTimeout); process.exit(0); })
    .catch((err: unknown) => { logError('Error during shutdown', err); clearTimeout(shutdownTimeout); process.exit(1); });
}

// ─── Memory monitoring (single source of truth) ───
// agent.ts has a more capable memory monitor (with GC hints, browser cleanup,
// and persistent warning count). This module exposes a simpler version that
// is only used if error-handler is loaded standalone (e.g. in tests).
// In production, agent.ts checks global.__isShuttingDown to coordinate.

function monitorMemory(): void {
  if (_isShuttingDown()) return;
  const { log, safeLog } = require('./logger');
  let CONFIG: any;
  try { CONFIG = require('./config'); } catch { return; }
  const memUsage: NodeJS.MemoryUsage = process.memoryUsage();
  const heapUsedMB: number = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB: number = Math.round(memUsage.heapTotal / 1024 / 1024);
  const rssMB: number = Math.round(memUsage.rss / 1024 / 1024);
// @ts-expect-error
  if (global._lastMemoryLog === undefined || Date.now() - global._lastMemoryLog > 60000) {
// @ts-expect-error
    global._lastMemoryLog = Date.now();
    log(`Memory: heap ${heapUsedMB}/${heapTotalMB}MB, rss ${rssMB}MB`, 'DEBUG', 'error-handler');
  }
  if (heapUsedMB > (CONFIG.MEMORY_RESTART_THRESHOLD_MB || 480)) {
    safeLog({
      context: { heapUsedMB, heapTotalMB, rssMB, threshold: CONFIG.MEMORY_RESTART_THRESHOLD_MB },
    }, 'ERROR', 'error-handler');
    log(`Memory threshold exceeded: ${heapUsedMB}MB`, 'ERROR', 'error-handler');
    if (isHFSpaces) {
      log('HF Spaces: NOT shutting down on memory threshold — attempting GC + browser cleanup', 'WARN', 'error-handler');
      if (global.gc) global.gc();
      try {
        const container = require('./container');
        const browserMod = container.container?.get?.('browser', { required: false });
        if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
          browserMod.browserManager.cleanup().catch(() => {});
        }
      } catch { /* best effort */ }
    } else {
      gracefulShutdown('memory_threshold');
    }
  }
}

// NOTE: Memory monitor interval NOT started here anymore.
// agent.ts owns the primary memory monitor (60s interval with GC + browser cleanup).
// Starting it here created a race condition with a separate shutdown flag.
// This function is exported for use in tests or standalone scenarios only.

Error.stackTraceLimit = 50;

module.exports = { gracefulShutdown, monitorMemory, classifyError, _isShuttingDown, _markShuttingDown };
