'use strict';

const { fetchWithTimeout, extractJSON, validateActionResponse, sanitizeErrorText, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');
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
    const payload = {
      messages: [{ role: 'user', content: [
        { type: 'text', text: prompt },
        ...(base64Image ? [{ type: 'image', image: `data:image/jpeg;base64,${base64Image}` }] : [])
      ] }],
      max_tokens: CONFIG.MAX_TOKENS || 4096, temperature: 0.0, stream: false
    };
    const makeRequest = async () => {
      const response = await fetchWithTimeout(url, { method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
      if (response.status === 429) { const retryAfter = response.headers.get('retry-after'); const err: any = new Error('RATE_LIMIT'); err.retryAfterMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : undefined; throw err; }
      if (!response.ok) { const errorText = sanitizeErrorText(await response.text().catch(() => 'Unknown error')); throw new Error(`HTTP_ERROR_${response.status}: ${errorText}`); }
      const data = await response.json();
      if (!data.success || !data.result || !data.result.response) throw new Error('CLOUDFLARE_EMPTY_RESPONSE');
      return data.result.response;
    };
    try {
      const rawContent = await retryWithBackoff(makeRequest);
      if (options.validate === false) return rawContent;
      return validateActionResponse(extractJSON(rawContent, 'Cloudflare'), 'Cloudflare');
    } catch (err: any) {
      if (err.message && (err.message.includes('HTTP_ERROR_404') || err.message.includes('HTTP_ERROR_401') || err.message.includes('HTTP_ERROR_403'))) {
        const { rollbackProvider } = require('./providers-config-loader');
        log(`⚠️ Cloudflare returned config error -- attempting rollback...`, 'WARN', 'cloudflare');
        const rolledBack = rollbackProvider('Cloudflare');
        if (rolledBack) {
          log(`↩️ Rolled back Cloudflare.`, 'INFO', 'cloudflare');
          const newConfig = getProviderConfig('Cloudflare');
          const newUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${newConfig.model}`;
          const retryRaw = await retryWithBackoff(async () => {
            const retryResponse = await fetchWithTimeout(newUrl, { method: 'POST', headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal });
            if (retryResponse.status === 429) { const ra = retryResponse.headers.get('retry-after'); const e: any = new Error('RATE_LIMIT'); e.retryAfterMs = ra ? parseInt(ra, 10) * 1000 : undefined; throw e; }
            if (!retryResponse.ok) throw new Error(`Retry failed with status ${retryResponse.status}`);
            const retryData = await retryResponse.json();
            if (!retryData.success || !retryData.result || !retryData.result.response) throw new Error('CLOUDFLARE_EMPTY_RESPONSE');
            return retryData.result.response;
          });
          if (options.validate === false) return retryRaw;
          return validateActionResponse(extractJSON(retryRaw, 'Cloudflare'), 'Cloudflare');
        }
      }
      throw err;
    }
  };
}

module.exports = { CloudflareProvider };
