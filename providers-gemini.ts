'use strict';

// ─── Gemini Provider ─────────────────────────────────────────────────────────
//
// Uses Google Generative AI SDK (@google/generative-ai). This is the only
// provider that uses a vendor SDK instead of raw HTTP — the serializers
// (providers-serializers.ts) mark it as serializerType='gemini'.
//
// Supports vision (multimodal) via inline data in the parts array.
//
// P10: Gemini free tier is aggressively rate-limited. The registry tracks
//     consecutive 429s with escalating cooldown (30s → 60s → 120s).
//     This provider normalizes Google SDK errors so that classifyError()
//     in providers-health correctly identifies them as 'rate_limited'.
//     The registry's addProviderFailure() then calls recordGemini429().
//
// P7: providerName passed to retryWithBackoff for health-aware retries.
//
// MODEL ROTATION (v3):
//   When a model hits 429 (RESOURCE_EXHAUSTED), the provider automatically
//   tries the next model in the fallback chain. Uses all available
//   Google free-tier TEXT-OUT models for maximum throughput:
//     gemini-2.5-flash → gemini-2.5-pro
//     → gemini-2.0-flash → gemini-1.5-flash
//   NOTE: Image generation (Nano Banana) and TTS models are excluded —
//   they produce non-text output incompatible with the action pipeline.
//   Each model has its own RPM limit, so cycling through them effectively
//   multiplies the available rate limit.
//   A per-model cooldown tracker prevents retrying a rate-limited model
//   until its cooldown expires.
//
// Error normalization: Google SDK errors use different patterns than HTTP:
//   - 429 → error message contains 'RESOURCE_EXHAUSTED' or 'quota'
//   - 400 → 'INVALID_ARGUMENT'
//   - 403 → 'PERMISSION_DENIED'
//   We normalize these to HTTP_ERROR_X format so classifyError() works.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { extractJSON, validateActionResponse, getProviderConfig, getFallbackModels } = require('./providers-base');

/**
 * Normalize a Google SDK error into a format that classifyError() recognizes.
 */
function normalizeGeminiError(err: any): Error {
  const msg = err?.message || String(err) || '';
  const status = err?.status || err?.error?.status || '';

  if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('QUOTA_EXCEEDED') || status === 'RESOURCE_EXHAUSTED') {
    const normalized: any = new Error('HTTP_ERROR_429: RESOURCE_EXHAUSTED - ' + msg);
    if (err?.error?.retryDelayMs) {
      normalized.retryAfterMs = err.error.retryDelayMs;
    }
    return normalized;
  }

  if (msg.includes('INVALID_ARGUMENT') || status === 'INVALID_ARGUMENT') {
    return new Error('HTTP_ERROR_400: ' + msg);
  }

  if (msg.includes('PERMISSION_DENIED') || status === 'PERMISSION_DENIED') {
    return new Error('HTTP_ERROR_403: ' + msg);
  }

  if (msg.includes('NOT_FOUND') || /not found/i.test(msg) || status === 'NOT_FOUND' || status === 404) {
    return new Error('HTTP_ERROR_404: ' + msg);
  }

  if (msg.includes('UNAVAILABLE') || msg.includes('INTERNAL') || status === 'UNAVAILABLE' || status === 'INTERNAL') {
    return new Error('HTTP_ERROR_503: ' + msg);
  }

  return err instanceof Error ? err : new Error(msg);
}

// ─── Per-model cooldown tracker ────────────────────────────────────────────
// When a model hits 429, we record a cooldown so we skip it on the next call
// until the cooldown expires. This prevents wasting time retrying a model
// that we know is still rate-limited.

const _modelCooldowns: Record<string, { expiresAt: number; consecutive429s: number }> = {};

/**
 * Get the full ordered list of models to try (primary + fallbacks).
 */
function _getModelChain(): string[] {
  const config = getProviderConfig('Gemini');
  const primary = config?.model || 'gemini-2.5-flash';
  const fallbacks = getFallbackModels('Gemini');
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const m of [primary, ...fallbacks]) {
    if (!seen.has(m)) {
      seen.add(m);
      chain.push(m);
    }
  }
  return chain;
}

/**
 * Get the first non-cool-downed model from the chain.
 * Returns null if all models are on cooldown.
 */
function _getAvailableModel(): string | null {
  const chain = _getModelChain();
  const now = Date.now();

  for (const model of chain) {
    const cooldown = _modelCooldowns[model];
    if (!cooldown || now >= cooldown.expiresAt) {
      return model;
    }
  }

  // All models are on cooldown — find the one that expires soonest
  let soonestExpiry = Infinity;
  let soonestModel: string | null = null;
  for (const model of chain) {
    const cooldown = _modelCooldowns[model];
    if (cooldown && cooldown.expiresAt < soonestExpiry) {
      soonestExpiry = cooldown.expiresAt;
      soonestModel = model;
    }
  }

  return soonestModel;
}

