'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { callMistralCodeGen, parseCodegenResponse } = require('./providers-codegen-mistral');
const { callBazaarLinkCodeGenWithModel, getBazaarLinkModels } = require('./providers-codegen-bazaarlink');
const blLimiter = require('./bazaarlink-rate-limiter');
const { log, logError } = require('./logger');

// ─── IMPORTANT: Provider Scope ─────────────────────────────────────────
// This tribunal is for CODE GENERATION ONLY.
//   - BazaarLink: primary codegen provider (50 free req/day)
//   - Mistral: dedicated codegen provider
//   - OpenRouter is NOT used here — it's for the vision/general tribunal only.
//   - Cloudflare, Gemini, etc. are NOT codegen providers — never call them here.

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
 * Discover available codegen models.
 * Returns { blModels, hasMistral, hasBazaarLink }.
 *
 * CODEGEN PROVIDERS ONLY:
 *   - BazaarLink: primary codegen provider (50 free req/day)
 *   - Mistral: dedicated codegen provider
 *
 * OpenRouter, Cloudflare, Gemini, etc. are NOT codegen providers.
 * They must NOT be called here — they belong to the vision/general tribunal.
 */
function discoverModels() {
  // BazaarLink models (codegen primary — 50 free req/day)
  const blModels = getBazaarLinkModels();
  const hasBazaarLink = !!getCONFIG().BAZAARLINK_API_KEY;

  return {
    blModels,
    hasMistral: !!getCONFIG().MISTRAL_CODE_API_KEY,
    hasBazaarLink,
  };
}

// ═══════════════════════════════════════════════════════════
//  PRIMARY API: generateCodeFixViaTribunal
//  For generating CODE FIXES only. Returns validated fix objects.
// ═══════════════════════════════════════════════════════════

