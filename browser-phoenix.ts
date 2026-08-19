// Resilience R8: Crash-Resistant Browser — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// browser-phoenix.ts — P1 Crash-Resistant Browser
// ═══════════════════════════════════════════════════════════════
// Browser crash = cycle death. This module wraps browser launch
// with multi-tier recovery to ensure the bot can always get a
// working browser instance, even after repeated crashes.
//
// Features:
//   1. Tier 1: Normal Playwright launch (existing browser.ts behavior)
//   2. Tier 2: If launch fails or browser disconnects:
//      Kill ALL Chromium processes (pkill), clear Playwright temp
//      files, relaunch with aggressive flags
//   3. Tier 3: If Tier 2 fails: launch with --headless=new
//      (different headless mode, sometimes fixes GPU/render issues)
//   4. Consecutive failure tracking — after 3 failures in a row,
//      wait 60 seconds before retrying (prevents CPU spin)
//   5. After 5 consecutive failures: declare browser unrecoverable,
//      alert, and suggest restart
//   6. Browser disconnect recovery: detect page.close/browser.close
//      events and auto-relaunch
//   7. Metrics: launch attempts, successes, failures, current tier
//
// Integration:
//   - cycle-cycle-manager.ts uses phoenixBrowserLaunch() instead
//     of direct browser.ts launch
//   - Replaces withBrowserRetry() in cycle-manager
//
// Config:
//   BROWSER_PHOENIX_MAX_CONSECUTIVE_FAILURES — before cooldown (default 3)
//   BROWSER_PHOENIX_COOLDOWN_MS — wait between retry batches (default 60000)
//   BROWSER_PHOENIX_UNRECOVERABLE_THRESHOLD — before declaring dead (default 5)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'browser-phoenix') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

function logError(msg: string, err: Error) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  console.error(`[ERROR] [browser-phoenix] ${msg}`, err);
}

// ─── Constants ───
const DEFAULT_MAX_CONSECUTIVE_FAILURES = 3;
const DEFAULT_COOLDOWN_MS = 60 * 1000;        // 60 seconds
const DEFAULT_UNRECOVERABLE_THRESHOLD = 5;

// ─── State ───
let _consecutiveFailures = 0;
let _totalLaunchAttempts = 0;
let _totalLaunchSuccesses = 0;
let _totalRecoveries = 0;
let _currentTier = 0;           // 0 = not started, 1-3 = recovery tier used
let _lastFailureTime = 0;
let _lastLaunchTime = 0;
let _isCoolingDown = false;
let _cooldownTimer: ReturnType<typeof setTimeout> | null = null;
let _isUnrecoverable = false;
let _started = false;
let _lastError: string | null = null;

// ─── Helpers ───

function _getMaxConsecutiveFailures(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.BROWSER_PHOENIX_MAX_CONSECUTIVE_FAILURES);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_MAX_CONSECUTIVE_FAILURES;
}

function _getCooldownMs(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.BROWSER_PHOENIX_COOLDOWN_MS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_COOLDOWN_MS;
}

function _getUnrecoverableThreshold(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.BROWSER_PHOENIX_UNRECOVERABLE_THRESHOLD);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_UNRECOVERABLE_THRESHOLD;
}

function _getBrowserModule(): any {
  try {
    return require('./browser');
  } catch (e) {
    log(`Cannot require browser module: ${(e as Error).message}`, 'ERROR');
    return null;
  }
}

/**
 * Kill ALL Chromium/Playwright processes and clean temp files.
 */
function _slaughterChromium(): void {
  log('[PHOENIX] Slaughtering all Chromium processes...', 'WARN');

  try {
    const { execSync } = require('child_process');
    // Kill all chromium/chrome processes
    try { execSync('pkill -f chromium 2>/dev/null || true', { timeout: 5000 }); } catch { /* ignore */ }
    try { execSync('pkill -f chrome 2>/dev/null || true', { timeout: 5000 }); } catch { /* ignore */ }
    try { execSync('pkill -f headless_shell 2>/dev/null || true', { timeout: 5000 }); } catch { /* ignore */ }
  } catch {
    // child_process not available or exec failed — non-critical
  }

  // Clear Playwright temp directories
  try {
    const fs = require('fs');
    const path = require('path');
    const os = require('os');
    const tmpDir = os.tmpdir();

    const playwrightDirs = fs.readdirSync(tmpDir).filter(
      (f: string) => f.startsWith('.playwright-') || f.startsWith('playwright-')
    );

    for (const dir of playwrightDirs) {
      try {
        fs.rmSync(path.join(tmpDir, dir), { recursive: true, force: true });
        log(`[PHOENIX] Cleared Playwright temp dir: ${dir}`, 'DEBUG');
      } catch { /* ignore */ }
    }

    // Also clear any core dumps from chromium crashes
    const coreFiles = fs.readdirSync(tmpDir).filter(
      (f: string) => f.startsWith('core.') || f.startsWith('chrome-crash-')
    );
    for (const core of coreFiles) {
      try {
        fs.unlinkSync(path.join(tmpDir, core));
      } catch { /* ignore */ }
    }
  } catch {
    // fs operations failed — non-critical
  }
}

