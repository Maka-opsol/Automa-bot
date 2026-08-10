'use strict';
// Last modified: 2026-08-11 — Runtime /tmp overlay for self-heal on read-only filesystems

// ═══════════════════════════════════════════════════════════════════════════════
// Self-Heal /tmp Overlay
//
// Problem: On Render (and similar platforms), source files deployed from git
// are read-only. The self-heal system generates patches but can't write them.
//
// Solution: Write patched files to a writable overlay directory (/tmp), then
// intercept Node's Module._resolveFilename to check the overlay FIRST.
//
// Resolution order:
//   1. /tmp/self-heal-overlay/<relative-path>  (patched version)
//   2. <PROJECT_ROOT>/<relative-path>            (original, read-only)
//
// Persistence: Patched file contents are stored in the patch_history DB table
// (already exists). On boot, restoreOverlay() re-applies them from DB to /tmp.
//
// Security: Only files matching ALLOWED_PREFIXES can be overlaid. The
// interceptor validates paths stay within the overlay directory.
// ═══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const Module = require('module');
const { PROJECT_ROOT } = require('./project-root');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function getDb() { return _deps.database?.db; }
function getCONFIG(): Record<string, any> { return _deps.config || (() => { try { return require('./get-config'); } catch { return {} as any; } })(); }

// ─── Configuration ──────────────────────────────────────────────────────────

const OVERLAY_DIR = process.env.SELF_HEAL_OVERLAY_DIR || '/tmp/self-heal-overlay';

// Only these file prefixes can be healed (same as self-deploy's ALLOWED_PREFIXES)
const ALLOWED_PREFIXES = [
  'selectors-', 'providers-detection-', 'providers-detection-',
  'cycle-', 'providers-base', 'providers-config-loader', 'providers-registry',
  'providers-fallback', 'providers-prompts', 'providers-vision-pipeline',
  'providers-stats', 'providers-tribunal', 'providers-serializers',
  'providers-prompt-evolution',
  'cache', 'auth-auth-manager', 'config', 'browser', 'state-machine',
  'longevity-ui-recovery', 'self-heal-degradation-ladder',
  'math-problem-classifier', 'services-pix2tex',
];

// ─── State ─────────────────────────────────────────────────────────────────

let _interceptorInstalled = false;
let _overlayFileCount = 0;

// ─── Core: Write a patched file to the overlay ────────────────────────────

/**
 * Write a file to the overlay directory. Only allowed for files
 * matching ALLOWED_PREFIXES. Returns true on success.
 */
function writeToOverlay(relativeFilePath: string, content: string): boolean {
  if (!isFileAllowed(relativeFilePath)) {
    log(`Overlay write BLOCKED (prefix not allowed): ${relativeFilePath}`, 'WARN', 'self-heal-overlay');
    return false;
  }

  // Security: path traversal check
  const resolved = path.resolve(OVERLAY_DIR, relativeFilePath);
  if (!resolved.startsWith(OVERLAY_DIR + path.sep) && resolved !== OVERLAY_DIR) {
    log(`Overlay write BLOCKED (path traversal): ${relativeFilePath}`, 'ERROR', 'self-heal-overlay');
    return false;
  }

  try {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(resolved, content, 'utf8');
    _overlayFileCount++;
    log(`Overlay: wrote ${relativeFilePath} (${content.length} chars)`, 'INFO', 'self-heal-overlay');
    return true;
  } catch (err: any) {
    logError(`Overlay write failed for ${relativeFilePath}`, err);
    return false;
  }
}

/**
 * Remove a file from the overlay (revert to original).
 */
function removeFromOverlay(relativeFilePath: string): boolean {
  try {
    const resolved = path.resolve(OVERLAY_DIR, relativeFilePath);
    if (fs.existsSync(resolved)) {
      fs.unlinkSync(resolved);
      _overlayFileCount = Math.max(0, _overlayFileCount - 1);
      log(`Overlay: removed ${relativeFilePath}`, 'INFO', 'self-heal-overlay');
    }
    return true;
  } catch (err: any) {
    logError(`Overlay remove failed for ${relativeFilePath}`, err);
    return false;
  }
}

