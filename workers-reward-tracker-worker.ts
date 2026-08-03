'use strict';

/**
 * Reward tracker worker thread.
 *
 * Runs the RewardTracker logic in an isolated thread with its own
 * better-sqlite3 connection (WAL mode supports concurrent reads).
 *
 * Dependencies passed via INIT:
 *   - dbPath: path to SQLite DB file
 *   - sourceDir: path to source directory (for prod survival checks)
 */

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const Database = require('better-sqlite3');
const { WorkerBase } = require('./workers-worker-base');
const { METHOD } = require('./workers-message-protocol');

const PROD_SURVIVAL_CHECK_INTERVAL_MS = 60 * 60 * 1000;
const PROD_SURVIVAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const WORST_MODEL_STAGING_THRESHOLD = 0.3;

class RewardTrackerWorkerImpl {
  _db: any;
  _emit: any;
  _sourceDir: any;
  _intervalHandle: any;
  _dbPath: any;

  constructor(dbPath: any, sourceDir: any, emitFn: any) {
    this._db = null;
    this._emit = emitFn || (() => {});
    this._sourceDir = sourceDir || PROJECT_ROOT;
    this._intervalHandle = null;
    this._dbPath = dbPath;
  }

  _initDB() { 
    this._db = new Database(this._dbPath, { readonly: false });
    this._db.pragma('journal_mode = WAL');
    this._db.pragma('busy_timeout = 5000');
    this._db.exec(`
      CREATE TABLE IF NOT EXISTS heal_model_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model_name TEXT NOT NULL,
        patch_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        staging_passed INTEGER DEFAULT NULL,
        prod_survived_24h INTEGER DEFAULT NULL,
        promoted_at INTEGER DEFAULT NULL,
        heal_duration_ms INTEGER DEFAULT NULL,
        UNIQUE(patch_id)
      );
      CREATE INDEX IF NOT EXISTS idx_heal_model_name ON heal_model_metrics(model_name);
      CREATE INDEX IF NOT EXISTS idx_heal_model_ts ON heal_model_metrics(timestamp);
      CREATE INDEX IF NOT EXISTS idx_heal_model_promoted ON heal_model_metrics(promoted_at);
    `);
  }

  recordPatchGeneration(modelName: any, patchId: any) { 
    if (!modelName || !patchId) return false;
    try {
      this._db.prepare(`
        INSERT OR IGNORE INTO heal_model_metrics (model_name, patch_id, timestamp)
        VALUES(?, ?, ?)
      `).run(
        modelName.substring(0, 200),
        patchId.substring(0, 500),
        Date.now(),
      );
      return true;
    } catch (err: any) {
      this._emitLog('recordPatchGeneration failed', err.message, 'ERROR');
      return false;
    }
  }

  recordStagingResult(modelName: any, patchId: any, passed: any) { 
    if (!patchId) return false;
    try {
      const now = Date.now();
      const result = this._db.prepare(`
        UPDATE heal_model_metrics
        SET staging_passed = ?, promoted_at = CASE WHEN ? = 1 THEN COALESCE(promoted_at, ?) ELSE promoted_at END,
            heal_duration_ms = COALESCE(heal_duration_ms, ? - timestamp)
        WHERE patch_id = ?
      `).run(passed ? 1 : 0, passed ? 1 : 0, now, now, patchId);

      if (result.changes === 0) {
        this._db.prepare(`
          INSERT OR IGNORE INTO heal_model_metrics (model_name, patch_id, timestamp, staging_passed, promoted_at)
          VALUES(?, ?, ?, ?, ?)
        `).run(modelName || 'unknown', patchId, now, passed ? 1 : 0, passed ? now : null);
      }
      return true;
    } catch (err: any) {
      this._emitLog('recordStagingResult failed', err.message, 'ERROR');
      return false;
    }
  }

  recordProdSurvival(_modelName: any, patchId: any, survived24h: any) { 
    if (!patchId) return false;
    try {
      const result = this._db.prepare(`
        UPDATE heal_model_metrics SET prod_survived_24h = ? WHERE patch_id = ?
      `).run(survived24h ? 1 : 0, patchId);

      if (result.changes === 0) {
        this._emitLog(`No row found for patchId ${patchId}`, '', 'WARN');
        return false;
      }
      return true;
    } catch (err: any) {
      this._emitLog('recordProdSurvival failed', err.message, 'ERROR');
      return false;
    }
  }

