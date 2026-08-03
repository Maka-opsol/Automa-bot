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
const { PROJECT_ROOT } = require('./project-root');
const fs = require('fs');
const os = require('os');

// Create isolated database in /tmp
const tmpDir = path.join(os.tmpdir(), 'clean-room-test-' + process.pid);
fs.mkdirSync(tmpDir, { recursive: true });

// Minimal in-memory config override
process.env.CLEAN_ROOM_TEST = '1';
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.NO_PERSIST = 'true';

const APP_URL = ${JSON.stringify(CONFIG.APP_URL || 'https://app.mathu.co.za')};

async function runTest() { 
  const startTime = Date.now();
  let browser: any = null;

  try {
    // Step 1: Load config (should work without cached state)
    const CONFIG = require(${JSON.stringify(path.join(PROJECT_ROOT, 'config'))});
    const testUrl = CONFIG.APP_URL || APP_URL;
    console.log('[clean-room] Config loaded, APP_URL:', testUrl);

    // Step 2: Load database (creates fresh in /tmp)
    const Database = require('better-sqlite3');
    const testDb = new Database(path.join(tmpDir, 'test.db'));
    testDb.prepare('CREATE TABLE IF NOT EXISTS test (id INTEGER PRIMARY KEY, val TEXT)').run();
    testDb.prepare('INSERT INTO test (val) VALUES (?)').run('clean-room');
    const row = testDb.prepare('SELECT * FROM test').get();
    testDb.close();
    if (!row || row.val !== 'clean-room') {
      console.error('[clean-room] Database test failed');
      process.exit(1);
    }
    console.log('[clean-room] Database: OK');

    // Step 3: Load logger
    const { log } = require(${JSON.stringify(path.join(PROJECT_ROOT, 'logger'))});
    log('Clean-room test logger initialized', 'INFO', 'clean-room');
    console.log('[clean-room] Logger: OK');

    // Step 4: Launch browser (most critical test)
    console.log('[clean-room] Launching browser...');
    const { launchBrowser, closeBrowser } = require(${JSON.stringify(path.join(PROJECT_ROOT, 'browser'))});
    browser = await launchBrowser();

    if (!browser) {
      console.error('[clean-room] Browser launch returned null');
      process.exit(1);
    }

    const pages = browser.pages ? browser.pages() : [];
    const page = pages.length > 0 ? pages[0] : await browser.newPage();

    // Step 5: Navigate to APP_URL
    console.log('[clean-room] Navigating to:', testUrl);
    await page.goto(testUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    console.log('[clean-room] Navigation complete, URL:', page.url());

    // Step 6: Take screenshot (proves rendering works)
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 });
    if (!screenshot || screenshot.length < 100) {
      console.error('[clean-room] Screenshot too small or empty');
      process.exit(1);
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
      process.exit(1);
    }

    // Cleanup
    await closeBrowser();

    // Cleanup tmp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e: any) {
      // Non-critical
    }

    const duration = Date.now() - startTime;
    console.log('[clean-room] SUCCESS in ' + duration + 'ms');
    process.exit(0);
  } catch (err: any) {
    console.error('[clean-room] FAILED:', err.message);
    console.error(err.stack);

    if (browser) {
      try { await browser.close(); } catch (e: any) { /* ignore */ }
    }

    // Cleanup tmp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e: any) { /* ignore */ }

    process.exit(1);
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

    // Write script to temp file (NOT source directory)
    const os = require('os');
    const scriptPath = path.join(os.tmpdir(), `_clean_room_runner-${Date.now()}.js`);
    try {
      fs.writeFileSync(scriptPath, scriptContent, 'utf-8');
    } catch (err: any) {
      logError('Failed to write clean-room test script', err);
// @ts-expect-error
      result.error = 'Failed to write test script: ' + err.message;
      _lastResult = result;
      this._logEvent('clean_room_test', JSON.stringify(result));
      return result;
    }

    // Run the test in a forked process
    let firstRunPassed = false;
    try {
// @ts-expect-error
      firstRunPassed = await this._forkTest(scriptPath);
    } catch (err: any) {
      logError('Clean-room test fork error', err);
// @ts-expect-error
      result.error = 'Fork error: ' + err.message;
    }

    result.duration = Date.now() - startTime;
    result.passed = firstRunPassed;

    if (!firstRunPassed) {
      // Check if main bot is working (i.e., bot is addicted to stale state)
      const mainBotWorking = await this._checkMainBotWorking();

      if (mainBotWorking) {
        log('Bot is addicted to stale state: clean-room test failed but main bot works', 'ERROR', 'clean-room');
        result.addictionDetected = true;
        try { getSendAlert()('Clean-room test failed while main bot works. Bot may be addicted to stale cached state.', 2); } catch (e: any) {}

        // Attempt cache clear and session purge
        log('Triggering cache clear and session purge', 'WARN', 'clean-room');
        await this._clearCacheAndSessions();

        // Re-test
        log('Re-running clean-room test after cache clear', 'INFO', 'clean-room');
        try {
// @ts-expect-error
          result.retestPassed = await this._forkTest(scriptPath);
          if (result.retestPassed) {
            log('Clean-room re-test PASSED after cache clear', 'INFO', 'clean-room');
          } else {
            log('Clean-room re-test STILL FAILED after cache clear', 'ERROR', 'clean-room');
            try { getSendAlert()('Clean-room test still fails after cache clear. Possible fundamental breakage.', 1); } catch (e: any) {}
          }
        } catch (retestErr: any) {
          logError('Clean-room re-test error', retestErr);
        }
      } else {
        log('Clean-room test failed and main bot also not working (not state addiction)', 'WARN', 'clean-room');
      }
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

    // Clean up temp script
    try { fs.unlinkSync(scriptPath); } catch (e: any) { /* ignore */ }

    return result;
  }

  _forkTest(scriptPath: any) { 
    return new Promise((resolve) => {
      try {
        const child = fork(scriptPath, [], {
          timeout: 120000,
          cwd: PROJECT_ROOT,
          stdio: 'pipe',
          env: {
            ...process.env,
            CLEAN_ROOM_TEST: '1',
            NO_PERSIST: 'true'
          }
        });

        let output = '';
        child.stdout.on('data', (data: any) => { output += data.toString(); });
        child.stderr.on('data', (data: any) => { output += data.toString(); });

        child.on('exit', (code: any) => {
          const cleanOutput = output.split('\n').filter(l => l.includes('[clean-room]')).join('\n');
          if (cleanOutput) {
            log(`Clean-room output:\n${cleanOutput}`, code === 0 ? 'DEBUG' : 'WARN', 'clean-room');
          }
          resolve(code === 0);
        });

        child.on('error', (err: any) => {
          logError('Clean-room test process error', err);
          resolve(false);
        });

        // Hard timeout safety net
        const _timeoutHandle = setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
          log('Clean-room test timed out (120s)', 'ERROR', 'clean-room');
          resolve(false);
        }, 125000);
        child.on('exit', () => { clearTimeout(_timeoutHandle); });
      } catch (err: any) {
        logError('Error forking clean-room test', err);
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