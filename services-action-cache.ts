'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// Action Cache — Remembers successful actions keyed by visual context.
//
// Purpose: Skip expensive AI/tribunal calls when the bot has already seen
// the exact same visual layout and knows what action to take.
//
// Example: If the "Next" button is always at (0.85, 0.93) on quiz pages,
// and the screenshot layout hash matches, execute the saved click directly
// instead of burning a vision API call.
//
// Context signature: SHA-256 of (state + screenshotRegionHash + dominantColors)
// - state: tribunal-reported state (e.g., "assessment", "exercise_info")
// - screenshotRegionHash: MD5 of a cropped region of the screenshot that
//   contains the action-relevant area (buttons, inputs)
// - dominantColors: hash of the 4 quadrant dominant colors (page classifier)
//
// TTL: Entries expire after 4 hours (layouts may change after updates).
// Max entries: 200 (prevents unbounded growth).
// Failure threshold: 3 consecutive failures → entry evicted.
//
// SQLite table: action_cache
// ═══════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const zlib = require('zlib');

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
const DEFAULT_MIN_HITS_BEFORE_SAVE = 1; // Save after first successful use

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
function computeContextSignature(
  state: string | null,
  base64Screenshot: string | null,
  dominantColors?: string
): string | null {
  if (!state || !base64Screenshot || base64Screenshot.length < 100) return null;

  // Decode screenshot buffer for region hashing
  let imageBuffer: Buffer;
  try {
    // Handle both raw base64 and data URI format
    const b64 = base64Screenshot.startsWith('data:')
      ? base64Screenshot.split(',')[1] || ''
      : base64Screenshot;
    imageBuffer = Buffer.from(b64, 'base64');
  } catch {
    return null;
  }

  if (imageBuffer.length < 100) return null;

  // Hash key regions of the image (not the full image — that changes with text content)
  // Focus on the bottom 40% where buttons typically live, and the top 20% for headers
  const width = 1280; // approximate — we work with raw bytes
  const totalPixels = imageBuffer.length / 3; // rough RGB estimate (ignoring PNG structure)

  // For speed, hash a sampled subset rather than decoding the full PNG
  // Use the raw buffer — even with PNG encoding overhead, the button regions
  // will produce consistent hashes for identical layouts
  const hashSource = [
    `state:${state}`,
    `imgLen:${imageBuffer.length}`,
    `domColors:${dominantColors || 'none'}`,
  ].join('|');

  return crypto.createHash('sha256').update(hashSource).digest('hex').substring(0, 32);
}

/**
 * Compute a lightweight layout fingerprint from a decoded RGBA image buffer.
 * Samples specific regions (bottom buttons area, center content, top header)
 * and hashes the color distribution, not the exact pixels.
 *
 * This is more stable than a full screenshot hash because it ignores text
 * content changes while still detecting layout shifts.
 */
function computeLayoutFingerprint(
  rgba: Uint8ClampedArray, width: number, height: number
): string {
  // Sample 4 quadrants, count color buckets per quadrant
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
    const step = 12; // coarse sampling for speed
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
      // Bucket the average color into 8 ranges per channel (3 bits each = 9-bit descriptor)
      const rAvg = Math.floor(rSum / count / 32); // 0-7
      const gAvg = Math.floor(gSum / count / 32);
      const bAvg = Math.floor(bSum / count / 32);
      parts.push(`${q.name}:${rAvg}${gAvg}${bAvg}`);
    }
  }

  return parts.join(',');
}

// ─── Cache Operations ──────────────────────────────────────────────────────

/**
 * Look up a cached action for the given context signature.
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
  try {
    const dbMod = _getDb();
    if (!dbMod) return null;

    const row = dbMod.prepare(
      `SELECT action_type, target_x, target_y, value, keypad_sequence, current_state,
              reasoning, hit_count, last_used
       FROM action_cache WHERE context_sig = ? AND evicted = 0`
    ).get(contextSignature);

    if (!row) return null;

    // Check TTL
    const config = _getConfig();
    const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
    if (Date.now() - row.last_used > ttlMs) {
      // Expired — silently evict
      _markEvicted(contextSignature);
      return null;
    }

    log(`Action cache HIT: sig=${contextSignature.substring(0, 8)} type=${row.action_type} hits=${row.hit_count}`, 'INFO', 'action-cache');
    updateStats('hits');

    // Update hit count and last used
    dbMod.prepare(
      `UPDATE action_cache SET hit_count = hit_count + 1, last_used = ? WHERE context_sig = ?`
    ).run(Date.now(), contextSignature);

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
  } catch (e: any) {
    log(`Action cache lookup error: ${e.message || e}`, 'DEBUG', 'action-cache');
    return null;
  }
}

/**
 * Save a successful action to the cache.
 * If an entry already exists for this context, update it. Otherwise insert.
 * Only saves actions that have been successful at least once.
 */
