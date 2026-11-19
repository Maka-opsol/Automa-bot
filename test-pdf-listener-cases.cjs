'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { pdfErrorSource } = require('./pdf-error-diagnostics');
const source = fs.readFileSync(require.resolve('./parallel-coordinator.ts'), 'utf8');

function listener(url) {
  const match = source.match(/    page\.on\('pageerror', \(err: Error\) => \{[\s\S]*?\n    \}\);/);
  assert.ok(match, 'worker pageerror listener not found');
  let callback;
  const logs = [];
  const page = { on(event, fn) { assert.equal(event, 'pageerror'); callback = fn; }, url };
  vm.runInNewContext(match[0].replace('(err: Error)', '(err)'), {
    page, id: 2, pdfErrorSource, log: (...args) => logs.push(args),
  });
  return { callback, logs };
}
module.exports = function registerPdfListenerCases(test) {
test('worker error listener retains the error and emits redacted PDF source', () => {
  const { callback, logs } = listener(() => 'https://app.example/?token=PRIVATE');
  callback({ message: 'pdfjsLib is not defined', stack: 'ReferenceError\n at https://app.example/file.js?x=SECRET:10:20' });
  assert.equal(logs[0][0], '[WORKER-2] [page-error] pdfjsLib is not defined [pdf-source same-origin]');
  assert.deepEqual(logs[0].slice(1), ['ERROR', 'parallel']);
  assert.ok(!logs[0][0].includes('SECRET'));
});
test('worker retains unrelated error and never queries page URL', () => {
  let urlCalls = 0;
  const { callback, logs } = listener(() => { urlCalls++; throw new Error('should not call'); });
  callback({ message: 'other failure' });
  assert.equal(urlCalls, 0);
  assert.deepEqual(logs[0], ['[WORKER-2] [page-error] other failure', 'ERROR', 'parallel']);
});
test('page URL failure preserves error and logs unknown origin', () => {
  const { callback, logs } = listener(() => { throw new Error('closed'); });
  callback({ message: 'pdfjsLib is not defined', stack: 'ReferenceError\n at https://example.test/a.js:1:2' });
  assert.match(logs[0][0], /pdfjsLib is not defined \[pdf-source unknown-origin/);
});
test('render reporting describes observations rather than asserting readiness', () => {
  assert.match(source, /Nonzero canvas detected after .*render readiness unverified/);
  assert.match(source, /No nonzero canvas detected within 60s; render status unknown — proceeding anyway/);
  assert.match(source, /const maxWaitMs = 60000/);
  assert.match(source, /return canvas\.width > 0 && canvas\.height > 0/);
});
};
