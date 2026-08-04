'use strict';

// Provider implementations — internal sub-modules, not container-registered
const { GitHubGPTProvider } = require('./providers-github-gpt');
const { GroqProvider } = require('./providers-groq');
const { ZAIProvider } = require('./providers-zai');
const { AgnesProvider } = require('./providers-agnes');
const { NvidiaProvider } = require('./providers-nvidia');
const { CloudflareProvider } = require('./providers-cloudflare');
const { CerebrasProvider } = require('./providers-cerebras');
const { GeminiProvider } = require('./providers-gemini');
const { OpenRouterTribunalProvider } = require('./providers-openrouter-tribunal');

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getLog(): (msg: string, level?: string, _module?: string) => void {
  return _deps.logger?.log || console.log;
}

const providerCycleState = { githubRateLimitCount: 0, githubSwappedOut: false };
let cycleBlacklist = new Set<string>();
let cycleFailCounts: Record<string, number> = {};
let permanentBlacklist = new Map<string, number>();
const providerStats = new Map<string, any>();
let dynamicProviders: Array<{ name: string; fn: any }> = [];

function registerDynamicProvider(name: string, providerFn: any) { 
  dynamicProviders.push({ name, fn: providerFn });
  getLog()(`Registered dynamic provider: ${name}`, 'DEBUG', 'registry');
}

function recordProviderResult(name: string, success: boolean, latency: number) { 
  const log = getLog();
  const stats = providerStats.get(name) || { successes: 0, failures: 0, totalLatency: 0, count: 0 };
  stats.count++;
  if (success) stats.successes++; else stats.failures++;
  stats.totalLatency += latency;
  providerStats.set(name, stats);
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
    if (row) { updateProviderStats.run((row.success_count ?? 0) + (success ? 1 : 0), (row.failure_count ?? 0) + (success ? 0 : 1), (row.total_latency ?? 0) + latency, Date.now(), name); }
    else { log(`Failed to re-fetch provider row after insert: ${name}`, 'WARN', 'registry'); }
  } catch (e: any) { log(`DB error in recordProviderResult: ${e.message || e}`, 'DEBUG', 'registry'); }
}

function isProviderHealthy(name: string) { 
  const stats = providerStats.get(name);
  if (!stats || stats.count < 5) return true;
  const successRate = stats.successes / stats.count;
  const avgLatency = stats.totalLatency / stats.count;
  return successRate > 0.5 && avgLatency < 20000;
}

function resetCycleProviderState() {
  const log = getLog();
  providerCycleState.githubRateLimitCount = 0;
  providerCycleState.githubSwappedOut = false;
  cycleBlacklist = new Set();
  cycleFailCounts = {};
  dynamicProviders = [];
  log('Provider cycle state reset (GitHub GPT back, blacklist cleared)', 'INFO', 'registry');
}

function addProviderFailure(name: string) { 
  const log = getLog();
  cycleFailCounts[name] = (cycleFailCounts[name] || 0) + 1;
  if (cycleFailCounts[name] >= 2) {
    if (!cycleBlacklist.has(name)) { cycleBlacklist.add(name); log(`Blacklisting ${name} for this cycle (${cycleFailCounts[name]} failures)`, 'WARN', 'registry'); }
    permanentBlacklist.set(name, Date.now() + 3600000);
  }
}

function isProviderBlacklisted(name: string) { 
  const cooldown = permanentBlacklist.get(name);
  if (cooldown && Date.now() < cooldown) return true;
  if (cooldown) permanentBlacklist.delete(name);
  return cycleBlacklist.has(name) || !isProviderHealthy(name);
}

const retiredProviders = new Map<string, { reason: string; retiredAt: number }>();

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
}

function isProviderRetired(name: string) { 
  return retiredProviders.has(name);
}

async function getAvailableProviders() { 
  const log = getLog();
  const providers: Array<{ name: string; fn: any }> = [];
  if (providerCycleState.githubSwappedOut) {
    const zai = ZAIProvider();
    if (zai && !isProviderBlacklisted('z.ai') && !isProviderRetired('z.ai')) providers.push({ name: 'z.ai', fn: zai });
  } else {
    const github = GitHubGPTProvider();
    if (github && !isProviderBlacklisted('GitHub GPT') && !isProviderRetired('GitHub GPT')) providers.push({ name: 'GitHub GPT', fn: github });
  }
  const groq = GroqProvider(); if (groq && !isProviderBlacklisted('Groq') && !isProviderRetired('Groq')) providers.push({ name: 'Groq', fn: groq });
  const agnes = AgnesProvider(); if (agnes && !isProviderBlacklisted('Agnes') && !isProviderRetired('Agnes')) providers.push({ name: 'Agnes', fn: agnes });
  const nvidia = NvidiaProvider(); if (nvidia && !isProviderBlacklisted('NVIDIA') && !isProviderRetired('NVIDIA')) providers.push({ name: 'NVIDIA', fn: nvidia });
  const cloudflare = CloudflareProvider(); if (cloudflare && !isProviderBlacklisted('Cloudflare') && !isProviderRetired('Cloudflare')) providers.push({ name: 'Cloudflare', fn: cloudflare });
  const cerebras = CerebrasProvider(); if (cerebras && !isProviderBlacklisted('Cerebras') && !isProviderRetired('Cerebras')) providers.push({ name: 'Cerebras', fn: cerebras });
  const gemini = GeminiProvider(); if (gemini && !isProviderBlacklisted('Gemini') && !isProviderRetired('Gemini')) providers.push({ name: 'Gemini', fn: gemini });
  const openrouter = OpenRouterTribunalProvider(); if (openrouter && !isProviderBlacklisted('OpenRouter') && !isProviderRetired('OpenRouter')) providers.push({ name: 'OpenRouter', fn: openrouter });
  const hasZai = providers.some(p => p.name === 'z.ai');
  if (!hasZai) { const zai = ZAIProvider(); if (zai && !isProviderBlacklisted('z.ai') && !isProviderRetired('z.ai')) providers.push({ name: 'z.ai', fn: zai }); }
  for (const dp of dynamicProviders) { if (!isProviderBlacklisted(dp.name) && !isProviderRetired(dp.name)) { providers.push(dp); } }
  if (providers.length === 0) {
    log('No providers available! Attempting auto-discovery...', 'ERROR', 'registry');
    try {
      const { autoDiscoverModels } = require('./providers-config-loader');
      const discovered = await autoDiscoverModels();
      if (discovered.length > 0) { log(`Emergency discovery found ${discovered.length} models, but they are not registered as callable providers`, 'WARN', 'registry'); }
    } catch (_e: any) { /* non-critical, suppressed */ }
  }
  return providers;
}

function getProviderCycleState() { return providerCycleState; }

module.exports = { getAvailableProviders, addProviderFailure, resetCycleProviderState, isProviderBlacklisted, getProviderCycleState, recordProviderResult, isProviderHealthy, registerDynamicProvider, retireProvider, isProviderRetired, _injectDependencies };
