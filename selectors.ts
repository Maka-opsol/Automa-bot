'use strict';

// ═════════════════════════════════════════════════════════════
// Selector Manager — Loads, caches, and manages CSS/Playwright
// selector sets for different UI components.
//
// Render-aware: Cache eviction on memory pressure, Render-safe
// file reads (all under /tmp on Render), mtime-based staleness.
// ═════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, safeLog, logError } = require('./logger');

// ═════════════════════════════════════════════════════════════
// Constants
// ═════════════════════════════════════════════════════════════

/** Time-to-live for cached selector sets (ms). */
const SELECTOR_TTL = 5 * 60 * 1000; // 5 minutes

/** Maximum number of selector sets in cache. */
const MAX_CACHE_ENTRIES = 15;

/** Maximum size of a selector file in bytes (sanity check). */
const MAX_SELECTOR_FILE_SIZE = 100_000; // 100 KB

// ═════════════════════════════════════════════════════════════
// In-memory selector cache
// ═════════════════════════════════════════════════════════════

// BUG FIX (Response 19): Cache now tracks mtime of the source file
// so we can detect external changes (e.g., self-heal selector drift)
// without waiting for TTL expiry.
const SELECTOR_CACHE = new Map<string, {
  data: any;
  loadedAt: number;
  sourceMtime: number;
}>();

/**
 * Evict the oldest cache entry if the cache is full.
 * Uses insertion order (Map preserves it).
 */
function _evictIfNeeded(): void {
  if (SELECTOR_CACHE.size >= MAX_CACHE_ENTRIES) {
    const oldest = SELECTOR_CACHE.keys().next().value;
    if (oldest !== undefined) {
      SELECTOR_CACHE.delete(oldest);
      log(`Selector cache evicted: ${oldest}`, 'DEBUG', 'selectors');
    }
  }
}

// ═════════════════════════════════════════════════════════════
// SelectorManager class
// ═════════════════════════════════════════════════════════════

class SelectorManager {
  basePath: any;

  constructor() { this.basePath = PROJECT_ROOT; }

  /**
   * Get selectors for a component. Tries flat file first, then
   * directory-based path. Falls back to hardcoded selectors on failure.
   *
   * BUG FIX (Response 19): Now checks file mtime to detect changes
   * made by self-heal-selector-drift or other external writers.
   * Also validates file size before parsing.
   */
  getSelectors(component: any) {
    const cacheKey = String(component);
    const cached = SELECTOR_CACHE.get(cacheKey);

    // Check if cache is still valid (TTL + mtime match)
    if (cached) {
      const age = Date.now() - cached.loadedAt;
      if (age < SELECTOR_TTL) {
        // Verify mtime hasn't changed (external modification)
        try {
          const flatPath = path.join(this.basePath, `selectors-${component}-current.json`);
          const stat = fs.statSync(flatPath);
          if (stat.mtimeMs === cached.sourceMtime) return cached.data;
          // mtime changed — fall through to reload
          log(`Selector file mtime changed for ${component}, reloading`, 'DEBUG', 'selectors');
        } catch {
          // File doesn't exist at flat path — cache may still be valid if TTL ok
          return cached.data;
        }
      }
      // TTL expired or mtime changed — remove stale entry
      SELECTOR_CACHE.delete(cacheKey);
    }

    try {
      // Try flat filename first (selectors-{component}-current.json)
      const flatPath = path.join(this.basePath, `selectors-${component}-current.json`);
      let realPath: string | null = null;
      let fileStat: fs.Stats | null = null;

      try {
        realPath = fs.realpathSync(flatPath);
        fileStat = fs.statSync(realPath);
      } catch {
        // Fallback to directory-based path (component/current.json)
        try {
          const dirPath = path.join(this.basePath, component, 'current.json');
          realPath = fs.realpathSync(dirPath);
          fileStat = fs.statSync(realPath);
        } catch {
          // Neither path exists
        }
      }

      if (!realPath || !fileStat) throw new Error(`No selector file found for ${component}`);

      // BUG FIX (Response 19): Sanity check file size before parsing.
      // A corrupted or empty file could produce a huge or invalid JSON.
      if (fileStat.size > MAX_SELECTOR_FILE_SIZE) {
        log(`Selector file too large for ${component}: ${fileStat.size} bytes`, 'WARN', 'selectors');
        return this.getFallbackSelectors(component);
      }

      const raw = fs.readFileSync(realPath, 'utf8');
      const data = JSON.parse(raw);

      // Validate basic structure
      if (!data || typeof data !== 'object') {
        throw new Error(`Invalid selector data for ${component}: not an object`);
      }

      _evictIfNeeded();
      SELECTOR_CACHE.set(cacheKey, {
        data,
        loadedAt: Date.now(),
        sourceMtime: fileStat.mtimeMs,
      });
      log(`Loaded selectors: ${component} v${data.version || '?'}`, 'DEBUG', 'selectors');
      return data;
    } catch (err: any) {
      logError(`Failed to load selectors for ${component}`, err);
      return this.getFallbackSelectors(component);
    }
  }

