'use strict';

// ─── Provider Health, Circuit Breakers, and Failure Classification ───
//
// This module is the single source of truth for:
//   1. ProviderHealth — per-provider metrics and scoring
//   2. CircuitBreaker — per-provider open/half-open/closed state machine
//   3. CooldownManager — per-provider, per-error-type cooldown timers
//   4. classifyError — structured error classification with retry guidance
//   5. Smart retry decision — shouldRetry() with delay calculation
//
// Priorities covered: P5 (health scoring), P6 (failure classification),
//   P7 (smart retry logic), P21 (cooldowns), P22 (circuit breakers)

// ─── Lazy Logger ───
let _loggerMod: any = null;
function _getLogger() { if (!_loggerMod) _loggerMod = require('./logger'); return _loggerMod; }
function _log(msg: string, level?: string, mod?: string) { try { _getLogger().log(msg, level, mod); } catch {} }

// ═══════════════════════════════════════════════════════════════════
// ERROR CLASSIFICATION (P6)
// ═══════════════════════════════════════════════════════════════════

export type ErrorCategory =
  | 'malformed'       // 400 — bad request, never retry
  | 'auth_failure'    // 401/403 — disable provider
  | 'model_removed'   // 404 — model not found, permanent
  | 'bad_format'      // 422 — unprocessable, never retry
  | 'rate_limited'    // 429 — cooldown with retry-after
  | 'server_error'    // 5xx — exponential backoff
  | 'timeout'         // request timed out
  | 'connection'      // ECONNRESET, ENOTFOUND, network
  | 'empty_response'  // provider returned empty content
  | 'too_large'       // response exceeded size limit
  | 'unknown';        // unclassified, allow limited retry

export interface ClassifiedError {
  category: ErrorCategory;
  retryable: boolean;
  disableProvider: boolean;
  retireProvider: boolean;
  retryAfterMs: number;      // 0 = no specific retry-after
  description: string;
}

/**
 * Classify an error into a structured category with retry/disable/retire guidance.
 * This replaces the old classifyError() in providers-base.ts which only had
 * 3 categories (transient/fatal/unknown) and missed 400/404/422/5xx.
 */
