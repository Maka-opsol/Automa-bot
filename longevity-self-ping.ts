'use strict';

// Health Watchdog — Self-Ping with Scoring + Auto-Restart + Render Hour Budget
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
// FIX: Render Hour Budget Tracking
//   Render free tier = 750 hours/month. If the bot runs 24/7, that's ~31 days.
//   Without budget tracking, the bot exhausts hours in month 1 and dies for months 2-3.
//
//   New behavior:
//   - Track cumulative monthly runtime in calibration DB (survives restarts via Turso)
//   - At 80% budget: extend DORMANT sleep periods to conserve hours
//   - At 90% budget: only run during "efficient windows" (8h/day instead of 24h)
//   - At 95% budget: enter extended DORMANT (4h on, 20h off)
//   - At 100% budget: full DORMANT until month rollover
//   - Fatal restarts (process.exit) check budget before executing

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
const EXTENDED_SLEEP_MS = 30 * 60 * 1000;

// ─── Render Hour Budget ───
const RENDER_MONTHLY_HOURS = 750;
const BUDGET_KEY = 'render_hour_budget';
const BUDGET_TRACKING_KEY = 'render_runtime_hours_this_month';
let _monthlyRuntimeSeconds = 0;
let _budgetLoaded = false;
let _lastRuntimeSample = 0;

// ─── State ───
let _interval: ReturnType<typeof setInterval> | null = null;
let _isRunning = false;

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

let _onLevelChange: ((from: string, to: string, state: HealthState) => void) | null = null;

interface HealthCheckResult {
  points: number;
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
  restartTimes: number[];
  inExtendedSleep: boolean;
  extendedSleepUntil: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Render Hour Budget Management
// ═══════════════════════════════════════════════════════════════════════════

function _getDb() { return _deps.database?.db; }

/**
 * Load cumulative runtime from calibration DB (persisted via Turso).
 * Tracks total seconds the bot has been running this calendar month.
 */
function _loadRuntimeBudget(): void {
  if (_budgetLoaded) return;
  try {
    const db = _getDb();
    if (!db) return;
    const row = db.prepare('SELECT value, updated_at FROM calibration WHERE key = ?').get(BUDGET_TRACKING_KEY);
    if (row) {
      const data = JSON.parse(row.value);
      // Check if the month has rolled over
      const storedMonth = data.month || '';
      const currentMonth = new Date().toISOString().slice(0, 7); // YYYY-MM
      if (storedMonth === currentMonth) {
        _monthlyRuntimeSeconds = data.seconds || 0;
        _lastRuntimeSample = data.lastSample || Date.now();
        log(`Runtime budget loaded: ${Math.round(_monthlyRuntimeSeconds / 3600)}h this month (${Math.round(getBudgetPct())}%)`, 'INFO');
      } else {
        // New month — reset
        _monthlyRuntimeSeconds = 0;
        _lastRuntimeSample = Date.now();
        _saveRuntimeBudget();
        log(`New month detected — runtime budget reset`, 'INFO');
      }
    } else {
      _lastRuntimeSample = Date.now();
    }
    _budgetLoaded = true;
  } catch {}
}

/**
 * Save current runtime to calibration DB.
 */
function _saveRuntimeBudget(): void {
  try {
    const db = _getDb();
    if (!db) return;
    db.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)').run(
      BUDGET_TRACKING_KEY,
      JSON.stringify({
        seconds: _monthlyRuntimeSeconds,
        month: new Date().toISOString().slice(0, 7),
        lastSample: Date.now(),
      }),
      Date.now()
    );
  } catch {}
}

/**
 * Update runtime counter. Call periodically (every check).
 */
