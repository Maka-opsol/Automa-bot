'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const os = require('os');
const { fork } = require('child_process');

const CONFIG = require('./get-config');

const ADVERSARIAL_TIMEOUT_MS = CONFIG.ADVERSARIAL_TEST_TIMEOUT_MS || 15000;
const OVERSIZED_INPUT_SIZE = 10 * 1024 * 1024; // 10MB

class AdversarialTester {
  tempDir: any;

  constructor() {
    this.tempDir = path.join(os.tmpdir(), 'mathu-adversarial');
    this._ensureDir();
    this._ensureTable();
  }

  _ensureDir() { 
    try {
      if (!fs.existsSync(this.tempDir)) {
        fs.mkdirSync(this.tempDir, { recursive: true });
      }
    } catch (err: any) {
      logError('Failed to create adversarial temp directory', err);
    }
  }

  _ensureTable() { 
    try {
      getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS adversarial_test_results (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patch_id TEXT NOT NULL,
          test_type TEXT NOT NULL,
          passed INTEGER NOT NULL,
          error TEXT,
          duration_ms INTEGER,
          tested_at INTEGER NOT NULL,
          file_path TEXT,
          UNIQUE(patch_id, test_type)
        );
        CREATE INDEX IF NOT EXISTS idx_adversarial_patch ON adversarial_test_results(patch_id);
        CREATE INDEX IF NOT EXISTS idx_adversarial_type ON adversarial_test_results(test_type);
      `);
    } catch (err: any) {
      logError('Failed to create adversarial_test_results table', err);
    }
  }

  async testPatch(patchContent: any, filePath: any, patchId: any) { 
    try {
      if (!patchContent || typeof patchContent !== 'string') {
        log('No patch content provided for adversarial testing', 'WARN', 'adversarial-tester');
        return { passed: false, results: [{ testType: 'init', passed: false, error: 'No patch content', duration: 0 }] };
      }

      if (!patchId) {
        patchId = `adversarial-${Date.now()}`;
      }

      const resolvedPath = filePath || 'unknown.js';
      log(`Starting adversarial testing for ${resolvedPath} (patch: ${patchId})`, 'INFO', 'adversarial-tester');

      const safePatchId = (patchId || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
      const testFile = path.join(this.tempDir, `adversarial-${safePatchId}.js`);
      fs.writeFileSync(testFile, patchContent, 'utf8');

      const testTypes = [
        { type: 'nullInput', handler: () => this._testNullInput(testFile) },
        { type: 'emptyInput', handler: () => this._testEmptyInput(testFile) },
        { type: 'malformedResponse', handler: () => this._testMalformedResponse(testFile) },
        { type: 'oversizedInput', handler: () => this._testOversizedInput(testFile) },
        { type: 'concurrentAccess', handler: () => this._testConcurrentAccess(testFile) },
        { type: 'expiredSession', handler: () => this._testExpiredSession(testFile) }
      ];

      const results = [];
      let allPassed = true;

      for (const testDef of testTypes) {
        const start = Date.now();
        try {
          const result = await testDef.handler();
          const duration = Date.now() - start;
          const passed = (result as any).passed;

          if (!passed) allPassed = false;

          const record = {
            testType: testDef.type,
            passed,
            error: (result as any).error || null,
            duration
          };
          results.push(record);

          this._recordResult(patchId, testDef.type, passed, (result as any).error, duration, resolvedPath);

          if (passed) {
            log(`Adversarial test '${testDef.type}' PASSED (${duration}ms)`, 'DEBUG', 'adversarial-tester');
          } else {
            log(`Adversarial test '${testDef.type}' FAILED: ${(result as any).error} (${duration}ms)`, 'WARN', 'adversarial-tester');
          }
        } catch (err: any) {
          const duration = Date.now() - start;
          allPassed = false;
          results.push({ testType: testDef.type, passed: false, error: err.message, duration });
          this._recordResult(patchId, testDef.type, false, err.message, duration, resolvedPath);
          logError(`Adversarial test '${testDef.type}' threw`, err);
        }
      }

      try { fs.unlinkSync(testFile); } catch (cleanupErr: any) { /* ignore */ }

      log(`Adversarial testing complete for ${resolvedPath}: ${results.filter(r => r.passed).length}/${results.length} passed`, allPassed ? 'INFO' : 'WARN', 'adversarial-tester');

      return { passed: allPassed, results };
    } catch (err: any) {
      logError('Failed to run adversarial tests', err);
      return { passed: false, results: [{ testType: 'fatal', passed: false, error: err.message, duration: 0 }] };
    }
  }

  _testNullInput(testFile: any) { 
    return new Promise((resolve) => {
      const testScript = `
        try {
          const mod = require('${testFile.replace(/'/g, "\\'")}');
          const exports = typeof mod === 'object' && mod !== null ? mod : {};
          const keys = Object.keys(exports);
          for (const key of keys) {
            try {
              if (typeof exports[key] === 'function') {
                exports[key](null);
                exports[key](undefined);
              }
            } catch (e: any) {
              // Expected - functions may reject null
            }
          }
          process.send({ passed: true, error: null });
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;

      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  _testEmptyInput(testFile: any) { 
    return new Promise((resolve) => {
      const testScript = `
        try {
          const mod = require('${testFile.replace(/'/g, "\\'")}');
          const exports = typeof mod === 'object' && mod !== null ? mod : {};
          const keys = Object.keys(exports);
          const emptyInputs = ['', {}, [], 0, false];
          for (const key of keys) {
            try {
              if (typeof exports[key] === 'function') {
                for (const input of emptyInputs) {
                  exports[key](input);
                }
              }
            } catch (e: any) {
              // Expected
            }
          }
          process.send({ passed: true, error: null });
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;

      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  _testMalformedResponse(testFile: any) { 
    return new Promise((resolve) => {
      const testScript = `
        try {
          const mod = require('${testFile.replace(/'/g, "\\'")}');
          const exports = typeof mod === 'object' && mod !== null ? mod : {};
          const keys = Object.keys(exports);
          const malformedInputs = [
            '{broken json',
            'undefined',
            'NaN',
            '<html>not json</html>',
            '\\0\\0\\0 binary',
            '{ "a": }',
            '["unclosed array'
          ];
          for (const key of keys) {
            try {
              if (typeof exports[key] === 'function') {
                for (const input of malformedInputs) {
                  exports[key](input);
                }
              }
            } catch (e: any) {
              // Expected - should not crash the process
            }
          }
          process.send({ passed: true, error: null });
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;

      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  _testOversizedInput(testFile: any) { 
    return new Promise((resolve) => {
      const size = OVERSIZED_INPUT_SIZE; // 10MB as intended
      const testScript = `
        try {
          const mod = require('${testFile.replace(/'/g, "\\'")}');
          const exports = typeof mod === 'object' && mod !== null ? mod : {};
          const keys = Object.keys(exports);
          const bigString = 'x'.repeat(${size});
          for (const key of keys) {
            try {
              if (typeof exports[key] === 'function') {
                exports[key](bigString);
              }
            } catch (e: any) {
              // Expected - should not crash
            }
          }
          process.send({ passed: true, error: null });
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;

      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  _testConcurrentAccess(testFile: any) { 
    return new Promise((resolve) => {
      const childCount = 5;
      let completed = 0;
      let allOk = true;
      let errors = [];

      const testScript = `
        try {
          const mod = require('${testFile.replace(/'/g, "\\'")}');
          process.send({ passed: true, error: null });
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;

      for (let i = 0; i < childCount; i++) {
        this._runSandboxed(testScript, (result: any) => {
          completed++;
          if (!result.passed) {
            allOk = false;
            errors.push(result.error);
          }
          if (completed === childCount) {
            resolve({
              passed: allOk,
              error: allOk ? null : `Concurrent access failures: ${errors.join('; ').substring(0, 300)}`
            });
          }
        });
      }
    });
  }

  _testExpiredSession(testFile: any) { 
    return new Promise((resolve) => {
      const testScript = `
        try {
          const mod = require('${testFile.replace(/'/g, "\\'")}');
          const exports = typeof mod === 'object' && mod !== null ? mod : {};
          const keys = Object.keys(exports);
          const expiredSession = {
            token: process.env.TEST_TOKEN || 'expired-test-token-placeholder',
            expires_at: Date.now() - 86400000,
            refresh_token: null,
            user: null
          };
          for (const key of keys) {
            try {
              if (typeof exports[key] === 'function') {
                exports[key](expiredSession);
              }
            } catch (e: any) {
              // Expected
            }
          }
          process.send({ passed: true, error: null });
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;

      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  _runSandboxed(scriptBody: any, callback: any) { 
    const scriptFile = path.join(this.tempDir, `sandbox-${Date.now()}-${Math.random().toString(36).substring(2, 8)}.js`);

    try {
      fs.writeFileSync(scriptFile, scriptBody, 'utf8');

      const child = fork(scriptFile, [], {
        timeout: ADVERSARIAL_TIMEOUT_MS,
        cwd: PROJECT_ROOT,
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, NODE_ENV: 'adversarial-test' }
      });

      let settled = false;
      let timeoutId: any = null;

      const finish = (result: any) => {
        if (settled) return;
        settled = true;
        if (timeoutId) { clearTimeout(timeoutId); timeoutId = null; }
        try { fs.unlinkSync(scriptFile); } catch (e: any) { /* ignore */ }
        callback(result);
      };

      child.on('message', (msg: any) => {
        if (msg && typeof msg === 'object' && 'passed' in msg) {
          finish({ passed: !!msg.passed, error: msg.error || null });
        }
      });

      child.on('exit', (code: any) => {
        finish({ passed: code === 0, error: code !== 0 ? `Process exited with code ${code}` : null });
      });

      child.on('error', (err: any) => {
        finish({ passed: false, error: err.message });
      });

      timeoutId = setTimeout(() => {
        try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
        finish({ passed: false, error: `Timeout after ${ADVERSARIAL_TIMEOUT_MS}ms` });
      }, ADVERSARIAL_TIMEOUT_MS + 2000);
    } catch (err: any) {
      try { fs.unlinkSync(scriptFile); } catch (e: any) { /* ignore */ }
      callback({ passed: false, error: err.message });
    }
  }

  _recordResult(patchId: any, testType: any, passed: any, error: any, durationMs: any, filePath: any) { 
    try {
      getDb()?.prepare(
        'INSERT OR REPLACE INTO adversarial_test_results (patch_id, test_type, passed, error, duration_ms, tested_at, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)'
      ).run(patchId, testType, passed ? 1 : 0, (error || '').substring(0, 500), durationMs, Date.now(), (filePath || '').substring(0, 200));
    } catch (err: any) {
      logError('Failed to record adversarial test result', err);
    }
  }

  isHardened(patchId: any) { 
    try {
      const allTests = ['nullInput', 'emptyInput', 'malformedResponse', 'oversizedInput', 'concurrentAccess', 'expiredSession'];
      const results = getDb()?.prepare(
        'SELECT test_type, passed FROM adversarial_test_results WHERE patch_id = ?'
      ).all(patchId);

      if (results.length === 0) return false;

      const resultMap = {};
      for (const r of results) {
        (resultMap as any)[r.test_type] = r.passed === 1;
      }

      return allTests.every(t => (resultMap as any)[t] === true);
    } catch (err: any) {
      logError('Failed to check if patch is hardened', err);
      return false;
    }
  }

  getFuzzFeedback(patchId: any) { 
    try {
      const failures = getDb()?.prepare(
        "SELECT test_type, error FROM adversarial_test_results WHERE patch_id = ? AND passed = 0 ORDER BY tested_at DESC"
      ).all(patchId);

      if (failures.length === 0) return null;

      const feedback = failures.map((f: any) => {
        const testDescriptions = {
          nullInput: 'Function called with null/undefined inputs - must handle gracefully',
          emptyInput: 'Function called with empty strings, objects, arrays - must handle gracefully',
          malformedResponse: 'Function received malformed JSON responses - must not crash',
          oversizedInput: 'Function received very large input (10MB) - must handle without OOM',
          concurrentAccess: 'Multiple processes required the module simultaneously - must be safe',
          expiredSession: 'Function received an expired session object - must handle auth failures'
        };
        return {
          testType: f.test_type,
          description: (testDescriptions as any)[f.test_type] || f.test_type,
          error: f.error
        };
      });

      return feedback;
    } catch (err: any) {
      logError('Failed to get fuzz feedback', err);
      return null;
    }
  }

  getTestHistory(patchId: any) { 
    try {
      return getDb()?.prepare(
        'SELECT * FROM adversarial_test_results WHERE patch_id = ? ORDER BY tested_at DESC'
      ).all(patchId);
    } catch (err: any) {
      logError('Failed to get adversarial test history', err);
      return [];
    }
  }
}

const adversarialTester = new AdversarialTester();

module.exports = {
  adversarialTester,
  AdversarialTester,
  testPatch: (patch: any, filePath: any, patchId: any) => adversarialTester.testPatch(patch, filePath, patchId),
  isHardened: (patchId: any) => adversarialTester.isHardened(patchId),
  getFuzzFeedback: (patchId: any) => adversarialTester.getFuzzFeedback(patchId),
  getTestHistory: (patchId: any) => adversarialTester.getTestHistory(patchId),
  _injectDependencies,
};