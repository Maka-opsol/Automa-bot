'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// pixel-fallback.ts — Pure pixel-based page analysis & action generation v2
// ═══════════════════════════════════════════════════════════════════════════
// When ALL AI providers fail AND DOM is empty (Flutter canvas) AND semantics
// return nothing, this module falls back to raw screenshot pixel analysis.
//
// LOGIN FLOW HANDLED:
//   1. MathU redirects to Microsoft login (login.microsoftonline.com)
//      → detects email input field → types email → clicks Next
//   2. Microsoft redirects to ADVLEARN password page
//      → detects password input field → types password → clicks Sign in
//   3. "Stay signed in?" prompt
//      → clicks Yes/Stay signed in button
//   4. "Use another account" option
//      → detects and clicks if needed
//   5. Various intermediate screens (Continue, etc.)
//
// APP PAGES HANDLED:
//   - Assignments: finds download arrow buttons, then Start/Watch/Redo blue buttons
//   - Module download: detects download arrow icon on module cards, clicks to download
//   - Module topics: detects expanded module content with topic buttons
//   - Quiz: finds Done/Submit teal-green buttons, numeric keypad
//   - Exercise: MUST click open book icon (top-right of card) to view memo BEFORE
//     clicking Next — the app requires viewing the memo before proceeding.
//     Detects the book icon as a small blue element in the top-right of the white card.
//   - Score screen: finds Continue to pathway button
//   - Video player: clicks video to open it, watches for exactly 2 minutes 59 seconds,
//     then finds back/X button to dismiss.
//
// Detection methods:
//   - URL pattern matching (primary for Microsoft auth pages)
//   - Background color analysis (blue = Microsoft/assignment, mint = quiz)
//   - Pixel region scanning for white input fields, blue buttons, green buttons
//   - Aspect ratio filtering for shape classification
//
// No external dependencies — uses only Node.js built-ins (zlib, Buffer).
// Memory: ~4 MB for a 1280×720 RGBA decode. CPU: ~20-30ms total.
// ═══════════════════════════════════════════════════════════════════════════

const zlib = require('zlib');
const { log } = require('./logger');

// ─── PNG Decoder (minimal, RGBA 8-bit only) ───────────────────────────────

function _paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function _decodePNG(buffer: Buffer): { width: number; height: number; rgba: Uint8ClampedArray } | null {
  try {
    if (buffer.length < 24 ||
        buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E ||
        buffer[3] !== 0x47 || buffer[4] !== 0x0D || buffer[5] !== 0x0A ||
        buffer[6] !== 0x1A || buffer[7] !== 0x0A) {
      return null;
    }

    let width = 0, height = 0, colorType = 0, bitDepth = 0;
    const idatChunks: Buffer[] = [];
    let offset = 8;

    while (offset + 12 <= buffer.length) {
      const chunkLen = buffer.readUInt32BE(offset);
      const chunkType = buffer.toString('ascii', offset + 4, offset + 8);

      if (chunkType === 'IHDR' && chunkLen >= 13) {
        width = buffer.readUInt32BE(offset + 8);
        height = buffer.readUInt32BE(offset + 12);
        bitDepth = buffer[offset + 16];
        colorType = buffer[offset + 17];
      } else if (chunkType === 'IDAT') {
        idatChunks.push(buffer.subarray(offset + 8, offset + 8 + chunkLen));
      } else if (chunkType === 'IEND') {
        break;
      }

      offset += 12 + chunkLen;
      if (chunkLen > buffer.length) break;
    }

    if (width === 0 || height === 0 || width > 4096 || height > 4096) return null;
    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) return null;

    const channels = colorType === 6 ? 4 : 3;
    const stride = width * channels;
    const compressed = Buffer.concat(idatChunks);
    const raw = zlib.inflateSync(compressed, { maxOutputLength: (stride + 1) * height + height });
    const rgba = new Uint8ClampedArray(width * height * 4);

    for (let y = 0; y < height; y++) {
      const filterByte = raw[y * (stride + 1)];
      const rowSrc = y * (stride + 1) + 1;
      const rowDst = y * width * 4;

      for (let x = 0; x < width; x++) {
        for (let c = 0; c < 4; c++) {
          const srcC = c < channels ? c : channels - 1;
          const rawVal = raw[rowSrc + x * channels + srcC];
          const left = x > 0 ? rgba[rowDst + (x - 1) * 4 + c] : 0;
          const above = y > 0 ? rgba[rowDst - width * 4 + x * 4 + c] : 0;
          const upperLeft = (x > 0 && y > 0) ? rgba[rowDst - width * 4 + (x - 1) * 4 + c] : 0;

          let val: number;
          switch (filterByte) {
            case 1: val = rawVal + left; break;
            case 2: val = rawVal + above; break;
            case 3: val = rawVal + ((left + above) >> 1); break;
            case 4: val = rawVal + _paethPredictor(left, above, upperLeft); break;
            default: val = rawVal; break;
          }
          rgba[rowDst + x * 4 + c] = val & 0xFF;
        }
        if (channels === 3) {
          rgba[rowDst + x * 4 + 3] = 255;
        }
      }
    }

    return { width, height, rgba };
  } catch (e: any) {
    log(`PNG decode failed: ${e.message}`, 'DEBUG', 'pixel-fallback');
    return null;
  }
}

// ─── Color helpers ────────────────────────────────────────────────────────

function _isWhiteish(r: number, g: number, b: number): boolean {
  return r > 210 && g > 210 && b > 210;
}

function _isLightGray(r: number, g: number, b: number): boolean {
  return r > 180 && g > 180 && b > 180 && !(r > 230 && g > 230 && b > 230);
}

/** Microsoft brand blue: #0078D4 → R:0-30 G:100-140 B:190-230 */
function _isMicrosoftBlue(r: number, g: number, b: number): boolean {
  return r < 60 && g > 80 && g < 180 && b > 160 && b < 240;
}

/** Deep royal blue (MathU app header/sidebar): #1e3a8a → R:20-40 G:50-70 B:120-150 */
function _isDeepBlue(r: number, g: number, b: number): boolean {
  return r < 50 && g > 40 && g < 80 && b > 100 && b < 170;
}

/** Download button circle color: dark navy blue (#1e3a8a range) */
function _isDownloadButtonColor(r: number, g: number, b: number): boolean {
  return r < 55 && g > 40 && g < 80 && b > 110 && b < 180;
}

/** White/light arrow color inside download button: R>200 G>200 B>200 */
function _isArrowWhite(r: number, g: number, b: number): boolean {
  return r > 200 && g > 200 && b > 200;
}

/** Teal-green gradient (quiz Submit/Done buttons): #0d9488 to #22c55e */
function _isTealGreen(r: number, g: number, b: number): boolean {
  return g > 140 && b > 100 && r < g - 30 && b < g + 20;
}

/** Bright green (Next button on exercise, Start on assignments): #10B981 to #22c55e */
function _isGreenish(r: number, g: number, b: number): boolean {
  return g > 150 && r < g - 40 && b < g - 20 && b > 50;
}

function _isOrangeish(r: number, g: number, b: number): boolean {
  return r > 200 && g > 100 && g < 180 && b < 100;
}

function _isDark(r: number, g: number, b: number): boolean {
  return r < 60 && g < 60 && b < 60;
}

/** Pale mint/cyan background (quiz pages): #ECFEFF → R:230+ G:250+ B:255 */
function _isMintBackground(r: number, g: number, b: number): boolean {
  return r > 220 && g > 240 && b > 240;
}

/** Light lavender/blue-grey (choice buttons in quiz): #e2e8f0 */
function _isLavender(r: number, g: number, b: number): boolean {
  return r > 200 && g > 210 && b > 230 && r < 240 && g < 240 && b < 250;
}

// ─── Rectangle detection ───────────────────────────────────────────────────

interface DetectedRect {
  x: number; y: number; w: number; h: number;
  cx: number; cy: number;
}

/**
 * Find horizontal bands of pixels matching a color predicate.
 * Returns bounding boxes of rectangular regions.
 */
