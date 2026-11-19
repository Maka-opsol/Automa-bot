'use strict';
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {EventEmitter} = require('node:events');
const esbuild = require(process.env.ESBUILD_PATH || 'esbuild');
const root = path.resolve(__dirname, '..');
const secret = 'PRIVATE_TEST_SECRET';
function load(file, imports, env) {
  const js = esbuild.transformSync(fs.readFileSync(path.join(root,file),'utf8'), {loader:'ts',format:'cjs',target:'node20'}).code;
  const ctx={module:{exports:{}},exports:{},URL,Buffer,console,process:{env},setTimeout,setInterval,require:n=>n in imports ? imports[n] : require(n)};
  vm.runInNewContext(js,ctx,{filename:file});return ctx.module.exports;
}
test('both streams coexist with navigation correlation and omit hostile input',async()=>{
 const logs=[];const auth=require('../authnet-diagnostics');
 const render=load('render-diagnostics.ts',{},{}), signals=load('render-observability.ts',{},{});
 const nav={navigateWorkerEntry:async(p,url)=>p.goto(url,{waitUntil:'domcontentloaded',timeout:60000})};
 const env={MATHU_AUTHNET_DIAGNOSTICS:'1',MATHU_RENDER_DIAGNOSTICS:'1'};
 const mod=load('parallel-coordinator.ts',{'./worker-navigation-recovery':nav,'./authnet-diagnostics':auth,'./render-diagnostics':render,'./render-observability':signals},env);
 class Page extends EventEmitter {
  constructor(){super();this.current='about:blank';this.frame={url:()=>this.current};}
  setDefaultTimeout(){} setDefaultNavigationTimeout(){} mainFrame(){return this.frame;} url(){return this.current;}
  async goto(url){const request={url:()=>url,frame:()=>this.frame,isNavigationRequest:()=>true,redirectedFrom:()=>null,resourceType:()=> 'document'};this.emit('request',request);this.emit('response',{request:()=>request,url:()=>url,status:()=>200,headers:()=>({'content-security-policy':"script-src 'self'; report-uri /"+secret})});this.current=url;this.emit('framenavigated',this.frame);return {};}
  async evaluate(){return {ready:'complete',frame:0,frameReadable:0,frameUnreadable:0,frameComplete:0,canvas:1,canvasNonzero:1,shadowOpen:0,cardsTop:0,cardsShadow:0,cardsFrame:0,nodesCapped:0};}
 }
 const p=new Page(),c=new mod.ParallelCoordinator();mod._injectDependencies({config:{APP_URL:'https://fixture.invalid/?token='+secret},logger:{log:x=>logs.push(x)}});c.browser={newContext:async()=>({newPage:async()=>p})};c._sleep=async()=>{};
 await c._createWorker(3);const w=c.workers.get(3);assert.equal(await c._ensureLoggedIn(w,3),true);await c._navigateAssignments(w,false);p.emit('pageerror',{message:secret,stack:'https://fixture.invalid/'+secret});p.emit('console',{type:()=> 'error',text:()=>secret});await new Promise(r=>setTimeout(r,0));
 const output=logs.join('\n');assert.ok(output.includes('[authnet-diag]'));assert.ok(output.includes('[render-diag]'));assert.ok(output.includes('[render-signal]'));assert.ok(output.includes('assignments_load'));for(const x of [secret,'fixture.invalid','https://','?token='])assert.ok(!output.includes(x),x);
});
test('real auth guard avoids URL and query in Microsoft and unknown-page logs',async()=>{
 const logs=[];const guard=load('cycle-auth-guard.ts',{'./utils-sleep':{sleep:async()=>{}}},{ });guard._injectDependencies({config:{APP_URL:'https://fixture.invalid'},logger:{log:x=>{logs.push(x);return true;}}});
 for(const url of ['https://login.microsoftonline.com/?code='+secret,'https://unknown.invalid/?code='+secret]){const page={url:()=>url};assert.equal(await guard.ensureAuthenticated(page),page);}
 const out=logs.join('\n');assert.ok(logs.length>=2);for(const x of [secret,'unknown.invalid','login.microsoftonline.com','https://','?code='])assert.ok(!out.includes(x),x);
});
