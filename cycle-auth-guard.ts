'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): any { return _deps.config || {}; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

const { retryWithBackoff } = require('./providers-base');

let authAttempts = 0;

// FIX: Track consecutive captcha failures across cycles to detect
// captcha feedback loops that burn Render hours for nothing.
let _consecutiveCaptchaFailures = 0;
const MAX_CONSECUTIVE_CAPTCHA_FAILURES = 3;

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
    const origin = new URL(url).origin;
    const hostname = new URL(url).hostname;
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
    log(`SPA check: URL ${url} is not a recognized SPA domain`, 'DEBUG', 'auth-guard');
    return false;
  }

  // Content-based validation: look for MathU app elements in the page
  try {
    const hasAppShell = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const hasAssignments = body.includes('Assignments') || body.includes('assignments');
      const hasCourses = body.includes('Courses') || body.includes('courses');
      const hasCrawford = body.includes('Crawford') || body.includes('crawford');
      return hasAssignments || hasCourses || hasCrawford;
    }).catch(() => false);

    if (hasAppShell) {
      log('SPA check: MathU app elements detected — session valid', 'DEBUG', 'auth-guard');
      return true;
    }

    const hasFlutterCanvas = await page.evaluate(() => {
      const canvases = document.querySelectorAll('canvas');
      for (const c of canvases) {
        const cls = (c.className || '').toString();
        if (cls.includes('flt') || cls.includes('flutter')) return true;
      }
      const glassPane = document.querySelector('flt-glass-pane');
      if (glassPane) return true;
      return false;
    }).catch(() => false);

    if (hasFlutterCanvas) {
      log('SPA check: Flutter canvas detected — assuming session valid', 'DEBUG', 'auth-guard');
      return true;
    }

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

    log('SPA check: No contradictory signals on SPA domain — assuming valid', 'DEBUG', 'auth-guard');
    return true;
  } catch (err: any) {
    log(`SPA check: evaluate failed (${err.message}) — assuming valid`, 'WARN', 'auth-guard');
    return true;
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
    log('SPA session invalid, re-authenticating...', 'WARN', 'auth-guard');
  } else {
    if (url.includes('/assignments')) { authAttempts = 0; return page; }
  }

  // ── Re-authentication flow ──
  if (url.includes('login.microsoftonline.com') || url.includes(CONFIG.APP_URL) || _isSpaDomain(url)) {
    log('Session expired, re-authenticating...', 'WARN', 'auth-guard');
    authAttempts++;
    if (authAttempts > CONFIG.MAX_AUTH_ATTEMPTS) {
      try { (_deps.alerting?.sendAlert || (() => {}))('Max authentication attempts exceeded'); } catch (alertErr: any) { log('Failed to send auth failure alert', 'ERROR', 'auth-guard'); }
      throw new Error('Max authentication attempts exceeded');
    }
    const refreshed = await auth.refreshSession?.(page);
    if (refreshed) { authAttempts = 0; return page; }

    // refreshSession (→ authenticate) returned false = "no strategy matched,
    // delegating to vision tribunal". The page might still be usable — the
    // tribunal can handle it visually. Check the actual page state before
    // nuking the browser.
    const postRefreshUrl = page.url();
    const stillOnAppDomain = _isSpaDomain(postRefreshUrl);
    const redirectedToLogin = postRefreshUrl.includes('login.microsoftonline.com') || postRefreshUrl.includes('login.live.com');

    if (stillOnAppDomain && !redirectedToLogin) {
      // Page is still on the app domain — session is likely valid, auth
      // strategies just can't recognize the page layout. Let the tribunal
      // handle it. Do NOT close the browser.
      log('Auth returned false but page remains on app domain — continuing to tribunal', 'INFO', 'auth-guard');
      authAttempts = 0;
      return page;
    }

    // Genuinely unauthenticated (redirected to Microsoft login or unknown domain)
    await browser.closeBrowser?.();
    const newPage = await retryWithBackoff(browser.launchBrowser, { maxRetries: 2 });
    try {
      await auth.authenticate?.(newPage);
      authAttempts = 0;
      return newPage;
    } catch (authErr: any) {
      // FIX: Distinguish MFA_REQUIRED from other auth failures.
      // MFA is permanent — no point retrying, escalate immediately.
      const errMsg = authErr?.message || '';
      if (errMsg.includes('MFA_REQUIRED')) {
        log('MFA required — alerting and entering long sleep to avoid hour burn', 'ERROR', 'auth-guard');
        try { (_deps.alerting?.sendAlert || (() => {}))('MFA required — human intervention needed. Bot entering DORMANT.', 1); } catch {}
        // Trigger degradation to DORMANT to stop burning hours
        try {
          const { degradationLadder } = require('./self-heal-degradation-ladder');
          degradationLadder.setLevel(4, 'MFA_REQUIRED — cannot authenticate without human intervention');
        } catch {}
        throw new Error('MFA_REQUIRED: Cannot proceed without human MFA intervention');
      }
      throw authErr;
    }
  }
  return page;
}

