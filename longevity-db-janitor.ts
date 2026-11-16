'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }

const { log, logError } = require('./logger');

// Data retention policies - how long to keep different data types
const RETENTION_DAYS = {
  blackbox: 14,           // Blackbox decision logs - keep 2 weeks
  network_intercept_log: 3, // Network intercept logs - keep 3 days (very noisy)
  progress_log: 90,       // Progress logs - keep 3 months
  semantics_snapshots: 7,  // Semantics snapshots - keep 1 week
  flutter_semantics_cache: 3, // Flutter semantics cache - keep 3 days
  // patch_history: NOT cleaned by blanket time-based cleanup anymore.
  // The overlay module's collapseRedundantPatchHistory() handles it with
  // status-aware retention: 30d for 'applied', 7d for rejected/rolled_back/superseded.
  // Keeping it here with a conservative 365d as a safety net for any rows
  // that slip through, but the overlay module should handle 99% of cleanup.
  patch_history: 365,     // Safety net only — overlay module does the real pruning
  gitops_rollback_chain: 90, // GitOps rollback - keep 3 months
  performance_profile: 30, // Performance profiles - keep 1 month
  exploration_maps: 14,   // Exploration maps - keep 2 weeks
  provider_quotas: 30,    // Provider quota tracking - keep 1 month
  reflection_history: 180, // Reflection history - keep 6 months
  experiment_results: 365, // Experiment results - keep 1 year
  template_cache: 30,     // Template cache - keep 1 month
  // v6-fix: Previously unbounded tables — would grow forever over 5 years
  config_reconciliation: 30,  // Config reconciliation logs
  patch_embeddings: 90,   // Patch embeddings
  heal_model_metrics: 30,  // Heal model metrics
  degradation_log: 30,     // Degradation ladder logs
  critical_consensus: 90,  // Critical patch consensus
  db_quarantine: 30,       // DB quarantine entries
  dependency_health: 7,   // Dependency health snapshots
  discovered_states: 30,   // Discovered UI states
  // v6-fix (2026-11-15): Previously missing tables — would grow forever
  state_history: 7,        // State transitions — high volume, keep 1 week
  self_heal_events: 90,    // Self-heal audit trail — keep 3 months
  selector_versions: 90,   // Selector version history (rollback) — keep 3 months
  critical_patch_audit: 90, // Critical patch audit (non-pending only) — keep 3 months
  blackbox_full: 30,       // Screenshot BLOBs — keep 1 month (BIG disk consumer)
  // NEVER auto-delete: completed_modules, calibration, model_registry, q_values,
  // blocked_modules, schema_version, coordinator_lock, workers, assigned_tasks,
  // runtime_versions, provider_schemas, ui_baselines, provider_registry
};

// v6-fix (2026-11-15): cleanupTable() previously used `WHERE timestamp < ?` for
// ALL tables, but many tables use a DIFFERENT timestamp column name. Those
// tables' cleanup SILENTLY FAILED (prepare threw, caught by try/catch, returned
// 0) every run for the entire life of the bot. This mapping specifies the
// correct column for each table. Tables marked "(BROKEN)" were in
// RETENTION_DAYS but never actually pruned due to the wrong column name.
const TABLE_TIMESTAMP_COL: Record<string, string> = {
  blackbox: 'timestamp',
  network_intercept_log: 'timestamp',
  progress_log: 'timestamp',
  state_history: 'timestamp',             // NEW
  semantics_snapshots: 'timestamp',
  flutter_semantics_cache: 'timestamp',
  patch_history: 'timestamp',
  gitops_rollback_chain: 'timestamp',
  performance_profile: 'recorded_at',     // (BROKEN — was: timestamp)
  exploration_maps: 'created_at',          // (BROKEN — was: timestamp)
  reflection_history: 'timestamp',
  experiment_results: 'promoted_at',       // (BROKEN — was: timestamp)
  template_cache: 'last_used',             // (BROKEN — was: timestamp)
  config_reconciliation: 'timestamp',
  patch_embeddings: 'created_at',          // (BROKEN — was: timestamp)
  heal_model_metrics: 'created_at',        // (BROKEN — was: timestamp)
  degradation_log: 'timestamp',
  critical_consensus: 'timestamp',
  critical_patch_audit: 'requested_at',   // NEW
  db_quarantine: 'quarantined_at',         // (BROKEN — was: timestamp)
  dependency_health: 'last_checked',       // (BROKEN — was: timestamp)
  discovered_states: 'added_at',           // (BROKEN — was: timestamp)
  self_heal_events: 'timestamp',           // NEW
  selector_versions: 'created_at',         // NEW
  blackbox_full: 'captured_at',            // NEW
};

