// bootstrap-calibration.ts
// Last modified: 2026-11-15
//
// THE CALIBRATION GATE
//
// Before the bot engages any cloud providers, subsystems, self-heal,
// stealth, or external services, it must prove the basic algorithm works:
//
//   1. Open a browser, navigate to the target URL.
//   2. Take a screenshot.
//   3. Send the screenshot to Ollama (the local, no-API-key provider).
//   4. Ollama returns an action (click / type / scroll / wait) or "done".
//   5. Execute the action.
//   6. Repeat until Ollama reports the assignment page is reached.
//
// Only on success does the caller proceed to startDaemon() — which engages
// the full tribunal, cloud providers, and every subsystem.
//
// FAILURE SEMANTICS
//   - BOOTSTRAP_ENABLED=0  → skip the bootstrap entirely, proceed to daemon.
//   - BOOTSTRAP_STRICT=0 (default) → if the bootstrap fails or Ollama is
//     unreachable, log a WARNING and proceed to the daemon anyway (graceful
//     degradation — the cloud providers will take over vision/action). This
//     is the safe default for production environments that may not have
//     Ollama installed.
//   - BOOTSTRAP_STRICT=1 → HARD gate. If the bootstrap fails for any reason,
//     the bot does NOT engage the daemon. Use this in local/dev environments
//     where Ollama is guaranteed and the calibration MUST pass.

// Env vars are read inside runBootstrap() at CALL TIME (not module load
// time) so tests can change them between cases without cache-clearing hacks.
// BOOTSTRAP_PROMPT is a static constant (no env dependency) so it stays at
// module level.

// The prompt sent to Ollama with every screenshot. It asks for a single
// JSON action — the same actionType vocabulary the tribunal uses (click,
// type, scroll, wait) plus a "done" sentinel for when the assignment page
// is visible. Coordinates are fractions of the viewport (0.0–1.0).
const BOOTSTRAP_PROMPT = `You are a browser navigation agent. You are looking at a screenshot of a web app.
GOAL: reach the "assignment page" — the page where math problems or questions are listed for the student to solve.

Decide the SINGLE best action to get closer to that goal.
Return ONLY a JSON object (no markdown fences, no text outside the JSON):
{"actionType":"click"|"type"|"scroll"|"wait"|"done","targetX":<0.0-1.0>,"targetY":<0.0-1.0>,"text":"<for type>","scrollAmount":<-1.0 up to 1.0 down>,"waitMs":<ms>,"reasoning":"<one sentence>"}

Rules:
- "done" ONLY when you can see math problems or questions on the page (the assignment page is reached).
- "click" to press a button, link, or menu item that leads toward assignments. Include targetX/targetY.
- "type" if there is a login/sign-in form. Click the field first (targetX/targetY), then provide text.
- "scroll" to reveal content below the fold if the assignment might be further down. Use scrollAmount.
- "wait" if the page is still loading (spinner, blank). Use waitMs.
- targetX/targetY are fractions of the viewport: 0.0 = left/top edge, 1.0 = right/bottom edge.`;

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }

// Extract the first {...} block from a model response and parse it as JSON.
// Small local models sometimes wrap JSON in prose or markdown fences — this
// tolerates that. Returns null if no valid JSON object is found.
function extractJSON(text: string): any | null {
  if (!text || typeof text !== 'string') return null;
  // Strip markdown code fences if present
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    // Try a looser match — sometimes models emit trailing commas or comments
    const loose = match[0]
      .replace(/,\s*}/g, '}')
      .replace(/,\s*]/g, ']');
    try { return JSON.parse(loose); } catch { return null; }
  }
}

