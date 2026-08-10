'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Use DI-provided config when available, fall back to direct require.
// Both reference the same frozen CONFIG object.
const CONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] ?? require('./get-config')[prop] });

const SOURCE_DIR = PROJECT_ROOT;
const CODE_FILES = [
  'agent.ts', 'config.ts', 'logger.ts', 'state-machine.ts', 'database.ts', 'cache.ts',
  'browser.ts', 'auth.ts', 'services-ip-check.ts', 'alerting.ts', 'progress-tracker.ts',
  'captcha-solver-external.ts', 'self-heal.ts', 'self-heal-gitops.ts',
  'self-heal-auditor.ts', 'sandbox-executor.ts', 'failsafe-coordinator.ts',
  'cycle-cycle-manager.ts', 'cycle-auth-guard.ts', 'cycle-action-executor.ts', 'cycle-stagnation.ts',
  'cycle-module-tracking.ts', 'cycle-config-updater.ts', 'cycle-ui-prompt-updater.ts',
  'providers-base.ts', 'providers-config-loader.ts', 'providers-registry.ts',
  'providers-github-gpt.ts', 'providers-groq.ts', 'providers-zai.ts', 'providers-agnes.ts',
  'providers-nvidia.ts', 'providers-cloudflare.ts', 'providers-cerebras.ts', 'providers-gemini.ts',
  'providers-vision-pipeline.ts', 'providers-tribunal.ts', 'providers-prompts.ts', 'providers-stats.ts',
  'providers.ts', 'providers-fallback.ts',
  'providers-detection-work-detector.ts', 'providers-detection-captcha-solver.ts',
  'providers-detection-signin-button.ts', 'providers-detection-collapsed-cards.ts',
  'providers-detection-module-completion.ts', 'providers-detection-captcha-text-extractor.ts',
  'providers-codegen-mistral.ts', 'providers-codegen-qwen.ts', 'providers-codegen-deepseek.ts',
  'providers-codegen-openrouter.ts', 'providers-codegen-tribunal.ts'
];

let _monitoringTimer: any = null;
let _monitoringRunning = false;

/**
 * SECURITY: Pure-JS unified diff applier — no shell, no child_process.
 * Only handles simple context diffs (no binary, no ed-style).
 * Returns true on success, false on any failure.
 */
function applyUnifiedDiffSafe(filePath: string, diffText: string): boolean {
  try {
    if (!fs.existsSync(filePath)) return false;
    const original = fs.readFileSync(filePath, 'utf-8');
    const lines = original.split('\n');
    const diffLines = diffText.split('\n');

    // Parse hunks: collect {oldStart, oldCount, newLines, oldLines}
    interface Hunk { oldStart: number; oldCount: number; newLines: string[]; oldLines: string[] }
    const hunks: Hunk[] = [];
    let current: Hunk | null = null;

    for (const dl of diffLines) {
      // Match @@ -oldStart,oldCount +newStart,newCount @@
      const hunkMatch = dl.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(?:\d+)(?:,(?:\d+))?\s+@@/);
      if (hunkMatch) {
        if (current) hunks.push(current);
        current = { oldStart: parseInt(hunkMatch[1], 10), oldCount: parseInt(hunkMatch[2] || '1', 10), newLines: [], oldLines: [] };
        continue;
      }
      if (!current) continue;
      if (dl.startsWith('+')) current.newLines.push(dl.substring(1));
      else if (dl.startsWith('-')) current.oldLines.push(dl.substring(1));
      else if (dl.startsWith(' ') || dl === '') { current.newLines.push(dl.startsWith(' ') ? dl.substring(1) : dl); current.oldLines.push(dl.startsWith(' ') ? dl.substring(1) : dl); }
      // Ignore diff headers (---, +++, context-only lines)
    }
    if (current) hunks.push(current);

    // Apply hunks in reverse order so line offsets don't shift
    for (let i = hunks.length - 1; i >= 0; i--) {
      const hunk = hunks[i];
      const idx = hunk.oldStart - 1; // 1-indexed to 0-indexed
      if (idx < 0 || idx > lines.length) return false;
      // Verify old lines match
      for (let j = 0; j < hunk.oldLines.length; j++) {
        if (lines[idx + j] !== hunk.oldLines[j]) {
          log(`Diff context mismatch at line ${idx + j + 1} for ${filePath}`, 'WARN', 'self-deploy');
          return false;
        }
      }
      // Replace
      lines.splice(idx, hunk.oldCount, ...hunk.newLines);
    }

    // Atomic write
    const tmpPath = path.join(os.tmpdir(), `diff-${path.basename(filePath)}-${Date.now()}.tmp`);
    fs.writeFileSync(tmpPath, lines.join('\n'), 'utf-8');
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (err: any) {
    logError(`Pure-JS diff apply failed for ${filePath}`, err);
    return false;
  }
}

