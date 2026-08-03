'use strict';

// Lazy requires to avoid top-level circular dependency chain
const { getAvailableProviders, addProviderFailure, getProviderCycleState, recordProviderResult } = require('./providers-registry');

// Lazy logger — loaded on first use
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

// Lazy providers-base — loaded on first use
let _providersBase: any = null;
function _getProvidersBase() { if (!_providersBase) _providersBase = require('./providers-base'); return _providersBase; }

// Lazy providers-prompts — loaded on first use
let _prompts: any = null;
function _getPrompts() { if (!_prompts) _prompts = require('./providers-prompts'); return _prompts; }

function findMajorityCluster(validResults: any) { 
  const clusters = {};
  for (const res of validResults) {
    const key = `${res.currentState || 'unknown'}::${res.actionType}`;
    if (!(clusters as any)[key]) (clusters as any)[key] = [];
    (clusters as any)[key].push(res);
  }
  const sorted = Object.values(clusters).sort((a: any, b: any) => (b as any).length - (a as any).length);
  if (sorted.length === 0) return null;
  if (validResults.length === 1) {
    // Single provider — accept its result directly without requiring a cluster
    return { cluster: [sorted[0]], size: 1, total: 1 };
  }
  if ((sorted[0] as any).length < 2) return null;
  return { cluster: sorted[0] as any, size: (sorted[0] as any).length, total: validResults.length };
}

async function runTribunal(base64Image: any, pageUrl = null, uiMap = null, signal = null) {
  const { log } = _getLogger();
  const { safeCall } = _getProvidersBase();
  const { getSystemPrompt, getUserInstruction } = _getPrompts();
  const providers = await getAvailableProviders();
  if (providers.length === 0) {
    log('❌ No vision API keys configured.', 'ERROR', 'tribunal');
    return { actionType: 'wait', currentState: 'error', reasoning: 'No providers', targetX: 0, targetY: 0 };
  }
  let mapHint = '';
  if (uiMap) { mapHint = `\nUI MAP (from exploration): ${JSON.stringify(uiMap).substring(0, 500)}\nUse this map to guide actions.\n`; }
  const urlHint = pageUrl ? `\nCURRENT PAGE URL: ${pageUrl}\nUse this URL as an additional hint for state detection.\n` : '';
  const fullPrompt = `${getSystemPrompt()}${urlHint}${mapHint}\n${getUserInstruction()}`;
  log(`Tribunal: consulting ${providers.length} model(s)...`, 'INFO', 'tribunal');
  const results: PromiseSettledResult<any>[] = await Promise.allSettled(
    providers.map(async (provider: any) => {
      const start = Date.now();
      try {
        const res = await safeCall(
          (sig: any) => provider.fn(base64Image, fullPrompt, sig || signal, { validate: true }),
          `Tribunal ${provider.name}`,
          { url: provider.name, maxRetries: 2, baseDelay: 1000, signal }
        );
        const latency = Date.now() - start;
        recordProviderResult(provider.name, true, latency);
        return { ...res, _model: provider.name };
      } catch (err: any) {
        recordProviderResult(provider.name, false, Date.now() - start);
        addProviderFailure(provider.name);
        const errMsg = err && err.message ? String(err.message) : String(err);
        if (provider.name === 'GitHub GPT' && errMsg.includes('RATE_LIMIT')) {
          const state = getProviderCycleState();
          state.githubRateLimitCount++;
          if (state.githubRateLimitCount >= 3 && !state.githubSwappedOut) {
            state.githubSwappedOut = true;
            log('🔀 GitHub GPT rate-limited 3× this cycle -- swapping to z.ai for remainder of cycle', 'WARN', 'tribunal');
          }
        }
        log(`⚠️ ${provider.name} failed: ${errMsg}`, 'WARN', 'tribunal');
        return null;
      }
    })
  );
  // M4 FIX: Normalize failure handling — filter out empty/malformed results
  // that some providers silently return instead of throwing. A result is only
  // considered a valid vote if it has non-empty actionType and currentState.
  const fulfilled = results.filter(r => r.status === 'fulfilled' && r.value !== null).map((r: any) => (r as any).value);
  const valid = fulfilled.filter(r => {
    if (!r) return false;
    const hasAction = r.actionType && typeof r.actionType === 'string' && r.actionType.trim().length > 0;
    const hasState = r.currentState && typeof r.currentState === 'string' && r.currentState.trim().length > 0;
    if (!hasAction || !hasState) {
      log(`⚠️ Tribunal: filtered out empty/malformed result from ${r._model || 'unknown'} (actionType=${JSON.stringify(r.actionType)}, currentState=${JSON.stringify(r.currentState)})`, 'WARN', 'tribunal');
      return false;
    }
    return true;
  });

  if (valid.length === 0) {
    log('⚠️ No valid model responses -- falling back to wait.', 'WARN', 'tribunal');
    return { actionType: 'wait', currentState: 'error', reasoning: 'No valid responses', targetX: 0, targetY: 0 };
  }
  if (valid.length === 1) {
    log(`✅ Single valid response from ${valid[0]._model}: ${valid[0].currentState} / ${valid[0].actionType}`, 'INFO', 'tribunal');
    const { _model, ...action } = valid[0];
    return { ...action, reasoning: `Tribunal (1 model - ${_model}): ${action.reasoning}` };
  }
  const majority = findMajorityCluster(valid);
  if (!majority) {
    const { _model, ...action } = valid[0];
    log(`⚠️ No majority -- picking first valid response from ${_model}: ${action.currentState} / ${action.actionType}`, 'WARN', 'tribunal');
    return { ...action, reasoning: `Tribunal (no majority -- first response from ${_model}): ${action.reasoning}` };
  }
  log(`✅ Tribunal consensus: ${majority.size}/${majority.total} models agree on ${(majority.cluster as any)[0].currentState} / ${(majority.cluster as any)[0].actionType}`, 'INFO', 'tribunal');
  const rep = (majority.cluster as any)[0];
  return {
    currentState: rep.currentState,
    reasoning: `Tribunal (${majority.size} models): ${rep.reasoning}`,
    actionType: rep.actionType,
    targetX: rep.targetX ?? 0,
    targetY: rep.targetY ?? 0,
    value: rep.value ?? '',
    keypadSequence: rep.keypadSequence,
    submitX: rep.submitX ?? 0,
    submitY: rep.submitY ?? 0,
  };
}

module.exports = { runTribunal };
