'use strict';

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n// MathU Bot v6 \u2014 Render Free Plan Entry Point (FULL FEATURES)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Designed for Render free tier: 512 MB RAM, ephemeral disk,
// spins down after 15 min inactivity, cold starts ~30s.
//
// ALL features are kept enabled. Memory savings come from:
//   1. No worker threads (saves ~90-150 MB \u2014 3 workers \u00d7 30-50 MB each)
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
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

require('./error-handler');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROJECT_ROOT } = require('./project-root');

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// RENDER DETECTION
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Expose RENDER_SERVICE_ID so downstream modules can detect Render
// without duplicating the check. This is set once at startup before
// any modules are loaded.
if (!process.env.RENDER_SERVICE_ID) {
  // Best-effort detection: if running as render-free-plan.ts entry point,
  // we ARE on Render. Some env vars may not be set on very first deploy
  // so we also check RENDER (set by Render for all services).
  if (process.env.RENDER) {
    process.env.RENDER_SERVICE_ID = 'detected-free-plan';
  }
}

const IS_RENDER = !!(process.env.RENDER_SERVICE_ID || process.env.RENDER);

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// PRE-STARTUP: Set Render-friendly defaults BEFORE any module loads
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

const DATA_DIR = os.tmpdir();

// Paths \u2014 all under /tmp (ephemeral, but writable)
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
if (!process.env.REGRESSION_BANK_DIR)   process.env.REGRESSION_BANK_DIR   = path.join(DATA_DIR, 'mathu-regression');

// Memory \u2014 only set MAX_MEMORY_MB if not already set.
// WARNING_THRESHOLD and RESTART_THRESHOLD are NOT set here.
// They have correct defaults in config.ts (350 and 360 for Render).
// Setting them here risks conflicting with a user-overridden MAX_MEMORY_MB
// in the Render dashboard, causing validation failure (Bug #6).
if (!process.env.MAX_MEMORY_MB) process.env.MAX_MEMORY_MB = '448';

