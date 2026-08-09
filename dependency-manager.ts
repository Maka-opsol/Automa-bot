'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Dependencies that are optional - bot works without them
const OPTIONAL_DEPS = new Set([
  'onnxruntime-node',
  '@xenova/transformers',
  'sharp',
  'tesseract.js',
  'node-telegram-bot-api',
  'nodemailer',
]);

// Type-only packages (prefixed with @types/) are never needed at runtime.
// They provide TypeScript definitions only — skip require.resolve() for these.
const isTypesOnly = (dep: string) => dep.startsWith('@types/');

function checkDependencies() { 
  const pkg = require('./package.json');
  const deps = { ...pkg.dependencies, ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
  const missing = [];
  const missingOptional = [];
  for (const dep of Object.keys(deps)) {
    if (isTypesOnly(dep)) continue; // Skip @types/* packages (type definitions only, never needed at runtime)
    try { require.resolve(dep); } catch (e: any) {
      if (OPTIONAL_DEPS.has(dep)) {
        missingOptional.push(dep);
      } else {
        missing.push(dep);
      }
    }
  }
  return { missing, missingOptional };
}

function installDependencies() { 
  log('📦 Installing missing dependencies...', 'INFO', 'deps');
  try {
    execSync('npm install --production --no-audit --no-fund', { stdio: 'inherit', timeout: 180000 });
    log('✅ Dependencies installed successfully.', 'INFO', 'deps');
  } catch (err: any) {
    logError('Dependency installation failed', err);
    log('⚠️ Some dependencies failed to install. Bot may have limited functionality.', 'WARN', 'deps');
  }
}

function ensurePlaywrightBrowsers() { 
  try {
    const pw = require('playwright');
    try {
      pw.chromium.executablePath();
      log('✅ Playwright Chromium already installed.', 'DEBUG', 'deps');
    } catch (e: any) {
      log('⚠️ Playwright Chromium not found. Installing...', 'WARN', 'deps');
      try {
        execSync('npx playwright install chromium --with-deps', { stdio: 'inherit', timeout: 180000 });
        log('✅ Playwright Chromium installed successfully.', 'INFO', 'deps');
      } catch (installErr: any) {
        log('⚠️ Playwright install with --with-deps failed, trying without...', 'WARN', 'deps');
        try {
          execSync('npx playwright install chromium', { stdio: 'inherit', timeout: 180000 });
          log('✅ Playwright Chromium installed (without system deps).', 'INFO', 'deps');
        } catch (err: any) {
          logError('Playwright browser install failed. Browser launch may fail.', err);
        }
      }
    }
  } catch (e: any) {
    logError('Playwright module not available', e);
  }
}

function ensureDependencies() { 
  const { missing, missingOptional } = checkDependencies();
  if (missing.length === 0 && missingOptional.length === 0) {
    log('✅ All dependencies are present.', 'DEBUG', 'deps');
  } else {
    if (missingOptional.length > 0) {
      log(`ℹ️ Optional deps missing (non-fatal): ${missingOptional.join(', ')}`, 'INFO', 'deps');
    }
    if (missing.length > 0) {
      // Use injected config first; fall back to require only if DI not available
      const config = _deps.config || require('./get-config');
      if (config.SANDBOX_MODE) {
        log(`❌ Sandbox mode: missing required dependencies: ${missing.join(', ')}. Exiting.`, 'ERROR', 'deps');
        process.exit(1);
      }
      if (config.AUTO_INSTALL_DEPENDENCIES) {
        installDependencies();
      } else {
        log(`⚠️ Missing dependencies: ${missing.join(', ')}. Set AUTO_INSTALL_DEPENDENCIES=true to auto-install.`, 'WARN', 'deps');
      }
    }
  }
  // Always ensure Playwright browsers are available
  ensurePlaywrightBrowsers();
}

module.exports = { ensureDependencies, ensurePlaywrightBrowsers, _injectDependencies };
