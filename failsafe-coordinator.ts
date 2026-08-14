'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getStateDiagnostics() { return _deps.stateMachine?.getStateDiagnostics; }
function getCacheStats() { return _deps.cache?.getCacheStats; }
function getBrowserManager() { return _deps.browser?.getBrowserManager(); }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

class FailsafeCoordinator {
  healthChecks: any;
  lastHealthReport: any;
  _degradationLevel: any;
  circuitBreakers: any;
  _checkInterval: any;
  _started: any;
  failureThreshold: any;
  resetTimeoutMs: any;
  halfOpenRequests: any;
  warning: any;

  constructor() {
    this.healthChecks = new Map();
    this.circuitBreakers = new Map();
    this.lastHealthReport = null;
    this._checkInterval = null;
    this._degradationLevel = 0;
    this._started = false;
  }

  registerHealthCheck(name: any, checkFn: any, intervalMs = 60000) { 
    this.healthChecks.set(name, { fn: checkFn, interval: intervalMs, lastCheck: null, lastResult: null, consecutiveFailures: 0 });
  }

  registerCircuitBreaker(name: any, options: any = {}) { 
    if (this.circuitBreakers.has(name)) { log(`Circuit breaker '${name}' already registered, overwriting`, 'WARN', 'failsafe'); }
    const { failureThreshold = 5, resetTimeoutMs = 60000, halfOpenRequests = 1 } = options;
    this.circuitBreakers.set(name, { state: 'closed', failureCount: 0, successCount: 0, lastFailureTime: null, failureThreshold, resetTimeoutMs, halfOpenRequests, halfOpenSuccesses: 0, halfOpenInFlight: 0 });
  }

  async executeWithCircuitBreaker(name: any, fn: any) {
    const breaker = this.circuitBreakers.get(name);
    if (!breaker) return await fn();
    if (breaker.state === 'open') {
      const timeSinceFailure = Date.now() - breaker.lastFailureTime;
      if (timeSinceFailure >= breaker.resetTimeoutMs) {
        breaker.state = 'half-open';
        breaker.halfOpenSuccesses = 0;
        breaker.halfOpenInFlight = 0;
        log(`Circuit breaker ${name} entering half-open state`, 'INFO', 'failsafe');
      } else {
        throw new Error(`Circuit breaker ${name} is open`);
      }
    }
    if (breaker.state === 'half-open') {
      if (breaker.halfOpenInFlight >= breaker.halfOpenRequests) {
        throw new Error(`Circuit breaker ${name} half-open concurrency limit reached (${breaker.halfOpenRequests})`);
      }
      breaker.halfOpenInFlight++;
    }
    try { const result = await fn(); this._recordCircuitSuccess(name); return result; } catch (err: any) { this._recordCircuitFailure(name); throw err; }
  }

  _recordCircuitSuccess(name: any) { 
    const breaker = this.circuitBreakers.get(name);
    if (!breaker) return;
    breaker.successCount++; breaker.failureCount = 0;
    if (breaker.halfOpenInFlight > 0) breaker.halfOpenInFlight--;
    if (breaker.state === 'half-open') { breaker.halfOpenSuccesses++; if (breaker.halfOpenSuccesses >= breaker.halfOpenRequests) { breaker.state = 'closed'; log(`Circuit breaker ${name} closed`, 'INFO', 'failsafe'); } }
  }

  _recordCircuitFailure(name: any) { 
    const breaker = this.circuitBreakers.get(name);
    if (!breaker) return;
    if (breaker.halfOpenInFlight > 0) breaker.halfOpenInFlight--;
    breaker.failureCount++; breaker.lastFailureTime = Date.now();
    if (breaker.state === 'half-open') { breaker.state = 'open'; log(`Circuit breaker ${name} reopened from half-open`, 'WARN', 'failsafe'); } else if (breaker.failureCount >= breaker.failureThreshold) { breaker.state = 'open'; log(`Circuit breaker ${name} opened`, 'WARN', 'failsafe'); }
  }

  async runHealthChecks() { 
    const results = {};
    let hasCritical = false, hasWarning = false;
    for (const [name, check] of this.healthChecks) {
      try {
        const result = await check.fn();
        check.lastCheck = Date.now(); check.lastResult = result; check.consecutiveFailures = 0;
// @ts-expect-error
        results[name] = { healthy: true, result, lastCheck: check.lastCheck };
      } catch (err: any) {
        check.consecutiveFailures++; check.lastCheck = Date.now(); check.lastResult = { error: err.message };
        const isHealthy = check.consecutiveFailures < 3;
// @ts-expect-error
        results[name] = { healthy: isHealthy, error: err.message, consecutiveFailures: check.consecutiveFailures, lastCheck: check.lastCheck };
        if (!isHealthy) { hasCritical = true; logError('Health check failed: ' + name + ' - ' + err.message, err); } else { hasWarning = true; }
      }
    }
    this._degradationLevel = hasCritical ? 2 : hasWarning ? 1 : 0;
    this.lastHealthReport = { timestamp: Date.now(), degradationLevel: this._degradationLevel, checks: results, circuitBreakers: this.getCircuitBreakerStatus() };
    return this.lastHealthReport;
  }

  getCircuitBreakerStatus() { 
    const status = {};
// @ts-expect-error
    for (const [name, breaker] of this.circuitBreakers) { status[name] = { state: breaker.state, failureCount: breaker.failureCount, successCount: breaker.successCount, lastFailureTime: breaker.lastFailureTime }; }
    return status;
  }

