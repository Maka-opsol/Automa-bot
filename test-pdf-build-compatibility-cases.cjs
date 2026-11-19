'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = __dirname;
const coordinator = fs.readFileSync(path.join(root, 'parallel-coordinator.ts'), 'utf8');
const importLine = "import { pdfErrorSource } from './pdf-error-diagnostics';";

// Run the actual build script only in a disposable fixture. It contains no bot.
function runFixture(t, esbuildShim, includeHelper = true) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mathu-pdf-build-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.copyFileSync(path.join(root, 'build.js'), path.join(dir, 'build.js'));
  if (includeHelper) fs.copyFileSync(path.join(root, 'pdf-error-diagnostics.js'), path.join(dir, 'pdf-error-diagnostics.js'));
  assert.ok(coordinator.includes(importLine), 'fixture import must match the coordinator');
  fs.writeFileSync(path.join(dir, 'fixture.ts'), `${importLine}\nexport const classify = pdfErrorSource;\n`);
  fs.mkdirSync(path.join(dir, 'node_modules', 'esbuild'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'node_modules', 'esbuild', 'index.js'), esbuildShim);
  const result = spawnSync(process.execPath, ['build.js'], { cwd: dir, encoding: 'utf8' });
  return { dir, result };
}

// The stub exercises build.js file selection, copy, failure status and module
// resolution; it does not claim to test real esbuild's TypeScript compilation.
const fakeEsbuild = `exports.transformSync = (src, options) => {
  if (options.loader !== 'ts' || options.format !== 'cjs' || options.target !== 'node20') throw Error('unexpected options');
  const expected = ${JSON.stringify(importLine)} + '\\nexport const classify = pdfErrorSource;\\n';
  if (src !== expected) throw Error('unexpected fixture');
  return { code: "const { pdfErrorSource } = require('./pdf-error-diagnostics');\\nexports.classify = pdfErrorSource;\\n" };
};`;

function verifyBuiltModule(dir) {
  const built = require(path.join(dir, 'dist', 'fixture.js'));
  assert.equal(built.classify({ message: 'pdfjsLib is not defined', stack: 'ReferenceError\n at https://a.test/private.js:2:3' }, 'https://a.test/'), ' [pdf-source same-origin]');
  assert.equal(fs.readFileSync(path.join(dir, 'dist', 'pdf-error-diagnostics.js'), 'utf8'), fs.readFileSync(path.join(root, 'pdf-error-diagnostics.js'), 'utf8'));
}

module.exports = function registerPdfBuildCases(test) {
test('build packages the helper alongside compiled imports in an isolated fixture', t => {
  const { dir, result } = runFixture(t, fakeEsbuild);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Compiled: 1 files, 0 failures/);
  verifyBuiltModule(dir);
});

test('build fails rather than silently omitting a missing helper', t => {
  const { result } = runFixture(t, fakeEsbuild, false);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FAIL: pdf-error-diagnostics\.js/);
});

let realEsbuild;
try { realEsbuild = require.resolve('esbuild'); } catch {}
test('real esbuild compiles the fixture and resolves its packaged helper', { skip: !realEsbuild && 'esbuild is not installed' }, t => {
  const { dir, result } = runFixture(t, `module.exports = require(${JSON.stringify(realEsbuild)});`);
  assert.equal(result.status, 0, result.stderr);
  verifyBuiltModule(dir);
});
};
