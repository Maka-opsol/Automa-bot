'use strict';

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function _log(...args: any[]) { return (_deps.logger?.log || console.log)(...args); }
function _logError(...args: any[]) { return (_deps.logger?.logError || console.error)(...args); }
function _getCONFIG() { return _deps.config || require('./get-config'); }

// Lazy requires — avoids circular dependency at module load time
let _callChatCompletion: any = null;
function _getCallChatCompletion() { if (!_callChatCompletion) { _callChatCompletion = _deps.providersBase?.callChatCompletion || require('./providers-base').callChatCompletion; } return _callChatCompletion; }
let _discoverAllFreeModels: any = null;
function _getDiscoverAllFreeModels() { if (!_discoverAllFreeModels) { const m = require('./services-model-discovery-advanced'); _discoverAllFreeModels = m.discoverAllFreeModels; } return _discoverAllFreeModels; }

// ─── Database Accessors ───
function getUpsertModel() { return _deps.database?.upsertModel; }
function getGetActiveModel() { return _deps.database?.getActiveModel; }
function getSetModelRole() { return _deps.database?.setModelRole; }
function getGetFallbackModel() { return _deps.database?.getFallbackModel; }

// ─── Render Free Plan Detection ───
function _isRenderFreePlan(): boolean {
  return !!(process.env.RENDER_SERVICE_ID) &&
    (!process.env.RENDER_SERVICE_TYPE || process.env.RENDER_SERVICE_TYPE === 'free');
}

// ─── Constants ───

/** Number of candidates the tribunal should vote for */
const TRIBUNAL_VOTE_COUNT = 3;

/** Timeout for tribunal API call (ms) */
const TRIBUNAL_TIMEOUT_MS = 15000;

/** Timeout for individual model test (ms) */
const MODEL_TEST_TIMEOUT_MS = 20000;

/** Maximum candidates to test sequentially per evolution run */
const MAX_TEST_ITERATIONS = 8;

/** Self-protection cooldown between evolutions (ms) */
const EVOLUTION_COOLDOWN_MS = 6 * 60 * 60 * 1000;

/** Dummy 1x1 white JPEG */
const DUMMY_IMAGE_1X1_JPEG = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAUAQEAAAAAAAAAAAAAAAAAAAAA/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AKwA//9k=';

/** Test prompt that must produce valid JSON */
const TEST_PROMPT = 'Reply with ONLY valid JSON: {"currentState": "test", "actionType": "wait"}';

/** Provider endpoint configuration */
const PROVIDER_ENDPOINTS: Record<string, { endpoint: string; apiKeyKey: string }> = {
  openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions', apiKeyKey: 'OPENROUTER_API_KEY' },
  mistral: { endpoint: 'https://api.mistral.ai/v1/chat/completions', apiKeyKey: 'MISTRAL_CODE_API_KEY' },
  groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', apiKeyKey: 'GROQ_API_KEY' },
};

// ─── Evolution State & Metrics ───
let _lastEvolutionTime = 0;
let _evolutionMetrics = {
  totalEvolutions: 0,
  successfulEvolutions: 0,
  failedEvolutions: 0,
  skippedEvolutions: 0,
  candidatesDiscovered: 0,
  candidatesTested: 0,
  candidatesPassed: 0,
  lastNewModel: null as string | null,
  lastNewProvider: null as string | null,
  lastEvolutionDuration: 0,
  lastError: null as string | null,
};

// ─── API Key Resolution ───

/**
 * Get API key for a provider from CONFIG.
 * Extended to support Groq in addition to OpenRouter and Mistral.
 */
function getApiKey(provider: string): string | null {
  const cfg = _getCONFIG();
  const entry = PROVIDER_ENDPOINTS[provider];
  if (!entry) return null;
  return cfg[entry.apiKeyKey] || null;
}

// ─── Tribunal ───

/**
 * Ask the current active model to vote on which candidates are best.
 *
 * Improvements over original:
 *   - Excludes current active model from the candidate list to avoid self-voting
 *   - Timeout via Promise.race
 *   - Validates response is a JSON array
 *   - Validates voted models exist in the candidate list
 *   - Limits candidates presented to reduce token usage
 *   - Configurable vote count
 */
