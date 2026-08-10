'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

// Lazy loggers — only resolve at call time, never at module load
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error) { _deps.logger?.logError?.(msg, err) ?? console.error(msg, err); }

class AuthManager {
  strategies: any[] = [];
  _injectDependencies: any;

  puzzleSolver: any = null;
  activeStrategy: any = null; // Track which strategy is currently handling auth

  constructor() {
    // Defer all side-effect work to init() — called after DI injection
  }

  /**
   * Initialize the auth manager. Called after _injectDependencies().
   * Loads strategies and optional puzzle solver.
   */
  init() {
    this.loadStrategies();
    const CONFIG = getCONFIG();
    if (CONFIG.ENABLE_PUZZLE_SANDBOX) {
      try {
        this.puzzleSolver = require('./puzzle-sandbox');
        log('Puzzle sandbox loaded.', 'INFO', 'auth');
      } catch (e: any) { logError('Puzzle sandbox load failed', e as Error); }
    }
  }

  loadStrategies() { 
    const fs = require('fs');
    const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
    const strategyFiles = fs.readdirSync(PROJECT_ROOT)
      .filter((f: any) => f.startsWith('auth-strategies-') && f !== 'auth-strategies-base.ts' && f !== 'auth-strategies-base.js' && (f.endsWith('.ts') || f.endsWith('.js')));
    for (const file of strategyFiles) {
      try {
        const StrategyClass = require(path.join(PROJECT_ROOT, file));
        const instance = new StrategyClass();
        if (instance.id) {
          this.strategies.push(instance);
          log(`Loaded auth strategy: ${instance.id}`, 'DEBUG', 'auth');
        }
      } catch (err: any) { logError(`Failed to load strategy ${file}`, err as Error); }
    }
    this.strategies.sort((a: any, b: any) => String(b.version).localeCompare(String(a.version)));
  }

  async authenticate(page: any, credentials: any) { 
    for (const strategy of this.strategies) {
      try {
        if (await strategy.canHandle(page)) {
          this.activeStrategy = strategy; // Track active strategy for fallback CAPTCHA selectors
          log(`Using auth strategy: ${strategy.id}`, 'INFO', 'auth');
          return await strategy.authenticate(page, credentials);
        }
      } catch (err: any) { logError(`Strategy ${strategy.id} failed`, err as Error); continue; }
    }

    // FIX: No strategy matched — don't immediately throw. Instead, try to
    // identify the page and take recovery actions. This handles:
    //   - Microsoft showing an unexpected page (consent, account pick, conditional access)
    //   - Being redirected to a CAPTCHA challenge page
    //   - Being on a post-logout or error page
    const recoveryResult = await this._attemptPageRecovery(page, credentials);
    if (recoveryResult) return recoveryResult;

    throw new Error('No authentication strategy could handle this page');
  }

  /**
   * FIX: Attempt to recover from unrecognized pages during auth.
   * This is the key fix for "No authentication strategy could handle this page".
   */
  async _attemptPageRecovery(page: any, credentials: any): Promise<boolean | null> {
    const url = page.url();
    log(`Auth recovery: attempting to handle unrecognized page: ${url}`, 'WARN', 'auth');

    // 1. If we're on any Microsoft domain, try navigating directly to login
    if (url.includes('microsoft.com') || url.includes('live.com') || url.includes('msftauth.net')) {
      // Try clicking common Microsoft buttons that might be blocking us
      const clickTargets = [
        'button[type="submit"]',
        'input[type="submit"]',
        '#idSIButton9',     // Microsoft "Next" button
        '#idBtn_Back',      // KMSI / back button
        'button:has-text("Next")',
        'button:has-text("Continue")',
        'button:has-text("Yes")',
        'button:has-text("Accept")',
        'button:has-text("OK")',
        'a:has-text("Continue")',
      ];
      for (const sel of clickTargets) {
        try {
          const el = await page.$(sel);
          if (el) {
            const isVisible = await el.isVisible().catch(() => false);
            if (isVisible) {
              log(`Auth recovery: clicking ${sel} on unrecognized Microsoft page`, 'INFO', 'auth');
              await el.click();
              await new Promise(r => setTimeout(r, 3000));
              // Re-check if a strategy can now handle the page
              for (const strategy of this.strategies) {
                try {
                  if (await strategy.canHandle(page)) {
                    this.activeStrategy = strategy;
                    log(`Auth recovery: strategy ${strategy.id} can handle page after click`, 'INFO', 'auth');
                    return await strategy.authenticate(page, credentials);
                  }
                } catch {}
              }
            }
          }
        } catch {}
      }

      // 2. Check if we somehow ended up on MathU already (redirect happened)
      if (url.includes('mathu.co.za') || url.includes('mathu')) {
        log('Auth recovery: already on MathU domain, auth may have succeeded', 'INFO', 'auth');
        return true;
      }

      // 3. Try full page reload — Microsoft sometimes gets stuck on intermediate pages
      log('Auth recovery: reloading page to reset Microsoft auth flow', 'WARN', 'auth');
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await new Promise(r => setTimeout(r, 5000));

      // 4. After reload, try strategies again
      for (const strategy of this.strategies) {
        try {
          if (await strategy.canHandle(page)) {
            this.activeStrategy = strategy;
            log(`Auth recovery: strategy ${strategy.id} can handle page after reload`, 'INFO', 'auth');
            return await strategy.authenticate(page, credentials);
          }
        } catch {}
      }
    }

    // 4. If on MathU domain already, session might be valid
    if (url.includes('mathu.co.za') || url.includes('mathu')) {
      log('Auth recovery: on MathU domain, assuming session valid', 'INFO', 'auth');
      return true;
    }

    return null; // Truly unrecognized
  }

