const { describe, it, expect } = require('vitest');
const { MSG_TYPE, WORKER_CMD, METHOD, WORKER_ERROR,
  nextCorrelationId,
  createRequest, createReply, createCast, createEvent, } = require('./workers-message-protocol');

// ─── Constants ───

describe('Message Protocol Constants', () => {
  it('MSG_TYPE should have exactly 4 frozen types', () => {
    expect(Object.keys(MSG_TYPE)).toHaveLength(4);
    expect(Object.isFrozen(MSG_TYPE)).toBe(true);
    expect(MSG_TYPE.REQUEST).toBe('request');
    expect(MSG_TYPE.REPLY).toBe('reply');
    expect(MSG_TYPE.CAST).toBe('cast');
    expect(MSG_TYPE.EVENT).toBe('event');
  });

  it('WORKER_CMD should have lifecycle commands', () => {
    expect(WORKER_CMD.INIT).toBe('init');
    expect(WORKER_CMD.START).toBe('start');
    expect(WORKER_CMD.STOP).toBe('stop');
    expect(WORKER_CMD.SHUTDOWN).toBe('shutdown');
    expect(WORKER_CMD.HEALTH).toBe('health');
    expect(Object.isFrozen(WORKER_CMD)).toBe(true);
  });

  it('METHOD should have metrics methods', () => {
    expect(METHOD.METRICS_INCREMENT).toBe('metrics.increment');
    expect(METHOD.METRICS_HISTOGRAM).toBe('metrics.recordHistogram');
    expect(METHOD.METRICS_GAUGE).toBe('metrics.setGauge');
    expect(METHOD.METRICS_GET_SUMMARY).toBe('metrics.getSummary');
  });

  it('METHOD should have diary methods', () => {
    expect(METHOD.DIARY_LOG_ENTRY).toBe('diary.logEntry');
    expect(METHOD.DIARY_LOG_ACTION).toBe('diary.logAction');
    expect(METHOD.DIARY_LOG_DECISION).toBe('diary.logDecision');
    expect(METHOD.DIARY_LOG_ERROR).toBe('diary.logError');
    expect(METHOD.DIARY_LOG_STATE_TRANS).toBe('diary.logStateTransition');
    expect(METHOD.DIARY_LOG_METRIC).toBe('diary.logMetric');
    expect(METHOD.DIARY_GET_TODAY).toBe('diary.getTodayEntries');
    expect(METHOD.DIARY_GET_SUMMARY).toBe('diary.getSummary');
  });

  it('METHOD should have reward tracker methods', () => {
    expect(METHOD.RT_RECORD_PATCH_GEN).toBe('rewardTracker.recordPatchGeneration');
    expect(METHOD.RT_RECORD_STAGING).toBe('rewardTracker.recordStagingResult');
    expect(METHOD.RT_RECORD_PROD_SURVIVAL).toBe('rewardTracker.recordProdSurvival');
    expect(METHOD.RT_RECORD_HEAL_DURATION).toBe('rewardTracker.recordHealDuration');
    expect(METHOD.RT_GET_BEST_LINEUP).toBe('rewardTracker.getBestCodegenLineup');
    expect(METHOD.RT_GENERATE_REPORT).toBe('rewardTracker.generateReport');
    expect(METHOD.RT_GET_STATS).toBe('rewardTracker.getStats');
  });

  it('METHOD should have system methods', () => {
    expect(METHOD.SYS_LOG).toBe('system.log');
    expect(METHOD.SYS_READY).toBe('system.ready');
    expect(METHOD.SYS_ERROR).toBe('system.error');
    expect(Object.isFrozen(METHOD)).toBe(true);
  });

  it('WORKER_ERROR should define error codes', () => {
    expect(WORKER_ERROR.NOT_READY).toBe('WORKER_NOT_READY');
    expect(WORKER_ERROR.UNKNOWN_METHOD).toBe('UNKNOWN_METHOD');
    expect(WORKER_ERROR.INVALID_PAYLOAD).toBe('INVALID_PAYLOAD');
    expect(WORKER_ERROR.TIMEOUT).toBe('REQUEST_TIMEOUT');
    expect(WORKER_ERROR.SHUTTING_DOWN).toBe('WORKER_SHUTTING_DOWN');
    expect(WORKER_ERROR.INIT_FAILED).toBe('WORKER_INIT_FAILED');
    expect(Object.isFrozen(WORKER_ERROR)).toBe(true);
  });

  it('METHOD should have unique values (no collisions)', () => {
    const values = Object.values(METHOD);
    const unique = new Set(values);
    expect(unique.size).toBe(values.length);
  });
});

// ─── Correlation ID ───

