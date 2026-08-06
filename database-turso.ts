'use strict';

// ─── Turso Cloud Database Sync ─────────────────────────────────────────────
//
// Provides a lightweight sync layer between the local SQLite database and
// a remote Turso (libSQL) database. The local DB remains the primary store
// for all reads/writes (zero latency). This module periodically syncs
// critical data to Turso for persistence across Render restarts/redeploys.
//
// Why Turso:
//   - libSQL is SQLite-compatible — same SQL dialect
//   - Free tier: 9 GB storage, 25M reads/mo, 500 DBs
//   - Edge-distributed — fast from any region
//   - No schema changes needed — same CREATE TABLE statements work
//
// Sync strategy:
//   - Tables synced: calibration, completed_modules, last_state, banned_actions,
//     provider_registry, model_registry
//   - Sync interval: every 60 seconds (configurable)
//   - Dirty-check: hashes all local data before sync — skips the round-trip
//     entirely if nothing has changed since the last successful sync
//   - On startup: pull from Turso if local DB is empty (cold start recovery)
//   - One-directional: local → Turso (local is source of truth)
//   - Conflict resolution: last-write-wins (local always wins)
//
// Environment variables:
//   TURSO_DATABASE_URL — e.g. libsql://my-db-myuser.turso.io
//   TURSO_AUTH_TOKEN    — Authentication token from Turso dashboard
//
// If either env var is missing, this module is a no-op (graceful disable).

const { PROJECT_ROOT } = require('./project-root');

// Lazy requires — only load @libsql/client if Turso is configured
let _client: any = null;
let _syncEnabled = false;
let _syncInterval: any = null;
let _lastSyncTime = 0;
let _syncErrors = 0;
let _lastDataHash: string | null = null; // Dirty-check: skip sync if data hasn't changed

function _log(msg: string, level: string = 'INFO') {
  try { console.log(`[${new Date().toISOString()}] [turbo-sync:${level}] ${msg}`); }
  catch { /* fallback */ }
}

function _getClient() {
  if (_client) return _client;
  if (_syncEnabled) return null; // Already tried and failed

  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  if (!url || !token) {
    _log('Turso not configured (missing TURSO_DATABASE_URL or TURSO_AUTH_TOKEN). Cloud sync disabled.', 'INFO');
    return null;
  }

  try {
    const { createClient } = require('@libsql/client');
    _client = createClient({ url, authToken: token });
    _syncEnabled = true;
    _log(`Turso client initialized: ${url.replace(/\/\/.*@/, '//***@')}`);
    return _client;
  } catch (err: any) {
    _log(`Failed to initialize Turso client: ${err.message}`, 'ERROR');
    return null;
  }
}

/**
 * Execute a SQL statement on Turso. Returns true on success.
 */
async function _exec(sql: string, params: any[] = []): Promise<boolean> {
  const client = _getClient();
  if (!client) return false;

  try {
    await client.execute({ sql, args: params });
    return true;
  } catch (err: any) {
    _syncErrors++;
    _log(`Turso exec failed: ${err.message}`, 'WARN');
    return false;
  }
}

/**
 * Initialize Turso schema (create tables if not exist).
 * Uses the same CREATE TABLE statements as the local SQLite.
 */
async function initTursoSchema(): Promise<void> {
  const client = _getClient();
  if (!client) return;

  const tables = [
    `CREATE TABLE IF NOT EXISTS calibration (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`,
    `CREATE TABLE IF NOT EXISTS completed_modules (name TEXT PRIMARY KEY, completed_at INTEGER, attempts INTEGER DEFAULT 0, completion_time_ms INTEGER, last_attempt INTEGER)`,
    `CREATE TABLE IF NOT EXISTS last_state (url TEXT, state TEXT, timestamp INTEGER)`,
    `CREATE TABLE IF NOT EXISTS banned_actions (action_type TEXT PRIMARY KEY, banned_by TEXT, banned_at INTEGER, reason TEXT)`,
    `CREATE TABLE IF NOT EXISTS provider_registry (provider_name TEXT PRIMARY KEY, endpoint TEXT, model TEXT, last_verified INTEGER, history TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0, total_latency INTEGER DEFAULT 0, last_check INTEGER)`,
    `CREATE TABLE IF NOT EXISTS model_registry (provider TEXT, model_id TEXT PRIMARY KEY, is_free INTEGER DEFAULT 0, is_working INTEGER DEFAULT 0, role TEXT DEFAULT 'candidate', last_tested_at INTEGER, last_success_at INTEGER, failure_count INTEGER DEFAULT 0)`,
  ];

  for (const sql of tables) {
    await _exec(sql);
  }
  _log('Turso schema initialized');
}