function _findColorBands(
  rgba: Uint8ClampedArray, width: number, height: number,
  colorFn: (r: number, g: number, b: number) => boolean,
  y1: number, y2: number, x1: number, x2: number,
  step: number = 2
): DetectedRect[] {
  interface RowBand { y: number; left: number; right: number; count: number }
  const rowBands: RowBand[] = [];

  for (let y = y1; y < y2; y++) {
    let left = -1, right = -1, count = 0;
    for (let x = x1; x < x2; x += step) {
      const idx = (y * width + x) * 4;
      if (colorFn(rgba[idx], rgba[idx + 1], rgba[idx + 2])) {
        if (left === -1) left = x;
        right = x;
        count++;
      }
    }
    if (left !== -1 && right !== -1 && count >= 5) {
      rowBands.push({ y, left, right, count });
    }
  }

  if (rowBands.length === 0) return [];

  const rects: DetectedRect[] = [];
  let groupStart = 0;

  for (let i = 1; i <= rowBands.length; i++) {
    const cur = rowBands[i - 1];
    const next = rowBands[i];
    const isContinuation = next &&
      next.y - cur.y <= 3 &&
      Math.abs(cur.left - next.left) < 40 &&
      Math.abs(cur.right - next.right) < 40;

    if (!isContinuation) {
      let minY = Infinity, maxY = -Infinity, sumLeft = 0, sumRight = 0, cnt = 0;
      for (let j = groupStart; j < i; j++) {
        const b = rowBands[j];
        if (b.y < minY) minY = b.y;
        if (b.y > maxY) maxY = b.y;
        sumLeft += b.left;
        sumRight += b.right;
        cnt++;
      }
      const avgLeft = sumLeft / cnt;
      const avgRight = sumRight / cnt;
      const rw = avgRight - avgLeft;
      const rh = maxY - minY;

      if (rw >= 30 && rh >= 8) {
        rects.push({
          x: Math.round(avgLeft), y: minY,
          w: Math.round(rw), h: Math.round(rh),
          cx: Math.round((avgLeft + avgRight) / 2),
          cy: Math.round((minY + maxY) / 2)
        });
      }
      groupStart = i;
    }
  }

  return rects;
}

// ─── Element finders ──────────────────────────────────────────────────────

/**
 * Find input fields (white rectangle with aspect ratio > 3:1).
 * Scans the center 60% of the image vertically, 15%-85% horizontally.
 * Returns ALL matching input fields sorted by Y position (top first).
 */
function _findAllInputFields(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect[] {
  const y1 = Math.floor(height * 0.25);
  const y2 = Math.floor(height * 0.75);
  const x1 = Math.floor(width * 0.15);
  const x2 = Math.floor(width * 0.85);

  const whiteBands = _findColorBands(rgba, width, height, _isWhiteish, y1, y2, x1, x2, 2);
  const grayBands = _findColorBands(rgba, width, height, _isLightGray, y1, y2, x1, x2, 2);

  const allRects = [...whiteBands, ...grayBands];

  // Filter for input-like aspect ratios (wide and short)
  return allRects
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return aspectRatio > 3.0 && aspectRatio < 25 && r.w >= 80 && r.w <= 800 && r.h >= 12 && r.h <= 80;
    })
    .sort((a, b) => a.cy - b.cy);
}

/**
 * Find a single input field (returns the topmost one).
 */
function _findInputField(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const fields = _findAllInputFields(rgba, width, height);
  return fields.length > 0 ? fields[0] : null;
}

/**
 * Find a Microsoft-blue button (Next / Sign in).
 * Looks for Microsoft-blue rectangles in a vertical range.
 */
function _findBlueButton(
  rgba: Uint8ClampedArray, width: number, height: number,
  belowY: number, aboveY?: number
): DetectedRect | null {
  const y1 = belowY;
  const y2 = aboveY ? Math.min(aboveY, height - 10) : Math.min(Math.floor(belowY + height * 0.4), height - 10);
  const x1 = Math.floor(width * 0.15);
  const x2 = Math.floor(width * 0.85);

  const blueBands = _findColorBands(rgba, width, height, _isMicrosoftBlue, y1, y2, x1, x2, 2);

  const buttons = blueBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 60 && r.w <= 600 && r.h >= 18 && r.h <= 80 && aspectRatio > 1.5 && aspectRatio < 25;
    })
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Find a teal-green gradient button (Submit/Done/Continue in quiz).
 * These are the gradient buttons from #0EA5E9 to #10B981.
 */
function _findTealGreenButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const y1 = Math.floor(height * 0.80);
  const y2 = Math.floor(height * 0.98);
  const x1 = Math.floor(width * 0.10);
  const x2 = Math.floor(width * 0.90);

  const greenBands = _findColorBands(rgba, width, height, _isTealGreen, y1, y2, x1, x2, 2);

  const buttons = greenBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 80 && r.w <= 700 && r.h >= 20 && r.h <= 80 && aspectRatio > 2 && aspectRatio < 20;
    })
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Find a bright green Next button (exercise navigation).
 * Green fill #10B981 with white text.
 */
function _findGreenButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const y1 = Math.floor(height * 0.88);
  const y2 = Math.floor(height * 0.98);
  const x1 = Math.floor(width * 0.70);
  const x2 = Math.floor(width * 0.98);

  const greenBands = _findColorBands(rgba, width, height, _isGreenish, y1, y2, x1, x2, 2);

  const buttons = greenBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 60 && r.w <= 300 && r.h >= 20 && r.h <= 60 && aspectRatio > 1.5 && aspectRatio < 10;
    })
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Find a prominent colored button (green, orange, blue, teal) on any page.
 * Used for Watch/Start/Play/Redo buttons on assignment pages.
 */
function _findActionButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const y1 = Math.floor(height * 0.15);
  const y2 = Math.floor(height * 0.85);
  const x1 = Math.floor(width * 0.10);
  const x2 = Math.floor(width * 0.90);

  const isButtonColor = (r: number, g: number, b: number) =>
    _isGreenish(r, g, b) || _isOrangeish(r, g, b) || _isMicrosoftBlue(r, g, b) || _isTealGreen(r, g, b);

  const coloredBands = _findColorBands(rgba, width, height, isButtonColor, y1, y2, x1, x2, 3);

  const buttons = coloredBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 50 && r.w <= 400 && r.h >= 18 && r.h <= 80 && aspectRatio > 1.5 && aspectRatio < 15;
    })
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Find a dark "Sign in" / "Next" text-like button (dark on white background).
 */
function _findDarkButton(
  rgba: Uint8ClampedArray, width: number, height: number,
  belowY: number
): DetectedRect | null {
  const y1 = belowY;
  const y2 = Math.min(Math.floor(belowY + height * 0.3), height - 10);
  const x1 = Math.floor(width * 0.2);
  const x2 = Math.floor(width * 0.8);

  const darkBands = _findColorBands(rgba, width, height, _isDark, y1, y2, x1, x2, 2);

  const buttons = darkBands
    .filter(r => r.w >= 40 && r.w <= 300 && r.h >= 10 && r.h <= 50)
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Find download arrow button on module cards.
 * These are dark navy blue circles (~30-45px diameter) containing a white
 * downward arrow icon, typically located in the right portion of module cards.
 * On MathU, each module card has a download button that must be clicked
 * before the module content (topics with Watch/Start buttons) becomes visible.
 */
function _findDownloadButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  // Scan the card area: roughly right 40-85% horizontally, 15-85% vertically
  const y1 = Math.floor(height * 0.15);
  const y2 = Math.floor(height * 0.85);
  const x1 = Math.floor(width * 0.40);
  const x2 = Math.floor(width * 0.85);

  const downloadBands = _findColorBands(rgba, width, height, _isDownloadButtonColor, y1, y2, x1, x2, 3);

  // Filter for roughly square shapes (download buttons are circular)
  const candidates = downloadBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      // Download buttons are roughly square (circles appear as squares in pixel scan)
      return r.w >= 25 && r.w <= 55 && r.h >= 25 && r.h <= 55 &&
             aspectRatio > 0.6 && aspectRatio < 1.6;
    });

  if (candidates.length === 0) return null;

  // Verify candidate has a white arrow inside (downward pointing)
  // Sample pixels in the center of the button for white arrow pixels
  for (const candidate of candidates) {
    let whitePixelsInCenter = 0;
    let totalPixelsChecked = 0;
    const cx = candidate.cx;
    const cy = candidate.cy;
    const radius = Math.min(candidate.w, candidate.h) / 2;

    // Check a vertical strip in the center (the arrow shaft)
    for (let dy = -Math.floor(radius * 0.6); dy <= Math.floor(radius * 0.6); dy += 2) {
      const px = cx;
      const py = cy + dy;
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const idx = (py * width + px) * 4;
        totalPixelsChecked++;
        if (_isArrowWhite(rgba[idx], rgba[idx + 1], rgba[idx + 2])) {
          whitePixelsInCenter++;
        }
      }
    }
    // Also check a horizontal strip lower-half (the arrow head)
    for (let dx = -Math.floor(radius * 0.5); dx <= Math.floor(radius * 0.5); dx += 2) {
      const px = cx + dx;
      const py = Math.floor(cy + radius * 0.3);
      if (px >= 0 && px < width && py >= 0 && py < height) {
        const idx = (py * width + px) * 4;
        totalPixelsChecked++;
        if (_isArrowWhite(rgba[idx], rgba[idx + 1], rgba[idx + 2])) {
          whitePixelsInCenter++;
        }
      }
    }

    // If enough white pixels inside, this is a download button with arrow
    if (totalPixelsChecked > 0 && whitePixelsInCenter / totalPixelsChecked > 0.25) {
      log(`Pixel fallback: found download button at (${cx}, ${cy}) size ${candidate.w}x${candidate.h}`, 'INFO', 'pixel-fallback');
      return candidate;
    }
  }

  return null;
}

