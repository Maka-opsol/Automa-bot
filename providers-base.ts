'use strict';

/**
 * providers-base.ts — Shared utilities for all AI providers.
 *
 * Key functions:
 *   extractJSON()               — Extract ALL JSON objects from a response string
 *   validateActionResponse()     — Validate the extracted action has required fields
 *   getProviderConfig()          — Get config for a named provider
 *   retryWithBackoff()           — Retry with exponential backoff + circuit-aware delays
 *   classifyError()              — Classify errors for circuit breaker / health tracking
 *   safeCall()                   — Timeout-wrapped call for tribunal etc.
 *   callChatCompletionWithRollback() — OpenAI-compatible chat completion with rollback
 *   fetchWithTimeout()           — Timeout-wrapped fetch
 *   sanitizeErrorText()          — Redact sensitive info from error text
 *   getFallbackModels()          — Get fallback models for a provider
 *   _getOrLimiter()              — Get OpenRouter rate limiter
 */

// ─── Raw Response Buffer ─────────────────────────────────────────────
// Stores full raw responses from all providers for dashboard inspection.
// TTL is configurable via RAW_RESPONSE_TTL_MS (default 30s, changeable from dashboard).

const _rawResponses: Array<{ provider: string; model: string; ts: number; content: string; fullBody?: string }> = [];
const RAW_RESPONSE_MAX = 20;

/**
 * Store a raw provider response for dashboard inspection.
 * @param provider - Provider name (e.g. 'Groq', 'Agnes')
 * @param content - The text content returned by the model
 * @param fullBody - Optional full HTTP response JSON (for OpenAI-compatible providers)
 * @param model - Model name used
 */
function storeRawResponse(provider: string, content: string, fullBody?: string, model?: string) {
  try {
    _rawResponses.push({
      provider,
      model: model || '',
      ts: Date.now(),
      content,
      fullBody: fullBody || undefined,
    });
    // Cap buffer size
    while (_rawResponses.length > RAW_RESPONSE_MAX) _rawResponses.shift();
  } catch { /* non-critical */ }
}

/**
 * Get all raw responses, pruning expired entries. TTL read from RAW_RESPONSE_TTL_MS config.
 */
function getRawResponses(): Array<{ provider: string; model: string; ts: number; content: string; fullBody?: string }> {
  const now = Date.now();
  let ttl = 30000;
  try { ttl = require('./get-config').RAW_RESPONSE_TTL_MS || 30000; } catch { /* use default */ }
  // Prune expired
  while (_rawResponses.length > 0 && now - _rawResponses[0].ts > ttl) {
    _rawResponses.shift();
  }
  return [..._rawResponses];
}

const _getLog = () => { try { return require('./logger'); } catch { return { log: console.log, logError: console.error }; } };

/**
 * DI injection hook — called by container-modules.ts during initialization.
 * providers-base uses lazy require() internally, so this is a no-op.
 */
function _injectDependencies(_deps: any) {
  // No-op: this module uses lazy require('./logger') and require('./get-config')
}

// ─── fetchWithTimeout ──────────────────────────────────────────────────
// Re-exported here so providers that require('./providers-base') don't
// need a separate require('./utils-fetch') (which can cause circular deps).

const _nativeFetch: any = globalThis.fetch;

