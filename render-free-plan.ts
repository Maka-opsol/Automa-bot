'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// MathU Bot v6 — Render Free Plan Entry Point (FULL FEATURES)
// ═══════════════════════════════════════════════════════════════════════════
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
// ═══════════════════════════════════════════════════════════════════════════

require('./error-handler');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROJECT_ROOT } = require('./project-root');

// ═══════════════════════════════════════════════════════════════════════════
// PRE-STARTUP: Set Render-friendly defaults BEFORE any module loads
// ═══════════════════════════════════════════════════════════════════════════

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
if (!process.env.REGRESSION_BANK_DIR)   process.env.REGRESSION_BANK_DIR   = path.join(DATA_DIR, 'mathu-regression');

// Memory — tight but workable for 512 MB (OS + Node + Chromium + subsystems)
if (!process.env.MAX_MEMORY_MB)              process.env.MAX_MEMORY_MB = '448';
if (!process.env.MEMORY_WARNING_THRESHOLD_MB) process.env.MEMORY_WARNING_THRESHOLD_MB = '350';
if (!process.env.MEMORY_RESTART_THRESHOLD_MB) process.env.MEMORY_RESTART_THRESHOLD_MB = '400';

// Timing
if (!process.env.MAX_UPTIME_HOURS)           process.env.MAX_UPTIME_HOURS = '0';      // never force restart
if (!process.env.MAX_CYCLES_BEFORE_RESTART)  process.env.MAX_CYCLES_BEFORE_RESTART = '999999';

// Logging — keep it reasonable (no persistent disk)
if (!process.env.LOG_LEVEL)       process.env.LOG_LEVEL = 'info';
if (!process.env.LOG_MAX_FILES)   process.env.LOG_MAX_FILES = '2';
if (!process.env.LOG_MAX_SIZE_MB) process.env.LOG_MAX_SIZE_MB = '10';

// Chromium — single-process saves 50-80 MB vs multi-process
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

// ═══════════════════════════════════════════════════════════════════════════
// LOAD MODULES
// ═══════════════════════════════════════════════════════════════════════════

const { container, startSubsystemGroup, startSelfHealV2Subsystems, getContainerHealth, runStartupSmokeTests } = require('./container');

let CONFIG: any, log: any, logError: any;
let closeDatabase: any, upsertCalibration: any, selectCalibration: any;
try {
  CONFIG = container.get('config');
  ({ log, logError } = container.get('logger'));
  ({ closeDatabase, upsertCalibration, selectCalibration } = container.get('database'));
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

// ═══════════════════════════════════════════════════════════════════════════
// SUBSYSTEMS: Start ALL of them (full feature set)
// ═══════════════════════════════════════════════════════════════════════════

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

// ═══════════════════════════════════════════════════════════════════════════
// WORKER FALLBACK: Start rewardTracker in-process
// ═══════════════════════════════════════════════════════════════════════════
// Workers are skipped on 512 MB (saves ~90-150 MB). The in-process
// modules for metrics and diary are already active via the container.
// rewardTracker is skipped by startSelfHealV2Subsystems (WORKER_BACKED
// set), so we start it manually here.
// ═══════════════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════════════
// KEEPALIVE PINGER — Prevents Render 15-min spin-down
// ═══════════════════════════════════════════════════════════════════════════
// Render free plan spins down after 15 minutes of no HTTP traffic.
// Self-ping every 4 minutes keeps the service permanently awake.
// Optional: set KEEPALIVE_PING_URL to a UptimeRobot/cron-job.org URL
// for an external backup ping.
// ═══════════════════════════════════════════════════════════════════════════

const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000;
const EXTERNAL_PING_URL = process.env.KEEPALIVE_PING_URL || '';

let _keepaliveFailCount = 0;

function selfPing() {
  const port = process.env.PORT || '10000';
  const req = http.get(`http://localhost:${port}/health`, (res: any) => {
    let data = '';
    res.on('data', (chunk: any) => { data += chunk; });
    res.on('end', () => {
      _keepaliveFailCount = 0;
    });
  });
  req.on('error', (err: any) => {
    _keepaliveFailCount++;
    log(`Keepalive ping failed (${_keepaliveFailCount}): ${err.message}`, 'WARN', 'keepalive');
  });
  req.setTimeout(5000, () => { req.destroy(); });
}

function externalPing() {
  if (!EXTERNAL_PING_URL) return;
  const https = require('https');
  const url = new URL(EXTERNAL_PING_URL);
  const req = https.get({ hostname: url.hostname, path: url.pathname + url.search, timeout: 10000 }, () => {});
  req.on('error', () => {});
  req.setTimeout(10000, () => { req.destroy(); });
}

function keepaliveLoop() {
  selfPing();
  externalPing();
}

setTimeout(() => {
  keepaliveLoop();
  setInterval(keepaliveLoop, KEEPALIVE_INTERVAL_MS).unref();
}, 30000);

log(`Keepalive system started (interval: ${KEEPALIVE_INTERVAL_MS / 1000}s, external: ${EXTERNAL_PING_URL ? 'enabled' : 'disabled'})`, 'INFO', 'render-free-plan');

// ═══════════════════════════════════════════════════════════════════════════
// SHUTDOWN HANDLING — Recovery, not exit
// ═══════════════════════════════════════════════════════════════════════════

let isShuttingDown = false;
const originalExit = process.exit.bind(process);
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
    if (browserMod?.closeBrowser) await browserMod.closeBrowser();
  } catch { /* best effort */ }
}, 1);
registerShutdownHook(async () => {
  log('Closing database...', 'INFO', 'render-free-plan');
  try { closeDatabase(); } catch { /* best effort */ }
}, 2);

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY MANAGEMENT — Tuned for 512 MB
// ═══════════════════════════════════════════════════════════════════════════

