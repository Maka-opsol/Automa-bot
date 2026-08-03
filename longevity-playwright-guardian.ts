'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }
function getUpsertRuntimeVersion() { return _deps.database?.upsertRuntimeVersion; }

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, logError } = require('./logger');
const PLAYWRIGHT_LOCK_FILE = path.join(PROJECT_ROOT, '.playwright-lock.json');
const PLAYWRIGHT_MAJOR_VERSIONS_URL = 'https://registry.npmjs.org/playwright';
const UPGRADE_CHECK_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // Check weekly

let _lastUpgradeCheck = 0;
let _currentPwVersion = null;

function getPwVersion() { 
  try { return require('playwright/package.json').version; } catch { return null; }
}

function getChromiumRevision() { 
  try {
    const pw = require('playwright');
    return pw.chromium.name() + '@' + (pw.chromium.revision() || 'unknown');
  } catch { return null; }
}

function saveLockfile() { 
  const version = getPwVersion();
  const chromium = getChromiumRevision();
  if (!version) return;
  const lock = {
    playwrightVersion: version,
    chromiumRevision: chromium,
    nodeVersion: process.version,
    lockedAt: new Date().toISOString(),
    lastUpgradeCheck: _lastUpgradeCheck,
  };
  try {
    fs.writeFileSync(PLAYWRIGHT_LOCK_FILE, JSON.stringify(lock, null, 2));
    log(`Playwright lockfile saved: pw@${version}, ${chromium}`, 'DEBUG', 'pw-guardian');
    getUpsertRuntimeVersion()?.run('playwright', version, Date.now());
    getUpsertRuntimeVersion()?.run('chromium', chromium, Date.now());
  } catch (e: any) { logError('Failed to save playwright lockfile', e); }
}

function loadLockfile() { 
  try {
    if (!fs.existsSync(PLAYWRIGHT_LOCK_FILE)) return null;
    return JSON.parse(fs.readFileSync(PLAYWRIGHT_LOCK_FILE, 'utf8'));
  } catch { return null; }
}

async function checkAndUpgradePlaywright() { 
  if (Date.now() - _lastUpgradeCheck < UPGRADE_CHECK_INTERVAL_MS) return;
  _lastUpgradeCheck = Date.now();
  _currentPwVersion = getPwVersion();

  // Check if current browser binary actually works
  try {
    require('playwright').chromium.executablePath();
    log('Chromium binary verified.', 'DEBUG', 'pw-guardian');
  } catch (e: any) {
    log('Chromium binary missing or broken. Reinstalling...', 'WARN', 'pw-guardian');
    try {
      execSync('npx playwright install chromium --with-deps', { stdio: 'inherit', timeout: 180000 });
      log('Chromium reinstalled successfully.', 'INFO', 'pw-guardian');
    } catch (e2: any) {
      try { execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 180000 }); }
      catch (e3: any) { logError('Chromium reinstall failed', e3); }
    }
    saveLockfile();
    return;
  }

  // Check if npm has a newer MINOR version (not major - avoid breaking)
  try {
    const currentVersion = _currentPwVersion;
    if (!currentVersion) return;
    const [major, minor] = currentVersion.split('.').map(Number);

    // Check npm for latest version
    const npmVersion = execSync('npm view playwright version --json 2>/dev/null || echo "unknown"', { encoding: 'utf8', timeout: 15000 }).trim().replace(/"/g, '');
    if (npmVersion === 'unknown') return;
    const [npmMajor, npmMinor] = npmVersion.split('.').map((v: any) => parseInt(v, 10));

    if (npmMajor === major && npmMinor > minor) {
      log(`New Playwright ${npmVersion} available (current: ${currentVersion}). Minor upgrade is safe.`, 'INFO', 'pw-guardian');
      // Save recommendation for manual review
      getUpsertCalibration()?.run('recommended_pw_version', npmVersion, Date.now());
      getUpsertCalibration()?.run('recommended_pw_upgrade_reason', `Minor update available: ${currentVersion} -> ${npmVersion}`, Date.now());
    } else if (npmMajor > major) {
      log(`Major Playwright update available: ${npmVersion} (current: ${currentVersion}). Skipping auto-upgrade - manual review needed.`, 'WARN', 'pw-guardian');
      getUpsertCalibration()?.run('recommended_pw_version', npmVersion, Date.now());
      getUpsertCalibration()?.run('recommended_pw_upgrade_reason', `MAJOR update: ${currentVersion} -> ${npmVersion} - manual review required`, Date.now());
    }
  } catch (e: any) { log('Playwright version check failed (non-critical).', 'DEBUG', 'pw-guardian'); }

  saveLockfile();
}

function startPlaywrightGuardian() { 
  log('Playwright guardian started.', 'INFO', 'pw-guardian');
  saveLockfile();
  // Check immediately, then weekly
  checkAndUpgradePlaywright().catch(e => logError('Initial PW check failed', e));
  const interval = setInterval(() => checkAndUpgradePlaywright().catch(e => logError('Periodic PW check failed', e)), UPGRADE_CHECK_INTERVAL_MS);
  if (interval.unref) interval.unref();
  return interval;
}

function getStatus() { 
  return {
    playwrightVersion: getPwVersion(),
    chromiumRevision: getChromiumRevision(),
    nodeVersion: process.version,
    lockfile: loadLockfile(),
    lastUpgradeCheck: _lastUpgradeCheck ? new Date(_lastUpgradeCheck).toISOString() : 'never',
  };
}

module.exports = { startPlaywrightGuardian, checkAndUpgradePlaywright, saveLockfile, loadLockfile, getStatus, getPwVersion, getChromiumRevision, _injectDependencies };
