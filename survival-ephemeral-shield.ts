// Resilience R5: Disk Wipe Protection — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// survival-ephemeral-shield.ts — P1 Ephemeral Disk Protection
// ═══════════════════════════════════════════════════════════════
// Render free tier mounts an ephemeral disk at /app/ that is
// WIPEABLE on every deploy, restart, or scale event. Any data
// written to /app/ (DB, checkpoint, logs, browser profile) can
// vanish without warning. This module:
//
//   1. Monitors critical file paths for unexpected deletion/move
//   2. Periodically copies critical files to /tmp/ (persisted
//      across restarts but not deploys on Render free plan)
//   3. Detects disk wipe events by comparing file existence
//      against a "manifest" saved to /tmp/
//   4. Triggers state restoration via survival-tombstone.ts
//      when a disk wipe is detected
//   5. Provides disk space monitoring with pre-emptive cleanup
//      of non-critical files (logs, old screenshots)
//
// Critical paths monitored:
//   - DB_PATH (mathu-bot.db)
//   - CHECKPOINT_FILE (checkpoint.json)
//   - LOG_DIR (logs/)
//   - USER_DATA_DIR (.browser-data/)
//
// Protection tiers:
//   Tier 1 (always): DB and checkpoint → shadow copy to /tmp/
//   Tier 2 (periodic): logs and browser data → shadow copy
//   Tier 3 (cleanup): stale logs, old screenshots, temp files
//
// Integration:
//   - container-subsystem-runner.ts calls start() at boot
//   - runtime-heap-guardian.ts calls triggerShieldCheck() before OOM exit
//   - cycle-cycle-manager.ts calls syncCriticalFiles() on cycle end
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'ephemeral-shield') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

function logError(msg: string, err: Error) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  console.error(`[ERROR] [${mod}] ${msg}`, err);
}

// ─── Constants ───
const DEFAULT_SYNC_INTERVAL_MS = 30 * 1000;      // 30 seconds
const DEFAULT_MANIFEST_CHECK_MS = 10 * 1000;     // 10 seconds
const DEFAULT_DISK_CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds
const DISK_SPACE_CRITICAL_PERCENT = 90;           // Trigger cleanup above this
const DISK_SPACE_LOW_PERCENT = 80;                // Log warning above this
const MAX_LOG_FILES = 5;                          // Keep only N most recent log files
const MAX_LOG_AGE_MS = 2 * 60 * 60 * 1000;       // 2 hours
const MAX_SCREENSHOT_AGE_MS = 30 * 60 * 1000;     // 30 minutes
const SHADOW_DIR = '/tmp/mathu-shield';           // Shadow copies directory
const MANIFEST_FILE = '/tmp/mathu-shield/manifest.json';
const SHIELD_VERSION = 1;

// ─── State ───
let _syncInterval: ReturnType<typeof setInterval> | null = null;
let _manifestCheckInterval: ReturnType<typeof setInterval> | null = null;
let _diskCheckInterval: ReturnType<typeof setInterval> | null = null;
let _syncCount = 0;
let _wipeDetected = false;
let _wipeDetectedAt = 0;
let _lastManifestCheck = 0;
let _lastDiskCheck = 0;
let _diskUsagePercent = 0;
let _cleanupCount = 0;
let _started = false;

// ─── Helpers ───

/**
 * Lazily require fs/path to avoid startup overhead.
 */
function getFs(): any {
  return require('fs');
}

function getPath(): any {
  return require('path');
}

function getOs(): any {
  return require('os');
}

/**
 * Check if we are on Render (ephemeral disk at /app/).
 */
function isRender(): boolean {
  return !!(process.env.RENDER_SERVICE_ID || process.env.RENDER);
}

/**
 * Get the critical paths from CONFIG with defaults.
 */
function getCriticalPaths(): Record<string, string> {
  const CONFIG = getCONFIG();
  const path = getPath();
  const os = getOs();

  return {
    dbPath: (CONFIG.DB_PATH as string) || path.join(process.cwd(), 'mathu-bot.db'),
    checkpointFile: (CONFIG.CHECKPOINT_FILE as string) || path.join(process.cwd(), 'checkpoint.json'),
    logDir: (CONFIG.LOG_DIR as string) || path.join(process.cwd(), 'logs'),
    userDataDir: (CONFIG.USER_DATA_DIR as string) || path.join(process.cwd(), '.browser-data'),
    shadowDir: SHADOW_DIR,
  };
}

