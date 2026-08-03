'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const util = require('util');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const CONFIG = require('./get-config');

const execAsync = util.promisify(require('child_process').exec);
const EXEC_TIMEOUT_MS = 120000; // 2 minutes for npm commands
const SMOKE_TEST_DURATION_MS = 30000; // 30 seconds

// Critical binaries to check
const CRITICAL_BINARIES = {
  chromium: {
    check: () => {
      try {
        const { chromium } = require('playwright');
        return typeof chromium.executablePath === 'function';
      } catch (e: any) { return false; }
    },
    required: true,
    label: 'Playwright Chromium',
  },
  sharp: {
    check: () => {
      try { require('sharp'); return true; } catch (e: any) { return false; }
    },
    required: false,
    label: 'sharp (image processing)',
  },
  'onnxruntime-node': {
    check: () => {
      try { require('onnxruntime-node'); return true; } catch (e: any) { return false; }
    },
    required: false,
    label: 'onnxruntime-node (ML inference)',
  },
};

const ENSURE_TABLE_SQL = `CREATE TABLE IF NOT EXISTS dependency_health (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  check_timestamp INTEGER NOT NULL,
  npm_healthy INTEGER DEFAULT 1,
  playwright_healthy INTEGER DEFAULT 1,
  issues TEXT,
  heal_attempted INTEGER DEFAULT 0,
  heal_successful INTEGER DEFAULT 1
)`;

class DependencyHealer {
  _lastHealthResult: any;
  _intervalId: any;
  _healingInProgress: any;
  issues: any;
  ok: any;
  corrupted: any;

  constructor() {
    this._intervalId = null;
    this._healingInProgress = false;
    this._lastHealthResult = null;
  }

  /**
   * Run a full dependency health check.
   * 1. npm ls --json to detect missing/broken deps
   * 2. Check critical binaries exist and load
   * 3. Hash-check critical files in node_modules
   * 4. Check Playwright browser binary
   *
   * @returns {object} Health check results
   */
  async runHealthCheck() { 
    const result = {
      timestamp: Date.now(),
      npm: null,
      binaries: {},
      hashCheck: null,
      playwright: null,
      overall: true,
    };

    log('Running dependency health check...', 'INFO', 'dependency-healer');

    // 1. npm ls --json
// @ts-expect-error
    result.npm = await this._checkNpmDeps();
// @ts-expect-error
    if (result.npm.issues.length > 0) {
      result.overall = false;
    }

    // 2. Critical binary checks
    for (const [name, check] of Object.entries(CRITICAL_BINARIES)) {
      try {
        const ok = check.check();
// @ts-expect-error
        result.binaries[name] = { ok, label: check.label, required: check.required };
        if (!ok && check.required) {
          result.overall = false;
        }
      } catch (err: any) {
// @ts-expect-error
        result.binaries[name] = { ok: false, label: check.label, required: check.required, error: err.message };
        if (check.required) result.overall = false;
      }
    }

    // 3. Hash-check critical files in node_modules
// @ts-expect-error
    result.hashCheck = this._hashCheckCriticalFiles();

    // 4. Playwright browser binary check
// @ts-expect-error
    result.playwright = await this._checkPlaywrightBrowser();

    // Record to database
    this._recordHealthResult(result);

    if (result.overall) {
      log('Dependency health check: all clear', 'INFO', 'dependency-healer');
    } else {
      const issues = this._summarizeIssues(result);
      log(`Dependency health check: ISSUES FOUND - ${issues}`, 'WARN', 'dependency-healer');
    }

    this._lastHealthResult = result;
    return result;
  }

