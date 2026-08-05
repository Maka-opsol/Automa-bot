'use strict';

// ─── Hugging Face Spaces detection ───
const IS_HF_SPACE = !!process.env.HF_SPACE || !!process.env.SPACE_ID || !!process.env.SPACE_AUTHOR_NAME;
if (IS_HF_SPACE) { console.log('━━━ Running on Hugging Face Spaces — all features enabled ━━━'); }

// ─── Error handler MUST load first — registers uncaughtException / unhandledRejection ───
require('./error-handler');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

// ─── DI Container — single point of access for all modules ───
// NOTE: agent.ts IS the bootstrap entrypoint; direct require() here is intentional
// (the container itself is being imported here to bootstrap everything else).
const { container, startSubsystemGroup, startSelfHealV2Subsystems, startResilienceSubsystems, getContainerHealth } = require('./container');

// ─── Core modules (critical, initialized eagerly) ───
let CONFIG: any,       log: any,       setLogLevel: any,       logError: any,       logMetric: any,       logAudit: any;
let closeDatabase: any,    pruneTemplateCache,    upsertCalibration: any,    selectCalibration: any,    checkIntegrity,    getDatabaseStats;
try {
  CONFIG = container.get('config');
  ({ log, setLogLevel, logError, logMetric, logAudit } = container.get('logger'));
  ({ closeDatabase, pruneTemplateCache, upsertCalibration, selectCalibration, checkIntegrity, getDatabaseStats } = container.get('database'));
} catch (initErr: any) {
  console.error(`━━━ FATAL: Core module initialization failed ━━━`);
  console.error(`Error: ${initErr.message}`);
  console.error(`Stack: ${initErr.stack}`);
  console.error(`━━━ Common causes: ━━━`);
  console.error(`  1. Node.js version < 20.6.0 (run: node -v to check)`);
  console.error(`  2. better-sqlite3 failed to compile (check build logs)`);
  console.error(`  3. Missing native dependencies (apt-get install python3 make g++)`);
  console.error(`  4. Missing environment variables (see .env.example)`);
  // HF Spaces: container restarts on exit, so process.exit is acceptable here
  // (unrecoverable init failure — no point in retrying)
  process.exit(1);
}

// ─── Provider stats ───
// v5-fix: These were OUTSIDE the try/catch above — any failure (e.g. Playwright
// not installed causing browser → providers cascade) would crash with no friendly
// error message. Now wrapped with graceful degradation.
let getStats: (update?: Record<string, any>) => Record<string, any>;
let updateStats: (update: Record<string, any>) => void;
try {
  ({ getStats, updateStats } = container.get('providers'));
} catch (providersErr: any) {
  console.error(`━━━ FATAL: Provider module initialization failed ━━━`);
  console.error(`Error: ${(providersErr as Error).message}`);
  console.error(`━━━ Common causes: ━━━`);
  console.error(`  1. Playwright/Chromium not installed (run: npx playwright install chromium)`);
  console.error(`  2. Missing provider API keys (see .env.example)`);
  console.error(`  3. Node.js version < 20.6.0 (run: node -v to check)`);
  // Unrecoverable — container restart is the only fix
  process.exit(1);
}

// ─── Cycle ───
let startDaemon: () => Promise<void>;
let requestStop: () => void;
let registerShutdownHook: (hook: () => Promise<void>, priority?: number) => void;
try {
  ({ startDaemon, requestStop } = container.get('orchestrator'));
  ({ registerShutdownHook } = container.get('shutdown'));
} catch (cycleErr: any) {
  console.error(`━━━ FATAL: Cycle/Shutdown module initialization failed ━━━`);
  console.error(`Error: ${(cycleErr as Error).message}`);
  console.error(`━━━ This is likely a cascading failure from a missing dependency. ━━━`);
  console.error(`Check the container health for details: /api/container`);
  process.exit(1);
}

// ─── Alerting ───
const _alertingMod = container.get('alerting', { required: false });
const sendAlert = _alertingMod?.sendAlert || ((msg: any) => log(`[ALERT] ${msg}`, 'ERROR', 'agent'));

