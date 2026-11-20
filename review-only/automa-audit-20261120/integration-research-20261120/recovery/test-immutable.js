'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {verifyImmutableCommit} = require('./immutable-postverify');
const repo = 'Maka-opsol/Automa-bot';
const digest = b => crypto.createHash('sha256').update(b).digest('hex');
function fixture(options = {}) {
  const db = new Map();
  function put(type, data) {
    data = Buffer.from(data);
    const oid = crypto.createHash('sha1').update(Buffer.from(`${type} ${data.length}\0`)).update(data).digest('hex');
    db.set(oid, {type, data}); return oid;
  }
  const blob = text => put('blob', text);
  function tree(entries) {
    entries = entries.slice().sort((a,b) => Buffer.compare(Buffer.from(a[1] + (a[0] === '40000' ? '/' : '')), Buffer.from(b[1] + (b[0] === '40000' ? '/' : ''))));
    return put('tree', Buffer.concat(entries.map(([m,n,id]) => Buffer.concat([Buffer.from(`${m} ${n}\0`), Buffer.from(id,'hex')]))));
  }
  function commit(root, parents) {
    return put('commit', `tree ${root}\n${parents.map(p => 'parent '+p+'\n').join('')}author T <t@example.test> 1 +0000\ncommitter T <t@example.test> 1 +0000\n\nmessage\n`);
  }
  const original = blob('old\n'), updated = blob(options.actual ?? 'new\r\n');
  const unchanged = blob('unchanged');
  const oldTarget = tree([[options.oldMode || '100644','file.js',original], ['100644','other',unchanged]]);
  const afterEntries = [[options.newMode || '100644','file.js',updated], ['100644','other',options.other ? blob('changed') : unchanged]];
  if (options.add) afterEntries.push(['100644','added',blob('x')]);
  const newTarget = tree(afterEntries);
  const oldRoot = tree([['40000','dir',oldTarget],['100644','root',unchanged]]);
  const newRootEntries = [['40000','dir',newTarget], ['100644','root',unchanged]];
  if (options.emptyDirectory) newRootEntries.push(['40000','empty',tree([])]);
  const newRoot = tree(newRootEntries);
  const base = commit(oldRoot, []);
  const after = commit(newRoot, options.parents ? options.parents(base, oldRoot) : [base]);
  const content = options.expected ?? 'new\r\n';
  const input = {repository:repo,filename:'dir/file.js',base,blob:original,commit:after,mode:'100644',content,contentDigest:digest(content)};
  const calls = [];
  const reader = { async getObject(repository, oid) {
    calls.push({repository,oid});
    const object = db.get(oid); if (!object) return null;
    return {status:200, repository, oid, type:object.type, data:Buffer.from(object.data), complete:true, truncated:false, hasMore:false};
  }};
  return {input, reader, db, calls, put, tree, commit, oldRoot, newRoot, base, after, updated, original};
}
async function checkFalse(f) { assert.equal(await verifyImmutableCommit(f.input, f.reader), false); }