class SelfDeploy {
  corruptedFiles: any;

  constructor() {
  }

  _logEvent(phase: any, triggerReason: any) { 
    try {
      getDb()?.prepare('INSERT INTO self_heal_events (feature_id, phase, timestamp, trigger_reason) VALUES (?, ?, ?, ?)')
        .run('self-deploy', phase, Date.now(), triggerReason);
    } catch (err: any) {
      logError('Failed to log self-heal event', err);
    }
  }

  /**
   * Compute SHA-256 hash of a file.
   */
  _hashFile(filePath: any) { 
    try {
      if (!fs.existsSync(filePath)) return null;
      const content = fs.readFileSync(filePath, 'utf-8');
      return crypto.createHash('sha256').update(content, 'utf-8').digest('hex');
    } catch (err: any) {
      logError(`Failed to hash file: ${filePath}`, err);
      return null;
    }
  }

  /**
   * Compute the full codebase hash manifest.
   * @returns {object} Map of filename -> sha256 hash
   */
  computeManifest() { 
    try {
      const manifest = {};
      for (const file of CODE_FILES) {
        const filePath = path.join(SOURCE_DIR, file);
        const hash = this._hashFile(filePath);
        if (hash) {
          (manifest as any)[file] = hash;
        }
      }
      return manifest;
    } catch (err: any) {
      logError('Error computing codebase manifest', err);
      return {};
    }
  }

  /**
   * Verify codebase integrity by comparing current file hashes against stored manifest.
   */
  verifyCodebaseIntegrity() { 
    try {
      const currentManifest = this.computeManifest();

      // Load stored manifest
      let storedManifest = {};
      try {
        const row = getDb()?.prepare("SELECT value FROM calibration WHERE key = 'codebase_manifest'").get();
        if (row && row.value) {
          storedManifest = JSON.parse(row.value);
        }
      } catch (parseErr: any) {
        logError('Failed to parse stored manifest', parseErr);
      }

      // If no stored manifest, store current and report intact
      if (Object.keys(storedManifest).length === 0) {
        log('No stored manifest found, creating baseline', 'INFO', 'self-deploy');
        this.updateManifest(currentManifest);
        return { intact: true, corruptedFiles: [], manifestMismatch: false };
      }

      // Compare
      const corruptedFiles = [];
      const allFiles = new Set([...Object.keys(currentManifest), ...Object.keys(storedManifest)]);

      for (const file of allFiles) {
        const currentHash = (currentManifest as any)[file];
        const storedHash = (storedManifest as any)[file];

        if (!currentHash && storedHash) {
          // File was deleted
          corruptedFiles.push({ file, issue: 'missing' });
        } else if (currentHash && !storedHash) {
          // New file (not necessarily corruption, but a mismatch)
          corruptedFiles.push({ file, issue: 'unexpected_new' });
        } else if (currentHash !== storedHash) {
          // Hash mismatch - file was modified
          corruptedFiles.push({ file, issue: 'hash_mismatch', currentHash, storedHash });
        }
      }

      const intact = corruptedFiles.length === 0;
      const manifestMismatch = !intact;

      if (intact) {
        log('Codebase integrity verified: all files match stored manifest', 'INFO', 'self-deploy');
      } else {
        log(`Codebase integrity violation: ${corruptedFiles.length} files affected`, 'ERROR', 'self-deploy');
        for (const cf of corruptedFiles) {
          log(`  - ${cf.file}: ${cf.issue}`, 'ERROR', 'self-deploy');
        }
      }

      return { intact, corruptedFiles, manifestMismatch };
    } catch (err: any) {
      logError('Error verifying codebase integrity', err);
      return { intact: false, corruptedFiles: [], manifestMismatch: false, error: err.message };
    }
  }

