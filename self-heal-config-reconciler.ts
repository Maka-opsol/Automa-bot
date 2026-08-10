'use strict';
// self-heal-config-reconciler.ts — Reconciles local config with remote overrides.
// Fixes applied:
//   1. reconcileAll() is now async — awaits remote config readiness before reconciling
//   2. start() eliminated duplicate timer — subsystem-runner owns the scheduling
//   3. DB inserts batched using db.transaction() (better-sqlite3 API, not raw SQL)
//   4. _categorizeKey() tightened: MAX_ prefix only for known numeric patterns
//   5. _getLocalConfigValues() uses config snapshot (avoids Proxy overhead)
//   6. _waitForRemoteConfig() reduced from 10s to 5s poll timeout

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const CONFIG = require('./get-config');
function updateConfig(...args: any[]) { return _deps.config?.updateConfig?.(...args) || CONFIG.updateConfig?.(...args); }

// Keys that are security-critical: never override from remote
const SECURITY_CRITICAL_KEYS = new Set([
  'ENCRYPTION_PASSPHRASE',
  'TELEGRAM_BOT_TOKEN',
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'API_KEY',
  'SECRET_KEY',
  'TOKEN',
  'PASSWORD',
  'CREDENTIALS',
  'ZAI_API_KEY',
  'OPENAI_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'NVIDIA_API_KEY',
  'CLOUDFLARE_API_KEY',
  'CEREBRAS_API_KEY',
  'ANTHROPIC_API_KEY',
]);

// Keys that are numeric max limits (lower is more conservative)
const MAX_LIMIT_KEYS = new Set([
  'MAX_QUESTIONS',
  'MAX_RETRIES',
  'MAX_CONSECUTIVE_FAILURES',
  'SELF_HEAL_MAX_ATTEMPTS',
  'MEMORY_RESTART_THRESHOLD_MB',
  'BROWSER_LAUNCH_TIMEOUT_MS',
  'ACTION_TIMEOUT_MS',
  'CAPTCHA_HUMAN_TIMEOUT_MS',
  'MAX_MODULES_PER_SESSION',
  'MAX_EXPLORATION_DEPTH',
  'PROVIDER_TIMEOUT_MS',
  'NAVIGATION_TIMEOUT_MS',
  'DB_SIZE_LIMIT_MB',
  'QUOTA_BUDGET',
  'MAX_MODULES_PER_CYCLE',
]);

// Keys that are numeric min thresholds (higher is more conservative)
const MIN_THRESHOLD_KEYS = new Set([
  'MIN_DELAY_MS',
  'MIN_SCORE_TO_PROCEED',
  'MIN_MODULE_CONFIDENCE',
  'COOLDOWN_MS',
  'RETRY_DELAY_MS',
  'BACKOFF_BASE_MS',
  'STATE_RECOVERY_PROMOTE_AFTER',
  'AUTH_HEALER_MAX_FAILURES',
]);

// Keys that are timing/delay values (higher = more conservative/stable)
const TIMING_KEYS = new Set([
  'CYCLE_DELAY_MS',
  'ACTION_DELAY_MS',
  'QUESTION_DELAY_MS',
  'VIDEO_WAIT_MS',
  'PAGE_LOAD_WAIT_MS',
  'STAGNATION_TIMEOUT_MS',
  'WATCHDOG_TIMEOUT_MS',
  'HEALTH_CHECK_INTERVAL_MS',
  'BROWSER_RESTART_INTERVAL_MS',
  'REFRESH_INTERVAL_MS',
  'PROACTIVE_REFRESH_INTERVAL_MS',
]);

// Boolean feature flag keys (prefer local user settings)
const FEATURE_FLAG_KEYS = new Set([
  'SELF_HEAL_ENABLED',
  'GITOPS_ENABLED',
  'EXPLORATION_ENABLED',
  'UI_DRIFT_DETECTION',
  'BLACKBOX_RECORDING',
  'TELEMETRY_ENABLED',
  'ADAPTIVE_PERFORMANCE',
  'FLUTTER_SEMANTICS_ENABLED',
  'NETWORK_INTERCEPT_ENABLED',
  'LOCAL_VLM_FAILOVER',
  'PROGRESSIVE_DIFFICULTY',
  'ANOMALY_DETECTION',
]);