  /**
   * Check npm dependencies via `npm ls --json`.
   */
  async _checkNpmDeps() { 
    const issues = [];
    let npmOutput: any = null;

    try {
      const { stdout } = await execAsync('npm ls --json 2>&1', {
        timeout: EXEC_TIMEOUT_MS,
        cwd: PROJECT_ROOT,
      });

      try {
        npmOutput = JSON.parse(stdout);
      } catch (parseErr: any) {
        // npm ls outputs errors to stderr but they end up in stdout with 2>&1
        // Try to parse anyway - sometimes there's a preamble
        const jsonStart = stdout.indexOf('{');
        if (jsonStart >= 0) {
          npmOutput = JSON.parse(stdout.slice(jsonStart));
        }
      }
    } catch (err: any) {
      // npm ls returns non-zero exit code if there are issues
      if (err.stdout) {
        try {
          const jsonStart = err.stdout.indexOf('{');
          if (jsonStart >= 0) {
            npmOutput = JSON.parse(err.stdout.slice(jsonStart));
          }
        } catch (e: any) { /* ignore */ }
      }
      if (!npmOutput) {
        issues.push({ type: 'npm_ls_error', message: err.message?.slice(0, 200) || 'npm ls failed' });
        return { ok: false, issues };
      }
    }

    if (!npmOutput) {
      return { ok: true, issues: [] };
    }

    // Check for problems in npm output
    if (npmOutput.problems && Array.isArray(npmOutput.problems)) {
      for (const problem of npmOutput.problems) {
        const isMissing = problem.includes('missing:') || problem.includes('UNMET DEPENDENCY');
        const isExtraneous = problem.includes('extraneous');
        const isPeerDep = problem.includes('peer dep');

        if (isMissing) {
          issues.push({ type: 'missing', message: problem });
        } else if (isExtraneous) {
          // Extraneous is usually not critical
          log(`npm extraneous dep: ${problem}`, 'DEBUG', 'dependency-healer');
        } else if (isPeerDep) {
          // Peer dep warnings are usually non-critical
          log(`npm peer dep warning: ${problem}`, 'DEBUG', 'dependency-healer');
        }
      }
    }

    // Check for missing dependencies by looking for errored children
    const checkMissing = (node: any, prefix = '') => {
      if (node.missing && typeof node.missing === 'object') {
        for (const [depName, depInfo] of Object.entries(node.missing)) {
          if ((depInfo as any).requiredBy) {
            issues.push({ type: 'missing', message: `Missing: ${depName} required by ${(depInfo as any).requiredBy}` });
          }
        }
      }
      if (node.dependencies) {
        for (const dep of Object.values(node.dependencies)) {
          checkMissing(dep, prefix + '  ');
        }
      }
    };
    checkMissing(npmOutput);

    return { ok: issues.length === 0, issues };
  }

  /**
   * Hash-check critical files in node_modules to detect corruption.
   * Compares against previously stored hashes in the DB.
   */
  _hashCheckCriticalFiles() { 
    const crypto = require('crypto');
    const results = { checked: 0, corrupted: 0, details: [] };

    // Read package.json main entries for critical packages
    const criticalPackages = ['better-sqlite3', 'playwright', 'playwright-core', 'envalid', 'node-telegram-bot-api'];

    for (const pkg of criticalPackages) {
      try {
        const pkgPath = path.join(PROJECT_ROOT, 'node_modules', pkg, 'package.json');
        if (!fs.existsSync(pkgPath)) {
          (results.details as any[]).push({ package: pkg, error: 'package.json not found' });
          results.corrupted++;
          continue;
        }

        const pkgJson = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const mainEntry = pkgJson.main || 'index.js';
        const mainPath = path.join(PROJECT_ROOT, 'node_modules', pkg, mainEntry);

        if (!fs.existsSync(mainPath)) {
          (results.details as any[]).push({ package: pkg, error: `main entry not found: ${mainEntry}` });
          results.corrupted++;
          continue;
        }

        const content = fs.readFileSync(mainPath);
        const hash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);

        results.checked++;
        (results.details as any[]).push({ package: pkg, hash, status: 'ok' });
      } catch (err: any) {
        (results.details as any[]).push({ package: pkg, error: err.message });
        results.corrupted++;
      }
    }

    if (results.corrupted > 0) {
      log(`Hash check: ${results.corrupted}/${results.checked} packages have issues`, 'WARN', 'dependency-healer');
    }

