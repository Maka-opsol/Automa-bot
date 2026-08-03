'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { fetchWithTimeout, extractJSON, sanitizeErrorText } = require('./providers-base');

async function callDeepSeekCodeGen(prompt: any, signal: any) { 
  const apiKey = getCONFIG().DEEPSEEK_CODE_API_KEY;
  if (!apiKey) throw new Error('DeepSeek API key missing');
  const payload = {
    model: getCONFIG().CODE_GEN_MODEL_DEEPSEEK,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2048,
    response_format: { type: 'json_object' }
  };
  const response = await fetchWithTimeout('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });
  if (response.status === 429) throw new Error('DEEPSEEK_RATE_LIMIT');
  if (!response.ok) {
    const errorText = sanitizeErrorText(await response.text());
    throw new Error(`DeepSeek HTTP ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('DeepSeek empty response');
  return extractJSON(raw, 'DeepSeekCodeGen');
}

module.exports = { callDeepSeekCodeGen, _injectDependencies };
