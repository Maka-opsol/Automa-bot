'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Memory Mode Manager — Full Power / Memory Protection / Minimum
// ═══════════════════════════════════════════════════════════════════════
// Three operational modes:
//
//   FULL POWER:         All subsystems enabled, normal GC, full features.
//                       Memory thresholds: warn=350MB, restart=400MB
//
//   MEMORY PROTECTION:  Heavy self-heal subsystems disabled, aggressive
//                       GC (15s), caches purged, tighter thresholds.
//                       Memory thresholds: warn=200MB, restart=220MB
//
//   MINIMUM:            Everything not needed to solve questions is
//                       disabled. Only the core cycle (screenshot →
//                       tribunal → action) remains. No exploration, no
//                       diary workers, no telemetry, no survival pings,
//                       no module tracking, no work shifts, no alerting,
//                       no pix2tex, no VLM, no GAN telemetry, no progress
//                       detection, no health checks, no circuit breakers.
//                       Memory thresholds: warn=150MB, restart=170MB
//                       GC every 8s. Monitor every 5s.
//
// Auto-switching rules:
//   → Memory Protection: when heap > 250MB or RSS > 380MB or wasRecentlyOOMKilled()
//   → Minimum:          when OOM death spiral detected AND self-heal
//                       fails, OR when restored from database.
//   → Full Power:       ONLY after a verified self-heal fix is promoted
//                       (via promoteAfterSelfHealFix). NEVER auto-promotes.
//                       Manual dashboard switch is still available for testing.
//
// Minimum mode escape hatches:
//   → Self-heal session can promote minimum → memory_protection (not
//     directly to full_power). After a verified fix, minimum can
//     eventually return to memory_protection.
//   → Manual dashboard switch can override to any mode.
//
// v3 FIX: _applyMode('memory_protection') now performs IMMEDIATE memory
//   recovery (close browser, clear caches, force GC) instead of just
//   setting env vars.
//
// v3 FIX: recordOOMExit now blocks briefly for the Turso write to ensure
//   the OOM marker survives the restart.
//
// v3 FIX: Added shedMemory() as a standalone emergency function.
// ═══════════════════════════════════════════════════════════════════════

const persistConfig = require('./persistent-config');

// Calibration keys for DB-backed persistence (survives /tmp wipes via Turso)
const CALIBRATION_KEY_MODE = 'memory_mode_current';
const CALIBRATION_KEY_OOM_EXIT = 'oom_last_exit_ts';
const CALIBRATION_KEY_MEMORY_HEARTBEAT = 'last_memory_heartbeat';
const CALIBRATION_KEY_MINIMUM_MODE = 'minimum_mode_active'; // persists minimum mode to DB
const OOM_RECOVERY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_RECOVERY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MINIMUM_MODE_OOM_KILL_THRESHOLD = 3; // 3+ OOM kills in window = auto minimum

// ── Mode thresholds ──
type MemoryMode = 'full_power' | 'memory_protection' | 'minimum';

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
    warnHeapMB: 200,
    restartHeapMB: 220,
    rssHardLimitMB: 380,
    gcIntervalMs: 15 * 1000,     // v7: was 30s — now 15s for more aggressive GC
    monitorIntervalMs: 8 * 1000,   // v7: was 10s — now 8s for faster detection
    warningStreak: 1,              // v3: was 2 — now react on FIRST warning
  },
  minimum: {
    warnHeapMB: 150,
    restartHeapMB: 170,
    rssHardLimitMB: 300,
    gcIntervalMs: 8 * 1000,       // very aggressive GC
    monitorIntervalMs: 5 * 1000,   // very fast detection
    warningStreak: 1,
  },
};

// Auto-downgrade triggers (switch to memory_protection)
const AUTO_DOWNGRADE_HEAP_MB = 250;
const AUTO_DOWNGRADE_RSS_MB = 380;

// v4: Auto-promote REMOVED. Full power is only granted after a verified
// self-heal fix is promoted. This prevents the bot from eagerly switching
// to full power and OOMing again. See promoteAfterSelfHealFix().
//
// Self-heal session lifecycle (DB-backed, survives restarts):
//   beginSelfHealSession()  — temporarily grant full power for healing
//   appendSelfHealProgress() — save incremental work to DB
//   promoteAfterSelfHealFix() — called after verified fix is promoted
//   finalizeSelfHealSession() — delete patch drafts, return to MEM PROTECTION
//   abortSelfHealSession()  — cleanup on failure, return to MEM PROTECTION
//
// The calibration keys used:
//   'self_heal_session'     — active session state (in_progress/done/aborted)
//   'self_heal_granted_ts'  — when full power was granted for this session
const CALIBRATION_KEY_SELF_HEAL_SESSION = 'self_heal_session';
const CALIBRATION_KEY_SELF_HEAL_GRANTED_TS = 'self_heal_granted_ts';
const SELF_HEAL_SESSION_TIMEOUT_MS = 15 * 60 * 1000; // 15 min max per session (v7: was 30min)
let _selfHealSessionTimer: ReturnType<typeof setTimeout> | null = null;

// Modules to disable in memory_protection mode
const HEAVY_SELF_HEAL_KEYS = [
  'BLACKBOX_FULL_ENABLED', 'ENABLE_EXPLORATION_PASS', 'ENABLE_ADAPTIVE_PERFORMANCE',
  'PROMPT_EVOLUTION_ENABLED', 'REGRESSION_BANK_ENABLED', 'PATCH_MEMORY_ENABLED',
  'HEAL_REWARD_TRACKER_ENABLED', 'SELF_HEAL_TIMELINE_ENABLED', 'EXTENDED_CHECKPOINT_ENABLED',
  'CANARY_ROLLOUT_ENABLED', 'DIFF_MINIMIZER_ENABLED', 'ADVERSARIAL_TESTER_ENABLED',
  'CLEAN_ROOM_TEST_ENABLED', 'SUBSYSTEM_CB_MESH_ENABLED', 'CONFIG_RECONCILER_ENABLED',
  'DEPENDENCY_HEALER_ENABLED', 'DB_HEALER_ENABLED', 'STATE_RECOVERY_ENABLED',
  'ENABLE_BLACKBOX',
];
const HEAVY_RESILIENCE_KEYS = [
  'POLICY_ACTION_VALIDATOR_ENABLED',
];

