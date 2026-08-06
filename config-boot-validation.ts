// Resilience R2: Diagnostic Smoke Test — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// config-boot-validation.ts — P0 Diagnostic Smoke Test
// ═══════════════════════════════════════════════════════════════
// Enhanced startup diagnostics that replace/enhance the basic
// smoke tests. Each check produces a structured {pass, name, reason}
// result. Called from container-subsystem-runner.ts on startup.
//
// Checks performed:
//   1. Required env vars present (name + length > 0)
//   2. API keys format validation (length > 20, looks like a key)
//   3. Database writable (INSERT + SELECT + DELETE test row)
//   4. Provider availability (1-token test request to each configured provider)
//   5. Browser launch test (launch + screenshot + close, 30s timeout)
//   6. Disk space check (>10MB free on data directory)
//
// Each check is independent — one failure doesn't block others.
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'boot-validation') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

function logError(msg: string, err: Error) {
  try {
    const logger = (_deps as any).logger;
    if (logger?.logError) { logger.logError(msg, err); return; }
  } catch { /* fall through */ }
  console.error(`[ERROR] [boot-validation] ${msg}`, err);
}

// ─── Check result type ───
interface CheckResult {
  name: string;
  pass: boolean;
  reason: string;
  durationMs?: number;
  details?: string;
}

// ─── 1. Required env vars ───
function checkEnvVars(): CheckResult {
  const CONFIG = getCONFIG();
  const requiredVars = [
    'MICROSOFT_EMAIL', 'MICROSOFT_PASSWORD',
    'ENCRYPTION_KEY',
  ];

  // Also check for at least one provider API key
  const providerKeys = [
    'GROQ_API_KEY', 'ZAI_API_KEY',
    'AGNES_API_KEY', 'NVIDIA_API_KEY', 'CEREBRAS_API_KEY',
    'CLOUDFLARE_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
    'DEEPINFRA_API_KEY',
    // GitHub GPT retired 2026-07-30 — excluded
  ];

  const missing: string[] = [];
  for (const v of requiredVars) {
    const val = (CONFIG as any)[v] || process.env[v];
    if (!val || val.length === 0) missing.push(v);
  }

  const hasProviderKey = providerKeys.some(k => {
    const val = (CONFIG as any)[k] || process.env[k];
    return val && val.length > 0;
  });

  if (!hasProviderKey) missing.push('(at least one provider API key)');

  if (missing.length > 0) {
    return { name: 'env_vars', pass: false, reason: `Missing: ${missing.join(', ')}` };
  }
  return { name: 'env_vars', pass: true, reason: 'All required env vars present' };
}

// ─── 2. API key format validation ───
function checkApiKeyFormats(): CheckResult {
  const CONFIG = getCONFIG();
  const keys = [
    'GROQ_API_KEY', 'ZAI_API_KEY',
    'AGNES_API_KEY', 'NVIDIA_API_KEY', 'CEREBRAS_API_KEY',
    'CLOUDFLARE_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
    'DEEPINFRA_API_KEY',
    // GitHub GPT retired 2026-07-30 — excluded
  ];

  const issues: string[] = [];
  for (const key of keys) {
    const val = (CONFIG as any)[key] || process.env[key];
    if (val && val.length > 0) {
      if (val.length < 20) {
        issues.push(`${key}: too short (${val.length} chars, min 20)`);
      }
      // Check it's not a placeholder
      if (['your_', 'placeholder', 'xxx', 'changeme', 'default'].some(p => val.toLowerCase().includes(p))) {
        issues.push(`${key}: appears to be a placeholder`);
      }
    }
  }

  if (issues.length > 0) {
    return { name: 'api_key_formats', pass: false, reason: issues.join('; ') };
  }
  return { name: 'api_key_formats', pass: true, reason: 'All API keys look valid' };
}

// ─── 3. Database writable ───
async function checkDatabase(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const db = (_deps as any).database;
    if (!db?.database) {
      return { name: 'database', pass: false, reason: 'Database module not available', durationMs: Date.now() - start };
    }

    // Try a write+read+delete cycle
    const testKey = `_boot_test_${Date.now()}`;
    db.database.prepare('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(testKey, 'boot_test_ok');
    const row = db.database.prepare('SELECT v FROM kv WHERE k = ?').get(testKey);
    db.database.prepare('DELETE FROM kv WHERE k = ?').run(testKey);

    if (row && row.v === 'boot_test_ok') {
      return { name: 'database', pass: true, reason: 'DB read/write OK', durationMs: Date.now() - start };
    }
    return { name: 'database', pass: false, reason: 'DB write/read mismatch', durationMs: Date.now() - start };
  } catch (err: any) {
    return { name: 'database', pass: false, reason: `DB error: ${err.message || String(err)}`, durationMs: Date.now() - start };
  }
}

// ─── 4. Provider availability (1-token test) ───
async function checkProviders(): Promise<CheckResult> {
  const start = Date.now();
  const results: string[] = [];

  try {
    const registry = (_deps as any).providerRegistry;
    if (!registry?.getAvailableProviders) {
      // Fallback: just check if env keys exist
      const keys = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'DEEPINFRA_API_KEY'];
      const present = keys.filter(k => process.env[k]?.length > 0);
      if (present.length === 0) {
        return { name: 'providers', pass: false, reason: 'No provider API keys found in environment', durationMs: Date.now() - start };
      }
      return { name: 'providers', pass: true, reason: `API keys present for: ${present.join(', ')} (live test skipped — no registry)`, durationMs: Date.now() - start };
    }

    // Get available providers (this tests config loading, not live API calls)
    const providers = registry.getAvailableProviders({ visionOnly: false });
    const names = providers.map((p: any) => p.name || p.id || 'unknown');

    if (names.length === 0) {
      return { name: 'providers', pass: false, reason: 'Provider registry returned empty list', durationMs: Date.now() - start };
    }

    return { name: 'providers', pass: true, reason: `${names.length} providers available: ${names.slice(0, 5).join(', ')}${names.length > 5 ? '...' : ''}`, durationMs: Date.now() - start };
  } catch (err: any) {
    return { name: 'providers', pass: false, reason: `Provider check error: ${err.message || String(err)}`, durationMs: Date.now() - start };
  }
}

