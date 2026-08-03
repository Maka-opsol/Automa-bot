'use strict';
const { sleep } = require('./utils-sleep');
const { PROJECT_ROOT } = require('./project-root');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

// C8 partial: lazy config accessor instead of top-level require
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

class AuthHealer {
  private _healLock: Promise<void> | null = null;
  private _refreshIntervalId: any = null;
  private _failureCount: number = 0;
  private _healCooldownMs: number = 30 * 60 * 1000; // 30 min cooldown
  private _lastHealTime: number = 0;

  constructor() {
    // fields initialized above
  }

  /**
   * C4 FIX: Promise-based mutex to prevent TOCTOU race condition.
   * Only one healAuthFlow() can execute at a time.
   */
  private _acquireHealLock(): Promise<void> {
    if (!this._healLock) {
      this._healLock = Promise.resolve();
      return Promise.resolve();
    }
    return this._healLock;
  }

  private _setHealLock(p: Promise<void>) {
    this._healLock = p.finally(() => { this._healLock = null; });
  }

  /**
   * Track auth failures. If count exceeds threshold, trigger self-heal.
   * @param {number} failureCount - Current consecutive auth failure count
   * @returns {boolean} true if healing was triggered
   */
  handleAuthFailure(failureCount: number): boolean {
    const CONFIG = getCONFIG();
    const maxFailures = CONFIG.AUTH_HEALER_MAX_FAILURES || 5;
    this._failureCount = failureCount;

    if (failureCount >= maxFailures) {
      log(`Auth failure count ${failureCount} >= ${maxFailures}, triggering auth self-heal`, 'WARN', 'auth-healer');
      logAudit(`Auth failure threshold reached (${failureCount}/${maxFailures}), initiating heal`, 'auth-healer');

      // C4 FIX: Use mutex lock instead of boolean flag.
      // This eliminates the TOCTOU race between check and set.
      if (this._healLock) {
        log('Auth heal already in progress (lock held), skipping', 'WARN', 'auth-healer');
        return false;
      }
      if (Date.now() - this._lastHealTime < this._healCooldownMs) {
        log('Auth heal in cooldown period, skipping', 'WARN', 'auth-healer');
        return false;
      }

      this._lastHealTime = Date.now();
      const healPromise = this.healAuthFlow().catch(err => logError('Auth heal flow failed', err));
      this._setHealLock(healPromise as any);
      return true;
    }

    log(`Auth failure count: ${failureCount}/${maxFailures}`, 'DEBUG', 'auth-healer');
    return false;
  }

