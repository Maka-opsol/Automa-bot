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
    // TASK 110 (2026-10-06): Handle timeout=0 as "no timeout" in the
    // inline fallback too (the utils-fetch version already handles this,
    // but the inline fallback didn't — causing codegen requests to time out
    // at 30s when utils-fetch wasn't loaded).
    const useTimeout = effectiveTimeout > 0;
    const controller = new AbortController();
    const timeoutId = useTimeout ? setTimeout(() => controller.abort(), effectiveTimeout) : null;
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
      if (timeoutId) clearTimeout(timeoutId);
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
  options: { signal?: any; maxTokens?: number; temperature?: number; responseFormat?: any; systemMessage?: string; timeoutMs?: number } = {}
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

  // TASK 117 (2026-10-11): Build messages array with optional system message.
  // Some smaller models (e.g., NVIDIA's llama-3.2-11b-vision-instruct) don't
  // follow JSON-output instructions when they're buried in the user message.
  // A dedicated system message with the JSON instruction significantly
  // improves compliance.
  const messages: any[] = [];
  if (options.systemMessage && typeof options.systemMessage === 'string' && options.systemMessage.length > 0) {
    messages.push({ role: 'system', content: options.systemMessage });
  }
  messages.push({ role: 'user', content: userContent });

  const payload: any = {
    model,
    messages,
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
  }, options.timeoutMs);

  // Handle 422 — protocol chameleon: try without response_format
  if (response.status === 422 && payload.response_format) {
    log(`${providerName} 422 — retrying without response_format`, 'WARN', 'base');
    delete payload.response_format;
    const retryResponse = await fetchWithTimeout(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      signal: options.signal,
    }, options.timeoutMs);
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

    // TASK 112 (2026-10-08): Detect OpenRouter daily limit exhaustion.
    // When X-RateLimit-Remaining is 0, the free-model daily quota is used up.
    // Extract the reset time from the error response and cache it so we
    // don't waste more API calls that will all 429.
    if (providerName === 'OpenRouter' && response.status === 429 &&
        errorText.includes('free-models-per-day')) {
      // Try to extract X-RateLimit-Reset from the error text
      const resetMatch = errorText.match(/X-RateLimit-Reset["']?:\s*["']?(\d+)/);
      if (resetMatch && resetMatch[1]) {
        const resetTime = parseInt(resetMatch[1], 10);
        // Set the OpenRouter tribunal's daily limit flags
        try {
          const orMod = require('./providers-openrouter-tribunal');
          if (orMod?._setDailyLimitExhausted) {
            orMod._setDailyLimitExhausted(resetTime);
          }
        } catch {}
        log(`OpenRouter: daily limit exhausted — free-models-per-day=0. Reset at ${new Date(resetTime).toISOString()}. Will skip API calls until reset.`, 'WARN', 'base');
      }
    }

    // Stealth signal — report provider HTTP failure for risk scoring.
    // Cheap and best-effort: never breaks the provider call. The signal
    // decays on its own TTL inside stealth-operations.
    try {
      const stealth = require('./stealth-operations');
      if (stealth?.reportSignal) {
        const _status = response.status;
        const _detail = `${providerName} HTTP ${_status}: ${errorText.slice(0, 120)}`;
        // Provider 429s are API-key rate limits (keyed on the API key, not our
        // egress IP) — rotating IP/UA via stealth-ops cannot fix them, and a
        // weight-40 signal flips stealth to ELEVATED/MAXIMUM on every 429,
        // triggering pointless IP/UA rotation + log spam. Drop the signal for
        // provider 429s; keep http_block for 403/401/5xx (those may be target-site
        // IP blocks where rotation actually helps).
        if (_status === 403 || _status === 401) {
          stealth.reportSignal('http_block', `providers:${providerName}`, _detail, 60);
        } else if (_status >= 500) {
          stealth.reportSignal('http_block', `providers:${providerName}`, _detail, 20);
        }
      }
    } catch { /* stealth unavailable — never break provider call */ }

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

  // Collect every parsed JSON value we can find, split by whether it looks like
  // an action object. Action callers (validateActionResponse) need actionType;
  // vision/coordinate callers expect bare {x,y} objects or arrays of them.
  // Return the best action object if any exists, otherwise the first valid
  // object/array — so vision coordinate responses are accepted (they have no
  // actionType). Action callers' validator (validateActionResponse) rejects
  // non-action objects, so returning them is safe for action callers too.
  const actionCandidates: any[] = [];
  const otherCandidates: any[] = [];

  const consider = (val: any) => {
    if (val === null || val === undefined) return;
    if (val && typeof val === 'object' && !Array.isArray(val) && val.actionType) {
      actionCandidates.push(val); return;
    }
    if (val && typeof val === 'object' && !Array.isArray(val) && val.action && typeof val.action === 'object' && val.action.actionType) {
      actionCandidates.push(val.action); return;
    }
    if (Array.isArray(val)) {
      const actionItem = val.find((it: any) => it && typeof it === 'object' && it.actionType);
      if (actionItem) { actionCandidates.push(actionItem); return; }
      const nestedActionItem = val.find((it: any) => it && it.action && it.action.actionType);
      if (nestedActionItem) { actionCandidates.push(nestedActionItem.action); return; }
      // coordinate array (or other array) — accept as-is
      otherCandidates.push(val); return;
    }
    if (val && typeof val === 'object') {
      // bare object, e.g. {x,y} coordinate — accept as-is
      otherCandidates.push(val); return;
    }
  };

  // 1. Try parsing the entire response as JSON first
  consider(_tryParseJSON(rawContent));

  // 2. Markdown code fences: ```json ... ``` or ``` ... ```
  const fenceRe = /```(?:json)?\s*([\s\S]*?)```/g;
  let m;
  while ((m = fenceRe.exec(rawContent)) !== null) {
    consider(_tryParseJSON(m[1].trim()));
  }

  // 3. Top-level { ... } object blocks via brace-depth tracking (skips braces inside strings)
  const objBlocks: string[] = [];
  {
    let depth2 = 0, blockStart = -1, inString = false, stringChar = '';
    for (let i2 = 0; i2 < rawContent.length; i2++) {
      const ch = rawContent[i2];
      if (inString) { if (ch === '\\') { i2++; continue; } if (ch === stringChar) inString = false; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue; }
      if (ch === '{') { if (depth2 === 0) blockStart = i2; depth2++; }
      else if (ch === '}') { depth2--; if (depth2 === 0 && blockStart >= 0) { objBlocks.push(rawContent.substring(blockStart, i2 + 1)); blockStart = -1; } }
    }
  }
  for (const blk of objBlocks) consider(_tryParseJSON(blk));

  // 4. Top-level [ ... ] array blocks via bracket-depth tracking (NEW — arrays
  //    like [] or [{"x":0.5,"y":0.6}] were never extracted by the brace tracker)
  const arrBlocks: string[] = [];
  {
    let depth3 = 0, blockStart = -1, inString = false, stringChar = '';
    for (let i3 = 0; i3 < rawContent.length; i3++) {
      const ch = rawContent[i3];
      if (inString) { if (ch === '\\') { i3++; continue; } if (ch === stringChar) inString = false; continue; }
      if (ch === '"' || ch === "'" || ch === '`') { inString = true; stringChar = ch; continue; }
      if (ch === '[') { if (depth3 === 0) blockStart = i3; depth3++; }
      else if (ch === ']') { depth3--; if (depth3 === 0 && blockStart >= 0) { arrBlocks.push(rawContent.substring(blockStart, i3 + 1)); blockStart = -1; } }
    }
  }
  for (const blk of arrBlocks) consider(_tryParseJSON(blk));

  // 5. Last-resort: greedy regex for all {...} and [...] blocks (including nested).
  //    Try from LAST to FIRST for objects — chain-of-thought models put the real
  //    action JSON at the end.
  const allObj = rawContent.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || [];
  for (let k = allObj.length - 1; k >= 0; k--) consider(_tryParseJSON(allObj[k]));
  const allArr = rawContent.match(/\[[^\[\]]*(?:\[[^\[\]]*\][^\[\]]*)*\]/g) || [];
  for (const s of allArr) consider(_tryParseJSON(s));

  // 6. Prefer action objects (action callers); otherwise the first valid object/array (vision callers)
  if (actionCandidates.length > 0) return actionCandidates[0];
  if (otherCandidates.length > 0) return otherCandidates[0];

  // 7. Nothing found — log for debugging
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
  // Providers commonly wrap HTTP responses in plain Error messages such as
  // HTTP_ERROR_429: {...}; these errors have no status/statusCode property.
  // Extract the wrapped status before message heuristics so bare 429s are not
  // misclassified as unknown and retried with the generic cooldown.
  const statusMatch = String(msg).match(/(?:HTTP_ERROR_|HTTP\s+|^)([45]\d{2})\b/i);
  const status = err?.status || err?.statusCode || (statusMatch ? parseInt(statusMatch[1], 10) : 0);

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
      // (even from different code paths) won't hammer the same provider, AND
      // short-circuit the retry loop immediately. Without the bail, a 2-retry
      // call logs "Retry 1/2 → Retry 2/2 → Retry exhausted" (3 lines) for a
      // provider we JUST marked rate-limited — pure noise. The cooldown gate at
      // the top of this function catches the next call.
      if (classified.category === 'rate_limited' && providerName) {
        setProviderCooldown(providerName, classified.retryAfterMs);
        if (attempt < maxRetries) {
          log(`Provider ${providerName} rate-limited — short-circuiting retries (cooldown ${Math.round(classified.retryAfterMs / 1000)}s)`, 'WARN', 'base');
          throw err;
        }
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

  // TASK 110 (2026-10-06): If timeoutMs is 0 or Infinity, don't set a timer.
  // This allows codegen provider calls (which use safeCall) to run without
  // any timeout. The old code always set a 120s timer — "Request timed out"
  // errors in the codegen tribunal were caused by this timer firing.
  const useTimeout = timeoutMs > 0 && timeoutMs !== Infinity;

  const timeoutPromise = useTimeout
    ? new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort();
          reject(new Error(`${label} timed out after ${timeoutMs}ms${url ? ` (${url})` : ''}`));
        }, timeoutMs);
      })
    : new Promise<never>(() => {}); // never resolves — no timeout

  // Start fn(signal) so we can attach a catch handler if timeout wins the race.
  const fnPromise = fn(signal);

  try {
    const result = await Promise.race([
      fnPromise,
      timeoutPromise,
    ]);
    return result;
  } catch (err: any) {
    // Suppress the redundant WARN for known rate-limit / cooldown outcomes —
    // retryWithBackoff already logged the specific cause. Logging it again here
    // at WARN (plus the vision-pipeline DEBUG) was 2+ extra lines per provider
    // per cycle for a condition we already know about. Keep WARN for unexpected
    // errors; downgrade rate-limit/cooldown to DEBUG.
    const _msg = String(err.message || err);
    const _isRateLimit = /PROVIDER_COOLDOWN|HTTP_ERROR_429|rate_limit|rate-limited|OPENROUTER_DAILY_LIMIT|DAILY_LIMIT|429/.test(_msg);
    log(`${label} failed: ${_msg}`, _isRateLimit ? 'DEBUG' : 'WARN', 'base');
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
  // Backward-compat alias: callers built before the v2 rename (e.g.
  // services-model-evolution-v2.ts, self-documenting-diary.ts,
  // meta-learner-reflection.ts, critical-patch-consensus.ts,
  // protocol-chameleon.ts, provider-quota-bargain.ts) still look up
  // `callChatCompletion`. Without this alias they get `undefined` and
  // silently no-op every provider call — which is what caused the
  // "callChatCompletion not available for model testing" log storm.
  callChatCompletion: callChatCompletionWithRollback,
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
