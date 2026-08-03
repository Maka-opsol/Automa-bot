'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }
function getInsertSelfHealEvent() { return _deps.database?.insertSelfHealEvent; }

const CONFIG = require('./get-config');

const SMOOTHING_ALPHA = 0.3; // Exponential smoothing factor (lower = smoother)
const EXHAUSTION_LOOKBACK_CYCLES = 10;
const EXHAUSTION_WARNING_CYCLES = 2; // Warn if exhaustion predicted within this many cycles
const DEFAULT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const CALIBRATION_KEY_PREFIX = 'provider_health_';

class ProviderHealthPredictor {
  _providerDiscovery: any;
  providers: any;
  _checkInterval: any;
  _isRunning: any;
  _cycleCounter: any;

  constructor() {
    /**
     * Per-provider tracking:
     * Map<providerName, {
     *   cycles: Array<{ cycle: number, success: boolean, latency: number, quotaUsed: number, quotaTotal: number }>,
     *   smoothed: { successRate: number, latency: number, quotaRate: number },
     *   lastPrediction: { willExhaustIn: number|null, confidence: number }|null,
     * }>
     */
    this.providers = new Map();
    this._checkInterval = null;
    this._isRunning = false;
    this._cycleCounter = 0;
    this._providerDiscovery = null;

    this._loadTrendsFromDB();
  }

  /**
   * Lazy-load provider discovery module.
   */
  _getProviderDiscovery() { 
    if (this._providerDiscovery) return this._providerDiscovery;
    try {
      const pd = require('./providers-provider-discovery');
      this._providerDiscovery = pd;
      return pd;
    } catch (err: any) {
      logError('provider-discovery module not available', err, { module: 'provider-prediction' });
      return null;
    }
  }

  /**
   * Load persisted trends from calibration table.
   */
  _loadTrendsFromDB() { 
    try {
      const rows = getDb()?.prepare(`
        SELECT key, value FROM calibration
        WHERE key LIKE ?
      `).all(`${CALIBRATION_KEY_PREFIX}%`);

      for (const row of rows) {
        try {
          const providerName = row.key.substring(CALIBRATION_KEY_PREFIX.length);
          const data = JSON.parse(row.value);
          if (data.cycles && Array.isArray(data.cycles)) {
            this.providers.set(providerName, {
              cycles: data.cycles,
              smoothed: data.smoothed || { successRate: 1, latency: 0, quotaRate: 0 },
              lastPrediction: data.lastPrediction || null,
            });
          }
        } catch (parseErr: any) {
          // Skip malformed rows
        }
      }

      if (this.providers.size > 0) {
        log(`Loaded provider health trends for ${this.providers.size} provider(s)`, 'INFO', 'provider-prediction');
      }
    } catch (err: any) {
      logError('Failed to load provider trends from DB', err, { module: 'provider-prediction' });
    }
  }

  /**
   * Persist trends for a provider to the calibration table.
   */
  _persistProviderTrends(providerName: any) { 
    try {
      const data = this.providers.get(providerName);
      if (!data) return;

      const key = `${CALIBRATION_KEY_PREFIX}${providerName}`;
      // Keep only recent cycles to avoid bloating the DB
      const compactCycles = data.cycles.slice(-EXHAUSTION_LOOKBACK_CYCLES * 2);
      const toStore = {
        cycles: compactCycles,
        smoothed: data.smoothed,
        lastPrediction: data.lastPrediction,
      };
      getUpsertCalibration()?.run(key, JSON.stringify(toStore), Date.now());
    } catch (err: any) {
      logError(`Failed to persist trends for ${providerName}`, err, { module: 'provider-prediction' });
    }
  }

  /**
   * Record a provider cycle's stats and update smoothed metrics.
   * @param {string} providerName
   * @param {{ success: boolean, latency: number, quotaUsed: number, quotaTotal: number }} stats
   */
  recordProviderCycleStats(providerName: any, stats: any) { 
    try {
      if (!providerName || typeof providerName !== 'string') return;

      this._cycleCounter++;
      const safeName = providerName.substring(0, 100);

      if (!this.providers.has(safeName)) {
        this.providers.set(safeName, {
          cycles: [],
          smoothed: { successRate: 1, latency: 0, quotaRate: 0 },
          lastPrediction: null,
        });
      }

      const provider = this.providers.get(safeName);
      provider.cycles.push({
        cycle: this._cycleCounter,
        success: !!stats.success,
        latency: typeof stats.latency === 'number' ? stats.latency : 0,
        quotaUsed: typeof stats.quotaUsed === 'number' ? stats.quotaUsed : 0,
        quotaTotal: typeof stats.quotaTotal === 'number' ? stats.quotaTotal : 0,
      });

      // Trim to keep only recent data
      if (provider.cycles.length > EXHAUSTION_LOOKBACK_CYCLES * 3) {
        provider.cycles = provider.cycles.slice(-EXHAUSTION_LOOKBACK_CYCLES * 2);
      }

      // Update exponential smoothing
      const alpha = SMOOTHING_ALPHA;

      // Success rate (binary: 1 or 0)
      const currentSuccess = stats.success ? 1 : 0;
      provider.smoothed.successRate = alpha * currentSuccess + (1 - alpha) * provider.smoothed.successRate;

      // Latency
      if (stats.latency > 0) {
        if (provider.smoothed.latency === 0) {
          provider.smoothed.latency = stats.latency;
        } else {
          provider.smoothed.latency = alpha * stats.latency + (1 - alpha) * provider.smoothed.latency;
        }
      }

      // Quota consumption rate (quota used per cycle)
      if (stats.quotaUsed > 0 && stats.quotaTotal > 0) {
        provider.smoothed.quotaRate = alpha * stats.quotaUsed + (1 - alpha) * provider.smoothed.quotaRate;
      }

      // Compute exhaustion prediction
      provider.lastPrediction = this.getExhaustionPrediction(safeName);

      // Persist periodically (every 5 cycles to reduce DB writes)
      if (this._cycleCounter % 5 === 0) {
        this._persistProviderTrends(safeName);
      }
    } catch (err: any) {
      logError(`Failed to record provider stats for ${providerName}`, err, { module: 'provider-prediction' });
    }
  }

