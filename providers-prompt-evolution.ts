'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, logError } = require('./logger');
const { db } = require('./database');

const PROMPT_OVERRIDES_FILE = path.join(PROJECT_ROOT, 'prompt-overrides.json');
const MEASUREMENT_WINDOW = 50;
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

let _startupTimer: any = null;

class PromptEvolver {
  _timer: any;

  constructor() {
    this._timer = null;
    this._ensureOverridesFile();
    this._ensurePromptVersionsTable();
  }

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
      // Table may already exist
    }
  }

  async analyzePromptEffectiveness() { 
    try {
      const limit = 200;
      const minEntries = getCONFIG().PROMPT_EVOLUTION_MIN_ENTRIES || 50;

      let rows = [];
      try {
        rows = db.prepare('SELECT * FROM blackbox ORDER BY timestamp DESC LIMIT ?').all(limit);
      } catch (e: any) {
        log('Blackbox table not available for prompt analysis', 'WARN', 'prompt-evolution');
        return null;
      }

      if (rows.length < minEntries) {
        log(`Not enough blackbox entries for analysis (${rows.length} < ${minEntries})`, 'DEBUG', 'prompt-evolution');
        return null;
      }

      const stateGroups = {};

      for (const row of rows) {
        const state = row.state || 'unknown';
        if (!(stateGroups as any)[state]) {
          (stateGroups as any)[state] = { total: 0, successes: 0, latencies: [], actions: [], reasons: [] };
        }
        const group = (stateGroups as any)[state];
        group.total++;
        if (row.success === 1) group.successes++;
        if (row.latency) group.latencies.push(row.latency);
        if (row.action) group.actions.push(row.action);
        if (row.reasoning) group.reasons.push(row.reasoning);
      }

      const analysis = {};
      const underperforming = [];

      for (const [state, data] of Object.entries(stateGroups) as any[]) {
        if (data.total < 5) continue;

        const successRate = data.successes / data.total;
        const avgLatency = data.latencies.length > 0
          ? Math.round(data.latencies.reduce((a: any, b: any) => a + b, 0) / data.latencies.length)
          : 0;

        const actionCounts = {};
        for (const action of data.actions) {
          (actionCounts as any)[action] = ((actionCounts as any)[action] || 0) + 1;
        }
        const mostCommonAction = Object.entries(actionCounts)
          .sort((a: any, b: any) => b[1] - a[1])[0];

        const failureReasons = data.reasons
          .filter((r: any) => r)
          .map((r: any) => String(r).substring(0, 100));

        (analysis as any)[state] = {
          successRate: Math.round(successRate * 1000) / 10,
          avgLatency,
          totalCycles: data.total,
          mostCommonAction: mostCommonAction ? mostCommonAction[0] : null,
          mostCommonActionCount: mostCommonAction ? mostCommonAction[1] : 0,
          failureReasons
        };

        if (successRate < 0.5) {
          underperforming.push({
            state,
            successRate,
            avgLatency,
            failureReasons: data.reasons
              .filter((r: any) => r)
              .map((r: any) => String(r).substring(0, 100)),
            totalCycles: data.total
          });
        }
      }

      underperforming.sort((a, b) => a.successRate - b.successRate);

      log(`Prompt analysis: ${Object.keys(analysis).length} states analyzed, ${underperforming.length} underperforming (< 50% success)`, 'INFO', 'prompt-evolution');

      return { analysis, underperforming };
    } catch (err: any) {
      logError('Failed to analyze prompt effectiveness', err);
      return null;
    }
  }

  async evolvePrompt(state: any, analysis: any) { 
    try {
      if (!analysis || !analysis.failureReasons) {
        log('No analysis data for prompt evolution', 'WARN', 'prompt-evolution');
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

      let suggestion = null;
      try {
        const { generateCodeFixViaTribunal } = require('./providers-codegen-tribunal');
        const mockInvestigation = {
          url: 'prompt-evolution',
          html: '',
          fileContent: metaPrompt,
          targetFile: 'prompt-evolve'
        };
        const result = await generateCodeFixViaTribunal(mockInvestigation, metaPrompt);
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
      const stateLower = state.toLowerCase();
      let idx = basePrompt.toLowerCase().indexOf(stateLower);
      if (idx === -1) {
        // Also try original case (DB may store original case)
        idx = basePrompt.indexOf(state);
        if (idx === -1) {
          log(`Prompt substring not found for state: ${stateLower}`, 'DEBUG', 'prompt-evolution');
        }
      }
      if (idx !== -1) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(basePrompt.length, idx + state.length + 200);
        return '... ' + basePrompt.substring(start, end) + ' ...';
      }
      return null; // State section not found in prompt;
    } catch (e: any) {
      return null;
    }
  }

  async applyPromptUpdate(state: any, newPromptSection: any, precomputedAnalysis = null) { 
    try {
      if (!state || !newPromptSection) {
        log('Invalid state or prompt section for update', 'WARN', 'prompt-evolution');
        return false;
      }

      // Use passed-in analysis if available, otherwise re-fetch
      const analysisResult = precomputedAnalysis || await this.analyzePromptEffectiveness();
      const rawRate = (analysisResult?.analysis as any)?.[state]?.successRate || 0; // already a percentage (0-100) from analysis
      const currentRate = rawRate;

      db.prepare(
        'INSERT INTO prompt_evolution_log (timestamp, state, previous_prompt, new_prompt, success_rate_before, success_rate_after, status, measurement_cycles, measured_success) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)'
      ).run(
        Date.now(),
        state.substring(0, 100),
        this._getCurrentPromptSection(state),
        newPromptSection.substring(0, 5000),
        currentRate,
        0,
        'active'
      );

      const overrides = this._loadOverrides();
      if (!overrides.overrides) overrides.overrides = {};
      overrides.overrides[state] = newPromptSection;
      overrides._meta.lastUpdated = new Date().toISOString();
      overrides._meta.lastState = state;

      fs.writeFileSync(PROMPT_OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf8');

      log(`Prompt override applied for state '${state}'`, 'INFO', 'prompt-evolution');
      return true;
    } catch (err: any) {
      logError('Failed to apply prompt update', err);
      return false;
    }
  }

  async rollbackPrompt(state: any) { 
    try {
      const activeLog = db.prepare(
        "SELECT * FROM prompt_evolution_log WHERE state = ? AND status = 'active' AND reverted = 0 ORDER BY timestamp DESC LIMIT 1"
      ).get(state);

      if (!activeLog) {
        log(`No active prompt evolution found for state '${state}' to rollback`, 'WARN', 'prompt-evolution');
        return false;
      }

      const overrides = this._loadOverrides();
      if (overrides.overrides && overrides.overrides[state]) {
        if (activeLog.previous_prompt) {
          overrides.overrides[state] = activeLog.previous_prompt;
        } else {
          delete overrides.overrides[state];
        }
        overrides._meta.lastRollback = new Date().toISOString();
        overrides._meta.lastRollbackState = state;

        fs.writeFileSync(PROMPT_OVERRIDES_FILE, JSON.stringify(overrides, null, 2), 'utf8');
      }

      db.prepare(
        'UPDATE prompt_evolution_log SET reverted = 1, reverted_at = ?, status = ? WHERE id = ?'
      ).run(Date.now(), 'rolled_back', activeLog.id);

      log(`Prompt rolled back for state '${state}' (log id: ${activeLog.id})`, 'WARN', 'prompt-evolution');

      try {
        db.prepare(
          'INSERT INTO reflection_history (timestamp, suggestion_type, description, file, success) VALUES (?, ?, ?, ?, ?)'
        ).run(Date.now(), 'prompt_rollback', `Rolled back prompt for state ${state} - effectiveness did not improve`, 'providers-prompt-evolution.js', 0);
      } catch (e: any) {
        // Non-fatal
      }

      return true;
    } catch (err: any) {
      logError(`Failed to rollback prompt for state '${state}'`, err);
      return false;
    }
  }

  _loadOverrides() { 
    try {
      if (fs.existsSync(PROMPT_OVERRIDES_FILE)) {
        return JSON.parse(fs.readFileSync(PROMPT_OVERRIDES_FILE, 'utf8'));
      }
    } catch (err: any) {
      logError('Failed to load prompt overrides', err);
    }
    return { _meta: { version: 1 }, overrides: {} };
  }

  recordCycleOutcome(state: any, success: any) { 
    try {
      const activeLog = db.prepare(
        "SELECT * FROM prompt_evolution_log WHERE state = ? AND status = 'active' AND reverted = 0 ORDER BY timestamp DESC LIMIT 1"
      ).get(state);

      if (!activeLog) return;

      const measurementCycles = activeLog.measurement_cycles + 1;
      const measuredSuccess = activeLog.measured_success + (success ? 1 : 0);

      db.prepare(
        'UPDATE prompt_evolution_log SET measurement_cycles = ?, measured_success = ? WHERE id = ?'
      ).run(measurementCycles, measuredSuccess, activeLog.id);

      if (measurementCycles >= MEASUREMENT_WINDOW) {
        const newRatePercent = (measuredSuccess / measurementCycles) * 100;
        const beforeRate = activeLog.success_rate_before || 0; // already 0-100 from analysis

        if (newRatePercent > beforeRate) {
          log(`Prompt evolution for '${state}' IMPROVED: ${beforeRate.toFixed(2)} -> ${newRatePercent.toFixed(2)} (over ${measurementCycles} cycles)`, 'INFO', 'prompt-evolution');

          db.prepare(
            'UPDATE prompt_evolution_log SET success_rate_after = ?, status = ? WHERE id = ?'
          ).run(newRatePercent, 'confirmed', activeLog.id);

          try {
            db.prepare(
              'INSERT INTO reflection_history (timestamp, suggestion_type, description, file, success) VALUES (?, ?, ?, ?, ?)'
            ).run(Date.now(), 'prompt_evolution', `Prompt evolution confirmed for state ${state}: ${beforeRate.toFixed(2)} -> ${newRatePercent.toFixed(2)}`, 'providers-prompt-evolution.js', 1);
          } catch (e: any) { /* Non-fatal */ }
        } else {
          log(`Prompt evolution for '${state}' did NOT improve: ${beforeRate.toFixed(2)} -> ${newRatePercent.toFixed(2)}, rolling back`, 'WARN', 'prompt-evolution');
          this.rollbackPrompt(state).catch(() => {});
        }
      }
    } catch (err: any) {
      logError('Failed to record cycle outcome for prompt evolution', err);
    }
  }

  async startEvolutionCycle(intervalMs: any) { 
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    if (_startupTimer) {
      clearTimeout(_startupTimer);
      _startupTimer = null;
    }

    const interval = intervalMs || DEFAULT_INTERVAL_MS;

    log(`Starting prompt evolution cycle (every ${Math.round(interval / 60000)} minutes)`, 'INFO', 'prompt-evolution');

    const runCycle = async () => {
      try {
        log('Running prompt evolution analysis cycle...', 'INFO', 'prompt-evolution');

        const analysisResult = await this.analyzePromptEffectiveness();
        if (!analysisResult || !analysisResult.underperforming || analysisResult.underperforming.length === 0) {
          log('No underperforming states found, skipping evolution', 'DEBUG', 'prompt-evolution');
          return;
        }

        for (const state of analysisResult.underperforming) {
          if (state.successRate < 0.3 && state.totalCycles >= 10) {
            log(`Evolving prompt for state '${state.state}' (success: ${(state.successRate * 100).toFixed(1)}%)`, 'INFO', 'prompt-evolution');

            const stateAnalysis = (analysisResult.analysis as any)[state.state];
            if (stateAnalysis) {
              await this.evolvePrompt(state.state, stateAnalysis);
            }

            await new Promise(resolve => setTimeout(resolve, 5000));
          }
        }

        log('Prompt evolution cycle complete', 'INFO', 'prompt-evolution');
      } catch (err: any) {
        logError('Prompt evolution cycle failed', err);
      }
    };

    this._timer = setInterval(runCycle, interval);
    if (this._timer) this._timer.unref();

    // Run first cycle immediately (with a short delay to avoid startup contention)
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
          currentRate: r.measurement_cycles > 0 ? (r.measured_success / r.measurement_cycles * 100).toFixed(1) + '%' : 'N/A'
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
}

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
  startEvolutionCycle: (interval: any) => promptEvolver.startEvolutionCycle(interval),
  stopEvolutionCycle: () => promptEvolver.stopEvolutionCycle(),
  getEvolutionStatus: () => promptEvolver.getEvolutionStatus(),
  getPromptForState: (state: any) => promptEvolver.getPromptForState(state),
  recordCycleOutcome: (state: any, success: any) => promptEvolver.recordCycleOutcome(state, success),
  _injectDependencies,
};