'use strict';

const { DIContainer } = require('./container-container');
type DIContainerType = InstanceType<typeof DIContainer>;

// Lazy logger with fallback for test environments
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

/** A [requirePath, containerName, deps, optionalDeps?] tuple for batch registration.
 *  P13: optionalDeps allows batch-registered modules to declare optional deps
 *  that inject null on failure instead of skipping the parent module. */
type ModuleTuple = [string, string, string[], string[]?];

/**
 * Build and return the fully-configured DI container.
 *
 * Every module that was previously directly required() in agent.js
 * or cycle-manager.js is now declared here with its dependencies,
 * lifecycle, and criticality.
 *
 * Modules are organized by subsystem for clarity.
 */
function createContainer(): DIContainerType {
  const c = new DIContainer('mathu-bot');

  // ═══════════════════════════════════════════════════════════
  // CORE (critical — failure prevents startup)
  // ═══════════════════════════════════════════════════════════

  c.register('config', {
    factory: () => require('./config'),
    critical: true,
    tags: ['core'],
  });

  c.register('logger', {
    factory: () => require('./logger'),
    deps: ['config'],
    critical: true,
    tags: ['core'],
  });

  c.register('database', {
    factory: (deps: any) => {
      const mod = require('./database');
      mod._injectDependencies(deps);
      mod.initDatabase();
      return mod;
    },
    deps: ['config', 'logger'],
    critical: true,
    tags: ['core'],
  });

  c.register('stateMachine', {
    factory: (deps: any) => {
      const mod = require('./state-machine');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['database', 'config', 'logger'],
    critical: true,
    tags: ['core'],
  });

  // ═══════════════════════════════════════════════════════════
  // FOUNDATION UTILITIES (registered early — depended on by browser,
  // providers, and many other modules)
  // v5-fix: moved here from UTILITY section to fix registration-order
  // fragility (browser depended on cache, but cache was 500 lines below).
  // ═══════════════════════════════════════════════════════════

  c.register('cache', {
    factory: (deps: any) => {
      const mod = require('./cache');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('providersBase', {
    factory: (deps: any) => {
      const mod = require('./providers-base');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['providers'],
  });

  c.register('providersStats', {
    factory: (deps: any) => {
      const mod = require('./providers-stats');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: [],
    critical: false,
    tags: ['providers'],
  });

  // ═══════════════════════════════════════════════════════════
  // BROWSER
  // ═══════════════════════════════════════════════════════════

  c.register('browser', {
    factory: (deps: any) => {
      const mod = require('./browser');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'cache', 'database'],
    critical: true,
    tags: ['browser'],
  });

  // ═══════════════════════════════════════════════════════════
  // ALERTING (critical — depended on by auth, providers, orchestrator, authGuard)
  // ═══════════════════════════════════════════════════════════

  c.register('alerting', {
    factory: (deps: any) => {
      const mod = require('./alerting');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: true,
    tags: ['alerting', 'core'],
  });

  // ═══════════════════════════════════════════════════════════
  // AUTH
  // ═══════════════════════════════════════════════════════════

  c.register('auth', {
    factory: (deps: any) => {
      const mod = require('./auth');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'alerting'],
    critical: true,
    tags: ['auth'],
  });

  c.register('jwt', {
    factory: (deps: any) => {
      const mod = require('./jwt');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'alerting'],
    critical: false,
    tags: ['auth', 'api'],
  });

  // ═══════════════════════════════════════════════════════════
  // PROVIDERS
  // ═══════════════════════════════════════════════════════════

  c.register('providers', {
    factory: (deps: any) => {
      const mod = require('./providers');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'browser', 'cache'],
    critical: true,
    tags: ['providers'],
  });

  c.register('providerRegistry', {
    factory: (deps: any) => {
      const mod = require('./providers-registry');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'alerting'],
    critical: true,
    tags: ['providers'],
  });

  c.register('visionPipeline', {
    factory: (deps: any) => {
      const mod = require('./providers-vision-pipeline');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'providerRegistry', 'providersBase', 'browser', 'cache'],
    critical: true,
    tags: ['providers'],
  });

  c.register('providerQuotaBargain', {
    factory: (deps: any) => {
      const mod = require('./provider-quota-bargain');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'alerting', 'providersBase'],
    critical: false,
    tags: ['providers'],
  });

  // OpenRouter rate limiter — the single source of truth for OR daily budget
  // Registered early so providers can use it immediately
  c.register('openRouterRateLimiter', {
    factory: (deps: any) => {
      const mod = require('./openrouter-rate-limiter');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['providers'],
  });

  // WolframAlpha oracle — external math verification (Response 1)
  // Registered before math-verify so it's available as a dependency
  c.register('wolfram', {
    factory: (deps: any) => {
      const mod = require('./services-wolfram');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['services'],
  });

  // Math verification module — catches LLM math errors (Response 1)
  // Uses nerdamer locally + WolframAlpha as external oracle
  c.register('mathVerify', {
    factory: (deps: any) => {
      const mod = require('./math-verify');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'wolfram'],
    critical: false,
    tags: ['services'],
  });

  // Response 4: Problem classifier (no DI deps needed — uses lazy requires)
  c.register('problemClassifier', {
    factory: (deps: any) => {
      const mod = require('./math-problem-classifier');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['services'],
  });

  // Response 4: Mathpix OCR client (no DI deps needed — uses lazy requires)
  c.register('mathpix', {
    factory: (deps: any) => {
      const mod = require('./services-mathpix');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['services'],
  });

  // Response 5: Solution cache (uses calibration table, no extra DI deps)
  c.register('solutionCache', {
    factory: (deps: any) => {
      const mod = require('./math-solution-cache');
      mod._injectDependencies(deps);
      mod.init();
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['services'],
  });

  // Response 6: /tmp disk guardian (prevents silent /tmp fill-up)
  c.register('tmpGuardian', {
    factory: (deps: any) => {
      const mod = require('./longevity-tmp-guardian');
      mod._injectDependencies(deps);
      mod.init();
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['longevity'],
  });

  // Response 6: Render cold start detection + recovery
  c.register('coldStart', {
    factory: (deps: any) => {
      const mod = require('./render-cold-start');
      mod._injectDependencies(deps);
      mod.init();
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['longevity'],
  });

  // Work shift scheduler — time + resource aware shift management (Response 7)
  c.register('workShifts', {
    factory: (deps: any) => {
      const mod = require('./services-work-shifts');
      mod._injectDependencies(deps);
      mod.recoverFromDB();
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['scheduling'],
  });

  // API key vault — centralized key validation + health tracking (Response 8)
  c.register('apiKeyVault', {
    factory: (deps: any) => {
      const mod = require('./services-api-key-vault');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['monitoring'],
  });

  // Contextual alert manager — proactive NTFY alerts based on bot state (Response 8)
  c.register('contextualAlerts', {
    factory: (deps: any) => {
      const mod = require('./services-ntfy-alerts');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['monitoring'],
  });

  // Action cache — skip AI calls when visual context matches a previous successful action
  c.register('actionCache', {
    factory: (deps: any) => {
      const mod = require('./services-action-cache');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['performance'],
  });

  // Health watchdog — self-ping with scoring + auto-restart (Response 2)
  c.register('healthWatchdog', {
    factory: (deps: any) => {
      const mod = require('./longevity-self-ping');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'browser', 'cache', 'providersBase'],
    critical: false,
    tags: ['longevity'],
  });

  // providersBase and providersStats are registered in FOUNDATION UTILITIES above.
  // v5-fix: moved up so dependents (providerQuotaBargain, dashboard) don't
  // rely on late lazy-resolution.

  c.register('providersConfigLoader', {
    factory: (deps: any) => {
      const mod = require('./providers-config-loader');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['providers'],
  });

  // ═══════════════════════════════════════════════════════════
  // CYCLE
  // ═══════════════════════════════════════════════════════════

  c.register('cycleManager', {
    factory: (deps: any) => {
      // Inject dependencies into cycle-manager via a setup function
      const cycleManager = require('./cycle-cycle-manager');
      cycleManager._injectDependencies(deps);
      return cycleManager;
    },
    deps: [
      // Core
      'config', 'logger', 'database', 'browser', 'auth', 'providers',
      'stateMachine', 'visionPipeline', 'cache', 'alerting',
      // Cycle subsystems
      'authGuard', 'actionExecutor', 'stagnation', 'moduleTracking',
      // State & progress
      'statePersist', 'moduleSelector', 'progressTracker',
      // Provider management
      'providersBase', 'providerQuotaBargain',
      // Utility modules
      'dependencySurvivor', 'uiDriftDiscovery', 'captchaHumanFallback',
      'bruteForceNavigator', 'blackbox', 'adaptivePerformanceEngine',
      'explorationCartographer',
      // Flutter subsystems
      'flutterStability', 'flutterModalSlayer', 'flutterSemantics',
      'flutterDpr', 'flutterNetwork', 'flutterInspector',
      'flutterCanvas', 'flutterGestures',
      // Experiments & policy
      'strategyVariants', 'policyEngine', 'pluginAPI',
    ],
    critical: true,
    tags: ['cycle'],
  });

  c.register('orchestrator', {
    factory: (deps: any) => {
      const mod = require('./cycle-orchestrator');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'cycleManager', 'shutdown', 'alerting'],
    critical: true,
    tags: ['cycle'],
  });

  c.register('shutdown', {
    factory: (deps: any) => {
      const mod = require('./cycle-shutdown');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['logger'],
    critical: true,
    tags: ['cycle'],
  });

  c.register('actionExecutor', {
    factory: (deps: any) => {
      const mod = require('./cycle-action-executor');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'browser', 'providers', 'providersBase', 'progressTracker', 'policyEngine', 'flutterGestures', 'adaptivePerformanceEngine'],
    critical: true,
    tags: ['cycle'],
  });

  c.register('authGuard', {
    factory: (deps: any) => {
      const mod = require('./cycle-auth-guard');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'auth', 'browser', 'alerting'],
    critical: true,
    tags: ['cycle', 'auth'],
  });

  c.register('stagnation', {
    factory: (deps: any) => {
      const mod = require('./cycle-stagnation');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'browser', 'alerting'],
    critical: false,
    tags: ['cycle'],
  });

  c.register('moduleTracking', {
    factory: (deps: any) => {
      const mod = require('./cycle-module-tracking');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'cache', 'providers'],
    critical: false,
    tags: ['cycle'],
  });

  // ═══════════════════════════════════════════════════════════
  // SELF-HEAL
  // ═══════════════════════════════════════════════════════════

  // P13: Removed 'sandboxExecutor' and 'selfHealAuditor' from deps.
  // selfHeal internally lazy-requires both when needed, so if they fail
  // to initialize (e.g. sandboxExecutor on Render's constrained env),
  // selfHeal still works. Previously, sandboxExecutor failure cascaded:
  //   sandboxExecutor fails → selfHealAuditor skipped → selfHeal skipped
  // Now: sandboxExecutor failure = sandboxExecutor only.
  c.register('selfHeal', {
    factory: (deps: any) => {
      const mod = require('./self-heal');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database',
           'providersStats', 'patchMemory', 'diffMinimizer', 'adversarialTester',
           'canary', 'regressionBank', 'rewardTracker', 'healerCircuitBreaker',
           'browser', 'auth', 'alerting'],
    // P13: sandboxExecutor and selfHealAuditor are lazy-required internally
    optionalDeps: ['sandboxExecutor', 'selfHealAuditor'],
    critical: false,
    tags: ['self-heal'],
  });

  // P13: Removed 'sandboxExecutor' from deps — selfHealAuditor lazy-requires
  // it internally. This breaks the cascade:
  //   sandboxExecutor fails → selfHealAuditor skipped → selfHeal skipped
  // Now: sandboxExecutor failure = sandboxExecutor only.
  c.register('selfHealAuditor', {
    factory: (deps: any) => {
      const mod = require('./self-heal-auditor');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    optionalDeps: ['sandboxExecutor'],
    critical: false,
    tags: ['self-heal'],
  });

  c.register('selfHealGitops', {
    factory: (deps: any) => {
      const mod = require('./self-heal-gitops');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'alerting'],
    critical: false,
    tags: ['self-heal'],
  });

  c.register('sandboxExecutor', {
    factory: (deps: any) => {
      const mod = require('./sandbox-executor');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'alerting'],
    critical: false,
    tags: ['self-heal'],
  });

  // v5-fix: removed 'providers' from deps — same rationale as selfHealAuditor.
  // This module only uses providersBase (non-critical) with a lazy fallback.
  c.register('criticalPatchConsensus', {
    factory: (deps: any) => {
      const mod = require('./critical-patch-consensus');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'sandboxExecutor'],
    critical: false,
    tags: ['self-heal'],
  });

  // Self-heal v2 subsystems — batch registered from typed tuples
  const selfHealV2Modules: ModuleTuple[] = [
    ['self-heal-predictive', 'predictiveHeal', ['config', 'logger', 'database', 'providers']],
    ['self-heal-structural-drift-fingerprint', 'structuralDrift', ['config', 'logger', 'database']],
    ['self-heal-provider-prediction', 'providerPrediction', ['config', 'logger', 'database', 'providers']],
    ['self-heal-memory-prediction', 'memoryPrediction', ['config', 'logger', 'database']],
    ['self-heal-db-healer', 'dbHealer', ['config', 'logger', 'database']],
    ['self-heal-auth-healer', 'authHealer', ['config', 'logger', 'auth', 'database']],
    ['self-heal-state-recovery', 'stateRecovery', ['config', 'logger', 'database', 'stateMachine']],
    ['self-heal-dependency-healer', 'dependencyHealer', ['config', 'logger', 'database']],
    ['self-heal-config-reconciler', 'configReconciler', ['config', 'logger', 'database']],
    ['self-heal-reward-tracker', 'rewardTracker', ['config', 'logger', 'database']],
    ['self-heal-timeline', 'healTimeline', ['config', 'logger', 'database']],
    // P13: Removed 'sandboxExecutor' from metaSelfTest deps — it lazy-requires
    // internally. Kept 'selfHealAuditor' as optional (has lazy fallback).
    ['self-heal-meta-self-test', 'metaSelfTest', ['config', 'logger', 'database', 'alerting'], ['selfHealAuditor', 'sandboxExecutor']],
    ['self-heal-circuit-breaker', 'healerCircuitBreaker', ['config', 'logger', 'database']],
    ['self-heal-canary', 'canary', ['config', 'logger', 'database']],
    ['self-heal-diff-minimizer', 'diffMinimizer', ['config', 'logger']],
    ['self-heal-adversarial-tester', 'adversarialTester', ['config', 'logger', 'database']],
    ['self-heal-regression-bank', 'regressionBank', ['config', 'logger', 'database']],
    ['self-heal-patch-memory', 'patchMemory', ['config', 'logger', 'database']],
    ['self-heal-degradation-ladder', 'degradationLadder', ['config', 'logger', 'database', 'alerting']],
    ['self-heal-clean-room-test', 'cleanRoomTest', ['config', 'logger', 'database', 'alerting']],
    ['self-heal-self-deploy', 'selfDeploy', ['config', 'logger', 'database', 'alerting']],
    ['self-heal-selector-drift', 'selectorDrift', ['config', 'logger', 'database']],
    ['self-heal-blackbox-replay', 'blackboxReplay', ['config', 'logger', 'database']],
    ['self-heal-critical-shadow-mode', 'criticalShadowMode', ['config', 'logger', 'database']],
  ];

  // ModuleTuple is now [requirePath, containerName, deps, optionalDeps?]
  for (const tuple of selfHealV2Modules) {
    const [modPath, name, deps, optionalDeps] = tuple;
    c.register(name, {
      factory: (deps: any) => {
        const mod = require(`./${modPath}`);
        mod._injectDependencies(deps);
        return mod;
      },
      deps,
      optionalDeps: optionalDeps || [],
      critical: false,
      tags: ['self-heal', 'self-heal-v2'],
    });
  }

  // ═══════════════════════════════════════════════════════════
  // MONITORING
  // ═══════════════════════════════════════════════════════════

  c.register('healthCheck', {
    factory: (deps: any) => {
      const mod = require('./monitoring-health-check');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'alerting'],
    critical: false,
    tags: ['monitoring'],
  });

  c.register('anomalyDetector', {
    factory: (deps: any) => {
      const mod = require('./monitoring-anomaly-detector');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'alerting'],
    critical: false,
    tags: ['monitoring'],
  });

  c.register('subsystemCircuitBreakers', {
    factory: (deps: any) => {
      const mod = require('./monitoring-subsystem-circuit-breakers');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'alerting'],
    critical: false,
    tags: ['monitoring', 'self-heal'],
  });

  c.register('metrics', {
    factory: (deps: any) => {
      const mod = require('./metrics');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['monitoring', 'workerizable'],
  });

  // ═══════════════════════════════════════════════════════════
  // LONGEVITY
  // ═══════════════════════════════════════════════════════════

  c.register('playwrightGuardian', {
    factory: (deps: any) => {
      const mod = require('./longevity-playwright-guardian');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['longevity'],
  });

  c.register('dbJanitor', {
    factory: (deps: any) => {
      const mod = require('./longevity-db-janitor');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['longevity'],
  });

  c.register('nodeMonitor', {
    factory: (deps: any) => {
      const mod = require('./longevity-node-monitor');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['longevity'],
  });

  // (alerting moved to core section above — registered as critical before dependents)

  // ═══════════════════════════════════════════════════════════
  // PLANNING & EXPERIMENTS
  // ═══════════════════════════════════════════════════════════

  c.register('moduleSelector', {
    factory: (deps: any) => {
      const mod = require('./planning-module-selector');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['planning'],
  });

  c.register('strategyVariants', {
    factory: (deps: any) => {
      const mod = require('./experiments-strategy-variants');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['experiments'],
  });

  // ═══════════════════════════════════════════════════════════
  // META-LEARNING
  // ═══════════════════════════════════════════════════════════

  c.register('reflection', {
    factory: (deps: any) => {
      const mod = require('./meta-learner-reflection');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'alerting', 'providersBase'],
    critical: false,
    tags: ['meta-learning'],
  });

  // ═══════════════════════════════════════════════════════════
  // FLUTTER SPECIALIZATION
  // ═══════════════════════════════════════════════════════════

  const flutterModules: ModuleTuple[] = [
    ['flutter-dpr-calibrator', 'flutterDpr', ['database']],
    ['flutter-stability-waiter', 'flutterStability', []],
    ['flutter-modal-slayer', 'flutterModalSlayer', ['browser']],
    ['flutter-network-interceptor', 'flutterNetwork', ['database']],
    ['flutter-engine-inspector', 'flutterInspector', []],
    ['flutter-canvas-parser', 'flutterCanvas', []],
    ['flutter-gesture-simulator', 'flutterGestures', []],
    ['flutter-semantics-overlord', 'flutterSemantics', []],
  ];

  for (const [modPath, name, extraDeps] of flutterModules) {
    c.register(name, {
      factory: (deps: any) => {
      const mod = require(`./${modPath}`);
      mod._injectDependencies(deps);
      return mod;
    },
      deps: ['config', 'logger', ...extraDeps],
      critical: false,
      tags: ['flutter'],
    });
  }

  // ═══════════════════════════════════════════════════════════
  // UTILITY
  // ═══════════════════════════════════════════════════════════

  // v5-fix M1: Register validationSuite — it was referenced in agent.ts:371
  // via container.get('validationSuite') but never registered, so it always
  // returned null and smoke tests never ran.
  c.register('validationSuite', {
    factory: (deps: any) => {
      const mod = require('./test-validation-suite');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'browser', 'auth', 'providers', 'database'],
    critical: false,
    tags: ['utility'],
  });

  // cache is registered in FOUNDATION UTILITIES above.
  // v5-fix: moved up because browser depends on it.

  c.register('blackbox', {
    factory: (deps: any) => {
      const mod = require('./blackbox-recorder');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('progressTracker', {
    factory: (deps: any) => {
      const mod = require('./progress-tracker');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('statePersist', {
    factory: (deps: any) => {
      const mod = require('./state-persist');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'stateMachine', 'browser'],
    critical: false,
    tags: ['utility'],
  });

  c.register('dependencySurvivor', {
    factory: (deps: any) => {
      const mod = require('./dependency-survivor');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'providersBase'],
    critical: false,
    tags: ['utility'],
  });

  c.register('dependencyManager', {
    factory: (deps: any) => {
      const mod = require('./dependency-manager');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('failsafeCoordinator', {
    factory: (deps: any) => {
      const mod = require('./failsafe-coordinator');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'stateMachine', 'cache', 'browser', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('dbBackup', {
    factory: (deps: any) => {
      const mod = require('./db-backup');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('uiDriftDiscovery', {
    factory: (deps: any) => {
      const mod = require('./ui-drift-discovery');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('bruteForceNavigator', {
    factory: (deps: any) => {
      const mod = require('./brute-force-navigator');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('captchaHumanFallback', {
    factory: (deps: any) => {
      const mod = require('./captcha-human-fallback');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'browser', 'auth', 'providers', 'database'],
    critical: false,
    tags: ['utility'],
  });

  c.register('captchaSolverExternal', {
    factory: (deps: any) => {
      const mod = require('./captcha-solver-external');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['utility'],
  });

  c.register('adaptivePerformanceEngine', {
    factory: (deps: any) => {
      const mod = require('./adaptive-performance-engine');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['utility'],
  });

  c.register('explorationCartographer', {
    factory: (deps: any) => {
      const mod = require('./exploration-cartographer');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['utility', 'exploration'],
  });

  c.register('domainAdapter', {
    factory: (deps: any) => {
      const mod = require('./exploration-domain-adapter');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['utility', 'exploration'],
  });

  // ═══════════════════════════════════════════════════════════
  // POLICY & PLUGINS
  // ═══════════════════════════════════════════════════════════

  c.register('policyEngine', {
    factory: (deps: any) => {
      const mod = require('./policy-policy-engine');
      mod._injectDependencies(deps);
      return mod.policyEngine;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['policy'],
  });

  c.register('pluginAPI', {
    factory: (deps: any) => {
      const mod = require('./plugins-plugin-interface');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['plugins'],
  });

  c.register('plugins', {
    factory: (deps: any) => {
      const mod = require('./plugins-loader');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['plugins'],
  });

  // ═══════════════════════════════════════════════════════════
  // SERVICES
  // ═══════════════════════════════════════════════════════════

  c.register('ipCheck', {
    factory: (deps: any) => {
      const mod = require('./services-ip-check');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['services'],
  });

  c.register('modelEvolution', {
    factory: (deps: any) => {
      const mod = require('./services-model-evolution');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'providersBase'],
    critical: false,
    tags: ['services'],
  });

  c.register('modelEvolutionAdvanced', {
    factory: (deps: any) => {
      const mod = require('./services-model-evolution-v2');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'providersBase'],
    critical: false,
    tags: ['services'],
  });

  c.register('remoteConfig', {
    factory: (deps: any) => {
      const mod = require('./config-remote-config');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['services'],
  });

  c.register('getActiveModel', {
    factory: (deps: any) => {
      const mod = require('./services-get-active-model');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'database'],
    critical: false,
    tags: ['services'],
  });

  // ═══════════════════════════════════════════════════════════
  // DOCUMENTING
  // ═══════════════════════════════════════════════════════════

  c.register('diary', {
    factory: (deps: any) => {
      const mod = require('./self-documenting-diary');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['documenting', 'workerizable'],
  });

  // ═══════════════════════════════════════════════════════════
  // COORDINATION
  // ═══════════════════════════════════════════════════════════

  c.register('coordinator', {
    factory: (deps: any) => {
      const mod = require('./coordinator-leader');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database'],
    critical: false,
    tags: ['coordination'],
  });

  c.register('resourceManager', {
    factory: (deps: any) => {
      const mod = require('./resource-manager');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['coordination'],
  });

  // ═══════════════════════════════════════════════════════════
  // DASHBOARD
  // ═══════════════════════════════════════════════════════════

  c.register('dashboard', {
    factory: (deps: any) => {
      const mod = require('./dashboard-server');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger', 'database', 'stateMachine', 'cache', 'providers', 'browser', 'jwt', 'failsafeCoordinator', 'providersStats'],
    critical: false,
    tags: ['dashboard'],
  });

  // ═══════════════════════════════════════════════════════════
  // REMOTE BRAIN
  // ═══════════════════════════════════════════════════════════

  c.register('remoteBrain', {
    factory: (deps: any) => {
      const mod = require('./remote-brain-injector');
      mod._injectDependencies(deps);
      return mod;
    },
    deps: ['config', 'logger'],
    critical: false,
    tags: ['utility'],
  });

  // ═══════════════════════════════════════════════════════════
  // RESILIENCE — Worst-case survival modules (R1-R16)
  // ═══════════════════════════════════════════════════════════

  const resilienceModules: ModuleTuple[] = [
    // R1: Pre-OOM euthanasia
    ['runtime-heap-guardian', 'runtimeHeapGuardian', ['config', 'logger', 'browser', 'cache']],
    // R2: Diagnostic smoke test
    ['config-boot-validation', 'configBootValidation', ['config', 'logger', 'database', 'providers', 'browser'], ['alerting']],
    // R3a: Env var drift detection
    ['config-drift-detector', 'configDriftDetector', ['config', 'logger', 'database'], ['alerting']],
    // R3b: DNS-over-HTTPS fallback
    ['providers-dns-rotation', 'providersDnsRotation', ['config', 'logger']],
    // R4: Remote state backup
    ['survival-tombstone', 'survivalTombstone', ['config', 'logger', 'database'], ['alerting']],
    // R5: Disk wipe protection
    ['survival-ephemeral-shield', 'survivalEphemeralShield', ['config', 'logger', 'database'], ['statePersist']],
    // R6: External liveness beacon
    ['survival-heartbeat-beacon', 'survivalHeartbeatBeacon', ['config', 'logger']],
    // R7: Hot module isolation
    ['runtime-module-quarantine', 'runtimeModuleQuarantine', ['config', 'logger'], ['alerting']],
    // R8: Crash-resistant browser
    ['browser-phoenix', 'browserPhoenix', ['config', 'logger', 'browser'], ['alerting']],
    // R9: Semantic progress detection
    ['progress-semantic-detector', 'progressSemanticDetector', ['config', 'logger']],
    // R10a: Speed benchmark timeout
    ['progress-speed-benchmark', 'progressSpeedBenchmark', ['config', 'logger', 'database']],
    // R10b: Circular path detection
    ['progress-circular-path-detector', 'progressCircularPathDetector', ['config', 'logger']],
    // R11: Cross-module failure correlation
    ['cascade-breaker', 'cascadeBreaker', ['config', 'logger', 'database'], ['alerting']],
    // R12: Quota rationing
    ['economy-quota-rations', 'economyQuotaRations', ['config', 'logger', 'database'], ['alerting', 'providerRegistry']],
    // R13a: Action whitelist per state
    ['policy-action-validator', 'policyActionValidator', ['config', 'logger']],
    // R13b: State transition guard
    ['policy-state-guard', 'policyStateGuard', ['config', 'logger']],
    // R14a: CAPTCHA loop detection
    ['auth-captcha-loop-guard', 'authCaptchaLoopGuard', ['config', 'logger', 'database'], ['alerting']],
    // R14b: Token lifecycle management
    ['auth-token-graveyard', 'authTokenGraveyard', ['config', 'logger', 'database'], ['alerting', 'auth']],
    // R15: IP rotation awareness
    ['network-ip-rotator', 'networkIpRotator', ['config', 'logger', 'database'], ['alerting', 'providers']],
    // R16: No-browser fallback
    ['browser-ghost-mode', 'browserGhostMode', ['config', 'logger']],
  ];

  for (const tuple of resilienceModules) {
    const [modPath, name, deps, optionalDeps] = tuple;
    c.register(name, {
      factory: (deps: any) => {
        const mod = require(`./${modPath}`);
        mod._injectDependencies(deps);
        return mod;
      },
      deps,
      optionalDeps: optionalDeps || [],
      critical: false,
      tags: ['resilience'],
    });
  }

  return c;
}

module.exports = {  createContainer  };
