'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { callMistralCodeGen, parseCodegenResponse } = require('./providers-codegen-mistral');
const blLimiter = require('./bazaarlink-rate-limiter');
const { log, logError } = require('./logger');
const { fetchWithTimeout, extractJSON, sanitizeErrorText } = require('./providers-base');

// ─── Lazy BazaarLink require (resilient to transform failures) ───
let _blModule: any = null;
let _blLoadError: string | null = null;

function _getBL(): any {
  if (_blLoadError) return null;
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

// ─── Lazy non-codegen provider requires (loaded only on 3-strike escalation) ───
let _orCodeGenModule: any = null;
let _orCodeGenLoadError: string | null = null;
function _getORCodeGen(): any {
  if (_orCodeGenLoadError) return null;
  if (_orCodeGenModule) return _orCodeGenModule;
  try {
    _orCodeGenModule = require('./providers-codegen-openrouter');
    return _orCodeGenModule;
  } catch (err: any) {
    _orCodeGenLoadError = String(err.message || err).substring(0, 300);
    log(`OpenRouter codegen module failed to load: ${_orCodeGenLoadError}`, 'ERROR', 'codegen');
    return null;
  }
}

let _deepSeekModule: any = null;
let _deepSeekLoadError: string | null = null;
function _getDeepSeek(): any {
  if (_deepSeekLoadError) return null;
  if (_deepSeekModule) return _deepSeekModule;
  try {
    _deepSeekModule = require('./providers-codegen-deepseek');
    return _deepSeekModule;
  } catch (err: any) {
    _deepSeekLoadError = String(err.message || err).substring(0, 300);
    log(`DeepSeek codegen module failed to load: ${_deepSeekLoadError}`, 'ERROR', 'codegen');
    return null;
  }
}

let _qwenModule: any = null;
let _qwenLoadError: string | null = null;
function _getQwen(): any {
  if (_qwenLoadError) return null;
  if (_qwenModule) return _qwenModule;
  try {
    _qwenModule = require('./providers-codegen-qwen');
    return _qwenModule;
  } catch (err: any) {
    _qwenLoadError = String(err.message || err).substring(0, 300);
    log(`Qwen codegen module failed to load: ${_qwenLoadError}`, 'ERROR', 'codegen');
    return null;
  }
}

// ─── DEFAULT TRIBUNAL TIMEOUTS ───
const DEFAULT_TRIBUNAL_TIMEOUT_MS = 120_000; // 2 minutes for codegen
const NON_CODEGEN_EXTENDED_TIMEOUT_MS = 180_000; // 3 minutes for non-codegen (slower models)

// ─── Fix Validation ───

function validateFix(fix: any): boolean {
  if (!fix || typeof fix !== 'object') return false;
  if (!fix.file || typeof fix.file !== 'string') return false;
  if (!fix.change || typeof fix.change !== 'string') return false;
  if (!fix.patch || typeof fix.patch !== 'string') return false;
  if (fix.patch.trim().length < 5) return false;
  return true;
}

function validateFixArray(parsed: any): any[] {
  if (!parsed) return [];
  if (Array.isArray(parsed)) return parsed.filter(validateFix);
  if (typeof parsed === 'object') {
    for (const key of ['fixes', 'patches', 'results', 'data', 'response']) {
      if (Array.isArray(parsed[key])) {
        const extracted = parsed[key].filter(validateFix);
        if (extracted.length > 0) return extracted;
      }
    }
    if (validateFix(parsed)) return [parsed];
  }
  return [];
}

/**
 * Stricter validation for non-codegen provider patches.
 * Non-codegen models often produce malformed output, so we apply extra checks:
 *   - Patch must NOT start with '---' (unified diff) — self-heal only supports full file replacement
 *   - Patch must start with a valid module pattern
 *   - Patch must have a reasonable length (not a one-liner, not 1MB)
 *   - File path must look like a real project file (.ts/.js extension)
 *   - Change description must be > 10 chars (catches lazy "fix bug" descriptions)
 */
function validateFixStrict(fix: any): boolean {
  if (!validateFix(fix)) return false;

  // File path must look real
  if (!/\.(ts|js)$/.test(fix.file)) return false;
  // Reject paths with .. or absolute paths
  if (fix.file.includes('..') || path_is_absolute(fix.file)) return false;
  // Reject unified diffs
  if (fix.patch.trimStart().startsWith('---')) return false;
  // Patch must have a reasonable minimum length for a full file
  if (fix.patch.trim().length < 50) return false;
  // Reject if patch is suspiciously large (> 200KB for a single file)
  if (fix.patch.length > 200 * 1024) return false;
  // Change description must be meaningful
  if (fix.change.trim().length < 10) return false;
  // Patch must start with a valid module pattern
  const trimmedStart = fix.patch.trimStart().substring(0, 30);
  const validStarts = ["'use strict'", '"use strict"', 'import ', 'export ', '//', '/*', '/**'];
  if (!validStarts.some(s => trimmedStart.startsWith(s))) return false;

  return true;
}

/** Simple check if a path looks absolute (no need for path module) */
function path_is_absolute(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:/.test(p);
}

/**
 * Parse a raw string response from a non-codegen model into fix objects.
 * Non-codegen models often return:
 *   - Markdown fences (```json ... ``` or ``` ... ```)
 *   - Plain text with the JSON embedded somewhere
 *   - JSON wrapped in explanatory text
 *   - Double-escaped JSON
 * This function tries multiple extraction strategies.
 */
function parseNonCodegenResponse(raw: string, providerName: string): any[] {
  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) return [];

  // Strategy 1: Direct JSON parse
  try {
    const parsed = JSON.parse(raw);
    const fixes = validateFixArray(parsed);
    if (fixes.length > 0) {
      log(`Non-codegen ${providerName}: direct JSON parse yielded ${fixes.length} fix(es)`, 'DEBUG', 'codegen');
      return fixes;
    }
  } catch {}

  // Strategy 2: Extract from markdown code fences
  const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/g;
  let match;
  while ((match = fenceRegex.exec(raw)) !== null) {
    const inner = match[1].trim();
    if (inner.length < 10) continue;
    try {
      const parsed = JSON.parse(inner);
      const fixes = validateFixArray(parsed);
      if (fixes.length > 0) {
        log(`Non-codegen ${providerName}: markdown fence parse yielded ${fixes.length} fix(es)`, 'DEBUG', 'codegen');
        return fixes;
      }
    } catch {}
  }

  // Strategy 3: Find JSON array in text using bracket matching
  const bracketStart = raw.indexOf('[');
  if (bracketStart !== -1) {
    // Find the matching closing bracket
    let depth = 0;
    let bracketEnd = -1;
    for (let i = bracketStart; i < raw.length; i++) {
      if (raw[i] === '[') depth++;
      else if (raw[i] === ']') {
        depth--;
        if (depth === 0) { bracketEnd = i + 1; break; }
      }
    }
    if (bracketEnd > bracketStart) {
      try {
        const parsed = JSON.parse(raw.substring(bracketStart, bracketEnd));
        const fixes = validateFixArray(parsed);
        if (fixes.length > 0) {
          log(`Non-codegen ${providerName}: bracket extraction yielded ${fixes.length} fix(es)`, 'DEBUG', 'codegen');
          return fixes;
        }
      } catch {}
    }
  }

  // Strategy 4: Find JSON object that might contain a fixes array
  const objStart = raw.indexOf('{');
  if (objStart !== -1) {
    let depth = 0;
    let objEnd = -1;
    for (let i = objStart; i < raw.length; i++) {
      if (raw[i] === '{') depth++;
      else if (raw[i] === '}') {
        depth--;
        if (depth === 0) { objEnd = i + 1; break; }
      }
    }
    if (objEnd > objStart) {
      try {
        const parsed = JSON.parse(raw.substring(objStart, objEnd));
        const fixes = validateFixArray(parsed);
        if (fixes.length > 0) {
          log(`Non-codegen ${providerName}: object extraction yielded ${fixes.length} fix(es)`, 'DEBUG', 'codegen');
          return fixes;
        }
      } catch {}
    }
  }

  // Strategy 5: Try extractJSON from providers-base (handles double-escapes, etc.)
  try {
    const extracted = extractJSON(raw, `NonCodegen-${providerName}`);
    if (extracted) {
      const fixes = validateFixArray(extracted);
      if (fixes.length > 0) {
        log(`Non-codegen ${providerName}: extractJSON yielded ${fixes.length} fix(es)`, 'DEBUG', 'codegen');
        return fixes;
      }
    }
  } catch {}

  log(`Non-codegen ${providerName}: all parse strategies failed (raw length: ${raw.length})`, 'WARN', 'codegen');
  return [];
}

