'use strict';

import type { Deps } from './types/di-types';

// ─── Dependency Injection ───
let _deps: Deps = {};
function _injectDependencies(deps: Deps) { _deps = deps; }

// Lazy requires to avoid top-level circular dependency chain:
// providers-base → logger → config (cycle risk)
// providers-base → utils-fetch → logger (cycle risk)
let _utilsFetch: any = null;
function _getUtilsFetch() { if (!_utilsFetch) _utilsFetch = require('./utils-fetch'); return _utilsFetch; }
let _loggerMod: any = null;
function _getLogger() { if (!_loggerMod) _loggerMod = require('./logger'); return _loggerMod; }
function log(...args: any[]) { return _getLogger().log(...args); }
function safeLog(...args: any[]) { return _getLogger().safeLog(...args); }
function logError(...args: any[]) { return _getLogger().logError(...args); }
// Lazy CONFIG accessor — DI when available, direct require as fallback.
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

function sanitizeErrorText(text: any, maxLength = 100) {
  if (!text) return 'Unknown error';
  // v5-fix L1: Previous regex /[a-zA-Z0-9_\\-]{20,}/g was far too aggressive —
  // it redacted ANY alphanumeric string >= 20 chars (filenames, URLs, stack
  // frames, model names like "gpt-4o-mini-chat"). Now only redact strings that
  // look like actual API keys/secrets: hex strings (32+ chars) and base64-ish
  // strings (40+ chars, containing +/=/).
  const sanitized = text
    .replace(/(?:^|[\s:="'])[a-fA-F0-9]{32,}(?:[\s"'])/g, (match) => {
      // Redact hex-only strings 32+ chars (likely API keys / hashes)
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

async function callChatCompletionWithRollback(endpoint: any, apiKey: any, model: any, base64Image: any, prompt: any, providerName: any, options: any = {}) { 
  try { return await module.exports.callChatCompletion(endpoint, apiKey, model, base64Image, prompt, options); } catch (err: any) {
    if (err.message && (err.message.includes('HTTP_ERROR_404') || err.message.includes('HTTP_ERROR_401') || err.message.includes('HTTP_ERROR_403'))) {
      log(`⚠️ ${providerName} returned config error (${err.message}) -- attempting rollback...`, 'WARN', 'base');
      const rolledBack = rollbackProvider(providerName);
      if (rolledBack) {
        log(`↩️ Rolled back ${providerName} to previous config.`, 'INFO', 'base');
        const newConfig = getProviderConfig(providerName);
        return await module.exports.callChatCompletion(newConfig.endpoint, apiKey, newConfig.model, base64Image, prompt, options);
      }
    }
    throw err;
  }
}

async function callChatCompletion(endpoint: any, apiKey: any, model: any, base64Image = null, prompt: any, options: any = {}) { 
  const { maxTokens = getCONFIG().MAX_TOKENS, temperature = getCONFIG().TEMPERATURE, responseFormat = null, signal } = options;
  const content = [{ type: 'text', text: prompt }];
  if (base64Image) { content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } } as any); }
  const payload = { model, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content }] };
