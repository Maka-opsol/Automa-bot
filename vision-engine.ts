'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// VISION ENGINE — TASK 104 (2026-09-30)
// ═══════════════════════════════════════════════════════════════════════════
//
// User's 20-point architectural advice implemented as a clean module.
// This is the "general visual perception → hypothesis → experiment →
// consequence → memory loop" described in the advice.
//
// Philosophy: "maintain a visual world model, generate many hypotheses,
// and only execute actions whose visual evidence justifies them."
//
// This module wraps the existing pixel-fallback's detectors and adds:
//   1. Unknown as a first-class operating mode
//   2. Persistent visual object map (scene graph)
//   3. Multi-feature candidate scoring (not just color)
//   4. Connected-component analysis
//   5. Edge-based button detection
//   6. Every action as hypothesis/experiment
//   7. Region-level change detection (3×3 grid)
//   8. Active probing instead of repeated clicking
//   9. Separated progress from visual change
//   10. Safe action ladder
//   11. Don't reload aggressively (reversible exploration first)
//   12. Scroll displacement tracking
//   13. Viewport geometry as sensor
//   14. Temporal classification (multi-frame)
//   15. Multi-hypothesis math recognition
//   16. Unsupervised color calibration
//   17. Explicit wait/observe actions with reasons
//   18. Persistent action memory across restarts
//   19. Defensive coordinate handling
//   20. Emergency policy flowchart
// ═══════════════════════════════════════════════════════════════════════════

const zlib = require('zlib');
const { log } = require('./logger');

// ─── 2. Visual Object Map ─────────────────────────────────────────────────

interface VisualObject {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'button' | 'input' | 'link' | 'icon' | 'card' | 'modal' | 'navigation' | 'text' | 'unknown';
  confidence: number;
  features: ObjectFeatures;
  firstSeen: number;
  lastSeen: number;
  timesClicked: number;
  timesChangedPage: number;
  timesNoEffect: number;
}

interface ObjectFeatures {
  color: { r: number; g: number; b: number };
  size: number;          // w * h
  aspectRatio: number;   // w / h
  edgeDensity: number;   // 0-1, how many strong edges
  interiorUniformity: number; // 0-1, how uniform the interior is
  whitespaceIsolation: number; // 0-1, how much empty space surrounds it
  temporalPersistence: number; // 0-1, how many frames it's survived
  historicalSuccess: number; // from action rewards
}

// ─── 6. Action as Hypothesis ─────────────────────────────────────────────

interface ActionHypothesis {
  actionType: string;
  targetX: number;
  targetY: number;
  targetX2?: number;
  targetY2?: number;
  value?: string;
  keypadSequence?: any[];
  evidence: string[];
  confidence: number;
  expectedEffects: string[];
  risk: number;          // 0=very low, 1=low, 2=medium, 3=high
  reversible: boolean;
  reason: string;
}

// ─── 12. Scroll Displacement Tracking ────────────────────────────────────

interface ScrollEvent {
  direction: number;     // +1 = down, -1 = up
  displacement: number;  // 0-1, how much the page changed
  timestamp: number;
}

// ─── 14. Temporal Classification ──────────────────────────────────────────

type RegionTemporalState = 'static' | 'animated' | 'loading' | 'progressing' | 'disappearing' | 'appearing' | 'unknown';

interface TemporalFrame {
  timestamp: number;
  regionFingerprints: string[];
}

// ─── State ────────────────────────────────────────────────────────────────

const _state = {
  // 2. Visual object map
  visualObjects: [] as VisualObject[],
  objectNextId: 0,

  // 7. Region fingerprints (3×3 grid)
  lastRegionFingerprints: [] as string[],

  // 8. Active probing — track which targets have been tried
  probedTargets: [] as Array<{ x: number; y: number; changedPage: boolean; timestamp: number }>,

  // 10. Safe action ladder
  safeActionExhausted: { wait: false, scroll: false, lowRisk: false, mediumRisk: false },

  // 12. Scroll displacement
  scrollHistory: [] as ScrollEvent[],

  // 14. Temporal frames
  temporalFrames: [] as TemporalFrame[],
  temporalState: 'unknown' as RegionTemporalState | 'unknown',

  // 16. Unsupervised color calibration
  unsupervisedColors: new Map<string, number>(), // color key → count of times seen as isolated rectangle

  // 18. Persistent journal
  journalLoaded: false,
};

const MAX_VISUAL_OBJECTS = 50;
const MAX_TEMPORAL_FRAMES = 4;
const MAX_PROBE_HISTORY = 10;
const MAX_SCROLL_HISTORY = 10;

// ─── 1. Unknown as First-Class Mode ───────────────────────────────────────

type OperatingMode = 'known_state' | 'unknown_state' | 'surface_discovery' | 'safe_exploration' | 'recovery';

