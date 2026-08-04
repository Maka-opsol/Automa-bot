'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CIRCULAR DEPENDENCY GUARD
// ═══════════════════════════════════════════════════════════════════════════
// This module is the root of the dependency tree. It eagerly requires
// './logger' below with a try/catch fallback. This is SAFE because:
//   logger.ts  lazy-loads  config.ts  (via CONFIG() accessor)
//   config.ts  never requires logger.ts (uses console.* directly)
//
// The chain is: container-container → logger → config (lazy)
// DO NOT add require('./config') here — it would create a hard cycle.
// ═══════════════════════════════════════════════════════════════════════════

// Lazy logger fallback for environments where pino isn't available
let _log: (msg: string, level?: string, _module?: string) => void;
let _logError: (msg: string, err: Error) => void;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const logger = require('./logger');
  _log = logger.log;
  _logError = logger.logError;
} catch {
  // v5-fix: Previous implementation retried require('./logger') on EVERY log call.
  // Node.js doesn't cache failed requires, so this re-parsed and re-evaluated
  // logger.ts on every call — a significant performance penalty. Now the
   // fallback goes straight to console without retrying.
  _log = (msg: string, level?: string) => { console.log(`[${level || 'INFO'}] ${msg}`); };
  _logError = (msg: string, err: Error) => { console.error(msg, err); };
}

// ─── Lifecycle Constants ───
const LIFECYCLE: Readonly<Record<string, string>> = Object.freeze({
  SINGLETON: 'singleton',     // Created once, reused forever
  TRANSIENT: 'transient',     // New instance every get()
  DEFERRED: 'deferred',       // Like singleton, but only created on first explicit get()
});

// ─── Module Registration Status ───
const STATUS: Readonly<Record<string, string>> = Object.freeze({
  PENDING: 'pending',
  INITIALIZING: 'initializing',
  READY: 'ready',
  FAILED: 'failed',
  SKIPPED: 'skipped',         // Non-critical module that failed to load
});

// ─── Type Definitions ───

interface ModuleRegistration {
  factory: (deps: Record<string, unknown>, container: DIContainer) => unknown;
  deps: string[];
  /** Dependencies that are allowed to fail. If an optional dep fails
   *  to initialize, null is injected instead of skipping the parent module.
   *  P13: Prevents cascading failures from non-critical deps. */
  optionalDeps: string[];
  lifecycle: string;
  critical: boolean;
  tags: Set<string>;
}

interface ModuleStatusEntry {
  name: string;
  status: string;
  critical: boolean;
  error: string | null;
  tags: string[];
}

interface ContainerGetOptions {
  required?: boolean;
}

interface ContainerSummary {
  containerName: string;
  total: number;
  ready: number;
  failed: number;
  skipped: number;
  pending: number;
  criticalFailed: string[];
  modules: ModuleStatusEntry[];
}

/**
 * A dependency injection container with lifecycle management,
 * circular dependency detection, and graceful failure for non-critical modules.
 */
class DIContainer {
  private readonly _name: string;
  private readonly _registry: Map<string, ModuleRegistration>;
  private readonly _instances: Map<string, unknown>;
  private readonly _statuses: Map<string, string>;
  private readonly _errors: Map<string, Error>;
  private readonly _initOrder: string[];
  private readonly _initStack: Set<string>;

  constructor(name = 'root') {
    this._name = name;
    this._registry = new Map();
    this._instances = new Map();
    this._statuses = new Map();
    this._errors = new Map();
    this._initOrder = [];
    this._initStack = new Set();
  }

  /**
   * Register a module.
   */
  register(name: string, opts: {
    factory: (deps: Record<string, unknown>, container: DIContainer) => unknown;
    deps?: string[];
    /** P13: Optional deps — inject null on failure instead of skipping parent */
    optionalDeps?: string[];
    lifecycle?: string;
    critical?: boolean;
    tags?: string[];
  }): void {
    if (this._registry.has(name)) {
      _log(`[DI] Module already registered, skipping: ${name}`, 'WARN', 'container');
      return;
    }
    const registration: ModuleRegistration = {
      factory: opts.factory,
      deps: opts.deps || [],
      optionalDeps: opts.optionalDeps || [],
      lifecycle: opts.lifecycle || LIFECYCLE.SINGLETON,
      critical: opts.critical !== undefined ? opts.critical : true,
      tags: new Set(opts.tags || []),
    };
    this._registry.set(name, registration);
    this._statuses.set(name, STATUS.PENDING);
  }

