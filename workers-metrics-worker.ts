'use strict';

/**
 * Metrics worker thread.
 *
 * Runs the Metrics class in an isolated thread. All counter/histogram/gauge
 * operations happen here, keeping the main thread's event loop clean.
 *
 * No external dependencies (no DB, no config, no filesystem).
 */

const { WorkerBase } = require('./workers-worker-base');
const { METHOD } = require('./workers-message-protocol');

// ─── Metrics implementation (copied from metrics.js, runs in worker) ───

class Metrics {
  counters: any;
  histograms: any;
  gauges: any;
  MAX_HISTOGRAM_SIZE: any;

  constructor() {
    this.counters = new Map();
    this.histograms = new Map();
    this.gauges = new Map();
    this.MAX_HISTOGRAM_SIZE = 10000;
  }

  increment(name: any, value = 1, tags = {}) { 
    const key = this._key(name, tags);
    this.counters.set(key, (this.counters.get(key) || 0) + value);
  }

  recordHistogram(name: any, value: any, tags = {}) { 
    const key = this._key(name, tags);
    if (!this.histograms.has(key)) this.histograms.set(key, []);
    const arr = this.histograms.get(key);
    arr.push(value);
    if (arr.length > this.MAX_HISTOGRAM_SIZE) {
      this.histograms.set(key, arr.filter((_: any, i: any) => i % 2 === 0));
    }
  }

  setGauge(name: any, value: any, tags = {}) { 
    const key = this._key(name, tags);
    this.gauges.set(key, value);
  }

  _key(name: any, tags: any) { 
    const tagStr = Object.keys(tags).sort().map(k => `${k}=${tags[k]}`).join(',');
    return tagStr ? `${name}:${tagStr}` : name;
  }

  getSummary() { 
    const summary = {
      counters: Object.fromEntries(this.counters),
      gauges: Object.fromEntries(this.gauges),
      histograms: {},
    };
    for (const [key, values] of this.histograms) {
      if (values.length === 0) {
        (summary.histograms as any)[key] = { count: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
        continue;
      }
      const sorted = [...values].sort((a, b) => a - b);
      const p = (pct: any) => sorted[Math.floor((pct / 100) * sorted.length)];
      (summary.histograms as any)[key] = {
        count: values.length,
        min: sorted[0],
        max: sorted[sorted.length - 1],
        p50: p(50),
        p95: p(95),
        p99: p(99),
      };
    }
    return summary;
  }
}

// ─── Worker Implementation ───

class MetricsWorker extends WorkerBase {
  counters: any;
  histograms: any;
  gauges: any;
  MAX_HISTOGRAM_SIZE: any;

  constructor() {
    super();
    this._metrics = null;
  }

  _onInit() { 
    this._metrics = new Metrics();

    // Register method handlers
    this._registerMethod(METHOD.METRICS_INCREMENT, (payload: any) => {
      this._metrics.increment(payload.name, payload.value, payload.tags || {});
      return { ok: true };
    });

    this._registerMethod(METHOD.METRICS_HISTOGRAM, (payload: any) => {
      this._metrics.recordHistogram(payload.name, payload.value, payload.tags || {});
      return { ok: true };
    });

    this._registerMethod(METHOD.METRICS_GAUGE, (payload: any) => {
      this._metrics.setGauge(payload.name, payload.value, payload.tags || {});
      return { ok: true };
    });

    this._registerMethod(METHOD.METRICS_GET_SUMMARY, () => {
      return this._metrics.getSummary();
    });
  }

  _healthCheck() { 
    const base = super._healthCheck();
    return {
      ...base,
      countersCount: this._metrics ? this._metrics.counters.size : 0,
      histogramsCount: this._metrics ? this._metrics.histograms.size : 0,
      gaugesCount: this._metrics ? this._metrics.gauges.size : 0,
    };
  }
}

// ─── Entry Point ───
new MetricsWorker().run();