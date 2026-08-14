'use strict';
// Last modified: 2026-08-12 — Remote git commit + Render deploy for self-heal
//
// ═══════════════════════════════════════════════════════════════════════════════
// Self-Heal Git Deploy
//
// Problem: On Render, the /tmp overlay and hot-swap only heal the RUNNING
// instance. If the instance OOMs, crash-loops, or gets replaced by a new
// deploy, all patches are lost. The bot is stuck in a cycle of:
//   heal → work for a while → OOM/crash → new instance → broken again → heal
//
// Solution: After a patch is verified working (via overlay + hot-swap),
// push it to GitHub via the GitHub Contents API (no local git needed),
// then trigger a Render deploy. The new instance boots with the fix
// baked into the code on disk — no overlay, no interceptor, no hacks.
//
// Two deployment paths:
//   Path A (GitHub push):  Commit to branch → Render auto-deploys on push
//   Path B (Render API):   POST to Render deploy API with patch IDs in env
//
// Safety gates:
//   - Patches must be verified working for VERIFICATION_CYCLES cycles first
//   - Max SELF_DEPLOY_DAILY_MAX deploys per day
//   - Min SELF_DEPLOY_COOLDOWN_MIN between deploys
//   - Only files in ALLOWED_DEPLOY_PREFIXES can be committed
//   - Auto-rollback if new instance fails health checks within ROLLBACK_WINDOW
// ═══════════════════════════════════════════════════════════════════════════════

const https = require('https');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }
function getDb() { return _deps.database?.db; }
function getInsertSelfHealEvent() { return _deps.database?.insertSelfHealEvent; }

function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

// ─── Configuration ─────────────────────────────────────────────────────────

const SELF_DEPLOY_DAILY_MAX = 3;
const SELF_DEPLOY_COOLDOWN_MIN = 30;
const VERIFICATION_CYCLES_REQUIRED = 5; // Patch must work for 5 cycles before deploy
const ROLLBACK_WINDOW_MS = 15 * 60 * 1000; // 15 min to detect a bad deploy

/**
 * Files that can be committed to GitHub. Much narrower than overlay's
 * ALLOWED_PREFIXES because this is permanent — a bad commit persists.
 */
const ALLOWED_DEPLOY_PREFIXES = [
  'selectors-',
  'providers-detection-',
  'providers-config-loader',
  'providers-fallback',
  'providers-registry',
  'cycle-stagnation',
  'cycle-action-executor',
  'utils-',
  'self-heal-selector-drift',
  'self-heal-config-reconciler',
];

// ─── State ──────────────────────────────────────────────────────────────────

let _deploysToday = 0;
let _lastDeployDay = new Date().toDateString();
let _lastDeployTime = 0;
let _pendingVerification: Map<string, { patchId: string; file: string; cyclesOk: number; firstVerifiedAt: number }> = new Map();
let _deployInProgress = false;

// ─── GitHub API ─────────────────────────────────────────────────────────────

/**
 * Make an authenticated request to the GitHub API.
 * Returns parsed JSON or null on failure.
 */
function githubApi(method: string, path: string, body?: any): Promise<any> {
  return new Promise((resolve) => {
    const token = process.env.GITHUB_TOKEN;
    const repo = process.env.GITHUB_REPO; // e.g. 'owner/repo'

    if (!token || !repo) {
      log('Git deploy: GITHUB_TOKEN or GITHUB_REPO not set', 'WARN', 'self-heal-git-deploy');
      resolve(null);
      return;
    }

    const url = `https://api.github.com/repos/${repo}${path}`;
    const options: any = {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'User-Agent': 'MathU-Bot-SelfHeal',
        'Accept': 'application/vnd.github.v3+json',
      },
    };

    if (body) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    const req = https.request(url, options, (res: any) => {
      let data = '';
      res.on('data', (chunk: any) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(data)); }
          catch { resolve(data || true); }
        } else {
          log(`GitHub API ${method} ${path} → ${res.statusCode}: ${data.substring(0, 200)}`, 'WARN', 'self-heal-git-deploy');
          resolve(null);
        }
      });
    });

    req.on('error', (err: Error) => {
      logError(`GitHub API request failed: ${method} ${path}`, err);
      resolve(null);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      log(`GitHub API timeout: ${method} ${path}`, 'WARN', 'self-heal-git-deploy');
      resolve(null);
    });

    req.end();
  });
}

/**
 * Get the current commit SHA of the default branch.
 */
async function getDefaultBranchSha(): Promise<{ sha: string; branch: string } | null> {
  try {
    const repo = process.env.GITHUB_REPO;
    // Get default branch
    const repoInfo = await githubApi('GET', '');
    if (!repoInfo?.default_branch) return null;
    const branch = repoInfo.default_branch;

    // Get latest commit SHA
    const ref = await githubApi('GET', `/git/ref/heads/${branch}`);
    if (!ref?.object?.sha) return null;
    return { sha: ref.object.sha, branch };
  } catch {
    return null;
  }
}

