'use strict';

// Limited tests of the CURRENT validator's two critical checks with fake dependencies.
// No real sandbox, staged code, bot, database, browser or network is executed.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'test-validation-suite.js'), 'utf8');

function load() {
  const entry = { exports: {} };
  const logs = [];
  let cwd = '/current';
  const changes = [];
  const mocks = {
    fs: { existsSync: p => p === '/staged' },
    './logger': { log: (...args) => logs.push(args), logError: (...args) => logs.push(args) },
    './config': {},
  };
  const fakeProcess = {
    cwd: () => cwd,
    chdir: dir => { changes.push(dir); cwd = dir; },
  };
  function fakeRequire(name) {
    if (!Object.hasOwn(mocks, name)) throw new Error(`Unexpected import: ${name}`);
    return mocks[name];
  }
  fakeRequire.main = {};
  vm.runInNewContext(source, { require: fakeRequire, module: entry, process: fakeProcess },
    { filename: 'test-validation-suite.js', timeout: 1000 });
  return { api: entry.exports, logs, changes, fakeProcess };
}

function dependencies({ url = 'https://mathu.co.za/assignments', db = 'ok', authError } = {}) {
  const calls = [];
  return {
    calls,
    deps: {
      browser: {
        launchBrowser: async () => { calls.push('launch'); return { url: () => url }; },
        closeBrowser: async () => { calls.push('close'); },
      },
      auth: { authenticate: async () => { calls.push('authenticate'); if (authError) throw Error('auth failed'); } },
      database: { db: { pragma: query => { calls.push(query); return [{ integrity_check: db }]; } } },
    },
  };
}

function summarize(results) {
  return Array.from(results, r => [r.id, r.passed]);
}

test('critical checks pass with an authenticated URL and healthy fake database', async () => {
  const { api } = load();
  const { deps, calls } = dependencies();
  api._injectDependencies(deps);
  const results = await api.validationSuite.runCritical();
  assert.deepEqual(summarize(results), [['auth_flow', true], ['database_integrity', true]]);
  assert.deepEqual(calls, ['launch', 'authenticate', 'close', 'integrity_check']);
  assert.equal(await api.validateBeforePromotion(), true);
});

test('wrong URL fails auth and still closes the fake browser', async () => {
  const { api } = load();
  const { deps, calls } = dependencies({ url: 'https://example.org/login' });
  api._injectDependencies(deps);
  assert.deepEqual(summarize(await api.validationSuite.runCritical()), [['auth_flow', false], ['database_integrity', true]]);
  assert.ok(calls.includes('close'));
  assert.equal(await api.validateBeforePromotion(), false);
});

test('authentication exception fails the critical check and closes the fake browser', async () => {
  const { api } = load();
  const { deps, calls } = dependencies({ authError: true });
  api._injectDependencies(deps);
  const results = await api.validationSuite.runCritical();
  assert.deepEqual(summarize(results), [['auth_flow', false], ['database_integrity', true]]);
  assert.match(results[0].error, /auth failed/);
  assert.ok(calls.includes('close'));
  assert.equal(await api.validateBeforePromotion(), false);
});

test('failed integrity check blocks the current-code gate', async () => {
  const { api } = load();
  const { deps } = dependencies({ db: 'corrupt' });
  api._injectDependencies(deps);
  assert.deepEqual(summarize(await api.validationSuite.runCritical()), [['auth_flow', true], ['database_integrity', false]]);
  assert.equal(await api.validateBeforePromotion(), false);
});

test('missing dependencies fail rather than passing the critical checks', async () => {
  const { api } = load();
  assert.deepEqual(summarize(await api.validationSuite.runCritical()), [['auth_flow', false], ['database_integrity', false]]);
  assert.equal(await api.validateBeforePromotion(), false);
});

test('staging-path characterization: changing cwd still uses injected current dependencies', async () => {
  const { api, changes, fakeProcess } = load();
  const { deps, calls } = dependencies();
  api._injectDependencies(deps);
  assert.equal(await api.validateBeforePromotion('/staged'), true);
  assert.deepEqual(changes, ['/staged', '/current']);
  assert.equal(fakeProcess.cwd(), '/current');
  assert.deepEqual(calls, ['launch', 'authenticate', 'close', 'integrity_check']);
  // This deliberately does NOT claim that any staged code was loaded or tested.
});

test('a failed check restores cwd after a staging path', async () => {
  const { api, changes, fakeProcess } = load();
  const { deps } = dependencies({ db: 'corrupt' });
  api._injectDependencies(deps);
  assert.equal(await api.validateBeforePromotion('/staged'), false);
  assert.deepEqual(changes, ['/staged', '/current']);
  assert.equal(fakeProcess.cwd(), '/current');
});

test('importing the module does not execute the suite', () => {
  const { logs } = load();
  assert.equal(logs.length, 0);
});
