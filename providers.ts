'use strict';

// Last modified: 2026-08-05 — Response 20: Updated compression to 768px quality 30
const { getAvailableProviders, resetCycleProviderState, addProviderFailure, getProviderCycleState, registerDynamicProvider } = require('./providers-registry');
const { runTribunal } = require('./providers-tribunal');
const { getStats, updateStats } = require('./providers-stats');
const { detectNewWork } = require('./providers-detection-work-detector');
const { solveCaptchaWithVision } = require('./providers-detection-captcha-solver');
const { extractMicrosoftCaptchaText } = require('./providers-detection-captcha-text-extractor');
const { checkModuleCompletionViaVision } = require('./providers-detection-module-completion');
const { findSignInButtonCoordinates } = require('./providers-detection-signin-button');
const { findCollapsedCardsCoordinates } = require('./providers-detection-collapsed-cards');
const { safeCall, coalescer } = require('./providers-base');

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): any { return _deps.config || {}; }
function getLog(): (msg: string, level?: string, _module?: string) => void {
  return _deps.logger?.log || console.log;
}
function getLogError(): (msg: string, err: Error, ctx?: any) => void {
  return _deps.logger?.logError || ((msg: string, err: Error) => console.error(msg, err));
}
function getCache() { return _deps.cache || {}; }
function getBrowser() { return _deps.browser || {}; }


async function determineNextAction(base64Image: string, pageUrl: string | null = null, uiMap: any = null) { 
  const CONFIG = getCONFIG();
  const logError = getLogError();
  const { compressScreenshot } = getBrowser();
  const _compress = typeof compressScreenshot === 'function' ? compressScreenshot : (img: string, _w?: number, _q?: number) => img;
  const { getCachedAction, setCachedAction } = getCache();
  const compressed = await _compress(base64Image, 768, 30);
  const cached = getCachedAction(base64Image);
  if (cached) return cached;
  const key = `action:${crypto.createHash('sha256').update(compressed).digest('hex')}`;
  const action = await coalescer.execute(key, async () => {
    if (CONFIG.SAVE_SCREENSHOTS) {
      try {
        const dir = CONFIG.SCREENSHOT_DIR;
        const files = fs.readdirSync(dir).filter((f: string) => f.endsWith('.jpg'));
        while (files.length >= CONFIG.MAX_SCREENSHOTS) { const oldest = files.sort((a: string, b: string) => { try { return fs.statSync(path.join(dir, a)).mtimeMs - fs.statSync(path.join(dir, b)).mtimeMs; } catch { return 0; } })[0]; fs.unlinkSync(path.join(dir, oldest)); files.shift(); }
        const filename = `screenshot_${Date.now()}.jpg`;
        fs.writeFileSync(path.join(dir, filename), Buffer.from(compressed, 'base64'));
      } catch (e: any) { logError('Failed to save screenshot', e as Error); }
    }
    let action;
    // Call runTribunal directly — it has its own internal 120s AbortController
    // timeout. Wrapping it in another safeCall here created a race where this
    // layer's timeout fired ~5ms before the tribunal's own, aborting consensus
    // computation and orphaning valid results.
    try { action = await runTribunal(compressed, pageUrl, uiMap); } catch (err: any) { logError('Tribunal failed, using fallback', err as Error); action = { actionType: 'wait', currentState: 'error', reasoning: 'Fallback due to tribunal failure', targetX: 0, targetY: 0 }; }
    return action;
  }, 5000);
  setCachedAction(base64Image, action);
  return action;
}

module.exports = { determineNextAction, detectNewWork, resetCycleProviderState, getAvailableProviders, solveCaptchaWithVision, extractMicrosoftCaptchaText, checkModuleCompletionViaVision, findSignInButtonCoordinates, findCollapsedCardsCoordinates, getStats, updateStats, registerDynamicProvider, _injectDependencies };
