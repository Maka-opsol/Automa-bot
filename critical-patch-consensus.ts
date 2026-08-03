'use strict';

/**
 * critical-patch-consensus.js
 *
 * Allows the bot to modify CRITICAL files (config.js, database.js, browser.js,
 * state-machine.js, agent.js, etc.) ONLY when every single AI provider in the
 * system unanimously agrees the change is necessary.
 *
 * Safety layers (all must pass):
 *   1. Unanimous consensus  – every provider must independently produce the
 *      same file + patch (fuzzy-matched).
 *   2. Multi-round validation – the consensus is verified in a second round
 *      where providers review the proposed patch.
 *   3. Mandatory cooling-off  – a configurable delay (default 5 min) before
 *      the patch is applied, during which any provider can "veto" by failing
 *      a final sanity check.
 *   4. Immutable backup     – a timestamped, read-only backup is created and
 *      its hash is stored for rollback.
 *   5. Sandbox execution    – the patch is tested in an isolated child_process
 *      before touching the real file.
 *   6. Full audit trail     – every step is recorded in the `critical_consensus`
 *      table and all alert channels are notified.
 *   7. Auto-rollback        – if the patched file fails to load within a
 *      verification window, the backup is restored automatically.
 *
 * Usage:
 *   const { requestCriticalPatch } = require('./critical-patch-consensus');
 *   const result = await requestCriticalPatch(investigationContext);
 *   // result.applied === true | false
 */

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const crypto = require('crypto');
const { fork } = require('child_process');

const CONFIG = require('./get-config');
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }
function getDb() { return _deps.database?.db; }
function getInsertPatch() { return _deps.database?.insertPatch; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }
function getGetAvailableProviders() { return _deps.providerRegistry?.getAvailableProviders || (() => []); }
function getCallChatCompletion() { return _deps.providersBase?.callChatCompletion; }
function getRetryWithBackoff() { return _deps.providersBase?.retryWithBackoff; }
function getExecutePatchInSandbox() { return _deps.sandboxExecutor?.executePatchInSandbox || require('./sandbox-executor').executePatchInSandbox; }

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Files that are ordinarily protected by self-heal but CAN be touched here. */
const CRITICAL_FILES = new Set([
  'agent.ts',
  'config.ts',
  'logger.ts',
  'state-machine.ts',
  'database.ts',
  'browser.ts',
  'cache.ts',
  'error-handler.ts',
  'self-heal.ts',
  'providers-base.ts',
  'providers-tribunal.ts',
  'providers-prompts.ts',
  'providers-vision-pipeline.ts',
  'providers-config-loader.ts',
  'providers-registry.ts',
  'providers.ts',
  'cycle-orchestrator.ts',
  'cycle-cycle-manager.ts',
  'cycle-action-executor.ts',
  'auth-auth-manager.ts',
]);

const SOURCE_DIR = PROJECT_ROOT;

/** Minimum number of providers required to even attempt consensus. */
const MIN_PROVIDER_COUNT = 3;

/** Delay (ms) between consensus confirmation and actual application. */
const COOLING_OFF_MS = CONFIG.CRITICAL_CONSENSUS_COOLING_OFF_MS || (5 * 60 * 1000);

/** Maximum attempts at re-running consensus if the first round is inconclusive. */
const MAX_CONSENSUS_ROUNDS = 2;

/** Timeout (ms) for the sandbox verification child process. */
const SANDBOX_TIMEOUT_MS = 15_000;

/** Window (ms) after applying a patch during which auto-rollback is active. */
const VERIFICATION_WINDOW_MS = CONFIG.CRITICAL_CONSENSUS_VERIFY_WINDOW_MS || (10 * 60 * 1000);

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

function buildAnalysisPrompt(context: any) { 
  return `
You are part of a safety-critical code review panel for an autonomous bot (MathU Bot).
Your task is to analyse a problem and decide whether a CRITICAL file must be modified.

RULES:
- You MUST only recommend changes to critical files if there is NO other alternative.
- You MUST be conservative — when in doubt, say "no change needed".
- If you recommend a change, you MUST provide the EXACT file path (relative to project root) and the COMPLETE replacement content (not a diff).

CONTEXT:
${context.description}

RECENT ERRORS (last 24h):
${context.recentErrors || 'None available'}

CURRENT FILE CONTENT (${context.targetFile}):
${context.currentFileContent || '(file not readable)'}

RECENT PATCHES TO THIS FILE:
${context.recentPatches || 'None'}

Respond ONLY with valid JSON:
{
  "change_needed": true | false,
  "confidence": 0.0-1.0,
  "reasoning": "explanation",
  "file": "relative/path/to/file.js",
  "new_content": "complete new file content if change_needed is true, otherwise null",
  "risk_assessment": "low | medium | high | critical",
  "reversible": true | false,
  "alternative_approaches": ["approach 1 that doesn't touch critical files"]
}
`.trim();
}