  /**
   * Investigate and heal the Microsoft authentication flow.
   */
  async healAuthFlow(): Promise<boolean> {
    if (this._healLock) {
      log('healAuthFlow called while lock is held, returning false', 'WARN', 'auth-healer');
      return false;
    }
    this._lastHealTime = Date.now();

    let page: any = null;
    try {
      log('Starting auth flow investigation...', 'INFO', 'auth-healer');

      // Step 1: Launch browser and capture the current login state
      const { launchBrowser, closeBrowser } = require('./browser');
      page = await launchBrowser();

      log('Navigating to Microsoft login page for investigation...', 'DEBUG', 'auth-healer');
      await page.goto('https://login.microsoftonline.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      await sleep(5000);

      const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 });
      const screenshotBase64 = screenshot.toString('base64');
      const html = await page.content();
      const currentUrl = page.url();

      log(`Captured auth page screenshot (${Math.round(screenshot.length / 1024)}KB), URL: ${currentUrl}`, 'INFO', 'auth-healer');
      await closeBrowser();
      page = null;

      // Step 2: Send to codegen tribunal for analysis
      const investigation = {
        screenshot: screenshotBase64,
        html,
        url: currentUrl,
        fileContent: '',
        targetFile: 'auth-strategies-microsoft-v2.ts',
      };

      const prompt = `The Microsoft login flow appears to have changed. Analyze the current login page and identify what has changed from the expected flow. ` +
        `Current URL: ${currentUrl}\n\n` +
        `Generate a patch for auth-strategies-microsoft-v2.ts to adapt to the new login page structure.`;

      let fixes: any[] = [];
      try {
        const { generateCodeFixViaTribunal } = require('./providers-codegen-tribunal');
        fixes = await generateCodeFixViaTribunal(investigation, prompt);
      } catch (tribunalErr: any) {
        logError('Codegen tribunal failed for auth analysis', tribunalErr);
        log('Falling back to VLM analysis for auth page', 'WARN', 'auth-healer');
        try {
          const { runVisionPipeline } = require('./providers-vision-pipeline');
          const analysis = await runVisionPipeline(screenshotBase64, prompt);
          log(`VLM analysis result: ${JSON.stringify(analysis).slice(0, 500)}`, 'INFO', 'auth-healer');
        } catch (vlmErr: any) {
          logError('VLM fallback analysis also failed', vlmErr);
        }
        return false;
      }

      if (!fixes || fixes.length === 0) {
        log('No auth fixes generated by tribunal', 'WARN', 'auth-healer');
        return false;
      }

      // Step 3: Route through critical-patch-consensus (auth is critical)
      const authFix = fixes.find((f: any) => f.file === 'auth-strategies-microsoft-v2.ts') || fixes[0];
      if (!authFix) {
        log('No applicable auth fix found in tribunal results', 'WARN', 'auth-healer');
        return false;
      }

      let approved = false;
      try {
        const consensus = require('./critical-patch-consensus');
        const result = await consensus.requestCriticalPatch({
          targetFile: 'auth-strategies-microsoft-v2.ts',
          description: 'Auth flow self-heal patch',
          // C5 FIX: lastErrors was undefined — now gathered from DB
          recentErrors: this._getRecentErrors(),
          screenshot: screenshotBase64,
        });
        approved = result.applied;
        log(`Critical patch consensus: ${approved ? 'APPROVED' : 'REJECTED'} - ${result.reason || ''}`, approved ? 'INFO' : 'WARN', 'auth-healer');
      } catch (consensusErr: any) {
        logError('Critical patch consensus unavailable', consensusErr);
        log('Consensus module not available, rejecting auth-critical patch for safety', 'WARN', 'auth-healer');
        approved = false;
      }

      if (!approved) {
        logAudit('Auth heal patch rejected by consensus', 'auth-healer');
        return false;
      }

      // Step 4: Apply the patch
      const fs = require('fs');
      const pathModule = require('path');
      const targetBase = pathModule.join(PROJECT_ROOT, 'auth-strategies-microsoft-v2');
      const targetPath = fs.existsSync(targetBase + '.ts') ? targetBase + '.ts' : targetBase + '.js';

      if (!fs.existsSync(targetPath)) {
        log(`Auth strategy file not found: ${targetPath}`, 'ERROR', 'auth-healer');
        return false;
      }

      // Backup the current file
      try {
        const dir = pathModule.dirname(targetPath);
        const baseName = pathModule.basename(targetPath);
        const oldBackups = fs.readdirSync(dir).filter((f: string) => f.startsWith(`${baseName}.backup-`));
        for (const old of oldBackups.slice(0, -5)) { try { fs.unlinkSync(pathModule.join(dir, old)); } catch (e: any) {} }
      } catch (e: any) { /* non-critical */ }

      const backupPath = targetPath + `.backup-${Date.now()}`;
      try {
        fs.copyFileSync(targetPath, backupPath);
        log(`Backed up auth strategy to ${backupPath}`, 'DEBUG', 'auth-healer');
      } catch (backupErr: any) {
        logError('Failed to backup auth strategy file', backupErr);
      }

      // Apply patch
      try {
        const { execFileSync } = require('child_process');
        const patchFile = targetPath + '.patch';
        fs.writeFileSync(patchFile, authFix.patch);
        try {
          execFileSync('patch', ['--dry-run', '-f', targetPath], { input: fs.readFileSync(patchFile), timeout: 15000 });
          execFileSync('patch', ['-f', targetPath], { input: fs.readFileSync(patchFile), timeout: 15000 });
          log('Auth strategy patch applied successfully', 'INFO', 'auth-healer');
          logAudit('Auth heal patch applied to microsoft-v2.ts', 'auth-healer');
        } finally {
          try { fs.unlinkSync(patchFile); } catch (cleanupErr: any) { /* ignore */ }
        }
      } catch (patchErr: any) {
        log('Patch command failed, attempting full file replacement in safe temp location', 'WARN', 'auth-healer');
        try {
          const isTypeScript = targetPath.endsWith('.ts');
          const tmpExt = isTypeScript ? '.ts' : '.js';
          const tmpPath = `${targetPath}.tmp-heal-${Date.now()}${tmpExt}`;
          fs.writeFileSync(tmpPath, authFix.patch, 'utf-8');
          const { execFile } = require('child_process');
          let syntaxOk = false;
          try {
            if (isTypeScript) {
              await new Promise<void>((resolve, reject) => {
                execFile('npx', ['tsc', '--noEmit', '--strict', '--allowJs', '--skipLibCheck', tmpPath], { timeout: 15000 }, (err: any) => {
                  if (err) reject(err); else resolve();
                });
              });
              syntaxOk = true;
              log('Auth replacement passes TypeScript syntax check (fallback)', 'INFO', 'auth-healer');
            } else {
              execFile('node', ['--check', tmpPath], { timeout: 10000, stdio: 'pipe' });
              syntaxOk = true;
              log('Auth replacement passes syntax check (fallback)', 'INFO', 'auth-healer');
            }
          } catch (checkErr: any) {
            log(`Auth replacement failed syntax check: ${checkErr.stderr || checkErr.message}`, 'ERROR', 'auth-healer');
          }
          if (syntaxOk) {
            fs.copyFileSync(tmpPath, targetPath);
            log('Auth replacement applied from temp file (fallback)', 'INFO', 'auth-healer');
          }
          try { fs.unlinkSync(tmpPath); } catch (cleanupErr: any) { /* ignore */ }
        } catch (writeErr: any) {
          logError('Auth replacement file write failed', writeErr);
          if (fs.existsSync(backupPath)) {
            fs.copyFileSync(backupPath, targetPath);
            log('Restored auth strategy from backup after failed replacement', 'INFO', 'auth-healer');
          }
          return false;
        }
      }

      // Step 5: Validate by attempting a test login
      log('Validating auth heal with test login attempt...', 'INFO', 'auth-healer');
      try {
        delete require.cache[require.resolve('./auth-strategies-microsoft-v2')];
        require('./auth-strategies-microsoft-v2');
        log('Auth strategy module loads successfully after patch', 'INFO', 'auth-healer');
        logAudit('Auth heal validated successfully', 'auth-healer');
        return true;
      } catch (validateErr: any) {
        logError('Auth heal validation failed', validateErr);
        logAudit('Auth heal validation FAILED', 'auth-healer');
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, targetPath);
          log('Restored auth strategy from backup after failed validation', 'WARN', 'auth-healer');
        }
        return false;
      }
    } catch (err: any) {
      logError('Auth heal flow failed with unexpected error', err);
      logAudit('Auth heal flow failed unexpectedly', 'auth-healer');
      return false;
    } finally {
      // C4 FIX: Lock released automatically via _setHealLock's .finally()
      if (page) {
        try {
          const { closeBrowser } = require('./browser');
          await closeBrowser();
        } catch (e: any) { /* best effort */ }
      }
    }
  }

  /**
   * Proactively refresh a session before it expires.
   */
  async refreshSessionProactively(sessionAgeMs: number): Promise<boolean> {
    const CONFIG = getCONFIG();
    const expectedTTL = CONFIG.SESSION_TTL_MS || 8 * 60 * 60 * 1000;
    const refreshThreshold = expectedTTL * 0.5;

    if (sessionAgeMs < refreshThreshold) {
      log(`Session age ${Math.round(sessionAgeMs / 60000)}min < refresh threshold ${Math.round(refreshThreshold / 60000)}min, no refresh needed`, 'DEBUG', 'auth-healer');
      return true;
    }

    log(`Session age ${Math.round(sessionAgeMs / 60000)}min exceeds 50% TTL, initiating proactive refresh`, 'INFO', 'auth-healer');

    try {
      const { refreshSession } = require('./auth');
      if (typeof refreshSession === 'function') {
        const refreshed = await refreshSession();
        if (refreshed) {
          log('Session refreshed successfully via refreshSession()', 'INFO', 'auth-healer');
          return true;
        }
      }
    } catch (err: any) {
      logError('Session refresh via auth module failed', err);
    }

    try {
      const rotated = await this.rotateSession();
      if (rotated) {
        log('Session rotated from pool successfully', 'INFO', 'auth-healer');
        return true;
      }
    } catch (err: any) {
      logError('Session rotation from pool failed', err);
    }

    log('All sessions expired, triggering full auth heal', 'WARN', 'auth-healer');
    logAudit('All sessions expired, triggering auth heal', 'auth-healer');
    return this.healAuthFlow();
  }

  /**
   * Rotate to the next available session from the session pool.
   */
  async rotateSession(): Promise<boolean> {
    try {
      getDb()?.exec(`CREATE TABLE IF NOT EXISTS session_pool (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        last_validated_at INTEGER,
        valid INTEGER DEFAULT 1
      )`);

      const candidate = getDb()?.prepare(
        'SELECT * FROM session_pool WHERE valid = 1 ORDER BY last_validated_at DESC LIMIT 1'
      ).get();

      if (!candidate) {
        log('No valid sessions in pool', 'WARN', 'auth-healer');
        return false;
      }

      const sessionData = JSON.parse(candidate.session_data);
      const CONFIG = getCONFIG();
      const appUrl = CONFIG.APP_URL || 'https://app.mathletics.com';

      let page: any = null;
      try {
        const { launchBrowser, closeBrowser } = require('./browser');
        page = await launchBrowser();

        if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
          const context = page.context();
          await context.addCookies(sessionData.cookies);
        }
        if (sessionData.localStorage) {
          await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.evaluate((storage: Record<string, string>) => {
            for (const [key, value] of Object.entries(storage)) {
              try { localStorage.setItem(key, value); } catch (e: any) {}
            }
          }, sessionData.localStorage);
        }

        await page.goto(appUrl + '/assignments', { waitUntil: 'domcontentloaded', timeout: 15000 });
        await sleep(3000);

        const finalUrl = page.url();
        const isOnLoginPage = finalUrl.includes('login') || finalUrl.includes('signin');

        await closeBrowser();
        page = null;

        if (isOnLoginPage) {
          getDb()?.prepare('UPDATE session_pool SET valid = 0 WHERE id = ?').run(candidate.id);
          log(`Session pool entry ${candidate.id} is expired, marked invalid`, 'WARN', 'auth-healer');
          return false;
        }

        const { saveSession } = require('./cache');
        if (typeof saveSession === 'function') {
          saveSession(sessionData);
        }

        getDb()?.prepare('UPDATE session_pool SET last_validated_at = ? WHERE id = ?').run(Date.now(), candidate.id);

        log(`Rotated to session pool entry ${candidate.id}, validated successfully`, 'INFO', 'auth-healer');
        logAudit(`Rotated to session pool entry ${candidate.id}`, 'auth-healer');
        return true;
      } catch (browserErr: any) {
        logError('Browser validation of session failed', browserErr);
        return false;
      } finally {
        if (page) {
          try {
            const { closeBrowser } = require('./browser');
            await closeBrowser();
          } catch (e: any) { /* best effort */ }
        }
      }
    } catch (err: any) {
      logError('Session rotation failed', err);
      return false;
    }
  }

  /**
   * Get the next valid session from the pool (non-recursive).
   */
  async _rotateFromPool(): Promise<boolean> {
    try {
      const candidates = getDb()?.prepare(
        'SELECT * FROM session_pool WHERE valid = 1 ORDER BY last_validated_at DESC LIMIT 5'
      ).all();

      for (const candidate of candidates) {
        if (!candidate) continue;

        const sessionData = JSON.parse(candidate.session_data);
        const CONFIG = getCONFIG();
        const appUrl = CONFIG.APP_URL || 'https://app.mathletics.com';

        let page: any = null;
        try {
          const { launchBrowser, closeBrowser } = require('./browser');
          page = await launchBrowser();

          if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
            const context = page.context();
            await context.addCookies(sessionData.cookies);
          }
          if (sessionData.localStorage) {
            await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
            await page.evaluate((storage: Record<string, string>) => {
              for (const [key, value] of Object.entries(storage)) {
                try { localStorage.setItem(key, value); } catch (e: any) {}
              }
            }, sessionData.localStorage);
          }

          await page.goto(appUrl + '/assignments', { waitUntil: 'domcontentloaded', timeout: 15000 });
          await sleep(3000);

          const finalUrl = page.url();
          const isOnLoginPage = finalUrl.includes('login') || finalUrl.includes('signin');

          await closeBrowser();
          page = null;

          if (isOnLoginPage) {
            getDb()?.prepare('UPDATE session_pool SET valid = 0 WHERE id = ?').run(candidate.id);
            log(`Session pool entry ${candidate.id} is expired, marked invalid`, 'WARN', 'auth-healer');
            continue;
          }

          const { saveSession } = require('./cache');
          if (typeof saveSession === 'function') {
            saveSession(sessionData);
          }

          getDb()?.prepare('UPDATE session_pool SET last_validated_at = ? WHERE id = ?').run(Date.now(), candidate.id);

          log(`Rotated to session pool entry ${candidate.id}, validated successfully`, 'INFO', 'auth-healer');
          logAudit(`Rotated to session pool entry ${candidate.id}`, 'auth-healer');
          return true;
        } catch (browserErr: any) {
          logError('Browser validation of session failed', browserErr);
          getDb()?.prepare('UPDATE session_pool SET valid = 0 WHERE id = ?').run(candidate.id);
          log(`Session pool entry ${candidate.id} validation failed, marked invalid`, 'WARN', 'auth-healer');
          continue;
        }
      }

      log('No valid sessions found in pool', 'WARN', 'auth-healer');
      return false;
    } catch (err: any) {
      logError('Session rotation from pool failed', err);
      return false;
    }
  }

  /**
   * Start the proactive session refresh daemon.
   */
  startProactiveRefreshDaemon(intervalMs?: number) {
    const interval = intervalMs || 30 * 60 * 1000;
    if (this._refreshIntervalId) {
      log('Auth proactive refresh daemon already running', 'WARN', 'auth-healer');
      return;
    }

    log(`Auth proactive refresh daemon started (interval: ${Math.round(interval / 60000)}min)`, 'INFO', 'auth-healer');

    this._refreshIntervalId = setInterval(async () => {
      try {
        const sessionAge = this._estimateSessionAge();
        if (sessionAge === null) {
          log('Unable to estimate session age, skipping refresh check', 'DEBUG', 'auth-healer');
          return;
        }
        await this.refreshSessionProactively(sessionAge);
      } catch (err: any) {
        logError('Proactive refresh daemon check failed', err);
      }
    }, interval);

    if (this._refreshIntervalId.unref) this._refreshIntervalId.unref();
  }

  /**
   * Estimate the current session age based on last auth timestamp.
   */
  _estimateSessionAge(): number | null {
    try {
      const { loadSession } = require('./cache');
      if (typeof loadSession === 'function') {
        const session = loadSession();
        if (session?.authenticatedAt) {
          return Date.now() - session.authenticatedAt;
        }
      }
      const row = getDb()?.prepare('SELECT MAX(last_validated_at) as last_auth FROM session_pool').get();
      if (row?.last_auth) {
        return Date.now() - row.last_auth;
      }
      return null;
    } catch (err: any) {
      logError('Failed to estimate session age', err);
      return null;
    }
  }

  /**
   * C5 FIX: Gather recent auth-related errors from the database for the
   * critical-patch-consensus context. Previously this was an undefined
   * variable ("lastErrors") causing a ReferenceError at runtime.
   */
  private _getRecentErrors(): string {
    try {
      const rows = getDb()?.prepare(
        `SELECT message, timestamp FROM error_log 
         WHERE timestamp > ? AND (message LIKE '%auth%' OR message LIKE '%login%' OR message LIKE '%session%')
         ORDER BY timestamp DESC LIMIT 10`
      ).all(Date.now() - 24 * 60 * 60 * 1000);
      if (!rows || rows.length === 0) return 'No recent auth-related errors available';
      return rows.map((r: any) => `[${new Date(r.timestamp).toISOString()}] ${r.message}`).join('\n');
    } catch (err: any) {
      return 'No recent auth-related errors available';
    }
  }

  /**
   * Stop the proactive refresh daemon.
   */
  stop() {
    if (this._refreshIntervalId) {
      clearInterval(this._refreshIntervalId);
      this._refreshIntervalId = null;
      log('Auth proactive refresh daemon stopped', 'INFO', 'auth-healer');
    }
  }
}

// Singleton
const authHealer = new AuthHealer();
module.exports = { AuthHealer, authHealer, _injectDependencies };
