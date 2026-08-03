'use strict';

type WorkerMessage = {
  type: string;
  id?: string;
  method?: string;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  timestamp?: number;
};

const { parentPort, workerData } = require('worker_threads');
const { MSG_TYPE, WORKER_CMD, WORKER_ERROR,
  createReply, createEvent, } = require('./workers-message-protocol');

/**
 * Base class for worker threads. Handles the message dispatch loop,
 * INIT/SHUTDOWN lifecycle, and method routing.
 *
 * Subclasses implement:
 *   - _onInit(payload)     — called once with init data
 *   - _onShutdown()        — called before worker exits
 *   - _handleMethod(method, payload) → result — method dispatch
 *   - _healthCheck() → Object — periodic health check
 *
 * Usage (in a worker entry file):
 *   class MetricsWorker extends WorkerBase {
 *     _handleMethod(method, payload) { ... }
 *     _onInit(payload) { ... }
 *   }
 *   new MetricsWorker().run();
 */
class WorkerBase {
  protected _port: typeof parentPort;
  protected _name: string;
  protected _ready: boolean;
  protected _shuttingDown: boolean;
  protected readonly _methodHandlers: Map<string, (payload: Record<string, unknown>) => unknown>;

  constructor() {
    if (!parentPort) {
      throw new Error('[WorkerBase] Must be run inside a worker thread');
    }

    this._port = parentPort;
    this._name = (workerData as { workerName?: string })?.workerName || 'unnamed';
    this._ready = false;
    this._shuttingDown = false;
    this._methodHandlers = new Map();
  }

  /**
   * Start the message dispatch loop.
   * Call this once at the end of the worker entry script.
   */
  run(): void {
    if (!this._port) return;
    this._port.on('message', (msg: WorkerMessage) => this._onMessage(msg));

    // Handle parent thread disconnect (main process exit)
    this._port.on('close', () => {
      this._shuttingDown = true;
      this._onShutdown();
      process.exit(0);
    });
  }

  /**
   * Send an event back to the main thread.
   */
  emit(method: string, payload?: Record<string, unknown>): void {
    if (this._shuttingDown) return;
    try {
      this._port?.postMessage(createEvent(method, payload));
    } catch (_: any) {
      // Ignore — worker may be exiting
    }
  }

  /**
   * Check if the worker is ready and not shutting down.
   */
  get ready(): boolean {
    return this._ready;
  }

  /**
   * Get the worker name.
   */
  get name(): string {
    return this._name;
  }

  // ═══════════════════════════════════════════════════════════
  // Override points for subclasses
  // ═══════════════════════════════════════════════════════════

  /**
   * Called once when INIT message is received.
   */
  _onInit(_payload: Record<string, unknown>): void {
    // Default: no-op. Subclasses override.
  }

  /**
   * Called before worker exits.
   */
  _onShutdown(): void {
    // Default: no-op. Subclasses override.
  }

  /**
   * Dispatch a method call. Override in subclasses.
   */
  _handleMethod(method: string, payload: Record<string, unknown>): unknown {
    // Check registered handlers first
    const handler = this._methodHandlers.get(method);
    if (handler) {
      return handler(payload);
    }
    const err = new Error(`Unknown method: ${method}`);
    (err as Error & { code: string }).code = WORKER_ERROR.UNKNOWN_METHOD;
    throw err;
  }

  /**
   * Health check. Override in subclasses.
   */
  _healthCheck(): Record<string, unknown> {
    return {
      name: this._name,
      ready: this._ready,
      uptime: process.uptime(),
      memoryUsage: process.memoryUsage().heapUsed,
    };
  }

  /**
   * Register a method handler.
   */
  _registerMethod(method: string, handler: (payload: Record<string, unknown>) => unknown): void {
    this._methodHandlers.set(method, handler);
  }

  // ═══════════════════════════════════════════════════════════
  // Private: Message dispatch
  // ═══════════════════════════════════════════════════════════

  _onMessage(msg: WorkerMessage): void {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case MSG_TYPE.REQUEST:
        this._onRequest(msg);
        break;

      case MSG_TYPE.CAST:
        this._onCast(msg);
        break;

      default:
        // Ignore unknown types
        break;
    }
  }

  _onRequest(msg: WorkerMessage): void {
    if (!this._port) return;

    // Special commands
    if (msg.method === WORKER_CMD.HEALTH) {
      try {
        const result = this._healthCheck();
        this._port.postMessage(createReply(msg.id!, result as Record<string, unknown>));
      } catch (err: any) {
        this._port.postMessage(createReply(msg.id!, undefined, {
          code: WORKER_ERROR.INVALID_PAYLOAD,
          message: (err as Error).message,
        }));
      }
      return;
    }

    if (this._shuttingDown) {
      this._port.postMessage(createReply(msg.id!, undefined, {
        code: WORKER_ERROR.SHUTTING_DOWN,
        message: 'Worker is shutting down',
      }));
      return;
    }

    if (!this._ready) {
      this._port.postMessage(createReply(msg.id!, undefined, {
        code: WORKER_ERROR.NOT_READY,
        message: 'Worker not initialized',
      }));
      return;
    }

    try {
      const result = this._handleMethod(msg.method as any, msg.payload || {});
      // Handle async results
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>)
          .then(data => this._port!.postMessage(createReply(msg.id!, data as Record<string, unknown>)))
          .catch(err => this._port!.postMessage(createReply(msg.id!, undefined, {
            code: 'METHOD_ERROR',
            message: (err as Error).message,
          })));
      } else {
        this._port.postMessage(createReply(msg.id!, result as Record<string, unknown>));
      }
    } catch (err: any) {
      this._port.postMessage(createReply(msg.id!, undefined, {
        code: (err as Error & { code?: string }).code || 'METHOD_ERROR',
        message: (err as Error).message,
      }));
    }
  }

  _onCast(msg: WorkerMessage): void {
    if (!this._port) return;

    switch (msg.method) {
      case WORKER_CMD.INIT:
        try {
          this._onInit(msg.payload || {});
          this._ready = true;
          // Signal readiness
          this._port.postMessage(createEvent('system.ready', { name: this._name }));
        } catch (err: any) {
          this._port.postMessage(createEvent('system.error', {
            name: this._name,
            message: `Init failed: ${(err as Error).message}`,
            stack: (err as Error).stack,
          }));
        }
        break;

      case WORKER_CMD.SHUTDOWN:
        this._shuttingDown = true;
        this._onShutdown();
        // Give a brief moment for cleanup, then exit
        setTimeout(() => process.exit(0), 100).unref();
        break;

      case WORKER_CMD.START:
        // Subclasses can override _onStart if needed
        if (typeof (this as unknown as { _onStart?: (p: Record<string, unknown>) => void })._onStart === 'function') {
          (this as unknown as { _onStart: (p: Record<string, unknown>) => void })._onStart(msg.payload || {});
        }
        break;

      case WORKER_CMD.STOP:
        if (typeof (this as unknown as { _onStop?: (p: Record<string, unknown>) => void })._onStop === 'function') {
          (this as unknown as { _onStop: (p: Record<string, unknown>) => void })._onStop(msg.payload || {});
        }
        break;

      default:
        // Silently ignore unknown casts
        break;
    }
  }
}

module.exports = { WorkerBase };
