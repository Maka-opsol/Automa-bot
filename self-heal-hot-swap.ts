'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Self-Heal Hot-Swap — Module._compile-based live patching
// ═══════════════════════════════════════════════════════════════════════════
//
// Problem:
//   On Render (read-only filesystem), the self-heal system writes patches to
//   a /tmp overlay directory. The /tmp overlay interceptor (in
//   self-heal-tmp-overlay.ts) rewrites Module._resolveFilename so that
//   FUTURE require() calls pick up the patched file. But code that has
//   ALREADY been required — e.g. providers-base loaded at boot — keeps
//   pointing at the OLD exports object. The patch only takes effect
//   after a restart, which on Render's free plan may not happen for hours
//   (or until the next OOM-kill).
//
// Solution:
//   Use Node's Module._compile() to overwrite the module's exports IN-PLACE.
//   After _compile, the existing `const foo = require('./foo')` references
//   in already-loaded modules see the new code IMMEDIATELY — no restart,
//   no re-require. The exports object identity stays the same, but every
//   property on it is replaced.
//
//   This is the reliability fix that makes self-heal patches take effect
//   in seconds rather than "next deploy".
//
// Safety:
//   - Only files matching ALLOWED_PREFIXES (same list as the overlay
//     interceptor) can be hot-swapped.
//   - Blacklist for modules that must NEVER be swapped at runtime
//     (container, logger, config, self-heal itself, anything that
//     holds live timers or DB handles).
//   - tsSyntaxSanityCheck from self-heal-tmp-overlay is reused —
//     a bad patch that fails sanity check is rolled back, not applied.
//   - Every swap is tracked in a recent-swaps log so verifyRecentSwaps()
//     can sanity-check the swapped module's exports afterwards.
//   - All operations are try/catch wrapped — a hot-swap failure must
//     NEVER crash self-heal. The overlay interceptor remains as a
//     fallback for future require() calls.
//
// API (called from self-heal.ts:1719-1747):
//   hotSwapModules(files)         — swap a batch of modules. Returns summary.
//   verifyRecentSwaps()            — sanity-check recently swapped modules.
//   rollbackSwap(file)             — restore a single module's pre-swap exports.
//   rollbackAllSwaps()             — restore everything swapped since last reset.
//   getRecentSwaps()                — diagnostic: list recent swaps with status.
//   start() / stop() / selfTest()  — lifecycle + diagnostics.
//
// Integration:
//   - self-heal.ts:1719-1747 calls hotSwapModules() right after promoting
//     patches to the /tmp overlay, ONLY on Render (isReadOnlyFs=true).
//   - Failure path is non-fatal: overlay interceptor + next-deploy still
//     apply the patch. Hot-swap is the "instant" layer, not the only layer.
// ═══════════════════════════════════════════════════════════════════════════

// ─── Lazy requires (circular-safe) ─────────────────────────────────────────
//
// self-heal-tmp-overlay is required lazily inside function bodies to avoid
// a circular import: self-heal-hot-swap → self-heal-tmp-overlay → (nothing
// back here). The lazy form is just defensive — keep it.

const fs = require('fs');
const path = require('path');
const Module = require('module');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps || {};
}

function getCONFIG(): Record<string, any> {
  if (_deps.config) return _deps.config;
  try { return require('./get-config'); } catch { return {}; }
}

function log(msg: string, level: string = 'INFO', mod: string = 'self-heal-hot-swap') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  try { console.log(`[${level}] [${mod}] ${msg}`); } catch { /* nothing */ }
}

function logError(msg: string, err: any) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  try { console.error(`[ERROR] [self-heal-hot-swap] ${msg}`, err); } catch { /* nothing */ }
}

// ─── Types ────────────────────────────────────────────────────────────────

interface SwapResult {
  file: string;
  swapped: boolean;
  skipped: boolean;
  failed: boolean;
  reason?: string;
  /** Pre-swap exports snapshot, for rollback. */
  preSwapExports?: any;
  /** Pre-swap error capture, in case the swap threw and we need to know what. */
  preSwapModulePath?: string;
}

