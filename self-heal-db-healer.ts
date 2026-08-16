'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const CONFIG = require('./get-config');

// Tables with JSON columns that need validation
const JSON_COLUMNS = {
  patch_history: 'patch',
  exploration_maps: 'map',
  performance_profile: 'profile',
  experiment_results: 'result',
  template_cache: 'template',
  reflection_history: 'reflection',
  gitops_rollback_chain: 'snapshot',
};

// Expected schema per table (column_name -> { type, nullable, default })
// Used for schema drift detection - extended as needed
const EXPECTED_SCHEMA = {
  patch_history: {
    id: { type: 'INTEGER', nullable: false },
    timestamp: { type: 'INTEGER', nullable: false },
    change_description: { type: 'TEXT', nullable: true },
    file: { type: 'TEXT', nullable: false },
    patch: { type: 'TEXT', nullable: true },
    status: { type: 'TEXT', nullable: true },
    applied_at: { type: 'INTEGER', nullable: true },
    source: { type: 'TEXT', nullable: true },
  },
  exploration_maps: {
    id: { type: 'INTEGER', nullable: false },
    timestamp: { type: 'INTEGER', nullable: false },
    map: { type: 'TEXT', nullable: true },
    module_name: { type: 'TEXT', nullable: true },
    coverage_score: { type: 'REAL', nullable: true },
  },
  progress_log: {
    id: { type: 'INTEGER', nullable: false },
    timestamp: { type: 'INTEGER', nullable: false },
    module: { type: 'TEXT', nullable: true },
    question_index: { type: 'INTEGER', nullable: true },
    score: { type: 'INTEGER', nullable: true },
    provider: { type: 'TEXT', nullable: true },
  },
  blackbox: {
    id: { type: 'INTEGER', nullable: false },
    timestamp: { type: 'INTEGER', nullable: false },
    state: { type: 'TEXT', nullable: true },
    action: { type: 'TEXT', nullable: true },
    result: { type: 'TEXT', nullable: true },
    provider: { type: 'TEXT', nullable: true },
  },
  provider_quotas: {
    id: { type: 'INTEGER', nullable: false },
    provider: { type: 'TEXT', nullable: false },
    spent: { type: 'INTEGER', nullable: true, default: 0 },
    limit_val: { type: 'INTEGER', nullable: true },
    reset_at: { type: 'INTEGER', nullable: true },
  },
};

// Expected table list for missing-table detection
const EXPECTED_TABLES = [
  'patch_history', 'exploration_maps', 'progress_log', 'blackbox',
  'provider_quotas', 'performance_profile', 'experiment_results',
  'template_cache', 'reflection_history', 'gitops_rollback_chain',
  'completed_modules', 'calibration', 'model_registry', 'q_values',
  'blocked_modules', 'schema_version', 'coordinator_lock',
  'db_quarantine', 'discovered_states', 'dependency_health',
  'config_reconciliation', 'session_pool', 'provider_health',
  'network_intercept_log', 'semantics_snapshots', 'flutter_semantics_cache',
];

// CREATE TABLE statements for missing tables
const TABLE_CREATION_SQL = {
  db_quarantine: `CREATE TABLE IF NOT EXISTS db_quarantine (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    original_table TEXT NOT NULL,
    original_row_id INTEGER NOT NULL,
    original_data TEXT,
    reason TEXT,
    quarantined_at INTEGER NOT NULL
  )`,
  discovered_states: `CREATE TABLE IF NOT EXISTS discovered_states (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    state_name TEXT NOT NULL UNIQUE,
    transitions TEXT,
    screenshot_hash TEXT,
    reasoning TEXT,
    traverse_count INTEGER DEFAULT 0,
    promoted INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_traversed INTEGER
  )`,
  dependency_health: `CREATE TABLE IF NOT EXISTS dependency_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_timestamp INTEGER NOT NULL,
    npm_healthy INTEGER DEFAULT 1,
    playwright_healthy INTEGER DEFAULT 1,
    issues TEXT,
    heal_attempted INTEGER DEFAULT 0,
    heal_successful INTEGER DEFAULT 0
  )`,
  config_reconciliation: `CREATE TABLE IF NOT EXISTS config_reconciliation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reconciled_at INTEGER NOT NULL,
    key TEXT NOT NULL,
    local_value TEXT,
    remote_value TEXT,
    resolved_value TEXT,
    resolution TEXT,
    reason TEXT
  )`,
  session_pool: `CREATE TABLE IF NOT EXISTS session_pool (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_data TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_validated_at INTEGER,
    valid INTEGER DEFAULT 1
  )`,
  provider_health: `CREATE TABLE IF NOT EXISTS provider_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    success_rate REAL DEFAULT 0,
    latency_ms REAL DEFAULT 0,
    quota_remaining INTEGER DEFAULT 0,
    checked_at INTEGER NOT NULL
  )`,
};

