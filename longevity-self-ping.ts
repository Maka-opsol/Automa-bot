'use strict';

// Health Watchdog — Self-Ping with Scoring + Auto-Restart
//
// Runs every 60 seconds and scores the bot's health across 6 checks.
// Each check returns 0-2 points. Total 12 points possible.
//
// Score thresholds:
//   10-12: Healthy    — all systems go
//    6-9:  Degraded   — warn, skip non-essentials
//    3-5:  Critical   — attempt graceful in-process restart
//    0-2:  Fatal      — process.exit(1) to trigger Render auto-restart
//
// Consecutive restart tracking:
//   If > 3 restarts in 1 hour → enter extended sleep (30 min) to avoid
//   restart loops that burn through Render's 750hr/month quota.
//
// Integration:
//   - render-free-plan.ts: starts/stops the watchdog, exposes score in /health
//   - cycle-cycle-manager.ts: reads health score for decision-making
//   - Response 8: NTFY alerts on critical/fatal health transitions

const fs = require('fs');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string) {
  _deps.logger?.log?.(msg, level, 'health-watchdog') ?? console.log(msg);
}

// ─── Configuration ───
const CHECK_INTERVAL_MS = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS || '60000', 10);
const HEAP_CRITICAL_MB = parseInt(process.env.HEALTH_WATCHDOG_HEAP_CRITICAL_MB || '200', 10);
const HEAP_WARNING_MB = parseInt(process.env.HEALTH_WATCHDOG_HEAP_WARNING_MB || '150', 10);
const TMP_CRITICAL_PCT = parseInt(process.env.HEALTH_WATCHDOG_TMP_CRITICAL_PCT || '80', 10);
const STALL_THRESHOLD_MIN = parseInt(process.env.HEALTH_WATCHDOG_STALL_MIN || '10', 10);
const MAX_RESTARTS_PER_HOUR = 3;
const EXTENDED_SLEEP_MS = 30 * 60 * 1000; // 30 minutes

// ─── State ───
let _interval: ReturnType<typeof setInterval> | null = null;
let _isRunning = false;

// Health check results (latest)
let _healthState: HealthState = {
  score: 12,
  level: 'healthy',
  checks: {},
  lastCheckTime: 0,
  consecutiveCriticalStreak: 0,
  lastProgressTime: Date.now(),
  totalRestarts: 0,
  restartTimes: [],
  inExtendedSleep: false,
  extendedSleepUntil: 0,
};

// Callback for when health level changes
let _onLevelChange: ((from: string, to: string, state: HealthState) => void) | null = null;

interface HealthCheckResult {
  points: number;       // 0, 1, or 2
  detail: string;
}

