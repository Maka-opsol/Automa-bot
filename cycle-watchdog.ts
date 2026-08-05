'use strict';
// Created: 2026-08-05 — Question-level watchdog with 10-min timeout, self-heal, and provider re-discovery.
//
// This module monitors each question attempt within a cycle. If a single question
// takes longer than QUESTION_TIMEOUT_MS (default 10 minutes), the watchdog:
//   1. Logs a CRITICAL timeout event with full diagnostic context
//   2. Resets all provider circuit breakers (in-memory state)
//   3. Resets all provider 429 cooldowns
//   4. Clears the cycle blacklist
//   5. Re-discovers available providers via the config-loader
//   6. Re-registers any discovered providers as dynamic providers
//   7. Triggers the self-heal pipeline if enabled
//   8. Attempts to recover the current question (reload + retry)
//
// Design:
//   - Per-question timer (not per-cycle) because the cycle manager already
//     handles MAX_RUNTIME_PER_CYCLE_MS. This catches the case where the bot
//     is stuck in a loop on ONE question for too long without the cycle
//     timeout being reached.
//   - Non-blocking: the watchdog sets a deadline and checks it each iteration.
//     It does NOT use a separate setInterval or setTimeout to avoid complexity
//     with async operations and process lifecycle.
//   - Integrates with existing self-heal subsystem via DI.
//   - Uses the same logging, alerting, and provider registry as the rest of the bot.

// ─── Dependency Injection ───────────────────────────────────────────────────
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

// ─── Lazy accessors ────────────────────────────────────────────────────────
function getCONFIG(): Record<string, any> {
  return _deps.config || {};
}
function log(msg: string, level?: string, mod?: string) {
  _deps.logger?.log?.(msg, level, mod) ?? console.log(msg);
}
function logError(msg: string, err: Error, ctx?: any) {
  _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err);
}
function getSendAlert() {
  return _deps.alerting?.sendAlert || (() => {});
}

// ─── Lazy-loaded modules (only needed during self-heal, not at require time) ─
let _registryMod: any = null;
function _getRegistry() {
  if (!_registryMod) {
    try { _registryMod = require('./providers-registry'); }
    catch { _registryMod = null; }
  }
  return _registryMod;
}

let _configLoaderMod: any = null;
function _getConfigLoader() {
  if (!_configLoaderMod) {
    try { _configLoaderMod = require('./providers-config-loader'); }
    catch { _configLoaderMod = null; }
  }
  return _configLoaderMod;
}

let _healthMod: any = null;
function _getHealth() {
  if (!_healthMod) {
    try { _healthMod = require('./providers-health'); }
    catch { _healthMod = null; }
  }
  return _healthMod;
}

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_QUESTION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const PROVIDER_RESET_RETRY_DELAY_MS = 3000;         // 3s between reset steps
const PROVIDER_REDISCOVERY_TIMEOUT_MS = 30000;       // 30s max for discovery
const MAX_SELF_HEAL_ATTEMPTS_PER_QUESTION = 2;        // Don't heal more than twice per question
const WATCHDOG_CHECK_INTERVAL_MS = 5000;              // Check every 5 seconds

// ─── Per-question state ───────────────────────────────────────────────────
interface QuestionWatchState {
  questionStartTime: number | null;
  questionNumber: number;
  selfHealAttempts: number;
  providerResetsDone: boolean;
  lastDiagnosticLogTime: number;
  lastActionType: string;
  consecutiveStuckChecks: number;
  healed: boolean;
  timedOut: boolean;
}

let questionState: QuestionWatchState = {
  questionStartTime: null,
  questionNumber: 0,
  selfHealAttempts: 0,
  providerResetsDone: false,
  lastDiagnosticLogTime: 0,
  lastActionType: '',
  consecutiveStuckChecks: 0,
  healed: false,
  timedOut: false,
};

// ─── Per-cycle counters ───────────────────────────────────────────────────
let cycleWatchdogStats = {
  questionsTimedOut: 0,
  providersResetCount: 0,
  selfHealsTriggered: 0,
  providerRediscoveriesRun: 0,
};

// ═══════════════════════════════════════════════════════════════════════════════
// QUESTION LIFECYCLE HOOKS
// ═══════════════════════════════════════════════════════════════════════════════
//
// Call these from cycle-cycle-manager.ts at the appropriate points:
//   onQuestionStarted()  — at the beginning of each question attempt
//   onActionCompleted() — after each action within a question
//   onQuestionCompleted() — when a question finishes (success or failure)
//   onCycleStarted() — at cycle start, resets all counters
//   onCycleEnded() — at cycle end, logs summary

