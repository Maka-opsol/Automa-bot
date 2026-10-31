'use strict';
// Last modified: 2026-08-07 - Disabled Cerebras (free tier removed)

// Provider implementations - internal sub-modules, not container-registered
// Each require is wrapped in try/catch so one broken provider doesn't kill the entire registry.
// ===============================================================================
// PROVIDER DIAGNOSTIC (for startup health check)
// ===============================================================================

// FIX: Declared BEFORE getAvailableProviderCount() which uses it.
// Tracks whether the initial diagnostic has been logged.
let _diagnosticLogged = false;

// FIX: Track which modules failed to load and WHY, for diagnostic logging.
const _loadFailures: Array<{ name: string; error: string }> = [];
let GitHubGPTProvider: any = null; try { ({ GitHubGPTProvider } = require('./providers-github-gpt')); } catch (e: any) { _loadFailures.push({ name: 'GitHub GPT', error: e.message }); console.error(`[registry] Failed to load providers-github-gpt: ${e.message}`); }
let GroqProvider: any = null; try { ({ GroqProvider } = require('./providers-groq')); } catch (e: any) { _loadFailures.push({ name: 'Groq', error: e.message }); console.error(`[registry] Failed to load providers-groq: ${e.message}`); }
let ZAIProvider: any = null; try { ({ ZAIProvider } = require('./providers-zai')); } catch (e: any) { _loadFailures.push({ name: 'z.ai', error: e.message }); console.error(`[registry] Failed to load providers-zai: ${e.message}`); }
let AgnesProvider: any = null; try { ({ AgnesProvider } = require('./providers-agnes')); } catch (e: any) { _loadFailures.push({ name: 'Agnes', error: e.message }); console.error(`[registry] Failed to load providers-agnes: ${e.message}`); }
let NvidiaProvider: any = null; try { ({ NvidiaProvider } = require('./providers-nvidia')); } catch (e: any) { _loadFailures.push({ name: 'NVIDIA', error: e.message }); console.error(`[registry] Failed to load providers-nvidia: ${e.message}`); }
let CloudflareProvider: any = null; try { ({ CloudflareProvider } = require('./providers-cloudflare')); } catch (e: any) { _loadFailures.push({ name: 'Cloudflare', error: e.message }); console.error(`[registry] Failed to load providers-cloudflare: ${e.message}`); }
let CerebrasProvider: any = null; try { ({ CerebrasProvider } = require('./providers-cerebras')); } catch (e: any) { _loadFailures.push({ name: 'Cerebras', error: e.message }); console.error(`[registry] Failed to load providers-cerebras: ${e.message}`); }
let GeminiProvider: any = null; try { ({ GeminiProvider } = require('./providers-gemini')); } catch (e: any) { _loadFailures.push({ name: 'Gemini', error: e.message }); console.error(`[registry] Failed to load providers-gemini: ${e.message}`); }
let OpenRouterTribunalProvider: any = null; try { ({ OpenRouterTribunalProvider } = require('./providers-openrouter-tribunal')); } catch (e: any) { _loadFailures.push({ name: 'OpenRouter', error: e.message }); console.error(`[registry] Failed to load providers-openrouter-tribunal: ${e.message}`); }
let DeepInfraProvider: any = null; try { ({ DeepInfraProvider } = require('./providers-deepinfra')); } catch (e: any) { _loadFailures.push({ name: 'DeepInfra', error: e.message }); console.error(`[registry] Failed to load providers-deepinfra: ${e.message}`); }

// TIER 1+ (2026-10-31): Ollama local LLM — NEVER gets blacklisted, always available
let OllamaProvider: any = null; try { ({ OllamaProvider } = require('./providers-ollama')); } catch (e: any) { _loadFailures.push({ name: 'Ollama', error: e.message }); console.error(`[registry] Failed to load providers-ollama: ${e.message}`); }

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
  // Cerebras removed - free tier removed (2026-08-07)
  // DeepInfra removed - no longer free tier (2026-08-06)
  { name: 'Gemini', factory: GeminiProvider },
  { name: 'OpenRouter', factory: OpenRouterTribunalProvider },
  // GitHub GPT is in the table but filtered by P9 (disabled by default)
  { name: 'GitHub GPT', factory: GitHubGPTProvider },
  // TIER 1+ (2026-10-31): Ollama local LLM — always available, never blacklisted.
  // This is the LAST resort but ALWAYS available. When all cloud providers
  // are rate-limited/blacklisted, the bot uses Ollama instead of waiting.
  { name: 'Ollama', factory: OllamaProvider },
];