  /**
   * Update the stored codebase manifest.
   */
  updateManifest(manifest: any) { 
    try {
      const manifestToStore = manifest || this.computeManifest();
      getDb()?.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
        .run('codebase_manifest', JSON.stringify(manifestToStore), Date.now());
      log(`Codebase manifest updated (${Object.keys(manifestToStore).length} files)`, 'INFO', 'self-deploy');
    } catch (err: any) {
      logError('Error updating manifest', err);
    }
  }

  /**
   * Find the most recent backup and restore files from it.
   * Re-applies only successful self-heal patches from patch_memory.
   */
  async restoreFromBackup() { 
    try {
      const backupDir = CONFIG.SELF_HEAL_BACKUP_DIR;
      if (!backupDir) {
        log('No SELF_HEAL_BACKUP_DIR configured', 'ERROR', 'self-deploy');
        return { restored: false, filesRestored: 0, error: 'No backup directory configured' };
      }

      if (!fs.existsSync(backupDir)) {
        log(`Backup directory does not exist: ${backupDir}`, 'ERROR', 'self-deploy');
        return { restored: false, filesRestored: 0, error: 'Backup directory missing' };
      }

      // Find most recent backup
      const entries = fs.readdirSync(backupDir)
        .filter((f: any) => f.startsWith('backup-') && fs.statSync(path.join(backupDir, f)).isDirectory())
        .sort((a: any, b: any) => {
          const numA = parseInt((a.match(/\d+/) || ['0'])[0], 10) || 0;
          const numB = parseInt((b.match(/\d+/) || ['0'])[0], 10) || 0;
          return numB - numA;
        });

      if (entries.length === 0) {
        log('No backups found', 'ERROR', 'self-deploy');
        return { restored: false, filesRestored: 0, error: 'No backups available' };
      }

      const latestBackup = path.join(backupDir, entries[0]);
      log(`Restoring from backup: ${latestBackup}`, 'INFO', 'self-deploy');
      this._logEvent('backup_restore', `Restoring from ${latestBackup}`);

      // Verify backup integrity first
      const backupIntegrity = this._verifyBackupIntegrity(latestBackup);
      if (!backupIntegrity.intact) {
        log(`Backup ${latestBackup} is also corrupted: ${(backupIntegrity as any).corruptedFiles.length} files`, 'ERROR', 'self-deploy');
        this._logEvent('backup_restore_failed', `Backup corrupted: ${latestBackup}`);
        return { restored: false, filesRestored: 0, error: 'Backup is corrupted' };
      }

      // Copy files from backup to source
      let filesRestored = 0;
      for (const file of CODE_FILES) {
        const src = path.join(latestBackup, file);
        const dest = path.join(SOURCE_DIR, file);

        if (fs.existsSync(src)) {
          const destDir = path.dirname(dest);
          if (!fs.existsSync(destDir)) {
            fs.mkdirSync(destDir, { recursive: true });
          }
          fs.copyFileSync(src, dest);
          filesRestored++;
        }
      }

      // Re-apply successful self-heal patches
      const patchesReapplied = await this._reapplySuccessfulPatches();

      log(`Restored ${filesRestored} files from backup, reapplied ${patchesReapplied} patches`, 'INFO', 'self-deploy');
      this._logEvent('backup_restore', `Restored ${filesRestored} files, ${patchesReapplied} patches from ${latestBackup}`);

      // Update manifest after restore
      this.updateManifest(null as any);

      return { restored: true, filesRestored, patchesReapplied, backupPath: latestBackup };
    } catch (err: any) {
      logError('Error restoring from backup', err);
      this._logEvent('backup_restore_failed', err.message);
      return { restored: false, filesRestored: 0, error: err.message };
    }
  }

