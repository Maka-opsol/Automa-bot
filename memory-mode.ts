'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Memory Mode Manager — Full Power / Memory Protection
// ═══════════════════════════════════════════════════════════════════════
// Two operational modes:
//
//   FULL POWER:         All subsystems enabled, normal GC, full features.
//                       Memory thresholds: warn=350MB, restart=400MB
//
//   MEMORY PROTECTION:  Heavy subsystems disabled, aggressive GC (60s),
//                       reduced log buffer, tighter thresholds.
//                       Memory thresholds: warn=250MB, restart=280MB
//
// Auto-switching rules:
//   → Memory Protection: when heap > 320MB or RSS > 440MB or wasRecentlyOOMKilled()
//   → Full Power:       only MANUAL via dashboard (never auto-promote)
//                       (prevents oscillation between modes)
//
// Mode state is persisted via persistent-config so it survives restarts.
// ═══════════════════════════════════════════════════════════════════════

const persistConfig = require('./persistent-config');

// ── Mode thresholds ──
const MODE_THRESHOLDS = {
  full_power: {
    warnHeapMB: 350,
    restartHeapMB: 400,
    rssHardLimitMB: 470,
    gcIntervalMs: 90 * 1000,
    monitorIntervalMs: 20 * 1000,
    warningStreak: 2,
  },
  memory_protection: {
    warnHeapMB: 250,
    restartHeapMB: 280,
    rssHardLimitMB: 430,
    gcIntervalMs: 60 * 1000,
    monitorIntervalMs: 15 * 1000,
    warningStreak: 2,
  },
};

// Auto-downgrade triggers (switch to memory_protection)
const AUTO_DOWNGRADE_HEAP_MB = 320;
const AUTO_DOWNGRADE_RSS_MB = 440;

// Modules to disable in memory_protection mode
const HEAVY_SELF_HEAL_KEYS = [
  'BLACKBOX_FULL_ENABLED', 'ENABLE_EXPLORATION_PASS', 'ENABLE_ADAPTIVE_PERFORMANCE',
  'PROMPT_EVOLUTION_ENABLED', 'REGRESSION_BANK_ENABLED', 'PATCH_MEMORY_ENABLED',
  'HEAL_REWARD_TRACKER_ENABLED', 'SELF_HEAL_TIMELINE_ENABLED', 'EXTENDED_CHECKPOINT_ENABLED',
  'CANARY_ROLLOUT_ENABLED', 'DIFF_MINIMIZER_ENABLED',
];
const HEAVY_RESILIENCE_KEYS = [
  'ENABLE_BLACKBOX', 'POLICY_ACTION_VALIDATOR_ENABLED',
];

let _currentMode: 'full_power' | 'memory_protection' = 'full_power';
let _gcTimer: ReturnType<typeof setInterval> | null = null;
let _monitorTimer: ReturnType<typeof setInterval> | null = null;
let _modeChangeCallbacks: Array<(mode: string, reason: string) => void> = [];
let _isShuttingDown = false;

// ── Log helper ──
function _log(msg: string, level: string = 'INFO') {
  try {
    const { container } = require('./container');
    const logger = container.get('logger', { required: false });
    logger?.log?.(msg, level, 'memory-mode');
  } catch {
    console.log(`[memory-mode] ${level}: ${msg}`);
  }
}

// ── Get current mode ──
function getMode(): 'full_power' | 'memory_protection' {
  return _currentMode;
}

function getThresholds() {
  return MODE_THRESHOLDS[_currentMode];
}

function isMemoryProtection(): boolean {
  return _currentMode === 'memory_protection';
}

