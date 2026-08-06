'use strict';
// Last modified: 2026-08-05 - Response 20: Added DeepInfra, generalized emergency discovery, vision-only filter

// Provider implementations - internal sub-modules, not container-registered
const { GitHubGPTProvider } = require('./providers-github-gpt');
const { GroqProvider } = require('./providers-groq');
const { ZAIProvider } = require('./providers-zai');
const { AgnesProvider } = require('./providers-agnes');
const { NvidiaProvider } = require('./providers-nvidia');
const { CloudflareProvider } = require('./providers-cloudflare');
const { CerebrasProvider } = require('./providers-cerebras');
const { GeminiProvider } = require('./providers-gemini');
const { OpenRouterTribunalProvider } = require('./providers-openrouter-tribunal');
const { DeepInfraProvider } = require('./providers-deepinfra');

// --- Dependency Injection ---------------------------------------------------
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getLog(): (msg: string, level?: string, _module?: string) => void {
  return _deps.logger?.log || console.log;
}

// Lazy health module - loaded on first use
let _healthMod: any = null;
function _getHealth() { if (!_healthMod) _healthMod = require('./providers-health'); return _healthMod; }

// Lazy config loader - loaded on first use
let _configLoaderMod: any = null;
function _getConfigLoader() { if (!_configLoaderMod) _configLoaderMod = require('./providers-config-loader'); return _configLoaderMod; }

// Lazy serializers - loaded on first use
let _serializersMod: any = null;
function _getSerializers() { if (!_serializersMod) _serializersMod = require('./providers-serializers'); return _serializersMod; }

// ===============================================================================
// PROVIDER REGISTRATION TABLE
// ===============================================================================
//
// Each entry maps a provider name to its factory function.
// The registry iterates this table in getAvailableProviders(),
// applying health/capability/blacklist/retirement filters.

interface ProviderEntry {
  name: string;
  factory: () => any;  // returns null if API key missing
}

const PROVIDER_TABLE: ProviderEntry[] = [
  { name: 'Groq', factory: GroqProvider },
  { name: 'z.ai', factory: ZAIProvider },
  { name: 'Agnes', factory: AgnesProvider },
  { name: 'NVIDIA', factory: NvidiaProvider },
  { name: 'Cloudflare', factory: CloudflareProvider },
  { name: 'Cerebras', factory: CerebrasProvider },
  // DeepInfra removed - no longer free tier (2026-08-06)
  { name: 'Gemini', factory: GeminiProvider },
  { name: 'OpenRouter', factory: OpenRouterTribunalProvider },
  // GitHub GPT is in the table but filtered by P9 (disabled by default)
  { name: 'GitHub GPT', factory: GitHubGPTProvider },
];

// ===============================================================================
// CYCLE-LEVEL STATE (reset per question cycle)
// ===============================================================================

const providerCycleState = { githubRateLimitCount: 0, githubSwappedOut: false };
let cycleBlacklist = new Set<string>();
let cycleFailCounts: Record<string, number> = {};
let dynamicProviders: Array<{ name: string; fn: any }> = [];

// ===============================================================================
// RETIRED PROVIDERS (permanent until restart or manual intervention)
// ===============================================================================

const retiredProviders = new Map<string, { reason: string; retiredAt: number }>();

// ===============================================================================
// GEMINI 429 ESCALATING COOLDOWN (P10)
// ===============================================================================
//
// Gemini free tier is aggressively rate-limited. Instead of letting the
// generic circuit breaker handle it (which would block Gemini entirely
// for 45s), we use an escalating cooldown that adapts:
//   - 1st consecutive 429: 30s cooldown
//   - 2nd consecutive 429: 60s cooldown
//   - 3rd+ consecutive 429: 120s cooldown
// After cooldown, allow 1 probe request (half-open). If it succeeds, reset.
// If it 429s again, double the cooldown.

const gemini429State = {
  consecutive429s: 0,
  cooldownUntil: 0,
  currentCooldownMs: 30000,
};

function getGeminiCooldownRemainingMs(): number {
  const remaining = gemini429State.cooldownUntil - Date.now();
  return Math.max(0, remaining);
}

