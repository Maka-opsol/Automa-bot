'use strict';
// Last modified: 2026-08-08 — Response 6: /tmp disk guardian

// ═══════════════════════════════════════════════════════════════════════════════
// /tmp Disk Guardian — Prevents /tmp from filling up (silent killer)
//
// /tmp is typically 500 MB on Render free tier. If it fills, writes fail
// silently — rate limiter state, screenshots, DB checkpoints all corrupted.
// This module monitors usage and prunes files before that happens.
//
// Pruning tiers:
//   > 70% usage: prune oldest screenshots (by mtime)
//   > 85% usage: aggressive — delete ALL screenshots, logs, temp files
//   > 95% usage: emergency — clear /tmp entirely (except protected files)
//
// Protected files (never deleted):
//   - openrouter-rate-limit.json (rate limiter state)
//   - mathpix-rate-limit.json (Mathpix budget state)
//   - render-last-seen.json (cold start detection)
//   - checkpoint.json (cycle progress)
//   - *.db (SQLite databases)
//
// File type categorization:
//   Screenshots: /tmp/screenshot-*.png, /tmp/mathu-logs/screenshots/*.png
//   Logs:        /tmp/*.log, /tmp/mathu-logs/*.log
//   State:       /tmp/*.json (protected)
//   Dumps:       /tmp/*.dmp (always safe to delete)
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

// ─── Configuration ──────────────────────────────────────────────────────────

const TMP_DIR = os.tmpdir();
const CHECK_INTERVAL_MS = parseInt(process.env.TMP_GUARDIAN_INTERVAL_MS || '120000', 10); // 2 min (was 5 min)
const THRESHOLD_WARN = parseFloat(process.env.TMP_GUARDIAN_WARN || '0.60');     // 60% (was 70%)
const THRESHOLD_AGGRESSIVE = parseFloat(process.env.TMP_GUARDIAN_AGGRESSIVE || '0.75'); // 75% (was 85%)
const THRESHOLD_EMERGENCY = parseFloat(process.env.TMP_GUARDIAN_EMERGENCY || '0.90'); // 90% (was 95%)

// Protected file patterns (never deleted, even in emergency)
const PROTECTED_PATTERNS = [
  'openrouter-rate-limit.json',
  'mathpix-rate-limit.json',
  'render-last-seen.json',
  'checkpoint.json',
  'last-state.json',
  'state.json',
];

// ─── State ──────────────────────────────────────────────────────────────────

let _timer: ReturnType<typeof setInterval> | null = null;
let _running = false;

interface DiskUsage {
  totalBytes: number;
  usedBytes: number;
  freeBytes: number;
  usagePct: number;  // 0-1
}

interface PruneResult {
  before: DiskUsage;
  after: DiskUsage;
  freedBytes: number;
  filesDeleted: number;
  level: 'none' | 'warn' | 'aggressive' | 'emergency';
}

let _lastPrune: PruneResult | null = null;
let _stats = {
  checks: 0,
  prunes: 0,
  totalFreedBytes: 0,
  totalFilesDeleted: 0,
};

