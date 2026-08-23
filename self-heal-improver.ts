'use strict';

// ═══════════════════════════════════════════════════════════════════════════════
// Self-Improvement System
// ═══════════════════════════════════════════════════════════════════
//
// Self-healing keeps the bot alive.  Self-improvement makes it stronger.
//
// Healing:  "something is broken → fix it"        (error-triggered)
// Improving: "something works but could work better" (schedule/perf-triggered)
//
// This module analyses recent performance, identifies the single most
// impactful improvement opportunity, asks the codegen tribunal to
// implement it, then monitors metrics to decide whether to keep or
// roll back the change.
//
// Reuses the self-heal pipeline's building blocks (tribunal, sandbox,
// staging, overlay, canary) but with a different trigger, prompt,
// and post-promotion measurement loop.
// ═══════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const crypto = require('crypto');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function getDb() { return _deps.database?.db; }

function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }
function getProvidersStats() { return _deps.providersStats || require('./providers-stats'); }
function getGenerateCodeFixViaTribunal() { return _deps.codegenTribunal?.generateCodeFixViaTribunal || require('./providers-codegen-tribunal').generateCodeFixViaTribunal; }
function getConsultTribunalRaw() { return _deps.codegenTribunal?.consultTribunalRaw || (() => { try { return require('./providers-codegen-tribunal').consultTribunalRaw; } catch { return null; } })(); }
function getExecutePatchInSandbox() { return _deps.sandboxExecutor?.executePatchInSandbox || require('./sandbox-executor').executePatchInSandbox; }
function getAuditPatch() { return _deps.auditor?.auditPatch || require('./self-heal-auditor').auditPatch; }
function getPatchMemory() { return _deps.patchMemory || require('./self-heal-patch-memory'); }
function getCanary() { return _deps.canary || require('./self-heal-canary'); }
function getMemoryMode() { return require('./memory-mode'); }

const SOURCE_DIR = PROJECT_ROOT;

// ─── Tuning Knobs ───
const IMPROVE_INTERVAL_MS = 2 * 60 * 60 * 1000;           // Run every 2 hours
const IMPROVE_MIN_CYCLES_SINCE_LAST = 50;                 // Need 50+ cycles of data
const IMPROVE_MIN_QUESTIONS_WINDOW = 5;                   // Need 5+ completions in window
const METRIC_OBSERVATION_WINDOW_MS = 30 * 60 * 1000;       // 30 min to measure impact
const METRIC_DEGRADATION_THRESHOLD = 0.15;                 // Roll back if >15% worse
const MAX_IMPROVEMENTS_PER_DAY = 3;                        // Don't go crazy
const IMPROVE_COOLDOWN_AFTER_ROLLBACK_MS = 4 * 60 * 60 * 1000; // 4h cooldown after rollback

let _lastImprovementTime = 0;
let _lastRollbackTime = 0;
let _improvementsToday = 0;
let _improvementDay = new Date().toDateString();
let _isImproving = false;
let _metricsSnapshot: { questionsCompleted: number; errors: number; timestamp: number } | null = null;

// ═════════════════════════════════════════════════════════════════════
//  IMPROVEMENT OPPORTUNITY ANALYSIS
// ═════════════════════════════════════════════════════════

interface ImprovementSignal {
  type: string;
  description: string;
  severity: number;   // 0-1
  suggestedFiles: string[];
  context: string;
}

/**
 * Read recent blackbox entries for pattern analysis.
 * Returns the last N entries with state, action, success, reasoning.
 */
function _fetchRecentBlackbox(limit = 200): any[] {
  try {
    const stmt = getDb()?.prepare(`
      SELECT state, action, success, reasoning, latency, provider_used
      FROM blackbox ORDER BY timestamp DESC LIMIT ?
    `);
    return stmt?.all(limit) || [];
  } catch { return []; }
}

/**
 * Read recent progress log entries.
 */
function _fetchRecentProgress(limit = 100): any[] {
  try {
    const stmt = getDb()?.prepare(`
      SELECT ts, questions_completed, provider, model, action, success
      FROM progress_log ORDER BY ts DESC LIMIT ?
    `);
    return stmt?.all(limit) || [];
  } catch { return []; }
}

/**
 * Analyse recent performance and return ranked improvement signals.
 * Each signal represents a concrete bottleneck the AI could fix.
 */