function classifyError(err: unknown): ClassifiedError {
  const msg = (err && typeof err === 'object' && (err as any).message) || (typeof err === 'string' ? err : '');
  const statusCode = extractStatus(err);
  const retryAfterMs = extractRetryAfter(err);

  // Check status code first (most reliable signal)
  if (statusCode === 400) {
    return { category: 'malformed', retryable: false, disableProvider: false, retireProvider: false, retryAfterMs: 0, description: `Bad request (400): ${truncateMsg(msg)}` };
  }
  if (statusCode === 401 || msg.includes('Invalid API key') || msg.includes('invalid_api_key') || msg.includes('Authentication error')) {
    return { category: 'auth_failure', retryable: false, disableProvider: true, retireProvider: false, retryAfterMs: 5000, description: `Auth failure (401): ${truncateMsg(msg)}` };
  }
  if (statusCode === 403) {
    return { category: 'auth_failure', retryable: false, disableProvider: true, retireProvider: false, retryAfterMs: 0, description: `Forbidden (403): ${truncateMsg(msg)}` };
  }
  if (statusCode === 404 || msg.includes('model not found') || msg.includes('does not exist') || msg.includes('not_available')) {
    return { category: 'model_removed', retryable: false, disableProvider: false, retireProvider: true, retryAfterMs: 0, description: `Model removed (404): ${truncateMsg(msg)}` };
  }
  if (statusCode === 422 || msg.includes('HTTP_ERROR_422')) {
    return { category: 'bad_format', retryable: false, disableProvider: false, retireProvider: false, retryAfterMs: 0, description: `Unprocessable (422): ${truncateMsg(msg)}` };
  }
  if (statusCode === 429 || msg.includes('RATE_LIMIT') || msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('too many requests') || msg.includes('OPENROUTER_DAILY_LIMIT') || msg.includes('OPENROUTER_PACING')) {
    const dailyMatch = msg.match(/OPENROUTER_DAILY_LIMIT.*?(\d+)\/(\d+)/);
    const pacingMatch = msg.includes('OPENROUTER_PACING');
    const retryMs = dailyMatch ? 3600000 : (pacingMatch ? 60000 : (retryAfterMs || 45000)); // 1h daily, 1min pacing, 45s default
    return { category: 'rate_limited', retryable: true, disableProvider: false, retireProvider: false, retryAfterMs: retryMs, description: dailyMatch ? `OpenRouter daily limit reached (${dailyMatch[1]}/${dailyMatch[2]}). Resumes at UTC midnight.` : pacingMatch ? `OpenRouter pacing: request too soon, wait 60s` : `Rate limited (429): retry after ${retryMs}ms` };
  }
  if (statusCode >= 500 && statusCode < 600) {
    return { category: 'server_error', retryable: true, disableProvider: false, retireProvider: false, retryAfterMs: 0, description: `Server error (${statusCode}): ${truncateMsg(msg)}` };
  }

  // Message-based classification (no status code)
  if (msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED') || msg.includes('ENOTFOUND') || msg.includes('socket hang up')) {
    return { category: 'connection', retryable: true, disableProvider: false, retireProvider: false, retryAfterMs: 2000, description: `Connection error: ${truncateMsg(msg)}` };
  }
  if (msg.includes('ETIMEDOUT') || msg.includes('Timeout') || msg.includes('timed out') || msg.includes('TIMEOUT')) {
    return { category: 'timeout', retryable: true, disableProvider: false, retireProvider: false, retryAfterMs: 2000, description: `Timeout: ${truncateMsg(msg)}` };
  }
  if (msg.includes('EMPTY_RESPONSE') || msg.includes('empty response') || msg.includes('CLOUDFLARE_EMPTY_RESPONSE')) {
    return { category: 'empty_response', retryable: true, disableProvider: false, retireProvider: false, retryAfterMs: 1000, description: 'Empty response from provider' };
  }
  if (msg.includes('RESPONSE_TOO_LARGE') || msg.includes('too large')) {
    return { category: 'too_large', retryable: false, disableProvider: false, retireProvider: false, retryAfterMs: 0, description: 'Response too large' };
  }
  if (msg.includes('browser disconnected') || msg.includes('Browser disconnected')) {
    return { category: 'connection', retryable: true, disableProvider: false, retireProvider: false, retryAfterMs: 3000, description: 'Browser disconnected' };
  }

  // Unknown — allow limited retry (max 1) since we can't classify
  return { category: 'unknown', retryable: true, disableProvider: false, retireProvider: false, retryAfterMs: 1000, description: `Unknown error: ${truncateMsg(msg)}` };
}

function extractStatus(err: unknown): number {
  const message = (err && typeof err === 'object' && (err as any).message)
    || (typeof err === 'string' ? err : '');
  if (err && typeof err === 'object') {
    const e = err as any;
    if (typeof e.status === 'number') return e.status;
    if (typeof e.statusCode === 'number') return e.statusCode;
  }
  const match = String(message).match(/(?:HTTP_ERROR_|HTTP\s+|^)([45]\d{2})\b/i);
  if (match) return parseInt(match[1], 10);
  return 0;
}

function extractRetryAfter(err: unknown): number {
  const message = (err && typeof err === 'object' && (err as any).message)
    || (typeof err === 'string' ? err : '');
  if (err && typeof err === 'object') {
    const retryAfterMs = (err as any).retryAfterMs;
    if (typeof retryAfterMs === 'number' && retryAfterMs > 0) return retryAfterMs;
  }
  const delay = String(message).match(/try again in\s+(?:(\d+)m)?([\d.]+)s/i);
  if (delay) {
    const minutes = parseInt(delay[1] || '0', 10);
    const seconds = parseFloat(delay[2]);
    const retryAfterMs = Math.round((minutes * 60 + seconds) * 1000);
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) return retryAfterMs;
  }
  return 0;
}

