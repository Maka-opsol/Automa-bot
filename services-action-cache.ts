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
 * Cost: ~0.03ms (12×32 = 384 byte reads, no decoding).
 */
function _coarseBufferFingerprint(buf: Buffer): string {
  const len = buf.length;
  // Sample 4 windows of 16 bytes each at 20%, 40%, 60%, 80% of the file.
  // These positions hit the compressed image data (not headers/footers).
  const positions = [0.2, 0.4, 0.6, 0.8];
  const windowSize = 16;
  let hash = 0;
  for (const pct of positions) {
    const start = Math.floor(len * pct);
    for (let i = 0; i < windowSize && (start + i) < len; i++) {
      // XOR-fold bytes into a 32-bit hash — fast, no allocations
      hash = ((hash << 5) - hash + buf[start + i]) | 0;
    }
  }
  // Also bucket the length to absorb ±1KB animation jitter.
  // Round to nearest 2KB so a 17-byte difference maps to the same bucket.
  const bucketedLen = Math.floor(len / 2048) * 2048;
  return `${bucketedLen}:${(hash >>> 0).toString(16)}`;
}

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

  const fp = _coarseBufferFingerprint(imageBuffer);
  const hashSource = [
    `state:${state}`,
    `fp:${fp}`,
    `domColors:${dominantColors || 'none'}`,
  ].join('|');

  return crypto.createHash('sha256').update(hashSource).digest('hex').substring(0, 32);
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

const _stats = { hits: 0, misses: 0, saves: 0, evictions: 0, tursoHits: 0 };
function updateStats(type: string) { _stats[type] = (_stats as any)[type] + 1 || 1; }

let _db: any = null;
function _getDb() {
  if (_db) return _db;
  try {
    const dbMod = require('./database');
    _db = dbMod.getDb?.() || dbMod.db;
    return _db;
  } catch { return null; }
}

function _getUnifiedDb() {
  return _deps.unifiedDb || null;
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
    const dbMod = _getDb();
    if (!dbMod) return;

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
    log(`Action cache save error: ${e.message || e}`, 'DEBUG', 'action-cache');
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