/**
 * Check if a file exists in the overlay.
 */
function hasOverlay(relativeFilePath: string): boolean {
  const resolved = path.resolve(OVERLAY_DIR, relativeFilePath);
  return fs.existsSync(resolved);
}

/**
 * Read a file from the overlay.
 */
function readFromOverlay(relativeFilePath: string): string | null {
  try {
    const resolved = path.resolve(OVERLAY_DIR, relativeFilePath);
    if (fs.existsSync(resolved)) {
      return fs.readFileSync(resolved, 'utf8');
    }
    return null;
  } catch (err: any) {
    return null;
  }
}

// ─── Require Interceptor ───────────────────────────────────────────────────

/**
 * Install the Module._resolveFilename interceptor.
 * This is the magic that makes /tmp patches take effect immediately
 * without restarting the process.
 *
 * When any code does require('./selectors-foo'), Node will:
 *   1. Check if /tmp/self-heal-overlay/selectors-foo.ts exists → use it
 *   2. Otherwise fall back to the normal resolution → PROJECT_ROOT/selectors-foo.ts
 *
 * IMPORTANT: This does NOT affect already-loaded modules (they're cached
 * in require.cache). For hot-reload of a specific module, call evictModule().
 */
function installInterceptor(): boolean {
  if (_interceptorInstalled) return true;

  // Only install on Render or when explicitly enabled
  const isRender = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  const explicitlyEnabled = process.env.SELF_HEAL_TMP_OVERLAY === 'true';
  if (!isRender && !explicitlyEnabled) {
    log('Overlay interceptor skipped (not on Render, not explicitly enabled)', 'DEBUG', 'self-heal-overlay');
    return false;
  }

  const originalResolveFilename = Module._resolveFilename;

  // @ts-expect-error — accessing internal Node.js API
  Module._resolveFilename = function(request: string, parent: any, ...args: any[]) {
    try {
      // Only intercept relative project requires (not node_modules, not builtins)
      if (!request.startsWith('.') && !request.startsWith('/')) {
        return originalResolveFilename.call(this, request, parent, ...args);
      }

      // Resolve the original path first
      const originalPath = originalResolveFilename.call(this, request, parent, ...args);

      // Check if it's within our project root
      const absolutePath = path.resolve(originalPath);
      if (!absolutePath.startsWith(PROJECT_ROOT + path.sep) && absolutePath !== PROJECT_ROOT) {
        return originalPath;
      }

      // Compute the relative path from project root
      const relativePath = path.relative(PROJECT_ROOT, absolutePath);

      // Check if an overlay exists for this file
      const overlayPath = path.resolve(OVERLAY_DIR, relativePath);
      if (fs.existsSync(overlayPath)) {
        return overlayPath;
      }

      return originalPath;
    } catch (e: any) {
      // If our interceptor fails, fall back to original behavior
      return originalResolveFilename.call(this, request, parent, ...args);
    }
  };

  _interceptorInstalled = true;
  log(`Self-heal /tmp overlay interceptor installed (dir: ${OVERLAY_DIR})`, 'INFO', 'self-heal-overlay');
  return true;
}

/**
 * Evict a module from require.cache so it gets re-resolved
 * (and thus picks up the overlay version on next require).
 */
function evictModule(relativeFilePath: string): boolean {
  try {
    // Find the module in require.cache by checking for the relative path
    const absolutePath = path.resolve(PROJECT_ROOT, relativeFilePath);
    const overlayPath = path.resolve(OVERLAY_DIR, relativeFilePath);

    // Try both the original path and overlay path
    for (const cacheKey of Object.keys(require.cache)) {
      if (cacheKey === absolutePath || cacheKey === overlayPath ||
          cacheKey.endsWith(path.sep + relativeFilePath) ||
          cacheKey.endsWith(relativeFilePath)) {
        delete require.cache[cacheKey];
        log(`Evicted ${relativeFilePath} from require.cache`, 'DEBUG', 'self-heal-overlay');
        return true;
      }
    }
    return false;
  } catch (err: any) {
    return false;
  }
}