  getDegradationLevel() {  return this._degradationLevel; }
  isDegraded() {  return this._degradationLevel > 0; }
  isCritical() {  return this._degradationLevel >= 2; }
  getLastHealthReport() {  return this.lastHealthReport; }

  startPeriodicChecks(intervalMs = 60000) { 
    if (this._checkInterval) clearInterval(this._checkInterval);
    this._started = true;
    this.runHealthChecks().catch(err => logError('Health checks failed', err, { module: 'failsafe' }));
    this._checkInterval = setInterval(() => { this.runHealthChecks().catch(err => logError('Health checks failed', err, { module: 'failsafe' })); }, intervalMs);
    if (this._checkInterval.unref) this._checkInterval.unref();
  }

  stopPeriodicChecks() {  if (this._checkInterval) { clearInterval(this._checkInterval); this._checkInterval = null; } this._started = false; }

  getFullDiagnostics() { 
    let dbStats = null;
    try { const { getDatabaseStats } = require('./database'); dbStats = getDatabaseStats(); } catch {}
    return { timestamp: Date.now(), degradationLevel: this._degradationLevel, database: dbStats, stateMachine: getStateDiagnostics ? getStateDiagnostics()?.() : 'unavailable', cache: getCacheStats ? getCacheStats()?.() : 'unavailable', circuitBreakers: this.getCircuitBreakerStatus(), browser: getBrowserManager() ? getBrowserManager().getMetrics() : 'unavailable', memory: process.memoryUsage(), uptime: process.uptime() };
  }
}

const failsafeCoordinator = new FailsafeCoordinator();

failsafeCoordinator.registerHealthCheck('database', async () => {
  const database = require('./database');
  // database.ts does NOT export `db` directly — it exports checkIntegrity and
  // getDatabaseStats.  Use those instead of reaching for the raw connection.
  if (typeof database.checkIntegrity === 'function') {
    const ok = database.checkIntegrity();
    if (!ok) throw new Error('Database integrity check failed');
  }
  const stats = database.getDatabaseStats ? database.getDatabaseStats() : null;
  if (stats && stats.totalSizeBytes > 200 * 1024 * 1024) { throw new Error(`Database size ${(stats.totalSizeBytes/1024/1024).toFixed(1)} MB exceeds critical threshold`); }
  const result = { sizeMB: stats ? (stats.totalSizeBytes/1024/1024).toFixed(1) : 0 };
// @ts-expect-error
  if (stats && stats.totalSizeBytes > 100 * 1024 * 1024) { result.warning = `Database size ${(stats.totalSizeBytes/1024/1024).toFixed(1)} MB exceeds warning threshold`; }
  return result;
}, 30000);

failsafeCoordinator.registerHealthCheck('filesystem', async () => {
  const fs = require('fs');
  // FIX: Ensure LOG_DIR exists before checking. On fresh starts the logger's
  // _initLogStream() may not have run yet, so the directory won't exist.
  // Previously this threw ENOENT and the health check reported critical.
  const logDir = CONFIG.LOG_DIR;
  if (logDir) {
    try { fs.accessSync(logDir, fs.constants.W_OK); }
    catch {
      try { fs.mkdirSync(logDir, { recursive: true, mode: 0o750 }); }
      catch { throw new Error(`LOG_DIR '${logDir}' does not exist and cannot be created`); }
    }
  }
  fs.accessSync(require('path').dirname(CONFIG.DB_PATH), fs.constants.W_OK);
  return { writable: true };
}, 60000);

failsafeCoordinator.registerHealthCheck('memory', async () => {
  const heapUsedMB = process.memoryUsage().heapUsed / (1024 * 1024);
  if (heapUsedMB > CONFIG.MEMORY_RESTART_THRESHOLD_MB) { throw new Error(`Memory critical: ${heapUsedMB.toFixed(1)}MB`); }
  if (heapUsedMB > CONFIG.MEMORY_WARNING_THRESHOLD_MB) {
    return { heapUsedMB: heapUsedMB.toFixed(1), warning: `Memory usage ${heapUsedMB.toFixed(1)}MB exceeds warning threshold` };
  }
  return { heapUsedMB: heapUsedMB.toFixed(1) };
}, 30000);

failsafeCoordinator.registerCircuitBreaker('vision_api', { failureThreshold: 5, resetTimeoutMs: 300000 });
failsafeCoordinator.registerCircuitBreaker('code_gen', { failureThreshold: 3, resetTimeoutMs: 600000 });
failsafeCoordinator.registerCircuitBreaker('remote_config', { failureThreshold: 3, resetTimeoutMs: 900000 });

module.exports = {
  failsafeCoordinator,
  executeWithCircuitBreaker: (name: any, fn: any) => failsafeCoordinator.executeWithCircuitBreaker(name, fn),
  getDiagnostics: () => failsafeCoordinator.getFullDiagnostics(),
  isDegraded: () => failsafeCoordinator.isDegraded(),
  isCritical: () => failsafeCoordinator.isCritical(),
  startHealthChecks: (interval: any) => failsafeCoordinator.startPeriodicChecks(interval),
  stopHealthChecks: () => failsafeCoordinator.stopPeriodicChecks()
,
  _injectDependencies,
};
