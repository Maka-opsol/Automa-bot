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
  patch_history: 365,     // Patch history - keep 1 year
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
  // NEVER auto-delete: completed_modules, calibration, model_registry, q_values,
  // blocked_modules, schema_version, coordinator_lock, workers, assigned_tasks,
  // runtime_versions, provider_schemas, ui_baselines, provider_registry
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
]);

function cleanupTable(tableName: any, retentionDays: any) { 
  try {
    if (!ALLOWED_CLEANUP_TABLES.has(tableName)) return 0;

    const cutoff = Date.now() - (retentionDays * 24 * 60 * 60 * 1000);
    const stmt = getDb()?.prepare(`DELETE FROM ${tableName} WHERE timestamp < ?`);
    const info = stmt.run(cutoff);
    if (info.changes > 0) {
      log(`Janitor: deleted ${info.changes} old rows from ${tableName} (retention: ${retentionDays}d)`, 'INFO', 'db-janitor');
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

function runJanitor() { 
  log('Running database janitor...', 'DEBUG', 'db-janitor');
  let totalDeleted = 0;

  for (const [table, days] of Object.entries(RETENTION_DAYS)) {
    totalDeleted += cleanupTable(table, days);
  }

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

module.exports = { startDatabaseJanitor, stopJanitor, runJanitor, getStatus, RETENTION_DAYS ,
  _injectDependencies,
};