function buildVerificationPrompt(patch: any, providerAnalyses: any) { 
  return `
You are the FINAL safety gate in a critical-patch consensus system.

A unanimous panel of AI providers has proposed the following patch:

FILE: ${patch.file}
RISK: ${patch.riskAssessment}

SUMMARY OF PROVIDER REASONING:
${providerAnalyses.map((a: any, i: any) => `Provider ${i + 1} (${a.provider}): ${a.reasoning}`).join('\n')}

PROPOSED NEW CONTENT (first 2000 chars):
${(patch.newContent || '').substring(0, 2000)}

YOUR TASK:
1. Review the patch for correctness, safety, and completeness.
2. Check that it does NOT introduce: infinite loops, memory leaks, security vulnerabilities, broken imports, or logic errors.
3. Verify the patch addresses the root cause described in the reasoning.

Respond ONLY with valid JSON:
{
  "approved": true | false,
  "confidence": 0.0-1.0,
  "concerns": ["any concerns or issues found"],
  "suggested_fixes": ["if not approved, what should change"]
}
`.trim();
}

function buildVetoPrompt(patch: any) { 
  return `
FINAL VETO CHECK for critical file patch.

FILE: ${patch.file}
APPROVED BY: ${patch.approvalCount} providers

Read the proposed content carefully. If you find ANY reason this patch should NOT be applied —
including but not limited to: syntax errors, broken require() paths, removed security checks,
deleted functions that other modules depend on, or logic that could cause infinite loops —
you MUST veto it.

PROPOSED CONTENT:
${(patch.newContent || '').substring(0, 3000)}

Respond ONLY with valid JSON:
{
  "veto": true | false,
  "reason": "if vetoed, explain why"
}
`.trim();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normalise two content strings for fuzzy comparison.
 * Strips trailing whitespace, normalises line endings, and trims.
 */
function normaliseContent(content: any) { 
  if (!content) return '';
  return content
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line: any) => line.trimEnd())
    .join('\n')
    .trim();
}

/**
 * Compute a SHA-256 hash of the given string.
 */
function hashContent(content: any) { 
  return crypto.createHash('sha256').update(content || '').digest('hex');
}

/**
 * Fuzzy content similarity: ratio of matching lines (order-independent).
 * Returns a number between 0 and 1.
 */
function contentSimilarity(a: any, b: any) { 
  const linesA = new Set(normaliseContent(a).split('\n').filter((l: any) => l.length > 0));
  const linesB = new Set(normaliseContent(b).split('\n').filter((l: any) => l.length > 0));
  if (linesA.size === 0 && linesB.size === 0) return 1;
  const intersection = [...linesA].filter(l => linesB.has(l));
  return intersection.length / Math.max(linesA.size, linesB.size);
}

/**
 * Parse JSON from an LLM response, tolerating markdown fences.
 */
function parseJSON(raw: any) { 
  let cleaned = raw.trim();
  if (cleaned.startsWith('```json')) cleaned = cleaned.replace(/^```json\s*/, '').replace(/\s*```$/, '');
  else if (cleaned.startsWith('```')) cleaned = cleaned.replace(/^```\s*/, '').replace(/\s*```$/, '');
  cleaned = cleaned.trim().replace(/,\s*}/g, '}').replace(/,\s*\]/g, ']');
  const match = cleaned.match(/\{[\s\S]*\}/);
  return JSON.parse(match ? match[0] : cleaned);
}

/**
 * Create an immutable, timestamped backup and return its path.
 */
function createImmutableBackup(filePath: any) { 
  const timestamp = Date.now();
  const backupDir = path.join(SOURCE_DIR, '.critical-backups');
  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  }
  const relativeFile = path.relative(SOURCE_DIR, filePath);
  const backupPath = path.join(backupDir, `${relativeFile.replace(/\//g, '_')}.${timestamp}.bak`);
  const backupDirOfFile = path.dirname(backupPath);
  if (!fs.existsSync(backupDirOfFile)) {
    fs.mkdirSync(backupDirOfFile, { recursive: true, mode: 0o700 });
  }
  fs.copyFileSync(filePath, backupPath);
  fs.chmodSync(backupPath, 0o400); // read-only
  log(`🔒 Created immutable backup: ${backupPath}`, 'INFO', 'critical-consensus');
  return backupPath;
}

