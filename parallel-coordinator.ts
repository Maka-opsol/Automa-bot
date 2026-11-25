// ═══════════════════════════════════════════════════════════════════════
// Parallel Browser Coordinator v2 — task-based distribution
// ═══════════════════════════════════════════════════════════════════════
//
// ARCHITECTURE:
//
//   ┌─────────────────────────────────────────────────────┐
//   │  Coordinator (main process)                        │
//   │  • Launches 1 Chrome with N browser contexts       │
//   │  • Each worker claims a MODULE (task) from Turso    │
//   │  • Modules = video, exercise, memo, assessment      │
//   │  • Worker completes the ENTIRE module, then claims next │
//   └─────────────────────────────────────────────────────┘
//          │              │              │
//          ▼              ▼              ▼
//     ┌─────────┐    ┌─────────┐    ┌─────────┐
//     │Worker 0 │    │Worker 1 │    │Worker 2 │
//     │Task:    │    │Task:    │    │Task:    │
//     │Video 3  │    │Exer. 5  │    │Memo 2   │
//     │(watching)│   │(solving)│   │(writing)│
//     └─────────┘    └─────────┘    └─────────┘
//
// MATHU APP FLOW (per worker):
//   1. Login (if needed) — each worker has own session
//   2. Navigate to /assignments
//   3. Find an uncompleted module card
//   4. Click it → enters the module
//   5. Complete the module:
//      - Video: wait 2m59s, then click "Next"/"Done"
//      - Exercise: answer questions until score screen
//      - Memo: type the memo content, submit
//   6. Return to /assignments
//   7. Mark module as done in Turso
//   8. Claim next uncompleted module
//
// TASK TYPES:
//   - 'video'       — watch a video (must wait 2m59s)
//   - 'exercise'    — answer math questions
//   - 'memo'        — write/type a memo
//   - 'assessment'  — take a test
//   - 'unknown'     — let the AI tribunal figure it out
//
// COORDINATION:
//   - Turso `completed_modules` table tracks which modules are done
//   - Workers atomically claim modules via `UPDATE ... RETURNING`
//   - If a worker crashes, its module is released after 10 min
//   - No two workers work on the same module simultaneously
// ═══════════════════════════════════════════════════════════════════════

'use strict';

import { navigateWorkerEntry } from './worker-navigation-recovery';

let _deps: any = {};
const renderSignals = new WeakMap<object, any>();
const renderPollReports = new WeakMap<object, number>();
function _injectDependencies(deps: any) { _deps = deps; }
function getCONFIG(): any { return _deps.config || require('./config'); }
function getLog(): (msg: string, level?: string, mod?: string) => void {
  return _deps.logger?.log || ((msg: string, level?: string) => console.log(`[${level || 'INFO'}] [parallel] ${msg}`));
}
function getLogError() { return _deps.logger?.logError || ((msg: string, err: Error) => console.error(msg, err)); }
function getShipper(): any { try { return require('./dashboard-shipper'); } catch { return null; } }

interface WorkerState {
  id: number;
  page: any;
  context: any;
  status: 'idle' | 'logging_in' | 'browsing_assignments' | 'in_module' | 'completing_video' | 'answering_question' | 'writing_memo' | 'error' | 'done';
  currentModule: { name: string; type: string; claimedAt: number } | null;
  modulesCompleted: number;
  errors: number;
  lastActivity: number;
  authNetDiag?: any;
}

class ParallelCoordinator {
  private workers: Map<number, WorkerState> = new Map();
  private browser: any = null;
  private browserManager: any = null;
  private running: boolean = false;
  private startTime: number = 0;

  async start(): Promise<void> {
    const log = getLog();
    const workerCount = parseInt(process.env.PARALLEL_WORKERS || '3', 10);
    log(`[PARALLEL] Starting coordinator with ${workerCount} workers (task-based)...`, 'INFO', 'parallel');

    // Launch the shared browser
    const browserMod = require('./browser');
    const browserManager = browserMod.browserManager;
    if (!browserManager) throw new Error('Browser manager not available');

    log('[PARALLEL] Launching shared Chrome instance...', 'INFO', 'parallel');
    await browserManager.launch();
    this.browser = browserManager.browserInstance;
    this.browserManager = browserManager;
    if (!this.browser) throw new Error('Browser launch failed');

    // Create N worker contexts
    for (let i = 0; i < workerCount; i++) {
      try {
        await this._createWorker(i);
      } catch (err: any) {
        log(`[PARALLEL] Failed to create worker ${i}`, 'ERROR', 'parallel');
      }
    }

    log(`[PARALLEL] ✅ ${this.workers.size}/${workerCount} workers ready`, 'INFO', 'parallel');
    this.running = true;
    this.startTime = Date.now();

    // Start worker loops
    for (const [id, _] of this.workers) {
      this._runWorkerLoop(id).catch((err: any) => {
        log(`[PARALLEL] Worker ${id} loop crashed`, 'ERROR', 'parallel');
      });
    }

    this._startHealthMonitor();
  }

