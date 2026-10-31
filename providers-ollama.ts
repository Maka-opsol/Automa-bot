'use strict';

// ─── Ollama Provider (Local LLM) ──────────────────────────────────────────
//
// TIER 1+ (2026-10-31): Self-hosted LLM that runs on the GitHub Actions runner.
// Calls http://localhost:11434/v1/chat/completions (Ollama's OpenAI-compatible API).
//
// KEY ADVANTAGE: NEVER gets blacklisted. When cloud providers (Groq, z.ai,
// OpenRouter, etc.) hit rate limits or go down, this provider stays available.
//
// Uses llava:7b for both vision (screenshot analysis) and text (code review).
// Ollama doesn't need an API key — the "apiKey" is just a dummy string.
// ═══════════════════════════════════════════════════════════════════════

const { callChatCompletionWithRollback } = require('./providers-base');

let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434/v1/chat/completions';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llava:7b';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'llava:7b';

/**
 * Factory function — matches the pattern of other providers (Groq, z.ai, etc.)
 * Returns null if Ollama isn't available (no server running).
 * Returns an async callable that takes (base64Image, prompt, signal, options).
 */
function OllamaProvider() {
  // Ollama is a local server — always "has credentials" (no API key needed)
  // Return the callable directly. The callable checks if Ollama is actually
  // running at call time and throws if not (which the tribunal handles).
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const log = _getLogger().log;
    const model = base64Image ? OLLAMA_VISION_MODEL : OLLAMA_MODEL;

    log(`[OLLAMA] Calling ${model} ${base64Image ? '(vision)' : '(text)'} — prompt: ${String(prompt).substring(0, 80)}...`, 'DEBUG', 'ollama');

    try {
      const result = await callChatCompletionWithRollback(
        OLLAMA_ENDPOINT,
        'ollama',  // dummy API key — Ollama doesn't check it
        model,
        base64Image,
        prompt,
        'Ollama',
        {
          signal: signal,
          maxTokens: options.maxTokens || 2048,
          temperature: options.temperature ?? 0.1,
          systemMessage: 'You are a helpful assistant that analyzes MathU math questions from screenshots. Respond with valid JSON only.',
        }
      );
      log(`[OLLAMA] ✅ Response received (${result.length} chars)`, 'DEBUG', 'ollama');
      return result;
    } catch (err: any) {
      log(`[OLLAMA] ❌ Call failed: ${err.message}`, 'WARN', 'ollama');
      throw err;
    }
  };
}

module.exports = { OllamaProvider };
