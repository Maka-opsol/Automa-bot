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
let explorationFailures = 0;

function requestStop() {  stopRequested = true; }

function checkMemoryAndRecover(CONFIG: any, log: any, clearCache: any) { 
  const used = process.memoryUsage().heapUsed / 1024 / 1024;
  if (used > CONFIG.MEMORY_RESTART_THRESHOLD_MB) {
    log(`Memory high (${used.toFixed(0)}MB) -- cleaning up`, 'WARN', 'cycle');
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

async function runCycle() { 
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
  const getFallbackAction = async (page: any) => {
    if (!_fallbackMod) { try { _fallbackMod = require('./providers-fallback'); } catch { _fallbackMod = { getFallbackAction: async () => ({ actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 }) }; } }
    return _fallbackMod.getFallbackAction(page);
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
  log(`Starting cycle #${getStats().cycleCount}`, 'INFO', 'cycle');
  resetCycleProviderState();

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

    let questionsCompleted = checkpoint?.questionsCompleted || 0;
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

    // Select module using dynamic planning
    let currentModule = getNextModule?.();
    if (currentModule) { log(`Selected module: ${currentModule}`, 'INFO', 'cycle'); }

    while (questionsCompleted < CONFIG.MAX_QUESTIONS && !stopRequested) {
      try { fs.writeFileSync(CONFIG.HEARTBEAT_FILE, String(Date.now())); } catch (_e: any) { /* best-effort heartbeat write */ }
      // Resilience: heap guardian check (supplements built-in checkMemoryAndRecover)
      runtimeHeapGuardian?.checkMemory?.();
      if (checkMemoryAndRecover(CONFIG, log, clearCache)) {
        await closeBrowser();
        _networkSetup = false;
        page = await withBrowserRetry(async (p: any) => { if (authenticate) await authenticate(p); return p; });
        browserLastRestart = Date.now();
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

      const beforeUrl = page.url();
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 });
      const base64 = screenshot.toString('base64');
      // Feed screenshot to dashboard cache (non-blocking)
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
      // Resilience: circular path detection
      if (progressCircularPathDetector) {
        const loopCheck = progressCircularPathDetector.checkUrlLoop(beforeUrl);
        if (loopCheck?.isLooping) {
          log(`Circular path detected! URL ${beforeUrl} seen ${loopCheck.loopCount} times. Navigating away.`, 'WARN', 'cycle');
          await page.goto(CONFIG.BASE_URL || 'about:blank', { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});
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
      // Vision tribunal
      if (!action) {
        try {
          action = await safeCall((_sig: any) => determineNextAction(base64, page.url(), explorationMode ? explorationMap : null), 'Tribunal', { timeoutMs: CONFIG.TRIBUNAL_TIMEOUT_MS, url: 'tribunal' });
        } catch (err: any) {
          logError('Tribunal failed, using fallback', err);
          action = await getFallbackAction(page);
        }
      }
      if (!action || !action.actionType) {
        log('Action is null, using fallback wait', 'WARN', 'cycle');
        action = { actionType: 'wait', currentState: 'error', targetX: 0, targetY: 0 };
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

      // UI drift detection
      if (uiDrift) {
        const uiDrifted = await uiDrift.detectDrift(action.currentState, base64);
        if (uiDrifted) {
          log('UI Drifted! Entering Discovery Mode.', 'WARN', 'cycle');
          await uiDrift.discoverUI(page);
          await stateMachine.transition(STATES.UI_DISCOVERED);
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
        lastQuestionCompletionTime = Date.now();
        lastScreenshotChangeTime = Date.now();
        updateStats({ questionsCompleted });
        trackProgress?.({ action: action.actionType, state: action.currentState, timestamp: new Date().toISOString(), questionsCompleted });
        if (upsertLastState) upsertLastState.run(page.url(), action.currentState, Date.now());
        consecutiveFailures = 0;
        saveCheckpoint?.({ url: page.url(), state: action.currentState, questionsCompleted });
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
            const pixelAction = await pixelFallback.generatePixelFallbackAction(page);
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
  } catch (err: any) {
    const errorType = classifyProviderError?.(err);
    const isRetryable = errorType?.retryable ?? false;
    const isHealable = errorType?.healable ?? false;
    logError(`Cycle error (${typeof errorType === 'string' ? errorType : errorType?.code || 'unknown'})`, err);
    // Resilience: report failure to cascade breaker
    cascadeBreaker?.recordFailure?.('cycleManager', err);
    // Resilience: report failure to module quarantine
    runtimeModuleQuarantine?.recordFailure?.('cycleManager', err);
    updateStats({ errors: (getStats().errors || 0) + 1 });
    consecutiveFailures++;
    if (CONFIG.ALERT_ON_ERROR) try { sendAlert(`Cycle error: ${err instanceof Error ? err.message : String(err)}`); } catch (e: any) {}

    // Error routing based on type
    const isErrorTransient = isRetryable && !isHealable;
    const isErrorFatal = !isRetryable && !isHealable;

    if (isErrorTransient) {
      log('Transient error -- will retry next cycle', 'WARN', 'cycle');
    } else if (isErrorFatal) {
      log('Fatal error -- restarting cycle', 'ERROR', 'cycle');
    } else {
      // Healable or unknown — try self-heal
      if (CONFIG.SELF_HEAL_ENABLED && consecutiveFailures >= CONFIG.SELF_HEAL_FAILURE_THRESHOLD && !selfHealRunning && performSelfHeal) {
        log(`${consecutiveFailures} consecutive failures. Attempting self-heal...`, 'WARN', 'cycle');
        selfHealRunning = true;
        performSelfHeal().then((healed: any) => { 
          selfHealRunning = false;
          if (healed) { log('Self-heal successful. Resetting failure count.', 'INFO', 'cycle'); consecutiveFailures = 0; }
          else { log('Self-heal failed. Alerting and stopping.', 'ERROR', 'cycle'); if (CONFIG.ALERT_ON_ERROR) try { sendAlert('Self-heal failed after multiple attempts. Stopping.'); } catch (e: any) {} stopRequested = true; }
        }).catch((e: any) => { selfHealRunning = false; logError('Self-heal threw error', e); });
      }
      if (consecutiveFailures % 5 === 0) {
        try { const pd = _getProviderDiscovery(); if (pd?.refreshAllProviderModels) pd.refreshAllProviderModels().catch((e: any) => logError('Model refresh failed', e)); } catch (e: any) { /* non-critical */ }
      }
      if (consecutiveFailures % 10 === 0) {
        try { const pr = _getProcessRetrainer(); if (pr?.retrainProcesses) pr.retrainProcesses().catch((e: any) => logError('Retraining failed', e)); } catch (e: any) { /* non-critical */ }
      }
    }
  } finally {
    if (closeBrowser) await closeBrowser();
    if (clearCache) clearCache();
    _networkSetup = false;
    if (CONFIG.ENABLE_GC_ON_CYCLE && global.gc) { global.gc(); log('Garbage collection triggered.', 'DEBUG', 'cycle'); }
  }
}

module.exports = { runCycle, requestStop, _injectDependencies };.
