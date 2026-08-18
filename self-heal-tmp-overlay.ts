'use strict';
// Last modified: 2026-08-11 — Runtime /tmp overlay for self-heal on read-only filesystems
// Last modified: 2026-08-11 — Added patch pruning (stale detection, cap, DB collapse)

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
// Pruning: Without pruning the bot would eventually die from fixing itself.
//   - Stale detection: if the base file (git-deployed) now matches the overlay,
//     the patch is redundant and gets removed.
//   - Active cap: max MAX_ACTIVE_PATCHES overlay files; oldest evicted first.
//   - DB collapse: only the latest 'applied' patch per file is kept; older
//     attempts for the same file are marked 'superseded' and deleted sooner.
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

// Pruning configuration
const MAX_ACTIVE_PATCHES = 20;           // Max overlay files before eviction kicks in
const STALE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000; // Check for stale patches every 6h
const DB_APPLIED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;  // 30 days for applied (base file likely redeployed by then)
const DB_NON_APPLIED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days for rejected/rolled_back/superseded

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
let _pruneInterval: any = null;

// ─── Syntax sanity check ─────────────────────────────────────────────────────

/**
 * Lightweight syntax sanity check for .ts overlay files.
 * Catches truncated AI output that would kill esbuild with
 * "Unterminated string literal" or similar transform errors.
 *
 * NOT a full parser — just checks:
 *   1. No unterminated single/double quoted strings at EOF
 *   2. Brace/bracket/paren balance isn't wildly off (suggests truncation)
 *   3. File doesn't end mid-escape (trailing backslash)
 *
 * Returns true if the content looks syntactically sane enough to serve.
 */
function tsSyntaxSanityCheck(content: string): boolean {
  if (!content || content.length < 20) return false;

  // Check for trailing backslash (mid-escape = almost certainly truncated)
  const trimmed = content.trimEnd();
  if (trimmed.endsWith('\\')) return false;

  let braces = 0, parens = 0, brackets = 0;
  let inSingle = false, inDouble = false, inTemplate = false;
  let inLineComment = false, inBlockComment = false;

  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    const next = i + 1 < content.length ? content[i + 1] : '';

    // Handle comments (only when not inside strings)
    if (!inSingle && !inDouble && !inTemplate) {
      if (inBlockComment) {
        if (ch === '*' && next === '/') { inBlockComment = false; i++; }
        continue;
      }
      if (inLineComment) {
        if (ch === '\n') inLineComment = false;
        continue;
      }
      if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
      if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    }

    // Skip escaped chars inside strings
    if ((inSingle || inDouble || inTemplate) && ch === '\\') {
      i++; // skip next char
      continue;
    }

    // String delimiters
    if (!inSingle && !inDouble && !inTemplate && !inLineComment && !inBlockComment) {
      // Track delimiters for balance
      if (ch === '{') braces++;
      else if (ch === '}') braces--;
      else if (ch === '(') parens++;
      else if (ch === ')') parens--;
      else if (ch === '[') brackets++;
      else if (ch === ']') brackets--;
    }

    if (ch === "'" && !inDouble && !inTemplate && !inLineComment && !inBlockComment) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && !inTemplate && !inLineComment && !inBlockComment) inDouble = !inDouble;
    else if (ch === '`' && !inSingle && !inDouble && !inLineComment && !inBlockComment) inTemplate = !inTemplate;
  }

  // If still inside a single or double quote at EOF, string is unterminated
  if (inSingle || inDouble) return false;

  // Template literals can legitimately span to EOF (e.g. a template string at end of file)
  // so we don't check inTemplate.

  // Wildly unbalanced delimiters suggest truncation or corruption.
  // Allow some slack (comments, regex literals, etc. can throw off simple counting)
  if (braces < -5 || parens < -5 || brackets < -5) return false;
  // Many more opening than closing = likely truncated
  if (braces - 0 > 20 || parens - 0 > 20 || brackets - 0 > 20) return false;

  return true;
}

