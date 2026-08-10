'use strict';
const { sleep } = require('./utils-sleep');

const BaseAuthStrategy = require('./auth-strategies-base');
const { selectorManager, getSelectorsWithFallbacks } = require('./selectors');
const { log, logError } = require('./logger');

class MicrosoftAuthV2 extends BaseAuthStrategy {
  selectors: any = null;
  constructor() { super('microsoft', '2'); this.selectors = null; }
  async init() { this.selectors = selectorManager.getSelectors('microsoft-login'); }
  async canHandle(page: any) { await this.init(); const url = page.url(); return url.includes('login.microsoftonline.com'); }

  async authenticate(page: any, credentials: any) {
    await this.init();
    if (!this.selectors?.selectors) throw new Error('Microsoft auth selectors not loaded');
    const { emailInput, passwordInput, submitButton } = this.selectors.selectors;

    // ── Step 1: Email ──
    const emailEl = await this._findElement(page, emailInput, 'email');
    if (!emailEl) throw new Error('Email input not found');
    await emailEl.fill(credentials.email);
    const emailBtn = await this._findElement(page, submitButton, 'submit (email)');
    if (emailBtn) await emailBtn.click();
    await sleep(3000);

    // ── Step 1.5: Handle unexpected pages after email submit ──
    const afterEmailUrl = page.url();
    if (this._isMfaPage(page, afterEmailUrl)) {
      log('MFA/2FA page detected after email submit — cannot proceed automatically', 'ERROR', 'auth');
      throw new Error('MFA_REQUIRED: Multi-factor authentication page detected after email submit');
    }
    if (this._isRecoveryPage(afterEmailUrl)) {
      log('Account recovery page detected — skipping', 'WARN', 'auth');
      throw new Error('RECOVERY_PAGE: Account recovery page detected');
    }

    // ── Step 2: Password ──
    const passEl = await this._findElement(page, passwordInput, 'password');
    if (!passEl) throw new Error('Password input not found');
    await passEl.fill(credentials.password);
    const passBtn = await this._findElement(page, submitButton, 'submit (password)');
    if (passBtn) await passBtn.click();
    await sleep(5000);

    // ── Step 3: KMSI (Keep Me Signed In) ──
    const postAuthUrl = page.url();
    if (postAuthUrl.includes('/kmsi')) {
      log('KMSI page detected — clicking Yes', 'INFO', 'auth');
      const kmsiClicked = await this._handleKmsi(page);
      if (!kmsiClicked) {
        log('KMSI handling failed — continuing anyway', 'WARN', 'auth');
      }
      await sleep(3000);
    }

    // ── Step 4: MFA check after password submit ──
    const finalUrl = page.url();
    if (this._isMfaPage(page, finalUrl)) {
      log('MFA/2FA page detected after password submit — cannot proceed', 'ERROR', 'auth');
      throw new Error('MFA_REQUIRED: Multi-factor authentication required');
    }

    // ── Step 5: Post-auth verification ──
    // BUG: Original code always returned true without checking if auth succeeded.
    // FIX: Verify we actually left the Microsoft login domain.
    const verifyUrl = page.url();
    if (verifyUrl.includes('login.microsoftonline.com') || verifyUrl.includes('login.live.com')) {
      // Still on Microsoft login — check for error messages
      const errorMsg = await this._detectAuthError(page);
      if (errorMsg) {
        log(`Auth failed: ${errorMsg}`, 'ERROR', 'auth');
        throw new Error(`AUTH_FAILED: ${errorMsg}`);
      }
      // No error detected but still on login page — could be slow redirect
      log('Still on Microsoft login page after auth — waiting for redirect...', 'WARN', 'auth');
      await sleep(5000);
      const retryUrl = page.url();
      if (retryUrl.includes('login.microsoftonline.com')) {
        log('Auth verification failed: still on Microsoft login after 10s', 'ERROR', 'auth');
        throw new Error('AUTH_STUCK: Did not redirect from Microsoft login page');
      }
    }

    log('Microsoft authentication verified successfully', 'INFO', 'auth');
    return true;
  }

  /**
   * Find an element using selector string or fallback chain.
   * Tries the primary selector, then FALLBACK_SELECTORS from selectors.ts.
   */
  async _findElement(page: any, selector: string, role: string): Promise<any> {
    // Try primary selector
    try {
      const el = await page.$(selector);
      if (el) return el;
    } catch {}

    // Try fallback selectors based on role
    const fallbackKey = role.includes('email') ? 'email-input'
      : role.includes('password') ? 'password-input'
      : role.includes('submit') ? 'signin-button' : null;

    if (fallbackKey) {
      const fallbacks = getSelectorsWithFallbacks(fallbackKey);
      for (const fb of fallbacks) {
        try {
          const el = await page.$(fb);
          if (el) {
            log(`Used fallback selector for ${role}: ${fb}`, 'DEBUG', 'auth');
            return el;
          }
        } catch {}
      }
    }

    return null;
  }

