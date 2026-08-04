'use strict';

// Lazy requires to avoid top-level dependency on heavy modules
const _getLog = () => { try { return require('./logger'); } catch { return { log: console.log, logError: console.error }; } };

/**
 * Overall timeout for the entire fallback action pipeline.
 * On Render free plan (slow CPU), individual page.$() calls can hang.
 * This prevents the fallback from consuming the entire cycle budget.
 */
const FALLBACK_TIMEOUT_MS = 5000;

/**
 * Per-selector timeout in ms. Each page.$() is raced against this.
 */
const SELECTOR_TIMEOUT_MS = 2000;

/**
 * Try a single page.$() with a per-call timeout.
 * Returns null on timeout or error (never throws).
 */
async function _safeQuery(page: any, selector: string): Promise<any> {
  const { sleep } = require('./utils-sleep');
  try {
    return await Promise.race([
      page.$(selector),
      sleep(SELECTOR_TIMEOUT_MS).then(() => null),
    ]);
  } catch { return null; }
}

/**
 * Get bounding box from an element handle with timeout.
 * Returns null on any failure.
 */
async function _safeBoundingBox(page: any, element: any): Promise<any> {
  if (!element) return null;
  const { sleep } = require('./utils-sleep');
  try {
    return await Promise.race([
      element.boundingBox(),
      sleep(SELECTOR_TIMEOUT_MS).then(() => null),
    ]);
  } catch { return null; }
}

/**
 * Build a click action from a bounding box.
 * Returns null if box is invalid.
 */
function _boxToAction(box: any, currentState: string): any {
  if (!box || box.width <= 0 || box.height <= 0) return null;
  return {
    actionType: 'click',
    currentState,
    targetX: Math.round(box.x + box.width / 2),
    targetY: Math.round(box.y + box.height / 2),
  };
}

// ─── Selectors organized by page context ───

const ASSIGNMENT_SELECTORS = [
  // Video buttons
  { selector: 'button:has-text("Watch")', state: 'assignments_page' },
  { selector: 'button:has-text("Start")', state: 'assignments_page' },
  { selector: 'button:has-text("Play")', state: 'assignments_page' },
  // Module/assignment cards — click top area (title)
  { selector: '.module-card, .card, [class*="assignment"], [class*="module"]', state: 'assignments_page', offsetY: 30 },
];

const LOGIN_SELECTORS = [
  { selector: 'input[type="email"]', state: 'microsoft_email_input', actionType: 'input_email' },
  { selector: 'input[name="loginfmt"]', state: 'microsoft_email_input', actionType: 'input_email' },
  { selector: 'input[type="password"]', state: 'microsoft_password_input', actionType: 'input_password' },
  { selector: 'input[name="passwd"]', state: 'microsoft_password_input', actionType: 'input_password' },
];

const SIGNIN_SELECTORS = [
  { selector: 'button:has-text("Sign in")', state: 'signin_page' },
  { selector: 'button:has-text("Log in")', state: 'signin_page' },
  { selector: 'button:has-text("Next")', state: 'signin_page' },
  { selector: 'button:has-text("Continue")', state: 'signin_page' },
];

/**
 * Generate a fallback action when the tribunal/AI fails.
 *
 * Strategy:
 *   1. Try visual recovery (longevity-ui-recovery) — works across UI redesigns
 *   2. Context-specific selectors (assignments, login, signin)
 *   3. Return wait action as last resort
 *
 * On Render free plan:
 *   - Overall timeout prevents hung page.$() from consuming cycle budget
 *   - Per-selector timeout (2s) prevents individual query hangs
 *   - Removed dead code (unused viewport computation, unnecessary browser require)
 */
async function getFallbackAction(page: any) {
  const { log } = _getLog();
  const { sleep } = require('./utils-sleep');

  // Wrap entire pipeline in a timeout
  const result = await Promise.race([
    _getFallbackActionInner(page, log),
    sleep(FALLBACK_TIMEOUT_MS).then(() => {
      log('Fallback action pipeline timed out', 'WARN', 'fallback');
      return { actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 };
    }),
  ]);
  return result;
}

async function _getFallbackActionInner(page: any, log: any): Promise<any> {
  // ── Stage 1: Visual recovery (works across UI redesigns) ──
  try {
    const { generateRecoveryAction } = require('./longevity-ui-recovery');
    const recoveryAction = await generateRecoveryAction(page);
    if (recoveryAction) {
      log('Visual recovery provided fallback action', 'DEBUG', 'fallback');
      return recoveryAction;
    }
  } catch (e: any) {
    log(`UI recovery failed, using selector-based fallback: ${e.message || e}`, 'DEBUG', 'fallback');
  }

  // ── Stage 2: Wait for DOM readiness ──
  // After navigation or error, DOM may not be ready.
  // Non-blocking: if waitForLoadState hangs, the per-selector timeouts will catch it.
  try {
    await Promise.race([
      page.waitForLoadState('domcontentloaded', { timeout: 2000 }),
      require('./utils-sleep').sleep(2500).then(() => null),
    ]);
  } catch { /* proceed with selectors anyway */ }

  // ── Stage 3: Context-specific selectors ──
  const url = page.url();

  // Assignments page
  if (url.includes('/assignments')) {
    for (const entry of ASSIGNMENT_SELECTORS) {
      const el = await _safeQuery(page, entry.selector);
      if (el) {
        const box = await _safeBoundingBox(page, el);
        if (box) {
          const action = _boxToAction(box, entry.state);
          if (action) {
            if (entry.offsetY) { action.targetY = Math.round(box.y + entry.offsetY); }
            log(`Fallback found ${entry.selector} on assignments page`, 'DEBUG', 'fallback');
            return action;
          }
        }
      }
    }
  }

  // Microsoft login
  if (url.includes('login.microsoftonline.com')) {
    for (const entry of LOGIN_SELECTORS) {
      const el = await _safeQuery(page, entry.selector);
      if (el) {
        const box = await _safeBoundingBox(page, el);
        if (box) {
          const action = _boxToAction(box, entry.state);
          if (action) {
            action.actionType = entry.actionType || action.actionType;
            log(`Fallback found ${entry.selector} on login page`, 'DEBUG', 'fallback');
            return action;
          }
        }
      }
    }
  }

  // Generic signin buttons (any page)
  if (url.includes('login') || url.includes('signin') || url.includes('auth')) {
    for (const entry of SIGNIN_SELECTORS) {
      const el = await _safeQuery(page, entry.selector);
      if (el) {
        const box = await _safeBoundingBox(page, el);
        if (box) {
          const action = _boxToAction(box, entry.state);
          if (action) {
            log(`Fallback found ${entry.selector} on auth page`, 'DEBUG', 'fallback');
            return action;
          }
        }
      }
    }
  }

  // ── Stage 4: Last resort ──
  return { actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 };
}

module.exports = { getFallbackAction };
