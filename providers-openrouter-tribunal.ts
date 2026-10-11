'use strict';
// Last modified: 2026-08-12 — openrouter/free-first strategy with fallback fatigue

// ─── OpenRouter Tribunal Provider ───────────────────────────────────────────
//
// Strategy: openrouter/free is king. It auto-routes to whatever free model
// is healthy on OpenRouter. We give it the most chances and only fall back
// to specific models as a distant last resort.
//
// Why? On 512MB Render, cycling through 6 specific models burns memory.
// openrouter/free will work *eventually* — and time is the one thing we have.
//
// Phase 1: openrouter/free with generous retries (4 attempts)
// Phase 2: Specific fallback models (only if not fatigued)
// Phase 3: Last-gasp openrouter/free

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, retryWithBackoff, _getOrLimiter } = require('./providers-base');
const { providerSupportsVision } = require('./providers-serializers');

// Lazy logger
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

// Lazy registry (for checking if other providers are available)
let _registry: any = null;
function _getRegistry() { if (!_registry) _registry = require('./providers-registry'); return _registry; }

/* ── Fallback fatigue ───────────────────────────────────────────────────
 * When specific fallback models keep failing, we stop bothering with them
 * entirely. openrouter/free auto-routes anyway — no point naming specific
 * models if they all die. Fatigue resets on any success or after 10 min.
 *
 * TASK 112 (2026-10-08): Check daily limit BEFORE wasting API calls.
 * If X-RateLimit-Remaining is 0, the daily free-model quota is exhausted.
 * No point making 4+ API calls that will all 429. Check the limit first,
 * and if exhausted, throw immediately with OPENROUTER_DAILY_LIMIT so the
 * cycle manager can park until midnight.
 */
let _fallbackFatigueCount = 0;
let _fallbackFatigueResetTimer: any = null;
const FALLBACK_FATIGUE_THRESHOLD = 3;         // 3 specific-model failures → skip them
const FALLBACK_FATIGUE_RESET_MS = 10 * 60 * 1000;

// TASK 112: Track daily limit exhaustion
let _dailyLimitExhausted = false;
let _dailyLimitResetTime = 0;

/* ── openrouter/free retry config ───────────────────────────────────────────
 * openrouter/free gets way more chances than any specific model.
 * It auto-routes to whatever's healthy — it'll work eventually.
 */
const OR_FREE_RETRIES = 3;                    // retries (4 total attempts: 1 + 3)
const OR_FREE_BASE_DELAY = 2000;              // 2s → 4s → 8s backoff

/** Record a specific-model failure. Returns true when fatigue threshold is hit. */
function _recordFallbackFailure(): boolean {
  _fallbackFatigueCount++;
  // Reset the cooldown timer on each new failure
  if (_fallbackFatigueResetTimer) clearTimeout(_fallbackFatigueResetTimer);
  _fallbackFatigueResetTimer = setTimeout(() => {
    _fallbackFatigueCount = 0;
    _fallbackFatigueResetTimer = null;
  }, FALLBACK_FATIGUE_RESET_MS);
  return _fallbackFatigueCount >= FALLBACK_FATIGUE_THRESHOLD;
}

/** Reset fatigue on any success. */
function _resetFallbackFatigue(): void {
  _fallbackFatigueCount = 0;
  if (_fallbackFatigueResetTimer) {
    clearTimeout(_fallbackFatigueResetTimer);
    _fallbackFatigueResetTimer = null;
  }
}

function _isFallbackFatigued(): boolean {
  return _fallbackFatigueCount >= FALLBACK_FATIGUE_THRESHOLD;
}

/**
 * Known free vision models on OpenRouter, ordered by quality.
 * (V) = vision-capable. Text-only models filtered at runtime.
 */
const VISION_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',           // (V) Best free vision model on OpenRouter
  'qwen/qwen2.5-vl-72b-instruct:free',   // (V) Qwen vision — excellent at math OCR
  'google/gemma-3-12b-it:free',           // (V) Smaller Gemma, still good vision
];

/**
 * Text-only fallback models. Used only when:
 *   1. No image is provided (text-only request), OR
 *   2. All vision models failed and we have no other option
 * These are cheap, fast, but CANNOT process images.
 */
