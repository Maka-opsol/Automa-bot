'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function getCallChatCompletion() { return _deps.providersBase?.callChatCompletionWithRollback || require('./providers-base').callChatCompletionWithRollback; }
function getGetActiveModel() { return _deps.database?.getActiveModel; }
function getAuditPatchContent() { return _deps.sandboxExecutor?.auditPatchContent || require('./sandbox-executor').auditPatchContent; }

/**
 * Self-heal auditor — Layer 2 of the two-layer audit system.
 *
 * v2: Enhanced for non-codegen provider patches.
 * When a patch comes from a non-codegen provider (Gemini, Groq, Cloudflare,
 * etc.), additional safety layers are activated:
 *
 *   - Extended keyword scanning (more patterns)
 *   - Higher auditor count (more independent models vote)
 *   - Stricter supermajority threshold (3/4 instead of 2/3)
 *   - Output structure validation (full file content vs unified diff)
 *   - Single-veto enforcement (any single auditor can block)
 *   - Size and entropy checks
 */

// ─── Keyword Pre-Filter ───
// These are patterns that are obviously malicious regardless of context.
const FORBIDDEN_KEYWORDS = [
  'child_process', 'exec(', 'spawn(', 'eval(', 'Function(',
  'require("fs")', "require('fs')", 'fs.readFile', 'fs.writeFile', 'fs.unlink',
  'process.env',
  'atob(', 'btoa(',
];

// v2: Extended keyword list for non-codegen patches (more dangerous models)
const EXTENDED_FORBIDDEN_KEYWORDS = [
  ...FORBIDDEN_KEYWORDS,
  // Data exfiltration vectors
  'fetch(', 'http.get', 'http.request', 'https://',
  'XMLHttpRequest', 'WebSocket',
  'net.connect', 'dns.lookup',
  // File system access (beyond what's needed)
  'fs.mkdir', 'fs.rmdir', 'fs.rmSync', 'fs.unlinkSync',
  'fs.copyFile', 'fs.renameSync',
  // Code execution vectors
  'new Function', 'vm.runInNewContext', 'vm.runInThisContext',
  'require("child_process")', "require('child_process')",
  // Network exfiltration patterns
  'encodeURIComponent', 'JSON.stringify(process',
  // Process manipulation
  'process.exit(', 'process.kill(', 'process.disconnect(',
  // Module cache poisoning
  'delete require.cache',
  // Timer bombs
  'setInterval(', 'setTimeout(.*\d{6,}',
  // Environment access
  'process.env.HOME', 'process.env.USER', 'process.env.PATH',
];

/**
 * Context-aware keyword scan: matches against the patch, but skips any
 * pattern that ALSO appears in the original file content (when provided).
 * This prevents false positives on patches to files that legitimately
 * use `process.env`, `fs.readFile`, `require('fs')`, etc.
 *
 * Returns a structured result so callers can surface WHICH keywords
 * matched — previously the message was just "Blocked by keyword scanner"
 * with no way to debug.
 */
function isObviouslyMalicious(patchText: any, originalContent?: string): boolean {
  return scanForKeywords(patchText, originalContent).matched.length > 0;
}

function scanForKeywords(patchText: any, originalContent?: string): { matched: string[] } {
  if (!patchText || typeof patchText !== 'string') return { matched: [] };
  const lower = patchText.toLowerCase();
  const origLower = originalContent ? originalContent.toLowerCase() : '';
  const matched: string[] = [];
  for (const keyword of FORBIDDEN_KEYWORDS) {
    const kw = keyword.toLowerCase();
    if (lower.includes(kw)) {
      // Skip if the pattern already exists in the original file — patching
      // a file that already uses process.env / fs.readFile / etc. is fine.
      if (origLower && origLower.includes(kw)) continue;
      matched.push(keyword);
    }
  }
  return { matched };
}

/**
 * v2: Extended keyword check for non-codegen patches.
 * Checks a broader set of dangerous patterns AND also validates
 * the structural integrity of the patch.
 *
 * Context-aware: skips keyword patterns already present in originalContent.
 */
function isObviouslyMaliciousExtended(patchText: any, originalContent?: string): { malicious: boolean; reasons: string[] } {
  const lower = patchText.toLowerCase();
  const origLower = originalContent ? originalContent.toLowerCase() : '';
  const reasons: string[] = [];

  for (const keyword of EXTENDED_FORBIDDEN_KEYWORDS) {
    const kw = keyword.toLowerCase();
    if (lower.includes(kw)) {
      if (origLower && origLower.includes(kw)) continue;
      reasons.push(`Extended keyword: ${keyword}`);
    }
  }

  // Structural checks
  if (!patchText || typeof patchText !== 'string') {
    reasons.push('Patch is not a string');
  } else {
    // Check for unified diff format (self-heal only supports full file replacement)
    if (patchText.trimStart().startsWith('---')) {
      reasons.push('Patch is a unified diff (not full file replacement)');
    }
    // Check for suspiciously short patches
    if (patchText.trim().length < 50) {
      reasons.push('Patch is suspiciously short (< 50 chars)');
    }
    // Check for suspiciously large patches
    if (patchText.length > 200 * 1024) {
      reasons.push('Patch is suspiciously large (> 200KB)');
    }
    // Check for binary-like content
    const nullByteCount = (patchText.match(/\0/g) || []).length;
    if (nullByteCount > 0) {
      reasons.push(`Patch contains ${nullByteCount} null byte(s)`);
    }
    // Check for high entropy (possible encrypted/obfuscated content)
    if (_hasHighEntropy(patchText)) {
      reasons.push('Patch has unusually high entropy (possible obfuscation)');
    }
    // Check that patch starts with a valid module pattern
    const trimmedStart = patchText.trimStart().substring(0, 20);
    const validStarts = ["'use strict'", '"use strict"', 'import ', 'export ', '//', '/*', '/**'];
    if (!validStarts.some(s => trimmedStart.startsWith(s))) {
      reasons.push(`Patch doesn't start with a recognized module pattern (starts with: "${trimmedStart.substring(0, 30)}")`);
    }
    // Check for unbalanced braces (basic syntax sanity)
    if (!_hasBalancedBraces(patchText)) {
      reasons.push('Patch has unbalanced braces/brackets/parens');
    }
  }

  return { malicious: reasons.length > 0, reasons };
}

