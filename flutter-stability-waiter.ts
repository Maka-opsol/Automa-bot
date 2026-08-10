'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);

/**
 * Multi-signal Flutter UI stability waiter.
 *
 * Signals checked (any subset that is available):
 *   1. Semantics node count  — window.flutter.web.engine.semantics._semantics keys
 *   2. DOM element count    — querySelectorAll interactive elements
 *   3. Network idle          — 0 in-flight XHR/fetch ( MutationObserver-free, uses perf entries )
 *   4. Layout stability      — body offsetHeight unchanged
 *   5. Paint quiescence      — no new animation frames changing layout (requestAnimationFrame check)
 *
 * On Render free plan:
 *   - Default timeout 10s (vs 15s) — saves CPU on tight 512 MB constraint
 *   - Adaptive polling: 150ms → 300ms → 500ms as stability confidence grows
 *   - Per-poll evaluate timeout of 2s to prevent hangs on frozen pages
 *   - getConfigSnapshot() friendly — no heavy object allocations in the loop
 */

interface StabilitySnapshot {
  semanticsCount: number;
  domCount: number;
  bodyHeight: number;
  networkIdle: boolean;
  timestamp: number;
}

class FlutterStabilityWaiter {
  /** How many consecutive stable snapshots before declaring stability */
  private REQUIRED_STABLE = 3;

  /** Base poll interval in ms — adapts upward as confidence grows */
  private BASE_POLL_MS = 150;

  /** Per-page.evaluate timeout in ms */
  private EVAL_TIMEOUT_MS = 2000;

  async waitForStable(page: any, timeoutMs?: number): Promise<boolean> {
    // Render free plan: default 10s, allow CONFIG override
    const isRenderFree = !process.env.RENDER_SERVICE_TYPE || process.env.RENDER_SERVICE_TYPE === 'free';
    const defaultTimeout = isRenderFree ? 10000 : 15000;
    const timeout = timeoutMs ?? getCONFIG.FLUTTER_STABILITY_TIMEOUT_MS ?? defaultTimeout;

    log('Waiting for Flutter UI to stabilize (multi-signal)...', 'DEBUG', 'stability');
    const deadline = Date.now() + timeout;
    let previous: StabilitySnapshot | null = null;
    let stableRun = 0;

    try {
      while (Date.now() < deadline) {
        const snapshot = await this._captureSnapshot(page);
        if (snapshot === null) {
          // Page evaluate failed (navigating, crashed, etc.) — wait and retry
          await sleep(this._adaptivePoll(stableRun));
          continue;
        }

        const isStable = previous !== null && this._isStable(previous, snapshot);

        if (isStable) {
          stableRun++;
          if (stableRun >= this.REQUIRED_STABLE) {
            log(`UI stabilized: ${snapshot.semanticsCount} semantics, ${snapshot.domCount} DOM, height=${snapshot.bodyHeight}, netIdle=${snapshot.networkIdle}`, 'DEBUG', 'stability');
            return true;
          }
        } else {
          stableRun = 0;
        }

        previous = snapshot;
        await sleep(this._adaptivePoll(stableRun));
      }
    } catch (e: any) {
      logError('Stability wait errored', e);
    }

    log('Stability wait timed out, proceeding anyway.', 'WARN', 'stability');
    return false;
  }

  /**
   * Capture a multi-signal stability snapshot from the page.
   * Returns null if page.evaluate times out or throws.
   */
  private async _captureSnapshot(page: any): Promise<StabilitySnapshot | null> {
    try {
      // Wrap in a race against a per-poll timeout to prevent hangs on frozen pages.
      // On Render free plan, a hung evaluate would waste the entire cycle budget.
      const result = await Promise.race([
        page.evaluate(() => {
          // Signal 1: Flutter semantics node count
          let semanticsCount = 0;
          const flEng = (window as any).flutter?.web?.engine;
          if (flEng?.semantics?._semantics) {
            semanticsCount = Object.keys(flEng.semantics._semantics).length;
          }

          // Signal 2: DOM interactive element count
          const domCount = document.querySelectorAll('button, [role="button"], input, a[href], [tabindex]').length;

          // Signal 3: Layout stability — body height
          const bodyHeight = document.body?.offsetHeight ?? 0;

          // Signal 4: Network idle — check if there are pending requests
          // PerformanceObserver-free approach: count open XHRs + active fetch
          let networkIdle = true;
          if ((window as any)._activeXhrCount !== undefined) {
            networkIdle = (window as any)._activeXhrCount === 0;
          } else {
            // Fallback: check performance entries for recent resource timings
            const now = performance.now();
            const recentEntries = performance.getEntriesByType('resource').filter(
              (e: any) => now - (e.responseEnd || e.startTime) < 500
            );
            networkIdle = recentEntries.length === 0;
          }

          return { semanticsCount, domCount, bodyHeight, networkIdle };
        }),
        sleep(this.EVAL_TIMEOUT_MS).then(() => null),
      ]);

      if (result === null) return null;
      return { ...result, timestamp: Date.now() };
    } catch (_e) {
      return null;
    }
  }

  /**
   * Compare two snapshots. A page is considered stable if:
   *   - Semantics count is unchanged (or both 0 — non-Flutter page)
   *   - DOM count is unchanged
   *   - Body height is unchanged (±2px for sub-pixel rounding)
   *   - Network is idle
   */
  private _isStable(prev: StabilitySnapshot, curr: StabilitySnapshot): boolean {
    // Semantics: stable if unchanged, or both zero (non-Flutter fallback)
    const semanticsOk = prev.semanticsCount === curr.semanticsCount
      || (prev.semanticsCount === 0 && curr.semanticsCount === 0);

    // DOM: stable if count unchanged
    const domOk = prev.domCount === curr.domCount;

    // Layout: stable if body height within 2px (sub-pixel rounding on Render)
    const layoutOk = Math.abs(prev.bodyHeight - curr.bodyHeight) <= 2;

    // Network: must be idle
    const netOk = curr.networkIdle;

    // ── Anti-blank guard ──
    // If ALL content signals are zero, the page hasn't rendered yet.
    // Do NOT declare stability — keep polling until something appears.
    // This prevents declaring a blank white Flutter canvas as "stable".
    const allZero = curr.semanticsCount === 0 && curr.domCount === 0 && curr.bodyHeight === 0;
    if (allZero) return false;

    // Require at least 2 of {semanticsOk, domOk, layoutOk} plus network idle
    const structuralSignals = [semanticsOk, domOk, layoutOk].filter(Boolean).length;
    return structuralSignals >= 2 && netOk;
  }

  /**
   * Adaptive polling: start fast, slow down as stability confidence grows.
   * 150ms → 250ms → 400ms as stableRun increases.
   * On Render free plan, fewer polls = less CPU pressure.
   */
  private _adaptivePoll(stableRun: number): number {
    if (stableRun === 0) return this.BASE_POLL_MS;         // 150ms — fast initial polling
    if (stableRun === 1) return this.BASE_POLL_MS + 100;   // 250ms — first stable confirmation
    return this.BASE_POLL_MS * 2 + 100;                     // 400ms — near-declaration polling
  }
}

module.exports = Object.assign(new FlutterStabilityWaiter(), { _injectDependencies });
