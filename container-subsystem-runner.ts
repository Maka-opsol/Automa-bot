'use strict';

const { DIContainer } = require('./container-container');
type ContainerSummary = ReturnType<InstanceType<typeof DIContainer>['getSummary']>;
const { spawnAll, getWorkerStatuses, shutdownAll } = require('./workers');

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

// ─── Type Definitions ───

interface SubsystemStartResult {
  started: string[];
  failed: Array<{ name: string; error: string }>;
}

interface SmokeTestResult {
  passed: boolean;
  checks: Array<{ id: string; passed: boolean; detail?: string }>;
}

interface SelfHealFlagConfig {
  flag: string | null;
  method?: string;
  arg?: number;
  immediate?: boolean;
  intervalArg?: number;
  accessor?: string;
}

/**
 * Start a tagged group of non-critical subsystems from the DI container.
 * Each module is loaded via container.get() inside a try/catch.
 * This replaces the ~20 try { require(...).start() } catch blocks in agent.js.
 */
function startSubsystemGroup(
  container: any,
  tag: string,
  startMethod: string = 'start',
): SubsystemStartResult {
  const moduleNames = container.getByTag(tag);
  const started: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  for (const name of moduleNames) {
    try {
      const mod = container.get(name, { required: false }) as Record<string, unknown> | null;
      if (!mod) {
        // Module was skipped (dependency failed) — already logged by container
        continue;
      }
      if (typeof mod[startMethod] === 'function') {
        (mod[startMethod] as () => void)();
        started.push(name);
      }
    } catch (err: any) {
      const errMsg = (err as Error).message;
      failed.push({ name, error: errMsg });
      _logger()?.log(`Subsystem "${name}" failed to start: ${errMsg}`, 'WARN', 'subsystem-runner');
    }
  }

  if (started.length > 0) {
    _logger()?.log(`Started ${started.length} ${tag} subsystems: ${started.join(', ')}`, 'INFO', 'subsystem-runner');
  }
  if (failed.length > 0) {
    _logger()?.log(`${failed.length} ${tag} subsystems failed: ${failed.map(f => f.name).join(', ')}`, 'WARN', 'subsystem-runner');
  }

  return { started, failed };
}

/**
 * Start all self-heal v2 subsystems, respecting their CONFIG flags.
 * This is a specialized version that checks CONFIG.*_ENABLED before starting.
 *
 * @param container - The DI container
 * @param CONFIG - The frozen configuration object
 */
