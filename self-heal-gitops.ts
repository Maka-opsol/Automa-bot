'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
// 3.8 FIX: Lazy config access — go through DI deps when available,
// fall back to direct require only if DI not yet injected.
function _getConfig(): Record<string, any> { return _deps.config || require('./get-config'); }
let _CONFIG_STALE = true;
let _CONFIG_CACHE: Record<string, any> = {};
function getCONFIG(): Record<string, any> {
  if (_CONFIG_STALE) { _CONFIG_CACHE = _getConfig(); _CONFIG_STALE = false; }
  return _CONFIG_CACHE;
}

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDBHelpers() {
  try {
    const db = require('./database');
    return {
      getGitopsChain: db.getGitopsChain || db.db?.prepare('SELECT * FROM gitops_rollback_chain ORDER BY timestamp DESC LIMIT ?'),
      insertGitopsChain: db.insertGitopsChain || db.db?.prepare('INSERT INTO gitops_rollback_chain (timestamp, branch, description, applied) VALUES (?, ?, ?, ?)'),
      insertPatch: db.insertPatch,
      updateGitopsApplied: db.updateGitopsApplied || (db.db ? db.db.prepare('UPDATE gitops_rollback_chain SET applied = ? WHERE timestamp = ?') : null),
    };
  } catch (e: any) {
    return { getGitopsChain: null, insertGitopsChain: null, insertPatch: null, updateGitopsApplied: null };
  }
}

class GitOpsSelfHeal {
  rollbackChain: any;
  maxDepth: any;

  constructor() {
    this.rollbackChain = [];
    this.maxDepth = getCONFIG().GITOPS_ROLLBACK_DEPTH || 10;
    this.loadChain();
  }

  loadChain() {
    try {
      const helpers = getDBHelpers();
      if (helpers.getGitopsChain && typeof helpers.getGitopsChain.all === 'function') {
        const rows = helpers.getGitopsChain.all(this.maxDepth);
        this.rollbackChain = rows
          .filter((r: any) => r.applied !== 0)
          .map((r: any) => ({ timestamp: r.timestamp, branch: r.branch, description: r.description, applied: r.applied }));
      }
    } catch (e: any) { this.rollbackChain = []; }
  }

// @ts-expect-error
  createBranch(timestamp: any, _depth = 0) {
    if (_depth > 2) { log('createBranch: max recursion depth reached', 'ERROR', 'self-heal-gitops'); return null; }
    const branch = `self-heal-${timestamp}`;
    try {
      execFileSync('git', ['checkout', '-b', branch], { stdio: 'ignore' });
      return branch;
    } catch (e: any) {
      try {
        execFileSync('git', ['init'], { stdio: 'ignore' });
        execFileSync('git', ['add', '.'], { stdio: 'ignore' });
        execFileSync('git', ['commit', '-m', 'Initial commit for self-heal'], { stdio: 'ignore' });
        return this.createBranch(timestamp, _depth + 1);
      } catch (initErr: any) {
        log(`Git not available or repo init failed: ${initErr.message}`, 'ERROR', 'self-heal-gitops');
        return null;
      }
    }
  }

