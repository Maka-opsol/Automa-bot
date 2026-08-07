'use strict';

import type { Deps } from './types/di-types';

// ─── Node builtins + npm packages only — no project requires ───
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ─── Dependency Injection ───
// Dependencies are injected via _injectDependencies() from the DI container.
// No top-level require() for project modules.
let _deps: Deps = {};
let _initialized = false;

function _injectDependencies(deps: Deps) {
  _deps = deps;
}

// ─── Lazy accessors with console fallbacks ───
function getLog(): (msg: string, level?: string, _module?: string) => void {
  return _deps.logger?.log || console.log;
}
function getLogError(): (msg: string, err: Error, ctx?: any) => void {
  return _deps.logger?.logError || ((msg: string, err: Error) => console.error(msg, err));
}
function getCONFIG(): any {
  return _deps.config || {};
}

let db: any;
let dbRetries = 0;
const MAX_DB_RETRIES = 3;

function createDatabaseConnection() { 
  const CONFIG = getCONFIG();
  const log = getLog();
  const dbPath = CONFIG.DB_PATH;
  if (!dbPath || typeof dbPath !== 'string') throw new Error('Invalid database path');
  const normalizedPath = path.normalize(dbPath);
  if (normalizedPath.includes('..')) throw new Error('Path traversal detected in database path');
  const dbDir = path.dirname(normalizedPath);
  // Ensure database directory exists with fallback
  if (!fs.existsSync(dbDir)) {
    try { fs.mkdirSync(dbDir, { recursive: true, mode: 0o750 }); } catch (mkdirErr: any) {
      // Fallback to /tmp if original path is not writable
      const fallbackDir = path.join(os.tmpdir(), 'mathu-bot');
      try { fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o750 }); } catch (e2: any) { throw new Error(`Cannot create database directory: ${mkdirErr.message}`); }
      log(`Could not create ${dbDir}, falling back to ${fallbackDir}`, 'WARN', 'database');
      return createDatabaseConnectionAt(path.join(fallbackDir, 'mathu-bot.db'));
    }
  }
  // Verify directory is writable
  try { fs.accessSync(dbDir, fs.constants.W_OK); } catch (e: any) {
    const fallbackDir = path.join(os.tmpdir(), 'mathu-bot');
    try { fs.mkdirSync(fallbackDir, { recursive: true, mode: 0o750 }); } catch (e2: any) {}
    log(`Database directory not writable: ${dbDir}, falling back to ${fallbackDir}`, 'WARN', 'database');
    return createDatabaseConnectionAt(path.join(fallbackDir, 'mathu-bot.db'));
  }
  return createDatabaseConnectionAt(normalizedPath);
}

function createDatabaseConnectionAt(dbPath: string) { 
  const connection = new Database(dbPath);
  connection.pragma('journal_mode = WAL');
  connection.pragma('synchronous = NORMAL');
  connection.pragma('foreign_keys = ON');
  connection.pragma('busy_timeout = 5000');
  connection.pragma('cache_size = -8000');
  connection.pragma('temp_store = MEMORY');
  return connection;
}

function checkIntegrity() { 
  const log = getLog();
  const logError = getLogError();
  try {
    const result = db.pragma('integrity_check');
    if (result[0]?.integrity_check !== 'ok') throw new Error(`Integrity check failed: ${JSON.stringify(result)}`);
    log('Database integrity check passed', 'DEBUG', 'database');
    return true;
  } catch (err: any) {
    logError('Database integrity check failed', err);
    return false;
  }
}

function getCurrentVersion() { 
  try { const row = db.prepare('SELECT version FROM schema_version ORDER BY version DESC LIMIT 1').get(); return row ? row.version : 0; } catch (e: any) { return 0; }
}

