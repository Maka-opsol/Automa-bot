'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

// v5-fix: Lazy requires to avoid top-level DI dependency
function getLogger() { return _deps.logger || (() => { try { return require('./logger'); } catch { return { log: console.log, logError: console.error }; } })(); }
function getCONFIG() { return _deps.config || require('./get-config'); }
let _getStatsFn: any = null;
function getStatsFn() {
  if (!_getStatsFn) {
    try { _getStatsFn = (_deps.providersStats || require('./providers-stats')).getStats; }
    catch { _getStatsFn = () => ({ memory: 0, cpu: 0 }); }
  }
  return _getStatsFn;
}

const CHECK_INTERVAL_MS = 30000;
const MIN_WORKERS = 1;
const MAX_WORKERS = parseInt(process.env.MAX_WORKERS || '') || 5;
const CPU_TARGET = 60;
const MEMORY_TARGET = 70;
const MEMORY_MAX = parseInt(process.env.MEMORY_MAX_MB || '') || (() => { try { return Math.round(require('os').totalmem() / 1024 / 1024 * 0.7); } catch { return 800; } })();

class ResourceManager {
  currentWorkers: any;
  lastAdjustment: any;
  cooldownMs: any;
  history: any;
  _lastCpuTime: any;
  _checkTimer: any;

  constructor() {
    this.currentWorkers = MIN_WORKERS;
    this.lastAdjustment = Date.now();
    this.cooldownMs = 60000;
    this.history = [];
    this._lastCpuTime = null;
  }

  getCpuUsage() { 
    try {
      const usage = process.cpuUsage();
      const total = usage.user + usage.system;
      if (this._lastCpuTime) {
        const deltaUser = usage.user - this._lastCpuTime.user;
        const deltaSystem = usage.system - this._lastCpuTime.system;
        const deltaTotal = deltaUser + deltaSystem;
        const deltaElapsed = (Date.now() - this._lastCpuTime.timestamp) * 1000;
        this._lastCpuTime = { user: usage.user, system: usage.system, timestamp: Date.now() };
        return deltaElapsed > 0 ? (deltaTotal / deltaElapsed) * 100 : 0;
      }
      this._lastCpuTime = { user: usage.user, system: usage.system, timestamp: Date.now() };
      return 0;
    } catch (err: any) {
      return 0;
    }
  }

  getMemoryUsage() { 
    const mem = process.memoryUsage();
    return {
      heapUsed: mem.heapUsed / 1024 / 1024,
      heapTotal: mem.heapTotal / 1024 / 1024,
      rss: mem.rss / 1024 / 1024,
      external: mem.external / 1024 / 1024,
    };
  }

  getLoadAverage() { 
    try {
      return require('os').loadavg();
    } catch (err: any) {
      return [0, 0, 0];
    }
  }

  collectMetrics() { 
    const cpu = this.getCpuUsage();
    const mem = this.getMemoryUsage();
    const load = this.getLoadAverage();
    const stats = getStatsFn()();
    return {
      timestamp: Date.now(),
      cpu,
      memory: mem.heapUsed,
      load1: load[0] || 0,
      load5: load[1] || 0,
      load15: load[2] || 0,
      cycles: stats.cycleCount || 0,
      errors: stats.errors || 0,
      workers: this.currentWorkers,
    };
  }

  calculateAdjustment(metrics: any) { 
    const cpuDelta = metrics.cpu - CPU_TARGET;
    const memDelta = metrics.memory - MEMORY_TARGET;
    let adjustment = 0;
    if (cpuDelta > 10 || memDelta > 10) {
      adjustment = -1;
    } else if (cpuDelta < -10 && memDelta < -10 && this.currentWorkers < MAX_WORKERS) {
      adjustment = 1;
    }
    if (metrics.memory > MEMORY_MAX) {
      adjustment = -1;
    }
    if (metrics.errors > 5) {
      adjustment = -1;
    }
    return adjustment;
  }

  adjustWorkers(adjustment: any) { 
    if (adjustment === 0) return;
    const newCount = Math.max(MIN_WORKERS, Math.min(MAX_WORKERS, this.currentWorkers + adjustment));
    if (newCount === this.currentWorkers) return;
    getLogger().log(`Adjusting workers: ${this.currentWorkers} -> ${newCount} (${adjustment > 0 ? 'scale up' : 'scale down'})`, 'INFO', 'resource');
    this.currentWorkers = newCount;
    this.lastAdjustment = Date.now();
    this.emitWorkerUpdate(newCount);
  }

  emitWorkerUpdate(count: any) { 
    try {
      const { coordinator } = require('./coordinator-leader');
      if (coordinator.isLeader) {
        const current = coordinator.getActiveWorkers().length;
        if (current < count) {
          for (let i = current; i < count; i++) {
            const workerId = `worker-${Date.now()}-${i}`;
            coordinator.registerWorker(workerId, { type: 'worker' });
          }
        } else if (current > count) {
          const toRemove = current - count;
          const workers = coordinator.getActiveWorkers();
          for (let i = 0; i < toRemove && i < workers.length; i++) {
            coordinator.unregisterWorker(workers[i]);
          }
        }
      }
    } catch (err: any) {
      getLogger().logError('Failed to update workers', err);
    }
  }

  runCheck() { 
    const now = Date.now();
    if (now - this.lastAdjustment < this.cooldownMs) return;
    const metrics = this.collectMetrics();
    this.history.push(metrics);
    if (this.history.length > 60) this.history.shift();
    const adjustment = this.calculateAdjustment(metrics);
    if (adjustment !== 0) {
      this.adjustWorkers(adjustment);
    }
  }

  start() { 
    this._checkTimer = setInterval(() => this.runCheck(), CHECK_INTERVAL_MS);
    this._checkTimer.unref();
    setTimeout(() => this.runCheck(), 10000).unref();
    getLogger().log('Resource manager started', 'INFO', 'resource');
  }

  getStatus() { 
    const metrics = this.collectMetrics();
    return {
      currentWorkers: this.currentWorkers,
      cpu: metrics.cpu.toFixed(1),
      memory: metrics.memory.toFixed(1),
      loadAvg: metrics.load1.toFixed(2),
      history: this.history.slice(-10),
      maxWorkers: MAX_WORKERS,
      minWorkers: MIN_WORKERS,
    };
  }
}

const resourceManager = new ResourceManager();

module.exports = { resourceManager, _injectDependencies };