  /**
   * Get exhaustion prediction for a provider using simple linear regression on quota consumption.
   * @param {string} providerName
   * @returns {{ willExhaustIn: number|null, confidence: number }}
   *   - willExhaustIn: estimated cycles until exhaustion (null if no quota data)
   *   - confidence: 0-1, higher with more data points and better R² fit
   */
  getExhaustionPrediction(providerName: any) { 
    try {
      const provider = this.providers.get(providerName);
      if (!provider || provider.cycles.length < 3) {
        return { willExhaustIn: null, confidence: 0 };
      }

      // Get recent cycles with quota data
      const recentCycles = provider.cycles.slice(-EXHAUSTION_LOOKBACK_CYCLES);
      const quotaCycles = recentCycles.filter((c: any) => c.quotaUsed > 0 && c.quotaTotal > 0);

      if (quotaCycles.length < 3) {
        return { willExhaustIn: null, confidence: 0 };
      }

      // Simple linear regression on cumulative quota consumption
      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0, sumY2 = 0, n = 0;
      const points = [];

      for (const c of quotaCycles) {
        points.push({ x: c.cycle, y: c.quotaUsed });
      }

      for (const { x, y } of points) {
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
        sumY2 += y * y;
        n++;
      }

      const denom = (n * sumX2 - sumX * sumX);
      if (denom === 0) {
        return { willExhaustIn: null, confidence: 0 };
      }

      // Regression line: y = slope * x + intercept
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;

      // Get the most recent quota total (assume it stays constant)
      const latestQuotaTotal = quotaCycles[quotaCycles.length - 1].quotaTotal;
      if (latestQuotaTotal <= 0) {
        return { willExhaustIn: null, confidence: 0 };
      }

      // Calculate cumulative quota used so far
      const cumulativeUsed = points.reduce((sum, p) => sum + p.y, 0);

      // Predict cycles until exhaustion: remaining_quota / rate_per_cycle
      const remaining = Math.max(0, latestQuotaTotal - cumulativeUsed);
      const ratePerCycle = Math.abs(slope) > 0 ? Math.abs(slope) : provider.smoothed.quotaRate;

      if (ratePerCycle <= 0) {
        return { willExhaustIn: null, confidence: 0 };
      }

      const cyclesToExhaust = Math.ceil(remaining / ratePerCycle);

      // Compute R² for confidence
      const meanY = sumY / n;
      const ssTot = points.reduce((sum, p) => sum + Math.pow(p.y - meanY, 2), 0);
      const ssRes = points.reduce((sum, p) => {
        const predicted = slope * p.x + intercept;
        return sum + Math.pow(p.y - predicted, 2);
      }, 0);
      const rSquared = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;
      const confidence = Math.max(0, Math.min(1, rSquared * (n / EXHAUSTION_LOOKBACK_CYCLES)));

      // If slope is decreasing (quota usage going down), no exhaustion risk
      if (slope < 0) {
        return { willExhaustIn: null, confidence: 0 };
      }

      return {
        willExhaustIn: cyclesToExhaust,
        confidence: Math.round(confidence * 100) / 100,
      };
    } catch (err: any) {
      logError(`Failed to predict exhaustion for ${providerName}`, err, { module: 'provider-prediction' });
      return { willExhaustIn: null, confidence: 0 };
    }
  }

