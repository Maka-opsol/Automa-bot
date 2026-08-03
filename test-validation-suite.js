let _deps = {};
function _injectDependencies(deps) { _deps = deps; }
function getLaunchBrowser() { return _deps.browser?.launchBrowser; }
function getCloseBrowser() { return _deps.browser?.closeBrowser; }
function getAuthenticate() { return _deps.auth?.authenticate; }
function getDetermineNextAction() { return _deps.providers?.determineNextAction; }
function getDb() { return _deps.database?.db; }

const { log, logError } = require('./logger');
const CONFIG = require('./config');

const TESTS = [
  {
    id: 'auth_flow',
    name: 'Authentication Flow',
    run: async () => {
      const page = await getLaunchBrowser()?.();
      try {
        await getAuthenticate()?.(page);
        const url = page.url();
        return url.includes('/assignments') || url.includes('mathu.co.za');
      } finally {
        await getCloseBrowser()?.();
      }
    },
  },
  {
    id: 'state_detection',
    name: 'State Detection',
    run: async () => {
      const { stateMachine, STATES } = require('./state-machine');
      await stateMachine.initialize();
      return stateMachine.getCurrentState() === STATES.MATHU_LOGIN;
    },
  },
  {
    id: 'database_integrity',
    name: 'Database Integrity',
    run: async () => {
      const result = getDb()?.pragma('integrity_check');
      return result[0]?.integrity_check === 'ok';
    },
  },
  {
    id: 'provider_health',
    name: 'Provider Health',
    run: async () => {
      const { getAvailableProviders } = require('./providers-registry');
      const providers = getAvailableProviders();
      return providers.length > 0;
    },
  },
  {
    id: 'cache_operation',
    name: 'Cache Operation',
    run: async () => {
      const { getCachedAction, setCachedAction } = require('./cache');
      const testKey = 'test';
      setCachedAction(testKey, { actionType: 'wait' });
      const result = getCachedAction(testKey);
      return result && result.actionType === 'wait';
    },
  },
  {
    id: 'self_heal_sandbox',
    name: 'Self-Heal Sandbox',
    run: async () => {
      const { executePatchInSandbox } = require('./sandbox-executor');
      const testPatch = 'module.exports = { test: true };';
      const result = await executePatchInSandbox(testPatch, '/tmp/test.js');
      return result !== false;
    },
  },
];

class ValidationSuite {
  constructor() {
    this.results = [];
    this.isRunning = false;
  }

  async runAll() {
    if (this.isRunning) return this.results;
    this.isRunning = true;
    this.results = [];
    log('🧪 Running validation suite...', 'INFO', 'validation');
    for (const test of TESTS) {
      try {
        const start = Date.now();
        const passed = await test.run();
        const duration = Date.now() - start;
        this.results.push({
          id: test.id,
          name: test.name,
          passed,
          duration,
          timestamp: Date.now(),
        });
        log(`Test ${test.id}: ${passed ? '✅ PASS' : '❌ FAIL'} (${duration}ms)`, passed ? 'INFO' : 'WARN', 'validation');
      } catch (err) {
        this.results.push({
          id: test.id,
          name: test.name,
          passed: false,
          error: err.message,
          timestamp: Date.now(),
        });
        logError(`Test ${test.id} threw exception`, err);
      }
    }
    this.isRunning = false;
    return this.results;
  }

  async runCritical() {
    const critical = TESTS.filter(t => t.id === 'auth_flow' || t.id === 'database_integrity');
    const results = [];
    for (const test of critical) {
      try {
        const passed = await test.run();
        results.push({ id: test.id, passed });
      } catch (err) {
        results.push({ id: test.id, passed: false, error: err.message });
      }
    }
    return results;
  }

  getResults() {
    return this.results;
  }

  getSummary() {
    const total = this.results.length;
    const passed = this.results.filter(r => r.passed).length;
    return { total, passed, failed: total - passed, successRate: total > 0 ? (passed / total * 100).toFixed(1) : 0 };
  }

  async runAndLog() {
    await this.runAll();
    const summary = this.getSummary();
    log(`Validation suite complete: ${summary.passed}/${summary.total} passed (${summary.successRate}%)`, 'INFO', 'validation');
    if (summary.failed > 0) {
      const failures = this.results.filter(r => !r.passed).map(r => r.id).join(', ');
      log(`Failed tests: ${failures}`, 'WARN', 'validation');
    }
    return this.results;
  }
}

const validationSuite = new ValidationSuite();

async function validateBeforePromotion(stagingSource) {
  // If a staging source path is provided, run validation from that directory
  const originalDir = process.cwd();
  if (stagingSource && fs.existsSync(stagingSource)) {
    try {
      process.chdir(stagingSource);
    } catch (e) {
      log(`Could not chdir to staging source: ${e.message}`, 'WARN', 'validation');
    }
  }
  try {
    const results = await validationSuite.runCritical();
    const allPassed = results.every(r => r.passed);
    if (!allPassed) {
      log('Critical validation failed, blocking promotion', 'ERROR', 'validation');
      return false;
    }
    return true;
  } finally {
    if (stagingSource) {
      try { process.chdir(originalDir); } catch (e) { /* ignore */ }
    }
  }
}

module.exports = { validationSuite, validateBeforePromotion, TESTS, _injectDependencies };
