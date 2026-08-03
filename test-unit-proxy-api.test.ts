const { describe, it, expect } = require('vitest');
const { createMetricsProxy } = require('./workers-proxy-metrics-proxy');
// [type-only import removed at runtime] import type { MetricsProxy } from './workers-proxy-metrics-proxy.ts';
const { createDiaryProxy } = require('./workers-proxy-diary-proxy');
// [type-only import removed at runtime] import type { DiaryProxy } from './workers-proxy-diary-proxy.ts';
const { createRewardTrackerProxy } = require('./workers-proxy-reward-tracker-proxy');
// [type-only import removed at runtime] import type { RewardTrackerProxy } from './workers-proxy-reward-tracker-proxy.ts';

// ─── Metrics Proxy Tests ───

describe('Metrics Proxy API', () => {
  it('should create a proxy with correct API shape', () => {
    const proxy: MetricsProxy = createMetricsProxy('test-metrics');
    expect(proxy).toHaveProperty('increment');
    expect(proxy).toHaveProperty('recordHistogram');
    expect(proxy).toHaveProperty('setGauge');
    expect(proxy).toHaveProperty('getSummary');
    expect(typeof proxy.increment).toBe('function');
    expect(typeof proxy.recordHistogram).toBe('function');
    expect(typeof proxy.setGauge).toBe('function');
    expect(typeof proxy.getSummary).toBe('function');
  });

  it('increment should not throw (fire-and-forget to non-existent worker)', () => {
    const proxy = createMetricsProxy('nonexistent');
    expect(() => proxy.increment('clicks')).not.toThrow();
    expect(() => proxy.increment('clicks', 5, { page: 'home' })).not.toThrow();
  });

  it('recordHistogram should not throw (fire-and-forget)', () => {
    const proxy = createMetricsProxy('nonexistent');
    expect(() => proxy.recordHistogram('duration_ms', 250)).not.toThrow();
  });

  it('setGauge should not throw (fire-and-forget)', () => {
    const proxy = createMetricsProxy('nonexistent');
    expect(() => proxy.setGauge('memory_mb', 512)).not.toThrow();
  });

  it('getSummary should reject (no worker available)', async () => {
    const proxy = createMetricsProxy('nonexistent');
    await expect(proxy.getSummary()).rejects.toThrow();
  });

  it('should default worker name to "metrics"', () => {
    const proxy = createMetricsProxy();
    expect(typeof proxy.increment).toBe('function');
  });
});

// ─── Diary Proxy Tests ───

describe('Diary Proxy API', () => {
  it('should create a proxy with full diary API shape', () => {
    const proxy: DiaryProxy = createDiaryProxy('diary');
    expect(proxy).toHaveProperty('logEntry');
    expect(proxy).toHaveProperty('logAction');
    expect(proxy).toHaveProperty('logDecision');
    expect(proxy).toHaveProperty('logError');
    expect(proxy).toHaveProperty('logStateTransition');
    expect(proxy).toHaveProperty('logMetric');
    expect(proxy).toHaveProperty('getTodayEntries');
    expect(proxy).toHaveProperty('getSummary');
    expect(proxy).toHaveProperty('start');
  });

  it('all fire-and-forget methods should not throw', () => {
    const proxy = createDiaryProxy('nonexistent');
    expect(() => proxy.logEntry('action', 'Clicked login', { page: 'home' })).not.toThrow();
    expect(() => proxy.logAction('login', 'idle', true, 'reason')).not.toThrow();
    expect(() => proxy.logDecision('use-gpt4', { confidence: 0.9 })).not.toThrow();
    expect(() => proxy.logError(new Error('test'), { ctx: 'test' })).not.toThrow();
    expect(() => proxy.logStateTransition('idle', 'working', 'task start')).not.toThrow();
    expect(() => proxy.logMetric('memory', 512, 'MB')).not.toThrow();
  });

  it('start should be a no-op', () => {
    const proxy = createDiaryProxy('nonexistent');
    expect(() => proxy.start()).not.toThrow();
  });

  it('read methods should reject (no worker available)', async () => {
    const proxy = createDiaryProxy('nonexistent');
    await expect(proxy.getTodayEntries()).rejects.toThrow();
    await expect(proxy.getSummary()).rejects.toThrow();
  });
});

// ─── Reward Tracker Proxy Tests ───

describe('Reward Tracker Proxy API', () => {
  it('should create a proxy with full reward tracker API shape', () => {
    const proxy: RewardTrackerProxy = createRewardTrackerProxy('rt');
    expect(proxy).toHaveProperty('recordPatchGeneration');
    expect(proxy).toHaveProperty('recordStagingResult');
    expect(proxy).toHaveProperty('recordProdSurvival');
    expect(proxy).toHaveProperty('recordHealDuration');
    expect(proxy).toHaveProperty('getBestCodegenLineup');
    expect(proxy).toHaveProperty('generateReport');
    expect(proxy).toHaveProperty('getStats');
    expect(proxy).toHaveProperty('startProdSurvivalCheck');
    expect(proxy).toHaveProperty('stop');
  });

  it('all fire-and-forget methods should not throw', () => {
    const proxy = createRewardTrackerProxy('nonexistent');
    expect(() => proxy.recordPatchGeneration('gpt-4', 'patch-001')).not.toThrow();
    expect(() => proxy.recordStagingResult('deepseek', 'patch-002', true)).not.toThrow();
    expect(() => proxy.recordProdSurvival('mistral', 'patch-003', false)).not.toThrow();
    expect(() => proxy.recordHealDuration('qwen', 'patch-004', 4500)).not.toThrow();
  });

  it('no-op methods should not throw', () => {
    const proxy = createRewardTrackerProxy('nonexistent');
    expect(() => proxy.startProdSurvivalCheck()).not.toThrow();
    expect(() => proxy.stop()).not.toThrow();
  });

  it('read methods should reject (no worker available)', async () => {
    const proxy = createRewardTrackerProxy('nonexistent');
    await expect(proxy.getBestCodegenLineup()).rejects.toThrow();
    await expect(proxy.generateReport()).rejects.toThrow();
    await expect(proxy.getStats()).rejects.toThrow();
  });

  it('getBestCodegenLineup should accept count parameter', async () => {
    const proxy = createRewardTrackerProxy('nonexistent');
    await expect(proxy.getBestCodegenLineup(10)).rejects.toThrow();
  });
});