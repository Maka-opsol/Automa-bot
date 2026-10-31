'use strict';

import type { Deps } from './types/di-types';

// ─── npm packages + Node builtins only at top level ───
const { chromium } = require('playwright');
// TASK 131 (2026-10-28): sharp made LAZY to save ~30-50MB during boot.
// Browser.ts is required by container.get('orchestrator') → cycleManager → 'browser' dep.
// Loading sharp eagerly was contributing to the boot OOM crash loop.
let _sharp: any = null;
let _sharpLoaded = false;
function _getSharp(): any {
  if (_sharpLoaded) return _sharp;
  _sharpLoaded = true;
  try { _sharp = require('sharp'); } catch (e: any) { _sharp = null; }
  return _sharp;
}
const crypto = require('crypto');

// Utility modules — these have minimal/no project deps and will be
// converted to full DI in later phases. Kept as direct requires for now.
const { getRealisticBrowserContext } = require('./utils-user-agent');
const { getChromeFlags, addProxyFlags, addWindowSizeFlags } = require('./browser-chrome-flags');

// v5-fix H3: Lazy-load metrics to avoid requiring it before DI injection.
// Previously this was a top-level require('./metrics') which triggered metrics
// module evaluation before the DI container had called _injectDependencies().
let _metricsRecordClickDuration: ((ms: any, style: any) => void) | null = null;
function getRecordClickDuration() {
  if (!_metricsRecordClickDuration) {
    try {
      const metrics = require('./metrics');
      _metricsRecordClickDuration = metrics.recordClickDuration;
    } catch {
      _metricsRecordClickDuration = () => {};
    }
  }
  return _metricsRecordClickDuration;
}

// ─── Dependency Injection ───
let _deps: Deps = {};

function _injectDependencies(deps: Deps) {
  _deps = deps;
}

// ─── Lazy accessors with fallbacks ───
function getCONFIG(): any { return _deps.config || {}; }
function getLog(): (msg: string, level?: string, _module?: string) => void {
  return _deps.logger?.log || console.log;
}
function getLogError(): (msg: string, err: Error, ctx?: any) => void {
  return _deps.logger?.logError || ((msg: string, err: Error) => console.error(msg, err));
}
function getLoadSession(): (data?: any) => any {
  return _deps.cache?.loadSession || (() => null);
}
function getSaveSession(): (data: any) => void {
  return _deps.cache?.saveSession || (() => {});
}
function getSelectCalibration(): any {
  return _deps.database?.selectCalibration;
}

const browserMetrics = {
  launchAttempts: 0,
  launchSuccesses: 0,
  launchFailures: 0,
  disconnections: 0,
  crashes: 0,
  lastLaunchTime: null,
  lastDisconnectionTime: null,
  totalPages: 0,
  currentMemoryUsage: 0
};

class BrowserManager {
  browserInstance: any;
  executablePath: any;

  contextInstance: any;
  pageInstance: any;
  cdpSession: any;
  browserDisconnected: boolean;
  browserLaunchCount: number;
  scaleFactor: number;
  viewportWidth: number;
  viewportHeight: number;
  isMac: boolean;
  MOD_KEY: string;
  launching: boolean;
  dprScale: number;
  telemetryGAN: any;
  _shutdownInitiated: boolean;
  _healthCheckInterval: any;
  _memoryMonitorInterval: any;
  _disconnectedListeners: Array<(data?: any) => void>;
  _intentionalClose: boolean;
  _fpFonts: string[] | null;
  _traceFile: string | null;  // TIER 1: Playwright trace file path
  _configInitialized: boolean;

  constructor() {
    this.browserInstance = null;
    this.contextInstance = null;
    this.pageInstance = null;
    this.cdpSession = null;
    this.browserDisconnected = false;
    this.browserLaunchCount = 0;
    this.scaleFactor = 1.0;
    this.viewportWidth = 1280;
    this.viewportHeight = 720;
    this.isMac = process.platform === 'darwin';
    this.MOD_KEY = this.isMac ? 'Meta' : 'Control';
    this.launching = false;
    this.dprScale = 1.0;
    this.telemetryGAN = null;
    this._shutdownInitiated = false;
    this._healthCheckInterval = null;
    this._memoryMonitorInterval = null;
    this._disconnectedListeners = [];
    this._intentionalClose = false;
    this._fpFonts = null;
    this._traceFile = null;  // TIER 1: trace file initialized
    this._configInitialized = false;
  }

  /** Lazy-init CONFIG-dependent fields on first access */
  _ensureConfig() {
    if (this._configInitialized) return;
    const CONFIG = getCONFIG();
    this.viewportWidth = CONFIG.DISPLAY_WIDTH || 1280;
    this.viewportHeight = CONFIG.DISPLAY_HEIGHT || 720;
    if (CONFIG.ENABLE_GAN_TELEMETRY) { this._initGANTelemetry(); }
    this._configInitialized = true;
  }

  // ─── Humanization helpers ───

  static _gaussianRandom(mean = 0, stdev = 1) {
    const u = 1 - Math.random();
    const v = Math.random();
    const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
    return z * stdev + mean;
  }

  async _humanDelay(baseMs = 100, jitterMs = 80) {
    const delay = Math.max(20, baseMs + BrowserManager._gaussianRandom(0, jitterMs));
    await new Promise(r => setTimeout(r, delay));
  }

  on(event: string, listener: (data?: any) => void) { 
    if (event === 'disconnected') {
      // v6-fix: Cap listener count to prevent unbounded growth over thousands
      // of browser launches (~11k/year). Only one listener is needed anyway.
      if (this._disconnectedListeners.length > 5) {
        this._disconnectedListeners = this._disconnectedListeners.slice(-1);
      }
      this._disconnectedListeners.push(listener);
    }
  }

  emit(event: string, data?: any) { 
    const log = getLog();
    if (event === 'disconnected') this._disconnectedListeners.forEach(fn => { try { fn(data); } catch (e: any) {} });
    if (event === 'crashed') { log('Page crash event emitted', 'ERROR', 'browser'); this.browserDisconnected = true; }
  }

  _initGANTelemetry() { 
    const log = getLog();
    try { this.telemetryGAN = require('./telemetry-gan'); this.telemetryGAN.init().catch((e: Error) => log(`GAN init failed: ${e.message}`, 'WARN', 'browser')); } catch (e: any) { log(`GAN module not loaded: ${e.message}`, 'WARN', 'browser'); this.telemetryGAN = null; }
  }

