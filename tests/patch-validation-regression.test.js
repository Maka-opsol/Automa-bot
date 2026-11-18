'use strict';

// Isolated contract tests: the real bot, browser, database and network are never loaded.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'test-validation-suite.js'), 'utf8');

function load({ cli = false, sandboxResult } = {}) {
  const logs = [];
  const fakeProcess = { exitCode: 0, cwd: () => '/original', chdir: () => {} };
  const entry = { exports: {} };
  const mocks = {
    'fs': { existsSync: () => true },
    './logger': { log: (...args) => logs.push(args), logError: (...args) => logs.push(args) },
    './config': {},
    './sandbox-executor': { executePatchInSandbox: async () => sandboxResult },
    './state-machine': { stateMachine: { initialize: async () => {}, getCurrentState: () => 'login' }, STATES: { MATHU_LOGIN: 'login' } },
    './providers-registry': { getAvailableProviders: () => ['fake'] },
    './cache': { getCachedAction: () => ({ actionType: 'wait' }), setCachedAction: () => {} },
  };
  function fakeRequire(name) {
    if (!Object.hasOwn(mocks, name)) throw new Error(`Unexpected import: ${name}`);
    return mocks[name];
  }
  fakeRequire.main = cli ? entry : {};
  vm.runInNewContext(source, { require: fakeRequire, module: entry, process: fakeProcess }, { filename: 'test-validation-suite.js', timeout: 1000 });
  return { api: entry.exports, logs, fakeProcess };
}

for (const [label, result, expected] of [
  ['explicit safe', { safe: true }, true],
  ['unsafe object', { safe: false, error: 'rejected' }, false],
  ['missing safe', {}, false],
  ['truthy safe', { safe: 'yes' }, false],
  ['null', null, false],
  ['false', false, false],
]) {
  test(`sandbox rejects false positives: ${label}`, async () => {
    const { api } = load({ sandboxResult: result });
    const sandboxTest = api.TESTS.find(t => t.id === 'self_heal_sandbox');
    assert.equal(await sandboxTest.run(), expected);
  });
}

test('staged validation fails closed even if current critical checks would pass', async () => {
  const { api } = load();
  let calls = 0;
  api.validationSuite.runCritical = async () => { calls++; return [{ passed: true }]; };
  assert.equal(await api.validateBeforePromotion('/staged/path'), false);
  assert.equal(calls, 0);
});

test('missing staged path fails closed without checking current code', async () => {
  const { api } = load();
  api.validationSuite.runCritical = async () => { throw new Error('must not run'); };
  assert.equal(await api.validateBeforePromotion('/missing/staged/path'), false);
});

for (const [label, results, expected] of [
  ['passing', [{ passed: true }, { passed: true }], true],
  ['empty', [], false],
  ['failed', [{ passed: false }], false],
  ['truthy non-boolean', [{ passed: 'yes' }], false],
  ['missing', null, false],
]) {
  test(`critical gate handles ${label} results`, async () => {
    const { api } = load();
    api.validationSuite.runCritical = async () => results;
    assert.equal(await api.validateBeforePromotion(), expected);
  });
}

test('CLI executes the suite and sets a nonzero status when a test fails', async () => {
  const { fakeProcess, logs } = load({ cli: true, sandboxResult: { safe: false } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fakeProcess.exitCode, 1);
  assert.ok(logs.some(args => String(args[0]).includes('Running validation suite')));
  assert.ok(logs.some(args => String(args[0]).includes('self_heal_sandbox')));
});

test('importing the suite does not execute it', async () => {
  const { logs } = load();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(logs.length, 0);
});