function recordGemini429(): void {
  gemini429State.consecutive429s++;
  if (gemini429State.consecutive429s === 1) gemini429State.currentCooldownMs = 30000;
  else if (gemini429State.consecutive429s === 2) gemini429State.currentCooldownMs = 60000;
  else gemini429State.currentCooldownMs = 120000;
  gemini429State.cooldownUntil = Date.now() + gemini429State.currentCooldownMs;
  getLog()(`Gemini 429 cooldown: ${gemini429State.consecutive429s} consecutive, ${gemini429State.currentCooldownMs / 1000}s cooldown`, 'WARN', 'registry');
}

function recordGeminiSuccess(): void {
  if (gemini429State.consecutive429s > 0) {
    getLog()(`Gemini recovered after ${gemini429State.consecutive429s} consecutive 429s`, 'INFO', 'registry');
  }
  gemini429State.consecutive429s = 0;
  gemini429State.cooldownUntil = 0;
  gemini429State.currentCooldownMs = 30000;
}

function isGeminiOnCooldown(): boolean {
  return Date.now() < gemini429State.cooldownUntil;
}

// ===============================================================================
// DYNAMIC PROVIDERS
// ===============================================================================

function registerDynamicProvider(name: string, providerFn: any) { 
  dynamicProviders.push({ name, fn: providerFn });
  getLog()(`Registered dynamic provider: ${name}`, 'DEBUG', 'registry');
}

// ===============================================================================
// RESULT RECORDING (P5 - delegates to providers-health)
// ===============================================================================
//
// recordProviderResult is the main entry point called by the tribunal.
// It now delegates to providers-health.recordCallResult for health scoring,
// circuit breakers, and cooldowns. The DB write is kept here for persistence.

function recordProviderResult(name: string, success: boolean, latency: number) { 
  const log = getLog();

  // Delegate to health module for scoring + circuit breakers + cooldowns
  try {
    const health = _getHealth();
    health.recordCallResult(name, success, latency);
  } catch (e: any) { /* non-critical: health module failure shouldn't break recording */ }

  // Gemini-specific 429 tracking (P10)
  if (name === 'Gemini') {
    if (success) recordGeminiSuccess();
    // Note: 429 recording happens in addProviderFailure below
  }

  // Persist to DB for long-term stats
  try {
    const db = _deps.database;
    if (!db) return;
    const selectProvider = db.selectProvider;
    const upsertProvider = db.upsertProvider;
    const updateProviderStats = db.updateProviderStats;
    if (!selectProvider || !upsertProvider || !updateProviderStats) return;
    let row = selectProvider.get(name);
    if (!row) {
      upsertProvider.run(name, null, null, Date.now(), '[]', 0, 0, 0, Date.now());
      row = selectProvider.get(name);
    }
    if (row) {
      updateProviderStats.run(
        (row.success_count ?? 0) + (success ? 1 : 0),
        (row.failure_count ?? 0) + (success ? 0 : 1),
        (row.total_latency ?? 0) + latency,
        Date.now(),
        name
      );
    }
  } catch (e: any) { log(`DB error in recordProviderResult: ${e.message || e}`, 'DEBUG', 'registry'); }
}

// ===============================================================================
// HEALTH CHECK (P5 - delegates to providers-health)
// ===============================================================================

function isProviderHealthy(name: string): boolean { 
  try {
    const health = _getHealth();
    const snapshot = health.getHealthSnapshot(name);
    // Health score >= 0.3 is considered healthy (tolerant for low-sample providers)
    return snapshot.healthScore >= 0.3;
  } catch {
    // If health module fails, assume healthy (fail-open)
    return true;
  }
}

// ===============================================================================
// CYCLE-LEVEL BLACKLIST (per-question-cycle, not persistent)
// ===============================================================================

function resetCycleProviderState() {
  const log = getLog();
  providerCycleState.githubRateLimitCount = 0;
  providerCycleState.githubSwappedOut = false;
  cycleBlacklist = new Set();
  cycleFailCounts = {};
  dynamicProviders = [];
  // Reset health state for all tracked providers (fresh cycle)
  try {
    const health = _getHealth();
    for (const name of health.getTrackedProviders()) {
      health.resetProviderState(name);
    }
  } catch {}
  log('Provider cycle state reset (blacklist cleared, health reset)', 'INFO', 'registry');
}

