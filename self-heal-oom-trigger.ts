'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// self-heal-oom-trigger.ts — Boot-Time OOM Self-Heal Trigger
// ═══════════════════════════════════════════════════════════════════════════
// Problem: When the bot OOM-kills (exit code 137, SIGKILL), the process
// never gets a graceful shutdown signal. The survival-restart-guardian
// correctly detects OOM loops via DB-backed restart counting and switches
// to memory_protection mode — but it NEVER triggers self-heal.
//
// Self-heal only runs from within the cycle loop:
//   _isDesperatelyBroken() → performSelfHeal()
//
// When the process OOMs every ~5 minutes (as shown in Render events),
// the cycle loop may never reach the self-heal check point. The bot
// survives in degraded memory_protection mode but never fixes the
// root cause.
//
// Solution: This module is called at BOOT TIME (in render-free-plan.ts
// and agent.ts) AFTER the restart guardian init. If an OOM loop is
// detected, it:
//   1. Records a process_lifecycle event (DB, survives restarts)
//   2. Records a self_heal_event with trigger_reason='oom_loop_boot'
//   3. Schedules a self-heal run via setTimeout (0-30s delay)
//   4. The self-heal runs in memory_protection mode (lightweight)
//   5. All progress is saved to DB so it accumulates across restarts
//
// If the process OOMs again before self-heal completes, the next boot
// picks up where it left off because the self_heal_event is already in DB.
//
// Integration:
//   - render-free-plan.ts: init() after restart guardian
//   - agent.ts: init() after restart guardian
//   - survival-restart-guardian.ts: onEmergencyActivate hook
// ═══════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};
let _initialized = false;
let _bootHealScheduled = false;

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function log(msg: string, level: string = 'INFO') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, 'oom-trigger'); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [oom-trigger] ${msg}`);
}

function logError(msg: string, err: Error) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  console.error(`[ERROR] [oom-trigger] ${msg}`, err);
}

function getDb() { return _deps.database?.db; }
function getInsertSelfHealEvent() { return _deps.database?.insertSelfHealEvent; }

// ─── Configuration ──────────────────────────────────────────────────────────

// How long to wait before triggering self-heal at boot (ms).
// Gives the process time to stabilize (DB ready, logger ready, etc.)
// but short enough to run before the next OOM.
const BOOT_HEAL_DELAY_MS = 15 * 1000; // 15 seconds

// Don't re-trigger boot heal if one was scheduled in the last N minutes.
// This prevents scheduling a new heal on every boot when the previous
// one hasn't had time to run.
const BOOT_HEAL_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// Calibration key for tracking last boot heal schedule time.
const DB_KEY_LAST_BOOT_HEAL = 'oom_trigger_last_boot_heal';

// ─── Process Lifecycle Tracking ────────────────────────────────────────────

/**
 * Record a process start event in the process_lifecycle table.
 * This survives OOM kills because it's in the DB (synced via Turso).
 */
function recordProcessStart(wasUnexpected: boolean, restartCount: number): void {
  try {
    const db = getDb();
    if (!db) return;

    db.prepare(`
      INSERT INTO process_lifecycle (pid, event, timestamp, heap_mb, rss_mb, extra)
      VALUES (?, 'start', ?, ?, ?, ?)
    `).run(
      process.pid,
      Date.now(),
      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      Math.round(process.memoryUsage().rss / 1024 / 1024),
      JSON.stringify({ wasUnexpected, restartCount, nodeVersion: process.version })
    );
  } catch (e: any) {
    // Table might not exist yet (first migration) — non-critical
    log(`Failed to record process start: ${e.message}`, 'DEBUG');
  }
}

/**
 * Record a process stop event. Called on graceful shutdown.
 * The ABSENCE of a 'stop' event after a 'start' event is how
 * we detect OOM kills (SIGKILL doesn't allow any handler to run).
 */
function recordProcessStop(reason: string): void {
  try {
    const db = getDb();
    if (!db) return;

    db.prepare(`
      INSERT INTO process_lifecycle (pid, event, timestamp, heap_mb, rss_mb, extra)
      VALUES (?, 'stop', ?, ?, ?, ?)
    `).run(
      process.pid,
      Date.now(),
      Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
      Math.round(process.memoryUsage().rss / 1024 / 1024),
      JSON.stringify({ reason })
    );
  } catch (e: any) {
    log(`Failed to record process stop: ${e.message}`, 'DEBUG');
  }
}

/**
 * Analyze the process_lifecycle table to count OOM kills.
 * An OOM kill is a 'start' event that has NO corresponding 'stop' event
// from the same PID within a reasonable time window.
 */
function getRecentOOMKillCount(windowMs: number = 30 * 60 * 1000): number {
  try {
    const db = getDb();
    if (!db) return 0;

    const windowStart = Date.now() - windowMs;

    // Count start events without a matching stop event from the same PID
    // A stop event from the same PID proves graceful shutdown.
    // No stop event = killed (OOM SIGKILL or crash).
    const row = db.prepare(`
      SELECT COUNT(*) as cnt FROM process_lifecycle
      WHERE event = 'start' AND timestamp > ?
      AND pid NOT IN (
        SELECT pid FROM process_lifecycle
        WHERE event = 'stop' AND timestamp > ?
      )
    `).get(windowStart, windowStart);

    return row?.cnt || 0;
  } catch (e: any) {
    log(`Failed to count OOM kills: ${e.message}`, 'DEBUG');
    return 0;
  }
}

// ─── Boot-Time Self-Heal Trigger ───────────────────────────────────────────

/**
 * Check if we should schedule a boot-time self-heal.
 * Returns true if OOM loop conditions are met and we haven't
 * recently scheduled one.
 */
function shouldScheduleBootHeal(): boolean {
  // Check 1: Is there an active OOM loop? (restart guardian knows)
  try {
    const guardian = require('./survival-restart-guardian');
    if (!guardian.isEmergencyMode?.()) {
      // Not in emergency mode — but check moderate restart count
      const status = guardian.getStatus?.();
      if (!status || status.recentUnexpectedRestarts < 2) {
        return false;
      }
    }
  } catch {
    // Restart guardian not available — use our own DB check
    if (getRecentOOMKillCount() < 2) return false;
  }

  // Check 2: Cooldown — don't schedule if we recently tried
  try {
    const db = getDb();
    if (db) {
      const row = db.prepare('SELECT value, updated_at FROM calibration WHERE key = ?').get(DB_KEY_LAST_BOOT_HEAL);
      if (row) {
        const lastHealTime = parseInt(row.value, 10);
        if (Date.now() - lastHealTime < BOOT_HEAL_COOLDOWN_MS) {
          log(`Boot heal in cooldown (last scheduled ${Math.round((Date.now() - lastHealTime) / 60000)}min ago)`, 'DEBUG');
          return false;
        }
      }
    }
  } catch { /* non-critical */ }

  return true;
}

/**
 * Gather diagnostic context from DB about what was happening
 * before the OOM kills. This helps self-heal investigate the
 * root cause without needing the cycle loop's error history.
 */
function gatherOOMDiagnostics(): string {
  const parts: string[] = [];

  try {
    const db = getDb();
    if (!db) return 'No DB available';

    // 1. Recent self_heal_events (last 30 min)
    try {
      const events = db.prepare(`
        SELECT feature_id, phase, trigger_reason, outcome, error
        FROM self_heal_events
        WHERE timestamp > ?
        ORDER BY timestamp DESC LIMIT 10
      `).all(Date.now() - 30 * 60 * 1000);

      if (events.length > 0) {
        parts.push(`Recent self-heal events (${events.length}):`);
        for (const e of events) {
          const line = `  [${e.phase}] ${e.feature_id}: ${e.trigger_reason || 'no trigger'} → ${e.outcome || 'unknown'}${e.error ? ` (err: ${e.error.substring(0, 100)})` : ''}`;
          parts.push(line);
        }
      }
    } catch { /* table might not exist */ }

    // 2. Process lifecycle — recent OOM kills
    try {
      const oomCount = getRecentOOMKillCount();
      if (oomCount > 0) {
        parts.push(`OOM kill count (last 30min): ${oomCount}`);
      }

      // Last few process starts
      const starts = db.prepare(`
        SELECT timestamp, heap_mb, extra FROM process_lifecycle
        WHERE event = 'start'
        ORDER BY timestamp DESC LIMIT 5
      `).all();
      if (starts.length > 0) {
        parts.push('Recent process starts:');
        for (const s of starts) {
          const extra = s.extra ? JSON.parse(s.extra) : {};
          parts.push(`  ${new Date(s.timestamp).toISOString()} heap=${s.heap_mb}MB unexpected=${extra.wasUnexpected}`);
        }
      }
    } catch { /* non-critical */ }

    // 3. Recent blackbox failures
    try {
      const failures = db.prepare(`
        SELECT timestamp, state, action, reasoning, provider_used
        FROM blackbox
        WHERE timestamp > ? AND success = 0
        ORDER BY timestamp DESC LIMIT 10
      `).all(Date.now() - 30 * 60 * 1000);

      if (failures.length > 0) {
        parts.push(`Recent cycle failures (${failures.length}):`);
        const stateCounts: Record<string, number> = {};
        for (const f of failures) {
          stateCounts[f.state] = (stateCounts[f.state] || 0) + 1;
        }
        for (const [state, count] of Object.entries(stateCounts)) {
          parts.push(`  State '${state}': ${count} failures`);
        }
        // Last 3 failure reasons
        for (const f of failures.slice(0, 3)) {
          if (f.reasoning) {
            parts.push(`  Last failure reason: ${f.reasoning.substring(0, 200)}`);
          }
        }
      }
    } catch { /* non-critical */ }

    // 4. Memory mode state
    try {
      const memoryMode = require('./memory-mode');
      parts.push(`Memory mode: ${memoryMode.getMode()} (thresholds: warn=${memoryMode.getThresholds().warnHeapMB}MB, restart=${memoryMode.getThresholds().restartHeapMB}MB)`);
    } catch { /* non-critical */ }

  } catch (e: any) {
    parts.push(`Diagnostic gathering failed: ${e.message}`);
  }

  return parts.length > 0 ? parts.join('\n') : 'No diagnostic data available';
}

/**
 * Actually trigger self-heal. This is called after the delay.
 * It's kept as lightweight as possible — just calls performSelfHeal()
 * which has its own fast-pass (runtime heal) before the heavy pipeline.
 */
async function triggerBootHeal(): Promise<void> {
  if (_bootHealScheduled) {
    log('Boot heal already scheduled or running, skipping', 'DEBUG');
    return;
  }
  _bootHealScheduled = true;

  const diagnostics = gatherOOMDiagnostics();
  log(`Boot-time OOM self-heal triggered. Diagnostics:\n${diagnostics}`, 'WARN');

  // Record the trigger event in DB
  try {
    getInsertSelfHealEvent()?.(
      Date.now(),
      'oom_boot_trigger',
      'triggered',
      'oom_loop_detected_at_boot',
      JSON.stringify({ diagnostics: diagnostics.substring(0, 2000) }),
      0, 0, 0,
      'pending',  // outcome updated after heal completes
      0,
      null
    );
  } catch { /* non-critical */ }

  // Update cooldown marker
  try {
    const db = getDb();
    if (db) {
      db.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
        .run(DB_KEY_LAST_BOOT_HEAL, String(Date.now()), Date.now());
    }
  } catch { /* non-critical */ }

  // Attempt self-heal — wrapped in try/catch so we don't crash the boot
  //
  // CRITICAL FIX: Call performRuntimeHeal() DIRECTLY, not performSelfHeal().
  // performSelfHeal() is wrapped by the circuit breaker which may be OPEN
  // from previous failed heals (exponential backoff up to 8 hours).
  // performRuntimeHeal() is exported as a raw function with NO circuit
  // breaker, NO daily limits, NO /tmp overlay requirement — it just runs
  // the 7 runtime avenues (DB repair, provider reset, cache flush, etc.)
  // which is exactly what an OOM loop needs: clear stuck state.
  //
  // Only fall through to the full performSelfHeal() (code patches) if
  // runtime heal succeeds and we want to try for a deeper fix too.
  let anyHealed = false;
  try {
    const selfHealMod = require('./self-heal');

    // ── STEP 1: Runtime heal (bypasses ALL guards) ──
    const performRuntimeHeal = selfHealMod.performRuntimeHeal;
    if (typeof performRuntimeHeal === 'function') {
      log('Calling performRuntimeHeal() directly (bypasses circuit breaker)...', 'WARN');
      const rtResult = await performRuntimeHeal();
      if (rtResult?.healed) {
        const successes = rtResult.results?.filter((r: any) => r.healed);
        log(`Boot-time OOM runtime heal SUCCEEDED via: ${successes?.map((r: any) => r.avenue).join(', ')}`, 'INFO');
        anyHealed = true;
        // Reset the circuit breaker so the cycle loop can also use self-heal
        try {
          const cb = require('./self-heal-circuit-breaker');
          const breaker = cb.healerCircuitBreaker || cb;
          if (typeof breaker.reset === 'function') {
            breaker.reset();
            log('Circuit breaker RESET after successful OOM runtime heal', 'INFO');
          }
        } catch {}
      } else {
        log('Boot-time OOM runtime heal found no fixable issues', 'WARN');
      }
    } else {
      log('performRuntimeHeal not available — self-heal module not loaded yet', 'WARN');
    }

    // ── STEP 2: Full self-heal (with circuit breaker) for code-patch fix ──
    // Only attempt if runtime heal didn't help AND we're not in an OOM
    // death spiral (the full pipeline uses more memory — risky when OOMing).
    // Request a self-heal session for full power if in memory_protection.
    if (!anyHealed) {
      try {
        const memoryMode = require('./memory-mode');
        if (memoryMode.isMemoryProtection?.()) {
          memoryMode.beginSelfHealSession?.('oom_boot_trigger');
        }
      } catch {}

      const performSelfHeal = selfHealMod.performSelfHeal;
      if (typeof performSelfHeal === 'function') {
        log('Runtime heal didn\'t help — attempting full performSelfHeal()...', 'WARN');
        const fullHealed = await performSelfHeal();
        if (fullHealed) {
          log('Boot-time OOM full self-heal SUCCEEDED', 'INFO');
          anyHealed = true;
        } else {
          log('Boot-time OOM full self-heal found no fixable issues', 'WARN');
        }
      }
    }

    // Record outcome
    try {
      if (anyHealed) {
        getInsertSelfHealEvent()?.(
          Date.now(), 'oom_boot_trigger', 'completed', 'oom_loop_boot_heal_success',
          null, 0, 0, 0, 'success', 0, null
        );
      } else {
        getInsertSelfHealEvent()?.(
          Date.now(), 'oom_boot_trigger', 'completed', 'oom_loop_boot_heal_no_fix',
          null, 0, 0, 0, 'no_fix_found', 0, null
        );
      }
    } catch {}
  } catch (err: any) {
    logError('Boot-time OOM self-heal FAILED', err);
    try {
      getInsertSelfHealEvent()?.(
        Date.now(), 'oom_boot_trigger', 'failed', 'oom_loop_boot_heal_error',
        null, 0, 0, 0, 'error', 0, String(err).substring(0, 1000)
      );
    } catch {}
  } finally {
    _bootHealScheduled = false;
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Initialize the OOM trigger module. Call once at boot.
 *
 * @param options.wasUnexpected - Whether this boot was after an unexpected restart
 * @param options.emergencyMode - Whether the restart guardian activated emergency mode
 * @param options.recentRestartCount - Number of recent unexpected restarts
 */
function init(options: {
  wasUnexpected?: boolean;
  emergencyMode?: boolean;
  recentRestartCount?: number;
}): { healScheduled: boolean; oomKillCount: number } {
  if (_initialized) {
    log('Already initialized, skipping', 'DEBUG');
    return { healScheduled: false, oomKillCount: 0 };
  }
  _initialized = true;

  const wasUnexpected = options.wasUnexpected ?? false;
  const emergencyMode = options.emergencyMode ?? false;
  const recentRestartCount = options.recentRestartCount ?? 0;

  // Record process start in lifecycle table
  recordProcessStart(wasUnexpected, recentRestartCount);

  // Count OOM kills from lifecycle table
  const oomKillCount = getRecentOOMKillCount();

  if (emergencyMode || wasUnexpected) {
    log(`Boot context: unexpected=${wasUnexpected}, emergencyMode=${emergencyMode}, ` +
      `recentRestarts=${recentRestartCount}, oomKillsFromDB=${oomKillCount}`, 'WARN');
  }

  // Wire process stop recording into shutdown
  try {
    const origShutdown = (process as any).__oomTriggerShutdownHook;
    if (!origShutdown) {
      (process as any).__oomTriggerShutdownHook = true;
      const shutdownHook = () => {
        recordProcessStop('graceful_shutdown');
      };
      process.on('SIGTERM', shutdownHook);
      process.on('SIGINT', shutdownHook);
    }
  } catch { /* non-critical */ }

  // Check if we should schedule a boot-time self-heal
  if (shouldScheduleBootHeal()) {
    log(`OOM loop detected — scheduling boot-time self-heal in ${BOOT_HEAL_DELAY_MS / 1000}s`, 'ERROR');

    // Delay gives the process time to:
    // - Finish initializing all subsystems
    // - Start the heap guardian (which prevents OOM during heal)
    // - Establish DB connection for Turso sync
    const timer = setTimeout(() => {
      triggerBootHeal().catch(() => {});
    }, BOOT_HEAL_DELAY_MS);

    // Don't hold the process open for this timer
    if (timer?.unref) timer.unref();

    return { healScheduled: true, oomKillCount };
  }

  return { healScheduled: false, oomKillCount };
}

/**
 * Re-check OOM loop detection AFTER Turso sync has populated the local DB.
 *
 * On Render free tier, init() runs before Turso sync. The local SQLite
 * is empty (ephemeral disk wiped by OOM restart), so both the restart
 * guardian and this module see 0 restart/OOM records. After Turso pulls
 * data from the cloud, this function re-checks and triggers self-heal
 * if an OOM loop is now visible.
 *
 * Also records the process_lifecycle start event (which may have failed
 * during init() if the table didn't exist yet — Turso sync creates it).
 */
function recheckAfterTursoSync(): { healScheduled: boolean; oomKillCount: number } {
  // Re-record process start — the table might not have existed during init()
  // Now that Turso has synced, the table exists and the start is persisted.
  try {
    const db = getDb();
    if (db) {
      // Check if we already recorded a start for this PID
      const existing = db.prepare(
        'SELECT id FROM process_lifecycle WHERE pid = ? AND event = ? ORDER BY timestamp DESC LIMIT 1'
      ).get(process.pid, 'start');
      if (!existing) {
        recordProcessStart(false, 0);
        log('Recorded process start in process_lifecycle (table now available post-Turso)', 'DEBUG');
      }
    }
  } catch { /* non-critical */ }

  // Now re-check OOM conditions with the restored DB data
  const oomKillCount = getRecentOOMKillCount();

  // Also re-check via the restart guardian (which also re-reads DB)
  let guardianSeesLoop = false;
  try {
    const guardian = require('./survival-restart-guardian');
    const status = guardian.getStatus?.();
    if (status && (status.recentUnexpectedRestarts >= 2 || status.emergencyModeActive)) {
      guardianSeesLoop = true;
    }
  } catch { /* guardian not available */ }

  if (guardianSeesLoop || oomKillCount >= 2) {
    log(`Post-Turso recheck: OOM loop CONFIRMED (guardian=${guardianSeesLoop}, lifecycle_ooms=${oomKillCount})`, 'ERROR');

    if (shouldScheduleBootHeal()) {
      log(`Post-Turso OOM self-heal TRIGGERED`, 'ERROR');
      const timer = setTimeout(() => {
        triggerBootHeal().catch(() => {});
      }, 5000); // Shorter delay — subsystems already running
      if (timer?.unref) timer.unref();
      return { healScheduled: true, oomKillCount };
    } else {
      log(`Post-Turso: OOM loop confirmed but boot heal in cooldown`, 'WARN');
    }
  }

  return { healScheduled: false, oomKillCount };
}

module.exports = {
  init,
  recordProcessStop,
  getRecentOOMKillCount,
  gatherOOMDiagnostics,
  recheckAfterTursoSync,
  _injectDependencies,
};
