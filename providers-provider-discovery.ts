'use strict';

const { searchWeb } = require('./web-search');
const { getProviderConfig, updateProviderConfig } = require('./providers-config-loader');
const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

const PROVIDER_QUERIES = {
  'Groq': 'Groq API models list llama vision',
  'GitHub GPT': 'GitHub Models Azure OpenAI gpt-4o-mini',
  'z.ai': 'z.ai GLM-4.6V-Flash model',
  'Agnes': 'Agnes AI 2.0 flash model',
  'NVIDIA': 'NVIDIA NIM llama-3.2-11b-vision-instruct',
  'Cloudflare': 'Cloudflare Workers AI @cf/meta/llama-3.2-11b-vision',
  'Cerebras': 'Cerebras gemma-4-31b model',
  'Gemini': 'Gemini 1.5 flash model'
};

function extractModelName(text: any, providerName: any) { 
  const defaults = {
    'Groq': 'llama-3.2-11b-vision-preview',
    'GitHub GPT': 'gpt-4o-mini',
    'z.ai': 'GLM-4.6V-Flash',
    'Agnes': 'agnes-2.0-flash',
    'NVIDIA': 'meta/llama-3.2-11b-vision-instruct',
    'Cloudflare': '@cf/meta/llama-3.2-11b-vision',
    'Cerebras': 'gemma-4-31b',
    'Gemini': 'gemini-1.5-flash'
  };
  if (!text || typeof text !== 'string') return (defaults as any)[providerName] || null;
  const modelPatterns = {
    'Groq': /llama-3[\d.]*-[\w-]*vision[\w-]*/i,
    'GitHub GPT': /gpt-4[\w.-]*/i,
    'z.ai': /GLM-[\d.]+V-[\w-]+/i,
    'Agnes': /agnes-[\d.]+-[\w-]+/i,
    'NVIDIA': /meta\/llama-[\d.]+-[\w-]*/i,
    'Cloudflare': /@cf\/meta\/llama-[\d.]+-[\w-]*/i,
    'Cerebras': /gemma-[\d]+-[\w-]+/i,
    'Gemini': /gemini-[\d.]+-[\w-]+/i,
  };
  const pattern = (modelPatterns as any)[providerName];
  if (pattern) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return (defaults as any)[providerName] || null;
}

async function discoverProviderModel(providerName: any) { 
  log(`🔍 Discovering model for ${providerName}...`, 'INFO', 'provider-discovery');
  const query = (PROVIDER_QUERIES as any)[providerName];
  if (!query) return null;
  const result = await searchWeb(query);
  if (!result) return null;
  const model = extractModelName(result, providerName);
  if (model) { log(`📦 Found model for ${providerName}: ${model}`, 'INFO', 'provider-discovery'); return model; }
  return null;
}

async function refreshAllProviderModels() {
  const providers = Object.keys(PROVIDER_QUERIES);
  const results = await Promise.allSettled(providers.map(prov => discoverProviderModel(prov)));
  let updatedCount = 0;
  for (const [i, result] of results.entries()) {
    if (result.status === 'fulfilled' && result.value) {
      const providerName = providers[i];
      const model = result.value;
      const current = getProviderConfig(providerName);
      if (current && current.model !== model) {
        updateProviderConfig(providerName, { ...current, model }, false);
        updatedCount++;
        log(`🔄 Updated ${providerName} model to ${model}`, 'INFO', 'provider-discovery');
      }
    }
  }
  return updatedCount;
}

module.exports = { refreshAllProviderModels, discoverProviderModel };