// ===============================================================================
// CYCLE-LEVEL STATE (reset per question cycle)
// ===============================================================================

const providerCycleState = { githubRateLimitCount: 0, githubSwappedOut: false };
let _lastEmptyProviderLogTime = 0;
const EMPTY_PROVIDER_LOG_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between CRITICAL logs
let _lastEmergencyDiscoveryTime = 0;
const EMERGENCY_DISCOVERY_COOLDOWN_MS = 10 * 60 * 1000; // 10 min between emergency discoveries
let cycleBlacklist = new Set<string>();
let cycleFailCounts: Record<string, number> = {};
let dynamicProviders: Array<{ name: string; fn: any }> = [];

// ===============================================================================
// RETIRED PROVIDERS (persisted to DB, survives restarts via Turso)
// ===============================================================================

const retiredProviders = new Map<string, { reason: string; retiredAt: number }>();

/**
 * Load retired providers from the calibration table (DB/Turso).
 * Called on startup so dead providers aren't retried after Render restarts.
 * Keys are stored as 'retired_<ProviderName>' in the calibration table.
 */
function _loadRetiredProvidersFromDb(): void {
  try {
    const db = _deps.database;
    if (!db?.selectCalibration) return;
    const rows = db.selectCalibration.all();
    let loaded = 0;
    for (const row of rows) {
      if (typeof row.key === 'string' && row.key.startsWith('retired_')) {
        try {
          const parsed = JSON.parse(row.value);
          if (parsed.reason && parsed.retiredAt) {
            const providerName = row.key.substring('retired_'.length);
            retiredProviders.set(providerName, { reason: parsed.reason, retiredAt: parsed.retiredAt });
            loaded++;
          }
        } catch {}
      }
    }
    if (loaded > 0) {
      getLog()(`Loaded ${loaded} retired providers from DB: ${[...retiredProviders.keys()].join(', ')}`, 'WARN', 'registry');
    }
  } catch {}
}

// Load retired providers immediately on module require
_loadRetiredProvidersFromDb();

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