/**
 * Verify a file can be loaded without errors inside a child process.
 * Writes to a temporary location first, validates, then copies to real location only on success.
 * @param {string} filePath - Target file path
 * @param {string} consensusContent - Content to verify
 * @returns {Promise<boolean>} true if verification passed and file was written
 */
async function verifyFileLoad(filePath: any, consensusContent: any) { 
    try {
      // Write to a temporary location first to avoid corrupting the real file
      const ext = path.extname(filePath) || '.js';
      const tmpPath = `${filePath}.tmp-verify-${Date.now()}${ext}`;
      fs.writeFileSync(tmpPath, consensusContent, 'utf8');

      const settled = await new Promise((resolve, _reject) => {
        const child = fork(tmpPath, [], {
          timeout: 15000,
          cwd: SOURCE_DIR,
          stdio: 'pipe',
          env: { ...Object.fromEntries(
            Object.entries(process.env).filter(([k]) =>
              ['PATH', 'NODE_ENV', 'HOME', 'SHADOW_MODE'].includes(k)
            )
          ), NODE_ENV: 'verify', SHADOW_MODE: 'true' }
        });

        child.on('message', (msg: any) => {
          if (msg && typeof msg === 'object' && 'passed' in msg) {
            resolve({ passed: msg.passed, error: msg.error || null });
          }
        });

        child.on('exit', (code: any) => {
          resolve({ passed: code === 0, error: code !== 0 ? `Process exited with code ${code}` : null });
        });

        child.on('error', (err: any) => {
          resolve({ passed: false, error: err.message });
        });

        setTimeout(() => {
          try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
          resolve({ passed: false, error: 'Verify timed out' });
        }, 20000);
      });

      // C7 FIX: Atomic write — the temp file already exists from verification above;
      // rename it into place instead of re-writing the real file directly.
      if ((settled as any).passed) {
        fs.renameSync(tmpPath, filePath);
        log(`File load verified, atomically replaced: ${filePath}`, 'INFO', 'critical-consensus');
      } else {
        log(`File load verification FAILED for ${filePath}, keeping original`, 'WARN', 'critical-consensus');
      }

      // Only clean up temp file on failure (on success, rename already moved it)
      if (!(settled as any).passed) {
        try { fs.unlinkSync(tmpPath); } catch (e: any) { /* ignore */ }
      }

      return (settled as any).passed;
    } catch (err: any) {
      logError('verifyFileLoad failed', err, { module: 'critical-consensus' });
      return false;
    }
}

/**
 * Record an entry in the critical_consensus audit table.
 */