  /**
   * Register a module as an already-created instance (alias for register + pre-init).
   */
  registerInstance(name: string, instance: unknown, opts: {
    deps?: string[];
    optionalDeps?: string[];
    critical?: boolean;
    tags?: string[];
  } = {}): void {
    this._registry.set(name, {
      factory: () => instance,
      deps: opts.deps || [],
      optionalDeps: opts.optionalDeps || [],
      lifecycle: LIFECYCLE.SINGLETON,
      critical: opts.critical !== undefined ? opts.critical : true,
      tags: new Set(opts.tags || []),
    });
    this._instances.set(name, instance);
    this._statuses.set(name, STATUS.READY);
    this._errors.delete(name);
  }

  /**
   * Get a module instance, initializing it if necessary.
   */
  get(name: string, opts: ContainerGetOptions = {}): unknown {
    const required = opts.required !== undefined ? opts.required : true;

    // Check registration
    const reg = this._registry.get(name);
    if (!reg) {
      if (required) {
        throw new Error(`[DI] Module not registered: ${name}`);
      }
      return null;
    }

    // Singleton or Deferred: return cached instance
    if ((reg.lifecycle === LIFECYCLE.SINGLETON || reg.lifecycle === LIFECYCLE.DEFERRED) && this._instances.has(name)) {
      return this._instances.get(name);
    }

    // Transient: always create new
    if (reg.lifecycle === LIFECYCLE.TRANSIENT) {
      return this._createInstance(name, reg);
    }

    // Singleton / Deferred: create and cache (even null results to prevent re-init)
    const instance = this._createInstance(name, reg);
    if (reg.lifecycle === LIFECYCLE.SINGLETON || reg.lifecycle === LIFECYCLE.DEFERRED) {
      this._instances.set(name, instance);
    }
    return instance;
  }

  /**
   * Create a module instance with dependency resolution and circular detection.
   */
  private _createInstance(name: string, reg: ModuleRegistration): unknown {
    // Check if already initialized
    const status = this._statuses.get(name);
    if (status === STATUS.READY && this._instances.has(name)) {
      return this._instances.get(name);
    }
    if (status === STATUS.INITIALIZING) {
      throw new Error(`[DI] Circular dependency detected: ${name}`);
    }
    if (status === STATUS.FAILED || status === STATUS.SKIPPED) {
      // Allow retry for circular dependency failures — the init order may have changed
      if (status === STATUS.FAILED && this._errors.get(name)?.message?.includes('Circular dependency')) {
        this._statuses.set(name, STATUS.PENDING);
        this._errors.delete(name);
        // fall through to re-initialize
      } else {
        return this._instances.has(name) ? this._instances.get(name) : null;
      }
    }

    // Mark as initializing and track in init stack BEFORE resolving deps
    // so circular dependencies are caught immediately
    this._initStack.add(name);
    this._statuses.set(name, STATUS.INITIALIZING);

    // Resolve dependencies
    // Build the set of optional dep names for fast lookup (P13)
    const optionalSet = new Set(reg.optionalDeps);
    const resolvedDeps: Record<string, unknown> = {};
    try {
      for (const depName of reg.deps) {
        const isOptional = optionalSet.has(depName);
        const depResult = this.get(depName, { required: !isOptional });
        // A registered dep that returns null means it failed to initialize
        if (depResult === null && this._registry.has(depName)) {
          if (isOptional) {
            // P13: Optional dep failed — inject null and continue
            _log(`[DI] Optional dep "${depName}" failed for "${name}", injecting null`, 'WARN', 'container');
            resolvedDeps[depName] = null;
            continue;
          }
          throw new Error(`[DI] Dependency "${depName}" failed to initialize`);
        }
        resolvedDeps[depName] = depResult;
      }
    } catch (depErr: any) {
      this._initStack.delete(name);
      // Circular dependency errors should propagate without wrapping
      if ((depErr as Error).message?.includes('Circular dependency')) {
        this._statuses.set(name, STATUS.FAILED);
        this._errors.set(name, depErr as Error);
        throw depErr;
      }
      if (!reg.critical) {
        this._statuses.set(name, STATUS.SKIPPED);
        _log(`[DI] Skipping non-critical module "${name}" — dependency failed: ${(depErr as Error).message}`, 'WARN', 'container');
        return null;
      }
      this._statuses.set(name, STATUS.FAILED);
      this._errors.set(name, depErr as Error);
      _logError(`[DI] Dependency failed for critical module "${name}"`, depErr as Error);
      throw new Error(`[DI] Dependency failed for critical module "${name}": ${(depErr as Error).message}`);
    }

    // Run factory
    try {
      const instance = reg.factory(resolvedDeps, this);
      this._statuses.set(name, STATUS.READY);
      this._initOrder.push(name);
      return instance;
    } catch (err: any) {
      this._statuses.set(name, reg.critical ? STATUS.FAILED : STATUS.SKIPPED);
      this._errors.set(name, err as Error);
      if (reg.critical) {
        _logError(`[DI] Critical module "${name}" failed to initialize`, err as Error);
        throw err;
      } else {
        _log(`[DI] Non-critical module "${name}" failed: ${(err as Error).message}`, 'WARN', 'container');
        return null;
      }
    } finally {
      this._initStack.delete(name);
    }
  }

