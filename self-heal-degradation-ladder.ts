'use strict';
// Last modified: 2026-08-08 — Response 3: 5-level degradation ladder with provider+OR budget awareness

// ═══════════════════════════════════════════════════════════════════════════════
// Graceful Degradation Ladder — 5-Level Resource-Aware Degradation System
//
// Instead of binary fail/succeed, the bot adapts its behavior based on
// available resources (providers + OpenRouter budget). Each level adjusts
// screenshot quality, module activation, and request pacing.
//
// Levels (auto-calculated each cycle):
//   0 (FULL)       — 3+ vision providers, OR budget > 60% → normal operation
//   1 (REDUCED)     — 1-2 vision providers or OR budget 30-60% → skip optional modules
//   2 (CONSERVING)  — No vision providers or OR budget 10-30% → batch screenshots, text-only
//   3 (SURVIVAL)    — Only 1 provider total or OR budget < 10% → minimal operation
//   4 (DORMANT)     — Zero providers or budget = 0 → graceful sleep with wake checks
//
// Integration:
//   - cycle-cycle-manager.ts: checks calculateLevel() at cycle start
//   - providers-registry.ts: reports provider count via getAvailableProviderCount()
//   - openrouter-rate-limiter.ts: reports budget % via getBudgetPct()
//   - cycle-action-executor.ts: adjusts behavior per level
//   - Various optional modules: skip work when level >= their threshold
// ═══════════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }
function updateConfig(...args: any[]) { return _deps.config?.updateConfig?.(...args); }

const CONFIG = require('./get-config');

// ─── 5-Level System ──────────────────────────────────────────────────────────

const LEVEL_NAMES = ['FULL', 'REDUCED', 'CONSERVING', 'SURVIVAL', 'DORMANT'] as const;
export type DegradationLevelName = typeof LEVEL_NAMES[number];
export type DegradationLevel = 0 | 1 | 2 | 3 | 4;

interface LevelThresholds {
  minProviders: number;        // minimum total providers for this level
  minVisionProviders: number;   // minimum vision-capable providers for this level
  minOrBudgetPct: number;       // minimum OR budget % for this level (0-100)
}

// Thresholds for each level — the system stays at the HIGHEST level
// whose thresholds are ALL met. If any threshold fails, drops one level.
const LEVEL_REQUIREMENTS: Record<DegradationLevelName, LevelThresholds> = {
  FULL:       { minProviders: 3, minVisionProviders: 2, minOrBudgetPct: 60 },
  REDUCED:    { minProviders: 1, minVisionProviders: 1, minOrBudgetPct: 30 },
  CONSERVING: { minProviders: 1, minVisionProviders: 0, minOrBudgetPct: 10 },
  SURVIVAL:   { minProviders: 1, minVisionProviders: 0, minOrBudgetPct: 0 },
  DORMANT:    { minProviders: 0, minVisionProviders: 0, minOrBudgetPct: 0 },
};

const MODE_CONFIG_OVERRIDES = {
  FULL: {
    ENABLE_EXPERIMENTS: true,
    ENABLE_EXPLORATION: true,
    PROVIDER_PREFERENCE: 'all',
    SCREENSHOT_QUALITY: 50,
    ENABLE_NETWORK_INTERCEPT: true,
    ENABLE_VISION_TRIBUNAL: true,
    ENABLE_FLUTTER_SEMANTICS: false,
    PAUSE_CYCLES: false
  },
  REDUCED: {
    ENABLE_EXPERIMENTS: false,
    ENABLE_EXPLORATION: false,
    PROVIDER_PREFERENCE: 'cheap',
    SCREENSHOT_QUALITY: 20,
    ENABLE_NETWORK_INTERCEPT: true,
    ENABLE_VISION_TRIBUNAL: true,
    ENABLE_FLUTTER_SEMANTICS: false,
    PAUSE_CYCLES: false
  },
  CONSERVING: {
    ENABLE_EXPERIMENTS: false,
    ENABLE_EXPLORATION: false,
    PROVIDER_PREFERENCE: 'local-only',
    SCREENSHOT_QUALITY: 10,
    ENABLE_NETWORK_INTERCEPT: false,
    ENABLE_VISION_TRIBUNAL: false,
    ENABLE_FLUTTER_SEMANTICS: true,
    PAUSE_CYCLES: false
  },
  SURVIVAL: {
    ENABLE_EXPERIMENTS: false,
    ENABLE_EXPLORATION: false,
    PROVIDER_PREFERENCE: 'local-only',
    SCREENSHOT_QUALITY: 5,
    ENABLE_NETWORK_INTERCEPT: false,
    ENABLE_VISION_TRIBUNAL: false,
    ENABLE_FLUTTER_SEMANTICS: true,
    PAUSE_CYCLES: false
  },
  DORMANT: {
    ENABLE_EXPERIMENTS: false,
    ENABLE_EXPLORATION: false,
    PROVIDER_PREFERENCE: 'none',
    SCREENSHOT_QUALITY: 1,
    ENABLE_NETWORK_INTERCEPT: false,
    ENABLE_VISION_TRIBUNAL: false,
    ENABLE_FLUTTER_SEMANTICS: false,
    PAUSE_CYCLES: true
  }
};

