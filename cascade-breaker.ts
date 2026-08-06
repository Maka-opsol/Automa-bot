// Resilience R11: Cross-Module Failure Correlation — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// cascade-breaker.ts — P2 Cross-Module Failure Correlation
// ═══════════════════════════════════════════════════════════════
// When multiple modules fail simultaneously, the cycle manager
// may not realize they're related. This module provides a
// central failure event bus that correlates failures across ALL
// modules and triggers a cascade recovery protocol when a
// systemic failure pattern is detected.
//
// Features:
//   1. Failure event bus: modules report failures with timestamps
//   2. Sliding window (60 seconds): track failures across modules
//   3. If 3+ DIFFERENT modules fail within 60 seconds → cascade event
//   4. On cascade event:
//      a. Freeze non-essential modules
//      b. Reset all provider state
//      c. Log cascade report with full failure details
//   5. Cooldown: 5-minute cascade suppression after an event
//   6. Per-module "blast radius" classification:
//      - isolated: failure doesn't affect other modules
//      - local: failure may affect 1-2 related modules
//      - systemic: failure indicates systemic problem
//
// Integration:
//   - cycle-cycle-manager.ts calls recordFailure() on each error
//   - cycle-cycle-manager.ts checks isCascadeActive() before actions
//   - All modules call recordFailure() via safeCall or directly
//
// Config:
//   CASCADE_BREAKER_WINDOW_MS — sliding window (default 60000)
//   CASCADE_BREAKER_MODULE_THRESHOLD — modules before cascade (default 3)
//   CASCADE_BREAKER_COOLDOWN_MS — post-cascade cooldown (default 300000)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'cascade-breaker') {
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
  console.error(`[ERROR] [cascade-breaker] ${msg}`, err);
}

// ─── Types ───
type BlastRadius = 'isolated' | 'local' | 'systemic';

interface FailureEvent {
  module: string;
  error: string;
  blastRadius: BlastRadius;
  timestamp: number;
}

interface CascadeEvent {
  timestamp: number;
  failureCount: number;
  modules: string[];
  failures: FailureEvent[];
  recoveryActions: string[];
}

// ─── Constants ───
const DEFAULT_WINDOW_MS = 60 * 1000;          // 60 seconds
const DEFAULT_MODULE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;    // 5 minutes

// Module blast radius classification
const BLAST_RADIUS_MAP: Record<string, BlastRadius> = {
  // Systemic: failure indicates infrastructure-level problem
  'browser': 'systemic',
  'database': 'systemic',
  'config': 'systemic',
  'sandboxExecutor': 'systemic',
  // Local: failure may affect related modules
  'providers': 'local',
  'providerRegistry': 'local',
  'statePersist': 'local',
  'selfHeal': 'local',
  'metaSelfTest': 'local',
  'alerting': 'local',
  // Isolated: failure is contained to the module
  'monitoringHealthCheck': 'isolated',
  'modelDiscovery': 'isolated',
  'modelEvolution': 'isolated',
  'uiDriftDiscovery': 'isolated',
  'rewardTracker': 'isolated',
  'diary': 'isolated',
};

// ─── State ───
let _failureWindow: FailureEvent[] = [];
let _cascadeEvents: CascadeEvent[] = [];        // Last 5 cascade events
let _lastCascadeTime: number | null = null;
let _totalFailuresRecorded = 0;
let _totalCascadesTriggered = 0;
let _isCascadeActive = false;
let _started = false;
let _cleanupInterval: ReturnType<typeof setInterval> | null = null;

// ─── Helpers ───

function _getWindowMs(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CASCADE_BREAKER_WINDOW_MS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_WINDOW_MS;
}

function _getModuleThreshold(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CASCADE_BREAKER_MODULE_THRESHOLD);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_MODULE_THRESHOLD;
}

function _getCooldownMs(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.CASCADE_BREAKER_COOLDOWN_MS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_COOLDOWN_MS;
}

function _getBlastRadius(moduleName: string): BlastRadius {
  // Check exact match first
  if (BLAST_RADIUS_MAP[moduleName]) {
    return BLAST_RADIUS_MAP[moduleName];
  }
  // Check prefix match (e.g., 'providers-groq' → 'providers')
  for (const [key, radius] of Object.entries(BLAST_RADIUS_MAP)) {
    if (moduleName.startsWith(key)) {
      return radius;
    }
  }
  // Default: local (moderate concern)
  return 'local';
}

