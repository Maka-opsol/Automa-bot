'use strict';

// ─── GitHub GPT Provider ──────────────────────────────────────────────────
//
// Uses GitHub Models API (gpt-4o-mini). OpenAI-compatible with JSON mode support.
//
// P9: DISABLED by default until health check passes.
//     The registry filters this provider via isProviderDisabledByDefault().
//     Even if GITHUB_API_KEY is set, GitHub GPT will not be used unless explicitly
//     enabled via providers-config-loader or a health check re-enables it.
//
// P1: Content serialization handled by providers-base/serializers.
//     GitHub GPT supports response_format (JSON mode) per PROVIDER_CAPABILITIES.
// P20: Structured logging.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function GitHubGPTProvider() {
  const apiKey = process.env.GITHUB_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('GitHub GPT');

    // P9: GitHub GPT supports response_format (JSON mode) — serializer allows it
    // P7: Pass providerName for health-aware retries
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'GitHub GPT',
        { responseFormat: { type: 'json_object' }, signal }
      ),
      { providerName: 'GitHub GPT' }
    );

    if (options.validate === false) return rawContent;
    return validateActionResponse(extractJSON(rawContent, 'GitHub GPT'), 'GitHub GPT');
  };
}

module.exports = { GitHubGPTProvider };
