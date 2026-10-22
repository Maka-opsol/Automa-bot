// Resilience R13a: Action Whitelist Per State — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// policy-action-validator.ts — P2 Action Validation
// ═══════════════════════════════════════════════════════════════
// Prevent the bot from executing nonsensical or dangerous actions.
// This module validates every action against a strict whitelist
// per current state and checks coordinate bounds.
//
// TASK 121 (2026-10-21): Fixed critical blockers in question completion:
//   1. Renamed `input_keypad` (typo) → `keypad_input` (real action type)
//   2. Added ALL question-related states: exercise_info, exercise_memo,
//      assessment, score_screen, video_player, pathway, exploration
//   3. Removed `screenshot` and `navigate` (not implemented in executor)
//   4. Added `keypad_input`, `type_text`, `input_email`, `input_password`,
//      `press_key`, `navigate_back`, `select_option` to appropriate states
//   5. Added `drag`, `hover`, `long_press` where needed
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
// TASK 121 (2026-10-21): Comprehensive whitelist with correct action type names.
// The action types must match VALID_ACTION_TYPES in providers-prompts.ts exactly.
// Real implemented action types (from cycle-action-executor.ts):
//   click, flutter_tap, double_click, hover, long_press, type_text,
//   input_email, input_password, keypad_input, press_key,
//   flutter_swipe, drag, scroll_vertical, scroll_horizontal,
//   navigate_back, select_option, reload_browser, wait, request_human_intervention
const STATE_ACTION_WHITELIST: Record<string, string[]> = {
  // ─── Login / Auth states ───
  'mathu_login': [
    'click', 'flutter_tap', 'double_click',
    'input_email', 'input_password',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
  ],
  'microsoft_email_input': [
    'click', 'flutter_tap', 'double_click',
    'input_email', 'input_password',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
  ],
  'microsoft_password_input': [
    'click', 'flutter_tap', 'double_click',
    'input_email', 'input_password',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
  ],
  'microsoft_kmsi': [
    'click', 'flutter_tap', 'double_click',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
  ],
  'advlearn_login': [
    'click', 'flutter_tap', 'double_click',
    'input_email', 'input_password',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
  ],
  'captcha': [
    'wait', 'reload_browser', 'reload_page',
    'click', 'flutter_tap',
  ],
  'auth_page': [
    'click', 'flutter_tap', 'double_click',
    'input_email', 'input_password',
    'keypad_input', 'wait', 'reload_browser', 'reload_page',
  ],

  // ─── App main pages ───
  'assignments_page': [
    'click', 'flutter_tap', 'double_click',
    'scroll_vertical', 'scroll_horizontal', 'flutter_swipe',
    'wait', 'reload_browser', 'reload_page',
    'navigate_back',
  ],
  'pathway': [
    'click', 'flutter_tap', 'double_click',
    'scroll_vertical', 'scroll_horizontal', 'flutter_swipe',
    'wait', 'reload_browser', 'reload_page',
    'navigate_back',
  ],

  // ─── Exercise / Question states (TASK 121: keypad_input now allowed!) ───
  'exercise_info': [
    'click', 'flutter_tap', 'double_click',
    'keypad_input', 'type_text', 'press_key',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
    'navigate_back', 'select_option',
  ],
  'exercise_memo': [
    'click', 'flutter_tap', 'double_click',
    'keypad_input', 'type_text', 'press_key',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
    'navigate_back', 'select_option',
  ],
  'assessment': [
    'click', 'flutter_tap', 'double_click',
    'keypad_input', 'type_text', 'press_key',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
    'navigate_back', 'select_option',
  ],
  'question_page': [
    'click', 'flutter_tap', 'double_click',
    'keypad_input', 'type_text', 'press_key',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
    'navigate_back', 'select_option',
  ],
  'answering': [
    'click', 'flutter_tap', 'double_click',
    'keypad_input', 'type_text', 'press_key',
    'flutter_swipe', 'wait',
    'navigate_back', 'select_option',
  ],

  // ─── Video / Media states ───
  'video_player': [
    'click', 'flutter_tap', 'double_click',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'reload_browser', 'reload_page',
    'navigate_back', 'press_key',
  ],

  // ─── Score / Completion states ───
  'score_screen': [
    'click', 'flutter_tap', 'double_click',
    'scroll_vertical', 'flutter_swipe',
    'wait', 'reload_browser', 'reload_page',
    'navigate_back',
  ],
  'completion_screen': [
    'click', 'flutter_tap', 'double_click',
    'navigate_back', 'wait',
    'reload_browser', 'reload_page',
  ],

  // ─── Error / recovery states ───
  'error_screen': [
    'navigate_back', 'wait', 'reload_browser', 'reload_page',
    'click', 'flutter_tap',
  ],
  'app_error': [
    'wait', 'reload_browser', 'reload_page',
    'click', 'flutter_tap',
  ],
  'error': [
    'wait', 'reload_browser', 'reload_page',
    'click', 'flutter_tap',
  ],
  'human_intervention': [
    'wait', 'reload_browser', 'reload_page',
  ],
  'flutter_modal': [
    'click', 'flutter_tap', 'double_click',
    'flutter_swipe', 'wait',
    'navigate_back', 'press_key',
  ],
  'flutter_bottom_sheet': [
    'click', 'flutter_tap', 'double_click',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'navigate_back',
  ],

  // ─── Exploration fallback ───
  // When the bot doesn't recognize the page, allow ALL safe actions so it
  // can try different things to figure out where it is.
  'exploration': [
    'click', 'flutter_tap', 'double_click',
    'keypad_input', 'type_text', 'press_key',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'navigate_back', 'select_option',
    'reload_browser', 'reload_page',
  ],
  'exploring': [
    'click', 'flutter_tap', 'double_click',
    'keypad_input', 'type_text', 'press_key',
    'flutter_swipe', 'scroll_vertical', 'scroll_horizontal',
    'wait', 'navigate_back', 'select_option',
    'reload_browser', 'reload_page',
  ],

  // ─── Unknown fallback ───
  // Allow ALL safe actions when state is unknown — better to try something
  // than to be stuck. The cycle manager will fall back to pixel-explorer if
  // the AI's action doesn't make progress.
  'unknown': [
    'click', 'flutter_tap', 'double_click',
    'keypad_input', 'type_text', 'press_key',
    'input_email', 'input_password',
    'flutter_swipe', 'drag',
    'scroll_vertical', 'scroll_horizontal',
    'wait', 'navigate_back', 'select_option',
    'reload_browser', 'reload_page',
    'hover', 'long_press',
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

  // TASK 43: 'request_human_intervention' is ALWAYS allowed on ANY state.
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

  // Validate coordinates if present (coordinates use 0-1 fractional system)
  if (action.x !== undefined && action.y !== undefined) {
    if (action.x < 0 || action.x > 1 || action.y < 0 || action.y > 1) {
      // TASK 121: Some AI responses may still use 0-100 scale. Allow if in that range.
      if (action.x >= 0 && action.x <= 100 && action.y >= 0 && action.y <= 100) {
        // Treat as 0-100 scale, normalize to 0-1
        action.x = action.x / 100;
        action.y = action.y / 100;
      } else {
        _totalRejected++;
        _lastRejection = { action: actionType, state: currentState, reason: `Coordinates out of bounds: (${action.x}, ${action.y})` };
        log(
          `[POLICY] Action rejected: coordinates (${action.x}, ${action.y}) out of viewport bounds (0-1)`,
          'WARN'
        );
        return { allowed: false, reason: _lastRejection.reason };
      }
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