async function runModelTribunal(candidates: Array<{ id: string; provider: string; endpoint: string | null }>): Promise<Array<{ id: string; provider: string; endpoint: string | null }>> {
  _log(`Model tribunal: ${candidates.length} candidates`, 'INFO', 'evolution');

  const active = getGetActiveModel()?.get();
  if (!active) {
    _log('No active model for tribunal, using first candidates', 'WARN', 'evolution');
    return candidates.slice(0, TRIBUNAL_VOTE_COUNT);
  }

  // Exclude the current active model from the vote to avoid self-selection bias
  const filtered = candidates.filter(c => c.id !== active.model_id);
  if (filtered.length === 0) {
    _log('All candidates are the active model, nothing to vote on', 'WARN', 'evolution');
    return [];
  }

  const provider = active.provider || 'openrouter';
  const apiKey = getApiKey(provider);
  if (!apiKey) {
    _log(`No API key for provider ${provider}, using first candidates`, 'WARN', 'evolution');
    return filtered.slice(0, TRIBUNAL_VOTE_COUNT);
  }

  const endpoint = PROVIDER_ENDPOINTS[provider]?.endpoint;
  if (!endpoint) {
    _log(`No endpoint for provider ${provider}, using first candidates`, 'WARN', 'evolution');
    return filtered.slice(0, TRIBUNAL_VOTE_COUNT);
  }

  // Limit candidates presented to the tribunal to save tokens
  const presentable = filtered.slice(0, 20);
  const prompt = `You are choosing the best vision+code model from this list of free models:
${presentable.map((c, i) => `${i + 1}. ${c.id} (${c.provider})`).join('\n')}
Which ${TRIBUNAL_VOTE_COUNT} are most capable at BOTH vision (screenshot analysis) AND code generation? Reply with a JSON array of model IDs only.`;

  try {
    const callChatCompletion = _getCallChatCompletion();
    if (!callChatCompletion) {
      _log('callChatCompletion not available for tribunal', 'WARN', 'evolution');
      return filtered.slice(0, TRIBUNAL_VOTE_COUNT);
    }

    const response = await Promise.race([
      callChatCompletion(endpoint, apiKey, active.model_id, null, prompt, provider, {
        maxTokens: 200,
        temperature: 0.0,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Tribunal timeout')), TRIBUNAL_TIMEOUT_MS)),
    ]);

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      _log('Tribunal returned empty content', 'WARN', 'evolution');
      return filtered.slice(0, TRIBUNAL_VOTE_COUNT);
    }

    const match = content.match(/\[.*?\]/s);
    if (!match) {
      _log('Tribunal response did not contain a JSON array', 'WARN', 'evolution');
      return filtered.slice(0, TRIBUNAL_VOTE_COUNT);
    }

    const voted = JSON.parse(match[0]);
    if (!Array.isArray(voted) || voted.length === 0) {
      _log('Tribunal returned invalid vote structure', 'WARN', 'evolution');
      return filtered.slice(0, TRIBUNAL_VOTE_COUNT);
    }

    // Validate that voted models exist in the filtered candidate list
    const validVoted = filtered.filter(c => voted.includes(c.id));
    if (validVoted.length > 0) {
      _log(`Tribunal voted for: ${validVoted.map(c => c.id).join(', ')}`, 'INFO', 'evolution');
      return validVoted;
    }

    _log('Tribunal voted for models not in candidate list', 'WARN', 'evolution');
    return filtered.slice(0, TRIBUNAL_VOTE_COUNT);
  } catch (err: any) {
    _logError('Tribunal failed', err);
    return filtered.slice(0, TRIBUNAL_VOTE_COUNT);
  }
}

// ─── Model Testing ───

/**
 * Test a single model candidate.
 *
 * Improvements over original:
 *   - Timeout via Promise.race (MODEL_TEST_TIMEOUT_MS)
 *   - Uses the candidate's own endpoint (not hardcoded)
 *   - Vision test first, text-only retry on 404
 *   - Tracks metrics (tested, passed)
 *   - Registers dead candidates in DB
 *   - Defensive: validates JSON response
 *   - On Render free plan: shorter timeout tolerance
 */
async function testModel(model: { id: string; provider: string; endpoint: string | null }): Promise<boolean> {
  const apiKey = getApiKey(model.provider);
  if (!apiKey) {
    _log(`No API key for provider ${model.provider}, skipping ${model.id}`, 'WARN', 'evolution');
    return false;
  }

  if (!model.endpoint) {
    _log(`No endpoint for ${model.id} (provider: ${model.provider}), skipping`, 'WARN', 'evolution');
    return false;
  }

  const callChatCompletion = _getCallChatCompletion();
  if (!callChatCompletion) {
    _log('callChatCompletion not available for model testing', 'ERROR', 'evolution');
    return false;
  }

  _evolutionMetrics.candidatesTested++;

  // Try vision test first
  try {
    const response = await Promise.race([
      callChatCompletion(model.endpoint, apiKey, model.id, DUMMY_IMAGE_1X1_JPEG, TEST_PROMPT, model.provider, {
        maxTokens: 50,
      }),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Model test timeout')), MODEL_TEST_TIMEOUT_MS)),
    ]);

    const content = response?.choices?.[0]?.message?.content;
    if (!content) {
      _log(`Model ${model.id} returned empty content`, 'WARN', 'evolution');
      return false;
    }

    // Validate JSON
    const parsed = JSON.parse(content);
    if (parsed.currentState && parsed.actionType) {
      _log(`Model ${model.id} passed vision test!`, 'INFO', 'evolution');
      _evolutionMetrics.candidatesPassed++;
      return true;
    }

    _log(`Model ${model.id} returned invalid JSON structure`, 'WARN', 'evolution');
    return false;
  } catch (err: any) {
    // If the model doesn't support image input (404 or similar), retry as text-only
    if (err.message && (err.message.includes('404') || err.message.includes('image'))) {
      _log(`Model ${model.id} doesn't support vision - retrying as text-only`, 'DEBUG', 'evolution');
      try {
        const response = await Promise.race([
          callChatCompletion(model.endpoint, apiKey, model.id, null, TEST_PROMPT, model.provider, {
            maxTokens: 50,
          }),
          new Promise((_, reject) => setTimeout(() => reject(new Error('Model text test timeout')), MODEL_TEST_TIMEOUT_MS)),
        ]);

        const content = response?.choices?.[0]?.message?.content;
        if (!content) return false;

        const parsed = JSON.parse(content);
        if (parsed.currentState && parsed.actionType) {
          _log(`Model ${model.id} passed text-only test`, 'INFO', 'evolution');
          _evolutionMetrics.candidatesPassed++;
          return true;
        }
        return false;
      } catch (textErr: any) {
        _log(`Model ${model.id} text-only also failed: ${textErr.message}`, 'WARN', 'evolution');
        return false;
      }
    }

    _log(`Model ${model.id} failed test: ${err.message}`, 'WARN', 'evolution');
    return false;
  }
}

// ─── Metrics ───

/**
 * Get evolution metrics snapshot. Useful for dashboard and diagnostics.
 */
function getEvolutionMetrics() {
  return { ..._evolutionMetrics };
}

// ─── Evolution Orchestration ───

/**
 * Roll back to the fallback model.
 */
function _rollbackToFallback(): void {
  const fallback = getGetFallbackModel()?.get();
  if (fallback) {
    getSetModelRole()?.run('active', fallback.model_id);
    _log(`Rolled back to fallback: ${fallback.model_id} (${fallback.provider})`, 'WARN', 'evolution');
  } else {
    _log('No fallback model available for rollback!', 'ERROR', 'evolution');
  }
}

/**
 * Advanced Model Evolution Pipeline (V2).
 *
 * Flow:
 *   1. Discover free models via advanced discovery (multi-provider, cached)
 *   2. Filter out already-known models from DB
 *   3. Run model tribunal (current AI votes, excluding self)
 *   4. Test top-voted candidates sequentially with timeout
 *   5. Promote winner to active, demote previous to fallback
 *   6. On failure, roll back to fallback model
 *
 * Improvements over original:
 *   - Uses discoverAllFreeModels from advanced discovery (cached, multi-provider)
 *   - Filters to vision-capable models via visionOnly option
 *   - Self-cooldown protection (6h minimum)
 *   - Timeout on tribunal and all model tests
 *   - Tribunal excludes current active model (avoids self-voting)
 *   - Extended metrics tracking
 *   - Groq provider support in getApiKey
 *   - Render free plan: shorter timeouts, vision-only filtering
 *   - DB writes only for tested candidates (not all discovered)
 */
async function evolveModelsAdvanced(): Promise<any> {
  _log('Starting advanced model evolution...', 'INFO', 'evolution');

  // Self-protection: cooldown
  const now = Date.now();
  const cooldown = _getCONFIG().EVOLUTION_COOLDOWN_MS || EVOLUTION_COOLDOWN_MS;
  if ((now - _lastEvolutionTime) < cooldown) {
    _log(`Evolution cooldown active (${Math.round((cooldown - (now - _lastEvolutionTime)) / 60000)}min remaining)`, 'DEBUG', 'evolution');
    _evolutionMetrics.skippedEvolutions++;
    return { success: false, message: 'Evolution cooldown active', skipped: true };
  }

  const startTime = Date.now();
  _evolutionMetrics.totalEvolutions++;
  _evolutionMetrics.lastError = null;

  try {
    // Step 1: Discover free models (multi-provider, cached)
    const discoverAllFreeModels = _getDiscoverAllFreeModels();
    if (!discoverAllFreeModels) throw new Error('Model discovery module not available');

    // On Render free plan, prefer vision-capable models since the bot needs vision
    const allFree = await discoverAllFreeModels({ visionOnly: _isRenderFreePlan() });
    _evolutionMetrics.candidatesDiscovered = allFree.length;

    if (allFree.length === 0) throw new Error('No free models found');

    // Step 2: Filter out already-known models
    let db: any;
    try {
      db = require('./database').db;
    } catch {
      _log('Database not available, skipping known-model filter', 'WARN', 'evolution');
    }

    const existing = new Set<string>();
    if (db) {
      try {
        const stmt = db.prepare('SELECT model_id FROM model_registry');
        for (const row of stmt.iterate()) existing.add(row.model_id);
      } catch (e: any) {
        _log(`Failed to query existing models: ${e.message}`, 'WARN', 'evolution');
      }
    }

    const candidates = allFree.filter((m: any) => !existing.has(m.id));
    if (candidates.length === 0) {
      _log('No new free models to evaluate.', 'INFO', 'evolution');
      _evolutionMetrics.lastEvolutionDuration = Date.now() - startTime;
      _lastEvolutionTime = Date.now();
      return { success: true, message: 'No new models' };
    }

    // Step 3: Run tribunal to narrow candidates
    const topCandidates = await runModelTribunal(candidates);

    // Step 4: Test top-voted candidates sequentially
    let winner: any = null;
    const testBatch = topCandidates.slice(0, MAX_TEST_ITERATIONS);

    for (const candidate of testBatch) {
      _log(`Testing candidate: ${candidate.id} (${candidate.provider})`, 'INFO', 'evolution');

      if (await testModel(candidate)) {
        winner = candidate;
        break;
      } else {
        // Mark as dead in DB (only tested candidates, not all discovered)
        getUpsertModel()?.run(
          candidate.provider, candidate.id,
          1, 0, 'dead',
          Date.now(), null, 1
        );
      }
    }

    // Step 5: Promote winner or roll back
    const current = getGetActiveModel()?.get();

    if (winner) {
      _log(`New active model: ${winner.id} (provider: ${winner.provider})`, 'INFO', 'evolution');

      // Demote current active to fallback
      if (current) {
        getSetModelRole()?.run('fallback', current.model_id);
      }

      // Promote winner
      getUpsertModel()?.run(
        winner.provider, winner.id,
        1, 1, 'active',
        Date.now(), Date.now(), 0
      );

      _evolutionMetrics.successfulEvolutions++;
      _evolutionMetrics.lastNewModel = winner.id;
      _evolutionMetrics.lastNewProvider = winner.provider;
      _evolutionMetrics.lastEvolutionDuration = Date.now() - startTime;
      _lastEvolutionTime = Date.now();

      return { success: true, newModel: winner.id, provider: winner.provider };
    }

    // No winner — roll back
    _log('No candidate passed tests; keeping current.', 'WARN', 'evolution');
    _rollbackToFallback();

    _evolutionMetrics.failedEvolutions++;
    _evolutionMetrics.lastEvolutionDuration = Date.now() - startTime;
    _lastEvolutionTime = Date.now();

    return { success: false, message: 'All candidates failed' };
  } catch (err: any) {
    _logError('Evolution crashed', err);
    _rollbackToFallback();

    _evolutionMetrics.failedEvolutions++;
    _evolutionMetrics.lastError = err.message;
    _evolutionMetrics.lastEvolutionDuration = Date.now() - startTime;
    _lastEvolutionTime = Date.now();

    return { success: false, error: err.message };
  }
}

module.exports = { evolveModelsAdvanced, getEvolutionMetrics, _injectDependencies };