/**
 * Ensure the shadow directory exists.
 */
function ensureShadowDir(): boolean {
  try {
    const fs = getFs();
    const path = getPath();
    if (!fs.existsSync(SHADOW_DIR)) {
      fs.mkdirSync(SHADOW_DIR, { recursive: true, mode: 0o700 });
      log(`Created shadow directory: ${SHADOW_DIR}`, 'DEBUG');
    }
    return true;
  } catch (e: any) {
    logError('Failed to create shadow directory', e);
    return false;
  }
}

/**
 * Copy a file safely (read → write) with size cap.
 */
function copyFileSafe(src: string, dest: string, maxSizeBytes: number = 50 * 1024 * 1024): boolean {
  try {
    const fs = getFs();
    if (!fs.existsSync(src)) return false;

    const stat = fs.statSync(src);
    if (stat.size > maxSizeBytes) {
      log(`Skipping large file: ${src} (${stat.size} bytes > ${maxSizeBytes})`, 'DEBUG');
      return false;
    }

    // Atomic copy: write to .tmp first, then rename
    const tmp = dest + '.tmp';
    const content = fs.readFileSync(src);
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, dest);
    return true;
  } catch (e: any) {
    // Don't spam logs for expected failures (file not found during wipe)
    if (e.code !== 'ENOENT' && e.code !== 'EACCES') {
      logError(`Failed to copy ${src} → ${dest}`, e);
    }
    return false;
  }
}

/**
 * Recursively copy a directory (shallow — one level only) with size cap.
 */
function copyDirShallow(srcDir: string, destDir: string, maxSizeBytes: number = 10 * 1024 * 1024): number {
  try {
    const fs = getFs();
    const path = getPath();
    let filesCopied = 0;
    let totalBytes = 0;

    if (!fs.existsSync(srcDir)) return 0;

    const entries = fs.readdirSync(srcDir);
    if (!fs.existsSync(destDir)) {
      fs.mkdirSync(destDir, { recursive: true, mode: 0o700 });
    }

    for (const entry of entries) {
      const srcPath = path.join(srcDir, entry);
      const destPath = path.join(destDir, entry);
      const stat = fs.statSync(srcPath);

      if (stat.isFile()) {
        if (totalBytes + stat.size > maxSizeBytes) continue; // Size budget exceeded
        if (copyFileSafe(srcPath, destPath, maxSizeBytes)) {
          filesCopied++;
          totalBytes += stat.size;
        }
      }
    }

    return filesCopied;
  } catch (e: any) {
    logError(`Failed to shallow-copy dir ${srcDir}`, e);
    return 0;
  }
}

// ─── Tier 1: Critical File Shadowing ───

/**
 * Sync the most critical files (DB + checkpoint) to /tmp/.
 * This is the minimum protection against data loss.
 */
function syncCriticalFiles(): boolean {
  if (!ensureShadowDir()) return false;

  const paths = getCriticalPaths();
  const path = getPath();
  let anySuccess = false;

  // 1. Database file
  const dbShadow = path.join(SHADOW_DIR, 'mathu-bot.db');
  const dbOk = copyFileSafe(paths.dbPath, dbShadow, 50 * 1024 * 1024);
  if (dbOk) {
    anySuccess = true;
    log('Database shadow updated', 'DEBUG');
  }

  // 2. Checkpoint file
  const cpShadow = path.join(SHADOW_DIR, 'checkpoint.json');
  const cpOk = copyFileSafe(paths.checkpointFile, cpShadow, 5 * 1024 * 1024);
  if (cpOk) {
    anySuccess = true;
    log('Checkpoint shadow updated', 'DEBUG');
  }

  _syncCount++;
  return anySuccess;
}

// ─── Tier 2: Non-Critical File Shadowing ───

/**
 * Sync non-critical directories (logs, browser data) to /tmp/.
 * These are "nice to have" for debugging but not required for recovery.
 */
