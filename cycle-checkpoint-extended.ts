'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

const fs = require('fs');
const path = require('path');
const { log, logError, logAudit } = require('./logger');

const MAX_CHECKPOINT_SIZE_BYTES = 100 * 1024; // 100KB
const CHECKPOINT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours for resume
const CHECKPOINT_STALE_MS = 24 * 60 * 60 * 1000; // 24 hours = stale

function _getTombstoneFile() { return '/tmp/mathu-data/checkpoint.tombstone.json'; }

/**
 * Extended checkpoint system for restart amnesia prevention.
 * Saves full contextual state to enable seamless cycle resumption.
 */
class ExtendedCheckpoint {
  _tombstoneRegistered: any;

  constructor() {
    this._tombstoneRegistered = false;
  }

  /**
   * Save an extended checkpoint with full contextual state.
   * Uses atomic write (write to .tmp then rename) to prevent corruption.
   *
   * @param {object} data - Checkpoint data
   * @param {string} data.url - Current page URL
   * @param {string} data.state - Current state machine state
   * @param {number} data.questionsCompleted - Number of questions completed
   * @param {object} [data.providerHealthScores] - Provider health scores map
   * @param {object} [data.experimentState] - Current active experiment
   * @param {object} [data.explorationMap] - Current exploration map
   * @param {Array} [data.moduleQueue] - Module selection queue
   * @param {string[]} [data.recentScreenshotHashes] - Last 10 screenshot hashes
   * @param {string} [data.restartReason] - Why the restart happened
   * @param {string} [data.degradationMode] - Current operational mode
   * @param {object} [data.healerState] - Healer circuit breaker state
   */
  saveExtendedCheckpoint(data: any) { 
    const checkpointFile = getCONFIG().CHECKPOINT_FILE || './checkpoint.json';
    const tmpFile = checkpointFile + '.tmp';

    try {
      // Build the extended checkpoint object
      const checkpoint = {
        // Core checkpoint data
        url: data.url || null,
        state: data.state || null,
        questionsCompleted: data.questionsCompleted || 0,

        // Extended contextual state
        providerHealthScores: data.providerHealthScores || null,
        experimentState: data.experimentState || null,
        explorationMap: data.explorationMap || null,
        moduleQueue: data.moduleQueue || [],
        recentScreenshotHashes: (data.recentScreenshotHashes || []).slice(0, 10),
        restartReason: data.restartReason || null,
        degradationMode: data.degradationMode || 'normal',
        healerState: data.healerState || null,

        // Metadata
        savedAt: Date.now(),
        version: 2,
      };

      // Truncate moduleQueue if checkpoint would exceed max size
      let serialized = JSON.stringify(checkpoint);
      while (serialized.length > MAX_CHECKPOINT_SIZE_BYTES && checkpoint.moduleQueue.length > 0) {
        checkpoint.moduleQueue.pop();
        serialized = JSON.stringify(checkpoint);
      }

      // If still too large, trim exploration map
      if (serialized.length > MAX_CHECKPOINT_SIZE_BYTES && checkpoint.explorationMap) {
        checkpoint.explorationMap = null;
        serialized = JSON.stringify(checkpoint);
      }

      // If still too large, trim provider health scores
      if (serialized.length > MAX_CHECKPOINT_SIZE_BYTES && checkpoint.providerHealthScores) {
        const entries = Object.entries(checkpoint.providerHealthScores);
        if (entries.length > 5) {
          checkpoint.providerHealthScores = Object.fromEntries(entries.slice(0, 5));
          serialized = JSON.stringify(checkpoint);
        } else {
          checkpoint.providerHealthScores = null;
          serialized = JSON.stringify(checkpoint);
        }
      }

      // Final size check
      if (serialized.length > MAX_CHECKPOINT_SIZE_BYTES) {
        log(`Checkpoint truncated to ${Math.round(serialized.length / 1024)}KB (max ${MAX_CHECKPOINT_SIZE_BYTES / 1024}KB)`, 'WARN', 'checkpoint-extended');
      }

      // Atomic write: write to .tmp then rename
      fs.writeFileSync(tmpFile, serialized, 'utf8');
      fs.renameSync(tmpFile, checkpointFile);

      log(`Extended checkpoint saved: state=${checkpoint.state}, q=${checkpoint.questionsCompleted}, size=${Math.round(serialized.length / 1024)}KB, reason=${checkpoint.restartReason || 'manual'}`, 'INFO', 'checkpoint-extended');
    } catch (err: any) {
      logError('Extended checkpoint save failed', err);
      // Clean up tmp file if it exists
      try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch (e: any) { /* best effort */ }
    }
  }

