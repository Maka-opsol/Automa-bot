'use strict';

/**
 * Typed message protocol for worker thread communication.
 *
 * Message shapes:
 *   REQUEST  — main → worker or worker → main, expects a REPLY
 *   REPLY    — response to a REQUEST (success or error)
 *   CAST     — fire-and-forget notification (no reply expected)
 *   EVENT    — worker → main, async event (e.g. log, metric update)
 *
 * Every message has: { type, id?, method, payload?, error? }
 */

// ─── Message Types ───
const MSG_TYPE: Readonly<Record<string, string>> = Object.freeze({
  REQUEST:  'request',
  REPLY:    'reply',
  CAST:     'cast',
  EVENT:    'event',
});

// ─── Worker Lifecycle Commands ───
const WORKER_CMD: Readonly<Record<string, string>> = Object.freeze({
  INIT:       'init',        // Send config + init params
  START:      'start',       // Begin periodic work
  STOP:       'stop',        // Pause periodic work
  SHUTDOWN:   'shutdown',    // Graceful termination
  HEALTH:     'health',      // Health check ping
});

// ─── Well-Known Methods ───
const METHOD: Readonly<Record<string, string>> = Object.freeze({
  // Metrics
  METRICS_INCREMENT:       'metrics.increment',
  METRICS_HISTOGRAM:       'metrics.recordHistogram',
  METRICS_GAUGE:           'metrics.setGauge',
  METRICS_GET_SUMMARY:     'metrics.getSummary',

  // Diary
  DIARY_LOG_ENTRY:         'diary.logEntry',
  DIARY_LOG_ACTION:        'diary.logAction',
  DIARY_LOG_DECISION:      'diary.logDecision',
  DIARY_LOG_ERROR:         'diary.logError',
  DIARY_LOG_STATE_TRANS:   'diary.logStateTransition',
  DIARY_LOG_METRIC:        'diary.logMetric',
  DIARY_GET_TODAY:         'diary.getTodayEntries',
  DIARY_GET_SUMMARY:       'diary.getSummary',

  // Reward Tracker
  RT_RECORD_PATCH_GEN:     'rewardTracker.recordPatchGeneration',
  RT_RECORD_STAGING:       'rewardTracker.recordStagingResult',
  RT_RECORD_PROD_SURVIVAL: 'rewardTracker.recordProdSurvival',
  RT_RECORD_HEAL_DURATION: 'rewardTracker.recordHealDuration',
  RT_GET_BEST_LINEUP:      'rewardTracker.getBestCodegenLineup',
  RT_GENERATE_REPORT:      'rewardTracker.generateReport',
  RT_GET_STATS:            'rewardTracker.getStats',

  // System
  SYS_LOG:                 'system.log',
  SYS_READY:               'system.ready',
  SYS_ERROR:               'system.error',
});

// ─── Error Codes ───
const WORKER_ERROR: Readonly<Record<string, string>> = Object.freeze({
  NOT_READY:       'WORKER_NOT_READY',
  UNKNOWN_METHOD:  'UNKNOWN_METHOD',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  TIMEOUT:         'REQUEST_TIMEOUT',
  SHUTTING_DOWN:   'WORKER_SHUTTING_DOWN',
  INIT_FAILED:     'WORKER_INIT_FAILED',
});

// ─── Message Interfaces ───
interface WorkerMessage {
  type: string;
  id?: string;
  method?: string;
  payload?: Record<string, unknown>;
  error?: { code: string; message: string };
  timestamp?: number;
}

// Re-export the type so consumers can import it.
// In CJS, interfaces are erased at runtime, so we also attach a
// runtime-safe type-guard so downstream can do typeof checks if needed.
function isWorkerMessage(msg: unknown): msg is WorkerMessage {
  return typeof msg === 'object' && msg !== null && 'type' in msg;
}

// ─── Correlation ID Generator ───
let _correlationCounter = 0;
function nextCorrelationId(): string {
  return `msg_${process.pid}_${Date.now()}_${++_correlationCounter}`;
}

// ─── Message Factories ───
function createRequest(method: string, payload?: Record<string, unknown>, id?: string): WorkerMessage {
  return {
    type: MSG_TYPE.REQUEST,
    id: id || nextCorrelationId(),
    method,
    payload: payload != null ? payload : {},
  };
}

function createReply(id: string, payload?: Record<string, unknown>, error?: { code: string; message: string } | null): WorkerMessage {
  const msg: WorkerMessage = {
    type: MSG_TYPE.REPLY,
    id,
  };
  if (error) {
    msg.error = {
      code: error.code || 'UNKNOWN',
      message: error.message || String(error),
    };
  } else {
    msg.payload = payload != null ? payload : {};
  }
  return msg;
}

function createCast(method: string, payload?: Record<string, unknown>): WorkerMessage {
  return {
    type: MSG_TYPE.CAST,
    method,
    payload: payload != null ? payload : {},
  };
}

function createEvent(method: string, payload?: Record<string, unknown>): WorkerMessage {
  return {
    type: MSG_TYPE.EVENT,
    method,
    payload: payload != null ? payload : {},
    timestamp: Date.now(),
  };
}

module.exports = {
  MSG_TYPE, WORKER_CMD, WORKER_ERROR, METHOD,
  nextCorrelationId,
  createRequest, createReply, createCast, createEvent,
  isWorkerMessage,
};