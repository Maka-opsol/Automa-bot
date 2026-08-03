'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const CONFIG = require('./get-config');

const STATES = {
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN'
};

const BASE_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes
const MAX_BACKOFF_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_SLIDING_WINDOW = 10;
const DEFAULT_FAILURE_RATE = 0.6;

class HealerCircuitBreaker {
  _state: any;
  _failureCount: any;
  _successCount: any;
  _lastFailureTime: any;
  _consecutiveOpens: any;
  _slidingWindow: any;
  _initialized: any;

  constructor() {
    this._state = STATES.CLOSED;
    this._failureCount = 0;
    this._successCount = 0;
    this._lastFailureTime = null;
    this._consecutiveOpens = 0;
    this._slidingWindow = []; // array of booleans: true=success, false=failure
    this._initialized = false;
  }

  _ensureTable() { 
    try {
      getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS healer_circuit_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          state TEXT NOT NULL DEFAULT 'CLOSED',
          failure_count INTEGER DEFAULT 0,
          success_count INTEGER DEFAULT 0,
          last_failure_time INTEGER,
          consecutive_opens INTEGER DEFAULT 0,
          sliding_window TEXT DEFAULT '[]',
          updated_at INTEGER
        )
      `);
    } catch (err: any) {
      logError('Failed to create healer_circuit_state table', err);
    }
  }

  _initFromDb() { 
    try {
      this._ensureTable();
      const row = getDb()?.prepare('SELECT * FROM healer_circuit_state WHERE id = 1').get();
      if (!row) {
        getDb()?.prepare(
          'INSERT INTO healer_circuit_state (id, state, failure_count, success_count, last_failure_time, consecutive_opens, sliding_window, updated_at) VALUES (1, ?, 0, 0, NULL, 0, ?, ?)'
        ).run(STATES.CLOSED, '[]', Date.now());
        this._state = STATES.CLOSED;
        this._failureCount = 0;
        this._successCount = 0;
        this._lastFailureTime = null;
        this._consecutiveOpens = 0;
        this._slidingWindow = [];
        log('Initialized healer circuit breaker state (new row)', 'INFO', 'healer-cb');
      } else {
        this._state = row.state || STATES.CLOSED;
        this._failureCount = row.failure_count ?? 0;
        this._successCount = row.success_count ?? 0;
        this._lastFailureTime = row.last_failure_time || null;
        this._consecutiveOpens = row.consecutive_opens ?? 0;
        try {
          this._slidingWindow = JSON.parse(row.sliding_window || '[]');
        } catch (e: any) {
          this._slidingWindow = [];
        }
        log(`Loaded healer circuit state: ${this._state} (opens: ${this._consecutiveOpens})`, 'INFO', 'healer-cb');
      }
      this._initialized = true;
    } catch (err: any) {
      logError('Failed to initialize circuit breaker from DB', err);
      this._initialized = true; // Don't retry infinitely
    }
  }

  _persist() { 
    try {
      getDb()?.prepare(`
        UPDATE healer_circuit_state SET
          state = ?,
          failure_count = ?,
          success_count = ?,
          last_failure_time = ?,
          consecutive_opens = ?,
          sliding_window = ?,
          updated_at = ?
        WHERE id = 1
      `).run(
        this._state,
        this._failureCount,
        this._successCount,
        this._lastFailureTime,
        this._consecutiveOpens,
        JSON.stringify(this._slidingWindow),
        Date.now()
      );
    } catch (err: any) {
      logError('Failed to persist circuit breaker state', err);
    }
  }

  _getBackoffMs() { 
    const backoff = BASE_BACKOFF_MS * Math.pow(2, this._consecutiveOpens);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }

  canAttemptHeal() { 
    try {
      if (!this._initialized) {
        this._initFromDb();
      }

      if (this._state === STATES.CLOSED) {
        log('Circuit breaker CLOSED: heal attempt allowed', 'DEBUG', 'healer-cb');
        return { allowed: true, reason: null };
      }

      if (this._state === STATES.OPEN) {
        const backoffMs = this._getBackoffMs();
        const elapsed = this._lastFailureTime ? (Date.now() - this._lastFailureTime) : Infinity;

        if (elapsed >= backoffMs) {
          this._state = STATES.HALF_OPEN;
          this._persist();
          log(`Circuit breaker transitioning OPEN -> HALF_OPEN (backoff ${Math.round(backoffMs / 60000)}min elapsed)`, 'INFO', 'healer-cb');
          return { allowed: true, reason: null };
        }

        const remaining = Math.ceil((backoffMs - elapsed) / 60000);
        log(`Circuit breaker OPEN: heal denied, ${remaining}min remaining in backoff`, 'WARN', 'healer-cb');
        return { allowed: false, reason: `Circuit breaker OPEN, backoff remaining: ${remaining}min` };
      }

      if (this._state === STATES.HALF_OPEN) {
        log('Circuit breaker HALF_OPEN: single attempt allowed', 'INFO', 'healer-cb');
        return { allowed: true, reason: null };
      }

      return { allowed: false, reason: 'Unknown circuit breaker state' };
    } catch (err: any) {
      logError('Error checking canAttemptHeal', err);
      return { allowed: true, reason: null }; // Fail-open on error
    }
  }

  recordHealResult(success: any) { 
    try {
      if (!this._initialized) {
        this._initFromDb();
      }

      // Use strict boolean check — truthy non-boolean values (e.g., error objects) must not be treated as success
      const isSuccess = success === true;

      if (isSuccess) {
        this._successCount++;
        log(`Heal attempt succeeded (state: ${this._state})`, 'INFO', 'healer-cb');
      } else {
        this._failureCount++;
        this._lastFailureTime = Date.now();
        log(`Heal attempt failed (state: ${this._state})`, 'WARN', 'healer-cb');
      }

      if (this._state === STATES.HALF_OPEN) {
        if (isSuccess) {
          this._state = STATES.CLOSED;
          this._consecutiveOpens = 0;
          this._slidingWindow = [];
          log('Circuit breaker HALF_OPEN -> CLOSED (heal succeeded)', 'INFO', 'healer-cb');
        } else {
          this._state = STATES.OPEN;
          this._consecutiveOpens++;
          log(`Circuit breaker HALF_OPEN -> OPEN (heal failed, consecutive opens: ${this._consecutiveOpens})`, 'WARN', 'healer-cb');
        }
      } else if (this._state === STATES.CLOSED) {
        const windowSize = CONFIG.HEALER_CB_SLIDING_WINDOW || DEFAULT_SLIDING_WINDOW;
        const failureRateThreshold = CONFIG.HEALER_CB_FAILURE_RATE || DEFAULT_FAILURE_RATE;

        this._slidingWindow.push(isSuccess);
        if (this._slidingWindow.length > windowSize) {
          this._slidingWindow.shift();
        }

        if (this._slidingWindow.length >= windowSize) {
          const failures = this._slidingWindow.filter((r: any) => !r).length;
          const rate = failures / this._slidingWindow.length;

          if (rate > failureRateThreshold) {
            this._state = STATES.OPEN;
            this._consecutiveOpens++;
            log(
              `Circuit breaker CLOSED -> OPEN (failure rate ${Math.round(rate * 100)}% > ${Math.round(failureRateThreshold * 100)}% in window of ${windowSize})`,
              'ERROR',
              'healer-cb'
            );
          }
        }
      }

      this._persist();
    } catch (err: any) {
      logError('Error recording heal result', err);
    }
  }

  getState() { 
    try {
      if (!this._initialized) {
        this._initFromDb();
      }
      return {
        state: this._state,
        failureCount: this._failureCount,
        successCount: this._successCount,
        lastFailureTime: this._lastFailureTime,
        consecutiveOpens: this._consecutiveOpens,
        slidingWindowSize: this._slidingWindow.length
      };
    } catch (err: any) {
      logError('Error getting circuit breaker state', err);
      return { state: 'UNKNOWN', error: err.message };
    }
  }

  wrapPerformSelfHeal(originalFn: any) { 
    const self = this;
    return async function wrappedPerformSelfHeal(...args: any[]) {
      try {
        const check = self.canAttemptHeal();
        if (!check.allowed) {
          log(`Heal blocked by circuit breaker: ${check.reason}`, 'WARN', 'healer-cb');
          return false;
        }

        log('Heal attempt permitted by circuit breaker, calling original performSelfHeal', 'DEBUG', 'healer-cb');
// @ts-expect-error
        const result = await originalFn.apply(this, args);
        const success = result === true;

        self.recordHealResult(success);
        log(`Heal attempt result recorded: ${success ? 'SUCCESS' : 'FAILURE'}`, success ? 'INFO' : 'WARN', 'healer-cb');

        return result;
      } catch (err: any) {
        logError('Error in wrapped performSelfHeal', err);
        self.recordHealResult(false);
        return false;
      }
    };
  }

  reset() { 
    try {
      this._state = STATES.CLOSED;
      this._failureCount = 0;
      this._successCount = 0;
      this._lastFailureTime = null;
      this._consecutiveOpens = 0;
      this._slidingWindow = [];
      this._persist();
      log('Healer circuit breaker manually reset to CLOSED', 'INFO', 'healer-cb');
    } catch (err: any) {
      logError('Error resetting circuit breaker', err);
    }
  }
}

const healerCircuitBreaker = new HealerCircuitBreaker();

// Initialize on require
try {
  healerCircuitBreaker._initFromDb();
} catch (err: any) {
  logError('Failed to initialize healer circuit breaker on startup', err);
}

module.exports = {
  HealerCircuitBreaker,
  healerCircuitBreaker,
  STATES,
  /**
   * Start the healer circuit breaker subsystem.
   * Called by container-subsystem-runner when HEALER_CIRCUIT_BREAKER_ENABLED is set.
   * The breaker is already initialized on require; this logs readiness.
   */
  start() {
    log('Healer circuit breaker subsystem started', 'INFO', 'healer-cb');
  },
  _injectDependencies,
};