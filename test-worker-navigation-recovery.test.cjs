'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { navigateWorkerEntry } = require('./worker-navigation-recovery');
const entry = 'https://app.example.test/';
const timeout = () => Object.assign(new Error('synthetic timeout'), { name: 'TimeoutError' });
function fake({ url = entry, gotoError, loadError, afterLoad, response = { ok: true }, emit = true, status = 200, main = true } = {}) {
  let current = url, listener; const calls = [], frame = {};
  return { calls, url: () => current, mainFrame: () => frame,
    on: (_event, fn) => { listener = fn; },
    removeListener: (_event, fn) => { assert.equal(listener, fn); listener = null; },
    goto: async (...args) => { calls.push(['goto', ...args]); if (emit && listener) listener({url:()=>current,status:()=>status,request:()=>({isNavigationRequest:()=>true,frame:()=>main ? frame : {}})}); if (gotoError) throw gotoError; return response; },
    waitForLoadState: async (...args) => { calls.push(['wait', ...args]); if (afterLoad) current = afterLoad; if (loadError) throw loadError; }
  };
}
test('normal goto passes through result and does not add a wait', async () => {
  const p = fake(); let recovered = 0;
  assert.deepEqual(await navigateWorkerEntry(p, entry, () => recovered++), {ok:true});
  assert.deepEqual(p.calls, [['goto', entry, {waitUntil:'domcontentloaded',timeout:60000}]]); assert.equal(recovered,0);
});
test('late same-entry DOMContentLoaded resumes without another navigation', async () => {
  const p = fake({gotoError:timeout()}); let recovered=0;
  assert.equal(await navigateWorkerEntry(p,entry,()=>recovered++),null);
  assert.deepEqual(p.calls,[['goto',entry,{waitUntil:'domcontentloaded',timeout:60000}],['wait','domcontentloaded',{timeout:15000}]]); assert.equal(recovered,1);
});
test('permanent timeout rethrows original after exactly one wait', async () => {
 const e=timeout(),p=fake({gotoError:e,loadError:timeout()}); await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e); assert.equal(p.calls.length,2);
});
test('non-timeout failure propagates without retry', async () => {
 const e=new Error('synthetic connection failure'),p=fake({gotoError:e}); await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e); assert.equal(p.calls.length,1);
});
for (const url of ['about:blank','https://login.microsoftonline.com/example','https://evil.test/?next=https://app.example.test/', 'https://app.example.test/signin','https://app.example.test.evil.test/','chrome-error://chromewebdata/']) {
 test(`timeout off entry is not retried: ${url}`, async () => { const e=timeout(),p=fake({url,gotoError:e}); await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e); assert.equal(p.calls.length,1); });
}
for (const opts of [{emit:false},{status:500},{status:302},{main:false}]) {
 test(`unproven or unsuccessful navigation response is not recovered: ${JSON.stringify(opts)}`,async()=>{const e=timeout(),p=fake({...opts,gotoError:e});await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e);assert.equal(p.calls.length,1);});
}
test('redirect during wait does not count as recovery',async()=>{const e=timeout(),p=fake({gotoError:e,afterLoad:'https://login.microsoftonline.com/login'});let n=0;await assert.rejects(navigateWorkerEntry(p,entry,()=>n++),x=>x===e);assert.equal(n,0);assert.equal(p.calls.length,2);});
test('load-state errors retain original failure',async()=>{const e=timeout(),p=fake({gotoError:e,loadError:new Error('closed')});await assert.rejects(navigateWorkerEntry(p,entry),x=>x===e);assert.equal(p.calls.length,2);});
test('trailing-slash normalized and port respected',async()=>{const p=fake({url:'https://app.example.test/path/',gotoError:timeout()});await navigateWorkerEntry(p,'https://app.example.test/path');const q=fake({url:'https://app.example.test:444/path',gotoError:timeout()});await assert.rejects(navigateWorkerEntry(q,'https://app.example.test/path'));assert.equal(q.calls.length,1);});
test('invalid app URL preserves original goto behavior',async()=>{const e=new Error('bad url'),p=fake({gotoError:e});await assert.rejects(navigateWorkerEntry(p,'not a url'),x=>x===e);assert.equal(p.calls.length,1);});
test('two workers recover independently without repeated goto',async()=>{const a=fake({gotoError:timeout()}), b=fake({gotoError:timeout(),loadError:timeout()});const r=await Promise.allSettled([navigateWorkerEntry(a,entry),navigateWorkerEntry(b,entry)]);assert.equal(r[0].status,'fulfilled');assert.equal(r[1].status,'rejected');assert.equal(a.calls.length,2);assert.equal(b.calls.length,2);});
// Execute the actual coordinator login method with synthetic pages/dependencies.
function coordinator(deps) {
 const src=fs.readFileSync(__dirname+'/parallel-coordinator.ts','utf8');
 const begin=src.indexOf('  private async _ensureLoggedIn('), end=src.indexOf('\n  /**',begin);
 assert.ok(begin>=0&&end>begin);
 const body=src.slice(begin,end).replace('private async _ensureLoggedIn(worker: WorkerState, id: number): Promise<boolean>','async _ensureLoggedIn(worker, id)').replace('catch (err: any)','catch (err)');
 const make=new Function('_deps','getCONFIG','getLog','navigateWorkerEntry',`return class { async _sleep() {} ${body} }`);
 return new (make(deps,()=>({APP_URL:entry}),()=>()=>{},navigateWorkerEntry))();
}
test('coordinator integration resumes existing login check after late load',async()=>{const p=fake({gotoError:timeout()});assert.equal(await coordinator({})._ensureLoggedIn({page:p},0),true);assert.equal(p.calls.length,2);});
test('coordinator integration returns false on unrecovered timeout',async()=>{const p=fake({gotoError:timeout(),loadError:timeout()});assert.equal(await coordinator({})._ensureLoggedIn({page:p},0),false);assert.equal(p.calls.length,2);});
