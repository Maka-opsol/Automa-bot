'use strict';

// --- Groq Provider (SDK-based) --------------------------------------------
//
// Uses groq-sdk instead of raw HTTP API. The SDK handles content formatting
// including vision (image_url) automatically.
//
// Primary model: qwen/qwen3.6-27b (vision-capable qwen model on Groq).
//
// P7: providerName passed to retryWithBackoff for health-aware retries.
// P20: Structured error logging.
// FIX: Signal now passed via RequestOptions (second arg to create()),
// not as abortSignal in the body — Groq SDK doesn't support abortSignal.

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
    const GroqSDK = require('groq-sdk');
    const Groq = GroqSDK.default || GroqSDK.Groq || GroqSDK;
    _client = new Groq({ apiKey: process.env.GROQ_API_KEY });
    return _client;
  } catch (e: any) {
    _getLogger().log(`Groq SDK not available: ${e.message}`, 'WARN', 'groq');
    _sdkLoadFailed = true;
    return null;
  }
}

function GroqProvider() {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return null;

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const client = _getClient();
    if (!client) {
      throw new Error('Groq SDK not installed - run: npm install groq-sdk');
    }

    const log = _getLogger().log;

    // FIX: Build request factory that reads config fresh each call.
    // This prevents stale closure after rollbackProvider().
    const buildRequest = () => {
      const config = getProviderConfig('Groq');
      const model = config.model || 'qwen/qwen3.6-27b';
      const userContent = base64Image
        ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          ]
        : prompt;

      return { model, userContent };
    };

    const makeRequest = async () => {
      const { model, userContent } = buildRequest();

      // Groq SDK (OpenAI-compatible): pass signal via RequestOptions (2nd arg),
      // NOT as abortSignal in the request body — the SDK rejects that with 400.
      const body: any = {
        model,
        messages: [{ role: 'user', content: userContent }],
        max_tokens: 4096,
        temperature: 0.1,
      };
      const requestOptions: any = signal ? { signal } : undefined;

      const response = await client.chat.completions.create(body, requestOptions);

      if (!response?.choices?.[0]?.message?.content) {
        throw new Error('GROQ_EMPTY_RESPONSE');
      }
      const content = response.choices[0].message.content;
      try { require('./providers-base').storeRawResponse('Groq', content, JSON.stringify(response), body.model); } catch {}
      return content;
    };

    // P7: Pass providerName for health-aware retries
    try {
      const rawContent = await retryWithBackoff(makeRequest, { providerName: 'Groq', signal });
      if (options.validate === false) return rawContent;
      return validateActionResponse(extractJSON(rawContent, 'Groq'), 'Groq');
    } catch (err: any) {
      // Attempt rollback on model-not-found errors
      if (err.message && (
        err.message.includes('model_not_found') ||
        err.message.includes('does not exist') ||
        err.message.includes('404')
      )) {
        try {
          const { rollbackProvider } = require('./providers-config-loader');
          log(`Groq model error (${err.message}) - attempting rollback...`, 'WARN', 'groq');
          const rolledBack = rollbackProvider('Groq');
          if (rolledBack) {
            log('Rolled back Groq model config.', 'INFO', 'groq');
            // FIX: Rebuild makeRequest after rollback to pick up new config.
            // buildRequest() reads config fresh, so the new model is used.
            const retryContent = await retryWithBackoff(makeRequest, { providerName: 'Groq', signal });
            if (options.validate === false) return retryContent;
            return validateActionResponse(extractJSON(retryContent, 'Groq'), 'Groq');
          }
        } catch (rollbackErr: any) {
          log(`Groq rollback failed: ${rollbackErr.message || rollbackErr}`, 'WARN', 'groq');
        }
      }
      throw err;
    }
  };
}

module.exports = { GroqProvider };
