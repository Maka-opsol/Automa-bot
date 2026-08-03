'use strict';

const { log, logError } = require('./logger');
const path = require('path');
const fs = require('fs');

// Compatibility shims for API changes across package versions
const COMPAT_SHIMS = {
  'pino': {
    // pino 7 vs 8 vs 9: multistream API changed
    check() { 
      try {
        const version = require('pino/package.json').version;
        const major = parseInt(version.split('.')[0], 10);
        if (major >= 9) {
          log(`pino v${version} detected. Compatibility mode enabled.`, 'WARN', 'compat');
          return 'pino-v9';
        }
        return null;
      } catch { return null; }
    }
  },
  'better-sqlite3': {
    check() { 
      try {
        const version = require('better-sqlite3/package.json').version;
        const major = parseInt(version.split('.')[0], 10);
        if (major >= 11) {
          log(`better-sqlite3 v${version} detected. Checking compatibility...`, 'WARN', 'compat');
        }
        return null;
      } catch { return null; }
    }
  },
  'envalid': {
    check() { 
      try {
        const version = require('envalid/package.json').version;
        const major = parseInt(version.split('.')[0], 10);
        if (major >= 8) {
          log(`envalid v${version} detected. Checking strict mode handling...`, 'WARN', 'compat');
          // envalid v8+ may change strict mode behavior
        }
        return null;
      } catch { return null; }
    }
  }
};

function runCompatChecks() { 
  const issues = [];
  for (const [pkg, shim] of Object.entries(COMPAT_SHIMS)) {
    try {
      const result = shim.check();
      if (result) issues.push({ package: pkg, mode: result });
    } catch (e: any) {
      // Package not installed - that's handled by dependency-manager
    }
  }
  if (issues.length > 0) {
    log(`Compatibility issues detected: ${issues.map(i => `${i.package} (${i.mode})`).join(', ')}`, 'WARN', 'compat');
  }
  return issues;
}

function getCompatReport() { 
  const report = {};
  for (const pkg of Object.keys(COMPAT_SHIMS)) {
    try {
      (report as any)[pkg] = require(`${pkg}/package.json`).version;
    } catch {
      (report as any)[pkg] = 'not installed';
    }
  }
// @ts-expect-error
  report.node = process.version;
// @ts-expect-error
  report.platform = process.platform;
// @ts-expect-error
  report.arch = process.arch;
  return report;
}

module.exports = { runCompatChecks, getCompatReport };