async function generateCodeFixViaTribunal(investigationData: any, errorLogs: any, signal?: any) { 
  const models = discoverModels();

  const totalModels = models.blModels.length
    + (models.hasMistral ? 1 : 0);

  const blModelList = models.blModels.join(', ');
  log(`\u{1f9e0} CODEGEN TRIBUNAL: Consulting ${totalModels} models — BazaarLink [${blModelList}]${models.hasMistral ? ' + Mistral' : ''}...`, 'INFO', 'codegen');

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
  let blSkipped = false;

  // BazaarLink models (PRIMARY codegen provider)
  // CHECK BUDGET BEFORE spawning API calls — if exhausted, skip entirely
  // to avoid burning retry attempts on guaranteed failures.
  if (models.hasBazaarLink) {
    if (blLimiter.isExhausted()) {
      log('BazaarLink budget exhausted — skipping BazaarLink calls this round', 'WARN', 'codegen');
      blSkipped = true;
    } else {
      for (const modelSlug of models.blModels) {
        log(`Tribunal: spawning BL/${modelSlug}`, 'DEBUG', 'codegen');
        allPromises.push(
          callBazaarLinkCodeGenWithModel(prompt, signal, modelSlug)
            .then((result: any) => {
              // Debug: log what BazaarLink actually returned
              if (!result) {
                log(`BL/${modelSlug}: parseCodegenResponse returned null`, 'WARN', 'codegen');
              } else if (Array.isArray(result)) {
                log(`BL/${modelSlug}: got ${result.length} raw fix(es) from parser`, 'DEBUG', 'codegen');
              } else {
                log(`BL/${modelSlug}: got non-array result: ${typeof result}`, 'DEBUG', 'codegen');
              }
              return { provider: `BL/${modelSlug}`, fixes: validateFixArray(result) };
            })
            .catch((err: any) => ({ provider: `BL/${modelSlug}`, fixes: [], error: String(err.message || err).substring(0, 200) }))
        );
      }
    }
  }
  // Mistral (dedicated codegen)
  if (models.hasMistral) {
    allPromises.push(
      callMistralCodeGen(prompt, signal)
        .then((result: any) => {
          // Debug: log what Mistral's parser actually returned
          if (!result) {
            log('Mistral: parseCodegenResponse returned null', 'WARN', 'codegen');
          } else if (Array.isArray(result)) {
            log(`Mistral: got ${result.length} raw fix(es) from parser`, 'DEBUG', 'codegen');
          } else {
            log(`Mistral: got non-array result: ${typeof result}`, 'DEBUG', 'codegen');
          }
          return { provider: 'Mistral', fixes: validateFixArray(result) };
        })
        .catch((err: any) => ({ provider: 'Mistral', fixes: [], error: String(err.message || err).substring(0, 200) }))
    );
  }

  // NO OpenRouter here — it's for vision/general tribunal only.
  // NO Cloudflare, Gemini, or any other non-codegen provider.

  if (allPromises.length === 0) {
    log('No codegen providers available. Need BAZAARLINK_API_KEY or MISTRAL_CODE_API_KEY.', 'ERROR', 'codegen');
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
    const nulls = results
      .filter(r => r.status === 'fulfilled' && !r.value.error && r.value.fixes.length === 0)
      .map((r: any) => r.value.provider);
    const parts: string[] = [];
    if (errors.length) parts.push(`Errors: ${errors.join('; ').substring(0, 400)}`);
    if (nulls.length) parts.push(`Empty responses: ${nulls.join(', ')}`);
    if (blSkipped) parts.push('BazaarLink skipped (budget exhausted)');
    log(`\u274c No valid fixes from ${allPromises.length} model(s). ${parts.join(' | ')}`, 'ERROR', 'codegen');
    // Signal to caller that this failure is NOT retriable if BazaarLink is
    // exhausted and Mistral also failed/returned empty.
    return blSkipped ? null : null;
  }

  log(`\u{1f4ca} ${validResponses.length}/${totalModels} codegen models returned valid fixes.`, 'INFO', 'codegen');

  // ── Patch voting consensus ──
  // With only BazaarLink + Mistral (2-3 models max), we can't reach
  // a high consensus threshold. Use a pragmatic approach:
  //   - If ANY model returned fixes, use the best one.
  //   - If multiple models agree, prefer the agreed fix.
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
  const sortedVotes = [...fixVotes.values()].sort((a, b) => b.count - a.count);
  const best = sortedVotes[0];

  if (best && best.count > 1) {
    // Multiple models agree — high confidence
    log(`\u2705 CONSENSUS: ${best.count}/${validResponses.length} models (${best.providers.join(', ')}) agree on ${best.fix.file}.`, 'INFO', 'codegen');
    return [best.fix];
  }
  if (best) {
    // Single model returned fixes — use it (better than nothing during OOM)
    log(`\u26a0\ufe0f Single-model fix from ${best.providers[0]} for ${best.fix.file}.`, 'WARN', 'codegen');
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

  const models = discoverModels();

  const totalModels = models.blModels.length
    + (models.hasMistral ? 1 : 0);

  log(`\u{1f9e0} TRIBUNAL RAW: Consulting ${totalModels} codegen models for generic task...`, 'INFO', 'codegen');

  const ctl = withTimeout(signal, timeoutMs);

  try {
    const allPromises: Promise<{ provider: string; raw: string } | null>[] = [];

    // BazaarLink for raw consultation (primary)
    // Check budget BEFORE spawning — skip if exhausted.
    if (models.hasBazaarLink && !blLimiter.isExhausted()) {
      for (const modelSlug of models.blModels) {
        log(`Tribunal raw: spawning BL/${modelSlug}`, 'DEBUG', 'codegen');
        allPromises.push(
          _callRawBazaarLink(prompt, ctl.signal, modelSlug)
        );
      }
    } else if (models.hasBazaarLink) {
      log('Tribunal raw: BazaarLink budget exhausted — skipping', 'WARN', 'codegen');
    }
    if (models.hasMistral) {
      allPromises.push(
        _callRawProvider('Mistral', () => callMistralCodeGen(prompt, ctl.signal), ctl.signal)
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
 * Call a BazaarLink model for raw text (not fix-validated).
 */
async function _callRawBazaarLink(prompt: string, signal: any, modelSlug: string) {
  try {
    const { callBazaarLinkCodeGenWithModel } = require('./providers-codegen-bazaarlink');
    const result = await callBazaarLinkCodeGenWithModel(prompt, signal, modelSlug);
    if (!result) return null;
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    if (!raw || raw.trim().length === 0) return null;
    return { provider: `BL/${modelSlug}`, raw };
  } catch (err: any) {
    log(`Tribunal raw BL/${modelSlug} failed: ${String(err.message || err).substring(0, 200)}`, 'DEBUG', 'codegen');
    return null;
  }
}

/**
 * Call a dedicated provider (Mistral) for raw text.
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
  const url = investigationData?.url || null;
  const html = investigationData?.html ? String(investigationData.html).substring(0, 1500) : null;
  const targetFile = investigationData?.targetFile || null;
  const fileContent = investigationData?.fileContent ? String(investigationData.fileContent).substring(0, 8000) : null;
  const isBootTime = !!investigationData?.bootTime;

  let contextLines: string[] = [];
  contextLines.push(`- Error/reason: ${errorLogs || 'Unknown recurring failure'}`);
  if (url) contextLines.push(`- Current URL: ${url}`);
  if (html) contextLines.push(`- HTML snippet: ${html}`);
  if (isBootTime) contextLines.push(`- NOTE: This is a boot-time heal (no browser available). Diagnose from error patterns only.`);

  let prompt = `You are a senior Node.js/TypeScript developer diagnosing and fixing an automation bot.\n`;
  prompt += `CONTEXT:\n${contextLines.join('\n')}\n`;

  if (targetFile && fileContent) {
    prompt += `\nTarget file to fix: ${targetFile}\n`;
    prompt += `--- BEGIN FILE: ${targetFile} ---\n${fileContent}\n--- END FILE ---\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Identify the exact bug in the file above.\n`;
    prompt += `2. Propose a fix.\n`;
    prompt += `3. Return a JSON ARRAY of objects. Each object must have:\n`;
    prompt += `- "file": (string) relative path from project root\n`;
    prompt += `- "change": (string) human-readable description of the fix\n`;
    prompt += `- "patch": (string) a UNIFIED DIFF patch (lines starting with + or -)\n`;
    prompt += `If no fix is possible, return exactly: []\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  } else {
    prompt += `\nNo specific target file identified. You must infer which file(s) to fix from the error context above.\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Analyze the error and identify the likely source file.\n`;
    prompt += `2. Propose a fix with a unified diff patch.\n`;
    prompt += `3. Return a JSON ARRAY of objects. Each object must have:\n`;
    prompt += `- "file": (string) relative path from project root\n`;
    prompt += `- "change": (string) human-readable description of the fix\n`;
    prompt += `- "patch": (string) a UNIFIED DIFF patch (lines starting with + or -)\n`;
    prompt += `Only return [] if you truly cannot identify any file to fix.\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  }

  return prompt;
}

module.exports = { generateCodeFixViaTribunal, consultTribunalRaw, _injectDependencies };