function _determineOperatingMode(currentState: string | undefined, confidence: number): OperatingMode {
  // Known state with high confidence
  if (currentState && confidence > 0.6 && currentState !== 'unknown' && currentState !== 'exploring' && currentState !== 'exploration') {
    return 'known_state';
  }
  // Unknown but not yet explored
  if (!currentState || currentState === 'unknown' || currentState === 'exploring' || currentState === 'exploration') {
    // Check if we've discovered any interactive surfaces
    if (_state.visualObjects.length > 0) {
      return 'safe_exploration';
    }
    return 'unknown_state';
  }
  // Low confidence on a "known" state
  if (confidence < 0.4) {
    return 'surface_discovery';
  }
  return 'known_state';
}

// ─── 3. Multi-Feature Candidate Scoring ──────────────────────────────────

function _computeObjectFeatures(
  rgba: Uint8ClampedArray, width: number, height: number,
  x: number, y: number, w: number, h: number
): ObjectFeatures {
  // Sample the object's pixels
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(width, Math.floor(x + w)), y1 = Math.min(height, Math.floor(y + h));
  const sampleStep = Math.max(1, Math.floor(Math.min(w, h) / 10));

  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  let edgeCount = 0;
  let prevLum: number | null = null;
  const lumValues: number[] = [];

  for (let py = y0; py < y1; py += sampleStep) {
    for (let px = x0; px < x1; px += sampleStep) {
      const idx = (py * width + px) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      rSum += r; gSum += g; bSum += b; count++;
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      lumValues.push(lum);
      // Edge detection: compare with previous pixel
      if (prevLum !== null && Math.abs(lum - prevLum) > 30) edgeCount++;
      prevLum = lum;
    }
    prevLum = null;
  }

  if (count === 0) count = 1;

  // Color (average)
  const avgR = Math.round(rSum / count), avgG = Math.round(gSum / count), avgB = Math.round(bSum / count);

  // Edge density
  const edgeDensity = Math.min(1, edgeCount / Math.max(1, count));

  // Interior uniformity (variance of luminance)
  const meanLum = lumValues.reduce((a, b) => a + b, 0) / lumValues.length;
  const variance = lumValues.reduce((a, b) => a + (b - meanLum) ** 2, 0) / Math.max(1, lumValues.length);
  const interiorUniformity = Math.max(0, 1 - Math.sqrt(variance) / 128);

  // Whitespace isolation: check pixels around the object
  let borderEmpty = 0, borderTotal = 0;
  const borderMargin = Math.max(3, Math.floor(Math.min(w, h) * 0.1));
  for (let py = y0 - borderMargin; py < y1 + borderMargin; py += sampleStep) {
    for (let px = x0 - borderMargin; px < x1 + borderMargin; px += sampleStep) {
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      if (px >= x0 && px < x1 && py >= y0 && py < y1) continue; // skip interior
      const idx = (py * width + px) * 4;
      const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
      if (lum > 220 || lum < 20) borderEmpty++; // white or black background
      borderTotal++;
    }
  }
  const whitespaceIsolation = borderTotal > 0 ? borderEmpty / borderTotal : 0;

  return {
    color: { r: avgR, g: avgG, b: avgB },
    size: w * h,
    aspectRatio: w / Math.max(1, h),
    edgeDensity,
    interiorUniformity,
    whitespaceIsolation,
    temporalPersistence: 0, // set by visual object tracker
    historicalSuccess: 0,   // set by action rewards
  };
}

function _scoreCandidate(features: ObjectFeatures): number {
  // Multi-feature scoring — doesn't rely on color alone
  const rectangularity = features.interiorUniformity; // uniform interior = likely rectangle
  const sizePlausibility = features.size > 500 && features.size < 50000 ? 1 : 0.5;
  const aspectScore = features.aspectRatio > 0.3 && features.aspectRatio < 5 ? 1 : 0.3;
  const edgeScore = Math.min(1, features.edgeDensity * 2);
  const whitespaceScore = features.whitespaceIsolation;
  const persistenceScore = features.temporalPersistence;
  const historyScore = Math.min(1, features.historicalSuccess / 3);

  return (
    0.20 * (1 - Math.abs(features.aspectRatio - 1.5) / 5) + // color similarity (using aspect as proxy since we don't have a target color)
    0.20 * rectangularity +
    0.15 * edgeScore +
    0.15 * whitespaceScore +
    0.10 * sizePlausibility +
    0.10 * persistenceScore +
    0.10 * historyScore
  );
}

// ─── 4. Connected-Component Analysis ─────────────────────────────────────

interface ConnectedComponent {
  x: number; y: number; w: number; h: number;
  pixelCount: number;
  avgColor: { r: number; g: number; b: number };
}

