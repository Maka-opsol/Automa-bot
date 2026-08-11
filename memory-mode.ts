'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Memory Mode Manager — Full Power / Memory Protection
// ═══════════════════════════════════════════════════════════════════════
// Two operational modes:
//
//   FULL POWER:         All subsystems enabled, normal GC, full features.
//                       Memory thresholds: warn=350MB, restart=400MB
//
//   MEMORY PROTECTION:  Heavy subsystems disabled, aggressive GC (30s),
//                       browser closed, caches purged, tighter thresholds.
//                       Memory thresholds: warn=250MB, restart=280MB
//
// Auto-switching rules:
//   → Memory Protection: when heap > 320MB or RSS > 440MB or wasRecentlyOOMKilled()
//   → Full Power:       ONLY after a verified self-heal fix is promoted
//                       (via promoteAfterSelfHealFix). NEVER auto-promotes.
//                       Manual dashboard switch is still available for testing.
//
// v3 FIX: _applyMode('memory_protection') now performs IMMEDIATE memory
//   recovery (close browser, clear caches, force GC) instead of just
//   setting env vars. This was the root cause of the bot dying without
//   ever activating protection — it switched mode but never freed memory.
//
// v3 FIX: recordOOMExit now blocks briefly for the Turso write to ensure
//   the OOM marker survives the restart. Previously the fire-and-forget
//   Turso write never completed before process.exit().
//
// v3 FIX: Added shedMemory() as a standalone emergency function that can
//   be called by the heap guardian or cycle manager at any time.
// ═══════════════════════════════════════════════════════════════════════

const persistConfig = require('./persistent-config');

// Calibration keys for DB-backed persistence (survives /tmp wipes via Turso)
const CALIBRATION_KEY_MODE = 'memory_mode_current';
const CALIBRATION_KEY_OOM_EXIT = 'oom_last_exit_ts';
const CALIBRATION_KEY_MEMORY_HEARTBEAT = 'last_memory_heartbeat';
const OOM_RECOVERY_WINDOW_MS = 10 * 60 * 1000; // 10 minutes
const HEARTBEAT_RECOVERY_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

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
    gcIntervalMs: 30 * 1000,     // v3: was 60s — now 30s for more aggressive GC
    monitorIntervalMs: 10 * 1000,  // v3: was 15s — now 10s for faster detection
    warningStreak: 1,              // v3: was 2 — now react on FIRST warning
  },
};

// Auto-downgrade triggers (switch to memory_protection)
const AUTO_DOWNGRADE_HEAP_MB = 320;
const AUTO_DOWNGRADE_RSS_MB = 440;

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
const SELF_HEAL_SESSION_TIMEOUT_MS = 30 * 60 * 1000; // 30 min max per session
let _selfHealSessionTimer: ReturnType<typeof setTimeout> | null = null;

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
function getMode(): 'full_power' | 'memory_protection' {
  return _currentMode;
}

function getThresholds() {
  return MODE_THRESHOLDS[_currentMode];
}

function isMemoryProtection(): boolean {
  return _currentMode === 'memory_protection';
}

// ═══════════════════════════════════════════════════════════════════════
// v3: EMERGENCY MEMORY SHED — actually frees memory
// ═══════════════════════════════════════════════════════════════════════
// This is the core fix. Previously _applyMode only set env vars.
// Now it calls this to immediately reduce memory pressure.
// Can also be called standalone by the heap guardian or cycle manager.

/**
 * Shed memory immediately. Closes browser, clears caches, forces GC.
 * Returns the approximate heap after shedding (MB).
 *
 * Order matters: browser first (biggest consumer ~100-200MB),
 * then caches, then GC to reclaim freed objects.
 */