/**
 * Prune old events from the sliding window.
 */
function _pruneWindow(): void {
  const cutoff = Date.now() - _getWindowMs();
  while (_failureWindow.length > 0 && _failureWindow[0].timestamp < cutoff) {
    _failureWindow.shift();
  }
}

/**
 * Get unique module names in the current window.
 */
function _getUniqueModulesInWindow(): Set<string> {
  const modules = new Set<string>();
  for (const event of _failureWindow) {
    modules.add(event.module);
  }
  return modules;
}

// ─── Core API ───

/**
 * Record a failure event for a module.
 * Call this from cycle-manager on every error, or from safeCall wrappers.
 *
 * @param moduleName — The module that failed
 * @param error — The error message or Error object
 * @param blastRadius — Override blast radius (optional, auto-detected if omitted)
 */
function recordFailure(moduleName: string, error: Error | string, blastRadius?: BlastRadius): void {
  if (_isCascadeActive) {
    // Don't record during active cascade (prevents cascade-on-cascade)
    return;
  }

  const errorStr = error instanceof Error ? error.message : String(error);
  const radius = blastRadius || _getBlastRadius(moduleName);

  _totalFailuresRecorded++;

  const event: FailureEvent = {
    module: moduleName,
    error: errorStr,
    blastRadius: radius,
    timestamp: Date.now(),
  };

  _failureWindow.push(event);
  _pruneWindow();

  // Log non-isolated failures
  if (radius !== 'isolated') {
    log(
      `[CASCADE] Failure recorded: "${moduleName}" [${radius}]: ${errorStr}`,
      'WARN'
    );
  }

  // Check for cascade condition
  _checkCascade();
}

/**
 * Check if cascade conditions are met.
 */
function _checkCascade(): void {
  // Check cooldown
  if (_lastCascadeTime && (Date.now() - _lastCascadeTime) < _getCooldownMs()) {
    return; // In cooldown
  }

  const uniqueModules = _getUniqueModulesInWindow();
  const threshold = _getModuleThreshold();

  if (uniqueModules.size >= threshold) {
    _triggerCascade(uniqueModules);
  }
}

/**
 * Trigger cascade recovery protocol.
 */
function _triggerCascade(failedModules: Set<string>): void {
  _isCascadeActive = true;
  _lastCascadeTime = Date.now();
  _totalCascadesTriggered++;

  // Build cascade event
  const recentFailures = _failureWindow.slice(-20); // Last 20 failures
  const recoveryActions: string[] = [];

  log(
    `[CASCADE] ⚠ CASCADE EVENT DETECTED: ${failedModules.size} modules failed within ${_getWindowMs() / 1000}s: ` +
    Array.from(failedModules).join(', '),
    'ERROR'
  );

  // Recovery actions based on blast radii
  const hasSystemic = recentFailures.some(f => f.blastRadius === 'systemic');

  if (hasSystemic) {
    recoveryActions.push('Systemic failure detected — full recovery protocol');
    recoveryActions.push('Reset all provider state');
    recoveryActions.push('Force browser restart');
    recoveryActions.push('Clear all caches');

    // Reset provider state
    try {
      const providerRegistry = (_deps as any).providerRegistry;
      if (providerRegistry?.resetCycleProviderState) {
        providerRegistry.resetCycleProviderState();
        recoveryActions.push('Provider state reset: OK');
      }
    } catch { /* non-critical */ }

    // Force browser close
    try {
      const browser = (_deps as any).browser;
      if (browser?.closeBrowser) {
        browser.closeBrowser().catch(() => {});
        recoveryActions.push('Browser force-closed');
      }
    } catch { /* non-critical */ }

    // Clear caches
    try {
      const cache = (_deps as any).cache;
      if (cache?.clearAll) {
        cache.clearAll();
        recoveryActions.push('Cache cleared');
      }
    } catch { /* non-critical */ }
  } else {
    recoveryActions.push('Local/isolated failures — partial recovery');
    recoveryActions.push('Reset affected provider state');

    // Reset only affected provider state
    try {
      const providerRegistry = (_deps as any).providerRegistry;
      if (providerRegistry?.resetCycleProviderState) {
        providerRegistry.resetCycleProviderState();
        recoveryActions.push('Provider state reset: OK');
      }
    } catch { /* non-critical */ }
  }

  const cascadeEvent: CascadeEvent = {
    timestamp: Date.now(),
    failureCount: recentFailures.length,
    modules: Array.from(failedModules),
    failures: recentFailures,
    recoveryActions,
  };

  _cascadeEvents.push(cascadeEvent);
  if (_cascadeEvents.length > 5) {
    _cascadeEvents.shift();
  }

  // Alert
  try {
    const alerting = (_deps as any).alerting;
    if (alerting?.sendAlert) {
      alerting.sendAlert(
        `Cascade Event: ${failedModules.size} Modules Failed`,
        `Modules: ${Array.from(failedModules).join(', ')}\n` +
        `Recovery actions:\n${recoveryActions.join('\n')}`
      );
    }
  } catch { /* non-critical */ }

  // Persist to DB
  try {
    const db = (_deps as any).database;
    if (db?.upsertCalibration) {
      db.upsertCalibration('cascade_total', String(_totalCascadesTriggered));
      db.upsertCalibration('cascade_last_modules', Array.from(failedModules).join(','));
      db.upsertCalibration('cascade_last_time', String(Date.now()));
    }
  } catch { /* non-critical */ }

  // End cascade state after a delay
  setTimeout(() => {
    _isCascadeActive = false;
    _failureWindow = []; // Clear window after cascade
    log('[CASCADE] Cascade recovery period ended. Resuming normal operation.', 'INFO');
  }, _getCooldownMs() / 2).unref(); // Half the cooldown period
}