/**
 * Calculate Shannon entropy of a string.
 * High entropy (> 4.5) suggests encrypted or compressed content.
 */
function _shannonEntropy(str: string): number {
  const freq: Record<string, number> = {};
  for (const ch of str) {
    freq[ch] = (freq[ch] || 0) + 1;
  }
  let entropy = 0;
  const len = str.length;
  for (const ch in freq) {
    const p = freq[ch] / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

function _hasHighEntropy(str: string): boolean {
  // Only check if patch is reasonably long
  if (str.length < 200) return false;
  // Sample entropy on first 1000 chars for speed
  const sample = str.substring(0, 1000);
  return _shannonEntropy(sample) > 4.5;
}

/**
 * Check if braces, brackets, and parentheses are balanced.
 * Ignores those inside strings and comments (basic check).
 */
function _hasBalancedBraces(str: string): boolean {
  let depth = 0;
  let bracketDepth = 0;
  let parenDepth = 0;
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    const next = str[i + 1];

    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === inString) inString = null;
      continue;
    }

    if (ch === '/' && next === '/') { inLineComment = true; i++; continue; }
    if (ch === '/' && next === '*') { inBlockComment = true; i++; continue; }
    if (ch === '"' || ch === "'" || ch === '`') { inString = ch; continue; }

    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (ch === '[') bracketDepth++;
    else if (ch === ']') bracketDepth--;
    else if (ch === '(') parenDepth++;
    else if (ch === ')') parenDepth--;

    if (depth < 0 || bracketDepth < 0 || parenDepth < 0) return false;
  }

  return depth === 0 && bracketDepth === 0 && parenDepth === 0;
}

// ─── AI Auditor Configuration ───

const AUDITOR_PROMPT = `
You are a strict cybersecurity auditor for an autonomous bot.
Another AI has generated a JavaScript/TypeScript code patch as a FULL FILE REPLACEMENT
(i.e., the patch IS the new version of the file — not a diff).

YOUR ONLY JOB is to determine if this code is MALICIOUS or DANGEROUS.

CRITICAL — CONTEXT-AWARE EVALUATION:
If the "CURRENTLY APPROVED VERSION" section is provided below, you MUST compare the
patch against it. Patterns that ALREADY EXIST in the approved version are pre-approved
and MUST NOT be flagged. Only flag NEW dangerous patterns that the patch INTRODUCES.
For example, if the approved version already fetches from api.proxyscrape.com and the
patch keeps that same fetch, that is NOT a violation — the integration was already
approved. Only flag a NEW fetch to a domain that wasn't already in the approved version.

You must REJECT the patch if it INTRODUCES any of the following:
1. NEW network requests to domains OTHER THAN the target website (mathu.co.za,
   microsoftonline.com) or already-approved integrations present in the current version.
2. NEW attempts to read, write, or delete files outside of the bot's own directory.
3. NEW usage of 'child_process', 'exec', 'spawn', or 'eval()'.
4. NEW attempts to steal environment variables and send them externally.
5. NEW infinite loops or intentional memory bombs.
6. NEW obfuscated code (base64 decoding, weird hex sequences).

Respond ONLY in this exact JSON format:
{ "is_safe": true/false, "reason": "One sentence explaining why." }
`;

/**
 * v2: Stricter auditor prompt for non-codegen patches.
 * Adds more specific checks for common non-codegen failure modes.
 * Also context-aware: skips patterns already present in the approved version.
 */
const NON_CODEGEN_AUDITOR_PROMPT = `
You are an EXTREMELY strict cybersecurity auditor for an autonomous bot.
A NON-CODE-GENERATION AI model (like Gemini, Groq, or Cloudflare) has generated
a JavaScript/TypeScript code patch as a FULL FILE REPLACEMENT. These models are
NOT designed for code generation and frequently produce dangerous, malformed, or
subtly broken code.

CRITICAL — CONTEXT-AWARE EVALUATION:
If the "CURRENTLY APPROVED VERSION" section is provided below, you MUST compare the
patch against it. Patterns that ALREADY EXIST in the approved version are pre-approved
and MUST NOT be flagged. Only flag NEW dangerous patterns the patch INTRODUCES.

You must REJECT the patch if it INTRODUCES any of the following:
1. NEW network requests to ANY domain not already present in the approved version.
2. NEW file system operations (fs.read, fs.write, etc.) not already in the approved version.
3. NEW usage of 'child_process', 'exec', 'spawn', 'eval()', 'Function('.
4. NEW access to environment variables not already in the approved version.
5. NEW infinite loops, unbounded recursion, or memory bombs.
6. NEW obfuscated code (base64, hex sequences, encoded strings).
7. NEW code that modifies process-level state (process.env.X = ..., process.exit()).
8. Code that seems like placeholder/dummy content (e.g., just 'use strict' with nothing else, or a file that just exports an empty object).
9. NEW imports or requires of modules not already used in the approved version.
10. The patch looks like a DESCRIPTION of a fix rather than actual code.
11. The patch contains markdown, HTML, or non-JavaScript content.
12. The patch is a unified diff (lines starting with + or -) rather than a complete file.

RESPOND ONLY in this exact JSON format:
{ "is_safe": true/false, "reason": "One sentence explaining why." }
`;

