'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { fetchWithTimeout, sanitizeErrorText } = require('./providers-base');

/**
 * Parse a codegen response from Mistral.
 *
 * Unlike vision/action responses, codegen returns arrays of
 * { file, change, patch } — NOT action objects with actionType.
 * So we do NOT use extractJSON (which only looks for actionType).
 *
 * Handles:
 *  1. Direct JSON array:  [{"file":...}]
 *  2. Wrapped object:     {"fixes":[{"file":...}]}
 *  3. Double-escaped:     \"[{\\\"file\\\":...}]\"  (response_format quirk)
 *  4. Markdown code block: ```json ... ```
 */
function parseCodegenResponse(raw: string): any {
  if (!raw || typeof raw !== 'string') return null;
  let text = raw.trim();

  // Strip markdown code fences if present
  const fenceMatch = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```\s*$/);
  if (fenceMatch) text = fenceMatch[1].trim();

  // Attempt 1: Direct parse
  try { return JSON.parse(text); } catch {}

  // Attempt 2: Double-escaped JSON — some providers (Mistral with
  // response_format:json_object) return a JSON string whose value
  // is itself JSON.  e.g. the JS string contains literal \"quotes\"
  // Detect by checking if the first char is a quote and it parses as a string.
  if (text.startsWith('"')) {
    try {
      const inner = JSON.parse(text);  // unescape the outer string layer
      if (typeof inner === 'string') {
        return JSON.parse(inner);  // parse the actual JSON payload
      }
    } catch {}
  }

  // Attempt 3: Aggressive unescape - double-backslash to single, escaped-quote to quote
  try {
    const unescaped = text
      .replace(/\\\\/g, '\\')
      .replace(/\\"/g, '"');
    return JSON.parse(unescaped);
  } catch {}

  // Attempt 4: Brace-depth extraction for arrays
  const arrStart = text.indexOf('[');
  if (arrStart >= 0) {
    let depth = 0;
    let arrEnd = -1;
    let inStr = false;
    let strCh = '';
    for (let i = arrStart; i < text.length; i++) {
      const ch = text[i];
      if (inStr) {
        if (ch === '\\') { i++; continue; }
        if (ch === strCh) inStr = false;
        continue;
      }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === '[') depth++;
      else if (ch === ']') { depth--; if (depth === 0) { arrEnd = i + 1; break; } }
    }
    if (arrEnd > arrStart) {
      try { return JSON.parse(text.substring(arrStart, arrEnd)); } catch {}
    }
  }

  return null;
}

async function callMistralCodeGen(prompt: any, signal: any) { 
  const apiKey = getCONFIG().MISTRAL_CODE_API_KEY;
  if (!apiKey) throw new Error('Mistral API key missing');
  const payload: any = {
    model: getCONFIG().CODE_GEN_MODEL_MISTRAL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.1,
    max_tokens: 2048,
    // Do NOT set response_format:json_object here.
    // The codegen prompt asks for a JSON ARRAY, but json_object
    // forces the top-level to be an object — causing Mistral to
    // double-escape the array into a string value.
  };
  const response = await fetchWithTimeout('https://api.mistral.ai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal
  });
  if (!response.ok) {
    const errorText = sanitizeErrorText(await response.text());
    throw new Error(`Mistral HTTP ${response.status}: ${errorText}`);
  }
  const data = await response.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error('Mistral empty response');
  return parseCodegenResponse(raw);
}

module.exports = { callMistralCodeGen, parseCodegenResponse, _injectDependencies };
