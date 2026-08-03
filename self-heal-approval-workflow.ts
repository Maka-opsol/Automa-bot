'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

const CONFIG = require('./get-config');

/**
 * Approval workflow for restricted-file patches.
 *
 * When the sandbox determines a patch targets a RESTRICTED file
 * (self-heal.js, browser.js, state-machine.js, etc.), it cannot be
 * applied immediately.  Instead it enters a pending-approval queue.
 *
 * Approval gates (all must pass for the patch to proceed):
 *   1. AI auditor supermajority (>= 2/3 of auditors must vote "safe")
 *   2. Cooling-off timer (default 5 min, configurable via SELF_HEAL_APPROVAL_COOLDOWN_MS)
 *   3. No veto from any single auditor (unanimous "not dangerous")
 *
 * The system is designed for autonomous operation — there is no human
 * in the loop.  The "approval" comes from multiple independent AI
 * auditors agreeing the patch is safe, combined with a time delay
 * that allows any monitoring subsystem to raise an alarm.
 *
 * All actions are recorded in the `patch_approvals` DB table for
 * full audit trail.
 */

// ─── Approval Status Constants ───
const APPROVAL_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
  CANCELLED: 'cancelled',
});

class PatchApprovalQueue {
  _db: any;
  _expirationTimer: any;

  constructor(db: any) {
    this._db = db;
    this._ensureTable();
    this._expirationTimer = null;
    this._startExpirationLoop();
  }

  // ─── Schema ───

  _ensureTable() { 
    try {
      this._db.exec(`
        CREATE TABLE IF NOT EXISTS patch_approvals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patch_id TEXT NOT NULL UNIQUE,
          target_file TEXT NOT NULL,
          patch_hash TEXT NOT NULL,
          patch_size INTEGER NOT NULL,
          status TEXT DEFAULT 'pending',
          requested_at INTEGER NOT NULL,
          decided_at INTEGER,
          decided_by TEXT,
          rejection_reason TEXT,
          auditor_votes TEXT,
          cooling_off_until INTEGER,
          metadata TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_approval_status ON patch_approvals(status);
        CREATE INDEX IF NOT EXISTS idx_approval_file ON patch_approvals(target_file);
        CREATE INDEX IF NOT EXISTS idx_approval_requested ON patch_approvals(requested_at);
      `);
    } catch (err: any) {
      logError('Failed to create patch_approvals table', err);
    }
  }

  // ─── Public API ───