/**
 * Detect if module content has loaded (topics visible with multiple small colored buttons).
 * After clicking download, the module card expands to show individual topics.
 * This function checks for a cluster of 2+ small colored buttons (Watch/Start)
 * which indicates the module content is now visible.
 */
function _isModuleContentLoaded(
  rgba: Uint8ClampedArray, width: number, height: number
): boolean {
  // Look for clusters of small colored buttons in the main content area
  const y1 = Math.floor(height * 0.20);
  const y2 = Math.floor(height * 0.85);
  const x1 = Math.floor(width * 0.15);
  const x2 = Math.floor(width * 0.85);

  const isButtonColor = (r: number, g: number, b: number) =>
    _isGreenish(r, g, b) || _isOrangeish(r, g, b) || _isTealGreen(r, g, b);

  const coloredBands = _findColorBands(rgba, width, height, isButtonColor, y1, y2, x1, x2, 3);

  // Filter for small button shapes (topic buttons are smaller than main action buttons)
  const topicButtons = coloredBands.filter(r => {
    return r.w >= 40 && r.w <= 200 && r.h >= 15 && r.h <= 50;
  });

  // If we see 2+ small colored buttons, module content is likely loaded
  return topicButtons.length >= 2;
}

/**
 * Find lavender/blue-grey pill-shaped buttons (multiple choice options in quiz).
 */
function _findChoiceButtons(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect[] {
  const y1 = Math.floor(height * 0.60);
  const y2 = Math.floor(height * 0.85);
  const x1 = Math.floor(width * 0.15);
  const x2 = Math.floor(width * 0.85);

  const lavenderBands = _findColorBands(rgba, width, height, _isLavender, y1, y2, x1, x2, 2);

  return lavenderBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 60 && r.w <= 400 && r.h >= 20 && r.h <= 60 && aspectRatio > 2 && aspectRatio < 10;
    })
    .sort((a, b) => a.cx - b.cx);
}

// ─── Selected choice detection ─────────────────────────────────────────────

/**
 * Detect if a choice button is already "selected" (highlighted/active state).
 * In MathU quiz, a selected choice typically has a darker border or filled background
 * compared to unselected lavender buttons. We check for a more saturated/colored state.
 */
function _isSelectedChoice(
  rgba: Uint8ClampedArray, width: number, rect: DetectedRect
): boolean {
  // Sample the center of the choice button — selected choices tend to have
  // a colored tint (teal/blue overlay) rather than pure lavender
  const cx = Math.floor(rect.cx);
  const cy = Math.floor(rect.cy);
  const sampleRadius = 3;

  let tealCount = 0;
  let totalCount = 0;
  for (let dy = -sampleRadius; dy <= sampleRadius; dy++) {
    for (let dx = -sampleRadius; dx <= sampleRadius; dx++) {
      const px = cx + dx;
      const py = cy + dy;
      if (px < 0 || px >= width || py < 0 || py >= height) continue;
      const idx = (py * width + px) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      totalCount++;
      if (_isTealGreen(r, g, b) || (b > 150 && g > 120 && r < 100)) {
        tealCount++;
      }
    }
  }
  // If >40% of center pixels show teal/blue tint, consider it selected
  return totalCount > 0 && (tealCount / totalCount) > 0.4;
}

/**
 * Check if any choice button appears to be already selected on the quiz page.
 * Returns the selected button rect or null.
 */
function _findSelectedChoice(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const choices = _findChoiceButtons(rgba, width, height);
  for (const choice of choices) {
    if (_isSelectedChoice(rgba, width, choice)) {
      return choice;
    }
  }
  return null;
}

// ─── Full-width button detection ──────────────────────────────────────────

/**
 * Find a full-width colored button at the bottom of the screen.
 * Used for "Continue to pathway" and similar wide action buttons on score screens.
 * Wider and lower than the teal-green submit button.
 */
function _findFullWidthButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const y1 = Math.floor(height * 0.82);
  const y2 = Math.floor(height * 0.98);
  const x1 = Math.floor(width * 0.05);
  const x2 = Math.floor(width * 0.95);

  // Accept teal-green, green, or blue full-width buttons
  const isFullWidthColor = (r: number, g: number, b: number) =>
    _isTealGreen(r, g, b) || _isGreenish(r, g, b) || _isMicrosoftBlue(r, g, b);

  const bands = _findColorBands(rgba, width, height, isFullWidthColor, y1, y2, x1, x2, 2);

  // Filter for full-width buttons: very wide, moderate height, high aspect ratio
  const buttons = bands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= width * 0.6 && r.h >= 25 && r.h <= 70 && aspectRatio > 4 && aspectRatio < 25;
    })
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

// ─── Next question button detection ────────────────────────────────────────

/**
 * Find a "Next" button at the bottom-right of the screen.
 * This appears on multi-question assessments (e.g., "1/88 Chapter Test") after
 * answering a question. It's a smaller teal/green button than the full-width submit.
 */
function _findNextQuestionButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  // Bottom-right region only — Next button is typically right-aligned
  const y1 = Math.floor(height * 0.88);
  const y2 = Math.floor(height * 0.98);
  const x1 = Math.floor(width * 0.60);
  const x2 = Math.floor(width * 0.95);

  const isNextColor = (r: number, g: number, b: number) =>
    _isTealGreen(r, g, b) || _isGreenish(r, g, b);

  const bands = _findColorBands(rgba, width, height, isNextColor, y1, y2, x1, x2, 2);

  const buttons = bands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 50 && r.w <= 250 && r.h >= 20 && r.h <= 55 && aspectRatio > 1.5 && aspectRatio < 8;
    })
    .sort((a, b) => a.cx - b.cx);

  return buttons.length > 0 ? buttons[0] : null;
}

// ─── Basic text region extraction ──────────────────────────────────────

/**
 * Estimate the "darkness" of a pixel region — returns a score 0-1 where
 * 1 = very dark (likely text on light background).
 * Used for extracting question text and choice labels from quiz pages.
 */
function _getTextDensityInRegion(
  rgba: Uint8ClampedArray, width: number, height: number,
  x1: number, y1: number, x2: number, y2: number
): number {
  let darkPixels = 0;
  let totalPixels = 0;
  const step = 2; // sample every 2 pixels for speed
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * width + x) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      totalPixels++;
      // Dark pixels (text): luminance < 80
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luminance < 80) darkPixels++;
    }
  }
  return totalPixels > 0 ? darkPixels / totalPixels : 0;
}

/**
 * Attempt to identify question text region and choice text regions on a quiz page.
 * Returns a summary object with estimated text positions (not actual OCR text).
 * This provides context for the math verifier — it can't read the text but
 * can tell WHERE text is located, enabling better coordinate-based extraction later.
 *
 * Returns null if no text regions found (e.g., page is all buttons/no question visible).
 */
function _extractTextRegions(
  rgba: Uint8ClampedArray, width: number, height: number
): { questionRegion: { x1: number; y1: number; x2: number; y2: number; density: number } | null; choiceRegions: Array<{ x1: number; y1: number; x2: number; y2: number; density: number; index: number }> } | null {
  // Question text is typically in the upper portion of the white card area
  // On MathU quiz pages, the question sits above the choice buttons
  const qY1 = Math.floor(height * 0.25);
  const qY2 = Math.floor(height * 0.55);
  const qX1 = Math.floor(width * 0.10);
  const qX2 = Math.floor(width * 0.90);
  const questionDensity = _getTextDensityInRegion(rgba, width, height, qX1, qY1, qX2, qY2);

  // Only proceed if we found meaningful text density (question text exists)
  if (questionDensity < 0.05) return null;

  const questionRegion = { x1: qX1, y1: qY1, x2: qX2, y2: qY2, density: questionDensity };

  // Choice text regions are within/around each lavender button
  const choices = _findChoiceButtons(rgba, width, height);
  const choiceRegions: Array<{ x1: number; y1: number; x2: number; y2: number; density: number; index: number }> = [];

  for (let i = 0; i < choices.length; i++) {
    const c = choices[i];
    // Expand slightly around each choice button to capture label text
    const cx1 = Math.max(0, Math.floor(c.x - 5));
    const cy1 = Math.max(0, Math.floor(c.y - 2));
    const cx2 = Math.min(width, Math.floor(c.x + c.w + 5));
    const cy2 = Math.min(height, Math.floor(c.y + c.h + 2));
    const density = _getTextDensityInRegion(rgba, width, height, cx1, cy1, cx2, cy2);
    choiceRegions.push({ x1: cx1, y1: cy1, x2: cx2, y2: cy2, density, index: i });
  }

  return { questionRegion, choiceRegions };
}

