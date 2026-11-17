'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { fork } = require('child_process');

const CONFIG = require('./get-config');

let _lastResult: any = null;
let _testTimer: any = null;
let _startupTimer: any = null;

class CleanRoomTest {
  constructor() {
  }

  /**
   * Generate a self-contained minimal test script that verifies the bot
   * works without any cached state or session data.
   */
  generateTestScript() { 
    try {
      const script = `
'use strict';

const path = require('path');
const { createRequire } = require('module');
const projectRequire = createRequire(${JSON.stringify(path.join(PROJECT_ROOT, 'package.json'))});
projectRequire('tsx/cjs/api').register();
const fs = require('fs');
const os = require('os');

async function runTest() { 
  const startTime = Date.now();
  let page = null;
  let closeBrowser = null;
  let tmpDir = null;

  try {
    // Nested inside the parent's private runner directory, so the parent can
    // remove it even when the child is killed before its own cleanup runs.
    tmpDir = fs.mkdtempSync(path.join(process.env.CLEAN_ROOM_BASE_DIR || os.tmpdir(), 'clean-room-test-'));
    process.env.CLEAN_ROOM_TEST = '1';
    process.env.DB_PATH = path.join(tmpDir, 'test.db');
    process.env.NO_PERSIST = 'true';

    // Step 1: Load config (should work without cached state)
    const CONFIG = projectRequire('./config');
    const testUrl = CONFIG.APP_URL || process.env.APP_URL || 'https://app.mathu.co.za';
    console.log('[clean-room] Config loaded');

    // Step 2: Load database (creates fresh in /tmp)
    const Database = projectRequire('better-sqlite3');
    const testDb = new Database(path.join(tmpDir, 'test.db'));
    testDb.prepare('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, val TEXT)').run();
    testDb.prepare('INSERT INTO test (val) VALUES (?)').run('clean-room');
    const row = testDb.prepare('SELECT * FROM test').get();
    testDb.close();
    if (!row || row.val !== 'clean-room') {
      console.error('[clean-room] Database test failed');
      throw new Error('Clean-room check failed');
    }
    console.log('[clean-room] Database: OK');

    // Step 3: Load logger
    const { log } = projectRequire('./logger');
    log('Clean-room test logger initialized', 'INFO', 'clean-room');
    console.log('[clean-room] Logger: OK');

    // Step 4: Launch browser (most critical test)
    console.log('[clean-room] Launching browser...');
    const browserModule = projectRequire('./browser');
    browserModule._injectDependencies({ config: CONFIG });
    closeBrowser = browserModule.closeBrowser;
    page = await browserModule.launchBrowser();
    // launchBrowser returns the already configured Page, not a Browser.
    if (!page || typeof page.goto !== 'function') {
      throw new Error('Browser launch did not return a Page');
    }

    // Step 5: Navigate to APP_URL
    console.log('[clean-room] Navigating to app');
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[clean-room] Navigation complete');

    // Step 6: Take screenshot (proves rendering works)
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 });
    if (!screenshot || screenshot.length < 100) {
      console.error('[clean-room] Screenshot too small or empty');
      throw new Error('Clean-room check failed');
    }
    console.log('[clean-room] Screenshot: OK (' + screenshot.length + ' bytes)');

    // Step 7: Find at least one interactive element
    const interactiveElements = await page.$$eval(
      'button, a[href], input, [role="button"], [tabindex]',
      (els) => els.length
    );
    console.log('[clean-room] Interactive elements found:', interactiveElements);

    if (interactiveElements === 0) {
      console.error('[clean-room] No interactive elements found on page');
      throw new Error('Clean-room check failed');
    }

    const duration = Date.now() - startTime;
    console.log('[clean-room] SUCCESS in ' + duration + 'ms');
  } catch (err) {
    // Browser and configuration errors can contain the complete app URL.
    console.error('[clean-room] FAILED (details withheld)');
    process.exitCode = 1;
  } finally {
    if (closeBrowser) {
      try { await closeBrowser(); } catch (e) { /* ignore */ }
    }
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) { /* ignore */ }
    }
  }
}

runTest();
`;
      return script;
    } catch (err: any) {
      logError('Error generating clean-room test script', err);
      return null;
    }
  }

