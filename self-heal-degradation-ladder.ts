'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }
function updateConfig(...args: any[]) { return _deps.config?.updateConfig?.(...args); }

const CONFIG = require('./get-config');

const MODES = ['FULL', 'DEGRADED', 'SURVIVAL', 'HIBERNATION'];

const MODE_CONFIG_OVERRIDES = {
  FULL: {
    ENABLE_EXPERIMENTS: true,
    ENABLE_EXPLORATION: true,
    PROVIDER_PREFERENCE: 'all',
    SCREENSHOT_QUALITY: 50,
    ENABLE_NETWORK_INTERCEPT: true,
    ENABLE_VISION_TRIBUNAL: true,
    ENABLE_FLUTTER_SEMANTICS: false,
    PAUSE_CYCLES: false
  },
  DEGRADED: {
    ENABLE_EXPERIMENTS: false,
    ENABLE_EXPLORATION: false,
    PROVIDER_PREFERENCE: 'cheap',
    SCREENSHOT_QUALITY: 20,
    ENABLE_NETWORK_INTERCEPT: true,
    ENABLE_VISION_TRIBUNAL: true,
    ENABLE_FLUTTER_SEMANTICS: false,
    PAUSE_CYCLES: false
  },
  SURVIVAL: {
    ENABLE_EXPERIMENTS: false,
    ENABLE_EXPLORATION: false,
    PROVIDER_PREFERENCE: 'local-only',
    SCREENSHOT_QUALITY: 10,
    ENABLE_NETWORK_INTERCEPT: false,
    ENABLE_VISION_TRIBUNAL: false,
    ENABLE_FLUTTER_SEMANTICS: true,
    PAUSE_CYCLES: false
  },
  HIBERNATION: {
    ENABLE_EXPERIMENTS: false,
    ENABLE_EXPLORATION: false,
    PROVIDER_PREFERENCE: 'none',
    SCREENSHOT_QUALITY: 5,
    ENABLE_NETWORK_INTERCEPT: false,
    ENABLE_VISION_TRIBUNAL: false,
    ENABLE_FLUTTER_SEMANTICS: false,
    PAUSE_CYCLES: true
  }
};

class DegradationLadder {
  _currentMode: any;
  _onModeChange: any;
  _originalConfig: any;
  _evalTimer: any;
  _recoveryTimer: any;

  constructor() {
    this._currentMode = null;
    this._originalConfig = {};
    this._evalTimer = null;
    this._recoveryTimer = null;
    this._onModeChange = null;
    this._ensureTables();
    this._loadCurrentMode();
  }

