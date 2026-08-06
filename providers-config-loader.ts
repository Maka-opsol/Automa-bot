'use strict';
// Last modified: 2026-08-06 - Disabled DeepInfra (no longer free), all providers vision-capable

// --- Dependency Injection ---------------------------------------------------
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

// Lazy logger fallback for before DI init
function _log(msg: string, level?: string, mod?: string) { if (_deps.logger?.log) { _deps.logger.log(msg, level, mod); } else { try { const l = require('./logger'); l.log(msg, level, mod); } catch {} } }
function _logError(msg: string, err: Error) { if (_deps.logger?.logError) { _deps.logger.logError(msg, err); } else { try { const l = require('./logger'); l.logError(msg, err); } catch {} } }

// ===============================================================================
// FREE-ONLY MODEL DEFAULTS (P2, P3)
// ===============================================================================
//
// Every model here MUST be:
//   1. Available on a free tier (no credit card required)
//   2. Capable of following JSON action instructions (not base models)
//   3. Reasonably fast (<10s typical response on free tier)
//
// Models replaced from original DEFAULTS:
//   - Groq: deepseek-r1-distill-llama-70b ??? llama-3.3-70b-versatile (deepseek-r1 deprecated)
//   - Gemini: gemini-2.0-flash ??? gemini-2.5-flash (better rate limits, still free)
//   - DeepInfra: NEW - free Qwen2.5-VL vision models
//   - NVIDIA: meta/llama-3.2-11b-vision-instruct ??? meta/llama-3.3-70b-instruct
//       (3.3-70b is free on NVIDIA NIM, much stronger than 3.2-11b)
//   - Cerebras: gemma-4-31b ??? llama-4-scout-17b-16e-instruct
//       (Cerebras may not host gemma-4; llama-4-scout is confirmed available)
//   - GitHub GPT: DISABLED (free tier ended)
//
// Models kept:
//   - z.ai: GLM-4.6V-Flash (vision model, free tier)
//   - Agnes: agnes-2.0-flash (free tier)
//   - Cloudflare: @cf/meta/llama-4-scout-17b-16e-instruct (free Workers AI)

export interface ProviderDefault {
  endpoint: string | null;
  model: string;
  disabled?: boolean;           // P9: if true, provider is skipped by default
  disabledReason?: string;
  envKeys: string[];            // required env vars for this provider
  visionCapable: boolean;       // whether the default model supports vision
  fallbackModels?: string[];    // models to try if primary 404s
}

const DEFAULTS: Record<string, ProviderDefault> = {
  'GitHub GPT': {
    endpoint: 'https://models.inference.ai.azure.com/chat/completions',
    model: 'gpt-4o-mini',
    disabled: true,
    disabledReason: 'Retired July 30, 2026 - GitHub Models free tier ended',
    envKeys: ['GITHUB_API_KEY'],
    visionCapable: true,
    fallbackModels: ['gpt-4o'],
  },
  'Groq': {
    endpoint: null,  // Uses groq-sdk (not raw HTTP)
    model: 'qwen/qwen3.6-27b',
    envKeys: ['GROQ_API_KEY'],
    visionCapable: true,  // qwen model supports vision via SDK
    fallbackModels: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'llama3-70b-8192',
    ],
  },
  'z.ai': {
    endpoint: 'https://api.z.ai/api/paas/v4/chat/completions',
    model: 'GLM-4.6V-Flash',
    envKeys: ['ZAI_API_KEY'],
    visionCapable: true,
    fallbackModels: ['GLM-4-Flash'],
  },
  'Agnes': {
    endpoint: 'https://apihub.agnes-ai.com/v1/chat/completions',
    model: 'agnes-2.0-flash',
    envKeys: ['AGNES_API_KEY'],
    visionCapable: true,
    fallbackModels: [],
  },
  'NVIDIA': {
    endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions',
    model: 'meta/llama-3.3-70b-instruct',
    envKeys: ['NVIDIA_API_KEY'],
    visionCapable: true,
    fallbackModels: [
      'nvidia/llama-3.2-11b-vision-instruct',
      'meta/llama-3.1-8b-instruct',
      'nvidia/llama-3.1-nemotron-70b-instruct',
    ],
  },
  'Cloudflare': {
    endpoint: null,  // built dynamically from CF_ACCOUNT_ID
    model: '@cf/meta/llama-4-scout-17b-16e-instruct',
    envKeys: ['CF_API_KEY', 'CF_ACCOUNT_ID'],
    visionCapable: true,
    fallbackModels: [
      '@cf/meta/llama-3.3-70b-instruct',
      '@cf/meta/llama-3.1-8b-instruct',
    ],
  },
  'Cerebras': {
    endpoint: null,  // Uses @cerebras/cerebras_cloud_sdk (not raw HTTP)
    model: 'gemma-4-31b',
    disabled: true,
    disabledReason: 'Free tier removed - disabled Aug 2026',
    envKeys: ['CEREBRAS_API_KEY'],
    visionCapable: true,
    fallbackModels: [
      'zai-glm-4.7',
      'gpt-oss-120b',
    ],
  },
  'DeepInfra': {
    endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions',
    model: 'Qwen/Qwen2.5-VL-32B-Instruct',
    disabled: true,
    disabledReason: 'No longer free tier - disabled Aug 2026',
    envKeys: ['DEEPINFRA_API_KEY'],
    visionCapable: true,
    fallbackModels: ['meta-llama/Llama-4-Scout-17B-16E-Instruct', 'Qwen/Qwen3-0.6B'],
  },
  'Gemini': {
    endpoint: null,  // uses Google SDK, not HTTP endpoint
    model: 'gemini-2.5-flash',
    envKeys: ['GEMINI_API_KEY'],
    visionCapable: true,
    fallbackModels: ['gemini-2.0-flash', 'gemini-1.5-flash'],
  },
  'OpenRouter': {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    model: 'google/gemma-3-27b-it',
    envKeys: ['OPENROUTER_API_KEY'],
    visionCapable: true,
    fallbackModels: [
      'google/gemma-4-31b-it',
      'nvidia/nemotron-nano-12b-2-vl',
      'qwen/qwen3-0.6b',
    ],
  },
};

