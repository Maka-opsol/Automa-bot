'use strict';

// ═══════════════════════════════════════════════
// Runtime Guardian — Checks for Node.js and Playwright version
// mismatches against a remote manifest. Auto-upgrades only
// approved LTS versions.
//
// Render-aware: Auto-upgrade is DISABLED on Render (ephemeral disk,
// no persistent npm install). Only version CHECK and logging.
// ═══════════════════════════════════════════════

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function _getCONFIG(): Record<string, any> {
  return _deps.config || (() => { try { return require('./get-config'); } catch { return {}; } })();
}

const { log, logError } = require('./logger');

// BUG FIX (Response 19): Lazy-load heavy modules
const _lazyModules = {
  fetchJSON: () => require('./utils-fetch').fetchJSON,
  upsertRuntimeVersion: () => require('./database').upsertRuntimeVersion,
};

// ═══════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════

/** Default check interval: 24 hours */
const DEFAULT_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Timeout for manifest fetch (ms) */
const MANIFEST_FETCH_TIMEOUT_MS = 10 * 1000;

/** BUG FIX (Response 19): On Render, check interval is 48h (no auto-upgrade anyway) */
const RENDER_CHECK_INTERVAL_MS = 48 * 60 * 60 * 1000;

/** Render detection */
function _isRender(): boolean {
  return !!(process.env.RENDER_SERVICE_ID || process.env.RENDER);
}

// ═══════════════════════════════════════════════
// Approved LTS versions for auto-upgrade
// ═══════════════════════════════════════════════

// BUG FIX (Response 19): Extracted to a Set for O(1) lookup and easier maintenance
const APPROVED_LTS_VERSIONS = new Set([
  // Node 18 LTS
  'v18.20.0', 'v18.20.1', 'v18.20.2', 'v18.20.3', 'v18.20.4', 'v18.20.5',
  'v18.19.0', 'v18.19.1',
  // Node 20 LTS
  'v20.18.0', 'v20.18.1', 'v20.18.2',
  'v20.17.0', 'v20.16.0', 'v20.15.0', 'v20.14.0',
  // Node 22 LTS
  'v22.12.0', 'v22.11.0', 'v22.10.0', 'v22.9.0',
]);

// BUG FIX (Response 19): Semver regex extracted to constant
const SEMVER_REGEX = /^[0-9]+\.[0-9]+\.[0-9]+$/;

class RuntimeGuardian {
  manifestUrl: any;
  checkInterval: any;
  versions: any;
  _checkTimer: any;
  _injectDependencies: any;
  _isChecking: boolean;
  _lastCheckAt: number;

  constructor() {
    const config = _getCONFIG();
    if (!config.RUNTIME_MANIFEST_URL || config.RUNTIME_MANIFEST_URL.includes('example.com')) {
      log('Runtime Guardian disabled: no valid RUNTIME_MANIFEST_URL configured', 'INFO', 'guardian');
      return;
    }
    this.manifestUrl = config.RUNTIME_MANIFEST_URL;
    // BUG FIX (Response 19): Longer interval on Render
    this.checkInterval = _isRender() ? RENDER_CHECK_INTERVAL_MS : DEFAULT_CHECK_INTERVAL_MS;
    this.versions = {};
    this._isChecking = false;
    this._lastCheckAt = 0;
  }

  /**
   * Start the periodic version check.
   * BUG FIX (Response 19): Mutex prevents concurrent checks.
   * Timer is .unref()'d to not prevent shutdown.
   */
  async start() {
    if (!this.manifestUrl) {
      log('Runtime Guardian not configured, skipping start', 'DEBUG', 'guardian');
      return;
    }
    log('Runtime Guardian starting...', 'INFO', 'guardian');
    await this.checkAndUpgrade();
    this._checkTimer = setInterval(() => this.checkAndUpgrade(), this.checkInterval);
    if (this._checkTimer && this._checkTimer.unref) this._checkTimer.unref();
  }

