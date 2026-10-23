'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): any { return _deps.config || {}; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

const zlib = require('zlib');

// Lazy import — providers-base is heavy and may not be available during
// early DI initialization. Only needed in the non-SPA auth fallback path.
let _retryWithBackoff: ((fn: any, opts: any) => Promise<any>) | null = null;
function _getRetryWithBackoff() {
  if (_retryWithBackoff) return _retryWithBackoff;
  try { _retryWithBackoff = require('./providers-base').retryWithBackoff; } catch {}
  return _retryWithBackoff;
}

let authAttempts = 0;

// ─── Login-Flow Tracking ───────────────────────────────────────────────────
// BUG FIX (2026-09-04): The auth-guard previously treated every arrival on
// login.microsoftonline.com as a "session expired" event and aggressively
// re-authenticated by calling refreshSession → authenticate → strategy loop.
// When the bot itself had just clicked "Sign in with Microsoft" on the
// mathu_login page, this caused an infinite loop:
//
//   1. Tribunal: click on mathu_login (clicks "Sign in with Microsoft")
//   2. Page navigates to login.microsoftonline.com (EXPECTED, valid transition)
//   3. Next cycle's ensureAuthenticated() sees the Microsoft URL, thinks the
//      session expired, and calls refreshSession()
//   4. refreshSession runs MicrosoftAuthV2 strategy; if any selector fails
//      (very common on real Microsoft pages), it returns false
//   5. ensureAuthenticated sees we're "still on Microsoft login" and calls
//      browser.closeBrowser() + relaunch — bot is bounced back to MathU app
//   6. Bot is back at mathu_login state — clicks again → loop forever
//
// The fix: cycle-manager calls notifyLoginInitiated() immediately after
// executing a click on the mathu_login state. While that flag is set,
// ensureAuthenticated treats the Microsoft login URL as an EXPECTED
// destination (not session expiry) and returns the page as-is, allowing the
// tribunal to handle the microsoft_email_input state visually.
//
// The flag auto-expires after 5 minutes as a safety net in case
// notifyLoginCompleted() is never called (e.g., on crash / OOM).
let _loginFlowInitiatedAt: number | null = null;
const LOGIN_FLOW_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Notify the auth-guard that the bot has just initiated a Microsoft login
 * (typically by clicking "Sign in with Microsoft" on the mathu_login page).
 *
 * While this flag is set, arriving on login.microsoftonline.com is treated
 * as the EXPECTED result of that click, NOT as a session-expiry event.
 *
 * The flag is auto-cleared:
 *   - When the bot returns to a SPA (MathU) domain (login completed)
 *   - After LOGIN_FLOW_TIMEOUT_MS as a safety net
 */
function notifyLoginInitiated(): void {
  _loginFlowInitiatedAt = Date.now();
  log('Login flow initiated — auth-guard will treat Microsoft login URL as expected destination', 'INFO', 'auth-guard');
}

/**
 * Notify the auth-guard that the login flow has completed (the bot is back
 * on the MathU SPA domain, either via successful auth or by escaping back).
 * Clears the login-flow flag so future Microsoft redirects are treated as
 * real session expiries again.
 */
function notifyLoginCompleted(): void {
  if (_loginFlowInitiatedAt !== null) {
    log('Login flow completed — auth-guard resumes normal session-expiry detection', 'INFO', 'auth-guard');
  }
  _loginFlowInitiatedAt = null;
}

/**
 * Returns true if the bot has initiated a Microsoft login flow within the
 * last LOGIN_FLOW_TIMEOUT_MS milliseconds and we have not yet been notified
 * that the flow completed.
 */
function isLoginInProgress(): boolean {
  if (_loginFlowInitiatedAt === null) return false;
  const age = Date.now() - _loginFlowInitiatedAt;
  if (age > LOGIN_FLOW_TIMEOUT_MS) {
    log(`Login flow flag timed out after ${Math.round(age / 1000)}s — clearing (treating future Microsoft URLs as real session expiry)`, 'WARN', 'auth-guard');
    _loginFlowInitiatedAt = null;
    return false;
  }
  return true;
}

// ─── Pixel-based blank page detection ───────────────────────────────────
// Flutter Web renders everything to <canvas>, so innerText is always empty.
// Text-length heuristics are fundamentally broken for Flutter SPAs.
// Instead, sample 12 pixels in a 4x3 grid from a PNG screenshot.
// A page is blank only if ALL 12 pixels have near-zero variance
// (max standard deviation < 3 across R/G/B channels).
// Real content (text, buttons, images) always produces enough variance
// to exceed this threshold, even on pages with large solid-color areas.
// Uses PNG pixel sampling for accuracy, with JPEG fallback.

/**
 * Undo PNG row filters to get actual pixel values.
 * PNG rows have a filter byte prefix (0=None, 1=Sub, 2=Up, 3=Average, 4=Paeth).
 * The raw inflated data contains *filtered* bytes — not actual colors.
 * Skipping defiltering reads garbage that appears uniformly zero/identical.
 */
