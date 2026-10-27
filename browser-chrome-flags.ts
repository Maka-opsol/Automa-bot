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
    // NOTE: --disable-gpu and --disable-accelerated-2d-canvas are NOT included.
    // This app uses Flutter CanvasKit which requires WebGL to render.
    // --disable-gpu kills WebGL, leaving a permanently blank white canvas.
    // Headless Chromium already uses SwiftShader (software GL) by default,
    // so these flags are unnecessary AND destructive.
    optional: ['--disable-extensions', '--disable-infobars', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']
  },
  compatibility: {
    // These flags are only included when explicitly opted in via allowDeprecated: true.
    // On Render free plan (single known domain), they are unnecessary.
    deprecated: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
    optional: ['--disable-notifications', '--disable-popup-blocking', '--disable-prompt-on-repost', '--metrics-recording-only']
  },
  replit: {
    optional: ['--disable-software-rasterizer', '--disable-canvas-aa', '--disable-3d-builds']
  }
};

// All flags that Chromium has removed or will remove, OR that break critical functionality.
// These are ALWAYS stripped, regardless of allowDeprecated setting.
const DEPRECATED_FLAGS = new Set([
  '--enable-features=NetworkService,NetworkServiceInProcess',
  // The following are also deprecated but were historically in compatibility.deprecated.
  // They are now in DEPRECATED_FLAGS so they get properly filtered.
  '--disable-web-security',
  '--disable-features=IsolateOrigins,site-per-process',
  // v17: --disable-gpu REMOVED from deprecated flags.
  // It was added here to fix blank-canvas on Replit, but on Render free plan
  // (512MB), stripping it lets the GPU subsystem stay active. When CanvasKit
  // re-renders after a click, Chromium RSS spikes 100MB→400MB and the OS
  // OOM killer fires. On memory-constrained instances, --disable-gpu must
  // pass through from CHROMIUM_FLAGS env var.
  // NOTE: --disable-gpu does kill WebGL/CanvasKit rendering. The bot will
  // see blank pages and enter the blank_page recovery loop. On 512MB this
  // is preferable to OOM killing every non-wait action.
]);

// Flags that CHROMIUM_FLAGS env var commonly duplicates from FLAG_GROUPS.
// Used for deduplication — env flags matching these prefixes are skipped
// when the corresponding group is already included.
const COMMON_FLAG_PREFIXES = [
  '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
  '--disable-gpu', '--disable-extensions', '--disable-background-networking',
  '--disable-software-rasterizer', '--no-zygote', '--single-process',
  '--disable-default-apps', '--disable-sync', '--disable-translate',
  '--optimize-for-size', '--js-flags=',
];

/**
 * Check if a flag matches any common prefix (exact match for --flag, or starts-with for --flag=value).
 */
function _matchesCommonPrefix(flag: string): boolean {
  for (const prefix of COMMON_FLAG_PREFIXES) {
    if (prefix.endsWith('=')) {
      // Prefix with = means match --js-flags=*
      if (flag.startsWith(prefix)) return true;
    } else {
      // Exact match
      if (flag === prefix) return true;
    }
  }
  return false;
}

/**
 * Detect if running on Render free plan.
 */
function _isRenderFreePlan(): boolean {
  return !!(process.env.RENDER_SERVICE_ID) &&
    (!process.env.RENDER_SERVICE_TYPE || process.env.RENDER_SERVICE_TYPE === 'free');
}

/**
 * Build the Chrome/Chromium flag array for Playwright launch.
 *
 * @param options.isReplit - Include Replit-specific flags
 * @param options.allowDeprecated - Include deprecated compatibility flags (default: false).
 *        On Render free plan, always false regardless of this option.
 * @param options.verbose - Log flag details
 * @param options.dedupEnvFlags - Deduplicate flags from CHROMIUM_FLAGS env var against
 *        FLAG_GROUPS output (default: true). Prevents ~8 duplicate flags on Render.
 * @returns string[] of Chromium flags
 */
