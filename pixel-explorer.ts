'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// pixel-explorer.ts — Blind pixel exploration for completely unknown UIs
// ═══════════════════════════════════════════════════════════════════════════
// When pixel-fallback's pattern matching fails (UI completely redesigned),
// this module systematically probes the viewport by:
//   1. Scanning the viewport in a grid, classifying each cell
//   2. Scoring cells by clickability (color saturation, contrast, shape)
//   3. Clicking the highest-scored unexplored cell
//   4. Observing what happened (page change? new elements?)
//   5. Building a persistent map of (visual region → observed effect)
//
// This is the pixel equivalent of exploration-cartographer, but works
// with ZERO DOM, ZERO AI, ZERO semantics — pure pixel analysis.
//
// Storage: pixel_exploration_map in calibration DB table
//   key = "pxmap.{pageHash}" → value = JSON map of discovered regions
//
// Exploration strategy:
//   - Grid scan: 8×6 = 48 cells covering the viewport
//   - Each cell classified as: background, text, button-like, image, unknown
//   - Button-like cells scored by: saturation, contrast, aspect ratio
//   - Click highest-scored unexplored cell, wait 2s, compare screenshots
//   - If page changed: mark as "productive click", record effect
//   - If page unchanged: mark as "dead zone", skip in future
//   - After 5 productive clicks on same page: stop exploring, use map
//
// Safety:
//   - Skips cells matching dangerous patterns (logout, delete colors)
//   - Maximum 8 clicks per exploration session (prevents infinite loops)
//   - Cooldown: won't re-explore same page within 5 minutes
//   - Scroll-aware: explores visible viewport, then scrolls and re-scans
//
// Memory: ~3 KB for a full exploration map per page type.
// ═══════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

const { log, logError } = require('./logger');

// ─── Constants ───────────────────────────────────────────────────────────

const DB_PREFIX = 'pxmap.';
const GRID_COLS = 8;
const GRID_ROWS = 6;
const MAX_CLICKS_PER_SESSION = 8;
const EXPLORATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MIN_PRODUCTIVE_CLICKS_TO_MAP = 3;
const CLICK_OBSERVE_WAIT_MS = 2000;
const GRID_STEP = 2; // Pixel sampling step (every 2nd pixel for speed)

// ─── In-memory state ─────────────────────────────────────────────────────

interface ExploredCell {
  gridX: number;
  gridY: number;
  cx: number;   // Center X in viewport pixels
  cy: number;   // Center Y in viewport pixels
  classification: 'background' | 'text' | 'button_like' | 'image' | 'unknown' | 'input_like';
  clickScore: number;
  clicked: boolean;
  productive: boolean;  // Did clicking this change the page?
  effect: string;       // 'navigation', 'modal_open', 'content_change', 'none'
  screenshotHash: string; // Hash of page after click
  lastExplored: number;
  clickCount: number;
}

interface PageExplorationMap {
  pageHash: string;
  urlPattern: string;
  cells: ExploredCell[];
  productiveCells: number;
  totalClicks: number;
  lastExplored: number;
  scrollY: number;      // Scroll position when this map was built
  bestNextClick: { cx: number; cy: number } | null;  // Most reliable productive cell
}

const _maps: Map<string, PageExplorationMap> = new Map();
let _sessionClickCount = 0;
let _lastExplorationTime = 0;
let _currentScrollY = 0;

// ─── Helpers ─────────────────────────────────────────────────────────────

function _getDB() {
  try { return require('./unified-db'); } catch { return null; }
}

function _simpleHash(data: Uint8ClampedArray | Buffer): string {
  let h = 0;
  for (let i = 0; i < data.length; i += 16) {
    h = ((h << 5) - h + data[i]) | 0;
  }
  return (h >>> 0).toString(36);
}

function _screenshotHash(pngBuf: Buffer): string {
  return _simpleHash(pngBuf);
}

/** Get a rough "page type" hash from URL (domain + path, no query) */
function _urlPageHash(url: string): string {
  try {
    const u = new URL(url);
    return _simpleHash(Buffer.from(u.hostname + u.pathname));
  } catch {
    return _simpleHash(Buffer.from(url.substring(0, 100)));
  }
}

// ─── Viewport Grid Scan ──────────────────────────────────────────────────

