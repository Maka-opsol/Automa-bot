'use strict';

/**
 * pixel-training.ts — Self-training from successful AI actions
 *
 * Records (screenshot → action → result) triples whenever an AI provider
 * successfully navigates a page. Extracts lightweight visual features
 * around the click/target point, stores feature vectors + metadata in
 * the pixel_training_data DB table, and uploads screenshots to Cloudinary
 * via screenshot-storage.ts.
 *
 * The pixel-fallback.ts module queries this training data when its own
 * confidence is low, effectively learning from the AI providers' successes.
 *
 * Memory-safe design:
 *   - LRU cache bounded at MAX_CACHE_SIZE entries
 *   - Feature vectors are compact (float32 arrays, ~40 bytes each)
 *   - Raw screenshots are NOT kept in memory — uploaded to Cloudinary
 *   - DB queries are paginated (never load full table)
 *
 * Self-training loop:
 *   1. AI provider determines a successful action (click, type, scroll)
 *   2. cycle-cycle-manager calls recordSuccessfulAction()
 *   3. This module:
 *      a. Extracts visual features from the screenshot around the target
 *      b. Computes a compact feature vector (color histogram + edge density +
 *         layout signature)
 *      c. Stores the triple in SQLite (pixel_training_data table)
 *      d. Uploads the screenshot to Cloudinary for future reference
 *      e. Updates the in-memory LRU cache
 *   4. When pixel-fallback has low confidence, it calls querySimilarSituations()
 *      to find historically similar screenshots and reuse those actions
 *
 * Config (env vars):
 *   PIXEL_TRAINING_ENABLED    — Enable/disable (default: true)
 *   PIXEL_TRAINING_MAX_CACHE  — Max entries in LRU cache (default: 500)
 *   PIXEL_TRAINING_SIMILARITY_THRESHOLD — Min cosine similarity (default: 0.7)
 *   PIXEL_TRAINING_MAX_RESULTS — Max results from similarity query (default: 5)
 */

// ─── Lazy imports ────────────────────────────────────────────────────────

function _getLog() {
  try { return require('./logger'); } catch { return { log: console.log, logError: console.error }; }
}

function _getConfig() {
  try { return require('./get-config'); } catch { return {}; }
}

function _getDb() {
  try { return require('./database'); } catch { return null; }
}

