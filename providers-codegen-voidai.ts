'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// providers-codegen-voidai.ts — VoidAI Codegen Provider
// ═══════════════════════════════════════════════════════════════════════════
// Uses the openai SDK with VoidAI baseURL (https://api.voidai.app/v1).
// Joins the codegen tribunal alongside BazaarLink + Mistral.
//
// Setup (per user's spec):
//   import OpenAI from 'openai';
//   const client = new OpenAI({
//     apiKey: 'sk-voidai-your_key_here',
//     baseURL: 'https://api.voidai.app/v1'
//   });
//   const response = await client.chat.completions.create({
//     model: 'gpt-5.1',
//     messages: [...]
//   });
//
// Uses parseCodegenResponse from providers-codegen-mistral.ts (shared parser)
// since codegen returns {file, change, patch} arrays, not action objects.
// ═══════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const OpenAI = require('openai').default || require('openai');
const { parseCodegenResponse } = require('./providers-codegen-mistral');

// ─── Lazy client instance (reuses same client across calls) ──────
let _client: any = null;
function _getClient(apiKey: string): any {
  if (!_client || (_client as any)._apiKey !== apiKey) {
    _client = new OpenAI({
      baseURL: 'https://api.voidai.app/v1',
      apiKey: apiKey,
      // TASK 108+110 (2026-10-06): Disable SDK-level timeout and retries.
      // Codegen tribunals should NOT time out (user's explicit request).
      // NOTE: OpenAI SDK treats timeout: 0 as "use default" (60s), NOT
      // "no timeout." Must use Infinity to actually disable.
      timeout: Infinity, // no timeout (wait forever for code generation)
      maxRetries: 0,     // no SDK retries (we handle retries ourselves)
    });
    (_client as any)._apiKey = apiKey;
  }
  return _client;
}

// ⚠️ DO NOT ALTER THESE MODEL NAMES WITHOUT EXPLICIT USER PERMISSION ⚠️
// User-specified VoidAI models for codegen tribunal.
// 'gpt-5.3-codex' is the primary model (best for code generation).
// The list provides fallbacks in case the primary model is unavailable.
const DEFAULT_MODELS = [
  'gpt-5.3-codex',
  'claude-haiku-4-5-20251001',
  'deepseek-v4-pro',
  'qwen3-coder-480b-a35b-instruct',
  'kimi-k2.7-code',
  'glm-5.3',
  'qwen3.8-27b:free',
];

/**
 * Call VoidAI with a specific model for code generation.
 * Uses the openai SDK with VoidAI baseURL.
 * Uses parseCodegenResponse since codegen returns
 * {file, change, patch} arrays, not action objects with actionType.
 */
async function callVoidAICodeGenWithModel(prompt: any, signal: any, modelSlug: any) {
  const apiKey = getCONFIG().VOIDAI_API_KEY;
  if (!apiKey) throw new Error('VoidAI API key missing');

  const client = _getClient(apiKey);

  let content: string;
  let lastErr: any = null;
  const maxRetries = 2;

  // TASK 107 (2026-10-03): Retry on HTTP 500 errors.
  // VoidAI's gpt-5.3-codex and claude-haiku-4-5 models intermittently return
  // HTTP 500 (server-side errors). These are transient — retrying with a
  // short delay often succeeds. The old code threw immediately on any error,
  // wasting the entire codegen tribunal round.
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await client.chat.completions.create({
        model: modelSlug,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        max_tokens: 2048,
      }, { signal });
      content = response.choices[0].message.content ?? '';

      // Success — break out of retry loop
      if (content && content.trim().length > 0) {
        break;
      }
      // Empty response — treat as error and retry
      lastErr = new Error(`VoidAI ${modelSlug} empty response`);
    } catch (err: any) {
      lastErr = err;
      const status = err?.status || err?.statusCode || 0;
      const errMsg = String(err?.message || err || '');

      // Only retry on 500 (server error) or network errors
      const isRetryable = status === 500 || status === 502 || status === 503 ||
        errMsg.includes('request_failed') || errMsg.includes('ETIMEDOUT') ||
        errMsg.includes('ECONNRESET') || errMsg.includes('fetch failed');

      if (!isRetryable || attempt === maxRetries) {
        // Non-retryable error or max retries exhausted — throw with context
        const code = err?.error?.code || err?.code || '';
        const type = err?.error?.type || err?.type || '';
        const detail = err?.error?.message || err?.message || String(err);
        const parts: string[] = [`VoidAI ${modelSlug}`];
        if (status) parts.push(`HTTP ${status}`);
        if (code) parts.push(`code=${code}`);
        if (type) parts.push(`type=${type}`);
        parts.push(detail);
        if (attempt > 0) parts.push(`(after ${attempt + 1} attempts)`);
        throw new Error(parts.join(': '));
      }

      // Retryable — wait before next attempt
      const backoffMs = 1000 * (attempt + 1); // 1s, 2s
      try {
        const { log } = require('./logger');
        log(`VoidAI/${modelSlug}: HTTP ${status} on attempt ${attempt + 1}/${maxRetries + 1} — retrying in ${backoffMs}ms`, 'WARN', 'voidai');
      } catch {}
      await new Promise(r => setTimeout(r, backoffMs));
    }
  }

  if (!content || content.trim().length === 0) {
    throw lastErr || new Error(`VoidAI ${modelSlug} empty response after ${maxRetries + 1} attempts`);
  }

  // Debug log: first 200 chars of raw response (helps diagnose parse failures)
  try {
    const { log } = require('./logger');
    log(`VoidAI/${modelSlug} raw response (${content.length} chars): ${content.substring(0, 200).replace(/\n/g, ' ')}`, 'DEBUG', 'voidai-raw');
  } catch {}

  // Use the codegen-aware parser (handles arrays, double-escapes, etc.)
  return parseCodegenResponse(content);
}

/**
 * Call VoidAI with the default model for code generation.
 */
async function callVoidAICodeGen(prompt: any, signal: any) {
  const defaultModel = getCONFIG().CODE_GEN_MODEL_VOIDAI || 'gpt-5.3-codex';
  return callVoidAICodeGenWithModel(prompt, signal, defaultModel);
}

/**
 * Get the list of VoidAI models to try in the codegen tribunal.
 * ⚠️ DO NOT ALTER MODEL NAMES WITHOUT EXPLICIT USER PERMISSION ⚠️
 *
 * ALWAYS returns all models including fallbacks.
 * Config model (if set and different from gpt-5.3-codex) is tried first.
 */
function getVoidAIModels(): string[] {
  // ⚠️ DO NOT ALTER THESE MODEL NAMES WITHOUT EXPLICIT USER PERMISSION ⚠️
  const allModels = [
    'gpt-5.3-codex',
    'claude-haiku-4-5-20251001',
    'deepseek-v4-pro',
    'qwen3-coder-480b-a35b-instruct',
    'kimi-k2.7-code',
    'glm-5.3',
    'qwen3.8-27b:free',
  ];

  const configModel = getCONFIG().CODE_GEN_MODEL_VOIDAI;
  if (configModel && configModel !== 'gpt-5.3-codex' && !allModels.includes(configModel)) {
    // User set a custom model not in the default list — try it first
    return [configModel, ...allModels];
  }

  // If config model is in the list, ensure it's first (it's already gpt-5.3-codex or a default)
  // Otherwise return all defaults as-is.
  return allModels;
}

module.exports = {
  callVoidAICodeGen,
  callVoidAICodeGenWithModel,
  getVoidAIModels,
  _injectDependencies,
};