// ─── Timeout / Signal Utilities ───

function withTimeout(signal: any, timeoutMs: number): AbortController {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('Tribunal timeout')), timeoutMs);
  if (signal) {
    if (signal.aborted) { clearTimeout(timer); controller.abort(signal.reason); return controller; }
    signal.addEventListener('abort', () => { clearTimeout(timer); controller.abort(signal.reason); }, { once: true });
  }
  (controller as any)._cleanup = () => clearTimeout(timer);
  return controller;
}

// ─── Codegen Provider Discovery ───

function discoverModels() {
  const bl = _getBL();
  const blModels = bl?.getBazaarLinkModels?.() || [];
  const hasBazaarLink = !!getCONFIG().BAZAARLINK_API_KEY && !!bl;

  return {
    blModels,
    hasMistral: !!getCONFIG().MISTRAL_CODE_API_KEY,
    hasBazaarLink,
  };
}

/**
 * Discover ALL available providers including non-codegen ones.
 * Used only after 3 consecutive codegen failures (the "last resort" cascade).
 *
 * Returns a list of provider descriptors, each with:
 *   - name: human-readable name
 *   - type: 'codegen' | 'non-codegen'
 *   - callFn: async (prompt, signal) => raw result
 *   - parseFn: (raw) => fix[]
 */
