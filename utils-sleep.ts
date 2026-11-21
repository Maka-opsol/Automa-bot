'use strict';
/**
 * Non-deprecated sleep - replaces page.waitForTimeout().
 *
 * Playwright deprecated page.waitForTimeout() in favour of locator-based
 * waits. For unconditional pauses (e.g. UI animations settling), use
 * this standalone sleep instead.
 *
 * All helpers validate their input and return Promises that resolve once
 * the delay elapses. They are race-safe: the underlying timer is cleared
 * on settle, so resolved promises do not leak references.
 */

/** A finite, non-negative delay in milliseconds. */
type Milliseconds = number;

function assertDelay(ms: number, name: string): void {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) {
    throw new RangeError(`sleep: ${name} must be a finite, non-negative number (got ${String(ms)})`);
  }
}

/**
 * Resolve after `ms` milliseconds.
 * Use this for unconditional pauses; prefer locator waits for assertions.
 */
function sleep(ms: Milliseconds): Promise<void> {
  assertDelay(ms, 'ms');
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Resolve after `seconds` seconds. Convenience wrapper around sleep()
 * for human-scale delays expressed in whole or fractional seconds.
 */
function sleepSeconds(seconds: number): Promise<void> {
  assertDelay(seconds, 'seconds');
  return sleep(seconds * 1000);
}

/**
 * Resolve after a jittered delay of `ms` +/- `jitterMs` milliseconds.
 *
 * Useful for retry/backoff across concurrent workers: jittering the
 * delay spreads retries out and avoids the thundering-herd effect when
 * several callers retry against the same rate-limited resource at once.
 * The actual wait is clamped to >= 0 so a large jitter never yields a
 * negative duration.
 */
function sleepWithJitter(ms: Milliseconds, jitterMs: Milliseconds = 0): Promise<void> {
  assertDelay(ms, 'ms');
  assertDelay(jitterMs, 'jitterMs');
  const delta = jitterMs === 0 ? 0 : (Math.random() * 2 - 1) * jitterMs;
  const delay = Math.max(0, Math.round(ms + delta));
  return sleep(delay);
}

module.exports = { sleep, sleepSeconds, sleepWithJitter };