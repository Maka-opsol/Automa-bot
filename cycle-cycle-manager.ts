'use strict';

const fs = require('fs');
const crypto = require('crypto');

// ─── Dependency Injection ───
// All dependencies are injected via _injectDependencies() from the DI container.
// No top-level require() for project modules — only Node.js builtins.
let _deps = {};

/**
 * Inject dependencies from the DI container.
 * Called once during container initialization.
 *
 * @param {Object} deps - Object mapping dependency names to modules
 */
function _injectDependencies(deps: any) { 
  _deps = deps;
}

// ─── Lazy accessors with fallback to container.get() ───
// This allows cycle-manager to work even if some non-critical deps are null.

function getDep(name: any) { 
  return (_deps as any)[name] || null;
}

// Fallback is safe: cycle-manager runs mid-cycle, long after container init.
function getCONFIG(): Record<string, any> { return (_deps as any).config || require('./get-config'); }

// ─── Module state ───
let stopRequested = false;
let cycleStartTime: number | null = null;
let browserRestartInterval = 4 * 60 * 60 * 1000;
let consecutiveFailures = 0;
let selfHealRunning = false;
let _networkSetup = false;
let explorationMode = false;
let explorationMap: any = null;

// v4: Track recent error codes to distinguish structural vs transient failures.
// Self-heal should ONLY fire when the bot is structurally broken, not when
// it's hitting transient provider issues. A rotating buffer of recent error
// codes lets us assess: are we seeing the SAME transient error repeatedly
// (don't self-heal) or DIFFERENT structural errors (do self-heal)?
const _recentErrorCodes: Array<{ code: string; ts: number }> = [];
const RECENT_ERROR_WINDOW_MS = 15 * 60 * 1000; // 15-minute window
const RECENT_ERROR_MAX = 20;
let explorationFailures = 0;

/* ── OR Budget Park ──────────────────────────────────────────────────────────
 * When OpenRouter's daily limit is exhausted and no other providers exist,
 * the bot "parks" — skips screenshots and tribunal, just sleeps until
 * midnight UTC. The screen stays untouched, so it resumes on the same
 * question. Zero memory waste during the park.
 */
let _orParked = false;
let _orParkedDate = '';   // YYYY-MM-DD UTC of the day we parked
const OR_PARK_CHECK_INTERVAL_MS = 60000; // Check for midnight every 60s

/**
 * Check if OpenRouter budget is exhausted AND no other providers available.
 * If so, enter park mode (returns true). If midnight has rolled over,
 * unparks and returns false.
 */
async function _checkOrPark(log: any): Promise<boolean> {
  // Already parked — check if midnight rolled over
  if (_orParked) {
    const todayUTC = new Date().toISOString().slice(0, 10);
    if (todayUTC !== _orParkedDate) {
      _orParked = false;
      _orParkedDate = '';
      log('OR park: midnight rollover detected, resuming normal operation', 'INFO', 'cycle');
      return false;
    }
    // Still parked — caller should sleep and continue
    return true;
  }

  // Not parked — check if we SHOULD park
  try {
    const orLimiter = require('./openrouter-rate-limiter');
    const budgetPct = orLimiter.getBudgetPct?.();
    if (budgetPct === undefined || budgetPct > 0) return false; // Budget available

    // Budget is 0 — check if other providers are FUNCTIONAL (not just configured)
    const registry = require('./providers-registry');
    const providers = await registry.getAvailableProviders?.();
    const nonOrProviders = Array.isArray(providers) ? providers.filter((p: any) => p.name !== 'OpenRouter') : [];

    if (nonOrProviders.length > 0) {
      // Other providers exist — but are they actually functional?
      // Check if all of them have very low health (recent 429s)
      let anyHealthy = false;
      try {
        const health = require('./providers-health');
        for (const p of nonOrProviders) {
          const snapshot = health.getHealthSnapshot?.(p.name);
          // If provider has been called recently and has decent health, it's functional
          if (snapshot && snapshot.totalCalls >= 1 && snapshot.healthScore >= 0.3) {
            anyHealthy = true;
            break;
          }
          // If no calls recorded yet, assume potentially healthy (new provider)
          if (snapshot && snapshot.totalCalls === 0) {
            anyHealthy = true;
            break;
          }
        }
      } catch {}

      // Check Cloudflare model cooldowns — if ALL models on cooldown, CF is dead too
      let cfAllOnCooldown = false;
      if (!anyHealthy) {
        try {
          const cfProvider = require('./providers-cloudflare');
          const modelChain = cfProvider._getModelChain?.();
          if (Array.isArray(modelChain) && modelChain.length > 0) {
            // We can't directly check cooldowns, but if no provider is healthy, CF is likely dead
            cfAllOnCooldown = true;
          }
        } catch {}
      }

      if (anyHealthy) {
        log('OR budget exhausted but other healthy providers available — not parking', 'INFO', 'cycle');
        return false;
      }

      // All non-OR providers are also down — enter park
      log('OR budget exhausted AND all other providers are down (all 429). Parking until midnight UTC.', 'WARN', 'cycle');
    } else {
      log('OR daily limit exhausted, no other providers configured. Parking until midnight UTC.', 'WARN', 'cycle');
    }

    // Enter park (either no other providers, or all are 429'd)
    _orParked = true;
    _orParkedDate = new Date().toISOString().slice(0, 10);

    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    tomorrow.setUTCHours(0, 0, 0, 0);
    const msUntilMidnight = tomorrow.getTime() - now.getTime();
    const parkMinutes = Math.min(Math.round(msUntilMidnight / 60000), 30);

    log('OR daily limit exhausted, no other providers. Parking ~' + parkMinutes + 'min until midnight UTC. Screen untouched.', 'WARN', 'cycle');
    try {
      const sendAlert = require('./alerting').sendAlert;
      sendAlert?.('OR budget parked: sleeping until midnight UTC, no other providers');
    } catch { /* non-critical */ }
    return true;
  } catch {
    return false; // Can't determine state — don't park
  }
}

// v4: Error codes that are ALWAYS transient — self-heal cannot fix these.
// If ALL recent errors fall in this set, do NOT activate self-heal.
const TRANSIENT_ERROR_CODES = new Set([
  'E_NETWORK_TIMEOUT', 'E_RATE_LIMITED', 'E_PROVIDER_TEMPORARY',
  'E_BROWSER_DISCONNECTED', 'E_CAPTCHA_ENCOUNTERED',
  'E_CONNECTION_FAILED', // ECONNREFUSED/ENOTFOUND
]);

/**
 * Record an error code in the rotating buffer. Called after every cycle error.
 */
function _recordErrorForDesperation(code: string) {
  const now = Date.now();
  _recentErrorCodes.push({ code, ts: now });
  // Trim old entries
  while (_recentErrorCodes.length > 0 && now - _recentErrorCodes[0].ts > RECENT_ERROR_WINDOW_MS) {
    _recentErrorCodes.shift();
  }
  // Cap size
  while (_recentErrorCodes.length > RECENT_ERROR_MAX) {
    _recentErrorCodes.shift();
  }
}

/**
 * v4: Assess whether the bot is DESPERATELY in need of self-heal.
 *
 * Returns true ONLY when:
 *   1. The error is classified as healable (selector drift, UI change, etc.)
 *      AND consecutive failures >= threshold, OR
 *   2. There are 3+ DIFFERENT non-transient error codes in the recent window
 *      (suggests cascading structural failure, not a single transient issue), OR
 *   3. The survival-restart-guardian has emergency mode active (OOM loop).
 *
 * Returns false when:
 *   - All recent errors are transient (rate limits, timeouts, captchas)
 *   - Same transient error repeating (provider outage, not code breakage)
 *   - Fewer than threshold consecutive failures
 *   - A self-heal session is already active
 */
function _isDesperatelyBroken(CONFIG: any): boolean {
  // Must have enough consecutive failures
  if (consecutiveFailures < CONFIG.SELF_HEAL_FAILURE_THRESHOLD) return false;

  // Check if survival guardian has detected an OOM loop
  try {
    const guardian = require('./survival-restart-guardian');
    if (guardian.isEmergencyMode?.()) return true;
  } catch {}

  // If we have very few recent errors recorded, fall back to count-only check
  // (first few cycles — not enough data for pattern analysis)
  if (_recentErrorCodes.length < 3) {
    // With no error classification data, require higher threshold
    return consecutiveFailures >= Math.max(CONFIG.SELF_HEAL_FAILURE_THRESHOLD, 10);
  }

  // Count distinct error codes and separate transient vs non-transient
  const transientCount = _recentErrorCodes.filter(e => TRANSIENT_ERROR_CODES.has(e.code)).length;
  const nonTransientCodes = new Set(
    _recentErrorCodes.filter(e => !TRANSIENT_ERROR_CODES.has(e.code)).map(e => e.code)
  );
  const healableCodes = new Set(
    _recentErrorCodes.filter(e => {
      // Healable codes from errors.ts
      const h = ['E_SELECTOR_DRIFT', 'E_UI_CHANGED', 'E_PROVIDER_PERMANENT', 'E_STATE_DEADLOCK', 'E_PATCH_FAILED'];
      return h.includes(e.code);
    }).map(e => e.code)
  );

  // Case 1: Explicitly healable errors with enough consecutive failures
  if (healableCodes.size > 0 && consecutiveFailures >= CONFIG.SELF_HEAL_FAILURE_THRESHOLD) {
    return true;
  }

  // Case 2: ALL errors are transient — NOT desperate, just unlucky
  if (transientCount === _recentErrorCodes.length) {
    // Same transient error repeating? Definitely not structural.
    if (nonTransientCodes.size === 0) return false;
  }

  // Case 3: 3+ DIFFERENT non-transient error codes = cascading structural failure
  if (nonTransientCodes.size >= 3) {
    return true;
  }

  // Case 4: Mix of transient and non-transient, but non-transient are diverse
  // (2+ different non-transient codes) AND failures are very high
  if (nonTransientCodes.size >= 2 && consecutiveFailures >= CONFIG.SELF_HEAL_FAILURE_THRESHOLD * 2) {
    return true;
  }

  // Default: not desperate enough
  return false;
}

function requestStop() {  stopRequested = true; }

