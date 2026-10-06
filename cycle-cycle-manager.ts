'use strict';

const fs = require('fs');
const crypto = require('crypto');

// ─── Dependency Injection ───
// All dependencies are injected via _injectDependencies() from the DI container.
// No top-level require() for project modules — only Node.js builtins.
let _deps = {};

/**
 * Inject dependencies from the DI container.
 * Called once during container initialization.
 *
 * BUG FIX (2026-09-04): Also stores the container reference so getDep() can
 * lazy-load modules that aren't in the eager deps array. This allows the
 * cycleManager to declare only 7 core deps (down from 37) while still
 * being able to access all 30+ other modules via getDep('moduleName').
 *
 * @param {Object} deps - Object mapping dependency names to modules
 * @param {Object} container - The DI container itself (for lazy loading)
 */
function _injectDependencies(deps: any) {
  _deps = deps;
  // The container passes itself as deps.__container (see container-modules.ts factory)
  _container = deps.__container || null;
}

// BUG FIX (2026-09-04): Reference to the DI container for lazy module loading.
// When getDep('moduleName') is called for a module NOT in the eager deps array,
// we fall back to container.get('moduleName') which lazy-loads it on first access.
let _container: any = null;

// ─── Lazy accessors with fallback to container.get() ───
// This allows cycle-manager to work even if some non-critical deps are null.

function getDep(name: any) {
  // First check if the dep was eagerly injected
  const eager = (_deps as any)[name];
  if (eager) return eager;
  // BUG FIX (2026-09-04): Lazy-load from the DI container if not in eager deps.
  // This allows cycleManager to declare only 7 core deps while still accessing
  // all 30+ other modules (authGuard, actionExecutor, blackbox, flutter-*, etc.)
  // on first use. The container.get() call triggers the module's factory, which
  // requires + initializes the module — this happens ONCE, then is cached by
  // the container as a singleton.
  if (_container) {
    try {
      const lazy = _container.get(name, { required: false });
      if (lazy) {
        // Cache it in _deps so subsequent getDep() calls don't hit the container
        (_deps as any)[name] = lazy;
        return lazy;
      }
    } catch { /* module failed to load — return null, caller handles it */ }
  }
  return null;
}

// Fallback is safe: cycle-manager runs mid-cycle, long after container init.
function getCONFIG(): Record<string, any> { return (_deps as any).config || require('./get-config'); }

// ── BUG FIX (2026-09-04): Recovery-URL resolver ──
// When the bot needs to recover (blank page, browser restart, etc.), prefer
// the URL it was last successfully at — falling back to CONFIG.APP_URL only
// if no last-known-good URL has been recorded yet (first cycle / cold start).
// This replaces the old behavior of always navigating to a preset root URL,
// which lost deep-link context and was brittle to deployment domain changes.
function _getRecoveryUrl(): string {
  try {
    const authGuard = getDep('authGuard');
    const lastGoodUrl = typeof authGuard?.getLastKnownGoodUrl === 'function'
      ? authGuard.getLastKnownGoodUrl()
      : null;
    if (lastGoodUrl && typeof lastGoodUrl === 'string' && lastGoodUrl.length > 0) {
      // BUG FIX (2026-09-08): Defensive guard — never return a chrome-error,
      // about:blank, or chrome:// URL as the recovery target.
      // `notifyLastKnownGoodUrl` already filters these out, but defense-in-depth
      // in case a stale value was stored before the filter was added, or the
      // filter was bypassed somehow.
      if (lastGoodUrl.includes('chrome-error://') ||
          lastGoodUrl.includes('chromewebdata') ||
          lastGoodUrl.startsWith('about:blank') ||
          lastGoodUrl.startsWith('chrome://') ||
          lastGoodUrl.startsWith('devtools://') ||
          lastGoodUrl.startsWith('data:')) {
        // Fall through to default APP_URL below
      } else {
        return lastGoodUrl;
      }
    }
  } catch { /* non-critical */ }
  const CONFIG = getCONFIG();
  // Normalize: strip trailing slashes from APP_URL so we don't get double-slash
  // when callers append paths like '/assignments'
  const _appUrl = String(CONFIG.APP_URL || CONFIG.BASE_URL || 'https://app.mathu.co.za').replace(/\/+$/, '');
  return _appUrl;
}

// ─── Module state ───
let stopRequested = false;
let cycleStartTime: number | null = null;
let browserRestartInterval = 4 * 60 * 60 * 1000;

// TASK 57 (2026-09-11): Answer-type actions that must NEVER be cached on
// question states. Each question is different — a cached answer from a
// previous question would be wrong.
const ANSWER_ACTIONS = new Set([
  'keypad_input',
  'input_email',
  'input_password',
  'type_text',
]);

// TASK 58 (2026-09-11): States where the AI must READ the page to generate
// the correct answer. Cache is banned on these states UNTIL the AI submits
// an answer (clicks a choice). After that, navigation actions (Next, book icon)
// CAN be cached.
const CACHE_BANNED_STATES = new Set([
  'exercise_info',  // Math question — AI must read and solve it
  'assessment',     // Assessment questions — AI must read and answer
  'answering',      // Actively answering — AI must see the question
  'question',       // Generic question state — AI must read it
  'question_page',  // Question page — AI must read it
  'blank_page',     // Don't cache blank pages
  'exploration',    // Don't cache exploration — each unknown page is different
  'exploring',      // TASK 73 (2026-09-23): AI returns "exploring" (verb, -ing form)
                    // but the cache only banned "exploration" (noun). The bot was
                    // stuck clicking (990, 375) forever on every exploring page
                    // because the state-only fallback kept hitting the same
                    // cached click. Both forms are now banned.
  'unknown',        // Don't cache unknown state — AI must re-evaluate
  'error',          // Don't cache error states — recovery is context-specific
  'app_error',      // Don't cache app_error — recovery is context-specific
  'human_intervention', // Don't cache human intervention state
  // TASK 66 (2026-09-21): loading state must NOT be cached.
  // The bot was stuck in a loop: AI returned "loading" state + "wait" action →
  // cached → next cycle: cache hit with "wait" → page still loading →
  // cache hit again with "wait" → forever. The page IS loading and the AI
  // needs to check every cycle if it finished loading. Once it loads, the
  // AI will see the actual content (assignments page, question, etc.) and
  // the state will change — at that point caching can resume.
  'loading',
]);
let consecutiveFailures = 0;
let selfHealRunning = false;
let _networkSetup = false;
let explorationMode = false;
let explorationMap: any = null;

// v4: Track recent error codes to distinguish structural vs transient failures.
// Self-heal should ONLY fire when the bot is structurally broken, not when
// it's hitting transient provider issues. A rotating buffer of recent error
// codes lets us assess: are we seeing the SAME transient error repeatedly
// (don't self-heal) or DIFFERENT structural errors (do self-heal)?
const _recentErrorCodes: Array<{ code: string; ts: number }> = [];
const RECENT_ERROR_WINDOW_MS = 15 * 60 * 1000; // 15-minute window
const RECENT_ERROR_MAX = 20;
let explorationFailures = 0;

/* ── OR Budget Park ──────────────────────────────────────────────────────────
 * When OpenRouter's daily limit is exhausted and no other providers exist,
 * the bot "parks" — skips screenshots and tribunal, just sleeps until
 * midnight UTC. The screen stays untouched, so it resumes on the same
 * question. Zero memory waste during the park.
 */
let _orParked = false;
let _orParkedDate = '';   // YYYY-MM-DD UTC of the day we parked
const OR_PARK_CHECK_INTERVAL_MS = 60000; // Check for midnight every 60s

/* ── 20-Minute Zero-Progress Self-Heal Trigger ───────────────────────────
 * If the bot completes ZERO questions in 20 minutes, full self-heal fires
 * DIRECTLY — no _isDesperatelyBroken gate, no consecutive failure threshold,
 * no circuit breaker. Uses MULTIPLE independent time sources:
 *   Avenue 1: Wall clock — Date.now() minus cycleStart
 *   Avenue 2: DB progress log — 0 entries in last 20 minutes
 *   Avenue 3: Cycle count × estimated iteration time (cycles * ~40s avg)
 *   Avenue 4: Heartbeat file mtime — process alive but no progress
 * 2 of 4 avenues must agree. This is a HARD trigger — it MUST fire.
 */
let _zeroProgressHealTriggered = false;
// BUG FIX (2026-09-04): Changed from 10 minutes to 20 minutes per user request.
// 10 minutes was too aggressive — the bot often needs >10min to complete a
// module (video watching alone takes 3min, plus quiz answering, plus navigation).
// At 10min, self-heal was firing during normal operation, not just actual stalls.
const ZERO_PROGRESS_STUCK_MS = 60 * 60 * 1000;       // 60 minutes (was 20)
const ZERO_PROGRESS_MIN_CYCLES = 90;                  // 90 cycles × 40s = 60min (was 30)

/* ── OOM-Surviving Cycle State Snapshot ──────────────────────────────────
 * Writes critical in-memory state to the calibration DB (Turso-synced)
 * every cycle. On OOM kill, the SIGKILL wipes /tmp and all JS heaps, but
 * the DB survives. The next process reads the snapshot on first cycle
 * and resumes with correct failure counts, error patterns, and park state.
 *
 * What gets persisted (compact JSON, ~1-3 KB):
 *   - consecutiveFailures: so self-heal thresholds work across OOM
 *   - _recentErrorCodes: last 10 codes for transient-vs-structural check
 *   - _orParked / _orParkedDate: so parked state survives
 *   - _zeroProgressHealTriggered: so we don't re-trigger immediately
 *   - explorationMode: boolean flag
 *
 * NOT persisted (intentionally):
 *   - explorationMap: can be huge; re-discovered quickly via state machine
 *   - selfHealRunning: always false at cycle boundary (serialized state)
 *   - _networkSetup: always false at cycle start anyway
 */
const CYCLE_STATE_DB_KEY = 'cycle_state_snapshot';
const CYCLE_STATE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours — stale snapshots are ignored
let _cycleStateRestored = false;

function _snapshotCycleState() {
  try {
    const db = getDep('database');
    if (!db?.upsertCalibration) return;

    const snapshot = {
      v: 1,
      ts: Date.now(),
      pid: process.pid,
      cf: consecutiveFailures,
      errors: _recentErrorCodes.slice(-10),   // last 10 entries
      orParked: _orParked,
      orDate: _orParkedDate,
      zpTriggered: _zeroProgressHealTriggered,
      explMode: explorationMode,
      memMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
    };

    db.upsertCalibration.run(CYCLE_STATE_DB_KEY, JSON.stringify(snapshot), Date.now());
  } catch {
    // DB write failure is non-fatal — /tmp checkpoint is the primary path,
    // this is the OOM-survival backup path.
  }
}

function _restoreCycleState(log: any) {
  if (_cycleStateRestored) return; // Only restore once per process lifetime
  _cycleStateRestored = true;

  try {
    const db = getDep('database');
    if (!db?.selectCalibration) return;

    const row = db.selectCalibration.get(CYCLE_STATE_DB_KEY);
    if (!row?.value) return;

    const snap = JSON.parse(row.value);
    if (!snap?.ts || snap.v !== 1) return;

    const age = Date.now() - snap.ts;
    if (age > CYCLE_STATE_MAX_AGE_MS) {
      log(`Cycle state snapshot is stale (${Math.round(age / 60000)}min old), ignoring`, 'DEBUG', 'cycle');
      return;
    }

    // Restore consecutive failures — the most critical piece.
    // Without this, OOM resets the counter and self-heal thresholds are blind.
    if (typeof snap.cf === 'number' && snap.cf > 0) {
      const oldVal = consecutiveFailures;
      consecutiveFailures = snap.cf;
      log(`OOM-restore: consecutiveFailures ${oldVal} → ${snap.cf} (from snapshot ${Math.round(age / 1000)}s ago)`, 'INFO', 'cycle');
    }

    // Restore error code buffer — enables transient-vs-structural discrimination
    if (Array.isArray(snap.errors) && snap.errors.length > 0) {
      const now = Date.now();
      let restored = 0;
      for (const e of snap.errors) {
        if (e?.code && e?.ts && (now - e.ts) < RECENT_ERROR_WINDOW_MS) {
          _recentErrorCodes.push(e);
          restored++;
        }
      }
      if (restored > 0) {
        // Re-trim to window/cap
        while (_recentErrorCodes.length > 0 && now - _recentErrorCodes[0].ts > RECENT_ERROR_WINDOW_MS) _recentErrorCodes.shift();
        while (_recentErrorCodes.length > RECENT_ERROR_MAX) _recentErrorCodes.shift();
        log(`OOM-restore: ${restored} error codes restored to buffer (${_recentErrorCodes.length} total)`, 'INFO', 'cycle');
      }
    }

    // Restore OR park state — avoids re-checking budget on every post-OOM cycle
    if (snap.orParked && snap.orDate) {
      const todayUTC = new Date().toISOString().slice(0, 10);
      if (snap.orDate === todayUTC) {
        _orParked = true;
        _orParkedDate = snap.orDate;
        log(`OOM-restore: OR park state restored (parked for ${snap.orDate})`, 'INFO', 'cycle');
      }
      // If date is yesterday, park expired naturally — don't restore
    }

    // Restore zero-progress trigger — prevents immediate re-trigger after OOM
    if (snap.zpTriggered) {
      _zeroProgressHealTriggered = true;
      log('OOM-restore: zero-progress heal trigger restored (will not re-trigger)', 'INFO', 'cycle');
    }

    // Restore exploration mode
    if (snap.explMode) {
      explorationMode = true;
      log('OOM-restore: exploration mode restored', 'INFO', 'cycle');
    }

    log(`Cycle state restored from DB snapshot (age: ${Math.round(age / 1000)}s, heap was ${snap.memMB}MB, PID ${snap.pid})`, 'INFO', 'cycle');
  } catch {
    // Restore failure is non-fatal — the bot starts clean, which is safe
  }
}

/* ── OOM-Surviving Action Replay Buffer ──────────────────────────────────
 * Every 2 successful actions, flush them to the DB. On OOM kill + restart,
 * the bot replays them instead of burning API calls on the tribunal.
 * Each action is ~200 bytes; 2 actions = ~400 bytes per flush.
 */
const ACTION_REPLAY_DB_KEY = 'action_replay_buffer';
const ACTION_REPLAY_MAX_AGE_MS = 10 * 60 * 1000; // 10 minutes
const ACTION_REPLAY_FLUSH_INTERVAL = 2; // flush every N successful actions
let _actionReplayBuf: any[] = [];
let _actionsSinceLastFlush = 0;

function _pushActionReplay(action: any) {
  // Only buffer progress-making actions
  if (!action || action.actionType === 'wait') return;
  _actionReplayBuf.push({
    a: action.actionType,
    x: action.targetX,
    y: action.targetY,
    s: action.submitX,
    t: action.submitY,
    v: action.value || '',
    k: action.keypadSequence || [],
    cs: action.currentState || '',
    ts: Date.now(),
  });
  _actionsSinceLastFlush++;
  if (_actionsSinceLastFlush >= ACTION_REPLAY_FLUSH_INTERVAL) {
    _flushActionReplay();
    _actionsSinceLastFlush = 0;
  }
}

function _flushActionReplay() {
  if (_actionReplayBuf.length === 0) return;
  try {
    const db = getDep('database');
    if (!db?.upsertCalibration) return;
    // Keep only last 2 actions in DB (overwrite)
    const toSave = _actionReplayBuf.slice(-ACTION_REPLAY_FLUSH_INTERVAL);
    db.upsertCalibration.run(ACTION_REPLAY_DB_KEY, JSON.stringify(toSave), Date.now());
  } catch { /* non-fatal */ }
  _actionReplayBuf = []; // clear in-memory after flush
}

function _clearActionReplay() {
  _actionReplayBuf = [];
  _actionsSinceLastFlush = 0;
  try {
    const db = getDep('database');
    if (db?.upsertCalibration) {
      db.upsertCalibration.run(ACTION_REPLAY_DB_KEY, '', Date.now());
    }
  } catch { /* non-fatal */ }
}

async function _replayActionsFromDB(page: any, executeActionFn: any, log: any): Promise<number> {
  try {
    const db = getDep('database');
    if (!db?.selectCalibration) return 0;
    const row = db.selectCalibration.get(ACTION_REPLAY_DB_KEY);
    if (!row?.value || typeof row.value !== 'string' || row.value.length < 10) return 0;

    const actions: any[] = JSON.parse(row.value);
    if (!Array.isArray(actions) || actions.length === 0) return 0;

    // Check freshness
    const newest = Math.max(...actions.map((a: any) => a.ts || 0));
    if (Date.now() - newest > ACTION_REPLAY_MAX_AGE_MS) {
      log('Action replay buffer stale, clearing', 'DEBUG', 'cycle');
      _clearActionReplay();
      return 0;
    }

    let replayed = 0;
    for (const saved of actions) {
      if (!saved?.a) continue;
      const rebuilt = {
        actionType: saved.a,
        targetX: saved.x ?? 0.5,
        targetY: saved.y ?? 0.5,
        submitX: saved.s ?? 0.5,
        submitY: saved.t ?? 0.5,
        value: saved.v || '',
        keypadSequence: saved.k || [],
        currentState: saved.cs || '',
        reasoning: `OOM replay (saved ${Math.round((Date.now() - (saved.ts || 0)) / 1000)}s ago)`,
      };
      try {
        log(`Replaying action: ${rebuilt.actionType} at (${rebuilt.targetX?.toFixed(2)}, ${rebuilt.targetY?.toFixed(2)}) state=${rebuilt.currentState}`, 'INFO', 'cycle');
        if (executeActionFn) await executeActionFn(page, rebuilt);
        replayed++;
        // Brief pause between replayed actions to let the page react
        if (replayed < actions.length) await new Promise(r => setTimeout(r, 2000));
      } catch (err: any) {
        log(`Replay failed for ${rebuilt.actionType}: ${err.message || err} — falling back to tribunal`, 'WARN', 'cycle');
        break; // Stop replaying on first failure
      }
    }

    // Clear buffer after replay attempt (success or failure)
    _clearActionReplay();
    if (replayed > 0) log(`Replayed ${replayed}/${actions.length} actions from DB`, 'INFO', 'cycle');
    return replayed;
  } catch {
    return 0;
  }
}

const ZERO_PROGRESS_VOTES_NEEDED = 2;

/**
 * Check if OpenRouter budget is exhausted AND no other providers available.
 * If so, enter park mode (returns true). If midnight has rolled over,
 * unparks and returns false.
 */
async function _checkOrPark(log: any): Promise<boolean> {
  // Already parked — check if midnight rolled over
  if (_orParked) {
    const todayUTC = new Date().toISOString().slice(0, 10);
    if (todayUTC !== _orParkedDate) {
      _orParked = false;
      _orParkedDate = '';
      log('OR park: midnight rollover detected, resuming normal operation', 'INFO', 'cycle');
      return false;
    }
    // Still parked — caller should sleep and continue
    return true;
  }

  // Not parked — check if we SHOULD park
  try {
    const orLimiter = require('./openrouter-rate-limiter');
    const budgetPct = orLimiter.getBudgetPct?.();
    if (budgetPct === undefined || budgetPct > 0) return false; // Budget available

    // Budget is 0 — check if other providers are FUNCTIONAL (not just configured)
    const registry = require('./providers-registry');
    const providers = await registry.getAvailableProviders?.();
    const nonOrProviders = Array.isArray(providers) ? providers.filter((p: any) => p.name !== 'OpenRouter') : [];

    if (nonOrProviders.length > 0) {
      // Other providers exist — but are they actually functional?
      // Check if all of them have very low health (recent 429s)
      let anyHealthy = false;
      try {
        const health = require('./providers-health');
        for (const p of nonOrProviders) {
          const snapshot = health.getHealthSnapshot?.(p.name);
          // If provider has been called recently and has decent health, it's functional
          if (snapshot && snapshot.totalCalls >= 1 && snapshot.healthScore >= 0.3) {
            anyHealthy = true;
            break;
          }
          // If no calls recorded yet, assume potentially healthy (new provider)
          if (snapshot && snapshot.totalCalls === 0) {
            anyHealthy = true;
            break;
          }
        }
      } catch {}

      // Check Cloudflare model cooldowns — if ALL models on cooldown, CF is dead too
      let cfAllOnCooldown = false;
      if (!anyHealthy) {
        try {
          const cfProvider = require('./providers-cloudflare');
          const modelChain = cfProvider._getModelChain?.();
          if (Array.isArray(modelChain) && modelChain.length > 0) {
            // We can't directly check cooldowns, but if no provider is healthy, CF is likely dead
            cfAllOnCooldown = true;
          }
        } catch {}
      }

      if (anyHealthy) {
        log('OR budget exhausted but other healthy providers available — not parking', 'INFO', 'cycle');
        return false;
      }

      // All non-OR providers are also down — enter park
      log('OR budget exhausted AND all other providers are down (all 429). Parking until midnight UTC.', 'WARN', 'cycle');
    } else {
      log('OR daily limit exhausted, no other providers configured. Parking until midnight UTC.', 'WARN', 'cycle');
    }

    // Enter park (either no other providers, or all are 429'd)
    _orParked = true;
    _orParkedDate = new Date().toISOString().slice(0, 10);

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    const parkMinutes = Math.min(Math.round(msUntilMidnight / 60000), 30);

    log('OR daily limit exhausted, no other providers. Parking ~' + parkMinutes + 'min until midnight UTC. Screen untouched.', 'WARN', 'cycle');
    try {
      const sendAlert = require('./alerting').sendAlert;
      // TASK 61: Removed alert — routine daily event.
    } catch { /* non-critical */ }
    return true;
  } catch {
    return false; // Can't determine state — don't park
  }
}

// v4: Error codes that are ALWAYS transient — self-heal cannot fix these.
// If ALL recent errors fall in this set, do NOT activate self-heal.
const TRANSIENT_ERROR_CODES = new Set([
  'E_NETWORK_TIMEOUT', 'E_RATE_LIMITED', 'E_PROVIDER_TEMPORARY',
  'E_BROWSER_DISCONNECTED', 'E_CAPTCHA_ENCOUNTERED',
  'E_CONNECTION_FAILED', // ECONNREFUSED/ENOTFOUND
]);

// v6: Error codes that indicate the bot is structurally stuck and self-heal
// should investigate. These bypass the normal "consecutiveFailures >= threshold"
// gate because the bot may not be "failing" in the traditional sense —
// it's running but making no progress (worse than failing).
const PROGRESS_STALL_CODES = new Set([
  'E_PROGRESS_STALL',   // 0 questions in PROGRESS_TIMEOUT_MS
  'E_SLOW_PROGRESS',    // questions completed but then stalled for 2x timeout
  'E_ZERO_PROGRESS',    // 0 questions in 20min (4-avenue hard trigger)
]);

// v6: Healable codes — self-heal should fire for these even at lower thresholds.
// Expanded to include progress stalls and restart loops.
const HEALABLE_ERROR_CODES = new Set([
  'E_SELECTOR_DRIFT', 'E_UI_CHANGED', 'E_PROVIDER_PERMANENT',
  'E_STATE_DEADLOCK', 'E_PATCH_FAILED',
  'E_PROGRESS_STALL', 'E_SLOW_PROGRESS', 'E_RESTART_LOOP',
  'E_ZERO_PROGRESS',
]);

/**
 * Record an error code in the rotating buffer. Called after every cycle error.
 */
function _recordErrorForDesperation(code: string) {
  const now = Date.now();
  _recentErrorCodes.push({ code, ts: now });
  // Trim old entries
  while (_recentErrorCodes.length > 0 && now - _recentErrorCodes[0].ts > RECENT_ERROR_WINDOW_MS) {
    _recentErrorCodes.shift();
  }
  // Cap size
  while (_recentErrorCodes.length > RECENT_ERROR_MAX) {
    _recentErrorCodes.shift();
  }
}

/**
 * v10: Error-rate spike detection.
 * Triggers runtime heal when errors are coming in FAST even if individually
 * they're transient. A burst of 6+ errors in 2 minutes usually means something
 * systemic is wrong (broken network interceptor, stuck rate limiter, etc.)
 * that runtime heal can fix without code patches.
 */
function _isErrorRateSpiking(): boolean {
  if (_recentErrorCodes.length < 6) return false;
  const now = Date.now();
  const SPIKE_WINDOW_MS = 2 * 60 * 1000; // 2 min
  const recentSpikes = _recentErrorCodes.filter(e => now - e.ts < SPIKE_WINDOW_MS);
  return recentSpikes.length >= 6;
}

/**
 * v6: Return a human-readable reason for WHY self-heal is triggering.
 * Used in log messages so operators can quickly understand the cause.
 */
function _getSelfHealReason(CONFIG: any): string {
  // Check progress stall first (most likely new trigger)
  if (_recentErrorCodes.length > 0) {
    const stallCode = _recentErrorCodes.find(e => PROGRESS_STALL_CODES.has(e.code));
    if (stallCode) {
      if (stallCode.code === 'E_PROGRESS_STALL') return 'no progress in 60min';
      if (stallCode.code === 'E_SLOW_PROGRESS') return 'slow progress (stalled after initial questions)';
    }
  }

  // Check restart loop
  try {
    const guardian = require('./survival-restart-guardian');
    if (guardian.isEmergencyMode?.()) return 'OOM loop detected by restart guardian';
    const status = guardian.getStatus?.();
    if (status) {
      const recent = status.recentUnexpectedRestarts || 0;
      if (recent >= 2) return `${recent} unexpected restarts in 30min`;
      if ((status.totalRestartsRecorded || 0) >= 5) return `${status.totalRestartsRecorded} total unexpected restarts`;
    }
  } catch {}

  // Check error pattern
  if (_recentErrorCodes.length >= 3) {
    const healableCodes = new Set(
      _recentErrorCodes.filter(e => HEALABLE_ERROR_CODES.has(e.code)).map(e => e.code)
    );
    if (healableCodes.size > 0) return `healable errors: ${[...healableCodes].join(', ')}`;
    const nonTransient = new Set(
      _recentErrorCodes.filter(e => !TRANSIENT_ERROR_CODES.has(e.code)).map(e => e.code)
    );
    if (nonTransient.size >= 3) return `${nonTransient.size} different non-transient error codes`;
  }

  return `${consecutiveFailures} consecutive failures >= threshold ${CONFIG.SELF_HEAL_FAILURE_THRESHOLD}`;
}

/**
 * v6: Assess whether the bot is DESPERATELY in need of self-heal.
 *
 * Returns true when ANY of these conditions are met:
 *
 *   1. PROGRESS STALL: A progress stall error (E_PROGRESS_STALL or
 *      E_SLOW_PROGRESS) was thrown. These are ALWAYS desperate — the bot
 *      is running but not making progress, which is worse than failing.
 *      Self-heal should investigate why (bad selectors, UI change, logic bug).
 *
 *   2. RESTART LOOP: The survival-restart-guardian has recorded multiple
 *      unexpected restarts (OOM kills, crashes) in a short window. This
 *      means the bot is in a crash loop that self-heal should try to fix
 *      (e.g., memory leak, infinite loop, broken dependency).
 *
 *   3. OOM EMERGENCY: The survival guardian has activated emergency mode.
 *
 *   4. HEALABLE ERRORS: The error is classified as healable (selector drift,
 *      UI change, etc.) AND consecutive failures >= threshold.
 *
 *   5. CASCADING FAILURES: 3+ DIFFERENT non-transient error codes in the
 *      recent window (suggests cascading structural failure).
 *
 *   6. DIVERSE FAILURE MIX: 2+ different non-transient codes AND very
 *      high failure count (2x threshold).
 *
 * Returns false when:
 *   - All recent errors are transient (rate limits, timeouts, captchas)
 *   - Same transient error repeating (provider outage, not code breakage)
 *   - Fewer than threshold consecutive failures (and no stall/restart trigger)
 *   - A self-heal session is already active
 */