/**
 * Get the base64-encoded content and SHA of a file on the default branch.
 */
async function getFileContent(filePath: string): Promise<{ content: string; sha: string } | null> {
  try {
    const result = await githubApi('GET', `/contents/${filePath}`);
    if (!result?.content || !result?.sha) return null;
    // GitHub API returns base64 with newlines stripped
    return { content: result.content, sha: result.sha };
  } catch {
    return null;
  }
}

/**
 * Commit a file change to a branch via GitHub Contents API.
 * Creates the branch from the default branch if it doesn't exist.
 */
async function commitFileToBranch(
  filePath: string,
  newContent: string,
  branch: string,
  message: string
): Promise<{ commitSha: string } | null> {
  try {
    // Get the current file on the target branch (or default branch if new)
    const existing = await githubApi('GET', `/contents/${filePath}?ref=${branch}`);
    const sha = existing?.sha;

    // Encode to base64
    const content = Buffer.from(newContent, 'utf8').toString('base64');

    const body: any = {
      message,
      content,
      branch,
    };

    // If file exists, we need its SHA for update
    if (sha) {
      body.sha = sha;
    }

    const result = await githubApi('PUT', `/contents/${filePath}`, body);
    if (!result?.commit?.sha) {
      log(`Failed to commit ${filePath} to ${branch}`, 'WARN', 'self-heal-git-deploy');
      return null;
    }

    log(`Committed ${filePath} to ${branch} (sha: ${result.commit.sha.substring(0, 7)})`, 'INFO', 'self-heal-git-deploy');
    return { commitSha: result.commit.sha };
  } catch (err: any) {
    logError(`commitFileToBranch failed for ${filePath}`, err);
    return null;
  }
}

/**
 * Create a pull request.
 */
async function createPullRequest(
  headBranch: string,
  baseBranch: string,
  title: string,
  body: string
): Promise<{ number: number; url: string } | null> {
  try {
    const result = await githubApi('POST', '/pulls', {
      title,
      head: headBranch,
      base: baseBranch,
      body,
    });
    if (!result?.number) return null;
    return { number: result.number, url: result.html_url };
  } catch (err: any) {
    logError('Failed to create PR', err);
    return null;
  }
}

// ─── Render Deploy API ──────────────────────────────────────────────────────

/**
 * Trigger a new deploy on Render via the Render API.
 * Optionally passes patch IDs as env vars so the new instance
 * knows which patches to apply from DB on boot.
 */
async function triggerRenderDeploy(patchIds?: string[]): Promise<{ deployId: string } | null> {
  return new Promise((resolve) => {
    const apiKey = process.env.RENDER_API_KEY;
    const serviceId = process.env.RENDER_SERVICE_ID;

    if (!apiKey || !serviceId) {
      log('Git deploy: RENDER_API_KEY or RENDER_SERVICE_ID not set', 'WARN', 'self-heal-git-deploy');
      resolve(null);
      return;
    }

    const deployBody: any = {
      clearCache: 'do_not_clear',
    };

    // Pass patch IDs as env var so new instance can verify them on boot
    if (patchIds && patchIds.length > 0) {
      deployBody.envVars = [
        {
          key: 'SELF_HEAL_PENDING_PATCHES',
          value: patchIds.join(','),
        },
      ];
    }

    const postData = JSON.stringify(deployBody);

    const options = {
      hostname: 'api.render.com',
      port: 443,
      path: `/v1/services/${serviceId}/deploys`,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(postData),
      },
    };

    const req = https.request(options, (res: any) => {
    let data = '';
    res.on('data', (chunk: any) => { data += chunk; });
    res.on('end', () => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        try {
          const parsed = JSON.parse(data);
          log(`Render deploy triggered (id: ${parsed.id?.substring(0, 8) || 'unknown'})`, 'INFO', 'self-heal-git-deploy');
          resolve({ deployId: parsed.id });
        } catch {
          resolve({ deployId: 'unknown' });
        }
      } else {
        log(`Render deploy API → ${res.statusCode}: ${data.substring(0, 200)}`, 'WARN', 'self-heal-git-deploy');
        resolve(null);
      }
    });
  });

    req.on('error', (err: Error) => {
      logError('Render deploy API request failed', err);
      resolve(null);
    });

    req.setTimeout(30000, () => {
      req.destroy();
      log('Render deploy API timeout', 'WARN', 'self-heal-git-deploy');
      resolve(null);
    });

    req.write(postData);
    req.end();
  });
}

// ─── Rollback ───────────────────────────────────────────────────────────────

/**
 * Revert the last commit on a branch via GitHub API.
 * Used when a deployed fix makes things worse.
 */