function _updateRuntime(): void {
  const now = Date.now();
  if (_lastRuntimeSample > 0) {
    const elapsed = Math.floor((now - _lastRuntimeSample) / 1000);
    _monthlyRuntimeSeconds += elapsed;
  }
  _lastRuntimeSample = now;

  // Save every 5 minutes (not every check to avoid DB churn)
  if (Math.floor(now / 300000) !== Math.floor((now - 60000) / 300000)) {
    _saveRuntimeBudget();
  }
}

/**
 * Get budget usage as percentage (0-100).
 */
function getBudgetPct(): number {
  const hoursUsed = _monthlyRuntimeSeconds / 3600;
  return Math.min(100, (hoursUsed / RENDER_MONTHLY_HOURS) * 100);
}

/**
 * Get remaining hours in this month's budget.
 */
function getRemainingHours(): number {
  const hoursUsed = _monthlyRuntimeSeconds / 3600;
  return Math.max(0, RENDER_MONTHLY_HOURS - hoursUsed);
}

/**
 * Check if we should be sleeping to conserve Render hours.
 * Returns { shouldSleep: boolean, reason: string, durationMs: number }.
 */
function _shouldSleepForBudget(): { shouldSleep: boolean; reason: string; durationMs: number } {
  const pct = getBudgetPct();
  const remaining = getRemainingHours();
  const now = new Date();
  const hour = now.getUTCHours(); // Use UTC for consistency

  // At 100%: full sleep until month rollover
  if (pct >= 100) {
    const daysUntilRollover = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime() - now.getTime();
    return { shouldSleep: true, reason: `Budget exhausted (${Math.round(pct)}%). Sleeping until month rollover.`, durationMs: daysUntilRollover };
  }

  // At 95%: 4h on, 20h off schedule
  if (pct >= 95) {
    // Only run during efficient window: 06:00-10:00 UTC
    if (hour < 6 || hour >= 10) {
      const msUntilWindow = ((6 - hour + 24) % 24) * 3600000;
      return { shouldSleep: true, reason: `Budget critical (${Math.round(pct)}%). Sleeping until 06:00 UTC efficient window.`, durationMs: Math.min(msUntilWindow, 20 * 3600000) };
    }
    return { shouldSleep: false, reason: '', durationMs: 0 };
  }

  // At 90%: 8h/day schedule (06:00-14:00 UTC)
  if (pct >= 90) {
    if (hour < 6 || hour >= 14) {
      const msUntilWindow = ((6 - hour + 24) % 24) * 3600000;
      return { shouldSleep: true, reason: `Budget tight (${Math.round(pct)}%). Sleeping until 06:00 UTC window.`, durationMs: Math.min(msUntilWindow, 16 * 3600000) };
    }
    return { shouldSleep: false, reason: '', durationMs: 0 };
  }

  // At 80%: extend DORMANT periods
  if (pct >= 80) {
    // During off-peak hours (22:00-06:00 UTC), sleep longer
    if (hour >= 22 || hour < 6) {
      return { shouldSleep: true, reason: `Budget watch (${Math.round(pct)}%). Off-peak sleep.`, durationMs: 4 * 3600000 };
    }
    return { shouldSleep: false, reason: '', durationMs: 0 };
  }

  return { shouldSleep: false, reason: '', durationMs: 0 };
}

// ═══════════════════════════════════════════════════════════════════════════
// Individual Health Checks (each returns 0-2 points)
// ═══════════════════════════════════════════════════════════════════════════

function _checkBrowser(): HealthCheckResult {
  try {
    const browser = _deps.browser;
    if (!browser) return { points: 1, detail: 'Browser module not loaded' };
    const page = browser.browserManager?.pageInstance;
    if (page && !page.isClosed()) return { points: 2, detail: 'Browser connected' };
    if (page && page.isClosed()) {
      const disconnected = browser.getBrowserDisconnected?.();
      return { points: 0, detail: `Browser page closed${disconnected ? ' (disconnected)' : ''}` };
    }
    const launchCount = browser.getBrowserLaunchCount?.() ?? 0;
    const disconnected = browser.getBrowserDisconnected?.();
    if (launchCount === 0) return { points: 1, detail: 'Browser not yet launched' };
    if (disconnected) return { points: 0, detail: `Browser disconnected after ${launchCount} launch(es)` };
    return { points: 1, detail: `Browser state uncertain (${launchCount} launches)` };
  } catch (e: any) {
    return { points: 1, detail: `Browser check error: ${e.message}` };
  }
}

