'use strict';
/**
 * Non-deprecated sleep — replaces page.waitForTimeout().
 *
 * Playwright deprecated page.waitForTimeout() in favour of locator-based
 * waits. For unconditional pauses (e.g. UI animations settling), use
 * this standalone sleep instead.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
module.exports = { sleep };