let _memoryWarningCount = 0;

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

  if (used > CONFIG.MEMORY_RESTART_THRESHOLD_MB || rss > 470) {
    // Critical: close browser + force GC
    log(`Memory critical: heap=${used.toFixed(0)}MB rss=${rss.toFixed(0)}MB — closing browser + GC`, 'WARN', 'render-free-plan');
    try {
      const browserMod = container.get('browser', { required: false });
      if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
        browserMod.browserManager.cleanup().catch(() => {});
      }
    } catch { /* best effort */ }
    if (global.gc) { try { global.gc(); } catch { /* ignore */ } }
    _memoryWarningCount = 0;
  } else if (used > CONFIG.MEMORY_WARNING_THRESHOLD_MB) {
    _memoryWarningCount++;
    if (_memoryWarningCount >= 3) {
      log(`Memory warning persistent (${_memoryWarningCount}/3): heap=${used.toFixed(0)}MB — closing browser`, 'WARN', 'render-free-plan');
      try {
        const browserMod = container.get('browser', { required: false });
        if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
          browserMod.browserManager.cleanup().catch(() => {});
        }
      } catch { /* best effort */ }
      if (global.gc) { try { global.gc(); } catch { /* ignore */ } }
      _memoryWarningCount = 0;
    } else {
      log(`Memory warning: heap=${used.toFixed(0)}MB rss=${rss.toFixed(0)}MB [${_memoryWarningCount}/3]`, 'WARN', 'render-free-plan');
    }
  } else {
    _memoryWarningCount = 0;
  }
}, 30000).unref();

// ═══════════════════════════════════════════════════════════════════════════
// HTTP SERVER — Render requires listening on $PORT
// ═══════════════════════════════════════════════════════════════════════════

const DASHBOARD_ALLOWED_ORIGINS = process.env.DASHBOARD_ALLOWED_ORIGINS
  ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
  : ['*'];

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

const server = http.createServer((req: any, res: any) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ── Root: status page ──
  if (pathname === '/' && req.method === 'GET') {
    const stats = getStats();
    const mem = process.memoryUsage();
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
</style></head><body>
<h1>MathU Bot v6 — Render Free Plan</h1>
<p>All features enabled. 512 MB RAM. No worker threads (in-process). Single-process Chromium.</p>
<h2>Status</h2>
<div class="stat"><span class="stat-label">Status</span><span class="badge ${stats.currentStatus === 'running' ? 'badge-ok' : stats.currentStatus === 'idle' ? 'badge-warn' : 'badge-err'}">${stats.currentStatus || 'unknown'}</span></div>
<div class="stat"><span class="stat-label">Questions Completed</span><span class="stat-value">${stats.questionsCompleted || 0}</span></div>
<div class="stat"><span class="stat-label">Cycles Run</span><span class="stat-value">${stats.cycleCount || 0}</span></div>
<div class="stat"><span class="stat-label">Uptime</span><span class="stat-value">${formatUptime(process.uptime())}</span></div>
<div class="stat"><span class="stat-label">Heap Used</span><span class="stat-value">${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB</span></div>
<div class="stat"><span class="stat-label">RSS</span><span class="stat-value">${(mem.rss / 1024 / 1024).toFixed(0)} MB</span></div>
<div class="stat"><span class="stat-label">Node.js</span><span class="stat-value">${process.version}</span></div>
<div class="stat"><span class="stat-label">Workers</span><span class="stat-value">0 (in-process)</span></div>
<h2>API Endpoints</h2>
<ul>
<li><code>GET /health</code> — Health check</li>
<li><code>GET /api/status</code> — Detailed status JSON</li>
<li><code>GET /api/metrics</code> — Performance metrics</li>
<li><code>GET /api/container</code> — Container module health</li>
</ul>
<div class="footer">MathU Bot v6 | Render Free Plan | All Features | ${formatUptime(process.uptime())} | ${new Date().toISOString()}</div>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── Health ──
  if (pathname === '/health' || pathname === '/api/health') {
    const stateMachine = container.get('stateMachine');
    const stats = getStats();
    const mem = process.memoryUsage();
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      stats: { questionsCompleted: stats.questionsCompleted || 0, cycleCount: stats.cycleCount || 0 },
      memory: {
        heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
        heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(0) + 'MB',
        rss: (mem.rss / 1024 / 1024).toFixed(0) + 'MB',
      },
      state: { current: stateMachine?.stateMachine?.getCurrentState?.() || null },
      platform: 'render-free-plan',
      features: 'all-enabled',
      workers: 'in-process',
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(health));
    return;
  }

  // ── Status ──
  if (pathname === '/api/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getStats()));
    return;
  }

  // ── Metrics ──
  if (pathname === '/api/metrics') {
    const metricsMod = container.get('metrics', { required: false });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(metricsMod?.metrics?.getSummary?.() || {}));
    return;
  }

  // ── Container health ──
  if (pathname === '/api/container') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(getContainerHealth()));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Start HTTP server FIRST (Render requirement) ──