  /**
   * Verify a backup directory's integrity.
   */
  _verifyBackupIntegrity(backupPath: any) { 
    try {
      let presentCount = 0;
      const missing = [];

      for (const file of CODE_FILES) {
        const filePath = path.join(backupPath, file);
        if (fs.existsSync(filePath)) {
          presentCount++;
        } else {
          missing.push(file);
        }
      }

      // A backup with less than 50% of files is considered corrupted
      const intact = presentCount >= CODE_FILES.length * 0.5;

      return {
        intact,
        filesPresent: presentCount,
        filesTotal: CODE_FILES.length,
        missingFiles: missing
      };
    } catch (err: any) {
      logError('Error verifying backup integrity', err);
      return { intact: false, filesPresent: 0, filesTotal: CODE_FILES.length, missingFiles: [] };
    }
  }

  /**
   * Re-apply only the successful self-heal patches from patch_history.
   * SECURITY: Each patch is re-validated through the sandbox executor's
   * auditPatchContent() before being applied, even if it was previously
   * marked as 'applied'. This prevents replay of malicious patches that
   * may have slipped through a prior sandbox bypass (e.g. SELF_HEAL_ALLOW_ALL).
   */
  async _reapplySuccessfulPatches() { 
    try {
      const patches = getDb()?.prepare(
        "SELECT * FROM patch_history WHERE status = 'applied' ORDER BY timestamp ASC"
      ).all();

      // Lazy-load sandbox audit functions (avoids top-level require issues)
      let auditPatchContent: ((code: string) => { safe: boolean; violations: string[] }) | null = null;
      try {
        const sandbox = require('./sandbox-executor');
        auditPatchContent = sandbox.auditPatchContent;
      } catch (e: any) {
        log('Sandbox executor not available for patch re-validation — skipping content audit', 'WARN', 'self-deploy');
      }

      let reapplied = 0;
      let skipped = 0;
      for (const patch of patches) {
        try {
          if (!patch.file || !patch.patch) continue;

          const resolvedFilePath = path.resolve(SOURCE_DIR, patch.file);
          if (!resolvedFilePath.startsWith(SOURCE_DIR + path.sep)) continue;
          if (!fs.existsSync(resolvedFilePath)) continue;

          // Verify patch is in allowed scope (must match sandbox-executor's ALLOWED_PREFIXES)
          const ALLOWED_PREFIXES = ['selectors-', 'providers-detection-', 'cycle-', 'utils-'];
          const isAllowed = ALLOWED_PREFIXES.some(p => patch.file.startsWith(p));
          if (!isAllowed) continue;

          // SECURITY: Re-validate patch content through sandbox audit before applying.
          // This catches patches that were stored before a sandbox bypass was fixed,
          // or patches that were applied via SELF_HEAL_ALLOW_ALL without proper validation.
          if (auditPatchContent) {
            const audit = auditPatchContent(patch.patch);
            if (!audit.safe) {
              log(`Skipping replay of patch ${patch.id} for ${patch.file}: content audit failed (${audit.violations.length} violations)`, 'WARN', 'self-deploy');
              skipped++;
              continue;
            }
          }

          // Apply the stored patch content to the file
          if (patch.patch.startsWith('---')) {
            // SECURITY: Use pure-JS diff application instead of execFile('patch')
            // to eliminate command injection via patch content
            const applyResult = applyUnifiedDiffSafe(resolvedFilePath, patch.patch);
            if (applyResult) {
              reapplied++;
            } else {
              log(`Failed to re-apply diff patch for ${patch.file}`, 'WARN', 'self-deploy');
            }
          } else {
            // Full file replacement — only allowed if content audit passed above
            const tmpPath = path.join(os.tmpdir(), `deploy-${patch.file}-${Date.now()}.tmp`);
            fs.writeFileSync(tmpPath, patch.patch, 'utf-8');
            fs.renameSync(tmpPath, resolvedFilePath);
            reapplied++;
          }
        } catch (patchErr: any) {
          logError(`Error re-applying patch ${patch.id}`, patchErr);
        }
      }

      if (skipped > 0) {
        log(`Skipped ${skipped} patches due to failed content audit during replay`, 'WARN', 'self-deploy');
      }

      return reapplied;
    } catch (err: any) {
      logError('Error re-applying successful patches', err);
      return 0;
    }
  }

