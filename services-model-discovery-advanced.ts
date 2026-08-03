'use strict';

const { fetchJSON } = require('./utils-fetch');
const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

const PROVIDER_ENDPOINTS = {
  openrouter: 'https://openrouter.ai/api/v1/models',
  mistral: 'https://api.mistral.ai/v1/models',
};

async function discoverModels(providerName: any) { 
  const url = (PROVIDER_ENDPOINTS as any)[providerName];
  if (!url) return [];
  try {
    const headers = {};
    if (providerName === 'mistral' && CONFIG.MISTRAL_CODE_API_KEY) { (headers as any)['Authorization'] = `Bearer ${CONFIG.MISTRAL_CODE_API_KEY}`; }
    const data = await fetchJSON(url, { headers }, 15000);
    const models = data.data || [];
    return models.filter((m: any) => { const promptCost = parseFloat(m.pricing?.prompt || m.pricing?.promptPrice || '1'); const completionCost = parseFloat(m.pricing?.completion || '1'); return (promptCost === 0 && completionCost === 0) || m.id.includes(':free'); }).map((m: any) => ({
      id: m.id,
      provider: providerName,
      endpoint: providerName === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : providerName === 'mistral' ? 'https://api.mistral.ai/v1/chat/completions' : null
    }));
  } catch (err: any) { logError(`Model discovery for ${providerName} failed`, err); return []; }
}

async function discoverAllFreeModels() { 
  const results = [];
  for (const provider of Object.keys(PROVIDER_ENDPOINTS)) {
    const models = await discoverModels(provider);
    results.push(...models);
  }
  return results;
}

module.exports = { discoverAllFreeModels, getFreeModels: discoverModels };