  getBrowserDisconnected() {  return this.browserDisconnected; }
  resetBrowserDisconnected() {  this.browserDisconnected = false; }
  getBrowserLaunchCount() {  return this.browserLaunchCount; }
  resetBrowserLaunchCount() {  this.browserLaunchCount = 0; }
  getScaleFactor() {  return this.scaleFactor; }
  getViewportDimensions() {  return { width: this.viewportWidth, height: this.viewportHeight }; }
  getPage() {  return this.pageInstance; }
  getDprScale() {  return this.dprScale; }
  setDprScale(scale: number) {  this.dprScale = scale; }
  getMetrics() {  return { ...browserMetrics }; }

  async launch() {
    this._ensureConfig();
    const log = getLog();
    if (this.launching) {
      log('Browser launch already in progress, waiting...', 'DEBUG', 'browser');
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { clearInterval(interval); reject(new Error('Browser launch timeout while waiting')); }, getCONFIG().BROWSER_LAUNCH_EXTENDED_TIMEOUT_MS || 120000);
        const interval = setInterval(() => {
          if (!this.launching) {
            clearTimeout(timeout);
            clearInterval(interval);
            if (this.pageInstance) { resolve(this.pageInstance); } else { reject(new Error('Browser launch failed')); }
          }
        }, 100);
      });
    }
    // TASK 123 (2026-10-22): REUSE EXISTING BROWSER IF ALIVE.
    // The cycle manager calls launch() at the start of every cycle, but
    // Task 87 says "protect browser at all costs — keep browser open
    // between cycles." The old code always called cleanup() which killed
    // the existing browser, defeating the purpose of keeping it open.
    // Now we check if the browser is still connected and the page is valid
    // — if so, return the existing page WITHOUT relaunching.
    try {
      if (this.browserInstance && this.browserInstance.isConnected() && this.pageInstance) {
        // Verify the page is still functional (not closed/disconnected)
        const pageUrl = this.pageInstance.url();
        if (pageUrl && !pageUrl.includes('chrome-error')) {
          log(`Reusing existing browser (page at ${pageUrl.substring(0, 60)}) — skipping relaunch (Task 87: protect browser)`, 'DEBUG', 'browser');
          return this.pageInstance;
        }
      }
    } catch (e: any) {
      log(`Reuse check failed: ${e.message} — proceeding with fresh launch`, 'DEBUG', 'browser');
    }
    this.launching = true;
    this._intentionalClose = false;
    this.browserDisconnected = false;
    const launchAttempt = this.browserLaunchCount + 1;
    log(`Launching browser (attempt ${launchAttempt})...`, 'INFO', 'browser');
    await this.cleanup();
    const launchStrategies = [
      this.getFullLaunchOptions.bind(this),
      this.getReducedLaunchOptions.bind(this),
      this.getMinimalLaunchOptions.bind(this),
    ];
    let lastError: Error | null = null;
    for (let strategyIndex = 0; strategyIndex < launchStrategies.length; strategyIndex++) {
      const strategyName = ['full', 'reduced', 'minimal'][strategyIndex];
      log(`Trying ${strategyName} launch strategy...`, 'DEBUG', 'browser');
      try {
        const options = launchStrategies[strategyIndex]();
        this.browserInstance = await Promise.race([
          chromium.launch(options),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Browser launch timeout')), options.timeout || getCONFIG().BROWSER_LAUNCH_TIMEOUT_MS || 60000))
        ]);
        this.browserLaunchCount++;
        this.browserDisconnected = false;
        this.setupBrowserHandlers();
        await this.setupContext();
        await this.configurePage();
        log(`Browser launched successfully with ${strategyName} strategy`, 'INFO', 'browser');
        this.launching = false;
        return this.pageInstance;
      } catch (err: any) {
        lastError = err as Error;
        log(`Launch strategy ${strategyName} failed: ${(err as Error).message}`, 'WARN', 'browser');
        await this.cleanup();
      }
    }
    this.launching = false;
    const errorMsg = `All browser launch strategies failed. Last error: ${lastError?.message}`;
    log(errorMsg, 'ERROR', 'browser');
    throw new Error(errorMsg);
  }

  getFullLaunchOptions() { 
    const CONFIG = getCONFIG();
    let flags = getChromeFlags({ isReplit: CONFIG.REPLIT_VM, verbose: true });
    // BUG FIX (2026-09-07): Force HTTP/1.1 to avoid proxy HTTP/2 incompatibility.
    // Some proxies can't handle multiplexed HTTP/2 traffic, causing silent drops.
    flags.push('--disable-http2');
    // BUG FIX (2026-09-08): Provide explicit fallbacks for DISPLAY_WIDTH/HEIGHT
    // at the call site (defense-in-depth — addWindowSizeFlags also validates,
    // but if browser-chrome-flags.ts is an older version, this protects us).
    const _w = Number(CONFIG.DISPLAY_WIDTH) || 1280;
    const _h = Number(CONFIG.DISPLAY_HEIGHT) || 800;
    addWindowSizeFlags(flags, _w, _h);
    // BUG FIX (2026-09-08): headless MUST default to true.
    // The old code `!!getCONFIG().HEADLESS` evaluates to `false` when CONFIG is
    // empty (during cold start or after self-heal rollback), which causes
    // Playwright to launch a HEADED browser. On a headless server (no X server),
    // this fails with "Missing X server or $DISPLAY" + "The platform failed to
    // initialize. Exiting." — the bot then cascades to reduced/minimal strategies
    // unnecessarily. Default to headless: true unless explicitly disabled.
    //
    // TASK 143 (2026-10-29): Use headless=true (headless-shell) with --enable-unsafe-swiftshader.
    // Previous attempt used headless=false + --headless=new, but the full Chromium
    // binary is NOT installed by Playwright (only chrome-headless-shell is).
    // headless=false causes "browser failed to initialize" because there's no
    // full chromium binary at /opt/pw-browsers/.
    //
    // Instead: headless-shell DOES support WebGL via SwiftShader if you pass
    // --enable-unsafe-swiftshader flag. This was added in Playwright/Chrome 1248.
    // The flag is already in Playwright's default flags (we see it in the launch
    // log: --enable-unsafe-swiftshader). The issue was that headless-shell was
    // crashing because Xvfb wasn't providing DISPLAY. Now that we have
    // DISPLAY=:99 set in the Dockerfile CMD, headless-shell should be able to
    // initialize SwiftShader WebGL via the X display.
    const _forceHeaded = !!(globalThis as any).__forceHeaded;
    const _headless = _forceHeaded ? false : true;
    // Ensure --enable-unsafe-swiftshader is in flags (it usually is by default,
    // but make sure it's there for CanvasKit WebGL support)
    if (!flags.includes('--enable-unsafe-swiftshader')) {
      flags.push('--enable-unsafe-swiftshader');
    }
    const options: any = { headless: _headless, args: flags, timeout: getCONFIG().BROWSER_LAUNCH_TIMEOUT_MS || 60000 };
    // BUG FIX (2026-09-08): Only set per-context proxy mode when a proxy is
    // actually active. When `__proxyDisabled` is true, DON'T pass
    // `proxy: { server: 'per-context' }` — otherwise Chromium receives the
    // `--proxy-server=http://per-context` flag, which it interprets as a
    // literal proxy URL (host="per-context", port=80). When a context is
    // created without a proxy override, Chromium tries to connect to this
    // bogus proxy → ERR_PROXY_CONNECTION_FAILED. This was causing the bot
    // to fail even after the proxy was disabled.
    if (!(globalThis as any).__proxyDisabled) {
      options.proxy = { server: 'per-context' };
    }
    if (CONFIG.CHROMIUM_EXECUTABLE_PATH) { options.executablePath = CONFIG.CHROMIUM_EXECUTABLE_PATH; }
    return options;
  }

  getReducedLaunchOptions() { 
    const CONFIG = getCONFIG();
    // BUG FIX (2026-09-08): Provide explicit fallbacks for DISPLAY_WIDTH/HEIGHT.
    // During cold start or after a self-heal rollback, `_deps.config` may be
    // momentarily empty (DI container not yet re-initialized), causing
    // `CONFIG.DISPLAY_WIDTH` to be `undefined` and producing the malformed
    // Chromium flag `--window-size=undefined,undefined` which causes the
    // browser launch to fail with "Target page, context or browser has been closed".
    const _w = Number(CONFIG.DISPLAY_WIDTH) || 1280;
    const _h = Number(CONFIG.DISPLAY_HEIGHT) || 800;
    const flags = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', '--disable-http2', `--window-size=${_w},${_h}`];
    const options: any = { headless: true, args: flags, timeout: getCONFIG().BROWSER_LAUNCH_TIMEOUT_MS || 45000 };
    // BUG FIX (2026-09-08): Only set per-context proxy when proxy is active.
    if (!(globalThis as any).__proxyDisabled) {
      options.proxy = { server: 'per-context' };
    }
    if (CONFIG.CHROMIUM_EXECUTABLE_PATH) { options.executablePath = CONFIG.CHROMIUM_EXECUTABLE_PATH; }
    return options;
  }

  getMinimalLaunchOptions() { 
    const CONFIG = getCONFIG();
    const options: any = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process', '--disable-http2'], timeout: getCONFIG().BROWSER_LAUNCH_TIMEOUT_MS || 30000 };
    // BUG FIX (2026-09-08): Only set per-context proxy when proxy is active.
    if (!(globalThis as any).__proxyDisabled) {
      options.proxy = { server: 'per-context' };
    }
    if (CONFIG.CHROMIUM_EXECUTABLE_PATH) { options.executablePath = CONFIG.CHROMIUM_EXECUTABLE_PATH; }
    return options;
  }

  setupBrowserHandlers() { 
    const log = getLog();
    const logError = getLogError();
    if (!this.browserInstance) return;
    this.browserInstance.on('disconnected', () => { if (!this._intentionalClose && !this.launching) { log('Browser process disconnected unexpectedly', 'ERROR', 'browser'); } this.browserDisconnected = true; this.emit('disconnected'); });
    this.browserInstance.on('error', (err: Error) => { logError('Browser process error', err); this.browserDisconnected = true; });
  }

  async setupContext() {
    const log = getLog();
    const logError = getLogError();
    if (!this.browserInstance) throw new Error('Browser instance not available');
    const loadSession = getLoadSession();
    const sessionData = loadSession();
    const contextOptions: any = await getRealisticBrowserContext();
    if (sessionData) { contextOptions.storageState = sessionData; }
    // BUG FIX (2026-09-07): Pass proxy at the context level, not the launch level.
    // Also implement auto-disable: if the browser has had proxy issues (chrome-error,
    // repeated blank pages, navigation timeouts), disable the proxy for this context
    // to allow the bot to continue working without the proxy.
    //
    // BUG FIX (2026-09-08): Before assigning a proxy, validate it against
    // app.mathu.co.za. If validation fails, try rotating to a new validated
    // proxy. If all proxies fail, fall back to direct connection. This prevents
    // the bot from wasting 30s navigation timeouts on a dead peer.
    try {
      const ipRotator = require('./network-ip-rotator');

      // If proxies were disabled by a previous error path (chrome-error,
      // blank-page escalation), honor that decision and use direct.
      const _proxyDisabled = (globalThis as any).__proxyDisabled || false;

      let proxyMode: 'current' | 'rotated' | 'bypassed' | 'direct' = 'direct';
      if (!_proxyDisabled && typeof ipRotator.ensureValidProxy === 'function') {
        proxyMode = await ipRotator.ensureValidProxy();
      }

      // After ensureValidProxy, re-read the current proxy (it may have rotated)
      const currentProxy = ipRotator.getCurrentProxy?.();

      if (currentProxy && proxyMode !== 'bypassed' && proxyMode !== 'direct' && !_proxyDisabled) {
        // Parse the proxy URL to separate credentials (if any) from the server URL.
        // Playwright requires credentials as separate username/password properties,
        // not inline in the URL string.
        try {
          const proxyUrl = new URL(currentProxy);
          const proxyConfig: any = { server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}` };
          if (proxyUrl.username) {
            proxyConfig.username = decodeURIComponent(proxyUrl.username);
          }
          if (proxyUrl.password) {
            proxyConfig.password = decodeURIComponent(proxyUrl.password);
          }
          contextOptions.proxy = proxyConfig;
          log(`Context proxy set to: ${proxyConfig.server}${proxyConfig.username ? ' (with auth)' : ''} [mode=${proxyMode}]`, 'INFO', 'browser');
        } catch {
          // If URL parsing fails, pass the raw proxy string
          contextOptions.proxy = { server: currentProxy };
          log(`Context proxy set to (raw): ${currentProxy} [mode=${proxyMode}]`, 'INFO', 'browser');
        }
      } else if (_proxyDisabled || proxyMode === 'bypassed') {
        log(`Proxy DISABLED (mode=${proxyMode}) — using direct connection`, 'WARN', 'browser');
      } else {
        log('No proxy available — using direct connection', 'DEBUG', 'browser');
      }
    } catch (e: any) {
      log(`Failed to validate/get proxy for context: ${e.message}`, 'WARN', 'browser');
    }
    this.contextInstance = await Promise.race([
      this.browserInstance.newContext(contextOptions),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Context creation timeout')), getCONFIG().BROWSER_CONTEXT_TIMEOUT_MS || 30000))
    ]);

    // ═══════════════════════════════════════════════════════════════════════
    // TIER 1 (2026-10-30): Playwright trace recording
    // ═══════════════════════════════════════════════════════════════════════
    // Records every click, navigation, screenshot, and network request.
    // The trace can be replayed with: npx playwright show-trace trace.zip
    // Only enabled when ENABLE_TRACING=true env var is set (GitHub Actions).
    if (process.env.ENABLE_TRACING === 'true') {
      try {
        const traceDir = process.env.TRACE_DIR || '/tmp/mathu-logs/traces';
        const traceFile = `${traceDir}/trace-${Date.now()}.zip`;
        // Ensure trace directory exists
        try { require('fs').mkdirSync(traceDir, { recursive: true }); } catch {}
        await this.contextInstance.tracing.start({
          screenshots: true,
          snapshots: true,
          sources: true,
          title: `MathU Bot Trace — ${new Date().toISOString()}`,
        });
        this._traceFile = traceFile;
        log(`[TIER1] Playwright tracing started — trace will be saved to ${traceFile}`, 'INFO', 'browser');
      } catch (traceErr: any) {
        log(`[TIER1] Tracing failed to start (non-fatal): ${traceErr.message}`, 'WARN', 'browser');
      }
    }
    // ─── End TIER 1 trace recording ───

    this.contextInstance.on('page', async (newPage: any) => {
      // CRITICAL FIX: In --single-process mode (Render free plan), closing any
      // page/popup kills the ENTIRE browser process because all pages share
      // one OS process. We must NOT close popups — just ignore them.
      const chromiumFlags = getCONFIG().CHROMIUM_FLAGS || process.env.CHROMIUM_FLAGS || '';
      const isSingleProcess = chromiumFlags.includes('--single-process');
      if (isSingleProcess) {
        log('Popup opened in single-process mode — ignoring (close would kill browser)', 'DEBUG', 'browser');
        return;
      }
      log('Closing unexpected new page/popup', 'WARN', 'browser');
      try { await Promise.race([newPage.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('Page close timeout')), getCONFIG().BROWSER_CLOSE_TIMEOUT_MS || 5000))]); } catch (err: any) { logError('Failed to close popup', err as Error); }
    });
  }

  async configurePage() { 
    const log = getLog();
    const logError = getLogError();
    const CONFIG = getCONFIG();
    if (!this.contextInstance) throw new Error('Context not available');
    this.pageInstance = await Promise.race([
      this.contextInstance.newPage(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Page creation timeout')), getCONFIG().BROWSER_PAGE_TIMEOUT_MS || 30000))
    ]);
    this.pageInstance.setDefaultTimeout(getCONFIG().BROWSER_PAGE_TIMEOUT_MS || 30000);
    this.pageInstance.setDefaultNavigationTimeout(getCONFIG().BROWSER_LAUNCH_TIMEOUT_MS || 45000);
    await this.pageInstance.addInitScript(this.getFingerprintSpoofScript());

    // ═══════════════════════════════════════════════════════════════════════
    // TIER 1+ (2026-10-31): Auto-click "Enable accessibility" on Flutter Web
    // ═══════════════════════════════════════════════════════════════════════
    // Flutter Web shows an "Enable accessibility" button on first load.
    // Without clicking it, Flutter doesn't create semantics DOM nodes —
    // the bot sees "Enable accessibility" instead of question text.
    // This init script runs on every navigation and auto-clicks the button.
    await this.pageInstance.addInitScript(function() {
      // Poll for the "Enable accessibility" button and click it
      var clickInterval = setInterval(function() {
        try {
          // Flutter Web renders the button as a clickable text element
          var els = document.querySelectorAll('flt-glass-pane, flt-semantics, [class*="semantics"], body *');
          for (var i = 0; i < els.length; i++) {
            var el = els[i];
            var text = (el.textContent || '').trim();
            if (text === 'Enable accessibility' || text.includes('Enable accessibility')) {
              console.log('[TASK151] Auto-clicking "Enable accessibility" button');
              el.click();
              // Also dispatch key events (Flutter sometimes responds to keypress)
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab' }));
              clearInterval(clickInterval);
              return;
            }
          }
        } catch (e) {}
      }, 1000);
      // Stop polling after 30 seconds
      setTimeout(function() { clearInterval(clickInterval); }, 30000);
    });
    // ─── End auto-click accessibility ───

    // ═══════════════════════════════════════════════════════════════════════
    // TASK 150/151 (2026-10-30): SUPERSEDED — CanvasKit blocking REMOVED.
    // On GitHub Actions (16GB RAM), CanvasKit loads normally with SwiftShader.
    // The Proxy mock + canvaskit.wasm blocking was only needed on Render (512MB).
    // Real CanvasKit = real rendering = screenshots have content = tribunal works.
    // ─── End Task 150/151 (superseded) ───

    // ═══════════════════════════════════════════════════════════════════════
    // TASK 150/151 CanvasKit blocking code — REMOVED (was Render-only workaround)
    // On GitHub Actions with 16GB RAM, CanvasKit loads and renders normally.
    // ═══════════════════════════════════════════════════════════════════════

    // ═══════════════════════════════════════════════════════════════════════
    // TASK 139 (2026-10-29): REMOVED Task 138's Flutter loader injection.
    // CanvasKit loads normally now — no blocking, no Proxy mock, no semantics forcing.
    // The bot takes screenshots of the REAL rendered page and sends them to the tribunal.
    // ═══════════════════════════════════════════════════════════════════════

    this.pageInstance.on('crash', () => { log('Page crashed', 'ERROR', 'browser'); this.browserDisconnected = true; this.emit('crashed'); });
    this.pageInstance.on('error', (err: Error) => { logError('Page error', err); });

    // Console message capture for debugging
    this.pageInstance.on('console', (msg: any) => {
      try {
        const text = msg.text?.() ?? String(msg);
        const lower = String(text).toLowerCase();
        if (lower.includes('webgl') || lower.includes('canvaskit') ||
            lower.includes('flutter') || lower.includes('shader') ||
            lower.includes('vulkan') || lower.includes('gl_') ||
            lower.includes('opengl') || lower.includes('angle') ||
            lower.includes('swiftshader') || lower.includes('error') ||
            lower.includes('task150') || lower.includes('task149') ||
            lower.includes('task146') || lower.includes('task148') ||
            lower.includes('task151') || lower.includes('probe') ||
            lower.includes('semantic') || lower.includes('engine') ||
            lower.includes('render')) {
          const type = msg.type?.() ?? 'log';
          const level = type === 'error' ? 'ERROR' : (type === 'warning' ? 'WARN' : 'INFO');
          log(`[PAGE-CONSOLE ${type.toUpperCase()}] ${String(text).substring(0, 500)}`, level, 'browser');
        }
      } catch { /* don't let console handler crash anything */ }
    });
    this.pageInstance.on('pageerror', (err: Error) => {
      try {
        log(`[PAGE-ERROR] ${err.message || String(err)}`, 'ERROR', 'browser');
      } catch {}
    });

    // ═══════════════════════════════════════════════════════════════════════
    // TASK 149 (2026-10-30): SUPERSEDED by Task 150.
    // Task 149 tried to force the chromium variant of CanvasKit (3.5MB vs
    // 7.2MB) to reduce the WASM compile spike. But the pre-CanvasKit baseline
    // was already 450MB, and even the chromium variant's 75MB compile spike
    // pushed cgroup past 512MB → OOM.
    //
    // Task 150 takes the nuclear approach: block CanvasKit entirely and read
    // from Flutter semantics DOM nodes instead. All Task 149 route handlers
    // and init scripts have been removed to avoid conflicts.
    // ─── End Task 149 (superseded) ───

    // ═══════════════════════════════════════════════════════════════════════
    // TASK 139 (2026-10-29): REMOVED Task 138's Flutter loader injection.
    // ═══════════════════════════════════════════════════════════════════════
    // Task 138 tried to inject a canvasKitVariant: "chromium" config by
    // monkey-patching _flutter.loader.load(). But:
    //   1. The injection set window._flutter.loader = {} BEFORE flutter.js
    //      loaded. When flutter.js checked `window._flutter.loader || create`,
    //      it found the empty object and SKIPPED creating the real loader.
    //      → Flutter never initialized → page permanently BLANK.
    //   2. The HTML calls loadEntrypoint(), not load(). The canvasKitVariant
    //      config is only read by load(), so the injection was useless anyway.
    //
    // REMOVED entirely. CanvasKit will load normally (full 7.2MB WASM).
    // The watchdog now has a 90s grace period after navigation to let the
    // WASM compile complete without being killed.
    // ═══════════════════════════════════════════════════════════════════════

    this.pageInstance.on('crash', () => { log('Page crashed', 'ERROR', 'browser'); this.browserDisconnected = true; this.emit('crashed'); });
    this.pageInstance.on('error', (err: Error) => { logError('Page error', err); });
    const selectCalibration = getSelectCalibration();
    if (selectCalibration) {
      const savedScale = selectCalibration.get('scaleFactor');
      if (savedScale?.value) { this.scaleFactor = parseFloat(savedScale.value) || 1.0; }
    }
    await this.calibrateViewport();
    const vp = getPageViewport(this.pageInstance);
    if (vp) { this.viewportWidth = vp.width; this.viewportHeight = vp.height; }
    if (CONFIG.FLUTTER_DPR_AUTO_CALIBRATE) { await this.calibrateDpr(); }
  }

  async cleanup() { 
    // TIER 1: Try to save trace on emergency cleanup
    if (process.env.ENABLE_TRACING === 'true' && this.contextInstance && this._traceFile) {
      try {
        const log = getLog();
        log(`[TIER1] Saving trace on cleanup to ${this._traceFile}...`, 'INFO', 'browser');
        await this.contextInstance.tracing.stop({ path: this._traceFile });
        log('[TIER1] ✅ Trace saved on cleanup', 'INFO', 'browser');
      } catch {}
    }
    try { if (this.pageInstance && !this.pageInstance.isClosed()) { await this.pageInstance.close({ runBeforeUnload: false }).catch(() => {}); } } catch {}
    try { if (this.contextInstance) { await this.contextInstance.close().catch(() => {}); } } catch {}
    try { if (this.browserInstance && this.browserInstance.isConnected()) { await this.browserInstance.close().catch(() => {}); } } catch {}
    this.pageInstance = null; this.contextInstance = null; this.browserInstance = null; this.cdpSession = null;
    this._traceFile = null;
  }

  async close() { 
    const log = getLog();
    const saveSession = getSaveSession();
    log('Closing browser gracefully...', 'INFO', 'browser');
    this._intentionalClose = true;
    if (this._healthCheckInterval) { clearInterval(this._healthCheckInterval); this._healthCheckInterval = null; }
    if (this._memoryMonitorInterval) { clearInterval(this._memoryMonitorInterval); this._memoryMonitorInterval = null; }

    // ═══════════════════════════════════════════════════════════════════════
    // TIER 1 (2026-10-30): Save Playwright trace before closing browser
    // ═══════════════════════════════════════════════════════════════════════
    if (process.env.ENABLE_TRACING === 'true' && this.contextInstance && this._traceFile) {
      try {
        log(`[TIER1] Saving Playwright trace to ${this._traceFile}...`, 'INFO', 'browser');
        await this.contextInstance.tracing.stop({ path: this._traceFile });
        log(`[TIER1] ✅ Trace saved (${require('fs').statSync(this._traceFile).size / 1024 / 1024 | 0}MB)`, 'INFO', 'browser');
      } catch (traceErr: any) {
        log(`[TIER1] Failed to save trace (non-fatal): ${traceErr.message}`, 'WARN', 'browser');
      }
    }
    // ─── End TIER 1 trace saving ───

    // Skip session save if browser already disconnected (avoids Protocol error)
    if (this.contextInstance && !this.browserDisconnected && this.browserInstance?.isConnected()) {
      try { const storage = await this.contextInstance.storageState(); if (storage) { saveSession(storage); } } catch (err: any) { log(`Failed to save session on close: ${(err as Error).message}`, 'WARN', 'browser'); }
    }
    const closeOperations = [
      { resource: this.cdpSession, name: 'CDP session', closeMethod: 'detach' },
      { resource: this.pageInstance, name: 'page' },
      { resource: this.contextInstance, name: 'context' },
      { resource: this.browserInstance, name: 'browser' }
    ];
    for (const { resource, name, closeMethod } of closeOperations) {
      if (resource) {
        try {
          const closeFn = closeMethod ? resource[closeMethod].bind(resource) : resource.close.bind(resource);
          await Promise.race([closeFn(), new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 10000))]); log(`Closed ${name}`, 'DEBUG', 'browser');
        } catch (err: any) { log(`Failed to close ${name}: ${(err as Error).message}`, 'WARN', 'browser'); }
      }
    }
    this.cdpSession = null; this.pageInstance = null; this.contextInstance = null; this.browserInstance = null;
    log('Browser closed', 'INFO', 'browser');
  }

  getFingerprintSpoofScript() { 
    // Random but stable-per-session values (generated once at startup)
    if (!this._fpFonts) {
      this._fpFonts = [
        'Arial', 'Arial Black', 'Calibri', 'Cambria', 'Comic Sans MS',
        'Consolas', 'Courier New', 'Georgia', 'Helvetica', 'Impact',
        'Lucida Console', 'Palatino Linotype', 'Segoe UI', 'Tahoma',
        'Times New Roman', 'Trebuchet MS', 'Verdana'
      ];
      // Shuffle with a deterministic seed from PID
      const seed = process.pid;
      for (let i = this._fpFonts.length - 1; i > 0; i--) {
        const j = ((seed * 1103515245 + 12345) >> 16) % (i + 1);
        [this._fpFonts[i], this._fpFonts[j]] = [this._fpFonts[j], this._fpFonts[i]];
      }
      // Present 12-16 fonts (realistic for a standard Windows/Mac install)
      const count = 12 + ((seed >> 8) % 5);
      this._fpFonts = this._fpFonts.slice(0, count);
    }
    const fontsJSON = JSON.stringify(this._fpFonts);

    return `
      // ── WebRTC blocking ──
      const originalRTCPeerConnection = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (originalRTCPeerConnection) {
        window.RTCPeerConnection = function() {
          throw new DOMException('WebRTC not supported', 'NotSupportedError');
        };
        window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
      }

      // ── Canvas fingerprint noise ──
      const toDataURL = HTMLCanvasElement.prototype.toDataURL;
      HTMLCanvasElement.prototype.toDataURL = function(type) {
        if (type === 'image/png') {
          const context = this.getContext('2d');
          if (context) {
            const imageData = context.getImageData(0, 0, this.width, this.height);
            for (let i = 0; i < imageData.data.length; i += 4) {
              imageData.data[i] = imageData.data[i] ^ (Math.random() > 0.5 ? 1 : 0);
            }
            context.putImageData(imageData, 0, 0);
          }
        }
        return toDataURL.apply(this, arguments);
      };
      // Also noise toBlob and toBlobSync
      const origToBlob = HTMLCanvasElement.prototype.toBlob;
      if (origToBlob) {
        HTMLCanvasElement.prototype.toBlob = function(callback, type, quality) {
          return origToBlob.call(this, callback, type, quality);
        };
      }

      // ── WebGL vendor/renderer spoofing (WebGL1 + WebGL2) ──
      const getParameter = WebGLRenderingContext.prototype.getParameter;
      WebGLRenderingContext.prototype.getParameter = function(param) {
        if (param === 37445) return 'Intel Inc.';
        if (param === 37446) return 'Intel Iris OpenGL Engine';
        if (param === 7936) return 'WebKit';
        if (param === 7937) return 'WebKit WebGL';
        return getParameter.apply(this, arguments);
      };
      const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
      if (getParameter2) {
        WebGL2RenderingContext.prototype.getParameter = function(param) {
          if (param === 37445) return 'Intel Inc.';
          if (param === 37446) return 'Intel Iris OpenGL Engine';
          if (param === 7936) return 'WebKit';
          if (param === 7937) return 'WebKit WebGL';
          return getParameter2.apply(this, arguments);
        };
      }

      // ── AudioContext fingerprint noise ──
      const origCreateOscillator = AudioContext.prototype.createOscillator;
      if (origCreateOscillator) {
        AudioContext.prototype.createOscillator = function() {
          const osc = origCreateOscillator.call(this);
          const origConnect = osc.connect.bind(osc);
          osc.connect = function(dest, ...args) {
            return origConnect(dest, ...args);
          };
          return osc;
        };
      }

      // ── Font enumeration spoofing ──
      if (document.fonts && document.fonts.check) {
        const origFontCheck = document.fonts.check.bind(document.fonts);
        const allowedFonts = ${fontsJSON};
        document.fonts.check = function(font, text) {
          const match = font.match(/(?:"|')?([^"',]+)(?:"|')?/);
          if (match) {
            const fontName = match[1].trim();
            if (allowedFonts.some(f => f.toLowerCase() === fontName.toLowerCase())) {
              return true;
            }
          }
          return origFontCheck(font, text);
        };
      }

      // ── Plugins spoofing (Chrome-like) ──
      Object.defineProperty(navigator, 'plugins', {
        get: () => {
          const plugins = [
            { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
            { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
            { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' }
          ];
          plugins.length = 3;
          return plugins;
        }
      });

      // ── Languages spoofing ──
      Object.defineProperty(navigator, 'languages', {
        get: () => ['en-US', 'en']
      });

      // ── Hardware concurrency ──
      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8
      });

      // ── Device memory ──
      if (navigator.deviceMemory === undefined) {
        Object.defineProperty(navigator, 'deviceMemory', {
          get: () => 8
        });
      }

      // ── Platform spoofing (consistent with user-agent) ──
      const ua = navigator.userAgent;
      const platform = ua.includes('Mac') ? 'MacIntel' : ua.includes('Linux') ? 'Linux x86_64' : 'Win32';
      Object.defineProperty(navigator, 'platform', {
        get: () => platform
      });

      // ── Suppress automation flags ──
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined
      });

      // ── Chrome runtime spoofing ──
      window.chrome = window.chrome || {};
      window.chrome.runtime = window.chrome.runtime || {};

      // ── Permissions query consistency ──
      const origQuery = Permissions.prototype.query;
      if (origQuery) {
        Permissions.prototype.query = function(params) {
          if (params.name === 'notifications') {
            return Promise.resolve({ state: Notification.permission });
          }
          return origQuery.call(this, params);
        };
      }
    `;
  }

  async calibrateViewport() { 
    const log = getLog();
    if (!this.pageInstance) return;
    try {
      const result = await this.pageInstance.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio, screenWidth: window.screen.width, screenHeight: window.screen.height }));
      log(`Viewport calibrated: ${result.width}x${result.height}, DPR: ${result.devicePixelRatio}`, 'DEBUG', 'browser');
      return result;
    } catch (err: any) { log(`Viewport calibration failed: ${(err as Error).message}`, 'WARN', 'browser'); return null; }
  }

  async calibrateDpr() { 
    const log = getLog();
    if (!this.pageInstance) return;
    try { this.dprScale = await this.pageInstance.evaluate(() => window.devicePixelRatio) || 1.0; log(`DPR calibrated: ${this.dprScale}`, 'DEBUG', 'browser'); } catch (err: any) { log(`DPR calibration failed: ${(err as Error).message}`, 'WARN', 'browser'); this.dprScale = 1.0; }
  }

  // TASK 89 (2026-09-25): Lowered defaults from 640px/q15 to 512px/q10.
  // The bot was OOM-looping on the assignments page — smaller screenshots
  // mean less transient memory during parallel tribunal calls.
  async compressScreenshot(base64: string, maxWidth = 512, quality = 10) { 
    if (!base64) return base64;
    const sharp = _getSharp();
    if (!sharp) return base64;
    try {
      const buffer = Buffer.from(base64, 'base64');
      const compressed = await sharp(buffer).resize(maxWidth, null, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality }).toBuffer();
      return compressed.toString('base64');
    } catch { return base64; }
  }

  async performClickWithRetry(page: any, x: number, y: number, maxRetries = 3) { 
    const log = getLog();
    let success = false;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const jx = x + BrowserManager._gaussianRandom(0, 1.5);
        const jy = y + BrowserManager._gaussianRandom(0, 1.5);
        await this._humanDelay(50, 30);
        await page.mouse.click(jx, jy);
        success = true;
        break;
      } catch (err: any) {
        log(`Click retry ${i+1}/${maxRetries} failed: ${(err as Error).message}`, 'DEBUG', 'browser');
        await this._humanDelay(400, 200);
      }
    }
    return success;
  }

  async humanMoveAndClick(page: any, x: number, y: number) {
    const startX = await page.evaluate(() => window.mouseX || 0).catch(() => 0);
    const startY = await page.evaluate(() => window.mouseY || 0).catch(() => 0);
    if (startX === 0 && startY === 0) {
      return this.performClickWithRetry(page, x, y, 3);
    }
    const steps = 3 + Math.floor(Math.random() * 3);
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      const ease = t * t * (3 - 2 * t);
      const perpX = (y - startY) * 0.05 * Math.sin(t * Math.PI);
      const perpY = -(x - startX) * 0.05 * Math.sin(t * Math.PI);
      const cx = startX + (x - startX) * ease + perpX + BrowserManager._gaussianRandom(0, 0.8);
      const cy = startY + (y - startY) * ease + perpY + BrowserManager._gaussianRandom(0, 0.8);
      await page.mouse.move(cx, cy);
      await this._humanDelay(8, 6);
    }
    const jx = x + BrowserManager._gaussianRandom(0, 1.2);
    const jy = y + BrowserManager._gaussianRandom(0, 1.2);
    await this._humanDelay(30, 20);
    await page.mouse.click(jx, jy);
    return true;
  }

  async flutterTap(page: any, x: number, y: number) { 
    try { await page.mouse.click(x, y); return true; } catch { return false; }
  }

  async scrollPage(page: any, deltaX: number, deltaY: number) { 
    const logError = getLogError();
    try {
      const chunks = 3 + Math.floor(Math.random() * 3);
      const dxChunk = deltaX / chunks;
      const dyChunk = deltaY / chunks;
      for (let i = 0; i < chunks; i++) {
        const jitterX = dxChunk + BrowserManager._gaussianRandom(0, Math.abs(dxChunk) * 0.1 + 1);
        const jitterY = dyChunk + BrowserManager._gaussianRandom(0, Math.abs(dyChunk) * 0.1 + 1);
        await page.mouse.wheel(jitterX, jitterY);
        await this._humanDelay(30, 20);
      }
    } catch (err: any) { logError('Scroll failed', err as Error); }
  }

  async getCDPSession(page: any) { 
    const logError = getLogError();
    if (this.cdpSession) return this.cdpSession;
    if (!page || !this.browserInstance) return null;
    try {
      this.cdpSession = await page.createCDPSession();
      return this.cdpSession;
    } catch (err: any) { logError('Failed to create CDP session', err as Error); return null; }
  }

  performClickWithStyle(page: any, x: number, y: number, style = 'human') { 
    if (style === 'human') {
      return this.humanMoveAndClick(page, x, y);
    }
    return this.flutterTap(page, x, y);
  }

  async getElementTextAt(page: any, x: number, y: number) { 
    const logError = getLogError();
    try {
      return await page.evaluate(({ px, py }: any) => {
        const el = document.elementFromPoint(px, py);
        return el ? el.textContent?.substring(0, 200) || '' : '';
      }, { px: x, py: y });
    } catch (err: any) { logError('getElementTextAt failed', err as Error); return ''; }
  }

  async withBrowserRetry(action: (page: any) => Promise<any>, maxRetries = 3) { 
    const log = getLog();
    let lastError: Error | undefined;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const page = await this.launch();
        const result = await action(page);
        return result;
      } catch (err: any) {
        lastError = err as Error;
        log(`Browser retry ${i + 1}/${maxRetries}: ${lastError.message}`, 'WARN', 'browser');
        await this.cleanup();
      }
    }
    throw lastError;
  }
}

// Lazy singleton — created on first access after _injectDependencies has been called
let _browserManager: BrowserManager | null = null;
function getBrowserManager(): BrowserManager {
  if (!_browserManager) {
    _browserManager = new BrowserManager();
  }
  return _browserManager;
}

/**
 * Non-deprecated replacement for page.viewportSize().
 * Playwright deprecated viewportSize() in 1.44+.
 * Uses optional chaining so it still works today but falls back gracefully
 * when the method is removed from a future Playwright version.
 */
function getPageViewport(page: any): { width: number; height: number } {
  try {
    const vp = page.viewportSize?.();
    if (vp) return vp;
  } catch { /* method removed in future Playwright */ }
  try {
    return page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
  } catch { /* evaluate failed */ }
  return { width: 1280, height: 800 };
}

// ─── TASK 150 (2026-10-30): DOM text extraction for Flutter semantics ───
// When CanvasKit is blocked (Task 150), the canvas is blank but Flutter's
// Dart code still runs and creates DOM semantics nodes. This function
// extracts all visible text from the page — including Flutter semantics,
// aria-labels, and any regular DOM text.
//
// Flutter semantics nodes use these element types:
//   <flt-semantics> — container for a semantics node
//   <flt-semantics-container> — grouping container
//   <flt-semantics-text> — text content node
//   aria-label attributes on various elements
//
// Returns: { text: string, nodeCount: number, hasFlutterSemantics: boolean }
async function extractDomText(page: any): Promise<{ text: string; nodeCount: number; hasFlutterSemantics: boolean; hasCanvas: boolean; bodyHTML: string }> {
  const log = getLog();
  try {
    const result = await page.evaluate(() => {
      // Try Flutter semantics first
      var flutterNodes = document.querySelectorAll('flt-semantics, flt-semantics-container, flt-semantics-text, [aria-label]');
      var texts = [];
      flutterNodes.forEach(function(node) {
        var t = node.getAttribute('aria-label') || node.textContent || '';
        if (t && t.trim().length > 0) {
          texts.push(t.trim());
        }
      });
      // Also try regular DOM text (for non-Flutter content like login pages)
      if (texts.length === 0) {
        var bodyText = document.body ? document.body.innerText : '';
        if (bodyText && bodyText.trim().length > 0) {
          texts.push(bodyText.trim().substring(0, 5000));
        }
      }
      // Also try input fields and buttons
      var inputs = document.querySelectorAll('input, button, [role="button"], a');
      inputs.forEach(function(el) {
        var t = el.getAttribute('aria-label') || el.textContent || el.getAttribute('placeholder') || '';
        if (t && t.trim().length > 0) {
          texts.push('[' + (el.tagName || 'ELEMENT') + '] ' + t.trim());
        }
      });
      // Check for canvas elements
      var canvases = document.querySelectorAll('canvas');
      var combined = texts.join('\n');
      return {
        text: combined,
        nodeCount: flutterNodes.length,
        hasFlutterSemantics: flutterNodes.length > 0,
        hasCanvas: canvases.length > 0,
        bodyHTML: document.body ? document.body.innerHTML.substring(0, 2000) : '(no body)'
      };
    });
    log(`[TASK150] extractDomText: ${result.nodeCount} semantics nodes, ${result.text.length} chars text, hasCanvas=${result.hasCanvas}`, 'INFO', 'browser');
    if (result.text.length > 0) {
      // Log first 500 chars for diagnostic
      log(`[TASK150] DOM text preview: ${result.text.substring(0, 500).replace(/\n/g, ' | ')}`, 'INFO', 'browser');
    } else {
      log(`[TASK150] No DOM text found — page may not have loaded Flutter yet. Body HTML preview: ${result.bodyHTML.substring(0, 300)}`, 'WARN', 'browser');
    }
    return result;
  } catch (err: any) {
    const msg = err?.message || String(err);
    log(`[TASK150] extractDomText failed: ${msg}`, 'ERROR', 'browser');
    return { text: '', nodeCount: 0, hasFlutterSemantics: false, hasCanvas: false, bodyHTML: '' };
  }
}
// ─── End Task 150 DOM text extraction ───

// ─── TASK 148 (2026-10-29): Node-side WebGL check ───
async function checkWebGL(page: any): Promise<{ available: boolean; vendor?: string; renderer?: string; error?: string }> {
  const log = getLog();
  try {
    const result = await page.evaluate(() => {
      try {
        var c = document.createElement('canvas');
        var gl = c.getContext('webgl2') || c.getContext('webgl') || c.getContext('experimental-webgl');
        if (!gl) {
          return { available: false, error: 'No WebGL context' };
        }
        var dbg = gl.getExtension('WEBGL_debug_renderer_info');
        var vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VERSION);
        var renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : '(masked)';
        return { available: true, vendor: String(vendor), renderer: String(renderer) };
      } catch (e) {
        return { available: false, error: String(e && e.message ? e.message : e) };
      }
    });
    if (result.available) {
      log(`[TASK148] Node-side WebGL check: AVAILABLE — vendor=${result.vendor} renderer=${result.renderer}`, 'INFO', 'browser');
    } else {
      log(`[TASK148] Node-side WebGL check: UNAVAILABLE — ${result.error} (expected with --disable-gpu in Task 150)`, 'INFO', 'browser');
    }
    return result;
  } catch (err: any) {
    const msg = err?.message || String(err);
    log(`[TASK148] Node-side WebGL check: evaluate() failed — ${msg}`, 'WARN', 'browser');
    return { available: false, error: msg };
  }
}
// ─── End Task 148 Node-side WebGL check ───

module.exports = {
  get browserManager() { return getBrowserManager(); },
  getBrowserMetrics: () => getBrowserManager().getMetrics(),
  launchBrowser: () => getBrowserManager().launch(),
  closeBrowser: () => getBrowserManager().close(),
  getBrowserDisconnected: () => getBrowserManager().getBrowserDisconnected(),
  resetBrowserDisconnected: () => getBrowserManager().resetBrowserDisconnected(),
  getCDPSession: (page: any) => getBrowserManager().getCDPSession(page),
  flutterTap: (page: any, x: number, y: number) => getBrowserManager().flutterTap(page, x, y),
  performClickWithStyle: (page: any, x: number, y: number, style?: string) => getBrowserManager().performClickWithStyle(page, x, y, style),
  performClickWithRetry: (page: any, x: number, y: number, maxRetries?: number) => getBrowserManager().performClickWithRetry(page, x, y, maxRetries),
  scrollPage: (page: any, deltaX: number, deltaY: number) => getBrowserManager().scrollPage(page, deltaX, deltaY),
  humanMoveAndClick: (page: any, x: number, y: number) => getBrowserManager().humanMoveAndClick(page, x, y),
  getElementTextAt: (page: any, x: number, y: number) => getBrowserManager().getElementTextAt(page, x, y),
  get MOD_KEY() { return getBrowserManager().MOD_KEY; },
  getBrowserLaunchCount: () => getBrowserManager().getBrowserLaunchCount(),
  resetBrowserLaunchCount: () => getBrowserManager().resetBrowserLaunchCount(),
  getScaleFactor: () => getBrowserManager().getScaleFactor(),
  getViewportDimensions: () => getBrowserManager().getViewportDimensions(),
  compressScreenshot: (base64: string, maxWidth?: number, quality?: number) => getBrowserManager().compressScreenshot(base64, maxWidth, quality),
  withBrowserRetry: (action: (page: any) => Promise<any>, maxRetries?: number) => getBrowserManager().withBrowserRetry(action, maxRetries),
  getDprScale: () => getBrowserManager().getDprScale(),
  getPageViewport,
  getBrowser: () => getBrowserManager().browserInstance,
  getPage: () => getBrowserManager().pageInstance,
  // TASK 150: DOM text extraction — reads Flutter semantics nodes when
  // CanvasKit is blocked. Used by cycle manager as fallback for screenshots.
  extractDomText,
  checkWebGL,
  // DI support
  _injectDependencies,
};
