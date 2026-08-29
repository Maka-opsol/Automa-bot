'use strict';

// ─── Agnes Provider ─────────────────────────────────────────────────────────
//
// Agnes supports vision (all providers are now vision-capable).
// The serializer (providers-serializers.ts) marks Agnes with
// supportsVision=true, supportsMultipartContent=true.
//
// P1: Content serialization handled by providers-base/serializers.
// P20: Structured logging.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function AgnesProvider() {
  const apiKey = process.env.AGNES_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Agnes');

    // P7: Pass providerName for health-aware retries
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'Agnes',
        { signal }
      ),
      { providerName: 'Agnes', signal, maxRetries: options.maxRetries }
    );

    if (options.validate === false) return rawContent;
    const parsed = extractJSON(rawContent, 'Agnes');
    // Tolerate missing fields rather than discarding the response.
    if (!parsed || typeof parsed !== 'object') {
      return { actionType: 'wait', currentState: 'unknown', reasoning: 'Agnes returned non-object response' };
    }
    if (!parsed.actionType || typeof parsed.actionType !== 'string') {
      parsed.actionType = 'wait';
    }
    if (!parsed.currentState || typeof parsed.currentState !== 'string') {
      parsed.currentState = 'unknown';
    }
    return validateActionResponse(parsed, 'Agnes');
  };
}

module.exports = { AgnesProvider };
