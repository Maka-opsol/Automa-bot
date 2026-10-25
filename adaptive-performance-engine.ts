'use strict';
// adaptive-performance-engine.ts — v2 (dashboard patch upgrade)
// Adds EMA smoothing, a latency sample ring buffer, getStats()/reset(),
// and CONFIG-driven bounds so the slowdown factor is observable and
// stable instead of reacting to single-sample latency spikes.
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getSelectCalibration() { return _deps.database?.selectCalibration; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }
function getUpsertPerformanceProfile() { return _deps.database?.upsertPerformanceProfile; }
function getSelectPerformanceProfile() { return _deps.database?.selectPerformanceProfile; }

const { log } = require('./logger');
const CONFIG = require('./get-config');

// EMA weight for new latency samples: 0 < alpha <= 1.
// Smaller alpha => smoother (slower to react). Defaults to 0.3.
const EMA_ALPHA = Number(CONFIG.PERFORMANCE_EMA_ALPHA ?? 0.3);
// Hard clamps for the slowdown factor.
const MIN_SLOWDOWN = Number(CONFIG.PERFORMANCE_MIN_SLOWDOWN ?? 0.5);
const MAX_SLOWDOWN = Number(CONFIG.PERFORMANCE_MAX_SLOWDOWN ?? 3.0);
// How many recent latency samples to retain for stats.
const SAMPLE_WINDOW = Number(CONFIG.PERFORMANCE_SAMPLE_WINDOW ?? 32);

class AdaptivePerformanceEngine {
  slowdownFactor: any;
  private latencySamples: number[] = [];
  private lastLatencyMs: number | null = null;
  private lastUpdatedAt: number | null = null;

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
    this.slowdownFactor = this.clamp(this.slowdownFactor);
  }

  private clamp(value: number): number {
    return Math.min(Math.max(value, MIN_SLOWDOWN), MAX_SLOWDOWN);
  }

  private pushSample(latencyMs: number) {
    this.latencySamples.push(latencyMs);
    if (this.latencySamples.length > SAMPLE_WINDOW) this.latencySamples.shift();
  }

  recordLatency(latencyMs: any) {
    const latency = Number(latencyMs) || 0;
    this.lastLatencyMs = latency;
    this.lastUpdatedAt = Date.now();
    this.pushSample(latency);

    const baseline = CONFIG.PERFORMANCE_BASELINE_MS || 500;
    const ratio = latency / baseline;
    // EMA-smoothed target slowdown so a single spike no longer yanks the factor.
    const target = this.clamp(this.slowdownFactor * (0.9 + ratio * 0.1));
    this.slowdownFactor = this.clamp(
      this.slowdownFactor + EMA_ALPHA * (target - this.slowdownFactor)
    );

    getUpsertCalibration()?.run('performance_profile_slowdown', String(this.slowdownFactor), Date.now());
    try { getUpsertPerformanceProfile()?.run(process.env.NODE_ENV || 'production', this.slowdownFactor, Date.now()); } catch (e: any) { log('Failed to save performance profile', 'DEBUG', 'perf'); }
    log(`⚡ Adaptive engine: slowdown = ${this.slowdownFactor.toFixed(2)} (latency: ${latency}ms, samples: ${this.latencySamples.length})`, 'DEBUG', 'perf');
  }

  getAdjustedWait(baseWaitMs: any) {
    return Math.round(baseWaitMs * this.slowdownFactor);
  }

  // Dashboard observability hook: returns a snapshot of current engine state.
  getStats() {
    const samples = this.latencySamples;
    const count = samples.length;
    const sum = count ? samples.reduce((a: number, b: number) => a + b, 0) : 0;
    const avg = count ? sum / count : 0;
    const min = count ? Math.min(...samples) : 0;
    const max = count ? Math.max(...samples) : 0;
    return {
      slowdownFactor: Number(this.slowdownFactor),
      emaAlpha: EMA_ALPHA,
      bounds: { min: MIN_SLOWDOWN, max: MAX_SLOWDOWN },
      lastLatencyMs: this.lastLatencyMs,
      lastUpdatedAt: this.lastUpdatedAt,
      samples: { count, window: SAMPLE_WINDOW, avg, min, max },
    };
  }

  // Recovery hook: clears sample history and resets the factor to neutral.
  reset() {
    this.latencySamples = [];
    this.slowdownFactor = 1.0;
    this.lastLatencyMs = null;
    this.lastUpdatedAt = null;
    try { getUpsertCalibration()?.run('performance_profile_slowdown', String(this.slowdownFactor), Date.now()); } catch (e: any) { log('Failed to persist reset', 'DEBUG', 'perf'); }
    log('⚡ Adaptive engine: reset to slowdown = 1.00', 'INFO', 'perf');
  }
}

module.exports = Object.assign(new AdaptivePerformanceEngine(), { _injectDependencies });