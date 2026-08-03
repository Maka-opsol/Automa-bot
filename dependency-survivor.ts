'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const MIN_NODE_VERSION = [18, 0, 0];

class DependencySurvivor {
  requiredNodeVersion: string | null = null; // Declared property — No longer force a specific version

  constructor() {
    // Initialization handled by property default above
  }

  checkAndFix() { 
    // Check Node.js version (minimum 18, no forced version)
    const current = process.version.replace('v', '').split('.').map(Number);
    if (current[0] < MIN_NODE_VERSION[0] || (current[0] === MIN_NODE_VERSION[0] && current[1] < MIN_NODE_VERSION[1])) {
      log(`⚠️ Node version ${process.version} is below minimum v${MIN_NODE_VERSION.join('.')}. Things may not work correctly.`, 'WARN', 'deps');
    } else {
      log(`✅ Node.js version ${process.version} meets minimum requirement.`, 'DEBUG', 'deps');
    }

    // Check Playwright browsers
    try {
      require.resolve('playwright');
      try { require('playwright').chromium.executablePath(); log('✅ Playwright Chromium found.', 'DEBUG', 'deps'); }
      catch (e: any) {
        log('⚠️ Playwright drivers missing. Installing...', 'WARN', 'deps');
        this.installPlaywrightBrowsers();
      }
    } catch (e: any) {
      log('⚠️ Playwright package not installed. Run: npm install playwright', 'WARN', 'deps');
    }

    // Check sharp (optional)
    try { require('sharp'); log('✅ Sharp module loaded.', 'DEBUG', 'deps'); }
    catch (e: any) { log('⚠️ Sharp not available. Screenshot compression disabled.', 'WARN', 'deps'); }

    // Check optional heavy deps gracefully
    const optionalDeps = ['onnxruntime-node', '@xenova/transformers'];
    for (const dep of optionalDeps) {
      try { require(dep); log(`✅ ${dep} loaded.`, 'DEBUG', 'deps'); }
      catch (e: any) { log(`ℹ️ ${dep} not available (optional - some features disabled).`, 'INFO', 'deps'); }
    }

    log('✅ Dependency survivor check passed.', 'INFO', 'deps');
  }

  installPlaywrightBrowsers() { 
    try {
      // Try installing just chromium (smallest, what we need)
      execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 120000 });
      log('✅ Playwright Chromium installed successfully.', 'INFO', 'deps');
    } catch (e: any) {
      log('⚠️ Playwright browser install failed. The bot will try again on launch.', 'WARN', 'deps');
    }
  }
}

module.exports = Object.assign(new DependencySurvivor(), { _injectDependencies });