  recordHealDuration(_modelName: any, patchId: any, durationMs: any) { 
    if (!patchId) return false;
    try {
      this._db.prepare(`
        UPDATE heal_model_metrics SET heal_duration_ms = ? WHERE patch_id = ?
      `).run(durationMs, patchId);
      return true;
    } catch (err: any) {
      this._emitLog('recordHealDuration failed', err.message, 'ERROR');
      return false;
    }
  }

  getModelStats() { 
    try {
      const rows = this._db.prepare(`
        SELECT
          model_name,
          COUNT(*) as total,
          SUM(CASE WHEN staging_passed= 1 THEN 1 ELSE 0 END) as staging_passed_count,
          SUM(CASE WHEN staging_passed IS NOT NULL THEN 1 ELSE 0 END) as staging_total,
          SUM(CASE WHEN prod_survived_24h= 1 THEN 1 ELSE 0 END) as prod_survived_count,
          SUM(CASE WHEN prod_survived_24h IS NOT NULL THEN 1 ELSE 0 END) as prod_total,
          COALESCE(AVG(heal_duration_ms), 0) as avg_time_to_heal
        FROM heal_model_metrics
        GROUP BY model_name
        ORDER BY
          CASE WHEN prod_total > 0 THEN (CAST(prod_survived_count AS REAL) / prod_total) ELSE -1 END DESC,
          CASE WHEN staging_total > 0 THEN (CAST(staging_passed_count AS REAL) / staging_total) ELSE -1 END DESC
      `).all();

      return rows.map((row: any) => ({
        modelName: row.model_name,
        total: row.total,
        stagingPassRate: row.staging_total > 0
          ? Math.round((row.staging_passed_count / row.staging_total) * 100) / 100
          : null,
        prodSurvivalRate: row.prod_total > 0
          ? Math.round((row.prod_survived_count / row.prod_total) * 100) / 100
          : null,
        avgTimeToHeal: Math.round(row.avg_time_to_heal || 0),
        stagingPassedCount: row.staging_passed_count,
        stagingTotal: row.staging_total,
        prodSurvivedCount: row.prod_survived_count,
        prodTotal: row.prod_total,
      }));
    } catch (err: any) {
      this._emitLog('getModelStats failed', err.message, 'ERROR');
      return [];
    }
  }

  getBestCodegenLineup(count = 4) { 
    try {
      const stats = this.getModelStats();
      const safeCount = Math.max(1, Math.min(10, Math.floor(count)));

      const qualified = stats.filter((s: any) => {
        if (s.prodSurvivalRate !== null && s.prodTotal >= 2) return true;
        if (s.stagingPassRate !== null && s.stagingTotal >= 3 && s.stagingPassRate >= 0.5) return true;
        return false;
      });

      qualified.sort((a: any, b: any) => {
        const aProd = a.prodSurvivalRate !== null ? a.prodSurvivalRate : -1;
        const bProd = b.prodSurvivalRate !== null ? b.prodSurvivalRate : -1;
        if (bProd !== aProd) return bProd - aProd;
        const aStage = a.stagingPassRate !== null ? a.stagingPassRate : -1;
        const bStage = b.stagingPassRate !== null ? b.stagingPassRate : -1;
        if (bStage !== aStage) return bStage - aStage;
        return b.total - a.total;
      });

      return qualified.slice(0, safeCount).map((s: any) => s.modelName);
    } catch (err: any) {
      this._emitLog('getBestCodegenLineup failed', err.message, 'ERROR');
      return [];
    }
  }

  getWorstModels() { 
    try {
      const stats = this.getModelStats();
      return stats
        .filter((s: any) =>
          s.stagingPassRate !== null &&
          s.stagingPassRate < WORST_MODEL_STAGING_THRESHOLD &&
          s.stagingTotal >= 3
        )
        .map((s: any) => ({
          modelName: s.modelName,
          stagingPassRate: s.stagingPassRate,
          total: s.total,
        }));
    } catch (err: any) {
      this._emitLog('getWorstModels failed', err.message, 'ERROR');
      return [];
    }
  }

