 strict';
// sandbox-executor.ts — Security-critical module for validating self-heal patches.
// P14 fixes:
//   1. isPatchableFile() now handles absolute paths correctly (callers pass fullPath)
//   2. Worker script no longer requires ./project-root (was crashing from /tmp/)
//   3. Path traversal check uses path.resolve() correctly for absolute filePath inputs
//   4. Worker script uses 0o600 (no execute needed — fork() handles that)
//   5. tsc command injection via filePath closed (execFileSync with args array)
//   6. auditPatchContent resets regex lastIndex (defensive for stateful patterns)
//   7. extractRelativeName() exported for external path normalization

const vm = require('vm');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const fs = require('fs');
const os = require('os');
const { fork } = require('child_process');

// Lazy logger fallback for environments where pino isn't available
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

let _log: (msg: string, level?: string, mod?: string) => void;
let _logError: (msg: string, err: Error) => void;
try {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const logger = require('./logger');
  _log = logger.log;
  _logError = logger.logError;
} catch {
  _log = (msg: string, level?: string) => { try { const _l = require('./logger'); _l.log(msg, level || 'INFO', 'sandbox-executor'); } catch { console.log(`[${level || 'INFO'}] ${msg}`); } };
  _logError = (msg: string, err: Error) => { try { const _l = require('./logger'); _l.logError(msg, err); } catch { console.error(msg, err); } };
}

const SOURCE_DIR = PROJECT_ROOT;

// ─── Allowed Node.js built-in modules for sandbox (read-only mirrors) ───
const ALLOWED_MODULES = new Set([
  'path', 'url', 'crypto', 'stream', 'buffer', 'events', 'assert', 'zlib', 'util',
]);

