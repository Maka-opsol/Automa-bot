'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }
function getInsertSelfHealEvent() { return _deps.database?.insertSelfHealEvent; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }
function getSelectCalibration() { return _deps.database?.selectCalibration; }

const CONFIG = require('./get-config');

const MAX_BASELINE_SNAPSHOTS = 168; // 7 days * 24 hours
const BASELINE_PERSIST_KEY = 'structural_drift_baseline';
const DEFAULT_DRIFT_THRESHOLD = 0.3;
const CLASS_HISTOGRAM_TOP_N = 20;

class StructuralDriftFingerprinter {
  baseline: any;
  latestDriftScore: any;
  latestFingerprint: any;
  _networkEndpoints: any;
  _networkResponseSizes: any;
  loadEventEnd: any;
  domComplete: any;
  domLoading: any;
  domInteractive: any;

  constructor() {
    this.baseline = [];
    this.latestDriftScore = null;
    this.latestFingerprint = null;
    this._networkEndpoints = new Set();
    this._networkResponseSizes = [];
  }

  /**
   * Capture a platform-level fingerprint from a Playwright page.
   * Collects DOM metrics, network patterns, and timing information.
   * @param {import('playwright').Page} page
   * @returns {Promise<Object>} fingerprint object
   */
  async captureFingerprint(page: any) { 
    try {
      const fingerprint = {
        timestamp: Date.now(),
        url: page.url(),
        dom: await this._captureDomMetrics(page),
        network: await this._captureNetworkMetrics(page),
        timing: await this._captureTimingMetrics(page),
      };

      this.latestFingerprint = fingerprint;
      log(`Fingerprint captured: ${fingerprint.dom.nodeCount} nodes, depth ${fingerprint.dom.maxNestingDepth}`, 'DEBUG', 'structural-drift');
      return fingerprint;
    } catch (err: any) {
      logError('Failed to capture fingerprint', err, { module: 'structural-drift' });
      return null;
    }
  }

  /**
   * Capture DOM metrics from the page.
   */
  async _captureDomMetrics(page: any) { 
    try {
      return await page.evaluate((topN: any) => {
        const allElements = document.querySelectorAll('*');
        const nodeCount = allElements.length;

        // Compute max nesting depth
        let maxDepth = 0;
        const MAX_MEASURE_DEPTH = 200;
        function measureDepth(el: any, depth: any) { 
          if (depth > MAX_MEASURE_DEPTH) return;
          if (depth > maxDepth) maxDepth = depth;
          for (const child of el.children) {
            measureDepth(child, depth + 1);
          }
        }
        measureDepth(document.documentElement, 0);

        // Build class name histogram
        const classCounts = new Map();
        for (const el of allElements) {
          if (el.classList) {
            for (const cls of el.classList) {
              classCounts.set(cls, (classCounts.get(cls) || 0) + 1);
            }
          }
        }
        const topClasses = [...classCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, topN)
          .map(([name, count]) => ({ name, count }));

        // Tag name distribution
        const tagCounts = new Map();
        for (const el of allElements) {
          const tag = el.tagName.toLowerCase();
          tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
        }
        const topTags = [...tagCounts.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 15)
          .map(([name, count]) => ({ name, count }));

        return {
          nodeCount,
          maxNestingDepth: maxDepth,
          classHistogram: topClasses,
          tagDistribution: topTags,
          uniqueClassCount: classCounts.size,
          uniqueTagCount: tagCounts.size,
        };
      }, CLASS_HISTOGRAM_TOP_N);
    } catch (err: any) {
      logError('Failed to capture DOM metrics', err, { module: 'structural-drift' });
      return { nodeCount: 0, maxNestingDepth: 0, classHistogram: [], tagDistribution: [], uniqueClassCount: 0, uniqueTagCount: 0 };
    }
  }

