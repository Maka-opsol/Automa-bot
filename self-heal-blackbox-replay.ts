'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }
function logAudit(msg: string, mod?: string) { _deps.logger?.logAudit?.(msg, mod) ?? console.log(msg); }

function getDb() { return _deps.database?.db; }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const CONFIG = require('./get-config');

const DOM_TRUNCATE_BYTES = 500 * 1024; // 500KB
const TOMBSTONE_FILE = path.join(process.env.TMPDIR || '/tmp', 'mathu-data', '.tombstone.json');
const DEFAULT_MAX_FULL_ENTRIES = CONFIG.BLACKBOX_FULL_MAX_ENTRIES || 20;

class BlackboxReplay {
  maxFullEntries: any;
  _crashHandlers: any;
  _lastCheckpointTime: any;

  constructor() {
    this.maxFullEntries = DEFAULT_MAX_FULL_ENTRIES;
    this._crashHandlers = [];
    this._ensureTables();
    this._registerCrashHandlers();
  }

  _ensureTables() { 
    try {
      getDb()?.exec(`
        CREATE TABLE IF NOT EXISTS blackbox_full (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          blackbox_id INTEGER NOT NULL,
          timestamp INTEGER NOT NULL,
          screenshot BLOB,
          dom_html TEXT,
          network_log TEXT,
          tribunal_responses TEXT,
          FOREIGN KEY (blackbox_id) REFERENCES blackbox(id)
        );
        CREATE INDEX IF NOT EXISTS idx_blackbox_full_bid ON blackbox_full(blackbox_id);
        CREATE INDEX IF NOT EXISTS idx_blackbox_full_ts ON blackbox_full(timestamp);
      `);
    } catch (err: any) {
      logError('Failed to create blackbox_full table', err, { module: 'blackbox-replay' });
    }
  }

  _registerCrashHandlers() { 
    const onUncaught = (err: any) => {
      try {
        this.writeTombstone({
          timestamp: Date.now(),
          lastState: process.env.MATHU_STATE || 'unknown',
          error: err ? err.message : 'uncaughtException',
          memoryUsage: process.memoryUsage ? process.memoryUsage() : {},
          uptime: process.uptime ? process.uptime() : 0,
          lastCheckpoint: this._lastCheckpointTime || Date.now(),
        });
      } catch (tombErr: any) {
        // Best effort — cannot log if we're crashing
      }
    };

    const onBeforeExit = (code: any) => {
      if (code !== 0) {
        try {
          this.writeTombstone({
            timestamp: Date.now(),
            lastState: process.env.MATHU_STATE || 'unknown',
            error: `Process exiting with code ${code}`,
            memoryUsage: process.memoryUsage ? process.memoryUsage() : {},
            uptime: process.uptime ? process.uptime() : 0,
            lastCheckpoint: this._lastCheckpointTime || Date.now(),
          });
        } catch (tombErr: any) {
          // Best effort
        }
      }
    };

    process.on('uncaughtException', onUncaught);
    process.on('beforeExit', onBeforeExit);
    this._crashHandlers.push({ event: 'uncaughtException', fn: onUncaught });
    this._crashHandlers.push({ event: 'beforeExit', fn: onBeforeExit });
  }

  unregisterCrashHandlers() {
    for (const handler of this._crashHandlers) {
      process.removeListener(handler.event, handler.fn);
    }
    this._crashHandlers = [];
  }

