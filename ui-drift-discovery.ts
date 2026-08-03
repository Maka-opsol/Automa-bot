'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }
function getUpsertUiBaseline() { return _deps.database?.upsertUiBaseline; }

let sharp: any;
try { sharp = require('sharp'); } catch (e: any) { sharp = null; }
const crypto = require('crypto');
const CONFIG = require('./get-config');
const { log, logError } = require('./logger');
let Tesseract: any;
try { Tesseract = require('tesseract.js'); } catch (e: any) { Tesseract = null; }

class UIDriftDetector {
  baselines: any;
  ocr: any;
  aria: any;
  dom: any;
  actions: any;

  constructor() {
    this.baselines = new Map();
    this.loadBaselines();
  }

  loadBaselines() { 
    try {
      const rows = getDb()?.prepare('SELECT state, hash FROM ui_baselines').all();
      for (const row of rows) this.baselines.set(row.state, row.hash);
    } catch (err: any) {
      logError('Failed to load UI baselines', err);
    }
  }

  async hashImage(base64: any) { 
    if (!sharp) return '0';
    const buffer = Buffer.from(base64, 'base64');
    const { data } = await sharp(buffer).resize(9, 8).greyscale().raw().toBuffer({ resolveWithObject: true });
    let hash = 0;
    for (let i = 0; i < data.length; i++) {
      const bit = data[i] > 128 ? 1 : 0;
      hash = ((hash << 1) | bit) >>> 0;
    }
    return hash.toString(16);
  }

  hammingDistance(h1: any, h2: any) { 
    const b1 = BigInt(`0x${h1}`), b2 = BigInt(`0x${h2}`);
    let xor = b1 ^ b2;
    let dist = 0;
    while (xor > 0) { dist++; xor &= xor - 1n; }
    return dist;
  }

  async detectDrift(state: any, base64: any) { 
    const baseline = this.baselines.get(state);
    if (!baseline) return false;
    const currentHash = await this.hashImage(base64);
    const dist = this.hammingDistance(baseline, currentHash);
    const threshold = CONFIG.UI_DRIFT_THRESHOLD || 10;
    const drifted = dist > threshold;
    if (drifted) log(`⚠️ UI Drift detected for ${state}! Hamming: ${dist}`, 'WARN', 'ui-drift');
    return drifted;
  }

  async discoverUI(page: any, state = 'assignments_page') { 
    log('🔍 Entering UI Discovery Mode...', 'WARN', 'ui-drift');
    const map = {};
    const screenshot = await page.screenshot({ type: 'jpeg' });
    const base64 = screenshot.toString('base64');
    try {
      if (!Tesseract) { log('Tesseract not available, skipping OCR', 'DEBUG', 'ui-drift'); return map; }
      const { data: ocrResult } = await Tesseract.recognize(screenshot, 'eng');
// @ts-expect-error
      map.ocr = (ocrResult.words || []).map((w: any) => ({ text: w.text, x: w.bbox ? w.bbox.x0 : 0, y: w.bbox ? w.bbox.y0 : 0 }));
    } catch (_e: any) { /* non-critical, suppressed */ }
    try {
      const snapshot = await require('./utils-a11y-snapshot').getA11ySnapshot(page);
// @ts-expect-error
      map.aria = snapshot;
    } catch (_e: any) { /* non-critical, suppressed */ }
    const elements = await page.evaluate(() => {
      const all = document.querySelectorAll('button, a, input, [role="button"]');
      return Array.from(all).map((el: any) => ({ tag: el.tagName, text: el.innerText || el.getAttribute('aria-label'), rect: el.getBoundingClientRect() }));
    });
// @ts-expect-error
    map.dom = elements;
    const watch = elements.filter((e: any) => e.text?.toLowerCase().includes('watch'));
// @ts-expect-error
    if (watch.length > 0) map.actions = { watch: watch[0].rect };
    log('📦 UI Map generated. Transitions updated.', 'INFO', 'ui-drift');
    const hash = await this.hashImage(base64);
    getUpsertUiBaseline()?.run(state, hash, JSON.stringify(map), Date.now());
    this.baselines.set(state, hash);
    return map;
  }
}

module.exports = Object.assign(new UIDriftDetector(), { _injectDependencies });
