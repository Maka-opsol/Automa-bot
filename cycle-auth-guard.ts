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
    const buf = await page.screenshot({ type: 'png', fullPage: false });
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
    const jpegBuf = await page.screenshot({ type: 'jpeg', quality: 20 }).catch(() => null);
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
    // ── BLANK PAGE DETECTION (pixel-based, must run BEFORE canvas check) ──
    // Flutter Web paints everything to <canvas>, so innerText is always empty.
    // Text-length heuristics are fundamentally broken for Flutter SPAs.
    // Instead, sample ~35 pixels from a screenshot (corners, centre, grid, random).
    // If pixel variance is near-zero (std < 3), the page is visually blank.
    // If even 1 pixel differs significantly, real content is rendered.
    const visuallyBlank = await _isPageVisuallyBlank(page);
    if (visuallyBlank) {
      log('SPA check: Screenshot is visually blank (low pixel variance) — session NOT valid', 'WARN', 'auth-guard');
      return false;
    }

    // Pixel check already confirmed the page is NOT visually blank.
    // If we're on the SPA domain and the page has rendered pixels, the session
    // is valid — the Flutter app is showing something (even if it's a quiz,
    // modal, or non-standard layout the text-check couldn't detect).
    log('SPA check: Page has rendered content (pixels differ) — session valid', 'DEBUG', 'auth-guard');
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
    const retryFn = _getRetryWithBackoff();
    const newPage = retryFn ? await retryFn(browser.launchBrowser, { maxRetries: 2 }) : await browser.launchBrowser?.();
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

module.exports = { ensureAuthenticated, handleCaptcha, resetCaptchaFailureCount, getCaptchaFailureCount, consumeBlankPageFlag, peekBlankPageFlag, _isPageBlank, _injectDependencies };