interface CellAnalysis {
  gridX: number;
  gridY: number;
  x1: number; y1: number; x2: number; y2: number;
  cx: number; cy: number;
  avgR: number; avgG: number; avgB: number;
  saturation: number;   // 0-1, how colorful
  contrast: number;    // 0-1, contrast with surroundings
  isUniform: boolean;   // True if cell is mostly one color (background)
  hasEdge: boolean;     // True if cell borders a different color region
  darkPixelRatio: number;
  lightPixelRatio: number;
  colorVariance: number;
}

/**
 * Scan a grid cell and return analysis.
 */
function _analyzeCell(
  rgba: Uint8ClampedArray, width: number, height: number,
  gridX: number, gridY: number
): CellAnalysis {
  const cellW = Math.floor(width / GRID_COLS);
  const cellH = Math.floor(height / GRID_ROWS);
  const x1 = gridX * cellW;
  const y1 = gridY * cellH;
  const x2 = Math.min(x1 + cellW, width);
  const y2 = Math.min(y1 + cellH, height);
  const cx = Math.round((x1 + x2) / 2);
  const cy = Math.round((y1 + y2) / 2);

  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  const rVals: number[] = [];
  const gVals: number[] = [];
  const bVals: number[] = [];

  for (let y = y1; y < y2; y += GRID_STEP) {
    for (let x = x1; x < x2; x += GRID_STEP) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      sumR += r; sumG += g; sumB += b;
      rVals.push(r); gVals.push(g); bVals.push(b);
      count++;
    }
  }

  if (count === 0) {
    return { gridX, gridY, x1, y1, x2, y2, cx, cy, avgR: 128, avgG: 128, avgB: 128, saturation: 0, contrast: 0, isUniform: true, hasEdge: false, darkPixelRatio: 0.5, lightPixelRatio: 0.5, colorVariance: 0 };
  }

  const avgR = Math.round(sumR / count);
  const avgG = Math.round(sumG / count);
  const avgB = Math.round(sumB / count);

  // Saturation (HSL-based, simplified)
  const max = Math.max(avgR, avgG, avgB) / 255;
  const min = Math.min(avgR, avgG, avgB) / 255;
  const l = (max + min) / 2;
  const saturation = max === min ? 0 : (max - min) / (l > 0.5 ? (2 - max - min) : (max + min));

  // Color variance within cell (how uniform is it)
  const rStd = _stdDev(rVals);
  const gStd = _stdDev(gVals);
  const bStd = _stdDev(bVals);
  const colorVariance = (rStd + gStd + bStd) / 3;
  const isUniform = colorVariance < 15;

  // Contrast with average of bordering cells (sample a ring around the cell)
  let borderSumR = 0, borderSumG = 0, borderSumB = 0, borderCount = 0;
  const borderMargin = Math.max(cellW, cellH) * 0.3;
  const bx1 = Math.max(0, Math.round(x1 - borderMargin));
  const by1 = Math.max(0, Math.round(y1 - borderMargin));
  const bx2 = Math.min(width, Math.round(x2 + borderMargin));
  const by2 = Math.min(height, Math.round(y2 + borderMargin));

  for (let y = by1; y < by2; y += GRID_STEP * 2) {
    for (let x = bx1; x < bx2; x += GRID_STEP * 2) {
      // Only sample border (not interior)
      if (x >= x1 && x <= x2 && y >= y1 && y <= y2) continue;
      const idx = (y * width + x) * 4;
      borderSumR += rgba[idx]; borderSumG += rgba[idx + 1]; borderSumB += rgba[idx + 2];
      borderCount++;
    }
  }

  let contrast = 0;
  if (borderCount > 0) {
    const bAvgR = borderSumR / borderCount;
    const bAvgG = borderSumG / borderCount;
    const bAvgB = borderSumB / borderCount;
    contrast = (Math.abs(avgR - bAvgR) + Math.abs(avgG - bAvgG) + Math.abs(avgB - bAvgB)) / (255 * 3);
  }

  // Dark/light pixel ratio
  let darkCount = 0, lightCount = 0;
  for (let i = 0; i < rVals.length; i += 3) {
    if (rVals[i] < 80 && gVals[i] < 80 && bVals[i] < 80) darkCount++;
    if (rVals[i] > 200 && gVals[i] > 200 && bVals[i] > 200) lightCount++;
  }
  const darkPixelRatio = darkCount / Math.max(1, rVals.length / 3);
  const lightPixelRatio = lightCount / Math.max(1, rVals.length / 3);

  // Edge detection: does the cell border a different-colored region?
  let edgeCount = 0;
  const edgeCheckStep = Math.max(1, Math.floor(cellW / 10));
  // Check right edge
  for (let y = y1; y < y2; y += edgeCheckStep) {
    const innerIdx = (y * width + (x2 - 2)) * 4;
    const outerIdx = (y * width + Math.min(x2 + 2, width - 1)) * 4;
    if (Math.abs(rgba[innerIdx] - rgba[outerIdx]) +
        Math.abs(rgba[innerIdx+1] - rgba[outerIdx+1]) +
        Math.abs(rgba[innerIdx+2] - rgba[outerIdx+2]) > 60) {
      edgeCount++;
    }
  }
  const hasEdge = edgeCount >= 2;

  return { gridX, gridY, x1, y1, x2, y2, cx, cy, avgR, avgG, avgB, saturation, contrast, isUniform, hasEdge, darkPixelRatio, lightPixelRatio, colorVariance };
}

