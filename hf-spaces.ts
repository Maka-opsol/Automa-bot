'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// MathU Bot v5 — Hugging Face Spaces Entry Point
// ═══════════════════════════════════════════════════════════════════════════
// Designed for 5-year unattended operation on HF Spaces free CPU tier.
//
// Key differences from agent.ts:
//   1. Web-server-first: HTTP server starts immediately on $PORT (7860)
//   2. Daemon runs as background task (not blocking the event loop)
//   3. Internal keepalive pinger prevents HF's 48h inactivity sleep
//   4. No MAX_UPTIME_HOURS forced restart
//   5. No watchdog (HF manages process lifecycle)
//   6. Memory limits tuned for 16GB CPU instance
//   7. process.exit() calls replaced with graceful recovery
//   8. / endpoint serves a minimal status page for HF Spaces UI
// ═══════════════════════════════════════════════════════════════════════════

require('./error-handler');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

// ─── DI Container ───
const { container, startSubsystemGroup, startSelfHealV2Subsystems, getContainerHealth } = require('./container');

// ─── Core modules ───
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

// ─── Cycle modules ───
let startDaemon: () => Promise<void>;
let requestStop: () => void;
let runSingleCycle: (() => Promise<void>) | undefined;
try {
  ({ startDaemon, requestStop } = container.get('orchestrator'));
} catch (e: any) {
  console.error(`FATAL: Cycle module initialization failed: ${e.message}`);
  process.exit(1);
}

// ─── Alerting ───
const _alertingMod = container.get('alerting', { required: false });
const sendAlert = _alertingMod?.sendAlert || ((msg: any) => log(`[ALERT] ${msg}`, 'ERROR', 'hf-spaces'));

// ─── Validate config (graceful degradation if creds missing) ───
const { ensureDependencies } = container.get('dependencyManager', { required: false }) || { ensureDependencies: () => {} };
ensureDependencies();
try { CONFIG.validateConfig(); } catch (validationErr: any) {
  console.error(`FATAL: Configuration validation failed: ${(validationErr as Error).message}`);
  try { closeDatabase(); } catch { /* best effort */ }
  process.exit(1);
}

// ─── Longevity subsystems ───
startSubsystemGroup('longevity');

// ─── Seed initial active model ───
const { getActiveModel, upsertModel } = require('./database');
const active = getActiveModel.get();
if (!active) {
  log('Seeding initial active model: openrouter/free', 'INFO', 'hf-spaces');
  upsertModel.run('openrouter', 'openrouter/free', 1, 1, 'active', Date.now(), Date.now(), 0);
}

// ─── Self-Heal v2 subsystems ───
startSelfHealV2Subsystems(CONFIG);

// ─── HF Spaces: Override MAX_UPTIME_HOURS to 0 (never forced restart) ───
if (CONFIG.MAX_UPTIME_HOURS && CONFIG.MAX_UPTIME_HOURS > 0) {
  CONFIG.updateConfig('MAX_UPTIME_HOURS', 0);
  log('HF Spaces: Disabled MAX_UPTIME_HOURS forced restart', 'INFO', 'hf-spaces');
}

// ═══════════════════════════════════════════════════════════════════════════
// INTERNAL KEEPALIVE PINGER
// ═══════════════════════════════════════════════════════════════════════════
// HF Spaces sleeps containers after 48 hours of no HTTP traffic.
// We self-ping every 4 minutes to prevent this. This costs zero money
// (it's a localhost request) and keeps the space permanently awake.
//
// Additionally, we can ping an external monitoring service (UptimeRobot)
// so even if the container IS restarted, the monitoring ping wakes it up
// within 5 minutes.
// ═══════════════════════════════════════════════════════════════════════════

const KEEPALIVE_INTERVAL_MS = 4 * 60 * 1000; // 4 minutes
const EXTERNAL_PING_URL = process.env.KEEPALIVE_PING_URL || ''; // e.g. UptimeRobot URL

let _keepaliveFailCount = 0;