async function fetchWithTimeout(url: any, options: any = {}, timeoutMs?: number) {
  try {
    const { fetchWithTimeout: _fwt } = require('./utils-fetch');
    return _fwt(url, options, timeoutMs);
  } catch {
    // Inline fallback if utils-fetch unavailable
    const config = require('./get-config');
    const effectiveTimeout = timeoutMs ?? config.REQUEST_TIMEOUT_MS ?? 30000;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
    let externalAbortHandler;
    if (options.signal) {
      externalAbortHandler = () => controller.abort();
      options.signal.addEventListener('abort', externalAbortHandler, { once: true });
      if (options.signal.aborted) { controller.abort(); }
    }
    try {
      const response = await _nativeFetch(url, { ...options, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timeoutId);
      if (options.signal && externalAbortHandler) { options.signal.removeEventListener('abort', externalAbortHandler); }
    }
  }
}

// ─── sanitizeErrorText ──────────────────────────────────────────────────

function sanitizeErrorText(errorText: string): string {
  if (typeof errorText !== 'string') return String(errorText);
  return errorText
    .replace(/(?:^|[\s:="'])[a-fA-F0-9]{32,}(?:[\s"'])/g, (match) => {
      return match.slice(0, -1) + '[REDACTED]';
    })
    .replace(/[A-Za-z0-9+/=]{40,}/g, '[REDACTED_BASE64]');
}

// ─── callChatCompletionWithRollback ─────────────────────────────────────

/**
 * Call an OpenAI-compatible chat completion endpoint.
 * Supports config rollback on 404/401 errors via providers-config-loader.
 * Handles protocol chameleon 422 recovery.
 */
async function callChatCompletionWithRollback(
  endpoint: string,
  apiKey: string,
  model: string,
  base64Image: any,
  prompt: any,
  providerName: string,
  options: { signal?: any; maxTokens?: number; temperature?: number; responseFormat?: any } = {}
): Promise<string> {
  const log = _getLog().log;

  // Build user content — flatten image + text into content array or string
  let userContent: any;
  if (base64Image && typeof base64Image === 'string' && base64Image.length > 0) {
    userContent = [
      { type: 'text', text: typeof prompt === 'string' ? prompt : String(prompt) },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
    ];
  } else {
    userContent = typeof prompt === 'string' ? prompt : String(prompt);
  }

  const payload: any = {
    model,
    messages: [{ role: 'user', content: userContent }],
    max_tokens: options.maxTokens || 4096,
    temperature: options.temperature ?? 0.1,
  };

  if (options.responseFormat) {
    payload.response_format = options.responseFormat;
  }

  const headers: Record<string, string> = {
    'Authorization': `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };

  // OpenRouter requires additional headers
  if (providerName === 'OpenRouter' || (endpoint && typeof endpoint === 'string' && endpoint.includes('openrouter.ai'))) {
    const config = require('./get-config');
    headers['HTTP-Referer'] = config.APP_URL || 'https://mathu-bot.local';
    headers['X-Title'] = 'MathU Bot';
  }

  const response = await fetchWithTimeout(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: options.signal,
  });

  // Handle 422 — protocol chameleon: try without response_format
  if (response.status === 422 && payload.response_format) {
    log(`${providerName} 422 — retrying without response_format`, 'WARN', 'base');
    delete payload.response_format;
    const retryResponse = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    });
    if (retryResponse.ok) {
      const data = await retryResponse.json();
      const content = data.choices?.[0]?.message?.content || '';
      storeRawResponse(providerName, content, JSON.stringify(data), model);
      return content;
    }
    const errText = sanitizeErrorText(await retryResponse.text().catch(() => 'Unknown error'));
    throw new Error(`HTTP_ERROR_${retryResponse.status}: ${errText}`);
  }

  // Handle 404 — model not found, attempt config rollback
  if (response.status === 404) {
    try {
      const { rollbackProvider } = require('./providers-config-loader');
      const rolledBack = rollbackProvider(providerName);
      if (rolledBack) {
        log(`${providerName} 404 — config rolled back, retrying with new model`, 'WARN', 'base');
        const newConfig = require('./get-config');
        const newModel = newConfig.PROVIDERS?.[providerName]?.model;
        if (newModel && newModel !== model) {
          payload.model = newModel;
          const retryResponse = await fetchWithTimeout(endpoint, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
            signal: options.signal,
          });
          if (retryResponse.ok) {
            const data = await retryResponse.json();
            const content = data.choices?.[0]?.message?.content || '';
            storeRawResponse(providerName, content, JSON.stringify(data), payload.model);
            return content;
          }
          const errText = sanitizeErrorText(await retryResponse.text().catch(() => 'Unknown error'));
          throw new Error(`HTTP_ERROR_${retryResponse.status}: ${errText}`);
        }
      }
    } catch (rollbackErr: any) {
      if (rollbackErr.message?.includes('HTTP_ERROR_')) throw rollbackErr;
      log(`${providerName} rollback failed: ${rollbackErr.message}`, 'WARN', 'base');
    }
  }

  if (!response.ok) {
    const errorText = sanitizeErrorText(await response.text().catch(() => 'Unknown error'));
    throw new Error(`HTTP_ERROR_${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || '';
  storeRawResponse(providerName, content, JSON.stringify(data), model);
  return content;
}

// ─── getFallbackModels ──────────────────────────────────────────────────

/**
 * Get fallback models for a provider. Delegates to providers-config-loader.
 */
function getFallbackModels(providerName: string): string[] {
  try {
    const configLoader = require('./providers-config-loader');
    return configLoader.getFallbackModels(providerName) || [];
  } catch {
    return [];
  }
}

// ─── _getOrLimiter ──────────────────────────────────────────────────────

/**
 * Get the OpenRouter rate limiter module.
 */
function _getOrLimiter() {
  try {
    return require('./openrouter-rate-limiter');
  } catch {
    return { checkBudget: () => {}, waitForBudget: async () => {} };
  }
}

// ─── extractJSON ─────────────────────────────────────────────────────────
// Extracts ALL JSON objects from a response, ignoring non-JSON text.
// Returns the FIRST valid action object (has actionType), or null.

/**
 * Try to parse a string as JSON. Returns the parsed object or null.
 */
function _tryParseJSON(str: string): any {
  try {
    const obj = JSON.parse(str);
    return obj && typeof obj === 'object' ? obj : null;
  } catch { return null; }
}

/**
 * Extract all JSON objects from a response string.
 * Scans for { ... } blocks (including nested) using brace depth tracking.
 * Also tries parsing the entire string as JSON first.
 *
 * @param rawContent - The raw text response from the AI model
 * @param providerName - Provider name for logging
 * @returns The first valid action object, or null if none found
 */
function extractJSON(rawContent: string, providerName?: string): any {
  if (!rawContent || typeof rawContent !== 'string') {
    _getLog().log(`extractJSON: empty or non-string input from ${providerName || 'unknown'}`, 'DEBUG', 'base');
    return null;
  }

  // 1. Try parsing the entire response as JSON first
  const fullParse = _tryParseJSON(rawContent);
  if (fullParse) {
    // If it has actionType, it's directly an action object
    if (fullParse.actionType) return fullParse;
    // If it has a nested action, unwrap it
    if (fullParse.action && fullParse.action.actionType) return fullParse.action;
  }

  // 2. Extract all top-level { ... } blocks by brace depth tracking
  const candidates: { start: number; end: number; json: string }[] = [];
  let depth = 0;
  let blockStart = -1;
  let inString = false;
  let stringChar = '';

  for (let i = 0; i < rawContent.length; i++) {
    const ch = rawContent[i];

    // Handle string literals (skip braces inside strings)
    if (inString) {
      if (ch === '\\') { i++; continue; } // Skip escaped char
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === '{') {
      if (depth === 0) blockStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && blockStart >= 0) {
        const jsonStr = rawContent.substring(blockStart, i + 1);
        candidates.push({ start: blockStart, end: i + 1, json: jsonStr });
        blockStart = -1;
      }
    }
  }

  // 3. Try each candidate (prefer first valid action object)
  for (const candidate of candidates) {
    const parsed = _tryParseJSON(candidate.json);
    if (!parsed) continue;

    // Direct action object
    if (parsed.actionType) return parsed;

    // Nested action in a wrapper (e.g., { "action": { "actionType": "click", ... } })
    if (parsed.action && typeof parsed.action === 'object' && parsed.action.actionType) {
      return parsed.action;
    }

    // Array of actions — return the first valid one
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && item.actionType) return item;
        if (item && item.action && item.action.actionType) return item.action;
      }
    }
  }

  // 4. Try markdown code block extraction (```json ... ```)
  const codeBlockRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = codeBlockRegex.exec(rawContent)) !== null) {
    const codeContent = match[1].trim();
    const parsed = _tryParseJSON(codeContent);
    if (!parsed) continue;

    if (parsed.actionType) return parsed;
    if (parsed.action && typeof parsed.action === 'object' && parsed.action.actionType) {
      return parsed.action;
    }
    if (Array.isArray(parsed)) {
      for (const item of parsed) {
        if (item && item.actionType) return item;
        if (item && item.action && item.action.actionType) return item.action;
      }
    }
  }

  // 5. Nothing found — log the full response for debugging
  const preview = rawContent.length > 500
    ? rawContent.substring(0, 500) + `... [truncated, total ${rawContent.length} chars]`
    : rawContent;
  _getLog().log(
    `extractJSON: no JSON object found in ${providerName || 'unknown'} response. Preview: "${preview.replace(/"/g, '\\"').substring(0, 300)}"`,
    'WARN',
    'base'
  );

  return null;
}

