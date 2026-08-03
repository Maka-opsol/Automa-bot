'use strict';
const { getPageViewport } = require('./browser');
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): any { return _deps.config || {}; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

let lastActions: any[] = [];
function resetStagnationState() { lastActions = []; lastScreenshotHash = null; }

let lastScreenshotHash: any = null;

async function recoverIfStuck(page: any, screenshotBuffer: any, action: any) { 
  if (!action || !action.actionType) return;
  const currentHash = require('crypto').createHash('md5').update(screenshotBuffer).digest('hex');
  if (lastScreenshotHash === currentHash) {
    const CONFIG = getCONFIG();
    log('⚠️ Screenshot unchanged -- possible stagnation.', 'WARN', 'stagnation');
    if (CONFIG.ALERT_ON_STAGNATION) try { getSendAlert()('Stagnation detected: screenshot unchanged'); } catch (e: any) {}
    await page.reload();
    await sleep(5000);
    _deps.browser?.scrollPage?.(page, 0, 300);
    await sleep(2000);
    lastScreenshotHash = null;
    return;
  }
  lastScreenshotHash = currentHash;
  const CONFIG = getCONFIG();
  lastActions.push(action.actionType);
  while (lastActions.length > CONFIG.MAX_CONSECUTIVE_SAME_ACTION) lastActions.shift();
  if (lastActions.length === CONFIG.MAX_CONSECUTIVE_SAME_ACTION) {
    const allSame = lastActions.every(a => a === lastActions[0]);
    if (allSame && lastActions[0] !== 'wait') {
      log(`⚠️ Repeated action ${lastActions[0]} ${CONFIG.MAX_CONSECUTIVE_SAME_ACTION} times -- attempting recovery.`, 'WARN', 'stagnation');
      if (CONFIG.ALERT_ON_STAGNATION) try { getSendAlert()(`Repeated action ${lastActions[0]} ${CONFIG.MAX_CONSECUTIVE_SAME_ACTION} times`); } catch (e: any) {}
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
