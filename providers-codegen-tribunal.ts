'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { callMistralCodeGen } = require('./providers-codegen-mistral');
const { callQwenCodeGen } = require('./providers-codegen-qwen');
const { callDeepSeekCodeGen } = require('./providers-codegen-deepseek');
const { callOpenRouterCodeGenWithModel } = require('./providers-codegen-openrouter');
const { log, logError } = require('./logger');


function validateFix(fix: any) { 
  if (!fix || typeof fix !== 'object') return false;
  if (!fix.file || typeof fix.file !== 'string') return false;
  if (!fix.change || typeof fix.change !== 'string') return false;
  if (!fix.patch || typeof fix.patch !== 'string') return false;
  if (fix.patch.trim().length < 5) return false;
  return true;
}

function validateFixArray(parsed: any) { 
  if (!Array.isArray(parsed)) parsed = [parsed];
  return parsed.filter(validateFix);
}

async function generateCodeFixViaTribunal(investigationData: any, errorLogs: any, signal: any) { 
  let modelDiscovery;
  try { modelDiscovery = require('./services-model-discovery-advanced'); } catch (e: any) { modelDiscovery = null; }
  if (!modelDiscovery) { log('model-discovery-advanced not available', 'WARN', 'codegen'); return null; }
  const provider = getCONFIG().CODE_GEN_PROVIDERS.find((p: any) => p.name === 'openrouter');
  let orModels = [];
  if (provider && getCONFIG().OPENROUTER_API_KEY) {
    const freeModels = await modelDiscovery.getFreeModels(provider.name);
    // ── HARD COST GUARD ── Only keep models with :free suffix
    orModels = (freeModels || []).map((m: any) => m.id).filter((id: string) => id.includes(':free'));
  }
  if (orModels.length === 0) { orModels = ['openrouter/free']; }
  let totalModels = orModels.length;
  if (getCONFIG().MISTRAL_CODE_API_KEY) totalModels++;
  if (getCONFIG().QWEN_CODE_API_KEY) totalModels++;
  if (getCONFIG().DEEPSEEK_CODE_API_KEY) totalModels++;
  log(`\u{1f9e0} SUPER TRIBUNAL: Consulting ${totalModels} models (${orModels.length} via OpenRouter + Mistral + Qwen + DeepSeek)...`, 'INFO', 'codegen');
  const prompt = buildCodeGenPrompt(investigationData, errorLogs);
  const allPromises = [];
  for (const modelSlug of orModels) {
    if (getCONFIG().OPENROUTER_API_KEY) { allPromises.push(callOpenRouterCodeGenWithModel(prompt, signal, modelSlug).then((result: any) => ({ provider: `OR/${modelSlug}`, fixes: validateFixArray(result) })).catch((err: any) => ({ provider: `OR/${modelSlug}`, fixes: [], error: err.message }))); }
  }
  if (getCONFIG().MISTRAL_CODE_API_KEY) { allPromises.push(callMistralCodeGen(prompt, signal).then((result: any) => ({ provider: 'Mistral', fixes: validateFixArray(result) })).catch((err: any) => ({ provider: 'Mistral', fixes: [], error: err.message }))); }
  if (getCONFIG().QWEN_CODE_API_KEY) { allPromises.push(callQwenCodeGen(prompt, signal).then((result: any) => ({ provider: 'Qwen', fixes: validateFixArray(result) })).catch((err: any) => ({ provider: 'Qwen', fixes: [], error: err.message }))); }
  if (getCONFIG().DEEPSEEK_CODE_API_KEY) { allPromises.push(callDeepSeekCodeGen(prompt, signal).then((result: any) => ({ provider: 'DeepSeek', fixes: validateFixArray(result) })).catch((err: any) => ({ provider: 'DeepSeek', fixes: [], error: err.message }))); }
  const results = await Promise.allSettled(allPromises) as PromiseSettledResult<{ provider: string; fixes: any[]; error?: string }>[];
  const validResponses = results.filter(r => r.status === 'fulfilled' && r.value.fixes.length > 0).map((r: any) => (r as any).value);
  if (validResponses.length === 0) { log(`\u274c No valid fixes from ANY of the ${totalModels} models.`, 'ERROR', 'codegen'); return null; }
  log(`\u{1f4ca} ${validResponses.length}/${totalModels} models returned valid fixes.`, 'INFO', 'codegen');
  const fixVotes = new Map();
  for (const resp of validResponses) {
    for (const fix of resp.fixes) {
      const key = `${fix.file}::${fix.patch.substring(0, 80)}`;
      if (!fixVotes.has(key)) { fixVotes.set(key, { fix, count: 0, providers: [] }); }
      const entry = fixVotes.get(key);
      entry.count++;
      entry.providers.push(resp.provider);
    }
  }
  const sortedVotes = Array.from(fixVotes.values()).sort((a, b) => b.count - a.count);
  const best = sortedVotes[0];
  const required = getCONFIG().CODE_GEN_CONSENSUS_THRESHOLD ?? 5;
  if (best && best.count >= required) { log(`\u2705 SUPER CONSENSUS: ${best.count}/${validResponses.length} models (${best.providers.join(', ')}) agree on ${best.fix.file}.`, 'INFO', 'codegen'); return [best.fix]; }
  if (validResponses.length >= 6) { log(`\u274c No super-majority (best: ${best?.count || 0}/${validResponses.length}). Aborting to avoid corruption.`, 'ERROR', 'codegen'); return null; }
  if (best) { log(`\u26a0\ufe0f Limited responses (${validResponses.length}/${totalModels}). Using fallback fix from ${best.providers[0]}.`, 'WARN', 'codegen'); return [best.fix]; }
  return null;
}

function buildCodeGenPrompt(investigationData: any, errorLogs: any) { 
  return `
You are a senior Node.js developer fixing an automation bot.
CONTEXT:
- Error/Stagnation reason: ${errorLogs || 'Unknown recurring failure'}
- Current URL: ${investigationData.url || 'Unknown'}
- HTML Snippet: ${(investigationData.html || '').substring(0, 1500)}
- Target file to fix: ${investigationData.targetFile || 'Unknown'}
The bot is failing due to UI changes or logic errors.
Here is the current content of the file that likely needs fixing:
--- BEGIN FILE: ${investigationData.targetFile} ---
${(investigationData.fileContent || '').substring(0, 8000)}
--- END FILE ---
INSTRUCTIONS:
1. Identify the exact bug or missing selector/logic.
2. Propose a fix.
3. Return a JSON ARRAY of objects. Each object must have:
- "file": (string) relative path
- "change": (string) human-readable description
- "patch": (string) either a UNIFIED DIFF (starting with --) or the COMPLETE REPLACEMENT code.
If no fix is needed, return an empty array.
ONLY return valid JSON. No markdown, no explanations outside the JSON.
`;
}

module.exports = { generateCodeFixViaTribunal, _injectDependencies };