/** Valid ways a .ts file can start (first non-whitespace chars) */
const VALID_TS_STARTS = [
  "'use strict'", '"use strict"',
  'import ', 'export ',
  '//', '/*',
  'const ', 'let ', 'var ',
  'function ', 'async ', 'class ',
  'type ', 'interface ', 'enum ',
  'declare ', 'namespace ',
];

function hasValidTSHeader(content: string): boolean {
  const head = content.trimStart();
  return VALID_TS_STARTS.some(s => head.startsWith(s));
}

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

  // Content integrity: reject garbage that would kill esbuild on next require.
  // OOM heap corruption can produce strings with null bytes or truncated headers.
  // AI-generated patches can be malformed JSON wrapped in TS syntax.
  if (!content || typeof content !== 'string' || content.length < 20) {
    log(`Overlay write BLOCKED (content too short, ${content?.length || 0} chars): ${relativeFilePath}`, 'ERROR', 'self-heal-overlay');
    return false;
  }
  if (content.includes('\0')) {
    log(`Overlay write BLOCKED (contains null bytes — OOM corruption?): ${relativeFilePath}`, 'ERROR', 'self-heal-overlay');
    return false;
  }
  if (relativeFilePath.endsWith('.ts')) {
    // Header check: must start with a recognized TS pattern
    if (!hasValidTSHeader(content)) {
      log(`Overlay write BLOCKED (bad TS header): ${relativeFilePath}`, 'ERROR', 'self-heal-overlay');
      return false;
    }
    // Syntax sanity check: catch truncated AI output (unterminated strings, wildly unbalanced braces)
    if (!tsSyntaxSanityCheck(content)) {
      log(`Overlay write BLOCKED (fails syntax sanity check — likely truncated): ${relativeFilePath}`, 'ERROR', 'self-heal-overlay');
      return false;
    }
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
        // Validate the overlay file is readable and not empty/truncated.
        // OOM heap corruption or bad AI patches can write garbage,
        // which then kills esbuild transforms with "Unterminated string literal".
        try {
          const stat = fs.statSync(overlayPath);
          // A valid providers-prompts.ts is ~8KB+. If an overlay is < 50 bytes,
          // it's almost certainly corruption, not a real patch.
          if (stat.size < 50) {
            log(`Overlay INVALID (too small, ${stat.size}b): ${relativePath} — skipping, using original`, 'ERROR', 'self-heal-overlay');
            return originalPath;
          }
          // Validate .ts overlay files: header check + syntax sanity.
          // This catches corrupted overlays (truncated AI output, OOM corruption)
          // that would kill esbuild with "Unterminated string literal".
          if (relativePath.endsWith('.ts')) {
            const content = fs.readFileSync(overlayPath, 'utf8');
            if (!hasValidTSHeader(content)) {
              log(`Overlay INVALID (bad TS header): ${relativePath} — skipping, using original`, 'ERROR', 'self-heal-overlay');
              return originalPath;
            }
            if (!tsSyntaxSanityCheck(content)) {
              log(`Overlay INVALID (syntax sanity check failed — likely truncated): ${relativePath} — skipping, using original`, 'ERROR', 'self-heal-overlay');
              return originalPath;
            }
          }
        } catch (readErr: any) {
          // Can't even stat/read the overlay — skip it
          log(`Overlay UNREADABLE: ${relativePath} — ${readErr.code || readErr.message}, using original`, 'ERROR', 'self-heal-overlay');
          return originalPath;
        }
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

    // Prune stale/redundant patches immediately after restore
    let pruneResult: any = null;
    try {
      pruneResult = pruneOverlayPatches();
    } catch (err: any) {
      logError('Post-restore pruning failed (non-fatal)', err);
    }

    if (restored > 0) {
      const pruneInfo = pruneResult
        ? ` (${pruneResult.supersededByBase} superseded, ${pruneResult.evictedByCap} evicted by cap)`
        : '';
      log(`Self-heal overlay initialized: ${restored} patches restored${pruneInfo}, interceptor active`, 'INFO', 'self-heal-overlay');
    } else {
      log('Self-heal overlay initialized: interceptor active, no previous patches', 'INFO', 'self-heal-overlay');
    }

    // Start periodic pruning
    startPeriodicPruning();
  }
}