function _stdDev(vals: number[]): number {
  if (vals.length === 0) return 0;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return Math.sqrt(variance);
}

// ─── Clickability Scoring ────────────────────────────────────────────────

/**
 * Score a cell's clickability (0-100).
 * Higher = more likely to be a useful clickable element.
 */
function _scoreClickability(cell: CellAnalysis): number {
  let score = 0;

  // Background cells: very low score
  if (cell.isUniform && cell.saturation < 0.1 && cell.contrast < 0.05) {
    return 0;
  }

  // Pure white background
  if (cell.avgR > 230 && cell.avgG > 230 && cell.avgB > 230 && cell.isUniform) {
    return 0;
  }

  // Highly saturated + high contrast = likely a button or interactive element
  score += cell.saturation * 30;     // Max 30 for pure saturation
  score += cell.contrast * 25;       // Max 25 for high contrast

  // Edges suggest a bounded UI element (button, card)
  if (cell.hasEdge) score += 15;

  // Color variance suggests content (text, icons) rather than flat background
  if (!cell.isUniform) score += 10;
  if (cell.colorVariance > 20) score += 10;

  // Penalize very dark cells (could be status bars, nav bars — less useful)
  if (cell.darkPixelRatio > 0.7) score -= 10;

  // Penalize very light cells (likely empty space)
  if (cell.lightPixelRatio > 0.8) score -= 5;

  // Bonus for cells in the bottom 30% of viewport (where action buttons usually live)
  // This is a heuristic, not a hardcoded scan region — still works if buttons move
  if (cell.cy > cell.y2 * 0.7) score += 5;

  return Math.max(0, Math.min(100, Math.round(score)));
}

/**
 * Classify a cell's visual type.
 */
function _classifyCell(cell: CellAnalysis): ExploredCell['classification'] {
  // Input-like: very uniform, light gray/white, wide aspect ratio
  if (cell.isUniform && cell.colorVariance < 10 &&
      cell.avgR > 180 && cell.avgG > 180 && cell.avgB > 180) {
    return 'input_like';
  }

  // Text: moderate variance, low saturation, not uniform
  if (cell.colorVariance > 15 && cell.colorVariance < 60 && cell.saturation < 0.15 && !cell.isUniform) {
    return 'text';
  }

  // Button-like: saturated, has edges, not uniform
  if (cell.saturation > 0.2 && cell.hasEdge && !cell.isUniform) {
    return 'button_like';
  }

  // Image: high variance, moderate saturation, no edges
  if (cell.colorVariance > 40 && !cell.hasEdge) {
    return 'image';
  }

  // Background: uniform, low saturation
  if (cell.isUniform && cell.saturation < 0.15) {
    return 'background';
  }

  return 'unknown';
}

// ─── Core Exploration ────────────────────────────────────────────────────

/**
 * Scan the full viewport and return scored grid cells.
 */
function _scanViewport(rgba: Uint8ClampedArray, width: number, height: number): CellAnalysis[] {
  const cells: CellAnalysis[] = [];
  for (let gy = 0; gy < GRID_ROWS; gy++) {
    for (let gx = 0; gx < GRID_COLS; gx++) {
      cells.push(_analyzeCell(rgba, width, height, gx, gy));
    }
  }
  return cells;
}

/**
 * Generate an exploration action for a page where pixel-fallback found nothing.
 * This is the last resort before giving up.
 *
 * Strategy:
 *   1. Scan viewport grid
 *   2. Score cells by clickability
 *   3. Pick highest-scored unexplored (or least-recently-explored) cell
 *   4. Return click action for that cell
 *
 * After the click, observeOutcome() should be called to learn from the result.
 */
