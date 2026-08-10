'use strict';

// ═══════════════════════════════════════════════════════════════════════
// Screenshot Storage Service — Cloudinary-backed
// ═══════════════════════════════════════════════════════════════════════
// Stores screenshots on Cloudinary so they don't consume Render's
// limited memory/disk (free tier: 512MB RAM, ephemeral /tmp).
//
// Replaces the old S3/R2/GCS implementation.
//
// Environment Variables:
//   CLOUDINARY_CLOUD_NAME   — Cloud name (default: xlhumi67)
//   CLOUDINARY_API_KEY      — API key
//   CLOUDINARY_API_SECRET   — API secret
//   CLOUDINARY_FOLDER       — Folder prefix (default: 'mathu-bot/screenshots')
//   SCREENSHOT_STORAGE_ENABLED — Enable/disable (default: true)
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

let _initialized = false;
let _enabled = false;
let _cloudinary: any = null;
let _config: Record<string, any> = {};
let _uploadQueue: Array<{ buffer: Buffer; key: string; metadata?: Record<string, string> }> = [];
let _isUploading = false;
let _totalUploaded = 0;
let _totalFailed = 0;
let _totalBytes = 0;
let _rateLimitTokens = 10;
let _lastRefillTime = Date.now();
const MAX_QUEUE_SIZE = 50;
const RATE_LIMIT_PER_SECOND = 2;
const UPLOAD_TIMEOUT_MS = 30000;
const MAX_RETRY_ATTEMPTS = 2;

// LRU URL cache (bounded to prevent memory leaks)
const _urlCache = new Map<string, string>();
const MAX_URL_CACHE = 500;

function _log(msg: string, level: string = 'INFO') {
  try {
    const { container } = require('./container');
    const logger = container.get('logger', { required: false });
    logger?.log?.(msg, level, 'screenshot-storage');
  } catch {
    console.log(`[screenshot-storage] ${level}: ${msg}`);
  }
}

function _logError(msg: string, err: any) {
  try {
    const { container } = require('./container');
    const logger = container.get('logger', { required: false });
    logger?.logError?.(msg, err, {});
  } catch {
    console.error(`[screenshot-storage] ERROR: ${msg}`, err);
  }
}

// ── Token bucket rate limiter ──
function _refillTokens() {
  const now = Date.now();
  const elapsed = (now - _lastRefillTime) / 1000;
  _rateLimitTokens = Math.min(10, _rateLimitTokens + elapsed * RATE_LIMIT_PER_SECOND);
  _lastRefillTime = now;
}

function _consumeToken(): boolean {
  _refillTokens();
  if (_rateLimitTokens >= 1) {
    _rateLimitTokens -= 1;
    return true;
  }
  return false;
}

// ── LRU cache helper ──
function _cacheSet(key: string, value: string) {
  if (_urlCache.has(key)) _urlCache.delete(key);
  if (_urlCache.size >= MAX_URL_CACHE) {
    const firstKey = _urlCache.keys().next().value;
    _urlCache.delete(firstKey);
  }
  _urlCache.set(key, value);
}

function _cacheGet(key: string): string | undefined {
  if (!_urlCache.has(key)) return undefined;
  const value = _urlCache.get(key)!;
  _urlCache.delete(key);
  _urlCache.set(key, value);
  return value;
}

// ── Initialize ──
function init(): { enabled: boolean; backend: string } {
  // Try to load cloudinary
  try {
    _cloudinary = require('cloudinary').v2;
  } catch (e: any) {
    _log(`cloudinary module not available: ${e.message} — install with 'npm i cloudinary'`, 'WARN');
    _initialized = true;
    return { enabled: false, backend: 'none' };
  }

  // Read config from env (same keys as config.ts envalid)
  const cloudName = process.env.CLOUDINARY_CLOUD_NAME || 'xlhumi67';
  const apiKey = process.env.CLOUDINARY_API_KEY || '';
  const apiSecret = process.env.CLOUDINARY_API_SECRET || '';

  if (!apiKey || !apiSecret) {
    _log('CLOUDINARY_API_KEY and/or CLOUDINARY_API_SECRET not set. Screenshots will NOT be uploaded.', 'WARN');
    _log('Set CLOUDINARY_API_SECRET in Render dashboard (sensitive).', 'WARN');
    _initialized = true;
    return { enabled: false, backend: 'none' };
  }

  _cloudinary.config({
    cloud_name: cloudName,
    api_key: apiKey,
    api_secret: apiSecret,
    secure: true,
  });

  _config = {
    cloudName,
    folder: process.env.CLOUDINARY_FOLDER || 'mathu-bot/screenshots',
    enabled: process.env.SCREENSHOT_STORAGE_ENABLED !== 'false',
  };

  _enabled = _config.enabled;
  _initialized = true;

  _log(`Cloudinary screenshot storage enabled: cloud=${cloudName} folder=${_config.folder}`, 'INFO');
  return { enabled: true, backend: 'cloudinary' };
}