// Auto-init on first require (after DI injection at container startup)
init();

// ═══════════════════════════════════════════════════════════════════════════════
// Patch Pruning — prevents ironic death by accumulated Band-Aids
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Walk the overlay directory and return relative paths of all .ts/.js files.
 */
function listOverlayFiles(): string[] {
  const results: string[] = [];
  try {
    if (!fs.existsSync(OVERLAY_DIR)) return results;
    const walk = (dir: string): string[] => {
      let files: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          files = files.concat(walk(fullPath));
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.js')) {
          files.push(path.relative(OVERLAY_DIR, fullPath));
        }
      }
      return files;
    };
    return walk(OVERLAY_DIR);
  } catch {
    return results;
  }
}

/**
 * 1) Stale detection: Compare each overlay file against its read-only base.
 *    If the base file now contains the same content (git deploy fixed it
//    natively), the overlay patch is redundant and should be removed.
//
 *    Also checks a weaker condition: if the base file is NEWER than the
 *    overlay's DB timestamp (meaning a fresh deploy happened), and the
 *    base file is structurally valid, mark the patch for review.
 */
function reconcileOverlayWithBase(): { superseded: number; kept: number } {
  let superseded = 0;
  let kept = 0;
  const db = getDb();
  const overlayFiles = listOverlayFiles();

  for (const file of overlayFiles) {
    const overlayPath = path.resolve(OVERLAY_DIR, file);
    const basePath = path.resolve(PROJECT_ROOT, file);

    // If the base file doesn't exist at all, keep the overlay (it's still needed)
    if (!fs.existsSync(basePath)) {
      kept++;
      continue;
    }

    try {
      const overlayContent = fs.readFileSync(overlayPath, 'utf8');
      const baseContent = fs.readFileSync(basePath, 'utf8');

      // EXACT MATCH: base file now has the patch natively — superseded
      if (overlayContent === baseContent) {
        log(`Prune: ${file} is identical to base — superseded (git deploy fixed it)`, 'INFO', 'self-heal-overlay');
        removeFromOverlay(file);
        evictModule(file);

        // Mark all applied patches for this file as 'superseded' in DB
        if (db) {
          try {
            db.prepare(
              "UPDATE patch_history SET status = 'superseded' WHERE file = ? AND status = 'applied'"
            ).run(file);
          } catch { /* non-critical */ }
        }
        superseded++;
        continue;
      }

      // DIFF MATCH: check if the overlay is just the base + our recorded patch applied.
      // If the base was updated and now already contains the key changes, the patch
      // may be partially or fully redundant. For safety, we check a weaker signal:
      // the base file's mtime (deploy time) vs. when we applied the patch.
      if (db) {
        try {
          const latestPatch = db.prepare(
            "SELECT id, timestamp FROM patch_history WHERE file = ? AND status = 'applied' ORDER BY timestamp DESC LIMIT 1"
          ).get(file);

          if (latestPatch) {
            const baseStat = fs.statSync(basePath);
            // If base file was modified AFTER our patch was applied (i.e., a new deploy),
            // check if the key fixes from the overlay are present in the new base.
            // We use a simple heuristic: if >80% of non-whitespace, non-comment lines
            // from the overlay exist in the base, consider it superseded.
            if (baseStat.mtimeMs > latestPatch.timestamp) {
              const overlayLines = new Set(
                overlayContent.split('\n')
                  .map(l => l.trim())
                  .filter(l => l.length > 10 && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))
              );
              const baseLines = new Set(
                baseContent.split('\n')
                  .map(l => l.trim())
                  .filter(l => l.length > 10 && !l.startsWith('//') && !l.startsWith('/*') && !l.startsWith('*'))
              );

              if (overlayLines.size > 0) {
                let matchCount = 0;
                for (const line of overlayLines) {
                  if (baseLines.has(line)) matchCount++;
                }
                const similarity = matchCount / overlayLines.size;

                if (similarity >= 0.95) {
                  log(`Prune: ${file} is ${Math.round(similarity * 100)}% similar to updated base — superseded`, 'INFO', 'self-heal-overlay');
                  removeFromOverlay(file);
                  evictModule(file);
                  db.prepare(
                    "UPDATE patch_history SET status = 'superseded' WHERE file = ? AND status = 'applied'"
                  ).run(file);
                  superseded++;
                  continue;
                } else if (similarity >= 0.80) {
                  log(`Prune: ${file} is ${Math.round(similarity * 100)}% similar to updated base — keeping but flagging`, 'WARN', 'self-heal-overlay');
                }
              }
            }
          }
        } catch { /* non-critical: stale check is best-effort */ }
      }

      kept++;
    } catch {
      kept++; // If we can't read/compare, keep the overlay
    }
  }

  return { superseded, kept };
}

