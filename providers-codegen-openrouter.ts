'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { fetchWithTimeout, extractJSON, sanitizeErrorText } = require('./providers-base');

// ─── OpenRouter Rate Limiter (delegates to openrouter-rate-limiter.ts) ──────
// Codegen is CRITICAL priority — it gets 50% of the daily budget.
// All budget logic lives in openrouter-rate-limiter.ts (single source of truth).

let _orLimiter: any = null;
function _getOrLimiter() {
  if (!_orLimiter) _orLimiter = require('./openrouter-rate-limiter');
  return _orLimiter;
}

async function callOpenRouterCodeGenWithModel(prompt: any, signal: any, modelSlug: any) { 
  const apiKey = getCONFIG().OPENROUTER_API_KEY;
  if (!apiKey) throw new Error('OpenRouter API key missing');

  // ─── Daily limit gate (codegen = critical priority) ───
  _getOrLimiter().checkBudget('critical');

  const payload = {
    model: modelSlug,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2048,
    response_format: { type: 'json_object' }
  };
  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': getCONFIG().APP_URL || 'https://mathu-bot.local',
      'X-Title': 'MathU Bot Self-Heal'
    },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const errorText = sanitizeErrorText(await response.text());
    throw new Error(`OpenRouter ${modelSlug} HTTP ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error(`OpenRouter ${modelSlug} empty response`);

  // Record usage after successful call
  _getOrLimiter().recordUsage('critical');

  return extractJSON(raw, `OpenRouter-${modelSlug}`);
}

async function callOpenRouterCodeGen(prompt: any, signal: any) { 
  const defaultModel = getCONFIG().CODE_GEN_MODEL_OPENROUTER || 'openrouter/free';
  return callOpenRouterCodeGenWithModel(prompt, signal, defaultModel);
}

module.exports = { callOpenRouterCodeGen, callOpenRouterCodeGenWithModel, _injectDependencies };