// Execute one bootstrap action using browser primitives directly (NOT the
// full action executor — the bootstrap is deliberately minimal, with no DI
// graph, so it can run before the container's heavy modules engage).
async function executeBootstrapAction(
  page: any,
  action: any,
  browser: any,
  viewport: { width: number; height: number },
): Promise<void> {
  const { width, height } = viewport;
  switch (action.actionType) {
    case 'click': {
      if (action.targetX == null || action.targetY == null) return;
      const x = Math.round(action.targetX * width);
      const y = Math.round(action.targetY * height);
      const click = browser.performClickWithRetry || browser.humanMoveAndClick;
      if (click) {
        await click(page, x, y, 3);
      } else {
        await page.mouse.click(x, y);
      }
      break;
    }
    case 'type': {
      // Click to focus the field first, then type
      if (action.targetX != null && action.targetY != null) {
        const x = Math.round(action.targetX * width);
        const y = Math.round(action.targetY * height);
        const click = browser.performClickWithRetry || browser.humanMoveAndClick;
        if (click) {
          await click(page, x, y, 1);
        } else {
          await page.mouse.click(x, y);
        }
        await sleep(250);
      }
      if (action.text) {
        await page.keyboard.type(String(action.text), { delay: 50 });
      }
      break;
    }
    case 'scroll': {
      const amount = Number(action.scrollAmount) || 0;
      const delta = Math.round(amount * height * 0.5);
      if (browser.scrollPage) {
        await browser.scrollPage(page, 0, delta);
      } else {
        await page.mouse.wheel(0, delta);
      }
      break;
    }
    case 'wait': {
      const ms = Number(action.waitMs) || 2000;
      await sleep(ms);
      break;
    }
    case 'done':
      // Success sentinel — nothing to execute
      break;
    default:
      // Unknown actionType — wait briefly and let the next iteration try again
      await sleep(1000);
  }
}

interface BootstrapResult {
  success: boolean;
  iterations: number;
  skipped?: boolean;
  reason?: string;
}

