'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

const { log, logError } = require('./logger');

/**
 * M5 FIX: Number of consecutive unhealthy/degraded results before alerting.
 * Prevents alert storms from transient blips.
 */
const CONSECUTIVE_FAILURES_BEFORE_ALERT = 2;

class HealthChecker {
  checks: any;
  lastResults: any;
  _consecutiveFailures: any;
  _periodicTimers: any;
  _isRunning: any;
  interval: any;
  timeout: any;
  critical: any;

  constructor() {
    this.checks = new Map();
    this.lastResults = new Map();
    /** M5 FIX: Track consecutive failures per check for alert dedup. */
    this._consecutiveFailures = new Map();
    /** M5 FIX: Track periodic timer references for cleanup. */
    this._periodicTimers = new Map();
    this._isRunning = false;
  }

  registerCheck(name: any, checkFn: any, options: any = {}) { 
    this.checks.set(name, { fn: checkFn, interval: options.interval || 5 * 60 * 1000, timeout: options.timeout || 30000, critical: options.critical || false, lastRun: 0 });
    this._consecutiveFailures.set(name, 0);
  }

  async runCheck(name: any) { 
    const check = this.checks.get(name);
    if (!check) throw new Error(`Unknown check: ${name}`);
    const startTime = Date.now();
    let result = { status: 'healthy', message: null, duration: 0, timestamp: new Date().toISOString() };
    try {
      let timerId;
      const timeoutPromise = new Promise((_, reject) => { timerId = setTimeout(() => reject(new Error('Timeout')), check.timeout); });
      try {
        await Promise.race([check.fn(), timeoutPromise]);
        result.status = 'healthy';
      } finally {
        clearTimeout(timerId);
      }
    } catch (err: any) {
      result.status = check.critical ? 'unhealthy' : 'degraded';
      result.message = err.message;
      logError(`Health check "${name}" failed`, err);
    } finally {
      result.duration = Date.now() - startTime;
      check.lastRun = Date.now();
      this.lastResults.set(name, result);
    }
    return result;
  }

  async runAllChecks() { 
    const entries = [...this.checks.entries()];
    const results = {};
    const settled = await Promise.allSettled(
      entries.map(([name]) => this.runCheck(name).then(result => [name, result]))
    );
    for (const entry of settled) {
      if (entry.status === 'fulfilled') {
        (results as any)[entry.value[0]] = entry.value[1];
      }
    }
    return results;
  }

  /**
   * M5 FIX: Run all checks and trigger alerts for any that are failing.
   * Uses consecutive failure counting to avoid alert storms.
   */
  async runAllChecksWithAlerting() {
    if (this._isRunning) return;
    this._isRunning = true;
    try {
      const results = await this.runAllChecks();
      const failedChecks = [];
      const recoveredChecks = [];

      for (const [name, result] of Object.entries(results)) {
        const isFailing = (result as any).status === 'unhealthy' || (result as any).status === 'degraded';
        const prevFailures = this._consecutiveFailures.get(name) || 0;

        if (isFailing) {
          const newCount = prevFailures + 1;
          this._consecutiveFailures.set(name, newCount);
          if (newCount >= CONSECUTIVE_FAILURES_BEFORE_ALERT) {
// @ts-expect-error
            failedChecks.push({ name, ...result });
          } else {
            log(`Health check "${name}" failing (${newCount}/${CONSECUTIVE_FAILURES_BEFORE_ALERT}) — not yet alerting`, 'WARN', 'health-check');
          }
        } else {
          if (prevFailures >= CONSECUTIVE_FAILURES_BEFORE_ALERT) {
            recoveredChecks.push(name);
          }
          this._consecutiveFailures.set(name, 0);
        }
      }

      // Send aggregated alert for all failing checks
      if (failedChecks.length > 0) {
        const hasUnhealthy = failedChecks.some(c => c.status === 'unhealthy');
        const severity = hasUnhealthy ? 1 : 2;
        const lines = failedChecks.map(c => `  [${c.status.toUpperCase()}] ${c.name}: ${c.message || 'check failed'} (${c.duration}ms)`);
        const summary = `Health check failures (${failedChecks.length}/${Object.keys(results).length}):
${lines.join('\n')}`;
        getSendAlert()(summary, severity);
        log(summary, 'ERROR', 'health-check');
      }

      // Log recoveries
      for (const name of recoveredChecks) {
        const msg = `Health check recovered: ${name} is now healthy`;
        log(msg, 'INFO', 'health-check');
        try { getSendAlert()(msg, 3); } catch (e: any) { /* non-critical */ }
      }
    } catch (err: any) {
      logError('Health check run with alerting failed', err);
    } finally {
      this._isRunning = false;
    }
  }

