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

const CONFIG = require('./get-config');

const CRITICAL_FILES = ['config.ts', 'database.ts', 'browser.ts', 'state-machine.ts',
  'config.js', 'database.js', 'browser.js', 'state-machine.js'];
const SOURCE_DIR = PROJECT_ROOT;

class CriticalShadowMode {
  stdout: any;
  stderr: any;

  constructor() {
    this._ensureEventsTable();
  }

  _ensureEventsTable() { 
    // No-op: self_heal_events table is created by the main database migration.
    // Do NOT create it here with a different schema.
  }

  isCriticalFile(filePath: any) { 
    const fileName = path.basename(filePath);
    return CRITICAL_FILES.includes(fileName);
  }

  getCriticalFiles() { 
    return [...CRITICAL_FILES];
  }

  async testInShadow(filePath: any, patchContent: any) { 
    const startTime = Date.now();
    const testResults = [];

    try {
      if (!this.isCriticalFile(filePath)) {
        log(`File ${filePath} is not a critical file, shadow mode not required`, 'WARN', 'critical-shadow');
        return { canPromote: true, testResults: [{ type: 'skip', passed: true, reason: 'Not a critical file' }] };
      }

      if (!patchContent || typeof patchContent !== 'string') {
        log('No patch content provided for shadow testing', 'WARN', 'critical-shadow');
        return { canPromote: false, failedTests: ['no-content'], testResults: [{ type: 'init', passed: false, reason: 'No patch content' }] };
      }

      const ext = path.extname(filePath);
      const baseName = path.basename(filePath, ext);
      const shadowPath = path.join(path.dirname(filePath), `${baseName}.shadow${ext}`);
      const fileName = path.basename(filePath);

      log(`Starting shadow mode test for critical file: ${fileName}`, 'INFO', 'critical-shadow');

      // Write shadow copy
      try {
        fs.writeFileSync(shadowPath, patchContent, 'utf8');
        log(`Shadow copy written: ${shadowPath}`, 'DEBUG', 'critical-shadow');
      } catch (writeErr: any) {
        logError(`Failed to write shadow file for ${fileName}`, writeErr);
        return { canPromote: false, failedTests: ['shadow-write'], testResults: [{ type: 'shadow-write', passed: false, error: writeErr.message }] };
      }

      let allPassed = true;
      const failedTests = [];

      // 1. Syntax check
      log(`[Shadow] Running syntax check on ${fileName}...`, 'DEBUG', 'critical-shadow');
      const syntaxResult = await this._syntaxCheck(shadowPath);
      testResults.push(syntaxResult);
      if (!syntaxResult.passed) { allPassed = false; failedTests.push('syntax-check'); }

      // 2. Require test
      if (syntaxResult.passed) {
        log(`[Shadow] Running require test on ${fileName}...`, 'DEBUG', 'critical-shadow');
        const requireResult = await this._requireTest(shadowPath, fileName);
        testResults.push(requireResult);
        if (!(requireResult as any).passed) { allPassed = false; failedTests.push('require-test'); }
      }

      // 3. Integration test
      if (allPassed) {
        log(`[Shadow] Running integration test...`, 'DEBUG', 'critical-shadow');
        const integrationResult = await this._runIntegrationTest(shadowPath);
        testResults.push(integrationResult);
        if (!(integrationResult as any).passed) { allPassed = false; failedTests.push('integration-test'); }
      }

      // 4. Regression tests
      if (allPassed) {
        log(`[Shadow] Running regression tests...`, 'DEBUG', 'critical-shadow');
        const regressionResult = await this._runRegressionTests(shadowPath);
        testResults.push(regressionResult);
        if (!regressionResult.passed) { allPassed = false; failedTests.push('regression-tests'); }
      }

      const duration = Date.now() - startTime;

      this._recordEvent(
        allPassed ? 'shadow_test_passed' : 'shadow_test_failed',
        `Shadow test ${allPassed ? 'passed' : 'failed'} for ${fileName}`,
        JSON.stringify({ filePath, duration, failedTests, testResults: testResults.map((r: any) => ({ type: r.type, passed: r.passed })) })
      );

      if (allPassed) {
        log(`Shadow mode PASSED for ${fileName} (${duration}ms)`, 'INFO', 'critical-shadow');
        return { canPromote: true, testResults, duration };
      } else {
        log(`Shadow mode FAILED for ${fileName}: ${failedTests.join(', ')} (${duration}ms)`, 'ERROR', 'critical-shadow');
        this.cleanupShadow(filePath);
        return { canPromote: false, failedTests, testResults, duration };
      }
    } catch (err: any) {
      logError(`Shadow mode test failed for ${filePath}`, err);
      this.cleanupShadow(filePath);
      return { canPromote: false, failedTests: ['fatal'], testResults: [{ type: 'fatal', passed: false, error: err.message }], error: err.message };
    }
  }

