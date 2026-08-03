'use strict';

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function ZAIProvider() { 
  const apiKey = process.env.ZAI_API_KEY;
  if (!apiKey) return null;
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('z.ai');
    const rawContent = await retryWithBackoff(() =>
      callChatCompletionWithRollback(config.endpoint, apiKey, config.model, base64Image, prompt, 'z.ai', { signal })
    );
    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'z.ai'), 'z.ai');
  };
}

module.exports = { ZAIProvider };