function syncNonCriticalFiles(): boolean {
  if (!ensureShadowDir()) return false;

  const paths = getCriticalPaths();
  const path = getPath();
  let totalFiles = 0;

  // Log files (keep last few, skip old ones)
  const logShadow = path.join(SHADOW_DIR, 'logs');
  const logFiles = copyDirShallow(paths.logDir, logShadow, 5 * 1024 * 1024);
  if (logFiles > 0) {
    totalFiles += logFiles;
  }

  // Browser data is typically large — only copy if small enough
  // and on Render (where it's ephemeral)
  if (isRender()) {
    const userDataShadow = path.join(SHADOW_DIR, 'browser-data');
    const browserFiles = copyDirShallow(paths.userDataDir, userDataShadow, 5 * 1024 * 1024);
    if (browserFiles > 0) {
      totalFiles += browserFiles;
    }
  }

  if (totalFiles > 0) {
    log(`Non-critical shadow: ${totalFiles} files copied`, 'DEBUG');
    return true;
  }
  return false;
}

// ─── Manifest & Wipe Detection ───

interface FileManifestEntry {
  path: string;
  size: number;
  mtimeMs: number;
  exists: boolean;
}

interface DiskManifest {
  version: number;
  createdAt: number;
  updatedAt: number;
  pid: number;
  files: Record<string, FileManifestEntry>;
}

/**
 * Build a manifest of critical file states.
 */
function buildManifest(): DiskManifest {
  const paths = getCriticalPaths();
  const fs = getFs();
  const manifest: DiskManifest = {
    version: SHIELD_VERSION,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    pid: process.pid,
    files: {},
  };

  const criticalEntries: Array<{ key: string; path: string }> = [
    { key: 'db', path: paths.dbPath },
    { key: 'checkpoint', path: paths.checkpointFile },
    { key: 'logDir', path: paths.logDir },
    { key: 'userDataDir', path: paths.userDataDir },
  ];

  for (const entry of criticalEntries) {
    try {
      if (fs.existsSync(entry.path)) {
        const stat = fs.statSync(entry.path);
        manifest.files[entry.key] = {
          path: entry.path,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
          exists: true,
        };
      } else {
        manifest.files[entry.key] = {
          path: entry.path,
          size: 0,
          mtimeMs: 0,
          exists: false,
        };
      }
    } catch {
      manifest.files[entry.key] = {
        path: entry.path,
        size: 0,
        mtimeMs: 0,
        exists: false,
      };
    }
  }

  return manifest;
}

/**
 * Save the current manifest to /tmp/.
 */
function saveManifest(manifest: DiskManifest): boolean {
  try {
    ensureShadowDir();
    const fs = getFs();
    const tmp = MANIFEST_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2));
    fs.renameSync(tmp, MANIFEST_FILE);
    return true;
  } catch (e: any) {
    logError('Failed to save manifest', e);
    return false;
  }
}

/**
 * Load the previous manifest from /tmp/.
 * Returns null if no manifest exists.
 */
function loadManifest(): DiskManifest | null {
  try {
    const fs = getFs();
    if (!fs.existsSync(MANIFEST_FILE)) return null;

    const content = fs.readFileSync(MANIFEST_FILE, 'utf-8');
    const manifest = JSON.parse(content) as DiskManifest;

    // Version check
    if (manifest.version !== SHIELD_VERSION) {
      log(`Manifest version mismatch (got ${manifest.version}, expected ${SHIELD_VERSION}), ignoring`, 'WARN');
      return null;
    }

    return manifest;
  } catch (e: any) {
    logError('Failed to load manifest', e);
    return null;
  }
}

/**
 * Compare current disk state against previous manifest.
 * Detects disk wipe events where files that existed before are now gone.
 *
 * Wipe detection criteria:
 *   - DB file existed in manifest but no longer exists
 *   - OR DB file size dropped to 0
 *   - AND the manifest is from a recent process (same PID or < 5 min old)
 */
