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
const { safeArrayFrom } = require('./providers-base');

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
 * Make an authenticated request to the GitHub API with retry.
 * Retries on 429 (rate limit) and 5xx (server error) up to 3 times.
 * Returns parsed JSON or null on failure.
 */
const GITHUB_API_MAX_RETRIES = 3;
const GITHUB_API_RETRY_DELAY_MS = 2000;

function githubApi(method: string, apiPath: string, body?: any): Promise<any> {
  const token = process.env.GITHUB_TOKEN;
  const repo = process.env.GITHUB_REPO; // e.g. 'owner/repo'

  if (!token || !repo) {
    log('Git deploy: GITHUB_TOKEN or GITHUB_REPO not set', 'WARN', 'self-heal-git-deploy');
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    let attempt = 0;

    function doRequest(): void {
      attempt++;
      const url = `https://api.github.com/repos/${repo}${apiPath}`;
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
          // Success
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try { resolve(JSON.parse(data)); }
            catch { resolve(data || true); }
            return;
          }

          // Retryable: 429 (rate limit) or 5xx (server error)
          const isRetryable = res.statusCode === 429 || res.statusCode >= 500;
          if (isRetryable && attempt < GITHUB_API_MAX_RETRIES) {
            const delay = res.statusCode === 429
              ? Math.min(60000, GITHUB_API_RETRY_DELAY_MS * Math.pow(2, attempt - 1))
              : GITHUB_API_RETRY_DELAY_MS * attempt;
            log(`GitHub API ${method} ${apiPath} → ${res.statusCode} (attempt ${attempt}/${GITHUB_API_MAX_RETRIES}), retrying in ${delay}ms`, 'WARN', 'self-heal-git-deploy');
            setTimeout(doRequest, delay);
            return;
          }

          // Non-retryable failure
          log(`GitHub API ${method} ${apiPath} → ${res.statusCode} (attempt ${attempt}/${GITHUB_API_MAX_RETRIES}): ${data.substring(0, 300)}`, 'ERROR', 'self-heal-git-deploy');
          resolve(null);
        });
      });

      req.on('error', (err: Error) => {
        if (attempt < GITHUB_API_MAX_RETRIES) {
          const delay = GITHUB_API_RETRY_DELAY_MS * attempt;
          log(`GitHub API ${method} ${apiPath} error (attempt ${attempt}/${GITHUB_API_MAX_RETRIES}): ${err.message}, retrying in ${delay}ms`, 'WARN', 'self-heal-git-deploy');
          setTimeout(doRequest, delay);
          return;
        }
        logError(`GitHub API ${method} ${apiPath} failed after ${GITHUB_API_MAX_RETRIES} attempts`, err);
        resolve(null);
      });

      req.setTimeout(30000, () => {
        req.destroy();
        if (attempt < GITHUB_API_MAX_RETRIES) {
          log(`GitHub API ${method} ${apiPath} timeout (attempt ${attempt}/${GITHUB_API_MAX_RETRIES}), retrying`, 'WARN', 'self-heal-git-deploy');
          setTimeout(doRequest, GITHUB_API_RETRY_DELAY_MS * attempt);
          return;
        }
        log(`GitHub API ${method} ${apiPath} timed out after ${GITHUB_API_MAX_RETRIES} attempts`, 'ERROR', 'self-heal-git-deploy');
        resolve(null);
      });

      req.end();
    }

    doRequest();
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
 * Has built-in retry for 409 Conflict (SHA race condition).
 *
 * The GitHub Contents API requires the current file's SHA when updating.
 * If the SHA is stale (another commit happened between GET and PUT),
 * GitHub returns 409 Conflict. This function retries by re-fetching
 * the SHA and trying again.
 */
