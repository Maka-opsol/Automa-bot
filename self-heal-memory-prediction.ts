'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }
function getInsertSelfHealEvent() { return _deps.database?.insertSelfHealEvent; }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const CONFIG = require('./get-config');

const MIN_DATA_POINTS = 5;
const MAX_DATA_POINTS = 200;
const RESTART_BUFFER_CYCLES = 2;
const DEFAULT_CHECK_INTERVAL_MS = 60 * 1000; // 1 minute
const AVERAGE_CYCLE_DURATION_MS = 5 * 60 * 1000; // 5 minutes fallback

class MemoryPredictor {
  memoryHistory: any;
  _checkInterval: any;
  _isRunning: any;
  _lastRestartTime: any;
  _restartCooldownMs: any;
  _thresholdMB: any;
  _walHistory: any;

  constructor() {
    /**
     * Array of { timestamp: number, heapUsedMB: number }
     */
    this.memoryHistory = [];
    this._checkInterval = null;
    this._isRunning = false;
    this._lastRestartTime = 0;
    this._restartCooldownMs = 15 * 60 * 1000; // 15 min cooldown between restarts
    this._thresholdMB = CONFIG.MEMORY_RESTART_THRESHOLD_MB || 480;
  }

  /**
   * Record a heap usage data point.
   * @param {number} heapUsedMB - heapUsed in megabytes
   */
  recordMemory(heapUsedMB: any) { 
    try {
      const value = typeof heapUsedMB === 'number' && heapUsedMB >= 0 ? heapUsedMB : 0;
      this.memoryHistory.push({
        timestamp: Date.now(),
        heapUsedMB: Math.round(value * 100) / 100,
      });

      // Trim to max data points
      if (this.memoryHistory.length > MAX_DATA_POINTS) {
        this.memoryHistory = this.memoryHistory.slice(-MAX_DATA_POINTS);
      }
    } catch (err: any) {
      logError('Failed to record memory data point', err, { module: 'memory-prediction' });
    }
  }

  /**
   * Get current heap usage from process.memoryUsage().
   * @returns {number} heapUsed in MB
   */
  _getCurrentHeapMB() { 
    try {
      const mem = process.memoryUsage();
      return Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100;
    } catch (err: any) {
      return 0;
    }
  }

  /**
   * Simple linear regression on recent data points.
   * Returns { slope, intercept, rSquared, dataPoints } or null if insufficient data.
   */
  _linearRegression() { 
    try {
      const data = this.memoryHistory;
      if (data.length < MIN_DATA_POINTS) return null;

      // Use the most recent points for a more accurate short-term prediction
      const recent = data.slice(-Math.min(data.length, 30));
      const n = recent.length;

      let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
      for (let i = 0; i < n; i++) {
        // Use time offset in minutes from the first point for better numerical stability
        const x = (recent[i].timestamp - recent[0].timestamp) / 60000; // minutes
        const y = recent[i].heapUsedMB;
        sumX += x;
        sumY += y;
        sumXY += x * y;
        sumX2 += x * x;
      }

      const denom = (n * sumX2 - sumX * sumX);
      if (Math.abs(denom) < 1e-10) return null;

      const slope = (n * sumXY - sumX * sumY) / denom; // MB per minute
      const intercept = (sumY - slope * sumX) / n;

      // Compute R²
      const meanY = sumY / n;
      let ssTot = 0, ssRes = 0;
      for (let i = 0; i < n; i++) {
        const x = (recent[i].timestamp - recent[0].timestamp) / 60000;
        const y = recent[i].heapUsedMB;
        ssTot += Math.pow(y - meanY, 2);
        ssRes += Math.pow(y - slope * x - intercept, 2);
      }
      const rSquared = ssTot > 0 ? 1 - (ssRes / ssTot) : 0;

      return { slope, intercept, rSquared, dataPoints: n };
    } catch (err: any) {
      logError('Linear regression failed', err, { module: 'memory-prediction' });
      return null;
    }
  }

