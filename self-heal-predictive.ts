'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }
function getInsertSelfHealEvent() { return _deps.database?.insertSelfHealEvent; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }
function getSelectCalibration() { return _deps.database?.selectCalibration; }

const CONFIG = require('./get-config');

const LATENCY_SPIKE_THRESHOLD = CONFIG.PREDICTIVE_HEAL_LATENCY_SPIKE_THRESHOLD || 2.0;
const CLICK_DROP_THRESHOLD = CONFIG.PREDICTIVE_HEAL_CLICK_DROP_THRESHOLD || 0.3;
const ENTROPY_REPEAT_LIMIT = 5;
const SHADOW_FIX_TTL_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute

class SelfHealPredictor {
  _codeGenTribunal: any;
  metricsWindow: any;
  maxWindowSamples: any;
  baseline: any;
  shadowFixCache: any;
  _checkInterval: any;
  _isRunning: any;
  _anomalyDetector: any;

  constructor() {
    this.metricsWindow = [];
    this.maxWindowSamples = 60;
    this.baseline = {
      latencyP95: null,
      clickSuccessRate: null,
      screenshotHashEntropy: null,
    };
    this.shadowFixCache = new Map();
    this._checkInterval = null;
    this._isRunning = false;
    this._anomalyDetector = null;
    this._codeGenTribunal = null;

    this._subscribeToAnomalies();
    this._loadBaseline();
    this._registerFailsafeHealthCheck();
  }

  /**
   * Try to subscribe to anomaly events from the existing anomaly-detector module.
   */
  _subscribeToAnomalies() { 
    try {
      const { anomalyDetector } = require('./monitoring-anomaly-detector');
      this._anomalyDetector = anomalyDetector;
      log('Subscribed to anomaly-detector events', 'INFO', 'predictive-heal');
    } catch (err: any) {
      log('anomaly-detector module not available, running in standalone mode', 'WARN', 'predictive-heal');
    }
  }

  /**
   * Try to load the codegen tribunal for shadow mode.
   */
  _getCodegenTribunal() { 
    if (this._codeGenTribunal) return this._codeGenTribunal;
    try {
      this._codeGenTribunal = require('./providers-codegen-tribunal');
      return this._codeGenTribunal;
    } catch (err: any) {
      logError('codegen-tribunal module not available for shadow mode', err, { module: 'predictive-heal' });
      return null;
    }
  }

  /**
   * Load baseline from calibration table or initialize defaults.
   */
  _loadBaseline() { 
    try {
      const row = getSelectCalibration()?.get('predictive_heal_baseline');
      if (row && row.value) {
        const parsed = JSON.parse(row.value);
        if (parsed.latencyP95 != null) this.baseline.latencyP95 = parsed.latencyP95;
        if (parsed.clickSuccessRate != null) this.baseline.clickSuccessRate = parsed.clickSuccessRate;
        if (parsed.screenshotHashEntropy != null) this.baseline.screenshotHashEntropy = parsed.screenshotHashEntropy;
        log('Loaded predictive baseline from calibration', 'DEBUG', 'predictive-heal');
      }
    } catch (err: any) {
      logError('Failed to load predictive baseline', err, { module: 'predictive-heal' });
    }
  }

  /**
   * Persist baseline to calibration table.
   */
  _persistBaseline() { 
    try {
      getUpsertCalibration()?.run('predictive_heal_baseline', JSON.stringify(this.baseline), Date.now());
    } catch (err: any) {
      logError('Failed to persist predictive baseline', err, { module: 'predictive-heal' });
    }
  }

  /**
   * Register as a failsafe health check.
   */
  _registerFailsafeHealthCheck() { 
    try {
      const failsafe = require('./failsafe-coordinator');
      const coordinator = failsafe && (failsafe.failsafeCoordinator || failsafe);
      if (coordinator && typeof coordinator.registerHealthCheck === 'function') {
        coordinator.registerHealthCheck('predictive-heal', () => this._healthCheck(), 60000);
        log('Registered predictive-heal as failsafe health check', 'INFO', 'predictive-heal');
      }
    } catch (err: any) {
      log('failsafe-coordinator not available for health check registration', 'WARN', 'predictive-heal');
    }
  }

  /**
   * Health check for failsafe coordinator.
   */
  _healthCheck() { 
    if (this.metricsWindow.length < 3) {
      return { healthy: true, status: 'warming_up', samples: this.metricsWindow.length };
    }
    const latest = this.metricsWindow[this.metricsWindow.length - 1];
    const anomalyDetected = this._evaluateMetrics(latest);
    return {
      healthy: !anomalyDetected.detected,
      status: anomalyDetected.detected ? 'anomaly_detected' : 'normal',
      latestMetrics: latest,
      reasons: anomalyDetected.reasons,
      shadowFixReady: this.shadowFixCache.size > 0,
    };
  }

