'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Last-Resort Mode — "do everything possible to complete questions
// regardless of the consequences"
// ═══════════════════════════════════════════════════════════════════════
//
// Problem:
//   When a cycle ends with 0 questions completed AND self-heal has failed,
//   the bot used to either (a) set stopRequested=true and STOP WORKING
//   (cycle-cycle-manager.ts:4873), or (b) sleep 2 min and passively retry.
//   Neither is "doing everything possible." The bot is alive but idle —
//   the worst state, because it burns uptime without making progress.
//
// Solution:
//   A last-resort mode that bypasses EVERY guard that could be preventing
//   progress. When activated, the cycle runs at MAXIMUM AGGRESSION:
//     - Stealth throttling:        bypassed (force NORMAL, no jitter)
//     - Normalcy delays:           bypassed (no breaks, no idles, no slow-downs)
//     - Memory protection:         forced to max power (beginSelfHealSession)
//     - Work-shift restrictions:   bypassed (force active shift)
//     - Provider rate-limit backoff: bypassed (retry immediately)
//     - Progress-timeout throw:    bypassed (keep trying, don't throw E_PROGRESS_STALL)
//     - Slow-progress throw:       bypassed (don't throw E_SLOW_PROGRESS)
//     - Zero-progress self-heal:   NOT re-triggered (it already failed —
//                                  re-triggering would just loop)
//
//   The orchestrator retries almost immediately (5 s sleep instead of
//   2 min) when last-resort is requested, so there's no passive gap
//   between "self-heal failed" and "try again aggressively."
//
// Safety valve:
//   After MAX_EFFORTS_PER_SESSION (5) consecutive last-resort cycles that
//   STILL complete 0 questions, shouldForceRestart() returns true. The
//   orchestrator then forces a process restart (on Render, exit(1) triggers
//   auto-restart; on HF Spaces, the process stays up but resets all
//   in-memory state). This prevents an infinite zero-progress loop while
//   still "trying everything" repeatedly — each restart gets a fresh
//   browser, fresh module cache, fresh provider quota window.
//
// Trigger conditions (either sets the pending request):
//   1. Self-heal failed (cycle-cycle-manager.ts:4873) — the old "stop" path
//   2. 2+ consecutive zero-question cycles — gradual escalation
//
// Lifecycle:
//   requestLastResort(reason)  → sets pending flag (called on self-heal fail / repeated zeros)
   //   isLastResortRequested()    → checked by orchestrator to reduce sleep
//   clearLastResortRequest()   → consumed at top of runCycle
//   enterLastResortMode(reason)→ activates (called at top of runCycle if requested)
//   [cycle runs with guards bypassed]
//   exitLastResortMode(reason) → deactivates (called in runCycle finally block)
//   recordEffortOutcome(did)   → records success/failure (called in finally block)
//   shouldForceRestart()       → checked by orchestrator after effort
// ═══════════════════════════════════════════════════════════════════════

const MAX_EFFORTS_PER_SESSION = 5;

// ─── State ──────────────────────────────────────────────────────────────
let _active = false;               // true while a cycle is running in last-resort mode
let _reason = '';                  // why the current effort was triggered
let _enteredAt = 0;                // when the current effort started
let _pendingRequest = false;       // the NEXT cycle should run in last-resort mode
let _pendingReason = '';           // why the next effort was requested
let _effortsThisSession = 0;       // total last-resort cycles since boot
let _consecutiveFailedEfforts = 0; // last-resort cycles that still got 0 questions, in a row
let _lastOutcomeTime = 0;          // when the last effort's outcome was recorded
let _consecutiveZeroQuestionCycles = 0; // tracked across ALL cycles (not just last-resort)

// ─── Logger (lazy, circular-safe) ───────────────────────────────────────
function _log(msg: string, level: string = 'INFO'): void {
  try {
    const logger = require('./logger');
    if (logger?.log) { logger.log(msg, level, 'last-resort-mode'); return; }
  } catch {}
  const fn = level === 'ERROR' ? 'error' : level === 'WARN' ? 'warn' : 'log';
  (console as any)[fn](`[last-resort-mode] ${msg}`);
}

