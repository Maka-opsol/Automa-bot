const { describe, it, expect, vi, beforeEach, afterEach } = require('vitest');

// ─── Imports ───
const { ERROR_CODES,
  MathUBotError,
  TransientError,
  NetworkTimeoutError,
  RateLimitedError,
  ProviderTemporaryError,
  BrowserDisconnectedError,
  CaptchaEncounteredError,
  FatalError,
  CredentialInvalidError,
  EncryptionFailureError,
  DatabaseCorruptError,
  SandboxEscapedError,
  OutOfMemoryError,
  HealableError,
  SelectorDriftError,
  UIChangedError,
  ProviderPermanentError,
  StateDeadlockError,
  PatchFailedError,
  ConfigError,
  AuthenticationError,
  ProviderError,
  StateError,
  SandboxError,
  ValidationError,
  classifyError } = require('./errors');

const { DIContainer, LIFECYCLE, STATUS } = require('./container-container');

const { MSG_TYPE, WORKER_CMD, WORKER_ERROR, METHOD,
  nextCorrelationId,
  createRequest, createReply, createCast, createEvent,
} = require('./workers-message-protocol');

// ═══════════════════════════════════════════════════════════
// 1. ERROR TAXONOMY — Advanced Edge Cases
// ═══════════════════════════════════════════════════════════