function _checkProgress(): HealthCheckResult {
  const now = Date.now();
  const elapsed = now - _healthState.lastProgressTime;
  const thresholdMs = STALL_THRESHOLD_MIN * 60 * 1000;
  if (elapsed < thresholdMs) return { points: 2, detail: `Progress ${Math.round(elapsed / 60000)}m ago` };
  if (elapsed < thresholdMs * 2) return { points: 1, detail: `Stalled ${Math.round(elapsed / 60000)}m` };
  return { points: 0, detail: `No progress for ${Math.round(elapsed / 60000)}m` };
}

function _checkHeap(): HealthCheckResult {
  try {
    const mem = process.memoryUsage();
    const heapMB = mem.heapUsed / 1024 / 1024;
    if (heapMB < HEAP_WARNING_MB) return { points: 2, detail: `Heap ${heapMB.toFixed(0)}MB` };
    if (heapMB < HEAP_CRITICAL_MB) return { points: 1, detail: `Heap high: ${heapMB.toFixed(0)}MB` };
    return { points: 0, detail: `Heap critical: ${heapMB.toFixed(0)}MB` };
  } catch {
    return { points: 1, detail: 'Heap check failed' };
  }
}

function _checkEventLoop(): HealthCheckResult {
  return new Promise<HealthCheckResult>((resolve) => {
    const start = Date.now();
    setImmediate(() => {
      const elapsed = Date.now() - start;
      if (elapsed < 100) resolve({ points: 2, detail: `Event loop ${elapsed}ms` });
      else if (elapsed < 500) resolve({ points: 1, detail: `Event loop slow: ${elapsed}ms` });
      else resolve({ points: 0, detail: `Event loop HUNG: ${elapsed}ms` });
    });
    setTimeout(() => resolve({ points: 0, detail: 'Event loop check timed out' }), 2000);
  });
}

function _checkTmpSpace(): HealthCheckResult {
  try {
    const tmpDir = '/tmp';
    if (!fs.existsSync(tmpDir)) return { points: 2, detail: '/tmp not found' };
    const ourDirs = ['/tmp', '/tmp/mathu-logs', '/tmp/mathu-backups'];
    let fileCount = 0;
    for (const dir of ourDirs) {
      try { if (fs.existsSync(dir)) fileCount += fs.readdirSync(dir).length; } catch {}
    }
    if (fileCount < 100) return { points: 2, detail: `/tmp files: ${fileCount}` };
    if (fileCount < 300) return { points: 1, detail: `/tmp files: ${fileCount} (elevated)` };
    return { points: 0, detail: `/tmp files: ${fileCount} (critical)` };
  } catch {
    return { points: 2, detail: '/tmp check skipped' };
  }
}

