'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getSelectCalibration() { return _deps.database?.selectCalibration; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }
function getUpsertPerformanceProfile() { return _deps.database?.upsertPerformanceProfile; }
function getSelectPerformanceProfile() { return _deps.database?.selectPerformanceProfile; }

const { log } = require('./logger');
const CONFIG = require('./get-config');

class AdaptivePerformanceEngine {
  slowdownFactor: any;

  constructor() {
    this.slowdownFactor = 1.0;
    this.loadProfile();
  }

  loadProfile() { 
    const row = getSelectCalibration()?.get('performance_profile_slowdown');
    if (row) this.slowdownFactor = parseFloat(row.value) || 1.0;
    try {
      const profile = getSelectPerformanceProfile()?.get();
      if (profile && profile.slowdown_factor) { this.slowdownFactor = parseFloat(profile.slowdown_factor) || 1.0; }
    } catch (e: any) { log('Failed to load performance profile', 'DEBUG', 'perf'); }
  }

  recordLatency(latencyMs: any) { 
    const baseline = CONFIG.PERFORMANCE_BASELINE_MS || 500;
    const ratio = latencyMs / baseline;
    this.slowdownFactor = Math.min(Math.max(this.slowdownFactor * (0.9 + ratio * 0.1), 0.5), 3.0);
    getUpsertCalibration()?.run('performance_profile_slowdown', String(this.slowdownFactor), Date.now());
    try { getUpsertPerformanceProfile()?.run(process.env.NODE_ENV || 'production', this.slowdownFactor, Date.now()); } catch (e: any) { log('Failed to save performance profile', 'DEBUG', 'perf'); }
    log(`⚡ Adaptive engine: slowdown = ${this.slowdownFactor.toFixed(2)} (latency: ${latencyMs}ms)`, 'DEBUG', 'perf');
  }

  getAdjustedWait(baseWaitMs: any) { 
    return Math.round(baseWaitMs * this.slowdownFactor);
  }
}

module.exports = Object.assign(new AdaptivePerformanceEngine(), { _injectDependencies });
