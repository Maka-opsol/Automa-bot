'use strict';
// Last modified: 2026-08-08 — OpenRouter rate limiter integration, graceful sleep

// ─── OpenRouter Tribunal Provider ───────────────────────────────────────────
//
// Uses OpenRouter's API to access multiple free vision models.
// This is the most flexible provider — it can route to any OpenRouter model.
//
// Key behaviors:
//   - Uses callChatCompletionWithRollback (not bare callChatCompletion)
//     for protocol chameleon 422 recovery and config rollback support
//   - Falls back through a chain of known free vision models
//   - Model-level vision capability check via providers-serializers
//     (e.g., llama-4-scout is text-only and will be skipped for vision tasks)
//   - P7: providerName passed to retryWithBackoff for health-aware retries
//   - P19: Fallback chain includes multiple free vision models for resilience
//   - Rate limiter: delegates to openrouter-rate-limiter.ts for budget tracking
//   - Graceful sleep: when budget exhausted AND no other providers, sleeps
//     until midnight UTC (the "OpenRouter is the only provider" scenario)

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, retryWithBackoff, _getOrLimiter } = require('./providers-base');
const { providerSupportsVision } = require('./providers-serializers');

// Lazy logger
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

// Lazy registry (for checking if other providers are available)
let _registry: any = null;
function _getRegistry() { if (!_registry) _registry = require('./providers-registry'); return _registry; }

/**
 * Known free vision models on OpenRouter, ordered by quality.
 * Text-only models are filtered out at runtime via providerSupportsVision().
 *
 * Models marked with (V) are confirmed vision-capable.
 * Models marked with (T) are text-only — included as last-resort fallbacks
 * when no image is present, or when vision providers all fail.
 */
const VISION_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',           // (V) Best free vision model on OpenRouter
  'qwen/qwen2.5-vl-72b-instruct:free',   // (V) Qwen vision — excellent at math OCR
  'google/gemma-3-12b-it:free',           // (V) Smaller Gemma, still good vision
];

/**
 * Text-only fallback models. Used only when:
 *   1. No image is provided (text-only request), OR
 *   2. All vision models failed and we have no other option
 * These are cheap, fast, but CANNOT process images.
 */
const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',                     // (T) Updated Aug 2026
  'nvidia/nemotron-3-super-120b:free',               // (T) Efficient MoE, strong reasoning
  'deepseek/deepseek-r1-distill-llama-70b:free',      // (T) Reasoning (if still available)
];

function OpenRouterTribunalProvider() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return null;
  }

  // The primary model can be overridden via env var
  const primaryModel = process.env.OPENROUTER_TRIBUNAL_MODEL || 'openrouter/free';
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const log = _getLogger().log;
    const hasImage = !!base64Image;

    // Build fallback chain based on whether we have an image
    // If image present: try vision models first, then text fallbacks
    // If no image: try primary model, then text fallbacks
    const candidates = [primaryModel];
    const fallbackPool = hasImage
      ? [...VISION_FALLBACK_MODELS, ...TEXT_FALLBACK_MODELS]
      : [...TEXT_FALLBACK_MODELS];

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
      // P1: Skip text-only models when we have an image
      // (the serializer would strip the image, resulting in a blind analysis)
      if (hasImage && !providerSupportsVision('OpenRouter', m)) {
        log(`OpenRouter: skipping text-only model ${m} for vision request`, 'DEBUG', 'openrouter');
        continue;
      }

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
          { providerName: 'OpenRouter', maxRetries: 2, baseDelay: 1000, signal }
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
        // Model returned non-JSON / unparseable response — try next model in chain
        if (errMsg.includes('No action returned') || errMsg.includes('missing actionType') || errMsg.includes('no JSON object found')) {
          log(`OpenRouter: model ${m} returned invalid/unparseable response, trying next fallback`, 'WARN', 'openrouter');
          continue;
        }
        // Permanent errors (400, 401, 403) — no point trying other models with same key
        throw err;
      }
    }

    throw lastErr || new Error('OpenRouter: all models exhausted');
  };
}

/**
 * Check if OpenRouter is the ONLY available provider right now.
 * Used to decide whether to sleep until midnight when budget is exhausted.
 */
async function _isOnlyProvider(): Promise<boolean> {
  try {
    const registry = _getRegistry();
    const providers = await registry.getAvailableProviders();
    // Filter out OpenRouter itself — are there any OTHER providers?
    const others = providers.filter((p: any) => p.name !== 'OpenRouter');
    return others.length === 0;
  } catch {
    return true; // Assume only provider if we can't check
  }
}

/**
 * Graceful wait: if OpenRouter budget is exhausted AND no other providers
 * are available, sleep until midnight UTC (or 30min, whichever is shorter).
 * This prevents the death spiral when OpenRouter is the ONLY provider.
 */
async function waitForOpenRouterBudget(): Promise<void> {
  const limiter = _getOrLimiter();
  const log = _getLogger().log;

  try {
    limiter.checkBudget('critical');
    // Budget available — no need to wait
    return;
  } catch {
    // Budget exhausted
  }

  // Check if other providers are available
  const onlyProvider = await _isOnlyProvider();
  if (!onlyProvider) {
    log('OpenRouter budget exhausted but other providers available — letting them handle it', 'INFO', 'openrouter');
    return;
  }

  // No other providers — sleep until midnight
  await limiter.waitForBudget('critical', {
    checkOtherProviders: async () => !(await _isOnlyProvider()),
  });
}

module.exports = { OpenRouterTribunalProvider, waitForOpenRouterBudget };
