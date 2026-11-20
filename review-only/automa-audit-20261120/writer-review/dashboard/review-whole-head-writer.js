'use strict';
// Offline research implementation based on whole-head-writer.prototype.js.
// ALL adapters are unimplemented production trust boundaries. See REVIEW.md.
const crypto = require('node:crypto');
const { MUTATION } = require('./whole-head-writer.prototype');
const oid=/^[0-9a-f]{40}$/, hex64=/^[0-9a-f]{64}$/;
const required=['ollama#security','ollama#correctness','ollama#intent'];
function reject(s){const e=new Error(s);e.notSent=true;throw e;}
function hash(s){return crypto.createHash('sha256').update(s,'utf8').digest('hex');}
function dependenciesReady(d){return !!d && typeof d.issue==='function' && typeof d.authorize==='function' && typeof d.enabled==='function' && typeof d.sendOnce==='function' && typeof d.verifyCommit==='function' && d.journal && ['reserve','committed','uncertain'].every(k=>typeof d.journal[k]==='function');}
function validEvidence(e, input){return e && Object.keys(e).sort().join(',')==='base_blob,candidate_sha256,job,nonce,path,providers,run_attempt,run_id,safe,version,workflow_sha' && e.version===1 && e.safe===true && e.job==='audit' && e.path===input.filename && e.base_blob===input.blob && e.candidate_sha256===hash(input.content) && e.workflow_sha===input.base && e.run_attempt===1 && /^[1-9][0-9]*$/.test(e.run_id||'') && hex64.test(e.nonce||'') && Array.isArray(e.providers) && e.providers.length===3 && new Set(e.providers).size===3 && required.every(p=>e.providers.includes(p));}
async function writeWholeHead(input, deps) {
 const {repository,branch,filename,content,message,base,blob,mode,evidence,deadlineWall,deadlineMono,nowMono}=input;
 if(repository!=='Maka-opsol/Automa-bot'||branch!=='main'||typeof filename!=='string'||!/^[A-Za-z0-9_./-]+$/.test(filename)||filename.split('/').some(x=>!x||x==='.'||x==='..'||x.startsWith('.'))||typeof content!=='string'||typeof message!=='string'||!oid.test(base||'')||!oid.test(blob||'')||mode!=='100644'||!validEvidence(evidence,input))reject('Invalid bound audit or unsupported write');
 if(!dependenciesReady(deps)||typeof nowMono!=='function'||!Number.isFinite(deadlineWall)||!Number.isFinite(deadlineMono))reject('Whole-head safety adapters unavailable');
 const check=()=>{if(Date.now()>=deadlineWall||nowMono()>=deadlineMono)reject('Write authority expired');};
 check();
 const binding=Object.freeze({repository,branch,filename,base,blob,mode,contentDigest:hash(content),runId:evidence.run_id,runAttempt:evidence.run_attempt,nonce:evidence.nonce,workflowSha:evidence.workflow_sha,expiresAt:deadlineWall});
 // A trusted issuer must independently authenticate the actual v1 audit/runtime;
 // neither this aggregate callback nor an arbitrary in-process object is proof.
 let receipt;try{receipt=await deps.issue(binding,evidence);}catch{reject('Receipt issuance unavailable');}
 check(); if(!receipt)reject('Receipt issuance unavailable');
 let authorized=false;try{authorized=await deps.authorize(receipt,binding);}catch{} if(authorized!==true)reject('Receipt authorization rejected');
 check(); if(await deps.enabled()!==true)reject('Writes disabled');
 const operation=crypto.randomBytes(32).toString('hex');
 let reservation;try{reservation=await deps.journal.reserve({binding,receipt,operation});}catch{reject('Atomic journal unavailable');}
 // reserve must atomically consume the receipt, persist before sending, and lock
 // the entire target across all workers/restarts until reconciliation.
 if(!reservation||reservation.status!=='reserved')reject('Receipt already consumed or target locked');
 check(); if(await deps.enabled()!==true)reject('Writes disabled after reservation'); check();
 const request={query:MUTATION,variables:{input:{branch:{repositoryNameWithOwner:repository,branchName:branch},expectedHeadOid:base,message:{headline:message},fileChanges:{additions:[{path:filename,contents:Buffer.from(content,'utf8').toString('base64')}]},clientMutationId:operation}}};
 try{
   const result=await deps.sendOnce(request);const p=result?.data?.createCommitOnBranch,c=p?.commit;
   if(result?.status!==200||(result.errors!==undefined&&(!Array.isArray(result.errors)||result.errors.length!==0))||p?.clientMutationId!==operation||!oid.test(c?.oid||'')||c.parents?.totalCount!==1||c.parents?.nodes?.length!==1||c.parents.nodes[0].oid!==base)throw Error('Unconfirmed mutation');
   // Independent immutable-object verifier MUST establish exact one-parent,
   // full tree delta, path, blob bytes and unchanged executable mode.
   if(await deps.verifyCommit({...binding,commit:c.oid,content})!==true)throw Error('Commit verification failed');
   if(await deps.journal.committed(reservation,c.oid)!==true)throw Error('Journal completion failed');
   return c.oid;
 }catch{try{await deps.journal.uncertain(reservation);}catch{}throw Error('Write outcome or journal completion unknown; reconciliation required');}
}
module.exports={writeWholeHead,dependenciesReady,validEvidence};
