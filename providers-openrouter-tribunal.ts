'use strict';

const { extractJSON, validateActionResponse, callChatCompletion, getProviderConfig, retryWithBackoff } = require('./providers-base');

function OpenRouterTribunalProvider() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;
  // Use a known free vision model. Fallback chain:
  // 1. google/gemma-3-27b-it:free — excellent vision, free tier
  // 2. qwen/qwen3-0.6b:free (not vision, but text fallback)
  const model = process.env.OPENROUTER_TRIBUNAL_MODEL || 'google/gemma-3-27b-it:free';
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    // Try the configured model first, then fallback
    const models = [
      model,
      'google/gemma-3-27b-it:free',
      'meta-llama/llama-4-scout-17b-16e-instruct:free',
    ];
    let lastErr: any = null;
    for (const m of models) {
      try {
        const rawContent = await retryWithBackoff(() =>
          callChatCompletion(endpoint, apiKey, m, base64Image, prompt, 'OpenRouter', {
            signal,
            maxRetries: 1,
            baseDelay: 1000,
          })
        );
        if (options.validate === false) return rawContent;
        return validateActionResponse(extractJSON(rawContent, 'OpenRouter'), 'OpenRouter');
      } catch (err: any) {
        lastErr = err;
        // If the model doesn't exist or doesn't support image, try next
        if (err.message && (err.message.includes('404') || err.message.includes('image') || err.message.includes('does not exist'))) {
          continue;
        }
        throw err;
      }
    }
    throw lastErr;
  };
}

module.exports = { OpenRouterTribunalProvider };
