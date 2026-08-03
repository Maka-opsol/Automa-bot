'use strict';

/**
 * Main-thread proxy for the metrics worker.
 *
 * Provides the same API surface as the original `metrics.js` module,
 * but delegates all operations to the worker thread via WorkerManager.
 *
 * Fire-and-forget operations (increment, histogram, gauge) use cast()
 * to avoid request/reply overhead on the hot path.
 * Read operations (getSummary) use request().
 */

const { workerManager } = require('./workers-worker-manager');
const { METHOD } = require('./workers-message-protocol');

interface MetricsProxy {
  increment(name: string, value?: number, tags?: Record<string, unknown>): void;
  recordHistogram(name: string, value: number, tags?: Record<string, unknown>): void;
  setGauge(name: string, value: number, tags?: Record<string, unknown>): void;
  getSummary(): Promise<Record<string, unknown> | undefined>;
}

/**
 * Create a metrics proxy object.
 * @param workerName - Name the worker was spawned with (default: 'metrics')
 */
function createMetricsProxy(workerName: string = 'metrics'): MetricsProxy {
  return {
    /**
     * Increment a counter (fire-and-forget for zero latency on hot path).
     */
    increment(name: string, value: number = 1, tags: Record<string, unknown> = {}): void {
      workerManager.cast(workerName, METHOD.METRICS_INCREMENT, { name, value, tags });
    },

    /**
     * Record a histogram value (fire-and-forget).
     */
    recordHistogram(name: string, value: number, tags: Record<string, unknown> = {}): void {
      workerManager.cast(workerName, METHOD.METRICS_HISTOGRAM, { name, value, tags });
    },

    /**
     * Set a gauge value (fire-and-forget).
     */
    setGauge(name: string, value: number, tags: Record<string, unknown> = {}): void {
      workerManager.cast(workerName, METHOD.METRICS_GAUGE, { name, value, tags });
    },

    /**
     * Get metrics summary (request/reply — awaits worker response).
     */
    async getSummary(): Promise<Record<string, unknown> | undefined> {
      return workerManager.request(workerName, METHOD.METRICS_GET_SUMMARY);
    },
  };
}

/**
 * Convenience: record click duration.
 */
function recordClickDuration(ms: number, style: string): void {
  workerManager.cast('metrics', METHOD.METRICS_HISTOGRAM, {
    name: 'click_duration_ms',
    value: ms,
    tags: { style },
  });
  workerManager.cast('metrics', METHOD.METRICS_INCREMENT, {
    name: 'clicks_total',
    value: 1,
  });
}

module.exports = { createMetricsProxy, recordClickDuration };