// ─── Page type detection (URL-based) ──────────────────────────────────────

function _isMicrosoftLoginPage(url: string): boolean {
  return url.includes('login.microsoftonline.com') ||
         url.includes('login.live.com') ||
         url.includes('login.microsoft.com');
}

function _isMicrosoftPasswordPage(url: string): boolean {
  return url.includes('/password') || url.includes('/postpassword');
}

function _isMicrosoftKMSIPage(url: string): boolean {
  return url.includes('/kmsi') || url.includes('/oauth2/authorize') && url.includes('prompt=none');
}

function _isMathUAppPage(url: string): boolean {
  return url.includes('app.mathu.co.za') || url.includes('mathu.co.za');
}

function _isAssignmentPage(url: string): boolean {
  return url.includes('assignment') || url.includes('mathletics.com/#') || url.includes('student');
}

// ─── Dominant color analysis ───────────────────────────────────────────────

interface ColorResult { r: number; g: number; b: number }

function _getDominantColor(rgba: Uint8ClampedArray, width: number, height: number): ColorResult {
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  const step = 10;
  for (let i = 0; i < width * height * 4; i += 4 * step) {
    rSum += rgba[i];
    gSum += rgba[i + 1];
    bSum += rgba[i + 2];
    count++;
  }
  return {
    r: Math.round(rSum / Math.max(count, 1)),
    g: Math.round(gSum / Math.max(count, 1)),
    b: Math.round(bSum / Math.max(count, 1))
  };
}

/** Sample a specific region's dominant color */
function _getRegionDominantColor(
  rgba: Uint8ClampedArray, width: number, height: number,
  x1Pct: number, y1Pct: number, x2Pct: number, y2Pct: number
): ColorResult {
  const sx = Math.floor(width * x1Pct);
  const sy = Math.floor(height * y1Pct);
  const ex = Math.floor(width * x2Pct);
  const ey = Math.floor(height * y2Pct);
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  const step = 5;
  for (let y = sy; y < ey; y += step) {
    for (let x = sx; x < ex; x += step) {
      const idx = (y * width + x) * 4;
      rSum += rgba[idx];
      gSum += rgba[idx + 1];
      bSum += rgba[idx + 2];
      count++;
    }
  }
  return {
    r: Math.round(rSum / Math.max(count, 1)),
    g: Math.round(gSum / Math.max(count, 1)),
    b: Math.round(bSum / Math.max(count, 1))
  };
}

function _isBlueishBackground(r: number, g: number, b: number): boolean {
  return b > r + 40 && b > g + 20 && b > 100;
}

function _isDeepBlueBackground(r: number, g: number, b: number): boolean {
  return _isDeepBlue(r, g, b) || (b > 140 && r < 50 && g < 90);
}

function _isMintPageBackground(r: number, g: number, b: number): boolean {
  return _isMintBackground(r, g, b);
}

/**
 * Classify page type by background color analysis.
 * Returns a string tag for routing.
 */
function _classifyPageByColor(
  rgba: Uint8ClampedArray, width: number, height: number
): 'microsoft_login' | 'mathu_app' | 'quiz' | 'score_screen' | 'exercise_info' | 'unknown' {
  // Check top region (header area) color
  const headerColor = _getRegionDominantColor(rgba, width, height, 0.0, 0.0, 1.0, 0.25);

  // Check overall background
  const overallColor = _getDominantColor(rgba, width, height);

  // Microsoft login: clean white/light gray background with blue accents
  if (_isWhiteish(headerColor.r, headerColor.g, headerColor.b) ||
      _isLightGray(headerColor.r, headerColor.g, headerColor.b)) {
    // Check if there's a Microsoft-blue element somewhere on the page
    const midColor = _getRegionDominantColor(rgba, width, height, 0.3, 0.35, 0.7, 0.45);
    if (_isMicrosoftBlue(midColor.r, midColor.g, midColor.b)) {
      return 'microsoft_login';
    }
  }

  // MathU app: deep blue header/sidebar
  if (_isDeepBlueBackground(headerColor.r, headerColor.g, headerColor.b)) {
    return 'mathu_app';
  }

  // Quiz page: pale mint/cyan background
  if (_isMintPageBackground(overallColor.r, overallColor.g, overallColor.b)) {
    return 'quiz';
  }

  // Score screen: mint background + white center area + teal full-width button at bottom
  // Check this BEFORE the generic mathu_app check since score screens are within the app
  if (_isScoreScreenByPixels(rgba, width, height)) {
    return 'score_screen';
  }

  // Also check if the top 25% has deep blue (app header)
  if (_isDeepBlueBackground(headerColor.r, headerColor.g, headerColor.b)) {
    return 'mathu_app';
  }

  // Exercise page: deep blue header + white card center + green Next button bottom-right
  if (_isExercisePageByPixels(rgba, width, height)) {
    return 'exercise_info';
  }

  return 'unknown';
}

// ─── Action generators ────────────────────────────────────────────────────

/**
 * Handle the Microsoft email input page.
 * Detects email input field, returns action to type email.
 */
function _microsoftEmailAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    log(`Pixel fallback: found email input at (${inputField.cx}, ${inputField.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'input_email',
      targetX: inputField.cx,
      targetY: inputField.cy,
      currentState: 'microsoft_email_input',
      reasoning: 'Pixel fallback: found email input field on Microsoft login'
    };
  }

  // No input field found — try to find Next button (might be already filled)
  const midY = Math.floor(height * 0.45);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    log(`Pixel fallback: found Next button at (${blueButton.cx}, ${blueButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: blueButton.cx,
      targetY: blueButton.cy,
      currentState: 'microsoft_email_input',
      reasoning: 'Pixel fallback: found blue Next button (email may be pre-filled)'
    };
  }

  return null;
}

/**
 * Handle the Microsoft password page.
 * This is the ADVLEARN page that appears after email submission.
 * Detects password input field, returns action to type password.
 */
function _microsoftPasswordAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    log(`Pixel fallback: found password input at (${inputField.cx}, ${inputField.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'input_password',
      targetX: inputField.cx,
      targetY: inputField.cy,
      currentState: 'advlearn_login',
      reasoning: 'Pixel fallback: found password input field on ADVLEARN page'
    };
  }

  // No input — look for Sign in button (password might be pre-filled)
  const midY = Math.floor(height * 0.45);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    log(`Pixel fallback: found Sign-in button at (${blueButton.cx}, ${blueButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: blueButton.cx,
      targetY: blueButton.cy,
      currentState: 'advlearn_login',
      reasoning: 'Pixel fallback: found blue Sign-in button (password may be pre-filled)'
    };
  }

  return null;
}

/**
 * Handle the "Stay signed in?" / KMSI page.
 * Looks for the "Yes" or "Stay signed in" button.
 */
function _microsoftKMSIAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // KMSI page: find the blue "Yes" button or the "Stay signed in" button
  // It's typically the only blue button on a white background page
  const midY = Math.floor(height * 0.35);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    log(`Pixel fallback: found KMSI Yes button at (${blueButton.cx}, ${blueButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: blueButton.cx,
      targetY: blueButton.cy,
      currentState: 'advlearn_login',
      reasoning: 'Pixel fallback: found "Stay signed in?" Yes button'
    };
  }

  // Fallback: try dark button (text link "Yes" or "No")
  const darkButton = _findDarkButton(rgba, width, height, midY);
  if (darkButton) {
    log(`Pixel fallback: found KMSI dark button at (${darkButton.cx}, ${darkButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: darkButton.cx,
      targetY: darkButton.cy,
      currentState: 'advlearn_login',
      reasoning: 'Pixel fallback: found dark KMSI button'
    };
  }

  return null;
}

/**
 * Handle a generic Microsoft login page (email or unknown sub-step).
 * Tries to detect the current step based on what elements are visible.
 */