// ── Apply mode: set env vars and CONFIG values ──
function _applyMode(mode: 'full_power' | 'memory_protection', reason: string): void {
  const prev = _currentMode;
  _currentMode = mode;
  const thresholds = MODE_THRESHOLDS[mode];

  if (mode === 'memory_protection') {
    // Disable heavy modules
    for (const key of [...HEAVY_SELF_HEAL_KEYS, ...HEAVY_RESILIENCE_KEYS]) {
      process.env[key] = 'false';
    }
    _log(`MEMORY PROTECTION mode activated: ${reason}. Disabled ${HEAVY_SELF_HEAL_KEYS.length + HEAVY_RESILIENCE_KEYS.length} heavy modules. Thresholds: warn=${thresholds.warnHeapMB}MB restart=${thresholds.restartHeapMB}MB GC=${thresholds.gcIntervalMs / 1000}s`, 'WARN');
  } else {
    // Re-enable heavy modules (only env — they won't start until restart)
    for (const key of [...HEAVY_SELF_HEAL_KEYS, ...HEAVY_RESILIENCE_KEYS]) {
      delete process.env[key]; // Remove override so defaults apply on next start
    }
    _log(`FULL POWER mode activated: ${reason}. Heavy modules will re-enable on restart. Thresholds: warn=${thresholds.warnHeapMB}MB restart=${thresholds.restartHeapMB}MB GC=${thresholds.gcIntervalMs / 1000}s`, 'INFO');
  }

  // Persist mode
  persistConfig.setMode(mode, reason, prev !== mode);

  // Notify callbacks
  if (prev !== mode) {
    for (const cb of _modeChangeCallbacks) {
      try { cb(mode, reason); } catch { /* ignore */ }
    }
  }
}

// ── Manual mode switch (from dashboard) ──
function switchMode(mode: 'full_power' | 'memory_protection', reason: string): void {
  _applyMode(mode, `manual:${reason}`);
  // Restart GC and monitor timers with new intervals
  _restartTimers();
}

// ── Auto-downgrade check ──
function checkAutoDowngrade(heapMB: number, rssMB: number): boolean {
  if (_currentMode === 'memory_protection') return false; // Already protected

  let shouldDowngrade = false;
  let reason = '';

  if (heapMB > AUTO_DOWNGRADE_HEAP_MB) {
    shouldDowngrade = true;
    reason = `heap=${heapMB.toFixed(0)}MB > ${AUTO_DOWNGRADE_HEAP_MB}MB`;
  } else if (rssMB > AUTO_DOWNGRADE_RSS_MB) {
    shouldDowngrade = true;
    reason = `rss=${rssMB.toFixed(0)}MB > ${AUTO_DOWNGRADE_RSS_MB}MB`;
  } else if (persistConfig.wasRecentlyOOMKilled()) {
    shouldDowngrade = true;
    reason = 'recent_OOM_crash_detected';
  }

  if (shouldDowngrade) {
    _applyMode('memory_protection', `auto:${reason}`);
    _restartTimers();
  }

  return shouldDowngrade;
}

// ── Register mode change callback ──
function onModeChange(cb: (mode: string, reason: string) => void): void {
  _modeChangeCallbacks.push(cb);
}

// ── GC timer ──
function _restartTimers(): void {
  if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
  if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; }

  const thresholds = MODE_THRESHOLDS[_currentMode];

  _gcTimer = setInterval(() => {
    if (_isShuttingDown) return;
    if (global.gc) {
      try { global.gc(); } catch { /* ignore */ }
    }
  }, thresholds.gcIntervalMs);
  if (_gcTimer && typeof (_gcTimer as any).unref === 'function') (_gcTimer as any).unref();

  // The monitor timer is managed by render-free-plan.ts — we just store the interval
  // so it can pick it up.
}

// ── Initialize: restore persisted mode + check for OOM history ──
function init(): void {
  try {
    const persisted = persistConfig.getMode();
    // Check if we should start in memory protection
    if (persisted.current === 'memory_protection') {
      // Check if the reason was auto — if so, keep it
      _applyMode('memory_protection', `restored:${persisted.reason}`);
      _log('Restored MEMORY PROTECTION mode from persistent storage', 'INFO');
    } else if (persistConfig.wasRecentlyOOMKilled()) {
      // Was killed by OOM — start in protection mode even if was "full_power"
      _applyMode('memory_protection', 'auto:OOM_kill_recovery');
      _log('Detected recent OOM kill — starting in MEMORY PROTECTION mode', 'WARN');
    } else {
      _applyMode('full_power', 'initial');
    }
  } catch (e: any) {
    _applyMode('full_power', 'init_fallback');
  }

  _restartTimers();
}

function shutdown(): void {
  _isShuttingDown = true;
  if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
  if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; }
}

module.exports = {
  init,
  shutdown,
  getMode,
  getThresholds,
  isMemoryProtection,
  switchMode,
  checkAutoDowngrade,
  onModeChange,
  HEAVY_SELF_HEAL_KEYS,
  HEAVY_RESILIENCE_KEYS,
  AUTO_DOWNGRADE_HEAP_MB,
  AUTO_DOWNGRADE_RSS_MB,
};
