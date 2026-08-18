'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { callMistralCodeGen, parseCodegenResponse } = require('./providers-codegen-mistral');
const blLimiter = require('./bazaarlink-rate-limiter');
const { log, logError } = require('./logger');

// ─── Utility ───
function _sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ─── Lazy BazaarLink require (resilient to transform failures) ───
// Top-level require('./providers-codegen-bazaarlink') crashes the entire
// codegen-tribunal module if esbuild/tsx fails to transform it (e.g.
// corrupted file on disk, OOM-damaged source). Instead, import lazily
// so BazaarLink degrades gracefully — Mistral can still function.
let _blModule: any = null;
let _blLoadError: string | null = null;

function _getBL(): any {
  if (_blLoadError) return null; // already failed, don't retry
  if (_blModule) return _blModule;
  try {
    _blModule = require('./providers-codegen-bazaarlink');
    return _blModule;
  } catch (err: any) {
    _blLoadError = String(err.message || err).substring(0, 300);
    log(`BazaarLink module failed to load (tribunal will skip BL): ${_blLoadError}`, 'ERROR', 'codegen');
    return null;
  }
}

// ─── IMPORTANT: Provider Scope ─────────────────────────────────────────
// This tribunal is for CODE GENERATION ONLY.
//   - BazaarLink: primary codegen provider (50 free req/day)
//   - Mistral: dedicated codegen provider
//   - OpenRouter is NOT used here — it's for the vision/general tribunal only.
//   - Cloudflare, Gemini, etc. are NOT codegen providers — never call them here.
//
// FALLBACK: If ALL dedicated codegen providers fail AND the caller indicates
// this is a repeated failure (not first attempt), we fall back to non-codegen
// vision/general providers (Groq, z.ai, NVIDIA, Cloudflare, Gemini, OpenRouter)
// from the general registry. These providers use the same codegen prompt but
// their raw text output is parsed via parseCodegenResponse() instead of
// extractJSON/validateActionResponse. This ensures self-heal never gets
// stuck in a retry loop when both BazaarLink and Mistral are down.

// ─── Default timeout for tribunal calls when no external signal is provided ───
const DEFAULT_TRIBUNAL_TIMEOUT_MS = 120_000; // 2 minutes

// v7: Prefixes that the /tmp overlay allows. Fixes for files not
// matching these prefixes will be silently rejected here — saving API
// budget, overlay writes, and rollback cycles.
const PATCHABLE_PREFIXES = [
  'selectors-', 'providers-detection-', 'cycle-', 'providers-base',
  'providers-config-loader', 'providers-registry', 'providers-fallback',
  'providers-prompts', 'providers-vision-pipeline', 'providers-stats',
  'providers-tribunal', 'providers-serializers', 'providers-prompt-evolution',
  'cache', 'auth-auth-manager', 'config', 'browser', 'state-machine',
  'longevity-ui-recovery', 'self-heal-degradation-ladder',
  'math-problem-classifier', 'services-pix2tex',
];

function _isPatchableFile(file: string): boolean {
  return PATCHABLE_PREFIXES.some(p => file.startsWith(p));
}

