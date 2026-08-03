'use strict';

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function GitHubGPTProvider() { 
  const apiKey = process.env.GITHUB_API_KEY;
  if (!apiKey) return null;
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('GitHub GPT');
    const rawContent = await retryWithBackoff(() =>
      callChatCompletionWithRollback(config.endpoint, apiKey, config.model, base64Image, prompt, 'GitHub GPT', { responseFormat: { type: 'json_object' }, signal })
    );
    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'GitHub GPT'), 'GitHub GPT');
  };
}

module.exports = { GitHubGPTProvider };