  /**
   * Get hardcoded fallback selectors when file-based loading fails.
   */
  getFallbackSelectors(component: any) {
    const fallbacks: Record<string, any> = {
      'microsoft-login': {
        version: 'fallback',
        selectors: {
          emailInput: 'input[type="email"]',
          passwordInput: 'input[type="password"]',
          submitButton: 'button[type="submit"]',
          // BUG FIX (Response 19): Added more Microsoft-specific selectors
          emailInputAlt: 'input[name="loginfmt"]',
          passwordInputAlt: 'input[name="passwd"]',
          captchaContainer: '#idDiv_SAOTCS_Proofs',
          captchaImage: 'img[alt*="captcha"]',
          captchaInput: 'input[type="text"]',
        }
      },
      // BUG FIX (Response 19): Added mathu-app fallback selectors
      'mathu-app': {
        version: 'fallback',
        selectors: {
          watchButton: 'button:has-text("Watch")',
          startButton: 'button:has-text("Start")',
          nextButton: 'button:has-text("Next")',
          assignmentCard: '.module-card, [class*="card"]',
          progressBar: '[class*="progress"]',
        }
      }
    };
    return fallbacks[component] || { version: 'fallback', selectors: {} };
  }

  /**
   * Set the active version for a component's selectors.
   * Updates the 'current' symlink to point to the new version file.
   */
  setActiveVersion(component: any, version: any) {
    const flatVersionPath = path.join(this.basePath, `selectors-${component}-v${version}.json`);
    const flatCurrentPath = path.join(this.basePath, `selectors-${component}-current.json`);
    let versionFile: string | null = null;
    let currentLink: string | null = null;
    if (fs.existsSync(flatVersionPath)) {
      versionFile = flatVersionPath;
      currentLink = flatCurrentPath;
    } else {
      const componentPath = path.join(this.basePath, component);
      versionFile = path.join(componentPath, `v${version}.json`);
      currentLink = path.join(componentPath, 'current.json');
    }
    if (!fs.existsSync(versionFile)) throw new Error(`Version file not found: ${versionFile}`);
    let oldTarget: string | null = null;
    try { oldTarget = fs.readlinkSync(currentLink!); } catch { /* no existing link */ }
    try {
      if (fs.existsSync(currentLink)) fs.unlinkSync(currentLink);
      fs.symlinkSync(versionFile, currentLink);
      // BUG FIX (Response 19): Invalidate cache so next getSelectors
      // picks up the new version immediately.
      SELECTOR_CACHE.delete(String(component));
      log(`Updated ${component} to version ${version}`, 'INFO', 'selectors');
    } catch (err: any) {
      // Rollback: restore old symlink
      if (oldTarget) { try { fs.symlinkSync(oldTarget, currentLink!); } catch { /* best effort */ } }
      throw err;
    }
  }

  /**
   * Get all available version numbers for a component's selectors.
   * Checks both flat filenames and directory-based paths.
   */
  getAvailableVersions(component: any) {
    const versions = new Set<number>();
    // Try flat filenames first (selectors-{component}-v{N}.json)
    try {
      const files = fs.readdirSync(this.basePath);
      const prefix = `selectors-${component}-v`;
      for (const f of files) {
        if (f.startsWith(prefix) && f.endsWith('.json')) {
          const m = f.match(/v(\d+)\.json$/);
          if (m) versions.add(parseInt(m[1], 10));
        }
      }
    } catch { /* directory read failed */ }
    // Also check directory-based versions
    const componentPath = path.join(this.basePath, component);
    if (fs.existsSync(componentPath)) {
      try {
        const dirFiles = fs.readdirSync(componentPath);
        for (const f of dirFiles) {
          const m = f.match(/^v(\d+)\.json$/);
          if (m) versions.add(parseInt(m[1], 10));
        }
      } catch { /* directory read failed */ }
    }
    return [...versions].sort((a: number, b: number) => b - a);
  }