// ─── validateActionResponse ──────────────────────────────────────────────

/**
 * Validate that an extracted action has the required fields.
 * Returns the action if valid, throws if not.
 */
function validateActionResponse(action: any, providerName?: string): any {
  if (!action) {
    throw new Error(`${providerName || 'Provider'}: No action returned`);
  }
  if (!action.actionType) {
    throw new Error(`${providerName || 'Provider'}: Action missing actionType field`);
  }
  // Ensure numeric fields are numbers (some models return strings)
  if (action.targetX !== undefined) action.targetX = Number(action.targetX) || 0;
  if (action.targetY !== undefined) action.targetY = Number(action.targetY) || 0;
  return action;
}

// ─── getProviderConfig ───────────────────────────────────────────────────

/**
 * Get provider config (endpoint, model, etc.).
 * Delegates to providers-config-loader which checks DB first,
 * then falls back to DEFAULTS (which have endpoints).
 * The old get-config frozen config doesn't have provider endpoints,
 * which caused `undefined.includes()` crashes in callChatCompletionWithRollback.
 */
function getProviderConfig(providerName: string): Record<string, any> {
  try {
    const configLoader = require('./providers-config-loader');
    return configLoader.getProviderConfig(providerName) || {};
  } catch {
    // Fallback to frozen config if config-loader unavailable
    try {
      const config = require('./get-config');
      const providers = config.PROVIDERS || {};
      return providers[providerName] || {};
    } catch {
      return {};
    }
  }
}