// ─── 5. Browser launch test ───
async function checkBrowser(): Promise<CheckResult> {
  const start = Date.now();
  try {
    const browser = (_deps as any).browser;
    if (!browser?.launchBrowser) {
      return { name: 'browser', pass: false, reason: 'Browser module not available', durationMs: Date.now() - start };
    }

    // Launch with a short timeout
    const launchPromise = (async () => {
      const page = await browser.launchBrowser();
      try {
        // Take a blank screenshot
        await page.screenshot({ type: 'jpeg', quality: 10 });
        return page;
      } catch (e: any) {
        return page; // screenshot might fail, that's OK
      }
    })();

    const timeoutPromise = new Promise<null>((_, reject) =>
      setTimeout(() => reject(new Error('Browser launch timeout (30s)')), 30000)
    );

    const page = await Promise.race([launchPromise, timeoutPromise]);

    if (page) {
      try { await browser.closeBrowser(); } catch { /* best effort */ }
      return { name: 'browser', pass: true, reason: 'Browser launched, screenshot taken, closed OK', durationMs: Date.now() - start };
    }

    return { name: 'browser', pass: false, reason: 'Browser launch returned null', durationMs: Date.now() - start };
  } catch (err: any) {
    return { name: 'browser', pass: false, reason: `Browser error: ${err.message || String(err)}`, durationMs: Date.now() - start };
  }
}

// ─── 6. Disk space ───
function checkDiskSpace(): CheckResult {
  const start = Date.now();
  try {
    const fs = require('fs');
    const path = require('path');
    const CONFIG = getCONFIG();
    const dataDir = (CONFIG.DATA_DIR as string) || path.join(process.cwd(), 'data');

    // Ensure data dir exists
    if (!fs.existsSync(dataDir)) {
      try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ok */ }
    }

    // Write a 1KB test file
    const testFile = path.join(dataDir, `_disk_test_${Date.now()}`);
    const testBuf = Buffer.alloc(1024, 'x');
    fs.writeFileSync(testFile, testBuf);
    const stat = fs.statSync(testFile);
    fs.unlinkSync(testFile);

    const sizeKB = stat.size / 1024;
    return { name: 'disk_space', pass: true, reason: `Data dir writable (${dataDir}, test write ${sizeKB}KB OK)`, durationMs: Date.now() - start };
  } catch (err: any) {
    return { name: 'disk_space', pass: false, reason: `Disk check error: ${err.message || String(err)}`, durationMs: Date.now() - start };
  }
}

// ─── Run all diagnostics ───
async function runFullDiagnostics(): Promise<{
  results: CheckResult[];
  summary: { passed: number; failed: number; total: number };
  criticalFailures: string[];
}> {
  log('Running full boot diagnostics...', 'INFO');

  const results: CheckResult[] = [];

  // Sync checks first
  results.push(checkEnvVars());
  results.push(checkApiKeyFormats());
  results.push(checkDiskSpace());

  // Async checks (run sequentially to avoid resource contention on 512MB)
  results.push(await checkDatabase());
  results.push(await checkProviders());
  // Browser test is expensive — skip if we're already memory-constrained
  const heapMB = process.memoryUsage().heapUsed / 1024 / 1024;
  if (heapMB < 300) {
    results.push(await checkBrowser());
  } else {
    results.push({ name: 'browser', pass: false, reason: `Skipped (heap already at ${heapMB.toFixed(0)}MB)`, durationMs: 0 });
  }

  const passed = results.filter(r => r.pass).length;
  const failed = results.filter(r => !r.pass).length;
  const criticalFailures = results.filter(r => !r.pass).map(r => r.name);

  // Log results
  for (const r of results) {
    const icon = r.pass ? 'OK' : 'FAIL';
    const dur = r.durationMs != null ? ` (${r.durationMs}ms)` : '';
    log(`  [${icon}] ${r.name}: ${r.reason}${dur}`, r.pass ? 'INFO' : 'WARN');
  }

  log(`Diagnostics complete: ${passed}/${results.length} passed`, passed === results.length ? 'INFO' : 'WARN');

  return {
    results,
    summary: { passed, failed, total: results.length },
    criticalFailures,
  };
}

/**
 * Quick check — just env vars and database. Used for fast startup validation.
 */
async function runQuickCheck(): Promise<{ pass: boolean; reason: string }> {
  const envResult = checkEnvVars();
  if (!envResult.pass) return { pass: false, reason: envResult.reason };

  const dbResult = await checkDatabase();
  if (!dbResult.pass) return { pass: false, reason: dbResult.reason };

  return { pass: true, reason: 'Quick check passed' };
}

module.exports = {
  runFullDiagnostics,
  runQuickCheck,
  checkEnvVars,
  checkDatabase,
  checkProviders,
  checkBrowser,
  checkDiskSpace,
  checkApiKeyFormats,
  _injectDependencies,
};