/**
 * 2) Active patch cap: if more than MAX_ACTIVE_PATCHES files are in the
 *    overlay, evict the oldest ones first (by DB timestamp).
 */
function enforceOverlayCap(): { evicted: number; remaining: number } {
  const db = getDb();
  const overlayFiles = listOverlayFiles();

  if (overlayFiles.length <= MAX_ACTIVE_PATCHES) {
    return { evicted: 0, remaining: overlayFiles.length };
  }

  const toEvict = overlayFiles.length - MAX_ACTIVE_PATCHES;
  let evicted = 0;

  // Sort by patch timestamp (oldest first) — need DB for this
  if (db) {
    try {
      const fileTimestamps: Map<string, number> = new Map();
      for (const file of overlayFiles) {
        const row = db.prepare(
          "SELECT MAX(timestamp) as latest_ts FROM patch_history WHERE file = ? AND status = 'applied'"
        ).get(file);
        fileTimestamps.set(file, row?.latest_ts || 0);
      }

      // Sort oldest first
      const sorted = overlayFiles.sort((a, b) =>
        (fileTimestamps.get(a) || 0) - (fileTimestamps.get(b) || 0)
      );

      // Evict the oldest `toEvict` files
      for (let i = 0; i < toEvict && i < sorted.length; i++) {
        const file = sorted[i];
        log(`Prune: evicting ${file} from overlay (cap: ${MAX_ACTIVE_PATCHES}, oldest patch)`, 'WARN', 'self-heal-overlay');
        removeFromOverlay(file);
        evictModule(file);

        // Mark as 'superseded' rather than delete — preserves history but
        // prevents re-restoring on next boot
        db.prepare(
          "UPDATE patch_history SET status = 'superseded' WHERE file = ? AND status = 'applied'"
        ).run(file);
        evicted++;
      }
    } catch (err: any) {
      logError('Prune: overlay cap enforcement failed', err);
    }
  }

  return { evicted, remaining: listOverlayFiles().length };
}

/**
 * 3) DB collapse: for each file that has multiple 'applied' patches in
 *    patch_history, keep only the latest one and mark all older ones as
 *    'superseded'. Also clean up non-applied patches by shorter retention.
 *    This prevents the DB from bloating with redundant full-text patch copies.
 */