const PORT = parseInt(process.env.PORT || '10000', 10);
server.listen(PORT, '0.0.0.0', () => {
  log(`MathU Bot v6 — Render Free Plan (all features) listening on port ${PORT}`, 'INFO', 'render-free-plan');
  log(`Memory: warn=${CONFIG.MEMORY_WARNING_THRESHOLD_MB}MB, restart=${CONFIG.MEMORY_RESTART_THRESHOLD_MB}MB, workers=in-process`, 'INFO', 'render-free-plan');
});

// ── Heartbeat file ──
setInterval(() => {
  if (CONFIG.HEARTBEAT_FILE) {
    try { fs.writeFileSync(CONFIG.HEARTBEAT_FILE, String(Date.now())); } catch { /* best-effort */ }
  }
}, CONFIG.HEARTBEAT_INTERVAL_MS).unref();

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND TASKS (all enabled)
// ═══════════════════════════════════════════════════════════════════════════

// IP check
if (CONFIG.ENABLE_IP_CHECK) {
  container.get('ipCheck', { required: false })?.checkIpLocation?.().catch(() => {});
}

// DB backup
container.get('dbBackup', { required: false })?.startScheduledBackup?.();

// Model evolution
const EVOLUTION_INTERVAL_DAYS = parseInt(process.env.EVOLUTION_INTERVAL_DAYS || '30', 10);
let isEvolving = false;
async function checkAndRunEvolution() {
  if (isEvolving) return;
  try {
    const row = selectCalibration.get('last_evolution_timestamp');
    const lastRun = row ? parseInt(row.value, 10) : 0;
    const daysSince = (Date.now() - lastRun) / (1000 * 60 * 60 * 24);
    if (daysSince >= EVOLUTION_INTERVAL_DAYS) {
      log(`Running model evolution (${daysSince.toFixed(1)} days since last)...`, 'INFO', 'render-free-plan');
      isEvolving = true;
      try {
        const modelEvolution = container.get('modelEvolutionAdvanced', { required: false });
        if (modelEvolution) {
          const result = await modelEvolution.evolveModelsAdvanced();
          log(`Model evolution: ${result.success ? 'success' : result.message}`, 'INFO', 'render-free-plan');
        }
        upsertCalibration.run('last_evolution_timestamp', String(Date.now()), Date.now());
      } catch (err: any) { logError('Model evolution failed', err); } finally { isEvolving = false; }
    }
  } catch (err: any) { logError('Evolution check failed', err); }
}
setTimeout(() => checkAndRunEvolution().catch(() => {}), 5 * 60 * 1000);
setInterval(() => checkAndRunEvolution().catch(() => {}), 6 * 60 * 60 * 1000).unref();

// Template cache pruning
try {
  const { pruneTemplateCache } = container.get('database');
  setTimeout(() => { pruneTemplateCache(); }, 3600000);
  setInterval(() => { pruneTemplateCache(); }, 30 * 24 * 60 * 60 * 1000).unref();
} catch { /* best-effort */ }

// Autonomous features
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

// ═══════════════════════════════════════════════════════════════════════════
// START THE DAEMON (non-blocking — runs in background)
// ═══════════════════════════════════════════════════════════════════════════

log('Starting daemon loop (background, all features)...', 'INFO', 'render-free-plan');
startDaemon().catch(err => {
  logError('Fatal daemon error', err);
  if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Fatal daemon error: ${err.message}`); } catch { /* non-critical */ }
  log('Daemon crashed — will restart on next cycle iteration', 'ERROR', 'render-free-plan');
});

log('MathU Bot v6 — Render Free Plan fully started (all features, no workers)', 'INFO', 'render-free-plan');
