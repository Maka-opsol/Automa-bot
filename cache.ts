'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { PROJECT_ROOT } = require('./project-root');

// Use USER_DATA_DIR (set by render-free-plan.ts to /tmp/.browser-data) instead
// of PROJECT_ROOT (/app/) which is read-only in Docker.
function getDataDir() { return process.env.USER_DATA_DIR || path.join(os.tmpdir(), '.browser-data'); }

let _deps: Record<string, any> = {};
let screenshotCache: any = null;
let visionResponseCache: any = null;

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
  const CONFIG = deps.config || {};
  const { LRUCache } = require('lru-cache');
  if (!screenshotCache) {
    screenshotCache = new LRUCache({
      max: 20,
      ttl: CONFIG.SCREENSHOT_CACHE_TTL_MS || 5000,
      // v6-fix: Screenshot cache reduced from 50MB to 10MB (screenshots are large base64 blobs)
      maxSize: 10 * 1024 * 1024,
      sizeCalculation: (value: any) => { return JSON.stringify(value).length * 2; },
      dispose: (_key: any, value: any) => { if (value?.screenshot) { delete value.screenshot; } }
    });
  }
  // v6-fix: Vision cache reduced from 200MB to 20MB. On 512MB total RAM (Render free),
  // 200MB for cache alone + Chromium (~200-300MB) + Node.js heap = guaranteed OOM.
  // 20MB is sufficient: LRU evicts least-recently-used, and vision responses
  // are re-requested cheaply (cached at provider level). The 5-min TTL also
  // ensures entries don't linger long.
  if (!visionResponseCache) {
    visionResponseCache = new LRUCache({
      max: 50,
      ttl: 5 * 60 * 1000,
      maxSize: 20 * 1024 * 1024,
      sizeCalculation: (value: any) => { return JSON.stringify(value).length * 2; }
    });
  }
  // Run stale file cleanup now that deps are available
  cleanupStaleFiles();
}

function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getScreenshotCacheKey(base64: any) { 
  if (!base64 || typeof base64 !== 'string') throw new Error('Invalid screenshot data for caching');
  return crypto.createHash('sha256').update(base64).digest('hex');
}

function getCachedAction(base64: any) { 
  if (!base64 || typeof base64 !== 'string') return null;
  try {
    const key = getScreenshotCacheKey(base64);
    const entry = screenshotCache.get(key);
    if (entry) { log('Using cached action result', 'DEBUG', 'cache'); return JSON.parse(JSON.stringify(entry)); }
    return null;
  } catch (err: any) { logError('Cache lookup failed', err); return null; }
}

function setCachedAction(base64: any, action: any) { 
  if (!base64 || typeof base64 !== 'string') return;
  if (!action || typeof action !== 'object') return;
  try {
    const key = getScreenshotCacheKey(base64);
    if (!action.actionType || typeof action.actionType !== 'string') { log('Invalid action structure for cache', 'WARN', 'cache'); return; }
    const actionCopy = JSON.parse(JSON.stringify(action));
    screenshotCache.set(key, actionCopy);
  } catch (err: any) { logError('Cache set failed', err); }
}

function getCachedVisionResponse(prompt: any, base64: any) { 
  if (!prompt || !base64) return null;
  try {
    const imgHash = crypto.createHash('sha256').update(base64).digest('hex').substring(0, 32);
    const key = crypto.createHash('sha256').update(prompt + imgHash).digest('hex');
    return visionResponseCache.get(key);
  } catch { return null; }
}

function setCachedVisionResponse(prompt: any, base64: any, response: any) { 
  if (!prompt || !base64 || !response) return;
  try {
    const imgHash = crypto.createHash('sha256').update(base64).digest('hex').substring(0, 32);
    const key = crypto.createHash('sha256').update(prompt + imgHash).digest('hex');
    visionResponseCache.set(key, response);
  } catch {}
}

function clearCache() {  try { const oldSize = screenshotCache.size; screenshotCache.clear(); visionResponseCache.clear(); log(`Screenshot cache cleared (${oldSize} entries)`, 'DEBUG', 'cache'); } catch (err: any) { logError('Cache clear failed', err); } }

function getCacheStats() {  if (!screenshotCache || !visionResponseCache) return { size: 0, maxSize: 0, calculatedSize: 0, visionSize: 0 }; return { size: screenshotCache.size, maxSize: screenshotCache.max, calculatedSize: screenshotCache.calculatedSize, visionSize: visionResponseCache.size }; }

const SESSION_FILE = path.join(getDataDir(), 'session.json');
const SESSION_LOCK_FILE = SESSION_FILE + '.lock';

async function acquireLock(lockPath: any, timeoutMs = 5000) { 
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { fs.writeFileSync(lockPath, process.pid.toString(), { flag: 'wx' }); return true; } catch (err: any) {
      if (err.code === 'EEXIST') {
        try {
          const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
          if (lockAge > 30000) {
            try { fs.unlinkSync(lockPath); } catch (unlinkErr: any) { /* lock was just removed by another process, retry on next loop iteration */ }
          }
        } catch {}
        const backoff = Math.min(100, (Date.now() - start) / 10);
        // Backoff wait — single sleep instead of spin-loop
        await new Promise(r => setTimeout(r, backoff));
      } else { return false; }
    }
  }
  return false;
}

function releaseLock(lockPath: any) {  try { fs.unlinkSync(lockPath); } catch {} }