  /**
   * Request approval for a patch that targets a restricted file.
   *
   * @param {Object} params
   * @param {string} params.patchId       - Unique identifier for this patch request
   * @param {string} params.targetFile    - Relative file path being patched
   * @param {string} params.patchHash     - SHA-256 hash of the patch content (for integrity)
   * @param {number} params.patchSize     - Size of the patch in bytes
   * @param {Object} [params.metadata]    - Extra context (generating model, error context, etc.)
   * @returns {{ id: number, status: string, coolingOffUntil: number }}
   */
  requestApproval({ patchId, targetFile, patchHash, patchSize, metadata }: { patchId: string; targetFile: string; patchHash: string; patchSize: number; metadata?: Record<string, unknown> }) {
    const now = Date.now();
    const cooldownMs = CONFIG.SELF_HEAL_APPROVAL_COOLDOWN_MS || (5 * 60 * 1000);
    const coolingOffUntil = now + cooldownMs;

    try {
      this._db.prepare(`
        INSERT INTO patch_approvals (patch_id, target_file, patch_hash, patch_size, status, requested_at, cooling_off_until, metadata)
        VALUES(?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(patchId, targetFile, patchHash, patchSize, now, coolingOffUntil, metadata ? JSON.stringify(metadata) : null);

      const row = this._db.prepare('SELECT id, status, cooling_off_until FROM patch_approvals WHERE patch_id = ?').get(patchId);

      logAudit(`Approval requested for restricted file "${targetFile}" (patch ${patchId}, cooldown ${cooldownMs / 1000}s)`, 'approval-workflow');

      return {
        id: row.id,
        status: row.status,
        coolingOffUntil: row.cooling_off_until,
      };
    } catch (err: any) {
      logError('Failed to create approval request', err);
      throw new Error(`Approval request failed: ${err.message}`);
    }
  }

  /**
   * Submit auditor votes and decide approval.
   *
   * Decision logic:
   *   - If any auditor votes "dangerous" → REJECTED (single veto)
   *   - If >= 2/3 of auditors vote "safe" AND cooling-off has elapsed → APPROVED
   *   - If >= 2/3 vote "safe" BUT cooling-off hasn't elapsed → stays PENDING
   *   - Otherwise → REJECTED (insufficient support)
   *
   * @param {string} patchId
   * @param {Array<{ auditor: string, safe: boolean, reason: string }>} votes
   * @returns {{ approved: boolean, status: string, reason: string }}
   */
  submitVotes(patchId: any, votes: any) { 
    const row = this._db.prepare('SELECT * FROM patch_approvals WHERE patch_id = ?').get(patchId);
    if (!row) {
      return { approved: false, status: 'not_found', reason: `No approval request found for ${patchId}` };
    }
    if (row.status !== APPROVAL_STATUS.PENDING) {
      return { approved: false, status: row.status, reason: `Approval already ${row.status}` };
    }

    // Store votes
    const votesJson = JSON.stringify(votes);
    const now = Date.now();

    // Single-veto check: if ANY auditor says dangerous, reject immediately
    const veto = votes.find((v: any) => !v.safe);
    if (veto) {
      this._updateStatus(patchId, APPROVAL_STATUS.REJECTED, 'auto-veto', `Vetoed by auditor "${veto.auditor}": ${veto.reason}`, votesJson, now);
      logAudit(`Approval VETOED for patch ${patchId} by "${veto.auditor}": ${veto.reason}`, 'approval-workflow');
      return { approved: false, status: APPROVAL_STATUS.REJECTED, reason: `Vetoed by auditor "${veto.auditor}": ${veto.reason}` };
    }

    // Supermajority check: need >= 2/3 safe votes
    const totalVotes = votes.length;
    const safeVotes = votes.filter((v: any) => v.safe).length;
    const threshold = Math.ceil(totalVotes * 2 / 3);

    if (safeVotes < threshold) {
      const reason = `Insufficient support: ${safeVotes}/${totalVotes} safe (need ${threshold})`;
      this._updateStatus(patchId, APPROVAL_STATUS.REJECTED, 'auto-insufficient', reason, votesJson, now);
      logAudit(`Approval REJECTED for patch ${patchId}: ${reason}`, 'approval-workflow');
      return { approved: false, status: APPROVAL_STATUS.REJECTED, reason };
    }

    // Supermajority achieved — check cooling-off period
    if (now < row.cooling_off_until) {
      const remaining = Math.ceil((row.cooling_off_until - now) / 1000);
      // Update votes but keep pending
      this._db.prepare('UPDATE patch_approvals SET auditor_votes = ? WHERE patch_id = ?').run(votesJson, patchId);
      log(`Approval for patch ${patchId}: votes passed (${safeVotes}/${totalVotes}), cooling off ${remaining}s remaining`, 'INFO', 'approval-workflow');
      return { approved: false, status: APPROVAL_STATUS.PENDING, reason: `Cooling off: ${remaining}s remaining` };
    }

    // All checks passed — APPROVED
    this._updateStatus(patchId, APPROVAL_STATUS.APPROVED, 'auto-supermajority', `Approved by ${safeVotes}/${totalVotes} auditors`, votesJson, now);
    logAudit(`Approval GRANTED for patch ${patchId}: ${safeVotes}/${totalVotes} auditors approved`, 'approval-workflow');
    return { approved: true, status: APPROVAL_STATUS.APPROVED, reason: `Approved by ${safeVotes}/${totalVotes} auditors` };
  }

  /**
   * Check if a patch has been approved (used by self-heal.js before applying).
   *
   * @param {string} patchId
   * @returns {{ approved: boolean, status: string, reason?: string }}
   */
  checkApproval(patchId: any) { 
    const row = this._db.prepare('SELECT status, rejection_reason FROM patch_approvals WHERE patch_id = ?').get(patchId);
    if (!row) {
      return { approved: false, status: 'not_found', reason: 'No approval record found' };
    }
    return {
      approved: row.status === APPROVAL_STATUS.APPROVED,
      status: row.status,
      reason: row.rejection_reason || undefined,
    };
  }

  /**
   * Cancel a pending approval (e.g. if a better fix is found).
   *
   * @param {string} patchId
   * @param {string} [reason='Cancelled']
   * @returns {boolean}
   */
  cancelApproval(patchId: any, reason = 'Cancelled') { 
    const row = this._db.prepare('SELECT status FROM patch_approvals WHERE patch_id = ?').get(patchId);
    if (!row || row.status !== APPROVAL_STATUS.PENDING) {
      return false;
    }
    this._updateStatus(patchId, APPROVAL_STATUS.CANCELLED, 'manual', reason, null, Date.now());
    log(`Approval cancelled for patch ${patchId}: ${reason}`, 'INFO', 'approval-workflow');
    return true;
  }

  /**
   * Get count of currently pending approvals (for alerting / health checks).
   */
  getPendingCount() { 
    try {
      const row = this._db.prepare("SELECT COUNT(*) as count FROM patch_approvals WHERE status = 'pending'").get();
      return row ? row.count : 0;
    } catch (err: any) {
      return 0;
    }
  }

  /**
   * Get all approvals for a specific file (for audit review).
   *
   * @param {string} targetFile
   * @param {number} [limit=20]
   */
  getFileApprovals(targetFile: any, limit = 20) { 
    try {
      const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)));
      return this._db.prepare(
        'SELECT * FROM patch_approvals WHERE target_file = ? ORDER BY requested_at DESC LIMIT ?'
      ).all(targetFile, safeLimit).map(this._formatRow);
    } catch (err: any) {
      logError('Failed to get file approvals', err);
      return [];
    }
  }

  /**
   * Get recent approval history.
   *
   * @param {number} [limit=50]
   */
  getHistory(limit = 50) { 
    try {
      const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)));
      return this._db.prepare(
        'SELECT * FROM patch_approvals ORDER BY requested_at DESC LIMIT ?'
      ).all(safeLimit).map(this._formatRow);
    } catch (err: any) {
      logError('Failed to get approval history', err);
      return [];
    }
  }

  /**
   * Expire all pending approvals that have exceeded their cooling-off window
   * without receiving sufficient votes.  Called periodically by the timer.
   */
  expireStale() { 
    const now = Date.now();
    try {
      // Find pending approvals whose cooling-off has passed but that still have no votes
      const stale = this._db.prepare(
        "SELECT patch_id, target_file FROM patch_approvals WHERE status = 'pending' AND cooling_off_until < ?"
      ).all(now);

      for (const row of stale) {
        this._updateStatus(row.patch_id, APPROVAL_STATUS.EXPIRED, 'auto-expire', 'No votes received before cooling-off elapsed', null, now);
        log(`Approval expired for patch ${row.patch_id} (file: ${row.target_file}) — no votes received`, 'WARN', 'approval-workflow');
      }

      return stale.length;
    } catch (err: any) {
      logError('Failed to expire stale approvals', err);
      return 0;
    }
  }

  /**
   * Clean up old approval records (keep last N days).
   *
   * @param {number} [retainDays=30]
   */
  cleanup(retainDays = 30) { 
    const cutoff = Date.now() - (retainDays * 24 * 60 * 60 * 1000);
    try {
      const result = this._db.prepare('DELETE FROM patch_approvals WHERE requested_at < ? AND status NOT IN (?, ?)').run(cutoff, APPROVAL_STATUS.PENDING, APPROVAL_STATUS.APPROVED);
      if (result.changes > 0) {
        log(`Cleaned up ${result.changes} old approval records`, 'INFO', 'approval-workflow');
      }
      return result.changes;
    } catch (err: any) {
      logError('Failed to cleanup approval records', err);
      return 0;
    }
  }

  // ─── Internal ───

  _updateStatus(patchId: any, status: any, decidedBy: any, reason: any, votesJson: any, decidedAt: any) { 
    this._db.prepare(`
      UPDATE patch_approvals SET status = ?, decided_at = ?, decided_by = ?, rejection_reason = ?, auditor_votes = ? WHERE patch_id = ?
    `).run(status, decidedAt, decidedBy, reason, votesJson, patchId);
  }

  _formatRow(row: any) { 
    return {
      id: row.id,
      patchId: row.patch_id,
      targetFile: row.target_file,
      patchHash: row.patch_hash,
      patchSize: row.patch_size,
      status: row.status,
      requestedAt: row.requested_at,
      decidedAt: row.decided_at,
      decidedBy: row.decided_by,
      rejectionReason: row.rejection_reason,
      auditorVotes: row.auditor_votes ? JSON.parse(row.auditor_votes) : null,
      coolingOffUntil: row.cooling_off_until,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }

  _startExpirationLoop() { 
    const intervalMs = CONFIG.SELF_HEAL_APPROVAL_EXPIRE_INTERVAL_MS || (60 * 1000); // 1 min default
    this._expirationTimer = setInterval(() => {
      const expired = this.expireStale();
      if (expired > 0) {
        log(`Approval workflow: expired ${expired} stale request(s)`, 'INFO', 'approval-workflow');
      }
    }, intervalMs);

    // Don't prevent process exit
    if (this._expirationTimer.unref) {
      this._expirationTimer.unref();
    }
  }

  /**
   * Shut down the expiration timer (for clean shutdown).
   */
  shutdown() { 
    if (this._expirationTimer) {
      clearInterval(this._expirationTimer);
      this._expirationTimer = null;
    }
  }
}

function getDb() { return _deps.database?.db; }

const approvalQueue = new PatchApprovalQueue(null);
const origRequestApproval = approvalQueue.requestApproval.bind(approvalQueue);
approvalQueue.requestApproval = function(...args: any[]) { this._db = getDb() || this._db; return origRequestApproval(...args);
};
const origSubmitVotes = approvalQueue.submitVotes.bind(approvalQueue);
approvalQueue.submitVotes = function(...args: any[]) { this._db = getDb() || this._db; return origSubmitVotes(...args);
};

module.exports = {
  PatchApprovalQueue,
  APPROVAL_STATUS,
  patchApprovalQueue: approvalQueue,
  _injectDependencies,
};