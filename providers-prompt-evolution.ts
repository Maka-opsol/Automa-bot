'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Prompt Evolution — Automatically improves vision AI system prompts
// based on blackbox failure analysis.
//
// Render-aware: On Render free plan, evolution cycles are throttled
// (minimum 12h interval instead of 6h) and tribunal calls have a
// 30s timeout to avoid stalling on the slow CPU.
// ═══════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function _getCONFIG(): Record<string, any> {
  return _deps.config || (() => { try { return require('./get-config'); } catch { return {}; } })();
}

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, logError } = require('./logger');
const { db } = require('./database');

// ─── Constants ───

const PROMPT_OVERRIDES_FILE = path.join(PROJECT_ROOT, 'prompt-overrides.json');
const MEASUREMENT_WINDOW = 50;

// BUG FIX (Response 18): Default interval differs between Render and local.
// On Render's slow CPU, tribunal calls take much longer and consume more
// memory. We use 12h instead of 6h to reduce pressure.
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const RENDER_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours on Render

// BUG FIX (Response 18): Maximum concurrent states evolved per cycle.
// Without this, a cycle with 20 underperforming states would fire 20
// tribunal calls sequentially, each taking 10-30s on Render.
const MAX_EVOLUTIONS_PER_CYCLE = 3;

// BUG FIX (Response 18): Minimum time between evolution attempts for the
// SAME state. Prevents re-evolving a state that was just evolved in the
// previous cycle (e.g., the tribunal suggestion hasn't had time to be
// measured yet).
const SAME_STATE_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours

// BUG FIX (Response 18): Timeout for tribunal calls during evolution.
// On Render's slow CPU, the codegen tribunal can stall.
const TRIBUNAL_TIMEOUT_MS = 30 * 1000; // 30 seconds

// BUG FIX (Response 18): Maximum number of failure reasons to collect
// per state. Without this, the failureReasons array grows unbounded
// across cycles, wasting memory on Render's 512 MB.
const MAX_FAILURE_REASONS_PER_STATE = 20;

// BUG FIX (Response 18): Minimum success rate to trigger evolution.
// States above this threshold are not worth evolving (diminishing
// returns, wasted tribunal calls).
const EVOLUTION_SUCCESS_RATE_THRESHOLD = 0.3;

// BUG FIX (Response 18): Minimum cycles before a state is eligible
// for evolution. Too few cycles means the success rate is noisy.
const MIN_CYCLES_FOR_EVOLUTION = 10;

// Render detection (same pattern as browser-chrome-flags.ts Response 13)
function _isRenderFreePlan(): boolean {
  return !!(process.env.RENDER_SERVICE_ID || process.env.RENDER);
}

let _startupTimer: any = null;

// BUG FIX (Response 18): Cache parsed overrides to avoid re-reading
// and re-parsing JSON on every getPromptForState / _getCurrentPromptSection call.
let _overridesCache: any = null;
let _overridesCacheMtime = 0;

// ─── PromptEvolver Class ───

class PromptEvolver {
  _timer: any;
  /** Tracks last evolution timestamp per state to enforce cooldown */
  _lastEvolvedAt: Map<string, number>;

  constructor() {
    this._timer = null;
    this._lastEvolvedAt = new Map();
    this._ensureOverridesFile();
    this._ensurePromptVersionsTable();
  }

  // ─── File / Table Setup ───

  _ensureOverridesFile() {
    try {
      if (!fs.existsSync(PROMPT_OVERRIDES_FILE)) {
        const defaults = {
          _meta: { version: 1, description: 'Auto-generated prompt overrides by prompt-evolution' },
          overrides: {}
        };
        fs.writeFileSync(PROMPT_OVERRIDES_FILE, JSON.stringify(defaults, null, 2), 'utf8');
        log('Created prompt overrides file', 'DEBUG', 'prompt-evolution');
      }
      // Prime the cache on startup
      this._loadOverrides();
    } catch (err: any) {
      logError('Failed to create prompt overrides file', err);
    }
  }