function truncateMsg(msg: string, maxLen = 120): string {
  if (!msg) return 'Unknown error';
  return msg.length > maxLen ? msg.slice(0, maxLen) + '...' : msg;
}

// ═══════════════════════════════════════════════════════════════════
// PROVIDER HEALTH SCORING (P5)
// ═══════════════════════════════════════════════════════════════════

export interface HealthSnapshot {
  providerName: string;
  healthScore: number;           // 0.0 – 1.0
  successRate: number;           // 0.0 – 1.0
  avgLatencyMs: number;
  consecutiveFailures: number;
  totalCalls: number;
  lastSuccessAt: number | null;  // epoch ms
  lastFailureAt: number | null;  // epoch ms
  errorBreakdown: Record<string, number>;  // category → count
  circuitState: CircuitState;
  cooldownUntil: number | null;  // epoch ms
  disabled: boolean;
}

export interface ErrorRecord {
  category: ErrorCategory;
  timestamp: number;
  latencyMs: number;
}

const MAX_ERROR_HISTORY = 50;
const MAX_LATENCY_WINDOW = 20;

/**
 * Per-provider health tracker.
 * Computes a composite health score from success rate, latency, error types,
 * and recency. Used by the registry to order tribunal candidates and by
 * the tribunal to weight votes.
 */
class ProviderHealth {
  private successes = 0;
  private failures = 0;
  private consecutiveFailures = 0;
  private latencyWindow: number[] = [];  // ring buffer of recent latencies
  private errorCounts: Record<string, number> = {};  // category → count
  private errorHistory: ErrorRecord[] = [];
  private lastSuccessAt: number | null = null;
  private lastFailureAt: number | null = null;
  private disabled = false;
  private disabledReason = '';
  private disabledAt = 0;

  constructor(private readonly providerName: string) {}

  recordSuccess(latencyMs: number): void {
    this.successes++;
    this.consecutiveFailures = 0;
    this.lastSuccessAt = Date.now();
    this._pushLatency(latencyMs);
  }

  recordFailure(category: ErrorCategory, latencyMs: number): void {
    this.failures++;
    this.consecutiveFailures++;
    this.lastFailureAt = Date.now();
    this._pushLatency(latencyMs);
    this.errorCounts[category] = (this.errorCounts[category] || 0) + 1;
    this.errorHistory.push({ category, timestamp: Date.now(), latencyMs });
    if (this.errorHistory.length > MAX_ERROR_HISTORY) {
      this.errorHistory.shift();
    }
  }

  disable(reason: string): void {
    this.disabled = true;
    this.disabledReason = reason;
    this.disabledAt = Date.now();
    _log(`${this.providerName} DISABLED: ${reason}`, 'WARN', 'health');
  }

  enable(): void {
    if (this.disabled) {
      _log(`${this.providerName} re-enabled`, 'INFO', 'health');
    }
    this.disabled = false;
    this.disabledReason = '';
    this.disabledAt = 0;
  }

  isDisabled(): boolean { return this.disabled; }

