'use strict';

// ─── Cloudflare Workers AI Provider (v3) ────────────────────────────────────
//
// Uses Cloudflare Workers AI API (/accounts/{id}/ai/run/{model}).
// This is NOT an OpenAI-compatible API — it has its own URL structure
// and response format, so it cannot use callChatCompletionWithRollback.
//
// Supports:
//   - System messages (via `messages` array with `system` role)
//   - Vision (multimodal): all models support image input
//   - Model cascade (like Gemini): tries primary model, then fallbacks
//   - Per-model cooldown tracking for 429 rate limits
//
// Current primary model: @cf/meta/llama-4-scout-17b-16e-instruct
// Fallback chain: moondream3.1 → kimi-k2.6 → gemma-4-26b → kimi-k2.5 → llama-3.2-11b-vision
//
// Vision: All 6 models are vision-capable. Images are sent as multimodal
// content parts in the user message (type: "image_url" + type: "text").
//
// P7: providerName passed to retryWithBackoff for health-aware retries.
// P20: Structured error logging.

const { fetchWithTimeout, extractJSON, validateActionResponse, sanitizeErrorText, getProviderConfig, retryWithBackoff, getFallbackModels } = require('./providers-base');
const { log } = require('./logger');

// Lazy CONFIG proxy (avoids frozen config caching bug)
const CONFIG: any = new Proxy({}, { get: (_, prop) => {
  try { return require('./get-config')[prop]; } catch { return undefined; }
}});

// ─── Per-model cooldown tracker ────────────────────────────────────────────
// When a model hits 429, we record a cooldown so we skip it on the next call
// until the cooldown expires. This prevents wasting time retrying a model
// that we know is still rate-limited.

const _modelCooldowns: Record<string, { expiresAt: number; consecutive429s: number }> = {};

/**
 * Get the full ordered list of models to try (primary + fallbacks).
 */
function _getModelChain(): string[] {
  const config = getProviderConfig('Cloudflare');
  const primary = config?.model || '@cf/meta/llama-4-scout-17b-16e-instruct';
  const fallbacks = getFallbackModels('Cloudflare');
  // Deduplicate while preserving order
  const seen = new Set<string>();
  const chain: string[] = [];
  for (const m of [primary, ...fallbacks]) {
    if (!seen.has(m)) {
      seen.add(m);
      chain.push(m);
    }
  }
  return chain;
}

/**
 * Record a 429 for a model, escalating the cooldown.
 * Escalation: 30s → 60s → 120s → 240s (max 4 min).
 */
function _recordModel429(model: string): void {
  const now = Date.now();
  const existing = _modelCooldowns[model];
  const prevCount = existing ? existing.consecutive429s : 0;
  const newCount = prevCount + 1;

  // Escalating cooldown: 30s × 2^min(count-1, 3)
  const cooldownSecs = 30 * Math.pow(2, Math.min(newCount - 1, 3));
  _modelCooldowns[model] = {
    expiresAt: now + cooldownSecs * 1000,
    consecutive429s: newCount,
  };

  log(`Cloudflare model ${model} hit 429 (#${newCount}), cooldown ${cooldownSecs}s`, 'WARN', 'cloudflare');
}

/**
 * Clear 429 count for a model (called on successful call).
 */
function _clearModel429(model: string): void {
  if (_modelCooldowns[model]) {
    _modelCooldowns[model].consecutive429s = 0;
    delete _modelCooldowns[model];
  }
}

/**
 * Check if an error is a 429/rate-limit.
 */
function _isRateLimitError(err: any): boolean {
  const msg = err?.message || '';
  return msg.includes('HTTP_ERROR_429') || msg.includes('Rate limited');
}

