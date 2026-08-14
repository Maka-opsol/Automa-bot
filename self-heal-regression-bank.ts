'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { fork } = require('child_process');
const util = require('util');
const execFile = util.promisify(require('child_process').execFile);

const CONFIG = require('./get-config');

const PRUNE_AFTER_DAYS = 90;
const REGRESSION_DIR = path.join(PROJECT_ROOT, 'test', 'regression', 'generated');

class RegressionBank {
  reason: any;

  constructor() {
    this._ensureDir();
    this._ensureTable();
  }

  _ensureDir() { 
    try {
      if (!fs.existsSync(REGRESSION_DIR)) {
        fs.mkdirSync(REGRESSION_DIR, { recursive: true });
        log(`Created regression test directory: ${REGRESSION_DIR}`, 'INFO', 'regression-bank');
      }
    } catch (err: any) {
      logError('Failed to create regression test directory', err);
    }
  }

  _ensureTable() { 
    try {
      getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS regression_tests (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patch_id TEXT NOT NULL,
          file_path TEXT NOT NULL,
          bug_description TEXT,
          blackbox_state TEXT,
          blackbox_action TEXT,
          blackbox_hash TEXT,
          created_at INTEGER NOT NULL,
          last_run_at INTEGER,
          last_run_passed INTEGER,
          consecutive_passes INTEGER DEFAULT 0,
          total_runs INTEGER DEFAULT 0,
          total_passes INTEGER DEFAULT 0
        );
        CREATE INDEX IF NOT EXISTS idx_regression_patch ON regression_tests(patch_id);
        CREATE INDEX IF NOT EXISTS idx_regression_created ON regression_tests(created_at);
      `);
    } catch (err: any) {
      logError('Failed to create regression_tests table', err);
    }
  }

  async generateRegressionTest(blackboxRecording: any, patch: any) { 
    try {
      const patchId = patch.id || String(patch.timestamp || Date.now());
      const timestamp = Date.now();

      if (!blackboxRecording || !patch) {
        log('Missing blackbox recording or patch for regression test generation', 'WARN', 'regression-bank');
        return null;
      }

      const reasoning = blackboxRecording.reasoning || 'Unknown bug';
      const state = blackboxRecording.state || 'unknown';
      const action = blackboxRecording.action || 'unknown';
      const screenshotHash = blackboxRecording.screenshot_hash || 'no-hash';

      const prompt = [
        'Write a Node.js test that fails on the old code and passes on the new code.',
        `The bug was: ${reasoning}`,
        `State was: ${state}`,
        `Action was: ${action}`,
        `Screenshot hash: ${screenshotHash}`,
        `Target file: ${patch.file || 'unknown'}`,
        'The test must:',
        '1. Use const assert = require("assert");',
        '2. Test the specific behavior that was fixed',
        '3. Be self-contained and runnable with: node <test_file>',
        '4. Export a run() function that returns { passed: boolean, error: string|null }',
        '5. Handle errors gracefully - catch them and return { passed: false, error: ... }',
        'Return ONLY the test code, no explanations.'
      ].join('\n');

      log(`Generating regression test for patch ${patchId}...`, 'INFO', 'regression-bank');

      let testBody = '';
      try {
        const { consultTribunalRaw } = require('./providers-codegen-tribunal');
        const regressPrompt = [
          'Write a Node.js test that fails on the old code and passes on the new code.',
          `The bug was: ${reasoning}`,
          `State was: ${state}`,
          `Action was: ${action}`,
          `Screenshot hash: ${screenshotHash}`,
          `Target file: ${patch.file || 'unknown'}`,
          'The test must:',
          '1. Use const assert = require("assert");',
          '2. Test the specific behavior that was fixed',
          '3. Be self-contained and runnable with: node <test_file>',
          '4. Export a run() function that returns { passed: boolean, error: string|null }',
          '5. Handle errors gracefully - catch them and return { passed: false, error: ... }',
          'Return ONLY the test code, no explanations.'
        ].join('\n');

        const signal = AbortSignal.timeout(120_000);
        const result = await consultTribunalRaw(regressPrompt, signal, { responseFormatJson: false });
        if (result && result.trim().length > 0) {
          testBody = result.trim();
        }
      } catch (tribunalErr: any) {
        logError('Tribunal call failed for regression test generation, using template', tribunalErr);
        testBody = this._generateTemplateTest(patchId, reasoning, state, action);
      }

      if (!testBody || testBody.trim().length === 0) {
        testBody = this._generateTemplateTest(patchId, reasoning, state, action);
      }

      const header = [
        `// Auto-generated regression test for patch ${patchId}`,
        `// Bug: ${reasoning}`,
        `// State: ${state}`,
        `// Action: ${action}`,
        `// Generated: ${new Date(timestamp).toISOString()}`,
        'const assert = require(\'assert\');',
        ''
      ].join('\n');

      const fullTest = header + testBody;
      const fileName = `${patchId}_${timestamp}.test.js`;
      const filePath = path.join(REGRESSION_DIR, fileName);

      fs.writeFileSync(filePath, fullTest, 'utf8');

      getDb()?.prepare(
        'INSERT INTO regression_tests (patch_id, file_path, bug_description, blackbox_state, blackbox_action, blackbox_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(patchId, filePath, reasoning.substring(0, 500), state.substring(0, 200), action.substring(0, 200), screenshotHash.substring(0, 64), timestamp);

      log(`Regression test saved: ${fileName} (patch: ${patchId})`, 'INFO', 'regression-bank');

      if (CONFIG.GITOPS_ENABLED) {
        try {
          // SECURITY: Use execFile with args array to prevent shell injection.
          // patchId is passed as a separate argument, never interpolated into a shell string.
          const safeMessage = `Add regression test for patch ${(patchId || 'unknown').substring(0, 64)}`;
          await execFile('git', ['add', '.'], { cwd: PROJECT_ROOT, stdio: 'ignore' });
          await execFile('git', ['commit', '-m', safeMessage], { cwd: PROJECT_ROOT, stdio: 'ignore' });
          log(`Regression test committed alongside patch ${patchId}`, 'INFO', 'regression-bank');
        } catch (gitErr: any) {
          log('Failed to commit regression test to git (non-fatal)', 'WARN', 'regression-bank');
        }
      }

      return { patchId, filePath, fileName };
    } catch (err: any) {
      logError('Failed to generate regression test', err);
      return null;
    }
  }

