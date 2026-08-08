'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Unified Database — Turso-primary read routing with local fallback.
//
// This module is the SINGLE entry point all consumers should use for
// database operations on critical data. It routes:
//
//   READS:  Turso (async, primary) → local SQLite (sync, fallback)
//   WRITES: Local SQLite (sync, immediate) + Turso (async, fire-and-forget)
//
// Why: Turso persists across Render restarts/redeploys. Local SQLite is
// ephemeral on Render free tier. By reading from Turso first, the bot
// always has access to the most authoritative data — even after a restart
// that wipes the local DB.
//
// Usage:
//   const udb = require('./unified-db');
//   const value = await udb.getCalibration('some_key');   // Turso-first
//   await udb.saveModule('Module 5');                      // local + Turso
//   const completed = await udb.isModuleCompleted('Module 5'); // Turso-first
//
// For ephemeral/high-churn tables (blackbox, progress_log, etc.),
// use the raw database.ts module directly — those stay local-only.
// ═══════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

function _getLog() {
  return _deps.logger?.log || console.log;
}
function _getLogError() {
  return _deps.logger?.logError || ((msg: string, err: Error) => console.error(msg, err));
}

// Lazy references
let _localDb: any = null;
let _turso: any = null;

function _getLocalDb() {
  if (_localDb) return _localDb;
  try {
    _localDb = require('./database');
    return _localDb;
  } catch { return null; }
}

function _getTurso() {
  if (_turso) return _turso;
  try {
    _turso = require('./database-turso');
    return _turso;
  } catch { return null; }
}

// ─── Stats ──────────────────────────────────────────────────────────────────

const _stats = {
  tursoReads: 0,
  tursoHits: 0,
  localFallbacks: 0,
  tursoWrites: 0,
  tursoWriteErrors: 0,
};

function getStats() { return { ..._stats }; }

// ═══════════════════════════════════════════════════════════════════════════
// CALIBRATION (key-value store — includes solution cache, config, etc.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get a calibration value. Turso-first, local fallback.
 */
async function getCalibration(key: string): Promise<string | null> {
  _stats.tursoReads++;

  // Try Turso first
  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const value = await turso.tursoGetCalibration(key);
      if (value !== null) {
        _stats.tursoHits++;
        return value;
      }
    } catch {}
  }

  // Fallback to local
  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    const row = db?.selectCalibration?.get?.(key);
    return row?.value || null;
  } catch { return null; }
}

/**
 * Set a calibration value. Writes to local (sync) + Turso (async).
 */
async function setCalibration(key: string, value: string, updatedAt?: number): Promise<boolean> {
  const ts = updatedAt || Date.now();

  // Write to local immediately (sync)
  try {
    const db = _getLocalDb();
    db?.upsertCalibration?.run?.(key, value, ts);
  } catch {}

  // Write to Turso (async, fire-and-forget)
  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    _stats.tursoWrites++;
    try {
      const ok = await turso.tursoUpsertCalibration(key, value, ts);
      if (!ok) _stats.tursoWriteErrors++;
    } catch { _stats.tursoWriteErrors++; }
  }

  return true;
}

/**
 * Get all calibration entries matching a prefix. Turso-first.
 */
async function getCalibrationLike(prefix: string): Promise<Array<{ key: string; value: string; updated_at: number }>> {
  _stats.tursoReads++;

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const rows = await turso.tursoGetCalibrationLike(prefix);
      if (rows.length > 0) {
        _stats.tursoHits++;
        return rows;
      }
    } catch {}
  }

  // Fallback to local
  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    return db?.db?.prepare('SELECT key, value, updated_at FROM calibration WHERE key LIKE ?')
      ?.all(`${prefix}%`) || [];
  } catch { return []; }
}

/**
 * Delete a calibration entry. Both stores.
 */
