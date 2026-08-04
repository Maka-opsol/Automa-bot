'use strict';

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

// Lazy logger fallback for before DI init
function _log(msg: string, level?: string, mod?: string) { if (_deps.logger?.log) { _deps.logger.log(msg, level, mod); } else { try { const l = require('./logger'); l.log(msg, level, mod); } catch {} } }
function _logError(msg: string, err: Error) { if (_deps.logger?.logError) { _deps.logger.logError(msg, err); } else { try { const l = require('./logger'); l.logError(msg, err); } catch {} } }

// Dynamic model registry - updated by provider health checks and web discovery
let DYNAMIC_MODELS: Record<string, any> = {};
let _dynamicModelsLoaded = false;

function loadDynamicModels() { 
  if (_dynamicModelsLoaded) return;
  _dynamicModelsLoaded = true;
  try {
    // Lazy access: read from database module at call time, not at require() time
    const db = _deps.database ?? require('./database');
    const stored = db.selectCalibration?.get('dynamic_provider_models');
    if (stored && stored.value) { DYNAMIC_MODELS = JSON.parse(stored.value); }
  } catch (e: any) { _logError('Failed to load dynamic models', e); }
}

function saveDynamicModels() { 
  try {
    // Lazy access: write to database module at call time
    const db = _deps.database ?? require('./database');
    db.upsertCalibration?.run('dynamic_provider_models', JSON.stringify(DYNAMIC_MODELS), Date.now());
  } catch (e: any) { _logError('Failed to save dynamic models', e); }
}

// Auto-discover models from provider model list APIs
async function autoDiscoverModels() { 
  const discoveries = [];
  // OpenRouter
  try {
    const { fetchJSON } = require('./utils-fetch');
    const data = await fetchJSON('https://openrouter.ai/api/v1/models', {}, 10000);
    if (data && data.data) {
      const visionFree = data.data.filter((m: any) => m.architecture && m.architecture.modality && m.architecture.modality.includes('image') && m.pricing && (m.pricing.prompt === '0' || m.pricing.prompt === 0 || parseFloat(m.pricing.prompt) === 0));
      if (visionFree.length > 0) {
        const best = visionFree.sort((a: any, b: any) => (b.context_length ?? 0) - (a.context_length ?? 0))[0];
        DYNAMIC_MODELS['openrouter-free-vision'] = { endpoint: 'https://openrouter.ai/api/v1/chat/completions', model: best.id, discoveredAt: Date.now(), source: 'openrouter-api' };
        discoveries.push({ provider: 'openrouter', model: best.id });
      }
    }
  } catch (e: any) { _log(`Auto-discover failed: ${e.message}`, 'WARN', 'config-loader'); }
  if (discoveries.length > 0) { saveDynamicModels(); _log(`Auto-discovered ${discoveries.length} new models`, 'INFO', 'config-loader'); }
  return discoveries;
}

const DEFAULTS = {
  'GitHub GPT': { endpoint: 'https://models.inference.ai.azure.com/chat/completions', model: 'gpt-4o-mini' },
  Groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', model: 'llama-4-scout-17b-16e-instruct' },
  'z.ai': { endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', model: 'GLM-4.6V-Flash' },
  Agnes: { endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions', model: 'agnes-2.0-flash' },
  NVIDIA: { endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', model: 'meta/llama-3.2-11b-vision-instruct' },
  Cloudflare: { endpoint: null, model: '@cf/meta/llama-4-scout-17b-16e-instruct' },
  Cerebras: { endpoint: 'https://api.cerebras.ai/v1/chat/completions', model: 'gemma-4-31b' },
  Gemini: { endpoint: null, model: 'gemini-2.0-flash' },
};

/** Lazy accessor for database selectProvider — resolves at call time, not at require() time. */
function _getDb() {
  return _deps.database ?? require('./database');
}

function getProviderConfig(providerName: any) { 
  try {
    // Ensure dynamic models are loaded from DB on first call
    loadDynamicModels();
    const db = _getDb();
    const row = db.selectProvider?.get(providerName);
    if (row && row.model) return { endpoint: row.endpoint || null, model: row.model };
  } catch (e: any) { _logError(`getProviderConfig DB error for ${providerName}`, e); }
  // Check dynamic models
  if (DYNAMIC_MODELS[providerName]) { const d = DYNAMIC_MODELS[providerName]; return { endpoint: d.endpoint || null, model: d.model }; }
  const def = (DEFAULTS as any)[providerName];
  if (def) return { endpoint: def.endpoint || null, model: def.model };
  return { endpoint: null, model: null };
}

function updateProviderConfig(providerName: any, newConfig: any, verified = true) { 
  try {
    const db = _getDb();
    const old = db.selectProvider?.get(providerName);
    let history = [];
    if (old && old.history) { try { history = JSON.parse(old.history); } catch (_e: any) { /* malformed data, skipping */ } }
    if (old) {
      history.push({ endpoint: old.endpoint, model: old.model, verifiedAt: old.last_verified ? new Date(old.last_verified).toISOString() : new Date().toISOString() });
      if (history.length > 5) history.shift();
    }
    db.upsertProvider?.run(providerName, newConfig.endpoint || null, newConfig.model, verified ? Date.now() : (old ? old.last_verified : Date.now()), JSON.stringify(history), old ? (old.success_count ?? 0) : 0, old ? (old.failure_count ?? 0) : 0, old ? (old.total_latency ?? 0) : 0, Date.now());
  } catch (e: any) { _logError(`Failed to update provider config for ${providerName}`, e); }
}

function rollbackProvider(providerName: any) { 
  try {
    const db = _getDb();
    const row = db.selectProvider?.get(providerName);
    if (!row || !row.history) return false;
    let history = [];
    try { history = JSON.parse(row.history); } catch (e: any) { return false; }
    if (history.length === 0) return false;
    const previous = history.pop();
    db.upsertProvider?.run(providerName, previous.endpoint || null, previous.model, Date.now(), JSON.stringify(history), row ? (row.success_count ?? 0) : 0, row ? (row.failure_count ?? 0) : 0, row ? (row.total_latency ?? 0) : 0, Date.now());
    return true;
  } catch (e: any) { return false; }
}

function getProviderHistory(providerName: any) { 
  try {
    const db = _getDb();
    const row = db.selectProvider?.get(providerName);
    if (row && row.history) return JSON.parse(row.history);
  } catch (_e: any) { /* malformed data, skipping */ }
  return [];
}

module.exports = { getProviderConfig, updateProviderConfig, rollbackProvider, getProviderHistory, autoDiscoverModels, DYNAMIC_MODELS: () => ({ ...DYNAMIC_MODELS }), _injectDependencies };
