'use strict';
// Offline tests of the actual coordinator methods, with browser/database mocks.
// Extraction removes only the TypeScript annotations on these specific methods.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const source = fs.readFileSync(__dirname + '/parallel-coordinator.ts', 'utf8');
function method(name) {
  const start = source.indexOf(`  private async ${name}(`);
  const end = source.indexOf('\n  /**', start);
  assert.ok(start >= 0 && end > start, `method ${name} exists`);
  return source.slice(start, end)
    .replace('private async ', 'async ')
    .replace(/: Promise<(?:void|boolean)>/g, '')
    .replace(/: (?:WorkerState|string|number|any)(?=[,)])/g, '')
    .replace(/catch \(err: any\)/g, 'catch (err)');
}
function create({ card, clickError, evaluateError, dbError, completion = true }) {
  const queries = [], clicks = [], sleeps = [], steps = [], logs = [];
  const db = { prepare(sql) { return { run(...args) { queries.push([sql, ...args]); if (dbError) throw new Error('mock database failure'); } }; } };
  const page = {
    goto: async () => { steps.push('goto'); },
    evaluate: async () => { if (evaluateError) throw new Error('mock evaluate failure'); return card; },
    mouse: { click: async (...args) => { clicks.push(args); if (clickError) throw new Error('mock click failed'); } }
  };
  const worker = { id: 1, page, status: 'idle', currentModule: null, modulesCompleted: 0, errors: 0, lastActivity: 0 };
  const deps = { database: { db } };
  const build = new Function('_deps', 'getLog', 'getCONFIG', `return class {
    ${method('_runWorkerLoop')}
    ${method('_findAndClickModuleViaVision')}
    ${method('_findAndClickModuleCard')}
    ${method('_markModuleDone')}
    ${method('_markModuleFailed')}
  }`);
  const Coordinator = build(deps, () => (...a) => logs.push(a), () => ({ APP_URL: 'https://example.invalid' }));
  const c = new Coordinator();
  c.workers = new Map([[1, worker]]); c.running = true;
  c._ensureLoggedIn = async () => true;
  c._navigateAssignments = async () => { await page.goto(); };  // stubbed: loop calls this before the render gate; mimics the real method's page.goto so steps=['goto']
  c._waitForFlutterRender = async () => true;        // render succeeded → proceed to claim/click (exercises click-safety, not render-failure)
  c._claimNextModule = async () => ({ name: 'Mock lesson', type: 'exercise' });
  c._detectModuleType = async () => { steps.push('detect'); return 'exercise'; };
  c._completeModule = async () => { steps.push('complete'); return completion; };
  c._sleep = async ms => { sleeps.push(ms); if (ms === 30000) c.running = false; };
  // Successful paths stop after their existing return-to-assignments navigation.
  const oldGoto = page.goto; page.goto = async (...args) => { await oldGoto(...args); if (steps.filter(s => s === 'goto').length === 2) c.running = false; };
  return { c, worker, queries, clicks, sleeps, steps, logs };
}
for (const scenario of [
  { name: 'card absent', card: { found: false } },
  { name: 'mouse click rejects', card: { found: true, x: 10, y: 20 }, clickError: true },
  { name: 'card lookup rejects', evaluateError: true },
]) {
  test(`${scenario.name} releases claim and never reports completion`, async () => {
    const s = create(scenario); await s.c._runWorkerLoop(1);
    assert.deepEqual(s.queries, [['DELETE FROM completed_modules WHERE name = ? AND completed_at = 0', 'Mock lesson']]);
    assert.equal(s.worker.modulesCompleted, 0); assert.equal(s.worker.errors, 1);
    assert.equal(s.worker.currentModule, null); assert.equal(s.worker.status, 'idle'); assert.ok(s.worker.lastActivity > 0);
    assert.deepEqual(s.sleeps, [30000]); assert.deepEqual(s.steps, ['goto']);
    assert.equal(s.clicks.length, scenario.clickError ? 1 : 0);
  });
}
test('failed release does not mark done or spin without delay', async () => {
  const s = create({ card: { found: false }, dbError: true }); await s.c._runWorkerLoop(1);
  assert.deepEqual(s.queries, [['DELETE FROM completed_modules WHERE name = ? AND completed_at = 0', 'Mock lesson']]);
  assert.equal(s.worker.modulesCompleted, 0); assert.equal(s.worker.errors, 1);
  assert.equal(s.worker.currentModule, null); assert.deepEqual(s.sleeps, [30000]);
});
test('successful click and completed module still mark done', async () => {
  const s = create({ card: { found: true, x: 10, y: 20 }, completion: true }); await s.c._runWorkerLoop(1);
  assert.equal(s.queries.length, 1); assert.equal(s.queries[0][0], 'UPDATE completed_modules SET completed_at = ? WHERE name = ?');
  assert.ok(s.queries[0][1] > 0); assert.equal(s.queries[0][2], 'Mock lesson');
  assert.deepEqual(s.clicks, [[10,20]]); assert.deepEqual(s.steps, ['goto','detect','complete','goto']);
  assert.equal(s.worker.modulesCompleted, 1); assert.equal(s.worker.errors, 0); assert.equal(s.worker.currentModule, null);
});
test('successful click but module failure retains existing retry release', async () => {
  const s = create({ card: { found: true, x: 10, y: 20 }, completion: false }); await s.c._runWorkerLoop(1);
  assert.deepEqual(s.queries, [['DELETE FROM completed_modules WHERE name = ? AND completed_at = 0', 'Mock lesson']]);
  assert.deepEqual(s.steps, ['goto','detect','complete','goto']);
  assert.equal(s.worker.modulesCompleted, 0); assert.equal(s.worker.errors, 1); assert.equal(s.worker.currentModule, null);
});