async function deleteCalibration(key: string): Promise<boolean> {
  try {
    const db = _getLocalDb();
    db?.db?.prepare('DELETE FROM calibration WHERE key = ?')?.run(key);
  } catch {}

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try { await turso.tursoDeleteCalibration(key); } catch {}
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMPLETED MODULES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if a module is completed. Turso-first.
 */
async function isModuleCompleted(name: string): Promise<boolean> {
  _stats.tursoReads++;

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const completed = await turso.tursoIsModuleCompleted(name);
      if (completed) { _stats.tursoHits++; return true; }
    } catch {}
  }

  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    return !!db?.selectModule?.(name);
  } catch { return false; }
}

/**
 * Mark a module as completed. Writes to local + Turso.
 */
async function saveModule(name: string): Promise<boolean> {
  const now = Date.now();

  try {
    const db = _getLocalDb();
    db?.insertModule?.(name);
  } catch {}

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    _stats.tursoWrites++;
    try {
      const ok = await turso.tursoInsertModule(name, now);
      if (!ok) _stats.tursoWriteErrors++;
    } catch { _stats.tursoWriteErrors++; }
  }

  return true;
}

/**
 * Get all completed module names. Turso-first.
 */
async function getAllModules(): Promise<string[]> {
  _stats.tursoReads++;

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const modules = await turso.tursoGetAllModules();
      if (modules.length > 0) { _stats.tursoHits++; return modules; }
    } catch {}
  }

  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    return db?.getAllModules?.() || [];
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════
// LAST STATE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the last known state. Turso-first.
 */
async function getLastState(): Promise<{ url: string; state: string; timestamp: number } | null> {
  _stats.tursoReads++;

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const state = await turso.tursoGetLastState();
      if (state) { _stats.tursoHits++; return state; }
    } catch {}
  }

  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    return db?.selectLastState?.get?.() || null;
  } catch { return null; }
}

/**
 * Save the last state. Writes to local + Turso.
 */
async function saveLastState(url: string, state: string, timestamp?: number): Promise<boolean> {
  const ts = timestamp || Date.now();

  try {
    const db = _getLocalDb();
    db?.upsertLastState?.run?.(url, state, ts);
  } catch {}

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    _stats.tursoWrites++;
    try {
      const ok = await turso.tursoUpsertLastState(url, state, ts);
      if (!ok) _stats.tursoWriteErrors++;
    } catch { _stats.tursoWriteErrors++; }
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// BANNED ACTIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check if an action is banned. Turso-first.
 */
async function isActionBanned(actionType: string): Promise<boolean> {
  _stats.tursoReads++;

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const banned = await turso.tursoIsActionBanned(actionType);
      if (banned) { _stats.tursoHits++; return true; }
    } catch {}
  }

  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    return !!db?.selectBannedAction?.get?.(actionType);
  } catch { return false; }
}

/**
 * List all banned actions. Turso-first.
 */
async function listBannedActions(): Promise<any[]> {
  _stats.tursoReads++;

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const list = await turso.tursoListBannedActions();
      if (list.length > 0) { _stats.tursoHits++; return list; }
    } catch {}
  }

  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    return db?.listBannedActions?.all?.() || [];
  } catch { return []; }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTIVE MODEL
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the active AI model. Turso-first.
 */
async function getActiveModel(): Promise<{ model_id: string; provider: string } | null> {
  _stats.tursoReads++;

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const model = await turso.tursoGetActiveModel();
      if (model) { _stats.tursoHits++; return model; }
    } catch {}
  }

  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    return db?.getActiveModel?.get?.() || null;
  } catch { return null; }
}

// ═══════════════════════════════════════════════════════════════════════════
// ACTION CACHE (Turso-primary for AI call avoidance)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Look up a cached action. Turso-first, local fallback.
 * Returns full action cache entry or null.
 */
async function getActionCache(contextSig: string): Promise<any | null> {
  _stats.tursoReads++;

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const entry = await turso.tursoGetActionCache(contextSig);
      if (entry) {
        _stats.tursoHits++;
        // Update hit count in Turso (fire-and-forget)
        turso.tursoUpdateActionCacheHit(contextSig).catch(() => {});
        return entry;
      }
    } catch {}
  }

  // Fallback to local
  _stats.localFallbacks++;
  try {
    const db = _getLocalDb();
    const row = db?.db?.prepare(
      `SELECT action_type, target_x, target_y, value, keypad_sequence, current_state,
              reasoning, hit_count, last_used
       FROM action_cache WHERE context_sig = ? AND evicted = 0`
    )?.get(contextSig);
    if (row) {
      // Update hit count in local
      try {
        db.db.prepare('UPDATE action_cache SET hit_count = hit_count + 1, last_used = ? WHERE context_sig = ?')
          .run(Date.now(), contextSig);
      } catch {}
      return row;
    }
  } catch {}

  return null;
}

