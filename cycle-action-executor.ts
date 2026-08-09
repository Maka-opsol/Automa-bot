'use strict';
// Last modified: 2026-08-05 — Response 20: Dynamic wait timeout (waitTime + 5s buffer instead of 30s cap)

// ═══════════════════════════════════════════════════════════════════════════
// Cycle Action Executor — Executes validated actions on the Playwright page.
//
// Render-aware: All Playwright interactions are timed. Keyboard shortcuts
// use try/catch per key to avoid a single failure killing the whole action.
// ═══════════════════════════════════════════════════════════════════════════

// v5-fix C9: All project module requires converted to DI deps.
// Only Node.js builtins and pure utilities at top level.
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): any { return _deps.config || {}; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Default delay after keyboard select-all (ms). */
const SELECT_ALL_DELAY_MS = 50;

/** Default delay between keystrokes in keyboard.type (ms). */
const KEYBOARD_TYPE_DELAY_MS = 50;

/** Maximum retry attempts for click actions. */
const CLICK_MAX_RETRIES = 2;

/** Base delay between click retries (ms). */
const CLICK_RETRY_BASE_DELAY_MS = 1000;

/** Delay before typing after tap on input field (ms). */
const PRE_TYPE_DELAY_MS = 500;

/** Delay between keypad taps (ms). */
const KEYPAD_TAP_DELAY_MS = 200;

/** Maximum time for a single non-wait action execution (ms).
 * Prevents a non-wait action from blocking the cycle indefinitely.
 * Wait actions use their own dynamic timeout (waitTime + buffer). */
const ACTION_TIMEOUT_MS = 30 * 1000; // 30 seconds

/** Extra buffer added to wait action time for timeout (ms). */
const WAIT_TIMEOUT_BUFFER_MS = 5000;

// ═══════════════════════════════════════════════════════════════════════════
// Helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Get the wait multiplier from CONFIG, defaulting to 1.0. */
function _waitMultiplier(config: any): number {
  return config.WAIT_MULTIPLIER ?? 1.0;
}

/** Select all text in the focused field. Handles Mac vs Linux/Windows. */
async function _selectAllText(page: any): Promise<void> {
  const isMac = process.platform === 'darwin';
  const modKey = isMac ? 'Meta' : 'Control';
  try { await page.keyboard.down(modKey); } catch { /* best effort */ }
  try { await page.keyboard.press('a'); } catch { /* best effort */ }
  try { await page.keyboard.up(modKey); } catch { /* best effort */ }
  await sleep(SELECT_ALL_DELAY_MS);
  try { await page.keyboard.press('Backspace'); } catch { /* best effort */ }
}

/** Type text into the focused field with error handling. */
async function _typeText(page: any, text: string, config: any): Promise<void> {
  const typeDelay = config.KEYBOARD_TYPE_DELAY_MS ?? KEYBOARD_TYPE_DELAY_MS;
  try {
    await page.keyboard.type(text, { delay: typeDelay });
  } catch (e: any) {
    log(`keyboard.type failed: ${e.message}`, 'WARN', 'action');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Main action executor
// ═══════════════════════════════════════════════════════════════════════════

async function executeAction(page: any, action: any) {
  // Race the entire action against a timeout.
  // Wait actions use a dynamic timeout (waitTime + buffer) since they may
  // legitimately need > 30s (e.g., BETWEEN_STEPS_MS * WAIT_MULTIPLIER = 75s).
  const isWaitAction = action.actionType === 'wait';
  const CONFIG = getCONFIG();
  const wm = _waitMultiplier(CONFIG);
  const estimatedWaitTime = isWaitAction
    ? ((CONFIG.ENABLE_ADAPTIVE_PERFORMANCE && _deps.adaptivePerformanceEngine?.getAdjustedWait)
        ? (_deps.adaptivePerformanceEngine.getAdjustedWait(CONFIG.BETWEEN_STEPS_MS) || CONFIG.BETWEEN_STEPS_MS * wm)
        : CONFIG.BETWEEN_STEPS_MS * wm)
    : 0;
  const timeoutMs = isWaitAction
    ? Math.max(estimatedWaitTime + WAIT_TIMEOUT_BUFFER_MS, ACTION_TIMEOUT_MS)
    : ACTION_TIMEOUT_MS;

  const actionPromise = _executeActionInner(page, action);
  // FIX: Save timer handle and clear after race resolves
  let actionTimer: any = null;
  const timeoutPromise = new Promise<null>(resolve =>
    actionTimer = setTimeout(() => resolve(null), timeoutMs)
  );
  try {
    const result = await Promise.race([actionPromise, timeoutPromise]);
    if (result === null) {
      log(`Action ${action.actionType} timed out after ${timeoutMs / 1000}s`, 'WARN', 'action');
    }
  } finally {
    if (actionTimer) clearTimeout(actionTimer);
  }
}

async function _executeActionInner(page: any, action: any) { 
  const CONFIG = getCONFIG();
  const wm = _waitMultiplier(CONFIG);
  const browser = _deps.browser || {};
  const providersBase = _deps.providersBase || {};
  const gestures = _deps.flutterGestures || {};
  const adaptiveEngine = _deps.adaptivePerformanceEngine || null;
  const providers = _deps.providers || {};
  const progressTracker = _deps.progressTracker || {};
  const policyEngine = _deps.policyEngine?.policyEngine || _deps.policyEngine || {};

  log(`Executing: ${action.actionType} on state ${action.currentState}`, 'INFO', 'action');

  // Track total actions stat
  const currentStats = providers.getStats?.() || {};
  providers.updateStats?.({ totalActions: (currentStats.totalActions || 0) + 1 });

  // Compute viewport and scaling
  const vp = browser.getPageViewport?.(page) || null;
  const vw = vp ? vp.width : CONFIG.DISPLAY_WIDTH;
  const vh = vp ? vp.height : CONFIG.DISPLAY_HEIGHT;
  const scale = browser.getScaleFactor?.() || 1;
  const dprScale = browser.getDprScale?.() || 1;
  const toAbsolute = (xPercent: any, yPercent: any) => {
    if (xPercent > 1 && yPercent > 1) return { x: xPercent, y: yPercent };
    return { x: xPercent * vw * scale * dprScale, y: yPercent * vh * scale * dprScale };
  };

  // Policy check
  let hostname = 'unknown';
  try { hostname = new URL(page.url()).hostname; } catch (_e: any) { /* URL parse failed */ }
  const context = { url: page.url(), domain: hostname };
  const policyResult = policyEngine.checkAction?.(action.actionType, context) || { allowed: true };
  if (!policyResult.allowed) {
    log(`Policy blocked action: ${policyResult.reason}`, 'WARN', 'action');
    return;
  }

  switch (action.actionType) {
    case 'click':
    case 'flutter_tap': {
      if (action.targetX == null || action.targetY == null) {
        log('Click action missing coordinates.', 'ERROR', 'action');
        break;
      }
      const { x, y } = toAbsolute(action.targetX, action.targetY);
      const retryWithBackoff = providersBase.retryWithBackoff || ((fn: any) => fn());
 const success = await retryWithBackoff(
        () => browser.performClickWithRetry?.(page, x, y, 3),
        { maxRetries: CLICK_MAX_RETRIES, baseDelay: CLICK_RETRY_BASE_DELAY_MS },
      );
      if (!success) {
        log('Click failed to produce page change, trying flutterTap fallback.', 'WARN', 'action');
        try { await browser.flutterTap?.(page, x, y); } catch (e: any) { /* best effort */ }
      }
      await sleep(CONFIG.POST_CLICK_MS * wm);
      break;
    }
    case 'flutter_swipe': {
      const { x: startX, y: startY } = toAbsolute(action.targetX || 0.5, action.targetY || 0.5);
      const { x: endX, y: endY } = toAbsolute(action.targetX2 || 0.5, action.targetY2 || 0.5);
      if (gestures.performSwipe) {
        await gestures.performSwipe(page, startX, startY, endX, endY, CONFIG.SWIPE_DURATION_MS);
      } else {
        log('flutter_swipe: performSwipe not available', 'WARN', 'action');
      }
      await sleep(CONFIG.BETWEEN_STEPS_MS * wm);
      break;
    }
    case 'input_email': {
      if (action.targetX == null || action.targetY == null) {
        log('Input email missing coordinates.', 'ERROR', 'action');
        break;
      }
      const { x, y } = toAbsolute(action.targetX, action.targetY);
      await browser.flutterTap?.(page, x, y);
      await sleep(PRE_TYPE_DELAY_MS);
      // Try to focus the email field via locator
      try {
        const emailLocator = page.locator('input[type="email"], input[name*="email" i], [role="textbox"][aria-label*="email" i]');
        if (await emailLocator.count() > 0) { await emailLocator.first().click(); }
      } catch (e: any) { log(`Locator for email field failed: ${e.message}`, 'WARN', 'action'); }
      await _selectAllText(page);
      await _typeText(page, CONFIG.getMicrosoftEmail?.() || '', CONFIG);
      try { await page.keyboard.press('Enter'); } catch { /* best effort */ }
      await sleep(CONFIG.POST_CLICK_MS * wm);
      break;
    }
    case 'input_password': {
      if (action.targetX == null || action.targetY == null) {
        log('Input password missing coordinates.', 'ERROR', 'action');
        break;
      }
      const { x, y } = toAbsolute(action.targetX, action.targetY);
      await browser.flutterTap?.(page, x, y);
      await sleep(PRE_TYPE_DELAY_MS);
      try {
        const passLocator = page.locator('input[type="password"], input[name*="password" i], [role="textbox"][aria-label*="password" i]');
        if (await passLocator.count() > 0) { await passLocator.first().click(); }
      } catch (e: any) { log(`Locator for password field failed: ${e.message}`, 'WARN', 'action'); }
      await _selectAllText(page);
      await _typeText(page, CONFIG.getMicrosoftPassword?.() || '', CONFIG);
      try { await page.keyboard.press('Enter'); } catch { /* best effort */ }
      await sleep(CONFIG.POST_CLICK_MS * wm);
      break;
    }
    case 'keypad_input': {
      if (action.keypadSequence && Array.isArray(action.keypadSequence)) {
        for (const key of action.keypadSequence) {
          const { x, y } = toAbsolute(key.x, key.y);
          await browser.flutterTap?.(page, x, y);
          await sleep(KEYPAD_TAP_DELAY_MS);
        }
        if (action.submitX != null && action.submitY != null) {
          const { x, y } = toAbsolute(action.submitX, action.submitY);
          await browser.flutterTap?.(page, x, y);
        }
        await sleep(CONFIG.POST_CLICK_MS * wm);
      } else {
        log('keypad_input missing keypadSequence.', 'ERROR', 'action');
      }
      break;
    }
    case 'scroll_vertical': {
      const scrollFactor = browser.getScaleFactor?.() || 1;
      await browser.scrollPage?.(page, 0, CONFIG.SCROLL_AMOUNT * scrollFactor);
      await sleep(CONFIG.SCROLL_PAUSE_MS * wm);
      break;
    }
    case 'scroll_horizontal': {
      const scrollFactor = browser.getScaleFactor?.() || 1;
      await browser.scrollPage?.(page, CONFIG.SCROLL_AMOUNT * scrollFactor, 0);
      await sleep(CONFIG.SCROLL_PAUSE_MS * wm);
      break;
    }
    case 'wait': {
      const waitTime = (CONFIG.ENABLE_ADAPTIVE_PERFORMANCE && adaptiveEngine?.getAdjustedWait)
        ? adaptiveEngine.getAdjustedWait(CONFIG.BETWEEN_STEPS_MS)
        : CONFIG.BETWEEN_STEPS_MS * wm;
      log(`Waiting ${waitTime}ms...`, 'DEBUG', 'action');
      await sleep(waitTime);
      break;
    }
    default:
      log(`Unknown action: ${action.actionType}`, 'WARN', 'action');
      await sleep(CONFIG.BETWEEN_STEPS_MS * wm);
  }

  // Track progress
  progressTracker.trackProgress?.({ action: action.actionType, state: action.currentState });
}

module.exports = { executeAction, _injectDependencies };
