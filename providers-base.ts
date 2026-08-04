'use strict';

import type { Deps } from './types/di-types';

// ─── Dependency Injection ───────────────────────────────────────────────────
let _deps: Deps = {};
function _injectDependencies(deps: Deps) { _deps = deps; }

// ─── Lazy Requires (avoid top-level circular dependency chains) ─────────────
// providers-base → logger → config (cycle risk)
// providers-base → utils-fetch → logger (cycle risk)
// providers-base → providers-health (new, loaded on first use)
// providers-base → providers-serializers (new, loaded on first use)
let _utilsFetch: any = null;
function _getUtilsFetch() { if (!_utilsFetch) _utilsFetch = require('./utils-fetch'); return _utilsFetch; }
let _loggerMod: any = null;
function _getLogger() { if (!_loggerMod) _loggerMod = require('./logger'); return _loggerMod; }
function log(...args: any[]) { return _getLogger().log(...args); }
function safeLog(...args: any[]) { return _getLogger().safeLog(...args); }
function logError(...args: any[]) { return _getLogger().logError(...args); }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

// Lazy health module — loaded on first use to avoid circular deps
let _healthMod: any = null;
function _getHealth() { if (!_healthMod) _healthMod = require('./providers-health'); return _healthMod; }

// Lazy serializers module — loaded on first use
let _serializersMod: any = null;
function _getSerializers() { if (!_serializersMod) _serializersMod = require('./providers-serializers'); return _serializersMod; }

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════════

