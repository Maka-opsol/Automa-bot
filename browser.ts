'use strict';

import type { Deps } from './types/di-types';

// ─── npm packages + Node builtins only at top level ───
const { chromium } = require('playwright');
let sharp: any;
try { sharp = require('sharp'); } catch (e: any) { sharp = null; }
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
    if (CONFIG.HTTP_PROXY || CONFIG.HTTPS_PROXY) { addProxyFlags(flags, { http: CONFIG.HTTP_PROXY, https: CONFIG.HTTPS_PROXY }); }
    addWindowSizeFlags(flags, CONFIG.DISPLAY_WIDTH, CONFIG.DISPLAY_HEIGHT);
    const options = { headless: !!getCONFIG().HEADLESS, args: flags, timeout: getCONFIG().BROWSER_LAUNCH_TIMEOUT_MS || 60000 };
// @ts-expect-error
    if (CONFIG.CHROMIUM_EXECUTABLE_PATH) { options.executablePath = CONFIG.CHROMIUM_EXECUTABLE_PATH; }
    return options;
  }

  getReducedLaunchOptions() { 
    const CONFIG = getCONFIG();
    // NOTE: --disable-gpu removed — breaks Flutter CanvasKit WebGL rendering
    const flags = ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-extensions', '--disable-background-networking', `--window-size=${CONFIG.DISPLAY_WIDTH},${CONFIG.DISPLAY_HEIGHT}`];
    if (CONFIG.HTTPS_PROXY) { flags.push(`--proxy-server=${CONFIG.HTTPS_PROXY}`); }
    const options = { headless: true, args: flags, timeout: getCONFIG().BROWSER_LAUNCH_TIMEOUT_MS || 45000 };
// @ts-expect-error
    if (CONFIG.CHROMIUM_EXECUTABLE_PATH) { options.executablePath = CONFIG.CHROMIUM_EXECUTABLE_PATH; }
    return options;
  }

  getMinimalLaunchOptions() { 
    const CONFIG = getCONFIG();
    // NOTE: --disable-gpu removed — breaks Flutter CanvasKit WebGL rendering
    const options = { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--no-zygote', '--single-process'], timeout: getCONFIG().BROWSER_LAUNCH_TIMEOUT_MS || 30000 };
// @ts-expect-error
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
    const contextOptions = await getRealisticBrowserContext();
    if (sessionData) { contextOptions.storageState = sessionData; }
    this.contextInstance = await Promise.race([
      this.browserInstance.newContext(contextOptions),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Context creation timeout')), getCONFIG().BROWSER_CONTEXT_TIMEOUT_MS || 30000))
    ]);
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
    try { if (this.pageInstance && !this.pageInstance.isClosed()) { await this.pageInstance.close({ runBeforeUnload: false }).catch(() => {}); } } catch {}
    try { if (this.contextInstance) { await this.contextInstance.close().catch(() => {}); } } catch {}
    try { if (this.browserInstance && this.browserInstance.isConnected()) { await this.browserInstance.close().catch(() => {}); } } catch {}
    this.pageInstance = null; this.contextInstance = null; this.browserInstance = null; this.cdpSession = null;
  }

  async close() { 
    const log = getLog();
    const saveSession = getSaveSession();
    log('Closing browser gracefully...', 'INFO', 'browser');
    this._intentionalClose = true;
    if (this._healthCheckInterval) { clearInterval(this._healthCheckInterval); this._healthCheckInterval = null; }
    if (this._memoryMonitorInterval) { clearInterval(this._memoryMonitorInterval); this._memoryMonitorInterval = null; }
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

  async compressScreenshot(base64: string, maxWidth = 640, quality = 15) { 
    if (!base64) return base64;
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
  // DI support
  _injectDependencies,
};
