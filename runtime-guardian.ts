'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { log, logError } = require('./logger');
const { fetchJSON } = require('./utils-fetch');
const { upsertRuntimeVersion } = require('./database');

class RuntimeGuardian {
  manifestUrl: any;
  checkInterval: any;
  versions: any;
  _checkTimer: any;
  _injectDependencies: any;

  constructor() {
    if (!getCONFIG().RUNTIME_MANIFEST_URL || getCONFIG().RUNTIME_MANIFEST_URL.includes('example.com')) {
      log('Runtime Guardian disabled: no valid RUNTIME_MANIFEST_URL configured', 'INFO', 'guardian');
      return;
    }
    this.manifestUrl = getCONFIG().RUNTIME_MANIFEST_URL;
    this.checkInterval = 24 * 60 * 60 * 1000;
    this.versions = {};
  }

  async start() { 
    if (!this.manifestUrl) {
      log('Runtime Guardian not configured, skipping start', 'DEBUG', 'guardian');
      return;
    }
    log('Runtime Guardian starting...', 'INFO', 'guardian');
    await this.checkAndUpgrade();
    this._checkTimer = setInterval(() => this.checkAndUpgrade(), this.checkInterval); if (this._checkTimer && this._checkTimer.unref) this._checkTimer.unref();
  }

  async checkAndUpgrade() { 
    try {
      const manifest = await fetchJSON(this.manifestUrl, {}, 10000);
      const requiredNode = manifest.node;
      const requiredPlaywright = manifest.playwright;
      const currentNode = process.version;
      const currentSemver = currentNode.replace(/^v/, '');
      const requiredSemver = (requiredNode || '').replace(/^v/, '');
      if (currentSemver !== requiredSemver) {
        log(`Node version mismatch: ${currentNode} vs ${requiredNode}. Upgrading...`, 'WARN', 'guardian');
        this.upgradeNode(requiredNode);
      }
      const currentPW = require('playwright/package.json').version;
      if (currentPW !== requiredPlaywright) {
        log(`Playwright version mismatch: ${currentPW} vs ${requiredPlaywright}. Upgrading...`, 'WARN', 'guardian');
        this.upgradePlaywright(requiredPlaywright);
      }
      if (requiredNode) upsertRuntimeVersion.run('node', requiredNode, Date.now());
      if (requiredPlaywright) upsertRuntimeVersion.run('playwright', requiredPlaywright, Date.now());
    } catch (e: any) { logError('Runtime check failed', e); }
  }

  upgradeNode(version: any) { 
    const APPROVED_LTS_VERSIONS = new Set(['v18.20.0', 'v18.20.1', 'v18.20.2', 'v18.20.3', 'v18.20.4', 'v18.20.5', 'v18.19.0', 'v18.19.1', 'v20.18.0', 'v20.18.1', 'v20.18.2', 'v20.17.0', 'v20.16.0', 'v20.15.0', 'v20.14.0', 'v22.12.0', 'v22.11.0', 'v22.10.0', 'v22.9.0']);
    try {
      if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
        log(`Invalid version format from manifest: ${version}`, 'ERROR', 'runtime-guardian');
        return;
      }
      const versionPrefix = 'v' + version;
      if (!APPROVED_LTS_VERSIONS.has(versionPrefix)) {
        log(`Version ${version} is not in the approved LTS allowlist, skipping auto-upgrade`, 'WARN', 'runtime-guardian');
        return;
      }
      log(`Node version mismatch detected. Manual upgrade may be required.`, 'WARN', 'guardian');
    } catch (e: any) { logError('Node upgrade check failed', e); }
  }

  upgradePlaywright(version: any) { 
    try {
      if (!version || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version)) {
        log(`Invalid version format from manifest: ${version}`, 'ERROR', 'runtime-guardian');
        return;
      }
      execSync(`npm install playwright@${version} && npx playwright install`, { stdio: 'inherit', timeout: 180000 });
      log(`Upgraded Playwright to ${version}.`, 'INFO', 'guardian');
    } catch (e: any) { logError('Playwright upgrade failed', e); }
  }
}

const _runtimeGuardianInstance = new RuntimeGuardian();
_runtimeGuardianInstance._injectDependencies = _injectDependencies;
module.exports = _runtimeGuardianInstance;