function loadSession() { 
  try {
    if (!fs.existsSync(SESSION_FILE)) return null;
    const stat = fs.statSync(SESSION_FILE);
    if (stat.size > 10 * 1024 * 1024) { log('Session file too large, ignoring', 'WARN', 'cache'); return null; }
    const data = fs.readFileSync(SESSION_FILE, 'utf8');
    const parsed = JSON.parse(data);
    if (!parsed || typeof parsed !== 'object') { log('Session file has invalid root type', 'WARN', 'cache'); return null; }
    if (!parsed.cookies && !parsed.origins) { log('Session file missing required fields', 'WARN', 'cache'); return null; }
    if (parsed.cookies && !Array.isArray(parsed.cookies)) { log('Session cookies is not an array', 'WARN', 'cache'); return null; }
    if (Array.isArray(parsed.cookies)) {
      const validCookies = parsed.cookies.filter((cookie: any) => { return cookie && typeof cookie === 'object' && typeof cookie.name === 'string' && typeof cookie.value === 'string' && typeof cookie.domain === 'string'; });
      if (validCookies.length !== parsed.cookies.length) { log(`Filtered ${parsed.cookies.length - validCookies.length} invalid cookies`, 'WARN', 'cache'); parsed.cookies = validCookies; }
    }
    return parsed;
  } catch (err: any) { if (err instanceof SyntaxError) { log('Session file contains invalid JSON', 'WARN', 'cache'); } else { logError('Failed to load session', err); } return null; }
}

async function saveSession(storage: any) { 
  if (!storage || typeof storage !== 'object') { log('Invalid session data for saving', 'WARN', 'cache'); return false; }
  const tmpFile = SESSION_FILE + '.tmp.' + process.pid;
  try {
    if (!await acquireLock(SESSION_LOCK_FILE)) { log('Could not acquire session lock', 'WARN', 'cache'); return false; }
    try {
      const jsonData = JSON.stringify(storage, null, 2);
      if (jsonData.length > 10 * 1024 * 1024) { log('Session data too large to save', 'WARN', 'cache'); return false; }
      fs.writeFileSync(tmpFile, jsonData, { encoding: 'utf8', mode: 0o600 });
      fs.renameSync(tmpFile, SESSION_FILE);
      log('Session saved successfully', 'INFO', 'cache');
      return true;
    } finally { releaseLock(SESSION_LOCK_FILE); }
  } catch (err: any) { logError('Failed to save session', err); try { fs.unlinkSync(tmpFile); } catch {} return false; }
}

function addCompletedModule(moduleName: any) { 
  if (!moduleName || typeof moduleName !== 'string') { log('Invalid module name for completion', 'WARN', 'cache'); return false; }
  const sanitizedName = moduleName.trim().substring(0, 500);
  if (!sanitizedName) { log('Empty module name after sanitization', 'WARN', 'cache'); return false; }
  try {
    // R6: Write to local (sync) + Turso (async via unifiedDb)
    _deps.database?.insertModule?.(sanitizedName);
    if (_deps.unifiedDb) {
      _deps.unifiedDb.saveModule(sanitizedName).catch(() => {});
    }
    log(`Marked module as completed: "${sanitizedName.substring(0, 50)}..."`, 'INFO', 'cache'); return true;
  } catch (err: any) { logError('Failed to save completed module', err, { moduleName: sanitizedName.substring(0, 50) }); return false; }
}

function isModuleCompleted(moduleName: any) { 
  if (!moduleName || typeof moduleName !== 'string') return false;
  // R6: Check local first (fast), Turso serves as backup
  try { return !!_deps.database?.selectModule?.(moduleName.trim().substring(0, 500)); } catch (err: any) { logError('Failed to check module completion', err); return false; }
}

async function loadCompletedModulesAsync() { 
  // R6: Try Turso first for authoritative data, fall back to local
  if (_deps.unifiedDb) {
    try {
      const tursoModules = await _deps.unifiedDb.getAllModules();
      if (tursoModules.length > 0) return tursoModules;
    } catch {}
  }
  try { return _deps.database?.getAllModules?.() || []; } catch (err: any) { logError('Failed to load completed modules', err); return []; }
}

function loadCompletedModules() {  try { return _deps.database?.getAllModules?.() || []; } catch (err: any) { logError('Failed to load completed modules', err); return []; } }

function cleanupStaleFiles() { 
  try {
    const dir = path.dirname(SESSION_FILE);
    const baseName = path.basename(SESSION_FILE); // e.g. 'session.json'
    const files = fs.readdirSync(dir);
    for (const file of files) {
      // Match: session.json.lock, session.json.tmp.<pid>, session.json.tmp.*
      const isLockOrTemp = file === baseName + '.lock' || file.startsWith(baseName + '.tmp.');
      if (!isLockOrTemp) continue;
      try {
        const filePath = path.join(dir, file);
        const stat = fs.statSync(filePath);
        const age = Date.now() - stat.mtimeMs;
        if (age > 3600000) { fs.unlinkSync(filePath); log(`Cleaned up stale file: ${file}`, 'DEBUG', 'cache'); }
      } catch {}
    }
  } catch (err: any) {}
}

module.exports = {
  getCachedAction,
  setCachedAction,
  getCachedVisionResponse,
  setCachedVisionResponse,
  clearCache,
  getCacheStats,
  loadSession,
  saveSession,
  addCompletedModule,
  isModuleCompleted,
  loadCompletedModules,
  loadCompletedModulesAsync,
  cleanupStaleFiles,
  _injectDependencies,
};
