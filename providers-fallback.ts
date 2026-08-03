'use strict';

// Lazy requires to avoid top-level dependency on heavy browser module
// Try visual recovery first (works even after major UI redesigns)
async function getFallbackAction(page: any) { 
  const { log } = require('./logger');
  try {
    const { generateRecoveryAction } = require('./longevity-ui-recovery');
    const recoveryAction = await generateRecoveryAction(page);
    if (recoveryAction) { return recoveryAction; }
  } catch (e: any) { log(`UI recovery failed, falling back to heuristic detection: ${e.message || e}`, 'DEBUG', 'fallback'); }

  const url = page.url();
  // Get viewport dimensions to convert pixel coords to fractional (0-1) coords
  const { getPageViewport } = require('./browser');
  const viewport = getPageViewport(page) || { width: 1280, height: 800 };
  const vw = viewport.width;
  const vh = viewport.height;

  // The main action pipeline uses absolute pixel coords. If fractional coords are
  // needed, the caller should normalize. Here we return absolute coords for consistency.
  if (url.includes('/assignments')) {
    const watchBtn = await page.$('button:has-text("Watch")');
    if (watchBtn) { const box = await watchBtn.boundingBox(); if (box) return { actionType: 'click', currentState: 'assignments_page', targetX: Math.round(box.x + box.width/2), targetY: Math.round(box.y + box.height/2) }; }
    const startBtn = await page.$('button:has-text("Start")');
    if (startBtn) { const box = await startBtn.boundingBox(); if (box) return { actionType: 'click', currentState: 'assignments_page', targetX: Math.round(box.x + box.width/2), targetY: Math.round(box.y + box.height/2) }; }
    const card = await page.$('.module-card, .card');
    if (card) { const box = await card.boundingBox(); if (box) return { actionType: 'click', currentState: 'assignments_page', targetX: Math.round(box.x + box.width/2), targetY: Math.round(box.y + 30) }; }
  }
  if (url.includes('login.microsoftonline.com')) {
    const emailInput = await page.$('input[type="email"]');
    if (emailInput) { const box = await emailInput.boundingBox(); if (box) return { actionType: 'input_email', currentState: 'microsoft_email_input', targetX: Math.round(box.x + box.width/2), targetY: Math.round(box.y + box.height/2) }; }
    const passwordInput = await page.$('input[type="password"]');
    if (passwordInput) { const box = await passwordInput.boundingBox(); if (box) return { actionType: 'input_password', currentState: 'microsoft_password_input', targetX: Math.round(box.x + box.width/2), targetY: Math.round(box.y + box.height/2) }; }
  }
  return { actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 };
}

module.exports = { getFallbackAction };