  /**
   * Check if a module is available (registered and not failed).
   */
  has(name: string): boolean {
    const status = this._statuses.get(name);
    return this._registry.has(name) && status === STATUS.READY;
  }

  /**
   * Get the status of a module.
   */
  getStatus(name: string): string {
    return this._statuses.get(name) || STATUS.PENDING;
  }

  /**
   * Get the error that caused a module to fail.
   */
  getError(name: string): Error | null {
    return this._errors.get(name) || null;
  }

  /**
   * Get all module statuses for health reporting.
   */
  getAllStatuses(): ModuleStatusEntry[] {
    const result: ModuleStatusEntry[] = [];
    for (const [name, reg] of this._registry) {
      const status = this._statuses.get(name);
      const error = this._errors.get(name);
      result.push({
        name,
        status: status || STATUS.PENDING,
        critical: reg.critical,
        error: error ? error.message : null,
        tags: [...reg.tags],
      });
    }
    return result;
  }

  /**
   * Get all modules with a specific tag.
   */
  getByTag(tag: string): string[] {
    const results: string[] = [];
    for (const [name, reg] of this._registry) {
      if (reg.tags.has(tag)) {
        results.push(name);
      }
    }
    return results;
  }

  /**
   * Get all registered module names.
   */
  getRegisteredNames(): string[] {
    return [...this._registry.keys()];
  }

  /**
   * Get the initialization order.
   */
  getInitOrder(): string[] {
    return [...this._initOrder];
  }

  /**
   * Reset a singleton instance, forcing re-creation on next get().
   */
  reset(name: string): void {
    if (!this._registry.has(name)) {
      throw new Error(`[DI] Cannot reset unregistered module: ${name}`);
    }
    this._instances.delete(name);
    this._statuses.set(name, STATUS.PENDING);
    this._errors.delete(name);
    this._initStack.delete(name);
  }

  /**
   * Reset all instances.
   */
  resetAll(): void {
    this._instances.clear();
    this._statuses.clear();
    this._errors.clear();
    this._initStack.clear();
    this._initOrder.length = 0;
    for (const name of this._registry.keys()) {
      this._statuses.set(name, STATUS.PENDING);
    }
  }

  /**
   * Get a summary for logging / health endpoints.
   */
  getSummary(): ContainerSummary {
    const statuses = this.getAllStatuses();
    const ready = statuses.filter(s => s.status === STATUS.READY).length;
    const failed = statuses.filter(s => s.status === STATUS.FAILED).length;
    const skipped = statuses.filter(s => s.status === STATUS.SKIPPED).length;
    const pending = statuses.filter(s => s.status === STATUS.PENDING).length;
    return {
      containerName: this._name,
      total: statuses.length,
      ready,
      failed,
      skipped,
      pending,
      criticalFailed: statuses.filter(s => s.critical && s.status === STATUS.FAILED).map(s => s.name),
      modules: statuses,
    };
  }
}
module.exports = { DIContainer, LIFECYCLE, STATUS };