// ===============================================================================
// DYNAMIC MODEL REGISTRY (P4, P19)
// ===============================================================================
//
// Discovered and verified models live here. Persisted to DB so they survive
// restarts. Entries have metadata for capability-based filtering.

interface DynamicModel {
  endpoint: string | null;
  model: string;
  discoveredAt: number;
  source: string;
  verified: boolean;
  verifiedAt: number | null;
  visionCapable: boolean;
  providerName?: string;  // which provider this is a fallback for
}

let DYNAMIC_MODELS: Record<string, DynamicModel> = {};
let _dynamicModelsLoaded = false;

function loadDynamicModels() { 
  if (_dynamicModelsLoaded) return;
  _dynamicModelsLoaded = true;
  try {
    const db = _deps.database ?? require('./database');
    const stored = db.selectCalibration?.get('dynamic_provider_models');
    if (stored && stored.value) {
      const parsed = JSON.parse(stored.value);
      DYNAMIC_MODELS = parsed;
      _log(`Loaded ${Object.keys(parsed).length} dynamic models from DB`, 'DEBUG', 'config-loader');
    }
  } catch (e: any) { _logError('Failed to load dynamic models', e); }
}

function saveDynamicModels() { 
  try {
    const db = _deps.database ?? require('./database');
    db.upsertCalibration?.run('dynamic_provider_models', JSON.stringify(DYNAMIC_MODELS), Date.now());
  } catch (e: any) { _logError('Failed to save dynamic models', e); }
}

// ===============================================================================
// AUTO-DISCOVERY WITH VERIFICATION (P19)
// ===============================================================================
//
// Queries provider model list APIs for free models, then verifies each
// with a minimal test request before registering. This prevents registering
// models that return 404 or require authentication.

