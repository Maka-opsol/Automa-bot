'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// MathU Bot v6 — Render Free Plan Entry Point (FULL FEATURES)
// ═══════════════════════════════════════════════════════════════════════════════
// Designed for Render free tier: 512 MB RAM, ephemeral disk,
// spins down after 15 min inactivity, cold starts ~30s.
//
// ALL features are kept enabled. Memory savings come from:
//   1. No worker threads (saves ~90-150 MB — 3 workers × 30-50 MB each)
//      In-process modules are used instead (they're lightweight).
//   2. Chromium in single-process mode (saves ~50-80 MB vs multi-process)
//   3. Chromium V8 heap capped at 128 MB
//   4. Aggressive GC every 3 minutes
//
// Memory budget (~285 MB total, ~227 MB headroom):
//   - Node.js baseline:        ~70 MB
//   - All JS subsystems:       ~40 MB (timers + small data, NOT workers)
//   - Chromium single-process: ~100 MB
//   - better-sqlite3:          ~15 MB
//   - OS / overhead:           ~60 MB
//
// Staying alive:
//   - Internal self-ping every 4 minutes prevents Render spin-down
//   - Optional external ping (KEEPALIVE_PING_URL) via UptimeRobot/cron-job.org
//   - 750 hours/month free = ~31 days of 24/7 (tight but feasible)
//
// Ephemeral disk:
//   - No persistent disk on Render free plan
//   - All paths point to /tmp (survives across the same instance, lost on redeploy)
//   - DB re-seeds on each cold start; bot continues from fresh state
//   - Progress is tracked by MathU platform itself, not just locally
//
// Render detection:
//   - RENDER_SERVICE_ID env var indicates we are on Render
//   - Used by subsystems to skip heavy I/O, disk checks, etc.
//
// Dashboard integration:
//   - dashboard-server.ts is mounted via handleDashboardRequest()
//   - Full dashboard UI at /dashboard
//   - All management API routes (/api/*) handled by dashboard-server
// ═══════════════════════════════════════════════════════════════════════════════

require('./error-handler');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROJECT_ROOT } = require('./project-root');

// ═══════════════════════════════════════════════════════════════════════
// RENDER DETECTION
// ═══════════════════════════════════════════════════════════════════════
if (!process.env.RENDER_SERVICE_ID) {
  if (process.env.RENDER) {
    process.env.RENDER_SERVICE_ID = 'detected-free-plan';
  }
}

const IS_RENDER = !!(process.env.RENDER_SERVICE_ID || process.env.RENDER);

// ═══════════════════════════════════════════════════════════════════════
// PRE-STARTUP: Set Render-friendly defaults BEFORE any module loads
// ═══════════════════════════════════════════════════════════════════════

const DATA_DIR = os.tmpdir();

// Paths — all under /tmp (ephemeral, but writable)
if (!process.env.DB_PATH)          process.env.DB_PATH          = path.join(DATA_DIR, 'mathu-bot.db');
if (!process.env.USER_DATA_DIR)    process.env.USER_DATA_DIR    = path.join(DATA_DIR, '.browser-data');
if (!process.env.LOG_DIR)          process.env.LOG_DIR          = path.join(DATA_DIR, 'mathu-logs');
if (!process.env.SCREENSHOT_DIR)   process.env.SCREENSHOT_DIR   = path.join(DATA_DIR, 'mathu-logs', 'screenshots');
if (!process.env.AUTH_STATE_PATH)  process.env.AUTH_STATE_PATH  = path.join(DATA_DIR, 'state.json');
if (!process.env.HEARTBEAT_FILE)   process.env.HEARTBEAT_FILE   = path.join(DATA_DIR, '.heartbeat');
if (!process.env.CHECKPOINT_FILE)  process.env.CHECKPOINT_FILE  = path.join(DATA_DIR, 'checkpoint.json');
if (!process.env.PROGRESS_LOG_PATH) process.env.PROGRESS_LOG_PATH = path.join(DATA_DIR, 'mathu-logs', 'progress.jsonl');
if (!process.env.LAST_STATE_PATH)  process.env.LAST_STATE_PATH  = path.join(DATA_DIR, 'last-state.json');
if (!process.env.SELF_HEAL_BACKUP_DIR)  process.env.SELF_HEAL_BACKUP_DIR  = path.join(DATA_DIR, 'mathu-backups');
if (!process.env.SELF_HEAL_STAGING_DIR) process.env.SELF_HEAL_STAGING_DIR = path.join(DATA_DIR, 'mathu-staging');
if (!process.env.SELF_HEAL_OVERLAY_DIR) process.env.SELF_HEAL_OVERLAY_DIR = path.join(DATA_DIR, 'self-heal-overlay');
if (!process.env.REGRESSION_BANK_DIR)   process.env.REGRESSION_BANK_DIR   = path.join(DATA_DIR, 'mathu-regression');

// Display — smaller viewport on Render free tier saves ~40-60% on screenshot size
// (800x600 vs 1280x800 = 480K pixels vs 1024K pixels).
// JPEG quality 30 at 800x600 ≈ 15-25KB per screenshot vs 30-60KB at 1280x800.
// The AI providers can still read math at this resolution.
if (!process.env.DISPLAY_WIDTH)  process.env.DISPLAY_WIDTH  = '800';
if (!process.env.DISPLAY_HEIGHT) process.env.DISPLAY_HEIGHT = '600';

// Memory — only set MAX_MEMORY_MB if not already set.
// Render free plan = 512 MB total. Aggressive threshold to prevent OOM kills.
if (!process.env.MAX_MEMORY_MB) process.env.MAX_MEMORY_MB = '400';
// Override warning and restart thresholds to be aggressive
if (!process.env.MEMORY_WARNING_THRESHOLD_MB) process.env.MEMORY_WARNING_THRESHOLD_MB = '280';
if (!process.env.MEMORY_RESTART_THRESHOLD_MB) process.env.MEMORY_RESTART_THRESHOLD_MB = '320';