function CloudflareProvider() {
  const apiKey = process.env.CF_API_KEY;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!apiKey || !accountId) return null;

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const modelChain = _getModelChain();

    // Try models in order until one succeeds or all fail
    for (const modelId of modelChain) {
      const cooldown = _modelCooldowns[modelId];
      const now = Date.now();
      if (cooldown && now < cooldown.expiresAt) {
        continue; // Skip this model — still on cooldown
      }

      try {
        const result = await _callWithModel(accountId, apiKey, modelId, base64Image, prompt, signal, options);
        // Success — clear any 429 record for this model
        _clearModel429(modelId);
        return result;
      } catch (err: any) {
        if (_isRateLimitError(err)) {
          _recordModel429(modelId);
          // Continue to next model in chain
          continue;
        }
        // Empty response — this model returned nothing useful, try next model
        // instead of retrying the same one (which would just waste time)
        if (err.message && err.message.includes('CLOUDFLARE_EMPTY_RESPONSE')) {
          log(`Cloudflare model ${modelId} returned empty response, trying next fallback`, 'WARN', 'cloudflare');
          continue;
        }
        // Non-429 error (401/403/404/500) — attempt rollback before giving up
        if (err.message && (
          err.message.includes('HTTP_ERROR_404') ||
          err.message.includes('HTTP_ERROR_401') ||
          err.message.includes('HTTP_ERROR_403')
        )) {
          try {
            const { rollbackProvider } = require('./providers-config-loader');
            log(`Cloudflare model ${modelId} returned config error (${err.message}) -- attempting rollback...`, 'WARN', 'cloudflare');
            const rolledBack = rollbackProvider('Cloudflare');
            if (rolledBack) {
              log(`Rolled back Cloudflare model config.`, 'INFO', 'cloudflare');
              const newConfig = getProviderConfig('Cloudflare');
              if (newConfig.model && newConfig.model !== modelId) {
                const retryResult = await _callWithModel(accountId, apiKey, newConfig.model, base64Image, prompt, signal, options);
                _clearModel429(newConfig.model);
                return retryResult;
              }
            }
          } catch (rollbackErr: any) {
            log(`Cloudflare rollback failed: ${rollbackErr.message || rollbackErr}`, 'WARN', 'cloudflare');
          }
        }
        // Model returned non-JSON / unparseable response — try next model in chain
        const parseErr = err?.message || '';
        if (parseErr.includes('No action returned') || parseErr.includes('missing actionType') || parseErr.includes('no JSON object found')) {
          log(`Cloudflare model ${modelId} returned invalid/unparseable response, trying next fallback`, 'WARN', 'cloudflare');
          continue;
        }
        // Non-recoverable error — don't try other models for auth/config errors
        throw err;
      }
    }

    // All models exhausted (all on cooldown)
    throw new Error('Cloudflare: All models rate-limited, waiting for cooldown');
  };
}

/**
 * Call a specific Cloudflare Workers AI model.
 * Uses the standard chat messages format with system + user roles.
 * Supports vision: sends base64 image as multimodal content part when available.
 */
async function _callWithModel(
  accountId: string,
  apiKey: string,
  modelId: string,
  base64Image: any,
  prompt: any,
  signal: any,
  options: any = {}
): Promise<any> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${modelId}`;

  // Build messages array with system prompt + user content
  // All current CF models support system role in messages
  const messages: Array<{ role: string; content: any }> = [];

  // Add system message for action guidance
  messages.push({
    role: 'system',
    content: 'You are a helpful assistant that analyzes screenshots and returns JSON action objects. Always respond with valid JSON only.',
  });

  // Build user message content — multimodal if image present, plain string otherwise
  const promptText = typeof prompt === 'string' ? prompt : String(prompt);
  if (base64Image && typeof base64Image === 'string' && base64Image.length > 0) {
    // Cloudflare Workers AI multimodal format: array of content parts
    // Image part uses image_url type (NOT 'image' — that's not a valid CF type)
    const imagePart = base64Image.startsWith('data:')
      ? base64Image
      : `data:image/png;base64,${base64Image}`;
    messages.push({
      role: 'user',
      content: [
        { type: 'image_url', image_url: { url: imagePart } },
        { type: 'text', text: promptText },
      ],
    });
  } else {
    messages.push({
      role: 'user',
      content: promptText,
    });
  }

  const payload = {
    messages,
    max_tokens: CONFIG.MAX_TOKENS || 4096,
    temperature: 0.0,
    stream: false,
  };

  const makeRequest = async () => {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal,
    });

    // Extract retry-after for rate limiting
    if (response.status === 429) {
      const retryAfter = response.headers.get('retry-after');
      const err: any = new Error('HTTP_ERROR_429: Rate limited');
      err.retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined;
      throw err;
    }

    if (!response.ok) {
      const errorText = sanitizeErrorText(await response.text().catch(() => 'Unknown error'));
      throw new Error(`HTTP_ERROR_${response.status}: ${errorText}`);
    }

    const data = await response.json();
    if (!data.success || !data.result) {
      // Some CF models return result as string, others as object
      if (data.result && typeof data.result === 'string') {
        return data.result;
      }
      throw new Error('CLOUDFLARE_EMPTY_RESPONSE');
    }

    // Handle different response shapes from CF models:
    // - Kimi: result.response (string)
    // - Llama models: result.response (string)
    // - Some models: result directly as string
    const responseText = data.result.response || (typeof data.result === 'string' ? data.result : null);
    if (!responseText) {
      throw new Error('CLOUDFLARE_EMPTY_RESPONSE');
    }
    return responseText;
  };

  const rawContent = await retryWithBackoff(makeRequest, { providerName: 'Cloudflare', signal });
  if (options.validate === false) return rawContent;
  return validateActionResponse(extractJSON(rawContent, 'Cloudflare'), 'Cloudflare');
}

module.exports = { CloudflareProvider, _getModelChain, _recordModel429, _clearModel429 };
