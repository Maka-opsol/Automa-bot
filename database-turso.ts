'use strict';

// ─── Turso Cloud Database — PRIMARY Store ────────────────────────────────────
//
// v6-R6 refactor: Turso is now the PRIMARY database for reads. Local SQLite
// serves as a low-latency write-through cache. All critical data lives in
// Turso first; local DB is populated from Turso on cold start and kept
// in sync via periodic push.
//
// Architecture:
//   - READS: Turso first → local fallback (if Turso unavailable)
//   - WRITES: Local immediately (zero latency) + async push to Turso
//   - Cold start: Pull ALL data from Turso → populate local
//   - Periodic sync: Push local changes → Turso (every 30s)
//
// Tables managed in Turso (critical/persistent data):
//   calibration, completed_modules, last_state, banned_actions,
//   provider_registry, model_registry, action_cache
//
// Tables NOT synced (ephemeral/high-churn — local only):
//   blackbox, progress_log, semantics_snapshots, template_cache,
//   network_intercept_log, performance_profile, patch_history,
//   gitops_rollback_chain, etc.
//
// Environment variables:
//   TURSO_DATABASE_URL — e.g. libsql://my-db-myuser.turso.io
//   TURSO_AUTH_TOKEN    — Authentication token from Turso dashboard
//
// If either env var is missing, this module is a no-op (graceful disable).
// All reads/writes fall through to local DB only.

// ─── State ──────────────────────────────────────────────────────────────────

let _client: any = null;
let _enabled = false;
let _syncInterval: any = null;
let _lastSyncTime = 0;
let _lastPullTime = 0;
let _consecutiveErrors = 0;
const MAX_CONSECUTIVE_ERRORS = 5; // Auto-disable after 5 consecutive failures
const SYNC_INTERVAL_MS_DEFAULT = 120000; // 120s — push local → Turso (was 30s; 512MB can't afford frequent syncs during active cycles)
// v18: Heap guard — skip Turso sync when memory is tight.
// On 512MB Render, the Node heap is ~256MB max, but RSS includes the
// browser process (~100-200MB). When heap is 80MB+, RSS is already
// ~300-400MB, and the sync's HTTP allocations can push past 512MB.
// TASK 95 (2026-09-27): Raised from 80MB to 300MB.
// The bot's steady-state heap is ~200-280MB. With the old 80MB guard,
// Turso syncs were ALWAYS skipped — the action_cache was never synced
// to cloud storage. Raised to 300MB so syncs actually happen during
// normal operation. The sync's HTTP allocation is ~50-100KB — negligible
// compared to the 384MB V8 heap limit.
const SYNC_HEAP_GUARD_MB = 300;
// v19: RSS hard limit — skip sync if total process RSS is above this.
// On Render free plan (512MB), the OOM killer fires at ~512MB RSS.
// Leave 100MB headroom for the browser and GC overhead.
const SYNC_RSS_GUARD_MB = 400;
// v19: Mutex — prevent concurrent syncs. If a sync is already running
// (e.g., it took > interval due to network latency), skip the next one.
let _syncInProgress = false;

// FIX: Retry transient write failures (1 retry with 1s backoff)
const WRITE_RETRY_DELAY_MS = 1000;
const WRITE_RETRY_COUNT = 1;

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

function _getLog() {
  return _deps.logger?.log || ((msg: string, level?: string, mod?: string) => {
    try { console.log(`[${new Date().toISOString()}] [turso:${level || 'INFO'}] ${msg}`); } catch {}
  });
}
function _getLogError() {
  return _deps.logger?.logError || ((msg: string, err: Error) => {
    try { console.error(`[turso:ERROR] ${msg}`, err); } catch {}
  });
}

// ─── Client Management ──────────────────────────────────────────────────────

function _getClient() {
  if (_client) return _client;
  if (_enabled && _consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    // Auto-disabled — too many consecutive errors. Don't spam retries.
    return null;
  }

  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  if (!url || !token) {
    _enabled = false;
    _getLog()('Turso not configured (missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN). Operating in local-only mode.', 'INFO');
    return null;
  }

  try {
    const { createClient } = require('@libsql/client');
    _client = createClient({
      url,
      authToken: token,
      // Connection pooling handled by libsql client internally
    });
    _enabled = true;
    _getLog()(`Turso client initialized (PRIMARY): ${url.replace(/\/\/.*@/, '//***@')}`);
    return _client;
  } catch (err: any) {
    _getLog()(`Failed to initialize Turso client: ${err.message}`, 'ERROR');
    _enabled = false;
    return null;
  }
}

/**
 * Check if Turso is available and healthy.
 */
function isAvailable(): boolean {
  return !!_getClient();
}

