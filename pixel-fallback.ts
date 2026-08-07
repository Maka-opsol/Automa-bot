'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// pixel-fallback.ts — Pure pixel-based page analysis & action generation
// ═══════════════════════════════════════════════════════════════════════════
// When ALL AI providers fail AND DOM is empty (Flutter canvas) AND semantics
// return nothing, this module falls back to raw screenshot pixel analysis.
//
// How it works:
//   1. Takes a PNG screenshot → decodes to raw RGBA pixels (built-in zlib)
//   2. Scans pixels for color patterns (white rects = inputs, blue rects = buttons)
//   3. Uses URL context + pixel analysis to determine page type
//   4. Returns a concrete action with coordinates for the executor
//
// Capabilities:
//   - Microsoft login: finds email/password input fields, Next/Sign-in buttons
//   - Assignment pages: finds colored Watch/Start buttons
//   - Generic: finds any prominent clickable-looking rectangle
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
    // Validate PNG signature
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
      if (chunkLen > buffer.length) break; // Malformed chunk
    }

    if (width === 0 || height === 0 || width > 4096 || height > 4096) return null;
    // Only support RGBA 8-bit (colorType 6) and RGB 8-bit (colorType 2)
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
          const srcC = c < channels ? c : channels - 1; // Map alpha=3 for RGB
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
        // For RGB (no alpha channel), set alpha to 255
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

function _isMicrosoftBlue(r: number, g: number, b: number): boolean {
  // Microsoft brand blue: roughly #0078D4 → R:0 G:120 B:212 (with tolerance)
  return r < 60 && g > 80 && g < 180 && b > 160 && b < 240;
}

function _isGreenish(r: number, g: number, b: number): boolean {
  return g > 140 && r < g - 40 && b < g - 20;
}

function _isOrangeish(r: number, g: number, b: number): boolean {
  return r > 200 && g > 100 && g < 180 && b < 100;
}

function _isDark(r: number, g: number, b: number): boolean {
  return r < 60 && g < 60 && b < 60;
}

// ─── Rectangle detection ───────────────────────────────────────────────────

interface DetectedRect {
  x: number; y: number; w: number; h: number;
  cx: number; cy: number;
}

/**
 * Find horizontal bands of pixels matching a color predicate.
 * Returns bounding boxes of rectangular regions.
 * @param step Sample every Nth pixel for speed (default 2)
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

  // Group adjacent rows with overlapping column ranges into rectangles
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
      // Emit rectangle from groupStart to i-1
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
 * Find an input field (white rectangle with aspect ratio > 4:1).
 * Scans the center 60% of the image vertically, 20%-80% horizontally.
 */
function _findInputField(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const y1 = Math.floor(height * 0.25);
  const y2 = Math.floor(height * 0.75);
  const x1 = Math.floor(width * 0.15);
  const x2 = Math.floor(width * 0.85);

  // Find white bands (input fields are white)
  const whiteBands = _findColorBands(rgba, width, height, _isWhiteish, y1, y2, x1, x2, 2);

  // Also find light gray bands (some inputs have subtle borders)
  const grayBands = _findColorBands(rgba, width, height, _isLightGray, y1, y2, x1, x2, 2);

  // Merge and deduplicate nearby rects
  const allRects = [...whiteBands, ...grayBands];

  // Filter for input-like aspect ratios (wide and short)
  const inputCandidates = allRects
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return aspectRatio > 3.5 && aspectRatio < 25 && r.w >= 100 && r.w <= 700 && r.h >= 15 && r.h <= 80;
    })
    // Sort by y position (top first)
    .sort((a, b) => a.cy - b.cy);

  if (inputCandidates.length === 0) return null;

  // Return the topmost input-like rectangle
  return inputCandidates[0];
}

/**
 * Find a blue button (Microsoft "Next" / "Sign in" button).
 * Looks for Microsoft-blue rectangles below a given Y coordinate.
 */
function _findBlueButton(
  rgba: Uint8ClampedArray, width: number, height: number,
  belowY: number
): DetectedRect | null {
  const y1 = belowY;
  const y2 = Math.min(Math.floor(belowY + height * 0.4), height - 10);
  const x1 = Math.floor(width * 0.2);
  const x2 = Math.floor(width * 0.8);

  const blueBands = _findColorBands(rgba, width, height, _isMicrosoftBlue, y1, y2, x1, x2, 2);

  // Filter for button-like sizes
  const buttons = blueBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 80 && r.w <= 500 && r.h >= 20 && r.h <= 80 && aspectRatio > 2 && aspectRatio < 20;
    })
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

/**
 * Find a prominent colored button (green, orange, or blue) on any page.
 * Used for Watch/Start/Play buttons on assignment pages.
 */
function _findActionButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const y1 = Math.floor(height * 0.15);
  const y2 = Math.floor(height * 0.85);
  const x1 = Math.floor(width * 0.1);
  const x2 = Math.floor(width * 0.9);

  const isButtonColor = (r: number, g: number, b: number) =>
    _isGreenish(r, g, b) || _isOrangeish(r, g, b) || _isMicrosoftBlue(r, g, b);

  const coloredBands = _findColorBands(rgba, width, height, isButtonColor, y1, y2, x1, x2, 3);

  // Filter for button-like sizes
  const buttons = coloredBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 60 && r.w <= 400 && r.h >= 20 && r.h <= 80 && aspectRatio > 1.5 && aspectRatio < 15;
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

  // We don't want the whole background — just small dark rectangles (buttons, text links)
  const buttons = darkBands
    .filter(r => r.w >= 40 && r.w <= 300 && r.h >= 10 && r.h <= 50)
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