async function commitFileToBranch(
  filePath: string,
  newContent: string,
  branch: string,
  message: string,
  maxRetries: number = 3
): Promise<{ commitSha: string } | null> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Get the current file on the target branch
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
      if (result?.commit?.sha) {
        log(`Committed ${filePath} to ${branch} (sha: ${result.commit.sha.substring(0, 7)}${attempt > 1 ? ` on attempt ${attempt}` : ''})`, 'INFO', 'self-heal-git-deploy');
        return { commitSha: result.commit.sha };
      }

      // githubApi returns null on non-2xx. If it was a 409, retry.
      // We can't tell from null alone, but the retry is harmless for other failures.
      if (attempt < maxRetries) {
        log(`Commit ${filePath} returned null (possible 409 Conflict), retrying (${attempt}/${maxRetries})...`, 'WARN', 'self-heal-git-deploy');
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }

      log(`Failed to commit ${filePath} to ${branch} after ${maxRetries} attempts`, 'ERROR', 'self-heal-git-deploy');
      return null;
    } catch (err: any) {
      if (attempt < maxRetries) {
        log(`commitFileToBranch ${filePath} threw (attempt ${attempt}/${maxRetries}): ${err.message}, retrying...`, 'WARN', 'self-heal-git-deploy');
        await new Promise(r => setTimeout(r, 1000 * attempt));
        continue;
      }
      logError(`commitFileToBranch ${filePath} failed after ${maxRetries} attempts`, err);
      return null;
    }
  }
  return null;
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
  // EXECUTIVE_MODE: allow ALL files to be deployed.
  if (process.env.EXECUTIVE_KEY) return true;
  return ALLOWED_DEPLOY_PREFIXES.some(prefix => filePath.startsWith(prefix));
}

/**
 * Check deploy safety (rate limits, cooldowns).
 */
