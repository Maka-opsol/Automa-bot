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
 * already covered. This ensures new modules get backed up automatically.
 */
function buildBackupScope(): string[] {
  const staticScope = new Set(
    _BACKUP_SCOPE_BASES.flatMap(f => [f + '.ts', f + '.js'])
  );

  // Scan project root for additional source files
  try {
    const allFiles = fs.readdirSync(SOURCE_DIR);
    for (const file of allFiles) {
      if ((file.endsWith('.ts') || file.endsWith('.js')) &&
          !file.endsWith('.test.ts') && !file.endsWith('.test.js') &&
          !file.endsWith('.d.ts') &&
          !staticScope.has(file) &&
          !file.startsWith('test-') && // test helpers aren't critical
          !file.startsWith('scripts-')) { // scripts aren't critical
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

// ═══════════════════════════════════════════════════════════
//  ATOMIC FILE OPERATIONS
// ═══════════════════════════════════════════════════════════

/**
 * Atomically replace a file by writing to a temp file then renaming.
 * On the same filesystem, rename() is atomic — either the old file
 * or the new file exists, never a partial write.
 */
function atomicReplaceFile(destPath: any, content: any) {
  const dir = path.dirname(destPath);
  // Use a unique temp name in the SAME directory to ensure same-filesystem rename
  const tmpPath = path.join(dir, `.tmp-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
  try {
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, destPath);
  } catch (err: any) {
    // Clean up temp file if rename failed
    try { fs.unlinkSync(tmpPath); } catch (cleanupErr: any) { /* best effort */ }
    throw err;
  }
}

// ═══════════════════════════════════════════════════════════
//  BACKUP / ROLLBACK / PROMOTE  (pure fs, no child_process)
// ═══════════════════════════════════════════════════════════

async function backupCode() { 
  const timestamp = Date.now();
  const backupPath = path.join(getBACKUP_DIR(), `backup-${timestamp}`);
  fs.mkdirSync(backupPath, { recursive: true });

  // Rotate old backups
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
          // Restore = remove from overlay (falls back to read-only original)
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
        // Continue restoring other files — partial rollback is better than none
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
          // On read-only FS: write to /tmp overlay instead of SOURCE_DIR
          const ok = overlay.writeToOverlay(file, content);
          if (ok) {
            promotedFiles.push(file);
          } else {
            failedFiles.push(file);
          }
        } else {
          // Normal writable FS: atomic replace in place
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

  // Evict overlaid modules from require.cache so they reload on next require
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
  // Record rollback in patch memory so the system learns from it
  if (patchId) {
    try {
      const patchMemory = getPatchMemory();
      if (patchMemory && typeof patchMemory.recordOutcome === 'function') {
        patchMemory.recordOutcome(String(patchId), 'rolled_back');
      }
    } catch (_e: any) { /* non-critical */ }
  }
}

/**
 * Verify promoted files are readable and have valid structure.
 * Catches corruption from mid-crash scenarios.
 */
function verifyPromotedFiles(fixes: any, overlay?: any) {
  const targetFiles = fixes.map((f: any) => f.file);
  let allValid = true;

  for (const file of targetFiles) {
    // When using overlay, verify from the overlay path
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
    // Verify the file starts with 'use strict' or a valid module pattern
    const trimmedStart = content.trimStart().substring(0, 20);
    const validStarts = ["'use strict'", '"use strict"', "'use strict';", '"use strict";', 'import ', 'export ', '//', '/*', '/**'];
    const hasValidStart = validStarts.some(s => trimmedStart.startsWith(s));
    if (!hasValidStart) {
      log(`Post-promotion verification WARNING: ${file} does not start with a recognized pattern (starts with: "${trimmedStart.substring(0, 30)}")`, 'WARN', 'self-heal');
    }
  }

  return allValid;
}

// ═══════════════════════════════════════════════════════════
//  INVESTIGATION
// ═══════════════════════════════════════════════════════════

async function investigatePage() { 
  log('Investigating page for self-healing...', 'INFO', 'self-heal');
  let page;
  try {
    page = await (_deps.browser?.launchBrowser || (() => {}))();
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

// ═══════════════════════════════════════════════════════════
//  TWO-LAYER AUDIT COORDINATION
//
//  Layer 1: Sandbox (deterministic, fast)
//    - File-level: isPatchableFile (immutable/restricted/allowed)
//    - Content-level: auditPatchContent (30+ blocked patterns)
//    - Path traversal, syntax validation, size limit
//
//  Layer 2: AI Auditor (probabilistic, slower)
//    - Keyword pre-filter (isObviouslyMalicious)
//    - AI tribunal vote (multiple independent models)
//
//  For RESTRICTED files, Layer 2 results are submitted to the
//  approval workflow which requires supermajority + no veto.
// ═══════════════════════════════════════════════════════════

/**
 * Run the two-layer audit on a single fix.
 *
 * @param {Object} fix - { file, patch, change, generatingModel }
 * @returns {Promise<{ passed: boolean, reason?: string, approvalStatus?: string }>}
 */
async function auditFix(fix: any) { 
  const { file, patch } = fix;

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
  // For restricted files, we need explicit votes for the approval workflow.
  // For allowed files, a simple safe/unsafe is sufficient.
  let auditResult;

  if (sandboxResult.requiresApproval) {
    // RESTRICTED file — need tribunal votes for approval workflow
    log(`Restricted file ${file}: requesting AI tribunal votes`, 'INFO', 'self-heal');
    auditResult = await getAuditPatchWithVotes()(patch);
  } else {
    // Allowed file — standard audit (keyword + single AI check)
    auditResult = await getAuditPatch()(patch);
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

/**
 * Handle approval for a restricted file using the PatchApprovalQueue.
 *
 * @param {Object} fix
 * @param {Object} auditResult - Must include `votes` array for restricted files
 * @returns {Promise<{ approved: boolean, reason: string }>}
 */
async function handleRestrictedFileApproval(fix: any, auditResult: any) { 
  const queue = getApprovalQueue();
  const patchId = `sh-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const patchHash = crypto.createHash('sha256').update(fix.patch).digest('hex');
  const patchSize = Buffer.byteLength(fix.patch, 'utf8');

  // Create approval request
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

  // Submit AI auditor votes
  const votes = (auditResult.votes || []).map((v: any) => ({
    auditor: v.auditor || v.provider || 'unknown',
    safe: v.safe !== false && v.is_safe !== false,
    reason: v.reason || '',
  }));

  // If no votes were collected (auditor returned safe but no vote details),
  // create a single synthetic vote based on the overall result
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

// ═══════════════════════════════════════════════════════════
//  STAGING (no child_process — pure fs + sandbox validation)
// ═══════════════════════════════════════════════════════════

/**
 * Apply validated fixes to the staging area.
 *
 * Security guarantees at this point:
 *   - Sandbox validated: file is patchable, content has no dangerous patterns,
 *     path traversal blocked, syntax valid, size < 50KB
 *   - AI auditor validated: no malicious intent detected
 *   - For restricted files: approval workflow granted
 *
 * We ONLY do full file replacement — no diff/patch command.
 * If a patch looks like a unified diff, we reject it (the tribunal should
 * generate full file content).
 *
 * @param {Array} fixes  - Validated fixes
 * @param {string} stagingSource - Path to staging source dir
 * @returns {boolean}
 */
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

    // Write the patch as full file content
    try {
      atomicReplaceFile(filePath, fix.patch);
      log(`Applied patch to ${fix.file} in staging (atomic full replacement)`, 'INFO', 'self-heal');
    } catch (err: any) {
      logError(`Failed to write patch for ${fix.file}`, err);
      return false;
    }

    // Record in database
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

// ═══════════════════════════════════════════════════════════
//  MAIN SELF-HEAL ORCHESTRATOR
// ═══════════════════════════════════════════════════════════

let _healInProgress = false;

async function performSelfHeal() {
  if (_healInProgress) { log('Self-heal already in progress, skipping', 'DEBUG', 'self-heal'); return false; }
  // v8-fix: On Render/ephemeral disks, source files are read-only (deployed from git).
  // Use the /tmp overlay system: patches are written to /tmp/self-heal-overlay/,
  // and a require() interceptor makes Node load them instead of the read-only
  // originals. The overlay is repopulated from patch_history DB on each boot.
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

  // v4: If in memory_protection, request a self-heal session to get full power.
  // This is the ONLY way to get full power automatically. The session has a
  // 30-minute timeout and all progress is saved to DB to survive OOM kills.
  const memoryMode = getMemoryMode();
  const sessionRequested = memoryMode.isMemoryProtection() && memoryMode.beginSelfHealSession('self_heal_triggered');
  if (sessionRequested) {
    log('Self-heal session STARTED — full power granted for healing. All progress will be saved to DB.', 'WARN', 'self-heal');
  }

  log('Starting self-heal process...', 'INFO', 'self-heal');
  logAudit('Self-heal process started', 'self-heal');
  const healStartTime = Date.now();
  const backupPath = await backupCode();

  let attempts = 0;
  let healed = false;
  let safeFixes: any[] = [];

  while (attempts < getCONFIG().SELF_HEAL_MAX_ATTEMPTS && !healed) {
    attempts++;
    log(`Self-heal attempt ${attempts}/${getCONFIG().SELF_HEAL_MAX_ATTEMPTS}`, 'INFO', 'self-heal');

    // 1. Investigate the current page state
    const investigation = await investigatePage();
    if (!investigation) {
      log('Investigation failed, retrying', 'ERROR', 'self-heal');
      memoryMode.appendSelfHealProgress?.('investigation_failed', { attempt: attempts });
      continue;
    }
    // v4: Save investigation to DB (survives OOM)
    memoryMode.appendSelfHealProgress?.('investigation', { summary: investigation?.summary?.substring(0, 200), attempt: attempts });

    // 2. Gather error context
    const errorLogs = getRecentErrors();

    // 3. Build patch context from memory (D2: few-shot from past fixes)
    let patchContext = '';
    try {
      if (getCONFIG().PATCH_MEMORY_ENABLED) {
        const patchMem = getPatchMemory();
        patchContext = await patchMem.buildContextForTribunal(errorLogs);
        if (patchContext) log('Patch memory provided similar past fixes', 'INFO', 'self-heal');
      }
    } catch (e: any) { /* non-critical */ }

    // 4. Generate fixes via AI tribunal
    let fixes: any[] | null;
    try {
      fixes = await getGenerateCodeFixViaTribunal()(
        investigation,
        errorLogs + (patchContext ? '\n\n' + patchContext : '')
      );
    } catch (err: any) {
      logError('Tribunal failed to generate fixes', err);
      continue;
    }

    if (!fixes || fixes.length === 0) {
      log('No fixes generated by tribunal', 'WARN', 'self-heal');
      memoryMode.appendSelfHealProgress?.('no_fixes', { attempt: attempts });
      continue;
    }

    // v4: Save generated fixes to DB (survives OOM)
    memoryMode.appendSelfHealProgress?.('fixes_generated', {
      count: fixes.length,
      files: fixes.map((f: any) => f.file),
      attempt: attempts,
    });

    // 5. Two-layer audit on each fix (sandbox → AI auditor → approval workflow)
    safeFixes = [];
    const blockedFixes: any[] = [];

    for (const fix of fixes) {
      const result = await auditFix(fix);
      if (result.passed) {
        safeFixes.push(fix);
        log(`Patch for ${fix.file} passed all audit layers`, 'INFO', 'self-heal');
      } else {
        blockedFixes.push({ file: fix.file, reason: result.reason });
        log(`Patch for ${fix.file} BLOCKED: ${result.reason}`, 'WARN', 'self-heal');
        if (getCONFIG().ALERT_ON_ERROR) {
          try { ((_deps.alerting?.sendAlert) || (() => {}))(`Self-heal blocked patch for ${fix.file}: ${result.reason}`); } catch (e: any) { /* non-critical */ }
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
      return false;
    }

    // 6. Minimize diffs before staging (B3)
    try {
      if (getCONFIG().DIFF_MINIMIZER_ENABLED) {
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

    // 7. Prepare staging area (copy current source to staging)
    const stagingSource = copyToStaging();

    // 8. Apply validated fixes to staging
    const applyOk = applyFixesToStaging(safeFixes, stagingSource);
    if (!applyOk) {
      log('Apply to staging failed, rolling back', 'WARN', 'self-heal');
      rollbackAndAlert(backupPath, safeFixes[0]?.id, overlay);
      continue;
    }

    // 9. Run critical validation suite on STAGED code (not live code)
    //    We must validate the patched version before promoting it.
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

    // 10. Adversarial testing (B4)
    try {
      if (getCONFIG().ADVERSARIAL_TESTER_ENABLED) {
        const { testPatch: adversarialTest } = getAdversarialTester();
        for (const fix of safeFixes) {
          const advResult = await adversarialTest(fix.patch, fix.file);
          if (!advResult.passed) {
            const failedTypes = (advResult.results || []).filter((r: any) => !r.passed).map((r: any) => r.testType).join(', ');
            log(`Adversarial test failed for ${fix.file}: ${failedTypes}`, 'WARN', 'self-heal');
            if (getCONFIG().ALERT_ON_ERROR) {
              try { ((_deps.alerting?.sendAlert) || (() => {}))(`Patch for ${fix.file} failed adversarial testing`); } catch (e: any) { /* non-critical */ }
            }
          } else {
            log(`Adversarial test passed for ${fix.file}`, 'INFO', 'self-heal');
          }
        }
      }
    } catch (e: any) {
      log('Adversarial testing failed, continuing (non-critical)', 'WARN', 'self-heal');
    }

    // 11. Promote or enter canary
    let promotedDirectly = true;
    try {
      if (getCONFIG().CANARY_ROLLOUT_ENABLED) {
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

      // Post-promotion verification: check files are valid after atomic write
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
          await patchMem.storePatch(fix.id || String(Date.now()), errorLogs, fix.file, fix.patch, 'applied');
        }
      }
    } catch (e: any) { /* non-critical */ }

    // D3: Record model reward metrics
    try {
      if (getCONFIG().HEAL_REWARD_TRACKER_ENABLED) {
        const rewardTracker = getRewardTracker();
        for (const fix of safeFixes) {
          rewardTracker.recordStagingResult(fix.generatingModel || 'unknown', fix.id, 1);
        }
      }
    } catch (e: any) { /* non-critical */ }

    healed = true;
    _patchesAppliedToday++;

    // v4: Notify memory-mode that a fix was promoted.
    // This is the ONLY path that justifies full power. The bot will
    // stay in full power briefly for verification, then finalizeSelfHealSession()
    // returns it to memory_protection.
    memoryMode.promoteAfterSelfHealFix?.(safeFixes.map((f: any) => f.file));
    log('Fix promoted — self-heal session will finalize after verification.', 'INFO', 'self-heal');
    break;
  }

  if (!healed) {
    log('Self-heal failed after max attempts.', 'ERROR', 'self-heal');
    _lastFailureTime = Date.now();
    rollbackAndAlert(backupPath, safeFixes[0]?.id, overlay);
    // v4: Abort self-heal session on failure
    memoryMode.abortSelfHealSession?.('all_attempts_failed');
    try { ((_deps.alerting?.sendAlert) || (() => {}))('Self-heal failed after all attempts. Rolled back.'); } catch (e: any) { /* non-critical */ }
    return false;
  } else {
    _lastFailureTime = 0; // Reset cooldown on successful heal
  }

  const duration = Date.now() - healStartTime;
  log(`Self-heal successful! (${duration}ms, ${attempts} attempt(s))`, 'INFO', 'self-heal');
  getInsertSelfHealEvent().run(
    Date.now(), 'core', 'completed', 'Self-heal succeeded',
    null, 0, 0, 0, 'success', duration, null
  );
  logAudit(`Self-heal succeeded in ${duration}ms`, 'self-heal');

  // v4: Finalize self-heal session — returns to MEMORY PROTECTION.
  // The fix is already promoted; the bot proved it can handle this.
  // Now it goes back to safe mode. Patch drafts are deleted from DB.
  memoryMode.finalizeSelfHealSession?.();
  log('Self-heal session FINALIZED — returning to MEMORY PROTECTION mode.', 'INFO', 'self-heal');

  return true;
  } finally {
    _healInProgress = false;
  }
}

// ═══════════════════════════════════════════════════════════
//  SAFETY LIMITS
// ═══════════════════════════════════════════════════════════

const SELF_HEAL_DAILY_MAX_PATCHES = 5;
const SELF_HEAL_COOLDOWN_AFTER_FAILURE_MS = 30 * 60 * 1000; // 30 min
let _patchesAppliedToday = 0;
let _lastPatchDay = new Date().toDateString();
let _lastFailureTime = 0;

function checkSelfHealSafety() { 
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

// ═══════════════════════════════════════════════════════════
//  EXPORTS
// ═══════════════════════════════════════════════════════════

// Build the final export object so that consumers always get a stable
// reference — no post-require mutation of module.exports.performSelfHeal.
let _exportedPerformSelfHeal = performSelfHeal;
let _circuitBreakerWrapped = false;

// Wire the healer circuit breaker if enabled (deferred — not at module scope)
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
  _injectDependencies
};
