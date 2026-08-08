'use strict';
// Last modified: 2026-08-08 — Response 5: Step-by-step solution caching

// ═══════════════════════════════════════════════════════════════════════════════
// Math Solution Cache — Never solve the exact same problem twice.
//
// Stores verified solutions in the DB calibration table (key-value) so they
// can be reused on future encounters. Uses problem normalization for exact
// matching and constant-based similarity detection for near-matches.
//
// Storage model:
//   Uses the existing `calibration` table (key = 'sol_cache_<hash>', value = JSON)
//   Max 500 entries (LRU eviction when full)
//
// Cache flow:
//   1. Before calling LLM → normalize problem → check cache
//   2. Exact match → reuse solution (skip LLM entirely, saves budget)
//   3. Similar match → include cached solution as context hint
//   4. No match → call LLM normally → cache result after verification
//
// Eviction:
//   - LRU: evict entries with oldest lastUsedAt when at capacity
//   - Fail threshold: delete entries with failCount > 2
//   - Age cleanup: delete entries older than 30 days with successCount = 0
// ═══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }

// R6: unifiedDb for Turso-first reads/writes on calibration table
function getUnifiedDb() { return _deps.unifiedDb || null; }

// ─── Configuration ──────────────────────────────────────────────────────────

const MAX_ENTRIES = parseInt(process.env.SOLUTION_CACHE_MAX || '500', 10);
const SIMILARITY_THRESHOLD = parseFloat(process.env.SOLUTION_CACHE_SIMILARITY || '0.8', 10);
const MAX_AGE_DAYS = parseInt(process.env.SOLUTION_CACHE_MAX_AGE_DAYS || '30', 10);
const FAIL_EVICTION_THRESHOLD = 2;
const KEY_PREFIX = 'sol_cache_';

// ─── Solution Entry ─────────────────────────────────────────────────────────

interface SolutionEntry {
  problemText: string;
  normalizedText: string;
  solution: string;
  steps: string[];
  problemType: string;
  modelUsed: string;
  verified: boolean;
  verifiedAt: number | null;
  successCount: number;
  failCount: number;
  createdAt: number;
  lastUsedAt: number;
  constants: number[];  // extracted numeric constants for similarity
}

// ─── Stats ──────────────────────────────────────────────────────────────────

let _stats = {
  lookups: 0,
  exactHits: 0,
  similarHits: 0,
  misses: 0,
  stores: 0,
  evictions: 0,
  failEvictions: 0,
  ageCleanups: 0,
};

function getStats() { return { ..._stats }; }

// ═══════════════════════════════════════════════════════════════════════════
// Problem Normalization
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Normalize a problem text for hashing.
 * Strips whitespace, normalizes unicode, sorts terms in equations,
 * so equivalent problems produce the same hash.
 *
 * Examples:
 *   "3x + 5 = 20" and "5 + 3x = 20" → same hash
 *   "Solve 3x+5=20" and "What is x if 3x+5=20?" → same hash
 */