function discoverAllProviders(): Array<{
  name: string;
  type: 'codegen' | 'non-codegen';
  callFn: (prompt: string, signal: any) => Promise<any>;
  parseFn: (raw: any) => any[];
}> {
  const providers: Array<{ name: string; type: 'codegen' | 'non-codegen'; callFn: (prompt: string, signal: any) => Promise<any>; parseFn: (raw: any) => any[]; }> = [];

  // ── Tier 1: Dedicated codegen providers ──
  const bl = _getBL();
  if (getCONFIG().BAZAARLINK_API_KEY && bl) {
    const models = bl.getBazaarLinkModels?.() || [];
    for (const slug of models) {
      providers.push({
        name: `BL/${slug}`,
        type: 'codegen',
        callFn: (prompt: string, signal: any) => bl.callBazaarLinkCodeGenWithModel(prompt, signal, slug),
        parseFn: (raw: any) => validateFixArray(typeof raw === 'string' ? JSON.parse(raw) : raw),
      });
    }
  }
  if (getCONFIG().MISTRAL_CODE_API_KEY) {
    providers.push({
      name: 'Mistral',
      type: 'codegen',
      callFn: (prompt: string, signal: any) => callMistralCodeGen(prompt, signal),
      parseFn: (raw: any) => validateFixArray(raw),
    });
  }
  if (getCONFIG().DEEPSEEK_CODE_API_KEY) {
    const ds = _getDeepSeek();
    if (ds?.callDeepSeekCodeGen) {
      providers.push({
        name: 'DeepSeek',
        type: 'codegen',
        callFn: (prompt: string, signal: any) => ds.callDeepSeekCodeGen(prompt, signal),
        parseFn: (raw: any) => validateFixArray(raw),
      });
    }
  }
  if (getCONFIG().QWEN_CODE_API_KEY) {
    const qw = _getQwen();
    if (qw?.callQwenCodeGen) {
      providers.push({
        name: 'Qwen',
        type: 'codegen',
        callFn: (prompt: string, signal: any) => qw.callQwenCodeGen(prompt, signal),
        parseFn: (raw: any) => validateFixArray(raw),
      });
    }
  }

  // ── Tier 2: OpenRouter codegen (uses budget) ──
  if (getCONFIG().OPENROUTER_API_KEY) {
    const or = _getORCodeGen();
    if (or?.callOpenRouterCodeGenWithModel) {
      providers.push({
        name: 'OpenRouter/codegen',
        type: 'codegen',
        callFn: (prompt: string, signal: any) => or.callOpenRouterCodeGenWithModel(prompt, signal, getCONFIG().CODE_GEN_MODEL_OPENROUTER || 'openrouter/free'),
        parseFn: (raw: any) => validateFixArray(raw),
      });
    }
  }

  // ── Tier 3: Non-codegen providers (GENERAL/VISION models) ──
  // These are NOT designed for code generation, so their output is parsed
  // more stringently and validated more strictly downstream.
  //
  // Gemini
  try {
    const gemini = require('./providers-gemini');
    if (gemini && getCONFIG().GEMINI_API_KEY) {
      providers.push({
        name: 'Gemini',
        type: 'non-codegen',
        callFn: async (prompt: string, signal: any) => {
          const result = await gemini.callGemini(prompt, null, signal);
          return result?.choices?.[0]?.message?.content || result?.content || null;
        },
        parseFn: (raw: any) => parseNonCodegenResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), 'Gemini'),
      });
    }
  } catch {}

  // Groq
  try {
    const groq = require('./providers-groq');
    if (groq && getCONFIG().GROQ_API_KEY) {
      providers.push({
        name: 'Groq',
        type: 'non-codegen',
        callFn: async (prompt: string, signal: any) => {
          const result = await groq.callGroq(prompt, null, signal);
          return result?.choices?.[0]?.message?.content || null;
        },
        parseFn: (raw: any) => parseNonCodegenResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), 'Groq'),
      });
    }
  } catch {}

  // Cloudflare Workers AI
  try {
    const cf = require('./providers-cloudflare');
    if (cf && getCONFIG().CLOUDFLARE_ACCOUNT_ID) {
      providers.push({
        name: 'Cloudflare',
        type: 'non-codegen',
        callFn: async (prompt: string, signal: any) => {
          const result = await cf.callCloudflare(prompt, null, signal);
          return result?.choices?.[0]?.message?.content || result?.content || null;
        },
        parseFn: (raw: any) => parseNonCodegenResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), 'Cloudflare'),
      });
    }
  } catch {}

  // NVIDIA NIM
  try {
    const nvidia = require('./providers-nvidia');
    if (nvidia && getCONFIG().NVIDIA_API_KEY) {
      providers.push({
        name: 'NVIDIA',
        type: 'non-codegen',
        callFn: async (prompt: string, signal: any) => {
          const result = await nvidia.callNvidia(prompt, null, signal);
          return result?.choices?.[0]?.message?.content || null;
        },
        parseFn: (raw: any) => parseNonCodegenResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), 'NVIDIA'),
      });
    }
  } catch {}

  // Z.AI
  try {
    const zai = require('./providers-zai');
    if (zai && getCONFIG().ZAI_API_KEY) {
      providers.push({
        name: 'Z.AI',
        type: 'non-codegen',
        callFn: async (prompt: string, signal: any) => {
          const result = await zai.callZAI(prompt, null, signal);
          return result?.choices?.[0]?.message?.content || result?.content || null;
        },
        parseFn: (raw: any) => parseNonCodegenResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), 'Z.AI'),
      });
    }
  } catch {}

  // Agnes
  try {
    const agnes = require('./providers-agnes');
    if (agnes) {
      providers.push({
        name: 'Agnes',
        type: 'non-codegen',
        callFn: async (prompt: string, signal: any) => {
          const result = await agnes.callAgnes(prompt, null, signal);
          return result?.choices?.[0]?.message?.content || result?.content || result?.response || null;
        },
        parseFn: (raw: any) => parseNonCodegenResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), 'Agnes'),
      });
    }
  } catch {}

  // GitHub GPT (if available)
  try {
    const ghgpt = require('./providers-github-gpt');
    if (ghgpt) {
      providers.push({
        name: 'GitHub-GPT',
        type: 'non-codegen',
        callFn: async (prompt: string, signal: any) => {
          const result = await ghgpt.callGitHubGPT(prompt, null, signal);
          return result?.choices?.[0]?.message?.content || result?.content || null;
        },
        parseFn: (raw: any) => parseNonCodegenResponse(typeof raw === 'string' ? raw : JSON.stringify(raw), 'GitHub-GPT'),
      });
    }
  } catch {}

  return providers;
}