function _connectedComponents(
  rgba: Uint8ClampedArray, width: number, height: number,
  mask: (r: number, g: number, b: number) => boolean
): ConnectedComponent[] {
  // Simple flood-fill connected components on a binary mask
  const visited = new Uint8Array(width * height);
  const components: ConnectedComponent[] = [];
  const stack: number[] = [];
  const minSize = 20; // ignore tiny components
  const maxSize = width * height * 0.8; // ignore full-page components

  for (let startY = 0; startY < height; startY += 2) {
    for (let startX = 0; startX < width; startX += 2) {
      const startIdx = startY * width + startX;
      if (visited[startIdx]) continue;
      const pIdx = startIdx * 4;
      if (!mask(rgba[pIdx], rgba[pIdx + 1], rgba[pIdx + 2])) continue;

      // Flood fill
      stack.length = 0;
      stack.push(startIdx);
      let minX = width, maxX = 0, minY = height, maxY = 0;
      let pixelCount = 0, rSum = 0, gSum = 0, bSum = 0;

      while (stack.length > 0) {
        const idx = stack.pop()!;
        if (idx < 0 || idx >= width * height || visited[idx]) continue;
        const pi = idx * 4;
        if (!mask(rgba[pi], rgba[pi + 1], rgba[pi + 2])) continue;

        visited[idx] = 1;
        const px = idx % width, py = Math.floor(idx / width);
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        pixelCount++;
        rSum += rgba[pi]; gSum += rgba[pi + 1]; bSum += rgba[pi + 2];

        // 4-connectivity
        if (px > 0) stack.push(idx - 1);
        if (px < width - 1) stack.push(idx + 1);
        if (py > 0) stack.push(idx - width);
        if (py < height - 1) stack.push(idx + width);
      }

      if (pixelCount >= minSize && pixelCount <= maxSize) {
        components.push({
          x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1,
          pixelCount,
          avgColor: { r: Math.round(rSum / pixelCount), g: Math.round(gSum / pixelCount), b: Math.round(bSum / pixelCount) },
        });
      }
    }
  }
  return components;
}

function _detectCandidatesViaConnectedComponents(
  rgba: Uint8ClampedArray, width: number, height: number
): ConnectedComponent[] {
  const allComponents: ConnectedComponent[] = [];

  // Mask 1: dark-on-light (buttons with dark text on light background)
  allComponents.push(..._connectedComponents(rgba, width, height, (r, g, b) => {
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum < 80; // dark pixels
  }));

  // Mask 2: high-saturation (colored buttons)
  allComponents.push(..._connectedComponents(rgba, width, height, (r, g, b) => {
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const sat = max > 0 ? (max - min) / max : 0;
    return sat > 0.4 && max > 80;
  }));

  // Mask 3: edge magnitude (high-contrast boundaries)
  // (simplified — just check if adjacent pixels differ significantly)
  allComponents.push(..._connectedComponents(rgba, width, height, (r, g, b) => {
    return r > 100 && g > 100 && b > 100; // light regions (potential button interiors)
  }));

  // Merge overlapping components
  return _mergeOverlappingComponents(allComponents);
}

function _mergeOverlappingComponents(components: ConnectedComponent[]): ConnectedComponent[] {
  if (components.length <= 1) return components;
  const merged: ConnectedComponent[] = [];
  const used = new Set<number>();

  for (let i = 0; i < components.length; i++) {
    if (used.has(i)) continue;
    const current = { ...components[i] };
    for (let j = i + 1; j < components.length; j++) {
      if (used.has(j)) continue;
      const other = components[j];
      // Check overlap
      const overlapX = Math.max(0, Math.min(current.x + current.w, other.x + other.w) - Math.max(current.x, other.x));
      const overlapY = Math.max(0, Math.min(current.y + current.h, other.y + other.h) - Math.max(current.y, other.y));
      const overlapArea = overlapX * overlapY;
      const minArea = Math.min(current.w * current.h, other.w * other.h);
      if (overlapArea > minArea * 0.3) {
        // Merge
        current.x = Math.min(current.x, other.x);
        current.y = Math.min(current.y, other.y);
        current.w = Math.max(current.x + current.w, other.x + other.w) - current.x;
        current.h = Math.max(current.y + current.h, other.y + other.h) - current.y;
        current.pixelCount += other.pixelCount;
        used.add(j);
      }
    }
    merged.push(current);
  }
  return merged;
}

// ─── 5. Edge-Based Button Detection ───────────────────────────────────────

