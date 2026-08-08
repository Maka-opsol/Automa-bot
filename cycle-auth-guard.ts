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

/**
 * Default SPA domains for MathU. On these domains the URL never changes
 * between pages (e.g. assignments, topics, quiz, score screen are all
 * rendered client-side under the same origin+path).
 * Config override: CONFIG.MATHU_SPA_DOMAINS (comma-separated).
 */
function _getSpaDomains(): string[] {
  const CONFIG = getCONFIG();
  const raw = (CONFIG.MATHU_SPA_DOMAINS || 'app.mathu.co.za,mathu.co.za') as string;
  return raw.split(',').map((d: string) => d.trim()).filter(Boolean);
}

/**
 * Check whether the current URL belongs to a known SPA domain where
 * path-based session validation is unreliable.
 */
function _isSpaDomain(url: string): boolean {
  try {
    const domains = _getSpaDomains();
    const origin = new URL(url).origin;               // e.g. https://app.mathu.co.za
    const hostname = new URL(url).hostname;             // e.g. app.mathu.co.za
    return domains.some(d => origin.includes(d) || hostname === d || hostname.endsWith('.' + d));
  } catch { return false; }
}

/**
 * Multi-signal SPA session validator.
 * Instead of checking for '/assignments' in the URL (which never appears
 * on a Flutter Web SPA), we look at:
 *   1. Is the page on a known MathU SPA domain?
 *   2. Is the page NOT on a Microsoft login domain?
 *   3. Does the page body contain MathU app indicators?
 * If all pass → session is valid, no re-auth needed.
 */
async function _isSpaSessionValid(page: any): Promise<boolean> {
  const url = page.url();

  // Negative signal: if we landed on Microsoft login, session is NOT valid
  if (url.includes('login.microsoftonline.com') || url.includes('login.live.com')) {
    log('SPA check: on Microsoft login domain — session invalid', 'DEBUG', 'auth-guard');
    return false;
  }

  // Positive signal: on MathU SPA domain
  if (!_isSpaDomain(url)) {
    // Not on a MathU SPA domain at all — could be an error page or redirect
    log(`SPA check: URL ${url} is not a recognized SPA domain`, 'DEBUG', 'auth-guard');
    return false;
  }

  // Content-based validation: look for MathU app elements in the page
  try {
    // Strategy 1: Check for sidebar nav or main app shell
    const hasAppShell = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      // MathU dashboard shows "Assignments" and "Courses" in sidebar
      const hasAssignments = body.includes('Assignments') || body.includes('assignments');
      const hasCourses = body.includes('Courses') || body.includes('courses');
      // Crawford branding often visible in the app
      const hasCrawford = body.includes('Crawford') || body.includes('crawford');
      // Any of these indicate we're inside the MathU app shell
      return hasAssignments || hasCourses || hasCrawford;
    }).catch(() => false);

    if (hasAppShell) {
      log('SPA check: MathU app elements detected — session valid', 'DEBUG', 'auth-guard');
      return true;
    }

    // Strategy 2: Check for Flutter web canvas (MathU is Flutter-based)
    const hasFlutterCanvas = await page.evaluate(() => {
      // Flutter Web renders in a <flt-glass-pane> or canvases with specific classes
      const canvases = document.querySelectorAll('canvas');
      for (const c of canvases) {
        const cls = (c.className || '').toString();
        if (cls.includes('flt') || cls.includes('flutter')) return true;
      }
      // Also check for the glass-pane element
      const glassPane = document.querySelector('flt-glass-pane');
      if (glassPane) return true;
      return false;
    }).catch(() => false);

    if (hasFlutterCanvas) {
      log('SPA check: Flutter canvas detected — assuming session valid', 'DEBUG', 'auth-guard');
      return true;
    }

    // Strategy 3: Check for auth-related content (sign-in prompts, error pages)
    const hasSignInPrompt = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      return body.includes('Sign in') || body.includes('sign in') ||
             body.includes('Log in') || body.includes('log in') ||
             body.includes('Enter your email');
    }).catch(() => false);

    if (hasSignInPrompt) {
      log('SPA check: Sign-in prompt detected — session invalid', 'DEBUG', 'auth-guard');
      return false;
    }

    // Fallback: on SPA domain with no contradictory signals — assume valid
    // This prevents false re-auth triggers when the page is still loading
    log('SPA check: No contradictory signals on SPA domain — assuming valid', 'DEBUG', 'auth-guard');
    return true;
  } catch (err: any) {
    log(`SPA check: evaluate failed (${err.message}) — assuming valid`, 'WARN', 'auth-guard');
    return true; // Fail-open: don't re-auth on evaluation errors
  }
}

async function ensureAuthenticated(page: any) { 
  const CONFIG = getCONFIG();
  const auth = _deps.auth || {};
  const browser = _deps.browser || {};
  const url = page.url();

  // ── SPA-aware session validation ──
  if (_isSpaDomain(url)) {
    const valid = await _isSpaSessionValid(page);
    if (valid) {
      authAttempts = 0;
      return page;
    }
    // If invalid, fall through to re-auth below
    log('🔐 SPA session invalid, re-authenticating...', 'WARN', 'auth-guard');
  } else {
    // Non-SPA path: use original URL-based check (for non-SPA deployments)
    if (url.includes('/assignments')) { authAttempts = 0; return page; }
  }

  // ── Re-authentication flow (triggers for both SPA and non-SPA) ──
  if (url.includes('login.microsoftonline.com') || url.includes(CONFIG.APP_URL) || _isSpaDomain(url)) {
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
