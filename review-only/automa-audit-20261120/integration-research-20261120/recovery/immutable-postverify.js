'use strict';
// Offline model, not a GitHub adapter. See README for trust and completeness contract.
const crypto = require('node:crypto');
const { TextDecoder } = require('node:util');
const OID = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const hash = (algorithm, bytes) => crypto.createHash(algorithm).update(bytes).digest('hex');
function gitHash(type, data) {
  return hash('sha1', Buffer.concat([Buffer.from(`${type} ${data.length}\0`, 'ascii'), data]));
}
function validPath(path) {
  return typeof path === 'string' && /^[A-Za-z0-9_./-]+$/.test(path) &&
    path.split('/').every(p => p && p !== '.' && p !== '..' && !p.startsWith('.'));
}
function fail() { throw new Error('incomplete or invalid immutable evidence'); }

// Only accepts complete raw Git objects pinned by their SHA-1, never a branch or HEAD.
// reader.getObject(repository, oid) response contract is described in README.
async function verifyImmutableCommit(input, reader) {
  try {
    const { repository, filename, commit, base, blob, mode, content, contentDigest } = input || {};
    if (repository !== 'Maka-opsol/Automa-bot' || !validPath(filename) ||
        !OID.test(commit || '') || !OID.test(base || '') || !OID.test(blob || '') || commit === base || mode !== '100644' ||
        typeof content !== 'string' || !SHA256.test(contentDigest || '') ||
        !reader || typeof reader.getObject !== 'function') fail();
    const bytes = Buffer.from(content, 'utf8');
    if (utf8.decode(bytes) !== content || hash('sha256', bytes) !== contentDigest) fail();
    const cache = new Map();
    let reads = 0;
    async function object(oid, type) {
      if (!OID.test(oid)) fail();
      if (cache.has(oid)) {
        const o = cache.get(oid);
        if (o.type !== type) fail();
        return o.data;
      }
      if (++reads > 50000) fail();
      const r = await reader.getObject(repository, oid);
      if (!r || r.status !== 200 || r.repository !== repository || r.oid !== oid || r.type !== type ||
          r.complete !== true || r.truncated !== false || r.hasMore !== false || !Buffer.isBuffer(r.data) ||
          r.data.length > 32 * 1024 * 1024 || gitHash(type, r.data) !== oid) fail();
      // Detach from mutable provider buffers.
      const data = Buffer.from(r.data);
      cache.set(oid, {type, data});
      return data;
    }
    async function commitInfo(oid) {
      const raw = await object(oid, 'commit');
      const split = raw.indexOf(Buffer.from('\n\n'));
      if (split < 0) fail();
      const header = utf8.decode(raw.subarray(0, split));
      if (header.includes('\0') || header.includes('\r')) fail();
      const lines = header.split('\n');
      let tree = null; const parents = [];
      for (const line of lines) {
        if (line.startsWith('tree ')) {
          const v = line.slice(5); if (tree !== null || !OID.test(v)) fail(); tree = v;
        } else if (line.startsWith('parent ')) {
          const v = line.slice(7); if (!OID.test(v)) fail(); parents.push(v);
        } else if (!line || (!line.startsWith(' ') && !/^[a-zA-Z0-9-]+ /.test(line))) fail();
      }
      if (!tree) fail();
      return {tree, parents};
    }
    const [before, after] = await Promise.all([commitInfo(base), commitInfo(commit)]);
    if (after.parents.length !== 1 || after.parents[0] !== base) fail();
    let entryCount = 0;
    async function treeMap(root) {
      const out = new Map();
      async function walk(oid, prefix, depth, active) {
        if (depth > 128 || active.has(oid)) fail();
        const next = new Set(active); next.add(oid);
        const raw = await object(oid, 'tree');
        let i = 0, last = null; const names = new Set();
        while (i < raw.length) {
          if (++entryCount > 100000) fail();
          const space = raw.indexOf(0x20, i), nul = raw.indexOf(0, space + 1);
          if (space <= i || nul <= space + 1 || nul + 21 > raw.length) fail();
          const m = raw.subarray(i, space).toString('ascii');
          if (!['40000','100644','100755','120000','160000'].includes(m) ||
              !raw.subarray(i, space).equals(Buffer.from(m, 'ascii'))) fail();
          const nameBytes = raw.subarray(space + 1, nul);
          const name = utf8.decode(nameBytes);
          if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\0') || names.has(name)) fail();
          names.add(name);
          // Git sorts directory names as though they have a trailing slash.
          const sortKey = Buffer.concat([nameBytes, m === '40000' ? Buffer.from('/') : Buffer.alloc(0)]);
          if (last && Buffer.compare(last, sortKey) >= 0) fail();
          last = sortKey;
          const child = raw.subarray(nul + 1, nul + 21).toString('hex');
          if (/^0+$/.test(child)) fail();
          const path = prefix ? prefix + '/' + name : name;
          if (out.has(path)) fail();
          // Include directory existence (even empty trees); ignore directory OID in
          // the delta since the intended descendant edit changes ancestor OIDs.
          out.set(path, {mode:m, oid:child});
          if (m === '40000') await walk(child, path, depth + 1, next);
          i = nul + 21;
        }
      }
      await walk(root, '', 0, new Set());
      return out;
    }
    const oldFiles = await treeMap(before.tree), newFiles = await treeMap(after.tree);
    const oldTarget = oldFiles.get(filename), newTarget = newFiles.get(filename);
    if (!oldTarget || !newTarget || oldTarget.mode !== mode || newTarget.mode !== mode || oldTarget.oid !== blob) fail();
    const paths = new Set([...oldFiles.keys(), ...newFiles.keys()]);
    let changes = 0;
    for (const path of paths) {
      const a = oldFiles.get(path), b = newFiles.get(path);
      if (!a || !b || a.mode !== b.mode || (a.mode !== '40000' && a.oid !== b.oid)) {
        if (path !== filename) fail();
        changes++;
      }
    }
    if (changes !== 1) fail();
    await object(oldTarget.oid, 'blob');
    const actual = await object(newTarget.oid, 'blob');
    if (!actual.equals(bytes) || hash('sha256', actual) !== contentDigest) fail();
    return true;
  } catch (_) { return false; }
}
module.exports = { verifyImmutableCommit };
