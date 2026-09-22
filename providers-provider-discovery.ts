'use strict';

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function _log(...args: any[]) { return (_deps.logger?.log || console.log)(...args); }
function _logError(...args: any[]) { return (_deps.logger?.logError || console.error)(...args); }
function _getCONFIG() { return _deps.config || require('./get-config'); }

// Lazy requires to avoid circular deps at module load time
let _webSearch: any = null;
let _configLoader: any = null;
function _getWebSearch() { if (!_webSearch) { try { _webSearch = require('./web-search'); } catch { _webSearch = null; } } return _webSearch; }
function _getConfigLoader() { if (!_configLoader) { try { _configLoader = require('./providers-config-loader'); } catch { _configLoader = null; } } return _configLoader; }

/**
 * Provider-specific model discovery configs.
 * On Render free plan, web search is expensive (8 HTTP requests).
 * Discovery is now:
 *   1. Rate-limited (cooldown between full refreshes)
 *   2. Selective (only discover for providers that need it)
 *   3. Non-destructive (bad regex matches don't overwrite DB config)
 */
const PROVIDER_QUERIES = {
  'Groq': 'Groq llama-3.3-70b versatile vision model',
  'GitHub GPT': 'GitHub Models Azure OpenAI gpt-4o-mini',
  'z.ai': 'z.ai GLM-4.6V-Flash model',
  'Agnes': 'Agnes AI 2.0 flash model',
  'NVIDIA': 'NVIDIA NIM llama-3.1-8b-instruct',
  'Cloudflare': 'Cloudflare Workers AI llama-4-scout',
  'Cerebras': 'Cerebras gemma model fast inference',
  'Gemini': 'Gemini 1.5 flash model',
};

/** Default model names when web search fails */
const PROVIDER_DEFAULTS: Record<string, string> = {
  'Groq': 'llama-3.3-70b-versatile',
  'GitHub GPT': 'gpt-4o-mini',
  'z.ai': 'GLM-4.6V-Flash',
  'Agnes': 'agnes-2.0-flash',
  'NVIDIA': 'meta/llama-3.1-8b-instruct',
  'Cloudflare': '@cf/meta/llama-4-scout-17b-16e-instruct',
  'Cerebras': 'gemma-4-31b',
  'Gemini': 'gemini-2.5-flash',
};

/** Regex patterns to extract model names from web search results */
const MODEL_PATTERNS: Record<string, RegExp> = {
  'Groq': /llama-3[\d.]*-[\w-]*vision[\w-]*/i,
  'GitHub GPT': /gpt-4[\w.-]*/i,
  'z.ai': /GLM-[\d.]+V-[\w-]+/i,
  'Agnes': /agnes-[\d.]+-[\w-]+/i,
  'NVIDIA': /meta\/llama-[\d.]+-[\w-]*/i,
  'Cloudflare': /@cf\/meta\/llama-[\d.]+-[\w-]*/i,
  'Cerebras': /gemma-[\d]+-[\w-]+/i,
  'Gemini': /gemini-[\d.]+-[\w-]+/i,
};

/** Minimum time (ms) between full refreshes. On Render free plan, web searches are expensive. */
const REFRESH_COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes

let _lastRefreshTime = 0;
let _isRefreshing = false;

/**
 * Extract a model name from unstructured web search text.
 * Falls back to default if no match found.
 */
function extractModelName(text: any, providerName: string): string | null {
  if (!text || typeof text !== 'string') {
    return PROVIDER_DEFAULTS[providerName] || null;
  }
  const pattern = MODEL_PATTERNS[providerName];
  if (pattern) {
    const match = text.match(pattern);
    if (match) return match[0];
  }
  return PROVIDER_DEFAULTS[providerName] || null;
}

/**
 * Discover a single provider's model via web search.
 * Returns { providerName, model, source } or null.
 * Source is 'web_search' or 'default' for diagnostic purposes.
 */
async function discoverProviderModel(providerName: string): Promise<{ providerName: string; model: string; source: string } | null> {
  const query = PROVIDER_QUERIES[providerName];
  if (!query) return null;

  // Try web search first
  const ws = _getWebSearch();
  if (ws) {
    try {
      _log(`Discovering model for ${providerName}...`, 'DEBUG', 'provider-discovery');
      const result = await ws.searchWeb(query);
      if (result) {
        const model = extractModelName(result, providerName);
        if (model) {
          _log(`Found model for ${providerName}: ${model} (web search)`, 'INFO', 'provider-discovery');
          return { providerName, model, source: 'web_search' };
        }
      }
    } catch (e: any) {
      _logError(`Web search failed for ${providerName}`, e);
    }
  }

  // Fall back to default
  const defaultModel = PROVIDER_DEFAULTS[providerName];
  if (defaultModel) {
    _log(`Using default model for ${providerName}: ${defaultModel}`, 'DEBUG', 'provider-discovery');
    return { providerName, model: defaultModel, source: 'default' };
  }
  return null;
}

/**
 * Refresh models for all providers.
 *
 * On Render free plan:
 *   - 30-minute cooldown between full refreshes (prevents web search bombardment)
 *   - Mutex prevents concurrent refreshes
 *   - Sequential (not parallel) to avoid network I/O burst
 *   - Only updates DB when model actually changed AND source is 'web_search'
 *     (defaults don't overwrite existing DB config)
 *
 * @param options.force - Skip cooldown check
 * @param options.providerNames - Only refresh specific providers
 * @returns number of providers updated
 */
async function refreshAllProviderModels(options: { force?: boolean; providerNames?: string[] } = {}): Promise<number> {
  const now = Date.now();
  const cooldown = _getCONFIG().PROVIDER_DISCOVERY_COOLDOWN_MS || REFRESH_COOLDOWN_MS;

  if (_isRefreshing) {
    _log('Provider discovery already in progress, skipping', 'DEBUG', 'provider-discovery');
    return 0;
  }

  if (!options.force && (now - _lastRefreshTime) < cooldown) {
    _log(`Provider discovery cooldown active (${Math.round((cooldown - (now - _lastRefreshTime)) / 1000)}s remaining)`, 'DEBUG', 'provider-discovery');
    return 0;
  }

  _isRefreshing = true;
  _lastRefreshTime = now;

  const loader = _getConfigLoader();
  if (!loader) {
    _log('Provider config loader unavailable', 'WARN', 'provider-discovery');
    _isRefreshing = false;
    return 0;
  }

  const targetProviders = options.providerNames || Object.keys(PROVIDER_QUERIES);
  let updatedCount = 0;

  // Sequential to avoid network I/O burst on Render
  for (const providerName of targetProviders) {
    try {
      const result = await discoverProviderModel(providerName);
      if (!result) continue;

      // Only update DB if discovered via web search (not default)
      // Defaults should not overwrite existing DB config
      if (result.source !== 'web_search') continue;

      const current = loader.getProviderConfig(providerName);
      if (current && current.model !== result.model) {
        // BUG FIX (2026-09-04): Was `model` (undefined variable — ReferenceError).
        // The discovered model is `result.model`, not a bare `model`.
        loader.updateProviderConfig(providerName, { ...current, model: result.model }, false);
        updatedCount++;
        _log(`Updated ${providerName} model to ${result.model}`, 'INFO', 'provider-discovery');
      }
    } catch (e: any) {
      _logError(`Failed to discover model for ${providerName}`, e);
    }
  }

  _isRefreshing = false;
  return updatedCount;
}

module.exports = { refreshAllProviderModels, discoverProviderModel, _injectDependencies };