async function explore(page: any): Promise<any> {
  const { sleep } = require('./utils-sleep');

  // Cooldown check
  const now = Date.now();
  if (now - _lastExplorationTime < EXPLORATION_COOLDOWN_MS && _sessionClickCount >= MAX_CLICKS_PER_SESSION) {
    log('Pixel exploration in cooldown, using existing map', 'DEBUG', 'pixel-explorer');
    return _getBestKnownAction(page);
  }

  try {
    const pngBuf = await page.screenshot({ type: 'png', fullPage: false });
    if (!pngBuf || pngBuf.length < 100) {
      log('Pixel explorer: screenshot failed', 'DEBUG', 'pixel-explorer');
      return null;
    }

    const pf = require('./pixel-fallback');
    const decoded = pf._decodePNG?.(pngBuf);
    if (!decoded) {
      log('Pixel explorer: PNG decode failed', 'DEBUG', 'pixel-explorer');
      return null;
    }

    const { rgba, width, height } = decoded;
    const url = page.url() || '';
    const pageHash = _urlPageHash(url);
    const mapKey = `${pageHash}_${_currentScrollY}`;

    // Load existing map if any
    let map = _maps.get(mapKey);
    if (!map) {
      map = {
        pageHash,
        urlPattern: url.substring(0, 100),
        cells: [],
        productiveCells: 0,
        totalClicks: 0,
        lastExplored: 0,
        scrollY: _currentScrollY,
        bestNextClick: null,
      };
      // Try loading from DB
      await _loadMapFromDB(mapKey, map);
    }

    // Scan viewport
    const cells = _scanViewport(rgba, width, height);

    // Score and filter
    const scored: Array<{ cell: CellAnalysis; analysis: CellAnalysis; classification: string; clickScore: number }> = [];

    for (const cell of cells) {
      const clickScore = _scoreClickability(cell);
      const classification = _classifyCell(cell);

      if (clickScore === 0) continue;

      // Check if this cell was already explored
      const existing = map.cells.find(c =>
        Math.abs(c.cx - cell.cx) < width / GRID_COLS &&
        Math.abs(c.cy - cell.cy) < height / GRID_ROWS
      );

      // Skip cells that were clicked and are known dead zones
      if (existing && existing.clicked && !existing.productive && existing.clickCount >= 2) {
        continue;
      }

      scored.push({ cell, analysis: cell, classification, clickScore });
    }

    // Sort by score descending
    scored.sort((a, b) => b.clickScore - a.clickScore);

    if (scored.length === 0) {
      log('Pixel explorer: no clickable cells found', 'DEBUG', 'pixel-explorer');
      return null;
    }

    // Pick the best cell
    const best = scored[0];
    const targetCell = best.cell;

    log(`Pixel explorer: clicking cell (${targetCell.cx}, ${targetCell.cy}) score=${best.clickScore} class=${best.classification}`, 'INFO', 'pixel-explorer');

    // Record in map
    const exploredCell: ExploredCell = {
      gridX: targetCell.gridX,
      gridY: targetCell.gridY,
      cx: targetCell.cx,
      cy: targetCell.cy,
      classification: best.classification as ExploredCell['classification'],
      clickScore: best.clickScore,
      clicked: false,
      productive: false,
      effect: 'none',
      screenshotHash: '',
      lastExplored: Date.now(),
      clickCount: 0,
    };

    // Update or add to map
    const existingIdx = map.cells.findIndex(c =>
      Math.abs(c.cx - targetCell.cx) < width / GRID_COLS &&
      Math.abs(c.cy - targetCell.cy) < height / GRID_ROWS
    );
    if (existingIdx >= 0) {
      exploredCell.clickCount = map.cells[existingIdx].clickCount + 1;
      exploredCell.productive = map.cells[existingIdx].productive;
      exploredCell.effect = map.cells[existingIdx].effect;
      map.cells[existingIdx] = exploredCell;
    } else {
      map.cells.push(exploredCell);
    }

    _sessionClickCount++;
    _lastExplorationTime = now;
    map.lastExplored = now;
    map.totalClicks++;

    // Save map
    _maps.set(mapKey, map);
    _saveMapToDB(mapKey, map).catch(() => {});

    return {
      actionType: 'click',
      targetX: targetCell.cx,
      targetY: targetCell.cy,
      currentState: 'exploring',
      reasoning: `Pixel explorer: probing cell at (${targetCell.cx}, ${targetCell.cy}) score=${best.clickScore} class=${best.classification}`,
      _pixelExplorer: true,
      _explorationMapKey: mapKey,
      _explorationCellCx: targetCell.cx,
      _explorationCellCy: targetCell.cy,
    };
  } catch (e: any) {
    logError('Pixel exploration failed', e);
    return null;
  }
}

