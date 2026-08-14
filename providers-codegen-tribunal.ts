'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { callMistralCodeGen } = require('./providers-codegen-mistral');
const { callQwenCodeGen } = require('./providers-codegen-qwen');
const { callDeepSeekCodeGen } = require('./providers-codegen-deepseek');
const { callOpenRouterCodeGenWithModel } = require('./providers-codegen-openrouter');
const { log, logError } = require('./logger');

// ─── Default timeout for tribunal calls when no external signal is provided ───
const DEFAULT_TRIBUNAL_TIMEOUT_MS = 120_000; // 2 minutes

function validateFix(fix: any) { 
  if (!fix || typeof fix !== 'object') return false;
  if (!fix.file || typeof fix.file !== 'string') return false;
  if (!fix.change || typeof fix.change !== 'string') return false;
  if (!fix.patch || typeof fix.patch !== 'string') return false;
  if (fix.patch.trim().length < 5) return false;
  return true;
}

function validateFixArray(parsed: any) { 
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter(validateFix);
  // Some providers wrap the array in an object — try common wrappers
  if (typeof parsed === 'object') {
    for (const key of ['fixes', 'patches', 'results', 'data', 'response']) {
      if (Array.isArray(parsed[key])) {
        const extracted = parsed[key].filter(validateFix);
        if (extracted.length > 0) return extracted;
      }
    }
    // Single fix object (not wrapped in array)
    if (validateFix(parsed)) return [parsed];
  }
  return [];
}

/**
 * Ensure we have an AbortSignal with a timeout. If the caller already
 * provided a signal, compose it with our timeout. If not, create one.
 */
function withTimeout(signal: any, timeoutMs: number): AbortController {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Tribunal timeout')), timeoutMs);
  // If the caller's signal aborts, abort ours too
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); controller.abort(signal.reason); return controller; }
    signal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(signal.reason); }, { once: true });
  }
  // Return controller so the caller can clear the timer if the promise settles first
  (controller as any)._cleanup = () => clearTimeout(timer);
  return controller;
}

/**
 * Discover available models and return the list of OpenRouter model slugs
 * plus which dedicated providers are available.
 * Returns { orModels, hasMistral, hasQwen, hasDeepSeek }.
 */
async function discoverModels() {
  let modelDiscovery;
  try { modelDiscovery = require('./services-model-discovery-advanced'); } catch (e: any) { modelDiscovery = null; }
  if (!modelDiscovery) return null;

  const provider = getCONFIG().CODE_GEN_PROVIDERS?.find?.((p: any) => p.name === 'openrouter');
  let orModels: string[] = [];
  if (provider && getCONFIG().OPENROUTER_API_KEY) {
    try {
      const freeModels = await modelDiscovery.getFreeModels(provider.name);
      orModels = (freeModels || []).map((m: any) => m.id).filter((id: string) => id.includes(':free'));
    } catch (e: any) { /* model discovery can fail under memory pressure */ }
  }
  if (orModels.length === 0) orModels = ['openrouter/free'];
  return {
    orModels,
    hasMistral: !!getCONFIG().MISTRAL_CODE_API_KEY,
    hasQwen: !!getCONFIG().QWEN_CODE_API_KEY,
    hasDeepSeek: !!getCONFIG().DEEPSEEK_CODE_API_KEY,
  };
}

// ═══════════════════════════════════════════════════════════
//  PRIMARY API: generateCodeFixViaTribunal
//  For generating CODE FIXES only. Returns validated fix objects.
// ═══════════════════════════════════════════════════════════

async function generateCodeFixViaTribunal(investigationData: any, errorLogs: any, signal?: any) { 
  const models = await discoverModels();
  if (!models) { log('model-discovery-advanced not available', 'WARN', 'codegen'); return null; }

  const totalModels = models.orModels.length
    + (models.hasMistral ? 1 : 0)
    + (models.hasQwen ? 1 : 0)
    + (models.hasDeepSeek ? 1 : 0);

  log(`\u{1f9e0} SUPER TRIBUNAL: Consulting ${totalModels} models (${models.orModels.length} via OpenRouter + Mistral + Qwen + DeepSeek)...`, 'INFO', 'codegen');

  const prompt = buildCodeGenPrompt(investigationData, errorLogs);
  const ctl = withTimeout(signal, DEFAULT_TRIBUNAL_TIMEOUT_MS);

  try {
    return await _runFixConsensus(prompt, models, totalModels, ctl.signal);
  } finally {
    (ctl as any)._cleanup?.();
  }
}

/**
 * Run the fix-specific consensus algorithm.
 * Separate function so the signal setup/teardown is clean.
 */