const JANITOR_INTERVAL_MS = 6 * 60 * 60 * 1000; // Run every 6 hours
const VACUUM_THRESHOLD_BYTES = 50 * 1024 * 1024; // Vacuum if DB > 50MB

const ALLOWED_CLEANUP_TABLES = new Set([
  'blackbox', 'network_intercept_log', 'progress_log', 'semantics_snapshots',
  'flutter_semantics_cache', 'patch_history', 'gitops_rollback_chain',
  'performance_profile', 'exploration_maps', 'reflection_history',
  'experiment_results', 'template_cache',
  // v6-fix: Previously unbounded tables
  'config_reconciliation', 'patch_embeddings', 'heal_model_metrics',
  'degradation_log', 'critical_consensus', 'db_quarantine',
  'dependency_health', 'discovered_states',
  // v6-fix (2026-11-15): Previously missing tables
  'state_history', 'self_heal_events', 'selector_versions',
  'critical_patch_audit', 'blackbox_full',
]);

function cleanupTable(tableName: any, retentionDays: any) {
  try {
    if (!ALLOWED_CLEANUP_TABLES.has(tableName)) return 0;

    // v6-fix (2026-11-15): Use the correct timestamp column for each table.
    // Previously hardcoded `timestamp`, which silently failed for tables
    // using created_at, requested_at, quarantined_at, etc.
    const col = TABLE_TIMESTAMP_COL[tableName] || 'timestamp';
    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);

    // critical_patch_audit: only prune RESOLVED items (status != 'pending').
    // Pending audits must stay until resolved, even if old.
    let sql: string;
    if (tableName === 'critical_patch_audit') {
      sql = `DELETE FROM ${tableName} WHERE ${col} < ? AND status != 'pending'`;
    } else {
      sql = `DELETE FROM ${tableName} WHERE ${col} < ?`;
    }

    const stmt = getDb()?.prepare(sql);
    const info = stmt.run(cutoff);
    if (info.changes > 0) {
      log(`Janitor: deleted ${info.changes} old rows from ${tableName} (retention: ${retentionDays}d, col: ${col})`, 'INFO', 'db-janitor');
    }
    return info.changes;
  } catch (err: any) {
    // Table might not exist yet
    return 0;
  }
}

function cleanupProviderQuotas() { 
  try {
    const cutoff = Date.now() - (RETENTION_DAYS.provider_quotas * 24 * 60 * 60 * 1000);
    getDb()?.prepare(`UPDATE provider_quotas SET spent = 0, reset_at = ? WHERE reset_at < ? OR reset_at IS NULL`).run(Date.now(), cutoff);
    log('Janitor: reset expired provider quotas', 'DEBUG', 'db-janitor');
  } catch (e: any) { logError('Janitor: failed to reset provider quotas', e); }
}

function vacuumIfNeeded() { 
  try {
    const pageCount = getDb()?.pragma('page_count')[0]?.page_count || 0;
    const pageSize = getDb()?.pragma('page_size')[0]?.page_size || 4096;
    const freelistCount = getDb()?.pragma('freelist_count')[0]?.freelist_count || 0;
    const totalSize = pageCount * pageSize;
    const wasteRatio = pageCount > 0 ? freelistCount / pageCount : 0;

    if (totalSize > VACUUM_THRESHOLD_BYTES && wasteRatio > 0.1) {
      // v6-fix: Check disk space before VACUUM (requires ~2x DB size free).
      // On Render free plan with limited disk, VACUUM without checking can
      // cause ENOSPC and corrupt the database.
      try {
        const fs = require('fs');
        const stat = fs.statfsSync(process.cwd());
        const freeBytes = stat.bavail * stat.bsize;
        const requiredBytes = totalSize * 2;
        if (freeBytes < requiredBytes) {
          log(`Janitor: Skipping VACUUM — insufficient disk (need ${Math.round(requiredBytes/1024/1024)}MB, have ${Math.round(freeBytes/1024/1024)}MB free)`, 'WARN', 'db-janitor');
          return;
        }
      } catch (diskErr: any) {
        log(`Janitor: Cannot check disk space, proceeding with VACUUM`, 'WARN', 'db-janitor');
      }
      log(`Janitor: DB is ${Math.round(totalSize/1024/1024)}MB with ${Math.round(wasteRatio*100)}% waste. Running VACUUM...`, 'INFO', 'db-janitor');
      const start = Date.now();
      getDb()?.prepare('VACUUM').run();
      const elapsed = Date.now() - start;
      log(`Janitor: VACUUM completed in ${elapsed}ms`, 'INFO', 'db-janitor');
    } else {
      log(`Janitor: DB is ${Math.round(totalSize/1024/1024)}MB, waste ${Math.round(wasteRatio*100)}% - no vacuum needed`, 'DEBUG', 'db-janitor');
    }
  } catch (err: any) {
    logError('Janitor VACUUM failed', err);
  }
}

