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

  async testPatch(patchContent: any, filePath: any, patchId: any, options?: { isNonCodegen?: boolean }) {
    try {
      if (!patchContent || typeof patchContent !== 'string') {
        log('No patch content provided for adversarial testing', 'WARN', 'adversarial-tester');
        return { passed: false, results: [{ testType: 'init', passed: false, error: 'No patch content', duration: 0 }] };
      }

      if (!patchId) {
        patchId = `adversarial-${Date.now()}`;
      }

      const resolvedPath = filePath || 'unknown.js';
      const isNonCodegen = options?.isNonCodegen || false;
      log(`Starting adversarial testing for ${resolvedPath} (patch: ${patchId})${isNonCodegen ? ' [NON-CODEGEN - extended tests]' : ''}`, 'INFO', 'adversarial-tester');

      const safePatchId = (patchId || '').replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 100);
      const testFile = path.join(this.tempDir, `adversarial-${safePatchId}.js`);
      fs.writeFileSync(testFile, patchContent, 'utf8');

      // v2: Core tests (always run)
      const testTypes = [
        { type: 'nullInput', handler: () => this._testNullInput(testFile) },
        { type: 'emptyInput', handler: () => this._testEmptyInput(testFile) },
        { type: 'malformedResponse', handler: () => this._testMalformedResponse(testFile) },
        { type: 'oversizedInput', handler: () => this._testOversizedInput(testFile) },
        { type: 'concurrentAccess', handler: () => this._testConcurrentAccess(testFile) },
        { type: 'expiredSession', handler: () => this._testExpiredSession(testFile) },
      ];

      // v2: Extended tests for non-codegen patches
      if (isNonCodegen) {
        testTypes.push(
          { type: 'syntaxValidity', handler: () => this._testSyntaxValidity(testFile) },
          { type: 'moduleStructure', handler: () => this._testModuleStructure(testFile, resolvedPath) },
          { type: 'exportConsistency', handler: () => this._testExportConsistency(testFile) },
          { type: 'requireSafety', handler: () => this._testRequireSafety(testFile) },
          { type: 'noNetworkCalls', handler: () => this._testNoNetworkCalls(testFile) },
          { type: 'noProcessManipulation', handler: () => this._testNoProcessManipulation(testFile) },
          { type: 'contentSanity', handler: () => this._testContentSanity(testFile, patchContent) },
        );
      }

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

  // ═══════════════════════════════════════════════════════════════
  //  CORE TESTS (original)
  // ═══════════════════════════════════════════════════════════════

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
      const size = OVERSIZED_INPUT_SIZE;
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

  // ═══════════════════════════════════════════════════════════════
  //  EXTENDED TESTS (v2: for non-codegen patches)
  // ═══════════════════════════════════════════════════════════════

  /**
   * Validate that the patch has valid JavaScript syntax.
   * Non-codegen models often produce syntactically invalid code.
   */
  _testSyntaxValidity(testFile: any) {
    return new Promise((resolve) => {
      const testScript = `
        try {
          // Try to parse the file as a module (catches syntax errors)
          const fs = require('fs');
          const source = fs.readFileSync('${testFile.replace(/'/g, "\\'")}', 'utf8');
          try {
            new Function(source);
            // Also try as module (catches import/export errors that Function doesn't)
            require('${testFile.replace(/'/g, "\\'")}');
            process.send({ passed: true, error: null });
          } catch (e: any) {
            if (e instanceof SyntaxError) {
              process.send({ passed: false, error: 'Syntax error: ' + e.message.substring(0, 200) });
            } else {
              // Non-syntax require error (missing deps) is OK for a patch
              process.send({ passed: true, error: null });
            }
          }
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;
      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  /**
   * Verify the patch has a proper module structure:
   *   - Starts with 'use strict'
   *   - Has module.exports at the bottom
   *   - Is not a trivial/placeholder file
   */
  _testModuleStructure(testFile: any, originalFilePath: any) {
    return new Promise((resolve) => {
      const testScript = `
        try {
          const fs = require('fs');
          const source = fs.readFileSync('${testFile.replace(/'/g, "\\'")}', 'utf8');
          const lines = source.split('\\n');

          const issues = [];

          // Must start with 'use strict'
          const trimmed = source.trimStart();
          if (!trimmed.startsWith("'use strict'") && !trimmed.startsWith('"use strict"')) {
            issues.push('Does not start with use strict');
          }

          // Must have module.exports (unless it's a config-only or type-only file)
          const baseName = '${originalFilePath.replace(/'/g, "\\'")}'.replace(/\\.(ts|js)$/, '');
          const isTypeFile = baseName.includes('.d.') || baseName.includes('global.');
          if (!isTypeFile && !source.includes('module.exports')) {
            issues.push('No module.exports found');
          }

          // Must not be trivially small (non-codegen models sometimes output just 'use strict')
          const meaningfulLines = lines.filter((l: string) => {
            const t = l.trim();
            return t.length > 0 && !t.startsWith('//') && !t.startsWith('/*') && !t.startsWith('*');
          });
          if (meaningfulLines.length < 3) {
            issues.push('File has fewer than 3 meaningful lines (possible placeholder)');
          }

          // Must not be mostly comments
          const commentLines = lines.filter((l: string) => {
            const t = l.trim();
            return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
          });
          if (commentLines.length > meaningfulLines.length * 0.7 && meaningfulLines.length > 5) {
            issues.push('File is mostly comments (' + Math.round(commentLines.length / meaningfulLines.length * 100) + '% comment lines)');
          }

          if (issues.length > 0) {
            process.send({ passed: false, error: issues.join('; ') });
          } else {
            process.send({ passed: true, error: null });
          }
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;
      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  /**
   * Verify the patch exports a consistent set of functions/objects.
   * Catches cases where non-codegen models export random stuff.
   */
  _testExportConsistency(testFile: any) {
    return new Promise((resolve) => {
      const testScript = `
        try {
          const mod = require('${testFile.replace(/'/g, "\\'")}');
          const exports = typeof mod === 'object' && mod !== null ? mod : {};
          const keys = Object.keys(exports);

          const issues = [];

          // Must export at least one thing
          if (keys.length === 0) {
            issues.push('Module exports nothing');
          }

          // All exports should be functions or objects (not strings, numbers, etc.)
          for (const key of keys) {
            const val = exports[key];
            const type = typeof val;
            if (type !== 'function' && type !== 'object') {
              issues.push('Export ' + key + ' is ' + type + ' (expected function or object)');
            }
          }

          // Check for suspicious export names that non-codegen models sometimes produce
          const suspiciousExports = ['answer', 'response', 'result', 'output', 'fix', 'patch', 'solution'];
          const normalizedKeys = keys.map((k: string) => k.toLowerCase());
          const hasSuspicious = suspiciousExports.some(s => normalizedKeys.includes(s));
          if (hasSuspicious && keys.length <= 2) {
            issues.push('Has suspiciously generic export name(s): ' + keys.join(', '));
          }

          if (issues.length > 0) {
            process.send({ passed: false, error: issues.join('; ') });
          } else {
            process.send({ passed: true, error: null });
          }
        } catch (e: any) {
          // If require fails due to missing deps, that's OK (it's a patch for the real project)
          if (e.code === 'MODULE_NOT_FOUND') {
            process.send({ passed: true, error: null });
          } else {
            process.send({ passed: false, error: e.message.substring(0, 300) });
          }
        }
      `;
      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  /**
   * Verify the patch doesn't require suspicious/unusual modules.
   */
  _testRequireSafety(testFile: any) {
    return new Promise((resolve) => {
      const testScript = `
        try {
          const fs = require('fs');
          const source = fs.readFileSync('${testFile.replace(/'/g, "\\'")}', 'utf8');

          const forbiddenRequires = [
            'child_process', 'cluster', 'dgram', 'dns', 'fs',
            'http', 'https', 'net', 'readline', 'repl', 'tls',
            'vm', 'worker_threads', 'crypto'
          ];

          const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
          let match;
          const issues = [];
          const found = [];

          while ((match = requireRegex.exec(source)) !== null) {
            const mod = match[1];
            // Skip relative requires (./, ../)
            if (mod.startsWith('.') || mod.startsWith('/')) continue;
            // Check against forbidden list
            const baseMod = mod.split('/')[0];
            if (forbiddenRequires.includes(baseMod)) {
              found.push(mod);
            }
          }

          if (found.length > 0) {
            issues.push('Requires forbidden module(s): ' + found.join(', '));
          }

          if (issues.length > 0) {
            process.send({ passed: false, error: issues.join('; ') });
          } else {
            process.send({ passed: true, error: null });
          }
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;
      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  /**
   * Verify the patch doesn't make any network calls.
   */
  _testNoNetworkCalls(testFile: any) {
    return new Promise((resolve) => {
      const testScript = `
        try {
          const fs = require('fs');
          const source = fs.readFileSync('${testFile.replace(/'/g, "\\'")}', 'utf8').toLowerCase();

          const networkPatterns = [
            'fetch(', 'http.get(', 'http.request(', 'https.get(', 'https.request(',
            'xmlhttprequest', 'websocket', 'net.connect(', 'dns.lookup(',
            '.get(', '.post(', '.put(', '.delete(', '.patch('
          ];

          const issues = [];
          for (const pattern of networkPatterns) {
            if (source.includes(pattern)) {
              issues.push('Contains network call pattern: ' + pattern);
            }
          }

          // Also check for URL-like strings
          const urlPattern = /https?:\/\/[a-z]/;
          if (urlPattern.test(source)) {
            // Check it's not just in a comment
            const lines = source.split('\\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (urlPattern.test(trimmed) && !trimmed.startsWith('//') && !trimmed.startsWith('*')) {
                issues.push('Contains URL in code: ' + trimmed.substring(0, 80));
                break;
              }
            }
          }

          if (issues.length > 0) {
            process.send({ passed: false, error: issues.join('; ') });
          } else {
            process.send({ passed: true, error: null });
          }
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;
      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  /**
   * Verify the patch doesn't manipulate process-level state.
   */
  _testNoProcessManipulation(testFile: any) {
    return new Promise((resolve) => {
      const testScript = `
        try {
          const fs = require('fs');
          const source = fs.readFileSync('${testFile.replace(/'/g, "\\'")}', 'utf8');

          const forbiddenPatterns = [
            'process.exit(', 'process.kill(', 'process.disconnect(',
            'process.env.HOME', 'process.env.USER',
            'process.env.GITHUB', 'process.env.RENDER',
            'process.env.MISTRAL', 'process.env.OPENROUTER',
            'process.env.BAZAARLINK', 'process.env.DEEPSEEK',
            'process.env.GEMINI', 'process.env.GROQ',
            'process.send(',  // IPC (only adversarial test runner should use this)
          ];

          const issues = [];
          for (const pattern of forbiddenPatterns) {
            if (source.includes(pattern)) {
              issues.push('Contains process manipulation: ' + pattern);
            }
          }

          if (issues.length > 0) {
            process.send({ passed: false, error: issues.join('; ') });
          } else {
            process.send({ passed: true, error: null });
          }
        } catch (e: any) {
          process.send({ passed: false, error: e.message.substring(0, 300) });
        }
      `;
      this._runSandboxed(testScript, (result: any) => resolve(result));
    });
  }

  /**
   * Sanity check the content: verify it's actual code, not a description,
   * explanation, or markdown.
   */
  _testContentSanity(testFile: any, originalContent: string) {
    return new Promise((resolve) => {
      try {
        const issues = [];

        // Check for markdown (non-codegen models love outputting markdown)
        const mdPatterns = [/^#{1,6}\s/m, /^\*\s/m, /^-\s/m, /^```/m];
        const lines = originalContent.split('\n');
        let mdLineCount = 0;
        for (const line of lines) {
          const trimmed = line.trimStart();
          if (mdPatterns.some(p => p.test(trimmed))) {
            mdLineCount++;
          }
        }
        if (mdLineCount > lines.length * 0.3) {
          issues.push(`Content is ${Math.round(mdLineCount / lines.length * 100)}% markdown lines (possible description, not code)`);
        }

        // Check for English prose patterns (common in non-codegen model outputs)
        const proseIndicators = [/^Here is/i, /^The fix is/i, /^I\s+will/i, /^This code/i, /^To fix/i, /^The issue/i, /^You should/i];
        let proseLineCount = 0;
        for (const line of lines) {
          const trimmed = line.trim();
          if (proseIndicators.some(p => p.test(trimmed))) {
            proseLineCount++;
          }
        }
        if (proseLineCount > 3) {
          issues.push(`Content has ${proseLineCount} prose-like lines (possible explanation, not code)`);
        }

        // Check for HTML (non-codegen models sometimes return HTML)
        if (/<html/i.test(originalContent) || /<body/i.test(originalContent) || /<div/i.test(originalContent)) {
          issues.push('Content contains HTML tags (not JavaScript)');
        }

        if (issues.length > 0) {
          resolve({ passed: false, error: issues.join('; ') });
        } else {
          resolve({ passed: true, error: null });
        }
      } catch (e: any) {
        resolve({ passed: false, error: e.message.substring(0, 300) });
      }
    });
  }

  // ═══════════════════════════════════════════════════════════════
  //  SANDBOX RUNNER
  // ═══════════════════════════════════════════════════════════════

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

      const testDescriptions: Record<string, string> = {
        nullInput: 'Function called with null/undefined inputs - must handle gracefully',
        emptyInput: 'Function called with empty strings, objects, arrays - must handle gracefully',
        malformedResponse: 'Function received malformed JSON responses - must not crash',
        oversizedInput: 'Function received very large input (10MB) - must handle without OOM',
        concurrentAccess: 'Multiple processes required the module simultaneously - must be safe',
        expiredSession: 'Function received an expired session object - must handle auth failures',
        syntaxValidity: 'Patch has invalid JavaScript syntax',
        moduleStructure: 'Patch does not have proper module structure (use strict, exports)',
        exportConsistency: 'Patch exports are inconsistent or suspicious',
        requireSafety: 'Patch requires forbidden modules (child_process, fs, http, etc.)',
        noNetworkCalls: 'Patch makes network calls (forbidden in self-heal patches)',
        noProcessManipulation: 'Patch manipulates process state (env, exit, kill)',
        contentSanity: 'Patch content is not valid code (markdown, HTML, or prose)',
      };

      return failures.map((f: any) => ({
        testType: f.test_type,
        description: testDescriptions[f.test_type] || f.test_type,
        error: f.error
      }));
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
  testPatch: (patch: any, filePath: any, patchId: any, options?: any) => adversarialTester.testPatch(patch, filePath, patchId, options),
  isHardened: (patchId: any) => adversarialTester.isHardened(patchId),
  getFuzzFeedback: (patchId: any) => adversarialTester.getFuzzFeedback(patchId),
  getTestHistory: (patchId: any) => adversarialTester.getTestHistory(patchId),
  _injectDependencies,
};
