'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { callMistralCodeGen, parseCodegenResponse } = require('./providers-codegen-mistral');
const blLimiter = require('./bazaarlink-rate-limiter');
const { log, logError } = require('./logger');
// TASK 79 (2026-09-25): Increase max listeners to avoid MaxListenersExceededWarning
// when 7+ models are spawned in parallel — each OpenAI SDK call adds an abort
// listener to the shared AbortSignal, and the default limit is 10.
const { setMaxListeners } = require('events');

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

// ─── Lazy VoidAI require (resilient to transform failures) ───
// Same pattern as BazaarLink: lazy import so VoidAI degrades gracefully
// if the module fails to load (corrupted file, OOM-damaged source, etc.)
let _voidModule: any = null;
let _voidLoadError: string | null = null;

function _getVoid(): any {
  if (_voidLoadError) return null; // already failed, don't retry
  if (_voidModule) return _voidModule;
  try {
    _voidModule = require('./providers-codegen-voidai');
    return _voidModule;
  } catch (err: any) {
    _voidLoadError = String(err.message || err).substring(0, 300);
    log(`VoidAI module failed to load (tribunal will skip VoidAI): ${_voidLoadError}`, 'ERROR', 'codegen');
    return null;
  }
}

// ─── IMPORTANT: Provider Scope ─────────────────────────────────────────
// This tribunal is for CODE GENERATION ONLY.
//   - BazaarLink: primary codegen provider (50 free req/day)
//   - VoidAI: codegen provider using OpenAI SDK with api.voidai.app baseURL
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
// TASK 79 (2026-09-25): Codegen tribunals should NOT time out.
// The user explicitly said: "At this point, codegen tribunals shouldn't time out."
// Set to 30 minutes (1,800,000ms) — practically infinite. Code generation
// LLMs (gpt-5.3-codex, claude-haiku-4-5, etc.) can take 2-5 minutes per
// response, and with 7 models in parallel, the slowest one determines the
// wall-clock time. A 300s timeout (Task 77) was still too tight and caused
// AbortErrors that killed valid responses mid-flight.
//
// The caller (self-heal.ts) also respects SELF_HEAL_TRIBUNAL_TIMEOUT_MS —
// if set to 0, it skips AbortSignal.timeout entirely.
const DEFAULT_TRIBUNAL_TIMEOUT_MS = 1_800_000; // 30 minutes (practically no timeout)

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
  // TASK 79 (2026-09-25): If timeoutMs is 0 or Infinity, don't set a timer —
  // the tribunal should not time out. Only the caller's external signal
  // (if any) can abort it.
  let timer: any = null;
  if (timeoutMs > 0 && timeoutMs !== Infinity) {
    timer = setTimeout(() => controller.abort(new Error('Tribunal timeout')), timeoutMs);
  }
  // If the caller's signal aborts, abort ours too
  if (signal) {
    if (signal.aborted) { if (timer) clearTimeout(timer); controller.abort(signal.reason); return controller; }
    signal.addEventListener('abort', () => { if (timer) clearTimeout(timer); controller.abort(signal.reason); }, { once: true });
  }
  // Return controller so the caller can clear the timer if the promise settles first
  (controller as any)._cleanup = () => { if (timer) clearTimeout(timer); };
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
  const hasBazaarLink = !!getCONFIG().BAZAARLINK_API_KEY && !!bl;

  // TASK 140 (2026-10-24): Check if BazaarLink daily limit is exhausted.
  // If so, skip ALL BazaarLink models (not just individual ones).
  const blDailyLimitExhausted = bl?.isBazaarlinkDailyLimitExhausted?.() || false;
  if (blDailyLimitExhausted) {
    log('BazaarLink: daily limit exhausted — skipping ALL BazaarLink models for this session', 'WARN', 'codegen');
  }
  const blModels = (hasBazaarLink && !blDailyLimitExhausted) ? (bl?.getBazaarLinkModels?.() || []) : [];

  // VoidAI models (codegen — uses OpenAI SDK with api.voidai.app baseURL)
  const voidMod = _getVoid();
  const voidModels = voidMod?.getVoidAIModels?.() || [];
  const hasVoidAI = !!getCONFIG().VOIDAI_API_KEY && !!voidMod;

  // TASK 76 (2026-09-24): Filter out models that returned 402 (insufficient
  // credits) during this self-heal session. These models won't recover until
  // the BazaarLink account is topped up — retrying them wastes API budget
  // and tribunal timeout.
  const blModelsFiltered = blModels.filter((m: string) => !_isModelExhausted(`BL/${m}`));
  const voidModelsFiltered = hasVoidAI
    ? voidModels.filter((m: string) => !_isModelExhausted(`VoidAI/${m}`))
    : [];
  if (blModels.length > blModelsFiltered.length) {
    log(`BazaarLink: skipping ${blModels.length - blModelsFiltered.length} exhausted model(s): ${blModels.filter((m: string) => _isModelExhausted(`BL/${m}`)).join(', ')}`, 'WARN', 'codegen');
  }
  if (hasVoidAI && voidModels.length > voidModelsFiltered.length) {
    log(`VoidAI: skipping ${voidModels.length - voidModelsFiltered.length} exhausted model(s): ${voidModels.filter((m: string) => _isModelExhausted(`VoidAI/${m}`)).join(', ')}`, 'WARN', 'codegen');
  }

  // TASK 76: Also check if Mistral is exhausted
  const hasMistral = !!getCONFIG().MISTRAL_CODE_API_KEY && !_isModelExhausted('Mistral');
  if (!!getCONFIG().MISTRAL_CODE_API_KEY && _isModelExhausted('Mistral')) {
    log('Mistral: skipping (exhausted — 402/403/model_not_found)', 'WARN', 'codegen');
  }

  return {
    blModels: blModelsFiltered,
    hasMistral,
    hasBazaarLink,
    voidModels: voidModelsFiltered,
    hasVoidAI,
  };
}