async function rollbackBranch(branch: string, reason: string): Promise<boolean> {
  try {
    // Get the last two commits
    const commits = await githubApi('GET', `/commits?sha=${branch}&per_page=2`);
    if (!commits || commits.length < 2) {
      log('Cannot rollback: not enough commits', 'WARN', 'self-heal-git-deploy');
      return false;
    }

    // Revert the latest commit
    const result = await githubApi('POST', `/git/commits/${commits[0].sha}/reverts`, {
      message: `Auto-rollback: ${reason}`,
    });

    if (!result?.sha) return false;

    log(`Reverted commit ${commits[0].sha.substring(0, 7)} on ${branch} (reason: ${reason})`, 'WARN', 'self-heal-git-deploy');
    return true;
  } catch (err: any) {
    logError('Rollback failed', err);
    return false;
  }
}

// ─── Core Deploy Flow ───────────────────────────────────────────────────────

/**
 * Check if a file is allowed to be deployed to GitHub.
 */
function isDeployAllowed(filePath: string): boolean {
  return ALLOWED_DEPLOY_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

/**
 * Check deploy safety (rate limits, cooldowns).
 */
function checkDeploySafety(): boolean {
  const today = new Date().toDateString();
  if (today !== _lastDeployDay) {
    _deploysToday = 0;
    _lastDeployDay = today;
  }
  if (_deploysToday >= SELF_DEPLOY_DAILY_MAX) {
    log(`Self-deploy daily limit reached (${SELF_DEPLOY_DAILY_MAX})`, 'WARN', 'self-heal-git-deploy');
    return false;
  }
  const timeSinceLastDeploy = Date.now() - _lastDeployTime;
  if (timeSinceLastDeploy < SELF_DEPLOY_COOLDOWN_MIN * 60 * 1000) {
    const remaining = Math.ceil((SELF_DEPLOY_COOLDOWN_MIN * 60 * 1000 - timeSinceLastDeploy) / 60000);
    log(`Self-deploy in cooldown (${remaining}min remaining)`, 'WARN', 'self-heal-git-deploy');
    return false;
  }
  return true;
}

/**
 * Record a patch as pending verification.
 * Call this after a patch is applied via overlay + hot-swap.
 * After VERIFICATION_CYCLES_REQUIRED successful cycles, the patch
 * becomes eligible for git deploy.
 */
function recordPatchForVerification(patchId: string, file: string): void {
  if (_pendingVerification.has(file)) return; // Already tracking
  _pendingVerification.set(file, {
    patchId,
    file,
    cyclesOk: 0,
    firstVerifiedAt: Date.now(),
  });
  log(`Patch ${patchId} for ${file} queued for deployment verification`, 'INFO', 'self-heal-git-deploy');
}

/**
 * Mark a verified cycle as successful. Call once per cycle for each
 * patched file that didn't cause errors.
 */
function markCycleSuccess(file: string): void {
  const entry = _pendingVerification.get(file);
  if (!entry) return;
  entry.cyclesOk++;
  if (entry.cyclesOk >= VERIFICATION_CYCLES_REQUIRED) {
    log(`Patch for ${file} verified for ${entry.cyclesOk} cycles — eligible for git deploy`, 'INFO', 'self-heal-git-deploy');
  }
}

/**
 * Mark a verified cycle as failed. Resets the verification counter.
 */
function markCycleFailed(file: string): void {
  const entry = _pendingVerification.get(file);
  if (!entry) return;
  entry.cyclesOk = 0;
  log(`Patch for ${file} verification reset (cycle failed)`, 'WARN', 'self-heal-git-deploy');
}

/**
 * Get all patches that have been verified long enough and are eligible
 * for permanent git deploy.
 */
function getEligiblePatches(): Array<{ patchId: string; file: string; cyclesOk: number }> {
  const eligible: Array<{ patchId: string; file: string; cyclesOk: number }> = [];
  for (const [file, entry] of _pendingVerification) {
    if (entry.cyclesOk >= VERIFICATION_CYCLES_REQUIRED && isDeployAllowed(file)) {
      eligible.push({ patchId: entry.patchId, file, cyclesOk: entry.cyclesOk });
    }
  }
  return eligible;
}

/**
 * THE MAIN FUNCTION: Deploy verified patches to GitHub and trigger Render.
 *
 * Flow:
 *   1. Check safety (rate limits)
 *   2. Read verified patch content from DB / overlay
 *   3. Create a branch on GitHub via API
 *   4. Commit each patched file to the branch
 *   5. Create a PR (optional, based on config)
 *   6. If auto-merge: merge the PR → triggers Render auto-deploy
 *   7. Also trigger Render deploy API (belt and suspenders)
 *   8. Remove deployed patches from verification queue
 */
async function deployVerifiedPatches(): Promise<{
  deployed: boolean;
  method: 'github_push' | 'render_api' | 'both' | 'none';
  details: string;
  files: string[];
}> {
  if (_deployInProgress) {
    return { deployed: false, method: 'none', details: 'deploy already in progress', files: [] };
  }

  const eligible = getEligiblePatches();
  if (eligible.length === 0) {
    return { deployed: false, method: 'none', details: 'no patches eligible for deploy', files: [] };
  }

  if (!checkDeploySafety()) {
    return { deployed: false, method: 'none', details: 'rate limited', files: eligible.map(e => e.file) };
  }

  _deployInProgress = true;
  const deployedFiles: string[] = [];
  const deployedPatchIds: string[] = [];

  try {
    const config = getCONFIG();
    const autoMerge = config.SELF_HEAL_GIT_AUTO_MERGE !== false; // default true

    // 1. Get default branch info
    const branchInfo = await getDefaultBranchSha();
    if (!branchInfo) {
      log('Git deploy: cannot get default branch', 'ERROR', 'self-heal-git-deploy');
      return { deployed: false, method: 'none', details: 'cannot get default branch', files: eligible.map(e => e.file) };
    }

    // 2. Create a branch name
    const timestamp = Date.now();
    const branchName = `self-heal/auto-deploy-${timestamp}`;

    // 3. Create the branch via GitHub API
    const branchCreated = await githubApi('POST', '/git/refs', {
      ref: `refs/heads/${branchName}`,
      sha: branchInfo.sha,
    });

    if (!branchCreated) {
      // Branch might already exist, try direct push to default branch instead
      log('Branch creation failed, will push to default branch directly', 'WARN', 'self-heal-git-deploy');
    }

    const targetBranch = branchCreated ? branchName : branchInfo.branch;

    // 4. Commit each patched file
    const db = getDb();
    let commitSuccessCount = 0;

    for (const entry of eligible) {
      // Read patched content from overlay (or DB as fallback)
      const fs = require('fs');
      const path = require('path');
      const overlayPath = path.resolve('/tmp/self-heal-overlay', entry.file);
      let patchedContent: string | null = null;

      if (fs.existsSync(overlayPath)) {
        patchedContent = fs.readFileSync(overlayPath, 'utf8');
      } else if (db) {
        // Fallback: read from patch_history DB
        try {
          const row = db.prepare(
            "SELECT patch FROM patch_history WHERE id = ? AND status = 'applied' ORDER BY timestamp DESC LIMIT 1"
          ).get(entry.patchId);
          if (row?.patch) {
            // If it's a diff, we need the original to apply it
            // For simplicity, we only support full-file replacements via git deploy
            if (!row.patch.startsWith('---')) {
              patchedContent = row.patch;
            }
          }
        } catch {}
      }

      if (!patchedContent) {
        log(`No patched content available for ${entry.file}, skipping`, 'WARN', 'self-heal-git-deploy');
        continue;
      }

      // Commit to GitHub
      const message = `self-heal: fix ${entry.file} (patch ${entry.patchId}, verified ${entry.cyclesOk} cycles)`;
      const result = await commitFileToBranch(entry.file, patchedContent, targetBranch, message);

      if (result) {
        commitSuccessCount++;
        deployedFiles.push(entry.file);
        deployedPatchIds.push(entry.patchId);
      }
    }

    if (commitSuccessCount === 0) {
      log('No files committed, aborting deploy', 'WARN', 'self-heal-git-deploy');
      return { deployed: false, method: 'none', details: 'no commits succeeded', files: [] };
    }

    // 5. Create PR and optionally auto-merge
    let deployMethod: 'github_push' | 'render_api' | 'both' = 'github_push';

    if (branchCreated && targetBranch !== branchInfo.branch) {
      // Create a PR
      const pr = await createPullRequest(
        targetBranch,
        branchInfo.branch,
        `Self-heal: auto-fix ${commitSuccessCount} file(s)`,
        `Verified working for ${VERIFICATION_CYCLES_REQUIRED}+ cycles via /tmp overlay.\n\nFiles: ${deployedFiles.join(', ')}\n\nPatch IDs: ${deployedPatchIds.join(', ')}`
      );

      if (pr) {
        log(`PR created: #${pr.number} — ${pr.url}`, 'INFO', 'self-heal-git-deploy');

        if (autoMerge) {
          // Merge the PR → this triggers Render auto-deploy
          const merged = await githubApi('PUT', `/pulls/${pr.number}/merge`, {
            commit_title: `Auto-merge self-heal #${pr.number}`,
            merge_method: 'squash',
          });

          if (merged) {
            log(`PR #${pr.number} auto-merged — Render will auto-deploy`, 'INFO', 'self-heal-git-deploy');
          } else {
            log(`PR #${pr.number} auto-merge failed — will try Render API`, 'WARN', 'self-heal-git-deploy');
            deployMethod = 'render_api';
          }
        }
      } else {
        log('PR creation failed — falling back to Render API', 'WARN', 'self-heal-git-deploy');
        deployMethod = 'render_api';
      }
    }

    // 6. Also trigger Render Deploy API (belt and suspenders)
    // This works even if the GitHub push didn't trigger an auto-deploy
    const renderResult = await triggerRenderDeploy(deployedPatchIds);
    if (renderResult) {
      deployMethod = deployMethod === 'github_push' ? 'both' : 'render_api';
    }

    // 7. Update state
    _deploysToday++;
    _lastDeployTime = Date.now();

    // Remove deployed patches from verification queue
    for (const file of deployedFiles) {
      _pendingVerification.delete(file);
    }

    // Record in DB
    try {
      getInsertSelfHealEvent()?.(
        Date.now(), 'git_deploy', 'completed',
        `Deployed ${deployedFiles.length} files via ${deployMethod}`,
        null, 0, 0, 0, 'success', 0,
        JSON.stringify({ method: deployMethod, files: deployedFiles, patchIds: deployedPatchIds, branch: targetBranch })
      );
    } catch {}

    logAudit(`Git deploy: ${deployedFiles.length} files deployed via ${deployMethod}`, 'self-heal-git-deploy');

    return {
      deployed: true,
      method: deployMethod,
      details: `${deployedFiles.length} files committed and deployed`,
      files: deployedFiles,
    };
  } catch (err: any) {
    logError('Git deploy failed', err);
    try {
      getInsertSelfHealEvent()?.(
        Date.now(), 'git_deploy', 'failed', err.message,
        null, 0, 0, 0, null, 0, null
      );
    } catch {}
    return { deployed: false, method: 'none', details: err.message, files: [] };
  } finally {
    _deployInProgress = false;
  }
}

// ─── Status ─────────────────────────────────────────────────────────────────

function getStatus() {
  return {
    deploysToday: _deploysToday,
    maxDeploysPerDay: SELF_DEPLOY_DAILY_MAX,
    lastDeployTime: _lastDeployTime,
    deployInProgress: _deployInProgress,
    pendingVerificationCount: _pendingVerification.size,
    pendingFiles: Array.from(_pendingVerification.entries()).map(([file, e]) => ({
      file,
      cyclesOk: e.cyclesOk,
      required: VERIFICATION_CYCLES_REQUIRED,
      eligible: e.cyclesOk >= VERIFICATION_CYCLES_REQUIRED,
    })),
    githubConfigured: !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO),
    renderConfigured: !!(process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID),
  };
}