function _defilterPng(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const rs = y * (stride + 1) + 1; // raw row start (after filter byte)
    const os = y * stride;            // output row start
    for (let x = 0; x < stride; x++) {
      const a = raw[rs + x];
      const left  = x >= bpp       ? out[os + x - bpp] : 0;
      const up    = y > 0          ? out[os - stride + x] : 0;
      const upL   = (y > 0 && x >= bpp) ? out[os - stride + x - bpp] : 0;
      let v: number;
      switch (filter) {
        case 0: v = a; break;
        case 1: v = (a + left) & 0xFF; break;
        case 2: v = (a + up) & 0xFF; break;
        case 3: v = (a + ((left + up) >> 1)) & 0xFF; break;
        case 4: {
          const p = left + up - upL;
          const pa = Math.abs(p - left), pb = Math.abs(p - up), pc = Math.abs(p - upL);
          v = (pa <= pb && pa <= pc) ? (a + left) & 0xFF
            : (pb <= pc) ? (a + up) & 0xFF
            : (a + upL) & 0xFF;
          break;
        }
        default: v = a;
      }
      out[os + x] = v;
    }
  }
  return out;
}

/**
 * Sample ~35 pixels from a PNG screenshot buffer using a multi-strategy approach:
 *   1) 4 corners (inset 3% from edges)
 *   2) 1 centre pixel
 *   3) 5x4 grid (20 samples, inset 8% from edges)
 *   4) 10 random pixels (xorshift32, seeded from dimensions + time)
 * Deduplicates coordinates that overlap. Returns array of [r, g, b] tuples, or null on failure.
 */
function _samplePixelsFromPng(pngBuffer: Buffer): Array<[number, number, number]> | null {
  try {
    // Verify PNG signature
    if (pngBuffer.length < 24 || pngBuffer[0] !== 0x89) return null;

    let offset = 8; // skip PNG signature
    let width = 0, height = 0, colorType = 0;
    const idatChunks: Buffer[] = [];

    while (offset + 12 <= pngBuffer.length) {
      const chunkLen = pngBuffer.readUInt32BE(offset);
      const chunkType = pngBuffer.toString('ascii', offset + 4, offset + 8);
      const chunkData = pngBuffer.slice(offset + 8, offset + 8 + chunkLen);
      offset += 12 + chunkLen;

      if (chunkType === 'IHDR') {
        width = chunkData.readUInt32BE(0);
        height = chunkData.readUInt32BE(4);
        colorType = chunkData[9];
      } else if (chunkType === 'IDAT') {
        idatChunks.push(chunkData);
      } else if (chunkType === 'IEND') {
        break;
      }
    }

    if (width < 10 || height < 10 || idatChunks.length === 0) return null;

    const raw = zlib.inflateSync(Buffer.concat(idatChunks));
    const bpp = (colorType === 6) ? 4 : (colorType === 2) ? 3 : 1;

    // CRITICAL: defilter to get actual pixel values, not raw filtered bytes
    const pixels = _defilterPng(raw, width, height, bpp);

    const stride = width * bpp;
    const samples: Array<[number, number, number]> = [];
    const seen = new Set<string>(); // deduplicate coordinates

    function sampleAt(fx: number, fy: number) {
      const x = Math.min(Math.floor(width * fx), width - 1);
      const y = Math.min(Math.floor(height * fy), height - 1);
      const key = `${x},${y}`;
      if (seen.has(key)) return;
      seen.add(key);
      const start = y * stride + x * bpp;
      if (start + 2 < pixels.length) {
        samples.push([pixels[start], pixels[start + 1], pixels[start + 2]]);
      }
    }

    // 1) Four corners (inset 3% to stay inside the viewport, not on the absolute edge)
    const cornerInset = 0.03;
    sampleAt(cornerInset, cornerInset);             // top-left
    sampleAt(1 - cornerInset, cornerInset);         // top-right
    sampleAt(cornerInset, 1 - cornerInset);         // bottom-left
    sampleAt(1 - cornerInset, 1 - cornerInset);     // bottom-right

    // 2) Centre of the screen
    sampleAt(0.5, 0.5);

    // 3) 5×4 grid (20 samples), inset 8% from edges to avoid browser chrome
    const gridCols = [0.08, 0.27, 0.46, 0.65, 0.84];
    const gridRows = [0.10, 0.35, 0.60, 0.85];
    for (const fy of gridRows) {
      for (const fx of gridCols) {
        sampleAt(fx, fy);
      }
    }

    // 4) 10 random pixels (seeded from dimensions for reproducibility within
    //    a single call, but different each call via Date.now() xor)
    const seed = (width * 31 + height * 17) ^ (Date.now() & 0xFFFF);
    let rng = seed >>> 0;
    function nextRand() {
      // xorshift32
      rng ^= rng << 13;
      rng ^= rng >>> 17;
      rng ^= rng << 5;
      return (rng >>> 0) / 4294967296;
    }
    const randInset = 0.05; // stay 5% away from absolute edges
    for (let i = 0; i < 10; i++) {
      sampleAt(randInset + nextRand() * (1 - 2 * randInset),
              randInset + nextRand() * (1 - 2 * randInset));
    }

    return samples.length >= 12 ? samples : null;
  } catch {
    return null;
  }
}