class DatabaseHealer {
  _intervalId: any;
  _running: any;
  completedAt: any;
  durationMs: any;
  error: any;

  constructor() {
    this._intervalId = null;
    this._running = false;
  }

  /**
   * Run the full database health check suite.
   * Returns a summary object with results from each sub-check.
   */
  async runFullCheck() { 
    if (this._running) {
      log('Database healer check already in progress, skipping', 'WARN', 'db-healer');
      return { skipped: true };
    }
    this._running = true;
    const summary: any = {
      startedAt: Date.now(),
      integrity: null,
      jsonValidation: null,
      orphanedRows: null,
      schemaVersion: null,
      vacuum: null,
    };

    try {
      // 1. Integrity check
      summary.integrity = await this._checkIntegrity();

      // 2. JSON column validation
      summary.jsonValidation = await this.validateJsonColumns();

      // 3. Orphaned row detection
      summary.orphanedRows = await this.detectOrphanedRows();

      // 4. Schema version check
      summary.schemaVersion = await this.checkSchemaVersion();

      // 5. Vacuum if needed
      summary.vacuum = await this.vacuumIfNeeded();

      (summary as any).completedAt = Date.now();
      (summary as any).durationMs = (summary as any).completedAt - summary.startedAt;
      log(`Database healer full check completed in ${summary.durationMs}ms`, 'INFO', 'db-healer');
    } catch (err: any) {
      logError('Database healer full check failed', err);
      (summary as any).error = err.message;
    } finally {
      this._running = false;
    }

    return summary;
  }

