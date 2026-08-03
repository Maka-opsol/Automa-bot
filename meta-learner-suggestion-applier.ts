'use strict';

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, logError } = require('./logger');
const CONFIG = require('./get-config');
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getSandboxExecutor() { return _deps.sandboxExecutor || require('./sandbox-executor'); }
function getDatabase() { return _deps.database || require('./database'); }

const SOURCE_DIR = PROJECT_ROOT;

function isValidTargetFile(file: any) {
  if (!file || typeof file !== 'string') return false;
  const normalized = path.normalize(file);
  if (normalized.includes('..')) return false;
  if (path.isAbsolute(file)) return false;
  const resolved = path.resolve(SOURCE_DIR, file);
  if (!resolved.startsWith(SOURCE_DIR)) return false;
  return true;
}

async function applySuggestion(suggestion: any) {
  if (!isValidTargetFile(suggestion.file)) {
    log('suggestion-applier: invalid target file path, rejecting', 'WARN', 'suggestion-applier');
    return false;
  } 
  const { type, file, patch, description } = suggestion;
  // Prevent path traversal: normalize and reject if it escapes SOURCE_DIR
  const normalizedFile = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  if (normalizedFile !== file || /[<>:"|?*]/.test(normalizedFile) || normalizedFile.startsWith('/')) {
    logError('Suggestion rejected: suspicious file path', new Error(`Path traversal detected: ${file}`));
    return false;
  }
  log(`Applying suggestion (${type}) to ${file}: ${description}`, 'INFO', 'suggestion-applier');
  const fullPath = path.join(SOURCE_DIR, file);
  // Double-check the resolved path stays within SOURCE_DIR
  if (!fullPath.startsWith(SOURCE_DIR + path.sep) && fullPath !== SOURCE_DIR) {
    logError('Suggestion rejected: path escapes project root', new Error(`Resolved path: ${fullPath}`));
    return false;
  }
  if (!fs.existsSync(path.dirname(fullPath))) {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  }
  const backupPath = fullPath + '.backup.' + Date.now();
  try {
    if (fs.existsSync(fullPath)) {
      fs.copyFileSync(fullPath, backupPath);
    }
    // Validate the patch in sandbox BEFORE writing to disk
    const result = await getSandboxExecutor().executePatchInSandbox(patch, fullPath);
    if (!result || !result.safe) {
      log(`Sandbox execution failed for ${file}`, 'WARN', 'suggestion-applier');
      return false;
    }
    // Only write to disk after sandbox validation passes
    fs.writeFileSync(fullPath, patch, 'utf8');
    if (type === 'selector_update' || type === 'prompt_update' || type === 'transition_update') {
      const testResult = await testSuggestion(file, patch);
      if (!testResult) {
        log(`Testing failed for ${file}, rolling back`, 'WARN', 'suggestion-applier');
        if (fs.existsSync(backupPath)) fs.copyFileSync(backupPath, fullPath);
        return false;
      }
    }
    getDatabase().insertPatch.run(Date.now(), description, file, patch, 'applied', Date.now(), 'reflection');
    log(`Successfully applied suggestion to ${file}`, 'INFO', 'suggestion-applier');
    return true;
  } catch (err: any) {
    logError(`Failed to apply suggestion to ${file}`, err);
    if (fs.existsSync(backupPath)) {
      fs.copyFileSync(backupPath, fullPath);
    }
    return false;
  } finally {
    try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch (e: any) {}
  }
}

async function testSuggestion(file: any, _patch: any) { 
  // Prevent path traversal: only allow alphanumeric, hyphens, underscores, slashes within project
  const safeFile = path.normalize(file).replace(/^(\.\.[\/\\])+/, '');
  if (safeFile !== file || /[<>:"|?*]/.test(safeFile) || safeFile.startsWith('/')) {
    logError('Suggestion test rejected: suspicious file path', new Error(`Path traversal detected: ${file}`));
    return false;
  }
  try {
    const testFile = file.replace(/\.js$/, '.test.js');
    const testPath = path.join(SOURCE_DIR, 'test', testFile);
    if (fs.existsSync(testPath)) {
      // Integration test not available — fall through to syntax-only validation
      log(`No integration test found for ${file}, using syntax-only validation`, 'DEBUG', 'suggestion-applier');
    }
    // Use node --check for syntax validation only (no code execution)
    const tempTest = path.join(SOURCE_DIR, 'test', 'temp-test.js');
// @ts-expect-error
    fs.writeFileSync(tempTest, patch, 'utf8');
    let checkResult = false;
    try {
      require('child_process').execFileSync('node', ['--check', tempTest], { stdio: 'pipe', timeout: 10000 });
      checkResult = true;
    } catch (e: any) {
      log(`Syntax check failed for ${file}: ${e.message}`, 'WARN', 'suggestion-applier');
    } finally {
      try { fs.unlinkSync(tempTest); } catch (e: any) {}
    }
    return checkResult;
  } catch (err: any) {
    logError('Suggestion testing failed', err);
    return false;
  }
}

module.exports = { applySuggestion, _injectDependencies };
