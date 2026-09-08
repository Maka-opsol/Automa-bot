'use strict';
// Last modified: 2026-09-02 — v19: Major enhancement. Added type_text, press_key,
// navigate_back, double_click, hover, long_press, drag, select_option.
// Total action types: 8 → 16.

// ═══════════════════════════════════════════════════════════════════════════
// Cycle Action Executor — Executes validated actions on the Playwright page.
//
// Render-aware: All Playwright interactions are timed. Keyboard shortcuts
// use try/catch per key to avoid a single failure killing the whole action.
//
// Architecture:
//   executeAction() races _executeActionInner() against a timeout.
//   _executeActionInner() runs the policy check then dispatches to the
//   appropriate handler by actionType. Every handler is wrapped in
//   try/catch so one failure doesn't crash the cycle.
//
// Action types (16 total):
//   COORDINATE-BASED: click, flutter_tap, double_click, hover, long_press
//   TEXT INPUT:       input_email, input_password, type_text, keypad_input
//   GESTURE:          flutter_swipe, drag, scroll_vertical, scroll_horizontal
//   KEYBOARD:         press_key
//   NAVIGATION:       navigate_back, select_option
//   TIMING:           wait
// ═══════════════════════════════════════════════════════════════════════════

// v5-fix C9: All project module requires converted to DI deps.
// Only Node.js builtins and pure utilities at top level.
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): any {
  if (_deps.config) return _deps.config;
  try { return require('./get-config'); } catch { return {}; }
}
function log(msg: string, level?: string, mod?: string) {
  if (_deps.logger?.log) { _deps.logger.log(msg, level, mod); return; }
  try { require('./logger').log(msg, level, mod); return; } catch {}
  console.log(msg);
}
function logError(msg: string, err: Error, ctx?: any) {
  if (_deps.logger?.logError) { _deps.logger.logError(msg, err, ctx); return; }
  try { require('./logger').logError(msg, err, ctx); return; } catch {}
  console.error(msg, err);
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Default delay after keyboard select-all (ms). */
const SELECT_ALL_DELAY_MS = 50;

/** Default delay between keystrokes in keyboard.type (ms). */
const KEYBOARD_TYPE_DELAY_MS = 50;

/** Maximum retry attempts for click actions. */
const CLICK_MAX_RETRIES = 1;

/** Base delay between click retries (ms). */
const CLICK_RETRY_BASE_DELAY_MS = 500;

/** Delay before typing after tap on input field (ms). */
const PRE_TYPE_DELAY_MS = 500;

/** Delay between keypad taps (ms). */
const KEYPAD_TAP_DELAY_MS = 200;

/** Delay after hover before taking effect (ms). */
const HOVER_SETTLE_MS = 300;

/** Default long-press duration (ms). */
const LONG_PRESS_DURATION_MS = 600;

/** Delay for dropdown option to appear after opening (ms). */
const DROPDOWN_OPEN_DELAY_MS = 400;

/** Drag gesture step count and step delay (ms). */
const DRAG_STEPS = 20;
const DRAG_STEP_DELAY_MS = 15;

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

/**
 * Focus a form field robustly, handling Microsoft login's `lightbox-cover`
 * overlay that intercepts pointer events during page transitions.
 *
 * Microsoft's login page periodically shows `<div class="lightbox-cover">`
 * (used for gray-out progress) on top of the email/password input. Playwright's
 * default `.click()` waits for visible+enabled+stable AND checks for intercepting
 * elements — so it hangs for 30s and times out, instead of just clicking through.
 *
 * Strategy (in order, fail fast at each step):
 *   1. `fill(value)` — Playwright's native method, sets value directly without
 *      needing a real click. Bypasses interception entirely. If this succeeds,
 *      the value is already set — caller should NOT call keyboard.type again.
 *   2. `click({ force: true })` — bypass the interception check. Use after
 *      `fill()` fails (e.g. field is a custom Flutter web component).
 *      Caller should still call keyboard.type to enter the value.
 *   3. JS `focus()` via evaluate — directly set focus on the element.
 *      Caller should still call keyboard.type to enter the value.
 *
 * Returns:
 *   'filled'  — fill() succeeded, value is set, do NOT type again.
 *   'focused' — focus succeeded via click or JS, caller should type the value.
 *   'failed'  — all strategies failed, but caller can still attempt keyboard.type
 *               on whatever element has focus (e.g. after flutterTap).
 */
async function _focusFieldRobust(
  page: any,
  selector: string,
  value: string,
  logPrefix = 'field'
): Promise<'filled' | 'focused' | 'failed'> {
  // Strategy 1: page.fill() — most reliable, bypasses interception
  try {
    await page.fill(selector, value, { timeout: 5000 });
    log(`${logPrefix}: fill() succeeded`, 'DEBUG', 'action');
    return 'filled';
  } catch (fillErr: any) {
    log(`${logPrefix}: fill() failed: ${fillErr?.message || fillErr}`, 'DEBUG', 'action');
  }

  // Strategy 2: locator click with force=true (bypass interception)
  try {
    const loc = page.locator(selector).first();
    if (await loc.count() > 0) {
      await loc.click({ force: true, timeout: 5000 });
      log(`${logPrefix}: click({force}) succeeded`, 'DEBUG', 'action');
      return 'focused';
    }
  } catch (clickErr: any) {
    log(`${logPrefix}: click({force}) failed: ${clickErr?.message || clickErr}`, 'DEBUG', 'action');
  }

  // Strategy 3: JS focus via evaluate
  try {
    const focused = await page.evaluate((sel: string) => {
      const el = document.querySelector(sel) as HTMLInputElement | null;
      if (el) {
        el.focus();
        el.click?.();
        return true;
      }
      return false;
    }, selector);
    if (focused) {
      log(`${logPrefix}: JS focus() fallback used`, 'DEBUG', 'action');
      return 'focused';
    }
  } catch (evalErr: any) {
    log(`${logPrefix}: JS focus() failed: ${evalErr?.message || evalErr}`, 'WARN', 'action');
  }

  // All strategies failed — but we should still attempt keyboard typing,
  // because the prior flutterTap may have already focused the field.
  log(`${logPrefix}: all focus strategies failed, will attempt keyboard.type on whatever has focus`, 'WARN', 'action');
  return 'failed';
}

/** Press a key or key combination. Handles modifier keys correctly. */
async function _pressKey(page: any, key: string): Promise<void> {
  // Support compound keys like "Control+a", "Shift+Tab", "Meta+Enter"
  const parts = key.split('+').map((k: string) => k.trim());
  if (parts.length > 1) {
    // Press modifier keys first, then the main key, then release in reverse
    const modifiers = parts.slice(0, -1);
    const mainKey = parts[parts.length - 1];
    for (const mod of modifiers) {
      try { await page.keyboard.down(mod); } catch { /* best effort */ }
    }
    try { await page.keyboard.press(mainKey); } catch { /* best effort */ }
    for (const mod of modifiers.reverse()) {
      try { await page.keyboard.up(mod); } catch { /* best effort */ }
    }
  } else {
    try { await page.keyboard.press(key); } catch { /* best effort */ }
  }
}

/** Move mouse to coordinates without clicking (hover). */
async function _hoverAt(page: any, x: number, y: number): Promise<void> {
  try {
    await page.mouse.move(x, y);
  } catch (e: any) {
    log(`mouse.move failed: ${e.message}`, 'WARN', 'action');
  }
}

/** Perform a drag gesture from (x1,y1) to (x2,y2) using CDP touch events.
 * Falls back to mouse down/move/up if CDP fails. */
async function _dragGesture(page: any, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  let cdp: any = null;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: x1, y: y1 }],
    });
    for (let i = 1; i <= DRAG_STEPS; i++) {
      const t = i / DRAG_STEPS;
      // Ease-in-out for natural feel
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
      const x = x1 + (x2 - x1) * ease;
      const y = y1 + (y2 - y1) * ease;
      await cdp.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y }],
      });
      await sleep(DRAG_STEP_DELAY_MS);
    }
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd',
      touchPoints: [],
    });
  } catch (e: any) {
    // Fallback to mouse-based drag
    log(`CDP drag failed, falling back to mouse: ${e.message}`, 'WARN', 'action');
    try {
      await page.mouse.move(x1, y1);
      await page.mouse.down();
      await page.mouse.move(x2, y2, { steps: DRAG_STEPS });
      await page.mouse.up();
    } catch (e2: any) {
      log(`Mouse drag also failed: ${e2.message}`, 'WARN', 'action');
    }
  } finally {
    if (cdp) { await cdp.detach().catch(() => {}); }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Action handlers
// ═══════════════════════════════════════════════════════════════════════════

// Each handler is an async function (page, action, ctx) => void.
// ctx contains pre-computed viewport, scale, config, and dependency refs.
// Every handler is wrapped in try/catch by the dispatcher — they should
// throw on fatal errors but log and continue on transient ones.

type ActionCtx = {
  page: any;
  action: any;
  CONFIG: any;
  wm: number;
  browser: any;
  providersBase: any;
  gestures: any;
  adaptiveEngine: any;
  providers: any;
  progressTracker: any;
  policyEngine: any;
  toAbsolute: (xPercent: any, yPercent: any) => { x: number; y: number };
};

// ── Click / Tap ──
async function _handleClick(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, browser, providersBase, toAbsolute } = ctx;
  if (action.targetX == null || action.targetY == null) {
    log('Click action missing coordinates.', 'ERROR', 'action');
    return;
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
}

// ── Double Click ──
async function _handleDoubleClick(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, browser, toAbsolute } = ctx;
  if (action.targetX == null || action.targetY == null) {
    log('double_click action missing coordinates.', 'ERROR', 'action');
    return;
  }
  const { x, y } = toAbsolute(action.targetX, action.targetY);
  try {
    await page.mouse.dblclick(x, y);
    log(`Double-clicked at (${x.toFixed(0)}, ${y.toFixed(0)})`, 'DEBUG', 'action');
  } catch (e: any) {
    log(`double_click failed: ${e.message}`, 'WARN', 'action');
    // Fallback: rapid manual double-click
    try {
      await page.mouse.click(x, y);
      await sleep(50);
      await page.mouse.click(x, y);
    } catch { /* best effort */ }
  }
  await sleep(CONFIG.POST_CLICK_MS * wm);
}