// Post-set consistency guard
(function ensureMemoryThresholdConsistency() {
  const maxMem = parseInt(process.env.MAX_MEMORY_MB || '448', 10);
  const restartThr = parseInt(process.env.MEMORY_RESTART_THRESHOLD_MB || '0', 10);
  const warnThr = parseInt(process.env.MEMORY_WARNING_THRESHOLD_MB || '0', 10);
  if (restartThr > 0 && restartThr >= maxMem) {
    process.env.MEMORY_RESTART_THRESHOLD_MB = String(Math.floor(maxMem * 0.8));
  }
  const effectiveRestart = parseInt(
    process.env.MEMORY_RESTART_THRESHOLD_MB || String(Math.floor(maxMem * 0.8)), 10
  );
  if (warnThr > 0 && warnThr >= effectiveRestart) {
    process.env.MEMORY_WARNING_THRESHOLD_MB = String(Math.floor(maxMem * 0.7));
  }
})();

// Timing
if (!process.env.MAX_UPTIME_HOURS)           process.env.MAX_UPTIME_HOURS = '0';
if (!process.env.MAX_CYCLES_BEFORE_RESTART) process.env.MAX_CYCLES_BEFORE_RESTART = '999999';

// Logging
if (!process.env.LOG_LEVEL)       process.env.LOG_LEVEL = 'info';
if (!process.env.LOG_MAX_FILES)   process.env.LOG_MAX_FILES = '2';
if (!process.env.LOG_MAX_SIZE_MB) process.env.LOG_MAX_SIZE_MB = '10';

// Chromium — single-process saves 50-80 MB vs multi-process
if (!process.env.CHROMIUM_FLAGS) {
  process.env.CHROMIUM_FLAGS =
    '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage '
    // NOTE: --disable-gpu removed — breaks Flutter CanvasKit WebGL rendering
    + '--disable-extensions --disable-background-networking '
    + '--disable-default-apps --disable-sync '
    + '--disable-translate --disable-component-extensions-with-background-pages '
    + '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,'
    + 'MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion '
    + '--js-flags=--max-old-space-size=96 --optimize-for-size '
    + '--single-process --disable-logging --disable-notifications';
}

// Ensure directories exist
for (const dir of [
  process.env.LOG_DIR, process.env.USER_DATA_DIR,
  process.env.SELF_HEAL_BACKUP_DIR, process.env.SELF_HEAL_STAGING_DIR,
  process.env.SELF_HEAL_OVERLAY_DIR,
  process.env.REGRESSION_BANK_DIR, process.env.SCREENSHOT_DIR,
]) {
  try { fs.mkdirSync(dir!, { recursive: true }); } catch { /* best-effort */ }
}

// ═══════════════════════════════════════════════════════════════════════
// LOAD MODULES
// ═══════════════════════════════════════════════════════════════════════

const { container, startSubsystemGroup, startSelfHealV2Subsystems, startResilienceSubsystems, getContainerHealth, runStartupSmokeTests } = require('./container');

let CONFIG: any, log: any, logError: any;
let closeDatabase: any, upsertCalibration: any, selectCalibration: any, pruneTemplateCache: any;
try {
  CONFIG = container.get('config');
  ({ log, logError } = container.get('logger'));
  ({ closeDatabase, upsertCalibration, selectCalibration, pruneTemplateCache } = container.get('database'));
} catch (initErr: any) {
  console.error(`FATAL: Core module initialization failed: ${initErr.message}`);
  process.exit(1);
}

let startDaemon: () => Promise<void>;
let requestStop: () => void;
try {
  ({ startDaemon, requestStop } = container.get('orchestrator'));
} catch (e: any) {
  console.error(`FATAL: Cycle module initialization failed: ${e.message}`);
  process.exit(1);
}

const _alertingMod = container.get('alerting', { required: false });
const sendAlert = _alertingMod?.sendAlert || ((msg: any) => log(`[ALERT] ${msg}`, 'ERROR', 'render-free-plan'));

const { ensureDependencies } = container.get('dependencyManager', { required: false }) || { ensureDependencies: () => {} };
ensureDependencies();
try { CONFIG.validateConfig(); } catch (validationErr: any) {
  console.error(`FATAL: Configuration validation failed: ${(validationErr as Error).message}`);
  try { closeDatabase(); } catch { /* best effort */ }
  process.exit(1);
}

// ═══════════════════════════════════════════════════════════════════════
// LOAD DASHBOARD SERVER (connected via container, same as this file)
// ═══════════════════════════════════════════════════════════════════════
// dashboard-server.ts resolves its own dependencies from container,
// so no manual DI is needed. We just import its request handler.
const { handleDashboardRequest } = require('./dashboard-server');

// ═══════════════════════════════════════════════════════════════════════
// MEMORY-SAVINGS: Memory Mode Manager
// ═══════════════════════════════════════════════════════════════════════
// Two modes: "full_power" (all features) and "memory_protection" (heavy
// modules disabled, aggressive GC). Auto-switches to memory_protection
// when memory is critically high or a recent OOM crash is detected.
// Manual toggle via dashboard API.
//
// Must initialize BEFORE subsystems start so env vars are set correctly.
const memoryMode = require('./memory-mode');
memoryMode.init();
log(`Operational mode: ${memoryMode.getMode()} (thresholds: warn=${memoryMode.getThresholds().warnHeapMB}MB, restart=${memoryMode.getThresholds().restartHeapMB}MB)`, 'INFO', 'render-free-plan');

// ═══════════════════════════════════════════════════════════════════════
// RESTART GUARDIAN — DB-backed crash loop detection
// ═══════════════════════════════════════════════════════════════════════
// Must init AFTER memory-mode (so it can switch modes) but BEFORE
// subsystems start (so emergency mode can disable heavy modules).
// Uses DB (via Turso) for restart counting — survives /tmp/ wipes.
const restartGuardian = require('./survival-restart-guardian');
const guardianResult = restartGuardian.init({
  logger: container.get('logger', { required: false }),
  database: container.get('database', { required: false }),
  browser: container.get('browser', { required: false }),
  cache: container.get('cache', { required: false }),
});
if (guardianResult.wasUnexpected) {
  log(`Restart guardian: unexpected restart detected (${guardianResult.recentRestartCount} recent)`, 'WARN', 'render-free-plan');
}
if (guardianResult.emergencyMode) {
  log(`Restart guardian: EMERGENCY MODE active — all preservation methods engaged`, 'ERROR', 'render-free-plan');
}
if (memoryMode.isMemoryProtection()) {
  log(`Operational mode after restart guardian: ${memoryMode.getMode()}`, 'WARN', 'render-free-plan');
}