function recordConsensusEvent(data: any) { 
  try {
    getDb()?.prepare(`
      INSERT INTO critical_consensus
        (timestamp, phase, target_file, provider, approved, confidence, reasoning, patch_hash, details)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      Date.now(),
      data.phase,
      data.targetFile || null,
      data.provider || null,
      data.approved ? 1 : 0,
      data.confidence || 0,
      data.reasoning || null,
      data.patchHash || null,
      JSON.stringify(data.details || {})
    );
  } catch (err: any) {
    logError('Failed to record consensus event', err);
  }
}

/**
 * Auto-rollback monitor: after a patch is applied, watch for failures
 * and restore the backup if the file can't be loaded.
 */
function startRollbackMonitor(filePath: any, backupPath: any, originalHash: any) { 
  const startTime = Date.now();
  const interval = setInterval(async () => {
    if (Date.now() - startTime > VERIFICATION_WINDOW_MS) {
      clearInterval(interval);
      log(`✅ Verification window passed for ${filePath} — patch is stable.`, 'INFO', 'critical-consensus');
      recordConsensusEvent({
        phase: 'verification_complete',
        targetFile: path.relative(SOURCE_DIR, filePath),
        approved: true,
        confidence: 1,
        reasoning: 'Patch survived verification window',
        patchHash: originalHash,
        details: { duration_ms: VERIFICATION_WINDOW_MS },
      });
      return;
    }
    try {
      // Simple require-check for rollback monitor (file is already written at this point)
      let loadsOk = false;
      let loadError = 'unknown';
      try {
        // For TypeScript files, require.resolve/require will fail at runtime.
        // Use fs.existsSync + syntax validation instead.
        if (filePath.endsWith('.ts')) {
          if (!fs.existsSync(filePath)) {
            loadError = 'File does not exist';
          } else {
            // C6 FIX: Use tsc --noEmit for actual TypeScript syntax validation
            // instead of the dummy vm.Script placeholder that always passed.
            try {
              const { execFile } = require('child_process');
              const result = await new Promise<{ok: boolean; err: string | null}>((resolve) => {
                const child = execFile(
                  'npx', ['tsc', '--noEmit', '--strict', '--allowJs', '--skipLibCheck', filePath],
                  { timeout: 30000, cwd: SOURCE_DIR },
                  (error: any, _stdout: any, stderr: any) => {
                    if (error) {
                      resolve({ ok: false, err: stderr || error.message });
                    } else {
                      resolve({ ok: true, err: null });
                    }
                  }
                );
                child.on('error', (execErr: any) => {
                  resolve({ ok: false, err: 'Failed to spawn tsc: ' + execErr.message });
                });
              });
              if (result.ok) {
                loadsOk = true;
              } else {
                loadError = 'tsc validation: ' + (result.err || 'unknown error');
              }
            } catch (tscErr: any) {
              loadError = 'tsc exception: ' + tscErr.message;
            }
          }
        } else {
          delete require.cache[require.resolve(filePath)];
          require(filePath);
          loadsOk = true;
        }
      } catch (reqErr: any) {
        loadError = reqErr.message;
      }
      if (!loadsOk) {
        clearInterval(interval);
        log(`🚨 PATCH VERIFICATION FAILED for ${filePath}: ${loadError} — rolling back!`, 'ERROR', 'critical-consensus');
        fs.copyFileSync(backupPath, filePath);
        recordConsensusEvent({
          phase: 'auto_rollback',
          targetFile: path.relative(SOURCE_DIR, filePath),
          approved: false,
          confidence: 0,
          reasoning: `Verification failed: ${loadError}`,
          patchHash: originalHash,
          details: { rollbackBackup: backupPath, error: loadError },
        });
        try { getSendAlert()(`CRITICAL PATCH ROLLED BACK: ${path.relative(SOURCE_DIR, filePath)} — ${loadError}`, 1); } catch (e: any) {}
      }
    } catch (err: any) {
      logError('Rollback monitor error', err);
    }
  }, 30_000); // check every 30 seconds

  // Don't prevent process exit
  if (interval.unref) interval.unref();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

let isConsensusRunning = false;

/**
 * Request a critical file patch through unanimous AI consensus.
 *
 * @param {Object} context
 * @param {string} context.description  – What problem are we trying to solve?
 * @param {string} context.targetFile   – Relative path to the critical file.
 * @param {string} [context.recentErrors] – Recent error logs.
 * @param {string} [context.screenshot] – Base64 screenshot for context.
 * @returns {Promise<{applied: boolean, reason: string, details: Object}>}
 */
async function requestCriticalPatch(context: any) { 
  if (isConsensusRunning) {
    return { applied: false, reason: 'Consensus process already running', details: {} };
  }

  const targetFile = context.targetFile;
  if (!targetFile || !CRITICAL_FILES.has(targetFile)) {
    return { applied: false, reason: `File not in critical files list: ${targetFile}`, details: {} };
  }

  const fullPath = path.join(SOURCE_DIR, targetFile);
  if (!fs.existsSync(fullPath)) {
    return { applied: false, reason: `File does not exist: ${fullPath}`, details: {} };
  }

  // Read current file content
  let currentFileContent;
  try {
    currentFileContent = fs.readFileSync(fullPath, 'utf-8');
  } catch (err: any) {
    return { applied: false, reason: `Cannot read file: ${err.message}`, details: {} };
  }

  // Gather recent patches to this file
  let recentPatches = 'None';
  try {
    const patches = getDb()?.prepare(
      `SELECT description, patch, status, applied_at FROM patch_history WHERE file = ? ORDER BY timestamp DESC LIMIT 5`
    ).all(targetFile);
    if (patches.length > 0) {
      recentPatches = patches.map((p: any) => `- [${p.status}] ${p.description} (at ${new Date(p.applied_at).toISOString()})`).join('\n');
    }
  } catch (_e: any) { /* non-critical, suppressed */ }

  const enrichedContext = {
    ...context,
    currentFileContent,
    recentPatches,
  };

  isConsensusRunning = true;
  const consensusId = crypto.randomBytes(8).toString('hex');
  log(`🔒 CRITICAL CONSENSUS [${consensusId}] initiated for: ${targetFile}`, 'WARN', 'critical-consensus');

  try {
    // -----------------------------------------------------------------------
    // PHASE 1: Gather analyses from ALL providers
    // -----------------------------------------------------------------------
    const providers = getGetAvailableProviders()();
    if (providers.length < MIN_PROVIDER_COUNT) {
      log(`Not enough providers (${providers.length} < ${MIN_PROVIDER_COUNT}) for critical consensus`, 'WARN', 'critical-consensus');
      return { applied: false, reason: `Insufficient providers: ${providers.length} (need ${MIN_PROVIDER_COUNT})`, details: { consensusId, providerCount: providers.length } };
    }

    const analysisPrompt = buildAnalysisPrompt(enrichedContext);
    const analyses = [];

    const results = await Promise.allSettled(
      providers.map(async (provider: any) => {
        const start = Date.now();
        try {
          const response = await getRetryWithBackoff()(
            (sig: any) => provider.fn(null, analysisPrompt, sig, { validate: false, useTextOnly: true }),
            `CriticalConsensus-Analysis-${provider.name}`,
            { url: provider.name, maxRetries: 2, baseDelay: 2000 }
          );
          const latency = Date.now() - start;
          const parsed = parseJSON(response);
          return { provider: provider.name, ...parsed, latency };
        } catch (err: any) {
          return { provider: provider.name, error: err.message, change_needed: false };
        }
      })
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) {
        analyses.push(r.value);
        recordConsensusEvent({
          phase: 'analysis',
          targetFile,
          provider: r.value.provider,
          approved: r.value.change_needed,
          confidence: r.value.confidence,
          reasoning: r.value.reasoning,
          details: { risk: r.value.risk_assessment, alternatives: r.value.alternative_approaches },
        });
      }
    }

    // -----------------------------------------------------------------------
    // PHASE 2: Check unanimous agreement
    // -----------------------------------------------------------------------
    const wantChange = analyses.filter(a => a.change_needed === true || a.change_needed === 'true');
    const dontWantChange = analyses.filter(a => a.change_needed === false);
    const errored = analyses.filter(a => a.error);

    log(
      `Consensus [${consensusId}] results: ${wantChange.length} want change, ${dontWantChange.length} don't, ${errored.length} errored`,
      'INFO',
      'critical-consensus'
    );

    // Unanimous means: ALL non-errored providers must agree.
    // Allow consensus to proceed if enough providers succeeded to meet MIN_PROVIDER_COUNT.
    if (errored.length > 0) {
      if (wantChange.length + dontWantChange.length < MIN_PROVIDER_COUNT) {
        return {
          applied: false,
          reason: `${errored.length} provider(s) errored — not enough successful providers for consensus (${wantChange.length + dontWantChange.length} < ${MIN_PROVIDER_COUNT})`,
          details: { consensusId, analyses: analyses.map(a => ({ provider: a.provider, change_needed: a.change_needed, error: a.error })) },
        };
      }
      log(`${errored.length} provider(s) errored but ${wantChange.length + dontWantChange.length} succeeded — proceeding with available providers`, 'WARN', 'critical-consensus');
    }

    if (dontWantChange.length > 0) {
      const reasons = dontWantChange.map(a => `${a.provider}: ${a.reasoning}`).join('; ');
      log(`Consensus [${consensusId}] BLOCKED — not unanimous. Reasons: ${reasons}`, 'INFO', 'critical-consensus');
      return {
        applied: false,
        reason: `Not unanimous: ${dontWantChange.length} provider(s) rejected the change`,
        details: { consensusId, rejectReasons: reasons, analyses },
      };
    }

    if (wantChange.length === 0) {
      return { applied: false, reason: 'No providers recommended a change', details: { consensusId } };
    }

    // -----------------------------------------------------------------------
    // PHASE 3: Validate that all providers agree on the SAME patch
    // -----------------------------------------------------------------------
    // All must target the same file
    const targetFiles = new Set(wantChange.map(a => a.file));
    if (targetFiles.size !== 1 || !targetFiles.has(targetFile)) {
      return {
        applied: false,
        reason: `Providers disagree on target file: ${[...targetFiles].join(', ')}`,
        details: { consensusId },
      };
    }

    // Check content similarity — all proposed contents should be highly similar
    const contents = wantChange.map(a => a.new_content).filter(Boolean);
    if (contents.length < wantChange.length) {
      return {
        applied: false,
        reason: 'Some providers did not provide new_content',
        details: { consensusId },
      };
    }

    // Reject if all contents are empty/whitespace
    if (contents.every(c => !c.trim())) {
      return { applied: false, reason: 'All providers returned empty content — patch rejected', details: { consensusId } };
    }

    const referenceContent = contents[0];
    for (let i = 1; i < contents.length; i++) {
      const similarity = contentSimilarity(referenceContent, contents[i]);
      if (similarity < 0.85) {
        log(
          `Consensus [${consensusId}] BLOCKED — content disagreement between providers (similarity: ${similarity.toFixed(2)})`,
          'WARN',
          'critical-consensus'
        );
        return {
          applied: false,
          reason: `Providers disagree on patch content (similarity as low as ${similarity.toFixed(2)})`,
          details: { consensusId, similarity },
        };
      }
    }

    // Pick the longest content as the "consensus patch" (most complete)
    const consensusContent = contents.reduce((a, b) => a.length >= b.length ? a : b, '');
    const patchHash = hashContent(consensusContent);

    // Check average confidence
    const avgConfidence = wantChange.reduce((sum, a) => sum + (a.confidence || 0), 0) / wantChange.length;
    if (avgConfidence < 0.8) {
      return {
        applied: false,
        reason: `Average confidence too low: ${(avgConfidence * 100).toFixed(0)}% (minimum 80%)`,
        details: { consensusId, avgConfidence },
      };
    }

    // Check risk assessment — reject "critical" risk patches outright
    const hasCriticalRisk = wantChange.some(a => (a.risk_assessment || '').toLowerCase() === 'critical');
    if (hasCriticalRisk) {
      return {
        applied: false,
        reason: 'One or more providers assessed the risk as CRITICAL — patch rejected',
        details: { consensusId },
      };
    }

    log(
      `✅ Consensus [${consensusId}] PHASE 1 PASSED: ${wantChange.length}/${analyses.length} providers agree on patch for ${targetFile} (confidence: ${(avgConfidence * 100).toFixed(0)}%)`,
      'WARN',
      'critical-consensus'
    );

    // -----------------------------------------------------------------------
    // PHASE 4: Multi-round verification — providers review the patch
    // -----------------------------------------------------------------------
    const verificationPrompt = buildVerificationPrompt(
      { file: targetFile, riskAssessment: wantChange[0].risk_assessment, newContent: consensusContent },
      wantChange
    );

    const verifications = await Promise.allSettled(
      providers.map(async (provider: any) => {
        try {
          const response = await getRetryWithBackoff()(
            (sig: any) => provider.fn(null, verificationPrompt, sig, { validate: false, useTextOnly: true }),
            `CriticalConsensus-Verify-${provider.name}`,
            { url: provider.name, maxRetries: 1, baseDelay: 1000 }
          );
          const parsed = parseJSON(response);
          return { provider: provider.name, ...parsed };
        } catch (err: any) {
          return { provider: provider.name, approved: false, concerns: [`Provider error: ${err.message}`] };
        }
      })
    );

    let verificationPassed = true;
    const allVerificationResults = [];
    for (const r of verifications) {
      if (r.status === 'fulfilled' && r.value) {
        allVerificationResults.push(r.value);
        recordConsensusEvent({
          phase: 'verification',
          targetFile,
          provider: r.value.provider,
          approved: r.value.approved,
          confidence: r.value.confidence,
          reasoning: r.value.concerns?.join('; ') || 'Approved',
          patchHash,
          details: { suggested_fixes: r.value.suggested_fixes },
        });
        if (!r.value.approved) {
          verificationPassed = false;
        }
      } else {
        verificationPassed = false;
      }
    }

    if (!verificationPassed) {
      const concerns = allVerificationResults
        .filter(v => !v.approved)
        .map(v => `${v.provider}: ${v.concerns?.join(', ') || 'no reason given'}`)
        .join('; ');
      log(`Consensus [${consensusId}] FAILED verification: ${concerns}`, 'ERROR', 'critical-consensus');
      return {
        applied: false,
        reason: `Verification round failed: ${concerns}`,
        details: { consensusId, verifications: allVerificationResults },
      };
    }

    log(`✅ Consensus [${consensusId}] PHASE 2 PASSED: All providers verified the patch`, 'WARN', 'critical-consensus');

    // -----------------------------------------------------------------------
    // PHASE 5: Cooling-off period
    // -----------------------------------------------------------------------
    log(`⏳ Consensus [${consensusId}] entering cooling-off period: ${(COOLING_OFF_MS / 1000 / 60).toFixed(1)} minutes...`, 'INFO', 'critical-consensus');
    await new Promise(resolve => setTimeout(resolve, COOLING_OFF_MS));

    // -----------------------------------------------------------------------
    // PHASE 6: Final veto check
    // -----------------------------------------------------------------------
    const vetoPrompt = buildVetoPrompt({ file: targetFile, newContent: consensusContent, approvalCount: wantChange.length });
    const vetoResults = await Promise.allSettled(
      providers.map(async (provider: any) => {
        try {
          const response = await getRetryWithBackoff()(
            (sig: any) => provider.fn(null, vetoPrompt, sig, { validate: false, useTextOnly: true }),
            `CriticalConsensus-Veto-${provider.name}`,
            { url: provider.name, maxRetries: 1, baseDelay: 1000 }
          );
          const parsed = parseJSON(response);
          return { provider: provider.name, ...parsed };
        } catch (err: any) {
          // A provider error during veto is treated as a veto (fail-safe)
          return { provider: provider.name, veto: true, reason: `Provider error: ${err.message}` };
        }
      })
    );

    let vetoed = false;
    let vetoReason = '';
    for (const r of vetoResults) {
      if (r.status === 'fulfilled' && r.value?.veto) {
        vetoed = true;
        vetoReason = `${r.value.provider}: ${r.value.reason}`;
        break;
      }
      if (r.status === 'rejected') {
        vetoed = true;
        vetoReason = `Provider ${r.reason?.message || 'unknown'} failed during veto check`;
        break;
      }
    }

    if (vetoed) {
      log(`Consensus [${consensusId}] VETOED during final check: ${vetoReason}`, 'ERROR', 'critical-consensus');
      recordConsensusEvent({
        phase: 'veto',
        targetFile,
        approved: false,
        confidence: 0,
        reasoning: vetoReason,
        patchHash,
      });
      return {
        applied: false,
        reason: `Patch vetoed during final check: ${vetoReason}`,
        details: { consensusId, vetoReason },
      };
    }

    // -----------------------------------------------------------------------
    // PHASE 7: Apply the patch
    // -----------------------------------------------------------------------
    log(`🔒 Consensus [${consensusId}] ALL PHASES PASSED. Applying critical patch to ${targetFile}...`, 'WARN', 'critical-consensus');

    // 7a. Immutable backup
    const backupPath = createImmutableBackup(fullPath);
    const prePatchHash = hashContent(currentFileContent);

    // 7b. Sandbox test — try loading the new content
    const sandboxResult = await getExecutePatchInSandbox()(consensusContent, fullPath);
    if (!sandboxResult || !sandboxResult.safe) {
      log(`Consensus [${consensusId}] sandbox execution failed — aborting`, 'ERROR', 'critical-consensus');
      return {
        applied: false,
        reason: 'Sandbox execution of patched file failed',
        details: { consensusId },
      };
    }

    // 7c. Verify and write the patch (writes to temp first, copies to real location only on success)
    const loadOk = await verifyFileLoad(fullPath, consensusContent);
    if (!loadOk) {
      log(`Consensus [${consensusId}] patched file fails to load — keeping original`, 'ERROR', 'critical-consensus');
      return {
        applied: false,
        reason: 'Patched file fails to load. Original kept.',
        details: { consensusId },
      };
    }

    log(`✅ Consensus [${consensusId}] patch written to ${targetFile}`, 'WARN', 'critical-consensus');

    // 7e. Record in patch_history
    try {
      getInsertPatch()?.run(
        Date.now(),
        `CRITICAL CONSENSUS [${consensusId}]: ${wantChange[0].reasoning?.substring(0, 200)}`,
        targetFile,
        consensusContent.substring(0, 5000),
        'applied',
        Date.now(),
        'critical-consensus'
      );
    } catch (e: any) {
      logError('Failed to record critical patch in patch_history', e);
    }

    // 7f. Start rollback monitor
    startRollbackMonitor(fullPath, backupPath, patchHash);

    // 7g. Record final consensus event
    recordConsensusEvent({
      phase: 'applied',
      targetFile,
      approved: true,
      confidence: avgConfidence,
      reasoning: `Unanimous consensus (${wantChange.length} providers). All verification and veto checks passed.`,
      patchHash,
      details: {
        consensusId,
        backupPath,
        prePatchHash,
        providers: wantChange.map(a => a.provider),
        coolingOffMs: COOLING_OFF_MS,
      },
    });

    // 7h. Alert all channels
    await getSendAlert()(
      `CRITICAL PATCH APPLIED [${consensusId}]: ${targetFile} was modified by unanimous AI consensus (${wantChange.length} providers). Confidence: ${(avgConfidence * 100).toFixed(0)}%. Backup: ${backupPath}`,
      1 // highest priority
    );

// @ts-expect-error
    logAudit('critical_patch_applied', { consensusId, targetFile, providerCount: wantChange.length, confidence: avgConfidence, patchHash });

    return {
      applied: true,
      reason: `Unanimous consensus (${wantChange.length} providers, confidence ${(avgConfidence * 100).toFixed(0)}%)`,
      details: {
        consensusId,
        targetFile,
        providerCount: wantChange.length,
        confidence: avgConfidence,
        patchHash,
        backupPath,
        verificationWindowMs: VERIFICATION_WINDOW_MS,
      },
    };

  } catch (err: any) {
    logError(`Critical consensus [${consensusId}] unexpected error`, err);
    recordConsensusEvent({
      phase: 'error',
      targetFile,
      approved: false,
      confidence: 0,
      reasoning: err.message,
      details: { consensusId, stack: err.stack },
    });
    return {
      applied: false,
      reason: `Unexpected error: ${err.message}`,
      details: { consensusId },
    };
  } finally {
    isConsensusRunning = false;
  }
}

