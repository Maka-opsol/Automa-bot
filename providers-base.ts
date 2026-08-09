'use strict';

/**
 * providers-base.ts — Shared utilities for all AI providers.
 *
 * Key functions:
 *   extractJSON()       — Extract ALL JSON objects from a response string
 *   validateActionResponse() — Validate the extracted action has required fields
 *   getProviderConfig() — Get config for a named provider
 *   retryWithBackoff()  — Retry with exponential backoff + circuit-aware delays
 *   classifyError()     — Classify errors for circuit breaker / health tracking
 *   safeCall()          — Timeout-wrapped call for tribunal etc.
 */

const _getLog = () => { try { return require('./logger'); } catch { return { log: console.log, logError: console.error }; } };

/**
 * DI injection hook — called by container-modules.ts during initialization.
 * providers-base uses lazy require() internally, so this is a no-op.
 */
function _injectDependencies(_deps: any) {
  // No-op: this module uses lazy require('./logger') and require('./get-config')
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

function getProviderConfig(providerName: string): Record<string, any> {
  try {
    const config = require('./get-config');
    const providers = config.PROVIDERS || {};
    return providers[providerName] || {};
  } catch {
    return {};
  }
}

// ─── classifyError ───────────────────────────────────────────────────────

function classifyError(err: any): { category: string; retryable: boolean; retryAfterMs: number } {
  const msg = err?.message || err?.toString?.() || '';
  const status = err?.status || err?.statusCode || 0;

  // Rate limited
  if (status === 429 || msg.includes('rate_limit') || msg.includes('rate limit') || msg.includes('rate_limited')) {
    // Extract retry-after from message or default to 60s
    const match = msg.match(/retry after (\d+)ms/);
    const retryAfterMs = match ? parseInt(match[1], 10) : 60000;
    return { category: 'rate_limited', retryable: true, retryAfterMs };
  }

  // Auth errors
  if (status === 401 || status === 403 || msg.includes('unauthorized') || msg.includes('forbidden') || msg.includes('invalid api')) {
    return { category: 'auth', retryable: false, retryAfterMs: 0 };
  }

  // Model errors
  if (status === 404 || msg.includes('model_not_found') || msg.includes('does not exist')) {
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
async function retryWithBackoff(
  fn: () => Promise<any>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    providerName?: string;
  } = {}
): Promise<any> {
  const { maxRetries = 3, baseDelayMs = 1000, providerName } = options;
  const log = _getLog().log;

  let lastError: any = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      lastError = err;
      const classified = classifyError(err);

      if (!classified.retryable || attempt >= maxRetries) {
        log(
          `Retry exhausted for ${providerName || 'unknown'}: ${classified.category}: ${attempt >= maxRetries ? `max ${maxRetries} retries exceeded` : `not retryable`} (attempt ${attempt + 1}/${maxRetries})`,
          'WARN',
          'base'
        );
        throw err;
      }

      const delay = Math.min(classified.retryAfterMs || baseDelayMs * Math.pow(2, attempt), 60000);
      log(
        `Retry ${attempt + 1}/${maxRetries} for ${providerName || 'unknown'} after ${delay}ms: ${classified.category}: retry after ${Math.min(delay, 60000)}ms`,
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
  options: { timeoutMs?: number; url?: string } = {}
): Promise<any> {
  const { timeoutMs = 120000, url } = options;
  const log = _getLog().log;

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const controller = { aborted: false };

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.aborted = true;
      reject(new Error(`${label} timed out after ${timeoutMs}ms${url ? ` (${url})` : ''}`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([
      fn(controller),
      timeoutPromise,
    ]);
    return result;
  } catch (err: any) {
    log(`${label} failed: ${err.message || err}`, 'WARN', 'base');
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

module.exports = {
  extractJSON,
  validateActionResponse,
  getProviderConfig,
  retryWithBackoff,
  classifyError,
  safeCall,
  _injectDependencies,
};