  /**
   * Predict how many minutes until heap usage reaches MEMORY_RESTART_THRESHOLD_MB.
   * @returns {number|null} estimated minutes until threshold, or null if can't predict
   */
  predictTimeToThreshold() { 
    try {
      const currentMB = this._getCurrentHeapMB();
      const regression = this._linearRegression();

      if (!regression || regression.slope <= 0) {
        // Memory not growing or insufficient data
        return null;
      }

      const remaining = this._thresholdMB - currentMB;
      if (remaining <= 0) {
        return 0; // Already at or above threshold
      }

      const minutesToThreshold = remaining / regression.slope;
      return Math.round(minutesToThreshold * 10) / 10;
    } catch (err: any) {
      logError('Failed to predict time to threshold', err, { module: 'memory-prediction' });
      return null;
    }
  }

  /**
   * Determine if a preemptive restart should be triggered.
   * Returns true if predicted to hit threshold within RESTART_BUFFER_CYCLES cycles
   * (based on average cycle duration).
   * @returns {boolean}
   */
  shouldPreemptiveRestart() { 
    try {
      // Check cooldown
      if (Date.now() - this._lastRestartTime < this._restartCooldownMs) {
        return false;
      }

      const currentMB = this._getCurrentHeapMB();
      if (currentMB >= this._thresholdMB) {
        log(`Memory already at threshold: ${currentMB}MB >= ${this._thresholdMB}MB`, 'ERROR', 'memory-prediction');
        return true;
      }

      const minutesToThreshold = this.predictTimeToThreshold();
      if (minutesToThreshold === null) return false;

      // Estimate average cycle duration from recent blackbox entries
      let avgCycleDurationMs = AVERAGE_CYCLE_DURATION_MS;
      try {
        const recentCycles = getDb()?.prepare(`
          SELECT timestamp, latency FROM blackbox
          WHERE timestamp > ?
          ORDER BY timestamp ASC
          LIMIT 50
        `).all(Date.now() - 3600000);

        if (recentCycles.length > 2) {
          let totalGap = 0;
          for (let i = 1; i < recentCycles.length; i++) {
            totalGap += recentCycles[i].timestamp - recentCycles[i - 1].timestamp;
          }
          avgCycleDurationMs = totalGap / (recentCycles.length - 1);
          avgCycleDurationMs = Math.max(60000, Math.min(avgCycleDurationMs, 30 * 60 * 1000)); // Clamp 1-30 min
        }
      } catch (e: any) {
        // Use default
      }

      const bufferWindowMs = RESTART_BUFFER_CYCLES * avgCycleDurationMs;
      const bufferWindowMinutes = bufferWindowMs / 60000;

      if (minutesToThreshold <= bufferWindowMinutes) {
        log(
          `Preemptive restart recommended: ${minutesToThreshold.toFixed(1)}min to threshold, buffer window is ${bufferWindowMinutes.toFixed(1)}min (${RESTART_BUFFER_CYCLES} cycles)`,
          'WARN',
          'memory-prediction'
        );
        return true;
      }

      return false;
    } catch (err: any) {
      logError('shouldPreemptiveRestart check failed', err, { module: 'memory-prediction' });
      return false;
    }
  }