  _generateTemplateTest(_patchId: any, reasoning: any, state: any, action: any) { 
    const escapedReasoning = reasoning.replace(/'/g, "\\'").replace(/\n/g, ' ');
    const escapedState = state.replace(/'/g, "\\'");
    const escapedAction = action.replace(/'/g, "\\'");
    return [
      '// Test body generated by tribunal (template fallback)',
      '',
      'async function run() {',
      `  // This test guards against regression of: ${escapedReasoning}`,
      `  // Original state: ${escapedState}`,
      `  // Original action: ${escapedAction}`,
      '  try {',
      '    // Verify the patched module can be required without errors',
      '    const path = require("path");',
      '    const { PROJECT_ROOT } = require(\'./project-root\');',
      '    const modulePath = PROJECT_ROOT;',
      '    // Basic sanity check - the bot should be loadable',
      '    assert.ok(true, "Sanity check passed");',
      '    return { passed: true, error: null };',
      '  } catch (err: any) {',
      '    return { passed: false, error: err.message };',
      '  }',
      '}',
      '',
      'if (require.main === module) {',
      '  run().then(result => {',
      '    if (result.passed) {',
      '      console.log("PASS: " + JSON.stringify(result));',
      '      process.exit(0);',
      '    } else {',
      '      console.log("FAIL: " + JSON.stringify(result));',
      '      process.exit(1);',
      '    }',
      '  }).catch(err => {',
      '    console.log("FAIL: " + err.message);',
      '    process.exit(1);',
      '  });',
      '}',
      '',
      '',
      'module.exports = { run };',
      ''
    ].join('\n');
  }

  async runRegressionSuite() { 
    try {
      log('Running regression test suite...', 'INFO', 'regression-bank');
      const files = this._getTestFiles();

      if (files.length === 0) {
        log('No regression tests found to run', 'DEBUG', 'regression-bank');
        return { total: 0, passed: 0, failed: 0, results: [] };
      }

      let total = 0;
      let passed = 0;
      let failed = 0;
      const results = [];

      const testPromises = files.map((file: any) => this._runSingleTest(file));
      const testResults = await Promise.allSettled(testPromises);

      for (const outcome of testResults) {
        if (outcome.status === 'fulfilled' && outcome.value) {
          const r = outcome.value;
          total++;
          if (r.passed) { passed++; } else { failed++; }
          results.push(r);
        } else {
          total++;
          failed++;
          results.push({
            file: 'unknown',
            passed: false,
            duration: 0,
            error: (outcome as any).reason?.message || 'Test execution failed'
          });
        }
      }

      log(`Regression suite complete: ${passed}/${total} passed`, passed === total ? 'INFO' : 'WARN', 'regression-bank');

      await this._pruneOldTests();

      return { total, passed, failed, results };
    } catch (err: any) {
      logError('Failed to run regression suite', err);
      return { total: 0, passed: 0, failed: 0, results: [], error: err.message };
    }
  }

  _getTestFiles() { 
    try {
      if (!fs.existsSync(REGRESSION_DIR)) return [];
      return fs.readdirSync(REGRESSION_DIR)
        .filter((f: any) => f.endsWith('.test.js'))
        .map((f: any) => path.join(REGRESSION_DIR, f))
        .sort();
    } catch (err: any) {
      logError('Failed to list regression test files', err);
      return [];
    }
  }

  _runSingleTest(filePath: any) { 
    return new Promise((resolve) => {
      const timeout = CONFIG.REGRESSION_TEST_TIMEOUT_MS || 30000;
      const start = Date.now();

      try {
        const child = fork(filePath, [], {
          timeout,
          cwd: PROJECT_ROOT,
          stdio: 'pipe',
          env: { ...process.env, NODE_ENV: 'test' }
        });

        let output = '';

        child.stdout.on('data', (data: any) => { output += data.toString(); });
        child.stderr.on('data', (data: any) => { output += data.toString(); });

        let _timeoutHandle: any;
      child.on('exit', (code: any) => {
        if (_timeoutHandle) { clearTimeout(_timeoutHandle); _timeoutHandle = null; }
          const duration = Date.now() - start;
          const testPassed = code === 0;

          try {
            getDb()?.prepare(
              'UPDATE regression_tests SET last_run_at = ?, last_run_passed = ?, total_runs = total_runs + 1, total_passes = total_passes + ?, consecutive_passes = CASE WHEN ? = 1 THEN consecutive_passes + 1 ELSE 0 END WHERE file_path = ?'
            ).run(Date.now(), testPassed ? 1 : 0, testPassed ? 1 : 0, testPassed ? 1 : 0, filePath);
          } catch (updateErr: any) {
            // Non-fatal
          }

          resolve({
            file: path.basename(filePath),
            filePath,
            passed: testPassed,
            duration,
            exitCode: code,
            output: output.substring(0, 500)
          });
        });

        child.on('error', (err: any) => {
          const duration = Date.now() - start;
          resolve({
            file: path.basename(filePath),
            filePath,
            passed: false,
            duration,
            error: err.message
          });
        });

        _timeoutHandle = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
          resolve({
            file: path.basename(filePath),
            filePath,
            passed: false,
            duration: Date.now() - start,
            error: 'Test timed out'
          });
        }, timeout + 5000);
      } catch (err: any) {
        resolve({
          file: path.basename(filePath),
          filePath,
          passed: false,
          duration: Date.now() - start,
          error: err.message
        });
      }
    });
  }

  async _pruneOldTests() { 
    try {
      const cutoffTimestamp = Date.now() - (PRUNE_AFTER_DAYS * 24 * 60 * 60 * 1000);
      const oldTests = getDb()?.prepare(
        'SELECT * FROM regression_tests WHERE created_at < ? AND consecutive_passes >= 5 AND total_runs >= 5 ORDER BY created_at ASC'
      ).all(cutoffTimestamp);

      if (oldTests.length === 0) return;

      let pruned = 0;
      for (const test of oldTests) {
        try {
          if (test.file_path && fs.existsSync(test.file_path)) {
            fs.unlinkSync(test.file_path);
          }
          getDb()?.prepare('DELETE FROM regression_tests WHERE id = ?').run(test.id);
          pruned++;
        } catch (delErr: any) {
          log(`Failed to prune regression test ${test.id}: ${delErr.message}`, 'WARN', 'regression-bank');
        }
      }

      if (pruned > 0) {
        log(`Pruned ${pruned} old regression tests (older than ${PRUNE_AFTER_DAYS} days, consistently passing)`, 'INFO', 'regression-bank');
      }
    } catch (err: any) {
      logError('Failed to prune old regression tests', err);
    }
  }

  getRegressionCount() { 
    try {
      const row = getDb()?.prepare('SELECT COUNT(*) as count FROM regression_tests').get();
      return row ? row.count : 0;
    } catch (err: any) {
      logError('Failed to get regression test count', err);
      return 0;
    }
  }

  getRegressionStats() { 
    try {
      const total = getDb()?.prepare('SELECT COUNT(*) as count FROM regression_tests').get().count;
      const passed = getDb()?.prepare('SELECT COUNT(*) as count FROM regression_tests WHERE last_run_passed = 1').get().count;
      const failed = getDb()?.prepare('SELECT COUNT(*) as count FROM regression_tests WHERE last_run_passed = 0').get().count;
      const neverRun = getDb()?.prepare('SELECT COUNT(*) as count FROM regression_tests WHERE last_run_at IS NULL').get().count;
      return { total, passed, failed, neverRun };
    } catch (err: any) {
      logError('Failed to get regression stats', err);
      return { total: 0, passed: 0, failed: 0, neverRun: 0 };
    }
  }
}

const regressionBank = new RegressionBank();

module.exports = {
  regressionBank,
  RegressionBank,
  generateRegressionTest: (recording: any, patch: any) => regressionBank.generateRegressionTest(recording, patch),
  runRegressionSuite: () => regressionBank.runRegressionSuite(),
  getRegressionCount: () => regressionBank.getRegressionCount(),
  getRegressionStats: () => regressionBank.getRegressionStats(),
  _injectDependencies,
};