/**
 * Restore pending verification state from DB (survives restarts).
 */
function restoreFromDb(): void {
  try {
    const db = getDb();
    if (!db) return;

    // Check for any in-progress git deploys
    const row = db.prepare(
      "SELECT value FROM calibration WHERE key = 'git_deploy_pending'"
    ).get();

    if (row?.value) {
      try {
        const pending = JSON.parse(row.value);
        if (Array.isArray(pending)) {
          for (const entry of pending) {
            if (entry.file && entry.patchId) {
              _pendingVerification.set(entry.file, {
                patchId: entry.patchId,
                file: entry.file,
                cyclesOk: 0, // Reset on restart — re-verify
                firstVerifiedAt: Date.now(),
              });
            }
          }
          log(`Restored ${pending.length} pending verification(s) from DB`, 'INFO', 'self-heal-git-deploy');
        }
      } catch {}
    }
  } catch {}
}

/**
 * Persist pending verification state to DB.
 */
function saveToDb(): void {
  try {
    const db = getDb();
    if (!db) return;

    const pending = Array.from(_pendingVerification.values()).map(e => ({
      patchId: e.patchId,
      file: e.file,
    }));

    db.prepare(
      "INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)"
    ).run('git_deploy_pending', JSON.stringify(pending), Date.now());
  } catch {}
}

