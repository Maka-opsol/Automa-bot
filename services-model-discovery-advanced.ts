'use strict';

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const _log = (...args: any[]) => (_deps.logger?.log || console.log)(...args);
const _logError = (...args: any[]) => (_deps.logger?.logError || console.error)(...args);
function _getCONFIG() { return _deps.config || require('./get-config'); }

// Lazy require to avoid circular dependency at module load
let _fetchJSON: any = null;
function _getFetchJSON() { if (!_fetchJSON) { const m = require('./utils-fetch'); _fetchJSON = m.fetchJSON; } return _fetchJSON; }

/**
 * Provider endpoints for programmatic model discovery.
 * Each endpoint returns a JSON list of models.
 *
 * On Render free plan:
 *   - All requests go through fetchJSON (which has timeout via utils-fetch)
 *   - Results are cached per-provider with a TTL to avoid redundant requests
 *   - Vision modality is inferred from model ID to reduce downstream filtering
 */
const PROVIDER_ENDPOINTS: Record<string, { url: string; getHeaders: (cfg: any) => Record<string, string> }> = {
  openrouter: {
    url: 'https://openrouter.ai/api/v1/models',
    getHeaders: (cfg: any) => {
      const h: Record<string, string> = {};
      if (cfg.OPENROUTER_API_KEY) h['Authorization'] = `Bearer ${cfg.OPENROUTER_API_KEY}`;
      return h;
    },
  },
  mistral: {
    url: 'https://api.mistral.ai/v1/models',
    getHeaders: (cfg: any) => {
      const h: Record<string, string> = {};
      if (cfg.MISTRAL_CODE_API_KEY) h['Authorization'] = `Bearer ${cfg.MISTRAL_CODE_API_KEY}`;
      return h;
    },
  },
  groq: {
    url: 'https://api.groq.com/openai/v1/models',
    getHeaders: (cfg: any) => {
      const h: Record<string, string> = {};
      if (cfg.GROQ_API_KEY) h['Authorization'] = `Bearer ${cfg.GROQ_API_KEY}`;
      return h;
    },
  },
};

/** In-memory cache: provider → { models, timestamp } */
const _cache = new Map<string, { models: any[]; timestamp: number }>();

/** Cache TTL in ms — avoids redundant requests within the same evolution cycle */
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Detect if a model likely supports vision based on its ID.
 * Heuristic: model ID contains vision-related keywords.
 * Not perfect, but avoids needing to fetch model details.
 */
function _isLikelyVision(modelId: string): boolean {
  const lower = modelId.toLowerCase();
  return /vision|vlm|vl|multimodal|image|visual/i.test(lower);
}

/**
 * Check if a model is free based on pricing info.
 * A model is considered free if:
 *   - prompt cost === 0 AND completion cost === 0, OR
 *   - model ID contains ':free' (OpenRouter convention)
 */
function _isFreeModel(m: any): boolean {
  const promptCost = parseFloat(m.pricing?.prompt || m.pricing?.promptPrice || '1');
  const completionCost = parseFloat(m.pricing?.completion || '1');
  return (promptCost === 0 && completionCost === 0) || m.id.includes(':free');
}

/**
 * Discover free models from a single provider's API endpoint.
 *
 * Returns an array of { id, provider, endpoint, isVision }.
 * On error, returns empty array (never throws).
 */
async function discoverModels(providerName: string): Promise<any[]> {
  const cfg = _getCONFIG();
  const endpoint = PROVIDER_ENDPOINTS[providerName];
  if (!endpoint) return [];

  // Check cache
  const cached = _cache.get(providerName);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
    return cached.models;
  }

  try {
    const fetchJSON = _getFetchJSON();
    const headers = endpoint.getHeaders(cfg);
    const data = await fetchJSON(endpoint.url, { headers }, 15000);
    // Strip ':free' suffix — OpenRouter uses it for pricing tier but
    // most provider APIs reject it as an unknown model variant.
    const models: any[] = (data.data || []).filter(_isFreeModel).map((m: any) => ({
      id: m.id.replace(/:free$/, ''),
      provider: providerName,
      endpoint: providerName === 'openrouter'
        ? 'https://openrouter.ai/api/v1/chat/completions'
        : providerName === 'mistral'
          ? 'https://api.mistral.ai/v1/chat/completions'
          : providerName === 'groq'
            ? 'https://api.groq.com/openai/v1/chat/completions'
            : null,
      isVision: _isLikelyVision(m.id),
    }));

    // Update cache
    _cache.set(providerName, { models, timestamp: Date.now() });
    return models;
  } catch (err: any) {
    _logError(`Model discovery for ${providerName} failed`, err);
    return [];
  }
}

/**
 * Discover all free models from all configured endpoints.
 *
 * Uses Promise.allSettled for parallelism — each provider's
 * discovery is independent. Failed providers return [] and
 * don't block others.
 *
 * On Render free plan:
 *   - Cache prevents redundant requests within 30 minutes
 *   - All results include isVision flag for downstream filtering
 */
async function discoverAllFreeModels(options: { visionOnly?: boolean } = {}): Promise<any[]> {
  const results = await Promise.allSettled(
    Object.keys(PROVIDER_ENDPOINTS).map(prov => discoverModels(prov))
  );

  const all: any[] = [];
  for (const result of results) {
    if (result.status === 'fulfilled') {
      all.push(...result.value);
    }
  }

  if (options.visionOnly) {
    return all.filter(m => m.isVision);
  }
  return all;
}

module.exports = { discoverAllFreeModels, getFreeModels: discoverModels, _injectDependencies };