function detectWipe(): { wipeDetected: boolean; missingFiles: string[]; reason: string } {
  const currentManifest = buildManifest();
  const previousManifest = loadManifest();

  // Save current manifest for next check
  saveManifest(currentManifest);

  if (!previousManifest) {
    // No previous manifest — first run. Save and skip.
    log('No previous manifest found — first run, establishing baseline', 'INFO');
    return { wipeDetected: false, missingFiles: [], reason: 'no_previous_manifest' };
  }

  const missingFiles: string[] = [];
  const criticalGone: string[] = [];

  for (const [key, prevEntry] of Object.entries(previousManifest.files)) {
    const currEntry = currentManifest.files[key];
    if (!currEntry) continue;

    if (prevEntry.exists && !currEntry.exists) {
      missingFiles.push(key);
      if (key === 'db' || key === 'checkpoint') {
        criticalGone.push(key);
      }
    }

    // DB existed but is now empty (possible partial wipe)
    if (key === 'db' && prevEntry.exists && currEntry.exists && currEntry.size === 0 && prevEntry.size > 0) {
      missingFiles.push(key + ' (empty)');
      criticalGone.push(key + ' (empty)');
    }
  }

  if (criticalGone.length > 0) {
    // Verify it's not just a normal restart (PID change with recent manifest)
    const manifestAge = Date.now() - previousManifest.updatedAt;
    const isRecentManifest = manifestAge < 5 * 60 * 1000; // 5 minutes
    const isSamePid = previousManifest.pid === process.pid;

    if (isRecentManifest || isSamePid) {
      // High confidence wipe detected
      return {
        wipeDetected: true,
        missingFiles: criticalGone,
        reason: `Critical files missing: ${criticalGone.join(', ')} (manifest age: ${Math.round(manifestAge / 1000)}s, pid match: ${isSamePid})`,
      };
    } else {
      // Old manifest — files may have been legitimately cleaned up
      log(`Old manifest (${Math.round(manifestAge / 1000 / 60)}m old) references missing files, but not recent enough to trigger wipe recovery`, 'INFO');
      return { wipeDetected: false, missingFiles, reason: 'stale_manifest' };
    }
  }

  if (missingFiles.length > 0) {
    log(`Non-critical files missing: ${missingFiles.join(', ')}`, 'INFO');
  }

  return { wipeDetected: false, missingFiles: [], reason: 'ok' };
}

/**
 * Attempt to restore from shadow copies after a wipe is detected.
 * Priority: DB first (most critical), then checkpoint.
 */
async function restoreFromShadow(): Promise<{ restored: boolean; details: string }> {
  const paths = getCriticalPaths();
  const path = getPath();
  const fs = getFs();

  log('Starting shadow restoration...', 'WARN');

  // 1. Restore database
  const dbShadow = path.join(SHADOW_DIR, 'mathu-bot.db');
  try {
    if (fs.existsSync(dbShadow) && fs.existsSync(paths.dbPath)) {
      // DB file exists but is empty/corrupt — replace from shadow
      const stat = fs.statSync(paths.dbPath);
      if (stat.size === 0) {
        fs.copyFileSync(dbShadow, paths.dbPath);
        log(`Database restored from shadow (${fs.statSync(dbShadow).size} bytes)`, 'WARN');

        // Also restore WAL and SHM files if they exist in shadow
        const dbWAL = path.join(SHADOW_DIR, 'mathu-bot.db-wal');
        const dbSHM = path.join(SHADOW_DIR, 'mathu-bot.db-shm');
        const walDest = paths.dbPath + '-wal';
        const shmDest = paths.dbPath + '-shm';
        if (fs.existsSync(dbWAL)) fs.copyFileSync(dbWAL, walDest);
        if (fs.existsSync(dbSHM)) fs.copyFileSync(dbSHM, shmDest);
      }
    } else if (fs.existsSync(dbShadow) && !fs.existsSync(paths.dbPath)) {
      // DB file completely gone
      fs.copyFileSync(dbShadow, paths.dbPath);
      log(`Database restored from shadow (file was missing)`, 'WARN');
    }
  } catch (e: any) {
    logError('Failed to restore database from shadow', e);
  }

  // 2. Restore checkpoint
  const cpShadow = path.join(SHADOW_DIR, 'checkpoint.json');
  try {
    if (fs.existsSync(cpShadow)) {
      const checkpointContent = fs.readFileSync(cpShadow, 'utf-8');
      const checkpoint = JSON.parse(checkpointContent);

      // Use statePersist if available for proper save
      const statePersist = (_deps as any).statePersist;
      if (statePersist?.saveCheckpoint) {
        statePersist.saveCheckpoint(checkpoint);
        log('Checkpoint restored from shadow via statePersist', 'WARN');
      } else {
        // Fallback: write directly
        fs.writeFileSync(paths.checkpointFile, checkpointContent);
        log('Checkpoint restored from shadow (direct write)', 'WARN');
      }
    }
  } catch (e: any) {
    logError('Failed to restore checkpoint from shadow', e);
  }

  // 3. Re-create log directory if missing
  try {
    if (!fs.existsSync(paths.logDir)) {
      fs.mkdirSync(paths.logDir, { recursive: true, mode: 0o750 });
      log('Log directory recreated after wipe', 'INFO');
    }
  } catch (e: any) {
    logError('Failed to recreate log directory', e);
  }

  return { restored: true, details: 'Shadow restoration attempted for DB and checkpoint' };
}

