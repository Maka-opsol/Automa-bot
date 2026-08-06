// Resilience R3a: Env Var Drift Detection — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// config-drift-detector.ts — Detect env var changes across restarts
// ═══════════════════════════════════════════════════════════════
// On every startup, hash critical env vars (name+length, NOT values)
// and compare against stored hash. If changed: log which vars
// changed and optionally halt startup.
//
// Also validates API key format on startup.
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'drift-detector') {
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
  console.error(`[ERROR] [drift-detector] ${msg}`, err);
}

// Critical env vars to track (names only, not values)
// GitHub GPT retired 2026-07-30 — excluded to avoid false drift alerts
const TRACKED_VARS = [
  'MICROSOFT_EMAIL',
  'GROQ_API_KEY', 'ZAI_API_KEY',
  'AGNES_API_KEY', 'NVIDIA_API_KEY', 'CEREBRAS_API_KEY',
  'CLOUDFLARE_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY',
  'DEEPINFRA_API_KEY',
  'ENCRYPTION_KEY',
  'RENDER', 'NODE_ENV',
];

interface DriftReport {
  changed: string[];
  added: string[];
  removed: string[];
  hash: string;
  drifted: boolean;
}

/**
 * Compute a SHA-256 hash of env var names + their value lengths.
 * We don't hash values themselves to avoid leaking secrets to logs.
 */
function computeEnvHash(): { hash: string; varMap: Record<string, number> } {
  const crypto = require('crypto');
  const varMap: Record<string, number> = {};

  for (const varName of TRACKED_VARS) {
    const val = process.env[varName] || '';
    varMap[varName] = val.length;
  }

  // Hash: sorted key=value_length pairs
  const sorted = Object.entries(varMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const hash = crypto.createHash('sha256').update(sorted).digest('hex');
  return { hash, varMap };
}

/**
 * Get the stored hash from the database.
 */
function getStoredHash(): string | null {
  try {
    const db = (_deps as any).database;
    if (!db?.database) return null;
    const row = db.database.prepare("SELECT v FROM kv WHERE k = 'env_var_hash'").get();
    return row ? row.v : null;
  } catch {
    return null;
  }
}

/**
 * Store the current hash in the database.
 */
function storeHash(hash: string, varMap: Record<string, number>): void {
  try {
    const db = (_deps as any).database;
    if (!db?.database) return;
    db.database.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('env_var_hash', ?)").run(hash);
    // Also store the var map for diff computation
    db.database.prepare("INSERT OR REPLACE INTO kv (k, v) VALUES ('env_var_map', ?)").run(JSON.stringify(varMap));
  } catch (e: any) {
    logError('Failed to store env hash', e);
  }
}

/**
 * Load the previous var map from database.
 */
function getStoredVarMap(): Record<string, number> | null {
  try {
    const db = (_deps as any).database;
    if (!db?.database) return null;
    const row = db.database.prepare("SELECT v FROM kv WHERE k = 'env_var_map'").get();
    if (!row) return null;
    return JSON.parse(row.v);
  } catch {
    return null;
  }
}

/**
 * Run drift detection. Returns a report of changes.
 * Should be called once at startup.
 */
function detectDrift(): DriftReport {
  const { hash, varMap } = computeEnvHash();
  const storedHash = getStoredHash();

  if (!storedHash) {
    log('First run — storing env hash baseline', 'INFO');
    storeHash(hash, varMap);
    return { changed: [], added: [], removed: [], hash, drifted: false };
  }

  if (hash === storedHash) {
    log('No env var drift detected', 'INFO');
    return { changed: [], added: [], removed: [], hash, drifted: false };
  }

  // Drift detected — compute diff
  const storedMap = getStoredVarMap() || {};
  const changed: string[] = [];
  const added: string[] = [];
  const removed: string[] = [];

  for (const key of Object.keys(varMap)) {
    if (!(key in storedMap)) {
      added.push(key);
    } else if (varMap[key] !== storedMap[key]) {
      changed.push(`${key} (length ${storedMap[key]} → ${varMap[key]})`);
    }
  }
  for (const key of Object.keys(storedMap)) {
    if (!(key in varMap)) {
      removed.push(key);
    }
  }

  log(`ENV DRIFT DETECTED: changed=[${changed.join(', ')}] added=[${added.join(', ')}] removed=[${removed.join(', ')}]`, 'WARN');

  // Try to send alert
  try {
    const alerting = (_deps as any).alerting;
    if (alerting?.sendAlert) {
      alerting.sendAlert(`Config drift detected: ${changed.length} changed, ${added.length} added, ${removed.length} removed`);
    }
  } catch { /* non-critical */ }

  // Update stored hash
  storeHash(hash, varMap);

  return { changed, added, removed, hash, drifted: true };
}

/**
 * Validate API key formats at startup.
 */
function validateKeyFormats(): { valid: boolean; issues: string[] } {
  const CONFIG = getCONFIG();
  const issues: string[] = [];

  const keyChecks: [string, number][] = [
    ['GROQ_API_KEY', 20],
    ['ZAI_API_KEY', 20],
    ['GEMINI_API_KEY', 20],
    ['OPENROUTER_API_KEY', 20],
    ['DEEPINFRA_API_KEY', 20],
    // GitHub GPT retired 2026-07-30 — excluded
  ];

  for (const [key, minLen] of keyChecks) {
    const val = (CONFIG as any)[key] || process.env[key];
    if (val && val.length > 0 && val.length < minLen) {
      issues.push(`${key}: too short (${val.length} chars, min ${minLen})`);
    }
    // Check it's not a placeholder
    if (val && val.length > 0 &&
      ['your_', 'placeholder', 'xxx', 'changeme', 'default'].some(p => val.toLowerCase().includes(p))) {
      issues.push(`${key}: appears to be a placeholder`);
    }
  }

  return { valid: issues.length === 0, issues };
}

module.exports = {
  detectDrift,
  validateKeyFormats,
  computeEnvHash,
  _injectDependencies,
};