describe('nextCorrelationId', () => {
  it('should return a string with msg_ prefix', () => {
    const id = nextCorrelationId();
    expect(typeof id).toBe('string');
    expect(id.startsWith('msg_')).toBe(true);
  });

  it('should return unique IDs on consecutive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, () => nextCorrelationId()));
    expect(ids.size).toBe(100);
  });

  it('should contain PID and timestamp components', () => {
    const id = nextCorrelationId();
    const parts = id.split('_');
    expect(parts.length).toBe(4);
    expect(parseInt(parts[1], 10)).toBe(process.pid);
    expect(parseInt(parts[2], 10)).toBeGreaterThan(0);
    expect(parseInt(parts[3], 10)).toBeGreaterThan(0);
  });
});

// ─── Message Factories ───

describe('createRequest', () => {
  it('should create a request message with auto-generated ID', () => {
    const msg = createRequest('test.method', { key: 'value' });
    expect(msg.type).toBe(MSG_TYPE.REQUEST);
    expect(msg.method).toBe('test.method');
    expect(msg.id).toBeDefined();
    expect(msg.payload).toEqual({ key: 'value' });
  });

  it('should accept a custom ID', () => {
    const msg = createRequest('foo', {}, 'custom-id-123');
    expect(msg.id).toBe('custom-id-123');
  });

  it('should default payload to empty object when undefined', () => {
    const msg = createRequest('bar');
    expect(msg.payload).toEqual({});
  });

  it('should default payload to empty object when null', () => {
    const msg = createRequest('bar', null);
    expect(msg.payload).toEqual({});
  });
});

describe('createReply', () => {
  it('should create a success reply with payload', () => {
    const msg = createReply('req-123', { result: 'ok' });
    expect(msg.type).toBe(MSG_TYPE.REPLY);
    expect(msg.id).toBe('req-123');
    expect(msg.method).toBeUndefined();
    expect(msg.payload).toEqual({ result: 'ok' });
    expect(msg.error).toBeUndefined();
  });

  it('should create an error reply', () => {
    const msg = createReply('req-456', undefined, {
      code: 'METHOD_ERROR',
      message: 'Something went wrong',
    });
    expect(msg.type).toBe(MSG_TYPE.REPLY);
    expect(msg.error).toEqual({
      code: 'METHOD_ERROR',
      message: 'Something went wrong',
    });
    expect(msg.payload).toBeUndefined();
  });

  it('should handle null error as success reply', () => {
    const msg = createReply('req-789', { data: 42 }, null);
    expect(msg.error).toBeUndefined();
    expect(msg.payload).toEqual({ data: 42 });
  });

  it('should default error code to UNKNOWN when missing', () => {
    const msg = createReply('req-1', undefined, { message: 'err' });
    expect(msg.error.code).toBe('UNKNOWN');
  });
});

describe('createCast', () => {
  it('should create a fire-and-forget message without ID', () => {
    const msg = createCast('init', { key: 'val' });
    expect(msg.type).toBe(MSG_TYPE.CAST);
    expect(msg.method).toBe('init');
    expect(msg.payload).toEqual({ key: 'val' });
    expect(msg.id).toBeUndefined();
  });

  it('should default payload to empty object', () => {
    const msg = createCast('shutdown');
    expect(msg.payload).toEqual({});
  });
});

describe('createEvent', () => {
  it('should create an event message with timestamp', () => {
    const before = Date.now();
    const msg = createEvent('system.ready', { name: 'metrics' });
    const after = Date.now();

    expect(msg.type).toBe(MSG_TYPE.EVENT);
    expect(msg.method).toBe('system.ready');
    expect(msg.payload).toEqual({ name: 'metrics' });
    expect(msg.timestamp).toBeGreaterThanOrEqual(before);
    expect(msg.timestamp).toBeLessThanOrEqual(after);
  });

  it('should not have an ID or error', () => {
    const msg = createEvent('log');
    expect(msg.id).toBeUndefined();
    expect(msg.error).toBeUndefined();
  });
});

// ─── Message Shape Contract ───

describe('Message shape contracts', () => {
  it('all messages should have a type field', () => {
    const req = createRequest('m');
    const rep = createReply('id', {});
    const cast = createCast('m');
    const evt = createEvent('m');

    for (const msg of [req, rep, cast, evt]) {
      expect(msg).toHaveProperty('type');
      expect(typeof msg.type).toBe('string');
      expect(msg.type.length).toBeGreaterThan(0);
    }
  });

  it('request/cast/event messages should have a method field', () => {
    const req = createRequest('m');
    const cast = createCast('m');
    const evt = createEvent('m');

    for (const msg of [req, cast, evt]) {
      expect(msg).toHaveProperty('method');
      expect(typeof msg.method).toBe('string');
    }
    // Replies do not carry a method field — they are matched by correlation id
    const rep = createReply('id', {});
    expect(rep.method).toBeUndefined();
  });
});