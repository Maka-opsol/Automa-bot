'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Action Cache — Remembers successful actions keyed by visual context.
//
// R6 refactor: Now uses unified-db for Turso-primary persistence.
// - READS: Local DB first (sync, zero latency for hot path), then Turso
//   fallback for cold starts where local is empty
// - WRITES: Local DB (sync) + Turso (async, fire-and-forget via unifiedDb)
//
// Purpose: Skip expensive AI/tribunal calls when the bot has already seen
// the exact same visual layout and knows what action to take.
//
// Context signature: SHA-256 of (state + screenshotRegionHash + dominantColors)
//
// TTL: Entries expire after 4 hours (layouts may change after updates).
// Max entries: 200 (prevents unbounded growth).
// Failure threshold: 3 consecutive failures → entry evicted.
//
// Storage: action_cache table (local + Turso)
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

function _getConfig() {
  return _deps.config || (() => { try { return require('./get-config'); } catch { return {}; } })();
}
function _getLog() {
  const logger = _deps.logger || {};
  return logger.log || console.log;
}

// ─── Configuration ────────────────────────────────────────────────────────

const DEFAULT_MAX_ENTRIES = 200;
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const DEFAULT_MAX_FAILURES = 3;
// BUG FIX (2026-09-04): High-hit-count eviction threshold.
// If the same cached action is hit more than this many times without success,
// evict it — the action is clearly wrong for the page (e.g., the bot is stuck
// on a Microsoft password-reset page that visually resembles the email input
// page). Override via env var ACTION_CACHE_MAX_HITS_BEFORE_EVICT.
const DEFAULT_MAX_HITS_BEFORE_EVICT = 10;

// ─── Context Signature Computation ─────────────────────────────────────────

/**
 * Compute a visual context signature from the current state and screenshot.
 * The signature captures the layout of action-relevant regions without
 * depending on exact pixel values (which change due to text content, timers, etc.)
 *
 * @param state - Current tribunal state (e.g., "assessment", "exercise_info")
 * @param base64Screenshot - Full JPEG/PNG screenshot (base64-encoded, WITHOUT data: prefix)
 * @param dominantColors - Optional pre-computed color hash from page classifier
 * @returns Context signature string, or null if inputs invalid
 */
/**
 * Compute a coarse byte-sample fingerprint directly from a JPEG/PNG buffer.
 * Does NOT require decoding — samples bytes at fixed percentage positions
 * through the file body. This is stable across animation frames (which
 * only change a small fraction of DCT blocks) but changes for genuinely
 * different pages.
 *
 * Cost: ~0.01ms (just array indexing, no decoding).
 *
 * BUG FIX (2026-09-04, v2): Returns an ARRAY of per-region hashes instead
 * of a single XOR-folded hash. The old single-hash design meant that ANY
 * byte change in ANY sampled window cascaded to a completely different
 * signature — so a clock ticking in the corner, a spinner animating, or
 * a video thumbnail changing frame invalidated the entire cache.
 *
 * The new design returns 12 independent region hashes. The signature
 * string encodes all 12 (for exact-match DB storage), but the new
 * `findSimilarSignature()` function does in-JS similarity matching:
 * if N out of 12 regions match (default 9 = 75%), the signature is
 * considered a match. This makes the cache resilient to small background
 * changes while still rejecting genuinely different pages.
 */
const FINGERPRINT_POSITIONS = [0.05, 0.12, 0.2, 0.28, 0.36, 0.44, 0.52, 0.6, 0.68, 0.76, 0.84, 0.92];
const FINGERPRINT_WINDOW_SIZE = 32;
const NUM_REGIONS = FINGERPRINT_POSITIONS.length;

function _coarseBufferFingerprintRegions(buf: Buffer): {
  lenBucket: number;
  regions: number[];
} {
  const len = buf.length;
  const regions: number[] = new Array(NUM_REGIONS).fill(0);
  for (let r = 0; r < NUM_REGIONS; r++) {
    const start = Math.floor(len * FINGERPRINT_POSITIONS[r]);
    let hash = 0;
    for (let i = 0; i < FINGERPRINT_WINDOW_SIZE && (start + i) < len; i++) {
      hash = ((hash << 5) - hash + buf[start + i]) | 0;
    }
    regions[r] = hash >>> 0; // unsigned
  }
  const lenBucket = Math.floor(len / 1024) * 1024;
  return { lenBucket, regions };
}

/**
 * @deprecated Use _coarseBufferFingerprintRegions instead. Kept for backward
 * compatibility with any external callers. Returns the old single-hash format.
 */
function _coarseBufferFingerprint(buf: Buffer): string {
  const { lenBucket, regions } = _coarseBufferFingerprintRegions(buf);
  // XOR-fold all region hashes into one (lossy — this is what we're moving away from)
  let combined = 0;
  for (const r of regions) combined ^= r;
  return `${lenBucket}:${(combined >>> 0).toString(16)}`;
}

/**
 * Compare two region fingerprint arrays and return the fraction of matching regions.
 * Two regions "match" if their unsigned 32-bit hash values are equal.
 *
 * @returns 0.0 - 1.0 fraction of matching regions
 */
