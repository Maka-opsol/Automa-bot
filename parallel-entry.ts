// ═══════════════════════════════════════════════════════════════════════
// Parallel Entry Point — starts N browser workers in parallel
// ═══════════════════════════════════════════════════════════════════════
//
// This is an alternative entry point to render-free-plan.ts / hf-spaces.ts.
// Instead of running a single browser that solves one question at a time,
// this runs N browser contexts in parallel, each solving a different question.
//
// Usage:
//   PARALLEL_WORKERS=3 node --import tsx parallel-entry.ts
//
// If PARALLEL_WORKERS is not set or is 1, falls back to normal mode
// (calls render-free-plan.ts).
//
// MEMORY: Each worker adds ~30-50MB (context + page + CanvasKit share).
// With 3 workers: ~150MB extra. Total peak ~7.4GB on 16GB runner.
// ═══════════════════════════════════════════════════════════════════════

'use strict';

require('./error-handler');
const http = require('http');
const { PROJECT_ROOT } = require('./project-root');

// ─── DI Container ───
const { container, getContainerHealth } = require('./container');

// ─── Core modules ───
let CONFIG: any, log: any;
try {
  CONFIG = container.get('config');
  log = container.get('logger').log;
} catch (initErr: any) {
  console.error(`FATAL: Core module initialization failed: ${initErr.message}`);
  process.exit(1);
}

const workerCount = parseInt(process.env.PARALLEL_WORKERS || '3', 10);
const isParallelMode = workerCount > 1;

log(`[PARALLEL-ENTRY] Parallel mode: ${isParallelMode ? `ENABLED (${workerCount} workers)` : 'DISABLED (single browser)'}`, 'INFO', 'parallel-entry');

if (!isParallelMode) {
  // Fall back to normal mode
  log('[PARALLEL-ENTRY] PARALLEL_WORKERS=1 — falling back to normal mode (render-free-plan.ts)', 'INFO', 'parallel-entry');
  require('./render-free-plan');
} else {
  // Run in parallel mode
  (async () => {
    try {
      // Start HTTP server first (for health checks)
      const port = parseInt(process.env.PORT || '10000', 10);
      const server = http.createServer((req: any, res: any) => {
        if (req.url === '/health') {
          const parallelMod = require('./parallel-coordinator');
          const stats = parallelMod.getStats();
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: true,
            mode: 'parallel',
            ...stats,
            memory: {
              heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
              rss: Math.round(process.memoryUsage().rss / 1024 / 1024) + 'MB',
            },
            uptime: process.uptime() + 's',
          }, null, 2));
        } else if (req.url === '/' || req.url === '/stats') {
          const parallelMod = require('./parallel-coordinator');
          const stats = parallelMod.getStats();
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end(`
            <html><body style="font-family: monospace; background: #1a1a1a; color: #00ff00; padding: 20px;">
            <h1>MathU Bot — Parallel Mode (${workerCount} workers)</h1>
            <pre>${JSON.stringify(stats, null, 2)}</pre>
            <p>Uptime: ${process.uptime().toFixed(0)}s</p>
            <p>Memory: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS</p>
            </body></html>
          `);
        } else {
          res.writeHead(404);
          res.end('Not found');
        }
      });
      server.listen(port, '0.0.0.0', () => {
        log(`[PARALLEL-ENTRY] HTTP server listening on port ${port}`, 'INFO', 'parallel-entry');
      });

      // Start subsystems (same as render-free-plan.ts)
      const { startSubsystemGroup, startSelfHealV2Subsystems, startResilienceSubsystems, spawnWorkers } = require('./container');

      // Start longevity subsystems
      try { startSubsystemGroup('longevity'); } catch (e: any) { log(`Longevity start failed: ${e.message}`, 'WARN', 'parallel-entry'); }

      // Start resilience subsystems
      try { startResilienceSubsystems(); } catch (e: any) { log(`Resilience start failed: ${e.message}`, 'WARN', 'parallel-entry'); }

      // Start self-heal v2
      try { startSelfHealV2Subsystems(); } catch (e: any) { log(`Self-heal start failed: ${e.message}`, 'WARN', 'parallel-entry'); }

      // Spawn worker threads (metrics, diary, rewardTracker)
      if (!process.env.RENDER_SERVICE_ID && !process.env.RENDER) {
        log('[PARALLEL-ENTRY] Spawning worker threads...', 'INFO', 'parallel-entry');
        try {
          const results = await spawnWorkers(container, CONFIG);
          log(`[PARALLEL-ENTRY] Workers spawned: ${results.started.join(', ')}`, 'INFO', 'parallel-entry');
        } catch (e: any) {
          log(`[PARALLEL-ENTRY] Worker spawn failed (non-fatal): ${e.message}`, 'WARN', 'parallel-entry');
        }
      }

      // Start the parallel coordinator
      const parallelMod = require('./parallel-coordinator');
      parallelMod._injectDependencies({
        config: CONFIG,
        logger: container.get('logger'),
        database: container.get('database'),
        providers: container.get('providers'),
        actionExecutor: container.get('actionExecutor'),
        authGuard: container.get('authGuard'),
        auth: container.get('auth'),
      });

      log('[PARALLEL-ENTRY] Starting parallel coordinator...', 'INFO', 'parallel-entry');
      await parallelMod.start();
      log('[PARALLEL-ENTRY] ✅ Parallel coordinator started — bot is running', 'INFO', 'parallel-entry');

      // Keep the process alive
      log(`[PARALLEL-ENTRY] Bot running in parallel mode (${workerCount} workers). Press Ctrl+C to stop.`, 'INFO', 'parallel-entry');

      // Handle shutdown
      process.on('SIGTERM', async () => {
        log('[PARALLEL-ENTRY] SIGTERM received — stopping...', 'INFO', 'parallel-entry');
        await parallelMod.stop();
        process.exit(0);
      });
      process.on('SIGINT', async () => {
        log('[PARALLEL-ENTRY] SIGINT received — stopping...', 'INFO', 'parallel-entry');
        await parallelMod.stop();
        process.exit(0);
      });

    } catch (err: any) {
      log(`[PARALLEL-ENTRY] FATAL: ${err.message}`, 'ERROR', 'parallel-entry');
      console.error(err);
      process.exit(1);
    }
  })();
}
