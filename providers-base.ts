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
      return data.choices?.[0]?.message?.content || '';
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
            return data.choices?.[0]?.message?.content || '';
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
  return data.choices?.[0]?.message?.content || '';
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