  async detectCaptcha(page: any) { 
    for (const strategy of this.strategies) {
      try {
        if (await strategy.canHandle(page)) {
          this.activeStrategy = strategy; // Track active strategy
          return await strategy.detectCaptcha(page); 
        }
      } catch (err: any) { logError(`Strategy ${strategy.id} detectCaptcha failed`, err as Error); continue; }
    }
    return false;
  }

  async solveCaptcha(page: any) { 
    let solved = false;
    for (const strategy of this.strategies) {
      try {
        if (await strategy.canHandle(page)) {
          this.activeStrategy = strategy; // Track active strategy
          solved = await strategy.solveCaptcha(page);
          if (solved) return true;
        }
      } catch (err: any) { logError(`Strategy ${strategy.id} solveCaptcha failed`, err as Error); }
    }
    if (!solved) {
      const CONFIG = getCONFIG();

      // FIX: Always try vision-based CAPTCHA solving as first fallback,
      // even when CAPTCHA_SERVICE is 'none'. The old code required an
      // external service to be configured, leaving the bot helpless.
      try {
        const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 });
        const base64 = screenshot.toString('base64');
        const { solveCaptchaWithVision } = require('./providers');
        log('Attempting vision-based CAPTCHA solving as fallback', 'INFO', 'auth');
        const visionText = await solveCaptchaWithVision(base64);
        if (visionText) {
          log('Vision-based CAPTCHA solver returned text, applying...', 'INFO', 'auth');
          const selectors = this.activeStrategy?.selectors?.selectors || {};
          const captchaInput = selectors.captchaInput || 'input[type="text"]';
          const submitBtn = selectors.submitButton || 'button[type="submit"]';
          const input = await page.$(captchaInput);
          if (input) {
            await input.click();
            await input.fill(visionText);
            const submit = await page.$(submitBtn);
            if (submit) { await submit.click(); await new Promise(r => setTimeout(r, 3000)); return true; }
          }
        }
      } catch (visionErr: any) {
        log(`Vision CAPTCHA fallback failed: ${visionErr.message}`, 'WARN', 'auth');
      }

