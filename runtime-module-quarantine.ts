// Resilience R7: Hot Module Isolation — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// runtime-module-quarantine.ts — P1 Hot Module Isolation
// ═══════════════════════════════════════════════════════════════
// One module crash = cycle crash. This module wraps DI module
// function calls in a sandbox that catches throws, tracks per-
// module failure counts, and quarantines modules that fail
// repeatedly — returning null instead of propagating exceptions.
//
// Features:
//   1. safeCall(moduleName, fn, fallback) — wraps any function
//      call with try/catch, tracks per-module throw counts
//   2. If module X throws N consecutive times (default 3),
//      it is quarantined — all subsequent calls return fallback
//   3. On cycle start: resetQuarantine() un-quarantines all modules
//   4. Quarantine events are logged with full stack traces
//   5. Per-module error history (last 5 errors) for diagnostics
//   6. Configurable quarantine threshold and auto-reset on cycle
//
// Integration:
//   - cycle-cycle-manager.ts wraps critical dep calls with safeCall
//   - cycle-cycle-manager.ts calls resetQuarantine() at cycle start
//   - container-subsystem-runner.ts starts monitoring
//
// Config:
//   MODULE_QUARANTINE_MAX_FAILURES — consecutive failures before
//     quarantine (default 3)
//   MODULE_QUARANTINE_ENABLED — master switch (default true)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'module-quarantine') {
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
  console.error(`[ERROR] [module-quarantine] ${msg}`, err);
}

// ─── Constants ───
const DEFAULT_MAX_FAILURES = 3;
const MAX_ERROR_HISTORY = 5;

// ─── Types ───
interface ModuleErrorEntry {
  error: Error;
  timestamp: number;
  functionName?: string;
}

interface ModuleQuarantineState {
  moduleName: string;
  consecutiveFailures: number;
  totalFailures: number;
  isQuarantined: boolean;
  quarantineTime: number | null;
  lastError: ModuleErrorEntry | null;
  errorHistory: ModuleErrorEntry[];
  firstFailureTime: number | null;
}

// ─── State ───
const _moduleStates: Map<string, ModuleQuarantineState> = new Map();
let _totalQuarantineEvents = 0;
let _totalSafeCalls = 0;
let _totalCaughtErrors = 0;
let _started = false;

// ─── Helpers ───

function _isEnabled(): boolean {
  const CONFIG = getCONFIG();
  return CONFIG.MODULE_QUARANTINE_ENABLED !== false; // default true
}

function _getMaxFailures(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.MODULE_QUARANTINE_MAX_FAILURES);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_MAX_FAILURES;
}

function _getOrCreateState(moduleName: string): ModuleQuarantineState {
  let state = _moduleStates.get(moduleName);
  if (!state) {
    state = {
      moduleName,
      consecutiveFailures: 0,
      totalFailures: 0,
      isQuarantined: false,
      quarantineTime: null,
      lastError: null,
      errorHistory: [],
      firstFailureTime: null,
    };
    _moduleStates.set(moduleName, state);
  }
  return state;
}

// ─── Core API ───

/**
 * Wrap any module function call with error isolation.
 * If the module is quarantined, returns fallback immediately.
 * If the call throws, tracks the failure and quarantines if threshold reached.
 *
 * @param moduleName - The DI module name (e.g. 'selfHeal', 'sandboxExecutor')
 * @param fn - The function to call
 * @param fallback - Value to return on error or quarantine (default null)
 * @returns The function result, or fallback on error/quarantine
 */
