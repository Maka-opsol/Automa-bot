'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);
const CONFIG = require('./get-config');


class BruteForceNavigator {
  tried: any;
  maxTries: any;

  constructor() {
    this.tried = new Set();
    this.maxTries = CONFIG.BRUTE_FORCE_MAX_TRIES || 50;
  }

  async bruteForceNavigate(page: any) { 
    log('💪 Initiating Brute Force Navigation (DOM scraping)...', 'WARN', 'bruteforce');
    // v18: Guard against closed page/context/browser. Memory protection
    // (memory-mode) may close the browser mid-cycle, leaving a stale page
    // reference. All page.evaluate / page.mouse calls would throw
    // "Target page, context or browser has been closed" and crash the cycle.
    try {
      if (!page || page.isClosed?.()) {
        log('Brute force skipped — page is closed', 'WARN', 'bruteforce');
        return false;
      }
      if (page.context?.()?.browser?.()?.isConnected?.() === false) {
        log('Brute force skipped — browser disconnected', 'WARN', 'bruteforce');
        return false;
      }
    } catch { /* property access may throw on dead proxy — fall through to try/catch below */ }
    try {
      const elements = await page.evaluate(() => {
        const selectors = ['button', 'a', 'input[type="submit"]', '[role="button"]', '.clickable'];
        const all: any[] = [];
        for (const sel of selectors) {
          document.querySelectorAll(sel).forEach((el: any) => {
            const rect = el.getBoundingClientRect();
            // Skip hidden or zero-size elements (would produce NaN/invalid coords)
            if (rect.width === 0 || rect.height === 0) return;
            all.push({ x: rect.x + rect.width/2, y: rect.y + rect.height/2, text: el.innerText || el.getAttribute('aria-label'), tag: el.tagName });
          });
        }
        return all;
      });
      const unique = elements.filter((e: any) => !this.tried.has(`${e.x},${e.y}`)).slice(0, this.maxTries);
      for (const el of unique) {
        this.tried.add(`${el.x},${el.y}`);
        log(`🔨 Brute forcing click on "${el.text || el.tag}" at ${el.x},${el.y}`, 'DEBUG', 'bruteforce');
        const beforeUrl = page.url();
        await page.mouse.click(el.x, el.y);
        await sleep(3000);
        const afterUrl = page.url();
        if (afterUrl !== beforeUrl) { log(`✅ Brute force succeeded! Navigated to ${afterUrl}`, 'INFO', 'bruteforce'); this.tried.clear(); return true; }
      }
      log('❌ Brute force failed to find a path.', 'WARN', 'bruteforce');
      return false;
    } catch (navErr: any) {
      const msg = navErr?.message || String(navErr);
      if (msg.includes('closed') || msg.includes('Closed') || msg.includes('disconnected')) {
        log(`Brute force aborted — page/browser was closed: ${msg}`, 'WARN', 'bruteforce');
        return false;
      }
      throw navErr; // Re-throw unexpected errors
    }
  }
}

module.exports = Object.assign(new BruteForceNavigator(), { _injectDependencies });
