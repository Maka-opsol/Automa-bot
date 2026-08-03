'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCallChatCompletion() { return _deps.providersBase?.callChatCompletion || require('./providers-base').callChatCompletion; }
function getUpsertModel() { return _deps.database?.upsertModel; }
function getGetActiveModel() { return _deps.database?.getActiveModel; }
function getSetModelRole() { return _deps.database?.setModelRole; }
function getGetFallbackModel() { return _deps.database?.getFallbackModel; }

const { discoverAllFreeModels } = require('./services-model-discovery-advanced');
const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

async function runModelTribunal(candidates: any) { 
  log(`⚖️ Model tribunal: ${candidates.length} candidates`, 'INFO', 'evolution');
  const active = getGetActiveModel()?.get();
  if (!active) return candidates.slice(0, 3);
  const modelId = active.model_id;
  const provider = active.provider || 'openrouter';
  const endpoint = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : 'https://api.mistral.ai/v1/chat/completions';
  const apiKey = provider === 'openrouter' ? CONFIG.OPENROUTER_API_KEY : CONFIG.MISTRAL_CODE_API_KEY;
  if (!apiKey) return candidates.slice(0, 3);
  const prompt = `You are choosing the best vision+code model from this list of free models:\n${candidates.map((c: any,i: any) => `${i+1}. ${c.id}`).join('\n')}\nWhich 3 are most capable? Reply with a JSON array of model IDs.`;
  try {
    const response = await getCallChatCompletion()(endpoint, apiKey, modelId, null, prompt, { maxTokens: 100, temperature: 0.0 });
    const content = response.choices?.[0]?.message?.content;
    if (!content) { logError('Tribunal returned empty content', new Error('empty content')); return candidates.slice(0, 3); }
    const match = content.match(/\[.*\]/s);
    if (match) { const voted = JSON.parse(match[0]); return candidates.filter((c: any) => voted.includes(c.id)); }
  } catch (err: any) { logError('Tribunal failed', err); }
  return candidates.slice(0, 3);
}

async function testModel(model: any) { 
  const apiKey = getApiKey(model.provider);
  if (!apiKey) { log(`No API key for provider ${model.provider}, skipping ${model.id}`, 'WARN', 'evolution'); return false; }
  const dummyImage = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';
  const prompt = 'Reply with ONLY valid JSON: {"currentState": "test", "actionType": "wait"}';
  try {
    const response = await getCallChatCompletion()(model.endpoint, apiKey, model.id, dummyImage, prompt, { maxTokens: 50 });
    const content = response.choices?.[0]?.message?.content;
    if (!content) { log(`Model ${model.id} returned empty content`, 'WARN', 'evolution'); return false; }
    JSON.parse(content);
    return true;
  } catch (err: any) {
    // If the model doesn't support image input (404), retry as text-only.
    if (err.message && err.message.includes('404') && err.message.includes('image')) {
      log(`Model ${model.id} doesn't support vision — retrying as text-only`, 'DEBUG', 'evolution');
      try {
        const response = await getCallChatCompletion()(model.endpoint, apiKey, model.id, null, prompt, { maxTokens: 50 });
        const content = response.choices?.[0]?.message?.content;
        if (!content) return false;
        JSON.parse(content);
        return true;
      } catch { return false; }
    }
    log(`Model ${model.id} failed test: ${err.message}`, 'WARN', 'evolution');
    return false;
  }
}

function getApiKey(provider: any) { 
  if (provider === 'openrouter') return CONFIG.OPENROUTER_API_KEY;
  if (provider === 'mistral') return CONFIG.MISTRAL_CODE_API_KEY;
  return null;
}

async function evolveModelsAdvanced() { 
  log('🚀 Starting advanced model evolution...', 'INFO', 'evolution');
  try {
    const allFree = await discoverAllFreeModels();
    if (allFree.length === 0) throw new Error('No free models found');
    const existing = new Set();
    const stmt = require('./database').db.prepare('SELECT model_id FROM model_registry');
    for (const row of stmt.iterate()) existing.add(row.model_id);
    const candidates = allFree.filter((m: any) => !existing.has(m.id));
    if (candidates.length === 0) { log('No new free models to evaluate.', 'INFO', 'evolution'); return { success: true, message: 'No new models' }; }
    const topCandidates = await runModelTribunal(candidates);
    let winner = null;
    for (const candidate of topCandidates) {
      if (await testModel(candidate)) { winner = candidate; break; }
    }
    if (winner) {
      const current = getGetActiveModel()?.get();
      if (current) getSetModelRole()?.run('fallback', current.model_id);
      getUpsertModel()?.run(winner.provider, winner.id, 1, 1, 'active', Date.now(), Date.now(), 0);
      log(`🏆 New active model: ${winner.id} (provider: ${winner.provider})`, 'INFO', 'evolution');
      return { success: true, newModel: winner.id };
    } else { log('No candidate passed tests; keeping current.', 'WARN', 'evolution'); return { success: false, message: 'All candidates failed' }; }
  } catch (err: any) { logError('Evolution crashed', err); const fallback = getGetFallbackModel()?.get(); if (fallback) getSetModelRole()?.run('active', fallback.model_id); return { success: false, error: err.message }; }
}

module.exports = { evolveModelsAdvanced, _injectDependencies };
