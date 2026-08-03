'use strict';

const { log, logError } = require('./logger');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getProvidersConfigLoader() { return _deps.providersConfigLoader || require('./providers-config-loader'); }
const { fetchWithTimeout } = require('./utils-fetch');

// Provider adapter registry - each adapter knows how to call a specific API format
const ADAPTERS = {
  'openai-compatible': {
    // Standard OpenAI chat completions format (used by most providers)
    async call(endpoint: any, apiKey: any, model: any, base64Image: any, prompt: any, options: any = {}) { 
      const content = [{ type: 'text', text: prompt }];
// @ts-expect-error
      if (base64Image) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image } as any` } });
      const payload = { model, max_tokens: options.maxTokens || 256, temperature: options.temperature || 0, messages: [{ role: 'user', content }] };
      const resp = await fetchWithTimeout(endpoint, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`HTTP_${resp.status}: ${text.substring(0, 200)}`);
      }
      return resp.json();
    },
    test(_model: any) {  return true; }, // Any model works with this format
  },
  'gemini-native': {
    async call(endpoint: any, apiKey: any, model: any, base64Image: any, prompt: any, options: any = {}) { 
      const parts = [{ text: prompt }];
// @ts-expect-error
      if (base64Image) parts.unshift({ inlineData: { mimeType: 'image/jpeg', data: base64Image  } as any });
      const payload = { contents: [{ parts }], generationConfig: { maxOutputTokens: options.maxTokens || 256, temperature: options.temperature || 0 } };
      const url = endpoint || `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: options.signal,
      });
      if (!resp.ok) throw new Error(`GEMINI_HTTP_${resp.status}`);
      const data = await resp.json();
      // Normalize to OpenAI format
      return { choices: [{ message: { content: data.candidates?.[0]?.content?.parts?.[0]?.text || '' } }] };
    },
    test(model: any) {  return model.includes('gemini'); },
  },
  'cloudflare-workers-ai': {
    async call(_endpoint: any, apiKey: any, model: any, base64Image: any, prompt: any, options: any = {}) { 
      const accountId = process.env.CF_ACCOUNT_ID;
      if (!accountId) throw new Error('CF_ACCOUNT_ID not set');
      const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1/chat/completions`;
      const content = [{ type: 'text', text: prompt }];
// @ts-expect-error
      if (base64Image) content.push({ type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image } as any` } });
      const resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model, max_tokens: options.maxTokens || 256, temperature: options.temperature || 0, messages: [{ role: 'user', content }] }),
        signal: options.signal,
      });
      if (!resp.ok) throw new Error(`CF_HTTP_${resp.status}`);
      return resp.json();
    },
    test(model: any) {  return model.startsWith('@cf/'); },
  },
};

function getAdapterForProvider(providerName: any, model: any) { 
  // Check Gemini models first
  if (providerName === 'gemini' || providerName?.includes('gemini') || (model && model.includes('gemini'))) return ADAPTERS['gemini-native'];
  if (model && model.startsWith('@cf/')) return ADAPTERS['cloudflare-workers-ai'];
  // Default to OpenAI-compatible (covers Groq, GitHub, NVIDIA, Cerebras, Agnes, z.ai, OpenRouter, Mistral, DeepSeek, Qwen)
  return ADAPTERS['openai-compatible'];
}

function registerAdapter(name: any, adapter: any) { 
  (ADAPTERS as any)[name] = adapter;
  log(`Registered provider adapter: ${name}`, 'INFO', 'provider-adapter');
}

// Test a provider endpoint and return health info
async function testProviderHealth(providerName: any, apiKey: any, endpoint: any, model: any) { 
  const adapter = getAdapterForProvider(providerName, model);
  const testPrompt = 'Respond with only the word "ok"';
  try {
    const start = Date.now();
    const result = await adapter.call(endpoint, apiKey, model, null, testPrompt, { maxTokens: 10 });
    const latency = Date.now() - start;
    const content = result.choices?.[0]?.message?.content || result.candidates?.[0]?.content?.parts?.[0]?.text || '';
    return { healthy: true, latency, responseSnippet: content.substring(0, 50) };
  } catch (err: any) {
    return { healthy: false, error: err.message };
  }
}

module.exports = { getAdapterForProvider, registerAdapter, testProviderHealth, ADAPTERS, _injectDependencies };
