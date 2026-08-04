'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }
function _log(...args: any[]) { return (_deps.logger?.log || console.log)(...args); }
function _logError(...args: any[]) { return (_deps.logger?.logError || console.error)(...args); }

const CB_STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

// Known subsystems and their fallback chains
const DEFAULT_SUBSYSTEMS: Record<string, { description: string; fallbackChain?: string[]; nonCritical?: boolean }> = {
  auth: {
    description: 'Authentication subsystem',
    fallbackChain: ['session-pool-rotation', 'auth-healer']
  },
  browser: {
    description: 'Browser automation subsystem',
    fallbackChain: ['relaunch-reduced-flags', 'minimal-flags']
  },
  vision: {
    description: 'Vision / tribunal subsystem',
    fallbackChain: ['flutter-semantics', 'selector-based', 'local-vlm']
  },
  action_executor: {
    description: 'Action execution subsystem',
    fallbackChain: ['brute-force-navigator', 'network-replay']
  },
  tracking: {
    description: 'Progress tracking subsystem',
    fallbackChain: ['continue-without-tracking'],
    nonCritical: true
  }
};

interface BreakerState {
  state: string;
  primaryFn: (...args: any[]) => Promise<any>;
  fallbackFn?: (...args: any[]) => Promise<any>;
  failureThreshold: number;
  resetTimeoutMs: number;
  halfOpenRequests: number;
  failureCount: number;
  successCount: number;
  lastFailureTime: number | null;
  halfOpenSuccesses: number;
  usingFallback: boolean;
  totalPrimaryCalls: number;
  totalFallbackCalls: number;
}

class SubsystemCircuitBreakerMesh {
  _onCascadeChange: ((prev: string, curr: string, cascade: any) => Promise<void>) | null;
  _breakers: Map<string, BreakerState>;
  _fallbackRegistry: Map<string, Map<string, (...args: any[]) => Promise<any>>>;
  _monitoringTimer: any;

  constructor() {
    this._breakers = new Map();
    this._fallbackRegistry = new Map();
    this._monitoringTimer = null;
    this._onCascadeChange = null;
  }

  /**
   * Register a subsystem with its primary function and fallback.
   */
  registerSubsystem(name: string, fn: (...args: any[]) => Promise<any>, fallbackFn?: (...args: any[]) => Promise<any>, options: any = {}) {
    try {
      const {
        failureThreshold = 5,
        resetTimeoutMs = 300000,
        halfOpenRequests = 1
      } = options;

      this._breakers.set(name, {
        state: CB_STATES.CLOSED,
        primaryFn: fn,
        fallbackFn,
        failureThreshold,
        resetTimeoutMs,
        halfOpenRequests,
        failureCount: 0,
        successCount: 0,
        lastFailureTime: null,
        halfOpenSuccesses: 0,
        usingFallback: false,
        totalPrimaryCalls: 0,
        totalFallbackCalls: 0,
      });

      _log(`Registered subsystem circuit breaker: ${name} (threshold: ${failureThreshold}, reset: ${Math.round(resetTimeoutMs / 1000)}s)`, 'INFO', 'subsystem-mesh');
    } catch (err: any) {
      _logError(`Failed to register subsystem ${name}`, err);
    }
  }

  /**
   * Register an explicit fallback function for a subsystem+level.
   */
  registerFallback(name: string, fallbackLevel: string, fn: (...args: any[]) => Promise<any>) {
    try {
      if (!this._fallbackRegistry.has(name)) {
        this._fallbackRegistry.set(name, new Map());
      }
      this._fallbackRegistry.get(name)!.set(fallbackLevel, fn);
      _log(`Registered fallback "${fallbackLevel}" for subsystem "${name}"`, 'DEBUG', 'subsystem-mesh');
    } catch (err: any) {
      _logError(`Failed to register fallback ${fallbackLevel} for ${name}`, err);
    }
  }

