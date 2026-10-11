'use strict';

// ─── NVIDIA Provider ──────────────────────────────────────────────────────────
//
// Uses NVIDIA NIM API with meta/llama-3.3-70b-instruct (free tier).
// OpenAI-compatible API. Supports vision (all providers now vision-capable).
// Does NOT reliably support response_format on free tier.
//
// P1: Content serialization handled by providers-base/serializers.
//     responseFormat is NOT passed - PROVIDER_CAPABILITIES.supportsResponseFormat=false.
// P7: providerName passed to retryWithBackoff for health-aware retries.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

function NvidiaProvider() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('NVIDIA');

    // P1 FIX: Do NOT pass responseFormat - NVIDIA free tier doesn't support it.
    // The serializer (providers-serializers.ts) also strips it via
    // supportsResponseFormat=false, but not passing it at all is cleaner.
    // P7: Pass providerName for health-aware retries
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'NVIDIA',
        { signal }
      ),
      { providerName: 'NVIDIA', signal, maxRetries: options.maxRetries }
    );

    if (options.validate === false) return rawContent;
    // TASK 117 (2026-10-11): NVIDIA's llama-3.2-11b-vision-instruct model
    // sometimes returns plain text instead of JSON. The extractJSON function
    // fails with "no JSON object found." Try to extract JSON from the text
    // response before giving up.
    let parsed = extractJSON(rawContent, 'NVIDIA');
    if (!parsed) {
      // The response was plain text, not JSON. NVIDIA models sometimes
      // return markdown/explanation instead of structured JSON.
      // Try to find a JSON block in the text.
      const jsonMatch = rawContent.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch[0]);
        } catch {}
      }
      if (!parsed) {
        // No JSON found. Return a structured action based on the text response.
        // The model is describing what it sees — convert it to a "wait" action
        // so the tribunal can try other providers.
        const log = require('./logger').log;
        log(`NVIDIA: no JSON in response, returning wait. Preview: ${rawContent.substring(0, 100)}`, 'WARN', 'nvidia');
        return { actionType: 'wait', currentState: 'unknown', reasoning: `NVIDIA text response (no JSON): ${rawContent.substring(0, 200)}`, targetX: 0, targetY: 0 };
      }
    }
    return validateActionResponse(parsed, 'NVIDIA');
  };
}

module.exports = { NvidiaProvider };
