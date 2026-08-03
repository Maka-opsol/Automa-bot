'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCallChatCompletion() { return _deps.providersBase?.callChatCompletion || require('./providers-base').callChatCompletion; }
function getUpsertModel() { return _deps.database?.upsertModel; }
function getGetActiveModel() { return _deps.database?.getActiveModel; }
function getGetFallbackModel() { return _deps.database?.getFallbackModel; }
function getSetModelRole() { return _deps.database?.setModelRole; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }

const { fetchJSON } = require('./utils-fetch');
const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

function getActiveProviderDetails() { 
  const activeModel = getGetActiveModel()?.get();
  const modelId = activeModel ? activeModel.model_id : 'openrouter/free';
  if (modelId.includes('openrouter')) { return { endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: CONFIG.OPENROUTER_API_KEY, model: modelId }; } else if (modelId.includes('mistral')) { return { endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKey: CONFIG.MISTRAL_CODE_API_KEY, model: modelId }; }
  return { endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: CONFIG.OPENROUTER_API_KEY, model: modelId };
}

async function discoverFreeModels(provider = 'openrouter') { 
  log('🔍 Discovering free models via API...', 'INFO', 'evolution');
  const url = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/models' : 'https://api.mistral.ai/v1/models';
  const headers = provider === 'openrouter' ? {} : { 'Authorization': `Bearer ${CONFIG.MISTRAL_CODE_API_KEY}` };
  const data = await fetchJSON(url, { headers }, 15000);
  const freeModels = (data.data || []).filter((m: any) => { const promptCost = parseFloat(m.pricing?.prompt || '1'); const completionCost = parseFloat(m.pricing?.completion || '1'); return promptCost === 0 && completionCost === 0; }).map((m: any) => m.id);
  log(`Found ${freeModels.length} free models.`, 'INFO', 'evolution');
  return freeModels;
}

async function runMetaTribunal(candidateModels: any) { 
  log('⚖️ Running Meta-Tribunal (Asking current AI to vote)...', 'INFO', 'evolution');
  const { endpoint, apiKey, model } = getActiveProviderDetails();
  if (!apiKey) { log('⚠️ No API key for active model, skipping meta-tribunal.', 'WARN', 'evolution'); return [candidateModels[0]]; }
  const prompt = `You are an AI selecting a new AI model for an automated bot that analyzes screenshots (vision) and writes code.\nHere is a list of FREE models currently available:\n${candidateModels.map((m: any, i: any) => `${i+1}. ${m}`).join('\n')}\nBased on their names, which 2 models are most likely to be good at vision AND code generation?\nReply ONLY with a JSON array of strings, e.g., ["model/id/1", "model/id/2"]`;
  try {
    const response = await getCallChatCompletion()(endpoint, apiKey, model, null, prompt, { maxTokens: 100, temperature: 0.0 });
    const text = response.choices?.[0]?.message?.content;
    if (!text) { log('Meta-tribunal returned empty content', 'WARN', 'evolution'); return [candidateModels[0]]; }
    const match = text.match(/\[.*\]/s);
    if (match) { const votes = JSON.parse(match[0]); log(`Tribunal voted for: ${votes.join(', ')}`, 'INFO', 'evolution'); return votes; }
  } catch (err: any) { logError('Tribunal failed to vote', err); }
  return [candidateModels[0]];
}

async function safeTestModel(modelId: any) { 
  log(`🧪 Safe-testing model: ${modelId}...`, 'INFO', 'evolution');
  const dummyImage = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';
  const testPrompt = 'Reply with ONLY valid JSON: {"currentState": "test", "actionType": "wait"}';
  try {
    const response = await getCallChatCompletion()('https://openrouter.ai/api/v1/chat/completions', CONFIG.OPENROUTER_API_KEY, modelId, dummyImage, testPrompt, { maxTokens: 50, temperature: 0.0 });
    const content = response.choices?.[0]?.message?.content;
    if (!content) {
      log(`❌ Model ${modelId} returned empty content`, 'WARN', 'evolution');
      return false;
    }
    JSON.parse(content);
    log(`✅ Model ${modelId} passed the test!`, 'INFO', 'evolution');
    return true;
  } catch (err: any) { log(`❌ Model ${modelId} failed test: ${err.message}`, 'WARN', 'evolution'); return false; }
}

async function evolveModels() { 
  log('🚀 Starting Model Evolution Pipeline...', 'INFO', 'evolution');
  try {
    const freeModels = await discoverFreeModels('openrouter');
    if (freeModels.length === 0) throw new Error('No free models found');
    const topCandidates = await runMetaTribunal(freeModels.slice(0, 20));
    const topModels = freeModels.slice(0, 10);
    for (const m of topModels) { getUpsertModel()?.run('openrouter', m, 1, 0, 'candidate', Date.now(), null, 0); }
    let newWinner = null;
    for (const candidate of topCandidates) {
      getUpsertModel()?.run('openrouter', candidate, 1, 0, 'candidate', Date.now(), null, 0);
      if (await safeTestModel(candidate)) { newWinner = candidate; break; } else { getUpsertModel()?.run('openrouter', candidate, 1, 0, 'dead', Date.now(), null, 1); }
    }
    const currentActive = getGetActiveModel()?.get();
    if (newWinner) {
      log(`🏆 New model chosen: ${newWinner}`, 'INFO', 'evolution');
      if (currentActive) { getSetModelRole()?.run('fallback', currentActive.model_id); }
      getUpsertModel()?.run('openrouter', newWinner, 1, 1, 'active', Date.now(), Date.now(), 0);
      getUpsertCalibration()?.run('last_evolution_timestamp', String(Date.now()), Date.now());
      return { success: true, newModel: newWinner, message: 'Evolution successful!' };
    } else {
      log(`⚠️ All candidates failed! Rolling back...`, 'ERROR', 'evolution');
      const fallback = getGetFallbackModel()?.get();
      if (fallback) { getSetModelRole()?.run('active', fallback.model_id); getUpsertCalibration()?.run('last_evolution_timestamp', String(Date.now()), Date.now()); return { success: false, newModel: fallback.model_id, message: 'All failed, rolled back to fallback.' }; }
      throw new Error('Evolution failed and no fallback model exists!');
    }
  } catch (err: any) { logError('Evolution pipeline crashed', err); const fallback = getGetFallbackModel()?.get(); if (fallback) getSetModelRole()?.run('active', fallback.model_id); getUpsertCalibration()?.run('last_evolution_timestamp', String(Date.now()), Date.now()); return { success: false, error: err.message }; }
}

module.exports = { evolveModels, discoverFreeModels, _injectDependencies };
