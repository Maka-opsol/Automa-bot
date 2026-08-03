'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);


class FlutterEngineInspector {
  async getRenderObjects(page: any) { 
    try {
      const objects = await page.evaluate(() => {
        const engine = window.flutter?.web?.engine || window._flutter?.engine || window.flutterEngine;
        if (!engine) return null;
        const semantics = engine.semantics;
        if (semantics && semantics._semantics) { return JSON.stringify(semantics._semantics); }
        return null;
      });
      if (objects) { log('🔧 Flutter Engine Inspector extracted semantics.', 'INFO', 'inspector'); return JSON.parse(objects); }
      return null;
    } catch (e: any) { logError('Engine inspector failed', e); return null; }
  }

  async dispatchTapViaEngine(page: any, x: any, y: any) { 
    try {
      const result = await page.evaluate((x: any, y: any) => {
        const engine = window.flutter?.web?.engine;
        if (!engine) return false;
// @ts-expect-error
        const touch = new any({ identifier: 0, target: document, clientX: x, clientY: y });
        const event = new (TouchEvent as any)('touchstart', { touches: [touch], changedTouches: [touch] });
        document.dispatchEvent(event);
        const endEvent = new (TouchEvent as any)('touchend', { touches: [], changedTouches: [touch] });
        document.dispatchEvent(endEvent);
        return true;
      }, x, y);
      return result;
    } catch (e: any) { return false; }
  }
}

module.exports = Object.assign(new FlutterEngineInspector(), { _injectDependencies });