// @ts-expect-error
  if (responseFormat) payload.response_format = responseFormat;
  const response = await _getUtilsFetch().fetchWithTimeout(endpoint, { method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
  if (response.status === 429) {
    // Extract retry-after header if available
    const retryAfter = response.headers.get('retry-after');
    let retryMs = 60000;
    if (retryAfter) {
      const asNum = parseInt(retryAfter, 10);
      if (!isNaN(asNum)) { retryMs = asNum * 1000; }
      else {
        const asDate = new Date(retryAfter);
        if (!isNaN(asDate.getTime())) { retryMs = Math.max(0, asDate.getTime() - Date.now()); }
      }
    }
    const err = new Error('RATE_LIMIT');
// @ts-expect-error
    err.retryAfterMs = retryMs;
// @ts-expect-error
    err.rateLimitRemaining = response.headers.get('x-ratelimit-remaining');
    throw err;
  }
  if (!response.ok) {
    const errorText = sanitizeErrorText(await response.text().catch(() => 'Unknown error'));
    throw new Error(`HTTP_ERROR_${response.status}: ${errorText}`);
  }
  // v6-fix: Limit response body to prevent OOM from malicious/broken providers.
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


async function retryWithBackoff(fn: () => Promise<unknown>, { maxRetries = getCONFIG().RETRY_ATTEMPTS, baseDelay = getCONFIG().RETRY_BASE_DELAY_MS, maxDelay = 30000} = {}) {
  const safeMaxRetries = Math.max(1, Math.min(Math.floor(maxRetries) || 3, 10));
  let attempt = 0;
  while (true) {
    try { return await fn(); } catch (err: any) {
      attempt++;
      if (attempt >= safeMaxRetries) throw err;
      let delay;
      if (err.retryAfterMs && typeof err.retryAfterMs === 'number' && err.retryAfterMs > 0) {
        delay = Math.min(err.retryAfterMs + Math.random() * 1000, maxDelay);
      } else {
        delay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxDelay);
      }
      log(`Retry ${attempt}/${maxRetries} after ${Math.round(delay)}ms due to: ${err.message}`, 'WARN', 'base');
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

const circuitBreakers = new Map();

function getCircuitBreaker(url: any) { 
  if (!circuitBreakers.has(url)) { circuitBreakers.set(url, { failures: 0, lastFailure: 0, state: 'closed' }); }
  return circuitBreakers.get(url);
}

// v6-fix: Prune stale circuit breaker entries to prevent unbounded Map growth.
// Over 5 years with dynamic provider discovery, dead entries accumulate.
function _pruneStaleCircuitBreakers() {
  const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
  for (const [url, entry] of circuitBreakers.entries()) {
    if (entry.state === 'closed' && entry.failures === 0 && entry.lastFailure < cutoff) {
      circuitBreakers.delete(url);
    }
  }
}
setInterval(_pruneStaleCircuitBreakers, 60 * 60 * 1000).unref();

async function safeCall(fn: (signal: AbortSignal) => Promise<unknown>, context: string, { timeoutMs = getCONFIG().REQUEST_TIMEOUT_MS, maxRetries = getCONFIG().RETRY_ATTEMPTS, baseDelay = getCONFIG().RETRY_BASE_DELAY_MS, url = 'unknown', signal: externalSignal }: any = {}) {
  const cb = getCircuitBreaker(url);
  if (cb.state === 'open') {
    const elapsed = Date.now() - cb.lastFailure;
    if (elapsed < getCONFIG().CIRCUIT_BREAKER_TIMEOUT_MS) { throw new Error(`Circuit breaker open for ${url}`); } else { cb.state = 'half-open'; }
  }
  let attempt = 0;
  const safeMaxRetries = Math.max(1, Math.min(Math.floor(maxRetries) || 3, 10));
  while (attempt <= safeMaxRetries) {
    attempt++;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    let externalHandler;
    if (externalSignal) {
      if (externalSignal.aborted) { clearTimeout(timeoutId); throw new Error('Aborted'); }
      externalHandler = () => controller.abort();
      externalSignal.addEventListener('abort', externalHandler, { once: true });
    }
    try {
      const result = await fn(controller.signal);
      cb.failures = 0; cb.state = 'closed'; clearTimeout(timeoutId);
      if (externalSignal && externalHandler) externalSignal.removeEventListener('abort', externalHandler);
      return result;
    } catch (err: any) {
      clearTimeout(timeoutId);
      if (externalSignal && externalHandler) externalSignal.removeEventListener('abort', externalHandler);
      cb.failures++; cb.lastFailure = Date.now();
      if (externalSignal?.aborted) throw err;
      if (cb.failures >= getCONFIG().CIRCUIT_BREAKER_FAILURE_THRESHOLD) { cb.state = 'open'; log(`🔴 Circuit opened for ${url} (${cb.failures} failures)`, 'ERROR', 'base'); }
      if (attempt >= safeMaxRetries) throw err;
      const base = baseDelay * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 200;
      const delay = Math.min(base + jitter, 30000);
      log(`🔄 Retry ${attempt}/${maxRetries} for ${context} after ${delay}ms`, 'WARN', 'base');
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function classifyError(err: unknown) { 
  const msg = (err && typeof err === 'object' && (err as any).message) || (typeof err === 'string' ? err : '');
  if (msg.includes('ECONNRESET') || msg.includes('ETIMEDOUT') || msg.includes('Timeout') || msg.includes('RATE_LIMIT')) return { code: 'transient', retryable: true, healable: false };
  if (msg.includes('Invalid API key') || msg.includes('HTTP_ERROR_401') || msg.includes('HTTP_ERROR_403')) return { code: 'fatal', retryable: false, healable: false };
  if (msg.includes('browser disconnected') || msg.includes('Browser disconnected')) return { code: 'transient', retryable: true, healable: false };
  return { code: 'unknown', retryable: true, healable: true };
}

class RequestCoalescer {
  maxTokens: any;
  temperature: any;
  responseFormat: any;
  signal: any;
  response_format: any;
  retryAfterMs: any;
  rateLimitRemaining: any;
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

// v5-fix H4: Lazy-load protocol chameleon on first use instead of at module
// evaluation time. Previously `getCONFIG().ENABLE_PROTOCOL_CHAMELEON` ran
// before DI injection, creating an implicit ordering dependency.
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

const _originalCallChatCompletion = callChatCompletion;
// @ts-expect-error
callChatCompletion = async function(endpoint: any, apiKey: any, model: any, base64Image: any, prompt: any, options: any = {}) {
  try { return await _originalCallChatCompletion(endpoint, apiKey, model, base64Image, prompt, options); } catch (err: any) {
    const protocolChameleon = getProtocolChameleon();
    if (err.message && err.message.includes('HTTP_ERROR_422') && protocolChameleon) {
      log(`422 error, attempting protocol adaptation for ${endpoint}`, 'WARN', 'base');
      try {
        const providerName = Object.keys(getCONFIG().PROTOCOL_CHAMELEON_SCHEMA_URLS).find(p => endpoint.includes(p)) || 'unknown';
        const adapted = await protocolChameleon.adapt(endpoint, apiKey, model, { base64Image, prompt, options }, providerName);
        if (adapted) { log('Protocol adaptation succeeded.', 'INFO', 'base'); return adapted; }
      } catch (adaptErr: any) { logError('Protocol adaptation failed', adaptErr); }
    }
    throw err;
  }
};

module.exports = {
  get fetchWithTimeout() { return _getUtilsFetch().fetchWithTimeout; },
  sanitizeErrorText,
  extractJSON,
  validateActionResponse,
  callChatCompletion,
  callChatCompletionWithRollback,
  getProviderConfig,
  retryWithBackoff,
  safeCall,
  classifyError,
  getCircuitBreaker,
  coalescer,
  _injectDependencies,
};
