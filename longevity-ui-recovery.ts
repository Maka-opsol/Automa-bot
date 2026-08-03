'use strict';

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');
const crypto = require('crypto');

// Generic visual heuristics that work regardless of MathU's specific layout
const UNIVERSAL_PATTERNS = {
  signInButton: [
    'button:has-text("Sign in")', 'button:has-text("Log in")', 'button:has-text("Login")',
    'button:has-text("Next")', 'button:has-text("Continue")',
    'input[type="submit"]', 'button[type="submit"]',
  ],
  emailInput: [
    'input[type="email"]', 'input[name="email"]', 'input[name="loginfmt"]',
    'input[autocomplete="email"]', 'input[autocomplete="username"]',
    'input[placeholder*="email" i]', 'input[placeholder*="Email" i]',
  ],
  passwordInput: [
    'input[type="password"]', 'input[name="password"]', 'input[name="passwd"]',
    'input[autocomplete="current-password"]', 'input[placeholder*="password" i]',
  ],
  assignmentCard: [
    '.module-card', '.card', '[data-testid*="assignment"]', '[data-testid*="module"]',
    '[class*="assignment"]', '[class*="module"]', '[class*="card"]',
  ],
  watchButton: [
    'button:has-text("Watch")', 'button:has-text("Start")', 'button:has-text("Play")',
    'button:has-text("Begin")', 'button:has-text("Open")',
    'a:has-text("Watch")', '[role="button"]:has-text("Watch")',
  ],
  skipButton: [
    'button:has-text("Skip")', 'button:has-text("Next")', 'button:has-text("Continue")',
    'button:has-text("Done")', 'button:has-text("Finish")',
  ],
  videoPlayer: [
    'video', 'iframe[src*="youtube"]', 'iframe[src*="vimeo"]', '[class*="video"]',
    '[class*="player"]',
  ],
};

// Compute a page signature hash to detect major layout changes
async function computePageSignature(page: any) { 
  try {
    const sig = await page.evaluate(() => {
      // Collect structural features that are resilient to content changes
      const forms = document.querySelectorAll('form').length;
      const inputs = document.querySelectorAll('input').length;
      const buttons = document.querySelectorAll('button').length;
      const links = document.querySelectorAll('a').length;
      const images = document.querySelectorAll('img').length;
      const iframes = document.querySelectorAll('iframe').length;
      const hasVideo = !!document.querySelector('video');
      const bodyLen = document.body.innerText.length;
      // Get top-level class names (layout structure)
      const mainClasses = Array.from(document.body.children).map((el: any) => el.tagName + '.' + (el.className || '').toString().split(' ')[0]).join('|').substring(0, 500);
      return { forms, inputs, buttons, links, images, iframes, hasVideo, bodyLen, mainClasses };
    });
    const hash = crypto.createHash('md5').update(JSON.stringify(sig)).digest('hex');
    return { hash, signature: sig };
  } catch (e: any) { return null; }
}

// Try to find an element using a list of selectors
async function findElement(page: any, selectors: any) { 
  for (const selector of selectors) {
    try {
      const el = await page.$(selector);
      if (el) {
        const box = await el.boundingBox();
        if (box && box.width > 0 && box.height > 0) {
          return { element: el, selector, box };
        }
      }
    } catch (e: any) { continue; }
  }
  return null;
}

// Detect what kind of page we're on using heuristics, not hardcoded states
async function detectPageType(page: any) { 
  const url = page.url().toLowerCase();
  if (url.includes('login.microsoft') || url.includes('live.com') || url.includes('microsoftonline')) {
    // Check what step of MS login we're on
    const emailInput = await findElement(page, UNIVERSAL_PATTERNS.emailInput);
    if (emailInput) return { type: 'microsoft_email', confidence: 0.95 };
    const passwordInput = await findElement(page, UNIVERSAL_PATTERNS.passwordInput);
    if (passwordInput) return { type: 'microsoft_password', confidence: 0.95 };
    const nextButton = await findElement(page, UNIVERSAL_PATTERNS.signInButton);
    if (nextButton) return { type: 'microsoft_mfa_or_consent', confidence: 0.7 };
    return { type: 'microsoft_unknown', confidence: 0.5 };
  }
  if (url.includes('mathu') || url.includes('assignment')) {
    const watchButton = await findElement(page, UNIVERSAL_PATTERNS.watchButton);
    if (watchButton) return { type: 'assignments_ready', confidence: 0.9 };
    const video = await findElement(page, UNIVERSAL_PATTERNS.videoPlayer);
    if (video) return { type: 'video_playing', confidence: 0.85 };
    const card = await findElement(page, UNIVERSAL_PATTERNS.assignmentCard);
    if (card) return { type: 'assignments_browsing', confidence: 0.8 };
    return { type: 'mathu_unknown', confidence: 0.5 };
  }
  return { type: 'unknown', confidence: 0.3 };
}

// Generate a recovery action using pure visual heuristics (no AI needed)
async function generateRecoveryAction(page: any) { 
  const pageType = await detectPageType(page);
  log(`Visual recovery detected page type: ${pageType.type} (${(pageType.confidence*100).toFixed(0)}%)`, 'INFO', 'ui-recovery');

  switch (pageType.type) {
    case 'microsoft_email': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.emailInput);
      if (found) return { actionType: 'input_email', currentState: 'microsoft_email_input', targetX: found.box.x + found.box.width/2, targetY: found.box.y + found.box.height/2, reasoning: 'Visual recovery: found email input', recovery: true };
      break;
    }
    case 'microsoft_password': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.passwordInput);
      if (found) return { actionType: 'input_password', currentState: 'microsoft_password_input', targetX: found.box.x + found.box.width/2, targetY: found.box.y + found.box.height/2, reasoning: 'Visual recovery: found password input', recovery: true };
      break;
    }
    case 'microsoft_mfa_or_consent': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.signInButton);
      if (found) return { actionType: 'click', currentState: 'microsoft_consent', targetX: found.box.x + found.box.width/2, targetY: found.box.y + found.box.height/2, reasoning: 'Visual recovery: found Next/Continue button', recovery: true };
      break;
    }
    case 'assignments_ready': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.watchButton);
      if (found) return { actionType: 'click', currentState: 'assignments_page', targetX: found.box.x + found.box.width/2, targetY: found.box.y + found.box.height/2, reasoning: 'Visual recovery: found Watch/Start button', recovery: true };
      break;
    }
    case 'video_playing': {
      return { actionType: 'wait', currentState: 'video_playing', targetX: 0, targetY: 0, reasoning: 'Visual recovery: video is playing, waiting', recovery: true };
    }
    case 'assignments_browsing': {
      const found = await findElement(page, UNIVERSAL_PATTERNS.assignmentCard);
      if (found) return { actionType: 'click', currentState: 'assignments_page', targetX: found.box.x + found.box.width/2, targetY: found.box.y + 30, reasoning: 'Visual recovery: clicking assignment card', recovery: true };
      break;
    }
  }
  return null;
}

module.exports = { UNIVERSAL_PATTERNS, computePageSignature, findElement, detectPageType, generateRecoveryAction };
