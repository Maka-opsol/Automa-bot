'use strict';

// ─── Error Taxonomy for MathU Bot ───
// All domain errors extend MathUBotError. Consumers can use instanceof
// to classify and route errors to the correct recovery strategy.

// ─── Error Code Constants ───
const ERROR_CODES: Readonly<Record<string, string>> = Object.freeze({
  // Base
  UNKNOWN: 'E_UNKNOWN',

  // Transient (retryable)
  NETWORK_TIMEOUT: 'E_NETWORK_TIMEOUT',
  RATE_LIMITED: 'E_RATE_LIMITED',
  PROVIDER_TEMPORARY: 'E_PROVIDER_TEMPORARY',
  BROWSER_DISCONNECTED: 'E_BROWSER_DISCONNECTED',
  CAPTCHA_ENCOUNTERED: 'E_CAPTCHA_ENCOUNTERED',

  // Fatal (non-retryable, triggers shutdown)
  CREDENTIAL_INVALID: 'E_CREDENTIAL_INVALID',
  ENCRYPTION_FAILURE: 'E_ENCRYPTION_FAILURE',
  DATABASE_CORRUPT: 'E_DATABASE_CORRUPT',
  SANDBOX_ESCAPED: 'E_SANDBOX_ESCAPED',
  OUT_OF_MEMORY: 'E_OUT_OF_MEMORY',

  // Healable (triggers self-heal pipeline)
  SELECTOR_DRIFT: 'E_SELECTOR_DRIFT',
  UI_CHANGED: 'E_UI_CHANGED',
  PROVIDER_PERMANENT: 'E_PROVIDER_PERMANENT',
  STATE_DEADLOCK: 'E_STATE_DEADLOCK',
  PATCH_FAILED: 'E_PATCH_FAILED',

  // Domain-specific
  CONFIG_INVALID: 'E_CONFIG_INVALID',
  AUTH_FAILURE: 'E_AUTH_FAILURE',
  PROVIDER_ERROR: 'E_PROVIDER_ERROR',
  STATE_ERROR: 'E_STATE_ERROR',
  SANDBOX_ERROR: 'E_SANDBOX_ERROR',
  ENCRYPTION_ERROR: 'E_ENCRYPTION_ERROR',
  VALIDATION_ERROR: 'E_VALIDATION_ERROR',
}) as const;

// ─── Error Options Interface ───
interface MathUBotErrorOptions {
  code?: string;
  retryable?: boolean;
  healable?: boolean;
  cause?: Error | null;
  context?: Record<string, unknown>;
  retryAfterMs?: number | null;
}

// ─── Serialized Error Shape ───
interface SerializedError {
  name: string;
  code: string;
  message: string;
  retryable: boolean;
  healable: boolean;
  retryAfterMs: number | null;
  context: Record<string, unknown>;
  cause: { name: string; message: string; code?: string } | null;
}

/**
 * Base error for all MathU Bot domain errors.
 * Every subclass MUST call super(message, { code, ...context }).
 */
class MathUBotError extends Error {
  public readonly code: string;
  public readonly retryable: boolean;
  public readonly healable: boolean;
  public readonly cause: Error | null;
  public readonly context: Record<string, unknown>;
  public readonly retryAfterMs: number | null;
  public readonly timestamp: number;

  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = opts.code || ERROR_CODES.UNKNOWN;
    this.retryable = opts.retryable ?? false;
    this.healable = opts.healable ?? false;
    this.cause = opts.cause || null;
    this.context = opts.context || {};
    this.retryAfterMs = opts.retryAfterMs ?? null;
    this.timestamp = Date.now();
    Error.captureStackTrace(this, this.constructor);
  }

  /** Serialize for structured logging / API responses. */
  toJSON(): SerializedError {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      healable: this.healable,
      retryAfterMs: this.retryAfterMs,
      context: this.context,
      cause: this.cause
        ? { name: this.cause.name, message: this.cause.message, code: (this.cause as MathUBotError).code }
        : null,
    };
  }
}

// ─── Transient Errors (retryable) ───

class TransientError extends MathUBotError {
  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, retryable: true, code: opts.code || ERROR_CODES.UNKNOWN });
  }
}

class NetworkTimeoutError extends TransientError {
  constructor(message = 'Network request timed out', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.NETWORK_TIMEOUT });
  }
}

class RateLimitedError extends TransientError {
  constructor(message = 'Rate limited by upstream provider', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.RATE_LIMITED, retryAfterMs: opts.retryAfterMs || 60000 });
  }
}

class ProviderTemporaryError extends TransientError {
  constructor(provider: string, message = 'Provider temporarily unavailable', opts: MathUBotErrorOptions = {}) {
    super(`${provider}: ${message}`, { ...opts, code: ERROR_CODES.PROVIDER_TEMPORARY, context: { provider, ...opts.context } });
  }
}

class BrowserDisconnectedError extends TransientError {
  constructor(message = 'Browser disconnected unexpectedly', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.BROWSER_DISCONNECTED, retryAfterMs: opts.retryAfterMs || 5000 });
  }
}

class CaptchaEncounteredError extends TransientError {
  constructor(message = 'CAPTCHA encountered during automation', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.CAPTCHA_ENCOUNTERED });
  }
}