// ═══════════════════════════════════════════════════════════
//  PRIMARY API: generateCodeFixViaTribunal
//  For generating CODE FIXES only. Returns validated fix objects.
//
//  v2: Now accepts `consecutiveFailures` from self-heal.ts.
//  After 3 consecutive failures of the codegen-only tribunal,
//  the FULL provider cascade is activated (all providers, including
//  non-codegen ones). Non-codegen patches are validated more
//  stringently and go through enhanced safety protocols.
// ═══════════════════════════════════════════════════════════

async function generateCodeFixViaTribunal(
  investigationData: any,
  errorLogs: any,
  signal?: any,
  options?: { consecutiveFailures?: number }
) {
  const consecutiveFailures = options?.consecutiveFailures || 0;
  const useFullCascade = consecutiveFailures >= 3;

  if (useFullCascade) {
    log(`\u{1f6a8} FULL PROVIDER CASCADE ACTIVATED (${consecutiveFailures} consecutive codegen failures) — including ALL non-codegen providers with enhanced safety`, 'WARN', 'codegen');
    const allProviders = discoverAllProviders();
    const totalModels = allProviders.length;
    const codegenCount = allProviders.filter(p => p.type === 'codegen').length;
    const nonCodegenCount = allProviders.filter(p => p.type === 'non-codegen').length;

    log(`Full cascade: ${totalModels} providers total (${codegenCount} codegen + ${nonCodegenCount} non-codegen)`, 'INFO', 'codegen');

    const prompt = buildCodeGenPrompt(investigationData, errorLogs, true);
    const timeoutMs = NON_CODEGEN_EXTENDED_TIMEOUT_MS;
    const ctl = withTimeout(signal, timeoutMs);

    try {
      return await _runFullCascadeConsensus(prompt, allProviders, totalModels, ctl.signal);
    } finally {
      (ctl as any)._cleanup?.();
    }
  }

  // ── Normal codegen-only path (original behavior) ──
  const models = discoverModels();
  const totalModels = models.blModels.length + (models.hasMistral ? 1 : 0);
  const blModelList = models.blModels.join(', ');
  log(`\u{1f9e0} CODEGEN TRIBUNAL: Consulting ${totalModels} models \u2014 BazaarLink [${blModelList}]${models.hasMistral ? ' + Mistral' : ''}...`, 'INFO', 'codegen');

  const prompt = buildCodeGenPrompt(investigationData, errorLogs);
  const ctl = withTimeout(signal, DEFAULT_TRIBUNAL_TIMEOUT_MS);

  try {
    return await _runFixConsensus(prompt, models, totalModels, ctl.signal);
  } finally {
    (ctl as any)._cleanup?.();
  }
}