// Cached reference to the real Array — immune to global shadowing.
// Under Render memory pressure, the global Array can be corrupted by
// third-party code, causing libsql client.execute() to crash with
// "Array.isArray is not a function". We capture a reference at module
// load time so we can detect and recover.
const _realArray = Array;

/** Check whether the global Array has been corrupted.
 *  Checks all critical static methods — corruption may strip individual
 *  methods (e.g. Array.from) while leaving Array.isArray intact.
 */
function _isArrayCorrupted(): boolean {
  return typeof Array !== 'function'
    || typeof Array.isArray !== 'function'
    || typeof Array.from !== 'function'
    || typeof Array.of !== 'function';
}

/**
 * Execute a SQL query on Turso and return the result object.
 * Returns { rows, columns } on success, null on failure.
 * Defends against Array.isArray corruption inside @libsql/client.
 */
async function _query(sql: string, params: any[] = []): Promise<any | null> {
  const client = _getClient();
  if (!client) return null;

  // Detect and temporarily repair corrupted global Array
  let arrayWasCorrupted = false;
  if (_isArrayCorrupted()) {
    arrayWasCorrupted = true;
    try {
      (globalThis as any).Array = _realArray;
    } catch { /* best effort */ }
  }

  try {
    const result = await client.execute({ sql, args: params });
    _consecutiveErrors = 0; // Reset on success
    return result;
  } catch (err: any) {
    _consecutiveErrors++;
    // Detect the specific Array.isArray corruption error from libsql
    const msg = err?.message || '';
    if (msg.includes('Array.isArray is not a function') || msg.includes('Array is not a function') || msg.includes('Array.from is not a function')) {
      _getLog()(`Turso query failed — global Array corrupted (query #${_consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}). Attempting repair.`, 'ERROR');
    } else {
      _getLog()(`Turso query failed (${_consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}): ${msg}`, 'WARN');
    }
    if (_consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      _getLog()(`Turso auto-disabled after ${MAX_CONSECUTIVE_ERRORS} consecutive errors. Using local-only mode.`, 'ERROR');
    }
    return null;
  } finally {
    // If Array was corrupted, it stays repaired — do NOT restore a broken reference
  }
}

/**
 * Execute a SQL statement on Turso. Returns true on success.
 * FIX: Added retry for transient failures on write operations.
 */
async function _exec(sql: string, params: any[] = []): Promise<boolean> {
  const result = await _query(sql, params);
  if (result !== null) return true;

  // Retry once for transient failures (unless already auto-disabled)
  if (_consecutiveErrors >= MAX_CONSECUTIVE_ERRORS - 1) return false;

  _getLog()(`Turso write retry in ${WRITE_RETRY_DELAY_MS}ms for: ${sql.substring(0, 80)}...`, 'DEBUG');
  await new Promise(r => setTimeout(r, WRITE_RETRY_DELAY_MS));
  const retry = await _query(sql, params);
  if (retry !== null) {
    _getLog()(`Turso write retry succeeded`, 'DEBUG');
    return true;
  }
  return false;
}

// ─── Schema Initialization ──────────────────────────────────────────────────