  /**
 * Compute composite health score 0.0 – 1.0.
 *
 * Components:
 *   - successRate (weight 0.5): success / total, min-samples guard
 *   - latencyScore (weight 0.2): inverse of avg latency, capped at 10s
 *   - errorDiversity (weight 0.15): penalize providers with many different error types
 *   - recency (weight 0.15): bonus for recent success, penalty for stale/failed
 *
 * Minimum samples (5) required before scoring kicks in; below that, returns 0.5
 * (neutral — assume healthy until proven otherwise).
 */
  healthScore(): number {
    const total = this.successes + this.failures;
    // Not enough data — neutral score
    if (total < 5) return 0.5;
    // Disabled providers get 0
    if (this.disabled) return 0.0;

    // Component 1: Success rate (0.0 – 1.0, weight 0.5)
    const successRate = this.successes / total;

    // Component 2: Latency score (0.0 – 1.0, weight 0.2)
    // Lower latency = higher score. 0ms = 1.0, >=10000ms = 0.0
    const avgLatency = this._avgLatency();
    const latencyScore = Math.max(0, 1.0 - (avgLatency / 10000));

    // Component 3: Error diversity penalty (weight 0.15)
    // More different error types = worse. 0 types = 1.0, 5+ types = 0.0
    const errorTypes = Object.keys(this.errorCounts).length;
    const diversityScore = Math.max(0, 1.0 - (errorTypes / 5));

    // Component 4: Recency (weight 0.15)
    // Recent success (within 5 min) = 1.0, stale (no call in 30 min) decays
    // Recent failure (within 1 min) heavily penalizes
    const now = Date.now();
    let recencyScore = 0.5; // neutral
    if (this.lastSuccessAt) {
      const ageMs = now - this.lastSuccessAt;
      if (ageMs < 5 * 60 * 1000) recencyScore = 1.0;
      else if (ageMs < 30 * 60 * 1000) recencyScore = 0.7;
      else recencyScore = 0.3;
    }
    if (this.lastFailureAt && (now - this.lastFailureAt) < 60 * 1000) {
      recencyScore *= 0.3; // heavy penalty for very recent failure
    }

    // Consecutive failure penalty
    let consecutivePenalty = 1.0;
    if (this.consecutiveFailures >= 5) consecutivePenalty = 0.1;
    else if (this.consecutiveFailures >= 3) consecutivePenalty = 0.3;
    else if (this.consecutiveFailures >= 2) consecutivePenalty = 0.6;

    const raw = (successRate * 0.5) + (latencyScore * 0.2) + (diversityScore * 0.15) + (recencyScore * 0.15);
    return Math.max(0, Math.min(1, raw * consecutivePenalty));
  }

  getConsecutiveFailures(): number { return this.consecutiveFailures; }

  getErrorCount(category: string): number { return this.errorCounts[category] || 0; }

  getSnapshot(circuitState: CircuitState, cooldownUntil: number | null): HealthSnapshot {
    const total = this.successes + this.failures;
    return {
      providerName: this.providerName,
      healthScore: this.healthScore(),
      successRate: total > 0 ? this.successes / total : 0,
      avgLatencyMs: this._avgLatency(),
      consecutiveFailures: this.consecutiveFailures,
      totalCalls: total,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
      errorBreakdown: { ...this.errorCounts },
      circuitState,
      cooldownUntil,
      disabled: this.disabled,
    };
  }

  private _pushLatency(ms: number): void {
    this.latencyWindow.push(ms);
    if (this.latencyWindow.length > MAX_LATENCY_WINDOW) this.latencyWindow.shift();
  }

  private _avgLatency(): number {
    if (this.latencyWindow.length === 0) return 0;
    const sum = this.latencyWindow.reduce((a, b) => a + b, 0);
    return sum / this.latencyWindow.length;
  }
}

// ═══════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER (P22)
// ═══════════════════════════════════════════════════════════════════

export type CircuitState = 'closed' | 'open' | 'half-open';

interface CircuitBreakerConfig {
  failureThreshold: number;     // consecutive failures to open
  halfOpenMaxAttempts: number;  // probes in half-open before re-opening
  successThreshold: number;     // successes in half-open to close
}

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  halfOpenMaxAttempts: 2,
  successThreshold: 1,
};

