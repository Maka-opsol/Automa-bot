'use strict';

// Independent illustrative contract, NOT a deployable authorization system.
const { createHash } = require('node:crypto');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 1024;
const oid = v => typeof v === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(v);
const hash = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

/**
 * All injected functions are trusted boundary components, not caller assertions.
 * verifyReceipt MUST authenticate the exact serialized receipt and return its claims;
 * authenticateCaller MUST establish the actual caller; evaluatePolicy MUST apply
 * trusted policy. atomicConsume MUST atomically check expiry against authoritative
 * time and consume a unique nonce, durably and across all writers. It returns true
 * only for the single successful consumption. See README for limitations.
 */
function createContract({ verifyReceipt, authenticateCaller, evaluatePolicy, atomicConsume, requiredPolicy }) {
  if (![verifyReceipt, authenticateCaller, evaluatePolicy, atomicConsume].every(f => typeof f === 'function') || !text(requiredPolicy)) {
    throw new TypeError('trusted adapters and requiredPolicy are required');
  }
  return async function authorize(request, authContext) {
    try {
      if (!request || typeof request !== 'object' || !text(request.receipt) || !Buffer.isBuffer(request.candidate)) return null;
      // Snapshot untrusted request inputs before awaiting adapters.
      const receipt = request.receipt;
      const target = Object.freeze({ repo: request.repo, branch: request.branch, baseCommit: request.baseCommit, baseBlob: request.baseBlob });
      const candidateSha256 = sha256(Buffer.from(request.candidate));
      if (!text(target.repo) || !text(target.branch) || !oid(target.baseCommit) || !oid(target.baseBlob)) return null;
      const caller = await authenticateCaller(authContext);
      if (!text(caller)) return null;
      const verified = await verifyReceipt(receipt);
      if (!verified || typeof verified !== 'object') return null;
      // Copy only defined primitive claims; don't trust external mutable object references.
      const claims = Object.freeze({
        repo: verified.repo, branch: verified.branch, baseCommit: verified.baseCommit,
        baseBlob: verified.baseBlob, candidateSha256: verified.candidateSha256,
        caller: verified.caller, policy: verified.policy, expiresAtMs: verified.expiresAtMs,
        nonce: verified.nonce
      });
      if (!text(claims.nonce) || !Number.isSafeInteger(claims.expiresAtMs) || claims.expiresAtMs <= 0 ||
          !hash(claims.candidateSha256) || claims.repo !== target.repo || claims.branch !== target.branch ||
          claims.baseCommit !== target.baseCommit || claims.baseBlob !== target.baseBlob ||
          claims.candidateSha256 !== candidateSha256 || claims.caller !== caller || claims.policy !== requiredPolicy) return null;
      if (await evaluatePolicy(Object.freeze({ claims, target, caller, candidateSha256, policy: requiredPolicy })) !== true) return null;
      const receiptSha256 = sha256(receipt);
      // Adapter performs the expiry check *inside* its atomic consume operation.
      if (await atomicConsume(Object.freeze({ nonce: claims.nonce, expiresAtMs: claims.expiresAtMs, receiptSha256 })) !== true) return null;
      return Object.freeze({ ...target, candidateSha256, caller, policy: requiredPolicy, nonce: claims.nonce, expiresAtMs: claims.expiresAtMs, receiptSha256 });
    } catch (_) {
      return null; // Any malformed input or adapter failure denies authorization.
    }
  };
}
module.exports = { createContract, sha256 };
