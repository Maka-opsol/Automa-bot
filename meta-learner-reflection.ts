'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }
function getCallChatCompletion() { return _deps.providersBase?.callChatCompletion || require('./providers-base').callChatCompletion; }
function getGetActiveModel() { return _deps.database?.getActiveModel; }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');
const { applySuggestion } = require('./meta-learner-suggestion-applier');
const { validateSuggestion } = require('./meta-learner-suggestion-validator');

const REFLECTION_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_SUGGESTIONS_PER_RUN = 3;
const MIN_ENTRIES_FOR_REFLECTION = 50;

let lastReflectionTime = 0;
let isReflectionRunning = false;

async function runReflection() { 
  // Response 3: skip reflection at degradation level 1+ (REDUCED)
  try {
    const { degradationLadder } = require('./self-heal-degradation-ladder');
    if (degradationLadder.shouldSkip('meta-learner-reflection')) {
      return; // silently skip
    }
  } catch {}
  if (isReflectionRunning) {
    log('Reflection already running, skipping', 'DEBUG', 'reflection');
    return;
  }
  const now = Date.now();
  if (now - lastReflectionTime < REFLECTION_INTERVAL_MS && lastReflectionTime > 0) {
    return;
  }
  isReflectionRunning = true;
  try {
    log('🧠 Starting self-reflection cycle...', 'INFO', 'reflection');
    const entries = await fetchRecentEntries();
    if (entries.length < MIN_ENTRIES_FOR_REFLECTION) {
      log(`Only ${entries.length} entries, need ${MIN_ENTRIES_FOR_REFLECTION}, skipping`, 'DEBUG', 'reflection');
      return;
    }
    const analysis = await analyzeEntries(entries);
    if (!analysis || !analysis.suggestions || analysis.suggestions.length === 0) {
      log('No actionable suggestions from reflection', 'INFO', 'reflection');
      return;
    }
    const validated = await validateSuggestions(analysis.suggestions);
    for (const suggestion of validated.slice(0, MAX_SUGGESTIONS_PER_RUN)) {
      const applied = await applySuggestion(suggestion);
      if (applied) {
        log(`Applied suggestion: ${suggestion.description}`, 'INFO', 'reflection');
        await logSuggestionOutcome(suggestion, true);
      } else {
        log(`Failed to apply suggestion: ${suggestion.description}`, 'WARN', 'reflection');
        await logSuggestionOutcome(suggestion, false);
      }
    }
    lastReflectionTime = Date.now();
  } catch (err: any) {
    logError('Self-reflection failed', err);
  } finally {
    isReflectionRunning = false;
  }
}

async function fetchRecentEntries(limit = 500) { 
  try {
    const stmt = getDb()?.prepare(`
      SELECT id, timestamp, state, action, success, reasoning, latency, provider_used, screenshot_hash
      FROM blackbox
      ORDER BY timestamp DESC
      LIMIT ?
    `);
    return stmt.all(limit);
  } catch (err: any) {
    logError('Failed to fetch blackbox entries for reflection', err);
    return [];
  }
}

