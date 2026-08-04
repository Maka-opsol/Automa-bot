'use strict';

// ─── Cerebras Provider ───────────────────────────────────────────────────────
//
// Uses Cerebras inference API with llama-4-scout-17b-16e-instruct (free tier).
// OpenAI-compatible API. TEXT-ONLY — does not support vision.
// Does NOT reliably support response_format.
//
// P1: Content serialization handled by providers-base/serializers.
//     The serializer sends plain string content (never array format).
//     supportsVision=false, supportsMultipartContent=false.
// P7: providerName passed to retryWithBackoff for health-aware retries.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function CerebrasProvider() {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Cerebras');

    // P1 FIX: Do NOT pass responseFormat — Cerebras doesn't support it.
    // P7: Pass providerName for health-aware retries
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'Cerebras',
        { signal }
      ),
      { providerName: 'Cerebras' }
    );

    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'Cerebras'), 'Cerebras');
  };
}

module.exports = { CerebrasProvider };