/**
 * Smart cleanup for patch_history — status-aware retention.
 * Runs alongside the blanket cleanup but with much shorter windows
 * for non-applied patches. The overlay module's collapseRedundantPatchHistory()
 * is the primary pruner; this is a complementary safety net.
 */
function cleanupPatchHistorySmart() {
  try {
    const db = getDb();
    if (!db) return 0;
    let total = 0;

    // 1) Delete old rejected/rolled_back/superseded patches (7 days)
    const nonAppliedCutoff = Date.now() - (7 * 24 * 60 * 60 * 1000);
    const r1 = db.prepare(
      "DELETE FROM patch_history WHERE status IN ('rejected', 'rolled_back', 'superseded') AND timestamp < ?"
    ).run(nonAppliedCutoff);
    total += r1.changes;

    // 2) Delete old applied patches (30 days) — if the overlay module didn't
    //    already handle it, this catches stragglers. Any patch older than 30 days
    //    that's still 'applied' either got superseded by a git deploy or is
    //    stale. The overlay module's reconcileOverlayWithBase() handles the
    //    graceful detection; this is the hard deadline.
    const appliedCutoff = Date.now() - (30 * 24 * 60 * 60 * 1000);
    const r2 = db.prepare(
      "DELETE FROM patch_history WHERE status = 'applied' AND timestamp < ?"
    ).run(appliedCutoff);
    total += r2.changes;

    // 3) Collapse redundant: for files with multiple 'applied' patches,
    //    keep only the latest (same as overlay module, but as safety net)
    const duplicates = db.prepare(
      "SELECT file, COUNT(*) as cnt, MAX(timestamp) as latest_ts FROM patch_history WHERE status = 'applied' GROUP BY file HAVING cnt > 1"
    ).all();
    for (const row of duplicates) {
      const r3 = db.prepare(
        "UPDATE patch_history SET status = 'superseded' WHERE file = ? AND status = 'applied' AND timestamp < ?"
      ).run(row.file, row.latest_ts);
      total += r3.changes;
    }

    if (total > 0) {
      log(`Janitor: smart patch_history cleanup — ${total} rows pruned (status-aware)`, 'INFO', 'db-janitor');
    }
    return total;
  } catch (err: any) {
    return 0;
  }
}

/**
 * v6-fix (2026-11-15): Prune orphaned blackbox_full rows — screenshot BLOBs
 * left behind after blackbox pruning. blackbox_full has a foreign key to
 * blackbox(id), so when blackbox rows are deleted, their blackbox_full
 * children become orphans. These are the BIGGEST disk consumers (screenshots
 * stored as BLOBs), so orphan cleanup is critical for multi-year operation.
 */
function cleanupBlackboxFullOrphans() {
  try {
    const db = getDb();
    if (!db) return 0;
    const info = db.prepare(
      `DELETE FROM blackbox_full WHERE blackbox_id NOT IN (SELECT id FROM blackbox)`
    ).run();
    if (info.changes > 0) {
      log(`Janitor: deleted ${info.changes} orphaned blackbox_full rows (screenshot BLOBs)`, 'INFO', 'db-janitor');
    }
    return info.changes;
  } catch (err: any) {
    return 0;
  }
}

function runJanitor() {
  log('Running database janitor...', 'DEBUG', 'db-janitor');
  let totalDeleted = 0;

  for (const [table, days] of Object.entries(RETENTION_DAYS)) {
    // Skip patch_history for blanket cleanup — handled by smart cleanup below
    if (table === 'patch_history') continue;
    totalDeleted += cleanupTable(table, days);
  }

  // Smart patch_history cleanup (status-aware, much more aggressive than 365d)
  totalDeleted += cleanupPatchHistorySmart();

  // v6-fix (2026-11-15): Clean up orphaned screenshot BLOBs after blackbox pruning.
  // These are the biggest disk consumers — without this, blackbox_full grows
  // unbounded even though blackbox itself is pruned.
  totalDeleted += cleanupBlackboxFullOrphans();

  cleanupProviderQuotas();

  if (totalDeleted > 0) {
    log(`Janitor: total ${totalDeleted} rows cleaned up`, 'INFO', 'db-janitor');
    vacuumIfNeeded();
  }
}

let _janitorInterval: any = null;