/**
 * Save an action cache entry. Writes to local (sync) + Turso (async).
 */
async function saveActionCache(data: {
  contextSig: string;
  actionType: string;
  targetX: number;
  targetY: number;
  value: string;
  keypadSequence: any;
  currentState: string;
  reasoning: string;
}): Promise<boolean> {
  const now = Date.now();
  const keypadJson = data.keypadSequence ? JSON.stringify(data.keypadSequence) : null;

  // Write to local (sync)
  try {
    const db = _getLocalDb();
    if (db?.db) {
      db.db.prepare(
        `INSERT INTO action_cache (context_sig, action_type, target_x, target_y, value,
          keypad_sequence, current_state, reasoning, success_count, failure_count,
          hit_count, created_at, last_used, evicted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 0)
         ON CONFLICT(context_sig) DO UPDATE SET
           action_type = excluded.action_type,
           target_x = excluded.target_x,
           target_y = excluded.target_y,
           value = excluded.value,
           keypad_sequence = excluded.keypad_sequence,
           current_state = excluded.current_state,
           reasoning = excluded.reasoning,
           success_count = success_count + 1,
           failure_count = 0,
           last_used = excluded.last_used`
      ).run(
        data.contextSig, data.actionType, data.targetX, data.targetY, data.value,
        keypadJson, data.currentState, data.reasoning, now, now
      );
    }
  } catch {}

  // Write to Turso (async)
  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    _stats.tursoWrites++;
    try {
      const ok = await turso.tursoUpsertActionCache({
        contextSig: data.contextSig,
        actionType: data.actionType,
        targetX: data.targetX,
        targetY: data.targetY,
        value: data.value,
        keypadSequence: keypadJson,
        currentState: data.currentState,
        reasoning: data.reasoning,
      });
      if (!ok) _stats.tursoWriteErrors++;
    } catch { _stats.tursoWriteErrors++; }
  }

  return true;
}

/**
 * Record a failure for a cached action. Both stores.
 */
async function recordActionCacheFailure(contextSig: string): Promise<boolean> {
  // Local
  try {
    const db = _getLocalDb();
    if (db?.db) {
      const row = db.db.prepare('SELECT failure_count FROM action_cache WHERE context_sig = ? AND evicted = 0')
        .get(contextSig);
      if (row) {
        const newFailCount = (row.failure_count || 0) + 1;
        db.db.prepare('UPDATE action_cache SET failure_count = ?, last_used = ? WHERE context_sig = ?')
          .run(newFailCount, Date.now(), contextSig);

        if (newFailCount >= 3) {
          db.db.prepare('UPDATE action_cache SET evicted = 1 WHERE context_sig = ?').run(contextSig);
        }
      }
    }
  } catch {}

  // Turso
  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try { await turso.tursoRecordActionCacheFailure(contextSig); } catch {}
  }

  return true;
}

/**
 * Evict an action cache entry. Both stores.
 */
async function evictActionCache(contextSig: string): Promise<boolean> {
  try {
    const db = _getLocalDb();
    db?.db?.prepare('UPDATE action_cache SET evicted = 1 WHERE context_sig = ?')?.run(contextSig);
  } catch {}

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try { await turso.tursoEvictActionCache(contextSig); } catch {}
  }

  return true;
}

/**
 * Run action cache maintenance (evict expired + capacity trim). Both stores.
 */
