'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

const { log, logError } = require('./logger');
// M5 FIX: Removed unused `const CONFIG = require('./get-config')` — all thresholds are
// module-level constants (lines below), not config-driven.
const ANOMALY_CHECK_INTERVAL_MS = 5 * 60 * 1000;
const REQUIRED_SAMPLES = 30;
const Z_SCORE_THRESHOLD = 3;
const CONSECUTIVE_ANOMALIES_REQUIRED = 2;

class AnomalyDetector {
  metrics: any;
  anomalyCounts: any;
  lastCheck: any;
  isRunning: any;
  _captchaCooldownTimer: any;
  _interval: any;
  _initialTimeout: any;

  constructor() {
    this.metrics = {
      pageLoadTime: [],
      actionLatency: [],
      captchaFrequency: [],
      memoryUsage: [],
    };
    this.anomalyCounts = {
      pageLoadTime: 0,
      actionLatency: 0,
      captchaFrequency: 0,
      memoryUsage: 0,
    };
    this.lastCheck = 0;
    this.isRunning = false;
  }

  async collectMetrics() { 
    try {
      const now = Date.now();
      const lastHour = now - 3600000;
      const pageLoads = getDb()?.prepare(`
        SELECT AVG(latency) as avg_latency FROM blackbox
        WHERE timestamp > ? AND state = 'assignments_page'
      `).get(lastHour);
      if (pageLoads && pageLoads.avg_latency) {
        this.metrics.pageLoadTime.push(parseFloat(pageLoads.avg_latency));
      }
      const actions = getDb()?.prepare(`
        SELECT AVG(latency) as avg_latency FROM blackbox
        WHERE timestamp > ? AND latency > 0
      `).get(lastHour);
      if (actions && actions.avg_latency) {
        this.metrics.actionLatency.push(parseFloat(actions.avg_latency));
      }
      const captchas = getDb()?.prepare(`
        SELECT COUNT(*) as count FROM blackbox
        WHERE timestamp > ? AND state = 'captcha' AND success = 0
      `).get(lastHour);
      if (captchas) {
        this.metrics.captchaFrequency.push(captchas.count);
      }
      const memUsage = process.memoryUsage().heapUsed / 1024 / 1024;
      this.metrics.memoryUsage.push(memUsage);
      // Prevent unbounded memory growth — trim to last 500 samples
      const MAX_SAMPLES = 500;
      for (const key of Object.keys(this.metrics)) {
        if (this.metrics[key].length > MAX_SAMPLES) {
          this.metrics[key] = this.metrics[key].slice(-MAX_SAMPLES);
        }
      }
    } catch (err: any) {
      logError('Failed to collect metrics for anomaly detection', err);
    }
  }