async function _runFixConsensus(prompt: string, models: any, totalModels: number, signal: any) {
  const allPromises: Promise<any>[] = [];

  for (const modelSlug of models.orModels) {
    if (getCONFIG().OPENROUTER_API_KEY) {
      allPromises.push(
        callOpenRouterCodeGenWithModel(prompt, signal, modelSlug)
          .then((result: any) => ({ provider: `OR/${modelSlug}`, fixes: validateFixArray(result) }))
          .catch((err: any) => ({ provider: `OR/${modelSlug}`, fixes: [], error: String(err.message || err).substring(0, 200) }))
      );
    }
  }
  if (models.hasMistral) {
    allPromises.push(
      callMistralCodeGen(prompt, signal)
        .then((result: any) => ({ provider: 'Mistral', fixes: validateFixArray(result) }))
        .catch((err: any) => ({ provider: 'Mistral', fixes: [], error: String(err.message || err).substring(0, 200) }))
    );
  }
  if (models.hasQwen) {
    allPromises.push(
      callQwenCodeGen(prompt, signal)
        .then((result: any) => ({ provider: 'Qwen', fixes: validateFixArray(result) }))
        .catch((err: any) => ({ provider: 'Qwen', fixes: [], error: String(err.message || err).substring(0, 200) }))
    );
  }
  if (models.hasDeepSeek) {
    allPromises.push(
      callDeepSeekCodeGen(prompt, signal)
        .then((result: any) => ({ provider: 'DeepSeek', fixes: validateFixArray(result) }))
        .catch((err: any) => ({ provider: 'DeepSeek', fixes: [], error: String(err.message || err).substring(0, 200) }))
    );
  }

  if (allPromises.length === 0) {
    log('No codegen providers available (no API keys configured)', 'ERROR', 'codegen');
    return null;
  }

  const results = await Promise.allSettled(allPromises) as PromiseSettledResult<{ provider: string; fixes: any[]; error?: string }>[];
  const validResponses = results
    .filter(r => r.status === 'fulfilled' && r.value.fixes.length > 0)
    .map((r: any) => (r as any).value);

  if (validResponses.length === 0) {
    const errors = results
      .filter(r => r.status === 'fulfilled' && r.value.error)
      .map((r: any) => `${r.value.provider}: ${(r as any).value.error}`);
    log(`\u274c No valid fixes from ANY of the ${totalModels} models. Errors: ${errors.join('; ').substring(0, 500)}`, 'ERROR', 'codegen');
    return null;
  }

  log(`\u{1f4ca} ${validResponses.length}/${totalModels} models returned valid fixes.`, 'INFO', 'codegen');

  // ── Patch voting consensus ──
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

  if (best && best.count >= required) {
    log(`\u2705 SUPER CONSENSUS: ${best.count}/${validResponses.length} models (${best.providers.join(', ')}) agree on ${best.fix.file}.`, 'INFO', 'codegen');
    return [best.fix];
  }
  if (validResponses.length >= 6) {
    log(`\u274c No super-majority (best: ${best?.count || 0}/${validResponses.length}). Aborting to avoid corruption.`, 'ERROR', 'codegen');
    return null;
  }
  if (best) {
    log(`\u26a0\ufe0f Limited responses (${validResponses.length}/${totalModels}). Using fallback fix from ${best.providers[0]}.`, 'WARN', 'codegen');
    return [best.fix];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  GENERIC API: consultTribunalRaw
//  For any text-generation task that is NOT a code fix.
//  Returns the raw text from the first successful model.
//  No fix validation, no consensus voting — just best-effort text.
// ═══════════════════════════════════════════════════════════

/**
 * Consult the tribunal for generic text generation (NOT code fixes).
 * Use this for: regression tests, state discovery, prompt evolution,
 * diff minimization, process retraining, etc.
 *
 * @param {string} prompt - The full prompt to send to models
 * @param {AbortSignal} [signal] - Optional external abort signal
 * @param {object} [options] - Optional configuration
 * @param {number} [options.timeoutMs=120000] - Timeout in ms
 * @param {boolean} [options.responseFormatJson=false] - Request JSON response format
 * @returns {Promise<string|null>} Raw text from the first successful model, or null
 */
async function consultTribunalRaw(prompt: string, signal?: any, options?: { timeoutMs?: number; responseFormatJson?: boolean }) {
  const timeoutMs = options?.timeoutMs || DEFAULT_TRIBUNAL_TIMEOUT_MS;
  const responseFormatJson = options?.responseFormatJson !== false; // default true

  const models = await discoverModels();
  if (!models) { log('model-discovery-advanced not available for raw consultation', 'WARN', 'codegen'); return null; }

  const totalModels = models.orModels.length
    + (models.hasMistral ? 1 : 0)
    + (models.hasQwen ? 1 : 0)
    + (models.hasDeepSeek ? 1 : 0);

  log(`\u{1f9e0} TRIBUNAL RAW: Consulting ${totalModels} models for generic task...`, 'INFO', 'codegen');

  const ctl = withTimeout(signal, timeoutMs);

  try {
    // For raw consultation, we use a simpler approach: race all models
    // and return the first successful response. This is much faster than
    // waiting for all (no need for consensus on non-fix tasks).
    const allPromises: Promise<{ provider: string; raw: string } | null>[] = [];

    for (const modelSlug of models.orModels) {
      if (getCONFIG().OPENROUTER_API_KEY) {
        allPromises.push(
          _callRawOr(prompt, ctl.signal, modelSlug, responseFormatJson)
        );
      }
    }
    if (models.hasMistral) {
      allPromises.push(
        _callRawProvider('Mistral', () => callMistralCodeGen(prompt, ctl.signal), ctl.signal)
      );
    }
    if (models.hasQwen) {
      allPromises.push(
        _callRawProvider('Qwen', () => callQwenCodeGen(prompt, ctl.signal), ctl.signal)
      );
    }
    if (models.hasDeepSeek) {
      allPromises.push(
        _callRawProvider('DeepSeek', () => callDeepSeekCodeGen(prompt, ctl.signal), ctl.signal)
      );
    }

    if (allPromises.length === 0) {
      log('No codegen providers available for raw consultation', 'ERROR', 'codegen');
      return null;
    }

    // Strategy: collect all that succeed within timeout, pick the longest
    // non-empty response (best effort quality heuristic).
    const results = await Promise.allSettled(allPromises);
    const successes: { provider: string; raw: string }[] = [];
    const errors: string[] = [];

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        successes.push(r.value);
      } else if (r.status === 'fulfilled' && !r.value) {
        // null = provider had no result but didn't throw
      } else if (r.status === 'rejected') {
        errors.push(String((r as any).reason?.message || r.reason).substring(0, 100));
      }
    }

    if (successes.length === 0) {
      log(`No successful response from ${totalModels} models for raw consultation. Errors: ${errors.join('; ').substring(0, 500)}`, 'ERROR', 'codegen');
      return null;
    }

    // Pick the response with the most content (likely highest quality)
    successes.sort((a, b) => b.raw.length - a.raw.length);
    const best = successes[0];
    log(`Tribunal raw: got response from ${best.provider} (${best.raw.length} chars, ${successes.length}/${totalModels} succeeded)`, 'INFO', 'codegen');

    return best.raw;
  } finally {
    (ctl as any)._cleanup?.();
  }
}