  /**
   * Execute a subsystem, respecting circuit breaker state.
   */
  async execute(name: string, ...args: any[]) {
    const breaker = this._breakers.get(name);
    if (!breaker) {
      _log(`Unknown subsystem: ${name}, executing directly`, 'WARN', 'subsystem-mesh');
      throw new Error(`Subsystem "${name}" not registered`);
    }

    // If OPEN, check if it's time for HALF_OPEN
    if (breaker.state === CB_STATES.OPEN) {
      const elapsed = breaker.lastFailureTime ? (Date.now() - breaker.lastFailureTime) : Infinity;
      if (elapsed < breaker.resetTimeoutMs) {
        breaker.usingFallback = true;
        breaker.totalFallbackCalls++;
        _log(`Subsystem ${name} OPEN, executing fallback`, 'WARN', 'subsystem-mesh');
        return this._executeFallback(name, args, breaker);
      }
      // Transition to HALF_OPEN
      breaker.state = CB_STATES.HALF_OPEN;
      breaker.halfOpenSuccesses = 0;
      _log(`Subsystem ${name} OPEN -> HALF_OPEN`, 'INFO', 'subsystem-mesh');
    }

    // CLOSED or HALF_OPEN — try primary
    breaker.totalPrimaryCalls++;
    try {
      const result = await breaker.primaryFn(...args);
      this._recordSuccess(name, breaker);
      return result;
    } catch (err: any) {
      this._recordFailure(name, breaker);

      if (breaker.state === CB_STATES.OPEN) {
        breaker.usingFallback = true;
        breaker.totalFallbackCalls++;
        _log(`Subsystem ${name} primary failed, falling back (state: ${breaker.state})`, 'WARN', 'subsystem-mesh');
        return this._executeFallback(name, args, breaker);
      }

      throw err;
    }
  }

  async _executeFallback(name: string, args: any[], breaker: BreakerState) {
    if (breaker.fallbackFn) {
      return breaker.fallbackFn(...args);
    }

    const defaultSub = DEFAULT_SUBSYSTEMS[name];
    if (defaultSub?.fallbackChain) {
      for (const level of defaultSub.fallbackChain) {
        const fallbackMap = this._fallbackRegistry.get(name);
        if (fallbackMap?.has(level)) {
          try {
            return fallbackMap.get(level)!(...args);
          } catch (fbErr: any) {
            _log(`Fallback "${level}" for ${name} also failed`, 'WARN', 'subsystem-mesh');
          }
        }
      }
    }

    throw new Error(`No fallback available for subsystem "${name}"`);
  }

  _recordSuccess(name: string, breaker: BreakerState) {
    breaker.successCount++;
    breaker.failureCount = 0;
    if (breaker.state === CB_STATES.HALF_OPEN) {
      breaker.halfOpenSuccesses++;
      if (breaker.halfOpenSuccesses >= breaker.halfOpenRequests) {
        breaker.state = CB_STATES.CLOSED;
        breaker.usingFallback = false;
        _log(`Subsystem ${name} HALF_OPEN -> CLOSED (recovered)`, 'INFO', 'subsystem-mesh');
      }
    }
  }

  _recordFailure(name: string, breaker: BreakerState) {
    breaker.failureCount++;
    breaker.lastFailureTime = Date.now();

    if (breaker.state === CB_STATES.HALF_OPEN) {
      breaker.state = CB_STATES.OPEN;
      _log(`Subsystem ${name} HALF_OPEN -> OPEN (probe failed)`, 'WARN', 'subsystem-mesh');
    } else if (breaker.state === CB_STATES.CLOSED && breaker.failureCount >= breaker.failureThreshold) {
      breaker.state = CB_STATES.OPEN;
      _log(`Subsystem ${name} CLOSED -> OPEN (${breaker.failureCount}/${breaker.failureThreshold} failures)`, 'ERROR', 'subsystem-mesh');
    }
  }