function startDatabaseJanitor() { 
  log('Database janitor started.', 'INFO', 'db-janitor');
  // Run immediately on startup (clean up from previous runs)
  setTimeout(() => {
    try { runJanitor(); } catch (e: any) { logError('Initial janitor run failed', e); }
  }, 30000).unref(); // 30 seconds after startup
  // Then periodically
  _janitorInterval = setInterval(() => {
    try { runJanitor(); } catch (e: any) { logError('Periodic janitor run failed', e); }
  }, JANITOR_INTERVAL_MS);
  if (_janitorInterval.unref) _janitorInterval.unref();
}

function stopJanitor() { if (_janitorInterval) { clearInterval(_janitorInterval); _janitorInterval = null; } }

function getStatus() { 
  try {
    const pageCount = getDb()?.pragma('page_count')[0]?.page_count || 0;
    const pageSize = getDb()?.pragma('page_size')[0]?.page_size || 4096;
    const freelistCount = getDb()?.pragma('freelist_count')[0]?.freelist_count || 0;
    const tables = {};
    for (const table of Object.keys(RETENTION_DAYS)) {
      try { (tables as any)[table] = getDb()?.prepare(`SELECT COUNT(*) as count FROM ${table}`).get()?.count || 0; } catch { (tables as any)[table] = 'N/A'; }
    }
    return { totalSizeBytes: pageCount * pageSize, wastePercent: pageCount > 0 ? Math.round(freelistCount / pageCount * 100) : 0, tables, retentionDays: RETENTION_DAYS };
  } catch (e: any) { return { error: e.message }; }
}

/**
 * v6-fix (2026-11-15): Self-test for the janitor. Verifies that every table
 * in RETENTION_DAYS has a matching entry in TABLE_TIMESTAMP_COL (so cleanup
 * won't silently fail due to a wrong column name) and is in
 * ALLOWED_CLEANUP_TABLES. Also verifies the interval is safe (< 2^31 ms).
 */
function selfTest(): Record<string, any> {
  const checks: string[] = [];
  const retentionTables = Object.keys(RETENTION_DAYS);
  const colTables = Object.keys(TABLE_TIMESTAMP_COL);

  // These tables are in RETENTION_DAYS for documentation but are handled by
  // dedicated functions (not the blanket cleanupTable loop), so they're
  // intentionally NOT in TABLE_TIMESTAMP_COL or ALLOWED_CLEANUP_TABLES.
  const separatelyHandled = new Set(['provider_quotas', 'patch_history']);

  // Every retention table must have a column mapping (unless separately handled)
  for (const table of retentionTables) {
    if (separatelyHandled.has(table)) continue;
    if (!TABLE_TIMESTAMP_COL[table]) {
      checks.push(`${table} in RETENTION_DAYS but missing from TABLE_TIMESTAMP_COL (cleanup would use wrong column)`);
    }
    if (!ALLOWED_CLEANUP_TABLES.has(table)) {
      checks.push(`${table} in RETENTION_DAYS but missing from ALLOWED_CLEANUP_TABLES (cleanup would skip it)`);
    }
  }

  // Interval must be safe (< 2^31 ms)
  if (JANITOR_INTERVAL_MS >= 2147483647) {
    checks.push('JANITOR_INTERVAL_MS would overflow 32-bit timer');
  }

  // blackbox_full orphan cleanup must exist
  if (typeof cleanupBlackboxFullOrphans !== 'function') {
    checks.push('cleanupBlackboxFullOrphans function missing');
  }

  return {
    ok: checks.length === 0,
    checks,
    retentionTableCount: retentionTables.length,
    columnMappingCount: colTables.length,
    allowedCleanupCount: ALLOWED_CLEANUP_TABLES.size,
    intervalMs: JANITOR_INTERVAL_MS,
  };
}

module.exports = {
  // v6-fix (2026-11-15): Add `start`/`stop` aliases so the subsystem runner's
  // startSubsystemGroup('longevity') auto-starts the janitor. Previously the
  // janitor exported only `startDatabaseJanitor` (not `start`), so the
  // subsystem runner silently skipped it — the pruning interval NEVER ran,
  // and the DB grew unbounded despite the module existing and being registered.
  start: startDatabaseJanitor,
  stop: stopJanitor,
  startDatabaseJanitor,
  stopJanitor,
  runJanitor,
  getStatus,
  selfTest,
  RETENTION_DAYS,
  TABLE_TIMESTAMP_COL,
  ALLOWED_CLEANUP_TABLES,
  cleanupTable,
  cleanupBlackboxFullOrphans,
  cleanupPatchHistorySmart,
  _injectDependencies,
};