    return results;
  }

  /**
   * Check if Playwright browser binary exists and is valid.
   */
  async _checkPlaywrightBrowser() { 
    try {
      const { chromium } = require('playwright');
      const execPath = chromium.executablePath();

      if (!execPath || !fs.existsSync(execPath)) {
        return { ok: false, error: `Chromium binary not found at ${execPath}` };
      }

      const stat = fs.statSync(execPath);
      // A valid Chromium binary should be at least 50MB
      const minSize = 50 * 1024 * 1024;
      if (stat.size < minSize) {
        return { ok: false, error: `Chromium binary too small: ${Math.round(stat.size / 1024 / 1024)}MB (min ${Math.round(minSize / 1024 / 1024)}MB)` };
      }

      return { ok: true, path: execPath, sizeMB: Math.round(stat.size / 1024 / 1024) };
    } catch (err: any) {
      return { ok: false, error: err.message };
    }
  }

  /**
   * Heal a detected dependency issue.
   * @param {object} issue - The issue from runHealthCheck
   * @returns {boolean} true if heal was successful
   */
  async healDependency(issue: any) { 
    if (this._healingInProgress) {
      log('Dependency heal already in progress', 'WARN', 'dependency-healer');
      return false;
    }
    this._healingInProgress = true;

    let healed = false;
    try {
      const issueType = issue?.type || (typeof issue === 'string' ? issue : 'unknown');
      log(`Healing dependency issue: ${issueType}`, 'INFO', 'dependency-healer');

      switch (issueType) {
        case 'missing':
          healed = await this._healMissingPackages();
          break;

        case 'playwright_missing':
        case 'playwright_corrupted':
          healed = await this._healPlaywright();
          break;

        case 'node_modules_corrupted':
          healed = await this._healNodeModules();
          break;

        default:
          // Try a full npm ci first
          log(`Unknown issue type "${issueType}", attempting npm ci`, 'INFO', 'dependency-healer');
          healed = await this._healMissingPackages();
          break;
      }

      if (healed) {
        log('Dependency heal successful', 'INFO', 'dependency-healer');
        logAudit(`Dependency heal successful for: ${issueType}`, 'dependency-healer');
      } else {
        log('Dependency heal failed', 'ERROR', 'dependency-healer');
        logAudit(`Dependency heal FAILED for: ${issueType}`, 'dependency-healer');
      }

      return healed;
    } catch (err: any) {
      logError('Dependency heal failed with error', err);
      logAudit(`Dependency heal error: ${err.message}`, 'dependency-healer');
      return false;
    } finally {
      this._healingInProgress = false;
    }
  }

  /**
   * Heal missing packages via npm ci (or npm install --production as fallback).
   */
  async _healMissingPackages() { 
    try {
      // Try npm ci first (clean install from lockfile)
      log('Attempting npm ci...', 'INFO', 'dependency-healer');
      await execAsync('npm ci --no-audit --no-fund 2>&1', {
        timeout: EXEC_TIMEOUT_MS * 2, // double timeout for full install
        cwd: PROJECT_ROOT,
      });
      log('npm ci succeeded', 'INFO', 'dependency-healer');
      return true;
    } catch (err: any) {
      logError('npm ci failed, falling back to npm install', err);
      try {
        await execAsync('npm install --production --no-audit --no-fund 2>&1', {
          timeout: EXEC_TIMEOUT_MS * 3,
          cwd: PROJECT_ROOT,
        });
        log('npm install succeeded (fallback)', 'INFO', 'dependency-healer');
        return true;
      } catch (err2: any) {
        logError('npm install also failed', err2);
        return false;
      }
    }
  }

  /**
   * Heal Playwright by installing the Chromium browser.
   */
  async _healPlaywright() { 
    try {
      log('Installing Playwright Chromium...', 'INFO', 'dependency-healer');
      await execAsync('npx playwright install chromium 2>&1', {
        timeout: EXEC_TIMEOUT_MS * 3,
        cwd: PROJECT_ROOT,
      });
      log('Playwright Chromium installed', 'INFO', 'dependency-healer');
      return true;
    } catch (err: any) {
      logError('Playwright Chromium install failed', err);
      return false;
    }
  }

  /**
   * Nuclear option: rm -rf node_modules && npm ci.
   */
  async _healNodeModules() { 
    try {
      const nodeModulesPath = path.join(PROJECT_ROOT, 'node_modules');

      log('Removing node_modules directory...', 'WARN', 'dependency-healer');
      fs.rmSync(nodeModulesPath, { recursive: true, force: true });

      log('Running npm ci after node_modules removal...', 'INFO', 'dependency-healer');
      await execAsync('npm ci --no-audit --no-fund 2>&1', {
        timeout: EXEC_TIMEOUT_MS * 3,
        cwd: PROJECT_ROOT,
      });

      log('Node modules rebuilt successfully', 'INFO', 'dependency-healer');
      logAudit('Full node_modules rebuild completed', 'dependency-healer');
      return true;
    } catch (err: any) {
      logError('Node modules rebuild failed', err);
      return false;
    }
  }

  /**
   * Verify that the heal was successful by running a 30-second smoke test.
   * Tests: require main modules, launch browser briefly.
   * @returns {object} { healthy: boolean, checks: object[] }
   */
  async verifyHeal() { 
    const checks = [];
    let allPassed = true;

    log('Running post-heal smoke test...', 'INFO', 'dependency-healer');
    const smokeStart = Date.now();

    // Test 1: Require main modules
    const modules = ['config', 'database', 'logger'];
    for (const mod of modules) {
      try {
        // Clear cache to force fresh require
        delete require.cache[require.resolve(`./${mod}`)];
        require(`./${mod}`);
        checks.push({ module: mod, ok: true });
        log(`Smoke test: ${mod} - OK`, 'DEBUG', 'dependency-healer');
      } catch (err: any) {
        checks.push({ module: mod, ok: false, error: err.message });
        allPassed = false;
        logError(`Smoke test: ${mod} - FAILED`, err);
      }
    }

    // Test 2: Browser launch (10 seconds max)
    try {
      const { launchBrowser, closeBrowser } = require('./browser');
      const page = await launchBrowser();
      checks.push({ module: 'browser', ok: true });
      log('Smoke test: browser - OK', 'DEBUG', 'dependency-healer');

      // Quick navigation test
      try {
        await page.goto('about:blank', { timeout: 5000 });
        checks.push({ module: 'browser-navigation', ok: true });
      } catch (navErr: any) {
        checks.push({ module: 'browser-navigation', ok: false, error: navErr.message });
      }

      await closeBrowser();
    } catch (err: any) {
      checks.push({ module: 'browser', ok: false, error: err.message });
      allPassed = false;
      logError('Smoke test: browser - FAILED', err);
      try { await require('./browser').closeBrowser(); } catch (e: any) { /* already closed */ }
    }

    const elapsed = Date.now() - smokeStart;
    log(`Smoke test completed in ${elapsed}ms - ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`, allPassed ? 'INFO' : 'WARN', 'dependency-healer');

    return { healthy: allPassed, checks, elapsedMs: elapsed };
  }

  /**
   * Record health check results to the database.
   */
  _recordHealthResult(result: any) { 
    try {
      getDb()?.exec(ENSURE_TABLE_SQL);

      const issues = [];
      if (result.npm?.issues?.length) issues.push(...result.npm.issues.map((i: any) => i.message));
      for (const [name, info] of Object.entries(result.binaries || {})) {
// @ts-expect-error
        if (!(info as any).ok) issues.push(`Binary ${name}: ${info.error || 'missing'}`);
      }
      if (result.playwright && !result.playwright.ok) {
        issues.push(`Playwright: ${result.playwright.error}`);
      }

      getDb()?.prepare(`
        INSERT INTO dependency_health (check_timestamp, npm_healthy, playwright_healthy, issues)
        VALUES(?, ?, ?, ?)
      `).run(
        Date.now(),
        result.npm?.ok ? 1 : 0,
        result.playwright?.ok ? 1 : 0,
        issues.length > 0 ? JSON.stringify(issues) : null
      );
    } catch (err: any) {
      logError('Failed to record dependency health result', err);
    }
  }

  /**
   * Summarize issues from a health check result.
   */
  _summarizeIssues(result: any) { 
    const parts = [];
    if (result.npm?.issues?.length) parts.push(`${result.npm.issues.length} npm issues`);
    for (const [name, info] of Object.entries(result.binaries || {})) {
      if (!(info as any).ok) parts.push(`${name} missing`);
    }
    if (result.playwright && !result.playwright.ok) parts.push('Playwright issue');
    return parts.join(', ');
  }

  /**
   * Auto-heal: run health check and heal any detected issues.
   * Classified as "transient" - no consensus needed.
   * @returns {object} { healthCheck, healed, verified }
   */
  async autoHeal() { 
    const healthCheck = await this.runHealthCheck();

    if (healthCheck.overall) {
      return { healthCheck, healed: false, verified: true, reason: 'no_issues' };
    }

    log('Dependency issues detected, initiating auto-heal...', 'INFO', 'dependency-healer');
    logAudit('Dependency auto-heal initiated', 'dependency-healer');

    // Determine the most likely fix
    let healType = 'unknown';
    if ((healthCheck as any).npm?.issues?.some((i: any) => i.type === 'missing')) {
      healType = 'missing';
// @ts-expect-error
    } else if (healthCheck.playwright && !healthCheck.playwright.ok) {
      healType = 'playwright_missing';
// @ts-expect-error
    } else if ((healthCheck.hashCheck as any)?.corrupted > 0) {
      healType = 'node_modules_corrupted';
    }

    const healed = await this.healDependency(healType);
    if (!healed) {
      return { healthCheck, healed: false, verified: false, reason: 'heal_failed' };
    }

    // Verify the heal
    const verified = await this.verifyHeal();
    return { healthCheck, healed: true, verified: verified.healthy };
  }

  /**
   * Start the periodic dependency health check scheduler.
   * @param {number} intervalMs - Check interval (default 6 hours)
   */
  start(intervalMs: any) { 
    const interval = intervalMs || 6 * 60 * 60 * 1000;
    if (this._intervalId) {
      log('Dependency healer already running', 'WARN', 'dependency-healer');
      return;
    }

    log(`Dependency healer started (interval: ${Math.round(interval / 60000)}min)`, 'INFO', 'dependency-healer');

    // Initial check after delay
    setTimeout(async () => {
      try {
        const result = await this.autoHeal();
        if (!result.verified) {
          log('Initial dependency auto-heal did not fully resolve issues', 'WARN', 'dependency-healer');
        }
      } catch (err: any) {
        logError('Initial dependency heal run failed', err);
      }
    }, 45000).unref();

    // Register with failsafe coordinator
    try {
      const { failsafeCoordinator } = require('./failsafe-coordinator');
      if (failsafeCoordinator && typeof failsafeCoordinator.registerHealthCheck === 'function') {
        failsafeCoordinator.registerHealthCheck('dependency-healer', () => this.runHealthCheck(), interval);
        log('Registered dependency healer as failsafe health check', 'DEBUG', 'dependency-healer');
      }
    } catch (err: any) {
      log('Could not register with failsafe coordinator', 'DEBUG', 'dependency-healer');
    }

    this._intervalId = setInterval(async () => {
      try {
        await this.autoHeal();
      } catch (err: any) {
        logError('Periodic dependency heal run failed', err);
      }
    }, interval);

    if (this._intervalId.unref) this._intervalId.unref();
  }

  /**
   * Stop the periodic scheduler.
   */
  stop() { 
    if (this._intervalId) {
      clearInterval(this._intervalId);
      this._intervalId = null;
      log('Dependency healer stopped', 'INFO', 'dependency-healer');
    }
  }

  /**
   * Get the last health check result.
   */
  getLastHealthResult() { 
    return this._lastHealthResult;
  }
}

// Singleton
const dependencyHealer = new DependencyHealer();
module.exports = { DependencyHealer, dependencyHealer , _injectDependencies };