async function initTursoSchema(): Promise<void> {
  const client = _getClient();
  if (!client) return;

  // All critical tables that Turso manages as primary store
  const tables = [
    `CREATE TABLE IF NOT EXISTS calibration (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS completed_modules (name TEXT PRIMARY KEY, completed_at INTEGER, attempts INTEGER DEFAULT 0, completion_time_ms INTEGER, last_attempt INTEGER)`,
    `CREATE TABLE IF NOT EXISTS last_state (url TEXT, state TEXT, timestamp INTEGER)`,
    `CREATE TABLE IF NOT EXISTS banned_actions (action_type TEXT PRIMARY KEY, banned_by TEXT, banned_at INTEGER, reason TEXT)`,
    `CREATE TABLE IF NOT EXISTS provider_registry (provider_name TEXT PRIMARY KEY, endpoint TEXT, model TEXT, last_verified INTEGER, history TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0, total_latency INTEGER DEFAULT 0, last_check INTEGER)`,
    `CREATE TABLE IF NOT EXISTS model_registry (provider TEXT, model_id TEXT PRIMARY KEY, is_free INTEGER DEFAULT 0, is_working INTEGER DEFAULT 0, role TEXT DEFAULT 'candidate', last_tested_at INTEGER, last_success_at INTEGER, failure_count INTEGER DEFAULT 0)`,
    // R6: action_cache — critical for AI call avoidance, must survive restarts
    `CREATE TABLE IF NOT EXISTS action_cache (context_sig TEXT PRIMARY KEY, action_type TEXT NOT NULL, target_x REAL NOT NULL, target_y REAL NOT NULL, value TEXT DEFAULT '', keypad_sequence TEXT, current_state TEXT NOT NULL, reasoning TEXT DEFAULT '', success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0, hit_count INTEGER DEFAULT 0, created_at INTEGER NOT NULL, last_used INTEGER NOT NULL, evicted INTEGER DEFAULT 0)`,
  ];

  // Create indexes for common query patterns
  const indexes = [
    `CREATE INDEX IF NOT EXISTS idx_action_cache_state ON action_cache(current_state)`,
    `CREATE INDEX IF NOT EXISTS idx_action_cache_last_used ON action_cache(last_used)`,
    `CREATE INDEX IF NOT EXISTS idx_calibration_updated ON calibration(updated_at)`,
    `CREATE INDEX IF NOT EXISTS idx_model_role ON model_registry(role)`,
  ];

  for (const sql of tables) {
    await _exec(sql);
  }
  for (const sql of indexes) {
    await _exec(sql);
  }
  _getLog()('Turso schema initialized (PRIMARY store with action_cache)');
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRECT READ API — Turso as primary, local as fallback
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read a calibration value from Turso.
 * Returns the value string or null.
 */
async function tursoGetCalibration(key: string): Promise<string | null> {
  const result = await _query('SELECT value FROM calibration WHERE key = ?', [key]);
  if (result?.rows?.length > 0) return result.rows[0].value as string;
  return null;
}

/**
 * Check if a module is completed in Turso.
 * Returns true if found.
 */
async function tursoIsModuleCompleted(name: string): Promise<boolean> {
  const result = await _query('SELECT 1 FROM completed_modules WHERE name = ?', [name]);
  return (result?.rows?.length ?? 0) > 0;
}

/**
 * Get all completed module names from Turso.
 */
async function tursoGetAllModules(): Promise<string[]> {
  const result = await _query('SELECT name FROM completed_modules');
  if (!result?.rows) return [];
  return result.rows.map((r: any) => r.name as string);
}

/**
 * Get the last known state from Turso.
 */
async function tursoGetLastState(): Promise<{ url: string; state: string; timestamp: number } | null> {
  const result = await _query('SELECT url, state, timestamp FROM last_state ORDER BY timestamp DESC LIMIT 1');
  if (result?.rows?.length > 0) return result.rows[0] as any;
  return null;
}

/**
 * Get a banned action from Turso.
 */
async function tursoIsActionBanned(actionType: string): Promise<boolean> {
  const result = await _query('SELECT 1 FROM banned_actions WHERE action_type = ?', [actionType]);
  return (result?.rows?.length ?? 0) > 0;
}

/**
 * Get all banned actions from Turso.
 */
async function tursoListBannedActions(): Promise<any[]> {
  const result = await _query('SELECT * FROM banned_actions ORDER BY banned_at DESC');
  return result?.rows || [];
}

/**
 * Get the active model from Turso.
 */
async function tursoGetActiveModel(): Promise<{ model_id: string; provider: string } | null> {
  const result = await _query("SELECT model_id, provider FROM model_registry WHERE role = 'active' LIMIT 1");
  if (result?.rows?.length > 0) return result.rows[0] as any;
  return null;
}

/**
 * Get action cache entry from Turso.
 * Returns full row or null.
 */
async function tursoGetActionCache(contextSig: string): Promise<any | null> {
  const result = await _query(
    `SELECT action_type, target_x, target_y, value, keypad_sequence, current_state,
            reasoning, hit_count, last_used
     FROM action_cache WHERE context_sig = ? AND evicted = 0`,
    [contextSig]
  );
  if (result?.rows?.length > 0) return result.rows[0];
  return null;
}

/**
 * Count active action cache entries in Turso.
 */
async function tursoCountActionCache(): Promise<number> {
  const result = await _query('SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0');
  return result?.rows?.[0]?.cnt || 0;
}

/**
 * Get calibration entries matching a LIKE pattern (e.g., solution cache keys).
 */
async function tursoGetCalibrationLike(prefix: string): Promise<Array<{ key: string; value: string; updated_at: number }>> {
  const result = await _query('SELECT key, value, updated_at FROM calibration WHERE key LIKE ?', [`${prefix}%`]);
  return result?.rows || [];
}

// ═══════════════════════════════════════════════════════════════════════════
// DIRECT WRITE API — Write to Turso immediately (primary store)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Write a calibration value to Turso.
 */
async function tursoUpsertCalibration(key: string, value: string, updatedAt: number): Promise<boolean> {
  return _exec('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)', [key, value, updatedAt]);
}

/**
 * Insert a completed module to Turso.
 */
async function tursoInsertModule(name: string, completedAt: number): Promise<boolean> {
  return _exec('INSERT OR IGNORE INTO completed_modules (name, completed_at) VALUES (?, ?)', [name, completedAt]);
}

/**
 * Update last state in Turso.
 */
async function tursoUpsertLastState(url: string, state: string, timestamp: number): Promise<boolean> {
  return _exec('INSERT OR REPLACE INTO last_state (url, state, timestamp) VALUES (?, ?, ?)', [url, state, timestamp]);
}

/**
 * Upsert a provider in Turso.
 */
async function tursoUpsertProvider(data: { provider_name: string; endpoint: string; model: string; last_verified: number; history: string; success_count: number; failure_count: number; total_latency: number; last_check: number }): Promise<boolean> {
  return _exec(
    `INSERT OR REPLACE INTO provider_registry (provider_name, endpoint, model, last_verified, history, success_count, failure_count, total_latency, last_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [data.provider_name, data.endpoint, data.model, data.last_verified, data.history, data.success_count, data.failure_count, data.total_latency, data.last_check]
  );
}

/**
 * Upsert a model in Turso.
 */
async function tursoUpsertModel(provider: string, modelId: string, isFree: number, isWorking: number, role: string, lastTestedAt: number, lastSuccessAt: number, failureCount: number): Promise<boolean> {
  return _exec(
    `INSERT OR REPLACE INTO model_registry (provider, model_id, is_free, is_working, role, last_tested_at, last_success_at, failure_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [provider, modelId, isFree, isWorking, role, lastTestedAt, lastSuccessAt, failureCount]
  );
}

/**
 * Upsert an action cache entry in Turso.
 */
async function tursoUpsertActionCache(data: {
  contextSig: string;
  actionType: string;
  targetX: number;
  targetY: number;
  value: string;
  keypadSequence: string | null;
  currentState: string;
  reasoning: string;
}): Promise<boolean> {
  const now = Date.now();
  return _exec(
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
       last_used = excluded.last_used`,
    [data.contextSig, data.actionType, data.targetX, data.targetY, data.value,
     data.keypadSequence, data.currentState, data.reasoning, now, now]
  );
}

/**
 * Update action cache hit count in Turso.
 */
async function tursoUpdateActionCacheHit(contextSig: string): Promise<boolean> {
  return _exec(
    'UPDATE action_cache SET hit_count = hit_count + 1, last_used = ? WHERE context_sig = ?',
    [Date.now(), contextSig]
  );
}

/**
 * Mark action cache entry as evicted in Turso.
 */
async function tursoEvictActionCache(contextSig: string): Promise<boolean> {
  return _exec('UPDATE action_cache SET evicted = 1 WHERE context_sig = ?', [contextSig]);
}

/**
 * Record action cache failure in Turso.
 */
async function tursoRecordActionCacheFailure(contextSig: string): Promise<boolean> {
  return _exec(
    'UPDATE action_cache SET failure_count = failure_count + 1, last_used = ? WHERE context_sig = ?',
    [Date.now(), contextSig]
  );
}

/**
 * Evict expired action cache entries in Turso.
 * FIX: libsql returns { rows: [...] } not { rows: { affectedRowCount } }.
 * Use a count query instead.
 */
async function tursoEvictExpiredActionCache(cutoffTimestamp: number): Promise<number> {
  // First count how many will be evicted
  const countResult = await _query(
    'SELECT COUNT(*) as cnt FROM action_cache WHERE last_used < ? AND evicted = 0',
    [cutoffTimestamp]
  );
  const willEvict = countResult?.rows?.[0]?.cnt || 0;
  if (willEvict === 0) return 0;

  // Then evict
  await _exec(
    'UPDATE action_cache SET evicted = 1 WHERE last_used < ? AND evicted = 0',
    [cutoffTimestamp]
  );
  return willEvict;
}

/**
 * Run action cache capacity eviction in Turso (evict oldest 10%).
 * FIX: Also use count-then-evict pattern for accurate return value.
 */
async function tursoActionCacheCapacityEvict(maxEntries: number): Promise<number> {
  // Get current count
  const countResult = await _query('SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0');
  const count = countResult?.rows?.[0]?.cnt || 0;
  if (count <= maxEntries) return 0;

  const toEvict = Math.max(1, Math.floor(maxEntries * 0.1));
  // FIX: Count how many the subquery will actually match
  const matchResult = await _query(
    `SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0 ORDER BY last_used ASC LIMIT ?`,
    [toEvict]
  );
  const willEvict = matchResult?.rows?.[0]?.cnt || 0;
  if (willEvict === 0) return 0;

  await _exec(
    `UPDATE action_cache SET evicted = 1 WHERE context_sig IN (
      SELECT context_sig FROM action_cache WHERE evicted = 0
      ORDER BY last_used ASC LIMIT ?
    )`,
    [toEvict]
  );
  return willEvict;
}

/**
 * Delete calibration entry from Turso.
 */
async function tursoDeleteCalibration(key: string): Promise<boolean> {
  return _exec('DELETE FROM calibration WHERE key = ?', [key]);
}

/**
 * Bulk push calibration entries to Turso (for cold start recovery).
 */
async function tursoBulkUpsertCalibration(entries: Array<{ key: string; value: string; updated_at: number }>): Promise<{ synced: number; errors: number }> {
  let synced = 0, errors = 0;
  for (const entry of entries) {
    const ok = await tursoUpsertCalibration(entry.key, entry.value, entry.updated_at);
    if (ok) synced++; else errors++;
  }
  return { synced, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// PULL FROM TURSO — Authoritative cold start recovery
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Pull ALL critical data from Turso into local SQLite.
 * This is the authoritative source — Turso data overwrites local.
 * Used on cold start or when local DB is suspected stale.
 */
async function pullFromTurso(): Promise<{ pulled: number; tables: Record<string, number> }> {
  const client = _getClient();
  if (!client) return { pulled: 0, tables: {} };

  let pulled = 0;
  const tables: Record<string, number> = {};

  try {
    const db = require('./database');

    // Pull calibration — authoritative (includes solution cache, action cache metadata, etc.)
    try {
      const result = await client.execute('SELECT * FROM calibration');
      for (const row of result.rows) {
        try { db.upsertCalibration?.run(row.key as string, row.value as string, row.updated_at as number); pulled++; } catch {}
      }
      tables.calibration = result.rows.length;
    } catch {}

    // Pull completed_modules
    try {
      const result = await client.execute('SELECT * FROM completed_modules');
      for (const row of result.rows) {
        try { db.insertModule?.(row.name as string); pulled++; } catch {}
      }
      tables.completed_modules = result.rows.length;
    } catch {}

    // Pull model_registry (all roles, not just active)
    try {
      const result = await client.execute('SELECT * FROM model_registry');
      for (const row of result.rows) {
        try {
          db.upsertModel?.run(
            row.provider, row.model_id, row.is_free, row.is_working, row.role,
            row.last_tested_at, row.last_success_at, row.failure_count
          ); pulled++;
        } catch {}
      }
      tables.model_registry = result.rows.length;
    } catch {}

    // Pull last_state
    try {
      const result = await client.execute('SELECT * FROM last_state ORDER BY timestamp DESC LIMIT 1');
      if (result.rows.length > 0) {
        const row = result.rows[0];
        try { db.upsertLastState?.run(row.url, row.state, row.timestamp); pulled++; } catch {}
      }
      tables.last_state = result.rows.length;
    } catch {}

    // Pull banned_actions
    try {
      const result = await client.execute('SELECT * FROM banned_actions');
      for (const row of result.rows) {
        try { db.insertBannedAction?.run(row.action_type, row.banned_by, row.banned_at, row.reason); pulled++; } catch {}
      }
      tables.banned_actions = result.rows.length;
    } catch {}

    // Pull action_cache
    try {
      const result = await client.execute('SELECT * FROM action_cache WHERE evicted = 0');
      const localDb = db.db;
      if (localDb) {
        for (const row of result.rows) {
          try {
            localDb.prepare(
              `INSERT OR REPLACE INTO action_cache (context_sig, action_type, target_x, target_y, value,
                keypad_sequence, current_state, reasoning, success_count, failure_count,
                hit_count, created_at, last_used, evicted)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).run(
              row.context_sig, row.action_type, row.target_x, row.target_y, row.value,
              row.keypad_sequence, row.current_state, row.reasoning, row.success_count,
              row.failure_count, row.hit_count, row.created_at, row.last_used, row.evicted
            );
            pulled++;
          } catch {}
        }
      }
      tables.action_cache = result.rows.length;
    } catch {}

    // Pull provider_registry
    try {
      const result = await client.execute('SELECT * FROM provider_registry');
      for (const row of result.rows) {
        try {
          db.upsertProvider?.run(
            row.provider_name, row.endpoint, row.model, row.last_verified, row.history,
            row.success_count, row.failure_count, row.total_latency, row.last_check
          ); pulled++;
        } catch {}
      }
      tables.provider_registry = result.rows.length;
    } catch {}

    _lastPullTime = Date.now();
    _getLog()(`Pulled ${pulled} rows from Turso (AUTHORITATIVE). Tables: ${JSON.stringify(tables)}`);
  } catch (err: any) {
    _getLog()(`Pull from Turso failed: ${err.message}`, 'ERROR');
  }

  return { pulled, tables };
}