// ─── Page type detection (URL-based) ──────────────────────────────────────

function _isMicrosoftLoginPage(url: string): boolean {
  return url.includes('login.microsoftonline.com') ||
         url.includes('login.live.com') ||
         url.includes('login.microsoft.com');
}

function _isPasswordPage(url: string): boolean {
  return url.includes('/password') || url.includes('/kmsi') || url.includes('/postpassword');
}

function _isAssignmentPage(url: string): boolean {
  return url.includes('assignment') || url.includes('mathletics.com/#') || url.includes('student');
}

// ─── Dominant color analysis ───────────────────────────────────────────────

function _getDominantColor(rgba: Uint8ClampedArray, width: number, height: number): { r: number; g: number; b: number } {
  let rSum = 0, gSum = 0, bSum = 0, count = 0;
  const step = 10; // Sample every 10th pixel for speed
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

function _isBlueishBackground(r: number, g: number, b: number): boolean {
  return b > r + 40 && b > g + 20 && b > 100;
}

// ─── Action generators ────────────────────────────────────────────────────

function _microsoftLoginAction(
  url: string,
  rgba: Uint8ClampedArray,
  width: number, height: number
): any | null {
  const isPassword = _isPasswordPage(url);

  // Step 1: Find the input field
  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    if (isPassword) {
      log(`Pixel fallback: found password input at (${inputField.cx}, ${inputField.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'input_password',
        targetX: inputField.cx,
        targetY: inputField.cy,
        currentState: 'microsoft_password_input',
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

  // Step 2: No input field found — try to find Next/Sign-in button
  // (might be on a "Stay signed in?" page or confirmation page)
  const midY = Math.floor(height * 0.45);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    log(`Pixel fallback: found blue button at (${blueButton.cx}, ${blueButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: blueButton.cx,
      targetY: blueButton.cy,
      currentState: 'microsoft_signin',
      reasoning: 'Pixel fallback: found blue sign-in button'
    };
  }

  // Step 3: Try dark button (could be "Next" styled as dark text)
  const darkButton = _findDarkButton(rgba, width, height, midY);
  if (darkButton) {
    log(`Pixel fallback: found dark button at (${darkButton.cx}, ${darkButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: darkButton.cx,
      targetY: darkButton.cy,
      currentState: 'microsoft_next',
      reasoning: 'Pixel fallback: found dark Next button'
    };
  }

  return null;
}

function _assignmentPageAction(
  rgba: Uint8ClampedArray,
  width: number, height: number
): any | null {
  // Look for colored buttons (Watch/Start/Play)
  const button = _findActionButton(rgba, width, height);
  if (button) {
    log(`Pixel fallback: found action button at (${button.cx}, ${button.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: button.cx,
      targetY: button.cy,
      currentState: 'assignments_page',
      reasoning: 'Pixel fallback: found colored action button'
    };
  }

  // No button found — try scrolling down to find more content
  return {
    actionType: 'scroll_vertical',
    targetX: 0,
    targetY: 0,
    currentState: 'assignments_page',
    reasoning: 'Pixel fallback: no buttons visible, scrolling'
  };
}

/**
 * Detect if the page appears to be a login page by dominant blue color.
 * Used when URL detection fails (e.g., redirect chains).
 */
function _detectLoginPageByColor(
  rgba: Uint8ClampedArray, width: number, height: number
): boolean {
  const dominant = _getDominantColor(rgba, width, height);
  return _isBlueishBackground(dominant.r, dominant.g, dominant.b);
}

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Generate a fallback action using pure pixel analysis.
 * Takes its own screenshot if needed (only called when AI fails, so overhead is acceptable).
 * Returns null if no actionable element found.
 */
async function generatePixelFallbackAction(page: any): Promise<any> {
  try {
    const url = page?.url?.() || '';

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
    log(`Pixel fallback: analyzing ${width}x${height} image (${(screenshotBuffer.length / 1024).toFixed(0)} KB)`, 'DEBUG', 'pixel-fallback');

    // ── Microsoft login pages ──
    if (_isMicrosoftLoginPage(url)) {
      const action = _microsoftLoginAction(url, rgba, width, height);
      if (action) return action;
    }

    // ── Detect login by color (for redirect chains where URL hasn't updated yet) ──
    if (_detectLoginPageByColor(rgba, width, height)) {
      log('Pixel fallback: blue background detected, treating as login page', 'DEBUG', 'pixel-fallback');
      const action = _microsoftLoginAction(url, rgba, width, height);
      if (action) return action;
    }

    // ── Assignment / app pages ──
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
  } catch (e: any) {
    log(`Pixel fallback error: ${e.message}`, 'DEBUG', 'pixel-fallback');
    return null;
  }
}

module.exports = { generatePixelFallbackAction };