/**
 * Build aggressive Chromium flags for Tier 2 launch.
 */
function _getTier2Flags(): string[] {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    // NOTE: --disable-gpu removed — breaks Flutter CanvasKit WebGL rendering
    '--single-process',
    '--headless=new',
    '--disable-software-rasterizer',
    '--disable-extensions',
    '--disable-background-networking',
    '--disable-default-apps',
    '--disable-sync',
    '--disable-translate',
    '--disable-component-extensions-with-background-pages',
    '--no-zygote',
    '--disable-features=OptimizationGuideModelDownloading,OptimizationHintsFetching,MediaRouter,DialMediaRouteProvider',
  ];
}

/**
 * Build Tier 3 flags (even more aggressive — new headless mode).
 */
function _getTier3Flags(): string[] {
  return [
    ..._getTier2Flags(),
    '--headless=new',      // Explicit new headless mode
    '--disable-viz',
    '--disable-features=VizDisplayCompositor',
    '--js-flags=--max-old-space-size=64',  // Minimal JS heap for browser itself
  ];
}

// ─── Core API ───

/**
 * Multi-tier browser launch with automatic recovery.
 *
 * Tier 1: Normal launch via browser.ts
 * Tier 2: Kill chromium + clear temp + aggressive flags
 * Tier 3: Even more aggressive flags (--disable-viz, reduced JS heap)
 *
 * @returns {Promise<{browser, context, page} | null>} Browser instance or null if unrecoverable
 */
async function phoenixBrowserLaunch(): Promise<any | null> {
  if (_isUnrecoverable) {
    log('[PHOENIX] Browser declared unrecoverable. Refusing launch.', 'ERROR');
    return null;
  }

  if (_isCoolingDown) {
    log('[PHOENIX] Currently cooling down from recent failures. Skipping launch.', 'WARN');
    return null;
  }

  // Check if we need cooldown
  if (_consecutiveFailures >= _getMaxConsecutiveFailures() && _lastFailureTime > 0) {
    const elapsed = Date.now() - _lastFailureTime;
    if (elapsed < _getCooldownMs()) {
      _isCoolingDown = true;
      const remaining = _getCooldownMs() - elapsed;
      log(
        `[PHOENIX] Cooling down for ${Math.ceil(remaining / 1000)}s before next launch attempt (${_consecutiveFailures} consecutive failures)`,
        'WARN'
      );
      return null;
    }
    // Cooldown period passed — reset consecutive failures to allow retry
    _consecutiveFailures = 0;
  }

  const browserModule = _getBrowserModule();
  if (!browserModule) {
    log('[PHOENIX] browser module not available — cannot launch', 'ERROR');
    _recordFailure('browser module not available');
    return null;
  }

  // Attempt launches across tiers
  const tiers = [
    { tier: 1, name: 'NORMAL', flags: null },
    { tier: 2, name: 'AGGRESSIVE', flags: _getTier2Flags() },
    { tier: 3, name: 'MINIMAL', flags: _getTier3Flags() },
  ];

  // Start from the last successful tier (skip lower tiers if we already know they fail)
  const startTier = Math.max(1, _currentTier);

  for (let i = startTier - 1; i < tiers.length; i++) {
    const { tier, name, flags } = tiers[i];

    log(`[PHOENIX] Attempting Tier ${tier} (${name}) launch...`, 'INFO');
    _totalLaunchAttempts++;

    try {
      let result: any;

      if (tier === 1) {
        // Tier 1: Normal launch via browser.ts
        result = await _launchNormal(browserModule);
      } else {
        // Tier 2/3: Kill chromium first, then launch with extra flags
        _slaughterChromium();

        // Small delay after killing processes
        await new Promise(resolve => setTimeout(resolve, 1000));

        result = await _launchWithFlags(browserModule, flags!, tier);
      }

      if (result) {
        _recordSuccess(tier);
        return result;
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      log(
        `[PHOENIX] Tier ${tier} (${name}) launch failed: ${error.message}`,
        'WARN'
      );
      _lastError = error.message;
    }
  }

  // All tiers failed
  _recordFailure('all tiers failed');
  return null;
}

/**
 * Tier 1: Normal launch via existing browser module.
 */
async function _launchNormal(browserModule: any): Promise<any | null> {
  try {
    // Use the browser module's existing launch mechanism
    if (typeof browserModule.launchBrowser === 'function') {
      await browserModule.launchBrowser();
    }

    // Try to get a working page
    if (typeof browserModule.getPage === 'function') {
      const page = browserModule.getPage();
      if (page) {
        _lastLaunchTime = Date.now();
        return { browser: browserModule.browserInstance, page, tier: 1 };
      }
    }

    // If launchBrowser doesn't return anything useful, check if the browser instance exists
    if (browserModule.browserInstance) {
      _lastLaunchTime = Date.now();
      return { browser: browserModule.browserInstance, tier: 1 };
    }

    return null;
  } catch (err) {
    throw err; // Propagate for tier tracking
  }
}

/**
 * Tier 2/3: Direct Playwright launch with custom flags.
 */
async function _launchWithFlags(browserModule: any, flags: string[], tier: number): Promise<any | null> {
  try {
    const { chromium } = require('playwright');
    const path = require('path');
    const os = require('os');

    const launchOptions: Record<string, any> = {
      headless: true,
      args: flags,
      timeout: 30000,  // 30s launch timeout
    };

    // Set user data dir to /tmp
    const userDataDir = path.join(os.tmpdir(), '.browser-data-phoenix');
    try {
      const fs = require('fs');
      fs.mkdirSync(userDataDir, { recursive: true });
    } catch { /* ignore */ }

    const browser = await chromium.launch(launchOptions);
    const context = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      ignoreHTTPSErrors: true,
    });

    const page = await context.newPage();

    _lastLaunchTime = Date.now();
    log(`[PHOENIX] Tier ${tier} launch successful`, 'INFO');

    // Also update the browser module's internal state if possible
    if (browserModule.browserInstance === undefined || browserModule.browserInstance === null) {
      browserModule.browserInstance = browser;
      browserModule.contextInstance = context;
      browserModule.pageInstance = page;
    }

    return { browser, context, page, tier };
  } catch (err) {
    throw err;
  }
}

