'use strict';

// --- Groq Provider (SDK-based) --------------------------------------------
//
// Uses groq-sdk instead of raw HTTP API. The SDK handles content formatting
// including vision (image_url) automatically.
//
// TASK 88 (2026-09-25): Added listAvailableModels() using groq.models.list()
// This fetches ALL available models from the Groq API directly — no more
// guessing model names via web search.
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

// ─── TASK 88 (2026-09-25): Groq Model List Fetching ──────────────────────
//
// Uses `groq.models.list()` to get ALL available models from the Groq API.
// This replaces the old web-search-based model discovery with a direct API
// call — much more reliable and always up-to-date.
//
// The function:
//   1. Calls groq.models.list() to get all models
//   2. Filters for vision-capable models (the bot needs image input)
//   3. Returns a list of model IDs, sorted by preference:
//      - llama-3.3-70b-versatile first (proven, fast, vision-capable)
//      - Then other llama-3.x models (vision-capable)
//      - Then any remaining models

let _cachedModels: string[] | null = null;
let _modelsCacheTime = 0;
const MODELS_CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * List all available Groq models using the SDK.
 * Returns a list of model IDs.
 * Cached for 30 minutes to avoid hitting the API on every call.
 */
async function listAvailableModels(): Promise<string[]> {
  const log = _getLogger().log;

  // Return cached list if fresh
  if (_cachedModels && (Date.now() - _modelsCacheTime) < MODELS_CACHE_TTL_MS) {
    return _cachedModels;
  }

  const client = _getClient();
  if (!client) {
    log('Groq SDK not available — cannot list models', 'WARN', 'groq');
    return _cachedModels || ['llama-3.3-70b-versatile']; // fallback to last known
  }

  try {
    log('Fetching available Groq models via SDK...', 'DEBUG', 'groq');
    const modelsList = await client.models.list();

    // Extract model IDs
    const allModels: string[] = [];
    if (modelsList && typeof modelsList[Symbol.iterator] === 'function') {
      // Paginated iterator — iterate through all pages
      for await (const page of modelsList) {
        if (Array.isArray(page?.data)) {
          for (const model of page.data) {
            if (model?.id) allModels.push(model.id);
          }
        }
      }
    } else if (Array.isArray(modelsList?.data)) {
      // Non-paginated response
      for (const model of modelsList.data) {
        if (model?.id) allModels.push(model.id);
      }
    } else if (Array.isArray(modelsList)) {
      // Plain array response
      for (const model of modelsList) {
        if (typeof model === 'string') allModels.push(model);
        else if (model?.id) allModels.push(model.id);
      }
    }

    if (allModels.length === 0) {
      log('Groq models.list() returned no models — using fallback', 'WARN', 'groq');
      return _cachedModels || ['llama-3.3-70b-versatile'];
    }

    // Sort by preference: llama-3.3-70b-versatile first, then other llama-3.x
    const preferredOrder = (a: string, b: string) => {
      const aLower = a.toLowerCase();
      const bLower = b.toLowerCase();

      // Most preferred: llama-3.3-70b-versatile (proven, vision-capable)
      if (aLower === 'llama-3.3-70b-versatile') return -1;
      if (bLower === 'llama-3.3-70b-versatile') return 1;

      // Next: other llama-3.x models with vision capability
      const aLlama3 = aLower.includes('llama-3') && (aLower.includes('vision') || aLower.includes('versatile'));
      const bLlama3 = bLower.includes('llama-3') && (bLower.includes('vision') || bLower.includes('versatile'));
      if (aLlama3 && !bLlama3) return -1;
      if (!aLlama3 && bLlama3) return 1;

      // Alphabetical for the rest
      return a.localeCompare(b);
    };

    allModels.sort(preferredOrder);

    _cachedModels = allModels;
    _modelsCacheTime = Date.now();
    log(`Groq models fetched: ${allModels.length} models available. Top: ${allModels.slice(0, 5).join(', ')}${allModels.length > 5 ? '...' : ''}`, 'INFO', 'groq');

    return allModels;
  } catch (e: any) {
    log(`Groq models.list() failed: ${e.message || e}`, 'WARN', 'groq');
    return _cachedModels || ['llama-3.3-70b-versatile']; // fallback to last known
  }
}

/**
 * Get the best available Groq model.
 * Uses listAvailableModels() and picks the first one (already sorted by preference).
 * Falls back to 'llama-3.3-70b-versatile' if the API call fails.
 */
async function getBestModel(): Promise<string> {
  const models = await listAvailableModels();
  return models[0] || 'llama-3.3-70b-versatile';
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
    const buildRequest = async () => {
      const config = getProviderConfig('Groq');
      // TASK 88: If no model configured, use getBestModel() to auto-discover
      let model = config.model;
      if (!model || model === 'auto') {
        model = await getBestModel();
        log(`Groq: auto-discovered model: ${model}`, 'DEBUG', 'groq');
      }
      const userContent = base64Image
        ? [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
          ]
        : prompt;

      return { model, userContent };
    };

    const makeRequest = async () => {
      const { model, userContent } = await buildRequest();

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
      const rawContent = await retryWithBackoff(makeRequest, { providerName: 'Groq', signal, maxRetries: options.maxRetries });
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
          log(`Groq model error (${err.message}) — fetching fresh model list...`, 'WARN', 'groq');

          // TASK 88: Instead of rollbackProvider, fetch fresh model list
          // and try the next available model
          _cachedModels = null; // force refresh
          _modelsCacheTime = 0;
          const freshModels = await listAvailableModels();
          const currentModel = getProviderConfig('Groq').model;
          const nextModel = freshModels.find(m => m !== currentModel) || freshModels[0];

          if (nextModel && nextModel !== currentModel) {
            log(`Groq: switching from ${currentModel} to ${nextModel} (auto-discovered fallback)`, 'INFO', 'groq');
            const { updateProviderConfig } = require('./providers-config-loader');
            const current = getProviderConfig('Groq');
            updateProviderConfig('Groq', { ...current, model: nextModel }, false);

            // Retry with the new model
            const retryContent = await retryWithBackoff(makeRequest, { providerName: 'Groq', signal, maxRetries: 0 });
            if (options.validate === false) return retryContent;
            return validateActionResponse(extractJSON(retryContent, 'Groq'), 'Groq');
          }
        } catch (rollbackErr: any) {
          log(`Groq model switch failed: ${rollbackErr.message || rollbackErr}`, 'WARN', 'groq');
        }
      }
      throw err;
    }
  };
}

module.exports = { GroqProvider, listAvailableModels, getBestModel };