function analyzeOpportunities(): ImprovementSignal[] {
  const signals: ImprovementSignal[] = [];
  const stats = getProvidersStats().getStats();
  const blackbox = _fetchRecentBlackbox(200);
  const progress = _fetchRecentProgress(100);

  // ── Signal 1: High error rate in specific states ──
  const stateErrors: Record<string, { total: number; errors: number }> = {};
  for (const entry of blackbox) {
    if (!entry.state) continue;
    if (!stateErrors[entry.state]) stateErrors[entry.state] = { total: 0, errors: 0 };
    stateErrors[entry.state].total++;
    if (entry.success === 0) stateErrors[entry.state].errors++;
  }
  for (const [state, data] of Object.entries(stateErrors)) {
    if (data.total < 10) continue;
    const errorRate = data.errors / data.total;
    if (errorRate > 0.25) {
      // Map states to likely files
      let files: string[] = [];
      if (state.includes('blank')) files = ['cycle-action-executor.ts', 'browser.ts'];
      else if (state.includes('question') || state.includes('keypad')) files = ['providers-detection-module-completion.ts', 'cycle-action-executor.ts'];
      else if (state.includes('captcha')) files = ['captcha-solver-external.ts', 'providers-detection-captcha-solver.ts'];
      else files = ['cycle-action-executor.ts', 'state-machine.ts'];

      // Get failure reasons for context
      const failures = blackbox
        .filter((e: any) => e.state === state && e.success === 0 && e.reasoning)
        .map((e: any) => e.reasoning)
        .slice(0, 5);

      signals.push({
        type: 'high_error_state',
        description: `State '${state}' fails ${Math.round(errorRate * 100)}% of the time (${data.errors}/${data.total})`,
        severity: errorRate,
        suggestedFiles: files,
        context: `State '${state}' has ${data.errors} failures out of ${data.total} attempts.\nFailure reasons: ${failures.join('; ') || 'none captured'}`,
      });
    }
  }

  // ── Signal 2: Slow provider latency ──
  const providerLatencies: Record<string, number[]> = {};
  for (const entry of blackbox) {
    if (!entry.provider_used || !entry.latency || entry.latency <= 0) continue;
    if (!providerLatencies[entry.provider_used]) providerLatencies[entry.provider_used] = [];
    providerLatencies[entry.provider_used].push(entry.latency);
  }
  for (const [provider, latencies] of Object.entries(providerLatencies)) {
    if (latencies.length < 5) continue;
    const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
    if (avg > 15000) { // >15s average
      signals.push({
        type: 'slow_provider',
        description: `${provider} averages ${Math.round(avg)}ms per call (${latencies.length} samples)`,
        severity: Math.min(1, avg / 60000),
        suggestedFiles: ['providers-fallback.ts', 'providers-registry.ts', 'providers-config-loader.ts'],
        context: `Provider ${provider} has high latency: avg=${Math.round(avg)}ms, p50=${Math.round(latencies.sort((a, b) => a - b)[Math.floor(latencies.length / 2)])}ms, p95=${Math.round(latencies.sort((a, b) => a - b)[Math.floor(latencies.length * 0.95)])}ms`,
      });
    }
  }

  // ── Signal 3: Repeated identical failures (the bot keeps trying the same bad thing) ──
  const reasoningCounts: Record<string, number> = {};
  for (const entry of blackbox) {
    if (entry.success === 0 && entry.reasoning) {
      const key = entry.reasoning.substring(0, 100);
      reasoningCounts[key] = (reasoningCounts[key] || 0) + 1;
    }
  }
  const repeatedFailures = Object.entries(reasoningCounts)
    .filter(([, count]) => count >= 5)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3);
  for (const [reason, count] of repeatedFailures) {
    signals.push({
      type: 'repeated_failure',
      description: `Same failure repeated ${count} times: "${reason.substring(0, 80)}"`,
      severity: Math.min(1, count / 15),
      suggestedFiles: ['cycle-action-executor.ts', 'cycle-stagnation.ts', 'providers-fallback.ts'],
      context: `The bot failed with reasoning "${reason}" ${count} times in the last ${blackbox.length} actions. This suggests a systematic issue that retrying won't fix.`,
    });
  }

  // ── Signal 4: Low throughput (questions per hour) ──
  if (progress.length >= 10) {
    const oldest = progress[progress.length - 1];
    const newest = progress[0];
    const windowMs = (newest.ts || 0) - (oldest.ts || 0);
    if (windowMs > 30 * 60 * 1000) { // at least 30 min of data
      const completedInWindow = progress.filter((p: any) => p.success === 1).length;
      const qph = (completedInWindow / windowMs) * 3600000;
      if (qph < 8) {
        signals.push({
          type: 'low_throughput',
          description: `Throughput is ${qph.toFixed(1)} questions/hour (target: 10+)`,
          severity: Math.max(0, 1 - qph / 10),
          suggestedFiles: ['cycle-action-executor.ts', 'cycle-stagnation.ts', 'providers-fallback.ts', 'state-machine.ts'],
          context: `In the last ${Math.round(windowMs / 60000)} minutes, the bot completed ${completedInWindow} questions (${qph.toFixed(1)} q/h). Potential causes: wasted cycles on retries, slow providers, or inefficient state transitions.`,
        });
      }
    }
  }

  // ── Signal 5: Specific action types with low success rates ──
  const actionStats: Record<string, { total: number; errors: number }> = {};
  for (const entry of blackbox) {
    if (!entry.action) continue;
    if (!actionStats[entry.action]) actionStats[entry.action] = { total: 0, errors: 0 };
    actionStats[entry.action].total++;
    if (entry.success === 0) actionStats[entry.action].errors++;
  }
  for (const [action, data] of Object.entries(actionStats)) {
    if (data.total < 15) continue;
    const errorRate = data.errors / data.total;
    if (errorRate > 0.2 && errorRate < 1) { // between 20% and 100%
      signals.push({
        type: 'action_failure',
        description: `Action '${action}' fails ${Math.round(errorRate * 100)}% (${data.errors}/${data.total})`,
        severity: errorRate * 0.8,
        suggestedFiles: ['cycle-action-executor.ts', 'providers-detection-work-detector.ts', 'selectors.ts'],
        context: `Action type '${action}' has a ${Math.round(errorRate * 100)}% failure rate. Consider improving the detection logic, selectors, or fallback behavior for this action.`,
      });
    }
  }

  return signals.sort((a, b) => b.severity - a.severity);
}

