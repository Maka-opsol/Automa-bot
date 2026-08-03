'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): any { return _deps.config || {}; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function safeLog(obj: any, level?: string, mod?: string) { _deps.logger?.safeLog?.(obj, level, mod) ?? console.log(JSON.stringify(obj)); }

const { retryWithBackoff } = require('./providers-base');

let authAttempts = 0;

async function ensureAuthenticated(page: any) { 
  const CONFIG = getCONFIG();
  const auth = _deps.auth || {};
  const browser = _deps.browser || {};
  const url = page.url();
  if (url.includes('/assignments')) { authAttempts = 0; return page; }
  if (url.includes('login.microsoftonline.com') || url.includes(CONFIG.APP_URL)) {
    log('🔐 Session expired, re-authenticating...', 'WARN', 'auth-guard');
    authAttempts++;
    if (authAttempts > CONFIG.MAX_AUTH_ATTEMPTS) { if (CONFIG.ALERT_ON_AUTH_FAILURE) try { (_deps.alerting?.sendAlert || (() => {}))('Max authentication attempts exceeded'); } catch (alertErr: any) { log('Failed to send auth failure alert', 'ERROR', 'auth-guard'); } throw new Error('Max authentication attempts exceeded'); }
    const refreshed = await auth.refreshSession?.(page);
    if (refreshed) { authAttempts = 0; return page; }
    await browser.closeBrowser?.();
    const newPage = await retryWithBackoff(browser.launchBrowser, { maxRetries: 2 });
    await auth.authenticate?.(newPage);
    authAttempts = 0;
    return newPage;
  }
  return page;
}

async function handleCaptcha(page: any) { 
  const CONFIG = getCONFIG();
  const auth = _deps.auth || {};
  if (await auth.detectCaptcha?.(page)) {
    log('🧩 CAPTCHA detected.', 'WARN', 'auth-guard');
    let solved = false;
    let attempts = 0;
    while (!solved && attempts < CONFIG.CAPTCHA_MAX_ATTEMPTS) {
      attempts++;
      solved = await auth.solveCaptcha?.(page);
      if (!solved) {
        log(`CAPTCHA attempt ${attempts} failed. Reloading...`, 'WARN', 'auth-guard');
        await page.reload();
        await sleep(5000);
      }
    }
    if (!solved) {
      log('❌ Failed to solve CAPTCHA after max attempts. Waiting and retrying later.', 'ERROR', 'auth-guard');
      if (CONFIG.ALERT_ON_ERROR) try { (_deps.alerting?.sendAlert || (() => {}))('CAPTCHA solving failed after max attempts'); } catch (e: any) {}
      const baseDelay = 60000;
      for (let i = 0; i < 5; i++) {
        const delay = Math.min(baseDelay * Math.pow(2, i), 1800000);
        await new Promise(r => setTimeout(r, delay));
        if (await auth.solveCaptcha?.(page)) { solved = true; break; }
      }
      if (!solved) throw new Error('CAPTCHA could not be solved after multiple backoff attempts');
    }
  }
}

module.exports = { ensureAuthenticated, handleCaptcha, _injectDependencies };