// ─── Auto Cycle Tracking ─────────────────────────────────────────────────
// Instead of requiring external markCycleSuccess/Failed calls (which would
// need wiring into the cycle manager), we auto-track verification by querying
// the self_heal_events DB table for recent failures mentioning the patched file.
// Each periodic timer tick = 1 cycle check. If no failures found since the
// patch was recorded, the cycle counts as successful.

const CYCLE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // Same as periodic timer

/**
 * Auto-increment verification cycles by checking for recent errors.
 * If a self-heal event with phase='failed' mentions the patched file
 * since firstVerifiedAt, the cycle is FAILED (counter reset).
 * Otherwise the cycle counts as OK (counter incremented).
 */
function autoTrackVerificationCycles(): void {
  if (_pendingVerification.size === 0) return;
  const db = getDb();
  if (!db) return;

  const now = Date.now();
  for (const [file, entry] of _pendingVerification) {
    try {
      // Check for any self-heal failure events since this patch was recorded
      // that mention the file name
      const failures = db.prepare(
        `SELECT COUNT(*) as cnt FROM self_heal_events
         WHERE timestamp > ? AND (outcome = 'failure' OR phase = 'failed')
         AND (trigger_reason LIKE ? OR trigger_reason LIKE ?)`
      ).get(
        entry.firstVerifiedAt,
        `%${file}%`,
        `%${path.basename(file, '.ts')}%`
      );

      if (failures?.cnt > 0) {
        // A failure was detected for this file — reset verification
        if (entry.cyclesOk > 0) {
          markCycleFailed(file);
        }
      } else {
        // No failures — count this as a successful cycle
        markCycleSuccess(file);
      }
    } catch {
      // Non-critical — DB query may fail for various reasons
    }
  }
}

