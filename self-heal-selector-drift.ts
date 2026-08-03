'use strict';

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }
function getInsertSelectorVersion() { return _deps.database?.insertSelectorVersion; }
function getInsertSelfHealEvent() { return _deps.database?.insertSelfHealEvent; }

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const CONFIG = require('./get-config');

const SELECTORS_DIR = PROJECT_ROOT;

class SelectorDriftHealer {
  _visionPipeline: any;
  constructor() {
    this._visionPipeline = null;
  }

  /**
   * Lazy-load the vision pipeline (avoids import-time crashes if unavailable).
   */
  _getVisionPipeline() { 
    if (this._visionPipeline) return this._visionPipeline;
    try {
      const { runVisionPipeline } = require('./providers-vision-pipeline');
      this._visionPipeline = runVisionPipeline;
      return this._visionPipeline;
    } catch (err: any) {
      logError('vision-pipeline not available for selector healing', err, { module: 'selector-drift' });
      return null;
    }
  }

  /**
   * Load and parse a selector JSON file.
   * @param {string} selectorFile - Relative path within selectors/ dir (e.g., 'mathu-app/current.json')
   * @returns {Object|null} parsed selector data
   */
  _loadSelectorFile(selectorFile: any) { 
    try {
      const fullPath = path.resolve(SELECTORS_DIR, selectorFile);
      // Prevent path traversal
      if (!fullPath.startsWith(SELECTORS_DIR + path.sep) && fullPath !== SELECTORS_DIR) {
        log(`Selector file path traversal blocked: ${selectorFile}`, 'WARN', 'selector-drift');
        return null;
      }
      if (!fs.existsSync(fullPath)) {
        log(`Selector file not found: ${selectorFile}`, 'WARN', 'selector-drift');
        return null;
      }
      const content = fs.readFileSync(fullPath, 'utf8');
      return JSON.parse(content);
    } catch (err: any) {
      logError(`Failed to load selector file: ${selectorFile}`, err, { module: 'selector-drift' });
      return null;
    }
  }