// The main entry point. Called from render-free-plan.ts (and hf-spaces.ts)
// BEFORE startDaemon(). On success (or graceful skip), the caller proceeds
// to engage the full daemon. On strict-mode failure, the caller halts.
//
// `ollamaProvider` is an optional injection point for testing — when provided,
// the bootstrap uses it instead of require('./providers-ollama').OllamaProvider().
// Production callers omit it.
async function runBootstrap({ container, log, logError, ollamaProvider }: any): Promise<BootstrapResult> {
  // Read env vars at CALL TIME (not module load time) so tests can change
  // them between cases without cache-clearing hacks.
  const BOOTSTRAP_ENABLED = process.env.BOOTSTRAP_ENABLED !== '0';
  const BOOTSTRAP_STRICT = process.env.BOOTSTRAP_STRICT === '1';
  const BOOTSTRAP_MAX_ITERATIONS = parseInt(process.env.BOOTSTRAP_MAX_ITERATIONS || '15', 10);
  const BOOTSTRAP_TARGET_URL =
    process.env.BOOTSTRAP_TARGET_URL ||
    process.env.APP_URL ||
    'https://app.mathu.co.za/';
  const BOOTSTRAP_NAV_TIMEOUT_MS = parseInt(process.env.BOOTSTRAP_NAV_TIMEOUT_MS || '30000', 10);
  const BOOTSTRAP_OLLAMA_TIMEOUT_MS = parseInt(process.env.BOOTSTRAP_OLLAMA_TIMEOUT_MS || '60000', 10);
  const BOOTSTRAP_POST_ACTION_DELAY_MS = parseInt(process.env.BOOTSTRAP_POST_ACTION_DELAY_MS || '1500', 10);

  if (!BOOTSTRAP_ENABLED) {
    log('Bootstrap DISABLED (BOOTSTRAP_ENABLED=0) — proceeding directly to daemon', 'INFO', 'bootstrap');
    return { success: true, skipped: true, iterations: 0, reason: 'disabled' };
  }

  log(
    `Bootstrap: starting Ollama-only calibration (target=${BOOTSTRAP_TARGET_URL}, max=${BOOTSTRAP_MAX_ITERATIONS} iter, strict=${BOOTSTRAP_STRICT})`,
    'INFO', 'bootstrap',
  );

  // 1. Load the Ollama provider — the ONLY model the bootstrap uses.
  //    OllamaProvider() returns null if Ollama isn't running on localhost:11434.
  let ollamaFn: any = null;
  if (ollamaProvider) {
    // Injection point for testing — ollamaProvider is either a function
    // (already unwrapped) or an object with an OllamaProvider() factory.
    ollamaFn = typeof ollamaProvider === 'function'
      ? ollamaProvider
      : ollamaProvider.OllamaProvider?.();
  } else {
    try {
      const ollamaMod = require('./providers-ollama');
      ollamaFn = ollamaMod.OllamaProvider();
    } catch (e: any) {
      logError('Bootstrap: failed to load providers-ollama module', e);
    }
  }

  if (!ollamaFn) {
    const msg = 'Ollama not reachable on localhost:11434 — bootstrap cannot run. ' +
      'Install Ollama (`ollama serve`) and pull a vision model (`ollama pull qwen2.5vl:7b`).';
    if (BOOTSTRAP_STRICT) {
      logError(`Bootstrap STRICT mode: ${msg} — HALTING, daemon will not start.`, new Error('ollama_unreachable'));
      return { success: false, iterations: 0, reason: 'ollama_unreachable' };
    }
    log(`Bootstrap: ${msg} — proceeding to daemon anyway (cloud providers will handle vision).`, 'WARN', 'bootstrap');
    return { success: true, skipped: true, iterations: 0, reason: 'ollama_unreachable' };
  }
  log('Bootstrap: Ollama reachable — starting calibration loop', 'INFO', 'bootstrap');

  // 2. Get the browser from the container (already registered + configured).
  let browser: any;
  try {
    browser = container.get('browser');
  } catch (e: any) {
    logError('Bootstrap: browser module not available in container', e);
    if (BOOTSTRAP_STRICT) return { success: false, iterations: 0, reason: 'browser_unavailable' };
    return { success: true, skipped: true, iterations: 0, reason: 'browser_unavailable' };
  }

  // 3. Launch the browser + navigate to the target URL.
  try {
    await browser.launchBrowser();
  } catch (e: any) {
    logError('Bootstrap: browser launch failed', e);
    if (BOOTSTRAP_STRICT) return { success: false, iterations: 0, reason: 'browser_launch_failed' };
    return { success: true, skipped: true, iterations: 0, reason: 'browser_launch_failed' };
  }

  let page: any;
  try {
    page = browser.getPage();
    await page.goto(BOOTSTRAP_TARGET_URL, {
      waitUntil: 'domcontentloaded',
      timeout: BOOTSTRAP_NAV_TIMEOUT_MS,
    });
    log(`Bootstrap: navigated to ${BOOTSTRAP_TARGET_URL}`, 'INFO', 'bootstrap');
  } catch (e: any) {
    logError('Bootstrap: navigation to target URL failed', e);
    if (BOOTSTRAP_STRICT) return { success: false, iterations: 0, reason: 'navigation_failed' };
    return { success: true, skipped: true, iterations: 0, reason: 'navigation_failed' };
  }

  // Give the page a moment to settle after navigation (Flutter apps render
  // async). Configurable via BOOTSTRAP_SETTLE_MS so tests can set it to 0.
  const BOOTSTRAP_SETTLE_MS = parseInt(process.env.BOOTSTRAP_SETTLE_MS || '2000', 10);
  await sleep(BOOTSTRAP_SETTLE_MS);

  // 4. The calibration loop: screenshot → Ollama → action → repeat.
  let lastActionType: string | null = null;
  let stuckCount = 0;

  for (let iter = 1; iter <= BOOTSTRAP_MAX_ITERATIONS; iter++) {
    // --- Take a screenshot ---
    let base64: string;
    try {
      const buf = await page.screenshot({ type: 'jpeg', quality: 70 });
      base64 = buf.toString('base64');
    } catch (e: any) {
      logError(`Bootstrap iter ${iter}: screenshot failed`, e);
      await sleep(1000);
      continue;
    }

    // Compress if the browser module supports it (keeps the Ollama request small)
    const compressed = browser.compressScreenshot?.(base64, 1024, 70) || base64;

    // --- Ask Ollama what to do ---
    // validate:false → get the raw model text back (we parse ourselves so we
    // can recognize the 'done' sentinel that validateActionResponse would
    // normalize to 'wait').
    let rawResponse: any;
    try {
      rawResponse = await Promise.race([
        ollamaFn(compressed, BOOTSTRAP_PROMPT, null, {
          validate: false,
          timeoutMs: BOOTSTRAP_OLLAMA_TIMEOUT_MS,
        }),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Ollama call timed out')), BOOTSTRAP_OLLAMA_TIMEOUT_MS),
        ),
      ]);
    } catch (e: any) {
      logError(`Bootstrap iter ${iter}: Ollama call failed`, e);
      await sleep(2000);
      continue;
    }

    // --- Parse the action ---
    const responseText = typeof rawResponse === 'string'
      ? rawResponse
      : (rawResponse?.choices?.[0]?.message?.content ?? JSON.stringify(rawResponse));
    const action = extractJSON(responseText);
    if (!action || !action.actionType) {
      log(`Bootstrap iter ${iter}: could not parse action from Ollama response — retrying`, 'WARN', 'bootstrap');
      await sleep(1000);
      continue;
    }

    log(
      `Bootstrap iter ${iter}/${BOOTSTRAP_MAX_ITERATIONS}: ${action.actionType}` +
      (action.reasoning ? ` — ${String(action.reasoning).slice(0, 120)}` : ''),
      'INFO', 'bootstrap',
    );

    // --- Success: assignment page reached ---
    if (action.actionType === 'done') {
      log(
        `Bootstrap SUCCESS — reached assignment page in ${iter} iteration(s). ` +
        'Engaging full daemon (cloud providers, subsystems, external services).',
        'INFO', 'bootstrap',
      );
      return { success: true, iterations: iter };
    }

    // --- Stuck detection: same action 3 times in a row → abort ---
    // stuckCount counts consecutive repeats. At >= 2 repeats (3 total
    // occurrences), the loop is clearly stuck on the same action.
    if (action.actionType === lastActionType) {
      stuckCount++;
      if (stuckCount >= 2) {
        log(
          `Bootstrap iter ${iter}: stuck on '${action.actionType}' for 3 consecutive iterations — aborting calibration`,
          'WARN', 'bootstrap',
        );
        if (BOOTSTRAP_STRICT) {
          return { success: false, iterations: iter, reason: 'stuck' };
        }
        log('Bootstrap non-strict: proceeding to daemon despite being stuck (cloud providers will take over)', 'WARN', 'bootstrap');
        return { success: true, skipped: true, iterations: iter, reason: 'stuck' };
      }
    } else {
      stuckCount = 0;
      lastActionType = action.actionType;
    }

    // --- Execute the action ---
    const viewport = browser.getViewportDimensions?.() || { width: 1280, height: 720 };
    try {
      await executeBootstrapAction(page, action, browser, viewport);
    } catch (e: any) {
      logError(`Bootstrap iter ${iter}: action execution failed`, e);
    }
    await sleep(BOOTSTRAP_POST_ACTION_DELAY_MS);
  }

  // Max iterations exhausted without reaching the assignment page.
  log(
    `Bootstrap FAILED — did not reach assignment page in ${BOOTSTRAP_MAX_ITERATIONS} iterations.`,
    'ERROR', 'bootstrap',
  );
  if (BOOTSTRAP_STRICT) {
    return { success: false, iterations: BOOTSTRAP_MAX_ITERATIONS, reason: 'max_iterations' };
  }
  log('Bootstrap non-strict: proceeding to daemon anyway (cloud providers will take over vision/navigation)', 'WARN', 'bootstrap');
  return { success: true, skipped: true, iterations: BOOTSTRAP_MAX_ITERATIONS, reason: 'max_iterations' };
}

module.exports = {
  runBootstrap,
  // Exported for the smoke test:
  _executeBootstrapAction: executeBootstrapAction,
  _extractJSON: extractJSON,
  BOOTSTRAP_PROMPT,
};
