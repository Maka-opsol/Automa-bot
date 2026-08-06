// Resilience R13b: State Transition Guard — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// policy-state-guard.ts — P2 State Transition Validation
// ═══════════════════════════════════════════════════════════════
// Prevent the bot from navigating to unexpected states or
// revisiting completed work. This module validates state
// transitions against a known state machine and blocks
// dangerous transitions.
//
// Features:
//   1. Allowed state transitions map
//   2. Block transitions to unknown states
//   3. Block navigation to external domains (non-MathU)
//   4. Block revisiting score_screen for same question (double-counting)
//   5. Track visited URLs to detect revisits
//
// Integration:
//   - cycle-cycle-manager.ts calls validateTransition() after state detection
//   - cycle-cycle-manager.ts acts on blocked transitions by navigating away
//
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'state-guard') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Types ───
interface TransitionValidationResult {
  allowed: boolean;
  reason: string | null;
}

// ─── Allowed State Transitions ───
// Format: fromState → Set<toState>
const ALLOWED_TRANSITIONS: Record<string, Set<string>> = {
  'assignments_page': new Set(['question_page', 'auth_page', 'error_screen']),
  'question_page': new Set(['answering', 'score_screen', 'assignments_page', 'error_screen', 'auth_page']),
  'answering': new Set(['score_screen', 'question_page', 'error_screen', 'assignments_page']),
  'score_screen': new Set(['assignments_page', 'question_page', 'completion_screen', 'error_screen']),
  'completion_screen': new Set(['assignments_page', 'question_page']),
  'auth_page': new Set(['assignments_page', 'error_screen']),
  'error_screen': new Set(['assignments_page', 'auth_page', 'question_page']),
  'unknown': new Set(['assignments_page', 'question_page', 'auth_page', 'error_screen', 'score_screen']),
};

// ─── State ───
let _currentState: string = 'unknown';
let _visitedScoreQuestions: Set<string> = new Set();  // question IDs that have been scored
let _totalTransitions = 0;
let _totalBlocked = 0;
let _lastBlockedTransition: { from: string; to: string; reason: string } | null = null;
let _started = false;

// ─── Helpers ───

/**
 * Extract domain from URL.
 */
function _getDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Check if a URL belongs to the MathU platform.
 * This is a basic check — can be enhanced with actual MathU domain.
 */
function _isMathUDomain(url: string): boolean {
  const domain = _getDomain(url);
  if (!domain) return false;

  // Allow localhost and common MathU-related domains
  const allowed = new Set([
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    // Add actual MathU domains here
  ]);

  if (allowed.has(domain)) return true;

  // Allow any non-external domain (heuristic: if it's not a known external site)
  const blockedDomains = new Set([
    'google.com', 'facebook.com', 'twitter.com', 'github.com',
    'microsoft.com', 'apple.com', 'amazon.com',
  ]);

  return !blockedDomains.has(domain);
}

// ─── Core API ───

/**
 * Validate a state transition.
 *
 * @param fromState — The current state
 * @param toState — The target state
 * @param url — The URL being navigated to (optional)
 * @param questionId — The question identifier (for score_screen revisiting check)
 * @returns TransitionValidationResult
 */
function validateTransition(
  fromState: string,
  toState: string,
  url?: string,
  questionId?: string
): TransitionValidationResult {
  _totalTransitions++;

  // Update current state tracking
  _currentState = toState;

  // Check if toState is known
  if (!ALLOWED_TRANSITIONS[toState] && !ALLOWED_TRANSITIONS['unknown']) {
    _totalBlocked++;
    _lastBlockedTransition = { from: fromState, to: toState, reason: `Unknown target state: "${toState}"` };
    log(
      `[STATE-GUARD] Transition blocked: "${fromState}" → "${toState}" (unknown state)`,
      'WARN'
    );
    return { allowed: false, reason: _lastBlockedTransition.reason };
  }

  // Check allowed transitions (any → unknown is always allowed for discovery)
  if (toState !== 'unknown') {
    const fromTransitions = ALLOWED_TRANSITIONS[fromState] || ALLOWED_TRANSITIONS['unknown'];
    if (!fromTransitions.has(toState)) {
      // Check reverse: is there a known path back?
      const reverseTransitions = ALLOWED_TRANSITIONS[toState];
      if (!reverseTransitions || !reverseTransitions.has(fromState)) {
        _totalBlocked++;
        _lastBlockedTransition = { from: fromState, to: toState, reason: `No allowed transition from "${fromState}" to "${toState}"` };
        log(
          `[STATE-GUARD] Transition blocked: "${fromState}" → "${toState}" (not in allowed list)`,
          'WARN'
        );
        return { allowed: false, reason: _lastBlockedTransition.reason };
      }
      // Reverse path exists — allow but log
      log(
        `[STATE-GUARD] Reverse transition allowed: "${fromState}" → "${toState}"`,
        'DEBUG'
      );
    }
  }

  // Check URL domain if provided
  if (url && !_isMathUDomain(url)) {
    _totalBlocked++;
    _lastBlockedTransition = { from: fromState, to: toState, reason: `External domain: ${_getDomain(url)}` };
    log(
      `[STATE-GUARD] Transition blocked: navigating to external domain "${_getDomain(url)}"`,
      'WARN'
    );
    return { allowed: false, reason: _lastBlockedTransition.reason };
  }

  // Check for score screen revisiting (double-counting prevention)
  if (toState === 'score_screen' && questionId) {
    if (_visitedScoreQuestions.has(questionId)) {
      _totalBlocked++;
      _lastBlockedTransition = { from: fromState, to: toState, reason: `Score screen already visited for question "${questionId}" (double-counting prevention)` };
      log(
        `[STATE-GUARD] Transition blocked: revisiting score_screen for question "${questionId}"`,
        'WARN'
      );
      return { allowed: false, reason: _lastBlockedTransition.reason };
    }
    _visitedScoreQuestions.add(questionId);
  }

  return { allowed: true, reason: null };
}

/**
 * Mark a question's score screen as visited (call after successfully viewing score).
 */
function markScoreVisited(questionId: string): void {
  _visitedScoreQuestions.add(questionId);
}

/**
 * Get the current state.
 */
function getCurrentState(): string {
  return _currentState;
}

/**
 * Reset state tracking (call at cycle start).
 */
function reset(): void {
  _currentState = 'unknown';
  _visitedScoreQuestions.clear();
}

/**
 * Get diagnostic status.
 */
function getStatus(): {
  currentState: string;
  totalTransitions: number;
  totalBlocked: number;
  blockRate: number;
  visitedScoreQuestions: number;
  lastBlockedTransition: { from: string; to: string; reason: string } | null;
} {
  return {
    currentState: _currentState,
    totalTransitions: _totalTransitions,
    totalBlocked: _totalBlocked,
    blockRate: _totalTransitions > 0 ? Math.round((_totalBlocked / _totalTransitions) * 100) : 0,
    visitedScoreQuestions: _visitedScoreQuestions.size,
    lastBlockedTransition: _lastBlockedTransition,
  };
}

/**
 * Start the state guard.
 */
function start(): void {
  if (_started) return;
  _started = true;

  log('[STATE-GUARD] State guard started', 'INFO');
}

module.exports = {
  _injectDependencies,
  validateTransition,
  markScoreVisited,
  getCurrentState,
  reset,
  getStatus,
  start,
};
