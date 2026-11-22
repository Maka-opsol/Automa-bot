'use strict';

// ─── Ollama Provider (the last-hope local fallback) ─────────────────────────
//
// Ollama runs locally on http://localhost:11434 — no API key, no cloud
// dependency. This makes it the bot's ultimate fallback when every cloud
// provider is down (OpenRouter, Groq, z.ai, etc.). Per the design principle:
// "worst case scenario, just rely on the bot's internal systems and what it
// can control." Ollama IS an internal system — it runs on the same host.
//
// SAME INFORMATION AS CLOUD PROVIDERS:
//   The tribunal (providers-tribunal.ts:461) flattens the system prompt +
//   URL hint + UI map + math context (problem type, OCR text, cached/Wolfram
//   solutions) + user instruction into a single `prompt` string, then passes
//   it as the 2nd argument to EVERY provider. This provider passes that
//   `prompt` straight through to callChatCompletionWithRollback, so Ollama
//   receives EXACTLY the same context as OpenRouter, Groq, z.ai, etc.
//   No special handling, no reduced context — first-class treatment.
//
// OpenAI-compatible endpoint:
//   Ollama exposes http://localhost:11434/v1/chat/completions (OpenAI format).
//   callChatCompletionWithRollback already handles this format, including the
//   multipart image_url content for vision. Ollama accepts any bearer token
//   (or none) — we pass a dummy 'ollama' to satisfy the Authorization header.
//
// REACHABILITY GATING (auto-detection, no env var required):
//   The factory must return synchronously (null = provider skipped, or a
//   function = provider active). We do a cached synchronous reachability
//   probe via curl (connect-timeout 1s) — if Ollama is running, the factory
//   returns the provider function; if not, it returns null and the registry
//   skips Ollama cleanly. The probe result is cached for 30 seconds so we
//   don't shell out on every getAvailableProviders() call. If curl isn't
//   available, fall back to the OLLAMA_ENABLED env var.
//
//   This means: start Ollama on the host, and within 30 seconds the bot
//   auto-detects it and adds it to the tribunal pool + model_registry
//   fallback. Stop Ollama, and the bot stops trying to use it (no wasted
//   cycles hitting a dead localhost).
//
// VISION MODEL REQUIREMENT:
//   The tribunal sends a base64 screenshot with every call. The default model
//   MUST be vision-capable. Default: qwen2.5vl:7b (vision-capable, runs on
//   modest hardware). Override with OLLAMA_MODEL env var (e.g. 'llama3.2-vision:11b',
//   'qwen2.5vl:32b', 'minicpm-v:8b'). The user must `ollama pull <model>` first.
//
// TOLERANT PARSING (for small models):
//   A 7B local model is more likely than a frontier cloud model to produce
//   slightly malformed JSON or miss fields. We tolerate missing actionType /
//   currentState (default to 'wait' / 'unknown') rather than discarding the
//   response — same pattern as providers-agnes.ts.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

// ─── Reachability probe (cached, synchronous via curl) ─────────────────────
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || 'http://localhost:11434';
const OLLAMA_HEALTH_URL = OLLAMA_BASE_URL + '/api/tags'; // native list-models endpoint
const PROBE_CACHE_TTL_MS = 30 * 1000; // 30 seconds

let _probeCache: { reachable: boolean; probedAt: number } | null = null;

/**
 * Synchronous reachability probe for the local Ollama server.
 * Uses curl with a 1s connect timeout (available on Linux/macOS).
 * Returns true if Ollama responded, false otherwise. Cached for 30s.
 *
 * If curl isn't available, falls back to the OLLAMA_ENABLED env var
 * (set OLLAMA_ENABLED=1 to force-enable without a probe).
 */
