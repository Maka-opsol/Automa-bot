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
const STATE_ACTION_WHITELIST: Record<string, string[]> = {
  'assignments_page': [
    'click',           // Click on assignment/module
    'scroll_vertical', // Scroll through assignments
    'scroll_horizontal',
    'wait',            // Wait for page load
    'navigate',        // Navigate to specific assignment
  ],
  'question_page': [
    'click',           // Click on answer option
    'input_keypad',    // Type answer via keypad
    'flutter_swipe',   // Swipe on mobile Flutter UI
    'wait',            // Wait for rendering
    'scroll_vertical',
    'scroll_horizontal',
    'screenshot',      // Take screenshot for analysis
  ],
  'answering': [
    'click',
    'input_keypad',
    'flutter_swipe',
    'wait',
    'screenshot',
  ],
  'score_screen': [
    'click',           // Click "Next" or "Continue"
    'scroll_vertical',
    'wait',
    'navigate',        // Navigate back to assignments
  ],
  'completion_screen': [
    'click',
    'navigate',
    'wait',
  ],
  'auth_page': [
    'input_keypad',
    'click',
    'wait',
    'navigate',
  ],
  'mathu_login': [
    'click',           // Click "Sign in with Microsoft"
    'input_email',     // Type email
    'input_password',  // Type password
    'wait',
    'navigate',
    'reload_browser',  // Reload if stuck
  ],
  'microsoft_email_input': [
    'click',
    'input_email',
    'input_password',
    'wait',
    'navigate',
    'reload_browser',
  ],
  'advlearn_login': [
    'click',
    'input_email',
    'input_password',
    'wait',
    'navigate',
    'reload_browser',
  ],
  'captcha': [
    'wait',            // Wait for the captcha solver to handle it
    'reload_browser',  // Reload to get a fresh captcha if stuck
    'click',           // Click on captcha elements if needed
  ],
  'error_screen': [
    'navigate',        // Navigate away from error
    'wait',
    'click',           // Dismiss error dialogs
  ],
  'unknown': [
    // Minimal actions for unknown states
    'screenshot',
    'wait',
    'navigate',
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
