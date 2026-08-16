'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const CONFIG = require('./get-config');

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  'this', 'that', 'not', 'can', 'has', 'had', 'been', 'have', 'will',
  'would', 'could', 'should', 'do', 'if', 'then', 'else', 'return',
  'function', 'const', 'let', 'var', 'async', 'await', 'try', 'catch',
  'new', 'null', 'undefined', 'true', 'false', 'require', 'module',
  'exports', 'class', 'import', 'default', 'throw', 'finally', 'while',
]);

const DEFAULT_TOP_K = 5;
const MAX_RETRIEVE_FOR_SEARCH = 200;
const TOP_KEYWORDS = 20;
const PRUNE_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000; // 90 days

// Lazy-loaded transformer pipeline
let _pipeline: any = null;
let _pipelineLoadAttempted = false;

/**
 * Attempts to load @xenova/transformers pipeline for real embeddings.
 * Returns null if not available.
 */
async function _loadEmbeddingPipeline() { 
  if (_pipelineLoadAttempted) return _pipeline;
  _pipelineLoadAttempted = true;
  try {
    const { pipeline } = require('@xenova/transformers');
    _pipeline = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
    log('Loaded @xenova/transformers embedding pipeline', 'INFO', 'patch-memory');
  } catch (err: any) {
    log('@xenova/transformers not available, using keyword fingerprint fallback', 'DEBUG', 'patch-memory');
    _pipeline = null;
  }
  return _pipeline;
}

/**
 * Tokenizes text into lowercase words, filtering stop words.
 */
function _tokenize(text: any) { 
  if (!text || typeof text !== 'string') return [];
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP_WORDS.has(w));
}

/**
 * Computes a TF-IDF-style keyword fingerprint: top N words with their frequencies.
 * Returns { words: string[], weights: number[], fingerprint: string }
 */
function _computeFingerprint(text: any) { 
  try {
    const tokens = _tokenize(text);
    if (tokens.length === 0) {
      return { words: [], weights: [], fingerprint: '' };
    }

    // Term frequency
    const freq = {};
    for (const token of tokens) {
      (freq as any)[token] = ((freq as any)[token] || 0) + 1;
    }

    // Sort by frequency, take top N
    const sorted = Object.entries(freq)
      .sort((a: any, b: any) => (b as any)[1] - (a as any)[1])
      .slice(0, TOP_KEYWORDS);

    const words = sorted.map(([w]) => w);
    const maxFreq = sorted[0] ? sorted[0][1] : 1;
    const weights = sorted.map(([, c]: any) => (c as any) / (maxFreq as any));

    // Create a hash-based fingerprint string for storage
    const fingerprint = words.join('|');

    return { words, weights, fingerprint };
  } catch (err: any) {
    logError('_computeFingerprint failed', err, { module: 'patch-memory' });
    return { words: [], weights: [], fingerprint: '' };
  }
}

/**
 * Computes Jaccard similarity between two sets of keywords.
 */
function _jaccardSimilarity(setA: any, setB: any) { 
  const a = new Set(setA);
  const b = new Set(setB);
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Computes cosine similarity between two number arrays.
 */
function _cosineSimilarity(vecA: any, vecB: any) { 
  if (!vecA || !vecB || vecA.length !== vecB.length || vecA.length === 0) return 0;
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < vecA.length; i++) {
    dotProduct += vecA[i] * vecB[i];
    normA += vecA[i] * vecA[i];
    normB += vecB[i] * vecB[i];
  }
  normA = Math.sqrt(normA);
  normB = Math.sqrt(normB);
  if (normA === 0 || normB === 0) return 0;
  return dotProduct / (normA * normB);
}

class PatchMemory {
  constructor() {
    this._ensureTable();
  }

