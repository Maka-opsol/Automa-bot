'use strict';

// Lazy logger to avoid top-level circular dependency
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

const FLAG_GROUPS = {
  stability: {
    required: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote'],
    optional: ['--disable-hang-monitor', '--disable-ipc-flooding-protection', '--no-default-browser-check']
  },
  performance: {
    optional: ['--disable-accelerated-2d-canvas', '--disable-gpu', '--disable-extensions', '--disable-infobars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
  },
  compatibility: {
    deprecated: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
    optional: ['--disable-notifications', '--disable-popup-blocking', '--disable-prompt-on-repost', '--metrics-recording-only']
  },
  replit: {
    optional: ['--disable-software-rasterizer', '--disable-canvas-aa', '--disable-3d-builds']
  }
};

const DEPRECATED_FLAGS = new Set(['--enable-features=NetworkService,NetworkServiceInProcess']);

function getChromeFlags(options: any = {}) { 
  const flags = [];
  const warnings = [];
  for (const [group, groupFlags] of Object.entries(FLAG_GROUPS)) {
    if (group === 'replit' && !(options as any).isReplit) continue;
// @ts-expect-error
    if (groupFlags.required) { for (const flag of groupFlags.required) { if (!DEPRECATED_FLAGS.has(flag)) flags.push(flag); } }
    if (groupFlags.optional) { for (const flag of groupFlags.optional) { if (!DEPRECATED_FLAGS.has(flag)) flags.push(flag); } }
// @ts-expect-error
    if (groupFlags.deprecated && options.allowDeprecated !== false) {
// @ts-expect-error
      for (const flag of groupFlags.deprecated) {
        if (!DEPRECATED_FLAGS.has(flag)) { flags.push(flag); warnings.push(`Using deprecated flag: ${flag}`); } else { warnings.push(`Skipped deprecated flag: ${flag}`); }
      }
    }
  }
  // v5-fix: Allow extra Chromium flags via CHROMIUM_FLAGS env var (space-separated).
  // Used on Render free plan to limit Chromium's V8 heap and disable heavy features.
  const extraFlags = process.env.CHROMIUM_FLAGS;
  if (extraFlags) {
    for (const flag of extraFlags.split(/\s+/).filter(Boolean)) {
      flags.push(flag);
    }
    if (options.verbose) { _getLogger().log(`Added ${extraFlags.split(/\s+/).filter(Boolean).length} flags from CHROMIUM_FLAGS env var`, 'INFO', 'chrome-flags'); }
  }
  if (warnings.length > 0 && options.verbose) { for (const warning of warnings) { _getLogger().log(`Using deprecated flag: ${warning}`, 'WARN', 'chrome-flags'); } }
  return flags;
}

function addProxyFlags(flags: any, proxyConfig: any) { 
  if (proxyConfig.http) { flags.push(`--proxy-server=${proxyConfig.http}`); } else if (proxyConfig.https) { flags.push(`--proxy-server=https=${proxyConfig.https}`); }
  return flags;
}

function addWindowSizeFlags(flags: any, width: any, height: any) { 
  flags.push(`--window-size=${width},${height}`);
  return flags;
}

module.exports = { getChromeFlags, addProxyFlags, addWindowSizeFlags, DEPRECATED_FLAGS };