  /**
   * Check disk usage: SQLite WAL size growth rate and screenshot directory size.
   * @returns {{ walSizeMB: number, walGrowthRateMBPerHour: number|null, screenshotDirSizeMB: number }}
   */
  getDiskUsagePrediction() { 
    try {
      let walSizeMB = 0;
      let walGrowthRateMBPerHour = null;
      let screenshotDirSizeMB = 0;

      // Check SQLite WAL size
      try {
        const dbPath = CONFIG.DB_PATH;
        if (dbPath) {
          const walPath = dbPath + '-wal';
          if (fs.existsSync(walPath)) {
            const stats = fs.statSync(walPath);
            walSizeMB = Math.round(stats.size / 1024 / 1024 * 100) / 100;

            // Estimate growth rate from recent WAL sizes (store in memory)
            if (!this._walHistory) this._walHistory = [];
            this._walHistory.push({ timestamp: Date.now(), sizeMB: walSizeMB });
            if (this._walHistory.length > 20) this._walHistory.shift();

            if (this._walHistory.length >= 3) {
              const oldest = this._walHistory[0];
              const newest = this._walHistory[this._walHistory.length - 1];
              const hoursElapsed = (newest.timestamp - oldest.timestamp) / 3600000;
              if (hoursElapsed > 0) {
                walGrowthRateMBPerHour = Math.round(((newest.sizeMB - oldest.sizeMB) / hoursElapsed) * 100) / 100;
              }
            }
          }
        }
      } catch (e: any) {
        // WAL check failed, continue
      }

      // Check screenshot directory size
      try {
        const screenshotDirs = [
          path.join(PROJECT_ROOT, 'logs', 'screenshots'),
          path.join(PROJECT_ROOT, 'screenshots'),
        ];
        for (const dir of screenshotDirs) {
          if (fs.existsSync(dir)) {
            const size = this._getDirSize(dir);
            screenshotDirSizeMB += size;
          }
        }
        screenshotDirSizeMB = Math.round(screenshotDirSizeMB * 100) / 100;
      } catch (e: any) {
        // Screenshot dir check failed, continue
      }

      return { walSizeMB, walGrowthRateMBPerHour, screenshotDirSizeMB };
    } catch (err: any) {
      logError('Disk usage prediction failed', err, { module: 'memory-prediction' });
      return { walSizeMB: 0, walGrowthRateMBPerHour: null, screenshotDirSizeMB: 0 };
    }
  }

