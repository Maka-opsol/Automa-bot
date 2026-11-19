'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const esbuild = require(process.env.ESBUILD_PATH || 'esbuild');
const source = fs.readFileSync(process.env.WORKER_SOURCE || __dirname + '/parallel-coordinator.ts', 'utf8');
// Compile the actual complete coordinator. Only the entry-navigation import is stubbed.
const js = esbuild.transformSync(source + '\nmodule.exports.__pdfErrorSource = pdfErrorSource;', {loader:'ts', format:'cjs', target:'node20'}).code;
let clock = 0;
class FakeDate extends Date { static now() { return clock; } }
const ctx = { module: {exports:{}}, exports: {}, require: name => {
  if (name === './worker-navigation-recovery') return {navigateWorkerEntry: async () => {}};
  throw new Error('unexpected require ' + name);
}, console, process, Buffer, URL, Date: FakeDate, setTimeout, setInterval };
vm.runInNewContext(js, ctx, {filename:'parallel-coordinator.js'});
const {ParallelCoordinator, _injectDependencies, __pdfErrorSource: pdf} = ctx.module.exports;
const message = 'pdfjsLib is not defined';
function p(stack, page='https://app.example.test/private?token=TOP_SECRET') { return pdf({message, stack},page); }
const same = 'ReferenceError\n at https://app.example.test/private/a.js?token=SECRET:12:34';
test('PDF source recognizes same origin without exposing URLs or secrets', () => { assert.equal(p(same),' [pdf-source same-origin]'); });
test('PDF external source has coarse classification', () => { assert.equal(p('ReferenceError\n at https://cdn.example.test/x.js:2:3'),' [pdf-source external-origin]'); });
test('missing page origin is unknown', () => { assert.equal(p(same,''),' [pdf-source unknown-origin]'); });
test('missing malformed unsupported stack frames are unavailable', () => { for (const stack of [undefined,'','Error\n at native','Error\n at https://[broken:3:4','Error\n at file:///x.js:1:2']) assert.equal(p(stack),' [pdf-source unavailable]'); });
test('malformed frame does not prevent finding later usable frame', () => { assert.equal(p('Error\n at https://[broken:3:4\n at https://app.example.test/x:2:3'),' [pdf-source same-origin]'); });
test('source scan is bounded to 40 frames and 16384 chars', () => { assert.equal(p('Error\n'+' at native\n'.repeat(40)+' at https://app.example.test/x:1:2'),' [pdf-source unavailable]'); assert.equal(p('Error\n'+'x'.repeat(16384)+'\n at https://app.example.test/x:1:2'),' [pdf-source unavailable]'); });
test('unrelated errors untouched', () => { assert.equal(pdf({message:'other'},'https://app.example.test'), ''); });
test('throwing stack accessor is contained', () => { assert.equal(pdf({message,get stack(){throw Error('secret');}},''),' [pdf-source unavailable]'); });
function setup() {
  const logs=[]; _injectDependencies({logger:{log:(...args)=>logs.push(args)}});
  const c = new ParallelCoordinator();
  c._sleep = async ms => {clock += ms;};
  return {c,logs};
}
async function worker() {
  const {c,logs}=setup(); const events={}; let urls=0;
  const page={setDefaultTimeout(){},setDefaultNavigationTimeout(){},on(k,f){events[k]=f;},url(){urls++;return 'https://app.example.test/?token=PRIVATE';}};
  c.browser={newContext:async()=>({newPage:async()=>page})}; await c._createWorker(2);
  return {c,logs,events,urls:()=>urls};
}
test('actual pageerror listener retains PDF error and emits coarse source', async () => { const w=await worker(); w.events.pageerror({message,stack:same}); const line=w.logs.at(-1); assert.equal(line[0], '[WORKER-2] [page-error] pdfjsLib is not defined [pdf-source same-origin]'); assert.equal(line[1],'ERROR'); assert.ok(!line[0].includes('SECRET')); });
test('actual listener leaves unrelated errors unchanged and does not access URL', async () => { const w=await worker(); w.events.pageerror({message:'ordinary error'}); assert.equal(w.urls(),0); assert.equal(w.logs.at(-1)[0],'[WORKER-2] [page-error] ordinary error'); });
test('card evaluation failure is not logged as a confirmed absence and does not leak error', async () => { const {c,logs}=setup(); c.workers.set(1,{page:{evaluate:async()=>{throw Error('PRIVATE_URL');}}}); assert.equal(await c._claimNextModule(1),null); assert.match(logs.at(-1)[0],/inspection failed; page content unknown/); assert.ok(!JSON.stringify(logs).includes('PRIVATE_URL')); assert.ok(!JSON.stringify(logs).includes('No module cards found')); });
test('a successful empty card inspection still reports no cards', async () => { const {c,logs}=setup(); c.workers.set(1,{page:{evaluate:async()=>[]}}); assert.equal(await c._claimNextModule(1),null); assert.match(logs.at(-1)[0],/No module cards found/); });
test('successful nonempty inspection preserves claiming path', async () => { const {c}=setup(); c.workers.set(1,{page:{evaluate:async()=>[{name:'synthetic video',completed:false}]}}); c._claimModuleInDb=async()=>true; const result=await c._claimNextModule(1); assert.equal(result.name,'synthetic video'); assert.equal(result.type,'video'); });
test('nonzero canvas message does not claim readiness', async () => {clock=0;const {c,logs}=setup();await c._waitForFlutterRender({evaluate:async()=>true},1);assert.match(logs.at(-1)[0],/Nonzero canvas detected.*readiness unverified/);assert.equal(clock,0);});
test('60 second no-canvas and evaluation-error paths report unknown and continue', async () => { for (const evaluate of [async()=>false,async()=>{throw Error('closed');}]) {clock=0;const {c,logs}=setup();await c._waitForFlutterRender({evaluate},1);assert.equal(clock,60000);assert.match(logs.at(-1)[0],/No nonzero canvas detected within 60s; render status unknown — proceeding anyway/);} });