// ─── TASK 76 (2026-09-24): Exhausted Model Tracking ──────────────────────
//
// When a codegen provider returns 402 (insufficient credits) or a similar
// permanent error, we add the model to this set. The model is then skipped
// for the rest of the self-heal session (and future sessions until the
// process restarts — at which point the set is cleared, giving the model
// another chance in case credits were topped up).
//
// This prevents the codegen tribunal from wasting 3 retry attempts calling
// the same model that returned 402 on attempt 1.

const _exhaustedModels = new Set<string>();

function _isModelExhausted(providerModel: string): boolean {
  return _exhaustedModels.has(providerModel);
}

function _markModelExhausted(providerModel: string, reason: string): void {
  if (!_exhaustedModels.has(providerModel)) {
    _exhaustedModels.add(providerModel);
    log(`Model ${providerModel} MARKED AS EXHAUSTED (will be skipped for rest of session): ${reason}`, 'ERROR', 'codegen');
  }
}

/**
 * Check if an error indicates the model is permanently unavailable (402, etc).
 * Returns true if the error should cause the model to be marked as exhausted.
 */
function _isPermanentModelError(err: any): { permanent: boolean; reason: string } {
  const errMsg = String(err?.message || err || '').toLowerCase();
  // 402 Insufficient credits (BazaarLink)
  if (errMsg.includes('402') || errMsg.includes('insufficient credits') || errMsg.includes('insufficient_credit')) {
    return { permanent: true, reason: '402 Insufficient credits' };
  }
  // 403 Forbidden (API key revoked)
  if (errMsg.includes('403') && (errMsg.includes('forbidden') || errMsg.includes('api key'))) {
    return { permanent: true, reason: '403 Forbidden (API key issue)' };
  }
  // Model not found / decommissioned
  if (errMsg.includes('model_not_found') || errMsg.includes('does not exist') || errMsg.includes('decommissioned')) {
    return { permanent: true, reason: 'Model not found/decommissioned' };
  }
  return { permanent: false, reason: '' };
}

/**
 * Check if an error is an AbortError (timeout) — should NOT be treated as
 * a hard failure. The model might work on retry with a longer timeout.
 */
function _isAbortError(err: any): boolean {
  const errMsg = String(err?.message || err || '').toLowerCase();
  return errMsg.includes('aborted') || errMsg.includes('user aborted')
    || err?.name === 'AbortError' || err?.name === 'TimeoutError';
}