// ═══════════════════════════════════════════════════════════════════════
// OOM SELF-HEAL TRIGGER — Connect OOM loop detection to self-heal
// ═══════════════════════════════════════════════════════════════════════
// The restart guardian detects OOM loops but only switches to
// memory_protection mode (symptom treatment). This module triggers
// self-heal at boot time to fix the ROOT CAUSE.
// It runs after a 15s delay (gives subsystems time to init) and
// records everything to DB so progress accumulates across OOMs.
try {
  const oomTrigger = require('./self-heal-oom-trigger');
  oomTrigger._injectDependencies({
    logger: container.get('logger', { required: false }),
    database: container.get('database', { required: false }),
  });
  const oomResult = oomTrigger.init({
    wasUnexpected: guardianResult.wasUnexpected,
    emergencyMode: guardianResult.emergencyMode,
    recentRestartCount: guardianResult.recentRestartCount,
  });
  if (oomResult.healScheduled) {
    log(`OOM self-heal TRIGGERED at boot (detected ${oomResult.oomKillCount} OOM kills in process_lifecycle)`, 'ERROR', 'render-free-plan');
  }
} catch (oomTriggerErr: any) {
  log(`OOM trigger init failed (non-fatal): ${oomTriggerErr.message}`, 'WARN', 'render-free-plan');
}

// ═══════════════════════════════════════════════════════════════════════
// SUBSYSTEMS: Start ALL of them (respecting mode-specific env vars above)
// ═══════════════════════════════════════════════════════════════════════

// Longevity subsystems
startSubsystemGroup('longevity');

// Screenshot external storage (before training, since training depends on it)
try {
  const ssStorage = require('./screenshot-storage');
  const ssResult = ssStorage.init();
  if (ssResult.enabled) {
    log(`Screenshot storage: backend=${ssResult.backend}`, 'INFO', 'render-free-plan');
  }
} catch (e: any) {
  log(`Screenshot storage init failed: ${e.message || e}`, 'WARN', 'render-free-plan');
}

// Pixel training system (learns from successful actions)
try {
  const pixelTraining = require('./pixel-training');
  const status = pixelTraining.getStats();
  log(`Pixel training: ${status.cacheSize} samples in cache, ${status.totalRecords} in DB`, 'INFO', 'render-free-plan');
} catch (e: any) {
  log(`Pixel training init failed: ${e.message || e}`, 'WARN', 'render-free-plan');
}

// Seed initial active model if needed
const { getActiveModel, upsertModel } = require('./database');
const active = getActiveModel.get();
if (!active) {
  log('Seeding initial active model: openrouter/free', 'INFO', 'render-free-plan');
  upsertModel.run('openrouter', 'openrouter/free', 1, 1, 'active', Date.now(), Date.now(), 0);
}

// Self-Heal v2 subsystems (respecting CONFIG flags — many disabled above)
startSelfHealV2Subsystems(CONFIG);

// Resilience subsystems (survival, runtime, progress, economy, policy, auth, network)
startResilienceSubsystems();

// ═══════════════════════════════════════════════════════════════════════
// WORKER FALLBACK: Start rewardTracker in-process
// ═══════════════════════════════════════════════════════════════════════
log('Render: Running all subsystems in-process (no worker threads, saves ~90-150 MB)', 'INFO', 'render-free-plan');
try {
  const rtMod = container.get('rewardTracker', { required: false });
  if (rtMod && typeof rtMod.start === 'function') {
    rtMod.start(60 * 60 * 1000);
    log('Reward tracker started in-process', 'INFO', 'render-free-plan');
  }
} catch (e: any) {
  log(`Reward tracker in-process start failed: ${e.message}`, 'WARN', 'render-free-plan');
}

// Override MAX_UPTIME_HOURS to 0 (never forced restart)
if (CONFIG.MAX_UPTIME_HOURS && CONFIG.MAX_UPTIME_HOURS > 0) {
  CONFIG.updateConfig('MAX_UPTIME_HOURS', 0);
  log('Render: Disabled MAX_UPTIME_HOURS forced restart', 'INFO', 'render-free-plan');
}

// ═══════════════════════════════════════════════════════════════════════
// KEEPALIVE PINGER — Prevents Render 15-min spin-down
// ═══════════════════════════════════════════════════════════════════════

const KEEPALIVE_INTERVAL_MS = 3.5 * 60 * 1000;
const EXTERNAL_PING_URL = process.env.KEEPALIVE_PING_URL || '';
const KEEPALIVE_ERROR_THRESHOLD = 5;

let _keepaliveFailCount = 0;
let _firstKeepaliveLogged = false;

function externalPing() {
  if (!EXTERNAL_PING_URL) return;
  try {
    const url = new URL(EXTERNAL_PING_URL);
    const transport = url.protocol === 'https:' ? require('https') : http;
    const req = transport.get({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      timeout: 10000,
    }, (res: any) => {
      res.resume();
    });
    req.on('error', () => {});
    req.setTimeout(10000, () => { req.destroy(); });
  } catch {
    // URL parse failure — non-critical
  }
}

const _selfPingWrapped = function() {
  const port = process.env.PORT || '10000';
  const req = http.get(`http://localhost:${port}/health`, (res: any) => {
    res.resume();
    res.on('end', () => {
      _keepaliveFailCount = 0;
      if (!_firstKeepaliveLogged) {
        _firstKeepaliveLogged = true;
        log('First keepalive ping succeeded — Render spin-down prevented', 'INFO', 'keepalive');
      }
    });
  });
  req.on('error', (err: any) => {
    _keepaliveFailCount++;
    const level = _keepaliveFailCount >= KEEPALIVE_ERROR_THRESHOLD ? 'ERROR' : 'WARN';
    log(
      `Keepalive ping failed (${_keepaliveFailCount}/${KEEPALIVE_ERROR_THRESHOLD}): ${err.message}`,
      level,
      'keepalive'
    );
  });
  req.setTimeout(5000, () => { req.destroy(); });
};