  applyAndVerify(fixes: any) {
    const timestamp = Date.now();
    const branch = this.createBranch(timestamp);
    if (!branch) throw new Error('Git branch creation failed');

    const patchedFiles = fixes.map((f: any) => path.resolve(PROJECT_ROOT, f.file)).filter((p: any) => p.startsWith(PROJECT_ROOT));

    // Write patch files to temp, then use git mv for atomic commit
    const SOURCE_DIR = PROJECT_ROOT;
    const tmpFiles = [];
    for (const fix of fixes) {
      const resolvedPath = path.resolve(PROJECT_ROOT, fix.file);
      if (!resolvedPath.startsWith(PROJECT_ROOT)) {
        log(`GitOps security: path traversal blocked for ${fix.file}`, 'ERROR', 'gitops');
        continue;
      }
      const dir = path.dirname(resolvedPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const tmpPath = resolvedPath + `.patch-${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, fix.patch, 'utf8');
      tmpFiles.push({ tmpPath, resolvedPath });
    }

    // Stage and commit the changes
    try {
      for (const { tmpPath, resolvedPath } of tmpFiles) {
        fs.renameSync(tmpPath, resolvedPath);
        execFileSync('git', ['add', resolvedPath], { stdio: 'ignore', cwd: SOURCE_DIR });
      }
      execFileSync('git', ['commit', '-m', `Self-heal patch ${timestamp}`], { stdio: 'ignore', cwd: SOURCE_DIR });
    } catch (gitErr: any) {
      for (const { tmpPath, resolvedPath } of tmpFiles) {
        try { fs.unlinkSync(tmpPath); } catch (e: any) {}
        // Attempt rollback
        try { execFileSync('git', ['checkout', '--', resolvedPath], { stdio: 'ignore', cwd: SOURCE_DIR }); } catch (e: any) {}
      }
      logError('Git commit failed', gitErr);
      throw new Error('Git commit failed');
    }

    // 3.6 FIX: TypeScript compilation check (tsx transpiles at runtime,
    // so runtime errors from bad types are the actual failure mode).
    try {
      if (patchedFiles.length > 0) {
        execFileSync('npx', ['tsc', '--noEmit', '--pretty', ...patchedFiles], {
          stdio: 'pipe', encoding: 'utf8', timeout: 120000,
        });
      }
    } catch (tscErr: any) {
      execFileSync('git', ['reset', '--hard', 'HEAD~1'], { stdio: 'ignore' });
      execFileSync('git', ['branch', '-D', branch], { stdio: 'ignore' });
      throw new Error('TypeScript compilation failed: ' + ((tscErr as any).stdout || '').substring(0, 500));
    }

    // Lint check
    try {
      if (patchedFiles.length > 0) {
        const { execFileSync: esLintExec } = require('child_process');
        esLintExec('npx', ['eslint', ...patchedFiles, '--max-warnings', '0'], { stdio: 'pipe', encoding: 'utf8', timeout: 60000 });
      }
    } catch (e: any) {
      execFileSync('git', ['reset', '--hard', 'HEAD~1'], { stdio: 'ignore' });
      execFileSync('git', ['branch', '-D', branch], { stdio: 'ignore' });
      throw new Error('ESLint failed');
    }

    // Fuzzing check
    const fuzzed = this.runFuzzingMock();
    if (!fuzzed) {
      execFileSync('git', ['reset', '--hard', 'HEAD~1'], { stdio: 'ignore' });
      execFileSync('git', ['branch', '-D', branch], { stdio: 'ignore' });
      throw new Error('Fuzzing failed');
    }

    // Switch to current branch and merge
    let mainBranch = 'main';
    try { mainBranch = execFileSync('git', ['symbolic-ref', '--short', 'HEAD'], { stdio: 'pipe' }).toString().trim(); } catch (e: any) {}
    try {
      execFileSync('git', ['checkout', mainBranch], { stdio: 'pipe' });
    } catch (e: any) {
      logError(`Failed to checkout ${mainBranch}`, e);
    }
    try {
      execFileSync('git', ['merge', '--no-ff', branch, '-m', `Merge ${branch}`], { stdio: 'ignore' });
    } catch (mergeErr: any) {
      try { execFileSync('git', ['merge', '--abort'], { stdio: 'pipe' }); } catch (abortErr: any) { /* ignore */ }
      throw mergeErr;
    }

    this.rollbackChain.push({ timestamp, branch, description: fixes.map((f: any) => f.change).join(', '), applied: 1 });
    if (this.rollbackChain.length > this.maxDepth) this.rollbackChain.shift();

    const helpers = getDBHelpers();
    if (helpers.insertGitopsChain) {
      try { helpers.insertGitopsChain.run(timestamp, branch, fixes.map((f: any) => f.change).join(', '), 1); } catch (e: any) { logError('Failed to record gitops chain in DB', e); }
    }

    log(`GitOps Self-Heal merged patch ${timestamp}`, 'INFO', 'self-heal-gitops');
    return true;
  }

  runFuzzingMock() {
    try {
      const { spawnSync } = require('child_process');
      const result = spawnSync('node', ['test-fuzzing-runner.js'], { timeout: 30000, stdio: 'pipe' });
      return result.status === 0;
    } catch (e: any) {
      log('Fuzzing runner not available, skipping', 'DEBUG', 'self-heal-gitops');
      return true; // Don't block on missing test runner
    }
  }

  rollbackToPrevious() {
    if (this.rollbackChain.length === 0) return false;
    const prev = this.rollbackChain[this.rollbackChain.length - 1];
    try {
      execFileSync('git', ['show-ref', '--verify', `refs/heads/${prev.branch}`], { stdio: 'pipe' });
      execFileSync('git', ['checkout', prev.branch], { stdio: 'ignore' });
      this.rollbackChain.pop(); // only remove on success
      log(`Emergency rollback to ${prev.timestamp}`, 'WARN', 'self-heal-gitops');
      try {
        const helpers = getDBHelpers();
        if (helpers.updateGitopsApplied) {
          helpers.updateGitopsApplied.run(0, prev.timestamp);
        }
      } catch (e: any) { log('Could not update gitops DB record on rollback', 'WARN', 'self-heal-gitops'); }
      return true;
    } catch (e: any) { logError('Rollback failed', e); return false; }
  }
}

module.exports = { gitops: new GitOpsSelfHeal(), _injectDependencies };