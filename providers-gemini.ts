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
// Error normalization: Google SDK errors use different patterns than HTTP:
//   - 429 → error message contains 'RESOURCE_EXHAUSTED' or 'quota'
//   - 400 → 'INVALID_ARGUMENT'
//   - 403 → 'PERMISSION_DENIED'
//   We normalize these to HTTP_ERROR_X format so classifyError() works.

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { extractJSON, validateActionResponse, getProviderConfig, retryWithBackoff } = require('./providers-base');

/**
 * Normalize a Google SDK error into a format that classifyError() recognizes.
 * Without this, RESOURCE_EXHAUSTED (429) would be classified as 'unknown'
 * instead of 'rate_limited', bypassing the Gemini 429 cooldown logic.
 */
function normalizeGeminiError(err: any): Error {
  const msg = err?.message || String(err) || '';
  const status = err?.status || err?.error?.status || '';

  // 429 / quota exhausted
  if (msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('QUOTA_EXCEEDED') || status === 'RESOURCE_EXHAUSTED') {
    const normalized: any = new Error('HTTP_ERROR_429: RESOURCE_EXHAUSTED - ' + msg);
    // Preserve retry-after if the SDK provides it
    if (err?.error?.retryDelayMs) {
      normalized.retryAfterMs = err.error.retryDelayMs;
    }
    return normalized;
  }

  // 400 / invalid argument
  if (msg.includes('INVALID_ARGUMENT') || status === 'INVALID_ARGUMENT') {
    return new Error('HTTP_ERROR_400: ' + msg);
  }

  // 403 / permission denied
  if (msg.includes('PERMISSION_DENIED') || status === 'PERMISSION_DENIED') {
    return new Error('HTTP_ERROR_403: ' + msg);
  }

  // 404 / model not found
  if (msg.includes('NOT_FOUND') || status === 'NOT_FOUND') {
    return new Error('HTTP_ERROR_404: ' + msg);
  }

  // 500+ / server error
  if (msg.includes('UNAVAILABLE') || msg.includes('INTERNAL') || status === 'UNAVAILABLE' || status === 'INTERNAL') {
    return new Error('HTTP_ERROR_503: ' + msg);
  }

  // Pass through with original message preserved
  return err instanceof Error ? err : new Error(msg);
}

function GeminiProvider() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return null;
  }

  const genAI = new GoogleGenerativeAI(apiKey);

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Gemini');
    const model = genAI.getGenerativeModel({ model: config.model });

    // P7: Pass providerName for health-aware retries
    const result = await retryWithBackoff(async () => {
      let _abortHandler: (() => void) | null = null;
      const abortPromise = signal ? new Promise((_, reject) => {
        _abortHandler = () => reject(new Error('Aborted'));
        signal.addEventListener('abort', _abortHandler, { once: true });
      }) : null;

      try {
        // Build parts array for Gemini SDK
        const parts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [{ text: prompt }];
        if (base64Image) {
          parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64Image } } as any);
        }

        const generatePromise = model.generateContent(parts);
        return abortPromise
          ? await Promise.race([generatePromise, abortPromise])
          : await generatePromise;
      } catch (sdkErr: any) {
        // P10: Normalize Google SDK errors so classifyError() in the retry
        // system and health module can correctly categorize them.
        // Without this, 429/RESOURCE_EXHAUSTED would be 'unknown' and
        // the Gemini cooldown escalation in the registry wouldn't trigger.
        throw normalizeGeminiError(sdkErr);
      } finally {
        if (_abortHandler && signal) {
          try { signal.removeEventListener('abort', _abortHandler); } catch {}
        }
      }
    }, { providerName: 'Gemini' });

    // Validate response
    const response = result.response;
    if (!response) throw new Error('Gemini: Empty SDK result');

    const text = response.text();
    if (!text) throw new Error('EMPTY_RESPONSE');

    if (options.validate === false) return text;
    return validateActionResponse(extractJSON(text, 'Gemini'), 'Gemini');
  };
}

module.exports = { GeminiProvider };