function addProviderFailure(name: string, err?: any) { 
  const log = getLog();
  cycleFailCounts[name] = (cycleFailCounts[name] || 0) + 1;

  // Gemini-specific: track 429s for escalating cooldown.
  // Only count actual rate-limit errors, not 404s, auth errors, etc.
  if (name === 'Gemini') {
    const msg = err?.message || '';
    if (msg.includes('HTTP_ERROR_429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota') || msg.includes('429')) {
      recordGemini429();
    }
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
  // TIER 1+ (2026-10-31): Ollama NEVER gets blacklisted — it's a local LLM,
  // not subject to rate limits or cloud outages. This ensures the bot always
  // has at least one provider available.
  if (name === 'Ollama') return false;

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
  const retiredAt = Date.now();
  retiredProviders.set(name, { reason, retiredAt });
  log(`Provider ${name} retired: ${reason}`, 'WARN', 'registry');
  // Persist to local DB (sync) — survives via Turso sync
  try {
    const db = _deps.database;
    if (db?.upsertCalibration) {
      db.upsertCalibration.run(`retired_${name}`, JSON.stringify({ reason, retiredAt }), retiredAt);
    }
  } catch (e: any) {}
  // Also push to Turso immediately (don't wait for 30s sync cycle)
  try {
    const turso = require('./database-turso');
    if (turso?.isAvailable?.()) {
      turso.tursoUpsertCalibration(`retired_${name}`, JSON.stringify({ reason, retiredAt }), retiredAt).catch(() => {});
    }
  } catch {}

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
    // Guard: factory itself may be null if the provider module failed to load
    if (!entry.factory) {
      getLog()(`Provider ${entry.name} skipped — factory not loaded (module error)`, 'WARN', 'registry');
      continue;
    }
    const fn = entry.factory();
    if (!fn) {
      // Log why each provider was skipped for diagnostics
      const envKeys = configLoader.getEnvKeys?.(entry.name) || [];
      const missingKeys = envKeys.filter((k: string) => !process.env[k]);
      if (missingKeys.length > 0) {
        getLog()(`Provider ${entry.name} skipped — missing env keys: ${missingKeys.join(', ')}`, 'DEBUG', 'registry');
      } else {
        getLog()(`Provider ${entry.name} factory returned null (unknown reason)`, 'DEBUG', 'registry');
      }
      continue;
    }

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

  // --- Phase 4: Fail-safe on empty (P16) ---
  if (candidates.length === 0) {
    const now = Date.now();
    // Rate-limit CRITICAL log to once per 10 minutes to avoid spam
    if (now - _lastEmptyProviderLogTime > EMPTY_PROVIDER_LOG_COOLDOWN_MS) {
      log('CRITICAL: No providers available after all filters. Attempting emergency discovery + registration.', 'ERROR', 'registry');
      _lastEmptyProviderLogTime = now;
    }
    // Rate-limit emergency discovery to once per 10 minutes
    if (now - _lastEmergencyDiscoveryTime > EMERGENCY_DISCOVERY_COOLDOWN_MS) {
      _lastEmergencyDiscoveryTime = now;
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
    } else {
      log('No providers available — skipping emergency discovery (cooldown active).', 'DEBUG', 'registry');
    }
  }

  // --- Phase 4.5: Last-resort bypass ---
  // When ALL providers are filtered out (including after emergency discovery),
  // re-scan ignoring blacklist/health/circuit/cooldown but still requiring a
  // working factory and not retired. Better to try a degraded provider than
  // to have zero providers and idle.
  if (candidates.length === 0) {
    for (const entry of PROVIDER_TABLE) {
      if (configLoader.isProviderDisabledByDefault(entry.name)) continue;
      if (!entry.factory) continue;
      let fn: any;
      try { fn = entry.factory(); } catch { continue; }
      if (!fn) continue;
      if (isProviderRetired(entry.name)) continue;
      // Skip Gemini 429 cooldown even in last-resort (cooldown is real)
      if (entry.name === 'Gemini' && isGeminiOnCooldown()) continue;
      log(`Last-resort: including ${entry.name} (bypassing blacklist/health)`, 'WARN', 'registry');
      candidates.push({ name: entry.name, fn, healthScore: 0.1 });
    }
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
// PROVIDER COUNT (for degradation ladder — synchronous count)
// ===============================================================================

/**
 * Get the number of currently available providers.
 * This is a synchronous approximation that checks loaded providers from
 * the table against their API key availability and health status.
 * Used by the degradation ladder to determine resource levels.
 * 
 * Note: This is an approximation — the full getAvailableProviders() is async
 * and does more thorough checks. This sync version is sufficient for level
 * determination since it runs every cycle.
 */
function getAvailableProviderCount(options?: { visionOnly?: boolean }): number {
  let count = 0;
  const configLoader = _getConfigLoader();
  const skipReasons: Array<{ name: string; reason: string }> = [];

  for (const entry of PROVIDER_TABLE) {
    if (configLoader.isProviderDisabledByDefault(entry.name)) {
      skipReasons.push({ name: entry.name, reason: 'disabled by default' });
      continue;
    }
    if (!entry.factory) {
      skipReasons.push({ name: entry.name, reason: 'module failed to load' });
      continue;
    }
    try {
      const fn = entry.factory();
      if (!fn) {
        const envKeys = configLoader.getEnvKeys?.(entry.name) || [];
        const missingKeys = envKeys.filter((k: string) => !process.env[k]);
        const reason = missingKeys.length > 0
          ? `missing env: ${missingKeys.join(', ')}`
          : 'factory returned null (unknown)';
        skipReasons.push({ name: entry.name, reason });
        continue;
      }
    } catch (e: any) {
      skipReasons.push({ name: entry.name, reason: `factory threw: ${e.message}` });
      continue;
    }
    if (isProviderBlacklisted(entry.name)) {
      skipReasons.push({ name: entry.name, reason: 'blacklisted' });
      continue;
    }
    if (isProviderRetired(entry.name)) {
      skipReasons.push({ name: entry.name, reason: 'retired' });
      continue;
    }
    if (entry.name === 'Gemini' && isGeminiOnCooldown()) {
      skipReasons.push({ name: entry.name, reason: 'Gemini 429 cooldown' });
      continue;
    }

    // Vision-only filtering
    if (options?.visionOnly) {
      try {
        const serializers = _getSerializers();
        const caps = serializers.getProviderCapabilities?.(entry.name);
        if (caps && !caps.supportsVision) {
          skipReasons.push({ name: entry.name, reason: 'text-only (vision requested)' });
          continue;
        }
      } catch {}
    }

    count++;
  }

  // Add dynamic providers
  for (const dp of dynamicProviders) {
    if (isProviderBlacklisted(dp.name) || isProviderRetired(dp.name)) continue;
    if (options?.visionOnly) {
      try {
        const serializers = _getSerializers();
        const caps = serializers.getProviderCapabilities?.(dp.name);
        if (caps && !caps.supportsVision) continue;
      } catch {}
    }
    count++;
  }

  // Last-resort: if count is 0, check if any factory can produce a provider
  // (ignoring blacklist/health). Matches the async getAvailableProviders logic.
  if (count === 0) {
    for (const entry of PROVIDER_TABLE) {
      if (configLoader.isProviderDisabledByDefault(entry.name)) continue;
      if (!entry.factory) continue;
      try { if (!entry.factory()) continue; } catch { continue; }
      if (isProviderRetired(entry.name)) continue;
      if (entry.name === 'Gemini' && isGeminiOnCooldown()) continue;
      count++;
      break; // Only need 1 to prevent false "no providers"
    }
  }

  // FIX: Always log diagnostic info when count is 0 (or on first call)
  // This tells us EXACTLY why no providers are available
  if (count === 0 || !_diagnosticLogged) {
    _diagnosticLogged = true;
    const log = getLog();
    const loadedCount = PROVIDER_TABLE.filter(e => e.factory !== null).length;
    log(`Provider diagnostic: ${count}/${PROVIDER_TABLE.length} available (${loadedCount} modules loaded, ${_loadFailures.length} load failures)`, count === 0 ? 'ERROR' : 'INFO', 'registry');
    for (const s of skipReasons) {
      log(`  SKIP ${s.name}: ${s.reason}`, 'DEBUG', 'registry');
    }
    for (const f of _loadFailures) {
      log(`  FAIL ${f.name}: ${f.error}`, 'ERROR', 'registry');
    }
  }

  return count;
}

// ===============================================================================
// PROVIDER DIAGNOSTIC EXPORTS (for startup health check)
// ===============================================================================

/** Log full provider diagnostic summary. Call once at startup. */
function logProviderDiagnostic(): void {
  _diagnosticLogged = false; // Force re-log
  getAvailableProviderCount();   // This now logs the diagnostic
  getLog()(`Provider modules loaded: ${PROVIDER_TABLE.filter(e => e.factory !== null).map(e => e.name).join(', ') || 'NONE'}`, _loadFailures.length > 0 ? 'WARN' : 'INFO', 'registry');
  if (_loadFailures.length > 0) {
    getLog()(`Provider modules FAILED: ${_loadFailures.map(f => `${f.name}(${f.error})`).join(', ')}`, 'ERROR', 'registry');
  }
}

/** Get load failures for external reporting (health endpoint, etc.) */
function getLoadFailures(): Array<{ name: string; error: string }> {
  return [..._loadFailures];
}

// ===============================================================================
// LEGACY COMPATIBILITY
// ===============================================================================

function getProviderCycleState() { return providerCycleState; }

module.exports = {
  getAvailableProviders,
  getAvailableProviderCount,
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
  // Diagnostic (for startup health check)
  logProviderDiagnostic,
  getLoadFailures,
  // DI
  _injectDependencies,
};