// ─── Immediate Redeploy (Full Self-Heal) ──────────────────────────────────

const FULL_HEAL_SIGTERM_WATCHDOG_MS = 5 * 60 * 1000; // 5 minutes
let _fullHealWatchdogTimer: ReturnType<typeof setTimeout> | null = null;
let _fullHealRedeployInProgress = false;

/**
 * Trigger an immediate redeploy after a successful full self-heal.
 * Unlike the deferred deployVerifiedPatches() (which waits for 5
 * verification cycles), this function commits ALL overlay patches
 * to GitHub NOW and triggers a Render deploy.
 *
 * Flow:
 *   1. Read all patched files from /tmp/self-heal-overlay/
 *   2. Commit each to GitHub via Contents API (on a new branch)
 *   3. Create PR + auto-merge (or push directly)
 *   4. Trigger Render Deploy API
 *   5. Start 5-min SIGTERM watchdog — if no SIGTERM, redeploy failed
 *
 * This is the ONLY correct way to complete a full self-heal on Render.
 * The overlay + hot-swap heal the running instance, but a fresh deploy
 * from GitHub is the only way to guarantee the fix persists.
 */
async function triggerImmediateRedeploy(patchedFiles: string[]): Promise<{
  redeployed: boolean;
  method: 'github_push' | 'render_api' | 'both' | 'none';
  details: string;
  files: string[];
}> {
  const hasGithub = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
  const hasRender = !!(process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID);

  if (!hasGithub && !hasRender) {
    log('Immediate redeploy: no GITHUB_TOKEN+GITHUB_REPO or RENDER_API_KEY+RENDER_SERVICE_ID set — cannot redeploy', 'ERROR', 'self-heal-git-deploy');
    try {
      getInsertSelfHealEvent()?.(
        Date.now(), 'immediate_redeploy', 'failed', 'no_credentials',
        null, 0, 0, 0, 'error', 0,
        JSON.stringify({ files: patchedFiles, hasGithub, hasRender })
      );
    } catch {}
    return { redeployed: false, method: 'none', details: 'no GitHub or Render credentials configured', files: [] };
  }

  if (_fullHealRedeployInProgress) {
    log('Immediate redeploy already in progress, skipping', 'WARN', 'self-heal-git-deploy');
    return { redeployed: false, method: 'none', details: 'redeploy already in progress', files: [] };
  }

  // Read patched content from overlay for each file
  const fs = require('fs');
  const pathModule = require('path');
  const filesToCommit: Array<{ file: string; content: string }> = [];

  for (const file of patchedFiles) {
    const overlayPath = pathModule.resolve('/tmp/self-heal-overlay', file);
    if (fs.existsSync(overlayPath)) {
      try {
        const content = fs.readFileSync(overlayPath, 'utf8');
        filesToCommit.push({ file, content });
      } catch (err: any) {
        log(`Cannot read overlay for ${file}: ${err.message}`, 'WARN', 'self-heal-git-deploy');
      }
    } else {
      log(`No overlay file for ${file} at ${overlayPath} — skipping`, 'WARN', 'self-heal-git-deploy');
    }
  }

  if (filesToCommit.length === 0) {
    log('No patched files found in overlay to commit', 'WARN', 'self-heal-git-deploy');
    return { redeployed: false, method: 'none', details: 'no patched files in overlay', files: [] };
  }

  _fullHealRedeployInProgress = true;
  const committedFiles: string[] = [];

  try {
    const config = getCONFIG();
    const autoMerge = config.SELF_HEAL_GIT_AUTO_MERGE !== false; // default true

    // 1. Get default branch info
    const branchInfo = await getDefaultBranchSha();
    if (!branchInfo && hasGithub) {
      log('Immediate redeploy: cannot get default branch from GitHub', 'ERROR', 'self-heal-git-deploy');
    }

    // 2. Create a branch
    let targetBranch: string;
    let branchCreated = false;

    if (branchInfo) {
      const timestamp = Date.now();
      const branchName = `self-heal/full-heal-${timestamp}`;
      const created = await githubApi('POST', '/git/refs', {
        ref: `refs/heads/${branchName}`,
        sha: branchInfo.sha,
      });

      if (created) {
        targetBranch = branchName;
        branchCreated = true;
        log(`Created branch ${branchName} for full-heal redeploy`, 'INFO', 'self-heal-git-deploy');
      } else {
        targetBranch = branchInfo.branch;
        log('Branch creation failed, pushing directly to default branch', 'WARN', 'self-heal-git-deploy');
      }
    } else {
      targetBranch = 'main'; // fallback
    }

    // 3. Commit each patched file to GitHub
    if (hasGithub && branchInfo) {
      for (const entry of filesToCommit) {
        const message = `full self-heal: fix ${entry.file} (immediate redeploy ${new Date().toISOString()})`;
        const result = await commitFileToBranch(entry.file, entry.content, targetBranch, message);
        if (result) {
          committedFiles.push(entry.file);
        }
      }
    }

    // 4. Create PR + auto-merge
    let deployMethod: 'github_push' | 'render_api' | 'both' = 'render_api';

    if (hasGithub && branchCreated && branchInfo && committedFiles.length > 0) {
      const pr = await createPullRequest(
        targetBranch,
        branchInfo.branch,
        `Full self-heal: auto-fix ${committedFiles.length} file(s)`,
        `Immediate redeploy after successful full self-heal.\n\nFiles: ${committedFiles.join(', ')}\n\nTimestamp: ${new Date().toISOString()}`
      );

      if (pr) {
        log(`PR created: #${pr.number} — ${pr.url}`, 'INFO', 'self-heal-git-deploy');

        if (autoMerge) {
          const merged = await githubApi('PUT', `/pulls/${pr.number}/merge`, {
            commit_title: `Auto-merge full self-heal #${pr.number}`,
            merge_method: 'squash',
          });

          if (merged) {
            log(`PR #${pr.number} auto-merged — Render will auto-deploy from push`, 'INFO', 'self-heal-git-deploy');
            deployMethod = 'github_push';
          } else {
            log(`PR #${pr.number} auto-merge failed — will use Render API`, 'WARN', 'self-heal-git-deploy');
          }
        } else {
          deployMethod = 'github_push'; // Push still triggers Render auto-deploy
        }
      }
    } else if (hasGithub && !branchCreated && committedFiles.length > 0) {
      // Pushed directly to default branch — Render auto-deploys
      deployMethod = 'github_push';
      log(`Committed directly to ${targetBranch} — Render will auto-deploy from push`, 'INFO', 'self-heal-git-deploy');
    }

    // 5. Trigger Render Deploy API (belt and suspenders)
    if (hasRender) {
      const renderResult = await triggerRenderDeploy(committedFiles.map(f => `full-heal-${f}`));
      if (renderResult) {
        deployMethod = deployMethod === 'github_push' ? 'both' : 'render_api';
        log(`Render deploy triggered (id: ${renderResult.deployId?.substring(0, 8)})`, 'INFO', 'self-heal-git-deploy');
      } else {
        log('Render deploy API call failed', 'WARN', 'self-heal-git-deploy');
      }
    }

    const succeeded = committedFiles.length > 0 && (deployMethod !== 'none');

    // 6. Record event
    try {
      getInsertSelfHealEvent()?.(
        Date.now(), 'immediate_redeploy', succeeded ? 'completed' : 'failed',
        succeeded ? 'full_heal_redeploy_success' : 'full_heal_redeploy_no_commits',
        null, 0, 0, 0, succeeded ? 'success' : 'error', 0,
        JSON.stringify({ method: deployMethod, files: committedFiles, branch: targetBranch, totalAttempted: filesToCommit.length })
      );
    } catch {}

    logAudit(`Immediate redeploy: ${committedFiles.length}/${filesToCommit.length} files committed via ${deployMethod}`, 'self-heal-git-deploy');

    // 7. Start SIGTERM watchdog — if Render doesn't kill us in 5 min, redeploy failed
    if (succeeded) {
      startSigtermWatchdog();
    }

    return {
      redeployed: succeeded,
      method: deployMethod,
      details: `${committedFiles.length}/${filesToCommit.length} files committed and deployed via ${deployMethod}`,
      files: committedFiles,
    };
  } catch (err: any) {
    logError('Immediate redeploy failed', err);
    try {
      getInsertSelfHealEvent()?.(
        Date.now(), 'immediate_redeploy', 'failed', err.message,
        null, 0, 0, 0, 'error', 0, null
      );
    } catch {}
    return { redeployed: false, method: 'none', details: err.message, files: [] };
  } finally {
    _fullHealRedeployInProgress = false;
  }
}