function _microsoftLoginAction(
  url: string,
  rgba: Uint8ClampedArray,
  width: number, height: number
): any | null {
  const isPassword = _isMicrosoftPasswordPage(url);
  const isKMSI = _isMicrosoftKMSIPage(url);

  if (isKMSI) {
    return _microsoftKMSIAction(rgba, width, height);
  }

  if (isPassword) {
    return _microsoftPasswordAction(rgba, width, height);
  }

  // Email page or undetermined sub-step
  // First try to find an input field
  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    if (isPassword) {
      log(`Pixel fallback: found password input at (${inputField.cx}, ${inputField.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'input_password',
        targetX: inputField.cx,
        targetY: inputField.cy,
        currentState: 'advlearn_login',
        reasoning: 'Pixel fallback: found password input field'
      };
    } else {
      log(`Pixel fallback: found email input at (${inputField.cx}, ${inputField.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'input_email',
        targetX: inputField.cx,
        targetY: inputField.cy,
        currentState: 'microsoft_email_input',
        reasoning: 'Pixel fallback: found email input field'
      };
    }
  }

  // No input field found — try to find Next/Sign-in/Yes/Continue button
  const midY = Math.floor(height * 0.40);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    log(`Pixel fallback: found blue button at (${blueButton.cx}, ${blueButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: blueButton.cx,
      targetY: blueButton.cy,
      currentState: isPassword ? 'advlearn_login' : 'microsoft_email_input',
      reasoning: 'Pixel fallback: found blue sign-in/next button'
    };
  }

  // Try dark button (could be "Next" styled as dark text link)
  const darkButton = _findDarkButton(rgba, width, height, midY);
  if (darkButton) {
    log(`Pixel fallback: found dark button at (${darkButton.cx}, ${darkButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: darkButton.cx,
      targetY: darkButton.cy,
      currentState: 'microsoft_email_input',
      reasoning: 'Pixel fallback: found dark Next button'
    };
  }

  return null;
}

/**
 * Handle MathU app assignment pages.
 * Looks for colored Watch/Start/Redo buttons in the deep blue UI.
 */
function _assignmentPageAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // ── Priority 1: Check for download buttons on module cards ──
  // MathU modules require downloading before topics (Watch/Start) appear.
  // Download buttons are dark navy circles with white down-arrows.
  const downloadBtn = _findDownloadButton(rgba, width, height);
  if (downloadBtn) {
    log(`Pixel fallback: found download button at (${downloadBtn.cx}, ${downloadBtn.cy}) — clicking to download module`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: downloadBtn.cx,
      targetY: downloadBtn.cy,
      currentState: 'module_downloading',
      reasoning: 'Pixel fallback: found module download arrow button — clicking to initiate download'
    };
  }

  // ── Priority 2: Look for topic buttons (Watch/Start/Play/Redo) ──
  // These appear after a module has been downloaded and expanded.
  const button = _findActionButton(rgba, width, height);
  if (button) {
    log(`Pixel fallback: found action button at (${button.cx}, ${button.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: button.cx,
      targetY: button.cy,
      currentState: 'assignments_page',
      reasoning: 'Pixel fallback: found colored action button (Watch/Start/Redo)'
    };
  }

  // ── Priority 3: No button found — scroll down to find more content ──
  return {
    actionType: 'scroll_vertical',
    targetX: 0,
    targetY: 0,
    currentState: 'assignments_page',
    reasoning: 'Pixel fallback: no buttons visible on assignments page, scrolling'
  };
}

/**
 * Handle MathU quiz question pages.
 * Detects: multiple choice options, numeric keypad, Submit/Done button.
 */
function _quizPageAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // Priority 1: Check if a choice is already selected → look for Next question button
  // On multi-question assessments (e.g., 1/88 Chapter Test), after selecting an answer
  // the user needs to click "Next" to proceed to the next question
  const selectedChoice = _findSelectedChoice(rgba, width, height);
  if (selectedChoice) {
    const nextButton = _findNextQuestionButton(rgba, width, height);
    if (nextButton) {
      log(`Pixel fallback: choice selected, found Next button at (${nextButton.cx}, ${nextButton.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'click',
        targetX: nextButton.cx,
        targetY: nextButton.cy,
        currentState: 'assessment',
        reasoning: 'Pixel fallback: choice already selected, clicking Next question button'
      };
    }
    // Choice selected but no Next button — try the teal-green Submit/Done button instead
    const tealButton = _findTealGreenButton(rgba, width, height);
    if (tealButton) {
      log(`Pixel fallback: choice selected, clicking Submit/Done at (${tealButton.cx}, ${tealButton.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'click',
        targetX: tealButton.cx,
        targetY: tealButton.cy,
        currentState: 'assessment',
        reasoning: 'Pixel fallback: choice already selected, clicking Submit/Done button'
      };
    }
  }

  // Priority 2: Check for teal-green Submit/Done/Continue button at the bottom
  const tealButton = _findTealGreenButton(rgba, width, height);
  if (tealButton) {
    log(`Pixel fallback: found quiz Submit/Done button at (${tealButton.cx}, ${tealButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: tealButton.cx,
      targetY: tealButton.cy,
      currentState: 'assessment',
      reasoning: 'Pixel fallback: found teal-green Submit/Done button in quiz'
    };
  }

  // Priority 3: Check for choice buttons (multiple choice — click one)
  const choiceButtons = _findChoiceButtons(rgba, width, height);
  if (choiceButtons.length > 0) {
    // Try to extract text region info for the math verifier
    const textRegions = _extractTextRegions(rgba, width, height);
    const textInfo = textRegions
      ? ` | questionRegion density=${textRegions.questionRegion?.density.toFixed(2)}, ${textRegions.choiceRegions.length} choice text regions`
      : '';

    // Pick a random choice to avoid always picking the same wrong answer
    const pickIndex = Math.floor(Math.random() * choiceButtons.length);
    const pick = choiceButtons[pickIndex];
    log(`Pixel fallback: clicking choice button at (${pick.cx}, ${pick.cy}) (${choiceButtons.length} options)${textInfo}`, 'INFO', 'pixel-fallback');

    // Attach text regions with the clicked choice index for math verifier
    const textRegionsWithData = textRegions ? { ...textRegions, _clickedChoiceIndex: pickIndex } : null;

    return {
      actionType: 'click',
      targetX: pick.cx,
      targetY: pick.cy,
      currentState: 'assessment',
      reasoning: `Pixel fallback: clicking quiz choice button (${choiceButtons.length} options available)${textInfo}`,
      _textRegions: textRegionsWithData, // Attach for downstream consumers (math verifier)
    };
  }

  // Priority 4: Check for Next question button (might be a non-MCQ where answer was entered)
  const nextButton = _findNextQuestionButton(rgba, width, height);
  if (nextButton) {
    log(`Pixel fallback: found Next question button at (${nextButton.cx}, ${nextButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: nextButton.cx,
      targetY: nextButton.cy,
      currentState: 'assessment',
      reasoning: 'Pixel fallback: found Next question button (answer may be pre-filled)'
    };
  }

  // Priority 5: Check for input field (algebraic answer) + keypad area
  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    // There's an input field but no teal button visible yet — might need to enter answer
    // For now, just click the input field to focus it
    log(`Pixel fallback: found quiz input field at (${inputField.cx}, ${inputField.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: inputField.cx,
      targetY: inputField.cy,
      currentState: 'assessment',
      reasoning: 'Pixel fallback: found quiz answer input field'
    };
  }

  return null;
}

/**
 * Handle MathU video player page.
 * The bot must: (1) click on the video to open it, (2) watch for exactly
 * 2 minutes 59 seconds, (3) then click the back/X button to dismiss.
 *
 * Video watch timer is tracked in-memory across iterations.
 *
 * When the video is NOT yet opened (thumbnail/poster visible):
 *   - Click the center of the video to open it
 *   - Start the 2m59s watch timer
 *
 * When the video IS open AND watch time < 2m59s:
 *   - Return 'wait' — keep watching
 *
 * When the video IS open AND watch time >= 2m59s:
 *   - Find and click the back arrow / X button to dismiss
 *   - Reset the timer
 */
function _videoPlayerAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // ── Check if video player is OPEN (controls visible, back arrow in top-left) ──
  // Look for a dark/back button in the top-left quadrant of the content area
  // The video player back arrow is typically at roughly (5-15%, 10-25%) of the screen
  const backX1 = Math.floor(width * 0.02);
  const backX2 = Math.floor(width * 0.15);
  const backY1 = Math.floor(height * 0.10);
  const backY2 = Math.floor(height * 0.30);

  const darkBands = _findColorBands(rgba, width, height, _isDark, backY1, backY2, backX1, backX2, 2);
  const backButtons = darkBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 10 && r.w <= 60 && r.h >= 15 && r.h <= 60 && aspectRatio > 0.3 && aspectRatio < 3.0;
    })
    .sort((a, b) => a.cx - b.cx);

  // ── Also check for white arrow on dark background ──
  let whitePixelCount = 0;
  let totalPixels = 0;
  for (let y = backY1; y < backY2; y += 3) {
    for (let x = backX1; x < backX2; x += 3) {
      const idx = (y * width + x) * 4;
      totalPixels++;
      if (_isWhiteish(rgba[idx], rgba[idx + 1], rgba[idx + 2]) ||
          (rgba[idx] > 180 && rgba[idx + 1] > 180 && rgba[idx + 2] > 180)) {
        whitePixelCount++;
      }
    }
  }
  const hasWhiteArrow = totalPixels > 10 && whitePixelCount / totalPixels > 0.3;

  // Video player is OPEN if we found a back button OR a white arrow cluster
  const videoIsOpen = backButtons.length > 0 || hasWhiteArrow;

  if (videoIsOpen) {
    // Start the watch timer if not already started
    _startVideoTimer();

    const elapsed = _getVideoWatchElapsed();
    const remaining = Math.max(0, VIDEO_WATCH_DURATION_MS - elapsed);
    const remainingSec = Math.ceil(remaining / 1000);

    if (!_isVideoWatchComplete()) {
      // Still watching — return wait action
      log(`Pixel fallback: video watching... ${Math.floor(elapsed / 1000)}s elapsed, ${remainingSec}s remaining`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'wait',
        targetX: 0,
        targetY: 0,
        currentState: 'video_player',
        reasoning: `Pixel fallback: watching video (${Math.floor(elapsed / 1000)}s/${VIDEO_WATCH_DURATION_MS / 1000}s), ${remainingSec}s remaining before dismiss`
      };
    }

    // Watch time complete — dismiss the video
    _resetVideoTimer();

    if (backButtons.length > 0) {
      const btn = backButtons[0];
      log(`Pixel fallback: video watch complete (${VIDEO_WATCH_DURATION_MS / 1000}s), clicking back button at (${btn.cx}, ${btn.cy}) to dismiss`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'click',
        targetX: btn.cx,
        targetY: btn.cy,
        currentState: 'video_player',
        reasoning: `Pixel fallback: video watch complete (${VIDEO_WATCH_DURATION_MS / 1000}s), clicking back/close to dismiss`
      };
    }

    // Fallback: click the top-left area where the back arrow is
    const clickX = Math.floor((backX1 + backX2) / 2);
    const clickY = Math.floor((backY1 + backY2) / 2);
    log(`Pixel fallback: video watch complete, clicking back arrow area (${clickX}, ${clickY}) to dismiss`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: clickX,
      targetY: clickY,
      currentState: 'video_player',
      reasoning: `Pixel fallback: video watch complete (${VIDEO_WATCH_DURATION_MS / 1000}s), clicking back arrow area to dismiss`
    };
  }

  // ── Video is not yet open (showing thumbnail/poster) ──
  // Reset timer (in case of stale state) and click to open
  _resetVideoTimer();
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  log(`Pixel fallback: video thumbnail visible, clicking center (${centerX}, ${centerY}) to open video`, 'INFO', 'pixel-fallback');
  return {
    actionType: 'click',
    targetX: centerX,
    targetY: centerY,
    currentState: 'video_player',
    reasoning: 'Pixel fallback: video thumbnail/poster visible, clicking to open video player'
  };
}

/**
 * Handle MathU exercise pages (step-by-step content with Next/Previous).
 *
 * CRITICAL: The bot MUST click the open book icon in the top-right corner
 * of the white card BEFORE clicking Next. The app requires viewing the
 * memo before the Next button becomes active.
 *
 * The book icon is a small blue icon in the top-right area of the
 * white content card (roughly 75-95% from left, 5-20% from top).
 *
 * Workflow per question:
 *   1. Click the open book icon to flip to memo/solution
 *   2. After memo is visible, click the green "Next" button
 */
function _exercisePageAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // ── Priority 1: Find the open book icon in the top-right of the card ──
  // The book icon is a small blue element in the top-right corner of the
  // white content card. It appears at roughly 75-95% horizontal, 5-20% vertical.
  const bookX1 = Math.floor(width * 0.72);
  const bookX2 = Math.floor(width * 0.96);
  const bookY1 = Math.floor(height * 0.05);
  const bookY2 = Math.floor(height * 0.22);

  // Look for a small blue/dark-blue element (the book icon)
  // Book icons are typically small: 20-50px wide, 20-50px tall
  const bookBands = _findColorBands(rgba, width, height, _isDeepBlue, bookY1, bookY2, bookX1, bookX2, 2);
  const bookCandidates = bookBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 15 && r.w <= 60 && r.h >= 15 && r.h <= 60 && aspectRatio > 0.5 && aspectRatio < 2.5;
    })
    .sort((a, b) => a.cx - b.cx);

  // Also check for Microsoft-blue book icons (some themes use brighter blue)
  const bookBandsBright = _findColorBands(rgba, width, height, _isMicrosoftBlue, bookY1, bookY2, bookX1, bookX2, 2);
  const bookCandidatesBright = bookBandsBright
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 15 && r.w <= 60 && r.h >= 15 && r.h <= 60 && aspectRatio > 0.5 && aspectRatio < 2.5;
    })
    .sort((a, b) => a.cx - b.cx);

  const allBookCandidates = [...bookCandidates, ...bookCandidatesBright];

  if (allBookCandidates.length > 0) {
    // Pick the rightmost/topmost candidate (most likely the book icon)
    const book = allBookCandidates[allBookCandidates.length - 1];
    log(`Pixel fallback: found open book icon at (${book.cx}, ${book.cy}) — clicking to view memo`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: book.cx,
      targetY: book.cy,
      currentState: 'exercise_info',
      reasoning: 'Pixel fallback: found open book icon in top-right of exercise card — clicking to flip to memo/solution (REQUIRED before Next)'
    };
  }

  // ── Priority 2: Book icon not found — look for any small blue/dark element in top-right ──
  // Broader search: any colored element that could be the book icon
  const anyBands = _findColorBands(rgba, width, height, (r, g, b) =>
    _isDeepBlue(r, g, b) || _isMicrosoftBlue(r, g, b) || (r < 80 && g < 100 && b < 180),
    bookY1, bookY2, bookX1, bookX2, 2
  );
  const anyCandidates = anyBands
    .filter(r => r.w >= 10 && r.w <= 70 && r.h >= 10 && r.h <= 70)
    .sort((a, b) => a.cx - b.cx);

  if (anyCandidates.length > 0) {
    const candidate = anyCandidates[anyCandidates.length - 1];
    log(`Pixel fallback: found possible book icon candidate at (${candidate.cx}, ${candidate.cy}) — clicking to view memo`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: candidate.cx,
      targetY: candidate.cy,
      currentState: 'exercise_info',
      reasoning: 'Pixel fallback: found possible book/memo icon in exercise card — clicking (REQUIRED before Next)'
    };
  }

  // ── Priority 3: No book icon detected — click the general top-right area of the card ──
  // This is a safe fallback: the book icon is always in the top-right of the white card
  const fallbackBookX = Math.floor(width * 0.88);
  const fallbackBookY = Math.floor(height * 0.12);
  log(`Pixel fallback: no book icon detected, clicking top-right area (${fallbackBookX}, ${fallbackBookY}) as fallback for memo icon`, 'INFO', 'pixel-fallback');
  return {
    actionType: 'click',
    targetX: fallbackBookX,
    targetY: fallbackBookY,
    currentState: 'exercise_info',
    reasoning: 'Pixel fallback: clicking top-right of exercise card as fallback for open book/memo icon (REQUIRED before Next)'
  };
}

