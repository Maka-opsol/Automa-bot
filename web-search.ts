'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// web-search.ts — Multi-backend web search with fallback chain
// ═══════════════════════════════════════════════════════════════════════════
// BUG FIX (2026-09-04): Previously relied solely on DuckDuckGo's Instant
// Answer API (api.duckduckgo.com), which is:
//   1. NOT a search API — it returns Wikipedia abstracts, not search results
//   2. Often returns empty results for technical queries (model names, APIs)
//   3. Frequently blocked/rate-limited from datacenter IPs (Render, HF Spaces)
//   4. The "fetch failed" error is a network-level failure (DNS/refused)
//
// New design: multiple search backends tried in order until one succeeds.
//   1. DuckDuckGo HTML search (html.duckduckgo.com) — actual search results
//   2. DuckDuckGo Lite (lite.duckduckgo.com) — minimal, less likely to block
//   3. DuckDuckGo Instant Answer API (api.duckduckgo.com) — old fallback
//   4. Direct provider API calls (OpenRouter /models, Cloudflare, etc.)
//
// All backends include a realistic User-Agent header to avoid being blocked.
// ═══════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { fetchWithTimeout, fetchJSON } = require('./utils-fetch');
const { log, logError } = require('./logger');

// Realistic User-Agent to avoid being blocked by search engines.
// Using a recent Chrome UA string — search engines block requests with
// no UA or obvious bot UAs (like "node", "axios", etc.)
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
];

function _getRandomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function _getHeaders(): Record<string, string> {
  return {
    'User-Agent': _getRandomUserAgent(),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
  };
}

// ─── Backend 1: DuckDuckGo HTML Search ─────────────────────────────────────
// Scrapes the HTML search results page. This returns ACTUAL search results
// (unlike the Instant Answer API which returns Wikipedia abstracts).
// URL: https://html.duckduckgo.com/html/?q=QUERY

async function searchDuckDuckGoHTML(query: string): Promise<string | null> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: _getHeaders(),
    }, 15000);

    if (!response.ok) {
      log(`DuckDuckGo HTML search returned HTTP ${response.status}`, 'DEBUG', 'web-search');
      return null;
    }

    const html = await response.text();
    if (!html || html.length < 100) return null;

    // Extract result snippets from the HTML. DuckDuckGo HTML results have
    // result snippets in <a class="result__snippet" ...>TEXT</a> tags.
    // Also extract result titles from <a class="result__a" ...>TITLE</a>.
    const snippets: string[] = [];

    // Extract result snippets
    const snippetRegex = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
    let match;
    while ((match = snippetRegex.exec(html)) !== null) {
      const text = match[1]
        .replace(/<[^>]+>/g, '') // strip inner HTML tags
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (text.length > 20) snippets.push(text);
    }

    // Extract result titles (often contain the key info for model discovery)
    const titleRegex = /class="result__a"[^>]*>([\s\S]*?)<\/a>/g;
    while ((match = titleRegex.exec(html)) !== null) {
      const text = match[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (text.length > 10) snippets.push(text);
    }

    if (snippets.length === 0) return null;
    const result = snippets.slice(0, 10).join(' ');
    log(`DuckDuckGo HTML search: got ${snippets.length} results for "${query}"`, 'DEBUG', 'web-search');
    return result;
  } catch (err: any) {
    log(`DuckDuckGo HTML search failed: ${err.message || err}`, 'DEBUG', 'web-search');
    return null;
  }
}

// ─── Backend 2: DuckDuckGo Lite ────────────────────────────────────────────
// Minimal version of DuckDuckGo, less likely to be blocked.
// URL: https://lite.duckduckgo.com/lite/?q=QUERY

