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
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const log = _getLogger().log;
    const model = base64Image ? OLLAMA_VISION_MODEL : OLLAMA_MODEL;

    log(`[OLLAMA] Calling ${model} ${base64Image ? '(vision)' : '(text)'} — prompt: ${String(prompt).substring(0, 80)}...`, 'INFO', 'ollama');

    // TIER 1+: Ollama on CPU is slower than cloud providers (30-60s per call).
    // We bypass callChatCompletionWithRollback (which has a 30s default timeout)
    // and call Ollama directly with a 5-minute timeout.
    const requestBody: any = {
      model: model,
      messages: [
        { role: 'system', content: 'You are a helpful assistant that analyzes MathU math questions from screenshots. Respond with valid JSON only.' },
        { role: 'user', content: base64Image
          ? [{ type: 'text', text: String(prompt) }, { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64Image}` } }]
          : String(prompt)
        },
      ],
      max_tokens: options.maxTokens || 2048,
      temperature: options.temperature ?? 0.1,
      stream: false,
    };

    try {
      const response = await fetch(OLLAMA_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ollama',
        },
        body: JSON.stringify(requestBody),
        signal: signal || undefined, // Use the tribunal's signal (5 min timeout)
      });

      if (!response.ok) {
        throw new Error(`Ollama HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || '';

      if (!content || content.trim().length === 0) {
        throw new Error('Ollama returned empty response');
      }

      log(`[OLLAMA] ✅ Response received (${content.length} chars)`, 'INFO', 'ollama');
      return content;
    } catch (err: any) {
      log(`[OLLAMA] ❌ Call failed: ${err.message}`, 'WARN', 'ollama');
      throw err;
    }
  };
}

module.exports = { OllamaProvider };