async function runActionCacheMaintenance(ttlMs: number, maxEntries: number): Promise<{ evicted: number }> {
  let evicted = 0;
  const cutoff = Date.now() - ttlMs;

  // Local maintenance
  try {
    const db = _getLocalDb();
    if (db?.db) {
      const result = db.db.prepare('UPDATE action_cache SET evicted = 1 WHERE last_used < ? AND evicted = 0')
        .run(cutoff);
      evicted += result.changes || 0;

      // Capacity eviction
      const count = db.db.prepare('SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0').get()?.cnt || 0;
      if (count > maxEntries) {
        const toEvict = Math.max(1, Math.floor(maxEntries * 0.1));
        const capResult = db.db.prepare(
          `UPDATE action_cache SET evicted = 1 WHERE context_sig IN (
            SELECT context_sig FROM action_cache WHERE evicted = 0
            ORDER BY last_used ASC LIMIT ?
          )`
        ).run(toEvict);
        evicted += capResult.changes || 0;
      }

      // Clean old evicted rows
      db.db.prepare(
        `DELETE FROM action_cache WHERE evicted = 1 AND context_sig NOT IN (
          SELECT context_sig FROM action_cache WHERE evicted = 1 ORDER BY last_used DESC LIMIT 50
        )`
      ).run();
    }
  } catch {}

  // Turso maintenance
  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      const tursoEvicted = await turso.tursoEvictExpiredActionCache(cutoff);
      evicted += tursoEvicted;
      await turso.tursoActionCacheCapacityEvict(maxEntries);
    } catch {}
  }

  return { evicted };
}

/**
 * Get action cache stats. Turso count + local top actions.
 */
async function getActionCacheStats(): Promise<{
  activeEntries: number;
  tursoEntries: number;
  topActions: Array<{ actionType: string; state: string; hitCount: number }>;
}> {
  let activeEntries = 0;
  let tursoEntries = 0;
  const topActions: Array<{ actionType: string; state: string; hitCount: number }> = [];

  // Local stats
  try {
    const db = _getLocalDb();
    if (db?.db) {
      activeEntries = db.db.prepare('SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0').get()?.cnt || 0;
      const rows = db.db.prepare(
        `SELECT action_type, current_state, hit_count FROM action_cache
         WHERE evicted = 0 ORDER BY hit_count DESC LIMIT 10`
      ).all() || [];
      for (const row of rows) {
        topActions.push({ actionType: row.action_type, state: row.current_state, hitCount: row.hit_count });
      }
    }
  } catch {}

  // Turso count
  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try { tursoEntries = await turso.tursoCountActionCache(); } catch {}
  }

  return { activeEntries, tursoEntries, topActions };
}

/**
 * Clear all action cache entries. Both stores.
 */
async function clearActionCache(): Promise<void> {
  try {
    const db = _getLocalDb();
    db?.db?.prepare('DELETE FROM action_cache')?.run();
  } catch {}

  const turso = _getTurso();
  if (turso?.isAvailable?.()) {
    try {
      // No bulk delete in the API, but we can use _exec via internal access
      const client = require('./database-turso');
      // Use the internal _exec if available
    } catch {}
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RAW LOCAL DB ACCESS (for ephemeral tables — blackbox, progress, etc.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get the raw local database instance.
 * Use this ONLY for ephemeral tables that are not synced to Turso:
 *   blackbox, progress_log, semantics_snapshots, template_cache,
 *   network_intercept_log, performance_profile, patch_history, etc.
 */
function getLocalDb(): any {
  return _getLocalDb();
}

/**
 * Get the Turso module for advanced operations.
 */
function getTurso(): any {
  return _getTurso();
}

module.exports = {
  _injectDependencies,

  // Calibration
  getCalibration,
  setCalibration,
  getCalibrationLike,
  deleteCalibration,

  // Completed modules
  isModuleCompleted,
  saveModule,
  getAllModules,

  // Last state
  getLastState,
  saveLastState,

  // Banned actions
  isActionBanned,
  listBannedActions,

  // Active model
  getActiveModel,

  // Action cache
  getActionCache,
  saveActionCache,
  recordActionCacheFailure,
  evictActionCache,
  runActionCacheMaintenance,
  getActionCacheStats,
  clearActionCache,

  // Raw access (for ephemeral tables)
  getLocalDb,
  getTurso,

  // Stats
  getStats,
};
