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

// ─── TASK 91 (2026-09-26): Vision Model Detection ──────────────────────
//
// Groq models that support vision (multimodal image input).
// These accept content arrays: [{type:'text',...}, {type:'image_url',...}]
//
// Known vision-capable Groq models (as of 2026-09):
//   - llama-3.2-90b-vision-preview
//   - llama-3.2-11b-vision-preview
//   - Any model with "vision" in the ID
//
// Text-only models (llama-3.3-70b-versatile, llama-3.1-8b-instant, etc.)
// only accept string content. They CANNOT process screenshots.
//
// The bot needs vision models to analyze MathU screenshots. During a
// provider drought, Groq vision models are critical — so we prioritize
// them over text-only models.

function _isVisionModel(modelId: string): boolean {
    if (!modelId || typeof modelId !== 'string') return false;
    const lower = modelId.toLowerCase();

    // 1. Explicit keyword / infix check — "vision" in the name is the most reliable indicator
    if (lower.includes('vision')) return true;

    // 2. LLaVA variants are always vision-capable
    if (lower.includes('llava')) return true;

    // 3. Known explicit prefixes and model names (including vendor namespaces like meta-llama/)
    // TASK 96 (2026-09-29): Removed broad 'qwen' match — not all Qwen models support vision.
    // Only Qwen-VL (Vision-Language) variants do. The old code matched ALL qwen models,
    // causing text-only models like qwen/qwen3.8-27b to be incorrectly identified as
    // vision-capable, resulting in 400 "content must be a string" errors.
    const knownVisionPrefixes = [
        'llama-4-scout',
        'llama-4-maverick',
        'llama-3.2-11b-vision',     // Only vision variants
        'llama-3.2-90b-vision',     // Only vision variants
        'qwen-vl',                   // Qwen Vision-Language variants
        'qwen2-vl',
        'qwen/qwen2-vl',
        'qwen/qwen-vl',
        'meta-llama/llama-4-scout',
    ];

    return knownVisionPrefixes.some(m => lower.includes(m));
}

/**
 * List all available Groq models using the SDK.
 * Returns a list of model IDs, sorted with VISION models first.
 * Cached for 30 minutes to avoid hitting the API on every call.
 *
 * TASK 91 (2026-09-26): Vision models are prioritized over text-only
 * models. The bot needs vision to analyze MathU screenshots — without
 * it, Groq is useless for the tribunal.
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
    return _cachedModels || ['llama-3.2-90b-vision-preview'];
  }

  try {
    log('Fetching available Groq models via SDK...', 'DEBUG', 'groq');
    const modelsList = await client.models.list();

    // Extract model IDs
    const allModels: string[] = [];
    if (modelsList && typeof modelsList[Symbol.iterator] === 'function') {
      for await (const page of modelsList) {
        if (Array.isArray(page?.data)) {
          for (const model of page.data) {
            if (model?.id) allModels.push(model.id);
          }
        }
      }
    } else if (Array.isArray(modelsList?.data)) {
      for (const model of modelsList.data) {
        if (model?.id) allModels.push(model.id);
      }
    } else if (Array.isArray(modelsList)) {
      for (const model of modelsList) {
        if (typeof model === 'string') allModels.push(model);
        else if (model?.id) allModels.push(model.id);
      }
    }

    if (allModels.length === 0) {
      log('Groq models.list() returned no models — using fallback', 'WARN', 'groq');
      return _cachedModels || ['llama-3.2-90b-vision-preview'];
    }

    // TASK 91: Sort with VISION models first, then text-only.
    // Within vision models, prefer larger context / newer models.
    const preferredOrder = (a: string, b: string) => {
      const aVision = _isVisionModel(a);
      const bVision = _isVisionModel(b);

      // Vision models ALWAYS come first
      if (aVision && !bVision) return -1;
      if (!aVision && bVision) return 1;

      // Within the same category, prefer larger models (90b > 11b)
      const aSize = parseInt(a.match(/(\d+)b/i)?.[1] || '0', 10);
      const bSize = parseInt(b.match(/(\d+)b/i)?.[1] || '0', 10);
      if (aSize !== bSize) return bSize - aSize; // larger first

      // Alphabetical for same-size models
      return a.localeCompare(b);
    };

    allModels.sort(preferredOrder);

    _cachedModels = allModels;
    _modelsCacheTime = Date.now();

    // Log vision vs text-only breakdown
    const visionModels = allModels.filter(_isVisionModel);
    const textModels = allModels.filter(m => !_isVisionModel(m));
    log(`Groq models fetched: ${allModels.length} total (${visionModels.length} vision, ${textModels.length} text-only). Vision: [${visionModels.slice(0, 5).join(', ')}]`, 'INFO', 'groq');

    return allModels;
  } catch (e: any) {
    log(`Groq models.list() failed: ${e.message || e}`, 'WARN', 'groq');
    return _cachedModels || ['llama-3.2-90b-vision-preview'];
  }
}

/**
 * Get the best available Groq VISION model.
 * Uses listAvailableModels() and picks the first vision-capable model.
 * Only falls back to text-only if NO vision models are available.
 */
