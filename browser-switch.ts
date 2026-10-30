// ═══════════════════════════════════════════════════════════════════════
// Browser Module Switcher — chooses local browser.ts or remote browser-remote.ts
// ═══════════════════════════════════════════════════════════════════════
//
// This module is a drop-in replacement for `require('./browser')` that
// automatically switches between:
//   - LOCAL mode: uses browser.ts (Chrome runs in-process on Render)
//   - REMOTE mode: uses browser-remote.ts (Chrome runs on Replit via HTTP)
//
// The switch is controlled by the BROWSER_SERVICE_URL environment variable:
//   - If BROWSER_SERVICE_URL is set → REMOTE mode (Replit)
//   - If BROWSER_SERVICE_URL is NOT set → LOCAL mode (Render in-process)
//
// This allows all existing code that does `require('./browser')` to work
// without modification — the switch is transparent.

'use strict';

const _isRemoteMode = !!(process.env.BROWSER_SERVICE_URL);

let _browserModule: any = null;

function _getBrowserModule(): any {
  if (_browserModule) return _browserModule;

  if (_isRemoteMode) {
    // Use remote browser adapter — Chrome runs on Replit
    _browserModule = require('./browser-remote');
    try {
      const logger = require('./logger');
      logger.log(`[BROWSER-SWITCH] Using REMOTE browser mode — BROWSER_SERVICE_URL=${process.env.BROWSER_SERVICE_URL}`, 'INFO', 'browser-switch');
    } catch {
      console.log('[BROWSER-SWITCH] Using REMOTE browser mode');
    }
  } else {
    // Use local browser — Chrome runs in-process on Render
    _browserModule = require('./browser');
    try {
      const logger = require('./logger');
      logger.log('[BROWSER-SWITCH] Using LOCAL browser mode — Chrome runs in-process', 'INFO', 'browser-switch');
    } catch {
      console.log('[BROWSER-SWITCH] Using LOCAL browser mode');
    }
  }

  return _browserModule;
}

// Export a proxy that lazily delegates to the chosen module.
// All property accesses and function calls are forwarded.
module.exports = new Proxy({}, {
  get(_target, prop) {
    const mod = _getBrowserModule();
    const val = mod[prop];
    if (typeof val === 'function') {
      return val.bind(mod);
    }
    return val;
  },
  // Allow `require('./browser')()` pattern if someone calls it directly
  apply(_target, _thisArg, args) {
    const mod = _getBrowserModule();
    if (typeof mod === 'function') return mod(...args);
    return mod;
  },
  // Allow constructor calls
  construct(_target, args) {
    const mod = _getBrowserModule();
    if (typeof mod === 'function') return new mod(...args);
    return mod;
  }
});