function safeCall<T>(
  moduleName: string,
  fn: () => T,
  fallback?: T
): T | undefined {
  if (!_isEnabled()) {
    try { return fn(); } catch (e) { return fallback; }
  }

  _totalSafeCalls++;
  const state = _getOrCreateState(moduleName);

  // If module is quarantined, return fallback immediately
  if (state.isQuarantined) {
    return fallback;
  }

  try {
    const result = fn();
    // Success — reset consecutive failures
    if (state.consecutiveFailures > 0) {
      log(
        `[QUARANTINE] Module "${moduleName}" recovered after ${state.consecutiveFailures} consecutive failures`,
        'INFO'
      );
    }
    state.consecutiveFailures = 0;
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    _totalCaughtErrors++;

    // Record failure
    state.consecutiveFailures++;
    state.totalFailures++;
    state.lastError = { error, timestamp: Date.now() };
    if (!state.firstFailureTime) {
      state.firstFailureTime = Date.now();
    }

    // Add to error history (ring buffer of MAX_ERROR_HISTORY)
    state.errorHistory.push({ error, timestamp: Date.now(), functionName: fn.name || undefined });
    if (state.errorHistory.length > MAX_ERROR_HISTORY) {
      state.errorHistory.shift();
    }

    const maxFailures = _getMaxFailures();

    // Check if quarantine threshold reached
    if (state.consecutiveFailures >= maxFailures && !state.isQuarantined) {
      state.isQuarantined = true;
      state.quarantineTime = Date.now();
      _totalQuarantineEvents++;

      logError(
        `[QUARANTINE] Module "${moduleName}" QUARANTINED after ${state.consecutiveFailures} consecutive failures. ` +
        `Returning fallback for remainder of cycle. Last error: ${error.message}`,
        error
      );

      // Attempt to alert
      try {
        const alerting = (_deps as any).alerting;
        if (alerting?.sendAlert) {
          alerting.sendAlert(
            `Module Quarantined: ${moduleName}`,
            `Module "${moduleName}" has been quarantined after ${state.consecutiveFailures} consecutive failures. ` +
            `Last error: ${error.message}\n\nThe module will be un-quarantined at the start of the next cycle.`
          );
        }
      } catch { /* alerting is non-critical */ }
    } else if (!state.isQuarantined) {
      log(
        `[QUARANTINE] Module "${moduleName}" threw (failure ${state.consecutiveFailures}/${maxFailures}): ${error.message}`,
        'WARN'
      );
    }

    return fallback;
  }
}

/**
 * Async version of safeCall. Same logic but for Promise-returning functions.
 */
async function safeCallAsync<T>(
  moduleName: string,
  fn: () => Promise<T>,
  fallback?: T
): Promise<T | undefined> {
  if (!_isEnabled()) {
    try { return await fn(); } catch (e) { return fallback; }
  }

  _totalSafeCalls++;
  const state = _getOrCreateState(moduleName);

  // If module is quarantined, return fallback immediately
  if (state.isQuarantined) {
    return fallback;
  }

  try {
    const result = await fn();
    // Success — reset consecutive failures
    if (state.consecutiveFailures > 0) {
      log(
        `[QUARANTINE] Module "${moduleName}" recovered after ${state.consecutiveFailures} consecutive failures`,
        'INFO'
      );
    }
    state.consecutiveFailures = 0;
    return result;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    _totalCaughtErrors++;

    // Record failure
    state.consecutiveFailures++;
    state.totalFailures++;
    state.lastError = { error, timestamp: Date.now() };
    if (!state.firstFailureTime) {
      state.firstFailureTime = Date.now();
    }

    // Add to error history
    state.errorHistory.push({ error, timestamp: Date.now() });
    if (state.errorHistory.length > MAX_ERROR_HISTORY) {
      state.errorHistory.shift();
    }

    const maxFailures = _getMaxFailures();

    if (state.consecutiveFailures >= maxFailures && !state.isQuarantined) {
      state.isQuarantined = true;
      state.quarantineTime = Date.now();
      _totalQuarantineEvents++;

      logError(
        `[QUARANTINE] Module "${moduleName}" QUARANTINED (async) after ${state.consecutiveFailures} consecutive failures. ` +
        `Last error: ${error.message}`,
        error
      );

      try {
        const alerting = (_deps as any).alerting;
        if (alerting?.sendAlert) {
          alerting.sendAlert(
            `Module Quarantined: ${moduleName}`,
            `Module "${moduleName}" has been quarantined after ${state.consecutiveFailures} consecutive failures (async). ` +
            `Last error: ${error.message}`
          );
        }
      } catch { /* non-critical */ }
    } else if (!state.isQuarantined) {
      log(
        `[QUARANTINE] Module "${moduleName}" threw async (failure ${state.consecutiveFailures}/${maxFailures}): ${error.message}`,
        'WARN'
      );
    }

    return fallback;
  }
}

/**
 * Check if a module is currently quarantined.
 */
function isQuarantined(moduleName: string): boolean {
  const state = _moduleStates.get(moduleName);
  return state?.isQuarantined === true;
}

/**
 * Manually quarantine a module (e.g., if external logic detects it's broken).
 */
function quarantineModule(moduleName: string, reason?: string): void {
  const state = _getOrCreateState(moduleName);
  if (!state.isQuarantined) {
    state.isQuarantined = true;
    state.quarantineTime = Date.now();
    _totalQuarantineEvents++;
    log(
      `[QUARANTINE] Module "${moduleName}" manually quarantined. Reason: ${reason || 'external'}`,
      'WARN'
    );
  }
}

/**
 * Manually un-quarantine a module (e.g., if it's been repaired mid-cycle).
 */