// ─── classifyError ───────────────────────────────────────────────────────

// ─── Per-provider 429 cooldown tracker ───
// FIX: Stop hammering providers that are already rate-limited.
// When a provider hits 429, we record the cooldown end time and refuse
// to retry until the cooldown expires. This prevents the retry storm
// seen in logs where Gemini/OpenRouter/z.ai all burn through retries
// simultaneously while already rate-limited.
const _providerCooldowns = new Map<string, number>(); // provider -> cooldownEndMs

function setProviderCooldown(providerName: string, cooldownMs: number): void {
  _providerCooldowns.set(providerName, Date.now() + cooldownMs);
}

function getProviderCooldownRemainingMs(providerName: string): number {
  const end = _providerCooldowns.get(providerName);
  if (!end) return 0;
  const remaining = end - Date.now();
  if (remaining <= 0) { _providerCooldowns.delete(providerName); return 0; }
  return remaining;
}

function classifyError(err: any): { category: string; retryable: boolean; retryAfterMs: number } {
  const msg = err?.message || err?.toString?.() || '';
  const status = err?.status || err?.statusCode || 0;

  // Rate limited
  if (status === 429 || msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('rate_limited')) {
    // Extract retry-after from message or default to 10s
    const match = msg.match(/retry after (\d+)ms/);
    const retryAfterMs = match ? parseInt(match[1], 10) : 10000; // 10s default (not 120s)
    return { category: 'rate_limited', retryable: true, retryAfterMs };
  }

  // Auth errors
  if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('invalid api')) {
    return { category: 'auth', retryable: false, retryAfterMs: 0 };
  }

  // Model errors
  if (status === 404 || msg.includes('model_not_found') || msg.includes('does not exist') || msg.includes('no longer available') || msg.includes('HTTP_ERROR_404')) {
    return { category: 'model_not_found', retryable: false, retryAfterMs: 0 };
  }

  // Server errors
  if (status >= 500 || msg.includes('timeout') || msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT')) {
    return { category: 'server_error', retryable: true, retryAfterMs: 5000 };
  }

  // Empty response
  if (msg.includes('empty_response') || msg.includes('EMPTY_RESPONSE') || msg.includes('No content')) {
    return { category: 'empty_response', retryable: true, retryAfterMs: 2000 };
  }

  // Default
  return { category: 'unknown', retryable: true, retryAfterMs: 3000 };
}