  /**
   * Capture network metrics by reading from the DB network_intercept_log.
   */
  async _captureNetworkMetrics(_page: any) { 
    try {
      const oneHourAgo = Date.now() - 3600000;
      const recentNetwork = getDb()?.prepare(`
        SELECT url, method FROM network_intercept_log
        WHERE timestamp > ?
        ORDER BY timestamp DESC
        LIMIT 200
      `).all(oneHourAgo);

      const endpointPaths = new Set();
      for (const entry of recentNetwork) {
        try {
          const url = new URL(entry.url);
          const path = url.pathname;
          // Normalize path by removing numeric IDs
          const normalized = path.replace(/\/(?!v\d+$)\d+(?=\/|$)/g, '/:id');
          endpointPaths.add(`${entry.method || 'GET'} ${normalized}`);
        } catch (e: any) {
          // Skip malformed URLs
        }
      }

      // Response size ranges from network log headers
      const responseSizes = [];
      for (const entry of recentNetwork) {
        try {
          if (entry.headers) {
            const headers = JSON.parse(entry.headers);
            const cl = headers['content-length'] || headers['Content-Length'];
            if (cl) {
              const size = parseInt(cl, 10);
              if (size > 0) responseSizes.push(size);
            }
          }
        } catch (e: any) {
          // Skip malformed headers
        }
      }

      const sizes = responseSizes.length > 0 ? {
        min: Math.min(...responseSizes),
        max: Math.max(...responseSizes),
        avg: Math.round(responseSizes.reduce((a, b) => a + b, 0) / responseSizes.length),
      } : { min: 0, max: 0, avg: 0 };

      return {
        uniqueEndpoints: [...endpointPaths].sort(),
        endpointCount: endpointPaths.size,
        responseSizeRanges: sizes,
      };
    } catch (err: any) {
      logError('Failed to capture network metrics', err, { module: 'structural-drift' });
      return { uniqueEndpoints: [], endpointCount: 0, responseSizeRanges: { min: 0, max: 0, avg: 0 } };
    }
  }

  /**
   * Capture timing metrics from the page using Performance API.
   */
  async _captureTimingMetrics(page: any) { 
    try {
      const timing = await page.evaluate(() => {
        const nav = performance.getEntriesByType('navigation' as any)[0];
        if (!nav) {
          return { pageLoadTimeMs: null, renderLatencyMs: null, timeToInteractiveMs: null };
        }
        return {
          pageLoadTimeMs: Math.round((nav as any).loadEventEnd - nav.startTime),
          renderLatencyMs: Math.round((nav as any).domComplete - (nav as any).domLoading),
// @ts-expect-error
          timeToInteractiveMs: Math.round(nav.domInteractive - nav.startTime),
        };
      });
      return timing;
    } catch (err: any) {
      logError('Failed to capture timing metrics', err, { module: 'structural-drift' });
      return { pageLoadTimeMs: null, renderLatencyMs: null, timeToInteractiveMs: null };
    }
  }

  /**
   * Add a fingerprint to the rolling baseline window.
   * @param {Object} fingerprint - fingerprint from captureFingerprint()
   */
  updateBaseline(fingerprint: any) { 
    try {
      if (!fingerprint) return;

      const snapshot = {
        timestamp: fingerprint.timestamp || Date.now(),
        dom: { ...fingerprint.dom },
        network: { ...fingerprint.network },
        timing: { ...fingerprint.timing },
      };

      this.baseline.push(snapshot);

      // Maintain rolling window of 168 hourly snapshots
      if (this.baseline.length > MAX_BASELINE_SNAPSHOTS) {
        this.baseline.shift();
      }

      // Persist baseline to DB
      this._persistBaseline();

      log(`Baseline updated: ${this.baseline.length}/${MAX_BASELINE_SNAPSHOTS} snapshots`, 'DEBUG', 'structural-drift');
    } catch (err: any) {
      logError('Failed to update baseline', err, { module: 'structural-drift' });
    }
  }

  /**
   * Persist baseline to the calibration table as JSON.
   */
  _persistBaseline() { 
    try {
      // Persist a compact version to avoid bloating the calibration table
      const compact = this.baseline.map((s: any) => ({
        ts: s.timestamp,
        nc: s.dom.nodeCount,
        md: s.dom.maxNestingDepth,
        uc: s.dom.uniqueClassCount,
        ut: s.dom.uniqueTagCount,
        ec: s.network.endpointCount,
        plt: s.timing.pageLoadTimeMs,
        rl: s.timing.renderLatencyMs,
        tti: s.timing.timeToInteractiveMs,
      }));
      getUpsertCalibration()?.run(BASELINE_PERSIST_KEY, JSON.stringify(compact), Date.now());
    } catch (err: any) {
      logError('Failed to persist structural drift baseline', err, { module: 'structural-drift' });
    }
  }

  /**
   * Load baseline from the calibration table.
   */
  _loadBaselineFromDB() { 
    try {
      const row = getSelectCalibration()?.get(BASELINE_PERSIST_KEY);
      if (!row || !row.value) return;

      const compact = JSON.parse(row.value);
      if (!Array.isArray(compact)) return;

      // Only load if in-memory baseline is empty
      if (this.baseline.length === 0) {
        this.baseline = compact.map(c => ({
          timestamp: c.ts,
          dom: { nodeCount: c.nc, maxNestingDepth: c.md, uniqueClassCount: c.uc, uniqueTagCount: c.ut, classHistogram: [], tagDistribution: [] },
          network: { endpointCount: c.ec, uniqueEndpoints: [], responseSizeRanges: { min: 0, max: 0, avg: 0 } },
          timing: { pageLoadTimeMs: c.plt, renderLatencyMs: c.rl, timeToInteractiveMs: c.tti },
        }));
        log(`Loaded ${this.baseline.length} baseline snapshots from DB`, 'INFO', 'structural-drift');
      }
    } catch (err: any) {
      logError('Failed to load structural drift baseline from DB', err, { module: 'structural-drift' });
    }
  }