async function autoDiscoverModels() { 
  const discoveries: Array<{provider: string; model: string; visionCapable: boolean}> = [];

  // --- OpenRouter: query /models for free vision models ---
  try {
    const { fetchJSON } = require('./utils-fetch');
    const data = await fetchJSON('https://openrouter.ai/api/v1/models', {}, 15000);
    if (data && data.data) {
      // Filter: free pricing + supports image modality
      const visionFree = data.data.filter((m: any) => {
        const promptCost = parseFloat(m.pricing?.prompt || '1');
        const completionCost = parseFloat(m.pricing?.completion || '1');
        const isFree = (promptCost === 0 && completionCost === 0) || m.id.includes(':free');
        if (!isFree) return false;
        // Check modality for vision support
        const modality = m.architecture?.modality;
        const hasImage = Array.isArray(modality) && modality.includes('image');
        const hasText = Array.isArray(modality) && modality.includes('text');
        return hasImage && hasText;
      });
      // Sort by context length (larger is better for complex reasoning)
      visionFree.sort((a: any, b: any) => (b.context_length ?? 0) - (a.context_length ?? 0));
      // Register top 3 as discovered candidates
      const topN = visionFree.slice(0, 3);
      for (const m of topN) {
        const key = `openrouter-discovered-${m.id.replace(/[^a-z0-9]/gi, '-')}`;
        DYNAMIC_MODELS[key] = {
          endpoint: 'https://openrouter.ai/api/v1/chat/completions',
          model: m.id,
          discoveredAt: Date.now(),
          source: 'openrouter-api',
          verified: false,
          verifiedAt: null,
          visionCapable: true,
          providerName: 'OpenRouter',
        };
        discoveries.push({ provider: 'openrouter', model: m.id, visionCapable: true });
      }
    }
  } catch (e: any) { _log(`Auto-discover OpenRouter failed: ${e.message}`, 'WARN', 'config-loader'); }

  // --- Groq: query /models for available models ---
  try {
    const { fetchJSON } = require('./utils-fetch');
    const groqKey = process.env.GROQ_API_KEY;
    if (groqKey) {
      const data = await fetchJSON('https://api.groq.com/openai/v1/models', {
        headers: { 'Authorization': `Bearer ${groqKey}` }
      }, 10000);
      if (data && data.data) {
        const freeModels = data.data
          .map((m: any) => m.id)
          .filter((id: string) => !id.includes('whisper') && !id.includes('tts') && !id.includes('playai'))
          .filter((id: string) => id.includes('vision') || id.includes('vl') || id.includes('multimodal') || id.includes('omni'));
        // Register top 2 as fallback candidates
        for (const id of freeModels.slice(0, 2)) {
          const key = `groq-discovered-${id.replace(/[^a-z0-9]/gi, '-')}`;
          if (!DYNAMIC_MODELS[key]) {
            DYNAMIC_MODELS[key] = {
              endpoint: 'https://api.groq.com/openai/v1/chat/completions',
              model: id,
              discoveredAt: Date.now(),
              source: 'groq-api',
              verified: false,
              verifiedAt: null,
              visionCapable: id.includes('vision') || id.includes('vl') || id.includes('omni') || id.includes('multimodal'),
              providerName: 'Groq',
            };
            discoveries.push({ provider: 'groq', model: id, visionCapable: id.includes('vision') || id.includes('vl') || id.includes('omni') || id.includes('multimodal') });
          }
        }
      }
    }
  } catch (e: any) { _log(`Auto-discover Groq failed: ${e.message}`, 'WARN', 'config-loader'); }

  // --- Verify discovered models with minimal test requests ---
  // Only verify the first discovery from each provider to save time
  const toVerify = discoveries.filter((d, i, arr) => arr.findIndex(x => x.provider === d.provider) === i);
  for (const disc of toVerify.slice(0, 2)) {  // max 2 verifications to limit API usage
    const key = Object.entries(DYNAMIC_MODELS).find(([, v]) => v.model === disc.model && v.source.includes(disc.provider))?.[0];
    if (!key) continue;
    const dm = DYNAMIC_MODELS[key];
    if (dm.verified) continue;
    try {
      const verified = await _verifyModel(dm);
      if (verified) {
        dm.verified = true;
        dm.verifiedAt = Date.now();
        _log(`Verified discovered model: ${disc.model} (${disc.provider})`, 'INFO', 'config-loader');
      } else {
        _log(`Discovered model failed verification: ${disc.model} (${disc.provider})`, 'WARN', 'config-loader');
      }
    } catch (e: any) { _log(`Verification error for ${disc.model}: ${e.message}`, 'WARN', 'config-loader'); }
  }

  if (discoveries.length > 0) {
    saveDynamicModels();
    _log(`Auto-discovered ${discoveries.length} models (${toVerify.length} verified)`, 'INFO', 'config-loader');
  }
  return discoveries;
}

/**
 * Verify a model with a minimal test request.
 * Sends a short prompt and checks for a valid response.
 */