/**
 * Run the full provider cascade with ALL available providers.
 * Non-codegen providers get their responses parsed more stringently
 * and their fixes are flagged for enhanced downstream validation.
 */
async function _runFullCascadeConsensus(
  prompt: string,
  providers: Array<{ name: string; type: string; callFn: (prompt: string, signal: any) => Promise<any>; parseFn: (raw: any) => any[] }>,
  totalModels: number,
  signal: any
) {
  const allPromises: Promise<any>[] = [];

  for (const provider of providers) {
    log(`Full cascade: spawning ${provider.name} (${provider.type})`, 'DEBUG', 'codegen');
    allPromises.push(
      provider.callFn(prompt, signal)
        .then((result: any) => {
          const fixes = provider.parseFn(result);
          const isNonCodegen = provider.type === 'non-codegen';

          // Non-codegen fixes get strict validation
          const validFixes = isNonCodegen ? fixes.filter(validateFixStrict) : fixes.filter(validateFix);

          if (validFixes.length > 0) {
            log(`Full cascade ${provider.name}: ${validFixes.length} valid fix(es)${isNonCodegen ? ' [NON-CODEGEN - strict validation + enhanced safety]' : ''}`, 'INFO', 'codegen');
            return {
              provider: provider.name,
              fixes: validFixes,
              providerType: provider.type,
              error: undefined,
            };
          }

          log(`Full cascade ${provider.name}: 0 valid fixes from ${fixes.length} raw parse(s)`, 'DEBUG', 'codegen');
          return { provider: provider.name, fixes: [], providerType: provider.type };
        })
        .catch((err: any) => ({
          provider: provider.name,
          fixes: [],
          providerType: provider.type,
          error: String(err.message || err).substring(0, 200),
        }))
    );
  }

  if (allPromises.length === 0) {
    log('Full cascade: no providers available at all', 'ERROR', 'codegen');
    return null;
  }

  const results = await Promise.allSettled(allPromises) as PromiseSettledResult<any>[];
  const validResponses = results
    .filter((r): r is PromiseSettledResult<{ provider: string; fixes: any[]; providerType: string; error?: string }> =>
      r.status === 'fulfilled' && r.value.fixes.length > 0)
    .map(r => r.value);

  if (validResponses.length === 0) {
    const errors = results
      .filter(r => r.status === 'fulfilled' && r.value.error)
      .map(r => `${r.value.provider}: ${r.value.error}`);
    log(`\u274c Full cascade: no valid fixes from ${totalModels} providers. Errors: ${errors.join('; ').substring(0, 600)}`, 'ERROR', 'codegen');
    return null;
  }

  log(`\u{1f4ca} Full cascade: ${validResponses.length}/${totalModels} providers returned valid fixes.`, 'INFO', 'codegen');

  // ── Enhanced voting with codegen preference ──
  // Codegen fixes are worth 2 votes, non-codegen fixes are worth 1 vote.
  // This ensures codegen consensus still wins when available, but
  // non-codegen fixes can carry the day if ALL codegen providers fail.
  const fixVotes = new Map<string, { fix: any; score: number; providers: string[]; hasCodegenVote: boolean }>();

  for (const resp of validResponses) {
    for (const fix of resp.fixes) {
      const key = `${fix.file}::${fix.patch.substring(0, 120)}`;
      if (!fixVotes.has(key)) {
        fixVotes.set(key, { fix, score: 0, providers: [], hasCodegenVote: false });
      }
      const entry = fixVotes.get(key)!;
      const voteWeight = resp.providerType === 'codegen' ? 2 : 1;
      entry.score += voteWeight;
      entry.providers.push(resp.provider);
      if (resp.providerType === 'codegen') entry.hasCodegenVote = true;
    }
  }

  const sortedVotes = [...fixVotes.values()].sort((a, b) => {
    // Prefer codegen-voted fixes at the same score
    if (b.score !== a.score) return b.score - a.score;
    if (a.hasCodegenVote !== b.hasCodegenVote) return a.hasCodegenVote ? -1 : 1;
    return b.providers.length - a.providers.length;
  });

  const best = sortedVotes[0];
  if (!best) return null;

  // Tag the winning fix with metadata about its origin
  const taggedFix = {
    ...best.fix,
    _cascadeMetadata: {
      providers: best.providers,
      score: best.score,
      hasCodegenVote: best.hasCodegenVote,
      totalVoters: validResponses.length,
    },
  };

  if (best.score > 2) {
    log(`\u2705 CASCADE CONSENSUS (score ${best.score}): ${best.providers.join(', ')} agree on ${best.fix.file}${best.hasCodegenVote ? '' : ' [non-codegen only]'}\u26a0\ufe0f`, 'WARN', 'codegen');
    return [taggedFix];
  }

  if (best.providers.length > 1) {
    log(`\u26a0\ufe0f CASCADE: ${best.providers.length} providers (${best.providers.join(', ')}) agree on ${best.fix.file} (score: ${best.score})${best.hasCodegenVote ? '' : ' [ALL NON-CODEGEN]'}`, 'WARN', 'codegen');
    return [taggedFix];
  }

  // Single provider returned fixes — use it (last resort)
  log(`\u{1f525} CASCADE LAST RESORT: Single provider ${best.providers[0]} for ${best.fix.file} [${best.fix._cascadeMetadata?.hasCodegenVote ? 'codegen' : 'NON-CODEGEN'}]\u26a0\ufe0f`, 'ERROR', 'codegen');
  return [taggedFix];
}

