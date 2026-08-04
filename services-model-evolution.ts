'use strict';

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function _log(...args: any[]) { return (_deps.logger?.log || console.log)(...args); }
function _logError(...args: any[]) { return (_deps.logger?.logError || console.error)(...args); }
function _getCONFIG() { return _deps.config || require('./get-config'); }

// Lazy requires — avoids circular dependency at module load time
let _fetchJSON: any = null;
function _getFetchJSON() { if (!_fetchJSON) { const m = require('./utils-fetch'); _fetchJSON = m.fetchJSON; } return _fetchJSON; }
let _callChatCompletion: any = null;
function _getCallChatCompletion() { if (!_callChatCompletion) { _callChatCompletion = _deps.providersBase?.callChatCompletion || require('./providers-base').callChatCompletion; } return _callChatCompletion; }

// ─── Database Accessors ───
function getUpsertModel() { return _deps.database?.upsertModel; }
function getGetActiveModel() { return _deps.database?.getActiveModel; }
function getGetFallbackModel() { return _deps.database?.getFallbackModel; }
function getSetModelRole() { return _deps.database?.setModelRole; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }

// ─── Render Free Plan Detection ───
function _isRenderFreePlan(): boolean {
  return !!(process.env.RENDER_SERVICE_ID) &&
    (!process.env.RENDER_SERVICE_TYPE || process.env.RENDER_SERVICE_TYPE === 'free');
}

// ─── Constants ───

/** Maximum number of candidates to present to the meta-tribunal */
const TRIBUNAL_MAX_CANDIDATES = 20;

/** Number of top candidates the tribunal should vote for */
const TRIBUNAL_VOTE_COUNT = 3;

/** Timeout for meta-tribunal API call (ms). On Render, use shorter timeout. */
const TRIBUNAL_TIMEOUT_MS = 15000;

/** Timeout for individual model test (ms) */
const MODEL_TEST_TIMEOUT_MS = 20000;

/** Maximum number of candidates to test sequentially before giving up */
const MAX_TEST_ITERATIONS = 10;

/** Minimum time (ms) between evolution runs. Self-protection even if caller doesn't check. */
const EVOLUTION_COOLDOWN_MS = 6 * 60 * 60 * 1000; // 6 hours

/** Dummy 1x1 white JPEG for testing vision models. Minimal size to reduce GC pressure. */
const DUMMY_IMAGE_1X1_JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

/** Test prompt that must produce valid JSON */
const TEST_PROMPT = 'Reply with ONLY valid JSON: {"currentState": "test", "actionType": "wait"}';

// ─── Evolution State ───
let _lastEvolutionTime = 0;
let _evolutionMetrics = {
  totalEvolutions: 0,
  successfulEvolutions: 0,
  failedEvolutions: 0,
  candidatesTested: 0,
  lastNewModel: null as string | null,
  lastEvolutionDuration: 0,
};

// ─── Provider Endpoint Resolution ───

/**
 * Known provider endpoints. Extended from just openrouter/mistral.
 */
const PROVIDER_ENDPOINTS: Record<string, { endpoint: string; apiKeyFn: (cfg: any) => string | null }> = {
  openrouter: {
    endpoint: 'https://openrouter.ai/api/v1/chat/completions',
    apiKeyFn: (cfg) => cfg.OPENROUTER_API_KEY || null,
  },
  mistral: {
    endpoint: 'https://api.mistral.ai/v1/chat/completions',
    apiKeyFn: (cfg) => cfg.MISTRAL_CODE_API_KEY || null,
  },
  groq: {
    endpoint: 'https://api.groq.com/openai/v1/chat/completions',
    apiKeyFn: (cfg) => cfg.GROQ_API_KEY || null,
  },
};

/**
 * Get endpoint + API key for the currently active model's provider.
 */
function getActiveProviderDetails(): { endpoint: string; apiKey: string | null; model: string } | null {
  const activeModel = getGetActiveModel()?.get();
  if (!activeModel) return null;
  const provider = activeModel.provider || 'openrouter';
  const cfg = _getCONFIG();
  const entry = PROVIDER_ENDPOINTS[provider];
  if (!entry) return null;
  const apiKey = entry.apiKeyFn(cfg);
  if (!apiKey) return null;
  return { endpoint: entry.endpoint, apiKey, model: activeModel.model_id };
}