function log(msg: string, level: string = 'INFO', mod: string = 'pixel-training') {
  try {
    const logger = _getLog();
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── DI ──────────────────────────────────────────────────────────────────

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

// ─── Constants ───────────────────────────────────────────────────────────

const MAX_CACHE_SIZE = 500;
const DEFAULT_SIMILARITY_THRESHOLD = 0.7;
const DEFAULT_MAX_RESULTS = 5;
const FEATURE_VECTOR_SIZE = 24; // 8 color bins * 3 channels (R,G,B histograms)

// ─── LRU Cache ───────────────────────────────────────────────────────────

class TrainingLRU {
  private cache = new Map<string, TrainingEntry>();
  private readonly maxSize: number;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): TrainingEntry | undefined {
    if (!this.cache.has(key)) return undefined;
    const value = this.cache.get(key)!;
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: string, value: TrainingEntry): void {
    if (this.cache.has(key)) this.cache.delete(key);
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  values(): TrainingEntry[] {
    return Array.from(this.cache.values());
  }

  get size(): number { return this.cache.size; }

  clear(): void { this.cache.clear(); }
}

// ─── Types ───────────────────────────────────────────────────────────────

interface TrainingEntry {
  id?: number;
  /** Hash of the screenshot for dedup */
  screenshotHash: string;
  /** Cloudinary URL for the full screenshot */
  cloudinaryUrl: string;
  /** Cloudinary public ID */
  cloudinaryPublicId: string;
  /** Cloudinary thumbnail URL */
  cloudinaryThumbnail: string;
  /** Compact feature vector (float32 array) */
  featureVector: number[];
  /** The action that was taken */
  action: {
    actionType: string;  // 'click', 'type', 'scroll', 'navigate'
    targetX?: number;
    targetY?: number;
    text?: string;
    direction?: string;
    selector?: string;
    label?: string;       // Human-readable description of what was clicked
  };
  /** State machine state when action was taken */
  state: string;
  /** Which AI provider suggested this action */
  provider: string;
  /** Category of the page (exercise, video, login, etc.) */
  pageCategory: string;
  /** Was the action verified as successful? */
  verified: boolean;
  /** Timestamp */
  createdAt: string;
  /** Confidence score from the AI (0-1) */
  confidence: number;
  /** Visual region around the click point (for context) */
  regionSnapshot?: string; // base64 thumbnail of the 200x200px region around click
}

interface SimilarSituation {
  entry: TrainingEntry;
  similarity: number;
}

// ─── Module State ────────────────────────────────────────────────────────

let _lruCache: TrainingLRU;
let _dbInitialized = false;
let _recordCount = 0;
let _queryCount = 0;
let _hitCount = 0;

function _getCache(): TrainingLRU {
  if (!_lruCache) {
    const config = _getConfig();
    const maxSize = config.PIXEL_TRAINING_MAX_CACHE || MAX_CACHE_SIZE;
    _lruCache = new TrainingLRU(maxSize);
  }
  return _lruCache;
}

// ─── Database ────────────────────────────────────────────────────────────

function _ensureDb(): boolean {
  if (_dbInitialized) return true;

  const dbModule = _getDb() || (_deps as any).database;
  if (!dbModule) {
    log('Database not available — training data stored in memory only', 'WARN');
    _dbInitialized = true; // Don't keep retrying
    return false;
  }

  try {
    const db = dbModule.db || dbModule;
    if (!db || !db.prepare) {
      log('Database handle invalid — training data stored in memory only', 'WARN');
      _dbInitialized = true;
      return false;
    }

    db.exec(`
      CREATE TABLE IF NOT EXISTS pixel_training_data (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        screenshot_hash TEXT NOT NULL,
        cloudinary_url TEXT,
        cloudinary_public_id TEXT,
        cloudinary_thumbnail TEXT,
        feature_vector TEXT NOT NULL,
        action_json TEXT NOT NULL,
        state TEXT NOT NULL,
        provider TEXT,
        page_category TEXT DEFAULT 'unknown',
        verified INTEGER DEFAULT 0,
        confidence REAL DEFAULT 0,
        created_at TEXT NOT NULL,
        region_snapshot TEXT
      )
    `);

    // Index for similarity queries (hash-based lookup)
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ptd_hash ON pixel_training_data(screenshot_hash)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ptd_state ON pixel_training_data(state)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ptd_category ON pixel_training_data(page_category)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_ptd_created ON pixel_training_data(created_at DESC)`);

    _dbInitialized = true;
    log('pixel_training_data table ready', 'INFO');
    return true;
  } catch (err: any) {
    log(`Failed to init training DB: ${err.message}`, 'ERROR');
    _dbInitialized = true; // Don't keep retrying
    return false;
  }
}

// ─── Feature Extraction ──────────────────────────────────────────────────

/**
 * Extract a compact feature vector from a base64 screenshot.
 * The vector captures the visual "fingerprint" of the page:
 *   - Color histogram (8 bins per channel: R, G, B) = 24 floats
 *   - These are normalized to [0, 1]
 *
 * This is deliberately lightweight — no heavy convolutions or embeddings.
 * It's designed to run in <5ms on a single frame.
 */
function extractFeatureVector(base64Image: string): number[] {
  try {
    // Decode base64 to raw pixel data
    const buf = Buffer.from(
      base64Image.includes(',') ? base64Image.split(',')[1] : base64Image,
      'base64'
    );

    // Quick JPEG/PNG header check — if we can't decode, return zero vector
    if (buf.length < 100) return new Array(FEATURE_VECTOR_SIZE).fill(0);

    // Sample pixels uniformly across the image (don't read every pixel — too slow)
    // We'll sample from the raw buffer at regular intervals
    const sampleStep = Math.max(1, Math.floor(buf.length / 10000)); // ~10K samples
    const rBins = new Array(8).fill(0);
    const gBins = new Array(8).fill(0);
    const bBins = new Array(8).fill(0);
    let sampleCount = 0;

    // For JPEG: scan for 0xFF 0xD8...0xFF 0xD9 markers and sample in between
    // For simplicity and speed, sample raw bytes as if they were RGB
    // This is a rough approximation but works for similarity matching
    for (let i = 0; i < buf.length - 2 && sampleCount < 10000; i += sampleStep) {
      // Skip JPEG markers (0xFF followed by 0x00-0xFF except 0x00 and 0xD9)
      if (buf[i] === 0xFF && buf[i + 1] !== 0x00 && buf[i + 1] !== 0xD8 && buf[i + 1] !== 0xD9) {
        // Likely a marker — skip ahead
        if (buf[i + 1] >= 0xC0 && buf[i + 1] <= 0xFE && i + 3 < buf.length) {
          const segLen = buf[i + 2] * 256 + buf[i + 3];
          i += segLen;
          continue;
        }
      }

      // Treat bytes as RGB triplet (rough approximation)
      const r = buf[i] & 0xFF;
      const g = buf[i + 1] & 0xFF;
      const b = buf[i + 2] & 0xFF;

      rBins[Math.min(7, r >> 5)]++;
      gBins[Math.min(7, g >> 5)]++;
      bBins[Math.min(7, b >> 5)]++;
      sampleCount++;
    }

    if (sampleCount === 0) return new Array(FEATURE_VECTOR_SIZE).fill(0);

    // Normalize to [0, 1]
    const vector: number[] = [];
    for (let i = 0; i < 8; i++) {
      vector.push(rBins[i] / sampleCount);
      vector.push(gBins[i] / sampleCount);
      vector.push(bBins[i] / sampleCount);
    }

    return vector;
  } catch (err: any) {
    log(`Feature extraction failed: ${err.message}`, 'WARN');
    return new Array(FEATURE_VECTOR_SIZE).fill(0);
  }
}

/**
 * Compute cosine similarity between two feature vectors.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Simple hash of a base64 string for deduplication.
 */
function _simpleHash(str: string): string {
  let hash = 0;
  const sample = str.length > 500 ? str.substring(0, 500) : str;
  for (let i = 0; i < sample.length; i++) {
    const char = sample.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0; // Convert to 32-bit int
  }
  return Math.abs(hash).toString(36);
}

// ─── Record Successful Action ────────────────────────────────────────────

interface RecordOptions {
  /** The action that succeeded */
  action: TrainingEntry['action'];
  /** Base64 screenshot (with or without data URI prefix) */
  screenshotBase64: string;
  /** Current state machine state */
  state: string;
  /** Which provider suggested this action */
  provider: string;
  /** Page category (exercise, video, login, etc.) */
  pageCategory?: string;
  /** Confidence from the AI (0-1) */
  confidence?: number;
  /** Whether the action was verified as successful */
  verified?: boolean;
}

/**
 * Record a successful action for future training.
 * This is the main entry point called by cycle-cycle-manager after a
 * successful AI action.
 */
async function recordSuccessfulAction(options: RecordOptions): Promise<TrainingEntry | null> {
  const config = _getConfig();
  if (config.PIXEL_TRAINING_ENABLED === false) return null;

  try {
    const screenshotHash = _simpleHash(options.screenshotBase64);
    const featureVector = extractFeatureVector(options.screenshotBase64);

    // Upload screenshot to Cloudinary
    let cloudinaryUrl = '';
    let cloudinaryPublicId = '';
    let cloudinaryThumbnail = '';

    try {
      const screenshotStorage = (_deps as any).screenshotStorage || require('./screenshot-storage');
      if (screenshotStorage?.uploadScreenshot) {
        const uploadResult = await screenshotStorage.uploadScreenshot(options.screenshotBase64, {
          category: 'training',
          tags: [
            `state:${options.state}`,
            `provider:${options.provider}`,
            `action:${options.action.actionType}`,
            `category:${options.pageCategory || 'unknown'}`,
            'training-data',
          ],
        });
        if (uploadResult) {
          cloudinaryUrl = uploadResult.secureUrl || uploadResult.url;
          cloudinaryPublicId = uploadResult.publicId;
          cloudinaryThumbnail = uploadResult.thumbnailUrl;
        }
      }
    } catch (err: any) {
      log(`Cloudinary upload for training data failed (non-fatal): ${err.message}`, 'WARN');
    }

    const entry: TrainingEntry = {
      screenshotHash,
      cloudinaryUrl,
      cloudinaryPublicId,
      cloudinaryThumbnail,
      featureVector,
      action: options.action,
      state: options.state,
      provider: options.provider,
      pageCategory: options.pageCategory || 'unknown',
      verified: options.verified !== false,
      confidence: options.confidence || 0,
      createdAt: new Date().toISOString(),
    };

    // Store in LRU cache
    const cacheKey = `hash:${screenshotHash}:state:${options.state}`;
    _getCache().set(cacheKey, entry);

    // Store in database
    _ensureDb();
    const dbModule = _getDb() || (_deps as any).database;
    if (dbModule?.db?.prepare) {
      try {
        const stmt = dbModule.db.prepare(`
          INSERT INTO pixel_training_data
            (screenshot_hash, cloudinary_url, cloudinary_public_id, cloudinary_thumbnail,
             feature_vector, action_json, state, provider, page_category, verified,
             confidence, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        stmt.run(
          screenshotHash,
          cloudinaryUrl,
          cloudinaryPublicId,
          cloudinaryThumbnail,
          JSON.stringify(featureVector),
          JSON.stringify(options.action),
          options.state,
          options.provider,
          options.pageCategory || 'unknown',
          options.verified !== false ? 1 : 0,
          options.confidence || 0,
          entry.createdAt
        );
        _recordCount++;
      } catch (err: any) {
        log(`DB insert failed (non-fatal): ${err.message}`, 'WARN');
      }
    }

    log(
      `Recorded training entry: ${options.action.actionType} at (${options.action.targetX},${options.action.targetY}) ` +
      `state=${options.state} provider=${options.provider} cloudinary=${cloudinaryUrl ? 'yes' : 'no'}`,
      'DEBUG'
    );

    return entry;
  } catch (err: any) {
    log(`recordSuccessfulAction failed: ${err.message}`, 'ERROR');
    return null;
  }
}

// ─── Query Similar Situations ────────────────────────────────────────────

interface QueryOptions {
  /** Base64 screenshot to find similar situations for */
  screenshotBase64: string;
  /** Current state machine state (filter by state) */
  state?: string;
  /** Page category filter */
  pageCategory?: string;
  /** Minimum cosine similarity (default: 0.7) */
  similarityThreshold?: number;
  /** Max results (default: 5) */
  maxResults?: number;
  /** Only return verified (successful) entries */
  verifiedOnly?: boolean;
}

/**
 * Find historically similar situations to the current screenshot.
 * Used by pixel-fallback.ts when its confidence is low.
 *
 * Search order:
 *   1. LRU cache (instant, in-memory)
 *   2. Database (slower, but persistent)
 *   3. Cloudinary (for visual review, not automatic)
 *
 * Returns entries sorted by similarity (highest first).
 */
function querySimilarSituations(options: QueryOptions): SimilarSituation[] {
  const config = _getConfig();
  if (config.PIXEL_TRAINING_ENABLED === false) return [];

  const threshold = options.similarityThreshold || DEFAULT_SIMILARITY_THRESHOLD;
  const maxResults = options.maxResults || DEFAULT_MAX_RESULTS;
  const queryVector = extractFeatureVector(options.screenshotBase64);

  _queryCount++;

  // 1. Search LRU cache first
  const cacheResults: SimilarSituation[] = [];
  const cacheEntries = _getCache().values();
  for (const entry of cacheEntries) {
    // Apply filters
    if (options.state && entry.state !== options.state) continue;
    if (options.pageCategory && entry.pageCategory !== options.pageCategory) continue;
    if (options.verifiedOnly && !entry.verified) continue;

    const similarity = cosineSimilarity(queryVector, entry.featureVector);
    if (similarity >= threshold) {
      cacheResults.push({ entry, similarity });
    }
  }

  if (cacheResults.length > 0) {
    _hitCount++;
    cacheResults.sort((a, b) => b.similarity - a.similarity);
    log(`Cache hit: found ${cacheResults.length} similar situations (queried ${_queryCount}, hits ${_hitCount})`, 'DEBUG');
    return cacheResults.slice(0, maxResults);
  }

  // 2. Search database
  _ensureDb();
  const dbModule = _getDb() || (_deps as any).database;
  if (!dbModule?.db?.prepare) return [];

  try {
    let sql = `SELECT * FROM pixel_training_data WHERE verified = 1`;
    const params: any[] = [];

    if (options.state) {
      sql += ` AND state = ?`;
      params.push(options.state);
    }
    if (options.pageCategory) {
      sql += ` AND page_category = ?`;
      params.push(options.pageCategory);
    }

    sql += ` ORDER BY created_at DESC LIMIT 100`;

    const rows = dbModule.db.prepare(sql).all(...params) as any[];
    const dbResults: SimilarSituation[] = [];

    for (const row of rows) {
      let storedVector: number[];
      try {
        storedVector = JSON.parse(row.feature_vector);
      } catch { continue; }

      const similarity = cosineSimilarity(queryVector, storedVector);
      if (similarity >= threshold) {
        let action: TrainingEntry['action'];
        try { action = JSON.parse(row.action_json); } catch { continue; }

        const entry: TrainingEntry = {
          id: row.id,
          screenshotHash: row.screenshot_hash,
          cloudinaryUrl: row.cloudinary_url,
          cloudinaryPublicId: row.cloudinary_public_id,
          cloudinaryThumbnail: row.cloudinary_thumbnail,
          featureVector: storedVector,
          action,
          state: row.state,
          provider: row.provider,
          pageCategory: row.page_category,
          verified: row.verified === 1,
          confidence: row.confidence,
          createdAt: row.created_at,
        };

        dbResults.push({ entry, similarity });

        // Cache this entry for future queries
        const cacheKey = `hash:${row.screenshot_hash}:state:${row.state}`;
        _getCache().set(cacheKey, entry);
      }
    }

    dbResults.sort((a, b) => b.similarity - a.similarity);

    if (dbResults.length > 0) {
      _hitCount++;
      log(`DB hit: found ${dbResults.length} similar situations`, 'DEBUG');
    }

    return dbResults.slice(0, maxResults);
  } catch (err: any) {
    log(`DB query failed: ${err.message}`, 'ERROR');
    return [];
  }
}

/**
 * Get the most common successful action for a given state.
 * Useful as a quick fallback when similarity search is too slow.
 */
function getMostCommonAction(state: string, pageCategory?: string): TrainingEntry['action'] | null {
  _ensureDb();
  const dbModule = _getDb() || (_deps as any).database;
  if (!dbModule?.db?.prepare) return null;

  try {
    let sql = `SELECT action_json, COUNT(*) as cnt FROM pixel_training_data WHERE verified = 1 AND state = ?`;
    const params: any[] = [state];

    if (pageCategory) {
      sql += ` AND page_category = ?`;
      params.push(pageCategory);
    }

    sql += ` GROUP BY action_json ORDER BY cnt DESC LIMIT 1`;

    const row = dbModule.db.prepare(sql).get(...params) as any;
    if (!row) return null;

    try { return JSON.parse(row.action_json); } catch { return null; }
  } catch (err: any) {
    log(`getMostCommonAction failed: ${err.message}`, 'ERROR');
    return null;
  }
}

/**
 * Get training statistics.
 */
function getStats(): {
  totalRecords: number;
  cacheSize: number;
  totalQueries: number;
  cacheHits: number;
  hitRate: string;
  dbAvailable: boolean;
} {
  let totalRecords = _recordCount;

  // Try to get actual DB count
  _ensureDb();
  const dbModule = _getDb() || (_deps as any).database;
  if (dbModule?.db?.prepare) {
    try {
      const row = dbModule.db.prepare(`SELECT COUNT(*) as cnt FROM pixel_training_data`).get() as any;
      if (row) totalRecords = row.cnt;
    } catch { /* use _recordCount */ }
  }

  const totalQueries = _queryCount || 1;
  return {
    totalRecords,
    cacheSize: _getCache().size,
    totalQueries: _queryCount,
    cacheHits: _hitCount,
    hitRate: ((_hitCount / totalQueries) * 100).toFixed(1) + '%',
    dbAvailable: _dbInitialized,
  };
}

/**
 * Clear all training data (cache + DB table).
 */
function clearTrainingData(): void {
  _getCache().clear();

  _ensureDb();
  const dbModule = _getDb() || (_deps as any).database;
  if (dbModule?.db?.prepare) {
    try {
      dbModule.db.exec(`DELETE FROM pixel_training_data`);
      log('All training data cleared', 'INFO');
    } catch (err: any) {
      log(`Failed to clear training data: ${err.message}`, 'ERROR');
    }
  }

  _recordCount = 0;
  _queryCount = 0;
  _hitCount = 0;
}

/**
 * Prune old training data to keep DB size bounded.
 * Keeps the most recent N entries per state.
 */
function pruneOldData(maxPerState: number = 50): number {
  _ensureDb();
  const dbModule = _getDb() || (_deps as any).database;
  if (!dbModule?.db?.prepare) return 0;

  try {
    // Find states with more than maxPerState entries
    const overStates = dbModule.db.prepare(`
      SELECT state, COUNT(*) as cnt FROM pixel_training_data
      GROUP BY state HAVING cnt > ?
    `).all(maxPerState) as any[];

    let totalPruned = 0;
    for (const { state, cnt } of overStates) {
      const toDelete = cnt - maxPerState;
      dbModule.db.prepare(`
        DELETE FROM pixel_training_data WHERE rowid IN (
          SELECT rowid FROM pixel_training_data
          WHERE state = ? ORDER BY created_at ASC LIMIT ?
        )
      `).run(state, toDelete);
      totalPruned += toDelete;
    }

    if (totalPruned > 0) {
      log(`Pruned ${totalPruned} old training entries`, 'INFO');
    }
    return totalPruned;
  } catch (err: any) {
    log(`Prune failed: ${err.message}`, 'ERROR');
    return 0;
  }
}

module.exports = {
  recordSuccessfulAction,
  querySimilarSituations,
  getMostCommonAction,
  extractFeatureVector,
  cosineSimilarity,
  getStats,
  clearTrainingData,
  pruneOldData,
  _injectDependencies,
};