// ── Additional keys disabled ONLY in minimum mode ──
// Everything that isn't needed to solve questions.
const MINIMUM_ONLY_KEYS = [
  // Workers & background tasks
  'DIARY_WORKER_ENABLED',        // diary logging worker thread
  'WORKER_MANAGER_ENABLED',      // worker thread manager
  // Telemetry & monitoring
  'ENABLE_GAN_TELEMETRY',        // GAN telemetry collection
  'ENABLE_LOCAL_VLM',            // local VLM model loading (~50-100MB)
  // Services
  'NTFY_ENABLED',                // push notification alerts
  'PIX2TEX_ENABLED',             // OCR math extraction service
  // Survival & longevity
  'SURVIVAL_ENABLED',            // survival subsystem (ephemeral shield, tombstone, etc.)
  'LONGEVITY_ENABLED',           // longevity subsystem (self-ping, UI recovery, etc.)
  // Progress & tracking
  'PROGRESS_DETECTOR_ENABLED',   // progress/semantic detection
  'MODULE_TRACKING_ENABLED',     // module completion tracking
  // Monitoring
  'HEALTH_CHECK_ENABLED',        // periodic health checks
  'CIRCUIT_BREAKER_ENABLED',     // subsystem circuit breakers
  // Work shifts
  'WORK_SHIFTS_ENABLED',         // work shift scheduling
  // Exploration
  'ENABLE_EXPLORATION_PASS',     // already in HEAVY but duplicate for clarity
  'ENABLE_ADAPTIVE_PERFORMANCE', // already in HEAVY but duplicate for clarity
];

let _currentMode: MemoryMode = 'full_power';
let _gcTimer: ReturnType<typeof setInterval> | null = null;
let _monitorTimer: ReturnType<typeof setInterval> | null = null;
let _modeChangeCallbacks: Array<(mode: string, reason: string) => void> = [];
let _isShuttingDown = false;
let _browserClosedByProtection = false; // v3: track if we closed the browser
let _selfHealSessionActive = false; // v4: track if a self-heal session owns full power

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
function getMode(): MemoryMode {
  return _currentMode;
}

function getThresholds() {
  return MODE_THRESHOLDS[_currentMode];
}

function isMemoryProtection(): boolean {
  return _currentMode === 'memory_protection' || _currentMode === 'minimum';
}

function isMinimumMode(): boolean {
  return _currentMode === 'minimum';
}

// ═══════════════════════════════════════════════════════════════════════
// v6: GRADUATED MEMORY SHED — browser-safe memory recovery
// ═══════════════════════════════════════════════════════════════════════
// On Render 512MB, the browser is the biggest memory consumer (~100-200MB).
// But closing it during a quiz destroys the current question state.
//
// Shed levels (higher = more aggressive, more memory freed):
//   L0 (caches+GC):        ~5-15MB   — always safe, no browser impact
//   L1 (page blank+restore): ~30-80MB  — navigates to about:blank, GC, then back
//   L2 (page reload):      ~20-50MB  — reloads page, may lose unsaved form state
//   L3 (close browser):    ~100-200MB — last resort, destroys quiz state
//
// When preserveBrowser=true (mid-quiz), L0→L1→L2 are tried in sequence.
// The function stops at the first level that brings heap below targetMB,
// or after exhausting all browser-safe levels.
//
// When preserveBrowser=false (between quizzes, startup, etc.), jumps
// straight to L3 for maximum recovery.
// ═══════════════════════════════════════════════════════════════════════

/**
 * Shed memory using graduated levels. Returns the approximate heap after shedding (MB).
 *
 * @param reason - Why we're shedding (for logging)
 * @param options.preserveBrowser - If true, avoid closing the browser (use L0-L2 only).
 *   Use this when mid-quiz to avoid losing the current question state.
 * @param options.targetMB - Stop shedding once heap is below this value.
 *   If undefined, tries all levels up to maxLevel.
 * @param options.maxLevel - Maximum shed level to use (0-3). Default: 3 (full).
 *   If preserveBrowser is true, maxLevel is clamped to 2.
 */
