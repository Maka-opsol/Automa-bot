'use strict';
// Offline, synthetic Playwright fixtures only: every request is intercepted.
// Requires playwright-core and an installed Chromium (set CHROMIUM_PATH if needed).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { navigateWorkerEntry } = require('./worker-navigation-recovery');
const target = 'http://fixture.invalid/';

async function withPage(handler, run) {
  const browser = await chromium.launch({executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args:['--no-sandbox','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});
  try {
    const context = await browser.newContext({serviceWorkers:'block'});
    await context.route('**/*', handler);
    const page = await context.newPage();
    return await run(page);
  } finally { await browser.close(); }
}
// Shorten only fixture timeouts; production still uses 60s and 15s.
function fixturePage(page) {
  return {
    on: page.on.bind(page), removeListener: page.removeListener.bind(page),
    mainFrame: page.mainFrame.bind(page), url: page.url.bind(page),
    goto: (url, opts) => page.goto(url, {...opts, timeout:200}),
    waitForLoadState: (state, opts) => page.waitForLoadState(state, {...opts, timeout:2000}),
  };
}
test('real Playwright late DOMContentLoaded: same committed document resumes without re-navigation', async () => {
  let documentRequests=0;
  await withPage(async route => {
    const url=route.request().url();
    if (url===target) { documentRequests++; await route.fulfill({status:200,contentType:'text/html',body:'<!doctype html><script src="/slow.js"></script><p>fixture</p>'}); }
    else if (url===target+'slow.js') { await new Promise(resolve=>setTimeout(resolve,700)); await route.fulfill({status:200,contentType:'application/javascript',body:'void 0'}); }
    else await route.abort();
  }, async page => {
    let recovered=0;
    assert.equal(await navigateWorkerEntry(fixturePage(page),target,()=>recovered++),null);
    assert.equal(recovered,1); assert.equal(documentRequests,1); assert.equal(page.url(),target);
  });
});
test('real Playwright reset propagates without extra navigation', async () => {
  let requests=0;
  await withPage(async route => { requests++; await route.abort('connectionreset'); }, async page => {
    let recovered=0;
    await assert.rejects(navigateWorkerEntry(fixturePage(page),target,()=>recovered++),/ERR_CONNECTION_RESET/);
    assert.equal(recovered,0); assert.equal(requests,1);
  });
});
