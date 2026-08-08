'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// pixel-calibration.ts — Self-calibrating pixel color thresholds
// ═══════════════════════════════════════════════════════════════════════════
// When AI providers successfully click a button, we capture the pixel color
// at that click coordinate and store it. Over time, we build a distribution
// of observed colors per category (teal, green, blue, etc.). The median of
// each channel becomes the new dynamic threshold — so if MathU changes its
// button colors, the pixel-fallback adapts automatically.
//
// Storage: calibration DB table (key = "pxcal.{category}", value = JSON)
// Format: { samples: [{r,g,b,ts}], median: {r,g,b}, count: N, updated: ts }
//
// Categories tracked:
//   - teal_submit:   teal-green Submit/Done buttons
//   - green_next:    green Next/Start/Continue buttons
//   - ms_blue:       Microsoft blue Next/Sign-in buttons
//   - deep_blue:     MathU app header / download buttons / book icons
//   - lavender:      lavender choice buttons in quiz
//   - mint_bg:       mint/cyan quiz page background
//   - dark_btn:      dark generic buttons (KMSI, etc.)
//
// Hook points:
//   1. cycle-cycle-manager.ts calls sampleActionColor() after successful clicks
//   2. pixel-fallback.ts calls getDynamicThresholds() to get overrides
//   3. Tombstone saves/restore calibration data on shutdown/startup
//
// No external dependencies — uses only existing logger + unified-db.
// Memory: ~2 KB for 100 samples per category × 7 categories.
// ═══════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

const { log, logError } = require('./logger');

// ─── Constants ───────────────────────────────────────────────────────────

/** DB key prefix for all calibration entries. */
const DB_PREFIX = 'pxcal.';

/** Maximum samples per category before evicting oldest. */
const MAX_SAMPLES = 60;

/** Minimum samples required before we trust the median over hardcoded. */
const MIN_SAMPLES_FOR_OVERRIDE = 5;

/** Category definitions with their classification rules. */
const CATEGORIES: Record<string, {
  label: string;
  /** Which hardcoded color function this category calibrates. */
  matchesHardcoded: (r: number, g: number, b: number) => boolean;
  /** Extra check: is this pixel likely a button (not background noise)? */
  isButtonCandidate?: (r: number, g: number, b: number) => boolean;
}> = {};

// Lazy-initialized after module load to avoid forward reference issues
function _initCategories() {
  const pf = require('./pixel-fallback');

  CATEGORIES['teal_submit'] = {
    label: 'Teal Submit/Done',
    matchesHardcoded: (r, g, b) => pf._isTealGreen?.(r, g, b) === true,
  };
  CATEGORIES['green_next'] = {
    label: 'Green Next/Start',
    matchesHardcoded: (r, g, b) => pf._isGreenish?.(r, g, b) === true,
  };
  CATEGORIES['ms_blue'] = {
    label: 'Microsoft Blue',
    matchesHardcoded: (r, g, b) => pf._findBlueButton != null, // URL-based, not color
    isButtonCandidate: (r, g, b) => r < 60 && g > 80 && g < 180 && b > 160 && b < 240,
  };
  CATEGORIES['deep_blue'] = {
    label: 'Deep Blue (App)',
    matchesHardcoded: (r, g, b) => r < 55 && g > 40 && g < 90 && b > 100 && b < 180,
  };
  CATEGORIES['lavender'] = {
    label: 'Lavender Choice',
    matchesHardcoded: (r, g, b) => r > 200 && g > 210 && b > 230 && r < 240 && g < 240 && b < 250,
  };
  CATEGORIES['mint_bg'] = {
    label: 'Mint Background',
    matchesHardcoded: (r, g, b) => r > 220 && g > 240 && b > 240,
    // Background: only accept if it's very pale (not a button)
    isButtonCandidate: (r, g, b) => r > 230 && g > 245 && b > 245,
  };
  CATEGORIES['dark_btn'] = {
    label: 'Dark Button',
    matchesHardcoded: (r, g, b) => r < 60 && g < 60 && b < 60,
  };
}

// ─── In-memory cache ────────────────────────────────────────────────────