  _ensureTable() { 
    try {
      getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS patch_embeddings (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patch_id TEXT NOT NULL,
          timestamp INTEGER NOT NULL,
          investigation_context TEXT,
          file TEXT,
          patch_text TEXT,
          status TEXT DEFAULT 'pending',
          embedding_type TEXT DEFAULT 'fingerprint',
          fingerprint TEXT,
          weights TEXT,
          embedding BLOB,
          FOREIGN KEY (patch_id) REFERENCES patch_history(id)
        );
        CREATE INDEX IF NOT EXISTS idx_patch_emb_ts ON patch_embeddings(timestamp);
        CREATE INDEX IF NOT EXISTS idx_patch_emb_status ON patch_embeddings(status);
        CREATE INDEX IF NOT EXISTS idx_patch_emb_file ON patch_embeddings(file);
      `);
    } catch (err: any) {
      logError('Failed to create patch_embeddings table', err, { module: 'patch-memory' });
    }
  }

  /**
   * Stores a patch with its embedding/fingerprint for similarity search.
   * @param {string} patchId
   * @param {string} investigationContext
   * @param {string} file
   * @param {string} patchText
   * @param {string} status - 'pending' | 'applied' | 'rejected' | 'rolled_back' | 'superseded'
   */
  async storePatch(patchId: any, investigationContext: any, file: any, patchText: any, status = 'pending') { 
    try {
      if (!patchId || typeof patchId !== 'string') {
        log('storePatch: invalid patchId', 'WARN', 'patch-memory');
        return false;
      }

      const timestamp = Date.now();
      const contextText = investigationContext || '';

      // Try real embeddings first
      const pipe = await _loadEmbeddingPipeline();
      let embeddingType = 'fingerprint';
      let embedding = null;
      let fingerprint = '';
      let weights = '';

      if (pipe) {
        try {
          const output = await pipe(contextText, { pooling: 'mean', normalize: true });
          const embeddingData = Array.from(output.data);
          // Store as Float32Array buffer
// @ts-expect-error
          embedding = Buffer.from(new Float32Array(embeddingData).buffer);
          embeddingType = 'transformer';
          log(`Computed real embedding (${embeddingData.length}d) for patch ${patchId}`, 'DEBUG', 'patch-memory');
        } catch (embedErr: any) {
          log('Real embedding computation failed, falling back to fingerprint', 'WARN', 'patch-memory');
        }
      }

      // Always compute fingerprint as fallback/backup
      const fp = _computeFingerprint(contextText);
      fingerprint = fp.fingerprint;
      weights = JSON.stringify(fp.weights);

      const insertStmt = getDb()?.prepare(`
        INSERT INTO patch_embeddings (patch_id, timestamp, investigation_context, file, patch_text, status, embedding_type, fingerprint, weights, embedding)
        VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertStmt.run(
        patchId, timestamp,
        (contextText || '').substring(0, 50000),
        (file || '').substring(0, 500),
        (patchText || '').substring(0, 100000),
        status.substring(0, 50),
        embeddingType,
        fingerprint.substring(0, 2000),
        weights.substring(0, 10000),
        embedding
      );

      log(`Stored patch ${patchId} (type=${embeddingType}, status=${status})`, 'INFO', 'patch-memory');
      return true;
    } catch (err: any) {
      logError('storePatch failed', err, { module: 'patch-memory' });
      return false;
    }
  }