  /**
   * Get list of providers predicted to exhaust within EXHAUSTION_WARNING_CYCLES.
   * @returns {Array<{ providerName: string, willExhaustIn: number, confidence: number, smoothed: Object }>}
   */
  getProvidersNeedingReplacement() { 
    try {
      const needing = [];

      for (const [providerName, data] of this.providers) {
        const prediction = data.lastPrediction || this.getExhaustionPrediction(providerName);

        if (
          prediction.willExhaustIn !== null &&
          prediction.willExhaustIn <= EXHAUSTION_WARNING_CYCLES &&
          prediction.confidence > 0.3
        ) {
          needing.push({
            providerName,
            willExhaustIn: prediction.willExhaustIn,
            confidence: prediction.confidence,
            smoothed: { ...data.smoothed },
          });
        }
      }

      // Sort by urgency (lowest cycles first, then by confidence)
      needing.sort((a, b) => {
        if (a.willExhaustIn !== b.willExhaustIn) return a.willExhaustIn - b.willExhaustIn;
        return b.confidence - a.confidence;
      });

      if (needing.length > 0) {
        log(`${needing.length} provider(s) need replacement: ${needing.map(n => `${n.providerName} (${n.willExhaustIn} cycles)`).join(', ')}`, 'WARN', 'provider-prediction');
      }

      return needing;
    } catch (err: any) {
      logError('Failed to get providers needing replacement', err, { module: 'provider-prediction' });
      return [];
    }
  }

  /**
   * Start proactive provider discovery when exhaustion is predicted.
   * Calls refreshAllProviderModels from providers/provider-discovery early.
   */
  async startProactiveDiscovery() { 
    try {
      const needing = this.getProvidersNeedingReplacement();
      if (needing.length === 0) return;

      const pd = this._getProviderDiscovery();
      if (!pd || typeof pd.refreshAllProviderModels !== 'function') {
        log('Provider discovery module unavailable for proactive refresh', 'WARN', 'provider-prediction');
        return;
      }

      log(`Starting proactive provider discovery for ${needing.length} at-risk provider(s)`, 'INFO', 'provider-prediction');

      for (const { providerName, willExhaustIn, confidence } of needing) {
        try {
          this._logSelfHealEvent(
            'provider-prediction',
            'proactive_discovery',
            `${providerName} predicted to exhaust in ${willExhaustIn} cycles (confidence: ${confidence})`,
            null,
            0, 0, 0,
            'discovery_started'
          );
        } catch (e: any) { /* skip */ }
      }

      await pd.refreshAllProviderModels();

      log('Proactive provider discovery completed', 'INFO', 'provider-prediction');

      for (const { providerName } of needing) {
        try {
          this._logSelfHealEvent(
            'provider-prediction',
            'discovery_complete',
            `Refresh completed for ${providerName}`,
            null,
            0, 0, 0,
            'success'
          );
        } catch (e: any) { /* skip */ }
      }
    } catch (err: any) {
      logError('Proactive provider discovery failed', err, { module: 'provider-prediction' });
    }
  }

  /**
   * Start the periodic check loop.
   * @param {number} intervalMs - Check interval (default 5 minutes)
   */
  start(intervalMs = DEFAULT_CHECK_INTERVAL_MS) { 
    if (this._isRunning) {
      log('Provider health predictor already running', 'WARN', 'provider-prediction');
      return;
    }

    this._isRunning = true;
    const safeInterval = Math.max(60000, intervalMs);

    this._checkInterval = setInterval(() => {
      this._periodicCheck();
    }, safeInterval);
    if (this._checkInterval && this._checkInterval.unref) this._checkInterval.unref();

    // Run first check after 30 seconds
    setTimeout(() => this._periodicCheck(), 30000).unref();

    log(`Provider health predictor started (interval: ${safeInterval / 1000}s)`, 'INFO', 'provider-prediction');
  }

  /**
   * Periodic check for provider exhaustion.
   */
  async _periodicCheck() { 
    try {
      const needing = this.getProvidersNeedingReplacement();
      if (needing.length > 0) {
        await this.startProactiveDiscovery();
      }
    } catch (err: any) {
      logError('Periodic provider health check failed', err, { module: 'provider-prediction' });
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
    // Persist all trends on stop
    for (const providerName of this.providers.keys()) {
      this._persistProviderTrends(providerName);
    }
    log('Provider health predictor stopped', 'INFO', 'provider-prediction');
  }

  /**
   * Get summary of all tracked providers.
   */
  getSummary() { 
    const summary = {};
    for (const [name, data] of (this.providers as any)) {
// @ts-expect-error
      summary[name] = {
        cycleCount: data.cycles.length,
        smoothedSuccessRate: Math.round(data.smoothed.successRate * 1000) / 1000,
        smoothedLatency: Math.round(data.smoothed.latency),
        smoothedQuotaRate: Math.round(data.smoothed.quotaRate * 100) / 100,
        prediction: data.lastPrediction,
      };
    }
    return summary;
  }

  /**
   * Log a self-heal event.
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
      logError('Failed to log provider prediction self-heal event', err, { module: 'provider-prediction' });
    }
  }
}

const providerHealthPredictor = new ProviderHealthPredictor();

module.exports = { ProviderHealthPredictor, providerHealthPredictor , _injectDependencies };