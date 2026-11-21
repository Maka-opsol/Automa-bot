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
        // 1. In _ensureLoggedIn(worker, id): verify the page isn't showing a login prompt
//    or empty content before returning "Already logged in".
      const pageState = await worker.page.evaluate(() => {
        const text = (document.body?.innerText || '').trim().toLowerCase();
        const interactiveCount = document.querySelectorAll('button, [role="button"], input, a[href], canvas').length;
        const looksLikeLogin =
          text.includes('sign in with microsoft') ||
          text.includes('sign in with apple') ||
          text.includes('sign in with phone') ||
          (text.includes('sign in') && text.length < 500);
        return { textLen: text.length, interactiveCount, looksLikeLogin };
      }).catch(() => ({ textLen: 0, interactiveCount: 0, looksLikeLogin: false }));

      if (pageState.looksLikeLogin) {
        log(`[WORKER-${id}] App page shows login prompt — attempting auth handoff`, 'INFO', 'parallel');
        const authGuard = _deps.authGuard;
        if (authGuard && typeof authGuard.ensureAuthenticated === 'function') {
          diag?.step('guard_handoff');
          const result = await authGuard.ensureAuthenticated(worker.page);
          outcome = result === false ? 'guard_returned_false' : 'guard_returned_nonfalse_unverified';
          return result !== false;
        }
        const auth = _deps.auth;
        if (auth && typeof auth.authenticate === 'function') {
          diag?.step('auth_handoff');
          const authed = await auth.authenticate(worker.page);
          outcome = authed === false ? 'auth_returned_false' : 'auth_returned_unverified';
          return authed !== false;
        }
        return false;
      }

      // Already logged in (not on Microsoft login and not showing login prompt)
      log(`[WORKER-${id}] Already logged in`, 'INFO', 'parallel');
      outcome = diag?.classify() === 'app_origin' ? 'legacy_true_app_unverified' : 'legacy_true_external_unverified';
      return true;

        // 2. In _waitForFlutterRender(page, workerId): check ALL canvases on the page
//    and fall back to rendered DOM/text/semantics signals rather than relying
//    solely on document.querySelector('canvas').
    while (Date.now() - startTime < maxWaitMs) {
      try {
        const check = await page.evaluate(() => {
          const canvases = Array.from(document.querySelectorAll('canvas'));
          const hasNonzeroCanvas = canvases.some((c: any) => c.width > 0 && c.height > 0);
          const hasAnyCanvas = canvases.length > 0;
          const flEng = (window as any).flutter?.web?.engine;
          const semanticsCount = flEng?.semantics?._semantics ? Object.keys(flEng.semantics._semantics).length : 0;
          const interactiveCount = document.querySelectorAll('button, [role="button"], input, a[href], [class*="card"]').length;
          const bodyTextLen = (document.body?.innerText || '').trim().length;
          const hasRenderedContent = semanticsCount > 0 || interactiveCount > 0 || bodyTextLen > 20;
          return {
            hasNonzeroCanvas,
            hasAnyCanvas,
            hasRenderedContent,
            state: hasNonzeroCanvas ? 'nonzero' : (hasRenderedContent ? 'content' : (hasAnyCanvas ? 'zero' : 'absent')),
          };
        });

        if (diagnostic) {
          if (check.state === 'absent') polls.absent++;
          if (check.state === 'zero') polls.zero++;
        }

        if (check.hasNonzeroCanvas || check.hasRenderedContent) {
          reportPolls();
          log(
            `[WORKER-${workerId}] Render detected after ${Math.round((Date.now() - startTime) / 1000)}s (mode=${check.state})`,
            'INFO',
            'parallel'
          );
          return true;
        }
      } catch { if (diagnostic) polls.errors++; }
      await this._sleep(1000);
    }

        // Step 3: Claim a module from Turso
        const module = await this._claimNextModule(id);
        if (!module) {
          log(`[WORKER-${id}] No modules available — waiting 30s`, 'INFO', 'parallel');
          await this._sleep(30000);
          continue;
        }

        worker.currentModule = { name: module.name, type: module.type, claimedAt: Date.now() };
        log(`[WORKER-${id}] Claimed module (type: ${module.type})`, 'INFO', 'parallel');

        // Step 4: Find and click the module card
        const clicked = await this._findAndClickModuleCard(worker.page, module.name, id);
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

      // Check if we're on the assignments page (already logged in)
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
        // Already logged in
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

  /** Navigate as before, with optional passive timing and outcome metadata. */
  private async _navigateAssignments(worker: WorkerState, isReturn: boolean): Promise<any> {
    const diag = worker.authNetDiag;
    diag?.begin(isReturn ? 'assignments_return_load' : 'assignments_load');
    try {
      const result = await worker.page.goto(getCONFIG().APP_URL + '/assignments', { waitUntil: 'load', timeout: 120000 });
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
  private async _waitForFlutterRender(page: any, workerId: number): Promise<boolean> {
    const log = getLog();
    const maxWaitMs = 60000;
    const startTime = Date.now();
    const diagnostic = process.env.MATHU_RENDER_DIAGNOSTICS === '1';
    const polls = { absent: 0, zero: 0, errors: 0 };
    const reportPolls = () => {
      if (diagnostic && (renderPollReports.get(page) || 0) < 3) {
        renderPollReports.set(page, (renderPollReports.get(page) || 0) + 1);
        try { log(`[WORKER-${workerId}] [render-diag] first-canvas polls absent=${polls.absent} zero=${polls.zero} eval-error=${polls.errors}`, 'DEBUG', 'parallel'); } catch {}
      }
    };

    while (Date.now() - startTime < maxWaitMs) {
      try {
        // Exactly the same first-canvas predicate; optional mode adds only a coarse result.
        const result = diagnostic ? await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return 'absent';
          return canvas.width > 0 && canvas.height > 0 ? 'nonzero' : 'zero';
        }) : await page.evaluate(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return false;
          return canvas.width > 0 && canvas.height > 0;
        });
        if (diagnostic && result === 'absent') polls.absent++;
        if (diagnostic && result === 'zero') polls.zero++;
        if (diagnostic ? result === 'nonzero' : result) {
          reportPolls();
          log(`[WORKER-${workerId}] Nonzero canvas detected after ${Math.round((Date.now() - startTime) / 1000)}s; render readiness unverified`, 'INFO', 'parallel');
          return true;
        }
      } catch { if (diagnostic) polls.errors++; }
      await this._sleep(1000);
    }
    reportPolls();
    log(`[WORKER-${workerId}] No nonzero canvas detected within 60s; render status unknown — proceeding anyway`, 'WARN', 'parallel');
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