function _isDesperatelyBroken(CONFIG: any): boolean {
  // ── Trigger 1: Progress stall — ALWAYS desperate regardless of failure count ──
  // The bot is running but achieving nothing. This is the most insidious
  // failure mode because it doesn't throw errors — it just wastes time.
  if (_recentErrorCodes.length > 0) {
    const hasStall = _recentErrorCodes.some(e => PROGRESS_STALL_CODES.has(e.code));
    if (hasStall) {
      // Only require 1 consecutive failure (the stall itself) to trigger self-heal
      return consecutiveFailures >= 1;
    }
  }

  // ── Trigger 2: Restart loop — crash count is high ──
  // Even if the current cycle hasn't failed, if the bot has been restarting
   // frequently, something structural is wrong that self-heal should investigate.
  try {
    const guardian = require('./survival-restart-guardian');
    if (guardian.isEmergencyMode?.()) return true;
    // Also check for moderate restart count — don't wait for full emergency mode
    const status = guardian.getStatus?.();
    if (status) {
      const recentRestarts = status.recentUnexpectedRestarts || 0;
      const totalRestarts = status.totalRestartsRecorded || 0;
      // 2+ unexpected restarts in 30min = likely a fixable crash loop
      if (recentRestarts >= 2) {
        return true;
      }
      // 5+ total unexpected restarts since boot = accumulated instability
      if (totalRestarts >= 5 && consecutiveFailures >= 2) {
        return true;
      }
    }
  } catch {}

  // ── Original triggers (v4): require consecutive failure threshold ──
  if (consecutiveFailures < CONFIG.SELF_HEAL_FAILURE_THRESHOLD) return false;

  // If we have very few recent errors recorded, fall back to count-only check
  if (_recentErrorCodes.length < 3) {
    return consecutiveFailures >= Math.max(CONFIG.SELF_HEAL_FAILURE_THRESHOLD, 10);
  }

  // Count distinct error codes and separate transient vs non-transient
  const transientCount = _recentErrorCodes.filter(e => TRANSIENT_ERROR_CODES.has(e.code)).length;
  const nonTransientCodes = new Set(
    _recentErrorCodes.filter(e => !TRANSIENT_ERROR_CODES.has(e.code)).map(e => e.code)
  );
  const healableCodes = new Set(
    _recentErrorCodes.filter(e => HEALABLE_ERROR_CODES.has(e.code)).map(e => e.code)
  );

  // Case 4: Explicitly healable errors with enough consecutive failures
  if (healableCodes.size > 0 && consecutiveFailures >= CONFIG.SELF_HEAL_FAILURE_THRESHOLD) {
    return true;
  }

  // Case 5: ALL errors are transient — NOT desperate, just unlucky
  if (transientCount === _recentErrorCodes.length) {
    if (nonTransientCodes.size === 0) return false;
  }

  // Case 6: 3+ DIFFERENT non-transient error codes = cascading structural failure
  if (nonTransientCodes.size >= 3) {
    return true;
  }

  // Case 7: Mix of transient and non-transient, but non-transient are diverse
  if (nonTransientCodes.size >= 2 && consecutiveFailures >= CONFIG.SELF_HEAL_FAILURE_THRESHOLD * 2) {
    return true;
  }

  // Default: not desperate enough
  return false;
}

function requestStop() {  stopRequested = true; }

// v5 FIX: checkMemoryAndRecover now calls memoryMode.shedMemory (async) which
// actually closes the browser and frees ~100-200MB. Previously it only did
// clearCache + GC, which freed maybe 5-10MB — nowhere near enough on 512MB.
// v6 FIX: Now accepts preserveBrowser to use graduated shedding mid-quiz.
//   When preserveBrowser=true, uses L0-L2 (caches, page blank+restore, reload)
//   instead of L3 (close browser) which would destroy quiz state.
//   Returns true if memory was high AND recovery was attempted.
async function checkMemoryAndRecover(CONFIG: any, log: any, clearCache: any, preserveBrowser: boolean = false): Promise<boolean> {
  // v8: Use memory-mode thresholds instead of CONFIG env vars.
  // CONFIG.MEMORY_RESTART_THRESHOLD_MB comes from Dockerfile env (was 360MB)
  // and is far too high. memory-mode thresholds are mode-aware and
  // coordinated with the heap guardian and render-free-plan monitor.
  let restartMB = CONFIG.MEMORY_RESTART_THRESHOLD_MB;
  try {
    const memoryMode = require('./memory-mode');
    restartMB = memoryMode.getThresholds().restartHeapMB;
  } catch {}
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  if (used > restartMB) {
    log(`Memory high (${used.toFixed(0)}MB > ${restartMB}MB) -- shedding (preserveBrowser=${preserveBrowser})`, 'WARN', 'cycle');
    try {
      const memoryMode = require('./memory-mode');
      await memoryMode.shedMemory('cycle-check-memory', {
        preserveBrowser,
        targetMB: restartMB - 30,
      });
    } catch { /* memory-mode not available */ }
    if (clearCache) clearCache();
    if (global.gc) global.gc();
    return true;
  }
  return false;
}

// v5-fix H1: Lazy-loaded non-container modules — cached after first load
let _a11ySnapshot: any = null;
function _getA11ySnapshot() { if (!_a11ySnapshot) { try { _a11ySnapshot = require('./utils-a11y-snapshot'); } catch { _a11ySnapshot = { getA11ySnapshot: async () => null }; } } return _a11ySnapshot; }
let _codegenTribunal: any = null;
function _getCodegenTribunal() { if (!_codegenTribunal) { try { _codegenTribunal = require('./providers-codegen-tribunal'); } catch { _codegenTribunal = null; } } return _codegenTribunal; }
let _providerDiscovery: any = null;
function _getProviderDiscovery() { if (!_providerDiscovery) { try { _providerDiscovery = require('./providers-provider-discovery'); } catch { _providerDiscovery = null; } } return _providerDiscovery; }
let _processRetrainer: any = null;
function _getProcessRetrainer() { if (!_processRetrainer) { try { _processRetrainer = require('./cycle-process-retrainer'); } catch { _processRetrainer = null; } } return _processRetrainer; }
let _mathVerify: any = null;
function _getMathVerify() { if (!_mathVerify) { try { _mathVerify = require('./math-verify'); } catch { _mathVerify = null; } } return _mathVerify; }
let _healthWatchdog: any = null;
function _getHealthWatchdog() { if (!_healthWatchdog) { try { _healthWatchdog = require('./longevity-self-ping'); } catch { _healthWatchdog = null; } } return _healthWatchdog; }
let _problemClassifier: any = null;
function _getProblemClassifier() { if (!_problemClassifier) { try { _problemClassifier = require('./math-problem-classifier'); } catch { _problemClassifier = null; } } return _problemClassifier; }
let _pix2tex: any = null;
function _getPix2tex() { if (!_pix2tex) { try { _pix2tex = require('./services-pix2tex'); } catch { _pix2tex = null; } } return _pix2tex; }
let _degradationLadder: any = null;
function _getDegradationLadder() { if (!_degradationLadder) { try { _degradationLadder = require('./self-heal-degradation-ladder'); } catch { _degradationLadder = null; } } return _degradationLadder; }
let _actionCache: any = null;
let _actionCacheLoadAttempted = false;
let _explorationEvicted = false; // TASK 77: track if we've evicted 'explor' entries
function _getActionCache() {
  if (!_actionCache) {
    if (_actionCacheLoadAttempted) {
      // Already tried once and failed — retry once more (DB may have been late)
      _actionCacheLoadAttempted = false; // allow one more attempt
      try { _actionCache = require('./services-action-cache'); } catch { _actionCache = null; }
    } else {
      try { _actionCache = require('./services-action-cache'); } catch { _actionCache = null; }
      _actionCacheLoadAttempted = true;
    }
    // TASK 77 (2026-09-24): On first successful load, evict all 'explor' entries.
    // The user explicitly requested this cleanup — existing 'exploring'/'exploration'
    // entries in the cache cause the bot to click the wrong spot on unknown pages.
    if (_actionCache && !_explorationEvicted) {
      _explorationEvicted = true;
      try {
        const evicted = _actionCache.evictExplorationEntries?.();
        if (evicted && evicted > 0) {
          // Logged inside the function — just reset _localCacheEmpty if we evicted entries
          _localCacheEmpty = null; // force re-check
        }
      } catch {}
    }
  }
  return _actionCache;
}
let _localCacheEmpty: boolean | null = null;  // null = not yet checked; true = empty (cold start)
function _isLocalCacheEmpty(): boolean {
  if (_localCacheEmpty !== null) return _localCacheEmpty;
  try {
    const dbMod = require('./database');
    const db = dbMod.getDb?.() || dbMod.db;
    if (db) {
      const cnt = db.prepare(`SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0`).get()?.cnt || 0;
      _localCacheEmpty = cnt === 0;
    } else { _localCacheEmpty = true; }
  } catch { _localCacheEmpty = true; }
  return _localCacheEmpty;
}

/**
 * Save an action to the action cache. Called from EVERY action-producing path
 * so that no valid action ever skips persistence. This is the single point of
 * truth for cache writes — do NOT add inline cache saves elsewhere.
 *
 * @returns true if save succeeded, false if skipped/failed
 */
async function _saveActionToCache(
  action: any,
  currentState: string | null,
  base64: string | null,
  actionCache: any,
  existingSig: string | null,
  isCacheExcluded: boolean,
  log: Function
): Promise<boolean> {
  if (!action?.actionType) return false;
  if (!actionCache) return false;
  if (isCacheExcluded) {
    // TASK 80 (2026-09-25): On banned states, ONLY save if the AI explicitly
    // set "repeatable": true. Previously, click/flutter_tap actions on
    // exploring state were being saved because they're not ANSWER_ACTIONS
    // (keypad_input, input_email, etc.). This caused the bot to click the
    // wrong spot on unknown pages. Now ALL non-repeatable actions on banned
    // states are rejected.
    if (action.repeatable === true) {
      // AI says it's repeatable — save it regardless of state
    } else {
      // TASK 80: Don't save ANY action on banned states (not just answer actions).
      // The only exception is repeatable: true.
      return false;
    }
    // repeatable === true — proceed to save
  }
  // TASK 55 (2026-09-11): Allow 'wait' actions to be cached.
  // The old code skipped caching 'wait' actions — but 'wait' IS a valid action
  // (e.g., waiting for a video to finish, waiting for a page to load).
  // If we don't cache it, the bot re-queries the tribunal every cycle for the
  // same page, wasting API calls. The 3-failure eviction will clean up bad entries.
  // Only skip 'blank_page' (not a real action type).
  if (action.actionType === 'blank_page') return false;

  try {
    // Compute sig if not already computed for this cycle
    let sig = existingSig;
    if (!sig) {
      sig = actionCache.computeContextSignature(currentState, base64);
    }
    if (!sig) return false;

    await actionCache.save(sig, {
      actionType: action.actionType,
      targetX: action.targetX,
      targetY: action.targetY,
      value: action.value || '',
      keypadSequence: action.keypadSequence,
      currentState: action.currentState || currentState || 'unknown',
      reasoning: action.reasoning,
      // TASK 74 (2026-09-23): Pass through AI-decided skipExactMatch flag.
      // When true, the cached action will NOT be returned by exact signature
      // matching or state-only fallback — preventing the bot from reusing
      // a popup click (e.g., "Stay signed in? Yes") on a different page
      // that happens to share the same state label.
      skipExactMatch: action.skipExactMatch === true,
      // TASK 74: Pass the screenshot so save() can compute the click pixel hash.
      // The hash is stored in the DB and used by the state-only fallback to
      // verify the click area hasn't changed before returning the cached action.
      base64Screenshot: base64,
    });
    _localCacheEmpty = false;
    return true;
  } catch (err: any) {
    log(`Action cache save failed: ${err.message || err}`, 'ERROR', 'cycle');
    return false;
  }
}

let _solutionCache: any = null;
function _getSolutionCache() { if (!_solutionCache) { try { _solutionCache = require('./math-solution-cache'); } catch { _solutionCache = null; } } return _solutionCache; }
let _tmpGuardian: any = null;
function _getTmpGuardian() { if (!_tmpGuardian) { try { _tmpGuardian = require('./longevity-tmp-guardian'); } catch { _tmpGuardian = null; } } return _tmpGuardian; }
let _coldStart: any = null;
function _getColdStart() { if (!_coldStart) { try { _coldStart = require('./render-cold-start'); } catch { _coldStart = null; } } return _coldStart; }