/**
 * Record a 429 for a model, escalating the cooldown.
 * Escalation: 30s → 60s → 120s → 240s (max 4 min).
 */
function _recordModel429(model: string): void {
  const now = Date.now();
  const existing = _modelCooldowns[model];
  const prevCount = existing ? existing.consecutive429s : 0;
  const newCount = prevCount + 1;

  // Escalating cooldown: 30s × 2^min(count-1, 3)
  const cooldownSecs = 30 * Math.pow(2, Math.min(newCount - 1, 3));
  _modelCooldowns[model] = {
    expiresAt: now + cooldownSecs * 1000,
    consecutive429s: newCount,
  };

  log(`Gemini model ${model} hit 429 (#${newCount}), cooldown ${cooldownSecs}s`, 'WARN', 'gemini');
}

/**
 * Clear 429 count for a model (called on successful call).
 */
function _clearModel429(model: string): void {
  if (_modelCooldowns[model]) {
    _modelCooldowns[model].consecutive429s = 0;
    delete _modelCooldowns[model];
  }
}

/**
 * Check if an error is a 429/rate-limit.
 */
function _isRateLimitError(err: any): boolean {
  const msg = err?.message || '';
  return msg.includes('HTTP_ERROR_429') || msg.includes('RESOURCE_EXHAUSTED');
}

function GeminiProvider() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const modelChain = _getModelChain();

    // Try models in order until one succeeds or all fail
    for (const modelId of modelChain) {
      const cooldown = _modelCooldowns[modelId];
      const now = Date.now();
      if (cooldown && now < cooldown.expiresAt) {
        continue; // Skip this model — still on cooldown
      }

      try {
        const result = await _callWithModel(genAI, modelId, base64Image, prompt, signal, options);
        // Success — clear any 429 record for this model
        _clearModel429(modelId);
        return result;
      } catch (err: any) {
        if (_isRateLimitError(err)) {
          _recordModel429(modelId);
          // Continue to next model in chain
          continue;
        }
        // 404 = model doesn't exist or deprecated, skip to next in chain
        if (err.message && (err.message.includes('HTTP_ERROR_404') || err.message.includes('no longer available'))) {
          log(`Gemini model ${modelId} not found/deprecated (404), trying next fallback`, 'WARN', 'gemini');
          continue;
        }
        // Other non-429 error (400, 403, 503) — let the outer retry system handle it
        throw err;
      }
    }

    // All models exhausted (all on cooldown or 404)
    throw new Error('Gemini: All models exhausted (rate-limited or not found)');
  };
}

/**
 * Call a specific Gemini model with error normalization.
 */
async function _callWithModel(
  genAI: any, modelId: string, base64Image: any, prompt: any, signal: any, options: any
) {
  const { retryWithBackoff } = require('./providers-base');

  const model = genAI.getGenerativeModel({ model: modelId });

  // P7: Pass providerName for health-aware retries
  const result = await retryWithBackoff(async () => {
    let _abortHandler: (() => void) | null = null;
    const abortPromise = signal ? new Promise((_, reject) => {
      _abortHandler = () => reject(new Error('Aborted'));
      signal.addEventListener('abort', _abortHandler, { once: true });
    }) : null;

    try {
      const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt }];
      if (base64Image) {
        parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64Image } } as any);
      }

      const generatePromise = model.generateContent(parts);
      return abortPromise
        ? await Promise.race([generatePromise, abortPromise])
        : await generatePromise;
    } catch (sdkErr: any) {
      throw normalizeGeminiError(sdkErr);
    } finally {
      if (_abortHandler && signal) {
        try { signal.removeEventListener('abort', _abortHandler); } catch {}
      }
    }
  }, { providerName: 'Gemini', signal });

  const response = result.response;
  if (!response) throw new Error('Gemini: Empty SDK result');

  const text = response.text();
  if (!text) throw new Error('EMPTY_RESPONSE');

  if (options.validate === false) return text;
  return validateActionResponse(extractJSON(text, 'Gemini'), 'Gemini');
}

// Stub logger if not available at module load
function log(msg: string, level?: string, mod?: string) {
  try { require('./logger').log(msg, level, mod); } catch { console.log(msg); }
}

module.exports = { GeminiProvider, _getModelChain, _getAvailableModel, _recordModel429, _clearModel429 };