function unquarantineModule(moduleName: string): void {
  const state = _moduleStates.get(moduleName);
  if (state && state.isQuarantined) {
    state.isQuarantined = false;
    state.quarantineTime = null;
    state.consecutiveFailures = 0;
    log(
      `[QUARANTINE] Module "${moduleName}" manually un-quarantined.`,
      'INFO'
    );
  }
}

/**
 * Reset all quarantines — called at the start of each new cycle.
 * All modules get a fresh chance regardless of past failures.
 */
function resetQuarantine(): void {
  let unquarantinedCount = 0;
  for (const [name, state] of _moduleStates) {
    if (state.isQuarantined) {
      unquarantinedCount++;
      state.isQuarantined = false;
      state.quarantineTime = null;
    }
    state.consecutiveFailures = 0;
    state.firstFailureTime = null;
  }

  if (unquarantinedCount > 0) {
    log(
      `[QUARANTINE] Cycle reset: ${unquarantinedCount} modules un-quarantined, all failure counts reset.`,
      'INFO'
    );
  }
}

/**
 * Record an external error for a module (e.g., if another system detected
 * a failure that wasn't caught by safeCall). This counts toward quarantine
 * threshold without the try/catch wrapper.
 */
function recordExternalError(moduleName: string, error: Error | string): void {
  if (!_isEnabled()) return;

  const state = _getOrCreateState(moduleName);
  const err = error instanceof Error ? error : new Error(error);

  state.consecutiveFailures++;
  state.totalFailures++;
  state.lastError = { error: err, timestamp: Date.now() };
  if (!state.firstFailureTime) {
    state.firstFailureTime = Date.now();
  }

  state.errorHistory.push({ error: err, timestamp: Date.now() });
  if (state.errorHistory.length > MAX_ERROR_HISTORY) {
    state.errorHistory.shift();
  }

  const maxFailures = _getMaxFailures();

  if (state.consecutiveFailures >= maxFailures && !state.isQuarantined) {
    state.isQuarantined = true;
    state.quarantineTime = Date.now();
    _totalQuarantineEvents++;

    logError(
      `[QUARANTINE] Module "${moduleName}" QUARANTINED (external error) after ${state.consecutiveFailures} failures: ${err.message}`,
      err
    );
  }
}

/**
 * Get the current state of a specific module.
 */
function getModuleState(moduleName: string): ModuleQuarantineState | null {
  return _moduleStates.get(moduleName) || null;
}

/**
 * Get the list of currently quarantined modules.
 */
function getQuarantinedModules(): string[] {
  const quarantined: string[] = [];
  for (const [name, state] of _moduleStates) {
    if (state.isQuarantined) {
      quarantined.push(name);
    }
  }
  return quarantined;
}

/**
 * Get full diagnostic status for all tracked modules.
 */
function getStatus(): {
  enabled: boolean;
  totalSafeCalls: number;
  totalCaughtErrors: number;
  totalQuarantineEvents: number;
  trackedModules: number;
  quarantinedModules: string[];
  modules: Record<string, {
    consecutiveFailures: number;
    totalFailures: number;
    isQuarantined: boolean;
    quarantineDurationMs: number | null;
    lastError: string | null;
    errorHistoryLength: number;
  }>;
} {
  const modules: Record<string, any> = {};
  for (const [name, state] of _moduleStates) {
    modules[name] = {
      consecutiveFailures: state.consecutiveFailures,
      totalFailures: state.totalFailures,
      isQuarantined: state.isQuarantined,
      quarantineDurationMs: state.quarantineTime ? Date.now() - state.quarantineTime : null,
      lastError: state.lastError ? state.lastError.error.message : null,
      errorHistoryLength: state.errorHistory.length,
    };
  }

  return {
    enabled: _isEnabled(),
    totalSafeCalls: _totalSafeCalls,
    totalCaughtErrors: _totalCaughtErrors,
    totalQuarantineEvents: _totalQuarantineEvents,
    trackedModules: _moduleStates.size,
    quarantinedModules: getQuarantinedModules(),
    modules,
  };
}

/**
 * Start the module quarantine system. Logs initial status.
 * Called by container-subsystem-runner.ts.
 */
function start(): void {
  if (_started) return;
  _started = true;

  log(
    `[QUARANTINE] Module quarantine started (maxFailures=${_getMaxFailures()}, enabled=${_isEnabled()})`,
    'INFO'
  );
}

module.exports = {
  _injectDependencies,
  safeCall,
  safeCallAsync,
  isQuarantined,
  quarantineModule,
  unquarantineModule,
  resetQuarantine,
  recordExternalError,
  getModuleState,
  getQuarantinedModules,
  getStatus,
  start,
};