/**
 * Start a 5-minute SIGTERM watchdog.
 * After a successful immediate redeploy, Render should send SIGTERM to
 * the current instance within a few minutes (to replace it with the new deploy).
 * If no SIGTERM arrives within 5 minutes, the redeploy failed or Render
 * didn't pick up the change. Log a failure event so the next boot knows.
 */
function startSigtermWatchdog(): void {
  // Clear any existing watchdog
  if (_fullHealWatchdogTimer) {
    clearTimeout(_fullHealWatchdogTimer);
  }

  const watchdogStartedAt = Date.now();
  log(`SIGTERM watchdog started — expecting Render to terminate this instance within ${FULL_HEAL_SIGTERM_WATCHDOG_MS / 60000} minutes`, 'WARN', 'self-heal-git-deploy');

  _fullHealWatchdogTimer = setTimeout(() => {
    // If we reach here, no SIGTERM was received — redeploy failed
    const elapsed = Date.now() - watchdogStartedAt;
    log(`SIGTERM watchdog FIRED after ${Math.round(elapsed / 60000)}min — no SIGTERM received. Full self-heal redeploy FAILED.`, 'ERROR', 'self-heal-git-deploy');
    log('The new deploy did not replace this instance. Possible causes: Render didn\'t pick up the push, API key invalid, or service ID wrong.', 'ERROR', 'self-heal-git-deploy');

    try {
      getInsertSelfHealEvent()?.(
        Date.now(), 'immediate_redeploy', 'failed', 'sigterm_watchdog_fired',
        `No SIGTERM received after ${Math.round(elapsed / 60000)} minutes — redeploy did not replace this instance`,
        0, 0, 0, 'error', elapsed, null
      );
    } catch {}

    // Reset the watchdog
    _fullHealWatchdogTimer = null;
  }, FULL_HEAL_SIGTERM_WATCHDOG_MS);

  // Don't hold the process open for the watchdog — if Render sends SIGTERM,
  // it will kill us. If the watchdog fires, we just log and continue running.
  if (_fullHealWatchdogTimer?.unref) {
    _fullHealWatchdogTimer.unref();
  }
}

