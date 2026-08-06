// Resilience R10a: Speed Benchmark Timeout — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// progress-speed-benchmark.ts — P1 Speed Timeout Detection
// ═══════════════════════════════════════════════════════════════
// Track time-to-complete for each question in a rolling window.
// If the current question takes 3x longer than the average AND
// semantic state hasn't changed, force a skip to prevent the bot
// from being stuck on a single question indefinitely.
//
// Features:
//   1. Rolling window of last 10 question completion times
//   2. Average time-to-complete computed from the window
//   3. If current question > multiplier × average AND no semantic
//      change for 2 minutes → timeout, suggest skip
//   4. Grace period for first few questions (no baseline yet)
//   5. Persists stats to DB for cross-restart continuity
//
// Integration:
//   - cycle-cycle-manager.ts records question start/end times
//   - cycle-cycle-manager.ts calls checkSpeedTimeout() in main loop
//
// Config:
//   SPEED_BENCHMARK_MULTIPLIER — timeout multiplier (default 3)
//   SPEED_BENCHMARK_WINDOW — rolling window size (default 10)
//   SPEED_BENCHMARK_MIN_SAMPLES — minimum samples before timeout active (default 3)
//   SPEED_BENCHMARK_GRACE_PERIOD_MS — initial grace period (default 120000 = 2min)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'speed-benchmark') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Types ───
interface QuestionTimeRecord {
  questionNumber: number | null;
  startTime: number;
  endTime: number;
  durationMs: number;
  timestamp: number;
}

// ─── Constants ───
const DEFAULT_MULTIPLIER = 3;
const DEFAULT_WINDOW = 10;
const DEFAULT_MIN_SAMPLES = 3;
const DEFAULT_GRACE_PERIOD_MS = 120000;  // 2 minutes

// ─── State ───
let _completionTimes: number[] = [];           // Rolling window of durations
let _currentQuestionStart: number | null = null;
let _currentQuestionNumber: number | null = null;
let _totalQuestionsCompleted = 0;
let _totalTimeoutsTriggered = 0;
let _started = false;

// ─── Helpers ───

function _getMultiplier(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.SPEED_BENCHMARK_MULTIPLIER);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_MULTIPLIER;
}

function _getWindow(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.SPEED_BENCHMARK_WINDOW);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_WINDOW;
}

function _getMinSamples(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.SPEED_BENCHMARK_MIN_SAMPLES);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_MIN_SAMPLES;
}

function _getGracePeriodMs(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.SPEED_BENCHMARK_GRACE_PERIOD_MS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_GRACE_PERIOD_MS;
}

// ─── Core API ───

/**
 * Record the start of a new question.
 * @param questionNumber — Optional question number for tracking
 */
function startQuestion(questionNumber?: number): void {
  _currentQuestionStart = Date.now();
  _currentQuestionNumber = questionNumber || null;
}

/**
 * Record the completion of a question.
 * Adds the duration to the rolling window.
 */
function endQuestion(): void {
  if (_currentQuestionStart === null) return;

  const durationMs = Date.now() - _currentQuestionStart;
  _totalQuestionsCompleted++;

  // Add to rolling window
  _completionTimes.push(durationMs);
  const window = _getWindow();
  while (_completionTimes.length > window) {
    _completionTimes.shift();
  }

  log(
    `[SPEED] Question completed in ${Math.round(durationMs / 1000)}s ` +
    `(avg: ${Math.round(getAverageTime() / 1000)}s, window: ${_completionTimes.length})`,
    'DEBUG'
  );

  // Persist to DB
  try {
    const db = (_deps as any).database;
    if (db?.upsertCalibration) {
      db.upsertCalibration('speed_avg_ms', String(Math.round(getAverageTime())));
      db.upsertCalibration('speed_total_completed', String(_totalQuestionsCompleted));
    }
  } catch { /* non-critical */ }

  _currentQuestionStart = null;
  _currentQuestionNumber = null;
}

/**
 * Get the average completion time from the rolling window.
 */
function getAverageTime(): number {
  if (_completionTimes.length === 0) return 0;
  const sum = _completionTimes.reduce((a, b) => a + b, 0);
  return sum / _completionTimes.length;
}

/**
 * Get the median completion time (more robust against outliers).
 */