  /**
   * Compute a drift score between 0 and 1 by comparing current fingerprint against the baseline.
   * Higher score = more drift.
   * @param {Object} currentFingerprint - fingerprint from captureFingerprint()
   * @returns {number} drift score between 0 and 1
   */
  computeDriftScore(currentFingerprint: any) { 
    try {
      if (!currentFingerprint) return 0;
      if (this.baseline.length < 3) {
        // Not enough baseline data yet - check() handles baseline update
        return 0;
      }

      const scores = [];

      // 1. Node count drift
      const nodeCounts = this.baseline.map((b: any) => b.dom.nodeCount).filter((n: any) => n > 0);
      if (nodeCounts.length > 0) {
        const avgNodes = nodeCounts.reduce((a: any, b: any) => a + b, 0) / nodeCounts.length;
        const stdNodes = Math.sqrt(nodeCounts.reduce((a: any, b: any) => a + Math.pow(b - avgNodes, 2), 0) / nodeCounts.length) || 1;
        const currentNodes = currentFingerprint.dom.nodeCount || 0;
        const nodeZ = Math.abs(currentNodes - avgNodes) / stdNodes;
        scores.push(Math.min(1, nodeZ / 5)); // Cap at z=5
      }

      // 2. Max nesting depth drift
      const depths = this.baseline.map((b: any) => b.dom.maxNestingDepth).filter((d: any) => d > 0);
      if (depths.length > 0) {
        const avgDepth = depths.reduce((a: any, b: any) => a + b, 0) / depths.length;
        const currentDepth = currentFingerprint.dom.maxNestingDepth || 0;
        const depthRatio = Math.abs(currentDepth - avgDepth) / (avgDepth || 1);
        scores.push(Math.min(1, depthRatio));
      }

      // 3. Unique class count drift
      const classCounts = this.baseline.map((b: any) => b.dom.uniqueClassCount).filter((c: any) => c > 0);
      if (classCounts.length > 0) {
        const avgClasses = classCounts.reduce((a: any, b: any) => a + b, 0) / classCounts.length;
        const currentClasses = currentFingerprint.dom.uniqueClassCount || 0;
        const classRatio = Math.abs(currentClasses - avgClasses) / (avgClasses || 1);
        scores.push(Math.min(1, classRatio));
      }

      // 4. Endpoint count drift
      const endpointCounts = this.baseline.map((b: any) => b.network.endpointCount).filter((c: any) => c > 0);
      if (endpointCounts.length > 0) {
        const avgEndpoints = endpointCounts.reduce((a: any, b: any) => a + b, 0) / endpointCounts.length;
        const currentEndpoints = currentFingerprint.network.endpointCount || 0;
        const endpointRatio = Math.abs(currentEndpoints - avgEndpoints) / (avgEndpoints || 1);
        scores.push(Math.min(1, endpointRatio));
      }

      // 5. Page load time drift
      const loadTimes = this.baseline.map((b: any) => b.timing.pageLoadTimeMs).filter((t: any) => t != null && t > 0);
      if (loadTimes.length > 0) {
        const avgLoad = loadTimes.reduce((a: any, b: any) => a + b, 0) / loadTimes.length;
        const stdLoad = Math.sqrt(loadTimes.reduce((a: any, b: any) => a + Math.pow(b - avgLoad, 2), 0) / loadTimes.length) || 1;
        const currentLoad = currentFingerprint.timing.pageLoadTimeMs || 0;
        const loadZ = Math.abs(currentLoad - avgLoad) / stdLoad;
        scores.push(Math.min(1, loadZ / 5));
      }

      // Weighted average of all available scores
      if (scores.length === 0) return 0;
      const avgScore = scores.reduce((a, b) => a + b, 0) / scores.length;
      this.latestDriftScore = avgScore;

      return avgScore;
    } catch (err: any) {
      logError('Failed to compute drift score', err, { module: 'structural-drift' });
      return 0;
    }
  }

