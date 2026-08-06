'use strict';
// Last modified: 2026-08-06 - All providers vision-capable; updated comments, removed text-only skip logic

// ─── OpenRouter Tribunal Provider ───────────────────────────────────────────
//
// Uses OpenRouter's API to access multiple free models.
// This is the most flexible provider - it can route to any OpenRouter model.
// All current models are vision-capable.
//
// Key behaviors:
//   - Uses callChatCompletionWithRollback (not bare callChatCompletion)
//     for protocol chameleon 422 recovery and config rollback support
//   - Falls back through a chain of known free models
//   - P7: providerName passed to retryWithBackoff for health-aware retries
//   - P19: Fallback chain includes multiple free models for resilience

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, retryWithBackoff } = require('./providers-base');

// Lazy logger
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

/**
 * Primary vision models on OpenRouter, ordered by quality.
 * All models are now vision-capable.
 */
const VISION_FALLBACK_MODELS = [
  'google/gemma-3-27b-it',           // Best free vision model on OpenRouter
  'nvidia/nemotron-nano-12b-2-vl',   // NVIDIA Nemotron vision - OCR-optimized
  'google/gemma-3-12b-it',           // Smaller Gemma, still good vision
  'qwen/qwen2.5-vl-72b-instruct',   // Qwen vision - excellent at math OCR
];

/**
 * Additional fallback models for resilience when primary models fail.
 */
const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it',                     // Updated Aug 2026
  'nvidia/nemotron-3-super-120b',               // Efficient MoE, strong reasoning
  'deepseek/deepseek-r1-distill-llama-70b',      // Reasoning (if still available)
];

function OpenRouterTribunalProvider() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return null;
  }

  // The primary model can be overridden via env var
  const primaryModel = process.env.OPENROUTER_TRIBUNAL_MODEL || 'google/gemma-3-27b-it';
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const log = _getLogger().log;

    // Build fallback chain: primary model first, then all fallback models
    const candidates = [primaryModel];
    const fallbackPool = [...VISION_FALLBACK_MODELS, ...TEXT_FALLBACK_MODELS];

    // Deduplicate (primary model might be in the fallback pool)
    const seen = new Set<string>();
    for (const m of candidates) {
      if (!seen.has(m)) seen.add(m);
    }
    for (const m of fallbackPool) {
      if (!seen.has(m)) seen.add(m);
    }
    const models = Array.from(seen);

    let lastErr: any = null;
    for (const m of models) {
      // All models are vision-capable - no need to skip for missing vision support

      try {
        // Use callChatCompletionWithRollback for:
        //   - Protocol chameleon 422 recovery
        //   - Config rollback on 404/401
        // P7: providerName for health-aware retries
        const rawContent = await retryWithBackoff(
          () => callChatCompletionWithRollback(
            endpoint, apiKey, m, base64Image, prompt, 'OpenRouter',
            { signal }
          ),
          { providerName: 'OpenRouter', maxRetries: 2, baseDelay: 1000 }
        );

        if (options.validate === false) return rawContent;
        return validateActionResponse(extractJSON(rawContent, 'OpenRouter'), 'OpenRouter');
      } catch (err: any) {
        lastErr = err;
        const errMsg = err?.message || String(err);

        // On 404 or model-not-found, try next model in chain
        // On other errors, also try next (the fallback chain IS the retry strategy)
        if (errMsg.includes('HTTP_ERROR_404') || errMsg.includes('does not exist')) {
          log(`OpenRouter: model ${m} not found, trying next fallback`, 'WARN', 'openrouter');
          continue;
        }
        // For transient errors (429, 5xx), try next model rather than failing immediately
        if (errMsg.includes('HTTP_ERROR_429') || errMsg.includes('HTTP_ERROR_5') || errMsg.includes('timeout') || errMsg.includes('ECONNREFUSED')) {
          log(`OpenRouter: model ${m} transient error, trying next fallback`, 'WARN', 'openrouter');
          continue;
        }
        // Permanent errors (400, 401, 403) - no point trying other models with same key
        throw err;
      }
    }

    throw lastErr || new Error('OpenRouter: all models exhausted');
  };
}

module.exports = { OpenRouterTribunalProvider };