test('accepts exact immutable nested one-path change and CRLF bytes; no HEAD query', async () => {
  const f = fixture(); assert.equal(await verifyImmutableCommit(f.input, f.reader), true);
  assert.ok(f.calls.length >= 6); assert.ok(f.calls.every(c => c.repository === repo && /^[0-9a-f]{40}$/.test(c.oid)));
});
test('accepts exact multibyte UTF-8 and empty output', async () => {
  for (const content of ['α🙂\r\n', '']) { const f = fixture({actual:content,expected:content}); assert.equal(await verifyImmutableCommit(f.input,f.reader), true); }
});
for (const [name, opts] of [
  ['other path changed', {other:true}], ['additional path added',{add:true}], ['empty tree added',{emptyDirectory:true}],
  ['prior executable',{oldMode:'100755'}], ['new executable',{newMode:'100755'}], ['prior symlink',{oldMode:'120000'}],
  ['new symlink',{newMode:'120000'}], ['CRLF normalized',{actual:'new\n'}], ['zero parents',{parents:()=>[]}],
  ['multiple parents',{parents:(base)=>[base,base]}], ['wrong parent',{parents:(_base,tree)=>[tree]}]
]) test('rejects '+name, async () => checkFalse(fixture(opts)));
for (const [name, mutate] of [
  ['different repo', i=>i.repository='other/repo'], ['outside path',i=>i.filename='../file.js'], ['dot segment',i=>i.filename='dir/.secret'],
  ['wrong target path',i=>i.filename='dir/other'], ['invalid commit ID',i=>i.commit='main'], ['invalid baseline',i=>i.base='HEAD'],
  ['equal commit and baseline',i=>i.commit=i.base], ['unsupported mode',i=>i.mode='100755'], ['digest mismatch',i=>i.contentDigest='a'.repeat(64)],
  ['missing digest',i=>delete i.contentDigest], ['wrong reviewed blob',i=>i.blob='f'.repeat(40)], ['missing reviewed blob',i=>delete i.blob], ['lone surrogate UTF-8',i=>{i.content='\ud800';i.contentDigest=digest(i.content);}]
]) test('rejects input '+name, async () => { const f=fixture(); mutate(f.input); await checkFalse(f); });
for (const [name, mutate] of [
  ['non-200 status',r=>r.status=206], ['wrong repository',r=>r.repository='evil/repo'], ['wrong object id',r=>r.oid='0'.repeat(40)],
  ['wrong type',r=>r.type='blob'], ['missing complete',r=>delete r.complete], ['incomplete',r=>r.complete=false],
  ['truncated',r=>r.truncated=true], ['missing truncation flag',r=>delete r.truncated], ['more pages',r=>r.hasMore=true],
  ['missing pagination flag',r=>delete r.hasMore], ['non-buffer bytes',r=>r.data=r.data.toString('base64')],
  ['tampered object bytes',r=>r.data=Buffer.concat([r.data, Buffer.from('x')])]
]) test('rejects evidence '+name, async () => {
  const f=fixture(), get=f.reader.getObject; f.reader.getObject=async (...args)=>{const r=await get(...args); if(r) mutate(r); return r;}; await checkFalse(f);
});
test('rejects missing and throwing reader',async()=>{for(const getObject of [async()=>null, async()=>{throw Error('network');}]) {const f=fixture(); f.reader.getObject=getObject; await checkFalse(f);}});
test('rejects missing nested tree or target blob',async()=>{for(const which of ['tree','blob']) {const f=fixture(), get=f.reader.getObject; f.reader.getObject=async (...args)=>{let r=await get(...args); return r && r.type===which ? null : r;}; await checkFalse(f);}});
test('rejects fake claimed type and content addressed tampering specifically at new blob',async()=>{const f=fixture(), get=f.reader.getObject; f.reader.getObject=async (...args)=>{let r=await get(...args); if(args[1]===f.updated) r.data=Buffer.from('new\n'); return r;}; await checkFalse(f);});
test('rejects duplicate tree entries',async()=>{const f=fixture(); const entry=Buffer.concat([Buffer.from('100644 file.js\0'),Buffer.from(f.updated,'hex')]);const dup=f.put('tree',Buffer.concat([entry,entry])); const root=f.tree([['40000','dir',dup]]); f.input.commit=f.commit(root,[f.base]);await checkFalse(f);});
test('rejects malformed and truncated raw tree bytes',async()=>{for(const raw of [Buffer.from('100644 a\0abc'),Buffer.from('100644 /bad\0'+ 'a'.repeat(20))]){const f=fixture();const root=f.put('tree',raw);f.input.commit=f.commit(root,[f.base]);await checkFalse(f);}});
test('rejects unrelated deleted subtree and no-op',async()=>{const f=fixture();f.input.commit=f.commit(f.oldRoot,[f.base]);await checkFalse(f);const g=fixture();const root=g.tree([['100644','root',g.original]]);g.input.commit=g.commit(root,[g.base]);await checkFalse(g);});