  /**
   * Step 1: Run PRAGMA integrity_check. If it fails, attempt repair
   * via WAL checkpoint + REINDEX, then re-check.
   * If repair still fails, attempt nuclear DB reset (backup + recreate).
   */
  async _checkIntegrity() { 
    try {
      // Guard: if DB is not injected, nothing to check
      if (!getDb()) {
        log('Database not injected — skipping integrity check', 'WARN', 'db-healer');
        return { ok: true, skipped: true };
      }

      const result = getDb()?.pragma('integrity_check');
      const status = result?.[0]?.integrity_check;

      if (status === 'ok') {
        log('Database integrity check: OK', 'DEBUG', 'db-healer');
        return { ok: true, status };
      }

      log(`Database integrity check FAILED: ${JSON.stringify(result)}`, 'ERROR', 'db-healer');
      logAudit('Database integrity failure detected, attempting repair', 'db-healer');

      // Attempt repair: WAL checkpoint FULL
      try {
        log('Attempting WAL checkpoint (FULL) as repair step 1...', 'INFO', 'db-healer');
        getDb()?.pragma('wal_checkpoint(FULL)');
        log('WAL checkpoint completed', 'DEBUG', 'db-healer');
      } catch (ckptErr: any) {
        logError('WAL checkpoint repair failed', ckptErr);
      }

      // Attempt repair: REINDEX
      try {
        log('Attempting REINDEX as repair step 2...', 'INFO', 'db-healer');
        getDb()?.exec('REINDEX');
        log('REINDEX completed', 'DEBUG', 'db-healer');
      } catch (reindexErr: any) {
        logError('REINDEX repair failed', reindexErr);
      }

      // Re-check after repair attempts
      const recheck = getDb()?.pragma('integrity_check');
      const recheckStatus = recheck?.[0]?.integrity_check;

      if (recheckStatus === 'ok') {
        log('Database integrity restored after repair', 'INFO', 'db-healer');
        logAudit('Database integrity repaired successfully', 'db-healer');
        // v11: Also run schema drift repair after integrity is restored —
        // corrupted DBs often have missing tables/columns too
        try {
          const driftResult = this.repairSchemaDrift();
          if (driftResult.columnsAdded > 0 || driftResult.tablesCreated > 0) {
            log(`Post-repair schema drift fix: ${driftResult.tablesCreated} tables, ${driftResult.columnsAdded} columns`, 'INFO', 'db-healer');
          }
        } catch (driftErr: any) {
          log(`Post-repair schema drift check failed: ${driftErr.message}`, 'WARN', 'db-healer');
        }
        return { ok: true, status: recheckStatus, repaired: true };
      }

      log(`Database integrity still broken after WAL+REINDEX: ${JSON.stringify(recheck)}`, 'ERROR', 'db-healer');
      logAudit('Database integrity repair failed - attempting nuclear reset', 'db-healer');

      // v11: NUCLEAR OPTION — backup corrupted DB and recreate from schema
      // This is the last resort when WAL checkpoint + REINDEX both fail.
      try {
        const resetResult = await this._nuclearDbReset();
        if (resetResult.ok) {
          log('Database nuclear reset SUCCEEDED — fresh DB created', 'INFO', 'db-healer');
          logAudit('Database nuclear reset: corrupted DB backed up, fresh DB created', 'db-healer');
          return { ok: true, status: 'nuclear_reset', repaired: true, nuclearReset: true };
        }
        log(`Database nuclear reset FAILED: ${resetResult.error}`, 'ERROR', 'db-healer');
        return { ok: false, status: recheckStatus, repaired: false, nuclearResetAttempted: true };
      } catch (nuclearErr: any) {
        logError('Database nuclear reset threw error', nuclearErr);
        return { ok: false, status: recheckStatus, repaired: false, nuclearResetAttempted: true, error: nuclearErr.message };
      }
    } catch (err: any) {
      logError('Database integrity check threw error', err);
      // v11: If the integrity check itself throws (not just returns non-ok),
      // the DB connection may be broken. Try nuclear reset.
      try {
        const resetResult = await this._nuclearDbReset();
        if (resetResult.ok) {
          log('Database nuclear reset SUCCEEDED after integrity_check exception', 'INFO', 'db-healer');
          return { ok: true, status: 'nuclear_reset_after_exception', repaired: true, nuclearReset: true };
        }
      } catch (resetErr: any) {
        log(`Nuclear reset after exception also failed: ${resetErr.message}`, 'ERROR', 'db-healer');
      }
      return { ok: false, error: err.message };
    }
  }

