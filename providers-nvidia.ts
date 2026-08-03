'use strict';

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function NvidiaProvider() { 
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) return null;
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('NVIDIA');
    const rawContent = await retryWithBackoff(() =>
      callChatCompletionWithRollback(config.endpoint, apiKey, config.model, base64Image, prompt, 'NVIDIA', { responseFormat: { type: 'json_object' }, signal })
    );
    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'NVIDIA'), 'NVIDIA');
  };
}

module.exports = { NvidiaProvider };
