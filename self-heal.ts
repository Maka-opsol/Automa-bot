'use strict';
const { sleep } = require('./utils-sleep');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }
function getDb() { return _deps.database?.db; }
function getInsertPatch() { return _deps.database?.insertPatch; }
function getInsertSelfHealEvent() { return _deps.database?.insertSelfHealEvent; }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const crypto = require('crypto');

// Lazy accessors — DI-injected dep preferred; fallback require is safe here
// because self-heal only runs mid-cycle (long after container init).
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

// Executive privileges: activated by inputting the EXECUTIVE_KEY on the dashboard.
// Not just "set" — must be actively provided to activate.
function isExecutiveMode(): boolean {
  try { return !!require('./dashboard-server').isExecutivePrivilegesActive?.(); } catch { return false; }
}
function getMemoryMode(): any { return require('./memory-mode'); }
function getGenerateCodeFixViaTribunal() { return _deps.codegenTribunal?.generateCodeFixViaTribunal || require('./providers-codegen-tribunal').generateCodeFixViaTribunal; }
function getExecutePatchInSandbox() { return _deps.sandboxExecutor?.executePatchInSandbox || require('./sandbox-executor').executePatchInSandbox; }
function getAuditPatchWithVotes() { return _deps.auditor?.auditPatchWithVotes || require('./self-heal-auditor').auditPatchWithVotes; }
function getAuditPatch() { return _deps.auditor?.auditPatch || require('./self-heal-auditor').auditPatch; }
function getValidateBeforePromotion() { return _deps.validationSuite?.validateBeforePromotion || (() => { try { return require('./test-validation-suite.js').validateBeforePromotion; } catch { return null; } })(); }
function getPatchApprovalQueue() { return _deps.approvalWorkflow?.PatchApprovalQueue || require('./self-heal-approval-workflow').PatchApprovalQueue; }
function getPatchMemory() { return _deps.patchMemory || require('./self-heal-patch-memory'); }
function getProvidersStats() { return _deps.providersStats || require('./providers-stats'); }
function getDiffMinimizer() { return _deps.diffMinimizer || require('./self-heal-diff-minimizer'); }
function getAdversarialTester() { return _deps.adversarialTester || require('./self-heal-adversarial-tester'); }
function getCanary() { return _deps.canary || require('./self-heal-canary'); }
function getRegressionBank() { return _deps.regressionBank || require('./self-heal-regression-bank'); }
function getRewardTracker() { return _deps.rewardTracker || require('./self-heal-reward-tracker'); }
function getHealerCircuitBreaker() { return _deps.healerCircuitBreaker || require('./self-heal-circuit-breaker'); }

// ─── Paths & Limits (lazy — resolved at first use, not module load) ───
const SOURCE_DIR = PROJECT_ROOT;
function getBACKUP_DIR() { return getCONFIG().SELF_HEAL_BACKUP_DIR; }
function getSTAGING_DIR() { return getCONFIG().SELF_HEAL_STAGING_DIR; }
function getMAX_BACKUPS() { return getCONFIG().SELF_HEAL_MAX_BACKUPS || 5; }

/**
 * Files that are backed up and can be promoted/rolled back.
 * v5-fix: Backup scope is now dynamic — derived from all .ts/.js files
 * in the project root at backup time. This ensures new modules are
 * automatically included without manual list updates.
 */
// Static base list for the core modules (always backed up)
const _BACKUP_SCOPE_BASES = [
  'agent', 'config', 'logger', 'state-machine', 'database', 'cache',
  'browser', 'auth-auth-manager', 'ip-check', 'alerting', 'progress-tracker',
  'captcha-solver-external', 'self-heal', 'self-heal-gitops', 'self-heal-auditor',
  'container', 'error-handler', 'sandbox-executor', 'jwt',
  'cycle-cycle-manager', 'cycle-orchestrator', 'cycle-shutdown',
  'cycle-action-executor', 'cycle-auth-guard', 'cycle-stagnation',
  'cycle-module-tracking', 'cycle-config-updater', 'cycle-ui-prompt-updater',
  'providers-base', 'providers-config-loader', 'providers-registry',
  'providers-vision-pipeline', 'providers-tribunal', 'providers-prompts',
  'providers-stats', 'providers', 'providers-fallback',
  'providers-github-gpt', 'providers-groq', 'providers-zai', 'providers-agnes',
  'providers-nvidia', 'providers-cloudflare', 'providers-cerebras', 'providers-gemini',
  'providers-detection-work-detector', 'providers-detection-captcha-solver',
  'providers-detection-signin-button', 'providers-detection-collapsed-cards',
  'providers-detection-module-completion', 'providers-detection-captcha-text-extractor',
  'providers-codegen-mistral', 'providers-codegen-qwen', 'providers-codegen-deepseek',
  'providers-codegen-openrouter', 'providers-codegen-tribunal',
];

/**
 * Build the full backup scope by combining the static base list with
 * any additional .ts/.js source files in the project root that aren't
 * already covered.
 */
function buildBackupScope(): string[] {
  const staticScope = new Set(
    _BACKUP_SCOPE_BASES.flatMap(f => [f + '.ts', f + '.js'])
  );

  try {
    const allFiles = fs.readdirSync(SOURCE_DIR);
    for (const file of allFiles) {
      if ((file.endsWith('.ts') || file.endsWith('.js')) &&
          !file.endsWith('.test.ts') && !file.endsWith('.test.js') &&
          !file.endsWith('.d.ts') &&
          !staticScope.has(file) &&
          !file.startsWith('test-') &&
          !file.startsWith('scripts-')) {
        staticScope.add(file);
      }
    }
  } catch (e: any) {
    log('Failed to scan project root for backup scope (using static list)', 'WARN', 'self-heal');
  }

  return [...staticScope];
}

// Default backup scope (built lazily on first use)
let _cachedBackupScope: string[] | null = null;
function getBACKUP_SCOPE(): string[] {
  if (!_cachedBackupScope) {
    _cachedBackupScope = buildBackupScope();
  }
  return _cachedBackupScope;
}

// ─── Approval Queue (lazy-init on first use) ───
let _approvalQueue: any = null;
function getApprovalQueue() {
  if (!_approvalQueue) {
    _approvalQueue = new (getPatchApprovalQueue())(getDb());
  }
  return _approvalQueue;
}

// ═════════════════════════════════════════════════════════════
//  ATOMIC FILE OPERATIONS
// ═════════════════════════════════════════════════════════════

