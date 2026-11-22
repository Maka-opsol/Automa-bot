'use strict';
// Supplementary offline reproductions execute the original page predicates.
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const esbuild=require(process.env.ESBUILD_PATH || 'esbuild');
const source=fs.readFileSync(__dirname+'/parallel-coordinator.ts','utf8');
const code=esbuild.transformSync(source,{loader:'ts',format:'cjs',target:'node20'}).code;
const realm={module:{exports:{}},exports:{},require:n=>n==='./worker-navigation-recovery'?{}:require(n),process,console,URL,Buffer,setTimeout,setInterval};
vm.runInNewContext(code,realm);const {ParallelCoordinator,_injectDependencies}=realm.module.exports;
test('nonzero canvas satisfies the render gate via the canvas signal, without proving Flutter readiness',async()=>{
 const logs=[];_injectDependencies({logger:{log:s=>logs.push(s)}});const c=new ParallelCoordinator();
 realm.document={querySelector:s=>s==='canvas'?{width:300,height:150}:null};
 const page={evaluate:async fn=>fn()}; await c._waitForFlutterRender(page,1);
 assert.match(logs.at(-1),/Render signal detected \(canvas=nonzero\).*readiness unverified/);
});
test('a canvas-only synthetic page yields no selected DOM cards, not proof of no visual cards',async()=>{
 const logs=[];_injectDependencies({logger:{log:s=>logs.push(s)}});const c=new ParallelCoordinator();let selector='';
 realm.document={querySelectorAll:s=>{selector=s;return []}};
 c.workers.set(1,{page:{evaluate:async fn=>fn()}});assert.equal(await c._claimNextModule(1),null);
 assert.equal(selector,'[class*="card"], [role="listitem"], .module-card');assert.match(logs.at(-1),/No module cards found/);
});
