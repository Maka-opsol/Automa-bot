'use strict';

/**
 * Main-thread proxy for the reward-tracker worker.
 *
 * Write operations use cast (fire-and-forget) for non-blocking performance.
 * Read operations (getBestCodegenLineup, generateReport, getStats) use request/reply.
 *
 * startProdSurvivalCheck() is a no-op — the worker auto-starts its timer on init.
 */

const { workerManager } = require('./workers-worker-manager');
const { METHOD } = require('./workers-message-protocol');

interface RewardTrackerProxy {
  recordPatchGeneration(modelName: string, patchId: string): void;
  recordStagingResult(modelName: string, patchId: string, passed: boolean): void;
  recordProdSurvival(modelName: string, patchId: string, survived24h: boolean): void;
  recordHealDuration(modelName: string, patchId: string, durationMs: number): void;
  getBestCodegenLineup(count?: number): Promise<Record<string, unknown> | undefined>;
  generateReport(): Promise<Record<string, unknown> | undefined>;
  getStats(): Promise<Record<string, unknown> | undefined>;
  startProdSurvivalCheck(): void;
  stop(): void;
}

/**
 * Create a reward-tracker proxy object.
 * @param workerName - Name the worker was spawned with (default: 'rewardTracker')
 */
function createRewardTrackerProxy(workerName: string = 'rewardTracker'): RewardTrackerProxy {
  return {
    /** Record patch generation (fire-and-forget). */
    recordPatchGeneration(modelName: string, patchId: string): void {
      workerManager.cast(workerName, METHOD.RT_RECORD_PATCH_GEN, { modelName, patchId });
    },

    /** Record staging result (fire-and-forget). */
    recordStagingResult(modelName: string, patchId: string, passed: boolean): void {
      workerManager.cast(workerName, METHOD.RT_RECORD_STAGING, { modelName, patchId, passed });
    },

    /** Record prod survival (fire-and-forget). */
    recordProdSurvival(modelName: string, patchId: string, survived24h: boolean): void {
      workerManager.cast(workerName, METHOD.RT_RECORD_PROD_SURVIVAL, { modelName, patchId, survived24h });
    },

    /** Record heal duration (fire-and-forget). */
    recordHealDuration(modelName: string, patchId: string, durationMs: number): void {
      workerManager.cast(workerName, METHOD.RT_RECORD_HEAL_DURATION, { modelName, patchId, durationMs });
    },

    /** Get best codegen lineup (request/reply). */
    async getBestCodegenLineup(count: number = 4): Promise<Record<string, unknown> | undefined> {
      return workerManager.request(workerName, METHOD.RT_GET_BEST_LINEUP, { count });
    },

    /** Generate performance report (request/reply). */
    async generateReport(): Promise<Record<string, unknown> | undefined> {
      return workerManager.request(workerName, METHOD.RT_GENERATE_REPORT);
    },

    /** Get model stats (request/reply). */
    async getStats(): Promise<Record<string, unknown> | undefined> {
      return workerManager.request(workerName, METHOD.RT_GET_STATS);
    },

    /** No-op — the worker auto-starts prod survival check on init. */
    startProdSurvivalCheck(): void {
      // Already started in worker init
    },

    /** No-op — worker handles its own lifecycle. */
    stop(): void {
      // Worker handles its own shutdown
    },
  };
}

module.exports = { createRewardTrackerProxy };