function selfPing() {
  const port = process.env.PORT || '7860';
  const req = http.get(`http://localhost:${port}/health`, (res: any) => {
    let data = '';
    res.on('data', (chunk: any) => { data += chunk; });
    res.on('end', () => {
      _keepaliveFailCount = 0;
      log('Keepalive ping OK', 'DEBUG', 'keepalive');
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
  const req = https.get({ hostname: url.hostname, path: url.pathname + url.search, timeout: 10000 }, () => {
    log('External keepalive ping sent', 'DEBUG', 'keepalive');
  });
  req.on('error', () => {});
  req.setTimeout(10000, () => { req.destroy(); });
}

function keepaliveLoop() {
  selfPing();
  externalPing();
}

// Start keepalive after 30 seconds, then every 4 minutes
setTimeout(() => {
  keepaliveLoop();
  setInterval(keepaliveLoop, KEEPALIVE_INTERVAL_MS).unref();
}, 30000);

log(`Keepalive system started (interval: ${KEEPALIVE_INTERVAL_MS / 1000}s, external: ${EXTERNAL_PING_URL ? 'enabled' : 'disabled'})`, 'INFO', 'hf-spaces');

// ═══════════════════════════════════════════════════════════════════════════
// SHUTDOWN HANDLING — Recovery, not exit
// ═══════════════════════════════════════════════════════════════════════════

let isShuttingDown = false;

// Override process.exit to log and attempt recovery instead of dying
const originalExit = process.exit.bind(process);
(process as any).exit = (code?: number) => {
  if (isShuttingDown) {
    originalExit(code || 0);
    return;
  }
  log(`process.exit(${code}) intercepted — attempting recovery instead of dying`, 'WARN', 'hf-spaces');
  if (CONFIG.ALERT_ON_ERROR) {
    try { sendAlert(`process.exit(${code}) intercepted, recovering...`); } catch { /* non-critical */ }
  }
  // Try to recover by just continuing (the error that triggered exit
  // was likely transient — memory pressure, browser crash, etc.)
};

async function gracefulShutdown(signal: string) {
  if (isShuttingDown) return;
  isShuttingDown = true;
  log(`Received ${signal} — shutting down gracefully...`, 'INFO', 'hf-spaces');
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

// Register browser cleanup shutdown hook
const { registerShutdownHook } = (() => { try { return require('./cycle-shutdown'); } catch { return { registerShutdownHook: () => {} }; } })();
registerShutdownHook(async () => {
  log('Closing browser...', 'INFO', 'hf-spaces');
  try {
    const browserMod = container.get('browser', { required: false });
    if (browserMod?.closeBrowser) await browserMod.closeBrowser();
  } catch { /* best effort */ }
}, 1);
registerShutdownHook(async () => { log('Closing database...', 'INFO', 'hf-spaces'); try { closeDatabase(); } catch { /* best effort */ } }, 2);

// ═══════════════════════════════════════════════════════════════════════════
// MEMORY MANAGEMENT — Tuned for HF Spaces 16GB CPU
// ═══════════════════════════════════════════════════════════════════════════

let _memoryWarningCount = 0;
setInterval(() => {
  if (isShuttingDown) return;
  const mem = process.memoryUsage();
  const used = mem.heapUsed / 1024 / 1024;
  const external = mem.external / 1024 / 1024;

  if (used > CONFIG.MEMORY_RESTART_THRESHOLD_MB) {
    // Try aggressive GC before giving up
    if (global.gc) {
      log(`High memory: ${used.toFixed(0)}MB — attempting manual GC`, 'WARN', 'hf-spaces');
      global.gc();
      const afterGC = process.memoryUsage().heapUsed / 1024 / 1024;
      if (afterGC < CONFIG.MEMORY_WARNING_THRESHOLD_MB) {
        log(`GC recovered: ${used.toFixed(0)}MB -> ${afterGC.toFixed(0)}MB`, 'INFO', 'hf-spaces');
        _memoryWarningCount = 0;
        return;
      }
    }
    // HF Spaces: Close browser to recover memory instead of process.exit
    log(`Memory critical: ${used.toFixed(0)}MB — closing browser to recover`, 'WARN', 'hf-spaces');
    try {
      const browserMod = container.get('browser', { required: false });
      if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
        browserMod.browserManager.cleanup().catch(() => {});
      }
    } catch { /* best effort */ }
    if (global.gc) global.gc();
    _memoryWarningCount = 0;
  } else if (used > CONFIG.MEMORY_WARNING_THRESHOLD_MB) {
    _memoryWarningCount++;
    if (_memoryWarningCount >= 5) {  // More patient on 16GB
      log(`Memory warning persistent (${_memoryWarningCount}): ${used.toFixed(0)}MB — closing browser`, 'WARN', 'hf-spaces');
      try {
        const browserMod = container.get('browser', { required: false });
        if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
          browserMod.browserManager.cleanup().catch(() => {});
        }
      } catch { /* best effort */ }
      _memoryWarningCount = 0;
    } else {
      log(`Memory warning: ${used.toFixed(0)}MB [${_memoryWarningCount}/5]`, 'WARN', 'hf-spaces');
    }
  } else {
    _memoryWarningCount = 0;
  }
}, 60000).unref();

// ═══════════════════════════════════════════════════════════════════════════
// HTTP SERVER — HF Spaces entry point (must listen on $PORT)
// ═══════════════════════════════════════════════════════════════════════════

const DASHBOARD_ALLOWED_ORIGINS = process.env.DASHBOARD_ALLOWED_ORIGINS
  ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
  : ['http://localhost:7860', 'https://huggingface.co'];

const server = http.createServer((req: any, res: any) => {
  const origin = req.headers.origin || '';
  if (DASHBOARD_ALLOWED_ORIGINS.includes(origin) || origin.includes('huggingface.co')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // ── HF Spaces root: minimal status page ──
  if (pathname === '/' && req.method === 'GET') {
    const stats = getStats();
    const mem = process.memoryUsage();
    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MathU Bot v5</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;max-width:800px;margin:40px auto;padding:0 20px;color:#e5e7eb;background:#111827}
h1{color:#f9fafb;border-bottom:1px solid #374151;padding-bottom:12px}
.stat{display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid #1f2937}
.stat-label{color:#9ca3af}.stat-value{color:#60a5fa;font-weight:600}
.badge{display:inline-block;padding:2px 8px;border-radius:9999px;font-size:12px;font-weight:600}
.badge-ok{background:#065f46;color:#6ee7b7}.badge-warn{background:#78350f;color:#fcd34d}.badge-err{background:#7f1d1d;color:#fca5a5}
.footer{margin-top:40px;color:#6b7280;font-size:13px;text-align:center}
</style></head><body>
<h1>MathU Bot v5 — HF Spaces</h1>
<p>Autonomous educational platform bot. Running unattended on Hugging Face Spaces.</p>
<h2>Status</h2>
<div class="stat"><span class="stat-label">Status</span><span class="badge ${stats.currentStatus === 'running' ? 'badge-ok' : stats.currentStatus === 'idle' ? 'badge-warn' : 'badge-err'}">${stats.currentStatus || 'unknown'}</span></div>
<div class="stat"><span class="stat-label">Questions Completed</span><span class="stat-value">${stats.questionsCompleted || 0}</span></div>
<div class="stat"><span class="stat-label">Cycles Run</span><span class="stat-value">${stats.cycleCount || 0}</span></div>
<div class="stat"><span class="stat-label">Uptime</span><span class="stat-value">${formatUptime(process.uptime())}</span></div>
<div class="stat"><span class="stat-label">Heap Used</span><span class="stat-value">${(mem.heapUsed / 1024 / 1024).toFixed(0)} MB</span></div>
<div class="stat"><span class="stat-label">Node.js</span><span class="stat-value">${process.version}</span></div>
<div class="stat"><span class="stat-label">Platform</span><span class="stat-value">${process.platform} ${process.arch}</span></div>
<h2>API Endpoints</h2>
<ul>
<li><code>GET /health</code> — Health check (for HF Spaces monitoring)</li>
<li><code>GET /api/status</code> — Detailed status JSON</li>
<li><code>GET /api/metrics</code> — Performance metrics</li>
</ul>
<div class="footer">MathU Bot v5.0.0 | Uptime: ${formatUptime(process.uptime())} | ${new Date().toISOString()}</div>
</body></html>`;
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  // ── Health (used by HF Spaces + keepalive) ──
  if (pathname === '/health' || pathname === '/api/health') {
    const stateMachine = container.get('stateMachine');
    const stats = getStats();
    const mem = process.memoryUsage();
    const health = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      stats: { questionsCompleted: stats.questionsCompleted || 0, cycleCount: stats.cycleCount || 0 },
      memory: { heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB', heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(0) + 'MB' },
      state: { current: stateMachine?.stateMachine?.getCurrentState?.() || null },
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

  // ── Manual cycle trigger (for debugging/testing) ──
  if (pathname === '/api/run-cycle' && req.method === 'POST') {
    log('Manual cycle trigger via API', 'INFO', 'hf-spaces');
    try {
      const { runCycle } = require('./cycle-cycle-manager');
      runCycle().then((result: any) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, result }));
      }).catch((err: any) => {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: err.message }));
      });
    } catch (err: any) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Cycle manager not available' }));
    }
    return;
  }

  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

// ── Stats helper ──
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

// ── Start HTTP server FIRST (HF Spaces requirement) ──
const PORT = parseInt(process.env.PORT || '7860', 10);
server.listen(PORT, '0.0.0.0', () => {
  log(`MathU Bot v5 — HF Spaces edition listening on port ${PORT}`, 'INFO', 'hf-spaces');
  log(`Memory limits: warn=${CONFIG.MEMORY_WARNING_THRESHOLD_MB}MB, restart=${CONFIG.MEMORY_RESTART_THRESHOLD_MB}MB`, 'INFO', 'hf-spaces');
});

// ── Heartbeat file ──
setInterval(() => {
  if (CONFIG.HEARTBEAT_FILE) {
    try { fs.writeFileSync(CONFIG.HEARTBEAT_FILE, String(Date.now())); } catch { /* best-effort */ }
  }
}, CONFIG.HEARTBEAT_INTERVAL_MS).unref();

// ═══════════════════════════════════════════════════════════════════════════
// BACKGROUND TASKS (non-blocking, started after HTTP server)
// ═══════════════════════════════════════════════════════════════════════════

// ── IP check (disabled by default on HF Spaces) ──
if (CONFIG.ENABLE_IP_CHECK) {
  const ipCheck = container.get('ipCheck', { required: false });
  ipCheck?.checkIpLocation?.().catch(() => {});
}

// ── DB backup ──
const dbBackup = container.get('dbBackup', { required: false });
dbBackup?.startScheduledBackup?.();

// ── Model evolution ──
const EVOLUTION_INTERVAL_DAYS = parseInt(process.env.EVOLUTION_INTERVAL_DAYS || '30', 10);
let isEvolving = false;
async function checkAndRunEvolution() {
  if (isEvolving) return;
  try {
    const row = selectCalibration.get('last_evolution_timestamp');
    const lastRun = row ? parseInt(row.value, 10) : 0;
    const daysSince = (Date.now() - lastRun) / (1000 * 60 * 60 * 24);
    if (daysSince >= EVOLUTION_INTERVAL_DAYS) {
      log(`Running model evolution (${daysSince.toFixed(1)} days since last)...`, 'INFO', 'hf-spaces');
      isEvolving = true;
      try {
        const modelEvolution = container.get('modelEvolutionAdvanced', { required: false });
        if (modelEvolution) {
          const result = await modelEvolution.evolveModelsAdvanced();
          log(`Model evolution: ${result.success ? 'success' : result.message}`, 'INFO', 'hf-spaces');
        }
        upsertCalibration.run('last_evolution_timestamp', String(Date.now()), Date.now());
      } catch (err: any) { logError('Model evolution failed', err); } finally { isEvolving = false; }
    }
  } catch (err: any) { logError('Evolution check failed', err); }
}
setTimeout(() => checkAndRunEvolution().catch(() => {}), 5 * 60 * 1000);
setInterval(() => checkAndRunEvolution().catch(() => {}), 6 * 60 * 60 * 1000).unref();

// ── Template cache pruning ──
const { pruneTemplateCache } = container.get('database');
setTimeout(() => { pruneTemplateCache(); }, 3600000);
setInterval(() => { pruneTemplateCache(); }, 30 * 24 * 60 * 60 * 1000).unref();

// ── Autonomous features (non-critical) ──
container.get('reflection', { required: false })?.startReflectionScheduler?.();
container.get('strategyVariants', { required: false })?.runExperimentScheduler?.();
container.get('anomalyDetector', { required: false })?.start?.();
container.get('diary', { required: false })?.start?.();
container.get('coordinator', { required: false })?.startCoordinator?.();
container.get('resourceManager', { required: false })?.start?.();

// ── Health checks ──
const failsafeCoordinator = container.get('failsafeCoordinator', { required: false });
failsafeCoordinator?.startHealthChecks?.(60000);

// ── Remote config ──
container.get('remoteConfig', { required: false })?.loadRemoteConfig?.().catch(() => {});

// ── Startup smoke tests ──
const { runStartupSmokeTests } = require('./container');
const smokeResult = runStartupSmokeTests();
if (!smokeResult.passed && CONFIG.ALERT_ON_ERROR) {
  const failed = smokeResult.checks.filter((c: any) => !c.passed).map((c: any) => `${c.id}(${c.detail || '?'})`).join('; ');
  try { sendAlert(`Startup smoke tests failed: ${failed}`); } catch { /* non-critical */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// START THE DAEMON (non-blocking — runs in background)
// ═══════════════════════════════════════════════════════════════════════════

log('Starting daemon loop (background)...', 'INFO', 'hf-spaces');
startDaemon().catch(err => {
  logError('Fatal daemon error', err);
  if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Fatal daemon error: ${err.message}`); } catch { /* non-critical */ }
  // HF Spaces: Do NOT process.exit — the HTTP server must stay alive
  // for keepalive pings. Log and let error-handler deal with it.
  log('Daemon crashed — will restart on next cycle iteration', 'ERROR', 'hf-spaces');
});

log('MathU Bot v5 — HF Spaces edition fully started', 'INFO', 'hf-spaces');