// ═══════════════════════════════════════════════════════════
//  PRIMARY API: generateCodeFixViaTribunal
//  For generating CODE FIXES only. Returns validated fix objects.
// ═══════════════════════════════════════════════════════════

async function generateCodeFixViaTribunal(
  investigationData: any,
  errorLogs: any,
  signal?: any,
  options?: { allowNonCodegenFallback?: boolean; feedbackInfo?: { lastError?: string; lastFixPreview?: string } },
) {
  const models = discoverModels();

  const totalModels = models.blModels.length
    + (models.hasMistral ? 1 : 0)
    + (models.hasVoidAI ? models.voidModels.length : 0);

  const blModelList = models.blModels.join(', ');
  const voidModelList = models.voidModels.join(', ');
  log(`\u{1f9e0} CODEGEN TRIBUNAL: Consulting ${totalModels} models — BazaarLink [${blModelList}]${models.hasVoidAI ? ` + VoidAI [${voidModelList}]` : ''}${models.hasMistral ? ' + Mistral' : ''}${options?.allowNonCodegenFallback ? ' (non-codegen fallback ENABLED)' : ''}...`, 'INFO', 'codegen');

  const prompt = buildCodeGenPrompt(investigationData, errorLogs, options?.feedbackInfo);
  const screenshot = investigationData?.screenshot || null;  // v14: JPEG base64
  const ctl = withTimeout(signal, DEFAULT_TRIBUNAL_TIMEOUT_MS);

  try {
    const result = await _runFixConsensus(prompt, models, totalModels, ctl.signal, screenshot);
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
 *
 * BUG FIX (2026-09-04): Added `screenshot` parameter. Previously, this function
 * referenced `screenshot` at line 244 (callBazaarLinkCodeGenWithModel) but it
 * was NOT in the function's parameter list — causing "screenshot is not defined"
 * ReferenceError on every BazaarLink codegen call. The variable was declared
 * in the parent function generateCodeFixViaTribunal() but never passed down.
 */
async function _runFixConsensus(prompt: string, models: any, totalModels: number, signal: any, screenshot?: string | null) {
  let blSkipped = false;
  // TASK 79 (2026-09-25): No more tribunal budget — codegen tribunals don't
  // time out. The budget guard is removed (always allow all models to spawn).
  // The _budgetAllowsAnotherCall() function always returns true now.

  // TASK 79: Increase max listeners on the signal to avoid
  // MaxListenersExceededWarning when 7+ models are spawned in parallel.
  // Each OpenAI SDK call adds an abort listener to the shared AbortSignal.
  try {
    if (signal && typeof setMaxListeners === 'function') {
      // setMaxListeners(50, signal) — allows up to 50 parallel calls
      // (we have max 3 BL + 1 Mistral + 3 VoidAI = 7)
      setMaxListeners(50, signal);
    }
  } catch { /* non-critical */ }

  // TASK 71 (2026-09-23): Run ALL codegen providers in PARALLEL.
  // ----------------------------------------------------------------------
  // The previous code waited for BazaarLink's 3 models (each staggered 3s
  // apart, each ~10s API latency) to ALL complete before Mistral ran,
  // before VoidAI's 7 models started. Total = 30s BL + 9s BL staggering
  // + 1 Mistral + 70s VoidAI + 18s VoidAI staggering = 128s — exceeded
  // the 120s codegen tribunal timeout. So VoidAI's last 3-4 models
  // (the ones the user explicitly added in Task 67) NEVER had a chance
  // to return — the tribunal would abort them mid-flight.
  //
  // Fix: fire one promise per provider, in parallel. Within each provider,
  // we still stagger the per-provider models (3s) so we don't 429 that
  // provider — but the providers no longer block each other. The total
  // wall-clock time is now max(BL_time, Mistral_time, VoidAI_time) ≈
  // 60-90s (well within the 120s budget).
  //
  // We also use proper async-staggering: start the NEXT call after the
  // stagger delay WITHOUT waiting for the previous call to complete.
  // The old `await sleep(); await call();` pattern was sequential, not
  // staggered.
  //
  // Budget guard: if we've already burned >75s and we still have models
  // queued, skip them — better to return partial consensus than to time
  // out and return null (which causes self-heal to abort the whole patch
  // pipeline and the cycle manager's E_PROGRESS_STALL just keeps firing).
  //
  // Also: cap VoidAI to its top 3 models. The user added 7 VoidAI models
  // in Task 67 (gpt-5.3-codex, claude-haiku-4-5, deepseek-v4-pro,
  // qwen3-coder-480b, kimi-k2.7-code, glm-5.3, qwen3.8-27b:free) — but
  // consensus requires only 2 models to agree, and the first 3 are the
  // most capable (gpt-5.3-codex is the primary, per the user's spec).
  // The remaining 4 are lower-priority fallbacks that would push the
  // tribunal past its timeout budget.
  const allPromises: Promise<any>[] = [];

  // --- BazaarLink provider (parallel) ---
  if (models.hasBazaarLink) {
    if (blLimiter.isExhausted()) {
      log('BazaarLink budget exhausted — skipping BazaarLink calls this round', 'WARN', 'codegen');
      blSkipped = true;
    } else {
      // Spawn all BazaarLink model calls in parallel (no staggering BETWEEN
      // providers — only one BL provider instance, so per-provider staggering
      // is moot here; BL's own rate limiter handles internal 429s).
      for (const modelSlug of models.blModels) {
        // TASK 79: Budget guard removed — codegen tribunals don't time out.
        log(`Tribunal: spawning BL/${modelSlug} (parallel)`, 'DEBUG', 'codegen');
        allPromises.push(
          (async () => {
            try {
              const result = await _getBL().callBazaarLinkCodeGenWithModel(prompt, signal, modelSlug, screenshot);
              if (!result) {
                log(`BL/${modelSlug}: parseCodegenResponse returned null`, 'WARN', 'codegen');
              } else if (Array.isArray(result)) {
                log(`BL/${modelSlug}: got ${result.length} raw fix(es) from parser`, 'DEBUG', 'codegen');
              } else {
                log(`BL/${modelSlug}: got non-array result: ${typeof result}`, 'DEBUG', 'codegen');
              }
              return { provider: `BL/${modelSlug}`, fixes: validateFixArray(result) };
            } catch (err: any) {
              // TASK 76 (2026-09-24): Check for permanent errors (402, 403, model_not_found)
              const permCheck = _isPermanentModelError(err);
              if (permCheck.permanent) {
                _markModelExhausted(`BL/${modelSlug}`, permCheck.reason);
              } else if (_isAbortError(err)) {
                // AbortError = timeout, not a real failure. Log differently.
                log(`BL/${modelSlug}: request timed out (AbortError) — model may be slow, not broken. Error: ${String(err.message || err).substring(0, 100)}`, 'WARN', 'codegen');
                return { provider: `BL/${modelSlug}`, fixes: [], error: `Timeout: ${String(err.message || err).substring(0, 100)}` };
              }
              return { provider: `BL/${modelSlug}`, fixes: [], error: String(err.message || err).substring(0, 200) };
            }
          })()
        );
      }
    }
  }

  // --- Mistral provider (parallel) ---
  if (models.hasMistral) {
    log('Tribunal: spawning Mistral (parallel)', 'DEBUG', 'codegen');
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
        .catch((err: any) => {
          // TASK 76: Check for permanent errors
          const permCheck = _isPermanentModelError(err);
          if (permCheck.permanent) {
            _markModelExhausted('Mistral', permCheck.reason);
          } else if (_isAbortError(err)) {
            log(`Mistral: request timed out (AbortError) — model may be slow, not broken.`, 'WARN', 'codegen');
          }
          return { provider: 'Mistral', fixes: [], error: String(err.message || err).substring(0, 200) };
        })
    );
  }

  // --- VoidAI provider (parallel, capped at top 3 models) ---
  // TASK 71: Cap at 3 models to fit within the tribunal's 120s timeout.
  // The user added 7 VoidAI models in Task 67, but consensus only needs
  // 2 agreements. The first 3 (gpt-5.3-codex, claude-haiku-4-5, deepseek-v4-pro)
  // are the most capable. Spawning all 7 in parallel would risk OOM and
  // consume API quota for marginal consensus gain.
  if (models.hasVoidAI) {
    const VOID_MAX_MODELS = 3;
    const voidModelsToTry = models.voidModels.slice(0, VOID_MAX_MODELS);
    if (models.voidModels.length > VOID_MAX_MODELS) {
      log(`Tribunal: capping VoidAI from ${models.voidModels.length} to top ${VOID_MAX_MODELS} models (conserves API quota + memory)`, 'INFO', 'codegen');
    }
    for (const modelSlug of voidModelsToTry) {
      // TASK 79: Budget guard removed — codegen tribunals don't time out.
      log(`Tribunal: spawning VoidAI/${modelSlug} (parallel)`, 'DEBUG', 'codegen');
      allPromises.push(
        (async () => {
          try {
            const result = await _getVoid().callVoidAICodeGenWithModel(prompt, signal, modelSlug);
            if (!result) {
              log(`VoidAI/${modelSlug}: parseCodegenResponse returned null`, 'WARN', 'codegen');
            } else if (Array.isArray(result)) {
              log(`VoidAI/${modelSlug}: got ${result.length} raw fix(es) from parser`, 'DEBUG', 'codegen');
            } else {
              log(`VoidAI/${modelSlug}: got non-array result: ${typeof result}`, 'DEBUG', 'codegen');
            }
            return { provider: `VoidAI/${modelSlug}`, fixes: validateFixArray(result) };
          } catch (err: any) {
            // TASK 76: Check for permanent errors (402, 403, model_not_found)
            const permCheck = _isPermanentModelError(err);
            if (permCheck.permanent) {
              _markModelExhausted(`VoidAI/${modelSlug}`, permCheck.reason);
            } else if (_isAbortError(err)) {
              log(`VoidAI/${modelSlug}: request timed out (AbortError) — model may be slow, not broken.`, 'WARN', 'codegen');
              return { provider: `VoidAI/${modelSlug}`, fixes: [], error: `Timeout: ${String(err.message || err).substring(0, 100)}` };
            }
            return { provider: `VoidAI/${modelSlug}`, fixes: [], error: String(err.message || err).substring(0, 200) };
          }
        })()
      );
    }
  }

  // NO OpenRouter here — it's for vision/general tribunal only.
  // NO Cloudflare, Gemini, or any other non-codegen provider.

  if (allPromises.length === 0) {
    log('No codegen providers available. Need BAZAARLINK_API_KEY, VOIDAI_API_KEY, or MISTRAL_CODE_API_KEY.', 'ERROR', 'codegen');
    return null;
  }

  // TASK 71 (2026-09-23): Fixed pre-existing type assertion bug.
  // Original: `as PromiseSettledResult<{...}[]>` (single settled result whose value is an array)
  // Correct:  `as PromiseSettledResult<{...}>[]` (array of settled results, each holding a single value)
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
async function consultTribunalRaw(prompt: string, signal?: any, options?: { timeoutMs?: number; responseFormatJson?: boolean; screenshot?: string }) {
  const timeoutMs = options?.timeoutMs || DEFAULT_TRIBUNAL_TIMEOUT_MS;

  const models = discoverModels();

  const totalModels = models.blModels.length
    + (models.hasMistral ? 1 : 0)
    + (models.hasVoidAI ? models.voidModels.length : 0);

  log(`\u{1f9e0} TRIBUNAL RAW: Consulting ${totalModels} codegen models for generic task...`, 'INFO', 'codegen');

  const ctl = withTimeout(signal, timeoutMs);

  // TASK 79: Increase max listeners for parallel calls
  try {
    if (ctl.signal && typeof setMaxListeners === 'function') {
      setMaxListeners(50, ctl.signal);
    }
  } catch { /* non-critical */ }

  try {
    // TASK 71 (2026-09-23): Run ALL codegen providers in PARALLEL.
    // The previous code waited for BazaarLink's 3 models (each staggered 3s)
    // to ALL complete before VoidAI's 7 models started — which blew past
    // the 120s tribunal timeout. Now we fire one promise per provider
    // (BazaarLink, Mistral, VoidAI) all at once, with VoidAI capped at its
    // top 3 models (per Task 71 reasoning).
    const allPromises: Promise<{ provider: string; raw: string } | null>[] = [];

    if (models.hasBazaarLink) {
      if (blLimiter.isExhausted()) {
        log('Tribunal raw: BazaarLink budget exhausted — skipping', 'WARN', 'codegen');
      } else {
        for (const modelSlug of models.blModels) {
          log(`Tribunal raw: spawning BL/${modelSlug} (parallel)`, 'DEBUG', 'codegen');
          allPromises.push(_callRawBazaarLink(prompt, ctl.signal, modelSlug, options?.screenshot));
        }
      }
    }

    if (models.hasVoidAI) {
      // TASK 71: cap at top 3 VoidAI models (same as _runFixConsensus)
      const VOID_MAX_MODELS = 3;
      const voidModelsToTry = models.voidModels.slice(0, VOID_MAX_MODELS);
      if (models.voidModels.length > VOID_MAX_MODELS) {
        log(`Tribunal raw: capping VoidAI from ${models.voidModels.length} to top ${VOID_MAX_MODELS} models`, 'INFO', 'codegen');
      }
      for (const modelSlug of voidModelsToTry) {
        log(`Tribunal raw: spawning VoidAI/${modelSlug} (parallel)`, 'DEBUG', 'codegen');
        allPromises.push(_callRawVoidAI(prompt, ctl.signal, modelSlug));
      }
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
async function _callRawBazaarLink(prompt: string, signal: any, modelSlug: string, imageBase64?: string) {
  try {
    const bl = _getBL();
    if (!bl) return null;
    const result = await bl.callBazaarLinkCodeGenWithModel(prompt, signal, modelSlug, imageBase64);
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
 * Call a VoidAI model for raw text (not fix-validated).
 */
async function _callRawVoidAI(prompt: string, signal: any, modelSlug: string) {
  try {
    const voidMod = _getVoid();
    if (!voidMod) return null;
    const result = await voidMod.callVoidAICodeGenWithModel(prompt, signal, modelSlug);
    if (!result) return null;
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    if (!raw || raw.trim().length === 0) return null;
    return { provider: `VoidAI/${modelSlug}`, raw };
  } catch (err: any) {
    log(`Tribunal raw VoidAI/${modelSlug} failed: ${String(err.message || err).substring(0, 200)}`, 'DEBUG', 'codegen');
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

function buildCodeGenPrompt(investigationData: any, errorLogs: any, feedbackInfo?: { lastError?: string; lastFixPreview?: string }) {
  const url = investigationData?.url || null;
  // BUG FIX (2026-09-04): Increased HTML snippet from 1500 to 4000 chars.
  // 1500 chars was too short — the AI couldn't see enough of the page structure
  // to diagnose issues. 4000 chars covers most Flutter Web error dialogs and
  // login page forms while staying within token budget.
  const html = investigationData?.html ? String(investigationData.html).substring(0, 4000) : null;
  const targetFile = investigationData?.targetFile || null;
  const fileContent = investigationData?.fileContent ? String(investigationData.fileContent).substring(0, 12000) : null;
  const isBootTime = !!investigationData?.bootTime;
  const fileListing = investigationData?.fileListing || null;
  const importContext = investigationData?.importContext || null;
  // BUG FIX (2026-09-04): New context fields from enriched investigation.
  const pageText = investigationData?.pageText || null;
  const pageTitle = investigationData?.pageTitle || null;
  const consoleErrors = investigationData?.consoleErrors || null;
  const pageErrors = investigationData?.pageErrors || null;
  const domStats = investigationData?.domStats || null;

  let contextLines: string[] = [];
  contextLines.push(`- Error/reason: ${errorLogs || 'Unknown recurring failure'}`);
  if (url) contextLines.push(`- Current URL: ${url}`);
  if (pageTitle) contextLines.push(`- Page title: ${pageTitle}`);
  if (html) contextLines.push(`- HTML snippet (first 4000 chars):\n${html}`);
  if (pageText) contextLines.push(`- Visible page text: ${pageText}`);
  if (domStats) contextLines.push(`- DOM element counts: ${domStats}`);
  if (consoleErrors && Array.isArray(consoleErrors) && consoleErrors.length > 0) {
    contextLines.push(`- Browser console errors/warnings (last ${consoleErrors.length}):`);
    for (const e of consoleErrors) {
      contextLines.push(`    [${e.type}] ${e.text}${e.url ? ` (url: ${String(e.url).substring(0, 80)})` : ''}`);
    }
  }
  if (pageErrors && Array.isArray(pageErrors) && pageErrors.length > 0) {
    contextLines.push(`- Uncaught JS exceptions (last ${pageErrors.length}):`);
    for (const e of pageErrors) {
      contextLines.push(`    ${e}`);
    }
  }
  if (isBootTime) contextLines.push(`- NOTE: This is a boot-time heal (no browser available). Diagnose from error patterns only.`);

  // v14: Iterative feedback — tell AI what went wrong last time
  if (feedbackInfo?.lastError) {
    contextLines.push(`- PREVIOUS ATTEMPT FAILED: ${feedbackInfo.lastError}`);
    if (feedbackInfo.lastFixPreview) {
      contextLines.push(`- PREVIOUS FIX (rejected): ${feedbackInfo.lastFixPreview}`);
    }
  }

  let prompt = `You are a senior Node.js/TypeScript developer diagnosing and fixing an automation bot.\n`;
  const ctx = _getCodebaseContext();
  if (ctx) prompt += `${ctx}\n`;
  prompt += `CONTEXT:\n${contextLines.join('\n')}\n`;

  // v14: File listing when no target identified
  if (!targetFile && fileListing) {
    prompt += `\nAvailable files (choose the most relevant ones — you may pick up to 3 if the bug spans multiple modules):\n${fileListing}\n`;
  }

  if (targetFile && fileContent) {
    prompt += `\nTarget file to fix: ${targetFile}\n`;
    prompt += `--- BEGIN FILE: ${targetFile} ---\n${fileContent}\n--- END FILE ---\n`;
    // v14: Include import context for cross-file understanding
    if (importContext) {
      prompt += `\n${importContext}\n`;
    }
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Diagnose the ROOT CAUSE of the bug — not just the symptom. Use all available context (error logs, console errors, page text, DOM stats, state transitions) to understand WHY the failure happens.\n`;
    prompt += `2. Propose a fix that addresses the root cause, not just suppresses the symptom.\n`;
    prompt += `3. Return a JSON ARRAY with a SINGLE object (or up to 3 objects if the bug genuinely spans multiple files). Each object must have:\n`;
    prompt += `- "file": "${targetFile}" (exact filename — do NOT invent other filenames)\n`;
    prompt += `- "change": (string) Describe: (a) what the bug is, (b) WHY it happens, (c) how your fix addresses it. Root-cause analysis is required.\n`;
    prompt += `- "patch": (string) EITHER a unified diff OR the complete file content\n`;
    prompt += `PATCH FORMAT: You may return a unified diff (starting with --- a/${targetFile}) for surgical edits,\n`;
    prompt += `OR the complete file content for full replacement. Prefer unified diffs for small changes.\n`;
    prompt += `CRITICAL: Only fix ${targetFile} (and other clearly-related files if the bug spans modules). Do NOT return patches for unrelated files.\n`;
    prompt += `If no fix is possible, return exactly: []\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  } else {
    prompt += `\nNo specific target file identified. Choose from the file list above.\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Diagnose the ROOT CAUSE — use all available context (error logs, console errors, page text, DOM stats, state transitions, URL, page title) to understand WHY the failure happens. Do not just pattern-match the error to a filename — trace the causal chain.\n`;
    prompt += `2. Identify the file(s) whose responsibility aligns with the root cause. You may pick up to 3 files if the bug spans multiple modules.\n`;
    prompt += `3. For EACH file you pick, propose a fix that addresses the root cause.\n`;
    prompt += `4. Return a JSON ARRAY with one object per file (max 3):\n`;
    prompt += `- "file": (string) the exact filename from the available files list\n`;
    prompt += `- "change": (string) Describe: (a) what the bug is, (b) WHY it happens, (c) how your fix addresses it. Root-cause analysis is required.\n`;
    prompt += `- "patch": (string) EITHER a unified diff OR the complete file content\n`;
    prompt += `Do NOT pick a file by name recognition alone — pick it because the error describes a bug in that file's area of responsibility.\n`;
    prompt += `Only return [] if you truly cannot identify any file to fix.\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  }

  return prompt;
}

module.exports = { generateCodeFixViaTribunal, buildCodeGenPrompt, consultTribunalRaw, _injectDependencies };