function sanitizeErrorText(text: any, maxLength = 100) {
  if (!text) return 'Unknown error';
  // v5-fix L1: Only redact strings that look like actual API keys/secrets:
  // hex strings (32+ chars) and base64-ish strings (40+ chars, containing +/=/).
  const sanitized = text
    .replace(/(?:^|[\s:="'])[a-fA-F0-9]{32,}(?:[\s"'])/g, (match) => {
      return match.slice(0, -1) + '[REDACTED]';
    })
    .replace(/[A-Za-z0-9+/=]{40,}/g, '[REDACTED_BASE64]');
  return sanitized.slice(0, maxLength);
}

function extractJSON(raw: any, context: any) { 
  if (!raw || typeof raw !== 'string') throw new Error(`${context}: Empty or invalid input`);
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  else if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']');
  function extractFirstJSON(str: any) {
    let depth = 0, start = -1, inString = false, escaped = false;
    for (let i = 0; i < str.length; i++) {
      const ch = str[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') { if (depth === 0) start = i; depth++; }
      else if (ch === '}') { depth--; if (depth === 0 && start !== -1) return str.substring(start, i + 1); }
    }
    return str;
  }
  const jsonStr = extractFirstJSON(cleaned);
  try { return JSON.parse(jsonStr); } catch (e: any) { logError(`JSON parse error in ${context}`, e); throw new Error(`${context}: JSON parse failed`); }
}

function validateActionResponse(obj: any, modelName: any) { 
  if (!obj || typeof obj !== 'object') throw new Error(`${modelName}: Response is not an object`);
  const required = ['actionType'];
  const missing = required.filter(k => !obj[k]);
  if (missing.length > 0) throw new Error(`${modelName}: Missing required fields: ${missing.join(', ')}`);
  const { isValidAction, isValidState, ACTIONS_REQUIRING_COORDS } = require('./state-machine');
  if (obj.currentState && !isValidState(obj.currentState)) log(`${modelName}: Unknown state "${obj.currentState}"`, 'WARN', 'base');
  if (!isValidAction(obj.actionType)) throw new Error(`${modelName}: Invalid actionType "${obj.actionType}"`);
  if (ACTIONS_REQUIRING_COORDS.has(obj.actionType)) {
    if (typeof obj.targetX !== 'number' || typeof obj.targetY !== 'number') throw new Error(`${modelName}: Missing targetX/targetY for "${obj.actionType}" action`);
  }
  if (obj.actionType === 'keypad_input') {
    if (!Array.isArray(obj.keypadSequence) || obj.keypadSequence.length === 0) throw new Error(`${modelName}: keypadSequence required for keypad_input action`);
    for (const key of obj.keypadSequence) { if (typeof key.x !== 'number' || typeof key.y !== 'number') throw new Error(`${modelName}: Invalid keypad entry - missing x/y coordinates`); }
  }
  return obj;
}

const { rollbackProvider, getProviderConfig } = require('./providers-config-loader');

// ═══════════════════════════════════════════════════════════════════════════════
// CORE CHAT COMPLETION — P1: Provider-Specific Serialization
// ═══════════════════════════════════════════════════════════════════════════════
//
// BREAKING CHANGE from original: providerName is now a REQUIRED 6th parameter.
// Previous signature: (endpoint, apiKey, model, base64Image, prompt, options)
// New signature:      (endpoint, apiKey, model, base64Image, prompt, providerName, options)
//
// This fixes two bugs:
//   1. callChatCompletionWithRollback received providerName but never passed it through
//   2. OpenRouter passed 7 args but the 6th ('OpenRouter') was silently eaten as 'options'
//
// The providerName drives serializer selection: OpenAI-compatible providers get
// plain-string content when no image (fixes "content must be a string" errors),
// and array content only when the provider supports vision AND multipart.

async function callChatCompletion(endpoint: string, apiKey: string, model: string, base64Image: string | null, prompt: string, providerName: string, options: any = {}) { 
  const config = getCONFIG();
  const maxTokens = options.maxTokens || config.MAX_TOKENS || 4096;
  const temperature = options.temperature !== undefined ? options.temperature : (config.TEMPERATURE !== undefined ? config.TEMPERATURE : 0.1);
  const signal = options.signal;
  const responseFormat = options.responseFormat || null;

  // ─── Serializer-based payload construction (P1) ───
  // Each provider gets the correct content format:
  //   - OpenAI-compatible: string when no image, array when image + provider supports multipart
  //   - Cloudflare: always plain string
  //   - Gemini: not handled here (uses SDK)
  const serializers = _getSerializers();
  const caps = serializers.getProviderCapabilities(providerName);

  // If provider has a custom serializer type (e.g. 'cloudflare'), use the router.
  // For 'openai' type or unknown, we build the payload inline for maximum control.
  let payload: any;
  if (caps && caps.serializerType === 'cloudflare') {
    // Cloudflare has a completely different URL structure — this function
    // should not be called for Cloudflare. If it is, fall back to openai format.
    payload = _buildOpenAIPayload(providerName, model, prompt, base64Image, caps, maxTokens, temperature, responseFormat);
  } else if (caps && caps.serializerType === 'gemini') {
    // Gemini uses the Google SDK — this function should not be called.
    // Build an OpenAI-format payload as fallback (may not work but won't crash).
    payload = _buildOpenAIPayload(providerName, model, prompt, base64Image, caps, maxTokens, temperature, responseFormat);
  } else {
    // OpenAI-compatible: use provider-aware serialization
    payload = _buildOpenAIPayload(providerName, model, prompt, base64Image, caps, maxTokens, temperature, responseFormat);
  }

  const response = await _getUtilsFetch().fetchWithTimeout(endpoint, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal,
  });

  // ─── 429 handling with retry-after extraction ───
  if (response.status === 429) {
    const retryAfter = response.headers.get('retry-after');
    let retryMs = 45000; // P7: reduced from 60s to 45s default
    if (retryAfter) {
      const asNum = parseInt(retryAfter, 10);
      if (!isNaN(asNum)) { retryMs = asNum * 1000; }
      else {
        const asDate = new Date(retryAfter);
        if (!isNaN(asDate.getTime())) { retryMs = Math.max(0, asDate.getTime() - Date.now()); }
      }
    }
    const err: any = new Error('RATE_LIMIT');
    err.retryAfterMs = retryMs;
    err.rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
    throw err;
  }

  // ─── Non-429 error handling ───
  if (!response.ok) {
    const errorText = sanitizeErrorText(await response.text().catch(() => 'Unknown error'));
    throw new Error(`HTTP_ERROR_${response.status}: ${errorText}`);
  }

  // ─── Response size guard (OOM prevention) ───
  const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
  const responseText = await response.text();
  if (responseText.length > MAX_RESPONSE_BYTES) {
    throw new Error(`RESPONSE_TOO_LARGE: ${responseText.length} bytes exceeds ${MAX_RESPONSE_BYTES} limit`);
  }

  const data = JSON.parse(responseText);
  const rawContent = data.choices?.[0]?.message?.content;
  if (!rawContent) throw new Error('EMPTY_RESPONSE');
  return rawContent;
}

