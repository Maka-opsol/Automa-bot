'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Dashboard Server — Connected to render-free-plan.ts via container
// ═══════════════════════════════════════════════════════════════════════
// This module provides the full dashboard UI and all management API
// endpoints. It exports handleDashboardRequest() for mounting into
// an existing HTTP server (render-free-plan.ts), and also exports
// createDashboardServer() / startDashboard() for standalone use.
//
// Dependencies come from the container module (same as render-free-plan.ts).
// ═══════════════════════════════════════════════════════════════════════

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const crypto = require('crypto');
const { container } = require('./container');

// ── Resolve logger from container (with fallback) ──
function getLog() {
  try { return container.get('logger'); } catch { return require('./logger'); }
}

const log    = (...args: any[]) => getLog().log(...args);
const logErr = (...args: any[]) => getLog().logError(...args);

function getCONFIG(): Record<string, any> {
  try { return container.get('config'); } catch { return require('./get-config'); }
}

// ── Resolve dependencies from container ──
function getProviderStats() {
  try { return container.get('providersStats')?.getStats; } catch { return undefined; }
}
function getStateDiagnostics() {
  try { return container.get('stateMachine')?.getStateDiagnostics; } catch { return undefined; }
}
function getCacheStats() {
  try { return container.get('cache')?.getCacheStats; } catch { return undefined; }
}
function getDatabaseStats() {
  try { return container.get('database')?.getDatabaseStats; } catch { return undefined; }
}
function getFailsafeDiagnostics() {
  try { return container.get('failsafeCoordinator')?.getDiagnostics; } catch { return undefined; }
}
function getBrowserMetrics() {
  try { return container.get('browser')?.getBrowserMetrics; } catch { return undefined; }
}
function getGenerateToken() {
  try { return container.get('jwt')?.generateToken; } catch { return undefined; }
}
function getRequireAuth() {
  try { return container.get('jwt')?.requireAuth; } catch { return undefined; }
}

function _timingSafeEqual(a: any, b: any) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
}

const DASHBOARD_DIR = path.join(PROJECT_ROOT, 'public');
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

// ── Screenshot cache (shared with render-free-plan.ts via globals) ──
// render-free-plan.ts sets (globalThis).__setLatestScreenshot and
// (globalThis).__getLatestScreenshot. We mirror them here so the
// dashboard can serve screenshots even when loaded standalone.

let _latestScreenshot: { screenshot: string; timestamp: number; action?: any } | null = null;

function setLatestScreenshot(base64Jpeg: string, action?: any) {
  if (base64Jpeg.length > 500_000) return;
  _latestScreenshot = { screenshot: base64Jpeg, timestamp: Date.now(), action };
}

function getLatestScreenshot() {
  if (_latestScreenshot && Date.now() - _latestScreenshot.timestamp > 120_000) {
    _latestScreenshot = null;
  }
  return _latestScreenshot;
}

// Expose globally so cycle manager can call it (same globals as render-free-plan)
if (!(globalThis as any).__setLatestScreenshot) (globalThis as any).__setLatestScreenshot = setLatestScreenshot;
if (!(globalThis as any).__getLatestScreenshot) (globalThis as any).__getLatestScreenshot = getLatestScreenshot;

// ── Helper: read JSON body from request ──
function readBody(req: any, res: any, cb: (body: string) => void) {
  let body = '';
  const MAX = 1 * 1024 * 1024;
  let tooLarge = false;
  req.on('data', (chunk: any) => {
    if (body.length > MAX) {
      if (!tooLarge) { tooLarge = true; res.writeHead(413, { 'Content-Type': 'application/json' }); res.end('{"error":"Body too large"}'); req.destroy(); }
      return;
    }
    body += chunk;
  });
  req.on('end', () => { if (!tooLarge) cb(body); });
}

// ── Helper: JSON response ──
function jsonRes(res: any, data: any, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

// ── Helper: format uptime ──
function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  parts.push(`${s}s`);
  return parts.join(' ');
}

// ── Helper: get all known states from state-machine ──
function getAllStates(): string[] {
  try {
    const sm = require('./state-machine');
    return Object.values(sm.STATES || {});
  } catch { return []; }
}

function getAllActions(): string[] {
  try {
    const sm = require('./state-machine');
    return Object.keys(sm.ACTIONS || {});
  } catch { return []; }
}

// ── Helper: capture a live screenshot right now ──
async function captureLiveScreenshot(): Promise<string | null> {
  try {
    const browserMod = require('./browser');
    const page = browserMod.browserManager?.getPage?.() || browserMod.browserManager?.pageInstance;
    if (!page || page.isClosed()) return null;
    const buf = await page.screenshot({ type: 'jpeg', quality: 40 });
    const base64 = buf.toString('base64');
    try {
      const compressed = await browserMod.compressScreenshot?.(base64, 800, 30);
      if (compressed) return compressed;
    } catch { /* sharp not available, use raw */ }
    if (base64.length > 300_000) return base64.substring(0, 300_000);
    return base64;
  } catch (e: any) {
    log(`Live screenshot capture failed: ${e.message}`, 'WARN', 'dashboard');
    return null;
  }
}

// ── Helper: get stop state ──
function getDaemonState(): { running: boolean; stopRequested: boolean } {
  try {
    const orch = require('./cycle-orchestrator');
    return {
      running: !!orch.startDaemon,
      stopRequested: !!orch._stopRequested,
    };
  } catch { return { running: false, stopRequested: false }; }
}

