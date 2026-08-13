'use strict';

// ─── Cerebras Provider (SDK-based) ─────────────────────────────────────────
//
// Uses @cerebras/cerebras_cloud_sdk instead of raw HTTP API.
// The raw HTTP endpoint returned 402 (payment required), but the SDK
// with free-tier API keys works for supported models.
//
// Models: gemma-4-31b (primary, vision), zai-glm-4.7, gpt-oss-120b (fallbacks, may be text-only)
//
// P7: providerName passed to retryWithBackoff for health-aware retries.
// P20: Structured error logging.

const { extractJSON, validateActionResponse, getProviderConfig, retryWithBackoff } = require('./providers-base');

// Lazy logger
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

let _client: any = null;
let _sdkLoadFailed = false;

function _getClient() {
  if (_sdkLoadFailed) return null;
  if (_client) return _client;
  try {
    // Try named export first, then default
    const mod = require('@cerebras/cerebras_cloud_sdk');
    const Cerebras = mod.Cerebras || mod.default || mod;
    _client = new Cerebras({ apiKey: process.env.CEREBRAS_API_KEY });
    return _client;
  } catch (e: any) {
    _getLogger().log(`Cerebras SDK not available: ${e.message}`, 'WARN', 'cerebras');
    _sdkLoadFailed = true;
    return null;
  }
}

function CerebrasProvider() {
  const apiKey = process.env.CEREBRAS_API_KEY;
  if (!apiKey) return null;

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const client = _getClient();
    if (!client) {
      throw new Error('Cerebras SDK not installed - run: npm install @cerebras/cerebras_cloud_sdk');
    }

    const config = getProviderConfig('Cerebras');
    const log = _getLogger().log;

    const makeRequest = async () => {
      // Build user content - multipart with image if available, plain string otherwise
      const userContent = base64Image
        ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          ]
        : prompt;

      const response = await client.chat.completions.create({
        model: config.model || 'gemma-4-31b',
        messages: [{ role: 'user', content: userContent }],
        max_tokens: 4096,
        temperature: 0.1,
      });

      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('CEREBRAS_EMPTY_RESPONSE');
      }
      const content = response.choices[0].message.content;
      try { require('./providers-base').storeRawResponse('Cerebras', content, JSON.stringify(response), config.model || 'gemma-4-31b'); } catch {}
      return content;
    };

    // P7: Pass providerName for health-aware retries
    try {
      const rawContent = await retryWithBackoff(makeRequest, { providerName: 'Cerebras' });
      if (options.validate === false) return rawContent;
      return validateActionResponse(extractJSON(rawContent, 'Cerebras'), 'Cerebras');
    } catch (err: any) {
      // Attempt rollback on model-not-found or payment errors
      if (err.message && (
        err.message.includes('model_not_found') ||
        err.message.includes('404') ||
        err.message.includes('402') ||
        err.message.includes('payment')
      )) {
        try {
          const { rollbackProvider } = require('./providers-config-loader');
          log(`Cerebras model error (${err.message}) - attempting rollback...`, 'WARN', 'cerebras');
          const rolledBack = rollbackProvider('Cerebras');
          if (rolledBack) {
            log('Rolled back Cerebras model config.', 'INFO', 'cerebras');
            const rawContent = await retryWithBackoff(makeRequest, { providerName: 'Cerebras' });
            if (options.validate === false) return rawContent;
            return validateActionResponse(extractJSON(rawContent, 'Cerebras'), 'Cerebras');
          }
        } catch (rollbackErr: any) {
          log(`Cerebras rollback failed: ${rollbackErr.message || rollbackErr}`, 'WARN', 'cerebras');
        }
      }
      throw err;
    }
  };
}

module.exports = { CerebrasProvider };
