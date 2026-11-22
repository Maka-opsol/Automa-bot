'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require(process.env.ESBUILD_PATH || 'esbuild');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
function load(file, extras={}) {
  const src = fs.readFileSync(path.join(root, file),'utf8');
  const js = esbuild.transformSync(src,{loader:'ts',format:'cjs',target:'node20'}).code;
  const ctx={module:{exports:{}},exports:{},console,URL,Buffer,setTimeout,setInterval,...extras};
  vm.runInNewContext(js,ctx,{filename:file});
  return ctx.module.exports;
}
const helper = load('render-diagnostics.ts');
const secret = 'PRIVATE_USER_TOKEN_PATH_QUERY';
function fixtures() {
  const events={}, logs=[], frame={url:()=>`https://app.example/${secret}?token=${secret}`};
  const page={on:(n,f)=>{events[n]=f},mainFrame:()=>frame};
  helper.attachRenderDiagnostics(page,2,s=>logs.push(s));
  function request(url,type='script',failure='net::ERR_BLOCKED_BY_CSP') { return {url:()=>url,frame:()=>frame,resourceType:()=>type,failure:()=>({errorText:failure})}; }
  function response(req,status,headers={}) { return {request:()=>req,status:()=>status,headers:()=>Promise.resolve(headers)}; }
  return {events,logs,frame,page,request,response};
}
test('script failure and response output only fixed coarse categories',()=>{
  const f=fixtures();
  f.events.requestfailed(f.request(`https://cdn.example/${secret}/pdf.min.js?token=${secret}`));
  f.events.response(f.response(f.request(`https://app.example/${secret}/flutter_bootstrap.js?token=${secret}`),503));
  f.events.response(f.response(f.request(`https://app.example/${secret}/private.js`),204));
  assert.deepEqual(f.logs,['[WORKER-2] [render-diag] request-failed kind=pdf-script origin=external reason=csp-block','[WORKER-2] [render-diag] response kind=flutter-script origin=same status=5xx']);
  assert.ok(!JSON.stringify(f.logs).includes(secret));
});
test('CSP presence and directives only, never policy text or non-main document',async()=>{
  const f=fixtures(); const req=f.request(`https://app.example/${secret}`,'document');
  f.events.response(f.response(req,200,{'content-security-policy':`default-src 'self'; script-src https://${secret}; report-uri /${secret}`,'content-security-policy-report-only':`script-src-elem 'none'; report-uri /${secret}`}));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.deepEqual(f.logs,['[WORKER-2] [render-diag] csp enforced=present,script-src=1,script-src-elem=0,default-src=1 report-only=present,script-src=0,script-src-elem=1,default-src=0']);
  assert.ok(!JSON.stringify(f.logs).includes(secret));
  req.frame=()=>({url:()=>''}); f.events.response(f.response(req,200,{})); await Promise.resolve();
  assert.equal(f.logs.length,1);
});
test('absent CSP, unknown origins, malformed URLs and unknown errors remain coarse',async()=>{
  const f=fixtures();f.events.response(f.response(f.request('https://app.example/','document'),200,{}));
  f.events.requestfailed(f.request(`bad ${secret}`,'script',`toString`));
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok(f.logs.some(s=>s.includes('kind=other-script origin=unknown reason=other')));
  assert.ok(f.logs.some(s=>s.includes('csp enforced=absent report-only=absent')));
  assert.ok(!JSON.stringify(f.logs).includes(secret));
});
test('event count is capped and hostile getters/logger are contained',()=>{
  const f=fixtures();for(let i=0;i<100;i++)f.events.requestfailed(f.request(`https://cdn.example/${secret}.js`));
  assert.equal(f.logs.length,20);assert.doesNotThrow(()=>f.events.requestfailed({resourceType(){throw Error(secret)}}));
  const events={}; helper.attachRenderDiagnostics({on:(n,fn)=>events[n]=fn},1,()=>{throw Error(secret)});
  assert.doesNotThrow(()=>events.requestfailed(f.request('https://cdn.example/pdf.js')));
});
test('header rejection and non-script failures do not leak or cause unhandled rejection',async()=>{
  const f=fixtures(); const req=f.request(`https://app.example/${secret}`,'document');
  f.events.response({request:()=>req,status:()=>200,headers:()=>Promise.reject(Error(secret))});
  f.events.requestfailed(f.request(`https://app.example/${secret}`,'xhr',secret));
  await new Promise(resolve=>setTimeout(resolve,0)); assert.deepEqual(f.logs,[]);
});
function coordinator(enabled, document) {
  let clock=0;const logs=[]; const env=enabled?{MATHU_RENDER_DIAGNOSTICS:'1'}:{MATHU_RENDER_DIAGNOSTICS:'0'};
  class FakeDate extends Date {static now(){return clock}}
  const mod=load('parallel-coordinator.ts',{Date:FakeDate,document,process:{env},require:name=>{
    if(name==='./worker-navigation-recovery')return {};
    if(name==='./render-diagnostics')return helper;
    throw Error('unexpected import '+name);
  }});
  mod._injectDependencies({logger:{log:s=>logs.push(s)}});const c=new mod.ParallelCoordinator();c._sleep=async n=>{clock+=n};
  return {c,logs,clock:()=>clock};
}
test('optional polling distinguishes missing, zero and evaluate failures and keeps 60s timeout',async()=>{
  const {c,logs,clock}=coordinator(true);let i=0;
  await c._waitForFlutterRender({evaluate:async()=>{i++;if(i<=20)return 'absent';if(i<=40)return 'zero';throw Error(secret)}},7);
  assert.equal(clock(),60000);assert.ok(logs.some(s=>s.includes('absent=20 zero=20 eval-error=20')));
  assert.match(logs.at(-1),/proceeding anyway/);assert.ok(!JSON.stringify(logs).includes(secret));
});
test('optional polling keeps nonzero early return and unchanged predicate',async()=>{
  const {c,logs,clock}=coordinator(true);let i=0;
  await c._waitForFlutterRender({evaluate:async()=>++i===1?'absent':'nonzero'},1);
  assert.equal(clock(),1000);assert.ok(logs.some(s=>s.includes('absent=1 zero=0 eval-error=0')));assert.match(logs.at(-1),/readiness unverified/);
});
test('disabled polling keeps original behavior and emits no diagnostic output',async()=>{
  const {c,logs,clock}=coordinator(false);await c._waitForFlutterRender({evaluate:async()=>false},1);
  assert.equal(clock(),60000);assert.equal(logs.length,1);assert.ok(!logs[0].includes('render-diag'));
});
test('diagnostics-off failure still reports absent/zero/eval-error breakdown on the WARN line',async()=>{
  const {c,logs,clock}=coordinator(false);
  await c._waitForFlutterRender({evaluate:async()=>'absent'},1);
  assert.equal(clock(),60000);
  assert.equal(logs.length,1); // only the WARN; no [render-diag] line when diagnostics off
  assert.match(logs[0],/No nonzero canvas detected within 60s \(polls absent=60 zero=0 eval-error=0 cardsMax=0\); render status unknown — proceeding anyway/);
  assert.ok(!logs[0].includes('render-diag'));
});
test('enabled and disabled modes run the same real first-canvas predicate',async()=>{
  for (const canvas of [null,{width:0,height:20},{width:2,height:3}]) {
    const outcomes=[];
    for (const enabled of [false,true]) {
      const document={querySelector:selector=>{assert.equal(selector,'canvas');return canvas}};
      const {c,clock}=coordinator(enabled,document);
      await c._waitForFlutterRender({evaluate:async fn=>fn()},1);
      outcomes.push(clock());
    }
    assert.equal(outcomes[0],outcomes[1]);
    assert.equal(outcomes[0],canvas&&canvas.width>0&&canvas.height>0?0:60000);
  }
});
test('render-diagnostics listeners are opt-in; requestfailed is always-on',async()=>{
  for (const enabled of [false,true]) {const {c}=coordinator(enabled);const events=[];
    const page={on:n=>events.push(n),setDefaultTimeout(){},setDefaultNavigationTimeout(){}};
    c.browser={newContext:async()=>({newPage:async()=>page})};await c._createWorker(0);
    assert.ok(events.includes('requestfailed')); // always-on coarse network-failure diagnostic
    assert.equal(events.includes('response'),enabled); // opt-in render-diagnostics only
    assert.ok(events.includes('pageerror'));assert.ok(events.includes('console'));
  }
});
