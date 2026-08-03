'use strict';

const { Worker } = require('worker_threads');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

// ─── Compile-mode detection ───
// When running via `tsc` + `node dist/agent.js`, __dirname ends with '/dist'.
// In tsx mode (`npx tsx agent.ts`), __dirname is the project root.
// This affects worker spawning: compiled workers need .js paths and no --import tsx.
function isCompiledMode(): boolean {
  // __dirname is available at module scope in CJS modules.
  // In compiled mode it's <project_root>/dist, in tsx mode it's <project_root>.
  try {
    const dir = __dirname;
    const sep = path.sep;
    return dir === 'dist' || dir.endsWith(sep + 'dist') || dir.endsWith('/dist');
  } catch {
    return false;
  }
}

// Local type definition for worker message protocol
// (mirrors the interface in workers-message-protocol.ts to satisfy strict TS)
type WorkerMessage = {
  type: string;
  id?: string;
  method?: string;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  timestamp?: number;
};

const { MSG_TYPE, WORKER_CMD, WORKER_ERROR, METHOD,
  createRequest, createReply, createCast, } = require('./workers-message-protocol');

// Lazy logger with fallback for environments where pino isn't available
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

/**
 * Default timeout for request/reply calls (5 seconds).
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 5000;

/**
 * Default health check interval (30 seconds).
 */
const DEFAULT_HEALTH_INTERVAL_MS = 30000;

/**
 * Maximum number of restarts for a crashing worker within the restart window.
 */
const MAX_RESTARTS = 3;

/**
 * Time window for restart counting (5 minutes).
 */
const RESTART_WINDOW_MS = 5 * 60 * 1000;

// ─── Type Definitions ───

interface PendingRequest {
  resolve: (payload: Record<string, unknown> | undefined) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface WorkerState {
  worker: any | null;
  ready: boolean;
  pending: Map<string, PendingRequest>;
  restarts: number[];
  healthTimer: ReturnType<typeof setInterval> | null;
  shutdownRequested: boolean;
  requestTimeoutMs: number;
  healthIntervalMs: number;
  critical: boolean;
  workerPath: string;
  initPayload: Record<string, unknown>;
}

interface SpawnOptions {
  requestTimeoutMs?: number;
  healthIntervalMs?: number;
  critical?: boolean;
}

interface WorkerStatusEntry {
  name: string;
  ready: boolean;
  pendingRequests: number;
  shutdownRequested: boolean;
  restarts: number;
  critical: boolean;
}

/**
 * Manages worker thread lifecycle: spawn, health monitoring, graceful shutdown.
 *
 * Each worker has:
 *   - A Worker instance (Node.js worker_threads)
 *   - A pending-request map (correlation ID → { resolve, reject, timer })
 *   - A readiness flag
 *   - A restart history for circuit-breaking
 *
 * Usage:
 *   const mgr = new WorkerManager();
 *   const ok = await mgr.spawn('metrics', path.join(PROJECT_ROOT, 'workers-metrics-worker'), { ... });
 *   const summary = await mgr.request('metrics', METHOD.METRICS_GET_SUMMARY);
 */
class WorkerManager {
  private readonly _workers: Map<string, WorkerState>;
  private readonly _eventHandlers: Map<string, (payload?: Record<string, unknown>, msg?: WorkerMessage) => void>;
  /** Persistent restart history per worker name — survives across re-spawns. */
  private readonly _restartHistory: Map<string, number[]>;
  private _shuttingDown: boolean;

  constructor() {
    this._workers = new Map();
    this._eventHandlers = new Map();
    this._restartHistory = new Map();
    this._shuttingDown = false;
  }

