'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createContract, sha256 } = require('./contract');

// Test-only fakes. This verifier only knows a fixture and is NOT cryptographic.
function setup() {
  const now = 1700000000000;
  const used = new Set();
  const request = { receipt: 'fixture-signed-receipt', repo: 'owner/repo', branch: 'main', baseCommit: 'a'.repeat(40), baseBlob: 'b'.repeat(40), candidate: Buffer.from('candidate') };
  const claims = { repo: request.repo, branch: request.branch, baseCommit: request.baseCommit, baseBlob: request.baseBlob, candidateSha256: sha256(request.candidate), caller: 'alice', policy: 'policy-v1', expiresAtMs: now + 1000, nonce: 'nonce-1' };
  const adapters = {
    requiredPolicy: 'policy-v1',
    verifyReceipt: async raw => raw === 'fixture-signed-receipt' ? claims : null,
    authenticateCaller: async context => context === 'authenticated-alice-fixture' ? 'alice' : null,
    evaluatePolicy: async () => true,
    // Synchronous check+insert before returning a promise models atomicity only in this process.
    atomicConsume: async ({ nonce, expiresAtMs }) => {
      if (expiresAtMs <= now || used.has(nonce)) return false;
      used.add(nonce);
      return true;
    }
  };
  return { request, claims, adapters, context: 'authenticated-alice-fixture', used, now };
}
function run(s) { return createContract(s.adapters)(s.request, s.context); }

test('valid trusted exact binding succeeds once', async () => {
  const s = setup(); const result = await run(s);
  assert.equal(result.repo, s.request.repo);
  assert.equal(result.branch, s.request.branch);
  assert.equal(result.baseCommit, s.request.baseCommit);
  assert.equal(result.baseBlob, s.request.baseBlob);
  assert.equal(result.candidateSha256, sha256(s.request.candidate));
  assert.equal(result.caller, 'alice'); assert.equal(result.policy, 'policy-v1');
  assert.equal(result.receiptSha256, sha256(s.request.receipt));
  assert.equal(result.expiresAtMs, s.claims.expiresAtMs); assert.equal(result.nonce, s.claims.nonce);
  assert.equal(await run(s), null);
});

test('all required adapters and trusted policy must be injected', () => {
  for (const name of ['verifyReceipt', 'authenticateCaller', 'evaluatePolicy', 'atomicConsume', 'requiredPolicy']) {
    const s = setup(); delete s.adapters[name]; assert.throws(() => createContract(s.adapters), TypeError);
  }
});

test('invalid receipt, identity and forged booleans deny', async () => {
  let s = setup(); s.request.receipt = 'forged'; assert.equal(await run(s), null);
  s = setup(); s.context = { authenticated: true, authorized: true }; assert.equal(await run(s), null);
  s = setup(); s.request.authorized = true; s.adapters.evaluatePolicy = async () => false; assert.equal(await run(s), null);
  s = setup(); s.adapters.evaluatePolicy = async () => ({ authorized: true }); assert.equal(await run(s), null);
  s = setup(); s.adapters.atomicConsume = async () => ({ consumed: true }); assert.equal(await run(s), null);
});

for (const [field, value] of [
  ['repo', 'other/repo'], ['branch', 'other'], ['baseCommit', 'c'.repeat(40)],
  ['baseBlob', 'd'.repeat(40)], ['candidateSha256', '0'.repeat(64)],
  ['caller', 'mallory'], ['policy', 'policy-v2'], ['nonce', ''],
  ['expiresAtMs', NaN], ['expiresAtMs', 1.5], ['candidateSha256', 'not-a-hash']
]) {
  test(`mismatched or invalid claim ${field}=${String(value).slice(0, 12)} denies before consume`, async () => {
    const s = setup(); s.claims[field] = value; assert.equal(await run(s), null); assert.equal(s.used.size, 0);
  });
}

test('changed candidate denies', async () => { const s = setup(); s.request.candidate = Buffer.from('changed'); assert.equal(await run(s), null); });
test('malformed target denies', async () => { const s = setup(); s.request.baseBlob = 'not-a-git-oid'; assert.equal(await run(s), null); });
test('expired and exactly-expired receipts deny at consume', async () => {
  for (const delta of [-1, 0]) { const s = setup(); s.claims.expiresAtMs = s.now + delta; assert.equal(await run(s), null); assert.equal(s.used.size, 0); }
});
test('concurrent attempts permit exactly one', async () => {
  const s = setup(); const authorize = createContract(s.adapters);
  const results = await Promise.all(Array.from({length: 50}, () => authorize(s.request, s.context)));
  assert.equal(results.filter(Boolean).length, 1); assert.equal(s.used.size, 1);
});
for (const name of ['authenticateCaller', 'verifyReceipt', 'evaluatePolicy', 'atomicConsume']) {
  test(`${name} exception fails closed`, async () => {
    const s = setup(); s.adapters[name] = async () => { throw Error('adapter failed'); };
    assert.equal(await run(s), null);
  });
}

test('request candidate is snapshotted before async adapter', async () => {
  const s = setup();
  s.adapters.authenticateCaller = async () => { s.request.candidate.fill(0); return 'alice'; };
  const result = await run(s); assert.equal(result.candidateSha256, s.claims.candidateSha256);
  assert.notEqual(sha256(s.request.candidate), result.candidateSha256);
});