// v5 FIX: checkMemoryAndRecover now calls memoryMode.shedMemory (async) which
// actually closes the browser and frees ~100-200MB. Previously it only did
// clearCache + GC, which freed maybe 5-10MB — nowhere near enough on 512MB.
// v6 FIX: Now accepts preserveBrowser to use graduated shedding mid-quiz.
//   When preserveBrowser=true, uses L0-L2 (caches, page blank+restore, reload)
//   instead of L3 (close browser) which would destroy quiz state.
//   Returns true if memory was high AND recovery was attempted.
async function checkMemoryAndRecover(CONFIG: any, log: any, clearCache: any, preserveBrowser: boolean = false): Promise<boolean> {
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  if (used > CONFIG.MEMORY_RESTART_THRESHOLD_MB) {
    log(`Memory high (${used.toFixed(0)}MB) -- shedding memory (preserveBrowser=${preserveBrowser})`, 'WARN', 'cycle');
    try {
      const memoryMode = require('./memory-mode');
      await memoryMode.shedMemory('cycle-check-memory', {
        preserveBrowser,
        targetMB: CONFIG.MEMORY_RESTART_THRESHOLD_MB - 30, // aim 30MB below threshold
      });
    } catch { /* memory-mode not available */ }
    if (clearCache) clearCache();
    if (global.gc) global.gc();
    return true;
  }
  return false;
}

// v5-fix H1: Lazy-loaded non-container modules — cached after first load
let _a11ySnapshot: any = null;
function _getA11ySnapshot() { if (!_a11ySnapshot) { try { _a11ySnapshot = require('./utils-a11y-snapshot'); } catch { _a11ySnapshot = { getA11ySnapshot: async () => null }; } } return _a11ySnapshot; }
let _codegenTribunal: any = null;
function _getCodegenTribunal() { if (!_codegenTribunal) { try { _codegenTribunal = require('./providers-codegen-tribunal'); } catch { _codegenTribunal = null; } } return _codegenTribunal; }
let _providerDiscovery: any = null;
function _getProviderDiscovery() { if (!_providerDiscovery) { try { _providerDiscovery = require('./providers-provider-discovery'); } catch { _providerDiscovery = null; } } return _providerDiscovery; }
let _processRetrainer: any = null;
function _getProcessRetrainer() { if (!_processRetrainer) { try { _processRetrainer = require('./cycle-process-retrainer'); } catch { _processRetrainer = null; } } return _processRetrainer; }
let _mathVerify: any = null;
function _getMathVerify() { if (!_mathVerify) { try { _mathVerify = require('./math-verify'); } catch { _mathVerify = null; } } return _mathVerify; }
let _healthWatchdog: any = null;
function _getHealthWatchdog() { if (!_healthWatchdog) { try { _healthWatchdog = require('./longevity-self-ping'); } catch { _healthWatchdog = null; } } return _healthWatchdog; }
let _problemClassifier: any = null;
function _getProblemClassifier() { if (!_problemClassifier) { try { _problemClassifier = require('./math-problem-classifier'); } catch { _problemClassifier = null; } } return _problemClassifier; }
let _pix2tex: any = null;
function _getPix2tex() { if (!_pix2tex) { try { _pix2tex = require('./services-pix2tex'); } catch { _pix2tex = null; } } return _pix2tex; }
let _degradationLadder: any = null;
function _getDegradationLadder() { if (!_degradationLadder) { try { _degradationLadder = require('./self-heal-degradation-ladder'); } catch { _degradationLadder = null; } } return _degradationLadder; }
let _actionCache: any = null;
function _getActionCache() { if (!_actionCache) { try { _actionCache = require('./services-action-cache'); } catch { _actionCache = null; } } return _actionCache; }
let _solutionCache: any = null;
function _getSolutionCache() { if (!_solutionCache) { try { _solutionCache = require('./math-solution-cache'); } catch { _solutionCache = null; } } return _solutionCache; }
let _tmpGuardian: any = null;
function _getTmpGuardian() { if (!_tmpGuardian) { try { _tmpGuardian = require('./longevity-tmp-guardian'); } catch { _tmpGuardian = null; } } return _tmpGuardian; }
let _coldStart: any = null;
function _getColdStart() { if (!_coldStart) { try { _coldStart = require('./render-cold-start'); } catch { _coldStart = null; } } return _coldStart; }

