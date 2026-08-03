'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);

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
      // Downsample: keep every other element to stay within bounds
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
    const summary = { counters: Object.fromEntries(this.counters), gauges: Object.fromEntries(this.gauges), histograms: {} };
    for (const [key, values] of this.histograms) {
      if (values.length === 0) {
        (summary.histograms as any)[key] = { count: 0, min: 0, max: 0, p50: 0, p95: 0, p99: 0 };
        continue;
      }
      const sorted = [...values].sort((a,b) => a - b);
      const p = (pct: any) => sorted[Math.min(sorted.length - 1, Math.ceil((pct / 100) * sorted.length) - 1)];
      (summary.histograms as any)[key] = { count: values.length, min: sorted[0], max: sorted[sorted.length - 1], p50: p(50), p95: p(95), p99: p(99) };
    }
    return summary;
  }
}

const metrics = new Metrics();

function recordClickDuration(ms: any, style: any) { 
  metrics.recordHistogram('click_duration_ms', ms, { style });
  metrics.increment('clicks_total');
}

module.exports = { metrics, recordClickDuration, _injectDependencies };