/**
 * Run the fix-specific consensus algorithm (codegen only, original behavior).
 */
async function _runFixConsensus(prompt: string, models: any, totalModels: number, signal: any) {
  const allPromises: Promise<any>[] = [];
  let blSkipped = false;

  if (models.hasBazaarLink) {
    if (blLimiter.isExhausted()) {
      log('BazaarLink budget exhausted \u2014 skipping BazaarLink calls this round', 'WARN', 'codegen');
      blSkipped = true;
    } else {
      for (const modelSlug of models.blModels) {
        log(`Tribunal: spawning BL/${modelSlug}`, 'DEBUG', 'codegen');
        allPromises.push(
          _getBL().callBazaarLinkCodeGenWithModel(prompt, signal, modelSlug)
            .then((result: any) => {
              if (!result) {
                log(`BL/${modelSlug}: parseCodegenResponse returned null`, 'WARN', 'codegen');
              } else if (Array.isArray(result)) {
                log(`BL/${modelSlug}: got ${result.length} raw fix(es) from parser`, 'DEBUG', 'codegen');
              } else {
                log(`BL/${modelSlug}: got non-array result: ${typeof result}`, 'DEBUG', 'codegen');
              }
              return { provider: `BL/${modelSlug}`, fixes: validateFixArray(result) };
            })
            .catch((err: any) => ({ provider: `BL/${modelSlug}`, fixes: [], error: String(err.message || err).substring(0, 200) }))
        );
      }
    }
  }
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

  if (allPromises.length === 0) {
    log('No codegen providers available. Need BAZAARLINK_API_KEY or MISTRAL_CODE_API_KEY.', 'ERROR', 'codegen');
    return null;
  }

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
    return blSkipped ? null : null;
  }

  log(`\u{1f4ca} ${validResponses.length}/${totalModels} codegen models returned valid fixes.`, 'INFO', 'codegen');

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
    log(`\u2705 CONSENSUS: ${best.count}/${validResponses.length} models (${best.providers.join(', ')}) agree on ${best.fix.file}.`, 'INFO', 'codegen');
    return [best.fix];
  }
  if (best) {
    log(`\u26a0\ufe0f Single-model fix from ${best.providers[0]} for ${best.fix.file}.`, 'WARN', 'codegen');
    return [best.fix];
  }
  return null;
}