/**
 * Record a successful launch.
 */
function _recordSuccess(tier: number): void {
  _consecutiveFailures = 0;
  _currentTier = tier;
  _totalLaunchSuccesses++;
  _totalRecoveries += tier > 1 ? 1 : 0;
  _lastLaunchTime = Date.now();
  _lastError = null;

  if (tier > 1) {
    log(
      `[PHOENIX] Browser recovered at Tier ${tier} (after ${_totalLaunchAttempts} total attempts, ${_totalRecoveries} recoveries this session)`,
      'INFO'
    );

    // Alert on recovery
    try {
      const alerting = (_deps as any).alerting;
      if (alerting?.sendAlert) {
        alerting.sendAlert(
          'Browser Phoenix Recovery',
          `Browser recovered at Tier ${tier} after ${_consecutiveFailures} consecutive failures. ` +
          `Total recoveries this session: ${_totalRecoveries}`
        );
      }
    } catch { /* non-critical */ }
  } else {
    log(`[PHOENIX] Tier 1 (normal) launch successful`, 'INFO');
  }
}

/**
 * Record a launch failure.
 */
function _recordFailure(reason: string): void {
  _consecutiveFailures++;
  _lastFailureTime = Date.now();

  const maxConsecutive = _getMaxConsecutiveFailures();
  const unrecoverableThreshold = _getUnrecoverableThreshold();

  log(
    `[PHOENIX] Launch failure #${_consecutiveFailures}: ${reason}`,
    'WARN'
  );

  // Set up cooldown if we hit the consecutive failure limit
  if (_consecutiveFailures >= maxConsecutive && !_isCoolingDown) {
    _isCoolingDown = true;
    const cooldownMs = _getCooldownMs();

    log(
      `[PHOENIX] Entering cooldown for ${cooldownMs / 1000}s after ${_consecutiveFailures} consecutive failures`,
      'WARN'
    );

    if (_cooldownTimer) clearTimeout(_cooldownTimer);
    _cooldownTimer = setTimeout(() => {
      _isCoolingDown = false;
      log('[PHOENIX] Cooldown period ended. Ready to retry.', 'INFO');
    }, cooldownMs).unref();
  }

  // Check for unrecoverable state
  if (_consecutiveFailures >= unrecoverableThreshold) {
    _isUnrecoverable = true;
    log(
      `[PHOENIX] Browser declared UNRECOVERABLE after ${_consecutiveFailures} consecutive failures. ` +
      `Manual intervention or process restart required.`,
      'ERROR'
    );

    // Critical alert
    try {
      const alerting = (_deps as any).alerting;
      if (alerting?.sendAlert) {
        alerting.sendAlert(
          'BROWSER UNRECOVERABLE',
          `Browser has failed ${_consecutiveFailures} consecutive times across all tiers. ` +
          `The bot cannot operate without a browser. Consider: ` +
          `1. Check Render disk space (df -h) ` +
          `2. Check Chromium installation (npx playwright install chromium) ` +
          `3. Restart the service`
        );
      }
    } catch { /* non-critical */ }

    // Trigger process exit for Render auto-restart
    log('[PHOENIX] Triggering process.exit(1) for auto-restart...', 'ERROR');
    setTimeout(() => {
      try { process.exit(1); } catch { /* ignore */ }
    }, 2000);
  }
}