async function searchDuckDuckGoLite(query: string): Promise<string | null> {
  const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
  try {
    const response = await fetchWithTimeout(url, {
      method: 'GET',
      headers: _getHeaders(),
    }, 15000);

    if (!response.ok) {
      log(`DuckDuckGo Lite search returned HTTP ${response.status}`, 'DEBUG', 'web-search');
      return null;
    }

    const html = await response.text();
    if (!html || html.length < 100) return null;

    // DuckDuckGo Lite puts results in <td> elements with class "result-snippet"
    // The HTML is very minimal — just extract text between <td> tags
    const snippets: string[] = [];
    const tdRegex = /<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/g;
    let match;
    while ((match = tdRegex.exec(html)) !== null) {
      const text = match[1]
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim();
      if (text.length > 20) snippets.push(text);
    }

    // Fallback: extract all text from <a> tags if no snippets found
    if (snippets.length === 0) {
      const aRegex = /<a[^>]*class="result-link"[^>]*>([\s\S]*?)<\/a>/g;
      while ((match = aRegex.exec(html)) !== null) {
        const text = match[1]
          .replace(/<[^>]+>/g, '')
          .replace(/&amp;/g, '&')
          .trim();
        if (text.length > 10) snippets.push(text);
      }
    }

    if (snippets.length === 0) return null;
    const result = snippets.slice(0, 10).join(' ');
    log(`DuckDuckGo Lite search: got ${snippets.length} results for "${query}"`, 'DEBUG', 'web-search');
    return result;
  } catch (err: any) {
    log(`DuckDuckGo Lite search failed: ${err.message || err}`, 'DEBUG', 'web-search');
    return null;
  }
}

// ─── Backend 3: DuckDuckGo Instant Answer API (old fallback) ───────────────

async function searchDuckDuckGo(query: string): Promise<string | null> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const data = await fetchJSON(url, { headers: _getHeaders() }, 20000);
    let results: string[] = [];
    if (data.AbstractText) results.push(data.AbstractText);
    if (data.RelatedTopics) {
      for (const topic of data.RelatedTopics) {
        if (topic.Text) results.push(topic.Text);
      }
    }
    if (data.Infobox && data.Infobox.content) {
      for (const item of data.Infobox.content) {
        if (item.value) results.push(item.value);
      }
    }
    if (results.length === 0) return null;
    return results.join(' ');
  } catch (err: any) {
    log(`DuckDuckGo API search failed: ${err.message || err}`, 'DEBUG', 'web-search');
    return null;
  }
}

// ─── Backend 4: Direct Provider API calls ──────────────────────────────────
// For model discovery queries, try the provider's own model listing API first.
// This is more reliable than web search because it's the authoritative source.

async function fetchOpenRouterModels(): Promise<string | null> {
  try {
    const data = await fetchJSON('https://openrouter.ai/api/v1/models', { headers: _getHeaders() }, 15000);
    const models = data.data || [];
    return models.map((m: any) => m.id).join(', ');
  } catch (err: any) {
    logError('OpenRouter model fetch failed', err);
    return null;
  }
}