// ─── Tier 3: Disk Space Monitoring & Cleanup ───

/**
 * Get disk usage percentage for the filesystem containing the given path.
 * Returns -1 if unable to determine.
 */
function getDiskUsagePercent(checkPath: string): number {
  try {
    const fs = getFs();
    const stats = fs.statfsSync(checkPath);
    if (stats && typeof stats.bavail === 'number' && typeof stats.bsize === 'number' && typeof stats.blocks === 'number') {
      const totalBytes = stats.blocks * stats.bsize;
      const availBytes = stats.bavail * stats.bsize;
      const usedBytes = totalBytes - availBytes;
      return totalBytes > 0 ? (usedBytes / totalBytes) * 100 : -1;
    }
  } catch {
    // statfsSync may not be available in all Node.js builds
  }

  // Fallback: statfsSync not available — return -1 (unknown)
  // Previously used process RSS memory to estimate disk, which was
  // wildly inaccurate and could trigger unnecessary emergency cleanup.
  return -1;
}

/**
 * Clean up non-critical files to free disk space.
 * Priority: oldest + largest files first.
 *
 * Cleanup targets:
 *   1. Old log files (beyond MAX_LOG_AGE_MS or beyond MAX_LOG_FILES)
 *   2. Old screenshot files (beyond MAX_SCREENSHOT_AGE_MS)
 *   3. Temp files in /tmp/ that are > 1 hour old and match mathu-* pattern
 */