  /**
   * Get cache statistics for monitoring.
   * BUG FIX (Response 19): New method for diagnostics.
   */
  getCacheStats(): { size: number; max: number; entries: string[] } {
    return {
      size: SELECTOR_CACHE.size,
      max: MAX_CACHE_ENTRIES,
      entries: [...SELECTOR_CACHE.keys()],
    };
  }

  /**
   * Clear the selector cache.
   * BUG FIX (Response 19): New method for testing and recovery.
   */
  clearCache(): void {
    SELECTOR_CACHE.clear();
    log('Selector cache cleared', 'DEBUG', 'selectors');
  }
}

// ═════════════════════════════════════════════════════════════
// Fallback selector patterns when primary selectors fail
// ═════════════════════════════════════════════════════════════

const FALLBACK_SELECTORS: Record<string, string[]> = {
  'signin-button': [
    'button[type="submit"]',
    'input[type="submit"]',
    'button:has-text("Sign in")',
    'button:has-text("Log in")',
    'button:has-text("Login")',
    'a:has-text("Sign in")',
    '[data-testid="signin-button"]',
    '#signin-button',
    // BUG FIX (Response 19): Added more variations seen in the wild
    'button:has-text("Sign in with Microsoft")',
    'a:has-text("Sign in with Microsoft")',
    '[role="button"]:has-text("Sign in")',
  ],
  'email-input': [
    'input[type="email"]',
    'input[name="email"]',
    'input[name="loginfmt"]',
    'input[autocomplete="email"]',
    'input[autocomplete="username"]',
    '#i0116',
    // BUG FIX (Response 19): Added aria-label based selectors
    '[aria-label*="email" i]',
    '[aria-label*="Email" i]',
    '[placeholder*="email" i]',
  ],
  'password-input': [
    'input[type="password"]',
    'input[name="password"]',
    'input[name="passwd"]',
    'input[autocomplete="current-password"]',
    '#i0118',
    // BUG FIX (Response 19): Added aria-label based selectors
    '[aria-label*="password" i]',
    '[placeholder*="password" i]',
  ],
  'assignment-card': [
    '[data-testid="assignment-card"]',
    '.assignment-card',
    '.module-card',
    '[data-testid*="assignment"]',
    '[data-testid*="module"]',
    '[class*="assignment"]',
    '[class*="module"]',
    '[class*="card"]',
    // BUG FIX (Response 19): Added Flutter-specific selectors
    '[class*="card"][class*="module"]',
    '.flt-glass-pane [class*="card"]',
  ],
  'module-completion': [
    '[data-testid="completion-indicator"]',
    '.completion-indicator',
    '[class*="complete"]',
    '[class*="check"]',
    'svg[class*="check"]',
    // BUG FIX (Response 19): Added progress bar completion selectors
    '[class*="progress"][class*="100"]',
    '[role="progressbar"][aria-valuenow="100"]',
    'text*="100%"',
  ],
};

/**
 * Get selectors for a key, combining primary (from JSON files)
 * and fallback (from FALLBACK_SELECTORS) in priority order.
 *
 * BUG FIX (Response 19): Deduplicates selectors to avoid testing
 * the same selector twice via Playwright.
 */
function getSelectorsWithFallbacks(key: any) {
  const seen = new Set<string>();
  const result: string[] = [];

  // Primary selectors from JSON files (highest priority)
  try {
    const data = selectorManager.getSelectors(key);
    if (data?.selectors) {
      for (const [name, selector] of Object.entries(data.selectors)) {
        const s = String(selector);
        if (s && !seen.has(s)) {
          seen.add(s);
          result.push(s);
        }
      }
    }
  } catch (e: any) { /* fallback to static selectors only */ }

  // Fallback selectors (lower priority, deduplicated)
  const fallbacks = FALLBACK_SELECTORS[key] || [];
  for (const s of fallbacks) {
    if (!seen.has(s)) {
      seen.add(s);
      result.push(s);
    }
  }

  return result;
}

const selectorManager = new SelectorManager();
module.exports = { selectorManager, SelectorManager, getSelectorsWithFallbacks, FALLBACK_SELECTORS };