async function shedMemory(reason: string = 'unknown', options?: {
  preserveBrowser?: boolean;
  targetMB?: number;
  maxLevel?: number;
}): Promise<number> {
  const beforeMB = process.memoryUsage().heapUsed / 1024 / 1024;
  const preserveBrowser = options?.preserveBrowser ?? false;
  const targetMB = options?.targetMB;
  // Clamp maxLevel to 2 if preserveBrowser
  let maxLevel = options?.maxLevel ?? 3;
  if (preserveBrowser && maxLevel > 2) {
    maxLevel = 2;
  }

  _log(`shedMemory(${reason}): starting at heap=${beforeMB.toFixed(1)}MB, preserveBrowser=${preserveBrowser}, maxLevel=L${maxLevel}${targetMB ? `, target=${targetMB}MB` : ''}`, 'WARN');

  // Helper: check if we've freed enough
  function heapBelowTarget(): boolean {
    if (targetMB === undefined) return false;
    return process.memoryUsage().heapUsed / 1024 / 1024 < targetMB;
  }

  // ── L0: Clear all caches + GC (no browser impact) ──
  // Frees ~5-15MB. Always safe — never touches the browser.
  if (maxLevel >= 0) {
    _clearAllCaches();
    if (global.gc) { try { global.gc(); } catch {} }

    if (heapBelowTarget()) {
      const afterMB = process.memoryUsage().heapUsed / 1024 / 1024;
      _log(`shedMemory L0 sufficient: ${beforeMB.toFixed(1)}MB → ${afterMB.toFixed(1)}MB`, 'INFO');
      return afterMB;
    }
  }

  // ── L1: Navigate page to about:blank, GC, navigate back ──
  // Frees ~30-80MB by releasing page-level JS heap, DOM nodes, images,
  // CSS computed styles, and rendering tree. The browser process stays
  // alive, so re-navigation is fast (~1-2s). The quiz page should
  // restore its state from its framework (e.g. Flutter/React router).
  if (maxLevel >= 1 && preserveBrowser) {
    try {
      const { container } = require('./container');
      const browserMod = container.get('browser', { required: false });
      const page = browserMod?.browserManager?.pageInstance;
      if (page && !page.isClosed()) {
        const currentUrl = page.url();
        if (currentUrl && currentUrl !== 'about:blank') {
          _log(`shedMemory L1: navigating to about:blank (was: ${currentUrl})`, 'WARN');
          try {
            await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 });
          } catch { /* timeout ok — blank page is fine */ }
          // GC while page is blank — JS heap for the old page is now unreachable
          if (global.gc) { try { global.gc(); } catch {} }
          await new Promise(r => setTimeout(r, 500)); // brief pause for async frees
          if (global.gc) { try { global.gc(); } catch {} }

          if (heapBelowTarget()) {
            const afterMB = process.memoryUsage().heapUsed / 1024 / 1024;
            _log(`shedMemory L1 sufficient (page at about:blank): ${beforeMB.toFixed(1)}MB → ${afterMB.toFixed(1)}MB`, 'INFO');
            return afterMB;
          }

          // Didn't free enough — navigate back to restore quiz state
          _log(`shedMemory L1: heap still above target, navigating back to ${currentUrl}`, 'WARN');
          try {
            await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          } catch (navErr: any) {
            _log(`shedMemory L1: navigate back failed: ${navErr.message || navErr}`, 'ERROR');
          }
          // Second GC after page reloads
          if (global.gc) { try { global.gc(); } catch {} }
        }
      }
    } catch (e: any) {
      _log(`shedMemory L1 error: ${e.message}`, 'DEBUG');
    }
  }

  // ── L2: Page reload (in-place, same URL) ──
  // Frees ~20-50MB. Preserves the URL so the app reloads at the same route.
  // May lose in-memory app state (e.g. partially typed answer), but the
  // question number/position should be restored by the app's state management.
  if (maxLevel >= 2 && preserveBrowser) {
    try {
      const { container } = require('./container');
      const browserMod = container.get('browser', { required: false });
      const page = browserMod?.browserManager?.pageInstance;
      if (page && !page.isClosed()) {
        const currentUrl = page.url();
        if (currentUrl && currentUrl !== 'about:blank') {
          _log(`shedMemory L2: reloading page ${currentUrl}`, 'WARN');
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
          } catch (reloadErr: any) {
            _log(`shedMemory L2: reload failed: ${reloadErr.message || reloadErr}`, 'ERROR');
          }
          // Aggressive GC after reload
          if (global.gc) { try { global.gc(); } catch {} }
          await new Promise(r => setTimeout(r, 500));
          if (global.gc) { try { global.gc(); } catch {} }

          if (heapBelowTarget()) {
            const afterMB = process.memoryUsage().heapUsed / 1024 / 1024;
            _log(`shedMemory L2 sufficient (page reloaded): ${beforeMB.toFixed(1)}MB → ${afterMB.toFixed(1)}MB`, 'INFO');
            return afterMB;
          }
        }
      }
    } catch (e: any) {
      _log(`shedMemory L2 error: ${e.message}`, 'DEBUG');
    }
  }

  // ── L3: Close browser entirely (last resort) ──
  // Frees ~100-200MB. DESTROYS quiz state — only when NOT preserving browser.
  if (maxLevel >= 3 && !preserveBrowser) {
    if (!_browserClosedByProtection) {
      try {
        const { container } = require('./container');
        const browserMod = container.get('browser', { required: false });
        if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
          await browserMod.browserManager.cleanup().catch((e: any) => {
            _log(`Browser cleanup during shed: ${e.message}`, 'DEBUG');
          });
          _browserClosedByProtection = true;
          _log('shedMemory L3: browser closed (~100-200MB freed)', 'WARN');
        }
      } catch (e: any) {
        _log(`shedMemory L3 browser close error: ${e.message}`, 'DEBUG');
      }
    }
    // Extra GC after browser close
    if (global.gc) { try { global.gc(); } catch {} }
    await new Promise(r => setTimeout(r, 500));
    if (global.gc) { try { global.gc(); } catch {} }
  }

  const afterMB = process.memoryUsage().heapUsed / 1024 / 1024;
  _log(`shedMemory(${reason}): ${beforeMB.toFixed(1)}MB → ${afterMB.toFixed(1)}MB (${(beforeMB - afterMB).toFixed(1)}MB freed, maxLevel=L${maxLevel})`, afterMB < beforeMB ? 'INFO' : 'ERROR');

  return afterMB;
}

/**
 * Clear all in-memory caches without touching the browser.
 * This is L0 of the graduated shed — always safe, ~5-15MB freed.
 */
function _clearAllCaches(): void {
  // Clear the main in-memory cache
  try {
    const { container } = require('./container');
    const cache = container.get('cache', { required: false });
    if (cache?.clearCache) {
      cache.clearCache();
      _log('L0: main cache cleared', 'DEBUG');
    }
  } catch { /* not available */ }

  // Clear pixel training in-memory cache
  try {
    const pt = require('./pixel-training');
    if (pt?.clearCache) {
      pt.clearCache();
      _log('L0: pixel training cache cleared', 'DEBUG');
    }
  } catch { /* not loaded */ }

  // Clear screenshot storage in-memory caches
  try {
    const ss = require('./screenshot-storage');
    if (ss?.clearCache) {
      ss.clearCache();
      _log('L0: screenshot storage cache cleared', 'DEBUG');
    }
  } catch { /* not loaded */ }

  // Clear the dashboard screenshot buffer (global)
  try {
    if ((globalThis as any).__setLatestScreenshot) {
      (globalThis as any).__setLatestScreenshot('');
      _log('L0: dashboard screenshot buffer cleared', 'DEBUG');
    }
  } catch { /* ignore */ }
}

/**
 * Check if memory protection mode closed the browser.
 * The cycle manager uses this to know it needs to re-launch the browser
 * for the next cycle (vs. using an existing page).
 */
function wasBrowserClosedByProtection(): boolean {
  return _browserClosedByProtection;
}

/**
 * Clear the browser-closed flag (called after cycle manager re-launches browser).
 */
function clearBrowserClosedFlag(): void {
  _browserClosedByProtection = false;
}

