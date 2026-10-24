'use strict';

// ─── BazaarLink Codegen Provider ─────────────────────────────────────────
// Uses the openai SDK with BazaarLink baseURL.
// Replaces Qwen + DeepSeek in the codegen tribunal.
// Uses parseCodegenResponse from providers-codegen-mistral.ts (shared parser).
// Rate-limited to 50 requests/day via bazaarlink-rate-limiter.ts.

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const OpenAI = require('openai').default || require('openai');
const { parseCodegenResponse } = require('./providers-codegen-mistral');

// ─── Rate Limiter (delegates to bazaarlink-rate-limiter.ts) ──────
let _limiter: any = null;
function _getLimiter() {
  if (!_limiter) _limiter = require('./bazaarlink-rate-limiter');
  return _limiter;
}

// TASK 140 (2026-10-24): BazaarLink daily limit tracking
// When BazaarLink returns 429 "daily limit of 60 free-model requests",
// ALL BazaarLink models are exhausted. Skip them all until the flag is cleared.
// The flag clears automatically on process restart (new day = new session).
let _bazaarlinkDailyLimitExhausted = false;
function isBazaarlinkDailyLimitExhausted() { return _bazaarlinkDailyLimitExhausted; }

// ─── Lazy client instance (reuses same client across calls) ──────
let _client: any = null;
function _getClient(apiKey: string): any {
  if (!_client || (_client as any)._apiKey !== apiKey) {
    _client = new OpenAI({
      baseURL: 'https://api.bazaarlink.ai/v1',
      apiKey: apiKey,
      // TASK 108+110+130 (2026-10-22): Disable SDK-level timeout and retries.
      // Codegen tribunals should NOT time out (user's explicit request).
      // TASK 130: OpenAI SDK rejects `Infinity` with "timeout must be an integer"
      // Use a very large integer (24 hours) instead.
      timeout: 86400000, // 24 hours — effectively no timeout
      maxRetries: 0,     // no SDK retries
    });
    (_client as any)._apiKey = apiKey;
  }
  return _client;
}

// ⚠️ DO NOT ALTER THESE MODEL NAMES WITHOUT EXPLICIT USER PERMISSION ⚠️
// 'auto:free' is a valid BazaarLink model that auto-selects the best free model.
const DEFAULT_MODELS = [
  'auto:free',
  'qwen/qwen3.7-flash',
  'deepseek/deepseek-v4-flash',
];

/**
 * Call BazaarLink with a specific model for code generation.
 * Uses the openai SDK with BazaarLink baseURL.
 * Uses parseCodegenResponse since codegen returns
 * {file, change, patch} arrays, not action objects with actionType.
 */
async function callBazaarLinkCodeGenWithModel(prompt: any, signal: any, modelSlug: any) { 
  const apiKey = getCONFIG().BAZAARLINK_API_KEY;
  if (!apiKey) throw new Error('BazaarLink API key missing');

  // ─── Daily limit gate (50 req/day for codegen) ───
  _getLimiter().checkBudget();

  const client = _getClient(apiKey);

  let content: string;
  try {
    const response = await client.chat.completions.create({
      model: modelSlug,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 2048,
    }, { signal });
    content = response.choices[0].message.content ?? '';
  } catch (err: any) {
    // On 429, record 1 usage (same as success) to keep the counter accurate.
    if (err?.status === 429 || String(err?.message || '').includes('429')) {
      _getLimiter().recordUsage();
      // TASK 140 (2026-10-24): Detect BazaarLink daily limit exhaustion.
      // "You have reached the daily limit of 60 free-model requests"
      // When this happens, ALL BazaarLink models are exhausted — skip them all.
      const errMsg = String(err?.error?.message || err?.message || '');
      if (errMsg.includes('daily limit') || errMsg.includes('reached the daily limit')) {
        _bazaarlinkDailyLimitExhausted = true;
        const resetMatch = errMsg.match(/resets at (\d{2}:\d{2}) UTC/);
        const resetTime = resetMatch ? resetMatch[1] : '00:00 UTC';
        log(`BazaarLink: daily limit exhausted (resets at ${resetTime}) — skipping all BazaarLink models for this session`, 'WARN', 'bazaarlink');
      }
    }
    // TASK 107 (2026-10-03): Include more context in error messages.
    const status = err?.status || err?.statusCode || '';
    const detail = err?.error?.message || err?.message || String(err);
    const parts: string[] = [`BazaarLink ${modelSlug}`];
    if (status) parts.push(`HTTP ${status}`);
    parts.push(detail);
    throw new Error(parts.join(': '));
  }

  if (!content || content.trim().length === 0) {
    throw new Error(`BazaarLink ${modelSlug} empty response`);
  }

  // Debug log: first 200 chars of raw response (helps diagnose parse failures)
  try {
    const { log } = require('./logger');
    log(`BL/${modelSlug} raw response (${content.length} chars): ${content.substring(0, 200).replace(/\n/g, ' ')}`, 'DEBUG', 'bl-raw');
  } catch {}

  // Record usage after successful call
  _getLimiter().recordUsage();

  // Use the codegen-aware parser (handles arrays, double-escapes, etc.)
  return parseCodegenResponse(content);
}

/**
 * Call BazaarLink with the default model for code generation.
 */
async function callBazaarLinkCodeGen(prompt: any, signal: any) { 
  const defaultModel = getCONFIG().CODE_GEN_MODEL_BAZAARLINK || 'auto:free';
  return callBazaarLinkCodeGenWithModel(prompt, signal, defaultModel);
}

/**
 * Get the list of BazaarLink models to try in the codegen tribunal.
 * ⚠️ DO NOT ALTER MODEL NAMES WITHOUT EXPLICIT USER PERMISSION ⚠️
 *
 * ALWAYS returns all models including fallbacks.
 * Config model (if set and different from auto:free) is tried first.
 */
function getBazaarLinkModels(): string[] {
  // ⚠️ DO NOT ALTER THESE MODEL NAMES WITHOUT EXPLICIT USER PERMISSION ⚠️
  const allModels = [
    'auto:free',
    'qwen/qwen3.7-flash',
    'deepseek/deepseek-v4-flash',
  ];

  const configModel = getCONFIG().CODE_GEN_MODEL_BAZAARLINK;
  if (configModel && configModel !== 'auto:free' && !allModels.includes(configModel)) {
    // User set a custom model not in the default list — try it first
    return [configModel, ...allModels];
  }

  // If config model is in the list, ensure it's first (it's already auto:free or a default)
  // Otherwise return all defaults as-is.
  return allModels;
}

module.exports = {
  callBazaarLinkCodeGen,
  callBazaarLinkCodeGenWithModel,
  getBazaarLinkModels,
  isBazaarlinkDailyLimitExhausted,
  _injectDependencies,
};
