'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getProviderStats() { return _deps.providersStats?.getStats; }
function getProviderUpdateStats() { return _deps.providersStats?.updateStats; }
function getStateDiagnostics() { return _deps.stateMachine?.getStateDiagnostics; }
function getCacheStats() { return _deps.cache?.getCacheStats; }
function getDatabaseStats() { return _deps.database?.getDatabaseStats; }
function getFailsafeDiagnostics() { return _deps.failsafeCoordinator?.getDiagnostics; }
function getBrowserMetrics() { return _deps.browser?.getBrowserMetrics; }
function getGenerateToken() { return _deps.jwt?.generateToken; }
function getRequireAuth() { return _deps.jwt?.requireAuth; }

const http = require('http');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, logError } = require('./logger');
// 3.8 FIX: Lazy config access — prefer DI deps, fall back to direct require.
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }
const crypto = require('crypto');
function _timingSafeEqual(a: any, b: any) { if (typeof a !== 'string' || typeof b !== 'string') return false; if (a.length !== b.length) return false; try { return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; } }

const DASHBOARD_DIR = path.join(PROJECT_ROOT, 'public');
const ADMIN_SECRET = process.env.ADMIN_SECRET || null;

function serveStaticFile(res: any, filePath: any, contentType: any) {
  fs.readFile(filePath, (err: any, content: any) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
}

function createDashboardServer() { 
  const server = http.createServer((req: any, res: any) => {
    const DASHBOARD_ALLOWED_ORIGINS = process.env.DASHBOARD_ALLOWED_ORIGINS
        ? process.env.DASHBOARD_ALLOWED_ORIGINS.split(',')
        : ['http://localhost:8080'];
      const origin = req.headers.origin || '';
      if (DASHBOARD_ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/' || pathname === '/index.html') {
      const indexPath = path.join(DASHBOARD_DIR, 'index.html');
      if (fs.existsSync(indexPath)) {
        serveStaticFile(res, indexPath, 'text/html');
      } else {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`
          <!DOCTYPE html>
          <html><head><title>MathU Bot Dashboard</title>
          <style>body{font-family:sans-serif;padding:20px;background:#1a1a2e;color:#eee}
          .card{background:#16213e;padding:20px;border-radius:10px;margin:10px 0}
          .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:20px}
          .stat{font-size:24px;font-weight:bold;color:#0f3460}
          .label{color:#aaa;font-size:14px}
          pre{background:#0d1b2a;padding:15px;border-radius:5px;overflow:auto;max-height:400px}
          button{background:#0f3460;color:#fff;border:none;padding:10px 20px;border-radius:5px;cursor:pointer}
          button:hover{background:#1a4a7a}
          .danger{background:#e94560}
          .danger:hover{background:#c73e54}
          </style>
          </head>
          <body>
          <h1>🤖 MathU Bot Dashboard</h1>
          <div id="app">
            <div class="grid" id="stats-grid"></div>
            <div class="card"><h2>Actions</h2>
              <button onclick="fetch('/api/self-heal/trigger',{method:'POST'})">Trigger Self-Heal</button>
              <button onclick="fetch('/api/emergency/stop',{method:'POST'})" class="danger">Emergency Stop</button>
              <button onclick="fetch('/api/gitops/rollback',{method:'POST'})">Rollback</button>
            </div>
            <div class="card"><h2>Logs</h2>
              <pre id="logs">Loading...</pre>
            </div>
            <div class="card"><h2>State</h2>
              <pre id="state">Loading...</pre>
            </div>
          </div>
          <script>
            async function fetchJSON(url) { 
              const r = await fetch(url);
              return r.json();
            }
            async function refreshDashboard() { 
              try {
                const stats = await fetchJSON('/api/status');
                const state = await fetchJSON('/api/state');
                const logs = await fetch('/api/logs').then(r => r.text());
                document.getElementById('stats-grid').innerHTML = 
                  Object.entries(stats).map(([k,v]) =>
                    '<div class="card"><div class="stat">'+v+'</div><div class="label">'+k+'</div></div>'
                  ).join('');
                document.getElementById('state').textContent = JSON.stringify(state, null, 2);
                document.getElementById('logs').textContent = logs.slice(-5000);
              } catch (e: any) { console.error('Dashboard update error', e); }
            }
            refreshDashboard();
            setInterval(refreshDashboard, 5000);
          </script>
          </body></html>
        `);
      }
      return;
    }

    if (pathname === '/api/status') {
      getRequireAuth()(req, res, () => {
        const stats = getProviderStats()();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stats));
      });
      return;
    }

    if (pathname === '/api/state') {
      getRequireAuth()(req, res, () => {
        const diagnostics = getStateDiagnostics ? getStateDiagnostics()() : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(diagnostics));
      });
      return;
    }

    if (pathname === '/api/logs') {
      getRequireAuth()(req, res, () => {
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
      return;
    }

    if (pathname === '/api/health' || pathname === '/api/health/deep') {
      getRequireAuth()(req, res, () => {
        const health = {
          status: 'healthy',
          timestamp: new Date().toISOString(),
          stats: getProviderStats()(),
          state: getStateDiagnostics ? getStateDiagnostics()() : {},
          memory: process.memoryUsage(),
          uptime: process.uptime(),
          browser: getBrowserMetrics ? getBrowserMetrics()() : {},
          database: getDatabaseStats ? getDatabaseStats()() : {},
          cache: getCacheStats ? getCacheStats()() : {},
          failsafe: getFailsafeDiagnostics ? getFailsafeDiagnostics()() : {},
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(health));
      });
      return;
    }

    if (pathname === '/api/metrics') {
      getRequireAuth()(req, res, () => {
        const { metrics } = require('./metrics');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(metrics.getSummary ? metrics.getSummary() : {}));
      });
      return;
    }

    if (pathname === '/api/admin/token' && req.method === 'GET') {
      if (!ADMIN_SECRET) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Admin secret not set' }));
        return;
      }
      const authHeader = req.headers.authorization;
      if (!authHeader || !authHeader.startsWith('Bearer ') || !_timingSafeEqual(authHeader.slice(7), ADMIN_SECRET)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
      const token = getGenerateToken()({ admin: true });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token }));
      return;
    }

    if (pathname === '/api/self-heal/trigger' && req.method === 'POST') {
      getRequireAuth()(req, res, () => {
        const { performSelfHeal } = require('./self-heal');
        performSelfHeal().then((result: any) => { 
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: result }));
        }).catch((err: any) => {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        });
      });
      return;
    }

    if (pathname === '/api/emergency/stop' && req.method === 'POST') {
      getRequireAuth()(req, res, () => {
        const { requestStop } = require('./cycle-orchestrator');
        requestStop();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, message: 'Emergency stop requested' }));
      });
      return;
    }

    if (pathname === '/api/gitops/rollback' && req.method === 'POST') {
      getRequireAuth()(req, res, () => {
        const gitOps = require('./self-heal-gitops');
        try {
          const result = gitOps.gitops?.rollbackToPrevious
            ? gitOps.gitops.rollbackToPrevious()
            : false;
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: result }));
        } catch (err: any) {
          logError('GitOps rollback failed', err);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: err.message }));
        }
      });
      return;
    }

    if (pathname === '/api/command' && req.method === 'POST') {
      getRequireAuth()(req, res, () => {
        let body = ''; const MAX_BODY_SIZE = 1 * 1024 * 1024; let bodyTooLarge = false; req.on('data', (chunk: any) => { if (body.length > MAX_BODY_SIZE) { if (!bodyTooLarge) { bodyTooLarge = true; res.writeHead(413, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Request body too large' })); req.destroy(); } return; } body += chunk });
        req.on('end', () => {
          if (bodyTooLarge) return;
          try {
            const data = JSON.parse(body);
            const { action, params } = data;
            if (action === 'force_state' && params.state) {
              const { forceState } = require('./state-machine');
              forceState(params.state, 'admin_command');
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, state: params.state }));
            } else if (action === 'restart') {
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true, message: 'Restarting in 5 seconds...' }));
              log('Restart requested via dashboard, shutting down in 5s', 'WARN', 'dashboard');
              setTimeout(() => process.exit(0), 5000);
            } else if (action === 'gc') {
              if (global.gc) global.gc();
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } else if (action === 'set_config') {
              const SAFE_CONFIG_KEYS = new Set(['SLEEP_MIN_HOURS', 'SLEEP_MAX_HOURS', 'MAX_CYCLES_BEFORE_RESTART', 'MAX_CONSECUTIVE_FAILURES', 'CANARY_OBSERVATION_HOURS', 'PROMPT_EVOLUTION_MIN_ENTRIES', 'VISION_PRIORITY', 'ALERT_ON_ERROR', 'ALERT_ON_STAGNATION', 'ANOMALY_CHECK_INTERVAL_MS']);
              if (!SAFE_CONFIG_KEYS.has(params.key)) {
                res.writeHead(403, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Config key not allowed' }));
                return;
              }
              const { updateConfig } = require('./get-config');
              updateConfig(params.key, params.value);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ success: true }));
            } else {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Unknown command' }));
            }
          } catch (e: any) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid JSON' }));
          }
        });
      });
      return;
    }

    res.writeHead(404);
    res.end('Not found');
  });

  return server;
}

function startDashboard() { 
  const server = createDashboardServer();
  // Cloud platforms (Render, Railway, etc.) inject PORT — prefer it over config defaults
  const port = parseInt(process.env.PORT || process.env.DASHBOARD_PORT || getCONFIG().STATUS_PORT || 8080);
  server.listen(port, () => {
    log(`📊 Dashboard listening on port ${port}`, 'INFO', 'dashboard');
  });
  return server;
}

module.exports = { startDashboard, createDashboardServer, _injectDependencies };