function getChromeFlags(options: any = {}) { 
  const flags: string[] = [];
  const warnings: string[] = [];
  const isRenderFree = _isRenderFreePlan();
  const allowDeprecated = isRenderFree ? false : (options.allowDeprecated === true);
  const dedupEnvFlags = options.dedupEnvFlags !== false;

  // Track which common prefixes have been added from FLAG_GROUPS
  // so we can skip duplicates from CHROMIUM_FLAGS env var.
  const addedPrefixes = new Set<string>();

  for (const [group, groupFlags] of Object.entries(FLAG_GROUPS)) {
    if (group === 'replit' && !options.isReplit) continue;
    if (groupFlags.required) {
      for (const flag of groupFlags.required) {
        if (!DEPRECATED_FLAGS.has(flag)) {
          flags.push(flag);
          addedPrefixes.add(flag);
        }
      }
    }
    if (groupFlags.optional) {
      for (const flag of groupFlags.optional) {
        if (!DEPRECATED_FLAGS.has(flag)) {
          flags.push(flag);
          addedPrefixes.add(flag);
        }
      }
    }
    if (groupFlags.deprecated && allowDeprecated) {
      for (const flag of groupFlags.deprecated) {
        if (!DEPRECATED_FLAGS.has(flag)) {
          flags.push(flag);
          warnings.push(`Using deprecated flag: ${flag}`);
        } else {
          warnings.push(`Skipped deprecated flag: ${flag}`);
        }
      }
    }
  }

  // CHROMIUM_FLAGS env var — with deduplication on Render free plan.
  // On Render, CHROMIUM_FLAGS contains ~12 flags, ~8 of which overlap
  // with FLAG_GROUPS. Deduplication saves ~200 bytes of argv and reduces
  // Chromium stderr noise from duplicate-flag warnings.
  //
  // BUGFIX (2026-10-27): DO NOT filter --disable-gpu. On headless containers
  // (Render free tier), there is NO physical GPU. Chromium NEEDS --disable-gpu
  // to enable SwiftShader (software GPU) for WebGL/CanvasKit rendering.
  // Without --disable-gpu, Chromium tries to init a real GPU, fails, and
  // produces a BLANK canvas → retry loop → memory accumulation → OOM.
  //
  // The previous version of this fix filtered --disable-gpu thinking it caused
  // blank screens. That was WRONG — the blank screens were caused by
  // --disable-features=site-per-process,IsolateOrigins (added to browser.ts,
  // now removed). --disable-gpu was always needed and was never the problem.
  //
  // Only replace the low Chromium V8 heap limit (96MB → 128MB) so Flutter
  // CanvasKit has room to load inside Chromium's V8.
  const extraFlags = process.env.CHROMIUM_FLAGS;
  let envSkipped = 0;
  if (extraFlags) {
    const envFlagList = extraFlags.split(/\s+/).filter(Boolean);
    for (const flag of envFlagList) {
      if (dedupEnvFlags && _matchesCommonPrefix(flag) && addedPrefixes.has(flag)) {
        envSkipped++;
        continue;
      }
      // Also skip env flags that are in DEPRECATED_FLAGS
      if (DEPRECATED_FLAGS.has(flag)) {
        envSkipped++;
        continue;
      }
      // Replace low Chromium V8 limit (96MB) with higher one (128MB)
      if (flag.startsWith('--js-flags=--max-old-space-size=')) {
        const replacement = '--js-flags=--max-old-space-size=128';
        if (flag !== replacement) {
          flags.push(replacement);
          continue;
        }
      }
      flags.push(flag);
    }
  }

  if (options.verbose) {
    const logFn = _getLogger().log;
    logFn(`Chrome flags: ${flags.length} total (${envSkipped} env duplicates skipped, deprecated=${allowDeprecated})`, 'INFO', 'chrome-flags');
    if (warnings.length > 0) {
      for (const warning of warnings) {
        logFn(warning, 'WARN', 'chrome-flags');
      }
    }
    if (isRenderFree) {
      logFn('Render free plan detected: deprecated flags disabled, env flag dedup enabled', 'DEBUG', 'chrome-flags');
    }
  }

  return flags;
}

function addProxyFlags(flags: string[], proxyConfig: any): string[] { 
  if (proxyConfig.http) { flags.push(`--proxy-server=${proxyConfig.http}`); } else if (proxyConfig.https) { flags.push(`--proxy-server=https=${proxyConfig.https}`); }
  return flags;
}

function addWindowSizeFlags(flags: string[], width: any, height: any): string[] { 
  // BUG FIX (2026-09-08): Validate width/height — if either is undefined,
  // null, NaN, or <= 0, fall back to safe defaults (1280×800).
  // Without this, when `_deps.config` is momentarily empty (during cold start
  // or after a self-heal rollback), Chromium receives `--window-size=undefined,undefined`
  // which causes "Malformed window size" error and the browser launch fails
  // with "Target page, context or browser has been closed".
  const _w = Number(width);
  const _h = Number(height);
  const safeW = (Number.isFinite(_w) && _w > 0) ? _w : 1280;
  const safeH = (Number.isFinite(_h) && _h > 0) ? _h : 800;
  flags.push(`--window-size=${safeW},${safeH}`);
  return flags;
}

module.exports = { getChromeFlags, addProxyFlags, addWindowSizeFlags, DEPRECATED_FLAGS };