async function getBestModel(): Promise<string> {
  const models = await listAvailableModels();

  // Find the first vision-capable model
  const visionModel = models.find(_isVisionModel);
  if (visionModel) {
    return visionModel;
  }

  // No vision models available — use the first text-only model
  // (will automatically use text-only mode in makeRequest)
  return models[0] || 'llama-3.2-90b-vision-preview';
}

/**
 * Check if a model supports vision (image input).
 * Used by makeRequest() to decide whether to send content as array or string.
 */
function isVisionCapable(modelId: string): boolean {
  return _isVisionModel(modelId);
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

      // TASK 91 (2026-09-26): Check if the model supports vision.
      // If it's a text-only model, send just the prompt as a string
      // (no image array) — prevents the 400 "content must be a string" error.
      const modelSupportsVision = isVisionCapable(model);

      // Groq SDK (OpenAI-compatible): pass signal via RequestOptions (2nd arg),
      // NOT as abortSignal in the request body — the SDK rejects that with 400.
      const body: any = {
        model,
        messages: [{ role: 'user', content: modelSupportsVision ? userContent : prompt }],
        max_tokens: 4096,
        temperature: 0.1,
      };
      const requestOptions: any = signal ? { signal } : undefined;

      if (!modelSupportsVision && base64Image) {
        log(`Groq: model ${model} is text-only — sending prompt without screenshot`, 'DEBUG', 'groq');
      }

      try {
        const response = await client.chat.completions.create(body, requestOptions);

        if (!response?.choices?.[0]?.message?.content) {
          throw new Error('GROQ_EMPTY_RESPONSE');
        }
        const content = response.choices[0].message.content;
        try { require('./providers-base').storeRawResponse('Groq', content, JSON.stringify(response), body.model); } catch {}
        return content;
      } catch (err: any) {
        const errMsg = String(err?.message || err || '');

        // TASK 93 (2026-09-27): Handle context_length_exceeded error.
        // Vision models (llama-3.2-90b-vision-preview) have smaller context
        // windows than text models. The prompt + base64 screenshot can exceed
        // the limit. Fix: retry with a smaller screenshot and reduced max_tokens.
        if (errMsg.includes('context_length_exceeded') || errMsg.includes('reduce the length')) {
          log(`Groq: model ${body.model} context_length_exceeded — retrying with smaller image + reduced tokens`, 'WARN', 'groq');

          // Retry with: smaller image (re-compress to 384px/q5) + fewer max_tokens
          let smallerContent = prompt;
          if (modelSupportsVision && base64Image) {
            try {
              // Re-compress the screenshot to a smaller size
              const sharp = require('sharp');
              const buf = Buffer.from(base64Image, 'base64');
              const smallerBuf = await sharp(buf)
                .resize(384, null, { fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 5 })
                .toBuffer();
              const smallerBase64 = smallerBuf.toString('base64');
              smallerContent = [
                { type: 'text', text: prompt },
                { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${smallerBase64}` } },
              ] as any;
              log(`Groq: re-compressed screenshot to 384px/q5 (${smallerBase64.length} chars) for context_length retry`, 'DEBUG', 'groq');
            } catch (compressErr: any) {
              log(`Groq: screenshot re-compression failed: ${compressErr.message} — falling back to text-only`, 'WARN', 'groq');
              smallerContent = prompt; // text-only fallback
            }
          }

          const retryBody: any = {
            model: body.model,
            messages: [{ role: 'user', content: smallerContent }],
            max_tokens: 2048, // reduced from 4096
            temperature: 0.1,
          };
          const response = await client.chat.completions.create(retryBody, requestOptions);
          if (!response?.choices?.[0]?.message?.content) {
            throw new Error('GROQ_EMPTY_RESPONSE');
          }
          const content = response.choices[0].message.content;
          try { require('./providers-base').storeRawResponse('Groq', content, JSON.stringify(response), body.model); } catch {}
          return content;
        }

        // TASK 90: Handle "messages[0].content must be a string" error.
        // This is a FALLBACK — normally we detect text-only models proactively
        // (Task 91). But if a model is misidentified as vision-capable, the
        // API will still reject the array content. Catch it and retry text-only.
        if (errMsg.includes('messages[0].content must be a string')) {
          log(`Groq: model ${body.model} rejected vision content (unexpected) — retrying text-only`, 'WARN', 'groq');
          const textOnlyBody: any = {
            model: body.model,
            messages: [{ role: 'user', content: prompt }], // string, not array
            max_tokens: 4096,
            temperature: 0.1,
          };
          const response = await client.chat.completions.create(textOnlyBody, requestOptions);
          if (!response?.choices?.[0]?.message?.content) {
            throw new Error('GROQ_EMPTY_RESPONSE');
          }
          const content = response.choices[0].message.content;
          try { require('./providers-base').storeRawResponse('Groq', content, JSON.stringify(response), body.model); } catch {}
          return content;
        }
        throw err;
      }
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

module.exports = { GroqProvider, listAvailableModels, getBestModel, isVisionCapable };