/**
 * Per-provider circuit breaker with open/half-open/closed states.
 *
 * - CLOSED: normal operation, requests flow through
 * - OPEN: all requests fail-fast, provider is bypassed
 * - HALF-OPEN: one probe request allowed to test recovery
 *
 * Cooldown durations vary by error category:
 *   - rate_limited: 45s
 *   - timeout: 30s
 *   - connection: 15s
 *   - server_error: 60s
 *   - auth_failure: 300s (5 min — needs manual/key refresh)
 *   - other: 60s
 */
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private halfOpenAttempts = 0;
  private halfOpenSuccesses = 0;
  private openedAt = 0;
  private lastFailureCategory: ErrorCategory = 'unknown';
  private _config: CircuitBreakerConfig;

  constructor(private readonly providerName: string, config?: Partial<CircuitBreakerConfig>) {
    this._config = { ...DEFAULT_CB_CONFIG, ...config };
  }

  getState(): CircuitState { return this.state; }

  /**
 * Called before a request. Returns true if the request should proceed.
 * Returns false if the circuit is open (caller should skip this provider).
 */
  allowRequest(): boolean {
    if (this.state === 'closed') return true;
    if (this.state === 'open') {
      const elapsed = Date.now() - this.openedAt;
      const cooldown = this._getCooldownMs();
      if (elapsed >= cooldown) {
        this.state = 'half-open';
        this.halfOpenAttempts = 0;
        this.halfOpenSuccesses = 0;
        _log(`${this.providerName} circuit → half-open after ${Math.round(elapsed / 1000)}s cooldown`, 'INFO', 'health');
        return true;
      }
      return false;
    }
    // half-open: allow limited probes
    if (this.halfOpenAttempts >= this._config.halfOpenMaxAttempts) {
      return false;
    }
    return true;
  }

  /**
 * Called after a successful request.
 */
  recordSuccess(): void {
    if (this.state === 'half-open') {
      this.halfOpenSuccesses++;
      this.halfOpenAttempts++;
      if (this.halfOpenSuccesses >= this._config.successThreshold) {
        this.state = 'closed';
        this.consecutiveFailures = 0;
        _log(`${this.providerName} circuit → closed (recovered)`, 'INFO', 'health');
      }
    } else {
      this.consecutiveFailures = 0;
    }
  }

  /**
 * Called after a failed request.
 */
  recordFailure(category: ErrorCategory): void {
    this.lastFailureCategory = category;
    if (this.state === 'half-open') {
      this.halfOpenAttempts++;
      // Any failure in half-open re-opens
      this.state = 'open';
      this.openedAt = Date.now();
      _log(`${this.providerName} circuit → re-opened (half-open probe failed: ${category})`, 'WARN', 'health');
    } else {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this._config.failureThreshold) {
        this.state = 'open';
        this.openedAt = Date.now();
        _log(`${this.providerName} circuit → open (${this.consecutiveFailures} consecutive failures, category=${category}, cooldown=${this._getCooldownMs() / 1000}s)`, 'ERROR', 'health');
      }
    }
  }

  /**
 * Cooldown duration in ms, varies by last failure category.
 */
  private _getCooldownMs(): number {
    switch (this.lastFailureCategory) {
      case 'rate_limited': return 45000;
      case 'timeout': return 30000;
      case 'connection': return 15000;
      case 'server_error': return 60000;
      case 'auth_failure': return 300000;  // 5 min
      default: return 60000;
    }
  }

  /**
 * Time remaining until circuit may transition from open → half-open.
 * Returns 0 if circuit is not open.
 */
  cooldownRemainingMs(): number {
    if (this.state !== 'open') return 0;
    const elapsed = Date.now() - this.openedAt;
    const remaining = this._getCooldownMs() - elapsed;
    return Math.max(0, remaining);
  }

  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.halfOpenAttempts = 0;
    this.halfOpenSuccesses = 0;
    this.openedAt = 0;
  }
}

// ═══════════════════════════════════════════════════════════════════
// COOLDOWN MANAGER (P21)
// ═══════════════════════════════════════════════════════════════════

/**
 * Per-provider, per-error-type cooldown timers.
 * Distinct from circuit breakers: cooldowns are explicit "do not retry until X"
 * while circuit breakers track consecutive failure patterns.
 *
 * A provider can be on cooldown AND have an open circuit simultaneously.
 */