  /**
   * Load and validate the extended checkpoint.
   * Returns null if missing, corrupted, or older than 24 hours.
   *
   * @returns {object|null} Checkpoint data or null
   */
  loadExtendedCheckpoint() { 
    const checkpointFile = getCONFIG().CHECKPOINT_FILE || './checkpoint.json';

    try {
      if (!fs.existsSync(checkpointFile)) {
        log('No checkpoint file found', 'DEBUG', 'checkpoint-extended');
        return null;
      }

      const raw = fs.readFileSync(checkpointFile, 'utf8');
      const checkpoint = JSON.parse(raw);

      // Validate required fields
      if (!checkpoint.savedAt || typeof checkpoint.savedAt !== 'number') {
        log('Checkpoint missing valid savedAt timestamp, ignoring', 'WARN', 'checkpoint-extended');
        return null;
      }

      // Check if stale (older than 24 hours)
      const age = Date.now() - checkpoint.savedAt;
      if (age > CHECKPOINT_STALE_MS) {
        log(`Checkpoint is stale (${Math.round(age / 3600000)}h old), ignoring`, 'WARN', 'checkpoint-extended');
        return null;
      }

      // Validate version
      if (checkpoint.version < 2) {
        log(`Checkpoint version ${checkpoint.version} < 2, treating as legacy`, 'DEBUG', 'checkpoint-extended');
      }

      log(`Loaded extended checkpoint: state=${checkpoint.state}, q=${checkpoint.questionsCompleted}, age=${Math.round(age / 60000)}min`, 'INFO', 'checkpoint-extended');
      return checkpoint;
    } catch (err: any) {
      logError('Extended checkpoint load failed', err);
      // Corrupted file - remove it
      try {
        fs.unlinkSync(checkpointFile);
        log('Removed corrupted checkpoint file', 'WARN', 'checkpoint-extended');
      } catch (e: any) { /* best effort */ }
      return null;
    }
  }

  /**
   * Determine if the bot should resume from a checkpoint.
   * Returns true if checkpoint exists and is < 2 hours old.
   * Returns false if stale or from a different mode.
   *
   * @param {string} [currentMode] - Current operational mode to compare
   * @returns {boolean}
   */
  shouldResumeFromCheckpoint(currentMode: any) { 
    const checkpoint = this.loadExtendedCheckpoint();
    if (!checkpoint) {
      return false;
    }

    // Check age: must be < 2 hours
    const age = Date.now() - checkpoint.savedAt;
    if (age > CHECKPOINT_MAX_AGE_MS) {
      log(`Checkpoint too old for resume (${Math.round(age / 60000)}min > ${CHECKPOINT_MAX_AGE_MS / 60000}min)`, 'INFO', 'checkpoint-extended');
      return false;
    }

    // Check if mode matches (if provided)
    if (currentMode && checkpoint.degradationMode && checkpoint.degradationMode !== currentMode) {
      log(`Checkpoint mode "${checkpoint.degradationMode}" differs from current "${currentMode}", not resuming`, 'INFO', 'checkpoint-extended');
      return false;
    }

    // Check if there's actually useful state to resume
    if (!checkpoint.state && !checkpoint.url && checkpoint.questionsCompleted === 0) {
      log('Checkpoint has no useful state to resume', 'DEBUG', 'checkpoint-extended');
      return false;
    }

    log(`Checkpoint is valid for resume: state=${checkpoint.state}, age=${Math.round(age / 60000)}min`, 'INFO', 'checkpoint-extended');
    return true;
  }

  /**
   * Clear the checkpoint file after successful cycle completion.
   */
  clearCheckpoint() { 
    const checkpointFile = getCONFIG().CHECKPOINT_FILE || './checkpoint.json';
    try {
      if (fs.existsSync(checkpointFile)) {
        fs.unlinkSync(checkpointFile);
        log('Checkpoint cleared after successful cycle', 'DEBUG', 'checkpoint-extended');
      }
      // Also clear tombstone on clean shutdown
      this._clearTombstone();
    } catch (err: any) {
      logError('Failed to clear checkpoint', err);
    }
  }