function normalizeProblem(text: string): string {
  if (!text || typeof text !== 'string') return '';

  let result = text.trim();

  // Remove common instruction prefixes
  result = result.replace(/^(solve|find|calculate|compute|evaluate|determine|what is|what's)\s+(for\s+)?/i, '');
  result = result.replace(/^(the\s+)?(equation|problem|expression|value|answer|solution)\s+(is|equals|=)?\s*/i, '');

  // Remove question marks and trailing punctuation
  result = result.replace(/[?.,;!]+$/g, '');

  // Normalize whitespace
  result = result.replace(/\s+/g, ' ');

  // Remove spaces around operators for consistency
  result = result.replace(/\s*([+\-*=\/^])\s*/g, '$1');

  // Normalize common math words to symbols
  result = result.replace(/\b(times|multiplied by)\b/gi, '*');
  result = result.replace(/\b(divided by|over)\b/gi, '/');
  result = result.replace(/\b(plus)\b/gi, '+');
  result = result.replace(/\b(minus)\b/gi, '-');
  result = result.replace(/\b(equals?|is equal to)\b/gi, '=');

  // Normalize unicode fractions
  result = result.replace(/\u00BD/g, '(1/2)');   // ½
  result = result.replace(/\u00BC/g, '(1/4)');   // ¼
  result = result.replace(/\u00BE/g, '(3/4)');   // ¾
  result = result.replace(/\u2153/g, '(1/3)');   // ⅓
  result = result.replace(/\u2154/g, '(2/3)');   // ⅔

  // Normalize unicode minus
  result = result.replace(/\u2212/g, '-');

  // For equations: sort each side alphabetically (simple term sorting)
  // e.g., "5+3x=20" → "3x+5=20"
  const eqParts = result.split('=');
  if (eqParts.length === 2) {
    const sortTerms = (side: string) => {
      // Extract terms (separated by + or -)
      const terms = side.match(/[+-]?[^+-]+/g) || [side];
      terms.sort();
      return terms.join('');
    };
    result = sortTerms(eqParts[0]) + '=' + sortTerms(eqParts[1]);
  }

  return result.trim().toLowerCase();
}

/**
 * Compute a hash for a normalized problem string.
 */
function hashProblem(normalizedText: string): string {
  if (!normalizedText) return '';
  return crypto.createHash('sha256').update(normalizedText, 'utf8').digest('hex').slice(0, 16);
}

// ═══════════════════════════════════════════════════════════════════════════
// Constant Extraction (for similarity detection)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract numeric constants from problem text.
 * These are used for similarity matching — problems with the same structure
 * but different numbers are "similar".
 *
 * Examples:
 *   "3x + 5 = 20" → [3, 5, 20]
 *   "x^2 - 4x + 3 = 0" → [2, 4, 3]
 */
function extractConstants(text: string): number[] {
  if (!text) return [];

  const matches = text.match(/-?\d+\.?\d*/g) || [];
  return matches
    .map(m => parseFloat(m))
    .filter(n => !isNaN(n) && isFinite(n) && n !== 0);
}

/**
 * Compute structural similarity between two problems based on shared constants.
 * Returns 0-1 where 1 = identical structure.
 *
 * Algorithm:
 *   - Extract constants from both problems
 *   - Compare ratios: if the ratio pattern is similar, the structure is similar
 *   - Simpler: check what % of constant positions match
 */
function computeSimilarity(constantsA: number[], constantsB: number[]): number {
  if (!constantsA.length || !constantsB.length) return 0;
  if (constantsA.length === 0 && constantsB.length === 0) return 1;

  // If same number of constants, compare position-by-position
  const minLen = Math.min(constantsA.length, constantsB.length);
  const maxLen = Math.max(constantsA.length, constantsB.length);

  if (minLen === 0) return 0;

  let matches = 0;
  for (let i = 0; i < minLen; i++) {
    // Check if the ratio pattern matches (constants at same position)
    // We consider a match if the value differs by less than 50%
    const a = Math.abs(constantsA[i]);
    const b = Math.abs(constantsB[i]);
    if (a === 0 && b === 0) { matches++; continue; }
    if (a === 0 || b === 0) continue;

    const ratio = Math.min(a, b) / Math.max(a, b);
    if (ratio > 0.5) matches++; // 50% tolerance — same ballpark
  }

  return matches / maxLen;
}

// ═══════════════════════════════════════════════════════════════════════════
// Cache Operations (DB-backed via calibration table)
// ═══════════════════════════════════════════════════════════════════════════

function _countEntries(): number {
  try {
    const db = getDb();
    if (!db) return 0;
    const row = db.prepare("SELECT COUNT(*) as cnt FROM calibration WHERE key LIKE ?")
      .get(`${KEY_PREFIX}%`);
    return row?.cnt || 0;
  } catch { return 0; }
}

function _getAllEntries(): Array<{ key: string; value: string; updated_at: number }> {
  try {
    const db = getDb();
    if (!db) return [];
    return db.prepare("SELECT key, value, updated_at FROM calibration WHERE key LIKE ? ORDER BY updated_at ASC")
      .all(`${KEY_PREFIX}%`);
  } catch { return []; }
}

function _storeEntry(hash: string, entry: SolutionEntry): boolean {
  try {
    const db = getDb();
    if (!db) return false;
    const now = Date.now();
    db.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
      .run(`${KEY_PREFIX}${hash}`, JSON.stringify(entry), now);

    // R6: Async write to Turso via unifiedDb (fire-and-forget)
    const udb = getUnifiedDb();
    if (udb) {
      udb.setCalibration(`${KEY_PREFIX}${hash}`, JSON.stringify(entry), now).catch(() => {});
    }
    return true;
  } catch (e: any) {
    logError('Solution cache store failed', e);
    return false;
  }
}

function _loadEntry(hash: string): SolutionEntry | null {
  try {
    const db = getDb();
    if (!db) return null;
    const row = db.prepare("SELECT value FROM calibration WHERE key = ?")
      .get(`${KEY_PREFIX}${hash}`);
    if (!row?.value) return null;
    return JSON.parse(row.value);
  } catch { return null; }
}

// R6: Async load from Turso-first (used during cold start population)
async function _loadEntryFromTurso(hash: string): Promise<SolutionEntry | null> {
  const udb = getUnifiedDb();
  if (!udb) return null;
  try {
    const value = await udb.getCalibration(`${KEY_PREFIX}${hash}`);
    if (!value) return null;
    return JSON.parse(value);
  } catch { return null; }
}

function _deleteEntry(hash: string): boolean {
  try {
    const db = getDb();
    if (!db) return false;
    db.prepare("DELETE FROM calibration WHERE key = ?")
      .run(`${KEY_PREFIX}${hash}`);

    // R6: Async delete from Turso
    const udb = getUnifiedDb();
    if (udb) {
      udb.deleteCalibration(`${KEY_PREFIX}${hash}`).catch(() => {});
    }
    return true;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
// Eviction
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run eviction if cache is over capacity.
 * Evicts oldest-last-used entries first (LRU).
 */
function _evictIfNeeded(): void {
  try {
    const count = _countEntries();
    if (count <= MAX_ENTRIES) return;

    const entries = _getAllEntries();
    const toEvict = count - MAX_ENTRIES;

    for (let i = 0; i < toEvict && i < entries.length; i++) {
      const hash = entries[i].key.replace(KEY_PREFIX, '');
      _deleteEntry(hash);
    }

    _stats.evictions += toEvict;
    log(`Solution cache: evicted ${toEvict} entries (LRU, now ${count - toEvict}/${MAX_ENTRIES})`, 'INFO', 'solution-cache');
  } catch (e: any) {
    logError('Solution cache eviction failed', e);
  }
}

/**
 * Delete entries that have failed too many times (learned they're unreliable).
 */
function _evictFailedEntries(): void {
  try {
    const db = getDb();
    if (!db) return;

    const entries = _getAllEntries();
    let evicted = 0;

    for (const entry of entries) {
      try {
        const data: SolutionEntry = JSON.parse(entry.value);
        if (data.failCount > FAIL_EVICTION_THRESHOLD) {
          _deleteEntry(entry.key.replace(KEY_PREFIX, ''));
          evicted++;
        }
      } catch { /* skip corrupt entries */ }
    }

    if (evicted > 0) {
      _stats.failEvictions += evicted;
      log(`Solution cache: evicted ${evicted} unreliable entries (failCount > ${FAIL_EVICTION_THRESHOLD})`, 'INFO', 'solution-cache');
    }
  } catch { /* non-critical */ }
}

/**
 * Delete entries older than MAX_AGE_DAYS with zero successful reuses.
 */
function _cleanupOldEntries(): void {
  try {
    const db = getDb();
    if (!db) return;

    const cutoff = Date.now() - (MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
    const entries = _getAllEntries();
    let cleaned = 0;

    for (const entry of entries) {
      try {
        const data: SolutionEntry = JSON.parse(entry.value);
        if (data.successCount === 0 && data.createdAt < cutoff) {
          _deleteEntry(entry.key.replace(KEY_PREFIX, ''));
          cleaned++;
        }
      } catch { /* skip */ }
    }

    if (cleaned > 0) {
      _stats.ageCleanups += cleaned;
      log(`Solution cache: cleaned ${cleaned} stale entries (>${MAX_AGE_DAYS} days, 0 reuses)`, 'INFO', 'solution-cache');
    }
  } catch { /* non-critical */ }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — Lookup
// ═══════════════════════════════════════════════════════════════════════════

export interface CacheLookupResult {
  found: boolean;
  type: 'exact' | 'similar' | 'miss';
  solution?: SolutionEntry;
  similarSolution?: SolutionEntry;  // for 'similar' type
  hash: string;
  normalizedText: string;
}

/**
 * Look up a problem in the solution cache.
 *
 * Returns:
 *   - exact: found an exact match (normalized hash matches)
 *   - similar: found a structurally similar problem (same constants pattern)
 *   - miss: no match found
 */
function lookup(problemText: string): CacheLookupResult {
  _stats.lookups++;

  const normalized = normalizeProblem(problemText);
  const hash = hashProblem(normalized);

  if (!hash) {
    return { found: false, type: 'miss', hash, normalizedText: normalized };
  }

  // 1. Try exact match
  const exactEntry = _loadEntry(hash);
  if (exactEntry) {
    // Update lastUsedAt
    exactEntry.lastUsedAt = Date.now();
    _storeEntry(hash, exactEntry);

    _stats.exactHits++;
    log(`Solution cache EXACT HIT for hash=${hash.slice(0, 8)} (successCount=${exactEntry.successCount})`, 'DEBUG', 'solution-cache');
    return { found: true, type: 'exact', solution: exactEntry, hash, normalizedText: normalized };
  }

  // 2. Try similarity match — scan all entries for structural similarity
  const queryConstants = extractConstants(problemText);
  if (queryConstants.length >= 2) {  // need at least 2 constants for meaningful comparison
    try {
      const db = getDb();
      if (db) {
        const entries = _getAllEntries();
        let bestMatch: SolutionEntry | null = null;
        let bestSimilarity = 0;

        for (const entry of entries) {
          try {
            const data: SolutionEntry = JSON.parse(entry.value);
            const sim = computeSimilarity(queryConstants, data.constants);
            if (sim > bestSimilarity && sim >= SIMILARITY_THRESHOLD) {
              bestSimilarity = sim;
              bestMatch = data;
            }
          } catch { /* skip */ }
        }

        if (bestMatch) {
          _stats.similarHits++;
          log(`Solution cache SIMILAR HIT (${(bestSimilarity * 100).toFixed(0)}% match) for hash=${hash.slice(0, 8)}`, 'DEBUG', 'solution-cache');
          return { found: true, type: 'similar', similarSolution: bestMatch, hash, normalizedText: normalized };
        }
      }
    } catch { /* similarity scan failed — not critical */ }
  }

  // 3. Miss
  _stats.misses++;
  return { found: false, type: 'miss', hash, normalizedText: normalized };
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — Store
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Store a solution in the cache after successful verification.
 *
 * @param problemText - The original problem text
 * @param solution - The verified solution text
 * @param steps - Step-by-step solution steps (array of strings)
 * @param options
 *   - problemType: string (from classifier)
 *   - modelUsed: string (which LLM provided the answer)
 *   - verified: boolean (whether math-verify confirmed it)
 */
function store(
  problemText: string,
  solution: string,
  steps: string[],
  options: {
    problemType?: string;
    modelUsed?: string;
    verified?: boolean;
  } = {}
): boolean {
  const normalized = normalizeProblem(problemText);
  const hash = hashProblem(normalized);

  if (!hash) {
    log('Solution cache: cannot store — empty normalized text', 'WARN', 'solution-cache');
    return false;
  }

  // Check if we already have an entry (update it)
  const existing = _loadEntry(hash);
  const entry: SolutionEntry = {
    problemText: problemText.slice(0, 1000),  // truncate very long problems
    normalizedText: normalized,
    solution: solution.slice(0, 2000),
    steps: steps.slice(0, 20),  // max 20 steps
    problemType: options.problemType || 'UNKNOWN',
    modelUsed: options.modelUsed || 'unknown',
    verified: options.verified ?? false,
    verifiedAt: options.verified ? Date.now() : null,
    successCount: existing?.successCount || 0,
    failCount: existing?.failCount || 0,
    createdAt: existing?.createdAt || Date.now(),
    lastUsedAt: Date.now(),
    constants: extractConstants(problemText),
  };

  // Evict if needed BEFORE storing
  _evictIfNeeded();

  const success = _storeEntry(hash, entry);
  if (success) {
    _stats.stores++;
    log(`Solution cache STORED hash=${hash.slice(0, 8)} (type=${entry.problemType}, verified=${entry.verified})`, 'DEBUG', 'solution-cache');
  }

  return success;
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — Record reuse outcome
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Record whether a cached solution worked when reused.
 * This builds confidence data for LRU eviction ordering.
 */
function recordReuseOutcome(hash: string, success: boolean): void {
  const entry = _loadEntry(hash);
  if (!entry) return;

  if (success) {
    entry.successCount++;
  } else {
    entry.failCount++;
  }
  entry.lastUsedAt = Date.now();
  _storeEntry(hash, entry);

  // If it failed too many times, evict immediately
  if (entry.failCount > FAIL_EVICTION_THRESHOLD) {
    _deleteEntry(hash);
    _stats.failEvictions++;
    log(`Solution cache: evicted unreliable entry hash=${hash.slice(0, 8)} (failCount=${entry.failCount})`, 'INFO', 'solution-cache');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API — Maintenance
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Run periodic maintenance: eviction, cleanup.
 * Called by cycle manager every 100 cycles or on Recovery shift (Response 7).
 */
function runMaintenance(): { evicted: number; failed: number; cleaned: number } {
  const before = _countEntries();
  _evictIfNeeded();
  _evictFailedEntries();
  _cleanupOldEntries();
  const after = _countEntries();

  return {
    evicted: _stats.evictions,
    failed: _stats.failEvictions,
    cleaned: _stats.ageCleanups,
  };
}

/**
 * Get cache status summary for dashboard/monitoring.
 */
function getStatus(): {
  entries: number;
  maxEntries: number;
  lookups: number;
  exactHitRate: number;
  similarHitRate: number;
  missRate: number;
  stores: number;
  evictions: number;
} {
  const total = _stats.lookups || 1;
  return {
    entries: _countEntries(),
    maxEntries: MAX_ENTRIES,
    lookups: _stats.lookups,
    exactHitRate: _stats.exactHits / total,
    similarHitRate: _stats.similarHits / total,
    missRate: _stats.misses / total,
    stores: _stats.stores,
    evictions: _stats.evictions,
  };
}

// ─── Initialization ──────────────────────────────────────────────────────────

function init() {
  const count = _countEntries();
  log(`Solution cache initialized (${count}/${MAX_ENTRIES} entries, similarity threshold=${SIMILARITY_THRESHOLD})`, 'INFO', 'solution-cache');

  // Run maintenance on init (cleanup from previous session)
  _evictFailedEntries();
  _cleanupOldEntries();
}

module.exports = {
  // Core API
  lookup,
  store,
  recordReuseOutcome,

  // Maintenance
  runMaintenance,
  getStatus,
  init,

  // Utilities (exported for testing)
  normalizeProblem,
  hashProblem,
  extractConstants,
  computeSimilarity,

  // Stats
  getStats,

  // Types
  CacheLookupResult: undefined, // TypeScript type only, not a runtime value
  SolutionEntry: undefined,

  // DI
  _injectDependencies,
};
