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
 *   4. Is the page actually rendered (not blank Flutter canvas/spinner)?
 * A Flutter canvas alone is NOT sufficient — it could be a blank white
 * screen where the app failed to render. We must verify real content.
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
    // ── BLANK PAGE DETECTION (must run BEFORE canvas check) ──
    // A blank white Flutter canvas or loading spinner does NOT count as
    // a valid authenticated session. Check for actual rendered content.
    // CRITICAL: Flutter Web reports body height = viewport height (e.g. 768)
    // even when the canvas is completely blank. Do NOT use contentHeight
    // to detect blank Flutter pages — use text length instead.
    const pageContentSignal = await page.evaluate(() => {
      const body = document.body;
      if (!body) return { blank: true, reason: 'no_body' };

      const text = (body.innerText || '').trim();
      const textLen = text.length;

      // Check for loading spinner indicators (common in Flutter)
      const html = body.innerHTML || '';
      const hasSpinner = html.includes('loading') || html.includes('spinner') ||
                         html.includes('progress') || html.includes('CircularProgressIndicator');

      // Check for Flutter canvas elements
      const canvases = document.querySelectorAll('canvas');
      let hasFlutterCanvas = false;
      for (const c of canvases) {
        const cls = (c.className || '').toString();
        if (cls.includes('flt') || cls.includes('flutter')) { hasFlutterCanvas = true; break; }
      }
      if (!hasFlutterCanvas && document.querySelector('flt-glass-pane')) hasFlutterCanvas = true;

      return {
        blank: false,
        textLen,
        hasSpinner,
        hasFlutterCanvas,
        // Heuristic: Flutter canvas with very little text = blank/unrendered
        // (height is unreliable — Flutter always reports viewport height)
        isBlankCanvas: hasFlutterCanvas && textLen < 100,
        // Heuristic: if no text at all and no canvas, page is empty
        isEmpty: textLen === 0 && !hasFlutterCanvas,
      };
    }).catch(() => null);

    // If the page is a blank canvas or completely empty, NOT valid
    if (pageContentSignal) {
      if (pageContentSignal.isBlankCanvas) {
        log('SPA check: Flutter canvas exists but page is BLANK (no content rendered) — session NOT valid', 'WARN', 'auth-guard');
        return false;
      }
      if (pageContentSignal.isEmpty) {
        log('SPA check: Page is completely empty — session NOT valid', 'WARN', 'auth-guard');
        return false;
      }
    }

    const hasAppShell = await page.evaluate(() => {
      const body = document.body?.innerText || '';
      const hasAssignments = body.includes('Assignments') || body.includes('assignments');
      const hasCourses = body.includes('Courses') || body.includes('courses');
      const hasCrawford = body.includes('Crawford') || body.includes('crawford');
      // Also check for authenticated user indicators beyond nav labels
      const hasDashboard = body.includes('Dashboard') || body.includes('dashboard');
      const hasTopics = body.includes('Topics') || body.includes('topics');
      const hasProfile = body.includes('Profile') || body.includes('profile');
      const hasSignOut = body.includes('Sign out') || body.includes('sign out') || body.includes('Logout');
      return hasAssignments || hasCourses || hasCrawford || hasDashboard || hasTopics || hasProfile || hasSignOut;
    }).catch(() => false);

    if (hasAppShell) {
      log('SPA check: MathU app elements detected — session valid', 'DEBUG', 'auth-guard');
      return true;
    }

    // ── FLUTTER CANVAS CHECK (only if content signals above didn't match) ──
    // A Flutter canvas alone is NO longer sufficient. We already checked for
    // blank canvas above. If we reach here, the canvas has some content but
    // no recognizable MathU text. This could be a partially-loaded page.
    // Only accept if there is substantial text content (not just a spinner).
    if (pageContentSignal?.hasFlutterCanvas && !pageContentSignal?.hasSpinner) {
      // Canvas exists, not blank, not spinning — could be a quiz or modal
      // with non-standard text. Accept IF there's reasonable text content.
      if (pageContentSignal.textLen > 50) {
        log(`SPA check: Flutter canvas with ${pageContentSignal.textLen} chars text (no MathU labels) — accepting as likely valid`, 'DEBUG', 'auth-guard');
        return true;
      }
      // Very little text with canvas but no MathU labels — probably loading
      log('SPA check: Flutter canvas with minimal text and no MathU labels — session uncertain, treating as NOT valid', 'WARN', 'auth-guard');
      return false;
    }

    // No canvas, no app shell, no content — check for sign-in prompts
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

    // No canvas, no app shell, no sign-in, no content — page is likely still loading
    log('SPA check: No Flutter canvas, no app elements, no sign-in — page still loading or unresponsive', 'WARN', 'auth-guard');
    return false;
  } catch (err: any) {
    log(`SPA check: evaluate failed (${err.message}) — treating as NOT valid (was: assume valid)`, 'WARN', 'auth-guard');
    return false;
  }
}