  /**
   * Detect MFA/2FA pages.
   * Checks for:
   *   - URL patterns: /saml2, /mfa, /proofup, /strongauth
   *   - Page content: 'Approve the sign-in', 'Enter your code', 'authenticator app',
   *     'Microsoft Authenticator', 'verification code'
   *   - MFA-specific elements
   */
  _isMfaPage(page: any, url?: string): boolean {
    const currentUrl = url || page.url();

    // URL-based detection (most reliable)
    const mfaUrlPatterns = ['/saml2', '/mfa', '/proofup', '/strongauth', '/convergedlogin/MFA'];
    for (const pattern of mfaUrlPatterns) {
      if (currentUrl.includes(pattern)) return true;
    }

    // Content-based detection (via cached selectors)
    if (this.selectors?.patterns?.isRecoveryUrl) {
      try {
        const recoveryRegex = new RegExp(this.selectors.patterns.isRecoveryUrl, 'i');
        if (recoveryRegex.test(currentUrl)) return false; // Recovery is not MFA
      } catch {}
    }

    return false;
  }

  /**
   * Check if the current URL is a recovery page (forgot password, etc.)
   */
  _isRecoveryPage(url: string): boolean {
    const recoveryPatterns = ['/recovery', '/resetpassword', '/forgotpassword'];
    for (const p of recoveryPatterns) {
      if (url.includes(p)) return true;
    }
    if (this.selectors?.patterns?.isRecoveryUrl) {
      try {
        return new RegExp(this.selectors.patterns.isRecoveryUrl, 'i').test(url);
      } catch {}
    }
    return false;
  }

  /**
   * Handle KMSI (Keep Me Signed In) page.
   * Tries multiple approaches to click 'Yes' on the KMSI prompt.
   */
  async _handleKmsi(page: any): Promise<boolean> {
    // Try selectors in order of reliability
    const kmsiSelectors = [
      '#idBtn_Back',                    // Microsoft's standard KMSI button ID
      'button:has-text("Stay signed in")',
      'button:has-text("Yes")',
      'button:has-text("stay signed in")',
      'input[id="idBtn_Back"]',
      'button[type="submit"]',        // Last resort: any submit button on KMSI page
    ];

    for (const sel of kmsiSelectors) {
      try {
        const el = await page.$(sel);
        if (el) {
          await el.click();
          log(`KMSI clicked via: ${sel}`, 'DEBUG', 'auth');
          return true;
        }
      } catch {}
    }

    return false;
  }

  /**
   * Detect common auth error messages on Microsoft login page.
   */
  async _detectAuthError(page: any): Promise<string | null> {
    try {
      const errorText = await page.evaluate(() => {
        // Microsoft login error elements
        const errorEl = document.querySelector('#idPageTitle, .alert-error, [role="alert"], .error-message');
        if (errorEl) return errorEl.textContent || '';
        // Also check for common error patterns in body text
        const body = document.body?.innerText || '';
        const errorPatterns = [
          'incorrect password',
          'account is locked',
          'too many failed attempts',
          'temporary blocked',
          'suspended',
          'doesn\'t exist',
        ];
        for (const pattern of errorPatterns) {
          if (body.toLowerCase().includes(pattern)) return pattern;
        }
        return '';
      }).catch(() => '');

      if (errorText && errorText.trim().length > 0) {
        return errorText.trim();
      }
    } catch {}
    return null;
  }

  async detectCaptcha(page: any) {
    if (!this.selectors?.selectors) return false;
    const { captchaContainer } = this.selectors.selectors;
    const { isCaptchaTitle } = this.selectors.patterns || {};
    if (captchaContainer && await page.$(captchaContainer)) return true;
    const title = await page.title();
    if (isCaptchaTitle && title.toLowerCase().includes(isCaptchaTitle.toLowerCase())) return true;
    // FIX: Also detect MFA as a non-captcha blocker
    if (this._isMfaPage(page)) {
      log('MFA detected during captcha check — not a captcha', 'DEBUG', 'auth');
      return false; // Don't try to solve MFA as if it's a captcha
    }
    return false;
  }

  async solveCaptcha(page: any) {
    if (!this.selectors?.selectors) return false;
    const { captchaImage, captchaInput, submitButton } = this.selectors.selectors;
    const img = await page.$(captchaImage);
    if (!img) { log('Could not locate CAPTCHA image.', 'ERROR', 'auth'); return false; }
    const screenshot = await img.screenshot({ type: 'jpeg', quality: 60 });
    const base64 = screenshot.toString('base64');
    const { extractMicrosoftCaptchaText } = require('./providers');
    let text = await extractMicrosoftCaptchaText(base64);
    if (!text) {
      const humanCaptcha = require('./captcha-human-fallback');
      text = await humanCaptcha.requestHumanCaptcha(base64);
    }
    if (!text) return false;
    const input = await page.$(captchaInput);
    if (!input) { log('Could not locate CAPTCHA input field.', 'ERROR', 'auth'); return false; }
    await input.click();
    await input.fill(text);
    const submit = await page.$(submitButton);
    if (submit) { await submit.click(); await sleep(3000); return true; }
    return false;
  }
}

module.exports = MicrosoftAuthV2;
