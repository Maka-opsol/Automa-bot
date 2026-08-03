'use strict';

/**
 * Workers barrel — re-exports the worker infrastructure and proxy factories.
 *
 * Usage in agent.js or container setup:
 *   const { workerManager, spawnAll } = require('./workers');
 *   await spawnAll(CONFIG, container);
 */

const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { workerManager } = require('./workers-worker-manager');
// [type-only import removed at runtime] import type { DIContainer } from './container-container.ts';
type DIContainer = any;
const { createMetricsProxy } = require('./workers-proxy-metrics-proxy');
const { createDiaryProxy } = require('./workers-proxy-diary-proxy');
const { createRewardTrackerProxy } = require('./workers-proxy-reward-tracker-proxy');

// Lazy logger with fallback
let _logCache: { log: (msg: string, level?: string, mod?: string) => void; logError: (msg: string, err: Error) => void } | null = null;
function _logger() {
  if (_logCache) return _logCache;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    _logCache = require('./logger');
  } catch {
    _logCache = { log: () => {}, logError: () => {} };
  }
  return _logCache;
}

const WORKERS_DIR = PROJECT_ROOT;

interface SpawnResults {
  started: string[];
  failed: string[];
}

/**
 * Spawn all worker threads and register their proxies in the container.
 */
async function spawnAll(
  CONFIG: Record<string, unknown>,
  container: DIContainer,
): Promise<SpawnResults> {
  const results: SpawnResults = { started: [], failed: [] };

  // ─── Metrics Worker ───
  try {
    const metricsOk = await workerManager.spawn(
      'metrics',
      path.join(WORKERS_DIR, 'workers-metrics-worker'),
      {},  // No init payload needed (pure in-memory)
      { critical: false, requestTimeoutMs: 3000, healthIntervalMs: 60000 }
    );

    if (metricsOk) {
      // Replace the original metrics module with the worker proxy
      const metricsProxy = createMetricsProxy('metrics');
      container.registerInstance('metrics', metricsProxy, {
        tags: ['monitoring', 'worker-backed'],
      });
      results.started.push('metrics');
    } else {
      results.failed.push('metrics');
    }
  } catch (err: any) {
    _logger()?.logError('Failed to spawn metrics worker', err as Error);
    results.failed.push('metrics');
  }

  // ─── Diary Worker ───
  try {
    const diaryOk = await workerManager.spawn(
      'diary',
      path.join(WORKERS_DIR, 'workers-diary-worker'),
      {
        config: {
          LOG_DIR: CONFIG.LOG_DIR,
          OPENROUTER_API_KEY: CONFIG.OPENROUTER_API_KEY,
          MISTRAL_CODE_API_KEY: CONFIG.MISTRAL_CODE_API_KEY,
        },
      },
      { critical: false, requestTimeoutMs: 10000, healthIntervalMs: 120000 }
    );

    if (diaryOk) {
      const diaryProxy = createDiaryProxy('diary');
      container.registerInstance('diary', diaryProxy, {
        tags: ['documenting', 'worker-backed'],
      });
      results.started.push('diary');
    } else {
      results.failed.push('diary');
    }
  } catch (err: any) {
    _logger()?.logError('Failed to spawn diary worker', err as Error);
    results.failed.push('diary');
  }

  // ─── Reward Tracker Worker ───
  try {
    // Get DB path from the database module
    const dbModule = container.get('database', { required: false }) as { dbPath?: string } | null;
    const dbPath = dbModule?.dbPath || (CONFIG.DB_PATH as string) || path.join(PROJECT_ROOT, 'mathu-bot.db');

    const rtOk = await workerManager.spawn(
      'rewardTracker',
      path.join(WORKERS_DIR, 'workers-reward-tracker-worker'),
      {
        dbPath,
        sourceDir: PROJECT_ROOT,
        survivalCheckIntervalMs: 60 * 60 * 1000,
      },
      { critical: false, requestTimeoutMs: 10000, healthIntervalMs: 120000 }
    );

    if (rtOk) {
      const rtProxy = createRewardTrackerProxy('rewardTracker');
      container.registerInstance('rewardTracker', rtProxy, {
        tags: ['self-heal-v2', 'worker-backed'],
      });
      results.started.push('rewardTracker');
    } else {
      results.failed.push('rewardTracker');
    }
  } catch (err: any) {
    _logger()?.logError('Failed to spawn reward-tracker worker', err as Error);
    results.failed.push('rewardTracker');
  }

  // Register a shutdown hook for graceful termination
  _registerShutdownHook();

  if (results.started.length > 0) {
    _logger()?.log(`Workers spawned: ${results.started.join(', ')} (${results.failed.length} failed)`, 'INFO', 'workers');
  }

  return results;
}

/**
 * Get worker statuses for health reporting.
 */
function getWorkerStatuses() {
  return workerManager.getStatuses();
}

/**
 * Gracefully shut down all workers.
 */
async function shutdownAll(timeoutMs?: number): Promise<void> {
  await workerManager.shutdownAll(timeoutMs);
}

// ═══════════════════════════════════════════════════════════
// Private
// ═══════════════════════════════════════════════════════════

let _shutdownRegistered = false;

function _registerShutdownHook(): void {
  if (_shutdownRegistered) return;
  _shutdownRegistered = true;

  // Note: SIGTERM/SIGINT handlers are registered in agent.js to avoid duplicate races.
  // We only handle SIGHUP here, which agent.js does not handle.
  process.on('SIGHUP', () => {
    _logger()?.log('Received SIGHUP, shutting down workers...', 'INFO', 'workers');
    workerManager.shutdownAll(3000).then(() => {
      process.exit(0);
    }).catch(() => {
      process.exit(1);
    });
  });
}

module.exports = { 
  workerManager,
  spawnAll,
  getWorkerStatuses,
  shutdownAll,
 };