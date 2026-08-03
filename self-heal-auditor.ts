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
 * Layer 1 (sandbox-executor.js) handles deterministic checks:
 *   - File-level policy (immutable/restricted/allowed)
 *   - Content pattern blocking (30+ dangerous patterns)
 *   - Path traversal, syntax validation, size limits
 *
 * This module handles probabilistic checks:
 *   - Fast keyword pre-filter (isObviouslyMalicious)
 *   - AI tribunal vote (multiple independent models)
 *
 * The two layers are coordinated by self-heal.js:
 *   1. Sandbox runs first — if it blocks, AI auditor is never called
 *   2. AI auditor runs second — catches semantic maliciousness
 *      that pattern matching can't detect (e.g. data exfiltration
 *      via allowed API calls, logic bombs, etc.)
 */

// ─── Keyword Pre-Filter ───
// These are patterns that are obviously malicious regardless of context.
// NOTE: The sandbox already blocks most of these at the content level.
// This pre-filter exists as a FAST first pass before spending API calls.
const FORBIDDEN_KEYWORDS = [
  'child_process', 'exec(', 'spawn(', 'eval(', 'Function(',
  'require("fs")', "require('fs')", 'fs.readFile', 'fs.writeFile', 'fs.unlink',
  'process.env',
  'atob(', 'btoa(',
];

function isObviouslyMalicious(patchText: any) { 
  const lower = patchText.toLowerCase();
  return FORBIDDEN_KEYWORDS.some(keyword => lower.includes(keyword.toLowerCase()));
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

// ─── Single AI Auditor Call ───

async function auditPatchWithAI(patchText: any, signal: any, configOverride = null) { 
  let config = configOverride || getAuditorConfig();
  if (!config.apiKey) {
    log('Auditor API key missing. Blocking patch by default.', 'WARN', 'auditor');
    return { is_safe: false, reason: 'Auditor API key not configured', provider: config.provider, model: config.model };
  }
  try {
    const response = await getCallChatCompletion()(
      config.endpoint, config.apiKey, config.model, null,
      AUDITOR_PROMPT + '\n\nPATCH TO AUDIT:\n' + patchText,
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

async function auditPatchWithTribunal(patchText: any, signal: any) { 
  const auditorConfigs = [
    { provider: 'openrouter', model: 'openrouter/free' },
    { provider: 'mistral', model: 'codestral-latest' },
  ];

  const results: PromiseSettledResult<any>[] = await Promise.allSettled(auditorConfigs.map(async ({ provider, model }) => {
    let config = null;
    if (provider === 'openrouter' && getCONFIG().OPENROUTER_API_KEY) {
      config = { provider, model, endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKey: getCONFIG().OPENROUTER_API_KEY };
    } else if (provider === 'mistral' && getCONFIG().MISTRAL_CODE_API_KEY) {
      config = { provider, model, endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKey: getCONFIG().MISTRAL_CODE_API_KEY };
    }
    if (!config) return null;
    return auditPatchWithAI(patchText as any, signal as any, config as any);
  }));

  const votes = results
    .filter(r => r.status === 'fulfilled' && r.value)
// @ts-expect-error
    .map(r => r.value);

  const safeVotes = votes.filter(v => v.is_safe === true);
  const total = votes.length;

  if (total === 0) {
    // No auditors available — fall back to single call
    return auditPatchWithAI(patchText, signal);
  }

  const threshold = Math.ceil(total * 2 / 3);
  const approved = safeVotes.length >= threshold;

  return {
    safe: approved,
    is_safe: approved,
    reason: approved
      ? `Approved by ${safeVotes.length}/${total} auditors`
      : `Rejected by majority (${safeVotes.length}/${total})`,
    votes,
  };
}

// ─── Public API ───

/**
 * Standard audit — keyword check + AI tribunal.
 * Used for ALLOWED files (non-restricted). Returns simple safe/unsafe.
 *
 * @param {string} patchText
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ safe: boolean, reason?: string }>}
 */
async function auditPatch(patchText: any, signal: any) { 
  // Fast keyword pre-filter
  if (isObviouslyMalicious(patchText)) {
    log('Patch blocked by keyword pre-filter.', 'WARN', 'auditor');
    return { safe: false, reason: 'Blocked by keyword scanner' };
  }

  // Optional: use sandbox content audit as additional pre-filter
  // This catches patterns that the keyword scanner might miss
  const sandboxAudit = getAuditPatchContent()(patchText);
  if (!sandboxAudit.safe) {
    log(`Patch blocked by sandbox content audit: ${sandboxAudit.violations.length} violations`, 'WARN', 'auditor');
    return { safe: false, reason: `Sandbox content audit: ${sandboxAudit.violations.join('; ')}` };
  }

  // AI tribunal (ALWAYS runs for security — cannot be disabled for restricted-file audits)
  const aiResult = await auditPatchWithTribunal(patchText, signal);
  if (!aiResult.safe && !aiResult.is_safe) {
    log(`Patch blocked by AI auditor: ${aiResult.reason}`, 'WARN', 'auditor');
    return { safe: false, reason: aiResult.reason };
  }
  log('Patch passed AI auditor.', 'INFO', 'auditor');
  return { safe: true, reason: aiResult.reason || 'Passed all audit layers' };
}

/**
 * Vote-collecting audit — used for RESTRICTED files.
 * Returns individual auditor votes so the approval workflow can
 * make its own supermajority decision.
 *
 * @param {string} patchText
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ safe: boolean, is_safe: boolean, reason: string, votes: Array }>}
 */
async function auditPatchWithVotes(patchText: any, signal: any) { 
  // Keyword pre-filter
  if (isObviouslyMalicious(patchText)) {
    return {
      safe: false, is_safe: false,
      reason: 'Blocked by keyword scanner',
      votes: [{ auditor: 'keyword-filter', safe: false, reason: 'Forbidden keyword detected' }],
    };
  }

  // Sandbox content audit (via DI accessor for consistency)
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
  const result = await auditPatchWithTribunal(patchText, signal);
  return {
    safe: result.safe,
    is_safe: result.is_safe,
    reason: result.reason,
    votes: result.votes || [],
  };
}

module.exports = { auditPatch, auditPatchWithVotes, isObviouslyMalicious, _injectDependencies };