function getStats() {
  return {
    ..._stats,
    lastPrune: _lastPrune ? {
      freedBytes: _lastPrune.freedBytes,
      filesDeleted: _lastPrune.filesDeleted,
      level: _lastPrune.level,
      usagePctBefore: _lastPrune.before.usagePct,
      usagePctAfter: _lastPrune.after.usagePct,
    } : null,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Disk Usage Detection
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get disk usage for /tmp using statfs (Node.js >= 18.15)
 * or df command as fallback.
 */
function getDiskUsage(): DiskUsage {
  try {
    // Node.js 18.15+ has fs.statfs
    if (typeof fs.statfs === 'function') {
      const stats = fs.statfs(TMP_DIR);
      const totalBytes = stats.bavail * stats.bsize;
      const freeBytes = stats.bfree * stats.bsize;
      const usedBytes = (stats.blocks - stats.bfree) * stats.bsize;
      const usagePct = stats.blocks > 0 ? (stats.blocks - stats.bfree) / stats.blocks : 0;
      return { totalBytes, usedBytes, freeBytes, usagePct };
    }
  } catch { /* statfs not available, try fallback */ }

  // Fallback: try to read from /proc or use directory listing heuristic
  try {
    // On Linux, we can parse /proc/mounts or check df
    const { execSync } = require('child_process');
    const output = execSync(`df -B1 ${TMP_DIR} 2>/dev/null | tail -1`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    const parts = output.trim().split(/\s+/);
    if (parts.length >= 6) {
      const totalBytes = parseInt(parts[1], 10);
      const usedBytes = parseInt(parts[2], 10);
      const freeBytes = parseInt(parts[3], 10);
      const usagePct = totalBytes > 0 ? usedBytes / totalBytes : 0;
      return { totalBytes, usedBytes, freeBytes, usagePct };
    }
  } catch { /* df not available */ }

  // Last resort: estimate from directory listing
  return _estimateDiskUsage();
}

/**
 * Estimate disk usage by walking /tmp and summing file sizes.
 * Less accurate than statfs but works everywhere.
 */
function _estimateDiskUsage(): DiskUsage {
  const ASSUMED_TOTAL = 500 * 1024 * 1024; // Assume 500MB for /tmp
  let usedBytes = 0;

  try {
    _walkDir(TMP_DIR, (filePath) => {
      try {
        const stat = fs.statSync(filePath);
        if (stat.isFile()) usedBytes += stat.size;
      } catch { /* skip */ }
    });
  } catch { /* skip */ }

  const freeBytes = Math.max(0, ASSUMED_TOTAL - usedBytes);
  return {
    totalBytes: ASSUMED_TOTAL,
    usedBytes,
    freeBytes,
    usagePct: ASSUMED_TOTAL > 0 ? usedBytes / ASSUMED_TOTAL : 0,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// File Discovery
// ═══════════════════════════════════════════════════════════════════════════

type FileCallback = (filePath: string, stat: fs.Stats) => void;

/**
 * Recursively walk a directory, calling callback for each file.
 * Skips protected files and .db files.
 */
function _walkDir(dir: string, callback: FileCallback, recursive: boolean = true) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      // Skip protected files
      if (_isProtected(fullPath)) continue;

      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile()) {
          callback(fullPath, stat);
        } else if (stat.isDirectory() && recursive) {
          // Don't recurse into .git or node_modules
          if (entry.name !== '.git' && entry.name !== 'node_modules') {
            _walkDir(fullPath, callback, recursive);
          }
        }
      } catch { /* skip inaccessible */ }
    }
  } catch { /* skip unreadable directory */ }
}