// ── Hover ──
async function _handleHover(ctx: ActionCtx): Promise<void> {
  const { page, action, toAbsolute } = ctx;
  if (action.targetX == null || action.targetY == null) {
    log('hover action missing coordinates.', 'ERROR', 'action');
    return;
  }
  const { x, y } = toAbsolute(action.targetX, action.targetY);
  await _hoverAt(page, x, y);
  await sleep(HOVER_SETTLE_MS);
  log(`Hovered at (${x.toFixed(0)}, ${y.toFixed(0)})`, 'DEBUG', 'action');
}

// ── Long Press ──
async function _handleLongPress(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, browser, gestures, toAbsolute } = ctx;
  if (action.targetX == null || action.targetY == null) {
    log('long_press action missing coordinates.', 'ERROR', 'action');
    return;
  }
  const { x, y } = toAbsolute(action.targetX, action.targetY);
  const duration = action.duration || CONFIG.LONG_PRESS_DELAY_MS || LONG_PRESS_DURATION_MS;
  // Use gesture simulator if available (CDP touch), otherwise mouse fallback
  if (gestures.performLongPress) {
    try {
      await gestures.performLongPress(page, x, y);
    } catch (e: any) {
      log(`performLongPress failed: ${e.message}, using mouse fallback`, 'WARN', 'action');
      try {
        await page.mouse.move(x, y);
        await page.mouse.down();
        await sleep(duration);
        await page.mouse.up();
      } catch { /* best effort */ }
    }
  } else {
    try {
      await page.mouse.move(x, y);
      await page.mouse.down();
      await sleep(duration);
      await page.mouse.up();
    } catch (e: any) {
      log(`long_press mouse fallback failed: ${e.message}`, 'WARN', 'action');
    }
  }
  log(`Long-pressed at (${x.toFixed(0)}, ${y.toFixed(0)}) for ${duration}ms`, 'DEBUG', 'action');
  await sleep(CONFIG.POST_CLICK_MS * wm);
}

