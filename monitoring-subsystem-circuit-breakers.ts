'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');
const CB_STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

// Known subsystems and their fallback chains
const DEFAULT_SUBSYSTEMS = {
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

class SubsystemCircuitBreakerMesh {
  _onCascadeChange: any;
  _breakers: any;
  _fallbackRegistry: any;
  _monitoringTimer: any;
  failureThreshold: any;
  resetTimeoutMs: any;
  halfOpenRequests: any;

  constructor() {
    this._breakers = new Map();
    this._fallbackRegistry = new Map();
    this._monitoringTimer = null;
    this._onCascadeChange = null;
  }

  /**
   * Register a subsystem with its primary function and fallback.
   * @param {string} name - Subsystem name
   * @param {Function} fn - Primary execution function
   * @param {Function} fallbackFn - Fallback function
   * @param {object} options - { failureThreshold, resetTimeoutMs, halfOpenRequests }
   */
  registerSubsystem(name: any, fn: any, fallbackFn: any, options: any = {}) { 
    try {
      const {
        failureThreshold = 5,
        resetTimeoutMs = 300000, // 5 min
        halfOpenRequests = 1
      } = options;

      this._breakers.set(name, {
        state: CB_STATES.CLOSED,
        primaryFn: fn,
        fallbackFn: fallbackFn,
        failureThreshold,
        resetTimeoutMs,
        halfOpenRequests,
        failureCount: 0,
        successCount: 0,
        lastFailureTime: null,
        halfOpenSuccesses: 0,
        usingFallback: false,
        totalPrimaryCalls: 0,
        totalFallbackCalls: 0
      });

      log(`Registered subsystem circuit breaker: ${name} (threshold: ${failureThreshold}, reset: ${Math.round(resetTimeoutMs / 1000)}s)`, 'INFO', 'subsystem-mesh');
    } catch (err: any) {
      logError(`Failed to register subsystem ${name}`, err);
    }
  }

  /**
   * Register an explicit fallback function for a subsystem+level.
   * @param {string} name - Subsystem name
   * @param {string} fallbackLevel - e.g. 'flutter-semantics'
   * @param {Function} fn - Fallback function
   */
  registerFallback(name: any, fallbackLevel: any, fn: any) { 
    try {
      if (!this._fallbackRegistry.has(name)) {
        this._fallbackRegistry.set(name, new Map());
      }
      this._fallbackRegistry.get(name).set(fallbackLevel, fn);
      log(`Registered fallback "${fallbackLevel}" for subsystem "${name}"`, 'DEBUG', 'subsystem-mesh');
    } catch (err: any) {
      logError(`Failed to register fallback ${fallbackLevel} for ${name}`, err);
    }
  }

  /**
   * Execute a subsystem, respecting circuit breaker state.
   */
  async execute(name: string, ...args: unknown[]) {
    try {
      const breaker = this._breakers.get(name);
      if (!breaker) {
        log(`Unknown subsystem: ${name}, executing directly`, 'WARN', 'subsystem-mesh');
        throw new Error(`Subsystem "${name}" not registered`);
      }

      // If OPEN, go directly to fallback
      if (breaker.state === CB_STATES.OPEN) {
        const elapsed = breaker.lastFailureTime ? (Date.now() - breaker.lastFailureTime) : Infinity;
        if (elapsed < breaker.resetTimeoutMs) {
          breaker.usingFallback = true;
          breaker.totalFallbackCalls++;
          log(`Subsystem ${name} OPEN, executing fallback`, 'WARN', 'subsystem-mesh');
          return await this._executeFallback(name, args, breaker);
        } else {
          // Transition to HALF_OPEN
          breaker.state = CB_STATES.HALF_OPEN;
          breaker.halfOpenSuccesses = 0;
          log(`Subsystem ${name} OPEN -> HALF_OPEN`, 'INFO', 'subsystem-mesh');
        }
      }

      // If CLOSED or HALF_OPEN, try primary
      breaker.totalPrimaryCalls++;
      try {
        const result = await breaker.primaryFn(...args);
        this._recordSuccess(name, breaker);
        return result;
      } catch (err: any) {
        this._recordFailure(name, breaker);

        // If we just transitioned to OPEN or were already in HALF_OPEN that failed,
        // fall back
        if (breaker.state === CB_STATES.OPEN) {
          breaker.usingFallback = true;
          breaker.totalFallbackCalls++;
          log(`Subsystem ${name} primary failed, falling back (state: ${breaker.state})`, 'WARN', 'subsystem-mesh');
          return await this._executeFallback(name, args, breaker);
        }

        // If CLOSED but under threshold, still throw
        throw err;
      }
    } catch (err: any) {
      throw err;
    }
  }

  async _executeFallback(name: any, args: any, breaker: any) { 
    try {
      if (breaker.fallbackFn) {
        return await breaker.fallbackFn(...args);
      }

      // Try registered fallback chain
// @ts-expect-error
      const defaultSub = DEFAULT_SUBSYSTEMS[name];
      if (defaultSub && defaultSub.fallbackChain) {
        for (const level of defaultSub.fallbackChain) {
          const fallbackMap = this._fallbackRegistry.get(name);
          if (fallbackMap && fallbackMap.has(level)) {
            try {
              return await fallbackMap.get(level)(...args);
            } catch (fbErr: any) {
              log(`Fallback "${level}" for ${name} also failed`, 'WARN', 'subsystem-mesh');
            }
          }
        }
      }

      throw new Error(`No fallback available for subsystem "${name}"`);
    } catch (err: any) {
      logError(`Fallback execution failed for ${name}`, err);
      throw err;
    }
  }

  _recordSuccess(name: any, breaker: any) { 
    breaker.successCount++;
    breaker.failureCount = 0;
    if (breaker.state === CB_STATES.HALF_OPEN) {
      breaker.halfOpenSuccesses++;
      if (breaker.halfOpenSuccesses >= breaker.halfOpenRequests) {
        breaker.state = CB_STATES.CLOSED;
        breaker.usingFallback = false;
        log(`Subsystem ${name} HALF_OPEN -> CLOSED (recovered)`, 'INFO', 'subsystem-mesh');
      }
    }
  }

  _recordFailure(name: any, breaker: any) { 
    breaker.failureCount++;
    breaker.lastFailureTime = Date.now();

    if (breaker.state === CB_STATES.HALF_OPEN) {
      breaker.state = CB_STATES.OPEN;
      log(`Subsystem ${name} HALF_OPEN -> OPEN (probe failed)`, 'WARN', 'subsystem-mesh');
    } else if (breaker.state === CB_STATES.CLOSED && breaker.failureCount >= breaker.failureThreshold) {
      breaker.state = CB_STATES.OPEN;
      log(`Subsystem ${name} CLOSED -> OPEN (${breaker.failureCount}/${breaker.failureThreshold} failures)`, 'ERROR', 'subsystem-mesh');
    }
  }

  /**
   * Get status of all subsystem circuit breakers.
   */
  getMeshStatus() { 
    try {
      const status = {};
      for (const [name, breaker] of (this._breakers as any)) {
// @ts-expect-error
        status[name] = {
          state: breaker.state,
          failures: breaker.failureCount,
          successes: breaker.successCount,
          lastFailure: breaker.lastFailureTime,
          usingFallback: breaker.usingFallback,
          totalPrimaryCalls: breaker.totalPrimaryCalls,
          totalFallbackCalls: breaker.totalFallbackCalls
        };
      }
      return status;
    } catch (err: any) {
      logError('Error getting mesh status', err);
      return {};
    }
  }

  /**
   * Check if multiple subsystems are down and determine cascade degradation level.
   */
  cascadeCheck() { 
    try {
      const meshStatus = this.getMeshStatus();
      const openSubsystems = [];
      const nonCriticalOpen = [];

      for (const [name, status] of Object.entries(meshStatus)) {
        if ((status as any).state === CB_STATES.OPEN) {
// @ts-expect-error
          const isNonCritical = DEFAULT_SUBSYSTEMS[name] && DEFAULT_SUBSYSTEMS[name].nonCritical;
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
    } catch (err: any) {
      logError('Error in cascade check', err);
      return { level: 'normal', openSubsystems: [], nonCriticalOpen: [], meshStatus: {} };
    }
  }

  /**
   * Recommend operational mode changes based on which subsystems are down.
   */
  getDegradationRecommendation() { 
    try {
      const cascade = this.cascadeCheck();
      const recommendations = [];

      for (const subName of cascade.openSubsystems) {
// @ts-expect-error
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

      let overallRecommendation = null;
      if (cascade.level === 'critical') {
        overallRecommendation = 'CRITICAL: Multiple core subsystems down. Enter SURVIVAL mode immediately. Consider HIBERNATION if unrecoverable in 10 minutes.';
      } else if (cascade.level === 'survival') {
        overallRecommendation = 'SURVIVAL: Multiple subsystems degraded. Minimize operations, prioritize core functionality only.';
      } else if (cascade.level === 'degraded') {
        overallRecommendation = 'DEGRADED: Some subsystems using fallbacks. Monitor closely for further degradation.';
      }

      return {
        level: cascade.level,
        openSubsystems: cascade.openSubsystems,
        recommendations,
        overallRecommendation
      };
    } catch (err: any) {
      logError('Error generating degradation recommendation', err);
      return { level: 'normal', openSubsystems: [], recommendations: [], overallRecommendation: null };
    }
  }

  /**
   * Set callback for cascade change events.
   */
  onCascadeChange(callback: any) { 
    this._onCascadeChange = callback;
  }

  /**
   * Start periodic monitoring of the mesh.
   */
  startMonitoring(intervalMs = 30000) { 
    try {
      let lastLevel = 'normal';

      this._monitoringTimer = setInterval(async () => {
        try {
          const cascade = this.cascadeCheck();

          if (cascade.level !== lastLevel) {
            const prevLevel = lastLevel;
            lastLevel = cascade.level;
            log(`Cascade level changed: ${prevLevel} -> ${cascade.level} (open: [${cascade.openSubsystems.join(', ')}])`, cascade.level === 'normal' ? 'INFO' : 'WARN', 'subsystem-mesh');

            if (cascade.level !== 'normal') {
              const rec = this.getDegradationRecommendation();
              for (const r of rec.recommendations) {
                log(`Recommendation: ${r}`, 'WARN', 'subsystem-mesh');
              }
              if (rec.overallRecommendation) {
                try { getSendAlert()(`Subsystem cascade: ${cascade.level} - ${rec.overallRecommendation}`, 2); } catch (e: any) {}
              }
            }

            if (this._onCascadeChange) {
              try {
                await this._onCascadeChange(prevLevel, cascade.level, cascade);
              } catch (cbErr: any) {
                logError('Error in cascade change callback', cbErr);
              }
            }
          }

          // Auto-recovery: check for subsystems that should come back
          if (cascade.level === 'degraded' || cascade.level === 'survival') {
            this._checkAutoRecovery();
          }
        } catch (err: any) {
          logError('Error in monitoring cycle', err);
        }
      }, intervalMs);
      if (this._monitoringTimer.unref) this._monitoringTimer.unref();

      log(`Subsystem circuit breaker mesh monitoring started (interval: ${Math.round(intervalMs / 1000)}s)`, 'INFO', 'subsystem-mesh');
    } catch (err: any) {
      logError('Failed to start subsystem mesh monitoring', err);
    }
  }

  _checkAutoRecovery() { 
    try {
      for (const [name, breaker] of this._breakers) {
        if (breaker.state === CB_STATES.OPEN && breaker.lastFailureTime) {
          const elapsed = Date.now() - breaker.lastFailureTime;
          // Auto-transition to HALF_OPEN if enough time has passed
          if (elapsed >= breaker.resetTimeoutMs) {
            breaker.state = CB_STATES.HALF_OPEN;
            breaker.halfOpenSuccesses = 0;
            log(`Auto-recovery: subsystem ${name} OPEN -> HALF_OPEN`, 'INFO', 'subsystem-mesh');
          }
        }
      }
    } catch (err: any) {
      logError('Error in auto-recovery check', err);
    }
  }

  stopMonitoring() { 
    if (this._monitoringTimer) {
      clearInterval(this._monitoringTimer);
      this._monitoringTimer = null;
      log('Subsystem mesh monitoring stopped', 'INFO', 'subsystem-mesh');
    }
  }

  /**
   * Manually reset a subsystem's circuit breaker.
   */
  resetSubsystem(name: any) { 
    try {
      const breaker = this._breakers.get(name);
      if (!breaker) {
        log(`Cannot reset unknown subsystem: ${name}`, 'WARN', 'subsystem-mesh');
        return false;
      }
      breaker.state = CB_STATES.CLOSED;
      breaker.failureCount = 0;
      breaker.successCount = 0;
      breaker.lastFailureTime = null;
      breaker.halfOpenSuccesses = 0;
      breaker.usingFallback = false;
      log(`Subsystem ${name} circuit breaker manually reset`, 'INFO', 'subsystem-mesh');
      return true;
    } catch (err: any) {
      logError(`Error resetting subsystem ${name}`, err);
      return false;
    }
  }

  /**
   * Manually trip a subsystem's circuit breaker.
   */
  tripSubsystem(name: any, reason: any) { 
    try {
      const breaker = this._breakers.get(name);
      if (!breaker) {
        log(`Cannot trip unknown subsystem: ${name}`, 'WARN', 'subsystem-mesh');
        return false;
      }
      breaker.state = CB_STATES.OPEN;
      breaker.lastFailureTime = Date.now();
      log(`Subsystem ${name} manually tripped: ${reason}`, 'WARN', 'subsystem-mesh');
      return true;
    } catch (err: any) {
      logError(`Error tripping subsystem ${name}`, err);
      return false;
    }
  }
}

const subsystemMesh = new SubsystemCircuitBreakerMesh();
module.exports = {
  SubsystemCircuitBreakerMesh,
  subsystemMesh,
  CB_STATES,
  DEFAULT_SUBSYSTEMS
,
  _injectDependencies,
};