function startSelfHealV2Subsystems(
  container: any,
  CONFIG: Record<string, unknown>,
): SubsystemStartResult {
  const selfHealV2 = container.getByTag('self-heal-v2');
  const started: string[] = [];
  const failed: Array<{ name: string; error: string }> = [];

  // Modules that are worker-backed — skip here, they're started by spawnAll()
  const WORKER_BACKED = new Set<string>(['rewardTracker']);

  // Map module names to their CONFIG flags and start arguments
  const flagMap: Record<string, SelfHealFlagConfig> = {
    predictiveHeal: { flag: 'PREDICTIVE_HEAL_ENABLED', arg: 60000 },
    structuralDrift: { flag: null, method: 'startBaselineCollection', arg: 3600000, accessor: 'structuralDriftFingerprinter' },
    providerPrediction: { flag: 'PROVIDER_PREDICTION_ENABLED', arg: 300000 },
    memoryPrediction: { flag: 'SELF_HEAL_MEMORY_PREDICTION_ENABLED', arg: 900000 },
    dbHealer: { flag: 'DB_HEALER_ENABLED', arg: 6 * 60 * 60 * 1000 },
    // v5-fix H2: Added accessor 'authHealer' — the method lives on the
    // exported `authHealer` singleton instance, not at module top level.
    authHealer: { flag: 'AUTH_HEALER_ENABLED', method: 'startProactiveRefreshDaemon', accessor: 'authHealer' },
    stateRecovery: { flag: 'STATE_RECOVERY_ENABLED', arg: 24 * 60 * 60 * 1000 },
    dependencyHealer: { flag: 'DEPENDENCY_HEALER_ENABLED', arg: 6 * 60 * 60 * 1000 },
    // v5-fix H1: Added accessor 'configReconciler' — the method lives on the
    // exported `configReconciler` singleton instance, not at module top level.
    configReconciler: { flag: 'CONFIG_RECONCILER_ENABLED', method: 'reconcileAll', immediate: true, intervalArg: 6 * 60 * 60 * 1000, accessor: 'configReconciler' },
    // rewardTracker is worker-backed — skipped above via WORKER_BACKED set
    healTimeline: { flag: 'SELF_HEAL_TIMELINE_ENABLED', method: 'startCleanup', arg: 24 * 60 * 60 * 1000 },
    metaSelfTest: { flag: 'HEALER_SELF_TEST_ENABLED' },
    healerCircuitBreaker: { flag: 'HEALER_CIRCUIT_BREAKER_ENABLED' },
    degradationLadder: { flag: 'DEGRADATION_LADDER_ENABLED', arg: 60000 },
    selectorDrift: { flag: 'SELECTOR_DRIFT_HEAL_ENABLED', arg: 300000 },
    blackboxReplay: { flag: 'BLACKBOX_REPLAY_ENABLED' },
    adversarialTester: { flag: 'ADVERSARIAL_TESTER_ENABLED' },
    cleanRoomTest: { flag: 'CLEAN_ROOM_TEST_ENABLED' },
    selfDeploy: { flag: 'SELF_DEPLOY_ENABLED', method: 'startMonitoring', arg: 6 * 60 * 60 * 1000 },
  };

  for (const name of selfHealV2) {
    // Skip worker-backed modules — they're managed by the worker spawner
    if (WORKER_BACKED.has(name)) continue;

    const config = flagMap[name];
    if (!config) continue;

    // Check CONFIG flag
    if (config.flag && !CONFIG[config.flag]) continue;

    try {
      const mod = container.get(name, { required: false }) as Record<string, unknown> | null;
      if (!mod) continue;

      // If an accessor is specified, resolve the method on that sub-object
      // (e.g. structuralDriftFingerprinter.startBaselineCollection instead of startBaselineCollection)
      const target = config.accessor ? (mod[config.accessor] as Record<string, unknown> | undefined) : mod;
      if (!target || typeof target !== 'object') continue;

      const method = config.method || 'start';
      if (typeof target[method] === 'function') {
        if (config.immediate) {
          // Run immediately (e.g. reconcileAll) then start interval
          (target[method] as () => Promise<unknown>)().catch(() => {});
          if (config.intervalArg && typeof mod.start === 'function') {
            (mod.start as (ms: number) => void)(config.intervalArg);
          }
        } else {
          if (config.arg !== undefined) {
            (target[method] as (arg: number) => void)(config.arg);
          } else {
            (target[method] as () => void)();
          }
        }
        started.push(name);
      }
    } catch (err: any) {
      const errMsg = (err as Error).message;
      failed.push({ name, error: errMsg });
      _logger()?.log(`Self-heal v2 subsystem "${name}" failed: ${errMsg}`, 'WARN', 'subsystem-runner');
    }
  }

  if (started.length > 0) {
    _logger()?.log(`Self-heal v2: ${started.length} subsystems started`, 'INFO', 'subsystem-runner');
  }

  return { started, failed };
}

/**
 * Start resilience subsystems — modules tagged 'resilience' that have
 * a start() method. Includes survival, runtime, progress, economy,
 * policy, auth, and network modules from the worst-case resilience plan.
 */
function startResilienceSubsystems(
  container: any,
): SubsystemStartResult {
  const result = startSubsystemGroup(container, 'resilience', 'start');

  // Additional one-time init for modules that need startup calls beyond start()
  try {
    const configDriftDetector = container.get('configDriftDetector', { required: false }) as Record<string, unknown> | null;
    if (configDriftDetector && typeof configDriftDetector.checkAndAlert === 'function') {
      (configDriftDetector.checkAndAlert as () => void)();
    }
  } catch (e: any) {
    _logger()?.log(`configDriftDetector.checkAndAlert failed: ${(e as Error).message}`, 'WARN', 'subsystem-runner');
  }

  try {
    const networkIpRotator = container.get('networkIpRotator', { required: false }) as Record<string, unknown> | null;
    if (networkIpRotator && typeof networkIpRotator.checkIp === 'function') {
      (networkIpRotator.checkIp as () => Promise<unknown>)().catch(() => {});
    }
  } catch (e: any) {
    _logger()?.log(`networkIpRotator.checkIp failed: ${(e as Error).message}`, 'WARN', 'subsystem-runner');
  }

  return result;
}

/**
 * Run startup smoke tests to catch common failure modes early.
 * Called after container initialization but before the daemon loop starts.
 * Non-critical — failures are logged and alerted but don't prevent startup.
 */