// Post-set consistency guard: ensure thresholds are always valid
// relative to whatever MAX_MEMORY_MB ends up being (Dockerfile, dashboard,
// or default).  This prevents the config.ts validation from killing the
// container if the user sets MAX_MEMORY_MB lower in the Render dashboard.
(function ensureMemoryThresholdConsistency() {
  const maxMem = parseInt(process.env.MAX_MEMORY_MB || '448', 10);
  const restartThr = parseInt(process.env.MEMORY_RESTART_THRESHOLD_MB || '0', 10);
  const warnThr = parseInt(process.env.MEMORY_WARNING_THRESHOLD_MB || '0', 10);
  // If thresholds aren't set, let config.ts defaults handle it.
  // If they ARE set but violate the constraints, fix them here.
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
if (!process.env.MAX_UPTIME_HOURS)           process.env.MAX_UPTIME_HOURS = '0';      // never force restart
if (!process.env.MAX_CYCLES_BEFORE_RESTART)  process.env.MAX_CYCLES_BEFORE_RESTART = '999999';;

// Logging \u2014 keep it reasonable (no persistent disk)
if (!process.env.LOG_LEVEL)       process.env.LOG_LEVEL = 'info';
if (!process.env.LOG_MAX_FILES)   process.env.LOG_MAX_FILES = '2';
if (!process.env.LOG_MAX_SIZE_MB) process.env.LOG_MAX_SIZE_MB = '10';

// Chromium \u2014 single-process saves 50-80 MB vs multi-process
// BUG FIX (Response 18): CHROMIUM_FLAGS is now the authoritative source.
// browser-chrome-flags.ts deduplicates against this prefix set, so we
// must NOT include flags that browser-chrome-flags already handles
// (like --no-sandbox, --disable-dev-shm-usage, --disable-gpu).
// Only set Render-specific flags here that browser-chrome-flags would
// not normally add (single-process, JS heap cap, optimize-for-size).
if (!process.env.CHROMIUM_FLAGS) {
  process.env.CHROMIUM_FLAGS =
    '--no-sandbox --disable-setuid-sandbox --disable-dev-shm-usage '
    + '--disable-gpu --disable-software-rasterizer '
    + '--disable-extensions --disable-background-networking '
    + '--disable-default-apps --disable-sync '
    + '--disable-translate --disable-component-extensions-with-background-pages '
    + '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,'
    + 'MediaRouter,DialMediaRouteProvider,CalculateNativeWinOcclusion '
    + '--js-flags=--max-old-space-size=128 --optimize-for-size '
    + '--single-process';
}

// Ensure directories exist
for (const dir of [
  process.env.LOG_DIR, process.env.USER_DATA_DIR,
  process.env.SELF_HEAL_BACKUP_DIR, process.env.SELF_HEAL_STAGING_DIR,
  process.env.REGRESSION_BANK_DIR, process.env.SCREENSHOT_DIR,
]) {
  try { fs.mkdirSync(dir!, { recursive: true }); } catch { /* best-effort */ }
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// LOAD MODULES
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

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

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// SUBSYSTEMS: Start ALL of them (full feature set)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

// Longevity subsystems
startSubsystemGroup('longevity');

// Seed initial active model if needed
const { getActiveModel, upsertModel } = require('./database');
const active = getActiveModel.get();
if (!active) {
  log('Seeding initial active model: openrouter/free', 'INFO', 'render-free-plan');
  upsertModel.run('openrouter', 'openrouter/free', 1, 1, 'active', Date.now(), Date.now(), 0);
}

// Self-Heal v2 subsystems (all enabled)
startSelfHealV2Subsystems(CONFIG);

// Resilience subsystems (survival, runtime, progress, economy, policy, auth, network)
startResilienceSubsystems();

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// WORKER FALLBACK: Start rewardTracker in-process
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Workers are skipped on 512 MB (saves ~90-150 MB). The in-process
// modules for metrics and diary are already active via the container.
// rewardTracker is skipped by startSelfHealV2Subsystems (WORKER_BACKED
// set), so we start it manually here.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
log('Render: Running all subsystems in-process (no worker threads, saves ~90-150 MB)', 'INFO', 'render-free-plan');
try {
  const rtMod = container.get('rewardTracker', { required: false });
  if (rtMod && typeof rtMod.start === 'function') {
    rtMod.start(60 * 60 * 1000); // 1-hour survival check interval
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

// HEALTH WATCHDOG - Self-ping with scoring + auto-restart (Response 2)
try {
  const healthWatchdog = container.get('healthWatchdog', { required: false });
  if (healthWatchdog && typeof healthWatchdog.start === 'function') {
    healthWatchdog.start({
      onLevelChange: (from, to, state) => {
        log('Health watchdog: ' + from + ' -> ' + to + ' (score: ' + state.score + '/12)', 'WARN', 'render-free-plan');
        if (to === 'critical' || to === 'fatal') {
          try { sendAlert('Health level ' + to + ': score=' + state.score + '/12'); } catch {}
        }
      },
    });
    log('Health watchdog started', 'INFO', 'render-free-plan');
  }

  // Start degradation ladder periodic evaluation (Response 3)
  const degradationLadder = container.get('degradationLadder', { required: false });
  if (degradationLadder && typeof degradationLadder.start === 'function') {
    degradationLadder.start(60000); // evaluate every 60s
    log('Degradation ladder started (periodic eval every 60s)', 'INFO', 'render-free-plan');
  }

  // Start work shift scheduler (Response 7)
  try {
    const workShifts = container.get('workShifts', { required: false });
    if (workShifts && typeof workShifts.start === 'function') {
      workShifts.start(60000); // evaluate every 60s (same cadence as degradation ladder)
      log('Work shift scheduler started (eval every 60s)', 'INFO', 'render-free-plan');
    }
  } catch (e) {
    log('Work shift scheduler failed to start: ' + (e as any).message, 'WARN', 'render-free-plan');
  }

  // API key vault — validate all keys on startup + every 6h (Response 8)
  try {
    const vault = container.get('apiKeyVault', { required: false });
    if (vault && typeof vault.start === 'function') {
      vault.start(6 * 60 * 60 * 1000); // validate every 6 hours
      log('API key vault started (validate every 6h)', 'INFO', 'render-free-plan');
    }
  } catch (e) {
    log('API key vault failed to start: ' + (e as any).message, 'WARN', 'render-free-plan');
  }

  // FIX: Provider diagnostic — log exactly which providers loaded and why some are unavailable
  // This runs BEFORE the daemon loop starts, so any provider=0 issue is visible immediately
  try {
    const registry = require('./providers-registry');
    if (typeof registry.logProviderDiagnostic === 'function') {
      registry.logProviderDiagnostic();
    }
  } catch (e) {
    log('Provider diagnostic failed: ' + (e as any).message, 'WARN', 'render-free-plan');
  }

  // Contextual alert manager — proactive NTFY alerts based on state (Response 8)
  try {
    const alerts = container.get('contextualAlerts', { required: false });
    if (alerts && typeof alerts.start === 'function') {
      alerts.start(120000); // evaluate every 2 min
      log('Contextual alert manager started (eval every 2min)', 'INFO', 'render-free-plan');
    }
  } catch (e) {
    log('Contextual alert manager failed to start: ' + (e as any).message, 'WARN', 'render-free-plan');
  }

  // Cold start detection (Response 6)
  try {
    const coldStart = container.get('coldStart', { required: false });
    if (coldStart && typeof coldStart.detectColdStart === 'function') {
      const csInfo = coldStart.detectColdStart();
      if (csInfo.isColdStart) {
        log(`Cold start detected: ${csInfo.reason}`, 'WARN', 'render-free-plan');
        // Start last-seen updates so next cold start is detectable
        coldStart.startLastSeenUpdates();
      } else {
        log(`Startup type: ${csInfo.startupType} — ${csInfo.reason}`, 'INFO', 'render-free-plan');
        coldStart.startLastSeenUpdates();
      }
    }
  } catch (e) {
    log('Cold start detection failed: ' + (e as any).message, 'WARN', 'render-free-plan');
  }

  // /tmp disk guardian (Response 6)
  try {
    const tmpGuardian = container.get('tmpGuardian', { required: false });
    if (tmpGuardian && typeof tmpGuardian.start === 'function') {
      tmpGuardian.start();
      log('/tmp disk guardian started', 'INFO', 'render-free-plan');
    }
  } catch (e) {
    log('/tmp disk guardian start failed: ' + (e as any).message, 'WARN', 'render-free-plan');
  }
} catch (e) {
  log('Health watchdog / degradation ladder start failed: ' + e.message, 'WARN', 'render-free-plan');
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// KEEPALIVE PINGER \u2014 Prevents Render 15-min spin-down
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Render free plan spins down after 15 minutes of no HTTP traffic.
// Self-ping every 4 minutes keeps the service permanently awake.
// Optional: set KEEPALIVE_PING_URL to a UptimeRobot/cron-job.org URL
// for an external backup ping.
//
// BUG FIX (Response 18): External ping now uses 'http' or 'https'
// based on the URL protocol instead of always requiring 'https'.
// This allows pinging HTTP-based cron monitors too.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

const KEEPALIVE_INTERVAL_MS = 3.5 * 60 * 1000;  // 3.5 min (was 4 min) — tighter margin against 15-min spin-down
const EXTERNAL_PING_URL = process.env.KEEPALIVE_PING_URL || '';
// Maximum consecutive keepalive failures before logging at ERROR level
// instead of WARN. Prevents log spam during network blips.
const KEEPALIVE_ERROR_THRESHOLD = 5;

let _keepaliveFailCount = 0;

function selfPing() {
  const port = process.env.PORT || '10000';
  const req = http.get(`http://localhost:${port}/health`, (res: any) => {
    // Consume response body to free the socket
    res.resume();
    res.on('end', () => {
      _keepaliveFailCount = 0;
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
}

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
    }, () => {
      // Consume response to free socket
    });
    req.on('error', () => {});
    req.setTimeout(10000, () => { req.destroy(); });
  } catch {
    // URL parse failure \u2014 non-critical
  }
}

function keepaliveLoop() {
  selfPing();
  externalPing();
}

// BUG FIX (Response 18): First keepalive fires at 30s, but Render's
// spin-down timer starts from the last HTTP request. During cold
// start, the 30s gap is fine (Render gives 15 min). However, if
// the daemon takes long to initialize, the first interval tick may
// be delayed. We now log the first successful keepalive.
let _firstKeepaliveLogged = false;
const _origSelfPing = selfPing;
// Wrap to log first success (only once, minimal overhead)
const _selfPingWrapped = function() {
  const port = process.env.PORT || '10000';
  const req = http.get(`http://localhost:${port}/health`, (res: any) => {
    res.resume();
    res.on('end', () => {
      _keepaliveFailCount = 0;
      if (!_firstKeepaliveLogged) {
        _firstKeepaliveLogged = true;
        log('First keepalive ping succeeded \u2014 Render spin-down prevented', 'INFO', 'keepalive');
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
}, 15000);  // 15s initial delay (was 30s) — health server is ready faster now

log(
  `Keepalive system started (interval: ${KEEPALIVE_INTERVAL_MS / 1000}s, external: ${EXTERNAL_PING_URL ? 'enabled' : 'disabled'})`,
  'INFO',
  'render-free-plan'
);

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// SHUTDOWN HANDLING \u2014 Recovery, not exit
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

let isShuttingDown = false;
const originalExit = process.exit.bind(process);
(process as any).exit = (code?: number) => {
  if (isShuttingDown) { originalExit(code || 0); return; }
  log(`process.exit(${code}) intercepted \u2014 attempting recovery instead of dying`, 'WARN', 'render-free-plan');
  if (CONFIG.ALERT_ON_ERROR) {
    try { sendAlert(`process.exit(${code}) intercepted, recovering...`); } catch { /* non-critical */ }
  }
};

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`Received ${signal} \u2014 shutting down gracefully...`, 'INFO', 'render-free-plan');
  requestStop();
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
      // Timeout browser close to prevent shutdown hanging on disconnected process
      await Promise.race([
        browserMod.closeBrowser(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Browser close timed out')), 8000))
      ]).catch((err: any) => { log(`Browser close error (non-fatal): ${err.message}`, 'WARN', 'render-free-plan'); });
    }
  } catch { /* best effort */ }
}, 1);
registerShutdownHook(async () => {
  log('Flushing pixel calibration data...', 'INFO', 'render-free-plan');
  try {
    const pixelCal = require('./pixel-calibration');
    await pixelCal.flush();
  } catch { /* best effort */ }
}, 3);
registerShutdownHook(async () => {
  log('Closing database...', 'INFO', 'render-free-plan');
  try { closeDatabase(); } catch { /* best effort */ }
}, 4);

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// MEMORY MANAGEMENT \u2014 Tuned for 512 MB
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

let _memoryWarningCount = 0;

// BUG FIX (Response 18): RSS hard limit. On Render, if RSS exceeds
// 470 MB the OOM killer will terminate the process without warning.
// We now also track RSS trend (rising vs stable) to avoid closing
// the browser when RSS is temporarily high due to page load.
let _lastRss = 0;
const RSS_HARD_LIMIT_MB = 470;

// Scheduled GC every 3 minutes to keep heap lean
setInterval(() => {
  if (isShuttingDown) return;
  if (global.gc) {
    try { global.gc(); } catch { /* ignore */ }
  }
}, 3 * 60 * 1000).unref();

// Reactive memory monitoring every 30 seconds
setInterval(() => {
  if (isShuttingDown) return;
  const mem = process.memoryUsage();
  const used = mem.heapUsed / 1024 / 1024;
  const rss = mem.rss / 1024 / 1024;

  if (used > CONFIG.MEMORY_RESTART_THRESHOLD_MB || rss > RSS_HARD_LIMIT_MB) {
    // Critical: close browser + force GC
    log(`Memory critical: heap=${used.toFixed(0)}MB rss=${rss.toFixed(0)}MB \u2014 closing browser + GC`, 'WARN', 'render-free-plan');
    try {
      const browserMod = container.get('browser', { required: false });
      if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
        browserMod.browserManager.cleanup().catch(() => {});
      }
    } catch { /* best effort */ }
    if (global.gc) { try { global.gc(); } catch { /* ignore */ } }
    _memoryWarningCount = 0;
    _lastRss = rss;
  } else if (used > CONFIG.MEMORY_WARNING_THRESHOLD_MB) {
    _memoryWarningCount++;
    if (_memoryWarningCount >= 3) {
      log(`Memory warning persistent (${_memoryWarningCount}/3): heap=${used.toFixed(0)}MB \u2014 closing browser`, 'WARN', 'render-free-plan');
      try {
        const browserMod = container.get('browser', { required: false });
        if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
          browserMod.browserManager.cleanup().catch(() => {});
        }
      } catch { /* best effort */ }
      if (global.gc) { try { global.gc(); } catch { /* ignore */ } }
      _memoryWarningCount = 0;
      _lastRss = rss;
    } else {
      const rssTrend = _lastRss > 0 ? (rss - _lastRss > 10 ? 'rising' : 'stable') : 'unknown';
      log(
        `Memory warning: heap=${used.toFixed(0)}MB rss=${rss.toFixed(0)}MB [${_memoryWarningCount}/3] trend=${rssTrend}`,
        'WARN',
        'render-free-plan'
      );
    }
  } else {
    _memoryWarningCount = 0;
  }
  _lastRss = rss;
}, 30000).unref();

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// HTTP SERVER \u2014 Render requires listening on $PORT
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

const DASHBOARD_ALLOWED_ORIGINS = process.env.DASHBOARD_ALLOWED_ORIGINS
  ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
  : ['*'];

// ── Screenshot cache (for /api/screenshot endpoint) ──
let _latestScreenshot: { screenshot: string; timestamp: number; action?: any } | null = null;

function setLatestScreenshot(base64Jpeg: string, action?: any) {
  // Cap at ~500KB to avoid memory bloat on 512MB instance
  if (base64Jpeg.length > 500_000) return;
  _latestScreenshot = { screenshot: base64Jpeg, timestamp: Date.now(), action };
}

function getLatestScreenshot() {
  // Expire after 120 seconds
  if (_latestScreenshot && Date.now() - _latestScreenshot.timestamp > 120_000) {
    _latestScreenshot = null;
  }
  return _latestScreenshot;
}

// Expose globally so cycle manager can call it
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

// BUG FIX (Response 18): RSS memory on status page + Render detection flag
function getMemoryInfo() {
  const mem = process.memoryUsage();
  return {
    heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
    heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(0) + 'MB',
    rss: (mem.rss / 1024 / 1024).toFixed(0) + 'MB',
    rssPercent: ((mem.rss / (512 * 1024 * 1024)) * 100).toFixed(1) + '%',
  };
}

const server = http.createServer(async (req: any, res: any) => {
  // BUG FIX (Response 18): Only set CORS for actual allowed origins
  // instead of blindly echoing req.headers.origin (which could be
  // anything). If DASHBOARD_ALLOWED_ORIGINS is ['*'], allow all.
  const requestOrigin = req.headers.origin || '';
  if (DASHBOARD_ALLOWED_ORIGINS.includes('*') || DASHBOARD_ALLOWED_ORIGINS.includes(requestOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', requestOrigin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ── Root: full control dashboard (from dashboard-server module) ──
  if (pathname === '/' || pathname === '/index.html') {
    try {
      const dashMod = require('./dashboard-server');
      const html = dashMod._getDashboardHTML
        ? dashMod._getDashboardHTML()
        : null;
      if (html && html.length > 100) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
        return;
      }
    } catch { /* fall through to minimal fallback */ }
    // Minimal fallback if dashboard-server not available
    const stats = getStats();
    const memInfo = getMemoryInfo();
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>MathU Bot v6</title>
<style>body{font-family:system-ui,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#e5e7eb;background:#111827}
.stat{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1f2937}
.stat-label{color:#9ca3af}.stat-value{color:#60a5fa;font-weight:600}
</style></head><body>
<h1>MathU Bot v6</h1>
<div class="stat"><span class="stat-label">Status</span><span class="stat-value">${stats.currentStatus||'unknown'}</span></div>
<div class="stat"><span class="stat-label">Cycles</span><span class="stat-value">${stats.cycleCount||0}</span></div>
<div class="stat"><span class="stat-label">Heap</span><span class="stat-value">${memInfo.heapUsed}</span></div>
<div class="stat"><span class="stat-label">RSS</span><span class="stat-value">${memInfo.rss}</span></div>
<div class="stat"><span class="stat-label">Uptime</span><span class="stat-value">${formatUptime(process.uptime())}</span></div>
</body></html>`);
    return;
  }

  // \u2500\u2500 Health \u2500\u2500
  if (pathname === '/health' || pathname === '/api/health') {
    const stateMachine = container.get('stateMachine');
    const stats = getStats();
    const memInfo = getMemoryInfo();
    // Include health watchdog score (Response 2)
    const watchdog = container.get('healthWatchdog', { required: false });
    const watchdogHealth = watchdog?.getHealth?.() || null;
    // Include degradation level (Response 3)
    const degradationLadder = container.get('degradationLadder', { required: false });
    const degradationInfo = degradationLadder?.getLastCalculation?.() || null;
    // Include /tmp guardian status (Response 6)
    const tmpGuardian = container.get('tmpGuardian', { required: false });
    const tmpGuardianStatus = tmpGuardian?.getStatus?.() || null;
    // Include cold start info (Response 6)
    const coldStart = container.get('coldStart', { required: false });
    const coldStartStatus = coldStart?.getStatus?.() || null;
    const health = {
      status: watchdogHealth ? watchdogHealth.level : 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      stats: { questionsCompleted: stats.questionsCompleted || 0, cycleCount: stats.cycleCount || 0 },
      memory: memInfo,
      state: { current: stateMachine?.stateMachine?.getCurrentState?.() || null },
      platform: 'render-free-plan',
      isRender: IS_RENDER,
      features: 'all-enabled',
      workers: 'in-process',
      healthWatchdog: watchdogHealth ? {
        score: watchdogHealth.score,
        level: watchdogHealth.level,
        checks: watchdogHealth.checks,
        totalRestarts: watchdogHealth.totalRestarts,
        inExtendedSleep: watchdogHealth.inExtendedSleep,
      } : null,
      degradation: degradationInfo ? {
        level: degradationInfo.level,
        name: degradationInfo.name,
        providerCount: degradationInfo.providerCount,
        visionProviderCount: degradationInfo.visionProviderCount,
        orBudgetPct: degradationInfo.orBudgetPct,
        reasons: degradationInfo.reasons,
      } : null,
      tmpGuardian: tmpGuardianStatus ? {
        usagePct: Math.round(tmpGuardianStatus.usagePct * 100),
        usedMB: tmpGuardianStatus.usedMB,
        totalMB: tmpGuardianStatus.totalMB,
        lastPruneLevel: tmpGuardianStatus.lastPruneLevel,
        checks: tmpGuardianStatus.checks,
        prunes: tmpGuardianStatus.prunes,
      } : null,
      coldStart: coldStartStatus ? {
        startupType: coldStartStatus.startupType,
        isColdStart: coldStartStatus.isColdStart,
        gapMinutes: coldStartStatus.gapMinutes,
        lastSeenAt: coldStartStatus.lastSeenAt,
      } : null,
      workShift: (() => {
        try {
          const ws = require('./services-work-shifts');
          const shift = ws.getShift();
          return {
            current: shift.current,
            reason: shift.reason,
            fullCycle: ws.shouldRunFullCycle(),
          };
        } catch { return null; }
      })(),
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  // ── Heartbeat (Response 8) — UptimeRobot-compatible external monitoring ──
  if (pathname === '/api/health/heartbeat') {
    try {
      const heartbeat = require('./services-heartbeat-endpoint');
      const payload = await heartbeat.getHeartbeat();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    } catch (e: any) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: e.message }));
    }
    return;
  }

  // \u2500\u2500 Status \u2500\u2500
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStats()));
    return;
  }

  // \u2500\u2500 Metrics \u2500\u2500
  if (pathname === '/api/metrics') {
    const metricsMod = container.get('metrics', { required: false });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metricsMod?.metrics?.getSummary?.() || {}));
    return;
  }

  // \u2500\u2500 Container health \u2500\u2500
  if (pathname === '/api/container') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getContainerHealth()));
    return;
  }

  // ── Screenshot (live view for dashboard) ──
  if (pathname === '/api/screenshot') {
    const shot = getLatestScreenshot();
    if (!shot) {
      res.writeHead(204, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ available: true, timestamp: shot.timestamp, action: { actionType: shot.action?.actionType, currentState: shot.action?.currentState, reasoning: shot.action?.reasoning?.substring(0, 200) }, screenshot: shot.screenshot }));
    return;
  }

  // ── Provider health details ──
  if (pathname === '/api/providers') {
    try {
      const healthMod = require('./providers-health');
      const registryMod = require('./providers-registry');
      const providers = registryMod.getAvailableProviders ? await registryMod.getAvailableProviders() : [];
      const healthDetails = providers.map((p: any) => {
        const snapshot = healthMod.getHealthSnapshot?.(p.name) || {};
        return {
          name: p.name,
          healthScore: p.healthScore,
          totalCalls: snapshot.totalCalls || 0,
          successRate: snapshot.successRate || 0,
          avgLatencyMs: snapshot.avgLatencyMs || 0,
          isAvailable: healthMod.isProviderAvailable?.(p.name) ?? true,
          circuitBreaker: snapshot.circuitBreakerState || 'closed',
        };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      // FIX: Include load failures in provider response for diagnostics
      const loadFailures = registryMod.getLoadFailures ? registryMod.getLoadFailures() : [];
      res.end(JSON.stringify({ providers: healthDetails, loadFailures, providerCount: healthDetails.length, timestamp: Date.now() }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Banned actions management ──
  if (pathname === '/api/banned-actions' && req.method === 'GET') {
    try {
      const { listBannedActions } = require('./database');
      const rows = listBannedActions();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/banned-actions' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', (chunk: any) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.action_type) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'action_type is required' }));
            return;
          }
          const { insertBannedAction } = require('./database');
          insertBannedAction(data.action_type, 'dashboard', Date.now(), data.reason || 'Manual ban via dashboard');
          log(`Action banned via dashboard: ${data.action_type} (${data.reason || 'no reason'})`, 'WARN', 'dashboard');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, banned: data.action_type }));
        } catch (parseErr: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  if (pathname === '/api/banned-actions' && req.method === 'DELETE') {
    try {
      let body = '';
      req.on('data', (chunk: any) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.action_type) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'action_type is required' }));
            return;
          }
          const { deleteBannedAction } = require('./database');
          deleteBannedAction(data.action_type);
          log(`Action unbanned via dashboard: ${data.action_type}`, 'INFO', 'dashboard');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, unbanned: data.action_type }));
        } catch (parseErr: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Set state manually ──
  if (pathname === '/api/set-state' && req.method === 'POST') {
    try {
      let body = '';
      req.on('data', (chunk: any) => { body += chunk; });
      req.on('end', () => {
        try {
          const data = JSON.parse(body);
          if (!data.state || typeof data.state !== 'string') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'state is required' }));
            return;
          }
          const { upsertLastState } = require('./database');
          upsertLastState('manual://dashboard', data.state.substring(0, 100), Date.now());
          log(`State set via dashboard: ${data.state}`, 'INFO', 'dashboard');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: true, state: data.state }));
        } catch (parseErr: any) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Invalid JSON' }));
        }
      });
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Full status (for dashboard) ──
  if (pathname === '/api/full-status') {
    const stats = getStats();
    const memInfo = getMemoryInfo();
    const shot = getLatestScreenshot();
    try {
      const healthMod = require('./providers-health');
      const registryMod = require('./providers-registry');
      const providers = registryMod.getAvailableProviders ? await registryMod.getAvailableProviders() : [];
      const providerSummary = providers.map((p: any) => ({
        name: p.name,
        healthScore: p.healthScore,
        isAvailable: healthMod.isProviderAvailable?.(p.name) ?? true,
      }));
      // FIX: Include provider load failures and count in full status
      const loadFailures = registryMod.getLoadFailures ? registryMod.getLoadFailures() : [];
      const providerCount = registryMod.getAvailableProviderCount ? registryMod.getAvailableProviderCount() : 0;
      // Include daemon running state
      let daemonState = { stopRequested: false };
      try { const orch = require('./cycle-orchestrator'); daemonState = { stopRequested: !!orch._stopRequested }; } catch {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ...stats,
        daemon: daemonState,
        memory: memInfo,
        uptime: process.uptime(),
        platform: 'render-free-plan',
        screenshotAvailable: !!shot,
        providers: providerSummary,
        providerLoadFailures: loadFailures,
        providerCount,
        timestamp: Date.now(),
        degradation: degradationLadder?.getLastCalculation?.() ? {
          level: degradationLadder.getLastCalculation().level,
          name: degradationLadder.getLastCalculation().name,
          providerCount: degradationLadder.getLastCalculation().providerCount,
          visionProviderCount: degradationLadder.getLastCalculation().visionProviderCount,
          orBudgetPct: degradationLadder.getLastCalculation().orBudgetPct,
        } : null,
        workShifts: (() => {
          try {
            const ws = require('./services-work-shifts');
            const shift = ws.getShift();
            return {
              current: shift.current,
              previous: shift.previous,
              reason: shift.reason,
              timeSignal: shift.timeSignal,
              resourceSignal: shift.resourceSignal,
              cyclesInCurrentShift: shift.cyclesInCurrentShift,
              totalActiveHours: Math.round(shift.totalActiveMs / (1000 * 60 * 60) * 10) / 10,
              totalCyclesActive: shift.totalCyclesActive,
              lastEvalAt: shift.lastEvalAt,
            };
          } catch { return null; }
        })(),
        actionCache: (() => {
          try {
            const ac = require('./services-action-cache');
            return ac.getStats();
          } catch { return null; }
        })(),
      }));
    } catch (e: any) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ...stats, memory: memInfo, uptime: process.uptime(), timestamp: Date.now() }));
    }
    return;
  }


  // ── Live screenshot (capture right now) ──
  if (pathname === '/api/screenshot/live') {
    try {
      const browserMod = require('./browser');
      const page = browserMod.browserManager?.getPage?.() || browserMod.browserManager?.pageInstance;
      if (!page || page.isClosed()) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ available: false, error: 'Browser not available' }));
        return;
      }
      const buf = await page.screenshot({ type: 'jpeg', quality: 40 });
      let jpeg = buf.toString('base64');
      try { const compressed = await browserMod.compressScreenshot?.(jpeg, 800, 30); if (compressed) jpeg = compressed; } catch {}
      if (jpeg.length > 300_000) jpeg = jpeg.substring(0, 300_000);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: true, timestamp: Date.now(), screenshot: jpeg }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ available: false, error: e.message }));
    }
    return;
  }

  // ── Daemon state ──
  if (pathname === '/api/daemon') {
    let daemonState = { running: true, stopRequested: false };
    try { const orch = require('./cycle-orchestrator'); daemonState = { running: true, stopRequested: !!orch._stopRequested }; } catch { daemonState = { running: false, stopRequested: false }; }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(daemonState));
    return;
  }

  // ── Resume daemon ──
  if (pathname === '/api/daemon/resume' && req.method === 'POST') {
    try {
      const { resumeDaemon } = require('./cycle-orchestrator');
      resumeDaemon();
      log('Daemon resumed via dashboard', 'INFO', 'dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Daemon resumed' }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Force state (via state-machine) ──
  if (pathname === '/api/force-state' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        if (!data.state || typeof data.state !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'state is required' }));
          return;
        }
        const { forceState } = require('./state-machine');
        forceState(data.state, 'dashboard_admin');
        log(`State forced via dashboard: ${data.state}`, 'WARN', 'dashboard');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, state: data.state }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  // ── Available states list ──
  if (pathname === '/api/states') {
    try {
      const sm = require('./state-machine');
      const states = Object.values(sm.STATES || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ states }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Available actions list ──
  if (pathname === '/api/actions') {
    try {
      const sm = require('./state-machine');
      const actions = Object.keys(sm.ACTIONS || {});
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ actions }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Clear action cache ──
  if (pathname === '/api/action-cache/clear' && req.method === 'POST') {
    try {
      const ac = require('./services-action-cache');
      ac.clear();
      log('Action cache cleared via dashboard', 'INFO', 'dashboard');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
    } catch (e: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Set config (safe keys only) ──
  if (pathname === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => { body += chunk; });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const SAFE_KEYS = new Set(['SLEEP_MIN_HOURS','SLEEP_MAX_HOURS','MAX_CYCLES_BEFORE_RESTART','MAX_CONSECUTIVE_FAILURES','VISION_PRIORITY','ALERT_ON_ERROR','ALERT_ON_STAGNATION','OPENROUTER_TRIBUNAL_MODEL']);
        if (!SAFE_KEYS.has(data.key)) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Config key not allowed' }));
          return;
        }
        const { updateConfig } = require('./get-config');
        updateConfig(data.key, data.value);
        log(`Config changed via dashboard: ${data.key} = ${data.value}`, 'INFO', 'dashboard');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, key: data.key, value: data.value }));
      } catch (e: any) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e.message }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// \u2500\u2500 Start HTTP server FIRST (Render requirement) \u2500\u2500
const PORT = parseInt(process.env.PORT || '10000', 10);
server.listen(PORT, '0.0.0.0', () => {
  log(`MathU Bot v6 \u2014 Render Free Plan (all features) listening on port ${PORT}`, 'INFO', 'render-free-plan');
  log(`Memory: warn=${CONFIG.MEMORY_WARNING_THRESHOLD_MB}MB, restart=${CONFIG.MEMORY_RESTART_THRESHOLD_MB}MB, rss_hard=${RSS_HARD_LIMIT_MB}MB, workers=in-process`, 'INFO', 'render-free-plan');
});

// \u2500\u2500 Heartbeat file \u2500\u2500
setInterval(() => {
  if (CONFIG.HEARTBEAT_FILE) {
    try { fs.writeFileSync(CONFIG.HEARTBEAT_FILE, String(Date.now())); } catch { /* best-effort */ }
  }
}, CONFIG.HEARTBEAT_INTERVAL_MS).unref();

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// BACKGROUND TASKS (all enabled)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

// IP check
if (CONFIG.ENABLE_IP_CHECK) {
  container.get('ipCheck', { required: false })?.checkIpLocation?.().catch(() => {});
}

// DB backup
container.get('dbBackup', { required: false })?.startScheduledBackup?.();

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// MODEL EVOLUTION
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// BUG FIX (Response 18): Model evolution now has a dedicated timeout
// and mutex guard. On Render's slow CPU, the evolution process
// (which calls multiple provider APIs) can easily exceed 5 minutes.
// Without a timeout, it blocks the next check cycle indefinitely.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

const EVOLUTION_INTERVAL_DAYS = parseInt(process.env.EVOLUTION_INTERVAL_DAYS || '30', 10);
// BUG FIX (Response 18): Cap evolution runtime to 4 minutes.
// On Render's slow CPU, model discovery across multiple providers
// can stall. This prevents the isEvolving mutex from being held forever.
const EVOLUTION_TIMEOUT_MS = 4 * 60 * 1000;
let isEvolving = false;
let _evolutionStartTime = 0;

async function checkAndRunEvolution() {
  if (isEvolving) {
    // BUG FIX (Response 18): If evolution has been running for too long,
    // forcibly release the mutex. This handles the case where the
    // evolution promise never resolves (stalled network, unhandled
    // rejection swallowed by .catch()).
    if (_evolutionStartTime > 0 && (Date.now() - _evolutionStartTime) > EVOLUTION_TIMEOUT_MS) {
      log(
        `Model evolution stuck for ${Math.round((Date.now() - _evolutionStartTime) / 1000)}s \u2014 releasing mutex`,
        'ERROR',
        'render-free-plan'
      );
      isEvolving = false;
      _evolutionStartTime = 0;
      if (CONFIG.ALERT_ON_ERROR) {
        try { sendAlert('Model evolution timed out \u2014 mutex released'); } catch { /* non-critical */ }
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
          // BUG FIX (Response 18): Race evolution against timeout so it
          // can't block forever even if evolveModelsAdvanced never resolves.
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

// BUG FIX (Response 18): First evolution check delayed to 5 min to avoid
// startup contention. Subsequent checks every 6 hours.
// Both timers .unref()'d so they don't prevent clean shutdown.
setTimeout(() => checkAndRunEvolution().catch(() => {}), 5 * 60 * 1000).unref();
setInterval(() => checkAndRunEvolution().catch(() => {}), 6 * 60 * 60 * 1000).unref();

// Template cache pruning
// NOTE: 32-bit signed int max = 2_147_483_647 ms (~24.85 days).
// 30 days = 2_592_000_000 ms which OVERFLOWS, causing the interval
// to fire every 1ms (Node clamps the overflow to 1).  Cap at 7 days.
const PRUNE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days (safe for 32-bit)
if (typeof pruneTemplateCache === 'function') {
  try {
    setTimeout(() => { pruneTemplateCache(); }, 3600000).unref();
    setInterval(() => { pruneTemplateCache(); }, PRUNE_INTERVAL_MS).unref();
  } catch { /* best-effort */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// R6: Turso PRIMARY — Must initialize BEFORE subsystems that depend on it.
// Turso is now the authoritative data source. Pull from Turso populates
// local DB with all critical data (modules, calibration, action cache,
// provider registry, model registry, banned actions) before any subsystem
// reads from the local DB.
// ═══════════════════════════════════════════════════════════════════════════
(async () => {
  try {
    const tursoSync = require('./database-turso');
    const tursoModule = container.get('turso', { required: false });
    if (tursoModule) {
      log('Initializing Turso as PRIMARY data store (R6)...', 'INFO', 'render-free-plan');
      await tursoModule.startTursoSync();
      const status = tursoModule.getTursoStatus();
      if (status.enabled) {
        log(`Turso PRIMARY ready (client=${status.clientConnected}, lastPull=${status.lastPullTime > 0 ? 'yes' : 'no'})`, 'INFO', 'render-free-plan');
      } else {
        log('Turso not configured — operating in local-only mode', 'INFO', 'render-free-plan');
      }
    } else {
      // Fallback: direct require if container doesn't have turso yet
      await tursoSync.startTursoSync();
      log('Turso sync started (direct require fallback)', 'INFO', 'render-free-plan');
    }
  } catch (err: any) {
    log(`Turso init failed (non-fatal): ${err.message}`, 'WARN', 'render-free-plan');
  }
})();

// Autonomous features (now Turso data is available in local DB)
container.get('reflection', { required: false })?.startReflectionScheduler?.();
container.get('strategyVariants', { required: false })?.runExperimentScheduler?.();
container.get('anomalyDetector', { required: false })?.start?.();
container.get('diary', { required: false })?.start?.();
container.get('coordinator', { required: false })?.startCoordinator?.();
container.get('resourceManager', { required: false })?.start?.();

// Health checks
container.get('failsafeCoordinator', { required: false })?.startHealthChecks?.(60000);

// Remote config
container.get('remoteConfig', { required: false })?.loadRemoteConfig?.().catch(() => {});

// Startup smoke tests
const smokeResult = runStartupSmokeTests();
if (!smokeResult.passed && CONFIG.ALERT_ON_ERROR) {
  const failed = smokeResult.checks.filter((c: any) => !c.passed).map((c: any) => `${c.id}(${c.detail || '?'})`).join('; ');
  try { sendAlert(`Startup smoke tests failed: ${failed}`); } catch { /* non-critical */ }
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// START THE DAEMON (non-blocking \u2014 runs in background)
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

log('Starting daemon loop (background, all features)...', 'INFO', 'render-free-plan');
startDaemon().catch(err => {
  logError('Fatal daemon error', err);
  if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Fatal daemon error: ${err.message}`); } catch { /* non-critical */ }
  log('Daemon crashed \u2014 will restart on next cycle iteration', 'ERROR', 'render-free-plan');
});

log('MathU Bot v6 \u2014 Render Free Plan fully started (all features, no workers)', 'INFO', 'render-free-plan');