/**
 * Evict ALL modules that have overlays, forcing them to reload.
 * Call this after promoting staged patches.
 */
function evictAllOverlaidModules(): number {
  let count = 0;
  try {
    if (!fs.existsSync(OVERLAY_DIR)) return 0;

    const walk = (dir: string): string[] => {
      let results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results = results.concat(walk(fullPath));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
          results.push(fullPath);
        }
      }
      return results;
    };

    const overlaidFiles = walk(OVERLAY_DIR);
    for (const overlayPath of overlaidFiles) {
      const relativePath = path.relative(OVERLAY_DIR, overlayPath);
      if (evictModule(relativePath)) count++;
    }

    if (count > 0) {
      log(`Evicted ${count} overlaid modules from require.cache`, 'INFO', 'self-heal-overlay');
    }
  } catch (err: any) {
    logError('Failed to evict overlaid modules', err);
  }
  return count;
}

// ─── Persistence: Restore overlay from DB on boot ──────────────────────────

/**
 * Restore previously successful patches from the patch_history DB table
 * to the /tmp overlay. Called once on startup.
 */
function restoreOverlay(): { restored: number; skipped: number } {
  let restored = 0;
  let skipped = 0;

  try {
    const db = getDb();
    if (!db) {
      log('No database available for overlay restore', 'WARN', 'self-heal-overlay');
      return { restored: 0, skipped: 0 };
    }

    // Read all previously applied patches
    const patches = db.prepare(
      "SELECT file, patch FROM patch_history WHERE status = 'applied' ORDER BY timestamp DESC"
    ).all();

    if (!patches || patches.length === 0) {
      log('No previous patches to restore to overlay', 'DEBUG', 'self-heal-overlay');
      return { restored: 0, skipped: 0 };
    }

    // Use a Map to deduplicate by file (keep latest patch per file)
    const latestPatches = new Map<string, string>();
    for (const patch of patches) {
      if (patch.file && patch.patch) {
        latestPatches.set(patch.file, patch.patch);
      }
    }

    // Apply each patch to the overlay
    for (const [file, patchContent] of latestPatches) {
      if (!isFileAllowed(file)) {
        skipped++;
        continue;
      }

      // Determine if this is a full file replacement or a unified diff
      if (patchContent.startsWith('---')) {
        // It's a diff — need the original file to apply it
        const originalPath = path.join(PROJECT_ROOT, file);
        if (!fs.existsSync(originalPath)) {
          skipped++;
          continue;
        }
        const original = fs.readFileSync(originalPath, 'utf8');
        const patched = applySimpleDiff(original, patchContent);
        if (patched !== null) {
          writeToOverlay(file, patched);
          restored++;
        } else {
          log(`Diff apply failed for ${file} during overlay restore`, 'WARN', 'self-heal-overlay');
          skipped++;
        }
      } else {
        // Full file replacement
        writeToOverlay(file, patchContent);
        restored++;
      }
    }

    log(`Overlay restored: ${restored} files, ${skipped} skipped`, 'INFO', 'self-heal-overlay');
  } catch (err: any) {
    logError('Overlay restore failed', err);
  }

  return { restored, skipped };
}

/**
 * Clear the entire overlay (e.g., for rollback).
 */
function clearOverlay(): boolean {
  try {
    if (fs.existsSync(OVERLAY_DIR)) {
      fs.rmSync(OVERLAY_DIR, { recursive: true, force: true });
      log('Overlay cleared', 'INFO', 'self-heal-overlay');
    }
    _overlayFileCount = 0;
    return true;
  } catch (err: any) {
    logError('Failed to clear overlay', err);
    return false;
  }
}

// ─── Simple Diff Applier (pure JS, no shell) ──────────────────────────────

/**
 * Minimal unified diff applier. Returns patched content or null on failure.
 * Handles @@ -oldStart,oldCount +newStart,newCount @@ hunks.
 */