interface ColorSample {
  r: number; g: number; b: number;
  ts: number;       // when sampled
  source: string;   // 'ai_click', 'pixel_click', 'manual'
}

interface CategoryData {
  samples: ColorSample[];
  median: { r: number; g: number; b: number } | null;
  count: number;
  updated: number;
}

const _cache: Map<string, CategoryData> = new Map();
let _loaded = false;
let _dirty = false;

// ─── DB helpers ──────────────────────────────────────────────────────────

function _getDB() {
  try {
    const udb = require('./unified-db');
    return udb;
  } catch {
    return null;
  }
}

async function _loadFromDB(): Promise<void> {
  const db = _getDB();
  if (!db?.getCalibrationLike) return;

  try {
    const rows = await db.getCalibrationLike('pxcal.%');
    for (const row of rows) {
      try {
        const data = JSON.parse(row.value) as CategoryData;
        if (data.samples && Array.isArray(data.samples) && data.samples.length > 0) {
          _cache.set(row.key.replace(DB_PREFIX, ''), data);
        }
      } catch { /* skip corrupt entries */ }
    }
    const totalSamples = Array.from(_cache.values()).reduce((s, c) => s + c.samples.length, 0);
    log(`Pixel calibration loaded: ${_cache.size} categories, ${totalSamples} total samples`, 'INFO', 'pixel-calibration');
    _loaded = true;
  } catch (e: any) {
    log(`Pixel calibration DB load failed: ${e.message}`, 'DEBUG', 'pixel-calibration');
    _loaded = true; // Don't retry every call
  }
}

async function _saveToDB(category: string): Promise<void> {
  const db = _getDB();
  const data = _cache.get(category);
  if (!db?.setCalibration || !data) return;

  try {
    await db.setCalibration(
      `${DB_PREFIX}${category}`,
      JSON.stringify(data),
      data.updated
    );
  } catch (e: any) {
    logError(`Failed to save pixel calibration for ${category}`, e);
  }
}

// ─── Statistics ──────────────────────────────────────────────────────────

function _computeMedian(samples: ColorSample[]): { r: number; g: number; b: number } {
  const sorted = [...samples].sort((a, b) => a.ts - b.ts);

  const rs = sorted.map(s => s.r).sort((a, b) => a - b);
  const gs = sorted.map(s => s.g).sort((a, b) => a - b);
  const bs = sorted.map(s => s.b).sort((a, b) => a - b);

  const mid = Math.floor(rs.length / 2);
  const median = (arr: number[]) => arr.length % 2 === 0
    ? Math.round((arr[mid - 1] + arr[mid]) / 2)
    : arr[mid];

  return { r: median(rs), g: median(gs), b: median(bs) };
}

function _computeStdDev(samples: ColorSample[], median: { r: number; g: number; b: number }): { r: number; g: number; b: number } {
  const n = samples.length;
  if (n < 2) return { r: 0, g: 0, b: 0 };

  const variance = (arr: number[], m: number) =>
    arr.reduce((s, v) => s + (v - m) ** 2, 0) / n;

  const stdDev = (arr: number[], m: number) => Math.sqrt(variance(arr, m));

  return {
    r: stdDev(samples.map(s => s.r), median.r),
    g: stdDev(samples.map(s => s.g), median.g),
    b: stdDev(samples.map(s => s.b), median.b),
  };
}

// ─── Core API ────────────────────────────────────────────────────────────

/**
 * Sample the color at a pixel coordinate after a successful action.
 * The color is classified into categories and stored.
 *
 * @param r Red channel 0-255
 * @param g Green channel 0-255
 * @param b Blue channel 0-255
 * @param source Where this sample came from ('ai_click', 'pixel_click', 'manual')
 * @param actionType The action type (click, etc.) — helps filter noise
 */