// ── Swipe ──
async function _handleSwipe(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, gestures, toAbsolute } = ctx;
  const { x: startX, y: startY } = toAbsolute(action.targetX || 0.5, action.targetY || 0.5);
  const { x: endX, y: endY } = toAbsolute(action.targetX2 || 0.5, action.targetY2 || 0.5);
  if (gestures.performSwipe) {
    await gestures.performSwipe(page, startX, startY, endX, endY, CONFIG.SWIPE_DURATION_MS);
  } else {
    log('flutter_swipe: performSwipe not available', 'WARN', 'action');
  }
  await sleep(CONFIG.BETWEEN_STEPS_MS * wm);
}

// ── Drag and Drop ──
async function _handleDrag(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, toAbsolute } = ctx;
  if (action.targetX == null || action.targetY == null ||
      action.targetX2 == null || action.targetY2 == null) {
    log('drag action needs both start (targetX,targetY) and end (targetX2,targetY2) coordinates.', 'ERROR', 'action');
    return;
  }
  const { x: x1, y: y1 } = toAbsolute(action.targetX, action.targetY);
  const { x: x2, y: y2 } = toAbsolute(action.targetX2, action.targetY2);
  log(`Dragging from (${x1.toFixed(0)},${y1.toFixed(0)}) to (${x2.toFixed(0)},${y2.toFixed(0)})`, 'DEBUG', 'action');
  await _dragGesture(page, x1, y1, x2, y2);
  await sleep(CONFIG.BETWEEN_STEPS_MS * wm);
}

