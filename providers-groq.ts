'use strict';

// ─── Groq Provider ─────────────────────────────────────────────────────────
//
// Groq uses the Llama 3.3 70B model (deepseek-r1-distill-llama-70b as fallback).
// OpenAI-compatible API with vision support (llama-3.2-11b-vision-instruct).
// Does NOT reliably support response_format, so it's not passed.
//
// P1: Content serialization is handled by providers-base (via providers-serializers).
//     The serializer knows Groq supports multipart content for vision requests.
// P9: Not disabled — Groq is a primary provider.
// P20: Structured logging via providers-base.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function GroqProvider() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Groq');

    // P7: Pass providerName for health-aware retries
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'Groq',
        { signal }
      ),
      { providerName: 'Groq' }
    );

    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'Groq'), 'Groq');
  };
}

module.exports = { GroqProvider };
