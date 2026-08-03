const { describe, it, expect, vi } = require('vitest');
const { DIContainer, STATUS } = require('./container-container');
const { startSubsystemGroup,
  startSelfHealV2Subsystems,
  getContainerHealth, } = require('./container-subsystem-runner');

// ─── Subsystem Runner Tests ───

describe('startSubsystemGroup', () => {
  it('should start modules with matching tag', () => {
    const c = new DIContainer('test');
    const startFn = vi.fn();

    c.register('mod-a', {
      factory: () => ({ start: startFn }),
      critical: false,
      tags: ['group1'],
    });
    c.register('mod-b', {
      factory: () => ({ stop: vi.fn() }), // no 'start' method
      critical: false,
      tags: ['group1'],
    });
    c.register('mod-c', {
      factory: () => ({ start: vi.fn() }),
      critical: false,
      tags: ['group2'],
    });

    const result = startSubsystemGroup(c, 'group1');

    expect(startFn).toHaveBeenCalledTimes(1); // only mod-a has start()
    expect(result.started).toContain('mod-a');
    expect(result.started).not.toContain('mod-b'); // no start method
    expect(result.started).not.toContain('mod-c'); // wrong tag
    expect(result.failed).toHaveLength(0);
  });

  it('should collect failures for modules that throw on start', () => {
    const c = new DIContainer('test');

    c.register('good', {
      factory: () => ({ start: vi.fn() }),
      critical: false,
      tags: ['test'],
    });
    c.register('bad', {
      factory: () => ({
        start: () => { throw new Error('start failed'); },
      }),
      critical: false,
      tags: ['test'],
    });

    const result = startSubsystemGroup(c, 'test');

    expect(result.started).toContain('good');
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].name).toBe('bad');
    expect(result.failed[0].error).toBe('start failed');
  });

  it('should skip modules that returned null (dependency failed)', () => {
    const c = new DIContainer('test');

    c.register('dep-fail', {
      factory: () => { throw new Error('dep missing'); },
      deps: ['nonexistent-dep'],
      critical: false,
      tags: ['test'],
    });

    const result = startSubsystemGroup(c, 'test');
    expect(result.started).toHaveLength(0);
    expect(result.failed).toHaveLength(0); // skipped, not failed
  });

  it('should accept a custom start method name', () => {
    const c = new DIContainer('test');
    const initFn = vi.fn();

    c.register('mod', {
      factory: () => ({ init: initFn }),
      critical: false,
      tags: ['test'],
    });

    const result = startSubsystemGroup(c, 'test', 'init');
    expect(initFn).toHaveBeenCalled();
    expect(result.started).toContain('mod');
  });

  it('should return empty arrays for empty tag', () => {
    const c = new DIContainer('test');
    const result = startSubsystemGroup(c, 'nonexistent');
    expect(result.started).toEqual([]);
    expect(result.failed).toEqual([]);
  });
});

// ─── Self-Heal V2 Subsystem Runner ───