const ENSURE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS config_reconciliation (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reconciled_at INTEGER NOT NULL,
  key TEXT NOT NULL,
  local_value TEXT,
  remote_value TEXT,
  resolved_value TEXT,
  resolution TEXT,
  reason TEXT
)`;

class ConfigReconciler {
  _lastReconciliation: any;
  _intervalId: any;
  _started: boolean;

  constructor() {
    this._intervalId = null;
    this._lastReconciliation = null;
    this._started = false;
  }

  /**
   * Wait for remote config to be loaded before reconciling.
   * Without this, reconcileAll() ran against an empty remote config
   * at startup, making the entire reconciler useless.
   */
  async _waitForRemoteConfig(): Promise<void> {
    // CONFIG.waitForRemoteConfig() returns a Promise that resolves when
    // applyRemoteOverridesAsync() completes (see config.ts line 971).
    if (typeof CONFIG.waitForRemoteConfig === 'function') {
      try {
        await CONFIG.waitForRemoteConfig();
      } catch (err: any) {
        // Remote config failed to load — reconcile against local only
        log('Remote config not available, reconciling against local config', 'WARN', 'config-reconciler');
      }
    }
    // Also give config-remote-config module a chance to populate
    // Reduced from 10s to 5s — the fetch itself is now 5s max, so
    // waiting 10s on top is redundant.
    const MAX_WAIT_MS = 5000;
    const POLL_INTERVAL = 500;
    const start = Date.now();
    while (Date.now() - start < MAX_WAIT_MS) {
      try {
        const { getRemoteOverrides } = require('./config-remote-config');
        const overrides = getRemoteOverrides();
        if (overrides && Object.keys(overrides).length > 0) return;
        // Remote overrides are empty — could be legit (no overrides) or not loaded yet.
        // Check if remote config module has loaded at all.
        const remoteConfig = require('./config-remote-config');
        // @ts-expect-error — remoteConfig is a module export object
        if (remoteConfig.remoteConfig !== null && remoteConfig.remoteConfig !== undefined) return;
      } catch {
        // Module not available — that's fine
      }
      await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL));
    }
    log('Timed out waiting for remote config, proceeding with local', 'DEBUG', 'config-reconciler');
  }

  /**
   * Detect drift between local config, env vars, and remote config.
   * @returns {Promise<object>} { contradictions: Array<{key, localValue, remoteValue, category}> }
   */
  async detectDrift(): Promise<{ contradictions: any[]; timestamp: number }> { 
    const contradictions = [];

    try {
      const localConfig = this._getLocalConfigValues();

      let remoteOverrides: Record<string, any> = {};
      try {
        const { getRemoteOverrides } = require('./config-remote-config');
        remoteOverrides = getRemoteOverrides() || {};
      } catch (err: any) {
        log('Remote config not available for drift detection', 'DEBUG', 'config-reconciler');
      }

      for (const [key, remoteValue] of Object.entries(remoteOverrides)) {
// @ts-expect-error
        const localValue = localConfig[key];
        if (localValue === undefined) continue;

        const normalizedLocal = this._normalizeValue(localValue);
        const normalizedRemote = this._normalizeValue(remoteValue);

        if (normalizedLocal !== normalizedRemote) {
          contradictions.push({
            key,
            localValue,
            remoteValue,
            normalizedLocal,
            normalizedRemote,
            category: this._categorizeKey(key),
          });
        }
      }

      if (contradictions.length > 0) {
        log(`Config drift detected: ${contradictions.length} contradiction(s)`, 'INFO', 'config-reconciler');
      } else {
        log('No config drift detected', 'DEBUG', 'config-reconciler');
      }
    } catch (err: any) {
      logError('Config drift detection failed', err);
    }

    return { contradictions, timestamp: Date.now() };
  }

  /**
   * Reconcile a single key with proper precedence rules.
   */
  reconcileKey(key: string, localValue: any, remoteValue: any): { resolved: any; resolution: string; reason: string } { 
    const category = this._categorizeKey(key);
    let resolved: any;
    let resolution: string;
    let reason: string;

    switch (category) {
      case 'security':
        resolved = localValue;
        resolution = 'local';
        reason = 'Security-critical key: local value preserved, remote value rejected';
        break;

      case 'max_limit': {
        const localNum = parseFloat(localValue);
        const remoteNum = parseFloat(remoteValue);
        if (isNaN(localNum) || isNaN(remoteNum)) {
          resolved = localValue;
          resolution = 'local';
          reason = 'Non-numeric max limit values: keeping local';
          break;
        }
        if (localNum <= remoteNum) {
          resolved = localValue;
          resolution = 'local';
          reason = `Max limit: local (${localNum}) is more conservative than remote (${remoteNum})`;
        } else {
          resolved = remoteValue;
          resolution = 'conservative';
          reason = `Max limit: remote (${remoteNum}) is more conservative than local (${localNum})`;
        }
        break;
      }

      case 'min_threshold': {
        const localNum = parseFloat(localValue);
        const remoteNum = parseFloat(remoteValue);
        if (isNaN(localNum) || isNaN(remoteNum)) {
          resolved = localValue;
          resolution = 'local';
          reason = 'Non-numeric min threshold values: keeping local';
          break;
        }
        if (localNum >= remoteNum) {
          resolved = localValue;
          resolution = 'local';
          reason = `Min threshold: local (${localNum}) is more conservative than remote (${remoteNum})`;
        } else {
          resolved = remoteValue;
          resolution = 'conservative';
          reason = `Min threshold: remote (${remoteNum}) is more conservative than local (${localNum})`;
        }
        break;
      }

      case 'feature_flag':
        resolved = localValue;
        resolution = 'local';
        reason = 'Feature flag: local user preference preserved';
        break;

      case 'timing': {
        const localNum = parseFloat(localValue);
        const remoteNum = parseFloat(remoteValue);
        if (isNaN(localNum) || isNaN(remoteNum)) {
          resolved = localValue;
          resolution = 'local';
          reason = 'Non-numeric timing values: keeping local';
          break;
        }
        if (localNum >= remoteNum) {
          resolved = localValue;
          resolution = 'local';
          reason = `Timing: local (${localNum}ms) is more conservative than remote (${remoteNum}ms)`;
        } else {
          resolved = remoteValue;
          resolution = 'conservative';
          reason = `Timing: remote (${remoteNum}ms) is more conservative than local (${localNum}ms)`;
        }
        break;
      }

      default:
        resolved = localValue;
        resolution = 'local';
        reason = 'Unclassified key: local value preserved as default';
        break;
    }

    return { resolved, resolution, reason };
  }

  /**
   * Run full reconciliation: detect drift and reconcile all contradictions.
   * Applies resolved values to CONFIG in memory.
   *
   * FIX: Uses db.transaction() (better-sqlite3 API) instead of raw
   * `db.exec('BEGIN TRANSACTION')` which fails with better-sqlite3.
   */
  async reconcileAll(): Promise<{ timestamp: number; reconciliations: any[]; appliedCount: number }> { 
    await this._waitForRemoteConfig();

    const drift = await this.detectDrift();
    const reconciliations: any[] = [];
    let appliedCount = 0;

    try {
      const db = getDb();
      if (db) {
        try { db.exec(ENSURE_TABLE_SQL); } catch (e: any) { /* table may already exist */ }
      }

      // Use better-sqlite3's db.transaction() API instead of raw BEGIN/COMMIT.
      // Raw `db.exec('BEGIN TRANSACTION')` fails in better-sqlite3 because it
      // manages transactions internally via its C binding.
      const insertReconciliation = db
        ? db.transaction((recons: any[]) => {
            const stmt = db.prepare(`
              INSERT INTO config_reconciliation (reconciled_at, key, local_value, remote_value, resolved_value, resolution, reason)
              VALUES(?, ?, ?, ?, ?, ?, ?)
            `);
            for (const r of recons) {
              stmt.run(r.reconciled_at, r.key, r.local_value, r.remote_value, r.resolved_value, r.resolution, r.reason);
            }
          })
        : null;

      try {
        const dbEntries: any[] = [];

        for (const contradiction of drift.contradictions) {
          const result = this.reconcileKey(
            contradiction.key,
            contradiction.localValue,
            contradiction.remoteValue
          );

          reconciliations.push({
            key: contradiction.key,
            ...contradiction,
            ...result,
          });

          // Collect for DB insert
          dbEntries.push({
            reconciled_at: Date.now(),
            key: contradiction.key,
            local_value: JSON.stringify(contradiction.localValue),
            remote_value: JSON.stringify(contradiction.remoteValue),
            resolved_value: JSON.stringify(result.resolved),
            resolution: result.resolution,
            reason: result.reason,
          });

          // Apply resolved value to CONFIG in memory via updateConfig
          if (result.resolution === 'conservative' || result.resolution === 'remote') {
            try {
              const parsed = this._parseToType(result.resolved, contradiction.localValue);
              updateConfig(contradiction.key, parsed);
              appliedCount++;
              log(`Applied reconciliation for ${contradiction.key}: ${result.resolution} (${result.reason})`, 'INFO', 'config-reconciler');
            } catch (applyErr: any) {
              logError(`Failed to apply reconciliation for ${contradiction.key}`, applyErr);
            }
          } else {
            log(`Kept local value for ${contradiction.key}: ${result.reason}`, 'DEBUG', 'config-reconciler');
          }
        }

        // Batch-insert all entries in a single transaction
        if (insertReconciliation && dbEntries.length > 0) {
          try {
            insertReconciliation(dbEntries);
          } catch (dbErr: any) {
            logError('Failed to log config reconciliation entries', dbErr);
          }
        }
      } catch (err: any) {
        logError('Config reconciliation iteration failed', err);
      }

      if (appliedCount > 0) {
        log(`Config reconciliation: ${appliedCount}/${drift.contradictions.length} value(s) adjusted`, 'INFO', 'config-reconciler');
        logAudit(`Config reconciliation: ${appliedCount} value(s) adjusted from remote`, 'config-reconciler');
      }
    } catch (err: any) {
      logError('Config reconciliation failed', err);
    }

    this._lastReconciliation = {
      timestamp: Date.now(),
      reconciliations,
      appliedCount,
    };

    return this._lastReconciliation;
  }

  /**
   * Categorize a config key for reconciliation rules.
   */
  _categorizeKey(key: string): string { 
    const upperKey = key.toUpperCase();

    for (const secKey of SECURITY_CRITICAL_KEYS) {
      if (upperKey === secKey || upperKey.endsWith('_' + secKey) || upperKey.startsWith(secKey + '_')) {
        return 'security';
      }
    }
    if (/^(.*_)?(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(_.*)?$/.test(upperKey)) {
      return 'security';
    }

    if (MAX_LIMIT_KEYS.has(upperKey) || /_MAX_/.test(upperKey)) {
      return 'max_limit';
    }

    if (MIN_THRESHOLD_KEYS.has(upperKey) || (upperKey.includes('MIN_') && !upperKey.includes('MINUTE'))) {
      return 'min_threshold';
    }

    if (FEATURE_FLAG_KEYS.has(upperKey)) {
      return 'feature_flag';
    }
    if (upperKey.includes('ENABLED') || upperKey.includes('DISABLED') || upperKey.includes('USE_')) {
      return 'feature_flag';
    }

    if (TIMING_KEYS.has(upperKey)) {
      return 'timing';
    }
    if (/_(DELAY|WAIT|TIMEOUT|INTERVAL)_MS$/.test(upperKey) || upperKey.endsWith('_MS')) {
      return 'timing';
    }

    return 'unknown';
  }

  /**
   * Get the current local config values for comparison.
   */
  _getLocalConfigValues(): Record<string, any> { 
    const values: Record<string, any> = {};
    try {
      const source: Record<string, any> = typeof CONFIG.getConfigSnapshot === 'function'
        ? CONFIG.getConfigSnapshot()
        : CONFIG;

      for (const [key, value] of Object.entries(source)) {
        if (typeof value === 'function') continue;
        if (typeof value === 'object' && value !== null && !(value instanceof Array)) {
          if (value.constructor && value.constructor !== Object) continue;
        }
        values[key] = value;
      }
    } catch (err: any) {
      logError('Failed to read local config values', err);
    }
    return values;
  }

  _normalizeValue(value: any): string { 
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value).trim().toLowerCase();
  }

  _parseToType(resolved: any, reference: any): any { 
    if (reference === undefined || reference === null) return resolved;
    if (typeof reference === 'number') return parseFloat(resolved);
    if (typeof reference === 'boolean') return resolved === 'true' || resolved === true;
    if (typeof reference === 'object') {
      try { return JSON.parse(resolved); } catch (e: any) { return resolved; }
    }
    return resolved;
  }

  getLastReconciliation(): any { 
    return this._lastReconciliation;
  }

  /**
   * Start periodic config reconciliation.
   */
  start(intervalMs?: number): void { 
    const isFreePlan = !process.env.RENDER_SERVICE_TYPE || process.env.RENDER_SERVICE_TYPE === 'free';
    const defaultInterval = isFreePlan ? 8 * 60 * 60 * 1000 : 6 * 60 * 60 * 1000;
    const interval = intervalMs || defaultInterval;

    if (this._intervalId) {
      log('Config reconciler already running', 'WARN', 'config-reconciler');
      return;
    }

    this._started = true;
    log(`Config reconciler started (interval: ${Math.round(interval / 60000)}min, freePlan: ${isFreePlan})`, 'INFO', 'config-reconciler');

    this._intervalId = setInterval(() => {
      this.reconcileAll().catch((err: any) => {
        logError('Periodic config reconciliation failed', err);
      });
    }, interval);

    if (this._intervalId.unref) this._intervalId.unref();
  }

  stop(): void { 
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      this._started = false;
      log('Config reconciler stopped', 'INFO', 'config-reconciler');
    }
  }
}

// Singleton
const configReconciler = new ConfigReconciler();
module.exports = { ConfigReconciler, configReconciler, _injectDependencies };
