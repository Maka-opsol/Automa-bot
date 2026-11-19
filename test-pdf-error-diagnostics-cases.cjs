'use strict';
const assert = require('node:assert/strict');
const { pdfErrorSource } = require('./pdf-error-diagnostics');

module.exports = function registerPdfErrorDiagnosticsCases(test) {
const message = 'pdfjsLib is not defined';
const make = stack => ({ message, stack });
const page = 'https://app.example.test/private?session=TOP_SECRET';
const source = 'https://app.example.test/assets/view.js';

test('same-origin stack emits only a coarse category', () => {
  const out = pdfErrorSource(make(`ReferenceError: ${message}\n    at show (${source}:12:34)`), page);
  assert.equal(out, ' [pdf-source same-origin]');
});
test('external source is classified', () => {
  assert.equal(pdfErrorSource(make(`ReferenceError: ${message}\n at https://cdn.example.test/private/lib.js:1:2`), page), ' [pdf-source external-origin]');
});
test('page URL failure is unknown, not an exception', () => {
  assert.equal(pdfErrorSource(make(`ReferenceError: ${message}\n at ${source}:1:2`), ''), ' [pdf-source unknown-origin]');
});
test('no stack and malformed frames explicitly report unavailable', () => {
  for (const stack of [undefined, '', 'ReferenceError\n at anonymous', 'ReferenceError\n at https://[bad:4:5']) {
    assert.equal(pdfErrorSource(make(stack), page), ' [pdf-source unavailable]');
  }
});
test('query, fragment and userinfo never appear and do not affect identity', () => {
  const one = pdfErrorSource(make(`ReferenceError\n at https://user:PASS@app.example.test/assets/view.js?token=SECRET#FRAGMENT:12:34`), page);
  const two = pdfErrorSource(make(`ReferenceError\n at ${source}:12:34`), page);
  assert.equal(one, two);
  for (const secret of ['PASS', 'SECRET', 'FRAGMENT', 'TOP_SECRET', 'user']) assert.ok(!one.includes(secret));
});
test('different private paths and exact locations yield the same category', () => {
  const a = pdfErrorSource(make(`ReferenceError\n at ${source}:1:2`), page);
  const b = pdfErrorSource(make('ReferenceError\n at https://app.example.test/private/student-123.js:987:654'), page);
  assert.equal(a, ' [pdf-source same-origin]');
  assert.equal(a, b);
});
test('ignores unrelated errors without changing them', () => {
  assert.equal(pdfErrorSource({ message: 'other failure', stack: `at ${source}:1:2` }, page), '');
  assert.equal(pdfErrorSource(null, page), '');
});
test('throwing stack accessor is contained', () => {
  assert.equal(pdfErrorSource({ message, get stack() { throw new Error('boom'); } }, page), ' [pdf-source unavailable]');
});
test('first supported HTTP frame is chosen, not raw stack content', () => {
  const out = pdfErrorSource(make(`ReferenceError SECRET\n at native\n at ${source}:9:7\n at https://other.example.test/leak:4:5`), page);
  assert.equal(out, ' [pdf-source same-origin]');
});
test('malformed HTTP frames are skipped in favor of later valid frames', () => {
  const stack = `ReferenceError\n at https://[bad:4:5\n at ${source}:6:7`;
  assert.equal(pdfErrorSource(make(stack), page), ' [pdf-source same-origin]');
  const external = 'ReferenceError\n at https://[bad:4:5\n at https://other.test/private.js:8:9';
  assert.equal(pdfErrorSource(make(external), page), ' [pdf-source external-origin]');
});
test('source scanning is bounded to the first 40 frames and 16384 characters', () => {
  assert.equal(pdfErrorSource(make(`ReferenceError\n${' at native\n'.repeat(40)} at ${source}:1:2`), page), ' [pdf-source unavailable]');
  assert.equal(pdfErrorSource(make(`ReferenceError\n${'x'.repeat(16384)}\n at ${source}:1:2`), page), ' [pdf-source unavailable]');
});
test('unsupported schemes and nonnumeric positions are unavailable', () => {
  assert.equal(pdfErrorSource(make('ReferenceError\n at file:///secret/file.js:1:2'), page), ' [pdf-source unavailable]');
  assert.equal(pdfErrorSource(make(`ReferenceError\n at ${source}:one:two`), page), ' [pdf-source unavailable]');
});
};