/**
 * Take a screenshot and check if the page is visually blank.
 * Uses PNG pixel sampling (~35 pixels: corners + centre + 5x4 grid + 10 random)
 * with variance-based detection. Falls back to JPEG buffer size heuristic if PNG parsing fails.
 *
 * A page is blank only if ALL sampled pixels have near-zero variance
 * (standard deviation < 3 per RGB channel). This correctly handles:
 *   - White pages (all 255)
 *   - Black pages (all 0)
 *   - Solid colour pages (uniform)
 *   - Pages with ANY content (text, buttons, images) → variance > 3
 */
async function _isPageVisuallyBlank(page: any): Promise<boolean> {
  try {
    const buf = await page.screenshot({ type: 'png', fullPage: false, timeout: 8000, animations: 'disabled' });
    const samples = _samplePixelsFromPng(buf);
    if (samples && samples.length >= 8) {
      // Compute per-channel standard deviation
      const rMean = samples.reduce((s, p) => s + p[0], 0) / samples.length;
      const gMean = samples.reduce((s, p) => s + p[1], 0) / samples.length;
      const bMean = samples.reduce((s, p) => s + p[2], 0) / samples.length;
      const rStd = Math.sqrt(samples.reduce((s, p) => s + (p[0] - rMean) ** 2, 0) / samples.length);
      const gStd = Math.sqrt(samples.reduce((s, p) => s + (p[1] - gMean) ** 2, 0) / samples.length);
      const bStd = Math.sqrt(samples.reduce((s, p) => s + (p[2] - bMean) ** 2, 0) / samples.length);
      const maxStd = Math.max(rStd, gStd, bStd);
      const isBlank = maxStd < 3;
      log(`Pixel blank check: ${samples.length} samples, std(R=${rStd.toFixed(1)}, G=${gStd.toFixed(1)}, B=${bStd.toFixed(1)}), maxStd=${maxStd.toFixed(1)} → ${isBlank ? 'BLANK' : 'NOT blank'}`, 'DEBUG', 'auth-guard');
      return isBlank;
    }
    // PNG parsing failed — fall back to buffer size heuristic
    // A real rendered page at quality 20 produces >3KB even if mostly blank.
    // A genuinely blank page (solid white/black rectangle) compresses to <2KB.
    const jpegBuf = await page.screenshot({ type: 'jpeg', quality: 20, timeout: 8000, animations: 'disabled' }).catch(() => null);
    if (jpegBuf && jpegBuf.length < 2000) {
      log(`Pixel sampling unavailable, JPEG size=${jpegBuf.length}bytes < 2000 → assuming blank`, 'DEBUG', 'auth-guard');
      return true;
    }
    return false; // can't determine — assume not blank
  } catch {
    return false; // screenshot failed — assume not blank
  }
}

// FIX: Track consecutive captcha failures across cycles to detect
// captcha feedback loops that burn Render hours for nothing.
let _consecutiveCaptchaFailures = 0;
const MAX_CONSECUTIVE_CAPTCHA_FAILURES = 3;

// ─── Last-Known-Good-URL Tracking ──────────────────────────────────────────
// BUG FIX (2026-09-04): Previously, session checks compared the current URL
// against preset URL lists:
//   - CONFIG.MATHU_SPA_DOMAINS (default: "app.mathu.co.za,mathu.co.za")
//   - CONFIG.APP_URL           (default: "https://app.mathu.co.za/")
//
// These presets are brittle:
//   - If the bot is deployed to a different domain, the session check breaks.
//   - If CONFIG.APP_URL drifts from what the bot is actually using, the
//     check produces false positives (treating valid pages as expired).
//   - The url.includes(CONFIG.APP_URL) check on line ~463 was redundant with
//     _isSpaDomain(url) and produced noisy log warnings.
//
// Fix: track the origin of the last URL where the session was known to be
// valid. Use THAT origin as the baseline for the next session check. The
// preset list is kept only as a one-time bootstrap fallback for the very
// first cycle (when no last-known-good URL exists yet).
//
// The tracker is updated:
//   - When _isSpaSessionValid() returns true
//   - When the login-flow bypass fires (we're on Microsoft login but it's
//     an expected navigation, so the previous SPA URL is still "last known good")
//   - When cycle-cycle-manager.ts calls notifyLastKnownGoodUrl() after each
//     successful action
let _lastKnownGoodUrl: string | null = null;

/**
 * Notify the auth-guard of the URL the bot is currently on, so the next
 * session check can compare against it. Called by cycle-manager after each
 * successful action and after a successful session check.
 *
 * Only URLs on non-Microsoft, non-blank pages are stored. Microsoft login
 * URLs are NOT stored (we don't want them to become the "expected" origin).
 */