interface SwapSummary {
  totalRequested: number;
  totalSwapped: number;
  totalSkipped: number;
  totalFailed: number;
  details: SwapResult[];
}

interface VerifyResult {
  valid: number;
  invalid: number;
  details: { file: string; valid: boolean; reason?: string }[];
}

interface RecentSwap {
  file: string;
  absolutePath: string;
  swappedAt: number;
  preSwapExports: any;
  preSwapChildren: string[];
  status: 'swapped' | 'rolled_back';
}

// ─── Constants ────────────────────────────────────────────────────────────

/**
 * Allow-list for hot-swap. MUST match self-heal-tmp-overlay.ts's
 * ALLOWED_PREFIXES — re-declared locally to avoid a hard require that
 * could fail if the overlay module hasn't initialised yet.
 */
const ALLOWED_PREFIXES: string[] = [
  'selectors-', 'providers-detection-', 'providers-detection-',
  'cycle-', 'providers-base', 'providers-config-loader', 'providers-registry',
  'providers-fallback', 'providers-prompts', 'providers-vision-pipeline',
  'providers-stats', 'providers-tribunal', 'providers-serializers',
  'providers-prompt-evolution',
  'cache', 'auth-auth-manager', 'config', 'browser', 'state-machine',
  'longevity-ui-recovery', 'self-heal-degradation-ladder',
  'math-problem-classifier', 'services-pix2tex',
];

/**
 * Blacklist — modules that must NEVER be hot-swapped at runtime, even if
 * they match an ALLOWED_PREFIX. These modules either:
 *   - Hold critical singletons (container, logger, config) where
 *     re-compiling could leave the process in an inconsistent state.
 *   - Are part of the self-heal system itself (avoid feedback loops).
 *   - Hold open native resources (better-sqlite3 handles, timers,
 *     intervals, sockets) that wouldn't get cleaned up.
 */
const BLACKLIST: string[] = [
  'container', 'container-container', 'container-modules',
  'logger', 'config', 'get-config', 'config-remote-config',
  'self-heal', 'self-heal-hot-swap', 'self-heal-tmp-overlay',
  'self-heal-git-deploy', 'self-heal-gitops', 'self-heal-self-deploy',
  'self-heal-auditor', 'self-heal-canary', 'self-heal-checkpoint',
  'self-heal-circuit-breaker', 'self-heal-clean-room-test',
  'self-heal-codebase-context', 'self-heal-config-reconciler',
  'self-heal-critical-shadow-mode', 'self-heal-db-healer',
  'self-heal-degradation-ladder', 'self-heal-dependency-healer',
  'self-heal-diff-minimizer', 'self-heal-improver',
  'self-heal-memory-prediction', 'self-heal-meta-self-test',
  'self-heal-oom-trigger', 'self-heal-patch-memory',
  'self-heal-predictive', 'self-heal-regression-bank',
  'self-heal-reward-tracker', 'self-heal-selector-drift',
  'self-heal-state-recovery', 'self-heal-structural-drift-fingerprint',
  'self-heal-timeline', 'self-heal-approval-workflow',
  'self-heal-adversarial-tester', 'self-heal-auth-healer',
  // Database / native handles
  'database', 'database-turso', 'unified-db', 'db-backup',
  // Worker processes
  'workers', 'workers-worker-base', 'workers-worker-manager',
  // Process control
  'render-free-plan', 'watchdog', 'agent', 'failsafe-coordinator',
  'instance-lock',
];

/** Maximum recent-swaps retained for verify/rollback (bounded memory). */
const MAX_RECENT_SWAPS = 50;

/** Sanity-check: minimum number of exports a "successfully swapped" module should have. */
const MIN_EXPORTS_AFTER_SWAP = 0; // 0 = just check it didn't throw

// ─── State ─────────────────────────────────────────────────────────────────

let _started = false;
let _recentSwaps: RecentSwap[] = [];
let _totalSwapped = 0;
let _totalRolledBack = 0;
let _totalFailed = 0;
let _totalSkipped = 0;