function _checkProviders(): HealthCheckResult {
  try {
    let available = 0;
    try {
      const registry = require('./providers-registry');
      if (typeof registry.getAvailableProviderCount === 'function') available = registry.getAvailableProviderCount();
    } catch {
      try {
        const db = _deps.database?.db;
        if (db) {
          const row = db.prepare("SELECT COUNT(*) as cnt FROM model_registry WHERE role = 'active' AND is_working = 1").get();
          available = row?.cnt || 0;
        }
      } catch {}
    }
    if (available >= 3) return { points: 2, detail: `${available} providers` };
    if (available >= 1) return { points: 1, detail: `Only ${available} provider(s)` };
    return { points: 0, detail: 'No providers' };
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
  // Load budget on first check
  _loadRuntimeBudget();
  _updateRuntime();

  // ── FIX: Budget-aware sleep ──
  if (_healthState.inExtendedSleep) {
    if (Date.now() >= _healthState.extendedSleepUntil) {
      _healthState.inExtendedSleep = false;
      _healthState.extendedSleepUntil = 0;
      log('Extended sleep completed — resuming', 'INFO');
    } else {
      return _healthState;
    }
  }

  const budgetCheck = _shouldSleepForBudget();
  if (budgetCheck.shouldSleep) {
    if (!_healthState.inExtendedSleep) {
      log(`${budgetCheck.reason} Sleeping ${Math.round(budgetCheck.durationMs / 60000)}min. Remaining: ${getRemainingHours().toFixed(1)}h`, 'WARN');
      _healthState.inExtendedSleep = true;
      _healthState.extendedSleepUntil = Date.now() + budgetCheck.durationMs;
      try { (_deps.alerting?.sendAlert || (() => {}))(`${budgetCheck.reason} Remaining budget: ${getRemainingHours().toFixed(1)}h`, 2); } catch {}
    }
    return _healthState;
  }

  const prevLevel = _healthState.level;
  const checks: Record<string, HealthCheckResult> = {};

  checks.browser = _checkBrowser();
  checks.progress = _checkProgress();
  checks.heap = _checkHeap();
  checks.providers = _checkProviders();
  checks.tmpSpace = _checkTmpSpace();

  try {
    checks.eventLoop = await Promise.race([
      _checkEventLoop(),
      new Promise<HealthCheckResult>((resolve) => setTimeout(() => resolve({ points: 0, detail: 'timeout' }), 3000)),
    ]);
  } catch {
    checks.eventLoop = { points: 0, detail: 'Event loop check error' };
  }

  const score = Object.values(checks).reduce((sum, c) => sum + c.points, 0);
  const level = _scoreToLevel(score);

  _healthState.score = score;
  _healthState.level = level;
  _healthState.checks = checks;
  _healthState.lastCheckTime = Date.now();

  if (level === 'critical' || level === 'fatal') {
    _healthState.consecutiveCriticalStreak++;
  } else {
    _healthState.consecutiveCriticalStreak = 0;
  }

  if (level === 'healthy') {
    if (Math.random() < 0.1) log(`Health: ${score}/12 [${Object.entries(checks).map(([k, v]) => `${k}=${v.points}`).join(', ')}] budget=${Math.round(getBudgetPct())}%, remaining=${getRemainingHours().toFixed(1)}h`, 'DEBUG');
  } else {
    log(`Health ${level.toUpperCase()}: ${score}/12 [${Object.entries(checks).map(([k, v]) => `${k}=${v.points}`).join(', ')}]`, level === 'fatal' ? 'ERROR' : 'WARN');
  }

  if (level !== prevLevel) {
    log(`Health: ${prevLevel} -> ${level}`, 'WARN');
    _onLevelChange?.(prevLevel, level, _healthState);
  }

  if (level === 'critical' && _healthState.consecutiveCriticalStreak >= 3) {
    // FIX: Check budget before restarting — don't burn hours on restart loops
    if (getBudgetPct() >= 95) {
      log('Critical streak but budget nearly exhausted — entering DORMANT instead of restarting', 'ERROR');
      try {
        const { degradationLadder } = require('./self-heal-degradation-ladder');
        degradationLadder.setLevel(4, `CRITICAL_STREAK + BUDGET_LOW (${Math.round(getBudgetPct())}%)`);
      } catch {}
      _healthState.inExtendedSleep = true;
      _healthState.extendedSleepUntil = Date.now() + 2 * 3600000;
    } else {
      await _attemptGracefulRestart('consecutive critical streak');
    }
  } else if (level === 'fatal') {
    if (_isInRestartLoop()) {
      if (!_healthState.inExtendedSleep) {
        log(`Restart loop (${_restartsInLastHour()} in 1h). Extended sleep ${EXTENDED_SLEEP_MS / 60000}min.`, 'ERROR');
        _healthState.inExtendedSleep = true;
        _healthState.extendedSleepUntil = Date.now() + EXTENDED_SLEEP_MS;
      }
    } else {
      // FIX: Don't restart if budget is critically low
      if (getBudgetPct() >= 98) {
        log('Fatal health but budget nearly exhausted — entering DORMANT instead of restart', 'ERROR');
        try {
          const { degradationLadder } = require('./self-heal-degradation-ladder');
          degradationLadder.setLevel(4, `FATAL + BUDGET_EXHAUSTED (${Math.round(getBudgetPct())}%)`);
        } catch {}
        _healthState.inExtendedSleep = true;
        _healthState.extendedSleepUntil = Date.now() + 4 * 3600000;
      } else {
        await _attemptGracefulRestart('fatal health score');
      }
    }
  }

  return _healthState;
}

async function _attemptGracefulRestart(reason: string): Promise<void> {
  log(`Graceful restart: ${reason}`, 'WARN');
  try {
    const browser = _deps.browser;
    if (browser?.closeBrowser) {
      try { await Promise.race([browser.closeBrowser(), new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 10000))]); } catch (e: any) {
        log(`Browser close during restart: ${e.message}`, 'WARN');
      }
    }
    const cache = _deps.cache;
    if (cache?.clearCache) cache.clearCache();
    if (global.gc) { try { global.gc(); } catch {} }
    await new Promise(r => setTimeout(r, 3000));
    const browserMod = _deps.browser;
    if (browserMod?.launchBrowser || browserMod?.withBrowserRetry) {
      try {
        const launchFn = browserMod.phoenixBrowserRetry || browserMod.withBrowserRetry || browserMod.launchBrowser;
        if (launchFn) {
          await launchFn(async (p: any) => p);
          log('Graceful restart: browser re-initialized', 'INFO');
          _healthState.consecutiveCriticalStreak = 0;
          _recordRestart();
          return;
        }
      } catch (e: any) {
        log(`Graceful restart failed: ${e.message}`, 'ERROR');
      }
    }
    log('Graceful restart failed — process.exit(1)', 'ERROR');
    _recordRestart();
    process.exit(1);
  } catch (e: any) {
    log(`Graceful restart error: ${e.message} — process.exit(1)`, 'ERROR');
    _recordRestart();
    process.exit(1);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

function start(options?: { onLevelChange?: (from: string, to: string, state: HealthState) => void }): void {
  if (_isRunning) return;
  _isRunning = true;
  if (options?.onLevelChange) _onLevelChange = options.onLevelChange;
  log(`Health watchdog started (interval: ${CHECK_INTERVAL_MS / 1000}s, budget: ${RENDER_MONTHLY_HOURS}h/month)`, 'INFO');
  setTimeout(() => runHealthCheck().catch((e: any) => log(`Health check error: ${e.message}`, 'ERROR')), 5000);
  _interval = setInterval(() => {
    if (!_isRunning) return;
    runHealthCheck().catch((e: any) => log(`Health check error: ${e.message}`, 'ERROR'));
  }, CHECK_INTERVAL_MS);
  if (_interval.unref) _interval.unref();
}

function stop(): void {
  _isRunning = false;
  if (_interval) { clearInterval(_interval); _interval = null; }
  // Save final runtime before exit
  _saveRuntimeBudget();
  log('Health watchdog stopped', 'INFO');
}

function getHealth(): HealthState {
  return { ..._healthState };
}

function notifyProgress(): void {
  _healthState.lastProgressTime = Date.now();
}

module.exports = {
  start,
  stop,
  getHealth,
  notifyProgress,
  runHealthCheck,
  getBudgetPct,
  getRemainingHours,
  _injectDependencies,
};