function addProviderFailure(name: string) { 
  const log = getLog();
  cycleFailCounts[name] = (cycleFailCounts[name] || 0) + 1;

  // Gemini-specific: track 429s for escalating cooldown
  if (name === 'Gemini') {
    recordGemini429();
  }

  // Blacklist after 2 consecutive failures in this cycle
  if (cycleFailCounts[name] >= 2) {
    if (!cycleBlacklist.has(name)) {
      cycleBlacklist.add(name);
      log(`Blacklisting ${name} for this cycle (${cycleFailCounts[name]} failures)`, 'WARN', 'registry');
    }
  }
}

function isProviderBlacklisted(name: string): boolean { 
  // Check cycle blacklist
  if (cycleBlacklist.has(name)) return true;

  // Check health module availability
  try {
    const health = _getHealth();
    if (!health.isProviderAvailable(name)) return true;
    // Also check health score - below 0.2 is effectively dead
    const snapshot = health.getHealthSnapshot(name);
    if (snapshot.healthScore < 0.2 && snapshot.totalCalls >= 3) return true;
  } catch {}

  return false;
}

// ===============================================================================
// PROVIDER RETIREMENT + AUTO-REPLACEMENT (P8)
// ===============================================================================

function retireProvider(name: string, reason: string) { 
  const log = getLog();
  retiredProviders.set(name, { reason, retiredAt: Date.now() });
  log(`Provider ${name} retired: ${reason}`, 'WARN', 'registry');
  try {
    const db = _deps.database;
    if (db?.upsertCalibration) {
      db.upsertCalibration.run(`retired_${name}`, JSON.stringify({ reason, retiredAt: Date.now() }), Date.now());
    }
  } catch (e: any) {}

  // P8: Attempt auto-replacement
  try {
    const configLoader = _getConfigLoader();
    const replacement = configLoader.findReplacement(name);
    if (replacement && replacement.model) {
      const dynName = configLoader.registerReplacement(name, replacement);
      log(`Auto-replacement registered for ${name}: ${replacement.model} (as ${dynName})`, 'INFO', 'registry');
    } else {
      log(`No replacement found for retired ${name}`, 'WARN', 'registry');
    }
  } catch (e: any) {
    log(`Auto-replacement failed for ${name}: ${e.message}`, 'WARN', 'registry');
  }
}

function isProviderRetired(name: string): boolean { 
  return retiredProviders.has(name);
}

// ===============================================================================
// HEALTH-WEIGHTED PROVIDER SELECTION (P5, P12, P16)
// ===============================================================================
//
// getAvailableProviders() returns providers sorted by health score (descending).
// This means the tribunal will consult the healthiest providers first,
// and their votes carry the most weight (P12).
//
// Filtering pipeline:
//   1. Provider factory returns non-null (API key present)
//   2. Not disabled by default (P9: GitHub GPT)
//   3. Not on cycle blacklist
//   4. Not retired
//   5. Not disabled/cooldown/circuit-open (from providers-health)
//   6. Not Gemini on 429 cooldown (P10)
//   7. Vision-only filter if requested (Phase 2.5)
//   8. Sort by health score descending