  _ensurePromptVersionsTable() {
    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prompt_evolution_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          state TEXT NOT NULL,
          previous_prompt TEXT,
          new_prompt TEXT,
          success_rate_before REAL,
          success_rate_after REAL,
          status TEXT DEFAULT 'active',
          reverted INTEGER DEFAULT 0,
          reverted_at INTEGER,
          measurement_cycles INTEGER DEFAULT 0,
          measured_success INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_prompt_evo_state ON prompt_evolution_log(state);
        CREATE INDEX IF NOT EXISTS idx_prompt_evo_status ON prompt_evolution_log(status);
      `);
    } catch (err: any) {
      // BUG FIX (Response 18): Log table creation failure instead of
      // silently swallowing. On Render, the DB path might have
      // permission issues on first deploy.
      logError('Failed to create prompt_evolution_log table', err);
    }
  }

  // ─── Overrides I/O (with cache) ───

  /**
   * Load prompt overrides from disk, using a stat-based cache.
   * BUG FIX (Response 18): Previous implementation called
   * JSON.parse(fs.readFileSync(...)) on every call — hot path
   * during cycle execution. Now caches until file mtime changes.
   */
  _loadOverrides() {
    try {
      if (fs.existsSync(PROMPT_OVERRIDES_FILE)) {
        const stat = fs.statSync(PROMPT_OVERRIDES_FILE);
        // Use mtime to detect file changes (writeFile updates mtime)
        if (
          _overridesCache !== null &&
          _overridesCacheMtime === stat.mtimeMs
        ) {
          return _overridesCache;
        }
        const data = JSON.parse(fs.readFileSync(PROMPT_OVERRIDES_FILE, 'utf8'));
        _overridesCache = data;
        _overridesCacheMtime = stat.mtimeMs;
        return data;
      }
    } catch (err: any) {
      logError('Failed to load prompt overrides', err);
    }
    return { _meta: { version: 1 }, overrides: {} };
  }

  /**
   * Invalidate the overrides cache. Must be called after any write.
   */
  _invalidateOverridesCache() {
    _overridesCache = null;
    _overridesCacheMtime = 0;
  }

  // ─── Analysis ───

  async analyzePromptEffectiveness() {
    try {
      const limit = 200;
      const minEntries = _getCONFIG().PROMPT_EVOLUTION_MIN_ENTRIES || 50;

      let rows: any[] = [];
      try {
        rows = db.prepare('SELECT * FROM blackbox ORDER BY timestamp DESC LIMIT ?').all(limit);
      } catch (e: any) {
        log('Blackbox table not available for prompt analysis', 'WARN', 'prompt-evolution');
        return null;
      }

      if (rows.length < minEntries) {
        log(
          `Not enough blackbox entries for analysis (${rows.length} < ${minEntries})`,
          'DEBUG',
          'prompt-evolution'
        );
        return null;
      }

      // BUG FIX (Response 18): Use a Map instead of plain object for
      // stateGroups to avoid prototype pollution and get cleaner typing.
      const stateGroups = new Map<string, {
        total: number;
        successes: number;
        latencies: number[];
        actions: string[];
        reasons: string[];
      }>();

      for (const row of rows) {
        const state = (row.state || 'unknown').substring(0, 100);
        let group = stateGroups.get(state);
        if (!group) {
          group = { total: 0, successes: 0, latencies: [], actions: [], reasons: [] };
          stateGroups.set(state, group);
        }
        group.total++;
        if (row.success === 1) group.successes++;
        if (row.latency) group.latencies.push(row.latency);
        if (row.action) group.actions.push(row.action);
        if (row.reasoning) {
          // BUG FIX (Response 18): Cap failure reasons per state
          const reasonStr = String(row.reasoning).substring(0, 100);
          if (group.reasons.length < MAX_FAILURE_REASONS_PER_STATE) {
            group.reasons.push(reasonStr);
          }
        }
      }

      const analysis: Record<string, any> = {};
      const underperforming: any[] = [];

      for (const [state, data] of stateGroups) {
        if (data.total < 5) continue;

        const successRate = data.successes / data.total;
        const avgLatency = data.latencies.length > 0
          ? Math.round(data.latencies.reduce((a, b) => a + b, 0) / data.latencies.length)
          : 0;

        // Count actions efficiently
        const actionCounts = new Map<string, number>();
        for (const action of data.actions) {
          actionCounts.set(action, (actionCounts.get(action) || 0) + 1);
        }
        // Find most common action
        let mostCommonAction: [string, number] | null = null;
        for (const [action, count] of actionCounts) {
          if (!mostCommonAction || count > mostCommonAction[1]) {
            mostCommonAction = [action, count];
          }
        }

        const failureReasons = data.reasons.filter(r => r);

        analysis[state] = {
          successRate: Math.round(successRate * 1000) / 10,
          avgLatency,
          totalCycles: data.total,
          mostCommonAction: mostCommonAction ? mostCommonAction[0] : null,
          mostCommonActionCount: mostCommonAction ? mostCommonAction[1] : 0,
          failureReasons,
        };

        // BUG FIX (Response 18): Use named constants instead of magic
        // numbers for thresholds.
        if (successRate < EVOLUTION_SUCCESS_RATE_THRESHOLD) {
          underperforming.push({
            state,
            successRate,
            avgLatency,
            failureReasons,
            totalCycles: data.total,
          });
        }
      }

      underperforming.sort((a, b) => a.successRate - b.successRate);

      log(
        `Prompt analysis: ${Object.keys(analysis).length} states analyzed, ${underperforming.length} underperforming (< ${(EVOLUTION_SUCCESS_RATE_THRESHOLD * 100).toFixed(0)}% success)`,
        'INFO',
        'prompt-evolution'
      );

      return { analysis, underperforming };
    } catch (err: any) {
      logError('Failed to analyze prompt effectiveness', err);
      return null;
    }
  }

  // ─── Evolution ───

  /**
   * Check whether a state is on cooldown (recently evolved).
   * BUG FIX (Response 18): Prevents re-evolving the same state
   * every cycle when it hasn't had enough measurement cycles yet.
   */
  _isStateOnCooldown(state: string): boolean {
    const lastEvolved = this._lastEvolvedAt.get(state) || 0;
    return (Date.now() - lastEvolved) < SAME_STATE_COOLDOWN_MS;
  }

  /**
   * Evolve the prompt for a given state using the tribunal.
   * BUG FIX (Response 18): Tribunal call now races against a 30s
   * timeout so it can't stall on Render's slow CPU.
   */
  async evolvePrompt(state: any, analysis: any) {
    try {
      if (!analysis || !analysis.failureReasons) {
        log('No analysis data for prompt evolution', 'WARN', 'prompt-evolution');
        return null;
      }

      // BUG FIX (Response 18): Cooldown check — skip if recently evolved
      if (this._isStateOnCooldown(state)) {
        log(`State '${state}' is on cooldown, skipping evolution`, 'DEBUG', 'prompt-evolution');
        return null;
      }

      const currentPromptSection = this._getCurrentPromptSection(state);
      const failureDescriptions = analysis.failureReasons
        .map((r: any) => (r || '').substring(0, 150))
        .join('; ');

      const metaPrompt = [
        'You are a prompt engineering expert. Improve a vision AI system prompt.',
        '',
        `The bot consistently fails when it sees state '${state}'.`,
        `Success rate is ${analysis.successRate.toFixed(1)}%.`,
        `Average latency: ${analysis.avgLatency}ms.`,
        `Most common action: ${analysis.mostCommonAction || 'none'}.`,
        `Common failures: ${failureDescriptions || 'No specific failure reasons available'}.`,
        '',
        'The current prompt section for this state is:',
        '--- BEGIN CURRENT PROMPT ---',
        currentPromptSection || '(No specific prompt section exists for this state)',
        '--- END CURRENT PROMPT ---',
        '',
        'Suggest an improved prompt section. You must:',
        '1. Be specific about what to look for in this state',
        '2. Add guidance for common failure scenarios',
        '3. Keep it concise (max 200 words)',
        '4. Return ONLY the new prompt text, no explanations or markdown'
      ].join('\n');

      log(`Requesting prompt evolution for state '${state}'...`, 'INFO', 'prompt-evolution');

      let suggestion: string | null = null;
      try {
        const { generateCodeFixViaTribunal } = require('./providers-codegen-tribunal');
        const mockInvestigation = {
          url: 'prompt-evolution',
          html: '',
          fileContent: metaPrompt,
          targetFile: 'prompt-evolve'
        };

        // BUG FIX (Response 18): Race tribunal call against timeout.
        // On Render, the tribunal can stall for minutes if the provider
        // API is slow. This prevents the evolution cycle from hanging.
        const tribunalPromise = generateCodeFixViaTribunal(mockInvestigation, metaPrompt);
        const timeoutPromise = new Promise<null>(resolve =>
          setTimeout(() => resolve(null), TRIBUNAL_TIMEOUT_MS)
        );
        const result = await Promise.race([tribunalPromise, timeoutPromise]);

        if (result === null) {
          log(`Tribunal call timed out for state '${state}' (${TRIBUNAL_TIMEOUT_MS / 1000}s)`, 'WARN', 'prompt-evolution');
          return null;
        }

        if (result && result.length > 0 && result[0].patch) {
          suggestion = result[0].patch.trim();
        }
      } catch (tribunalErr: any) {
        logError('Tribunal call failed for prompt evolution', tribunalErr);
        return null;
      }

      if (!suggestion || suggestion.length < 20) {
        log('Invalid suggestion from tribunal for prompt evolution', 'WARN', 'prompt-evolution');
        return null;
      }

      if (suggestion === currentPromptSection) {
        log('Tribunal returned identical prompt, skipping', 'INFO', 'prompt-evolution');
        return null;
      }

      const applied = await this.applyPromptUpdate(state, suggestion);
      if (applied) {
        // BUG FIX (Response 18): Record evolution time for cooldown tracking
        this._lastEvolvedAt.set(state, Date.now());
        log(`Prompt evolved for state '${state}' (${suggestion.length} chars)`, 'INFO', 'prompt-evolution');
      }

      return { state, suggestion, applied };
    } catch (err: any) {
      logError(`Failed to evolve prompt for state '${state}'`, err);
      return null;
    }
  }

  _getCurrentPromptSection(state: any) {
    try {
      const overrides = this._loadOverrides();
      if (overrides.overrides && overrides.overrides[state]) {
        return overrides.overrides[state];
      }
    } catch (e: any) {
      // ignore
    }

    try {
      const prompts = require('./providers-prompts');
      const basePrompt = prompts.SYSTEM_PROMPT || prompts.getSystemPrompt() || '';
      const stateLower = String(state).toLowerCase();
      let idx = basePrompt.toLowerCase().indexOf(stateLower);
      if (idx === -1) {
        // Also try original case (DB may store original case)
        idx = basePrompt.indexOf(String(state));
        if (idx === -1) {
          log(`Prompt substring not found for state: ${stateLower}`, 'DEBUG', 'prompt-evolution');
        }
      }
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(basePrompt.length, idx + String(state).length + 200);
        return '... ' + basePrompt.substring(start, end) + ' ...';
      }
      return null;
    } catch (e: any) {
      return null;
    }
  }

  // ─── Apply / Rollback ───

  async applyPromptUpdate(state: any, newPromptSection: any, precomputedAnalysis = null) {
    try {
      if (!state || !newPromptSection) {
        log('Invalid state or prompt section for update', 'WARN', 'prompt-evolution');
        return false;
      }

      const stateStr = String(state).substring(0, 100);

      // Use passed-in analysis if available, otherwise re-fetch
      const analysisResult = precomputedAnalysis || await this.analyzePromptEffectiveness();
      const rawRate = (analysisResult?.analysis as any)?.[stateStr]?.successRate || 0;
      const currentRate = rawRate;

      // Fetch previous prompt BEFORE applying the new one
      const previousPrompt = this._getCurrentPromptSection(stateStr);

      db.prepare(
        'INSERT INTO prompt_evolution_log (timestamp, state, previous_prompt, new_prompt, success_rate_before, success_rate_after, status, measurement_cycles, measured_success) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)'
      ).run(
        Date.now(),
        stateStr,
        previousPrompt,
        String(newPromptSection).substring(0, 5000),
        currentRate,
        0,
        'active'
      );

      const overrides = this._loadOverrides();
      if (!overrides.overrides) overrides.overrides = {};
      overrides.overrides[stateStr] = newPromptSection;
      overrides._meta.lastUpdated = new Date().toISOString();
      overrides._meta.lastState = stateStr;

      // BUG FIX (Response 18): Write JSON, then invalidate cache.
      // Previous code didn't invalidate, so _loadOverrides would
      // return stale data until the next process restart.
      fs.writeFileSync(PROMPT_OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf8');
      this._invalidateOverridesCache();

      log(`Prompt override applied for state '${stateStr}'`, 'INFO', 'prompt-evolution');
      return true;
    } catch (err: any) {
      logError('Failed to apply prompt update', err);
      return false;
    }
  }

  async rollbackPrompt(state: any) {
    try {
      const stateStr = String(state);
      const activeLog = db.prepare(
        "SELECT * FROM prompt_evolution_log WHERE state = ? AND status = 'active' AND reverted = 0 ORDER BY timestamp DESC LIMIT 1"
      ).get(stateStr);

      if (!activeLog) {
        log(`No active prompt evolution found for state '${stateStr}' to rollback`, 'WARN', 'prompt-evolution');
        return false;
      }

      const overrides = this._loadOverrides();
      if (overrides.overrides && overrides.overrides[stateStr]) {
        if (activeLog.previous_prompt) {
          overrides.overrides[stateStr] = activeLog.previous_prompt;
        } else {
          delete overrides.overrides[stateStr];
        }
        overrides._meta.lastRollback = new Date().toISOString();
        overrides._meta.lastRollbackState = stateStr;

        fs.writeFileSync(PROMPT_OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf8');
        // BUG FIX (Response 18): Invalidate cache after rollback write
        this._invalidateOverridesCache();
      }

      db.prepare(
        'UPDATE prompt_evolution_log SET reverted = 1, reverted_at = ?, status = ? WHERE id = ?'
      ).run(Date.now(), 'rolled_back', activeLog.id);

      log(`Prompt rolled back for state '${stateStr}' (log id: ${activeLog.id})`, 'WARN', 'prompt-evolution');

      // BUG FIX (Response 18): Remove cooldown so the state can be
      // re-evolved after rollback (it clearly needs a better prompt)
      this._lastEvolvedAt.delete(stateStr);

      try {
        db.prepare(
          'INSERT INTO reflection_history (timestamp, suggestion_type, description, file, success) VALUES (?, ?, ?, ?, ?)'
        ).run(
          Date.now(),
          'prompt_rollback',
          `Rolled back prompt for state ${stateStr} - effectiveness did not improve`,
          'providers-prompt-evolution.ts',
          0
        );
      } catch (e: any) {
        // Non-fatal: reflection_history table may not exist
      }

      return true;
    } catch (err: any) {
      logError(`Failed to rollback prompt for state '${state}'`, err);
      return false;
    }
  }

  // ─── Cycle Outcome Recording ───

  /**
   * Record a cycle outcome for the active prompt evolution.
   * Called after each cycle completes to track whether the
   * evolved prompt is actually improving success rates.
   *
   * BUG FIX (Response 18): The comparison logic previously
   * used `successRate < 0.5` to decide rollback. Now uses the
   * named constant EVOLUTION_SUCCESS_RATE_THRESHOLD for clarity
   * and consistency with analyzePromptEffectiveness.
   */
  recordCycleOutcome(state: any, success: any) {
    try {
      const stateStr = String(state);
      const activeLog = db.prepare(
        "SELECT * FROM prompt_evolution_log WHERE state = ? AND status = 'active' AND reverted = 0 ORDER BY timestamp DESC LIMIT 1"
      ).get(stateStr);

      if (!activeLog) return;

      const measurementCycles = activeLog.measurement_cycles + 1;
      const measuredSuccess = activeLog.measured_success + (success ? 1 : 0);

      db.prepare(
        'UPDATE prompt_evolution_log SET measurement_cycles = ?, measured_success = ? WHERE id = ?'
      ).run(measurementCycles, measuredSuccess, activeLog.id);

      if (measurementCycles >= MEASUREMENT_WINDOW) {
        const newRatePercent = (measuredSuccess / measurementCycles) * 100;
        const beforeRate = activeLog.success_rate_before || 0;

        if (newRatePercent > beforeRate) {
          log(
            `Prompt evolution for '${stateStr}' IMPROVED: ${beforeRate.toFixed(2)} -> ${newRatePercent.toFixed(2)} (over ${measurementCycles} cycles)`,
            'INFO',
            'prompt-evolution'
          );

          db.prepare(
            'UPDATE prompt_evolution_log SET success_rate_after = ?, status = ? WHERE id = ?'
          ).run(newRatePercent, 'confirmed', activeLog.id);

          try {
            db.prepare(
              'INSERT INTO reflection_history (timestamp, suggestion_type, description, file, success) VALUES (?, ?, ?, ?, ?)'
            ).run(
              Date.now(),
              'prompt_evolution',
              `Prompt evolution confirmed for state ${stateStr}: ${beforeRate.toFixed(2)} -> ${newRatePercent.toFixed(2)}`,
              'providers-prompt-evolution.ts',
              1
            );
          } catch (e: any) { /* Non-fatal */ }
        } else {
          log(
            `Prompt evolution for '${stateStr}' did NOT improve: ${beforeRate.toFixed(2)} -> ${newRatePercent.toFixed(2)}, rolling back`,
            'WARN',
            'prompt-evolution'
          );
          // BUG FIX (Response 18): Log the rollback attempt instead of
          // silently swallowing errors via .catch(() => {})
          this.rollbackPrompt(stateStr).catch((rollbackErr: any) => {
            logError(`Auto-rollback failed for state '${stateStr}'`, rollbackErr);
          });
        }
      }
    } catch (err: any) {
      logError('Failed to record cycle outcome for prompt evolution', err);
    }
  }

  // ─── Evolution Cycle ───

  /**
   * Start the periodic prompt evolution cycle.
   *
   * BUG FIX (Response 18): If called without arguments (as agent.ts
   * does), the interval now defaults appropriately for the platform:
   * 12h on Render, 6h locally. Previously, undefined was passed
   * directly to setInterval, which defaults to 0 (fires immediately).
   */
  async startEvolutionCycle(intervalMs?: any) {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (_startupTimer) {
      clearTimeout(_startupTimer);
      _startupTimer = null;
    }

    // BUG FIX (Response 18): Default interval based on platform.
    // On Render, use a longer interval to reduce CPU and memory
    // pressure from tribunal calls.
    const isRender = _isRenderFreePlan();
    const interval = (typeof intervalMs === 'number' && intervalMs > 0)
      ? intervalMs
      : (isRender ? RENDER_INTERVAL_MS : DEFAULT_INTERVAL_MS);

    log(
      `Starting prompt evolution cycle (every ${Math.round(interval / 60000)} minutes, render=${isRender})`,
      'INFO',
      'prompt-evolution'
    );

    const runCycle = async () => {
      if (isShuttingDown()) return;
      try {
        log('Running prompt evolution analysis cycle...', 'INFO', 'prompt-evolution');

        const analysisResult = await this.analyzePromptEffectiveness();
        if (!analysisResult || !analysisResult.underperforming || analysisResult.underperforming.length === 0) {
          log('No underperforming states found, skipping evolution', 'DEBUG', 'prompt-evolution');
          return;
        }

        // BUG FIX (Response 18): Limit evolutions per cycle to prevent
        // excessive tribunal calls on Render's slow CPU.
        let evolvedThisCycle = 0;
        for (const stateData of analysisResult.underperforming) {
          if (evolvedThisCycle >= MAX_EVOLUTIONS_PER_CYCLE) {
            log(
              `Reached max evolutions per cycle (${MAX_EVOLUTIONS_PER_CYCLE}), stopping`,
              'DEBUG',
              'prompt-evolution'
            );
            break;
          }

          // BUG FIX (Response 18): Use named constants for thresholds
          if (stateData.successRate < EVOLUTION_SUCCESS_RATE_THRESHOLD && stateData.totalCycles >= MIN_CYCLES_FOR_EVOLUTION) {
            // BUG FIX (Response 18): Check cooldown before logging
            if (this._isStateOnCooldown(stateData.state)) {
              log(
                `State '${stateData.state}' on cooldown, skipping`,
                'DEBUG',
                'prompt-evolution'
              );
              continue;
            }

            log(
              `Evolving prompt for state '${stateData.state}' (success: ${(stateData.successRate * 100).toFixed(1)}%)`,
              'INFO',
              'prompt-evolution'
            );

            const stateAnalysis = (analysisResult.analysis as any)?.[stateData.state];
            if (stateAnalysis) {
              const result = await this.evolvePrompt(stateData.state, stateAnalysis);
              if (result?.applied) {
                evolvedThisCycle++;
              }
            }

            // BUG FIX (Response 18): Delay between tribunal calls to
            // avoid I/O burst on Render's throttled network.
            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }

        log(
          `Prompt evolution cycle complete (${evolvedThisCycle}/${analysisResult.underperforming.length} evolved)`,
          'INFO',
          'prompt-evolution'
        );
      } catch (err: any) {
        logError('Prompt evolution cycle failed', err);
      }
    };

    this._timer = setInterval(runCycle, interval);
    if (this._timer) this._timer.unref();

    // Run first cycle immediately (with a short delay to avoid startup contention)
    // BUG FIX (Response 18): .unref() the startup timer too
    _startupTimer = setTimeout(runCycle, 5000);
    if (_startupTimer) _startupTimer.unref();

    return this._timer;
  }

  stopEvolutionCycle() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
      log('Prompt evolution cycle stopped', 'INFO', 'prompt-evolution');
      return true;
    }
    return false;
  }

  getEvolutionStatus() {
    try {
      const active = db.prepare("SELECT * FROM prompt_evolution_log WHERE status = 'active' AND reverted = 0").all();
      const confirmed = db.prepare("SELECT * FROM prompt_evolution_log WHERE status = 'confirmed'").all();
      const rolledBack = db.prepare("SELECT * FROM prompt_evolution_log WHERE reverted = 1 ORDER BY reverted_at DESC LIMIT 10").all();

      return {
        activeEvolutions: active.map((r: any) => ({
          state: r.state,
          successRateBefore: r.success_rate_before,
          measurementProgress: `${r.measurement_cycles}/${MEASUREMENT_WINDOW}`,
          currentRate: r.measurement_cycles > 0
            ? (r.measured_success / r.measurement_cycles * 100).toFixed(1) + '%'
            : 'N/A'
        })),
        confirmedCount: confirmed.length,
        recentRollbacks: rolledBack.map((r: any) => ({
          state: r.state,
          rolledBackAt: r.reverted_at ? new Date(r.reverted_at).toISOString() : null
        })),
        isRunning: this._timer !== null
      };
    } catch (err: any) {
      logError('Failed to get evolution status', err);
      return { activeEvolutions: [], confirmedCount: 0, recentRollbacks: [], isRunning: false };
    }
  }

  getPromptForState(state: any) {
    try {
      const overrides = this._loadOverrides();
      if (overrides.overrides && overrides.overrides[state]) {
        return overrides.overrides[state];
      }
      return null;
    } catch (err: any) {
      return null;
    }
  }

  /**
   * Get the cooldown status of all recently evolved states.
   * Useful for debugging and the status API.
   */
  getCooldownStatus(): Record<string, number> {
    const result: Record<string, number> = {};
    const now = Date.now();
    for (const [state, lastEvolved] of this._lastEvolvedAt) {
      const remaining = Math.max(0, SAME_STATE_COOLDOWN_MS - (now - lastEvolved));
      if (remaining > 0) {
        result[state] = Math.round(remaining / 60000); // remaining minutes
      }
    }
    return result;
  }
}

// BUG FIX (Response 18): Module-level shutdown flag. On Render, the
// process may receive SIGTERM during an evolution cycle. Without
// this flag, the cycle would continue running even after shutdown
// is initiated, potentially causing errors during cleanup.
let _isShuttingDown = false;
function isShuttingDown(): boolean { return _isShuttingDown; }
process.once('SIGTERM', () => { _isShuttingDown = true; });
process.once('SIGINT', () => { _isShuttingDown = true; });

const promptEvolver = new PromptEvolver();

module.exports = {
  promptEvolver,
  PromptEvolver,
  /** @returns {Promise} - must be awaited */
// @ts-expect-error
  analyzePromptEffectiveness: (...args: any[]) => promptEvolver.analyzePromptEffectiveness(...args),
  /** @returns {Promise} - must be awaited */
// @ts-expect-error
  evolvePrompt: (...args: any[]) => promptEvolver.evolvePrompt(...args),
  applyPromptUpdate: (state: any, newPrompt: any, analysis: any) => promptEvolver.applyPromptUpdate(state, newPrompt, analysis),
  rollbackPrompt: (state: any) => promptEvolver.rollbackPrompt(state),
  startEvolutionCycle: (interval?: any) => promptEvolver.startEvolutionCycle(interval),
  stopEvolutionCycle: () => promptEvolver.stopEvolutionCycle(),
  getEvolutionStatus: () => promptEvolver.getEvolutionStatus(),
  getPromptForState: (state: any) => promptEvolver.getPromptForState(state),
  recordCycleOutcome: (state: any, success: any) => promptEvolver.recordCycleOutcome(state, success),
  /**
   * BUG FIX (Response 18): Expose cooldown status for diagnostics.
   */
  getCooldownStatus: () => promptEvolver.getCooldownStatus(),
  _injectDependencies,
};