  getStats() { 
    return this.getModelStats();
  }

  generateReport() { 
    const stats = this.getModelStats();
    if (stats.length === 0) {
      return 'No heal model metrics recorded yet.';
    }

    const lines = ['=== Heal Model Performance Report ===', ''];
    const totalPatches = stats.reduce((sum: any, s: any) => sum + s.total, 0);
    const totalStagingPassed = stats.reduce((sum: any, s: any) => sum + s.stagingPassedCount, 0);
    const totalStagingTests = stats.reduce((sum: any, s: any) => sum + s.stagingTotal, 0);
    const totalProdSurvived = stats.reduce((sum: any, s: any) => sum + s.prodSurvivedCount, 0);
    const totalProdTests = stats.reduce((sum: any, s: any) => sum + s.prodTotal, 0);

    lines.push(`Total patches generated: ${totalPatches}`);
    lines.push(`Overall staging pass rate: ${totalStagingTests > 0 ? Math.round((totalStagingPassed / totalStagingTests) * 100) : 'N/A'}%`);
    lines.push(`Overall prod survival rate (24h): ${totalProdTests > 0 ? Math.round((totalProdSurvived / totalProdTests) * 100) : 'N/A'}%`);
    lines.push('');

    lines.push('Per-model breakdown:');
    for (const s of stats) {
      const stagingPct = s.stagingPassRate !== null ? `${Math.round(s.stagingPassRate * 100)}%` : 'N/A';
      const prodPct = s.prodSurvivalRate !== null ? `${Math.round(s.prodSurvivalRate * 100)}%` : 'N/A';
      lines.push(
        `  Model ${s.modelName}: generated ${s.total} patches, ${stagingPct} passed staging, ${prodPct} survived 24h in production`
      );
    }

    const best = this.getBestCodegenLineup(3);
    const worst = this.getWorstModels();
    lines.push('');
    if (best.length > 0) {
      lines.push(`Best performing models: ${best.join(', ')}`);
    }
    if (worst.length > 0) {
      lines.push(`Underperforming models (<${Math.round(WORST_MODEL_STAGING_THRESHOLD * 100)}% staging): ${worst.map((w: any) => `${w.modelName} (${Math.round(w.stagingPassRate * 100)}%)`).join(', ')}`);
    }

    return lines.join('\n');
  }

  startProdSurvivalCheck(intervalMs = PROD_SURVIVAL_CHECK_INTERVAL_MS) { 
    if (this._intervalHandle) return;

    const runCheck = async () => {
      try {
        await this._checkProdSurvival();
      } catch (err: any) {
        this._emitLog('Prod survival check failed', err.message, 'ERROR');
      }
    };

    runCheck().catch(() => {});
    this._intervalHandle = setInterval(runCheck, intervalMs);
    if (this._intervalHandle.unref) this._intervalHandle.unref();
  }