/**
 * Handle MathU score/results page.
 * Detects the "Continue to pathway" button.
 */
function _scorePageAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // Score screen has a full-width teal-green "Continue to pathway" button
  // Try full-width button first (more specific to score screens)
  const fullWidthButton = _findFullWidthButton(rgba, width, height);
  if (fullWidthButton) {
    log(`Pixel fallback: found full-width Continue button at (${fullWidthButton.cx}, ${fullWidthButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: fullWidthButton.cx,
      targetY: fullWidthButton.cy,
      currentState: 'score_screen',
      reasoning: 'Pixel fallback: found full-width Continue to pathway button on score screen'
    };
  }

  // Fallback: try the regular teal-green button (smaller score screens)
  const tealButton = _findTealGreenButton(rgba, width, height);
  if (tealButton) {
    log(`Pixel fallback: found Continue button at (${tealButton.cx}, ${tealButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: tealButton.cx,
      targetY: tealButton.cy,
      currentState: 'score_screen',
      reasoning: 'Pixel fallback: found Continue button on score screen'
    };
  }

  return null;
}

// ─── Video watch timer ─────────────────────────────────────────────────

/**
 * Track video watch time. The bot must watch videos for 2 minutes 59 seconds
 * (179,000 ms) before clicking the back/X button to dismiss.
 * This state is ephemeral (in-memory only) and resets on process restart.
 */
let _videoOpenedAt: number | null = null;
const VIDEO_WATCH_DURATION_MS = 179000; // 2 minutes 59 seconds

function _resetVideoTimer(): void {
  _videoOpenedAt = null;
}

function _getVideoWatchElapsed(): number {
  if (_videoOpenedAt === null) return 0;
  return Date.now() - _videoOpenedAt;
}

function _startVideoTimer(): void {
  if (_videoOpenedAt === null) {
    _videoOpenedAt = Date.now();
    log(`Video watch timer started — must watch for ${VIDEO_WATCH_DURATION_MS / 1000}s before dismiss`, 'INFO', 'pixel-fallback');
  }
}

function _isVideoWatchComplete(): boolean {
  return _videoOpenedAt !== null && _getVideoWatchElapsed() >= VIDEO_WATCH_DURATION_MS;
}

// ─── Login flow state machine ────────────────────────────────────────────

/**
 * Track the login flow state to avoid re-entering email when we should be
 * entering password, or clicking "Stay signed in" when we should be done.
 * This state is ephemeral (in-memory only) and resets on process restart.
 */
let _loginFlowState: 'unknown' | 'email_entered' | 'password_entered' | 'kmsi' = 'unknown';
let _lastLoginUrl: string = '';

function _resetLoginFlowIfNeeded(url: string): void {
  // If we navigated away from Microsoft and came back, reset the flow
  if (_lastLoginUrl && !_isMicrosoftLoginPage(url) && _isMicrosoftLoginPage(url)) {
    // Went from Microsoft to somewhere and back to Microsoft
  }
  if (!_isMicrosoftLoginPage(url)) {
    _loginFlowState = 'unknown';
    _lastLoginUrl = url;
    return;
  }
  // Detect step transitions by URL
  if (url.includes('/password')) {
    if (_loginFlowState === 'email_entered' || _loginFlowState === 'unknown') {
      _loginFlowState = 'email_entered'; // Email was submitted, now on password page
    }
  } else if (url.includes('/kmsi')) {
    _loginFlowState = 'password_entered';
  }
  _lastLoginUrl = url;
}

/**
 * After a successful action, advance the login flow state.
 */
function _advanceLoginFlow(action: any): void {
  if (action.actionType === 'input_email') {
    _loginFlowState = 'email_entered';
  } else if (action.actionType === 'input_password') {
    _loginFlowState = 'password_entered';
  } else if (action.actionType === 'click' && action.currentState === 'microsoft_email_input') {
    _loginFlowState = 'email_entered';
  } else if (action.actionType === 'click' && action.currentState === 'advlearn_login') {
    _loginFlowState = 'kmsi';
  }
}

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Generate a fallback action using pure pixel analysis.
 * Takes a screenshot internally for pixel analysis.
 * Returns null if no actionable element found.
 *
 * Called by providers-fallback.ts as Stage 0 when AI is unavailable.
 * Also called directly by cycle-manager during stagnation recovery.
 */
/**
 * Maps each pixel-fallback-detected currentState to the states in which
 * that action actually makes sense. If the bot's real currentState is NOT
 * in the allowed set, the action is rejected.
 *
 * This prevents pixel-fallback from suggesting login actions when on
 * assignments_page, or assignment actions when in microsoft_email_input, etc.
 */
const STATE_COMPAT: Record<string, string[]> = {
  // Login states — only valid when actually in login flow
  // NOTE: 'unknown' and 'error' are included here because when the bot doesn't know
  // where it is, trying a login action (click email field) is safer than trying
  // an assignment action (click Watch button that doesn't exist on login page).
  'microsoft_email_input': ['mathu_login', 'microsoft_email_input', 'unknown', 'error', 'anywhere_click_recovery'],
  'advlearn_login':         ['mathu_login', 'microsoft_email_input', 'advlearn_login', 'unknown', 'error', 'anywhere_click_recovery'],
  'microsoft_stay_signed_in': ['mathu_login', 'microsoft_email_input', 'advlearn_login', 'unknown', 'error', 'anywhere_click_recovery'],
  'signin_page':            ['mathu_login', 'microsoft_email_input', 'advlearn_login', 'unknown', 'error', 'anywhere_click_recovery'],
  // App states — ONLY valid when actually inside the MathU app (known state)
  // REMOVED 'unknown' and 'error': prevents assignment actions during login flow
  'assignments_page':      ['assignments_page', 'score_screen', 'pathway', 'pathway_feedback', 'assessment_correction', 'anywhere_click_recovery', 'ui_discovered', 'flutter_modal', 'flutter_bottom_sheet', 'exploration'],
  'module_downloading':     ['assignments_page', 'anywhere_click_recovery'],
  'exercise_info':         ['exercise_info', 'exercise_memo', 'anywhere_click_recovery'],
  'assessment':             ['assessment', 'assessment_correction', 'anywhere_click_recovery'],
  'video_player':           ['video_player', 'anywhere_click_recovery'],
  'score_screen':           ['score_screen', 'pathway', 'pathway_feedback', 'anywhere_click_recovery'],
};

/**
 * Check if an action returned by pixel analysis is compatible with the
 * bot's actual current state. Prevents nonsensical actions.
 */
function _isActionStateCompatible(action: any, realCurrentState: string): boolean {
  if (!action || !action.currentState) return true; // Can't filter without state info
  const compat = STATE_COMPAT[action.currentState];
  if (!compat) return true; // Unknown state — allow (better than blocking)
  return compat.includes(realCurrentState);
}

async function generatePixelFallbackAction(page: any, currentState?: string): Promise<any> {
  try {
    const url = page?.url?.() || '';

    // ── Login flow guard ──
    // If we're on a Microsoft login page, ALWAYS prefer login actions.
    // This prevents the bot from trying assignment actions on login pages.
    if (_isMicrosoftLoginPage(url) || url.includes('login') || url.includes('signin') || url.includes('auth')) {
      log('Pixel fallback: on login page — forcing login-only mode', 'DEBUG', 'pixel-fallback');
      // Take screenshot for login-specific analysis
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
      if (!screenshotBuffer || screenshotBuffer.length < 100) return null;
      const decoded = _decodePNG(screenshotBuffer);
      if (!decoded) return null;
      const { width, height, rgba } = decoded;
      _resetLoginFlowIfNeeded(url);
      const loginAction = _microsoftLoginAction(url, rgba, width, height);
      if (loginAction) {
        _advanceLoginFlow(loginAction);
        return loginAction;
      }
      return null; // Don't fall through to app actions on login pages
    }

    // ── Unknown state guard ──
    // If currentState is unknown/null AND we're not on a known MathU app URL,
    // don't try app-specific actions. Only allow login or generic button clicks.
    const isAppUrl = _isMathUAppPage(url);
    if (!currentState && !isAppUrl) {
      log('Pixel fallback: unknown state + non-app URL — skipping app actions', 'DEBUG', 'pixel-fallback');
      // Still try a generic button click (could be a login button)
      const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
      if (!screenshotBuffer || screenshotBuffer.length < 100) return null;
      const decoded = _decodePNG(screenshotBuffer);
      if (!decoded) return null;
      const button = _findActionButton(decoded.rgba, decoded.width, decoded.height);
      if (button) {
        return { actionType: 'click', targetX: button.cx, targetY: button.cy, currentState: 'unknown', reasoning: 'Pixel fallback: generic button (unknown state)' };
      }
      return null;
    }

    // Take a fresh screenshot for pixel analysis
    const screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false });
    if (!screenshotBuffer || screenshotBuffer.length < 100) {
      log('Pixel fallback: screenshot failed or empty', 'DEBUG', 'pixel-fallback');
      return null;
    }

    const decoded = _decodePNG(screenshotBuffer);
    if (!decoded) {
      log('Pixel fallback: PNG decode failed', 'DEBUG', 'pixel-fallback');
      return null;
    }

    const { width, height, rgba } = decoded;
    log(`Pixel fallback: analyzing ${width}x${height} image (${(screenshotBuffer.length / 1024).toFixed(0)} KB)` +
        (currentState ? ` [currentState=${currentState}]` : ''), 'DEBUG', 'pixel-fallback');

    // Generate candidate action (state-independent pixel analysis)
    const action = await _generatePixelAction(page, url, rgba, width, height);

    // State-awareness filter: reject actions that don't make sense for current state
    if (action && currentState) {
      if (!_isActionStateCompatible(action, currentState)) {
        log(`Pixel fallback: action ${action.actionType} (detected state=${action.currentState}) ` +
            `is NOT compatible with actual currentState=${currentState} — rejected`, 'WARN', 'pixel-fallback');
        return null;
      }
    }

    return action;
  } catch (e: any) {
    log(`Pixel fallback error: ${e.message}`, 'DEBUG', 'pixel-fallback');
    return null;
  }
}