class CooldownManager {
  // provider → errorCategory → cooldownUntil (epoch ms)
  private cooldowns = new Map<string, Map<string, number>>();

  /**
  * Set a cooldown for a specific provider + error category.
  * @param durationMs - cooldown duration. 0 or negative = no cooldown.
  */
  setCooldown(providerName: string, category: ErrorCategory, durationMs: number): void {
    if (durationMs <= 0) return;
    const until = Date.now() + durationMs;
    if (!this.cooldowns.has(providerName)) {
      this.cooldowns.set(providerName, new Map());
    }
    const providerCooldowns = this.cooldowns.get(providerName)!;
    providerCooldowns.set(category, until);
    _log(`${providerName} cooldown set: ${category} for ${Math.round(durationMs / 1000)}s`, 'DEBUG', 'health');
  }

  /**
  * Check if a provider is on cooldown for ANY error category.
  */
  isOnCooldown(providerName: string): boolean {
    const providerCooldowns = this.cooldowns.get(providerName);
    if (!providerCooldowns) return false;
    const now = Date.now();
    for (const [category, until] of providerCooldowns) {
      if (until > now) return true;
    }
    // All expired — clean up
    this.cooldowns.delete(providerName);
    return false;
  }

  /**
  * Get the earliest cooldown expiry for a provider, or null if not on cooldown.
  */
  getCooldownUntil(providerName: string): number | null {
    const providerCooldowns = this.cooldowns.get(providerName);
    if (!providerCooldowns) return null;
    const now = Date.now();
    let earliest: number | null = null;
    for (const [category, until] of providerCooldowns) {
      if (until > now) {
        if (earliest === null || until < earliest) earliest = until;
      }
    }
    // Clean expired entries
    for (const [category, until] of providerCooldowns) {
      if (until <= now) providerCooldowns.delete(category);
    }
    if (providerCooldowns.size === 0) this.cooldowns.delete(providerName);
    return earliest;
  }

  /**
  * Clear all cooldowns for a provider (e.g., after successful call).
  */
  clearCooldowns(providerName: string): void {
    this.cooldowns.delete(providerName);
  }