  /**
   * Nuclear DB reset: back up the corrupted database file and create
   * a fresh one with the known schema. This is the last resort when
   * WAL checkpoint + REINDEX both fail to restore integrity.
   *
   * Returns { ok: true } on success, { ok: false, error: string } on failure.
   */
  async _nuclearDbReset(): Promise<{ ok: boolean; error?: string }> {
    try {
      const db = getDb();
      if (!db) return { ok: false, error: 'No database reference' };

      // Get the DB file path from better-sqlite3
      const dbPath = (db as any).name;
      if (!dbPath || typeof dbPath !== 'string') {
        return { ok: false, error: 'Cannot determine DB file path' };
      }

      const fs = require('fs');
      const path = require('path');

      // 1. Back up the corrupted DB
      const backupDir = path.join(path.dirname(dbPath), 'db-backups');
      try { fs.mkdirSync(backupDir, { recursive: true }); } catch {}

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupPath = path.join(backupDir, `corrupted-${timestamp}.db`);

      try {
        fs.copyFileSync(dbPath, backupPath);
        log(`Backed up corrupted DB to ${backupPath}`, 'INFO', 'db-healer');
      } catch (copyErr: any) {
        log(`Failed to backup corrupted DB: ${copyErr.message}`, 'WARN', 'db-healer');
        // Continue anyway — we'll try to recreate
      }

      // Also back up WAL and SHM files if they exist
      for (const ext of ['-wal', '-shm']) {
        const walPath = dbPath + ext;
        try {
          if (fs.existsSync(walPath)) {
            fs.copyFileSync(walPath, backupPath + ext);
          }
        } catch {}
      }

      // 2. Close the database connection
      try { db.close(); } catch (closeErr: any) {
        log(`Failed to close corrupted DB: ${closeErr.message}`, 'WARN', 'db-healer');
      }

      // 3. Delete the corrupted files
      try {
        fs.unlinkSync(dbPath);
        for (const ext of ['-wal', '-shm']) {
          try { fs.unlinkSync(dbPath + ext); } catch {}
        }
        log('Deleted corrupted DB files', 'INFO', 'db-healer');
      } catch (delErr: any) {
        log(`Failed to delete corrupted DB: ${delErr.message}`, 'WARN', 'db-healer');
        return { ok: false, error: `Cannot delete corrupted DB: ${delErr.message}` };
      }

      // 4. Re-initialize the database via the database module
      try {
        const dbMod = _deps.database;
        if (dbMod && typeof dbMod.initializeDatabase === 'function') {
          dbMod.initializeDatabase();
          log('Re-initialized database via database module', 'INFO', 'db-healer');
        } else if (dbMod && typeof dbMod.init === 'function') {
          dbMod.init();
          log('Re-initialized database via database.init()', 'INFO', 'db-healer');
        } else {
          return { ok: false, error: 'No database initialization method found on database module' };
        }
      } catch (initErr: any) {
        return { ok: false, error: `DB re-init failed: ${initErr.message}` };
      }

      // 5. Verify the new DB is healthy
      try {
        const freshDb = getDb();
        if (!freshDb) return { ok: false, error: 'DB reference null after re-init' };
        const freshCheck = freshDb.pragma('integrity_check');
        if (freshCheck?.[0]?.integrity_check !== 'ok') {
          return { ok: false, error: `Fresh DB also fails integrity: ${JSON.stringify(freshCheck)}` };
        }
        // 6. Recreate schema
        this.repairSchemaDrift();
        log('Fresh DB integrity verified and schema recreated', 'INFO', 'db-healer');
      } catch (verifyErr: any) {
        return { ok: false, error: `Fresh DB verification failed: ${verifyErr.message}` };
      }

      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Step 2: Validate JSON columns across known tables.
   * Quarantine rows where JSON.parse fails.
   */
  async validateJsonColumns() { 
    const results = { validated: 0, quarantined: 0, errors: [] };

    for (const [tableName, columnName] of Object.entries(JSON_COLUMNS)) {
      try {
        // Check table exists
        const tableExists = getDb()?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(tableName);
        if (!tableExists) continue;

        // Check column exists in table
        const colInfo = getDb()?.pragma(`table_info(${tableName})`);
        const hasColumn = colInfo.some((col: any) => col.name === columnName);
        if (!hasColumn) continue;

        const rows = getDb()?.prepare(`SELECT rowid as _rowid, ${columnName} FROM ${tableName}`).all();
        for (const row of rows) {
          results.validated++;
          const value = row[columnName];
          if (value === null || value === undefined) continue;

          try {
            JSON.parse(value);
          } catch (parseErr: any) {
            log(`Invalid JSON in ${tableName}.${columnName} row ${row._rowid}: ${parseErr.message}`, 'WARN', 'db-healer');
            try {
              this.quarantineRow(tableName, row._rowid, value, `Invalid JSON: ${parseErr.message}`);
              results.quarantined++;
            } catch (qErr: any) {
              (results.errors as any[]).push({ table: tableName, row: row._rowid, error: qErr.message });
            }
          }
        }
      } catch (err: any) {
        logError(`JSON validation failed for table ${tableName}`, err);
        (results.errors as any[]).push({ table: tableName, error: err.message });
      }
    }

    if (results.quarantined > 0) {
      log(`JSON validation: ${results.validated} checked, ${results.quarantined} quarantined`, 'INFO', 'db-healer');
      logAudit(`Quarantined ${results.quarantined} rows with invalid JSON`, 'db-healer');
    } else {
      log(`JSON validation: ${results.validated} rows checked, all valid`, 'DEBUG', 'db-healer');
    }
    return results;
  }

  /**
   * Step 3: Detect orphaned rows by checking foreign key integrity.
   */
  async detectOrphanedRows() { 
    const results = { checked: 0, orphans: 0, details: [] };

    // Known foreign key relationships in the schema
    const fkChecks = [
      {
        child: 'progress_log',
        childCol: 'module',
        parent: 'completed_modules',
        parentCol: 'module_name',
        type: 'soft', // not a real FK, logical relationship
      },
    ];

    for (const check of fkChecks) {
      try {
        const childExists = getDb()?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(check.child);
        const parentExists = getDb()?.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(check.parent);
        if (!childExists || !parentExists) continue;

        const orphans = getDb()?.prepare(`
          SELECT c.rowid as _rowid FROM ${check.child} c
          WHERE c.${check.childCol} IS NOT NULL
          AND c.${check.childCol} NOT IN (SELECT ${check.parentCol} FROM ${check.parent})
        `).all();

        for (const orphan of orphans) {
          try {
            const rowData = getDb()?.prepare(`SELECT * FROM ${check.child} WHERE rowid = ?`).get(orphan._rowid);
            this.quarantineRow(
              check.child,
              orphan._rowid,
              JSON.stringify(rowData),
              `Orphaned: ${check.childCol}='${rowData[check.childCol]}' not found in ${check.parent}.${check.parentCol}`
            );
            results.orphans++;
            (results.details as any[]).push({ table: check.child, rowId: orphan._rowid, reason: 'orphaned_fk' });
          } catch (qErr: any) {
            logError(`Failed to quarantine orphaned row in ${check.child}`, qErr);
          }
        }
        results.checked++;
      } catch (err: any) {
        logError(`Orphan detection failed for ${check.child}`, err);
      }
    }

    if (results.orphans > 0) {
      log(`Orphan detection: ${results.orphans} orphaned rows quarantined`, 'INFO', 'db-healer');
      logAudit(`Quarantined ${results.orphans} orphaned rows`, 'db-healer');
    } else {
      log('Orphan detection: no orphans found', 'DEBUG', 'db-healer');
    }
    return results;
  }

  /**
   * Step 4: Compare expected schema vs actual table columns.
   * Detects missing columns and missing tables.
   */
  async checkSchemaVersion() { 
    const results = { tablesChecked: 0, missingColumns: [], missingTables: [], driftFound: false };

    // Ensure all expected tables exist
    const existingTables = getDb()?.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);
    for (const tableName of EXPECTED_TABLES) {
      if (!existingTables.includes(tableName)) {
        (results.missingTables as any[]).push(tableName);
        results.driftFound = true;
      }
    }

    // Ensure expected creation SQL tables exist
    for (const tableName of Object.keys(TABLE_CREATION_SQL)) {
      if (!existingTables.includes(tableName)) {
        (results.missingTables as any[]).push(tableName);
        results.driftFound = true;
      }
    }

    // Check column-level schema for known tables
    for (const [tableName, expectedCols] of Object.entries(EXPECTED_SCHEMA)) {
      if (!existingTables.includes(tableName)) continue;
      results.tablesChecked++;

      try {
        const actualCols = getDb()?.pragma(`table_info(${tableName})`);
        const actualColNames = new Set(actualCols.map((c: any) => c.name));

        for (const [colName, expected] of Object.entries(expectedCols)) {
          if (!actualColNames.has(colName)) {
            (results.missingColumns as any[]).push({ table: tableName, column: colName, expectedType: expected.type });
            results.driftFound = true;
          }
        }
      } catch (err: any) {
        logError(`Schema check failed for table ${tableName}`, err);
      }
    }

    if (results.driftFound) {
      log(`Schema drift detected: ${results.missingTables.length} missing tables, ${results.missingColumns.length} missing columns`, 'WARN', 'db-healer');
    } else {
      log(`Schema version check: ${results.tablesChecked} tables verified, no drift`, 'DEBUG', 'db-healer');
    }
    return results;
  }

  /**
   * Step 5: Vacuum the database if freelist/pages ratio > 10%.
   */
  async vacuumIfNeeded() { 
    try {
      const pageCount = getDb()?.pragma('page_count')[0]?.page_count || 0;
      const freelistCount = getDb()?.pragma('freelist_count')[0]?.freelist_count || 0;

      if (pageCount === 0) {
        return { vacuumed: false, reason: 'empty_database' };
      }

      const wasteRatio = freelistCount / pageCount;

      if (wasteRatio > 0.1) {
        log(`Vacuum needed: ${freelistCount}/${pageCount} pages free (${Math.round(wasteRatio * 100)}%)`, 'INFO', 'db-healer');
        const start = Date.now();
        getDb()?.pragma('journal_mode = DELETE');
        getDb()?.prepare('VACUUM').run();
        getDb()?.pragma('journal_mode = WAL');
        const elapsed = Date.now() - start;
        log(`VACUUM completed in ${elapsed}ms`, 'INFO', 'db-healer');
        return { vacuumed: true, wasteRatio, elapsedMs: elapsed };
      }

      return { vacuumed: false, wasteRatio: Math.round(wasteRatio * 100) / 100 };
    } catch (err: any) {
      logError('Vacuum check/execution failed', err);
      return { vacuumed: false, error: err.message };
    }
  }

  /**
   * Attempt to repair a specific row by re-deriving from blackbox recordings.
   * Falls back to quarantine if unrepairable.
   */
  repairRow(tableName: any, rowId: any, originalData: any) { 
    try {
      // Check if we can re-derive from blackbox recordings
      let repaired = false;
      let repairedData = null;

      // For patch_history rows, check if the patch file still exists on disk
      if (tableName === 'patch_history') {
        try {
          // Cannot really re-derive a patch from nothing - quarantine it
          repaired = false;
        } catch (e: any) {
          // originalData was not valid JSON anyway
        }
      }

      // For exploration_maps, check if we have recent exploration data
      if (tableName === 'exploration_maps') {
        try {
          // Try to find a valid recent map to use as a template
          const recentMap = getDb()?.prepare('SELECT map FROM exploration_maps WHERE map IS NOT NULL ORDER BY timestamp DESC LIMIT 1').get();
          if (recentMap) {
            JSON.parse(recentMap.map); // validate it's valid JSON
            repairedData = recentMap.map;
            repaired = true;
          }
        } catch (e: any) {
          // No valid recent map found
        }
      }

      if (repaired && repairedData) {
        // Use the correct column name for the table being repaired
        const jsonCol = (JSON_COLUMNS as any)[tableName] || 'map';
        getDb()?.prepare(`UPDATE ${tableName} SET ${jsonCol} = ? WHERE rowid = ?`).run(repairedData, rowId);
        log(`Repaired row ${rowId} in ${tableName} (column: ${jsonCol}) from recent data`, 'INFO', 'db-healer');
        logAudit(`Repaired row ${tableName}:${rowId} via data re-derivation`, 'db-healer');
        return { repaired: true };
      }

      // Not repairable - quarantine it
      this.quarantineRow(tableName, rowId, originalData, 'Unable to re-derive data from available sources');
      return { repaired: false, quarantined: true };
    } catch (err: any) {
      logError(`Failed to repair row ${tableName}:${rowId}`, err);
      this.quarantineRow(tableName, rowId, originalData, `Repair failed: ${err.message}`);
      return { repaired: false, quarantined: true, error: err.message };
    }
  }

  /**
   * Move a row to the db_quarantine table and delete from the original table.
   */
  quarantineRow(tableName: any, rowId: any, originalData: any, reason: any) { 
    try {
      const quarantinedAt = Date.now();

      // Ensure quarantine table exists
      getDb()?.exec(TABLE_CREATION_SQL.db_quarantine);

      // Insert into quarantine
      getDb()?.prepare(`
        INSERT INTO db_quarantine (original_table, original_row_id, original_data, reason, quarantined_at)
        VALUES(?, ?, ?, ?, ?)
      `).run(tableName, rowId, typeof originalData === 'string' ? originalData : JSON.stringify(originalData), reason, quarantinedAt);

      // Delete from original table
      getDb()?.prepare(`DELETE FROM ${tableName} WHERE rowid = ?`).run(rowId);

      log(`Quarantined ${tableName}:${rowId} - reason: ${reason}`, 'INFO', 'db-healer');
      logAudit(`Quarantined ${tableName}:${rowId}: ${reason}`, 'db-healer');
    } catch (err: any) {
      logError(`Failed to quarantine row ${tableName}:${rowId}`, err);
      throw err;
    }
  }

  /**
   * Schema migration tribunal: compare actual vs expected schema and generate
   * migration SQL for missing columns and missing tables.
   */
  repairSchemaDrift() { 
    const migrations = { columnsAdded: 0, tablesCreated: 0, sql: [] };

    try {
      // 1. Create missing tables
      const existingTables = getDb()?.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r: any) => r.name);

      for (const [tableName, createSql] of Object.entries(TABLE_CREATION_SQL)) {
        if (!existingTables.includes(tableName)) {
          try {
            getDb()?.exec(createSql);
            migrations.tablesCreated++;
            (migrations.sql as any[]).push(`-- Created table: ${tableName}\n${createSql}`);
            log(`Created missing table: ${tableName}`, 'INFO', 'db-healer');
            logAudit(`Schema migration: created table ${tableName}`, 'db-healer');
          } catch (err: any) {
            logError(`Failed to create missing table ${tableName}`, err);
            (migrations.sql as any[]).push(`-- FAILED to create table: ${tableName}\n-- Error: ${err.message}`);
          }
        }
      }

      // 2. Add missing columns via ALTER TABLE
      for (const [tableName, expectedCols] of Object.entries(EXPECTED_SCHEMA)) {
        if (!existingTables.includes(tableName)) continue;

        try {
          const actualCols = getDb()?.pragma(`table_info(${tableName})`);
          const actualColNames = new Set(actualCols.map((c: any) => c.name));

          for (const [colName, expected] of Object.entries(expectedCols)) {
            if (!actualColNames.has(colName)) {
              const alterSql = `ALTER TABLE ${tableName} ADD COLUMN ${colName} ${expected.type}`;
              try {
                getDb()?.exec(alterSql);
                migrations.columnsAdded++;
                (migrations.sql as any[]).push(`-- Added column: ${tableName}.${colName}\n${alterSql}`);
                log(`Added missing column ${tableName}.${colName}`, 'INFO', 'db-healer');
                logAudit(`Schema migration: added column ${tableName}.${colName}`, 'db-healer');
              } catch (err: any) {
                logError(`Failed to add column ${tableName}.${colName}`, err);
                (migrations.sql as any[]).push(`-- FAILED to add column: ${tableName}.${colName}\n-- Error: ${err.message}`);
              }
            }
          }
        } catch (err: any) {
          logError(`Schema drift repair failed for table ${tableName}`, err);
        }
      }

      if (migrations.columnsAdded > 0 || migrations.tablesCreated > 0) {
        log(`Schema drift repaired: ${migrations.tablesCreated} tables created, ${migrations.columnsAdded} columns added`, 'INFO', 'db-healer');
      }
    } catch (err: any) {
      logError('Schema drift repair failed', err);
// @ts-expect-error
      migrations.error = err.message;
    }