async function sampleColor(r: number, g: number, b: number, source: string = 'ai_click', actionType?: string): Promise<void> {
  if (!_loaded) await _loadFromDB();
  _initCategories();

  // Skip pure white/black — those are backgrounds, not buttons
  if (r > 240 && g > 240 && b > 240) return;
  if (r < 15 && g < 15 && b < 15) return;

  // Skip low-saturation colors (grays) — unlikely to be buttons
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max - min < 20) return;

  const sample: ColorSample = { r, g, b, ts: Date.now(), source };
  let matched = false;

  for (const [catId, catDef] of Object.entries(CATEGORIES)) {
    const matchesCandidate = catDef.isButtonCandidate
      ? catDef.isButtonCandidate(r, g, b)
      : catDef.matchesHardcoded(r, g, b);

    if (!matchesCandidate) continue;

    let data = _cache.get(catId);
    if (!data) {
      data = { samples: [], median: null, count: 0, updated: 0 };
      _cache.set(catId, data);
    }

    // Dedup: skip if we already have a near-identical sample (< 5 RGB distance)
    const isDupe = data.samples.some(
      s => Math.abs(s.r - r) + Math.abs(s.g - g) + Math.abs(s.b - b) < 15
    );
    if (isDupe && data.samples.length > 3) continue;

    data.samples.push(sample);
    if (data.samples.length > MAX_SAMPLES) {
      // Evict oldest 20% to prevent stale data
      data.samples.splice(0, Math.ceil(MAX_SAMPLES * 0.2));
    }

    data.median = _computeMedian(data.samples);
    data.count = data.samples.length;
    data.updated = Date.now();
    matched = true;
    _dirty = true;

    // Async save (don't block)
    _saveToDB(catId).catch(() => {});
  }

  if (matched) {
    log(`Pixel sample: rgb(${r},${g},${b}) → ${source}${actionType ? ` [${actionType}]` : ''}`, 'DEBUG', 'pixel-calibration');
  }
}

/**
 * Get all dynamic thresholds as color matcher functions.
 * Returns functions that use calibrated medians when enough samples exist,
 * falling back to hardcoded when insufficient data.
 *
 * Usage in pixel-fallback.ts:
 *   const cal = require('./pixel-calibration');
 *   const thresholds = cal.getDynamicThresholds();
 *   // Use thresholds.isTealGreen(r, g, b) instead of _isTealGreen(r, g, b)
 */
function getDynamicThresholds(): Record<string, (r: number, g: number, b: number) => boolean> {
  if (!_loaded) {
    // Synchronous best-effort: use cache only
    _initCategories();
  }

  const thresholds: Record<string, (r: number, g: number, b: number) => boolean> = {};

  // Teal-green: calibrated median ± 1.5×stddev
  const tealData = _cache.get('teal_submit');
  if (tealData && tealData.median && tealData.samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
    const stdDev = _computeStdDev(tealData.samples, tealData.median);
    const m = tealData.median;
    thresholds.isTealGreen = (r: number, g: number, b: number) => {
      const rRange = Math.max(40, Math.min(80, stdDev.r * 1.5));
      const gRange = Math.max(40, Math.min(60, stdDev.g * 1.5));
      const bRange = Math.max(40, Math.min(60, stdDev.b * 1.5));
      return Math.abs(r - m.r) < rRange &&
             Math.abs(g - m.g) < gRange &&
             Math.abs(b - m.b) < bRange;
    };
  }

  // Green: calibrated median ± 1.5×stddev
  const greenData = _cache.get('green_next');
  if (greenData && greenData.median && greenData.samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
    const stdDev = _computeStdDev(greenData.samples, greenData.median);
    const m = greenData.median;
    thresholds.isGreenish = (r: number, g: number, b: number) => {
      const rRange = Math.max(40, Math.min(80, stdDev.r * 1.5));
      const gRange = Math.max(40, Math.min(60, stdDev.g * 1.5));
      const bRange = Math.max(40, Math.min(60, stdDev.b * 1.5));
      return Math.abs(r - m.r) < rRange &&
             Math.abs(g - m.g) < gRange &&
             Math.abs(b - m.b) < bRange;
    };
  }

  // Deep blue (app header, download buttons, book icons)
  const deepBlueData = _cache.get('deep_blue');
  if (deepBlueData && deepBlueData.median && deepBlueData.samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
    const stdDev = _computeStdDev(deepBlueData.samples, deepBlueData.median);
    const m = deepBlueData.median;
    thresholds.isDeepBlue = (r: number, g: number, b: number) => {
      const rRange = Math.max(30, Math.min(50, stdDev.r * 1.5));
      const gRange = Math.max(40, Math.min(60, stdDev.g * 1.5));
      const bRange = Math.max(50, Math.min(80, stdDev.b * 1.5));
      return Math.abs(r - m.r) < rRange &&
             Math.abs(g - m.g) < gRange &&
             Math.abs(b - m.b) < bRange;
    };
  }

  // Microsoft blue
  const msBlueData = _cache.get('ms_blue');
  if (msBlueData && msBlueData.median && msBlueData.samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
    const stdDev = _computeStdDev(msBlueData.samples, msBlueData.median);
    const m = msBlueData.median;
    thresholds.isMicrosoftBlue = (r: number, g: number, b: number) => {
      const rRange = Math.max(40, Math.min(60, stdDev.r * 1.5));
      const gRange = Math.max(50, Math.min(80, stdDev.g * 1.5));
      const bRange = Math.max(50, Math.min(80, stdDev.b * 1.5));
      return Math.abs(r - m.r) < rRange &&
             Math.abs(g - m.g) < gRange &&
             Math.abs(b - m.b) < bRange;
    };
  }

  // Lavender (choice buttons)
  const lavenderData = _cache.get('lavender');
  if (lavenderData && lavenderData.median && lavenderData.samples.length >= MIN_SAMPLES_FOR_OVERRIDE) {
    const stdDev = _computeStdDev(lavenderData.samples, lavenderData.median);
    const m = lavenderData.median;
    thresholds.isLavender = (r: number, g: number, b: number) => {
      const rRange = Math.max(25, Math.min(40, stdDev.r * 1.5));
      const gRange = Math.max(25, Math.min(40, stdDev.g * 1.5));
      const bRange = Math.max(25, Math.min(30, stdDev.b * 1.5));
      return Math.abs(r - m.r) < rRange &&
             Math.abs(g - m.g) < gRange &&
             Math.abs(b - m.b) < bRange;
    };
  }

  return thresholds;
}

