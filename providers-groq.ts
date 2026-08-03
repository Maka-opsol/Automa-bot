'use strict';

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function GroqProvider() { 
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Groq');
    const rawContent = await retryWithBackoff(() =>
      callChatCompletionWithRollback(config.endpoint, apiKey, config.model, base64Image, prompt, 'Groq', { signal })
    );
    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'Groq'), 'Groq');
  };
}

module.exports = { GroqProvider };
