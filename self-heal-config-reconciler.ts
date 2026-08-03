'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const CONFIG = require('./get-config');
function updateConfig(...args: any[]) { return _deps.config?.updateConfig?.(...args); }

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

  constructor() {
    this._intervalId = null;
    this._lastReconciliation = null;
  }

  /**
   * Detect drift between local config, env vars, and remote config.
   * @returns {object} { contradictions: Array<{key, localValue, remoteValue, category}> }
   */
  detectDrift() { 
    const contradictions = [];

    try {
      // Load local config values
      const localConfig = this._getLocalConfigValues();

      // Load remote config overrides
      let remoteOverrides = {};
      try {
        const { getRemoteOverrides } = require('./config-remote-config');
        remoteOverrides = getRemoteOverrides() || {};
      } catch (err: any) {
        log('Remote config not available for drift detection', 'DEBUG', 'config-reconciler');
      }

      // Compare each remote override against local
      for (const [key, remoteValue] of Object.entries(remoteOverrides)) {
// @ts-expect-error
        const localValue = localConfig[key];
        if (localValue === undefined) continue; // Remote-only key, no conflict

        // Normalize for comparison
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
        log(`Config drift detected: ${contradictions.length} contradictions`, 'INFO', 'config-reconciler');
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
   *
   * Precedence:
   * 1. Security-critical: never override from remote
   * 2. Numeric max limits: pick the more conservative (lower)
   * 3. Numeric min thresholds: pick the more conservative (higher)
   * 4. Boolean feature flags: prefer local
   * 5. Timing/delay: pick higher (more conservative/stable)
   * 6. Default: prefer local
   *
   * @param {string} key - Config key
   * @param {*} localValue - Local config value
   * @param {*} remoteValue - Remote config value
   * @returns {object} { resolved, resolution, reason }
   */
  reconcileKey(key: any, localValue: any, remoteValue: any) { 
    const category = this._categorizeKey(key);
    let resolved;
    let resolution;
    let reason;

    switch (category) {
      case 'security':
        // Never override security-critical keys from remote
        resolved = localValue;
        resolution = 'local';
        reason = 'Security-critical key: local value preserved, remote value rejected';
        break;

      case 'max_limit': {
        // Lower is more conservative for max limits
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
        // Higher is more conservative for min thresholds
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
        // Prefer local: user explicitly set this
        resolved = localValue;
        resolution = 'local';
        reason = 'Feature flag: local user preference preserved';
        break;

      case 'timing': {
        // Higher delay = more conservative/stable
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
        // Unknown key type: prefer local to avoid breaking changes
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
   * Does NOT persist to env vars (that would be circular).
   *
   * @returns {object} { reconciliations: Array, appliedCount: number }
   */
  reconcileAll() { 
    const drift = this.detectDrift();
    const reconciliations = [];
    let appliedCount = 0;

    try {
      getDb()?.exec(ENSURE_TABLE_SQL);

      for (const contradiction of drift.contradictions) {
        const result = this.reconcileKey(
          contradiction.key,
          contradiction.localValue,
          contradiction.remoteValue
        );

        reconciliations.push({
// @ts-expect-error
          key: contradiction.key,
          ...contradiction,
          ...result,
        });

        // Log to database
        try {
          getDb()?.prepare(`
            INSERT INTO config_reconciliation (reconciled_at, key, local_value, remote_value, resolved_value, resolution, reason)
            VALUES(?, ?, ?, ?, ?, ?, ?)
          `).run(
            Date.now(),
            contradiction.key,
            JSON.stringify(contradiction.localValue),
            JSON.stringify(contradiction.remoteValue),
            JSON.stringify(result.resolved),
            result.resolution,
            result.reason
          );
        } catch (dbErr: any) {
          logError('Failed to log config reconciliation', dbErr);
        }

        // Apply resolved value to CONFIG in memory via updateConfig (validates + audits)
        if (result.resolution === 'conservative' || result.resolution === 'remote') {
          try {
            // Parse the resolved value to its original type
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

      if (appliedCount > 0) {
        log(`Config reconciliation: ${appliedCount}/${drift.contradictions.length} values adjusted`, 'INFO', 'config-reconciler');
        logAudit(`Config reconciliation: ${appliedCount} values adjusted from remote`, 'config-reconciler');
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
  _categorizeKey(key: any) { 
    const upperKey = key.toUpperCase();

    // Check security-critical
    for (const secKey of SECURITY_CRITICAL_KEYS) {
      if (upperKey === secKey || upperKey.endsWith('_' + secKey) || upperKey.startsWith(secKey + '_')) {
        return 'security';
      }
    }
    // More precise security check: key contains the security pattern
    if (/^(.*_)?(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)(_.*)?$/.test(upperKey)) {
      return 'security';
    }

    // Check max limits
    for (const maxKey of MAX_LIMIT_KEYS) {
      if (upperKey.startsWith('MAX_') || upperKey.includes('_MAX_') || upperKey.includes(maxKey)) {
        return 'max_limit';
      }
    }

    // Check min thresholds
    for (const minKey of MIN_THRESHOLD_KEYS) {
      if (upperKey.includes(minKey) || (upperKey.includes('MIN_') && !upperKey.includes('MINUTE'))) {
        return 'min_threshold';
      }
    }

    // Check feature flags
    for (const flagKey of FEATURE_FLAG_KEYS) {
      if (upperKey.includes(flagKey)) {
        return 'feature_flag';
      }
    }
    if (upperKey.includes('ENABLED') || upperKey.includes('DISABLED') || upperKey.includes('USE_')) {
      return 'feature_flag';
    }

    // Check timing/delay
    for (const timingKey of TIMING_KEYS) {
      if (upperKey.includes(timingKey)) {
        return 'timing';
      }
    }
    if (upperKey.includes('DELAY_MS') || upperKey.includes('WAIT_MS') ||
        upperKey.includes('TIMEOUT_MS') || upperKey.includes('INTERVAL_MS') ||
        upperKey.endsWith('_MS')) {
      return 'timing';
    }

    return 'unknown';
  }

  /**
   * Get the current local config values for comparison.
   * Returns a flat object of CONFIG properties.
   */
  _getLocalConfigValues() { 
    const values = {};
    try {
      for (const [key, value] of Object.entries(CONFIG)) {
        // Skip functions and internal symbols
        if (typeof value === 'function') continue;
        // Skip non-plain objects (Maps, Sets, etc.) — arrays are fine
        if (typeof value === 'object' && value !== null && !(value instanceof Array)) {
          if (value.constructor && value.constructor !== Object) continue;
        }
// @ts-expect-error
        values[key] = value;
      }
    } catch (err: any) {
      logError('Failed to read local config values', err);
    }
    return values;
  }

  /**
   * Normalize a value for comparison (stringify).
   */
  _normalizeValue(value: any) { 
    if (value === null || value === undefined) return '';
    if (typeof value === 'boolean') return value ? 'true' : 'false';
    if (typeof value === 'number') return String(value);
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value).trim().toLowerCase();
  }

  /**
   * Parse a resolved value back to the type matching the reference.
   */
  _parseToType(resolved: any, reference: any) { 
    if (reference === undefined || reference === null) return resolved;
    if (typeof reference === 'number') return parseFloat(resolved);
    if (typeof reference === 'boolean') return resolved === 'true' || resolved === true;
    if (typeof reference === 'object') {
      try { return JSON.parse(resolved); } catch (e: any) { return resolved; }
    }
    return resolved;
  }

  /**
   * Get the last reconciliation result.
   */
  getLastReconciliation() { 
    return this._lastReconciliation;
  }

  /**
   * Start periodic config reconciliation.
   * @param {number} intervalMs - Check interval (default 6 hours)
   */
  start(intervalMs: any) { 
    const interval = intervalMs || 6 * 60 * 60 * 1000;
    if (this._intervalId) {
      log('Config reconciler already running', 'WARN', 'config-reconciler');
      return;
    }

    log(`Config reconciler started (interval: ${Math.round(interval / 60000)}min)`, 'INFO', 'config-reconciler');

    // Initial reconciliation after remote config has loaded
    const initTimer = setTimeout(() => {
      try { this.reconcileAll(); } catch (err: any) { logError('Initial config reconciliation failed', err); }
    }, 120000); // 2 minutes after startup to let remote config load
    if (initTimer && initTimer.unref) initTimer.unref();

    this._intervalId = setInterval(() => {
      try { this.reconcileAll(); } catch (err: any) { logError('Periodic config reconciliation failed', err); }
    }, interval);

    if (this._intervalId.unref) this._intervalId.unref();
  }

  /**
   * Stop the periodic scheduler.
   */
  stop() { 
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      log('Config reconciler stopped', 'INFO', 'config-reconciler');
    }
  }
}

// Singleton
const configReconciler = new ConfigReconciler();
module.exports = { ConfigReconciler, configReconciler , _injectDependencies };