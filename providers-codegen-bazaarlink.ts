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

// ─── Lazy client instance (reuses same client across calls) ──────
let _client: any = null;
function _getClient(apiKey: string): any {
  if (!_client || (_client as any)._apiKey !== apiKey) {
    _client = new OpenAI({
      baseURL: 'https://api.bazaarlink.ai/v1',
      apiKey: apiKey,
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
    // The isExhausted() pre-check in the tribunal will naturally stop
    // calling when the budget is truly exhausted. Using recordUsage()
    // instead of forceExhaust() avoids over-counting: previously forceExhaust
    // added 5 per 429, and with 3 concurrent models all getting 429 that
    // burned 15 per tribunal round (50 budget in ~4 rounds with only ~12 actual requests).
    if (err?.status === 429 || String(err?.message || '').includes('429')) {
      _getLimiter().recordUsage();
    }
    throw new Error(`BazaarLink ${modelSlug}: ${err.message || err}`);
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
  _injectDependencies,