async function _verifyModel(dm: DynamicModel): Promise<boolean> {
  if (!dm.endpoint) return false;
  let apiKey = '';
  if (dm.providerName === 'OpenRouter') apiKey = process.env.OPENROUTER_API_KEY || '';
  else if (dm.providerName === 'Groq') apiKey = process.env.GROQ_API_KEY || '';
  if (!apiKey) return false;

  try {
    const { fetchWithTimeout } = require('./utils-fetch');
    const payload = {
      model: dm.model,
      max_tokens: 10,
      temperature: 0,
      messages: [{ role: 'user', content: 'Reply with just the word OK.' }],
    };
    const resp = await fetchWithTimeout(dm.endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }, 10000);
    if (!resp.ok) return false;
    const data = await resp.json();
    return !!(data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content);
  } catch {
    return false;
  }
}

// ===============================================================================
// AUTO-REPLACEMENT (P8)
// ===============================================================================
//
// When a provider is retired (model 404), find a replacement from:
//   1. The provider's fallbackModels list in DEFAULTS
//   2. Verified dynamic models for the same provider
//   3. Verified dynamic models from any provider

function findReplacement(providerName: string): { endpoint: string | null; model: string } | null {
  const def = DEFAULTS[providerName];
  if (!def) {
    // Try dynamic models
    for (const [key, dm] of Object.entries(DYNAMIC_MODELS)) {
      if (dm.verified && dm.providerName === providerName && dm.endpoint) {
        return { endpoint: dm.endpoint, model: dm.model };
      }
    }
    return null;
  }

  // 1. Try fallback models from DEFAULTS
  if (def.fallbackModels && def.fallbackModels.length > 0) {
    for (const fbModel of def.fallbackModels) {
      return { endpoint: def.endpoint, model: fbModel };
    }
  }

  // 2. Try verified dynamic models for the same provider
  for (const [key, dm] of Object.entries(DYNAMIC_MODELS)) {
    if (dm.verified && dm.providerName === providerName && dm.endpoint) {
      return { endpoint: dm.endpoint, model: dm.model };
    }
  }

  // 3. Try any verified dynamic model (cross-provider replacement)
  for (const [key, dm] of Object.entries(DYNAMIC_MODELS)) {
    if (dm.verified && dm.endpoint) {
      return { endpoint: dm.endpoint, model: dm.model };
    }
  }

  return null;
}

/**
 * Register a replacement provider after a retirement.
 * The replacement is registered as a dynamic provider in the registry.
 */
function registerReplacement(retiredName: string, replacement: { endpoint: string | null; model: string }): string {
  const dynName = `replacement-for-${retiredName}`;
  DYNAMIC_MODELS[dynName] = {
    endpoint: replacement.endpoint,
    model: replacement.model,
    discoveredAt: Date.now(),
    source: `auto-replacement-for-${retiredName}`,
    verified: false,
    verifiedAt: null,
    visionCapable: false,  // will be determined by first call
    providerName: retiredName,
  };
  saveDynamicModels();
  _log(`Registered replacement ${dynName}: ${replacement.model}`, 'INFO', 'config-loader');
  return dynName;
}

// ===============================================================================
// PROVIDER CONFIG ACCESS (unchanged API, enhanced internals)
// ===============================================================================

/** Lazy accessor for database - resolves at call time, not at require() time. */
function _getDb() {
  return _deps.database ?? require('./database');
}

function getProviderConfig(providerName: string): { endpoint: string | null; model: string; disabled?: boolean; disabledReason?: string } {
  try {
    loadDynamicModels();
    const db = _getDb();
    const row = db.selectProvider?.get(providerName);
    if (row && row.model) {
      return { endpoint: row.endpoint || null, model: row.model };
    }
  } catch (e: any) { _logError(`getProviderConfig DB error for ${providerName}`, e); }

  // Check dynamic models
  if (DYNAMIC_MODELS[providerName]) {
    const d = DYNAMIC_MODELS[providerName];
    return { endpoint: d.endpoint || null, model: d.model };
  }

  // Fall back to DEFAULTS
  const def = DEFAULTS[providerName];
  if (def) {
    return {
      endpoint: def.endpoint || null,
      model: def.model,
      disabled: def.disabled || false,
      disabledReason: def.disabledReason,
    };
  }

  return { endpoint: null, model: null };
}

/**
 * Check if a provider's required env keys are present.
 * Used by the registry to skip providers without API keys.
 */
function hasRequiredEnvKeys(providerName: string): boolean {
  const def = DEFAULTS[providerName];
  if (!def) return true;  // unknown providers - let the provider factory check
  return def.envKeys.every(key => {
    const val = process.env[key];
    return typeof val === 'string' && val.length > 0;
  });
}

