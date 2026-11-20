'use strict';
// OFFLINE TEST BRIDGE ONLY: the object's claimed repository and completeness
// flags below are SYNTHETIC. This is not a trusted GitHub object reader.
const fs = require('node:fs');
const {verifyImmutableCommit} = require('./immutable-postverify');
(async () => {
  const {binding, commit, objects} = JSON.parse(fs.readFileSync(0, 'utf8'));
  const reader = { async getObject(repository, oid) {
    const o = objects[oid];
    if (!o) return null;
    return {status:200,repository,oid,type:o.type,data:Buffer.from(o.data,'base64'),complete:true,truncated:false,hasMore:false};
  }};
  const crypto = require('node:crypto');
  const result = await verifyImmutableCommit({...binding, commit,
    contentDigest:crypto.createHash('sha256').update(binding.content,'utf8').digest('hex')}, reader);
  process.stdout.write(result ? 'true' : 'false');
})().catch(()=>{process.stdout.write('false'); process.exitCode=1;});