const TEXT_FALLBACK_MODELS = [
  'google/gemma-4-31b-it:free',                     // (T) Updated Aug 2026
  'nvidia/nemotron-3-super-120b:free',               // (T) Efficient MoE, strong reasoning
  'deepseek/deepseek-r1-distill-llama-70b:free',      // (T) Reasoning (if still available)
];

function OpenRouterTribunalProvider() {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return null;
  }

  // The primary model can be overridden via env var
  const primaryModel = process.env.OPENROUTER_TRIBUNAL_MODEL || 'openrouter/free';
  const endpoint = 'https://openrouter.ai/api/v1/chat/completions';

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const log = _getLogger().log;
    const hasImage = !!base64Image;
    const isFatigued = _isFallbackFatigued();

    // TASK 112: Check daily limit BEFORE making any API calls.
    // If the daily limit is exhausted, throw immediately — don't waste
    // time on 4+ API calls that will all 429. The cycle manager handles
    // OPENROUTER_DAILY_LIMIT by parking until midnight.
    if (_dailyLimitExhausted) {
      if (Date.now() < _dailyLimitResetTime) {
        const remainingMin = Math.round((_dailyLimitResetTime - Date.now()) / 60000);
        log(`OpenRouter: daily limit exhausted — skipping all API calls (${remainingMin}min until reset)`, 'WARN', 'openrouter');
        throw new Error(`OPENROUTER_DAILY_LIMIT: ${remainingMin}min until reset`);
      } else {
        // Reset time passed — clear the flag
        _dailyLimitExhausted = false;
        log('OpenRouter: daily limit reset time passed — clearing flag, resuming API calls', 'INFO', 'openrouter');
      }
    }

    /**
     * Try a single model with retries. Must live here to capture
     * signal/base64Image/prompt/options from the closure.
     */
    const _tryModel = async (model: string, retries = OR_FREE_RETRIES, baseDelay = OR_FREE_BASE_DELAY): Promise<any> => {
      const rawContent = await retryWithBackoff(
        () => callChatCompletionWithRollback(
          endpoint, apiKey, model, base64Image, prompt, 'OpenRouter',
          { signal }
        ),
        { providerName: 'OpenRouter', maxRetries: retries, baseDelay, signal }
      );
      if (options.validate === false) return rawContent;
      return validateActionResponse(extractJSON(rawContent, 'OpenRouter'), 'OpenRouter');
    };

    // ══════════════════════════════════════════════════════════════════════════
    // PHASE 1: openrouter/free — always first, always the most chances
    // It auto-routes to whatever free model is healthy. Gamble, but cheap.
    // ══════════════════════════════════════════════════════════════════════════
    if (isFatigued) {
      log('OpenRouter: fatigued (' + _fallbackFatigueCount + ' failures), openrouter/free only', 'WARN', 'openrouter');
    }

    try {
      const result = await _tryModel('openrouter/free');
      _resetFallbackFatigue();
      return result;
    } catch (phase1Err: any) {
      // openrouter/free didn't work this time — that's fine, it'll work eventually
      const p1Msg = phase1Err?.message || String(phase1Err);

      // Permanent errors (auth) — no point trying anything else
      if (p1Msg.includes('HTTP_ERROR_401') || p1Msg.includes('HTTP_ERROR_403')) {
        throw phase1Err;
      }

      log('OpenRouter: openrouter/free failed (' + p1Msg.slice(0, 80) + '), trying specific fallbacks', 'WARN', 'openrouter');

      // ══════════════════════════════════════════════════════════════════════
      // PHASE 2: Specific fallback models (only if NOT fatigued)
      // If specific models have been failing, don't waste memory on them.
      // ══════════════════════════════════════════════════════════════════════
      if (!isFatigued) {
        const fallbackPool = hasImage
          ? [...VISION_FALLBACK_MODELS, ...TEXT_FALLBACK_MODELS]
          : [...TEXT_FALLBACK_MODELS];

        // Deduplicate against openrouter/free (already tried)
        const seen = new Set<string>(['openrouter/free']);
        const models = fallbackPool.filter((m: string) => {
          if (seen.has(m)) return false;
          seen.add(m);
          return true;
        });

        for (const m of models) {
          // Skip text-only for vision requests
          if (hasImage && !providerSupportsVision('OpenRouter', m)) {
            continue;
          }

          try {
            const result = await retryWithBackoff(
              () => callChatCompletionWithRollback(
                endpoint, apiKey, m, base64Image, prompt, 'OpenRouter',
                { signal }
              ),
              { providerName: 'OpenRouter', maxRetries: 1, baseDelay: 1000, signal }
            );
            // Specific model worked — but openrouter/free is still king
            _resetFallbackFatigue();
            if (options.validate === false) return result;
            return validateActionResponse(extractJSON(result, 'OpenRouter'), 'OpenRouter');
          } catch (err: any) {
            const errMsg = err?.message || String(err);

            // Permanent = stop entirely
            if (errMsg.includes('HTTP_ERROR_400') || errMsg.includes('HTTP_ERROR_401') || errMsg.includes('HTTP_ERROR_403')) {
              throw err;
            }

            // Track fatigue — if specific models keep dying, stop bothering
            if (_recordFallbackFailure()) {
              log('OpenRouter: fallback fatigue hit (' + _fallbackFatigueCount + '), skipping rest', 'WARN', 'openrouter');
              break;
            }

            if (errMsg.includes('HTTP_ERROR_404') || errMsg.includes('does not exist')) {
              log('OpenRouter: model ' + m + ' gone, next', 'WARN', 'openrouter');
              continue;
            }
            if (errMsg.includes('HTTP_ERROR_429') || errMsg.includes('HTTP_ERROR_5') || errMsg.includes('timeout') || errMsg.includes('ECONNREFUSED')) {
              log('OpenRouter: model ' + m + ' transient error, next', 'WARN', 'openrouter');
              continue;
            }
            if (errMsg.includes('No action returned') || errMsg.includes('missing actionType') || errMsg.includes('no JSON object found')) {
              log('OpenRouter: model ' + m + ' bad response, next', 'WARN', 'openrouter');
              continue;
            }
            throw err;
          }
        }
      }

      // ══════════════════════════════════════════════════════════════════════
      // PHASE 3: Last-gasp openrouter/free
      // Everything else failed. One more shot at the auto-router.
      // ══════════════════════════════════════════════════════════════════════
      log('OpenRouter: all fallbacks failed, one last openrouter/free attempt', 'WARN', 'openrouter');
      const result = await _tryModel('openrouter/free', 1, 3000);
      _resetFallbackFatigue();
      return result;
    }
  };
}