function _isProtected(filePath: string): boolean {
  const basename = path.basename(filePath);
  // Protected JSON files
  if (PROTECTED_PATTERNS.includes(basename)) return true;
  // Database files
  if (basename.endsWith('.db') || basename.endsWith('.db-wal') || basename.endsWith('.db-shm')) return true;
  // Lock files
  if (basename.endsWith('.lock')) return true;
  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// Pruning
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get all deletable files sorted by mtime (oldest first).
 */
function _getDeletableFiles(): Array<{ path: string; mtime: number; size: number }> {
  const files: Array<{ path: string; mtime: number; size: number }> = [];

  _walkDir(TMP_DIR, (filePath, stat) => {
    files.push({ path: filePath, mtime: stat.mtimeMs, size: stat.size });
  });

  // Sort by mtime ascending (oldest first)
  files.sort((a, b) => a.mtime - b.mtime);
  return files;
}

/**
 * Determine pruning level based on current disk usage.
 */
function _getPruneLevel(usagePct: number): 'none' | 'warn' | 'aggressive' | 'emergency' {
  if (usagePct >= THRESHOLD_EMERGENCY) return 'emergency';
  if (usagePct >= THRESHOLD_AGGRESSIVE) return 'aggressive';
  if (usagePct >= THRESHOLD_WARN) return 'warn';
  return 'none';
}

/**
 * Prune /tmp based on current usage level.
 * Returns PruneResult with before/after stats.
 */
function prune(): PruneResult {
  if (_running) {
    return { before: getDiskUsage(), after: getDiskUsage(), freedBytes: 0, filesDeleted: 0, level: 'none' };
  }

  _running = true;
  const before = getDiskUsage();
  let filesDeleted = 0;
  let freedBytes = 0;

  try {
    const level = _getPruneLevel(before.usagePct);

    if (level === 'none') {
      _running = false;
      return { before, after: before, freedBytes: 0, filesDeleted: 0, level: 'none' };
    }

    const deletableFiles = _getDeletableFiles();

    if (level === 'warn') {
      // Prune ALL non-protected files (oldest first) until below target
      const targetPct = THRESHOLD_WARN - 0.10; // Target 50%
      let freedSoFar = 0;

      for (const file of deletableFiles) {
        if (before.usagePct - (freedSoFar + file.size) / before.totalBytes < targetPct) break;
        // Delete ANYTHING not protected (was: only screenshots + browser cache)
        if (_isProtected(file.path)) continue;

        try {
          fs.unlinkSync(file.path);
          freedBytes += file.size;
          freedSoFar += file.size;
          filesDeleted++;
        } catch { /* skip */ }
      }

      // Also clean Chromium cache dirs directly (biggest space hogs)
      const userDataDir = path.join(TMP_DIR, '.browser-data');
      if (fs.existsSync(userDataDir)) {
        const cacheDirs = ['Default/Cache', 'Default/Code Cache', 'Default/Service Worker/CacheStorage',
          'Default/GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache',
          'Default/Session Storage', 'Default/Local Storage/leveldb', 'Default/IndexedDB'];
        for (const cacheDir of cacheDirs) {
          try {
            const cachePath = path.join(userDataDir, cacheDir);
            if (fs.existsSync(cachePath)) {
              const size = _dirSize(cachePath);
              if (size > 0) {
                _rmrf(cachePath);
                freedBytes += size;
                filesDeleted++;
              }
            }
          } catch { /* skip */ }
        }
      }

      log(`/tmp guardian WARN prune: ${filesDeleted} files freed ${_formatBytes(freedBytes)} (usage: ${(before.usagePct * 100).toFixed(1)}% -> target ${(targetPct * 100).toFixed(0)}%)`, 'WARN', 'tmp-guardian');
    } else if (level === 'aggressive') {
      // Delete ALL screenshots, logs, dumps — keep only state/DB
      for (const file of deletableFiles) {
        if (_isProtected(file.path)) continue;
        if (file.path.endsWith('.db') || file.path.endsWith('.db-wal') || file.path.endsWith('.db-shm')) continue;

        try {
          fs.unlinkSync(file.path);
          freedBytes += file.size;
          filesDeleted++;
        } catch { /* skip */ }
      }

      log(`/tmp guardian AGGRESSIVE prune: ${filesDeleted} files freed ${_formatBytes(freedBytes)} (usage: ${(before.usagePct * 100).toFixed(1)}%)`, 'ERROR', 'tmp-guardian');
    } else {
      // EMERGENCY: delete everything except protected files
      for (const file of deletableFiles) {
        try {
          fs.unlinkSync(file.path);
          freedBytes += file.size;
          filesDeleted++;
        } catch { /* skip */ }
      }

      // Also try to clean up empty directories
      try {
        _cleanEmptyDirs(TMP_DIR);
      } catch { /* non-critical */ }

      log(`/tmp guardian EMERGENCY prune: ${filesDeleted} files freed ${_formatBytes(freedBytes)} (usage: ${(before.usagePct * 100).toFixed(1)}%)`, 'CRITICAL', 'tmp-guardian');
    }

    const after = getDiskUsage();
    const result: PruneResult = { before, after, freedBytes, filesDeleted, level };

    _lastPrune = result;
    _stats.prunes++;
    _stats.totalFreedBytes += freedBytes;
    _stats.totalFilesDeleted += filesDeleted;

    _running = false;
    return result;
  } catch (e: any) {
    logError('/tmp guardian prune failed', e);
    _running = false;
    return { before, after: before, freedBytes: 0, filesDeleted: 0, level: 'none' };
  }
}

function _isScreenshot(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.webp';
}

function _isBrowserCache(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  return normalized.includes('/Cache') || normalized.includes('/GPUCache') ||
         normalized.includes('/ShaderCache') || normalized.includes('/Crashpad');
}

function _dirSize(dir: string): number {
  let total = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        const s = fs.statSync(full);
        if (s.isFile()) total += s.size;
        else if (s.isDirectory()) total += _dirSize(full);
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

function _rmrf(dir: string): void {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      try {
        if (e.isFile()) fs.unlinkSync(full);
        else if (e.isDirectory()) { _rmrf(full); fs.rmdirSync(full); }
      } catch { /* skip */ }
    }
    fs.rmdirSync(dir);
  } catch { /* skip */ }
}