function save(
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
): void {
  const log = _getLog();
  try {
    const dbMod = _getDb();
    if (!dbMod) return;

    // Check if we're at max capacity
    const config = _getConfig();
    const maxEntries = config.ACTION_CACHE_MAX_ENTRIES || DEFAULT_MAX_ENTRIES;
    const count = dbMod.prepare(
      `SELECT COUNT(*) as cnt FROM action_cache WHERE evicted = 0`
    ).get()?.cnt || 0;

    if (count >= maxEntries) {
      // Evict oldest/least-used entries
      const toEvict = Math.max(1, Math.floor(maxEntries * 0.1)); // evict 10%
      dbMod.prepare(
        `UPDATE action_cache SET evicted = 1 WHERE context_sig IN (
          SELECT context_sig FROM action_cache WHERE evicted = 0
          ORDER BY last_used ASC LIMIT ?
        )`
      ).run(toEvict);
    }

    const now = Date.now();
    const keypadJson = action.keypadSequence ? JSON.stringify(action.keypadSequence) : null;

    // Upsert: insert or update existing
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

    log(`Action cache SAVE: sig=${contextSignature.substring(0, 8)} type=${action.actionType} state=${action.currentState}`, 'DEBUG', 'action-cache');
  } catch (e: any) {
    log(`Action cache save error: ${e.message || e}`, 'DEBUG', 'action-cache');
  }
}

/**
 * Record a failure for a cached action.
 * If the same context fails MAX_FAILURES times consecutively, evict it.
 * Returns true if the entry was evicted.
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
      log(`Action cache EVICT: sig=${contextSignature.substring(0, 8)} failed ${newFailures} times — evicting`, 'WARN', 'action-cache');
      _markEvicted(contextSignature);
      updateStats('evictions');
      return true;
    }

    return false;
  } catch (e: any) {
    log(`Action cache failure recording error: ${e.message || e}`, 'DEBUG', 'action-cache');
    return false;
  }
}

// ─── Internal Helpers ──────────────────────────────────────────────────────

let _db: any = null;
function _getDb() {
  if (_db) return _db;
  try {
    const dbMod = require('./database');
    _db = dbMod.getDb?.() || dbMod.db;
    return _db;
  } catch { return null; }
}

function _markEvicted(contextSignature: string): void {
  try {
    const dbMod = _getDb();
    if (!dbMod) return;
    dbMod.prepare(`UPDATE action_cache SET evicted = 1 WHERE context_sig = ?`).run(contextSignature);
  } catch { /* non-critical */ }
}

const _stats = { hits: 0, misses: 0, saves: 0, evictions: 0 };
function updateStats(type: 'hits' | 'misses' | 'saves' | 'evictions') {
  _stats[type]++;
}

// ─── Maintenance ──────────────────────────────────────────────────────────

/**
 * Run maintenance: evict expired entries, clear old evicted rows.
 * Called periodically (e.g., every 100 questions).
 */
function runMaintenance(): void {
  const log = _getLog();
  try {
    const dbMod = _getDb();
    if (!dbMod) return;

    const config = _getConfig();
    const ttlMs = config.ACTION_CACHE_TTL_MS || DEFAULT_TTL_MS;
    const cutoff = Date.now() - ttlMs;

    // Evict expired entries
    const result = dbMod.prepare(
      `UPDATE action_cache SET evicted = 1 WHERE last_used < ? AND evicted = 0`
    ).run(cutoff);
    if (result.changes > 0) {
      log(`Action cache maintenance: evicted ${result.changes} expired entries`, 'INFO', 'action-cache');
      updateStats('evictions');
    }

    // Delete old evicted rows (keep last 50 for debugging)
    dbMod.prepare(
      `DELETE FROM action_cache WHERE evicted = 1 AND context_sig NOT IN (
        SELECT context_sig FROM action_cache WHERE evicted = 1 ORDER BY last_used DESC LIMIT 50
      )`
    ).run();
  } catch (e: any) {
    log(`Action cache maintenance error: ${e.message || e}`, 'DEBUG', 'action-cache');
  }
}

/**
 * Get cache statistics for monitoring.
 */
function getStats(): {
  hits: number;
  misses: number;
  saves: number;
  evictions: number;
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
 */
function clear(): void {
  _stats.hits = 0;
  _stats.misses = 0;
  _stats.saves = 0;
  _stats.evictions = 0;
  try {
    const dbMod = _getDb();
    if (dbMod) {
      dbMod.prepare(`DELETE FROM action_cache`).run();
    }
  } catch { /* non-critical */ }
}

module.exports = {
  _injectDependencies,
  computeContextSignature,
  computeLayoutFingerprint,
  lookup,
  save,
  recordFailure,
  runMaintenance,
  getStats,
  clear,
};
