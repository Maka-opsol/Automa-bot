'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const CONFIG = require('./get-config');

const VALID_PHASES = new Set([
  'triggered',
  'investigating',
  'generating_patches',
  'auditing',
  'staging',
  'testing',
  'promoting',
  'rolled_back',
  'completed',
  'failed',
]);

const VALID_FEATURES = new Set([
  'A1-predictive',
  'A2-canary',
  'B2-canary',
  'C1-db-healer',
  'D1-blackbox-replay',
  'D2-patch-memory',
  'D3-reward-tracker',
  'D4-timeline',
]);

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours
const PRUNE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days
const MIN_KEEP_EVENTS = 1000;

class SelfHealTimeline {
  _intervalHandle: any;
  triggerReason: any;
  investigationResult: any;
  patchesGenerated: any;
  patchesSafe: any;
  patchesApplied: any;
  outcome: any;
  durationMs: any;
  error: any;
  substring: any;

  constructor() {
    this._intervalHandle = null;
  }

  /**
   * Logs a self-heal event.
   * @param {string} featureId - e.g. 'A1-predictive', 'B2-canary', 'C1-db-healer'
   * @param {string} phase - One of the valid phases
   * @param {object} data - Event metadata
   * @returns {boolean}
   */
  logEvent(featureId: any, phase: any, data: any = {}) { 
    try {
      if (!featureId || typeof featureId !== 'string') {
        log('logEvent: invalid featureId', 'WARN', 'timeline');
        return false;
      }
      if (!VALID_PHASES.has(phase)) {
        log(`logEvent: invalid phase "${phase}"`, 'WARN', 'timeline');
        return false;
      }

      const timestamp = Date.now();

      // Sanitize and serialize data
      let safeData = {} as any;
      try {
        const {
          triggerReason,
          investigationResult,
          patchesGenerated,
          patchesSafe,
          patchesApplied,
          outcome,
          durationMs,
          error,
          ...rest
        } = data || {};

        safeData = {
          triggerReason: typeof triggerReason === 'string' ? triggerReason.substring(0, 2000) : undefined,
          investigationResult: typeof investigationResult === 'string' ? investigationResult.substring(0, 5000) : undefined,
          patchesGenerated: typeof patchesGenerated === 'number' ? patchesGenerated : undefined,
          patchesSafe: typeof patchesSafe === 'number' ? patchesSafe : undefined,
          patchesApplied: typeof patchesApplied === 'number' ? patchesApplied : undefined,
          outcome: typeof outcome === 'string' ? outcome.substring(0, 500) : undefined,
          durationMs: typeof durationMs === 'number' ? durationMs : undefined,
          error: typeof error === 'string' ? error.substring(0, 2000) : undefined,
        };

        // Include any extra fields (truncated)
        for (const [key, val] of Object.entries(rest)) {
          if (typeof val === 'string') {
            (safeData as any)[key] = val.substring(0, 1000);
          } else if (typeof val === 'number' || typeof val === 'boolean') {
            (safeData as any)[key] = val;
          }
        }
      } catch (dataErr: any) {
        log('Failed to sanitize event data, using empty object', 'WARN', 'timeline');
      }

      const insertStmt = getDb()?.prepare(`
        INSERT INTO self_heal_events (feature_id, phase, timestamp, trigger_reason, investigation_result, patches_generated, patches_safe, patches_applied, outcome, duration_ms, error)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        featureId.substring(0, 100),
        phase,
        timestamp,
        safeData.triggerReason || null,
        safeData.investigationResult || null,
        safeData.patchesGenerated || 0,
        safeData.patchesSafe || 0,
        safeData.patchesApplied || 0,
        safeData.outcome || null,
        safeData.durationMs || null,
        safeData.error || null
      );

      log(`Timeline event: feature=${featureId}, phase=${phase}`, 'DEBUG', 'timeline');
      return true;
    } catch (err: any) {
      logError('logEvent failed', err, { module: 'timeline' });
      return false;
    }
  }

  /**
   * Returns recent timeline events, optionally filtered by feature.
   * @param {number} limit
   * @param {string|null} featureFilter
   * @returns {Array}
   */
  getTimeline(limit = 50, featureFilter = null) { 
    try {
      const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
      let rows;

      if (featureFilter && typeof featureFilter === 'string') {
        rows = getDb()?.prepare(`
          SELECT * FROM self_heal_events
          WHERE feature_id = ?
          ORDER BY timestamp DESC
          LIMIT ?
        `).all((featureFilter as any).substring(0, 100), safeLimit);
      } else {
        rows = getDb()?.prepare(`
          SELECT * FROM self_heal_events
          ORDER BY timestamp DESC
          LIMIT ?
        `).all(safeLimit);
      }

      // Build data object from individual columns
      return rows.map((row: any) => ({
        id: row.id,
        featureId: row.feature_id,
        phase: row.phase,
        timestamp: row.timestamp,
        data: {
          triggerReason: row.trigger_reason,
          investigationResult: row.investigation_result,
          patchesGenerated: row.patches_generated,
          patchesSafe: row.patches_safe,
          patchesApplied: row.patches_applied,
          outcome: row.outcome,
          durationMs: row.duration_ms,
          error: row.error,
        },
      }));
    } catch (err: any) {
      logError('getTimeline failed', err, { module: 'timeline' });
      return [];
    }
  }

  /**
   * Aggregates events for a specific feature since a timestamp.
   * @param {string} featureId
   * @param {number} sinceMs - Timestamp (epoch ms) to look back from
   * @returns {object} { totalAttempts, successes, failures, avgDurationMs, lastOutcome }
   */
  getFeatureSummary(featureId: any, sinceMs: any) { 
    try {
      if (!featureId || typeof featureId !== 'string') {
        log('getFeatureSummary: invalid featureId', 'WARN', 'timeline');
        return { totalAttempts: 0, successes: 0, failures: 0, avgDurationMs: 0, lastOutcome: null };
      }

      const safeSince = typeof sinceMs === 'number' ? sinceMs : (Date.now() - 7 * 24 * 60 * 60 * 1000);

      const rows = getDb()?.prepare(`
        SELECT * FROM self_heal_events
        WHERE feature_id = ? AND timestamp >= ?
        ORDER BY timestamp ASC
      `).all(featureId.substring(0, 100), safeSince);

      const totalAttempts = new Set(rows.filter((r: any) => r.phase === 'triggered').map((r: any) => r.id)).size;
      const successes = rows.filter((r: any) => r.phase === 'completed').length;
      const failures = rows.filter((r: any) => r.phase === 'failed').length;

      // Average duration: compute from triggered -> completed/failed pairs
      const triggeredMap = {};
      const durations = [];
      let lastOutcome = null;

      for (const row of rows) {
        if (row.phase === 'triggered') {
          (triggeredMap as any)[row.id] = row.timestamp;
        }
        if (row.phase === 'completed' || row.phase === 'failed') {
          // Find the most recent trigger before this event
          const triggers = Object.entries(triggeredMap)
            .filter(([, ts]: any) => ts <= row.timestamp)
            .sort((a: any, b: any) => (b as any)[1] - (a as any)[1]);

          if (triggers.length > 0) {
            durations.push(row.timestamp - (triggers[0] as any)[1]);
            delete (triggeredMap as any)[triggers[0][0]];
          }

          lastOutcome = row.outcome || row.phase;
        }
      }

      const avgDurationMs = durations.length > 0
        ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
        : 0;

      return {
        totalAttempts,
        successes,
        failures,
        avgDurationMs,
        lastOutcome,
      };
    } catch (err: any) {
      logError('getFeatureSummary failed', err, { module: 'timeline' });
      return { totalAttempts: 0, successes: 0, failures: 0, avgDurationMs: 0, lastOutcome: null };
    }
  }

  /**
   * Returns all in-progress heals (phase not 'completed' or 'failed').
   * @returns {Array}
   */
  getActiveHeals() { 
    try {
      const rows = getDb()?.prepare(`
        SELECT * FROM self_heal_events
        WHERE phase NOT IN ('completed', 'failed')
          AND id IN (
            SELECT MAX(id) FROM self_heal_events GROUP BY feature_id
          )
        ORDER BY timestamp DESC
      `).all();

      return rows.map((row: any) => ({
        id: row.id,
        featureId: row.feature_id,
        phase: row.phase,
        timestamp: row.timestamp,
        data: {
          triggerReason: row.trigger_reason,
          investigationResult: row.investigation_result,
          patchesGenerated: row.patches_generated,
          patchesSafe: row.patches_safe,
          patchesApplied: row.patches_applied,
          outcome: row.outcome,
          durationMs: row.duration_ms,
          error: row.error,
        },
      }));
    } catch (err: any) {
      logError('getActiveHeals failed', err, { module: 'timeline' });
      return [];
    }
  }

  /**
   * Formats events for the /api/self-heal/timeline endpoint.
   * @param {Array} events - Raw events from getTimeline()
   * @returns {Array} Formatted events
   */
  formatTimelineForAPI(events: any) { 
    try {
      if (!Array.isArray(events)) return [];

      return events.map(event => {
        let parsedData = event.data || {};
        if (typeof parsedData === 'string') {
          try { parsedData = JSON.parse(parsedData); } catch (e: any) { parsedData = {}; }
        }

        return {
          id: event.id,
          timestamp: event.timestamp,
          feature: event.featureId,
          phase: event.phase,
          triggerReason: parsedData.triggerReason || null,
          outcome: parsedData.outcome || null,
          durationMs: parsedData.durationMs || null,
        };
      });
    } catch (err: any) {
      logError('formatTimelineForAPI failed', err, { module: 'timeline' });
      return [];
    }
  }

  /**
   * Returns overall self-heal statistics.
   * @returns {object}
   */
  getStats() { 
    try {
      const total = getDb()?.prepare('SELECT COUNT(*) as c FROM self_heal_events').get().c;
      const completed = getDb()?.prepare("SELECT COUNT(*) as c FROM self_heal_events WHERE phase = 'completed'").get().c;
      const failed = getDb()?.prepare("SELECT COUNT(*) as c FROM self_heal_events WHERE phase = 'failed'").get().c;
      const triggered = getDb()?.prepare("SELECT COUNT(DISTINCT id) as c FROM self_heal_events WHERE phase = 'triggered'").get().c;

      const successRate = triggered > 0
        ? Math.round((completed / triggered) * 100) / 100
        : 0;

      // Most active feature
      const mostActive = getDb()?.prepare(`
        SELECT feature_id, COUNT(*) as cnt
        FROM self_heal_events
        GROUP BY feature_id
        ORDER BY cnt DESC
        LIMIT 1
      `).get();

      // Average duration: simple approach using duration_ms column directly
      const avgRow = getDb()?.prepare(`
        SELECT AVG(duration_ms) as avg_d FROM self_heal_events
        WHERE phase IN ('completed', 'failed') AND duration_ms IS NOT NULL AND duration_ms > 0
      `).get();

      const averageDuration = avgRow && avgRow.avg_d ? Math.round(avgRow.avg_d) : 0;

      return {
        totalEvents: total,
        totalHealsTriggered: triggered,
        totalCompleted: completed,
        totalFailed: failed,
        successRate,
        mostActiveFeature: mostActive ? mostActive.feature_id : null,
        averageDurationMs: averageDuration,
      };
    } catch (err: any) {
      logError('getStats failed', err, { module: 'timeline' });
      return {
        totalEvents: 0,
        totalHealsTriggered: 0,
        totalCompleted: 0,
        totalFailed: 0,
        successRate: 0,
        mostActiveFeature: null,
        averageDurationMs: 0,
      };
    }
  }

  /**
   * Starts periodic cleanup of old events.
   * Prunes events older than 90 days, keeping at least 1000 most recent.
   * @param {number} intervalMs
   */
  startCleanup(intervalMs = CLEANUP_INTERVAL_MS) { 
    if (this._intervalHandle) {
      log('Timeline cleanup already running', 'DEBUG', 'timeline');
      return;
    }

    log(`Starting timeline cleanup (interval=${Math.round(intervalMs / (60 * 60 * 1000))}h)`, 'INFO', 'timeline');

    const runCleanup = () => {
      try {
        this._pruneOldEvents();
      } catch (err: any) {
        logError('Timeline cleanup iteration failed', err, { module: 'timeline' });
      }
    };

    runCleanup();

    this._intervalHandle = setInterval(runCleanup, intervalMs);
    if (this._intervalHandle.unref) {
      this._intervalHandle.unref();
    }
  }

  /**
   * Internal: prunes events older than 90 days, keeping at least MIN_KEEP_EVENTS.
   */
  _pruneOldEvents() { 
    try {
      const cutoff = Date.now() - PRUNE_MAX_AGE_MS;
      const totalCount = getDb()?.prepare('SELECT COUNT(*) as c FROM self_heal_events').get().c;

      if (totalCount <= MIN_KEEP_EVENTS) {
        return;
      }

      // Delete events older than 90 days, but keep at least MIN_KEEP_EVENTS
      const deleteStmt = getDb()?.prepare(`
        DELETE FROM self_heal_events
        WHERE timestamp < ?
          AND id NOT IN (
            SELECT id FROM self_heal_events
            ORDER BY timestamp DESC
            LIMIT ?
          )
      `);

      const result = deleteStmt.run(cutoff, MIN_KEEP_EVENTS);

      if (result.changes > 0) {
        log(`Pruned ${result.changes} old self_heal_events (older than 90 days)`, 'INFO', 'timeline');
      }
    } catch (err: any) {
      logError('_pruneOldEvents failed', err, { module: 'timeline' });
    }
  }

  /**
   * Stops the periodic cleanup.
   */
  stop() { 
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
      log('Stopped timeline cleanup', 'INFO', 'timeline');
    }
  }
}

module.exports = Object.assign(new SelfHealTimeline(), { _injectDependencies });