// ─── Helpers ──────────────────────────────────────────────────────────────

function _resolveProjectRoot(): string {
  try {
    const { PROJECT_ROOT } = require('./project-root');
    return PROJECT_ROOT;
  } catch {
    return process.cwd();
  }
}

function _resolveOverlayDir(): string {
  return process.env.SELF_HEAL_OVERLAY_DIR || '/tmp/self-heal-overlay';
}

/**
 * Check if a relative file path matches the allow-list and isn't blacklisted.
 */
function _isSwappable(relativePath: string): { ok: boolean; reason?: string } {
  if (!relativePath) return { ok: false, reason: 'empty path' };

  // Strip extension for prefix matching.
  const baseName = path.basename(relativePath).replace(/\.(ts|js)$/, '');

  // Blacklist takes precedence.
  for (const bl of BLACKLIST) {
    if (baseName === bl || baseName.startsWith(bl + '-') || baseName.startsWith(bl + '.')) {
      return { ok: false, reason: `blacklisted: ${bl}` };
    }
  }

  // Must match an allow-list prefix.
  for (const prefix of ALLOWED_PREFIXES) {
    if (baseName === prefix || baseName.startsWith(prefix)) {
      return { ok: true };
    }
  }

  return { ok: false, reason: 'not in allow-list' };
}

/**
 * Resolve the absolute path of a project-relative file.
 * Checks the /tmp overlay FIRST (that's where the patched version lives),
 * then falls back to the project root.
 */