function getMedianTime(): number {
  if (_completionTimes.length === 0) return 0;
  const sorted = [..._completionTimes].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Check if the current question has timed out based on speed benchmark.
 *
 * @param semanticStateChanged — Whether semantic state has changed since question start
 * @returns { timedOut, avgTimeMs, currentTimeMs, reason }
 */
function checkSpeedTimeout(semanticStateChanged: boolean): {
  timedOut: boolean;
  avgTimeMs: number;
  currentTimeMs: number;
  reason: string | null;
} {
  if (_currentQuestionStart === null) {
    return { timedOut: false, avgTimeMs: 0, currentTimeMs: 0, reason: null };
  }

  const currentTimeMs = Date.now() - _currentQuestionStart;
  const avgTimeMs = getAverageTime();
  const multiplier = _getMultiplier();
  const minSamples = _getMinSamples();
  const gracePeriodMs = _getGracePeriodMs();
  const thresholdMs = avgTimeMs * multiplier;

  // Need minimum samples before timeout is active
  if (_completionTimes.length < minSamples) {
    // But still apply grace period timeout
    if (currentTimeMs > gracePeriodMs && !semanticStateChanged) {
      _totalTimeoutsTriggered++;
      log(
        `[SPEED] Grace period timeout: ${Math.round(currentTimeMs / 1000)}s > ${gracePeriodMs / 1000}s ` +
        `(no semantic change, insufficient samples for benchmark)`,
        'WARN'
      );
      return {
        timedOut: true,
        avgTimeMs,
        currentTimeMs,
        reason: `grace_period_exceeded (${Math.round(currentTimeMs / 1000)}s > ${gracePeriodMs / 1000}s, no semantic change)`,
      };
    }
    return { timedOut: false, avgTimeMs, currentTimeMs, reason: null };
  }

  // Check if exceeded multiplier × average AND no semantic change
  if (currentTimeMs > thresholdMs && !semanticStateChanged) {
    _totalTimeoutsTriggered++;
    log(
      `[SPEED] Timeout: ${Math.round(currentTimeMs / 1000)}s > ${multiplier}×avg (${Math.round(avgTimeMs / 1000)}s = ${Math.round(thresholdMs / 1000)}s) ` +
      `(no semantic change, ${_completionTimes.length} samples)`,
      'WARN'
    );
    return {
      timedOut: true,
      avgTimeMs,
      currentTimeMs,
      reason: `speed_timeout (${Math.round(currentTimeMs / 1000)}s > ${multiplier}×${Math.round(avgTimeMs / 1000)}s, no semantic change)`,
    };
  }

  return { timedOut: false, avgTimeMs, currentTimeMs, reason: null };
}

/**
 * Reset all tracking (call at cycle start).
 */
function reset(): void {
  // Don't clear completionTimes — we want cross-cycle continuity for the rolling window
  _currentQuestionStart = null;
  _currentQuestionNumber = null;
}

/**
 * Get full diagnostic status.
 */
function getStatus(): {
  currentQuestionNumber: number | null;
  currentQuestionElapsedMs: number | null;
  averageTimeMs: number;
  medianTimeMs: number;
  windowSize: number;
  samplesInWindow: number;
  multiplier: number;
  totalQuestionsCompleted: number;
  totalTimeoutsTriggered: number;
  thresholdMs: number;
} {
  const avg = getAverageTime();
  return {
    currentQuestionNumber: _currentQuestionNumber,
    currentQuestionElapsedMs: _currentQuestionStart ? Date.now() - _currentQuestionStart : null,
    averageTimeMs: avg,
    medianTimeMs: getMedianTime(),
    windowSize: _getWindow(),
    samplesInWindow: _completionTimes.length,
    multiplier: _getMultiplier(),
    totalQuestionsCompleted: _totalQuestionsCompleted,
    totalTimeoutsTriggered: _totalTimeoutsTriggered,
    thresholdMs: avg * _getMultiplier(),
  };
}

/**
 * Start the speed benchmark system.
 */
function start(): void {
  if (_started) return;
  _started = true;

  log(
    `[SPEED] Speed benchmark started (multiplier=${_getMultiplier()}, window=${_getWindow()}, minSamples=${_getMinSamples()})`,
    'INFO'
  );
}

module.exports = {
  _injectDependencies,
  startQuestion,
  endQuestion,
  getAverageTime,
  getMedianTime,
  checkSpeedTimeout,
  reset,
  getStatus,
  start,
};