function notifyLastKnownGoodUrl(url: string | null | undefined): void {
  if (!url || typeof url !== 'string') return;
  if (url === 'about:blank') return;
  // Never store Microsoft login URLs — they are NOT the bot's "home" origin.
  if (url.includes('login.microsoftonline.com') ||
      url.includes('login.live.com') ||
      url.includes('login.microsoft.com') ||
      url.includes('msftauth.net')) {
    return;
  }
  // BUG FIX (2026-09-08): Never store Chrome error URLs.
  // `chrome-error://chromewebdata/` is what Chromium shows when a navigation
  // fails (network error, DNS failure, proxy broken). If we store it as the
  // "last known good URL", `_getRecoveryUrl()` returns it, and the next
  // `page.goto('chrome-error://chromewebdata/')` fails with ERR_ABORTED
  // because Chromium doesn't allow `page.goto` to `chrome-error://` URLs.
  // This created a death loop: blank-page escalation → self-heal failed →
  // restart → page.goto('chrome-error://chromewebdata/') → ERR_ABORTED →
  // blank-page escalation again.
  if (url.includes('chrome-error://') || url.includes('chromewebdata')) {
    return;
  }
  // Also reject other internal Chromium URLs that aren't real pages
  if (url.startsWith('chrome://') || url.startsWith('devtools://') || url.startsWith('data:')) {
    return;
  }
  if (_lastKnownGoodUrl !== url) {
    _lastKnownGoodUrl = url;
  }
}

/**
 * Get the last URL the bot was at when the session was known to be valid.
 * Used by cycle-manager for recovery navigation (so the bot returns to
 * where it was, not to a preset root URL).
 */
function getLastKnownGoodUrl(): string | null {
  return _lastKnownGoodUrl;
}

/**
 * Get the origin (protocol+host) of the last known good URL.
 * Returns null if no last-known-good URL has been recorded yet.
 */
function _getLastKnownGoodOrigin(): string | null {
  if (!_lastKnownGoodUrl) return null;
  try {
    return new URL(_lastKnownGoodUrl).origin;
  } catch {
    return null;
  }
}

/**
 * Check whether the given URL is on the same origin as the last known good
 * URL. Used to replace the preset _isSpaDomain() check.
 *
 * Behavior:
 *   - If a last-known-good URL exists, compare origins.
 *   - If no last-known-good URL exists yet (first cycle), fall back to the
 *     preset _isSpaDomain() check for bootstrap. This is the ONLY place the
 *     preset list is still consulted — after the first successful cycle, the
 *     tracker takes over entirely.
 */
function _isOnKnownAppOrigin(url: string): boolean {
  const lastOrigin = _getLastKnownGoodOrigin();
  if (lastOrigin) {
    try {
      return new URL(url).origin === lastOrigin;
    } catch {
      return false;
    }
  }
  // Bootstrap fallback: no last-known-good URL yet, use preset list.
  return _isSpaDomain(url);
}

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
 *   1. Is the page on the same origin as the last known good URL (or, on
 *      the first cycle, on a preset SPA domain)?
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

  // Positive signal: on the same origin as the last known good URL.
  // BUG FIX (2026-09-04): Replaced preset _isSpaDomain() check with
  // _isOnKnownAppOrigin() which uses the bot's actual last-known location
  // as the baseline. Preset URL lists are brittle (break if the deployment
  // domain changes, drift from CONFIG.APP_URL, etc.). The tracker is
  // updated after every successful cycle, so it always reflects where the
  // bot actually is — not where a config file thinks it should be.
  // For the very first cycle (no last-known-good URL yet), the helper falls
  // back to the preset _isSpaDomain() check as a one-time bootstrap.
  if (!_isOnKnownAppOrigin(url)) {
    log(`SPA check: URL ${url} is not on the last-known-good origin — session invalid`, 'DEBUG', 'auth-guard');
    return false;
  }

  // Content-based validation: look for MathU app elements in the page
  try {
    const visuallyBlank = await _isPageVisuallyBlank(page);
    if (visuallyBlank) {
      log('SPA check: Screenshot is visually blank (low pixel variance) — session NOT valid', 'WARN', 'auth-guard');
      return false;
    }

    // Pixel check confirmed the page is NOT visually blank.
    // TASK 133 (2026-10-23): Check if we're actually on the LOGIN page.
    // The MathU login page has rendered content ("Sign in with Microsoft" button)
    // but the user is NOT logged in. The old code treated any non-blank page on
    // the app origin as "session valid" — which meant the bot thought it was
    // logged in when it was actually on the login page. This caused an infinite
    // login loop: click Sign in → Microsoft redirects back → "session valid" →
    // tribunal sees login page → click Sign in again.
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      const lowerText = bodyText.toLowerCase();
      // Detect MathU login page indicators
      const isLoginPage = lowerText.includes('sign in with microsoft') ||
                          lowerText.includes('sign in with apple') ||
                          lowerText.includes('sign in with phone') ||
                          (lowerText.includes('sign in') && lowerText.length < 500);
      if (isLoginPage) {
        log('SPA check: Page has content but shows LOGIN page ("Sign in with Microsoft") — session NOT valid', 'WARN', 'auth-guard');
        return false;
      }
    } catch {}

    // We're on the last-known-good origin AND the page has rendered pixels
    // AND it's not the login page, so the session is valid.
    log('SPA check: Page has rendered content on known origin — session valid', 'DEBUG', 'auth-guard');
    notifyLastKnownGoodUrl(url);
    return true;
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
 * Uses pixel-based detection: samples ~35 pixels (corners, centre, grid, random)
 * from a screenshot. If pixel variance is near-zero (std < 3), the page is visually blank.
 */
async function _isPageBlank(page: any): Promise<boolean> {
  return _isPageVisuallyBlank(page);
}

