'use strict';
// Runs the actual HTTP handler and v1 auditor with synthetic network transports.
// No sockets, credentials, Actions dispatch or remote data are used.
const {test}=require('node:test'), assert=require('node:assert/strict'), fs=require('node:fs'), vm=require('node:vm'), {EventEmitter}=require('node:events'), crypto=require('node:crypto');
const {setup,base,candidate,blob,commit,nonce}=require('./test-actions-fixture.cjs');
const realAudit=require('./actions-auditor');
const source=fs.readFileSync(require.resolve('./app.js'),'utf8');
const key='0123456789abcdef'.repeat(4), commit2='b'.repeat(40);
function harness(opts={}){
 const a=setup(opts.audit||{}), calls=[], sends=[], reservations=new Map(), used=new Set();let monotime=1000, handler;
 const fake={
  issue:async (binding,e)=>{if(opts.issueFail)throw Error();if(opts.expire==='issue')monotime=4000000;return {binding:JSON.stringify(binding),mac:crypto.createHmac('sha256','synthetic-test-key').update(JSON.stringify(binding)).digest('hex')};},
  authorize:async (r,b)=>!opts.badReceipt&&r.binding===JSON.stringify(b)&&r.mac===crypto.createHmac('sha256','synthetic-test-key').update(JSON.stringify(b)).digest('hex'),
  enabled:async()=>!opts.disabled,
  journal:{reserve:async ({binding,receipt,operation})=>{const id=binding.repository+binding.branch+binding.filename;if(opts.journalFail||reservations.has(id)||used.has(receipt.mac))return {status:'locked'};used.add(receipt.mac);const r={status:'reserved',id,operation};reservations.set(id,r);if(opts.expire==='reserve')monotime=4000000;return r;},committed:async(r,c)=>{if(opts.completeFail)return false;r.status='committed';return true;},uncertain:async r=>{r.status='uncertain';}},
  sendOnce:async req=>{sends.push(req);if(opts.ambiguous)throw Error('timeout');const i=req.variables.input;return {status:200,data:{createCommitOnBranch:{clientMutationId:opts.wrongId?'bad':i.clientMutationId,commit:{oid:commit2,parents:{totalCount:1,nodes:[{oid:opts.wrongParent?'c'.repeat(40):commit}]}}}}};},
  verifyCommit:async input=>{calls.push(['verify',input]);return !opts.badTree;}
 };
 const network=(path)=>{
  const prefix='/repos/Maka-opsol/Automa-bot';assert(path.startsWith(prefix));path=path.slice(prefix.length);calls.push(['GET',path]);
  if(path==='')return {full_name:'Maka-opsol/Automa-bot',default_branch:'main'};
  if(path==='/git/ref/heads/main')return {object:{sha:opts.head||commit}};
  if(path.startsWith('/git/commits/'))return {tree:{sha:'d'.repeat(40)}};
  if(path==='/git/trees/'+ 'd'.repeat(40))return {tree:[{path:'src',mode:'040000',type:'tree',sha:'e'.repeat(40)}],truncated:false};
  if(path==='/git/trees/'+ 'e'.repeat(40))return {tree:[{path:'file.ts',mode:opts.mode||'100644',type:'blob',sha:opts.changedBlob?'f'.repeat(40):blob}],truncated:false};
  if(path.startsWith('/contents/src/file.ts?ref='))return {type:'file',path:'src/file.ts',encoding:'base64',content:Buffer.from(base).toString('base64'),sha:blob,size:Buffer.byteLength(base)};
  if(path==='/contents/src/file.ts')return {content:Buffer.from(candidate).toString('base64')};
  throw Error('Unexpected synthetic URL '+path);
 };
 const https={request:(options,cb)=>{const req=new EventEmitter();req.write=()=>{};req.destroy=()=>{};req.end=()=>process.nextTick(()=>{try{assert.equal(options.method,'GET');const data=network(options.path),res=new EventEmitter();res.headers={};res.statusCode=200;res.complete=true;res.destroy=()=>{};cb(res);res.emit('data',Buffer.from(JSON.stringify(data)));res.emit('end');}catch(e){req.emit('error',e)}});return req;}};
 const fakeHttp={createServer:fn=>{handler=fn;return {listen:()=>{}};}};
 const env={MAIN_WRITE_ENABLED:'yes',PATCH_SUBMISSION_KEY:key,GITHUB_TOKEN:'synthetic',AI_AUDITOR_BACKEND:'actions'};
 const reqmod=id=>{if(id==='http')return fakeHttp;if(id==='https')return https;if(id==='node:perf_hooks')return {performance:{now:()=>monotime}};if(id==='./review-writer-adapters')return opts.noDeps?null:fake;if(id==='./public-room'||id==='./github-webhook-admission')return {};if(id==='./actions-auditor')return {audit:(p,f,d,c,u,ctx,options)=>realAudit.audit(p,f,d,c,u,ctx,{...options,env:a.env,transport:a.transport,randomBytes:()=>Buffer.from(nonce,'hex'),sleep:async()=>{}})};return require(id);};
 const context={require:reqmod,process:{env,getuid:process.getuid},console:{log(){},error(){}},Buffer,TextDecoder,URL,setTimeout,clearTimeout,setInterval,clearInterval,setImmediate,Date,Math};
 vm.runInNewContext(source,context,{filename:'app.js'});
 async function request(method,url,body,apiKey=key){const req=new EventEmitter();req.method=method;req.url=url;req.headers={};req.rawHeaders=[];if(method==='POST'){req.headers['x-api-key']=apiKey;req.rawHeaders=['x-api-key',apiKey];}req.destroy=()=>{};const out=await new Promise(resolve=>{const res={statusCode:200,headersSent:false,setHeader(){},writeHead(code){this.statusCode=code;this.headersSent=true;},end(body){resolve({code:this.statusCode,body:JSON.parse(body||'{}')});}};handler(req,res);if(body!==undefined){req.emit('data',JSON.stringify(body));req.emit('end');}});return out;}
 async function submit(patch=candidate){const r=await request('POST','/api/patch/submit',{file:'src/file.ts',patch,description:'test',submittedBy:'tester',reviewedSha:blob});if(!r.body.patchId)return r;for(let i=0;i<100;i++){await new Promise(r=>setTimeout(r,2));const s=await request('GET','/api/patch/status/'+r.body.patchId);if(['done','rejected','failed','unknown'].includes(s.body.currentStatus))return s.body;}throw Error('pipeline did not finish');}
 return {submit,request,fake,calls,sends,reservations,a,close:()=>a.close()};
}
async function scenario(opts,check){const h=harness(opts);try{await check(h);}finally{h.close();}}
test('actual submit route performs verified v1 audit and synthetic whole-head commit',()=>scenario({},async h=>{const s=await h.submit();assert.equal(s.currentStatus,'done');assert.equal(h.sends.length,1);const i=h.sends[0].variables.input;assert.equal(i.expectedHeadOid,commit);assert.equal(i.branch.repositoryNameWithOwner,'Maka-opsol/Automa-bot');assert.equal(i.branch.branchName,'main');assert.equal(i.fileChanges.additions[0].path,'src/file.ts');assert.equal(Buffer.from(i.fileChanges.additions[0].contents,'base64').toString(),candidate);assert.equal(h.calls.filter(x=>x[0]==='verify').length,1);assert.equal(h.a.calls.filter(x=>x.method==='POST').length,1);}));
for(const [name,opts,status] of [
 ['missing adapters',{noDeps:true},'failed'],['changed baseline blob',{changedBlob:true},'rejected'],['executable mode',{mode:'100755'},'rejected'],['audit pin differs from captured head',{head:'c'.repeat(40)},'rejected'],['missing quorum',{audit:{verdict:{providers:['ollama#security']}}},'rejected'],['unsafe aggregate',{audit:{verdict:{safe:false}}},'rejected'],['bad receipt',{badReceipt:true},'rejected'],['issuer failure',{issueFail:true},'rejected'],['journal unavailable',{journalFail:true},'rejected'],['deadline during issuance',{expire:'issue'},'rejected'],['deadline after reservation',{expire:'reserve'},'rejected'],['disabled switch',{disabled:true},'rejected']])test(name,()=>scenario(opts,async h=>{const s=await h.submit();assert.equal(s.currentStatus,status,JSON.stringify(s));assert.equal(h.sends.length,0);}));
for(const [name,opts] of [['ambiguous send',{ambiguous:true}],['wrong response identity',{wrongId:true}],['wrong commit parent',{wrongParent:true}],['failed tree verification',{badTree:true}],['failed journal completion',{completeFail:true}]])test(name,()=>scenario(opts,async h=>{const s=await h.submit();assert.equal(s.currentStatus,'unknown');assert.equal(h.sends.length,1);assert.equal([...h.reservations.values()][0].status,'uncertain');}));
test('unauthorized route sends no network requests',()=>scenario({},async h=>{const r=await h.request('POST','/api/patch/submit',{file:'src/file.ts',patch:candidate,reviewedSha:blob},'wrong');assert.equal(r.code,401);assert.equal(h.calls.length,0);assert.equal(h.a.calls.length,0);assert.equal(h.sends.length,0);}));
