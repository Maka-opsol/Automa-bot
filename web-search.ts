'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { fetchJSON } = require('./utils-fetch');
const { log, logError } = require('./logger');

async function searchDuckDuckGo(query: any) { 
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`;
  try {
    const data = await fetchJSON(url, {}, 10000);
    let results = [];
    if (data.AbstractText) results.push(data.AbstractText);
    if (data.RelatedTopics) { for (const topic of data.RelatedTopics) { if (topic.Text) results.push(topic.Text); } }
    if (data.Infobox && data.Infobox.content) { for (const item of data.Infobox.content) { if (item.value) results.push(item.value); } }
    return results.join(' ');
  } catch (err: any) { logError('DuckDuckGo search failed', err); return null; }
}

async function fetchOpenRouterModels() { 
  try {
    const data = await fetchJSON('https://openrouter.ai/api/v1/models', {}, 15000);
    const models = data.data || [];
    return models.map((m: any) => m.id).join(', ');
  } catch (err: any) { logError('OpenRouter model fetch failed', err); return null; }
}

async function searchWeb(query: any, _maxResults = 1) { 
  if (!getCONFIG().WEB_SEARCH_ENABLED) { log('Web search disabled by config.', 'DEBUG', 'web-search'); return null; }
  log(`🌐 Searching web for: "${query}"`, 'DEBUG', 'web-search');
  let result = await searchDuckDuckGo(query);
  if (result && result.length > 20) return result;
  if (query.toLowerCase().includes('model') && query.toLowerCase().includes('openrouter')) {
    const or = await fetchOpenRouterModels();
    if (or) return or;
  }
  return null;
}

module.exports = { searchWeb, _injectDependencies };