function _regionSimilarity(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length || a.length === 0) return 0;
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] === b[i]) matches++;
  }
  return matches / a.length;
}

/**
 * Default similarity threshold for cache matching.
 * 0.75 means 9 out of 12 regions must match.
 * Configurable via env var ACTION_CACHE_SIMILARITY_THRESHOLD (0.0 - 1.0).
 */
const DEFAULT_SIMILARITY_THRESHOLD = 0.75;

function _getSimilarityThreshold(): number {
  const config = _getConfig();
  const v = Number(config.ACTION_CACHE_SIMILARITY_THRESHOLD);
  if (Number.isFinite(v) && v >= 0.0 && v <= 1.0) return v;
  return DEFAULT_SIMILARITY_THRESHOLD;
}

/**
 * Encode a state + region fingerprint into a signature string for DB storage.
 *
 * Format: "state|lenBucket|r0-r1-r2-...-r11"
 *
 * The state prefix lets us query the DB by current_state (indexed) and then
 * do in-JS similarity matching on the region arrays for entries with the same
 * state. This means: same state + 75% region match = cache hit, even if a
 * few regions differ due to animations / small layout changes.
 */
function computeContextSignature(
  state: string | null,
  base64Screenshot: string | null,
  dominantColors?: string
): string | null {
  if (!state || !base64Screenshot || base64Screenshot.length < 100) return null;

  let imageBuffer: Buffer;
  try {
    const b64 = base64Screenshot.startsWith('data:')
      ? base64Screenshot.split(',')[1] || ''
      : base64Screenshot;
    imageBuffer = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }

  if (imageBuffer.length < 100) return null;

  const { lenBucket, regions } = _coarseBufferFingerprintRegions(imageBuffer);
  // Format: state|lenBucket|r0-r1-...-r11|domColors
  // We keep the dominantColors in the signature for backward compat (older
  // entries may have used it), but the region array is the primary key.
  const regionsStr = regions.join('-');
  return `${state}|${lenBucket}|${regionsStr}|${dominantColors || 'none'}`;
}

/**
 * Parse a stored signature back into its component parts.
 * Returns null if the signature format is unrecognized (e.g., old-format signatures
 * that used sha256 — those won't have the region structure and will simply
 * fail to parse, which is fine; they'll be evicted on next access).
 */
function _parseSignature(sig: string): {
  state: string;
  lenBucket: number;
  regions: number[];
  domColors: string;
} | null {
  if (!sig || typeof sig !== 'string') return null;
  const parts = sig.split('|');
  if (parts.length < 4) return null;
  const state = parts[0];
  const lenBucket = parseInt(parts[1], 10);
  const regionsStr = parts[2];
  const domColors = parts.slice(3).join('|'); // in case domColors had | chars
  if (!state || !regionsStr || !Number.isFinite(lenBucket)) return null;
  const regions = regionsStr.split('-').map((h: string) => parseInt(h, 10));
  if (regions.length !== NUM_REGIONS || regions.some((r: number) => !Number.isFinite(r))) {
    return null;
  }
  return { state, lenBucket, regions, domColors };
}

/**
 * Check whether a stored signature is similar enough to a target signature
 * to be considered a cache hit. Two signatures are "similar" if:
 *   1. They have the same state
 *   2. They have similar length buckets (within ±2KB)
 *   3. The fraction of matching regions >= ACTION_CACHE_SIMILARITY_THRESHOLD
 *
 * @param storedSig - The signature stored in the DB
 * @param targetSig - The signature computed from the current screenshot
 * @returns true if the signatures are similar enough to be a cache hit
 */
function _isSignatureSimilar(storedSig: string, targetSig: string): boolean {
  const stored = _parseSignature(storedSig);
  const target = _parseSignature(targetSig);
  if (!stored || !target) return false;
  if (stored.state !== target.state) return false;
  // Length bucket must be within ±2KB (absorbs compression jitter)
  if (Math.abs(stored.lenBucket - target.lenBucket) > 2048) return false;
  const sim = _regionSimilarity(stored.regions, target.regions);
  return sim >= _getSimilarityThreshold();
}

/**
 * Find a similar cached action in the local DB by scanning entries with the
 * same `current_state` and doing in-JS similarity matching on their
 * `context_sig` (which encodes the region fingerprint).
 *
 * This is the SLOW PATH after the exact-match fast path misses. It queries
 * the `action_cache` table by `current_state` (which is indexed) so we only
 * scan entries with the same state — typically a few dozen at most.
 *
 * Returns the cached action if a similar signature is found, null otherwise.
 * Also updates the matched entry's hit_count and last_used (same as exact match).
 *
 * BUG FIX (2026-09-04, v2): This function makes the action cache resilient
 * to small background changes (clocks ticking, spinners animating, video
 * thumbnails changing frame). Previously, ANY byte change in the sampled
 * regions invalidated the entire cache entry — so the bot kept re-querying
 * the tribunal for pages it had already seen. Now, if 75% of regions match,
 * the cache entry is reused.
 */
