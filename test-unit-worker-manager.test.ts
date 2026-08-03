const { describe, it, expect, beforeEach, afterEach } = require('vitest');
const { WorkerManager,
  workerManager,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_HEALTH_INTERVAL_MS,
  MAX_RESTARTS,
  RESTART_WINDOW_MS, } = require('./workers-worker-manager');
// [type-only import removed at runtime] import type { WorkerStatusEntry, SpawnOptions } from './workers-worker-manager.ts';

describe('WorkerManager Constants', () => {
  it('should export DEFAULT_REQUEST_TIMEOUT_MS = 5000', () => {
    expect(DEFAULT_REQUEST_TIMEOUT_MS).toBe(5000);
  });

  it('should export DEFAULT_HEALTH_INTERVAL_MS = 30000', () => {
    expect(DEFAULT_HEALTH_INTERVAL_MS).toBe(30000);
  });

  it('should export MAX_RESTARTS = 3', () => {
    expect(MAX_RESTARTS).toBe(3);
  });

  it('should export RESTART_WINDOW_MS = 300000 (5 min)', () => {
    expect(RESTART_WINDOW_MS).toBe(5 * 60 * 1000);
  });
});

describe('WorkerManager', () => {
  let mgr: WorkerManager;

  beforeEach(() => {
    mgr = new WorkerManager();
  });

  it('should construct without error', () => {
    expect(mgr).toBeDefined();
  });

  it('should return empty statuses initially', () => {
    const statuses: WorkerStatusEntry[] = mgr.getStatuses();
    expect(Array.isArray(statuses)).toBe(true);
    expect(statuses).toHaveLength(0);
  });

  it('isReady should return false for non-existent worker', () => {
    expect(mgr.isReady('nonexistent')).toBe(false);
  });

  it('cast to non-existent worker should be a no-op (no throw)', () => {
    expect(() => mgr.cast('nonexistent', 'some.method', {})).not.toThrow();
  });

  it('request to non-existent worker should throw', async () => {
    await expect(mgr.request('nonexistent', 'some.method'))
      .rejects.toThrow('No worker "nonexistent"');
  });

  it('shutdownAll on empty manager should resolve', async () => {
    await expect(mgr.shutdownAll()).resolves.toBeUndefined();
  });

  it('shutdownWorker for non-existent worker should resolve', async () => {
    await expect(mgr.shutdownWorker('nonexistent')).resolves.toBeUndefined();
  });

  it('onEvent should register handler without error', () => {
    expect(() => {
      mgr.onEvent('metrics', 'system.ready', () => {});
    }).not.toThrow();
  });

  it('getStatuses should return correct shape for empty manager', () => {
    expect(mgr.getStatuses()).toEqual([]);
  });
});

describe('WorkerManager singleton', () => {
  it('should export a singleton workerManager instance', () => {
    expect(workerManager).toBeDefined();
    expect(typeof workerManager.spawn).toBe('function');
    expect(typeof workerManager.request).toBe('function');
    expect(typeof workerManager.cast).toBe('function');
    expect(typeof workerManager.isReady).toBe('function');
    expect(typeof workerManager.getStatuses).toBe('function');
    expect(typeof workerManager.shutdownAll).toBe('function');
    expect(typeof workerManager.shutdownWorker).toBe('function');
    expect(typeof workerManager.onEvent).toBe('function');
  });
});