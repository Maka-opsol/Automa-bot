'use strict';

/**
 * Main-thread proxy for the diary worker.
 *
 * Provides the same API surface as the original `diary.js` module.
 * All logging operations use cast (fire-and-forget) since diary writes
 * are non-critical and shouldn't block the main thread.
 *
 * getSummary() and getTodayEntries() use request/reply.
 */

const { workerManager } = require('./workers-worker-manager');
const { METHOD } = require('./workers-message-protocol');

interface DiaryProxy {
  logEntry(type: string, message: string, data?: Record<string, unknown>): void;
  logAction(action: string, state: string, success: boolean, reasoning?: string): void;
  logDecision(decision: string, context?: Record<string, unknown>): void;
  logError(err: Error, context?: Record<string, unknown>): void;
  logStateTransition(from: string, to: string, reason?: string): void;
  logMetric(name: string, value: number | string, unit?: string): void;
  getTodayEntries(): Promise<Record<string, unknown> | undefined>;
  getSummary(): Promise<Record<string, unknown> | undefined>;
  start(): void;
}

/**
 * Create a diary proxy object.
 * @param workerName - Name the worker was spawned with (default: 'diary')
 */
function createDiaryProxy(workerName: string = 'diary'): DiaryProxy {
  return {
    /** Log a generic entry (fire-and-forget). */
    logEntry(type: string, message: string, data: Record<string, unknown> = {}): void {
      workerManager.cast(workerName, METHOD.DIARY_LOG_ENTRY, { type, message, data });
    },

    /** Log an action (fire-and-forget). */
    logAction(action: string, state: string, success: boolean, reasoning?: string): void {
      workerManager.cast(workerName, METHOD.DIARY_LOG_ACTION, {
        action, state, success, reasoning,
      });
    },

    /** Log a decision (fire-and-forget). */
    logDecision(decision: string, context?: Record<string, unknown>): void {
      workerManager.cast(workerName, METHOD.DIARY_LOG_DECISION, { decision, context });
    },

    /** Log an error (fire-and-forget). */
    logError(err: Error, context: Record<string, unknown> = {}): void {
      workerManager.cast(workerName, METHOD.DIARY_LOG_ERROR, {
        error: { message: err.message, stack: err.stack },
        context,
      });
    },

    /** Log a state transition (fire-and-forget). */
    logStateTransition(from: string, to: string, reason?: string): void {
      workerManager.cast(workerName, METHOD.DIARY_LOG_STATE_TRANS, { from, to, reason });
    },

    /** Log a metric (fire-and-forget). */
    logMetric(name: string, value: number | string, unit: string = ''): void {
      workerManager.cast(workerName, METHOD.DIARY_LOG_METRIC, { name, value, unit });
    },

    /** Get today's diary entries (request/reply). */
    async getTodayEntries(): Promise<Record<string, unknown> | undefined> {
      return workerManager.request(workerName, METHOD.DIARY_GET_TODAY);
    },

    /** Generate/run daily summary (request/reply). */
    async getSummary(): Promise<Record<string, unknown> | undefined> {
      return workerManager.request(workerName, METHOD.DIARY_GET_SUMMARY);
    },

    /** No-op start() — the worker starts its own timers in _onInit. */
    start(): void {
      // Worker already starts its timers on init
    },
  };
}

module.exports = { createDiaryProxy };