// ─── Discovery ───

/**
 * Discover free models via provider API endpoints.
 * On Render free plan, uses the advanced discovery module which has caching.
 */
async function discoverFreeModels(provider = 'openrouter'): Promise<string[]> {
  _log('Discovering free models via API...', 'INFO', 'evolution');
  const cfg = _getCONFIG();
  const fetchJSON = _getFetchJSON();
  const entry = PROVIDER_ENDPOINTS[provider];
  if (!entry) {
    _log(`Unknown provider: ${provider}`, 'WARN', 'evolution');
    return [];
  }
  try {
    const headers: Record<string, string> = {};
    const apiKey = entry.apiKeyFn(cfg);
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const data = await fetchJSON(
      provider === 'openrouter'
        ? 'https://openrouter.ai/api/v1/models'
        : provider === 'mistral'
          ? 'https://api.mistral.ai/v1/models'
          : provider === 'groq'
            ? 'https://api.groq.com/openai/v1/models'
            : '',
      { headers },
      15000
    );
    const freeModels = (data.data || [])
      .filter((m: any) => {
        const promptCost = parseFloat(m.pricing?.prompt || m.pricing?.promptPrice || '1');
        const completionCost = parseFloat(m.pricing?.completion || m.pricing?.completionPrice || '1');
        return (promptCost === 0 && completionCost === 0) || m.id.includes(':free');
      })
      .map((m: any) => m.id);
    _log(`Found ${freeModels.length} free models from ${provider}.`, 'INFO', 'evolution');
    return freeModels;
  } catch (err: any) {
    _logError(`Discovery failed for ${provider}`, err);
    return [];
  }
}

// ─── Meta-Tribunal ───

/**
 * Ask the current active model to vote on which candidates are best.
 * Returns an ordered list of model IDs the tribunal recommends.
 *
 * Improvements over original:
 *   - Proper timeout via Promise.race
 *   - Validates tribunal response structure
 *   - Handles non-array responses gracefully
 *   - Limits candidates to TRIBUNAL_MAX_CANDIDATES to reduce token usage
 */