  private async _createWorker(id: number): Promise<void> {
    const log = getLog();
    log(`[PARALLEL] Creating worker ${id} (context + page)...`, 'INFO', 'parallel');

    const context = await this.browser.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    });

    const page = await context.newPage();
    // Apply the same fingerprint / pdf.js-mitigation init script the singleton page
    // gets via browser.ts configurePage(). Without it, headless Chromium advertises
    // the Chrome PDF Plugin, the site skips loading pdf.js, and the app throws
    // "pdfjsLib is not defined" on bootstrap — crashing before the Flutter <canvas>
    // is created (the "No nonzero canvas" / "No module cards" loop).
    try {
      const spoof = this.browserManager?.getFingerprintSpoofScript?.();
      if (spoof) await page.addInitScript(spoof);
    } catch (err: any) {
      log(`[WORKER-${id}] Failed to apply fingerprint spoof init script`, 'WARN', 'parallel');
    }
    // Opt-in pending a broader auth and proxy logging privacy review.
    let authNetDiag: any = null;
    if (process.env.MATHU_AUTHNET_DIAGNOSTICS === '1') {
      try {
        authNetDiag = require('./authnet-diagnostics').attachAuthNetDiagnostics(
          page, id, getCONFIG().APP_URL, !!(globalThis as any).__proxyDisabled, log);
      } catch {}
    }
    // Opt-in pending a broader auth and proxy logging privacy review.
    if (process.env.MATHU_RENDER_DIAGNOSTICS === '1') {
      try { require('./render-diagnostics').attachRenderDiagnostics(page, id, log); } catch {}
      try { renderSignals.set(page, require('./render-observability').attachRenderSignals(page, id, log, getCONFIG().APP_URL)); } catch {}
    }
    page.setDefaultTimeout(30000);
    page.setDefaultNavigationTimeout(120000);

    // Raw console and exception text may contain sensitive or academic content.
    let genericConsoleEvents = 0;
    let genericPageErrors = 0;
    page.on('console', (msg: any) => {
      try {
        if (msg.type() === 'error' && genericConsoleEvents++ < 4)
          log(`[WORKER-${id}] [page-console] kind=error`, 'DEBUG', 'parallel');
      } catch {}
    });
    page.on('pageerror', (err: Error) => {
      try {
        if (genericPageErrors++ < 4)
          log(`[WORKER-${id}] [page-error] kind=${err.message === 'pdfjsLib is not defined' ? 'pdf-reference' : 'other'}`, 'ERROR', 'parallel');
      } catch {}
    });
    // Log network request failures that matter for app boot (document/script/xhr/fetch).
    // Skips images/media/fonts/stylesheets so the 10-log cap is spent on meaningful
    // failures. Emits only resource type + host + error reason — no URLs, paths, or page
    // content. Decisive for "absent" canvas: if the Flutter bundle / pdf.js fail to load,
    // this shows which host failed and why (e.g. net::ERR_CONNECTION_TIMED_OUT).
    let failedReqs = 0;
    page.on('requestfailed', (req: any) => {
      try {
        if (failedReqs >= 10) return;
        let type = 'unknown';
        try { type = req.resourceType(); } catch {}
        if (['image', 'media', 'font', 'stylesheet'].includes(type)) return;
        let host = 'unknown';
        try { host = new URL(req.url()).host; } catch {}
        // Suppress logs for hosts the bot intentionally blocks (atlassian
        // support widget, google fonts) — page.route(..., r => r.abort())
        // triggers requestfailed, which would otherwise log a self-inflicted
        // WARN per block AND consume the 10-log cap before real failures
        // (cdn.jsdelivr.net pdf.js, the Flutter bundle host) get logged.
        if (host.endsWith('atlassian.net') || host.endsWith('gstatic.com') || host.endsWith('googleapis.com')) return;
        failedReqs++;
        const reason = (req.failure() && req.failure().errorText) || 'unknown';
        log(`[WORKER-${id}] [request-failed] type=${type} host=${host} reason=${reason}`, 'WARN', 'parallel');
      } catch {}
    });
    // Block the non-essential Atlassian support widget (automa.atlassian.net) so it
    // stops consuming scarce proxy bandwidth and generating timeout/reset noise while the
    // app bundle loads. The bot never interacts with the support widget; blocking it is
    // safe. NOTE: this is noise/bandwidth hygiene only — it does NOT fix the core problem
    // (the geo-fenced app host's multi-MB Flutter bundle aborts on the flaky proxy with
    // ERR_ABORTED / ERR_CONNECTION_RESET; pdf.js on cdn.jsdelivr.net returns
    // ERR_EMPTY_RESPONSE). That requires a stable proxy that can sustain large downloads.
    try {
      await page.route(/^https?:\/\/[^/]*\.atlassian\.net\//, (r: any) => r.abort());
    } catch {}
    // Block Google Fonts / gstatic assets — purely cosmetic, and on the flaky
    // ZA proxy these time out (net::ERR_TIMED_OUT) and waste bandwidth the main
    // Flutter bundle needs. The bot vision login does not depend on fonts.
    try {
      await page.route(/^https?:\/\/[^/]*(?:fonts\.gstatic\.com|www\.gstatic\.com|fonts\.googleapis\.com)\//, (r: any) => r.abort());
    } catch {}

    this.workers.set(id, {
      id,
      page,
      context,
      status: 'idle',
      currentModule: null,
      modulesCompleted: 0,
      errors: 0,
      lastActivity: Date.now(),
      authNetDiag,
    });

    log(`[PARALLEL] Worker ${id} ready`, 'INFO', 'parallel');
  }

  /**
   * Worker loop — each worker:
   *   1. Logs in (if needed)
   *   2. Goes to /assignments
   *   3. Claims a module (task) from Turso
   *   4. Completes the entire module
   *   5. Marks it done
   *   6. Claims next module
   */
  private async _runWorkerLoop(id: number): Promise<void> {
    const log = getLog();
    const worker = this.workers.get(id);
    if (!worker) return;

    log(`[WORKER-${id}] Loop started`, 'INFO', 'parallel');

    while (this.running) {
      try {
        // Step 1: Ensure logged in
        worker.status = 'logging_in';
        const loggedIn = await this._ensureLoggedIn(worker, id);
        if (!loggedIn) {
          log(`[WORKER-${id}] Login failed — retrying in 30s`, 'WARN', 'parallel');
          await this._sleep(30000);
          continue;
        }

        // Step 2: Navigate to assignments page
        worker.status = 'browsing_assignments';
        await this._navigateAssignments(worker, false);
        // Render-readiness is ADVISORY only: this bot relies on AI vision (Ollama) to see
        // the page and decide what to do, so a missing Flutter <canvas> or DOM module
        // cards must NOT block the vision path. _waitForFlutterRender runs for at most 10s
        // here (a short diagnostic sample — it logs the canvas/cardsMax breakdown) but its
        // result no longer gates the flow. The vision-based module finder below screenshots
        // the actual rendered pixels and lets the VLM locate the module cards.
        await this._waitForFlutterRender(worker.page, id, 10000);
        try { renderSignals.get(worker.page)?.sample('render'); } catch {}
        log(`[WORKER-${id}] On assignments page`, 'INFO', 'parallel');

        // Step 3: Claim a module from Turso
        const module = await this._claimNextModule(id);
        if (!module) {
          log(`[WORKER-${id}] No modules available — waiting 30s`, 'INFO', 'parallel');
          await this._sleep(30000);
          continue;
        }

        worker.currentModule = { name: module.name, type: module.type, claimedAt: Date.now() };
        log(`[WORKER-${id}] Claimed module (type: ${module.type})`, 'INFO', 'parallel');

        // Step 4: Find and click the module card — VISION FIRST. The bot relies on AI
        // vision (Ollama), not DOM/Semantics: _findAndClickModuleViaVision screenshots
        // the page and asks the VLM for module-card coordinates via
        // providers.findCollapsedCardsCoordinates. The DOM finder is a fallback only when
        // vision is unavailable (no providers wired, e.g. in tests).
        const clicked = await this._findAndClickModuleViaVision(worker, module.name, id)
          || await this._findAndClickModuleCard(worker.page, module.name, id);
        if (!clicked) {
          worker.errors++;
          log(`[WORKER-${id}] Module could not be opened — attempting to release claim for retry`, 'WARN', 'parallel');
          await this._markModuleFailed(module.name, id);
          worker.currentModule = null;
          worker.status = 'idle';
          worker.lastActivity = Date.now();
          await this._sleep(30000);
          continue;
        }

        // Step 5: Wait for module to load, detect type
        await this._sleep(3000); // Let the module page load
        const detectedType = await this._detectModuleType(worker.page, id);
        log(`[WORKER-${id}] Module type detected: ${detectedType}`, 'INFO', 'parallel');

        // Step 6: Complete the module based on type
        worker.status = detectedType === 'video' ? 'completing_video'
                      : detectedType === 'memo' ? 'writing_memo'
                      : 'answering_question';

        const completed = await this._completeModule(worker, detectedType, id);

        if (completed) {
          worker.modulesCompleted++;
          log(`[WORKER-${id}] ✅ Module completed`, 'INFO', 'parallel');
          await this._markModuleDone(module.name, id);
        } else {
          worker.errors++;
          log(`[WORKER-${id}] ❌ Module failed — will retry later`, 'WARN', 'parallel');
          await this._markModuleFailed(module.name, id);
        }

        worker.currentModule = null;
        worker.status = 'idle';
        worker.lastActivity = Date.now();

        // Navigate back to assignments for next module
        await this._navigateAssignments(worker, true).catch(() => {});

      } catch (err: any) {
        worker.errors++;
        worker.status = 'error';
        log(`[WORKER-${id}] Worker loop error`, 'ERROR', 'parallel');
        if (worker.currentModule) {
          await this._markModuleFailed(worker.currentModule.name, id);
          worker.currentModule = null;
        }
        await this._sleep(10000); // Back off before retrying
      }
    }

    log(`[WORKER-${id}] Loop stopped`, 'INFO', 'parallel');
  }

  /**
   * Ensure the worker is logged in.
   * Each worker has its own browser context with separate session.
   */
  private async _ensureLoggedIn(worker: WorkerState, id: number): Promise<boolean> {
    const log = getLog();
    const diag = worker.authNetDiag;
    let outcome = 'exception';
    let failure = null;
    diag?.begin('login_check');
    try {
      // Navigate to app root
      diag?.step('entry_domcontentloaded');
      await navigateWorkerEntry(worker.page, getCONFIG().APP_URL, () => {
        log(`[WORKER-${id}] App entry loaded after navigation timeout; resuming login check`, 'INFO', 'parallel');
      }, () => { diag?.step('entry_late_load_wait'); });
      diag?.step('post_entry_wait');
      await this._sleep(3000);

      // VISION-DRIVEN LOGIN (primary): this bot relies on AI vision, not URL substrings
      // or DOM CSS selectors. When providers are wired, drive the full login state machine
      // visually: MathU landing ("Sign in with Microsoft") → MS email field → MS password
      // field → KMSI "Yes" → assignments page. MicrosoftAuthV2 (DOM CSS form-fill) is dead
      // code — ensureAuthenticated (cycle-auth-guard Rule 1) returns the page as-is on MS
      // pages and never calls authenticate, so the form MUST be filled here, visually.
      // Guarded: tests inject no providers, so the legacy URL-based logic below runs
      // unchanged and produces the exact outcomes/phases the authnet tests assert.
      const providers = _deps.providers;
      if (providers && typeof providers.findSignInButtonCoordinates === 'function'
          && typeof providers.findElementCoordinates === 'function'
          && typeof providers.findCollapsedCardsCoordinates === 'function') {
        const visionOk = await this._visionLogin(worker, id, providers);
        outcome = visionOk ? 'vision_login_complete' : 'vision_login_incomplete';
        log(`[WORKER-${id}] Vision login: ${visionOk ? 'complete — logged in' : 'incomplete — will retry'}`, visionOk ? 'INFO' : 'WARN', 'parallel');
        return visionOk;
      }

      // Legacy URL-based login (fallback when no vision providers — tests).
      const url = worker.page.url();
      diag?.step('login_decision');
      if (url.includes('/assignments') || url.includes('app.mathu.co.za')) {
        // Check for Microsoft login redirect
        if (url.includes('login.microsoftonline.com') || url.includes('login.live.com')) {
          log(`[WORKER-${id}] Microsoft login required`, 'INFO', 'parallel');
          // Use the auth guard to handle login
          const authGuard = _deps.authGuard;
          if (authGuard && typeof authGuard.ensureAuthenticated === 'function') {
            diag?.step('guard_handoff');
            const result = await authGuard.ensureAuthenticated(worker.page);
            outcome = result === false ? 'guard_returned_false' : 'guard_returned_nonfalse_unverified';
            return result !== false;
          }
          // Fallback: try to use the auth manager
          const auth = _deps.auth;
          if (auth && typeof auth.authenticate === 'function') {
            diag?.step('auth_handoff');
            await auth.authenticate(worker.page);
            outcome = 'auth_returned_unverified';
            return true;
          }
          log(`[WORKER-${id}] No auth module — cannot log in`, 'ERROR', 'parallel');
          outcome = 'no_auth_module';
          return false;
        }
        // Already logged in (legacy URL-based — used only when no vision providers).
        log(`[WORKER-${id}] Already logged in`, 'INFO', 'parallel');
        outcome = diag?.classify() === 'app_origin' ? 'legacy_true_app_unverified' : 'legacy_true_external_unverified';
        return true;
      }
      outcome = diag?.classify() === 'app_origin' ? 'legacy_true_app_unverified' : 'legacy_true_other_unverified';
      return true;
    } catch (err: any) {
      failure = err;
      log(`[WORKER-${id}] Login check failed`, 'WARN', 'parallel');
      return false;
    } finally {
      diag?.finish(outcome, failure);
    }
  }

  /**
   * Vision-driven login state machine. Drives the full MathU → Microsoft → assignments
   * login flow visually: screenshots each step and asks the VLM (via
   * providers.findCollapsedCardsCoordinates / findSignInButtonCoordinates /
   * findElementCoordinates) what is on screen, then acts (click sign-in, type email,
   * type password, click KMSI "Yes") until the assignments page (module cards) is
   * reached. Replaces the dead DOM-CSS MicrosoftAuthV2 form-fill (ensureAuthenticated
   * never calls authenticate — Rule 1 returns the page as-is) and the URL-substring
   * "Already logged in" guess. The Flutter SPA's URL does not change between pages
   * (providers-prompts.ts:207), so vision — not URL — must drive every step.
   */
  private async _visionLogin(worker: WorkerState, id: number, providers: any): Promise<boolean> {
    const log = getLog();
    const cfg = getCONFIG();
    const email: string = (typeof cfg.getMicrosoftEmail === 'function' ? cfg.getMicrosoftEmail() : '') || cfg.MICROSOFT_EMAIL || '';
    const password: string = (typeof cfg.getMicrosoftPassword === 'function' ? cfg.getMicrosoftPassword() : '') || cfg.MICROSOFT_PASSWORD || '';
    const maxSteps = 8;
    // Track repeated sign-in clicks: if the page does not advance after the click,
    // escalate to a DOM text-selector click, then give up (hand back to worker loop).
    let signInAttempts = 0;

    // Give the page a moment to reach DOMContentLoaded before the first
    // screenshot. The 'no recognizable login state at step 0' warnings happen
    // when the Flutter app has not rendered yet — the bot screenshots a blank
    // canvas. Cheap: returns immediately if the page is already loaded, waits
    // at most 8s if not.
    try { await worker.page.waitForLoadState('domcontentloaded', { timeout: 8000 }); } catch {}
    // Wait for the Flutter CanvasKit to render (nonzero <canvas> or module-card
    // DOM) before screenshotting, retrying the page load once if the bundle /
    // pdf.js abort on the flaky proxy (cdn.jsdelivr.net ERR_ABORTED /
    // ERR_EMPTY_RESPONSE). domcontentloaded fires when the HTML is parsed, but
    // the multi-MB Flutter bundle + pdf.js can still be loading/aborting —
    // without this the first screenshot is a blank white page (the dashboard
    // showed white boxes), the vision hallucinates sign-in button coords, and
    // the click never navigates. _waitForFlutterRender polls up to 60s; if no
    // canvas appears, reload + retry once (the proxy often succeeds on a second
    // load). After the retries, proceed anyway (best effort).
    // Wait for the Flutter CanvasKit to render before screenshotting. The
    // multi-MB Flutter bundle can take >60s to download + execute on a slow or
    // throttled connection, so wait up to 120s per attempt (was 60s — the poll
    // timed out before the bundle finished, producing "absent=60" + blank
    // screenshots). If no canvas appears, reload + retry: the bundle host often
    // succeeds on a second load. Three attempts total (initial + 2 reloads);
    // the old loop only reloaded once ("retry 1/2" — retry 2/2 was a no-op).
    for (let renderAttempt = 0; renderAttempt < 3; renderAttempt++) {
      try {
        if (await this._waitForFlutterRender(worker.page, id, 120000)) break;
        if (renderAttempt < 2) {
          log(`[WORKER-${id}] Vision login: canvas not rendered after 120s — reloading page (retry ${renderAttempt + 1}/2)`, 'WARN', 'parallel');
          try { await worker.page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 }); } catch {}
        }
      } catch {}
    }

    for (let step = 0; step < maxSteps; step++) {
      let b64 = '';
      try {
        const shot = await worker.page.screenshot({ type: 'jpeg', quality: 80 });
        b64 = shot.toString('base64');
        // Ship every vision-login screenshot to the external dashboard app
        // (automa-dashboard) via POST /api/screenshot. The dashboard client
        // fetches /api/screenshots + renders them. Without this call, no
        // screenshots were ever POSTed, so the dashboard showed none.
        try { getShipper()?.shipScreenshot?.(b64, 'vision_login worker-' + id + ' step-' + step); } catch {}
      } catch {
        log(`[WORKER-${id}] Vision login: screenshot failed at step ${step} — retrying next cycle`, 'WARN', 'parallel');
        return false;
      }

      // Already on the assignments page? (logged in — module cards visible)
      let cards: any[] = [];
      try { cards = await providers.findCollapsedCardsCoordinates(b64) || []; } catch {}
      if (Array.isArray(cards) && cards.length > 0) {
        log(`[WORKER-${id}] Vision login: assignments page reached (${cards.length} module cards) — logged in`, 'INFO', 'parallel');
        return true;
      }

      // MathU landing: "Sign in with Microsoft" button.
      // The click triggers an OAuth redirect OFF the Flutter SPA to
      // login.microsoftonline.com (different origin), so a URL change is the
      // reliable signal the click registered. The old 3s flat sleep was too short
      // for the slow-proxy redirect, so the next screenshot still showed the
      // button and the bot spam-clicked every ~15s without ever advancing.
      try {
        const signIn = await providers.findSignInButtonCoordinates(b64);
        if (signIn && typeof signIn.x === 'number' && typeof signIn.y === 'number') {
          const urlBefore = worker.page.url();
          // After 2 vision clicks that did not advance, fall back to a DOM
          // text-selector click — if the button is a real <a>/<button> (not a
          // canvas pixel), this fires the nav handler reliably. If it is a Flutter
          // canvas widget, this throws silently and we retry vision coords.
          if (signInAttempts >= 2) {
            // After 2 vision clicks that did not advance, also try a DOM
            // text-selector click — if the button is a real <a>/<button> (not a
            // canvas pixel), this fires the nav handler reliably.
            let domOk = false;
            try { await worker.page.click('text=/Sign in with Microsoft/i', { timeout: 5000 }); domOk = true; }
            catch { domOk = false; }
            log(`[WORKER-${id}] Vision login: DOM sign-in click ${domOk ? 'succeeded' : 'failed'} (vision coords were not advancing)`, 'INFO', 'parallel');
          }
          // ALWAYS multi-click the sign-in button: the vision Y varies +/-0.1
          // across attempts (clicks logged at 320/400/440 for a button near
          // viewport center ~400 on a 1280x800 context), so a single click at
          // the vision coords often misses the Flutter canvas button. Click the
          // vision Y + the viewport center +/- a strip; the OAuth redirect
          // starts on the first hit, later clicks land on the redirecting page
          // (harmless). mouse.click + touchscreen.tap cover both pointer +
          // touch gesture paths.
          try {
            const vp = await worker.page.evaluate(() => ({ w: window.innerWidth || 1440, h: window.innerHeight || 900 })).catch(() => ({ w: 1440, h: 900 }));
            const cx = Math.round(signIn.x * vp.w), cy = Math.round(signIn.y * vp.h);
            const mid = Math.round(vp.h / 2);
            const ys = [cy, mid, mid - 40, mid + 40];
            log(`[WORKER-${id}] Vision login: clicking "Sign in with Microsoft" at x=${cx} ys=[${ys.join(',')}] (vision ${cy} + center strip)`, 'INFO', 'parallel');
            for (const py of ys) {
              await worker.page.mouse.click(cx, py).catch(() => {});
              await worker.page.touchscreen.tap(cx, py).catch(() => {});
              await this._sleep(250);
            }
          } catch {}
          signInAttempts++;
          // Poll for the OAuth redirect (URL change) for up to 15s — slow proxy.
          let navigated = false;
          for (let w = 0; w < 15; w++) {
            await this._sleep(1000);
            try { if (worker.page.url() !== urlBefore) { navigated = true; break; } } catch {}
          }
          if (navigated) {
            log(`[WORKER-${id}] Vision login: sign-in redirected to ${worker.page.url()}`, 'INFO', 'parallel');
            signInAttempts = 0;
          } else {
            log(`[WORKER-${id}] Vision login: sign-in click did not navigate (attempt ${signInAttempts})`, 'WARN', 'parallel');
            if (signInAttempts >= 4) {
              log(`[WORKER-${id}] Vision login: sign-in stuck after ${signInAttempts} attempts — handing back to worker loop`, 'WARN', 'parallel');
              return false;
            }
          }
          continue;
        }
      } catch {}

      // MS email field — type the configured email
      if (email) {
        try {
          const ef = await providers.findElementCoordinates(b64, 'the email input field');
          if (ef && typeof ef.x === 'number' && typeof ef.y === 'number') {
            signInAttempts = 0; // advanced past the sign-in step
            await this._visionClick(worker, id, ef, 'email field');
            await worker.page.keyboard.type(email).catch(() => {});
            await worker.page.keyboard.press('Enter').catch(() => {});
            log(`[WORKER-${id}] Vision login: typed email + pressed Enter`, 'INFO', 'parallel');
            await this._sleep(5000);
            continue;
          }
        } catch {}
      }

      // MS password field — type the configured password
      if (password) {
        try {
          const pf = await providers.findElementCoordinates(b64, 'the password input field');
          if (pf && typeof pf.x === 'number' && typeof pf.y === 'number') {
            signInAttempts = 0; // advanced past the sign-in step
            await this._visionClick(worker, id, pf, 'password field');
            await worker.page.keyboard.type(password).catch(() => {});
            await worker.page.keyboard.press('Enter').catch(() => {});
            log(`[WORKER-${id}] Vision login: typed password + pressed Enter`, 'INFO', 'parallel');
            await this._sleep(7000);
            continue;
          }
        } catch {}
      }

      // KMSI "Stay signed in?" — click "Yes"
      try {
        const kmsi = await providers.findElementCoordinates(b64, 'the "Yes" button on the "Stay signed in" page');
        if (kmsi && typeof kmsi.x === 'number' && typeof kmsi.y === 'number') {
          await this._visionClick(worker, id, kmsi, 'KMSI "Yes"');
          log(`[WORKER-${id}] Vision login: clicked KMSI "Yes"`, 'INFO', 'parallel');
          await this._sleep(3000);
          continue;
        }
      } catch {}

      // No recognizable login state at this step — stop and let the worker loop retry.
      log(`[WORKER-${id}] Vision login: no recognizable login state at step ${step} (not assignments/sign-in/email/password/KMSI) — handing back to worker loop`, 'WARN', 'parallel');
      break;
    }

    // Final check: did we reach the assignments page?
    try {
      const shot = await worker.page.screenshot({ type: 'jpeg', quality: 80 });
      try { if (shot && shot.length) getShipper()?.shipScreenshot?.(shot.toString('base64'), 'screenshot worker-' + id); } catch {}
      const cards = await providers.findCollapsedCardsCoordinates(shot.toString('base64')) || [];
      if (Array.isArray(cards) && cards.length > 0) {
        log(`[WORKER-${id}] Vision login: assignments page reached on final check`, 'INFO', 'parallel');
        return true;
      }
    } catch {}
    return false;
  }

  /**
   * Click a vision-returned coordinate (percentages 0-1) by converting to pixels via the
   * real viewport size, then dispatching a mouse click. Centralizes the pattern already
   * used inline by _findAndClickModuleViaVision. Failures are non-fatal — the caller's
   * loop re-screenshots and retries.
   */
  private async _visionClick(worker: WorkerState, id: number, coords: any, label: string): Promise<void> {
    const log = getLog();
    try {
      const vp = await worker.page.evaluate(() => ({ w: window.innerWidth || 1440, h: window.innerHeight || 900 })).catch(() => ({ w: 1440, h: 900 }));
      const px = Math.round(coords.x * vp.w), py = Math.round(coords.y * vp.h);
      log(`[WORKER-${id}] Vision login: clicking ${label} at (${px}, ${py})`, 'INFO', 'parallel');
      await worker.page.mouse.click(px, py).catch(() => {});
      // Also dispatch a touch tap — Flutter web GestureDetector sometimes responds
      // to pointer/touch events when mouse.click does not register on the canvas host.
      await worker.page.touchscreen.tap(px, py).catch(() => {});
    } catch {}
  }

  /** Navigate as before, with optional passive timing and outcome metadata. */
  private async _navigateAssignments(worker: WorkerState, isReturn: boolean): Promise<any> {
    const log = getLog();
    const diag = worker.authNetDiag;
    diag?.begin(isReturn ? 'assignments_return_load' : 'assignments_load');
    try {
      const result = await worker.page.goto(getCONFIG().APP_URL + '/assignments', { waitUntil: 'load', timeout: 120000 });

      // VISION NAVIGATION VERIFICATION: confirm the page actually rendered the
      // assignments view (module cards visible), not a login redirect / blank / error.
      // The bot relies on AI vision — the Flutter SPA's URL may not change between pages
      // (providers-prompts.ts:207), so a successful goto + "On assignments page" log is
      // NOT proof. Guarded: tests inject no providers, so the legacy goto-only behavior
      // is preserved (authnet asserts _navigateAssignments returns {ok:true}, outcome
      // 'completed'; combined-privacy asserts the 'assignments_load' diag marker).
      const providers = _deps.providers;
      if (providers && typeof providers.findCollapsedCardsCoordinates === 'function') {
        try {
          const shot = await worker.page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => Buffer.from(''));
          try { if (shot && shot.length) getShipper()?.shipScreenshot?.(shot.toString('base64'), 'screenshot worker-' + id); } catch {}
          const b64 = shot.toString('base64');
          const cards = await providers.findCollapsedCardsCoordinates(b64).catch(() => []);
          if (Array.isArray(cards) && cards.length > 0) {
            log(`[WORKER-${worker.id}] Vision nav: assignments page confirmed (${cards.length} module cards)`, 'INFO', 'parallel');
          } else {
            // No module cards — could be a login redirect (session expired) or blank.
            // Probe for a sign-in button to distinguish; if present, the session expired
            // and the next _ensureLoggedIn cycle (vision) will re-drive login.
            let signIn: any = null;
            if (typeof providers.findSignInButtonCoordinates === 'function') {
              signIn = await providers.findSignInButtonCoordinates(b64).catch(() => null);
            }
            if (signIn && typeof signIn.x === 'number') {
              log(`[WORKER-${worker.id}] Vision nav: /assignments did NOT render module cards — "Sign in with Microsoft" button visible (session expired); next login cycle will re-authenticate`, 'WARN', 'parallel');
            } else {
              log(`[WORKER-${worker.id}] Vision nav: /assignments did NOT render module cards and no sign-in button — page may be blank/loading; downstream module-finder will retry`, 'WARN', 'parallel');
            }
          }
        } catch (e: any) {
          log(`[WORKER-${worker.id}] Vision nav check error: ${e && e.message ? e.message : 'unknown'} — continuing`, 'WARN', 'parallel');
        }
      }

      diag?.finish('completed');
      return result;
    } catch (err: any) {
      diag?.finish('failed', err);
      throw err;
    }
  }

  /**
   * Claim the next uncompleted module from Turso.
   * Modules are tracked in the `completed_modules` table.
   * Returns the module name + detected type.
   */
  private async _claimNextModule(workerId: number): Promise<{ name: string; type: string } | null> {
    const log = getLog();
    try {
      // Get the list of modules from the assignments page
      // We'll use page.evaluate to extract module card names
      const page = this.workers.get(workerId)?.page;
      if (!page) return null;

      // Get all module cards on the assignments page
      let modules;
      try {
        modules = await page.evaluate(() => {
          const cards = document.querySelectorAll('[class*="card"], [role="listitem"], .module-card');
          const results: Array<{ name: string; completed: boolean; rect: any }> = [];
          cards.forEach((card: any) => {
            const name = card.textContent?.trim().substring(0, 100) || '';
            if (name.length > 5) {
              // Check if this card shows as completed
              const hasCompletedBadge = card.querySelector('[class*="complete"], [class*="done"], .checkmark');
              const rect = card.getBoundingClientRect();
              results.push({
                name,
                completed: !!hasCompletedBadge,
                rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
              });
            }
          });
          return results;
        });
      } catch {
        // Failed inspection does not establish that the page contains no cards.
        // Exception text may contain sensitive URLs or page content.
        log(`[WORKER-${workerId}] Module card inspection failed; page content unknown`, 'WARN', 'parallel');
        try { renderSignals.get(page)?.sample('card-inspection-failed'); } catch {}
        return null;
      }

      if (!modules || modules.length === 0) {
        try { renderSignals.get(page)?.sample('cards-empty'); } catch {}
        log(`[WORKER-${workerId}] No module cards found on page`, 'DEBUG', 'parallel');
        return null;
      }

      // Check Turso for which modules are already completed
      const db = _deps.database;
      for (const mod of modules) {
        if (mod.completed) continue; // Skip visually-completed modules

        // Check if already claimed/done in Turso
        let alreadyDone = false;
        if (db && db.isModuleCompleted) {
          try {
            alreadyDone = await db.isModuleCompleted(mod.name);
          } catch {}
        }

        if (!alreadyDone) {
          // Try to claim it atomically
          const claimed = await this._claimModuleInDb(mod.name, workerId);
          if (claimed) {
            // Detect module type from the card text
            const type = this._guessModuleType(mod.name);
            return { name: mod.name, type };
          }
        }
      }

      return null; // All modules are done or claimed
    } catch (err: any) {
      log(`[WORKER-${workerId}] Claim failed`, 'DEBUG', 'parallel');
      return null;
    }
  }

  /**
   * Guess the module type from the card name.
   */
  private _guessModuleType(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('video') || lower.includes('watch')) return 'video';
    if (lower.includes('memo') || lower.includes('write') || lower.includes('essay')) return 'memo';
    if (lower.includes('exercise') || lower.includes('practice') || lower.includes('question')) return 'exercise';
    if (lower.includes('assessment') || lower.includes('test') || lower.includes('exam')) return 'assessment';
    return 'unknown';
  }

  /**
   * Atomically claim a module in the database.
   */
  private async _claimModuleInDb(moduleName: string, workerId: number): Promise<boolean> {
    const db = _deps.database;
    if (!db || !db.db) return true; // If no DB, just claim it

    try {
      // Use a simple approach: check if already in completed_modules, if not, add it
      const existing = db.db.prepare('SELECT 1 FROM completed_modules WHERE name = ?').get(moduleName);
      if (existing) return false; // Already claimed or done

      // Mark as in-progress (we'll update completion time when done)
      db.db.prepare('INSERT OR IGNORE INTO completed_modules (name, completed_at, attempts) VALUES (?, 0, 1)').run(moduleName);
      return true;
    } catch {
      return true; // If DB fails, claim it anyway
    }
  }

  /**
   * Find and click a module card on the assignments page.
   */
  /**
   * Find and click a module card using AI VISION — the primary path. Screenshots the
   * assignments page and asks the VLM (via providers.findCollapsedCardsCoordinates, a
   * MathU-specific vision function that returns module-card coordinates as viewport
   * percentages) to locate module cards, then clicks the first. Returns false when vision
   * providers are unavailable or the VLM sees no cards, so the DOM finder
   * (_findAndClickModuleCard) can fall back. No DOM/Semantics/canvas assumptions — the
   * VLM sees the rendered pixels.
   *
   * NOTE: the VLM selects which card to open (it cannot match text by name), so the
   * Turso claim name is best-effort here; a follow-up could have the VLM return the
   * opened module's title so Turso records the right completion.
   */
  private async _findAndClickModuleViaVision(worker: WorkerState, _moduleName: string, id: number): Promise<boolean> {
    const log = getLog();
    const providers = _deps.providers;
    if (!providers || typeof providers.findCollapsedCardsCoordinates !== 'function') return false;
    try {
      const screenshot = await worker.page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => Buffer.from(''));
      try { if (screenshot && screenshot.length) getShipper()?.shipScreenshot?.(screenshot.toString('base64'), 'screenshot worker-' + id); } catch {}
      const base64 = screenshot.toString('base64');
      const cards = await providers.findCollapsedCardsCoordinates(base64).catch(() => []);
      if (!Array.isArray(cards) || cards.length === 0) {
        log(`[WORKER-${id}] Vision: no module cards detected by VLM`, 'DEBUG', 'parallel');
        return false;
      }
      const c = cards[0];
      const vx = typeof c?.x === 'number' ? c.x : 0.5;
      const vy = typeof c?.y === 'number' ? c.y : 0.5;
      const vp = await worker.page.evaluate(() => ({ w: window.innerWidth || 1440, h: window.innerHeight || 900 })).catch(() => ({ w: 1440, h: 900 }));
      const px = Math.round(vx * vp.w);
      const py = Math.round(vy * vp.h);
      log(`[WORKER-${id}] Vision: clicking module card at (${px}, ${py}) [viewport ${Math.round(vx * 100)}%, ${Math.round(vy * 100)}%]`, 'INFO', 'parallel');
      await worker.page.mouse.click(px, py).catch(() => {});
      // Also dispatch a touch tap — Flutter web GestureDetector sometimes responds
      // to pointer/touch events when mouse.click does not register on the canvas host.
      await worker.page.touchscreen.tap(px, py).catch(() => {});
      await this._sleep(3000); // Wait for navigation/expand
      return true;
    } catch {
      log(`[WORKER-${id}] Vision module-finder failed`, 'ERROR', 'parallel');
      return false;
    }
  }

  /**
   * Find and click a module card by matching text — the DOM FALLBACK when vision is
   * unavailable. Queries [class*="card"], [role="listitem"], .module-card and clicks the
   * card whose text contains the module name.
   */
  private async _findAndClickModuleCard(page: any, moduleName: string, workerId: number): Promise<boolean> {
    const log = getLog();
    try {
      // Find the card with matching text
      const card = await page.evaluate((name: string) => {
        const cards = document.querySelectorAll('[class*="card"], [role="listitem"], .module-card');
        for (const card of cards) {
          const text = card.textContent?.trim() || '';
          if (text.includes(name.substring(0, 30))) {
            const rect = card.getBoundingClientRect();
            return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, found: true };
          }
        }
        return { found: false };
      }, moduleName);

      if (!card.found) {
        log(`[WORKER-${workerId}] Card not found on page`, 'WARN', 'parallel');
        return false;
      }

      log(`[WORKER-${workerId}] Clicking module card at (${Math.round(card.x)}, ${Math.round(card.y)})`, 'INFO', 'parallel');
      await page.mouse.click(card.x, card.y);
      await this._sleep(3000); // Wait for navigation
      return true;
    } catch (err: any) {
      log(`[WORKER-${workerId}] Click card failed`, 'ERROR', 'parallel');
      return false;
    }
  }

  /**
   * Detect the type of module the worker is now in.
   */
  private async _detectModuleType(page: any, workerId: number): Promise<string> {
    const log = getLog();
    try {
      const type = await page.evaluate(() => {
        // Check for video player
        const video = document.querySelector('video, iframe[src*="youtube"], iframe[src*="vimeo"], [class*="video-player"]');
        if (video) return 'video';

        // Check for memo/text input
        const textarea = document.querySelector('textarea, [contenteditable="true"]');
        const memoKeywords = ['memo', 'essay', 'write', 'describe', 'explain'];
        const bodyText = document.body.innerText.toLowerCase();
        if (textarea && memoKeywords.some(k => bodyText.includes(k))) return 'memo';

        // Check for question/exercise
        const question = document.querySelector('[class*="question"], [class*="answer"], [role="radiogroup"], [role="listbox"]');
        if (question) return 'exercise';

        // Check for assessment/test
        if (bodyText.includes('assessment') || bodyText.includes('test') || bodyText.includes('exam')) return 'assessment';

        return 'unknown';
      });

      return type;
    } catch {
      return 'unknown';
    }
  }

  /**
   * Complete a module based on its type.
   */
  private async _completeModule(worker: WorkerState, type: string, id: number): Promise<boolean> {
    const log = getLog();
    log(`[WORKER-${id}] Completing module (type: ${type})...`, 'INFO', 'parallel');

    switch (type) {
      case 'video':
        return await this._completeVideoModule(worker, id);
      case 'memo':
        return await this._completeMemoModule(worker, id);
      case 'exercise':
      case 'assessment':
        return await this._completeExerciseModule(worker, id);
      default:
        // Unknown type — use the AI tribunal to figure it out
        return await this._completeWithAI(worker, id);
    }
  }

  /**
   * Complete a video module — wait 2m59s (179s), then click Next/Done.
   */
  private async _completeVideoModule(worker: WorkerState, id: number): Promise<boolean> {
    const log = getLog();
    log(`[WORKER-${id}] Video module — waiting 2m59s for video to play...`, 'INFO', 'parallel');

    // Wait for the video to play (MathU requires 2m59s = 179s)
    // We poll every 10s to check if the video is still playing
    const videoDuration = 179; // 2m59s in seconds
    const pollInterval = 10; // seconds
    let elapsed = 0;

    while (elapsed < videoDuration) {
      // Check if video is still playing
      try {
        const stillPlaying = await worker.page.evaluate(() => {
          const video = document.querySelector('video');
          if (!video) return false;
          return !video.paused && !video.ended;
        }).catch(() => false);

        if (!stillPlaying && elapsed > 30) {
          // Video might have ended early or not started
          log(`[WORKER-${id}] Video not playing at ${elapsed}s — checking if ended`, 'DEBUG', 'parallel');
          break;
        }
      } catch {}

      await this._sleep(pollInterval * 1000);
      elapsed += pollInterval;
      if (elapsed % 30 === 0) {
        log(`[WORKER-${id}] Video watching: ${elapsed}s / ${videoDuration}s`, 'INFO', 'parallel');
      }
    }

    // Try to click "Next", "Done", "Continue", or "Complete"
    const clicked = await this._clickCompletionButton(worker.page, id);
    if (clicked) {
      log(`[WORKER-${id}] ✅ Video module completed — clicked Next/Done`, 'INFO', 'parallel');
      return true;
    }

    log(`[WORKER-${id}] Video module — no completion button found`, 'WARN', 'parallel');
    return false;
  }

  /**
   * Complete a memo module — extract the prompt, use AI to generate the memo, type it, submit.
   */
  private async _completeMemoModule(worker: WorkerState, id: number): Promise<boolean> {
    const log = getLog();
    log(`[WORKER-${id}] Memo module — extracting prompt...`, 'INFO', 'parallel');

    // Extract the memo prompt
    const prompt = await worker.page.evaluate(() => {
      return document.body.innerText.substring(0, 2000);
    }).catch(() => '');

    log(`[WORKER-${id}] Memo prompt extracted`, 'INFO', 'parallel');

    // Use the AI tribunal to generate the memo
    const screenshot = await worker.page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => Buffer.from(''));
    try { if (screenshot && screenshot.length) getShipper()?.shipScreenshot?.(screenshot.toString('base64'), 'screenshot worker-' + id); } catch {}
    const base64 = screenshot.toString('base64');

    const providers = _deps.providers;
    if (!providers) {
      log(`[WORKER-${id}] No AI providers — cannot generate memo`, 'ERROR', 'parallel');
      return false;
    }

    // Ask the AI to generate a memo response
    const aiResult = await providers.determineNextAction(base64, { type: 'memo', prompt }).catch(() => null);
    if (!aiResult || !aiResult.text) {
      log(`[WORKER-${id}] AI failed to generate memo`, 'WARN', 'parallel');
      return false;
    }

    // Type the memo into the textarea
    const typed = await worker.page.evaluate((text: string) => {
      const textarea = document.querySelector('textarea, [contenteditable="true"]') as any;
      if (textarea) {
        if (textarea.tagName === 'TEXTAREA') {
          textarea.value = text;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        } else {
          textarea.textContent = text;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
        return true;
      }
      return false;
    }, aiResult.text).catch(() => false);

    if (!typed) {
      log(`[WORKER-${id}] Could not find textarea to type memo`, 'WARN', 'parallel');
      return false;
    }

    // Click submit
    await this._sleep(2000);
    const submitted = await this._clickCompletionButton(worker.page, id);
    if (submitted) {
      log(`[WORKER-${id}] ✅ Memo submitted`, 'INFO', 'parallel');
      return true;
    }

    return false;
  }

  /**
   * Complete an exercise/assessment module — answer questions until score screen.
   */
  private async _completeExerciseModule(worker: WorkerState, id: number): Promise<boolean> {
    const log = getLog();
    log(`[WORKER-${id}] Exercise module — answering questions...`, 'INFO', 'parallel');

    let questionsAnswered = 0;
    const maxQuestions = 50; // Safety limit

    while (questionsAnswered < maxQuestions) {
      // Take a screenshot
      const screenshot = await worker.page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => Buffer.from(''));
      try { if (screenshot && screenshot.length) getShipper()?.shipScreenshot?.(screenshot.toString('base64'), 'screenshot worker-' + id); } catch {}
      const base64 = screenshot.toString('base64');

      // Check if we're on the score screen (exercise complete)
      const onScoreScreen = await worker.page.evaluate(() => {
        const text = document.body.innerText.toLowerCase();
        return text.includes('score') || text.includes('complete') || text.includes('results') || text.includes('well done');
      }).catch(() => false);

      if (onScoreScreen) {
        log(`[WORKER-${id}] ✅ Score screen reached — exercise complete (${questionsAnswered} questions answered)`, 'INFO', 'parallel');
        return true;
      }

      // Send to AI tribunal for answer
      const providers = _deps.providers;
      if (!providers) {
        log(`[WORKER-${id}] No AI providers — cannot answer questions`, 'ERROR', 'parallel');
        return false;
      }

      const aiResult = await providers.determineNextAction(base64, { type: 'exercise' }).catch(() => null);
      if (!aiResult) {
        log(`[WORKER-${id}] AI returned no answer — retrying`, 'WARN', 'parallel');
        await this._sleep(5000);
        continue;
      }

      // Execute the answer (click, type, etc.)
      const actionExecutor = _deps.actionExecutor;
      if (actionExecutor && typeof actionExecutor.executeAction === 'function') {
        await actionExecutor.executeAction(worker.page, aiResult).catch(() => {});
      }

      questionsAnswered++;
      log(`[WORKER-${id}] Answered question ${questionsAnswered}`, 'INFO', 'parallel');
      await this._sleep(3000); // Wait for next question to load
    }

    log(`[WORKER-${id}] Reached max questions (${maxQuestions}) — assuming complete`, 'WARN', 'parallel');
    return true;
  }

  /**
   * Complete an unknown module type using the AI tribunal (fallback).
   */
  private async _completeWithAI(worker: WorkerState, id: number): Promise<boolean> {
    const log = getLog();
    log(`[WORKER-${id}] Unknown module type — using AI tribunal...`, 'INFO', 'parallel');

    // Take screenshots and let AI decide what to do for up to 20 actions
    for (let i = 0; i < 20; i++) {
      const screenshot = await worker.page.screenshot({ type: 'jpeg', quality: 80 }).catch(() => Buffer.from(''));
      try { if (screenshot && screenshot.length) getShipper()?.shipScreenshot?.(screenshot.toString('base64'), 'screenshot worker-' + id); } catch {}
      const base64 = screenshot.toString('base64');

      const providers = _deps.providers;
      if (!providers) return false;

      const aiResult = await providers.determineNextAction(base64, { type: 'unknown' }).catch(() => null);
      if (!aiResult) {
        await this._sleep(5000);
        continue;
      }

      // If AI says "wait" or "done", we might be finished
      if (aiResult.actionType === 'wait' && aiResult.currentState === 'score_screen') {
        log(`[WORKER-${id}] ✅ Score screen detected — module complete`, 'INFO', 'parallel');
        return true;
      }

      // Execute the action
      const actionExecutor = _deps.actionExecutor;
      if (actionExecutor && typeof actionExecutor.executeAction === 'function') {
        await actionExecutor.executeAction(worker.page, aiResult).catch(() => {});
      }

      await this._sleep(3000);
    }

    return false;
  }

  /**
   * Click a completion button (Next, Done, Continue, Complete, Submit).
   */
  private async _clickCompletionButton(page: any, workerId: number): Promise<boolean> {
    try {
      const result = await page.evaluate(() => {
        const buttons = document.querySelectorAll('button, [role="button"], a');
        const completionTexts = ['next', 'done', 'continue', 'complete', 'submit', 'finish'];
        for (const btn of buttons) {
          const text = btn.textContent?.trim().toLowerCase() || '';
          if (completionTexts.some(t => text.includes(t))) {
            const rect = btn.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, found: true };
            }
          }
        }
        return { found: false };
      });

      if (result.found) {
        await page.mouse.click(result.x, result.y);
        return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Wait for Flutter's CanvasKit to finish rendering.
   */
  private async _waitForFlutterRender(page: any, workerId: number, maxWaitMs: number = 60000): Promise<boolean> {
    const log = getLog();
    const startTime = Date.now();
    const diagnostic = process.env.MATHU_RENDER_DIAGNOSTICS === '1';
    const polls = { absent: 0, zero: 0, errors: 0, cardsMax: 0 };
    const reportPolls = () => {
      if (diagnostic && (renderPollReports.get(page) || 0) < 3) {
        renderPollReports.set(page, (renderPollReports.get(page) || 0) + 1);
        try { log(`[WORKER-${workerId}] [render-diag] first-canvas polls absent=${polls.absent} zero=${polls.zero} eval-error=${polls.errors}`, 'DEBUG', 'parallel'); } catch {}
      }
    };

    while (Date.now() - startTime < maxWaitMs) {
      try {
        // Render readiness has TWO independent signals, either of which is sufficient:
        //   (a) a sized Flutter <canvas> (canvas-based app), OR
        //   (b) module cards as DOM elements — _findAndClickModuleCard queries exactly
        //       [class*="card"], [role="listitem"], .module-card, so an assignments page
        //       that renders modules as DOM (with NO canvas) must not be blocked by a
        //       canvas-only gate (which would log absent=60 on a fully rendered page).
        // The card path also requires no password input on the page, so a redirected
        // login form (which may have a "card"-classed wrapper) cannot satisfy the gate.
        // No page text, attributes or pixels are read — only element counts and sizes.
        // Legacy string returns ('absent'/'zero'/'nonzero' from test mocks) normalize.
        const result = await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          const canvasState = !canvas ? 'absent' : (canvas.width > 0 && canvas.height > 0 ? 'nonzero' : 'zero');
          let cards = 0, hasPassword = false;
          try {
            if (typeof document.querySelectorAll === 'function') {
              cards = document.querySelectorAll('[class*="card"], [role="listitem"], .module-card').length;
              hasPassword = document.querySelectorAll('input[type="password"]').length > 0;
            }
          } catch {}
          return { canvas: canvasState, cards, hasPassword };
        });
        const canvasState = (result && typeof result === 'object') ? result.canvas : result;
        const cards = (result && typeof result === 'object' && typeof result.cards === 'number') ? result.cards : 0;
        const hasPassword = (result && typeof result === 'object' && typeof result.hasPassword === 'boolean') ? result.hasPassword : false;
        if (canvasState === 'absent') polls.absent++;
        else if (canvasState === 'zero') polls.zero++;
        if (cards > polls.cardsMax) polls.cardsMax = cards;
        if (canvasState === 'nonzero' || (cards >= 1 && !hasPassword)) {
          reportPolls();
          const sig = canvasState === 'nonzero' ? `canvas=${canvasState}` : `cards=${cards}`;
          log(`[WORKER-${workerId}] Render signal detected (${sig}) after ${Math.round((Date.now() - startTime) / 1000)}s; render readiness unverified`, 'INFO', 'parallel');
          return true;
        }
      } catch { polls.errors++; }
      await this._sleep(1000);
    }
    reportPolls();
    // Always report the breakdown on failure (NOT gated behind MATHU_RENDER_DIAGNOSTICS):
    // absent = no <canvas>, zero = canvas unsized, eval-error = context detached/closed,
    // cardsMax = most module-card DOM elements seen in any single poll. cardsMax=0 means
    // neither canvas nor cards ever appeared (bundle did not load); cardsMax>0 with no
    // success means cards were present but a password input was too (redirected to login).
    // Only coarse counts — no page content.
    // On timeout, gather a coarse diagnostic (no page content/URLs — only
    // counts + readyState + whether the Flutter bundle script tag is present)
    // so the next log shows WHY the canvas is absent: bundle-not-loaded (no
    // script tag), bundle-loaded-but-app-not-initialized (script tag present,
    // body empty), or page-not-navigated (readyState still loading).
    let _renderDiag = '';
    try {
      const _d = await page.evaluate(() => {
        const scripts = typeof document.querySelectorAll === 'function' ? document.querySelectorAll('script') : [];
        const flutterScripts = typeof document.querySelectorAll === 'function'
          ? document.querySelectorAll('script[src*="main.dart"], script[src*="flutter"], script[src*="canvaskit"]').length
          : 0;
        return {
          ready: document.readyState,
          scriptCount: scripts.length,
          flutterScripts,
          bodyLen: document.body ? document.body.innerHTML.length : 0,
        };
      });
      if (_d && typeof _d === 'object') {
        _renderDiag = ` ready=${(_d as any).ready} scripts=${(_d as any).scriptCount} flutterScripts=${(_d as any).flutterScripts} bodyLen=${(_d as any).bodyLen}`;
      }
    } catch {}
    log(`[WORKER-${workerId}] No nonzero canvas detected within ${Math.round(maxWaitMs / 1000)}s (polls absent=${polls.absent} zero=${polls.zero} eval-error=${polls.errors} cardsMax=${polls.cardsMax}); render status unknown — proceeding anyway${_renderDiag}`, 'WARN', 'parallel');
    return false;
  }

  /**
   * Mark a module as done in Turso.
   */
  private async _markModuleDone(moduleName: string, workerId: number): Promise<void> {
    const db = _deps.database;
    if (!db || !db.db) return;
    try {
      db.db.prepare('UPDATE completed_modules SET completed_at = ? WHERE name = ?').run(Date.now(), moduleName);
    } catch {}
  }

  /**
   * Mark a module as failed (release the claim so another worker can retry).
   */
  private async _markModuleFailed(moduleName: string, workerId: number): Promise<void> {
    const db = _deps.database;
    if (!db || !db.db) return;
    try {
      // Delete the claim so another worker can pick it up
      db.db.prepare('DELETE FROM completed_modules WHERE name = ? AND completed_at = 0').run(moduleName);
    } catch {}
  }

  /**
   * Health monitor — logs worker status every 60 seconds.
   */
  private _startHealthMonitor(): void {
    const log = getLog();
    setInterval(() => {
      const uptime = Math.round((Date.now() - this.startTime) / 1000);
      const workers = Array.from(this.workers.values()).map(w => ({
        id: w.id,
        status: w.status,
        module: w.currentModule?.name || null,
        type: w.currentModule?.type || null,
        completed: w.modulesCompleted,
        errors: w.errors,
      }));
      const totalCompleted = workers.reduce((sum: number, w: any) => sum + w.completed, 0);
      const totalErrors = workers.reduce((sum: number, w: any) => sum + w.errors, 0);
      log(`[PARALLEL] 📊 Uptime: ${uptime}s | Workers: ${this.workers.size} | Modules completed: ${totalCompleted} | Errors: ${totalErrors}`, 'INFO', 'parallel');
      for (const w of workers) {
        log(`[PARALLEL]   Worker ${w.id}: ${w.status} | module=${w.module ? 'active' : 'idle'} | ✅${w.completed} ❌${w.errors}`, 'INFO', 'parallel');
      }
    }, 60000).unref?.();
  }

  async stop(): Promise<void> {
    const log = getLog();
    log('[PARALLEL] Stopping coordinator...', 'INFO', 'parallel');
    this.running = false;

    for (const [id, worker] of this.workers) {
      try {
        await worker.context.close();
        log(`[PARALLEL] Worker ${id} context closed`, 'INFO', 'parallel');
      } catch {}
    }

    this.workers.clear();

    try {
      const browserMod = require('./browser');
      await browserMod.closeBrowser();
      log('[PARALLEL] Browser closed', 'INFO', 'parallel');
    } catch {}
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  getStats(): any {
    const workers = Array.from(this.workers.values()).map(w => ({
      id: w.id,
      status: w.status,
      currentModule: w.currentModule?.name || null,
      currentType: w.currentModule?.type || null,
      modulesCompleted: w.modulesCompleted,
      errors: w.errors,
    }));
    return {
      workerCount: this.workers.size,
      running: this.running,
      uptime: this.startTime ? Math.round((Date.now() - this.startTime) / 1000) : 0,
      totalModulesCompleted: workers.reduce((sum: number, w: any) => sum + w.modulesCompleted, 0),
      totalErrors: workers.reduce((sum: number, w: any) => sum + w.errors, 0),
      workers,
    };
  }
}

const _coordinator = new ParallelCoordinator();

module.exports = {
  ParallelCoordinator,
  start: () => _coordinator.start(),
  stop: () => _coordinator.stop(),
  getStats: () => _coordinator.getStats(),
  _injectDependencies,
};