/**
 * Sample color at the click coordinates from a PNG screenshot buffer.
 * This is the main hook called from cycle-cycle-manager after successful clicks.
 *
 * @param pngScreenshot PNG buffer from page.screenshot({ type: 'png' })
 * @param clickX Click X coordinate (viewport pixels, not CSS)
 * @param clickY Click Y coordinate
 * @param actionType The action that was executed
 */
async function sampleAtCoordinates(
  pngScreenshot: Buffer,
  clickX: number,
  clickY: number,
  actionType: string
): Promise<void> {
  try {
    const pf = require('./pixel-fallback');
    const decoded = pf._decodePNG?.(pngScreenshot);
    if (!decoded) return;

    const { rgba, width, height } = decoded;

    // Sample a 5×5 area around the click point to get a representative color
    const radius = 2;
    let sumR = 0, sumG = 0, sumB = 0, count = 0;

    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const px = Math.round(clickX) + dx;
        const py = Math.round(clickY) + dy;
        if (px < 0 || px >= width || py < 0 || py >= height) continue;

        const idx = (py * width + px) * 4;
        sumR += rgba[idx];
        sumG += rgba[idx + 1];
        sumB += rgba[idx + 2];
        count++;
      }
    }

    if (count > 0) {
      const avgR = Math.round(sumR / count);
      const avgG = Math.round(sumG / count);
      const avgB = Math.round(sumB / count);
      await sampleColor(avgR, avgG, avgB, 'ai_click', actionType);
    }
  } catch (e: any) {
    log(`Pixel calibration sample failed: ${e.message}`, 'DEBUG', 'pixel-calibration');
  }
}

/**
 * Also sample surrounding area colors (not just the exact click point).
 * This helps detect background colors and adjacent UI elements.
 * Samples a ring at distance 15-25px from click point.
 */