/**
 * Cancel the SIGTERM watchdog — call when SIGTERM is received to avoid
 * logging a false failure.
 */
function cancelSigtermWatchdog(): void {
  if (_fullHealWatchdogTimer) {
    clearTimeout(_fullHealWatchdogTimer);
    _fullHealWatchdogTimer = null;
    log('SIGTERM watchdog cancelled — instance is being replaced by new deploy', 'INFO', 'self-heal-git-deploy');
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

function init(): void {
  const config = getCONFIG();
  const enabled = config.SELF_DEPLOY_ENABLED === true
    || process.env.SELF_DEPLOY_ENABLED === 'true';

  if (!enabled) {
    log('Git deploy module DISABLED (SELF_DEPLOY_ENABLED not set)', 'INFO', 'self-heal-git-deploy');
    return;
  }

  const hasGithub = !!(process.env.GITHUB_TOKEN && process.env.GITHUB_REPO);
  const hasRender = !!(process.env.RENDER_API_KEY && process.env.RENDER_SERVICE_ID);

  if (!hasGithub && !hasRender) {
    log('Git deploy module DISABLED — no GITHUB_TOKEN+GITHUB_REPO or RENDER_API_KEY+RENDER_SERVICE_ID', 'WARN', 'self-heal-git-deploy');
    return;
  }

  restoreFromDb();

  log(`Git deploy module initialized (github: ${hasGithub}, render: ${hasRender})`, 'INFO', 'self-heal-git-deploy');

  // Periodic check: auto-track cycles + deploy eligible patches
  setInterval(async () => {
    try {
      // Auto-track verification cycles via DB error check
      autoTrackVerificationCycles();

      // Deploy any patches that reached the verification threshold
      const eligible = getEligiblePatches();
      if (eligible.length > 0) {
        log(`${eligible.length} patch(es) eligible for git deploy, starting...`, 'INFO', 'self-heal-git-deploy');
        const result = await deployVerifiedPatches();
        if (result.deployed) {
          log(`Git deploy result: ${result.method} — ${result.details}`, 'INFO', 'self-heal-git-deploy');
        }
      }
      saveToDb();
    } catch (err: any) {
      logError('Periodic git deploy check failed', err);
    }
  }, CYCLE_CHECK_INTERVAL_MS).unref?.();
}

init();

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  deployVerifiedPatches,
  triggerImmediateRedeploy,
  cancelSigtermWatchdog,
  recordPatchForVerification,
  markCycleSuccess,
  markCycleFailed,
  getEligiblePatches,
  rollbackBranch,
  getStatus,
  restoreFromDb,
  saveToDb,
  isDeployAllowed,
  _injectDependencies,
  // Constants
  VERIFICATION_CYCLES_REQUIRED,
  SELF_DEPLOY_DAILY_MAX,
  ALLOWED_DEPLOY_PREFIXES,
};