  /**
   * Searches for similar past patches based on the current context.
   * @param {string} context - Investigation context text
   * @param {number} topK - Number of results to return
   * @returns {Array} Top-K similar patches with similarity scores
   */
  async searchSimilar(context: any, topK: any) { 
    topK = Math.max(1, Math.min(20, Math.floor(topK || CONFIG.PATCH_MEMORY_TOP_K || DEFAULT_TOP_K)));
    const results: any[] = [];

    try {
      if (!context || typeof context !== 'string') {
        log('searchSimilar: invalid context', 'WARN', 'patch-memory');
        return results;
      }

      // Compute embedding/fingerprint for query
      const pipe = await _loadEmbeddingPipeline();
      let queryEmbedding = null;
      const fp = _computeFingerprint(context);

      if (pipe) {
        try {
          const output = await pipe(context, { pooling: 'mean', normalize: true });
          queryEmbedding = Array.from(output.data);
        } catch (embedErr: any) {
          // Fall back to fingerprint
        }
      }

      // Retrieve recent patches for comparison
      const rows = getDb()?.prepare(`
        SELECT * FROM patch_embeddings
        ORDER BY timestamp DESC
        LIMIT ?
      `).all(MAX_RETRIEVE_FOR_SEARCH);

      if (!rows || !Array.isArray(rows)) {
        return results;
      }

      // Compute similarities
      const scored = [];
      for (const row of rows) {
        let similarity = 0;

        if (queryEmbedding && row.embedding_type === 'transformer' && row.embedding) {
          // Real cosine similarity
          try {
            const storedEmbedding = Array.from(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, row.embedding.byteLength / 4));
            similarity = _cosineSimilarity(queryEmbedding, storedEmbedding);
          } catch (parseErr: any) {
            // Fall back to Jaccard
            similarity = _jaccardSimilarity(fp.words, (row.fingerprint || '').split('|'));
          }
        } else {
          // Fingerprint/Jaccard similarity
          similarity = _jaccardSimilarity(fp.words, (row.fingerprint || '').split('|'));
        }

        scored.push({
          patchId: row.patch_id,
          file: row.file,
          patchText: row.patch_text,
          status: row.status,
          similarity: Math.round(similarity * 1000) / 1000, // 3 decimal places
          timestamp: row.timestamp,
          embeddingType: row.embedding_type,
        });
      }

      // Sort by similarity descending, take top-K
      scored.sort((a, b) => b.similarity - a.similarity);
      const topResults = scored.slice(0, topK);

      log(`searchSimilar: found ${rows.length} patches, returning top ${topResults.length}`, 'DEBUG', 'patch-memory');
      return topResults;
    } catch (err: any) {
      logError('searchSimilar failed', err, { module: 'patch-memory' });
      return results;
    }
  }

  /**
   * Returns the patch text of the most similar successful patch.
   * Used as a seed for codegen tribunal.
   * @param {object} similarPatch - A result from searchSimilar
   * @returns {string|null}
   */
  getPatchSeed(similarPatch: any) { 
    try {
      if (!similarPatch || !similarPatch.patchText) {
        return null;
      }
      return similarPatch.patchText;
    } catch (err: any) {
      logError('getPatchSeed failed', err, { module: 'patch-memory' });
      return null;
    }
  }

  /**
   * Builds a formatted context string with few-shot examples from similar past fixes.
   * @param {string} context - Current investigation context
   * @returns {string} Formatted few-shot examples for tribunal prompt
   */
  async buildContextForTribunal(context: any) { 
    try {
      const similar = await this.searchSimilar(context, null as any);
      if (!similar || similar.length === 0) {
        return 'No similar past fixes found.';
      }

      const lines = ['Similar past fixes:'];
      for (let i = 0; i < similar.length; i++) {
        const p = similar[i];
        const patchPreview = (p.patchText || '').substring(0, 500);
        const statusLabel = p.status === 'applied' ? 'APPLIED' : p.status === 'rejected' ? 'REJECTED' : p.status.toUpperCase();
        lines.push(
          `${i + 1}. [similarity: ${p.similarity}] File: ${p.file}, Status: ${statusLabel}, Fix: ${patchPreview}`
        );
      }

      return lines.join('\n');
    } catch (err: any) {
      logError('buildContextForTribunal failed', err, { module: 'patch-memory' });
      return 'Error retrieving similar past fixes.';
    }
  }

  /**
   * Records the outcome of a patch after it has been evaluated.
   * @param {string} patchId
   * @param {string} outcome - 'applied' | 'rejected' | 'rolled_back' | 'superseded'
   */
  recordOutcome(patchId: any, outcome: any) { 
    try {
      if (!patchId || !outcome) {
        log('recordOutcome: missing patchId or outcome', 'WARN', 'patch-memory');
        return false;
      }

      const validOutcomes = new Set(['applied', 'rejected', 'rolled_back', 'superseded']);
      if (!validOutcomes.has(outcome)) {
        log(`recordOutcome: invalid outcome "${outcome}"`, 'WARN', 'patch-memory');
        return false;
      }

      const result = getDb()?.prepare(
        'UPDATE patch_embeddings SET status = ? WHERE patch_id = ?'
      ).run(outcome, patchId);

      if (result.changes > 0) {
        log(`Recorded outcome "${outcome}" for patch ${patchId}`, 'INFO', 'patch-memory');
// @ts-expect-error
        logAudit('patch_outcome_recorded', `patchId=${patchId}, outcome=${outcome}`);
        return true;
      } else {
        log(`No patch_embeddings row found for patchId ${patchId}`, 'WARN', 'patch-memory');
        return false;
      }
    } catch (err: any) {
      logError('recordOutcome failed', err, { module: 'patch-memory' });
      return false;
    }
  }

  /**
   * Prunes old non-applied patch embeddings beyond maxAge.
   * Now handles 'rejected', 'rolled_back', AND 'superseded' statuses.
   * @param {number} maxAge - Maximum age in ms (default 90 days)
   */
  pruneOld(maxAge = PRUNE_MAX_AGE_MS) { 
    try {
      const cutoff = Date.now() - maxAge;
      const result = getDb()?.prepare(
        `DELETE FROM patch_embeddings WHERE status IN ('rejected', 'rolled_back', 'superseded') AND timestamp < ?`
      ).run(cutoff);

      if (result.changes > 0) {
        log(`Pruned ${result.changes} non-applied patch embeddings older than ${Math.round(maxAge / (24 * 60 * 60 * 1000))} days`, 'INFO', 'patch-memory');
      }
      return result.changes;
    } catch (err: any) {
      logError('pruneOld failed', err, { module: 'patch-memory' });
      return 0;
    }
  }
}

module.exports = Object.assign(new PatchMemory(), { _injectDependencies });
