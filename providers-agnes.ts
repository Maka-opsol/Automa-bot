'use strict';

// ─── Agnes Provider ─────────────────────────────────────────────────────────
//
// Agnes is a text-only API. Does NOT support vision or multipart content.
// The serializer (providers-serializers.ts) marks Agnes with
// supportsVision=false, supportsMultipartContent=false.
// When an image is provided, it is silently dropped and only the text prompt
// is sent. Vision analysis for this provider comes from the tribunal's
// other vision-capable providers (Groq, z.ai, Gemini, OpenRouter).
//
// P1: Content serialization handled by providers-base/serializers.
//     The serializer sends plain string content (never array format).
// P20: Structured logging.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function AgnesProvider() {
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Agnes');

    // P7: Pass providerName for health-aware retries
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'Agnes',
        { signal }
      ),
      { providerName: 'Agnes' }
    );

    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'Agnes'), 'Agnes');
  };
}

module.exports = { AgnesProvider };