/**
 * Check if the blank-page flag is set WITHOUT consuming it.
 * Used by cycle-manager to decide whether to reset blankPageCounter
 * before the actual consumeBlankPageFlag call.
 */
function peekBlankPageFlag(page: any): boolean {
  return !!(page as any)?._authBlankPage;
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

  // ═══════════════════════════════════════════════════════════════════════════
  // BUG FIX (2026-09-04, v2): Never manually change the URL.
  // ═══════════════════════════════════════════════════════════════════════════
  // The Microsoft sign-in is shown as an overlay/popup on top of (or alongside)
  // the MathU app. The auth-guard previously "recovered" from perceived session
  // expiry by:
  //   1. Calling refreshSession() → which internally does page.goto(APP_URL)
  //      via captcha-human-fallback.ts → tryAllSessions(). This navigates AWAY
  //      from the Microsoft overlay, destroying the in-progress sign-in flow.
  //   2. Closing the browser entirely (browser.closeBrowser()) and relaunching
  //      (browser.launchBrowser()), which starts fresh at about:blank and then
  //      gets navigated to APP_URL by cycle-manager's fresh-start logic.
  //      This is the "changes the URL into an entirely new website" behavior.
  //
  // Both behaviors cause the bot to loop: click "Sign in with Microsoft" →
  // land on Microsoft login → auth-guard destroys the overlay → bot is back at
  // MathU root → tribunal sees mathu_login → clicks again → loop forever.
  //
  // New philosophy: the auth-guard NEVER changes the URL. It only READS the
  // current page state to decide whether the session is valid. If the session
  // is invalid, it returns the page as-is and lets the tribunal handle it
  // visually (the tribunal can click buttons, type credentials, etc. without
  // any URL navigation from the auth-guard).
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Rule 1: On Microsoft login page → return page as-is, ALWAYS ──
  // Whether we just clicked "Sign in with Microsoft" (login in progress) or
  // the session genuinely expired and Microsoft redirected us here, we NEVER
  // navigate away from the Microsoft page. The tribunal will see the email
  // input / password input / KMSI / MFA page and handle it visually.
  //
  // BUG FIX (2026-09-04, v3): Previously, this branch called
  // notifyLoginCompleted() — clearing the login-flow flag WHILE STILL ON THE
  // MICROSOFT PAGE. That was wrong: the login is NOT complete, we're in the
  // middle of it. Clearing the flag meant that when the bot bounced back to
  // the app origin (because Microsoft redirected back due to invalid session),
  // the login-flow protections were gone and the auth-guard called
  // refreshSession() → tryAllSessions() → page.goto(APP_URL) — a manual URL
  // change that destroyed state and caused the click loop.
  //
  // Now: the flag stays set while we're on Microsoft. It only clears when we
  // return to the app origin (Rule 2).
  //
  // BUG FIX (2026-09-04, v4): The old check used `url.includes(...)` which
  // matched SUBSTRINGS anywhere in the URL — including inside query parameters.
  // The bot ended up on `passwordreset.microsoftonline.com/?ru=https://login.microsoftonline.com/...`
  // and the `url.includes('login.microsoftonline.com')` matched the `ru=` query
  // param, causing the auth-guard to treat the password-reset page as a normal
  // Microsoft login page. The tribunal's action cache then kept serving
  // `input_email` (31+ hits!) on a page that has NO email input field.
  //
  // Fix: parse the URL hostname and check it directly. Also explicitly detect
  // password-reset / recovery / proofup pages — those require human intervention
  // (the account credentials are bad / require MFA setup / require password
  // change). No amount of bot clicking will succeed. The bot must alert and
  // degrade instead of looping.
  const hostname = (() => {
    try { return new URL(url).hostname.toLowerCase(); }
    catch { return ''; }
  })();

  const onMicrosoftLogin =
    hostname === 'login.microsoftonline.com' ||
    hostname === 'login.live.com' ||
    hostname === 'login.microsoft.com' ||
    hostname === 'msftauth.net' ||
    hostname.endsWith('.login.microsoftonline.com') ||
    hostname.endsWith('.login.live.com') ||
    hostname.endsWith('.msftauth.net');

  // TASK 43 (2026-09-10): Removed hardcoded password-reset / AADSTS URL detection.
  // The bot was mistaking legitimate login pages for human-intervention pages
  // because Microsoft login URLs sometimes contain path segments like '/recovery'
  // or query params like 'AADSTS' even on normal login flows.
  //
  // Instead of URL-pattern-matching to decide "this needs a human", we now let
  // the AI tribunal (vision providers) look at the screenshot and decide. The AI
  // can return `currentState: 'human_intervention'` if it sees a page that truly
  // requires human action (password expired, MFA enrollment, account locked, etc.).
  // The cycle-manager then pauses the bot based on the AI's decision — not dumb
  // selectors.
  //
  // The old code that threw MICROSOFT_RECOVERY_PAGE / MICROSOFT_AADSTS_ERROR
  // has been removed. The bot will no longer preemptively pause on these URLs —
  // it will take a screenshot and let the AI decide what to do.

  if (onMicrosoftLogin) {
    // BUG FIX (2026-09-07): Reset chrome-error counter when we successfully
    // reach a Microsoft login page — the proxy is working.
    (globalThis as any).__chromeErrorCount = 0;
    if (isLoginInProgress()) {
      log(`Login flow in progress — Microsoft login URL is expected destination. Returning page to tribunal. url=${url}`, 'INFO', 'auth-guard');
      // DO NOT clear the flag here — the login is NOT complete.
      // The flag will be cleared when we return to the app origin (Rule 2).
    } else {
      log(`On Microsoft login page — returning page to tribunal for visual handling (NOT navigating away, NOT closing browser). url=${url}`, 'INFO', 'auth-guard');
    }
    authAttempts = 0;
    // Clear any stale blank-page flag — the Microsoft page has content.
    (page as any)._authBlankPage = false;
    return page;
  }

  // ── Rule 2: If we were in a login flow and we're now back on the app origin,
  //    clear the login-flow flag (login completed or bounced back). ──
  // BUG FIX (2026-09-04, v3): When the bot returns to the app origin after a
  // login attempt (whether successful or failed), DON'T fall through to Rule 3/4
  // (which calls refreshSession → page.goto). The session might still be
  // settling, or the login might have failed and needs to be retried by the
  // tribunal. Either way, return the page as-is — NO URL changes.
  if (isLoginInProgress() && _isOnKnownAppOrigin(url)) {
    // TASK 133 (2026-10-23): Don't just assume login completed because we're
    // back on the app origin. The Microsoft login might have bounced back
    // WITHOUT authenticating (e.g., the bot never entered email/password, or
    // the login failed). Check if we're on the LOGIN page — if so, the login
    // did NOT complete, and we should NOT clear the login flag.
    try {
      const bodyText = await page.evaluate(() => document.body?.innerText || '');
      const lowerText = bodyText.toLowerCase();
      const isLoginPage = lowerText.includes('sign in with microsoft') ||
                           lowerText.includes('sign in with apple') ||
                           (lowerText.includes('sign in') && lowerText.length < 500);
      if (isLoginPage) {
        // We're BACK on the login page — the login FAILED (bounced back without auth)
        // Don't clear the login flag, don't return the page as "login complete".
        // Fall through to Rule 3 which will detect session is invalid (login page)
        // and let the tribunal try again.
        log('Login flow returned to app origin but page shows LOGIN — login did NOT complete, falling through to re-auth', 'WARN', 'auth-guard');
        notifyLoginCompleted(); // Clear the flag so we can retry
        // Fall through to Rule 3 — _isSpaSessionValid will return false (login page)
      } else {
        log('Login flow returned to app origin — login appears successful, clearing flag, returning page to tribunal (NO refreshSession, NO URL change)', 'INFO', 'auth-guard');
        notifyLoginCompleted();
        notifyLastKnownGoodUrl(url);
        authAttempts = 0;
        (page as any)._authBlankPage = false;
        return page;
      }
    } catch {
      // Can't check page content — assume login completed
      log('Login flow returned to app origin — clearing flag, returning page to tribunal (NO refreshSession, NO URL change)', 'INFO', 'auth-guard');
      notifyLoginCompleted();
      notifyLastKnownGoodUrl(url);
      authAttempts = 0;
      (page as any)._authBlankPage = false;
      return page;
    }
  }

  // ── Rule 3: SPA-aware session validation (read-only, no URL changes) ──
  // If we're on the bot's home origin, verify the session is still valid by
  // checking page content. If valid, return the page. If invalid, fall through
  // to the re-auth flow (which also does NOT change the URL anymore).
  if (_isOnKnownAppOrigin(url)) {
    // BUG FIX (2026-09-07): Reset chrome-error counter when we successfully
    // reach the app — the proxy (or direct connection) is working.
    (globalThis as any).__chromeErrorCount = 0;
    const valid = await _isSpaSessionValid(page);
    if (valid) {
      authAttempts = 0;
      return page;
    }
    // SPA invalid — check if the page is blank BEFORE attempting re-auth.
    // If blank, set the flag so cycle-manager's peekBlankPageFlag can catch it
    // and skip the tribunal (which would also see blank and waste API calls).
    const preRefreshBlank = await _isPageBlank(page);
    if (preRefreshBlank) {
      (page as any)._authBlankPage = true;
      // TASK 97+105 (2026-09-29 / 2026-10-03): Don't re-authenticate on blank pages!
      // The blank page is NOT a session expiry — it's Flutter still rendering.
      // Re-authenticating every time the page is blank causes a login loop.
      //
      // Wait for the page to render (up to 60s — Flutter on Render free tier
      // can take 30-45s to initialize CanvasKit). If still blank after 60s,
      // try a page.reload() — the Flutter app may have crashed during init.
      // Only re-authenticate if the page is STILL blank after reload.
      log('SPA session check: page is blank — waiting for Flutter to render (up to 60s)...', 'WARN', 'auth-guard');
      const renderDeadline = Date.now() + 60000;
      let rendered = false;
      while (Date.now() < renderDeadline) {
        await new Promise(r => setTimeout(r, 3000));
        const stillBlank = await _isPageBlank(page);
        if (!stillBlank) {
          rendered = true;
          log('SPA session check: page rendered after blank wait — session is valid, skipping re-auth', 'INFO', 'auth-guard');
          authAttempts = 0;
          return page;
        }
      }
      if (!rendered) {
        // TASK 105: Page still blank after 60s — try reloading before re-auth.
        // The Flutter app may have crashed during CanvasKit initialization.
        // A reload gives it a fresh chance to render.
        log('SPA session check: page still blank after 60s wait — trying page.reload() before re-auth', 'WARN', 'auth-guard');
        try {
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          // Wait another 30s after reload
          const reloadDeadline = Date.now() + 30000;
          while (Date.now() < reloadDeadline) {
            await new Promise(r => setTimeout(r, 3000));
            const stillBlank = await _isPageBlank(page);
            if (!stillBlank) {
              rendered = true;
              log('SPA session check: page rendered after reload — session is valid, skipping re-auth', 'INFO', 'auth-guard');
              authAttempts = 0;
              return page;
            }
          }
        } catch (reloadErr: any) {
          log(`SPA session check: reload failed: ${reloadErr.message}`, 'WARN', 'auth-guard');
        }
        if (!rendered) {
          log('SPA session check: page still blank after 60s + reload — proceeding with re-auth', 'WARN', 'auth-guard');
        }
      }
    }
    log('SPA session invalid, attempting re-auth (no URL change)...', 'WARN', 'auth-guard');
  } else {
    // Not on the known app origin and not on Microsoft login — could be a deep
    // link, /assignments (legacy), or an unknown page. Preserve the legacy
    // /assignments fast-path. Otherwise fall through to re-auth.
    if (url.includes('/assignments')) { authAttempts = 0; return page; }
  }

  // ── Rule 4: Re-authentication flow (NO URL CHANGES) ──
  // We only reach here if:
  //   - We're on the bot's home origin but the session is invalid, OR
  //   - We're on an unknown page (not Microsoft, not app origin, not /assignments)
  //
  // refreshSession() may internally navigate (via tryAllSessions → page.goto),
  // but ONLY when restoring a saved session — and that navigation stays within
  // the app origin, so it doesn't destroy the Microsoft overlay. We only call
  // refreshSession when we're already on the app origin (never on Microsoft).
  if (_isOnKnownAppOrigin(url)) {
    log('Session expired, attempting refreshSession (no URL change away from app)...', 'WARN', 'auth-guard');
    authAttempts++;
    if (authAttempts > CONFIG.MAX_AUTH_ATTEMPTS) {
      try { (_deps.alerting?.sendAlert || (() => {}))('Max authentication attempts exceeded'); } catch (alertErr: any) { log('Failed to send auth failure alert', 'ERROR', 'auth-guard'); }
      throw new Error('Max authentication attempts exceeded');
    }
    const refreshed = await auth.refreshSession?.(page);
    if (refreshed) {
      authAttempts = 0;
      (page as any)._authBlankPage = false;
      return page;
    }

    // refreshSession failed (no strategy matched, no saved session worked).
    // OLD BEHAVIOR (REMOVED): close the browser + relaunch + navigate to
    //   APP_URL. This was the "changes the URL into an entirely new website"
    //   behavior that destroyed the Microsoft sign-in overlay.
    // NEW BEHAVIOR: just return the page as-is. The tribunal will see whatever
    //   is on screen and decide what to do visually. If the page is genuinely
    //   broken (blank), the cycle-manager's blank-page escalation ladder will
    //   handle it — that's not the auth-guard's job.
    const isBlank = await _isPageBlank(page);
    if (isBlank) {
      log('refreshSession failed, page is BLANK — flagging for cycle-manager escalation (NOT closing browser)', 'WARN', 'auth-guard');
      (page as any)._authBlankPage = true;
    } else {
      log('refreshSession failed but page has content — returning page to tribunal (no URL change, no browser restart)', 'INFO', 'auth-guard');
    }
    authAttempts = 0;
    return page;
  }

  // BUG FIX (2026-09-07): Handle Chrome error pages (chrome-error://chromewebdata/).
  // These appear when page.goto() fails (network timeout, DNS error, proxy failure).
  // The page shows a blank Chrome error page — navigating to APP_URL recovers.
  // If this happens repeatedly, disable the proxy entirely (it's causing more
  // harm than good).
  //
  // BUG FIX (2026-09-08): Lowered threshold from 3 → 1 for proxy-disable.
  // The previous threshold (3 occurrences) meant the bot wasted 6+ minutes
  // cycling on chrome-error pages before the proxy was disabled. The first
  // chrome-error page is already strong evidence the proxy is broken — there's
  // no reason to wait. We still keep the counter for logging/observability.
  if (url.includes('chrome-error://') || url.includes('chromewebdata')) {
    // Track consecutive chrome-error occurrences
    const errorCount = ((globalThis as any).__chromeErrorCount || 0) + 1;
    (globalThis as any).__chromeErrorCount = errorCount;

    // FIRST chrome-error page = proxy is broken. Disable it immediately.
    // The user's directive: "If something is wrong with the browser, the bots
    // repeating actions or gets a chromedata error, turn off the proxies."
    if (errorCount >= 1 && !(globalThis as any).__proxyDisabled) {
      try {
        const ipRotator = require('./network-ip-rotator');
        const currentProxy = ipRotator.getCurrentProxy?.();
        if (currentProxy) {
          log(`Chrome error page detected (occurrence #${errorCount}, proxy=${currentProxy}) — DISABLING PROXY immediately. Browser will use direct connection on next launch.`, 'ERROR', 'auth-guard');
          // TASK 61: Removed alert — routine event.
          // BUG FIX (2026-09-09): Use bypassProxy() to FULLY shut down the proxy
          // (clears env vars + resets ip-rotator state), not just set the flag.
          if (typeof ipRotator.bypassProxy === 'function') {
            ipRotator.bypassProxy(`chrome-error page detected (occurrence #${errorCount})`);
          } else {
            (globalThis as any).__proxyDisabled = true;
          }
        } else {
          log(`Chrome error page detected (occurrence #${errorCount}) — no proxy active, will recover via navigation.`, 'WARN', 'auth-guard');
        }
      } catch {
        log(`Chrome error page detected (occurrence #${errorCount}) — ip-rotator not loaded, will recover via navigation.`, 'WARN', 'auth-guard');
      }
    } else if (errorCount >= 3 && (globalThis as any).__proxyDisabled) {
      // Already disabled — log it for visibility.
      log(`Chrome error page detected ${errorCount} times — proxy already disabled, but page still failing.`, 'WARN', 'auth-guard');

      // BUG FIX (2026-09-09): HARD EXIT on persistent network failure.
      // If we've seen 20+ chrome-error pages, the Render instance's network
      // is completely broken. Cycling for hours won't fix a network outage.
      // EXIT the process so Render can restart it cleanly.
      if (errorCount >= 20) {
        log(`FATAL: Chrome error page detected ${errorCount} times — network is completely unreachable. Exiting for clean Render restart.`, 'FATAL', 'auth-guard');
        try { (_deps.alerting?.sendAlert || (() => {}))(`FATAL: Network unreachable (chrome-error count=${errorCount}). Process exiting for clean Render restart.`); } catch {}
        try { require('./survival-restart-guardian').preserveBeforeExit?.('chrome_error_persistent').catch(() => {}); } catch {}
        const origExit = (process as any)._originalExit || process.exit.bind(process);
        origExit(137);
      }
    }

    const recoveryUrl = CONFIG.APP_URL || CONFIG.BASE_URL || 'https://app.mathu.co.za';
    log(`On Chrome error page (${url}, occurrence #${errorCount}) — navigating to ${recoveryUrl} (network/proxy error recovery)`, 'WARN', 'auth-guard');
    try {
      await page.goto(recoveryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e: any) {
      log(`Recovery navigation to ${recoveryUrl} also failed: ${e.message}`, 'ERROR', 'auth-guard');
      // If we can't navigate, close and relaunch the browser
      try {
        const browser = _deps.browser || {};
        await browser.closeBrowser?.();
        await new Promise(r => setTimeout(r, 2000));
        await browser.launchBrowser?.();
      } catch {}
    }
    return page;
  }

  // Unknown URL (not Microsoft, not app origin, not /assignments).
  // BUG FIX (2026-09-06): If on about:blank, navigate to APP_URL instead of
  // returning a blank page to the tribunal. The tribunal can't do anything
  // with a blank page — it just returns error/wait, which loops forever.
  if (url === 'about:blank') {
    const recoveryUrl = CONFIG.APP_URL || CONFIG.BASE_URL || 'https://app.mathu.co.za';
    log(`On about:blank — navigating to ${recoveryUrl} (instead of returning blank page to tribunal)`, 'INFO', 'auth-guard');
    try {
      await page.goto(recoveryUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    } catch (e: any) {
      log(`Navigation to ${recoveryUrl} failed: ${e.message}`, 'WARN', 'auth-guard');
    }
    return page;
  }
  log(`On unknown URL — returning page to tribunal for visual handling (no URL change). url=${url}`, 'INFO', 'auth-guard');
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

module.exports = {
  ensureAuthenticated,
  handleCaptcha,
  resetCaptchaFailureCount,
  getCaptchaFailureCount,
  consumeBlankPageFlag,
  peekBlankPageFlag,
  _isPageBlank,
  _injectDependencies,
  // ── BUG FIX (2026-09-04): Login-flow tracking ──
  // Cycle-manager calls notifyLoginInitiated() right after executing a click
  // on mathu_login state, and notifyLoginCompleted() when the bot returns to
  // the MathU SPA domain. See the long comment block at the top of the file.
  notifyLoginInitiated,
  notifyLoginCompleted,
  isLoginInProgress,
  // ── BUG FIX (2026-09-04): Last-known-good-URL tracking ──
  // Session checks compare the current URL against the bot's actual
  // last-known location (notifyLastKnownGoodUrl) rather than preset URL lists
  // (CONFIG.APP_URL, CONFIG.MATHU_SPA_DOMAINS). The tracker is updated after
  // every successful session check and from cycle-manager after every
  // successful action. getLastKnownGoodUrl() is used by cycle-manager for
  // recovery navigation (so the bot returns to where it was, not a preset
  // root URL).
  notifyLastKnownGoodUrl,
  getLastKnownGoodUrl,
};