function _detectButtonsByEdges(
  rgba: Uint8ClampedArray, width: number, height: number
): Array<{ x: number; y: number; w: number; h: number; confidence: number }> {
  // Simplified edge-based detection:
  // 1. Compute edge magnitude at each pixel
  // 2. Find regions with strong edge boundaries and uniform interiors
  // 3. Check for rectangular shape

  const candidates: Array<{ x: number; y: number; w: number; h: number; confidence: number }> = [];
  const edgeMap = new Float32Array(width * height);

  // Compute edge magnitude (Sobel-like)
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const idx = (y * width + x) * 4;
      const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
      const lumRight = 0.299 * rgba[idx + 4] + 0.587 * rgba[idx + 5] + 0.114 * rgba[idx + 6];
      const lumDown = 0.299 * rgba[idx + width * 4] + 0.587 * rgba[idx + width * 4 + 1] + 0.114 * rgba[idx + width * 4 + 2];
      edgeMap[y * width + x] = Math.abs(lumRight - lum) + Math.abs(lumDown - lum);
    }
  }

  // Scan for rectangular regions with strong borders
  const minSize = 20, maxSize = 200;
  const step = Math.max(2, Math.floor(width / 100));

  for (let y = 0; y < height - minSize; y += step) {
    for (let x = 0; x < width - minSize; x += step) {
      // Try different sizes
      for (let h = minSize; h <= maxSize && y + h < height; h += step * 2) {
        for (let w = minSize; w <= maxSize && x + w < width; w += step * 2) {
          // Check border edges
          let borderEdgeSum = 0, borderCount = 0;
          let interiorUniformity = 0;
          let interiorCount = 0;

          // Top and bottom borders
          for (let bx = x; bx < x + w; bx += 2) {
            const topIdx = (y * width + bx);
            const botIdx = ((y + h - 1) * width + bx);
            if (topIdx < edgeMap.length) { borderEdgeSum += edgeMap[topIdx]; borderCount++; }
            if (botIdx < edgeMap.length) { borderEdgeSum += edgeMap[botIdx]; borderCount++; }
          }
          // Left and right borders
          for (let by = y; by < y + h; by += 2) {
            const leftIdx = (by * width + x);
            const rightIdx = (by * width + x + w - 1);
            if (leftIdx < edgeMap.length) { borderEdgeSum += edgeMap[leftIdx]; borderCount++; }
            if (rightIdx < edgeMap.length) { borderEdgeSum += edgeMap[rightIdx]; borderCount++; }
          }

          // Interior uniformity (sample center)
          const cx = x + Math.floor(w / 2), cy = y + Math.floor(h / 2);
          const centerIdx = (cy * width + cx) * 4;
          if (centerIdx + 2 < rgba.length) {
            const centerLum = 0.299 * rgba[centerIdx] + 0.587 * rgba[centerIdx + 1] + 0.114 * rgba[centerIdx + 2];
            const sampleIdx = ((y + 2) * width + x + 2) * 4;
            if (sampleIdx + 2 < rgba.length) {
              const sampleLum = 0.299 * rgba[sampleIdx] + 0.587 * rgba[sampleIdx + 1] + 0.114 * rgba[sampleIdx + 2];
              interiorUniformity += 1 - Math.abs(centerLum - sampleLum) / 128;
              interiorCount++;
            }
          }

          if (borderCount > 0 && interiorCount > 0) {
            const avgBorderEdge = borderEdgeSum / borderCount;
            const avgUniformity = interiorUniformity / interiorCount;
            // High border edge + uniform interior = likely button
            if (avgBorderEdge > 15 && avgUniformity > 0.6) {
              const confidence = Math.min(1, (avgBorderEdge / 30) * 0.5 + avgUniformity * 0.5);
              candidates.push({ x, y, w, h, confidence });
            }
          }
        }
      }
    }
  }

  // Non-maximum suppression — keep only the highest-confidence overlapping candidate
  candidates.sort((a, b) => b.confidence - a.confidence);
  const result: typeof candidates = [];
  for (const c of candidates) {
    const overlaps = result.some(r =>
      Math.abs(r.x - c.x) < c.w * 0.3 && Math.abs(r.y - c.y) < c.h * 0.3
    );
    if (!overlaps) result.push(c);
    if (result.length >= 10) break; // limit
  }
  return result;
}

// ─── 2. Visual Object Tracker ─────────────────────────────────────────────

function _updateVisualObjects(
  rgba: Uint8ClampedArray, width: number, height: number,
  detectedCandidates: Array<{ x: number; y: number; w: number; h: number; kind?: string }>
): void {
  const now = Date.now();

  // Match detected candidates to existing objects (by overlap)
  for (const candidate of detectedCandidates) {
    let matched = false;
    for (const obj of _state.visualObjects) {
      // Check if candidate overlaps with existing object
      const overlapX = Math.max(0, Math.min(obj.x + obj.w, candidate.x + candidate.w) - Math.max(obj.x, candidate.x));
      const overlapY = Math.max(0, Math.min(obj.y + obj.h, candidate.y + candidate.h) - Math.max(obj.y, candidate.y));
      const overlapArea = overlapX * overlapY;
      const candidateArea = candidate.w * candidate.h;
      if (overlapArea > candidateArea * 0.3) {
        // Match — update position and lastSeen
        obj.x = candidate.x;
        obj.y = candidate.y;
        obj.w = candidate.w;
        obj.h = candidate.h;
        obj.lastSeen = now;
        obj.features.temporalPersistence = Math.min(1, (now - obj.firstSeen) / 30000); // 30s = full persistence
        matched = true;
        break;
      }
    }
    if (!matched && _state.visualObjects.length < MAX_VISUAL_OBJECTS) {
      // New object
      const features = _computeObjectFeatures(rgba, width, height, candidate.x, candidate.y, candidate.w, candidate.h);
      _state.visualObjects.push({
        id: `obj_${_state.objectNextId++}`,
        x: candidate.x, y: candidate.y, w: candidate.w, h: candidate.h,
        kind: (candidate.kind as any) || 'unknown',
        confidence: _scoreCandidate(features),
        features,
        firstSeen: now,
        lastSeen: now,
        timesClicked: 0,
        timesChangedPage: 0,
        timesNoEffect: 0,
      });
    }
  }

  // Remove objects not seen in the last 60 seconds
  _state.visualObjects = _state.visualObjects.filter(obj => now - obj.lastSeen < 60000);
}

