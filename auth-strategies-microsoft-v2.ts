'use strict';
const { sleep } = require('./utils-sleep');

const BaseAuthStrategy = require('./auth-strategies-base');
const { selectorManager } = require('./selectors');
const { log, logError } = require('./logger');

class MicrosoftAuthV2 extends BaseAuthStrategy {
  selectors: any = null;
  constructor() { super('microsoft', '2'); this.selectors = null; }
  async init() {  this.selectors = selectorManager.getSelectors('microsoft-login'); }
  async canHandle(page: any) { await this.init(); const url = page.url(); return url.includes('login.microsoftonline.com'); }
  async authenticate(page: any, credentials: any) { 
    await this.init();
    if (!this.selectors?.selectors) throw new Error('Microsoft auth selectors not loaded');
    const { emailInput, passwordInput, submitButton } = this.selectors.selectors;
    const emailEl = await page.$(emailInput);
    if (!emailEl) throw new Error('Email input not found');
    await emailEl.fill(credentials.email);
    const emailBtn = await page.$(submitButton);
    if (emailBtn) await emailBtn.click();
    await sleep(3000);
    const passEl = await page.$(passwordInput);
    if (!passEl) throw new Error('Password input not found');
    await passEl.fill(credentials.password);
    const passBtn = await page.$(submitButton);
    if (passBtn) await passBtn.click();
    await sleep(5000);
    return true;
  }
  async detectCaptcha(page: any) {
    if (!this.selectors?.selectors) return false;
    const { captchaContainer } = this.selectors.selectors;
    const { isCaptchaTitle } = this.selectors.patterns || {};
    if (captchaContainer && await page.$(captchaContainer)) return true;
    const title = await page.title();
    if (isCaptchaTitle && title.toLowerCase().includes(isCaptchaTitle.toLowerCase())) return true;
    return false;
  }
  async solveCaptcha(page: any) {
    if (!this.selectors?.selectors) return false;
    const { captchaImage, captchaInput, submitButton } = this.selectors.selectors;
    const img = await page.$(captchaImage);
    if (!img) { log('❌ Could not locate CAPTCHA image.', 'ERROR', 'auth'); return false; }
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
    if (!input) { log('❌ Could not locate CAPTCHA input field.', 'ERROR', 'auth'); return false; }
    await input.click();
    await input.fill(text);
    const submit = await page.$(submitButton);
    if (submit) { await submit.click(); await sleep(3000); return true; }
    return false;
  }
}

module.exports = MicrosoftAuthV2;
