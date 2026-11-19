'use strict';
// Offline synthetic Chromium and mocked hostile-event tests. No real app, credentials or interactions.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const esbuild = require(process.env.ESBUILD_PATH || 'esbuild');
const {chromium} = require(process.env.PLAYWRIGHT_CORE_PATH || 'playwright-core');
const root = path.resolve(__dirname, '..');
function load(name, extras={}) {
  const src=fs.readFileSync(path.join(root,name),'utf8');
  const js=esbuild.transformSync(src,{loader:'ts',format:'cjs',target:'node20'}).code;
  const ctx={module:{exports:{}},exports:{},URL,console,Buffer,setTimeout,setInterval,process,...extras};
  vm.runInNewContext(js,ctx,{filename:name}); return ctx.module.exports;
}
const signals=load('render-observability.ts');
const legacy=load('render-diagnostics.ts');
const secret='SENSITIVE_TOKEN_USERNAME_QUESTION_PATH_QUERY';
function noSecrets(logs) {
  const text=JSON.stringify(logs);
  for(const item of [secret,'127.0.0.1','http://','https://','?token=', '/private']) assert.ok(!text.includes(item), `leaked ${item}`);
}
function startServer(handler) { return new Promise(resolve=>{ const s=http.createServer(handler);s.listen(0,'127.0.0.1',()=>resolve(s)); }); }
const close=s=>new Promise(resolve=>s.close(resolve));
const flush=()=>new Promise(resolve=>setTimeout(resolve,50));

test('real offline Chromium: CSP, failed script, iframe, shadow, canvas and card counts', async()=>{
  let externalPort;
  const external=await startServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.end('<!doctype html><div class="card">foreign secret</div>')});
  externalPort=external.address().port;
  const app=await startServer((req,res)=>{
    if(req.url.startsWith('/pdf.js')) {res.writeHead(404);return res.end('missing');}
    if(req.url==='/inside') return res.end('<!doctype html><div class="card">inner</div><canvas width="4" height="4"></canvas>');
    if(req.url.startsWith('/csp')) {res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; report-uri /private/"+secret);return res.end(`<script src="http://127.0.0.1:${externalPort}/blocked.js?token=${secret}"></script>`);}
    res.end(`<!doctype html><div class="card">${secret}</div><div role="listitem">question ${secret}</div><canvas width="0" height="1"></canvas><div id="host"></div><iframe src="/inside"></iframe><iframe src="http://127.0.0.1:${externalPort}/foreign?token=${secret}"></iframe><script src="/pdf.js?token=${secret}"></script><script>const r=document.querySelector('#host').attachShadow({mode:'open'});r.innerHTML='<div class="card">${secret}</div><canvas width="8" height="8"></canvas>';</script>`);
  });
  const base=`http://127.0.0.1:${app.address().port}`;
  let browser;
  try {
    browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext();
    await context.route('**/*',route=>{const u=new URL(route.request().url()); return u.hostname==='127.0.0.1'?route.continue():route.abort();});
    const page=await context.newPage(), logs=[];
    legacy.attachRenderDiagnostics(page,1,s=>logs.push(s));
    const sig=signals.attachRenderSignals(page,1,s=>logs.push(s),base+'/private?token='+secret);
    await page.goto(base+'/private?token='+secret,{waitUntil:'load'});
    sig.sample('render'); await flush();
    const snap=logs.find(x=>x.includes('checkpoint=render'));
    assert.ok(snap,snap); assert.match(snap,/result=ok ready=complete/);
    for(const part of ['frame=2','frameReadable=1','frameUnreadable=1','frameComplete=1','canvas=3','canvasNonzero=2','shadowOpen=1','cardsTop=2','cardsShadow=1','cardsFrame=1','nodesCapped=0']) assert.ok(snap.includes(part),part+' '+snap);
    assert.ok(logs.some(x=>x.includes('kind=pdf-script')&&x.includes('status=4xx')));
    await page.goto(base+'/csp?token='+secret,{waitUntil:'load'}); await flush();
    assert.ok(logs.some(x=>x.includes('csp enforced=present,script-src=1,script-src-elem=0,default-src=1')),JSON.stringify(logs));
    assert.ok(logs.some(x=>x.includes('csp-violation hint=console kind=script')),JSON.stringify(logs));
    // Browsers may surface CSP as a generic request failure; policy presence alone is not proof of the cause.
    noSecrets(logs);
    await context.close();
  } finally {if(browser) await browser.close(); await close(app); await close(external);}
});

