'use strict';

// ─── BazaarLink Codegen Provider ─────────────────────────────────────────
// OpenAI-compatible API at https://api.bazaarlink.ai/v1
// Replaces Qwen + DeepSeek in the codegen tribunal.
// Uses parseCodegenResponse from providers-codegen-mistral.ts (shared parser).
// Rate-limited to 50 requests/day via bazaarlink-rate-limiter.ts.

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { fetchWithTimeout, sanitizeErrorText } = require('./providers-base');

// ─── Rate Limiter (delegates to bazaarlink-rate-limiter.ts) ──────
let _limiter: any = null;
function _getLimiter() {
  if (!_limiter) _limiter = require('./bazaarlink-rate-limiter');
  return _limiter;
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
 * Uses parseCodegenResponse (not extractJSON) since codegen returns
 * {file, change, patch} arrays, not action objects with actionType.
 */
async function callBazaarLinkCodeGenWithModel(prompt: any, signal: any, modelSlug: any) { 
  const apiKey = getCONFIG().BAZAARLINK_API_KEY;
  if (!apiKey) throw new Error('BazaarLink API key missing');

  // ─── Daily limit gate (50 req/day for codegen) ───
  _getLimiter().checkBudget();

  const payload: any = {
    model: modelSlug,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2048,
    // Do NOT set response_format:json_object — the prompt asks for a
    // JSON array, and json_object forces top-level object, causing
    // double-escaped responses (see Mistral fix).
  };

  const response = await fetchWithTimeout('https://api.bazaarlink.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal
  });

  if (!response.ok) {
    const errorText = sanitizeErrorText(await response.text());
    // On 429, sync the rate limiter to reality
    if (response.status === 429) {
      _getLimiter().forceExhaust('BazaarLink 429');
    }
    throw new Error(`BazaarLink ${modelSlug} HTTP ${response.status}: ${errorText}`);
  }

  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`BazaarLink ${modelSlug} empty response`);

  // Debug log: first 200 chars of raw response (helps diagnose parse failures)
  try {
    const { log } = require('./logger');
    log(`BL/${modelSlug} raw response (${raw.length} chars): ${raw.substring(0, 200).replace(/\n/g, ' ')}`, 'DEBUG', 'bl-raw');
  } catch {}

  // Record usage after successful call
  _getLimiter().recordUsage();

  // Use the codegen-aware parser (handles arrays, double-escapes, etc.)
  const { parseCodegenResponse } = require('./providers-codegen-mistral');
  return parseCodegenResponse(raw);
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
 */
function getBazaarLinkModels(): string[] {
  const configModel = getCONFIG().CODE_GEN_MODEL_BAZAARLINK;
  if (configModel) {
    // If the user set a specific model, still try auto:free first
    if (configModel !== 'auto:free') {
      return ['auto:free', configModel];
    }
    return ['auto:free'];
  }
  return ['auto:free', ...DEFAULT_MODELS];
}

module.exports = {
  callBazaarLinkCodeGen,
  callBazaarLinkCodeGenWithModel,
  getBazaarLinkModels,
  _injectDependencies,
};