async function sampleSurroundings(
  pngScreenshot: Buffer,
  clickX: number,
  clickY: number,
  actionType: string
): Promise<void> {
  try {
    const pf = require('./pixel-fallback');
    const decoded = pf._decodePNG?.(pngScreenshot);
    if (!decoded) return;

    const { rgba, width, height } = decoded;

    // Sample at 8 cardinal/intercardinal points at distance ~20px
    const distances = [15, 25];
    const angles = [0, 45, 90, 135, 180, 225, 270, 315];

    for (const dist of distances) {
      for (const angleDeg of angles) {
        const rad = (angleDeg * Math.PI) / 180;
        const px = Math.round(clickX + Math.cos(rad) * dist);
        const py = Math.round(clickY + Math.sin(rad) * dist);
        if (px < 0 || px >= width || py < 0 || py >= height) continue;

        const idx = (py * width + px) * 4;
        await sampleColor(rgba[idx], rgba[idx + 1], rgba[idx + 2], 'surrounding', actionType);
      }
    }
  } catch (e: any) {
    log(`Pixel calibration surrounding sample failed: ${e.message}`, 'DEBUG', 'pixel-calibration');
  }
}

// ─── Diagnostics ─────────────────────────────────────────────────────────

function getStatus(): Record<string, any> {
  const result: Record<string, any> = { loaded: _loaded, categories: {} };

  for (const [catId, data] of _cache) {
    const catDef = CATEGORIES[catId];
    result.categories[catId] = {
      label: catDef?.label || catId,
      sampleCount: data.samples.length,
      median: data.median,
      usingCalibrated: data.samples.length >= MIN_SAMPLES_FOR_OVERRIDE,
      lastSample: data.samples.length > 0 ? new Date(data.samples[data.samples.length - 1].ts).toISOString() : null,
      updated: data.updated ? new Date(data.updated).toISOString() : null,
    };
  }

  return result;
}

function reset(): void {
  _cache.clear();
  _dirty = false;
  _loaded = true;
}

// ─── Lifecycle ───────────────────────────────────────────────────────────

/**
 * Ensure calibration data is loaded. Call at startup.
 */
async function init(): Promise<void> {
  if (!_loaded) await _loadFromDB();
  _initCategories();

  const thresholds = getDynamicThresholds();
  const activeCount = Object.keys(thresholds).length;
  if (activeCount > 0) {
    log(`Pixel calibration active: ${activeCount} categories using calibrated thresholds`, 'INFO', 'pixel-calibration');
  }
}

/**
 * Flush any dirty data to DB. Call at shutdown.
 */
async function flush(): Promise<void> {
  if (_dirty) {
    for (const catId of _cache.keys()) {
      await _saveToDB(catId);
    }
    _dirty = false;
    log('Pixel calibration flushed to DB', 'DEBUG', 'pixel-calibration');
  }
}

/**
 * Get snapshot for tombstone persistence.
 */
function getSnapshot(): Record<string, any> {
  const snap: Record<string, any> = {};
  for (const [catId, data] of _cache) {
    if (data.samples.length > 0) {
      snap[catId] = {
        samples: data.samples.slice(-20), // Keep last 20 to save space
        median: data.median,
        count: data.count,
        updated: data.updated,
      };
    }
  }
  return snap;
}

/**
 * Restore from tombstone snapshot.
 */
async function restoreSnapshot(snap: Record<string, any>): Promise<number> {
  if (!snap || typeof snap !== 'object') return 0;

  if (!_loaded) await _loadFromDB();

  let restored = 0;
  for (const [catId, data] of Object.entries(snap)) {
    try {
      const catData = data as CategoryData;
      if (catData.samples && Array.isArray(catData.samples) && catData.samples.length > 0) {
        const existing = _cache.get(catId);
        if (!existing || existing.samples.length < catData.samples.length) {
          _cache.set(catId, catData);
          restored++;
        }
      }
    } catch { /* skip corrupt */ }
  }

  if (restored > 0) {
    log(`Pixel calibration restored ${restored} categories from tombstone`, 'INFO', 'pixel-calibration');
    _dirty = true;
    // Persist restored data
    for (const catId of _cache.keys()) {
      _saveToDB(catId).catch(() => {});
    }
  }
  return restored;
}

// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  _injectDependencies,
  init,
  flush,
  sampleColor,
  sampleAtCoordinates,
  sampleSurroundings,
  getDynamicThresholds,
  getStatus,
  reset,
  getSnapshot,
  restoreSnapshot,
};