  /**
   * Check the manifest for version mismatches.
   * BUG FIX (Response 19): Mutex guard + Render skip for upgrades.
   */
  async checkAndUpgrade() {
    if (this._isChecking) return;
    this._isChecking = true;
    try {
      const fetchJSON = _lazyModules.fetchJSON();
      const upsertRuntimeVersion = _lazyModules.upsertRuntimeVersion();
      if (!fetchJSON || !upsertRuntimeVersion) {
        log('Runtime Guardian: missing dependencies, skipping', 'DEBUG', 'guardian');
        return;
      }

      const manifest = await fetchJSON(this.manifestUrl, {}, MANIFEST_FETCH_TIMEOUT_MS);
      if (!manifest) {
        log('Runtime Guardian: empty manifest', 'WARN', 'guardian');
        return;
      }

      const requiredNode = manifest.node;
      const requiredPlaywright = manifest.playwright;
      const currentNode = process.version;
      const currentSemver = currentNode.replace(/^v/, '');
      const requiredSemver = (requiredNode || '').replace(/^v/, '');

      if (requiredSemver && currentSemver !== requiredSemver) {
        log(`Node version mismatch: ${currentNode} vs ${requiredNode}`, 'WARN', 'guardian');
        // BUG FIX (Response 19): On Render, only log — don't attempt upgrade
        // (ephemeral disk, no persistent npm install)
        if (_isRender()) {
          log('Render: skipping Node auto-upgrade (ephemeral disk)', 'WARN', 'guardian');
        } else {
          this.upgradeNode(requiredNode);
        }
      }

      // Check Playwright version
      try {
        const currentPW = require('playwright/package.json').version;
        if (requiredPlaywright && currentPW !== requiredPlaywright) {
          log(`Playwright version mismatch: ${currentPW} vs ${requiredPlaywright}`, 'WARN', 'guardian');
          if (_isRender()) {
            log('Render: skipping Playwright auto-upgrade (ephemeral disk)', 'WARN', 'guardian');
          } else {
            this.upgradePlaywright(requiredPlaywright);
          }
        }
      } catch (e: any) {
        log('Could not check Playwright version', 'DEBUG', 'guardian');
      }

      // Record versions in DB
      try {
        if (requiredNode) upsertRuntimeVersion.run('node', requiredNode, Date.now());
        if (requiredPlaywright) upsertRuntimeVersion.run('playwright', requiredPlaywright, Date.now());
      } catch (e: any) {
        log('Failed to record runtime versions', 'DEBUG', 'guardian');
      }

      this._lastCheckAt = Date.now();
    } catch (e: any) {
      logError('Runtime check failed', e);
    } finally {
      this._isChecking = false;
    }
  }

  /**
   * Check if a Node.js version is in the approved LTS allowlist.
   * Only versions in this set will be auto-upgraded.
   */
  _isApprovedVersion(version: string): boolean {
    if (!version || !SEMVER_REGEX.test(version)) return false;
    return APPROVED_LTS_VERSIONS.has('v' + version);
  }

  upgradeNode(version: any) {
    try {
      if (!this._isApprovedVersion(version)) {
        log(`Version ${version} is not in the approved LTS allowlist, skipping auto-upgrade`, 'WARN', 'runtime-guardian');
        return;
      }
      log(`Node version mismatch detected. Manual upgrade may be required.`, 'WARN', 'guardian');
    } catch (e: any) { logError('Node upgrade check failed', e); }
  }

  /**
   * Upgrade Playwright to a specific version.
   * BUG FIX (Response 19): Uses execSync with a timeout.
   * Previous code's 180s timeout was fine but had no error context.
   */
  upgradePlaywright(version: any) {
    if (!version || !SEMVER_REGEX.test(version)) {
      log(`Invalid version format from manifest: ${version}`, 'ERROR', 'runtime-guardian');
      return;
    }
    try {
      const { execSync } = require('child_process');
      const cmd = `npm install playwright@${version} && npx playwright install`;
      log(`Upgrading Playwright to ${version}...`, 'INFO', 'guardian');
      execSync(cmd, { stdio: 'inherit', timeout: 180000 });
      log(`Upgraded Playwright to ${version}.`, 'INFO', 'guardian');
    } catch (e: any) {
      logError('Playwright upgrade failed', e);
    }
  }

  /**
   * Get guardian status for monitoring.
   * BUG FIX (Response 19): New diagnostic method.
   */
  getStatus() {
    return {
      configured: !!this.manifestUrl,
      isRunning: this._checkTimer !== null,
      isChecking: this._isChecking,
      lastCheckAt: this._lastCheckAt,
      checkInterval: this.checkInterval,
      isRender: _isRender(),
    };
  }
}

const _runtimeGuardianInstance = new RuntimeGuardian();
_runtimeGuardianInstance._injectDependencies = _injectDependencies;
module.exports = _runtimeGuardianInstance;
