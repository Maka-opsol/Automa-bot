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
  }
}

module.exports = Object.assign(new BruteForceNavigator(), { _injectDependencies });