/**
 * Observe the outcome of an exploration click.
 * Call this after the click action has been executed.
 *
 * @param page Playwright page
 * @param beforeHash Screenshot hash BEFORE the click
 * @param mapKey The exploration map key from the explore() action
 * @param cellCx Center X of the clicked cell
 * @param cellCy Center Y of the clicked cell
 */
async function observeOutcome(
  page: any,
  beforeHash: string,
  mapKey: string,
  cellCx: number,
  cellCy: number
): Promise<{ productive: boolean; effect: string }> {
  const { sleep } = require('./utils-sleep');

  // Wait for page to react
  await sleep(CLICK_OBSERVE_WAIT_MS);

  let productive = false;
  let effect = 'none';

  try {
    const afterBuf = await page.screenshot({ type: 'png', fullPage: false });
    const afterHash = afterBuf ? _screenshotHash(afterBuf) : beforeHash;
    const urlChanged = page.url();

    // Detect what happened
    if (afterHash !== beforeHash) {
      productive = true;

      // Determine effect type
      const pf = require('./pixel-fallback');
      const decoded = afterBuf ? pf._decodePNG?.(afterBuf) : null;

      if (decoded) {
        const { rgba, width, height } = decoded;
        // Check for modal (dark overlay appeared)
        const centerPixel = rgba[Math.floor(height * 0.5) * width * 4 + Math.floor(width * 0.5) * 4];
        if (centerPixel && centerPixel[3] < 200) {
          effect = 'modal_open';
        } else {
          effect = 'content_change';
        }
      } else {
        effect = 'content_change';
      }

      log(`Pixel explorer: CLICK WAS PRODUCTIVE at (${cellCx}, ${cellCy}) effect=${effect}`, 'INFO', 'pixel-explorer');
    } else {
      effect = 'none';
      log(`Pixel explorer: click was dead zone at (${cellCx}, ${cellCy})`, 'DEBUG', 'pixel-explorer');
    }

    // Update map
    const map = _maps.get(mapKey);
    if (map) {
      const cell = map.cells.find(c => Math.abs(c.cx - cellCx) < 20 && Math.abs(c.cy - cellCy) < 20);
      if (cell) {
        cell.clicked = true;
        cell.productive = productive;
        cell.effect = effect;
        cell.screenshotHash = afterHash;
        cell.lastExplored = Date.now();

        if (productive) {
          map.productiveCells++;
          // Update best next click if this cell is highly productive
          if (!map.bestNextClick || cell.clickScore > (map.cells.find(c => c.cx === map.bestNextClick?.cx && c.cy === map.bestNextClick?.cy)?.clickScore || 0)) {
            map.bestNextClick = { cx: cell.cx, cy: cell.cy };
          }
        }

        _saveMapToDB(mapKey, map).catch(() => {});
      }
    }
  } catch (e: any) {
    logError('Pixel explorer outcome observation failed', e);
  }

  return { productive, effect };
}

/**
 * Get the best known action from a previously built exploration map.
 * Used when exploration is in cooldown or we have a reliable map.
 */
function _getBestKnownAction(page: any): any {
  const url = page.url() || '';
  const pageHash = _urlPageHash(url);
  const mapKey = `${pageHash}_${_currentScrollY}`;

  const map = _maps.get(mapKey);
  if (!map || !map.bestNextClick || map.productiveCells < MIN_PRODUCTIVE_CLICKS_TO_MAP) {
    return null;
  }

  log(`Pixel explorer: using known productive cell at (${map.bestNextClick.cx}, ${map.bestNextClick.cy})`, 'INFO', 'pixel-explorer');

  return {
    actionType: 'click',
    targetX: map.bestNextClick.cx,
    targetY: map.bestNextClick.cy,
    currentState: 'exploring',
    reasoning: `Pixel explorer: using known productive cell (${map.productiveCells} productive cells mapped)`,
    _pixelExplorer: true,
    _explorationMapKey: mapKey,
    _explorationCellCx: map.bestNextClick.cx,
    _explorationCellCy: map.bestNextClick.cy,
  };
}