// ── Apply mode: set env vars, persist, AND shed memory ──
async function _applyMode(mode: MemoryMode, reason: string): Promise<void> {
  const prev = _currentMode;
  _currentMode = mode;
  const thresholds = MODE_THRESHOLDS[mode];

  if (mode === 'minimum') {
    // MINIMUM: disable everything. Includes all memory_protection keys PLUS
    // additional minimum-only keys.
    const allKeys = [...HEAVY_SELF_HEAL_KEYS, ...HEAVY_RESILIENCE_KEYS, ...MINIMUM_ONLY_KEYS];
    for (const key of allKeys) {
      process.env[key] = 'false';
    }
    // Also disable screenshots and log rotation to reduce disk I/O
    process.env.SAVE_SCREENSHOTS = 'false';
    process.env.ENABLE_GAN_TELEMETRY = 'false';
    process.env.ENABLE_LOCAL_VLM = 'false';
    _log(`MINIMUM mode activated: ${reason}. Disabled ${allKeys.length} modules. Only core question-solving pipeline active. Thresholds: warn=${thresholds.warnHeapMB}MB restart=${thresholds.restartHeapMB}MB GC=${thresholds.gcIntervalMs / 1000}s`, 'ERROR');

    // Persist minimum mode to DB so it survives restarts
    try {
      const dbMod = require('./database');
      if (dbMod?.db && dbMod.upsertCalibration) {
        dbMod.upsertCalibration.run(CALIBRATION_KEY_MINIMUM_MODE, JSON.stringify({ active: true, reason, ts: Date.now() }), Date.now());
      }
    } catch { /* DB not ready */ }

    // Aggressive memory shed
    if (prev !== mode) {
      const afterMB = await shedMemory(`minimum_activate:${reason}`, { maxLevel: 3, preserveBrowser: false });
      _log(`Minimum mode memory shed: ${afterMB.toFixed(1)}MB`, 'ERROR');
    }
  } else if (mode === 'memory_protection') {
    // Disable heavy modules via env vars
    for (const key of [...HEAVY_SELF_HEAL_KEYS, ...HEAVY_RESILIENCE_KEYS]) {
      process.env[key] = 'false';
    }
    // Re-enable minimum-only keys (they're only disabled in minimum mode)
    for (const key of MINIMUM_ONLY_KEYS) {
      delete process.env[key];
    }
    // Clear minimum mode DB marker
    try {
      const dbMod = require('./database');
      if (dbMod?.db?.prepare) {
        dbMod.db.prepare('DELETE FROM calibration WHERE key = ?').run(CALIBRATION_KEY_MINIMUM_MODE);
      }
    } catch { /* DB not ready */ }
    _log(`MEMORY PROTECTION mode activated: ${reason}. Disabled ${HEAVY_SELF_HEAL_KEYS.length + HEAVY_RESILIENCE_KEYS.length} heavy modules. Thresholds: warn=${thresholds.warnHeapMB}MB restart=${thresholds.restartHeapMB}MB GC=${thresholds.gcIntervalMs / 1000}s`, 'WARN');

    // v3 FIX: Actually shed memory instead of just logging about it
    // v5 FIX: await the async shedMemory
    if (prev !== mode) {
      // Only shed on actual mode transition, not on re-init
      const afterMB = await shedMemory(`mode_activate:${reason}`);
      _log(`Memory shed complete: now at ${afterMB.toFixed(1)}MB`, 'WARN');
    }
  } else {
    // Re-enable heavy modules (only env — they won't start until restart)
    for (const key of [...HEAVY_SELF_HEAL_KEYS, ...HEAVY_RESILIENCE_KEYS, ...MINIMUM_ONLY_KEYS]) {
      delete process.env[key];
    }
    // Clear minimum mode DB marker
    try {
      const dbMod = require('./database');
      if (dbMod?.db?.prepare) {
        dbMod.db.prepare('DELETE FROM calibration WHERE key = ?').run(CALIBRATION_KEY_MINIMUM_MODE);
      }
    } catch { /* DB not ready */ }
    _browserClosedByProtection = false;
    _log(`FULL POWER mode activated: ${reason}. Heavy modules will re-enable on restart. Thresholds: warn=${thresholds.warnHeapMB}MB restart=${thresholds.restartHeapMB}MB GC=${thresholds.gcIntervalMs / 1000}s`, 'INFO');
  }

  // Persist mode to /tmp (fast, same-instance)
  persistConfig.setMode(mode, reason, prev !== mode);

  // Persist mode to calibration table (local SQLite — sync write).
  try {
    const dbMod = require('./database');
    if (dbMod?.db && dbMod.upsertCalibration) {
      dbMod.upsertCalibration.run(CALIBRATION_KEY_MODE, JSON.stringify({ mode, reason, ts: Date.now() }), Date.now());
    }
  } catch { /* DB not ready yet — non-critical */ }

  // Notify callbacks
  if (prev !== mode) {
    for (const cb of _modeChangeCallbacks) {
      try { cb(mode, reason); } catch { /* ignore */ }
    }
  }
}

/**
 * Activate minimum mode. Called when OOM death spiral + self-heal failure
 * is detected, or when restored from DB.
 */
async function activateMinimumMode(reason: string): Promise<void> {
  if (_currentMode === 'minimum') return; // already in minimum
  await _applyMode('minimum', reason);
  _restartTimers();
}

/**
 * Deactivate minimum mode, returning to memory_protection.
 * Called after a successful self-heal fix from minimum mode,
 * or manually from the dashboard.
 */
async function deactivateMinimumMode(reason: string): Promise<void> {
  if (_currentMode !== 'minimum') return;
  await _applyMode('memory_protection', `minimum_exit:${reason}`);
  _restartTimers();
}

// ── Manual mode switch (from dashboard) ──
async function switchMode(mode: MemoryMode, reason: string): Promise<void> {
  await _applyMode(mode, `manual:${reason}`);
  _restartTimers();
}

// ── Auto-downgrade check ──
// v5 FIX: Now async because _applyMode is async (awaits browser cleanup)
async function checkAutoDowngrade(heapMB: number, rssMB: number): Promise<boolean> {
  if (_currentMode === 'memory_protection' || _currentMode === 'minimum') return false;

  let shouldDowngrade = false;
  let reason = '';

  if (heapMB > AUTO_DOWNGRADE_HEAP_MB) {
    shouldDowngrade = true;
    reason = `heap=${heapMB.toFixed(0)}MB > ${AUTO_DOWNGRADE_HEAP_MB}MB`;
  } else if (rssMB > AUTO_DOWNGRADE_RSS_MB) {
    shouldDowngrade = true;
    reason = `rss=${rssMB.toFixed(0)}MB > ${AUTO_DOWNGRADE_RSS_MB}MB`;
  }
  // NOTE: wasRecentlyOOMKilled() is NOT checked here. It is a startup-time
  // heuristic (file-gap, RSS, missing-persist-file) that only makes sense at
  // boot. It is already called in init().
  // Mid-run OOM detection is handled by checkAfterTursoSync() via the DB.

  if (shouldDowngrade) {
    // If already in minimum, don't downgrade further
    if (_currentMode === 'minimum') return false;
    await _applyMode('memory_protection', `auto:${reason}`);
    _restartTimers();
  }

  return shouldDowngrade;
}