function _findSimilarLocalHit(targetSig: string): {
  actionType: string;
  targetX: number;
  targetY: number;
  value: string;
  keypadSequence: any;
  currentState: string;
  reasoning: string;
  hitCount: number;
  lastUsed: number;
} | null {
  const log = _getLog();
  const target = _parseSignature(targetSig);
  if (!target) return null;

  let dbMod: any = null;
  try { dbMod = _getDb(); } catch { return null; }
  if (!dbMod) return null;

  // Query by current_state (uses the idx_action_cache_state index).
  // Limit to last 50 entries to avoid scanning huge tables.
  let rows: any[] = [];
  try {
    rows = dbMod.prepare(
      `SELECT context_sig, action_type, target_x, target_y, value, keypad_sequence,
              current_state, reasoning, hit_count, last_used
       FROM action_cache
       WHERE current_state = ? AND evicted = 0
       ORDER BY last_used DESC
       LIMIT 50`
    ).all(target.state);
  } catch (e: any) {
    log(`Action cache similarity scan error: ${e.message || e}`, 'DEBUG', 'action-cache');
    return null;
  }

  if (!rows || rows.length === 0) return null;

  // Find the most similar entry.
  let bestRow: any = null;
  let bestSim = 0;
  for (const row of rows) {
    // Skip exact match (already tried in fast path)
    if (row.context_sig === targetSig) continue;
    const isSimilar = _isSignatureSimilar(row.context_sig, targetSig);
    if (isSimilar) {
      // Compute exact similarity for ranking
      const stored = _parseSignature(row.context_sig);
      if (stored) {
        const sim = _regionSimilarity(stored.regions, target.regions);
        if (sim > bestSim) {
          bestSim = sim;
          bestRow = row;
        }
      }
    }
  }

  if (!bestRow) return null;

  // Check TTL
  const config = _getConfig();
  const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
  if (Date.now() - bestRow.last_used > ttlMs) {
    _markEvicted(bestRow.context_sig);
    return null;
  }

  // Check high-hit-count eviction (same logic as exact match path)
  const currentHitCount = (bestRow.hit_count || 0) + 1;
  const maxHitsBeforeEviction = Number(config.ACTION_CACHE_MAX_HITS_BEFORE_EVICT) || DEFAULT_MAX_HITS_BEFORE_EVICT;
  if (currentHitCount > maxHitsBeforeEviction) {
    log(`Action cache EVICT (too many hits, similar match): sig=${bestRow.context_sig.substring(0, 8)} type=${bestRow.action_type} hits=${currentHitCount - 1}`, 'WARN', 'action-cache');
    _markEvicted(bestRow.context_sig);
    updateStats('evictions');
    return null;
  }

  const simPct = Math.round(bestSim * 100);
  log(`Action cache HIT (SIMILAR ${simPct}%): target_sig=${targetSig.substring(0, 8)} matched_sig=${bestRow.context_sig.substring(0, 8)} type=${bestRow.action_type} hits=${bestRow.hit_count}`, 'INFO', 'action-cache');
  updateStats('hits');
  updateStats('similarHits');

  // Update hit count and last_used on the MATCHED entry (not the target sig)
  try {
    dbMod.prepare(
      `UPDATE action_cache SET hit_count = hit_count + 1, last_used = ? WHERE context_sig = ?`
    ).run(Date.now(), bestRow.context_sig);
  } catch { /* best effort */ }

  // Async: update hit count in Turso via unifiedDb
  const udb = _getUnifiedDb();
  if (udb) { udb.getActionCache(bestRow.context_sig).catch(() => {}); }

  return {
    actionType: bestRow.action_type,
    targetX: bestRow.target_x,
    targetY: bestRow.target_y,
    value: bestRow.value || '',
    keypadSequence: bestRow.keypad_sequence ? JSON.parse(bestRow.keypad_sequence) : [],
    currentState: bestRow.current_state,
    reasoning: bestRow.reasoning || '[cached action (similar match)]',
    hitCount: bestRow.hit_count,
    lastUsed: bestRow.last_used,
  };
}

/**
 * Compute a lightweight layout fingerprint from a decoded RGBA image buffer.
 * Samples specific regions (bottom buttons area, center content, top header)
 * and hashes the color distribution, not the exact pixels.
 */
function computeLayoutFingerprint(
  rgba: Uint8ClampedArray, width: number, height: number
): string {
  const quadrants = [
    { name: 'top', x1: 0.0, y1: 0.0, x2: 1.0, y2: 0.2 },
    { name: 'center', x1: 0.2, y1: 0.3, x2: 0.8, y2: 0.6 },
    { name: 'bottom-left', x1: 0.0, y1: 0.8, x2: 0.5, y2: 1.0 },
    { name: 'bottom-right', x1: 0.5, y1: 0.8, x2: 1.0, y2: 1.0 },
  ];

  const parts: string[] = [];
  for (const q of quadrants) {
    const sx = Math.floor(width * q.x1);
    const sy = Math.floor(height * q.y1);
    const ex = Math.floor(width * q.x2);
    const ey = Math.floor(height * q.y2);

    let rSum = 0, gSum = 0, bSum = 0, count = 0;
    const step = 12;
    for (let y = sy; y < ey; y += step) {
      for (let x = sx; x < ex; x += step) {
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const idx = (y * width + x) * 4;
        rSum += rgba[idx];
        gSum += rgba[idx + 1];
        bSum += rgba[idx + 2];
        count++;
      }
    }

    if (count > 0) {
      const rAvg = Math.floor(rSum / count / 32);
      const gAvg = Math.floor(gSum / count / 32);
      const bAvg = Math.floor(bSum / count / 32);
      parts.push(`${q.name}:${rAvg}${gAvg}${bAvg}`);
    }
  }

  return parts.join(',');
}