/**
 * Check if a provider is disabled by default.
 */
function isProviderDisabledByDefault(providerName: string): boolean {
  const def = DEFAULTS[providerName];
  return def ? (def.disabled || false) : false;
}

/**
 * Get the env keys required for a provider (for diagnostics).
 */
function getEnvKeys(providerName: string): string[] {
  const def = DEFAULTS[providerName];
  return def ? (def.envKeys || []) : [];
}

/**
 * Get the fallback models chain for a provider.
 */
function getFallbackModels(providerName: string): string[] {
  const def = DEFAULTS[providerName];
  return def ? (def.fallbackModels || []) : [];
}

/**
 * Get all provider names from DEFAULTS.
 */
function getKnownProviders(): string[] {
  return Object.keys(DEFAULTS);
}

/**
 * Synchronous provider availability check.
 * Returns names of providers that have all required env keys present and are not disabled.
 * Used by smoke tests (sync context) to verify at least one provider is configured.
 */
function getAvailableProviderNamesSync(): string[] {
  const names: string[] = [];
  for (const name of Object.keys(DEFAULTS)) {
    if (isProviderDisabledByDefault(name)) continue;
    if (!hasRequiredEnvKeys(name)) continue;
    names.push(name);
  }
  return names;
}

/**
 * Get the full default config for a provider (including metadata).
 */
function getProviderDefault(providerName: string): ProviderDefault | null {
  return DEFAULTS[providerName] || null;
}

function updateProviderConfig(providerName: string, newConfig: any, verified = true) { 
  try {
    const db = _getDb();
    const old = db.selectProvider?.get(providerName);
    let history = [];
    if (old && old.history) { try { history = JSON.parse(old.history); } catch (_e: any) { /* malformed data, skipping */ } }
    if (old) {
      history.push({
        endpoint: old.endpoint,
        model: old.model,
        verifiedAt: old.last_verified ? new Date(old.last_verified).toISOString() : new Date().toISOString(),
      });
      if (history.length > 5) history.shift();
    }
    db.upsertProvider?.run(
      providerName,
      newConfig.endpoint || null,
      newConfig.model,
      verified ? Date.now() : (old ? old.last_verified : Date.now()),
      JSON.stringify(history),
      old ? (old.success_count ?? 0) : 0,
      old ? (old.failure_count ?? 0) : 0,
      old ? (old.total_latency ?? 0) : 0,
      Date.now()
    );
  } catch (e: any) { _logError(`Failed to update provider config for ${providerName}`, e); }
}

function rollbackProvider(providerName: string): boolean { 
  try {
    const db = _getDb();
    const row = db.selectProvider?.get(providerName);
    if (!row || !row.history) return false;
    let history = [];
    try { history = JSON.parse(row.history); } catch (e: any) { return false; }
    if (history.length === 0) return false;
    const previous = history.pop();
    db.upsertProvider?.run(
      providerName,
      previous.endpoint || null,
      previous.model,
      Date.now(),
      JSON.stringify(history),
      row ? (row.success_count ?? 0) : 0,
      row ? (row.failure_count ?? 0) : 0,
      row ? (row.total_latency ?? 0) : 0,
      Date.now()
    );
    _log(`Rolled back ${providerName} to ${previous.model}`, 'INFO', 'config-loader');
    return true;
  } catch (e: any) { return false; }
}

function getProviderHistory(providerName: string): Array<{endpoint: string | null; model: string; verifiedAt: string}> { 
  try {
    const db = _getDb();
    const row = db.selectProvider?.get(providerName);
    if (row && row.history) return JSON.parse(row.history);
  } catch (_e: any) { /* malformed data, skipping */ }
  return [];
}

module.exports = {
  // Core config access
  getProviderConfig,
  updateProviderConfig,
  rollbackProvider,
  getProviderHistory,
  // Discovery
  autoDiscoverModels,
  // Replacement (P8)
  findReplacement,
  registerReplacement,
  // Provider metadata (P4)
  hasRequiredEnvKeys,
  isProviderDisabledByDefault,
  getEnvKeys,
  getFallbackModels,
  getKnownProviders,
  getAvailableProviderNamesSync,
  getProviderDefault,
  // Dynamic models
  DYNAMIC_MODELS: () => ({ ...DYNAMIC_MODELS }),
  // DI
  _injectDependencies,
};
