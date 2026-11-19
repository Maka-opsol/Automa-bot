'use strict';

// A timed-out entry navigation may still finish loading in the same document.
// Never re-navigate: require a successful main-frame response from THIS goto,
// then wait once for DOMContentLoaded while remaining on the configured entry.
// This establishes document readiness, not authentication.
async function navigateWorkerEntry(page, appUrl, onLateLoad = () => {}) {
  let expected;
  try {
    expected = new URL(appUrl);
    if (!['http:', 'https:'].includes(expected.protocol)) throw new Error('invalid app URL');
  } catch {
    return page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
  }
  const isEntryUrl = (url) => {
    try {
      const current = new URL(url);
      const path = (s) => s.replace(/\/+$/, '') || '/';
      return current.origin === expected.origin && path(current.pathname) === path(expected.pathname);
    } catch { return false; }
  };
  let entryResponse = false;
  const observeResponse = (response) => {
    try {
      const request = response.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() &&
          isEntryUrl(response.url()) && response.status() >= 200 && response.status() < 300) {
        entryResponse = true;
      }
    } catch { /* unclassifiable responses cannot enable recovery */ }
  };
  page.on('response', observeResponse);
  try {
    try {
      return await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (error) {
      if (error?.name !== 'TimeoutError' || !entryResponse || !isEntryUrl(page.url())) throw error;
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      } catch {
        throw error;
      }
      if (!isEntryUrl(page.url())) throw error;
      onLateLoad();
      return null; // No Response object is available to the caller after a timed-out goto.
    }
  } finally {
    page.removeListener('response', observeResponse);
  }
}

module.exports = { navigateWorkerEntry };
