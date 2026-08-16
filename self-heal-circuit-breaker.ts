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
  _cascadeModeSince: any; // v2: Track when cascade mode was activated

  constructor() {
    this._state = STATES.CLOSED;
    this._failureCount = 0;
    this._successCount = 0;
    this._lastFailureTime = null;
    this._consecutiveOpens = 0;
    this._slidingWindow = [];
    this._initialized = false;
    this._cascadeModeSince = null;
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
          cascade_mode_since INTEGER,
          updated_at INTEGER
        )
      `);
      // Migration: add cascade_mode_since column if missing
      try {
        getDb()?.exec(`ALTER TABLE healer_circuit_state ADD COLUMN cascade_mode_since INTEGER`);
      } catch (alterErr: any) {
        if (!alterErr.message?.includes('duplicate column')) {
          log(`Circuit breaker migration warning: ${alterErr.message}`, 'DEBUG', 'healer-cb');
        }
      }
      // Migration: add sliding_window column if missing (legacy)
      try {
        getDb()?.exec(`ALTER TABLE healer_circuit_state ADD COLUMN sliding_window TEXT DEFAULT '[]'`);
      } catch (alterErr: any) {
        if (!alterErr.message?.includes('duplicate column')) {
          log(`Circuit breaker migration warning: ${alterErr.message}`, 'DEBUG', 'healer-cb');
        }
      }
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
          'INSERT INTO healer_circuit_state (id, state, failure_count, success_count, last_failure_time, consecutive_opens, sliding_window, cascade_mode_since, updated_at) VALUES (1, ?, 0, 0, NULL, 0, ?, NULL, ?)'
        ).run(STATES.CLOSED, '[]', Date.now());
        this._state = STATES.CLOSED;
        this._failureCount = 0;
        this._successCount = 0;
        this._lastFailureTime = null;
        this._consecutiveOpens = 0;
        this._slidingWindow = [];
        this._cascadeModeSince = null;
        log('Initialized healer circuit breaker state (new row)', 'INFO', 'healer-cb');
      } else {
        this._state = row.state || STATES.CLOSED;
        this._failureCount = row.failure_count ?? 0;
        this._successCount = row.success_count ?? 0;
        this._lastFailureTime = row.last_failure_time || null;
        this._consecutiveOpens = row.consecutive_opens ?? 0;
        this._cascadeModeSince = row.cascade_mode_since || null;
        try {
          this._slidingWindow = JSON.parse(row.sliding_window || '[]');
        } catch (e: any) {
          this._slidingWindow = [];
        }
        log(`Loaded healer circuit state: ${this._state} (opens: ${this._consecutiveOpens}${this._cascadeModeSince ? ', cascade since ' + new Date(this._cascadeModeSince).toISOString() : ''})`, 'INFO', 'healer-cb');
      }
      this._initialized = true;
    } catch (err: any) {
      logError('Failed to initialize circuit breaker from DB', err);
      this._initialized = true;
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
          cascade_mode_since = ?,
          updated_at = ?
        WHERE id = 1
      `).run(
        this._state,
        this._failureCount,
        this._successCount,
        this._lastFailureTime,
        this._consecutiveOpens,
        JSON.stringify(this._slidingWindow),
        this._cascadeModeSince,
        Date.now()
      );
    } catch (err: any) {
      if (err.message?.includes('no such column')) {
        try {
          getDb()?.exec(`ALTER TABLE healer_circuit_state ADD COLUMN cascade_mode_since INTEGER`);
          getDb()?.exec(`ALTER TABLE healer_circuit_state ADD COLUMN sliding_window TEXT DEFAULT '[]'`);
          getDb()?.prepare(`
            UPDATE healer_circuit_state SET
              state = ?, failure_count = ?, success_count = ?,
              last_failure_time = ?, consecutive_opens = ?,
              sliding_window = ?, cascade_mode_since = ?, updated_at = ?
            WHERE id = 1
          `).run(
            this._state, this._failureCount, this._successCount,
            this._lastFailureTime, this._consecutiveOpens,
            JSON.stringify(this._slidingWindow), this._cascadeModeSince, Date.now()
          );
        } catch (retryErr: any) {
          logError('Failed to persist circuit breaker state after migration', retryErr);
        }
      } else {
        logError('Failed to persist circuit breaker state', err);
      }
    }
  }

  _getBackoffMs() {
    const backoff = BASE_BACKOFF_MS * Math.pow(2, this._consecutiveOpens);
    return Math.min(backoff, MAX_BACKOFF_MS);
  }

  /**
   * v2: Get a REDUCED backoff when in cascade mode.
   * The whole point of cascade mode is to try every provider —
   * a long backoff defeats that purpose. Use 1/3 of normal backoff.
   */
  _getCascadeBackoffMs() {
    const normalBackoff = this._getBackoffMs();
    return Math.min(normalBackoff, 10 * 60 * 1000); // Max 10 min in cascade
  }

  /**
   * v2: Notify the circuit breaker that cascade mode has been activated.
   * This adjusts the backoff and threshold behavior.
   */
  notifyCascadeActivated() {
    if (!this._cascadeModeSince) {
      this._cascadeModeSince = Date.now();
      this._persist();
      log('Circuit breaker: cascade mode ACTIVATED — reduced backoff, allowing full provider exploration', 'WARN', 'healer-cb');
    }
  }

  /**
   * v2: Notify the circuit breaker that cascade mode has ended
   * (either success or the cascade itself failed).
   */
  notifyCascadeDeactivated(success: boolean) {
    if (this._cascadeModeSince) {
      const cascadeDuration = Date.now() - this._cascadeModeSince;
      this._cascadeModeSince = null;
      this._persist();
      log(`Circuit breaker: cascade mode DEACTIVATED after ${Math.round(cascadeDuration / 1000)}s (result: ${success ? 'SUCCESS' : 'FAILED'})`, success ? 'INFO' : 'WARN', 'healer-cb');
    }
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
        // v2: Use reduced backoff in cascade mode
        const backoffMs = this._cascadeModeSince
          ? this._getCascadeBackoffMs()
          : this._getBackoffMs();
        const elapsed = this._lastFailureTime ? (Date.now() - this._lastFailureTime) : Infinity;

        if (elapsed >= backoffMs) {
          this._state = STATES.HALF_OPEN;
          this._persist();
          log(`Circuit breaker transitioning OPEN -> HALF_OPEN (backoff ${Math.round(backoffMs / 60000)}min elapsed${this._cascadeModeSince ? ' [CASCADE reduced]' : ''})`, 'INFO', 'healer-cb');
          return { allowed: true, reason: null };
        }

        const remaining = Math.ceil((backoffMs - elapsed) / 60000);
        log(`Circuit breaker OPEN: heal denied, ${remaining}min remaining in backoff${this._cascadeModeSince ? ' [CASCADE reduced]' : ''}`, 'WARN', 'healer-cb');
        return { allowed: false, reason: `Circuit breaker OPEN, backoff remaining: ${remaining}min` };
      }

      if (this._state === STATES.HALF_OPEN) {
        log('Circuit breaker HALF_OPEN: single attempt allowed', 'INFO', 'healer-cb');
        return { allowed: true, reason: null };
      }

      return { allowed: false, reason: 'Unknown circuit breaker state' };
    } catch (err: any) {
      logError('Error checking canAttemptHeal', err);
      return { allowed: true, reason: null };
    }
  }

  recordHealResult(success: any) {
    try {
      if (!this._initialized) {
        this._initFromDb();
      }

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
        // v2: Use a LARGER window in cascade mode (more forgiving)
        const effectiveWindowSize = this._cascadeModeSince
          ? Math.max(windowSize, 15)
          : windowSize;
        // v2: Use a HIGHER failure rate threshold in cascade mode
        const failureRateThreshold = this._cascadeModeSince
          ? 0.8  // 80% failures before opening (cascade is expected to be harder)
          : (CONFIG.HEALER_CB_FAILURE_RATE || DEFAULT_FAILURE_RATE);

        this._slidingWindow.push(isSuccess);
        if (this._slidingWindow.length > effectiveWindowSize) {
          this._slidingWindow.shift();
        }

        if (this._slidingWindow.length >= effectiveWindowSize) {
          const failures = this._slidingWindow.filter((r: any) => !r).length;
          const rate = failures / this._slidingWindow.length;

          if (rate > failureRateThreshold) {
            this._state = STATES.OPEN;
            this._consecutiveOpens++;
            log(
              `Circuit breaker CLOSED -> OPEN (failure rate ${Math.round(rate * 100)}% > ${Math.round(failureRateThreshold * 100)}% in window of ${effectiveWindowSize}${this._cascadeModeSince ? ' [CASCADE mode]' : ''})`,
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
        slidingWindowSize: this._slidingWindow.length,
        cascadeMode: !!this._cascadeModeSince,
        cascadeModeSince: this._cascadeModeSince,
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
      this._cascadeModeSince = null;
      this._persist();
      log('Healer circuit breaker manually reset to CLOSED', 'INFO', 'healer-cb');
    } catch (err: any) {
      logError('Error resetting circuit breaker', err);
    }
  }
}

const healerCircuitBreaker = new HealerCircuitBreaker();

try {
  healerCircuitBreaker._initFromDb();
} catch (err: any) {
  logError('Failed to initialize healer circuit breaker on startup', err);
}

module.exports = {
  HealerCircuitBreaker,
  healerCircuitBreaker,
  STATES,
  start() {
    log('Healer circuit breaker subsystem started', 'INFO', 'healer-cb');
  },
  _injectDependencies,
};