    return migrations;
  }

  /**
   * Remove quarantined rows older than maxAgeDays.
   */
  pruneQuarantine(maxAgeDays: any) { 
    const days = maxAgeDays || CONFIG.DB_HEALER_QUARANTINE_MAX_AGE_DAYS || 30;
    try {
      const cutoff = Date.now() - (days * 24 * 60 * 60 * 1000);
      const result = getDb()?.prepare('DELETE FROM db_quarantine WHERE quarantined_at < ?').run(cutoff);
      if (result.changes > 0) {
        log(`Pruned ${result.changes} quarantined rows older than ${days} days`, 'INFO', 'db-healer');
      }
      return result.changes;
    } catch (err: any) {
      logError('Failed to prune quarantine', err);
      return 0;
    }
  }

  /**
   * Failsafe health check function - returns true if database is healthy.
   * v11: Made more resilient — handles null DB, exceptions, and triggers
   * repair if a quick check fails.
   */
  async healthCheck() { 
    try {
      const db = getDb();
      if (!db) {
        // DB not injected yet — not a failure, just not ready
        return true;
      }
      const result = db.pragma('integrity_check');
      if (result?.[0]?.integrity_check !== 'ok') {
        log('Failsafe health check: integrity NOT ok — triggering async repair', 'ERROR', 'db-healer');
        // Fire off a repair in the background — don't block the health check
        this._checkIntegrity().then((repairResult) => {
          if (repairResult?.ok) {
            log('Failsafe health check: async repair succeeded', 'INFO', 'db-healer');
          } else {
            log('Failsafe health check: async repair FAILED', 'ERROR', 'db-healer');
          }
        }).catch(() => {});
        // Return false to signal unhealthy, but repair is running
        return false;
      }
      // Quick query test
      db.prepare('SELECT COUNT(*) FROM sqlite_master').get();
      return true;
    } catch (err: any) {
      logError('Database health check failed', err);
      // v11: If the health check throws, the DB connection might be broken.
      // Try async nuclear reset.
      this._nuclearDbReset().then((resetResult) => {
        if (resetResult.ok) {
          log('Failsafe health check: nuclear reset succeeded after exception', 'INFO', 'db-healer');
        } else {
          log('Failsafe health check: nuclear reset also failed after exception', 'ERROR', 'db-healer');
        }
      }).catch(() => {});
      return false;
    }
  }

  /**
   * Start the periodic database healer scheduler.
   */
  start(intervalMs: any) { 
    const interval = intervalMs || 6 * 60 * 60 * 1000; // default 6 hours
    if (this._intervalId) {
      log('Database healer already running', 'WARN', 'db-healer');
      return;
    }

    log(`Database healer started (interval: ${Math.round(interval / 60000)}min)`, 'INFO', 'db-healer');

    // Run initial check after a short delay
    setTimeout(async () => {
      try {
        await this.runFullCheck();
        this.repairSchemaDrift();
      } catch (err: any) {
        logError('Initial database healer run failed', err);
      }
    }, 60000).unref();

    // Register as failsafe health check
    try {
      const { failsafeCoordinator } = require('./failsafe-coordinator');
      if (failsafeCoordinator && typeof failsafeCoordinator.registerHealthCheck === 'function') {
        failsafeCoordinator.registerHealthCheck('database-healer', () => this.healthCheck(), interval);
        log('Registered database healer as failsafe health check', 'DEBUG', 'db-healer');
      }
    } catch (err: any) {
      // failsafe-coordinator may not be available
      log('Could not register with failsafe coordinator (module may not be loaded yet)', 'DEBUG', 'db-healer');
    }

    this._intervalId = setInterval(async () => {
      try {
        await this.runFullCheck();
        this.repairSchemaDrift();
        this.pruneQuarantine(null as any);
      } catch (err: any) {
        logError('Periodic database healer run failed', err);
      }
    }, interval);

    // Don't prevent process exit
    if (this._intervalId.unref) this._intervalId.unref();
  }

  /**
   * Stop the periodic scheduler.
   */
  stop() { 
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      log('Database healer stopped', 'INFO', 'db-healer');
    }
  }
}

// Singleton
const dbHealer = new DatabaseHealer();
module.exports = { DatabaseHealer, dbHealer , _injectDependencies };