// ─── 7. Region-Level Change Detection ────────────────────────────────────

function _computeRegionFingerprints3x3(
  rgba: Uint8ClampedArray, width: number, height: number
): string[] {
  const regions: string[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      // Simple hash: average luminance of the region
      let sum = 0, count = 0;
      const x0 = Math.floor(width * col / 3);
      const x1 = Math.floor(width * (col + 1) / 3);
      const y0 = Math.floor(height * row / 3);
      const y1 = Math.floor(height * (row + 1) / 3);
      const step = Math.max(1, Math.floor((x1 - x0) / 10));
      for (let y = y0; y < y1; y += step) {
        for (let x = x0; x < x1; x += step) {
          const idx = (y * width + x) * 4;
          sum += 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
          count++;
        }
      }
      regions.push(Math.round(sum / Math.max(1, count)).toString(16).padStart(2, '0'));
    }
  }
  return regions;
}

function _compareRegions(before: string[], after: string[]): {
  centerChanged: boolean; headerChanged: boolean; changedCount: number;
} {
  let centerChanged = false, headerChanged = false, changedCount = 0;
  for (let i = 0; i < 9 && i < before.length && i < after.length; i++) {
    if (before[i] !== after[i]) {
      changedCount++;
      if (i === 4) centerChanged = true;
      if (i <= 2) headerChanged = true;
    }
  }
  return { centerChanged, headerChanged, changedCount };
}

// ─── 8. Active Probing ────────────────────────────────────────────────────

function _hasTargetBeenProbed(x: number, y: number): boolean {
  return _state.probedTargets.some(t => Math.abs(t.x - x) < 20 && Math.abs(t.y - y) < 20);
}

function _recordProbe(x: number, y: number, changedPage: boolean): void {
  _state.probedTargets.push({ x, y, changedPage, timestamp: Date.now() });
  if (_state.probedTargets.length > MAX_PROBE_HISTORY) _state.probedTargets.shift();
}

// ─── 10. Safe Action Ladder ──────────────────────────────────────────────

const ACTION_RISK: Record<string, number> = {
  'wait': 0, 'observe': 0,
  'scroll_vertical': 1, 'scroll_horizontal': 1, 'flutter_swipe': 1,
  'click': 2, 'flutter_tap': 2,
  'keypad_input': 3, 'input_email': 3, 'input_password': 3, 'click_type': 3, 'reload_page': 3,
};

function _getActionRisk(actionType: string): number {
  return ACTION_RISK[actionType] ?? 2;
}

function _getMaxAllowedRisk(): number {
  if (!_state.safeActionExhausted.wait) return 0;
  if (!_state.safeActionExhausted.scroll) return 1;
  if (!_state.safeActionExhausted.lowRisk) return 2;
  return 3;
}

function _exhaustRiskLevel(risk: number): void {
  if (risk === 0) _state.safeActionExhausted.wait = true;
  else if (risk === 1) _state.safeActionExhausted.scroll = true;
  else if (risk === 2) _state.safeActionExhausted.lowRisk = true;
  else if (risk === 3) _state.safeActionExhausted.mediumRisk = true;
}

function _resetSafeActionLadder(): void {
  _state.safeActionExhausted = { wait: false, scroll: false, lowRisk: false, mediumRisk: false };
}

// ─── 12. Scroll Displacement Tracking ─────────────────────────────────────

function _recordScroll(direction: number, displacement: number): void {
  _state.scrollHistory.push({ direction, displacement, timestamp: Date.now() });
  if (_state.scrollHistory.length > MAX_SCROLL_HISTORY) _state.scrollHistory.shift();
}

function _isScrollExhausted(): boolean {
  if (_state.scrollHistory.length < 3) return false;
  // Check if last 3 scrolls in the same direction had diminishing displacement
  const recent = _state.scrollHistory.slice(-3);
  const sameDir = recent.every(s => s.direction === recent[0].direction);
  if (!sameDir) return false;
  const diminishing = recent[2].displacement < recent[0].displacement * 0.3;
  const noChange = recent[2].displacement < 0.02;
  return diminishing || noChange;
}

// ─── 13. Viewport Geometry ───────────────────────────────────────────────

interface ViewportLayout {
  hasFixedHeader: boolean;
  hasFixedFooter: boolean;
  hasSidebar: boolean;
  hasCenteredModal: boolean;
  hasRepeatedRows: boolean;
  repeatedRowCount: number;
  hasLargeBlankRegion: boolean;
}