async function fetchCloudflareModels(): Promise<string | null> {
  // Cloudflare Workers AI models are listed at:
  // https://developers.cloudflare.com/workers-ai/models/
  // We can't easily scrape that, but we can try the API directly if we have a key.
  try {
    const CONFIG = getCONFIG();
    const accountId = CONFIG.CLOUDFLARE_ACCOUNT_ID || process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = CONFIG.CLOUDFLARE_API_TOKEN || process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiToken) return null;
    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/models/search`;
    const data = await fetchJSON(url, {
      headers: {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json',
      },
    }, 15000);
    if (data.result && Array.isArray(data.result)) {
      return data.result.map((m: any) => m.name || m.id).join(', ');
    }
    return null;
  } catch (err: any) {
    log(`Cloudflare model fetch failed: ${err.message || err}`, 'DEBUG', 'web-search');
    return null;
  }
}

async function fetchGroqModels(): Promise<string | null> {
  try {
    const CONFIG = getCONFIG();
    const apiKey = CONFIG.GROQ_API_KEY || process.env.GROQ_API_KEY;
    if (!apiKey) return null;
    const data = await fetchJSON('https://api.groq.com/openai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 15000);
    if (data.data && Array.isArray(data.data)) {
      return data.data.map((m: any) => m.id).join(', ');
    }
    return null;
  } catch (err: any) {
    log(`Groq model fetch failed: ${err.message || err}`, 'DEBUG', 'web-search');
    return null;
  }
}

async function fetchCerebrasModels(): Promise<string | null> {
  try {
    const CONFIG = getCONFIG();
    const apiKey = CONFIG.CEREBRAS_API_KEY || process.env.CEREBRAS_API_KEY;
    if (!apiKey) return null;
    const data = await fetchJSON('https://api.cerebras.ai/v1/models', {
      headers: { 'Authorization': `Bearer ${apiKey}` },
    }, 15000);
    if (data.data && Array.isArray(data.data)) {
      return data.data.map((m: any) => m.id).join(', ');
    }
    return null;
  } catch (err: any) {
    log(`Cerebras model fetch failed: ${err.message || err}`, 'DEBUG', 'web-search');
    return null;
  }
}

/**
 * Check if the query is a model-discovery query for a specific provider.
 * If so, try that provider's own model listing API first (most reliable).
 */
async function _tryProviderModelAPI(query: string): Promise<string | null> {
  const q = query.toLowerCase();

  // OpenRouter model discovery
  if (q.includes('openrouter') || (q.includes('model') && q.includes('openrouter'))) {
    const or = await fetchOpenRouterModels();
    if (or && or.length > 20) return or;
  }

  // Cloudflare Workers AI model discovery
  if (q.includes('cloudflare') || q.includes('workers ai') || q.includes('@cf/')) {
    const cf = await fetchCloudflareModels();
    if (cf && cf.length > 20) return cf;
  }

  // Groq model discovery
  if (q.includes('groq')) {
    const groq = await fetchGroqModels();
    if (groq && groq.length > 20) return groq;
  }

  // Cerebras model discovery
  if (q.includes('cerebras')) {
    const cerebras = await fetchCerebrasModels();
    if (cerebras && cerebras.length > 20) return cerebras;
  }

  return null;
}

// ─── Main search function — tries backends in order ────────────────────────

async function searchWeb(query: any, _maxResults = 1): Promise<string | null> {
  if (!getCONFIG().WEB_SEARCH_ENABLED) {
    log('Web search disabled by config.', 'DEBUG', 'web-search');
    return null;
  }
  const queryStr = String(query || '');
  log(`🌐 Searching web for: "${queryStr}"`, 'DEBUG', 'web-search');

  // ── Backend 0: Try provider's own model API first (most reliable) ──
  // For model-discovery queries, the provider's own /v1/models endpoint is
  // the authoritative source — no web search needed.
  const providerResult = await _tryProviderModelAPI(queryStr);
  if (providerResult && providerResult.length > 20) {
    log(`Provider API returned model list (${providerResult.length} chars) for "${queryStr}"`, 'INFO', 'web-search');
    return providerResult;
  }

  // ── Backend 1: DuckDuckGo HTML search ──
  let result = await searchDuckDuckGoHTML(queryStr);
  if (result && result.length > 20) return result;

  // ── Backend 2: DuckDuckGo Lite ──
  result = await searchDuckDuckGoLite(queryStr);
  if (result && result.length > 20) return result;

  // ── Backend 3: DuckDuckGo Instant Answer API (old fallback) ──
  result = await searchDuckDuckGo(queryStr);
  if (result && result.length > 20) return result;

  // ── Backend 4: OpenRouter models API (for openrouter queries) ──
  if (queryStr.toLowerCase().includes('model') && queryStr.toLowerCase().includes('openrouter')) {
    const or = await fetchOpenRouterModels();
    if (or) return or;
  }

  return null;
}

module.exports = { searchWeb, _injectDependencies };