function runMigrations() { 
  const CONFIG = getCONFIG();
  const log = getLog();
  const logError = getLogError();
  let current = getCurrentVersion();
  const target = 21;
  if (current === target) { log(`Database schema version ${target} ready.`, 'INFO', 'database'); return; }
  if (current > target) { log(`Database schema version ${current} is ahead of expected ${target}`, 'WARN', 'database'); return; }
  const backupPath = CONFIG.DB_PATH + '.backup.' + Date.now();
  try { fs.copyFileSync(CONFIG.DB_PATH, backupPath); fs.chmodSync(backupPath, 0o600); } catch (err: any) { logError('Failed to backup database before migration', err); throw new Error(`Database backup before migration failed: ${(err as Error).message}`); }
  log(`Migrating database from version ${current} to ${target}...`, 'INFO', 'database');

  const migrationSteps = [
    () => { db.exec(`CREATE TABLE IF NOT EXISTS completed_modules ( name TEXT PRIMARY KEY, completed_at INTEGER, attempts INTEGER DEFAULT 0, completion_time_ms INTEGER, last_attempt INTEGER ); CREATE TABLE IF NOT EXISTS progress_log ( id INTEGER PRIMARY KEY AUTOINCREMENT, action TEXT, state TEXT, timestamp INTEGER, questions_completed INTEGER ); CREATE TABLE IF NOT EXISTS template_cache ( id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT UNIQUE, action_type TEXT, state TEXT, x_percent REAL, y_percent REAL, width_percent REAL, height_percent REAL, crop_data BLOB, created_at INTEGER, last_used INTEGER, hit_count INTEGER DEFAULT 0 ); CREATE TABLE IF NOT EXISTS provider_registry ( provider_name TEXT PRIMARY KEY, endpoint TEXT, model TEXT, last_verified INTEGER, history TEXT, success_count INTEGER DEFAULT 0, failure_count INTEGER DEFAULT 0, total_latency INTEGER DEFAULT 0, last_check INTEGER ); CREATE TABLE IF NOT EXISTS calibration ( key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER ); CREATE TABLE IF NOT EXISTS last_state ( url TEXT, state TEXT, timestamp INTEGER ); CREATE INDEX IF NOT EXISTS idx_progress_timestamp ON progress_log(timestamp); CREATE INDEX IF NOT EXISTS idx_template_last_used ON template_cache(last_used);`); },
    () => {},
    () => { db.exec(`CREATE TABLE IF NOT EXISTS patch_history ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, description TEXT, file TEXT, patch TEXT, status TEXT, applied_at INTEGER, branch TEXT ); CREATE INDEX IF NOT EXISTS idx_patch_timestamp ON patch_history(timestamp);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS model_registry ( provider TEXT, model_id TEXT PRIMARY KEY, is_free INTEGER DEFAULT 0, is_working INTEGER DEFAULT 0, role TEXT DEFAULT 'candidate', last_tested_at INTEGER, last_success_at INTEGER, failure_count INTEGER DEFAULT 0 ); CREATE INDEX IF NOT EXISTS idx_model_role ON model_registry(role);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS state_history ( id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT NOT NULL, timestamp INTEGER NOT NULL, previous_state TEXT ); CREATE INDEX IF NOT EXISTS idx_state_history_timestamp ON state_history(timestamp);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS ui_baselines ( state TEXT PRIMARY KEY, hash TEXT, map TEXT, updated_at INTEGER ); CREATE TABLE IF NOT EXISTS provider_quotas ( provider TEXT PRIMARY KEY, budget REAL, spent REAL, reset_at INTEGER ); CREATE TABLE IF NOT EXISTS session_pool ( id INTEGER PRIMARY KEY AUTOINCREMENT, session_data TEXT, created_at INTEGER ); CREATE TABLE IF NOT EXISTS blackbox ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, state TEXT, action TEXT, semantics_snapshot TEXT, screenshot_hash TEXT, success INTEGER, reasoning TEXT, latency INTEGER, provider_used TEXT ); CREATE TABLE IF NOT EXISTS semantics_snapshots ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, count INTEGER, data TEXT ); CREATE INDEX IF NOT EXISTS idx_blackbox_timestamp ON blackbox(timestamp); CREATE INDEX IF NOT EXISTS idx_semantics_timestamp ON semantics_snapshots(timestamp);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS flutter_semantics_cache ( id INTEGER PRIMARY KEY AUTOINCREMENT, page_url TEXT, items TEXT, timestamp INTEGER ); CREATE INDEX IF NOT EXISTS idx_flutter_semantics_url ON flutter_semantics_cache(page_url);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS network_intercept_log ( id INTEGER PRIMARY KEY AUTOINCREMENT, url TEXT, method TEXT, data TEXT, headers TEXT, timestamp INTEGER, replayed INTEGER DEFAULT 0 ); CREATE INDEX IF NOT EXISTS idx_network_timestamp ON network_intercept_log(timestamp);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS performance_profile ( id INTEGER PRIMARY KEY AUTOINCREMENT, environment TEXT, slowdown_factor REAL, recorded_at INTEGER ); CREATE INDEX IF NOT EXISTS idx_performance_env ON performance_profile(environment);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS gitops_rollback_chain ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, branch TEXT, description TEXT, applied INTEGER DEFAULT 0 ); CREATE INDEX IF NOT EXISTS idx_gitops_timestamp ON gitops_rollback_chain(timestamp);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS provider_schemas ( provider TEXT PRIMARY KEY, schema TEXT, version TEXT, updated_at INTEGER ); CREATE TABLE IF NOT EXISTS exploration_maps ( id INTEGER PRIMARY KEY AUTOINCREMENT, state TEXT, map TEXT, created_at INTEGER ); CREATE INDEX IF NOT EXISTS idx_exploration_state ON exploration_maps(state);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS runtime_versions ( id INTEGER PRIMARY KEY AUTOINCREMENT, component TEXT, version TEXT, updated_at INTEGER );`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS q_values ( state TEXT, action TEXT, value REAL, updated_at INTEGER, PRIMARY KEY (state, action) ); CREATE TABLE IF NOT EXISTS blocked_modules ( name TEXT PRIMARY KEY, blocked_at INTEGER, unblock_at INTEGER ); CREATE TABLE IF NOT EXISTS reflection_history ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER, suggestion_type TEXT, description TEXT, file TEXT, success INTEGER );`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS coordinator_lock ( id TEXT PRIMARY KEY, holder TEXT, acquired_at INTEGER, expires_at INTEGER ); CREATE TABLE IF NOT EXISTS workers ( id TEXT PRIMARY KEY, last_heartbeat INTEGER, capabilities TEXT, status TEXT ); CREATE TABLE IF NOT EXISTS assigned_tasks ( task_id TEXT PRIMARY KEY, worker_id TEXT, assigned_at INTEGER, status TEXT, task_data TEXT, completed_at INTEGER, result TEXT, error TEXT );`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS experiment_results ( id INTEGER PRIMARY KEY AUTOINCREMENT, variant_id TEXT, promoted_at INTEGER, success_rate REAL, avg_latency REAL, attempts INTEGER, config TEXT );`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS critical_patch_audit ( id INTEGER PRIMARY KEY AUTOINCREMENT, requested_at INTEGER, target_file TEXT, description TEXT, status TEXT DEFAULT 'pending', phases_completed TEXT, provider_votes TEXT, resolution TEXT, resolved_at INTEGER ); CREATE INDEX IF NOT EXISTS idx_critical_audit_time ON critical_patch_audit(requested_at); CREATE INDEX IF NOT EXISTS idx_critical_audit_status ON critical_patch_audit(status);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS self_heal_events ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, feature_id TEXT NOT NULL, phase TEXT NOT NULL, trigger_reason TEXT, investigation_result TEXT, patches_generated INTEGER DEFAULT 0, patches_safe INTEGER DEFAULT 0, patches_applied INTEGER DEFAULT 0, outcome TEXT, duration_ms INTEGER, error TEXT ); CREATE INDEX IF NOT EXISTS idx_self_heal_events_time ON self_heal_events(timestamp); CREATE INDEX IF NOT EXISTS idx_self_heal_events_feature ON self_heal_events(feature_id); CREATE TABLE IF NOT EXISTS selector_versions ( id INTEGER PRIMARY KEY AUTOINCREMENT, selector_file TEXT NOT NULL, version INTEGER DEFAULT 1, content TEXT NOT NULL, previous_content TEXT, created_at INTEGER NOT NULL, source TEXT DEFAULT 'auto', validated INTEGER DEFAULT 0 ); CREATE TABLE IF NOT EXISTS patch_canary ( id INTEGER PRIMARY KEY AUTOINCREMENT, patch_id INTEGER NOT NULL, mode TEXT NOT NULL DEFAULT 'canary', started_at INTEGER NOT NULL, observation_hours REAL DEFAULT 6, error_rate_baseline REAL DEFAULT 0, error_rate_observed REAL DEFAULT 0, cycles_run INTEGER DEFAULT 0, status TEXT DEFAULT 'canary', promoted_at INTEGER, rolled_back_at INTEGER, FOREIGN KEY (patch_id) REFERENCES patch_history(id) ); CREATE TABLE IF NOT EXISTS adversarial_test_results ( id INTEGER PRIMARY KEY AUTOINCREMENT, patch_id INTEGER NOT NULL, test_type TEXT NOT NULL, passed INTEGER DEFAULT 0, details TEXT, tested_at INTEGER NOT NULL, FOREIGN KEY (patch_id) REFERENCES patch_history(id) ); CREATE TABLE IF NOT EXISTS db_quarantine ( id INTEGER PRIMARY KEY AUTOINCREMENT, table_name TEXT NOT NULL, row_id INTEGER, original_data TEXT, reason TEXT, quarantined_at INTEGER NOT NULL, repair_attempted INTEGER DEFAULT 0, repaired INTEGER DEFAULT 0 ); CREATE TABLE IF NOT EXISTS discovered_states ( state TEXT PRIMARY KEY, added_at INTEGER NOT NULL, traverse_count INTEGER DEFAULT 0, last_traversed INTEGER, ttl_days INTEGER DEFAULT 7, promoted INTEGER DEFAULT 0, source_screenshot_hash TEXT, tribunal_reasoning TEXT ); CREATE TABLE IF NOT EXISTS dependency_health ( id INTEGER PRIMARY KEY AUTOINCREMENT, package TEXT NOT NULL, expected_hash TEXT, actual_hash TEXT, healthy INTEGER DEFAULT 1, last_checked INTEGER, repair_attempted INTEGER DEFAULT 0, repair_result TEXT ); CREATE TABLE IF NOT EXISTS config_reconciliation ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, source TEXT NOT NULL, key TEXT NOT NULL, local_value TEXT, remote_value TEXT, resolved_value TEXT, resolution TEXT ); CREATE TABLE IF NOT EXISTS blackbox_full ( id INTEGER PRIMARY KEY AUTOINCREMENT, blackbox_id INTEGER NOT NULL, screenshot BLOB, dom_html TEXT, network_log TEXT, tribunal_responses TEXT, captured_at INTEGER NOT NULL, FOREIGN KEY (blackbox_id) REFERENCES blackbox(id) ); CREATE INDEX IF NOT EXISTS idx_blackbox_full_bb ON blackbox_full(blackbox_id); CREATE TABLE IF NOT EXISTS patch_embeddings ( id INTEGER PRIMARY KEY AUTOINCREMENT, patch_id INTEGER NOT NULL, embedding TEXT, investigation_context TEXT, file TEXT, patch_text TEXT, status TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (patch_id) REFERENCES patch_history(id) ); CREATE INDEX IF NOT EXISTS idx_patch_embeddings_time ON patch_embeddings(created_at); CREATE TABLE IF NOT EXISTS heal_model_metrics ( id INTEGER PRIMARY KEY AUTOINCREMENT, model_name TEXT NOT NULL, patch_id INTEGER, staging_passed INTEGER DEFAULT 0, prod_survived_24h INTEGER DEFAULT 0, prod_checked_at INTEGER, created_at INTEGER NOT NULL ); CREATE TABLE IF NOT EXISTS healer_circuit_state ( id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT DEFAULT 'closed', failure_count INTEGER DEFAULT 0, success_count INTEGER DEFAULT 0, last_failure_time INTEGER, consecutive_opens INTEGER DEFAULT 0, updated_at INTEGER ); CREATE TABLE IF NOT EXISTS degradation_log ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, from_mode TEXT NOT NULL, to_mode TEXT NOT NULL, reason TEXT, resource_snapshot TEXT );`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS critical_consensus ( id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp INTEGER NOT NULL, phase TEXT NOT NULL, target_file TEXT, provider TEXT, approved INTEGER DEFAULT 0, confidence REAL DEFAULT 0, reasoning TEXT, patch_hash TEXT, details TEXT ); CREATE INDEX IF NOT EXISTS idx_critical_consensus_timestamp ON critical_consensus(timestamp); CREATE INDEX IF NOT EXISTS idx_critical_consensus_phase ON critical_consensus(phase); CREATE INDEX IF NOT EXISTS idx_critical_consensus_file ON critical_consensus(target_file); CREATE INDEX IF NOT EXISTS idx_critical_consensus_hash ON critical_consensus(patch_hash);`); },
    () => { db.exec(`CREATE TABLE IF NOT EXISTS banned_actions ( action_type TEXT PRIMARY KEY, banned_by TEXT, banned_at INTEGER, reason TEXT );`); },
    () => {},
    () => {},
    () => {},
    () => { try { db.exec(`ALTER TABLE session_pool ADD COLUMN last_validated_at INTEGER;`); } catch (_e: any) { /* column may already exist */ } },
  ];

  const transaction = db.transaction(() => {
    while (current < target) { current++; try { if (migrationSteps[current - 1]) { migrationSteps[current - 1](); log(`Applied migration ${current}`, 'DEBUG', 'database'); } } catch (err: any) { throw new Error(`Migration ${current} failed: ${err.message}`); } }
    db.prepare('INSERT OR REPLACE INTO schema_version (version, applied_at) VALUES (?, ?)').run(target, Date.now());
  });

  try {
    transaction();
    log(`Database migrated successfully to version ${target}`, 'INFO', 'database');
    if (checkIntegrity()) { try { fs.unlinkSync(backupPath); } catch (e: any) {} } else { throw new Error('Post-migration integrity check failed'); }
  } catch (err: any) {
    logError('Migration failed, restoring backup', err);
    try { db.close(); fs.copyFileSync(backupPath, CONFIG.DB_PATH); db = createDatabaseConnection(); } catch (restoreErr: any) { logError('Failed to restore backup', restoreErr); }
    // v5-fix: Throw instead of process.exit(1) — allows caller (agent.ts) to
    // perform cleanup (close browser, flush logs) before exiting gracefully.
    throw new Error(`Database migration failed: ${(err as Error).message}. Backup restored from ${backupPath}`);
  }
}

/**
 * Initialize the database: connect, check integrity, run migrations.
 * Must be called after _injectDependencies().
 */
function initDatabase() {
  if (_initialized) return;
  const log = getLog();
  const logError = getLogError();

  while (dbRetries < MAX_DB_RETRIES) {
    try { db = createDatabaseConnection(); break; } catch (err: any) {
      dbRetries++;
      logError(`Database connection attempt ${dbRetries} failed`, err);
      if (dbRetries >= MAX_DB_RETRIES) { throw new Error('All database connection attempts failed'); }
      const backoff = 1000 * Math.pow(2, dbRetries);
      log(`Retrying database connection in ${backoff}ms...`, 'WARN', 'database');
      // Synchronous sleep via child_process (initDatabase must remain sync for container factory).
      // Only used during startup retries — at most MAX_DB_RETRIES times.
      try {
        const { execSync } = require('child_process');
        execSync(`sleep ${Math.min(backoff / 1000, 30)}`, { stdio: 'ignore', timeout: Math.min(backoff, 30000) + 1000 });
      } catch { /* sleep interrupted or unavailable — retry immediately */ }
    }
  }

  if (!checkIntegrity()) {
    log('Attempting database recovery...', 'WARN', 'database');
    try {
      db.pragma('recovery');
      if (!checkIntegrity()) { log('Database recovery failed, creating new database', 'ERROR', 'database'); try { fs.unlinkSync(db.name); } catch (e: any) { /* file may not exist */ } db = createDatabaseConnection(); }
    } catch (err: any) { logError('Database recovery error', err); throw new Error('Database recovery failed: ' + (err as Error).message); }
  }

  runMigrations();
  createPreparedStatements();
  _initialized = true;
}

function createSafeStatement(sql: string, paramValidator: ((...args: any[]) => string | null) | null = null) { 
  const stmt = db.prepare(sql);
  return {
    run: (...args: any[]) => { if (paramValidator) { const validationError = paramValidator(...args); if (validationError) { throw new Error(`Parameter validation failed: ${validationError}`); } } return stmt.run(...args); },
    get: (...args: any[]) => { if (paramValidator) { const validationError = paramValidator(...args); if (validationError) { throw new Error(`Parameter validation failed: ${validationError}`); } } return stmt.get(...args); },
    all: (...args: any[]) => { if (paramValidator) { const validationError = paramValidator(...args); if (validationError) { throw new Error(`Parameter validation failed: ${validationError}`); } } return stmt.all(...args); }
  };
}

const positiveInt = (val: any) => (typeof val !== 'number' || val <= 0 || !Number.isInteger(val)) ? 'must be positive integer' : null;
const nonEmptyString = (val: any) => (typeof val !== 'string' || val.length === 0) ? 'must be non-empty string' : null;
const validState = (val: any) => (typeof val !== 'string' || val.length === 0 || val.length > 100) ? 'invalid state' : null;

// NOTE: Prepared statements are created lazily on first call to initDatabase().
// Before initDatabase() is called, these will be undefined.
// We define them as null and populate them in initDatabase().
let insertModule: any, selectModule: any, getAllModules: any;
let insertProgress: any, getRecentProgress: any, insertTemplate: any;
let selectTemplate: any, listTemplates: any, updateTemplateHit: any;
let upsertProvider: any, selectProvider: any, listProviders: any;
let upsertCalibration: any, selectCalibration: any;
let upsertLastState: any, selectLastState: any;
let insertPatch: any, getRecentPatches: any, updateProviderStats: any;
let upsertModel: any, getActiveModel: any, getFallbackModel: any, setModelRole: any;
let upsertUiBaseline: any, selectUiBaseline: any;
let insertBlackbox: any, getBlackbox: any;
let insertSemanticsSnapshot: any;
let insertNetworkLog: any, getNetworkLogs: any;
let upsertPerformanceProfile: any, selectPerformanceProfile: any;
let insertGitopsChain: any, getGitopsChain: any, updateGitopsApplied: any;
let insertFlutterSemantics: any, getFlutterSemantics: any;
let upsertProviderSchema: any, selectProviderSchema: any;
let insertExplorationMap: any, getExplorationMaps: any;
let upsertRuntimeVersion: any, selectRuntimeVersion: any;
let insertSelfHealEvent: any, getSelfHealTimeline: any;
let insertSelectorVersion: any, getLatestSelectorVersion: any;
let insertPatchCanary: any, updatePatchCanary: any, getActiveCanary: any;
let insertAdversarialResult: any;
let insertDbQuarantine: any, getQuarantinedRows: any;
let upsertDiscoveredState: any, getDiscoveredStates: any, pruneExpiredStates: any;
let insertDependencyHealth: any, getDependencyHealth: any;
let insertConfigReconciliation: any;
let insertBlackboxFull: any, getBlackboxFull: any;
let insertPatchEmbedding: any, searchPatchEmbeddings: any;
let insertHealModelMetric: any, getHealModelMetrics: any;
let getOrCreateHealerCircuitState: any, updateHealerCircuitState: any, getHealerCircuitState: any;
let insertDegradationLog: any, getDegradationLog: any;
let insertBannedAction: any, deleteBannedAction: any, listBannedActions: any, selectBannedAction: any;

function createPreparedStatements() {
  insertModule = createSafeStatement('INSERT OR IGNORE INTO completed_modules (name, completed_at) VALUES (?, ?)', nonEmptyString);
  selectModule = createSafeStatement('SELECT 1 FROM completed_modules WHERE name = ?', nonEmptyString);
  getAllModules = db.prepare('SELECT name, completed_at, attempts, completion_time_ms FROM completed_modules');
  insertProgress = createSafeStatement('INSERT INTO progress_log (action, state, timestamp, questions_completed) VALUES (?, ?, ?, ?)', (action, state, timestamp, questions) => { if (nonEmptyString(action)) return `invalid action: ${action}`; if (validState(state)) return `invalid state: ${state}`; if (positiveInt(timestamp)) return `invalid timestamp: ${timestamp}`; if (questions !== undefined && questions !== null && positiveInt(questions)) return `invalid questions: ${questions}`; return null; });
  getRecentProgress = createSafeStatement('SELECT * FROM progress_log ORDER BY timestamp DESC LIMIT ?', positiveInt);
  insertTemplate = db.prepare(`INSERT OR REPLACE INTO template_cache (hash, action_type, state, x_percent, y_percent, width_percent, height_percent, crop_data, created_at, last_used, hit_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  selectTemplate = db.prepare('SELECT * FROM template_cache WHERE hash = ?');
  listTemplates = db.prepare('SELECT * FROM template_cache ORDER BY hit_count DESC LIMIT ?');
  updateTemplateHit = db.prepare('UPDATE template_cache SET last_used = ?, hit_count = hit_count + 1 WHERE id = ?');
  upsertProvider = db.prepare(`INSERT OR REPLACE INTO provider_registry (provider_name, endpoint, model, last_verified, history, success_count, failure_count, total_latency, last_check) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  selectProvider = db.prepare('SELECT * FROM provider_registry WHERE provider_name = ?');
  listProviders = db.prepare('SELECT * FROM provider_registry');
  upsertCalibration = db.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)');
  selectCalibration = db.prepare('SELECT value FROM calibration WHERE key = ?');
  upsertLastState = db.prepare('INSERT OR REPLACE INTO last_state (url, state, timestamp) VALUES (?, ?, ?)');
  selectLastState = db.prepare('SELECT url, state FROM last_state ORDER BY timestamp DESC LIMIT 1');
  insertPatch = db.prepare('INSERT INTO patch_history (timestamp, description, file, patch, status, applied_at, branch) VALUES (?, ?, ?, ?, ?, ?, ?)');
  getRecentPatches = db.prepare('SELECT * FROM patch_history ORDER BY timestamp DESC LIMIT ?');
  updateProviderStats = db.prepare('UPDATE provider_registry SET success_count = ?, failure_count = ?, total_latency = ?, last_check = ? WHERE provider_name = ?');
  upsertModel = db.prepare(`INSERT OR REPLACE INTO model_registry (provider, model_id, is_free, is_working, role, last_tested_at, last_success_at, failure_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  getActiveModel = db.prepare("SELECT model_id, provider FROM model_registry WHERE role = 'active' LIMIT 1");
  getFallbackModel = db.prepare("SELECT model_id, provider FROM model_registry WHERE role = 'fallback' LIMIT 1");
  setModelRole = db.prepare("UPDATE model_registry SET role = ? WHERE model_id = ?");
  upsertUiBaseline = db.prepare(`INSERT OR REPLACE INTO ui_baselines (state, hash, map, updated_at) VALUES (?, ?, ?, ?)`);
  selectUiBaseline = db.prepare('SELECT * FROM ui_baselines WHERE state = ?');
  insertBlackbox = db.prepare(`INSERT INTO blackbox (timestamp, state, action, semantics_snapshot, screenshot_hash, success, reasoning, latency, provider_used) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  getBlackbox = db.prepare('SELECT * FROM blackbox ORDER BY timestamp DESC LIMIT ?');
  insertSemanticsSnapshot = db.prepare(`INSERT INTO semantics_snapshots (timestamp, count, data) VALUES (?, ?, ?)`);
  insertNetworkLog = db.prepare(`INSERT INTO network_intercept_log (url, method, data, headers, timestamp, replayed) VALUES (?, ?, ?, ?, ?, ?)`);
  getNetworkLogs = db.prepare('SELECT * FROM network_intercept_log ORDER BY timestamp DESC LIMIT ?');
  upsertPerformanceProfile = db.prepare(`INSERT OR REPLACE INTO performance_profile (environment, slowdown_factor, recorded_at) VALUES (?, ?, ?)`);
  selectPerformanceProfile = db.prepare('SELECT * FROM performance_profile ORDER BY recorded_at DESC LIMIT 1');
  insertGitopsChain = db.prepare(`INSERT INTO gitops_rollback_chain (timestamp, branch, description, applied) VALUES (?, ?, ?, ?)`);
  getGitopsChain = db.prepare('SELECT * FROM gitops_rollback_chain ORDER BY timestamp DESC LIMIT ?');
  updateGitopsApplied = db.prepare('UPDATE gitops_rollback_chain SET applied = ? WHERE timestamp = ?');
  insertFlutterSemantics = db.prepare(`INSERT OR REPLACE INTO flutter_semantics_cache (page_url, items, timestamp) VALUES (?, ?, ?)`);
  getFlutterSemantics = db.prepare('SELECT * FROM flutter_semantics_cache WHERE page_url = ? ORDER BY timestamp DESC LIMIT 1');
  upsertProviderSchema = db.prepare(`INSERT OR REPLACE INTO provider_schemas (provider, schema, version, updated_at) VALUES (?, ?, ?, ?)`);
  selectProviderSchema = db.prepare('SELECT * FROM provider_schemas WHERE provider = ?');
  insertExplorationMap = db.prepare(`INSERT INTO exploration_maps (state, map, created_at) VALUES (?, ?, ?)`);
  getExplorationMaps = db.prepare('SELECT * FROM exploration_maps ORDER BY created_at DESC LIMIT ?');
  upsertRuntimeVersion = db.prepare(`INSERT OR REPLACE INTO runtime_versions (component, version, updated_at) VALUES (?, ?, ?)`);
  selectRuntimeVersion = db.prepare('SELECT * FROM runtime_versions WHERE component = ?');
  // Self-heal statements
  insertSelfHealEvent = db.prepare(`INSERT INTO self_heal_events (timestamp, feature_id, phase, trigger_reason, investigation_result, patches_generated, patches_safe, patches_applied, outcome, duration_ms, error) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  getSelfHealTimeline = db.prepare('SELECT * FROM self_heal_events ORDER BY timestamp DESC LIMIT ?');
  insertSelectorVersion = db.prepare(`INSERT INTO selector_versions (selector_file, version, content, previous_content, created_at, source, validated) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  getLatestSelectorVersion = db.prepare('SELECT * FROM selector_versions WHERE selector_file = ? ORDER BY version DESC LIMIT 1');
  insertPatchCanary = db.prepare(`INSERT INTO patch_canary (patch_id, mode, started_at, observation_hours, error_rate_baseline) VALUES (?, ?, ?, ?, ?)`);
  updatePatchCanary = db.prepare('UPDATE patch_canary SET mode = ?, error_rate_observed = ?, cycles_run = ?, status = ?, promoted_at = ?, rolled_back_at = ? WHERE id = ?');
  getActiveCanary = db.prepare("SELECT * FROM patch_canary WHERE status = 'canary' ORDER BY started_at DESC LIMIT 1");
  insertAdversarialResult = db.prepare(`INSERT INTO adversarial_test_results (patch_id, test_type, passed, details, tested_at) VALUES (?, ?, ?, ?, ?)`);
  insertDbQuarantine = db.prepare(`INSERT INTO db_quarantine (table_name, row_id, original_data, reason, quarantined_at) VALUES (?, ?, ?, ?, ?)`);
  getQuarantinedRows = db.prepare('SELECT * FROM db_quarantine WHERE repaired = 0 ORDER BY quarantined_at DESC LIMIT ?');
  upsertDiscoveredState = db.prepare(`INSERT OR REPLACE INTO discovered_states (state, added_at, traverse_count, last_traversed, ttl_days, promoted, source_screenshot_hash, tribunal_reasoning) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  getDiscoveredStates = db.prepare('SELECT * FROM discovered_states WHERE promoted = 1');
  pruneExpiredStates = db.prepare("DELETE FROM discovered_states WHERE promoted = 0 AND last_traversed < ?");
  insertDependencyHealth = db.prepare(`INSERT OR REPLACE INTO dependency_health (package, expected_hash, actual_hash, healthy, last_checked) VALUES (?, ?, ?, ?, ?)`);
  getDependencyHealth = db.prepare('SELECT * FROM dependency_health ORDER BY last_checked DESC');
  insertConfigReconciliation = db.prepare(`INSERT INTO config_reconciliation (timestamp, source, key, local_value, remote_value, resolved_value, resolution) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insertBlackboxFull = db.prepare(`INSERT INTO blackbox_full (blackbox_id, screenshot, dom_html, network_log, tribunal_responses, captured_at) VALUES (?, ?, ?, ?, ?, ?)`);
  getBlackboxFull = db.prepare('SELECT * FROM blackbox_full WHERE blackbox_id = ?');
  insertPatchEmbedding = db.prepare(`INSERT INTO patch_embeddings (patch_id, embedding, investigation_context, file, patch_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  searchPatchEmbeddings = db.prepare('SELECT * FROM patch_embeddings ORDER BY created_at DESC LIMIT ?');
  insertHealModelMetric = db.prepare(`INSERT INTO heal_model_metrics (model_name, patch_id, staging_passed, prod_survived_24h, created_at) VALUES (?, ?, ?, ?, ?)`);
  getHealModelMetrics = db.prepare("SELECT model_name, COUNT(*) as total, SUM(staging_passed) as staging_passes, SUM(prod_survived_24h) as prod_survived FROM heal_model_metrics GROUP BY model_name");
  getOrCreateHealerCircuitState = db.prepare("INSERT OR IGNORE INTO healer_circuit_state (id, state, updated_at) VALUES (1, 'closed', ?)");
  updateHealerCircuitState = db.prepare("UPDATE healer_circuit_state SET state = ?, failure_count = ?, success_count = ?, last_failure_time = ?, consecutive_opens = ?, updated_at = ? WHERE id = 1");
  getHealerCircuitState = db.prepare("SELECT * FROM healer_circuit_state WHERE id = 1");
  insertDegradationLog = db.prepare(`INSERT INTO degradation_log (timestamp, from_mode, to_mode, reason, resource_snapshot) VALUES (?, ?, ?, ?, ?)`);
  getDegradationLog = db.prepare('SELECT * FROM degradation_log ORDER BY timestamp DESC LIMIT ?');
  // Dashboard control: banned actions
  insertBannedAction = db.prepare(`INSERT OR REPLACE INTO banned_actions (action_type, banned_by, banned_at, reason) VALUES (?, ?, ?, ?)`);
  deleteBannedAction = db.prepare('DELETE FROM banned_actions WHERE action_type = ?');
  listBannedActions = db.prepare('SELECT * FROM banned_actions ORDER BY banned_at DESC');
  selectBannedAction = db.prepare('SELECT 1 FROM banned_actions WHERE action_type = ?');
}

function safeInsertModule(name: string) {  if (!name || typeof name !== 'string' || name.length > 500) { getLog()(`Invalid module name: ${typeof name}`, 'WARN', 'database'); return; } try { insertModule.run(name, Date.now()); } catch (err: any) { getLogError()('Failed to insert module', err, { moduleName: name.substring(0, 50) }); } }
function safeSelectModule(name: string) {  if (!name || typeof name !== 'string') return null; try { return selectModule.get(name); } catch (err: any) { getLogError()('Failed to select module', err); return null; } }
function safeGetAllModules() {  try { return getAllModules.all().map((r: any) => r.name); } catch (err: any) { getLogError()('Failed to get all modules', err); return []; } }
function safeInsertProgress(action: string, state: string, questionsCompleted = 0) {  if (!action || typeof action !== 'string') return; if (!state || typeof state !== 'string') return; try { insertProgress.run(action.substring(0, 100), state.substring(0, 100), Date.now(), Math.max(0, Math.min(999999, Math.floor(questionsCompleted)))); } catch (err: any) { getLogError()('Failed to insert progress', err, { action, state }); } }
function safeGetRecentProgress(limit = 100) {  const safeLimit = Math.max(1, Math.min(1000, Math.floor(limit))); try { return getRecentProgress.all(safeLimit); } catch (err: any) { getLogError()('Failed to get recent progress', err); return []; } }
function safeInsertTemplate(hash: string, actionType: string, state: string, xPercent: number, yPercent: number, widthPercent: number, heightPercent: number, cropData: Buffer | null) {  if (!hash || typeof hash !== 'string' || hash.length > 64) return; if (!actionType || typeof actionType !== 'string' || actionType.length > 50) return; if (!state || typeof state !== 'string' || state.length > 100) return; const validatePercent = (val: number, name: string) => { if (typeof val !== 'number' || val < 0 || val > 100) { getLog()(`Invalid ${name}: ${val}`, 'WARN', 'database'); return false; } return true; }; if (!validatePercent(xPercent, 'xPercent')) return; if (!validatePercent(yPercent, 'yPercent')) return; if (!validatePercent(widthPercent, 'widthPercent')) return; if (!validatePercent(heightPercent, 'heightPercent')) return; try { insertTemplate.run(hash, actionType, state, xPercent, yPercent, widthPercent, heightPercent, cropData || null, Date.now(), Date.now(), 0); } catch (err: any) { getLogError()('Failed to insert template', err, { hash: hash.substring(0, 10) }); } }

function closeDatabase() { 
  try { db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); getLog()('Database closed successfully', 'INFO', 'database'); } catch (err: any) { getLogError()('Error closing database', err); }
}

function pruneTemplateCache() { 
  try { const cutoff = Date.now() - (30 * 24 * 60 * 60 * 1000); const info = db.prepare("DELETE FROM template_cache WHERE last_used < ?").run(cutoff); if (info.changes > 0) { getLog()(`Pruned ${info.changes} stale template cache entries`, 'INFO', 'database'); const vacuumStart = Date.now(); db.prepare('VACUUM').run(); getLog()(`VACUUM completed in ${Date.now() - vacuumStart}ms`, 'DEBUG', 'database'); } } catch (err: any) { getLogError()('Failed to prune template cache', err); }
}

function vacuumIfNeeded() { 
  try { const pageCount = db.pragma('page_count')[0]?.page_count || 0; const freelistCount = db.pragma('freelist_count')[0]?.freelist_count || 0; if (pageCount > 0 && (freelistCount / pageCount) > 0.1) { getLog()(`Running VACUUM (freelist: ${freelistCount}/${pageCount} pages)`, 'INFO', 'database'); db.prepare('VACUUM').run(); } } catch (err: any) { getLogError()('VACUUM check failed', err); }
}

function getDatabaseStats() { 
  try { const pageCount = db.pragma('page_count')[0]?.page_count || 0; const pageSize = db.pragma('page_size')[0]?.page_size || 4096; const freelistCount = db.pragma('freelist_count')[0]?.freelist_count || 0; return { totalSizeBytes: pageCount * pageSize, freePages: freelistCount, totalPages: pageCount, utilizationPercent: pageCount > 0 ? ((pageCount - freelistCount) / pageCount * 100).toFixed(1) : 0 }; } catch (err: any) { getLogError()('Failed to get database stats', err); return null; }
}

module.exports = {
  get db() { return db; },
  insertModule: safeInsertModule,
  selectModule: safeSelectModule,
  getAllModules: safeGetAllModules,
  insertProgress: safeInsertProgress,
  getRecentProgress: safeGetRecentProgress,
  insertTemplate: safeInsertTemplate,
  get _rawInsertTemplate() { return insertTemplate; },
  get selectTemplate() { return selectTemplate; },
  get listTemplates() { return listTemplates; },
  get updateTemplateHit() { return updateTemplateHit; },
  get upsertProvider() { return upsertProvider; },
  get selectProvider() { return selectProvider; },
  get listProviders() { return listProviders; },
  get upsertCalibration() { return upsertCalibration; },
  get selectCalibration() { return selectCalibration; },
  get upsertLastState() { return upsertLastState; },
  get selectLastState() { return selectLastState; },
  get insertPatch() { return insertPatch; },
  get getRecentPatches() { return getRecentPatches; },
  get updateProviderStats() { return updateProviderStats; },
  get upsertModel() { return upsertModel; },
  get getActiveModel() { return getActiveModel; },
  get getFallbackModel() { return getFallbackModel; },
  get setModelRole() { return setModelRole; },
  closeDatabase,
  pruneTemplateCache,
  vacuumIfNeeded,
  getDatabaseStats,
  checkIntegrity,
  get upsertUiBaseline() { return upsertUiBaseline; },
  get selectUiBaseline() { return selectUiBaseline; },
  get insertBlackbox() { return insertBlackbox; },
  get getBlackbox() { return getBlackbox; },
  get insertSemanticsSnapshot() { return insertSemanticsSnapshot; },
  get insertNetworkLog() { return insertNetworkLog; },
  get getNetworkLogs() { return getNetworkLogs; },
  get upsertPerformanceProfile() { return upsertPerformanceProfile; },
  get selectPerformanceProfile() { return selectPerformanceProfile; },
  get insertGitopsChain() { return insertGitopsChain; },
  get getGitopsChain() { return getGitopsChain; },
  get updateGitopsApplied() { return updateGitopsApplied; },
  get insertFlutterSemantics() { return insertFlutterSemantics; },
  get getFlutterSemantics() { return getFlutterSemantics; },
  get upsertProviderSchema() { return upsertProviderSchema; },
  get selectProviderSchema() { return selectProviderSchema; },
  get insertExplorationMap() { return insertExplorationMap; },
  get getExplorationMaps() { return getExplorationMaps; },
  get upsertRuntimeVersion() { return upsertRuntimeVersion; },
  get selectRuntimeVersion() { return selectRuntimeVersion; },
  // Self-heal statements (getters since they're initialized in initDatabase)
  get insertSelfHealEvent() { return insertSelfHealEvent; },
  get getSelfHealTimeline() { return getSelfHealTimeline; },
  get insertSelectorVersion() { return insertSelectorVersion; },
  get getLatestSelectorVersion() { return getLatestSelectorVersion; },
  get insertPatchCanary() { return insertPatchCanary; },
  get updatePatchCanary() { return updatePatchCanary; },
  get getActiveCanary() { return getActiveCanary; },
  get insertAdversarialResult() { return insertAdversarialResult; },
  get insertDbQuarantine() { return insertDbQuarantine; },
  get getQuarantinedRows() { return getQuarantinedRows; },
  get upsertDiscoveredState() { return upsertDiscoveredState; },
  get getDiscoveredStates() { return getDiscoveredStates; },
  get pruneExpiredStates() { return pruneExpiredStates; },
  get insertDependencyHealth() { return insertDependencyHealth; },
  get getDependencyHealth() { return getDependencyHealth; },
  get insertConfigReconciliation() { return insertConfigReconciliation; },
  get insertBlackboxFull() { return insertBlackboxFull; },
  get getBlackboxFull() { return getBlackboxFull; },
  get insertPatchEmbedding() { return insertPatchEmbedding; },
  get searchPatchEmbeddings() { return searchPatchEmbeddings; },
  get insertHealModelMetric() { return insertHealModelMetric; },
  get getHealModelMetrics() { return getHealModelMetrics; },
  get getOrCreateHealerCircuitState() { return getOrCreateHealerCircuitState; },
  get updateHealerCircuitState() { return updateHealerCircuitState; },
  get getHealerCircuitState() { return getHealerCircuitState; },
  get insertDegradationLog() { return insertDegradationLog; },
  get getDegradationLog() { return getDegradationLog; },
  // Dashboard control
  get insertBannedAction() { return insertBannedAction; },
  get deleteBannedAction() { return deleteBannedAction; },
  get listBannedActions() { return listBannedActions; },
  get selectBannedAction() { return selectBannedAction; },
  // DI support
  _injectDependencies,
  initDatabase,
};