test('real offline Chromium: app, foreign and unknown error attribution; no error text', async()=>{
  const foreign=await startServer((req,res)=>{res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Content-Type','application/javascript');res.end(`throw new Error('${secret}');`)});
  const app=await startServer((req,res)=>{
    if(req.url.startsWith('/app.js')) {res.setHeader('Content-Type','application/javascript');return res.end('throw new ReferenceError("pdfjsLib is not defined");');}
    res.end(`<script src="/app.js?token=${secret}"></script><script crossorigin="anonymous" src="http://127.0.0.1:${foreign.address().port}/foreign.js?token=${secret}"></script>`);
  });
  const base=`http://127.0.0.1:${app.address().port}`; let browser;
  try {
    browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const context=await browser.newContext(); await context.route('**/*',route=>new URL(route.request().url()).hostname==='127.0.0.1'?route.continue():route.abort());
    const page=await context.newPage(), logs=[]; signals.attachRenderSignals(page,2,s=>logs.push(s),base);
    await page.goto(base+'/?token='+secret,{waitUntil:'load'}); await flush();
    assert.ok(logs.some(s=>s.includes('kind=pdf-reference source=app')),JSON.stringify(logs));
    assert.ok(logs.some(s=>s.includes('kind=other source=foreign')),JSON.stringify(logs));
    noSecrets(logs); await context.close();
  } finally {if(browser) await browser.close();await close(app);await close(foreign);}
});

test('hostile malformed input, budgets, no retries, and independent categories', async()=>{
  const events={},logs=[],page={on:(n,fn)=>events[n]=fn,evaluate:()=>Promise.reject(Error(secret))};
  const sig=signals.attachRenderSignals(page,99,s=>logs.push(s),'invalid '+secret);
  for(let i=0;i<25;i++) events.pageerror({message:secret,stack:secret});
  for(let i=0;i<25;i++){sig.sample('render');sig.sample('cards-empty');sig.sample('card-inspection-failed');sig.sample(secret);}
  await flush(); assert.equal(logs.length,7); assert.equal(logs.filter(x=>x.includes('page-error')).length,4);assert.equal(logs.filter(x=>x.includes('snapshot')).length,3);
  assert.ok(logs.every(x=>x.includes('source=unknown')||x.includes('result=error')));noSecrets(logs);
  const events2={},logs2=[];const p2={on:(n,fn)=>events2[n]=fn,evaluate:()=>Promise.resolve({ready:secret,cardsTop:secret,frame:Infinity,nodesCapped:1})};
  const sig2=signals.attachRenderSignals(p2,100,s=>logs2.push(s),'https://app.invalid');sig2.sample('render');await flush();
  assert.match(logs2[0],/result=error/);noSecrets(logs2);
  const hostile={on:(n,fn)=>events2[n]=fn,evaluate(){throw Error(secret)}};
  const sig3=signals.attachRenderSignals(hostile,NaN,()=>{throw Error(secret)},'https://app.invalid');
  assert.doesNotThrow(()=>sig3.sample('render'));assert.doesNotThrow(()=>events2.pageerror({get message(){throw Error(secret)}}));
});

test('first-frame attribution is limited and unknown if parsing fails',()=>{
  const e={},logs=[];signals.attachRenderSignals({on:(n,f)=>e[n]=f},3,s=>logs.push(s),'https://app.invalid/private?token='+secret);
  e.pageerror({message:'pdfjsLib is not defined',stack:`ReferenceError\n at fn (https://foreign.invalid/${secret}?token=${secret}:2:1)\n at fn (https://app.invalid/a:3:1)`});
  e.pageerror({message:'pdfjsLib is not defined',stack:secret});
  assert.match(logs[0],/source=foreign/);assert.match(logs[1],/source=unknown/);noSecrets(logs);
});

test('coordinator opt-in and opt-out, empty-card checkpoint, and bounded sanitized legacy listeners',async()=>{
  for(const enabled of [false,true]) {
    const events={}, logs=[];let evals=0;
    const page={on:(n,fn)=>(events[n] ||= []).push(fn),setDefaultTimeout(){},setDefaultNavigationTimeout(){},
      evaluate:async()=>{evals++;if(evals===1)return [];return {ready:'complete',frame:0,frameReadable:0,frameUnreadable:0,frameComplete:0,canvas:0,canvasNonzero:0,shadowOpen:0,cardsTop:0,cardsShadow:0,cardsFrame:0,nodesCapped:0}}};
    const env=enabled?{MATHU_RENDER_DIAGNOSTICS:'1'}:{MATHU_RENDER_DIAGNOSTICS:'0'};
    const mod=load('parallel-coordinator.ts',{process:{env},require:name=>{
      if(name==='./worker-navigation-recovery')return {};
      if(name==='./render-diagnostics')return legacy;
      if(name==='./render-observability')return signals;
      throw Error('unexpected import');
    }});
    mod._injectDependencies({config:{APP_URL:'https://app.invalid/'+secret},logger:{log:s=>logs.push(s)}});
    const c=new mod.ParallelCoordinator(); c.browser={newContext:async()=>({newPage:async()=>page})};
    await c._createWorker(0);
    assert.equal(!!events.requestfailed,enabled);
    assert.equal(events.pageerror.length,enabled?2:1);
    for(let i=0;i<12;i++) {
      for(const fn of events.console) fn({type:()=> 'error',text:()=>{throw Error(secret)}});
      for(const fn of events.pageerror) fn({message:secret,stack:`Error ${secret}\n at fn (https://app.invalid/${secret}:1:2)`});
    }
    assert.equal(logs.filter(x=>x.includes('[page-console]')).length,4);
    assert.equal(logs.filter(x=>x.includes('[page-error]')).length,4);
    assert.equal(logs.filter(x=>x.includes('[render-signal] page-error')).length,enabled?4:0);
    assert.equal(await c._claimNextModule(0),null); await flush();
    assert.equal(logs.filter(x=>x.includes('checkpoint=cards-empty')).length,enabled?1:0);
    assert.equal(evals,enabled?2:1); noSecrets(logs);
  }
});

test('snapshot node scan and output are capped',async()=>{
  const events={},logs=[]; const app=await startServer((req,res)=>res.end('<!doctype html>'+('<div class="card"></div>'.repeat(1600))));
  let browser;
  try {
    browser=await chromium.launch({executablePath:'/usr/bin/chromium',headless:true,args:['--no-sandbox','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1']});
    const page=await browser.newPage();const base=`http://127.0.0.1:${app.address().port}`;
    const sig=signals.attachRenderSignals(page,1,s=>logs.push(s),base);await page.goto(base);sig.sample('render');await flush();
    assert.ok(logs[0].includes('cardsTop=100'));assert.ok(logs[0].includes('nodesCapped=1'));noSecrets(logs);
  } finally {if(browser)await browser.close();await close(app);}
});