function runStartupSmokeTests(container: any): SmokeTestResult {
  const checks: SmokeTestResult['checks'] = [];

  // 1. Critical modules are all ready
  const summary = container.getSummary();
  if (summary.criticalFailed.length === 0) {
    checks.push({ id: 'critical-modules', passed: true, detail: `All ${summary.total - summary.failed - summary.skipped} initialized modules ready` });
  } else {
    checks.push({ id: 'critical-modules', passed: false, detail: `Critical failures: ${summary.criticalFailed.join(', ')}` });
  }

  // 2. No modules stuck in INITIALIZING (stale state from crashes)
  const stuck = summary.modules.filter((m: any) => m.status === 'initializing');
  if (stuck.length === 0) {
    checks.push({ id: 'no-stale-init', passed: true });
  } else {
    checks.push({ id: 'no-stale-init', passed: false, detail: `Stuck initializing: ${stuck.map((m: any) => m.name).join(', ')}` });
  }

  // 3. Dependency graph has no unresolvable chains
  //    (check: every failed/skipped module has a clear reason)
  const unclear = summary.modules.filter(
    (m: any) => (m.status === 'failed' || m.status === 'skipped') && !m.error
  );
  if (unclear.length === 0) {
    checks.push({ id: 'dep-graph-clean', passed: true });
  } else {
    checks.push({ id: 'dep-graph-clean', passed: false, detail: `Modules failed without error: ${unclear.map((m: any) => m.name).join(', ')}` });
  }

  // 4. Database is writable (try a calibration round-trip)
  try {
    const db = container.get('database', { required: false });
    if (db && db.upsertCalibration && db.selectCalibration) {
      const testKey = `smoke_test_${Date.now()}`;
      db.upsertCalibration.run(testKey, 'ok', Date.now());
      const row = db.selectCalibration.get(testKey);
      if (row && row.value === 'ok') {
        checks.push({ id: 'db-writable', passed: true });
        // Cleanup
        try { db.db.prepare('DELETE FROM calibration WHERE key = ?').run(testKey); } catch (e: any) { /* non-critical */ }
      } else {
        checks.push({ id: 'db-writable', passed: false, detail: 'Read-back mismatch' });
      }
    } else {
      checks.push({ id: 'db-writable', passed: false, detail: 'Database module not available' });
    }
  } catch (err: any) {
    checks.push({ id: 'db-writable', passed: false, detail: (err as Error).message });
  }

  // 5. Memory is below warning threshold at startup
  try {
    const usedMB = process.memoryUsage().heapUsed / 1024 / 1024;
    const config = container.get('config') as Record<string, unknown> | null;
    const threshold = (config?.MEMORY_WARNING_THRESHOLD_MB as number) || 400;
    if (usedMB < threshold) {
      checks.push({ id: 'memory-ok', passed: true, detail: `${usedMB.toFixed(0)}MB < ${threshold}MB` });
    } else {
      checks.push({ id: 'memory-ok', passed: false, detail: `${usedMB.toFixed(0)}MB >= ${threshold}MB warning threshold at startup` });
    }
  } catch (err: any) {
    checks.push({ id: 'memory-ok', passed: false, detail: (err as Error).message });
  }

  // 6. At least one provider is available
  try {
    const providers = container.get('providers', { required: false }) as Record<string, unknown> | null;
    if (providers && typeof providers.getStats === 'function') {
      const stats = (providers.getStats as () => Record<string, unknown>)();
      const activeProviders = (stats.availableProviders as string[]) || [];
      if (activeProviders.length > 0) {
        checks.push({ id: 'providers-available', passed: true, detail: `${activeProviders.length} provider(s): ${activeProviders.join(', ')}` });
      } else {
        checks.push({ id: 'providers-available', passed: false, detail: 'No providers available' });
      }
    } else {
      checks.push({ id: 'providers-available', passed: false, detail: 'Providers module not available' });
    }
  } catch (err: any) {
    checks.push({ id: 'providers-available', passed: false, detail: (err as Error).message });
  }

  const passed = checks.every(c => c.passed);

  // Log results
  for (const check of checks) {
    const level = check.passed ? 'INFO' : 'WARN';
    const icon = check.passed ? 'PASS' : 'FAIL';
    const detail = check.detail ? ` — ${check.detail}` : '';
    _logger()?.log(`[SmokeTest] ${icon}: ${check.id}${detail}`, level, 'smoke-test');
  }

  if (!passed) {
    _logger()?.log(`Startup smoke tests: ${checks.filter(c => c.passed).length}/${checks.length} passed`, 'WARN', 'smoke-test');
  } else {
    _logger()?.log(`Startup smoke tests: all ${checks.length} checks passed`, 'INFO', 'smoke-test');
  }

  return { passed, checks };
}

/**
 * Get a health summary of all container modules for the /health endpoint.
 */
function getContainerHealth(container: any): ContainerSummary {
  return container.getSummary();
}

/**
 * Spawn worker threads for workerizable subsystems.
 * Replaces in-process modules with worker-backed proxies.
 */
async function spawnWorkers(
  container: any,
  CONFIG: Record<string, unknown>,
): Promise<{ started: string[]; failed: string[] }> {
  try {
    const results = await spawnAll(CONFIG, container);
    return results;
  } catch (err: any) {
    _logger()?.logError('Worker spawner failed (falling back to in-process modules)', err as Error);
    return { started: [], failed: ['all'] };
  }
}

module.exports = { 
  startSubsystemGroup,
  startSelfHealV2Subsystems,
  startResilienceSubsystems,
  getContainerHealth,
  runStartupSmokeTests,
  spawnWorkers,
  getWorkerStatuses,
  shutdownAll,
 };