  /**
   * Redeploy the bot from the configured git remote.
   * Fetches latest from origin/main and checks out all files,
   * then re-applies successful self-heal patches.
   */
  async redeployFromGit() { 
    try {
      const gitDir = path.join(SOURCE_DIR, '.git');
      if (!fs.existsSync(gitDir)) {
        log('No .git directory found, cannot redeploy from git', 'ERROR', 'self-deploy');
        return { redeployed: false, patchesReapplied: 0, error: 'No git repository' };
      }

      log('Starting git redeploy from origin/main...', 'INFO', 'self-deploy');
      this._logEvent('git_redeploy', 'Starting git redeploy');

      // Fetch from origin
      try {
        await execPromise('git fetch origin main', { cwd: SOURCE_DIR, timeout: 60000 });
        log('Git fetch origin/main succeeded', 'INFO', 'self-deploy');
      } catch (fetchErr: any) {
        logError('Git fetch failed', fetchErr);
        this._logEvent('git_redeploy_failed', `Fetch failed: ${fetchErr.message}`);
        return { redeployed: false, patchesReapplied: 0, error: `Git fetch failed: ${fetchErr.message}` };
      }

      // Checkout all files from origin/main
      try {
        await execPromise('git checkout origin/main -- .', { cwd: SOURCE_DIR, timeout: 60000 });
        log('Git checkout origin/main -- . succeeded', 'INFO', 'self-deploy');
      } catch (checkoutErr: any) {
        logError('Git checkout failed', checkoutErr);
        this._logEvent('git_redeploy_failed', `Checkout failed: ${checkoutErr.message}`);
        return { redeployed: false, patchesReapplied: 0, error: `Git checkout failed: ${checkoutErr.message}` };
      }

      // Re-apply successful self-heal patches
      const patchesReapplied = await this._reapplySuccessfulPatches();

      log(`Git redeploy complete, ${patchesReapplied} patches reapplied`, 'INFO', 'self-deploy');
      this._logEvent('git_redeploy', `Redeployed from git, ${patchesReapplied} patches reapplied`);

      // Update manifest
      this.updateManifest(null as any);

      return { redeployed: true, patchesReapplied };
    } catch (err: any) {
      logError('Error during git redeploy', err);
      this._logEvent('git_redeploy_failed', err.message);
      return { redeployed: false, patchesReapplied: 0, error: err.message };
    }
  }