// ─── retryWithBackoff ─────────────────────────────────────────────────────

/**
 * Retry a function with exponential backoff.
 * Respects circuit breaker via providerName.
 */
/**
 * Retry a function with exponential backoff + jitter.
 * FIX: Added per-provider 429 cooldown awareness and jitter to prevent
 * thundering-herd effect where all providers retry simultaneously.
 */
async function retryWithBackoff(
  fn: () => Promise<any>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    providerName?: string;
    signal?: AbortSignal;
  } = {}
): Promise<any> {
  const { signal } = options;
  const { maxRetries = 0, baseDelayMs = 1000, providerName } = options;
  const log = _getLog().log;

  // FIX: Check if provider is already in cooldown from a previous 429
  if (providerName) {
    const cooldownRemaining = getProviderCooldownRemainingMs(providerName);
    if (cooldownRemaining > 0) {
      log(
        `Provider ${providerName} in 429 cooldown (${Math.round(cooldownRemaining / 1000)}s remaining) — skipping retries`,
        'WARN',
        'base'
      );
      throw new Error(`PROVIDER_COOLDOWN: ${providerName} rate-limited, retry after ${Math.round(cooldownRemaining / 1000)}s`);
    }
  }

  let lastError: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const classified = classifyError(err);

      // FIX: On 429, register provider-level cooldown so future calls
      // (even from different code paths) won't hammer the same provider
      if (classified.category === 'rate_limited' && providerName) {
        setProviderCooldown(providerName, classified.retryAfterMs);
      }

      // FIX: Check if the caller (e.g. tribunal) has already aborted.
      // Don't waste time retrying when the parent request is dead.
      if (signal?.aborted) {
        throw new DOMException('Aborted due to parent signal', 'AbortError');
      }

      if (!classified.retryable || attempt >= maxRetries) {
        log(
          `Retry exhausted for ${providerName || 'unknown'}: ${classified.category}: ${attempt >= maxRetries ? `max ${maxRetries} retries exceeded` : `not retryable`} (attempt ${attempt + 1}/${maxRetries})`,
          'WARN',
          'base'
        );
        throw err;
      }

      // FIX: Add jitter (±25%) to prevent synchronized retry storms
      const baseDelay = classified.retryAfterMs || baseDelayMs * Math.pow(2, attempt);
      const jitter = baseDelay * 0.25 * (Math.random() * 2 - 1);
      const delay = Math.min(Math.round(baseDelay + jitter), 120000); // cap at 2min
      log(
        `Retry ${attempt + 1}/${maxRetries} for ${providerName || 'unknown'} after ${delay}ms: ${classified.category}`,
        'WARN',
        'base'
      );
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

// ─── safeCall ───────────────────────────────────────────────────────────

/**
 * Wrap a function call with a timeout. Used for tribunal, provider calls etc.
 * Gracefully handles timeouts without crashing the cycle.
 */
async function safeCall(
  fn: (signal: any) => Promise<any>,
  label: string,
  options: { timeoutMs?: number; url?: string; signal?: any; maxRetries?: number; baseDelay?: number } = {}
): Promise<any> {
  const { timeoutMs = 120000, url, signal: externalSignal } = options;
  const log = _getLog().log;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const abortController = new AbortController();
  const { signal } = abortController;

  // FIX: Link external signal (e.g. tribunal abort) to our controller
  if (externalSignal) {
    if (externalSignal.aborted) {
      abortController.abort();
    } else {
      externalSignal.addEventListener('abort', () => abortController.abort(), { once: true });
    }
  }

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      abortController.abort();
      reject(new Error(`${label} timed out after ${timeoutMs}ms${url ? ` (${url})` : ''}`));
    }, timeoutMs);
  });

  // Start fn(signal) so we can attach a catch handler if timeout wins the race.
  // Without this, when the timeout fires first, fn()'s promise keeps running
  // in the background — if it later rejects (e.g. Array.from corruption),
  // that rejection is unhandled and crashes the process.
  const fnPromise = fn(signal);

  try {
    const result = await Promise.race([
      fnPromise,
      timeoutPromise,
    ]);
    return result;
  } catch (err: any) {
    log(`${label} failed: ${err.message || err}`, 'WARN', 'base');
    // If we timed out, fnPromise is still in flight. Attach a silent catch
    // to prevent UNHANDLED_REJECTION if it later rejects.
    fnPromise.catch(() => {});
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

// ─── coalescer ──────────────────────────────────────────────────────────

/**
 * Call coalescer — deduplicates concurrent async calls with the same key.
 * If a call with the same key is already in-flight, returns the same promise
 * instead of firing a duplicate request. Results are cached for ttlMs after
 * the call resolves so that near-duplicate keys also hit the cache.
 *
 * Usage:  const result = await coalescer.execute('my-key', () => doExpensiveWork(), 5000);
 */
const coalescer = {
  _inflight: new Map<string, Promise<any>>(),
  _cached: new Map<string, { result: any; expiry: number }>(),

  /**
   * Execute fn(key) with coalescing.
   * @param key   - Deduplication key (e.g. screenshot hash)
   * @param fn    - The async function to call
   * @param ttlMs - Cache TTL in ms after the call resolves (default 5000)
   */
  async execute(key: string, fn: () => Promise<any>, ttlMs: number = 5000): Promise<any> {
    const now = Date.now();

    // 1. Check cache
    const cached = this._cached.get(key);
    if (cached && cached.expiry > now) {
      return cached.result;
    }
    if (cached) this._cached.delete(key); // expired

    // 2. Check in-flight
    const inflight = this._inflight.get(key);
    if (inflight) return inflight;

    // 3. Execute
    const promise = fn().then((result: any) => {
      this._inflight.delete(key);
      this._cached.set(key, { result, expiry: Date.now() + ttlMs });
      return result;
    }).catch((err: any) => {
      this._inflight.delete(key);
      throw err;
    });

    this._inflight.set(key, promise);
    return promise;
  },

  /** Clear all cached and in-flight state */
  clear(): void {
    this._inflight.clear();
    this._cached.clear();
  },
};

module.exports = {
  extractJSON,
  validateActionResponse,
  getProviderConfig,
  retryWithBackoff,
  classifyError,
  safeCall,
  coalescer,
  callChatCompletionWithRollback,
  fetchWithTimeout,
  sanitizeErrorText,
  getFallbackModels,
  _getOrLimiter,
  _injectDependencies,
  // FIX: Export cooldown functions so providers can check before calling
  setProviderCooldown,
  getProviderCooldownRemainingMs,
  // Raw response buffer for dashboard
  storeRawResponse,
  getRawResponses,
};