      // Then try configured external services
      const hasCaptchaService = (CONFIG.ENABLE_PUZZLE_SANDBOX && this.puzzleSolver) || CONFIG.CAPTCHA_SERVICE !== 'none';
      if (!hasCaptchaService) return false;
      try {
        const screenshot2 = await page.screenshot({ type: 'jpeg' });
        const base64 = screenshot2.toString('base64');
        if (CONFIG.ENABLE_PUZZLE_SANDBOX && this.puzzleSolver) {
          log('Using puzzle sandbox for interactive CAPTCHA', 'INFO', 'auth');
          const result = await this.puzzleSolver.solvePuzzle(page, base64);
          if (result) { log('Puzzle solved by sandbox.', 'INFO', 'auth'); return true; }
        }
        if (CONFIG.CAPTCHA_SERVICE !== 'none') {
          const humanCaptcha = require('./captcha-human-fallback');
          const humanText = await humanCaptcha.requestHumanCaptcha(base64);
          if (humanText) {
            const selectors = this.activeStrategy?.selectors || {};
            const captchaInput = selectors.captchaInput || 'input[type="text"]';
            const submitBtn = selectors.submitButton || 'button[type="submit"]';
            await page.fill(captchaInput, humanText);
            await page.click(submitBtn);
            return true;
          }
        }
      } catch (err: any) { logError('Fallback captcha solving failed', err as Error); return false; }
      return false;
    }
  }

  async refreshSession(page: any) {
    const CONFIG = getCONFIG();

    // FIX: Pre-emptive session validation — check if we're actually still
    // on a MathU page before attempting expensive re-auth. If the page
    // hasn't expired yet, don't waste time re-authenticating.
    try {
      const currentUrl = page.url();
      if (currentUrl.includes('mathu.co.za') || currentUrl.includes('mathu')) {
        // Quick check: see if the page has any sign-in prompts
        const needsAuth = await page.evaluate(() => {
          const body = document.body?.innerText || '';
          return body.includes('Sign in') || body.includes('sign in') ||
                 body.includes('Log in') || body.includes('log in') ||
                 body.includes('Session expired') || body.includes('session expired');
        }).catch(() => false);
        if (!needsAuth) {
          log('Session refresh: still on MathU with no auth prompts, skipping re-auth', 'DEBUG', 'auth');
          return true;
        }
      }
    } catch {}

    if (process.env.EXTERNAL_AUTH_URL) {
      try {
        const { fetchWithTimeout } = require('./utils-fetch');
        const response = await fetchWithTimeout(process.env.EXTERNAL_AUTH_URL, {}, 15000);
        const cookies = await response.json();
        if (!Array.isArray(cookies)) throw new Error('Expected array of cookies');
        const validCookies = cookies.filter((c: any) =>
          c && typeof c.name === 'string' && c.name.length > 0 &&
          typeof c.value === 'string' &&
          typeof c.domain === 'string'
        );
        if (validCookies.length === 0) throw new Error('No valid cookies in response');
        await page.context().addCookies(validCookies);
        log('External session refreshed', 'INFO', 'auth');
        return true;
      } catch (err: any) { logError('External auth failed', err as Error); return false; }
    }

    // FIX: Try session pool restoration first, then cookie restoration
    // from tombstone before falling back to full re-auth.
    try {
      const humanCaptcha = require('./captcha-human-fallback');
      const restored = await humanCaptcha.tryAllSessions(page);
      if (restored) {
        log('Session restored from session pool', 'INFO', 'auth');
        return true;
      }
    } catch (e: any) {
      log(`Session pool restoration failed: ${e.message}`, 'WARN', 'auth');
    }

    // FIX: Try tombstone cookie restoration before full re-auth
    try {
      const tombstoneData = process.env.TOMBSTONE_URL ? null : null;
      // Check /tmp for saved cookies
      const fs = require('fs');
      const path = require('path');
      const cookieFile = path.join('/tmp', 'mathu-shield', 'cookies.json');
      if (fs.existsSync(cookieFile)) {
        const cookies = JSON.parse(fs.readFileSync(cookieFile, 'utf-8'));
        if (Array.isArray(cookies) && cookies.length > 0) {
          await page.context().addCookies(cookies);
          log('Session restored from shadow cookies', 'INFO', 'auth');
          // Validate by navigating to MathU
          await page.goto(CONFIG.APP_URL || 'https://app.mathu.co.za/', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          await new Promise(r => setTimeout(r, 3000));
          const afterUrl = page.url();
          if (afterUrl.includes('mathu') && !afterUrl.includes('login.microsoft')) {
            return true;
          }
          log('Shadow cookies did not resolve auth, proceeding to full re-auth', 'WARN', 'auth');
        }
      }
    } catch {}

    const email = CONFIG.getMicrosoftEmail?.() || CONFIG.MICROSOFT_EMAIL;
    const password = CONFIG.getMicrosoftPassword?.() || CONFIG.MICROSOFT_PASSWORD;
    return this.authenticate(page, { email, password });
  }
}

const _authManagerInstance = new AuthManager();
_authManagerInstance._injectDependencies = _injectDependencies;
module.exports = _authManagerInstance;
