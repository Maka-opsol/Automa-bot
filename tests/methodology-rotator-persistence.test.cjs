'use strict';

// Run: node --import tsx --test tests/methodology-rotator-persistence.test.cjs
// SQLite is in memory; no real bot, dashboard, service, or academic content is used.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');
const rotator = require('../methodology-rotator.ts');

function setup(t) {
  rotator._resetForTest();
  const db = new Database(':memory:');
  db.exec('CREATE TABLE calibration (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)');
  // Read the real production SQL rather than maintaining a different test statement.
  const source = fs.readFileSync(path.join(__dirname, '..', 'database.ts'), 'utf8');
  const match = source.match(/upsertCalibration\s*=\s*db\.prepare\('([^']+)'\)/);
  assert.ok(match, 'production calibration statement must be found');
  const insert = db.prepare(match[1]);
  const logs = [];
  rotator._injectDependencies({
    database: {
      upsertCalibration: insert,
      selectCalibration: db.prepare('SELECT value FROM calibration WHERE key = ?'),
    },
    logger: { log: (message) => logs.push(message) },
  });
  t.after(() => { rotator._resetForTest(); rotator._injectDependencies({}); db.close(); });
  return { db, logs };
}

function row(db, key) {
  const result = db.prepare('SELECT value, updated_at FROM calibration WHERE key = ?').get(key);
  assert.ok(result, `expected calibration row ${key}`);
  assert.ok(Number.isInteger(result.updated_at) && result.updated_at > 0, 'updated_at must be a timestamp');
  return { value: JSON.parse(result.value), updatedAt: result.updated_at };
}

test('state writes and reloads with the real three-parameter SQL', (t) => {
  const { db, logs } = setup(t);
  const before = Date.now();
  rotator.onFailure(1);
  const saved = row(db, rotator.STATE_KEY);
  assert.equal(saved.value.lastFailureCount, 1);
  assert.ok(saved.updatedAt >= before && saved.updatedAt <= Date.now());
  assert.ok(!logs.some((s) => s.includes('Failed to persist state')));
  rotator._resetForTest();
  rotator._loadState();
  // A subsequent save exposes the state after simulated restart.
  rotator._saveState();
  assert.equal(row(db, rotator.STATE_KEY).value.lastFailureCount, 1);
  rotator.onFailure(2);
  assert.equal(row(db, rotator.STATE_KEY).value.lastFailureCount, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM calibration WHERE key = ?').get(rotator.STATE_KEY).n, 1);
});

test('history persists attempt and success updates', (t) => {
  const { db } = setup(t);
  const change = rotator.onFailure(3);
  assert.ok(change && change.change);
  const id = change.change.id;
  assert.deepEqual(row(db, rotator.HISTORY_KEY).value[id], { attempts: 1, successes: 0 });
  rotator.onSuccess();
  assert.deepEqual(row(db, rotator.HISTORY_KEY).value[id], { attempts: 1, successes: 1 });
});

test('unhealthy provider persists and reloads after reset', (t) => {
  const { db } = setup(t);
  rotator.markProviderUnhealthy('example-provider');
  const saved = row(db, 'methodology_rotator_unhealthy_providers');
  assert.equal(saved.value[0][0], 'example-provider');
  assert.ok(saved.value[0][1] > 0);
  rotator._resetForTest();
  assert.equal(rotator.isProviderHealthy('example-provider'), true);
  rotator.start();
  assert.equal(rotator.isProviderHealthy('example-provider'), false);
  rotator.stop();
});
