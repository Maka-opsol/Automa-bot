'use strict';
// No external site: all requests are intercepted before fulfillment/abort.
const {test}=require('node:test');const assert=require('node:assert/strict');const {chromium}=require('playwright-core');
const fs=require('node:fs'),path=require('node:path'),Module=require('node:module');
const esbuild=require(process.env.ESBUILD_PATH||'esbuild');
const {attachAuthNetDiagnostics}=require('../authnet-diagnostics');
function coordinator(){const f=path.resolve(__dirname,'../parallel-coordinator.ts');const m=new Module(f,module);m.filename=f;m.paths=module.paths;m._compile(esbuild.transformSync(fs.readFileSync(f,'utf8'),{loader:'ts',format:'cjs',target:'node20'}).code,f);return m.exports;}
async function runFixture(handler,run){const b=await chromium.launch({executablePath:'/usr/bin/chromium',args:['--no-sandbox','--disable-background-networking','--host-resolver-rules=MAP * ~NOTFOUND']});try{const c=await b.newContext({serviceWorkers:'block'});await c.route('**/*',handler);const p=await c.newPage();await run(p);}finally{await b.close();}}
function setup(p){const messages=[],mod=coordinator();const logger={log:m=>{messages.push(m);return true;}};mod._injectDependencies({config:{APP_URL:'http://fixture.invalid'},logger});const c=new mod.ParallelCoordinator();c._sleep=async()=>{};const diag=attachAuthNetDiagnostics(p,2,'http://fixture.invalid',true,logger.log);const w={page:p,authNetDiag:diag};return {c,w,messages,events:()=>messages.filter(x=>x.startsWith('[authnet-diag] ')).map(x=>JSON.parse(x.slice(15)))};}
test('real browser blocked redirect records 3xx, Microsoft category and DNS failure without query',async()=>{
 // Playwright routes the first URL only; the resolver deliberately blocks the redirect.
 let requests=0;await runFixture(async route=>{requests++;await route.fulfill({status:302,headers:{location:'https://login.microsoftonline.com/common/oauth2/authorize?code=SYNTHETIC_PRIVATE'}});},async p=>{const f=setup(p);assert.equal(await f.c._ensureLoggedIn(f.w,2),false);const ev=f.events();assert.ok(ev.some(e=>e.event==='response'&&e.status==='3xx'));assert.ok(ev.some(e=>e.event==='request'&&e.host==='microsoft_login'&&e.redirected==='yes'));assert.ok(ev.some(e=>e.event==='request_failed'&&e.error_code==='ERR_NAME_NOT_RESOLVED'));assert.equal(ev.at(-1).outcome,'exception');assert.equal(JSON.stringify(ev).includes('SYNTHETIC_PRIVATE'),false);assert.equal(requests,1);});
});
test('real browser intercepted reset records phase and code without URL or synthetic query',async()=>{
 let requests=0;await runFixture(async route=>{requests++;await route.abort('connectionreset');},async p=>{const f=setup(p);assert.equal(await f.c._ensureLoggedIn(f.w,2),false);const ev=f.events();assert.ok(ev.some(e=>e.event==='request_failed'&&e.error_code==='ERR_CONNECTION_RESET'));assert.equal(ev.at(-1).phase,'entry_domcontentloaded');assert.equal(ev.at(-1).error_code,'ERR_CONNECTION_RESET');assert.equal(JSON.stringify(ev).includes('fixture.invalid'),false);assert.equal(requests,1);});
});