  /**
   * Spawn a new worker thread.
   *
   * @param name        - Logical worker name (e.g. 'metrics')
   * @param workerPath  - Absolute path to worker entry script
   * @param initPayload - Data sent via INIT command (config, dbPath, etc.)
   * @param opts        - Optional spawn configuration
   * @returns true if worker initialized successfully
   */
  async spawn(name: string, workerPath: string, initPayload: Record<string, unknown>, opts: SpawnOptions = {}): Promise<boolean> {
    if (this._workers.has(name)) {
      throw new Error(`[WorkerManager] Worker "${name}" already exists`);
    }

    const requestTimeoutMs = opts.requestTimeoutMs || DEFAULT_REQUEST_TIMEOUT_MS;
    const healthIntervalMs = opts.healthIntervalMs || DEFAULT_HEALTH_INTERVAL_MS;
    const critical = opts.critical !== undefined ? opts.critical : true;

    const state: WorkerState = {
      worker: null,
      ready: false,
      pending: new Map(),
      restarts: [],
      healthTimer: null,
      shutdownRequested: false,
      requestTimeoutMs,
      healthIntervalMs,
      critical,
      workerPath,
      initPayload,
    };

    try {
      // C2 FIX: Compile-aware worker spawning.
      // - tsx mode: use .ts paths under PROJECT_ROOT with --import tsx
      // - compiled mode: use .js paths under PROJECT_ROOT/dist, no tsx needed
      const compiled = isCompiledMode();

      // Resolve the actual worker script path
      let resolvedWorkerPath = workerPath;
      if (compiled && workerPath.endsWith('.ts')) {
        // In compiled mode, .ts worker paths need to become .js under dist/
        // e.g. PROJECT_ROOT/workers-metrics-worker -> PROJECT_ROOT/dist/workers-metrics-worker.js
        const basename = path.basename(workerPath, '.ts');
        resolvedWorkerPath = path.join(PROJECT_ROOT, 'dist', basename + '.js');
      } else if (compiled && !workerPath.endsWith('.js')) {
        // Extensionless path in compiled mode
        const basename = path.basename(workerPath);
        resolvedWorkerPath = path.join(PROJECT_ROOT, 'dist', basename + '.js');
      }

      // Build execArgv: only include --import tsx in tsx mode
      let execArgv: string[] = [];
      if (!compiled) {
        // tsx mode: verify tsx is resolvable before spawning
        try {
          require.resolve('tsx');
        } catch {
          throw new Error(`[WorkerManager] tsx module not found — cannot transpile .ts workers. Install tsx: npm install tsx`);
        }
        execArgv = ['--import', 'tsx'];
      }

      state.worker = new Worker(resolvedWorkerPath, {
        workerData: { workerName: name },
        execArgv,
      });

      state.worker.on('message', (msg: WorkerMessage) => this._onMessage(name, msg));
      state.worker.on('error', (err: Error) => this._onError(name, err));
      state.worker.on('exit', (code: number | null, signal: string | null) => this._onExit(name, code, signal, state));

      this._workers.set(name, state);

      // Send INIT and wait for SYS_READY
      await this._initWorker(name, state);

      // Start health monitoring
      this._startHealthCheck(name, state);

      _logger()?.log(`Worker "${name}" spawned (mode=${compiled ? 'compiled' : 'tsx'}, path=${resolvedWorkerPath})`, 'INFO', 'worker-manager');
      return true;
    } catch (err: any) {
      state.shutdownRequested = true;
      // Only delete from map if this state is still the current one
      // (prevents accidentally deleting a replacement worker's state during auto-restart race)
      if (this._workers.get(name) === state) {
        this._workers.delete(name);
      }
      if (state.worker) {
        try { state.worker.terminate(); } catch { /* ignore */ }
      }
      if (critical) {
        throw new Error(`[WorkerManager] Failed to spawn critical worker "${name}": ${(err as Error).message}`);
      }
      _logger()?.log(`Non-critical worker "${name}" failed to spawn: ${(err as Error).message}`, 'WARN', 'worker-manager');
      return false;
    }
  }

  /**
   * Send a request to a worker and wait for the reply.
   */
  async request(name: string, method: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown> | undefined> {
    const state = this._workers.get(name);
    if (!state) {
      throw new Error(`[WorkerManager] No worker "${name}"`);
    }
    if (state.shutdownRequested) {
      const err = new Error(`Worker "${name}" is shutting down`);
      (err as Error & { code: string }).code = WORKER_ERROR.SHUTTING_DOWN;
      throw err;
    }
    if (!state.ready) {
      const err = new Error(`Worker "${name}" not ready`);
      (err as Error & { code: string }).code = WORKER_ERROR.NOT_READY;
      throw err;
    }

    const msg = createRequest(method, payload);
    const timeout = timeoutMs || state.requestTimeoutMs;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        state.pending.delete(msg.id!);
        const err = new Error(`Request to "${name}.${method}" timed out after ${timeout}ms`);
        (err as Error & { code: string }).code = WORKER_ERROR.TIMEOUT;
        reject(err);
      }, timeout);