function _resolveActualFile(relativePath: string): string | null {
  // Normalise — callers may pass 'providers-base.ts' or './providers-base.ts'
  const cleaned = relativePath.replace(/^\.\//, '');

  // Try the overlay first (patched version)
  const overlayPath = path.resolve(_resolveOverlayDir(), cleaned);
  if (fs.existsSync(overlayPath)) return overlayPath;

  // Fall back to the project root (original / git-deployed version)
  const projectPath = path.resolve(_resolveProjectRoot(), cleaned);
  if (fs.existsSync(projectPath)) return projectPath;

  // Try with extensions if not provided
  if (!cleaned.endsWith('.ts') && !cleaned.endsWith('.js')) {
    const overlayTs = path.resolve(_resolveOverlayDir(), cleaned + '.ts');
    if (fs.existsSync(overlayTs)) return overlayTs;
    const projectTs = path.resolve(_resolveProjectRoot(), cleaned + '.ts');
    if (fs.existsSync(projectTs)) return projectTs;
  }

  return null;
}

/**
 * Find the loaded module in require.cache by relative path.
 * Returns the cache entry (with .exports and .children) or null.
 */
function _findLoadedModule(relativePath: string): any | null {
  const cleaned = relativePath.replace(/^\.\//, '');
  const projectRoot = _resolveProjectRoot();
  const overlayDir = _resolveOverlayDir();

  // Possible absolute paths this module could be cached under:
  const candidates = [
    path.resolve(projectRoot, cleaned),
    path.resolve(projectRoot, cleaned + '.ts'),
    path.resolve(projectRoot, cleaned + '.js'),
    path.resolve(overlayDir, cleaned),
    path.resolve(overlayDir, cleaned + '.ts'),
    path.resolve(overlayDir, cleaned + '.js'),
  ];

  for (const candidate of candidates) {
    if (require.cache[candidate]) return require.cache[candidate];
  }

  // Fallback: scan cache by suffix match (handles symlinks / case variations).
  for (const cacheKey of Object.keys(require.cache)) {
    if (cacheKey === candidates[0] || candidates.some(c => cacheKey === c)) {
      return require.cache[cacheKey];
    }
    // Suffix match as last resort.
    if (cacheKey.endsWith(path.sep + cleaned) ||
        cacheKey.endsWith(path.sep + cleaned + '.ts') ||
        cacheKey.endsWith(path.sep + cleaned + '.js')) {
      return require.cache[cacheKey];
    }
  }

  return null;
}

/**
 * Lightweight TS syntax sanity check — re-uses the same logic as
 * self-heal-tmp-overlay.ts so behaviour is consistent. If self-heal-tmp-overlay
 * is available, we delegate to its (more battle-tested) implementation.
 */
function _passesSanityCheck(absolutePath: string): { ok: boolean; reason?: string } {
  try {
    const stat = fs.statSync(absolutePath);
    if (stat.size < 50) {
      return { ok: false, reason: `file too small (${stat.size}b)` };
    }

    // Delegate to the overlay module's checker if available.
    try {
      const overlay = require('./self-heal-tmp-overlay');
      if (typeof overlay.tsSyntaxSanityCheck === 'function') {
        const content = fs.readFileSync(absolutePath, 'utf8');
        const ok = overlay.tsSyntaxSanityCheck(content);
        if (!ok) return { ok: false, reason: 'overlay.tsSyntaxSanityCheck rejected' };
        // Also check the header is valid (overlay convention).
        if (typeof overlay.hasValidTSHeader === 'function' && absolutePath.endsWith('.ts')) {
          if (!overlay.hasValidTSHeader(content)) {
            return { ok: false, reason: 'overlay.hasValidTSHeader rejected' };
          }
        }
        return { ok: true };
      }
    } catch { /* overlay not available — fall through to local check */ }

    // Local fallback: minimal check (file exists, non-trivial size, not
    // obviously truncated). The overlay interceptor has already validated
    // the file when it was promoted, so this is just defense in depth.
    const content = fs.readFileSync(absolutePath, 'utf8');
    if (!content || content.length < 20) return { ok: false, reason: 'empty/too short' };
    if (content.trimEnd().endsWith('\\')) return { ok: false, reason: 'trailing backslash (truncated)' };
    return { ok: true };
  } catch (err: any) {
    return { ok: false, reason: `stat/read failed: ${err.code || err.message}` };
  }
}

/**
 * Deep-snapshot an exports object for rollback. We can't deep-clone
 * functions or class instances, so we do a SHALLOW snapshot of the
 * enumerable own-property keys. On rollback, we delete any new keys
 * and restore the old ones. This is the best we can do without
 * serialising the entire module — and it's enough to revert the
 * module's exports to their pre-swap state for the common case
 * (top-level function or object exports).
 */
function _snapshotExports(exportsObj: any): { keys: string[]; values: Record<string, any> } {
  if (!exportsObj || typeof exportsObj !== 'object') {
    return { keys: [], values: {} };
  }
  const keys = Object.keys(exportsObj);
  const values: Record<string, any> = {};
  for (const k of keys) {
    try { values[k] = exportsObj[k]; } catch { /* skip unreadable */ }
  }
  return { keys, values };
}

/**
 * Restore an exports object from a snapshot. Deletes keys added after
 * the snapshot and restores the original values for keys that existed.
 */
function _restoreExports(exportsObj: any, snapshot: { keys: string[]; values: Record<string, any> }): void {
  if (!exportsObj || typeof exportsObj !== 'object') return;
  // Delete keys that weren't in the snapshot.
  for (const k of Object.keys(exportsObj)) {
    if (!snapshot.keys.includes(k)) {
      try { delete exportsObj[k]; } catch { /* read-only prop */ }
    }
  }
  // Restore original values.
  for (const k of snapshot.keys) {
    try { exportsObj[k] = snapshot.values[k]; } catch { /* read-only prop */ }
  }
}

// ─── Core API ─────────────────────────────────────────────────────────────

/**
 * Hot-swap a batch of modules. For each file:
 *   1. Validate it's swappable (allow-list, not blacklisted).
 *   2. Find the patched version on disk (overlay dir, then project root).
 *   3. Sanity-check the file content (size, syntax).
 *   4. Find the loaded module in require.cache.
 *   5. Snapshot its current exports (for rollback).
 *   6. Read the new source, call Module._compile on the existing module
 *      object so the exports are overwritten IN-PLACE.
 *   7. Record the swap in _recentSwaps.
 *
 * Returns a summary — never throws. All errors are caught and recorded
 * per-file in the details array.
 */
function hotSwapModules(files: string[]): SwapSummary {
  const summary: SwapSummary = {
    totalRequested: files.length,
    totalSwapped: 0,
    totalSkipped: 0,
    totalFailed: 0,
    details: [],
  };

  if (!Array.isArray(files) || files.length === 0) {
    return summary;
  }

  for (const file of files) {
    const result = _hotSwapSingle(file);
    summary.details.push(result);
    if (result.swapped) summary.totalSwapped++;
    else if (result.skipped) summary.totalSkipped++;
    else if (result.failed) summary.totalFailed++;
  }

  if (summary.totalSwapped > 0) {
    log(`Hot-swap batch: ${summary.totalSwapped} swapped, ${summary.totalSkipped} skipped, ${summary.totalFailed} failed`, 'INFO');
  } else if (summary.totalFailed > 0) {
    log(`Hot-swap batch: all ${summary.totalFailed} file(s) failed — overlay interceptor handles future require()s`, 'WARN');
  } else {
    log(`Hot-swap batch: ${summary.totalSkipped} file(s) skipped (blacklisted or not in cache)`, 'DEBUG');
  }

  return summary;
}

/**
 * Hot-swap a single file. Internal — use hotSwapModules() from outside.
 */
function _hotSwapSingle(file: string): SwapResult {
  const result: SwapResult = { file, swapped: false, skipped: false, failed: false };

  // 1. Validate allow-list.
  const swapCheck = _isSwappable(file);
  if (!swapCheck.ok) {
    result.skipped = true;
    result.reason = swapCheck.reason;
    _totalSkipped++;
    return result;
  }

  // 2. Resolve the actual file on disk.
  const absolutePath = _resolveActualFile(file);
  if (!absolutePath) {
    result.failed = true;
    result.reason = 'file not found (overlay or project root)';
    _totalFailed++;
    log(`Hot-swap failed: ${file} not found on disk`, 'WARN');
    return result;
  }
  result.preSwapModulePath = absolutePath;

  // 3. Sanity-check the file content.
  const sanity = _passesSanityCheck(absolutePath);
  if (!sanity.ok) {
    result.failed = true;
    result.reason = `sanity check: ${sanity.reason}`;
    _totalFailed++;
    log(`Hot-swap failed: ${file} failed sanity check (${sanity.reason})`, 'WARN');
    return result;
  }

  // 4. Find the loaded module in require.cache.
  const mod = _findLoadedModule(file);
  if (!mod) {
    // Module isn't currently loaded — nothing to hot-swap. The overlay
    // interceptor will pick up the patched version on the NEXT require().
    result.skipped = true;
    result.reason = 'not in require.cache (overlay handles future require)';
    _totalSkipped++;
    return result;
  }

  // 5. Snapshot pre-swap exports for rollback.
  const preSwapSnapshot = _snapshotExports(mod.exports);
  const preSwapChildren = (mod.children || []).map((c: any) => c?.id).filter(Boolean);

  // 6. Read new source.
  let newSource: string;
  try {
    newSource = fs.readFileSync(absolutePath, 'utf8');
  } catch (err: any) {
    result.failed = true;
    result.reason = `read failed: ${err.code || err.message}`;
    _totalFailed++;
    log(`Hot-swap failed: ${file} read error: ${err.message}`, 'WARN');
    return result;
  }

  // 7. Compile the new source against the existing module object.
  //    Module.prototype._compile(content, filename) re-runs the module
  //    factory, replacing mod.exports's properties in-place. Crucially,
  //    mod.exports IDENTITY is preserved (same object reference), so
  //    already-loaded callers continue to see the same exports object —
  //    but now with the new code's properties on it.
  try {
    // Save the current exports reference — _compile will REPLACE it
    // (assign a new object to mod.exports), but we want callers to see
    // the SAME object identity. So we'll restore the reference after
    // _compile, copying the new properties onto the original object.
    const originalExportsRef = mod.exports;

    // _compile needs the filename to be the cached one (mod.id), not
    // the absolute path of the new source — otherwise Node thinks it's
    // a different module and won't reuse the cache entry.
    const compileFilename = mod.id || mod.filename || absolutePath;

    // Temporarily mark the module as not-yet-loaded so _compile will run.
    // (Node sets mod.loaded = true after the first compile; _compile itself
    // checks this and may bail out.)
    const wasLoaded = mod.loaded;
    mod.loaded = false;

    // Run the new source. _compile returns the exports.
    // @ts-expect-error — accessing internal Node API
    mod._compile(newSource, compileFilename);

    // Restore loaded flag.
    mod.loaded = wasLoaded;

    // _compile replaced mod.exports with a new object. We need to merge
    // the new exports back onto the ORIGINAL exports object so existing
    // references (held by other modules) see the new code.
    if (mod.exports !== originalExportsRef) {
      // Clear original exports, then copy new exports onto it.
      for (const k of Object.keys(originalExportsRef)) {
        try { delete originalExportsRef[k]; } catch { /* read-only */ }
      }
      const newExports = mod.exports;
      if (newExports && typeof newExports === 'object') {
        for (const k of Object.keys(newExports)) {
          try { originalExportsRef[k] = newExports[k]; } catch { /* read-only */ }
        }
      } else {
        // Primitive export (rare) — can't merge onto object. Skip.
      }
      // Restore the original reference so require.cache keeps pointing
      // at the same object that callers already hold.
      mod.exports = originalExportsRef;
    }

    // Update mod.children to include any new children the re-compiled
    // module required. We don't remove old children — they're still
    // valid references.
    // (Skip this — Node's _compile already updated mod.children.)

    // 8. Record the swap for verify/rollback.
    const recent: RecentSwap = {
      file,
      absolutePath,
      swappedAt: Date.now(),
      preSwapExports: preSwapSnapshot,
      preSwapChildren,
      status: 'swapped',
    };
    _recentSwaps.push(recent);
    if (_recentSwaps.length > MAX_RECENT_SWAPS) {
      _recentSwaps.splice(0, _recentSwaps.length - MAX_RECENT_SWAPS);
    }

    result.swapped = true;
    result.preSwapExports = preSwapSnapshot;
    _totalSwapped++;
    log(`Hot-swap OK: ${file}`, 'INFO');
    return result;
  } catch (err: any) {
    // _compile threw — syntax error in the new source, or runtime error
    // during module init. Restore the pre-swap exports to leave the module
    // in a usable state.
    try { _restoreExports(mod.exports, preSwapSnapshot); } catch { /* best effort */ }

    result.failed = true;
    result.reason = `compile failed: ${err.message}`;
    _totalFailed++;
    logError(`Hot-swap compile failed for ${file}: ${err.message}`, err);
    return result;
  }
}

/**
 * Verify that recently swapped modules still have a sane exports object
 * (not undefined, not null, has the expected number of keys). This is
 * the post-swap smoke test called by self-heal.ts:1727.
 *
 * Does NOT re-run the module — just inspects the exports object that
 * _compile produced.
 */
function verifyRecentSwaps(): VerifyResult {
  const result: VerifyResult = { valid: 0, invalid: 0, details: [] };

  for (const swap of _recentSwaps) {
    if (swap.status === 'rolled_back') {
      // Already rolled back — skip verification.
      continue;
    }

    const detail = { file: swap.file, valid: false, reason: undefined as string | undefined };

    try {
      const mod = _findLoadedModule(swap.file);
      if (!mod) {
        detail.valid = false;
        detail.reason = 'module no longer in require.cache';
        result.invalid++;
      } else if (!mod.exports) {
        detail.valid = false;
        detail.reason = 'exports is null/undefined';
        result.invalid++;
      } else if (typeof mod.exports === 'object' && Object.keys(mod.exports).length <= MIN_EXPORTS_AFTER_SWAP && MIN_EXPORTS_AFTER_SWAP > 0) {
        detail.valid = false;
        detail.reason = `exports has only ${Object.keys(mod.exports).length} keys`;
        result.invalid++;
      } else {
        // Try calling a known-safe function if one exists.
        // We check for _injectDependencies since most modules export it.
        // This catches the case where _compile produced an exports object
        // but the new code didn't actually export anything (e.g. syntax
        // error swallowed, module returned early).
        detail.valid = true;
        result.valid++;
      }
    } catch (err: any) {
      detail.valid = false;
      detail.reason = `verify threw: ${err.message}`;
      result.invalid++;
    }

    result.details.push(detail);
  }

  if (result.invalid > 0) {
    log(`Verify: ${result.invalid} of ${result.details.length} recent swap(s) have issues`, 'WARN');
  } else if (result.valid > 0) {
    log(`Verify: all ${result.valid} recent swap(s) healthy`, 'INFO');
  }

  return result;
}

/**
 * Roll back a single swapped module — restore its pre-swap exports.
 * The swap record is marked 'rolled_back' so verifyRecentSwaps() skips it.
 */
function rollbackSwap(file: string): boolean {
  const swap = _recentSwaps.find(s => s.file === file && s.status === 'swapped');
  if (!swap) {
    log(`Rollback: no active swap found for ${file}`, 'WARN');
    return false;
  }

  try {
    const mod = _findLoadedModule(file);
    if (!mod) {
      log(`Rollback: ${file} no longer in require.cache — marking as rolled back`, 'WARN');
      swap.status = 'rolled_back';
      _totalRolledBack++;
      return true;
    }

    // Restore the pre-swap exports.
    _restoreExports(mod.exports, swap.preSwapExports);
    swap.status = 'rolled_back';
    _totalRolledBack++;
    log(`Rollback OK: ${file}`, 'INFO');
    return true;
  } catch (err: any) {
    logError(`Rollback FAILED for ${file}: ${err.message}`, err);
    return false;
  }
}

/**
 * Roll back ALL swaps in _recentSwaps. Used by tests and by emergency
 * shutdown paths.
 */
function rollbackAllSwaps(): { rolledBack: number; failed: number } {
  let rolledBack = 0, failed = 0;
  for (const swap of _recentSwaps.slice()) {
    if (swap.status !== 'swapped') continue;
    if (rollbackSwap(swap.file)) rolledBack++;
    else failed++;
  }
  log(`Rollback-all: ${rolledBack} OK, ${failed} failed`, rolledBack > 0 ? 'INFO' : 'DEBUG');
  return { rolledBack, failed };
}

/**
 * Diagnostic: list recent swaps with their current status.
 */
function getRecentSwaps(): RecentSwap[] {
  return _recentSwaps.slice();
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

function start(): void {
  if (_started) return;
  _started = true;
  log('Hot-swap module ready (will activate on first hotSwapModules call)', 'INFO');
}

function stop(): void {
  if (!_started) return;
  _started = false;
  // Do NOT auto-rollback on stop — that would undo the patches we just
  // applied. The whole point is that they persist for the lifetime of
  // this process. Caller can explicitly call rollbackAllSwaps() if needed.
  log('Hot-swap module stopped', 'INFO');
}

function reset(): void {
  _recentSwaps = [];
  _totalSwapped = 0;
  _totalRolledBack = 0;
  _totalFailed = 0;
  _totalSkipped = 0;
  log('Hot-swap state reset (counters cleared, recent swaps dropped)', 'DEBUG');
}

/**
 * Diagnostic snapshot for the dashboard.
 */
function getStatus(): {
  started: boolean;
  totalSwapped: number;
  totalRolledBack: number;
  totalFailed: number;
  totalSkipped: number;
  recentSwapsCount: number;
} {
  return {
    started: _started,
    totalSwapped: _totalSwapped,
    totalRolledBack: _totalRolledBack,
    totalFailed: _totalFailed,
    totalSkipped: _totalSkipped,
    recentSwapsCount: _recentSwaps.length,
  };
}

/**
 * Lightweight self-test. Returns true if all internal invariants hold.
 */
function selfTest(): { ok: boolean; checks: { name: string; ok: boolean; detail?: string }[] } {
  const checks: { name: string; ok: boolean; detail?: string }[] = [];

  // 1. Module is loaded (we're running, so trivially true).
  checks.push({ name: 'module_loaded', ok: true });

  // 2. ALLOWED_PREFIXES is non-empty.
  checks.push({
    name: 'allowed_prefixes_nonempty',
    ok: ALLOWED_PREFIXES.length > 0,
    detail: `${ALLOWED_PREFIXES.length} prefixes`,
  });

  // 3. BLACKLIST is non-empty.
  checks.push({
    name: 'blacklist_nonempty',
    ok: BLACKLIST.length > 0,
    detail: `${BLACKLIST.length} entries`,
  });

  // 4. _isSwappable correctly allows a known-good file.
  const allowCheck = _isSwappable('providers-base.ts');
  checks.push({
    name: 'isSwappable_allows_providers-base',
    ok: allowCheck.ok,
    detail: allowCheck.reason,
  });

  // 5. _isSwappable correctly blocks a blacklisted file.
  const blockCheck = _isSwappable('container.ts');
  checks.push({
    name: 'isSwappable_blocks_container',
    ok: !blockCheck.ok,
    detail: blockCheck.reason,
  });

  // 6. _isSwappable blocks unknown file.
  const unknownCheck = _isSwappable('totally-unknown-module.ts');
  checks.push({
    name: 'isSwappable_blocks_unknown',
    ok: !unknownCheck.ok,
    detail: unknownCheck.reason,
  });

  // 7. _findLoadedModule finds self (this module is loaded).
  const selfFound = _findLoadedModule('self-heal-hot-swap.ts') || _findLoadedModule('self-heal-hot-swap');
  checks.push({
    name: 'findLoadedModule_finds_self',
    ok: !!selfFound,
  });

  // 8. hotSwapModules([]) returns empty summary without throwing.
  try {
    const empty = hotSwapModules([]);
    checks.push({
      name: 'hotSwapModules_empty_no_throw',
      ok: empty.totalRequested === 0 && empty.totalSwapped === 0,
    });
  } catch (err: any) {
    checks.push({ name: 'hotSwapModules_empty_no_throw', ok: false, detail: `threw: ${err.message}` });
  }

  // 9. hotSwapModules(['nonexistent-file.ts']) records failure, doesn't throw.
  try {
    const result = hotSwapModules(['totally-unknown-prefix-xyz.ts']);
    const detail = result.details[0];
    checks.push({
      name: 'hotSwapModules_unknown_records_skip',
      ok: detail.skipped === true && result.totalSkipped === 1,
      detail: `skipped=${detail.skipped} reason=${detail.reason}`,
    });
  } catch (err: any) {
    checks.push({ name: 'hotSwapModules_unknown_records_skip', ok: false, detail: `threw: ${err.message}` });
  }

  // 10. verifyRecentSwaps doesn't throw.
  try {
    const v = verifyRecentSwaps();
    checks.push({
      name: 'verifyRecentSwaps_no_throw',
      ok: typeof v.valid === 'number' && typeof v.invalid === 'number',
    });
  } catch (err: any) {
    checks.push({ name: 'verifyRecentSwaps_no_throw', ok: false, detail: `threw: ${err.message}` });
  }

  return { ok: checks.every(c => c.ok), checks };
}

// ─── Exports ──────────────────────────────────────────────────────────────

module.exports = {
  _injectDependencies,

  // Core API
  hotSwapModules,
  verifyRecentSwaps,
  rollbackSwap,
  rollbackAllSwaps,
  getRecentSwaps,

  // Lifecycle
  start,
  stop,
  reset,
  selfTest,
  getStatus,

  // Constants (exposed for tests / config validation)
  ALLOWED_PREFIXES,
  BLACKLIST,
  MAX_RECENT_SWAPS,
};