async function runCycle(options?: { pixelOnly?: boolean }) { 
  // ─── Resolve all dependencies at cycle start ───
  // This ensures we always use the latest container state
  const CONFIG = getCONFIG();
  const loggerDep = getDep('logger') || {};
  const log = loggerDep.log || console.log;
  const logError = loggerDep.logError || console.error;
  const _providersDep = getDep('providers') || {};
  const getStats = _providersDep.getStats || (() => ({ cycleCount: 0, errors: 0 }));
  const updateStats = _providersDep.updateStats || (() => {});
  const determineNextAction = _providersDep.determineNextAction || null;
  const resetCycleProviderState = _providersDep.resetCycleProviderState || (() => {});
  const _browserDep = getDep('browser') || (() => { try { return require('./browser'); } catch { return {}; } })();
  const { launchBrowser, closeBrowser, getBrowserDisconnected, resetBrowserDisconnected, getBrowserLaunchCount, withBrowserRetry, resetBrowserLaunchCount, getPage } = _browserDep;
  const browserPhoenix = getDep('browserPhoenix') || (() => { try { return require('./browser-phoenix'); } catch { return null; } })();
  // Safe browser launch: phoenix > withBrowserRetry > plain launchBrowser.
  // Falls back to lazy require('./browser') if DI didn't inject the dep.
  const safeBrowserRetry = browserPhoenix?.phoenixBrowserRetry || withBrowserRetry || launchBrowser || (async (fn: any) => { throw new Error('No browser launch function available — browser module failed to load'); });
  const { clearCache } = getDep('cache') || {};
  const { ensureAuthenticated, handleCaptcha, authenticate } = getDep('authGuard') || {};
  const { executeAction } = getDep('actionExecutor') || {};
  const { recoverIfStuck, resetStagnationState } = getDep('stagnation') || {};
  const { trackModuleProgress } = getDep('moduleTracking') || {};
  const _smDep = getDep('stateMachine') || {};
  const stateMachine = _smDep.stateMachine || { resetDeadlock: () => {}, initialize: async () => {}, transition: async () => {} };
  const STATES = _smDep.STATES || {};
  const alertingDep = getDep('alerting') || {};
  const sendAlert = alertingDep.sendAlert || (() => {});
  const { performSelfHeal } = getDep('selfHeal') || {};
  // v5-fix H1: Use DI-injected providersBase instead of require('./providers-base')
  const _baseDep = getDep('providersBase') || {};
  const classifyProviderError = _baseDep.classifyError || null;
  const safeCall = _baseDep.safeCall || ((fn: any) => fn());
  // providers-fallback is not in the container — lazy load with caching
  let _fallbackMod: any = null;
  const getFallbackAction = async (page: any, currentState?: string) => {
    if (!_fallbackMod) { try { _fallbackMod = require('./providers-fallback'); } catch { _fallbackMod = { getFallbackAction: async () => ({ actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 }) }; } }
    return _fallbackMod.getFallbackAction(page, currentState);
  };
  const { saveCheckpoint, loadCheckpoint } = getDep('statePersist') || {};
  const { getNextModule, recordModuleCompletion } = getDep('moduleSelector') || {};
  const { trackProgress } = getDep('progressTracker') || {};
  const dbHelpers = getDep('database') || {};
  const insertSemanticsSnapshot = dbHelpers.insertSemanticsSnapshot || null;
  const upsertLastState = dbHelpers.upsertLastState || null;
  const dependencySurvivor = getDep('dependencySurvivor');
  const gitOps = getDep('selfHealGitops');
  const quotaBargain = getDep('providerQuotaBargain');
  const uiDrift = getDep('uiDriftDiscovery');
  const humanCaptcha = getDep('captchaHumanFallback');
  const bruteForce = getDep('bruteForceNavigator');
  const stabilityWaiter = getDep('flutterStability');
  const modalSlayer = getDep('flutterModalSlayer');
  const blackbox = getDep('blackbox');
  const adaptiveEngine = getDep('adaptivePerformanceEngine');
  const semantics = getDep('flutterSemantics');
  const dpr = getDep('flutterDpr');
  const network = getDep('flutterNetwork');
  const inspector = getDep('flutterInspector');
  const canvas = getDep('flutterCanvas');
  const gestures = getDep('flutterGestures');
  const strategyVariants = getDep('strategyVariants');
  const policyEngine = getDep('policyEngine');
  const pluginAPI = getDep('pluginAPI');

  // v5-fix H1: Use DI-injected explorationCartographer instead of require
  const explorationCartographer = getDep('explorationCartographer') || null;
  if (explorationCartographer && CONFIG.ENABLE_EXPLORATION_PASS) {
    log('Exploration cartographer available via DI.', 'DEBUG', 'cycle');
  }

  // ─── Resilience deps (R19 integration) ───
  const runtimeHeapGuardian = getDep('runtimeHeapGuardian');
  const runtimeModuleQuarantine = getDep('runtimeModuleQuarantine');
  const progressSemanticDetector = getDep('progressSemanticDetector');
  const progressSpeedBenchmark = getDep('progressSpeedBenchmark');
  const progressCircularPathDetector = getDep('progressCircularPathDetector');
  const cascadeBreaker = getDep('cascadeBreaker');
  const economyQuotaRations = getDep('economyQuotaRations');
  const policyActionValidator = getDep('policyActionValidator');
  const policyStateGuard = getDep('policyStateGuard');
  const authCaptchaLoopGuard = getDep('authCaptchaLoopGuard');
  const authTokenGraveyard = getDep('authTokenGraveyard');

  // ─── Degradation Level Check (Response 3) ───
  const degradationLadder = _getDegradationLadder();
  let degradationLevel = 0;
  let degradationLevelName = 'FULL';

  // ─── /tmp Disk Check (Response 6) ───
  // Quick check before cycle — if /tmp is too full, run a prune.
  // This prevents silent write failures mid-cycle.
  try {
    const tmpG = _getTmpGuardian();
    if (tmpG) {
      const usage = tmpG.getDiskUsage();
      if (usage.usagePct > parseFloat(CONFIG.TMP_GUARDIAN_WARN || '0.70')) {
        log(`/tmp usage high: ${(usage.usagePct * 100).toFixed(1)}% — running prune`, 'WARN', 'cycle');
        tmpG.prune();
      }
    }
  } catch { /* non-critical */ }

  // ─── Cold Start Recovery (Response 6) ───
  // On first cycle after a cold start, log the recovery status.
  try {
    const cs = _getColdStart();
    if (cs && cs.isColdStart() && !cs._recoveryLogged) {
      const info = cs.getColdStartInfo();
      log(`Cold start recovery: ${info?.reason || 'unknown'}. Using fast startup path.`, 'INFO', 'cycle');
      cs._recoveryLogged = true;
    }
  } catch { /* non-critical */ }
  try {
    if (degradationLadder) {
      const dlResult = degradationLadder.degradationLadder?.calculateLevel?.() || degradationLadder.calculateLevel?.();
      if (dlResult) {
        degradationLevel = dlResult.level;
        degradationLevelName = dlResult.name;
        // Apply cycle sleep if level requires it
        const cycleSleepMs = degradationLadder.degradationLadder?.getCycleSleepMs?.() || degradationLadder.getCycleSleepMs?.() || 0;
        if (cycleSleepMs > 0) {
          const { sleep } = require('./utils-sleep');
          log(`Degradation level ${degradationLevelName}: sleeping ${cycleSleepMs}ms between cycles`, 'INFO', 'cycle');
          await sleep(cycleSleepMs);
        }
        // DORMANT level: skip AI-dependent parts but still run pixel-only
        // Pixel fallback and explorer cost no API quota and can make progress
        if (degradationLevel >= 4 && !options?.pixelOnly) {
          log('Degradation level DORMANT: switching to pixel-only cycle (zero providers/budget)', 'WARN', 'cycle');
          options = { pixelOnly: true }; // Force pixel-only mode
          // Don't return — fall through to pixel-only path below
        }
      }
    }
  } catch (e: any) {
    // Non-critical: degradation check failure shouldn't break the cycle
    log(`Degradation check failed: ${e.message || e}`, 'DEBUG', 'cycle');
  }

  // Reset module quarantine at cycle start
  runtimeModuleQuarantine?.resetCycle?.();
  // Reset CAPTCHA loop guard at cycle start
  authCaptchaLoopGuard?.resetCycle?.();

  // ─── Cycle start ───
  dependencySurvivor?.checkAndFix?.();
  // Resilience: check heap before cycle starts
  runtimeHeapGuardian?.checkMemory?.();
  const cycleStart = Date.now();
  cycleStartTime = cycleStart;
  resetBrowserDisconnected?.();
  stateMachine.resetDeadlock();
  resetStagnationState?.();
  await stateMachine.initialize();
  const stats = getStats();
  updateStats({ cycleCount: (stats.cycleCount || 0) + 1, lastCycleStart: new Date().toISOString(), currentStatus: 'running' });
  log(`Starting cycle #${getStats().cycleCount}${options?.pixelOnly ? ' (pixel-only)' : ''}`, 'INFO', 'cycle');
  if (!options?.pixelOnly) resetCycleProviderState();

  let page: any;
  let clickAttempts = 0;
  let clickSuccesses = 0;

  try {
    const checkpoint = loadCheckpoint?.();
    if (checkpoint) { log(`Resuming from checkpoint at ${new Date(checkpoint.savedAt).toISOString()}`, 'INFO', 'cycle'); }

    // v16: Restore cycle manager state from DB snapshot (OOM-survival).
    // This runs once per process lifetime. On a clean start, the snapshot
    // is empty or stale and nothing happens. After an OOM kill, this
    // restores consecutiveFailures, error buffer, park state, etc.
    _restoreCycleState(log);

    // v16: Pre-cycle snapshot — write state to DB BEFORE the cycle body
    // runs. If the process is OOMkilled mid-cycle (e.g., during sign-in),
    // the finally-block snapshot never fires, but this pre-cycle snapshot
    // ensures the next boot sees correct state. Critical for first-cycle
    // OOM loops where no previous snapshot exists.
    _snapshotCycleState();

    // v9: PROACTIVE RUNTIME HEAL on restart-loop detection.
    // If the bot has restarted frequently, something is wrong in runtime state
    // that self-heal's runtime avenues can fix without code patches.
    // This runs ONCE at cycle start, before the main loop begins.
    try {
      const guardian = require('./survival-restart-guardian');
      const rStatus = guardian.getStatus?.();
      if (rStatus && rStatus.recentUnexpectedRestarts >= 2 && CONFIG.SELF_HEAL_ENABLED) {
        const selfHealMod = getDep('selfHeal');
        if (selfHealMod?.performRuntimeHeal) {
          log(`Restart loop detected (${rStatus.recentUnexpectedRestarts} restarts) — proactive runtime heal at cycle start`, 'WARN', 'cycle');
          const rtResult = await selfHealMod.performRuntimeHeal();
          if (rtResult?.healed) {
            const avenues = rtResult.results?.filter((r: any) => r.healed).map((r: any) => r.avenue).join(', ');
            log(`Proactive runtime heal SUCCEEDED: ${avenues}`, 'INFO', 'cycle');
          }
        }
      }
    } catch {}

    // Resilience: use browser-phoenix multi-tier launch if available
    page = await safeBrowserRetry(async (p: any) => {
      if (authenticate) await authenticate(p);
      if (checkpoint && checkpoint.url) { await p.goto(checkpoint.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); }
      return p;
    });

    // Validate that page is a real Playwright Page (not a browser manager or null).
    // Phoenix tier 2 recovery or lazy-require fallbacks may return non-Page objects.
    let isRealPage = page && typeof page?.goto === 'function' && typeof page?.url === 'function' && typeof page?.evaluate === 'function';
    if (!isRealPage) {
      // Last-ditch: try to get page from browser module's singleton
      try {
        const altPage = typeof getPage === 'function' ? getPage() : null;
        if (altPage && typeof altPage?.goto === 'function' && typeof altPage?.url === 'function') {
          log('Recovered valid Page from browser.getPage() after initial launch returned non-Page', 'WARN', 'cycle');
          page = altPage;
          isRealPage = true;
        }
      } catch {}
    }
    if (!isRealPage) {
      throw new Error(`Browser launch did not return a valid Playwright Page (got ${typeof page}${page?.constructor?.name ? ': ' + page.constructor.name : ''})`);
    }

    if (CONFIG.ENABLE_NETWORK_INTERCEPT && !_networkSetup && network && typeof page.route === 'function') {
      await network.setupInterception(page);
      _networkSetup = true;
    }
    if (CONFIG.FLUTTER_DPR_AUTO_CALIBRATE && dpr) { await dpr.calibrate(page).catch((e: any) => { log(`DPR calibration skipped: ${e.message}`, 'WARN', 'cycle'); }); }

    // v14: Wait for the page to render visible content after any navigation.
    // Flutter CanvasKit renders to a <canvas> element which starts as a blank
    // rectangle (all-black or all-white pixels) and takes several seconds to
    // paint the UI. This function polls the page using pixel-variance detection
    // until content appears or the timeout expires.
    // Returns true if page rendered, false if still blank after timeout.
    //
    // TASK 96 (2026-09-29): Increased from 15s to 30s.
    // The Flutter Web app sometimes takes >15s to render on Render free tier
    // (slow CPU, shared resources). 15s was too short — the bot gave up and
    // declared the page blank before Flutter finished initializing.
    async function _waitForRenderedPage(pg: any, timeoutMs: number = 30000): Promise<boolean> {
      try {
        const authGuard = getDep('authGuard');
        if (typeof authGuard?._isPageBlank !== 'function') return true;
        const deadline = Date.now() + timeoutMs;
        let checks = 0;
        while (Date.now() < deadline) {
          try {
            if (!(await authGuard._isPageBlank(pg))) {
              if (checks > 0) log(`Page rendered after ${checks} blank poll(s)`, 'DEBUG', 'cycle');
              return true;
            }
          } catch { break; }
          checks++;
          if (Date.now() < deadline) await new Promise(r => setTimeout(r, 2000));
        }
        log(`Page still blank after ${timeoutMs / 1000}s (${checks} polls)`, 'WARN', 'cycle');
        return false;
      } catch { return true; }
    }

    // v18 REMOVED: _isPageDead() was causing false positives on live pages.
    // The catch-all `catch { return true }` treated any transient property
    // access glitch as a dead page, triggering an unnecessary browser relaunch
    // that KILLED the working browser on 512MB (two Chrome instances = OOM).
    // Dead pages are now handled by the existing try/catch blocks around
    // page.screenshot() (line ~1500) and page.evaluate() (line ~2159), which
    // catch "closed"/"disconnected" errors and relaunch cleanly.

    // v18: Rate-limited browser relaunch. Prevents a death spiral where:
    //   1. Browser dies (OOM or process crash)
    //   2. _relaunchBrowser launches a new browser (~100MB RSS spike)
    //   3. The launch itself triggers another OOM, killing the new browser
    //   4. Next iteration detects dead page → relaunch again → loop
    // Without cooldown, the bot burns memory relaunching Chrome every 30s
    // without ever making progress. Cooldown lets memory settle after a
    // relaunch so the next iteration can actually take a screenshot and
    // proceed with the cycle.
    let _lastRelaunchTime = 0;
    const RELAUNCH_COOLDOWN_MS = 60000; // 60s between relaunch attempts

    async function _relaunchBrowser(): Promise<any> {
      const now = Date.now();
      if (now - _lastRelaunchTime < RELAUNCH_COOLDOWN_MS) {
        const waitMs = RELAUNCH_COOLDOWN_MS - (now - _lastRelaunchTime);
        log(`Browser relaunch rate-limited — waiting ${Math.round(waitMs / 1000)}s (cooldown)`, 'WARN', 'cycle');
        await new Promise(r => setTimeout(r, waitMs));
      }
      _lastRelaunchTime = Date.now();
      log('Browser was closed (likely by memory protection). Re-launching...', 'WARN', 'cycle');
      // Mark the old browser close as intentional BEFORE safeBrowserRetry calls
      // launchBrowser() → cleanup(). Without this, cleanup() fires the
      // "disconnected" event with _intentionalClose=false, producing a
      // misleading "Browser process disconnected unexpectedly" error log.
      try {
        const bm = _browserDep?.getBrowserManager?.();
        if (bm) bm._intentionalClose = true;
      } catch {}
      _networkSetup = false;
      const newPage = await safeBrowserRetry(async (p: any) => {
        if (authenticate) await authenticate(p);
        const targetUrl = _getRecoveryUrl();
        if (targetUrl) { await p.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}); }
        return p;
      });
      browserLastRestart = Date.now();
      _trackBrowserRestart();
      if (typeof resetBrowserLaunchCount === 'function') resetBrowserLaunchCount();
      return newPage;
    }

    // Navigate to app if browser landed on about:blank (fresh start OR post-self-heal)
    // Even with a checkpoint, self-heal may have killed the browser and re-launched
    // to about:blank. If we're on about:blank, we MUST navigate — the checkpoint
    // URL is stale (the browser was killed).
    if (page.url() === 'about:blank') {
      const targetUrl = _getRecoveryUrl();

      // BUG FIX (2026-09-06): Force GC + check heap BEFORE page.goto().
      // The navigation to app.mathu.co.za + Turso cold start + Flutter canvas
      // render all happen in a ~2 second burst, pushing heap from ~48MB to
      // 253MB — past the 256MB V8 limit. V8's OOM killer fires faster than
      // our 2-second early-oom interval. By forcing GC and checking heap
      // synchronously RIGHT BEFORE navigation, we ensure there's headroom.
      try { if (global.gc) global.gc(); } catch {}
      const _preNavHeapMB = process.memoryUsage().heapUsed / 1024 / 1024;
      const _preNavRSSMB = process.memoryUsage().rss / 1024 / 1024;
      log(`Pre-navigation memory check: heap=${_preNavHeapMB.toFixed(0)}MB, rss=${_preNavRSSMB.toFixed(0)}MB`, 'INFO', 'cycle');
      // BUG FIX (2026-09-06): Higher thresholds for 384MB V8 limit.
      // Flutter Web loads ~150MB into the shared V8 heap (Chromium --single-process).
      // 66MB baseline + 150MB Flutter = 216MB. Allow up to 300MB heap / 430MB RSS
      // before bailing — gives 84MB headroom below V8's 384MB limit.
      if (_preNavHeapMB >= 300 || _preNavRSSMB >= 430) {
        log(`FATAL: Memory too high before navigation (heap=${_preNavHeapMB.toFixed(0)}MB, rss=${_preNavRSSMB.toFixed(0)}MB). Exiting for clean restart.`, 'FATAL', 'cycle');
        try { require('./survival-restart-guardian').preserveBeforeExit?.('pre_nav_oom').catch(() => {}); } catch {}
        const origExit = (process as any)._originalExit || process.exit.bind(process);
        origExit(137);
      }

      log(`Fresh start: navigating to ${targetUrl}`, 'INFO', 'cycle');
      // ─────────────────────────────────────────────────────────────────────
      // PROXY-AWARE NAVIGATION RECOVERY (Task 29, 2026-09-08)
      // ─────────────────────────────────────────────────────────────────────
      // The bot uses a ProxyScrape ZA proxy for IP masking. When that proxy
      // silently fails (peer returns 502, hangs the connection, DNS fails
      // through the tunnel), `page.goto` times out at 30s or fails with
      // ERR_CONNECTION_CLOSED / ERR_TUNNEL_CONNECTION_FAILED. Without
      // recovery, the bot cycles on blank pages for 2-6 minutes before the
      // chrome-error URL appears and the auth-guard's threshold kicks in.
      //
      // Strategy: 3 bounded retries with a FRESH browser context each time:
      //   Attempt 1 — current proxy (already validated by `setupContext`)
      //   Attempt 2 — rotate to a different validated proxy
      //   Attempt 3 — direct connection (bypass proxy entirely)
      //
      // Each retry uses `closeBrowser` + `safeBrowserRetry` so the new
      // context picks up the latest `__proxyDisabled` / `ensureValidProxy`
      // decision. Network errors are recorded via `recordNetworkError` for
      // dashboard display. After the 3rd attempt fails, we log + continue
      // (the cycle's normal blank-page escalation will eventually self-heal).
      let _initialNavOk = false;
      const MAX_NAV_ATTEMPTS = 3;
      const _navAttemptOutcomes: Array<{ attempt: number; mode: string; ok: boolean; errorType?: string; message?: string }> = [];

      for (let _navAttempt = 1; _navAttempt <= MAX_NAV_ATTEMPTS && !_initialNavOk; _navAttempt++) {
        const _mode = _navAttempt === 1 ? 'proxy' : _navAttempt === 2 ? 'rotated' : 'direct';
        try {
          if (_navAttempt > 1) {
            // Before retrying: relaunch browser with fresh context.
            // Attempt 2: rotate to a different validated proxy.
            // Attempt 3: bypass proxy entirely (direct connection).
            try {
              const ipRotator = require('./network-ip-rotator');
              if (_navAttempt === 2 && typeof ipRotator.rotateToValidatedProxy === 'function') {
                const newProxy = await ipRotator.rotateToValidatedProxy(5);
                if (!newProxy) {
                  log('Attempt 2: no validated proxy available — skipping to direct connection.', 'WARN', 'cycle');
                  // Skip directly to attempt 3 (direct)
                  // BUG FIX (2026-09-09): Use bypassProxy() to fully shut down proxy
                  if (typeof ipRotator.bypassProxy === 'function') {
                    ipRotator.bypassProxy('no validated proxy available (attempt 2)');
                  } else {
                    (globalThis as any).__proxyDisabled = true;
                  }
                } else {
                  log(`Attempt 2: rotated to validated proxy ${newProxy}.`, 'INFO', 'cycle');
                }
              }
              if (_navAttempt === 3) {
                // Bypass proxy entirely.
                if (typeof ipRotator.bypassProxy === 'function') {
                  ipRotator.bypassProxy('navigation failed with proxy attempts 1+2');
                } else {
                  (globalThis as any).__proxyDisabled = true;
                }
                log('Attempt 3: bypassing proxy — using direct connection.', 'WARN', 'cycle');
                try {
                  const alerting = getDep('alerting');
                  // TASK 61: Removed alert — routine event.
                } catch {}
              }
            } catch { /* ip-rotator not loaded */ }

            // Relaunch browser with fresh context (picks up the new proxy mode)
            _networkSetup = false;
            const bm = _browserDep?.getBrowserManager?.();
            if (bm) bm._intentionalClose = true;
            await closeBrowser?.();
            await new Promise(r => setTimeout(r, 2000));
            page = await safeBrowserRetry(async (p: any) => {
              if (authenticate) await authenticate(p);
              return p;
            });
            if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
              try { await network.setupInterception(page); _networkSetup = true; } catch {}
            }
          }

          log(`Navigation attempt ${_navAttempt}/${MAX_NAV_ATTEMPTS} [${_mode}]: ${targetUrl}`, 'INFO', 'cycle');
          await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
          _initialNavOk = true;
          _navAttemptOutcomes.push({ attempt: _navAttempt, mode: _mode, ok: true });
          log(`Navigation attempt ${_navAttempt} succeeded [${_mode}].`, 'INFO', 'cycle');
        } catch (navErr: any) {
          const _errMsg = navErr?.message || String(navErr);
          // Categorize the error for dashboard + decision-making
          let _errorType = 'UNKNOWN';
          try {
            const ipRotator = require('./network-ip-rotator');
            if (typeof ipRotator.recordNetworkError === 'function') {
              ipRotator.recordNetworkError(navErr, { url: targetUrl });
              // Re-read the categorized type from the latest record
              const rec = ipRotator.getLatestNetworkError?.();
              if (rec?.errorType) _errorType = rec.errorType;
            }
          } catch { /* ip-rotator not loaded */ }

          _navAttemptOutcomes.push({ attempt: _navAttempt, mode: _mode, ok: false, errorType: _errorType, message: _errMsg.substring(0, 200) });
          log(`Navigation attempt ${_navAttempt} [${_mode}] failed: ${_errorType} — ${_errMsg.substring(0, 150)}`, 'WARN', 'cycle');

          // If this is a connection-closed / tunnel-failed / proxy error,
          // we know the proxy is bad — don't bother retrying with the same
          // proxy, skip straight to rotation (attempt 2) or bypass (attempt 3).
          const _isProxyError = /ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|chrome-error|CHROME_ERROR_PAGE/i.test(_errMsg);
          const _isTimeout = /Timeout \d+ms exceeded/i.test(_errMsg);

          if (_isProxyError && _navAttempt === 1) {
            log('Proxy error detected — skipping rotation, going straight to attempt 2 (rotate).', 'WARN', 'cycle');
            // Force the loop to attempt 2 (which will rotate)
            // (the for-loop will naturally increment to attempt 2)
          } else if (_isTimeout && _navAttempt === 1) {
            // First attempt timed out — proxy may be slow but not necessarily broken.
            // Try rotation (attempt 2) before giving up entirely.
            log('Navigation timeout on attempt 1 — will try rotating proxy on attempt 2.', 'WARN', 'cycle');
          } else if (_navAttempt === MAX_NAV_ATTEMPTS) {
            // Last attempt failed — log and continue (blank-page escalation will handle it)
            log(`All ${MAX_NAV_ATTEMPTS} navigation attempts failed. Outcomes: ${JSON.stringify(_navAttemptOutcomes)}`, 'ERROR', 'cycle');
            try {
              const alerting = getDep('alerting');
              // TASK 61: Removed alert — routine event.
            } catch {}

            // BUG FIX (2026-09-09): NETWORK-UNREACHABLE EXIT CONDITION.
            // If ALL 3 navigation attempts failed AND the chrome-error count is
            // high (> 10), the Render instance's network is completely broken.
            // Cycling on blank pages for hours won't fix a network outage —
            // EXIT the process so Render can restart it cleanly. A fresh
            // instance may get a different network path / IP / container.
            const _chromeErrCount = (globalThis as any).__chromeErrorCount || 0;
            if (_chromeErrCount >= 10) {
              log(`FATAL: Network unreachable — all ${MAX_NAV_ATTEMPTS} navigation attempts failed AND chrome-error count is ${_chromeErrCount}. Exiting for clean restart.`, 'FATAL', 'cycle');
              try {
                const alerting = getDep('alerting');
                alerting?.sendAlert?.(`FATAL: Network unreachable (chrome-error count=${_chromeErrCount}). Process exiting for clean Render restart.`);
              } catch {}
              try { require('./survival-restart-guardian').preserveBeforeExit?.('network_unreachable').catch(() => {}); } catch {}
              const origExit = (process as any)._originalExit || process.exit.bind(process);
              origExit(137);
            }
          }
          // Loop continues to next attempt
        }
      } // end for (navigation attempts)

      // BUG FIX (2026-09-06): Force GC + check heap AFTER page.goto() too.
      // The navigation itself may have allocated a lot (DOM, JS, network
      // responses). Force GC to reclaim what we can before the tribunal
      // adds more allocations (screenshot, provider calls, JSON parse).
      try { if (global.gc) global.gc(); } catch {}
      const _postNavHeapMB = process.memoryUsage().heapUsed / 1024 / 1024;
      const _postNavRSSMB = process.memoryUsage().rss / 1024 / 1024;
      log(`Post-navigation memory: heap=${_postNavHeapMB.toFixed(0)}MB, rss=${_postNavRSSMB.toFixed(0)}MB`, 'INFO', 'cycle');
      if (_postNavHeapMB >= 320 || _postNavRSSMB >= 440) {
        log(`FATAL: Memory too high after navigation (heap=${_postNavHeapMB.toFixed(0)}MB, rss=${_postNavRSSMB.toFixed(0)}MB). Exiting for clean restart.`, 'FATAL', 'cycle');
        try { require('./survival-restart-guardian').preserveBeforeExit?.('post_nav_oom').catch(() => {}); } catch {}
        const origExit = (process as any)._originalExit || process.exit.bind(process);
        origExit(137);
      }

      log('Fresh start: waiting for Flutter canvas to render...', 'INFO', 'cycle');
      await _waitForRenderedPage(page, 20000);

      // ─────────────────────────────────────────────────────────────────────
      // PERSISTENT-BLANK-AFTER-NAV BROWSER-PROGRESS FAILURE (Task 29)
      // ─────────────────────────────────────────────────────────────────────
      // If navigation "succeeded" (page.goto didn't throw) but the rendered
      // page is still blank after a 20s render wait, that's a distinct failure
      // category: BROWSER_PROGRESS_FAILURE. The page loaded but nothing painted
      // — meaning the proxy delivered a white screen, the JS bundle failed to
      // execute, or the Flutter canvas never initialized.
      //
      // Rather than waiting indefinitely (the old behavior), we poll the page
      // for up to 15 more seconds (3 × 5s polls). If still blank, we:
      //   1. Record a network error (BROWSER_PROGRESS_FAILURE).
      //   2. If a proxy is active and this isn't attempt 3, rotate/bypass and
      //      retry the entire navigation (loop back to attempt N+1).
      //   3. If we've exhausted retries, fall through to the normal cycle —
      //      the blank-page escalation ladder will eventually trigger self-heal.
      if (!_initialNavOk) {
        // Navigation itself failed all 3 attempts — don't double-recover here.
        // The blank-page escalation ladder below will handle it.
        log('Navigation did not succeed — relying on blank-page escalation.', 'WARN', 'cycle');
      } else {
        // Navigation "succeeded" — verify the page actually has content.
        let _persistentBlank = false;
        let _blankPolls = 0;
        const MAX_BLANK_POLLS = 3;
        const BLANK_POLL_INTERVAL_MS = 5000;
        for (let _bp = 0; _bp < MAX_BLANK_POLLS; _bp++) {
          try {
            const authGuard = getDep('authGuard');
            if (typeof authGuard?._isPageBlank === 'function') {
              const blank = await authGuard._isPageBlank(page);
              if (!blank) {
                _blankPolls = 0; // got content — exit early
                break;
              }
            } else {
              break; // can't check — assume ok
            }
          } catch { break; }
          _blankPolls++;
          if (_bp < MAX_BLANK_POLLS - 1) {
            await new Promise(r => setTimeout(r, BLANK_POLL_INTERVAL_MS));
          }
        }
        _persistentBlank = _blankPolls >= MAX_BLANK_POLLS;

        if (_persistentBlank) {
          // Record as a distinct browser-progress failure
          try {
            const ipRotator = require('./network-ip-rotator');
            if (typeof ipRotator.recordNetworkError === 'function') {
              ipRotator.recordNetworkError(
                new Error('Persistent blank screenshot after navigation — browser did not progress (canvas not painted)'),
                { url: targetUrl }
              );
            }
          } catch { /* ip-rotator not loaded */ }

          log(`BROWSER_PROGRESS_FAILURE: page blank after ${MAX_BLANK_POLLS} polls (${MAX_BLANK_POLLS * BLANK_POLL_INTERVAL_MS / 1000}s). Nav "succeeded" but nothing painted.`, 'ERROR', 'cycle');

          // If a proxy is still active, this is likely a proxy delivering a
          // blank response — bypass and let the next cycle try direct.
          try {
            const ipRotator = require('./network-ip-rotator');
            const currentProxy = ipRotator.getCurrentProxy?.();
            if (currentProxy && !(globalThis as any).__proxyDisabled) {
              if (typeof ipRotator.bypassProxy === 'function') {
                ipRotator.bypassProxy('persistent blank screenshot after navigation (proxy may be delivering empty response)');
              } else {
                (globalThis as any).__proxyDisabled = true;
              }
              log(`Proxy was active during persistent-blank — bypassing. Next cycle will use direct connection.`, 'WARN', 'cycle');
              try {
                const alerting = getDep('alerting');
                // TASK 61: Removed alert — routine event.
              } catch {}
            }
          } catch { /* ip-rotator not loaded */ }

          // Reload the page once with a fresh navigation — sometimes a single
          // navigation gets a bad response but a retry gets the real page.
          try {
            log('Attempting one page.reload() to recover from persistent blank...', 'WARN', 'cycle');
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 });
            await new Promise(r => setTimeout(r, 5000));
            // Check again
            const authGuard = getDep('authGuard');
            if (typeof authGuard?._isPageBlank === 'function') {
              const stillBlank = await authGuard._isPageBlank(page);
              if (stillBlank) {
                log('Page still blank after reload — falling through to cycle. Blank-page escalation will handle it.', 'WARN', 'cycle');
              } else {
                log('Page recovered after reload — proceeding with cycle.', 'INFO', 'cycle');
              }
            }
          } catch (reloadErr: any) {
            log(`Page reload during persistent-blank recovery failed: ${reloadErr?.message || reloadErr}`, 'WARN', 'cycle');
          }
        }
      }
    }

    let questionsCompleted = checkpoint?.questionsCompleted || 0;

    // v16: Replay actions from DB if process was OOMkilled.
    // Skips tribunal calls for the replayed actions, saving API budget.
    if (executeAction) {
      const replayed = await _replayActionsFromDB(page, executeAction, log);
      if (replayed > 0) {
        // Wait for page to settle after replayed actions
        await _waitForRenderedPage(page, 10000);
        if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
      }
    }

    // v6: Track whether we're mid-quiz (vs. between quizzes on assignments page).
    // When mid-quiz, memory protection uses browser-safe shedding (L0-L2)
    // instead of closing the browser (L3) which would destroy quiz state.
    let _midQuiz = false;
    let lastProgressTime = Date.now();
    let browserLastRestart = Date.now();
    let currentState = checkpoint?.state || null;
    let stuckCounter = 0;
    const MAX_STUCK = 10;
    let _appErrorCount = 0; // BUG FIX (2026-09-07): Track consecutive app_error states for browser relaunch
    let consecutiveTribunalFailures = 0;
    let unknownStateCounter = 0; // Counts consecutive 'unknown' currentState results
    let _humanInterventionLogged = false; // Task 35: Track if we've already logged the pause message
    // TASK 58 (2026-09-11): Track whether the AI has submitted an answer on
    // the current question. Multiple-choice questions are answered by clicking
    // a choice (click/flutter_tap). After the AI clicks, the next action is
    // usually "click Next" or "click book icon" — these CAN be cached because
    // their position doesn't change. But BEFORE the AI clicks, the cache must
    // NOT activate — the AI must read each question and choose the right answer.
    let _answerSubmitted = false;
    let _answerSubmittedState: string | null = null; // which state the answer was submitted on
    // TASK 62 (2026-09-11): Track consecutive screenshot-unchanged cycles for
    // cached actions. If a cached action doesn't change the screenshot 3 times
    // in a row, evict it — the cached action is wrong for this page.
    let _cacheHitUnchangedCount = 0;
    let _cacheHitUnchangedSig: string | null = null;
    const MAX_UNKNOWN_STATE = 3; // After this many unknowns, force recovery

    // TASK 39 (2026-09-09): Track consecutive "no providers" tribunal failures.
    // If ALL vision providers are unavailable for 30 minutes straight,
    // pause the bot for 3 hours and don't touch the browser.
    // API rate limits typically reset daily, so waiting 3h gives time for
    // cooldowns to expire without burning cycles on doomed tribunal calls.
    let _noProvidersSince: number | null = null; // timestamp when providers first became unavailable
    const NO_PROVIDERS_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    const NO_PROVIDERS_PAUSE_MS = 3 * 60 * 60 * 1000; // 3 hours
    let _noProvidersPauseUntil: number | null = null; // timestamp until which we should pause

    // v12: Blank-page escalation ladder — prevents infinite blank/wait loops
    // Track consecutive blank-page detections separately from unknown states.
    // Step 1 (count >= 2): reload MathU
    // Step 2 (count >= 3): restart browser context entirely
    // Step 3 (count >= 5): trigger full self-heal (let AI figure it out)
    // v12 FIX: Counter is NO LONGER reset on browser restart. It only resets
    // when the page is confirmed NON-blank. This prevents the loop:
    //   blank → restart → blank → restart → blank → restart (forever)
    // Instead: blank → restart → blank → restart → SELF-HEAL (3 restarts = done)
    let blankPageCounter = 0;
    const BLANK_RELOAD_THRESHOLD = 2;  // After 2 blank checks → reload
    const BLANK_RESTART_THRESHOLD = 3; // After 3 blank checks → restart browser context
    const BLANK_SELF_HEAL_THRESHOLD = 5; // After 5 blank checks → full self-heal
    // TASK 109 (2026-10-06): Bounded blank-page recovery.
    // After MAX_BLANK_RECOVERY_ATTEMPTS, stop the no-progress loop and
    // raise a specific alert. The old code reset blankPageCounter after
    // each escalation (reload/restart/self-heal), so the bot cycled
    // through the escalation steps forever — 353 cycles, 0 questions.
    // Now: track total blank recovery attempts (never reset), and when
    // the budget is exhausted, break the cycle and alert.
    const MAX_BLANK_RECOVERY_ATTEMPTS = 10; // total reloads+restarts+heals before giving up
    let totalBlankRecoveryAttempts = 0;

    // v10: Restart-count tracker — triggers self-heal if too many browser
    // restarts happen in a short window (symptom of a deeper issue).
    let recentRestartTimes: number[] = [];
    const RESTART_WINDOW_MS = 10 * 60 * 1000; // 10 min window
    const RESTART_COUNT_SELF_HEAL_THRESHOLD = 4; // 4 restarts in 10min → self-heal
    let restartSelfHealTriggered = false;

    // v10: Helper to track restarts and trigger self-heal if too many
    function _trackBrowserRestart() {
      recentRestartTimes.push(Date.now());
      // Prune old entries outside the window
      const windowStart = Date.now() - RESTART_WINDOW_MS;
      recentRestartTimes = recentRestartTimes.filter(t => t >= windowStart);
      // Check if we've hit the threshold
      if (!restartSelfHealTriggered && recentRestartTimes.length >= RESTART_COUNT_SELF_HEAL_THRESHOLD) {
        log(`Restart storm detected: ${recentRestartTimes.length} browser restarts in ${RESTART_WINDOW_MS / 60000}min — triggering self-heal`, 'WARN', 'cycle');
        restartSelfHealTriggered = true;
        if (CONFIG.SELF_HEAL_ENABLED && !selfHealRunning) {
          const selfHealMod = getDep('selfHeal');
          if (selfHealMod?.performRuntimeHeal) {
            try {
              const memoryMode = require('./memory-mode');
              if (memoryMode.isMemoryProtection?.()) {
                memoryMode.beginSelfHealSession?.(`restart_storm_${recentRestartTimes.length}_in_${RESTART_WINDOW_MS / 60000}min`);
              }
            } catch {}
            selfHealMod.performRuntimeHeal().then((rtResult: any) => {
              if (rtResult?.healed) {
                log(`Restart storm: runtime heal succeeded`, 'INFO', 'cycle');
              }
            }).catch(() => {});
          }
          // If runtime heal doesn't help, also trigger full self-heal
          const performSelfHeal = getDep('selfHeal')?.performSelfHeal;
          if (performSelfHeal && !selfHealRunning) {
            selfHealRunning = true;
            performSelfHeal({ skipRuntimeHeal: true }).then((healed: any) => {
              selfHealRunning = false;
              if (healed) log('Restart storm: full self-heal succeeded', 'INFO', 'cycle');
              else log('Restart storm: full self-heal failed', 'ERROR', 'cycle');
            }).catch(() => { selfHealRunning = false; });
          }
        }
      }
    }

    // 20-min stagnation auto-ban: track screenshot hash changes + question completions
    // to detect death spirals (wait/error loops with no progress)
    let lastScreenshotChangeTime = Date.now();
    let lastQuestionCompletionTime = Date.now();
    let previousScreenshotHash: string | null = null;
    let stagnationAutoBanTriggered = false;
    const STAGNATION_AUTO_BAN_MS = 20 * 60 * 1000;

    // Module download flow state machine (Response 3)
    // Tracks whether we just clicked a download button and need to wait
    // for the module to download before looking for Watch/Start buttons.
    type DownloadState = 'idle' | 'download_clicked' | 'downloading' | 'content_visible';
    let _moduleDownloadState: DownloadState = 'idle';
    let _moduleDownloadStartTime: number = 0;
    let _moduleDownloadRetryCount: number = 0;
    const MODULE_DOWNLOAD_TIMEOUT_MS = 60000; // 60s max wait for download
    const MODULE_DOWNLOAD_POLL_INTERVAL_MS = 3000; // poll every 3s
    const MODULE_DOWNLOAD_MAX_RETRIES = 2;
    let _preDownloadScreenshotHash: string | null = null;

    // Select module using dynamic planning
    let currentModule = getNextModule?.();
    if (currentModule) { log(`Selected module: ${currentModule}`, 'INFO', 'cycle'); }

    while (questionsCompleted < CONFIG.MAX_QUESTIONS && !stopRequested) {
      try { fs.writeFileSync(CONFIG.HEARTBEAT_FILE, String(Date.now())); } catch (_e: any) { /* best-effort heartbeat write */ }

      // ─────────────────────────────────────────────────────────────────────
      // HUMAN INTERVENTION PAUSE (Task 35, 2026-09-09)
      // ─────────────────────────────────────────────────────────────────────
      // When `__humanInterventionRequested` is set (via dashboard API or by
      // the bot itself when truly stuck), the bot PAUSES completely:
      //   - NO screenshots
      //   - NO clicks / actions
      //   - NO navigation
      //   - NO auth checks
      //   - NO tribunal calls
      // Just waits in a 5s poll loop until the flag is cleared via API.
      //
      // This lets the user:
      //   - Connect to the dashboard and see what state the bot is in
      //   - Optionally toggle headed mode to see the browser visually
      //   - Fix the issue manually (solve captcha, log in, navigate, etc.)
      //   - Click "Resume" on the dashboard to clear the flag
      if ((globalThis as any).__humanInterventionRequested) {
        const _reason = (globalThis as any).__humanInterventionReason || 'manual request';
        const _since = (globalThis as any).__humanInterventionSince || Date.now();
        const _pausedFor = Math.round((Date.now() - _since) / 1000);
        if (!_humanInterventionLogged) {
          log(`HUMAN INTERVENTION PAUSED — reason: ${_reason}. Bot will not touch the browser. Use dashboard /api/intervention/resume to continue.`, 'WARN', 'cycle');
          _humanInterventionLogged = true;
          // Send alert so the user knows
          try {
            const alerting = getDep('alerting');
            alerting?.sendAlert?.(`Human intervention required: ${_reason}. Bot paused — no browser interaction until resumed via dashboard.`);
          } catch {}
        }
        // Wait 5s before checking again — don't busy-loop
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }
      if (_humanInterventionLogged) {
        log('Human intervention RESUMED — bot continues normal operation.', 'INFO', 'cycle');
        _humanInterventionLogged = false;
      }

      // ─────────────────────────────────────────────────────────────────────
      // NO-PROVIDERS PAUSE (Task 39, 2026-09-09)
      // ─────────────────────────────────────────────────────────────────────
      // If ALL vision providers have been unavailable for 30+ minutes,
      // pause the bot for 3 hours. Don't touch the browser at all — just
      // sleep in 5-minute intervals until the pause expires.
      //
      // This prevents the bot from cycling for hours on doomed tribunal calls
      // when every provider is rate-limited (429) or down.
      if (_noProvidersPauseUntil && Date.now() < _noProvidersPauseUntil) {
        const _remaining = Math.round((_noProvidersPauseUntil - Date.now()) / 60000);
        if (!_humanInterventionLogged) {
          log(`NO-PROVIDERS PAUSE: All vision providers unavailable for 30+ min. Pausing for ${_remaining} more min. Not touching browser.`, 'WARN', 'cycle');
          try {
            const alerting = getDep('alerting');
            // TASK 61: Removed alert — routine event when quotas exhaust.
          } catch {}
          _humanInterventionLogged = true;
        }
        // Sleep 5 minutes, then check again
        await new Promise(r => setTimeout(r, 5 * 60 * 1000));
        continue;
      }
      // Pause expired — clear it
      if (_noProvidersPauseUntil && Date.now() >= _noProvidersPauseUntil) {
        log('NO-PROVIDERS PAUSE expired — resuming normal operation. Checking providers again.', 'INFO', 'cycle');
        _noProvidersPauseUntil = null;
        _noProvidersSince = null;
        (globalThis as any).__noProvidersSince = null;
        (globalThis as any).__noProvidersPauseUntil = null;
        _humanInterventionLogged = false;
      }

      // v11: OOM EMERGENCY PERIODIC HEAL — check at the top of every cycle
      // iteration. If the restart guardian is in emergency mode (OOM loop
      // detected), fire performRuntimeHeal directly. This runs even when
      // cycles succeed (no errors) or when all errors are transient (429s).
      // Without this, self-heal only fires inside error handlers which
      // require specific error classifications.
      if (CONFIG.SELF_HEAL_ENABLED && !selfHealRunning) {
        try {
          const guardian = require('./survival-restart-guardian');
          if (guardian.isEmergencyMode?.()) {
            const cycleNum = getStats().cycleCount || 0;
            // Only attempt every 3rd cycle to avoid healing on every single iteration
            if (cycleNum % 3 === 0) {
              log('OOM emergency: periodic runtime heal at cycle top', 'WARN', 'cycle');
              selfHealRunning = true;
              const directHeal = require('./self-heal').performRuntimeHeal;
              if (typeof directHeal === 'function') {
                directHeal().then((rtResult: any) => {
                  selfHealRunning = false;
                  if (rtResult?.healed) {
                    const avenues = rtResult.results?.filter((r: any) => r.healed).map((r: any) => r.avenue).join(', ');
                    log(`OOM emergency periodic heal SUCCEEDED: ${avenues}`, 'INFO', 'cycle');
                    // Reset circuit breaker
                    try {
                      const cb = require('./self-heal-circuit-breaker');
                      const breaker = cb.healerCircuitBreaker || cb;
                      if (typeof breaker.reset === 'function') breaker.reset();
                    } catch {}
                  }
                }).catch(() => { selfHealRunning = false; });
              } else {
                selfHealRunning = false;
              }
            }
          }
        } catch {}
      }

      // ── OR Budget Park: skip everything when OR is exhausted ──
      // When parked, we skip screenshots, tribunal, and all actions.
      // The screen stays exactly as-is (same question). We just sleep
      // until midnight UTC when the budget resets.
      if (await _checkOrPark(log)) {
        await new Promise(r => setTimeout(r, OR_PARK_CHECK_INTERVAL_MS));
        continue;
      }

      // Resilience: heap guardian check (supplements built-in checkMemoryAndRecover)
      // v5 FIX: checkMemory is now async
      // v6 FIX: pass preserveBrowser when mid-quiz to avoid destroying quiz state
      const guardianHit = await runtimeHeapGuardian?.checkMemory?.({ preserveBrowser: _midQuiz });
      if (guardianHit) {
        log('Heap guardian triggered hard threshold — breaking cycle', 'ERROR', 'cycle');
        break;
      }
      if (await checkMemoryAndRecover(CONFIG, log, clearCache, _midQuiz)) {
        // v6: Only close+restart browser if shedMemory actually closed it.
        // When preserveBrowser=true (mid-quiz), shedMemory uses L0-L2 and
        // the browser stays open — no need to re-launch.
        try {
          const memoryMode = require('./memory-mode');
          if (memoryMode.wasBrowserClosedByProtection()) {
            if (typeof closeBrowser === 'function') await closeBrowser();
            _networkSetup = false;
            page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
            browserLastRestart = Date.now();
            _trackBrowserRestart();
            memoryMode.clearBrowserClosedFlag();
          } else {
            log('Memory shed preserved browser (mid-quiz) — continuing without restart', 'INFO', 'cycle');
          }
        } catch { /* memory-mode not available, do full restart to be safe */
          if (typeof closeBrowser === 'function') await closeBrowser();
          _networkSetup = false;
          page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
          browserLastRestart = Date.now();
          _trackBrowserRestart();
        }
      }
      if (typeof getBrowserDisconnected === 'function' && getBrowserDisconnected()) throw new Error('Browser disconnected');
      if ((typeof getBrowserLaunchCount === 'function' && getBrowserLaunchCount() > 10) || (Date.now() - browserLastRestart) > browserRestartInterval) {
        log('Restarting browser for stability', 'INFO', 'cycle');
        if (typeof closeBrowser === 'function') await closeBrowser();
        _networkSetup = false;
        page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
        browserLastRestart = Date.now();
        _trackBrowserRestart();
        if (typeof resetBrowserLaunchCount === 'function') resetBrowserLaunchCount();
        else log('resetBrowserLaunchCount not available from browser module', 'WARN', 'cycle');
      }
      if (Date.now() - cycleStart > CONFIG.MAX_RUNTIME_PER_CYCLE_MS) {
        log('Cycle timeout', 'INFO', 'cycle');
        break;
      }

      // Resilience: token graveyard proactive refresh before auth check
      authTokenGraveyard?.checkAndRefresh?.(getDep('auth'));
      if (ensureAuthenticated) {
        const prevPage = page;
        page = await ensureAuthenticated(page);
        if (page !== prevPage) {
          _networkSetup = false;
          if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
            await network.setupInterception(page);
            _networkSetup = true;
          }
          if (CONFIG.FLUTTER_DPR_AUTO_CALIBRATE && dpr) { await dpr.calibrate(page); }
        }
      }

      // v12: Blank-page counter management via auth guard flags.
      // peekBlankPageFlag checks without consuming. consumeBlankPageFlag checks AND clears.
      // v13 FIX: Do NOT reset blankPageCounter when peek returns false.
      // The flag is only set in specific auth-guard paths — if the page is blank
      // but the flag wasn't set (e.g., refreshSession "succeeded" on a blank page),
      // resetting the counter here prevents escalation and creates an infinite loop.
      // The counter is now only reset when the tribunal confirms a non-blank page
      // (at line ~2352, where action.currentState is not blank_page/unknown).
      const authGuardMod = getDep('authGuard');
      const isBlank = authGuardMod?.peekBlankPageFlag?.(page);
      if (isBlank) {
        // v14 FIX: Defense-in-depth — verify the page is ACTUALLY blank right now.
        // The auth-guard sets the flag during a pre-refresh blank check, but
        // refreshSession may have loaded content since then, making the flag
        // stale. Verify with a fresh pixel check before escalating.
        let actuallyBlank = true;
        try {
          if (typeof authGuardMod?._isPageBlank === 'function') {
            actuallyBlank = await authGuardMod._isPageBlank(page);
          }
        } catch { /* non-critical — if check fails, trust the flag */ }
        // Consume the flag regardless (prevent re-processing)
        authGuardMod?.consumeBlankPageFlag?.(page);
        if (!actuallyBlank) {
          log('Auth guard blank flag was STALE — page now has content. Skipping escalation.', 'WARN', 'cycle');
        } else {
          blankPageCounter++;
          log(`Auth guard flagged blank page (escalation step ${blankPageCounter})`, 'WARN', 'cycle');
          if (blankPageCounter >= BLANK_SELF_HEAL_THRESHOLD) {
            // Step 3: Trigger full self-heal — something is fundamentally broken
            // v12: If the page is blank this many times, the AIs can figure it out.
            log(`Blank-page escalation: ${blankPageCounter} consecutive blanks — triggering full self-heal (AI investigation)`, 'ERROR', 'cycle');
            blankPageCounter = 0;
            try {
              const selfHealMod = getDep('selfHeal');
              if (selfHealMod?.performSelfHeal && CONFIG.SELF_HEAL_ENABLED && !selfHealRunning) {
                // v14: Reset circuit breaker — blank-page escalation is an emergency.
                // The breaker may be OPEN from a previous failed heal, which would
                // silently return false without executing any healing.
                try { require('./self-heal-circuit-breaker').healerCircuitBreaker?.reset?.(); } catch {}
                selfHealRunning = true;
                const healResult = await selfHealMod.performSelfHeal({ skipRuntimeHeal: true });
                selfHealRunning = false;
                log(`Blank-page self-heal result: ${JSON.stringify(healResult?.summary || healResult)?.substring(0, 200)}`, 'INFO', 'cycle');
                // TASK 35: If self-heal FAILED, request human intervention.
                // The bot is truly stuck — no amount of automated recovery will help.
                if (!healResult?.healed && !healResult?.success) {
                  log('Self-heal FAILED — requesting human intervention. Bot will pause.', 'ERROR', 'cycle');
                  (globalThis as any).__humanInterventionRequested = true;
                  (globalThis as any).__humanInterventionReason = `Self-heal failed (blank-page escalation step ${blankPageCounter})`;
                  (globalThis as any).__humanInterventionSince = Date.now();
                  try {
                    const alerting = getDep('alerting');
                    alerting?.sendAlert?.('Human intervention required: Self-heal failed. Bot paused. Use dashboard /api/intervention/resume when fixed.');
                  } catch {}
                }
              } else {
                log('Blank-page self-heal: not available or already running', 'WARN', 'cycle');
              }
            } catch (healErr: any) {
              selfHealRunning = false;
              log(`Blank-page self-heal failed: ${healErr.message || healErr}`, 'ERROR', 'cycle');
            }
            // Also restart browser as immediate recovery
            try {
              _trackBrowserRestart();
              await closeBrowser?.();
              _networkSetup = false;
              page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
              if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
                await network.setupInterception(page);
                _networkSetup = true;
              }
              await page.goto(_getRecoveryUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
              await new Promise(r => setTimeout(r, 8000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch (restartErr: any) {
              log(`Blank-page self-heal restart failed: ${restartErr.message || restartErr}`, 'ERROR', 'cycle');
              try {
                _networkSetup = false;
                page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
                if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
                  await network.setupInterception(page);
                  _networkSetup = true;
                }
              } catch (recoveryErr: any) {
                log(`Blank-page self-heal recovery also failed: ${recoveryErr.message || recoveryErr} — will break cycle`, 'ERROR', 'cycle');
                break;
              }
            }
            lastScreenshotChangeTime = Date.now();
            continue;
          } else if (blankPageCounter >= BLANK_RESTART_THRESHOLD) {
            // Step 2: Restart browser context entirely
            log(`Blank-page escalation: ${blankPageCounter} consecutive blanks — RESTARTING browser context (total recovery attempts: ${totalBlankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS})`, 'ERROR', 'cycle');
            // v12 FIX: Do NOT reset blankPageCounter here.
            // The counter only resets when the page is confirmed non-blank.
            // This ensures repeated restarts eventually escalate to self-heal.
            try {
              _trackBrowserRestart();
              await closeBrowser?.();
              _networkSetup = false;
              page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
              if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
                await network.setupInterception(page);
                _networkSetup = true;
              }
              await page.goto(_getRecoveryUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
              await new Promise(r => setTimeout(r, 8000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch (restartErr: any) {
              log(`Blank-page browser restart failed: ${restartErr.message || restartErr}`, 'ERROR', 'cycle');
              // Browser is dead — attempt recovery via withBrowserRetry before next cycle
              try {
                _networkSetup = false;
                page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
                if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
                  await network.setupInterception(page);
                  _networkSetup = true;
                }
                log('Blank-page restart: recovery via withBrowserRetry succeeded', 'INFO', 'cycle');
              } catch (recoveryErr: any) {
                log(`Blank-page restart: recovery also failed: ${recoveryErr.message || recoveryErr} — will break cycle`, 'ERROR', 'cycle');
                break;
              }
            }
            lastScreenshotChangeTime = Date.now();
            continue;
          } else if (blankPageCounter >= BLANK_RELOAD_THRESHOLD) {
            // Step 1: Reload MathU
            // BUG FIX (2026-09-08): If a proxy is active and we're hitting blank
            // pages, the proxy is likely silently failing (peer returning 502,
            // DNS failure through the tunnel, etc.). Disable the proxy before
            // reloading — otherwise we just reload through the same broken proxy
            // and get another blank page (which would escalate to restart, then
            // self-heal, burning 5+ minutes before any real recovery).
            try {
              const ipRotator = require('./network-ip-rotator');
              const currentProxy = ipRotator.getCurrentProxy?.();
              if (currentProxy && !(globalThis as any).__proxyDisabled) {
                log(`Blank-page escalation ${blankPageCounter}: proxy was active (${currentProxy}) — DISABLING PROXY before reload.`, 'ERROR', 'cycle');
                try {
                  const alerting = getDep('alerting');
                  // TASK 61: Removed alert — routine event.
                } catch {}
                // BUG FIX (2026-09-09): Use bypassProxy() to FULLY shut down the proxy
                if (typeof ipRotator.bypassProxy === 'function') {
                  ipRotator.bypassProxy(`blank-page escalation step ${blankPageCounter}`);
                } else {
                  (globalThis as any).__proxyDisabled = true;
                }
                // Relaunch browser WITHOUT proxy before reload — `setupContext`
                // reads `__proxyDisabled` at launch time.
                try {
                  _networkSetup = false;
                  const bm = _browserDep?.getBrowserManager?.();
                  if (bm) bm._intentionalClose = true;
                  await closeBrowser?.();
                  await new Promise(r => setTimeout(r, 2000));
                  page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
                  if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
                    try { await network.setupInterception(page); _networkSetup = true; } catch {}
                  }
                } catch (relaunchErr: any) {
                  log(`Browser relaunch during proxy-disable failed: ${relaunchErr?.message || relaunchErr}`, 'WARN', 'cycle');
                }
              }
            } catch { /* ip-rotator not loaded — skip */ }

            log(`Blank-page escalation: ${blankPageCounter} consecutive blanks — reloading MathU (total recovery attempts: ${totalBlankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS})`, 'WARN', 'cycle');
          totalBlankRecoveryAttempts++;
          // TASK 109: Budget check on reload path too
          if (totalBlankRecoveryAttempts >= MAX_BLANK_RECOVERY_ATTEMPTS) {
            log(`Blank-page recovery budget EXHAUSTED on reload step (${totalBlankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS}). Stopping and alerting.`, 'ERROR', 'cycle');
            try { getDep('alerting')?.sendAlert?.(`MathU Bot stuck: ${totalBlankRecoveryAttempts} blank-page recovery attempts failed. Flutter Web app not rendering.`); } catch {}
            (globalThis as any).__humanInterventionRequested = true;
            (globalThis as any).__humanInterventionReason = `Blank-page recovery budget exhausted (${totalBlankRecoveryAttempts} attempts).`;
            break;
          }
            const targetUrl = _getRecoveryUrl();
            if (targetUrl) {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 8000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            }
            lastScreenshotChangeTime = Date.now();
            continue;
          }
          // First blank: fall through to normal blank-page guard below
        }
      } // end if (isBlank) — v14: now wraps verification + escalation ladder
      // BUG FIX (2026-09-06): Removed handleCaptcha AND recordCaptcha calls.
      // The old code called auth.detectCaptcha(page) AND recordCaptcha() on
      // EVERY cycle — recordCaptcha logged "CAPTCHA detected" every ~5 seconds
      // even when there was no captcha. The tribunal (AI) now decides if there's
      // a captcha by looking at the screenshot and setting currentState to "captcha".
      // The captcha loop guard should only fire when the AI actually reports a captcha.
      // if (handleCaptcha) await handleCaptcha(page);
      // authCaptchaLoopGuard?.recordCaptcha?.();
      if (authCaptchaLoopGuard?.isCaptchaLooping?.()) {
        const cooldownMs = authCaptchaLoopGuard.getCaptchaCooldownRemaining?.() || 1800000;
        log(`CAPTCHA loop detected! Cooling off for ${Math.round(cooldownMs / 1000)}s`, 'WARN', 'cycle');
        await new Promise(resolve => setTimeout(resolve, Math.min(cooldownMs, 60000))); // cap wait at 60s per iteration
      }
      if (modalSlayer) await modalSlayer.dismissAnyModal(page);
      if (stabilityWaiter) await stabilityWaiter.waitForStable(page);

      // ── Fast DOM error text check (free, ~5ms) ──
      // Flutter renders to canvas so innerText is usually empty, BUT error
      // dialogs sometimes leak text into overlay divs. This catches those
      // cases without spending an API call on the vision tribunal.
      try {
        const errorText = await page.evaluate(() => {
          const text = (document.body?.innerText || '').toLowerCase();
          const errorPhrases = [
            'something went wrong', 'maintenance mode', 'session expired',
            'error occurred', 'try again later', 'service unavailable',
            'please try closing the app',
          ];
          for (const phrase of errorPhrases) {
            if (text.includes(phrase)) return phrase;
          }
          return null;
        });
        if (errorText) {
          const targetUrl = _getRecoveryUrl();
          log(`Fast DOM check: detected app error text "${errorText}" — reloading to recover`, 'WARN', 'cycle');
          if (targetUrl) {
            try {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 8000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch {}
          }
          lastScreenshotChangeTime = Date.now();
          lastProgressTime = Date.now();
          continue;
        }
      } catch { /* evaluate may fail — not an error, proceed */ }

      // ── Blank-page guard ──
      // Flutter apps can report "stabilized" with height=0 (canvas not yet painted).
      // If we screenshot a blank page, every AI provider will fail to see anything.
      // Detect blank pages by checking document height and retry with backoff.
      {
        const MAX_BLANK_RETRIES = 4;
        const BLANK_RETRY_BASE_MS = 2000;
        let isBlank = false;
        try {
          const pageHeight = await page.evaluate(() => {
            return Math.max(
              document.body?.scrollHeight || 0,
              document.body?.offsetHeight || 0,
              document.documentElement?.scrollHeight || 0
              // NOTE: do NOT include clientHeight — it returns viewport height,
              // not content height. See fresh-start check above for details.
            );
          });
          isBlank = pageHeight === 0;
        } catch { /* evaluate may fail on some pages — not blank, proceed */ }

        if (isBlank) {
          log('Blank-page guard: page height=0 after stability wait — retrying with backoff', 'WARN', 'cycle');
          for (let retry = 0; retry < MAX_BLANK_RETRIES; retry++) {
            const waitMs = BLANK_RETRY_BASE_MS * (retry + 1); // 2s, 4s, 6s, 8s
            log(`Blank-page retry ${retry + 1}/${MAX_BLANK_RETRIES}: waiting ${waitMs}ms`, 'DEBUG', 'cycle');
            await new Promise(r => setTimeout(r, waitMs));

            // Check height again
            try {
              const h = await page.evaluate(() => {
                return Math.max(
                  document.body?.scrollHeight || 0,
                  document.body?.offsetHeight || 0,
                  document.documentElement?.scrollHeight || 0
                );
              });
              if (h > 0) {
                log(`Blank-page guard: page height recovered to ${h}px after ${waitMs}ms`, 'INFO', 'cycle');
                isBlank = false;
                break;
              }
            } catch { break; /* evaluate failed — something is there */ }
          }

          // If still blank after retries, try a page reload
          if (isBlank) {
            log('Blank-page guard: still blank after retries — reloading page', 'WARN', 'cycle');
            try {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
              // Wait extra for Flutter to render after reload
              await new Promise(r => setTimeout(r, 5000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch (reloadErr: any) {
              log(`Blank-page guard: reload failed: ${reloadErr.message || reloadErr}`, 'WARN', 'cycle');
            }
          }
        }
      }

      // v14: NEVER take a screenshot of a blank page. Wait for CanvasKit to render
      // before capturing. This is the universal chokepoint — every cycle path
      // flows through here before the tribunal sees the screenshot.
      // Dead-page detection removed — was causing false positives that
      // killed working browsers on 512MB. The screenshot try/catch below
      // already handles "Target page, context or browser has been closed".
      await _waitForRenderedPage(page, 12000);

      const beforeUrl = page.url();
      let screenshot: any;
      try {
        // BUG FIX (2026-09-04): Lowered quality from 20 to 15 to reduce heap pressure.
        // Each screenshot is a base64 string in memory (~50KB at quality 20, ~30KB at 15).
        // Over 60+ cycles, the accumulated transient allocations push heap past the limit.
        //
        // BUG FIX (2026-09-08): Explicit 10s timeout (default 30s).
        // Playwright waits for `document.fonts.ready` before capturing — through
        // a slow / blocked proxy, @font-face fetches can hang for the full 30s.
        // Fail fast so we can retry / recover instead of crashing the cycle.
        // `animations: 'disabled'` skips animation-completion wait too.
        screenshot = await page.screenshot({ type: 'jpeg', quality: 15, timeout: 10000, animations: 'disabled' });
      } catch (ssErr: any) {
        const ssMsg = ssErr?.message || String(ssErr);
        if (ssMsg.includes('closed') || ssMsg.includes('Closed')) {
          log('Screenshot failed — page closed. Re-launching browser.', 'WARN', 'cycle');
          page = await _relaunchBrowser();
          continue;
        }
        // BUG FIX (2026-09-08): Screenshot timeout (fonts stuck via proxy, or
        // render hang). Multi-stage recovery so we don't crash the cycle:
        //   Stage 1: Pre-warm document.fonts.ready with a 3s race, then retry
        //            screenshot with a short 5s timeout.
        //   Stage 2: Reload the page once (clean DOM state), wait, retry once
        //            more with 8s timeout.
        //   Stage 3: Skip the cycle (continue main loop) instead of throwing —
        //            the next cycle will try again from a fresh state.
        const isTimeout = ssErr?.name === 'TimeoutError'
          || /Timeout \d+ms exceeded/i.test(ssMsg)
          || /timeout/i.test(ssMsg);
        if (!isTimeout) throw ssErr;

        log('Screenshot timed out (fonts/render hang). Recovering...', 'WARN', 'cycle');

        // Helper: CDP screenshot that bypasses Playwright's document.fonts.ready wait.
        // Playwright's page.screenshot() ALWAYS waits for fonts to load before
        // capturing — when a @font-face URL hangs through a proxy, every retry
        // also times out. CDP's Page.captureScreenshot does NOT wait for fonts.
        const _cdpScreenshot = async (pg: any, timeoutMs: number = 5000): Promise<Buffer | null> => {
          try {
            const client = await pg.context().newCDPSession(pg);
            const result = await Promise.race([
              client.send('Page.captureScreenshot', { format: 'jpeg', quality: 15 }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('CDP screenshot timeout')), timeoutMs)),
            ]) as any;
            try { await client.detach(); } catch {}
            if (result?.data) {
              return Buffer.from(result.data, 'base64');
            }
            return null;
          } catch { return null; }
        };

        // Stage 1: pre-warm fonts + retry via CDP (bypasses font wait)
        try {
          await Promise.race([
            page.evaluate(() => (document as any).fonts?.ready ?? Promise.resolve()),
            new Promise(r => setTimeout(r, 3000)),
          ]);
        } catch { /* fonts API missing — ignore */ }
        let recovered = false;
        try {
          const _cdpShot = await _cdpScreenshot(page, 5000);
          if (_cdpShot && _cdpShot.length > 0) {
            screenshot = _cdpShot;
            log(`Screenshot recovered on stage-1 CDP retry (${screenshot.length} bytes)`, 'INFO', 'cycle');
            recovered = true;
          }
        } catch (retry1Err: any) {
          log(`Stage-1 CDP retry failed: ${retry1Err?.message || retry1Err}`, 'WARN', 'cycle');
        }

        // Stage 2: reload page once and retry via CDP (bypasses font wait)
        if (!recovered) {
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
            await _waitForRenderedPage(page, 8000);
          } catch (reloadErr: any) {
            log(`Page reload during screenshot recovery failed: ${reloadErr?.message || reloadErr}`, 'WARN', 'cycle');
          }
          try {
            const _cdpShot = await _cdpScreenshot(page, 8000);
            if (_cdpShot && _cdpShot.length > 0) {
              screenshot = _cdpShot;
              log(`Screenshot recovered on stage-2 CDP retry (${screenshot.length} bytes)`, 'INFO', 'cycle');
              recovered = true;
            }
          } catch (retry2Err: any) {
            log(`Stage-2 CDP retry failed: ${retry2Err?.message || retry2Err}`, 'WARN', 'cycle');
          }
        }

        // Stage 3: skip cycle (don't crash)
        if (!recovered) {
          log('Screenshot failed 3× — skipping cycle with 15s wait. Next cycle will retry from fresh state.', 'WARN', 'cycle');
          // Clear stale screenshot from dashboard so user sees we're not stuck
          try {
            const setShot = (globalThis as any).__setLatestScreenshot;
            if (setShot) setShot('', 'screenshot-timeout-recovery');
          } catch { /* non-critical */ }
          await new Promise(r => setTimeout(r, 15000));
          continue;
        }
      }

      // ── Screenshot validity check ──
      // A valid screenshot of a rendered page should be >3KB even at quality:20.
      // If it's tiny, the page is likely blank (white rectangle).
      if (screenshot.length < 3000) {
        log(`Screenshot suspiciously small (${screenshot.length} bytes) — page may be blank. Waiting 3s and retaking...`, 'WARN', 'cycle');
        await new Promise(r => setTimeout(r, 3000));
        try {
          const retryShot = await page.screenshot({ type: 'jpeg', quality: 15, timeout: 8000, animations: 'disabled' });
          if (retryShot.length > screenshot.length) {
            log(`Retry screenshot is ${retryShot.length} bytes (was ${screenshot.length}) — using retry`, 'INFO', 'cycle');
            screenshot = retryShot;
          }
        } catch { /* retry failed — proceed with original */ }
      }

      let base64 = screenshot.toString('base64');
      // Feed screenshot to dashboard cache (non-blocking)

      // ─── Cloudinary: DISABLED — burns ~100MB/month bandwidth on Render
      // free tier (5GB limit). Screenshots are only useful for the dashboard;
      // they don't contribute to OOM survival. Re-enable by setting env
      // SCREENSHOT_STORAGE_ENABLED=true if you have bandwidth to spare.
      // try {
      //   const screenshotStorage = require('./screenshot-storage');
      //   if (screenshotStorage?.isEnabled?.() && screenshotStorage?.uploadScreenshot) {
      //     screenshotStorage.uploadScreenshot(screenshot, 'cycle', {
      //       state: currentState || 'unknown',
      //       cycle: String(getStats().cycleCount || 0),
      //     }).catch(() => {});
      //   }
      // } catch (uploadErr: any) {
      //   log(`Screenshot Cloudinary upload failed (non-critical): ${uploadErr.message || uploadErr}`, 'DEBUG', 'cycle');
      // }
      try {
        const setShot = (globalThis as any).__setLatestScreenshot;
        if (setShot) {
          setShot(base64, null); // action set after tribunal
        }
      } catch { /* non-critical */ }
      const screenshotHash = crypto.createHash('md5').update(screenshot).digest('hex');
      // Track screenshot changes for stagnation detection
      if (previousScreenshotHash && screenshotHash !== previousScreenshotHash) {
        lastScreenshotChangeTime = Date.now();
      }
      previousScreenshotHash = screenshotHash;

      // Check policy (existing policyEngine)
      if (policyEngine) {
        const urlCheck = policyEngine.checkUrl(beforeUrl);
        if (!urlCheck.allowed) { log(`Policy blocked action: ${urlCheck.reason}`, 'WARN', 'cycle'); break; }
      }
      // Resilience: state guard transition validation
      if (policyStateGuard && currentState) {
        const stateCheck = policyStateGuard.validateTransition(currentState, beforeUrl);
        if (stateCheck && !stateCheck.allowed) {
          log(`State guard blocked transition: ${stateCheck.reason}`, 'WARN', 'cycle');
        }
      }
      // Resilience: circular path detection (SPA-aware)
      if (progressCircularPathDetector) {
        // On SPA domains, URL never changes — use state+hash visual loop detection.
        // On non-SPA domains, use traditional URL-based detection.
        const spaDomains = (CONFIG.MATHU_SPA_DOMAINS || 'app.mathu.co.za,mathu.co.za').split(',').map((d: string) => d.trim());
        const isSpa = spaDomains.some((d: string) => beforeUrl.includes(d));
        let loopCheck;
        if (isSpa && currentState) {
          loopCheck = progressCircularPathDetector.checkStateLoop(currentState, screenshotHash);
          if (loopCheck?.isLooping) {
            log(`SPA visual loop detected! State "${currentState}" hash "${screenshotHash.substring(0, 8)}" repeated ${loopCheck.loopCount} times. ${loopCheck.suggestion}`, 'WARN', 'cycle');
            // TASK 105 (2026-10-03): On a BLANK page, scrolling doesn't help.
            // The page is blank because Flutter hasn't rendered yet (CanvasKit
            // initialization takes 10-30s on Render free tier). Scrolling a
            // blank page does nothing — the bot just loops back to the same
            // blank state, re-detects the loop, and scrolls again forever.
            //
            // Instead: check if the page is blank. If so, WAIT for Flutter
            // to render (up to 30s). Only scroll if the page has content.
            const authGuard = getDep('authGuard');
            const isBlank = authGuard?._isPageBlank ? await authGuard._isPageBlank(page).catch(() => false) : false;
            if (isBlank) {
              log(`SPA loop on blank ${currentState} page — waiting for Flutter to render (up to 30s) instead of scrolling`, 'WARN', 'cycle');
              const renderDeadline = Date.now() + 30000;
              let rendered = false;
              while (Date.now() < renderDeadline) {
                await new Promise(r => setTimeout(r, 3000));
                const stillBlank = authGuard?._isPageBlank ? await authGuard._isPageBlank(page).catch(() => false) : false;
                if (!stillBlank) {
                  rendered = true;
                  log('SPA loop: page rendered after wait — breaking loop', 'INFO', 'cycle');
                  break;
                }
              }
              if (!rendered) {
                log('SPA loop: page still blank after 30s wait — will proceed to tribunal/pixel fallback', 'WARN', 'cycle');
              }
            } else {
              // Page has content — scroll to break the visual stalemate
              try { await page.evaluate(() => window.scrollBy(0, 300)); } catch { /* non-critical */ }
              await new Promise(r => setTimeout(r, 2000));
            }
          }
        } else {
          loopCheck = progressCircularPathDetector.checkUrlLoop(beforeUrl);
          if (loopCheck?.isLooping) {
            log(`Circular path detected! URL ${beforeUrl} seen ${loopCheck.loopCount} times. Navigating to app URL.`, 'WARN', 'cycle');
            // BUG FIX (2026-09-06): Navigate to APP_URL, not 'about:blank'.
            // The old code used CONFIG.BASE_URL || 'about:blank' — when BASE_URL
            // was empty, it navigated to about:blank, which caused a death loop:
            // about:blank → tribunal sees blank → error/wait → circular path
            // detected on about:blank → navigate to about:blank → repeat.
            const recoveryUrl = _getRecoveryUrl();
            await page.goto(recoveryUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          }
        }
      }

      let action = null;

      // Flutter Semantics path
      if (CONFIG.ENABLE_FLUTTER_SEMANTICS && semantics && dpr) {
        const interactiveItems = await semantics.getInteractiveItems(page);
        if (interactiveItems.length > 0) {
          const watch = semantics.findElementFuzzy('watch', interactiveItems);
          if (watch && !watch.disabled) {
            const coords = dpr.getJitteredClick(watch.centerX, watch.centerY);
            action = { actionType: 'click', targetX: coords.x, targetY: coords.y, currentState: 'assignments_page', reasoning: 'Found via Flutter Semantics' };
            log('Flutter Semantics found "Watch" button.', 'INFO', 'cycle');
          } else {
            const start = semantics.findElementFuzzy('start', interactiveItems);
            if (start && !start.disabled) {
              const coords = dpr.getJitteredClick(start.centerX, start.centerY);
              action = { actionType: 'click', targetX: coords.x, targetY: coords.y, currentState: 'assignments_page', reasoning: 'Found via Flutter Semantics' };
              log('Flutter Semantics found "Start" button.', 'INFO', 'cycle');
            }
          }
        }
      }

      // Plugin actions
      if (!action && pluginAPI?.actions) {
        for (const [name, handler] of pluginAPI.actions) {
          try {
            const result = await handler(page, base64, beforeUrl);
            if (result) { action = result; log(`Plugin action ${name} provided result`, 'DEBUG', 'cycle'); break; }
          } catch (err: any) { logError(`Plugin action ${name} failed`, err); }
        }
      }

      // Resilience: quota throttle check before tribunal
      if (economyQuotaRations?.isEconomyMode?.()) {
        log('Economy mode active — reducing tribunal calls', 'INFO', 'cycle');
      }

      // TASK 106 (2026-10-03): Skip tribunal on blank pages.
      // The user correctly identified: "If the page was blank when we called
      // the tribunal, we should have sensed it at SOME POINT. We are constantly
      // checking the pixel colours and the AIs themselves report if the page
      // is blank. One might be wrong but I doubt it's both at the same time
      // consistently. The issue must be something else."
      //
      // The issue IS that both the pixel check AND the AI are detecting blank,
      // but the bot STILL calls the tribunal and executes the AI's action.
      // The AI (Groq) hallucinates "mathu_login / click" on a blank screenshot
      // — it should say "blank_page" but doesn't. So the bot clicks on
      // invisible buttons, which triggers the login flow, which returns to
      // a blank page, and the cycle repeats forever.
      //
      // Fix: After taking the screenshot, check if the page is visually blank.
      // If so, set currentState = 'blank_page' and SKIP the tribunal entirely.
      // The blank-page escalation ladder (reload → restart → self-heal) will
      // handle recovery. Don't waste API calls on blank screenshots.
      if (base64 && base64.length > 100) {
        const authGuardMod = getDep('authGuard');
        if (authGuardMod?._isPageBlank) {
          const isBlank = await authGuardMod._isPageBlank(page).catch(() => false);
          if (isBlank) {
            log('Page is visually blank — SKIPPING tribunal (not calling AI on a blank screenshot). Setting state to blank_page for escalation.', 'WARN', 'cycle');
            currentState = 'blank_page';
            action = { actionType: 'wait', currentState: 'blank_page', targetX: 0, targetY: 0, reasoning: 'Page is visually blank — skipping tribunal call' };
            // Skip to blank_page escalation
            blankPageCounter++;
            unknownStateCounter = 0;
            log(`blank_page state detected (${blankPageCounter} consecutive). Escalating...`, 'WARN', 'cycle');
            // Fall through to blank_page handling below (don't call tribunal)
          }
        }
      }

      // ─── Action Cache Lookup ───
      // Before calling the tribunal (expensive AI call), check if we have
      // a cached action for this exact visual context. If hit, skip the AI
      // call entirely and use the saved action.
      // EXCLUSION: Only skip cache for hard blank_page state.
      // Near-blank screenshots, Flutter DOM checks, and blankPageCounter
      // were removed in v12 — they over-excluded and starved the cache.
      // The coarse 12×32 fingerprint now handles animation jitter,
      // and the 3-failure eviction handles stale entries.
      let _actionCacheSig: string | null = null;
      let _actionCacheHit = false;
      const actionCache = _getActionCache();
      // TASK 56 (2026-09-11): Ban cache for states that require the AI to
      // READ the page content and generate the correct answer. On these states,
      // each question is different — a cached click from a previous question
      // would click the wrong answer. The AI MUST see the page every time.
      //
      // TASK 57 (2026-09-11): Partially relax the ban. After the AI has chosen
      // an answer, the NEXT action is usually "click Next" or "click the book
      // icon" — these are always at the same position regardless of the question.
      // So we allow the cache for non-answer actions (click, flutter_tap, scroll,
      // navigate) on these states, but BAN it for answer-type actions
      // (keypad_input, input_email, input_password, type_text) which would
      // be the actual answer to a different question.
      // (CACHE_BANNED_STATES and ANSWER_ACTIONS are defined at module scope — see lines 108-126)
      const _isCacheExcluded = CACHE_BANNED_STATES.has(currentState || '');
      // TASK 58 (2026-09-11): On question states, only allow cache AFTER the AI
      // has submitted an answer (clicked a choice). Before that, the AI must
      // read the question and choose the right answer — no cache.
      // After the AI clicks (answer submitted), the next action is likely
      // "click Next" or "click book icon" — these CAN be cached.
      //
      // TASK 59 (2026-09-11): The AI can also set "repeatable": true on the
      // action itself. If the AI says the action is repeatable (e.g., clicking
      // "Next" button — always in the same position), allow cache even BEFORE
      // an answer is submitted. The AI has explicitly said this action doesn't
      // require reading the page content.
      const _isCacheLookupAllowed = !_isCacheExcluded
        || (_answerSubmitted && _answerSubmittedState === currentState)
        || (action?.repeatable === true);
      // Clear _answerSubmitted if the state changed (moved to a new question or different page)
      if (_answerSubmitted && _answerSubmittedState !== currentState) {
        _answerSubmitted = false;
        _answerSubmittedState = null;
      }
      // TASK 55 (2026-09-11): Don't exclude cache for error/unknown states.
      // Even if the tribunal returned 'error' or 'unknown' on the previous cycle,
      // the visual page is still the same — the cache key should match.
      // The state in the signature is just for grouping — the visual fingerprint
      // is what determines if the page is the same. Use the current URL-based
      // state if available, otherwise fall back to currentState.
      if (!action && actionCache && _isCacheLookupAllowed) {
        try {
          // Compute context signature from current state + screenshot
          // TASK 55: Use 'unknown' as the state if currentState is null/empty —
          // this ensures the signature is still computed (the visual fingerprint
          // is the primary key, the state is just for grouping/query optimization).
          const cacheState = currentState || 'unknown';
          _actionCacheSig = actionCache.computeContextSignature(cacheState, base64);
          if (_actionCacheSig) {
            // Cold start (post-OOM): local action_cache is empty — use async
            // lookup which AWAITS the Turso read instead of fire-and-forget.
            // This lets us immediately reuse actions persisted before the kill.
            const useAsync = _isLocalCacheEmpty();
            const cachedAction = useAsync
              ? await actionCache.lookupAsync(_actionCacheSig, base64)
              : actionCache.lookup(_actionCacheSig, base64);
            // After a successful async populate, mark local as no longer empty
            // so subsequent cycles use the fast sync path
            if (cachedAction && useAsync) { _localCacheEmpty = false; }
            if (cachedAction) {
              // TASK 57 (2026-09-11): On banned states, reject cached answer-type actions.
              // The AI must read each question — a cached keypad_input from a previous
              // question would enter the wrong answer. But click/flutter_tap (Next button,
              // book icon, scroll) are safe to cache because their position doesn't change.
              if (_isCacheExcluded && ANSWER_ACTIONS.has(cachedAction.actionType)) {
                log(`Action cache HIT but REJECTED (answer action on banned state): type=${cachedAction.actionType} state=${cachedAction.currentState} — AI must read this question.`, 'DEBUG', 'cycle');
                action = null;
                _actionCacheHit = false;
                updateStats({ actionCacheMisses: (getStats().actionCacheMisses || 0) + 1 });
              } else {
                action = cachedAction;
                _actionCacheHit = true;
                const source = useAsync ? 'turso-cold' : 'local';
                log(`Action cache HIT (${source}): type=${cachedAction.actionType} at (${cachedAction.targetX.toFixed(2)}, ${cachedAction.targetY.toFixed(2)}) state=${cachedAction.currentState}`, 'INFO', 'cycle');
                updateStats({ actionCacheHits: (getStats().actionCacheHits || 0) + 1 });
              }
            } else {
              updateStats({ actionCacheMisses: (getStats().actionCacheMisses || 0) + 1 });
            }
          }
        } catch (cacheErr: any) {
          log(`Action cache lookup error: ${cacheErr.message || cacheErr}`, 'DEBUG', 'cycle');
        }
      }

      // Vision tribunal
      if (!action) {
        // Pixel-only mode: skip AI providers entirely, go straight to fallback chain
        if (options?.pixelOnly) {
          log('Pixel-only mode: skipping tribunal, using fallback chain directly', 'INFO', 'cycle');
          try {
            action = await getFallbackAction(page, currentState || undefined);
            if (action && action.actionType && action.actionType !== 'wait') {
              log(`Pixel-only fallback: ${action.actionType} at (${action.targetX}, ${action.targetY})`, 'INFO', 'cycle');
            }
            // v15: Save pixel-only fallback actions to cache too
            if (action) await _saveActionToCache(action, currentState, base64, actionCache, _actionCacheSig, _isCacheExcluded, log);
          } catch (fbErr: any) {
            log(`Pixel-only fallback failed: ${fbErr.message || fbErr}`, 'WARN', 'cycle');
          }
        } else {
          try {
            // Call determineNextAction directly — it has its own internal safeCall
            // timeout (120s) wrapping runTribunal. Adding another safeCall here
            // created a triple-nested timeout race where the outer one fired ~10ms
            // before the inner, aborting the tribunal right as it computed consensus
            // and orphaning a valid result in favor of pixel-fallback.
            if (!determineNextAction) {
              log('determineNextAction not available — using fallback action', 'WARN', 'cycle');
              action = await getFallbackAction(page, currentState || undefined);
            } else {
              action = await determineNextAction(base64, page.url(), explorationMode ? explorationMap : null);
            }

            // TASK 89 (2026-09-25): Force GC after tribunal — the tribunal call
            // allocates 7 parallel provider responses (~700KB total). If we don't
            // GC here, that transient memory stays allocated during action
            // execution and cache write, which can push past the hard restart
            // threshold on the assignments page where base heap is already high.
            if (global.gc) {
              try { global.gc(); } catch {}
            }

            // ── Eager action cache write (pre-execution) ──────────────────
            // Persist to Turso IMMEDIATELY after tribunal decides.
            // If OOM kills before execution, this survives. If the action
            // later fails, recordFailure evicts after 3 strikes.
            // v15: Uses centralized _saveActionToCache helper.
            await _saveActionToCache(action, currentState, base64, actionCache, _actionCacheSig, _isCacheExcluded, log);

            // If tribunal internally failed and returned a wait/error fallback, try pixel fallback
            // BUG FIX (2026-09-04): The old check only matched the literal string
            // "tribunal failure" — which is the text produced when runTribunal()
            // THROWS an exception (caught by determineNextAction's safeCall).
            // But when the vision pipeline exhausts its own fallback chain
            // (Pix2Tex → Local VLM → error-wait), the error-wait reasoning is
            // "All vision providers and fallbacks failed" — NOT "tribunal failure".
            // That error-wait flows through the tribunal as a normal provider
            // response, reaches consensus, and gets its reasoning prefixed with
            // "Tribunal (3/3 models, 100% agreement): ..." — which still doesn't
            // include "tribunal failure". So pixel-fallback was NEVER called.
            //
            // Fix: detect ANY wait-on-error action from the tribunal, regardless
            // of the exact reasoning text. This is safe because pixel-fallback
            // either returns a real action or returns its own wait — so there's
            // no downside to always trying it when the tribunal returns an error.
            const isTribunalErrorWait = action?.actionType === 'wait' &&
              (action?.currentState === 'error' || action?.currentState === 'unknown') &&
              (
                // Old check: literal "tribunal failure" text (thrown by determineNextAction's catch)
                action?.reasoning?.includes('tribunal failure') ||
                // Vision pipeline exhausted all fallbacks
                action?.reasoning?.includes('All vision providers and fallbacks failed') ||
                action?.reasoning?.includes('All vision fallbacks exhausted') ||
                // Tribunal found no valid model responses
                action?.reasoning?.includes('No valid responses from any provider') ||
                action?.reasoning?.includes('No providers') ||
                // Generic fallback-error from vision pipeline (provider: 'fallback-error')
                action?.provider === 'fallback-error' ||
                // BUG FIX (2026-09-08): If ALL providers failed (0 success), the
                // tribunal returns "Tribunal success: 0/N (0%)" but still returns
                // a wait action. Catch this case too — any wait action from the
                // tribunal when we know providers are failing should trigger pixel fallback.
                action?.reasoning?.includes('Fallback due to tribunal failure') ||
                action?.reasoning?.includes('0/0') ||
                action?.reasoning?.includes('0%')
              );
            // BUG FIX (2026-09-08): Also catch the case where determineNextAction
            // catches a tribunal exception and returns a generic error-wait.
            // The reasoning is "Fallback due to tribunal failure" — but we also
            // need to catch when ALL providers failed (the tribunal may return
            // success with 0 valid responses, or the vision pipeline may have
            // been called separately and logged "All vision fallbacks exhausted"
            // even though the tribunal itself returned a different reasoning).
            // Simplest fix: if the action is wait+error/unknown AND no pixel
            // fallback has been tried yet this cycle, try it.
            const _shouldTryPixelFallback = isTribunalErrorWait ||
              (action?.actionType === 'wait' &&
               (action?.currentState === 'error' || action?.currentState === 'unknown') &&
               !action?._pixelFallbackTried) ||
              // TASK 68: Also try pixel fallback when tribunal says "wait" on
              // non-login states (loading, exploration, assignments_page, etc.)
              // — the provider might have been rate-limited and returned a guess.
              (action?.actionType === 'wait' &&
               action?.currentState !== 'mathu_login' &&
               action?.currentState !== 'microsoft_email_input' &&
               action?.currentState !== 'captcha' &&
               action?.currentState !== 'human_intervention' &&
               !action?._pixelFallbackTried);

            // ─────────────────────────────────────────────────────────────────
            // TASK 39 (2026-09-09): Track "no providers" duration.
            // If the tribunal returns "No providers" or "No valid responses",
            // start (or continue) the no-providers timer. If it's been 30+
            // minutes, trigger a 3-hour pause (checked at top of cycle loop).
            //
            // TASK 69 (2026-09-22): The tribunal now triggers the instant
            // parallel→sequential switch ITSELF (in its `valid.length === 0`
            // block) before returning. We ALSO call `triggerSequentialMode()`
            // here as a defensive safety net — in case the tribunal's DB write
            // failed or the action was synthesized by the vision pipeline
            // (which calls runTribunal but may not pass through the same
            // `valid.length === 0` code path on every exception branch).
            // Idempotent — safe to call when sequential mode is already active.
            // ─────────────────────────────────────────────────────────────────
            if (action?.reasoning?.includes('No providers') ||
                action?.reasoning?.includes('No valid responses from any provider') ||
                action?.reasoning?.includes('0/0')) {
              if (!_noProvidersSince) {
                _noProvidersSince = Date.now();
                log(`No providers detected — starting 30-min timer. If providers don't recover, bot will pause for 3h.`, 'WARN', 'cycle');
              }
              // TASK 69: Defensive instant-switch (tribunal already triggers
              // this internally, but call again here in case the tribunal's
              // DB write failed or the action came from a different code path).
              try {
                const tribunal = require('./providers-tribunal');
                if (typeof tribunal.triggerSequentialMode === 'function') {
                  tribunal.triggerSequentialMode('cycle-manager: no-providers reasoning detected');
                }
              } catch {}
              const _elapsed = Date.now() - _noProvidersSince;
              if (_elapsed >= NO_PROVIDERS_THRESHOLD_MS && !_noProvidersPauseUntil) {
                _noProvidersPauseUntil = Date.now() + NO_PROVIDERS_PAUSE_MS;
                // Expose via globals for dashboard /api/health
                (globalThis as any).__noProvidersSince = _noProvidersSince;
                (globalThis as any).__noProvidersPauseUntil = _noProvidersPauseUntil;
                log(`No providers for ${Math.round(_elapsed / 60000)} min — triggering 3h pause. Bot will not touch the browser until ${new Date(_noProvidersPauseUntil).toISOString()}.`, 'ERROR', 'cycle');
                // TASK 54 (2026-09-11): Persist sequential mode flag in DB.
                // This survives restarts — the tribunal will use sequential
                // single-provider mode to conserve free-tier API quota.
                try {
                  const dbMod = require('./database');
                  dbMod.upsertCalibration?.run('sequential_provider_mode', 'true', Date.now());
                  log('Sequential provider mode ENABLED — will use one provider at a time to conserve quota.', 'WARN', 'cycle');
                } catch {}
                try {
                  const alerting = getDep('alerting');
                  // TASK 61: Removed alert — routine event when quotas exhaust.
                } catch {}
              }
            } else {
              // Providers recovered — reset the timer
              if (_noProvidersSince) {
                log('Providers recovered — clearing no-providers timer.', 'INFO', 'cycle');
                _noProvidersSince = null;
                _noProvidersPauseUntil = null;
                (globalThis as any).__noProvidersSince = null;
                (globalThis as any).__noProvidersPauseUntil = null;
                // TASK 54: Clear sequential mode — providers recovered, go back to parallel
                try {
                  const dbMod = require('./database');
                  dbMod.upsertCalibration?.run('sequential_provider_mode', 'false', Date.now());
                  log('Sequential provider mode DISABLED — providers recovered, returning to parallel mode.', 'INFO', 'cycle');
                } catch {}
              }
            }

            if (_shouldTryPixelFallback) {
              if (!isTribunalErrorWait) {
                log(`Tribunal returned wait+error/unknown (reasoning: ${action?.reasoning?.substring(0, 100)}). Trying pixel fallback as safety net.`, 'WARN', 'cycle');
              } else {
                logError(`Tribunal/vision returned error-wait, trying pixel fallback. reasoning=${action?.reasoning || 'unknown'}`, new Error(action?.reasoning || ''));
              }
            // v14: Feed tribunal failure to self-heal error buffer
            try { (getDep('selfHeal') || require('./self-heal'))?.pushSelfHealError?.(`tribunal fallback wait: ${action.reasoning || 'unknown'}`, 'tribunal'); } catch {}
              action = await getFallbackAction(page, currentState || undefined);
              // v15: Save tribunal-failure fallback actions to cache too
              await _saveActionToCache(action, currentState, base64, actionCache, _actionCacheSig, _isCacheExcluded, log);

              // TASK 50 (2026-09-11): If pixel fallback ALSO failed (returned wait/error/null),
              // do a random swipe on the page to preserve the session. This keeps the
              // Flutter app alive (prevents session timeout) while waiting for providers
              // to recover. Better than just waiting — at least we're doing SOMETHING.
              if (!action || action.actionType === 'wait' || action.currentState === 'error' || action.currentState === 'unknown') {
                log('Pixel fallback also failed — doing a random swipe to preserve session while providers recover.', 'INFO', 'cycle');
                try {
                  // Random swipe from a random point to another random point
                  const _swipeStartX = 0.2 + Math.random() * 0.6;
                  const _swipeStartY = 0.3 + Math.random() * 0.4;
                  const _swipeEndX = _swipeStartX + (Math.random() - 0.5) * 0.3;
                  const _swipeEndY = _swipeStartY + (Math.random() - 0.5) * 0.3;
                  action = {
                    actionType: 'flutter_swipe',
                    currentState: currentState || 'unknown',
                    targetX: Math.max(0.05, Math.min(0.95, _swipeStartX)),
                    targetY: Math.max(0.05, Math.min(0.95, _swipeStartY)),
                    targetX2: Math.max(0.05, Math.min(0.95, _swipeEndX)),
                    targetY2: Math.max(0.05, Math.min(0.95, _swipeEndY)),
                    reasoning: 'Session-preservation swipe — all providers and pixel fallback failed. Swiping to keep the Flutter session alive while waiting for providers to recover.',
                  };
                } catch {}
              }
            }
          } catch (err: any) {
            const errMsg = err?.message || String(err);
            // Fast-path: if OR daily limit just got exhausted, enter park immediately
            // instead of burning memory on fallback chains that will also fail
            if (errMsg.includes('OPENROUTER_DAILY_LIMIT') || errMsg.includes('free-models-per-day')) {
              if (await _checkOrPark(log)) {
                await new Promise(r => setTimeout(r, OR_PARK_CHECK_INTERVAL_MS));
                continue;
              }
            }
            logError('Tribunal failed, using fallback', err);
            // v14: Feed tribunal error to self-heal error buffer
            try { (getDep('selfHeal') || require('./self-heal'))?.pushSelfHealError?.(`tribunal exception: ${err?.message || String(err)}`, 'tribunal'); } catch {}
            action = await getFallbackAction(page, currentState || undefined);
            // v15: Save catch-path fallback actions to cache too
            await _saveActionToCache(action, currentState, base64, actionCache, _actionCacheSig, _isCacheExcluded, log);

            // TASK 50 (2026-09-11): If pixel fallback also failed in the catch path,
            // do a random swipe to preserve the session.
            if (!action || action.actionType === 'wait' || action.currentState === 'error' || action.currentState === 'unknown') {
              log('Pixel fallback also failed (catch path) — doing a random swipe to preserve session.', 'INFO', 'cycle');
              const _sx = 0.2 + Math.random() * 0.6;
              const _sy = 0.3 + Math.random() * 0.4;
              action = {
                actionType: 'flutter_swipe',
                currentState: currentState || 'unknown',
                targetX: Math.max(0.05, Math.min(0.95, _sx)),
                targetY: Math.max(0.05, Math.min(0.95, _sy)),
                targetX2: Math.max(0.05, Math.min(0.95, _sx + (Math.random() - 0.5) * 0.3)),
                targetY2: Math.max(0.05, Math.min(0.95, _sy + (Math.random() - 0.5) * 0.3)),
                reasoning: 'Session-preservation swipe (catch path) — tribunal threw exception, pixel fallback also failed.',
              };
            }
          }
        }
      }
      if (!action || !action.actionType) {
        log('Action is null, using fallback wait', 'WARN', 'cycle');
        action = { actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 };
      }

      // NOTE: When tribunal returns 'wait' for unknown/error state, we now RESPECT it.
      // Previously we ran the fallback chain (pixel → visual recovery → CSS selectors)
      // which often produced blind pixel clicks on unknown pages, making things worse.
      // If the tribunal couldn't determine the state, waiting is the safest action.

      // Dashboard: check if action is banned
      try {
        const dbMod = require('./database');
        const isBanned = dbMod.selectBannedAction?.(action.actionType);
        if (isBanned) {
          // If banned action is not 'wait', fall back to 'wait'
          // If 'wait' itself is banned (e.g. stagnation guard), fall back to 'reload'
          const isWaitAlsoBanned = dbMod.selectBannedAction?.('wait');
          if (!isWaitAlsoBanned) {
            log(`Action ${action.actionType} is banned. Forcing wait.`, 'WARN', 'cycle');
            action = { actionType: 'wait', currentState: action.currentState, targetX: 0, targetY: 0, reasoning: `Action ${action.actionType} banned` };
          } else {
            log(`Action ${action.actionType} and wait are both banned. Forcing reload.`, 'WARN', 'cycle');
            action = { actionType: 'reload', currentState: action.currentState, targetX: 0, targetY: 0, reasoning: `All fallbacks banned, using reload` };
          }
        }
      } catch { /* non-critical: DB unavailable */ }

      // Experiment context
      if (strategyVariants) {
        const experiment = strategyVariants.getActiveExperiment?.();
        if (experiment) {
          const jitter = experiment.context?.getJitterPx?.();
          if (jitter && action.targetX !== undefined && action.targetY !== undefined) {
            action.targetX += (Math.random() - 0.5) * jitter / 100;
            action.targetY += (Math.random() - 0.5) * jitter / 100;
          }
        }
      }

      // ─── Module Download Flow Detection (Response 3) ───
      // Before executing, check if this action is a download button click.
      // If so, record the pre-download screenshot hash and set state.
      const isDownloadClick = action.actionType === 'click' &&
        (action.currentState === 'module_downloading' ||
         (action.reasoning && action.reasoning.includes('download')));

      if (isDownloadClick && _moduleDownloadState === 'idle') {
        _moduleDownloadState = 'download_clicked';
        _moduleDownloadStartTime = Date.now();
        _moduleDownloadRetryCount = 0;
        _preDownloadScreenshotHash = screenshotHash;
        log('Module download flow: click detected, entering download_clicked state', 'INFO', 'cycle');
      }

      // Resilience: action validation before execution
      if (policyActionValidator) {
        const validation = policyActionValidator.validateAction(action, action.currentState);
        if (validation && !validation.allowed) {
          log(`Action validator blocked: ${validation.reason}`, 'WARN', 'cycle');
          action = { actionType: 'wait', currentState: action.currentState, targetX: 0, targetY: 0, reasoning: `Blocked by validator: ${validation.reason}` };
        }
      }
      updateStats({ currentState: action.currentState });
      // Update dashboard cache with action info
      try {
        const setShot = (globalThis as any).__setLatestScreenshot;
        if (setShot) {
          setShot(base64, action);
        }
      } catch { /* non-critical */ }

      // UI drift detection (uses base64 — must run before we null it)
      if (uiDrift) {
        const uiDrifted = await uiDrift.detectDrift(action.currentState, base64);
        if (uiDrifted) {
          log('UI Drifted! Entering Discovery Mode.', 'WARN', 'cycle');
          await uiDrift.discoverUI(page);
          await stateMachine.transition(STATES.UI_DISCOVERED);
        }
      }

      // ─── Solution Cache Check (Response 5) ───
      // Before calling LLM, check if we've seen this exact problem before.
      // Exact match → use cached solution directly (saves budget).
      // Similar match → include cached solution as context hint.
      let _cacheHitProblemText = '';
      let _cacheHitHash = '';
      const solutionCache = _getSolutionCache();
      if (solutionCache && action && (action.currentState === 'question' || action.actionType === 'keypad_input' || action.value)) {
        try {
          // Get problem text from page or action reasoning
          let probTextForCache = '';
          try {
            const bodyTextForCache = await page.evaluate(() => document.body?.innerText || '');
            if (bodyTextForCache && bodyTextForCache.length > 20) {
              probTextForCache = bodyTextForCache.substring(0, 2000);
            }
          } catch {}
          if (!probTextForCache && action.reasoning) {
            probTextForCache = action.reasoning;
          }

          if (probTextForCache) {
            const cacheResult = solutionCache.lookup(probTextForCache);
            if (cacheResult.type === 'exact' && cacheResult.solution) {
              const sol = cacheResult.solution;
              log(`Solution cache EXACT HIT — reusing verified solution (type=${sol.problemType}, used ${sol.successCount}x before)`, 'INFO', 'cycle');
              // Attach cached solution to action so downstream can use it
              action._cachedSolution = sol.solution;
              action._cachedSteps = sol.steps;
              action._cacheHit = 'exact';
              _cacheHitProblemText = probTextForCache;
              _cacheHitHash = cacheResult.hash;
              updateStats({ solutionCacheHits: (getStats().solutionCacheHits || 0) + 1 });
            } else if (cacheResult.type === 'similar' && cacheResult.similarSolution) {
              const simSol = cacheResult.similarSolution;
              log(`Solution cache SIMILAR HIT — including as context hint (type=${simSol.problemType})`, 'INFO', 'cycle');
              action._cachedSolutionHint = simSol.solution;
              action._cachedStepsHint = simSol.steps;
              action._cacheHit = 'similar';
              _cacheHitHash = cacheResult.hash;
              updateStats({ solutionCacheSimilarHits: (getStats().solutionCacheSimilarHits || 0) + 1 });
            }
          }
        } catch (cacheErr: any) {
          log(`Solution cache lookup error: ${cacheErr.message || cacheErr}`, 'DEBUG', 'cycle');
        }
      }

      // ─── Problem Classification Pipeline (Response 4) ───
      // Classify the math problem type from available text, and optionally
      // re-OCR with Pix2Tex if the vision model's text quality is poor.
      // This runs before math verification to provide better context.
      const classifier = _getProblemClassifier();
      if (classifier && action && (action.currentState === 'question' || action.actionType === 'keypad_input' || action.value)) {
        try {
          // Get text from the page (a11y snapshot or body text)
          let ocrText = '';
          try {
            const bodyText = await page.evaluate(() => document.body?.innerText || '');
            if (bodyText && bodyText.length > 20) {
              ocrText = bodyText.substring(0, 2000); // Limit to prevent huge prompts
            }
          } catch {}

          // Fallback: use action reasoning as text source
          if (!ocrText && action.reasoning) {
            ocrText = action.reasoning;
          }

          if (ocrText) {
            const classification = classifier.classifyProblem(ocrText);

            // Check if Pix2Tex should re-OCR this image
            const pix2tex = _getPix2tex();
            if (pix2tex && classifier.shouldUsePix2Tex(ocrText, classification.type, false)) {
              const p2tResult = await pix2tex.ocrMath(base64);
              if (p2tResult.text && p2tResult.text.length > 10) {
                log(`Pix2Tex re-OCR: ${p2tResult.text.length} chars (conf=${p2tResult.confidence}%)`, 'INFO', 'cycle');
                // Use Pix2Tex text for re-classification
                const reclassified = classifier.classifyProblem(p2tResult.text);
                // Attach to action for downstream consumers
                action._pix2texText = p2tResult.text;
                action._pix2texLatex = p2tResult.latex;
                action._problemType = reclassified.type;
                action._problemConfidence = reclassified.confidence;
                action._ocrQuality = reclassified.ocrQuality;

                // Record model-type affinity after this attempt
                const providerName = action.provider || 'unknown';
                classifier.recordModelTypeAffinity(reclassified.type, providerName, true); // optimistic, updated later on failure
              }
            } else {
              // No Pix2Tex re-OCR needed — use regex classification
              action._problemType = classification.type;
              action._problemConfidence = classification.confidence;
              action._ocrQuality = classification.ocrQuality;
            }

            if (action._problemType && action._problemType !== 'UNKNOWN') {
              log(`Problem classified: ${action._problemType} (conf=${(action._problemConfidence || 0).toFixed(0)}%, OCR quality=${(action._ocrQuality || 0).toFixed(0)}%)`, 'INFO', 'cycle');
            }
          }
        } catch (classErr: any) {
          // Non-critical: classification failure shouldn't break the cycle
          log(`Problem classification failed: ${classErr.message || classErr}`, 'DEBUG', 'cycle');
        }
      }

      // Math verification: check answer before submitting (Response 1)
      const mathVerify = _getMathVerify();
      if (mathVerify && action && mathVerify.shouldVerify(action.currentState || '')) {
        // For keypad/input actions: verify the typed value
        // For click actions on assessment: verify using text regions from pixel fallback
        let answerValue = action.value || action.keypadSequence?.map((k: any) => k.digit || k.label || '').join('') || '';
        let problemContext = action.reasoning || '';

        // Response 5: For click actions with _textRegions (pixel fallback MCQ),
        // try to construct a verification context from the text region metadata.
        // Note: pixel fallback can't OCR the actual text, but it provides density
        // and position info. The math verifier uses this as supplementary context.
        if (!answerValue && action.actionType === 'click' && action._textRegions) {
          const tr = action._textRegions;
          answerValue = `[choice at index ${action._textRegions._clickedChoiceIndex ?? '?'}]`;
          problemContext += ` [pixel-fallback: question text density=${tr.questionRegion?.density.toFixed(2)}, ` +
            `${tr.choiceRegions.length} choices detected]`;
        }

        if (answerValue && typeof answerValue === 'string' && answerValue.trim().length > 0) {
          try {
            // Use reasoning/action text as problem context, the answer value as proposed answer
            const verifyResult = await mathVerify.verifyAnswer(problemContext, answerValue);
            if (!verifyResult.correct && verifyResult.confidence > 0.7) {
              log(`Math verification FAILED (method=${verifyResult.method}, conf=${verifyResult.confidence.toFixed(2)}): ${verifyResult.explanation}. Skipping submit.`, 'WARN', 'cycle');
              // Skip this action — the answer is likely wrong. Let the next iteration re-analyze.
              action = { actionType: 'wait', currentState: action.currentState, reasoning: `Verification failed: ${verifyResult.explanation}`, targetX: 0, targetY: 0 };
              consecutiveTribunalFailures++;
              updateStats({ mathVerifyFailed: (getStats().mathVerifyFailed || 0) + 1 });
              // Continue to next loop iteration (re-screenshot and retry)
              continue;
            } else if (verifyResult.correct && verifyResult.method !== 'unknown') {
              log(`Math verification PASSED (method=${verifyResult.method}, conf=${verifyResult.confidence.toFixed(2)})`, 'INFO', 'cycle');
              updateStats({ mathVerifyPassed: (getStats().mathVerifyPassed || 0) + 1 });

              // ─── Solution Cache Store (Response 5) ───
              // Store the verified solution for future reuse.
              // If this was a cache hit, record the successful reuse.
              const solCache2 = _getSolutionCache();
              if (solCache2) {
                try {
                  if (_cacheHitHash && _cacheHitProblemText) {
                    // This was a cache hit — record successful reuse
                    solCache2.recordReuseOutcome(_cacheHitHash, true);
                  } else if (problemContext) {
                    // New solution — store it
                    const steps = action.reasoning ? action.reasoning.split(/\n|\./).filter((s: string) => s.trim().length > 10).slice(0, 10) : [];
                    solCache2.store(problemContext, answerValue, steps, {
                      problemType: action._problemType || 'UNKNOWN',
                      modelUsed: action.provider || 'unknown',
                      verified: true,
                    });
                  }
                } catch (storeErr: any) {
                  log(`Solution cache store error: ${storeErr.message || storeErr}`, 'DEBUG', 'cycle');
                }
              }
            }
          } catch (verifyErr: any) {
            log(`Math verification error: ${verifyErr.message || verifyErr}. Proceeding with action.`, 'WARN', 'cycle');
          }
        }
      }

      // Quota bargaining
      if (quotaBargain && typeof quotaBargain.canUseProvider === 'function' && !quotaBargain.canUseProvider('openrouter') && !quotaBargain.canUseProvider('mistral')) {
        log('Quota exhausted. Finding new free models...', 'WARN', 'cycle');
        const newModels = typeof quotaBargain.findNewFreeModels === 'function' ? await quotaBargain.findNewFreeModels() : [];
        if (newModels.length > 0) {
          resetCycleProviderState();
          for (const model of newModels) {
            // Dynamic providers discovered via quota bargaining are registered but skip tribunal
            // (they need actual endpoint configuration before they can participate)
            log(`Discovered model ${model} but needs endpoint configuration`, 'DEBUG', 'cycle');
          }
        }
      }

      const preActionState = currentState;
      const startTime = Date.now();
      let actionSuccess = false;

      // ── EARLY EXIT: blank_page wait → escalate via ladder ──
      // Don't waste 75s executing a 'wait' on a blank page.
      // v12: Instead of always navigating, use the same escalation ladder
      // as the auth-guard blank path. This ensures self-heal triggers after
      // enough consecutive blanks instead of navigating forever.
      // v11: Set currentState = 'blank_page' before continue so the next
      // cycle's action cache exclusion knows the page is blank. Without this,
      // the cache would serve a stale 'unknown/wait' from a previous cycle.
      if (action.actionType === 'wait' && action.currentState === 'blank_page') {
        currentState = 'blank_page';
        blankPageCounter++;
        const targetUrl = _getRecoveryUrl();

        if (blankPageCounter >= BLANK_SELF_HEAL_THRESHOLD) {
          // Step 3: Full self-heal
          log(`blank_page early exit: ${blankPageCounter} consecutive blanks — triggering full self-heal (AI investigation)`, 'ERROR', 'cycle');
          blankPageCounter = 0;
          try {
            const selfHealMod = getDep('selfHeal');
            if (selfHealMod?.performSelfHeal && CONFIG.SELF_HEAL_ENABLED && !selfHealRunning) {
              // v14: Reset circuit breaker for blank-page emergency
              try { require('./self-heal-circuit-breaker').healerCircuitBreaker?.reset?.(); } catch {}
              selfHealRunning = true;
              const healResult = await selfHealMod.performSelfHeal({ skipRuntimeHeal: true });
              selfHealRunning = false;
              log(`Blank-page self-heal result: ${JSON.stringify(healResult?.summary || healResult)?.substring(0, 200)}`, 'INFO', 'cycle');
            }
          } catch (healErr: any) {
            selfHealRunning = false;
            log(`Blank-page self-heal failed: ${healErr.message || healErr}`, 'ERROR', 'cycle');
          }
          // Navigate after self-heal
          if (targetUrl) {
            try {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 8000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch {}
          }
        } else if (blankPageCounter >= BLANK_RESTART_THRESHOLD) {
          // Step 2: Restart browser
          log(`blank_page early exit: ${blankPageCounter} consecutive blanks — RESTARTING browser context`, 'ERROR', 'cycle');
          // v12: Do NOT reset blankPageCounter
          try {
            _trackBrowserRestart();
            await closeBrowser?.();
            _networkSetup = false;
            page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
            if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
              await network.setupInterception(page);
              _networkSetup = true;
            }
            await page.goto(_getRecoveryUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 8000));
            if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
          } catch (restartErr: any) {
            log(`blank_page browser restart failed: ${restartErr.message || restartErr}`, 'ERROR', 'cycle');
            try {
              _networkSetup = false;
              page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
              if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) { await network.setupInterception(page); _networkSetup = true; }
            } catch { break; }
          }
        } else if (blankPageCounter >= BLANK_RELOAD_THRESHOLD) {
          // Step 1: Reload MathU
          log(`blank_page early exit: ${blankPageCounter} consecutive blanks — reloading MathU`, 'WARN', 'cycle');
          if (targetUrl) {
            try {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
              await new Promise(r => setTimeout(r, 8000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch {}
          }
        } else {
          // First blank: just navigate
          log(`blank_page early exit: skipping 75s wait, navigating to ${targetUrl}`, 'INFO', 'cycle');
          if (targetUrl) {
            try {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => {
                log(`blank_page early exit: navigation failed: ${e.message || e}`, 'WARN', 'cycle');
              });
              await new Promise(r => setTimeout(r, 8000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch (navErr: any) {
              log(`blank_page early exit failed: ${navErr.message || navErr}`, 'WARN', 'cycle');
            }
          }
        }
        lastScreenshotChangeTime = Date.now();
        continue;
      }

      // ── App Error Detection ──
      // The vision tribunal can report currentState='app_error' when it
      // sees error dialogs, maintenance notices, or "something went wrong"
      // messages on screen. These are app-level errors that require a page
      // reload — not clicks or self-heal. The app itself typically says
      // "close the app and open it again", which means reload.
      // BUG FIX (2026-09-07): If app_error appears 3+ times, relaunch the
      // entire browser — the page is stuck in a broken state that reload
      // can't fix.
      if (action.currentState === 'app_error') {
        _appErrorCount++;
        log(`App error detected by tribunal (#${_appErrorCount}): ${action.reasoning || 'error dialog visible'}.`, 'WARN', 'cycle');

        if (_appErrorCount >= 3) {
          log(`App error appeared ${_appErrorCount} times — relaunching entire browser.`, 'ERROR', 'cycle');
          _appErrorCount = 0;
          try {
            if (typeof closeBrowser === 'function') await closeBrowser();
            _networkSetup = false;
            page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
            if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
              await network.setupInterception(page);
              _networkSetup = true;
            }
            if (CONFIG.FLUTTER_DPR_AUTO_CALIBRATE && dpr) { await dpr.calibrate(page); }
          } catch (relaunchErr: any) {
            log(`Browser relaunch failed: ${relaunchErr.message}`, 'ERROR', 'cycle');
          }
          lastScreenshotChangeTime = Date.now();
          lastProgressTime = Date.now();
          continue;
        }

        const targetUrl = _getRecoveryUrl();
        log(`Reloading to recover from app error.`, 'WARN', 'cycle');
        if (targetUrl) {
          try {
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => {
              log(`App error recovery: navigation failed: ${e.message || e}`, 'WARN', 'cycle');
            });
            await new Promise(r => setTimeout(r, 8000));
            if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
          } catch (navErr: any) {
            log(`App error recovery failed: ${navErr.message || navErr}`, 'WARN', 'cycle');
          }
        } else {
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
            await new Promise(r => setTimeout(r, 8000));
            if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
          } catch {}
        }
        lastScreenshotChangeTime = Date.now();
        lastProgressTime = Date.now();
        continue;
      }

      // Execute action with plugin pre-hook
      pluginAPI?.runHooks?.('preAction', { page, action, state: currentState });

      if (action.actionType === 'click') {
        clickAttempts++;
        if (executeAction) await executeAction(page, action);
        const afterUrl = page.url();
        // v20: Trust the executor. Click already retries internally
        // (performClickWithRetry: 3 attempts with jitter). If the executor
        // returned without throwing, the click was delivered. Don't second-
        // guess it with body-length heuristics that fire false negatives on
        // JS-navigated pages (login buttons, Flutter router transitions).
        //
        // REMOVED: beforeBodyLen / afterBodyLen comparison.
        // REMOVED: Swipe + retry fallback (line 2207-2210).
        // REMOVED: Network replay fallback.
        //
        // Why these caused OOM on 512MB:
        // 1. The body-length check false-negatived on login/nav clicks →
        //    triggered swipe gesture (800ms CDP touch, 20 steps).
        // 2. Swipe caused Flutter to scroll/animate → Chromium allocated
        //    rendering memory for the animation (~30-80MB RSS growth).
        // 3. Then retry click + POST_CLICK_MS (20s) + BETWEEN_STEPS_MS (25s)
        //    = 45+ seconds of browser idle time → RSS grew to 312MB → OOM.
        //
        // The action executor already has its own retry logic. If a click
        // truly fails, the next cycle's screenshot will show nothing changed
        // and the tribunal will re-decide the action (possibly with cache
        // failure tracking evicting the bad entry).
        clickSuccesses++;
        actionSuccess = true;
        consecutiveFailures = 0;

        // TASK 58 (2026-09-11): If the AI clicked on a question state, mark
        // that an answer has been submitted. On the NEXT cycle, the cache can
        // activate for navigation actions (click Next, book icon) because
        // the AI already chose its answer — the remaining actions are navigation.
        if (CACHE_BANNED_STATES.has(currentState || '') && (action.actionType === 'click' || action.actionType === 'flutter_tap')) {
          _answerSubmitted = true;
          _answerSubmittedState = currentState;
          log(`Answer submitted on state ${currentState} — cache will be allowed for navigation actions on next cycle.`, 'DEBUG', 'cycle');
        }

        // ── BUG FIX (2026-09-04): Login-flow tracking ──
        // When the bot clicks on the mathu_login state, it is virtually
        // always clicking the "Sign in with Microsoft" button (per the
        // tribunal's AUTH RULE in providers-prompts.ts). The EXPECTED next
        // step is a navigation to login.microsoftonline.com.
        //
        // The auth-guard's ensureAuthenticated() at the START of the next
        // cycle would otherwise see that URL, misinterpret it as "session
        // expired", and call refreshSession() — which often fails and ends
        // up bouncing the bot back to MathU via browser.closeBrowser()+relaunch,
        // causing the click loop documented in the worklog.
        //
        // We proactively notify the auth-guard that a login flow has been
        // initiated, so its next ensureAuthenticated() call treats the
        // Microsoft login URL as an EXPECTED destination rather than a
        // session-expiry event. The flag auto-clears when the bot returns
        // to the MathU SPA domain (notifyLoginCompleted) or after 5 minutes.
        if (action.currentState === 'mathu_login' || preActionState === 'mathu_login') {
          try {
            const authGuardForLogin = getDep('authGuard');
            if (typeof authGuardForLogin?.notifyLoginInitiated === 'function') {
              authGuardForLogin.notifyLoginInitiated();
            }
          } catch (e: any) { /* non-critical — auth-guard not available */ }
        }
        // v20: All click fallbacks removed. They were designed for a
        // system with memory headroom. On 512MB, each fallback is a gamble:
        //  - Canvas OCR: loads sharp + Tesseract (~50-100MB)
        //  - Engine tap: adds another CDP session
        //  - Brute force navigate: navigates away, loses page state
        // If a click truly fails, the next cycle's fresh screenshot will
        // show the unchanged page and the tribunal will re-decide.
        // The action cache failure tracker will evict after 3 failures.
      } else {
        if (executeAction) await executeAction(page, action);
        actionSuccess = true;
        consecutiveFailures = 0;
      }

      // v16: Push successful action to OOM replay buffer.
      // Flushed to DB every 2 actions. On restart, replayed blindly.
      if (actionSuccess) _pushActionReplay(action);

      // ── BUG FIX (2026-09-04): Post-action memory cleanup ──
      // NOTE: Do NOT clear the screenshot global — it's needed for the dashboard.
      // The old cleanup code did setShot('', null) which wiped the screenshot
      // from the dashboard before it could be displayed. The screenshot is
      // already small (~30KB at quality 15) and gets overwritten on the next
      // cycle — no need to explicitly clear it.
      // Force GC to reclaim transient allocations from this cycle.
      try {
        if (global.gc) {
          global.gc(); // force garbage collection after each action
        }
      } catch { /* non-critical */ }

      // ── BUG FIX (2026-09-04): Update last-known-good-URL tracker ──
      // After a successful action, notify the auth-guard of the current URL.
      // This becomes the baseline for the next session check — replacing the
      // old preset-URL checks (CONFIG.APP_URL, CONFIG.MATHU_SPA_DOMAINS) with
      // the bot's actual current location. The auth-guard's notifyLastKnownGoodUrl
      // filters out Microsoft login URLs and about:blank, so we can pass any URL.
      if (actionSuccess) {
        try {
          const authGuardForUrl = getDep('authGuard');
          if (typeof authGuardForUrl?.notifyLastKnownGoodUrl === 'function') {
            authGuardForUrl.notifyLastKnownGoodUrl(page.url());
          }
        } catch (e: any) { /* non-critical — auth-guard not available */ }
      }

      // ─── Pixel Calibration Sampling ───
      // v17: GATED behind heap check. A PNG screenshot (500KB-2MB) is the
      // #1 OOM trigger on 512MB Render. Calibration is a nice-to-have that
      // can wait until the instance has memory headroom.
      const _postActionHeapMB = process.memoryUsage().heapUsed / 1024 / 1024;
      if (actionSuccess && action.actionType === 'click' && (action.targetX > 0 || action.targetY > 0)
          && _postActionHeapMB < 150) {
        try {
          const pixelCal = require('./pixel-calibration');
          const pngShot = await page.screenshot({ type: 'png', fullPage: false, timeout: 10000, animations: 'disabled' }).catch(() => null);
          if (pngShot && pngShot.length > 100) {
            const dprMod = require('./browser');
            const dpr = dprMod._dprScale || 1.0;
            pixelCal.sampleAtCoordinates(
              pngShot,
              Math.round(action.targetX * dpr),
              Math.round(action.targetY * dpr),
              action.actionType
            ).catch(() => {});
            pixelCal.sampleSurroundings(
              pngShot,
              Math.round(action.targetX * dpr),
              Math.round(action.targetY * dpr),
              action.actionType
            ).catch(() => {});
          }
        } catch (calErr: any) {
          log(`Pixel calibration sampling failed: ${calErr.message || calErr}`, 'DEBUG', 'cycle');
        }
      } else if (actionSuccess && action.actionType === 'click' && _postActionHeapMB >= 150) {
        log(`Skipping pixel calibration (heap=${_postActionHeapMB.toFixed(0)}MB > 150MB threshold)`, 'DEBUG', 'cycle');
      }

      // ─── Pixel Training: Record successful action for self-training ───
      // v17: GATED behind heap check. recordSuccess holds page + screenshot refs
      // that prevent GC. Skip when memory is tight.
      if (actionSuccess && action.actionType === 'click' && (action.targetX > 0 || action.targetY > 0)
          && _postActionHeapMB < 150) {
        try {
          const pixelTraining = require('./pixel-training');
          if (pixelTraining && pixelTraining.recordSuccess) {
            const trainingPng = (typeof pngShot !== 'undefined' && pngShot && pngShot.length > 100) ? pngShot : undefined;
            pixelTraining.recordSuccess({
              page,
              action,
              screenshotBuf: trainingPng,
              pageFingerprint: typeof screenshotHash === 'string' ? screenshotHash : '',
              viewportWidth: 1280,
              viewportHeight: 720,
              latencyMs: Date.now() - startTime,
            }).catch(() => {});
          }
        } catch (trainErr: any) {
          log(`Pixel training recording failed: ${trainErr.message || trainErr}`, 'DEBUG', 'cycle');
        }
      }

      // ─── Pixel Explorer Outcome Observation ───
      // v17: GATED behind heap check.
      if (actionSuccess && action._pixelExplorer && action._explorationMapKey
          && _postActionHeapMB < 150) {
        try {
          const pixelExplorer = require('./pixel-explorer');
          pixelExplorer.observeOutcome(
            page,
            typeof screenshotHash === 'string' ? screenshotHash : '',
            action._explorationMapKey,
            action._explorationCellCx || action.targetX,
            action._explorationCellCy || action.targetY
          ).catch(() => {});
        } catch (expErr: any) {
          log(`Pixel explorer outcome observation failed: ${expErr.message || expErr}`, 'DEBUG', 'cycle');
        }
      }

      // ─── Action Cache Failure Tracking ───
      // Cache write already happened eagerly (right after tribunal returned).
      // This block only handles failure tracking: if the action we just executed
      // (whether from cache or tribunal) failed, record it. After 3 consecutive
      // failures the entry is evicted.
      if (_actionCacheSig && actionCache && !_isCacheExcluded) {
        if (!actionSuccess) {
          const evicted = actionCache.recordFailure(_actionCacheSig);
          if (evicted) {
            log('Action cache entry evicted due to repeated failures — will re-query AI next cycle', 'WARN', 'cycle');
          }
        }
      }

      // TASK 62 (2026-09-11): Screenshot-unchanged eviction for cached actions.
      // If a cached action was used and the screenshot didn't change, increment
      // a counter. After 3 consecutive unchanged screenshots, evict the cache
      // entry — the cached action is wrong for this page.
      if (_actionCacheHit && _actionCacheSig) {
        if (screenshotHash === previousScreenshotHash) {
          // Screenshot didn't change — but wait, previousScreenshotHash was
          // already updated to the current hash at line ~2231. We need to
          // compare with the hash BEFORE this cycle's screenshot was taken.
          // Use _cacheHitUnchangedSig to track the last hash we saw when a
          // cache hit occurred.
          if (_cacheHitUnchangedSig === screenshotHash) {
            _cacheHitUnchangedCount++;
          } else {
            _cacheHitUnchangedCount = 1;
            _cacheHitUnchangedSig = screenshotHash;
          }
          if (_cacheHitUnchangedCount >= 3) {
            log(`Cache eviction: cached action didn't change screenshot ${_cacheHitUnchangedCount} times — evicting. sig=${_actionCacheSig.substring(0, 8)}`, 'WARN', 'cycle');
            try {
              if (actionCache?.evictEntry) {
                actionCache.evictEntry(_actionCacheSig);
              } else if (actionCache?.recordFailure) {
                // Fallback: force-evict via 3 rapid failures
                actionCache.recordFailure(_actionCacheSig);
                actionCache.recordFailure(_actionCacheSig);
                actionCache.recordFailure(_actionCacheSig);
              }
            } catch {}
            _cacheHitUnchangedCount = 0;
            _cacheHitUnchangedSig = null;
          }
        } else {
          // Screenshot changed — reset counter
          _cacheHitUnchangedCount = 0;
          _cacheHitUnchangedSig = null;
        }
      }

      // ─── Module Download Wait Logic (Response 3) ───
      // After executing a download click, wait for the module content to appear.
      // Uses screenshot hash comparison to detect when the page changes.
      if (_moduleDownloadState === 'download_clicked' && actionSuccess) {
        log('Module download flow: waiting for content to change...', 'INFO', 'cycle');
        const downloadStartTime = Date.now();
        let contentAppeared = false;
        const { sleep: dlSleep } = require('./utils-sleep');

        // Poll for screenshot change (indicates download started/completed)
        while (Date.now() - downloadStartTime < MODULE_DOWNLOAD_TIMEOUT_MS) {
          await dlSleep(MODULE_DOWNLOAD_POLL_INTERVAL_MS);
          try {
            const pollScreenshot = await page.screenshot({ type: 'jpeg', quality: 15, timeout: 10000, animations: 'disabled' });
            const pollHash = crypto.createHash('md5').update(pollScreenshot).digest('hex');

            if (pollHash !== _preDownloadScreenshotHash) {
              // Screenshot changed — download has started or completed
              _moduleDownloadState = 'downloading';
              log('Module download flow: screenshot changed, download in progress', 'INFO', 'cycle');

              // Wait additional time for content to fully render
              await dlSleep(2000);

              // v17: Skip PNG pixel check on tight heap — use heuristic instead
              if (process.memoryUsage().heapUsed / 1024 / 1024 < 150) {
                try {
                  const pngScreenshot = await page.screenshot({ type: 'png', fullPage: false, timeout: 10000, animations: 'disabled' });
                  const pixelMod = require('./pixel-fallback');
                  const decoded = pixelMod._decodePNG?.(pngScreenshot);
                  if (decoded && pixelMod._isModuleContentLoaded?.(decoded.rgba, decoded.width, decoded.height)) {
                    _moduleDownloadState = 'content_visible';
                    log('Module download flow: content loaded! Topics visible.', 'INFO', 'cycle');
                    contentAppeared = true;
                  }
                } catch (pxErr: any) {
                  log(`Module download flow: pixel check failed (${pxErr.message || pxErr}), assuming content loaded`, 'DEBUG', 'cycle');
                  contentAppeared = true;
                  _moduleDownloadState = 'content_visible';
                }
              } else {
                log('Module download flow: skipping PNG check (heap tight), assuming content loaded', 'DEBUG', 'cycle');
                contentAppeared = true;
                _moduleDownloadState = 'content_visible';
              }
              break;
            }
          } catch (pollErr: any) {
            log(`Module download flow: poll screenshot failed (${pollErr.message || pollErr})`, 'DEBUG', 'cycle');
          }
        }

        if (!contentAppeared) {
          // Download may still be in progress or failed
          const elapsed = Date.now() - downloadStartTime;
          if (elapsed >= MODULE_DOWNLOAD_TIMEOUT_MS) {
            log(`Module download flow: timeout after ${elapsed / 1000}s. Scrolling and retrying.`, 'WARN', 'cycle');
            _moduleDownloadRetryCount++;
            if (_moduleDownloadRetryCount <= MODULE_DOWNLOAD_MAX_RETRIES) {
              // Try scrolling and clicking the card again
              try { await page.evaluate(() => window.scrollBy(0, -200)); } catch { /* non-critical */ }
              await dlSleep(1000);
              _moduleDownloadState = 'idle'; // Reset to try again on next cycle
            } else {
              log(`Module download flow: max retries (${MODULE_DOWNLOAD_MAX_RETRIES}) exceeded. Moving on.`, 'WARN', 'cycle');
              _moduleDownloadState = 'idle';
            }
          } else {
            // Still waiting — stay in download_clicked state for next cycle to continue polling
            log('Module download flow: still waiting, will poll again next cycle', 'DEBUG', 'cycle');
          }
        }

        // If content is now visible, let the next cycle iteration find Watch/Start buttons
        if (_moduleDownloadState === 'content_visible') {
          _moduleDownloadState = 'idle';
          _preDownloadScreenshotHash = null;
          // Don't set currentState to module_downloading — let the next iteration
          // detect the assignments page with visible topic buttons
          // Force a new screenshot on the next iteration by jumping to top of loop
          await dlSleep((CONFIG.BETWEEN_STEPS_MS || 2000) * 1);
          continue;
        }
      }

      // If download was clicked but action failed (click didn't register)
      if (_moduleDownloadState === 'download_clicked' && !actionSuccess) {
        log('Module download flow: click failed, will retry on next cycle', 'DEBUG', 'cycle');
        _moduleDownloadState = 'idle'; // Reset so we can try again
      }

      // Record experiment result
      const latency = Date.now() - startTime;
      if (strategyVariants?.getActiveExperiment?.()) {
        strategyVariants.recordExperimentResult?.(actionSuccess, latency);
        const exp = strategyVariants.getActiveExperiment();
        if (exp?.results?.attempts >= 30) {
          if (strategyVariants.shouldPromoteExperiment?.()) {
            strategyVariants.promoteActiveExperiment?.();
          } else {
            strategyVariants.revertExperiment?.(exp);
          }
        }
      }

      // Adaptive performance
      if (CONFIG.ENABLE_ADAPTIVE_PERFORMANCE && adaptiveEngine) { adaptiveEngine.recordLatency(latency); }

      // Blackbox recording — v17: skip when heap is tight
      if (CONFIG.ENABLE_BLACKBOX && blackbox && _postActionHeapMB < 150) {
        const semanticsSnapshot = await _getA11ySnapshot().getA11ySnapshot(page);
        blackbox.record({ state: action.currentState, action: action.actionType, semantics: JSON.stringify(semanticsSnapshot).substring(0, 500), hash: screenshotHash, success: actionSuccess ? 1 : 0, reasoning: action.reasoning || '', latency, provider_used: action.provider || 'unknown' });
        if (insertSemanticsSnapshot) insertSemanticsSnapshot.run(Date.now(), semanticsSnapshot ? Object.keys(semanticsSnapshot).length : 0, JSON.stringify(semanticsSnapshot).substring(0, 1000));
      }

      // Flutter semantics persistence
      if (CONFIG.ENABLE_FLUTTER_SEMANTICS && semantics) {
        const items = await semantics.getInteractiveItems(page, true);
        // v5-fix: Use DI-injected insertFlutterSemantics instead of inline require('./database')
        const insertFlutterSemantics = dbHelpers.insertFlutterSemantics || null;
        insertFlutterSemantics?.run?.(page.url(), JSON.stringify(items.slice(0, 50)), Date.now());
      }

      // Stagnation recovery & module tracking
      if (recoverIfStuck) await recoverIfStuck(page, screenshot, action);
      if (trackModuleProgress) await trackModuleProgress(page, base64);

      // TASK 102+103 (2026-09-30): Action feedback loop with region-level change detection.
      // Tell the pixel fallback whether the last action changed the page.
      // The pixel fallback stores region fingerprints BEFORE the action;
      // we pass the new screenshot hash for comparison. If the page changed,
      // the pixel fallback's recordActionOutcome will also check region-level
      // changes to distinguish meaningful content change from animation/timer.
      try {
        const pixelMod = require('./pixel-fallback');
        if (pixelMod?.recordActionOutcome) {
          const pageChanged = previousScreenshotHash !== null && screenshotHash !== previousScreenshotHash;
          // Pass empty region fingerprints — the cycle manager doesn't have them.
          // The pixel fallback will fall back to the whole-page hash comparison
          // for the actionChangedPage boolean, and use its stored region
          // fingerprints for the region-level analysis.
          pixelMod.recordActionOutcome([], pageChanged);
        }
      } catch { /* non-critical */ }

      // ── Memory: release screenshot + base64 after ALL consumers ──
      // This is the last place either is used in the loop iteration.
      // Nulling frees ~20-60KB (base64) + ~15-25KB (raw Buffer) immediately.
      screenshot = null as any;
      base64 = null as any;
      _actionCacheSig = null;
      // TASK 95 (2026-09-27): Aggressive GC after nulling — frees the
      // actual memory immediately, not just the reference.
      if (global.gc) { try { global.gc(); } catch {} }
      // Resilience: semantic progress detection
      if (progressSemanticDetector) {
        try {
          const semState = await progressSemanticDetector.getSemanticState(page);
          if (semState) {
            // TASK 84 (2026-09-25): Only log if at least one field is non-null.
            // On Flutter Web SPA, the page content is inside a canvas, so
            // document.body.innerText returns empty/canvas text that doesn't
            // match any parsing patterns. This produced misleading log lines
            // like "Semantic state: Qnull/null module=null score=null" on
            // every cycle. Now we only log when there's actual semantic data.
            const hasData = semState.questionNumber !== null
              || semState.totalQuestions !== null
              || semState.module !== null
              || semState.score !== null;
            if (hasData) {
              log(`Semantic state: Q${semState.questionNumber}/${semState.totalQuestions} module=${semState.module} score=${semState.score}`, 'DEBUG', 'cycle');
            }
          }
        } catch (e: any) { /* non-critical */ }
      }

      // Module completion
      if (['score_screen', 'pathway_feedback'].includes(action.currentState) && action.currentState !== currentState) {
        questionsCompleted++;
        _midQuiz = false; // v6: quiz done, safe to close browser for memory
        try { const memoryMode = require('./memory-mode'); memoryMode.setMidQuiz(false); } catch {}
        lastQuestionCompletionTime = Date.now();
        lastScreenshotChangeTime = Date.now();
        updateStats({ questionsCompleted });
        // Notify health watchdog of progress (Response 2)
        _getHealthWatchdog()?.notifyProgress?.();
        trackProgress?.({ action: action.actionType, state: action.currentState, timestamp: new Date().toISOString(), questionsCompleted });
        if (upsertLastState) upsertLastState.run(page.url(), action.currentState, Date.now());
        consecutiveFailures = 0;
        saveCheckpoint?.({ url: page.url(), state: action.currentState, questionsCompleted });
        // Run solution cache maintenance every 100 questions (Response 5)
        if (questionsCompleted % 100 === 0) {
          try { _getSolutionCache()?.runMaintenance?.(); } catch { /* non-critical */ }
          try { _getActionCache()?.runMaintenance?.(); } catch { /* non-critical */ }
        }
        if (currentModule && recordModuleCompletion) {
          const timeTaken = Date.now() - cycleStart;
          recordModuleCompletion(currentModule, timeTaken);
          log(`Module ${currentModule} completed in ${timeTaken / 1000}s`, 'INFO', 'cycle');
          currentModule = getNextModule?.();
          if (currentModule) { log(`Next module: ${currentModule}`, 'INFO', 'cycle'); }
        }
      }

      // Resilience: speed benchmark timeout check
      if (progressSpeedBenchmark && action.currentState === preActionState) {
        const speedCheck = progressSpeedBenchmark.checkSpeedTimeout(startTime, action.currentState);
        if (speedCheck?.timedOut) {
          log(`Speed timeout: ${speedCheck.currentTime}ms > 3x avg ${speedCheck.avgTime?.toFixed(0)}ms. Forcing skip.`, 'WARN', 'cycle');
        }
      }
      // Stuck detection
      if (action.currentState === preActionState && !actionSuccess) {
        stuckCounter++;
        consecutiveTribunalFailures++;
      } else {
        stuckCounter = 0;
        consecutiveTribunalFailures = 0;
        explorationFailures = 0;
        explorationMode = false;
      }

      // ─────────────────────────────────────────────────────────────────────
      // TASK 45 (2026-09-10): Validate "exploration" state — require proof.
      // The AI must prove that the page doesn't match ANY known state before
      // setting currentState to "exploration". If the reasoning is too short
      // or doesn't mention "Not" for at least 3 known states, reject it
      // and treat as "unknown" instead (which triggers the unknown-state
      // escalation ladder: pixel fallback → reload → restart).
      // ─────────────────────────────────────────────────────────────────────
      if (action?.currentState === 'exploration') {
        const reasoning = String(action?.reasoning || '');
        // Count how many "Not <state>" patterns the AI mentioned
        const notCount = (reasoning.match(/\bnot\s+\w+/gi) || []).length;
        const reasoningLength = reasoning.length;
        if (notCount < 3 || reasoningLength < 50) {
          log(`Exploration state rejected — reasoning lacks proof (notCount=${notCount}, len=${reasoningLength}). Converting to 'unknown' for escalation. Reasoning: "${reasoning.substring(0, 100)}"`, 'WARN', 'cycle');
          action.currentState = 'unknown';
          // Don't change actionType — let the unknown-state handler deal with it
        } else {
          log(`Exploration state accepted — AI provided proof (${notCount} "Not" mentions, ${reasoningLength} chars).`, 'DEBUG', 'cycle');
        }
      }

      // Unknown state escape hatch — prevents 75s × N death spiral
      // When providers can't determine the page state, they return 'unknown'
      // and default to 'wait', creating an infinite idle loop. After
      // MAX_UNKNOWN_STATE consecutive unknowns, force a page reload to
      // break the cycle and potentially land on a recognizable page.
      if (action.currentState === 'unknown' || !action.currentState) {
        unknownStateCounter++;
        // 20-min stagnation auto-ban: if no screenshot change + no question completion
        // for 20+ minutes in unknown/error loop, auto-ban 'wait' to force reload
        const timeSinceScreenshotChange = Date.now() - lastScreenshotChangeTime;
        const timeSinceQuestionCompletion = Date.now() - lastQuestionCompletionTime;
        if (!stagnationAutoBanTriggered
            && action.actionType === 'wait'
            && timeSinceScreenshotChange > STAGNATION_AUTO_BAN_MS
            && timeSinceQuestionCompletion > STAGNATION_AUTO_BAN_MS) {
          log(`20-min stagnation detected in unknown loop (no screenshot change, no completions). Triggering runtime heal + auto-banning wait action.`, 'WARN', 'cycle');
          // v9: Trigger runtime heal FIRST — it may fix the root cause
          // (stale providers, corrupted DB, quarantined modules) without
          // needing to ban wait or reload.
          try {
            const selfHealMod = getDep('selfHeal');
            if (selfHealMod?.performRuntimeHeal && CONFIG.SELF_HEAL_ENABLED) {
              selfHealMod.performRuntimeHeal().then((rtResult: any) => {
                if (rtResult?.healed) {
                  log(`Stagnation runtime heal succeeded: ${rtResult.results?.filter((r: any) => r.healed).map((r: any) => r.avenue).join(', ')}`, 'INFO', 'cycle');
                }
              }).catch(() => {});
            }
          } catch {}
          // Also request self-heal session if in memory protection
          try {
            const memoryMode = require('./memory-mode');
            if (memoryMode.isMemoryProtection?.()) {
              memoryMode.beginSelfHealSession?.('stagnation_20min_unknown_loop');
            }
          } catch {}
          try {
            const dbMod = require('./database');
            dbMod.insertBannedAction?.('wait', 'stagnation-guard', Date.now() + 60 * 60 * 1000);
          } catch { /* non-critical */ }
          stagnationAutoBanTriggered = true;
          try {
            const sendAlert = require('./alerting').sendAlert;
            // TASK 61: Removed alert — routine event.
          } catch { /* non-critical */ }
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          lastScreenshotChangeTime = Date.now();
          continue;
        }
        if (unknownStateCounter >= MAX_UNKNOWN_STATE) {
          log(`Unknown state ${unknownStateCounter} times in a row. Trying pixel fallback before reload.`, 'WARN', 'cycle');
          unknownStateCounter = 0;
          // Try pixel-based fallback before reloading — it can handle login pages
          // and other pages even when AI, DOM, and semantics are all unavailable
          try {
            const pixelFallback = require('./pixel-fallback');
            const pixelAction = await pixelFallback.generatePixelFallbackAction(page, currentState || undefined);
            if (pixelAction && pixelAction.actionType && pixelAction.actionType !== 'wait') {
              log(`Pixel fallback saved us: ${pixelAction.actionType} at (${pixelAction.targetX}, ${pixelAction.targetY}) state=${pixelAction.currentState}`, 'INFO', 'cycle');
              if (executeAction) await executeAction(page, pixelAction);
              lastScreenshotChangeTime = Date.now();
              continue;
            }
          } catch (pfErr: any) {
            log(`Pixel fallback attempt failed: ${pfErr.message || pfErr}`, 'DEBUG', 'cycle');
          }
          // Pixel fallback didn't help — fall back to reload
          try {
            const currentUrl = page.url();
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            // If still on same page after reload, try navigating to BASE_URL
            if (page.url() === currentUrl && CONFIG.BASE_URL) {
              log('Reload didn\'t change page, navigating to BASE_URL.', 'WARN', 'cycle');
              await page.goto(CONFIG.BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }
          } catch (reloadErr: any) {
            log(`Page reload failed: ${reloadErr.message || reloadErr}`, 'WARN', 'cycle');
          }
          continue; // Skip the wait action and re-evaluate on next iteration
        }
      // v12: blank_page ESCALATION LADDER
      // The tribunal returns currentState='blank_page' when the screenshot is
      // blank/white (no content rendered). Instead of always navigating to
      // APP_URL (which often produces another blank page), escalate:
      //   Step 1 (count >= 2): reload MathU
      //   Step 2 (count >= 3): restart browser context entirely
      //   Step 3 (count >= 5): trigger full self-heal (let AI figure it out)
      // v12 FIX: Counter NOT reset on browser restart — only on non-blank page.
      } else if (action.currentState === 'blank_page') {
        blankPageCounter++;
        unknownStateCounter = 0;
        log(`blank_page state detected (${blankPageCounter} consecutive). Escalating...`, 'WARN', 'cycle');

        if (blankPageCounter >= BLANK_SELF_HEAL_THRESHOLD) {
          // Step 3: Trigger full self-heal — something is fundamentally broken
          // v12: If the page is blank this many times, the AIs can figure it out.
          totalBlankRecoveryAttempts++;
          log(`Blank-page escalation: ${blankPageCounter} consecutive blanks (total recovery attempts: ${totalBlankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS}) — triggering full self-heal (AI investigation)`, 'ERROR', 'cycle');

          // TASK 109: Capture DOM/console/network evidence BEFORE reloading.
          // The supervisor requested this for diagnosis.
          try {
            const domSnapshot = await page.content().catch(() => '<unavailable>');
            const consoleErrors: string[] = [];
            try {
              page.on('console', (msg: any) => {
                if (msg.type() === 'error') consoleErrors.push(msg.text().substring(0, 200));
              });
            } catch {}
            const url = page.url();
            log(`Blank-page evidence: url=${url}, domSize=${domSnapshot.length}, consoleErrors=${consoleErrors.length}`, 'WARN', 'cycle');
            if (consoleErrors.length > 0) {
              log(`Blank-page console errors: ${consoleErrors.slice(0, 5).join(' | ')}`, 'WARN', 'cycle');
            }
            // Push to self-heal error buffer for the codegen tribunal
            try {
              const selfHealMod = getDep('selfHeal') || require('./self-heal');
              selfHealMod?.pushSelfHealError?.(`blank_page: url=${url}, domSize=${domSnapshot.length}, consoleErrors=${consoleErrors.length}, consoleSamples=${consoleErrors.slice(0, 3).join('; ').substring(0, 300)}`, 'blank-page-recovery');
            } catch {}
          } catch (evidenceErr: any) {
            log(`Blank-page evidence capture failed: ${evidenceErr.message}`, 'DEBUG', 'cycle');
          }

          // TASK 109: Check if recovery budget is exhausted
          if (totalBlankRecoveryAttempts >= MAX_BLANK_RECOVERY_ATTEMPTS) {
            log(`Blank-page recovery budget EXHAUSTED (${totalBlankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS}). Stopping no-progress loop and raising alert.`, 'ERROR', 'cycle');
            try {
              const alerting = getDep('alerting');
              alerting?.sendAlert?.(`MathU Bot stuck: ${totalBlankRecoveryAttempts} blank-page recovery attempts failed. The Flutter Web app is not rendering. Bot is pausing to avoid wasting resources. Manual investigation needed.`);
            } catch {}
            // Set human intervention flag — don't touch the browser
            (globalThis as any).__humanInterventionRequested = true;
            (globalThis as any).__humanInterventionReason = `Blank-page recovery budget exhausted (${totalBlankRecoveryAttempts} attempts). Flutter Web app not rendering.`;
            break; // Break out of the cycle loop
          }

          blankPageCounter = 0;
          try {
            const selfHealMod = getDep('selfHeal');
            if (selfHealMod?.performSelfHeal && CONFIG.SELF_HEAL_ENABLED && !selfHealRunning) {
              // v14: Reset circuit breaker for blank-page emergency
              try { require('./self-heal-circuit-breaker').healerCircuitBreaker?.reset?.(); } catch {}
              selfHealRunning = true;
              const healResult = await selfHealMod.performSelfHeal({ skipRuntimeHeal: true });
              selfHealRunning = false;
              log(`Blank-page self-heal result: ${JSON.stringify(healResult?.summary || healResult)?.substring(0, 200)}`, 'INFO', 'cycle');
            }
          } catch (healErr: any) {
            selfHealRunning = false;
            log(`Blank-page self-heal failed: ${healErr.message || healErr}`, 'ERROR', 'cycle');
          }
          // Also try browser restart as immediate recovery
          try {
            _trackBrowserRestart();
            await closeBrowser?.();
            _networkSetup = false;
            page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
            if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
              await network.setupInterception(page);
              _networkSetup = true;
            }
            await page.goto(_getRecoveryUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 8000));
            if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
          } catch (restartErr: any) {
            log(`Blank-page browser restart (step 3) failed: ${restartErr.message || restartErr}`, 'ERROR', 'cycle');
            try {
              _networkSetup = false;
              page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
              if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) { await network.setupInterception(page); _networkSetup = true; }
            } catch (recoveryErr: any) {
              log(`Blank-page step-3 restart: recovery also failed: ${recoveryErr.message || recoveryErr} — will break cycle`, 'ERROR', 'cycle');
              break;
            }
          }
          lastScreenshotChangeTime = Date.now();
          continue;
        } else if (blankPageCounter >= BLANK_RESTART_THRESHOLD) {
          // Step 2: Restart browser context entirely
          totalBlankRecoveryAttempts++;
          log(`Blank-page escalation: ${blankPageCounter} consecutive blanks — RESTARTING browser context (total recovery attempts: ${totalBlankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS})`, 'ERROR', 'cycle');
          // v12 FIX: Do NOT reset blankPageCounter here.
          try {
            _trackBrowserRestart();
            await closeBrowser?.();
            _networkSetup = false;
            page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
            if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
              await network.setupInterception(page);
              _networkSetup = true;
            }
            await page.goto(_getRecoveryUrl(), { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 8000));
            if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
          } catch (restartErr: any) {
            log(`Blank-page browser restart failed: ${restartErr.message || restartErr}`, 'ERROR', 'cycle');
            try {
              _networkSetup = false;
              page = await safeBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
              if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) { await network.setupInterception(page); _networkSetup = true; }
            } catch (recoveryErr: any) {
              log(`Blank-page tribunal restart: recovery also failed: ${recoveryErr.message || recoveryErr} — will break cycle`, 'ERROR', 'cycle');
              break;
            }
          }
          lastScreenshotChangeTime = Date.now();
          continue;
        } else if (blankPageCounter >= BLANK_RELOAD_THRESHOLD) {
          // Step 1: Reload MathU
          log(`Blank-page escalation: ${blankPageCounter} consecutive blanks — reloading MathU (total recovery attempts: ${totalBlankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS})`, 'WARN', 'cycle');
          totalBlankRecoveryAttempts++;
          // TASK 109: Budget check on reload path too
          if (totalBlankRecoveryAttempts >= MAX_BLANK_RECOVERY_ATTEMPTS) {
            log(`Blank-page recovery budget EXHAUSTED on reload step (${totalBlankRecoveryAttempts}/${MAX_BLANK_RECOVERY_ATTEMPTS}). Stopping and alerting.`, 'ERROR', 'cycle');
            try { getDep('alerting')?.sendAlert?.(`MathU Bot stuck: ${totalBlankRecoveryAttempts} blank-page recovery attempts failed. Flutter Web app not rendering.`); } catch {}
            (globalThis as any).__humanInterventionRequested = true;
            (globalThis as any).__humanInterventionReason = `Blank-page recovery budget exhausted (${totalBlankRecoveryAttempts} attempts).`;
            break;
          }
          const targetUrl = _getRecoveryUrl();
          if (targetUrl) {
            try {
              await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => {
                log(`blank_page reload failed: ${e.message || e}`, 'WARN', 'cycle');
              });
              await new Promise(r => setTimeout(r, 8000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch (navErr: any) {
              log(`blank_page reload failed: ${navErr.message || navErr}`, 'WARN', 'cycle');
            }
          }
          lastScreenshotChangeTime = Date.now();
          continue;
        }
        // First blank page: navigate to APP_URL (original behavior)
        const targetUrl = _getRecoveryUrl();
        if (targetUrl) {
          try {
            log(`blank_page escape (step ${blankPageCounter}): navigating to ${targetUrl}`, 'INFO', 'cycle');
            await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => {
              log(`blank_page escape: navigation failed: ${e.message || e}`, 'WARN', 'cycle');
            });
            await new Promise(r => setTimeout(r, 8000));
            if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
          } catch (navErr: any) {
            log(`blank_page escape failed: ${navErr.message || navErr}`, 'WARN', 'cycle');
          }
        }
        if (_actionCacheSig && actionCache?.evictEntry) {
          try { actionCache.evictEntry(_actionCacheSig); } catch {}
        }
        // v11: Also flush any cached wait/unknown actions — they're
        // poisoning the cache when the page is blank
        if (actionCache?.flushActionsByType) {
          try { actionCache.flushActionsByType('wait'); } catch {}
        } else if (actionCache?.evictAll) {
          try { actionCache.evictAll(); } catch {}
        }
        lastScreenshotChangeTime = Date.now();
        continue;
      } else if (action.currentState === 'error') {
        // 20-min stagnation auto-ban for error loops
        const timeSinceScreenshotChange = Date.now() - lastScreenshotChangeTime;
        const timeSinceQuestionCompletion = Date.now() - lastQuestionCompletionTime;
        if (!stagnationAutoBanTriggered
            && action.actionType === 'wait'
            && timeSinceScreenshotChange > STAGNATION_AUTO_BAN_MS
            && timeSinceQuestionCompletion > STAGNATION_AUTO_BAN_MS) {
          log(`20-min stagnation detected in error loop (no screenshot change, no completions). Triggering runtime heal + auto-banning wait action.`, 'WARN', 'cycle');
          // v9: Trigger runtime heal FIRST — same as unknown-loop stagnation
          try {
            const selfHealMod = getDep('selfHeal');
            if (selfHealMod?.performRuntimeHeal && CONFIG.SELF_HEAL_ENABLED) {
              selfHealMod.performRuntimeHeal().then((rtResult: any) => {
                if (rtResult?.healed) {
                  log(`Stagnation runtime heal succeeded: ${rtResult.results?.filter((r: any) => r.healed).map((r: any) => r.avenue).join(', ')}`, 'INFO', 'cycle');
                }
              }).catch(() => {});
            }
          } catch {}
          // Also request self-heal session if in memory protection
          try {
            const memoryMode = require('./memory-mode');
            if (memoryMode.isMemoryProtection?.()) {
              memoryMode.beginSelfHealSession?.('stagnation_20min_error_loop');
            }
          } catch {}
          try {
            const dbMod = require('./database');
            dbMod.insertBannedAction?.('wait', 'stagnation-guard', Date.now() + 60 * 60 * 1000);
          } catch { /* non-critical */ }
          stagnationAutoBanTriggered = true;
          try {
            const sendAlert = require('./alerting').sendAlert;
            // TASK 61: Removed alert — routine event.
          } catch { /* non-critical */ }
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          lastScreenshotChangeTime = Date.now();
          continue;
        }
      } else {
        unknownStateCounter = 0;
        blankPageCounter = 0; // Reset blank-page counter on any non-unknown/non-blank state
        // Auto-rearm: if screenshot changes within 60s of ban, clear the flag
        if (stagnationAutoBanTriggered && (Date.now() - lastScreenshotChangeTime) < 60000) {
          stagnationAutoBanTriggered = false;
          try {
            const dbMod = require('./database');
            dbMod.deleteBannedAction?.('wait', 'stagnation-guard');
          } catch { /* non-critical */ }
        }
      }

      // Exploration mode
      if (consecutiveTribunalFailures >= CONFIG.EXPLORATION_CONSECUTIVE_FAILURES && CONFIG.ENABLE_EXPLORATION_PASS && explorationCartographer) {
        log(`${consecutiveTribunalFailures} consecutive tribunal failures. Entering exploration mode.`, 'WARN', 'cycle');
        explorationMode = true;
        explorationMap = await explorationCartographer.explore(page);
        if (explorationMap) { log('Exploration map built. Continuing with enhanced context.', 'INFO', 'cycle'); consecutiveTribunalFailures = 0; } else { log('Exploration failed to produce map.', 'WARN', 'cycle'); }
      }

      // Stuck recovery
      if (stuckCounter >= MAX_STUCK) {
        log(`Stuck for ${MAX_STUCK} cycles. Attempting recovery.`, 'WARN', 'cycle');
        if (humanCaptcha) {
          const restored = await humanCaptcha.tryAllSessions(page);
          if (restored) { log('Session pool restored access.', 'INFO', 'cycle'); stuckCounter = 0; }
        }
        if (stuckCounter >= MAX_STUCK) {
          // v10: Try self-heal FIRST (runtime heal is fast, non-destructive)
          // before falling back to the heavier GitOps approach.
          if (CONFIG.SELF_HEAL_ENABLED && !selfHealRunning) {
            const selfHealMod = getDep('selfHeal');
            if (selfHealMod?.performRuntimeHeal) {
              log(`Stuck ${MAX_STUCK} cycles — triggering runtime heal as stuck recovery`, 'INFO', 'cycle');
              try {
                const memoryMode = require('./memory-mode');
                if (memoryMode.isMemoryProtection?.()) {
                  memoryMode.beginSelfHealSession?.(`stuck_${MAX_STUCK}_cycles`);
                }
              } catch {}
              selfHealMod.performRuntimeHeal().then((rtResult: any) => {
                if (rtResult?.healed) {
                  log(`Stuck recovery: runtime heal succeeded`, 'INFO', 'cycle');
                  stuckCounter = 0;
                }
              }).catch(() => {});
            }
          }
          // GitOps fallback (existing behavior)
          const codegenTribunal = _getCodegenTribunal();
          if (codegenTribunal) {
          // Build investigation with actual file content for the tribunal
          let cmFileContent = '';
          let cmTargetFile = 'cycle-cycle-manager.ts';
          try {
            const cmPath = require('path').join(require('./project-root').PROJECT_ROOT, cmTargetFile);
            if (require('fs').existsSync(cmPath)) {
              cmFileContent = require('fs').readFileSync(cmPath, 'utf8').substring(0, 8000);
            }
          } catch (e: any) { /* non-critical */ }
          const investigation = { url: page.url(), html: await page.content(), fileContent: cmFileContent, targetFile: cmTargetFile };
          const errorLogs = `Stuck for ${MAX_STUCK} cycles at state ${currentState}`;
          const signal = AbortSignal.timeout(120_000);
          const fixes = await codegenTribunal.generateCodeFixViaTribunal(investigation, errorLogs, signal);
          if (fixes && fixes.length > 0 && CONFIG.GITOPS_ENABLED && gitOps?.applyAndVerify) {
            try { await gitOps.applyAndVerify(fixes); log('Self-heal applied via GitOps. Restarting cycle.', 'INFO', 'cycle'); throw new Error('RESTART_CYCLE'); } catch (e: any) { if (e.message === 'RESTART_CYCLE') throw e; gitOps.rollbackToPrevious?.(); }
          }
          } // end codegenTribunal block
        }
      }

      currentState = action.currentState;

      // BUG FIX (2026-09-07): Reset app_error counter when a non-error state is detected
      if (action.currentState !== 'app_error' && action.currentState !== 'error') {
        _appErrorCount = 0;
      }

      // BUG FIX (2026-09-06): Record CAPTCHA only when the AI (tribunal) actually
      // reports seeing a captcha — not on every cycle. The AI sets currentState
      // to "captcha" when it sees an actual captcha challenge in the screenshot.
      if (action.currentState === 'captcha') {
        authCaptchaLoopGuard?.recordCaptcha?.();
      }
      // v6: Track mid-quiz state for browser-preserving memory shedding.
      // We're "mid-quiz" when the state indicates we're on a question page
      // (not assignments, not score screen, not module downloading).
      // This drives the preserveBrowser flag in memory protection.
      const _quizStates = new Set(['question', 'question_m mcq', 'question_input', 'keypad', 'question_feedback', 'explanation', 'assessment', 'quiz_active']);
      _midQuiz = _quizStates.has(action.currentState || '') || (action.currentState === 'question' || action.actionType === 'keypad_input' || action.actionType === 'keypad_sequence');
      // Also update the module-level flag so render-free-plan monitor can read it
      try { const memoryMode = require('./memory-mode'); memoryMode.setMidQuiz(_midQuiz); } catch {}
      // ── Dashboard state ban enforcement ──
      // If the current state has been banned from the dashboard, skip
      // it and force a page reload to escape the banned state.
      try {
        const persistConfig = require('./persistent-config');
        if (persistConfig.isStateBanned(currentState)) {
          log(`State '${currentState}' is banned via dashboard — forcing page reload to escape`, 'WARN', 'cycle');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          currentState = 'assignments_page'; // Reset to safe state
          continue; // Re-evaluate on next iteration
        }
      } catch { /* non-critical: persistent-config not available */ }
      if (questionsCompleted > 0) {
        lastProgressTime = Date.now();
      } else if (Date.now() - lastProgressTime > CONFIG.PROGRESS_TIMEOUT_MS) {
        // v6: Progress timeout — throw a CLASSIFIED error so self-heal can trigger.
        // Previously this was a plain Error which fell through as 'fatal' (not retryable,
        // not healable), so self-heal NEVER fired on progress stalls. The bot just
        // retried the cycle endlessly. Now we throw a structured error with a
        // healable code so _isDesperatelyBroken recognizes it.
        const progressErr: any = new Error(`Progress timeout: 0 questions completed in ${Math.round(CONFIG.PROGRESS_TIMEOUT_MS / 60000)}min`);
        progressErr.code = 'E_PROGRESS_STALL';
        progressErr.retryable = false;
        progressErr.healable = true;
        throw progressErr;
      }

      // v6: Slow progress detection — even if some questions completed, if we
      // haven't completed ANY in PROGRESS_SLOW_TIMEOUT_MS, the bot is likely
      // stuck in a loop (answering the same question wrong, clicking the wrong
      // button, etc.). This is structurally broken behavior that self-heal should
      // investigate. Uses a separate, longer timeout than the zero-progress case.
      // Default: 2x PROGRESS_TIMEOUT_MS (120min with default 60min config).
      const SLOW_PROGRESS_MS = (CONFIG.PROGRESS_SLOW_TIMEOUT_MS || CONFIG.PROGRESS_TIMEOUT_MS * 2);
      if (questionsCompleted > 0 && Date.now() - lastProgressTime > SLOW_PROGRESS_MS) {
        const slowErr: any = new Error(`Slow progress: last question completion was ${Math.round((Date.now() - lastProgressTime) / 60000)}min ago`);
        slowErr.code = 'E_SLOW_PROGRESS';
        slowErr.retryable = false;
        slowErr.healable = true;
        throw slowErr;
      }

      // ── 20-Minute Zero-Progress Self-Heal Trigger ──
      // If 0 questions completed in 20 minutes, full self-heal fires DIRECTLY.
      // Uses 4 independent time avenues. 2 of 4 must agree. No gates.
      try {
        if (questionsCompleted === 0 && !_zeroProgressHealTriggered && !selfHealRunning) {
          let stuckVotes = 0;
          let avenues: string[] = [];

          // Avenue 1: Wall clock — time since cycle started
          const wallElapsed = Date.now() - cycleStart;
          if (wallElapsed >= ZERO_PROGRESS_STUCK_MS) {
            stuckVotes++;
            avenues.push(`wall=${Math.round(wallElapsed / 60000)}min`);
          }

          // Avenue 2: DB progress log — any progress entries in last 20 minutes?
          try {
            const dbMod = require('./database');
            const db = dbMod.db;
            if (db) {
              const recentProgress = db.prepare(
                `SELECT COUNT(*) as cnt FROM progress_log WHERE timestamp > ?`
              ).get(Date.now() - ZERO_PROGRESS_STUCK_MS);
              if (recentProgress && recentProgress.cnt === 0) {
                stuckVotes++;
                avenues.push('db_progress=0');
              }
            }
          } catch { /* progress_log table might not exist */ }

          // Avenue 3: Cycle count × estimated iteration time
          const cycleCount = getStats().cycleCount || 0;
          if (cycleCount >= ZERO_PROGRESS_MIN_CYCLES) {
            const estimatedMs = cycleCount * 40000;
            if (estimatedMs >= ZERO_PROGRESS_STUCK_MS) {
              stuckVotes++;
              avenues.push(`cycles=${cycleCount}\u00d740s`);
            }
          }

          // Avenue 4: Heartbeat file mtime — process is alive (heartbeat fresh)
          // but cycle has been running for 10+ min with zero output.
          try {
            const fs = require('fs');
            const stat = fs.statSync(CONFIG.HEARTBEAT_FILE);
            const heartbeatAge = Date.now() - stat.mtimeMs;
            if (heartbeatAge < 60000 && wallElapsed >= ZERO_PROGRESS_STUCK_MS) {
              stuckVotes++;
              avenues.push('heartbeat_confirmed');
            }
          } catch { /* heartbeat file might not exist */ }

          // TRIGGER: 2+ avenues agree -> full self-heal, no gates
          if (stuckVotes >= ZERO_PROGRESS_VOTES_NEEDED) {
            _zeroProgressHealTriggered = true;
            const errMsg = `ZERO PROGRESS for 20+ minutes (${avenues.join(', ')}). Triggering full self-heal directly.`;
            log(errMsg, 'ERROR', 'cycle');

            _recordErrorForDesperation('E_ZERO_PROGRESS');

            try {
              const sendAlert = require('./alerting').sendAlert;
              // TASK 61: Removed alert — routine event.
            } catch {}

            // DIRECT full self-heal - bypass _isDesperatelyBroken, bypass
            // consecutive failure count, bypass circuit breaker.
            if (CONFIG.SELF_HEAL_ENABLED) {
              // v14: Use try/finally to guarantee selfHealRunning is reset.
              // The outer catch (zpErr) at line ~2647 does NOT reset it,
              // so a throw from require('./self-heal') would stick it at true
              // for the rest of the process lifetime.
              try {
              selfHealRunning = true;
              const selfHealMod = require('./self-heal');

              // Step 1: Runtime heal (clear stuck state)
              const performRuntimeHeal = selfHealMod.performRuntimeHeal;
              if (typeof performRuntimeHeal === 'function') {
                log('Zero-progress: calling performRuntimeHeal() directly...', 'WARN', 'cycle');
                try {
                  const rtResult = await performRuntimeHeal();
                  if (rtResult?.healed) {
                    const av = rtResult.results?.filter((r: any) => r.healed).map((r: any) => r.avenue).join(', ');
                    log(`Zero-progress runtime heal succeeded: ${av}`, 'INFO', 'cycle');
                  }
                } catch (rtErr: any) {
                  log(`Zero-progress runtime heal error: ${rtErr.message}`, 'WARN', 'cycle');
                }
              }

              // Step 2: Full self-heal (code-patch pipeline) - ALWAYS runs
              const performSelfHeal = selfHealMod.performSelfHeal;
              if (typeof performSelfHeal === 'function') {
                log('Zero-progress: attempting FULL self-heal (code-patch pipeline)...', 'ERROR', 'cycle');
                try {
                  try {
                    const memoryMode = require('./memory-mode');
                    if (memoryMode.isMemoryProtection?.()) {
                      memoryMode.beginSelfHealSession?.('zero_progress_20min');
                    }
                  } catch {}

                  const fullHealed = await performSelfHeal({ skipRuntimeHeal: true });
                  if (fullHealed) {
                    log('Zero-progress FULL self-heal SUCCEEDED — restarting process to apply changes cleanly', 'INFO', 'cycle');
                    consecutiveFailures = 0;
                    // After a successful zero-progress self-heal, the process must
                    // RESTART (not just reload the page). The heal may have cleared
                    // caches, reset providers, and patched code via overlay — but
                    // the running cycle has stale state (blank page, dead browser
                    // context, exhausted action cache). A clean restart lets the
                    // new instance boot fresh, navigate to APP_URL, and start
                    // completing questions immediately.
                    // On Render: exit(1) triggers auto-restart.
                    try {
                      const sendAlert = require('./alerting').sendAlert;
                      // TASK 61: Removed alert — routine event.
                    } catch {}
                    try { await (getDep('shutdown')?.gracefulShutdown || (() => Promise.resolve()))('zero-progress-heal-restart'); } catch {}
                    process.exit(1);
                  } else {
                    log('Zero-progress FULL self-heal found no fixable issues', 'WARN', 'cycle');
                  }
                } catch (fullErr: any) {
                  log(`Zero-progress full heal threw: ${fullErr.message}`, 'ERROR', 'cycle');
                }
              }
              } finally {
                selfHealRunning = false;
              }
            }

            // Force a page reload after heal to break any visual loop
            try {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
              lastScreenshotChangeTime = Date.now();
            } catch {}
          }
        }
      } catch (zpErr: any) {
        // Zero-progress detector must NEVER crash the cycle loop
        logError('Zero-progress detector error (non-fatal)', zpErr);
      }

      // v15: Self-improvement cycle — make the bot stronger, not just alive.
      // Runs every 2 hours if conditions are met (enough data, no recent
      // rollback, daily limit not reached). Analyzes performance bottlenecks
      // and asks the codegen tribunal to implement improvements.
      try {
        const improver = getDep('selfHealImprover') || (() => { try { return require('./self-heal-improver'); } catch { return null; } })();
        if (improver?.shouldImprove?.()) {
          log('Triggering self-improvement cycle...', 'INFO', 'cycle');
          const improved = await improver.performSelfImprovement();
          if (improved) {
            log('Self-improvement applied successfully', 'INFO', 'cycle');
          }
        }
      } catch (impErr: any) {
        // Self-improvement must NEVER crash the cycle loop
        log(`Self-improvement error (non-fatal): ${impErr.message || impErr}`, 'DEBUG', 'cycle');
      }

      // Save session to pool (non-critical — never crash the cycle if browser died)
      if (humanCaptcha) {
        try {
          const storage = await page.context().storageState();
          humanCaptcha.saveSessionToPool(storage);
        } catch (_sessionErr: any) {
          // Browser may have been closed by self-heal, OOM, or crash —
          // session pool save is best-effort only.
          log(`Session pool save skipped: ${_sessionErr.message || _sessionErr}`, 'DEBUG', 'cycle');
        }
      }
    }

    // Post-cycle alerting
    if (clickAttempts > 5) {
      const successRate = clickSuccesses / clickAttempts;
      if (successRate < 0.3) { log(`Click executor failure rate high (${((1 - successRate) * 100).toFixed(0)}%).`, 'WARN', 'cycle'); }
    }
    log(`Cycle complete: ${questionsCompleted} questions processed`, 'INFO', 'cycle');
    consecutiveFailures = 0;

    // TASK 83 (2026-09-25): If the cycle ended with 0 questions completed,
    // signal the orchestrator to use a SHORT sleep (2 min) instead of the
    // normal 15-30 min sleep. This way, if vision providers were rate-limited,
    // the bot retries quickly instead of sleeping for 23 minutes.
    // The orchestrator checks (globalThis as any).__cycleZeroQuestions.
    if (questionsCompleted === 0) {
      (globalThis as any).__cycleZeroQuestions = true;
      log('Cycle ended with 0 questions — orchestrator will use short retry delay (2 min) instead of normal sleep.', 'INFO', 'cycle');
    } else {
      (globalThis as any).__cycleZeroQuestions = false;
    }

    // ─── Training maintenance: prune old data every 50 cycles ───
    const _cycleNum = getStats().cycleCount || 0;
    if (_cycleNum % 50 === 0) {
      try {
        const pixelTraining = require('./pixel-training');
        if (pixelTraining?.getStatus?.()?.dbRowCount > 200) {
          // pruneOldData not in existing API — rely on MAX_SAMPLES_PER_STATE in recordSuccess
          log(`Training data: ${pixelTraining.getStatus().dbRowCount} entries in DB`, 'DEBUG', 'cycle');
        }
      } catch {}
    }
  } catch (err: any) {
    // v18: If the browser was closed by memory protection mid-cycle,
    // this is NOT a real error — just relaunch and continue. Don't
    // increment consecutiveFailures (that would trigger self-heal
    // and circuit breakers for a non-issue).
    const errMsg = err?.message || String(err);
    if (errMsg.includes('Target page, context or browser has been closed')
        || errMsg.includes('Browser closed')
        || errMsg.includes('browser has been closed')) {
      log('Cycle caught browser-closed error (likely memory protection). Resetting failure count — not a real error.', 'WARN', 'cycle');
      consecutiveFailures = 0;
      // Don't push to self-heal error buffer — this is expected behavior
      // Don't run self-heal — nothing to heal
    } else {
      const errorType = classifyProviderError?.(err);
    // v6: Fall back to properties set directly on the error object.
    // classifyProviderError only recognizes MathUBotError instances and
    // common Node/Playwright patterns. Custom structured errors (like
    // progress stalls) carry their own code/retryable/healable.
    const isRetryable = errorType?.retryable ?? err.retryable ?? false;
    const isHealable = errorType?.healable ?? err.healable ?? false;
    const errorCode = errorType?.code || err.code || 'E_UNKNOWN';
    // v17: Include stack trace for unrecognised errors so the source
    // can be identified. Only log the full stack for errors that lack
    // a structured code (E_UNKNOWN) — structured errors already carry
    // enough context in their message.
    if (errorCode === 'E_UNKNOWN' && err?.stack) {
      const stackLines = (err.stack as string).split('\n').slice(0, 6).join('\n  ');
      logError(`Cycle error (${errorCode}) STACK: ${stackLines}`, err);
    } else {
      logError(`Cycle error (${errorCode})`, err);
    }
    // v14: Push error into self-heal's error buffer so the codegen
    // tribunal gets actual error messages (not just a count) when
    // diagnosing what went wrong. This is the #1 improvement:
    // "Send actual error logs, not a count."
    try {
      const selfHealMod = getDep('selfHeal') || require('./self-heal');
      if (selfHealMod?.pushSelfHealError) {
        const errMsg = err?.message || String(err);
        const errStack = err?.stack ? `\n${(err.stack as string).split('\n').slice(1, 4).join('\n')}` : '';
        selfHealMod.pushSelfHealError(`${errorCode}: ${errMsg}${errStack}`, 'cycle-manager');
      }
    } catch {}
    // Resilience: report failure to cascade breaker
    cascadeBreaker?.recordFailure?.('cycleManager', err);
    // Resilience: report failure to module quarantine
    runtimeModuleQuarantine?.recordFailure?.('cycleManager', err);
    updateStats({ errors: (getStats().errors || 0) + 1 });
    consecutiveFailures++;
    // v4: Record error code for desperation analysis
    _recordErrorForDesperation(errorCode);
    if (CONFIG.ALERT_ON_ERROR) try {
      // TASK 42 (2026-09-10): Suppress cycle-error alerts when human
      // intervention is already requested. The initial alert was already
      // sent — repeating it on every cycle burns ntfy quota and may
      // cause rate limiting that blocks genuinely important alerts.
      if ((globalThis as any).__humanInterventionRequested) {
        log('Cycle error alert suppressed (human intervention already requested — initial alert was sent)', 'DEBUG', 'cycle');
      } else {
        const alertMsg = err instanceof Error ? err.message : String(err);
        const alertStack = err?.stack ? `\n${(err.stack as string).split('\n').slice(1, 5).join('\n')}` : '';
        sendAlert(`Cycle error: ${alertMsg}${alertStack}`);
      }
    } catch (e: any) {}

    // Error routing based on type
    const isErrorTransient = isRetryable && !isHealable;
    const isErrorFatal = !isRetryable && !isHealable;

    if (isErrorTransient) {
      log('Transient error -- will retry next cycle', 'WARN', 'cycle');
      // v10: Error-rate spike override — even transient errors trigger runtime
      // heal if they're coming in fast enough. 6+ errors in 2min suggests
      // something systemic (broken network interceptor, stuck rate limiter).
      //
      // v11: OOM EMERGENCY OVERRIDE — when the restart guardian is in
      // emergency mode (detected OOM loop), self-heal MUST fire regardless
      // of error classification. Without this, a cycle that only sees 429s
      // (transient) never reaches _isDesperatelyBroken() because it's in
      // the wrong branch of the if/else chain. The bot knows it's in an
      // OOM loop but self-heal never runs.
      const isEmergencyMode = (() => { try { return require('./survival-restart-guardian').isEmergencyMode?.(); } catch { return false; } })();
      if (CONFIG.SELF_HEAL_ENABLED && !selfHealRunning && (_isErrorRateSpiking() || isEmergencyMode)) {
        const reason = isEmergencyMode ? 'OOM emergency mode' : 'error-rate spike';
        // In OOM emergency, call performRuntimeHeal DIRECTLY (bypasses circuit
        // breaker). The normal getDep path goes through the circuit breaker
        // wrapper which may be OPEN from previous failed heals.
        const healFn = isEmergencyMode
          ? (() => { try { return require('./self-heal').performRuntimeHeal; } catch { return null; } })()
          : getDep('selfHeal')?.performRuntimeHeal;
        if (healFn) {
          log(`${reason} detected — triggering runtime heal despite transient classification`, 'WARN', 'cycle');
          try {
            const memoryMode = require('./memory-mode');
            if (memoryMode.isMemoryProtection?.()) {
              memoryMode.beginSelfHealSession?.(isEmergencyMode ? 'oom_emergency_transient' : 'error_rate_spike');
            }
          } catch {}
          selfHealRunning = true;
          healFn().then((rtResult: any) => {
            selfHealRunning = false;
            if (rtResult?.healed) {
              log(`${reason}: runtime heal succeeded`, 'INFO', 'cycle');
              consecutiveFailures = Math.max(0, consecutiveFailures - 2);
              // Reset circuit breaker on successful OOM emergency heal
              if (isEmergencyMode) {
                try {
                  const cb = require('./self-heal-circuit-breaker');
                  const breaker = cb.healerCircuitBreaker || cb;
                  if (typeof breaker.reset === 'function') breaker.reset();
                } catch {}
              }
            }
          }).catch(() => { selfHealRunning = false; });
        }
      }
    } else if (isErrorFatal) {
      log('Fatal error -- restarting cycle', 'ERROR', 'cycle');
    } else {
      // v9: FAST RUNTIME HEAL — fires on FIRST healable error (progress stall,
      // restart loop, selector drift, etc.) without waiting for desperation.
      // This is the key new trigger: self-heal activates early via runtime
      // avenues (DB repair, provider reset, config reconcile, cache flush).
      // If those don't help, the old desperate-check + code-patch path runs.
      if (CONFIG.SELF_HEAL_ENABLED && !selfHealRunning && isHealable) {
        const performRuntimeHeal = getDep('selfHeal')?.performRuntimeHeal;
        if (performRuntimeHeal) {
          log(`Healable error ${errorCode} — triggering fast runtime heal (failure #${consecutiveFailures})`, 'INFO', 'cycle');
          // Request self-heal session if in memory protection (runtime heal
          // may need full-power modules like config-reconciler)
          try {
            const memoryMode = require('./memory-mode');
            if (memoryMode.isMemoryProtection?.()) {
              memoryMode.beginSelfHealSession?.(`healable_error:${errorCode}`);
            }
          } catch {}
          // Fire runtime heal in background — don't block the cycle
          performRuntimeHeal().then((rtResult: any) => {
            if (rtResult?.healed) {
              const avenues = rtResult.results?.filter((r: any) => r.healed).map((r: any) => r.avenue).join(', ');
              log(`Fast runtime heal SUCCEEDED for ${errorCode}: ${avenues}`, 'INFO', 'cycle');
              // If runtime heal fixed something, reset a portion of consecutive failures
              // (don't reset to 0 — the underlying issue may still exist, but the
              // runtime state is now cleaner so the next attempt is more likely to work)
              consecutiveFailures = Math.max(0, consecutiveFailures - 2);
            }
          }).catch(() => {});
        }
      }

      // v4: Full self-heal when the bot is DESPERATELY broken.
      // See _isDesperatelyBroken() for the full criteria.
      //
      // TASK 70 (2026-09-23): Pass `skipRuntimeHeal: true` so we go DIRECTLY
      // to the codegen tribunal. Previously this call omitted the option, so
      // performSelfHeal() ran the runtime heal fast-pass first — which always
      // "succeeded" (clearing caches always returns true) — and returned
      // `true` WITHOUT ever invoking the codegen tribunal. That meant the
      // "Full self-heal successful" log was misleading: no code fix was ever
      // generated, no AI was consulted, no patch was applied. The bot would
      // then reset the failure count and continue with the same broken state.
      //
      // The runtime heal fast-pass is still useful for transient issues
      // (already triggered earlier in this cycle via the runtime-heal-on-error
      // block above), so by the time we reach this DESPERATE trigger, runtime
      // avenues have already been exhausted. Skipping them here ensures the
      // codegen tribunal actually runs.
      if (CONFIG.SELF_HEAL_ENABLED && !selfHealRunning && performSelfHeal && _isDesperatelyBroken(CONFIG)) {
        // Build a human-readable reason for WHY self-heal triggered
        const healReason = _getSelfHealReason(CONFIG);
        log(`${consecutiveFailures} consecutive failures (DESPERATE: ${healReason}). Attempting full self-heal (code-patch pipeline)...`, 'WARN', 'cycle');
        selfHealRunning = true;
        performSelfHeal({ skipRuntimeHeal: true }).then((healed: any) => { 
          selfHealRunning = false;
          if (healed) { log('Full self-heal successful. Resetting failure count.', 'INFO', 'cycle'); consecutiveFailures = 0; }
          else { log('Self-heal failed. Alerting and stopping.', 'ERROR', 'cycle'); if (CONFIG.ALERT_ON_ERROR) try { sendAlert('Self-heal failed after multiple attempts. Stopping.'); } catch (e: any) {} stopRequested = true; }
        }).catch((e: any) => { selfHealRunning = false; logError('Self-heal threw error', e); });
      } else if (CONFIG.SELF_HEAL_ENABLED && consecutiveFailures >= CONFIG.SELF_HEAL_FAILURE_THRESHOLD) {
        log(`${consecutiveFailures} consecutive failures but NOT desperate (transient/error pattern). Skipping full self-heal. Will keep retrying.`, 'DEBUG', 'cycle');
      }
      if (consecutiveFailures % 5 === 0) {
        try { const pd = _getProviderDiscovery(); if (pd?.refreshAllProviderModels) pd.refreshAllProviderModels().catch((e: any) => logError('Model refresh failed', e)); } catch (e: any) { /* non-critical */ }
      }
      if (consecutiveFailures % 10 === 0) {
        try { const pr = _getProcessRetrainer(); if (pr?.retrainProcesses) pr.retrainProcesses().catch((e: any) => logError('Retraining failed', e)); } catch (e: any) { /* non-critical */ }
      }
    } // end else (non-browser-closed error)
  } // end catch
  } finally {
    // v16: Snapshot cycle state to DB (OOM-survival).
    // Runs every cycle. Writes ~1-3 KB to the calibration table.
    // If the process is SIGKILL'd (OOM), this is the last state that survives.
    _snapshotCycleState();

    // v6: Clear mid-quiz flag so monitors don't preserve browser after cycle ends
    try { const memoryMode = require('./memory-mode'); memoryMode.setMidQuiz(false); } catch {}
    // TASK 42 (2026-09-10): Do NOT close the browser if human intervention
    // is requested. The user may need to interact with the browser (e.g.
    // Microsoft password-reset page, captcha, MFA enrollment). Closing
    // the browser would destroy the page state and force a re-navigate
    // cycle that re-triggers the same human-intervention condition.
    // The bot will pause at the top of the next cycle iteration and NOT
    // touch the browser until the user resumes via dashboard.
    //
    // TASK 87 (2026-09-25): PROTECT BROWSER AT ALL COSTS.
    // User: "No browser, No progress." The browser is NEVER closed at the
    // end of a cycle, even on errors. This preserves the page state so
    // the next cycle can continue where it left off.
    log('Keeping browser open (Task 87: protect browser at all costs) — page state preserved for next cycle.', 'INFO', 'cycle');
    if (clearCache) clearCache();
    _networkSetup = false;
    if (CONFIG.ENABLE_GC_ON_CYCLE && global.gc) { global.gc(); log('Garbage collection triggered.', 'DEBUG', 'cycle'); }
  }
}

module.exports = { runCycle, requestStop, isOrParked: () => _orParked, _injectDependencies, restoreCycleState: _restoreCycleState };
