'use strict';
const { sleep } = require('./utils-sleep');
const { PROJECT_ROOT } = require('./project-root');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

class AuthHealer {
  private _healLock: Promise<void> | null = null;
  private _refreshIntervalId: any = null;
  private _failureCount: number = 0;
  private _healCooldownMs: number = 30 * 60 * 1000;
  private _lastHealTime: number = 0;

  constructor() {}

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

  handleAuthFailure(failureCount: number): boolean {
    const CONFIG = getCONFIG();
    const maxFailures = CONFIG.AUTH_HEALER_MAX_FAILURES || 5;
    this._failureCount = failureCount;

    if (failureCount >= maxFailures) {
      log(`Auth failure count ${failureCount} >= ${maxFailures}, triggering auth self-heal`, 'WARN', 'auth-healer');
      logAudit(`Auth failure threshold reached (${failureCount}/${maxFailures}), initiating heal`, 'auth-healer');

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

  async healAuthFlow(): Promise<boolean> {
    if (this._healLock) {
      log('healAuthFlow called while lock is held, returning false', 'WARN', 'auth-healer');
      return false;
    }
    this._lastHealTime = Date.now();

    let page: any = null;
    try {
      log('Starting auth flow investigation...', 'INFO', 'auth-healer');

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

      // FIX: Check for MFA BEFORE burning browser+AI resources on codegen.
      const mfaCheck = await this._checkForMfa(page, currentUrl, screenshotBase64);
      if (mfaCheck.detected) {
        await closeBrowser();
        page = null;
        log(`MFA detected during auth heal: ${mfaCheck.detail}. Alerting and entering DORMANT.`, 'ERROR', 'auth-healer');
        try { (_deps.alerting?.sendAlert || (() => {}))('MFA detected during auth heal: ' + mfaCheck.detail + '. Human intervention needed.', 1); } catch {}
        try {
          const { degradationLadder } = require('./self-heal-degradation-ladder');
          degradationLadder.setLevel(4, 'MFA_DETECTED: ' + mfaCheck.detail);
        } catch {}
        logAudit(`MFA detected, entering DORMANT: ${mfaCheck.detail}`, 'auth-healer');
        return false;
      }

      await closeBrowser();
      page = null;

      // FIX: Check degradation level before attempting codegen.
      // At CONSERVING+ (level 2+), codegen tribunal is disabled.
      // Use a lightweight fallback instead of failing immediately.
      let currentLevel = 0;
      try {
        const { degradationLadder } = require('./self-heal-degradation-ladder');
        currentLevel = degradationLadder.getCurrentLevel();
      } catch {}

      if (currentLevel >= 2) {
        log(`Auth heal at degradation level ${currentLevel} — using lightweight fallback (codegen disabled)`, 'WARN', 'auth-healer');
        return this._lightweightAuthHeal(screenshotBase64, html, currentUrl);
      }

      // ── Full codegen path (only at FULL or REDUCED) ──
      const investigation = {
        screenshot: screenshotBase64,
        html,
        url: currentUrl,
        fileContent: '',
        targetFile: 'auth-strategies-microsoft-v2.ts',
      };

      const prompt = 'The Microsoft login flow appears to have changed. Analyze the current login page and identify what has changed from the expected flow. ' +
        'Current URL: ' + currentUrl + '\n\n' +
        'Generate a patch for auth-strategies-microsoft-v2.ts to adapt to the new login page structure.';

      let fixes: any[] = [];
      try {
        const { generateCodeFixViaTribunal } = require('./providers-codegen-tribunal');
        fixes = await generateCodeFixViaTribunal(investigation, prompt);
      } catch (tribunalErr: any) {
        logError('Codegen tribunal failed for auth analysis', tribunalErr);
        log('Tribunal failed — falling back to lightweight heal', 'WARN', 'auth-healer');
        return this._lightweightAuthHeal(screenshotBase64, html, currentUrl);
      }

      if (!fixes || fixes.length === 0) {
        log('No auth fixes generated by tribunal — trying lightweight fallback', 'WARN', 'auth-healer');
        return this._lightweightAuthHeal(screenshotBase64, html, currentUrl);
      }

      const authFix = fixes.find((f: any) => f.file === 'auth-strategies-microsoft-v2.ts') || fixes[0];
      if (!authFix) {
        log('No applicable auth fix found — trying lightweight fallback', 'WARN', 'auth-healer');
        return this._lightweightAuthHeal(screenshotBase64, html, currentUrl);
      }

      let approved = false;
      try {
        const consensus = require('./critical-patch-consensus');
        const result = await consensus.requestCriticalPatch({
          targetFile: 'auth-strategies-microsoft-v2.ts',
          description: 'Auth flow self-heal patch',
          recentErrors: this._getRecentErrors(),
          screenshot: screenshotBase64,
        });
        approved = result.applied;
        log(`Critical patch consensus: ${approved ? 'APPROVED' : 'REJECTED'} - ${result.reason || ''}`, approved ? 'INFO' : 'WARN', 'auth-healer');
      } catch (consensusErr: any) {
        logError('Critical patch consensus unavailable', consensusErr);
        log('Consensus unavailable — falling back to lightweight heal', 'WARN', 'auth-healer');
        return this._lightweightAuthHeal(screenshotBase64, html, currentUrl);
      }

      if (!approved) {
        logAudit('Auth heal patch rejected by consensus — trying lightweight fallback', 'auth-healer');
        return this._lightweightAuthHeal(screenshotBase64, html, currentUrl);
      }

      // Apply the patch (same as original)
      return this._applyAuthPatch(authFix);
    } catch (err: any) {
      logError('Auth heal flow failed with unexpected error', err);
      logAudit('Auth heal flow failed unexpectedly', 'auth-healer');
      return false;
    } finally {
      if (page) {
        try {
          const { closeBrowser } = require('./browser');
          await closeBrowser();
        } catch (e: any) {}
      }
    }
  }

  /**
   * FIX: Lightweight auth healing that does NOT require codegen tribunal.
   * Works at any degradation level (even CONSERVING/SURVIVAL).
   *
   * Strategy:
   *   1. Try OpenRouter directly (always available per user) with a simple prompt
   *   2. If no AI at all, try brute-force selector probing on the login page
   *   3. Update the selector JSON file with any new selectors found
   *   4. If all fails, persist the failure details and alert for human intervention
   */
  async _lightweightAuthHeal(screenshotBase64: string, html: string, url: string): Promise<boolean> {
    log('Starting lightweight auth heal (no codegen required)...', 'INFO', 'auth-healer');

    // Step 1: Try using a single provider (OpenRouter) directly
    try {
      const { callChatCompletionWithRollback, extractJSON } = require('./providers-base');
      const orKey = process.env.OPENROUTER_API_KEY;
      if (orKey) {
        const prompt = `Analyze this Microsoft login page. The URL is: ${url}\n\n` +
          `The current selectors file expects these elements:\n` +
          `- Email input: input[type='email'], input[name='loginfmt']\n` +
          `- Password input: input[type='password'], input[name='passwd']\n` +
          `- Submit button: button[type='submit'], #idSIButton9\n\n` +
          `Based on the HTML structure, tell me if these selectors still work. ` +
          `If any have changed, give me the NEW correct selectors. ` +
          `Respond in JSON format: {"emailInput": "...", "passwordInput": "...", "submitButton": "...", "changed": true/false, "mfaDetected": false, "analysis": "..."}`;

        const raw = await callChatCompletionWithRollback(
          'https://openrouter.ai/api/v1/chat/completions',
          orKey,
          'google/gemini-2.0-flash-001',
          screenshotBase64,
          prompt,
          'auth-heal-lightweight',
          { signal: AbortSignal.timeout(30000) }
        );

        const parsed = extractJSON(raw, 'auth-heal-lightweight');
        if (parsed) {
          log(`Lightweight heal analysis: ${JSON.stringify(parsed).slice(0, 300)}`, 'INFO', 'auth-healer');

          if (parsed.mfaDetected) {
            log('Lightweight heal: MFA detected by AI — alerting', 'ERROR', 'auth-healer');
            try { (_deps.alerting?.sendAlert || (() => {}))('MFA detected by auth healer AI analysis', 1); } catch {}
            return false;
          }

          if (parsed.changed && parsed.emailInput && parsed.passwordInput) {
            // Update selector file
            const fs = require('fs');
            const { PROJECT_ROOT } = require('./project-root');
            const selectorPath = `${PROJECT_ROOT}/selectors-microsoft-login-current.json`;
            try {
              const current = JSON.parse(fs.readFileSync(selectorPath, 'utf8'));
              current.selectors.emailInput = parsed.emailInput;
              current.selectors.passwordInput = parsed.passwordInput;
              if (parsed.submitButton) current.selectors.submitButton = parsed.submitButton;
              current.version = String(Number(current.version) + 1);
              current.lastHealedAt = Date.now();
              current.healAnalysis = parsed.analysis;
              fs.writeFileSync(selectorPath, JSON.stringify(current, null, 2), 'utf8');
              log(`Selector file updated to version ${current.version}`, 'INFO', 'auth-healer');
              logAudit(`Auth selectors updated to v${current.version} via lightweight heal`, 'auth-healer');
              return true;
            } catch (writeErr: any) {
              logError('Failed to write updated selectors', writeErr);
            }
          }

          log('Lightweight heal: selectors still valid (no changes needed)', 'INFO', 'auth-healer');
          return true;
        }
      }
    } catch (aiErr: any) {
      log(`Lightweight heal AI analysis failed: ${aiErr.message}`, 'WARN', 'auth-healer');
    }

    // Step 2: Brute-force selector probe (no AI needed)
    log('Lightweight heal: attempting brute-force selector probe...', 'INFO', 'auth-healer');
    const probeResult = this._probeSelectorsFromHtml(html);
    if (probeResult.updated) {
      log('Lightweight heal: brute-force probe found updated selectors', 'INFO', 'auth-healer');
      logAudit('Auth selectors updated via brute-force probe', 'auth-healer');
      return true;
    }

    // Step 3: Persist failure for diagnostics and alert
    log('Lightweight heal: all methods failed — persisting failure and alerting', 'ERROR', 'auth-healer');
    try {
      getDb()?.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
        .run('auth_heal_last_failure', JSON.stringify({ url, timestamp: Date.now(), methods: ['lightweight_ai', 'brute_force'] }), Date.now());
    } catch {}

    try { (_deps.alerting?.sendAlert || (() => {}))('Auth heal failed at all levels. Human intervention may be required.', 1); } catch {}
    logAudit('Auth heal completely failed — human intervention needed', 'auth-healer');
    return false;
  }

  /**
   * Brute-force probe: scan HTML for common Microsoft login element patterns
   * and update selectors if the expected ones are missing.
   */
  _probeSelectorsFromHtml(html: string): { updated: boolean } {
    const probes = [
      { role: 'emailInput', patterns: ['name="loginfmt"', 'type="email"', 'id="i0116"', 'autocomplete="email"', 'autocomplete="username"', 'placeholder.*email'] },
      { role: 'passwordInput', patterns: ['name="passwd"', 'type="password"', 'id="i0118"', 'autocomplete="current-password"'] },
      { role: 'submitButton', patterns: ['id="idSIButton9"', 'type="submit"', 'value="Next"', 'value="Sign in"'] },
    ];

    const fs = require('fs');
    const { PROJECT_ROOT } = require('./project-root');
    const selectorPath = `${PROJECT_ROOT}/selectors-microsoft-login-current.json`;

    try {
      const current = JSON.parse(fs.readFileSync(selectorPath, 'utf8'));
      let updated = false;

      for (const probe of probes) {
        // Check if current selector still exists in HTML
        const currentSelector = current.selectors[probe.role];
        if (!currentSelector) continue;

        // Extract selector strings (handle comma-separated)
        const selectors = currentSelector.split(',').map((s: string) => s.trim());
        const anyMatch = selectors.some((sel: string) => {
          // Convert CSS selector to a rough HTML search
          if (sel.includes('#')) {
            const id = sel.match(/#([\w-]+)/)?.[1];
            return id && html.includes(`id="${id}"`);
          }
          if (sel.includes('[')) {
            const attr = sel.match(/\[([\w=\"'-]+)\]/)?.[1];
            return attr && html.includes(attr);
          }
          return html.includes(sel);
        });

        if (!anyMatch) {
          // Current selectors don't match — try to find new ones from probe patterns
          for (const pattern of probe.patterns) {
            if (html.includes(pattern)) {
              let newSelector = '';
              if (pattern.startsWith('id="')) {
                const id = pattern.match(/id="([^"]+)"/)?.[1];
                if (id) newSelector = `#${id}`;
              } else if (pattern.startsWith('name="')) {
                const name = pattern.match(/name="([^"]+)"/)?.[1];
                if (name) newSelector = `input[name="${name}"]`;
              } else if (pattern.startsWith('type="')) {
                const type = pattern.match(/type="([^"]+)"/)?.[1];
                if (type) newSelector = `input[type="${type}"]`;
              }

              if (newSelector) {
                log(`Probe found replacement for ${probe.role}: ${newSelector} (pattern: ${pattern})`, 'INFO', 'auth-healer');
                current.selectors[probe.role] = newSelector;
                updated = true;
                break;
              }
            }
          }
        }
      }

      if (updated) {
        current.version = String(Number(current.version) + 1);
        current.lastHealedAt = Date.now();
        fs.writeFileSync(selectorPath, JSON.stringify(current, null, 2), 'utf8');
        log(`Brute-force probe updated selectors to version ${current.version}`, 'INFO', 'auth-healer');
      }

      return { updated };
    } catch (err: any) {
      log(`Brute-force probe failed: ${err.message}`, 'WARN', 'auth-healer');
      return { updated: false };
    }
  }

  /**
   * FIX: Check for MFA without needing AI. Uses URL patterns and HTML content.
   */
  async _checkForMfa(page: any, url: string, _screenshot: string): Promise<{ detected: boolean; detail: string }> {
    // URL-based MFA detection
    const mfaUrlPatterns = ['/saml2', '/mfa', '/proofup', '/strongauth', '/convergedlogin/MFA'];
    for (const p of mfaUrlPatterns) {
      if (url.includes(p)) {
        return { detected: true, detail: `MFA URL pattern detected: ${p}` };
      }
    }

    // Content-based MFA detection
    try {
      const mfaIndicators = await page.evaluate(() => {
        const body = document.body?.innerText || '';
        const lower = body.toLowerCase();
        const mfaPhrases = [
          'approve the sign-in',
          'enter your code',
          'authenticator app',
          'microsoft authenticator',
          'verification code',
          'two-step verification',
          'pick an account',
          'number matching',
        ];
        for (const phrase of mfaPhrases) {
          if (lower.includes(phrase)) return phrase;
        }
        // Check for MFA-specific input fields
        const otpInput = document.querySelector('input[inputmode="numeric"][maxlength="6"], input[autocomplete="one-time-code"]');
        if (otpInput) return 'OTP input field detected';
        return null;
      }).catch(() => null);

      if (mfaIndicators) {
        return { detected: true, detail: `MFA content detected: ${mfaIndicators}` };
      }
    } catch {}

    return { detected: false, detail: '' };
  }

  /**
   * Apply an auth patch (shared between full codegen and lightweight paths).
   */
  async _applyAuthPatch(authFix: any): Promise<boolean> {
    const fs = require('fs');
    const pathModule = require('path');
    const { PROJECT_ROOT } = require('./project-root');
    const targetBase = pathModule.join(PROJECT_ROOT, 'auth-strategies-microsoft-v2');
    const targetPath = fs.existsSync(targetBase + '.ts') ? targetBase + '.ts' : targetBase + '.js';

    if (!fs.existsSync(targetPath)) {
      log(`Auth strategy file not found: ${targetPath}`, 'ERROR', 'auth-healer');
      return false;
    }

    // Backup
    try {
      const dir = pathModule.dirname(targetPath);
      const baseName = pathModule.basename(targetPath);
      const oldBackups = fs.readdirSync(dir).filter((f: string) => f.startsWith(`${baseName}.backup-`));
      for (const old of oldBackups.slice(0, -5)) { try { fs.unlinkSync(pathModule.join(dir, old)); } catch {} }
    } catch {}

    const backupPath = targetPath + `.backup-${Date.now()}`;
    try {
      fs.copyFileSync(targetPath, backupPath);
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
        try { fs.unlinkSync(patchFile); } catch {}
      }
    } catch (patchErr: any) {
      log('Patch command failed, attempting full file replacement', 'WARN', 'auth-healer');
      try {
        const isTypeScript = targetPath.endsWith('.ts');
        const tmpExt = isTypeScript ? '.ts' : '.js';
        const tmpPath = `${targetPath}.tmp-heal-${Date.now()}${tmpExt}`;
        fs.writeFileSync(tmpPath, authFix.patch, 'utf8');
        let syntaxOk = false;
        try {
          if (isTypeScript) {
            await new Promise<void>((resolve, reject) => {
              require('child_process').execFile('npx', ['tsc', '--noEmit', '--strict', '--allowJs', '--skipLibCheck', tmpPath], { timeout: 15000 }, (err: any) => {
                if (err) reject(err); else resolve();
              });
            });
            syntaxOk = true;
          } else {
            require('child_process').execFile('node', ['--check', tmpPath], { timeout: 10000, stdio: 'pipe' });
            syntaxOk = true;
          }
        } catch {}
        if (syntaxOk) {
          fs.copyFileSync(tmpPath, targetPath);
          log('Auth replacement applied (fallback)', 'INFO', 'auth-healer');
        }
        try { fs.unlinkSync(tmpPath); } catch {}
      } catch (writeErr: any) {
        logError('Auth replacement file write failed', writeErr);
        if (fs.existsSync(backupPath)) {
          fs.copyFileSync(backupPath, targetPath);
          log('Restored auth strategy from backup', 'INFO', 'auth-healer');
        }
        return false;
      }
    }

    // Validate
    try {
      delete require.cache[require.resolve('./auth-strategies-microsoft-v2')];
      require('./auth-strategies-microsoft-v2');
      log('Auth strategy module loads successfully after patch', 'INFO', 'auth-healer');
      logAudit('Auth heal validated successfully', 'auth-healer');
      return true;
    } catch (validateErr: any) {
      logError('Auth heal validation failed', validateErr);
      if (fs.existsSync(backupPath)) {
        fs.copyFileSync(backupPath, targetPath);
        log('Restored auth strategy from backup after failed validation', 'WARN', 'auth-healer');
      }
      return false;
    }
  }

  async refreshSessionProactively(sessionAgeMs: number): Promise<boolean> {
    const CONFIG = getCONFIG();
    const expectedTTL = CONFIG.SESSION_TTL_MS || 8 * 60 * 60 * 1000;
    const refreshThreshold = expectedTTL * 0.5;

    if (sessionAgeMs < refreshThreshold) {
      log(`Session age ${Math.round(sessionAgeMs / 60000)}min < threshold ${Math.round(refreshThreshold / 60000)}min, no refresh`, 'DEBUG', 'auth-healer');
      return true;
    }

    log(`Session age ${Math.round(sessionAgeMs / 60000)}min exceeds 50% TTL, initiating proactive refresh`, 'INFO', 'auth-healer');

    try {
      const { refreshSession } = require('./auth');
      if (typeof refreshSession === 'function') {
        const refreshed = await refreshSession();
        if (refreshed) {
          log('Session refreshed successfully', 'INFO', 'auth-healer');
          return true;
        }
      }
    } catch (err: any) {
      logError('Session refresh failed', err);
    }

    try {
      const rotated = await this.rotateSession();
      if (rotated) {
        log('Session rotated from pool', 'INFO', 'auth-healer');
        return true;
      }
    } catch (err: any) {
      logError('Session rotation failed', err);
    }

    log('All sessions expired, triggering full auth heal', 'WARN', 'auth-healer');
    logAudit('All sessions expired, triggering auth heal', 'auth-healer');
    return this.healAuthFlow();
  }

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
      const appUrl = CONFIG.APP_URL || 'https://app.mathu.co.za';

      let page: any = null;
      try {
        const { launchBrowser, closeBrowser } = require('./browser');
        page = await launchBrowser();

        if (sessionData.cookies && Array.isArray(sessionData.cookies)) {
          await page.context().addCookies(sessionData.cookies);
        }
        if (sessionData.localStorage) {
          await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });
          await page.evaluate((storage: Record<string, string>) => {
            for (const [key, value] of Object.entries(storage)) {
              try { localStorage.setItem(key, value); } catch {}
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
          log(`Session pool entry ${candidate.id} expired, marked invalid`, 'WARN', 'auth-healer');
          return false;
        }

        const { saveSession } = require('./cache');
        if (typeof saveSession === 'function') saveSession(sessionData);

        getDb()?.prepare('UPDATE session_pool SET last_validated_at = ? WHERE id = ?').run(Date.now(), candidate.id);
        log(`Rotated to session pool entry ${candidate.id}`, 'INFO', 'auth-healer');
        logAudit(`Rotated to session pool entry ${candidate.id}`, 'auth-healer');
        return true;
      } catch (browserErr: any) {
        logError('Browser validation of session failed', browserErr);
        return false;
      } finally {
        if (page) {
          try { const { closeBrowser } = require('./browser'); await closeBrowser(); } catch {}
        }
      }
    } catch (err: any) {
      logError('Session rotation failed', err);
      return false;
    }
  }

  startProactiveRefreshDaemon(intervalMs?: number) {
    const interval = intervalMs || 30 * 60 * 1000;
    if (this._refreshIntervalId) return;

    log(`Auth proactive refresh daemon started (interval: ${Math.round(interval / 60000)}min)`, 'INFO', 'auth-healer');

    this._refreshIntervalId = setInterval(async () => {
      try {
        const sessionAge = this._estimateSessionAge();
        if (sessionAge === null) return;
        await this.refreshSessionProactively(sessionAge);
      } catch (err: any) {
        logError('Proactive refresh daemon check failed', err);
      }
    }, interval);

    if (this._refreshIntervalId.unref) this._refreshIntervalId.unref();
  }

  _estimateSessionAge(): number | null {
    try {
      const { loadSession } = require('./cache');
      if (typeof loadSession === 'function') {
        const session = loadSession();
        if (session?.authenticatedAt) return Date.now() - session.authenticatedAt;
      }
      try { getDb()?.exec('ALTER TABLE session_pool ADD COLUMN last_validated_at INTEGER'); } catch {}
      const row = getDb()?.prepare('SELECT MAX(last_validated_at) as last_auth FROM session_pool').get();
      if (row?.last_auth) return Date.now() - row.last_auth;
      return null;
    } catch (err: any) {
      return null;
    }
  }

  private _getRecentErrors(): string {
    try {
      const rows = getDb()?.prepare(
        `SELECT message, timestamp FROM error_log 
         WHERE timestamp > ? AND (message LIKE '%auth%' OR message LIKE '%login%' OR message LIKE '%session%')
         ORDER BY timestamp DESC LIMIT 10`
      ).all(Date.now() - 24 * 60 * 60 * 1000);
      if (!rows || rows.length === 0) return 'No recent auth-related errors available';
      return rows.map((r: any) => `[${new Date(r.timestamp).toISOString()}] ${r.message}`).join('\n');
    } catch {
      return 'No recent auth-related errors available';
    }
  }

  stop() {
    if (this._refreshIntervalId) {
      clearInterval(this._refreshIntervalId);
      this._refreshIntervalId = null;
      log('Auth proactive refresh daemon stopped', 'INFO', 'auth-healer');
    }
  }
}

const authHealer = new AuthHealer();
module.exports = { AuthHealer, authHealer, _injectDependencies };
