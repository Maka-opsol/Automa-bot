'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const CONFIG = require('./get-config');
const crypto = require('crypto');

const PROMOTE_AFTER = CONFIG.STATE_RECOVERY_PROMOTE_AFTER || 5;
const STATE_TTL_DAYS = CONFIG.STATE_RECOVERY_TTL_DAYS || 7;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000; // weekly-ish (24h check, prune old)

// SQL for discovered_states table
const ENSURE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS discovered_states (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  state_name TEXT NOT NULL UNIQUE,
  transitions TEXT,
  screenshot_hash TEXT,
  reasoning TEXT,
  traverse_count INTEGER DEFAULT 0,
  promoted INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_traversed INTEGER
)`;

class StateRecovery {
  _runtimeTransitions: any;
  _initialized: any;
  _intervalId: any;

  constructor() {
    this._intervalId = null;
    this._runtimeTransitions = new Map(); // stateName -> [targetStates]
    this._initialized = false;
  }

  /**
   * Initialize: load promoted states into runtime transition table.
   */
  initialize() { 
    if (this._initialized) return;
    try {
      getDb()?.exec(ENSURE_TABLE_SQL);
      const promoted = getDb()?.prepare('SELECT state_name, transitions FROM discovered_states WHERE promoted = 1').all();
      for (const row of promoted) {
        try {
          const transitions = JSON.parse(row.transitions || '[]');
          this._runtimeTransitions.set(row.state_name, transitions);
        } catch (e: any) {
          logError(`Failed to parse transitions for discovered state ${row.state_name}`, e);
        }
      }
      this._initialized = true;
      if (promoted.length > 0) {
        log(`State recovery loaded ${promoted.length} promoted discovered states`, 'INFO', 'state-recovery');
      }
    } catch (err: any) {
      logError('State recovery initialization failed', err);
    }
  }

  /**
   * Handle a deadlock in the state machine.
   * Takes a screenshot, sends it to the tribunal for analysis,
   * and proposes a new state with valid transitions.
   *
   * @param {string} currentState - The current recognized state
   * @param {string} screenshot - Base64-encoded screenshot
   * @param {object} page - Playwright page object (optional, for additional data)
   * @returns {object|null} Proposed state info or null
   */
  async handleDeadlock(currentState: any, screenshot: any, page: any) { 
    log(`Handling deadlock in state: ${currentState}`, 'WARN', 'state-recovery');

    try {
      // Generate a hash of the screenshot for deduplication
      const screenshotHash = screenshot
        ? crypto.createHash('sha256').update(screenshot).digest('hex').slice(0, 16)
        : `no-screenshot-${Date.now()}`;

      // Check if we already have a discovered state for this screenshot
      try {
        const existing = getDb()?.prepare('SELECT state_name, promoted, transitions FROM discovered_states WHERE screenshot_hash = ?').get(screenshotHash);
        if (existing) {
          log(`Deadlock matches existing discovered state: ${existing.state_name} (promoted: ${existing.promoted})`, 'INFO', 'state-recovery');
          // Return existing if promoted
          if (existing.promoted) {
            return { proposed: true, state: existing.state_name, transitions: JSON.parse(existing.transitions || '[]'), existing: true };
          }
          // If not promoted, just increment observation
          this.observeTransition(existing.state_name);
          return { proposed: true, state: existing.state_name, existing: true, notYetPromoted: true };
        }
      } catch (e: any) {
        logError('Failed to check existing discovered states for deadlock', e);
      }

      // Build the prompt for the tribunal
      let pageContext = '';
      if (page) {
        try {
          pageContext = `\nPage URL: ${page.url()}`;
          const title = await page.title();
          pageContext += `\nPage title: ${title}`;
        } catch (e: any) {
          // page might be detached
        }
      }

      const prompt = `The bot is in an unknown state. The current recognized state is '${currentState}' but no valid transition exists. ` +
        `Analyze this screenshot and propose what new state this represents. Suggest valid transitions from this state.${pageContext}\n\n` +
        `Respond in this exact JSON format only (no markdown, no explanation outside JSON):\n` +
        `{"state_name": "descriptive_state_name", "transitions": ["target_state_1", "target_state_2"], "reasoning": "brief explanation of why this state exists"}`;

      // Send to tribunal for analysis (text-only — codegen models can't see images)
      let analysis = null;
      try {
        const { consultTribunalRaw } = require('./providers-codegen-tribunal');
        const signal = AbortSignal.timeout(90_000);
        const rawResult = await consultTribunalRaw(prompt, signal, { responseFormatJson: true });
        if (rawResult) {
          try {
            const parsed = JSON.parse(rawResult);
            if (parsed.state_name) analysis = parsed;
          } catch (e: any) {
            // Not valid JSON — try VLM fallback
          }
        }
      } catch (tribunalErr: any) {
        logError('Tribunal call failed for state discovery', tribunalErr);
      }

      // Fallback to VLM if tribunal didn't give us structured data
      if (!analysis || !analysis.state_name) {
        try {
          const { runVisionPipeline } = require('./providers-vision-pipeline');
          const vlmResult = await runVisionPipeline(screenshot, prompt);
          if (vlmResult && typeof vlmResult === 'string') {
            const jsonMatch = vlmResult.match(/\{[\s\S]*"state_name"[\s\S]*\}/);
            if (jsonMatch) {
              analysis = JSON.parse(jsonMatch[0]);
            }
          } else if (vlmResult?.state_name) {
            analysis = vlmResult;
          }
        } catch (vlmErr: any) {
          logError('VLM fallback failed for state discovery', vlmErr);
        }
      }

      if (!analysis || !analysis.state_name) {
        log('Could not determine new state from tribunal/VLM analysis', 'WARN', 'state-recovery');
        return null;
      }

      // Sanitize state name
      const stateName = analysis.state_name
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '');

      if (!stateName || stateName.length < 2) {
        log(`Invalid state name proposed: "${analysis.state_name}" -> "${stateName}"`, 'WARN', 'state-recovery');
        return null;
      }

      const transitions = Array.isArray(analysis.transitions) ? analysis.transitions : [];
      const reasoning = analysis.reasoning || 'Discovered via deadlock analysis';

      log(`Proposed new state: "${stateName}" with ${transitions.length} transitions`, 'INFO', 'state-recovery');

      return this.proposeNewState(stateName, transitions, screenshotHash, reasoning);
    } catch (err: any) {
      logError('Deadlock handling failed', err);
      return null;
    }
  }

  /**
   * Insert a newly discovered state into the database and register
   * tentative transitions in the runtime transition table.
   *
   * @param {string} stateName - The proposed state name
   * @param {string[]} transitions - Array of valid target states
   * @param {string} screenshotHash - Hash of the screenshot that triggered discovery
   * @param {string} reasoning - Why this state was proposed
   * @returns {object} { proposed: true, state: stateName }
   */
  proposeNewState(stateName: any, transitions: any, screenshotHash: any, reasoning: any) { 
    try {
      getDb()?.exec(ENSURE_TABLE_SQL);

      const now = Date.now();
      const transitionsJson = JSON.stringify(transitions);

      // Try insert - ignore if already exists (UNIQUE constraint)
      try {
        getDb()?.prepare(`
          INSERT INTO discovered_states (state_name, transitions, screenshot_hash, reasoning, traverse_count, promoted, created_at, last_traversed)
          VALUES(?, ?, ?, ?, 0, 0, ?, ?)
        `).run(stateName, transitionsJson, screenshotHash || null, reasoning, now, now);
        log(`New state proposed: "${stateName}"`, 'INFO', 'state-recovery');
        logAudit(`Discovered new state: ${stateName}`, 'state-recovery');
      } catch (insertErr: any) {
        if (insertErr.message?.includes('UNIQUE')) {
          log(`State "${stateName}" already exists, updating transitions`, 'DEBUG', 'state-recovery');
          getDb()?.prepare(`
            UPDATE discovered_states SET transitions = ?, screenshot_hash = ?, reasoning = ?, last_traversed = ?
            WHERE state_name = ?
          `).run(transitionsJson, screenshotHash || null, reasoning, now, stateName);
        } else {
          throw insertErr;
        }
      }

      // Add tentative transitions to the runtime transition table
      this._runtimeTransitions.set(stateName, transitions);

      return { proposed: true, state: stateName, transitions };
    } catch (err: any) {
      logError(`Failed to propose new state: ${stateName}`, err);
      return { proposed: false, state: stateName, error: err.message };
    }
  }

  /**
   * Record that the bot successfully traversed a discovered state.
   * Increment traverse_count; if threshold reached, promote to permanent.
   *
   * @param {string} stateName - The state that was traversed
   */
  observeTransition(stateName: any) { 
    try {
      getDb()?.exec(ENSURE_TABLE_SQL);

      const row = getDb()?.prepare('SELECT * FROM discovered_states WHERE state_name = ?').get(stateName);
      if (!row) {
        log(`Cannot observe transition for unknown state: ${stateName}`, 'WARN', 'state-recovery');
        return;
      }

      const newCount = (row.traverse_count || 0) + 1;
      getDb()?.prepare(`
        UPDATE discovered_states SET traverse_count = ?, last_traversed = ? WHERE state_name = ?
      `).run(newCount, Date.now(), stateName);

      if (newCount >= PROMOTE_AFTER && !row.promoted) {
        getDb()?.prepare('UPDATE discovered_states SET promoted = 1 WHERE state_name = ?').run(stateName);
        log(`State "${stateName}" promoted to permanent (traversed ${newCount} times)`, 'INFO', 'state-recovery');
        logAudit(`Discovered state promoted: ${stateName} (${newCount} traversals)`, 'state-recovery');
      }

      log(`State "${stateName}" traversed ${newCount}/${PROMOTE_AFTER} times`, 'DEBUG', 'state-recovery');
    } catch (err: any) {
      logError(`Failed to observe transition for ${stateName}`, err);
    }
  }

  /**
   * Remove discovered states that haven't been traversed recently
   * and haven't been promoted.
   */
  pruneExpiredStates() { 
    try {
      getDb()?.exec(ENSURE_TABLE_SQL);

      const ttlMs = STATE_TTL_DAYS * 24 * 60 * 60 * 1000;
      const cutoff = Date.now() - ttlMs;

      const result = getDb()?.prepare(`
        DELETE FROM discovered_states WHERE promoted = 0 AND (last_traversed IS NULL OR last_traversed < ?)
      `).run(cutoff);

      if (result.changes > 0) {
        log(`Pruned ${result.changes} expired discovered states (TTL: ${STATE_TTL_DAYS}d)`, 'INFO', 'state-recovery');

        // Clean up runtime transitions for pruned states
        const remaining = getDb()?.prepare('SELECT state_name FROM discovered_states').all();
        const remainingNames = new Set(remaining.map((r: any) => r.state_name));
        let smStates: any[] = [];
        try { smStates = Object.values(require('./state-machine').STATES || {}); } catch (e: any) { /* state-machine not available */ }
        for (const [stateName] of this._runtimeTransitions) {
          if (!remainingNames.has(stateName) && !smStates.includes(stateName)) {
            this._runtimeTransitions.delete(stateName);
          }
        }
      } else {
        log('No expired discovered states to prune', 'DEBUG', 'state-recovery');
      }

      return result.changes;
    } catch (err: any) {
      logError('Failed to prune expired states', err);
      return 0;
    }
  }

  /**
   * Get all promoted discovered states and their transitions.
   * Used by the state machine to extend its valid transition table.
   *
   * @returns {object} Map of state_name -> [validTargetStates]
   */
  getDiscoveredTransitions() {
    // Optimized: single query for all promoted states
    let dbError = false;
    try {
      const promotedRows = getDb()?.prepare('SELECT state_name, transitions FROM discovered_states WHERE promoted = 1').all();
      const promotedSet = new Set(promotedRows.map((r: any) => r.state_name));
      const result: Record<string, any> = {};
      for (const [stateName, transitions] of (this._runtimeTransitions as any)) {
        if (promotedSet.has(stateName)) {
          result[stateName] = transitions;
        }
      }
      return result;
    } catch (e: any) {
      log('DB query failed in getDiscoveredTransitions, falling back to individual queries', 'WARN', 'state-recovery');
      dbError = true;
    }

    if (dbError) {
      if (!this._initialized) this.initialize();
      const result: Record<string, any> = {};
      for (const [stateName, transitions] of this._runtimeTransitions) {
        try {
          const row = getDb()?.prepare('SELECT promoted FROM discovered_states WHERE state_name = ?').get(stateName);
          if (row && row.promoted) {
            result[stateName] = transitions;
          }
        } catch (e: any) {
          log(`getDiscoveredTransitions: DB query failed for ${stateName}, skipping`, 'WARN', 'state-recovery');
        }
      }
      return result;
    }

    return {};
  }

  /**
   * Get the full set of runtime transitions (including non-promoted tentative ones).
   * @returns {Map}
   */
  getRuntimeTransitions() { 
    if (!this._initialized) this.initialize();
    return this._runtimeTransitions;
  }

  /**
   * Start periodic pruning of expired states.
   * @param {number} intervalMs - Check interval (default 24 hours)
   */
  start(intervalMs: any) { 
    const interval = intervalMs || PRUNE_INTERVAL_MS;
    if (this._intervalId) {
      log('State recovery already running', 'WARN', 'state-recovery');
      return;
    }

    this.initialize();

    log(`State recovery started (prune interval: ${Math.round(interval / 3600000)}h)`, 'INFO', 'state-recovery');

    // Initial prune after short delay
    setTimeout(() => {
      try { this.pruneExpiredStates(); } catch (e: any) { logError('Initial state prune failed', e); }
    }, 30000).unref();

    this._intervalId = setInterval(() => {
      try { this.pruneExpiredStates(); } catch (e: any) { logError('Periodic state prune failed', e); }
    }, interval);

    if (this._intervalId.unref) this._intervalId.unref();
  }

  /**
   * Stop the periodic scheduler.
   */
  stop() { 
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      log('State recovery stopped', 'INFO', 'state-recovery');
    }
  }
}

// Singleton
const stateRecovery = new StateRecovery();
module.exports = { StateRecovery, stateRecovery , _injectDependencies };
