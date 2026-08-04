'use strict';

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n// Longevity UI Recovery \u2014 Visual heuristic-based page recovery
// when the AI provider fails or returns an invalid action.
//
// Uses no AI \u2014 pure DOM heuristics to detect page type
// and generate recovery actions. This is the last resort before
// the bot gives up and waits for the next cycle.
//
// Render-aware: All page.evaluate calls wrapped in 2s timeouts.
// findElement uses per-selector Promise.race to avoid hanging.
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

const { log, logError } = require('./logger');
const crypto = require('crypto');

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n// Constants
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

// BUG FIX (Response 19): Per-selector timeout for findElement.
// On Render, page.$() can hang if the page is mid-navigation.
const SELECTOR_TIMEOUT_MS = 2000;

// BUG FIX (Response 19): page.evaluate timeout for computePageSignature.
const EVALUATE_TIMEOUT_MS = 2000;

// BUG FIX (Response 19): Maximum number of selectors to try per
// findElement call. Prevents O(n) delays when many selectors exist.
const MAX_SELECTORS_TO_TRY = 10;

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n// Generic visual heuristics that work regardless of MathU's specific layout
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

const UNIVERSAL_PATTERNS = {
  signInButton: [
    'button:has-text("Sign in")', 'button:has-text("Log in")', 'button:has-text("Login")',
    'button:has-text("Next")', 'button:has-text("Continue")',
    'input[type="submit"]', 'button[type="submit"]',
    // BUG FIX (Response 19): Added more Microsoft login variants
    'button:has-text("Sign in with Microsoft")',
    'a:has-text("Sign in with Microsoft")',
    '#idSIButton9',  // Microsoft's actual submit button ID
    'button[id*="signin"]',
  ],
  emailInput: [
    'input[type="email"]', 'input[name="email"]', 'input[name="loginfmt"]',
    'input[autocomplete="email"]', 'input[autocomplete="username"]',
    'input[placeholder*="email" i]', 'input[placeholder*="Email" i]',
    // BUG FIX (Response 19): Added Microsoft-specific selectors
    '#i0116',
    'input[aria-label*="email" i]',
  ],
  passwordInput: [
    'input[type="password"]', 'input[name="password"]', 'input[name="passwd"]',
    'input[autocomplete="current-password"]', 'input[placeholder*="password" i]',
    // BUG FIX (Response 19): Added Microsoft-specific selectors
    '#i0118',
    'input[aria-label*="password" i]',
  ],
  assignmentCard: [
    '.module-card', '.card', '[data-testid*="assignment"]', '[data-testid*="module"]',
    '[class*="assignment"]', '[class*="module"]', '[class*="card"]',
    // BUG FIX (Response 19): Added Flutter-specific card selectors
    '.flt-glass-pane [class*="card"]',
    '[role="listitem"]',
  ],
  watchButton: [
    'button:has-text("Watch")', 'button:has-text("Start")', 'button:has-text("Play")',
    'button:has-text("Begin")', 'button:has-text("Open")',
    'a:has-text("Watch")', '[role="button"]:has-text("Watch")',
    // BUG FIX (Response 19): Added Redo variant
    'button:has-text("Redo")', 'a:has-text("Redo")',
  ],
  skipButton: [
    'button:has-text("Skip")', 'button:has-text("Next")', 'button:has-text("Continue")',
    'button:has-text("Done")', 'button:has-text("Finish")',
    // BUG FIX (Response 19): Added more completion variants
    'button:has-text("Complete")', 'button:has-text("Submit")',
  ],
  videoPlayer: [
    'video', 'iframe[src*="youtube"]', 'iframe[src*="vimeo"]', '[class*="video"]',
    '[class*="player"]',
    // BUG FIX (Response 19): Added MathU-specific video indicators
    '[class*="video-player"]', '[data-testid*="video"]',
  ],
  // BUG FIX (Response 19): New pattern \u2014 question/answer area
  questionArea: [
    '[class*="question"]', '[data-testid*="question"]',
    '[class*="answer"]', '[class*="option"]',
    '[role="radiogroup"]', '[role="listbox"]',
  ],
};

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\n// Page signature computation
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