  /**
   * Full recovery sequence:
   * 1. Verify integrity
   * 2. If intact: no action
   * 3. Try backup restore
   * 4. If backup also corrupted: try git redeploy
   * 5. If all fail: alert UNRECOVERABLE, enter HIBERNATION
   */
  async fullRecovery() { 
    log('Starting full recovery sequence', 'WARN', 'self-deploy');
    this._logEvent('full_recovery', 'Starting full recovery');

    // Step 1: Verify integrity
    const integrity = this.verifyCodebaseIntegrity();

    if (integrity.intact) {
      log('Codebase is intact, no recovery needed', 'INFO', 'self-deploy');
      this._logEvent('full_recovery', 'No recovery needed - codebase intact');
      return { recovered: false, reason: 'intact', action: 'none' };
    }

    log(`Codebase corruption detected: ${integrity.corruptedFiles.length} files affected`, 'ERROR', 'self-deploy');
    try { getSendAlert()(`Codebase corruption detected: ${integrity.corruptedFiles.length} files affected. Starting recovery.`, 1); } catch (e: any) {}

    // Step 2: Try backup restore
    log('Attempting backup restore...', 'WARN', 'self-deploy');
    const backupResult = await this.restoreFromBackup();

    if (backupResult.restored) {
      // Verify the restore actually fixed things
      const postRestoreIntegrity = this.verifyCodebaseIntegrity();
      if (postRestoreIntegrity.intact) {
        log('Full recovery successful via backup restore', 'INFO', 'self-deploy');
        this._logEvent('full_recovery', `Recovered via backup: ${backupResult.filesRestored} files`);
        try { getSendAlert()('Codebase recovered successfully from backup.', 3); } catch (e: any) {}
        return { recovered: true, reason: 'backup', action: 'backup_restore', details: backupResult };
      }

      log('Backup restore did not fix all corruption, trying git...', 'WARN', 'self-deploy');
    }

    // Step 3: Try git redeploy
    log('Attempting git redeploy...', 'WARN', 'self-deploy');
    const gitResult = await this.redeployFromGit();

    if (gitResult.redeployed) {
      const postGitIntegrity = this.verifyCodebaseIntegrity();
      if (postGitIntegrity.intact) {
        log('Full recovery successful via git redeploy', 'INFO', 'self-deploy');
        this._logEvent('full_recovery', `Recovered via git: ${gitResult.patchesReapplied} patches reapplied`);
        try { getSendAlert()('Codebase recovered successfully from git redeploy.', 3); } catch (e: any) {}
        return { recovered: true, reason: 'git', action: 'git_redeploy', details: gitResult };
      }

      log('Git redeploy did not fully resolve corruption', 'ERROR', 'self-deploy');
    }

    // Step 4: UNRECOVERABLE
    log('UNRECOVERABLE: All recovery methods failed', 'ERROR', 'self-deploy');
    try { getSendAlert()('UNRECOVERABLE: Codebase corruption cannot be fixed. Entering HIBERNATION.', 1); } catch (e: any) {}
    this._logEvent('full_recovery', 'UNRECOVERABLE - all methods failed');

    // Enter DORMANT (level 4) via degradation ladder
    // FIX: setMode() does not exist — use setLevel(4, reason)
    try {
      const { degradationLadder } = require('./self-heal-degradation-ladder');
      degradationLadder.setLevel(4, 'UNRECOVERABLE codebase corruption');
    } catch (err: any) {
      logError('Failed to enter DORMANT mode', err);
    }

    return { recovered: false, reason: 'unrecoverable', action: 'hibernation' };
  }

  /**
   * Start periodic integrity monitoring.
   * @param {number} intervalMs - Check interval (default 6 hours)
   */
  startMonitoring(intervalMs: any) { 
    try {
      const interval = intervalMs != null ? intervalMs : 6 * 60 * 60 * 1000;

      _monitoringTimer = setInterval(async () => {
        if (_monitoringRunning) return;
        _monitoringRunning = true;
        try {
          const integrity = this.verifyCodebaseIntegrity();

          if (!integrity.intact) {
            log(`Periodic integrity check detected corruption: ${integrity.corruptedFiles.length} files`, 'ERROR', 'self-deploy');
            await this.fullRecovery();
          }
        } catch (err: any) {
          logError('Error in periodic integrity monitoring', err);
        } finally {
          _monitoringRunning = false;
        }
      }, interval);

      if (_monitoringTimer && _monitoringTimer.unref) _monitoringTimer.unref();

      log(`Self-deploy integrity monitoring started (interval: ${Math.round(interval / 60000)}min)`, 'INFO', 'self-deploy');
    } catch (err: any) {
      logError('Failed to start self-deploy monitoring', err);
    }
  }

  stop() { 
    if (_monitoringTimer) {
      clearInterval(_monitoringTimer);
      _monitoringTimer = null;
      _monitoringRunning = false;
      log('Self-deploy monitoring stopped', 'INFO', 'self-deploy');
    }
  }
}

const selfDeploy = new SelfDeploy();
module.exports = { SelfDeploy, selfDeploy , _injectDependencies };