// ─── Auth ───
const _jwtMod = container.get('jwt', { required: false });
const requireAuth = _jwtMod?.requireAuth || ((req: any, res: any, next: any) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Authentication module unavailable' })); });
const generateToken = _jwtMod?.generateToken || (() => '');

// ─── Validate & Seed ───
const { ensureDependencies } = container.get('dependencyManager', { required: false }) || { ensureDependencies: () => {} };
ensureDependencies();
// v5-fix: validateConfig now throws instead of calling process.exit(1),
// so we can handle it here with proper cleanup before exiting.
try {
  CONFIG.validateConfig();
} catch (validationErr: any) {
  console.error(`━━━ FATAL: Configuration validation failed ━━━`);
  console.error(`Error: ${(validationErr as Error).message}`);
  console.error(`━━━ Fix: Check your .env file (see .env.example) or set SANDBOX_MODE=true ━━━`);
  // Attempt graceful cleanup before exiting
  try { closeDatabase(); } catch (_e: any) { /* best effort */ }
  process.exit(1);
}

// ─── HF Spaces: Ephemeral storage warning ───
if (IS_HF_SPACE) {
  log('Hugging Face Spaces detected — storage is EPHEMERAL (wiped on restart)', 'WARN', 'agent');
  log('Database, auth state, and checkpoints will NOT persist across container restarts', 'WARN', 'agent');
  log('Set SANDBOX_MODE=true if you want to test without real credentials', 'INFO', 'agent');
}

// ─── Longevity subsystems (non-critical, start early) ───
startSubsystemGroup('longevity');

// ─── Admin auth ───
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;
const ADMIN_ALLOWED_IPS = (process.env.ADMIN_ALLOWED_IPS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!ADMIN_SECRET) { log('ADMIN_SECRET not set. Admin endpoints will be disabled.', 'WARN', 'agent'); }

// ─── Admin rate limiter (5 requests per minute per IP, file-backed for restart persistence) ───
const _adminRateLimitMap = new Map();
const ADMIN_RATE_LIMIT_MAX = 5;
const ADMIN_RATE_WINDOW_MS = 60000;
const ADMIN_RATE_LIMIT_FILE = path.join(PROJECT_ROOT, '.admin-rate-limit.json');

// Load persisted rate-limit state on startup
try {
  if (fs.existsSync(ADMIN_RATE_LIMIT_FILE)) {
    const persisted = JSON.parse(fs.readFileSync(ADMIN_RATE_LIMIT_FILE, 'utf8'));
    const now = Date.now();
    for (const [ip, entry] of Object.entries(persisted)) {
      if (now - (entry as any).windowStart < ADMIN_RATE_WINDOW_MS) {
        _adminRateLimitMap.set(ip, entry);
      }
    }
  }
} catch { /* non-critical */ }

function _persistRateLimits() {
  try {
    const data = {};
    for (const [ip, entry] of _adminRateLimitMap) { (data as any)[ip] = entry; }
    fs.writeFileSync(ADMIN_RATE_LIMIT_FILE, JSON.stringify(data));
  } catch { /* non-critical */ }
}

function checkAdminRateLimit(req: any) {
  const ip = req.socket?.remoteAddress || 'unknown';
  const now = Date.now();
  let entry = _adminRateLimitMap.get(ip);
  if (!entry || now - entry.windowStart > ADMIN_RATE_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    _adminRateLimitMap.set(ip, entry);
  }
  entry.count++;
  _persistRateLimits();
  return entry.count <= ADMIN_RATE_LIMIT_MAX;
}

// Prune stale rate limit entries every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of _adminRateLimitMap) {
    if (now - entry.windowStart > ADMIN_RATE_WINDOW_MS * 2) {
      _adminRateLimitMap.delete(ip);
    }
  }
  _persistRateLimits();
}, 5 * 60 * 1000).unref();