// ═══════════════════════════════════════════════════════════════════════
// v4: Self-Heal Session Lifecycle — DB-backed, survives restarts
// ═══════════════════════════════════════════════════════════════════════
//
// Philosophy: The bot should NOT freely roam in FULL POWER mode.
// Full power is a scarce, dangerous resource on 512MB Render free tier.
// It is ONLY granted when self-heal desperately needs it to concoct
// a fix. Every action during that window is saved to the database so
// progress survives OOM kills. After a verified fix is promoted, the
// bot deletes old patch drafts and returns to MEMORY PROTECTION.
//
// If a self-heal session is active when the bot OOMs, the next
// startup detects it via the DB and can resume or abort.

/**
 * Check if there's an active self-heal session in the DB.
 * Called at init() to detect sessions that survived a restart.
 */
function _checkForActiveSelfHealSession(): void {
  try {
    const dbMod = require('./database');
    if (!dbMod?.db?.prepare || !dbMod?.selectCalibration) return;

    const row = dbMod.selectCalibration.get(CALIBRATION_KEY_SELF_HEAL_SESSION);
    if (!row) return;

    let session: any;
    try { session = JSON.parse(row.value); } catch { return; }

    if (session.status !== 'in_progress') return;

    const grantedTs = parseInt(session.grantedTs || '0', 10);
    const elapsed = Date.now() - grantedTs;

    if (elapsed > SELF_HEAL_SESSION_TIMEOUT_MS) {
      // Session expired — abort it, stay in memory_protection
      _log(`Self-heal session expired (${Math.round(elapsed / 60000)}min > ${SELF_HEAL_SESSION_TIMEOUT_MS / 60000}min timeout). Aborting.`, 'WARN');
      _writeSelfHealSessionToDB({ status: 'aborted', reason: 'session_timeout', abortedAt: Date.now() });
      return;
    }

    // Session still valid — grant full power again to continue healing
    _log(`Resuming self-heal session (elapsed: ${Math.round(elapsed / 60000)}min, timeout: ${SELF_HEAL_SESSION_TIMEOUT_MS / 60000}min). Granting FULL POWER.`, 'WARN');
    _selfHealSessionActive = true;
    // Fire-and-forget: at startup, no browser to close anyway
    _applyMode('full_power', `self_heal_resume:elapsed_${Math.round(elapsed / 60000)}min`).catch(() => {});
    _startSelfHealSessionTimeout(SELF_HEAL_SESSION_TIMEOUT_MS - elapsed);
  } catch (e: any) {
    _log(`Self-heal session restore check failed: ${e.message}`, 'DEBUG');
  }
}

/**
 * Write self-heal session state to the calibration DB.
 */
function _writeSelfHealSessionToDB(state: Record<string, any>): void {
  try {
    const dbMod = require('./database');
    if (dbMod?.db && dbMod.upsertCalibration) {
      dbMod.upsertCalibration.run(
        CALIBRATION_KEY_SELF_HEAL_SESSION,
        JSON.stringify({ ...state, updatedTs: Date.now() }),
        Date.now()
      );
    }
  } catch { /* non-critical — session is best-effort */ }
}

/**
 * Start the session timeout. If the session isn't finalized/aborted
 * before this fires, we abort automatically to prevent permanent full power.
 */
function _startSelfHealSessionTimeout(remainingMs: number): void {
  if (_selfHealSessionTimer) { clearTimeout(_selfHealSessionTimer); _selfHealSessionTimer = null; }
  _selfHealSessionTimer = setTimeout(() => {
    _log('Self-heal session timed out — forcing abort and return to MEMORY PROTECTION', 'ERROR');
    abortSelfHealSession('session_timeout');
  }, remainingMs);
  // Do NOT .unref() — we want this to fire even if the event loop is idle
}

/**
 * Begin a self-heal session. Grants FULL POWER temporarily.
 * This is the ONLY way to get full power automatically.
 *
 * The bot should call this ONLY when self-heal is desperately needed
 * and memory_protection is blocking the heavy modules required to fix
 * the problem. The caller must save all progress to the database after
 * each step so it survives OOM kills.
 *
 * Returns true if the session was started, false if one is already active
 * or the bot isn't in memory_protection mode.
 */
async function beginSelfHealSession(reason: string): Promise<boolean> {
  if (_selfHealSessionActive) {
    _log(`Self-heal session already active — ignoring beginSelfHealSession('${reason}')`, 'WARN');
    return false;
  }
  // Allow self-heal from both memory_protection AND minimum mode.
  // From minimum: promote to memory_protection (NOT full_power — too dangerous).
  // From memory_protection: promote to full_power (existing behavior).
  if (_currentMode !== 'memory_protection' && _currentMode !== 'minimum') {
    _log(`Not in memory_protection or minimum mode (current: ${_currentMode}) — self-heal session not needed`, 'DEBUG');
    return false;
  }

  const wasMinimum = _currentMode === 'minimum';

  _selfHealSessionActive = true;
  const grantedTs = Date.now();

  // Persist session to DB (survives restarts)
  _writeSelfHealSessionToDB({
    status: 'in_progress',
    reason,
    grantedTs,
  });

  // Also write the granted timestamp as a separate key for fast lookups
  try {
    const dbMod = require('./database');
    if (dbMod?.db && dbMod.upsertCalibration) {
      dbMod.upsertCalibration.run(CALIBRATION_KEY_SELF_HEAL_GRANTED_TS, String(grantedTs), grantedTs);
    }
  } catch { /* non-critical */ }

  // Switch to appropriate mode for healing
  // From minimum: go to memory_protection (safer, still disables heavy self-heal
  //   but re-enables the minimum-only keys like workers, telemetry, etc.)
  // From memory_protection: go to full_power (existing behavior)
  const healMode: MemoryMode = wasMinimum ? 'memory_protection' : 'full_power';
  // v5 FIX: await the mode switch (it's async now)
  await _applyMode(healMode, `self_heal_begin:${reason}`);
  _log(`SELF-HEAL SESSION STARTED: ${reason}. Promoted from ${wasMinimum ? 'MINIMUM' : 'MEMORY PROTECTION'} to ${healMode} for up to ${SELF_HEAL_SESSION_TIMEOUT_MS / 60000}min. SAVE ALL PROGRESS TO DB.`, 'WARN');

  // Start timeout
  _startSelfHealSessionTimeout(SELF_HEAL_SESSION_TIMEOUT_MS);

  return true;
}