  /**
   * Get status of all subsystem circuit breakers.
   */
  getMeshStatus() {
    const status: any = {};
    for (const [name, breaker] of this._breakers) {
      status[name] = {
        state: breaker.state,
        failures: breaker.failureCount,
        successes: breaker.successCount,
        lastFailure: breaker.lastFailureTime,
        usingFallback: breaker.usingFallback,
        totalPrimaryCalls: breaker.totalPrimaryCalls,
        totalFallbackCalls: breaker.totalFallbackCalls,
      };
    }
    return status;
  }

  /**
   * Check if multiple subsystems are down and determine cascade degradation level.
   */
  cascadeCheck() {
    const meshStatus = this.getMeshStatus();
    const openSubsystems: string[] = [];
    const nonCriticalOpen: string[] = [];

    for (const [name, status] of Object.entries(meshStatus)) {
      if (status.state === CB_STATES.OPEN) {
        const isNonCritical = DEFAULT_SUBSYSTEMS[name]?.nonCritical;
        if (isNonCritical) {
          nonCriticalOpen.push(name);
        } else {
          openSubsystems.push(name);
        }
      }
    }

    let level = 'normal';
    if (openSubsystems.length >= 3) {
      level = 'critical';
    } else if (openSubsystems.length >= 2) {
      level = 'survival';
    } else if (openSubsystems.length >= 1 || nonCriticalOpen.length >= 2) {
      level = 'degraded';
    }

    return { level, openSubsystems, nonCriticalOpen, meshStatus };
  }

  /**
   * Recommend operational mode changes based on which subsystems are down.
   * On Render free plan, HIBERNATION recommendation is removed (Render
   * spins down on inactivity — hibernation is counterproductive).
   */
  getDegradationRecommendation() {
    const cascade = this.cascadeCheck();
    const recommendations: string[] = [];
    const isRenderFree = !!(process.env.RENDER_SERVICE_ID);

    for (const subName of cascade.openSubsystems) {
      const subDef = DEFAULT_SUBSYSTEMS[subName];
      if (!subDef) continue;

      switch (subName) {
        case 'auth':
          recommendations.push('AUTH DOWN: Enable session pool rotation and increase auth retry backoff. If persistent, trigger auth-healer.');
          break;
        case 'browser':
          recommendations.push('BROWSER DOWN: Relaunch with reduced flags. If fails, switch to minimal-flags mode (no GPU, no sandbox).');
          break;
        case 'vision':
          recommendations.push('VISION DOWN: Recommend DEGRADED mode with Flutter Semantics only. Fall back to selector-based detection, then local VLM.');
          break;
        case 'action_executor':
          recommendations.push('ACTION EXECUTOR DOWN: Switch to brute-force navigator. If fails, use network replay fallback.');
          break;
        case 'tracking':
          recommendations.push('TRACKING DOWN: Non-critical subsystem. Continue operations without tracking.');
          break;
        default:
          recommendations.push(`${subName.toUpperCase()} DOWN: No specific recommendation available.`);
      }
    }

    let overallRecommendation: string | null = null;
    if (cascade.level === 'critical') {
      if (isRenderFree) {
        overallRecommendation = 'CRITICAL: Multiple core subsystems down. Restart cycle with minimal resources. Keepalive will maintain process.';
      } else {
        overallRecommendation = 'CRITICAL: Multiple core subsystems down. Enter SURVIVAL mode immediately. Consider HIBERNATION if unrecoverable in 10 minutes.';
      }
    } else if (cascade.level === 'survival') {
      overallRecommendation = 'SURVIVAL: Multiple subsystems degraded. Minimize operations, prioritize core functionality only.';
    } else if (cascade.level === 'degraded') {
      overallRecommendation = 'DEGRADED: Some subsystems using fallbacks. Monitor closely for further degradation.';
    }

    return {
      level: cascade.level,
      openSubsystems: cascade.openSubsystems,
      recommendations,
      overallRecommendation,
    };
  }

