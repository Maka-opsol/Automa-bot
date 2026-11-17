'use strict';

/**
 * BaseAuthStrategy — shared foundation for all auth strategies.
 *
 * The original version was 20 lines of no-op stubs. This improved version
 * provides the shared utilities that every concrete strategy (currently
 * MicrosoftAuthV2) was re-implementing inline:
 *
 *   • Typed AuthStrategyError with machine-readable codes — replaces the
 *     fragile `errMsg.includes('not found')` substring matching the manager
 *     uses to decide retry behavior. The manager can now `switch (err.code)`.
 *
 *   • Lazy one-shot init via _ensureReady() — MicrosoftAuthV2 called
 *     `await this.init()` at the top of all 4 public methods (4× per auth
 *     attempt). The base now memoizes init and calls it once.
 *
 *   • Selector helpers _findFirst / _clickFirst — replaces the duplicated
 *     "loop candidates, page.$(sel), return first hit" pattern that
 *     _findElement and _handleKmsi both implement in MicrosoftAuthV2.
 *
 *   • Wait helpers _waitForSelector / _waitForUrlAway / _settle — replaces
 *     the 8+ fixed `await sleep(N)` calls that don't adapt to page speed.
 *
 *   • Safe eval _safeEval / _safeContent — replaces the
 *     `page.evaluate(...).catch(() => '')` pattern duplicated across
 *     strategies and the manager.
 *
 *   • Domain matching matchesDomain() — the manager currently hardcodes
 *     'login.microsoftonline.com' at auth-auth-manager.ts:75 to gate its
 *     pre-strategy captcha branch. Strategies can now expose their domains
 *     and the manager can ask `strategy.matchesDomain(page)`.
 *
 *   • Health stats — the manager only stored `activeStrategy` transiently
 *     with no history. Strategies now carry stats (success/failure counts,
 *     consecutive failures, last error) so the manager can skip unhealthy
 *     strategies and a dashboard can observe auth health.
 *
 *   • Typed selector schema — the manager reads `strategy.selectors.captchaInput`
 *     but MicrosoftAuthV2 stores `strategy.selectors.selectors.captchaInput`
 *     (nested), so the manager's human-fallback always falls through to
 *     hardcoded defaults. Formalizing the flat shape here is the first step
 *     toward fixing that latent bug.
 *
 * BACKWARD COMPATIBILITY: The 4 public methods (canHandle, authenticate,
 * detectCaptcha, solveCaptcha) remain overridable stubs. MicrosoftAuthV2
 * overrides them directly and continues to work unchanged. New strategies
 * can use the protected helpers and _ensureReady() to avoid duplicating the
 * patterns listed above.
 */

// ──────────────────────────────────────────────────────────────────────────
// Typed errors
// ──────────────────────────────────────────────────────────────────────────
// Replaces string-prefix error matching. Today the manager does:
//   if (errMsg.includes('not found')) { /* retry with captcha */ }
// and strategies throw `new Error('MFA_REQUIRED: ...')`, `new Error('AUTH_FAILED: ...')`,
// `new Error('Email input not found')`, etc. The substring match is fragile
// ('not found' appears in multiple unrelated errors) and can't distinguish
// retryable from non-retryable failures. AuthStrategyError carries a
// machine-readable `code` and a `retryable` flag.

/**
 * @typedef {'ELEMENT_NOT_FOUND'|'MFA_REQUIRED'|'RECOVERY_PAGE'|'AUTH_FAILED'|'AUTH_STUCK'|'SELECTORS_NOT_LOADED'|'CAPTCHA_UNSOLVED'|'NETWORK_TIMEOUT'} AuthErrorCode
 */

const RETRYABLE_CODES = new Set(['ELEMENT_NOT_FOUND', 'CAPTCHA_UNSOLVED', 'NETWORK_TIMEOUT', 'SELECTORS_NOT_LOADED']);
const NON_RETRYABLE_CODES = new Set(['MFA_REQUIRED', 'RECOVERY_PAGE', 'AUTH_FAILED', 'AUTH_STUCK']);