/**
 * Build a Cloudinary public ID from category and metadata.
 * Format: {folder}/{category}/{date}/{time}-{hash}.{ext}
 */
function _buildKey(category: string, metadata?: Record<string, string>): string {
  const now = new Date();
  const dateStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const timeStr = `${String(now.getHours()).padStart(2, '0')}-${String(now.getMinutes()).padStart(2, '0')}-${String(now.getSeconds()).padStart(2, '0')}`;
  const hash = crypto.randomBytes(4).toString('hex');
  const ext = metadata?.format === 'jpeg' ? 'jpg' : 'png';
  return `${_config.folder || 'mathu-bot/screenshots'}${category}/${dateStr}/${timeStr}-${hash}.${ext}`;
}

/**
 * Upload a screenshot to Cloudinary.
 * Returns the storage key on success, or null on failure.
 *
 * @param screenshotBuf - PNG/JPEG buffer
 * @param category - Category tag (e.g. 'training', 'cycle', 'tombstone')
 * @param metadata - Optional metadata (sample_id, state, provider, etc.)
 */
async function uploadScreenshot(
  screenshotBuf: Buffer,
  category: string,
  metadata?: Record<string, string>
): Promise<{ key: string; url?: string } | null> {
  if (!_initialized || !_enabled) return null;
  if (!screenshotBuf || screenshotBuf.length < 100) return null;
  if (!_cloudinary) return null;

  const key = _buildKey(category, metadata);

  // Rate limit check
  if (!_consumeToken()) {
    if (_uploadQueue.length < MAX_QUEUE_SIZE) {
      _uploadQueue.push({ buffer: screenshotBuf, key, metadata });
    }
    return null;
  }

  return _doUpload(screenshotBuf, category, key, metadata);
}

async function _doUpload(
  screenshotBuf: Buffer,
  category: string,
  key: string,
  metadata?: Record<string, string>,
  attempt: number = 0
): Promise<{ key: string; url?: string } | null> {
  try {
    // Build Cloudinary tags from metadata
    const tags: string[] = ['mathu-bot', `category:${category}`];
    if (metadata?.state) tags.push(`state:${metadata.state}`);
    if (metadata?.provider) tags.push(`provider:${metadata.provider}`);
    if (metadata?.priority === 'high') tags.push('priority:high');
    if (metadata?.fingerprint) tags.push(`fp:${metadata.fingerprint.substring(0, 16)}`);

    const result = await _cloudinary.uploader.upload(
      `data:image/png;base64,${screenshotBuf.toString('base64')}`,
      {
        public_id: key.replace(/\.[^.]+$/, ''), // Remove extension for Cloudinary
        tags,
        resource_type: 'image',
        format: metadata?.format === 'jpeg' ? 'jpg' : 'auto',
        overwrite: false,
        // Eager thumbnail for quick preview
        eager: [{ width: 300, crop: 'limit', fetch_format: 'auto', quality: 'auto' }],
        eager_async: true,
      }
    );

    _totalUploaded++;
    _totalBytes += screenshotBuf.length;

    const publicUrl = result.secure_url || result.url;
    if (publicUrl) _cacheSet(key, publicUrl);

    _log(`Uploaded: ${key} (${(screenshotBuf.length / 1024).toFixed(1)}KB)`, 'DEBUG');
    return { key, url: publicUrl };
  }
  catch (err: any) {
    _totalFailed++;
    _log(`Upload failed (attempt ${attempt + 1}/${MAX_RETRY_ATTEMPTS + 1}): ${err.message || err}`, 'WARN');

    // Retry with backoff
    if (attempt < MAX_RETRY_ATTEMPTS) {
      const { sleep } = require('./utils-sleep');
      await sleep(1000 * Math.pow(2, attempt));
      return _doUpload(screenshotBuf, category, key, metadata, attempt + 1);
    }

    return null;
  }
}

/**
 * Generate a public URL for a stored screenshot.
 * Uses Cloudinary transformation URLs (auto-format, auto-quality).
 */
function getPublicUrl(key: string): string | null {
  // Check cache first
  const cached = _cacheGet(key);
  if (cached) return cached;

  if (!_cloudinary) return null;
  try {
    const publicId = key.replace(/\.[^.]+$/, '');
    const url = _cloudinary.url(publicId, {
      fetch_format: 'auto',
      quality: 'auto',
      secure: true,
    });
    _cacheSet(key, url);
    return url;
  } catch { return null; }
}

/**
 * Get a transformed URL with custom transformations.
 */