function cleanupNonCriticalFiles(): { freedBytes: number; filesDeleted: number } {
  const fs = getFs();
  const path = getPath();

  function _recursiveSize(dir: string, fs: any): number {
    let total = 0;
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        try {
          const s = fs.statSync(full);
          if (s.isFile()) total += s.size;
          else if (s.isDirectory()) total += _recursiveSize(full, fs);
        } catch { /* skip */ }
      }
    } catch { /* skip */ }
    return total;
  }

  function _rmrf(dir: string, fs: any): void {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        const full = path.join(dir, e.name);
        try {
          if (e.isFile()) fs.unlinkSync(full);
          else if (e.isDirectory()) { _rmrf(full, fs); fs.rmdirSync(full); }
        } catch { /* skip */ }
      }
      fs.rmdirSync(dir);
    } catch { /* skip */ }
  }
  let freedBytes = 0;
  let filesDeleted = 0;

  // 1. Clean old log files
  try {
    const paths = getCriticalPaths();
    const logDir = paths.logDir;
    if (fs.existsSync(logDir)) {
      const logEntries = fs.readdirSync(logDir)
        .map((f: string) => {
          try {
            const fullPath = path.join(logDir, f);
            const stat = fs.statSync(fullPath);
            return { name: f, path: fullPath, size: stat.size, mtimeMs: stat.mtimeMs, isFile: stat.isFile() };
          } catch { return null; }
        })
        .filter((e: any) => e?.isFile)
        .sort((a: any, b: any) => a.mtimeMs - b.mtimeMs) as Array<{ name: string; path: string; size: number; mtimeMs: number }>;

      const now = Date.now();
      for (let i = 0; i < logEntries.length; i++) {
        const entry = logEntries[i];
        const age = now - entry.mtimeMs;

        // Delete if older than MAX_LOG_AGE_MS, OR if we have more than MAX_LOG_FILES
        // and this is one of the oldest
        const tooOld = age > MAX_LOG_AGE_MS;
        const excessFile = i < (logEntries.length - MAX_LOG_FILES);

        if (tooOld || excessFile) {
          try {
            fs.unlinkSync(entry.path);
            freedBytes += entry.size;
            filesDeleted++;
          } catch { /* skip */ }
        }
      }

      if (filesDeleted > 0) {
        log(`Cleaned ${filesDeleted} old log files (${(freedBytes / 1024).toFixed(0)} KB freed)`, 'INFO');
      }
    }
  } catch (e: any) {
    logError('Log cleanup failed', e);
  }

  // 2. Clean old screenshot files (use SCREENSHOT_DIR, not cwd)
  try {
    const screenshotDir = process.env.SCREENSHOT_DIR
      || path.join(getOs().tmpdir(), 'mathu-logs', 'screenshots');
    if (fs.existsSync(screenshotDir)) {
      const now = Date.now();
      const entries = fs.readdirSync(screenshotDir);
      let screensDeleted = 0;

      for (const entry of entries) {
        try {
          const fullPath = path.join(screenshotDir, entry);
          const stat = fs.statSync(fullPath);
          if (stat.isFile() && (now - stat.mtimeMs) > MAX_SCREENSHOT_AGE_MS) {
            fs.unlinkSync(fullPath);
            freedBytes += stat.size;
            screensDeleted++;
            filesDeleted++;
          }
        } catch { /* skip */ }
      }

      if (screensDeleted > 0) {
        log(`Cleaned ${screensDeleted} old screenshots (${(freedBytes / 1024).toFixed(0)} KB total freed)`, 'INFO');
      }
    }
  } catch (e: any) {
    logError('Screenshot cleanup failed', e);
  }

  // 3. Clean Chromium browser cache (often 50-150MB)
  try {
    const userDataDir = process.env.USER_DATA_DIR
      || path.join(getOs().tmpdir(), '.browser-data');
    if (fs.existsSync(userDataDir)) {
      const cacheDirs = ['Default/Cache', 'Default/Code Cache', 'Default/Service Worker/CacheStorage',
        'Default/GPUCache', 'GrShaderCache', 'ShaderCache', 'DawnGraphiteCache', 'DawnWebGPUCache'];
      for (const cacheDir of cacheDirs) {
        const fullPath = path.join(userDataDir, cacheDir);
        if (fs.existsSync(fullPath)) {
          const size = _recursiveSize(fullPath, fs);
          if (size > 0) {
            _rmrf(fullPath, fs);
            freedBytes += size;
            filesDeleted++;
          }
        }
      }
      // Also clean chromium temp files in the profile dir
      const entries = fs.readdirSync(userDataDir).filter((f: string) =>
        f.startsWith('Crashpad') || f.endsWith('.tmp') || f === 'lockfile');
      for (const entry of entries) {
        try {
          const fullPath = path.join(userDataDir, entry);
          const stat = fs.statSync(fullPath);
          if (stat.isFile()) {
            fs.unlinkSync(fullPath);
            freedBytes += stat.size;
            filesDeleted++;
          }
        } catch { /* skip */ }
      }
      if (freedBytes > 0) {
        log(`Cleaned browser cache (${(freedBytes / 1024).toFixed(0)} KB freed)`, 'INFO');
      }
    }
  } catch { /* non-critical */ }

  // 4. Clean old temp files in /tmp/ matching mathu-* pattern
  try {
    const os = getOs();
    const tmpDir = os.tmpdir();
    if (fs.existsSync(tmpDir)) {
      const now = Date.now();
      const entries = fs.readdirSync(tmpDir).filter((f: string) => f.startsWith('mathu-'));

      for (const entry of entries) {
        try {
          const fullPath = path.join(tmpDir, entry);
          const stat = fs.statSync(fullPath);
          // Only clean temp files older than 1 hour
          if (stat.isFile() && (now - stat.mtimeMs) > 60 * 60 * 1000) {
            // Never delete the manifest or shadow directory contents
            if (fullPath.startsWith(SHADOW_DIR)) continue;
            if (entry === 'manifest.json') continue;

            fs.unlinkSync(fullPath);
            freedBytes += stat.size;
            filesDeleted++;
          }
        } catch { /* skip */ }
      }
    }
  } catch { /* non-critical */ }

  if (filesDeleted > 0) {
    _cleanupCount++;
    log(`Cleanup #${_cleanupCount}: ${filesDeleted} files, ${(freedBytes / 1024).toFixed(0)} KB total freed`, 'INFO');
  }

  return { freedBytes, filesDeleted };
}

/**
 * Check disk space and trigger cleanup if needed.
 */
function checkDiskSpace(): void {
  const paths = getCriticalPaths();

  _diskUsagePercent = getDiskUsagePercent(paths.dbPath);
  _lastDiskCheck = Date.now();

  if (_diskUsagePercent < 0) {
    log('Unable to determine disk usage', 'DEBUG');
    return;
  }

  if (_diskUsagePercent > DISK_SPACE_CRITICAL_PERCENT) {
    log(`Disk usage CRITICAL: ${_diskUsagePercent.toFixed(1)}% — triggering emergency cleanup`, 'ERROR');
    const result = cleanupNonCriticalFiles();
    log(`Emergency cleanup freed ${(result.freedBytes / 1024).toFixed(0)} KB`, 'WARN');

    // Also push tombstone if disk is critically low
    try {
      const tombstone = (_deps as any).tombstone;
      if (tombstone?.pushTombstone) {
        tombstone.pushTombstone('disk_critical').catch(() => {});
      }
    } catch { /* non-critical */ }
  } else if (_diskUsagePercent > DISK_SPACE_LOW_PERCENT) {
    log(`Disk usage HIGH: ${_diskUsagePercent.toFixed(1)}% — preemptive cleanup`, 'WARN');
    cleanupNonCriticalFiles();
  }
}