// ═══════════════════════════════════════════════════════════════════════════
// PUSH TO TURSO — Periodic local → Turso sync
// ═══════════════════════════════════════════════════════════════════════════

async function syncToTurso(): Promise<{ synced: number; errors: number }> {
  const client = _getClient();
  if (!client) return { synced: 0, errors: 0 };

  // v18/v19: Memory guard — skip sync when memory is tight.
  // Check BOTH heap and RSS. On 512MB Render:
  //   - heap 80MB+ means RSS is already ~300-400MB (browser + overhead)
  //   - RSS 400MB+ means we're ~100MB from OOM killer
  // Either condition alone is enough to skip the sync.
  try {
    const mem = process.memoryUsage();
    const heapMB = mem.heapUsed / 1024 / 1024;
    const rssMB = mem.rss / 1024 / 1024;
    if (heapMB > SYNC_HEAP_GUARD_MB) {
      _getLog()(`Turso sync skipped — heap ${heapMB.toFixed(0)}MB > ${SYNC_HEAP_GUARD_MB}MB guard`, 'DEBUG');
      return { synced: 0, errors: 0 };
    }
    if (rssMB > SYNC_RSS_GUARD_MB) {
      _getLog()(`Turso sync skipped — RSS ${rssMB.toFixed(0)}MB > ${SYNC_RSS_GUARD_MB}MB guard`, 'DEBUG');
      return { synced: 0, errors: 0 };
    }
  } catch {}

  let synced = 0;
  let errors = 0;

  // v18: Use executeMultiple (single HTTP request per table) instead of
  // per-row await client.execute(). This reduces 93 HTTP requests to ~7,
  // cutting memory allocation from ~5-10MB to ~0.5MB per sync cycle.
  // libsql client.executeMultiple() sends all statements in one HTTP
  // request, so the response is a single object instead of 93.
  //
  // IMPORTANT: executeMultiple does NOT support parameterized queries.
  // All values must be SQL-literal-escaped inline. This is safe because
  // all values originate from our own local SQLite (not user input).
  function _esc(val: any): string {
    if (val === null || val === undefined) return 'NULL';
    if (typeof val === 'number') return isFinite(val) ? String(val) : 'NULL';
    if (typeof val === 'bigint') return String(val);
    // String: escape for SQL literal safety
    let s = String(val);
    // Remove null bytes (SQLite can't store them in TEXT)
    s = s.replace(/\0/g, '');
    // Escape backslashes (some SQLite versions treat \\ as escape)
    s = s.replace(/\\/g, '\\\\');
    // Escape single quotes (SQL string delimiter)
    s = s.replace(/'/g, "''");
    // Collapse newlines/carriage returns (breaks executeMultiple statement separator)
    s = s.replace(/[\r\n]+/g, ' ');
    return "'" + s + "'";
  }

  try {
    const db = require('./database');
    const useBatch = typeof client.executeMultiple === 'function';

    if (!useBatch) {
      // Fallback: original per-row sync (shouldn't happen with @libsql/client >= 0.14)
      _getLog()('executeMultiple not available — using per-row fallback (higher memory)', 'DEBUG');
    }

    // Sync calibration
    try {
      const rows = db.db?.prepare('SELECT * FROM calibration')?.all() || [];
      if (rows.length > 0) {
        if (useBatch) {
          const stmts = rows.map((r: any) =>
            `INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (${_esc(r.key)}, ${_esc(r.value)}, ${_esc(r.updated_at)})`
          );
          await client.executeMultiple(stmts.join('; '));
          synced += rows.length;
        } else {
          for (const row of rows) {
            const ok = await _exec('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)', [row.key, row.value, row.updated_at]);
            if (ok) synced++; else errors++;
          }
        }
      }
    } catch (e: any) { errors++; }

    // Sync completed_modules
    try {
      const modules = db.db?.prepare('SELECT * FROM completed_modules')?.all() || [];
      if (modules.length > 0) {
        if (useBatch) {
          const stmts = modules.map((r: any) =>
            `INSERT OR REPLACE INTO completed_modules (name, completed_at, attempts, completion_time_ms, last_attempt) VALUES (${_esc(r.name)}, ${_esc(r.completed_at)}, ${_esc(r.attempts)}, ${_esc(r.completion_time_ms)}, ${_esc(r.last_attempt)})`
          );
          await client.executeMultiple(stmts.join('; '));
          synced += modules.length;
        } else {
          for (const row of modules) {
            const ok = await _exec('INSERT OR REPLACE INTO completed_modules (name, completed_at, attempts, completion_time_ms, last_attempt) VALUES (?, ?, ?, ?, ?)', [row.name, row.completed_at, row.attempts, row.completion_time_ms, row.last_attempt]);
            if (ok) synced++; else errors++;
          }
        }
      }
    } catch (e: any) { errors++; }

    // Sync last_state
    try {
      const lastState = db.db?.prepare('SELECT * FROM last_state ORDER BY timestamp DESC LIMIT 1')?.get();
      if (lastState) {
        if (useBatch) {
          await client.executeMultiple(`INSERT OR REPLACE INTO last_state (url, state, timestamp) VALUES (${_esc(lastState.url)}, ${_esc(lastState.state)}, ${_esc(lastState.timestamp)})`);
          synced++;
        } else {
          const ok = await _exec('INSERT OR REPLACE INTO last_state (url, state, timestamp) VALUES (?, ?, ?)', [lastState.url, lastState.state, lastState.timestamp]);
          if (ok) synced++; else errors++;
        }
      }
    } catch (e: any) { errors++; }

    // Sync banned_actions
    try {
      const banned = db.db?.prepare('SELECT * FROM banned_actions')?.all() || [];
      if (banned.length > 0) {
        if (useBatch) {
          const stmts = banned.map((r: any) =>
            `INSERT OR REPLACE INTO banned_actions (action_type, banned_by, banned_at, reason) VALUES (${_esc(r.action_type)}, ${_esc(r.banned_by)}, ${_esc(r.banned_at)}, ${_esc(r.reason)})`
          );
          await client.executeMultiple(stmts.join('; '));
          synced += banned.length;
        } else {
          for (const row of banned) {
            const ok = await _exec('INSERT OR REPLACE INTO banned_actions (action_type, banned_by, banned_at, reason) VALUES (?, ?, ?, ?)', [row.action_type, row.banned_by, row.banned_at, row.reason]);
            if (ok) synced++; else errors++;
          }
        }
      }
    } catch (e: any) { errors++; }

    // Sync provider_registry
    try {
      const providers = db.db?.prepare('SELECT * FROM provider_registry')?.all() || [];
      if (providers.length > 0) {
        if (useBatch) {
          const stmts = providers.map((r: any) =>
            `INSERT OR REPLACE INTO provider_registry (provider_name, endpoint, model, last_verified, history, success_count, failure_count, total_latency, last_check) VALUES (${_esc(r.provider_name)}, ${_esc(r.endpoint)}, ${_esc(r.model)}, ${_esc(r.last_verified)}, ${_esc(r.history)}, ${_esc(r.success_count)}, ${_esc(r.failure_count)}, ${_esc(r.total_latency)}, ${_esc(r.last_check)})`
          );
          await client.executeMultiple(stmts.join('; '));
          synced += providers.length;
        } else {
          for (const row of providers) {
            const ok = await _exec('INSERT OR REPLACE INTO provider_registry (provider_name, endpoint, model, last_verified, history, success_count, failure_count, total_latency, last_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [row.provider_name, row.endpoint, row.model, row.last_verified, row.history, row.success_count, row.failure_count, row.total_latency, row.last_check]);
            if (ok) synced++; else errors++;
          }
        }
      }
    } catch (e: any) { errors++; }

    // Sync model_registry
    try {
      const models = db.db?.prepare('SELECT * FROM model_registry')?.all() || [];
      if (models.length > 0) {
        if (useBatch) {
          const stmts = models.map((r: any) =>
            `INSERT OR REPLACE INTO model_registry (provider, model_id, is_free, is_working, role, last_tested_at, last_success_at, failure_count) VALUES (${_esc(r.provider)}, ${_esc(r.model_id)}, ${_esc(r.is_free)}, ${_esc(r.is_working)}, ${_esc(r.role)}, ${_esc(r.last_tested_at)}, ${_esc(r.last_success_at)}, ${_esc(r.failure_count)})`
          );
          await client.executeMultiple(stmts.join('; '));
          synced += models.length;
        } else {
          for (const row of models) {
            const ok = await _exec('INSERT OR REPLACE INTO model_registry (provider, model_id, is_free, is_working, role, last_tested_at, last_success_at, failure_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [row.provider, row.model_id, row.is_free, row.is_working, row.role, row.last_tested_at, row.last_success_at, row.failure_count]);
            if (ok) synced++; else errors++;
          }
        }
      }
    } catch (e: any) { errors++; }

    // Sync action_cache
    try {
      const actions = db.db?.prepare('SELECT * FROM action_cache WHERE evicted = 0')?.all() || [];
      if (actions.length > 0) {
        if (useBatch) {
          const stmts = actions.map((r: any) =>
            `INSERT INTO action_cache (context_sig, action_type, target_x, target_y, value,
              keypad_sequence, current_state, reasoning, success_count, failure_count,
              hit_count, created_at, last_used, evicted)
             VALUES (${_esc(r.context_sig)}, ${_esc(r.action_type)}, ${_esc(r.target_x)}, ${_esc(r.target_y)}, ${_esc(r.value)},
               ${_esc(r.keypad_sequence)}, ${_esc(r.current_state)}, ${_esc(r.reasoning)}, ${_esc(r.success_count)}, ${_esc(r.failure_count)},
               ${_esc(r.hit_count)}, ${_esc(r.created_at)}, ${_esc(r.last_used)}, ${_esc(r.evicted)})
             ON CONFLICT(context_sig) DO UPDATE SET
               action_type = excluded.action_type,
               target_x = excluded.target_x,
               target_y = excluded.target_y,
               hit_count = MAX(action_cache.hit_count, excluded.hit_count)`
          );
          await client.executeMultiple(stmts.join('; '));
          synced += actions.length;
        } else {
          for (const row of actions) {
            const ok = await _exec(
              `INSERT INTO action_cache (context_sig, action_type, target_x, target_y, value,
                keypad_sequence, current_state, reasoning, success_count, failure_count,
                hit_count, created_at, last_used, evicted)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
               ON CONFLICT(context_sig) DO UPDATE SET
                 action_type = excluded.action_type,
                 target_x = excluded.target_x,
                 target_y = excluded.target_y,
                 hit_count = MAX(action_cache.hit_count, excluded.hit_count)`,
              [row.context_sig, row.action_type, row.target_x, row.target_y, row.value,
               row.keypad_sequence, row.current_state, row.reasoning, row.success_count,
               row.failure_count, row.hit_count, row.created_at, row.last_used, row.evicted]
            );
            if (ok) synced++; else errors++;
          }
        }
      }
    } catch (e: any) { errors++; }

    _lastSyncTime = Date.now();
    if (synced > 0 || errors > 0) {
      _getLog()(`Pushed ${synced} rows to Turso (${errors} errors)${useBatch ? ' [batch]' : ' [per-row]'}`);
    }

    if (errors === 0) _consecutiveErrors = 0;
  } catch (err: any) {
    _getLog()(`Sync error: ${err.message}`, 'ERROR');
    errors++;
  }

  return { synced, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// SERVICE LIFECYCLE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start the Turso service.
 * 1. Initialize client + schema
 * 2. Pull ALL data from Turso (authoritative cold start)
 * 3. Start periodic push sync
 */
async function startTursoSync(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  if (!url || !token) {
    _getLog()('Turso disabled — set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to enable. Local-only mode.', 'INFO');
    return;
  }

  // Initialize client and schema
  const client = _getClient();
  if (!client) return;

  await initTursoSchema();

  // R6: ALWAYS pull from Turso on startup (it's the primary store now).
  // Even if local has data, Turso may have newer data from a previous session.
  _getLog()('Pulling ALL data from Turso (primary store)...', 'INFO');
  const pullResult = await pullFromTurso();
  if (pullResult.pulled > 0) {
    _getLog()(`Cold start recovery: ${pullResult.pulled} rows restored from Turso`, 'INFO');
  }

  // Start periodic push sync (local → Turso)
  const syncIntervalMs = parseInt(process.env.TURSO_SYNC_INTERVAL_MS || String(SYNC_INTERVAL_MS_DEFAULT), 10);
  _syncInterval = setInterval(async () => {
    // v19: Mutex — skip if previous sync is still running
    if (_syncInProgress) {
      _getLog()('Turso sync skipped — previous sync still in progress', 'DEBUG');
      return;
    }
    _syncInProgress = true;
    try {
      await syncToTurso();
    } finally {
      _syncInProgress = false;
    }
  }, syncIntervalMs);
  if (_syncInterval?.unref) _syncInterval.unref();

  // Initial push (local may have data that Turso doesn't)
  await syncToTurso();

  _getLog()(`Turso PRIMARY sync started (push interval: ${syncIntervalMs / 1000}s)`);
}

function stopTursoSync(): void {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
  _getLog()('Turso sync stopped', 'INFO');
}

function getTursoStatus(): {
  enabled: boolean;
  available: boolean;
  lastSyncTime: number;
  lastPullTime: number;
  errors: number;
  consecutiveErrors: number;
  clientConnected: boolean;
} {
  return {
    enabled: _enabled,
    available: isAvailable(),
    lastSyncTime: _lastSyncTime,
    lastPullTime: _lastPullTime,
    errors: 0,
    consecutiveErrors: _consecutiveErrors,
    clientConnected: !!_client,
  };
}

module.exports = {
  // Lifecycle
  _injectDependencies,
  startTursoSync,
  stopTursoSync,
  getTursoStatus,
  initTursoSchema,
  isAvailable,

  // Sync
  syncToTurso,
  pullFromTurso,

  // Direct reads (Turso-first)
  tursoGetCalibration,
  tursoIsModuleCompleted,
  tursoGetAllModules,
  tursoGetLastState,
  tursoIsActionBanned,
  tursoListBannedActions,
  tursoGetActiveModel,
  tursoGetActionCache,
  tursoCountActionCache,
  tursoGetCalibrationLike,

  // Direct writes (Turso-primary)
  tursoUpsertCalibration,
  tursoInsertModule,
  tursoUpsertLastState,
  tursoUpsertProvider,
  tursoUpsertModel,
  tursoUpsertActionCache,
  tursoUpdateActionCacheHit,
  tursoEvictActionCache,
  tursoRecordActionCacheFailure,
  tursoEvictExpiredActionCache,
  tursoActionCacheCapacityEvict,
  tursoDeleteCalibration,
  tursoBulkUpsertCalibration,
};