  /**
   * Compute p95 from a sorted array of numbers.
   */
  _computeP95(values: any) { 
    if (!values || values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.floor(sorted.length * 0.95);
    return sorted[Math.min(idx, sorted.length - 1)];
  }

  /**
   * Compute screenshot hash entropy (diversity) from recent hashes.
   */
  _computeHashEntropy(recentHashes: any) { 
    if (!recentHashes || recentHashes.length === 0) return null;
    const counts = new Map();
    for (const h of recentHashes) {
      counts.set(h, (counts.get(h) || 0) + 1);
    }
    const total = recentHashes.length;
    let entropy = 0;
    for (const count of counts.values()) {
      const p = count / total;
      if (p > 0) entropy -= p * Math.log2(p);
    }
    return entropy;
  }

  /**
   * Update baseline from recent metrics window when enough data collected.
   */
  _updateBaselineFromWindow() { 
    if (this.metricsWindow.length < 10) return;
    const latencies = this.metricsWindow
      .map((m: any) => m.latencyP95)
      .filter((v: any) => v != null);
    const clickRates = this.metricsWindow
      .map((m: any) => m.clickSuccessRate)
      .filter((v: any) => v != null);

    if (latencies.length > 5) {
      this.baseline.latencyP95 = this._computeP95(latencies);
    }
    if (clickRates.length > 5) {
      this.baseline.clickSuccessRate = clickRates.reduce((a: any, b: any) => a + b, 0) / clickRates.length;
    }

    const allHashes = this.metricsWindow
      .flatMap((m: any) => m.recentScreenshotHashes || [])
      .slice(-50);
    if (allHashes.length > 10) {
      this.baseline.screenshotHashEntropy = this._computeHashEntropy(allHashes);
    }

    this._persistBaseline();
  }

  /**
   * Check latest metrics against baseline for anomalies.
   * Returns { detected: boolean, reasons: string[] }
   */
  _evaluateMetrics(latest: any) { 
    const reasons = [];
    let detected = false;

    // Check latency spike: p95 > 2x baseline
    if (latest.latencyP95 != null && this.baseline.latencyP95 != null && this.baseline.latencyP95 > 0) {
      const ratio = latest.latencyP95 / this.baseline.latencyP95;
      if (ratio > LATENCY_SPIKE_THRESHOLD) {
        reasons.push(`latency_p95_spike: ${latest.latencyP95.toFixed(0)}ms is ${ratio.toFixed(1)}x baseline ${this.baseline.latencyP95.toFixed(0)}ms`);
        detected = true;
      }
    }

    // Check click success rate drop > 30% from baseline
    if (latest.clickSuccessRate != null && this.baseline.clickSuccessRate != null && this.baseline.clickSuccessRate > 0) {
      const drop = this.baseline.clickSuccessRate - latest.clickSuccessRate;
      if (drop > CLICK_DROP_THRESHOLD) {
        reasons.push(`click_rate_drop: ${latest.clickSuccessRate.toFixed(3)} dropped ${(drop / this.baseline.clickSuccessRate * 100).toFixed(1)}% from baseline ${this.baseline.clickSuccessRate.toFixed(3)}`);
        detected = true;
      }
    }

    // Check screenshot hash entropy collapse (same hash repeated > 5 times with no state change)
    if (latest.recentScreenshotHashes && latest.recentScreenshotHashes.length > 0) {
      const hashCounts = new Map();
      for (const h of latest.recentScreenshotHashes) {
        hashCounts.set(h, (hashCounts.get(h) || 0) + 1);
      }
      for (const [hash, count] of hashCounts) {
        if (count > ENTROPY_REPEAT_LIMIT && !latest.stateChanged) {
          reasons.push(`screenshot_entropy_collapse: hash ${hash.substring(0, 12)}... repeated ${count} times without state change`);
          detected = true;
          break;
        }
      }
    }

    return { detected, reasons };
  }

  /**
   * Main check method - receives latest metrics and evaluates them.
   * @param {Object} latestMetrics - { latencyP95, clickSuccessRate, recentScreenshotHashes, stateChanged }
   * @returns {{ anomalyDetected: boolean, reasons: string[], shadowFixAvailable: boolean }}
   */
  checkMetrics(latestMetrics: any) { 
    try {
      // Add to rolling window
      this.metricsWindow.push({
        ...latestMetrics,
        timestamp: Date.now(),
      });
      if (this.metricsWindow.length > this.maxWindowSamples) {
        this.metricsWindow.shift();
      }

      // Update baseline periodically
      this._updateBaselineFromWindow();

      // Evaluate
      const result = this._evaluateMetrics(latestMetrics);

      if (result.detected) {
        log(`Pre-failure anomaly detected: ${result.reasons.join('; ')}`, 'WARN', 'predictive-heal');
        this._logSelfHealEvent('predictive', 'anomaly_detected', result.reasons.join('; '), null);

        // Run shadow investigation
        this.runShadowInvestigation().catch(err => {
          logError('Shadow investigation failed', err, { module: 'predictive-heal' });
        });
      }

      return {
        anomalyDetected: result.detected,
        reasons: result.reasons,
        shadowFixAvailable: this.shadowFixCache.size > 0,
      };
    } catch (err: any) {
      logError('checkMetrics failed', err, { module: 'predictive-heal' });
      return { anomalyDetected: false, reasons: [], shadowFixAvailable: false };
    }
  }

  /**
   * Run shadow investigation - launches browser, takes screenshot, generates fix via tribunal.
   * Does NOT apply the fix - stores in cache for potential later use.
   */
  async runShadowInvestigation() { 
    const startTime = Date.now();
    let investigationResult = null;

    try {
      log('Starting shadow investigation (pre-failure)', 'INFO', 'predictive-heal');

      const { launchBrowser, closeBrowser } = require('./browser');
      const { authenticate } = require('./auth');
      const tribunal = this._getCodegenTribunal();
      if (!tribunal) {
        log('Cannot run shadow investigation: codegen-tribunal unavailable', 'WARN', 'predictive-heal');
        return;
      }

      let page = null;
      try {
        page = await launchBrowser();
        await authenticate(page);
        await page.goto((CONFIG.APP_URL || 'https://app.mathletics.com') + '/assignments', { waitUntil: 'domcontentloaded', timeout: 30000 });
        await sleep(3000);

        const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 });
        const base64 = screenshot.toString('base64');
        const html = await page.content();
        const url = page.url();

        investigationResult = {
          url: url || CONFIG.APP_URL,
          html: html || '',
          screenshotBase64: base64,
          timestamp: Date.now(),
        };

        log('Shadow investigation: page captured, requesting tribunal fix', 'INFO', 'predictive-heal');

        const { generateCodeFixViaTribunal } = tribunal;
        const fixes = await generateCodeFixViaTribunal(
          { url: investigationResult.url, html: investigationResult.html, screenshotBase64: investigationResult.screenshotBase64 },
          `Predictive anomaly detected at ${new Date().toISOString()}. Metrics indicate pre-failure conditions. Generate preventive fix.`
        );

        if (fixes && fixes.length > 0) {
          const cacheKey = `shadow_${Date.now()}`;
          this.shadowFixCache.set(cacheKey, {
            fixes,
            capturedAt: Date.now(),
            expiresAt: Date.now() + SHADOW_FIX_TTL_MS,
            investigation: {
              url: investigationResult.url,
              timestamp: investigationResult.timestamp,
            },
          });

          // Evict expired entries
          this._evictExpiredCache();

          log(`Shadow fix cached: ${fixes.length} fix(es) available (TTL ${SHADOW_FIX_TTL_MS / 60000}min)`, 'INFO', 'predictive-heal');
          this._logSelfHealEvent('predictive', 'shadow_fix_cached', `${fixes.length} fixes cached`, JSON.stringify(fixes.map((f: any) => f.file)).substring(0, 500), fixes.length, 0, 0, 'shadow_cached', Date.now() - startTime);
        } else {
          log('Shadow investigation: tribunal returned no fixes', 'INFO', 'predictive-heal');
          this._logSelfHealEvent('predictive', 'shadow_no_fix', 'Tribunal returned no fixes', null, 0, 0, 0, 'no_fix', Date.now() - startTime);
        }
      } finally {
        try {
          const { closeBrowser } = require('./browser');
          await closeBrowser();
        } catch (e: any) { /* best effort cleanup */ }
      }
    } catch (err: any) {
      logError('Shadow investigation error', err, { module: 'predictive-heal' });
      this._logSelfHealEvent('predictive', 'shadow_error', err.message, null, 0, 0, 0, 'error', Date.now() - startTime, err.message);
    }
  }

  /**
   * Evict expired entries from shadow fix cache.
   */
  _evictExpiredCache() { 
    const now = Date.now();
    for (const [key, entry] of this.shadowFixCache) {
      if (now > entry.expiresAt) {
        this.shadowFixCache.delete(key);
      }
    }
  }

  /**
   * Get cached shadow fix if available. Returns null if none cached or all expired.
   * @returns {{ fixes: Array, capturedAt: number, investigation: Object } | null}
   */
  getCachedShadowFix() { 
    try {
      this._evictExpiredCache();
      if (this.shadowFixCache.size === 0) return null;
      // Return the most recent cached fix
      const entries = [...this.shadowFixCache.values()].sort((a, b) => b.capturedAt - a.capturedAt);
      const latest = entries[0];
      log('Retrieved cached shadow fix for real failure recovery', 'INFO', 'predictive-heal');
      return {
        fixes: latest.fixes,
        capturedAt: latest.capturedAt,
        investigation: latest.investigation,
      };
    } catch (err: any) {
      logError('Failed to get cached shadow fix', err, { module: 'predictive-heal' });
      return null;
    }
  }

  /**
   * Clear the shadow fix cache (e.g., after applying a fix).
   */
  clearShadowCache() { 
    this.shadowFixCache.clear();
    log('Shadow fix cache cleared', 'DEBUG', 'predictive-heal');
  }

  /**
   * Log a self-heal event to the database.
   */
  _logSelfHealEvent(featureId: any, phase: any, triggerReason: any, investigationResult: any, patchesGenerated = 0, patchesSafe = 0, patchesApplied = 0, outcome = '', durationMs = 0, error = null) { 
    try {
      getInsertSelfHealEvent()?.run(
        Date.now(),
        featureId,
        phase,
        triggerReason ? String(triggerReason).substring(0, 1000) : null,
        investigationResult ? String(investigationResult).substring(0, 2000) : null,
        patchesGenerated,
        patchesSafe,
        patchesApplied,
        outcome ? String(outcome).substring(0, 100) : null,
        durationMs,
        error ? String(error).substring(0, 1000) : null
      );
    } catch (err: any) {
      logError('Failed to log self-heal event', err, { module: 'predictive-heal' });
    }
  }

  /**
   * Get current metrics summary.
   */
  getMetricsSummary() { 
    return {
      windowSize: this.metricsWindow.length,
      baseline: { ...this.baseline },
      shadowFixCount: this.shadowFixCache.size,
      isRunning: this._isRunning,
    };
  }

  /**
   * Start the periodic check loop.
   * @param {number} intervalMs - Check interval in milliseconds (default 60s)
   */
  start(intervalMs = DEFAULT_CHECK_INTERVAL_MS) { 
    if (this._isRunning) {
      log('Predictive healer already running', 'WARN', 'predictive-heal');
      return;
    }

    this._isRunning = true;
    const safeInterval = Math.max(10000, intervalMs);

    // Also check on anomaly events from the anomaly-detector if available
    if (this._anomalyDetector && this._anomalyDetector.metrics) {
      try {
        // Collect from anomaly detector's metrics periodically
        this._checkInterval = setInterval(() => {
          this._periodicAnomalyCheck();
        }, safeInterval);
      } catch (err: any) {
        logError('Failed to set up anomaly detector integration', err, { module: 'predictive-heal' });
      }
    } else {
      this._checkInterval = setInterval(() => {
        this._periodicAnomalyCheck();
      }, safeInterval);
    }
    if (this._checkInterval && this._checkInterval.unref) this._checkInterval.unref();

    // Run first check after a short delay
    setTimeout(() => this._periodicAnomalyCheck(), 5000).unref();

    log(`Predictive healer started (interval: ${safeInterval / 1000}s)`, 'INFO', 'predictive-heal');
  }

  /**
   * Periodic check that pulls from blackbox records and evaluates.
   */
  async _periodicAnomalyCheck() { 
    try {
      const now = Date.now();
      const oneHourAgo = now - 3600000;

      // Query recent blackbox metrics
      const recentEntries = getDb()?.prepare(`
        SELECT latency, success, screenshot_hash, state, timestamp
        FROM blackbox
        WHERE timestamp > ?
        ORDER BY timestamp DESC
        LIMIT 50
      `).all(oneHourAgo);

      if (recentEntries.length === 0) return;

      const latencies = recentEntries
        .map((e: any) => e.latency)
        .filter((v: any) => v != null && v > 0);
      const successes = recentEntries.map((e: any) => e.success);
      const hashes = recentEntries
        .map((e: any) => e.screenshot_hash)
        .filter((v: any) => v != null && v.length > 0);

      const clickSuccessCount = successes.filter((s: any) => s === 1 || s === true).length;
      const clickSuccessRate = successes.length > 0 ? clickSuccessCount / successes.length : null;

      this.checkMetrics({
        latencyP95: this._computeP95(latencies),
        clickSuccessRate,
        recentScreenshotHashes: hashes.slice(-10),
        stateChanged: new Set(recentEntries.map((e: any) => e.state).filter(Boolean)).size > 1,
      });
    } catch (err: any) {
      logError('Periodic anomaly check failed', err, { module: 'predictive-heal' });
    }
  }

  /**
   * Stop the periodic check loop.
   */
  stop() { 
    this._isRunning = false;
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
    log('Predictive healer stopped', 'INFO', 'predictive-heal');
  }
}

const selfHealPredictor = new SelfHealPredictor();

module.exports = { SelfHealPredictor, selfHealPredictor , _injectDependencies };