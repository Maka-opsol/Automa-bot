'use strict';

// ─── Cloudflare Workers AI Provider ──────────────────────────────────────────
//
// Uses Cloudflare Workers AI API (/accounts/{id}/ai/run/{model}).
// This is NOT an OpenAI-compatible API - it has its own URL structure
// and response format, so it cannot use callChatCompletionWithRollback.
//
// Cloudflare now supports vision (multipart content with image_url).
//
// Rollback logic: Uses callChatCompletionWithRollback's approach -
// on 401/403/404, attempts config rollback via providers-config-loader.
//
// P7: providerName passed to retryWithBackoff for health-aware retries.
// P20: Structured error logging.

const { fetchWithTimeout, extractJSON, validateActionResponse, sanitizeErrorText, getProviderConfig, retryWithBackoff } = require('./providers-base');
const { log } = require('./logger');
// Cloudflare provider uses CONFIG only for MAX_TOKENS; read lazily via the
// providers-base CONFIG proxy (which itself uses DI) or fall back to direct.
const CONFIG: any = new Proxy({}, { get: (_, prop) => {
  try { return require('./get-config')[prop]; } catch { return undefined; }
}});

function CloudflareProvider() {
  const apiKey = process.env.CF_API_KEY;
  const accountId = process.env.CF_ACCOUNT_ID;
  if (!apiKey || !accountId) return null;

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Cloudflare');
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${config.model}`;

    // Guard: reject empty or whitespace-only prompts before hitting the API
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      throw new Error('Cloudflare: Empty or invalid input (prompt is empty/whitespace)');
    }

    // Build content - multipart with image if available, plain string otherwise
    const userContent = base64Image
      ? [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } },
        ]
      : prompt;

    const payload = {
      messages: [{ role: 'user', content: userContent }],
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

      // Extract retry-after for rate limiting (P7)
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
      if (!data.success || !data.result || !data.result.response) {
        throw new Error('CLOUDFLARE_EMPTY_RESPONSE');
      }
      return data.result.response;
    };

    // P7: Pass providerName for health-aware retries (classifyError needs it)
    try {
      const rawContent = await retryWithBackoff(makeRequest, { providerName: 'Cloudflare' });
      if (options.validate === false) return rawContent;
      return validateActionResponse(extractJSON(rawContent, 'Cloudflare'), 'Cloudflare');
    } catch (err: any) {
      // Attempt rollback on config errors (401/403/404)
      if (err.message && (
        err.message.includes('HTTP_ERROR_404') ||
        err.message.includes('HTTP_ERROR_401') ||
        err.message.includes('HTTP_ERROR_403')
      )) {
        try {
          const { rollbackProvider } = require('./providers-config-loader');
          log(`Cloudflare returned config error (${err.message}) -- attempting rollback...`, 'WARN', 'cloudflare');
          const rolledBack = rollbackProvider('Cloudflare');
          if (rolledBack) {
            log(`Rolled back Cloudflare model config.`, 'INFO', 'cloudflare');
            const newConfig = getProviderConfig('Cloudflare');
            const newUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${newConfig.model}`;
            const retryRaw = await retryWithBackoff(async () => {
              const retryResponse = await fetchWithTimeout(newUrl, {
                method: 'POST',
                headers: {
                  'Authorization': `Bearer ${apiKey}`,
                  'Content-Type': 'application/json',
                },
                body: JSON.stringify(payload),
                signal,
              });
              if (retryResponse.status === 429) {
                const ra = retryResponse.headers.get('retry-after');
                const e: any = new Error('HTTP_ERROR_429: Rate limited');
                e.retryAfterMs = ra ? parseInt(ra, 10) * 1000 : undefined;
                throw e;
              }
              if (!retryResponse.ok) {
                const retryErrorText = sanitizeErrorText(await retryResponse.text().catch(() => 'Unknown error'));
                throw new Error(`Retry failed: HTTP_ERROR_${retryResponse.status}: ${retryErrorText}`);
              }
              const retryData = await retryResponse.json();
              if (!retryData.success || !retryData.result || !retryData.result.response) {
                throw new Error('CLOUDFLARE_EMPTY_RESPONSE');
              }
              return retryData.result.response;
            }, { providerName: 'Cloudflare' });
            if (options.validate === false) return retryRaw;
            return validateActionResponse(extractJSON(retryRaw, 'Cloudflare'), 'Cloudflare');
          }
        } catch (rollbackErr: any) {
          log(`Cloudflare rollback failed: ${rollbackErr.message || rollbackErr}`, 'WARN', 'cloudflare');
        }
      }
      throw err;
    }
  };
}

module.exports = { CloudflareProvider };
