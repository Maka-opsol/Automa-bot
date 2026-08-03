'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, logError } = require('./logger');

const FORBIDDEN_PATTERNS = [
  /child_process/i,
  /exec\s*\(/,
  /spawn\s*\(/,
  /eval\s*\(/,
  /Function\s*\(/,
  /process\.env/i,
  /require\s*\(\s*['"]fs['"]\s*\)/,
  /require\s*\(\s*['"]child_process['"]\s*\)/,
  /http:\/\/[^s]/i,
  /base64\s*decode/i,
  /atob\s*\(/,
  /btoa\s*\(/,
];

const ALLOWED_FILES = new Set([
  'providers-prompts.js',
  'selectors-microsoft-login-current.json',
  'selectors-mathu-app-current.json',
  'state-machine.js',
  'config.js',
  'providers-detection-work-detector.js',
  'providers-detection-captcha-solver.js',
  'providers-detection-signin-button.js',
  'providers-detection-collapsed-cards.js',
  'providers-detection-module-completion.js',
  'providers-detection-captcha-text-extractor.js',
  'cycle-action-executor.js',
  'cycle-stagnation.js',
]);

const BLOCKED_FILES = new Set([
  'agent.js',
  'browser.js',
  'database.js',
  'logger.js',
  'error-handler.js',
  'self-heal.js',
  'self-heal-gitops.js',
  'auth-auth-manager.js',
  'providers-base.js',
  'providers-tribunal.js',
]);

async function validateSuggestion(suggestion: any) { 
  const { file, patch } = suggestion;
  if (!file || typeof file !== 'string') {
    log('Invalid file path in suggestion', 'WARN', 'validator');
    return false;
  }
  if (BLOCKED_FILES.has(file)) {
    log(`Blocked file: ${file}`, 'WARN', 'validator');
    return false;
  }
  if (!ALLOWED_FILES.has(file) && !file.startsWith('selectors-') && !file.startsWith('providers-detection-')) {
    log(`File not in allowed list: ${file}`, 'WARN', 'validator');
    return false;
  }
  if (!patch || typeof patch !== 'string' || patch.length < 5) {
    log('Invalid or empty patch', 'WARN', 'validator');
    return false;
  }
  for (const pattern of FORBIDDEN_PATTERNS) {
    if (pattern.test(patch)) {
      log(`Patch contains forbidden pattern: ${pattern}`, 'WARN', 'validator');
      return false;
    }
  }
  if (/fs\.\s*(unlink|rmdir|rm|delete|write|append)/.test(patch)) {
    log('Patch contains potential destructive fs operation', 'WARN', 'validator');
    return false;
  }
  const normalizedFile = path.normalize(file);
  if (normalizedFile.includes('..')) {
    log(`Path traversal detected: ${file}`, 'WARN', 'validator');
    return false;
  }
  const SOURCE_DIR = PROJECT_ROOT;
  const fullPath = path.resolve(SOURCE_DIR, file);
  if (!fullPath.startsWith(SOURCE_DIR + path.sep)) {
    log(`File escapes project root: ${file}`, 'WARN', 'validator');
    return false;
  }
  if (fs.existsSync(fullPath)) {
    const stats = fs.statSync(fullPath);
    if (stats.size > 1024 * 1024) {
      log(`File too large: ${file} (${stats.size} bytes)`, 'WARN', 'validator');
      return false;
    }
  }
  try {
    const tempFile = path.join(PROJECT_ROOT, 'test', 'temp-suggestion.js');
    fs.writeFileSync(tempFile, patch);
    const { execFileSync } = require('child_process');
    try {
      execFileSync('node', ['--check', tempFile], { stdio: 'pipe', timeout: 5000 });
    } finally {
      try { fs.unlinkSync(tempFile); } catch (e: any) {}
    }
  } catch (err: any) {
    log(`Syntax check failed: ${err.message}`, 'WARN', 'validator');
    return false;
  }
  return true;
}

module.exports = { validateSuggestion };