// ─── Async Lookup (for cold starts — awaits Turso fallback) ───────

/**
 * Same as lookup() but returns a Promise and AWAITs the Turso fallback
 * when the local DB misses. Use this on cold starts (post-OOM) so the
 * bot can immediately reuse actions persisted in Turso instead of wasting
 * a full tribunal call.
 *
 * Flow:
 *  1. Local DB hit → return immediately (same as sync lookup)
 *  2. Local DB miss → await Turso read → populate local → return
 *  3. Turso miss → return null
 */
async function lookupAsync(contextSignature: string): Promise<{
  actionType: string;
  targetX: number;
  targetY: number;
  value: string;
  keypadSequence: any;
  currentState: string;
  reasoning: string;
  hitCount: number;
  lastUsed: number;
} | null> {
  const log = _getLog();

  // FAST PATH: Check local DB first (sync, zero latency)
  try {
    const dbMod = _getDb();
    if (dbMod) {
      const row = dbMod.prepare(
        `SELECT action_type, target_x, target_y, value, keypad_sequence, current_state,
                reasoning, hit_count, last_used
         FROM action_cache WHERE context_sig = ? AND evicted = 0`
      ).get(contextSignature);

      if (row) {
        // Check TTL
        const config = _getConfig();
        const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
        if (Date.now() - row.last_used > ttlMs) {
          _markEvicted(contextSignature);
          // Don't return — fall through to Turso below
        } else {
          // BUG FIX (2026-09-04): High-hit-count eviction.
          // If the same cached action is being hit >10 times without success,
          // the action is clearly wrong for the page (e.g., the bot is stuck
          // on a page that visually resembles the cached state but is actually
          // different — like a Microsoft password-reset page that visually
          // resembles the email input page). Evict the entry so the next
          // cycle re-queries the tribunal instead of serving the same stale
          // action 30+ times in a loop.
          const currentHitCount = (row.hit_count || 0) + 1;
          const maxHitsBeforeEviction = Number(config.ACTION_CACHE_MAX_HITS_BEFORE_EVICT) || DEFAULT_MAX_HITS_BEFORE_EVICT;
          if (currentHitCount > maxHitsBeforeEviction) {
            log(`Action cache EVICT (too many hits): sig=${contextSignature.substring(0, 8)} type=${row.action_type} hits=${currentHitCount - 1} — action is clearly not progressing the page, evicting to force tribunal re-query`, 'WARN', 'action-cache');
            _markEvicted(contextSignature);
            updateStats('evictions');
            const udb = _getUnifiedDb();
            if (udb) { udb.evictActionCache(contextSignature).catch(() => {}); }
            // Return null so cycle-manager falls through to the tribunal.
            return null;
          }
          log(`Action cache HIT (local): sig=${contextSignature.substring(0, 8)} type=${row.action_type} hits=${row.hit_count}`, 'INFO', 'action-cache');
          updateStats('hits');
          dbMod.prepare(
            `UPDATE action_cache SET hit_count = hit_count + 1, last_used = ? WHERE context_sig = ?`
          ).run(Date.now(), contextSignature);
          const udb = _getUnifiedDb();
          if (udb) { udb.getActionCache(contextSignature).catch(() => {}); }
          return {
            actionType: row.action_type, targetX: row.target_x, targetY: row.target_y,
            value: row.value || '',
            keypadSequence: row.keypad_sequence ? JSON.parse(row.keypad_sequence) : [],
            currentState: row.current_state, reasoning: row.reasoning || '[cached action]',
            hitCount: row.hit_count, lastUsed: row.last_used,
          };
        }
      }
    }
  } catch (e: any) {
    log(`Action cache local lookup error: ${e.message || e}`, 'DEBUG', 'action-cache');
  }

  // SLOW PATH: Await Turso (this is the key difference from sync lookup)
  // BUG FIX (2026-09-04, v2): Before going to Turso (network call), try
  // similarity matching against local DB entries with the same state. This
  // catches the common case where a small animation / layout shift changed
  // a few regions of the screenshot but the page is still fundamentally the
  // same — the cached action is still valid.
  const similarLocal = _findSimilarLocalHit(contextSignature);
  if (similarLocal) {
    return similarLocal;
  }

  const udb = _getUnifiedDb();
  if (udb) {
    try {
      const tursoRow = await udb.getActionCache(contextSignature);
      if (tursoRow) {
        const config = _getConfig();
        const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
        if (Date.now() - tursoRow.last_used <= ttlMs) {
          // Populate local DB for future fast hits
          try {
            const dbMod = _getDb();
            if (dbMod) {
              const keypadJson = tursoRow.keypad_sequence || null;
              dbMod.prepare(
                `INSERT OR REPLACE INTO action_cache (context_sig, action_type, target_x, target_y, value,
                  keypad_sequence, current_state, reasoning, success_count, failure_count,
                  hit_count, created_at, last_used, evicted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
              ).run(
                contextSignature, tursoRow.action_type, tursoRow.target_x, tursoRow.target_y,
                tursoRow.value || '', keypadJson, tursoRow.current_state, tursoRow.reasoning || '',
                tursoRow.success_count || 1, tursoRow.failure_count || 0,
                tursoRow.hit_count || 0, Date.now(), tursoRow.last_used
              );
            }
          } catch {}

          log(`Action cache HIT (turso-cold): sig=${contextSignature.substring(0, 8)} type=${tursoRow.action_type} hits=${tursoRow.hit_count}`, 'INFO', 'action-cache');
          updateStats('hits');
          updateStats('tursoHits');
          return {
            actionType: tursoRow.action_type, targetX: tursoRow.target_x, targetY: tursoRow.target_y,
            value: tursoRow.value || '',
            keypadSequence: tursoRow.keypad_sequence ? JSON.parse(tursoRow.keypad_sequence) : [],
            currentState: tursoRow.current_state, reasoning: tursoRow.reasoning || '[cached action]',
            hitCount: tursoRow.hit_count || 1, lastUsed: tursoRow.last_used,
          };
        }
      }
    } catch (e: any) {
      log(`Action cache Turso lookup error: ${e.message || e}`, 'DEBUG', 'action-cache');
    }
  }

  updateStats('misses');
  return null;
}

// ─── Cache Operations (sync — local DB fast path) ─────────────────────────

const _stats = { hits: 0, misses: 0, saves: 0, evictions: 0, tursoHits: 0, similarHits: 0 };
function updateStats(type: string) { _stats[type] = (_stats as any)[type] + 1 || 1; }

let _db: any = null;
function _getDb() {
  if (_db) return _db;
  try {
    const dbMod = require('./database');
    const fresh = dbMod.getDb?.() || dbMod.db;
    if (fresh) _db = fresh;  // Only cache if we got a real DB
    return fresh;
  } catch { return null; }
}

function _getUnifiedDb() {
  // DI may inject null if unifiedDb's own deps failed (turso is critical:false).
  // Fall back to direct require so Turso writes are never silently skipped.
  if (_deps.unifiedDb) return _deps.unifiedDb;
  try {
    const mod = require('./unified-db');
    if (mod && mod.saveActionCache) return mod;
  } catch { /* first load may fail */ }
  return null;
}

/**
 * Look up a cached action for the given context signature.
 * R6: Checks local DB first (fast), then falls back to Turso via unifiedDb.
 * Returns the cached action if found and not expired, null otherwise.
 */
function lookup(contextSignature: string): {
  actionType: string;
  targetX: number;
  targetY: number;
  value: string;
  keypadSequence: any;
  currentState: string;
  reasoning: string;
  hitCount: number;
  lastUsed: number;
} | null {
  const log = _getLog();

  // FAST PATH: Check local DB first (sync, zero latency)
  try {
    const dbMod = _getDb();
    if (dbMod) {
      const row = dbMod.prepare(
        `SELECT action_type, target_x, target_y, value, keypad_sequence, current_state,
                reasoning, hit_count, last_used
         FROM action_cache WHERE context_sig = ? AND evicted = 0`
      ).get(contextSignature);

      if (row) {
        // Check TTL
        const config = _getConfig();
        const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
        if (Date.now() - row.last_used > ttlMs) {
          _markEvicted(contextSignature);
          // Don't return — fall through to Turso check below
        } else {
          // BUG FIX (2026-09-04): High-hit-count eviction (sync path).
          // Same logic as lookupAsync: if the same cached action is being hit
          // >10 times without success, the action is clearly wrong for the page.
          // Evict so the next cycle re-queries the tribunal.
          const currentHitCount = (row.hit_count || 0) + 1;
          const maxHitsBeforeEviction = Number(_getConfig().ACTION_CACHE_MAX_HITS_BEFORE_EVICT) || DEFAULT_MAX_HITS_BEFORE_EVICT;
          if (currentHitCount > maxHitsBeforeEviction) {
            log(`Action cache EVICT (too many hits): sig=${contextSignature.substring(0, 8)} type=${row.action_type} hits=${currentHitCount - 1} — action is clearly not progressing the page, evicting to force tribunal re-query`, 'WARN', 'action-cache');
            _markEvicted(contextSignature);
            updateStats('evictions');
            const udb = _getUnifiedDb();
            if (udb) { udb.evictActionCache(contextSignature).catch(() => {}); }
            return null;
          }
          log(`Action cache HIT (local): sig=${contextSignature.substring(0, 8)} type=${row.action_type} hits=${row.hit_count}`, 'INFO', 'action-cache');
          updateStats('hits');

          // Update hit count and last used locally
          dbMod.prepare(
            `UPDATE action_cache SET hit_count = hit_count + 1, last_used = ? WHERE context_sig = ?`
          ).run(Date.now(), contextSignature);

          // Async: update hit count in Turso via unifiedDb
          const udb = _getUnifiedDb();
          if (udb) {
            udb.getActionCache(contextSignature).catch(() => {}); // updates hit count
          }

          return {
            actionType: row.action_type,
            targetX: row.target_x,
            targetY: row.target_y,
            value: row.value || '',
            keypadSequence: row.keypad_sequence ? JSON.parse(row.keypad_sequence) : [],
            currentState: row.current_state,
            reasoning: row.reasoning || '[cached action]',
            hitCount: row.hit_count,
            lastUsed: row.last_used,
          };
        }
      }
    }
  } catch (e: any) {
    log(`Action cache local lookup error: ${e.message || e}`, 'DEBUG', 'action-cache');
  }

  // SLOW PATH: Try Turso via unifiedDb (async — but we're in sync context,
  // so this is a fire-and-forget population for NEXT cycle)
  // BUG FIX (2026-09-04, v2): Before falling through to Turso (network),
  // try similarity matching against local DB entries with the same state.
  const similarLocal = _findSimilarLocalHit(contextSignature);
  if (similarLocal) {
    return similarLocal;
  }

  const udb = _getUnifiedDb();
  if (udb) {
    udb.getActionCache(contextSignature).then((tursoRow: any) => {
      if (tursoRow) {
        // Found in Turso but not local — populate local for future fast hits
        const config = _getConfig();
        const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
        if (Date.now() - tursoRow.last_used <= ttlMs) {
          try {
            const dbMod = _getDb();
            if (dbMod) {
              const keypadJson = tursoRow.keypad_sequence || null;
              dbMod.prepare(
                `INSERT OR REPLACE INTO action_cache (context_sig, action_type, target_x, target_y, value,
                  keypad_sequence, current_state, reasoning, success_count, failure_count,
                  hit_count, created_at, last_used, evicted)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
              ).run(
                contextSignature, tursoRow.action_type, tursoRow.target_x, tursoRow.target_y,
                tursoRow.value || '', keypadJson, tursoRow.current_state, tursoRow.reasoning || '',
                tursoRow.success_count || 1, tursoRow.failure_count || 0,
                tursoRow.hit_count || 0, Date.now(), tursoRow.last_used
              );
              log(`Action cache: populated local from Turso for sig=${contextSignature.substring(0, 8)}`, 'DEBUG', 'action-cache');
            }
          } catch {}
        }
      }
    }).catch(() => {});
  }

  updateStats('misses');
  return null;
}