// ── Email Input ──
async function _handleInputEmail(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, browser } = ctx;
  if (action.targetX == null || action.targetY == null) {
    log('Input email missing coordinates.', 'ERROR', 'action');
    return;
  }
  const { x, y } = ctx.toAbsolute(action.targetX, action.targetY);
  // Keep the flutterTap — the user explicitly asked AI to use flutter_tap on
  // all pages, including Microsoft login. The tap may also dismiss the
  // `lightbox-cover` overlay if it's currently intercepting clicks.
  await browser.flutterTap?.(page, x, y);
  await sleep(PRE_TYPE_DELAY_MS);

  const emailVal = CONFIG.getMicrosoftEmail?.() || '';
  if (!emailVal) {
    log('input_email: no email configured — skipping', 'WARN', 'action');
    return;
  }

  // BUG FIX (2026-09-08): Use robust focus that bypasses `lightbox-cover`
  // interception. The old `locator.click()` waited 30s for visible+enabled+stable
  // AND checked for intercepting elements — Microsoft login's lightbox-cover
  // overlay caused every click to time out.
  const EMAIL_SELECTOR = 'input[type="email"], input[name*="email" i], [role="textbox"][aria-label*="email" i]';
  const focusResult = await _focusFieldRobust(page, EMAIL_SELECTOR, emailVal, 'input_email');

  // If fill() already set the value, skip keyboard typing.
  // Otherwise (focused or failed), use keyboard.type to enter the value.
  if (focusResult !== 'filled') {
    if (focusResult === 'focused') {
      // Field is focused but empty — select all (in case there's a placeholder
      // or stale value) then type.
      await _selectAllText(page);
    }
    await _typeText(page, emailVal, CONFIG);
  }

  try { await page.keyboard.press('Enter'); } catch { /* best effort */ }
  await sleep(CONFIG.POST_CLICK_MS * wm);
}

// ── Password Input ──
async function _handleInputPassword(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, browser } = ctx;
  if (action.targetX == null || action.targetY == null) {
    log('Input password missing coordinates.', 'ERROR', 'action');
    return;
  }
  const { x, y } = ctx.toAbsolute(action.targetX, action.targetY);
  await browser.flutterTap?.(page, x, y);
  await sleep(PRE_TYPE_DELAY_MS);

  const passVal = CONFIG.getMicrosoftPassword?.() || '';
  if (!passVal) {
    log('input_password: no password configured — skipping', 'WARN', 'action');
    return;
  }

  // BUG FIX (2026-09-08): Same lightbox-cover interception issue as email.
  const PASS_SELECTOR = 'input[type="password"], input[name*="password" i], [role="textbox"][aria-label*="password" i]';
  const focusResult = await _focusFieldRobust(page, PASS_SELECTOR, passVal, 'input_password');

  if (focusResult !== 'filled') {
    if (focusResult === 'focused') {
      await _selectAllText(page);
    }
    await _typeText(page, passVal, CONFIG);
  }

  try { await page.keyboard.press('Enter'); } catch { /* best effort */ }
  await sleep(CONFIG.POST_CLICK_MS * wm);
}