setTimeout(() => {
  _selfPingWrapped();
  externalPing();
  setInterval(() => {
    _selfPingWrapped();
    externalPing();
  }, KEEPALIVE_INTERVAL_MS).unref();
}, 15000);

log(
  `Keepalive system started (interval: ${KEEPALIVE_INTERVAL_MS / 1000}s, external: ${EXTERNAL_PING_URL ? 'enabled' : 'disabled'})`,
  'INFO',
  'render-free-plan'
);

// ═══════════════════════════════════════════════════════════════════════
// SHUTDOWN HANDLING — Recovery, not exit
// ═══════════════════════════════════════════════════════════════════════

let isShuttingDown = false;
const originalExit = process.exit.bind(process);
// Expose original exit so heap guardian can bypass the interceptor for OOM exits.
// Without this, the heap guardian's process.exit(1) is intercepted, the process
// keeps running at critical memory, and Render SIGKILLs it (losing all state).
(process as any)._originalExit = originalExit;
(process as any).exit = (code?: number) => {
  if (isShuttingDown) { originalExit(code || 0); return; }
  log(`process.exit(${code}) intercepted — attempting recovery instead of dying`, 'WARN', 'render-free-plan');
  if (CONFIG.ALERT_ON_ERROR) {
    try { sendAlert(`process.exit(${code}) intercepted, recovering...`); } catch { /* non-critical */ }
  }
};

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`Received ${signal} — shutting down gracefully...`, 'INFO', 'render-free-plan');
  requestStop();
  // v4: Write clean shutdown marker so restart guardian knows this was intentional
  try { restartGuardian.writeCleanShutdownMarker(); } catch { /* best-effort */ }
  // v5: Record process stop in lifecycle table (enables OOM kill detection)
  try { require('./self-heal-oom-trigger').recordProcessStop(signal); } catch { /* best-effort */ }
  // Flush persistent config to disk before dying
  try { require('./persistent-config').flush(); } catch { /* best-effort */ }
  // Flush screenshot upload queue
  try {
    const ss = require('./screenshot-storage');
    if (ss.flushQueue) await ss.flushQueue();
  } catch { /* best-effort */ }
  // Shutdown pixel training
  try { require('./pixel-training').shutdown(); } catch { /* best-effort */ }
  // v4: Stop restart guardian monitoring
  try { restartGuardian.stop(); } catch { /* best-effort */ }
  try {
    const { gracefulShutdown: runHooks } = require('./cycle-shutdown');
    await runHooks(signal);
  } catch {
    try { closeDatabase(); } catch { /* best effort */ }
  }
  originalExit(0);
}

process.once('SIGINT', () => gracefulShutdown('SIGINT'));
process.once('SIGTERM', () => gracefulShutdown('SIGTERM'));