// ─── Fatal Errors (non-retryable) ───

class FatalError extends MathUBotError {
  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, retryable: false, code: opts.code || ERROR_CODES.UNKNOWN });
  }
}

class CredentialInvalidError extends FatalError {
  constructor(message = 'Invalid credentials', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.CREDENTIAL_INVALID });
  }
}

class EncryptionFailureError extends FatalError {
  constructor(message = 'Encryption operation failed', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.ENCRYPTION_FAILURE });
  }
}

class DatabaseCorruptError extends FatalError {
  constructor(message = 'Database corruption detected', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.DATABASE_CORRUPT });
  }
}

class SandboxEscapedError extends FatalError {
  constructor(message = 'Sandbox escape attempt detected', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.SANDBOX_ESCAPED });
  }
}

class OutOfMemoryError extends FatalError {
  constructor(message = 'Process out of memory', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.OUT_OF_MEMORY });
  }
}

// ─── Healable Errors (trigger self-heal) ───

class HealableError extends MathUBotError {
  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, healable: true, retryable: false, code: opts.code || ERROR_CODES.UNKNOWN });
  }
}

class SelectorDriftError extends HealableError {
  constructor(message = 'UI selector drift detected', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.SELECTOR_DRIFT });
  }
}

class UIChangedError extends HealableError {
  constructor(message = 'Significant UI change detected', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.UI_CHANGED });
  }
}

class ProviderPermanentError extends HealableError {
  constructor(provider: string, message = 'Provider permanently failed', opts: MathUBotErrorOptions = {}) {
    super(`${provider}: ${message}`, { ...opts, code: ERROR_CODES.PROVIDER_PERMANENT, context: { provider, ...opts.context } });
  }
}

class StateDeadlockError extends HealableError {
  constructor(message = 'State machine deadlock detected', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.STATE_DEADLOCK });
  }
}

class PatchFailedError extends HealableError {
  constructor(message = 'Self-heal patch failed', opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: ERROR_CODES.PATCH_FAILED });
  }
}

// ─── Domain-Specific Errors ───

class ConfigError extends MathUBotError {
  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: opts.code || ERROR_CODES.CONFIG_INVALID });
  }
}

class AuthenticationError extends MathUBotError {
  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: opts.code || ERROR_CODES.AUTH_FAILURE, retryable: opts.retryable ?? true });
  }
}

class ProviderError extends MathUBotError {
  constructor(provider: string, message: string, opts: MathUBotErrorOptions = {}) {
    super(`${provider}: ${message}`, { ...opts, code: opts.code || ERROR_CODES.PROVIDER_ERROR, context: { provider, ...opts.context } });
  }
}

class StateError extends MathUBotError {
  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: opts.code || ERROR_CODES.STATE_ERROR });
  }
}

class SandboxError extends MathUBotError {
  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: opts.code || ERROR_CODES.SANDBOX_ERROR });
  }
}

class ValidationError extends MathUBotError {
  constructor(message: string, opts: MathUBotErrorOptions = {}) {
    super(message, { ...opts, code: opts.code || ERROR_CODES.VALIDATION_ERROR });
  }
}

// ─── Helper: wrap any unknown error into the taxonomy ───

function classifyError(err: unknown): MathUBotError {
  if (err instanceof MathUBotError) return err;

  const message = (err as Error)?.message || String(err);

  // Auto-classify common Node / Playwright errors
  const lowerMessage = message.toLowerCase();
  if ((err as Error)?.name === 'TimeoutError' || lowerMessage.includes('timeout')) {
    return new NetworkTimeoutError(message, { cause: err as Error });
  }
  if (message.includes('rate limit') || message.includes('429') || message.includes('too many requests')) {
    return new RateLimitedError(message, { cause: err as Error });
  }
  if (lowerMessage.includes('browser') && (lowerMessage.includes('closed') || lowerMessage.includes('disconnected') || lowerMessage.includes('target closed'))) {
    return new BrowserDisconnectedError(message, { cause: err as Error });
  }
  if (message.includes('ECONNREFUSED') || message.includes('ENOTFOUND')) {
    return new TransientError(message, { cause: err as Error, code: 'E_CONNECTION_FAILED' });
  }
  if (message.includes('fetch failed')) {
    return new NetworkTimeoutError(message, { cause: err as Error });
  }
  if (lowerMessage.includes('captcha')) {
    return new CaptchaEncounteredError(message, { cause: err as Error });
  }

  // Default: wrap as unknown transient (safe default — retryable)
  return new TransientError(message, { cause: err as Error, code: ERROR_CODES.UNKNOWN });
}

module.exports = { ERROR_CODES, MathUBotError, TransientError, NetworkTimeoutError, RateLimitedError, ProviderTemporaryError, BrowserDisconnectedError, CaptchaEncounteredError, FatalError, CredentialInvalidError, EncryptionFailureError, DatabaseCorruptError, SandboxEscapedError, OutOfMemoryError, HealableError, SelectorDriftError, UIChangedError, ProviderPermanentError, StateDeadlockError, PatchFailedError, ConfigError, AuthenticationError, ProviderError, StateError, SandboxError, ValidationError, classifyError };
