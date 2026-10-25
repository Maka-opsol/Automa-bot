'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function getCallChatCompletion() { return _deps.providersBase?.callChatCompletion || require('./providers-base').callChatCompletion; }
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

function isObviouslyMalicious(patchText: any): boolean {
  const lower = patchText.toLowerCase();
  return FORBIDDEN_KEYWORDS.some(keyword => lower.includes(keyword.toLowerCase()));
}

/**
 * v2: Extended keyword check for non-codegen patches.
 * Checks a broader set of dangerous patterns AND also validates
 * the structural integrity of the patch.
 */
function isObviouslyMaliciousExtended(patchText: any): { malicious: boolean; reasons: string[] } {
  const lower = patchText.toLowerCase();
  const reasons: string[] = [];

  for (const keyword of EXTENDED_FORBIDDEN_KEYWORDS) {
    if (lower.includes(keyword.toLowerCase())) {
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
Another AI has generated a JavaScript code patch to fix a broken web scraper.
YOUR ONLY JOB is to determine if this code is MALICIOUS or DANGEROUS.
You must REJECT the patch if it contains ANY of the following:
1. Network requests to domains OTHER THAN the target website (mathu.co.za, microsoftonline.com) or known API providers.
2. Attempts to read, write, or delete files outside of the bot's own directory.
3. Usage of 'child_process', 'exec', 'spawn', or 'eval()'.
4. Attempts to steal environment variables and send them externally.
5. Infinite loops or intentional memory bombs.
6. Obfuscated code (base64 decoding, weird hex sequences).
Respond ONLY in this exact JSON format:
{ "is_safe": true/false, "reason": "One sentence explaining why." }
`;

/**
 * v2: Stricter auditor prompt for non-codegen patches.
 * Adds more specific checks for common non-codegen failure modes.
 */
const NON_CODEGEN_AUDITOR_PROMPT = `
You are an EXTREMELY strict cybersecurity auditor for an autonomous bot.
A NON-CODE-GENERATION AI model (like Gemini, Groq, or Cloudflare) has generated
a JavaScript code patch. These models are NOT designed for code generation and
frequently produce dangerous, malformed, or subtly broken code.

You must REJECT the patch if it contains ANY of the following:
1. Network requests to ANY domain (the bot should never make outbound HTTP requests from patched code).
2. ANY file system operations (fs.read, fs.write, etc.).
3. ANY usage of 'child_process', 'exec', 'spawn', 'eval()', 'Function('.
4. ANY access to environment variables.
5. Infinite loops, unbounded recursion, or memory bombs.
6. Obfuscated code (base64, hex sequences, encoded strings).
7. Code that modifies process-level state (process.env, process.exit, etc.).
8. Code that seems like placeholder/dummy content (e.g., just 'use strict' with nothing else, or a file that just exports an empty object).
9. Code that imports or requires modules not related to the fix.
10. The patch looks like a DESCRIPTION of a fix rather than actual code.
11. The patch contains markdown, HTML, or non-JavaScript content.
12. The patch is a unified diff (lines starting with + or -) rather than a complete file.

RESPOND ONLY in this exact JSON format:
{ "is_safe": true/false, "reason": "One sentence explaining why." }
`;

function getAuditorConfig() {
  if (process.env.AUDITOR_USE_ACTIVE === 'false' && process.env.AUDITOR_MODEL) {
    const provider = process.env.AUDITOR_PROVIDER || 'openrouter';
    const endpointMap = { openrouter: 'https://openrouter.ai/api/v1/chat/completions', mistral: 'https://api.mistral.ai/v1/chat/completions' };
    return { provider, model: process.env.AUDITOR_MODEL, endpoint: (endpointMap as any)[provider] || endpointMap.openrouter, apiKey: process.env.AUDITOR_API_KEY };
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

async function auditPatchWithAI(patchText: any, signal: any, configOverride = null, isNonCodegen = false) {
  let config = configOverride || getAuditorConfig();
  if (!config.apiKey) {
    log('Auditor API key missing. Blocking patch by default.', 'WARN', 'auditor');
    return { is_safe: false, reason: 'Auditor API key not configured', provider: config.provider, model: config.model };
  }
  try {
    const prompt = isNonCodegen ? NON_CODEGEN_AUDITOR_PROMPT : AUDITOR_PROMPT;
    const response = await getCallChatCompletion()(
      config.endpoint, config.apiKey, config.model, null,
      prompt + '\n\nPATCH TO AUDIT:\n' + patchText,
      { responseFormat: { type: 'json_object' }, signal }
    );
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty auditor response');
    const parsed = JSON.parse(content);
    if (typeof parsed.is_safe !== 'boolean') throw new Error('Invalid auditor response format');
    return { ...parsed, provider: config.provider, model: config.model };
  } catch (err: any) {
    logError(`Auditor model (${config.model}) failed`, err);
    return { is_safe: false, reason: `Auditor crashed: ${err.message}`, provider: config.provider, model: config.model };
  }
}

// ─── Tribunal Audit (multiple independent models) ───

async function auditPatchWithTribunal(patchText: any, signal: any, options?: { isNonCodegen?: boolean }) {
  const isNonCodegen = options?.isNonCodegen || false;

  // v2: Use more auditors and stricter thresholds for non-codegen patches
  let auditorConfigs: Array<{ provider: string; model: string }>;
  if (isNonCodegen) {
    // Get all available auditors for non-codegen patches
    const fullConfigs = getNonCodegenAuditorConfigs();
    auditorConfigs = fullConfigs.map(c => ({ provider: c.provider, model: c.model }));
    log(`Non-codegen audit: using ${auditorConfigs.length} auditors with strict mode`, 'INFO', 'auditor');
  } else {
    auditorConfigs = [
      { provider: 'openrouter', model: 'openrouter/free' },
      { provider: 'mistral', model: 'codestral-latest' },
    ];
  }

  const results: PromiseSettledResult<any>[] = await Promise.allSettled(auditorConfigs.map(async ({ provider, model }) => {
    let config = null;
    if (provider === 'openrouter' && getCONFIG().OPENROUTER_API_KEY) {
      config = { provider, model, endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: getCONFIG().OPENROUTER_API_KEY };
    } else if (provider === 'mistral' && getCONFIG().MISTRAL_CODE_API_KEY) {
      config = { provider, model, endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKey: getCONFIG().MISTRAL_CODE_API_KEY };
    } else if (provider === 'gemini' && getCONFIG().GEMINI_API_KEY) {
      config = { provider, model, endpoint: 'gemini-native', apiKey: getCONFIG().GEMINI_API_KEY };
    } else if (provider === 'groq' && getCONFIG().GROQ_API_KEY) {
      config = { provider, model, endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKey: getCONFIG().GROQ_API_KEY };
    }
    if (!config) return null;
    return auditPatchWithAI(patchText as any, signal as any, config as any, isNonCodegen);
  }));

  const votes = results
    .filter(r => r.status === 'fulfilled' && r.value)
// @ts-expect-error
    .map(r => r.value);

  const safeVotes = votes.filter(v => v.is_safe === true);
  const total = votes.length;

  if (total === 0) {
    return auditPatchWithAI(patchText, signal, null, isNonCodegen);
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

  // Compose a reason string that inlines each auditor's verdict so the
  // dashboard UI can surface WHY a patch was rejected (or approved)
  // without needing to render the votes array separately.
  const voteSummary = votes.map(v => {
    const who = `${v.provider || 'unknown'}/${v.model || 'unknown'}`;
    const verdict = v.is_safe ? 'SAFE' : 'UNSAFE';
    const why = v.reason || '(no reason given)';
    return `[${who} → ${verdict}: ${why}]`;
  }).join(' | ');

  return {
    safe: approved,
    is_safe: approved,
    reason: approved
      ? `Approved by ${safeVotes.length}/${total} auditors${isNonCodegen ? ' (non-codegen strict mode)' : ''}. ${voteSummary}`
      : `Rejected by majority (${safeVotes.length}/${total}). ${voteSummary}`,
    votes,
  };
}

// ─── Public API ───

/**
 * Standard audit — keyword check + AI tribunal.
 * Used for ALLOWED files (non-restricted). Returns simple safe/unsafe.
 *
 * v2: Accepts options.isNonCodegen for stricter validation.
 */
async function auditPatch(patchText: any, signal: any, options?: { isNonCodegen?: boolean }) {
  const isNonCodegen = options?.isNonCodegen || false;

  // Fast keyword pre-filter
  if (isObviouslyMalicious(patchText)) {
    log('Patch blocked by keyword pre-filter.', 'WARN', 'auditor');
    return { safe: false, reason: 'Blocked by keyword scanner' };
  }

  // v2: Extended keyword check for non-codegen patches
  if (isNonCodegen) {
    const extendedResult = isObviouslyMaliciousExtended(patchText);
    if (extendedResult.malicious) {
      log(`Patch blocked by EXTENDED keyword scanner (${extendedResult.reasons.length} issues): ${extendedResult.reasons.slice(0, 3).join('; ')}`, 'WARN', 'auditor');
      return { safe: false, reason: `Extended keyword scan: ${extendedResult.reasons.slice(0, 3).join('; ')}` };
    }
  }

  // Optional: use sandbox content audit as additional pre-filter
  const sandboxAudit = getAuditPatchContent()(patchText);
  if (!sandboxAudit.safe) {
    log(`Patch blocked by sandbox content audit: ${sandboxAudit.violations.length} violations`, 'WARN', 'auditor');
    return { safe: false, reason: `Sandbox content audit: ${sandboxAudit.violations.join('; ')}` };
  }

  // AI tribunal
  const aiResult = await auditPatchWithTribunal(patchText, signal, { isNonCodegen });
  if (!aiResult.safe && !aiResult.is_safe) {
    log(`Patch blocked by AI auditor: ${aiResult.reason}`, 'WARN', 'auditor');
    return { safe: false, reason: aiResult.reason };
  }
  log('Patch passed AI auditor.', 'INFO', 'auditor');
  return { safe: true, reason: aiResult.reason || 'Passed all audit layers' };
}

/**
 * Vote-collecting audit — used for RESTRICTED files.
 * v2: Accepts options.isNonCodegen for stricter validation.
 */
async function auditPatchWithVotes(patchText: any, signal: any, options?: { isNonCodegen?: boolean }) {
  const isNonCodegen = options?.isNonCodegen || false;

  // Keyword pre-filter
  if (isObviouslyMalicious(patchText)) {
    return {
      safe: false, is_safe: false,
      reason: 'Blocked by keyword scanner',
      votes: [{ auditor: 'keyword-filter', safe: false, reason: 'Forbidden keyword detected' }],
    };
  }

  // v2: Extended keyword check for non-codegen patches
  if (isNonCodegen) {
    const extendedResult = isObviouslyMaliciousExtended(patchText);
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

  // Sandbox content audit
  const sandboxAudit = getAuditPatchContent()(patchText);
  if (!sandboxAudit.safe) {
    return {
      safe: false, is_safe: false,
      reason: `Sandbox content: ${sandboxAudit.violations.join('; ')}`,
      votes: sandboxAudit.violations.map((v: any) => ({
        auditor: 'sandbox-content-audit', safe: false, reason: v,
      })),
    };
  }

  // AI tribunal with vote collection
  const result = await auditPatchWithTribunal(patchText, signal, { isNonCodegen });
  return {
    safe: result.safe,
    is_safe: result.is_safe,
    reason: result.reason,
    votes: result.votes || [],
  };
}

module.exports = { auditPatch, auditPatchWithVotes, isObviouslyMalicious, isObviouslyMaliciousExtended, _injectDependencies };