// ─── Seed initial active model ───
// NOTE: Direct require('./database') is safe here because database is already
// initialized by the DI container above (lines 18-20). Using container.get('database')
// would re-invoke the factory, so we require the cached module directly.
const { getActiveModel, upsertModel } = require('./database');
const active = getActiveModel.get();
if (!active) { log('Seeding initial active model: openrouter/free', 'INFO', 'agent'); upsertModel.run('openrouter', 'openrouter/free', 1, 1, 'active', Date.now(), Date.now(), 0); }

let isShuttingDown = false;

async function shutdown() { 
  if (isShuttingDown) return;
  isShuttingDown = true;
  try { const { _markShuttingDown } = require('./error-handler'); _markShuttingDown(); } catch { /* error-handler may not expose it in all paths */ }
  updateStats({ currentStatus: 'shutting_down' });
  log('Shutting down gracefully...', 'INFO', 'agent');
  requestStop();
  try {
    const { gracefulShutdown: runHooks } = require('./cycle-shutdown');
    await runHooks('SIGTERM');
  } catch (e: any) {
    log('Shutdown hooks unavailable, closing directly', 'WARN', 'agent');
    try { closeDatabase(); } catch (dbErr: any) { logError('Error closing database during fallback shutdown', dbErr); }
    process.exit(1);
  }
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

// v5-fix: Shutdown hooks now use { required: false } + null-checks so they don't
// throw during shutdown if the browser or other modules failed to initialize.
registerShutdownHook(async () => {
  log('Closing browser...', 'INFO', 'agent');
  try {
    const browserMod = container.get('browser', { required: false });
    if (browserMod?.closeBrowser) { await browserMod.closeBrowser(); }
    else { log('Browser module not available during shutdown, skipping', 'WARN', 'agent'); }
  } catch (e: any) { logError('Error closing browser during shutdown', e as Error); }
}, 1);
registerShutdownHook(async () => { log('Closing database...', 'INFO', 'agent'); try { closeDatabase(); } catch (dbErr: any) { logError('Error closing database during shutdown', dbErr as Error); } }, 2);

const MAX_UPTIME_MS = (CONFIG.MAX_UPTIME_HOURS || 0) * 60 * 60 * 1000;
if (MAX_UPTIME_MS > 0) {
  setTimeout(async () => {
    log(`Scheduled restart after ${CONFIG.MAX_UPTIME_HOURS}h for stability`, 'INFO', 'agent');
    try {
      const { gracefulShutdown: runHooks } = require('./cycle-shutdown');
      await runHooks('max_uptime');
    } catch (e: any) {
      try { closeDatabase(); } catch (dbErr: any) { /* ignore */ }
      // exit(1) triggers container restart on both HF Spaces and Render
      process.exit(1);
    }
  }, MAX_UPTIME_MS);
}

// ─── Memory monitoring with GC hint and browser lifecycle ───
const memoryCheckInterval = 60000;
let _memoryWarningCount = 0;
setInterval(() => {
  // Check both local and shared (from error-handler) shutdown flags
  const shuttingDown = isShuttingDown || !!(global as any).__isShuttingDown;
  if (shuttingDown) return;
  const mem = process.memoryUsage();
  const used = mem.heapUsed / 1024 / 1024;
  const external = mem.external / 1024 / 1024;

  if (used > CONFIG.MEMORY_RESTART_THRESHOLD_MB) {
    // Try aggressive GC before giving up
    if (global.gc) {
      log(`High memory: ${used.toFixed(0)}MB — attempting manual GC`, 'WARN', 'agent');
      global.gc();
      const afterGC = process.memoryUsage().heapUsed / 1024 / 1024;
      if (afterGC < CONFIG.MEMORY_WARNING_THRESHOLD_MB) {
        log(`GC recovered ${used.toFixed(0)}MB -> ${afterGC.toFixed(0)}MB`, 'INFO', 'agent');
        _memoryWarningCount = 0;
        return;
      }
    }
    log(`Memory critical: ${used.toFixed(0)}MB (external: ${external.toFixed(0)}MB, threshold ${CONFIG.MEMORY_RESTART_THRESHOLD_MB}MB) - restarting`, 'WARN', 'agent');
    if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Memory critical: ${used.toFixed(0)}MB, restarting`); } catch (e: any) {}
    // HF Spaces: exit(1) triggers container restart (desired behavior)
    // On Render, same behavior. This is intentional.
    process.exit(1);
  } else if (used > CONFIG.MEMORY_WARNING_THRESHOLD_MB) {
    _memoryWarningCount++;
    // Suggest browser close on persistent memory pressure
    if (_memoryWarningCount >= 3) {
      log(`Memory warning persistent (${_memoryWarningCount} checks): ${used.toFixed(0)}MB — closing browser to free memory`, 'WARN', 'agent');
      try {
        const browserMod = container.get('browser');
        if (browserMod?.browserManager?.pageInstance && !browserMod.browserManager.pageInstance.isClosed()) {
          browserMod.browserManager.cleanup().catch(() => {});
        }
      } catch (e: any) { /* best effort */ }
      _memoryWarningCount = 0;
    } else {
      log(`Memory warning: ${used.toFixed(0)}MB (external: ${external.toFixed(0)}MB) [${_memoryWarningCount}/3]`, 'WARN', 'agent');
    }
  } else {
    _memoryWarningCount = 0;
  }
}, memoryCheckInterval).unref();

// ─── Health checks ───
const failsafeCoordinator = container.get('failsafeCoordinator', { required: false });
if (failsafeCoordinator?.startHealthChecks) {
  failsafeCoordinator.startHealthChecks(60000);
}

// ─── Config updater ───
if (CONFIG.UPDATER_ENABLED) {
  try {
    const configUpdater = require('./cycle-config-updater');
    const updaterInterval = CONFIG.UPDATER_INTERVAL_HOURS * 60 * 60 * 1000;
    setTimeout(() => { log('Running initial config updater...', 'INFO', 'agent'); configUpdater.runConfigUpdater().catch((err: any) => logError('Config updater initial run failed', err)); }, 60000);
    setInterval(() => { log('Running scheduled config updater...', 'INFO', 'agent'); configUpdater.runConfigUpdater().catch((err: any) => logError('Config updater scheduled run failed', err)); }, updaterInterval).unref();
  } catch (e: any) { log('Config updater failed to load (non-critical)', 'WARN', 'agent'); }
}

// ─── UI Prompt updater ───
if (CONFIG.ENABLE_UI_PROMPT_UPDATER) {
  try {
    const uiPromptUpdater = require('./cycle-ui-prompt-updater');
    const LAST_UPDATE_FILE = path.join(PROJECT_ROOT, '.last-prompt-update');
    function shouldRunMonthly() {  try { const last = parseInt(fs.readFileSync(LAST_UPDATE_FILE, 'utf8'), 10); const days = CONFIG.UI_PROMPT_UPDATE_INTERVAL_DAYS || 30; return Date.now() - last > days * 24 * 60 * 60 * 1000; } catch { return true; } }
    if (shouldRunMonthly()) { setTimeout(() => { log('Running UI Prompt Updater (monthly)...', 'INFO', 'agent'); uiPromptUpdater.runUIPromptUpdater().then(() => { fs.writeFileSync(LAST_UPDATE_FILE, String(Date.now())); }).catch((err: any) => { logError('Prompt updater failed', err); }); }, 120000); }
    const baseInterval = (CONFIG.UI_PROMPT_UPDATE_INTERVAL_DAYS || 30) * 24 * 60 * 60 * 1000;
    setInterval(() => { log('Running scheduled UI Prompt Updater...', 'INFO', 'agent'); uiPromptUpdater.runUIPromptUpdater().then(() => { fs.writeFileSync(LAST_UPDATE_FILE, String(Date.now())); }).catch((err: any) => { logError('Prompt updater failed', err); }); }, baseInterval + Math.random() * 24 * 60 * 60 * 1000).unref();
  } catch (e: any) { log('UI Prompt updater failed to load (non-critical)', 'WARN', 'agent'); }
}

// ─── IP check ───
if (CONFIG.ENABLE_IP_CHECK) {
  const ipCheck = container.get('ipCheck', { required: false });
  ipCheck?.checkIpLocation?.().catch(() => {});
}

// ─── DB backup ───
const dbBackup = container.get('dbBackup', { required: false });
dbBackup?.startScheduledBackup?.();

// ─── Model evolution ───
const EVOLUTION_INTERVAL_DAYS = parseInt(process.env.EVOLUTION_INTERVAL_DAYS || '') || 30;
let isEvolving = false;

async function checkAndRunEvolution() { 
  if (isEvolving) return;
  try {
    const row = selectCalibration.get('last_evolution_timestamp');
    const lastRun = row ? parseInt(row.value, 10) : 0;
    const now = Date.now();
    const daysSince = (now - lastRun) / (1000 * 60 * 60 * 24);
    if (daysSince >= EVOLUTION_INTERVAL_DAYS) {
      log(`${daysSince.toFixed(1)} days since last evolution. Running monthly update...`, 'INFO', 'agent');
      isEvolving = true;
      try {
        const modelEvolution = container.get('modelEvolutionAdvanced', { required: false });
        if (modelEvolution) {
          const result = await modelEvolution.evolveModelsAdvanced();
          if (result.success) { log('Monthly model evolution completed successfully.', 'INFO', 'agent'); } else { log(`Monthly evolution finished with issues: ${result.message}`, 'WARN', 'agent'); }
        }
        upsertCalibration.run('last_evolution_timestamp', String(now), now);
      } catch (err: any) { logError('Monthly evolution failed', err); } finally { isEvolving = false; }
    } else {
      const remaining = (EVOLUTION_INTERVAL_DAYS - daysSince).toFixed(1);
      log(`Next model evolution in ~${remaining} days.`, 'DEBUG', 'agent');
    }
  } catch (err: any) { logError('Error checking evolution schedule', err); }
}

setTimeout(() => { checkAndRunEvolution().catch(() => {}); }, 5 * 60 * 1000);
setInterval(() => { checkAndRunEvolution().catch(() => {}); }, 6 * 60 * 60 * 1000).unref();

// ─── Template cache pruning ───
setTimeout(() => { pruneTemplateCache(); log('Initial template cache pruning completed.', 'INFO', 'agent'); }, 3600000);
setInterval(() => { pruneTemplateCache(); log('Monthly template cache pruning completed.', 'INFO', 'agent'); }, 30 * 24 * 60 * 60 * 1000).unref();

// ─── Remote brain ───
const remoteBrain = container.get('remoteBrain', { required: false });
if (remoteBrain) {
  setInterval(() => { remoteBrain.fetchStrategy().catch(() => {}); }, 10 * 60 * 1000).unref();
}

// ─── Autonomous features ───
const reflection = container.get('reflection', { required: false });
reflection?.startReflectionScheduler?.();

const strategyVariants = container.get('strategyVariants', { required: false });
strategyVariants?.runExperimentScheduler?.();

const anomalyDetector = container.get('anomalyDetector', { required: false });
anomalyDetector?.start?.();

const diary = container.get('diary', { required: false });
diary?.start?.();

const plugins = container.get('plugins', { required: false });
plugins?.loadPlugins?.();

// ─── Coordinator ───
const coordinator = container.get('coordinator', { required: false });
coordinator?.startCoordinator?.();

// ─── Resource manager ───
const resourceManager = container.get('resourceManager', { required: false });
resourceManager?.start?.();

// ─── Self-Heal v2: All subsystems via container ───
// A: Predictive & Proactive Healing
startSelfHealV2Subsystems(CONFIG);

// ─── Resilience subsystems ───
startResilienceSubsystems();

// B6: Prompt evolution
if (CONFIG.PROMPT_EVOLUTION_ENABLED) {
  try {
    const promptEvolution = require('./providers-prompt-evolution');
    setTimeout(() => promptEvolution.startEvolutionCycle().catch(() => {}), 2 * 60 * 60 * 1000);
    log('Prompt evolution scheduled', 'INFO', 'agent');
  } catch (e: any) { log('Prompt evolution failed to start (non-critical)', 'WARN', 'agent'); }
}

// ─── Validation suite periodic check ───
const validationSuite = container.get('validationSuite', { required: false });
if (validationSuite) {
  setInterval(() => {
    validationSuite.runCritical().then((results: any) => {
      const failed = results.filter((r: any) => !r.passed);
      if (failed.length > 0) {
        log(`Validation suite critical checks failed: ${failed.map((f: any) => f.id).join(', ')}`, 'WARN', 'agent');
        if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Validation critical failure: ${failed.map((f: any) => f.id).join(', ')}`); } catch (e: any) {}
      }
    }).catch((err: any) => logError('Validation check failed', err));
  }, 6 * 60 * 60 * 1000).unref();
}

