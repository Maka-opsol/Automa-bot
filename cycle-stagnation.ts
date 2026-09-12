'use strict';
const { getPageViewport } = require('./browser');
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): any { return _deps.config || {}; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

let lastActions: any[] = [];
let lastScreenshotHash: any = null;
let consecutiveUnchangedCount = 0;
const MAX_CONSECUTIVE_UNCHANGED = 3; // Only alert/reload after 3 cycles with same screenshot

function resetStagnationState() { lastActions = []; lastScreenshotHash = null; consecutiveUnchangedCount = 0; }

async function recoverIfStuck(page: any, screenshotBuffer: any, action: any) { 
  if (!action || !action.actionType) return;
  const currentHash = require('crypto').createHash('md5').update(screenshotBuffer).digest('hex');
  if (lastScreenshotHash === currentHash) {
    consecutiveUnchangedCount++;
    if (consecutiveUnchangedCount >= MAX_CONSECUTIVE_UNCHANGED) {
      const CONFIG = getCONFIG();
      log(`⚠️ Screenshot unchanged ${consecutiveUnchangedCount} consecutive cycles -- possible stagnation.`, 'WARN', 'stagnation');
      // TASK 61: Removed alert — routine event.
      // TASK 52 (2026-09-11): Use domcontentloaded + timeout + try/catch.
      // Old code used page.reload() with default 'load' wait — hangs on
      // font/image resources through proxy, throws ERR_CONNECTION_CLOSED.
      try {
        await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
      } catch (reloadErr: any) {
        log(`Stagnation reload failed (non-critical): ${reloadErr?.message || reloadErr}`, 'DEBUG', 'stagnation');
      }
      await sleep(5000);
      _deps.browser?.scrollPage?.(page, 0, 300);
      await sleep(2000);
      lastScreenshotHash = null;
      consecutiveUnchangedCount = 0;
    }
    return;
  }
  // Screenshot changed — reset counter
  consecutiveUnchangedCount = 0;
  lastScreenshotHash = currentHash;
  const CONFIG = getCONFIG();
  lastActions.push(action.actionType);
  while (lastActions.length > CONFIG.MAX_CONSECUTIVE_SAME_ACTION) lastActions.shift();
  if (lastActions.length === CONFIG.MAX_CONSECUTIVE_SAME_ACTION) {
    const allSame = lastActions.every(a => a === lastActions[0]);
    if (allSame && lastActions[0] !== 'wait') {
      log(`⚠️ Repeated action ${lastActions[0]} ${CONFIG.MAX_CONSECUTIVE_SAME_ACTION} times -- attempting recovery.`, 'WARN', 'stagnation');
      if (CONFIG.ALERT_ON_STAGNATION) try { getSendAlert()(`Repeated action ${lastActions[0]} ${CONFIG.MAX_CONSECUTIVE_SAME_ACTION} times`); } catch (e: any) {}

      // BUG FIX (2026-09-07): If a proxy is active and actions are repeating,
      // the proxy may be silently dropping the bot's actions (clicks, taps not
      // registering). Disable the proxy so the browser uses a direct connection.
      // BUG FIX (2026-09-09): Use bypassProxy() to FULLY shut down the proxy
      // (clears env vars + resets ip-rotator state), not just set the flag.
      try {
        const ipRotator = require('./network-ip-rotator');
        const currentProxy = ipRotator.getCurrentProxy?.();
        if (currentProxy && !(globalThis as any).__proxyDisabled) {
          log(`Proxy was active (${currentProxy}) when actions stopped working — DISABLING PROXY (actions may not be registering through proxy). Browser will relaunch with direct connection.`, 'ERROR', 'stagnation');
          // TASK 61: Removed alert — routine event.
          if (typeof ipRotator.bypassProxy === 'function') {
            ipRotator.bypassProxy(`repeated actions not working (stagnation)`);
          } else {
            (globalThis as any).__proxyDisabled = true;
          }
        }
      } catch {}

      const vp = getPageViewport(page);
      const x = Math.floor(Math.random() * (vp ? vp.width : CONFIG.DISPLAY_WIDTH));
      const y = Math.floor(Math.random() * (vp ? vp.height : CONFIG.DISPLAY_HEIGHT));
      await page.mouse.click(x, y);
      await sleep(2000);
      lastActions = [];
    }
  }
}

module.exports = { recoverIfStuck , resetStagnationState, _injectDependencies };