/**
 * Save a successful action to the cache.
 * Writes to local DB (sync) + Turso (awaited via unifiedDb).
 * The Turso write is AWAITED so the action is guaranteed persisted
 * before the bot continues — critical for OOM survival since SIGKILL
 * allows no shutdown hooks.
 */
async function save(
  contextSignature: string,
  action: {
    actionType: string;
    targetX: number;
    targetY: number;
    value?: string;
    keypadSequence?: any;
    currentState: string;
    reasoning?: string;
  }
): Promise<void> {
  const log = _getLog();
  try {
    let dbMod = _getDb();
    if (!dbMod) {
      // Database may not have been ready at first require — retry once
      _db = null;  // Clear cached null so _getDb retries require
      dbMod = _getDb();
    }
    if (!dbMod) {
      log(`Action cache save SKIPPED — local DB unavailable for sig=${contextSignature.substring(0, 8)}`, 'ERROR', 'action-cache');
      // Attempt Turso-only write as last resort
      const udb = _getUnifiedDb();
      if (udb) {
        try {
          const keypadJson = action.keypadSequence ? JSON.stringify(action.keypadSequence) : null;
          await udb.saveActionCache({
            contextSig: contextSignature, actionType: action.actionType,
            targetX: action.targetX, targetY: action.targetY,
            value: action.value || '', keypadSequence: keypadJson,
            currentState: action.currentState, reasoning: action.reasoning || '',
          });
          log(`Action cache TURSO-ONLY SAVE OK (no local DB): sig=${contextSignature.substring(0, 8)}`, 'INFO', 'action-cache');
        } catch (tursoDirectErr: any) {
          log(`Action cache COMPLETELY FAILED — no local DB and Turso write also failed: ${tursoDirectErr.message || tursoDirectErr}`, 'ERROR', 'action-cache');
        }
      } else {
        log(`Action cache COMPLETELY FAILED — no local DB and no unified-db for sig=${contextSignature.substring(0, 8)}`, 'ERROR', 'action-cache');
      }
      return;
    }

    // Check capacity and evict if needed (local)
    const config = _getConfig();
    const maxEntries = config.ACTION_CACHE_MAX_ENTRIES || DEFAULT_MAX_ENTRIES;
    const count = dbMod.prepare(
      `SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0`
    ).get()?.cnt || 0;

    if (count >= maxEntries) {
      const toEvict = Math.max(1, Math.floor(maxEntries * 0.1));
      dbMod.prepare(
        `UPDATE action_cache SET evicted = 1 WHERE context_sig IN (
          SELECT context_sig FROM action_cache WHERE evicted = 0
          ORDER BY last_used ASC LIMIT ?
        )`
      ).run(toEvict);
    }

    const now = Date.now();
    const keypadJson = action.keypadSequence ? JSON.stringify(action.keypadSequence) : null;

    // Upsert to local DB (sync, instant — survives until next OOM)
    dbMod.prepare(
      `INSERT INTO action_cache (context_sig, action_type, target_x, target_y, value,
        keypad_sequence, current_state, reasoning, success_count, failure_count,
        hit_count, created_at, last_used, evicted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, 0)
       ON CONFLICT(context_sig) DO UPDATE SET
         action_type = excluded.action_type,
         target_x = excluded.target_x,
         target_y = excluded.target_y,
         value = excluded.value,
         keypad_sequence = excluded.keypad_sequence,
         current_state = excluded.current_state,
         reasoning = excluded.reasoning,
         success_count = success_count + 1,
         failure_count = 0,
         last_used = excluded.last_used`
    ).run(
      contextSignature,
      action.actionType,
      action.targetX,
      action.targetY,
      action.value || '',
      keypadJson,
      action.currentState,
      action.reasoning || '',
      now,
      now
    );

    // AWAIT Turso write — guarantees persistence before next action.
    // On OOM (SIGKILL) the process dies instantly; only data already
    // in Turso survives. The ~100-500ms latency is acceptable since
    // it replaces a full tribunal call on the next boot.
    const udb = _getUnifiedDb();
    if (udb) {
      try {
        const tursoOk = await udb.saveActionCache({
          contextSig: contextSignature,
          actionType: action.actionType,
          targetX: action.targetX,
          targetY: action.targetY,
          value: action.value || '',
          keypadSequence: keypadJson,
          currentState: action.currentState,
          reasoning: action.reasoning || '',
        });
        log(`Action cache TURSO WRITE ${tursoOk ? 'OK' : 'FAILED'}: sig=${contextSignature.substring(0, 8)}`, tursoOk ? 'DEBUG' : 'WARN', 'action-cache');
      } catch (tursoErr: any) {
        log(`Action cache Turso write FAILED (local still saved): ${tursoErr.message || tursoErr}`, 'WARN', 'action-cache');
      }
    } else {
      log(`Action cache: NO unified-db — Turso write SKIPPED for sig=${contextSignature.substring(0, 8)}`, 'WARN', 'action-cache');
    }

    log(`Action cache SAVE: sig=${contextSignature.substring(0, 8)} type=${action.actionType} state=${action.currentState}`, 'DEBUG', 'action-cache');
    updateStats('saves');
  } catch (e: any) {
    log(`Action cache save CRITICAL ERROR (data LOST): ${e.message || e}`, 'ERROR', 'action-cache');
  }
}