  computeStats(values: any) { 
    if (values.length < REQUIRED_SAMPLES) return null;
    const mean = values.reduce((a: any, b: any) => a + b, 0) / values.length;
    const variance = values.reduce((a: any, b: any) => a + Math.pow(b - mean, 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    return { mean, stdDev };
  }

  detectAnomaly(metric: any, value: any) { 
    const stats = this.computeStats(this.metrics[metric]);
    if (!stats) return false;
    const zScore = Math.abs((value - stats.mean) / (stats.stdDev || 1));
    if (zScore > Z_SCORE_THRESHOLD) {
      this.anomalyCounts[metric]++;
      if (this.anomalyCounts[metric] >= CONSECUTIVE_ANOMALIES_REQUIRED) {
        return true;
      }
    } else {
      this.anomalyCounts[metric] = 0;
    }
    return false;
  }

  async runCheck() { 
    if (this.isRunning) return;
    this.isRunning = true;
    try {
      await this.collectMetrics();
      const checks = [
        { metric: 'pageLoadTime', value: this.metrics.pageLoadTime[this.metrics.pageLoadTime.length - 1] },
        { metric: 'actionLatency', value: this.metrics.actionLatency[this.metrics.actionLatency.length - 1] },
        { metric: 'captchaFrequency', value: this.metrics.captchaFrequency[this.metrics.captchaFrequency.length - 1] },
        { metric: 'memoryUsage', value: this.metrics.memoryUsage[this.metrics.memoryUsage.length - 1] },
      ];
      let anomaliesFound = 0;
      const anomalyDetails = [];
      for (const check of checks) {
        if (check.value !== undefined && check.value !== null) {
          const isAnomaly = this.detectAnomaly(check.metric, check.value);
          if (isAnomaly && isFinite(check.value)) {
            anomaliesFound++;
            const stats = this.computeStats(this.metrics[check.metric]);
            const detail = `${check.metric} = ${check.value.toFixed(2)} (mean=${stats?.mean?.toFixed(2) || '?'} stdDev=${stats?.stdDev?.toFixed(2) || '?'})`;
            anomalyDetails.push(detail);
            log(`Anomaly detected: ${detail}`, 'WARN', 'anomaly');
          }
        }
      }
      // v6-fix: Aggregated alerting. IMPORTANT: detectAnomaly() has a SIDE EFFECT
      // (increments anomalyCounts). The original code called it TWICE per metric —
      // the second call saw the count already inflated by the first, causing FALSE
      // recovery triggers on a SINGLE anomaly.
      // Fixed: trigger recovery using already-detected results, not re-detecting.
      if (anomaliesFound > 0) {
        const summary = `Anomaly detection: ${anomaliesFound} metric(s) above threshold:\n${anomalyDetails.join('\n')}`;
        const severity = anomaliesFound >= 3 ? 1 : 2;
        getSendAlert()(summary, severity);
        // Trigger recovery for metrics that already triggered above.
        // Do NOT call detectAnomaly() again (it would double-count).
        for (const check of checks) {
          if (check.value !== undefined && isFinite(check.value)) {
            const stats = this.computeStats(this.metrics[check.metric]);
            if (stats) {
              const z = Math.abs((check.value - stats.mean) / (stats.stdDev || 1));
              if (z > Z_SCORE_THRESHOLD && this.anomalyCounts[check.metric] >= CONSECUTIVE_ANOMALIES_REQUIRED) {
                this.triggerRecovery(check.metric);
              }
            }
          }
        }
      } else {
        log(`Anomaly check passed: ${checks.filter(c => c.value != null).length} metrics normal`, 'DEBUG', 'anomaly');
      }
      this.lastCheck = Date.now();
    } catch (err: any) {
      logError('Anomaly detection failed', err);
    } finally {
      this.isRunning = false;
    }
  }

  triggerRecovery(metric: any) { 
    if (metric === 'memoryUsage') {
      log('Memory anomaly detected, triggering cleanup', 'WARN', 'anomaly');
      if (global.gc) {
        global.gc();
      }
      const { clearCache } = require('./cache');
      clearCache();
    } else if (metric === 'pageLoadTime' || metric === 'actionLatency') {
      log('Performance anomaly detected, restarting browser', 'WARN', 'anomaly');
      const { closeBrowser, launchBrowser } = require('./browser');
      closeBrowser().then(() => launchBrowser()).catch(() => {});
    } else if (metric === 'captchaFrequency') {
      log('High CAPTCHA frequency, pausing for 5 minutes', 'WARN', 'anomaly');
      const orchestrator = require('./cycle-orchestrator');
      orchestrator.requestStop();
      if (this._captchaCooldownTimer) { clearTimeout(this._captchaCooldownTimer); }
      this._captchaCooldownTimer = setTimeout(() => {
        this._captchaCooldownTimer = null;
        if (typeof orchestrator.resumeDaemon === 'function') {
          orchestrator.resumeDaemon();
        } else {
          log('Cannot resume daemon: resumeDaemon not exported by orchestrator', 'ERROR', 'anomaly');
        }
      }, 5 * 60 * 1000);
      if (this._captchaCooldownTimer.unref) this._captchaCooldownTimer.unref();
    }
  }

  start() { 
    this._interval = setInterval(() => this.runCheck(), ANOMALY_CHECK_INTERVAL_MS);
    if (this._interval.unref) this._interval.unref();
    this._initialTimeout = setTimeout(() => this.runCheck(), 30000);
    if (this._initialTimeout.unref) this._initialTimeout.unref();
    log('Anomaly detector started', 'INFO', 'anomaly');
  }

  stop() { 
    if (this._interval) { clearInterval(this._interval); this._interval = null; }
    if (this._initialTimeout) { clearTimeout(this._initialTimeout); this._initialTimeout = null; }
    if (this._captchaCooldownTimer) { clearTimeout(this._captchaCooldownTimer); this._captchaCooldownTimer = null; }
    log('Anomaly detector stopped', 'INFO', 'anomaly');
  }
}

const anomalyDetector = new AnomalyDetector();

module.exports = { anomalyDetector, _injectDependencies };
