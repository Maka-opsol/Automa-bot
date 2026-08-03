'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);


class FlutterStabilityWaiter {
  async waitForStable(page: any, timeoutMs = 15000) { 
    log('⏳ Waiting for Flutter UI to stabilize...', 'DEBUG', 'stability');
    const start = Date.now();
    let previousCount = 0;
    let stableCount = 0;
    while (Date.now() - start < timeoutMs) {
      let count;
      try {
        count = await page.evaluate(() => {
          if (window.flutter?.web?.engine?.semantics?._semantics) { return Object.keys(window.flutter.web.engine.semantics._semantics).length; }
          return document.querySelectorAll('button, [role="button"], input').length;
        });
      } catch (e: any) { return false; }
      if (count === previousCount && count > 0) { stableCount++; if (stableCount >= 3) { log(`✅ UI stabilized with ${count} interactive elements.`, 'DEBUG', 'stability'); return true; } } else { stableCount = 0; previousCount = count; }
      await sleep(200);
    }
    log('⚠️ Stability wait timed out, proceeding anyway.', 'WARN', 'stability');
    return false;
  }
}

module.exports = Object.assign(new FlutterStabilityWaiter(), { _injectDependencies });