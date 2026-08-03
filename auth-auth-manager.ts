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
    throw new Error('No authentication strategy could handle this page');
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
      const hasCaptchaService = (CONFIG.ENABLE_PUZZLE_SANDBOX && this.puzzleSolver) || CONFIG.CAPTCHA_SERVICE !== 'none';
      if (!hasCaptchaService) return false;
      try {
        const screenshot = await page.screenshot({ type: 'jpeg' });
        const base64 = screenshot.toString('base64');
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
    const humanCaptcha = require('./captcha-human-fallback');
    const restored = await humanCaptcha.tryAllSessions(page);
    if (restored) return true;
    const email = CONFIG.getMicrosoftEmail?.() || CONFIG.MICROSOFT_EMAIL;
    const password = CONFIG.getMicrosoftPassword?.() || CONFIG.MICROSOFT_PASSWORD;
    return this.authenticate(page, { email, password });
  }
}

const _authManagerInstance = new AuthManager();
_authManagerInstance._injectDependencies = _injectDependencies;
module.exports = _authManagerInstance;