const { registerShutdownHook } = (() => {
  try { return require('./cycle-shutdown'); } catch { return { registerShutdownHook: () => {} }; }
})();
registerShutdownHook(async () => {
  log('Closing browser...', 'INFO', 'render-free-plan');
  try {
    const browserMod = container.get('browser', { required: false });
    if (browserMod?.closeBrowser) {
      await Promise.race([
        browserMod.closeBrowser(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Browser close timed out')), 8000))
      ]).catch((err: any) => { log(`Browser close error (non-fatal): ${err.message}`, 'WARN', 'render-free-plan'); });
    }
  } catch { /* best effort */ }
}, 1);
registerShutdownHook(async () => {
  log('Closing database...', 'INFO', 'render-free-plan');
  try { closeDatabase(); } catch { /* best effort */ }
}, 2);

// ═══════════════════════════════════════════════════════════════════════
// MEMORY MANAGEMENT — Mode-aware, dynamically tuned for 512 MB
// ═══════════════════════════════════════════════════════════════════════
// Thresholds come from memory-mode.ts based on current operational mode.
// In full_power:       warn=350MB, restart=400MB, GC=90s, monitor=20s
// In memory_protection: warn=250MB, restart=280MB, GC=30s, monitor=10s
// ═══════════════════════════════════════════════════════════════════════

let _memoryWarningCount = 0;
let _lastRss = 0;
const persistConfigMod = require('./persistent-config');
let _memoryMonitorInterval: ReturnType<typeof setInterval> | null = null;

// ── Mode-aware memory monitoring ──
// Uses thresholds from the active mode. Auto-downgrades to memory_protection
// if heap exceeds the global danger zone (320MB) or RSS > 440MB.
//
// v3 FIX: Interval is now restartable. When memory-mode changes, the old
// interval is cleared and a new one starts with the new monitor interval.
// Previously the interval was set once with .unref() and never updated,
// so in memory_protection mode (10s interval) it still polled at 20s.
//
// v3 FIX: On warning streak, calls memoryMode.shedMemory() for comprehensive
// cleanup instead of just browser close + GC.

function _startMemoryMonitor(): void {
  if (_memoryMonitorInterval) {
    clearInterval(_memoryMonitorInterval);
    _memoryMonitorInterval = null;
  }
  const intervalMs = memoryMode.getThresholds().monitorIntervalMs;
  log(`Memory monitor starting (interval=${intervalMs}ms, mode=${memoryMode.getMode()})`, 'DEBUG', 'render-free-plan');
  _memoryMonitorInterval = setInterval(() => {
    if (isShuttingDown) return;
    const mem = process.memoryUsage();
    const used = mem.heapUsed / 1024 / 1024;
    const rss = mem.rss / 1024 / 1024;

    // Record memory reading for history-based detection
    persistConfigMod.pushMemoryReading(Math.round(used * 10) / 10, Math.round(rss * 10) / 10);

    // v4: Periodic memory heartbeat to calibration DB (survives SIGKILL via Turso)
    // Written every ~5 minutes. On next startup, checkAfterTursoSync() reads this
    // to detect if the previous instance was running hot before being killed.
    const now = Date.now();
    if (Math.floor(now / 300000) !== Math.floor((now - intervalMs) / 300000)) {
      const heartbeat = JSON.stringify({ heapMB: Math.round(used), rssMB: Math.round(rss), ts: now });
      try {
        const { upsertCalibration: upsertCal } = require('./database');
        if (upsertCal) upsertCal.run('last_memory_heartbeat', heartbeat, now);
      } catch { /* DB not ready — non-critical */ }
    }

    // Auto-downgrade check (before applying mode-specific thresholds)
    // v5 FIX: checkAutoDowngrade is now async (awaits browser cleanup).
    // Don't use .then() — if downgrade happens, the callback restarted the
    // monitor and we should NOT run the stale-threshold code below.
    // We do a synchronous pre-check (heap/RSS) to avoid awaiting when
    // we're clearly not in danger zone.
    const thresholds_before = memoryMode.getThresholds();
    const needDowngrade = used > (memoryMode.AUTO_DOWNGRADE_HEAP_MB || 320) || rss > (memoryMode.AUTO_DOWNGRADE_RSS_MB || 440);
    if (needDowngrade && memoryMode.getMode() !== 'memory_protection') {
      // Actually trigger the async downgrade; fire-and-forget because
      // _applyMode will restart the monitor interval from the .then()
      memoryMode.checkAutoDowngrade(used, rss).then((downgraded: boolean) => {
        if (downgraded) {
          _memoryWarningCount = 0;
          _lastRss = rss;
          _startMemoryMonitor();
        }
      }).catch(() => {});
      return;
    }

    // Get FRESH thresholds (mode may have changed)
    const thresholds = memoryMode.getThresholds();
    const activeRestart = thresholds.restartHeapMB;
    const activeWarn = thresholds.warnHeapMB;
    const activeRssHard = thresholds.rssHardLimitMB;
    const activeStreak = thresholds.warningStreak;

    // Critical: immediate comprehensive memory shed
    // v5 FIX: shedMemory is now async — fire-and-forget in interval context
    // (we can't await inside setInterval). The browser cleanup will complete
    // within ~2-3s. A follow-up GC is scheduled.
    // v6 FIX: Read isMidQuiz() to preserve browser if mid-quiz
    if (used > activeRestart || rss > activeRssHard) {
      log(`Memory CRITICAL (${memoryMode.getMode()}): heap=${used.toFixed(0)}MB rss=${rss.toFixed(0)}MB — full memory shed (midQuiz=${memoryMode.isMidQuiz?.() ?? false})`, 'ERROR', 'render-free-plan');
      memoryMode.shedMemory('render-monitor-critical', {
        preserveBrowser: memoryMode.isMidQuiz?.() ?? false,
      }).then(() => {
        // v5 FIX: Second GC AFTER browser cleanup actually completes
        if (global.gc) { try { global.gc(); } catch {} }
      }).catch(() => {});
      if (global.gc) { try { global.gc(); } catch { /* ignore */ } }
      _memoryWarningCount = 0;
      _lastRss = rss;
    } else if (used > activeWarn) {
      _memoryWarningCount++;
      if (_memoryWarningCount >= activeStreak) {
        log(`Memory warning persistent (${_memoryWarningCount}/${activeStreak}, mode=${memoryMode.getMode()}): heap=${used.toFixed(0)}MB — memory shed (midQuiz=${memoryMode.isMidQuiz?.() ?? false})`, 'WARN', 'render-free-plan');
        // v5 FIX: shedMemory is async now
        // v6 FIX: preserve browser if mid-quiz
        memoryMode.shedMemory('render-monitor-warning', {
          preserveBrowser: memoryMode.isMidQuiz?.() ?? false,
        }).then(() => {
          if (global.gc) { try { global.gc(); } catch {} }
        }).catch(() => {});
        if (global.gc) { try { global.gc(); } catch { /* ignore */ } }
        _memoryWarningCount = 0;
        _lastRss = rss;
      } else {
        const rssTrend = _lastRss > 0 ? (rss - _lastRss > 10 ? 'rising' : 'stable') : 'unknown';
        log(
          `Memory warning: heap=${used.toFixed(0)}MB rss=${rss.toFixed(0)}MB [${_memoryWarningCount}/${activeStreak}] mode=${memoryMode.getMode()} trend=${rssTrend}`,
          'WARN',
          'render-free-plan'
        );
      }
    } else {
      _memoryWarningCount = 0;
    }
    _lastRss = rss;
  }, intervalMs);
  if (_memoryMonitorInterval && typeof (_memoryMonitorInterval as any).unref === 'function') {
    (_memoryMonitorInterval as any).unref();
  }
}
_startMemoryMonitor();

// ═══════════════════════════════════════════════════════════════════════
// HTTP SERVER — Render requires listening on $PORT
// ═══════════════════════════════════════════════════════════════════════
// Routes:
//   /health            — Lightweight health check (keepalive target)
//   /                  — Simple status page
//   /dashboard         — Full dashboard UI (handled by dashboard-server)
//   /api/*             — All API endpoints (handled by dashboard-server)
// ═══════════════════════════════════════════════════════════════════════

const DASHBOARD_ALLOWED_ORIGINS = process.env.DASHBOARD_ALLOWED_ORIGINS
  ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
  : ['*'];

// ── Screenshot cache (for /api/screenshot endpoint) ──
// NOTE: dashboard-server.ts shares this via globals. We set the globals
// here first; dashboard-server checks and reuses them if already set.
let _latestScreenshot: { screenshot: string; timestamp: number; action?: any } | null = null;

function setLatestScreenshot(base64Jpeg: string, action?: any) {
  if (base64Jpeg.length > 500_000) return;
  _latestScreenshot = { screenshot: base64Jpeg, timestamp: Date.now(), action };
}

function getLatestScreenshot() {
  // 30-minute TTL — screenshots should persist on dashboard between cycle iterations
  if (_latestScreenshot && Date.now() - _latestScreenshot.timestamp > 30 * 60 * 1000) {
    _latestScreenshot = null;
  }
  return _latestScreenshot;
}

// Expose globally so cycle manager and dashboard-server can access
(globalThis as any).__setLatestScreenshot = setLatestScreenshot;
(globalThis as any).__getLatestScreenshot = getLatestScreenshot;

function getStats() {
  try {
    const stateMachine = container.get('stateMachine');
    return stateMachine?.getStats?.() || { currentStatus: 'unknown', questionsCompleted: 0, cycleCount: 0 };
  } catch {
    return { currentStatus: 'unknown', questionsCompleted: 0, cycleCount: 0 };
  }
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(' ');
}

function getMemoryInfo() {
  const mem = process.memoryUsage();
  return {
    heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
    heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(0) + 'MB',
    rss: (mem.rss / 1024 / 1024).toFixed(0) + 'MB',
    rssPercent: ((mem.rss / (512 * 1024 * 1024)) * 100).toFixed(1) + '%',
  };
}

// ── Dashboard link helper ──
function getDashboardLink(port: number): string {
  return `/dashboard`;
}

const server = http.createServer(async (req: any, res: any) => {
  // CORS
  const requestOrigin = req.headers.origin || '';
  if (DASHBOARD_ALLOWED_ORIGINS.includes('*') || DASHBOARD_ALLOWED_ORIGINS.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ── Try dashboard-server routes first (handles /dashboard and /api/*) ──
  // Dashboard routes take priority for all /dashboard and /api paths.
  if (pathname.startsWith('/dashboard') || pathname.startsWith('/api/')) {
    const handled = await handleDashboardRequest(req, res);
    if (handled) return;
    // If dashboard-server didn't handle it, fall through to 404 below
  }

  // ── Root: status page with link to dashboard ──
  if (pathname === '/' && req.method === 'GET') {
    const stats = getStats();
    const memInfo = getMemoryInfo();
    const port = parseInt(process.env.PORT || '10000', 10);
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MathU Bot v6 — Render Free</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#e5e7eb;background:#111827}
h1{color:#f9fafb;border-bottom:1px solid #374151;padding-bottom:12px}
.stat{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1f2937}
.stat-label{color:#9ca3af}.stat-value{color:#60a5fa;font-weight:600}
.badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:12px;font-weight:600}
.badge-ok{background:#065f46;color:#6ee7b7}.badge-warn{background:#78350f;color:#fcd34d}.badge-err{background:#7f1d1d;color:#fca5a5}
.footer{margin-top:40px;color:#6b7280;font-size:13px;text-align:center}
a{color:#818cf8}a:hover{color:#a5b4fc}
</style></head><body>
<h1>MathU Bot v6 — Render Free Plan</h1>
<p>All features enabled. 512 MB RAM. No worker threads (in-process). Single-process Chromium.</p>
<h2>Status</h2>
<div class="stat"><span class="stat-label">Status</span><span class="badge ${stats.currentStatus === 'running' ? 'badge-ok' : stats.currentStatus === 'idle' ? 'badge-warn' : 'badge-err'}">${stats.currentStatus || 'unknown'}</span></div>
<div class="stat"><span class="stat-label">Questions Completed</span><span class="stat-value">${stats.questionsCompleted || 0}</span></div>
<div class="stat"><span class="stat-label">Cycles Run</span><span class="stat-value">${stats.cycleCount || 0}</span></div>
<div class="stat"><span class="stat-label">Uptime</span><span class="stat-value">${formatUptime(process.uptime())}</span></div>
<div class="stat"><span class="stat-label">Heap Used</span><span class="stat-value">${memInfo.heapUsed}</span></div>
<div class="stat"><span class="stat-label">RSS</span><span class="stat-value">${memInfo.rss} (${memInfo.rssPercent})</span></div>
<div class="stat"><span class="stat-label">Node.js</span><span class="stat-value">${process.version}</span></div>
<div class="stat"><span class="stat-label">Workers</span><span class="stat-value">0 (in-process)</span></div>
<div class="stat"><span class="stat-label">Platform</span><span class="stat-value">render-free-plan${IS_RENDER ? '' : ' (local)'}</span></div>
<h2>Links</h2>
<div class="stat"><span class="stat-label">Dashboard</span><span class="stat-value"><a href="${getDashboardLink(port)}">Open Dashboard</a></span></div>
<h2>API Endpoints</h2>
<ul>
<li><code>GET /health</code> — Health check (keepalive)</li>
<li><code>GET /dashboard</code> — Full dashboard UI</li>
<li><code>GET /api/full-status</code> — Combined status JSON</li>
<li><code>GET /api/health</code> — Deep health check</li>
<li><code>GET /api/providers</code> — Provider health</li>
<li><code>GET /api/metrics</code> — Performance metrics</li>
<li><code>GET /api/container</code> — Container module health</li>
</ul>
<div class="footer">MathU Bot v6 | Render Free Plan | All Features | ${formatUptime(process.uptime())} | ${new Date().toISOString()}</div>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── Health (lightweight, for keepalive ping) ──
  if (pathname === '/health') {
    try {
      const stateMachine = container.get('stateMachine');
      const stats = getStats();
      const memInfo = getMemoryInfo();
      const health = {
        status: 'ok',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        stats: { questionsCompleted: stats.questionsCompleted || 0, cycleCount: stats.cycleCount || 0 },
        memory: { ...memInfo, mode: memoryMode.getMode() },
        state: { current: stateMachine?.stateMachine?.getCurrentState?.() || null },
        platform: 'render-free-plan',
        isRender: IS_RENDER,
        features: 'all-enabled',
        workers: 'in-process',
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(health));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message || 'Health check failed' }));
    }
    return;
  }

  // ── API: Pixel Training Status ──
  if (pathname === '/api/training' && req.method === 'GET') {
    try {
      const pt = require('./pixel-training');
      const ss = require('./screenshot-storage');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        training: pt.getStatus(),
        storage: ss.getStatus(),
      }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: Training Data (for export / continual improvement) ──
  if (pathname === '/api/training/data' && req.method === 'GET') {
    try {
      const pt = require('./pixel-training');
      const db = require('./database').db;
      if (!db) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Database not available' }));
        return;
      }
      const url = new URL(req.url || '/', `http://${req.headers.host}`);
      const state = url.searchParams.get('state') || '';
      const limit = Math.min(100, parseInt(url.searchParams.get('limit') || '50', 10));

      let rows;
      if (state) {
        rows = db.prepare(
          'SELECT sample_id, state, action_type, x_percent, y_percent, success_count, provider, page_url_hash, screenshot_key, created_at FROM pixel_training_data WHERE state = ? ORDER BY success_count DESC, created_at DESC LIMIT ?'
        ).all(state, limit);
      } else {
        rows = db.prepare(
          'SELECT sample_id, state, action_type, x_percent, y_percent, success_count, provider, page_url_hash, screenshot_key, created_at FROM pixel_training_data ORDER BY success_count DESC, created_at DESC LIMIT ?'
        ).all(limit);
      }

      // Include external storage URLs for screenshot retrieval
      const ss = require('./screenshot-storage');
      const results = (rows as any[]).map((r: any) => ({
        ...r,
        screenshotUrl: r.screenshot_key ? ss.getPublicUrl(r.screenshot_key) : null,
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        total: results.length,
        stateFilter: state || 'all',
        data: results,
      }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── API: Upload screenshot manually (for training from external sources) ──
  if (pathname === '/api/training/upload' && req.method === 'POST') {
    try {
      const ss = require('./screenshot-storage');
      if (!ss.isEnabled()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'External storage not configured' }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: any) => chunks.push(chunk));
      req.on('end', async () => {
        const buf = Buffer.concat(chunks);
        const result = await ss.uploadScreenshot(buf, 'manual', {
          source: 'dashboard_upload',
          format: 'png',
          priority: 'high',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: !!result,
          key: result?.key || null,
          url: result?.url || null,
        }));
      });
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── 404 ──
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Start HTTP server FIRST (Render requirement) ──
const PORT = parseInt(process.env.PORT || '10000', 10);
server.listen(PORT, '0.0.0.0', () => {
  log(`MathU Bot v6 — Render Free Plan listening on port ${PORT}`, 'INFO', 'render-free-plan');
  log(`Dashboard available at http://localhost:${PORT}/dashboard`, 'INFO', 'render-free-plan');
  const t = memoryMode.getThresholds();
  log(`Mode: ${memoryMode.getMode()} | Memory: warn=${t.warnHeapMB}MB restart=${t.restartHeapMB}MB rss_hard=${t.rssHardLimitMB}MB gc=${t.gcIntervalMs / 1000}s`, 'INFO', 'render-free-plan');
});

// ── Heartbeat file ──
setInterval(() => {
  if (CONFIG.HEARTBEAT_FILE) {
    try { fs.writeFileSync(CONFIG.HEARTBEAT_FILE, String(Date.now())); } catch { /* best-effort */ }
  }
}, CONFIG.HEARTBEAT_INTERVAL_MS).unref();

// ═══════════════════════════════════════════════════════════════════════
// BACKGROUND TASKS (all enabled)
// ═══════════════════════════════════════════════════════════════════════

// IP check
if (CONFIG.ENABLE_IP_CHECK) {
  container.get('ipCheck', { required: false })?.checkIpLocation?.().catch(() => {});
}

// DB backup
container.get('dbBackup', { required: false })?.startScheduledBackup?.();

// ═══════════════════════════════════════════════════════════════════════
// MODEL EVOLUTION
// ═══════════════════════════════════════════════════════════════════════

const EVOLUTION_INTERVAL_DAYS = parseInt(process.env.EVOLUTION_INTERVAL_DAYS || '30', 10);
const EVOLUTION_TIMEOUT_MS = 4 * 60 * 1000;
let isEvolving = false;
let _evolutionStartTime = 0;

async function checkAndRunEvolution() {
  if (isEvolving) {
    if (_evolutionStartTime > 0 && (Date.now() - _evolutionStartTime) > EVOLUTION_TIMEOUT_MS) {
      log(
        `Model evolution stuck for ${Math.round((Date.now() - _evolutionStartTime) / 1000)}s — releasing mutex`,
        'ERROR',
        'render-free-plan'
      );
      isEvolving = false;
      _evolutionStartTime = 0;
      if (CONFIG.ALERT_ON_ERROR) {
        try { sendAlert('Model evolution timed out — mutex released'); } catch { /* non-critical */ }
      }
    } else {
      return;
    }
  }
  try {
    const row = selectCalibration.get('last_evolution_timestamp');
    const lastRun = row ? parseInt(row.value, 10) : 0;
    const daysSince = (Date.now() - lastRun) / (1000 * 60 * 60 * 24);
    if (daysSince >= EVOLUTION_INTERVAL_DAYS) {
      log(`Running model evolution (${daysSince.toFixed(1)} days since last)...`, 'INFO', 'render-free-plan');
      isEvolving = true;
      _evolutionStartTime = Date.now();
      try {
        const modelEvolution = container.get('modelEvolutionAdvanced', { required: false });
        if (modelEvolution) {
          const evolutionPromise = modelEvolution.evolveModelsAdvanced();
          const timeoutPromise = new Promise<null>(resolve =>
            setTimeout(() => resolve(null), EVOLUTION_TIMEOUT_MS)
          );
          const result = await Promise.race([evolutionPromise, timeoutPromise]);
          if (result === null) {
            log('Model evolution timed out', 'WARN', 'render-free-plan');
          } else {
            log(`Model evolution: ${result.success ? 'success' : result.message}`, 'INFO', 'render-free-plan');
          }
        }
        upsertCalibration.run('last_evolution_timestamp', String(Date.now()), Date.now());
      } catch (err: any) {
        logError('Model evolution failed', err);
      } finally {
        isEvolving = false;
        _evolutionStartTime = 0;
      }
    }
  } catch (err: any) { logError('Evolution check failed', err); }
}

setTimeout(() => checkAndRunEvolution().catch(() => {}), 5 * 60 * 1000).unref();
setInterval(() => checkAndRunEvolution().catch(() => {}), 6 * 60 * 60 * 1000).unref();

// Template cache pruning
const PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (safe for 32-bit)
if (typeof pruneTemplateCache === 'function') {
  try {
    setTimeout(() => { pruneTemplateCache(); }, 3600000).unref();
    setInterval(() => { pruneTemplateCache(); }, PRUNE_INTERVAL_MS).unref();
  } catch { /* best-effort */ }
}

// Autonomous features — only start lightweight ones on free plan
// container.get('reflection', { required: false })?.startReflectionScheduler?.();  // Heavy — disabled for memory
// container.get('strategyVariants', { required: false })?.runExperimentScheduler?.(); // Heavy — disabled for memory
container.get('anomalyDetector', { required: false })?.start?.();
// container.get('diary', { required: false })?.start?.();  // Accumulates data — disabled for memory
// container.get('coordinator', { required: false })?.startCoordinator?.();  // Heavy — disabled for memory
// container.get('resourceManager', { required: false })?.start?.();  // Heavy — disabled for memory

// Health checks
container.get('failsafeCoordinator', { required: false })?.startHealthChecks?.(60000);

// Remote config
container.get('remoteConfig', { required: false })?.loadRemoteConfig?.().catch(() => {});

// Turso cloud sync (graceful no-op if not configured)
try {
  const tursoSync = require('./database-turso');
  tursoSync.startTursoSync().then(() => {
    // After Turso pulls calibration data, check for OOM history.
    // On Render free plan, /tmp is wiped on restart so persistent-config is empty,
    // but Turso restores calibration entries including OOM markers and mode state.
    // v5 FIX: checkAfterTursoSync is now async (awaits browser cleanup)
    try {
      // v6 FIX: Re-run restart guardian after Turso sync.
      // init() runs BEFORE Turso sync, so on ephemeral disks it sees an
      // empty DB and misses all OOM history. Now that Turso has restored
      // the calibration table (including restart_guardian_history), re-check.
      try {
        const guardianRecheck = restartGuardian.recheckAfterTursoSync();
        if (guardianRecheck.activated) {
          log(`Post-Turso: restart guardian activated EMERGENCY MODE (${guardianRecheck.recentCount} restarts)`, 'ERROR', 'render-free-plan');
        } else if (guardianRecheck.recentCount > 0) {
          log(`Post-Turso: restart guardian found ${guardianRecheck.recentCount} unexpected restart(s)`, 'WARN', 'render-free-plan');
        }
      } catch (reErr: any) {
        log(`Post-Turso restart guardian recheck failed: ${reErr.message}`, 'WARN', 'render-free-plan');
      }

      // v6 FIX: Re-run OOM self-heal trigger after Turso sync.
      // Same boot-order problem: init() saw empty DB, now Turso has
      // restored process_lifecycle and restart history.
      try {
        const oomTrigger = require('./self-heal-oom-trigger');
        const oomRecheck = oomTrigger.recheckAfterTursoSync();
        if (oomRecheck.healScheduled) {
          log(`Post-Turso: OOM self-heal TRIGGERED (${oomRecheck.oomKillCount} OOM kills detected)`, 'ERROR', 'render-free-plan');
        }
      } catch (oomReErr: any) {
        log(`Post-Turso OOM trigger recheck failed: ${oomReErr.message}`, 'WARN', 'render-free-plan');
      }

      memoryMode.checkAfterTursoSync(selectCalibration, upsertCalibration).then(() => {
        if (memoryMode.isMemoryProtection()) {
          log(`Post-Turso OOM check: switched to ${memoryMode.getMode()} mode`, 'WARN', 'render-free-plan');
        }
      }).catch(() => {});
    } catch (e: any) {
      log(`Post-Turso OOM check failed: ${e.message}`, 'WARN', 'render-free-plan');
    }
  }).catch((err: any) => {
    log(`Turso sync failed to start: ${err.message}`, 'WARN', 'render-free-plan');
  });
} catch { /* module not found — skip */ }

// Startup smoke tests
const smokeResult = runStartupSmokeTests();
if (!smokeResult.passed && CONFIG.ALERT_ON_ERROR) {
  const failed = smokeResult.checks.filter((c: any) => !c.passed).map((c: any) => `${c.id}(${c.detail || '?'})`).join('; ');
  try { sendAlert(`Startup smoke tests failed: ${failed}`); } catch { /* non-critical */ }
}

// ═══════════════════════════════════════════════════════════════════════
// RE-APPLY PERSISTED FORCED STATE (if any)
// ═══════════════════════════════════════════════════════════════════════
try {
  const persistConfig = require('./persistent-config');
  const forced = persistConfig.getForcedState();
  if (forced) {
    const { forceState } = require('./state-machine');
    forceState(forced.state, `restored_from_persist:${forced.reason}`);
    log(`Restored persisted forced state: ${forced.state} (originally set: ${new Date(forced.forcedAt).toISOString()})`, 'WARN', 'render-free-plan');
  }
} catch { /* best-effort */ }

// ═══════════════════════════════════════════════════════════════════════
// WAIT FOR OOM BOOT HEAL BEFORE STARTING DAEMON
// ═══════════════════════════════════════════════════════════════════════
// If an OOM boot heal was scheduled (init or recheckAfterTursoSync),
// we MUST wait for it to complete before starting the cycle daemon.
// Without this wait, the daemon starts burning vision AI quota while
// the code-generation tribunal is still investigating the root cause.
//
// The oom-trigger module handles the full flow:
//   1. Runtime heal (clear stuck state)
//   2. Code-patch pipeline via generateCodeFixViaTribunal()
//   3. triggerImmediateRedeploy() → push to GitHub → Render deploy
//   4. Wait for SIGTERM (Render replacing this instance)
//
// waitForBootHeal() returns when all of the above completes.
// If the heal succeeded and triggered a redeploy, the SIGTERM will
// kill this process before we reach startDaemon().
(async () => {
  try {
    const oomTrigger = require('./self-heal-oom-trigger');
    if (oomTrigger.isBootHealInProgress?.()) {
      log('OOM boot heal in progress — WAITING before starting daemon (code-gen tribunal running)...', 'WARN', 'render-free-plan');
      const healResult = await oomTrigger.waitForBootHeal();
      log(`OOM boot heal completed: result=${healResult.result}, waited=${healResult.waited}ms`, healResult.result === 'success' ? 'INFO' : 'WARN', 'render-free-plan');
    }
  } catch (waitErr: any) {
    log(`OOM heal wait failed (non-fatal, starting daemon): ${waitErr.message}`, 'WARN', 'render-free-plan');
  }

  // ═══════════════════════════════════════════════════════════════════════
  // START THE DAEMON (non-blocking — runs in background)
  // ═══════════════════════════════════════════════════════════════════════

  log('Starting daemon loop (background, all features)...', 'INFO', 'render-free-plan');
  startDaemon().catch(err => {
    logError('Fatal daemon error', err);
    if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Fatal daemon error: ${err.message}`); } catch { /* non-critical */ }
    log('Daemon crashed — will restart on next cycle iteration', 'ERROR', 'render-free-plan');
  });

  log('MathU Bot v6 — Render Free Plan fully started (all features, no workers)', 'INFO', 'render-free-plan');
})();