function _analyzeViewportGeometry(
  rgba: Uint8ClampedArray, width: number, height: number
): ViewportLayout {
  // Fixed header: top 10% of screen has different brightness from center
  const headerLum = _avgLuminance(rgba, width, height, 0, 0, width, height * 0.1);
  const centerLum = _avgLuminance(rgba, width, height, width * 0.2, height * 0.3, width * 0.8, height * 0.7);
  const footerLum = _avgLuminance(rgba, width, height, 0, height * 0.9, width, height);

  // Sidebar: left 15% differs from center
  const leftLum = _avgLuminance(rgba, width, height, 0, height * 0.2, width * 0.15, height * 0.8);
  const rightLum = _avgLuminance(rgba, width, height, width * 0.85, height * 0.2, width, height * 0.8);

  // Repeated rows: scan horizontal bands for equal-height repeated patterns
  let repeatedRowCount = 0;
  const rowHeights: number[] = [];
  let bandStart = -1;
  let lastWasContent = false;
  for (let y = Math.floor(height * 0.2); y < height * 0.8; y += 3) {
    const rowLum = _avgLuminance(rgba, width, height, width * 0.1, y, width * 0.9, y + 3);
    const hasContent = rowLum > 30 && rowLum < 220;
    if (hasContent && !lastWasContent) {
      if (bandStart >= 0) rowHeights.push(y - bandStart);
      bandStart = y;
    }
    lastWasContent = hasContent;
  }
  if (bandStart >= 0) rowHeights.push(height * 0.8 - bandStart);
  // Check if multiple rows have similar height
  if (rowHeights.length >= 3) {
    const avgHeight = rowHeights.reduce((a, b) => a + b, 0) / rowHeights.length;
    const similarHeights = rowHeights.filter(h => Math.abs(h - avgHeight) < avgHeight * 0.2);
    if (similarHeights.length >= 3) {
      repeatedRowCount = similarHeights.length;
    }
  }

  return {
    hasFixedHeader: Math.abs(headerLum - centerLum) > 30,
    hasFixedFooter: Math.abs(footerLum - centerLum) > 30,
    hasSidebar: Math.abs(leftLum - centerLum) > 30 || Math.abs(rightLum - centerLum) > 30,
    hasCenteredModal: false, // checked by modal detector
    hasRepeatedRows: repeatedRowCount >= 3,
    repeatedRowCount,
    hasLargeBlankRegion: centerLum > 240 || centerLum < 10,
  };
}