  /**
   * Captures a full-fidelity snapshot for a failure event.
   * @param {object} page - Playwright page instance
   * @param {object} blackboxEntry - The blackbox DB row that failed
   * @param {Array|object} tribunalResponses - Tribunal decision(s)
   * @returns {number|null} The inserted blackbox_full id, or null on failure
   */
  async captureFailureSnapshot(page: any, blackboxEntry: any, tribunalResponses: any) { 
    try {
      if (!page || !blackboxEntry) {
        log('captureFailureSnapshot: missing page or blackboxEntry', 'WARN', 'blackbox-replay');
        return null;
      }

      const blackboxId = blackboxEntry.id;
      const timestamp = Date.now();

      // 1. Screenshot as Buffer (not base64) for storage efficiency
      let screenshot = null;
      try {
        screenshot = await page.screenshot({ type: 'png', fullPage: false });
      } catch (screenshotErr: any) {
        logError('Failed to capture failure screenshot', screenshotErr, { module: 'blackbox-replay' });
      }

      // 2. DOM HTML truncated to 500KB
      let domHtml = '';
      try {
        const rawHtml = await page.content();
        const buf = Buffer.from(rawHtml, 'utf8');
        if (buf.length > DOM_TRUNCATE_BYTES) {
          let truncIdx = DOM_TRUNCATE_BYTES;
          while (truncIdx >= 0 && (buf[truncIdx] & 0xC0) === 0x80) truncIdx--;
          domHtml = buf.slice(0, truncIdx).toString('utf8');
          log(`DOM HTML truncated from ${buf.length} to ${DOM_TRUNCATE_BYTES} bytes`, 'DEBUG', 'blackbox-replay');
        } else {
          domHtml = rawHtml;
        }
      } catch (htmlErr: any) {
        logError('Failed to capture failure DOM', htmlErr, { module: 'blackbox-replay' });
      }

      // 3. Network log from flutter-network-interceptor if available
      let networkLog = '[]';
      try {
        const interceptor = require('./flutter-network-interceptor');
        if (interceptor && Array.isArray(interceptor.capturedRequests)) {
          networkLog = JSON.stringify(interceptor.capturedRequests.slice(-50));
        }
      } catch (noInterceptor: any) {
        // Network interceptor not available, skip
        log('Network interceptor not available, skipping network log capture', 'DEBUG', 'blackbox-replay');
      }

      // 4. Tribunal responses JSON serialized
      let tribunalJson = '[]';
      try {
        tribunalJson = JSON.stringify(tribunalResponses || []);
      } catch (serializeErr: any) {
        log('Failed to serialize tribunal responses, using empty array', 'WARN', 'blackbox-replay');
      }

      // Insert into blackbox_full
      const insertStmt = getDb()?.prepare(`
        INSERT INTO blackbox_full (blackbox_id, timestamp, screenshot, dom_html, network_log, tribunal_responses)
        VALUES(?, ?, ?, ?, ?, ?)
      `);
      const result = insertStmt.run(blackboxId, timestamp, screenshot, domHtml, networkLog, tribunalJson);
      const insertedId = result.lastInsertRowid;

      log(`Captured failure snapshot id=${insertedId} for blackbox_id=${blackboxId}`, 'INFO', 'blackbox-replay');

      // Enforce max entries by pruning oldest
      this._pruneOldFullEntries();

      return insertedId;
    } catch (err: any) {
      logError('captureFailureSnapshot failed', err, { module: 'blackbox-replay' });
      return null;
    }
  }

  /**
   * Prunes oldest blackbox_full entries to stay within max limit.
   */
  _pruneOldFullEntries() { 
    try {
      const count = getDb()?.prepare('SELECT COUNT(*) as c FROM blackbox_full').get().c;
      if (count > this.maxFullEntries) {
        const toDelete = count - this.maxFullEntries;
        getDb()?.prepare(`DELETE FROM blackbox_full WHERE id IN (
          SELECT id FROM blackbox_full ORDER BY timestamp ASC LIMIT ?
        )`).run(toDelete);
        log(`Pruned ${toDelete} old blackbox_full entries`, 'DEBUG', 'blackbox-replay');
      }
    } catch (err: any) {
      logError('Failed to prune blackbox_full entries', err, { module: 'blackbox-replay' });
    }
  }

  /**
   * Replays a failure snapshot by loading it into a new browser context.
   * @param {number} blackboxId - The blackbox entry id to replay
   * @returns {object|null} { page, snapshot, domHtml, tribunalResponses } or null
   */
  async replaySnapshot(blackboxId: any) { 
    try {
      if (!blackboxId || typeof blackboxId !== 'number') {
        log('replaySnapshot: invalid blackboxId', 'WARN', 'blackbox-replay');
        return null;
      }

      const snapshot = getDb()?.prepare(
        'SELECT * FROM blackbox_full WHERE blackbox_id = ? ORDER BY timestamp DESC LIMIT 1'
      ).get(blackboxId);

      if (!snapshot) {
        log(`No full snapshot found for blackbox_id=${blackboxId}`, 'WARN', 'blackbox-replay');
        return null;
      }

      // Parse tribunal responses
      let tribunalResponses = [];
      try {
        tribunalResponses = JSON.parse(snapshot.tribunal_responses || '[]');
      } catch (e: any) {
        log('Failed to parse tribunal responses from snapshot', 'WARN', 'blackbox-replay');
      }

      // Create a new browser context and set DOM content
      let page = null;
      let browser: any = null;
      try {
        const { launchBrowser, closeBrowser } = require('./browser');
        page = await launchBrowser();
        browser = closeBrowser;
        const context = page.context();
        const newPage = await context.newPage();
        await page.close(); // Close original page

        // Set the DOM content from the snapshot
        await newPage.setContent(snapshot.dom_html || '', { waitUntil: 'domcontentloaded', timeout: 15000 });

        log(`Replayed snapshot for blackbox_id=${blackboxId} in new browser context`, 'INFO', 'blackbox-replay');

        return {
          page: newPage,
          _cleanup: async () => {
            try { await newPage.close(); } catch (e: any) {}
            try { await browser(); } catch (e: any) {}
          },
          snapshot,
          domHtml: snapshot.dom_html,
          tribunalResponses,
        };
      } catch (browserErr: any) {
        logError('Failed to create browser context for replay', browserErr, { module: 'blackbox-replay' });
        if (page) { try { await page.close(); } catch (e: any) {} }
        if (browser) {
          try { await browser(); } catch (e: any) {}
        }
        return null;
      }
    } catch (err: any) {
      logError('replaySnapshot failed', err, { module: 'blackbox-replay' });
      return null;
    }
  }