async function getAvailableProviders(options?: { visionOnly?: boolean }) { 
  const log = getLog();
  const configLoader = _getConfigLoader();
  let candidates: Array<{ name: string; fn: any; healthScore: number }> = [];

  // --- Phase 1: Collect candidates from PROVIDER_TABLE ---
  for (const entry of PROVIDER_TABLE) {
    // P9: Skip disabled-by-default providers (GitHub GPT)
    if (configLoader.isProviderDisabledByDefault(entry.name)) {
      continue;
    }

    // Instantiate the provider (checks for API key)
    const fn = entry.factory();
    if (!fn) continue;

    // Check all exclusion filters
    if (isProviderBlacklisted(entry.name)) continue;
    if (isProviderRetired(entry.name)) continue;

    // P10: Gemini-specific cooldown check
    if (entry.name === 'Gemini' && isGeminiOnCooldown()) continue;

    // Get health score for sorting
    let healthScore = 0.5; // default for untracked providers
    try {
      const health = _getHealth();
      const snapshot = health.getHealthSnapshot(entry.name);
      healthScore = snapshot.healthScore;
    } catch {}

    candidates.push({ name: entry.name, fn, healthScore });
  }

  // --- Phase 2: Add dynamic providers ---
  for (const dp of dynamicProviders) {
    if (isProviderBlacklisted(dp.name) || isProviderRetired(dp.name)) continue;
    let healthScore = 0.5;
    try {
      const health = _getHealth();
      const snapshot = health.getHealthSnapshot(dp.name);
      healthScore = snapshot.healthScore;
    } catch {}
    candidates.push({ name: dp.name, fn: dp.fn, healthScore });
  }

  // --- Phase 2.5: Vision-only filtering ---
  if (options?.visionOnly) {
    const serializers = _getSerializers();
    const beforeCount = candidates.length;
    candidates = candidates.filter(candidate => {
      const caps = serializers.getProviderCapabilities?.(candidate.name);
      const isVisionCapable = caps ? caps.supportsVision : true;
      return isVisionCapable;
    });
    const filtered = beforeCount - candidates.length;
    log(`Vision filter: ${filtered} text-only providers excluded`, 'DEBUG', 'registry');
  }

  // --- Phase 3: Sort by health score (highest first) ---
  candidates.sort((a, b) => b.healthScore - a.healthScore);

  // --- Phase 4: Fail-fast on empty (P16) ---
  if (candidates.length === 0) {
    log('CRITICAL: No providers available after all filters. Attempting emergency discovery + registration.', 'ERROR', 'registry');
    try {
      const discovered = await configLoader.autoDiscoverModels();
      if (discovered.length > 0) {
        log(`Emergency discovery found ${discovered.length} model(s). Attempting to register as dynamic providers.`, 'WARN', 'registry');
        // Try to create callable providers from discovered models
        const PROVIDER_ENDPOINT_MAP: Record<string, {endpoint: string; envKey: string}> = {
          openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions', envKey: 'OPENROUTER_API_KEY' },
          groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', envKey: 'GROQ_API_KEY' },
          nvidia: { endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', envKey: 'NVIDIA_API_KEY' },
          deepinfra: { endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions', envKey: 'DEEPINFRA_API_KEY' },
        };
        for (const disc of discovered.slice(0, 2)) {
          const providerConfig = PROVIDER_ENDPOINT_MAP[disc.provider];
          if (providerConfig && process.env[providerConfig.envKey]) {
            const { callChatCompletionWithRollback, extractJSON, validateActionResponse, retryWithBackoff } = require('./providers-base');
            const modelId = disc.model;
            const endpoint = providerConfig.endpoint;
            const apiKey = process.env[providerConfig.envKey];
            const dynName = `discovered-${modelId.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}`;
            const dynFn = async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
              const rawContent = await retryWithBackoff(() =>
                callChatCompletionWithRollback(endpoint, apiKey, modelId, base64Image, prompt, dynName, { signal }),
                { providerName: dynName }
              );
              if (options.validate === false) return rawContent;
              return validateActionResponse(extractJSON(rawContent, dynName), dynName);
            };
            registerDynamicProvider(dynName, dynFn);
            candidates.push({ name: dynName, fn: dynFn, healthScore: 0.4 }); // lower initial score
          }
        }
      }
    } catch (e: any) { log(`Emergency discovery failed: ${e.message}`, 'ERROR', 'registry'); }
  }

  // Log final provider list with health scores
  if (candidates.length > 0) {
    const summary = candidates.map(c => `${c.name}(${c.healthScore.toFixed(2)})`).join(', ');
    log(`Available providers (${candidates.length}): ${summary}`, 'INFO', 'registry');
  } else {
    log('FATAL: No providers available even after emergency discovery. Bot will idle.', 'ERROR', 'registry');
  }

  return candidates;
}

// ===============================================================================
// LEGACY COMPATIBILITY
// ===============================================================================

function getProviderCycleState() { return providerCycleState; }

module.exports = {
  getAvailableProviders,
  addProviderFailure,
  resetCycleProviderState,
  isProviderBlacklisted,
  getProviderCycleState,
  recordProviderResult,
  isProviderHealthy,
  registerDynamicProvider,
  retireProvider,
  isProviderRetired,
  // Gemini-specific (exposed for monitoring)
  getGeminiCooldownRemainingMs,
  isGeminiOnCooldown,
  // DI
  _injectDependencies,
};
