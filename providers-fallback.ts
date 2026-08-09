'use strict';

// Lazy requires to avoid top-level dependency on heavy modules
const _getLog = () => { try { return require('./logger'); } catch { return { log: console.log, logError: console.error }; } };

/**
 * Overall timeout for the entire fallback action pipeline.
 * On Render free plan (slow CPU), individual page.$() calls can hang.
 * This prevents the fallback from consuming the entire cycle budget.
 *
 * FIX: Increased from 15s to 25s. The pipeline runs pixel-fallback + pixel-explorer +
 * visual-recovery + DOM selectors sequentially. Each can take 2-3s on Render's slow CPU.
 * 15s was too tight and caused the pipeline to time out before completing all stages.
 */
const FALLBACK_TIMEOUT_MS = 25000;

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
  // Download button on module cards (must be checked before Watch/Start)
  { selector: '[class*="download"], [class*="Download"]', state: 'module_downloading' },
  { selector: 'button:has-text("Download")', state: 'module_downloading' },
  // Video buttons
  { selector: 'button:has-text("Watch")', state: 'assignments_page' },
  { selector: 'button:has-text("Start")', state: 'assignments_page' },
  { selector: 'button:has-text("Play")', state: 'assignments_page' },
  // Module/assignment cards — click top area (title)
  { selector: '.module-card, .card, [class*="assignment"], [class*="module"]', state: 'assignments_page', offsetY: 30 },
];

const EXERCISE_SELECTORS = [
  // Open book icon — MUST be clicked before Next (app requires viewing memo)
  { selector: '[class*="memo"], [class*="Memo"], [class*="book"], [class*="Book"]', state: 'exercise_info' },
  { selector: 'button:has-text("Memo"), button:has-text("memo")', state: 'exercise_info' },
  // Next button (only works AFTER memo has been viewed)
  { selector: 'button:has-text("Next")', state: 'exercise_info' },
  { selector: 'button:has-text("Previous")', state: 'exercise_info' },
];

const VIDEO_SELECTORS = [
  // Video back/close button inside the player
  { selector: '[class*="back"], [class*="Back"], [class*="close"], [class*="Close"]', state: 'video_player' },
  { selector: 'button:has-text("Back"), button:has-text("Close")', state: 'video_player' },
  // Video thumbnail/play area (to open the video)
  { selector: '[class*="video"], [class*="Video"], [class*="player"], video', state: 'video_player' },
];

const LOGIN_SELECTORS = [
  { selector: 'input[type="email"]', state: 'microsoft_email_input', actionType: 'input_email' },
  { selector: 'input[name="loginfmt"]', state: 'microsoft_email_input', actionType: 'input_email' },
  { selector: 'input[type="password"]', state: 'microsoft_password_input', actionType: 'input_password' },
  { selector: 'input[name="passwd"]', state: 'microsoft_password_input', actionType: 'input_password' },
  { selector: 'input[name="password"]', state: 'advlearn_login', actionType: 'input_password' },
];

const KMSI_SELECTORS = [
  { selector: 'button:has-text("Stay signed in")', state: 'microsoft_stay_signed_in' },
  { selector: 'button:has-text("Yes")', state: 'microsoft_stay_signed_in' },
  { selector: 'input[id="idBtn_Back"]', state: 'microsoft_stay_signed_in' },
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
 *   1. Pixel analysis (no DOM needed) — finds inputs/buttons by raw pixel color
 *   2. Visual recovery (longevity-ui-recovery) — works across UI redesigns
 *   3. Context-specific selectors (assignments, login, signin)
 *   4. Return wait action as last resort
 *
 * On Render free plan:
 *   - Overall timeout prevents hung page.$() from consuming cycle budget
 *   - Per-selector timeout (2s) prevents individual query hangs
 *   - Pixel fallback is first because it works when DOM is completely empty (Flutter canvas)
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
  // ── Stage 0: Pixel-based analysis (works with NO DOM, NO AI, NO semantics) ──
  // Decodes the screenshot PNG to raw RGBA pixels and scans for:
  //   - White rectangles = input fields (email/password)
  //   - Blue rectangles = Microsoft buttons (Next/Sign in)
  //   - Green/orange rectangles = Watch/Start buttons
  // This is the ultimate fallback when everything else is blind.
  try {
    const { generatePixelFallbackAction } = require('./pixel-fallback');
    const pixelAction = await generatePixelFallbackAction(page);
    if (pixelAction) {
      log(`Pixel fallback provided action: ${pixelAction.actionType} at (${pixelAction.targetX}, ${pixelAction.targetY})`, 'INFO', 'fallback');
      return pixelAction;
    }
  } catch (e: any) {
    log(`Pixel fallback failed: ${e.message || e}`, 'DEBUG', 'fallback');
  }

  // ── Stage 0.5: Blind pixel exploration (for completely unknown UIs) ──
  // When pixel-fallback's pattern matching fails (UI completely redesigned),
  // this systematically probes the viewport grid and learns from outcomes.
  try {
    const pixelExplorer = require('./pixel-explorer');
    const explorerAction = await pixelExplorer.explore(page);
    if (explorerAction) {
      log(`Pixel explorer provided action: ${explorerAction.actionType} at (${explorerAction.targetX}, ${explorerAction.targetY})`, 'INFO', 'fallback');
      return explorerAction;
    }
  } catch (e: any) {
    log(`Pixel explorer failed: ${e.message || e}`, 'DEBUG', 'fallback');
  }

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

  // Assignments page — also detect by SPA domain (URL may not have /assignments path)
  if (url.includes('/assignments') || url.includes('mathu.co.za')) {
    // Exercise selectors — MUST check these before generic assignment selectors
    // because the URL doesn't change between pages (SPA)
    for (const entry of EXERCISE_SELECTORS) {
      const el = await _safeQuery(page, entry.selector);
      if (el) {
        const box = await _safeBoundingBox(page, el);
        if (box) {
          const action = _boxToAction(box, entry.state);
          if (action) {
            log(`Fallback found ${entry.selector} on exercise page`, 'DEBUG', 'fallback');
            return action;
          }
        }
      }
    }

    // Video selectors — check for video elements
    for (const entry of VIDEO_SELECTORS) {
      const el = await _safeQuery(page, entry.selector);
      if (el) {
        const box = await _safeBoundingBox(page, el);
        if (box) {
          const action = _boxToAction(box, entry.state);
          if (action) {
            log(`Fallback found ${entry.selector} on video page`, 'DEBUG', 'fallback');
            return action;
          }
        }
      }
    }

    // Standard assignment selectors
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

  // Microsoft login (all sub-pages: email, password, kmsi)
  if (url.includes('login.microsoftonline.com') || url.includes('login.live.com') || url.includes('login.microsoft.com')) {
    // Try KMSI selectors first (if on the stay-signed-in page)
    if (url.includes('/kmsi')) {
      for (const entry of KMSI_SELECTORS) {
        const el = await _safeQuery(page, entry.selector);
        if (el) {
          const box = await _safeBoundingBox(page, el);
          if (box) {
            const action = _boxToAction(box, entry.state);
            if (action) {
              log(`Fallback found ${entry.selector} on KMSI page`, 'DEBUG', 'fallback');
              return action;
            }
          }
        }
      }
    }
    // Login input selectors
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

  // ADVLEARN or generic auth pages
  if (url.includes('login') || url.includes('signin') || url.includes('auth') || url.includes('advlearn')) {
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