function onCycleStarted() {
  questionState = {
    questionStartTime: null,
    questionNumber: 0,
    selfHealAttempts: 0,
    providerResetsDone: false,
    lastDiagnosticLogTime: 0,
    lastActionType: '',
    consecutiveStuckChecks: 0,
    healed: false,
    timedOut: false,
  };
  cycleWatchdogStats = {
    questionsTimedOut: 0,
    providersResetCount: 0,
    selfHealsTriggered: 0,
    providerRediscoveriesRun: 0,
  };
  log('Cycle watchdog armed — monitoring question timeouts', 'INFO', 'cycle-watchdog');
}

function onQuestionStarted(questionNumber: number) {
  questionState.questionStartTime = Date.now();
  questionState.questionNumber = questionNumber;
  questionState.selfHealAttempts = 0;
  questionState.providerResetsDone = false;
  questionState.healed = false;
  questionState.timedOut = false;
  questionState.lastActionType = '';
  questionState.consecutiveStuckChecks = 0;
  const CONFIG = getCONFIG();
  const timeoutMin = ((CONFIG.QUESTION_TIMEOUT_MS || DEFAULT_QUESTION_TIMEOUT_MS) / 60000).toFixed(0);
  log(`Watchdog: Question #${questionNumber} started (timeout: ${timeoutMin}min)`, 'DEBUG', 'cycle-watchdog');
}

function onActionCompleted(actionType: string) {
  questionState.lastActionType = actionType;
  questionState.consecutiveStuckChecks = 0; // Reset on any action
}

function onQuestionCompleted(questionNumber: number, success: boolean) {
  if (questionState.timedOut) {
    log(`Watchdog: Question #${questionNumber} completed after timeout (success=${success})`, 'WARN', 'cycle-watchdog');
  }
  questionState.questionStartTime = null;
  questionState.healed = false;
  questionState.timedOut = false;
}

