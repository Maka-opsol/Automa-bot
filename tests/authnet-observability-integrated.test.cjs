'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const esbuild = require(process.env.ESBUILD_PATH || 'esbuild');
const dir = path.resolve(__dirname, '..');
const { attachAuthNetDiagnostics, location, errorCode } = require('../authnet-diagnostics');
function coordinator() {
  const filename = path.join(dir, 'parallel-coordinator.ts');
  const code = esbuild.transformSync(fs.readFileSync(filename, 'utf8'), { loader:'ts', format:'cjs', target:'node20' }).code;
  const m = new Module(filename, module); m.filename=filename; m.paths=module.paths; m._compile(code,filename); return m.exports;
}
class Page extends EventEmitter {
  constructor() { super(); this.current='about:blank'; this.frame={url:()=>this.current}; this.go=[]; this.mode='success'; this.final='https://app.test/'; }
  mainFrame() { return this.frame; } url() { return this.current; }
  request(url, previous=null) { return {url:()=>url, frame:()=>this.frame, isNavigationRequest:()=>true, redirectedFrom:()=>previous, failure:()=>({errorText:'net::ERR_CONNECTION_RESET'})}; }
  async goto(url, options) {
    this.go.push({url,options}); const req=this.request(url); this.emit('request',req);
    if (this.mode === 'reset') { this.emit('requestfailed',req); throw Error('page.goto: net::ERR_CONNECTION_RESET at https://secret.test/?code=SYNTHETIC_SECRET'); }
    this.emit('response',{request:()=>req,url:()=>url,status:()=>this.mode==='redirect'?302:200});
    if (this.mode==='redirect') { const next=this.request(this.final,req); this.emit('request',next); this.emit('response',{request:()=>next,url:()=>this.final,status:()=>200}); }
    this.current=this.final; this.emit('framenavigated',this.frame);
    if (this.mode==='timeout' || this.mode==='late_fail') { const e=Error('page.goto: Timeout 60000ms exceeded. https://secret.test/SYNTHETIC_SECRET'); e.name='TimeoutError'; throw e; }
    return {ok:true};
  }
  async waitForLoadState() { if(this.mode==='late_fail') throw Error('timeout with SYNTHETIC_SECRET'); }
  setDefaultTimeout() {} setDefaultNavigationTimeout() {}
}
function fixture({url='https://app.test/',mode='success',guard,auth,proxy=false}={}) {
  const mod=coordinator(), logs=[], page=new Page(); page.final=url;page.mode=mode;
  const log=(message)=>{logs.push(message); return true;};
  const c=new mod.ParallelCoordinator(); mod._injectDependencies({config:{APP_URL:'https://app.test'},logger:{log},authGuard:guard,auth});
  const diag=attachAuthNetDiagnostics(page,3,'https://app.test',proxy,log);
  const worker={id:3,page,authNetDiag:diag,status:'idle',currentModule:null,errors:0}; c._sleep=async()=>{};
  return {mod,c,page,worker,logs,events:()=>logs.filter(x=>x.startsWith('[authnet-diag] ')).map(x=>JSON.parse(x.slice(15)))};
}
const end=f=>f.events().filter(x=>x.event==='end').at(-1);
test('real login path shows false-positive Microsoft redirect and correlates response sequence',async()=>{
  let guardCalls=0; const f=fixture({url:'https://login.microsoftonline.com/common/oauth2/authorize?code=SYNTHETIC_SECRET',mode:'redirect',guard:{ensureAuthenticated:async()=>{guardCalls++;}}});
  assert.equal(await f.c._ensureLoggedIn(f.worker,3),true);assert.equal(guardCalls,0);
  const e=f.events();assert.equal(end(f).host,'microsoft_login');assert.equal(end(f).outcome,'legacy_true_other_unverified');
  assert.ok(e.some(x=>x.event==='response'&&x.status==='3xx'));assert.ok(e.some(x=>x.event==='response'&&x.host==='microsoft_login'&&x.redirected==='yes'&&x.route==='authorize'));
  assert.ok(e.every(x=>x.worker===3&&x.attempt===1&&x.elapsed_ms>=0&&x.elapsed_ms<=300000));
  assert.equal(JSON.stringify(e).includes('SYNTHETIC_SECRET'),false);
});
test('guard handoff returns same value and is explicitly unverified',async()=>{
 let calls=0;const f=fixture({url:'https://login.live.com/?next=/assignments&code=SYNTHETIC_SECRET',guard:{ensureAuthenticated:async p=>{calls++;return p;}}});
 assert.equal(await f.c._ensureLoggedIn(f.worker,3),true);assert.equal(calls,1);assert.equal(end(f).outcome,'guard_returned_nonfalse_unverified');assert.equal(end(f).phase,'guard_handoff');
});
test('guard false and fallback auth results preserve existing behavior',async()=>{
 const a=fixture({url:'https://login.live.com/?next=/assignments',guard:{ensureAuthenticated:async()=>false}});
 assert.equal(await a.c._ensureLoggedIn(a.worker,3),false);assert.equal(end(a).outcome,'guard_returned_false');
 const b=fixture({url:'https://login.live.com/?next=/assignments',auth:{authenticate:async()=>false}});
 assert.equal(await b.c._ensureLoggedIn(b.worker,3),true);assert.equal(end(b).outcome,'auth_returned_unverified');
});
test('entry reset records fixed code and phase without diagnostic secret',async()=>{
 const f=fixture({mode:'reset'});assert.equal(await f.c._ensureLoggedIn(f.worker,3),false);
 assert.ok(f.events().some(x=>x.event==='request_failed'&&x.error_code==='ERR_CONNECTION_RESET'));
 assert.equal(end(f).phase,'entry_domcontentloaded');assert.equal(end(f).error_code,'ERR_CONNECTION_RESET');
 assert.equal(JSON.stringify(f.events()).includes('SYNTHETIC_SECRET'),false);
 // The covered legacy error log must also exclude the synthetic secret.
 assert.ok(f.logs.every(x=>!x.includes('SYNTHETIC_SECRET')));
});
test('original late-load timeout recovery remains successful and records phase',async()=>{
 const f=fixture({mode:'timeout'});assert.equal(await f.c._ensureLoggedIn(f.worker,3),true);
 assert.ok(f.events().some(x=>x.phase==='entry_late_load_wait'));assert.equal(end(f).outcome,'legacy_true_app_unverified');
 assert.equal(f.page.go.length,1);assert.equal(f.page.listenerCount('request'),1);
});
test('late load wait failure rethrows original timeout and records wait phase',async()=>{
 const f=fixture({mode:'late_fail'});assert.equal(await f.c._ensureLoggedIn(f.worker,3),false);
 assert.equal(end(f).phase,'entry_late_load_wait');assert.equal(end(f).error_code,'TIMEOUT');assert.equal(f.page.go.length,1);
});
test('assignments navigation logs failed load and preserves thrown error',async()=>{
 const f=fixture({mode:'reset'});await assert.rejects(f.c._navigateAssignments(f.worker,false),/ERR_CONNECTION_RESET/);
 assert.equal(end(f).phase,'assignments_load');assert.equal(end(f).outcome,'failed');assert.equal(end(f).error_code,'ERR_CONNECTION_RESET');assert.equal(f.page.go[0].options.waitUntil,'load');
});
test('return navigation preserves return and uses independent attempt',async()=>{
 const f=fixture();assert.equal(await f.c._ensureLoggedIn(f.worker,3),true);assert.deepEqual(await f.c._navigateAssignments(f.worker,true),{ok:true});
 assert.equal(end(f).phase,'assignments_return_load');assert.equal(end(f).attempt,2);assert.equal(end(f).outcome,'completed');
});
test('parsed origins reject deceptive host, foreign query, wrong scheme/port and malformed values',()=>{
 const app='https://app.test:444';for(const [u,host] of [['https://app.test:444/assignments?q=x','app_origin'],['https://app.test:443/','external'],['http://app.test:444','external'],['https://app.test.evil/','external'],['https://app.test@evil.test/','external'],['https://evil.test/?x=https://app.test:444','external'],['chrome-error://chromewebdata/','browser_error'],['https://login.microsoftonline.com.evil/','external'],['nonsense','unknown']])assert.equal(location(u,app).host,host);
});
test('all outputs are allowlisted and never contain synthetic secret, URL or page contents',()=>{
 const logs=[],p=new Page(); const d=attachAuthNetDiagnostics(p,9,'https://app.test/?token=TOKEN_SENTINEL',true,m=>logs.push(m));
 d.begin('SYNTHETIC_SECRET');d.step('https://secret.test/SYNTHETIC_SECRET');p.current='https://password:EMAIL_SENTINEL@app.test/assignments/SYNTHETIC_SECRET?code=TOKEN_SENTINEL';
 const r=p.request(p.current);p.emit('request',r);p.emit('response',{request:()=>r,url:()=>p.current,status:()=>401});p.emit('requestfailed',r);d.finish('SYNTHETIC_SECRET',Error('https://secret.test/SYNTHETIC_SECRET'));
 const out=logs.join('\n');for(const forbidden of ['SYNTHETIC_SECRET','TOKEN_SENTINEL','EMAIL_SENTINEL','https://','password','/assignments']) assert.equal(out.includes(forbidden),false,forbidden);
 assert.ok(out.includes('proxy_disabled_flag'));assert.ok(out.includes('"status":"401"'));
});
test('network failures and timeouts use fixed error code allowlist',()=>{
 assert.equal(errorCode(Error('net::ERR_CONNECTION_RESET at https://secret.test')), 'ERR_CONNECTION_RESET');
 assert.equal(errorCode(Error('ERR_MADE_UP_TOKEN_SENTINEL')), 'OTHER');const e=Error('private');e.name='TimeoutError';assert.equal(errorCode(e),'TIMEOUT');
});
test('deduplication and hard per-worker rate limit bound telemetry',()=>{
 const logs=[],p=new Page(),d=attachAuthNetDiagnostics(p,1,'https://app.test',false,m=>logs.push(m));d.begin('login_check');
 const r=p.request('https://app.test');for(let i=0;i<1000;i++)p.emit('response',{request:()=>r,url:()=>r.url(),status:()=>i%2?200:403});
 assert.ok(logs.length<=60);assert.ok(logs.length<=4);
 for(let i=0;i<100;i++) { d.finish('completed'); d.begin('login_check'); }assert.ok(logs.length<=60);
});
test('logger failures and malformed events cannot affect navigation',async()=>{
 const p=new Page(),d=attachAuthNetDiagnostics(p,1,'https://app.test',false,()=>{throw Error('logger failure')});
 d.begin('login_check');p.emit('request',{});p.emit('response',{});p.emit('requestfailed',{});d.step('entry_domcontentloaded');assert.deepEqual(await p.goto('https://app.test',{}),{ok:true});d.finish('completed');
});
test('worker loop reaches real assignments error path with diagnostic correlation',async()=>{
 const f=fixture();const goto=f.page.goto.bind(f.page);f.page.goto=async(url,opts)=>{if(url.endsWith('/assignments'))f.page.mode='reset';return goto(url,opts);};
 f.c.workers.set(3,f.worker);f.c.running=true;f.c._sleep=async ms=>{if(ms===10000)f.c.running=false;};
 await f.c._runWorkerLoop(3);assert.equal(f.worker.errors,1);assert.equal(f.worker.status,'error');
 assert.ok(f.events().some(e=>e.event==='end'&&e.phase==='assignments_load'&&e.error_code==='ERR_CONNECTION_RESET'));
 assert.equal(f.page.go.length,2);
});
test('response status categories and subframe exclusion',()=>{
 const logs=[],p=new Page(),d=attachAuthNetDiagnostics(p,1,'https://app.test',false,m=>logs.push(JSON.parse(m.slice(15))));d.begin('login_check');
 const req=p.request('https://app.test/');for(const [status,expected] of [[201,'2xx'],[302,'3xx'],[401,'401'],[403,'403'],[429,'429'],[418,'other_4xx'],[503,'5xx']]){p.emit('response',{request:()=>req,url:()=>req.url(),status:()=>status});assert.ok(logs.some(x=>x.status===expected));}
 const before=logs.length;const sub={...req,frame:()=>({})};p.emit('request',sub);p.emit('requestfailed',sub);assert.equal(logs.length,before);
});
test('unrecoverable timeout stays in entry phase and causes no extra goto',async()=>{
 const f=fixture({url:'https://login.live.com/',mode:'timeout'});assert.equal(await f.c._ensureLoggedIn(f.worker,3),false);assert.equal(end(f).phase,'entry_domcontentloaded');assert.equal(end(f).error_code,'TIMEOUT');assert.equal(f.page.go.length,1);
});
test('worker creation is opt-in with opt-out and captures disabled flag snapshot',async()=>{
 const prev=process.env.MATHU_AUTHNET_DIAGNOSTICS; const old=globalThis.__proxyDisabled;
 try { for(const enabled of [false,true]) {if(enabled)process.env.MATHU_AUTHNET_DIAGNOSTICS='1';else process.env.MATHU_AUTHNET_DIAGNOSTICS='0';globalThis.__proxyDisabled=true;
 const mod=coordinator(),logs=[],p=new Page();mod._injectDependencies({config:{APP_URL:'https://app.test'},logger:{log:m=>logs.push(m)}});const c=new mod.ParallelCoordinator();c.browser={newContext:async()=>({newPage:async()=>p})};await c._createWorker(5);const w=c.workers.get(5);assert.equal(!!w.authNetDiag,enabled);if(enabled){w.authNetDiag.begin('login_check');assert.ok(logs.some(m=>m.includes('"proxy_disabled_flag":"true"')));}
 }} finally {if(prev===undefined)delete process.env.MATHU_AUTHNET_DIAGNOSTICS;else process.env.MATHU_AUTHNET_DIAGNOSTICS=prev;if(old===undefined)delete globalThis.__proxyDisabled;else globalThis.__proxyDisabled=old;}
});