      state.pending.set(msg.id!, { resolve, reject, timer });
      state.worker!.postMessage(msg);
    });
  }

  /**
   * Send a fire-and-forget cast message to a worker.
   */
  cast(name: string, method: string, payload?: Record<string, unknown>): void {
    const state = this._workers.get(name);
    if (!state) return;
    if (!state.ready || state.shutdownRequested) return;

    try {
      state.worker!.postMessage(createCast(method, payload));
    } catch {
      // Fire-and-forget: ignore postMessage errors
    }
  }

  /**
   * Register an event handler for worker events.
   * Events are worker → main async messages (e.g. log, metric updates).
   */
  onEvent(workerName: string, method: string, handler: (payload?: Record<string, unknown>, msg?: WorkerMessage) => void): void {
    const key = `${workerName}.${method}`;
    this._eventHandlers.set(key, handler);
  }

  /**
   * Check if a worker is alive and ready.
   */
  isReady(name: string): boolean {
    const state = this._workers.get(name);
    return !!(state && state.ready);
  }

  /**
   * Get status of all managed workers.
   */
  getStatuses(): WorkerStatusEntry[] {
    const result: WorkerStatusEntry[] = [];
    for (const [name, state] of this._workers) {
      result.push({
        name,
        ready: state.ready,
        pendingRequests: state.pending.size,
        shutdownRequested: state.shutdownRequested,
        restarts: (this._restartHistory.get(name) || []).length,
        critical: state.critical,
      });
    }
    return result;
  }

  /**
   * Gracefully shut down all workers.
   */
  async shutdownAll(timeoutMs: number = 5000): Promise<void> {
    this._shuttingDown = true;
    const names = [...this._workers.keys()];

    // Send SHUTDOWN to all workers in parallel
    await Promise.allSettled(
      names.map(name => this._shutdownWorker(name, timeoutMs))
    );

    this._workers.clear();
    _logger()?.log('All workers shut down', 'INFO', 'worker-manager');
  }

  /**
   * Gracefully shut down a specific worker.
   */
  async shutdownWorker(name: string, timeoutMs: number = 5000): Promise<void> {
    await this._shutdownWorker(name, timeoutMs);
    this._workers.delete(name);
  }

  // ═══════════════════════════════════════════════════════════
  // Private Methods
  // ═══════════════════════════════════════════════════════════

  /**
   * Send INIT command and wait for SYS_READY.
   */
  private async _initWorker(name: string, state: WorkerState): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (originalHandler !== undefined) {
          this._eventHandlers.set(readyKey, originalHandler);
        } else {
          this._eventHandlers.delete(readyKey);
        }
        reject(new Error(`Worker "${name}" init timed out`));
      }, state.requestTimeoutMs * 2); // Double timeout for init

      // Listen for SYS_READY
      const readyKey = `${name}.${METHOD.SYS_READY}`;
      const originalHandler = this._eventHandlers.get(readyKey);
      this._eventHandlers.set(readyKey, (_payload?: Record<string, unknown>) => {
        state.ready = true;
        clearTimeout(timeout);
        this._eventHandlers.set(readyKey, originalHandler!); // restore
        resolve();
      });

      // Send INIT
      state.worker!.postMessage(createCast(WORKER_CMD.INIT, state.initPayload));
    });
  }

  /**
   * Handle incoming message from a worker.
   */
  private _onMessage(name: string, msg: WorkerMessage): void {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case MSG_TYPE.REPLY:
        this._handleReply(name, msg);
        break;

      case MSG_TYPE.EVENT:
      case MSG_TYPE.CAST:
        {
          // Dispatch to registered event handlers
          const key = `${name}.${msg.method}`;
          const handler = this._eventHandlers.get(key);
          if (handler) {
            try {
              handler(msg.payload, msg);
            } catch (err: any) {
              _logger()?.logError(`Event handler error for ${key}`, err as Error);
            }
          }
        }
        break;

      default:
        _logger()?.log(`Unknown message type from worker "${name}": ${msg.type}`, 'WARN', 'worker-manager');
    }
  }

  /**
   * Handle a REPLY message — resolve or reject the pending request.
   */
  private _handleReply(name: string, msg: WorkerMessage): void {
    const state = this._workers.get(name);
    if (!state) return;

    const pending = state.pending.get(msg.id!);
    if (!pending) {
      // Stale reply (request already timed out)
      return;
    }

    clearTimeout(pending.timer);
    state.pending.delete(msg.id!);

    if (msg.error) {
      const err = new Error(msg.error.message);
      (err as Error & { code: string }).code = msg.error.code;
      pending.reject(err);
    } else {
      pending.resolve(msg.payload);
    }
  }

  /**
   * Handle worker error event.
   */
  private _onError(name: string, err: Error): void {
    _logger()?.logError(`Worker "${name}" error`, err);
  }

  /**
   * Handle worker exit event. May auto-restart if within limits.
   * M3 FIX: Now properly handles signal-killed workers and adds
   * exponential backoff between restart attempts to prevent crash loops.
   */
  private _onExit(name: string, code: number | null, signal: string | null, state: WorkerState): void {
    const isUnexpected = !state.shutdownRequested && (code !== 0 || signal !== null);

    // Reject all pending requests
    for (const [, pending] of state.pending) {
      clearTimeout(pending.timer);
      const err = new Error(`Worker "${name}" exited with code ${code}`);
      (err as Error & { code: string }).code = 'WORKER_EXITED';
      pending.reject(err);
    }
    state.pending.clear();

    // Stop health check
    if (state.healthTimer) {
      clearInterval(state.healthTimer);
      state.healthTimer = null;
    }

    state.ready = false;

    if (isUnexpected && !this._shuttingDown) {
      const exitDesc = signal ? `signal ${signal}` : `code ${code}`;
      _logger()?.log(`Worker "${name}" exited unexpectedly with ${exitDesc}`, 'ERROR', 'worker-manager');

      // Check restart limits using persistent history (survives across re-spawns)
      const now = Date.now();
      let restarts = this._restartHistory.get(name) || [];
      restarts = restarts.filter(t => now - t < RESTART_WINDOW_MS);
      this._restartHistory.set(name, restarts);

      if (restarts.length >= MAX_RESTARTS) {
        _logger()?.log(`Worker "${name}" exceeded ${MAX_RESTARTS} restarts in ${RESTART_WINDOW_MS / 1000}s — giving up`, 'ERROR', 'worker-manager');
        if (state.critical) {
          _logger()?.log(`Critical worker "${name}" is down — degradation recommended`, 'ERROR', 'worker-manager');
        }
        return;
      }

      restarts.push(now);
      this._restartHistory.set(name, restarts);

      // M3 FIX: Exponential backoff — 1s, 2s, 4s — to avoid rapid crash loops
      const backoffMs = Math.min(1000 * Math.pow(2, restarts.length - 1), 8000);
      _logger()?.log(`Auto-restarting worker "${name}" (restart ${restarts.length}/${MAX_RESTARTS}) in ${backoffMs}ms`, 'WARN', 'worker-manager');

      // Reset state and re-spawn after backoff delay
      this._workers.delete(name);
      setTimeout(() => {
        if (this._shuttingDown) return;
        this.spawn(name, state.workerPath, state.initPayload, {
          requestTimeoutMs: state.requestTimeoutMs,
          healthIntervalMs: state.healthIntervalMs,
          critical: state.critical,
        }).catch(err => {
          _logger()?.log(`Auto-restart of "${name}" failed: ${(err as Error).message}`, 'ERROR', 'worker-manager');
        });
      }, backoffMs);
    } else if (state.shutdownRequested) {
      _logger()?.log(`Worker "${name}" shut down cleanly (code ${code})`, 'INFO', 'worker-manager');
    }
  }

  /**
   * Start periodic health check for a worker.
   */
  private _startHealthCheck(name: string, state: WorkerState): void {
    if (state.healthTimer) clearInterval(state.healthTimer);

    state.healthTimer = setInterval(() => {
      if (!state.ready || state.shutdownRequested) return;

      this.request(name, WORKER_CMD.HEALTH, undefined, 3000)
        .then(() => {
          // Healthy — no action needed
        })
        .catch(() => {
          _logger()?.log(`Worker "${name}" health check failed`, 'WARN', 'worker-manager');
        });
    }, state.healthIntervalMs);

    // Don't let health checks block process exit
    state.healthTimer.unref();
  }

  /**
   * Gracefully shut down a single worker.
   */
  private async _shutdownWorker(name: string, timeoutMs: number): Promise<void> {
    const state = this._workers.get(name);
    if (!state) return;

    // Send SHUTDOWN command BEFORE setting flag (flag blocks cast())
    this.cast(name, WORKER_CMD.SHUTDOWN);

    state.shutdownRequested = true;

    // Stop health check
    if (state.healthTimer) {
      clearInterval(state.healthTimer);
      state.healthTimer = null;
    }

    // Wait for clean exit
    if (state.worker && state.worker.exitCode !== null) {
      // Worker already exited — no need to wait
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref();

      state.worker!.on('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    // Force terminate if still alive
    if (state.worker) {
      try { state.worker.terminate(); } catch { /* ignore */ }
    }
  }
}

// ─── Singleton ───
const workerManager = new WorkerManager();

module.exports = {
  WorkerManager, workerManager, isCompiledMode,
  DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_HEALTH_INTERVAL_MS, MAX_RESTARTS, RESTART_WINDOW_MS,
};