'use strict';
// Offline review prototype. Never execute repository content or trust a verdict URL.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const {TextDecoder} = require('node:util');
const REPO='Maka-opsol/Automa-bot', WORKFLOW='.github/workflows/dashboard-auditor.yml';
const HEX40=/^[a-f0-9]{40}$/, HEX64=/^[a-f0-9]{64}$/;
const PATH=/^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)*\.(?:js|mjs|cjs|ts|tsx|jsx)$/;
const DENY=/(private[ _-]?key|-----begin|password|passwd|secret|api[_-]?key|bearer\s+[a-z0-9]|github_pat_|gh[pousr]_|sk-[a-z0-9]|student|learner|pupil|homework|worksheet|exam(?:ination)?|assessment|answer(?:s|ing)?|question(?:s)?|lesson|curriculum|math(?:ematics)?\s+(?:problem|task)|ignore\s+(?:all\s+)?(?:previous|prior)|system\s+prompt|(?:https?:\/\/|@)[^\s])/i;
const bad=()=>{throw Error('Actions audit rejected or unavailable');};
const digest=x=>crypto.createHash('sha256').update(x).digest('hex');
const integer=x=>Number.isSafeInteger(x)&&x>0;
// GitHub-owned artifact storage hosts; used to validate the signed artifact redirect
// when ACTIONS_AUDIT_ARTIFACT_HOST is not explicitly pinned by the operator.
const isGitHubHost=h=>{const lh=String(h||'').toLowerCase().replace(/\.$/,'');return lh==='github.com'||lh.endsWith('.github.com')||lh.endsWith('.githubusercontent.com');};
function source(s,max=4096){if(typeof s!=='string'||!s.length||Buffer.byteLength(s,'utf8')>max||!/^[\x09\x0a\x0d\x20-\x7e]+$/.test(s)||s.includes('<|')||DENY.test(s))bad();return Buffer.from(s,'ascii');}
function validDir(p){if(typeof p!=='string'||!path.isAbsolute(p)||fs.realpathSync(p)!==path.resolve(p))bad();const s=fs.statSync(p);if(!s.isDirectory()||(s.mode&0o077)!==0||s.uid!==process.getuid())bad();}
function admission(file,strict,filename,base,candidate) {
  // Operator-curated exact-content allowlist, not an automatic privacy classifier.
  if(typeof file!=='string'||!path.isAbsolute(file)||fs.realpathSync(file)!==path.resolve(file))bad();
  const s=fs.statSync(file);if(!s.isFile()||s.uid!==process.getuid()||(s.mode&0o022)||s.size>65536)bad();
  const obj=strict(new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(file)));
  if(!obj||Object.keys(obj).sort().join(',')!=='entries,version'||obj.version!==1||!Array.isArray(obj.entries)||obj.entries.length>256)bad();
  const hits=obj.entries.filter(x=>x&&Object.keys(x).sort().join(',')==='baseline_sha256,candidate_sha256,path'&&x.path===filename&&x.baseline_sha256===digest(base)&&x.candidate_sha256===digest(candidate));
  if(hits.length!==1)bad();
}
function reserve(dir,record) {
  validDir(dir);let d,f;
  try {d=fs.openSync(dir,'r'); f=fs.openSync(path.join(dir,record.nonce+'.jsonl'),'wx',0o600); fs.writeFileSync(f,JSON.stringify(record)+'\n');fs.fsyncSync(f);fs.fsyncSync(d);return {d,f};}
  catch(e){if(f!==undefined)fs.closeSync(f);if(d!==undefined)fs.closeSync(d);bad();}
}
function append(j,value){fs.writeSync(j.f,JSON.stringify(value)+'\n');fs.fsyncSync(j.f);}
function close(j){try{fs.closeSync(j.f);}finally{fs.closeSync(j.d);}}
// Require one conventional single-entry ZIP, no comments, encryption, directories,
// symlinks, extra files, ZIP64 or trailing bytes. Verify CRC and both headers.
function crc32(b){let c=0xffffffff;for(const x of b){c^=x;for(let i=0;i<8;i++)c=(c>>>1)^((c&1)?0xedb88320:0);}return (c^0xffffffff)>>>0;}
function unzip(b){
 if(!Buffer.isBuffer(b)||b.length<100||b.length>65536)bad();const n=b.length,e=n-22;
 if(b.readUInt32LE(e)!==0x06054b50||b.readUInt16LE(e+4)!==0||b.readUInt16LE(e+6)!==0||b.readUInt16LE(e+8)!==1||b.readUInt16LE(e+10)!==1||b.readUInt16LE(e+20)!==0)bad();
 const cd=b.readUInt32LE(e+16),cs=b.readUInt32LE(e+12);if(cd+cs!==e||cd<30||cd+46>e||b.readUInt32LE(cd)!==0x02014b50)bad();
 const flags=b.readUInt16LE(cd+8),method=b.readUInt16LE(cd+10),crc=b.readUInt32LE(cd+16),comp=b.readUInt32LE(cd+20),size=b.readUInt32LE(cd+24),nl=b.readUInt16LE(cd+28),ex=b.readUInt16LE(cd+30),comment=b.readUInt16LE(cd+32),disk=b.readUInt16LE(cd+34),off=b.readUInt32LE(cd+42),ext=b.readUInt32LE(cd+38);
 if((flags&~0x808)!==0||![0,8].includes(method)||size>8192||comp>32768||disk||off!==0||cd+46+nl+ex+comment!==e||comment||((ext>>>16)&0xf000)===0xa000)bad();
 const name=Buffer.from('dashboard-audit-verdict.json');if(nl!==name.length||!b.subarray(cd+46,cd+46+nl).equals(name))bad();
 if(b.readUInt32LE(0)!==0x04034b50||b.readUInt16LE(6)!==flags||b.readUInt16LE(8)!==method||b.readUInt16LE(26)!==nl)bad();
 const lex=b.readUInt16LE(28),start=30+nl+lex,end=start+comp;if(end>cd||!b.subarray(30,30+nl).equals(name))bad();
 if(flags&8){const len=cd-end;if(len!==12&&len!==16)bad();let p=end;if(len===16){if(b.readUInt32LE(p)!==0x08074b50)bad();p+=4;}if(b.readUInt32LE(p)!==crc||b.readUInt32LE(p+4)!==comp||b.readUInt32LE(p+8)!==size)bad();}
 else if(end!==cd||b.readUInt32LE(14)!==crc||b.readUInt32LE(18)!==comp||b.readUInt32LE(22)!==size)bad();
 let out;try{if(method===0)out=b.subarray(start,end);else{const expanded=zlib.inflateRawSync(b.subarray(start,end),{maxOutputLength:8192,info:true});if(expanded.engine.bytesWritten!==comp)bad();out=expanded.buffer;}}catch{bad();}if(out.length!==size||crc32(out)!==crc)bad();return out;
}
// Bounded streaming HTTP; never follows redirects or forwards credentials to storage.
async function request(url,{method='GET',token,body,deadline,limit=65536,fetcher=fetch}){
 const ms=Math.min(deadline-Date.now(),30000);if(ms<=0)bad();const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),ms);
 try{
  const headers={Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28','User-Agent':'MathU-Dashboard-Auditor'};
  if(token)headers.Authorization='Bearer '+token;if(body!==undefined)headers['Content-Type']='application/json';
  const r=await fetcher(url,{method,headers,redirect:'manual',signal:controller.signal,...(body!==undefined?{body:JSON.stringify(body)}:{})});
  const chunks=[];let len=0;if(r.body){for await(const chunk of r.body){len+=chunk.length;if(len>limit||Date.now()>=deadline)bad();chunks.push(Buffer.from(chunk));}}
  if(Date.now()>=deadline)bad();return {status:r.status,location:r.headers.get('location'),data:Buffer.concat(chunks)};
 }catch{bad();}finally{clearTimeout(timer);}
}
// Operator configuration. ACTIONS_AUDIT_TOKEN defaults to GITHUB_TOKEN so the
// dashboard's existing commit credential can drive the auditor when a dedicated
// token is not provisioned. The exact reviewed workflow commit pin is mandatory;
// workflow/actor/repo IDs and artifact host may still be derived. Admission
// is gated behind ACTIONS_AUDIT_SKIP_ADMISSION=1, which forces the operator to
// acknowledge the weaker posture via ACTIONS_AUDIT_PREREQUISITES.
function config(env){
 const e=env, token=e.ACTIONS_AUDIT_TOKEN||e.GITHUB_TOKEN, timeout=Number(e.ACTIONS_AUDIT_TIMEOUT_MS||2700000), interval=Number(e.ACTIONS_AUDIT_POLL_MS||3000);
 const prereq=e.ACTIONS_AUDIT_PREREQUISITES, skipAdmission=e.ACTIONS_AUDIT_SKIP_ADMISSION==='1';
 const workflow=e.ACTIONS_AUDIT_WORKFLOW_ID, actor=e.ACTIONS_AUDIT_ACTOR_ID, repoId=e.ACTIONS_AUDIT_REPOSITORY_ID, sha=e.ACTIONS_AUDIT_WORKFLOW_SHA, host=e.ACTIONS_AUDIT_ARTIFACT_HOST;
 if(typeof token!=='string'||!token||token.trim()!==token)bad();
 if(prereq!=='reviewed-private-admission-and-durable-journal'&&prereq!=='operator-opted-skip-admission')bad();
 if(skipAdmission&&prereq!=='operator-opted-skip-admission')bad();
 if(!skipAdmission&&(typeof e.ACTIONS_AUDIT_ADMISSION_FILE!=='string'||!e.ACTIONS_AUDIT_ADMISSION_FILE||!path.isAbsolute(e.ACTIONS_AUDIT_ADMISSION_FILE)))bad();
 if(workflow!==undefined&&(!Number.isInteger(Number(workflow))||Number(workflow)<=0))bad();
 if(actor!==undefined&&(!Number.isInteger(Number(actor))||Number(actor)<=0))bad();
 if(repoId!==undefined&&(!Number.isInteger(Number(repoId))||Number(repoId)<=0))bad();
 if(!HEX40.test(sha||''))bad();
 if(host!==undefined&&(typeof host!=='string'||host.length>253||!/^[a-z0-9.-]+$/.test(host)||!host.includes('.')||host.includes('..')))bad();
 if(!Number.isInteger(timeout)||timeout<1000||timeout>2700000||!Number.isInteger(interval)||interval<250||interval>10000)bad();
 if(typeof e.ACTIONS_AUDIT_JOURNAL_DIR!=='string'||!e.ACTIONS_AUDIT_JOURNAL_DIR||!path.isAbsolute(e.ACTIONS_AUDIT_JOURNAL_DIR))bad();
 return {token,workflow:workflow===undefined?undefined:Number(workflow),actor:actor===undefined?undefined:Number(actor),repoId:repoId===undefined?undefined:Number(repoId),sha:sha===undefined?undefined:sha,host:host===undefined?undefined:host,timeout,interval,journal:e.ACTIONS_AUDIT_JOURNAL_DIR,admission:e.ACTIONS_AUDIT_ADMISSION_FILE,skipAdmission};
}
async function audit(patch,filename,description,critical,submitter,context,{env=process.env,strictJson,transport=request,sleep=ms=>new Promise(r=>setTimeout(r,ms)),randomBytes=crypto.randomBytes,onValidated}={}){
 const rejected={safe:false,reason:'Actions auditor rejected or unavailable',votes:[]};let j,step='input';
 const monotonicStart=require('node:perf_hooks').performance.now();
 try{
  if(typeof strictJson!=='function'||typeof description!=='string'||description.length>2000||typeof submitter!=='string'||!submitter.trim()||submitter.length>256||typeof critical!=='boolean'||typeof filename!=='string'||filename.length>160||DENY.test(filename)||!context||!HEX40.test(context.reviewedSha||''))bad();
  const publicReadme=context.publicReadme===true;
  if((publicReadme ? filename!=='README.md' : !PATH.test(filename))||filename.startsWith('auditor/')||filename.startsWith('.github/'))bad();
  const candidate=source(patch,4096),baseline=source(context.originalContent,4096);if(candidate.equals(baseline))bad();
  if(publicReadme){
   const guard=require('./anonymous-documentation');guard.prevalidate({file:filename,patch,description,reviewedSha:context.reviewedSha});guard.validateDiff(context.originalContent,patch,filename);
   const suffix=patch.slice(context.originalContent.length);
   if(!context.originalContent.endsWith('\n')||!patch.startsWith(context.originalContent)||Buffer.byteLength(suffix)>1024||suffix.split('\n').length-Number(suffix.endsWith('\n'))>20||!/^[A-Za-z0-9 ,.?!\n-]+$/.test(suffix)||!/[A-Za-z0-9]/.test(suffix))bad();
  }
  const gitBlob=crypto.createHash('sha1').update('blob '+baseline.length+'\0').update(baseline).digest('hex');if(gitBlob!==context.reviewedSha)bad();
  step='config';const c=config(env);
  if(!c.skipAdmission){step='admission';admission(c.admission,strictJson,filename,baseline,candidate);}
  step='nonce';const nonce=randomBytes(32).toString('hex');if(!HEX64.test(nonce))bad();
  const deadline=Math.min(Date.now()+c.timeout, context.pipelineDeadline===undefined ? Infinity : context.pipelineDeadline-120000),root='https://api.github.com/repos/'+REPO,api='https://api.github.com';
  if(!Number.isFinite(deadline)||Date.now()>=deadline)bad();
  const checkTime=()=>{if(Date.now()>=deadline||require('node:perf_hooks').performance.now()-monotonicStart>=c.timeout)bad();if(context.assertDeadline!==undefined){if(typeof context.assertDeadline!=='function')bad();context.assertDeadline();}};
  const bounded=async(url,options)=>{checkTime();const r=await transport(url,options);checkTime();return r;};
  const req=async(method,p,body,limit=65536)=>bounded(root+p,{method,token:c.token,body,deadline,limit});
  const apiReq=async(method,p,body,limit=65536)=>bounded(api+p,{method,token:c.token,body,deadline,limit});
  const json=r=>strictJson(new TextDecoder('utf-8',{fatal:true}).decode(r.data));
  // Resolve the workflow by numeric ID (operator-pinned) or by filename (auto-derived).
  // Both paths validate the path + active state; the pinned path additionally checks id.
  step='workflow';const wfKey=c.workflow!==undefined?c.workflow:encodeURIComponent(path.basename(WORKFLOW));
  let r=await req('GET','/actions/workflows/'+wfKey);if(r.status!==200)bad();const w=json(r);
  if(w.path!==WORKFLOW||w.state!=='active'||!integer(w.id))bad();
  if(c.workflow!==undefined&&w.id!==c.workflow)bad();
  const workflowId=w.id;
  // Actor and repository may be auto-derived; workflow SHA is always pinned.
  let actorId=c.actor,repoIdVal=c.repoId,shaVal=c.sha;
  if(actorId===undefined){step='derive_actor';r=await apiReq('GET','/user');if(r.status!==200)bad();const u=json(r);if(!integer(u.id))bad();actorId=u.id;}
  if(repoIdVal===undefined){step='derive_repo';r=await apiReq('GET','/repos/'+REPO);if(r.status!==200)bad();const rep=json(r);if(!integer(rep.id))bad();repoIdVal=rep.id;}
  // Ref is main, so refuse to dispatch if its observed head already differs from
  // the trusted pin. This preflight cannot eliminate a branch movement race.
  step='preflight_pin';r=await apiReq('GET','/repos/'+REPO+'/branches/main');if(r.status!==200||json(r).commit?.sha!==shaVal)bad();
  step='journal';j=reserve(c.journal,{version:1,state:'reserved',nonce,path:filename,base_blob:context.reviewedSha,candidate_sha256:digest(candidate),workflow_sha:shaVal});
  step='dispatch';r=await req('POST','/actions/workflows/'+workflowId+'/dispatches',{ref:'main',return_run_details:true,inputs:{nonce,path:filename,base_blob:context.reviewedSha,candidate_b64:candidate.toString('base64')}});
  if(r.status!==200)bad();const dispatch=json(r);const runId=dispatch.workflow_run_id;if(!integer(runId))bad();append(j,{state:'dispatched',run_id:runId});
  let run;
  step='poll';do {
   r=await req('GET','/actions/runs/'+runId);if(r.status!==200)bad();run=json(r);
   if(run.id!==runId||run.workflow_id!==workflowId||run.event!=='workflow_dispatch'||run.head_branch!=='main'||run.head_sha!==shaVal||run.run_attempt!==1||run.repository?.id!==repoIdVal||run.repository?.full_name!==REPO||run.head_repository?.id!==repoIdVal||run.actor?.id!==actorId||run.triggering_actor?.id!==actorId)bad();
   if(run.status==='completed')break;if(!['queued','in_progress','waiting','requested','pending'].includes(run.status)||Date.now()+c.interval>=deadline)bad();await sleep(c.interval);
  }while(Date.now()<deadline);
  step='conclusion';if(run.status!=='completed'||run.conclusion!=='success')bad();
  step='jobs';r=await req('GET','/actions/runs/'+runId+'/attempts/1/jobs?per_page=100');if(r.status!==200)bad();const jobs=json(r);if(!Array.isArray(jobs.jobs)||jobs.total_count!==jobs.jobs.length||jobs.jobs.length>100)bad();const selected=jobs.jobs.filter(x=>x.name==='audit');if(selected.length!==1||selected[0].run_id!==runId||selected[0].run_attempt!==1||selected[0].status!=='completed'||selected[0].conclusion!=='success')bad();
  step='artifact';r=await req('GET','/actions/runs/'+runId+'/artifacts?per_page=100&name=audit-'+nonce);if(r.status!==200)bad();const a=json(r);if(a.total_count!==1||!Array.isArray(a.artifacts)||a.artifacts.length!==1)bad();const art=a.artifacts[0];if(art.name!=='audit-'+nonce||art.expired!==false||!integer(art.id)||!integer(art.size_in_bytes)||art.size_in_bytes>65536||art.workflow_run?.id!==runId||art.workflow_run?.repository_id!==repoIdVal||art.workflow_run?.head_sha!==shaVal)bad();
  step='artifact_redirect';r=await req('GET','/actions/artifacts/'+art.id+'/zip');if(r.status!==302||!r.location)bad();const u=new URL(r.location);if(u.protocol!=='https:'||u.username||u.password||u.port||u.hash)bad();if(c.host!==undefined){if(u.hostname!==c.host)bad();}else{if(!isGitHubHost(u.hostname))bad();}
  step='archive';r=await bounded(u.href,{method:'GET',deadline,limit:65536});if(r.status!==200)bad();const verdict=json({data:unzip(r.data)});
  step='verdict';const keys='base_blob,candidate_sha256,job,nonce,path,providers,run_attempt,run_id,safe,version,workflow_sha';
  // V1 producer is approved only with these three bound Ollama perspectives.
  if(!verdict||Object.keys(verdict).sort().join(',')!==keys||verdict.version!==1||verdict.nonce!==nonce||verdict.path!==filename||verdict.base_blob!==context.reviewedSha||verdict.candidate_sha256!==digest(candidate)||verdict.run_id!==String(runId)||verdict.run_attempt!==1||verdict.job!=='audit'||verdict.workflow_sha!==shaVal||!Array.isArray(verdict.providers)||verdict.providers.length!==3||new Set(verdict.providers).size!==3||!['ollama#security','ollama#correctness','ollama#intent'].every(p=>verdict.providers.includes(p))||verdict.safe!==true)bad();
  // Detect reruns or identity changes during artifact retrieval. Restrict rerun privileges too;
  // API eventual consistency cannot be proven away by this read.
  step='rerun';r=await req('GET','/actions/runs/'+runId);if(r.status!==200||Date.now()>=deadline)bad();const finalRun=json(r);
  if(finalRun.id!==runId||finalRun.workflow_id!==workflowId||finalRun.event!=='workflow_dispatch'||finalRun.head_branch!=='main'||finalRun.head_sha!==shaVal||finalRun.run_attempt!==1||finalRun.repository?.id!==repoIdVal||finalRun.repository?.full_name!==REPO||finalRun.head_repository?.id!==repoIdVal||finalRun.actor?.id!==actorId||finalRun.triggering_actor?.id!==actorId||finalRun.status!=='completed'||finalRun.conclusion!=='success')bad();
  append(j,{state:'consumed',run_id:runId});
  // Internal evidence only. This v1 aggregate is NOT a signed receipt or
  // authenticated per-vote record. The issuer must authenticate its provenance.
  if(onValidated!==undefined){if(typeof onValidated!=='function')bad();onValidated(Object.freeze({...verdict,providers:Object.freeze([...verdict.providers])}));}
  return {safe:true,reason:'Actions auditors approved; advisory only',votes:verdict.providers.map(p=>({provider:p,is_safe:true}))};
 }catch(e){try{console.error('[actions-auditor] rejected at step: '+step);}catch{} return rejected;}finally{if(j)try{close(j);}catch{}}
}
module.exports={audit,request,unzip,crc32};