/**
 * Call an OpenRouter model for raw text (not fix-validated).
 */
async function _callRawOr(prompt: string, signal: any, modelSlug: string, responseFormatJson: boolean) {
  try {
    const apiKey = getCONFIG().OPENROUTER_API_KEY;
    if (!apiKey) return null;

    const { fetchWithTimeout, extractJSON, sanitizeErrorText } = require('./providers-base');

    // Import rate limiter
    let orLimiter: any;
    try { orLimiter = require('./openrouter-rate-limiter'); } catch { orLimiter = null; }
    orLimiter?.checkBudget?.('critical');

    const payload: any = {
      model: modelSlug,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.1,
      max_tokens: 4096,
    };
    if (responseFormatJson) {
      payload.response_format = { type: 'json_object' };
    }

    const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': getCONFIG().APP_URL || 'https://mathu-bot.local',
        'X-Title': 'MathU Bot Tribunal Raw',
      },
      body: JSON.stringify(payload),
      signal
    });

    if (!response.ok) {
      const errorText = sanitizeErrorText(await response.text());
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const raw = data.choices?.[0]?.message?.content;
    if (!raw) throw new Error('Empty response');

    orLimiter?.recordUsage?.('critical');

    // If JSON format was requested, extract and return the raw JSON string
    if (responseFormatJson) {
      try {
        const parsed = JSON.parse(raw);
        return { provider: `OR/${modelSlug}`, raw: JSON.stringify(parsed) };
      } catch {
        // Not valid JSON despite requesting it — return as-is
        return { provider: `OR/${modelSlug}`, raw };
      }
    }
    return { provider: `OR/${modelSlug}`, raw };
  } catch (err: any) {
    log(`Tribunal raw OR/${modelSlug} failed: ${String(err.message || err).substring(0, 200)}`, 'DEBUG', 'codegen');
    return null;
  }
}

/**
 * Call a dedicated provider (Mistral/Qwen/DeepSeek) for raw text.
 */
async function _callRawProvider(name: string, callFn: () => Promise<any>, signal: any) {
  try {
    const result = await callFn();
    if (!result) return null;
    // result could be a parsed JSON or a string — normalize to string
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    if (!raw || raw.trim().length === 0) return null;
    return { provider: name, raw };
  } catch (err: any) {
    log(`Tribunal raw ${name} failed: ${String(err.message || err).substring(0, 200)}`, 'DEBUG', 'codegen');
    return null;
  }
}

function buildCodeGenPrompt(investigationData: any, errorLogs: any) { 
  // Safely extract all fields with fallbacks — callers often omit some
  const url = (investigationData?.url || 'Unknown');
  const html = String(investigationData?.html || '').substring(0, 1500);
  const targetFile = (investigationData?.targetFile || 'Unknown');
  const fileContent = String(investigationData?.fileContent || '').substring(0, 8000);

  return `
You are a senior Node.js developer fixing an automation bot.
CONTEXT:
- Error/Stagnation reason: ${errorLogs || 'Unknown recurring failure'}
- Current URL: ${url}
- HTML Snippet: ${html}
- Target file to fix: ${targetFile}
The bot is failing due to UI changes or logic errors.
Here is the current content of the file that likely needs fixing:
--- BEGIN FILE: ${targetFile} ---
${fileContent}
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

module.exports = { generateCodeFixViaTribunal, consultTribunalRaw, _injectDependencies };