/**
 * Compute a deterministic hash of all local DB data for dirty-checking.
 * Returns an MD5 hex string, or null if the DB is not available.
 */
function _computeLocalDataHash(db: any): string | null {
  try {
    const crypto = require('crypto');
    const parts: string[] = [];
    parts.push(`cal:${JSON.stringify(db.db?.prepare('SELECT * FROM calibration ORDER BY key')?.all() || [])}`);
    parts.push(`mod:${JSON.stringify(db.db?.prepare('SELECT * FROM completed_modules ORDER BY name')?.all() || [])}`);
    const ls = db.db?.prepare('SELECT * FROM last_state ORDER BY timestamp DESC LIMIT 1')?.get();
    parts.push(`ls:${JSON.stringify(ls || {})}`);
    parts.push(`ba:${JSON.stringify(db.db?.prepare('SELECT * FROM banned_actions ORDER BY action_type')?.all() || [])}`);
    parts.push(`pr:${JSON.stringify(db.db?.prepare('SELECT * FROM provider_registry ORDER BY provider_name')?.all() || [])}`);
    parts.push(`mr:${JSON.stringify(db.db?.prepare('SELECT * FROM model_registry ORDER BY provider, model_id')?.all() || [])}`);
    return crypto.createHash('md5').update(parts.join('\n')).digest('hex');
  } catch {
    return null;
  }
}

/**
 * Push local data to Turso. Called periodically by the sync timer.
 * Reads from the local SQLite DB and upserts into Turso.
 * Includes a dirty-check: computes a hash of all local data and skips
 * the sync entirely if nothing has changed since the last sync.
 */
async function syncToTurso(): Promise<{ synced: number; errors: number }> {
  const client = _getClient();
  if (!client) return { synced: 0, errors: 0 };

  try {
    const db = require('./database');

    // ─── Dirty-check: skip sync if data hasn't changed ───
    const currentHash = _computeLocalDataHash(db);
    if (currentHash !== null && _lastDataHash !== null && currentHash === _lastDataHash) {
      _lastSyncTime = Date.now();
      return { synced: 0, errors: 0 }; // Nothing changed — skip the round-trip
    }
    if (currentHash !== null) {
      _lastDataHash = currentHash;
    }
  } catch {
    // If dirty-check fails, proceed with sync anyway
  }

  let synced = 0;
  let errors = 0;
  const startTime = Date.now();

  try {
    // We need the local database module
    const db = require('./database');

    // Sync calibration
    try {
      const calibrationRows = db.db?.prepare('SELECT * FROM calibration')?.all() || [];
      for (const row of calibrationRows) {
        const ok = await _exec(
          'INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)',
          [row.key, row.value, row.updated_at]
        );
        if (ok) synced++;
        else errors++;
      }
    } catch (e: any) { errors++; }

    // Sync completed_modules
    try {
      const modules = db.db?.prepare('SELECT * FROM completed_modules')?.all() || [];
      for (const row of modules) {
        const ok = await _exec(
          'INSERT OR REPLACE INTO completed_modules (name, completed_at, attempts, completion_time_ms, last_attempt) VALUES (?, ?, ?, ?, ?)',
          [row.name, row.completed_at, row.attempts, row.completion_time_ms, row.last_attempt]
        );
        if (ok) synced++;
        else errors++;
      }
    } catch (e: any) { errors++; }

    // Sync last_state
    try {
      const lastState = db.db?.prepare('SELECT * FROM last_state ORDER BY timestamp DESC LIMIT 1')?.get();
      if (lastState) {
        const ok = await _exec(
          'INSERT OR REPLACE INTO last_state (url, state, timestamp) VALUES (?, ?, ?)',
          [lastState.url, lastState.state, lastState.timestamp]
        );
        if (ok) synced++;
        else errors++;
      }
    } catch (e: any) { errors++; }

    // Sync banned_actions
    try {
      const banned = db.db?.prepare('SELECT * FROM banned_actions')?.all() || [];
      for (const row of banned) {
        const ok = await _exec(
          'INSERT OR REPLACE INTO banned_actions (action_type, banned_by, banned_at, reason) VALUES (?, ?, ?, ?)',
          [row.action_type, row.banned_by, row.banned_at, row.reason]
        );
        if (ok) synced++;
        else errors++;
      }
    } catch (e: any) { errors++; }

    // Sync provider_registry
    try {
      const providers = db.db?.prepare('SELECT * FROM provider_registry')?.all() || [];
      for (const row of providers) {
        const ok = await _exec(
          'INSERT OR REPLACE INTO provider_registry (provider_name, endpoint, model, last_verified, history, success_count, failure_count, total_latency, last_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [row.provider_name, row.endpoint, row.model, row.last_verified, row.history, row.success_count, row.failure_count, row.total_latency, row.last_check]
        );
        if (ok) synced++;
        else errors++;
      }
    } catch (e: any) { errors++; }

    // Sync model_registry
    try {
      const models = db.db?.prepare('SELECT * FROM model_registry')?.all() || [];
      for (const row of models) {
        const ok = await _exec(
          'INSERT OR REPLACE INTO model_registry (provider, model_id, is_free, is_working, role, last_tested_at, last_success_at, failure_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          [row.provider, row.model_id, row.is_free, row.is_working, row.role, row.last_tested_at, row.last_success_at, row.failure_count]
        );
        if (ok) synced++;
        else errors++;
      }
    } catch (e: any) { errors++; }

    _lastSyncTime = Date.now();
    const duration = Date.now() - startTime;
    if (synced > 0) {
      _log(`Synced ${synced} rows to Turso (${duration}ms, ${errors} errors)`);
    }

    // Reset error count on successful sync
    if (errors === 0) _syncErrors = 0;
  } catch (err: any) {
    _log(`Sync error: ${err.message}`, 'ERROR');
    errors++;
  }

  return { synced, errors };
}