  /**
   * Recursively get directory size in MB.
   */
  _getDirSize(dirPath: any, seen = new Set()) {
    try {
      const resolved = fs.realpathSync(dirPath);
      if (seen.has(resolved)) return 0;
      seen.add(resolved);
      let totalSize = 0;
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          totalSize += this._getDirSize(fullPath, seen);
        } else if (entry.isFile()) {
          try {
            totalSize += fs.statSync(fullPath).size;
          } catch (e: any) { /* skip */ }
        }
      }
      return totalSize / 1024 / 1024;
    } catch (err: any) {
      return 0;
    }
  }

  /**
   * Perform a graceful restart with cleanup.
   */
  async _gracefulRestart(reason: any) { 
    try {
      log(`Initiating graceful restart: ${reason}`, 'WARN', 'memory-prediction');
      this._lastRestartTime = Date.now();

      this._logSelfHealEvent('memory-prediction', 'preemptive_restart', reason, JSON.stringify({
        currentHeapMB: this._getCurrentHeapMB(),
        thresholdMB: this._thresholdMB,
        historyLength: this.memoryHistory.length,
        diskUsage: this.getDiskUsagePrediction(),
      }));

      // Step 1: Close browser to free memory
      try {
        const { closeBrowser } = require('./browser');
        await closeBrowser();
        log('Browser closed for restart', 'INFO', 'memory-prediction');
      } catch (err: any) {
        logError('Failed to close browser during restart', err, { module: 'memory-prediction' });
      }

      // Step 2: Run GC if available
      if (global.gc) {
        try {
          global.gc();
          const afterGC = this._getCurrentHeapMB();
          log(`GC completed: ${afterGC}MB after collection`, 'INFO', 'memory-prediction');
        } catch (err: any) {
          logError('GC failed during restart', err, { module: 'memory-prediction' });
        }
      }

      // Step 3: Clear caches
      try {
        const { clearCache } = require('./cache');
        if (typeof clearCache === 'function') {
          clearCache();
          log('Cache cleared during restart', 'INFO', 'memory-prediction');
        }
      } catch (err: any) {
        // Cache clear failed, non-critical
      }

      // Step 4: Trigger process restart if memory still high
      const currentMB = this._getCurrentHeapMB();
      if (currentMB >= this._thresholdMB * 0.8) {
        log(`Memory still high after cleanup (${currentMB}MB), scheduling process exit`, 'WARN', 'memory-prediction');
        // Allow a brief window for any in-flight operations
        setTimeout(() => {
          log('Exiting process for restart', 'INFO', 'memory-prediction');
          process.exit(1);
        }, 5000);
      } else {
        log(`Memory reduced to ${currentMB}MB after cleanup, continuing`, 'INFO', 'memory-prediction');
      }
    } catch (err: any) {
      logError('Graceful restart failed', err, { module: 'memory-prediction' });
    }
  }

  /**
   * Start the periodic memory check loop.
   * @param {number} intervalMs - Check interval (default 1 minute)
   */
  start(intervalMs = DEFAULT_CHECK_INTERVAL_MS) { 
    if (this._isRunning) {
      log('Memory predictor already running', 'WARN', 'memory-prediction');
      return;
    }

    this._isRunning = true;
    const safeInterval = Math.max(10000, intervalMs);

    // Record initial memory
    this.recordMemory(this._getCurrentHeapMB());

    this._checkInterval = setInterval(() => {
      this._periodicCheck();
    }, safeInterval);
    if (this._checkInterval && this._checkInterval.unref) this._checkInterval.unref();

    log(`Memory predictor started (interval: ${safeInterval / 1000}s, threshold: ${this._thresholdMB}MB)`, 'INFO', 'memory-prediction');
  }

  /**
   * Periodic check: record memory, predict, potentially restart.
   */
  _periodicCheck() { 
    try {
      const currentMB = this._getCurrentHeapMB();
      this.recordMemory(currentMB);

      // Log every 5 minutes
      const prediction = this.predictTimeToThreshold();
      if (this.memoryHistory.length % 5 === 0) {
        const disk = this.getDiskUsagePrediction();
        log(
          `Memory check: ${currentMB}MB, time to threshold: ${prediction !== null ? prediction + 'min' : 'N/A'}, ` +
          `WAL: ${disk.walSizeMB}MB (growth: ${disk.walGrowthRateMBPerHour !== null ? disk.walGrowthRateMBPerHour + 'MB/hr' : 'N/A'}), ` +
          `screenshots: ${disk.screenshotDirSizeMB}MB`,
          'DEBUG',
          'memory-prediction'
        );
      }

      if (this.shouldPreemptiveRestart()) {
        this._gracefulRestart(
          `Memory trajectory predicts threshold breach. Current: ${currentMB}MB, threshold: ${this._thresholdMB}MB, ` +
          `predicted time to threshold: ${prediction !== null ? prediction + 'min' : 'unknown'}`
        );
      }
    } catch (err: any) {
      logError('Periodic memory check failed', err, { module: 'memory-prediction' });
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
    log('Memory predictor stopped', 'INFO', 'memory-prediction');
  }

  /**
   * Get a summary of the current memory state.
   */
  getSummary() { 
    const currentMB = this._getCurrentHeapMB();
    const prediction = this.predictTimeToThreshold();
    const regression = this._linearRegression();
    const disk = this.getDiskUsagePrediction();

    return {
      currentHeapMB: currentMB,
      thresholdMB: this._thresholdMB,
      dataPoints: this.memoryHistory.length,
      predictedMinutesToThreshold: prediction,
      slope: regression ? Math.round(regression.slope * 1000) / 1000 : null, // MB/min
      rSquared: regression ? Math.round(regression.rSquared * 1000) / 1000 : null,
      diskUsage: disk,
      isRunning: this._isRunning,
      lastRestartTime: this._lastRestartTime || null,
    };
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
      logError('Failed to log memory prediction self-heal event', err, { module: 'memory-prediction' });
    }
  }
}

const memoryPredictor = new MemoryPredictor();

module.exports = { MemoryPredictor, memoryPredictor , _injectDependencies };