  /**
   * Walks through the tribunal decision step-by-step for a failure.
   * @param {number} blackboxId
   * @param {function} callback - Called with { step, screenshot, tribunalDecision, success }
   * @returns {Array} Array of step results
   */
  async walkReplay(blackboxId: any, callback: any) { 
    const steps: any[] = [];
    try {
      if (typeof callback !== 'function') {
        log('walkReplay: callback must be a function', 'WARN', 'blackbox-replay');
        return steps;
      }

      // Load the blackbox entry and its full snapshot
      const blackboxEntry = getDb()?.prepare('SELECT * FROM blackbox WHERE id = ?').get(blackboxId);
      if (!blackboxEntry) {
        log(`walkReplay: blackbox entry ${blackboxId} not found`, 'WARN', 'blackbox-replay');
        return steps;
      }

      const snapshot = getDb()?.prepare(
        'SELECT * FROM blackbox_full WHERE blackbox_id = ? ORDER BY timestamp DESC LIMIT 1'
      ).get(blackboxId);

      let tribunalResponses = [];
      if (snapshot) {
        try { tribunalResponses = JSON.parse(snapshot.tribunal_responses || '[]'); } catch (_e: any) { /* malformed data, skipping */ }
      }

      // Build steps from the blackbox entry data
      const actionSteps = tribunalResponses.length > 0 ? tribunalResponses : [{
        action: blackboxEntry.action,
        reasoning: blackboxEntry.reasoning,
        success: blackboxEntry.success === 1,
      }];

      for (let i = 0; i < actionSteps.length; i++) {
        const resp = actionSteps[i];
        const step = {
          stepIndex: i + 1,
          totalSteps: actionSteps.length,
          action: resp.action || resp.patch || resp.file || 'unknown',
          tribunalDecision: {
            reasoning: resp.reasoning || '',
            model: resp.model || 'unknown',
            file: resp.file || '',
            patch: resp.patch || '',
          },
          screenshotAvailable: !!(snapshot && snapshot.screenshot),
          success: resp.success !== undefined ? resp.success : (blackboxEntry.success === 1),
          originalBlackboxSuccess: blackboxEntry.success === 1,
        };

        steps.push(step);

        try {
          await callback(step);
        } catch (callbackErr: any) {
          logError(`walkReplay callback error at step ${i + 1}`, callbackErr, { module: 'blackbox-replay' });
        }
      }

      log(`walkReplay completed for blackbox_id=${blackboxId}: ${steps.length} steps`, 'INFO', 'blackbox-replay');
      return steps;
    } catch (err: any) {
      logError('walkReplay failed', err, { module: 'blackbox-replay' });
      return steps;
    }
  }

  /**
   * Returns recent failure snapshots (where blackbox.success = 0).
   * @param {number} limit
   * @returns {Array}
   */
  getFailureSnapshots(limit = 10) { 
    try {
      const safeLimit = Math.max(1, Math.min(100, Math.floor(limit)));
      const rows = getDb()?.prepare(`
        SELECT bf.*, bb.state, bb.action, bb.success, bb.reasoning, bb.provider_used
        FROM blackbox_full bf
        INNER JOIN blackbox bb ON bf.blackbox_id = bb.id
        WHERE bb.success = 0
        ORDER BY bf.timestamp DESC
        LIMIT ?
      `).all(safeLimit);
      return rows;
    } catch (err: any) {
      logError('getFailureSnapshots failed', err, { module: 'blackbox-replay' });
      return [];
    }
  }