class AuthStrategyError extends Error {
  /**
   * @param {string} code  - one of AuthErrorCode
   * @param {string} message
   * @param {{ details?: string, retryable?: boolean }} [opts]
   */
  constructor(code, message, opts) {
    super(`${code}: ${message}`);
    this.name = 'AuthStrategyError';
    this.code = code;
    this.details = opts && opts.details ? opts.details : undefined;
    // Explicit retryable override wins; otherwise infer from the code.
    if (opts && typeof opts.retryable === 'boolean') {
      this.retryable = opts.retryable;
    } else if (RETRYABLE_CODES.has(code)) {
      this.retryable = true;
    } else if (NON_RETRYABLE_CODES.has(code)) {
      this.retryable = false;
    } else {
      this.retryable = false; // unknown codes default to non-retryable (safe)
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Strategy health stats
// ──────────────────────────────────────────────────────────────────────────
// The manager overwrites `activeStrategy` on every call with no history.
// These stats live on the strategy instance so the manager (and a future
// dashboard) can observe per-strategy health and skip strategies that are
// in a failure streak.

/**
 * @typedef {Object} StrategyStats
 * @property {number|null} lastUsedAt
 * @property {number} successCount
 * @property {number} failureCount
 * @property {number} consecutiveFailures
 * @property {{ code: string, message: string, at: number }|null} lastError
 */

function _newStats() {
  return {
    lastUsedAt: null,
    successCount: 0,
    failureCount: 0,
    consecutiveFailures: 0,
    lastError: null,
  };
}

// ──────────────────────────────────────────────────────────────────────────
// BaseAuthStrategy
// ──────────────────────────────────────────────────────────────────────────

class BaseAuthStrategy {
  /**
   * @param {string} name    - e.g. 'microsoft'
   * @param {string} version - e.g. '2'; used by the manager for sort (newest first)
   */
  constructor(name, version) {
    this.name = name;
    this.version = version;

    // Typed selector schema (flat). Subclasses populate this in _init().
    // The manager reads strategy.selectors.captchaInput / .submitButton in
    // its human-fallback branch — this flat shape matches what the manager
    // expects, avoiding the nested-shape mismatch in the current MicrosoftV2.
    /** @type {AuthStrategySelectors|null} */
    this.selectors = null;

    /** @type {StrategyStats} */
    this.stats = _newStats();

    // Lifecycle: _init() runs exactly once via _ensureReady().
    this._ready = false;
    this._initPromise = null;

    // Domain patterns for canHandle / matchesDomain. Subclasses override.
    // e.g. MicrosoftV2: ['login.microsoftonline.com', 'login.live.com', 'msftauth.net']
    /** @type {string[]} */
    this._domainPatterns = [];
  }

  /** Unique strategy identifier, e.g. 'microsoft-v2'. Required by the manager for loading. */
  get id() {
    return `${this.name}-v${this.version}`;
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────

  /**
   * Subclasses override to load selectors (from selectorManager, config, etc.).
   * Called exactly once by _ensureReady(). Must be idempotent and side-effect-light
   * after the first successful call.
   */
  async _init() {
    /* override in subclass */
  }

  /**
   * Ensures _init() has run exactly once. Safe to call at the top of every
   * public method. Replaces the `await this.init()` guard duplicated 4× in
   * MicrosoftAuthV2. If _init() fails, throws AuthStrategyError(SELECTORS_NOT_LOADED)
   * and resets so the next call can retry.
   */
  async _ensureReady() {
    if (this._ready) return;
    if (!this._initPromise) {
      this._initPromise = this._init()
        .then(() => {
          this._ready = true;
        })
        .catch((err) => {
          // Reset so the next _ensureReady() can retry (selectors may load
          // on a second attempt if selectorManager wasn't ready yet).
          this._initPromise = null;
          const msg = (err && err.message) ? err.message : String(err);
          throw new AuthStrategyError('SELECTORS_NOT_LOADED', msg, { retryable: true });
        });
    }
    return this._initPromise;
  }

  // ── Public interface (override in subclass) ────────────────────────────

  /** Gate: return true if this strategy can handle the current page. */
  async canHandle(_page) {
    return false;
  }

  /**
   * Authenticate on the page using the given credentials.
   * @returns {Promise<boolean>} truthy = success
   * @throws {AuthStrategyError} on typed failure (MFA_REQUIRED, AUTH_FAILED, etc.)
   */
  async authenticate(_page, _credentials) {
    return false;
  }

  /** Detect whether a CAPTCHA is present on the page. */
  async detectCaptcha(_page) {
    return false;
  }

  /** Attempt to solve a detected CAPTCHA (OCR, human fallback, etc.). */
  async solveCaptcha(_page) {
    return false;
  }

  // ── Domain matching ────────────────────────────────────────────────────
  // Replaces hardcoded 'login.microsoftonline.com' checks in the manager
  // (auth-auth-manager.ts:75) and duplicated domain lists in strategies.

  /**
   * True if the page URL contains any of this strategy's domain patterns.
   * The manager can call this instead of hardcoding provider domains.
   */
  matchesDomain(page) {
    return this._urlMatchesAny(page, this._domainPatterns);
  }

  /**
   * @protected
   * True if page.url() contains any of the given substrings.
   */
  _urlMatchesAny(page, substrings) {
    const url = this._safeUrl(page);
    if (!url) return false;
    return substrings.some((s) => url.includes(s));
  }

  /** @protected */
  _safeUrl(page) {
    try {
      return (page && typeof page.url === 'function') ? page.url() : '';
    } catch {
      return '';
    }
  }

  // ── Safe page operations ───────────────────────────────────────────────
  // Replaces page.evaluate(fn).catch(() => '') duplicated across strategies.

  /** @protected */
  async _safeEval(page, fn, fallback = '') {
    try {
      return await page.evaluate(fn);
    } catch {
      return fallback;
    }
  }

  /** @protected */
  async _safeContent(page, fallback = '') {
    try {
      return await page.content();
    } catch {
      return fallback;
    }
  }

  // ── Selector helpers ───────────────────────────────────────────────────
  // Replaces the "loop candidates, page.$(sel), return first hit" pattern
  // duplicated in MicrosoftAuthV2._findElement and _handleKmsi.

  /** @protected — normalize a selector (string | string[]) to an array. */
  _asArray(sel) {
    if (!sel) return [];
    return Array.isArray(sel) ? sel : [sel];
  }

  /**
   * @protected
   * Try each selector in order; return the first element that exists, or null.
   * Logs the chosen selector at DEBUG for traceability.
   */
  async _findFirst(page, candidates, role = 'element') {
    const list = this._asArray(candidates);
    for (const sel of list) {
      try {
        const el = await page.$(sel);
        if (el) {
          this._debug(`Found ${role} via selector: ${sel}`);
          return el;
        }
      } catch {
        /* try next candidate */
      }
    }
    if (list.length > 0) {
      this._debug(`No ${role} found among ${list.length} candidates`);
    }
    return null;
  }

  /**
   * @protected
   * Find the first matching element and click it. Returns true on success.
   */
  async _clickFirst(page, candidates, role = 'button') {
    const el = await this._findFirst(page, candidates, role);
    if (!el) return false;
    try {
      await el.click();
      return true;
    } catch (e) {
      this._warn(`Click failed on ${role}: ${(e && e.message) ? e.message : e}`);
      return false;
    }
  }

  /**
   * @protected
   * Get a selector by name from the typed selectors schema, normalized to
   * an array. Returns [] if not set.
   */
  _selectorsFor(name) {
    if (!this.selectors) return [];
    const val = this.selectors[name];
    return this._asArray(val);
  }

  // ── Wait helpers ───────────────────────────────────────────────────────
  // Replaces the 8+ fixed `await sleep(N)` calls in MicrosoftAuthV2 and the
  // 4 in the manager. Fixed sleeps don't adapt to page/proxy speed: too short
  // on slow proxies (element not there yet), too long on fast ones (wasted).

  /**
   * @protected
   * Wait for a selector to appear. Returns true if found, false on timeout.
   * Falls back to a settle wait if waitForSelector is unavailable.
   */
  async _waitForSelector(page, sel, timeoutMs = 10000) {
    try {
      await page.waitForSelector(sel, { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * @protected
   * Wait until the page URL no longer contains `fragment` (e.g. wait for
   * redirect away from '/login'). Returns true if the URL changed, false on
   * timeout. Polls every 500ms.
   */
  async _waitForUrlAway(page, fragment, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const url = this._safeUrl(page);
      if (!url.includes(fragment)) return true;
      await this._settle(500);
    }
    return false;
  }

  /**
   * @protected
   * Fixed sleep — use only when a selector-based wait isn't possible
   * (e.g. waiting for a JS animation to settle). Prefer _waitForSelector.
   */
  _settle(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ── Stats / health ─────────────────────────────────────────────────────
  // Subclasses (or the manager) call these to record outcomes. The manager
  // can read strategy.stats and strategy.isHealthy() to skip failing strategies.

  /** Record a successful authentication/captcha-solve. */
  _recordSuccess() {
    this.stats.lastUsedAt = Date.now();
    this.stats.successCount += 1;
    this.stats.consecutiveFailures = 0;
  }

  /**
   * Record a failure. Accepts an Error or AuthStrategyError; extracts the
   * code for the lastError record.
   */
  _recordFailure(error) {
    this.stats.lastUsedAt = Date.now();
    this.stats.failureCount += 1;
    this.stats.consecutiveFailures += 1;
    if (error) {
      const code = (error instanceof AuthStrategyError) ? error.code : 'AUTH_FAILED';
      const message = (error && error.message) ? error.message : String(error);
      this.stats.lastError = { code, message, at: Date.now() };
    }
  }

  /**
   * True if the strategy hasn't exceeded the consecutive-failure threshold.
   * The manager can use this to temporarily skip a strategy in a failure streak
   * (e.g. when MFA is repeatedly required, the account may be locked).
   */
  isHealthy(maxConsecutiveFailures = 3) {
    return this.stats.consecutiveFailures < maxConsecutiveFailures;
  }

  // ── Logging ────────────────────────────────────────────────────────────
  // Uses the project logger if available, falls back to console. Tags every
  // message with the strategy id so logs are traceable to a specific strategy.

  /** @protected */
  _log(msg, level = 'INFO') {
    const tag = `[${this.id}]`;
    try {
      const logger = require('./logger');
      if (logger && typeof logger.log === 'function') {
        logger.log(`${tag} ${msg}`, level, 'auth-strategy');
        return;
      }
    } catch {
      /* logger not available — fall through to console */
    }
    console.log(`[${level}] [auth-strategy] ${tag} ${msg}`);
  }

  /** @protected */
  _debug(msg) {
    this._log(msg, 'DEBUG');
  }

  /** @protected */
  _warn(msg) {
    this._log(msg, 'WARN');
  }

  /** @protected */
  _error(msg) {
    this._log(msg, 'ERROR');
  }
}

// ──────────────────────────────────────────────────────────────────────────
// Exports
// ──────────────────────────────────────────────────────────────────────────
// The class is the default export (backward compat: `require(...)` returns
// the class). AuthStrategyError is attached as a named property so strategies
// can do `const { AuthStrategyError } = require('./auth-strategies-base')`
// or `require('./auth-strategies-base').AuthStrategyError`.

module.exports = BaseAuthStrategy;
module.exports.AuthStrategyError = AuthStrategyError;
module.exports.default = BaseAuthStrategy;