async function handleCaptcha(page: any) {
  const CONFIG = getCONFIG();
  const auth = _deps.auth || {};
  if (await auth.detectCaptcha?.(page)) {
    log('CAPTCHA detected.', 'WARN', 'auth-guard');
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
      // FIX: Original code entered a 44-minute backoff loop that burned Render hours.
      // New behavior: track consecutive failures across cycles. If we've failed
      // N times in a row, enter DORMANT for a long sleep instead of burning hours.
      _consecutiveCaptchaFailures++;
      log(`CAPTCHA failed after ${attempts} attempts (consecutive failures: ${_consecutiveCaptchaFailures})`, 'ERROR', 'auth-guard');

      if (_consecutiveCaptchaFailures >= MAX_CONSECUTIVE_CAPTCHA_FAILURES) {
        log(`CAPTCHA feedback loop detected (${_consecutiveCaptchaFailures} consecutive). Entering DORMANT to stop burning Render hours.`, 'ERROR', 'auth-guard');
        try { (_deps.alerting?.sendAlert || (() => {}))(`CAPTCHA loop: ${_consecutiveCaptchaFailures} consecutive failures. Bot entering DORMANT for 2 hours.`, 1); } catch {}

        // Enter DORMANT to stop burning hours
        try {
          const { degradationLadder } = require('./self-heal-degradation-ladder');
          degradationLadder.setLevel(4, `CAPTCHA_LOOP: ${_consecutiveCaptchaFailures} consecutive captcha failures`);
        } catch {}

        // Sleep for 2 hours instead of a 44-minute retry loop.
        // This preserves ~1.9 of the 2 hours that would have been wasted.
        log('Sleeping for 2 hours to conserve Render hours...', 'WARN', 'auth-guard');
        await sleep(2 * 60 * 60 * 1000);
        throw new Error('CAPTCHA_LOOP: Sleeping after repeated captcha failures');
      }

      // First/second consecutive failure: short backoff (max 5 minutes total, not 44 minutes)
      const shortDelay = Math.min(60000 * _consecutiveCaptchaFailures, 300000); // 1-5 minutes
      log(`CAPTCHA backoff: ${Math.round(shortDelay / 1000)}s (failure ${_consecutiveCaptchaFailures}/${MAX_CONSECUTIVE_CAPTCHA_FAILURES})`, 'WARN', 'auth-guard');
      await new Promise(r => setTimeout(r, shortDelay));
      if (await auth.solveCaptcha?.(page)) {
        _consecutiveCaptchaFailures = 0;
        return;
      }
      throw new Error('CAPTCHA could not be solved after retries');
    }

    // Reset counter on success
    _consecutiveCaptchaFailures = 0;
  }
}

/**
 * Reset the consecutive captcha failure counter.
 * Called when a cycle completes successfully (captcha was either not needed or solved).
 */
function resetCaptchaFailureCount(): void {
  if (_consecutiveCaptchaFailures > 0) {
    log(`Reset captcha failure counter (was ${_consecutiveCaptchaFailures})`, 'DEBUG', 'auth-guard');
  }
  _consecutiveCaptchaFailures = 0;
}

/**
 * Get the current consecutive captcha failure count (for diagnostics).
 */
function getCaptchaFailureCount(): number {
  return _consecutiveCaptchaFailures;
}

module.exports = { ensureAuthenticated, handleCaptcha, resetCaptchaFailureCount, getCaptchaFailureCount, _injectDependencies };