  getOverallStatus() { 
    let hasUnhealthy = false;
    let hasDegraded = false;
    for (const result of this.lastResults.values()) { if (result.status === 'unhealthy') hasUnhealthy = true; if (result.status === 'degraded') hasDegraded = true; }
    if (hasUnhealthy) return 'unhealthy';
    if (hasDegraded) return 'degraded';
    return 'healthy';
  }

  getResults() {  return Object.fromEntries(this.lastResults); }

  /**
   * M5 FIX: Start periodic health checks with alerting.
   * Each registered check runs on its own interval.
   */
  startPeriodic() {
    for (const [name, check] of this.checks.entries()) {
      const timer = setInterval(() => {
        this.runCheck(name).then(result => {
          const isFailing = result.status !== 'healthy';
          const prevFailures = this._consecutiveFailures.get(name) || 0;

          if (isFailing) {
            const newCount = prevFailures + 1;
            this._consecutiveFailures.set(name, newCount);
            if (newCount >= CONSECUTIVE_FAILURES_BEFORE_ALERT) {
              const severity = result.status === 'unhealthy' ? 1 : 2;
              const msg = `Health check [${result.status.toUpperCase()}]: ${name} — ${result.message || 'check failed'} (${result.duration}ms)`;
              getSendAlert()(msg, severity);
              log(msg, 'ERROR', 'health-check');
            } else {
              log(`Health check "${name}" failing (${newCount}/${CONSECUTIVE_FAILURES_BEFORE_ALERT})`, 'WARN', 'health-check');
            }
          } else {
            if (prevFailures >= CONSECUTIVE_FAILURES_BEFORE_ALERT) {
              const msg = `Health check recovered: ${name} is now healthy`;
              log(msg, 'INFO', 'health-check');
              try { getSendAlert()(msg, 3); } catch (e: any) { /* non-critical */ }
            }
            this._consecutiveFailures.set(name, 0);
          }
        }).catch(err => {
          logError(`Periodic health check "${name}" threw`, err);
        });
      }, check.interval);
      if (timer.unref) timer.unref();
      this._periodicTimers.set(name, timer);
    }
    log(`Periodic health checks started for ${this.checks.size} check(s)`, 'INFO', 'health-check');
  }

  /**
   * M5 FIX: Stop all periodic health check timers.
   */
  stopPeriodic() {
    for (const [name, timer] of this._periodicTimers.entries()) {
      clearInterval(timer);
      this._periodicTimers.delete(name);
    }
    log('Periodic health checks stopped', 'INFO', 'health-check');
  }
}

const healthChecker = new HealthChecker();
healthChecker.registerCheck('database', async () => { const db = require('./database').db; db.prepare('SELECT 1').get(); }, { critical: true, interval: 60000 });
healthChecker.registerCheck('memory', async () => { const used = process.memoryUsage().heapUsed / 1024 / 1024; const cfg = require('./get-config'); const threshold = cfg.MEMORY_WARNING_THRESHOLD_MB || 280; if (used > threshold) throw new Error(`Memory high: ${used.toFixed(0)}MB > ${threshold}MB`); }, { critical: true, interval: 30000 });
healthChecker.registerCheck('disk-space', async () => { const fs = require('fs'); try { const s = fs.statfsSync(process.cwd()); const total = s.blocks * s.bsize; const free = s.bfree * s.bsize; const pct = (free / total) * 100; if (pct < 10) throw new Error(`Low disk space: ${pct.toFixed(1)}% free (${Math.round(free/1024/1024)}MB)`); } catch (e: any) { if (e.code === 'ENOSYS' || e.code === 'ERR_METHOD_NOT_IMPLEMENTED') { return; } else { throw e; } } }, { critical: false, interval: 300000 });

module.exports = Object.assign(healthChecker, { _injectDependencies });