// ═════════════════════════════════════════════════════════════════════
//  IMPROVEMENT PROMPT BUILDER
// ═══════════════════════════════════════════════════════════════════

/**
 * Build the improvement-oriented codegen prompt.
 * This is fundamentally different from the bug-fix prompt:
 * - No error to "fix"
 * - Instead: a performance bottleneck to "improve"
 * - The AI should optimise, not repair
 */
function _buildImprovementPrompt(
  signal: ImprovementSignal,
  targetFile: string | null,
  fileContent: string | null,
  fileListing: string | null,
): string {
  const codebaseCtx = require('./self-heal-codebase-context').CODEBASE_CONTEXT || '';

  let prompt = `You are a senior Node.js/TypeScript developer IMPROVING an automation bot.\n`;
  if (codebaseCtx) prompt += `${codebaseCtx}\n`;
  prompt += `\nPERFORMANCE BOTTLENECK:\n`;
  prompt += `${signal.description}\n\n`;
  prompt += `DETAILED ANALYSIS:\n${signal.context}\n\n`;

  if (targetFile && fileContent) {
    // Read import context for the target file
    let importCtx = '';
    try {
      const selfHeal = require('./self-heal');
      // _getImportContext is private, but we can replicate it
      const lines = fileContent.split('\n');
      const importLines = lines.filter((l: string) => /^(?:const|let|import|require\()/.test(l.trim()) || /from ['"]\.\//.test(l));
      const localModules: string[] = [];
      for (const line of importLines) {
        const matches = line.matchAll(/require\(['"]\.\/(.+?)['"]\)|from ['"]\.\/(.+?)['"]\)/g);
        for (const m of matches) {
          const mod = (m[1] || m[2] || '').replace(/\.(ts|js)$/, '');
          if (mod && !localModules.includes(mod) && localModules.length < 8) localModules.push(mod);
        }
      }
      if (localModules.length > 0) {
        importCtx = '\nRelated modules (first 50 lines each):\n';
        for (const mod of localModules) {
          const modPath = path.join(SOURCE_DIR, mod + '.ts');
          if (fs.existsSync(modPath)) {
            try {
              const content = fs.readFileSync(modPath, 'utf8');
              importCtx += `--- ${mod}.ts ---\n${content.split('\n').slice(0, 50).join('\n')}\n---\n`;
            } catch {}
          }
        }
      }
    } catch {}

    prompt += `TARGET FILE TO IMPROVE: ${targetFile}\n`;
    prompt += `--- BEGIN FILE: ${targetFile} ---\n${fileContent}\n--- END FILE ---\n`;
    if (importCtx) prompt += `\n${importCtx}\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Analyze the performance bottleneck described above.\n`;
    prompt += `2. Propose a code improvement that addresses this bottleneck.\n`;
    prompt += `3. Return a JSON ARRAY with a SINGLE object:\n`;
    prompt += `- "file": "${targetFile}" (exact filename)\n`;
    prompt += `- "change": (string) description of the improvement\n`;
    prompt += `- "patch": (string) EITHER a unified diff OR the complete file content\n`;
    prompt += `Prefer unified diffs for small, surgical improvements.\n`;
    prompt += `Do NOT change the module's public API (exports).\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  } else if (fileListing) {
    prompt += `AVAILABLE FILES (choose ONE to improve):\n${fileListing}\n\n`;
    prompt += `INSTRUCTIONS:\n`;
    prompt += `1. Analyze the bottleneck and identify which file to improve.\n`;
    prompt += `2. Return a JSON ARRAY with a SINGLE object:\n`;
    prompt += `- "file": (string) the exact filename\n`;
    prompt += `- "change": (string) description\n`;
    prompt += `- "patch": (string) EITHER a unified diff OR complete file content\n`;
    prompt += `Return ONLY the JSON array. No markdown fences, no explanation.\n`;
  } else {
    return ''; // Can't build a useful prompt without file info
  }

  return prompt;
}

// ═════════════════════════════════════════════════════════════════════
//  FILE READING HELPERS
// ═════════════════════════════════════════════════════════════════════

/**
 * Get a listing of patchable files, filtered by ALLOWED_PREFIXES.
 */
function _getFileListing(): string {
  try {
    const allowedPrefixes: string[] = require('./self-heal-codebase-context').ALLOWED_PREFIXES || [];
    const files: string[] = [];
    const entries = fs.readdirSync(SOURCE_DIR).filter((f: string) => f.endsWith('.ts'));
    for (const f of entries) {
      if (allowedPrefixes.some((p: string) => f.startsWith(p))) {
        files.push(f);
      }
    }
    return files.join('\n');
  } catch { return ''; }
}

/**
 * Read a file's content, or null if it doesn't exist.
 */
function _readFileContent(filename: string): string | null {
  try {
    const fullPath = path.join(SOURCE_DIR, filename);
    if (!fs.existsSync(fullPath)) return null;
    return fs.readFileSync(fullPath, 'utf8');
  } catch { return null; }
}

/**
 * Pick the best target file from a signal's suggested files.
 * Prefers files that exist on disk.
 */
function _pickTargetFile(signal: ImprovementSignal): { file: string | null; content: string | null } {
  for (const f of signal.suggestedFiles) {
    const content = _readFileContent(f);
    if (content) return { file: f, content };
  }
  return { file: null, content: null };
}

// ═════════════════════════════════════════════════════════════════════
//  MAIN ENTRY POINT: performSelfImprovement
// ═════════════════════════════════════════════════════════════════════

async function performSelfImprovement(): Promise<boolean> {
  // ── Guards ──
  if (_isImproving) { log('Self-improvement already running, skipping', 'DEBUG', 'improver'); return false; }
  if (!getCONFIG().SELF_HEAL_ENABLED) return false;

  // Daily limit
  const today = new Date().toDateString();
  if (today !== _improvementDay) { _improvementsToday = 0; _improvementDay = today; }
  if (_improvementsToday >= MAX_IMPROVEMENTS_PER_DAY) {
    log(`Self-improvement daily limit reached (${MAX_IMPROVEMENTS_PER_DAY})`, 'DEBUG', 'improver');
    return false;
  }

  // Cooldown after rollback
  if (Date.now() - _lastRollbackTime < IMPROVE_COOLDOWN_AFTER_ROLLBACK_MS) {
    return false;
  }

  // Interval check
  if (Date.now() - _lastImprovementTime < IMPROVE_INTERVAL_MS && _lastImprovementTime > 0) {
    return false;
  }

  // Minimum data requirement
  const stats = getProvidersStats().getStats();
  if (stats.cycleCount < IMPROVE_MIN_CYCLES_SINCE_LAST) {
    return false;
  }

  // ── Skip at high degradation levels ──
  try {
    const { degradationLadder } = require('./self-heal-degradation-ladder');
    if (degradationLadder.shouldSkip?.('self-heal-improver')) return false;
  } catch {}

  _isImproving = true;
  const startTime = Date.now();
  log('Self-improvement cycle starting...', 'INFO', 'improver');

  try {
    // 1. Analyse opportunities
    const signals = analyzeOpportunities();
    if (signals.length === 0) {
      log('No improvement opportunities found', 'DEBUG', 'improver');
      return false;
    }
    const topSignal = signals[0];
    log(`Top improvement opportunity: [${topSignal.type}] ${topSignal.description} (severity: ${topSignal.severity.toFixed(2)})`, 'INFO', 'improver');

    // Skip low-severity signals — not worth the API call
    if (topSignal.severity < 0.2) {
      log(`Severity ${topSignal.severity.toFixed(2)} below threshold 0.2, skipping`, 'DEBUG', 'improver');
      return false;
    }

    // 2. Resolve target file
    const { file: targetFile, content: fileContent } = _pickTargetFile(topSignal);
    const fileListing = !targetFile ? _getFileListing() : null;

    // 3. Snapshot current metrics (for before/after comparison)
    _metricsSnapshot = {
      questionsCompleted: stats.questionsCompleted || 0,
      errors: stats.errors || 0,
      timestamp: Date.now(),
    };

    // 4. Build improvement prompt
    const prompt = _buildImprovementPrompt(topSignal, targetFile, fileContent, fileListing);
    if (!prompt) {
      log('Could not build improvement prompt (no file info)', 'WARN', 'improver');
      return false;
    }

    // 5. Generate improvement via codegen tribunal
    const signal = AbortSignal.timeout(getCONFIG().SELF_HEAL_TRIBUNAL_TIMEOUT_MS || 120_000);
    const investigationData = {
      targetFile: targetFile || undefined,
      fileContent: fileContent ? fileContent.substring(0, 12000) : undefined,
      fileListing: fileListing || undefined,
      screenshot: null,  // No screenshot for improvement mode
      html: null,
      url: null,
    };

    let fixes: any[] | null = null;
    try {
      fixes = await getGenerateCodeFixViaTribunal()(
        investigationData,
        `[SELF-IMPROVEMENT MODE] ${topSignal.description}\n\n${topSignal.context}`,
        signal,
        { allowNonCodegenFallback: true },
      );
    } catch (err: any) {
      log(`Improvement tribunal failed: ${err.message || err}`, 'WARN', 'improver');
      return false;
    }

    if (!fixes || fixes.length === 0) {
      log('Tribunal returned no improvement suggestions', 'DEBUG', 'improver');
      return false;
    }

    const fix = fixes[0];
    log(`Improvement generated: ${fix.change} → ${fix.file} (${fix.patch.length} chars)`, 'INFO', 'improver');

    // 6. Validate via sandbox
    try {
      const sandboxResult = await getExecutePatchInSandbox()(fix.patch, fix.file);
      if (!sandboxResult?.safe) {
        log(`Improvement blocked by sandbox: ${sandboxResult?.violations?.join('; ') || sandboxResult?.error || 'unknown'}`, 'WARN', 'improver');
        return false;
      }
    } catch (err: any) {
      log(`Sandbox validation failed: ${err.message || err}`, 'WARN', 'improver');
      return false;
    }

    // 7. Validate via AI auditor (lighter than full self-heal — no approval workflow)
    try {
      const auditResult = await getAuditPatch()(fix.patch);
      if (!auditResult?.safe && !auditResult?.is_safe) {
        log(`Improvement blocked by AI auditor: ${auditResult?.reason || 'unknown'}`, 'WARN', 'improver');
        return false;
      }
    } catch (err: any) {
      log(`AI audit failed (non-fatal, proceeding): ${err.message || err}`, 'WARN', 'improver');
      // Don't block on audit failure — improvements are lower risk than fixes
    }

    // 8. Apply via staging → promotion (reuse self-heal's overlay-aware pipeline)
    const isReadOnlyFs = !!(process.env.RENDER || process.env.RENDER_SERVICE_ID);
    let overlay: any = null;
    if (isReadOnlyFs) {
      try { overlay = require('./self-heal-tmp-overlay'); } catch {}
    }

    // Backup first
    const backupPath = path.join(
      getCONFIG().SELF_HEAL_BACKUP_DIR || '/tmp/self-heal-backups',
      `improve-${Date.now()}`,
    );
    try {
      fs.mkdirSync(backupPath, { recursive: true });
      const srcPath = path.join(SOURCE_DIR, fix.file);
      if (fs.existsSync(srcPath)) {
        fs.copyFileSync(srcPath, path.join(backupPath, fix.file));
      }
    } catch (err: any) {
      log(`Backup failed: ${err.message}`, 'WARN', 'improver');
    }

    // Apply the patch
    let applied = false;
    try {
      if (isReadOnlyFs && overlay) {
        // Write to overlay
        const ok = overlay.writeToOverlay(fix.file, fix.patch);
        if (ok) {
          overlay.evictModule(fix.file);
          applied = true;
          log(`Improvement applied to overlay: ${fix.file}`, 'INFO', 'improver');
        } else {
          log(`Overlay write blocked for ${fix.file}`, 'WARN', 'improver');
        }
      } else {
        // Direct write with atomic replace
        const destPath = path.join(SOURCE_DIR, fix.file);
        const dir = path.dirname(destPath);
        const tmpPath = path.join(dir, `.tmp-improve-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
        fs.writeFileSync(tmpPath, fix.patch, 'utf8');
        fs.renameSync(tmpPath, destPath);
        applied = true;
        log(`Improvement applied to disk: ${fix.file}`, 'INFO', 'improver');
      }
    } catch (err: any) {
      logError(`Failed to apply improvement`, err);
    }

    if (!applied) return false;

    // 9. Record in patch memory for future reference
    try {
      const patchMem = getPatchMemory();
      if (patchMem?.storePatch) {
        await patchMem.storePatch(
          `improve-${Date.now()}`,
          `[IMPROVEMENT] ${topSignal.description}`,
          fix.file,
          fix.patch,
          'applied',
        );
      }
    } catch {}

    // Record in DB
    try {
      getDb()?.prepare?.(`
        INSERT INTO patch_history (timestamp, description, file, patch, status, applied_at, source)
        VALUES (?, ?, ?, ?, 'applied', ?, 'self-improvement')
      `)?.run(Date.now(), fix.change || 'Self-improvement', fix.file, fix.patch, Date.now());
    } catch {}

    _lastImprovementTime = Date.now();
    _improvementsToday++;
    const duration = Date.now() - startTime;
    log(`Self-improvement applied in ${duration}ms: ${fix.file} — monitoring impact...`, 'INFO', 'improver');

    // 10. Schedule metric observation (check if improvement helped)
    //     We don't block on this — the bot continues running while we observe.
    _scheduleMetricObservation(backupPath, fix.file, overlay);

    return true;
  } catch (err: any) {
    logError('Self-improvement cycle failed', err);
    return false;
  } finally {
    _isImproving = false;
  }
}

// ═════════════════════════════════════════════════════════════════════
//  METRIC OBSERVATION & AUTO-ROLLBACK
// ═══════════════════════════════════════════════════════════════════

/**
 * After applying an improvement, wait METRIC_OBSERVATION_WINDOW_MS,
 * then compare metrics. If performance degraded beyond threshold,
 * roll back automatically.
 */
function _scheduleMetricObservation(backupPath: string, file: string, overlay: any) {
  const observationId = Date.now();
  log(`Metric observation scheduled for +${METRIC_OBSERVATION_WINDOW_MS / 60000}min (id: ${observationId})`, 'DEBUG', 'improver');

  setTimeout(async () => {
    try {
      const stats = getProvidersStats().getStats();
      const snapshot = _metricsSnapshot;
      if (!snapshot) return;

      const deltaQuestions = (stats.questionsCompleted || 0) - snapshot.questionsCompleted;
      const deltaErrors = (stats.errors || 0) - snapshot.errors;
      const windowMinutes = (Date.now() - snapshot.timestamp) / 60000;

      // Calculate rates
      const beforeErrorRate = snapshot.errors / Math.max(1, snapshot.questionsCompleted + snapshot.errors);
      const afterTotal = deltaQuestions + deltaErrors;
      const afterErrorRate = afterTotal > 0 ? deltaErrors / afterTotal : 0;

      const errorRateChange = afterErrorRate - beforeErrorRate;
      const questionsPerMinute = deltaQuestions / Math.max(1, windowMinutes);

      log(
        `Metric observation [${observationId}]: ` +
        `+${deltaQuestions} questions, +${deltaErrors} errors in ${Math.round(windowMinutes)}min ` +
        `(${questionsPerMinute.toFixed(2)} q/min, error rate change: ${(errorRateChange * 100).toFixed(1)}%)`,
        'INFO', 'improver',
      );

      // Rollback conditions:
      // 1. Error rate increased by >15 percentage points
      // 2. Zero questions completed AND errors increased
      let shouldRollback = false;
      let rollbackReason = '';

      if (errorRateChange > METRIC_DEGRADATION_THRESHOLD) {
        shouldRollback = true;
        rollbackReason = `Error rate increased by ${(errorRateChange * 100).toFixed(1)}pp (threshold: ${(METRIC_DEGRADATION_THRESHOLD * 100).toFixed(0)}pp)`;
      } else if (deltaQuestions === 0 && deltaErrors > 3) {
        shouldRollback = true;
        rollbackReason = `Zero questions completed with ${deltaErrors} new errors`;
      }

      if (shouldRollback) {
        log(`AUTO-ROLLBACK: ${rollbackReason}`, 'WARN', 'improver');
        await _rollbackImprovement(backupPath, file, overlay, rollbackReason);
      } else {
        log(`Improvement KEPT: metrics stable or improved`, 'INFO', 'improver');
        // Record success
        try {
          getDb()?.prepare?.(`
            INSERT INTO self_heal_events (timestamp, target, outcome, detail, source)
            VALUES (?, 'improvement', 'kept', ?, 'self-improvement')
          `)?.run(Date.now(), `q/min: ${questionsPerMinute.toFixed(2)}, error delta: ${(errorRateChange * 100).toFixed(1)}pp`);
        } catch {}
      }
    } catch (err: any) {
      logError('Metric observation failed', err);
    }
  }, METRIC_OBSERVATION_WINDOW_MS).unref();
}

/**
 * Roll back an improvement by restoring from backup.
 */
async function _rollbackImprovement(backupPath: string, file: string, overlay: any, reason: string) {
  try {
    const backupFile = path.join(backupPath, file);
    if (!fs.existsSync(backupFile)) {
      log(`No backup found at ${backupFile}`, 'WARN', 'improver');
      return;
    }

    const originalContent = fs.readFileSync(backupFile, 'utf8');

    if (overlay) {
      const ok = overlay.writeToOverlay(file, originalContent);
      if (ok) {
        overlay.evictModule(file);
        log(`Improvement rolled back in overlay: ${file}`, 'INFO', 'improver');
      }
    } else {
      const destPath = path.join(SOURCE_DIR, file);
      const dir = path.dirname(destPath);
      const tmpPath = path.join(dir, `.tmp-rollback-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`);
      fs.writeFileSync(tmpPath, originalContent, 'utf8');
      fs.renameSync(tmpPath, destPath);
      log(`Improvement rolled back on disk: ${file}`, 'INFO', 'improver');
    }

    _lastRollbackTime = Date.now();

    // Record rollback
    try {
      getDb()?.prepare?.(`
        INSERT INTO self_heal_events (timestamp, target, outcome, detail, source)
        VALUES (?, 'improvement', 'rolled_back', ?, 'self-improvement')
      `)?.run(Date.now(), reason);
    } catch {}
  } catch (err: any) {
    logError('Improvement rollback failed', err);
  }
}

/**
 * Check if self-improvement should be considered.
 * Called from cycle-manager to decide whether to run an improvement cycle.
 * Returns true if enough time has passed and conditions are met.
 */
function shouldImprove(): boolean {
  if (_isImproving) return false;
  if (!getCONFIG().SELF_HEAL_ENABLED) return false;
  const today = new Date().toDateString();
  if (today !== _improvementDay) { _improvementsToday = 0; _improvementDay = today; }
  if (_improvementsToday >= MAX_IMPROVEMENTS_PER_DAY) return false;
  if (Date.now() - _lastRollbackTime < IMPROVE_COOLDOWN_AFTER_ROLLBACK_MS) return false;
  if (Date.now() - _lastImprovementTime < IMPROVE_INTERVAL_MS && _lastImprovementTime > 0) return false;
  const stats = getProvidersStats().getStats();
  if (stats.cycleCount < IMPROVE_MIN_CYCLES_SINCE_LAST) return false;
  return true;
}

module.exports = {
  performSelfImprovement,
  shouldImprove,
  analyzeOpportunities,
  _injectDependencies,
};