describe('Error Taxonomy: Advanced', () => {
  describe('instanceof chains', () => {
    it('NetworkTimeoutError should be instanceof TransientError and MathUBotError', () => {
      const err = new NetworkTimeoutError();
      expect(err).toBeInstanceOf(NetworkTimeoutError);
      expect(err).toBeInstanceOf(TransientError);
      expect(err).toBeInstanceOf(MathUBotError);
      expect(err).toBeInstanceOf(Error);
    });

    it('CredentialInvalidError should be instanceof FatalError and MathUBotError', () => {
      const err = new CredentialInvalidError();
      expect(err).toBeInstanceOf(CredentialInvalidError);
      expect(err).toBeInstanceOf(FatalError);
      expect(err).toBeInstanceOf(MathUBotError);
      expect(err).toBeInstanceOf(Error);
    });

    it('SelectorDriftError should be instanceof HealableError and MathUBotError', () => {
      const err = new SelectorDriftError();
      expect(err).toBeInstanceOf(SelectorDriftError);
      expect(err).toBeInstanceOf(HealableError);
      expect(err).toBeInstanceOf(MathUBotError);
      expect(err).toBeInstanceOf(Error);
    });

    it('ConfigError should be instanceof MathUBotError but NOT TransientError', () => {
      const err = new ConfigError('bad');
      expect(err).toBeInstanceOf(ConfigError);
      expect(err).toBeInstanceOf(MathUBotError);
      expect(err).not.toBeInstanceOf(TransientError);
      expect(err).not.toBeInstanceOf(FatalError);
      expect(err).not.toBeInstanceOf(HealableError);
    });
  });

  describe('toJSON serialization', () => {
    it('should serialize MathUBotError cause with code when cause is also MathUBotError', () => {
      const cause = new NetworkTimeoutError('inner timeout');
      const err = new FatalError('outer fatal', { cause });
      const json = err.toJSON();

      expect(json.name).toBe('FatalError');
      expect(json.code).toBe('E_UNKNOWN');
      expect(json.retryable).toBe(false);
      expect(json.cause).not.toBeNull();
      expect(json.cause!.name).toBe('NetworkTimeoutError');
      expect(json.cause!.message).toBe('inner timeout');
      expect(json.cause!.code).toBe('E_NETWORK_TIMEOUT');
    });

    it('should serialize full error with all fields', () => {
      const err = new RateLimitedError('custom msg', {
        retryAfterMs: 120000,
        context: { endpoint: '/api/v1/chat', model: 'groq-4' },
      });
      const json = err.toJSON();

      expect(json).toEqual({
        name: 'RateLimitedError',
        code: 'E_RATE_LIMITED',
        message: 'custom msg',
        retryable: true,
        healable: false,
        retryAfterMs: 120000,
        context: { endpoint: '/api/v1/chat', model: 'groq-4' },
        cause: null,
      });
    });

    it('should handle non-Error cause in toJSON gracefully', () => {
      const err = new TransientError('test', { cause: null });
      expect(err.toJSON().cause).toBeNull();
    });
  });

  describe('timestamp monotonicity', () => {
    it('errors created in sequence should have non-decreasing timestamps', () => {
      const err1 = new TransientError('first');
      const err2 = new FatalError('second');
      const err3 = new HealableError('third');

      expect(err2.timestamp).toBeGreaterThanOrEqual(err1.timestamp);
      expect(err3.timestamp).toBeGreaterThanOrEqual(err2.timestamp);
    });
  });

  describe('context reference', () => {
    it('context should be the same object reference passed in', () => {
      const ctx = { key: 'value' };
      const err = new ConfigError('test', { context: ctx });
      expect(err.context).toBe(ctx);
    });

    it('should default to empty object when no context provided', () => {
      const err = new ConfigError('test');
      expect(err.context).toEqual({});
    });
  });

  describe('classifyError edge cases', () => {
    it('should classify "too many requests" (exact match)', () => {
      const err = new Error('too many requests');
      const classified = classifyError(err);
      expect(classified).toBeInstanceOf(RateLimitedError);
    });

    it('should NOT classify uppercase "TOO MANY REQUESTS" (classifyError is case-sensitive)', () => {
      const err = new Error('TOO MANY REQUESTS');
      const classified = classifyError(err);
      // classifyError uses message.includes('too many requests') — case sensitive
      expect(classified).toBeInstanceOf(TransientError);
      expect(classified.code).toBe(ERROR_CODES.UNKNOWN);
    });

    it('should classify "fetch failed" errors', () => {
      const err = new Error('fetch failed: network error');
      const classified = classifyError(err);
      expect(classified).toBeInstanceOf(NetworkTimeoutError);
    });

    it('should classify "ENOTFOUND" errors', () => {
      const err = new Error('ENOTFOUND api.example.com');
      const classified = classifyError(err);
      expect(classified).toBeInstanceOf(NetworkTimeoutError);
    });

    it('should classify errors with "target closed" in browser context', () => {
      const err = new Error('Browser target closed');
      const classified = classifyError(err);
      expect(classified).toBeInstanceOf(BrowserDisconnectedError);
    });

    it('should classify errors with "disconnected" in browser context', () => {
      const err = new Error('browser disconnected');
      const classified = classifyError(err);
      expect(classified).toBeInstanceOf(BrowserDisconnectedError);
    });

    it('should default to TransientError with UNKNOWN code for unrecognized errors', () => {
      const err = new Error('completely unrecognizable error');
      const classified = classifyError(err);
      expect(classified).toBeInstanceOf(TransientError);
      expect(classified.code).toBe(ERROR_CODES.UNKNOWN);
      expect(classified.cause).toBe(err);
    });

    it('should handle number input to classifyError', () => {
      const classified = classifyError(42);
      expect(classified).toBeInstanceOf(TransientError);
      expect(classified.message).toBe('42');
    });

    it('should handle undefined input to classifyError', () => {
      const classified = classifyError(undefined);
      expect(classified).toBeInstanceOf(TransientError);
      expect(classified.message).toBe('undefined');
    });

    it('should set cause correctly when wrapping errors', () => {
      const original = new TypeError('type error');
      const classified = classifyError(original);
      expect(classified.cause).toBe(original);
    });
  });

  describe('ProviderPermanentError', () => {
    it('should include provider in context and message', () => {
      const err = new ProviderPermanentError('gemini', 'model deprecated');
      expect(err.message).toContain('gemini');
      expect(err.context.provider).toBe('gemini');
      expect(err.healable).toBe(true);
      expect(err.retryable).toBe(false);
    });
  });

  describe('EncryptionFailureError', () => {
    it('should be fatal and not retryable', () => {
      const err = new EncryptionFailureError();
      expect(err.code).toBe(ERROR_CODES.ENCRYPTION_FAILURE);
      expect(err.retryable).toBe(false);
      expect(err.healable).toBe(false);
    });
  });

  describe('DatabaseCorruptError', () => {
    it('should be fatal', () => {
      const err = new DatabaseCorruptError('WAL corrupted');
      expect(err.code).toBe(ERROR_CODES.DATABASE_CORRUPT);
      expect(err.message).toBe('WAL corrupted');
    });
  });

  describe('StateError', () => {
    it('should have state error code', () => {
      const err = new StateError('invalid transition');
      expect(err.code).toBe(ERROR_CODES.STATE_ERROR);
    });
  });

  describe('SandboxError', () => {
    it('should have sandbox error code', () => {
      const err = new SandboxError('escape attempt');
      expect(err.code).toBe(ERROR_CODES.SANDBOX_ERROR);
    });
  });

  describe('ValidationError', () => {
    it('should have validation error code', () => {
      const err = new ValidationError('missing field');
      expect(err.code).toBe(ERROR_CODES.VALIDATION_ERROR);
    });
  });

  describe('UIChangedError', () => {
    it('should be healable', () => {
      const err = new UIChangedError();
      expect(err.code).toBe(ERROR_CODES.UI_CHANGED);
      expect(err.healable).toBe(true);
    });
  });

  describe('PatchFailedError', () => {
    it('should be healable', () => {
      const err = new PatchFailedError('patch did not resolve');
      expect(err.code).toBe(ERROR_CODES.PATCH_FAILED);
      expect(err.healable).toBe(true);
    });
  });

  describe('AuthenticationError retryable override', () => {
    it('should allow overriding retryable to false', () => {
      const err = new AuthenticationError('bad token', { retryable: false });
      expect(err.retryable).toBe(false);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 2. DI CONTAINER — Advanced Scenarios
// ═══════════════════════════════════════════════════════════

describe('DIContainer: Advanced', () => {
  let c: DIContainer;

  beforeEach(() => {
    c = new DIContainer('advanced-test');
  });

  describe('deferred lifecycle', () => {
    it('should not create instance until first get() call', () => {
      let callCount = 0;
      c.register('lazy', {
        factory: () => { callCount++; return { id: callCount }; },
        lifecycle: LIFECYCLE.DEFERRED,
      });

      expect(callCount).toBe(0);
      expect(c.getStatus('lazy')).toBe(STATUS.PENDING);

      const instance = c.get('lazy') as { id: number };
      expect(callCount).toBe(1);
      expect(instance.id).toBe(1);

      // Second get should return cached instance
      const instance2 = c.get('lazy') as { id: number };
      expect(callCount).toBe(1); // Not called again
      expect(instance2.id).toBe(1);
    });
  });

  describe('resetAll', () => {
    it('should reset all instances and statuses to pending', () => {
      c.register('a', { factory: () => 1 });
      c.register('b', { factory: () => 2 });
      c.get('a');
      c.get('b');

      expect(c.getStatus('a')).toBe(STATUS.READY);
      expect(c.getStatus('b')).toBe(STATUS.READY);

      c.resetAll();

      expect(c.getStatus('a')).toBe(STATUS.PENDING);
      expect(c.getStatus('b')).toBe(STATUS.PENDING);
      expect(c.getRegisteredNames()).toEqual(['a', 'b']); // registrations preserved
    });

    it('should clear error state on resetAll', () => {
      c.register('bad', {
        factory: () => { throw new Error('fail'); },
        critical: false,
      });
      c.get('bad', { required: false });
      expect(c.getError('bad')).not.toBeNull();

      c.resetAll();
      expect(c.getError('bad')).toBeNull();
      expect(c.getStatus('bad')).toBe(STATUS.PENDING);
    });
  });

  describe('getError', () => {
    it('should return the error for a failed module', () => {
      c.register('failing', {
        factory: () => { throw new Error('specific error'); },
        critical: false,
      });
      c.get('failing', { required: false });

      const err = c.getError('failing');
      expect(err).not.toBeNull();
      expect(err!.message).toBe('specific error');
    });

    it('should return null for non-failed module', () => {
      c.register('good', { factory: () => 1 });
      c.get('good');
      expect(c.getError('good')).toBeNull();
    });

    it('should return null for unregistered module', () => {
      expect(c.getError('nonexistent')).toBeNull();
    });
  });

  describe('getInitOrder', () => {
    it('should return the order modules were initialized', () => {
      c.register('first', { factory: () => 1 });
      c.register('second', { factory: () => 2 });
      c.register('third', { factory: () => 3 });

      c.get('third');
      c.get('first');
      c.get('second');

      expect(c.getInitOrder()).toEqual(['third', 'first', 'second']);
    });

    it('should be empty before any get() calls', () => {
      c.register('a', { factory: () => 1 });
      expect(c.getInitOrder()).toEqual([]);
    });
  });

  describe('multi-level dependency chains', () => {
    it('should resolve A → B → C chain', () => {
      c.register('c', { factory: () => ({ value: 42 }) });
      c.register('b', {
        factory: (deps) => ({ cValue: (deps.c as { value: number }).value }),
        deps: ['c'],
      });
      c.register('a', {
        factory: (deps) => ({ bCValue: (deps.b as { cValue: number }).cValue }),
        deps: ['b'],
      });

      const a = c.get('a') as { bCValue: number };
      expect(a.bCValue).toBe(42);
    });

    it('should handle diamond dependency (A → B, A → C, B → D, C → D)', () => {
      let dCallCount = 0;
      c.register('d', {
        factory: () => { dCallCount++; return { id: 'd' }; },
        lifecycle: LIFECYCLE.SINGLETON,
      });
      c.register('b', {
        factory: (deps) => ({ d: deps.d }),
        deps: ['d'],
      });
      c.register('cc', {
        factory: (deps) => ({ d: deps.d }),
        deps: ['d'],
      });
      c.register('a', {
        factory: (deps) => ({ b: deps.b, cc: deps.cc }),
        deps: ['b', 'cc'],
      });

      const a = c.get('a') as { b: { d: unknown }; cc: { d: unknown } };
      expect(dCallCount).toBe(1); // D should only be created once
      expect(a.b.d).toBe(a.cc.d); // Same instance
    });
  });

  describe('getRegisteredNames', () => {
    it('should return all registered module names', () => {
      c.register('alpha', { factory: () => 1 });
      c.register('beta', { factory: () => 2 });
      c.register('gamma', { factory: () => 3 });

      const names = c.getRegisteredNames();
      expect(names).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('should return empty array for empty container', () => {
      expect(c.getRegisteredNames()).toEqual([]);
    });
  });

  describe('getStatus for unregistered modules', () => {
    it('should return PENDING for unregistered module', () => {
      expect(c.getStatus('nonexistent')).toBe(STATUS.PENDING);
    });
  });

  describe('registerInstance with options', () => {
    it('should register instance with tags', () => {
      const instance = { name: 'premade' };
      c.registerInstance('mod', instance, { tags: ['core', 'cached'] });

      expect(c.get('mod')).toBe(instance);
      expect(c.getByTag('core')).toContain('mod');
      expect(c.getByTag('cached')).toContain('mod');
      expect(c.has('mod')).toBe(true);
    });

    it('should register instance as non-critical', () => {
      const instance = { val: 1 };
      c.registerInstance('mod', instance, { critical: false });
      expect(c.has('mod')).toBe(true);

      const statuses = c.getAllStatuses();
      const modStatus = statuses.find(s => s.name === 'mod');
      expect(modStatus!.critical).toBe(false);
    });
  });

  describe('summary edge cases', () => {
    it('should handle empty container', () => {
      const summary = c.getSummary();
      expect(summary.containerName).toBe('advanced-test');
      expect(summary.total).toBe(0);
      expect(summary.ready).toBe(0);
      expect(summary.failed).toBe(0);
      expect(summary.skipped).toBe(0);
      expect(summary.pending).toBe(0);
      expect(summary.criticalFailed).toEqual([]);
      expect(summary.modules).toEqual([]);
    });

    it('should count pending modules', () => {
      c.register('a', { factory: () => 1 });
      c.register('b', { factory: () => 2 });
      // Don't call get() — they stay pending

      const summary = c.getSummary();
      expect(summary.pending).toBe(2);
    });
  });

  describe('factory receives container as second argument', () => {
    it('should pass the container instance to factory', () => {
      c.register('base', { factory: () => ({ val: 99 }) });
      c.register('dependent', {
        factory: (_deps, container) => {
          // Verify container is passed
          expect(container).toBe(c);
          return { fromContainer: (container as DIContainer).get('base') };
        },
        deps: ['base'],
      });

      const dep = c.get('dependent') as { fromContainer: { val: number } };
      expect(dep.fromContainer.val).toBe(99);
    });
  });

  describe('circular dependency in multi-module chain', () => {
    it('should detect A → B → C → A circular dependency', () => {
      c.register('a', { factory: () => 1, deps: ['b'] });
      c.register('b', { factory: () => 2, deps: ['c'] });
      c.register('c', { factory: () => 3, deps: ['a'] });

      expect(() => c.get('a')).toThrow('Circular dependency');
    });
  });

  describe('non-critical module with failed dependency that is non-critical', () => {
    it('should skip the child and the parent, not throw', () => {
      c.register('dep', {
        factory: () => { throw new Error('dep err'); },
        critical: false,
      });
      c.register('child', {
        factory: () => ({ ok: true }),
        deps: ['dep'],
        critical: false,
      });

      const result = c.get('child', { required: false });
      expect(result).toBeNull();
      expect(c.getStatus('dep')).toBe(STATUS.SKIPPED);
      expect(c.getStatus('child')).toBe(STATUS.SKIPPED);
    });
  });

  describe('reset then re-get', () => {
    it('should allow resetting a single module and getting it again', () => {
      let count = 0;
      c.register('mod', { factory: () => ++count });
      c.get('mod');
      expect(count).toBe(1);

      c.reset('mod');
      expect(c.getStatus('mod')).toBe(STATUS.PENDING);

      c.get('mod');
      expect(count).toBe(2);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 3. MESSAGE PROTOCOL — Advanced Scenarios
// ═══════════════════════════════════════════════════════════

describe('Message Protocol: Advanced', () => {
  describe('WorkerMessage type compliance', () => {
    it('createRequest should produce valid WorkerMessage', () => {
      const msg = createRequest('test.method', { key: 'val' });
      const msgAsWorkerMessage: WorkerMessage = msg;

      expect(msgAsWorkerMessage.type).toBe(MSG_TYPE.REQUEST);
      expect(msgAsWorkerMessage.method).toBe('test.method');
      expect(msgAsWorkerMessage.id).toBeDefined();
      expect(msgAsWorkerMessage.payload).toBeDefined();
    });

    it('createReply with error should produce valid WorkerMessage', () => {
      const msg = createReply('id-1', undefined, {
        code: WORKER_ERROR.TIMEOUT,
        message: 'timed out',
      });

      expect(msg.type).toBe(MSG_TYPE.REPLY);
      expect(msg.error).toBeDefined();
      expect(msg.error!.code).toBe(WORKER_ERROR.TIMEOUT);
    });
  });

  describe('nextCorrelationId uniqueness under concurrency simulation', () => {
    it('should produce 1000 unique IDs', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 1000; i++) {
        ids.add(nextCorrelationId());
      }
      expect(ids.size).toBe(1000);
    });
  });

  describe('frozen constants immutability', () => {
    it('MSG_TYPE should reject property assignment', () => {
      expect(() => {
        (MSG_TYPE as Record<string, unknown>).NEW_TYPE = 'new';
      }).toThrow();
    });

    it('WORKER_CMD should reject property assignment', () => {
      expect(() => {
        (WORKER_CMD as Record<string, unknown>).RESTART = 'restart';
      }).toThrow();
    });

    it('METHOD should reject property assignment', () => {
      expect(() => {
        (METHOD as Record<string, unknown>).NEW_METHOD = 'foo.bar';
      }).toThrow();
    });

    it('WORKER_ERROR should reject property assignment', () => {
      expect(() => {
        (WORKER_ERROR as Record<string, unknown>).CUSTOM = 'CUSTOM';
      }).toThrow();
    });
  });

  describe('createCast edge cases', () => {
    it('should handle undefined payload', () => {
      const msg = createCast('init', undefined as unknown as Record<string, unknown>);
      expect(msg.payload).toEqual({});
    });
  });

  describe('createEvent timestamp accuracy', () => {
    it('should have timestamp within 100ms of creation', () => {
      const before = Date.now();
      const msg = createEvent('log.info');
      const after = Date.now();

      expect(msg.timestamp).toBeGreaterThanOrEqual(before);
      expect(msg.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('method constant coverage', () => {
    it('should have all diary methods defined', () => {
      const diaryMethods = [
        METHOD.DIARY_LOG_ENTRY,
        METHOD.DIARY_LOG_ACTION,
        METHOD.DIARY_LOG_DECISION,
        METHOD.DIARY_LOG_ERROR,
        METHOD.DIARY_LOG_STATE_TRANS,
        METHOD.DIARY_LOG_METRIC,
        METHOD.DIARY_GET_TODAY,
        METHOD.DIARY_GET_SUMMARY,
      ];

      for (const method of diaryMethods) {
        expect(method).toBeDefined();
        expect(typeof method).toBe('string');
        expect(method.length).toBeGreaterThan(0);
      }
    });

    it('should have all reward tracker methods defined', () => {
      const rtMethods = [
        METHOD.RT_RECORD_PATCH_GEN,
        METHOD.RT_RECORD_STAGING,
        METHOD.RT_RECORD_PROD_SURVIVAL,
        METHOD.RT_RECORD_HEAL_DURATION,
        METHOD.RT_GET_BEST_LINEUP,
        METHOD.RT_GENERATE_REPORT,
        METHOD.RT_GET_STATS,
      ];

      for (const method of rtMethods) {
        expect(method).toBeDefined();
        expect(typeof method).toBe('string');
      }
    });
  });

  describe('message type completeness', () => {
    it('all constant groups should be non-empty', () => {
      expect(Object.keys(MSG_TYPE).length).toBeGreaterThan(0);
      expect(Object.keys(WORKER_CMD).length).toBeGreaterThan(0);
      expect(Object.keys(METHOD).length).toBeGreaterThan(0);
      expect(Object.keys(WORKER_ERROR).length).toBeGreaterThan(0);
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 4. CROSS-MODULE INTEGRATION
// ═══════════════════════════════════════════════════════════

describe('Cross-Module Integration', () => {
  describe('Error codes are unique across all categories', () => {
    it('ERROR_CODES values should all be unique', () => {
      const values = Object.values(ERROR_CODES);
      const unique = new Set(values);
      expect(unique.size).toBe(values.length);
    });

    it('WORKER_ERROR values should not collide with ERROR_CODES', () => {
      const errorCodes = new Set(Object.values(ERROR_CODES));
      for (const workerErr of Object.values(WORKER_ERROR)) {
        expect(errorCodes.has(workerErr)).toBe(false);
      }
    });
  });

  describe('Container can store error instances', () => {
    it('should be able to register and retrieve error instances', () => {
      const container = new DIContainer('error-test');
      const err = new SelectorDriftError('button#submit moved');

      container.registerInstance('lastError', err, { critical: false });
      const retrieved = container.get('lastError') as SelectorDriftError;

      expect(retrieved).toBe(err);
      expect(retrieved).toBeInstanceOf(SelectorDriftError);
      expect(retrieved.healable).toBe(true);
      expect(retrieved.code).toBe(ERROR_CODES.SELECTOR_DRIFT);
    });
  });

  describe('Error serialization round-trip through container', () => {
    it('should preserve error data when stored and retrieved via container', () => {
      const container = new DIContainer('roundtrip');
      const err = new RateLimitedError('API limit hit', {
        retryAfterMs: 30000,
        context: { service: 'groq', endpoint: '/chat' },
      });

      container.registerInstance('rateLimitErr', err);
      const retrieved = container.get('rateLimitErr') as RateLimitedError;
      const json = retrieved.toJSON();

      expect(json.code).toBe('E_RATE_LIMITED');
      expect(json.retryAfterMs).toBe(30000);
      expect(json.context.service).toBe('groq');
    });
  });
});

// ═══════════════════════════════════════════════════════════
// 5. TYPE SAFETY VERIFICATION (compile-time checked via tsc)
// ═══════════════════════════════════════════════════════════

describe('Type Safety: Runtime Verification', () => {
  it('ERROR_CODES should be a readonly record', () => {
    // Runtime check that the object is frozen
    expect(Object.isFrozen(ERROR_CODES)).toBe(true);
  });

  it('MathUBotError code property is a public readonly field (compile-time)', () => {
    const err = new NetworkTimeoutError('test');
    // TypeScript 'readonly' is compile-time only — verify the value is correct
    expect(typeof err.code).toBe('string');
    expect(err.code).toBe(ERROR_CODES.NETWORK_TIMEOUT);
  });

  it('SerializedError interface should match toJSON output shape', () => {
    const err = new ConfigError('test', { context: { key: 'val' } });
    const json = err.toJSON();

    // Verify all SerializedError fields exist
    expect(json).toHaveProperty('name');
    expect(json).toHaveProperty('code');
    expect(json).toHaveProperty('message');
    expect(json).toHaveProperty('retryable');
    expect(json).toHaveProperty('healable');
    expect(json).toHaveProperty('retryAfterMs');
    expect(json).toHaveProperty('context');
    expect(json).toHaveProperty('cause');
  });

  it('ContainerGetOptions should accept required: false', () => {
    const container = new DIContainer('type-test');
    container.register('mod', { factory: () => 1, critical: false });

    // This should not throw - tests that the API accepts the options shape
    const result = container.get('mod', { required: false });
    expect(result).toEqual(1);
  });
});