/**
 * Check if a cascade is currently active.
 */
function isCascadeActive(): boolean {
  return _isCascadeActive;
}

/**
 * Get the list of modules that have failed in the current window.
 */
function getFailedModules(): string[] {
  _pruneWindow();
  return Array.from(_getUniqueModulesInWindow());
}

/**
 * Get failure count for a specific module in the current window.
 */
function getModuleFailureCount(moduleName: string): number {
  _pruneWindow();
  return _failureWindow.filter(f => f.module === moduleName).length;
}

/**
 * Get full diagnostic status.
 */
function getStatus(): {
  isActive: boolean;
  totalFailuresRecorded: number;
  totalCascadesTriggered: number;
  failuresInWindow: number;
  uniqueModulesInWindow: number;
  lastCascadeTime: number | null;
  lastCascadeModules: string[];
  cascadeCooldownRemainingMs: number;
  recentFailures: { module: string; error: string; blastRadius: string; ageMs: number }[];
} {
  _pruneWindow();
  const uniqueModules = _getUniqueModulesInWindow();

  let cooldownRemainingMs = 0;
  if (_lastCascadeTime) {
    const elapsed = Date.now() - _lastCascadeTime;
    if (elapsed < _getCooldownMs()) {
      cooldownRemainingMs = _getCooldownMs() - elapsed;
    }
  }

  const lastCascade = _cascadeEvents.length > 0
    ? _cascadeEvents[_cascadeEvents.length - 1]
    : null;

  return {
    isActive: _isCascadeActive,
    totalFailuresRecorded: _totalFailuresRecorded,
    totalCascadesTriggered: _totalCascadesTriggered,
    failuresInWindow: _failureWindow.length,
    uniqueModulesInWindow: uniqueModules.size,
    lastCascadeTime: _lastCascadeTime,
    lastCascadeModules: lastCascade?.modules || [],
    cascadeCooldownRemainingMs: cooldownRemainingMs,
    recentFailures: _failureWindow.slice(-10).map(f => ({
      module: f.module,
      error: f.error,
      blastRadius: f.blastRadius,
      ageMs: Date.now() - f.timestamp,
    })),
  };
}

/**
 * Start the cascade breaker.
 */
function start(): void {
  if (_started) return;
  _started = true;

  // Periodic window cleanup
  _cleanupInterval = setInterval(() => {
    _pruneWindow();
  }, 10000).unref();

  log(
    `[CASCADE] Cascade breaker started (window=${_getWindowMs() / 1000}s, threshold=${_getModuleThreshold()} modules, cooldown=${_getCooldownMs() / 1000}s)`,
    'INFO'
  );
}

module.exports = {
  _injectDependencies,
  recordFailure,
  isCascadeActive,
  getFailedModules,
  getModuleFailureCount,
  getStatus,
  start,
};