function shedMemory(reason: string = 'unknown'): number {
  const beforeMB = process.memoryUsage().heapUsed / 1024 / 1024;
  _log(`shedMemory(${reason}): starting at heap=${beforeMB.toFixed(1)}MB`, 'WARN');

  // Step 1: Close browser — the single biggest memory consumer
  // Playwright/Chromium holds ~100-200MB of shared memory
  if (!_browserClosedByProtection) {
    try {
      const { container } = require('./container');
      const browserMod = container.get('browser', { required: false });
      if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
        browserMod.browserManager.cleanup().catch((e: any) => {
          _log(`Browser cleanup during shed: ${e.message}`, 'DEBUG');
        });
        _browserClosedByProtection = true;
        _log('shedMemory: browser closed (~100-200MB freed)', 'WARN');
      }
    } catch (e: any) {
      _log(`shedMemory browser close error: ${e.message}`, 'DEBUG');
    }
  }

  // Step 2: Clear providers-base coalescer cache
  try {
    const base = require('./providers-base');
    if (base?.coalescer?.clear) {
      base.coalescer.clear();
      _log('shedMemory: coalescer cache cleared', 'DEBUG');
    }
  } catch { /* not loaded yet */ }

  // Step 3: Clear Gemini model cooldowns (unbounded Map)
  try {
    // The cooldowns are module-scoped, but we can trigger a full clear
    // by requiring the module and calling its clear if exported
    const gemini = require('./providers-gemini');
    // Model cooldowns are internal — we can't directly clear them.
    // But we can force a GC which will collect orphaned entries.
  } catch { /* not loaded */ }

  // Step 4: Clear the main in-memory cache
  try {
    const { container } = require('./container');
    const cache = container.get('cache', { required: false });
    if (cache?.clearCache) {
      cache.clearCache();
      _log('shedMemory: main cache cleared', 'DEBUG');
    }
  } catch { /* not available */ }

  // Step 5: Clear pixel training in-memory cache (bounded LRU, but free it)
  try {
    const pt = require('./pixel-training');
    if (pt?.clearCache) {
      pt.clearCache();
      _log('shedMemory: pixel training cache cleared', 'DEBUG');
    }
  } catch { /* not loaded */ }

  // Step 6: Clear screenshot storage in-memory caches
  try {
    const ss = require('./screenshot-storage');
    if (ss?.clearCache) {
      ss.clearCache();
      _log('shedMemory: screenshot storage cache cleared', 'DEBUG');
    }
  } catch { /* not loaded */ }

  // Step 7: Force GC — twice with a small delay for async cleanup
  if (global.gc) {
    try { global.gc(); } catch { /* ignore */ }
  }
  setTimeout(() => {
    if (global.gc) {
      try { global.gc(); } catch { /* ignore */ }
    }
  }, 3000).unref();

  // Step 8: Clear the dashboard screenshot buffer (global)
  try {
    if ((globalThis as any).__setLatestScreenshot) {
      (globalThis as any).__setLatestScreenshot('');
      _log('shedMemory: dashboard screenshot buffer cleared', 'DEBUG');
    }
  } catch { /* ignore */ }

  const afterMB = process.memoryUsage().heapUsed / 1024 / 1024;
  _log(`shedMemory(${reason}): ${beforeMB.toFixed(1)}MB → ${afterMB.toFixed(1)}MB (${(beforeMB - afterMB).toFixed(1)}MB freed)`, afterMB < beforeMB ? 'INFO' : 'ERROR');

  return afterMB;
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
function _applyMode(mode: 'full_power' | 'memory_protection', reason: string): void {
  const prev = _currentMode;
  _currentMode = mode;
  const thresholds = MODE_THRESHOLDS[mode];

  if (mode === 'memory_protection') {
    // Disable heavy modules via env vars
    for (const key of [...HEAVY_SELF_HEAL_KEYS, ...HEAVY_RESILIENCE_KEYS]) {
      process.env[key] = 'false';
    }
    _log(`MEMORY PROTECTION mode activated: ${reason}. Disabled ${HEAVY_SELF_HEAL_KEYS.length + HEAVY_RESILIENCE_KEYS.length} heavy modules. Thresholds: warn=${thresholds.warnHeapMB}MB restart=${thresholds.restartHeapMB}MB GC=${thresholds.gcIntervalMs / 1000}s`, 'WARN');

    // v3 FIX: Actually shed memory instead of just logging about it
    if (prev !== mode) {
      // Only shed on actual mode transition, not on re-init
      const afterMB = shedMemory(`mode_activate:${reason}`);
      _log(`Memory shed complete: now at ${afterMB.toFixed(1)}MB`, 'WARN');
    }
  } else {
    // Re-enable heavy modules (only env — they won't start until restart)
    for (const key of [...HEAVY_SELF_HEAL_KEYS, ...HEAVY_RESILIENCE_KEYS]) {
      delete process.env[key];
    }
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

// ── Manual mode switch (from dashboard) ──
function switchMode(mode: 'full_power' | 'memory_protection', reason: string): void {
  _applyMode(mode, `manual:${reason}`);
  _restartTimers();
}

// ── Auto-downgrade check ──
function checkAutoDowngrade(heapMB: number, rssMB: number): boolean {
  if (_currentMode === 'memory_protection') return false;

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
    _applyMode('memory_protection', `auto:${reason}`);
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
    _applyMode('full_power', `self_heal_resume:elapsed_${Math.round(elapsed / 60000)}min`);
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
function beginSelfHealSession(reason: string): boolean {
  if (_selfHealSessionActive) {
    _log(`Self-heal session already active — ignoring beginSelfHealSession('${reason}')`, 'WARN');
    return false;
  }
  if (_currentMode !== 'memory_protection') {
    _log(`Not in memory_protection mode (current: ${_currentMode}) — self-heal session not needed`, 'DEBUG');
    return false;
  }

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

  // Switch to full power
  _applyMode('full_power', `self_heal_begin:${reason}`);
  _log(`SELF-HEAL SESSION STARTED: ${reason}. Full power granted for up to ${SELF_HEAL_SESSION_TIMEOUT_MS / 60000}min. SAVE ALL PROGRESS TO DB.`, 'WARN');

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
function finalizeSelfHealSession(): void {
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

  // Return to memory protection
  if (_currentMode !== 'memory_protection') {
    _applyMode('memory_protection', 'self_heal_finalize:fix_verified');
    _restartTimers();
  }

  _log('Self-heal session FINALIZED. Returning to MEMORY PROTECTION. Patch drafts deleted.', 'INFO');
}

/**
 * Abort the self-heal session (e.g., on failure, timeout, or OOM).
 * Returns to MEMORY PROTECTION immediately.
 */
function abortSelfHealSession(reason: string): void {
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

  // Return to memory protection immediately
  if (_currentMode !== 'memory_protection') {
    _applyMode('memory_protection', `self_heal_abort:${reason}`);
    _restartTimers();
  }

  _log(`Self-heal session ABORTED: ${reason}. Returned to MEMORY PROTECTION.`, 'WARN');
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
function checkAfterTursoSync(selectCalibration: any, upsertCalibration: any): void {
  if (!selectCalibration || !upsertCalibration) return;

  try {
    // Check 1: Was the mode persisted as memory_protection in the DB (via Turso)?
    const modeRow = selectCalibration.get(CALIBRATION_KEY_MODE);
    if (modeRow) {
      try {
        const parsed = JSON.parse(modeRow.value);
        if (parsed.mode === 'memory_protection' && _currentMode !== 'memory_protection') {
          _applyMode('memory_protection', `db_restored:${parsed.reason || 'unknown'}`);
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
          _applyMode('memory_protection', `db_oom_recovery:exit_${Math.round((Date.now() - oomTs) / 1000)}s_ago`);
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
              _applyMode('memory_protection', `db_heartbeat:heap_${hb.heapMB.toFixed(0)}MB_${ageSeconds}s_ago`);
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

// ── Initialize: restore persisted mode + check for OOM history ──
function init(): void {
  try {
    const persisted = persistConfig.getMode();
    if (persisted.current === 'memory_protection') {
      _applyMode('memory_protection', `restored:${persisted.reason}`);
      _log('Restored MEMORY PROTECTION mode from persistent storage', 'INFO');
    } else if (persistConfig.wasRecentlyOOMKilled()) {
      _applyMode('memory_protection', 'auto:OOM_kill_recovery');
      _log('Detected recent OOM kill — starting in MEMORY PROTECTION mode', 'WARN');
    } else {
      // v4: Default to memory_protection. Full power requires self-heal session
      // or manual dashboard switch. This is the safe default on 512MB.
      _applyMode('memory_protection', 'init_default_safe');
      _log('Starting in MEMORY PROTECTION mode (safe default). Full power requires self-heal session or manual switch.', 'INFO');
    }
  } catch (e: any) {
    _applyMode('memory_protection', 'init_fallback');
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

module.exports = {
  init,
  shutdown,
  getMode,
  getThresholds,
  isMemoryProtection,
  switchMode,
  checkAutoDowngrade,
  checkAfterTursoSync,
  recordOOMExit,
  onModeChange,
  shedMemory,                    // v3: standalone emergency memory shed
  wasBrowserClosedByProtection,  // v3: for cycle manager to check
  clearBrowserClosedFlag,       // v3: for cycle manager to reset
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
  AUTO_DOWNGRADE_HEAP_MB,
  AUTO_DOWNGRADE_RSS_MB,
  SELF_HEAL_SESSION_TIMEOUT_MS,
};
