'use strict';

// v5-fix C9: All project module requires converted to DI deps.
// Only Node.js builtins and pure utilities at top level.
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): any { return _deps.config || {}; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

async function executeAction(page: any, action: any) { 
  const CONFIG = getCONFIG();
  const browser = _deps.browser || {};
  const providersBase = _deps.providersBase || {};
  const gestures = _deps.flutterGestures || {};
  const adaptiveEngine = _deps.adaptivePerformanceEngine || null;
  const providers = _deps.providers || {};
  const progressTracker = _deps.progressTracker || {};
  const policyEngine = _deps.policyEngine?.policyEngine || _deps.policyEngine || {};

  log(`⚡ Executing: ${action.actionType} on state ${action.currentState}`, 'INFO', 'action');
  const currentStats = providers.getStats?.() || {};
  providers.updateStats?.({ totalActions: (currentStats.totalActions || 0) + 1 });
  const vp = browser.getPageViewport?.(page) || null;
  const vw = vp ? vp.width : CONFIG.DISPLAY_WIDTH;
  const vh = vp ? vp.height : CONFIG.DISPLAY_HEIGHT;
  const scale = browser.getScaleFactor?.() || 1;
  const dprScale = browser.getDprScale?.() || 1;
  const toAbsolute = (xPercent: any, yPercent: any) => {
    if (xPercent > 1 && yPercent > 1) return { x: xPercent, y: yPercent };
    return { x: xPercent * vw * scale * dprScale, y: yPercent * vh * scale * dprScale };
  };

  // Check policy for the action
  let hostname = 'unknown';
  try { hostname = new URL(page.url()).hostname; } catch (_e: any) { /* URL parse failed, using empty hostname */ }
  const context = { url: page.url(), domain: hostname };
  const policyResult = policyEngine.checkAction?.(action.actionType, context) || { allowed: true };
  if (!policyResult.allowed) {
    log(`Policy blocked action: ${policyResult.reason}`, 'WARN', 'action');
    return;
  }

  switch (action.actionType) {
    case 'click':
    case 'flutter_tap': {
      if (action.targetX == null || action.targetY == null) { log('❌ Click action missing coordinates.', 'ERROR', 'action'); break; }
      const { x, y } = toAbsolute(action.targetX, action.targetY);
      const success = await (providersBase.retryWithBackoff || ((fn: any) => fn()))(() => browser.performClickWithRetry?.(page, x, y, 3), { maxRetries: 2, baseDelay: 1000 });
      if (!success) { log('⚠️ Click failed to produce page change.', 'WARN', 'action'); await (browser.flutterTap?.(page, x, y)); }
      await sleep(CONFIG.POST_CLICK_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0));
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
      await sleep(CONFIG.BETWEEN_STEPS_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0));
      break;
    }
    case 'input_email': {
      if (action.targetX == null || action.targetY == null) { log('❌ Input email missing coordinates.', 'ERROR', 'action'); break; }
      const { x, y } = toAbsolute(action.targetX, action.targetY);
      await browser.flutterTap?.(page, x, y);
      await sleep(500);
      try {
        const emailLocator = page.locator('input[type="email"], input[name*="email" i], [role="textbox"][aria-label*="email" i]');
        if (await emailLocator.count() > 0) { await emailLocator.first().click(); }
      } catch (e: any) { log(`Locator for email field failed: ${e.message}`, 'WARN', 'action'); }
      const _isMac = process.platform === 'darwin';
      await page.keyboard.down(_isMac ? 'Meta' : 'Control'); await page.keyboard.press('a'); await page.keyboard.up(_isMac ? 'Meta' : 'Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(CONFIG.getMicrosoftEmail?.() || '', { delay: 50 });
      await page.keyboard.press('Enter');
      await sleep(CONFIG.POST_CLICK_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0));
      break;
    }
    case 'input_password': {
      if (action.targetX == null || action.targetY == null) { log('❌ Input password missing coordinates.', 'ERROR', 'action'); break; }
      const { x, y } = toAbsolute(action.targetX, action.targetY);
      await browser.flutterTap?.(page, x, y);
      await sleep(500);
      try {
        const passLocator = page.locator('input[type="password"], input[name*="password" i], [role="textbox"][aria-label*="password" i]');
        if (await passLocator.count() > 0) { await passLocator.first().click(); }
      } catch (e: any) { log(`Locator for password field failed: ${e.message}`, 'WARN', 'action'); }
      const _isMacPw = process.platform === 'darwin';
      await page.keyboard.down(_isMacPw ? 'Meta' : 'Control'); await page.keyboard.press('a'); await page.keyboard.up(_isMacPw ? 'Meta' : 'Control');
      await page.keyboard.press('Backspace');
      await page.keyboard.type(CONFIG.getMicrosoftPassword?.() || '', { delay: 50 });
      await page.keyboard.press('Enter');
      await sleep(CONFIG.POST_CLICK_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0));
      break;
    }
    case 'keypad_input': {
      if (action.keypadSequence && Array.isArray(action.keypadSequence)) {
        for (const key of action.keypadSequence) {
          const { x, y } = toAbsolute(key.x, key.y);
          await browser.flutterTap?.(page, x, y);
          await sleep(200);
        }
        if (action.submitX != null && action.submitY != null) {
          const { x, y } = toAbsolute(action.submitX, action.submitY);
          await browser.flutterTap?.(page, x, y);
        }
        await sleep(CONFIG.POST_CLICK_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0));
      } else { log('❌ keypad_input missing keypadSequence.', 'ERROR', 'action'); }
      break;
    }
    case 'scroll_vertical':
      await browser.scrollPage?.(page, 0, CONFIG.SCROLL_AMOUNT * (browser.getScaleFactor?.() || 1));
      await sleep(CONFIG.SCROLL_PAUSE_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0));
      break;
    case 'scroll_horizontal':
      await browser.scrollPage?.(page, CONFIG.SCROLL_AMOUNT * (browser.getScaleFactor?.() || 1), 0);
      await sleep(CONFIG.SCROLL_PAUSE_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0));
      break;
    case 'wait':
      log('⏳ Waiting...', 'DEBUG', 'action');
      const waitTime = (CONFIG.ENABLE_ADAPTIVE_PERFORMANCE && adaptiveEngine?.getAdjustedWait) ? adaptiveEngine.getAdjustedWait(CONFIG.BETWEEN_STEPS_MS) : CONFIG.BETWEEN_STEPS_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0);
      await sleep(waitTime);
      break;
    default:
      log(`⚠️ Unknown action: ${action.actionType}`, 'WARN', 'action');
      await sleep(CONFIG.BETWEEN_STEPS_MS * (CONFIG.WAIT_MULTIPLIER ?? 1.0));
  }
  progressTracker.trackProgress?.({ action: action.actionType, state: action.currentState });
}

module.exports = { executeAction, _injectDependencies };