describe('startSelfHealV2Subsystems', () => {
  it('should start modules with matching CONFIG flag', () => {
    const c = new DIContainer('test');
    const startFn = vi.fn();

    c.register('degradationLadder', {
      factory: () => ({ start: startFn }),
      critical: false,
      tags: ['self-heal-v2'],
    });

    const CONFIG: Record<string, unknown> = { DEGRADATION_LADDER_ENABLED: true };
    const result = startSelfHealV2Subsystems(c, CONFIG);

    expect(startFn).toHaveBeenCalled();
    expect(result.started).toContain('degradationLadder');
  });

  it('should skip modules when CONFIG flag is false', () => {
    const c = new DIContainer('test');
    const startFn = vi.fn();

    c.register('dbHealer', {
      factory: () => ({ start: startFn }),
      critical: false,
      tags: ['self-heal-v2'],
    });

    const CONFIG: Record<string, unknown> = { DB_HEALER_ENABLED: false };
    const result = startSelfHealV2Subsystems(c, CONFIG);

    expect(startFn).not.toHaveBeenCalled();
    expect(result.started).toHaveLength(0);
  });

  it('should skip modules when CONFIG flag is missing', () => {
    const c = new DIContainer('test');
    const startFn = vi.fn();

    c.register('dbHealer', {
      factory: () => ({ start: startFn }),
      critical: false,
      tags: ['self-heal-v2'],
    });

    const CONFIG: Record<string, unknown> = {};

    startSelfHealV2Subsystems(c, CONFIG);

    expect(startFn).not.toHaveBeenCalled();
  });

  it('should skip worker-backed modules (rewardTracker)', () => {
    const c = new DIContainer('test');
    const startFn = vi.fn();

    c.register('rewardTracker', {
      factory: () => ({ startProdSurvivalCheck: startFn }),
      critical: false,
      tags: ['self-heal-v2'],
    });

    const CONFIG: Record<string, unknown> = { HEAL_REWARD_TRACKER_ENABLED: true };
    const result = startSelfHealV2Subsystems(c, CONFIG);

    expect(startFn).not.toHaveBeenCalled();
    expect(result.started).toHaveLength(0);
  });

  it('should skip unregistered self-heal-v2 modules', () => {
    const c = new DIContainer('test');
    const CONFIG: Record<string, unknown> = { PREDICTIVE_HEAL_ENABLED: true };
    const result = startSelfHealV2Subsystems(c, CONFIG);
    expect(result.started).toHaveLength(0);
    expect(result.failed).toHaveLength(0);
  });

  it('should use flagMap.method when specified', () => {
    const c = new DIContainer('test');
    const reconcileFn = vi.fn().mockResolvedValue(undefined);
    const startFn = vi.fn();

    c.register('configReconciler', {
      factory: () => ({
        reconcileAll: reconcileFn,
        start: startFn,
      }),
      critical: false,
      tags: ['self-heal-v2'],
    });

    const CONFIG: Record<string, unknown> = { CONFIG_RECONCILER_ENABLED: true };
    const result = startSelfHealV2Subsystems(c, CONFIG);

    expect(reconcileFn).toHaveBeenCalled();
    expect(startFn).toHaveBeenCalled(); // immediate config also starts interval
    expect(result.started).toContain('configReconciler');
  });

  it('should use flagMap.arg for start argument', () => {
    const c = new DIContainer('test');
    const startFn = vi.fn();

    c.register('degradationLadder', {
      factory: () => ({ start: startFn }),
      critical: false,
      tags: ['self-heal-v2'],
    });

    const CONFIG: Record<string, unknown> = { DEGRADATION_LADDER_ENABLED: true };
    startSelfHealV2Subsystems(c, CONFIG);

    // flagMap for degradationLadder has arg: 60000
    expect(startFn).toHaveBeenCalledWith(60000);
  });

  it('should start modules with null flag (always enabled when registered)', () => {
    const c = new DIContainer('test');
    const startFn = vi.fn();

    c.register('providerPrediction', {
      factory: () => ({ start: startFn }),
      critical: false,
      tags: ['self-heal-v2'],
    });

    const CONFIG: Record<string, unknown> = {};
    const result = startSelfHealV2Subsystems(c, CONFIG);

    expect(startFn).toHaveBeenCalledWith(300000); // flagMap.arg
    expect(result.started).toContain('providerPrediction');
  });
});

// ─── getContainerHealth ───

describe('getContainerHealth', () => {
  it('should return a summary from the container', () => {
    const c = new DIContainer('test');
    c.register('mod-a', {
      factory: () => ({ run: () => {} }),
      critical: false,
      tags: ['core'],
    });
    c.get('mod-a');

    const health = getContainerHealth(c);
    expect(health).toHaveProperty('containerName', 'test');
    expect(health).toHaveProperty('total', 1);
    expect(health).toHaveProperty('ready', 1);
    expect(health).toHaveProperty('failed', 0);
    expect(health).toHaveProperty('modules');
    expect(health.modules).toHaveLength(1);
  });
});

// ─── Module Registry ───

describe('createContainer (module registry)', () => {
  it('should export createContainer', async () => {
    const { createContainer } = await import('./container-modules.ts');
    expect(typeof createContainer).toBe('function');
  });

  it('should create a container with all core modules registered', async () => {
    const { createContainer } = await import('./container-modules.ts');
    const c = createContainer();

    const names = c.getRegisteredNames();
    expect(names).toContain('config');
    expect(names).toContain('logger');
    expect(names).toContain('database');
    expect(names).toContain('stateMachine');
  });

  it('should create a container with 70+ modules', async () => {
    const { createContainer } = await import('./container-modules.ts');
    const c = createContainer();

    expect(c.getRegisteredNames().length).toBeGreaterThanOrEqual(70);
  });

  it('should have correct tags on core modules', async () => {
    const { createContainer } = await import('./container-modules.ts');
    const c = createContainer();

    const core = c.getByTag('core');
    expect(core).toContain('config');
    expect(core).toContain('logger');
    expect(core).toContain('database');
    expect(core).toContain('stateMachine');
  });

  it('should have self-heal-v2 tagged modules', async () => {
    const { createContainer } = await import('./container-modules.ts');
    const c = createContainer();

    const v2 = c.getByTag('self-heal-v2');
    expect(v2.length).toBeGreaterThanOrEqual(20);
    expect(v2).toContain('predictiveHeal');
    expect(v2).toContain('degradationLadder');
    expect(v2).toContain('canary');
  });

  it('should have workerizable tagged modules', async () => {
    const { createContainer } = await import('./container-modules.ts');
    const c = createContainer();

    const workerizable = c.getByTag('workerizable');
    expect(workerizable).toContain('metrics');
    expect(workerizable).toContain('diary');
  });

  it('should have flutter tagged modules', async () => {
    const { createContainer } = await import('./container-modules.ts');
    const c = createContainer();

    const flutter = c.getByTag('flutter');
    expect(flutter.length).toBe(8);
    expect(flutter).toContain('flutterDpr');
    expect(flutter).toContain('flutterGestures');
    expect(flutter).toContain('flutterSemantics');
  });
});