function _probeReachability(): boolean {
  // Force-enable via env (skip the probe entirely)
  if (process.env.OLLAMA_ENABLED === '1' || process.env.OLLAMA_ENABLED === 'true') {
    return true;
  }

  // Return cached result if fresh
  const now = Date.now();
  if (_probeCache && (now - _probeCache.probedAt) < PROBE_CACHE_TTL_MS) {
    return _probeCache.reachable;
  }

  // Synchronous probe via curl (1s connect timeout, 2s total timeout)
  let reachable = false;
  try {
    const { execSync } = require('child_process');
    const result = execSync(
      `curl -s -o /dev/null -w "%{http_code}" --connect-timeout 1 --max-time 2 "${OLLAMA_HEALTH_URL}"`,
      { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();
    // Ollama returns 200 on /api/tags when running. Accept any 2xx.
    reachable = /^2\d\d$/.test(result);
  } catch {
    // curl not available, or Ollama not running, or timeout — not reachable
    reachable = false;
  }

  _probeCache = { reachable, probedAt: now };
  return reachable;
}

/**
 * Force-refresh the reachability cache. Used by the smoke test and by
 * the health monitor to re-probe after Ollama starts/stops.
 */
function _refreshReachability(): boolean {
  _probeCache = null;
  return _probeReachability();
}

/**
 * Get the current cached reachability state (without re-probing).
 * Used for diagnostics / getStatus.
 */
function _getReachabilityState(): { reachable: boolean; probedAt: number | null; cacheAgeMs: number } {
  if (!_probeCache) {
    return { reachable: false, probedAt: null, cacheAgeMs: -1 };
  }
  return {
    reachable: _probeCache.reachable,
    probedAt: _probeCache.probedAt,
    cacheAgeMs: Date.now() - _probeCache.probedAt,
  };
}

// ─── Provider factory ──────────────────────────────────────────────────────

function OllamaProvider() {
  // Gate on reachability — if Ollama isn't running, return null so the
  // registry skips this provider cleanly (no wasted cycles hitting localhost).
  if (!_probeReachability()) {
    return null;
  }

  // Ollama needs no API key — pass a dummy to satisfy the Authorization
  // header that callChatCompletionWithRollback always sends.
  const apiKey = process.env.OLLAMA_API_KEY || 'ollama';

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Ollama');
    const model = process.env.OLLAMA_MODEL || config.model;

    // Pass the SAME prompt that every cloud provider receives — the tribunal
    // has already flattened system prompt + URL + UI map + math context into
    // this single string. No reduced context, no special handling.
    // format:json — Ollama maps response_format {type:'json_object'} to
    // format:json, forcing valid JSON output instead of prose (the vision prompts
    // already contain the word JSON which Ollama requires). If the model rejects
    // it, callChatCompletionWithRollback 422 handler retries without it — no regression.
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, model, base64Image, prompt, 'Ollama',
        { signal, maxTokens: options.maxTokens, temperature: options.temperature ?? 0.1, timeoutMs: 0, responseFormat: { type: 'json_object' } }
      ),
      { providerName: 'Ollama', signal, maxRetries: options.maxRetries ?? 2, baseDelay: 2000 }
    );

    if (options.validate === false) return rawContent;

    // Tolerant parsing — small local models may miss fields or produce
    // slightly malformed JSON. Don't discard the response; default missing
    // fields rather than throwing. Same pattern as providers-agnes.ts.
    const parsed = extractJSON(rawContent, 'Ollama');
    if (!parsed || typeof parsed !== 'object') {
      // Non-object response — return a safe wait action with the raw text in
      // reasoning, so the tribunal can still use it rather than failing hard.
      return {
        actionType: 'wait',
        currentState: 'unknown',
        reasoning: `Ollama returned non-object response: ${String(rawContent).slice(0, 200)}`,
      };
    }
    if (!parsed.actionType || typeof parsed.actionType !== 'string') {
      parsed.actionType = 'wait';
    }
    if (!parsed.currentState || typeof parsed.currentState !== 'string') {
      parsed.currentState = 'unknown';
    }
    if (!parsed.reasoning || typeof parsed.reasoning !== 'string') {
      parsed.reasoning = `Ollama ${model} (tolerant parse — actionType: ${parsed.actionType})`;
    }
    return validateActionResponse(parsed, 'Ollama');
  };
}

module.exports = {
  OllamaProvider,
  _probeReachability,
  _refreshReachability,
  _getReachabilityState,
  OLLAMA_BASE_URL,
};