interface HealthState {
  score: number;
  level: 'healthy' | 'degraded' | 'critical' | 'fatal';
  checks: Record<string, HealthCheckResult>;
  lastCheckTime: number;
  consecutiveCriticalStreak: number;
  lastProgressTime: number;
  totalRestarts: number;
  restartTimes: number[];  // timestamps of recent restarts
  inExtendedSleep: boolean;
  extendedSleepUntil: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Individual Health Checks (each returns 0-2 points)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Check 1: Browser connected?
 * 2 = connected, 1 = disconnected but recoverable, 0 = gone
 */
function _checkBrowser(): HealthCheckResult {
  try {
    const browser = _deps.browser;
    if (!browser) return { points: 1, detail: 'Browser module not loaded' };

    // Check if browser has an active page
    const disconnected = browser.getBrowserDisconnected?.();
    if (disconnected) return { points: 0, detail: 'Browser disconnected' };

    // Check page instance
    const page = browser.browserManager?.pageInstance;
    if (page && !page.isClosed()) return { points: 2, detail: 'Browser connected' };
    if (page && page.isClosed()) return { points: 0, detail: 'Browser page closed' };

    return { points: 1, detail: 'Browser state uncertain' };
  } catch (e: any) {
    return { points: 1, detail: `Browser check error: ${e.message}` };
  }
}

/**
 * Check 2: Recent progress?
 * 2 = progress in last N minutes, 1 = stalled, 0 = no progress for > 2x threshold
 */
function _checkProgress(): HealthCheckResult {
  const now = Date.now();
  const elapsed = now - _healthState.lastProgressTime;
  const thresholdMs = STALL_THRESHOLD_MIN * 60 * 1000;

  if (elapsed < thresholdMs) {
    return { points: 2, detail: `Progress ${Math.round(elapsed / 60000)}m ago` };
  }
  if (elapsed < thresholdMs * 2) {
    return { points: 1, detail: `Stalled ${Math.round(elapsed / 60000)}m (threshold: ${STALL_THRESHOLD_MIN}m)` };
  }
  return { points: 0, detail: `No progress for ${Math.round(elapsed / 60000)}m` };
}

/**
 * Check 3: Heap memory OK?
 * 2 = under warning, 1 = warning-critical, 0 = over critical
 */
function _checkHeap(): HealthCheckResult {
  try {
    const mem = process.memoryUsage();
    const heapMB = mem.heapUsed / 1024 / 1024;

    if (heapMB < HEAP_WARNING_MB) {
      return { points: 2, detail: `Heap ${heapMB.toFixed(0)}MB` };
    }
    if (heapMB < HEAP_CRITICAL_MB) {
      return { points: 1, detail: `Heap high: ${heapMB.toFixed(0)}MB (warn: ${HEAP_WARNING_MB}MB)` };
    }
    return { points: 0, detail: `Heap critical: ${heapMB.toFixed(0)}MB (limit: ${HEAP_CRITICAL_MB}MB)` };
  } catch {
    return { points: 1, detail: 'Heap check failed' };
  }
}

/**
 * Check 4: Event loop responsive?
 * 2 = < 100ms, 1 = < 500ms, 0 = > 500ms (or hung)
 */
function _checkEventLoop(): HealthCheckResult {
  return new Promise<HealthCheckResult>((resolve) => {
    const start = Date.now();
    setImmediate(() => {
      const elapsed = Date.now() - start;
      if (elapsed < 100) {
        resolve({ points: 2, detail: `Event loop ${elapsed}ms` });
      } else if (elapsed < 500) {
        resolve({ points: 1, detail: `Event loop slow: ${elapsed}ms` });
      } else {
        resolve({ points: 0, detail: `Event loop HUNG: ${elapsed}ms` });
      }
    });
    // Safety timeout in case setImmediate itself is blocked
    setTimeout(() => resolve({ points: 0, detail: 'Event loop check timed out' }), 2000);
  });
}

/**
 * Check 5: /tmp disk space OK?
 * 2 = under 60%, 1 = 60-80%, 0 = over 80%
 */
function _checkTmpSpace(): HealthCheckResult {
  try {
    const tmpDir = '/tmp';
    if (!fs.existsSync(tmpDir)) return { points: 2, detail: '/tmp not found (non-Linux?)' };

    const stats = fs.statSync(tmpDir);
    // On Render/Linux, we can't easily get disk usage of /tmp
    // Use a proxy: check how many files exist in our directories
    const ourDirs = ['/tmp', '/tmp/mathu-logs', '/tmp/mathu-backups'];
    let fileCount = 0;
    for (const dir of ourDirs) {
      try {
        if (fs.existsSync(dir)) {
          fileCount += fs.readdirSync(dir).length;
        }
      } catch { /* skip */ }
    }

    // Rough heuristic: if > 500 files in /tmp subtree, we might be filling up
    if (fileCount < 100) return { points: 2, detail: `/tmp files: ${fileCount}` };
    if (fileCount < 300) return { points: 1, detail: `/tmp files: ${fileCount} (elevated)` };
    return { points: 0, detail: `/tmp files: ${fileCount} (critical)` };
  } catch {
    return { points: 2, detail: '/tmp check skipped' };
  }
}

/**
 * Check 6: Any providers available?
 * 2 = 3+ providers, 1 = 1-2 providers, 0 = 0 providers
 */
function _checkProviders(): HealthCheckResult {
  try {
    const providersBase = _deps.providersBase;
    const stats = providersBase?.getStats?.() || {};
    const available = stats.availableProviders || 0;

    if (available >= 3) return { points: 2, detail: `${available} providers available` };
    if (available >= 1) return { points: 1, detail: `Only ${available} provider(s)` };
    return { points: 0, detail: 'No providers available' };
  } catch {
    return { points: 1, detail: 'Provider check error' };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Scoring + Level Determination
// ═══════════════════════════════════════════════════════════════════════════

function _scoreToLevel(score: number): HealthState['level'] {
  if (score >= 10) return 'healthy';
  if (score >= 6) return 'degraded';
  if (score >= 3) return 'critical';
  return 'fatal';
}

// ═══════════════════════════════════════════════════════════════════════════
// Restart Tracking
// ═══════════════════════════════════════════════════════════════════════════

function _recordRestart() {
  const now = Date.now();
  _healthState.totalRestarts++;
  _healthState.restartTimes.push(now);

  // Prune restarts older than 1 hour
  const oneHourAgo = now - 60 * 60 * 1000;
  _healthState.restartTimes = _healthState.restartTimes.filter(t => t > oneHourAgo);
}

function _restartsInLastHour(): number {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  return _healthState.restartTimes.filter(t => t > oneHourAgo).length;
}

function _isInRestartLoop(): boolean {
  return _restartsInLastHour() >= MAX_RESTARTS_PER_HOUR;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main Check Loop
// ═══════════════════════════════════════════════════════════════════════════

async function runHealthCheck(): Promise<HealthState> {
  // If in extended sleep, don't run checks — just wait
  if (_healthState.inExtendedSleep) {
    if (Date.now() >= _healthState.extendedSleepUntil) {
      _healthState.inExtendedSleep = false;
      _healthState.extendedSleepUntil = 0;
      log('Extended sleep completed — resuming health checks', 'INFO');
    } else {
      return _healthState;
    }
  }

  const prevLevel = _healthState.level;
  const checks: Record<string, HealthCheckResult> = {};

  // Run all checks
  checks.browser = _checkBrowser();
  checks.progress = _checkProgress();
  checks.heap = _checkHeap();
  checks.providers = _checkProviders();
  checks.tmpSpace = _checkTmpSpace();

  // Event loop check is async
  try {
    checks.eventLoop = await Promise.race([
      _checkEventLoop(),
      new Promise<HealthCheckResult>((resolve) =>
        setTimeout(() => resolve({ points: 0, detail: 'Event loop check timeout' }), 3000)
      ),
    ]);
  } catch {
    checks.eventLoop = { points: 0, detail: 'Event loop check error' };
  }

  // Calculate total score
  const score = Object.values(checks).reduce((sum, c) => sum + c.points, 0);
  const level = _scoreToLevel(score);

  // Update state
  _healthState.score = score;
  _healthState.level = level;
  _healthState.checks = checks;
  _healthState.lastCheckTime = Date.now();

  // Track critical streaks
  if (level === 'critical' || level === 'fatal') {
    _healthState.consecutiveCriticalStreak++;
  } else {
    _healthState.consecutiveCriticalStreak = 0;
  }

  // Log based on level
  if (level === 'healthy') {
    // Only log occasionally when healthy to reduce noise
    if (Math.random() < 0.1) { // 10% chance per check when healthy
      log(`Health: ${score}/12 [${Object.entries(checks).map(([k, v]) => `${k}=${v.points}`).join(', ')}]`, 'DEBUG');
    }
  } else {
    log(`Health ${level.toUpperCase()}: ${score}/12 [${Object.entries(checks).map(([k, v]) => `${k}=${v.points}`).join(', ')}]`, level === 'fatal' ? 'ERROR' : 'WARN');
  }

  // Handle level transitions
  if (level !== prevLevel) {
    log(`Health level changed: ${prevLevel} -> ${level}`, 'WARN');
    _onLevelChange?.(prevLevel, level, _healthState);
  }

  // Auto-actions based on level + streak
  if (level === 'critical' && _healthState.consecutiveCriticalStreak >= 3) {
    await _attemptGracefulRestart('consecutive critical streak');
  } else if (level === 'fatal') {
    if (_isInRestartLoop()) {
      if (!_healthState.inExtendedSleep) {
        log(`Restart loop detected (${_restartsInLastHour()} in 1h). Entering extended sleep for ${EXTENDED_SLEEP_MS / 60000} min.`, 'ERROR');
        _healthState.inExtendedSleep = true;
        _healthState.extendedSleepUntil = Date.now() + EXTENDED_SLEEP_MS;
      }
    } else {
      await _attemptGracefulRestart('fatal health score');
    }
  }

  return _healthState;
}

/**
 * Attempt a graceful in-process restart.
 * Steps: close browser → clear caches → GC → re-init browser → resume cycle
 * If browser fails to re-init, process.exit(1) to trigger Render auto-restart.
 */
async function _attemptGracefulRestart(reason: string): Promise<void> {
  log(`Graceful restart triggered: ${reason}`, 'WARN');

  try {
    // Step 1: Close browser
    const browser = _deps.browser;
    if (browser?.closeBrowser) {
      try { await Promise.race([browser.closeBrowser(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))]); } catch (e: any) {
        log(`Browser close during restart: ${e.message}`, 'WARN');
      }
    }

    // Step 2: Clear caches
    const cache = _deps.cache;
    if (cache?.clearCache) cache.clearCache();

    // Step 3: Force GC
    if (global.gc) { try { global.gc(); } catch { /* ignore */ } }

    // Step 4: Wait briefly
    await new Promise(r => setTimeout(r, 3000));

    // Step 5: Re-init browser
    const browserMod = _deps.browser;
    if (browserMod?.launchBrowser || browserMod?.withBrowserRetry) {
      try {
        const launchFn = browserMod.phoenixBrowserRetry || browserMod.withBrowserRetry || browserMod.launchBrowser;
        if (launchFn) {
          await launchFn(async (p: any) => p);
          log('Graceful restart: browser re-initialized successfully', 'INFO');
          _healthState.consecutiveCriticalStreak = 0;
          _recordRestart();
          return;
        }
      } catch (e: any) {
        log(`Graceful restart: browser re-init failed: ${e.message}`, 'ERROR');
      }
    }

    // Step 6: If we get here, in-process restart failed — trigger Render restart
    log('Graceful restart failed — triggering process.exit(1) for Render auto-restart', 'ERROR');
    _recordRestart();
    process.exit(1);
  } catch (e: any) {
    log(`Graceful restart error: ${e.message} — triggering process.exit(1)`, 'ERROR');
    _recordRestart();
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start the health watchdog. Call once at startup.
 */
function start(options?: { onLevelChange?: (from: string, to: string, state: HealthState) => void }): void {
  if (_isRunning) return;
  _isRunning = true;

  if (options?.onLevelChange) {
    _onLevelChange = options.onLevelChange;
  }

  log(`Health watchdog started (interval: ${CHECK_INTERVAL_MS / 1000}s)`, 'INFO');

  // Run first check after 5 seconds (let things settle)
  setTimeout(() => {
    runHealthCheck().catch((e: any) => log(`Health check error: ${e.message}`, 'ERROR'));
  }, 5000);

  // Schedule recurring checks
  _interval = setInterval(() => {
    if (!_isRunning) return;
    runHealthCheck().catch((e: any) => log(`Health check error: ${e.message}`, 'ERROR'));
  }, CHECK_INTERVAL_MS);

  // Don't let the interval prevent process exit
  _interval.unref();
}

/**
 * Stop the health watchdog. Call during shutdown.
 */
function stop(): void {
  _isRunning = false;
  if (_interval) {
    clearInterval(_interval);
    _interval = null;
  }
  log('Health watchdog stopped', 'INFO');
}

/**
 * Get the latest health state. Non-blocking — returns cached result.
 */
function getHealth(): HealthState {
  return { ..._healthState };
}

/**
 * Notify the watchdog that progress was made (e.g., question answered).
 * Resets the progress stall timer.
 */
function notifyProgress(): void {
  _healthState.lastProgressTime = Date.now();
}

module.exports = {
  start,
  stop,
  getHealth,
  notifyProgress,
  runHealthCheck,
  _injectDependencies,
};