function collapseRedundantPatchHistory(): { superseded: number; deleted: number } {
  let superseded = 0;
  let deleted = 0;
  const db = getDb();
  if (!db) return { superseded: 0, deleted: 0 };

  try {
    // Step 1: For each file, find all 'applied' patches and keep only the latest
    const appliedPerFile = db.prepare(
      "SELECT file, COUNT(*) as cnt, MAX(timestamp) as latest_ts FROM patch_history WHERE status = 'applied' GROUP BY file HAVING cnt > 1"
    ).all();

    for (const row of appliedPerFile) {
      // Mark all but the latest as 'superseded'
      const result = db.prepare(
        "UPDATE patch_history SET status = 'superseded' WHERE file = ? AND status = 'applied' AND timestamp < ?"
      ).run(row.file, row.latest_ts);
      superseded += result.changes;
    }

    // Step 2: Delete old non-applied patches (rejected, rolled_back, superseded)
    // using shorter retention than the janitor's blanket 365-day policy
    const nonAppliedCutoff = Date.now() - DB_NON_APPLIED_RETENTION_MS;
    const delResult = db.prepare(
      "DELETE FROM patch_history WHERE status IN ('rejected', 'rolled_back', 'superseded') AND timestamp < ?"
    ).run(nonAppliedCutoff);
    deleted += delResult.changes;

    // Step 3: Also clean up orphaned patch_embeddings that reference
    // deleted patch_history rows or non-applied statuses
    try {
      db.prepare(
        `DELETE FROM patch_embeddings WHERE status IN ('rejected', 'rolled_back', 'superseded') AND timestamp < ?`
      ).run(nonAppliedCutoff);
    } catch { /* patch_embeddings may not exist yet */ }

    // Step 4: Cap total applied patches — if somehow we still have too many
    // unique-file applied patches beyond a hard limit, age out the oldest
    const appliedCutoff = Date.now() - DB_APPLIED_RETENTION_MS;
    const oldApplied = db.prepare(
      "DELETE FROM patch_history WHERE status = 'applied' AND timestamp < ?"
    ).run(appliedCutoff);
    deleted += oldApplied.changes;

    if (superseded > 0 || deleted > 0) {
      log(`Prune: DB collapse — ${superseded} superseded, ${deleted} deleted`, 'INFO', 'self-heal-overlay');
    }
  } catch (err: any) {
    logError('Prune: DB collapse failed', err);
  }

  return { superseded, deleted };
}

/**
 * Master pruning function. Runs all three pruning strategies in sequence.
 * Called on boot after restoreOverlay() and periodically.
 *
 * Returns a summary of all pruning actions.
 */
function pruneOverlayPatches(): {
  supersededByBase: number;
  keptByBase: number;
  evictedByCap: number;
  remainingOverlay: number;
  dbSuperseded: number;
  dbDeleted: number;
} {
  const reconcileResult = reconcileOverlayWithBase();
  const capResult = enforceOverlayCap();
  const dbResult = collapseRedundantPatchHistory();

  // Update overlay file count after all pruning
  _overlayFileCount = listOverlayFiles().length;

  return {
    supersededByBase: reconcileResult.superseded,
    keptByBase: reconcileResult.kept,
    evictedByCap: capResult.evicted,
    remainingOverlay: capResult.remaining,
    dbSuperseded: dbResult.superseded,
    dbDeleted: dbResult.deleted,
  };
}

/**
 * Start periodic pruning alongside the DB janitor.
 */
function startPeriodicPruning(): void {
  if (_pruneInterval) return;

  _pruneInterval = setInterval(() => {
    try {
      const result = pruneOverlayPatches();
      const totalAction = result.supersededByBase + result.evictedByCap + result.dbDeleted;
      if (totalAction > 0) {
        log(`Periodic prune: ${result.supersededByBase} superseded, ${result.evictedByCap} evicted, ${result.dbDeleted} DB-deleted (${result.remainingOverlay} overlay files remain)`, 'INFO', 'self-heal-overlay');
      }
    } catch (err: any) {
      logError('Periodic pruning failed', err);
    }
  }, STALE_CHECK_INTERVAL_MS);

  if (_pruneInterval.unref) _pruneInterval.unref();
  log(`Periodic overlay pruning started (interval: ${STALE_CHECK_INTERVAL_MS / 3600000}h)`, 'INFO', 'self-heal-overlay');
}

/**
 * Stop periodic pruning.
 */
function stopPeriodicPruning(): void {
  if (_pruneInterval) {
    clearInterval(_pruneInterval);
    _pruneInterval = null;
  }
}

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

  // Pruning
  pruneOverlayPatches,
  reconcileOverlayWithBase,
  enforceOverlayCap,
  collapseRedundantPatchHistory,
  startPeriodicPruning,
  stopPeriodicPruning,

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
  MAX_ACTIVE_PATCHES,
};