// ═══════════════════════════════════════════════════════════
//  GENERIC API: consultTribunalRaw
//  For any text-generation task that is NOT a code fix.
// ═══════════════════════════════════════════════════════════

async function consultTribunalRaw(prompt: string, signal?: any, options?: { timeoutMs?: number; responseFormatJson?: boolean }) {
  const timeoutMs = options?.timeoutMs || DEFAULT_TRIBUNAL_TIMEOUT_MS;
  const models = discoverModels();
  const totalModels = models.blModels.length + (models.hasMistral ? 1 : 0);
  log(`\u{1f9e0} TRIBUNAL RAW: Consulting ${totalModels} codegen models for generic task...`, 'INFO', 'codegen');

  const ctl = withTimeout(signal, timeoutMs);
  try {
    const allPromises: Promise<{ provider: string; raw: string } | null>[] = [];

    if (models.hasBazaarLink && !blLimiter.isExhausted()) {
      for (const modelSlug of models.blModels) {
        log(`Tribunal raw: spawning BL/${modelSlug}`, 'DEBUG', 'codegen');
        allPromises.push(_callRawBazaarLink(prompt, ctl.signal, modelSlug));
      }
    } else if (models.hasBazaarLink) {
      log('Tribunal raw: BazaarLink budget exhausted \u2014 skipping', 'WARN', 'codegen');
    }
    if (models.hasMistral) {
      allPromises.push(_callRawProvider('Mistral', () => callMistralCodeGen(prompt, ctl.signal), ctl.signal));
    }

    if (allPromises.length === 0) {
      log('No codegen providers available for raw consultation', 'ERROR', 'codegen');
      return null;
    }

    const results = await Promise.allSettled(allPromises);
    const successes: { provider: string; raw: string }[] = [];
    const errors: string[] = [];

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        successes.push(r.value);
      } else if (r.status === 'rejected') {
        errors.push(String((r as any).reason?.message || r.reason).substring(0, 100));
      }
    }

    if (successes.length === 0) {
      log(`No successful response from ${totalModels} models for raw consultation. Errors: ${errors.join('; ').substring(0, 500)}`, 'ERROR', 'codegen');
      return null;
    }

    successes.sort((a, b) => b.raw.length - a.raw.length);
    const best = successes[0];
    log(`Tribunal raw: got response from ${best.provider} (${best.raw.length} chars, ${successes.length}/${totalModels} succeeded)`, 'INFO', 'codegen');
    return best.raw;
  } finally {
    (ctl as any)._cleanup?.();
  }
}

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