// ─── Level Calculation Result ───────────────────────────────────────────────────

interface LevelCalculation {
  level: DegradationLevel;
  name: DegradationLevelName;
  reasons: string[];
  providerCount: number;
  visionProviderCount: number;
  orBudgetPct: number;
}

class DegradationLadder {
  _currentLevel: DegradationLevel;
  _onLevelChange: any;
  _originalConfig: any;
  _evalTimer: any;
  _levelEnterTime: number;      // when we entered the current level
  _escalationTriggered: boolean;
  _escalationTriggeredAt: number;  // FIX: Track when escalation was triggered, persist to DB
  _lastCalculation: LevelCalculation | null;

  constructor() {
    this._currentLevel = 0;
    this._originalConfig = {};
    this._evalTimer = null;
    this._onLevelChange = null;
    this._levelEnterTime = Date.now();
    this._escalationTriggered = false;
    this._escalationTriggeredAt = 0;
    this._lastCalculation = null;
    this._ensureTables();
    this._loadCurrentLevel();
  }

  _ensureTables() { 
    try {
      getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS degradation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_level INTEGER,
          to_level INTEGER,
          reason TEXT,
          provider_count INTEGER,
          vision_count INTEGER,
          or_budget_pct REAL,
          timestamp INTEGER
        )
      `);
      getDb()?.exec(`
        CREATE INDEX IF NOT EXISTS idx_degradation_log_time
        ON degradation_log(timestamp)
      `);
    } catch (err: any) {
      logError('Failed to create degradation_log table', err);
    }
  }

  _loadCurrentLevel() { 
    try {
      const row = getDb()?.prepare("SELECT value FROM calibration WHERE key = 'degradation_level'").get();
      if (row && row.value !== undefined && row.value !== null) {
        const parsed = parseInt(row.value, 10);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 4) {
          this._currentLevel = parsed as DegradationLevel;
        }
      }
      // Also load the enter time from calibration
      const timeRow = getDb()?.prepare("SELECT value FROM calibration WHERE key = 'degradation_level_enter_time'").get();
      if (timeRow && timeRow.value) {
        this._levelEnterTime = parseInt(timeRow.value, 10) || Date.now();
      }
      log(`Degradation ladder initialized at level ${this._currentLevel} (${LEVEL_NAMES[this._currentLevel]})`, 'INFO', 'degradation-ladder');
    } catch (err: any) {
      logError('Failed to load current degradation level', err);
      this._currentLevel = 0;
    }
    // FIX: Load escalation trigger time from DB
    try {
      const escRow = getDb()?.prepare("SELECT value FROM calibration WHERE key = 'escalation_triggered_at'").get();
      if (escRow && escRow.value) {
        this._escalationTriggeredAt = parseInt(escRow.value, 10) || 0;
        // If escalation was triggered less than 6 hours ago, keep the flag set
        if (this._escalationTriggeredAt > 0 && Date.now() - this._escalationTriggeredAt < 6 * 60 * 60 * 1000) {
          this._escalationTriggered = true;
        }
      }
    } catch {}
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Core: calculateLevel() — called at the START of each question cycle
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Calculate the appropriate degradation level based on current conditions.
   * This is the MAIN entry point called by cycle-cycle-manager.ts at the
   * start of each question cycle.
   */
  calculateLevel(): LevelCalculation {
    const providerCount = this._getProviderCount();
    const visionCount = this._getVisionProviderCount();
    const orBudgetPct = this._getOrBudgetPct();
    const reasons: string[] = [];

    let determinedLevel: DegradationLevel = 0;

    // Check from FULL downward — first level whose requirements are ALL met wins
    for (let i = 0; i < 5; i++) {
      const req = LEVEL_REQUIREMENTS[LEVEL_NAMES[i]];
      const meetsProviders = providerCount >= req.minProviders;
      const meetsVision = visionCount >= req.minVisionProviders;
      const meetsBudget = orBudgetPct >= req.minOrBudgetPct;

      if (meetsProviders && meetsVision && meetsBudget) {
        determinedLevel = i as DegradationLevel;
        break;
      }

      // Collect why we couldn't stay at this level (for logging)
      if (i === 0 || (determinedLevel === 0 && i > 0)) {
        if (!meetsProviders) reasons.push(`providers=${providerCount} (need ${req.minProviders})`);
        if (!meetsVision) reasons.push(`vision=${visionCount} (need ${req.minVisionProviders})`);
        if (!meetsBudget) reasons.push(`OR budget=${orBudgetPct.toFixed(0)}% (need ${req.minOrBudgetPct}%)`);
      }
    }

    // If we couldn't meet even FULL requirements, determine actual level
    if (determinedLevel === 0 && reasons.length > 0) {
      determinedLevel = this._determineFallbackLevel(providerCount, visionCount, orBudgetPct);
    }

    const result: LevelCalculation = {
      level: determinedLevel,
      name: LEVEL_NAMES[determinedLevel],
      reasons,
      providerCount,
      visionProviderCount: visionCount,
      orBudgetPct,
    };

    this._lastCalculation = result;

    // Auto-apply level change if different from current
    if (determinedLevel !== this._currentLevel) {
      this.setLevel(determinedLevel, reasons.join(', '));
    }

    // Auto-escalation check: stuck at Level 3+ for > 30 minutes
    this._checkAutoEscalation();

    return result;
  }

  /**
   * Determine fallback level when FULL requirements aren't met.
   */
  _determineFallbackLevel(providers: number, vision: number, orBudget: number): DegradationLevel {
    // Dormant: zero providers
    if (providers === 0) return 4;
    // Survival: 1 provider total OR budget < 10%
    if (providers === 1 && orBudget < 10) return 3;
    // Survival: only 1 provider regardless of budget
    if (providers === 1) return 3;
    // Conserving: no vision providers
    if (vision === 0) return 2;
    // Conserving: budget 10-30%
    if (orBudget < 30) return 2;
    // Reduced: 1-2 providers or budget 30-60%
    if (providers <= 2 || orBudget < 60) return 1;
    return 0;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Data sources: provider count + OR budget
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get total available provider count from the registry.
   * Uses lazy-loaded registry module.
   */
  _getProviderCount(): number {
    try {
      const registry = require('./providers-registry');
      if (typeof registry.getAvailableProviderCount === 'function') {
        return registry.getAvailableProviderCount();
      }
      // Fallback: count using synchronous heuristic from provider table
      return this._estimateProviderCount();
    } catch (err: any) {
      return this._estimateProviderCount();
    }
  }

  /**
   * Get vision-capable provider count from the registry.
   */
  _getVisionProviderCount(): number {
    try {
      const registry = require('./providers-registry');
      if (typeof registry.getAvailableProviderCount === 'function') {
        return registry.getAvailableProviderCount({ visionOnly: true });
      }
      return this._estimateProviderCount(true);
    } catch (err: any) {
      return this._estimateProviderCount(true);
    }
  }

  /**
   * Estimate provider count from DB model_registry (fallback when registry isn't loaded).
   */
  _estimateProviderCount(visionOnly = false): number {
    try {
      const db = getDb();
      if (!db) return 0;
      const rows = db.prepare("SELECT COUNT(*) as cnt FROM model_registry WHERE role = 'active' AND is_working = 1").get();
      return rows?.cnt || 0;
    } catch {
      return 0;
    }
  }

  /**
   * Get OpenRouter budget remaining as a percentage (0-100).
   */
  _getOrBudgetPct(): number {
    try {
      const orLimiter = require('./openrouter-rate-limiter');
      if (typeof orLimiter.getBudgetPct === 'function') {
        return orLimiter.getBudgetPct();
      }
      // Fallback: calculate from getStatus()
      const status = orLimiter.getStatus();
      if (status && status.dailyLimit > 0) {
        return ((status.totalRemaining / status.dailyLimit) * 100);
      }
      return 100; // Assume full budget if we can't determine
    } catch (err: any) {
      // OR limiter not loaded — assume full budget (fail-open to FULL level)
      return 100;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Level Management
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get the current degradation level (0-4).
   */
  getCurrentLevel(): DegradationLevel {
    return this._currentLevel;
  }

  /**
   * Get the current level name.
   */
  getCurrentLevelName(): DegradationLevelName {
    return LEVEL_NAMES[this._currentLevel];
  }

  /**
   * Check if the current level is at or above a given threshold.
   * e.g., `isLevelAtLeast(2)` returns true for CONSERVING, SURVIVAL, DORMANT.
   */
  isLevelAtLeast(level: DegradationLevel): boolean {
    return this._currentLevel >= level;
  }

  /**
   * Check if the current level is at or below a given threshold.
   * e.g., `isLevelAtMost(1)` returns true for FULL, REDUCED.
   */
  isLevelAtMost(level: DegradationLevel): boolean {
    return this._currentLevel <= level;
  }

  /**
   * Set a new degradation level with persistence, config overrides, and alerts.
   */
  setLevel(newLevel: DegradationLevel, reason: string) {
    try {
      if (newLevel < 0 || newLevel > 4) {
        log(`Invalid degradation level: ${newLevel}`, 'ERROR', 'degradation-ladder');
        return { success: false, error: `Invalid level: ${newLevel}` };
      }

      const previousLevel = this._currentLevel;

      if (previousLevel === newLevel) {
        return { success: true, previousLevel, newLevel, reason: 'no change' };
      }

      this._currentLevel = newLevel;
      this._levelEnterTime = Date.now();

      // Persist to calibration
      try {
        getDb()?.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
          .run('degradation_level', String(newLevel), Date.now());
        getDb()?.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
          .run('degradation_level_enter_time', String(Date.now()), Date.now());
      } catch (e: any) { /* non-critical */ }

      // Log transition
      try {
        getDb()?.prepare(
          'INSERT INTO degradation_log (from_level, to_level, reason, provider_count, vision_count, or_budget_pct, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
        ).run(
          previousLevel, newLevel, reason,
          this._lastCalculation?.providerCount ?? 0,
          this._lastCalculation?.visionProviderCount ?? 0,
          this._lastCalculation?.orBudgetPct ?? 0,
          Date.now()
        );
      } catch (e: any) { /* non-critical */ }

      // Apply config overrides in memory
      this.applyModeConfig(LEVEL_NAMES[newLevel]);

      // Alert on significant level changes
      const isDowngrade = newLevel > previousLevel;
      const alertLevel = newLevel >= 3 ? 1 : newLevel >= 2 ? 2 : 3;
      const prevName = LEVEL_NAMES[previousLevel];
      const newName = LEVEL_NAMES[newLevel];

      try {
        getSendAlert()(`Degradation level changed: ${prevName} (${previousLevel}) -> ${newName} (${newLevel}). Reason: ${reason}`, alertLevel);
      } catch (e: any) {}

      log(
        `DEGRADATION: ${prevName} (${previousLevel}) -> ${newName} (${newLevel}) [${isDowngrade ? 'DOWN' : 'UP'}] reason: ${reason}`,
        isDowngrade ? 'WARN' : 'INFO',
        'degradation-ladder'
      );

      // Notify callback
      if (this._onLevelChange) {
        try {
          this._onLevelChange(previousLevel, newLevel, reason);
        } catch (cbErr: any) {
          logError('Error in level change callback', cbErr);
        }
      }

      // Reset escalation flag on upgrade
      if (!isDowngrade) {
        this._escalationTriggered = false;
      }

      return { previousLevel, newLevel, reason };
    } catch (err: any) {
      logError('Error setting degradation level', err);
      return { success: false, error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Auto-Escalation: stuck at Level 3+ for > 30 minutes
  // ═══════════════════════════════════════════════════════════════════════════

  _checkAutoEscalation() {
    const ESCALATION_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes
    // FIX: Allow re-escalation after restart (process uptime < 5 min = fresh process)
    const processUptimeMs = Date.now() - (process.uptime() * 1000);
    const isFreshProcess = processUptimeMs < 5 * 60 * 1000;
    // Also allow re-escalation if previous one was > 6 hours ago
    const escalationCooldownMs = 6 * 60 * 60 * 1000;
    const escalationExpired = this._escalationTriggeredAt > 0 && (Date.now() - this._escalationTriggeredAt > escalationCooldownMs);

    if (this._currentLevel < 3) {
      // Not in a critical level — reset
      this._escalationTriggered = false;
      return;
    }

    if (this._escalationTriggered && !isFreshProcess && !escalationExpired) {
      // Already escalated — don't repeat (unless fresh process or cooldown expired)
      return;
    }

    const timeInLevel = Date.now() - this._levelEnterTime;
    if (timeInLevel > ESCALATION_THRESHOLD_MS) {
      this._escalationTriggered = true;
      this._escalationTriggeredAt = Date.now();
      // FIX: Persist escalation trigger time to DB (survives restarts)
      try {
        getDb()?.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
          .run('escalation_triggered_at', String(Date.now()), Date.now());
      } catch (e: any) { /* non-critical */ }

      const levelName = LEVEL_NAMES[this._currentLevel];
      log(
        `AUTO-ESCALATION: Stuck at ${levelName} (${this._currentLevel}) for ${Math.round(timeInLevel / 60000)}min. Triggering emergency actions.${isFreshProcess ? ' (fresh process — re-escalating)' : ''}`,
        'ERROR',
        'degradation-ladder'
      );

      try {
        getSendAlert()(
          `ESCALATION: Bot stuck at ${levelName} for ${Math.round(timeInLevel / 60000)}min. Emergency actions triggered.`,
          1 // critical
        );
      } catch (e: any) {}

      // Emergency actions:
      // 1. Try to re-discover providers
      try {
        const discovery = require('./providers-provider-discovery');
        discovery.autoDiscoverModels?.().then((models: any[]) => {
          if (models && models.length > 0) {
            log(`Auto-escalation: discovered ${models.length} models`, 'INFO', 'degradation-ladder');
          }
        }).catch(() => {});
      } catch (e: any) {}

      // 2. If on Render, trigger restart via process.exit(1)
      if (process.env.RENDER_SERVICE_ID) {
        log('Auto-escalation: on Render — scheduling process.exit(1) in 10s for auto-restart', 'WARN', 'degradation-ladder');
        setTimeout(() => {
          log('Auto-escalation: executing process.exit(1) for Render auto-restart', 'ERROR', 'degradation-ladder');
          process.exit(1);
        }, 10000);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Config Overrides
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get effective config overrides for a given level name.
   */
  getModeConfig(levelName: string) {
    return (MODE_CONFIG_OVERRIDES as any)[levelName] || MODE_CONFIG_OVERRIDES.FULL;
  }

  /**
   * Apply level config overrides to CONFIG in memory.
   * Does NOT persist (level is persisted, config overrides are derived).
   */
  applyModeConfig(levelName: string) { 
    try {
      const overrides = this.getModeConfig(levelName);

      // Save original config values on first call
      if (Object.keys(this._originalConfig).length === 0) {
        this._originalConfig = {
          ENABLE_EXPERIMENTS: CONFIG.ENABLE_EXPERIMENTS,
          ENABLE_EXPLORATION: CONFIG.ENABLE_EXPLORATION,
          SCREENSHOT_QUALITY: CONFIG.SCREENSHOT_QUALITY,
          ENABLE_NETWORK_INTERCEPT: CONFIG.ENABLE_NETWORK_INTERCEPT,
        };
      }

      // Apply overrides through controlled mutation
      for (const [key, value] of Object.entries(overrides)) {
        if (key in CONFIG) {
          try { updateConfig(key, value); } catch (e: any) { /* already logged */ }
        }
      }

      log(`Applied ${levelName} level config overrides (${Object.keys(overrides).length} keys)`, 'INFO', 'degradation-ladder');
    } catch (err: any) {
      logError('Error applying mode config', err);
    }
  }

  /**
   * Restore original config values.
   */
  restoreOriginalConfig() { 
    try {
      for (const [key, value] of Object.entries(this._originalConfig)) {
        if (value !== undefined) {
          try { updateConfig(key, value); } catch (e: any) {}
        }
      }
      log('Restored original config values', 'INFO', 'degradation-ladder');
    } catch (err: any) {
      logError('Error restoring original config', err);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Module-Level Skip Helpers
  //
  // These are called by individual modules to check if they should skip work.
  // Each module calls `degradationLadder.shouldSkip('module_name')` at the
  // start of their operation.
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Module skip thresholds: the minimum level at which each module should SKIP.
   * If current level >= module's threshold, the module should skip its work.
   */
  private static readonly MODULE_SKIP_THRESHOLDS: Record<string, DegradationLevel> = {
    'self-documenting-diary': 1,      // Skip at REDUCED+ (diary is non-essential)
    'meta-learner-reflection': 1,     // Skip at REDUCED+ 
    'provider-quota-bargain': 1,      // Skip at REDUCED+ (bargain hunting)
    'providers-prompt-evolution': 1,  // Skip at REDUCED+ (prompt tuning)
    'model-evolution': 1,             // Skip at REDUCED+
    'self-heal-auditor': 2,           // Skip at CONSERVING+ (auditing is expensive)
    'experiments': 2,                  // Skip at CONSERVING+
    'exploration': 2,                  // Skip at CONSERVING+
    'providers-detection-captcha-solver': 2,  // Skip captcha solving at CONSERVING+
  };

  /**
   * Check if a module should skip its work at the current degradation level.
   */
  shouldSkip(moduleName: string): boolean {
    const threshold = (DegradationLadder as any).MODULE_SKIP_THRESHOLDS[moduleName];
    if (threshold === undefined) return false; // Unknown module — don't skip
    return this._currentLevel >= threshold;
  }

  /**
   * Get the cycle sleep time based on current level.
   * Higher levels = more time between cycles to conserve resources.
   */
  getCycleSleepMs(): number {
    switch (this._currentLevel) {
      case 0: return 0;    // FULL: no extra sleep
      case 1: return 5000;  // REDUCED: 5s between cycles
      case 2: return 15000; // CONSERVING: 15s between cycles
      case 3: return 30000; // SURVIVAL: 30s between cycles
      case 4: return 60000; // DORMANT: 60s wake checks
      default: return 0;
    }
  }

  /**
   * Get the maximum retry count based on current level.
   * Higher levels = fewer retries to save budget.
   */
  getMaxRetries(): number {
    switch (this._currentLevel) {
      case 0: return 3;  // FULL: up to 3 retries
      case 1: return 2;  // REDUCED: up to 2 retries
      case 2: return 1;  // CONSERVING: 1 retry
      case 3: return 0;  // SURVIVAL: no retries
      case 4: return 0;  // DORMANT: no retries
      default: return 3;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Backward Compatibility (old 4-mode system)
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Get current mode name (backward compat — maps 5-level to old 4-mode).
   */
  getCurrentMode(): string {
    const mapping: Record<DegradationLevel, string> = {
      0: 'FULL',
      1: 'DEGRADED',
      2: 'SURVIVAL',
      3: 'SURVIVAL',
      4: 'HIBERNATION',
    };
    return mapping[this._currentLevel] || 'FULL';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Health Check Helpers (used by legacy evaluateShouldDegrade/Recover)
  // ═══════════════════════════════════════════════════════════════════════════

  _checkLowProviderQuota(thresholdPercent: number): string | null { 
    try {
      const rows = getDb()?.prepare('SELECT provider, limit_val AS budget, spent FROM provider_quotas').all();
      for (const row of rows) {
        if (row.budget && row.budget > 0 && typeof row.spent === 'number') {
          const remaining = ((row.budget - row.spent) / row.budget) * 100;
          if (remaining < thresholdPercent) {
            return `${row.provider}: ${remaining.toFixed(1)}% remaining`;
          }
        }
      }
      return null;
    } catch (err: any) {
      return null;
    }
  }

  _checkMemoryThreshold(ratio: number): string | null { 
    try {
      const used = process.memoryUsage().heapUsed;
      const total = process.memoryUsage().heapTotal;
      if (total === 0) return null;
      const usageRatio = used / total;
      if (usageRatio > ratio) {
        return `${(usageRatio * 100).toFixed(1)}% (${Math.round(used / 1024 / 1024)}MB / ${Math.round(total / 1024 / 1024)}MB)`;
      }
      return null;
    } catch (err: any) {
      return null;
    }
  }

  _countOpenCircuitBreakers(): number { 
    let count = 0;
    try {
      const { healerCircuitBreaker } = require('./self-heal-circuit-breaker');
      const state = healerCircuitBreaker.getState();
      if (state.state === 'OPEN') count++;
    } catch (_e: any) {}
    try {
      const { subsystemMesh } = require('./monitoring-subsystem-circuit-breakers');
      const status = subsystemMesh.getMeshStatus();
      for (const s of Object.values(status)) {
        if ((s as any).state === 'OPEN') count++;
      }
    } catch (_e: any) {}
    return count;
  }

  _checkNoCloudProviders(): boolean { 
    try {
      const rows = getDb()?.prepare("SELECT is_working FROM model_registry WHERE role = 'active'").all();
      const working = rows.filter((r: any) => r.is_working === 1);
      return working.length === 0;
    } catch (err: any) {
      return false;
    }
  }

  _checkBrowserDead(): boolean { 
    try {
      const { browserManager } = require('./browser');
      if (browserManager && browserManager._browser && !browserManager._browser.closed) {
        return false;
      }
      return true;
    } catch (err: any) {
      return true;
    }
  }

  _checkDatabaseCorrupted(): boolean { 
    try {
      const result = getDb()?.prepare('PRAGMA integrity_check').get();
      return result && result.integrity_check !== 'ok';
    } catch (err: any) {
      return true;
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Callbacks & Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

  onLevelChange(callback: (prevLevel: DegradationLevel, newLevel: DegradationLevel, reason: string) => void) { 
    this._onLevelChange = callback;
  }

  /**
   * Start periodic evaluation (60s default).
   * This is a background safety net — calculateLevel() is also called per-cycle.
   */
  start(intervalMs = 60000) { 
    try {
      this._evalTimer = setInterval(() => {
        try {
          this.calculateLevel();
        } catch (err: any) {
          logError('Error in periodic degradation evaluation', err);
        }
      }, intervalMs);
      if (this._evalTimer && this._evalTimer.unref) this._evalTimer.unref();
      log(`Degradation ladder started (periodic eval interval: ${Math.round(intervalMs / 1000)}s)`, 'INFO', 'degradation-ladder');
    } catch (err: any) {
      logError('Failed to start degradation ladder', err);
    }
  }

  stop() { 
    if (this._evalTimer) { clearInterval(this._evalTimer); this._evalTimer = null; }
    log('Degradation ladder stopped', 'INFO', 'degradation-ladder');
  }

  /**
   * Get degradation history.
   */
  getHistory(limit = 20) { 
    try {
      return getDb()?.prepare('SELECT * FROM degradation_log ORDER BY timestamp DESC LIMIT ?').all(limit);
    } catch (err: any) {
      logError('Error getting degradation history', err);
      return [];
    }
  }

  /**
   * Get the last calculation result (for dashboards/monitoring).
   */
  getLastCalculation(): LevelCalculation | null {
    return this._lastCalculation;
  }

  /**
   * Get time spent at current level in milliseconds.
   */
  getTimeAtCurrentLevelMs(): number {
    return Date.now() - this._levelEnterTime;
  }
}

const degradationLadder = new DegradationLadder();
module.exports = {
  DegradationLadder,
  degradationLadder,
  LEVEL_NAMES,
  LEVEL_REQUIREMENTS,
  MODE_CONFIG_OVERRIDES,
  _injectDependencies,
};