/**
 * Check if OpenRouter is the ONLY available provider right now.
 * Used to decide whether to sleep until midnight when budget is exhausted.
 */
async function _isOnlyProvider(): Promise<boolean> {
  try {
    const registry = _getRegistry();
    const providers = await registry.getAvailableProviders();
    // Filter out OpenRouter itself — are there any OTHER providers?
    const others = providers.filter((p: any) => p.name !== 'OpenRouter');
    return others.length === 0;
  } catch {
    return true; // Assume only provider if we can't check
  }
}

/**
 * Graceful wait: if OpenRouter budget is exhausted AND no other providers
 * are available, sleep until midnight UTC (or 30min, whichever is shorter).
 * This prevents the death spiral when OpenRouter is the ONLY provider.
 */
async function waitForOpenRouterBudget(): Promise<void> {
  const limiter = _getOrLimiter();
  const log = _getLogger().log;

  try {
    limiter.checkBudget('critical');
    // Budget available — no need to wait
    return;
  } catch {
    // Budget exhausted
  }

  // Check if other providers are available
  const onlyProvider = await _isOnlyProvider();
  if (!onlyProvider) {
    log('OpenRouter budget exhausted but other providers available — letting them handle it', 'INFO', 'openrouter');
    return;
  }

  // No other providers — sleep until midnight
  await limiter.waitForBudget('critical', {
    checkOtherProviders: async () => !(await _isOnlyProvider()),
  });
}

/**
 * TASK 112: Set the daily limit exhaustion flag.
 * Called by providers-base.ts when a 429 "free-models-per-day" error is received.
 * @param resetTime - epoch milliseconds when the daily quota resets
 */
function _setDailyLimitExhausted(resetTime: number): void {
  _dailyLimitExhausted = true;
  _dailyLimitResetTime = resetTime;
  const { log } = require('./logger');
  log(`OpenRouter: daily limit flag SET — will skip all API calls until ${new Date(resetTime).toISOString()} (${Math.round((resetTime - Date.now()) / 60000)}min)`, 'WARN', 'openrouter');
}

module.exports = { OpenRouterTribunalProvider, waitForOpenRouterBudget, _fallbackFatigueCount: () => _fallbackFatigueCount, _setDailyLimitExhausted };
