'use strict';

// ─── NVIDIA Provider ──────────────────────────────────────────────────────────
//
// Uses NVIDIA NIM API with meta/llama-3.3-70b-instruct (free tier).
// OpenAI-compatible API. Supports vision (all providers now vision-capable).
// Does NOT reliably support response_format on free tier.
//
// P1: Content serialization handled by providers-base/serializers.
//     responseFormat is NOT passed - PROVIDER_CAPABILITIES.supportsResponseFormat=false.
// P7: providerName passed to retryWithBackoff for health-aware retries.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function NvidiaProvider() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('NVIDIA');

    // P1 FIX: Do NOT pass responseFormat - NVIDIA free tier doesn't support it.
    // The serializer (providers-serializers.ts) also strips it via
    // supportsResponseFormat=false, but not passing it at all is cleaner.
    // P7: Pass providerName for health-aware retries
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'NVIDIA',
        { signal }
      ),
      { providerName: 'NVIDIA', signal }
    );

    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'NVIDIA'), 'NVIDIA');
  };
}

module.exports = { NvidiaProvider };