function applySimpleDiff(original: string, diffText: string): string | null {
  try {
    const lines = original.split('\n');
    const diffLines = diffText.split('\n');

    interface Hunk { oldStart: number; oldCount: number; newLines: string[]; oldLines: string[] }
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;

    for (const dl of diffLines) {
      const hunkMatch = dl.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(?:\d+)(?:,(?:\d+))?\s+@@/);
      if (hunkMatch) {
        if (current) hunks.push(current);
        current = {
          oldStart: parseInt(hunkMatch[1], 10),
          oldCount: parseInt(hunkMatch[2] || '1', 10),
          newLines: [],
          oldLines: [],
        };
        continue;
      }
      if (!current) continue;
      if (dl.startsWith('+')) current.newLines.push(dl.substring(1));
      else if (dl.startsWith('-')) current.oldLines.push(dl.substring(1));
      else if (dl.startsWith(' ') || dl === '') {
        current.newLines.push(dl.startsWith(' ') ? dl.substring(1) : dl);
        current.oldLines.push(dl.startsWith(' ') ? dl.substring(1) : dl);
      }
    }
    if (current) hunks.push(current);

    // Apply hunks in reverse order
    for (let i = hunks.length - 1; i >= 0; i--) {
      const hunk = hunks[i];
      const idx = hunk.oldStart - 1;
      if (idx < 0 || idx > lines.length) return null;

      // Verify old lines match
      for (let j = 0; j < hunk.oldLines.length; j++) {
        if (lines[idx + j] !== hunk.oldLines[j]) return null;
      }
      lines.splice(idx, hunk.oldCount, ...hunk.newLines);
    }

    return lines.join('\n');
  } catch {
    return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function isFileAllowed(relativeFilePath: string): boolean {
  return ALLOWED_PREFIXES.some(prefix => relativeFilePath.startsWith(prefix));
}

// ─── Status ─────────────────────────────────────────────────────────────────

function getStatus(): {
  interceptorInstalled: boolean;
  overlayDir: string;
  overlayFileCount: number;
  projectRoot: string;
  isRender: boolean;
} {
  // Recount overlay files
  try {
    if (fs.existsSync(OVERLAY_DIR)) {
      const count = (fs.readdirSync(OVERLAY_DIR, { recursive: true }) as string[])
        .filter((f: string) => f.endsWith('.ts') || f.endsWith('.js')).length;
      _overlayFileCount = count;
    }
  } catch { /* non-critical */ }

  return {
    interceptorInstalled: _interceptorInstalled,
    overlayDir: OVERLAY_DIR,
    overlayFileCount: _overlayFileCount,
    projectRoot: PROJECT_ROOT,
    isRender: !!(process.env.RENDER || process.env.RENDER_SERVICE_ID),
  };
}

// ─── Init ───────────────────────────────────────────────────────────────────

function init(): void {
  // Create overlay directory
  try {
    if (!fs.existsSync(OVERLAY_DIR)) {
      fs.mkdirSync(OVERLAY_DIR, { recursive: true });
    }
  } catch (err: any) {
    logError('Failed to create overlay directory', err);
    return;
  }

  // Install the require interceptor
  const installed = installInterceptor();

  if (installed) {
    // Restore previous patches from DB
    const { restored, skipped } = restoreOverlay();
    if (restored > 0) {
      log(`Self-heal overlay initialized: ${restored} patches restored, interceptor active`, 'INFO', 'self-heal-overlay');
    } else {
      log('Self-heal overlay initialized: interceptor active, no previous patches', 'INFO', 'self-heal-overlay');
    }
  }
}

// Auto-init on first require (after DI injection at container startup)
init();

module.exports = {
  // Core API
  writeToOverlay,
  removeFromOverlay,
  hasOverlay,
  readFromOverlay,
  clearOverlay,

  // Require interceptor
  installInterceptor,
  evictModule,
  evictAllOverlaidModules,

  // Persistence
  restoreOverlay,

  // Status
  getStatus,
  isFileAllowed,

  // Init
  init,

  // DI
  _injectDependencies,

  // Constants
  OVERLAY_DIR,
  ALLOWED_PREFIXES,
};
