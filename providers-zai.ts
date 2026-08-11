'use strict';

// ─── Z.AI Provider ─────────────────────────────────────────────────────────
//
// Uses Z.AI's GLM-4.6V-Flash vision model. OpenAI-compatible API.
// Supports vision (multimodal) and system role.
// Does NOT support response_format.
//
// P1: Content serialization handled by providers-base/serializers.
//     The serializer knows z.ai supports multipart content for vision.
// P20: Structured logging.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function ZAIProvider() {
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('z.ai');

    // P7: Pass providerName for health-aware retries
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'z.ai',
        { signal }
      ),
      { providerName: 'z.ai', signal }
    );

    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'z.ai'), 'z.ai');
  };
}

module.exports = { ZAIProvider };