  /**
   * Writes a tombstone file on hard crash (OOM kill, SIGKILL, uncaughtException).
   * @param {object} crashInfo - { timestamp, lastState, error, memoryUsage, uptime, lastCheckpoint }
   */
  writeTombstone(crashInfo: any) { 
    try {
      const tombstone = {
        timestamp: crashInfo.timestamp || Date.now(),
        lastState: crashInfo.lastState || 'unknown',
        error: crashInfo.error || 'unknown',
        memoryUsage: {
          rss: crashInfo.memoryUsage?.rss || 0,
          heapTotal: crashInfo.memoryUsage?.heapTotal || 0,
          heapUsed: crashInfo.memoryUsage?.heapUsed || 0,
          external: crashInfo.memoryUsage?.external || 0,
        },
        uptime: crashInfo.uptime || 0,
        lastCheckpoint: crashInfo.lastCheckpoint || Date.now(),
      };

      // Ensure directory exists (writable location on Render)
      const dir = path.dirname(TOMBSTONE_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(TOMBSTONE_FILE, JSON.stringify(tombstone, null, 2), 'utf8');
// @ts-expect-error
      logAudit('tombstone_written', `error=${tombstone.error}, state=${tombstone.lastState}`);
    } catch (err: any) {
      // Best effort — we may be crashing
      try { console.error(`Failed to write tombstone: ${err.message}`); } catch (e: any) {}
    }
  }

  /**
   * Reads tombstone file on startup and determines recovery action.
   * @returns {object} { needsInvestigation, lastState, error, suggestedAction }
   */
  readTombstone() { 
    try {
      if (!fs.existsSync(TOMBSTONE_FILE)) {
        return { needsInvestigation: false, lastState: null, error: null, suggestedAction: null };
      }

      const raw = fs.readFileSync(TOMBSTONE_FILE, 'utf8');
      const tombstone = JSON.parse(raw);

      const ageMs = Date.now() - (tombstone.timestamp || 0);
      const needsInvestigation = ageMs < 2 * 60 * 60 * 1000; // Within 2 hours

      // Determine suggested action based on error type and memory
      let suggestedAction = 'resume';
      if (tombstone.error && (
        tombstone.error.includes('OOM') ||
        tombstone.error.includes('heap out of memory') ||
        (tombstone.memoryUsage && tombstone.memoryUsage.rss > 1500 * 1024 * 1024)
      )) {
        suggestedAction = 'rebuild';
      } else if (tombstone.error && (
        tombstone.error.includes('SIGKILL') ||
        tombstone.error.includes('uncaughtException') ||
        tombstone.error.includes('ECONNREFUSED')
      )) {
        suggestedAction = 'revert_patch';
      }

      log(`Tombstone found: error="${tombstone.error}", suggestedAction="${suggestedAction}", needsInvestigation=${needsInvestigation}`, 'INFO', 'blackbox-replay');

      return {
        needsInvestigation,
        lastState: tombstone.lastState,
        error: tombstone.error,
        suggestedAction,
        timestamp: tombstone.timestamp,
        memoryUsage: tombstone.memoryUsage,
        uptime: tombstone.uptime,
      };
    } catch (err: any) {
      logError('Failed to read tombstone', err, { module: 'blackbox-replay' });
      return { needsInvestigation: false, lastState: null, error: null, suggestedAction: null };
    }
  }

  /**
   * Cleans up old blackbox_full entries and removes stale tombstone files.
   */
  async cleanup() { 
    try {
      // Prune old blackbox_full entries
      this._pruneOldFullEntries();

      // Remove tombstone if > 1 hour old and bot is running fine
      if (fs.existsSync(TOMBSTONE_FILE)) {
        try {
          const raw = fs.readFileSync(TOMBSTONE_FILE, 'utf8');
          const tombstone = JSON.parse(raw);
          const ageMs = Date.now() - (tombstone.timestamp || 0);
          const oneHourMs = 60 * 60 * 1000;

          if (ageMs > oneHourMs) {
            // Bot is running fine (we got here), so the tombstone is stale
            fs.unlinkSync(TOMBSTONE_FILE);
            log('Removed stale tombstone file (> 1 hour old, bot running fine)', 'INFO', 'blackbox-replay');
          }
        } catch (tombErr: any) {
          logError('Failed to process tombstone during cleanup', tombErr, { module: 'blackbox-replay' });
        }
      }

      log('Blackbox replay cleanup completed', 'DEBUG', 'blackbox-replay');
    } catch (err: any) {
      logError('cleanup failed', err, { module: 'blackbox-replay' });
    }
  }
}

module.exports = Object.assign(new BlackboxReplay(), {
  /**
   * Start the blackbox replay subsystem.
   * Called by container-subsystem-runner when BLACKBOX_REPLAY_ENABLED is set.
   */
  start() {
    log('Blackbox replay subsystem started', 'INFO', 'blackbox-replay');
  },
  _injectDependencies,
});