/** Inner action generation — pure pixel analysis, no state filtering */
async function _generatePixelAction(page: any, url: string, rgba: Uint8ClampedArray, width: number, height: number): Promise<any> {

    // ── Microsoft login pages (URL-based — highest priority) ──
    if (_isMicrosoftLoginPage(url)) {
      _resetLoginFlowIfNeeded(url);
      const action = _microsoftLoginAction(url, rgba, width, height);
      if (action) {
        _advanceLoginFlow(action);
        return action;
      }
    }

    // ── Detect login by color analysis (for redirect chains where URL hasn't updated) ──
    const colorClass = _classifyPageByColor(rgba, width, height);
    if (colorClass === 'microsoft_login') {
      log('Pixel fallback: blue background detected, treating as login page', 'DEBUG', 'pixel-fallback');
      _resetLoginFlowIfNeeded(url);
      const action = _microsoftLoginAction(url, rgba, width, height);
      if (action) {
        _advanceLoginFlow(action);
        return action;
      }
    }

    // ── MathU app pages ──
    if (_isMathUAppPage(url) || colorClass === 'mathu_app' || colorClass === 'score_screen' || colorClass === 'exercise_info') {
      // Detect sub-page by visual features

      // Score screen: full-width button + white text area
      if (colorClass === 'score_screen' || _isScoreScreenByPixels(rgba, width, height)) {
        const scoreAction = _scorePageAction(rgba, width, height);
        if (scoreAction) return scoreAction;
      }

      // Quiz: mint background + teal buttons
      if (colorClass === 'quiz' || _isQuizPageByPixels(rgba, width, height)) {
        const quizAction = _quizPageAction(rgba, width, height);
        if (quizAction) return quizAction;
      }

      // Video player: dark content area OR white thumbnail with no green Next button
      if (_isVideoPlayerByPixels(rgba, width, height)) {
        const videoAction = _videoPlayerAction(rgba, width, height);
        if (videoAction) return videoAction;
      }

      // Exercise page: white card + green Next button + deep blue header
      if (colorClass === 'exercise_info' || _isExercisePageByPixels(rgba, width, height)) {
        const exerciseAction = _exercisePageAction(rgba, width, height);
        if (exerciseAction) return exerciseAction;
      }

      // Default: treat as assignments page (includes download button detection)
      return _assignmentPageAction(rgba, width, height);
    }

    // ── Assignment URL pattern ──
    if (_isAssignmentPage(url)) {
      return _assignmentPageAction(rgba, width, height);
    }

    // ── Generic: find any clickable button ──
    const button = _findActionButton(rgba, width, height);
    if (button) {
      log(`Pixel fallback: found generic button at (${button.cx}, ${button.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'click',
        targetX: button.cx,
        targetY: button.cy,
        currentState: 'unknown',
        reasoning: 'Pixel fallback: found generic clickable button'
      };
    }

    log('Pixel fallback: no actionable elements found', 'DEBUG', 'pixel-fallback');
    return null;
}

// ─── Visual page classifiers (pixel-only, no URL) ─────────────────────────

/**
 * Detect quiz page by visual features:
 * - Mint/cyan background
 * - White card in center
 * - Teal-green button at bottom
 */
function _isQuizPageByPixels(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  const overallColor = _getDominantColor(rgba, width, height);
  if (!_isMintPageBackground(overallColor.r, overallColor.g, overallColor.b)) return false;

  // Check for the white card area in center
  const centerColor = _getRegionDominantColor(rgba, width, height, 0.25, 0.35, 0.75, 0.65);
  if (!_isWhiteish(centerColor.r, centerColor.g, centerColor.b)) return false;

  return true;
}

/**
 * Detect exercise page by visual features:
 * - Deep blue header (MathU app header with "Exercise" title)
 * - Large white card in the center (question content)
 * - Green Next button at the bottom-right
 * - Typically shows "X/Y" progress indicator and Previous/Next buttons
 */
function _isExercisePageByPixels(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  // Check for deep blue header (MathU app)
  const headerColor = _getRegionDominantColor(rgba, width, height, 0.0, 0.0, 1.0, 0.12);
  if (!_isDeepBlueBackground(headerColor.r, headerColor.g, headerColor.b)) return false;

  // Check for large white card in center
  const centerColor = _getRegionDominantColor(rgba, width, height, 0.15, 0.15, 0.85, 0.85);
  if (!_isWhiteish(centerColor.r, centerColor.g, centerColor.b)) return false;

  // Check for green Next button at bottom-right (characteristic of exercise pages)
  const greenButton = _findGreenButton(rgba, width, height);
  if (!greenButton) return false;

  return true;
}

/**
 * Detect video player page by visual features:
 * - Large dark/gray rectangular area (video frame) occupying most of the content
 * - Either a play button overlay (video not yet opened) or playback controls at bottom
 */
function _isVideoPlayerByPixels(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  // Check for deep blue header (MathU app)
  const headerColor = _getRegionDominantColor(rgba, width, height, 0.0, 0.0, 1.0, 0.12);
  const hasAppHeader = _isDeepBlueBackground(headerColor.r, headerColor.g, headerColor.b);

  // Check the content area (below header) — video content is typically dark/gray
  const contentColor = _getRegionDominantColor(rgba, width, height, 0.15, 0.15, 0.85, 0.80);

  // Video thumbnails/posters are typically darker than white but not pure black
  const isDarkish = contentColor.r < 160 && contentColor.g < 160 && contentColor.b < 160;

  // Also check for a large dark rectangle (video frame)
  // This distinguishes video pages from exercise pages (which have white cards)
  const isWhiteContent = _isWhiteish(contentColor.r, contentColor.g, contentColor.b);

  // If we have the app header and the content is NOT white (not exercise/quiz)
  // and NOT mint (not quiz), it's likely a video page
  if (hasAppHeader && !isWhiteContent && isDarkish) return true;

  // Video with white thumbnail text (like "CONVERTING BETWEEN CUBIC UNITS")
  // Check for a mostly white/light center with dark text
  if (hasAppHeader && _isWhiteish(contentColor.r, contentColor.g, contentColor.b)) {
    // Could be exercise OR video thumbnail with white background
    // Distinguish by checking bottom area: video has controls, exercise has green Next
    const greenButton = _findGreenButton(rgba, width, height);
    if (!greenButton) {
      // No green Next button at bottom-right → likely video, not exercise
      return true;
    }
  }

  return false;
}

/**
 * Detect score screen by visual features:
 * - Large white area with text (score percentage)
 * - Teal-green full-width button at bottom
 * - Often on mint background
 */
function _isScoreScreenByPixels(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  // Check for the teal-green button at the bottom (full-width)
  const tealButton = _findTealGreenButton(rgba, width, height);
  if (!tealButton) return false;

  // Full-width button is characteristic of score screen
  if (tealButton.w < width * 0.6) return false;

  // Check for large white text area (score display) in the upper half
  const upperColor = _getRegionDominantColor(rgba, width, height, 0.2, 0.15, 0.8, 0.35);
  if (!_isWhiteish(upperColor.r, upperColor.g, upperColor.b)) return false;

  return true;
}

// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  generatePixelFallbackAction,
  // Exported for testing
  _decodePNG,
  _findInputField,
  _findAllInputFields,
  _findBlueButton,
  _findTealGreenButton,
  _findGreenButton,
  _findActionButton,
  _findChoiceButtons,
  _findDownloadButton,
  _isModuleContentLoaded,
  _classifyPageByColor,
  _isMicrosoftLoginPage,
  _isMicrosoftPasswordPage,
  _isMicrosoftKMSIPage,
  _isMathUAppPage,
  _isQuizPageByPixels,
  _isScoreScreenByPixels,
  _isExercisePageByPixels,
  _isVideoPlayerByPixels,
  _videoPlayerAction,
  _exercisePageAction,
  // Response 5 additions
  _findSelectedChoice,
  _isSelectedChoice,
  _findFullWidthButton,
  _findNextQuestionButton,
  _extractTextRegions,
  _getTextDensityInRegion,
};