// ─── DB Persistence ──────────────────────────────────────────────────────

async function _loadMapFromDB(key: string, map: PageExplorationMap): Promise<void> {
  const db = _getDB();
  if (!db?.getCalibration) return;

  try {
    const value = await db.getCalibration(`${DB_PREFIX}${key}`);
    if (value) {
      const parsed = JSON.parse(value) as PageExplorationMap;
      if (parsed.cells && Array.isArray(parsed.cells)) {
        map.cells = parsed.cells;
        map.productiveCells = parsed.productiveCells || 0;
        map.totalClicks = parsed.totalClicks || 0;
        map.bestNextClick = parsed.bestNextClick || null;
        log(`Pixel explorer: loaded map for ${key} (${map.cells.length} cells, ${map.productiveCells} productive)`, 'DEBUG', 'pixel-explorer');
      }
    }
  } catch { /* best effort */ }
}

async function _saveMapToDB(key: string, map: PageExplorationMap): Promise<void> {
  const db = _getDB();
  if (!db?.setCalibration) return;

  try {
    // Compact: only save essential fields
    const compact = {
      pageHash: map.pageHash,
      urlPattern: map.urlPattern,
      cells: map.cells.map(c => ({
        cx: c.cx, cy: c.cy,
        classification: c.classification,
        clickScore: c.clickScore,
        clicked: c.clicked,
        productive: c.productive,
        effect: c.effect,
        clickCount: c.clickCount,
      })),
      productiveCells: map.productiveCells,
      totalClicks: map.totalClicks,
      lastExplored: map.lastExplored,
      scrollY: map.scrollY,
      bestNextClick: map.bestNextClick,
    };
    await db.setCalibration(`${DB_PREFIX}${key}`, JSON.stringify(compact), Date.now());
  } catch (e: any) {
    logError('Failed to save pixel exploration map', e);
  }
}

// ─── Diagnostics ─────────────────────────────────────────────────────────

function getStatus(): Record<string, any> {
  return {
    sessionClickCount: _sessionClickCount,
    lastExplorationTime: _lastExplorationTime ? new Date(_lastExplorationTime).toISOString() : null,
    mapsCount: _maps.size,
    maps: Array.from(_maps.entries()).map(([key, map]) => ({
      key,
      cells: map.cells.length,
      productive: map.productiveCells,
      totalClicks: map.totalClicks,
      bestNextClick: map.bestNextClick,
    })),
  };
}

function reset(): void {
  _maps.clear();
  _sessionClickCount = 0;
  _lastExplorationTime = 0;
}

/**
 * Get snapshot for tombstone persistence.
 */
function getSnapshot(): Record<string, any> {
  const snap: Record<string, any> = {};
  for (const [key, map] of _maps) {
    if (map.productiveCells > 0) {
      snap[key] = {
        cells: map.cells.filter(c => c.productive).map(c => ({
          cx: c.cx, cy: c.cy, classification: c.classification,
          clickScore: c.clickScore, effect: c.effect,
        })),
        productiveCells: map.productiveCells,
        bestNextClick: map.bestNextClick,
        scrollY: map.scrollY,
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
  let restored = 0;
  for (const [key, data] of Object.entries(snap)) {
    try {
      const mapData = data as any;
      if (mapData.cells && Array.isArray(mapData.cells) && mapData.cells.length > 0) {
        const map: PageExplorationMap = {
          pageHash: '',
          urlPattern: '',
          cells: mapData.cells.map((c: any) => ({
            ...c, clicked: true, productive: true, clickCount: 1,
            screenshotHash: '', lastExplored: Date.now(),
          })),
          productiveCells: mapData.productiveCells || mapData.cells.length,
          totalClicks: mapData.cells.length,
          lastExplored: Date.now(),
          scrollY: mapData.scrollY || 0,
          bestNextClick: mapData.bestNextClick || null,
        };
        _maps.set(key, map);
        restored++;
      }
    } catch { /* skip corrupt */ }
  }
  if (restored > 0) {
    log(`Pixel explorer restored ${restored} maps from tombstone`, 'INFO', 'pixel-explorer');
  }
  return restored;
}

// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  _injectDependencies,
  explore,
  observeOutcome,
  getStatus,
  reset,
  getSnapshot,
  restoreSnapshot,
};