/**
 * Record a failure for a cached action.
 * R6: Updates local (sync) + Turso (async via unifiedDb).
 * If MAX_FAILURES consecutive failures → evict from both stores.
 */
function recordFailure(contextSignature: string): boolean {
  const log = _getLog();
  try {
    const dbMod = _getDb();
    if (!dbMod) return false;

    const config = _getConfig();
    const maxFailures = config.ACTION_CACHE_MAX_FAILURES || DEFAULT_MAX_FAILURES;

    const row = dbMod.prepare(
      `SELECT failure_count FROM action_cache WHERE context_sig = ? AND evicted = 0`
    ).get(contextSignature);

    if (!row) return false;

    const newFailCount = (row.failure_count || 0) + 1;
    dbMod.prepare(
      `UPDATE action_cache SET failure_count = ?, last_used = ? WHERE context_sig = ?`
    ).run(newFailCount, Date.now(), contextSignature);

    if (newFailCount >= maxFailures) {
      log(`Action cache EVICT: sig=${contextSignature.substring(0, 8)} failed ${newFailCount} times — evicting`, 'WARN', 'action-cache');
      _markEvicted(contextSignature);
      updateStats('evictions');

      // Async: evict from Turso too
      const udb = _getUnifiedDb();
      if (udb) {
        udb.evictActionCache(contextSignature).catch(() => {});
      }

      return true;
    }

    // Async: record failure in Turso
    const udb = _getUnifiedDb();
    if (udb) {
      udb.recordActionCacheFailure(contextSignature).catch(() => {});
    }

    return false;
  } catch (e: any) {
    log(`Action cache failure recording error: ${e.message || e}`, 'DEBUG', 'action-cache');
    return false;
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

function _markEvicted(contextSignature: string): void {
  try {
    const dbMod = _getDb();
    if (!dbMod) return;
    dbMod.prepare(`UPDATE action_cache SET evicted = 1 WHERE context_sig = ?`).run(contextSignature);
  } catch { /* non-critical */ }
}

// ─── Maintenance ──────────────────────────────────────────────────────────

/**
 * Run maintenance: evict expired entries, clear old evicted rows.
 * R6: Also runs Turso-side maintenance via unifiedDb.
 */
async function runMaintenanceAsync(): Promise<void> {
  const log = _getLog();
  const config = _getConfig();
  const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
  const maxEntries = config.ACTION_CACHE_MAX_ENTRIES || DEFAULT_MAX_ENTRIES;

  // Local maintenance (sync)
  try {
    const dbMod = _getDb();
    if (!dbMod) return;

    const cutoff = Date.now() - ttlMs;
    const result = dbMod.prepare(
      `UPDATE action_cache SET evicted = 1 WHERE last_used < ? AND evicted = 0`
    ).run(cutoff);
    if (result.changes > 0) {
      log(`Action cache maintenance: evicted ${result.changes} expired local entries`, 'INFO', 'action-cache');
      updateStats('evictions');
    }

    dbMod.prepare(
      `DELETE FROM action_cache WHERE evicted = 1 AND context_sig NOT IN (
        SELECT context_sig FROM action_cache WHERE evicted = 1 ORDER BY last_used DESC LIMIT 50
      )`
    ).run();
  } catch (e: any) {
    log(`Action cache maintenance error: ${e.message || e}`, 'DEBUG', 'action-cache');
  }

  // Turso maintenance (async via unifiedDb)
  const udb = _getUnifiedDb();
  if (udb) {
    try {
      const result = await udb.runActionCacheMaintenance(ttlMs, maxEntries);
      if (result.evicted > 0) {
        log(`Action cache maintenance: evicted ${result.evicted} expired Turso entries`, 'INFO', 'action-cache');
      }
    } catch {}
  }
}

/**
 * Sync version of maintenance for backward compatibility.
 * Fires off async Turso maintenance in the background.
 */
function runMaintenance(): void {
  // Run local maintenance synchronously (fast path)
  try {
    const dbMod = _getDb();
    if (!dbMod) return;

    const config = _getConfig();
    const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
    const cutoff = Date.now() - ttlMs;

    const result = dbMod.prepare(
      `UPDATE action_cache SET evicted = 1 WHERE last_used < ? AND evicted = 0`
    ).run(cutoff);
    if (result.changes > 0) {
      _getLog()(`Action cache maintenance: evicted ${result.changes} expired entries`, 'INFO', 'action-cache');
      updateStats('evictions');
    }

    dbMod.prepare(
      `DELETE FROM action_cache WHERE evicted = 1 AND context_sig NOT IN (
        SELECT context_sig FROM action_cache WHERE evicted = 1 ORDER BY last_used DESC LIMIT 50
      )`
    ).run();
  } catch {}

  // Fire off Turso maintenance in background
  runMaintenanceAsync().catch(() => {});
}

/**
 * Get cache statistics for monitoring.
 */
function getStats(): {
  hits: number;
  misses: number;
  saves: number;
  evictions: number;
  tursoHits: number;
  activeEntries: number;
  topActions: Array<{ actionType: string; state: string; hitCount: number }>;
} {
  const dbMod = _getDb();
  let activeEntries = 0;
  const topActions: Array<{ actionType: string; state: string; hitCount: number }> = [];

  try {
    if (dbMod) {
      activeEntries = dbMod.prepare(
        `SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0`
      ).get()?.cnt || 0;

      const rows = dbMod.prepare(
        `SELECT action_type, current_state, hit_count FROM action_cache
         WHERE evicted = 0 ORDER BY hit_count DESC LIMIT 10`
      ).all() || [];

      for (const row of rows) {
        topActions.push({
          actionType: row.action_type,
          state: row.current_state,
          hitCount: row.hit_count,
        });
      }
    }
  } catch { /* non-critical */ }

  return {
    ..._stats,
    activeEntries,
    topActions,
  };
}

/**
 * Clear all cached actions. Used for testing or manual reset.
 * R6: Clears both local and Turso.
 */
async function clearAsync(): Promise<void> {
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.saves = 0;
  _stats.evictions = 0;
  _stats.tursoHits = 0;
  _stats.similarHits = 0;
  try {
    const dbMod = _getDb();
    if (dbMod) {
      dbMod.prepare(`DELETE FROM action_cache`).run();
    }
  } catch {}

  // Clear Turso via unifiedDb
  const udb = _getUnifiedDb();
  if (udb) {
    try { await udb.clearActionCache(); } catch {}
  }
}

/**
 * Sync clear for backward compatibility.
 */
function clear(): void {
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.saves = 0;
  _stats.evictions = 0;
  _stats.tursoHits = 0;
  _stats.similarHits = 0;
  try {
    const dbMod = _getDb();
    if (dbMod) {
      dbMod.prepare(`DELETE FROM action_cache`).run();
    }
  } catch {}

  // Fire off Turso clear in background
  const udb = _getUnifiedDb();
  if (udb) {
    udb.clearActionCache().catch(() => {});
  }
}

module.exports = {
  _injectDependencies,
  computeContextSignature,
  computeLayoutFingerprint,
  lookup,
  lookupAsync,
  save,
  recordFailure,
  runMaintenance,
  runMaintenanceAsync,
  getStats,
  clear,
  clearAsync,
};
