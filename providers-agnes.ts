'use strict';

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function AgnesProvider() { 
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) return null;
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Agnes');
    const rawContent = await retryWithBackoff(() =>
      callChatCompletionWithRollback(config.endpoint, apiKey, config.model, base64Image, prompt, 'Agnes', { signal })
    );
    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'Agnes'), 'Agnes');
  };
}

module.exports = { AgnesProvider };