/**
 * Build an OpenAI-compatible payload with provider-aware content formatting.
 *
 * Key fix (P1): content is a PLAIN STRING when there is no image, or when
 * the provider does not support multipart content. This prevents
 * "messages[0].content must be a string" errors from Groq, z.ai, Agnes,
 * OpenRouter, etc.
 *
 * Content is an ARRAY only when: image is present AND provider supports
 * vision AND provider supports multipart content.
 */
function _buildOpenAIPayload(
  providerName: string,
  model: string,
  prompt: string,
  base64Image: string | null,
  caps: any,
  maxTokens: number,
  temperature: number,
  responseFormat: any
): any {
  const supportsVision = caps ? caps.supportsVision : false;
  const supportsMultipart = caps ? caps.supportsMultipartContent : false;
  const supportsResponseFmt = caps ? caps.supportsResponseFormat : false;
  const useVision = !!(base64Image && supportsVision);
  const useMultipart = useVision && supportsMultipart;

  let userContent: string | Array<{type: string; text?: string; image_url?: {url: string}}>;
  if (useMultipart) {
    // Array format: text part + image part
    userContent = [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
    ];
  } else {
    // Plain string format (always safe for OpenAI-compatible APIs)
    // If we have an image but provider doesn't support multipart,
    // the image is silently dropped — the prompt text still guides the model.
    userContent = prompt;
  }

  const payload: any = {
    model,
    max_tokens: maxTokens,
    temperature,
    messages: [{ role: 'user', content: userContent }],
  };

  // Only add response_format if provider supports it AND it was requested
  // (P1 fix: some providers like Groq don't support this and return 400)
  if (responseFormat && supportsResponseFmt) {
    payload.response_format = responseFormat;
  }

  return payload;
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROLLBACK WRAPPER — Updated to pass providerName through
// ═══════════════════════════════════════════════════════════════════════════════
//
// On 404/401/403, attempts to roll back to the previous model config.
// Now uses classifyError from providers-health for consistent error handling.

async function callChatCompletionWithRollback(endpoint: string, apiKey: string, model: string, base64Image: string | null, prompt: string, providerName: string, options: any = {}) { 
  try {
    return await _callChatCompletionInternal(endpoint, apiKey, model, base64Image, prompt, providerName, options);
  } catch (err: any) {
    const health = _getHealth();
    const classified = health.classifyError(err);
    // Only attempt rollback for config-related errors
    if (classified.category === 'model_removed' || classified.category === 'auth_failure') {
      log(`\u26a0\ufe0f ${providerName} returned ${classified.category} (${err.message}) -- attempting rollback...`, 'WARN', 'base');
      const rolledBack = rollbackProvider(providerName);
      if (rolledBack) {
        log(`\u21a9\ufe0f Rolled back ${providerName} to previous config.`, 'INFO', 'base');
        const newConfig = getProviderConfig(providerName);
        return await _callChatCompletionInternal(newConfig.endpoint, apiKey, newConfig.model, base64Image, prompt, providerName, options);
      }
      // If rollback not possible and model was removed, retire the provider
      if (classified.category === 'model_removed') {
        const registry = require('./providers-registry');
        if (registry.retireProvider) {
          registry.retireProvider(providerName, `Model ${model} not found (404)`);
        }
      }
    }
    throw err;
  }
}

/**
 * Internal call that wraps callChatCompletion with protocol chameleon support.
 * Separated from the rollback wrapper so the chameleon only runs once per attempt.
 */
async function _callChatCompletionInternal(endpoint: string, apiKey: string, model: string, base64Image: string | null, prompt: string, providerName: string, options: any = {}) {
  try {
    return await callChatCompletion(endpoint, apiKey, model, base64Image, prompt, providerName, options);
  } catch (err: any) {
    // Protocol chameleon: attempt 422 recovery
    const protocolChameleon = getProtocolChameleon();
    if (err.message && err.message.includes('HTTP_ERROR_422') && protocolChameleon) {
      log(`422 error, attempting protocol adaptation for ${providerName}`, 'WARN', 'base');
      try {
        const pUrls = getCONFIG().PROTOCOL_CHAMELEON_SCHEMA_URLS;
        const schemaProvider = pUrls ? Object.keys(pUrls).find((p: string) => endpoint.includes(p)) || 'unknown' : 'unknown';
        const adapted = await protocolChameleon.adapt(endpoint, apiKey, model, { base64Image, prompt, options }, schemaProvider);
        if (adapted) { log('Protocol adaptation succeeded.', 'INFO', 'base'); return adapted; }
      } catch (adaptErr: any) { logError('Protocol adaptation failed', adaptErr); }
    }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SMART RETRY — P7: Error-Type-Aware Retry with Backoff
// ═══════════════════════════════════════════════════════════════════════════════
//
// Replaces the old retryWithBackoff() which retried ALL errors equally.
// Now uses classifyError + getRetryDecision from providers-health to:
//   - Never retry 400/404/422 (permanent errors)
//   - One retry for 401 (credential refresh window)
//   - Honors retry-after for 429
//   - Exponential backoff for 5xx
//   - One retry only for unknown errors

async function retryWithBackoff(fn: () => Promise<unknown>, opts: any = {}) {
  const config = getCONFIG();
  const fallbackMax = Math.max(1, Math.min(Math.floor(config.RETRY_ATTEMPTS) || 3, 10));
  const fallbackDelay = config.RETRY_BASE_DELAY_MS || 1000;
  // Allow caller to specify providerName for health-aware retries
  const providerName = opts.providerName || 'unknown';
  const maxRetries = opts.maxRetries || fallbackMax;
  const baseDelay = opts.baseDelay || fallbackDelay;
  const maxDelay = opts.maxDelay || 30000;
  const health = _getHealth();

  let attempt = 0;
  while (true) {
    try {
      const result = await fn();
      // Record success for health tracking if providerName is known
      if (providerName !== 'unknown') {
        // Don't record here — the caller (safeCall or provider) records with latency
      }
      return result;
    } catch (err: any) {
      attempt++;
      const classified = health.classifyError(err);
      const decision = health.getRetryDecision(classified, attempt - 1); // 0-indexed attempt

      if (!decision.shouldRetry || attempt >= Math.min(maxRetries, decision.maxRetries) + 1) {
        // Structured log (P20)
        log(`Retry exhausted for ${providerName}: ${decision.reason} (attempt ${attempt}/${decision.maxRetries})`, 'WARN', 'base');
        throw err;
      }

      const delay = Math.min(decision.delayMs + Math.random() * 300, maxDelay);
      log(`Retry ${attempt}/${decision.maxRetries} for ${providerName} after ${Math.round(delay)}ms: ${decision.reason}`, 'WARN', 'base');
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SAFE CALL — P22: Circuit Breaker Integration + P5: Health Recording
// ═══════════════════════════════════════════════════════════════════════════════
//
// The main entry point for the tribunal. Wraps provider calls with:
//   1. Circuit breaker check (skip provider if open)
//   2. Timeout with AbortController
//   3. Smart retry with error-type awareness
//   4. Health recording (success/failure → ProviderHealth + CircuitBreaker)
//   5. Structured logging (P20)

async function safeCall(fn: (signal: AbortSignal) => Promise<unknown>, context: string, opts: any = {}) {
  const config = getCONFIG();
  const timeoutMs = opts.timeoutMs || config.REQUEST_TIMEOUT_MS || 30000;
  const maxRetries = opts.maxRetries || config.RETRY_ATTEMPTS || 3;
  const baseDelay = opts.baseDelay || config.RETRY_BASE_DELAY_MS || 1000;
  const providerName = opts.url || 'unknown';
  const externalSignal = opts.signal || null;
  const health = _getHealth();

  // ─── P22: Circuit breaker pre-check ───
  if (!health.isProviderAvailable(providerName)) {
    const snapshot = health.getHealthSnapshot(providerName);
    const reason = snapshot.disabled ? 'disabled' :
      snapshot.circuitState === 'open' ? `circuit open (${Math.round(snapshot.cooldownRemainingMs || 0)}ms remaining)` :
      'on cooldown';
    throw new Error(`Provider ${providerName} unavailable: ${reason}`);
  }

  const cb = health.getCircuitBreaker(providerName);
  let attempt = 0;
  const safeMaxRetries = Math.max(1, Math.min(Math.floor(maxRetries) || 3, 10));
  const startTime = Date.now();

  while (attempt < safeMaxRetries) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let externalHandler: (() => void) | null = null;

    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timeoutId);
        // Record as timeout since we never sent the request
        health.recordCallResult(providerName, false, Date.now() - startTime, new Error('Aborted'));
        throw new Error('Aborted');
      }
      externalHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalHandler, { once: true });
    }

    try {
      const result = await fn(controller.signal);
      const latency = Date.now() - startTime;
      clearTimeout(timeoutId);
      if (externalSignal && externalHandler) externalSignal.removeEventListener('abort', externalHandler);

      // ─── P5: Record success ───
      health.recordCallResult(providerName, true, latency);
      cb.recordSuccess();

      // ─── P20: Structured success log ───
      const healthScore = health.getProviderHealth(providerName).healthScore();
      log(health.formatProviderLog(providerName, '', latency, true, null, attempt - 1, healthScore), 'INFO', 'base');

      return result;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (externalSignal && externalHandler) externalSignal.removeEventListener('abort', externalHandler);

      const latency = Date.now() - startTime;
      if (externalSignal?.aborted) {
        health.recordCallResult(providerName, false, latency, err);
        throw err;
      }

      // ─── P6 + P7: Classify and decide retry ───
      const classified = health.classifyError(err);
      health.recordCallResult(providerName, false, latency, err);
      cb.recordFailure(classified.category);

      // ─── P20: Structured failure log ───
      const healthScore = health.getProviderHealth(providerName).healthScore();
      log(health.formatProviderLog(providerName, '', latency, false, classified.category, attempt - 1, healthScore), 'WARN', 'base');

      // ─── Check if provider should be retired ───
      if (classified.retireProvider) {
        log(`\ud83d\uded1 Retiring ${providerName}: ${classified.description}`, 'ERROR', 'base');
        try {
          const registry = require('./providers-registry');
          if (registry.retireProvider) registry.retireProvider(providerName, classified.description);
        } catch {}
        throw err;
      }

      // ─── Check if provider should be disabled ───
      if (classified.disableProvider) {
        log(`\u26d4 Disabling ${providerName}: ${classified.description}`, 'ERROR', 'base');
        // Health module already disables via recordCallResult
        throw err;
      }

      // ─── P7: Smart retry decision ───
      const decision = health.getRetryDecision(classified, attempt - 1);
      if (!decision.shouldRetry || attempt >= safeMaxRetries) {
        throw err;
      }

      const delay = Math.min(decision.delayMs + Math.random() * 300, 30000);
      log(`\ud83d\udd04 Retry ${attempt}/${safeMaxRetries} for ${context} after ${Math.round(delay)}ms: ${decision.reason}`, 'WARN', 'base');
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// ERROR CLASSIFICATION — P6: Delegates to providers-health
// ═══════════════════════════════════════════════════════════════════════════════
//
// Kept for backward compatibility. Returns the same shape as before
// { code, retryable, healable } but now backed by the 11-category classifier.
// New code should use providers-health.classifyError() directly for the full
// ClassifiedError with category, disableProvider, retireProvider, retryAfterMs.

function classifyError(err: unknown) {
  const health = _getHealth();
  const classified = health.classifyError(err);
  // Map new categories to old codes for backward compat
  switch (classified.category) {
    case 'malformed':
    case 'bad_format':
    case 'model_removed':
      return { code: 'fatal', retryable: false, healable: false };
    case 'auth_failure':
      return { code: 'fatal', retryable: false, healable: true };
    case 'rate_limited':
    case 'server_error':
    case 'timeout':
    case 'connection':
    case 'empty_response':
      return { code: 'transient', retryable: true, healable: false };
    case 'too_large':
      return { code: 'fatal', retryable: false, healable: false };
    default:
      return { code: 'unknown', retryable: classified.retryable, healable: true };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// CIRCUIT BREAKER — P22: Delegates to providers-health
// ═══════════════════════════════════════════════════════════════════════════════
//
// Kept for backward compatibility. Returns a plain object with the same shape
// as the old inline circuit breaker (failures, lastFailure, state) but backed
// by the full CircuitBreaker class from providers-health.
//
// NOTE: The old Map-based circuit breakers have been removed. All state is now
// in providers-health.ts. This function provides a compatibility shim.

const _compatCircuitBreakers = new Map<string, any>();

function getCircuitBreaker(urlOrName: string) {
  if (!_compatCircuitBreakers.has(urlOrName)) {
    // Create a compatibility shim backed by the real CircuitBreaker
    const health = _getHealth();
    const realCb = health.getCircuitBreaker(urlOrName);
    const shim: any = {
      get state() { return realCb.getState(); },
      set state(v: string) { /* no-op: state is managed by real CB */ },
      get failures() { return health.getProviderHealth(urlOrName).getConsecutiveFailures(); },
      set failures(v: number) { /* no-op: managed by real CB */ },
      get lastFailure() { return 0; },
      set lastFailure(v: number) { /* no-op */ },
    };
    _compatCircuitBreakers.set(urlOrName, shim);
  }
  return _compatCircuitBreakers.get(urlOrName);
}

// ═══════════════════════════════════════════════════════════════════════════════
// REQUEST COALESCER (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════════

class RequestCoalescer {
  pending: any;
  constructor() { this.pending = new Map(); }
  async execute(key: any, factory: any, ttlMs = 5000) { 
    if (this.pending.has(key)) return this.pending.get(key);
    const promise = factory().finally(() => { setTimeout(() => this.pending.delete(key), ttlMs); });
    this.pending.set(key, promise);
    return promise;
  }
}

const coalescer = new RequestCoalescer();

// ═══════════════════════════════════════════════════════════════════════════════
// PROTOCOL CHAMELEON — Lazy loader (preserved from original)
// ═══════════════════════════════════════════════════════════════════════════════

let _protocolChameleon: any = null;
let _protocolChameleonChecked = false;
function getProtocolChameleon() {
  if (!_protocolChameleonChecked) {
    _protocolChameleonChecked = true;
    if (getCONFIG().ENABLE_PROTOCOL_CHAMELEON) {
      try { _protocolChameleon = require('./protocol-chameleon'); log('Protocol Chameleon loaded.', 'INFO', 'base'); } catch (e: any) { logError('Protocol Chameleon load failed', e); }
    }
  }
  return _protocolChameleon;
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Fetch utility (lazy getter)
  get fetchWithTimeout() { return _getUtilsFetch().fetchWithTimeout; },
  // Utilities (unchanged)
  sanitizeErrorText,
  extractJSON,
  validateActionResponse,
  // Core completion (P1: now requires providerName as 6th arg)
  callChatCompletion,
  callChatCompletionWithRollback,
  // Config access (unchanged)
  getProviderConfig,
  // Retry (P7: now uses smart retry from providers-health)
  retryWithBackoff,
  // Safe call (P22: now uses circuit breakers + health recording from providers-health)
  safeCall,
  // Error classification (P6: delegates to providers-health, backward-compat shape)
  classifyError,
  // Circuit breaker (P22: delegates to providers-health, backward-compat shim)
  getCircuitBreaker,
  // Coalescer (unchanged)
  coalescer,
  // DI
  _injectDependencies,
};
