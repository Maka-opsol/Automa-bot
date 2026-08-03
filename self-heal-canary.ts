'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const CONFIG = require('./get-config');

/**
 * Canary rollout system for self-heal patches.
 *
 * Improvements over original:
 *   - startCanary() accepts optional targetFile parameter
 *   - recordCycleResult() supports backup-based rollback (not just git branch)
 *   - recordCycleResult() has auto-hook: can be called from cycle-manager
 *   - getHealthStatus() for dashboard/monitoring integration
 *   - Proper error event recording on rollback
 */

const SOURCE_DIR = PROJECT_ROOT;

class CanaryRollout {
  constructor() {
    this._ensureTable();
  }

  _ensureTable() { 
    try {
      getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS patch_canary (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patch_id INTEGER NOT NULL,
          status TEXT DEFAULT 'canary',
          error_rate_baseline REAL NOT NULL,
          error_rate_observed REAL DEFAULT 0,
          cycles_run INTEGER DEFAULT 0,
          observation_window INTEGER DEFAULT 100,
          started_at INTEGER NOT NULL,
          promoted_at INTEGER,
          rolled_back_at INTEGER,
          rollback_reason TEXT,
          target_file TEXT,
          backup_path TEXT,
          UNIQUE(patch_id)
        );
        CREATE INDEX IF NOT EXISTS idx_canary_status ON patch_canary(status);
        CREATE INDEX IF NOT EXISTS idx_canary_patch ON patch_canary(patch_id);
      `);
    } catch (err: any) {
      logError('Failed to create patch_canary table', err);
    }
  }

  /**
   * Start a canary for a patch.
   *
   * @param {number} patchId           - Unique patch identifier (typically Date.now())
   * @param {number} errorRateBaseline - Current error rate (0-1) to compare against
   * @param {string} [targetFile]      - Target file(s) being patched (for audit trail)
   * @param {string} [backupPath]      - Path to backup that can be used for rollback
   * @returns {Object|null} The canary DB record, or null on failure
   */
  startCanary(patchId: any, errorRateBaseline: any, targetFile: any, backupPath: any) { 
    try {
      const now = Date.now();
      const observationWindow = CONFIG.CANARY_OBSERVATION_HOURS
        ? CONFIG.CANARY_OBSERVATION_HOURS * 12  // ~12 cycles/hour estimate
        : 100;

      const existing = getDb()?.prepare('SELECT id FROM patch_canary WHERE patch_id = ?').get(patchId);
      if (existing) {
        log(`Canary already exists for patch ${patchId}, resetting`, 'WARN', 'canary');
        getDb()?.prepare(
          'UPDATE patch_canary SET status = ?, error_rate_observed = 0, cycles_run = 0, started_at = ?, promoted_at = NULL, rolled_back_at = NULL, rollback_reason = NULL, target_file = ?, backup_path = ? WHERE patch_id = ?'
        ).run('canary', now, targetFile || null, backupPath || null, patchId);
        const record = getDb()?.prepare('SELECT * FROM patch_canary WHERE patch_id = ?').get(patchId);
        log(`Canary reset for patch ${patchId}`, 'INFO', 'canary');
        return record;
      }

      getDb()?.prepare(
        'INSERT INTO patch_canary (patch_id, status, error_rate_baseline, error_rate_observed, cycles_run, observation_window, started_at, target_file, backup_path) VALUES (?, ?, ?, 0, 0, ?, ?, ?, ?)'
      ).run(patchId, 'canary', errorRateBaseline, observationWindow, now, targetFile || null, backupPath || null);

      const record = getDb()?.prepare('SELECT * FROM patch_canary WHERE patch_id = ?').get(patchId);
      log(`Canary started for patch ${patchId} (baseline: ${errorRateBaseline}, window: ${observationWindow} cycles${targetFile ? ', target: ' + targetFile : ''})`, 'INFO', 'canary');
      logAudit(`Canary started: patch ${patchId}, target ${targetFile || 'unknown'}`, 'canary');
      return record;
    } catch (err: any) {
      logError('Failed to start canary', err);
      return null;
    }
  }

  /**
   * Determine if the current cycle should use canary code.
   * Returns routing decision for the cycle manager.
   */
  shouldUseCanaryCode() { 
    try {
      const active = getDb()?.prepare("SELECT * FROM patch_canary WHERE status = 'canary' ORDER BY started_at DESC LIMIT 1").get();

      if (!active) {
        return { useCanary: false, canaryId: null, patchId: null };
      }

      const chance = 1 / Math.max(10, CONFIG.CANARY_OBSERVATION_HOURS || 10);
      const useCanary = Math.random() < chance;

      if (useCanary) {
        log(`Canary routing: using canary code for patch ${active.patch_id} (1-in-${CONFIG.CANARY_OBSERVATION_HOURS || 10} chance)`, 'DEBUG', 'canary');
      }

      return { useCanary, canaryId: active.id, patchId: active.patch_id };
    } catch (err: any) {
      logError('Failed to check canary routing', err);
      return { useCanary: false, canaryId: null, patchId: null };
    }
  }

  /**
   * Record the result of a cycle for the active canary.
   *
   * This is designed to be called from the cycle-manager after each cycle
   * completes, so canary monitoring is automatic.
   *
   * If the error rate exceeds the threshold, triggers rollback:
   *   1. First tries backup-based rollback (file restore from backup_path)
   *   2. Falls back to GitOps rollback if backup not available
   *   3. Records the event in self_heal_events
   *
   * @param {number} canaryId - The canary record ID
   * @param {boolean} hadError - Whether the cycle had an error
   * @returns {{ action: string, reason?: string, errorRate?: number, cyclesRun?: number, remaining?: number }}
   */
  recordCanaryCycleResult(canaryId: any, hadError: any) { 
    try {
      const canary = getDb()?.prepare('SELECT * FROM patch_canary WHERE id = ?').get(canaryId);

      if (!canary) {
        return { action: 'not_found', reason: 'Canary record does not exist' };
      }

      if (canary.status !== 'canary') {
        return { action: 'inactive', reason: `Canary status is ${canary.status}, not 'canary'` };
      }

      const newCyclesRun = canary.cycles_run + 1;
      const newErrorRate = (canary.error_rate_observed * canary.cycles_run + (hadError ? 1 : 0)) / newCyclesRun;

      getDb()?.prepare(
        'UPDATE patch_canary SET error_rate_observed = ?, cycles_run = ? WHERE id = ?'
      ).run(newErrorRate, newCyclesRun, canaryId);

      const multiplier = CONFIG.CANARY_ERROR_RATE_MULTIPLIER || 2.0;

      // ── Error rate threshold exceeded → ROLLBACK ──
      if (newErrorRate > canary.error_rate_baseline * multiplier) {
        return this._rollbackCanary(canary, newErrorRate, newCyclesRun, multiplier);
      }

      // ── Observation window complete → PROMOTE ──
      if (newCyclesRun >= canary.observation_window) {
        return this._promoteCanary(canary, newErrorRate, newCyclesRun);
      }

      // ── Continue observing ──
      return {
        action: 'continue',
        errorRate: newErrorRate,
        cyclesRun: newCyclesRun,
        remaining: canary.observation_window - newCyclesRun,
      };
    } catch (err: any) {
      logError('Failed to record canary cycle result', err);
      return { action: 'error', reason: err.message };
    }
  }

  /**
   * Convenience: record result for the currently active canary.
   * Cycle-manager calls this with just (hadError) — it finds the active canary.
   *
   * @param {boolean} hadError
   * @returns {Object|null} Result from recordCanaryCycleResult, or null if no active canary
   */
  recordActiveCanaryResult(hadError: any) { 
    const active = this.getActiveCanary();
    if (!active) return null;
    return this.recordCanaryCycleResult(active.id, hadError);
  }

  getActiveCanary() { 
    try {
      const active = getDb()?.prepare("SELECT * FROM patch_canary WHERE status = 'canary' ORDER BY started_at DESC LIMIT 1").get();
      if (!active) return null;

      return {
        id: active.id,
        patchId: active.patch_id,
        status: active.status,
        errorRateBaseline: active.error_rate_baseline,
        errorRateObserved: active.error_rate_observed,
        cyclesRun: active.cycles_run,
        observationWindow: active.observation_window,
        progress: active.observation_window > 0 ? (active.cycles_run / active.observation_window * 100).toFixed(1) + '%' : 'N/A',
        startedAt: new Date(active.started_at).toISOString(),
        targetFile: active.target_file,
        backupPath: active.backup_path,
      };
    } catch (err: any) {
      logError('Failed to get active canary', err);
      return null;
    }
  }

  getCanaryHistory(limit = 50) { 
    try {
      const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
      return getDb()?.prepare('SELECT * FROM patch_canary ORDER BY started_at DESC LIMIT ?').all(safeLimit).map((row: any) => ({
        id: row.id,
        patchId: row.patch_id,
        status: row.status,
        errorRateBaseline: row.error_rate_baseline,
        errorRateObserved: row.error_rate_observed,
        cyclesRun: row.cycles_run,
        observationWindow: row.observation_window,
        startedAt: new Date(row.started_at).toISOString(),
        promotedAt: row.promoted_at ? new Date(row.promoted_at).toISOString() : null,
        rolledBackAt: row.rolled_back_at ? new Date(row.rolled_back_at).toISOString() : null,
        rollbackReason: row.rollback_reason,
        targetFile: row.target_file,
        backupPath: row.backup_path,
      }));
    } catch (err: any) {
      logError('Failed to get canary history', err);
      return [];
    }
  }

  cancelCanary(canaryId: any) { 
    try {
      const result = getDb()?.prepare("UPDATE patch_canary SET status = 'rolled_back', rolled_back_at = ?, rollback_reason = ? WHERE id = ? AND status = 'canary'").run(
        Date.now(), 'Manually cancelled', canaryId
      );
      if (result.changes > 0) {
        logAudit(`Canary ${canaryId} manually cancelled`, 'canary');
        return true;
      }
      return false;
    } catch (err: any) {
      logError('Failed to cancel canary', err);
      return false;
    }
  }

  /**
   * Get canary health status for the monitoring / dashboard endpoint.
   * Returns a summary suitable for inclusion in health check responses.
   */
  getHealthStatus() { 
    try {
      const active = this.getActiveCanary();
      const recentCount = getDb()?.prepare("SELECT COUNT(*) as count FROM patch_canary WHERE started_at > ?").get(Date.now() - 24 * 60 * 60 * 1000);
      const recentRollbacks = getDb()?.prepare("SELECT COUNT(*) as count FROM patch_canary WHERE status = 'rolled_back' AND rolled_back_at > ?").get(Date.now() - 24 * 60 * 60 * 1000);

      return {
        hasActiveCanary: !!active,
        activeCanary: active ? {
          patchId: active.patchId,
          targetFile: active.targetFile,
          progress: active.progress,
          errorRateObserved: active.errorRateObserved,
          errorRateBaseline: active.errorRateBaseline,
          cyclesRun: active.cyclesRun,
          observationWindow: active.observationWindow,
        } : null,
        last24h: {
          total: recentCount?.count || 0,
          rollbacks: recentRollbacks?.count || 0,
        },
      };
    } catch (err: any) {
      return { hasActiveCanary: false, error: err.message };
    }
  }

  // ─── Internal ───

  _rollbackCanary(canary: any, errorRate: any, cyclesRun: any, multiplier: any) { 
    const now = Date.now();
    const reason = `Error rate ${errorRate.toFixed(4)} exceeded baseline ${canary.error_rate_baseline.toFixed(4)} * ${multiplier} after ${cyclesRun} cycles`;

    getDb()?.prepare(
      'UPDATE patch_canary SET status = ?, rolled_back_at = ?, rollback_reason = ? WHERE id = ?'
    ).run('rolled_back', now, reason, canary.id);

    log(`CANARY ROLLBACK: Patch ${canary.patch_id} — ${reason}`, 'ERROR', 'canary');
    logAudit(`Canary rollback: patch ${canary.patch_id}, ${reason}`, 'canary');

    // Record event
    try {
      getDb()?.prepare(
        'INSERT INTO self_heal_events (feature_id, phase, timestamp, trigger_reason, investigation_result) VALUES (?, ?, ?, ?, ?)'
      ).run('canary', 'canary_rollback', now, reason, JSON.stringify({ canaryId: canary.id, errorRate, baseline: canary.error_rate_baseline, cyclesRun, targetFile: canary.target_file }));
    } catch (eventErr: any) { /* Non-fatal */ }

    // Primary: backup-based rollback (restore files from backup_path)
    let rollbackSucceeded = false;
    if (canary.backup_path && fs.existsSync(canary.backup_path)) {
      rollbackSucceeded = this._restoreFromBackup(canary.backup_path);
    }

    // Fallback: GitOps rollback
    if (!rollbackSucceeded) {
      try {
        const gitOps = require('./self-heal-gitops');
        gitOps.gitops.rollbackToPrevious();
        log('GitOps rollback triggered by canary (backup not available)', 'WARN', 'canary');
        rollbackSucceeded = true;
      } catch (rollbackErr: any) {
        logError('Both backup and GitOps rollback failed for canary', rollbackErr);
      }
    }

    return {
      action: 'rollback',
      reason,
      rollbackMethod: rollbackSucceeded ? (canary.backup_path ? 'backup' : 'gitops') : 'failed',
    };
  }

  _promoteCanary(canary: any, errorRate: any, cyclesRun: any) { 
    const now = Date.now();

    getDb()?.prepare(
      'UPDATE patch_canary SET status = ?, promoted_at = ? WHERE id = ?'
    ).run('promoted', now, canary.id);

    log(`CANARY PROMOTED: Patch ${canary.patch_id} passed observation (${cyclesRun} cycles, error rate: ${errorRate.toFixed(4)})`, 'INFO', 'canary');
    logAudit(`Canary promoted: patch ${canary.patch_id}, ${cyclesRun} cycles`, 'canary');

    try {
      getDb()?.prepare(
        'INSERT INTO self_heal_events (feature_id, phase, timestamp, trigger_reason, investigation_result) VALUES (?, ?, ?, ?, ?)'
      ).run('canary', 'canary_promoted', now, `Canary for patch ${canary.patch_id} promoted`, JSON.stringify({ canaryId: canary.id, errorRate, cyclesRun, targetFile: canary.target_file }));
    } catch (eventErr: any) { /* Non-fatal */ }

    return { action: 'promote', errorRate, cyclesRun };
  }

  /**
   * Restore files from a backup directory.
   * @private
   * @param {string} backupPath
   * @returns {boolean}
   */
  _restoreFromBackup(backupPath: any) { 
    try {
      if (!fs.existsSync(backupPath)) return false;

      const entries = fs.readdirSync(backupPath, { recursive: false });
      let restored = 0;

      for (const entry of entries) {
        const src = path.join(backupPath, entry);
        const lstat = fs.lstatSync(src);

        if (lstat.isSymbolicLink()) continue; // Skip symlinks entirely
        if (lstat.isFile()) {
          const dest = path.join(SOURCE_DIR, entry);
          if (!dest.startsWith(SOURCE_DIR + path.sep) && dest !== SOURCE_DIR) continue; // Path traversal check
          const destDir = path.dirname(dest);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          fs.copyFileSync(src, dest);
          restored++;
        } else if (lstat.isDirectory()) {
          // Recursively copy directory contents
          this._copyDirRecursive(src, path.join(SOURCE_DIR, entry));
        }
      }

      log(`Canary backup rollback: restored ${restored} files from ${backupPath}`, 'INFO', 'canary');
      return restored > 0;
    } catch (err: any) {
      logError('Canary backup rollback failed', err);
      return false;
    }
  }

  _copyDirRecursive(srcDir: any, destDir: any) {
    const resolvedDestDir = path.resolve(destDir);
    if (!resolvedDestDir.startsWith(SOURCE_DIR + path.sep) && resolvedDestDir !== SOURCE_DIR) return;
    if (!fs.existsSync(resolvedDestDir)) fs.mkdirSync(resolvedDestDir, { recursive: true });
    for (const entry of fs.readdirSync(srcDir)) {
      const src = path.join(srcDir, entry);
      if (fs.lstatSync(src).isSymbolicLink()) continue; // Skip symlinks
      const dest = path.join(resolvedDestDir, entry);
      const resolvedDest = path.resolve(dest);
      if (!resolvedDest.startsWith(SOURCE_DIR + path.sep) && resolvedDest !== SOURCE_DIR) continue;
      if (fs.statSync(src).isDirectory()) {
        this._copyDirRecursive(src, dest);
      } else {
        fs.copyFileSync(src, dest);
      }
    }
  }
}

const canaryRollout = new CanaryRollout();

module.exports = {
  canaryRollout,
  CanaryRollout,
  startCanary: (patchId: any, errorRateBaseline: any, targetFile: any, backupPath: any) => canaryRollout.startCanary(patchId, errorRateBaseline, targetFile, backupPath),
  shouldUseCanaryCode: () => canaryRollout.shouldUseCanaryCode(),
  recordCanaryCycleResult: (canaryId: any, hadError: any) => canaryRollout.recordCanaryCycleResult(canaryId, hadError),
  recordActiveCanaryResult: (hadError: any) => canaryRollout.recordActiveCanaryResult(hadError),
  getActiveCanary: () => canaryRollout.getActiveCanary(),
  getCanaryHistory: (limit: any) => canaryRollout.getCanaryHistory(limit),
  cancelCanary: (canaryId: any) => canaryRollout.cancelCanary(canaryId),
  getHealthStatus: () => canaryRollout.getHealthStatus(),
  _injectDependencies,
};