async function runCycle(options?: { pixelOnly?: boolean }) { 
  // ─── Resolve all dependencies at cycle start ───
  // This ensures we always use the latest container state
  const CONFIG = getCONFIG();
  const loggerDep = getDep('logger') || {};
  const log = loggerDep.log || console.log;
  const logError = loggerDep.logError || console.error;
  const _providersDep = getDep('providers') || {};
  const { resetCycleProviderState, getStats, updateStats, determineNextAction } = _providersDep;
  const _browserDep = getDep('browser') || {};
  const { launchBrowser, closeBrowser, getBrowserDisconnected, resetBrowserDisconnected, getBrowserLaunchCount, withBrowserRetry, resetBrowserLaunchCount } = _browserDep;
  const { clearCache } = getDep('cache') || {};
  const { ensureAuthenticated, handleCaptcha, authenticate } = getDep('authGuard') || {};
  const { executeAction } = getDep('actionExecutor') || {};
  const { recoverIfStuck, resetStagnationState } = getDep('stagnation') || {};
  const { trackModuleProgress } = getDep('moduleTracking') || {};
  const _smDep = getDep('stateMachine') || {};
  const { stateMachine, STATES } = _smDep;
  const alertingDep = getDep('alerting') || {};
  const sendAlert = alertingDep.sendAlert || (() => {});
  const { performSelfHeal } = getDep('selfHeal') || {};
  // v5-fix H1: Use DI-injected providersBase instead of require('./providers-base')
  const _baseDep = getDep('providersBase') || {};
  const classifyProviderError = _baseDep.classifyError || null;
  const safeCall = _baseDep.safeCall || ((fn: any) => fn());
  // providers-fallback is not in the container — lazy load with caching
  let _fallbackMod: any = null;
  const getFallbackAction = async (page: any, currentState?: string) => {
    if (!_fallbackMod) { try { _fallbackMod = require('./providers-fallback'); } catch { _fallbackMod = { getFallbackAction: async () => ({ actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 }) }; } }
    return _fallbackMod.getFallbackAction(page, currentState);
  };
  const { saveCheckpoint, loadCheckpoint } = getDep('statePersist') || {};
  const { getNextModule, recordModuleCompletion } = getDep('moduleSelector') || {};
  const { trackProgress } = getDep('progressTracker') || {};
  const dbHelpers = getDep('database') || {};
  const insertSemanticsSnapshot = dbHelpers.insertSemanticsSnapshot || null;
  const upsertLastState = dbHelpers.upsertLastState || null;
  const dependencySurvivor = getDep('dependencySurvivor');
  const gitOps = getDep('selfHealGitops');
  const quotaBargain = getDep('providerQuotaBargain');
  const uiDrift = getDep('uiDriftDiscovery');
  const humanCaptcha = getDep('captchaHumanFallback');
  const bruteForce = getDep('bruteForceNavigator');
  const stabilityWaiter = getDep('flutterStability');
  const modalSlayer = getDep('flutterModalSlayer');
  const blackbox = getDep('blackbox');
  const adaptiveEngine = getDep('adaptivePerformanceEngine');
  const semantics = getDep('flutterSemantics');
  const dpr = getDep('flutterDpr');
  const network = getDep('flutterNetwork');
  const inspector = getDep('flutterInspector');
  const canvas = getDep('flutterCanvas');
  const gestures = getDep('flutterGestures');
  const strategyVariants = getDep('strategyVariants');
  const policyEngine = getDep('policyEngine');
  const pluginAPI = getDep('pluginAPI');

  // v5-fix H1: Use DI-injected explorationCartographer instead of require
  const explorationCartographer = getDep('explorationCartographer') || null;
  if (explorationCartographer && CONFIG.ENABLE_EXPLORATION_PASS) {
    log('Exploration cartographer available via DI.', 'DEBUG', 'cycle');
  }

  // ─── Resilience deps (R19 integration) ───
  const runtimeHeapGuardian = getDep('runtimeHeapGuardian');
  const runtimeModuleQuarantine = getDep('runtimeModuleQuarantine');
  const progressSemanticDetector = getDep('progressSemanticDetector');
  const progressSpeedBenchmark = getDep('progressSpeedBenchmark');
  const progressCircularPathDetector = getDep('progressCircularPathDetector');
  const cascadeBreaker = getDep('cascadeBreaker');
  const economyQuotaRations = getDep('economyQuotaRations');
  const policyActionValidator = getDep('policyActionValidator');
  const policyStateGuard = getDep('policyStateGuard');
  const authCaptchaLoopGuard = getDep('authCaptchaLoopGuard');
  const authTokenGraveyard = getDep('authTokenGraveyard');
  const browserPhoenix = getDep('browserPhoenix');

  // ─── Degradation Level Check (Response 3) ───
  const degradationLadder = _getDegradationLadder();
  let degradationLevel = 0;
  let degradationLevelName = 'FULL';

  // ─── /tmp Disk Check (Response 6) ───
  // Quick check before cycle — if /tmp is too full, run a prune.
  // This prevents silent write failures mid-cycle.
  try {
    const tmpG = _getTmpGuardian();
    if (tmpG) {
      const usage = tmpG.getDiskUsage();
      if (usage.usagePct > parseFloat(CONFIG.TMP_GUARDIAN_WARN || '0.70')) {
        log(`/tmp usage high: ${(usage.usagePct * 100).toFixed(1)}% — running prune`, 'WARN', 'cycle');
        tmpG.prune();
      }
    }
  } catch { /* non-critical */ }

  // ─── Cold Start Recovery (Response 6) ───
  // On first cycle after a cold start, log the recovery status.
  try {
    const cs = _getColdStart();
    if (cs && cs.isColdStart() && !cs._recoveryLogged) {
      const info = cs.getColdStartInfo();
      log(`Cold start recovery: ${info?.reason || 'unknown'}. Using fast startup path.`, 'INFO', 'cycle');
      cs._recoveryLogged = true;
    }
  } catch { /* non-critical */ }
  try {
    if (degradationLadder) {
      const dlResult = degradationLadder.degradationLadder?.calculateLevel?.() || degradationLadder.calculateLevel?.();
      if (dlResult) {
        degradationLevel = dlResult.level;
        degradationLevelName = dlResult.name;
        // Apply cycle sleep if level requires it
        const cycleSleepMs = degradationLadder.degradationLadder?.getCycleSleepMs?.() || degradationLadder.getCycleSleepMs?.() || 0;
        if (cycleSleepMs > 0) {
          const { sleep } = require('./utils-sleep');
          log(`Degradation level ${degradationLevelName}: sleeping ${cycleSleepMs}ms between cycles`, 'INFO', 'cycle');
          await sleep(cycleSleepMs);
        }
        // DORMANT level: skip AI-dependent parts but still run pixel-only
        // Pixel fallback and explorer cost no API quota and can make progress
        if (degradationLevel >= 4 && !options?.pixelOnly) {
          log('Degradation level DORMANT: switching to pixel-only cycle (zero providers/budget)', 'WARN', 'cycle');
          options = { pixelOnly: true }; // Force pixel-only mode
          // Don't return — fall through to pixel-only path below
        }
      }
    }
  } catch (e: any) {
    // Non-critical: degradation check failure shouldn't break the cycle
    log(`Degradation check failed: ${e.message || e}`, 'DEBUG', 'cycle');
  }

  // Reset module quarantine at cycle start
  runtimeModuleQuarantine?.resetCycle?.();
  // Reset CAPTCHA loop guard at cycle start
  authCaptchaLoopGuard?.resetCycle?.();

  // ─── Cycle start ───
  dependencySurvivor?.checkAndFix?.();
  // Resilience: check heap before cycle starts
  runtimeHeapGuardian?.checkMemory?.();
  const cycleStart = Date.now();
  cycleStartTime = cycleStart;
  resetBrowserDisconnected();
  stateMachine.resetDeadlock();
  resetStagnationState?.();
  await stateMachine.initialize();
  const stats = getStats();
  updateStats({ cycleCount: (stats.cycleCount || 0) + 1, lastCycleStart: new Date().toISOString(), currentStatus: 'running' });
  log(`Starting cycle #${getStats().cycleCount}${options?.pixelOnly ? ' (pixel-only)' : ''}`, 'INFO', 'cycle');
  if (!options?.pixelOnly) resetCycleProviderState();

  let page: any;
  let clickAttempts = 0;
  let clickSuccesses = 0;

  try {
    const checkpoint = loadCheckpoint?.();
    if (checkpoint) { log(`Resuming from checkpoint at ${new Date(checkpoint.savedAt).toISOString()}`, 'INFO', 'cycle'); }

    // Resilience: use browser-phoenix multi-tier launch if available
    const launchFn = browserPhoenix?.phoenixBrowserRetry || withBrowserRetry;
    page = await launchFn(async (p: any) => {
      if (authenticate) await authenticate(p);
      if (checkpoint && checkpoint.url) { await p.goto(checkpoint.url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {}); }
      return p;
    });

    if (CONFIG.ENABLE_NETWORK_INTERCEPT && !_networkSetup && network) {
      await network.setupInterception(page);
      _networkSetup = true;
    }
    if (CONFIG.FLUTTER_DPR_AUTO_CALIBRATE && dpr) { await dpr.calibrate(page); }

    // Navigate to app if browser landed on about:blank (fresh start, no checkpoint)
    if (!checkpoint && page.url() === 'about:blank') {
      const targetUrl = CONFIG.BASE_URL || CONFIG.APP_URL;
      if (targetUrl) {
        log(`Fresh start: navigating to ${targetUrl}`, 'INFO', 'cycle');
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch((e: any) => {
          log(`Initial navigation failed: ${e.message || e}`, 'WARN', 'cycle');
        });
        // Flutter apps need extra time after domcontentloaded to paint the canvas.
        // Wait for the page to actually have visible content before entering the cycle.
        log('Fresh start: waiting for Flutter canvas to render...', 'DEBUG', 'cycle');
        for (let w = 0; w < 10; w++) {
          await new Promise(r => setTimeout(r, 2000)); // 2s per check, max 20s
          try {
            const h = await page.evaluate(() => Math.max(
              document.body?.scrollHeight || 0,
              document.body?.offsetHeight || 0,
              document.documentElement?.scrollHeight || 0
              // NOTE: do NOT include clientHeight — it returns viewport height
              // (always ~768px), not content height. On a blank page, content
              // scrollHeight/offsetHeight are 0 but clientHeight is nonzero,
              // which would falsely declare the page as "has content".
            ));
            if (h > 0) {
              log(`Fresh start: page height=${h}px after ${(w + 1) * 2}s — proceeding`, 'INFO', 'cycle');
              break;
            }
          } catch { break; }
        }
      } else {
        log('Fresh start at about:blank — no BASE_URL or APP_URL configured', 'WARN', 'cycle');
      }
    }

    let questionsCompleted = checkpoint?.questionsCompleted || 0;

    // v6: Track whether we're mid-quiz (vs. between quizzes on assignments page).
    // When mid-quiz, memory protection uses browser-safe shedding (L0-L2)
    // instead of closing the browser (L3) which would destroy quiz state.
    let _midQuiz = false;
    let lastProgressTime = Date.now();
    let browserLastRestart = Date.now();
    let currentState = checkpoint?.state || null;
    let stuckCounter = 0;
    const MAX_STUCK = 10;
    let consecutiveTribunalFailures = 0;
    let unknownStateCounter = 0; // Counts consecutive 'unknown' currentState results
    const MAX_UNKNOWN_STATE = 3; // After this many unknowns, force recovery

    // 20-min stagnation auto-ban: track screenshot hash changes + question completions
    // to detect death spirals (wait/error loops with no progress)
    let lastScreenshotChangeTime = Date.now();
    let lastQuestionCompletionTime = Date.now();
    let previousScreenshotHash: string | null = null;
    let stagnationAutoBanTriggered = false;
    const STAGNATION_AUTO_BAN_MS = 20 * 60 * 1000;

    // Module download flow state machine (Response 3)
    // Tracks whether we just clicked a download button and need to wait
    // for the module to download before looking for Watch/Start buttons.
    type DownloadState = 'idle' | 'download_clicked' | 'downloading' | 'content_visible';
    let _moduleDownloadState: DownloadState = 'idle';
    let _moduleDownloadStartTime: number = 0;
    let _moduleDownloadRetryCount: number = 0;
    const MODULE_DOWNLOAD_TIMEOUT_MS = 60000; // 60s max wait for download
    const MODULE_DOWNLOAD_POLL_INTERVAL_MS = 3000; // poll every 3s
    const MODULE_DOWNLOAD_MAX_RETRIES = 2;
    let _preDownloadScreenshotHash: string | null = null;

    // Select module using dynamic planning
    let currentModule = getNextModule?.();
    if (currentModule) { log(`Selected module: ${currentModule}`, 'INFO', 'cycle'); }

    while (questionsCompleted < CONFIG.MAX_QUESTIONS && !stopRequested) {
      try { fs.writeFileSync(CONFIG.HEARTBEAT_FILE, String(Date.now())); } catch (_e: any) { /* best-effort heartbeat write */ }

      // ── OR Budget Park: skip everything when OR is exhausted ──
      // When parked, we skip screenshots, tribunal, and all actions.
      // The screen stays exactly as-is (same question). We just sleep
      // until midnight UTC when the budget resets.
      if (await _checkOrPark(log)) {
        await new Promise(r => setTimeout(r, OR_PARK_CHECK_INTERVAL_MS));
        continue;
      }

      // Resilience: heap guardian check (supplements built-in checkMemoryAndRecover)
      // v5 FIX: checkMemory is now async
      // v6 FIX: pass preserveBrowser when mid-quiz to avoid destroying quiz state
      const guardianHit = await runtimeHeapGuardian?.checkMemory?.({ preserveBrowser: _midQuiz });
      if (guardianHit) {
        log('Heap guardian triggered hard threshold — breaking cycle', 'ERROR', 'cycle');
        break;
      }
      if (await checkMemoryAndRecover(CONFIG, log, clearCache, _midQuiz)) {
        // v6: Only close+restart browser if shedMemory actually closed it.
        // When preserveBrowser=true (mid-quiz), shedMemory uses L0-L2 and
        // the browser stays open — no need to re-launch.
        try {
          const memoryMode = require('./memory-mode');
          if (memoryMode.wasBrowserClosedByProtection()) {
            await closeBrowser();
            _networkSetup = false;
            page = await withBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
            browserLastRestart = Date.now();
            memoryMode.clearBrowserClosedFlag();
          } else {
            log('Memory shed preserved browser (mid-quiz) — continuing without restart', 'INFO', 'cycle');
          }
        } catch { /* memory-mode not available, do full restart to be safe */
          await closeBrowser();
          _networkSetup = false;
          page = await withBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
          browserLastRestart = Date.now();
        }
      }
      if (getBrowserDisconnected()) throw new Error('Browser disconnected');
      if (getBrowserLaunchCount() > 10 || (Date.now() - browserLastRestart) > browserRestartInterval) {
        log('Restarting browser for stability', 'INFO', 'cycle');
        await closeBrowser();
        _networkSetup = false;
        page = await withBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
        browserLastRestart = Date.now();
        if (typeof resetBrowserLaunchCount === 'function') resetBrowserLaunchCount();
        else log('resetBrowserLaunchCount not available from browser module', 'WARN', 'cycle');
      }
      if (Date.now() - cycleStart > CONFIG.MAX_RUNTIME_PER_CYCLE_MS) {
        log('Cycle timeout', 'INFO', 'cycle');
        break;
      }

      // Resilience: token graveyard proactive refresh before auth check
      authTokenGraveyard?.checkAndRefresh?.(getDep('auth'));
      if (ensureAuthenticated) {
        const prevPage = page;
        page = await ensureAuthenticated(page);
        if (page !== prevPage) {
          _networkSetup = false;
          if (CONFIG.ENABLE_NETWORK_INTERCEPT && network) {
            await network.setupInterception(page);
            _networkSetup = true;
          }
          if (CONFIG.FLUTTER_DPR_AUTO_CALIBRATE && dpr) { await dpr.calibrate(page); }
        }
      }
      if (handleCaptcha) await handleCaptcha(page);
      // Resilience: CAPTCHA loop detection
      authCaptchaLoopGuard?.recordCaptcha?.();
      if (authCaptchaLoopGuard?.isCaptchaLooping?.()) {
        const cooldownMs = authCaptchaLoopGuard.getCaptchaCooldownRemaining?.() || 1800000;
        log(`CAPTCHA loop detected! Cooling off for ${Math.round(cooldownMs / 1000)}s`, 'WARN', 'cycle');
        await new Promise(resolve => setTimeout(resolve, Math.min(cooldownMs, 60000))); // cap wait at 60s per iteration
      }
      if (modalSlayer) await modalSlayer.dismissAnyModal(page);
      if (stabilityWaiter) await stabilityWaiter.waitForStable(page);

      // ── Blank-page guard ──
      // Flutter apps can report "stabilized" with height=0 (canvas not yet painted).
      // If we screenshot a blank page, every AI provider will fail to see anything.
      // Detect blank pages by checking document height and retry with backoff.
      {
        const MAX_BLANK_RETRIES = 4;
        const BLANK_RETRY_BASE_MS = 2000;
        let isBlank = false;
        try {
          const pageHeight = await page.evaluate(() => {
            return Math.max(
              document.body?.scrollHeight || 0,
              document.body?.offsetHeight || 0,
              document.documentElement?.scrollHeight || 0
              // NOTE: do NOT include clientHeight — it returns viewport height,
              // not content height. See fresh-start check above for details.
            );
          });
          isBlank = pageHeight === 0;
        } catch { /* evaluate may fail on some pages — not blank, proceed */ }

        if (isBlank) {
          log('Blank-page guard: page height=0 after stability wait — retrying with backoff', 'WARN', 'cycle');
          for (let retry = 0; retry < MAX_BLANK_RETRIES; retry++) {
            const waitMs = BLANK_RETRY_BASE_MS * (retry + 1); // 2s, 4s, 6s, 8s
            log(`Blank-page retry ${retry + 1}/${MAX_BLANK_RETRIES}: waiting ${waitMs}ms`, 'DEBUG', 'cycle');
            await new Promise(r => setTimeout(r, waitMs));

            // Check height again
            try {
              const h = await page.evaluate(() => {
                return Math.max(
                  document.body?.scrollHeight || 0,
                  document.body?.offsetHeight || 0,
                  document.documentElement?.scrollHeight || 0
                );
              });
              if (h > 0) {
                log(`Blank-page guard: page height recovered to ${h}px after ${waitMs}ms`, 'INFO', 'cycle');
                isBlank = false;
                break;
              }
            } catch { break; /* evaluate failed — something is there */ }
          }

          // If still blank after retries, try a page reload
          if (isBlank) {
            log('Blank-page guard: still blank after retries — reloading page', 'WARN', 'cycle');
            try {
              await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 });
              // Wait extra for Flutter to render after reload
              await new Promise(r => setTimeout(r, 5000));
              if (stabilityWaiter) await stabilityWaiter.waitForStable(page);
            } catch (reloadErr: any) {
              log(`Blank-page guard: reload failed: ${reloadErr.message || reloadErr}`, 'WARN', 'cycle');
            }
          }
        }
      }

      const beforeUrl = page.url();
      let screenshot = await page.screenshot({ type: 'jpeg', quality: 20 });

      // ── Screenshot validity check ──
      // A valid screenshot of a rendered page should be >3KB even at quality:20.
      // If it's tiny, the page is likely blank (white rectangle).
      if (screenshot.length < 3000) {
        log(`Screenshot suspiciously small (${screenshot.length} bytes) — page may be blank. Waiting 3s and retaking...`, 'WARN', 'cycle');
        await new Promise(r => setTimeout(r, 3000));
        try {
          const retryShot = await page.screenshot({ type: 'jpeg', quality: 20 });
          if (retryShot.length > screenshot.length) {
            log(`Retry screenshot is ${retryShot.length} bytes (was ${screenshot.length}) — using retry`, 'INFO', 'cycle');
            screenshot = retryShot;
          }
        } catch { /* retry failed — proceed with original */ }
      }

      let base64 = screenshot.toString('base64');
      // Feed screenshot to dashboard cache (non-blocking)

      // ─── Cloudinary: upload cycle screenshot (fire-and-forget) ───
      try {
        const screenshotStorage = require('./screenshot-storage');
        if (screenshotStorage?.isEnabled?.() && screenshotStorage?.uploadScreenshot) {
          screenshotStorage.uploadScreenshot(screenshot, 'cycle', {
            state: currentState || 'unknown',
            cycle: String(getStats().cycleCount || 0),
          }).catch(() => {});
        }
      } catch (uploadErr: any) {
        log(`Screenshot Cloudinary upload failed (non-critical): ${uploadErr.message || uploadErr}`, 'DEBUG', 'cycle');
      }
      try {
        const setShot = (globalThis as any).__setLatestScreenshot;
        if (setShot) {
          setShot(base64, null); // action set after tribunal
        }
      } catch { /* non-critical */ }
      const screenshotHash = crypto.createHash('md5').update(screenshot).digest('hex');
      // Track screenshot changes for stagnation detection
      if (previousScreenshotHash && screenshotHash !== previousScreenshotHash) {
        lastScreenshotChangeTime = Date.now();
      }
      previousScreenshotHash = screenshotHash;

      // Check policy (existing policyEngine)
      if (policyEngine) {
        const urlCheck = policyEngine.checkUrl(beforeUrl);
        if (!urlCheck.allowed) { log(`Policy blocked action: ${urlCheck.reason}`, 'WARN', 'cycle'); break; }
      }
      // Resilience: state guard transition validation
      if (policyStateGuard && currentState) {
        const stateCheck = policyStateGuard.validateTransition(currentState, beforeUrl);
        if (stateCheck && !stateCheck.allowed) {
          log(`State guard blocked transition: ${stateCheck.reason}`, 'WARN', 'cycle');
        }
      }
      // Resilience: circular path detection (SPA-aware)
      if (progressCircularPathDetector) {
        // On SPA domains, URL never changes — use state+hash visual loop detection.
        // On non-SPA domains, use traditional URL-based detection.
        const spaDomains = (CONFIG.MATHU_SPA_DOMAINS || 'app.mathu.co.za,mathu.co.za').split(',').map((d: string) => d.trim());
        const isSpa = spaDomains.some((d: string) => beforeUrl.includes(d));
        let loopCheck;
        if (isSpa && currentState) {
          loopCheck = progressCircularPathDetector.checkStateLoop(currentState, screenshotHash);
          if (loopCheck?.isLooping) {
            log(`SPA visual loop detected! State "${currentState}" hash "${screenshotHash.substring(0, 8)}" repeated ${loopCheck.loopCount} times. ${loopCheck.suggestion}`, 'WARN', 'cycle');
            // On SPA: scroll down to break the visual stalemate before navigating away
            try { await page.evaluate(() => window.scrollBy(0, 300)); } catch { /* non-critical */ }
            await new Promise(r => setTimeout(r, 2000));
          }
        } else {
          loopCheck = progressCircularPathDetector.checkUrlLoop(beforeUrl);
          if (loopCheck?.isLooping) {
            log(`Circular path detected! URL ${beforeUrl} seen ${loopCheck.loopCount} times. Navigating away.`, 'WARN', 'cycle');
            await page.goto(CONFIG.BASE_URL || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          }
        }
      }

      let action = null;

      // Flutter Semantics path
      if (CONFIG.ENABLE_FLUTTER_SEMANTICS && semantics && dpr) {
        const interactiveItems = await semantics.getInteractiveItems(page);
        if (interactiveItems.length > 0) {
          const watch = semantics.findElementFuzzy('watch', interactiveItems);
          if (watch && !watch.disabled) {
            const coords = dpr.getJitteredClick(watch.centerX, watch.centerY);
            action = { actionType: 'click', targetX: coords.x, targetY: coords.y, currentState: 'assignments_page', reasoning: 'Found via Flutter Semantics' };
            log('Flutter Semantics found "Watch" button.', 'INFO', 'cycle');
          } else {
            const start = semantics.findElementFuzzy('start', interactiveItems);
            if (start && !start.disabled) {
              const coords = dpr.getJitteredClick(start.centerX, start.centerY);
              action = { actionType: 'click', targetX: coords.x, targetY: coords.y, currentState: 'assignments_page', reasoning: 'Found via Flutter Semantics' };
              log('Flutter Semantics found "Start" button.', 'INFO', 'cycle');
            }
          }
        }
      }

      // Plugin actions
      if (!action && pluginAPI?.actions) {
        for (const [name, handler] of pluginAPI.actions) {
          try {
            const result = await handler(page, base64, beforeUrl);
            if (result) { action = result; log(`Plugin action ${name} provided result`, 'DEBUG', 'cycle'); break; }
          } catch (err: any) { logError(`Plugin action ${name} failed`, err); }
        }
      }

      // Resilience: quota throttle check before tribunal
      if (economyQuotaRations?.isEconomyMode?.()) {
        log('Economy mode active — reducing tribunal calls', 'INFO', 'cycle');
      }

      // ─── Action Cache Lookup ───
      // Before calling the tribunal (expensive AI call), check if we have
      // a cached action for this exact visual context. If hit, skip the AI
      // call entirely and use the saved action.
      let _actionCacheSig: string | null = null;
      let _actionCacheHit = false;
      const actionCache = _getActionCache();
      if (!action && actionCache && currentState) {
        try {
          // Compute context signature from current state + screenshot
          // Use previous cycle's state as the context key (currentState is set from last cycle)
          _actionCacheSig = actionCache.computeContextSignature(currentState, base64);
          if (_actionCacheSig) {
            const cachedAction = actionCache.lookup(_actionCacheSig);
            if (cachedAction) {
              action = cachedAction;
              _actionCacheHit = true;
              log(`Action cache HIT: type=${cachedAction.actionType} at (${cachedAction.targetX.toFixed(2)}, ${cachedAction.targetY.toFixed(2)}) state=${cachedAction.currentState}`, 'INFO', 'cycle');
              updateStats({ actionCacheHits: (getStats().actionCacheHits || 0) + 1 });
            } else {
              updateStats({ actionCacheMisses: (getStats().actionCacheMisses || 0) + 1 });
            }
          }
        } catch (cacheErr: any) {
          log(`Action cache lookup error: ${cacheErr.message || cacheErr}`, 'DEBUG', 'cycle');
        }
      }

      // Vision tribunal
      if (!action) {
        // Pixel-only mode: skip AI providers entirely, go straight to fallback chain
        if (options?.pixelOnly) {
          log('Pixel-only mode: skipping tribunal, using fallback chain directly', 'INFO', 'cycle');
          try {
            action = await getFallbackAction(page, currentState || undefined);
            if (action && action.actionType && action.actionType !== 'wait') {
              log(`Pixel-only fallback: ${action.actionType} at (${action.targetX}, ${action.targetY})`, 'INFO', 'cycle');
            }
          } catch (fbErr: any) {
            log(`Pixel-only fallback failed: ${fbErr.message || fbErr}`, 'WARN', 'cycle');
          }
        } else {
          try {
            action = await safeCall((_sig: any) => determineNextAction(base64, page.url(), explorationMode ? explorationMap : null), 'Tribunal', { timeoutMs: CONFIG.TRIBUNAL_TIMEOUT_MS, url: 'tribunal' });
          } catch (err: any) {
            const errMsg = err?.message || String(err);
            // Fast-path: if OR daily limit just got exhausted, enter park immediately
            // instead of burning memory on fallback chains that will also fail
            if (errMsg.includes('OPENROUTER_DAILY_LIMIT') || errMsg.includes('free-models-per-day')) {
              if (await _checkOrPark(log)) {
                await new Promise(r => setTimeout(r, OR_PARK_CHECK_INTERVAL_MS));
                continue;
              }
            }
            logError('Tribunal failed, using fallback', err);
            action = await getFallbackAction(page, currentState || undefined);
          }
        }
      }
      if (!action || !action.actionType) {
        log('Action is null, using fallback wait', 'WARN', 'cycle');
        action = { actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 };
      }

      // P-fix: When tribunal returns 'wait' for unknown/error state, run the full
      // fallback chain (pixel → visual recovery → CSS selectors) BEFORE accepting
      // the wait. This ensures the bot tries DOM/pixel-based recovery when AI
      // providers can't determine the state (e.g., only text-only providers available).
      if (action && action.actionType === 'wait' && (action.currentState === 'unknown' || action.currentState === 'error')) {
        log('Tribunal returned wait for unknown state — running fallback chain', 'INFO', 'cycle');
        try {
          const fallbackAction = await getFallbackAction(page, currentState || undefined);
          if (fallbackAction && fallbackAction.actionType && fallbackAction.actionType !== 'wait') {
            log(`Fallback chain provided action: ${fallbackAction.actionType} at (${fallbackAction.targetX}, ${fallbackAction.targetY}) state=${fallbackAction.currentState}`, 'INFO', 'cycle');
            action = fallbackAction;
          } else {
            log('Fallback chain returned wait — accepting tribunal wait', 'DEBUG', 'cycle');
          }
        } catch (fbErr: any) {
          log(`Fallback chain failed: ${fbErr.message || fbErr}`, 'WARN', 'cycle');
        }
      }

      // Dashboard: check if action is banned
      try {
        const dbMod = require('./database');
        const isBanned = dbMod.selectBannedAction?.(action.actionType);
        if (isBanned) {
          // If banned action is not 'wait', fall back to 'wait'
          // If 'wait' itself is banned (e.g. stagnation guard), fall back to 'reload'
          const isWaitAlsoBanned = dbMod.selectBannedAction?.('wait');
          if (!isWaitAlsoBanned) {
            log(`Action ${action.actionType} is banned. Forcing wait.`, 'WARN', 'cycle');
            action = { actionType: 'wait', currentState: action.currentState, targetX: 0, targetY: 0, reasoning: `Action ${action.actionType} banned` };
          } else {
            log(`Action ${action.actionType} and wait are both banned. Forcing reload.`, 'WARN', 'cycle');
            action = { actionType: 'reload', currentState: action.currentState, targetX: 0, targetY: 0, reasoning: `All fallbacks banned, using reload` };
          }
        }
      } catch { /* non-critical: DB unavailable */ }

      // Experiment context
      if (strategyVariants) {
        const experiment = strategyVariants.getActiveExperiment?.();
        if (experiment) {
          const jitter = experiment.context?.getJitterPx?.();
          if (jitter && action.targetX !== undefined && action.targetY !== undefined) {
            action.targetX += (Math.random() - 0.5) * jitter / 100;
            action.targetY += (Math.random() - 0.5) * jitter / 100;
          }
        }
      }

      // ─── Module Download Flow Detection (Response 3) ───
      // Before executing, check if this action is a download button click.
      // If so, record the pre-download screenshot hash and set state.
      const isDownloadClick = action.actionType === 'click' &&
        (action.currentState === 'module_downloading' ||
         (action.reasoning && action.reasoning.includes('download')));

      if (isDownloadClick && _moduleDownloadState === 'idle') {
        _moduleDownloadState = 'download_clicked';
        _moduleDownloadStartTime = Date.now();
        _moduleDownloadRetryCount = 0;
        _preDownloadScreenshotHash = screenshotHash;
        log('Module download flow: click detected, entering download_clicked state', 'INFO', 'cycle');
      }

      // Resilience: action validation before execution
      if (policyActionValidator) {
        const validation = policyActionValidator.validateAction(action, action.currentState);
        if (validation && !validation.allowed) {
          log(`Action validator blocked: ${validation.reason}`, 'WARN', 'cycle');
          action = { actionType: 'wait', currentState: action.currentState, targetX: 0, targetY: 0, reasoning: `Blocked by validator: ${validation.reason}` };
        }
      }
      updateStats({ currentState: action.currentState });
      // Update dashboard cache with action info
      try {
        const setShot = (globalThis as any).__setLatestScreenshot;
        if (setShot) {
          setShot(base64, action);
        }
      } catch { /* non-critical */ }

      // UI drift detection (uses base64 — must run before we null it)
      if (uiDrift) {
        const uiDrifted = await uiDrift.detectDrift(action.currentState, base64);
        if (uiDrifted) {
          log('UI Drifted! Entering Discovery Mode.', 'WARN', 'cycle');
          await uiDrift.discoverUI(page);
          await stateMachine.transition(STATES.UI_DISCOVERED);
        }
      }

      // ─── Solution Cache Check (Response 5) ───
      // Before calling LLM, check if we've seen this exact problem before.
      // Exact match → use cached solution directly (saves budget).
      // Similar match → include cached solution as context hint.
      let _cacheHitProblemText = '';
      let _cacheHitHash = '';
      const solutionCache = _getSolutionCache();
      if (solutionCache && action && (action.currentState === 'question' || action.actionType === 'keypad_input' || action.value)) {
        try {
          // Get problem text from page or action reasoning
          let probTextForCache = '';
          try {
            const bodyTextForCache = await page.evaluate(() => document.body?.innerText || '');
            if (bodyTextForCache && bodyTextForCache.length > 20) {
              probTextForCache = bodyTextForCache.substring(0, 2000);
            }
          } catch {}
          if (!probTextForCache && action.reasoning) {
            probTextForCache = action.reasoning;
          }

          if (probTextForCache) {
            const cacheResult = solutionCache.lookup(probTextForCache);
            if (cacheResult.type === 'exact' && cacheResult.solution) {
              const sol = cacheResult.solution;
              log(`Solution cache EXACT HIT — reusing verified solution (type=${sol.problemType}, used ${sol.successCount}x before)`, 'INFO', 'cycle');
              // Attach cached solution to action so downstream can use it
              action._cachedSolution = sol.solution;
              action._cachedSteps = sol.steps;
              action._cacheHit = 'exact';
              _cacheHitProblemText = probTextForCache;
              _cacheHitHash = cacheResult.hash;
              updateStats({ solutionCacheHits: (getStats().solutionCacheHits || 0) + 1 });
            } else if (cacheResult.type === 'similar' && cacheResult.similarSolution) {
              const simSol = cacheResult.similarSolution;
              log(`Solution cache SIMILAR HIT — including as context hint (type=${simSol.problemType})`, 'INFO', 'cycle');
              action._cachedSolutionHint = simSol.solution;
              action._cachedStepsHint = simSol.steps;
              action._cacheHit = 'similar';
              _cacheHitHash = cacheResult.hash;
              updateStats({ solutionCacheSimilarHits: (getStats().solutionCacheSimilarHits || 0) + 1 });
            }
          }
        } catch (cacheErr: any) {
          log(`Solution cache lookup error: ${cacheErr.message || cacheErr}`, 'DEBUG', 'cycle');
        }
      }

      // ─── Problem Classification Pipeline (Response 4) ───
      // Classify the math problem type from available text, and optionally
      // re-OCR with Pix2Tex if the vision model's text quality is poor.
      // This runs before math verification to provide better context.
      const classifier = _getProblemClassifier();
      if (classifier && action && (action.currentState === 'question' || action.actionType === 'keypad_input' || action.value)) {
        try {
          // Get text from the page (a11y snapshot or body text)
          let ocrText = '';
          try {
            const bodyText = await page.evaluate(() => document.body?.innerText || '');
            if (bodyText && bodyText.length > 20) {
              ocrText = bodyText.substring(0, 2000); // Limit to prevent huge prompts
            }
          } catch {}

          // Fallback: use action reasoning as text source
          if (!ocrText && action.reasoning) {
            ocrText = action.reasoning;
          }

          if (ocrText) {
            const classification = classifier.classifyProblem(ocrText);

            // Check if Pix2Tex should re-OCR this image
            const pix2tex = _getPix2tex();
            if (pix2tex && classifier.shouldUsePix2Tex(ocrText, classification.type, false)) {
              const p2tResult = await pix2tex.ocrMath(base64);
              if (p2tResult.text && p2tResult.text.length > 10) {
                log(`Pix2Tex re-OCR: ${p2tResult.text.length} chars (conf=${p2tResult.confidence}%)`, 'INFO', 'cycle');
                // Use Pix2Tex text for re-classification
                const reclassified = classifier.classifyProblem(p2tResult.text);
                // Attach to action for downstream consumers
                action._pix2texText = p2tResult.text;
                action._pix2texLatex = p2tResult.latex;
                action._problemType = reclassified.type;
                action._problemConfidence = reclassified.confidence;
                action._ocrQuality = reclassified.ocrQuality;

                // Record model-type affinity after this attempt
                const providerName = action.provider || 'unknown';
                classifier.recordModelTypeAffinity(reclassified.type, providerName, true); // optimistic, updated later on failure
              }
            } else {
              // No Pix2Tex re-OCR needed — use regex classification
              action._problemType = classification.type;
              action._problemConfidence = classification.confidence;
              action._ocrQuality = classification.ocrQuality;
            }

            if (action._problemType && action._problemType !== 'UNKNOWN') {
              log(`Problem classified: ${action._problemType} (conf=${(action._problemConfidence || 0).toFixed(0)}%, OCR quality=${(action._ocrQuality || 0).toFixed(0)}%)`, 'INFO', 'cycle');
            }
          }
        } catch (classErr: any) {
          // Non-critical: classification failure shouldn't break the cycle
          log(`Problem classification failed: ${classErr.message || classErr}`, 'DEBUG', 'cycle');
        }
      }

      // Math verification: check answer before submitting (Response 1)
      const mathVerify = _getMathVerify();
      if (mathVerify && action && mathVerify.shouldVerify(action.currentState || '')) {
        // For keypad/input actions: verify the typed value
        // For click actions on assessment: verify using text regions from pixel fallback
        let answerValue = action.value || action.keypadSequence?.map((k: any) => k.digit || k.label || '').join('') || '';
        let problemContext = action.reasoning || '';

        // Response 5: For click actions with _textRegions (pixel fallback MCQ),
        // try to construct a verification context from the text region metadata.
        // Note: pixel fallback can't OCR the actual text, but it provides density
        // and position info. The math verifier uses this as supplementary context.
        if (!answerValue && action.actionType === 'click' && action._textRegions) {
          const tr = action._textRegions;
          answerValue = `[choice at index ${action._textRegions._clickedChoiceIndex ?? '?'}]`;
          problemContext += ` [pixel-fallback: question text density=${tr.questionRegion?.density.toFixed(2)}, ` +
            `${tr.choiceRegions.length} choices detected]`;
        }

        if (answerValue && typeof answerValue === 'string' && answerValue.trim().length > 0) {
          try {
            // Use reasoning/action text as problem context, the answer value as proposed answer
            const verifyResult = await mathVerify.verifyAnswer(problemContext, answerValue);
            if (!verifyResult.correct && verifyResult.confidence > 0.7) {
              log(`Math verification FAILED (method=${verifyResult.method}, conf=${verifyResult.confidence.toFixed(2)}): ${verifyResult.explanation}. Skipping submit.`, 'WARN', 'cycle');
              // Skip this action — the answer is likely wrong. Let the next iteration re-analyze.
              action = { actionType: 'wait', currentState: action.currentState, reasoning: `Verification failed: ${verifyResult.explanation}`, targetX: 0, targetY: 0 };
              consecutiveTribunalFailures++;
              updateStats({ mathVerifyFailed: (getStats().mathVerifyFailed || 0) + 1 });
              // Continue to next loop iteration (re-screenshot and retry)
              await sleep(CONFIG.BETWEEN_STEPS_MS * wm);
              continue;
            } else if (verifyResult.correct && verifyResult.method !== 'unknown') {
              log(`Math verification PASSED (method=${verifyResult.method}, conf=${verifyResult.confidence.toFixed(2)})`, 'INFO', 'cycle');
              updateStats({ mathVerifyPassed: (getStats().mathVerifyPassed || 0) + 1 });

              // ─── Solution Cache Store (Response 5) ───
              // Store the verified solution for future reuse.
              // If this was a cache hit, record the successful reuse.
              const solCache2 = _getSolutionCache();
              if (solCache2) {
                try {
                  if (_cacheHitHash && _cacheHitProblemText) {
                    // This was a cache hit — record successful reuse
                    solCache2.recordReuseOutcome(_cacheHitHash, true);
                  } else if (problemContext) {
                    // New solution — store it
                    const steps = action.reasoning ? action.reasoning.split(/\n|\./).filter((s: string) => s.trim().length > 10).slice(0, 10) : [];
                    solCache2.store(problemContext, answerValue, steps, {
                      problemType: action._problemType || 'UNKNOWN',
                      modelUsed: action.provider || 'unknown',
                      verified: true,
                    });
                  }
                } catch (storeErr: any) {
                  log(`Solution cache store error: ${storeErr.message || storeErr}`, 'DEBUG', 'cycle');
                }
              }
            }
          } catch (verifyErr: any) {
            log(`Math verification error: ${verifyErr.message || verifyErr}. Proceeding with action.`, 'WARN', 'cycle');
          }
        }
      }

      // Quota bargaining
      if (quotaBargain && !quotaBargain.canUseProvider('openrouter') && !quotaBargain.canUseProvider('mistral')) {
        log('Quota exhausted. Finding new free models...', 'WARN', 'cycle');
        const newModels = await quotaBargain.findNewFreeModels();
        if (newModels.length > 0) {
          resetCycleProviderState();
          for (const model of newModels) {
            // Dynamic providers discovered via quota bargaining are registered but skip tribunal
            // (they need actual endpoint configuration before they can participate)
            log(`Discovered model ${model} but needs endpoint configuration`, 'DEBUG', 'cycle');
          }
        }
      }

      const preActionState = currentState;
      const startTime = Date.now();
      let actionSuccess = false;

      // Execute action with plugin pre-hook
      pluginAPI?.runHooks?.('preAction', { page, action, state: currentState });

      if (action.actionType === 'click') {
        clickAttempts++;
        const beforeBodyLen = await page.evaluate(() => document.body.innerText.length);
        if (executeAction) await executeAction(page, action);
        const afterUrl = page.url();
        const afterBodyLen = await page.evaluate(() => document.body.innerText.length);
        if (afterUrl !== beforeUrl || afterBodyLen !== beforeBodyLen) {
          clickSuccesses++;
          actionSuccess = true;
          consecutiveFailures = 0;
        } else {
          // Network replay fallback
          if (CONFIG.NETWORK_REPLAY_ON_CLICK_FAIL && network) {
            const submission = network.getLastSubmission('start');
            if (submission) {
              const replayed = await network.replayRequest(page, submission);
              if (replayed) { log('Network replay bypassed UI!', 'INFO', 'cycle'); actionSuccess = true; }
            }
          }
          // Swipe + retry
          if (!actionSuccess && gestures && executeAction) {
            await gestures.performSwipe(page, 500, 400, 500, 200);
            await executeAction(page, action);
            if (page.url() !== afterUrl) actionSuccess = true;
          }
        }
        // Canvas parsing fallback
        if (!actionSuccess && canvas && dpr) {
          const canvasData = await canvas.parseTextAndButtons(base64);
          if (canvasData.watchButton) {
            const coords = dpr.getJitteredClick(canvasData.watchButton.centerX, canvasData.watchButton.centerY);
            await page.mouse.click(coords.x, coords.y);
            actionSuccess = true;
          }
        }
        // Engine tap fallback
        if (!actionSuccess && inspector) {
          const engineTap = await inspector.dispatchTapViaEngine(page, 300, 400);
          if (engineTap) actionSuccess = true;
        }
        // Brute force fallback
        if (!actionSuccess && bruteForce) {
          const bruteSuccess = await bruteForce.bruteForceNavigate(page);
          if (bruteSuccess) actionSuccess = true;
        }
        if (actionSuccess) consecutiveFailures = 0;
      } else {
        if (executeAction) await executeAction(page, action);
        actionSuccess = true;
        consecutiveFailures = 0;
      }

      // ─── Pixel Calibration Sampling ───
      // After a successful click, sample the button color at click coordinates.
      // This builds a distribution of observed colors per category, so pixel-fallback
      // can adapt if MathU changes its color scheme.
      if (actionSuccess && action.actionType === 'click' && (action.targetX > 0 || action.targetY > 0)) {
        try {
          const pixelCal = require('./pixel-calibration');
          const pngShot = await page.screenshot({ type: 'png', fullPage: false }).catch(() => null);
          if (pngShot && pngShot.length > 100) {
            // Use DPR-adjusted coordinates (action coords are in viewport pixels)
            const dprMod = require('./browser');
            const dpr = dprMod._dprScale || 1.0;
            pixelCal.sampleAtCoordinates(
              pngShot,
              Math.round(action.targetX * dpr),
              Math.round(action.targetY * dpr),
              action.actionType
            ).catch(() => {});
            // Also sample surrounding area (background, adjacent elements)
            pixelCal.sampleSurroundings(
              pngShot,
              Math.round(action.targetX * dpr),
              Math.round(action.targetY * dpr),
              action.actionType
            ).catch(() => {});
          }
        } catch (calErr: any) {
          log(`Pixel calibration sampling failed: ${calErr.message || calErr}`, 'DEBUG', 'cycle');
        }
      }

      // ─── Pixel Training: Record successful action for self-training ───
      // After EVERY successful click (from any source — AI, pixel-fallback,
      // pixel-explorer, action cache), record the (screenshot, action, result)
      // triple so pixel-fallback can learn from it.
      if (actionSuccess && action.actionType === 'click' && (action.targetX > 0 || action.targetY > 0)) {
        try {
          const pixelTraining = require('./pixel-training');
          if (pixelTraining && pixelTraining.recordSuccess) {
            // Reuse the PNG from calibration if available, otherwise training will capture its own
            const trainingPng = (typeof pngShot !== 'undefined' && pngShot && pngShot.length > 100) ? pngShot : undefined;
            pixelTraining.recordSuccess({
              page,
              action,
              screenshotBuf: trainingPng,
              pageFingerprint: typeof screenshotHash === 'string' ? screenshotHash : '',
              viewportWidth: 1280,
              viewportHeight: 720,
              latencyMs: Date.now() - startTime,
            }).catch(() => {});
          }
        } catch (trainErr: any) {
          log(`Pixel training recording failed: ${trainErr.message || trainErr}`, 'DEBUG', 'cycle');
        }
      }

      // ─── Pixel Explorer Outcome Observation ───
      // If this was a pixel-explorer action, observe the outcome to learn from it.
      if (actionSuccess && action._pixelExplorer && action._explorationMapKey) {
        try {
          const pixelExplorer = require('./pixel-explorer');
          // screenshotHash was captured before the action as `screenshotHash` variable
          pixelExplorer.observeOutcome(
            page,
            typeof screenshotHash === 'string' ? screenshotHash : '',
            action._explorationMapKey,
            action._explorationCellCx || action.targetX,
            action._explorationCellCy || action.targetY
          ).catch(() => {});
        } catch (expErr: any) {
          log(`Pixel explorer outcome observation failed: ${expErr.message || expErr}`, 'DEBUG', 'cycle');
        }
      }

      // ─── Action Cache Save / Failure Tracking ───
      // After action execution, update the cache:
      // - Success: save the action (if not from cache) for future reuse
      // - Failure: record failure count; evict if too many consecutive failures
      if (_actionCacheSig && actionCache) {
        if (actionSuccess && !_actionCacheHit) {
          // Save new successful action to cache (only if it wasn't already from cache)
          // This builds the cache over time as the bot discovers working actions
          try {
            actionCache.save(_actionCacheSig, {
              actionType: action.actionType,
              targetX: action.targetX,
              targetY: action.targetY,
              value: action.value || '',
              keypadSequence: action.keypadSequence,
              currentState: action.currentState || currentState || 'unknown',
              reasoning: action.reasoning,
            });
          } catch (saveErr: any) {
            log(`Action cache save error: ${saveErr.message || saveErr}`, 'DEBUG', 'cycle');
          }
        } else if (!actionSuccess && _actionCacheHit) {
          // Cached action failed — record failure and possibly evict
          const evicted = actionCache.recordFailure(_actionCacheSig);
          if (evicted) {
            log('Action cache entry evicted due to repeated failures — will re-query AI next cycle', 'WARN', 'cycle');
          }
        }
      }

      // ─── Module Download Wait Logic (Response 3) ───
      // After executing a download click, wait for the module content to appear.
      // Uses screenshot hash comparison to detect when the page changes.
      if (_moduleDownloadState === 'download_clicked' && actionSuccess) {
        log('Module download flow: waiting for content to change...', 'INFO', 'cycle');
        const downloadStartTime = Date.now();
        let contentAppeared = false;
        const { sleep: dlSleep } = require('./utils-sleep');

        // Poll for screenshot change (indicates download started/completed)
        while (Date.now() - downloadStartTime < MODULE_DOWNLOAD_TIMEOUT_MS) {
          await dlSleep(MODULE_DOWNLOAD_POLL_INTERVAL_MS);
          try {
            const pollScreenshot = await page.screenshot({ type: 'jpeg', quality: 30 });
            const pollHash = crypto.createHash('md5').update(pollScreenshot).digest('hex');

            if (pollHash !== _preDownloadScreenshotHash) {
              // Screenshot changed — download has started or completed
              _moduleDownloadState = 'downloading';
              log('Module download flow: screenshot changed, download in progress', 'INFO', 'cycle');

              // Wait additional time for content to fully render
              await dlSleep(2000);

              // Check if module content (topic buttons) is now visible via pixel analysis
              try {
                const pngScreenshot = await page.screenshot({ type: 'png', fullPage: false });
                const pixelMod = require('./pixel-fallback');
                const decoded = pixelMod._decodePNG?.(pngScreenshot);
                if (decoded && pixelMod._isModuleContentLoaded?.(decoded.rgba, decoded.width, decoded.height)) {
                  _moduleDownloadState = 'content_visible';
                  log('Module download flow: content loaded! Topics visible.', 'INFO', 'cycle');
                  contentAppeared = true;
                }
              } catch (pxErr: any) {
                log(`Module download flow: pixel check failed (${pxErr.message || pxErr}), assuming content loaded`, 'DEBUG', 'cycle');
                // If pixel check fails, assume content loaded after screenshot change
                contentAppeared = true;
                _moduleDownloadState = 'content_visible';
              }
              break;
            }
          } catch (pollErr: any) {
            log(`Module download flow: poll screenshot failed (${pollErr.message || pollErr})`, 'DEBUG', 'cycle');
          }
        }

        if (!contentAppeared) {
          // Download may still be in progress or failed
          const elapsed = Date.now() - downloadStartTime;
          if (elapsed >= MODULE_DOWNLOAD_TIMEOUT_MS) {
            log(`Module download flow: timeout after ${elapsed / 1000}s. Scrolling and retrying.`, 'WARN', 'cycle');
            _moduleDownloadRetryCount++;
            if (_moduleDownloadRetryCount <= MODULE_DOWNLOAD_MAX_RETRIES) {
              // Try scrolling and clicking the card again
              try { await page.evaluate(() => window.scrollBy(0, -200)); } catch { /* non-critical */ }
              await dlSleep(1000);
              _moduleDownloadState = 'idle'; // Reset to try again on next cycle
            } else {
              log(`Module download flow: max retries (${MODULE_DOWNLOAD_MAX_RETRIES}) exceeded. Moving on.`, 'WARN', 'cycle');
              _moduleDownloadState = 'idle';
            }
          } else {
            // Still waiting — stay in download_clicked state for next cycle to continue polling
            log('Module download flow: still waiting, will poll again next cycle', 'DEBUG', 'cycle');
          }
        }

        // If content is now visible, let the next cycle iteration find Watch/Start buttons
        if (_moduleDownloadState === 'content_visible') {
          _moduleDownloadState = 'idle';
          _preDownloadScreenshotHash = null;
          // Don't set currentState to module_downloading — let the next iteration
          // detect the assignments page with visible topic buttons
          // Force a new screenshot on the next iteration by jumping to top of loop
          await dlSleep((CONFIG.BETWEEN_STEPS_MS || 2000) * 1);
          continue;
        }
      }

      // If download was clicked but action failed (click didn't register)
      if (_moduleDownloadState === 'download_clicked' && !actionSuccess) {
        log('Module download flow: click failed, will retry on next cycle', 'DEBUG', 'cycle');
        _moduleDownloadState = 'idle'; // Reset so we can try again
      }

      // Record experiment result
      const latency = Date.now() - startTime;
      if (strategyVariants?.getActiveExperiment?.()) {
        strategyVariants.recordExperimentResult?.(actionSuccess, latency);
        const exp = strategyVariants.getActiveExperiment();
        if (exp?.results?.attempts >= 30) {
          if (strategyVariants.shouldPromoteExperiment?.()) {
            strategyVariants.promoteActiveExperiment?.();
          } else {
            strategyVariants.revertExperiment?.(exp);
          }
        }
      }

      // Adaptive performance
      if (CONFIG.ENABLE_ADAPTIVE_PERFORMANCE && adaptiveEngine) { adaptiveEngine.recordLatency(latency); }

      // Blackbox recording
      if (CONFIG.ENABLE_BLACKBOX && blackbox) {
        const semanticsSnapshot = await _getA11ySnapshot().getA11ySnapshot(page);
        blackbox.record({ state: action.currentState, action: action.actionType, semantics: JSON.stringify(semanticsSnapshot).substring(0, 500), hash: screenshotHash, success: actionSuccess ? 1 : 0, reasoning: action.reasoning || '', latency, provider_used: action.provider || 'unknown' });
        if (insertSemanticsSnapshot) insertSemanticsSnapshot.run(Date.now(), semanticsSnapshot ? Object.keys(semanticsSnapshot).length : 0, JSON.stringify(semanticsSnapshot).substring(0, 1000));
      }

      // Flutter semantics persistence
      if (CONFIG.ENABLE_FLUTTER_SEMANTICS && semantics) {
        const items = await semantics.getInteractiveItems(page, true);
        // v5-fix: Use DI-injected insertFlutterSemantics instead of inline require('./database')
        const insertFlutterSemantics = dbHelpers.insertFlutterSemantics || null;
        insertFlutterSemantics?.run?.(page.url(), JSON.stringify(items.slice(0, 50)), Date.now());
      }

      // Stagnation recovery & module tracking
      if (recoverIfStuck) await recoverIfStuck(page, screenshot, action);
      if (trackModuleProgress) await trackModuleProgress(page, base64);
      // ── Memory: release screenshot + base64 after ALL consumers ──
      // This is the last place either is used in the loop iteration.
      // Nulling frees ~20-60KB (base64) + ~15-25KB (raw Buffer) immediately.
      screenshot = null as any;
      base64 = null as any;
      _actionCacheSig = null;
      // Resilience: semantic progress detection
      if (progressSemanticDetector) {
        try {
          const semState = await progressSemanticDetector.getSemanticState(page);
          if (semState) {
            log(`Semantic state: Q${semState.questionNumber}/${semState.totalQuestions} module=${semState.module} score=${semState.score}`, 'DEBUG', 'cycle');
          }
        } catch (e: any) { /* non-critical */ }
      }

      // Module completion
      if (['score_screen', 'pathway_feedback'].includes(action.currentState) && action.currentState !== currentState) {
        questionsCompleted++;
        _midQuiz = false; // v6: quiz done, safe to close browser for memory
        try { const memoryMode = require('./memory-mode'); memoryMode.setMidQuiz(false); } catch {}
        lastQuestionCompletionTime = Date.now();
        lastScreenshotChangeTime = Date.now();
        updateStats({ questionsCompleted });
        // Notify health watchdog of progress (Response 2)
        _getHealthWatchdog()?.notifyProgress?.();
        trackProgress?.({ action: action.actionType, state: action.currentState, timestamp: new Date().toISOString(), questionsCompleted });
        if (upsertLastState) upsertLastState.run(page.url(), action.currentState, Date.now());
        consecutiveFailures = 0;
        saveCheckpoint?.({ url: page.url(), state: action.currentState, questionsCompleted });
        // Run solution cache maintenance every 100 questions (Response 5)
        if (questionsCompleted % 100 === 0) {
          try { _getSolutionCache()?.runMaintenance?.(); } catch { /* non-critical */ }
          try { _getActionCache()?.runMaintenance?.(); } catch { /* non-critical */ }
        }
        if (currentModule && recordModuleCompletion) {
          const timeTaken = Date.now() - cycleStart;
          recordModuleCompletion(currentModule, timeTaken);
          log(`Module ${currentModule} completed in ${timeTaken / 1000}s`, 'INFO', 'cycle');
          currentModule = getNextModule?.();
          if (currentModule) { log(`Next module: ${currentModule}`, 'INFO', 'cycle'); }
        }
      }

      // Resilience: speed benchmark timeout check
      if (progressSpeedBenchmark && action.currentState === preActionState) {
        const speedCheck = progressSpeedBenchmark.checkSpeedTimeout(startTime, action.currentState);
        if (speedCheck?.timedOut) {
          log(`Speed timeout: ${speedCheck.currentTime}ms > 3x avg ${speedCheck.avgTime?.toFixed(0)}ms. Forcing skip.`, 'WARN', 'cycle');
        }
      }
      // Stuck detection
      if (action.currentState === preActionState && !actionSuccess) {
        stuckCounter++;
        consecutiveTribunalFailures++;
      } else {
        stuckCounter = 0;
        consecutiveTribunalFailures = 0;
        explorationFailures = 0;
        explorationMode = false;
      }

      // Unknown state escape hatch — prevents 75s × N death spiral
      // When providers can't determine the page state, they return 'unknown'
      // and default to 'wait', creating an infinite idle loop. After
      // MAX_UNKNOWN_STATE consecutive unknowns, force a page reload to
      // break the cycle and potentially land on a recognizable page.
      if (action.currentState === 'unknown' || !action.currentState) {
        unknownStateCounter++;
        // 20-min stagnation auto-ban: if no screenshot change + no question completion
        // for 20+ minutes in unknown/error loop, auto-ban 'wait' to force reload
        const timeSinceScreenshotChange = Date.now() - lastScreenshotChangeTime;
        const timeSinceQuestionCompletion = Date.now() - lastQuestionCompletionTime;
        if (!stagnationAutoBanTriggered
            && action.actionType === 'wait'
            && timeSinceScreenshotChange > STAGNATION_AUTO_BAN_MS
            && timeSinceQuestionCompletion > STAGNATION_AUTO_BAN_MS) {
          log(`20-min stagnation detected in unknown loop (no screenshot change, no completions). Auto-banning wait action.`, 'WARN', 'cycle');
          try {
            const dbMod = require('./database');
            dbMod.insertBannedAction?.('wait', 'stagnation-guard', Date.now() + 60 * 60 * 1000);
          } catch { /* non-critical */ }
          stagnationAutoBanTriggered = true;
          try {
            const sendAlert = require('./alerting').sendAlert;
            sendAlert?.('20-min stagnation auto-ban triggered: wait action banned');
          } catch { /* non-critical */ }
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          lastScreenshotChangeTime = Date.now();
          continue;
        }
        if (unknownStateCounter >= MAX_UNKNOWN_STATE) {
          log(`Unknown state ${unknownStateCounter} times in a row. Trying pixel fallback before reload.`, 'WARN', 'cycle');
          unknownStateCounter = 0;
          // Try pixel-based fallback before reloading — it can handle login pages
          // and other pages even when AI, DOM, and semantics are all unavailable
          try {
            const pixelFallback = require('./pixel-fallback');
            const pixelAction = await pixelFallback.generatePixelFallbackAction(page, currentState || undefined);
            if (pixelAction && pixelAction.actionType && pixelAction.actionType !== 'wait') {
              log(`Pixel fallback saved us: ${pixelAction.actionType} at (${pixelAction.targetX}, ${pixelAction.targetY}) state=${pixelAction.currentState}`, 'INFO', 'cycle');
              if (executeAction) await executeAction(page, pixelAction);
              lastScreenshotChangeTime = Date.now();
              continue;
            }
          } catch (pfErr: any) {
            log(`Pixel fallback attempt failed: ${pfErr.message || pfErr}`, 'DEBUG', 'cycle');
          }
          // Pixel fallback didn't help — fall back to reload
          try {
            const currentUrl = page.url();
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            // If still on same page after reload, try navigating to BASE_URL
            if (page.url() === currentUrl && CONFIG.BASE_URL) {
              log('Reload didn\'t change page, navigating to BASE_URL.', 'WARN', 'cycle');
              await page.goto(CONFIG.BASE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
            }
          } catch (reloadErr: any) {
            log(`Page reload failed: ${reloadErr.message || reloadErr}`, 'WARN', 'cycle');
          }
          continue; // Skip the wait action and re-evaluate on next iteration
        }
      // Also handle 'error' state — same death spiral as unknown
      } else if (action.currentState === 'error') {
        // 20-min stagnation auto-ban for error loops
        const timeSinceScreenshotChange = Date.now() - lastScreenshotChangeTime;
        const timeSinceQuestionCompletion = Date.now() - lastQuestionCompletionTime;
        if (!stagnationAutoBanTriggered
            && action.actionType === 'wait'
            && timeSinceScreenshotChange > STAGNATION_AUTO_BAN_MS
            && timeSinceQuestionCompletion > STAGNATION_AUTO_BAN_MS) {
          log(`20-min stagnation detected in error loop (no screenshot change, no completions). Auto-banning wait action.`, 'WARN', 'cycle');
          try {
            const dbMod = require('./database');
            dbMod.insertBannedAction?.('wait', 'stagnation-guard', Date.now() + 60 * 60 * 1000);
          } catch { /* non-critical */ }
          stagnationAutoBanTriggered = true;
          try {
            const sendAlert = require('./alerting').sendAlert;
            sendAlert?.('20-min stagnation auto-ban triggered: wait action banned');
          } catch { /* non-critical */ }
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          lastScreenshotChangeTime = Date.now();
          continue;
        }
      } else {
        unknownStateCounter = 0;
        // Auto-rearm: if screenshot changes within 60s of ban, clear the flag
        if (stagnationAutoBanTriggered && (Date.now() - lastScreenshotChangeTime) < 60000) {
          stagnationAutoBanTriggered = false;
          try {
            const dbMod = require('./database');
            dbMod.deleteBannedAction?.('wait', 'stagnation-guard');
          } catch { /* non-critical */ }
        }
      }

      // Exploration mode
      if (consecutiveTribunalFailures >= CONFIG.EXPLORATION_CONSECUTIVE_FAILURES && CONFIG.ENABLE_EXPLORATION_PASS && explorationCartographer) {
        log(`${consecutiveTribunalFailures} consecutive tribunal failures. Entering exploration mode.`, 'WARN', 'cycle');
        explorationMode = true;
        explorationMap = await explorationCartographer.explore(page);
        if (explorationMap) { log('Exploration map built. Continuing with enhanced context.', 'INFO', 'cycle'); consecutiveTribunalFailures = 0; } else { log('Exploration failed to produce map.', 'WARN', 'cycle'); }
      }

      // Stuck recovery
      if (stuckCounter >= MAX_STUCK) {
        log(`Stuck for ${MAX_STUCK} cycles. Attempting recovery.`, 'WARN', 'cycle');
        if (humanCaptcha) {
          const restored = await humanCaptcha.tryAllSessions(page);
          if (restored) { log('Session pool restored access.', 'INFO', 'cycle'); stuckCounter = 0; }
        }
        if (stuckCounter >= MAX_STUCK) {
          const codegenTribunal = _getCodegenTribunal();
          if (codegenTribunal) {
          const investigation = { url: page.url(), html: await page.content(), fileContent: 'Unknown', targetFile: 'cycle-cycle-manager.ts' };
          const errorLogs = `Stuck for ${MAX_STUCK} cycles at state ${currentState}`;
          const fixes = await codegenTribunal.generateCodeFixViaTribunal(investigation, errorLogs);
          if (fixes && fixes.length > 0 && CONFIG.GITOPS_ENABLED && gitOps?.applyAndVerify) {
            try { await gitOps.applyAndVerify(fixes); log('Self-heal applied via GitOps. Restarting cycle.', 'INFO', 'cycle'); throw new Error('RESTART_CYCLE'); } catch (e: any) { if (e.message === 'RESTART_CYCLE') throw e; gitOps.rollbackToPrevious?.(); }
          }
          } // end codegenTribunal block
        }
      }

      currentState = action.currentState;
      // v6: Track mid-quiz state for browser-preserving memory shedding.
      // We're "mid-quiz" when the state indicates we're on a question page
      // (not assignments, not score screen, not module downloading).
      // This drives the preserveBrowser flag in memory protection.
      const _quizStates = new Set(['question', 'question_m mcq', 'question_input', 'keypad', 'question_feedback', 'explanation', 'assessment', 'quiz_active']);
      _midQuiz = _quizStates.has(action.currentState || '') || (action.currentState === 'question' || action.actionType === 'keypad_input' || action.actionType === 'keypad_sequence');
      // Also update the module-level flag so render-free-plan monitor can read it
      try { const memoryMode = require('./memory-mode'); memoryMode.setMidQuiz(_midQuiz); } catch {}
      // ── Dashboard state ban enforcement ──
      // If the current state has been banned from the dashboard, skip
      // it and force a page reload to escape the banned state.
      try {
        const persistConfig = require('./persistent-config');
        if (persistConfig.isStateBanned(currentState)) {
          log(`State '${currentState}' is banned via dashboard — forcing page reload to escape`, 'WARN', 'cycle');
          await page.reload({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
          currentState = 'assignments_page'; // Reset to safe state
          continue; // Re-evaluate on next iteration
        }
      } catch { /* non-critical: persistent-config not available */ }
      if (questionsCompleted > 0) lastProgressTime = Date.now();
      else if (Date.now() - lastProgressTime > CONFIG.PROGRESS_TIMEOUT_MS) { throw new Error('Progress timeout'); }

      // Save session to pool
      if (humanCaptcha) {
        const storage = await page.context().storageState();
        humanCaptcha.saveSessionToPool(storage);
      }
    }

    // Post-cycle alerting
    if (clickAttempts > 5) {
      const successRate = clickSuccesses / clickAttempts;
      if (successRate < 0.3) { log(`Click success rate too low (${(successRate * 100).toFixed(0)}%). Triggering alert.`, 'WARN', 'cycle'); if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Low click success rate: ${successRate}`); } catch (e: any) {} }
    }
    log(`Cycle complete: ${questionsCompleted} questions processed`, 'INFO', 'cycle');
    consecutiveFailures = 0;

    // ─── Training maintenance: prune old data every 50 cycles ───
    const _cycleNum = getStats().cycleCount || 0;
    if (_cycleNum % 50 === 0) {
      try {
        const pixelTraining = require('./pixel-training');
        if (pixelTraining?.getStatus?.()?.dbRowCount > 200) {
          // pruneOldData not in existing API — rely on MAX_SAMPLES_PER_STATE in recordSuccess
          log(`Training data: ${pixelTraining.getStatus().dbRowCount} entries in DB`, 'DEBUG', 'cycle');
        }
      } catch {}
    }
  } catch (err: any) {
    const errorType = classifyProviderError?.(err);
    const isRetryable = errorType?.retryable ?? false;
    const isHealable = errorType?.healable ?? false;
    const errorCode = errorType?.code || 'E_UNKNOWN';
    logError(`Cycle error (${errorCode})`, err);
    // Resilience: report failure to cascade breaker
    cascadeBreaker?.recordFailure?.('cycleManager', err);
    // Resilience: report failure to module quarantine
    runtimeModuleQuarantine?.recordFailure?.('cycleManager', err);
    updateStats({ errors: (getStats().errors || 0) + 1 });
    consecutiveFailures++;
    // v4: Record error code for desperation analysis
    _recordErrorForDesperation(errorCode);
    if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Cycle error: ${err instanceof Error ? err.message : String(err)}`); } catch (e: any) {}

    // Error routing based on type
    const isErrorTransient = isRetryable && !isHealable;
    const isErrorFatal = !isRetryable && !isHealable;

    if (isErrorTransient) {
      log('Transient error -- will retry next cycle', 'WARN', 'cycle');
    } else if (isErrorFatal) {
      log('Fatal error -- restarting cycle', 'ERROR', 'cycle');
    } else {
      // v4: Only attempt self-heal when the bot is DESPERATELY broken.
      // See _isDesperatelyBroken() for the full criteria.
      if (CONFIG.SELF_HEAL_ENABLED && !selfHealRunning && performSelfHeal && _isDesperatelyBroken(CONFIG)) {
        log(`${consecutiveFailures} consecutive failures (DESPERATE: error pattern analysis passed). Attempting self-heal...`, 'WARN', 'cycle');
        selfHealRunning = true;
        performSelfHeal().then((healed: any) => { 
          selfHealRunning = false;
          if (healed) { log('Self-heal successful. Resetting failure count.', 'INFO', 'cycle'); consecutiveFailures = 0; }
          else { log('Self-heal failed. Alerting and stopping.', 'ERROR', 'cycle'); if (CONFIG.ALERT_ON_ERROR) try { sendAlert('Self-heal failed after multiple attempts. Stopping.'); } catch (e: any) {} stopRequested = true; }
        }).catch((e: any) => { selfHealRunning = false; logError('Self-heal threw error', e); });
      } else if (CONFIG.SELF_HEAL_ENABLED && consecutiveFailures >= CONFIG.SELF_HEAL_FAILURE_THRESHOLD) {
        log(`${consecutiveFailures} consecutive failures but NOT desperate (transient/error pattern). Skipping self-heal. Will keep retrying.`, 'DEBUG', 'cycle');
      }
      if (consecutiveFailures % 5 === 0) {
        try { const pd = _getProviderDiscovery(); if (pd?.refreshAllProviderModels) pd.refreshAllProviderModels().catch((e: any) => logError('Model refresh failed', e)); } catch (e: any) { /* non-critical */ }
      }
      if (consecutiveFailures % 10 === 0) {
        try { const pr = _getProcessRetrainer(); if (pr?.retrainProcesses) pr.retrainProcesses().catch((e: any) => logError('Retraining failed', e)); } catch (e: any) { /* non-critical */ }
      }
    }
  } finally {
    // v6: Clear mid-quiz flag so monitors don't preserve browser after cycle ends
    try { const memoryMode = require('./memory-mode'); memoryMode.setMidQuiz(false); } catch {}
    if (closeBrowser) await closeBrowser();
    if (clearCache) clearCache();
    _networkSetup = false;
    if (CONFIG.ENABLE_GC_ON_CYCLE && global.gc) { global.gc(); log('Garbage collection triggered.', 'DEBUG', 'cycle'); }
  }
}

module.exports = { runCycle, requestStop, isOrParked: () => _orParked, _injectDependencies };