// ─── Dashboard / Status Server ───
if (CONFIG.ENABLE_STATUS_SERVER) {
  const dashboard = container.get('dashboard', { required: false });
  dashboard?.startDashboard?.();
} else {
  // ─── Minimal status server (same API as before, but cleaner) ───
  // 3.1 FIX: Match dashboard-server.ts origin allowlist
  // HF Spaces: allow the Space's own origin pattern + localhost
  const DASHBOARD_ALLOWED_ORIGINS = process.env.DASHBOARD_ALLOWED_ORIGINS
    ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
    : IS_HF_SPACE
      ? ['http://localhost:7860', `https://${process.env.SPACE_AUTHOR_NAME || ''}-${process.env.SPACE_NAME || ''}.hf.space`]
      : ['http://localhost:8080'];
  const server = http.createServer((req: any, res: any) => {
    const origin = req.headers.origin || '';
    if (DASHBOARD_ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    // ── Admin: Evolve ──
    if (pathname === '/api/admin/evolve' && req.method === 'POST') {
      requireAuth(req, res, () => {
        log('Received remote trigger to evolve models.', 'INFO', 'agent');
        const modelEvolution = container.get('modelEvolutionAdvanced', { required: false });
        (modelEvolution?.evolveModelsAdvanced?.() || Promise.reject(new Error('Not available')))
          .then((result: any) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); })
          .catch((err: any) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
      });
      return;
    }

    // ── Brain override (validated before storage) ──
    if (pathname === '/api/brain/override' && req.method === 'POST') {
      return requireAuth(req, res, () => {
      let body = ''; const MAX_BODY = 1024 * 1024; let destroyed = false;
      req.on('data', (chunk: any) => { if (!destroyed) { body += chunk; if (body.length > MAX_BODY) { destroyed = true; req.destroy(); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Payload too large' })); } } }); req.on('end', () => { try { const data = JSON.parse(body); if (data.instruction) { const { validateInstruction } = require('./remote-brain-injector'); if (!validateInstruction(data.instruction)) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Instruction failed validation' })); return; } upsertCalibration.run('active_remote_instruction', data.instruction, Date.now()); res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: true })); } else { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Missing instruction' })); } } catch (e: any) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); } });
      });
    }

    // ── Blackbox (auth required — contains internal operation data) ──
    if (pathname === '/api/blackbox') {
      return requireAuth(req, res, () => {
        const blackbox = container.get('blackbox', { required: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(blackbox?.getRecent?.() || []));
      });
    }

    // ── GitOps rollback ──
    if (pathname === '/api/gitops/rollback' && req.method === 'POST') {
      requireAuth(req, res, async () => {
        const gitOps = container.get('selfHealGitops', { required: false });
        try {
          const result = gitOps?.gitops?.rollbackToPrevious
            ? await gitOps.gitops.rollbackToPrevious()
            : false;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: !!result }));
        } catch (err: any) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    // ── Admin token (exchange ADMIN_SECRET for JWT — rate limited + IP restricted) ──
    if (pathname === '/api/admin/token' && req.method === 'GET') {
      if (!ADMIN_SECRET) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Admin secret not set' })); return; }
      // SECURITY: Reject credential exchange over plain HTTP (non-TLS).
      // On Render/cloud, TLS is terminated at the load balancer — check X-Forwarded-Proto.
      // HF Spaces: TLS is handled by the proxy, but X-Forwarded-Proto may not be set.
      // When HF_SPACE=true, skip the TLS check (the HF proxy always uses HTTPS externally).
      const proto = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
      if (!IS_HF_SPACE && proto !== 'https') { res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'TLS required for admin endpoints' })); return; }
      // IP allowlist check
      if (ADMIN_ALLOWED_IPS.length > 0) {
        const clientIp = req.socket?.remoteAddress || '';
        const ipMatch = ADMIN_ALLOWED_IPS.some(allowed => clientIp === allowed.trim());
        if (!ipMatch) {
          res.writeHead(403, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Forbidden: IP not allowed' }));
          return;
        }
      }
      // Rate limiting
      if (!checkAdminRateLimit(req)) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Rate limited' }));
        return;
      }
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${ADMIN_SECRET}`) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unauthorized' })); return; }
      const token = generateToken({ admin: true });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ token }));
      return;
    }

    // ── Health ──
    if (pathname === '/health' || pathname === '/api/health') {
      const healthChecker = container.get('healthCheck', { required: false });
      const stateMachine = container.get('stateMachine');
      const stats = getStats();

      (healthChecker?.runAllChecks?.() || Promise.resolve([])).then((healthResults: any) => {
        const health = {
          status: healthChecker?.getOverallStatus?.() || 'unknown',
          timestamp: new Date().toISOString(),
          checks: healthResults,
          stats: { questionsCompleted: stats.questionsCompleted || 0, cycleCount: stats.cycleCount || 0, uptime: process.uptime() },
          container: getContainerHealth(),
          memory: (() => { const m = process.memoryUsage(); return { heapUsed: m.heapUsed / 1024 / 1024, heapTotal: m.heapTotal / 1024 / 1024, external: m.external / 1024 / 1024 }; })(),
          state: { current: stateMachine?.stateMachine?.getCurrentState?.() || null, deadlock: stateMachine?.detectDeadlock?.() || false },
        };
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(health));
      }).catch((err: any) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
      return;
    }

    // ── Status & Metrics ──
    if (pathname === '/api/status') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(getStats())); return; }
    if (pathname === '/api/metrics') {
      const metricsMod = container.get('metrics', { required: false });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(metricsMod?.metrics?.getSummary?.() || {}));
      return;
    }

    // ── Critical patch endpoints ──
    if (pathname === '/api/critical-patch/request' && req.method === 'POST') {
      requireAuth(req, res, () => {
        try {
          const consensus = container.get('criticalPatchConsensus', { required: false });
          if (!consensus) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Critical consensus module not available' })); return; }
          let body = ''; const MAX_BODY = 1024 * 1024; let destroyed = false;
          req.on('data', (chunk: any) => { if (!destroyed) { body += chunk; if (body.length > MAX_BODY) { destroyed = true; req.destroy(); res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Payload too large' })); } } });
          req.on('end', () => {
            if (destroyed) return;
            try {
              const data = JSON.parse(body);
              consensus.requestCriticalPatch({ targetFile: data.file, description: data.description || '', proposedPatch: data.proposedPatch || '' })
                .then((result: any) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(result)); })
                .catch((err: any) => { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: err.message })); });
            } catch (e: any) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Invalid JSON' })); }
          });
        } catch (e: any) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Critical consensus module not available' })); }
      });
      return;
    }

    if (pathname === '/api/critical-patch/status' && req.method === 'GET') {
      requireAuth(req, res, () => {
        const consensus = container.get('criticalPatchConsensus', { required: false });
        if (!consensus) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not available' })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(consensus.getConsensusStatus()));
      });
      return;
    }

    // ── Self-heal endpoints (auth required) ──
    if (pathname === '/api/self-heal/timeline' && req.method === 'GET') {
      return requireAuth(req, res, () => {
        try {
          const timeline = container.get('healTimeline', { required: false });
          const featureFilter = url.searchParams.get('feature') || null;
          const events = timeline?.getTimeline?.(50, featureFilter) || [];
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(timeline?.formatTimelineForAPI?.(events) || events));
        } catch (e: any) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); }
      });
    }
    if (pathname === '/api/self-heal/stats' && req.method === 'GET') {
      return requireAuth(req, res, () => {
        const timeline = container.get('healTimeline', { required: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(timeline?.getStats?.() || {}));
      });
    }
    if (pathname === '/api/self-heal/circuit-breaker' && req.method === 'GET') {
      return requireAuth(req, res, () => {
        const cb = container.get('healerCircuitBreaker', { required: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(cb?.getState?.() || { open: false }));
      });
    }
    if (pathname === '/api/self-heal/degradation' && req.method === 'GET') {
      return requireAuth(req, res, () => {
        const ladder = container.get('degradationLadder', { required: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ mode: ladder?.getCurrentMode?.() || 'UNKNOWN' }));
      });
    }
    if (pathname === '/api/self-heal/canary' && req.method === 'GET') {
      return requireAuth(req, res, () => {
        const canary = container.get('canary', { required: false });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ active: canary?.getActiveCanary?.(), history: canary?.getCanaryHistory?.() || [] }));
      });
    }

    // ── Container health endpoint (auth required — exposes internal module states) ──
    if (pathname === '/api/container' && req.method === 'GET') {
      return requireAuth(req, res, () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(getContainerHealth()));
      });
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found');
  });

  // Hugging Face Spaces requires port 7860. $PORT is injected by both HF and Render.
  const port = process.env.PORT || process.env.STATUS_PORT || CONFIG.STATUS_PORT || 7860;
  server.listen(port, () => {
    log(`Status server listening on port ${port}${IS_HF_SPACE ? ' (HF Spaces)' : ''}`, 'INFO', 'agent');
    // HF Spaces: CORS allowlist includes the Space's own origin
    if (IS_HF_SPACE) {
      log('HF Spaces mode: admin TLS check relaxed (proxy handles TLS)', 'INFO', 'agent');
    }
  });
  }

// ─── Heartbeat ───
setInterval(() => { if (CONFIG.HEARTBEAT_FILE) { try { fs.writeFileSync(CONFIG.HEARTBEAT_FILE, String(Date.now())); } catch (_e: any) { /* best-effort heartbeat write */ } } }, CONFIG.HEARTBEAT_INTERVAL_MS).unref();

// ─── Remote config ───
const remoteConfig = container.get('remoteConfig', { required: false });
remoteConfig?.loadRemoteConfig?.().catch(() => {});

// ─── Runtime guardian ───
if (CONFIG.ENABLE_RUNTIME_GUARDIAN) {
  try {
    const runtimeGuardian = require('./runtime-guardian');
    runtimeGuardian.start();
    log('Runtime Guardian started.', 'INFO', 'agent');
  } catch (e: any) { logError('Runtime Guardian failed to start', e); }
}

// ─── Startup smoke tests (catch common failure modes before daemon) ───
const { runStartupSmokeTests } = require('./container');
const smokeResult = runStartupSmokeTests();
if (!smokeResult.passed && CONFIG.ALERT_ON_ERROR) {
  const failedChecks = smokeResult.checks.filter((c: any) => !c.passed).map((c: any) => `${c.id}(${c.detail || 'unknown'})`).join('; ');
  try { sendAlert(`Startup smoke tests failed: ${failedChecks}`); } catch (e: any) { /* non-critical */ }
}

// ─── HF Spaces: Self-ping keep-alive ───────────────────────────────────────
// HF Spaces may sleep after inactivity. Pinging ourselves every 30s via the
// internal health endpoint keeps the container warm and responsive.
if (IS_HF_SPACE) {
  const keepAliveInterval = 30_000;
  setInterval(() => {
    try {
      const port = process.env.PORT || 7860;
      http.get(`http://localhost:${port}/health`, (res: any) => {
        res.resume(); // consume response to free memory
      }).on('error', () => { /* non-critical — health server may not be up yet */ });
    } catch { /* non-critical */ }
  }, keepAliveInterval).unref();
  log(`HF Spaces keep-alive self-ping enabled (every ${keepAliveInterval / 1000}s)`, 'INFO', 'agent');
}

// ─── Start the main daemon loop ───
startDaemon().catch(err => {  logError('Fatal daemon error', err); if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Fatal daemon error: ${err.message}`); } catch (e2: any) {} process.exit(1); });