/**
 * Append progress data for the current self-heal session.
 * Saved to DB so it survives OOM kills. Call this after every
 * meaningful step (investigation, patch generated, patch validated, etc.)
 */
function appendSelfHealProgress(step: string, data: Record<string, any>): void {
  if (!_selfHealSessionActive) return;

  try {
    const dbMod = require('./database');
    if (!dbMod?.db?.prepare) return;

    const progressKey = `self_heal_progress_${step}`;
    dbMod.upsertCalibration?.run(
      progressKey,
      JSON.stringify({ step, ...data, ts: Date.now() }),
      Date.now()
    );
  } catch { /* non-critical */ }

  _log(`Self-heal progress saved: ${step}`, 'DEBUG');
}

/**
 * Called after a verified self-heal fix has been successfully promoted.
 * This is the ONLY path that keeps full power active — but only briefly,
 * until finalizeSelfHealSession() cleans up and returns to memory_protection.
 *
 * The reason this exists: after a successful heal, the bot may need to
 * run a few more cycles in full power to verify the fix works in production.
 * But it MUST call finalizeSelfHealSession() when done.
 */
function promoteAfterSelfHealFix(filesFixed: string[]): void {
  if (!_selfHealSessionActive) {
    _log('promoteAfterSelfHealFix called but no active session — ignoring', 'WARN');
    return;
  }

  _writeSelfHealSessionToDB({
    status: 'fix_promoted',
    filesFixed,
    promotedAt: Date.now(),
  });

  _log(`Self-heal fix PROMOTED for: ${filesFixed.join(', ')}. Call finalizeSelfHealSession() when verification is complete to return to MEMORY PROTECTION.`, 'INFO');
}

/**
 * Finalize the self-heal session: delete patch drafts, return to MEMORY PROTECTION.
 * This MUST be called after promoteAfterSelfHealFix() once the fix is verified.
 */
async function finalizeSelfHealSession(): Promise<void> {
  if (!_selfHealSessionActive) return;

  // Clear the session timeout
  if (_selfHealSessionTimer) { clearTimeout(_selfHealSessionTimer); _selfHealSessionTimer = null; }

  _selfHealSessionActive = false;

  // Mark session as done in DB
  _writeSelfHealSessionToDB({
    status: 'done',
    finalizedAt: Date.now(),
  });

  // Delete progress keys (cleanup old drafts)
  try {
    const dbMod = require('./database');
    if (dbMod?.db?.prepare) {
      const rows = dbMod.db.prepare("SELECT key FROM calibration WHERE key LIKE 'self_heal_progress_%'").all();
      const deleteStmt = dbMod.db.prepare('DELETE FROM calibration WHERE key = ?');
      for (const row of rows) {
        deleteStmt.run(row.key);
      }
      _log(`Cleaned up ${rows.length} self-heal progress keys`, 'DEBUG');
    }
  } catch { /* non-critical */ }

  // Return to memory protection (or minimum if we were in minimum before)
  // v5 FIX: await so browser is actually closed before returning
  const targetMode: MemoryMode = 'memory_protection'; // always return to at least memory_protection
  if (_currentMode !== targetMode) {
    await _applyMode(targetMode, 'self_heal_finalize:fix_verified');
    _restartTimers();
  }

  _log(`Self-heal session FINALIZED. Returning to ${targetMode}. Patch drafts deleted.`, 'INFO');
}

/**
 * Abort the self-heal session (e.g., on failure, timeout, or OOM).
 * Returns to MEMORY PROTECTION immediately.
 */
async function abortSelfHealSession(reason: string): Promise<void> {
  if (!_selfHealSessionActive) return;

  // Clear the session timeout
  if (_selfHealSessionTimer) { clearTimeout(_selfHealSessionTimer); _selfHealSessionTimer = null; }

  _selfHealSessionActive = false;

  // Mark session as aborted in DB
  _writeSelfHealSessionToDB({
    status: 'aborted',
    reason,
    abortedAt: Date.now(),
  });

  // Return to memory protection immediately (or stay in minimum if DB says so)
  // v5 FIX: await so browser is actually closed
  // Check if minimum mode was active before this session
  let targetMode: MemoryMode = 'memory_protection';
  try {
    const dbMod = require('./database');
    if (dbMod?.selectCalibration) {
      const minRow = dbMod.selectCalibration.get(CALIBRATION_KEY_MINIMUM_MODE);
      if (minRow) {
        try {
          const parsed = JSON.parse(minRow.value);
          if (parsed.active) targetMode = 'minimum';
        } catch {}
      }
    }
  } catch {}
  if (_currentMode !== targetMode) {
    await _applyMode(targetMode, `self_heal_abort:${reason}`);
    _restartTimers();
  }

  _log(`Self-heal session ABORTED: ${reason}. Returned to ${targetMode}.`, 'WARN');
}

/**
 * Check if a self-heal session is currently active.
 */
function isSelfHealSessionActive(): boolean {
  return _selfHealSessionActive;
}

// ── Register mode change callback ──
function onModeChange(cb: (mode: string, reason: string) => void): void {
  _modeChangeCallbacks.push(cb);
}