  async _syntaxCheck(shadowPath: any) { 
    try {
      const { execFile } = require('child_process');
      const ext = path.extname(shadowPath);
      let cmd, args;
      if (ext === '.ts') {
        // Use tsc --noEmit for TypeScript files
        cmd = 'npx';
        args = ['tsc', '--noEmit', '--esModuleInterop', '--skipLibCheck', '--allowJs', shadowPath];
      } else {
        cmd = 'node';
        args = ['--check', shadowPath];
      }
      const { stdout, stderr } = await new Promise<any>((resolve, reject) => {
        execFile(cmd, args, { timeout: 30000 }, (err: any, stdout: any, stderr: any) => {
          if (err) reject(err); else resolve({ stdout, stderr });
        });
      });
      log(`[Shadow] Syntax check passed`, 'DEBUG', 'critical-shadow');
      return { type: 'syntax-check', passed: true };
    } catch (err: any) {
      const error = (err.stderr || err.stdout || err.message || '').trim().substring(0, 500);
      log(`[Shadow] Syntax check failed: ${error}`, 'WARN', 'critical-shadow');
      return { type: 'syntax-check', passed: false, error };
    }
  }

  async _requireTest(shadowPath: any, _fileName: any) { 
    return new Promise((resolve) => {
      const testScript = `
        try {
          const safePath = ${JSON.stringify(shadowPath)};
          delete require.cache[safePath];
          const mod = require(safePath);
          const keys = Object.keys(mod);
          process.send({ passed: true, exports: keys.length, error: null });
        } catch (e: any) {
          process.send({ passed: false, exports: 0, error: e.message.substring(0, 500) });
        }
      `;

      const scriptFile = path.join(PROJECT_ROOT, `shadow-require-test-${Date.now()}.js`);
      try {
        fs.writeFileSync(scriptFile, testScript, 'utf8');

        const child = fork(scriptFile, [], {
          timeout: 15000,
          cwd: SOURCE_DIR,
          stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
          env: { ...process.env, NODE_ENV: 'shadow-test' }
        });

        let settled = false;
        const finish = (result: any) => {
          if (settled) return;
          settled = true;
          try { fs.unlinkSync(scriptFile); } catch (e: any) { /* ignore */ }
          resolve(result);
        };

        child.on('message', (msg: any) => {
          if (msg && typeof msg === 'object' && 'passed' in msg) {
            if (msg.passed) {
              log(`[Shadow] Require test passed (${msg.exports} exports)`, 'DEBUG', 'critical-shadow');
            }
            finish({ type: 'require-test', passed: msg.passed, error: msg.error, exports: msg.exports });
          }
        });

        child.on('exit', (code: any) => {
          finish({ type: 'require-test', passed: code === 0, error: code !== 0 ? `Process exited with code ${code}` : null });
        });

        child.on('error', (err: any) => {
          finish({ type: 'require-test', passed: false, error: err.message });
        });

        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
          finish({ type: 'require-test', passed: false, error: 'Require test timed out' });
        }, 20000);
      } catch (err: any) {
        try { fs.unlinkSync(scriptFile); } catch (e: any) { /* ignore */ }
        resolve({ type: 'require-test', passed: false, error: err.message });
      }
    });
  }

  async _runIntegrationTest(shadowPath: any) { 
    try {
      const integrationTestPath = path.join(SOURCE_DIR, 'test', 'integration.test.js');
      if (!fs.existsSync(integrationTestPath)) {
        log('[Shadow] Integration test not found, skipping', 'DEBUG', 'critical-shadow');
        return { type: 'integration-test', passed: true, skipped: true, reason: 'No integration test found' };
      }

      const result = await new Promise((resolve) => {
        const child = fork(integrationTestPath, [], {
          timeout: 120000,
          cwd: SOURCE_DIR,
          stdio: 'pipe',
          env: { ...process.env, NODE_ENV: 'test', SHADOW_MODE: 'true', SHADOW_FILE: shadowPath }
        });

        let output = '';
        child.stdout.on('data', (d: any) => { output += d.toString(); });
        child.stderr.on('data', (d: any) => { output += d.toString(); });

        child.on('exit', (code: any) => {
          resolve({ type: 'integration-test', passed: code === 0, exitCode: code, output: output.substring(0, 500) });
        });

        child.on('error', (err: any) => {
          resolve({ type: 'integration-test', passed: false, error: err.message });
        });

        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
          resolve({ type: 'integration-test', passed: false, error: 'Integration test timed out' });
        }, 125000);
      });

      if ((result as any).passed) {
        log('[Shadow] Integration test passed', 'DEBUG', 'critical-shadow');
      } else {
        log(`[Shadow] Integration test failed: ${(result as any).error || 'exit code ' + (result as any).exitCode}`, 'WARN', 'critical-shadow');
      }

      return result;
    } catch (err: any) {
      logError('[Shadow] Integration test error', err);
      return { type: 'integration-test', passed: false, error: err.message };
    }
  }

  async _runRegressionTests(_shadowPath: any) { 
    try {
      const regressionDir = path.join(SOURCE_DIR, 'test', 'regression', 'generated');
      if (!fs.existsSync(regressionDir)) {
        log('[Shadow] No regression tests found, skipping', 'DEBUG', 'critical-shadow');
        return { type: 'regression-tests', passed: true, skipped: true, reason: 'No regression tests found' };
      }

      const testFiles = fs.readdirSync(regressionDir)
        .filter((f: any) => f.endsWith('.test.js'))
        .map((f: any) => path.join(regressionDir, f));

      if (testFiles.length === 0) {
        return { type: 'regression-tests', passed: true, skipped: true, reason: 'No regression tests found' };
      }

      let passed = 0;
      let failed = 0;
      const failures = [];

      for (const file of testFiles) {
        const result = await new Promise((resolve) => {
          const child = fork(file, [], {
            timeout: 30000,
            cwd: SOURCE_DIR,
            stdio: 'pipe',
            env: { ...process.env, NODE_ENV: 'test' }
          });

          child.on('exit', (code: any) => {
            resolve(code === 0);
          });

          child.on('error', () => {
            resolve(false);
          });

          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
            resolve(false);
          }, 35000);
        });

        if (result) { passed++; } else { failed++; failures.push(path.basename(file)); }
      }

      const allPassed = failed === 0;
      log(`[Shadow] Regression tests: ${passed}/${testFiles.length} passed`, allPassed ? 'DEBUG' : 'WARN', 'critical-shadow');