// ── Generic Text Input ──
async function _handleTypeText(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, browser } = ctx;
  if (action.targetX == null || action.targetY == null) {
    log('type_text action missing coordinates.', 'ERROR', 'action');
    return;
  }
  const text = action.value || '';
  if (!text) {
    log('type_text action missing value (text to type).', 'WARN', 'action');
    return;
  }
  const clearFirst = action.clearFirst !== false; // default true
  const { x, y } = ctx.toAbsolute(action.targetX, action.targetY);
  // Tap to focus the field
  await browser.flutterTap?.(page, x, y);
  await sleep(PRE_TYPE_DELAY_MS);
  // Optionally clear existing content
  if (clearFirst) {
    await _selectAllText(page);
  }
  await _typeText(page, text, CONFIG);
  log(`Typed ${text.length} chars at (${x.toFixed(0)}, ${y.toFixed(0)})${clearFirst ? ' (cleared first)' : ''}`, 'DEBUG', 'action');
  await sleep(CONFIG.POST_CLICK_MS * wm);
}

// ── Keypad Input ──
async function _handleKeypadInput(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, browser, toAbsolute } = ctx;
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
}

// ── Press Key ──
async function _handlePressKey(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm } = ctx;
  const key = action.value || '';
  if (!key) {
    log('press_key action missing value (key to press, e.g. "Enter", "Tab", "Escape").', 'WARN', 'action');
    return;
  }
  log(`Pressing key: ${key}`, 'DEBUG', 'action');
  await _pressKey(page, key);
  await sleep(CONFIG.POST_CLICK_MS * wm);
}

// ── Scroll Vertical ──
async function _handleScrollVertical(ctx: ActionCtx): Promise<void> {
  const { page, CONFIG, wm, browser } = ctx;
  const scrollFactor = browser.getScaleFactor?.() || 1;
  await browser.scrollPage?.(page, 0, CONFIG.SCROLL_AMOUNT * scrollFactor);
  await sleep(CONFIG.SCROLL_PAUSE_MS * wm);
}

// ── Scroll Horizontal ──
async function _handleScrollHorizontal(ctx: ActionCtx): Promise<void> {
  const { page, CONFIG, wm, browser } = ctx;
  const scrollFactor = browser.getScaleFactor?.() || 1;
  await browser.scrollPage?.(page, CONFIG.SCROLL_AMOUNT * scrollFactor, 0);
  await sleep(CONFIG.SCROLL_PAUSE_MS * wm);
}

// ── Navigate Back ──
async function _handleNavigateBack(ctx: ActionCtx): Promise<void> {
  const { page, CONFIG, wm } = ctx;
  try {
    await page.goBack({ waitUntil: 'domcontentloaded', timeout: 10000 });
    log('Navigated back in browser history.', 'DEBUG', 'action');
  } catch (e: any) {
    log(`navigate_back failed: ${e.message}`, 'WARN', 'action');
  }
  await sleep(CONFIG.BETWEEN_STEPS_MS * wm);
}

// ── Reload Browser ──
// BUG FIX (2026-09-06): New action type — lets the AI reload the current page
// when it's stuck, shows an error, or has an unsolvable CAPTCHA.
async function _handleReloadBrowser(ctx: ActionCtx): Promise<void> {
  const { page, CONFIG, wm } = ctx;
  try {
    log('Reloading current page (AI requested reload_browser)...', 'INFO', 'action');
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    log('Page reloaded successfully.', 'INFO', 'action');
  } catch (e: any) {
    log(`reload_browser failed: ${e.message}`, 'WARN', 'action');
  }
  await sleep(CONFIG.BETWEEN_STEPS_MS * wm);
}