async function analyzeEntries(entries: any) { 
  const summary = buildSummary(entries);
  const activeModel = getGetActiveModel()?.get();
  const modelId = activeModel ? activeModel.model_id : 'openrouter/free';
  const provider = activeModel ? activeModel.provider : 'openrouter';
  let endpoint, apiKey;
  if (provider === 'openrouter') {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    apiKey = CONFIG.OPENROUTER_API_KEY;
  } else if (provider === 'mistral') {
    endpoint = 'https://api.mistral.ai/v1/chat/completions';
    apiKey = CONFIG.MISTRAL_CODE_API_KEY;
  } else {
    endpoint = 'https://openrouter.ai/api/v1/chat/completions';
    apiKey = CONFIG.OPENROUTER_API_KEY;
  }
  if (!apiKey) {
    log('No API key for reflection analysis', 'WARN', 'reflection');
    return null;
  }
  const prompt = `
You are an expert system analyst reviewing logs of an autonomous web automation bot (MathU Bot).

SUMMARY OF RECENT ACTIVITY:
- Total actions: ${summary.totalActions}
- Success rate: ${summary.successRate}%
- Average latency: ${summary.avgLatency}ms
- Most common state: ${summary.mostCommonState}
- Most common action: ${summary.mostCommonAction}
- Failure reasons: ${summary.failureReasons.join('; ')}

RECENT ENTRIES (sample):
${entries.slice(0, 30).map((e: any) => `- ${e.timestamp}: ${e.state} -> ${e.action} (success: ${e.success}, latency: ${e.latency}ms, reasoning: ${e.reasoning || 'none'})`).join('\n')}

Based on this data, identify:
1. Recurring failure patterns
2. Slow operations that could be optimised
3. UI elements or selectors that might have changed
4. Opportunities for improved prompts or state transitions

Return a JSON object with:
{
  "findings": ["finding1", "finding2"],
  "suggestions": [
    {
      "type": "selector_update" | "prompt_update" | "transition_update" | "config_tweak" | "action_change",
      "file": "relative/path/to/file.js",
      "description": "Human-readable description",
      "patch": "The actual code change (diff or replacement)",
      "priority": 1-5
    }
  ]
}
`;
  try {
    const response = await getCallChatCompletion()(endpoint, apiKey, modelId, null, prompt, {
      maxTokens: 2048,
      temperature: 0.3,
      responseFormat: { type: 'json_object' },
    });
    const content = response.choices?.[0]?.message?.content;
    if (!content) throw new Error('Empty response from reflection model');
    return JSON.parse(content);
  } catch (err: any) {
    logError('Failed to analyze entries', err);
    return null;
  }
}

function buildSummary(entries: any) { 
  const totalActions = entries.length;
  const successes = entries.filter((e: any) => e.success === 1).length;
  const successRate = totalActions > 0 ? (successes / totalActions * 100) : 0;
  const latencies = entries.map((e: any) => e.latency || 0).filter((l: any) => l > 0);
  const avgLatency = latencies.length > 0 ? latencies.reduce((a: any, b: any) => a + b, 0) / latencies.length : 0;
  const stateCounts = {};
  const actionCounts = {};
  const failureReasons = [];
  for (const e of entries) {
    (stateCounts as any)[e.state] = ((stateCounts as any)[e.state] || 0) + 1;
    (actionCounts as any)[e.action] = ((actionCounts as any)[e.action] || 0) + 1;
    if (e.success === 0 && e.reasoning) {
      failureReasons.push(e.reasoning);
    }
  }
  let mostCommonState = 'unknown';
  let maxStateCount = 0;
  for (const [state, count] of Object.entries(stateCounts) as any[]) {
    if (count > maxStateCount) { maxStateCount = count; mostCommonState = state; }
  }
  let mostCommonAction = 'unknown';
  let maxActionCount = 0;
  for (const [action, count] of Object.entries(actionCounts) as any[]) {
    if (count > maxActionCount) { maxActionCount = count; mostCommonAction = action; }
  }
  return {
    totalActions,
    successRate: successRate.toFixed(1),
    avgLatency: avgLatency.toFixed(0),
    mostCommonState,
    mostCommonAction,
    failureReasons: failureReasons.slice(0, 10),
  };
}

async function validateSuggestions(suggestions: any) { 
  const validated = [];
  for (const suggestion of suggestions) {
    const isValid = await validateSuggestion(suggestion);
    if (isValid) {
      validated.push(suggestion);
    } else {
      log(`Suggestion failed validation: ${suggestion.description}`, 'WARN', 'reflection');
    }
  }
  return validated;
}

async function logSuggestionOutcome(suggestion: any, success: any) { 
  try {
    getDb()?.prepare(`
      INSERT INTO reflection_history (timestamp, suggestion_type, description, file, success)
      VALUES(?, ?, ?, ?, ?)
    `).run(Date.now(), suggestion.type, suggestion.description, suggestion.file, success ? 1 : 0);
  } catch (err: any) {
    logError('Failed to log suggestion outcome', err);
  }
}

function startReflectionScheduler() { 
  const interval = setInterval(() => {
    runReflection().catch(err => logError('Scheduled reflection failed', err));
  }, REFLECTION_INTERVAL_MS);
  if (interval.unref) interval.unref();
  setTimeout(() => {
    runReflection().catch(err => logError('Initial reflection failed', err));
  }, 60000).unref();
  log('Self-reflection scheduler started', 'INFO', 'reflection');
}

module.exports = {
  runReflection,
  startReflectionScheduler,
  _injectDependencies,
};