  /**
  * Prune expired cooldowns across all providers. Called periodically.
  */
  prune(): void {
    const now = Date.now();
    for (const [provider, cats] of this.cooldowns) {
      for (const [cat, until] of cats) {
        if (until <= now) cats.delete(cat);
      }
      if (cats.size === 0) this.cooldowns.delete(provider);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// SMART RETRY DECISION (P7)
// ═══════════════════════════════════════════════════════════════════

export interface RetryDecision {
  shouldRetry: boolean;
  delayMs: number;
  reason: string;
  maxRetries: number;  // total retries allowed for this error type
}

/**
 * Determine whether to retry based on the classified error and attempt count.
 * Replaces the old retryWithBackoff() which retried everything equally.
 *
 * Rules:
 *   - malformed (400): never retry
 *   - auth_failure (401): one retry after 5s (credential refresh window)
 *   - model_removed (404): never retry
 *   - bad_format (422): never retry
 *   - rate_limited (429): retry after provider-supplied retry-after, or 45s
 *   - server_error (5xx): exponential backoff, max 3 retries
 *   - timeout: retry after 2s, max 2 retries
 *   - connection: retry after 2s, max 3 retries
 *   - empty_response: retry after 1s, max 2 retries
 *   - unknown: one retry only
 */
function getRetryDecision(classified: ClassifiedError, attemptNumber: number): RetryDecision {
  // Never retry categories
  if (classified.category === 'malformed' || classified.category === 'model_removed' || classified.category === 'bad_format' || classified.category === 'too_large') {
    return { shouldRetry: false, delayMs: 0, reason: `${classified.category} is not retryable`, maxRetries: 0 };
  }

  // Auth failure: one retry after delay (key refresh window)
  if (classified.category === 'auth_failure') {
    if (attemptNumber >= 1) {
      return { shouldRetry: false, delayMs: 0, reason: 'auth_failure already retried once', maxRetries: 1 };
    }
    return { shouldRetry: true, delayMs: classified.retryAfterMs || 5000, reason: 'auth_failure: one retry after credential refresh window', maxRetries: 1 };
  }

  // Rate limited: retry after specified delay
  if (classified.category === 'rate_limited') {
    if (attemptNumber >= 3) {
      return { shouldRetry: false, delayMs: 0, reason: 'rate_limited: max 3 retries exceeded', maxRetries: 3 };
    }
    return { shouldRetry: true, delayMs: classified.retryAfterMs || 45000, reason: `rate_limited: retry after ${classified.retryAfterMs || 45000}ms`, maxRetries: 3 };
  }

  // Server error: exponential backoff, max 3 retries
  if (classified.category === 'server_error') {
    if (attemptNumber >= 3) {
      return { shouldRetry: false, delayMs: 0, reason: 'server_error: max 3 retries exceeded', maxRetries: 3 };
    }
    const delay = Math.min(1000 * Math.pow(2, attemptNumber) + Math.random() * 500, 30000);
    return { shouldRetry: true, delayMs: delay, reason: `server_error: exponential backoff ${Math.round(delay)}ms`, maxRetries: 3 };
  }

  // Timeout: retry after 2s, max 2 retries
  if (classified.category === 'timeout') {
    if (attemptNumber >= 2) {
      return { shouldRetry: false, delayMs: 0, reason: 'timeout: max 2 retries exceeded', maxRetries: 2 };
    }
    return { shouldRetry: true, delayMs: 2000, reason: 'timeout: retry after 2s', maxRetries: 2 };
  }

  // Connection error: retry after 2s, max 3 retries
  if (classified.category === 'connection') {
    if (attemptNumber >= 3) {
      return { shouldRetry: false, delayMs: 0, reason: 'connection: max 3 retries exceeded', maxRetries: 3 };
    }
    return { shouldRetry: true, delayMs: 2000 + Math.random() * 1000, reason: 'connection: retry after 2s', maxRetries: 3 };
  }

  // Empty response: retry after 1s, max 2 retries
  if (classified.category === 'empty_response') {
    if (attemptNumber >= 2) {
      return { shouldRetry: false, delayMs: 0, reason: 'empty_response: max 2 retries exceeded', maxRetries: 2 };
    }
    return { shouldRetry: true, delayMs: 1000, reason: 'empty_response: retry after 1s', maxRetries: 2 };
  }

  // Unknown: one retry only
  if (attemptNumber >= 1) {
    return { shouldRetry: false, delayMs: 0, reason: 'unknown: already retried once', maxRetries: 1 };
  }
  return { shouldRetry: true, delayMs: 1000, reason: 'unknown: one retry allowed', maxRetries: 1 };
}

// ═══════════════════════════════════════════════════════════════════
// HEALTH REGISTRY (singleton manager for all providers)
// ═══════════════════════════════════════════════════════════════════

const healthInstances = new Map<string, ProviderHealth>();
const circuitBreakerInstances = new Map<string, CircuitBreaker>();
const cooldownManager = new CooldownManager();

export function getProviderHealth(name: string): ProviderHealth {
  if (!healthInstances.has(name)) {
    healthInstances.set(name, new ProviderHealth(name));
  }
  return healthInstances.get(name)!;
}

export function getCircuitBreaker(name: string): CircuitBreaker {
  if (!circuitBreakerInstances.has(name)) {
    circuitBreakerInstances.set(name, new CircuitBreaker(name));
  }
  return circuitBreakerInstances.get(name)!;
}

export function getCooldownManager(): CooldownManager {
  return cooldownManager;
}

/**
 * Record a provider call result. This is the main entry point that updates
 * health, circuit breaker, and cooldowns in one call.
 *
 * Returns the classified error (if failed) or null (if success).
 */
export function recordCallResult(
  providerName: string,
  success: boolean,
  latencyMs: number,
  err?: unknown
): ClassifiedError | null {
  const health = getProviderHealth(providerName);
  const cb = getCircuitBreaker(providerName);

  if (success) {
    health.recordSuccess(latencyMs);
    cb.recordSuccess();
    cooldownManager.clearCooldowns(providerName);
    return null;
  }

  const classified = classifyError(err);
  health.recordFailure(classified.category, latencyMs);
  cb.recordFailure(classified.category);

  // Set cooldown if retryable and has a retry-after
  if (classified.retryAfterMs > 0) {
    cooldownManager.setCooldown(providerName, classified.category, classified.retryAfterMs);
  }

  // Disable provider if auth failure
  if (classified.disableProvider) {
    health.disable(classified.description);
  }

  return classified;
}

/**
 * Check if a provider should be allowed to make a request.
 * Returns true if: not disabled, not on cooldown, circuit breaker allows.
 */
export function isProviderAvailable(name: string): boolean {
  const health = getProviderHealth(name);
  if (health.isDisabled()) return false;
  if (cooldownManager.isOnCooldown(name)) return false;
  return getCircuitBreaker(name).allowRequest();
}

/**
 * Get a health snapshot for a provider, combining health + circuit + cooldown.
 */
export function getHealthSnapshot(name: string): HealthSnapshot {
  const health = getProviderHealth(name);
  const cb = getCircuitBreaker(name);
  const cooldownUntil = cooldownManager.getCooldownUntil(name);
  return health.getSnapshot(cb.getState(), cooldownUntil);
}

/**
 * Get all provider names that have health data.
 */
export function getTrackedProviders(): string[] {
  return [...healthInstances.keys()];
}

/**
 * Reset all state for a provider (used when provider config changes or on cycle reset).
 */
export function resetProviderState(name: string): void {
  const health = getProviderHealth(name);
  health.enable();
  getCircuitBreaker(name).reset();
  cooldownManager.clearCooldowns(name);
}

/**
 * Prune stale entries and expired cooldowns. Called periodically.
 */
export function pruneHealthData(): void {
  cooldownManager.prune();
  // Prune health instances with no data and not tracked
  for (const [name, health] of healthInstances) {
    const snap = health.getSnapshot('closed', null);
    if (snap.totalCalls === 0 && !circuitBreakerInstances.has(name)) {
      healthInstances.delete(name);
    }
  }
}

// Periodic prune every 10 minutes
const _pruneHealthInterval = setInterval(pruneHealthData, 10 * 60 * 1000);
if (typeof (_pruneHealthInterval as any).unref === 'function') {
  _pruneHealthInterval.unref();
}

// ═══════════════════════════════════════════════════════════════════
// STRUCTURED LOGGING HELPERS (P20)
// ═══════════════════════════════════════════════════════════════════

/**
 * Generate a structured log entry for a provider request.
 * Format is machine-parseable for dashboard aggregation.
 */
export function formatProviderLog(
  providerName: string,
  model: string,
  latencyMs: number,
  success: boolean,
  errorCategory: ErrorCategory | null,
  retryCount: number,
  healthScore: number
): string {
  const status = success ? 'OK' : (errorCategory || 'UNKNOWN').toUpperCase();
  return `[PROVIDER] name=${providerName} model=${model} latency=${Math.round(latencyMs)}ms status=${status} retries=${retryCount} health=${healthScore.toFixed(2)}`;
}

module.exports = {
  // Error classification
  classifyError,
  // Health scoring
  ProviderHealth,
  getProviderHealth,
  getHealthSnapshot,
  getTrackedProviders,
  // Circuit breakers
  CircuitBreaker,
  getCircuitBreaker,
  // Cooldowns
  CooldownManager,
  getCooldownManager,
  // Retry decisions
  getRetryDecision,
  // Unified recording
  recordCallResult,
  isProviderAvailable,
  resetProviderState,
  pruneHealthData,
  // Logging
  formatProviderLog,
  // Types (for JS consumers)
};