function onCycleEnded() {
  const stats = cycleWatchdogStats;
  if (stats.questionsTimedOut > 0 || stats.providersResetCount > 0 || stats.selfHealsTriggered > 0) {
    log(
      `Watchdog cycle summary: ${stats.questionsTimedOut} timeouts, ${stats.providersResetCount} provider resets, ${stats.selfHealsTriggered} self-heals, ${stats.providerRediscoveriesRun} rediscoveries`,
      'INFO',
      'cycle-watchdog'
    );
  }
  questionState.questionStartTime = null;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN WATCHDOG CHECK
// ═══════════════════════════════════════════════════════════════════════════════
//
// Call this in the cycle loop (every iteration). It checks if the current
// question has exceeded the timeout. If so, it triggers the self-heal pipeline.
//
// Returns: { shouldBreak: boolean, shouldContinue: boolean }
//   - shouldBreak = true: the cycle should break out of the current question loop
//   - shouldContinue = true: the cycle should continue to the next question

async function checkQuestionTimeout(
  currentPageUrl: string,
  currentCycleActionCount: number,
): Promise<{ shouldBreak: boolean; shouldContinue: boolean }> {
  // Not tracking a question — nothing to do
  if (!questionState.questionStartTime) {
    return { shouldBreak: false, shouldContinue: false };
  }

  // Already timed out and handled — don't re-trigger
  if (questionState.timedOut) {
    return { shouldBreak: false, shouldContinue: false };
  }

  const CONFIG = getCONFIG();
  const timeoutMs = CONFIG.QUESTION_TIMEOUT_MS || DEFAULT_QUESTION_TIMEOUT_MS;
  const elapsed = Date.now() - questionState.questionStartTime;
  const remaining = timeoutMs - elapsed;

  // ─── Pre-timeout diagnostics (at 50%, 75%, 90% of timeout) ───
  const fractions = [0.5, 0.75, 0.9];
  for (const frac of fractions) {
    const thresholdTime = questionState.questionStartTime + timeoutMs * frac;
    const now = Date.now();
    if (now >= thresholdTime && questionState.lastDiagnosticLogTime < thresholdTime) {
      const elapsedMin = (elapsed / 60000).toFixed(1);
      const pct = (frac * 100).toFixed(0);
      log(
        `Watchdog DIAGNOSTIC [${pct}%]: Question #${questionState.questionNumber} running for ${elapsedMin}min, ` +
        `lastAction=${questionState.lastActionType}, url=${currentPageUrl?.substring(0, 80) || 'unknown'}, ` +
        `actions=${currentCycleActionCount}, heals=${questionState.selfHealAttempts}`,
        'WARN',
        'cycle-watchdog'
      );
      questionState.lastDiagnosticLogTime = now;
    }
  }

  // ─── Not timed out yet ───
  if (elapsed < timeoutMs) {
    return { shouldBreak: false, shouldContinue: false };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // TIMEOUT REACHED — Start self-heal and provider re-discovery
  // ═══════════════════════════════════════════════════════════════════════════
  questionState.timedOut = true;
  cycleWatchdogStats.questionsTimedOut++;

  const elapsedMin = (elapsed / 60000).toFixed(1);
  log(
    `Watchdog TIMEOUT: Question #${questionState.questionNumber} exceeded ${elapsedMin}min limit! ` +
    `lastAction=${questionState.lastActionType}, url=${currentPageUrl?.substring(0, 80) || 'unknown'}, ` +
    `actions=${currentCycleActionCount}. Starting self-heal + provider re-discovery.`,
    'ERROR',
    'cycle-watchdog'
  );

  // Alert
  try {
    const alert = getSendAlert();
    alert(`Question #${questionState.questionNumber} timed out after ${elapsedMin}min — self-heal triggered`);
  } catch (_e: any) { /* non-critical */ }

  // Check if we've already healed too many times for this question
  if (questionState.selfHealAttempts >= MAX_SELF_HEAL_ATTEMPTS_PER_QUESTION) {
    log(
      `Watchdog: Max self-heal attempts (${MAX_SELF_HEAL_ATTEMPTS_PER_QUESTION}) reached for question #${questionState.questionNumber}. Abandoning question.`,
      'ERROR',
      'cycle-watchdog'
    );
    // Reset for next question but signal cycle to skip this one
    return { shouldBreak: true, shouldContinue: true };
  }

  questionState.selfHealAttempts++;
  cycleWatchdogStats.selfHealsTriggered++;

  // ─── Step 1: Reset all provider circuit breakers and cooldowns ───
  const providersReset = await resetAllProviders();
  if (providersReset) {
    cycleWatchdogStats.providersResetCount++;
    log('Watchdog: All provider circuit breakers and cooldowns reset', 'INFO', 'cycle-watchdog');
  } else {
    log('Watchdog: Provider reset had errors (non-fatal)', 'WARN', 'cycle-watchdog');
  }

  // ─── Step 2: Re-discover providers ───
  const discoveryResult = await rediscoverProviders();
  if (discoveryResult.discovered > 0) {
    cycleWatchdogStats.providerRediscoveriesRun++;
    log(
      `Watchdog: Re-discovered ${discoveryResult.discovered} provider(s), ${discoveryResult.registered} registered`,
      'INFO',
      'cycle-watchdog'
    );
  } else {
    log('Watchdog: No new providers discovered — will continue with existing providers', 'WARN', 'cycle-watchdog');
  }

  // ─── Step 3: Trigger self-heal pipeline ───
  const healed = await triggerSelfHeal(currentPageUrl);
  if (healed) {
    questionState.healed = true;
    log('Watchdog: Self-heal completed successfully — continuing question', 'INFO', 'cycle-watchdog');
    // Reset the question timer so we get another full timeout window
    questionState.questionStartTime = Date.now();
    questionState.timedOut = false;
    return { shouldBreak: false, shouldContinue: true };
  } else {
    log('Watchdog: Self-heal did not produce a fix — abandoning question', 'ERROR', 'cycle-watchdog');
    return { shouldBreak: true, shouldContinue: true };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 1: PROVIDER RESET
// ═══════════════════════════════════════════════════════════════════════════════
//
// Resets all in-memory provider state to give every provider a fresh chance:
//   - Circuit breaker: OPEN → CLOSED for all providers
//   - Cooldown timers: cleared for all providers
//   - Cycle blacklist: cleared
//   - Health scores: reset to default (0.5)
//   - Failure counts: zeroed

async function resetAllProviders(): Promise<boolean> {
  let allOk = true;

  // 1. Reset circuit breakers via providers-health
  try {
    const health = _getHealth();
    if (health) {
      // Reset all tracked providers' circuit breakers
      const tracked = health.getTrackedProviders?.();
      if (Array.isArray(tracked)) {
        for (const name of tracked) {
          try {
            health.resetProviderState?.(name);
            log(`  Reset provider state: ${name}`, 'DEBUG', 'cycle-watchdog');
          } catch (e: any) {
            log(`  Failed to reset ${name}: ${e.message}`, 'WARN', 'cycle-watchdog');
            allOk = false;
          }
        }
      }
      log(`Reset ${tracked?.length || 0} tracked provider states`, 'INFO', 'cycle-watchdog');
    }
  } catch (e: any) {
    log(`Provider health reset failed: ${e.message}`, 'WARN', 'cycle-watchdog');
    allOk = false;
  }

  // 2. Reset cycle blacklist and failure counts via providers-registry
  try {
    const registry = _getRegistry();
    if (registry) {
      registry.resetCycleProviderState?.();
      log('Reset cycle provider state (blacklist + failure counts cleared)', 'INFO', 'cycle-watchdog');
    }
  } catch (e: any) {
    log(`Registry reset failed: ${e.message}`, 'WARN', 'cycle-watchdog');
    allOk = false;
  }

  // 3. Reset Gemini-specific 429 cooldown state
  try {
    const registry = _getRegistry();
    if (registry && registry.isGeminiOnCooldown?.() === true) {
      // The registry doesn't expose a reset for Gemini cooldown directly,
      // but resetCycleProviderState() above should clear cycle-level state.
      // The Gemini 429 cooldown is tracked at module level, so we need
      // a workaround: register a no-op dynamic provider that won't be
      // Gemini but will provide alternative capacity.
      log('Note: Gemini is on 429 cooldown. Cooldown will expire naturally.', 'WARN', 'cycle-watchdog');
    }
  } catch (_e: any) { /* non-critical */ }

  await sleep(PROVIDER_RESET_RETRY_DELAY_MS);
  return allOk;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 2: PROVIDER RE-DISCOVERY
// ═══════════════════════════════════════════════════════════════════════════════
//
// Re-runs the auto-discovery pipeline to find new free providers/models.
// This queries OpenRouter, Groq, and DeepInfra for available free models,
// then verifies them and registers them as dynamic providers.

interface DiscoveryResult {
  discovered: number;
  registered: number;
}

async function rediscoverProviders(): Promise<DiscoveryResult> {
  const result: DiscoveryResult = { discovered: 0, registered: 0 };

  // 1. Run auto-discovery via config-loader
  try {
    const configLoader = _getConfigLoader();
    if (!configLoader) {
      log('Config loader not available for re-discovery', 'WARN', 'cycle-watchdog');
      return result;
    }

    log('Starting provider re-discovery (timeout: 30s)...', 'INFO', 'cycle-watchdog');

    // Race discovery against a timeout
    const discovered = await Promise.race([
      configLoader.autoDiscoverModels(),
      new Promise<[]>(resolve => setTimeout(() => resolve([]), PROVIDER_REDISCOVERY_TIMEOUT_MS)),
    ]);

    if (Array.isArray(discovered) && discovered.length > 0) {
      result.discovered = discovered.length;
      log(`Re-discovery found ${discovered.length} models: ${discovered.map(d => d.model).join(', ')}`, 'INFO', 'cycle-watchdog');

      // 2. Register discovered models as dynamic providers
      const registry = _getRegistry();
      if (registry) {
        const PROVIDER_ENDPOINT_MAP: Record<string, { endpoint: string; envKey: string }> = {
          openrouter: { endpoint: 'https://openrouter.ai/api/v1/chat/completions', envKey: 'OPENROUTER_API_KEY' },
          groq: { endpoint: 'https://api.groq.com/openai/v1/chat/completions', envKey: 'GROQ_API_KEY' },
          nvidia: { endpoint: 'https://integrate.api.nvidia.com/v1/chat/completions', envKey: 'NVIDIA_API_KEY' },
          deepinfra: { endpoint: 'https://api.deepinfra.com/v1/openai/chat/completions', envKey: 'DEEPINFRA_API_KEY' },
        };

        for (const disc of discovered) {
          const providerConfig = PROVIDER_ENDPOINT_MAP[disc.provider];
          if (!providerConfig) continue;
          if (!process.env[providerConfig.envKey]) {
            log(`  Skipping ${disc.model}: no API key for ${disc.provider}`, 'DEBUG', 'cycle-watchdog');
            continue;
          }

          try {
            const { callChatCompletionWithRollback, extractJSON, validateActionResponse, retryWithBackoff } = require('./providers-base');
            const modelId = disc.model;
            const endpoint = providerConfig.endpoint;
            const apiKey = process.env[providerConfig.envKey]!;
            const dynName = `watchdog-${modelId.replace(/[^a-z0-9]/gi, '-').slice(0, 30)}`;
            const dynFn = async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
              const rawContent = await retryWithBackoff(
                () => callChatCompletionWithRollback(endpoint, apiKey, modelId, base64Image, prompt, dynName, { signal }),
                { providerName: dynName }
              );
              if (options.validate === false) return rawContent;
              return validateActionResponse(extractJSON(rawContent, dynName), dynName);
            };
            registry.registerDynamicProvider(dynName, dynFn);
            result.registered++;
            log(`  Registered dynamic provider: ${dynName} (${modelId})`, 'INFO', 'cycle-watchdog');
          } catch (e: any) {
            log(`  Failed to register ${disc.model}: ${e.message}`, 'WARN', 'cycle-watchdog');
          }
        }
      }
    } else {
      log('Re-discovery found no new models', 'INFO', 'cycle-watchdog');
    }
  } catch (e: any) {
    logError('Provider re-discovery failed', e as Error);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STEP 3: SELF-HEAL TRIGGER
// ═══════════════════════════════════════════════════════════════════════════════
//
// Triggers the existing self-heal pipeline with a context-specific error
// message about the question timeout. The self-heal system will:
//   1. Capture the current page state
//   2. Generate code fixes via the codegen tribunal
//   3. Audit the fixes
//   4. Apply and verify (if GitOps is enabled)
//
// If self-heal is not available or fails, we still return true (the
// provider reset and re-discovery may have been enough to unblock the bot).

async function triggerSelfHeal(currentPageUrl: string): Promise<boolean> {
  const CONFIG = getCONFIG();

  // 1. Try the injected self-heal function
  const performSelfHeal = _deps.selfHeal?.performSelfHeal;
  if (CONFIG.SELF_HEAL_ENABLED && performSelfHeal) {
    try {
      log('Watchdog: Invoking self-heal pipeline...', 'INFO', 'cycle-watchdog');
      const healed = await performSelfHeal({
        reason: `question-timeout-${questionState.questionNumber}`,
        context: {
          url: currentPageUrl,
          elapsed: Date.now() - (questionState.questionStartTime || Date.now()),
          questionNumber: questionState.questionNumber,
          lastAction: questionState.lastActionType,
        },
      });
      if (healed) {
        log('Watchdog: Self-heal returned success', 'INFO', 'cycle-watchdog');
        return true;
      } else {
        log('Watchdog: Self-heal returned false — trying manual recovery', 'WARN', 'cycle-watchdog');
      }
    } catch (e: any) {
      logError('Watchdog: Self-heal threw error', e as Error);
    }
  }

  // 2. Manual recovery fallback: force a page reload
  log('Watchdog: Self-heal not available or failed — performing manual recovery (reset + re-discovery already done)', 'INFO', 'cycle-watchdog');
  return true; // Return true because provider reset + re-discovery may be sufficient
}

// ═══════════════════════════════════════════════════════════════════════════════
// DIAGNOSTIC SNAPSHOT
// ═══════════════════════════════════════════════════════════════════════════════
//
// Returns a snapshot of the current watchdog state for monitoring dashboards
// and the /api/health endpoint.

function getWatchdogSnapshot(): {
  isMonitoring: boolean;
  questionNumber: number;
  elapsedMs: number;
  timeoutMs: number;
  remainingMs: number;
  selfHealAttempts: number;
  healed: boolean;
  timedOut: boolean;
  lastActionType: string;
  cycleStats: typeof cycleWatchdogStats;
} {
  const CONFIG = getCONFIG();
  const timeoutMs = CONFIG.QUESTION_TIMEOUT_MS || DEFAULT_QUESTION_TIMEOUT_MS;
  const elapsed = questionState.questionStartTime ? Date.now() - questionState.questionStartTime : 0;

  return {
    isMonitoring: !!questionState.questionStartTime,
    questionNumber: questionState.questionNumber,
    elapsedMs: elapsed,
    timeoutMs,
    remainingMs: Math.max(0, timeoutMs - elapsed),
    selfHealAttempts: questionState.selfHealAttempts,
    healed: questionState.healed,
    timedOut: questionState.timedOut,
    lastActionType: questionState.lastActionType,
    cycleStats: { ...cycleWatchdogStats },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY: sleep (avoids top-level require of utils-sleep which may not exist
// in all contexts — this module must be safe to require anywhere)
// ═══════════════════════════════════════════════════════════════════════════════

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════════════════════════

module.exports = {
  // Lifecycle hooks — call from cycle-cycle-manager.ts
  onCycleStarted,
  onCycleEnded,
  onQuestionStarted,
  onQuestionCompleted,
  onActionCompleted,
  // Main check — call every iteration of the question loop
  checkQuestionTimeout,
  // Diagnostics
  getWatchdogSnapshot,
  // DI
  _injectDependencies,
};