// ── GC timer ──
function _restartTimers(): void {
  if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
  if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; }
  if (_selfHealSessionTimer) { clearTimeout(_selfHealSessionTimer); _selfHealSessionTimer = null; }

  const thresholds = MODE_THRESHOLDS[_currentMode];

  _gcTimer = setInterval(() => {
    if (_isShuttingDown) return;
    if (global.gc) {
      try { global.gc(); } catch { /* ignore */ }
    }
  }, thresholds.gcIntervalMs);
  if (_gcTimer && typeof (_gcTimer as any).unref === 'function') (_gcTimer as any).unref();

  // v4: No auto-promote timer. Full power is only granted via self-heal session.
  // If a self-heal session is active, ensure its timeout is running.
  if (_selfHealSessionActive && _currentMode === 'full_power') {
    // Timer should already be running, but ensure it
    if (!_selfHealSessionTimer) {
      _startSelfHealSessionTimeout(SELF_HEAL_SESSION_TIMEOUT_MS);
    }
  }
}

/**
 * Post-Turso-sync OOM check. Called after Turso pulls calibration data.
 */
async function checkAfterTursoSync(selectCalibration: any, upsertCalibration: any): Promise<void> {
  if (!selectCalibration || !upsertCalibration) return;

  try {
    // Check 0: Is MINIMUM mode persisted in the DB? (highest priority)
    const minRow = selectCalibration.get(CALIBRATION_KEY_MINIMUM_MODE);
    if (minRow) {
      try {
        const parsed = JSON.parse(minRow.value);
        if (parsed.active && _currentMode !== 'minimum') {
          await _applyMode('minimum', `db_restored_minimum:${parsed.reason || 'unknown'}`);
          _restartTimers();
          _log('Restored MINIMUM mode from database (Turso recovery)', 'ERROR');
          return;
        }
      } catch { /* parse error */ }
    }

    // Check 1: Was the mode persisted as memory_protection in the DB (via Turso)?
    const modeRow = selectCalibration.get(CALIBRATION_KEY_MODE);
    if (modeRow) {
      try {
        const parsed = JSON.parse(modeRow.value);
        if (parsed.mode === 'minimum' && _currentMode !== 'minimum') {
          await _applyMode('minimum', `db_restored_mode:${parsed.reason || 'unknown'}`);
          _restartTimers();
          _log('Restored MINIMUM mode from database (mode field)', 'ERROR');
          return;
        }
        if (parsed.mode === 'memory_protection' && _currentMode !== 'memory_protection') {
          await _applyMode('memory_protection', `db_restored:${parsed.reason || 'unknown'}`);
          _restartTimers();
          _log('Restored MEMORY PROTECTION mode from database (Turso recovery)', 'WARN');
          return;
        }
      } catch { /* parse error */ }
    }

    // Check 2: Was there a recent OOM exit recorded in the DB (via Turso)?
    const oomRow = selectCalibration.get(CALIBRATION_KEY_OOM_EXIT);
    if (oomRow) {
      const oomTs = parseInt(oomRow.value, 10);
      if (!isNaN(oomTs) && Date.now() - oomTs < OOM_RECOVERY_WINDOW_MS) {
        if (_currentMode !== 'memory_protection') {
          await _applyMode('memory_protection', `db_oom_recovery:exit_${Math.round((Date.now() - oomTs) / 1000)}s_ago`);
          _restartTimers();
          _log(`Detected OOM exit ${Math.round((Date.now() - oomTs) / 1000)}s ago in database — switching to MEMORY PROTECTION`, 'WARN');
        }
        return;
      }
    }

    // Check 3: Was the last memory heartbeat showing high memory?
    // The memory monitor writes a heartbeat every ~5 min to calibration DB.
    // If the previous instance was running hot (>300MB heap) and died recently
    // (heartbeat <15 min old), it was likely OOM-killed before recordOOMExit ran.
    try {
      const heartbeatRow = selectCalibration.get(CALIBRATION_KEY_MEMORY_HEARTBEAT);
      if (heartbeatRow) {
        const hb = JSON.parse(heartbeatRow.value);
        if (hb && typeof hb.heapMB === 'number' && typeof hb.ts === 'number') {
          const ageSeconds = Math.round((Date.now() - hb.ts) / 1000);
          if (hb.heapMB > 300 && ageSeconds < HEARTBEAT_RECOVERY_WINDOW_MS / 1000) {
            if (_currentMode !== 'memory_protection') {
              await _applyMode('memory_protection', `db_heartbeat:heap_${hb.heapMB.toFixed(0)}MB_${ageSeconds}s_ago`);
              _restartTimers();
              _log(`Detected high memory heartbeat (${hb.heapMB.toFixed(0)}MB heap, ${ageSeconds}s ago) — switching to MEMORY PROTECTION`, 'WARN');
            }
            return;
          }
        }
      }
    } catch { /* parse error — skip */ }
  } catch (e: any) {
    _log(`Post-Turso OOM check failed: ${e.message}`, 'WARN');
  }
}

/**
 * Record an OOM exit event. v3 FIX: blocks briefly (2s) for the Turso write
 * so the OOM marker actually survives the restart. Previously the
 * fire-and-forget async write never completed before process.exit().
 */
function recordOOMExit(heapMB: number, rssMB: number): void {
  const now = Date.now();
  const value = String(now);

  // Write to local SQLite (sync — guaranteed before exit)
  try {
    const dbMod = require('./database');
    if (dbMod?.db && dbMod.upsertCalibration) {
      dbMod.upsertCalibration.run(CALIBRATION_KEY_OOM_EXIT, value, now);
    }
  } catch { /* DB not available */ }

  // v3 FIX: Synchronous-ish Turso write — wait up to 2s for it to complete.
  // This ensures the OOM marker survives the restart so the next startup
  // can detect it via checkAfterTursoSync(). Without this, the async
  // fire-and-forget write never completed before process.exit(), so the
  // bot never knew it had been OOM-killed.
  try {
    const turso = require('./database-turso');
    if (turso?.tursoUpsertCalibration) {
      const tursoPromise = turso.tursoUpsertCalibration(CALIBRATION_KEY_OOM_EXIT, value, now);
      // Create a synchronous barrier — spin-wait for up to 2s
      const deadline = Date.now() + 2000;
      let settled = false;
      tursoPromise.then(() => { settled = true; }).catch(() => { settled = true; });
      // eslint-disable-next-line no-empty
      while (Date.now() < deadline && !settled) { /* busy-wait for Turso write */ }
      if (!settled) {
        _log('Turso OOM write timed out after 2s — local SQLite write is the fallback', 'WARN');
      } else {
        _log('OOM exit recorded to both local SQLite and Turso', 'INFO');
      }
    }
  } catch { /* turso module not available */ }

  _log(`OOM exit recorded: heap=${heapMB.toFixed(0)}MB rss=${rssMB.toFixed(0)}MB`, 'WARN');
}

