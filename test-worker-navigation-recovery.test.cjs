'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { navigateWorkerEntry } = require('./worker-navigation-recovery');
const entry = 'https://app.example.test/';
const timeout = () => Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' });
function fake({ url = entry, gotoError, loadError, afterLoad, response = { ok: true }, emit = true, status = 200, main = true, commit = true, requestFail = false, duringWait } = {}) {
  let current = url; const listeners = new Map(), calls = [];
  const frame = {url:()=>current};
  const request = {url:()=>current,isNavigationRequest:()=>true,frame:()=>main ? frame : {}};
  const fire = (event, value) => listeners.get(event)?.(value);
  return { calls, listeners, request, fire, frame, url: () => current, mainFrame: () => frame,
    on: (event, fn) => { assert.ok(!listeners.has(event)); listeners.set(event, fn); },
    removeListener: (event, fn) => { assert.equal(listeners.get(event), fn); listeners.delete(event); },
    goto: async (...args) => {
      calls.push(['goto', ...args]);
      if (emit) { fire('request', request); fire('response', {url:()=>current,status:()=>status,request:()=>request}); if (commit) fire('framenavigated',main ? frame : {}); if (requestFail) fire('requestfailed',request); }
      if (gotoError) throw gotoError; return response;
    },
    waitForLoadState: async (...args) => { calls.push(['wait', ...args]); if (afterLoad) current = afterLoad; if (duringWait) duringWait({fire,request,frame}); if (loadError) throw loadError; }
  };
}
const noListeners = p => assert.equal(p.listeners.size, 0);
test('normal goto passes through result and does not add a wait', async () => {
  const p = fake(); let recovered = 0;
  assert.deepEqual(await navigateWorkerEntry(p, entry, () => recovered++), {ok:true});
  assert.deepEqual(p.calls, [['goto', entry, {waitUntil:'domcontentloaded',timeout:60000}]]); assert.equal(recovered,0); noListeners(p);
});
test('late same-entry DOMContentLoaded resumes without another navigation', async () => {
  const p = fake({gotoError:timeout()}); let recovered=0;
  assert.equal(await navigateWorkerEntry(p,entry,()=>recovered++),null);
  assert.deepEqual(p.calls,[['goto',entry,{waitUntil:'domcontentloaded',timeout:60000}],['wait','domcontentloaded',{timeout:15000}]]); assert.equal(recovered,1); noListeners(p);
});
test('Playwright-style TimeoutError class with name Error recovers after late load', async () => {
  class TimeoutError extends Error {}
  const e = new TimeoutError('page.goto: Timeout 60000ms exceeded.');
  assert.equal(e.name, 'Error');
  const p=fake({gotoError:e}); assert.equal(await navigateWorkerEntry(p,entry),null); assert.equal(p.calls.length,2); noListeners(p);
});
test('ordinary Error with timeout-looking message is not recovered', async () => {
  const e=new Error('page.goto: Timeout 60000ms exceeded.'),p=fake({gotoError:e});
  await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e); assert.equal(p.calls.length,1); noListeners(p);
});
test('timeout class with non-navigation message is not recovered', async () => {
  class TimeoutError extends Error {}
  const e=new TimeoutError('different operation timed out'),p=fake({gotoError:e});
  await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e); assert.equal(p.calls.length,1); noListeners(p);
});
test('permanent timeout rethrows original after exactly one wait', async () => {
 const e=timeout(),p=fake({gotoError:e,loadError:timeout()}); await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e); assert.equal(p.calls.length,2); noListeners(p);
});
for (const message of ['synthetic connection failure','page.goto: net::ERR_CONNECTION_RESET','page.goto: net::ERR_TIMED_OUT','page.goto: net::ERR_CERT_AUTHORITY_INVALID','page.goto: net::ERR_PROXY_CONNECTION_FAILED']) {
 test(`non-timeout error propagates without retry: ${message}`, async () => {const e=new Error(message),p=fake({gotoError:e});await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e);assert.equal(p.calls.length,1);noListeners(p);});
}
for (const url of ['about:blank','https://login.microsoftonline.com/example','https://evil.test/?next=https://app.example.test/', 'https://app.example.test/signin','https://app.example.test.evil.test/','chrome-error://chromewebdata/']) {
 test(`timeout off entry is not retried: ${url}`, async () => { const e=timeout(),p=fake({url,gotoError:e}); await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e); assert.equal(p.calls.length,1); noListeners(p); });
}
for (const opts of [{emit:false},{status:500},{status:302},{main:false},{commit:false},{requestFail:true}]) {
 test(`unproven, uncommitted or failed navigation is not recovered: ${JSON.stringify(opts)}`,async()=>{const e=timeout(),p=fake({...opts,gotoError:e});await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e);assert.equal(p.calls.length,1);noListeners(p);});
}
test('a request failing during the readiness wait preserves the timeout',async()=>{const e=timeout(),p=fake({gotoError:e,duringWait:({fire,request})=>fire('requestfailed',request)});await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e);assert.equal(p.calls.length,2);noListeners(p);});
test('a competing same-entry navigation during the wait invalidates recovery',async()=>{const e=timeout(),p=fake({gotoError:e,duringWait:({fire,frame})=>fire('request',{url:()=>entry,isNavigationRequest:()=>true,frame:()=>frame})});await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e);assert.equal(p.calls.length,2);noListeners(p);});
test('redirect or second main-frame commit during wait invalidates recovery',async()=>{const e=timeout(),p=fake({gotoError:e,duringWait:({fire,frame})=>fire('framenavigated',frame)});await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e);noListeners(p);});
test('redirect during wait does not count as recovery',async()=>{const e=timeout(),p=fake({gotoError:e,afterLoad:'https://login.microsoftonline.com/login'});let n=0;await assert.rejects(navigateWorkerEntry(p,entry,()=>n++),x=>x===e);assert.equal(n,0);assert.equal(p.calls.length,2);noListeners(p);});
test('load-state errors retain original failure',async()=>{const e=timeout(),p=fake({gotoError:e,loadError:new Error('closed')});await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e);assert.equal(p.calls.length,2);noListeners(p);});
test('trailing-slash normalized and port respected',async()=>{const p=fake({url:'https://app.example.test/path/',gotoError:timeout()});await navigateWorkerEntry(p,'https://app.example.test/path');const q=fake({url:'https://app.example.test:444/path',gotoError:timeout()});await assert.rejects(navigateWorkerEntry(q,'https://app.example.test/path'));assert.equal(q.calls.length,1);noListeners(q);});
test('invalid app URL preserves original goto behavior',async()=>{const e=new Error('bad url'),p=fake({gotoError:e});await assert.rejects(navigateWorkerEntry(p,'not a url'),x=>x===e);assert.equal(p.calls.length,1);noListeners(p);});
test('two workers recover independently without repeated goto',async()=>{const a=fake({gotoError:timeout()}), b=fake({gotoError:timeout(),loadError:timeout()});const r=await Promise.allSettled([navigateWorkerEntry(a,entry),navigateWorkerEntry(b,entry)]);assert.equal(r[0].status,'fulfilled');assert.equal(r[1].status,'rejected');assert.equal(a.calls.length,2);assert.equal(b.calls.length,2);noListeners(a);noListeners(b);});
// Execute the actual coordinator login method with synthetic pages/dependencies.
function coordinator(deps) {
 const src=fs.readFileSync(__dirname+'/parallel-coordinator.ts','utf8');
 const begin=src.indexOf('  private async _ensureLoggedIn('), end=src.indexOf('\n  /**',begin);
 assert.ok(begin>=0&&end>begin);
 const body=src.slice(begin,end).replace('private async _ensureLoggedIn(worker: WorkerState, id: number): Promise<boolean>','async _ensureLoggedIn(worker, id)').replace('catch (err: any)','catch (err)');
 const make=new Function('_deps','getCONFIG','getLog','navigateWorkerEntry',`return class { async _sleep() {} ${body} }`);
 return new (make(deps,()=>({APP_URL:entry}),()=>()=>{},navigateWorkerEntry))();
}
test('coordinator integration resumes existing login check after late load',async()=>{const p=fake({gotoError:timeout()});assert.equal(await coordinator({})._ensureLoggedIn({page:p},0),true);assert.equal(p.calls.length,2);noListeners(p);});
test('coordinator integration returns false on unrecovered timeout',async()=>{const p=fake({gotoError:timeout(),loadError:timeout()});assert.equal(await coordinator({})._ensureLoggedIn({page:p},0),false);assert.equal(p.calls.length,2);noListeners(p);});
test('coordinator integration returns false on connection reset',async()=>{const p=fake({gotoError:new Error('page.goto: net::ERR_CONNECTION_RESET')});assert.equal(await coordinator({})._ensureLoggedIn({page:p},0),false);assert.equal(p.calls.length,1);noListeners(p);});