  /**
   * Check if structural drift exceeds the given threshold.
   * @param {number} threshold - drift score threshold (default 0.3)
   * @returns {boolean} true if drifted beyond threshold
   */
  isDrifted(threshold = DEFAULT_DRIFT_THRESHOLD) { 
    try {
      if (this.latestDriftScore === null) return false;
      const drifted = this.latestDriftScore > threshold;

      if (drifted) {
        log(`Structural drift detected: score ${this.latestDriftScore.toFixed(3)} > threshold ${threshold}`, 'WARN', 'structural-drift');
        this._logDriftEvent(threshold);
        this._triggerInvestigation();
      }

      return drifted;
    } catch (err: any) {
      logError('isDrifted check failed', err, { module: 'structural-drift' });
      return false;
    }
  }

  /**
   * Log a drift event to self_heal_events.
   */
  _logDriftEvent(threshold: any) { 
    try {
      getInsertSelfHealEvent()?.run(
        Date.now(),
        'structural-drift',
        'drift_detected',
        `Drift score ${this.latestDriftScore?.toFixed(3)} > threshold ${threshold}`,
        this.latestFingerprint ? JSON.stringify({
          nodeCount: this.latestFingerprint.dom.nodeCount,
          maxDepth: this.latestFingerprint.dom.maxNestingDepth,
          uniqueClasses: this.latestFingerprint.dom.uniqueClassCount,
          endpointCount: this.latestFingerprint.network.endpointCount,
        }) : null,
        0, 0, 0,
        'investigation_triggered',
        0,
        null
      );
    } catch (err: any) {
      logError('Failed to log structural drift event', err, { module: 'structural-drift' });
    }
  }

  /**
   * Trigger investigation when drift is detected.
   */
  _triggerInvestigation() { 
    try {
      // Trigger the self-heal investigation flow
      const { performSelfHeal } = require('./self-heal');
      performSelfHeal().catch((err: any) => { 
        logError('Structural drift investigation failed', err, { module: 'structural-drift' });
      });
    } catch (err: any) {
      logError('Failed to trigger investigation for structural drift', err, { module: 'structural-drift' });
    }
  }

  /**
   * Full check: capture fingerprint, compute drift, update baseline, return result.
   * @param {import('playwright').Page} page
   * @param {number} threshold - drift threshold
   * @returns {Promise<{ driftScore: number, isDrifted: boolean, fingerprint: Object }>}
   */
  async check(page: any, threshold = DEFAULT_DRIFT_THRESHOLD) { 
    try {
      // Load baseline from DB if empty
      if (this.baseline.length === 0) {
        this._loadBaselineFromDB();
      }

      const fingerprint = await this.captureFingerprint(page);
      if (!fingerprint) {
        return { driftScore: 0, isDrifted: false, fingerprint: null };
      }

      const driftScore = this.computeDriftScore(fingerprint);
      this.updateBaseline(fingerprint);
      const drifted = this.isDrifted(threshold);

      return { driftScore, isDrifted: drifted, fingerprint };
    } catch (err: any) {
      logError('Structural drift check failed', err, { module: 'structural-drift' });
      return { driftScore: 0, isDrifted: false, fingerprint: null };
    }
  }

  /**
   * Start periodic baseline collection.
   * @param {number} intervalMs - How often to capture a new baseline snapshot
   */
  startBaselineCollection(intervalMs: number) {
    log(`Starting baseline collection every ${Math.round(intervalMs / 60000)}min`, 'INFO', 'structural-drift');
    // Load existing baseline from DB on first start
    this._loadBaselineFromDB();
  }

  /**
   * Get the current baseline summary.
   */
  getBaselineSummary() { 
    if (this.baseline.length === 0) return { snapshotCount: 0 };

    const avg = (arr: any) => arr.length > 0 ? arr.reduce((a: any, b: any) => a + b, 0) / arr.length : 0;
    const nodeCounts = this.baseline.map((b: any) => b.dom.nodeCount);
    const depths = this.baseline.map((b: any) => b.dom.maxNestingDepth);
    const classCounts = this.baseline.map((b: any) => b.dom.uniqueClassCount);
    const loadTimes = this.baseline.map((b: any) => b.timing.pageLoadTimeMs).filter((t: any) => t != null);

    return {
      snapshotCount: this.baseline.length,
      oldestTimestamp: this.baseline[0]?.timestamp,
      newestTimestamp: this.baseline[this.baseline.length - 1]?.timestamp,
      avgNodeCount: Math.round(avg(nodeCounts)),
      avgMaxDepth: Math.round(avg(depths)),
      avgUniqueClasses: Math.round(avg(classCounts)),
      avgPageLoadTimeMs: loadTimes.length > 0 ? Math.round(avg(loadTimes)) : null,
      latestDriftScore: this.latestDriftScore,
    };
  }
}

const structuralDriftFingerprinter = new StructuralDriftFingerprinter();

module.exports = { StructuralDriftFingerprinter, structuralDriftFingerprinter , _injectDependencies };