const { db } = require('./database');
const { log, safeLog, logError } = require('./logger');

function runUltimateMigration() {
  log('🔄 Running ultimate migration for all new tables...', 'INFO', 'migration');
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ui_baselines ( state TEXT PRIMARY KEY, hash TEXT, map TEXT, updated_at INTEGER );
      CREATE TABLE IF NOT EXISTS provider_quotas ( provider TEXT PRIMARY KEY, budget REAL, spent REAL, reset_at INTEGER );
      CREATE TABLE IF NOT EXISTS session_pool ( id INTEGER PRIMARY KEY AUTOINCREMENT, session_data TEXT, created_at INTEGER );
      CREATE TABLE IF NOT EXISTS blackbox ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, state TEXT, action TEXT, semantics_snapshot TEXT, screenshot_hash TEXT, success INTEGER, reasoning TEXT, latency INTEGER, provider_used TEXT );
      CREATE TABLE IF NOT EXISTS flutter_semantics_cache ( id INTEGER PRIMARY KEY AUTOINCREMENT, page_url TEXT, items TEXT, timestamp INTEGER );
      CREATE TABLE IF NOT EXISTS network_intercept_log ( id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, method TEXT, data TEXT, headers TEXT, timestamp INTEGER, replayed INTEGER DEFAULT 0 );
      CREATE TABLE IF NOT EXISTS performance_profile ( id INTEGER PRIMARY KEY AUTOINCREMENT, environment TEXT, slowdown_factor REAL, recorded_at INTEGER );
      CREATE TABLE IF NOT EXISTS gitops_rollback_chain ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, branch TEXT, description TEXT, applied INTEGER DEFAULT 0 );
      CREATE TABLE IF NOT EXISTS semantics_snapshots ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, count INTEGER, data TEXT );
      CREATE TABLE IF NOT EXISTS provider_schemas ( provider TEXT PRIMARY KEY, schema TEXT, version TEXT, updated_at INTEGER );
      CREATE TABLE IF NOT EXISTS exploration_maps ( id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT, map TEXT, created_at INTEGER );
      CREATE TABLE IF NOT EXISTS runtime_versions ( id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT, version TEXT, updated_at INTEGER );
      CREATE TABLE IF NOT EXISTS q_values ( state TEXT, action TEXT, value REAL, updated_at INTEGER, PRIMARY KEY (state, action) );
      CREATE TABLE IF NOT EXISTS blocked_modules ( name TEXT PRIMARY KEY, blocked_at INTEGER, unblock_at INTEGER );
      CREATE TABLE IF NOT EXISTS reflection_history ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, suggestion_type TEXT, description TEXT, file TEXT, success INTEGER );
      CREATE TABLE IF NOT EXISTS coordinator_lock ( id TEXT PRIMARY KEY, holder TEXT, acquired_at INTEGER, expires_at INTEGER );
      CREATE TABLE IF NOT EXISTS workers ( id TEXT PRIMARY KEY, last_heartbeat INTEGER, capabilities TEXT, status TEXT );
      CREATE TABLE IF NOT EXISTS assigned_tasks ( task_id TEXT PRIMARY KEY, worker_id TEXT, assigned_at INTEGER, status TEXT, task_data TEXT, completed_at INTEGER, result TEXT, error TEXT );
      CREATE TABLE IF NOT EXISTS experiment_results ( id INTEGER PRIMARY KEY AUTOINCREMENT, variant_id TEXT, promoted_at INTEGER, success_rate REAL, avg_latency REAL, attempts INTEGER, config TEXT );
      CREATE INDEX IF NOT EXISTS idx_blackbox_timestamp ON blackbox(timestamp);
      CREATE INDEX IF NOT EXISTS idx_semantics_timestamp ON semantics_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_flutter_semantics_url ON flutter_semantics_cache(page_url);
      CREATE INDEX IF NOT EXISTS idx_network_timestamp ON network_intercept_log(timestamp);
      CREATE INDEX IF NOT EXISTS idx_performance_env ON performance_profile(environment);
      CREATE INDEX IF NOT EXISTS idx_gitops_timestamp ON gitops_rollback_chain(timestamp);
      CREATE INDEX IF NOT EXISTS idx_exploration_state ON exploration_maps(state);
    `);
    log('✅ Ultimate migration completed successfully.', 'INFO', 'migration');
  } catch (e) { logError('Ultimate migration failed', e); }
}

module.exports = { runUltimateMigration };