function getTransformUrl(
  key: string,
  transforms: { width?: number; height?: number; crop?: string; quality?: string } = {}
): string | null {
  if (!_cloudinary) return null;
  try {
    const publicId = key.replace(/\.[^.]+$/, '');
    return _cloudinary.url(publicId, {
      width: transforms.width,
      height: transforms.height,
      crop: transforms.crop || 'limit',
      fetch_format: 'auto',
      quality: transforms.quality || 'auto',
      secure: true,
    });
  } catch { return null; }
}

/**
 * Search screenshots by tag expression.
 */
async function searchScreenshots(
  tagExpression: string,
  options: { maxResults?: number; direction?: 'desc' | 'asc' } = {}
): Promise<Array<{ publicId: string; url: string; createdAt: string; tags: string[] }>> {
  if (!_initialized || !_cloudinary) return [];
  try {
    const result = await _cloudinary.search
      .expression(tagExpression)
      .sort_by('created_at', options.direction || 'desc')
      .max_results(options.maxResults || 30)
      .execute();
    return (result.resources || []).map((r: any) => ({
      publicId: r.public_id,
      url: r.secure_url,
      createdAt: r.created_at,
      tags: r.tags || [],
    }));
  } catch (err: any) {
    _log(`Search failed: ${err.message || err}`, 'ERROR');
    return [];
  }
}

/**
 * Delete screenshots by prefix.
 */
async function deleteByPrefix(prefix: string): Promise<number> {
  if (!_initialized || !_cloudinary) return 0;
  try {
    const result = await _cloudinary.api.delete_resources_by_prefix(prefix);
    const deleted = result?.deleted?.length || 0;
    _log(`Deleted ${deleted} screenshots with prefix: ${prefix}`, 'INFO');
    return deleted;
  } catch (err: any) {
    _log(`Delete by prefix failed: ${err.message || err}`, 'ERROR');
    return 0;
  }
}

/**
 * Delete a single screenshot by key.
 */
async function deleteScreenshot(key: string): Promise<boolean> {
  if (!_initialized || !_cloudinary) return false;
  try {
    const publicId = key.replace(/\.[^.]+$/, '');
    const result = await _cloudinary.uploader.destroy(publicId);
    return result?.result === 'ok';
  } catch (err: any) {
    _log(`Delete failed: ${err.message || err}`, 'ERROR');
    return false;
  }
}

/**
 * Process queued uploads.
 */
async function flushQueue(): Promise<{ uploaded: number; failed: number }> {
  if (_isUploading || _uploadQueue.length === 0) return { uploaded: 0, failed: 0 };
  _isUploading = true;

  let uploaded = 0;
  let failed = 0;

  while (_uploadQueue.length > 0) {
    if (!_consumeToken()) {
      const { sleep } = require('./utils-sleep');
      await sleep(500);
      continue;
    }

    const item = _uploadQueue.shift()!;
    const result = await _doUpload(item.buffer, '', item.key, item.metadata);
    if (result) uploaded++;
    else failed++;
  }

  _isUploading = false;
  return { uploaded, failed };
}

/**
 * Get storage statistics.
 */
function getStatus(): {
  enabled: boolean;
  backend: string;
  totalUploaded: number;
  totalFailed: number;
  totalBytesMB: number;
  queueSize: number;
  prefix: string;
  cacheSize: number;
} {
  return {
    enabled: _enabled,
    backend: _enabled ? 'cloudinary' : 'none',
    totalUploaded: _totalUploaded,
    totalFailed: _totalFailed,
    totalBytesMB: Math.round(_totalBytes / 1024 / 1024 * 100) / 100,
    queueSize: _uploadQueue.length,
    prefix: _config.folder || 'mathu-bot/screenshots/',
    cacheSize: _urlCache.size,
  };
}

/**
 * Check if external storage is enabled and configured.
 */
function isEnabled(): boolean {
  return _initialized && _enabled;
}

/**
 * Get the configured prefix for building keys externally.
 */
function getPrefix(): string {
  return _config.folder || 'mathu-bot/screenshots/';
}

/**
 * Clear the in-memory URL cache.
 */
function clearCache(): void {
  _urlCache.clear();
  _log('URL cache cleared', 'DEBUG');
}

/**
 * DI injection hook — called by container-modules.ts during initialization.
 */
function _injectDependencies(deps: Record<string, any>) {
  // No-op: this module uses lazy require() and process.env
}

module.exports = {
  init,
  uploadScreenshot,
  getPublicUrl,
  getTransformUrl,
  searchScreenshots,
  deleteByPrefix,
  deleteScreenshot,
  flushQueue,
  getStatus,
  isEnabled,
  getPrefix,
  clearCache,
  _injectDependencies,
};