// ── Helper: get available config keys that can be changed ──
const SAFE_CONFIG_KEYS = new Set([
  'SLEEP_MIN_HOURS', 'SLEEP_MAX_HOURS', 'MAX_CYCLES_BEFORE_RESTART',
  'MAX_CONSECUTIVE_FAILURES', 'CANARY_OBSERVATION_HOURS',
  'PROMPT_EVOLUTION_MIN_ENTRIES', 'VISION_PRIORITY',
  'ALERT_ON_ERROR', 'ALERT_ON_STAGNATION', 'ANOMALY_CHECK_INTERVAL_MS',
  'OPENROUTER_TRIBUNAL_MODEL',
]);

function serveStaticFile(res: any, filePath: any, contentType: any) {
  fs.readFile(filePath, (err: any, content: any) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

// ═══════════════════════════════════════════════════════════════════════
//  REQUEST HANDLER — Can be mounted into any HTTP server
// ═══════════════════════════════════════════════════════════════════════
// Returns true if the request was handled (caller should NOT send 404).
// Returns false if the request didn't match any dashboard route.
// ═══════════════════════════════════════════════════════════════════════

async function handleDashboardRequest(req: any, res: any): Promise<boolean> {
  const DASHBOARD_ALLOWED_ORIGINS = process.env.DASHBOARD_ALLOWED_ORIGINS
      ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
      : ['*'];
  const origin = req.headers.origin || '';
  if (DASHBOARD_ALLOWED_ORIGINS.includes(origin) || DASHBOARD_ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', origin || '*');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return true; }

  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname;

  // Require auth for dashboard API routes (except /health)
  // Accepts both raw ADMIN_SECRET and JWT tokens (via requireAuth)
  const requireAuth = getRequireAuth();
  const authWrap = (cb: () => void) => {
    // First check: raw ADMIN_SECRET (timing-safe)
    if (ADMIN_SECRET) {
      const authHdr = req.headers.authorization || '';
      if (authHdr.startsWith('Bearer ') && _timingSafeEqual(authHdr.slice(7), ADMIN_SECRET)) {
        cb();
        return;
      }
    }
    // Second check: JWT via requireAuth (if available)
    if (requireAuth) {
      requireAuth(req, res, () => {
        cb();
      });
      return;
    }
    // No auth configured — allow through
    cb();
  };

  // ═══════════════════════════════════════════════════════════════
  //  HTML DASHBOARD
  // ═══════════════════════════════════════════════════════════════
  if (pathname === '/dashboard' || pathname === '/dashboard/') {
    const indexPath = path.join(DASHBOARD_DIR, 'index.html');
    if (fs.existsSync(indexPath)) {
      serveStaticFile(res, indexPath, 'text/html');
      return true;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getDashboardHTML());
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  READ-ONLY API ENDPOINTS
  // ═══════════════════════════════════════════════════════════════

  // Status
  if (pathname === '/api/status') {
    authWrap(() => {
      const stats = getProviderStats();
      jsonRes(res, stats ? stats() : {});
    });
    return true;
  }

  // State diagnostics
  if (pathname === '/api/state') {
    authWrap(() => {
      const diagnostics = getStateDiagnostics();
      jsonRes(res, diagnostics ? diagnostics() : {});
    });
    return true;
  }

  // Daemon state (running/paused)
  if (pathname === '/api/daemon') {
    authWrap(() => {
      jsonRes(res, getDaemonState());
    });
    return true;
  }

  // Available states list
  if (pathname === '/api/states') {
    authWrap(() => {
      jsonRes(res, { states: getAllStates() });
    });
    return true;
  }

  // Available actions list
  if (pathname === '/api/actions') {
    authWrap(() => {
      jsonRes(res, { actions: getAllActions() });
    });
    return true;
  }

  // Logs
  if (pathname === '/api/logs') {
    authWrap(() => {
      try {
        const logFile = path.join(getCONFIG().LOG_DIR, 'daemon.log');
        if (fs.existsSync(logFile)) {
          const data = fs.readFileSync(logFile, 'utf8');
          const lines = data.split('\n').filter(Boolean);
          const tail = lines.slice(-200);
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end(tail.join('\n'));
        } else {
          res.writeHead(200, { 'Content-Type': 'text/plain' });
          res.end('No log file found');
        }
      } catch (e: any) {
        res.writeHead(500);
        res.end('Error reading log file');
      }
    });
    return true;
  }

  // Health (deep)
  if (pathname === '/api/health' || pathname === '/api/health/deep') {
    authWrap(() => {
      const mem = process.memoryUsage();
      const stats = getProviderStats();
      const health = {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        stats: stats ? stats() : {},
        state: (() => { const d = getStateDiagnostics(); return d ? d() : {}; })(),
        daemon: getDaemonState(),
        memory: {
          heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
          heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(0) + 'MB',
          rss: (mem.rss / 1024 / 1024).toFixed(0) + 'MB',
          rssPercent: ((mem.rss / (512 * 1024 * 1024)) * 100).toFixed(1) + '%',
        },
        uptime: process.uptime(),
        uptimeFormatted: formatUptime(process.uptime()),
        browser: (() => { const m = getBrowserMetrics(); return m ? m() : {}; })(),
        database: (() => { const s = getDatabaseStats(); return s ? s() : {}; })(),
        cache: (() => { const s = getCacheStats(); return s ? s() : {}; })(),
        failsafe: (() => { const d = getFailsafeDiagnostics(); return d ? d() : {}; })(),
      };
      jsonRes(res, health);
    });
    return true;
  }

  // Metrics
  if (pathname === '/api/metrics') {
    authWrap(() => {
      try {
        const { metrics } = require('./metrics');
        jsonRes(res, metrics.getSummary ? metrics.getSummary() : {});
      } catch { jsonRes(res, {}); }
    });
    return true;
  }

  // ── Cached screenshot (set by cycle manager) ──
  if (pathname === '/api/screenshot') {
    authWrap(() => {
      const shot = getLatestScreenshot();
      if (!shot) { jsonRes(res, { available: false }, 204); return; }
      jsonRes(res, {
        available: true,
        timestamp: shot.timestamp,
        age: Date.now() - shot.timestamp,
        action: shot.action ? {
          actionType: shot.action.actionType,
          currentState: shot.action.currentState,
          reasoning: shot.action.reasoning?.substring(0, 200),
        } : null,
        screenshot: shot.screenshot,
      });
    });
    return true;
  }

  // ── Live screenshot (capture right now) ──
  if (pathname === '/api/screenshot/live') {
    authWrap(async () => {
      try {
        const jpeg = await captureLiveScreenshot();
        if (!jpeg) { jsonRes(res, { available: false, error: 'Browser not available' }, 503); return; }
        jsonRes(res, { available: true, timestamp: Date.now(), screenshot: jpeg });
      } catch (e: any) {
        jsonRes(res, { available: false, error: e.message }, 500);
      }
    });
    return true;
  }

  // ── Provider health ──
  if (pathname === '/api/providers') {
    authWrap(async () => {
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
        const loadFailures = registryMod.getLoadFailures ? registryMod.getLoadFailures() : [];
        jsonRes(res, { providers: healthDetails, loadFailures, providerCount: healthDetails.length, timestamp: Date.now() });
      } catch (e: any) {
        jsonRes(res, { error: e.message }, 500);
      }
    });
    return true;
  }

  // ── Banned actions (GET) ──
  if (pathname === '/api/banned-actions' && req.method === 'GET') {
    authWrap(() => {
      try {
        const { listBannedActions } = require('./database');
        jsonRes(res, listBannedActions());
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Full status (combined) ──
  if (pathname === '/api/full-status') {
    authWrap(async () => {
      try {
        const stats = getProviderStats();
        const mem = process.memoryUsage();
        const shot = getLatestScreenshot();
        const healthMod = require('./providers-health');
        const registryMod = require('./providers-registry');
        const providers = registryMod.getAvailableProviders ? await registryMod.getAvailableProviders() : [];
        const providerSummary = providers.map((p: any) => ({
          name: p.name, healthScore: p.healthScore,
          isAvailable: healthMod.isProviderAvailable?.(p.name) ?? true,
        }));
        const loadFailures = registryMod.getLoadFailures ? registryMod.getLoadFailures() : [];
        const providerCount = registryMod.getAvailableProviderCount ? registryMod.getAvailableProviderCount() : 0;
        jsonRes(res, {
          ...(stats ? stats() : {}),
          daemon: getDaemonState(),
          memory: {
            heapUsed: (mem.heapUsed / 1024 / 1024).toFixed(0) + 'MB',
            heapTotal: (mem.heapTotal / 1024 / 1024).toFixed(0) + 'MB',
            rss: (mem.rss / 1024 / 1024).toFixed(0) + 'MB',
          },
          uptime: process.uptime(),
          uptimeFormatted: formatUptime(process.uptime()),
          screenshotAvailable: !!shot,
          providers: providerSummary,
          providerLoadFailures: loadFailures,
          providerCount,
          timestamp: Date.now(),
          actionCache: (() => { try { return require('./services-action-cache').getStats(); } catch { return null; } })(),
          workShifts: (() => { try { const ws = require('./services-work-shifts'); const s = ws.getShift(); return { current: s.current, reason: s.reason, fullCycle: ws.shouldRunFullCycle() }; } catch { return null; } })(),
        });
      } catch (e: any) {
        jsonRes(res, { error: e.message, timestamp: Date.now() }, 500);
      }
    });
    return true;
  }

  // ═══════════════════════════════════════════════════════════════
  //  CONTROL API ENDPOINTS (write operations)
  // ═══════════════════════════════════════════════════════════════

  // Admin token
  if (pathname === '/api/admin/token' && req.method === 'GET') {
    if (!ADMIN_SECRET) { jsonRes(res, { error: 'Admin secret not set' }, 503); return true; }
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || !_timingSafeEqual(authHeader.slice(7), ADMIN_SECRET)) {
      jsonRes(res, { error: 'Unauthorized' }, 401);
      return true;
    }
    const gen = getGenerateToken();
    jsonRes(res, { token: gen ? gen({ admin: true }) : null });
    return true;
  }

  // ── Emergency stop ──
  if (pathname === '/api/emergency/stop' && req.method === 'POST') {
    authWrap(() => {
      try {
        const { requestStop } = require('./cycle-orchestrator');
        requestStop();
        log('Emergency stop via dashboard', 'WARN', 'dashboard');
        jsonRes(res, { success: true, message: 'Emergency stop requested' });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Resume daemon ──
  if (pathname === '/api/daemon/resume' && req.method === 'POST') {
    authWrap(() => {
      try {
        const { resumeDaemon } = require('./cycle-orchestrator');
        resumeDaemon();
        log('Daemon resumed via dashboard', 'INFO', 'dashboard');
        jsonRes(res, { success: true, message: 'Daemon resumed' });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Self-heal trigger ──
  if (pathname === '/api/self-heal/trigger' && req.method === 'POST') {
    authWrap(() => {
      try {
        const { performSelfHeal } = require('./self-heal');
        performSelfHeal().then((result: any) => {
          jsonRes(res, { success: result });
        }).catch((err: any) => {
          jsonRes(res, { error: err.message }, 500);
        });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── GitOps rollback ──
  if (pathname === '/api/gitops/rollback' && req.method === 'POST') {
    authWrap(() => {
      try {
        const gitOps = require('./self-heal-gitops');
        const result = gitOps.gitops?.rollbackToPrevious ? gitOps.gitops.rollbackToPrevious() : false;
        jsonRes(res, { success: result });
      } catch (err: any) {
        logErr('GitOps rollback failed', err);
        jsonRes(res, { success: false, error: err.message }, 500);
      }
    });
    return true;
  }

  // ── Force state (via state-machine) ──
  if (pathname === '/api/force-state' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.state || typeof data.state !== 'string') {
            jsonRes(res, { error: 'state is required' }, 400); return;
          }
          const { forceState } = require('./state-machine');
          forceState(data.state, 'dashboard_admin');
          log(`State forced via dashboard: ${data.state}`, 'WARN', 'dashboard');
          jsonRes(res, { success: true, state: data.state });
        } catch (e: any) {
          jsonRes(res, { error: e.message }, 400);
        }
      });
    });
    return true;
  }

  // ── Ban action ──
  if (pathname === '/api/banned-actions' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.action_type) { jsonRes(res, { error: 'action_type is required' }, 400); return; }
          const { insertBannedAction } = require('./database');
          insertBannedAction(data.action_type, 'dashboard', Date.now(), data.reason || 'Manual ban via dashboard');
          log(`Action banned via dashboard: ${data.action_type} (${data.reason || 'no reason'})`, 'WARN', 'dashboard');
          jsonRes(res, { success: true, banned: data.action_type });
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  // ── Unban action ──
  if (pathname === '/api/banned-actions' && req.method === 'DELETE') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!data.action_type) { jsonRes(res, { error: 'action_type is required' }, 400); return; }
          const { deleteBannedAction } = require('./database');
          deleteBannedAction(data.action_type);
          log(`Action unbanned via dashboard: ${data.action_type}`, 'INFO', 'dashboard');
          jsonRes(res, { success: true, unbanned: data.action_type });
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  // ── Action cache management ──
  if (pathname === '/api/action-cache/clear' && req.method === 'POST') {
    authWrap(() => {
      try {
        const ac = require('./services-action-cache');
        ac.clear();
        log('Action cache cleared via dashboard', 'INFO', 'dashboard');
        jsonRes(res, { success: true });
      } catch (e: any) { jsonRes(res, { error: e.message }, 500); }
    });
    return true;
  }

  // ── Set config ──
  if (pathname === '/api/config' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          if (!SAFE_CONFIG_KEYS.has(data.key)) {
            jsonRes(res, { error: 'Config key not allowed. Allowed: ' + [...SAFE_CONFIG_KEYS].join(', ') }, 403); return;
          }
          const { updateConfig } = require('./get-config');
          updateConfig(data.key, data.value);
          log(`Config changed via dashboard: ${data.key} = ${data.value}`, 'INFO', 'dashboard');
          jsonRes(res, { success: true, key: data.key, value: data.value });
        } catch (e: any) { jsonRes(res, { error: e.message }, 400); }
      });
    });
    return true;
  }

  // ── Generic command endpoint (legacy compat) ──
  if (pathname === '/api/command' && req.method === 'POST') {
    authWrap(() => {
      readBody(req, res, (body) => {
        try {
          const data = JSON.parse(body);
          const { action, params } = data;
          if (action === 'force_state' && params?.state) {
            const { forceState } = require('./state-machine');
            forceState(params.state, 'admin_command');
            jsonRes(res, { success: true, state: params.state });
          } else if (action === 'restart') {
            jsonRes(res, { success: true, message: 'Restarting in 5 seconds...' });
            log('Restart requested via dashboard', 'WARN', 'dashboard');
            setTimeout(() => process.exit(0), 5000);
          } else if (action === 'gc') {
            if (global.gc) global.gc();
            jsonRes(res, { success: true });
          } else if (action === 'set_config') {
            if (!SAFE_CONFIG_KEYS.has(params.key)) {
              jsonRes(res, { error: 'Config key not allowed' }, 403); return;
            }
            const { updateConfig } = require('./get-config');
            updateConfig(params.key, params.value);
            jsonRes(res, { success: true });
          } else {
            jsonRes(res, { error: 'Unknown command' }, 400);
          }
        } catch (e: any) { jsonRes(res, { error: 'Invalid JSON' }, 400); }
      });
    });
    return true;
  }

  // ── Not a dashboard route ──
  return false;
}

// ═══════════════════════════════════════════════════════════════════════
//  STANDALONE SERVER CREATION (for non-render-free-plan use)
// ═══════════════════════════════════════════════════════════════════════

function createDashboardServer() {
  const server = http.createServer(async (req: any, res: any) => {
    const handled = await handleDashboardRequest(req, res);
    if (!handled) {
      res.writeHead(404);
      res.end('Not found');
    }
  });
  return server;
}

function startDashboard() {
  const server = createDashboardServer();
  const port = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || getCONFIG().STATUS_PORT || 8080);
  server.listen(port, () => {
    log(`Dashboard listening on port ${port}`, 'INFO', 'dashboard');
  });
  return server;
}

// ═══════════════════════════════════════════════════════════════════════
//  EMBEDDED DASHBOARD HTML
// ═══════════════════════════════════════════════════════════════════════

function getDashboardHTML(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MathU Bot Dashboard</title>
<style>
  :root {
    --bg: #0f1117;
    --bg2: #161822;
    --bg3: #1c1f2e;
    --border: #2a2d3e;
    --text: #e1e4ed;
    --text2: #8b8fa3;
    --accent: #6366f1;
    --accent2: #818cf8;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #eab308;
    --orange: #f97316;
    --radius: 8px;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); line-height: 1.5; }
  a { color: var(--accent2); }

  .header { background: var(--bg2); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
  .header h1 { font-size: 18px; font-weight: 600; }
  .header .status-badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 9999px; font-size: 12px; font-weight: 600; }
  .header .status-badge.ok { background: #052e16; color: var(--green); }
  .header .status-badge.warn { background: #422006; color: var(--yellow); }
  .header .status-badge.err { background: #450a0a; color: var(--red); }
  .header .status-badge .dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; }
  .header .meta { margin-left: auto; font-size: 13px; color: var(--text2); }

  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 16px; padding: 16px 24px; }
  .card { background: var(--bg2); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden; }
  .card-header { padding: 12px 16px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; font-size: 14px; font-weight: 600; }
  .card-body { padding: 12px 16px; }

  .stat-row { display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .stat-row:last-child { border-bottom: none; }
  .stat-label { color: var(--text2); }
  .stat-value { font-weight: 600; font-variant-numeric: tabular-nums; }
  .stat-value.green { color: var(--green); }
  .stat-value.red { color: var(--red); }
  .stat-value.yellow { color: var(--yellow); }
  .stat-value.orange { color: var(--orange); }

  .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 16px; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg3); color: var(--text); font-size: 13px; font-weight: 500; cursor: pointer; transition: all 0.15s; }
  .btn:hover { background: var(--border); }
  .btn:active { transform: scale(0.97); }
  .btn.danger { border-color: #7f1d1d; color: var(--red); }
  .btn.danger:hover { background: #450a0a; }
  .btn.primary { border-color: #3730a3; color: var(--accent2); }
  .btn.primary:hover { background: #312e81; }
  .btn.success { border-color: #14532d; color: var(--green); }
  .btn.success:hover { background: #052e16; }
  .btn.sm { padding: 5px 10px; font-size: 12px; }
  .btn:disabled { opacity: 0.4; cursor: not-allowed; }

  .btn-group { display: flex; flex-wrap: wrap; gap: 8px; }

  select, input[type="text"], input[type="number"] {
    background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius);
    color: var(--text); padding: 7px 12px; font-size: 13px; font-family: inherit;
  }
  select:focus, input:focus { outline: none; border-color: var(--accent); }
  select { cursor: pointer; }

  .screenshot-container { position: relative; background: #000; border-radius: var(--radius); overflow: hidden; }
  .screenshot-container img { width: 100%; display: block; }
  .screenshot-overlay { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: var(--text2); font-size: 14px; background: rgba(0,0,0,0.6); }
  .screenshot-meta { padding: 8px; font-size: 11px; color: var(--text2); background: var(--bg); border-top: 1px solid var(--border); display: flex; justify-content: space-between; }

  .banned-list { max-height: 200px; overflow-y: auto; }
  .banned-item { display: flex; align-items: center; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .banned-item:last-child { border-bottom: none; }

  .provider-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-bottom: 1px solid var(--border); font-size: 13px; }
  .provider-row:last-child { border-bottom: none; }
  .provider-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .provider-dot.online { background: var(--green); }
  .provider-dot.offline { background: var(--red); }
  .provider-dot.degraded { background: var(--yellow); }

  .log-viewer { background: var(--bg); border: 1px solid var(--border); border-radius: var(--radius); padding: 10px; font-family: 'SF Mono', 'Cascadia Code', 'Fira Code', monospace; font-size: 12px; max-height: 350px; overflow-y: auto; white-space: pre-wrap; word-break: break-all; line-height: 1.6; }

  .toast-container { position: fixed; bottom: 20px; right: 20px; z-index: 1000; display: flex; flex-direction: column; gap: 8px; }
  .toast { padding: 10px 16px; border-radius: var(--radius); font-size: 13px; font-weight: 500; animation: slideIn 0.2s ease-out; }
  .toast.success { background: #052e16; color: var(--green); border: 1px solid #14532d; }
  .toast.error { background: #450a0a; color: var(--red); border: 1px solid #7f1d1d; }
  .toast.info { background: #1e1b4b; color: var(--accent2); border: 1px solid #3730a3; }
  @keyframes slideIn { from { opacity: 0; transform: translateX(20px); } to { opacity: 1; transform: translateX(0); } }

  .config-row { display: flex; gap: 8px; margin-bottom: 8px; align-items: center; }
  .config-row select { flex: 1; }

  .empty { color: var(--text2); font-size: 13px; padding: 12px; text-align: center; }
  .full-width { grid-column: 1 / -1; }

  .action-info { font-size: 11px; color: var(--text2); margin-top: 4px; }

  @media (max-width: 640px) {
    .grid { padding: 12px; gap: 12px; }
    .header { padding: 12px 16px; }
    .header h1 { font-size: 16px; }
  }
</style>
</head>
<body>

<div class="header">
  <h1>MathU Bot</h1>
  <span id="statusBadge" class="status-badge ok"><span class="dot"></span><span id="statusText">Loading...</span></span>
  <span class="meta" id="metaInfo"></span>
</div>

<div class="grid" id="mainGrid">

  <!-- Screenshot -->
  <div class="card">
    <div class="card-header">
      <span>Screenshot</span>
      <div class="btn-group">
        <button class="btn sm primary" onclick="captureLive()">Capture Live</button>
        <button class="btn sm" onclick="refreshScreenshot()">Refresh Cached</button>
      </div>
    </div>
    <div class="card-body" style="padding:0">
      <div class="screenshot-container" id="screenshotBox">
        <div class="screenshot-overlay" id="screenshotOverlay">No screenshot available</div>
      </div>
      <div class="screenshot-meta">
        <span id="screenshotAge">-</span>
        <span id="screenshotAction">-</span>
      </div>
    </div>
  </div>

  <!-- Daemon Control -->
  <div class="card">
    <div class="card-header">Daemon Control</div>
    <div class="card-body">
      <div class="btn-group" style="margin-bottom: 12px;">
        <button class="btn danger" onclick="emergencyStop()">Emergency Stop</button>
        <button class="btn success" onclick="resumeDaemon()">Resume Daemon</button>
        <button class="btn primary" onclick="triggerSelfHeal()">Self-Heal</button>
      </div>
      <div class="btn-group">
        <button class="btn" onclick="gc()">Force GC</button>
        <button class="btn" onclick="clearActionCache()">Clear Action Cache</button>
        <button class="btn" onclick="rollback()">Rollback</button>
      </div>
      <div id="daemonState" class="action-info" style="margin-top:12px;">Loading...</div>
    </div>
  </div>

  <!-- State Control -->
  <div class="card">
    <div class="card-header">State Control</div>
    <div class="card-body">
      <div class="config-row">
        <select id="stateSelect"><option value="">Loading states...</option></select>
        <button class="btn primary" onclick="forceState()">Force State</button>
      </div>
      <div id="currentState" class="stat-row"><span class="stat-label">Current State</span><span class="stat-value">-</span></div>
      <div id="stateAge" class="stat-row"><span class="stat-label">State Age</span><span class="stat-value">-</span></div>
      <div id="deadlock" class="stat-row"><span class="stat-label">Deadlock</span><span class="stat-value">-</span></div>
    </div>
  </div>

  <!-- Ban Actions -->
  <div class="card">
    <div class="card-header">Action Bans</div>
    <div class="card-body">
      <div class="config-row">
        <select id="banActionSelect"><option value="">Loading actions...</option></select>
        <input type="text" id="banReason" placeholder="Reason (optional)" style="flex:1">
        <button class="btn danger sm" onclick="banAction()">Ban</button>
      </div>
      <div class="banned-list" id="bannedList"><div class="empty">Loading...</div></div>
    </div>
  </div>

  <!-- Config -->
  <div class="card">
    <div class="card-header">Config</div>
    <div class="card-body">
      <div class="config-row">
        <select id="configKeySelect">
          <option value="SLEEP_MIN_HOURS">SLEEP_MIN_HOURS</option>
          <option value="SLEEP_MAX_HOURS">SLEEP_MAX_HOURS</option>
          <option value="MAX_CYCLES_BEFORE_RESTART">MAX_CYCLES_BEFORE_RESTART</option>
          <option value="MAX_CONSECUTIVE_FAILURES">MAX_CONSECUTIVE_FAILURES</option>
          <option value="VISION_PRIORITY">VISION_PRIORITY</option>
          <option value="ALERT_ON_ERROR">ALERT_ON_ERROR</option>
          <option value="ALERT_ON_STAGNATION">ALERT_ON_STAGNATION</option>
          <option value="OPENROUTER_TRIBUNAL_MODEL">OPENROUTER_MODEL</option>
        </select>
        <input type="text" id="configValue" placeholder="Value" style="flex:1">
        <button class="btn primary sm" onclick="setConfig()">Set</button>
      </div>
    </div>
  </div>

  <!-- Providers -->
  <div class="card">
    <div class="card-header">Providers</div>
    <div class="card-body" id="providersList"><div class="empty">Loading...</div></div>
  </div>

  <!-- Memory & System -->
  <div class="card">
    <div class="card-header">System</div>
    <div class="card-body" id="systemStats"></div>
  </div>

  <!-- Action Cache -->
  <div class="card">
    <div class="card-header">Action Cache</div>
    <div class="card-body" id="actionCacheStats"><div class="empty">Loading...</div></div>
  </div>

  <!-- Logs -->
  <div class="card full-width">
    <div class="card-header">
      <span>Logs</span>
      <button class="btn sm" onclick="refreshLogs()">Refresh</button>
    </div>
    <div class="card-body" style="padding:0">
      <div class="log-viewer" id="logViewer">Loading...</div>
    </div>
  </div>
</div>

<div class="toast-container" id="toastContainer"></div>

<script>
const API = '';
let authHeader = '';
let autoRefresh = true;

async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (authHeader) headers['Authorization'] = authHeader;
  try {
    const r = await fetch(API + path, { ...opts, headers });
    if (r.status === 401) {
      const token = prompt('Enter admin token (or ADMIN_SECRET):');
      if (token) { authHeader = 'Bearer ' + token; return api(path, opts); }
      throw new Error('Unauthorized');
    }
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('application/json')) return r.json();
    return r.text();
  } catch (e) {
    console.error('API error:', path, e);
    return null;
  }
}

function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

function fmtUptime(s) {
  if (!s) return '-';
  const d = Math.floor(s/86400), h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60), sec = Math.floor(s%60);
  return [d>0?d+'d':'', h>0?h+'h':'', m>0?m+'m':'', sec+'s'].filter(Boolean).join(' ');
}

function fmtAge(ms) {
  if (!ms || ms < 0) return '-';
  if (ms < 60000) return Math.round(ms/1000) + 's ago';
  return Math.round(ms/60000) + 'm ago';
}

// ── Screenshot ──
async function refreshScreenshot() {
  const data = await api('/api/screenshot');
  if (!data) return;
  if (!data.available) {
    document.getElementById('screenshotOverlay').style.display = 'flex';
    document.getElementById('screenshotOverlay').textContent = 'No screenshot available';
    document.getElementById('screenshotAge').textContent = '-';
    document.getElementById('screenshotAction').textContent = '-';
    return;
  }
  const box = document.getElementById('screenshotBox');
  let img = box.querySelector('img');
  if (!img) { img = document.createElement('img'); box.appendChild(img); }
  img.src = 'data:image/jpeg;base64,' + data.screenshot;
  img.style.display = 'block';
  document.getElementById('screenshotOverlay').style.display = 'none';
  document.getElementById('screenshotAge').textContent = fmtAge(Date.now() - data.timestamp);
  document.getElementById('screenshotAction').textContent = data.action ? data.action.actionType + ' | ' + (data.action.currentState || '') : '-';
}

async function captureLive() {
  toast('Capturing live screenshot...', 'info');
  const data = await api('/api/screenshot/live');
  if (!data || !data.available) { toast('Failed to capture screenshot', 'error'); return; }
  const box = document.getElementById('screenshotBox');
  let img = box.querySelector('img');
  if (!img) { img = document.createElement('img'); box.appendChild(img); }
  img.src = 'data:image/jpeg;base64,' + data.screenshot;
  img.style.display = 'block';
  document.getElementById('screenshotOverlay').style.display = 'none';
  document.getElementById('screenshotAge').textContent = 'Just now';
  toast('Live screenshot captured', 'success');
}

// ── Daemon ──
async function emergencyStop() {
  if (!confirm('Stop the bot daemon? It will not run cycles until resumed.')) return;
  const r = await api('/api/emergency/stop', { method: 'POST' });
  if (r?.success) toast('Emergency stop activated', 'success');
  else toast('Stop failed', 'error');
  refreshAll();
}
async function resumeDaemon() {
  const r = await api('/api/daemon/resume', { method: 'POST' });
  if (r?.success) toast('Daemon resumed', 'success');
  else toast('Resume failed', 'error');
  refreshAll();
}
async function triggerSelfHeal() {
  toast('Self-heal triggered...', 'info');
  const r = await api('/api/self-heal/trigger', { method: 'POST' });
  toast(r?.success ? 'Self-heal complete' : 'Self-heal failed', r?.success ? 'success' : 'error');
}
async function gc() {
  const r = await api('/api/command', { method: 'POST', body: JSON.stringify({ action: 'gc' }) });
  toast(r?.success ? 'GC triggered' : 'GC failed', r?.success ? 'success' : 'error');
}
async function clearActionCache() {
  if (!confirm('Clear all cached actions?')) return;
  const r = await api('/api/action-cache/clear', { method: 'POST' });
  toast(r?.success ? 'Cache cleared' : 'Failed', r?.success ? 'success' : 'error');
  refreshAll();
}
async function rollback() {
  if (!confirm('Rollback to previous version?')) return;
  const r = await api('/api/gitops/rollback', { method: 'POST' });
  toast(r?.success ? 'Rollback initiated' : 'Rollback failed', r?.success ? 'success' : 'error');
}

// ── State ──
async function loadStates() {
  const r = await api('/api/states');
  if (!r) return;
  const sel = document.getElementById('stateSelect');
  sel.innerHTML = '<option value="">Select state...</option>' + r.states.map(s => '<option value="'+s+'">'+s+'</option>').join('');
}
async function forceState() {
  const s = document.getElementById('stateSelect').value;
  if (!s) return;
  if (!confirm('Force state to: ' + s + '?')) return;
  const r = await api('/api/force-state', { method: 'POST', body: JSON.stringify({ state: s }) });
  toast(r?.success ? 'State forced: ' + s : 'Failed: ' + (r?.error||''), r?.success ? 'success' : 'error');
  refreshAll();
}

// ── Actions Ban ──
async function loadActions() {
  const r = await api('/api/actions');
  if (!r) return;
  const sel = document.getElementById('banActionSelect');
  sel.innerHTML = '<option value="">Select action...</option>' + r.actions.map(a => '<option value="'+a+'">'+a+'</option>').join('');
}
async function banAction() {
  const action = document.getElementById('banActionSelect').value;
  const reason = document.getElementById('banReason').value;
  if (!action) return;
  const r = await api('/api/banned-actions', { method: 'POST', body: JSON.stringify({ action_type: action, reason }) });
  toast(r?.success ? 'Banned: ' + action : 'Failed', r?.success ? 'success' : 'error');
  refreshBans();
}
async function unbanAction(actionType) {
  const r = await api('/api/banned-actions', { method: 'DELETE', body: JSON.stringify({ action_type: actionType }) });
  toast(r?.success ? 'Unbanned: ' + actionType : 'Failed', r?.success ? 'success' : 'error');
  refreshBans();
}

// ── Config ──
async function setConfig() {
  const key = document.getElementById('configKeySelect').value;
  const value = document.getElementById('configValue').value;
  if (!key || !value) return;
  const r = await api('/api/config', { method: 'POST', body: JSON.stringify({ key, value }) });
  toast(r?.success ? key + ' = ' + value : 'Failed: ' + (r?.error||''), r?.success ? 'success' : 'error');
}

// ── Logs ──
async function refreshLogs() {
  const text = await api('/api/logs');
  const el = document.getElementById('logViewer');
  if (text) { el.textContent = typeof text === 'string' ? text : JSON.stringify(text); el.scrollTop = el.scrollHeight; }
}

// ── Refresh all data ──
async function refreshAll() {
  // Full status
  const full = await api('/api/full-status');
  if (full) {
    // Status badge
    const badge = document.getElementById('statusBadge');
    const sText = document.getElementById('statusText');
    const ds = full.daemon;
    if (ds?.stopRequested) { badge.className = 'status-badge warn'; sText.textContent = 'Paused'; }
    else { badge.className = 'status-badge ok'; sText.textContent = 'Running'; }

    // Meta
    document.getElementById('metaInfo').textContent = fmtUptime(full.uptime) + ' | ' + (full.memory?.rss || '-') + ' RSS';

    // Daemon state
    document.getElementById('daemonState').textContent = 'Stop: ' + (ds?.stopRequested ? 'YES' : 'no') + ' | Cycles: ' + (full.cycleCount || 0) + ' | Questions: ' + (full.questionsCompleted || 0);

    // System
    const sys = document.getElementById('systemStats');
    sys.innerHTML =
      '<div class="stat-row"><span class="stat-label">Uptime</span><span class="stat-value">' + fmtUptime(full.uptime) + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Heap Used</span><span class="stat-value">' + (full.memory?.heapUsed||'-') + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">RSS</span><span class="stat-value">' + (full.memory?.rss||'-') + '</span></div>' +
      '<div class="stat-row"><span class="stat-label">Providers</span><span class="stat-value">' + (full.providerCount||0) + '</span></div>' +
      (full.workShifts ? '<div class="stat-row"><span class="stat-label">Work Shift</span><span class="stat-value ' + (full.workShifts.fullCycle ? 'green' : 'yellow') + '">' + full.workShifts.current + '</span></div>' : '');

    // Action Cache
    const ac = full.actionCache;
    const acEl = document.getElementById('actionCacheStats');
    if (ac) {
      acEl.innerHTML =
        '<div class="stat-row"><span class="stat-label">Hits</span><span class="stat-value green">' + (ac.hits||0) + '</span></div>' +
        '<div class="stat-row"><span class="stat-label">Misses</span><span class="stat-value">' + (ac.misses||0) + '</span></div>' +
        '<div class="stat-row"><span class="stat-label">Saves</span><span class="stat-value">' + (ac.saves||0) + '</span></div>' +
        '<div class="stat-row"><span class="stat-label">Evictions</span><span class="stat-value red">' + (ac.evictions||0) + '</span></div>' +
        '<div class="stat-row"><span class="stat-label">Active Entries</span><span class="stat-value">' + (ac.activeEntries||0) + '</span></div>' +
        (ac.topActions?.length ? '<div style="margin-top:8px;font-size:11px;color:var(--text2)">Top: ' + ac.topActions.map(a=>a.action+' ('+a.count+')').join(', ') + '</div>' : '');
    } else { acEl.innerHTML = '<div class="empty">No cache data</div>'; }

    // Providers
    const pList = document.getElementById('providersList');
    if (full.providers?.length) {
      pList.innerHTML = full.providers.map(p => {
        const cls = p.isAvailable ? (p.healthScore > 70 ? 'online' : 'degraded') : 'offline';
        return '<div class="provider-row"><span class="provider-dot ' + cls + '"></span><span style="flex:1">' + p.name + '</span><span class="stat-value">' + (p.healthScore||0) + '%</span></div>';
      }).join('');
    } else { pList.innerHTML = '<div class="empty">No providers</div>'; }
  }

  // State
  const state = await api('/api/state');
  if (state) {
    document.querySelector('#currentState .stat-value').textContent = state.currentState || '-';
    document.querySelector('#stateAge .stat-value').textContent = state.stateAge ? fmtUptime(state.stateAge / 1000) : '-';
    const dl = document.querySelector('#deadlock .stat-value');
    if (state.deadlockDetected) { dl.textContent = 'DETECTED'; dl.className = 'stat-value red'; }
    else { dl.textContent = 'None'; dl.className = 'stat-value green'; }
  }

  // Screenshot
  refreshScreenshot();
  // Bans
  refreshBans();
}

// ── Init ──
(async function init() {
  await loadStates();
  await loadActions();
  await refreshAll();
  refreshLogs();
  setInterval(() => { if (autoRefresh) refreshAll(); }, 5000);
  setInterval(refreshLogs, 10000);
})();
</script>
</body>
</html>`;
}

module.exports = {
  handleDashboardRequest,
  createDashboardServer,
  startDashboard,
  getLatestScreenshot,
  setLatestScreenshot,
  _getDashboardHTML: getDashboardHTML,
};