function validateFix(fix: any) { 
  if (!fix || typeof fix !== 'object') return false;
  if (!fix.file || typeof fix.file !== 'string') return false;
  // Strip leading ./ if present
  const file = fix.file.replace(/^\.\//, '');
  fix.file = file;
  if (!_isPatchableFile(file)) {
    log(`Fix rejected: ${file} does not match patchable prefixes (overlay would block it)`, 'DEBUG', 'codegen');
    return false;
  }

  // v12-OOM-FIX: Reject fixes for files that don't exist on disk.
  // The AI has NO visibility into the codebase and will hallucinate
  // file names. Without this check, the fix passes validation,
  // reaches applyFixesToStaging, gets skipped silently, and then
  // promoteStaging used to write ALL 100+ files to overlay.
  try {
    const { PROJECT_ROOT } = require('./project-root');
    const fullPath = require('path').join(PROJECT_ROOT, file);
    if (!require('fs').existsSync(fullPath)) {
      log(`Fix rejected: ${file} does not exist on disk (AI hallucinated file name)`, 'WARN', 'codegen');
      return false;
    }
  } catch (e: any) {
    // If we can't check existence (e.g. project-root missing),
    // allow the fix through — don't make things worse.
  }

  if (!fix.change || typeof fix.change !== 'string') return false;
  if (!fix.patch || typeof fix.patch !== 'string') return false;
  if (fix.patch.trim().length < 5) return false;
  return true;
}

function validateFixArray(parsed: any) {
  if (!parsed) return [];
  let fixes: any[] = [];
  if (Array.isArray(parsed)) {
    fixes = parsed.filter(validateFix);
  } else if (typeof parsed === 'object') {
    for (const key of ['fixes', 'patches', 'results', 'data', 'response']) {
      if (Array.isArray(parsed[key])) {
        const extracted = parsed[key].filter(validateFix);
        if (extracted.length > 0) { fixes = extracted; break; }
      }
    }
    // Single fix object (not wrapped in array)
    if (fixes.length === 0 && validateFix(parsed)) fixes = [parsed];
  }

  // v12-OOM-FIX: Reject bulk-hallucinated responses.
  // The AI has no codebase visibility. When it hallucinates, it returns
  // patches for 10-60+ files (full file rewrites of 100KB+ each).
  // This single check prevents the most dangerous OOM pattern.
  const MAX_FIXES_PER_RESPONSE = 3;
  const MAX_TOTAL_PATCH_CHARS = 100_000; // 100KB

  if (fixes.length > MAX_FIXES_PER_RESPONSE) {
    log(`Fix array TRUNCATED: ${fixes.length} fixes exceeds max ${MAX_FIXES_PER_RESPONSE}. ` +
      `AI likely hallucinated bulk rewrites. Keeping first ${MAX_FIXES_PER_RESPONSE} only.`, 'WARN', 'codegen');
    fixes = fixes.slice(0, MAX_FIXES_PER_RESPONSE);
  }

  const totalChars = fixes.reduce((sum: number, f: any) => sum + (f.patch?.length || 0), 0);
  if (totalChars > MAX_TOTAL_PATCH_CHARS) {
    log(`Fix array REJECTED: total patch size ${totalChars} chars exceeds ${MAX_TOTAL_PATCH_CHARS} limit. ` +
      `AI returned full-file rewrites instead of targeted fixes.`, 'ERROR', 'codegen');
    return [];
  }

  return fixes;
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
  const bl = _getBL();
  const blModels = bl?.getBazaarLinkModels?.() || [];
  const hasBazaarLink = !!getCONFIG().BAZAARLINK_API_KEY && !!bl;

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

async function generateCodeFixViaTribunal(
  investigationData: any,
  errorLogs: any,
  signal?: any,
  options?: { allowNonCodegenFallback?: boolean },
) {
  const models = discoverModels();

  const totalModels = models.blModels.length
    + (models.hasMistral ? 1 : 0);

  const blModelList = models.blModels.join(', ');
  log(`\u{1f9e0} CODEGEN TRIBUNAL: Consulting ${totalModels} models — BazaarLink [${blModelList}]${models.hasMistral ? ' + Mistral' : ''}${options?.allowNonCodegenFallback ? ' (non-codegen fallback ENABLED)' : ''}...`, 'INFO', 'codegen');

  const prompt = buildCodeGenPrompt(investigationData, errorLogs);
  const ctl = withTimeout(signal, DEFAULT_TRIBUNAL_TIMEOUT_MS);

  try {
    const result = await _runFixConsensus(prompt, models, totalModels, ctl.signal);
    // If dedicated codegen providers all failed AND caller allows fallback,
    // try non-codegen providers from the general registry.
    if (!result && options?.allowNonCodegenFallback) {
      log('Dedicated codegen providers exhausted — falling back to non-codegen providers from general registry', 'WARN', 'codegen');
      return await _fallbackToGeneralProviders(prompt, ctl.signal);
    }
    return result;
  } finally {
    (ctl as any)._cleanup?.();
  }
}

/**
 * Run the fix-specific consensus algorithm.
 * Separate function so the signal setup/teardown is clean.
 */
async function _runFixConsensus(prompt: string, models: any, totalModels: number, signal: any) {
  let blSkipped = false;
  const BL_STAGGER_MS = 3000;
  const collected: Array<{ provider: string; fixes: any[]; error?: string }> = [];

  if (models.hasBazaarLink) {
    if (blLimiter.isExhausted()) {
      log('BazaarLink budget exhausted — skipping BazaarLink calls this round', 'WARN', 'codegen');
      blSkipped = true;
    } else {
      for (let i = 0; i < models.blModels.length; i++) {
        const modelSlug = models.blModels[i];
        // Stagger: wait 3s between BazaarLink requests (not before first)
        if (i > 0) {
          log(`Tribunal: staggering BL/${modelSlug} (${BL_STAGGER_MS}ms delay to avoid 429)`, 'DEBUG', 'codegen');
          await _sleep(BL_STAGGER_MS);
        }
        log(`Tribunal: calling BL/${modelSlug}`, 'DEBUG', 'codegen');
        try {
          const result = await _getBL().callBazaarLinkCodeGenWithModel(prompt, signal, modelSlug);
          if (!result) {
            log(`BL/${modelSlug}: parseCodegenResponse returned null`, 'WARN', 'codegen');
          } else if (Array.isArray(result)) {
            log(`BL/${modelSlug}: got ${result.length} raw fix(es) from parser`, 'DEBUG', 'codegen');
          } else {
            log(`BL/${modelSlug}: got non-array result: ${typeof result}`, 'DEBUG', 'codegen');
          }
          collected.push({ provider: `BL/${modelSlug}`, fixes: validateFixArray(result) });
        } catch (err: any) {
          collected.push({ provider: `BL/${modelSlug}`, fixes: [], error: String(err.message || err).substring(0, 200) });
        }
      }
    }
  }
  // Mistral (dedicated codegen) — runs in parallel with last BL model via allPromises
  const allPromises: Promise<any>[] = [...collected.map(c => Promise.resolve(c))];
  if (models.hasMistral) {
    allPromises.push(
      callMistralCodeGen(prompt, signal)
        .then((result: any) => {
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

  const results = await Promise.allSettled(allPromises) as PromiseSettledResult<{ provider: string; fixes: any[]; error?: string }[]>;
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

// ═══════════════════════════════════════════════════════════════════
//  FALLBACK: Non-codegen providers from the general registry
// ═══════════════════════════════════════════════════════════════════

/**
 * When both BazaarLink (budget exhausted / all 429) and Mistral (down / key
 * missing) have failed, this function grabs healthy providers from the general
 * registry (Groq, z.ai, NVIDIA, Cloudflare, Gemini, OpenRouter, ...) and asks
 * them the SAME codegen prompt.
 *
 * Key differences from the normal vision pipeline:
 *   - We pass `validate: false` so the provider returns raw text instead of
 *     going through extractJSON -> validateActionResponse (which expects
 *     actionType/targetX/targetY).
 *   - We parse the raw text with parseCodegenResponse() which understands
 *     { file, change, patch } arrays.
 *   - We still run the fix through validateFixArray() and PATCHABLE_PREFIXES.
 *   - We cap at 3 providers to avoid burning the entire registry on a codegen
 *     task that most vision models are not optimised for.
 *   - We track results in the health system so repeated failures trigger
 *     circuit breakers normally.
 */
const FALLBACK_MAX_PROVIDERS = 3;

async function _fallbackToGeneralProviders(prompt: string, signal: any): Promise<any[] | null> {
  let registry: any;
  try {
    registry = require('./providers-registry');
  } catch (err: any) {
    log(`Fallback: cannot load providers-registry: ${err.message || err}`, 'ERROR', 'codegen');
    return null;
  }

  const { getAvailableProviders, recordProviderResult, addProviderFailure } = registry;

  let providers: Array<{ name: string; fn: any; healthScore?: number }>;
  try {
    providers = await getAvailableProviders();
  } catch (err: any) {
    log(`Fallback: getAvailableProviders failed: ${err.message || err}`, 'ERROR', 'codegen');
    return null;
  }

  if (!providers || providers.length === 0) {
    log('Fallback: no general providers available after health filtering', 'ERROR', 'codegen');
    return null;
  }

  // Cap to top-N by health score to avoid burning the entire registry
  const capped = providers
    .sort((a: any, b: any) => (b.healthScore || 0) - (a.healthScore || 0))
    .slice(0, FALLBACK_MAX_PROVIDERS);

  log(`Fallback: trying ${capped.length} general provider(s): ${capped.map((p: any) => p.name).join(', ')}`, 'INFO', 'codegen');

  const collected: Array<{ provider: string; fixes: any[]; error?: string }> = [];

  // Call providers sequentially to avoid hammering all at once
  for (const provider of capped) {
    if (signal?.aborted) break;
    const start = Date.now();
    try {
      // CRITICAL: pass validate:false so the provider returns raw text.
      // Vision providers normally run extractJSON -> validateActionResponse
      // which expects {actionType, currentState, targetX, targetY}.
      // We want the RAW text so we can parse it as codegen output.
      const rawText = await provider.fn(
        null,           // no image -- codegen is text-only
        prompt,
        signal,
        { validate: false },
      );
      const latency = Date.now() - start;

      if (!rawText || typeof rawText !== 'string' || rawText.trim().length === 0) {
        log(`Fallback ${provider.name}: empty response (${latency}ms)`, 'WARN', 'codegen');
        recordProviderResult(provider.name, false, latency);
        collected.push({ provider: provider.name, fixes: [], error: 'empty_response' });
        continue;
      }

      // Parse with the codegen parser (not extractJSON)
      const parsed = parseCodegenResponse(rawText);
      const fixes = validateFixArray(parsed);

      if (fixes.length > 0) {
        log(`Fallback ${provider.name}: got ${fixes.length} valid fix(es) (${latency}ms)`, 'INFO', 'codegen');
        recordProviderResult(provider.name, true, latency);
        collected.push({ provider: provider.name, fixes });
      } else {
        log(`Fallback ${provider.name}: response parsed but 0 valid fixes (${latency}ms, raw=${rawText.length} chars)`, 'WARN', 'codegen');
        recordProviderResult(provider.name, false, latency);
        collected.push({ provider: provider.name, fixes: [], error: 'no_valid_fixes' });
      }
    } catch (err: any) {
      const latency = Date.now() - start;
      const errMsg = String(err.message || err).substring(0, 200);
      log(`Fallback ${provider.name} failed: ${errMsg} (${latency}ms)`, 'WARN', 'codegen');
      recordProviderResult(provider.name, false, latency);
      addProviderFailure(provider.name, err);
      collected.push({ provider: provider.name, fixes: [], error: errMsg });
    }
  }

  // Check if any fallback provider returned valid fixes
  const validResponses = collected.filter(c => c.fixes.length > 0);
  if (validResponses.length === 0) {
    const errors = collected.filter(c => c.error).map(c => `${c.provider}: ${c.error}`);
    log(`Fallback: all ${capped.length} general providers failed. ${errors.join('; ').substring(0, 500)}`, 'ERROR', 'codegen');
    return null;
  }

  log(`Fallback: ${validResponses.length}/${capped.length} general provider(s) returned valid fixes`, 'INFO', 'codegen');

  // Same consensus logic as primary: pick the most-agreed fix, or single best
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
    log(`CONSENSUS (fallback): ${best.count}/${validResponses.length} providers (${best.providers.join(', ')}) agree on ${best.fix.file}`, 'INFO', 'codegen');
    return [best.fix];
  }
  if (best) {
    log(`Single-model fallback fix from ${best.providers[0]} for ${best.fix.file}`, 'WARN', 'codegen');
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
    // BazaarLink for raw consultation (primary)
    // Check budget BEFORE spawning — skip if exhausted.
    // v7 FIX: Stagger BL requests 3s apart to avoid 429 rate limiting.
    const BL_STAGGER_MS = 3000;
    const blCollected: Array<{ provider: string; raw: string } | null>[] = [];
    if (models.hasBazaarLink && !blLimiter.isExhausted()) {
      for (let i = 0; i < models.blModels.length; i++) {
        const modelSlug = models.blModels[i];
        if (i > 0) {
          log(`Tribunal raw: staggering BL/${modelSlug} (${BL_STAGGER_MS}ms delay)`, 'DEBUG', 'codegen');
          await _sleep(BL_STAGGER_MS);
        }
        log(`Tribunal raw: calling BL/${modelSlug}`, 'DEBUG', 'codegen');
        blCollected.push(await _callRawBazaarLink(prompt, ctl.signal, modelSlug));
      }
    } else if (models.hasBazaarLink) {
      log('Tribunal raw: BazaarLink budget exhausted — skipping', 'WARN', 'codegen');
    }
    const allPromises: Promise<{ provider: string; raw: string } | null>[] = [
      ...blCollected.map(r => Promise.resolve(r)),
    ];
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
    const bl = _getBL();
    if (!bl) return null;
    const result = await bl.callBazaarLinkCodeGenWithModel(prompt, signal, modelSlug);
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

// Lazy load codebase context (fails gracefully if file doesn't exist)
let _codebaseContext: string | null = null;
function _getCodebaseContext(): string {
  if (_codebaseContext !== null) return _codebaseContext;
  try {
    _codebaseContext = require('./self-heal-codebase-context').CODEBASE_CONTEXT || '';
  } catch { _codebaseContext = ''; }
  return _codebaseContext;
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
  // Inject codebase architecture context so models generate valid fixes
  const ctx = _getCodebaseContext();
  if (ctx) prompt += `${ctx}\n`;
  prompt += `CONTEXT:\n${contextLines.join('\n')}\n`;

  if (targetFile && fileContent) {
    prompt += `\nTarget file to fix: ${targetFile}\n`;
    prompt += `--- BEGIN FILE: ${targetFile} ---\n${fileContent}\n--- END FILE ---\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Identify the exact bug in the file above.\n`;
    prompt += `2. Propose a fix.\n`;
    prompt += `3. Return a JSON ARRAY with a SINGLE object. The object must have:\n`;
    prompt += `- "file": "${targetFile}" (exact filename — do NOT invent other filenames)\n`;
    prompt += `- "change": (string) human-readable description of the fix\n`;
    prompt += `- "patch": (string) the COMPLETE file content with the fix applied\n`;
    prompt += `CRITICAL: Return the FULL file content in "patch", not a diff. Not a snippet. The entire file.\n`;
    prompt += `CRITICAL: Only fix ${targetFile}. Do NOT return patches for other files.\n`;
    prompt += `If no fix is possible, return exactly: []\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  } else {
    prompt += `\nNo specific target file identified. You must infer which file to fix from the error context above.\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Analyze the error and identify the single most likely source file.\n`;
    prompt += `2. Propose ONE fix only.\n`;
    prompt += `3. Return a JSON ARRAY with a SINGLE object. The object must have:\n`;
    prompt += `- "file": (string) the exact filename (e.g. "providers-detection-work-detector.ts")\n`;
    prompt += `- "change": (string) human-readable description of the fix\n`;
    prompt += `- "patch": (string) the COMPLETE file content with the fix applied\n`;
    prompt += `CRITICAL: Return the FULL file content in "patch", not a diff. Not a snippet. The entire file.\n`;
    prompt += `CRITICAL: Return ONLY ONE fix for ONE file. Do NOT return patches for multiple files.\n`;
    prompt += `Only return [] if you truly cannot identify any file to fix.\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  }

  return prompt;
}

module.exports = { generateCodeFixViaTribunal, consultTribunalRaw, _injectDependencies };
