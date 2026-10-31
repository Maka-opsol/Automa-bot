'use strict';

// ─── Ollama Provider (Local LLM) ──────────────────────────────────────────
//
// TIER 1+ (2026-10-31): Self-hosted LLM that runs on the GitHub Actions runner.
// Calls http://localhost:11434/v1/chat/completions (Ollama's OpenAI-compatible API).
//
// KEY ADVANTAGE: NEVER gets blacklisted. When cloud providers (Groq, z.ai,
// OpenRouter, etc.) hit rate limits or go down, this provider stays available.
// The bot never has to "wait for providers to recover" — it just uses Ollama.
//
// CONFIG:
//   OLLAMA_ENDPOINT=http://localhost:11434/v1/chat/completions (default)
//   OLLAMA_MODEL=qwen2.5-coder:7b (default — good for code + general reasoning)
//   OLLAMA_VISION_MODEL=llava:7b (for screenshot analysis — pulled separately)
//
// VISION SUPPORT:
//   - llava:7b can analyze screenshots (base64 image input)
//   - qwen2.5-coder:7b is text-only (good for self-heal code review)
//   - The provider auto-selects the right model based on whether an image is passed.
//
// MEMORY: ~4GB when model is loaded. Model stays warm in Ollama's cache.
// ═══════════════════════════════════════════════════════════════════════

const { callChatCompletionWithRollback } = require('./providers-base');

let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

const OLLAMA_ENDPOINT = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434/v1/chat/completions';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5-coder:7b';
const OLLAMA_VISION_MODEL = process.env.OLLAMA_VISION_MODEL || 'llava:7b';

// Check if Ollama server is running
let _ollamaChecked = false;
let _ollamaAvailable = false;
function _checkOllama(): boolean {
  if (_ollamaChecked) return _ollamaAvailable;
  _ollamaChecked = true;
  try {
    // Synchronous check via HTTP (use fetch with no-await)
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    fetch('http://localhost:11434/api/tags', { signal: controller.signal })
      .then((r: any) => { _ollamaAvailable = r.ok; })
      .catch(() => { _ollamaAvailable = false; })
      .finally(() => clearTimeout(timeout));
  } catch {
    _ollamaAvailable = false;
  }
  return _ollamaAvailable;
}

/**
 * Call Ollama for chat completion (text-only or vision).
 * Uses the same OpenAI-compatible interface as other providers.
 */
async function callOllama(
  base64Image: string | null,
  prompt: string,
  options: { signal?: any; maxTokens?: number; temperature?: number } = {}
): Promise<string> {
  const log = _getLogger().log;
  const model = base64Image ? OLLAMA_VISION_MODEL : OLLAMA_MODEL;
  const apiKey = 'ollama'; // Ollama doesn't need a real key

  log(`[OLLAMA] Calling ${model} ${base64Image ? '(vision)' : '(text)'} — prompt: ${prompt.substring(0, 80)}...`, 'DEBUG', 'ollama');

  try {
    const result = await callChatCompletionWithRollback(
      OLLAMA_ENDPOINT,
      apiKey,
      model,
      base64Image,
      prompt,
      'Ollama',
      {
        signal: options.signal,
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
}

/**
 * Quick health check — is Ollama running?
 */
async function isAvailable(): Promise<boolean> {
  try {
    const response = await fetch('http://localhost:11434/api/tags', {
      signal: AbortSignal.timeout?.(2000) || undefined,
    });
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * List available Ollama models.
 */
async function listModels(): Promise<string[]> {
  try {
    const response = await fetch('http://localhost:11434/api/tags');
    const data = await response.json();
    return (data.models || []).map((m: any) => m.name);
  } catch {
    return [];
  }
}

module.exports = {
  callOllama,
  isAvailable,
  listModels,
  OLLAMA_ENDPOINT,
  OLLAMA_MODEL,
  OLLAMA_VISION_MODEL,
};