async function _callRawProvider(name: string, callFn: () => Promise<any>, signal: any) {
  try {
    const result = await callFn();
    if (!result) return null;
    const raw = typeof result === 'string' ? result : JSON.stringify(result);
    if (!raw || raw.trim().length === 0) return null;
    return { provider: name, raw };
  } catch (err: any) {
    log(`Tribunal raw ${name} failed: ${String(err.message || err).substring(0, 200)}`, 'DEBUG', 'codegen');
    return null;
  }
}

function buildCodeGenPrompt(investigationData: any, errorLogs: any, isFullCascade = false) {
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
  prompt += `CONTEXT:\n${contextLines.join('\n')}\n`;

  if (isFullCascade) {
    // Enhanced prompt for non-codegen models — more explicit about output format
    prompt += `\nCRITICAL INSTRUCTIONS FOR OUTPUT FORMAT:\n`;
    prompt += `You MUST return ONLY a valid JSON array. No markdown fences. No explanation. No commentary.\n`;
    prompt += `The array must contain objects with EXACTLY these fields:\n`;
    prompt += `  - "file": string (relative path from project root, e.g. "providers-registry.ts")\n`;
    prompt += `  - "change": string (human-readable description, 10+ characters)\n`;
    prompt += `  - "patch": string (the COMPLETE new file content, NOT a unified diff. Must start with 'use strict')\n`;
    prompt += `If you cannot produce a valid fix, return exactly: []\n`;
  }

  if (targetFile && fileContent) {
    prompt += `\nTarget file to fix: ${targetFile}\n`;
    prompt += `--- BEGIN FILE: ${targetFile} ---\n${fileContent}\n--- END FILE ---\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Identify the exact bug in the file above.\n`;
    prompt += `2. Propose a fix.\n`;
    prompt += `3. Return a JSON ARRAY of objects. Each object must have:\n`;
    prompt += `- "file": (string) relative path from project root\n`;
    prompt += `- "change": (string) human-readable description of the fix\n`;
    prompt += `- "patch": (string) the COMPLETE new file content starting with 'use strict'\n`;
    prompt += `If no fix is possible, return exactly: []\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  } else {
    prompt += `\nNo specific target file identified. You must infer which file(s) to fix from the error context above.\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Analyze the error and identify the likely source file.\n`;
    prompt += `2. Propose a fix with complete file content.\n`;
    prompt += `3. Return a JSON ARRAY of objects. Each object must have:\n`;
    prompt += `- "file": (string) relative path from project root\n`;
    prompt += `- "change": (string) human-readable description of the fix\n`;
    prompt += `- "patch": (string) the COMPLETE new file content starting with 'use strict'\n`;
    prompt += `Only return [] if you truly cannot identify any file to fix.\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  }

  return prompt;
}

module.exports = { generateCodeFixViaTribunal, consultTribunalRaw, discoverAllProviders, validateFixStrict, parseNonCodegenResponse, _injectDependencies };