// ─── Wipe Detection & Recovery Orchestrator ───

/**
 * Run a single wipe detection check. If wipe is detected, attempt recovery.
 * Returns the detection result.
 */
async function triggerShieldCheck(): Promise<{ wipeDetected: boolean; restored: boolean; details: string }> {
  const result = detectWipe();

  if (result.wipeDetected) {
    _wipeDetected = true;
    _wipeDetectedAt = Date.now();

    log(`DISK WIPE DETECTED: ${result.reason}`, 'ERROR');

    // Attempt shadow restoration
    const restoreResult = await restoreFromShadow();

    // Also try tombstone restoration if shadow fails
    if (!restoreResult.restored) {
      try {
        const tombstone = (_deps as any).tombstone;
        if (tombstone?.checkAndRestore) {
          const tombResult = await tombstone.checkAndRestore();
          if (tombResult.restored) {
            log('Fallback: restored from tombstone after shadow restoration failed', 'WARN');
            return { wipeDetected: true, restored: true, details: tombResult.details };
          }
        }
      } catch { /* non-critical */ }
    }

    return { wipeDetected: true, restored: restoreResult.restored, details: restoreResult.details };
  }

  return { wipeDetected: false, restored: false, details: result.reason };
}

/**
 * Initial check at startup — compare against previous manifest,
 * detect wipe, restore if needed.
 */
async function initialCheck(): Promise<{ wipeDetected: boolean; restored: boolean; details: string }> {
  log('Running initial ephemeral shield check...', 'INFO');

  // First, ensure we have a baseline manifest
  const manifest = buildManifest();

  // If running on Render, check if the DB file looks suspiciously fresh
  // (just created vs modified over time) — could indicate a wipe
  if (isRender()) {
    const paths = getCriticalPaths();
    const fs = getFs();

    try {
      if (fs.existsSync(paths.dbPath)) {
        const stat = fs.statSync(paths.dbPath);
        const uptimeS = process.uptime();
        // If DB was created AFTER process start (or within last few seconds)
        // AND process uptime > 30s, the DB was likely recreated by better-sqlite3
        // on a fresh deploy — this is a wipe event
        if (stat.birthtimeMs > (Date.now() - 60000) && uptimeS > 30) {
          log(`DB appears freshly created (${Math.round((Date.now() - stat.birthtimeMs) / 1000)}s ago, uptime ${Math.round(uptimeS)}s) — checking shadow`, 'WARN');
        }
      }
    } catch { /* non-critical */ }
  }

  return triggerShieldCheck();
}

// ─── Public API ───

/**
 * Start the ephemeral shield:
 *   1. Run initial wipe detection check
 *   2. Start periodic critical file sync (Tier 1)
 *   3. Start periodic manifest check (wipe detection)
 *   4. Start periodic disk space monitoring (Tier 3)
 */
