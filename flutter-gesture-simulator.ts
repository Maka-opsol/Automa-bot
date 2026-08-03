'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);
const CONFIG = require('./get-config');


class FlutterGestureSimulator {
  async performSwipe(page: any, startX: any, startY: any, endX: any, endY: any, duration = 800) { 
    log(`🖐️ Simulating swipe from (${startX},${startY}) to (${endX},${endY})`, 'DEBUG', 'gesture');
    let cdp = null;
    try {
      cdp = await page.context().newCDPSession(page);
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: startX, y: startY }] });
      const steps = 20;
      for (let i = 1; i <= steps; i++) {
        const t = i / steps;
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;
        const x = startX + (endX - startX) * ease;
        const y = startY + (endY - startY) * ease;
        await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y }] });
        await sleep(duration / steps);
      }
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      log('✅ Swipe gesture dispatched.', 'DEBUG', 'gesture');
    } catch (e: any) { logError('Swipe failed, falling back to mouse scroll', e); await page.mouse.move(startX, startY); await page.mouse.down(); await page.mouse.move(endX, endY, { steps: 20 }); await page.mouse.up(); } finally { if (cdp) { await cdp.detach().catch(() => {}); } }
  }

  async performLongPress(page: any, x: any, y: any) { 
    await page.mouse.move(x, y);
    await page.mouse.down();
    await sleep(CONFIG.LONG_PRESS_DELAY_MS || 600);
    await page.mouse.up();
  }
}

module.exports = Object.assign(new FlutterGestureSimulator(), { _injectDependencies });