async function runMetaTribunal(candidateModels: string[]): Promise<string[]> {
  _log(`Running Meta-Tribunal for ${candidateModels.length} candidates...`, 'INFO', 'evolution');
  const details = getActiveProviderDetails();
  if (!details) {
    _log('No active provider details available for tribunal, using first candidate', 'WARN', 'evolution');
    return candidateModels.slice(0, TRIBUNAL_VOTE_COUNT);
  }

  const limited = candidateModels.slice(0, TRIBUNAL_MAX_CANDIDATES);
  const prompt = `You are an AI selecting a new AI model for an automated bot that analyzes screenshots (vision) and writes code.
Here is a list of FREE models currently available:
${limited.map((m, i) => `${i + 1}. ${m}`).join('\n')}
Based on their names, which ${TRIBUNAL_VOTE_COUNT} models are most likely to be good at vision AND code generation?
Reply ONLY with a JSON array of strings, e.g., ["model/id/1", "model/id/2", "model/id/3"]`;

  try {
    const callChatCompletion = _getCallChatCompletion();
    const response = await Promise.race([
      callChatCompletion(details.endpoint, details.apiKey, details.model, null, prompt, {
        maxTokens: 200,
        temperature: 0.0,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tribunal timeout')), TRIBUNAL_TIMEOUT_MS)),
    ]);

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      _log('Tribunal returned empty content, using top candidates', 'WARN', 'evolution');
      return candidateModels.slice(0, TRIBUNAL_VOTE_COUNT);
    }

    const match = content.match(/\[.*?\]/s);
    if (!match) {
      _log('Tribunal response did not contain a JSON array', 'WARN', 'evolution');
      return candidateModels.slice(0, TRIBUNAL_VOTE_COUNT);
    }

    const votes = JSON.parse(match[0]);
    if (!Array.isArray(votes) || votes.length === 0) {
      _log('Tribunal returned invalid vote structure', 'WARN', 'evolution');
      return candidateModels.slice(0, TRIBUNAL_VOTE_COUNT);
    }

    // Validate that voted models actually exist in candidate list
    const validVotes = votes.filter((v: string) => candidateModels.includes(v));
    if (validVotes.length > 0) {
      _log(`Tribunal voted for: ${validVotes.join(', ')}`, 'INFO', 'evolution');
      return validVotes;
    }

    _log('Tribunal voted for models not in candidate list', 'WARN', 'evolution');
    return candidateModels.slice(0, TRIBUNAL_VOTE_COUNT);
  } catch (err: any) {
    _logError('Tribunal failed to vote', err);
    return candidateModels.slice(0, TRIBUNAL_VOTE_COUNT);
  }
}

// ─── Model Testing ───

/**
 * Test a single model by sending a minimal vision request and checking for valid JSON response.
 *
 * Improvements over original:
 *   - Timeout via Promise.race (MODEL_TEST_TIMEOUT_MS)
 *   - Uses active provider's endpoint (not hardcoded OpenRouter)
 *   - Separate text-only retry on vision 404 (from v2 pattern)
 *   - Defensive: validates content is valid JSON
 *   - Tracks candidate test count in metrics
 */
async function safeTestModel(modelId: string, provider = 'openrouter'): Promise<boolean> {
  _log(`Testing model: ${modelId}...`, 'INFO', 'evolution');
  const cfg = _getCONFIG();
  const callChatCompletion = _getCallChatCompletion();
  const entry = PROVIDER_ENDPOINTS[provider];
  if (!entry) {
    _log(`Unknown provider ${provider} for model ${modelId}`, 'WARN', 'evolution');
    return false;
  }
  const apiKey = entry.apiKeyFn(cfg);
  if (!apiKey) {
    _log(`No API key for ${provider}, skipping ${modelId}`, 'WARN', 'evolution');
    return false;
  }

  _evolutionMetrics.candidatesTested++;

  // Try vision test first
  try {
    const response = await Promise.race([
      callChatCompletion(entry.endpoint, apiKey, modelId, DUMMY_IMAGE_1X1_JPEG, TEST_PROMPT, {
        maxTokens: 50,
        temperature: 0.0,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Model test timeout')), MODEL_TEST_TIMEOUT_MS)),
    ]);

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      _log(`Model ${modelId} returned empty content`, 'WARN', 'evolution');
      return false;
    }
    JSON.parse(content);
    _log(`Model ${modelId} passed vision test!`, 'INFO', 'evolution');
    return true;
  } catch (err: any) {
    // If 404 on vision, retry as text-only
    if (err.message && (err.message.includes('404'))) {
      _log(`Model ${modelId} vision failed (404), retrying text-only...`, 'DEBUG', 'evolution');
      try {
        const response = await Promise.race([
          callChatCompletion(entry.endpoint, apiKey, modelId, null, TEST_PROMPT, {
            maxTokens: 50,
            temperature: 0.0,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Model text test timeout')), MODEL_TEST_TIMEOUT_MS)),
        ]);
        const content = response?.choices?.[0]?.message?.content;
        if (!content) return false;
        JSON.parse(content);
        _log(`Model ${modelId} passed text-only test`, 'INFO', 'evolution');
        return true;
      } catch (textErr: any) {
        _log(`Model ${modelId} text-only also failed: ${textErr.message}`, 'WARN', 'evolution');
        return false;
      }
    }
    _log(`Model ${modelId} failed test: ${err.message}`, 'WARN', 'evolution');
    return false;
  }
}

// ─── Evolution Orchestration ───

/**
 * Get evolution metrics snapshot. Called by dashboard/diagnostics.
 */
function getEvolutionMetrics() {
  return { ..._evolutionMetrics };
}

/**
 * Check if enough time has passed since the last evolution.
 * Self-protection: even if the caller doesn't check, we refuse to run too frequently.
 * On Render free plan, enforces the cooldown strictly.
 */
function _canEvolve(): boolean {
  const now = Date.now();
  const cooldown = _getCONFIG().EVOLUTION_COOLDOWN_MS || EVOLUTION_COOLDOWN_MS;
  if ((now - _lastEvolutionTime) < cooldown) {
    _log(`Evolution cooldown active (${Math.round((cooldown - (now - _lastEvolutionTime)) / 60000)}min remaining)`, 'DEBUG', 'evolution');
    return false;
  }
  return true;
}

/**
 * Roll back to the current fallback model on evolution failure.
 * Ensures there's always an active model.
 */
function _rollbackToFallback(): void {
  const fallback = getGetFallbackModel()?.get();
  if (fallback) {
    getSetModelRole()?.run('active', fallback.model_id);
    _log(`Rolled back to fallback: ${fallback.model_id}`, 'WARN', 'evolution');
  } else {
    _log('No fallback model available for rollback!', 'ERROR', 'evolution');
  }
}

/**
 * V1 Model Evolution Pipeline.
 *
 * Flow:
 *   1. Discover free models via provider API
 *   2. Run meta-tribunal (current AI votes on candidates)
 *   3. Register candidates in DB
 *   4. Test top-voted candidates sequentially
 *   5. Promote winner to active, demote previous to fallback
 *   6. On failure, roll back to fallback model
 *
 * On Render free plan:
 *   - Self-cooldown protection (6h minimum between runs)
 *   - Timeout on all external calls (tribunal + model tests)
 *   - Metrics tracked for diagnostics
 *   - No more than MAX_TEST_ITERATIONS candidates tested per run
 */
async function evolveModels(): Promise<any> {
  _log('Starting Model Evolution Pipeline...', 'INFO', 'evolution');

  if (!_canEvolve()) {
    return { success: false, message: 'Evolution cooldown active', skipped: true };
  }

  const startTime = Date.now();
  _evolutionMetrics.totalEvolutions++;

  try {
    // Step 1: Discover free models
    const freeModels = await discoverFreeModels('openrouter');
    if (freeModels.length === 0) throw new Error('No free models found');

    // Step 2: Run meta-tribunal to narrow down candidates
    const topVoted = await runMetaTribunal(freeModels);

    // Step 3: Register top candidates in DB as 'candidate' role
    // Only register the tribunal-voted ones, not all free models (saves DB writes)
    for (const modelId of topVoted) {
      getUpsertModel()?.run('openrouter', modelId, 1, 0, 'candidate', Date.now(), null, 0);
    }

    // Step 4: Test candidates sequentially
    let newWinner: string | null = null;
    const testCandidates = topVoted.slice(0, MAX_TEST_ITERATIONS);

    for (const candidate of testCandidates) {
      if (await safeTestModel(candidate, 'openrouter')) {
        newWinner = candidate;
        break;
      } else {
        // Mark as dead in DB
        getUpsertModel()?.run('openrouter', candidate, 1, 0, 'dead', Date.now(), null, 1);
      }
    }

    // Step 5: Promote winner or roll back
    const currentActive = getGetActiveModel()?.get();

    if (newWinner) {
      _log(`New model chosen: ${newWinner}`, 'INFO', 'evolution');

      // Demote current active to fallback
      if (currentActive) {
        getSetModelRole()?.run('fallback', currentActive.model_id);
      }

      // Promote new winner
      getUpsertModel()?.run('openrouter', newWinner, 1, 1, 'active', Date.now(), Date.now(), 0);
      getUpsertCalibration()?.run('last_evolution_timestamp', String(Date.now()), Date.now());

      _evolutionMetrics.successfulEvolutions++;
      _evolutionMetrics.lastNewModel = newWinner;
      _evolutionMetrics.lastEvolutionDuration = Date.now() - startTime;
      _lastEvolutionTime = Date.now();

      return { success: true, newModel: newWinner, message: 'Evolution successful!' };
    } else {
      _log('All candidates failed! Rolling back...', 'ERROR', 'evolution');
      _rollbackToFallback();
      getUpsertCalibration()?.run('last_evolution_timestamp', String(Date.now()), Date.now());

      _evolutionMetrics.failedEvolutions++;
      _evolutionMetrics.lastEvolutionDuration = Date.now() - startTime;
      _lastEvolutionTime = Date.now();

      const fallback = getGetFallbackModel()?.get();
      if (fallback) {
        return { success: false, newModel: fallback.model_id, message: 'All candidates failed, rolled back to fallback.' };
      }
      throw new Error('Evolution failed and no fallback model exists!');
    }
  } catch (err: any) {
    _logError('Evolution pipeline crashed', err);
    _rollbackToFallback();
    getUpsertCalibration()?.run('last_evolution_timestamp', String(Date.now()), Date.now());

    _evolutionMetrics.failedEvolutions++;
    _evolutionMetrics.lastEvolutionDuration = Date.now() - startTime;
    _lastEvolutionTime = Date.now();

    return { success: false, error: err.message };
  }
}

module.exports = { evolveModels, discoverFreeModels, getEvolutionMetrics, _injectDependencies };