/**
 * Get the stored OOM kill count from the lifecycle OOM tracking.
 * Used at init to decide between memory_protection and minimum.
 */
function _getStoredOOMCount(): number {
  try {
    const dbMod = require('./database');
    if (!dbMod?.selectCalibration) return 0;
    const row = dbMod.selectCalibration.get('lifecycle_oom_count');
    if (!row) return 0;
    const count = parseInt(row.value, 10);
    return isNaN(count) ? 0 : count;
  } catch { return 0; }
}

// ── Initialize: restore persisted mode + check for OOM history ──
// v5 FIX: init() is intentionally sync (called at module load time).
// At init, no browser exists yet, so _applyMode's shedMemory is a no-op for
// the browser step — only sets env vars and persists. The real memory shed
// happens later when checkAfterTursoSync() or the monitor triggers it.
// We fire-and-forget the _applyMode promise to avoid changing the init API.
function init(): void {
  try {
    // Check for persisted minimum mode in DB first (survives /tmp wipes)
    try {
      const dbMod = require('./database');
      if (dbMod?.selectCalibration) {
        const minRow = dbMod.selectCalibration.get(CALIBRATION_KEY_MINIMUM_MODE);
        if (minRow) {
          try {
            const parsed = JSON.parse(minRow.value);
            if (parsed.active) {
              _applyMode('minimum', `db_boot_minimum:${parsed.reason || 'unknown'}`).catch(() => {});
              _log('Starting in MINIMUM mode (restored from database)', 'ERROR');
              _checkForActiveSelfHealSession();
              _restartTimers();
              return;
            }
          } catch {}
        }
      }
    } catch {}

    const persisted = persistConfig.getMode();
    if (persisted.current === 'minimum') {
      _applyMode('minimum', `restored:${persisted.reason}`).catch(() => {});
      _log('Starting in MINIMUM mode (restored from persistent storage)', 'ERROR');
    } else if (persisted.current === 'memory_protection') {
      _applyMode('memory_protection', `restored:${persisted.reason}`).catch(() => {});
      _log('Restored MEMORY PROTECTION mode from persistent storage', 'INFO');
    } else if (persistConfig.wasRecentlyOOMKilled()) {
      // Check OOM kill count — if very high, go straight to minimum
      const oomCount = _getStoredOOMCount();
      if (oomCount >= MINIMUM_MODE_OOM_KILL_THRESHOLD) {
        _applyMode('minimum', `boot_oom_count:${oomCount}`).catch(() => {});
        _log(`Detected ${oomCount} recent OOM kills — starting in MINIMUM mode`, 'ERROR');
      } else {
        _applyMode('memory_protection', 'auto:OOM_kill_recovery').catch(() => {});
        _log('Detected recent OOM kill — starting in MEMORY PROTECTION mode', 'WARN');
      }
    } else {
      // v4: Default to memory_protection. Full power requires self-heal session
      // or manual dashboard switch. This is the safe default on 512MB.
      _applyMode('memory_protection', 'init_default_safe').catch(() => {});
      _log('Starting in MEMORY PROTECTION mode (safe default). Full power requires self-heal session or manual switch.', 'INFO');
    }
  } catch (e: any) {
    _applyMode('memory_protection', 'init_fallback').catch(() => {});
    _log('Init fallback — MEMORY PROTECTION mode', 'WARN');
  }

  // v4: Check for an active self-heal session from a previous instance.
  // If found and not expired, resume full power to continue healing.
  _checkForActiveSelfHealSession();

  _restartTimers();
}

function shutdown(): void {
  _isShuttingDown = true;
  if (_gcTimer) { clearInterval(_gcTimer); _gcTimer = null; }
  if (_monitorTimer) { clearInterval(_monitorTimer); _monitorTimer = null; }
  if (_selfHealSessionTimer) { clearTimeout(_selfHealSessionTimer); _selfHealSessionTimer = null; }

  // On graceful shutdown, abort any active self-heal session
  if (_selfHealSessionActive) {
    _writeSelfHealSessionToDB({
      status: 'aborted',
      reason: 'graceful_shutdown',
      abortedAt: Date.now(),
    });
    _selfHealSessionActive = false;
  }
}

let _isMidQuiz = false; // v6: set by cycle-manager, read by render-free-plan monitor

/**
 * v6: Set whether the bot is currently mid-quiz.
 * When true, the render-free-plan monitor and heap guardian will
 * use browser-safe memory shedding (L0-L2) instead of closing
 * the browser (L3) which would destroy quiz state.
 */
function setMidQuiz(midQuiz: boolean): void {
  _isMidQuiz = midQuiz;
}

/** v6: Check if the bot is currently mid-quiz. */
function isMidQuiz(): boolean {
  return _isMidQuiz;
}

module.exports = {
  init,
  shutdown,
  getMode,
  getThresholds,
  isMemoryProtection,
  isMinimumMode,
  switchMode,
  activateMinimumMode,
  deactivateMinimumMode,
  checkAutoDowngrade,
  checkAfterTursoSync,
  recordOOMExit,
  onModeChange,
  shedMemory,                    // v3: standalone emergency memory shed
  wasBrowserClosedByProtection,  // v3: for cycle manager to check
  clearBrowserClosedFlag,       // v3: for cycle manager to reset
  setMidQuiz,                   // v6: set mid-quiz flag for browser-safe shedding
  isMidQuiz,                    // v6: query mid-quiz flag
  // v4: Self-heal session lifecycle
  beginSelfHealSession,
  appendSelfHealProgress,
  promoteAfterSelfHealFix,
  finalizeSelfHealSession,
  abortSelfHealSession,
  isSelfHealSessionActive,
  // Constants
  HEAVY_SELF_HEAL_KEYS,
  HEAVY_RESILIENCE_KEYS,
  MINIMUM_ONLY_KEYS,
  AUTO_DOWNGRADE_HEAP_MB,
  AUTO_DOWNGRADE_RSS_MB,
  MINIMUM_MODE_OOM_KILL_THRESHOLD,
  SELF_HEAL_SESSION_TIMEOUT_MS,
  CALIBRATION_KEY_MINIMUM_MODE,
};