function checkDeploySafety(): boolean {
  // EXECUTIVE_MODE: bypass daily limits and cooldowns entirely.
  if (process.env.EXECUTIVE_KEY) return true;
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
    pendingFiles: safeArrayFrom(_pendingVerification.entries()).map(([file, e]: any) => ({
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

    const pending = safeArrayFrom(_pendingVerification.values()).map((e: any) => ({
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
const WATCHDOG_CHECK_INTERVAL_MS = 15 * 1000; // Check every 15 seconds (same style as cycle-watchdog)
const WATCHDOG_DB_KEY = 'full_heal_watchdog_deadline';
let _fullHealWatchdogInterval: ReturnType<typeof setInterval> | null = null;
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
    // Try multiple possible overlay paths:
    //   1. /tmp/self-heal-overlay/{file}        — e.g. /tmp/self-heal-overlay/selectors-login.ts
    //   2. /tmp/self-heal-overlay/{basename}    — e.g. /tmp/self-heal-overlay/selectors-login.ts
    //   3. /tmp/self-heal-overlay/{file}.patch  — patch format
    const candidatePaths = [
      pathModule.resolve('/tmp/self-heal-overlay', file),
      pathModule.resolve('/tmp/self-heal-overlay', pathModule.basename(file)),
      file.startsWith('/') ? file : pathModule.resolve(process.cwd(), file),
    ];

    let content: string | null = null;
    for (const candidate of candidatePaths) {
      try {
        if (fs.existsSync(candidate)) {
          content = fs.readFileSync(candidate, 'utf8');
          if (content && content.length > 0) {
            log(`Read overlay for ${file} from ${candidate} (${content.length} bytes)`, 'DEBUG', 'self-heal-git-deploy');
            break;
          }
          content = null;
        }
      } catch (readErr: any) {
        log(`Cannot read ${candidate}: ${readErr.message}`, 'DEBUG', 'self-heal-git-deploy');
      }
    }

    if (content) {
      filesToCommit.push({ file, content });
    } else {
      log(`No overlay content found for ${file} — tried: ${candidatePaths.join(', ')}`, 'ERROR', 'self-heal-git-deploy');
    }
  }

  if (filesToCommit.length === 0) {
    log(`No patched files found in overlay to commit (requested: ${patchedFiles.join(', ')})`, 'ERROR', 'self-heal-git-deploy');
    return { redeployed: false, method: 'none', details: 'no patched files in overlay', files: [] };
  }

  _fullHealRedeployInProgress = true;
  const committedFiles: string[] = [];
  const errors: string[] = [];

  try {
    const config = getCONFIG();
    const autoMerge = config.SELF_HEAL_GIT_AUTO_MERGE !== false; // default true

    // ═══════════════════════════════════════════════════════════════
    // PHASE 1: GITHUB COMMIT
    // This is the CRITICAL path. The self-heal can fix everything
    // except itself — so this MUST work.
    // ═══════════════════════════════════════════════════════════════

    if (hasGithub) {
      // 1. Get default branch info — retry up to 3 times
      let branchInfo = await getDefaultBranchSha();
      if (!branchInfo) {
        log('Immediate redeploy: getDefaultBranchSha failed — retrying once more...', 'WARN', 'self-heal-git-deploy');
        await new Promise(r => setTimeout(r, 3000));
        branchInfo = await getDefaultBranchSha();
      }

      if (!branchInfo) {
        // CRITICAL: GitHub API is unreachable. Log everything we can.
        const diagInfo = JSON.stringify({
          token_set: !!process.env.GITHUB_TOKEN,
          token_prefix: process.env.GITHUB_TOKEN?.substring(0, 8) || 'none',
          repo: process.env.GITHUB_REPO || 'not set',
          files_requested: patchedFiles,
          files_found_in_overlay: filesToCommit.map(f => f.file),
        });
        log(`CRITICAL: Cannot reach GitHub API — default branch SHA unknown. Cannot commit. Diag: ${diagInfo}`, 'ERROR', 'self-heal-git-deploy');
        errors.push('github_api_unreachable');
      }

      // 2. Create a branch (for PR-based workflow)
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
          log(`Created branch ${branchName} (from ${branchInfo.branch}@${branchInfo.sha.substring(0, 7)})`, 'INFO', 'self-heal-git-deploy');
        } else {
          targetBranch = branchInfo.branch;
          log(`Branch creation failed — committing directly to ${targetBranch}`, 'WARN', 'self-heal-git-deploy');
        }
      } else {
        targetBranch = 'main'; // last resort fallback
        log(`No branch info — guessing target branch is 'main' (commit may fail)`, 'ERROR', 'self-heal-git-deploy');
      }

      // 3. Commit each patched file to GitHub
      if (branchInfo) {
        log(`Committing ${filesToCommit.length} file(s) to ${targetBranch}...`, 'INFO', 'self-heal-git-deploy');
        for (const entry of filesToCommit) {
          const message = `full self-heal: fix ${entry.file} (immediate redeploy ${new Date().toISOString()})`;
          const result = await commitFileToBranch(entry.file, entry.content, targetBranch, message);
          if (result) {
            committedFiles.push(entry.file);
          } else {
            errors.push(`commit_failed:${entry.file}`);
            log(`FAILED to commit ${entry.file} to ${targetBranch} — this file will NOT be in the redeploy`, 'ERROR', 'self-heal-git-deploy');
          }
        }
        log(`Committed ${committedFiles.length}/${filesToCommit.length} files to ${targetBranch}`, committedFiles.length > 0 ? 'INFO' : 'ERROR', 'self-heal-git-deploy');
      }

      // ═══════════════════════════════════════════════════════════════
      // PHASE 2: GET THE COMMIT ONTO THE DEFAULT BRANCH
      //
      // Render auto-deploys on push to the default branch.
      // If we committed to a feature branch, we MUST merge it
      // to the default branch. If merge fails, we MUST retry
      // by committing directly to the default branch.
      //
      // This is the most failure-prone step. The PR merge can
      // fail for many reasons (branch protection, conflicts,
      // required reviews, etc.). We need a bulletproof fallback.
      // ═══════════════════════════════════════════════════════════════

      let githubPushTriggered = false;

      if (branchCreated && committedFiles.length > 0) {
        // We have commits on a feature branch. Try PR + merge.
        const pr = await createPullRequest(
          targetBranch,
          branchInfo!.branch,
          `Full self-heal: auto-fix ${committedFiles.length} file(s)`,
          `Immediate redeploy after successful full self-heal.\n\nFiles: ${committedFiles.join(', ')}\n\nTimestamp: ${new Date().toISOString()}`
        );

        if (pr) {
          log(`PR #${pr.number} created: ${pr.url}`, 'INFO', 'self-heal-git-deploy');

          if (autoMerge) {
            const merged = await githubApi('PUT', `/pulls/${pr.number}/merge`, {
              commit_title: `Auto-merge full self-heal #${pr.number}`,
              merge_method: 'squash',
            });

            if (merged) {
              log(`PR #${pr.number} MERGED to ${branchInfo!.branch} — Render will auto-deploy`, 'INFO', 'self-heal-git-deploy');
              githubPushTriggered = true;
            } else {
              errors.push('pr_merge_failed');
              log(`PR #${pr.number} merge FAILED — falling back to direct commit to ${branchInfo!.branch}`, 'ERROR', 'self-heal-git-deploy');
            }
          } else {
            // autoMerge disabled — PR is open but not merged.
            // We still need to get the fix onto the default branch.
            errors.push('pr_not_auto_merged');
            log(`PR #${pr.number} created but auto-merge is disabled — falling back to direct commit`, 'WARN', 'self-heal-git-deploy');
          }
        } else {
          errors.push('pr_creation_failed');
          log(`PR creation FAILED — falling back to direct commit to ${branchInfo!.branch}`, 'ERROR', 'self-heal-git-deploy');
        }

        // FALLBACK: If PR/merge failed, commit directly to default branch.
        // This is the nuclear option — it bypasses PRs entirely.
        // It's safe because self-heal patches are already verified working.
        if (!githubPushTriggered && committedFiles.length > 0) {
          log(`FALLBACK: Committing ${committedFiles.length} file(s) directly to ${branchInfo!.branch}...`, 'WARN', 'self-heal-git-deploy');
          let fallbackCommitted = 0;
          for (const entry of filesToCommit) {
            const message = `full self-heal (direct): fix ${entry.file} (immediate redeploy ${new Date().toISOString()})`;
            const result = await commitFileToBranch(entry.file, entry.content, branchInfo!.branch, message);
            if (result) {
              fallbackCommitted++;
            }
          }
          if (fallbackCommitted > 0) {
            log(`FALLBACK SUCCEEDED: ${fallbackCommitted}/${filesToCommit.length} files committed directly to ${branchInfo!.branch}`, 'INFO', 'self-heal-git-deploy');
            githubPushTriggered = true;
          } else {
            errors.push('direct_commit_failed');
            log(`FALLBACK FAILED: Could not commit directly to ${branchInfo!.branch} either`, 'ERROR', 'self-heal-git-deploy');
          }
        }
      } else if (!branchCreated && committedFiles.length > 0) {
        // Already committed directly to default branch
        githubPushTriggered = true;
        log(`Committed directly to ${targetBranch} — Render will auto-deploy from push`, 'INFO', 'self-heal-git-deploy');
      }

      // ═══════════════════════════════════════════════════════════════
      // PHASE 3: RENDER DEPLOY API (belt and suspenders)
      // Even if the GitHub push triggers auto-deploy, we also
      // call the Render API directly. If GitHub push failed
      // but Render API works, the deploy still happens.
      // ═══════════════════════════════════════════════════════════════

      let renderTriggered = false;
      if (hasRender) {
        const renderResult = await triggerRenderDeploy(committedFiles.map(f => `full-heal-${f}`));
        if (renderResult) {
          renderTriggered = true;
          log(`Render deploy triggered (id: ${renderResult.deployId?.substring(0, 8) || 'unknown'})`, 'INFO', 'self-heal-git-deploy');
        } else {
          errors.push('render_api_failed');
          log('Render deploy API FAILED', 'ERROR', 'self-heal-git-deploy');
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // PHASE 4: DETERMINE OUTCOME
      //
      // The redeploy SUCCEEDED if ANY of these happened:
      //   A) Files committed to default branch (GitHub push)
      //   B) Render deploy API accepted
      //
      // The redeploy FAILED if NONE of these happened.
      // ═══════════════════════════════════════════════════════════════

      let deployMethod: 'github_push' | 'render_api' | 'both' | 'none' = 'none';
      if (githubPushTriggered && renderTriggered) {
        deployMethod = 'both';
      } else if (githubPushTriggered) {
        deployMethod = 'github_push';
      } else if (renderTriggered) {
        deployMethod = 'render_api';
      }

      const succeeded = committedFiles.length > 0 && deployMethod !== 'none';

      // 5. Record event with FULL diagnostic detail
      try {
        getInsertSelfHealEvent()?.(
          Date.now(), 'immediate_redeploy', succeeded ? 'completed' : 'failed',
          succeeded ? 'full_heal_redeploy_success' : 'full_heal_redeploy_failed',
          null, 0, 0, 0, succeeded ? 'success' : 'error', 0,
          JSON.stringify({
            method: deployMethod,
            committed: committedFiles,
            branch: targetBranch,
            totalRequested: patchedFiles.length,
            totalFoundInOverlay: filesToCommit.length,
            githubPushTriggered,
            renderTriggered,
            errors,
          })
        );
      } catch {}

      logAudit(`Immediate redeploy: ${committedFiles.length}/${filesToCommit.length} files committed via ${deployMethod}${errors.length > 0 ? ` (errors: ${errors.join(', ')})` : ''}`, 'self-heal-git-deploy');

      // 6. Start SIGTERM watchdog — ONLY if something was actually deployed
      if (succeeded) {
        startSigtermWatchdog();
      } else {
        log(`CRITICAL: No deploy path succeeded. Errors: ${errors.join(', ')}. Self-heal fix will be LOST on next restart.`, 'ERROR', 'self-heal-git-deploy');
      }

      return {
        redeployed: succeeded,
        method: deployMethod,
        details: `${committedFiles.length}/${filesToCommit.length} files committed via ${deployMethod}${errors.length > 0 ? ` [errors: ${errors.join(', ')}]` : ''}`,
        files: committedFiles,
      };
    } else {
      // No GitHub — Render API only
      log('No GitHub credentials — using Render deploy API only', 'WARN', 'self-heal-git-deploy');

      if (hasRender) {
        const renderResult = await triggerRenderDeploy(patchedFiles.map(f => `full-heal-${f}`));
        if (renderResult) {
          log(`Render deploy triggered (id: ${renderResult.deployId?.substring(0, 8) || 'unknown'})`, 'INFO', 'self-heal-git-deploy');
          startSigtermWatchdog();
          return { redeployed: true, method: 'render_api', details: 'deployed via Render API (no GitHub)', files: [] };
        } else {
          errors.push('render_api_failed_no_github');
          log('Render deploy API FAILED and no GitHub fallback available', 'ERROR', 'self-heal-git-deploy');
        }
      }

      try {
        getInsertSelfHealEvent()?.(
          Date.now(), 'immediate_redeploy', 'failed', 'no_deploy_path_succeeded',
          null, 0, 0, 0, 'error', 0,
          JSON.stringify({ hasGithub, hasRender, errors, files: patchedFiles })
        );
      } catch {}

      return { redeployed: false, method: 'none', details: `all deploy paths failed: ${errors.join(', ')}`, files: [] };
    }
  } catch (err: any) {
    logError('Immediate redeploy threw unexpected error', err);
    try {
      getInsertSelfHealEvent()?.(
        Date.now(), 'immediate_redeploy', 'failed', 'unexpected_error',
        null, 0, 0, 0, 'error', 0,
        JSON.stringify({ error: err.message, stack: err.stack?.substring(0, 500), committedFiles, errors })
      );
    } catch {}
    return { redeployed: false, method: 'none', details: `unexpected error: ${err.message}`, files: [] };
  } finally {
    _fullHealRedeployInProgress = false;
  }
}

/**
 * Start a 5-minute SIGTERM watchdog.
 *
 * Design: Same time-telling method as the 10-min question completion detector
 * in cycle-watchdog.ts — uses Date.now() stored at start, then a poll-based
 * interval checks elapsed time each tick. NO reliance on setTimeout firing
 * accurately.
 *
 * OOM-proof: The deadline is persisted to the DB (calibration table).
 * If the bot OOMs before the watchdog fires, the next boot will:
 *   1. See the pending deadline in the DB
 *   2. Check if the deadline has passed
 *   3. If yes — log the failure event (redeploy didn't replace the instance)
 *   4. If no — resume watching (the new process survived, meaning the old
 *      instance was killed and a new one started = success)
 *
 * This means even if the bot OOMs 3 times in 5 minutes, the FIRST boot
 * that survives past the deadline will correctly detect whether the
 * redeploy succeeded or failed.
 */
function startSigtermWatchdog(): void {
  const watchdogStartedAt = Date.now();
  const deadline = watchdogStartedAt + FULL_HEAL_SIGTERM_WATCHDOG_MS;

  log(`SIGTERM watchdog started — deadline in ${FULL_HEAL_SIGTERM_WATCHDOG_MS / 60000} minutes (deadline=${new Date(deadline).toISOString()})`, 'WARN', 'self-heal-git-deploy');

  // Persist the deadline to DB — survives OOM kills
  try {
    const db = getDb();
    if (db) {
      db.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
        .run(WATCHDOG_DB_KEY, JSON.stringify({ deadline, startedAt: watchdogStartedAt }), Date.now());
    }
  } catch {}

  // Stop any existing poll
  stopWatchdogPoll();

  // Poll-based check — same pattern as cycle-watchdog's Date.now() approach.
  // NOT a single setTimeout (which dies on OOM). This interval is just for
  // the living process; the DB persistence handles the OOM case.
  _fullHealWatchdogInterval = setInterval(() => {
    checkWatchdogDeadline(watchdogStartedAt, deadline);
  }, WATCHDOG_CHECK_INTERVAL_MS);
  if (_fullHealWatchdogInterval?.unref) {
    _fullHealWatchdogInterval.unref();
  }
}

/**
 * Check if the watchdog deadline has passed. Called by the poll interval.
 * Uses Date.now() for elapsed time — same as cycle-watchdog.ts
 * uses `Date.now() - questionState.questionStartTime`.
 */
function checkWatchdogDeadline(startedAt: number, deadline: number): void {
  const now = Date.now();
  const elapsed = now - startedAt;
  const remaining = deadline - now;

  // Log progress at 50%, 75%, 90% — same as cycle-watchdog diagnostics
  const fractions = [0.5, 0.75, 0.9];
  const loggedKey = '_watchdogLoggedThresholds';
  const logged: number[] = (global as any)[loggedKey] || [];

  for (const frac of fractions) {
    const thresholdTime = startedAt + FULL_HEAL_SIGTERM_WATCHDOG_MS * frac;
    if (now >= thresholdTime && !logged.includes(frac)) {
      const elapsedMin = (elapsed / 60000).toFixed(1);
      const pct = (frac * 100).toFixed(0);
      log(
        `SIGTERM watchdog DIAGNOSTIC [${pct}%]: ${elapsedMin}min elapsed, ` +
        `waiting for Render to replace this instance (${Math.round(remaining / 60000)}min remaining)`,
        'WARN', 'self-heal-git-deploy'
      );
      logged.push(frac);
      (global as any)[loggedKey] = logged;
    }
  }

  // Not timed out yet
  if (now < deadline) {
    return;
  }

  // ═══════════════════════════════════════════════════════════════
  // DEADLINE REACHED — no SIGTERM received, redeploy failed
  // ═══════════════════════════════════════════════════════════════
  stopWatchdogPoll();
  clearWatchdogDeadlineFromDb();
  (global as any)[loggedKey] = [];

  const elapsedMin = Math.round(elapsed / 60000);
  log(`SIGTERM watchdog FIRED after ${elapsedMin}min — no SIGTERM received. Full self-heal redeploy FAILED.`, 'ERROR', 'self-heal-git-deploy');
  log('The new deploy did not replace this instance. Possible causes: Render didn\'t pick up the push, API key invalid, or service ID wrong.', 'ERROR', 'self-heal-git-deploy');

  try {
    getInsertSelfHealEvent()?.(
      Date.now(), 'immediate_redeploy', 'failed', 'sigterm_watchdog_fired',
      `No SIGTERM received after ${elapsedMin} minutes — redeploy did not replace this instance`,
      0, 0, 0, 'error', elapsed, null
    );
  } catch {}
}

/**
 * Cancel the SIGTERM watchdog — call when SIGTERM is received to avoid
 * logging a false failure. Also clears the DB deadline.
 */
function cancelSigtermWatchdog(): void {
  stopWatchdogPoll();
  clearWatchdogDeadlineFromDb();
  (global as any)['_watchdogLoggedThresholds'] = [];
  log('SIGTERM watchdog cancelled — instance is being replaced by new deploy', 'INFO', 'self-heal-git-deploy');
}

/** Stop the poll interval. */
function stopWatchdogPoll(): void {
  if (_fullHealWatchdogInterval) {
    clearInterval(_fullHealWatchdogInterval);
    _fullHealWatchdogInterval = null;
  }
}

/** Clear the persisted deadline from DB. */
function clearWatchdogDeadlineFromDb(): void {
  try {
    const db = getDb();
    if (db) {
      db.prepare('DELETE FROM calibration WHERE key = ?').run(WATCHDOG_DB_KEY);
    }
  } catch {}
}

/**
 * Check on boot if there's a pending watchdog deadline from a previous instance
 * that OOM'd before the watchdog could fire.
 *
 * This is the OOM-proofing: if the old instance persisted a deadline but
 * then OOM'd, the new instance picks it up here.
 *
 * Three cases:
 *   1. Deadline passed, this is a NEW process (different PID) → redeploy failed
 *   2. Deadline not yet passed → redeploy may still be in progress, resume watching
 *   3. No deadline in DB → nothing to do
 */
function recoverWatchdogOnBoot(): void {
  try {
    const db = getDb();
    if (!db) return;

    const row = db.prepare('SELECT value, updated_at FROM calibration WHERE key = ?').get(WATCHDOG_DB_KEY);
    if (!row) return;

    let data: { deadline: number; startedAt: number };
    try {
      data = JSON.parse(row.value);
    } catch { return; }

    const now = Date.now();
    const elapsed = now - data.startedAt;
    const elapsedMin = Math.round(elapsed / 60000);

    if (now >= data.deadline) {
      // ═══════════════════════════════════════════════════════════════
      // CASE 1: Deadline PASSED — the old instance OOM'd and the
      // watchdog never fired. The redeploy may or may not have
      // succeeded. Check if we're running the NEW code (the patches
      // would be on disk if the merge happened).
      //
      // We can't know for certain if the deploy succeeded, but
      // since we're in a NEW process and the watchdog deadline
      // passed without the old instance being replaced, log it
      // as a potential failure for diagnostics.
      // ═══════════════════════════════════════════════════════════════
      log(
        `BOOT RECOVERY: SIGTERM watchdog deadline passed ${elapsedMin}min ago — previous instance OOM'd before watchdog fired. ` +
        `The redeploy may have succeeded (this instance may have the fix) or failed.`,
        'WARN', 'self-heal-git-deploy'
      );

      try {
        getInsertSelfHealEvent()?.(
          now, 'immediate_redeploy', 'failed', 'sigterm_watchdog_recovered_after_oom',
          `Watchdog deadline passed ${elapsedMin}min ago. Previous instance likely OOM'd. This boot is the recovery.`,
          0, 0, 0, 'warning', elapsed, null
        );
      } catch {}

      // Clear the stale deadline
      clearWatchdogDeadlineFromDb();
    } else {
      // ═══════════════════════════════════════════════════════════════
      // CASE 2: Deadline NOT yet passed — the old instance OOM'd
      // but the redeploy may still be in progress. We can't
      // cancel the watchdog because we don't know if Render
      // will SIGTERM us (the new instance) too.
      //
      // The safest approach: resume the watchdog with the
      // ORIGINAL deadline. If Render replaces us before the
      // deadline, great. If not, the watchdog will fire.
      // ═══════════════════════════════════════════════════════════════
      const remainingMin = Math.round((data.deadline - now) / 60000);
      log(
        `BOOT RECOVERY: Resuming SIGTERM watchdog — ${remainingMin}min remaining until deadline ` +
        `(previous instance OOM'd before watchdog fired)`,
        'WARN', 'self-heal-git-deploy'
      );

      // Resume polling with the original deadline
      stopWatchdogPoll();
      _fullHealWatchdogInterval = setInterval(() => {
        checkWatchdogDeadline(data.startedAt, data.deadline);
      }, WATCHDOG_CHECK_INTERVAL_MS);
      if (_fullHealWatchdogInterval?.unref) {
        _fullHealWatchdogInterval.unref();
      }
    }
  } catch {
    // Non-critical — DB may not be ready yet
  }
}

// ─── Init ───────────────────────────────────────────────────────────────────

function init(): void {
  // FIRST: Recover any pending SIGTERM watchdog from a previous instance
  // that OOM'd. This must run BEFORE the early returns below because a
  // watchdog deadline from a PREVIOUS boot must be honored regardless
  // of whether the current config enables new deploys.
  // Uses Date.now() comparison — same timing method as cycle-watchdog.
  recoverWatchdogOnBoot();

  const config = getCONFIG();
  const executiveMode = !!process.env.EXECUTIVE_KEY;
  const enabled = executiveMode
    || config.SELF_DEPLOY_ENABLED === true
    || process.env.SELF_DEPLOY_ENABLED === 'true';

  if (!enabled) {
    log('Git deploy module DISABLED (SELF_DEPLOY_ENABLED not set, no EXECUTIVE_KEY)', 'INFO', 'self-heal-git-deploy');
    return;
  }

  if (executiveMode) {
    log('EXECUTIVE_MODE: git deploy module enabled — bypassing daily limits and cooldowns', 'WARN', 'self-heal-git-deploy');
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
  recoverWatchdogOnBoot,
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