// ─── Dangerous patterns that must NEVER appear in AI-generated patches ───
// v5-fix: Patterns are now precise (word-boundary + context-specific) to avoid
// false positives on words like "processing", "execute", "fetch" in comments/strings.
// Comment/string content is stripped before matching (see auditPatchContent).
const BLOCKED_PATTERNS: readonly RegExp[] = [
  // Process access — match the global object, not the word "process" in identifiers
  /(?<!\w)process(?=\s*(?:\.|\[|env|exit|kill|pid|cwd|argv|stdout|stderr|stdin|versions|memoryUsage|nextTick|on|once|emit|send))(?!\w)/,
  /(?<!\w)require\s*\(/,
  /(?<!\w)global(?=\s*(?:\.|\[|this|__))(?!\w)/,
  /(?<!\w)globalThis(?=\s*(?:\.|\[))(?!\w)/,
  // Module/exports — match when used as the module object, not in strings like "module name"
  /(?<!\w)module\s*\./,
  /(?<!\w)module\.exports/,
  /(?<!\w)exports\s*[.=]/,
  /(?<!\w)__dirname(?=\s|[^a-zA-Z0-9_$])/,  
  /(?<!\w)__filename(?=\s|[^a-zA-Z0-9_$])/,  
  /(?<!\w)Buffer(?=\s*(?:\.|\[|from|alloc|isBuffer|concat))(?!\w)/,
  // Timers (could be used for resource exhaustion)
  /(?<!\w)setTimeout\s*\(/,
  /(?<!\w)setInterval\s*\(/,
  /(?<!\w)setImmediate\s*\(/,
  // Dynamic code execution
  /(?<!\w)eval\s*\(/,
  /(?<!\w)Function\s*\(/,
  /(?<!\w)new\s+Function\b/,
  // File system — match fs object access, not "fs" in a comment
  /(?<!\w)fs\s*\./,
  /(?<!\w)require\s*\(\s*['"]fs['"]\s*\)/,
  // Child processes — match the module and function calls precisely
  /(?<!\w)child_process(?=\s|[^a-zA-Z0-9_$])/,  
  /(?<![.\w])exec\s*\(/,
  /(?<![.\w])execSync\s*\(/,
  /(?<![.\w])spawn\s*\(/,
  /(?<![.\w])fork\s*\(/,
  // Network modules — match the module name, not every occurrence
  /(?<!\w)require\s*\(\s*['"](?:http|https|net|dgram)['"]\s*\)/,
  /(?<![.\w])fetch\s*\(/,
  // OS-level
  /(?<!\w)cluster(?=\s|[^a-zA-Z0-9_$])/,  
  /(?<!\w)worker_threads(?=\s|[^a-zA-Z0-9_$])/,  
  // Environment / secrets
  /(?<!\w)process\.env/,
  /(?<!\w)ENCRYPTION_PASSPHRASE/,
  /(?<!\w)MICROSOFT_EMAIL/,
  /(?<!\w)MICROSOFT_PASSWORD/,
  /(?<!\w)API_KEY/,
  // Anti-bypass: catch require indirection patterns
   /\[\s*['"](?:re|req|require)['"]\s*\]/,
  /(?:atob|btoa)\s*\(/,
  /String\.fromCharCode/,
  /\\u[0-9a-fA-F]{4}/,
];

// ─── Files that are ABSOLUTELY never patchable (even with SELF_HEAL_ALLOW_ALL) ───
const IMMUTABLE_FILES: ReadonlySet<string> = new Set([
  'config.js', 'config.ts',
  'database.js', 'database.ts',
  'agent.js', 'agent.ts',
  'error-handler.js', 'error-handler.ts',
  'container.js', 'container.ts',
  'sandbox-executor.js', 'sandbox-executor.ts',
  'errors.js', 'errors.ts',
]);

// ─── Files that are patchable only with explicit approval ───
const RESTRICTED_FILES: ReadonlySet<string> = new Set([
  'self-heal.js', 'self-heal.ts',
  'self-heal-auditor.js', 'self-heal-auditor.ts',
  'self-heal-gitops.js', 'self-heal-gitops.ts',
  'critical-patch-consensus.js', 'critical-patch-consensus.ts',
  'browser.js', 'browser.ts',
  'state-machine.js', 'state-machine.ts',
  'auth-auth-manager.js', 'auth-auth-manager.ts',
  'providers-registry.js', 'providers-registry.ts',
  'providers-tribunal.js', 'providers-tribunal.ts',
  'providers-vision-pipeline.js', 'providers-vision-pipeline.ts',
  'cycle-cycle-manager.js', 'cycle-cycle-manager.ts',
  'cycle-orchestrator.js', 'cycle-orchestrator.ts',
  'logger.js', 'logger.ts',
  'alerting.js', 'alerting.ts',
  'jwt.js', 'jwt.ts',
]);

// ─── Allowed prefixes for unrestricted patching ───
// BUG FIX (2026-09-04): Added missing prefixes that were causing valid
// self-heal patches to be blocked. The old list was missing:
//   - 'longevity-' — longevity-ui-recovery.ts, longevity-*.ts
//   - 'pixel-' — pixel-fallback.ts, pixel-calibration.ts, pixel-explorer.ts
//   - 'flutter-' — flutter-stability-waiter.ts, flutter-gesture-simulator.ts, etc.
//   - 'services-' — services-action-cache.ts, services-pix2tex.ts, etc.
//   - 'policy-' — policy-state-guard.ts, policy-action-validator.ts
//   - 'auth-' — auth-strategies-*.ts, auth-captcha-loop-guard.ts
//   - 'progress-' — progress-tracker.ts, progress-circular-path-detector.ts
//   - 'network-' — network-ip-rotator.ts
//   - 'monitoring-' — monitoring-anomaly-detector.ts, monitoring-health-check.ts
//   - 'survival-' — survival-heartbeat-beacon.ts, survival-restart-guardian.ts
//   - 'render-' — render-free-plan.ts, render-cold-start.ts
//   - 'self-heal-' — self-heal-clean-room-test.ts, self-heal-blackbox-replay.ts
//     (NOTE: self-heal.ts itself is in RESTRICTED_FILES — only submodules are allowed)
const ALLOWED_PREFIXES: readonly string[] = [
  'selectors-',
  'providers-detection-',
  'cycle-',
  'utils-',
  'test-',
  'plugins-',
  'planning-',
  'exploration-',
  'longevity-',
  'pixel-',
  'flutter-',
  'services-',
  'policy-',
  'auth-',
  'progress-',
  'network-',
  'monitoring-',
  'survival-',
  'render-',
  'self-heal-',  // submodules only (self-heal.ts is in RESTRICTED_FILES)
  'brute-force-',
  'browser-',
  'container-',
  'state-',
  'error-',
  'config-',
  'cache-',
  'alerting-',
  'logger-',
  'watchdog-',
  'failsafe-',
];

// ─── Type Definitions ───
interface AuditResult {
  safe: boolean;
  violations: string[];
}

interface PatchabilityResult {
  allowed: boolean;
  reason?: string;
  requiresApproval: boolean;
}

interface SandboxResult {
  safe: boolean;
  error?: string;
  violations?: string[];
  requiresApproval?: boolean;
}

/**
 * Extract the relative filename from either an absolute or relative path.
 * Callers pass both forms:
 *   - self-heal.ts: path.join(SOURCE_DIR, file) → absolute e.g. '/app/cycle-ui-prompt-updater.ts'
 *   - critical-patch-consensus.ts: path.join(SOURCE_DIR, targetFile) → absolute
 *   - meta-learner-suggestion-applier.ts: path.join(SOURCE_DIR, file) → absolute
 *   - test-validation-suite.js: '/tmp/test.js' → absolute (outside SOURCE_DIR, basename only)
 *   - self-heal-meta-self-test.ts: '/tmp/self-heal-test-dummy.js' → absolute (dummy, for testing)
 *
 * P14 fix: Previously isPatchableFile only stripped './' prefix, so absolute paths
 * like '/app/cycle-ui-prompt-updater.ts' never matched ALLOWED_PREFIXES —
 * silently rejecting all valid patches to cycle-*, utils-*, etc.
 */
function extractRelativeName(filePath: string): string {
  // If absolute and under SOURCE_DIR, strip the prefix to get relative name
  if (path.isAbsolute(filePath)) {
    const normalized = path.normalize(filePath).replace(/\\/g, '/');
    const root = SOURCE_DIR.replace(/\\/g, '/');
    if (normalized === root) return '';
    if (normalized.startsWith(root + '/')) return normalized.slice(root.length + 1);
    // Absolute path outside SOURCE_DIR — return basename for IMMUTABLE/RESTRICTED checks
    return path.basename(filePath);
  }
  // Relative path — just normalize
  return filePath.replace(/\\/g, '/').replace(/^\.\/?/, '');
}

/**
 * Check whether a patch string contains dangerous patterns.
 * P14: Resets regex lastIndex for safety with stateful patterns.
 *
 * Context-aware (P15): patterns that already exist in the ORIGINAL file
 * are not flagged. This prevents false positives when patching CommonJS files
 * (module.exports, exports.foo) or files that already use require() internally.
 * Only NEW introductions of dangerous patterns are blocked.
 */
function auditPatchContent(patchCode: string, originalContent?: string): AuditResult {
  const violations: string[] = [];
  // Strip comments before pattern matching
  const codeWithoutComments = patchCode
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  // Build set of patterns already present in the original file
  const originalStripped = originalContent
    ? originalContent
        .replace(/\/\/.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/<!--[\s\S]*?-->/g, '')
    : '';

  for (const pattern of BLOCKED_PATTERNS) {
    pattern.lastIndex = 0; // Reset for stateful regexes (defensive)
    if (pattern.test(codeWithoutComments)) {
      // If the original file already contains this pattern, it's not NEW — skip
      if (originalStripped) {
        pattern.lastIndex = 0;
        if (pattern.test(originalStripped)) continue;
      }
      violations.push(`Blocked pattern: ${pattern.source}`);
    }
  }
  return { safe: violations.length === 0, violations };
}

/**
 * Determine if a file is allowed to be patched.
 * Accepts both absolute and relative paths (P14 fix).
 */
function isPatchableFile(filePath: string, opts: { requireApproval?: boolean } = {}): PatchabilityResult {
  const relativeName = extractRelativeName(filePath);

  // Absolute immutables — never patchable
  if (IMMUTABLE_FILES.has(relativeName) || IMMUTABLE_FILES.has(path.basename(relativeName))) {
    return { allowed: false, reason: `File ${relativeName} is in the immutable list and can never be patched`, requiresApproval: false };
  }

  // Check if restricted (BEFORE prefix — restricted takes priority)
  const isRestricted = RESTRICTED_FILES.has(relativeName) || RESTRICTED_FILES.has(path.basename(relativeName));
  if (isRestricted) {
    if (opts.requireApproval) {
      return { allowed: true, requiresApproval: true, reason: `File ${relativeName} requires explicit approval for patching` };
    }
    return { allowed: false, reason: `File ${relativeName} is restricted and requires explicit approval`, requiresApproval: true };
  }

  // Check if it matches an allowed prefix (unrestricted)
  const prefixAllowed = ALLOWED_PREFIXES.some(p => relativeName.startsWith(p));
  if (prefixAllowed) {
    return { allowed: true, requiresApproval: false };
  }

  // Default: not allowed
  return { allowed: false, reason: `File ${relativeName} is not in any allowed patching scope`, requiresApproval: false };
}

/**
 * @deprecated Use executePatchInIsolatedProcess instead.
 * Kept for backward compatibility but no longer used internally.
 */
// @ts-expect-error
function createSandboxContext(): vm.Context {
  const context: Record<string, unknown> = { console: { log: () => {}, warn: () => {}, error: () => {} } };
  for (const mod of ALLOWED_MODULES) {
    try {
      context[mod] = require(mod);
    } catch {
      // Module not available — skip
    }
  }
  return vm.createContext(context);
}

/**
 * @deprecated Use executePatchInIsolatedProcess instead.
 */
function runPatchInSandbox(patchCode: string, timeoutMs = 5000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const context = createSandboxContext();
    const script = new vm.Script(patchCode, {
      filename: 'patch.js',
      timeout: timeoutMs,
    });
    const timer = setTimeout(() => {
      reject(new Error('Sandbox execution timed out — possible infinite loop'));
    }, timeoutMs);
    try {
      const result = script.runInContext(context, {
        timeout: timeoutMs,
        displayErrors: true,
      });
      clearTimeout(timer);
      resolve(result);
    } catch (err: any) {
      clearTimeout(timer);
      reject(err);
    }
  });
}

// ─── Isolated process sandbox (C2 fix: true process isolation) ───

/**
 * Path to the sandbox worker script. Generated once on first use.
 * The worker runs in a completely separate process with no access to
 * the host application's state, memory, or module cache.
 */
let _workerScriptPath: string | null = null;

function getWorkerScriptPath(): string {
  if (_workerScriptPath && fs.existsSync(_workerScriptPath)) return _workerScriptPath;

  // Generate a minimal worker script that receives patch code via IPC,
  // validates it, and reports back — all in a separate process.
  //
  // P14 fix: The worker is written to os.tmpdir() and forked from there.
  // It MUST NOT require('./project-root') because that would look for
  // /tmp/project-root.js which doesn't exist, crashing the worker on startup
  // before it can send the READY message or process any VALIDATE_PATCH messages.
  // This was a critical bug — the isolated process sandbox was completely broken
  // on every deployment where the worker ran from /tmp/.
  //
  // P14 fix: tsc now uses execFileSync with args array instead of execSync with
  // a concatenated command string. This closes a shell injection vector where
  // filePath containing quotes or semicolons could execute arbitrary commands.

  const workerCode = `
'use strict';
// sandbox-isolation-worker.js
// This script runs in a FORKED child process with true process isolation.
// It has NO access to the parent's require cache, globals, or state.
// P14: Does NOT require('./project-root') — worker lives in /tmp/ where that module
// doesn't exist. Only uses Node.js built-in modules.

const { execFileSync } = require('child_process');
const vm = require('vm');
const path = require('path');
const os = require('os');
const fs = require('fs');

process.on('message', (msg) => {
  if (!msg || msg.type !== 'VALIDATE_PATCH') {
    process.send({ type: 'RESULT', success: false, error: 'Invalid message type' });
    return;
  }

  const { patchCode, filePath, timeout } = msg;
  const startTime = Date.now();

  try {
    // Step 1: Syntax check via vm.Script (does not execute)
    new vm.Script(patchCode, { filename: filePath || 'patch.js', timeout: 3000 });

    // Step 2: For TypeScript files, also try tsc --noEmit if available
    // P14 fix: Uses execFileSync instead of execSync to avoid shell interpretation,
    // and passes tmpPath as a separate argument (not concatenated into command string).
    if (filePath && (filePath.endsWith('.ts') || filePath.endsWith('.tsx'))) {
      try {
        const tmpPath = path.join(os.tmpdir(), 'sandbox-verify-' + Date.now() + '.ts');
        fs.writeFileSync(tmpPath, patchCode, 'utf8');
        try {
          // execFileSync with args array — no shell, no injection possible
          execFileSync('npx', [
            'tsc', '--noEmit', '--allowJs', '--skipLibCheck',
            '--esModuleInterop', '--target', 'ES2020',
            '--moduleResolution', 'node', tmpPath
          ], {
            timeout: 15000,
            stdio: 'pipe',
            env: { ...process.env, NODE_ENV: 'sandbox-verify' }
          });
        } finally {
          try { fs.unlinkSync(tmpPath); } catch (e) { /* ignore */ }
        }
      } catch (tscErr) {
        const errMsg = ((tscErr.stderr && tscErr.stderr.toString()) ||
                       (tscErr.message || '')).slice(0, 500);
        process.send({
          type: 'RESULT',
          success: false,
          error: 'TypeScript compilation check failed: ' + errMsg,
          durationMs: Date.now() - startTime
        });
        return;
      }
    }

    // Step 3: Runtime behavior check — execute in a strict vm context
    // with NO access to require, process, fs, etc.
    const isolatedContext = vm.createContext({
      console: { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} },
      Math: Math,
      JSON: JSON,
      Date: Date,
      Array: Array,
      Object: Object,
      String: String,
      Number: Number,
      Boolean: Boolean,
      RegExp: RegExp,
      Map: Map,
      Set: Set,
      Error: Error,
      TypeError: TypeError,
      RangeError: RangeError,
      SyntaxError: SyntaxError,
    });

    const script = new vm.Script(patchCode, {
      filename: filePath || 'patch.js',
      timeout: timeout || 5000,
    });

    // Execute in the isolated context — if this throws, the patch has
    // runtime side effects that would have affected the host.
    script.runInContext(isolatedContext, {
      timeout: timeout || 5000,
      displayErrors: true,
    });

    process.send({
      type: 'RESULT',
      success: true,
      durationMs: Date.now() - startTime
    });
  } catch (err) {
    process.send({
      type: 'RESULT',
      success: false,
      error: (err && err.message) || String(err),
      durationMs: Date.now() - startTime
    });
  }
});

// Signal readiness
process.send({ type: 'READY' });
`;

  // Write the worker script to a secure temp location
  // P14: Use 0o600 (rw-------) — no execute bit needed since fork() uses Node.js directly
  const workerPath = path.join(os.tmpdir(), 'mathu-sandbox-worker-' + process.pid + '.js');
  fs.writeFileSync(workerPath, workerCode, 'utf8');
  fs.chmodSync(workerPath, 0o600);
  _workerScriptPath = workerPath;
  return workerPath;
}

/**
 * Execute a patch in a truly isolated child process.
 * Unlike vm.runInContext(), this provides PROCESS-LEVEL isolation:
 * - Separate memory space
 * - Separate module cache (no access to host's require'd modules)
 * - Separate globals (process, global, etc. are all fresh)
 * - Hard timeout kills the entire process
 * - --disallow-code-generation-from-strings prevents eval/Function escapes
 *
 * @param patchCode - The patch source code to validate
 * @param filePath - Target file path (for .ts files, also runs tsc --noEmit)
 * @param timeoutMs - Maximum execution time (default 15000ms)
 */
function executePatchInIsolatedProcess(patchCode: string, filePath: string, timeoutMs = 15000): Promise<{ success: boolean; error?: string; durationMs: number }> {
  return new Promise((resolve) => {
    const workerScript = getWorkerScriptPath();
    const hardTimeout = setTimeout(() => {
      _log(`Sandbox: Isolated process timed out after ${timeoutMs}ms for ${filePath}`, 'ERROR', 'sandbox-executor');
      resolve({ success: false, error: `Isolated process timed out after ${timeoutMs}ms`, durationMs: timeoutMs });
    }, timeoutMs + 5000); // extra 5s grace for process startup/shutdown

    try {
      const child = fork(workerScript, [], {
        stdio: 'pipe',
        env: {
          ...process.env,
          NODE_OPTIONS: '--disallow-code-generation-from-strings',
          NODE_ENV: 'sandbox-verify',
        },
        execArgv: ['--disallow-code-generation-from-strings'],
        timeout: timeoutMs,
      });

      let settled = false;

      const cleanup = (result: { success: boolean; error?: string; durationMs: number }) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimeout);
        try { child.kill('SIGKILL'); } catch (e: any) { /* already dead */ }
        resolve(result);
      };

      child.on('message', (msg: any) => {
        if (msg && msg.type === 'RESULT') {
          if (msg.success) {
            _log(`Sandbox: Isolated process validation PASSED for ${filePath} (${msg.durationMs}ms)`, 'INFO', 'sandbox-executor');
          } else {
            _log(`Sandbox: Isolated process validation FAILED for ${filePath}: ${msg.error}`, 'ERROR', 'sandbox-executor');
          }
          cleanup({ success: msg.success, error: msg.error, durationMs: msg.durationMs });
        }
      });

      child.on('error', (err: Error) => {
        _log(`Sandbox: Isolated process error for ${filePath}: ${err.message}`, 'ERROR', 'sandbox-executor');
        cleanup({ success: false, error: `Process error: ${err.message}`, durationMs: 0 });
      });

      child.on('exit', (code: number | null, signal: string | null) => {
        if (!settled) {
          const reason = signal ? `killed by signal ${signal}` : `exited with code ${code}`;
          _log(`Sandbox: Isolated process exited unexpectedly for ${filePath}: ${reason}`, 'WARN', 'sandbox-executor');
          cleanup({ success: false, error: `Process ${reason}`, durationMs: 0 });
        }
      });

      // Send the patch to the worker (after a small delay to ensure READY message could be sent)
      setTimeout(() => {
        if (!settled) {
          try {
            child.send({
              type: 'VALIDATE_PATCH',
              patchCode,
              filePath: filePath || 'patch.js',
              timeout: timeoutMs,
            });
          } catch (sendErr: any) {
            cleanup({ success: false, error: `Failed to send to worker: ${sendErr.message}`, durationMs: 0 });
          }
        }
      }, 100);

    } catch (forkErr: any) {
      clearTimeout(hardTimeout);
      _log(`Sandbox: Failed to fork isolated process for ${filePath}: ${forkErr.message}`, 'ERROR', 'sandbox-executor');
      resolve({ success: false, error: `Fork failed: ${forkErr.message}`, durationMs: 0 });
    }
  });
}

/**
 * Execute a patch in the sandbox with full security checks.
 *
 * Security layers:
 *  1. File-level check (isPatchableFile) — P14: now handles absolute paths
 *  2. Content-level check (auditPatchContent)
 *  3. Path traversal check — P14: handles both absolute and relative filePath
 *  4. Syntax validation via vm.Script (does NOT execute)
 *  5. Size limit check
 *  6. Runtime validation in isolated child process (true process isolation)
 *  7. No file writes — caller is responsible for writing after all checks pass
 */
async function executePatchInSandbox(patchText: string, filePath: string): Promise<SandboxResult> {
  // Layer 1: File-level check (P14: works with absolute paths now)
  const fileCheck = isPatchableFile(filePath);
  if (!fileCheck.allowed) {
    _log(`Sandbox: File not patchable: ${filePath} — ${fileCheck.reason}`, 'ERROR', 'sandbox-executor');
    return { safe: false, error: fileCheck.reason, requiresApproval: fileCheck.requiresApproval };
  }

  // Layer 2: Content-level audit (context-aware: skips patterns already in original file)
  let originalContent: string | undefined;
  try {
    const resolvedForRead = path.isAbsolute(filePath)
      ? path.normalize(filePath)
      : path.resolve(SOURCE_DIR, filePath);
    if (fs.existsSync(resolvedForRead)) {
      originalContent = fs.readFileSync(resolvedForRead, 'utf8');
    }
  } catch { /* original not available — audit without context */ }
  const contentAudit = auditPatchContent(patchText, originalContent);
  if (!contentAudit.safe) {
    _log(`Sandbox: Patch blocked for ${filePath} — ${contentAudit.violations.length} violations`, 'ERROR', 'sandbox-executor');
    return { safe: false, error: `Patch contains ${contentAudit.violations.length} blocked patterns`, violations: contentAudit.violations };
  }

  // Layer 3: Path traversal check
  // P14 fix: Handle both absolute and relative filePath inputs.
  // - If filePath is already absolute: use it directly (callers pass path.join(SOURCE_DIR, file))
  // - If filePath is relative: resolve against SOURCE_DIR
  // Either way, the result must stay within SOURCE_DIR.
  const resolvedTarget = path.isAbsolute(filePath)
    ? path.normalize(filePath)
    : path.resolve(SOURCE_DIR, filePath);
  const normalizedRoot = path.normalize(SOURCE_DIR);
  if (!resolvedTarget.startsWith(normalizedRoot + path.sep) && resolvedTarget !== normalizedRoot) {
    _log(`Sandbox: Path traversal blocked for ${filePath} (resolved: ${resolvedTarget}, root: ${normalizedRoot})`, 'ERROR', 'sandbox-executor');
    return { safe: false, error: `Path traversal blocked: ${filePath}` };
  }

  // Layer 4: Syntax validation using vm.Script (does NOT execute)
  try {
    new vm.Script(patchText, { filename: path.basename(filePath), timeout: 3000 });
  } catch (e: any) {
    _log(`Sandbox: Syntax validation failed for ${filePath}: ${e.message}`, 'ERROR', 'sandbox-executor');
    return { safe: false, error: `Patch syntax validation failed: ${e.message}` };
  }
  _log(`Sandbox: Syntax validation passed for ${filePath}`, 'INFO', 'sandbox-executor');

  // Layer 5: Size limit (prevent oversized patches)
  const MAX_PATCH_SIZE_BYTES = 50 * 1024; // 50KB
  if (Buffer.byteLength(patchText, 'utf8') > MAX_PATCH_SIZE_BYTES) {
    return { safe: false, error: `Patch exceeds maximum size (${MAX_PATCH_SIZE_BYTES / 1024}KB)` };
  }

  // Layer 6: Runtime validation in an isolated child process (C2 fix)
  // This provides TRUE process isolation — the patch cannot access
  // the host application's state, memory, module cache, or globals.
  _log(`Sandbox: Running isolated process validation for ${filePath}...`, 'INFO', 'sandbox-executor');
  const isolatedResult = await executePatchInIsolatedProcess(patchText, filePath);
  if (!isolatedResult.success) {
    _log(`Sandbox: Isolated process validation FAILED for ${filePath}: ${isolatedResult.error}`, 'ERROR', 'sandbox-executor');
    return { safe: false, error: `Isolated process validation failed: ${isolatedResult.error}` };
  }
  _log(`Sandbox: Isolated process validation PASSED for ${filePath} (${isolatedResult.durationMs}ms)`, 'INFO', 'sandbox-executor');

  // All checks passed — the patch is safe to apply.
  // NOTE: The caller (self-heal.js) is responsible for the actual file write.
  // This function NO LONGER writes files — separation of concerns for security.
  _log(`Sandbox: Patch for ${filePath} passed all security checks`, 'INFO', 'sandbox-executor');
  return { safe: true, requiresApproval: fileCheck.requiresApproval };
}

// @ts-expect-error
module.exports = {
  vm, path, SOURCE_DIR,
  ALLOWED_MODULES, BLOCKED_PATTERNS, IMMUTABLE_FILES, RESTRICTED_FILES, ALLOWED_PREFIXES,
  auditPatchContent, isPatchableFile, extractRelativeName,
  createSandboxContext, runPatchInSandbox,
  executePatchInIsolatedProcess, executePatchInSandbox,
  _injectDependencies,
};