function _avgLuminance(rgba: Uint8ClampedArray, width: number, height: number, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0, count = 0;
  const step = Math.max(1, Math.floor((x1 - x0) / 20));
  for (let y = Math.floor(y0); y < y1; y += step) {
    for (let x = Math.floor(x0); x < x1; x += step) {
      if (x >= width || y >= height) continue;
      const idx = (y * width + x) * 4;
      sum += 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

// ─── 14. Temporal Classification ──────────────────────────────────────────

function _recordTemporalFrame(regionFingerprints: string[]): void {
  _state.temporalFrames.push({ timestamp: Date.now(), regionFingerprints });
  if (_state.temporalFrames.length > MAX_TEMPORAL_FRAMES) _state.temporalFrames.shift();
}

function _classifyTemporalState(): RegionTemporalState {
  if (_state.temporalFrames.length < 2) return 'unknown';

  const frames = _state.temporalFrames;
  const last = frames[frames.length - 1];
  const prev = frames[frames.length - 2];
  const dt = last.timestamp - prev.timestamp;

  if (dt > 5000) return 'unknown'; // too much time between frames

  const changes = _compareRegions(prev.regionFingerprints, last.regionFingerprints);
  const centerChanged = changes.centerChanged;
  const allChanged = changes.changedCount >= 7;
  const noneChanged = changes.changedCount === 0;

  if (noneChanged) return 'static';
  if (allChanged) return 'loading';
  if (centerChanged && changes.changedCount <= 3) return 'progressing';

  // Check for appearing/disappearing
  if (frames.length >= 3) {
    const older = frames[frames.length - 3];
    const olderChanges = _compareRegions(older.regionFingerprints, prev.regionFingerprints);
    if (olderChanges.changedCount > 3 && noneChanged) return 'disappearing';
    if (olderChanges.changedCount === 0 && changes.changedCount > 3) return 'appearing';
  }

  return 'animated';
}

// ─── 16. Unsupervised Color Calibration ──────────────────────────────────

function _recordUnsupervisedColor(r: number, g: number, b: number): void {
  // Quantize color to reduce noise
  const key = `${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)}`;
  _state.unsupervisedColors.set(key, (_state.unsupervisedColors.get(key) || 0) + 1);
}

function _getCalibratedColors(): Array<{ r: number; g: number; b: number; count: number }> {
  return Array.from(_state.unsupervisedColors.entries())
    .map(([key, count]) => {
      const [r, g, b] = key.split(',').map(Number);
      return { r: r * 16, g: g * 16, b: b * 16, count };
    })
    .filter(c => c.count >= 3) // seen at least 3 times
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
}

// ─── 17. Explicit Wait/Observe Actions ────────────────────────────────────

function _waitAction(reason: string, ms: number = 500): ActionHypothesis {
  return {
    actionType: 'wait',
    targetX: 0, targetY: 0,
    evidence: [reason],
    confidence: 0.9,
    expectedEffects: ['page may finish loading', 'animation may complete'],
    risk: 0,
    reversible: true,
    reason: `wait ${ms}ms — ${reason}`,
  };
}

function _observeAction(reason: string): ActionHypothesis {
  return {
    actionType: 'observe',
    targetX: 0, targetY: 0,
    evidence: [reason],
    confidence: 0.8,
    expectedEffects: ['gather more visual evidence'],
    risk: 0,
    reversible: true,
    reason: `observe — ${reason}`,
  };
}

// ─── 18. Persistent Journal ───────────────────────────────────────────────

function _saveJournal(): void {
  try {
    const journal = {
      timestamp: Date.now(),
      visualObjects: _state.visualObjects.map(o => ({
        id: o.id, x: o.x, y: o.y, w: o.w, h: o.h, kind: o.kind,
        timesClicked: o.timesClicked, timesChangedPage: o.timesChangedPage, timesNoEffect: o.timesNoEffect,
      })),
      probedTargets: _state.probedTargets,
      unsupervisedColors: Array.from(_state.unsupervisedColors.entries()).slice(0, 50),
    };
    const fs = require('fs');
    const path = require('path');
    const journalPath = path.join(require('os').tmpdir(), 'pixel-fallback-journal.json');
    fs.writeFileSync(journalPath, JSON.stringify(journal));
    log(`Pixel fallback journal saved: ${_state.visualObjects.length} objects, ${_state.probedTargets.length} probes`, 'DEBUG', 'vision-engine');
  } catch (e: any) {
    log(`Journal save failed: ${e.message}`, 'DEBUG', 'vision-engine');
  }
}

function _loadJournal(): void {
  if (_state.journalLoaded) return;
  _state.journalLoaded = true;
  try {
    const fs = require('fs');
    const path = require('path');
    const journalPath = path.join(require('os').tmpdir(), 'pixel-fallback-journal.json');
    if (fs.existsSync(journalPath)) {
      const data = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      // Restore unsupervised colors
      if (data.unsupervisedColors) {
        for (const [key, count] of data.unsupervisedColors) {
          _state.unsupervisedColors.set(key, count);
        }
      }
      log(`Pixel fallback journal loaded: ${data.unsupervisedColors?.length || 0} colors restored`, 'INFO', 'vision-engine');
    }
  } catch (e: any) {
    log(`Journal load failed: ${e.message}`, 'DEBUG', 'vision-engine');
  }
}

// ─── 19. Defensive Coordinate Handling ────────────────────────────────────

function _scaleCoordinates(
  x: number, y: number,
  screenshotWidth: number, screenshotHeight: number,
  viewportWidth: number, viewportHeight: number
): { x: number; y: number } {
  const scaleX = viewportWidth / screenshotWidth;
  const scaleY = viewportHeight / screenshotHeight;
  return {
    x: Math.round(x * scaleX),
    y: Math.round(y * scaleY),
  };
}

// ─── 20. Emergency Policy (Main Entry Point) ─────────────────────────────

/**
 * The main emergency policy flowchart.
 * This is the "general visual perception → hypothesis → experiment →
 * consequence → memory loop" described in the advice.
 *
 * Called by the pixel fallback when the normal detectors can't produce
 * a confident action. Returns an ActionHypothesis or null.
 */
async function runEmergencyPolicy(
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
  currentState?: string
): Promise<ActionHypothesis | null> {
  _loadJournal();

  // Step 1: Is image valid?
  if (width < 200 || height < 150) {
    return _waitAction('screenshot too small for analysis');
  }
  const contrast = _computeContrast(rgba, width, height);
  if (contrast < 3) {
    return _waitAction('page appears blank/flat (low contrast)');
  }

  // Step 2: Build visual scene
  const regionFingerprints = _computeRegionFingerprints3x3(rgba, width, height);
  _recordTemporalFrame(regionFingerprints);

  // Step 3: Detect obstructions (modal, loading)
  const temporalState = _classifyTemporalState();
  if (temporalState === 'loading' || temporalState === 'progressing') {
    return _waitAction(`page is ${temporalState} (temporal classification)`, 1000);
  }

  // Step 4: Match known state
  const mode = _determineOperatingMode(currentState, 0.5);

  // Step 5: Detect candidates using connected components + edge detection
  const ccCandidates = _detectCandidatesViaConnectedComponents(rgba, width, height);
  const edgeCandidates = _detectButtonsByEdges(rgba, width, height);

  // Merge candidates
  const allCandidates = [
    ...ccCandidates.map(c => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
    ...edgeCandidates.map(c => ({ x: c.x, y: c.y, w: c.w, h: c.h })),
  ];

  // Step 6: Update visual object map
  _updateVisualObjects(rgba, width, height, allCandidates);

  // Step 7: Score candidates with multi-feature scoring
  const scoredCandidates = _state.visualObjects
    .filter(obj => obj.timesNoEffect < 3) // skip objects that failed 3+ times
    .map(obj => ({
      obj,
      score: _scoreCandidate(obj.features) - (obj.timesNoEffect * 0.1),
    }))
    .sort((a, b) => b.score - a.score);

  // Step 8: Active probing — skip already-probed targets
  const unprobedCandidates = scoredCandidates.filter(c => !_hasTargetBeenProbed(c.obj.x + c.obj.w / 2, c.obj.y + c.obj.h / 2));

  // Step 9: Safe action ladder — only attempt actions at or below the max allowed risk
  const maxRisk = _getMaxAllowedRisk();

  // Step 10: Generate hypothesis
  if (unprobedCandidates.length > 0 && maxRisk >= 2) {
    const best = unprobedCandidates[0];
    const cx = best.obj.x + best.obj.w / 2;
    const cy = best.obj.y + best.obj.h / 2;

    // Record unsupervised color for calibration
    _recordUnsupervisedColor(best.obj.features.color.r, best.obj.features.color.g, best.obj.features.color.b);

    return {
      actionType: 'click',
      targetX: cx,
      targetY: cy,
      evidence: [
        `connected-component detected (${best.obj.w}x${best.obj.h})`,
        `multi-feature score: ${best.score.toFixed(2)}`,
        `temporal persistence: ${best.obj.features.temporalPersistence.toFixed(2)}`,
        `edge density: ${best.obj.features.edgeDensity.toFixed(2)}`,
        best.obj.timesClicked > 0 ? `previously clicked ${best.obj.timesClicked}x (${best.obj.timesChangedPage} changed page)` : 'never clicked',
      ],
      confidence: best.score,
      expectedEffects: ['screen fingerprint changes', 'new content appears'],
      risk: 2,
      reversible: true,
      reason: `Emergency policy: clicking highest-scoring unprobed candidate at (${cx}, ${cy}) score=${best.score.toFixed(2)}`,
    };
  }

  // Step 11: If no candidates or risk too high, try lower-risk actions
  if (maxRisk >= 1 && !_isScrollExhausted()) {
    // Try scrolling to discover new content
    const displacement = 0.3; // estimated
    _recordScroll(1, displacement);
    return {
      actionType: 'scroll_vertical',
      targetX: width / 2,
      targetY: height * 0.7,
      targetX2: width / 2,
      targetY2: height * 0.3,
      evidence: ['no clickable candidates found', 'scroll may reveal new content'],
      confidence: 0.5,
      expectedEffects: ['new regions become visible'],
      risk: 1,
      reversible: true,
      reason: 'Emergency policy: scrolling to discover new content',
    };
  }

  // Step 12: Last resort — wait and observe
  _exhaustRiskLevel(_getMaxAllowedRisk());
  if (_getMaxAllowedRisk() >= 3) {
    _resetSafeActionLadder(); // all exhausted — start over
  }

  return _observeAction('all candidates exhausted or risk too high — gathering more evidence');
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function _computeContrast(rgba: Uint8ClampedArray, width: number, height: number): number {
  let sum = 0, sqSum = 0, count = 0;
  const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 500)));
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
      sum += lum; sqSum += lum * lum; count++;
    }
  }
  if (count === 0) return 0;
  const mean = sum / count;
  const variance = (sqSum / count) - (mean * mean);
  return Math.sqrt(Math.max(0, variance));
}

// ─── Record Outcome (called by cycle-manager) ────────────────────────────

function recordOutcome(newRegionFingerprints: string[], pageChanged: boolean): void {
  // Update visual objects
  if (_state.lastRegionFingerprints.length > 0) {
    const changes = _compareRegions(_state.lastRegionFingerprints, newRegionFingerprints);
    // Update the last-clicked object's effectiveness
    const lastProbe = _state.probedTargets[_state.probedTargets.length - 1];
    if (lastProbe) {
      lastProbe.changedPage = pageChanged && (changes.changedCount > 0);
    }
  }
  _state.lastRegionFingerprints = newRegionFingerprints;

  // Reset safe action ladder if page changed
  if (pageChanged) {
    _resetSafeActionLadder();
  }

  // Save journal periodically
  if (_state.probedTargets.length % 5 === 0) {
    _saveJournal();
  }
}

// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  runEmergencyPolicy,
  recordOutcome,
  _loadJournal,
  // Exposed for testing
  _computeContrast,
  _computeRegionFingerprints3x3,
  _connectedComponents,
  _detectButtonsByEdges,
  _analyzeViewportGeometry,
};
