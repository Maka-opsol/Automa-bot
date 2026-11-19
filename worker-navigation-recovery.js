'use strict';

// A timed-out entry navigation may still finish loading in the same document.
// Never re-navigate: allow one bounded readiness wait only after observing a
// single main-frame entry request, its successful response, and its commit.
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
  let entryRequest = null;
  let entryResponse = false;
  let entryCommitted = false;
  let invalidated = false;
  const observeRequest = (request) => {
    try {
      if (!request.isNavigationRequest() || request.frame() !== page.mainFrame()) return;
      // Redirects, competing navigations and repeated entry requests are ambiguous.
      if (entryRequest || !isEntryUrl(request.url())) invalidated = true;
      else entryRequest = request;
    } catch { invalidated = true; }
  };
  const observeResponse = (response) => {
    try {
      if (response.request() === entryRequest && entryRequest &&
          isEntryUrl(response.url()) && response.status() >= 200 && response.status() < 300) {
        entryResponse = true;
      }
    } catch { invalidated = true; }
  };
  const observeFailure = (request) => {
    if (request === entryRequest) invalidated = true;
  };
  const observeCommit = (frame) => {
    try {
      if (frame !== page.mainFrame()) return;
      if (!entryRequest || !isEntryUrl(frame.url()) || entryCommitted) invalidated = true;
      else entryCommitted = true;
    } catch { invalidated = true; }
  };
  page.on('request', observeRequest);
  page.on('response', observeResponse);
  page.on('requestfailed', observeFailure);
  page.on('framenavigated', observeCommit);
  const canRecover = () => !invalidated && entryRequest && entryResponse && entryCommitted && isEntryUrl(page.url());
  try {
    try {
      return await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (error) {
      // Playwright 1.40 TimeoutError inherits Error.name === 'Error'. Require
      // its timeout class name AND the navigation-timeout message in that case;
      // never classify arbitrary network, certificate or proxy errors as late loads.
      const isNavigationTimeout = error?.name === 'TimeoutError' ||
        (error?.constructor?.name === 'TimeoutError' &&
         /^page\.goto: Timeout \d+ms exceeded\./.test(error?.message || ''));
      if (!isNavigationTimeout || !canRecover()) throw error;
      try {
        await page.waitForLoadState('domcontentloaded', { timeout: 15000 });
      } catch {
        throw error;
      }
      if (!canRecover()) throw error;
      onLateLoad();
      return null; // No Response object is available to the caller after a timed-out goto.
    }
  } finally {
    page.removeListener('request', observeRequest);
    page.removeListener('response', observeResponse);
    page.removeListener('requestfailed', observeFailure);
    page.removeListener('framenavigated', observeCommit);
  }
}

module.exports = { navigateWorkerEntry };