/**
 * Check if the page is blank/unrendered — used by ensureAuthenticated to
 * decide whether to delegate to the tribunal (has content) or escalate
 * via reload/restart (blank canvas).
 *
 * CRITICAL: Flutter Web canvases report body height = viewport height (e.g. 768)
 * even when completely blank. We cannot rely on contentHeight to detect blank
 * Flutter pages. Instead, check text content length and Flutter canvas state.
 */
async function _isPageBlank(page: any): Promise<boolean> {
  try {
    const signal = await page.evaluate(() => {
      const body = document.body;
      if (!body) return { blank: true, reason: 'no_body' };
      const text = (body.innerText || '').trim();
      const textLen = text.length;

      // Check for Flutter canvas
      const canvases = document.querySelectorAll('canvas');
      let hasFlutterCanvas = false;
      for (const c of canvases) {
        const cls = (c.className || '').toString();
        if (cls.includes('flt') || cls.includes('flutter')) { hasFlutterCanvas = true; break; }
      }
      if (!hasFlutterCanvas && document.querySelector('flt-glass-pane')) hasFlutterCanvas = true;

      // Check for loading spinner indicators
      const html = body.innerHTML || '';
      const hasSpinner = html.includes('loading') || html.includes('spinner') ||
                         html.includes('progress') || html.includes('CircularProgressIndicator');

      // Blank = Flutter canvas exists but very little text content
      // (regardless of reported height — Flutter always reports viewport height)
      // OR no canvas and no text at all
      if (hasFlutterCanvas) {
        // Flutter canvas with < 100 chars of text = blank/unrendered
        // (100 chars allows for small UI elements while catching blank canvases)
        return { blank: textLen < 100, reason: `flutter_canvas_textlen_${textLen}` };
      }
      // No canvas at all
      return { blank: textLen === 0, reason: `no_canvas_textlen_${textLen}` };
    }).catch(() => null);
    return signal?.blank === true;
  } catch { return false; }
}

/**
 * Check and clear the blank-page flag that ensureAuthenticated may have set.
 * Returns true if the flag was set (indicating auth detected a blank page).
 */
function consumeBlankPageFlag(page: any): boolean {
  if ((page as any)?._authBlankPage) {
    (page as any)._authBlankPage = false;
    return true;
  }
  return false;
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
      // FIX: Before letting tribunal handle a "still on app domain" page,
      // check if it's a blank/unrendered page. The tribunal will also fail
      // on a blank canvas, returning unknown/wait in an infinite loop.
      // If blank, report the exact state so the cycle manager can escalate.
      const isBlank = await _isPageBlank(page);
      if (isBlank) {
        log('Auth returned false, page on app domain but BLANK — reporting blank_loading state (not delegating to tribunal)', 'WARN', 'auth-guard');
        authAttempts = 0;
        // Return page but attach a flag so the cycle manager knows to
        // escalate (reload/restart) rather than entering the tribunal loop.
        (page as any)._authBlankPage = true;
        return page;
      }
      // Page has content — session is likely valid, auth strategies just
      // can't recognize the layout. Let the tribunal handle it visually.
      log('Auth returned false but page remains on app domain with content — continuing to tribunal', 'INFO', 'auth-guard');
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

module.exports = { ensureAuthenticated, handleCaptcha, resetCaptchaFailureCount, getCaptchaFailureCount, consumeBlankPageFlag, _isPageBlank, _injectDependencies };