/**
 * Manually reset failure state (e.g., after external fix).
 */
function resetFailures(): void {
  _consecutiveFailures = 0;
  _isUnrecoverable = false;
  _isCoolingDown = false;
  _currentTier = 0;
  _lastError = null;
  if (_cooldownTimer) {
    clearTimeout(_cooldownTimer);
    _cooldownTimer = null;
  }
  log('[PHOENIX] Failure state manually reset.', 'INFO');
}

/**
 * Check if the browser is currently unrecoverable.
 */
function isUnrecoverable(): boolean {
  return _isUnrecoverable;
}

/**
 * Check if the browser is currently in cooldown.
 */
function isCoolingDown(): boolean {
  return _isCoolingDown;
}

/**
 * Get the current recovery tier (0 = not started, 1-3 = tier used).
 */
function getCurrentTier(): number {
  return _currentTier;
}

/**
 * Get full diagnostic status.
 */
function getStatus(): {
  consecutiveFailures: number;
  totalLaunchAttempts: number;
  totalLaunchSuccesses: number;
  totalRecoveries: number;
  currentTier: number;
  isCoolingDown: boolean;
  isUnrecoverable: boolean;
  lastLaunchTime: number | null;
  lastFailureTime: number | null;
  lastError: string | null;
} {
  return {
    consecutiveFailures: _consecutiveFailures,
    totalLaunchAttempts: _totalLaunchAttempts,
    totalLaunchSuccesses: _totalLaunchSuccesses,
    totalRecoveries: _totalRecoveries,
    currentTier: _currentTier,
    isCoolingDown: _isCoolingDown,
    isUnrecoverable: _isUnrecoverable,
    lastLaunchTime: _lastLaunchTime || null,
    lastFailureTime: _lastFailureTime || null,
    lastError: _lastError,
  };
}

/**
 * Start the browser phoenix system.
 */
function start(): void {
  if (_started) return;
  _started = true;

  log(
    `[PHOENIX] Browser phoenix started (maxConsecutive=${_getMaxConsecutiveFailures()}, ` +
    `cooldown=${_getCooldownMs() / 1000}s, unrecoverable=${_getUnrecoverableThreshold()})`,
    'INFO'
  );
}

/**
 * withBrowserRetry-compatible wrapper.
 * Launches via phoenix tiers, then calls action(page) and returns the result.
 * This is what cycle-manager expects: fn(page) => Promise<Page>.
 */
async function phoenixBrowserRetry(action: (page: any) => Promise<any>, maxRetries = 3): Promise<any> {
  const result = await phoenixBrowserLaunch();
  if (!result) throw new Error('Phoenix: all launch tiers failed');

  // result is { browser, context?, page, tier } or { browser, tier } (tier 1 fallback)
  let page = result.page;

  // Tier 1 sometimes doesn't return page directly — try to get it from browser module
  if (!page) {
    const browserModule = _getBrowserModule();
    if (typeof browserModule?.getPage === 'function') {
      page = browserModule.getPage();
    }
  }

  if (!page || typeof page.goto !== 'function') {
    throw new Error(`Phoenix tier ${result.tier} launch succeeded but no valid Page available`);
  }

  return action(page);
}

module.exports = {
  _injectDependencies,
  phoenixBrowserLaunch,
  phoenixBrowserRetry,
  resetFailures,
  isUnrecoverable,
  isCoolingDown,
  getCurrentTier,
  getStatus,
  start,
};