function getAuditorConfig() {
  // TIER 1+ (2026-10-30): Support self-hosted LLM via Ollama
  // When AUDITOR_PROVIDER=ollama, use the local Ollama server (no API calls)
  if (process.env.AUDITOR_USE_ACTIVE === 'false' && process.env.AUDITOR_MODEL) {
    const provider = process.env.AUDITOR_PROVIDER || 'openrouter';
    // TIER 1+: Add Ollama to the endpoint map + support AUDITOR_ENDPOINT override
    const endpointMap: Record<string, string> = {
      openrouter: 'https://openrouter.ai/api/v1/chat/completions',
      mistral: 'https://api.mistral.ai/v1/chat/completions',
      ollama: process.env.AUDITOR_ENDPOINT || 'http://localhost:11434/v1/chat/completions',
    };
    const endpoint = endpointMap[provider] || endpointMap.openrouter;
    // Ollama doesn't need a real API key — any string works. Use "ollama" if not set.
    const apiKey = process.env.AUDITOR_API_KEY || (provider === 'ollama' ? 'ollama' : '');
    if (provider === 'ollama') {
      log(`[TIER1+] Auditor using LOCAL Ollama LLM: ${process.env.AUDITOR_MODEL} at ${endpoint}`, 'INFO', 'auditor');
    }
    return { provider, model: process.env.AUDITOR_MODEL, endpoint, apiKey };
  }
  const active = getGetActiveModel()?.get();
  if (active && active.model_id) {
    const provider = active.provider || 'openrouter';
    const endpointMap = { openrouter: 'https://openrouter.ai/api/v1/chat/completions', mistral: 'https://api.mistral.ai/v1/chat/completions' };
    let apiKey = null;
    if (provider === 'openrouter') apiKey = getCONFIG().OPENROUTER_API_KEY;
    else if (provider === 'mistral') apiKey = getCONFIG().MISTRAL_CODE_API_KEY;
    if (apiKey) {
      log(`Auditor using evolved model: ${active.model_id} (${provider})`, 'DEBUG', 'auditor');
      return { provider, model: active.model_id, endpoint: (endpointMap as any)[provider] || endpointMap.openrouter, apiKey };
    }
  }
  log('No evolved model found for auditor. Falling back to openrouter/free.', 'WARN', 'auditor');
  return { provider: 'openrouter', model: 'openrouter/free', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: getCONFIG().OPENROUTER_API_KEY };
}

/**
 * v2: Get auditor configs for non-codegen patches.
 * Returns MORE auditor configs for higher confidence.
 * Includes additional provider endpoints.
 */
function getNonCodegenAuditorConfigs(): Array<{ provider: string; model: string; endpoint: string; apiKey: string | null }> {
  const configs: Array<{ provider: string; model: string; endpoint: string; apiKey: string | null }> = [];

  // TIER 1+ (2026-10-30): Add local Ollama LLM as the FIRST auditor
  // (fastest, no rate limits, runs locally). If Ollama is configured, it
  // gets the first vote. Cloud auditors provide additional votes for
  // redundancy and cross-validation.
  if (process.env.AUDITOR_PROVIDER === 'ollama' && process.env.AUDITOR_MODEL) {
    configs.push({
      provider: 'ollama',
      model: process.env.AUDITOR_MODEL,
      endpoint: process.env.AUDITOR_ENDPOINT || 'http://localhost:11434/v1/chat/completions',
      apiKey: process.env.AUDITOR_API_KEY || 'ollama',
    });
    log('[TIER1+] Local Ollama LLM added as auditor voter', 'DEBUG', 'auditor');
  }

  // OpenRouter (free tier)
  if (getCONFIG().OPENROUTER_API_KEY) {
    configs.push({
      provider: 'openrouter', model: 'openrouter/free',
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      apiKey: getCONFIG().OPENROUTER_API_KEY,
    });
  }

  // Mistral Codestral (dedicated code model — best auditor)
  if (getCONFIG().MISTRAL_CODE_API_KEY) {
    configs.push({
      provider: 'mistral', model: 'codestral-latest',
      endpoint: 'https://api.mistral.ai/v1/chat/completions',
      apiKey: getCONFIG().MISTRAL_CODE_API_KEY,
    });
  }

  // Gemini (if available — excellent for security analysis)
  if (getCONFIG().GEMINI_API_KEY) {
    try {
      const gemini = require('./providers-gemini');
      if (gemini) {
        configs.push({
          provider: 'gemini', model: 'gemini-2.0-flash',
          endpoint: 'gemini-native',
          apiKey: getCONFIG().GEMINI_API_KEY,
        });
      }
    } catch {}
  }

  // Groq (fast, good for pattern matching)
  if (getCONFIG().GROQ_API_KEY) {
    configs.push({
      provider: 'groq', model: 'qwen/qwen3.6-27b',
      endpoint: 'https://api.groq.com/openai/v1/chat/completions',
      apiKey: getCONFIG().GROQ_API_KEY,
    });
  }

  return configs;
}