  _ensureTables() { 
    try {
      getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS degradation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_mode TEXT,
          to_mode TEXT,
          reason TEXT,
          timestamp INTEGER
        )
      `);
      getDb()?.exec(`
        CREATE INDEX IF NOT EXISTS idx_degradation_log_time
        ON degradation_log(timestamp)
      `);
    } catch (err: any) {
      logError('Failed to create degradation_log table', err);
    }
  }

  _loadCurrentMode() { 
    try {
      const row = getDb()?.prepare("SELECT value FROM calibration WHERE key = 'degradation_mode'").get();
      if (row && row.value && MODES.includes(row.value)) {
        this._currentMode = row.value;
      } else {
        this._currentMode = 'FULL';
      }
      log(`Degradation ladder initialized at mode: ${this._currentMode}`, 'INFO', 'degradation-ladder');
    } catch (err: any) {
      logError('Failed to load current degradation mode', err);
      this._currentMode = 'FULL';
    }
  }

  /**
   * Get the current operational mode.
   */
  getCurrentMode() { 
    return this._currentMode;
  }

  /**
   * Get index of a mode in the MODES array for comparison.
   */
  _modeIndex(mode: any) { 
    const idx = MODES.indexOf(mode);
    return idx >= 0 ? idx : 0;
  }

  /**
   * Set a new degradation mode with validation.
   * Can only step down or up one level at a time, unless force is true.
   */
  setMode(newMode: any, reason: any, force = false) { 
    try {
      if (!MODES.includes(newMode)) {
        log(`Invalid degradation mode: ${newMode}`, 'ERROR', 'degradation-ladder');
        return { success: false, error: `Invalid mode: ${newMode}` };
      }

      const currentIdx = this._modeIndex(this._currentMode);
      const newIdx = this._modeIndex(newMode);
      const diff = Math.abs(newIdx - currentIdx);

      if (!force && diff > 1) {
        log(`Mode transition rejected: ${this._currentMode} -> ${newMode} (more than one level, use force)`, 'WARN', 'degradation-ladder');
        return { success: false, error: 'Can only transition one level at a time' };
      }

      const previousMode = this._currentMode;
      this._currentMode = newMode;

      // Persist to calibration
      getDb()?.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
        .run('degradation_mode', newMode, Date.now());

      // Log transition
      getDb()?.prepare('INSERT INTO degradation_log (from_mode, to_mode, reason, timestamp) VALUES (?, ?, ?, ?)')
        .run(previousMode, newMode, reason, Date.now());

      // Apply config overrides in memory
      this.applyModeConfig(newMode);

      // Alert on mode change (except initial load)
      if (previousMode !== newMode) {
        const isDowngrade = newIdx > currentIdx;
        const alertLevel = newMode === 'HIBERNATION' ? 1 : newMode === 'SURVIVAL' ? 2 : 3;
        try { getSendAlert()(`Degradation mode changed: ${previousMode} -> ${newMode}. Reason: ${reason}`, alertLevel); } catch (e: any) {}
        log(`DEGRADATION: ${previousMode} -> ${newMode} (reason: ${reason})`, isDowngrade ? 'WARN' : 'INFO', 'degradation-ladder');

        // Notify callback
        if (this._onModeChange) {
          try {
            this._onModeChange(previousMode, newMode, reason);
          } catch (cbErr: any) {
            logError('Error in mode change callback', cbErr);
          }
        }
      }

      return { previousMode, newMode, reason };
    } catch (err: any) {
      logError('Error setting degradation mode', err);
      return { success: false, error: err.message };
    }
  }

  /**
   * Evaluate whether the system should degrade one level.
   */
  evaluateShouldDegrade() { 
    try {
      const currentIdx = this._modeIndex(this._currentMode);

      // Already at bottom, cannot degrade further
      if (currentIdx >= MODES.length - 1) {
        return { shouldDegrade: false, targetMode: null, reason: 'Already at lowest mode' };
      }

      const targetMode = MODES[currentIdx + 1];
      let reason = null;

      switch (this._currentMode) {
        case 'FULL': {
          // Check: provider quota < 20%
          const lowQuota = this._checkLowProviderQuota(20);
          if (lowQuota) {
            reason = `Provider quota critically low: ${lowQuota}`;
          }

          // Check: memory > 70% threshold
          const memHigh = this._checkMemoryThreshold(0.7);
          if (!reason && memHigh) {
            reason = `Memory usage high: ${memHigh}`;
          }

          // Check: > 2 circuit breakers open
          const openCBs = this._countOpenCircuitBreakers();
          if (!reason && openCBs > 2) {
            reason = `${openCBs} circuit breakers open (threshold: 2)`;
          }

          break;
        }

        case 'DEGRADED': {
          // Check: no cloud providers available
          const noCloud = this._checkNoCloudProviders();
          if (noCloud) {
            reason = 'No cloud providers available';
          }

          // Check: memory > 85%
          const memCritical = this._checkMemoryThreshold(0.85);
          if (!reason && memCritical) {
            reason = `Memory usage critical: ${memCritical}`;
          }

          break;
        }

        case 'SURVIVAL': {
          // Check: browser won't launch
          const browserDead = this._checkBrowserDead();
          if (browserDead) {
            reason = 'Browser will not launch';
          }

          // Check: database corrupted
          const dbCorrupt = this._checkDatabaseCorrupted();
          if (!reason && dbCorrupt) {
            reason = 'Database may be corrupted';
          }

          // Check: > 5 circuit breakers open
          const openCBs = this._countOpenCircuitBreakers();
          if (!reason && openCBs > 5) {
            reason = `${openCBs} circuit breakers open (critical threshold: 5)`;
          }

          break;
        }

        default:
          return { shouldDegrade: false, targetMode: null, reason: 'No evaluation for current mode' };
      }

      if (reason) {
        return { shouldDegrade: true, targetMode, reason };
      }

      return { shouldDegrade: false, targetMode, reason: null };
    } catch (err: any) {
      logError('Error evaluating degradation', err);
      return { shouldDegrade: false, targetMode: null, reason: 'Evaluation error' };
    }
  }

  /**
   * Evaluate whether the system should recover one level.
   */
  evaluateShouldRecover() { 
    try {
      const currentIdx = this._modeIndex(this._currentMode);

      // Already at top, cannot recover further
      if (currentIdx <= 0) {
        return { shouldRecover: false, targetMode: null, reason: 'Already at highest mode' };
      }

      const targetMode = MODES[currentIdx - 1];
      let reason = null;

      switch (this._currentMode) {
        case 'HIBERNATION': {
          // Recover to SURVIVAL: database healthy AND browser launches
          const dbOk = !this._checkDatabaseCorrupted();
          const browserOk = !this._checkBrowserDead();

          if (dbOk && browserOk) {
            reason = 'Database healthy and browser launching';
          }

          break;
        }

        case 'SURVIVAL': {
          // Recover to DEGRADED: at least one cloud provider available
          const hasCloud = !this._checkNoCloudProviders();

          if (hasCloud) {
            reason = 'Cloud provider available';
          }

          break;
        }

        case 'DEGRADED': {
          // Recover to FULL: all providers healthy AND memory < 60% AND no circuit breakers open
          const memOk = !this._checkMemoryThreshold(0.6);
          const noOpenCBs = this._countOpenCircuitBreakers() === 0;
          const quotaOk = !this._checkLowProviderQuota(30);

          if (memOk && noOpenCBs && quotaOk) {
            reason = 'All conditions healthy: memory OK, no open circuit breakers, provider quota OK';
          }

          break;
        }

        default:
          return { shouldRecover: false, targetMode: null, reason: 'No evaluation for current mode' };
      }

      if (reason) {
        return { shouldRecover: true, targetMode, reason };
      }

      return { shouldRecover: false, targetMode, reason: null };
    } catch (err: any) {
      logError('Error evaluating recovery', err);
      return { shouldRecover: false, targetMode: null, reason: 'Evaluation error' };
    }
  }

  /**
   * Get effective config overrides for a given mode.
   */
  getModeConfig(mode: any) { 
// @ts-expect-error
    return MODE_CONFIG_OVERRIDES[mode] || MODE_CONFIG_OVERRIDES.FULL;
  }

  /**
   * Apply mode config overrides to CONFIG in memory.
   * Does NOT persist (mode is persisted, config overrides are derived).
   */
  applyModeConfig(mode: any) { 
    try {
      const overrides = this.getModeConfig(mode);

      // Save original config values on first call
      if (Object.keys(this._originalConfig).length === 0) {
        this._originalConfig = {
          ENABLE_EXPERIMENTS: CONFIG.ENABLE_EXPERIMENTS,
          ENABLE_EXPLORATION: CONFIG.ENABLE_EXPLORATION,
          SCREENSHOT_QUALITY: CONFIG.SCREENSHOT_QUALITY,
          ENABLE_NETWORK_INTERCEPT: CONFIG.ENABLE_NETWORK_INTERCEPT,
        };
      }

      // Apply overrides through controlled mutation
      for (const [key, value] of Object.entries(overrides)) {
        if (key in CONFIG) {
          try { updateConfig(key, value); } catch (e: any) { /* already logged by updateConfig */ }
        }
      }

      log(`Applied ${mode} mode config overrides (${Object.keys(overrides).length} keys)`, 'INFO', 'degradation-ladder');
    } catch (err: any) {
      logError('Error applying mode config', err);
    }
  }

  /**
   * Restore original config values.
   */
  restoreOriginalConfig() { 
    try {
      for (const [key, value] of Object.entries(this._originalConfig)) {
        if (value !== undefined) {
          try { updateConfig(key, value); } catch (e: any) { /* already logged by updateConfig */ }
        }
      }
      log('Restored original config values', 'INFO', 'degradation-ladder');
    } catch (err: any) {
      logError('Error restoring original config', err);
    }
  }

  // --- Health check helpers ---

  _checkLowProviderQuota(thresholdPercent: any) { 
    try {
      const rows = getDb()?.prepare('SELECT provider, limit_val AS budget, spent FROM provider_quotas').all();
      for (const row of rows) {
        if (row.budget && row.budget > 0 && typeof row.spent === 'number') {
          const remaining = ((row.budget - row.spent) / row.budget) * 100;
          if (remaining < thresholdPercent) {
            return `${row.provider}: ${remaining.toFixed(1)}% remaining`;
          }
        }
      }
      return null;
    } catch (err: any) {
      return null; // Table may not exist
    }
  }

  _checkMemoryThreshold(ratio: any) { 
    try {
      const used = process.memoryUsage().heapUsed;
      const total = process.memoryUsage().heapTotal;
      if (total === 0) return null;
      const usageRatio = used / total;
      if (usageRatio > ratio) {
        return `${(usageRatio * 100).toFixed(1)}% (${Math.round(used / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`;
      }
      return null;
    } catch (err: any) {
      return null;
    }
  }

  _countOpenCircuitBreakers() { 
    let count = 0;
    // Count from self-heal circuit breaker
    try {
      const { healerCircuitBreaker } = require('./self-heal-circuit-breaker');
      const state = healerCircuitBreaker.getState();
      if (state.state === 'OPEN') count++;
    } catch (_e: any) { /* non-critical, suppressed */ }
    // Count from subsystem mesh
    try {
      const { subsystemMesh } = require('./monitoring-subsystem-circuit-breakers');
      const status = subsystemMesh.getMeshStatus();
      for (const s of Object.values(status)) {
        if ((s as any).state === 'OPEN') count++;
      }
    } catch (_e: any) { /* non-critical, suppressed */ }
    return count;
  }

  _checkNoCloudProviders() { 
    try {
      const rows = getDb()?.prepare("SELECT is_working FROM model_registry WHERE role = 'active'").all();
      const working = rows.filter((r: any) => r.is_working === 1);
      return working.length === 0;
    } catch (err: any) {
      return false;
    }
  }

  _checkBrowserDead() { 
    try {
      // Quick check: try to see if browser module can report status
      const { browserManager } = require('./browser');
      if (browserManager && browserManager._browser && !browserManager._browser.closed) {
        return false;
      }
      // Browser not connected; report as dead
      return true;
    } catch (err: any) {
      // If we can't even load the browser module, the browser IS dead
      return true;
    }
  }

  _checkDatabaseCorrupted() { 
    try {
      const result = getDb()?.prepare('PRAGMA integrity_check').get();
      return result && result.integrity_check !== 'ok';
    } catch (err: any) {
      return true; // If we can't check, assume corrupted
    }
  }

  /**
   * Set callback for mode change events.
   */
  onModeChange(callback: any) { 
    this._onModeChange = callback;
  }

  /**
   * Start periodic evaluation.
   * @param {number} intervalMs - Evaluation interval (default 60s). Recovery check runs every 5 min.
   */
  start(intervalMs = 60000) { 
    try {
      let recoveryCounter = 0;
      const RECOVERY_CHECK_INTERVAL = Math.floor((5 * 60 * 1000) / intervalMs); // Check recovery every 5 min

      this._evalTimer = setInterval(async () => {
        try {
          // Always check for degradation
          const degradEval = this.evaluateShouldDegrade();
          if (degradEval.shouldDegrade) {
            log(`Auto-degrading: ${this._currentMode} -> ${degradEval.targetMode} (${degradEval.reason})`, 'WARN', 'degradation-ladder');
            this.setMode(degradEval.targetMode, degradEval.reason);
          }

          // Check recovery less frequently
          recoveryCounter++;
          if (recoveryCounter >= RECOVERY_CHECK_INTERVAL) {
            recoveryCounter = 0;
            const recoveryEval = this.evaluateShouldRecover();
            if (recoveryEval.shouldRecover) {
              log(`Auto-recovering: ${this._currentMode} -> ${recoveryEval.targetMode} (${recoveryEval.reason})`, 'INFO', 'degradation-ladder');
              this.setMode(recoveryEval.targetMode, recoveryEval.reason);
            }
          }
        } catch (err: any) {
          logError('Error in degradation evaluation cycle', err);
        }
      }, intervalMs);
      if (this._evalTimer && this._evalTimer.unref) this._evalTimer.unref();

      log(`Degradation ladder started (eval interval: ${Math.round(intervalMs / 1000)}s, recovery check: every 5min)`, 'INFO', 'degradation-ladder');
    } catch (err: any) {
      logError('Failed to start degradation ladder', err);
    }
  }

  stop() { 
    if (this._evalTimer) { clearInterval(this._evalTimer); this._evalTimer = null; }
    if (this._recoveryTimer) { clearInterval(this._recoveryTimer); this._recoveryTimer = null; }
    log('Degradation ladder stopped', 'INFO', 'degradation-ladder');
  }

  /**
   * Get degradation history.
   */
  getHistory(limit = 20) { 
    try {
      return getDb()?.prepare('SELECT * FROM degradation_log ORDER BY timestamp DESC LIMIT ?').all(limit);
    } catch (err: any) {
      logError('Error getting degradation history', err);
      return [];
    }
  }
}

const degradationLadder = new DegradationLadder();
module.exports = {
  DegradationLadder,
  degradationLadder,
  MODES,
  MODE_CONFIG_OVERRIDES,
  _injectDependencies,
};