  onCascadeChange(callback: (prev: string, curr: string, cascade: any) => Promise<void>) {
    this._onCascadeChange = callback;
  }

  /**
   * Start periodic monitoring of the mesh.
   * On Render free plan: 60s interval (vs 30s default) to save CPU.
   *
   * Note: _checkAutoRecovery is removed from the monitoring loop.
   * OPEN→HALF_OPEN transitions only happen in execute() where real
     * traffic probes the subsystem. The timer was causing phantom
   * HALF_OPEN transitions without actual testing.
   */
  startMonitoring(intervalMs?: number) {
    const isRenderFree = !!(process.env.RENDER_SERVICE_ID);
    const effectiveInterval = intervalMs ?? (isRenderFree ? 60000 : 30000);

    let lastLevel = 'normal';

    this._monitoringTimer = setInterval(async () => {
      try {
        const cascade = this.cascadeCheck();

        if (cascade.level !== lastLevel) {
          const prevLevel = lastLevel;
          lastLevel = cascade.level;
          _log(`Cascade level changed: ${prevLevel} -> ${cascade.level} (open: [${cascade.openSubsystems.join(', ')}])`, cascade.level === 'normal' ? 'INFO' : 'WARN', 'subsystem-mesh');

          if (cascade.level !== 'normal') {
            const rec = this.getDegradationRecommendation();
            for (const r of rec.recommendations) {
              _log(`Recommendation: ${r}`, 'WARN', 'subsystem-mesh');
            }
            if (rec.overallRecommendation) {
              try { getSendAlert()(`Subsystem cascade: ${cascade.level} - ${rec.overallRecommendation}`, 2); } catch { /* non-critical */ }
            }
          }

          if (this._onCascadeChange) {
            try {
              await this._onCascadeChange(prevLevel, cascade.level, cascade);
            } catch (cbErr: any) {
              _logError('Error in cascade change callback', cbErr);
            }
          }
        }
      } catch (err: any) {
        _logError('Error in monitoring cycle', err);
      }
    }, effectiveInterval);
    if (this._monitoringTimer.unref) this._monitoringTimer.unref();

    _log(`Subsystem circuit breaker mesh monitoring started (interval: ${Math.round(effectiveInterval / 1000)}s)`, 'INFO', 'subsystem-mesh');
  }

  stopMonitoring() {
    if (this._monitoringTimer) {
      clearInterval(this._monitoringTimer);
      this._monitoringTimer = null;
      _log('Subsystem mesh monitoring stopped', 'INFO', 'subsystem-mesh');
    }
  }

  resetSubsystem(name: string): boolean {
    const breaker = this._breakers.get(name);
    if (!breaker) {
      _log(`Cannot reset unknown subsystem: ${name}`, 'WARN', 'subsystem-mesh');
      return false;
    }
    breaker.state = CB_STATES.CLOSED;
    breaker.failureCount = 0;
    breaker.successCount = 0;
    breaker.lastFailureTime = null;
    breaker.halfOpenSuccesses = 0;
    breaker.usingFallback = false;
    _log(`Subsystem ${name} circuit breaker manually reset`, 'INFO', 'subsystem-mesh');
    return true;
  }

  tripSubsystem(name: string, reason: string): boolean {
    const breaker = this._breakers.get(name);
    if (!breaker) {
      _log(`Cannot trip unknown subsystem: ${name}`, 'WARN', 'subsystem-mesh');
      return false;
    }
    breaker.state = CB_STATES.OPEN;
    breaker.lastFailureTime = Date.now();
    _log(`Subsystem ${name} manually tripped: ${reason}`, 'WARN', 'subsystem-mesh');
    return true;
  }
}

const subsystemMesh = new SubsystemCircuitBreakerMesh();
module.exports = {
  SubsystemCircuitBreakerMesh,
  subsystemMesh,
  CB_STATES,
  DEFAULT_SUBSYSTEMS,
  _injectDependencies,
};