  /**
   * Write selector content to file.
   * @param {string} selectorFile - Relative path within selectors/ dir
   * @param {string} content - JSON string content
   * @returns {boolean} success
   */
  _writeSelectorFile(selectorFile: any, content: any) { 
    try {
      const fullPath = path.resolve(SELECTORS_DIR, selectorFile);
      if (!fullPath.startsWith(SELECTORS_DIR + path.sep) && fullPath !== SELECTORS_DIR) {
        log(`Selector file write path traversal blocked: ${selectorFile}`, 'WARN', 'selector-drift');
        return false;
      }

      // Validate JSON
      const parsed = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object') {
        log('Invalid selector content: not an object', 'WARN', 'selector-drift');
        return false;
      }

      // Ensure directory exists
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      fs.writeFileSync(fullPath, content, 'utf8');
      log(`Selector file written: ${selectorFile}`, 'INFO', 'selector-drift');
      return true;
    } catch (err: any) {
      logError(`Failed to write selector file: ${selectorFile}`, err, { module: 'selector-drift' });
      return false;
    }
  }

  /**
   * Detect if selectors in a file have drifted (no longer match elements on the live page).
   * @param {string} selectorFile - Relative path within selectors/ dir
   * @param {import('playwright').Page} page - Live Playwright page
   * @returns {Promise<{ drifted: boolean, brokenSelectors: string[] }>}
   */
  async detectDrift(selectorFile: any, page: any) { 
    try {
      const selectorData = this._loadSelectorFile(selectorFile);
      if (!selectorData) {
        return { drifted: false, brokenSelectors: [] };
      }

      const selectors = selectorData.selectors || selectorData;
      if (!selectors || typeof selectors !== 'object') {
        return { drifted: false, brokenSelectors: [] };
      }

      const brokenSelectors = [];

      for (const [key, selectorStr] of Object.entries(selectors)) {
        if (typeof selectorStr !== 'string' || selectorStr.trim().length === 0) continue;

        try {
          // Handle comma-separated selectors (e.g., "a, b" means try both)
          const parts = selectorStr.split(',').map(s => s.trim()).filter(Boolean);

          let found = false;
          for (const part of parts) {
            try {
              const el = await page.$(part);
              if (el) {
                found = true;
                break;
              }
            } catch (selErr: any) {
              // Invalid selector syntax
            }
          }

          if (!found) {
            brokenSelectors.push(`${key}: ${selectorStr}`);
          }
        } catch (err: any) {
          logError(`Error testing selector ${key}`, err, { module: 'selector-drift' });
        }
      }

      const drifted = brokenSelectors.length > 0;
      if (drifted) {
        log(`Selector drift detected in ${selectorFile}: ${brokenSelectors.length} broken selector(s)`, 'WARN', 'selector-drift');
        this._logSelfHealEvent(selectorFile, 'drift_detected', `${brokenSelectors.length} broken selectors`, JSON.stringify(brokenSelectors));
      }

      return { drifted, brokenSelectors };
    } catch (err: any) {
      logError(`Failed to detect selector drift for ${selectorFile}`, err, { module: 'selector-drift' });
      return { drifted: false, brokenSelectors: [] };
    }
  }

  /**
   * Heal drifted selectors by sending screenshot + broken selectors to the vision tribunal.
   * This bypasses the full code-patch pipeline (no sandbox, no codegen tribunal, no GitOps).
   * @param {string} selectorFile - Relative path within selectors/ dir
   * @param {string[]} brokenSelectors - List of broken selector strings
   * @param {import('playwright').Page} page - Live Playwright page for validation
   * @param {string} base64Screenshot - Screenshot of the page
   * @returns {Promise<{ healed: boolean, newContent: string }>}
   */
  async healDrift(selectorFile: any, brokenSelectors: any, page: any, base64Screenshot: any) { 
    const startTime = Date.now();

    try {
      log(`Healing selector drift for ${selectorFile} (${brokenSelectors.length} broken)`, 'INFO', 'selector-drift');

      const runVision = this._getVisionPipeline();
      if (!runVision) {
        log('Cannot heal: vision pipeline unavailable', 'ERROR', 'selector-drift');
// @ts-expect-error
        this._logSelfHealEvent(selectorFile, 'heal_failed', 'vision pipeline unavailable' as any, null, 0, 0, 0, 'error', Date.now() - startTime, 'vision pipeline unavailable');
        return { healed: false, newContent: '' };
      }

      // Load current selector data for context
      const currentData = this._loadSelectorFile(selectorFile);
      if (!currentData) {
        log('Cannot heal: failed to load current selector data', 'ERROR', 'selector-drift');
        return { healed: false, newContent: '' };
      }

      const brokenList = brokenSelectors.join('\n');
      const currentJson = JSON.stringify(currentData.selectors || currentData, null, 2);

      const prompt = [
        'You are a UI selector healer. The following CSS/Playwright selectors are broken (elements no longer exist on the page).',
        '',
        `Current selector JSON:\n${currentJson}`,
        '',
        `Broken selectors:\n${brokenList}`,
        '',
        'Analyze the screenshot and generate a COMPLETE replacement selector JSON file.',
        'Rules:',
        '- Output ONLY valid JSON wrapped in ```json ... ``` code blocks',
        '- Maintain the same JSON structure and keys',
        '- Use robust CSS selectors (data-testid, aria attributes, etc.)',
        '- For text-based selectors, use Playwright text selectors like button:has-text("...")',
        '- Do NOT invent selectors that don\'t exist in the screenshot',
      ].join('\n');

      log('Requesting new selectors from vision tribunal...', 'INFO', 'selector-drift');

      const response = await runVision(base64Screenshot, prompt, {
        timeoutMs: 30000,
      });

      if (!response || !response.result) {
        log('Vision tribunal returned empty response', 'WARN', 'selector-drift');
        this._logSelfHealEvent(selectorFile, 'heal_failed', 'empty tribunal response', null, 0, 0, 0, 'no_response', Date.now() - startTime);
        return { healed: false, newContent: '' };
      }

      // Extract JSON from response
      const proposedJson = this._extractJsonFromResponse(response.result);
      if (!proposedJson) {
        log('Failed to extract valid JSON from tribunal response', 'WARN', 'selector-drift');
        this._logSelfHealEvent(selectorFile, 'heal_failed', 'invalid JSON in response', String(response.result).substring(0, 500), 0, 0, 0, 'invalid_json', Date.now() - startTime);
        return { healed: false, newContent: '' };
      }

      // Validate proposed selectors against the live page
      const validation = await this._validateSelectors(proposedJson, page);
      if (!validation.passed) {
        log(`Selector validation failed: ${validation.passedCount}/${validation.totalCount} selectors found`, 'WARN', 'selector-drift');
        this._logSelfHealEvent(selectorFile, 'heal_failed', `validation: ${validation.passedCount}/${validation.totalCount} passed`, JSON.stringify(validation.failedKeys), 1, 0, 0, 'validation_failed', Date.now() - startTime);
        return { healed: false, newContent: '' };
      }

      log(`Selector validation passed: ${validation.passedCount}/${validation.totalCount} selectors found`, 'INFO', 'selector-drift');

      // Build new selector content preserving version metadata
      const previousContent = JSON.stringify(currentData, null, 2);
      const nextVersion = (currentData.version ? parseInt(currentData.version, 10) + 1 : 1);
      const newContent = JSON.stringify({
        version: String(nextVersion),
        created: new Date().toISOString().split('T')[0],
        selectors: proposedJson,
      }, null, 2);

      // Run a single integration smoke test BEFORE writing
      const smokePassed = await this._runSmokeTest(proposedJson, page);
      if (!smokePassed) {
        log('Smoke test failed, not writing selector file', 'WARN', 'selector-drift');
        this._logSelfHealEvent(selectorFile, 'heal_failed', 'smoke test failed', null, 1, 0, 0, 'smoke_failed', Date.now() - startTime);
        return { healed: false, newContent: '' };
      }

      // Write the new selector file only after smoke test passes
      const written = this._writeSelectorFile(selectorFile, newContent);
      if (!written) {
        log('Failed to write healed selector file', 'ERROR', 'selector-drift');
        this._logSelfHealEvent(selectorFile, 'heal_failed', 'file write failed', null, 1, 1, 0, 'write_failed', Date.now() - startTime);
        return { healed: false, newContent: '' };
      }

      // Record in selector_versions table
      try {
        getInsertSelectorVersion()?.run(
          selectorFile,
          nextVersion,
          newContent,
          previousContent,
          Date.now(),
          'selector-drift-auto',
          1 // validated
        );
      } catch (dbErr: any) {
        logError('Failed to record selector version', dbErr, { module: 'selector-drift' });
      }

      const outcome = smokePassed ? 'healed_and_verified' : 'healed_unverified';
      log(`Selector drift healed for ${selectorFile}: version ${nextVersion} (${outcome})`, 'INFO', 'selector-drift');
      this._logSelfHealEvent(selectorFile, 'heal_complete', `v${nextVersion}, ${validation.passedCount} selectors validated, smoke=${smokePassed}`, null, 1, 1, 1, outcome, Date.now() - startTime);

      return { healed: true, newContent };
    } catch (err: any) {
      logError(`Failed to heal selector drift for ${selectorFile}`, err, { module: 'selector-drift' });
      this._logSelfHealEvent(selectorFile, 'heal_error', err.message, null, 0, 0, 0, 'error', Date.now() - startTime, err.message);
      return { healed: false, newContent: '' };
    }
  }

  /**
   * Extract JSON object from a text response (handles code blocks).
   */
  _extractJsonFromResponse(text: any) { 
    try {
      if (!text || typeof text !== 'string') return null;

      // Try to extract from code block
      const codeBlockMatch = text.match(/```json\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) {
        const parsed = JSON.parse(codeBlockMatch[1].trim());
        if (parsed && typeof parsed === 'object') return parsed;
      }

      // Try bare JSON
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed && typeof parsed === 'object') return parsed;
      }

      return null;
    } catch (err: any) {
      return null;
    }
  }

  /**
   * Validate proposed selectors against the live page.
   * @param {Object} selectors - Map of selector name to selector string
   * @param {import('playwright').Page} page
   * @returns {Promise<{ passed: boolean, passedCount: number, totalCount: number, failedKeys: string[] }>}
   */
  async _validateSelectors(selectors: any, page: any) { 
    const failedKeys = [];
    let passedCount = 0;
    let totalCount = 0;

    for (const [key, selectorStr] of Object.entries(selectors)) {
      if (typeof selectorStr !== 'string' || selectorStr.trim().length === 0) continue;
      totalCount++;

      const parts = selectorStr.split(',').map(s => s.trim()).filter(Boolean);
      let found = false;
      for (const part of parts) {
        try {
          const el = await page.$(part);
          if (el) { found = true; break; }
        } catch (e: any) { /* skip invalid */ }
      }

      if (found) {
        passedCount++;
      } else {
        failedKeys.push(key);
      }
    }

    const passThreshold = Math.max(1, Math.ceil(totalCount * 0.8));
    return {
      passed: passedCount >= passThreshold,
      passedCount,
      totalCount,
      failedKeys,
    };
  }

  /**
   * Run a single integration smoke test - try to find at least one element with new selectors.
   * @param {Object} selectors
   * @param {import('playwright').Page} page
   * @returns {Promise<boolean>}
   */
  async _runSmokeTest(selectors: any, page: any) { 
    try {
      for (const [key, selectorStr] of Object.entries(selectors)) {
        if (typeof selectorStr !== 'string' || selectorStr.trim().length === 0) continue;
        const parts = selectorStr.split(',').map(s => s.trim()).filter(Boolean);
        for (const part of parts) {
          try {
            const el = await page.$(part);
            if (el) {
              log(`Smoke test passed: found element for "${key}" with "${part}"`, 'INFO', 'selector-drift');
              return true;
            }
          } catch (e: any) { /* skip */ }
        }
      }
      log('Smoke test failed: no elements found with any new selector', 'WARN', 'selector-drift');
      return false;
    } catch (err: any) {
      logError('Smoke test error', err, { module: 'selector-drift' });
      return false;
    }
  }

  /**
   * Scan all selector files in the selectors directory for drift.
   * @param {import('playwright').Page} page
   * @returns {Promise<Array<{ file: string, drifted: boolean, brokenSelectors: string[] }>>}
   */
  async scanAllSelectorFiles(page: any) { 
    try {
      const results = [];
      const selectorDirs = this._listSelectorFiles();

      for (const file of selectorDirs) {
        const result = await this.detectDrift(file, page);
        results.push({ file, ...result });
      }

      const drifted = results.filter(r => r.drifted);
      if (drifted.length > 0) {
        log(`Selector drift scan: ${drifted.length}/${results.length} files have drift`, 'WARN', 'selector-drift');
      } else {
        log(`Selector drift scan: all ${results.length} files healthy`, 'INFO', 'selector-drift');
      }

      return results;
    } catch (err: any) {
      logError('Failed to scan selector files', err, { module: 'selector-drift' });
      return [];
    }
  }

  /**
   * List all selector JSON files relative to the selectors directory.
   */
  _listSelectorFiles() { 
    try {
      const files: any[] = [];
      this._walkDir(SELECTORS_DIR, (filePath: any) => {
        if (filePath.endsWith('.json')) {
          files.push(path.relative(SELECTORS_DIR, filePath));
        }
      });
      return files;
    } catch (err: any) {
      logError('Failed to list selector files', err, { module: 'selector-drift' });
      return [];
    }
  }

  /**
   * Recursively walk a directory.
   */
  _walkDir(dir: any, callback: any) { 
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          this._walkDir(fullPath, callback);
        } else {
          callback(fullPath);
        }
      }
    } catch (err: any) {
      // Directory may not exist
    }
  }

  /**
   * Log a self-heal event to the database.
   */
  _logSelfHealEvent(featureId: any, phase: any, triggerReason: any, investigationResult: any, patchesGenerated = 0, patchesSafe = 0, patchesApplied = 0, outcome = '', durationMs = 0, error = null) { 
    try {
      getInsertSelfHealEvent()?.run(
        Date.now(),
        `selector-drift:${featureId}`,
        phase,
        triggerReason ? String(triggerReason).substring(0, 1000) : null,
        investigationResult ? String(investigationResult).substring(0, 2000) : null,
        patchesGenerated,
        patchesSafe,
        patchesApplied,
        outcome ? String(outcome).substring(0, 100) : null,
        durationMs,
        error ? String(error).substring(0, 1000) : null
      );
    } catch (err: any) {
      logError('Failed to log selector drift self-heal event', err, { module: 'selector-drift' });
    }
  }
}

const selectorDriftHealer = new SelectorDriftHealer();

module.exports = {
  SelectorDriftHealer,
  selectorDriftHealer,
  /**
   * Start the selector drift healer subsystem.
   * Called by container-subsystem-runner when SELECTOR_DRIFT_HEAL_ENABLED is set.
   * @param {number} _ms - Interval in ms (unused — drift checks run on-demand per cycle)
   */
  start(_ms?: number) {
    log('Selector drift healer subsystem started', 'INFO', 'selector-drift');
  },
  _injectDependencies,
};