function _cleanEmptyDirs(dir: string) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'node_modules') {
      _cleanEmptyDirs(fullPath);
      try {
        // If directory is now empty, remove it
        const remaining = fs.readdirSync(fullPath);
        if (remaining.length === 0) {
          fs.rmdirSync(fullPath);
        }
      } catch { /* skip */ }
    }
  }
}

function _formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

// ═══════════════════════════════════════════════════════════════════════════
// Periodic Check
// ═══════════════════════════════════════════════════════════════════════════

function check() {
  _stats.checks++;
  const usage = getDiskUsage();
  const level = _getPruneLevel(usage.usagePct);

  if (level === 'none') {
    // Log usage at DEBUG level when healthy
    if (_stats.checks % 12 === 0) { // Every hour (12 * 5min)
      log(`/tmp guardian: usage ${(usage.usagePct * 100).toFixed(1)}% (${_formatBytes(usage.usedBytes)} / ${_formatBytes(usage.totalBytes)})`, 'DEBUG', 'tmp-guardian');
    }
    return;
  }

  // Prune
  const result = prune();
  log(`/tmp guardian check #${_stats.checks}: level=${result.level}, deleted=${result.filesDeleted}, freed=${_formatBytes(result.freedBytes)}`, 'INFO', 'tmp-guardian');
}

// ═══════════════════════════════════════════════════════════════════════════
// Lifecycle
// ═══════════════════════════════════════════════════════════════════════════

function start() {
  if (_timer) return; // Already running

  // Immediate first check
  check();

  // Periodic check
  _timer = setInterval(() => {
    try {
      check();
    } catch (e: any) {
      logError('/tmp guardian periodic check failed', e);
    }
  }, CHECK_INTERVAL_MS);

  // Don't prevent Node.js from exiting
  if (_timer.unref) _timer.unref();

  const usage = getDiskUsage();
  log(`/tmp guardian started (interval=${CHECK_INTERVAL_MS}ms, usage=${(usage.usagePct * 100).toFixed(1)}%, thresholds: warn=${THRESHOLD_WARN}, aggressive=${THRESHOLD_AGGRESSIVE}, emergency=${THRESHOLD_EMERGENCY})`, 'INFO', 'tmp-guardian');
}

function stop() {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
  log('/tmp guardian stopped', 'INFO', 'tmp-guardian');
}

/**
 * Get current disk usage summary for dashboard/monitoring.
 */
function getStatus(): {
  usagePct: number;
  usedMB: number;
  totalMB: number;
  lastPruneLevel: string | null;
  checks: number;
  prunes: number;
} {
  const usage = getDiskUsage();
  return {
    usagePct: usage.usagePct,
    usedMB: Math.round(usage.usedBytes / (1024 * 1024)),
    totalMB: Math.round(usage.totalBytes / (1024 * 1024)),
    lastPruneLevel: _lastPrune?.level || null,
    checks: _stats.checks,
    prunes: _stats.prunes,
  };
}

// ─── Initialization ──────────────────────────────────────────────────────────

function init() {
  log('/tmp guardian initialized', 'INFO', 'tmp-guardian');
}

module.exports = {
  // Core API
  getDiskUsage,
  prune,
  check,

  // Lifecycle
  init,
  start,
  stop,

  // Query
  getStatus,
  getStats,

  // DI
  _injectDependencies,
};
