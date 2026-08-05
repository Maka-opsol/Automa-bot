'use strict';
// Created: 2026-08-05 — Response 20: New DeepInfra provider for free Qwen2.5-VL vision models

// ─── DeepInfra Provider ─────────────────────────────────────────────────────
//
// DeepInfra offers free vision models (Qwen2.5-VL, Llama Vision) with an
// OpenAI-compatible API. Vision models accept standard multipart content
// format: content: [{type:"text",...},{type:"image_url",...}]
//
// Free tier: token budget (hundreds of thousands tokens/month)
// Endpoint: https://api.deepinfra.com/v1/openai/chat/completions
// Docs: https://docs.deepinfra.com/chat/vision

const { callChatCompletionWithRollback, extractJSON, validateActionResponse, retryWithBackoff } = require('./providers-base');

function DeepInfraProvider() {
  const apiKey = process.env.DEEPINFRA_API_KEY;
  if (!apiKey) {
    return null;
  }

  const model = process.env.DEEPINFRA_MODEL || 'Qwen/Qwen2.5-VL-7B-Instruct';
  const endpoint = 'https://api.deepinfra.com/v1/openai/chat/completions';

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(endpoint, apiKey, model, base64Image, prompt, 'DeepInfra', { signal }),
      { providerName: 'DeepInfra', maxRetries: 2, baseDelay: 1000 }
    );

    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'DeepInfra'), 'DeepInfra');
  };
}

module.exports = { DeepInfraProvider };