/**
 * Pull data from Turso into local SQLite (cold start recovery).
 * Called on startup if the local DB appears fresh (no completed modules).
 */
async function pullFromTurso(): Promise<{ pulled: number }> {
  const client = _getClient();
  if (!client) return { pulled: 0 };

  let pulled = 0;

  try {
    const db = require('./database');

    // Pull calibration
    try {
      const result = await client.execute('SELECT * FROM calibration');
      for (const row of result.rows) {
        try { db.upsertCalibration?.run(row.key as string, row.value as string, row.updated_at as number); pulled++; } catch {}
      }
    } catch {}

    // Pull completed_modules
    try {
      const result = await client.execute('SELECT * FROM completed_modules');
      for (const row of result.rows) {
        try { db.insertModule?.(row.name as string); pulled++; } catch {}
      }
    } catch {}

    // Pull model_registry
    try {
      const result = await client.execute("SELECT * FROM model_registry WHERE role = 'active'");
      for (const row of result.rows) {
        try { db.upsertModel?.run(row.provider, row.model_id, row.is_free, row.is_working, row.role, row.last_tested_at, row.last_success_at, row.failure_count); pulled++; } catch {}
      }
    } catch {}

    _log(`Pulled ${pulled} rows from Turso (cold start recovery)`);
  } catch (err: any) {
    _log(`Pull from Turso failed: ${err.message}`, 'WARN');
  }

  return { pulled };
}

/**
 * Start the Turso sync service.
 * Initializes schema, pulls data if needed, and starts periodic sync.
 */
async function startTursoSync(): Promise<void> {
  const url = process.env.TURSO_DATABASE_URL;
  const token = process.env.TURSO_AUTH_TOKEN;

  if (!url || !token) {
    _log('Turso sync disabled — set TURSO_DATABASE_URL and TURSO_AUTH_TOKEN to enable.');
    return;
  }

  // Initialize client and schema
  const client = _getClient();
  if (!client) return;

  await initTursoSchema();

  // Cold start: pull from Turso if local DB is empty
  try {
    const db = require('./database');
    const modules = db.getAllModules?.() || [];
    if (modules.length === 0) {
      _log('Local DB is empty — pulling from Turso for cold start recovery...');
      await pullFromTurso();
    }
  } catch {}

  // Start periodic sync (every 60 seconds)
  const SYNC_INTERVAL_MS = parseInt(process.env.TURSO_SYNC_INTERVAL_MS || '60000', 10);
  _syncInterval = setInterval(async () => {
    await syncToTurso();
  }, SYNC_INTERVAL_MS);
  // Don't prevent process exit
  if (_syncInterval?.unref) _syncInterval.unref();

  // Initial sync
  await syncToTurso();

  _log(`Turso sync started (interval: ${SYNC_INTERVAL_MS / 1000}s)`);
}

function stopTursoSync(): void {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
}

function getTursoStatus(): { enabled: boolean; lastSyncTime: number; errors: number; clientConnected: boolean } {
  return {
    enabled: _syncEnabled,
    lastSyncTime: _lastSyncTime,
    errors: _syncErrors,
    clientConnected: !!_client,
  };
}

module.exports = {
  startTursoSync,
  stopTursoSync,
  syncToTurso,
  pullFromTurso,
  getTursoStatus,
  initTursoSchema,
};