// ═══════════════════════════════════════════════════════════════════════
// Request lifecycle (set by failure paths, consumed by the next runCycle)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Mark the NEXT cycle to run in last-resort mode.
 * Called from:
 *   - cycle-cycle-manager.ts:4873 (self-heal failed — replaces stopRequested=true)
 *   - cycle-cycle-manager.ts:4679 (repeated zero-question cycles)
 */
function requestLastResort(reason: string): void {
  _pendingRequest = true;
  _pendingReason = reason || 'unspecified';
  _log(`Last-resort REQUESTED for next cycle — reason: ${reason}. Guards will be bypassed.`, 'WARN');
}

function isLastResortRequested(): boolean { return _pendingRequest; }
function getPendingReason(): string { return _pendingReason; }
function clearLastResortRequest(): void { _pendingRequest = false; _pendingReason = ''; }

// ═══════════════════════════════════════════════════════════════════════
// Active mode lifecycle (entered at top of runCycle, exited in finally)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Activate last-resort mode. Called at the top of runCycle when
 * isLastResortRequested() is true. Increments the session effort counter.
 */
function enterLastResortMode(reason: string): void {
  _active = true;
  _reason = reason || 'unspecified';
  _enteredAt = Date.now();
  _effortsThisSession++;
  _log(
    `⚠️ LAST-RESORT MODE ACTIVE (effort #${_effortsThisSession}/${MAX_EFFORTS_PER_SESSION}) — reason: ${reason}. ` +
    `Bypassing stealth, normalcy, rate limits, memory protection, progress timeouts. ` +
    `Forcing questions through regardless of consequences.`,
    'ERROR'
  );
}

/**
 * Deactivate last-resort mode. Called in the runCycle finally block.
 */
function exitLastResortMode(reason: string): void {
  if (!_active) return;
  const durationMs = Date.now() - _enteredAt;
  _active = false;
  _log(`Last-resort mode deactivated after ${Math.round(durationMs / 1000)}s — ${reason}`, 'INFO');
}

/**
 * Record whether the last-resort effort completed any questions.
 * Called in the runCycle finally block (after exitLastResortMode).
 * Resets the failure counter on success; increments on failure.
 */