// ── Select Dropdown Option ──
async function _handleSelectOption(ctx: ActionCtx): Promise<void> {
  const { page, action, CONFIG, wm, browser } = ctx;
  if (action.targetX == null || action.targetY == null ||
      action.targetX2 == null || action.targetY2 == null) {
    log('select_option needs dropdown coords (targetX,targetY) and option coords (targetX2,targetY2).', 'ERROR', 'action');
    return;
  }
  // Click the dropdown to open it
  const { x: dropX, y: dropY } = ctx.toAbsolute(action.targetX, action.targetY);
  await browser.flutterTap?.(page, dropX, dropY);
  await sleep(DROPDOWN_OPEN_DELAY_MS);
  // Click the option
  const { x: optX, y: optY } = ctx.toAbsolute(action.targetX2, action.targetY2);
  await browser.flutterTap?.(page, optX, optY);
  log(`Selected dropdown option at (${optX.toFixed(0)}, ${optY.toFixed(0)})`, 'DEBUG', 'action');
  await sleep(CONFIG.POST_CLICK_MS * wm);
}

// ── Wait ──
async function _handleWait(ctx: ActionCtx): Promise<void> {
  const { CONFIG, wm, adaptiveEngine } = ctx;
  const waitTime = (CONFIG.ENABLE_ADAPTIVE_PERFORMANCE && adaptiveEngine?.getAdjustedWait)
    ? adaptiveEngine.getAdjustedWait(CONFIG.BETWEEN_STEPS_MS)
    : CONFIG.BETWEEN_STEPS_MS * wm;
  log(`Waiting ${waitTime}ms...`, 'DEBUG', 'action');
  await sleep(waitTime);
}

// ═══════════════════════════════════════════════════════════════════════════
// Action dispatch table
// ═══════════════════════════════════════════════════════════════════════════

const ACTION_HANDLERS: Record<string, (ctx: ActionCtx) => Promise<void>> = {
  // Coordinate-based interactions
  click:          _handleClick,
  flutter_tap:    _handleClick,        // alias
  double_click:   _handleDoubleClick,
  hover:          _handleHover,
  long_press:     _handleLongPress,
  // Text input
  input_email:    _handleInputEmail,
  input_password: _handleInputPassword,
  type_text:      _handleTypeText,
  keypad_input:   _handleKeypadInput,
  // Gesture
  flutter_swipe:  _handleSwipe,
  drag:           _handleDrag,
  scroll_vertical:   _handleScrollVertical,
  scroll_horizontal: _handleScrollHorizontal,
  // Keyboard
  press_key:      _handlePressKey,
  // Navigation
  navigate_back:  _handleNavigateBack,
  reload_browser: _handleReloadBrowser,
  // BUG FIX (2026-09-08): pixel-fallback.ts returns 'reload_page' (4 places)
  // — alias it to the same handler as 'reload_browser' so it actually works
  // instead of being logged as "Unknown action: reload_page".
  reload_page:    _handleReloadBrowser,
  select_option:  _handleSelectOption,
  // Timing
  wait:           _handleWait,
};

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
  // BUG FIX (2026-09-06): Fall back to require() if DI didn't inject these deps.
  // The action executor is loaded via require('./cycle-action-executor') and
  // _injectDependencies may not have been called with all deps.
  const browser = _deps.browser || (() => { try { return require('./browser'); } catch { return {}; } })();
  const providersBase = _deps.providersBase || (() => { try { return require('./providers-base'); } catch { return {}; } })();
  const gestures = _deps.flutterGestures || (() => { try { return require('./flutter-gesture-simulator'); } catch { return {}; } })();
  const adaptiveEngine = _deps.adaptivePerformanceEngine || null;
  const providers = _deps.providers || (() => { try { return require('./providers'); } catch { return {}; } })();
  const progressTracker = _deps.progressTracker || (() => { try { return require('./progress-tracker'); } catch { return {}; } })();
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

  // Dispatch to handler
  const handler = ACTION_HANDLERS[action.actionType];
  if (handler) {
    try {
      await handler({
        page, action, CONFIG, wm, browser, providersBase, gestures,
        adaptiveEngine, providers, progressTracker, policyEngine, toAbsolute,
      });
    } catch (e: any) {
      log(`Handler for ${action.actionType} threw: ${e.message}`, 'ERROR', 'action');
    }
  } else {
    log(`Unknown action: ${action.actionType}`, 'WARN', 'action');
    await sleep(CONFIG.BETWEEN_STEPS_MS * wm);
  }

  // Track progress
  progressTracker.trackProgress?.({ action: action.actionType, state: action.currentState });
}

module.exports = { executeAction, _injectDependencies };