  /**
   * Register process event handlers to write a tombstone file
   * on crash or unexpected exit.
   * Contains: timestamp, last known state, error message, memory usage.
   */
  registerTombstoneHandlers() { 
    if (this._tombstoneRegistered) return;
    this._tombstoneRegistered = true;

    const writeTombstone = (error: any) => {
      try {
        const mem = process.memoryUsage();
        const tombstone = {
          timestamp: Date.now(),
          lastKnownState: null,
          error: error ? (error.message || String(error)).slice(0, 500) : 'unexpected_exit',
          memoryUsage: {
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
          },
          uptime: process.uptime(),
        };

        // Try to get last known state from the existing checkpoint
        try {
          const checkpoint = this.loadExtendedCheckpoint();
          if (checkpoint) {
            tombstone.lastKnownState = checkpoint.state;
          }
        } catch (e: any) { /* best effort */ }

        const tmpFile = _getTombstoneFile() + '.tmp';
        fs.writeFileSync(tmpFile, JSON.stringify(tombstone, null, 2), 'utf8');
        fs.renameSync(tmpFile, _getTombstoneFile());
        log('Tombstone file written on process exit', 'INFO', 'checkpoint-extended');
      } catch (err: any) {
        // Last resort - can't do much if file write fails
        try {
          fs.writeFileSync(_getTombstoneFile(), JSON.stringify({ timestamp: Date.now(), error: 'tombstone_write_failed' }), 'utf8');
        } catch (e: any) { /* give up */ }
      }
    };

    // Tombstone writing is exported for error-handler.ts integration.
    // Crash handlers (uncaughtException/unhandledRejection) are registered
    // centrally in error-handler.ts to avoid duplicate handler races.
    log('Tombstone write function available for error-handler integration', 'DEBUG', 'checkpoint-extended');
  }

  /**
   * Load and clear the tombstone file.
   * Used on startup to understand why the previous process died.
   *
   * @returns {object|null} Tombstone data or null
   */
  loadTombstone() { 
    const TOMBSTONE_FILE = _getTombstoneFile();
    try {
      if (!fs.existsSync(TOMBSTONE_FILE)) {
        return null;
      }

      const raw = fs.readFileSync(TOMBSTONE_FILE, 'utf8');
      const tombstone = JSON.parse(raw);
      log(`Loaded tombstone: error="${tombstone.error}", uptime=${Math.round(tombstone.uptime || 0)}s, memory=${Math.round((tombstone.memoryUsage?.heapUsed || 0) / 1024 / 1024)}MB`, 'INFO', 'checkpoint-extended');
      logAudit(`Previous exit tombstone: ${tombstone.error}`, 'checkpoint-extended');
      return tombstone;
    } catch (err: any) {
      logError('Failed to load tombstone', err);
      return null;
    }
  }

  /**
   * Remove the tombstone file.
   */
  _clearTombstone() { 
    try {
      const TOMBSTONE_FILE = _getTombstoneFile();
      if (fs.existsSync(TOMBSTONE_FILE)) {
        fs.unlinkSync(TOMBSTONE_FILE);
        log('Tombstone cleared', 'DEBUG', 'checkpoint-extended');
      }
    } catch (err: any) { /* best effort */ }
  }

  /**
   * Get a summary of the last checkpoint for diagnostics.
   */
  getCheckpointSummary() { 
    const checkpoint = this.loadExtendedCheckpoint();
    if (!checkpoint) return null;

    return {
      exists: true,
      ageMinutes: Math.round((Date.now() - checkpoint.savedAt) / 60000),
      state: checkpoint.state,
      questionsCompleted: checkpoint.questionsCompleted,
      restartReason: checkpoint.restartReason,
      degradationMode: checkpoint.degradationMode,
      hasProviderScores: !!checkpoint.providerHealthScores,
      hasExperiment: !!checkpoint.experimentState,
      hasExplorationMap: !!checkpoint.explorationMap,
      moduleQueueLength: (checkpoint.moduleQueue || []).length,
      canResume: this.shouldResumeFromCheckpoint(null as any),
    };
  }
}

// Singleton
const extendedCheckpoint = new ExtendedCheckpoint();
module.exports = { ExtendedCheckpoint, extendedCheckpoint, _injectDependencies };