function atomicReplaceFile(destPath: any, content: any) {
  const dir = path.dirname(destPath);
  const tmpPath = path.join(dir, `.tmp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, destPath);
  } catch (err: any) {
    try { fs.unlinkSync(tmpPath); } catch (cleanupErr: any) { /* best effort */ }
    throw err;
  }
}

// ═════════════════════════════════════════════════════════════
//  BACKUP / ROLLBACK / PROMOTE  (pure fs, no child_process)
// ═════════════════════════════════════════════════════════════

async function backupCode() {
  const timestamp = Date.now();
  const backupPath = path.join(getBACKUP_DIR(), `backup-${timestamp}`);
  fs.mkdirSync(backupPath, { recursive: true });

  try {
    const allBackups = fs.readdirSync(getBACKUP_DIR())
      .filter((f: any) => f.startsWith('backup-'))
      .sort();
    while (allBackups.length >= getMAX_BACKUPS()) {
      const oldest = allBackups.shift();
      fs.rmSync(path.join(getBACKUP_DIR(), oldest), { recursive: true, force: true });
    }
  } catch (e: any) {
    log('Backup rotation failed (non-fatal)', 'WARN', 'self-heal');
  }

  const backupScope = getBACKUP_SCOPE();
  for (const file of backupScope) {
    const src = path.join(SOURCE_DIR, file);
    if (fs.existsSync(src)) {
      const dest = path.join(backupPath, file);
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }

  logAudit(`Code backed up to ${backupPath} (${backupScope.length} files)`, 'self-heal');
  return backupPath;
}

function restoreFromBackup(backupPath: any, overlay?: any) {
  const backupScope = getBACKUP_SCOPE();
  const isOverlay = !!overlay;
  for (const file of backupScope) {
    const src = path.join(backupPath, file);
    if (fs.existsSync(src)) {
      try {
        const content = fs.readFileSync(src, 'utf8');
        if (isOverlay) {
          overlay.removeFromOverlay(file);
          overlay.evictModule(file);
        } else {
          const dest = path.join(SOURCE_DIR, file);
          const destDir = path.dirname(dest);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          atomicReplaceFile(dest, content);
        }
      } catch (err: any) {
        logError(`Atomic rollback failed for ${file}`, err);
      }
    }
  }
}

function copyToStaging() {
  const stagingSource = path.join(getSTAGING_DIR(), 'source');
  if (fs.existsSync(stagingSource)) {
    fs.rmSync(stagingSource, { recursive: true, force: true });
  }
  fs.mkdirSync(stagingSource, { recursive: true });

  const backupScope = getBACKUP_SCOPE();
  for (const file of backupScope) {
    const src = path.join(SOURCE_DIR, file);
    if (fs.existsSync(src)) {
      const dest = path.join(stagingSource, file);
      const destDir = path.dirname(dest);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.copyFileSync(src, dest);
    }
  }
  return stagingSource;
}

function promoteStaging(overlay?: any) {
  const stagingSource = path.join(getSTAGING_DIR(), 'source');
  const promotedFiles = [];
  const failedFiles = [];
  const isOverlay = !!overlay;

  const backupScope = getBACKUP_SCOPE();
  for (const file of backupScope) {
    const src = path.join(stagingSource, file);
    if (fs.existsSync(src)) {
      try {
        const content = fs.readFileSync(src, 'utf8');
        if (isOverlay) {
          const ok = overlay.writeToOverlay(file, content);
          if (ok) {
            promotedFiles.push(file);
          } else {
            failedFiles.push(file);
          }
        } else {
          const dest = path.join(SOURCE_DIR, file);
          const destDir = path.dirname(dest);
          if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
          atomicReplaceFile(dest, content);
          promotedFiles.push(file);
        }
      } catch (err: any) {
        logError(`Promotion failed for ${file}`, err);
        failedFiles.push(file);
      }
    }
  }

  if (failedFiles.length > 0) {
    log(`Promotion had ${failedFiles.length} failures: ${failedFiles.join(', ')}`, 'ERROR', 'self-heal');
    return false;
  }

  if (isOverlay) {
    const evicted = overlay.evictAllOverlaidModules();
    log(`Staging promoted to /tmp overlay (${promotedFiles.length} files, ${evicted} modules evicted from cache)`, 'INFO', 'self-heal');
  } else {
    log(`Staging promoted to production (${promotedFiles.length} files, all atomic)`, 'INFO', 'self-heal');
  }
  return true;
}

function rollbackAndAlert(backupPath: any, patchId: any, overlay?: any) {
  log('Rolling back to backup...', 'WARN', 'self-heal');
  restoreFromBackup(backupPath, overlay);
  logAudit('Rollback completed from ' + backupPath, 'self-heal');
  try { ((_deps.alerting?.sendAlert) || (() => {}))('Self-heal failed. Rolled back.'); } catch (e: any) { /* non-critical */ }
  if (patchId) {
    try {
      const patchMemory = getPatchMemory();
      if (patchMemory && typeof patchMemory.recordOutcome === 'function') {
        patchMemory.recordOutcome(String(patchId), 'rolled_back');
      }
    } catch (_e: any) { /* non-critical */ }
  }
}

function verifyPromotedFiles(fixes: any, overlay?: any) {
  const targetFiles = fixes.map((f: any) => f.file);
  let allValid = true;

  for (const file of targetFiles) {
    let content: string | null = null;
    if (overlay) {
      content = overlay.readFromOverlay(file);
    } else {
      const filePath = path.join(SOURCE_DIR, file);
      if (!fs.existsSync(filePath)) {
        log(`Post-promotion verification FAILED: ${file} does not exist after promotion`, 'ERROR', 'self-heal');
        allValid = false;
        continue;
      }
      content = fs.readFileSync(filePath, 'utf8');
    }

    if (!content || content.trim().length === 0) {
      log(`Post-promotion verification FAILED: ${file} is empty`, 'ERROR', 'self-heal');
      allValid = false;
      continue;
    }
    if (content.length < 50) {
      log(`Post-promotion verification WARNING: ${file} is suspiciously short (${content.length} chars)`, 'WARN', 'self-heal');
    }
    const trimmedStart = content.trimStart().substring(0, 20);
    const validStarts = ["'use strict'", '"use strict"', "'use strict';", '"use strict";', 'import ', 'export ', '//', '/*', '/**'];
    const hasValidStart = validStarts.some(s => trimmedStart.startsWith(s));
    if (!hasValidStart) {
      log(`Post-promotion verification WARNING: ${file} does not start with a recognized pattern (starts with: "${trimmedStart.substring(0, 30)}")`, 'WARN', 'self-heal');
    }
  }

  return allValid;
}

// ═════════════════════════════════════════════════════════════
//  INVESTIGATION
// ═════════════════════════════════════════════════════════════

async function investigatePage() {
  log('Investigating page for self-healing...', 'INFO', 'self-heal');
  let page;
  try {
    const launcher = _deps.browser?.launchBrowser;
    if (!launcher) {
      log('No browser available for investigation (boot-time heal) — using log-based context', 'WARN', 'self-heal');
      return { screenshot: null, html: null, url: null, bootTime: true };
    }
    page = await launcher();
    if (!page) {
      log('Browser launch returned no page — using log-based context', 'WARN', 'self-heal');
      return { screenshot: null, html: null, url: null, bootTime: true };
    }
    await (_deps.auth?.authenticate || (() => {}))(page);
    await page.goto(getCONFIG().APP_URL + '/assignments', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(5000);
    const screenshot = await page.screenshot({ type: 'jpeg', quality: 30 });
    const base64 = screenshot.toString('base64');
    const html = await page.content();
    return { screenshot: base64, html, url: page.url() };
  } catch (err: any) {
    logError('Investigation failed', err);
    return null;
  } finally {
    if (page) {
      try { await (_deps.browser?.closeBrowser || (() => {}))(); } catch (e: any) { /* best effort */ }
    }
  }
}

function getRecentErrors() {
  try {
    const stats = getProvidersStats().getStats();
    return `Last error count: ${stats.errors || 0}, consecutive failures: ${stats.consecutiveFailures || 0}`;
  } catch (e: any) {
    return 'No error details available';
  }
}

/**
 * Enhanced error context: gathers additional diagnostic data from the
 * runtime environment to give the tribunal more signal about what's wrong.
 */
function getEnhancedErrorContext(): string {
  const parts: string[] = [];

  // 1. Memory status
  try {
    const mem = process.memoryUsage();
    parts.push(`Memory: RSS=${Math.round(mem.rss / 1024 / 1024)}MB, Heap=${Math.round(mem.heapUsed / 1024 / 1024)}/${Math.round(mem.heapTotal / 1024 / 1024)}MB`);
  } catch {}

  // 2. Provider stats summary
  try {
    const stats = getProvidersStats().getStats();
    if (stats) {
      parts.push(`Provider stats: ${stats.totalActions || 0} actions, ${stats.errors || 0} errors, ${stats.consecutiveFailures || 0} consecutive failures`);
    }
  } catch {}

  // 3. Uptime
  try {
    const uptimeSec = Math.round(process.uptime());
    parts.push(`Process uptime: ${Math.floor(uptimeSec / 3600)}h ${Math.floor((uptimeSec % 3600) / 60)}m`);
  } catch {}

  // 4. Degradation level (if available)
  try {
    const degradLadder = require('./self-heal-degradation-ladder');
    if (degradLadder?.getCurrentLevel) {
      const level = degradLadder.getCurrentLevel();
      parts.push(`Degradation level: ${level?.name || level || 'unknown'}`);
    }
  } catch {}

  // 5. Recent self-heal events (last 3)
  try {
    const db = getDb();
    if (db) {
      const recentEvents = db.prepare('SELECT phase, outcome, trigger_reason FROM self_heal_events ORDER BY timestamp DESC LIMIT 3').all();
      if (recentEvents.length > 0) {
        parts.push(`Recent self-heal events: ${recentEvents.map((e: any) => `${e.phase}=${e.outcome || '?'}`).join(', ')}`);
      }
    }
  } catch {}

  // 6. Circuit breaker state
  try {
    const cb = getHealerCircuitBreaker();
    if (cb?.healerCircuitBreaker?.getState) {
      const cbState = cb.healerCircuitBreaker.getState();
      parts.push(`Circuit breaker: ${cbState.state} (failures: ${cbState.failureCount}, consecutive opens: ${cbState.consecutiveOpens})`);
    }
  } catch {}

  return parts.length > 0 ? parts.join(' | ') : 'No additional context available';
}

const ERROR_TO_FILE_HINTS: Array<{ pattern: RegExp; files: string[] }> = [
  { pattern: /selector|click|wait_for|visible|locator/i, files: ['selectors.ts', 'browser.ts', 'cycle-action-executor.ts'] },
  { pattern: /auth|login|signin|token|jwt|session/i, files: ['auth-strategies-microsoft-v2.ts', 'auth-auth-manager.ts', 'auth.ts', 'jwt.ts'] },
  { pattern: /state.?machine|stuck|deadlock|transition/i, files: ['state-machine.ts', 'cycle-orchestrator.ts'] },
  { pattern: /timeout|timed.?out|30[0-9]{3}/i, files: ['browser.ts', 'cycle-watchdog.ts', 'config.ts'] },
  { pattern: /provider|model|openrouter|groq|mistral|api.?key/i, files: ['providers.ts', 'providers-registry.ts', 'providers-fallback.ts', 'providers-base.ts'] },
  { pattern: /memory|oom|heap|gc|allocation/i, files: ['memory-mode.ts', 'runtime-heap-guardian.ts', 'resource-manager.ts'] },
  { pattern: /screenshot|page|navigate|goto/i, files: ['browser.ts', 'cycle-action-executor.ts'] },
  { pattern: /captcha/i, files: ['captcha-solver-external.ts', 'providers-detection-captcha-solver.ts'] },
  { pattern: /stagnat|repeat|loop|circular/i, files: ['cycle-stagnation.ts', 'cycle-cycle-manager.ts', 'progress-tracker.ts'] },
  // v2: Additional patterns for better targeting
  { pattern: /quota|rate.?limit|429|budget/i, files: ['openrouter-rate-limiter.ts', 'bazaarlink-rate-limiter.ts', 'providers-registry.ts', 'providers-health.ts'] },
  { pattern: /require|module|cannot find|MODULE_NOT_FOUND/i, files: ['dependency-manager.ts', 'dependency-survivor.ts', 'container-modules.ts'] },
  { pattern: /ECONNREFUSED|ENOTFOUND|network|fetch|socket/i, files: ['providers-base.ts', 'utils-fetch.ts', 'providers-dns-rotation.ts', 'network-ip-rotator.ts'] },
];

function enrichInvestigationWithTargetFile(investigation: any, errorLogs: string) {
  const enriched = { ...investigation };

  // Try patch memory first
  try {
    const patchMem = getPatchMemory();
    if (patchMem && typeof patchMem.getMostFrequentTarget === 'function') {
      const frequentTarget = patchMem.getMostFrequentTarget();
      if (frequentTarget) {
        const filePath = path.join(SOURCE_DIR, frequentTarget);
        if (fs.existsSync(filePath)) {
          enriched.targetFile = frequentTarget;
          enriched.fileContent = fs.readFileSync(filePath, 'utf8');
          log(`Investigation enriched with patch-memory target: ${frequentTarget}`, 'DEBUG', 'self-heal');
          return enriched;
        }
      }
    }
  } catch (e: any) { /* non-critical */ }

  // Fall back to error-pattern matching
  for (const entry of ERROR_TO_FILE_HINTS) {
    if (entry.pattern.test(errorLogs)) {
      for (const candidate of entry.files) {
        const filePath = path.join(SOURCE_DIR, candidate);
        if (fs.existsSync(filePath)) {
          try {
            enriched.targetFile = candidate;
            enriched.fileContent = fs.readFileSync(filePath, 'utf8');
            log(`Investigation enriched with error-pattern target: ${candidate}`, 'DEBUG', 'self-heal');
            return enriched;
          } catch (e: any) { /* read failed, try next */ }
        }
      }
    }
  }

  log('Investigation: no specific target file identified, tribunal will infer from HTML', 'DEBUG', 'self-heal');
  return enriched;
}

// ═════════════════════════════════════════════════════════════
//  TWO-LAYER AUDIT COORDINATION
// ═════════════════════════════════════════════════════════════

/**
 * Run the two-layer audit on a single fix.
 * v2: Now accepts cascade metadata — non-codegen patches get
 * ENHANCED audit (more auditors, stricter thresholds, extra validation).
 */
async function auditFix(fix: any, cascadeMetadata?: any) {
  const { file, patch } = fix;
  const isNonCodegen = cascadeMetadata?.hasCodegenVote === false;

  // ── Layer 1: Sandbox (deterministic) ──
  const sandboxResult = await getExecutePatchInSandbox()(patch, file);

  if (!sandboxResult.safe) {
    const detail = sandboxResult.violations
      ? sandboxResult.violations.join('; ')
      : sandboxResult.error;
    log(`Sandbox BLOCKED patch for ${file}: ${detail}`, 'WARN', 'self-heal');
    return { passed: false, reason: `Sandbox: ${detail}` };
  }

  // ── Layer 2: AI Auditor (probabilistic) ──
  let auditResult;

  if (sandboxResult.requiresApproval) {
    log(`Restricted file ${file}: requesting AI tribunal votes`, 'INFO', 'self-heal');
    // Non-codegen patches for restricted files get the full tribunal with votes
    auditResult = await getAuditPatchWithVotes()(patch, undefined, { isNonCodegen });
  } else {
    // Allowed file — standard audit
    auditResult = await getAuditPatch()(patch, undefined, { isNonCodegen });
  }

  if (!auditResult.safe && !auditResult.is_safe) {
    const reason = auditResult.reason || 'AI auditor rejected patch';
    log(`AI auditor BLOCKED patch for ${file}: ${reason}`, 'WARN', 'self-heal');
    return { passed: false, reason: `AI auditor: ${reason}` };
  }

  // ── Restricted file approval workflow ──
  if (sandboxResult.requiresApproval) {
    const approvalResult = await handleRestrictedFileApproval(fix, auditResult);
    if (!approvalResult.approved) {
      return { passed: false, reason: `Approval: ${approvalResult.reason}` };
    }
    return { passed: true, approvalStatus: 'approved' };
  }

  return { passed: true };
}

async function handleRestrictedFileApproval(fix: any, auditResult: any) {
  const queue = getApprovalQueue();
  const patchId = `sh-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const patchHash = crypto.createHash('sha256').update(fix.patch).digest('hex');
  const patchSize = Buffer.byteLength(fix.patch, 'utf8');

  queue.requestApproval({
    patchId,
    targetFile: fix.file,
    patchHash,
    patchSize,
    metadata: {
      change: fix.change,
      generatingModel: fix.generatingModel || 'unknown',
    },
  });

  const votes = (auditResult.votes || []).map((v: any) => ({
    auditor: v.auditor || v.provider || 'unknown',
    safe: v.safe !== false && v.is_safe !== false,
    reason: v.reason || '',
  }));

  if (votes.length === 0) {
    votes.push({
      auditor: 'primary-auditor',
      safe: true,
      reason: auditResult.reason || 'Passed standard audit',
    });
  }

  const decision = queue.submitVotes(patchId, votes);

  if (!decision.approved) {
    log(`Approval REJECTED for restricted file ${fix.file}: ${decision.reason}`, 'WARN', 'self-heal');
    if (getCONFIG().ALERT_ON_ERROR) {
      try { ((_deps.alerting?.sendAlert) || (() => {}))(`Self-heal approval rejected for ${fix.file}: ${decision.reason}`); } catch (e: any) { /* non-critical */ }
    }
    return decision;
  }

  log(`Approval GRANTED for restricted file ${fix.file}: ${decision.reason}`, 'INFO', 'self-heal');
  return decision;
}

// ═════════════════════════════════════════════════════════════
//  STAGING (no child_process — pure fs + sandbox validation)
// ═════════════════════════════════════════════════════════════

function applyFixesToStaging(fixes: any, stagingSource: any) {
  log(`Applying ${fixes.length} validated fix(es) to staging...`, 'INFO', 'self-heal');

  for (const fix of fixes) {
    const filePath = path.join(stagingSource, fix.file);

    if (!fs.existsSync(filePath)) {
      log(`File ${fix.file} does not exist in staging, skipping`, 'WARN', 'self-heal');
      continue;
    }

    // Reject unified diffs — we only support full file replacement for safety
    if (fix.patch.trimStart().startsWith('---')) {
      log(`Patch for ${fix.file} is a unified diff — only full file replacement is supported. Rejecting.`, 'WARN', 'self-heal');
      return false;
    }

    try {
      atomicReplaceFile(filePath, fix.patch);
      log(`Applied patch to ${fix.file} in staging (atomic full replacement)`, 'INFO', 'self-heal');
    } catch (err: any) {
      logError(`Failed to write patch for ${fix.file}`, err);
      return false;
    }

    try {
      getInsertPatch().run(
        Date.now(), fix.change || 'Self-heal patch', fix.file,
        fix.patch, 'staged', Date.now(), 'self-heal'
      );
    } catch (err: any) {
      log(`Failed to record patch in DB (non-fatal): ${err.message}`, 'WARN', 'self-heal');
    }
  }

  return true;
}

// ═════════════════════════════════════════════════════════════
//  MAIN SELF-HEAL ORCHESTRATOR
// ═════════════════════════════════════════════════════════════

let _healInProgress = false;

// v2: Track consecutive tribunal failures across performSelfHeal invocations
// (survives restarts via in-memory counter — resets on successful heal)
let _consecutiveTribunalFailures = 0;

/**
 * Get the current consecutive tribunal failure count.
 * Exposed for external query (dashboard, diagnostics).
 */
function getConsecutiveTribunalFailures(): number { return _consecutiveTribunalFailures; }

/**
 * Reset the consecutive tribunal failure counter.
 * Called on successful heal or manual operator reset.
 */
function resetConsecutiveTribunalFailures() {
  const prev = _consecutiveTribunalFailures;
  _consecutiveTribunalFailures = 0;
  if (prev > 0) {
    log(`Consecutive tribunal failure counter reset (was ${prev})`, 'INFO', 'self-heal');
  }
}

interface SelfHealOptions {
  skipRuntimeHeal?: boolean;
}

async function performSelfHeal(options?: SelfHealOptions) {
  if (_healInProgress) { log('Self-heal already in progress, skipping', 'DEBUG', 'self-heal'); return false; }

  // v9: FAST PASS — runtime healing avenues (no /tmp, no code patches, no AI).
  if (!options?.skipRuntimeHeal) {
    try {
      log('Attempting runtime heal (fast pass)...', 'INFO', 'self-heal');
      const runtimeResult = await performRuntimeHeal();
      if (runtimeResult.healed) {
        const successes = runtimeResult.results.filter(r => r.healed);
        log(`Runtime heal SUCCEEDED via: ${successes.map(r => r.avenue).join(', ')}`, 'INFO', 'self-heal');
        logAudit(`Runtime heal succeeded: ${successes.map(r => r.avenue).join(', ')}`, 'self-heal');
        _lastFailureTime = 0; // Reset cooldown on any successful heal
        resetConsecutiveTribunalFailures(); // Reset tribunal failure tracking
        return true;
      }
      log('Runtime heal found no fixable issues — falling through to code-patch pipeline', 'INFO', 'self-heal');
    } catch (rtErr: any) {
      logError('Runtime heal fast pass threw error (falling through)', rtErr);
    }
  } else {
    log('Skipping runtime heal fast-pass (skipRuntimeHeal=true) — going directly to code-patch pipeline', 'INFO', 'self-heal');
  }

  // ── SLOW PATH: Code-patch pipeline ──
  const isReadOnlyFs = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
  let overlay: any = null;
  if (isReadOnlyFs) {
    try {
      overlay = require('./self-heal-tmp-overlay');
      if (!overlay.installInterceptor() && !overlay.getStatus().interceptorInstalled) {
        log('Self-heal: overlay interceptor not available, skipping', 'WARN', 'self-heal');
        try { getInsertSelfHealEvent()?.(Date.now(), 'core', 'skipped', 'Overlay interceptor unavailable', null, 0, 0, 0, null, null, 'no_overlay'); } catch {}
        return false;
      }
      log('Self-heal: using /tmp overlay for patches (read-only FS)', 'INFO', 'self-heal');
    } catch (overlayErr: any) {
      log(`Self-heal: overlay module failed to load: ${overlayErr.message}`, 'WARN', 'self-heal');
      try { getInsertSelfHealEvent()?.(Date.now(), 'core', 'skipped', 'Overlay module load failed', null, 0, 0, 0, null, null, 'overlay_load_error'); } catch {}
      return false;
    }
  }
  _healInProgress = true;
  try {
  if (!getCONFIG().SELF_HEAL_ENABLED) return false;
  if (getCONFIG().SELF_HEAL_MANUAL_OVERRIDE) {
    log(`Manual override set to ${getCONFIG().SELF_HEAL_MANUAL_OVERRIDE}, skipping self-heal`, 'INFO', 'self-heal');
    return false;
  }
  if (!checkSelfHealSafety()) return false;

  // v2: In FULL CASCADE mode (3+ consecutive failures), bypass daily limit.
  // This is a last-resort scenario — if the bot has failed 3 times in a row,
  // the normal daily limit should not prevent it from using every available provider.
  const isFullCascade = _consecutiveTribunalFailures >= 3;
  if (isFullCascade) {
    log(`FULL CASCADE MODE ACTIVE (${_consecutiveTribunalFailures} consecutive tribunal failures) — daily limit bypassed, all providers will be consulted`, 'WARN', 'self-heal');
    logAudit(`Full cascade mode activated (attempt ${_consecutiveTribunalFailures})`, 'self-heal');
  }

  const memoryMode = getMemoryMode();
  const sessionRequested = memoryMode.isMemoryProtection() && memoryMode.beginSelfHealSession('self_heal_triggered');
  if (sessionRequested) {
    log('Self-heal session STARTED — full power granted for healing. All progress will be saved to DB.', 'WARN', 'self-heal');
  }

  log('Starting self-heal code-patch process...', 'INFO', 'self-heal');
  logAudit('Self-heal code-patch process started', 'self-heal');
  const healStartTime = Date.now();
  const backupPath = await backupCode();

  let attempts = 0;
  let healed = false;
  let safeFixes: any[] = [];
  let lastTribunalError: string | null = null;

  // v2: Dynamic max attempts based on cascade state
  // Normal: SELF_HEAL_MAX_ATTEMPTS (default 3)
  // Full cascade: up to 5 attempts (more providers to try)
  const maxAttempts = isFullCascade
    ? Math.max(getCONFIG().SELF_HEAL_MAX_ATTEMPTS || 3, 5)
    : (getCONFIG().SELF_HEAL_MAX_ATTEMPTS || 3);

  while (attempts < maxAttempts && !healed) {
    attempts++;

    // Adaptive backoff: longer in cascade mode, shorter in normal mode
    if (attempts > 1) {
      const baseBackoff = isFullCascade ? 8 : 5;
      const backoffSec = attempts * baseBackoff;
      log(`Self-heal attempt ${attempts}/${maxAttempts} (waiting ${backoffSec}s backoff${isFullCascade ? ' [CASCADE]' : ''})`, 'INFO', 'self-heal');
      await sleep(backoffSec * 1000);
    } else {
      log(`Self-heal attempt ${attempts}/${maxAttempts}${isFullCascade ? ' [FULL CASCADE - all providers]' : ''}`, 'INFO', 'self-heal');
    }

    // Fast-fail: if BazaarLink budget is exhausted and Mistral also failed on
    // the previous attempt, retrying is pointless (UNLESS in full cascade mode,
    // where non-codegen providers may still work).
    try {
      const blLimiter = require('./bazaarlink-rate-limiter');
      if (blLimiter.isExhausted() && lastTribunalError !== null && !isFullCascade) {
        log(`Fast-fail: BazaarLink budget exhausted + previous Mistral failure (${lastTribunalError}). Retrying won't help.`, 'ERROR', 'self-heal');
        memoryMode.appendSelfHealProgress?.('fast_fail', { reason: 'bl_exhausted_plus_mistral_fail', lastError: lastTribunalError, attempt: attempts });
        break;
      }
    } catch {}

    const executiveMode = isExecutiveMode();
    const acceptAnyFix = executiveMode || getCONFIG().SELF_HEAL_ACCEPT_ANY_FIX === true;
    if (executiveMode) {
      log('EXECUTIVE PRIVILEGES ACTIVE — all safety gates bypassed, targeting fastest GitHub push', 'WARN', 'self-heal');
    } else if (acceptAnyFix) {
      log('ACCEPT_ANY_FIX active — audit/consensus skipped, other safety nets retained', 'INFO', 'self-heal');
    }

    // 1. Investigate the current page state
    const investigation = await investigatePage();
    if (!investigation) {
      log('Investigation failed (unexpected error), retrying', 'ERROR', 'self-heal');
      memoryMode.appendSelfHealProgress?.('investigation_failed', { attempt: attempts });
      continue;
    }
    if (investigation.bootTime) {
      log('Boot-time heal: proceeding with log-based investigation (no browser)', 'INFO', 'self-heal');
    }
    memoryMode.appendSelfHealProgress?.('investigation', { summary: investigation?.summary?.substring(0, 200), attempt: attempts });

    // 2. Gather error context (v2: enhanced with runtime diagnostics)
    const errorLogs = getRecentErrors();
    const enhancedContext = getEnhancedErrorContext();
    const fullErrorContext = `${errorLogs}\n${enhancedContext}`;

    // 3. Build patch context from memory (D2: few-shot from past fixes)
    let patchContext = '';
    try {
      if (getCONFIG().PATCH_MEMORY_ENABLED) {
        const patchMem = getPatchMemory();
        patchContext = await patchMem.buildContextForTribunal(fullErrorContext);
        if (patchContext) log('Patch memory provided similar past fixes', 'INFO', 'self-heal');
      }
    } catch (e: any) { /* non-critical */ }

    // 3b. Enrich investigation with likely target file + its content.
    const enrichedInvestigation = enrichInvestigationWithTargetFile(investigation, fullErrorContext);

    // 4. Generate fixes via AI tribunal
    // v2: Pass consecutiveFailures so the tribunal can activate full cascade
    let fixes: any[] | null = null;
    lastTribunalError = null;
    const tribunalTimeout = isFullCascade
      ? (getCONFIG().SELF_HEAL_TRIBUNAL_TIMEOUT_MS || 120_000) * 1.5  // 50% longer in cascade
      : (getCONFIG().SELF_HEAL_TRIBUNAL_TIMEOUT_MS || 120_000);
    const tribunalSignal = AbortSignal.timeout(tribunalTimeout);
    try {
      fixes = await getGenerateCodeFixViaTribunal()(
        enrichedInvestigation,
        fullErrorContext + (patchContext ? '\n\n' + patchContext : ''),
        tribunalSignal,
        { consecutiveFailures: _consecutiveTribunalFailures }
      );
    } catch (err: any) {
      if (err.name === 'TimeoutError' || err.name === 'AbortError') {
        log('Tribunal timed out — retrying', 'WARN', 'self-heal');
        lastTribunalError = 'timeout';
        memoryMode.appendSelfHealProgress?.('tribunal_timeout', { attempt: attempts });
        continue;
      }
      logError('Tribunal failed to generate fixes', err);
      lastTribunalError = String(err.message || err).substring(0, 200);
      continue;
    }

    if (!fixes || fixes.length === 0) {
      log('No fixes generated by tribunal', 'WARN', 'self-heal');
      lastTribunalError = 'no_fixes';
      memoryMode.appendSelfHealProgress?.('no_fixes', { attempt: attempts });
      continue;
    }

    // v2: Track tribunal success for cascade state machine
    // If we got here, the tribunal DID return fixes (even if they get blocked later)
    // The consecutive failure counter only tracks complete pipeline failures.

    // v4: Save generated fixes to DB (survives OOM)
    memoryMode.appendSelfHealProgress?.('fixes_generated', {
      count: fixes.length,
      files: fixes.map((f: any) => f.file),
      attempt: attempts,
      cascadeMode: isFullCascade,
      cascadeMetadata: fixes[0]?._cascadeMetadata || null,
    });

    // 5. Two-layer audit on each fix (sandbox -> AI auditor -> approval workflow)
    // v2: Non-codegen patches get enhanced audit via cascadeMetadata
    safeFixes = [];
    const blockedFixes: any[] = [];

    if (acceptAnyFix) {
      safeFixes = fixes;
      log(`${executiveMode ? 'EXECUTIVE_MODE' : 'ACCEPT_ANY_FIX'}: bypassing audit — applying all ${fixes.length} fix(es) directly`, 'WARN', 'self-heal');
    } else {
      for (const fix of fixes) {
        const cascadeMeta = fix._cascadeMetadata || null;
        const isNonCodegenPatch = cascadeMeta?.hasCodegenVote === false;

        // v2: Log non-codegen patch warnings clearly
        if (isNonCodegenPatch) {
          log(`NON-CODEGEN PATCH from ${cascadeMeta.providers.join(', ')} for ${fix.file} — applying enhanced safety protocols`, 'WARN', 'self-heal');
        }

        const result = await auditFix(fix, cascadeMeta);
        if (result.passed) {
          // Tag the fix with its origin metadata for downstream tracking
          safeFixes.push({
            ...fix,
            _isNonCodegen: isNonCodegenPatch,
            _cascadeMetadata: cascadeMeta,
          });
          log(`Patch for ${fix.file} passed all audit layers${isNonCodegenPatch ? ' [NON-CODEGEN - enhanced safety]' : ''}`, 'INFO', 'self-heal');
        } else {
          blockedFixes.push({ file: fix.file, reason: result.reason, isNonCodegen: isNonCodegenPatch });
          log(`Patch for ${fix.file} BLOCKED: ${result.reason}${isNonCodegenPatch ? ' [NON-CODEGEN]' : ''}`, 'WARN', 'self-heal');
          if (getCONFIG().ALERT_ON_ERROR) {
            try { ((_deps.alerting?.sendAlert) || (() => {}))(`Self-heal blocked patch for ${fix.file}: ${result.reason}`); } catch (e: any) { /* non-critical */ }
          }
        }
      }
    }

    if (safeFixes.length === 0) {
      log('All fixes blocked by audit. Aborting self-heal.', 'ERROR', 'self-heal');
      getInsertSelfHealEvent().run(
        Date.now(), 'core', 'failed', 'All fixes blocked by audit',
        null, fixes.length, 0, 0, null, null,
        `Blocked: ${blockedFixes.map(b => `${b.file}(${b.reason})`).join('; ')}`
      );
      // v2: Don't increment consecutive failures for audit blocks — the tribunal worked,
      // the safety system did its job. This is different from tribunal failures.
      continue;
    }

    // 6. Minimize diffs before staging (B3)
    try {
      if (getCONFIG().DIFF_MINIMIZER_ENABLED && !executiveMode) {
        const { minimizePatch } = getDiffMinimizer();
        for (let i = 0; i < safeFixes.length; i++) {
          const filePath = path.join(SOURCE_DIR, safeFixes[i].file);
          if (fs.existsSync(filePath)) {
            const orig = fs.readFileSync(filePath, 'utf8');
            const result = minimizePatch(orig, safeFixes[i].patch, safeFixes[i].file);
            if (result.minimized && result.patchedContent) {
              log(`Diff minimized for ${safeFixes[i].file}: ${result.savedPercent.toFixed(0)}% smaller`, 'INFO', 'self-heal');
              safeFixes[i].patch = result.patchedContent;
            }
          }
        }
      }
    } catch (e: any) {
      log('Diff minimization failed, using original patches', 'WARN', 'self-heal');
    }

    // 7. Prepare staging area
    const stagingSource = copyToStaging();

    // 8. Apply validated fixes to staging
    const applyOk = applyFixesToStaging(safeFixes, stagingSource);
    if (!applyOk) {
      log('Apply to staging failed, rolling back', 'WARN', 'self-heal');
      rollbackAndAlert(backupPath, safeFixes[0]?.id, overlay);
      continue;
    }

    // 9. Run critical validation suite on STAGED code
    if (!executiveMode) {
      const validateFn = getValidateBeforePromotion();
        const validated = validateFn ? await validateFn(stagingSource) : { passed: true };
      if (!validated) {
        log('Pre-promotion validation failed, rolling back', 'ERROR', 'self-heal');
        getInsertSelfHealEvent().run(
          Date.now(), 'core', 'failed', 'Pre-promotion validation failed',
          null, safeFixes.length, safeFixes.length, 0, null, null, 'validation'
        );
        rollbackAndAlert(backupPath, safeFixes[0]?.id, overlay);
        continue;
      }
    } else {
      log('EXECUTIVE_MODE: skipping pre-promotion validation', 'WARN', 'self-heal');
    }

    // 10. Adversarial testing (B4)
    // v2: Non-codegen patches ALWAYS get adversarial testing (even if config disabled)
    //     because they are inherently less trustworthy.
    const hasNonCodegenFix = safeFixes.some((f: any) => f._isNonCodegen);
    try {
      if ((getCONFIG().ADVERSARIAL_TESTER_ENABLED || hasNonCodegenFix) && !executiveMode) {
        const { testPatch: adversarialTest } = getAdversarialTester();
        for (const fix of safeFixes) {
          const advResult = await adversarialTest(fix.patch, fix.file);
          if (!advResult.passed) {
            const failedTypes = (advResult.results || []).filter((r: any) => !r.passed).map((r: any) => r.testType).join(', ');
            log(`Adversarial test failed for ${fix.file}: ${failedTypes}`, 'WARN', 'self-heal');
            // v2: Non-codegen patches that fail adversarial testing are REJECTED
            if (fix._isNonCodegen) {
              log(`NON-CODEGEN patch for ${fix.file} REJECTED due to adversarial test failure (required for non-codegen)`, 'ERROR', 'self-heal');
              safeFixes = safeFixes.filter((f: any) => f !== fix);
              if (getCONFIG().ALERT_ON_ERROR) {
                try { ((_deps.alerting?.sendAlert) || (() => {}))(`Non-codegen patch for ${fix.file} failed mandatory adversarial testing: ${failedTypes}`); } catch (e: any) {}
              }
              continue;
            }
            if (getCONFIG().ALERT_ON_ERROR) {
              try { ((_deps.alerting?.sendAlert) || (() => {}))(`Patch for ${fix.file} failed adversarial testing`); } catch (e: any) { /* non-critical */ }
            }
          } else {
            log(`Adversarial test passed for ${fix.file}${fix._isNonCodegen ? ' [NON-CODEGEN - mandatory pass]' : ''}`, 'INFO', 'self-heal');
          }
        }
        // If all non-codegen patches were rejected, continue to next attempt
        if (safeFixes.length === 0) {
          log('All patches rejected (non-codegen adversarial failures), retrying', 'WARN', 'self-heal');
          continue;
        }
      }
    } catch (e: any) {
      log('Adversarial testing failed, continuing (non-critical)', 'WARN', 'self-heal');
    }

    // 11. Promote or enter canary
    let promotedDirectly = true;
    try {
      if (getCONFIG().CANARY_ROLLOUT_ENABLED && !executiveMode) {
        const canary = getCanary();
        const _stats = getProvidersStats().getStats();
        const baseline = _stats.totalActions > 0 ? _stats.errors / _stats.totalActions : 0.1;
        const canaryResult = canary.startCanary(
          Date.now(),
          baseline,
          safeFixes.map(f => f.file).join(', '),
          backupPath
        );
        if (canaryResult) {
          promotedDirectly = false;
          log('Patch entered canary mode', 'INFO', 'self-heal');
        }
      }
    } catch (e: any) {
      log('Canary setup failed, falling back to direct promotion', 'WARN', 'self-heal');
    }

    if (promotedDirectly) {
      const promotedOk = promoteStaging(overlay);
      if (!promotedOk) {
        log('Promotion failed (atomic write errors), rolling back', 'ERROR', 'self-heal');
        rollbackAndAlert(backupPath, safeFixes[0]?.id, overlay);
        continue;
      }

      const verified = verifyPromotedFiles(safeFixes, overlay);
      if (!verified) {
        log('Post-promotion verification failed, rolling back to backup', 'ERROR', 'self-heal');
        getInsertSelfHealEvent().run(
          Date.now(), 'core', 'failed', 'Post-promotion verification failed',
          null, safeFixes.length, safeFixes.length, 0, null, null, 'post-promotion-verification'
        );
        rollbackAndAlert(backupPath, safeFixes[0]?.id, overlay);
        if (getCONFIG().ALERT_ON_ERROR) {
          try { ((_deps.alerting?.sendAlert) || (() => {}))('Self-heal post-promotion verification failed. Rolled back.'); } catch (e: any) { /* non-critical */ }
        }
        continue;
      }
      log('Post-promotion verification passed', 'INFO', 'self-heal');
    }

    // v10: HOT-SWAP
    if (isReadOnlyFs && promotedDirectly) {
      try {
        const hotSwap = require('./self-heal-hot-swap');
        const swapFiles = safeFixes.map((f: any) => f.file);
        const swapSummary = hotSwap.hotSwapModules(swapFiles);
        if (swapSummary.totalSwapped > 0) {
          log(`Hot-swap applied ${swapSummary.totalSwapped}/${swapFiles.length} module(s) instantly`, 'INFO', 'self-heal');
          const verifyResult = hotSwap.verifyRecentSwaps();
          if (verifyResult.invalid > 0) {
            log(`Hot-swap verification: ${verifyResult.invalid} module(s) have issues after swap`, 'WARN', 'self-heal');
            for (const detail of verifyResult.details) {
              if (!detail.valid) {
                const rolledBack = hotSwap.rollbackSwap(detail.file);
                log(`Hot-swap rollback for ${detail.file}: ${rolledBack ? 'OK' : 'FAILED'}`, rolledBack ? 'WARN' : 'ERROR', 'self-heal');
              }
            }
          } else {
            log(`Hot-swap verification: all ${verifyResult.valid} module(s) healthy`, 'INFO', 'self-heal');
          }
        } else if (swapSummary.totalFailed > 0) {
          log(`Hot-swap failed for ${swapSummary.totalFailed} module(s) — overlay interceptor still active as fallback`, 'WARN', 'self-heal');
        } else {
          log(`Hot-swap: ${swapSummary.totalSkipped} module(s) skipped (blacklisted or not in cache) — overlay interceptor handles those`, 'DEBUG', 'self-heal');
        }
      } catch (hsErr: any) {
        log(`Hot-swap module failed (non-fatal, overlay interceptor is fallback): ${hsErr.message}`, 'WARN', 'self-heal');
      }
    }

    // v11: IMMEDIATE REDEPLOY
    if (isReadOnlyFs) {
      try {
        const gitDeploy = require('./self-heal-git-deploy');
        if (_deps.logger || _deps.database) {
          try { gitDeploy._injectDependencies({ logger: _deps.logger, database: _deps.database, config: _deps.config }); } catch {}
        }

        const patchedFileNames = safeFixes.map((f: any) => f.file);
        const hasGithub = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
        const hasRender = !!(process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID);

        if (hasGithub || hasRender) {
          log(`Full self-heal succeeded — triggering IMMEDIATE redeploy of ${patchedFileNames.length} file(s) to GitHub + Render`, 'INFO', 'self-heal');
          const redeployResult = await gitDeploy.triggerImmediateRedeploy(patchedFileNames);
          if (redeployResult.redeployed) {
            log(`IMMEDIATE REDEPLOY TRIGGERED via ${redeployResult.method}: ${redeployResult.details}`, 'INFO', 'self-heal');
            log('Waiting for Render to SIGTERM this instance (5-minute watchdog active)...', 'INFO', 'self-heal');
          } else {
            log(`Immediate redeploy failed: ${redeployResult.details} — patches are active via overlay/hot-swap but NOT persisted to GitHub`, 'WARN', 'self-heal');
            let queuedCount = 0;
            for (const fix of safeFixes) {
              if (gitDeploy.isDeployAllowed(fix.file)) {
                gitDeploy.recordPatchForVerification(fix.id || String(Date.now()), fix.file);
                queuedCount++;
              }
            }
            if (queuedCount > 0) {
              log(`${queuedCount}/${safeFixes.length} patch(es) queued for deferred git deploy (fallback)`, 'INFO', 'self-heal');
            }
          }
        } else {
          log('No GITHUB_TOKEN+REPO or RENDER_API_KEY+SERVICE_ID — cannot redeploy. Patches active via overlay only.', 'WARN', 'self-heal');
          let queuedCount = 0;
          for (const fix of safeFixes) {
            if (gitDeploy.isDeployAllowed(fix.file)) {
              gitDeploy.recordPatchForVerification(fix.id || String(Date.now()), fix.file);
              queuedCount++;
            }
          }
          if (queuedCount > 0) {
            log(`${queuedCount}/${safeFixes.length} patch(es) queued for deferred git deploy verification`, 'INFO', 'self-heal');
          }
        }
      } catch (gdErr: any) {
        log(`Git deploy recording failed (non-fatal): ${gdErr.message}`, 'WARN', 'self-heal');
      }
    }

    // 12. Post-heal bookkeeping
    // B1: Generate regression tests
    try {
      if (getCONFIG().REGRESSION_BANK_ENABLED) {
        const regBank = getRegressionBank();
        for (const fix of safeFixes) {
          await regBank.generateRegressionTest(investigation, fix);
        }
        log('Regression tests generated', 'INFO', 'self-heal');
      }
    } catch (e: any) { log('Regression test generation failed (non-critical)', 'WARN', 'self-heal'); }

    // D2: Store successful patches in memory
    try {
      if (getCONFIG().PATCH_MEMORY_ENABLED) {
        const patchMem = getPatchMemory();
        for (const fix of safeFixes) {
          await patchMem.storePatch(fix.id || String(Date.now()), fullErrorContext, fix.file, fix.patch, 'applied');
        }
      }
    } catch (e: any) { /* non-critical */ }

    // D3: Record model reward metrics
    try {
      if (getCONFIG().HEAL_REWARD_TRACKER_ENABLED) {
        const rewardTracker = getRewardTracker();
        for (const fix of safeFixes) {
          rewardTracker.recordStagingResult(fix.generatingModel || fix._cascadeMetadata?.providers?.join('+') || 'unknown', fix.id, 1);
        }
      }
    } catch (e: any) { /* non-critical */ }

    healed = true;
    _patchesAppliedToday++;

    // v2: Reset consecutive tribunal failures on success
    resetConsecutiveTribunalFailures();

    memoryMode.promoteAfterSelfHealFix?.(safeFixes.map((f: any) => f.file));
    log('Fix promoted — self-heal session will finalize after verification.', 'INFO', 'self-heal');

    // v2: Log cascade-specific success info
    if (isFullCascade) {
      const nonCodegenFixes = safeFixes.filter((f: any) => f._isNonCodegen);
      if (nonCodegenFixes.length > 0) {
        log(`FULL CASCADE SUCCESS: ${nonCodegenFixes.length} non-codegen fix(es) applied from ${nonCodegenFixes.map((f: any) => f._cascadeMetadata?.providers?.join(', ')).join('; ')}`, 'WARN', 'self-heal');
        logAudit(`Full cascade success: non-codegen fixes from ${nonCodegenFixes.length} provider(s)`, 'self-heal');
      } else {
        log(`FULL CASCADE SUCCESS: codegen fix(es) found after ${_consecutiveTribunalFailures} prior failures`, 'INFO', 'self-heal');
      }
    }

    break;
  }

  if (!healed) {
    log('Self-heal failed after max attempts.', 'ERROR', 'self-heal');
    _lastFailureTime = Date.now();
    rollbackAndAlert(backupPath, safeFixes[0]?.id, overlay);

    // v2: Increment consecutive tribunal failure counter
    _consecutiveTribunalFailures++;
    log(`Consecutive tribunal failure count: ${_consecutiveTribunalFailures}`, 'ERROR', 'self-heal');

    // v2: Log the escalation threshold
    if (_consecutiveTribunalFailures === 3) {
      log(`THRESHOLD REACHED: ${_consecutiveTribunalFailures} consecutive failures — next self-heal will activate FULL PROVIDER CASCADE (all providers including non-codegen)`, 'ERROR', 'self-heal');
      logAudit(`Full cascade threshold reached (${_consecutiveTribunalFailures} failures)`, 'self-heal');
      if (getCONFIG().ALERT_ON_ERROR) {
        try { ((_deps.alerting?.sendAlert) || (() => {}))(`Self-heal failed ${_consecutiveTribunalFailures} times consecutively. Next attempt will use ALL available providers (full cascade).`); } catch (e: any) {}
      }
    } else if (_consecutiveTribunalFailures > 3) {
      log(`FULL CASCADE FAILED (attempt ${_consecutiveTribunalFailures}) — all providers including non-codegen were tried`, 'CRITICAL', 'self-heal');
    }

    memoryMode.abortSelfHealSession?.('all_attempts_failed');
    try { ((_deps.alerting?.sendAlert) || (() => {}))('Self-heal failed after all attempts. Rolled back.'); } catch (e: any) { /* non-critical */ }
    return false;
  } else {
    _lastFailureTime = 0;
  }

  const duration = Date.now() - healStartTime;
  log(`Self-heal successful! (${duration}ms, ${attempts} attempt(s))`, 'INFO', 'self-heal');
  getInsertSelfHealEvent().run(
    Date.now(), 'core', 'completed', 'Self-heal succeeded',
    null, 0, 0, 0, 'success', duration, null
  );
  logAudit(`Self-heal succeeded in ${duration}ms`, 'self-heal');

  memoryMode.finalizeSelfHealSession?.();
  log('Self-heal session FINALIZED — returning to MEMORY PROTECTION mode.', 'INFO', 'self-heal');

  return true;
  } finally {
    _healInProgress = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  RUNTIME HEALING AVENUES (non-code-fix)
// ═══════════════════════════════════════════════════════════════════════════

interface RuntimeHealResult {
  healed: boolean;
  avenue: string;
  detail: string;
}

async function runtimeHealDatabase(): Promise<RuntimeHealResult> {
  try {
    const db = getDb();
    if (!db) return { healed: false, avenue: 'db_repair', detail: 'no db' };
    let repairs = 0;
    try {
      const walResult = db.pragma('integrity_check');
      if (walResult?.[0]?.integrity_check !== 'ok') {
        log('DB integrity check failed — running emergency repair', 'WARN', 'self-heal');
        try { db.pragma('wal_checkpoint(TRUNCATE)'); repairs++; } catch {}
      }
    } catch (e: any) {
      log(`DB integrity check error: ${e.message}`, 'WARN', 'self-heal');
      try { db.pragma('wal_checkpoint(TRUNCATE)'); repairs++; } catch {}
    }
    const criticalTables = ['calibration', 'patch_history', 'self_heal_events', 'progress_log'];
    for (const table of criticalTables) {
      try {
        db.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get();
      } catch {
        log(`Critical table '${table}' missing — attempting recreate`, 'WARN', 'self-heal');
        try {
          if (table === 'calibration') {
            db.exec(`CREATE TABLE IF NOT EXISTS calibration (key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)`);
          } else if (table === 'progress_log') {
            db.exec(`CREATE TABLE IF NOT EXISTS progress_log (ts INTEGER, questions_completed INTEGER, provider TEXT, model TEXT, action TEXT, success INTEGER)`);
          }
          repairs++;
        } catch (createErr: any) {
          log(`Failed to recreate table '${table}': ${createErr.message}`, 'ERROR', 'self-heal');
        }
      }
    }
    try {
      const pageCount = db.pragma('page_count')?.[0]?.page_count || 0;
      const freePages = db.pragma('freelist_count')?.[0]?.freelist_count || 0;
      if (pageCount > 100 && freePages / pageCount > 0.2) {
        db.pragma('incremental_vacuum');
        repairs++;
        log(`DB vacuumed (${freePages} free pages reclaimed)`, 'INFO', 'self-heal');
      }
    } catch {}
    if (repairs > 0) {
      return { healed: true, avenue: 'db_repair', detail: `${repairs} repair(s) applied` };
    }
    return { healed: false, avenue: 'db_repair', detail: 'db healthy' };
  } catch (e: any) {
    return { healed: false, avenue: 'db_repair', detail: e.message };
  }
}

async function runtimeHealConfig(): Promise<RuntimeHealResult> {
  try {
    const configReconciler = require('./self-heal-config-reconciler')?.configReconciler;
    if (!configReconciler?.reconcileAll) {
      return { healed: false, avenue: 'config_reconcile', detail: 'module unavailable' };
    }
    const result = await configReconciler.reconcileAll();
    if (result?.fixesApplied > 0) {
      return { healed: true, avenue: 'config_reconcile', detail: `${result.fixesApplied} config fix(es)` };
    }
    return { healed: false, avenue: 'config_reconcile', detail: 'config in sync' };
  } catch (e: any) {
    return { healed: false, avenue: 'config_reconcile', detail: e.message };
  }
}

async function runtimeHealSelectors(): Promise<RuntimeHealResult> {
  try {
    const selectorModule = require('./selectors');
    if (selectorModule._clearCache && typeof selectorModule._clearCache === 'function') {
      selectorModule._clearCache();
      return { healed: true, avenue: 'selector_reload', detail: 'selector cache cleared' };
    }
    const selectorPath = require.resolve('./selectors');
    if (require.cache[selectorPath]) {
      delete require.cache[selectorPath];
      return { healed: true, avenue: 'selector_reload', detail: 'selector module evicted from require.cache' };
    }
    return { healed: false, avenue: 'selector_reload', detail: 'no selector cache found' };
  } catch (e: any) {
    return { healed: false, avenue: 'selector_reload', detail: e.message };
  }
}

async function runtimeHealModuleQuarantine(): Promise<RuntimeHealResult> {
  try {
    const quarantine = require('./runtime-module-quarantine');
    if (quarantine.resetAll?.()) {
      const status = quarantine.getStatus?.();
      const count = status?.quarantinedCount ?? 'unknown';
      return { healed: true, avenue: 'quarantine_reset', detail: `reset ${count} quarantined module(s)` };
    }
    return { healed: false, avenue: 'quarantine_reset', detail: 'no modules quarantined' };
  } catch (e: any) {
    return { healed: false, avenue: 'quarantine_reset', detail: 'module unavailable' };
  }
}

async function runtimeHealProviders(): Promise<RuntimeHealResult> {
  try {
    let fixes = 0;
    const providerDiscovery = require('./providers-provider-discovery');
    if (providerDiscovery.refreshAllProviderModels) {
      await providerDiscovery.refreshAllProviderModels();
      fixes++;
      log('Provider rediscovery forced', 'INFO', 'self-heal');
    }
    try {
      const rateLimiter = require('./openrouter-rate-limiter');
      if (rateLimiter.resetAll) { rateLimiter.resetAll(); fixes++; log('Rate limiter reset', 'INFO', 'self-heal'); }
    } catch {}
    try {
      const fallback = require('./providers-fallback');
      if (fallback.resetFallbackIndex) { fallback.resetFallbackIndex(); fixes++; log('Provider fallback index reset', 'INFO', 'self-heal'); }
    } catch {}
    try {
      const stats = getProvidersStats();
      if (stats.resetErrorCounts) { stats.resetErrorCounts(); fixes++; log('Provider error counters reset', 'INFO', 'self-heal'); }
    } catch {}
    if (fixes > 0) {
      return { healed: true, avenue: 'provider_reset', detail: `${fixes} provider fix(es)` };
    }
    return { healed: false, avenue: 'provider_reset', detail: 'providers healthy' };
  } catch (e: any) {
    return { healed: false, avenue: 'provider_reset', detail: e.message };
  }
}

async function runtimeHealAuth(): Promise<RuntimeHealResult> {
  try {
    const authHealer = require('./self-heal-auth-healer')?.authHealer;
    if (!authHealer?.forceRefresh) {
      return { healed: false, avenue: 'auth_refresh', detail: 'module unavailable' };
    }
    const result = await authHealer.forceRefresh();
    if (result?.refreshed) {
      return { healed: true, avenue: 'auth_refresh', detail: 'auth token refreshed' };
    }
    return { healed: false, avenue: 'auth_refresh', detail: 'token still valid' };
  } catch (e: any) {
    return { healed: false, avenue: 'auth_refresh', detail: e.message };
  }
}

async function runtimeHealCacheFlush(): Promise<RuntimeHealResult> {
  try {
    let flushed = 0;
    try {
      const actionCache = require('./services-action-cache');
      if (actionCache.clear) { actionCache.clear(); flushed++; }
    } catch {}
    try {
      const mathCache = require('./math-solution-cache');
      if (mathCache.clear) { mathCache.clear(); flushed++; }
    } catch {}
    const hotReloadable = [
      'providers-config-loader', 'providers-registry', 'providers-fallback',
      'selectors', 'state-machine', 'config', 'get-config',
    ];
    for (const mod of hotReloadable) {
      try {
        const resolved = require.resolve('./' + mod);
        if (require.cache[resolved]) { delete require.cache[resolved]; flushed++; }
      } catch {}
    }
    if (global.gc) { global.gc(); flushed++; }
    if (flushed > 0) {
      return { healed: true, avenue: 'cache_flush', detail: `${flushed} cache(s) cleared` };
    }
    return { healed: false, avenue: 'cache_flush', detail: 'nothing to flush' };
  } catch (e: any) {
    return { healed: false, avenue: 'cache_flush', detail: e.message };
  }
}

async function performRuntimeHeal(): Promise<{ healed: boolean; results: RuntimeHealResult[] }> {
  const avenues: Array<() => Promise<RuntimeHealResult>> = [
    runtimeHealDatabase,
    runtimeHealConfig,
    runtimeHealSelectors,
    runtimeHealModuleQuarantine,
    runtimeHealProviders,
    runtimeHealAuth,
    runtimeHealCacheFlush,
  ];

  log(`Running ${avenues.length} runtime healing avenues in parallel...`, 'INFO', 'self-heal');

  const results = await Promise.allSettled(avenues.map(fn => fn()));
  const healed: RuntimeHealResult[] = [];
  let anySuccess = false;

  for (const result of results) {
    if (result.status === 'fulfilled') {
      healed.push(result.value);
      if (result.value.healed) {
        anySuccess = true;
        log(`Runtime heal SUCCESS: ${result.value.avenue} — ${result.value.detail}`, 'INFO', 'self-heal');
      } else {
        log(`Runtime heal skip: ${result.value.avenue} — ${result.value.detail}`, 'DEBUG', 'self-heal');
      }
    } else {
      healed.push({ healed: false, avenue: 'unknown', detail: result.reason?.message || 'rejected' });
    }
  }

  try {
    const successes = healed.filter(r => r.healed);
    getInsertSelfHealEvent()?.(
      Date.now(), 'runtime_heal', anySuccess ? 'completed' : 'failed',
      `${successes.length}/${avenues.length} avenues succeeded`,
      null, 0, 0, 0, anySuccess ? 'success' : null,
      0, JSON.stringify(healed.map(r => ({ a: r.avenue, h: r.healed, d: r.detail })))
    );
  } catch {}

  return { healed: anySuccess, results: healed };
}

// ═════════════════════════════════════════════════════════════
//  SAFETY LIMITS
// ═════════════════════════════════════════════════════════════

const SELF_HEAL_DAILY_MAX_PATCHES = 5;
const SELF_HEAL_COOLDOWN_AFTER_FAILURE_MS = 30 * 60 * 1000; // 30 min
let _patchesAppliedToday = 0;
let _lastPatchDay = new Date().toDateString();
let _lastFailureTime = 0;

function checkSelfHealSafety() {
  if (isExecutiveMode()) return true;

  // v2: Full cascade bypasses daily limit (last resort)
  if (_consecutiveTribunalFailures >= 3) return true;

  const today = new Date().toDateString();
  if (today !== _lastPatchDay) {
    _patchesAppliedToday = 0;
    _lastPatchDay = today;
  }
  if (_patchesAppliedToday >= SELF_HEAL_DAILY_MAX_PATCHES) {
    log(`Self-heal daily limit reached (${SELF_HEAL_DAILY_MAX_PATCHES}). Waiting until tomorrow.`, 'WARN', 'self-heal');
    return false;
  }
  if (Date.now() - _lastFailureTime < SELF_HEAL_COOLDOWN_AFTER_FAILURE_MS) {
    const remaining = Math.ceil((SELF_HEAL_COOLDOWN_AFTER_FAILURE_MS - (Date.now() - _lastFailureTime)) / 60000);
    log(`Self-heal in cooldown after failure. ${remaining} min remaining.`, 'WARN', 'self-heal');
    return false;
  }
  return true;
}

// ═════════════════════════════════════════════════════════════
//  EXPORTS
// ═════════════════════════════════════════════════════════════

let _exportedPerformSelfHeal = performSelfHeal;
let _circuitBreakerWrapped = false;

function _maybeWrapWithCircuitBreaker() {
  if (_circuitBreakerWrapped) return;
  _circuitBreakerWrapped = true;
  try {
    if (getCONFIG().HEALER_CIRCUIT_BREAKER_ENABLED) {
      const cb = getHealerCircuitBreaker();
      if (cb?.healerCircuitBreaker?.wrapPerformSelfHeal) {
        _exportedPerformSelfHeal = cb.healerCircuitBreaker.wrapPerformSelfHeal(performSelfHeal);
        log('Healer circuit breaker wrapped performSelfHeal', 'INFO', 'self-heal');
      } else if (cb?.wrapPerformSelfHeal) {
        _exportedPerformSelfHeal = cb.wrapPerformSelfHeal(performSelfHeal);
        log('Healer circuit breaker wrapped performSelfHeal', 'INFO', 'self-heal');
      }
    }
  } catch (e: any) {
    log('Healer circuit breaker init failed, using unwrapped self-heal', 'WARN', 'self-heal');
  }
}

module.exports = {
  get performSelfHeal() {
    _maybeWrapWithCircuitBreaker();
    return _exportedPerformSelfHeal;
  },
  performRuntimeHeal,
  _injectDependencies,
  // v2: Expose cascade state for dashboard/diagnostics
  getConsecutiveTribunalFailures,
  resetConsecutiveTribunalFailures,
};
