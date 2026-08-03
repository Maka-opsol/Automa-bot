'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, safeLog, logError } = require('./logger');

const SELECTOR_CACHE = new Map();
const SELECTOR_TTL = 5 * 60 * 1000;

class SelectorManager {
  basePath: any;

  constructor() { this.basePath = PROJECT_ROOT; }
  getSelectors(component: any) { 
    const cacheKey = component;
    const cached = SELECTOR_CACHE.get(cacheKey);
    if (cached && (Date.now() - cached.loadedAt < SELECTOR_TTL)) { return cached.data; }
    try {
      // Try flat filename first (selectors-{component}-current.json)
      const flatPath = path.join(this.basePath, `selectors-${component}-current.json`);
      let realPath = null;
      try {
        realPath = fs.realpathSync(flatPath);
      } catch {
        // Fallback to directory-based path (component/current.json)
        try {
          realPath = fs.realpathSync(path.join(this.basePath, component, 'current.json'));
        } catch {}
      }
      if (!realPath) throw new Error(`No selector file found for ${component}`);
      const data = JSON.parse(fs.readFileSync(realPath, 'utf8'));
      SELECTOR_CACHE.set(cacheKey, { data, loadedAt: Date.now() });
      log(`Loaded selectors: ${component} v${data.version}`, 'DEBUG', 'selectors');
      return data;
    } catch (err: any) {
      logError(`Failed to load selectors for ${component}`, err);
      return this.getFallbackSelectors(component);
    }
  }
  getFallbackSelectors(component: any) { 
    const fallbacks = {
      'microsoft-login': {
        version: 'fallback',
        selectors: {
          emailInput: 'input[type="email"]',
          passwordInput: 'input[type="password"]',
          submitButton: 'button[type="submit"]',
          captchaContainer: '#idDiv_SAOTCS_Proofs',
          captchaImage: 'img[alt*="captcha"]',
          captchaInput: 'input[type="text"]'
        }
      }
    };
    return (fallbacks as any)[component] || { version: 'fallback', selectors: {} };
  }
  setActiveVersion(component: any, version: any) {
    // Try flat filename first (selectors-{component}-v{version}.json)
    const flatVersionPath = path.join(this.basePath, `selectors-${component}-v${version}.json`);
    const flatCurrentPath = path.join(this.basePath, `selectors-${component}-current.json`);
    let versionFile = null;
    let currentLink = null;
    if (fs.existsSync(flatVersionPath)) {
      versionFile = flatVersionPath;
      currentLink = flatCurrentPath;
    } else {
      // Fallback to directory-based path
      const componentPath = path.join(this.basePath, component);
      versionFile = path.join(componentPath, `v${version}.json`);
      currentLink = path.join(componentPath, 'current.json');
    }
    if (!fs.existsSync(versionFile)) throw new Error(`Version file not found: ${versionFile}`);
    let oldTarget = null;
    try { oldTarget = fs.readlinkSync(currentLink); } catch {}
    try {
      if (fs.existsSync(currentLink)) fs.unlinkSync(currentLink);
      fs.symlinkSync(versionFile, currentLink);
      SELECTOR_CACHE.delete(component);
      log(`Updated ${component} to version ${version}`, 'INFO', 'selectors');
    } catch (err: any) {
      if (oldTarget) { try { fs.symlinkSync(oldTarget, currentLink); } catch {} }
      throw err;
    }
  }
  getAvailableVersions(component: any) { 
    // Try flat filenames first (selectors-{component}-v{N}.json)
    const versions = new Set();
    try {
      const files = fs.readdirSync(this.basePath);
      const prefix = `selectors-${component}-v`;
      for (const f of files) {
        if (f.startsWith(prefix) && f.endsWith('.json')) {
          const m = f.match(/v(\d+)\.json$/);
          if (m) versions.add(parseInt(m[1], 10));
        }
      }
    } catch {}
    // Also check directory-based versions
    const componentPath = path.join(this.basePath, component);
    if (fs.existsSync(componentPath)) {
      try {
        const dirFiles = fs.readdirSync(componentPath);
        for (const f of dirFiles) {
          const m = f.match(/^v(\d+)\.json$/);
          if (m) versions.add(parseInt(m[1], 10));
        }
      } catch {}
    }
    return [...versions].sort((a: any, b: any) => b - a);
  }
}

// Fallback selector patterns when primary selectors fail
const FALLBACK_SELECTORS = {
  'signin-button': [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'a:has-text("Sign in")',
    '[data-testid="signin-button"]',
    '#signin-button',
  ],
  'email-input': [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="loginfmt"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    '#i0116',
  ],
  'password-input': [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="passwd"]',
    'input[autocomplete="current-password"]',
    '#i0118',
  ],
  'assignment-card': [
    '[data-testid="assignment-card"]',
    '.assignment-card',
    '.module-card',
    '[class*="assignment"]',
    '[class*="card"][class*="module"]',
  ],
  'module-completion': [
    '[data-testid="completion-indicator"]',
    '.completion-indicator',
    '[class*="complete"]',
    '[class*="check"]',
    'svg[class*="check"]',
  ],
};

function getSelectorsWithFallbacks(key: any) { 
  // Returns primary selectors from JSON files, plus fallbacks
  const primary = [];
  try {
    const data = selectorManager.getSelectors(key);
    if (data?.selectors) {
      for (const [name, selector] of Object.entries(data.selectors)) {
        if (typeof selector === 'string') primary.push(selector);
      }
    }
  } catch (e: any) { /* fallback to static selectors only */ }
  const fallbacks = (FALLBACK_SELECTORS as any)[key] || [];
  return [...primary, ...fallbacks];
}

const selectorManager = new SelectorManager();
module.exports = { selectorManager, SelectorManager, getSelectorsWithFallbacks, FALLBACK_SELECTORS };