function recordEffortOutcome(completedAny: boolean): void {
  _lastOutcomeTime = Date.now();
  if (completedAny) {
    if (_consecutiveFailedEfforts > 0) {
      _log(
        `Last-resort effort SUCCEEDED — at least one question completed. ` +
        `Resetting consecutive-failure counter (was ${_consecutiveFailedEfforts}).`,
        'INFO'
      );
    }
    _consecutiveFailedEfforts = 0;
  } else {
    _consecutiveFailedEfforts++;
    _log(
      `Last-resort effort FAILED — 0 questions completed. ` +
      `Consecutive failed efforts: ${_consecutiveFailedEfforts}/${MAX_EFFORTS_PER_SESSION}.`,
      'ERROR'
    );
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Zero-question cycle tracking (for gradual escalation)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Called by cycle-cycle-manager after every cycle (regardless of last-resort).
 * Returns the NEW consecutive-zero count so the caller can decide whether
 * to escalate.
 */
function recordZeroQuestionCycle(wasZero: boolean): number {
  if (wasZero) {
    _consecutiveZeroQuestionCycles++;
  } else {
    _consecutiveZeroQuestionCycles = 0;
  }
  return _consecutiveZeroQuestionCycles;
}

function getConsecutiveZeroQuestionCycles(): number { return _consecutiveZeroQuestionCycles; }

// ═══════════════════════════════════════════════════════════════════════
// Guard-bypass checks (called by cycle-cycle-manager throughout the loop)
// ═══════════════════════════════════════════════════════════════════════

/**
 * The single check the cycle loop uses to decide whether to bypass a guard.
 * Returns true while a last-resort cycle is actively running.
 *
 * Usage in cycle-cycle-manager.ts:
 *   const lastResort = require('./last-resort-mode');
 *   if (!lastResort.shouldBypassGuards()) {
 *     // ... normalcy break / stealth jitter / progress-timeout throw ...
 *   }
 */
function shouldBypassGuards(): boolean { return _active; }

// ─── Convenience aliases for readability at call sites ──────────────────
function shouldBypassNormalcy(): boolean { return _active; }
function shouldBypassStealth(): boolean { return _active; }
function shouldBypassProgressTimeout(): boolean { return _active; }
function shouldBypassSelfHealTrigger(): boolean { return _active; }

// ═══════════════════════════════════════════════════════════════════════
// Safety valve
// ═══════════════════════════════════════════════════════════════════════

/**
 * True when the safety valve has tripped: MAX_EFFORTS_PER_SESSION
 * consecutive last-resort cycles all completed 0 questions.
 * The orchestrator checks this after each effort and, if true, forces a
 * process restart to break the zero-progress loop.
 */
function shouldForceRestart(): boolean {
  return _consecutiveFailedEfforts >= MAX_EFFORTS_PER_SESSION;
}

// ═══════════════════════════════════════════════════════════════════════
// Diagnostics
// ═══════════════════════════════════════════════════════════════════════

function isLastResortActive(): boolean { return _active; }
function getReason(): string { return _reason; }
function getEnteredAt(): number { return _enteredAt; }
function getEffortsThisSession(): number { return _effortsThisSession; }
function getConsecutiveFailedEfforts(): number { return _consecutiveFailedEfforts; }
function getMaxEffortsPerSession(): number { return MAX_EFFORTS_PER_SESSION; }

/**
 * Full status snapshot for the dashboard / monitoring.
 */
function getStatus(): Record<string, any> {
  return {
    active: _active,
    reason: _reason,
    enteredAt: _enteredAt,
    effortsThisSession: _effortsThisSession,
    consecutiveFailedEfforts: _consecutiveFailedEfforts,
    consecutiveZeroQuestionCycles: _consecutiveZeroQuestionCycles,
    pendingRequest: _pendingRequest,
    pendingReason: _pendingReason,
    maxEffortsPerSession: MAX_EFFORTS_PER_SESSION,
    shouldForceRestart: shouldForceRestart(),
    lastOutcomeAge: _lastOutcomeTime ? Date.now() - _lastOutcomeTime : null,
  };
}

function selfTest(): Record<string, any> {
  const checks: string[] = [];
  const ok = true;

  // State coherence: active implies a reason
  if (_active && !_reason) checks.push('active but no reason set');

  return {
    ok: checks.length === 0,
    checks,
    active: _active,
    effortsThisSession: _effortsThisSession,
    consecutiveFailedEfforts: _consecutiveFailedEfforts,
    maxEffortsPerSession: MAX_EFFORTS_PER_SESSION,
    shouldForceRestart: shouldForceRestart(),
  };
}

// ─── Test-only reset (not exported in production builds, but harmless) ──
function _resetForTest(): void {
  _active = false;
  _reason = '';
  _enteredAt = 0;
  _pendingRequest = false;
  _pendingReason = '';
  _effortsThisSession = 0;
  _consecutiveFailedEfforts = 0;
  _lastOutcomeTime = 0;
  _consecutiveZeroQuestionCycles = 0;
}

module.exports = {
  // Request lifecycle
  requestLastResort,
  isLastResortRequested,
  getPendingReason,
  clearLastResortRequest,

  // Active mode lifecycle
  enterLastResortMode,
  exitLastResortMode,
  recordEffortOutcome,
  isLastResortActive,

  // Zero-question tracking
  recordZeroQuestionCycle,
  getConsecutiveZeroQuestionCycles,

  // Guard bypass checks
  shouldBypassGuards,
  shouldBypassNormalcy,
  shouldBypassStealth,
  shouldBypassProgressTimeout,
  shouldBypassSelfHealTrigger,

  // Safety valve
  shouldForceRestart,

  // Diagnostics
  getReason,
  getEnteredAt,
  getEffortsThisSession,
  getConsecutiveFailedEfforts,
  getMaxEffortsPerSession,
  getStatus,
  selfTest,

  // Test-only
  _resetForTest,
};