  /**
   * Run the clean-room test in a forked child process.
   */
  async runCleanRoomTest() { 
    log('Starting clean-room reproduction test', 'INFO', 'clean-room');
    const startTime = Date.now();

    const result = {
      passed: false,
      timestamp: startTime,
      duration: 0,
      addictionDetected: false,
      retestPassed: false,
      error: null
    };

    // Generate the test script
    const scriptContent = this.generateTestScript();
    if (!scriptContent) {
// @ts-expect-error
      result.error = 'Failed to generate test script';
      _lastResult = result;
      this._logEvent('clean_room_test', JSON.stringify(result));
      return result;
    }

    // Keep the runner in a fresh private directory; never follow a pre-existing
    // shared temporary pathname when creating it.
    const os = require('os');
    let scriptDir: string | null = null;
    let scriptPath: string;
    try {
      scriptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clean-room-runner-'));
      scriptPath = path.join(scriptDir, 'runner.js');
      fs.writeFileSync(scriptPath, scriptContent, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    } catch (err: any) {
      if (scriptDir) { try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }
      log('Failed to write clean-room test script (details withheld)', 'ERROR', 'clean-room');
// @ts-expect-error
      result.error = 'Failed to write test script';
      _lastResult = result;
      this._logEvent('clean_room_test', JSON.stringify(result));
      return result;
    }

    try {
    // Run the test in a forked process
    let firstRunPassed = false;
    try {
// @ts-expect-error
      firstRunPassed = await this._forkTest(scriptPath);
    } catch (err: any) {
      log('Clean-room test fork error (details withheld)', 'ERROR', 'clean-room');
// @ts-expect-error
      result.error = 'Fork error';
    }

    result.duration = Date.now() - startTime;
    result.passed = firstRunPassed;

    if (!firstRunPassed) {
      // A failed isolated run cannot distinguish stale state from unavailable
      // infrastructure, browser/proxy failures, timeouts, or child crashes.
      // Never purge based on this ambiguous signal, even if the main bot works.
      log('Clean-room test failed; cause is ambiguous, cache and sessions preserved', 'WARN', 'clean-room');
      try { getSendAlert()('Clean-room test failed; cache and sessions were preserved. Investigate infrastructure and browser health.', 2); } catch (e: any) {}
    } else {
      log('Clean-room test PASSED', 'INFO', 'clean-room');
    }

    result.duration = Date.now() - startTime;
    _lastResult = result;
    this._logEvent('clean_room_test', JSON.stringify({
      passed: result.passed,
      duration: result.duration,
      addictionDetected: result.addictionDetected,
      retestPassed: result.retestPassed
    }));

    return result;
    } finally {
      try { fs.rmSync(scriptDir, { recursive: true, force: true }); } catch (e: any) { /* ignore */ }
    }
  }

  _forkTest(scriptPath: any) { 
    return new Promise((resolve) => {
      try {
        const child = fork(scriptPath, [], {
          cwd: PROJECT_ROOT,
          // Child diagnostics can contain credentials or URL query parameters.
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          env: {
            ...process.env,
            APP_URL: CONFIG.APP_URL || 'https://app.mathu.co.za',
            CLEAN_ROOM_BASE_DIR: path.dirname(scriptPath),
            CLEAN_ROOM_TEST: '1',
            NO_PERSIST: 'true'
          }
        });

        let failed = false;
        child.on('error', () => {
          failed = true;
          log('Clean-room test process error (details withheld)', 'ERROR', 'clean-room');
        });

        const timeoutHandle = setTimeout(() => {
          failed = true;
          try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
          log('Clean-room test timed out (120s)', 'ERROR', 'clean-room');
        }, 120000);
        // Wait for close before the parent removes the runner directory.
        child.on('close', (code: any) => {
          clearTimeout(timeoutHandle);
          resolve(!failed && code === 0);
        });
      } catch (err: any) {
        log('Error forking clean-room test (details withheld)', 'ERROR', 'clean-room');
        resolve(false);
      }
    });
  }

  async _checkMainBotWorking() { 
    try {
      // Simple heuristic: check if the bot's last activity was recent (within 15 min)
      const row = getDb()?.prepare('SELECT timestamp FROM progress_log ORDER BY id DESC LIMIT 1').get();
      if (row && row.timestamp) {
        const age = Date.now() - row.timestamp;
        return age < 15 * 60 * 1000;
      }
      // If no progress log, assume not working
      return false;
    } catch (err: any) {
      logError('Error checking main bot status', err);
      return false;
    }
  }

  async _clearCacheAndSessions() { 
    try {
      log('Clearing template cache', 'INFO', 'clean-room');
      try { getDb()?.prepare('DELETE FROM template_cache').run(); } catch (e: any) { logError('Failed to clear template cache', e); }

      log('Clearing session pool', 'INFO', 'clean-room');
      try { getDb()?.prepare('DELETE FROM session_pool').run(); } catch (e: any) { logError('Failed to clear session pool', e); }

      log('Clearing network intercept log', 'INFO', 'clean-room');
      try { getDb()?.prepare('DELETE FROM network_intercept_log').run(); } catch (e: any) { logError('Failed to clear network intercept log', e); }

      log('Cache and session purge complete', 'INFO', 'clean-room');
    } catch (err: any) {
      logError('Error during cache/session clear', err);
    }
  }

  _logEvent(phase: any, triggerReason: any) { 
    try {
      getDb()?.prepare('INSERT INTO self_heal_events (feature_id, phase, timestamp, trigger_reason) VALUES (?, ?, ?, ?)')
        .run('clean-room-test', phase, Date.now(), triggerReason);
    } catch (err: any) {
      logError('Failed to log self-heal event', err);
    }
  }

  getLastResult() { 
    return _lastResult;
  }

  start(intervalMs: any) { 
    try {
      const interval = intervalMs != null
        ? intervalMs
        : (CONFIG.CLEAN_ROOM_TEST_INTERVAL_HOURS || 168) * 60 * 60 * 1000;

      // Run once 30 minutes after startup
      _startupTimer = setTimeout(async () => {
        try {
          await this.runCleanRoomTest();
        } catch (err: any) {
          logError('Startup clean-room test failed', err);
        }
      }, 30 * 60 * 1000);
      if (_startupTimer && _startupTimer.unref) _startupTimer.unref();

      // Periodic scheduler
      _testTimer = setInterval(async () => {
        try {
          await this.runCleanRoomTest();
        } catch (err: any) {
          logError('Periodic clean-room test failed', err);
        }
      }, interval);
      if (_testTimer && _testTimer.unref) _testTimer.unref();

      log(`Clean-room test started (interval: ${Math.round(interval / 60000)}min, first run in 30min)`, 'INFO', 'clean-room');
    } catch (err: any) {
      logError('Failed to start clean-room test', err);
    }
  }

  stop() { 
    if (_testTimer) { clearInterval(_testTimer); _testTimer = null; }
    if (_startupTimer) { clearTimeout(_startupTimer); _startupTimer = null; }
    log('Clean-room test stopped', 'INFO', 'clean-room');
  }
}

const cleanRoomTest = new CleanRoomTest();
module.exports = { CleanRoomTest, cleanRoomTest , _injectDependencies };