// @ts-expect-error
      return { type: 'regression-tests', passed: allPassed, total: testFiles.length, passed, failed, failures };
    } catch (err: any) {
      logError('[Shadow] Regression test error', err);
      return { type: 'regression-tests', passed: false, error: err.message };
    }
  }

  promoteShadow(filePath: any) { 
    try {
      const fileName = path.basename(filePath);
      const shadowPath = `${filePath}.shadow.js`;
      const timestamp = Date.now();

      if (!fs.existsSync(shadowPath)) {
        log(`Shadow file not found: ${shadowPath}`, 'WARN', 'critical-shadow');
        return { success: false, reason: 'Shadow file does not exist' };
      }

      // Backup original
      // Clean up old backup files for this target before creating new one
    try {
      const dir = require('path').dirname(filePath);
      const baseName = require('path').basename(filePath);
      const oldBackups = fs.readdirSync(dir).filter((f: any) => f.startsWith(baseName + '.backup.'));
      for (const old of oldBackups.slice(0, -3)) { try { fs.unlinkSync(require('path').join(dir, old)); } catch (e: any) {} }
    } catch (e: any) {}
    const backupPath = `${filePath}.backup.${timestamp}`;
      try {
        fs.copyFileSync(filePath, backupPath);
        log(`Backed up original to: ${backupPath}`, 'INFO', 'critical-shadow');
      } catch (backupErr: any) {
        logError(`Failed to backup original ${fileName}`, backupErr);
        return { success: false, reason: `Backup failed: ${backupErr.message}` };
      }

      // Move shadow to production
      try {
        const shadowContent = fs.readFileSync(shadowPath, 'utf8');
        const tmpPath = filePath + `.tmp-promote-${Date.now()}`;
        fs.writeFileSync(tmpPath, shadowContent, 'utf8');
        fs.renameSync(tmpPath, filePath);
        fs.unlinkSync(shadowPath);
        log(`Shadow promoted to production: ${fileName}`, 'INFO', 'critical-shadow');
      } catch (promoteErr: any) {
        logError(`Failed to promote shadow for ${fileName}`, promoteErr);
        // Attempt to restore from backup
        try {
          fs.copyFileSync(backupPath, filePath);
          log(`Restored original from backup after failed promotion`, 'WARN', 'critical-shadow');
        } catch (restoreErr: any) {
          logError('CRITICAL: Failed to restore original after failed promotion', restoreErr);
        }
        return { success: false, reason: `Promotion failed: ${promoteErr.message}` };
      }

      this._recordEvent('shadow_promoted', `Shadow promoted for ${fileName}`, JSON.stringify({ filePath, backupPath, timestamp }));

      return { success: true, backupPath, timestamp };
    } catch (err: any) {
      logError(`Failed to promote shadow for ${filePath}`, err);
      return { success: false, reason: err.message };
    }
  }

  cleanupShadow(filePath: any) { 
    try {
      const shadowPath = `${filePath}.shadow.js`;
      if (fs.existsSync(shadowPath)) {
        fs.unlinkSync(shadowPath);
        log(`Shadow file cleaned up: ${shadowPath}`, 'DEBUG', 'critical-shadow');
        return true;
      }
      return false;
    } catch (err: any) {
      logError(`Failed to cleanup shadow for ${filePath}`, err);
      return false;
    }
  }

  _recordEvent(eventType: any, description: any, details: any) { 
    try {
      const insertSelfHealEvent = _deps.database?.insertSelfHealEvent;
      insertSelfHealEvent?.run(
        Date.now(),
        'critical-shadow',
        eventType,
        description ? String(description).substring(0, 1000) : null,
        details ? String(details).substring(0, 2000) : null,
        0, 0, 0, eventType === 'shadow_test_failed' ? 'failed' : 'success', 0, null
      );
    } catch (err: any) {
      logError('Failed to record shadow mode event', err);
    }
  }

  getShadowStatus(filePath: any) { 
    try {
      const shadowPath = `${filePath}.shadow.js`;
      const exists = fs.existsSync(shadowPath);
      let hasBackup = false;
      try {
        const dir = path.dirname(filePath);
        const baseName = path.basename(filePath);
        const files = fs.readdirSync(dir);
        hasBackup = files.some((f: any) => f.startsWith(`${baseName}.backup.`));
      } catch (e: any) { /* ignore */ }

      return {
        filePath,
        hasShadow: exists,
        hasBackup,
        isCritical: this.isCriticalFile(filePath)
      };
    } catch (err: any) {
      logError('Failed to get shadow status', err);
      return { filePath, hasShadow: false, hasBackup: false, isCritical: false };
    }
  }
}

const criticalShadowMode = new CriticalShadowMode();

module.exports = {
  criticalShadowMode,
  CriticalShadowMode,
  testInShadow: (filePath: any, patchContent: any) => criticalShadowMode.testInShadow(filePath, patchContent),
  promoteShadow: (filePath: any) => criticalShadowMode.promoteShadow(filePath),
  cleanupShadow: (filePath: any) => criticalShadowMode.cleanupShadow(filePath),
  isCriticalFile: (filePath: any) => criticalShadowMode.isCriticalFile(filePath),
  getCriticalFiles: () => criticalShadowMode.getCriticalFiles(),
  getShadowStatus: (filePath: any) => criticalShadowMode.getShadowStatus(filePath),
  CRITICAL_FILES,
  /**
   * Start the critical shadow mode subsystem.
   * Called by container-subsystem-runner when the flag is set.
   */
  start() {
    log('Critical shadow mode subsystem started', 'INFO', 'critical-shadow');
  },
  _injectDependencies,
};