async function start(): Promise<{ wipeDetected: boolean; restored: boolean }> {
  if (_started) {
    log('Ephemeral shield already running', 'WARN');
    return { wipeDetected: false, restored: false };
  }
  _started = true;

  const CONFIG = getCONFIG();
  const syncIntervalMs = (CONFIG.EPHEMERAL_SHIELD_SYNC_MS as number) || DEFAULT_SYNC_INTERVAL_MS;
  const manifestCheckMs = (CONFIG.EPHEMERAL_SHIELD_MANIFEST_MS as number) || DEFAULT_MANIFEST_CHECK_MS;
  const diskCheckMs = (CONFIG.EPHEMERAL_SHIELD_DISK_MS as number) || DEFAULT_DISK_CHECK_INTERVAL_MS;

  // 1. Initial check
  const initialResult = await initialCheck();

  // 2. Immediate first sync of critical files
  syncCriticalFiles();

  // 3. Periodic critical file sync (Tier 1 + Tier 2)
  let nonCriticalCounter = 0;
  _syncInterval = setInterval(() => {
    try {
      syncCriticalFiles();
      // Tier 2 every 3rd sync (to reduce I/O on Render)
      nonCriticalCounter++;
      if (nonCriticalCounter % 3 === 0) {
        syncNonCriticalFiles();
      }
    } catch (e: any) {
      logError('Periodic sync failed', e);
    }
  }, syncIntervalMs);

  if (_syncInterval && typeof _syncInterval.unref === 'function') {
    _syncInterval.unref();
  }

  // 4. Periodic manifest check (wipe detection)
  _manifestCheckInterval = setInterval(() => {
    try {
      triggerShieldCheck().catch((e: any) => logError('Shield check failed', e));
    } catch (e: any) {
      logError('Manifest check interval error', e);
    }
  }, manifestCheckMs);

  if (_manifestCheckInterval && typeof _manifestCheckInterval.unref === 'function') {
    _manifestCheckInterval.unref();
  }

  // 5. Periodic disk space monitoring (Tier 3)
  _diskCheckInterval = setInterval(() => {
    try {
      checkDiskSpace();
    } catch (e: any) {
      logError('Disk check interval error', e);
    }
  }, diskCheckMs);

  if (_diskCheckInterval && typeof _diskCheckInterval.unref === 'function') {
    _diskCheckInterval.unref();
  }

  log(
    `Ephemeral shield started (sync=${syncIntervalMs}ms, manifest=${manifestCheckMs}ms, disk=${diskCheckMs}ms, render=${isRender()})`,
    'INFO'
  );

  return { wipeDetected: initialResult.wipeDetected, restored: initialResult.restored };
}

/**
 * Stop all shield intervals.
 */
function stop(): void {
  if (_syncInterval) {
    clearInterval(_syncInterval);
    _syncInterval = null;
  }
  if (_manifestCheckInterval) {
    clearInterval(_manifestCheckInterval);
    _manifestCheckInterval = null;
  }
  if (_diskCheckInterval) {
    clearInterval(_diskCheckInterval);
    _diskCheckInterval = null;
  }
  _started = false;
  log('Ephemeral shield stopped', 'INFO');
}

/**
 * Get shield status for diagnostics.
 */
function getStatus(): Record<string, any> {
  const fs = getFs();
  const path = getPath();

  // Shadow directory stats
  let shadowExists = false;
  let shadowSizeBytes = 0;
  let shadowFileCount = 0;

  try {
    if (fs.existsSync(SHADOW_DIR)) {
      shadowExists = true;
      const entries = fs.readdirSync(SHADOW_DIR);
      shadowFileCount = entries.length;
      for (const entry of entries) {
        try {
          const stat = fs.statSync(path.join(SHADOW_DIR, entry));
          if (stat.isFile()) shadowSizeBytes += stat.size;
        } catch { /* skip */ }
      }
    }
  } catch { /* ok */ }

  // Manifest stats
  let manifestAgeMs = -1;
  try {
    if (fs.existsSync(MANIFEST_FILE)) {
      manifestAgeMs = Date.now() - fs.statSync(MANIFEST_FILE).mtimeMs;
    }
  } catch { /* ok */ }

  return {
    started: _started,
    isRender: isRender(),
    syncIntervalRunning: _syncInterval !== null,
    manifestCheckRunning: _manifestCheckInterval !== null,
    diskCheckRunning: _diskCheckInterval !== null,
    syncCount: _syncCount,
    wipeDetected: _wipeDetected,
    wipeDetectedAt: _wipeDetectedAt > 0 ? new Date(_wipeDetectedAt).toISOString() : 'never',
    lastDiskCheck: _lastDiskCheck > 0 ? new Date(_lastDiskCheck).toISOString() : 'never',
    diskUsagePercent: _diskUsagePercent > 0 ? _diskUsagePercent.toFixed(1) + '%' : 'unknown',
    cleanupCount: _cleanupCount,
    shadowDir: {
      exists: shadowExists,
      fileCount: shadowFileCount,
      sizeBytes: shadowSizeBytes,
      path: SHADOW_DIR,
    },
    manifestAgeMs,
    criticalPaths: getCriticalPaths(),
  };
}

module.exports = {
  start,
  stop,
  syncCriticalFiles,
  syncNonCriticalFiles,
  triggerShieldCheck,
  detectWipe,
  restoreFromShadow,
  checkDiskSpace,
  cleanupNonCriticalFiles,
  buildManifest,
  saveManifest,
  loadManifest,
  getStatus,
  _injectDependencies,
};