// ─── Single AI Auditor Call ───

async function auditPatchWithAI(patchText: any, signal: any, configOverride = null, isNonCodegen = false, originalContent?: string) {
  let config = configOverride || getAuditorConfig();
  if (!config.apiKey) {
    log('Auditor API key missing. Blocking patch by default.', 'WARN', 'auditor');
    return { is_safe: false, reason: 'Auditor API key not configured', provider: config.provider, model: config.model };
  }
  // Defensive: callers have historically passed the wrong thing as `signal`
  // (e.g. a description string from the dashboard). Coerce anything that
  // isn't a real AbortSignal to undefined so fetchWithTimeout doesn't crash
  // with "options.signal.addEventListener is not a function".
  const safeSignal = (signal && typeof signal.addEventListener === 'function' && typeof signal.aborted === 'boolean')
    ? signal
    : undefined;
  try {
    const prompt = isNonCodegen ? NON_CODEGEN_AUDITOR_PROMPT : AUDITOR_PROMPT;
    // Build the user message: include the currently-approved version (if
    // available) so the LLM can compare the patch against it. Without this
    // context, the LLM sees the patch in isolation and flags pre-existing
    // patterns (e.g. ProxyScrape fetch, process.env access) as violations,
    // even though those patterns were already approved in the original file.
    let userMessage = '';
    if (originalContent && typeof originalContent === 'string' && originalContent.trim().length > 0) {
      // Cap the original content at 16KB to avoid blowing past the model's
      // context window. If the original is larger, send the first 16KB which
      // is enough to see the imports, top-level constants, and main exports.
      const truncated = originalContent.length > 16384
        ? originalContent.slice(0, 16384) + '\n\n// ... [TRUNCATED for context length] ...\n'
        : originalContent;
      userMessage += 'CURRENTLY APPROVED VERSION (evaluate the patch AGAINST this — patterns already present here are pre-approved and MUST NOT be flagged):\n```\n' + truncated + '\n```\n\n';
    }
    userMessage += 'PATCH TO AUDIT:\n```\n' + patchText + '\n```';

    // Helper: try the auditor call once. If it returns a 429 rate-limit error,
    // parse the X-RateLimit-Reset header and wait until that time (with a
    // 60s cap) before retrying ONCE. This lets us ride through OpenRouter's
    // free-tier daily quota reset without immediately failing.
    async function _callWithRateLimitRetry(): Promise<string> {
      try {
        return await getCallChatCompletion()(
          config.endpoint, config.apiKey, config.model, null,
          prompt + '\n\n' + userMessage,
          config.provider || 'auditor',
          { responseFormat: { type: 'json_object' }, signal: safeSignal }
        );
      } catch (err: any) {
        const errMsg = String(err && err.message || err);
        // Detect 429 rate-limit errors specifically (not other infra failures)
        const isRateLimit =
          /HTTP_ERROR_429/.test(errMsg) ||
          /Rate limit exceeded/i.test(errMsg);
        if (!isRateLimit) throw err;

        // Try to parse the reset time from the error message.
        // OpenRouter embeds X-RateLimit-Reset in the error JSON body
        // (e.g. "X-RateLimit-Reset":"1792972800000").
        const resetMatch = errMsg.match(/X-RateLimit-Reset["']?\s*[:=]\s*["']?(\d{10,})/);
        let waitMs = 0;
        if (resetMatch) {
          const resetEpochMs = parseInt(resetMatch[1], 10);
          if (Number.isFinite(resetEpochMs)) {
            waitMs = Math.max(0, resetEpochMs - Date.now());
          }
        }
        // Cap the wait at 60 seconds — if the reset is more than 60s away,
        // the rate limit is probably a daily quota (not a short-term throttle),
        // and waiting would block the dashboard for too long. In that case,
        // skip the retry and let the fallback chain handle it.
        if (waitMs === 0 || waitMs > 60000) {
          log(`Auditor ${config.provider}/${config.model} rate-limited (reset in ${Math.round(waitMs / 1000)}s) — skipping retry, will fall back to next tier`, 'WARN', 'auditor');
          throw err;
        }
        log(`Auditor ${config.provider}/${config.model} rate-limited — waiting ${Math.round(waitMs / 1000)}s for reset, then retrying once`, 'WARN', 'auditor');
        await new Promise(resolve => setTimeout(resolve, waitMs));
        // Retry once
        return await getCallChatCompletion()(
          config.endpoint, config.apiKey, config.model, null,
          prompt + '\n\n' + userMessage,
          config.provider || 'auditor',
          { responseFormat: { type: 'json_object' }, signal: safeSignal }
        );
      }
    }

    const content = await _callWithRateLimitRetry();
    if (!content || typeof content !== 'string' || content.trim() === '') {
      throw new Error('Empty auditor response');
    }
    // Some models wrap JSON in ```json ... ``` fences despite response_format.
    // Strip those before parsing.
    const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
    const parsed = JSON.parse(trimmed);
    if (typeof parsed.is_safe !== 'boolean') throw new Error('Invalid auditor response format');
    return { ...parsed, provider: config.provider, model: config.model };
  } catch (err: any) {
    logError(`Auditor model (${config.model}) failed`, err);
    // BUGFIX: Distinguish infrastructure failures from real safety verdicts.
    // Previously, ANY error (HTTP 429 rate limit, HTTP 500 server error,
    // network timeout, JSON parse failure) was treated as is_safe: false —
    // which counted as a vote AGAINST the patch. This caused patches to be
    // rejected just because OpenRouter's free-tier daily quota was exhausted
    // (50 req/day limit), even when the other auditor (Mistral) said SAFE.
    //
    // Now: infrastructure failures return a special "skipped" verdict that
    // does NOT count as a vote — only real safety verdicts (auditor returned
    // valid JSON with is_safe: true/false) count.
    const errMsg = String(err && err.message || err);
    const isInfraFailure =
      /HTTP_ERROR_4\d\d/.test(errMsg) ||         // 4xx client errors (429 rate limit, 401 auth, 403 forbidden, etc.)
      /HTTP_ERROR_5\d\d/.test(errMsg) ||         // 5xx server errors (500, 502, 503, 504)
      /Rate limit exceeded/i.test(errMsg) ||    // explicit rate-limit message
      /ECONNRESET|ETIMEDOUT|ENOTFOUND|ECONNREFUSED/.test(errMsg) || // network errors
      /fetch failed/i.test(errMsg) ||            // generic fetch failure
      /Empty auditor response/i.test(errMsg) || // empty response (server returned nothing)
      /Invalid auditor response format/i.test(errMsg); // bad JSON (auditor returned non-JSON)
    if (isInfraFailure) {
      return {
        is_safe: null,                          // null = skipped (does NOT count as a vote)
        skipped: true,
        skip_reason: `Auditor infrastructure failure: ${errMsg.slice(0, 200)}`,
        provider: config.provider,
        model: config.model,
      };
    }
    // For non-infrastructure errors (unexpected exceptions in our own code),
    // fail safe — but log loudly so the dashboard surfaces the actual reason.
    return { is_safe: false, reason: `Auditor crashed: ${errMsg}`, provider: config.provider, model: config.model };
  }
}

// ─── Tribunal Audit (multiple independent models) ───

// ─── Fallback Chain for Auditor Configs ─────────────────────────────────────
//
// The user's request: if the primary advisory AIs (OpenRouter + Mistral) don't
// work (rate-limited, down, etc.), fall back through this chain:
//   1. Codegen models (these are designed for code, can do safety review too):
//      - Mistral (already primary, but kept in fallback list as codegen-capable)
//      - DeepSeek (if DEEPSEEK_CODE_API_KEY)
//      - Qwen (if QWEN_CODE_API_KEY)
//      - Bazaarlink (if BAZAARLINK_API_KEY)
//      - VoidAI (if VOIDAI_API_KEY)
//      - OpenRouter free (already primary)
//   2. Groq (fast inference, qwen & llama models)
//   3. Z.ai (z-ai-web-dev-sdk compatible)
//   4. Whatever's left (Gemini, NVIDIA, Cloudflare, Cerebras, Agnes, GitHub-GPT)
//
// Each tier is tried in order; if EVERY model in a tier is skipped
// (infrastructure failure), move to the next tier. We stop at the first tier
// that returns at least one real verdict (is_safe: true/false).

interface AuditorConfig {
  provider: string;
  model: string;
  endpoint: string;
  apiKey: string | null;
}

// Lookup a provider's auditor config by API key + endpoint.
function _resolveAuditorConfig(provider: string): AuditorConfig | null {
  const cfg = getCONFIG();
  switch (provider) {
    case 'openrouter':
      if (!cfg.OPENROUTER_API_KEY) return null;
      return { provider: 'openrouter', model: 'openrouter/free', endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: cfg.OPENROUTER_API_KEY };
    case 'mistral':
      if (!cfg.MISTRAL_CODE_API_KEY) return null;
      return { provider: 'mistral', model: 'codestral-latest', endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKey: cfg.MISTRAL_CODE_API_KEY };
    case 'deepseek':
      if (!cfg.DEEPSEEK_CODE_API_KEY) return null;
      return { provider: 'deepseek', model: 'deepseek-coder', endpoint: 'https://api.deepseek.com/v1/chat/completions', apiKey: cfg.DEEPSEEK_CODE_API_KEY };
    case 'qwen':
      if (!cfg.QWEN_CODE_API_KEY) return null;
      return { provider: 'qwen', model: 'qwen-coder-plus', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', apiKey: cfg.QWEN_CODE_API_KEY };
    case 'bazaarlink':
      if (!cfg.BAZAARLINK_API_KEY) return null;
      return { provider: 'bazaarlink', model: 'bazaarlink-coder', endpoint: 'https://api.bazaarlink.ai/v1/chat/completions', apiKey: cfg.BAZAARLINK_API_KEY };
    case 'voidai':
      if (!cfg.VOIDAI_API_KEY) return null;
      return { provider: 'voidai', model: 'voidai-coder', endpoint: 'https://api.voidai.app/v1/chat/completions', apiKey: cfg.VOIDAI_API_KEY };
    case 'groq':
      if (!cfg.GROQ_API_KEY) return null;
      return { provider: 'groq', model: 'llama-3.3-70b-versatile', endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: cfg.GROQ_API_KEY };
    case 'zai':
      if (!cfg.ZAI_API_KEY) return null;
      return { provider: 'zai', model: 'glm-4.6', endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', apiKey: cfg.ZAI_API_KEY };
    case 'gemini':
      if (!cfg.GEMINI_API_KEY) return null;
      return { provider: 'gemini', model: 'gemini-2.0-flash', endpoint: 'gemini-native', apiKey: cfg.GEMINI_API_KEY };
    case 'nvidia':
      if (!cfg.NVIDIA_API_KEY) return null;
      return { provider: 'nvidia', model: 'meta/llama-3.1-70b-instruct', endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', apiKey: cfg.NVIDIA_API_KEY };
    case 'cloudflare':
      if (!cfg.CF_API_KEY || !cfg.CF_ACCOUNT_ID) return null;
      return { provider: 'cloudflare', model: '@cf/meta/llama-3.1-8b-instruct', endpoint: 'https://api.cloudflare.com/client/v4/accounts/' + cfg.CF_ACCOUNT_ID + '/ai/v1/chat/completions', apiKey: cfg.CF_API_KEY };
    case 'cerebras':
      if (!cfg.CEREBRAS_API_KEY) return null;
      return { provider: 'cerebras', model: 'llama3.1-70b', endpoint: 'https://api.cerebras.ai/v1/chat/completions', apiKey: cfg.CEREBRAS_API_KEY };
    case 'agnes':
      if (!cfg.AGNES_API_KEY) return null;
      return { provider: 'agnes', model: 'agnes-coder', endpoint: 'https://api.agnes.ai/v1/chat/completions', apiKey: cfg.AGNES_API_KEY };
    case 'github':
      if (!cfg.GITHUB_API_KEY) return null;
      return { provider: 'github', model: 'gpt-4o-mini', endpoint: 'https://api.githubcopilot.com/chat/completions', apiKey: cfg.GITHUB_API_KEY };
    default:
      return null;
  }
}

// The fallback chain — list of tiers, each tier is a list of provider names.
// We try each tier in order; the first tier that yields at least one real
// safety verdict wins. Within a tier, we run all configs in parallel.
const AUDITOR_FALLBACK_TIERS: string[][] = [
  // Tier 1: primary advisory models (best for safety review)
  ['openrouter', 'mistral'],
  // Tier 2: codegen models (designed for code, can do safety review)
  ['deepseek', 'qwen', 'bazaarlink', 'voidai'],
  // Tier 3: Groq (fast inference)
  ['groq'],
  // Tier 4: Z.ai
  ['zai'],
  // Tier 5: whatever's left (Gemini, NVIDIA, Cloudflare, Cerebras, Agnes, GitHub)
  ['gemini', 'nvidia', 'cloudflare', 'cerebras', 'agnes', 'github'],
];

async function auditPatchWithTribunal(patchText: any, signal: any, options?: { isNonCodegen?: boolean; originalContent?: string }) {
  const isNonCodegen = options?.isNonCodegen || false;
  const originalContent = options?.originalContent;

  // Helper: run all configs in a single tier in parallel, return all results
  // (including skipped verdicts so we can surface them).
  async function runTier(providerNames: string[]): Promise<any[]> {
    const configs: AuditorConfig[] = [];
    for (const name of providerNames) {
      const c = _resolveAuditorConfig(name);
      if (c) configs.push(c);
    }
    if (configs.length === 0) return [];
    const results: PromiseSettledResult<any>[] = await Promise.allSettled(
      configs.map(c => auditPatchWithAI(patchText, signal, c, isNonCodegen, originalContent))
    );
    return results
      .filter(r => r.status === 'fulfilled' && r.value)
      // @ts-expect-error
      .map(r => r.value);
  }

  // Walk through the fallback tiers in order. Stop at the first tier that
  // yields at least one real safety verdict (not skipped).
  // For non-codegen patches, we keep the original strict-tier behavior:
  // run ALL tiers' configs together so we get a full supermajority vote.
  let allResults: any[] = [];
  let usedTier = -1;
  if (isNonCodegen) {
    // Non-codegen: run ALL configs across all tiers (stricter, more votes)
    const allProviderNames = AUDITOR_FALLBACK_TIERS.flat();
    allResults = await runTier(allProviderNames);
    usedTier = -2; // sentinel: "all tiers combined"
    log(`Non-codegen audit: ${allResults.length} auditors across all fallback tiers`, 'INFO', 'auditor');
  } else {
    // Normal: walk tiers in order, stop at first tier with real verdicts
    for (let t = 0; t < AUDITOR_FALLBACK_TIERS.length; t++) {
      const tier = AUDITOR_FALLBACK_TIERS[t];
      const tierResults = await runTier(tier);
      if (tierResults.length > 0) {
        const realVerdicts = tierResults.filter(v => v && !v.skipped && v.is_safe !== null && v.is_safe !== undefined);
        if (realVerdicts.length > 0) {
          // This tier yielded at least one real verdict — use it
          allResults = tierResults;
          usedTier = t;
          log(`Auditor tier ${t + 1} (${tier.join(', ')}) yielded ${realVerdicts.length}/${tierResults.length} real verdicts`, 'INFO', 'auditor');
          break;
        }
        // All verdicts in this tier were skipped — record them for surfacing
        // and continue to the next tier
        allResults.push(...tierResults);
        log(`Auditor tier ${t + 1} (${tier.join(', ')}) all skipped — trying next tier`, 'WARN', 'auditor');
      }
    }
  }

  if (allResults.length === 0) {
    // No auditor configs are available at all (no API keys configured)
    log('No auditor configs available — failing safe', 'ERROR', 'auditor');
    return {
      safe: false,
      is_safe: false,
      reason: 'No auditor APIs are configured. Set at least one of: OPENROUTER_API_KEY, MISTRAL_CODE_API_KEY, GROQ_API_KEY, ZAI_API_KEY, GEMINI_API_KEY, etc.',
      votes: [],
      skipped: [],
    };
  }

  // BUGFIX: Filter out "skipped" verdicts (infrastructure failures like
  // 429 rate limit, 500 server error, network timeout). These are NOT safety
  // verdicts — they're infrastructure failures. Only real safety verdicts
  // (auditor returned valid JSON with is_safe: true/false) count as votes.
  // Skipped verdicts are still included in the response so the dashboard can
  // surface WHY an auditor didn't vote (e.g. "OpenRouter: rate limit exceeded").
  const votes = allResults.filter(v => v && !v.skipped && v.is_safe !== null && v.is_safe !== undefined);
  const skipped = allResults.filter(v => v && (v.skipped || v.is_safe === null || v.is_safe === undefined));
  if (skipped.length > 0) {
    for (const s of skipped) {
      log(`Auditor skipped: ${s.provider}/${s.model} — ${s.skip_reason || s.reason || 'unknown reason'}`, 'WARN', 'auditor');
    }
  }

  const safeVotes = votes.filter(v => v.is_safe === true);
  const total = votes.length;

  if (total === 0) {
    // ALL auditors (across ALL fallback tiers) were skipped — every provider
    // is down or rate-limited. Surface the full skip list to the dashboard.
    const skipReasons = skipped.map(s => `${s.provider}/${s.model}: ${(s.skip_reason || s.reason || 'unknown').slice(0, 100)}`).join('; ');
    log(`All ${allResults.length} auditors across all fallback tiers were skipped — failing safe`, 'ERROR', 'auditor');
    return {
      safe: false,
      is_safe: false,
      reason: `All auditors failed (infrastructure). Skipped: ${skipReasons}`,
      votes: [],
      skipped,
    };
  }

  // v2: Stricter threshold for non-codegen patches
  // Normal: 2/3 supermajority
  // Non-codegen: 3/4 supermajority OR single-veto
  let threshold: number;
  let singleVeto = false;
  if (isNonCodegen) {
    threshold = Math.ceil(total * 3 / 4); // 75% supermajority
    singleVeto = true; // Any single auditor can block
  } else {
    threshold = Math.ceil(total * 2 / 3); // 67% supermajority
  }

  // v2: Single-veto check for non-codegen patches
  if (singleVeto) {
    const unsafeVotes = votes.filter(v => v.is_safe === false);
 for (const veto of unsafeVotes) {
      log(`NON-CODEGEN SINGLE VETO: ${veto.provider}/${veto.model} vetoed patch: ${veto.reason}`, 'WARN', 'auditor');
      return {
        safe: false,
        is_safe: false,
        reason: `Non-codegen single-veto by ${veto.provider}/${veto.model}: ${veto.reason}`,
        votes,
      };
    }
  }

  const approved = safeVotes.length >= threshold;

  // Compose a reason string that inlines each auditor's verdict (or skip reason)
  // so the dashboard UI can surface WHY a patch was rejected (or approved)
  // without needing to render the votes array separately.
  // Include skipped auditors too so the user knows which auditor didn't vote
  // and why (e.g. "OpenRouter: rate limit exceeded — daily quota exhausted").
  const voteSummary = votes.map(v => {
    const who = `${v.provider || 'unknown'}/${v.model || 'unknown'}`;
    const verdict = v.is_safe ? 'SAFE' : 'UNSAFE';
    const why = v.reason || '(no reason given)';
    return `[${who} → ${verdict}: ${why}]`;
  }).join(' | ');
  const skippedSummary = skipped.length > 0
    ? skipped.map(s => {
        const who = `${s.provider || 'unknown'}/${s.model || 'unknown'}`;
        return `[${who} → SKIPPED: ${s.skip_reason || s.reason || 'unknown'}]`;
      }).join(' | ')
    : '';
  const fullSummary = skippedSummary ? voteSummary + ' | ' + skippedSummary : voteSummary;

  return {
    safe: approved,
    is_safe: approved,
    reason: approved
      ? `Approved by ${safeVotes.length}/${total} auditors${isNonCodegen ? ' (non-codegen strict mode)' : ''}${skipped.length > 0 ? ` (${skipped.length} skipped)` : ''}. ${fullSummary}`
      : `Rejected by majority (${safeVotes.length}/${total})${skipped.length > 0 ? ` (${skipped.length} skipped)` : ''}. ${fullSummary}`,
    votes,
    // Include skipped verdicts separately so the dashboard can render them
    // distinctly from real safety verdicts (e.g. with a different color badge).
    skipped: skipped.length > 0 ? skipped : undefined,
  };
}

// ─── Public API ───

/**
 * Standard audit — keyword check + AI tribunal.
 * Used for ALLOWED files (non-restricted). Returns simple safe/unsafe.
 *
 * v2: Accepts options.isNonCodegen for stricter validation.
 */
async function auditPatch(patchText: any, signal: any, options?: { isNonCodegen?: boolean; filePath?: string; originalContent?: string }) {
  const isNonCodegen = options?.isNonCodegen || false;

  // Load original file content (if available) so the keyword scanner can
  // skip patterns that already exist in the file — prevents false positives
  // like rejecting a patch to a file that already uses process.env.
  let originalContent: string | undefined = options?.originalContent;
  if (!originalContent && options?.filePath) {
    try {
      const fs = require('fs');
      const path = require('path');
      const resolved = path.isAbsolute(options.filePath)
        ? path.normalize(options.filePath)
        : path.resolve(process.cwd(), options.filePath);
      if (fs.existsSync(resolved)) {
        originalContent = fs.readFileSync(resolved, 'utf8');
      }
    } catch { /* original not available — scan without context */ }
  }

  // Fast keyword pre-filter (context-aware)
  const scanResult = scanForKeywords(patchText, originalContent);
  if (scanResult.matched.length > 0) {
    const reason = `Blocked by keyword scanner: ${scanResult.matched.join(', ')}`;
    log('Patch blocked by keyword pre-filter: ' + scanResult.matched.join(', '), 'WARN', 'auditor');
    return { safe: false, reason };
  }

  // v2: Extended keyword check for non-codegen patches
  if (isNonCodegen) {
    const extendedResult = isObviouslyMaliciousExtended(patchText, originalContent);
    if (extendedResult.malicious) {
      log(`Patch blocked by EXTENDED keyword scanner (${extendedResult.reasons.length} issues): ${extendedResult.reasons.slice(0, 3).join('; ')}`, 'WARN', 'auditor');
      return { safe: false, reason: `Extended keyword scan: ${extendedResult.reasons.slice(0, 3).join('; ')}` };
    }
  }

  // Optional: use sandbox content audit as additional pre-filter
  // Pass originalContent so context-aware skip works (auditPatchContent
  // already supports skipping patterns that exist in the original file,
  // but only if the caller passes the original — previously we were
  // passing only patchText, so every blocked pattern in the patch was
  // flagged as a violation, even if the original file already used it.
  const sandboxAudit = getAuditPatchContent()(patchText, originalContent);
  if (!sandboxAudit.safe) {
    log(`Patch blocked by sandbox content audit: ${sandboxAudit.violations.length} violations`, 'WARN', 'auditor');
    return { safe: false, reason: `Sandbox content audit: ${sandboxAudit.violations.join('; ')}` };
  }

  // AI tribunal (pass originalContent so context-aware evaluation works —
  // LLM can compare patch against approved version and skip pre-existing patterns)
  const aiResult = await auditPatchWithTribunal(patchText, signal, { isNonCodegen, originalContent });
  if (!aiResult.safe && !aiResult.is_safe) {
    log(`Patch blocked by AI auditor: ${aiResult.reason}`, 'WARN', 'auditor');
    return { safe: false, reason: aiResult.reason, votes: aiResult.votes, skipped: aiResult.skipped };
  }
  log('Patch passed AI auditor.', 'INFO', 'auditor');
  return { safe: true, reason: aiResult.reason || 'Passed all audit layers', votes: aiResult.votes, skipped: aiResult.skipped };
}

/**
 * Vote-collecting audit — used for RESTRICTED files.
 * v2: Accepts options.isNonCodegen for stricter validation.
 */
async function auditPatchWithVotes(patchText: any, signal: any, options?: { isNonCodegen?: boolean; filePath?: string; originalContent?: string }) {
  const isNonCodegen = options?.isNonCodegen || false;

  // Load original file content for context-aware scanning
  let originalContent: string | undefined = options?.originalContent;
  if (!originalContent && options?.filePath) {
    try {
      const fs = require('fs');
      const path = require('path');
      const resolved = path.isAbsolute(options.filePath)
        ? path.normalize(options.filePath)
        : path.resolve(process.cwd(), options.filePath);
      if (fs.existsSync(resolved)) {
        originalContent = fs.readFileSync(resolved, 'utf8');
      }
    } catch { /* original not available */ }
  }

  // Keyword pre-filter (context-aware)
  const scanResult = scanForKeywords(patchText, originalContent);
  if (scanResult.matched.length > 0) {
    return {
      safe: false, is_safe: false,
      reason: `Blocked by keyword scanner: ${scanResult.matched.join(', ')}`,
      votes: scanResult.matched.map(k => ({
        auditor: 'keyword-filter', safe: false, reason: `Forbidden keyword: ${k}`,
      })),
    };
  }

  // v2: Extended keyword check for non-codegen patches
  if (isNonCodegen) {
    const extendedResult = isObviouslyMaliciousExtended(patchText, originalContent);
    if (extendedResult.malicious) {
      return {
        safe: false, is_safe: false,
        reason: `Extended keyword scan: ${extendedResult.reasons.slice(0, 3).join('; ')}`,
        votes: extendedResult.reasons.map(r => ({
          auditor: 'extended-keyword-filter', safe: false, reason: r,
        })),
      };
    }
  }

  // Sandbox content audit (context-aware: pass originalContent so patterns
  // already present in the original file are skipped)
  const sandboxAudit = getAuditPatchContent()(patchText, originalContent);
  if (!sandboxAudit.safe) {
    return {
      safe: false, is_safe: false,
      reason: `Sandbox content: ${sandboxAudit.violations.join('; ')}`,
      votes: sandboxAudit.violations.map((v: any) => ({
        auditor: 'sandbox-content-audit', safe: false, reason: v,
      })),
    };
  }

  // AI tribunal with vote collection (context-aware: passes originalContent)
  const result = await auditPatchWithTribunal(patchText, signal, { isNonCodegen, originalContent });
  return {
    safe: result.safe,
    is_safe: result.is_safe,
    reason: result.reason,
    votes: result.votes || [],
  };
}

module.exports = { auditPatch, auditPatchWithVotes, isObviouslyMalicious, isObviouslyMaliciousExtended, scanForKeywords, _injectDependencies };