  async _checkProdSurvival() { 
    const now = Date.now();
    const windowStart = now - PROD_SURVIVAL_WINDOW_MS - (10 * 60 * 1000);
    const windowEnd = now - PROD_SURVIVAL_WINDOW_MS + (10 * 60 * 1000);

    const pending = this._db.prepare(`
      SELECT hm.*, ph.file, ph.patch
      FROM heal_model_metrics hm
      LEFT JOIN patch_history ph ON hm.patch_id = CAST(ph.id AS TEXT)
      WHERE hm.promoted_at IS NOT NULL
        AND hm.promoted_at BETWEEN ? AND ?
        AND hm.prod_survived_24h IS NULL
        AND hm.staging_passed = 1
      LIMIT 50
    `).all(windowStart, windowEnd);

    if (pending.length === 0) return;

    for (const entry of pending) {
      try {
        if (!entry.file || !entry.patch) {
          this.recordProdSurvival(entry.model_name, entry.patch_id, false);
          continue;
        }
        const filePath = path.join(this._sourceDir, entry.file);
        const resolved = path.resolve(filePath);
        if (!resolved.startsWith(path.resolve(this._sourceDir) + path.sep)) {
          this.recordProdSurvival(entry.model_name, entry.patch_id, false);
          continue;
        }
        if (!fs.existsSync(filePath)) {
          this.recordProdSurvival(entry.model_name, entry.patch_id, false);
          continue;
        }
        const currentContent = fs.readFileSync(filePath, 'utf8');
        let patchSnippet = (entry.patch || '').trim();
        const patchLines = patchSnippet.split('\n');
        const contentStart = patchLines.findIndex((l: any) => !l.startsWith('---') && !l.startsWith('+++') && !l.startsWith('@@'));
        if (contentStart > 0) patchSnippet = patchLines.slice(contentStart).join('\n').trim();
        const patchSnippetTrunc = patchSnippet.substring(0, 200);
        const survived = patchSnippetTrunc.length >= 20 && currentContent.includes(patchSnippetTrunc);
        this.recordProdSurvival(entry.model_name, entry.patch_id, survived);
      } catch (checkErr: any) {
        this.recordProdSurvival(entry.model_name, entry.patch_id, false);
      }
    }
  }

  _emitLog(message: any, detail: any, level: any) {
    this._emit('system.log', { message, detail, level });
  }

  stop() { 
    if (this._intervalHandle) {
      clearInterval(this._intervalHandle);
      this._intervalHandle = null;
    }
  }

  close() { 
    this.stop();
    if (this._db) {
      this._db.close();
      this._db = null;
    }
  }
}

// ─── Worker Implementation ───

class RewardTrackerWorker extends WorkerBase {
  _db: any;
  _emit: any;
  _sourceDir: any;
  _intervalHandle: any;
  _dbPath: any;

  constructor() {
    super();
    this._tracker = null;
  }

  _onInit(payload: any) { 
    const dbPath = payload.dbPath;
    const sourceDir = payload.sourceDir;
    if (!dbPath) {
      throw new Error('reward-tracker worker requires dbPath in init payload');
    }

    this._tracker = new RewardTrackerWorkerImpl(dbPath, sourceDir, (method: any, data: any) => this.emit(method, data));
    this._tracker._initDB();

    // Register method handlers
    this._registerMethod(METHOD.RT_RECORD_PATCH_GEN, (p: any) => {
      return { ok: this._tracker.recordPatchGeneration(p.modelName, p.patchId) };
    });

    this._registerMethod(METHOD.RT_RECORD_STAGING, (p: any) => {
      return { ok: this._tracker.recordStagingResult(p.modelName, p.patchId, p.passed) };
    });

    this._registerMethod(METHOD.RT_RECORD_PROD_SURVIVAL, (p: any) => {
      return { ok: this._tracker.recordProdSurvival(p.modelName, p.patchId, p.survived24h) };
    });

    this._registerMethod(METHOD.RT_RECORD_HEAL_DURATION, (p: any) => {
      return { ok: this._tracker.recordHealDuration(p.modelName, p.patchId, p.durationMs) };
    });

    this._registerMethod(METHOD.RT_GET_BEST_LINEUP, (p: any) => {
      return this._tracker.getBestCodegenLineup(p.count);
    });

    this._registerMethod(METHOD.RT_GENERATE_REPORT, () => {
      return this._tracker.generateReport();
    });

    this._registerMethod(METHOD.RT_GET_STATS, () => {
      return this._tracker.getStats();
    });

    // Auto-start prod survival check
    this._tracker.startProdSurvivalCheck(
      payload.survivalCheckIntervalMs || PROD_SURVIVAL_CHECK_INTERVAL_MS
    );
  }

  _onShutdown() { 
    if (this._tracker) {
      this._tracker.close();
      this._tracker = null;
    }
  }

  _healthCheck() { 
    const base = super._healthCheck();
    const dbStats = this._tracker?._db ? 'connected' : 'disconnected';
    return {
      ...base,
      db: dbStats,
      survivalCheckRunning: !!(this._tracker && this._tracker._intervalHandle),
    };
  }
}

// ─── Entry Point ───
new RewardTrackerWorker().run();