/**
 * Compute a structural page signature hash.
 * Used to detect major layout changes across cycles.
 *
 * BUG FIX (Response 19): page.evaluate is now wrapped in a timeout
 * via Promise.race so it can't hang on Render's slow CPU.
 */
async function computePageSignature(page: any) {
  try {
    const evalPromise = page.evaluate(() => {
      const forms = document.querySelectorAll('form').length;
      const inputs = document.querySelectorAll('input').length;
      const buttons = document.querySelectorAll('button').length;
      const links = document.querySelectorAll('a').length;
      const images = document.querySelectorAll('img').length;
      const iframes = document.querySelectorAll('iframe').length;
      const hasVideo = !!document.querySelector('video');
      const bodyLen = document.body.innerText.length;
      const mainClasses = Array.from(document.body.children)
        .map((el: any) => el.tagName + '.' + (el.className || '').toString().split(' ')[0])
        .join('|').substring(0, 500);
      return { forms, inputs, buttons, links, images, iframes, hasVideo, bodyLen, mainClasses };
    });
    const sig = await Promise.race([
      evalPromise,
      new Promise<null>(resolve => setTimeout(() => resolve(null), EVALUATE_TIMEOUT_MS)),
    ]);
    if (!sig) {
      log('Page signature evaluation timed out', 'WARN', 'ui-recovery');
      return null;
    }
    const hash = crypto.createHash('md5').update(JSON.stringify(sig)).digest('hex');
    return { hash, signature: sig };
  } catch (e: any) { return null; }
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Element finding with per-selector timeout
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

/**
 * Try to find a visible element using a list of selectors.
 *
 * BUG FIX (Response 19): Each selector is now wrapped in Promise.race
 * with a 2s timeout. Previously, a single slow selector could block
 * the entire recovery for 30+ seconds on Render.
 * Also capped at MAX_SELECTORS_TO_TRY to prevent long loops.
 */
async function findElement(page: any, selectors: any) {
  const selectorList = Array.isArray(selectors) ? selectors : [selectors];
  const toTry = selectorList.slice(0, MAX_SELECTORS_TO_TRY);

  for (const selector of toTry) {
    try {
      // BUG FIX (Response 19): Race each page.$() against timeout
      const findPromise = page.$(selector);
      const timeoutPromise = new Promise<null>(resolve =>
        setTimeout(() => resolve(null), SELECTOR_TIMEOUT_MS)
      );
      const el = await Promise.race([findPromise, timeoutPromise]);
      if (!el) continue;

      // Verify element is visible (has bounding box with positive dimensions)
      const boxPromise = el.boundingBox();
      const boxTimeout = new Promise<null>(resolve =>
        setTimeout(() => resolve(null), SELECTOR_TIMEOUT_MS)
      );
      const box = await Promise.race([boxPromise, boxTimeout]);
      if (box && box.width > 0 && box.height > 0) {
        return { element: el, selector, box };
      }
    } catch (e: any) { continue; }
  }
  return null;
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Page type detection
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

// URL pattern matchers for page type detection
const URL_PATTERNS: Record<string, RegExp[]> = {
  microsoft: [/login\.microsoft/i, /live\.com/i, /microsoftonline/i],
  mathu: [/mathu/i, /assignment/i],
};

/**
 * Detect what kind of page we're on using heuristics, not hardcoded states.
 *
 * BUG FIX (Response 19): Added questionArea detection for math question pages.
 * URL matching extracted to URL_PATTERNS for maintainability.
 */
async function detectPageType(page: any) {
  let url: string;
  try { url = page.url(); } catch { url = ''; }
  const urlLower = url.toLowerCase();

  // Check Microsoft login flow
  for (const pattern of URL_PATTERNS.microsoft) {
    if (pattern.test(urlLower)) {
      const emailInput = await findElement(page, UNIVERSAL_PATTERNS.emailInput);
      if (emailInput) return { type: 'microsoft_email', confidence: 0.95 };
      const passwordInput = await findElement(page, UNIVERSAL_PATTERNS.passwordInput);
      if (passwordInput) return { type: 'microsoft_password', confidence: 0.95 };
      const nextButton = await findElement(page, UNIVERSAL_PATTERNS.signInButton);
      if (nextButton) return { type: 'microsoft_mfa_or_consent', confidence: 0.7 };
      return { type: 'microsoft_unknown', confidence: 0.5 };
    }
  }

  // Check MathU platform
  for (const pattern of URL_PATTERNS.mathu) {
    if (pattern.test(urlLower)) {
      const watchButton = await findElement(page, UNIVERSAL_PATTERNS.watchButton);
      if (watchButton) return { type: 'assignments_ready', confidence: 0.9 };
      const video = await findElement(page, UNIVERSAL_PATTERNS.videoPlayer);
      if (video) return { type: 'video_playing', confidence: 0.85 };
      // BUG FIX (Response 19): Check for question area before assignment cards
      const question = await findElement(page, UNIVERSAL_PATTERNS.questionArea);
      if (question) return { type: 'question_page', confidence: 0.85 };
      const card = await findElement(page, UNIVERSAL_PATTERNS.assignmentCard);
      if (card) return { type: 'assignments_browsing', confidence: 0.8 };
      return { type: 'mathu_unknown', confidence: 0.5 };
    }
  }

  return { type: 'unknown', confidence: 0.3 };
}

// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550
// Recovery action generation
// \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550

/**
 * Generate a recovery action using pure visual heuristics (no AI needed).
 *
 * BUG FIX (Response 19): Added question_page case and better error handling.
 */
async function generateRecoveryAction(page: any) {
  const pageType = await detectPageType(page);
  log(`Visual recovery detected page type: ${pageType.type} (${(pageType.confidence * 100).toFixed(0)}%)`, 'INFO', 'ui-recovery');

  switch (pageType.type) {
    case 'microsoft_email': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.emailInput);
      if (found) return {
        actionType: 'input_email', currentState: 'microsoft_email_input',
        targetX: found.box.x + found.box.width / 2, targetY: found.box.y + found.box.height / 2,
        reasoning: 'Visual recovery: found email input', recovery: true,
      };
      break;
    }
    case 'microsoft_password': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.passwordInput);
      if (found) return {
        actionType: 'input_password', currentState: 'microsoft_password_input',
        targetX: found.box.x + found.box.width / 2, targetY: found.box.y + found.box.height / 2,
        reasoning: 'Visual recovery: found password input', recovery: true,
      };
      break;
    }
    case 'microsoft_mfa_or_consent': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.signInButton);
      if (found) return {
        actionType: 'click', currentState: 'microsoft_consent',
        targetX: found.box.x + found.box.width / 2, targetY: found.box.y + found.box.height / 2,
        reasoning: 'Visual recovery: found Next/Continue button', recovery: true,
      };
      break;
    }
    case 'assignments_ready': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.watchButton);
      if (found) return {
        actionType: 'click', currentState: 'assignments_page',
        targetX: found.box.x + found.box.width / 2, targetY: found.box.y + found.box.height / 2,
        reasoning: 'Visual recovery: found Watch/Start button', recovery: true,
      };
      break;
    }
    case 'video_playing': {
      return {
        actionType: 'wait', currentState: 'video_playing',
        targetX: 0, targetY: 0,
        reasoning: 'Visual recovery: video is playing, waiting', recovery: true,
      };
    }
    case 'assignments_browsing': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.assignmentCard);
      if (found) return {
        actionType: 'click', currentState: 'assignments_page',
        targetX: found.box.x + found.box.width / 2, targetY: found.box.y + 30,
        reasoning: 'Visual recovery: clicking assignment card', recovery: true,
      };
      break;
    }
    // BUG FIX (Response 19): New case \u2014 question page detected
    // but no specific answer element found. Signal that AI is needed.
    case 'question_page': {
      return {
        actionType: 'wait', currentState: 'question_visible',
        targetX: 0, targetY: 0,
        reasoning: 'Visual recovery: question page detected, deferring to AI for answer selection',
        recovery: true,
      };
    }
  }
  return null;
}

module.exports = { UNIVERSAL_PATTERNS, computePageSignature, findElement, detectPageType, generateRecoveryAction };
