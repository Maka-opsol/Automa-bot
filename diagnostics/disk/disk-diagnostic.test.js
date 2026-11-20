'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('./disk-diagnostic');

async function exercise(args, statfs) {
  let out = '';
  let err = '';
  const code = await run(args, {
    statfs,
    stdout: { write: s => { out += s; } },
    stderr: { write: s => { err += s; } }
  });
  return { code, out, err };
}

function stats(bsize, blocks, bavail) { return { bsize, blocks, bavail }; }

test('default path, exact bytes and bigint option', async () => {
  let called = 0;
  const r = await exercise([], async (path, options) => {
    called++;
    assert.equal(path, '.');
    assert.deepEqual(options, { bigint: true });
    return stats(4096n, 100n, 20n);
  });
  assert.equal(called, 1);
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { estimated: true, unit: 'bsize', total_bytes: '409600', available_bytes: '81920' });
  assert.equal(r.err, '');
});

test('configured path, huge integers and reserved blocks', async () => {
  const r = await exercise(['--path', '/runner/work'], async path => {
    assert.equal(path, '/runner/work');
    return { ...stats(4096n, 9007199254740993n, 9007199254740000n), bfree: 9007199254740100n };
  });
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), {
    estimated: true, unit: 'bsize', total_bytes: '36893488147419107328', available_bytes: '36893488147415040000'
  });
});

test('zero available space is reported successfully', async () => {
  const r = await exercise([], async () => stats(4096n, 10n, 0n));
  assert.equal(r.code, 0);
  assert.equal(JSON.parse(r.out).available_bytes, '0');
});

test('zero total blocks is accepted', async () => {
  const r = await exercise([], async () => stats(1n, 0n, 0n));
  assert.equal(r.code, 0);
  assert.deepEqual(JSON.parse(r.out), { estimated: true, unit: 'bsize', total_bytes: '0', available_bytes: '0' });
});

test('help does not call statfs', async () => {
  const r = await exercise(['--help'], () => { throw new Error('must not be called'); });
  assert.equal(r.code, 0);
  assert.match(r.out, /^Usage:/);
  assert.equal(r.err, '');
});

test('invalid arguments fail without touching filesystem', async () => {
  for (const args of [['--path'], ['--path', ''], ['unexpected'], ['--help', 'extra'], ['--path', '.', 'extra']]) {
    const r = await exercise(args, () => { throw new Error('must not be called'); });
    assert.equal(r.code, 2);
    assert.equal(r.out, '');
    assert.match(r.err, /^Usage:/);
  }
});

test('unsupported API is reported', async () => {
  const r = await exercise([], undefined);
  assert.equal(r.code, 1);
  assert.equal(r.out, '');
  assert.match(r.err, /UNSUPPORTED/);
});

test('known OS errors are useful and do not echo secret path or error message', async () => {
  for (const code of ['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM', 'ENOSYS', 'ENOTSUP', 'EIO']) {
    const r = await exercise(['--path', '/secret-token'], async () => {
      throw Object.assign(new Error('sensitive-message /secret-token'), { code });
    });
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.match(r.err, new RegExp(`\\(${code}\\)`));
    assert.doesNotMatch(r.err, /secret-token|sensitive-message/);
  }
});

test('unknown and malicious error codes are sanitized', async () => {
  for (const code of ['CUSTOM_ERROR', 'SECRET/path', 'SECRET\nleak', undefined]) {
    const r = await exercise([], async () => { throw Object.assign(new Error('secret'), { code }); });
    assert.equal(r.code, 1);
    assert.match(r.err, /\(UNKNOWN\): Unable to read filesystem statistics/);
    assert.doesNotMatch(r.err, /CUSTOM_ERROR|SECRET|secret/);
  }
});

test('invalid stats fail closed', async () => {
  for (const value of [null, {}, stats(0n, 1n, 1n), stats(-1n, 1n, 1n), stats(1n, -1n, 1n), stats(1n, 1n, -1n), stats(1, 1n, 1n), stats(1n, 1, 1n), stats(1n, 1n, 1)]) {
    const r = await exercise([], async () => value);
    assert.equal(r.code, 1);
    assert.equal(r.out, '');
    assert.match(r.err, /INVALID_STATS/);
  }
});


test('uses fragment size when available', async () => {
 const r = await exercise([], async () => ({ bsize:4096n, frsize:1024n, blocks:10n, bavail:3n }));
 assert.deepEqual(JSON.parse(r.out), {estimated:false, unit:'frsize', total_bytes:'10240', available_bytes:'3072'});
});
test('rejects inconsistent available blocks and invalid fragment sizes', async () => {
 for (const value of [{bsize:1n,blocks:0n,bavail:1n},{bsize:1n,frsize:0n,blocks:1n,bavail:1n}]) {
   const r=await exercise([],async()=>value); assert.equal(r.code,1); assert.match(r.err,/INVALID_STATS/);
 }
});
test('CLI returns sanitized error on a nonexistent path', () => {
 const {spawnSync}=require('node:child_process');
 const r=spawnSync(process.execPath,[require.resolve('./disk-diagnostic'),'--path','/no-such-disk-test-129ab'],{encoding:'utf8'});
 assert.equal(r.status,1); assert.match(r.stderr,/ENOENT/); assert.doesNotMatch(r.stderr,/no-such-disk-test/);
});