/**
 * Get the list of critical files that this module can modify.
 */
function getCriticalFiles() { 
  return [...CRITICAL_FILES];
}

/**
 * Check if a consensus process is currently running.
 */
function isRunning() { 
  return isConsensusRunning;
}

/**
 * Get recent critical consensus events from the database.
 */
function getConsensusHistory(limit = 20) { 
  try {
    return getDb()?.prepare(
      `SELECT * FROM critical_consensus ORDER BY timestamp DESC LIMIT ?`
    ).all(limit);
  } catch (err: any) {
    logError('Failed to query consensus history', err);
    return [];
  }
}

/**
 * Manually roll back the most recent critical patch for a given file.
 * Returns true if rollback was successful.
 */
function manualRollback(targetFile: any) { 
  const fullPath = path.join(SOURCE_DIR, targetFile);
  const backupDir = path.join(SOURCE_DIR, '.critical-backups');

  if (!fs.existsSync(backupDir)) {
    log('No backup directory found', 'WARN', 'critical-consensus');
    return false;
  }

  // Find the most recent backup for this file
  const prefix = targetFile.replace(/\//g, '_');
  const backups = fs.readdirSync(backupDir)
    .filter((f: any) => f.startsWith(prefix) && f.endsWith('.bak'))
    .sort()
    .reverse();

  if (backups.length === 0) {
    log(`No backups found for ${targetFile}`, 'WARN', 'critical-consensus');
    return false;
  }

  const backupPath = path.join(backupDir, backups[0]);
  try {
    fs.copyFileSync(backupPath, fullPath);
    log(`↩️ Manual rollback: restored ${targetFile} from ${backupPath}`, 'WARN', 'critical-consensus');
    recordConsensusEvent({
      phase: 'manual_rollback',
      targetFile,
      approved: false,
      confidence: 0,
      reasoning: `Manual rollback from ${backupPath}`,
      details: { backupPath },
    });
    try { getSendAlert()(`MANUAL ROLLBACK: ${targetFile} was restored from backup`, 2); } catch (e: any) {}
// @ts-expect-error
    logAudit('critical_patch_manual_rollback', { targetFile, backupPath });
    return true;
  } catch (err: any) {
    logError(`Manual rollback failed for ${targetFile}`, err);
    return false;
  }
}

function getConsensusStatus() { 
  const history = getConsensusHistory(1);
  return {
    isRunning: isConsensusRunning,
    lastEvent: history.length > 0 ? history[0] : null,
  };
}

module.exports = {
  _injectDependencies,
  requestCriticalPatch,
  getCriticalFiles,
  isRunning,
  getConsensusHistory,
  getConsensusStatus,
  manualRollback,
};