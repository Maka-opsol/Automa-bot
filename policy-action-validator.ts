// Resilience R13a: Action Whitelist Per State — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// policy-action-validator.ts — P2 Action Validation
// ═══════════════════════════════════════════════════════════════
// Prevent the bot from executing nonsensical or dangerous actions.
// This module validates every action against a strict whitelist
// per current state and checks coordinate bounds.
//
// Features:
//   1. Strict action whitelist per page state
//   2. Coordinate validation (0-100% viewport bounds)
//   3. Reject unknown action types
//   4. Per-state allowed actions (configurable)
//
// Integration:
//   - cycle-cycle-manager.ts calls validateAction() before execution
//
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'action-validator') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Types ───
interface ValidationResult {
  allowed: boolean;
  reason: string | null;
}

interface Action {
  actionType: string;
  x?: number;
  y?: number;
  value?: string;
  url?: string;
}

// ─── State Action Whitelist ───
// BUG FIX (2026-09-06): Added flutter_tap, flutter_swipe, and double_click to
// ALL states so the AI can use Flutter actions on any page without being blocked.
const STATE_ACTION_WHITELIST: Record<string, string[]> = {
  'assignments_page': [
    'click', 'flutter_tap', 'double_click',
    'scroll_vertical', 'scroll_horizontal', 'flutter_swipe',
    'wait', 'navigate', 'reload_browser', 'reload_page',
  ],
  'question_page': [
    'click', 'flutter_tap', 'double_click',
    'input_keypad', 'flutter_swipe',
    'wait', 'scroll_vertical', 'scroll_horizontal',
    'screenshot',
  ],
  'answering': [
    'click', 'flutter_tap', 'double_click',
    'input_keypad', 'flutter_swipe',
    'wait', 'screenshot',
  ],
  'score_screen': [
    'click', 'flutter_tap', 'double_click',
    'scroll_vertical', 'flutter_swipe',
    'wait', 'navigate', 'reload_browser', 'reload_page',
  ],
  'completion_screen': [
    'click', 'flutter_tap', 'double_click',
    'navigate', 'wait',
  ],
  'auth_page': [
    'click', 'flutter_tap', 'double_click',
    'input_keypad', 'wait', 'navigate', 'reload_browser', 'reload_page',
  ],
  'mathu_login': [
    'click', 'flutter_tap', 'double_click',
    'input_email', 'input_password',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'navigate', 'reload_browser', 'reload_page',
  ],
  'microsoft_email_input': [
    'click', 'flutter_tap', 'double_click',
    'input_email', 'input_password',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'navigate', 'reload_browser', 'reload_page',
  ],
  'advlearn_login': [
    'click', 'flutter_tap', 'double_click',
    'input_email', 'input_password',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'navigate', 'reload_browser', 'reload_page',
  ],
  'captcha': [
    'wait', 'reload_browser', 'reload_page',
    'click', 'flutter_tap',
  ],
  'error_screen': [
    'navigate', 'wait', 'reload_browser', 'reload_page',
    'click', 'flutter_tap',
  ],
  'unknown': [
    'click', 'flutter_tap', 'double_click',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'screenshot', 'wait', 'navigate', 'reload_browser', 'reload_page',
  ],
};

// ─── State ───
let _totalValidated = 0;
let _totalRejected = 0;
let _lastRejection: { action: string; state: string; reason: string } | null = null;

// ─── Core API ───

/**
 * Validate an action against the current state.
 *
 * @param action — The action to validate
 * @param currentState — The current page state (e.g. 'question_page')
 * @returns ValidationResult with allowed flag and optional reason
 */
function validateAction(action: Action, currentState: string): ValidationResult {
  _totalValidated++;

  if (!action || !action.actionType) {
    return { allowed: false, reason: 'No action type provided' };
  }

  const actionType = action.actionType;

  // TASK 43 (2026-09-10): 'request_human_intervention' is ALWAYS allowed on
  // ANY state. The AI can decide at any point that the bot can't proceed
  // automatically (password expired, MFA, account locked, etc.). We don't
  // restrict this to specific states — it's a universal escape hatch.
  if (actionType === 'request_human_intervention') {
    _totalValidated++;
    return { allowed: true, reason: 'Human intervention requested by AI (allowed on any state)' };
  }

  // Get allowed actions for current state (fallback to 'unknown')
  const allowedActions = STATE_ACTION_WHITELIST[currentState] || STATE_ACTION_WHITELIST['unknown'];

  // Check if action type is allowed
  if (!allowedActions.includes(actionType)) {
    _totalRejected++;
    _lastRejection = { action: actionType, state: currentState, reason: `Action "${actionType}" not allowed in state "${currentState}"` };
    log(
      `[POLICY] Action rejected: "${actionType}" not allowed in state "${currentState}"`,
      'WARN'
    );
    return { allowed: false, reason: _lastRejection.reason };
  }

  // Validate coordinates if present
  if (action.x !== undefined && action.y !== undefined) {
    if (action.x < 0 || action.x > 100 || action.y < 0 || action.y > 100) {
      _totalRejected++;
      _lastRejection = { action: actionType, state: currentState, reason: `Coordinates out of bounds: (${action.x}, ${action.y})` };
      log(
        `[POLICY] Action rejected: coordinates (${action.x}, ${action.y}) out of viewport bounds (0-100%)`,
        'WARN'
      );
      return { allowed: false, reason: _lastRejection.reason };
    }
  }

  // Validate URL if present (must be http(s) and same origin-ish)
  if (action.url) {
    try {
      const parsed = new URL(action.url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        _totalRejected++;
        return { allowed: false, reason: `Invalid URL protocol: ${parsed.protocol}` };
      }
    } catch {
      _totalRejected++;
      return { allowed: false, reason: `Invalid URL: ${action.url}` };
    }
  }

  return { allowed: true, reason: null };
}

/**
 * Get the whitelist of allowed actions for a state.
 */
function getAllowedActions(state: string): string[] {
  return STATE_ACTION_WHITELIST[state] || STATE_ACTION_WHITELIST['unknown'] || [];
}

/**
 * Add or update the whitelist for a state.
 */
function setAllowedActions(state: string, actions: string[]): void {
  STATE_ACTION_WHITELIST[state] = actions;
}

/**
 * Get diagnostic status.
 */
function getStatus(): {
  totalValidated: number;
  totalRejected: number;
  rejectionRate: number;
  lastRejection: { action: string; state: string; reason: string } | null;
} {
  return {
    totalValidated: _totalValidated,
    totalRejected: _totalRejected,
    rejectionRate: _totalValidated > 0 ? Math.round((_totalRejected / _totalValidated) * 100) : 0,
    lastRejection: _lastRejection,
  };
}

module.exports = {
  _injectDependencies,
  validateAction,
  getAllowedActions,
  setAllowedActions,
  getStatus,
};
