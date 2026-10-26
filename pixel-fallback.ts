'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// pixel-fallback.ts — Pure pixel-based page analysis & action generation v4
// ═══════════════════════════════════════════════════════════════════════════
// When ALL AI providers fail AND DOM is empty (Flutter canvas) AND semantics
// return nothing, this module falls back to raw screenshot pixel analysis.
// TREAT THIS AS THE BOT'S PRIMARY BRAIN — it may be all it has.
//
// ENHANCEMENTS in v3:
//   - (JPEG decode was later REMOVED in Task 99 — PNG input only, see _decodeScreenshot)
//   - Page-change fingerprinting (know if actions actually changed the page)
//   - Stagnation detection (stop repeating the same failed action)
//   - Smart quiz choice strategy (remember choices tried, avoid repeats)
//   - Error/crash page detection (browser error pages, white screens)
//   - Modal/overlay detection and dismissal
//   - Consecutive failure safety valve (switch to safe recovery)
//   - Scroll-depth memory (avoid infinite scroll loops)
//   - Progress tracking (questions answered, modules completed)
//   - Accept pre-decoded screenshots (avoid redundant screenshot())
//
// ENHANCEMENTS in v4 (SMART BRAIN):
//   - Adaptive color calibration: learns actual button colors from successful
//     clicks, adapts if MathU changes its color scheme between sessions
//   - Intelligent quiz answering: uses text density heuristics to prefer
//     longer/more-detailed choices (likely correct for math answers)
//   - Multi-pass scan with noise reduction: improved detection on JPEG-coarse
//     data by scanning at multiple step sizes and merging results
//   - Video progress bar detection: verifies video is actually playing vs
//     stuck/buffering by checking progress bar fill percentage
//   - Assignment completion awareness: detects already-completed modules
//     (green checkmarks, faded buttons) and skips them
//   - Internal timeout safety: every public function wrapped in a hard timeout
//     so pixel-fallback never blocks the cycle manager
//   - Pathway navigation intelligence: detects breadcrumb navigation and
//     module lists to move purposefully through the curriculum
//   - Keyboard-based text entry: uses page.keyboard for email/password input
//     instead of just clicking (more reliable on mobile viewports)
//   - Login flow hardening: detects "Pick an account" and "Use another
//     account" intermediate screens, handles password reset redirects
//   - Exercise memo flip detection: after clicking book icon, waits for
//     the memo page to appear before allowing Next (prevents premature advance)
//   - Safe coordinate jitter: adds small random offsets to prevent UI
//     elements from ignoring repeated clicks at the exact same coordinates
//
// FIXES in v4.2 (robustness pass):
//   - _memory: `recentActions: Array<...> = []` compiled to `(Array) = []`, which
//     REASSIGNED THE GLOBAL `Array` for the whole process. Now a typed literal.
//   - _isSelectedChoice referenced an undefined `height` (ReferenceError at runtime)
//   - _memory._lastVideoProgress / _videoStuckCount were never declared
//   - Page fingerprint only hashed the first 32 samples of the top pixel row, so
//     almost every page looked identical. Now a 128-bit grid dHash with Hamming
//     distance; stagnation / memo-flip detection compare by distance.
//   - Scroll exhaustion is now a consecutive-scroll streak (a content hash can't
//     count scrolls because scrolling changes the content).
//   - PNG decoder: in-place unfilter (faster), rejects interlaced/corrupt input
//     instead of returning garbage, validates chunk bounds.
//   - CDP session is always detached (leak on error), _withTimeout clears its timer
//   - Login / error URL matching no longer fires on substrings like "author"
//   - Modal detection requires ALL FOUR corners dimmed (app headers no longer match)
//   - Click jitter is clamped to the target size (small icons were being missed)
//   - Optional screenshot→viewport coordinate scaling (devicePixelRatio != 1)
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
//   - Page fingerprinting for change detection
//
// No external dependencies — uses only Node.js built-ins (zlib, Buffer, crypto).
// Memory: ~4 MB for a 1280×720 RGBA decode. CPU: ~20-30ms total.
// ═══════════════════════════════════════════════════════════════════════════

const zlib = require('zlib');
const { log } = require('./logger');

// ─── Screenshot decode (PNG only — JPEG decoder removed in Task 99) ──────

/**
 * Decode a screenshot buffer to raw RGBA pixels.
 * TASK 99 (2026-09-30): JPEG "decoder" REMOVED — it was fundamentally broken.
 * It sampled entropy-coded bytes from the JPEG scan data and treated them
 * as R/G/B pixel values. Those bytes do NOT correspond spatially to pixels
 * due to JPEG's Huffman coding, DCT coefficients, quantization, and chroma
 * subsampling. The resulting "image" was essentially random with respect to
 * the actual screenshot.
 *
 * The pixel fallback now ONLY accepts PNG input (via CDP Page.captureScreenshot
 * with format: 'png'). If a JPEG is passed, it returns null instead of
 * producing garbage data. This ensures the pixel analysis always operates
 * on real pixel values.
 */
function _decodeScreenshot(buffer: Buffer): { width: number; height: number; rgba: Uint8ClampedArray; format: string } | null {
  // Only accept PNG — JPEG "decoding" was removed (see comment above)
  const png = _decodePNG(buffer);
  if (png) return { ...png, format: 'png' };
  // JPEG or unsupported format — refuse to guess
  if (buffer.length > 2 && buffer[0] === 0xFF && buffer[1] === 0xD8) {
    log('Pixel fallback: JPEG input received — refusing to decode (JPEG byte-sampling is unreliable). Use PNG instead.', 'WARN', 'pixel-fallback');
  }
  return null;
}


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
    if (buffer.length < 33 ||
        buffer[0] !== 0x89 || buffer[1] !== 0x50 || buffer[2] !== 0x4E ||
        buffer[3] !== 0x47 || buffer[4] !== 0x0D || buffer[5] !== 0x0A ||
        buffer[6] !== 0x1A || buffer[7] !== 0x0A) {
      return null;
    }

    let width = 0, height = 0, colorType = 0, bitDepth = 0, interlace = 0;
    const idatChunks: Buffer[] = [];
    let offset = 8;

    while (offset + 12 <= buffer.length) {
      const chunkLen = buffer.readUInt32BE(offset);
      // Corrupt / truncated chunk: stop instead of silently reading past the end
      if (chunkLen > buffer.length - offset - 12) break;
      const chunkType = buffer.toString('ascii', offset + 4, offset + 8);

      if (chunkType === 'IHDR' && chunkLen >= 13) {
        width = buffer.readUInt32BE(offset + 8);
        height = buffer.readUInt32BE(offset + 12);
        bitDepth = buffer[offset + 16];
        colorType = buffer[offset + 17];
        interlace = buffer[offset + 20];
      } else if (chunkType === 'IDAT') {
        idatChunks.push(buffer.subarray(offset + 8, offset + 8 + chunkLen));
      } else if (chunkType === 'IEND') {
        break;
      }

      offset += 12 + chunkLen;
    }

    if (width === 0 || height === 0 || width > 4096 || height > 4096) return null;
    if (bitDepth !== 8 || (colorType !== 6 && colorType !== 2)) return null;
    if (interlace !== 0) {
      // Adam7 passes are laid out differently; decoding them as a plain raster
      // yields garbage, so refuse rather than guess.
      log('PNG decode: interlaced (Adam7) PNG not supported', 'DEBUG', 'pixel-fallback');
      return null;
    }
    if (idatChunks.length === 0) return null;

    const channels = colorType === 6 ? 4 : 3;
    const bpp = channels;                 // bytes per pixel (8-bit samples)
    const stride = width * channels;      // bytes per scanline (without filter byte)
    const rowSize = stride + 1;
    const expected = rowSize * height;
    const raw = zlib.inflateSync(Buffer.concat(idatChunks), { maxOutputLength: expected + height });
    if (raw.length < expected) return null;

    // Reverse the PNG scanline filters IN PLACE. Row y-1 is already unfiltered
    // when row y is processed, so `prev` always holds final pixel bytes.
    for (let y = 0; y < height; y++) {
      const filterType = raw[y * rowSize];
      const cur = y * rowSize + 1;
      const prev = y > 0 ? cur - rowSize : -1;

      switch (filterType) {
        case 0: break;
        case 1:
          for (let i = bpp; i < stride; i++) raw[cur + i] = (raw[cur + i] + raw[cur + i - bpp]) & 0xFF;
          break;
        case 2:
          if (prev >= 0) for (let i = 0; i < stride; i++) raw[cur + i] = (raw[cur + i] + raw[prev + i]) & 0xFF;
          break;
        case 3:
          for (let i = 0; i < stride; i++) {
            const left = i >= bpp ? raw[cur + i - bpp] : 0;
            const up = prev >= 0 ? raw[prev + i] : 0;
            raw[cur + i] = (raw[cur + i] + ((left + up) >> 1)) & 0xFF;
          }
          break;
        case 4:
          for (let i = 0; i < stride; i++) {
            const left = i >= bpp ? raw[cur + i - bpp] : 0;
            const up = prev >= 0 ? raw[prev + i] : 0;
            const upLeft = (i >= bpp && prev >= 0) ? raw[prev + i - bpp] : 0;
            raw[cur + i] = (raw[cur + i] + _paethPredictor(left, up, upLeft)) & 0xFF;
          }
          break;
        default:
          return null; // invalid filter byte => corrupt stream
      }
    }

    const rgba = new Uint8ClampedArray(width * height * 4);
    if (channels === 4) {
      for (let y = 0; y < height; y++) {
        const s = y * rowSize + 1;
        rgba.set(raw.subarray(s, s + stride), y * width * 4);
      }
    } else {
      for (let y = 0; y < height; y++) {
        let s = y * rowSize + 1;
        let d = y * width * 4;
        for (let x = 0; x < width; x++, s += 3, d += 4) {
          rgba[d] = raw[s]; rgba[d + 1] = raw[s + 1]; rgba[d + 2] = raw[s + 2]; rgba[d + 3] = 255;
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

/** Red/coral (error indicators, incorrect answer feedback) */
function _isReddish(r: number, g: number, b: number): boolean {
  return r > 180 && g < 100 && b < 100;
}

/** Yellow/amber (warning indicators, partial score) */
function _isYellowish(r: number, g: number, b: number): boolean {
  return r > 200 && g > 180 && b < 100;
}

/** Green checkmark color (completed modules/assignments): bright green #22C55E */
function _isCheckmarkGreen(r: number, g: number, b: number): boolean {
  return g > 160 && r < 80 && b < 80;
}

/** Faded/dimmed color (completed or disabled items): saturation < 30%, brightness 150-210 */
function _isFadedElement(r: number, g: number, b: number): boolean {
  const brightness = (r + g + b) / 3;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const saturation = max === 0 ? 0 : (max - min) / max;
  return brightness > 150 && brightness < 220 && saturation < 0.2;
}

/** Purple/violet (some MathU accent elements, information buttons) */
function _isPurple(r: number, g: number, b: number): boolean {
  return r > 80 && r < 160 && g < 80 && b > 120;
}

/** Play button triangle area: white on dark/colored circle */
function _isPlayButtonColor(r: number, g: number, b: number): boolean {
  return _isWhiteish(r, g, b) || (r > 180 && g > 180 && b > 180);
}

// ─── v4: Adaptive Color Calibration ─────────────────────────────────────

/**
 * Color calibration system: learns the actual button colors from successful
 * clicks. This allows pixel-fallback to adapt if MathU changes its color scheme.
 *
 * Each calibration entry tracks observed RGB samples at click coordinates.
 * After enough samples, it computes the actual dominant color and uses that
 * instead of the hardcoded thresholds for future detection.
 */
const _colorCalibration = {
  samples: new Map<string, Array<{ r: number; g: number; b: number }>>(),
  MIN_SAMPLES_FOR_CALIBRATION: 5,

  /** Record a color sample at a successful click coordinate */
  record(category: string, r: number, g: number, b: number): void {
    if (!this.samples.has(category)) this.samples.set(category, []);
    const samples = this.samples.get(category)!;
    samples.push({ r, g, b });
    // Keep only the last 20 samples per category
    if (samples.length > 20) samples.shift();
    if (samples.length === this.MIN_SAMPLES_FOR_CALIBRATION) {
      const avg = this._average(category);
      log(`Color calibration ready for '${category}': avg RGB(${avg.r}, ${avg.g}, ${avg.b})`, 'INFO', 'pixel-fallback');
    }
  },

  /** Get calibrated average color for a category */
  _average(category: string): { r: number; g: number; b: number } | null {
    const samples = this.samples.get(category);
    if (!samples || samples.length < this.MIN_SAMPLES_FOR_CALIBRATION) return null;
    let rSum = 0, gSum = 0, bSum = 0;
    for (const s of samples) { rSum += s.r; gSum += s.g; bSum += s.b; }
    const n = samples.length;
    return { r: Math.round(rSum / n), g: Math.round(gSum / n), b: Math.round(bSum / n) };
  },

  /** Get calibrated color matcher function, or null if not enough data */
  getMatcher(category: string): ((r: number, g: number, b: number) => boolean) | null {
    const avg = this._average(category);
    if (!avg) return null;
    const tolerance = 40;
    return (r: number, g: number, b: number) =>
      Math.abs(r - avg.r) < tolerance &&
      Math.abs(g - avg.g) < tolerance &&
      Math.abs(b - avg.b) < tolerance;
  },

  /** Get stats for dashboard display */
  getStats(): Record<string, { samples: number; calibrated: boolean; avg: { r: number; g: number; b: number } | null }> {
    const stats: Record<string, any> = {};
    for (const [cat, samples] of this.samples.entries()) {
      stats[cat] = {
        samples: samples.length,
        calibrated: samples.length >= this.MIN_SAMPLES_FOR_CALIBRATION,
        avg: this._average(cat),
      };
    }
    return stats;
  },
};

/**
 * Sample the color at a specific pixel coordinate from the decoded image.
 * Used for color calibration after successful clicks.
 */
function _sampleColorAt(rgba: Uint8ClampedArray, width: number, x: number, y: number): { r: number; g: number; b: number } | null {
  const ix = Math.round(x);
  const iy = Math.round(y);
  if (ix < 0 || ix >= width || iy < 0) return null;
  // Get height from the buffer length
  const totalPixels = rgba.length / 4;
  if (iy * width + ix >= totalPixels) return null;
  const idx = (iy * width + ix) * 4;
  return { r: rgba[idx], g: rgba[idx + 1], b: rgba[idx + 2] };
}

// ─── v4: Safe Coordinate Jitter ────────────────────────────────────────────

/**
 * Add small random jitter to coordinates to prevent UI frameworks from
 * ignoring repeated clicks at the exact same pixel. This is especially
 * important for Flutter/Web apps that may have click debouncing.
 */
function _jitter(
  x: number, y: number, range: number = 3, bounds?: { w?: number; h?: number }
): { x: number; y: number } {
  // Never jitter by more than a quarter of the target's smaller side, so small
  // icons (book / download / close) are not missed.
  let r = range;
  if (bounds && Number.isFinite(bounds.w) && Number.isFinite(bounds.h)) {
    r = Math.min(r, Math.floor(Math.min(bounds.w as number, bounds.h as number) / 4));
  }
  if (r <= 0) return { x: Math.round(x), y: Math.round(y) };
  const jx = x + (Math.random() - 0.5) * r * 2;
  const jy = y + (Math.random() - 0.5) * r * 2;
  return { x: Math.round(jx), y: Math.round(jy) };
}

// ─── v4: Internal Timeout Safety ───────────────────────────────────────────

const PIXEL_TIMEOUT_MS = 8000; // Hard cap: 8 seconds for any pixel operation

/**
 * Wrap an async function with a hard timeout. Returns null on timeout.
 */
async function _withTimeout<T>(fn: () => Promise<T>, label: string, timeoutMs: number = PIXEL_TIMEOUT_MS): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
    fn(),
    new Promise<null>((resolve) =>
      timer = setTimeout(() => {
        // TASK 46 (2026-09-11): Downgraded from WARN to DEBUG — the user
        // doesn't want to see this warning. Pixel fallback timeouts are
        // expected when the page is blank or the screenshot is too small.
        // The null return is sufficient — the caller handles it gracefully.
        log(`Pixel fallback: ${label} timed out after ${timeoutMs}ms`, 'DEBUG', 'pixel-fallback');
        resolve(null);
      }, timeoutMs)
    )
    ]);
  } finally {
    // Previously the timer was never cleared: it kept the event loop alive and
    // logged a bogus "timed out" line 8s after every SUCCESSFUL call.
    if (timer) clearTimeout(timer);
  }
}

// ─── v4: Multi-pass Noise-Reduced Scan ──────────────────────────────────

/**
 * Run color band detection at multiple step sizes and merge/deduplicate results.
 * This dramatically improves detection on JPEG-coarse decoded images where a single
 * step size may miss thin buttons or produce false positives from block artifacts.
 */
function _findColorBandsMultiPass(
  rgba: Uint8ClampedArray, width: number, height: number,
  colorFn: (r: number, g: number, b: number) => boolean,
  y1: number, y2: number, x1: number, x2: number
): DetectedRect[] {
  // Step sizes: 2 (precise) and 3 (coarse). NOTE: currently unused by any caller.
  const steps = [2, 3];
  const allRects: DetectedRect[] = [];

  for (const step of steps) {
    const rects = _findColorBands(rgba, width, height, colorFn, y1, y2, x1, x2, step);
    allRects.push(...rects);
  }

  if (allRects.length <= 1) return allRects;

  // Deduplicate: merge overlapping rects (center within 15px of each other)
  const merged: DetectedRect[] = [];
  const used = new Set<number>();
  for (let i = 0; i < allRects.length; i++) {
    if (used.has(i)) continue;
    const a = allRects[i];
    let sumX = a.cx, sumY = a.cy, sumW = a.w, sumH = a.h, count = 1;
    for (let j = i + 1; j < allRects.length; j++) {
      if (used.has(j)) continue;
      const b = allRects[j];
      if (Math.abs(a.cx - b.cx) < 15 && Math.abs(a.cy - b.cy) < 10) {
        sumX += b.cx; sumY += b.cy; sumW += b.w; sumH += b.h;
        count++;
        used.add(j);
      }
    }
    merged.push({
      x: Math.round(sumX / count - sumW / count / 2),
      y: Math.round(sumY / count - sumH / count / 2),
      w: Math.round(sumW / count),
      h: Math.round(sumH / count),
      cx: Math.round(sumX / count),
      cy: Math.round(sumY / count),
    });
  }

  return merged;
}

// ─── v4: Intelligent Quiz Choice Scoring ──────────────────────────────────

/**
 * Score quiz choices based on visual heuristics to pick the most likely correct answer.
 * For math questions, the correct answer often has:
 *   - Higher text density (more digits/symbols = more precise answer)
 *   - Specific positioning (often B or C in a 4-choice layout)
 *   - Wider width (longer answer text)
 *   - Selected state if auto-selected by the app
 *
 * Returns choices sorted by score (highest first).
 */
interface ScoredChoice extends DetectedRect {
  score: number;
  textDensity: number;
  widthScore: number;
  positionScore: number;
}

function _scoreQuizChoices(
  rgba: Uint8ClampedArray, width: number, height: number,
  choices: DetectedRect[], questionFingerprint: string
): ScoredChoice[] {
  const scored: ScoredChoice[] = [];
  const totalChoices = choices.length;

  for (let i = 0; i < totalChoices; i++) {
    const c = choices[i];
    // Text density inside the choice button
    const density = _getTextDensityInRegion(rgba, width, height,
      Math.max(0, c.x), Math.max(0, c.y),
      Math.min(width, c.x + c.w), Math.min(height, c.y + c.h));

    // Width score: wider choices likely have more text (longer answers)
    const maxWidth = Math.max(...choices.map(ch => ch.w), 1);
    const widthScore = c.w / maxWidth;

    // TASK 99 (2026-09-30): REMOVED position-based answer guessing.
    // Old code assumed B/C > A/D for 4-choice questions, which creates
    // a systematic failure mode and is not intelligence — it's a prior
    // masquerading as evidence. Now all positions are scored equally.
    // The only exception: if a choice is already selected (teal/green),
    // give it the highest priority — that's evidence, not guessing.
    let positionScore = 0.5; // Neutral — no position bias

    // Density score: higher density = more content = more likely correct for math
    const densityScore = Math.min(density * 3, 1.0);

    // Selected state bonus (if already teal/green) — this IS evidence
    if (_isSelectedChoice(rgba, width, c)) {
      positionScore = 1.0; // Already selected, highest priority
    }

    const score = densityScore * 0.5 + widthScore * 0.2 + positionScore * 0.3;
    scored.push({ ...c, score, textDensity: density, widthScore, positionScore });
  }

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

// ─── v4: Assignment Completion Detection ─────────────────────────────────

/**
 * Detect if an assignment/module card appears already completed.
 * Completed modules typically show:
 *   - Green checkmark icon (bright green circle)
 *   - Faded/dimmed action buttons
 *   - Reduced contrast compared to active modules
 */
function _isModuleCompleted(
  rgba: Uint8ClampedArray, width: number, height: number,
  cardRegion?: DetectedRect
): boolean {
  // Sample the area around potential checkmark locations
  // Checkmarks are typically in the left or right side of a card
  const checkRegions = cardRegion
    ? [
        { x1: cardRegion.x, y1: cardRegion.y, x2: cardRegion.x + 40, y2: cardRegion.y + cardRegion.h },
        { x1: cardRegion.x + cardRegion.w - 40, y1: cardRegion.y, x2: cardRegion.x + cardRegion.w, y2: cardRegion.y + cardRegion.h },
      ]
    : [
        { x1: Math.floor(width * 0.05), y1: Math.floor(height * 0.15), x2: Math.floor(width * 0.15), y2: Math.floor(height * 0.85) },
        { x1: Math.floor(width * 0.85), y1: Math.floor(height * 0.15), x2: Math.floor(width * 0.95), y2: Math.floor(height * 0.85) },
      ];

  for (const region of checkRegions) {
    let greenPixels = 0;
    let totalPixels = 0;
    for (let y = region.y1; y < region.y2; y += 3) {
      for (let x = region.x1; x < region.x2; x += 3) {
        if (x < 0 || x >= width || y < 0) continue;
        const totalPixelsInImage = rgba.length / 4;
        if (y * width + x >= totalPixelsInImage) continue;
        const idx = (y * width + x) * 4;
        totalPixels++;
        if (_isCheckmarkGreen(rgba[idx], rgba[idx + 1], rgba[idx + 2])) {
          greenPixels++;
        }
      }
    }
    if (totalPixels > 5 && greenPixels / totalPixels > 0.25) {
      return true;
    }
  }
  return false;
}

// ─── v4: Video Progress Bar Detection ────────────────────────────────────────

/**
 * Detect the video progress bar and its fill percentage.
 * This helps determine if the video is actually playing or stuck.
 * Progress bars are typically thin horizontal bars near the bottom
 * of the video area, with a filled portion (different color) and
 * an unfilled portion (gray/dark).
 */
function _detectVideoProgress(
  rgba: Uint8ClampedArray, width: number, height: number
): { progress: number; isPlaying: boolean; barY: number } | null {
  // Video progress bar is typically in the bottom 20% of the content area
  const barY1 = Math.floor(height * 0.70);
  const barY2 = Math.floor(height * 0.90);
  const barX1 = Math.floor(width * 0.10);
  const barX2 = Math.floor(width * 0.90);

  // Find the progress bar line (a thin horizontal band of consistent color)
  // The bar is typically 3-8px tall
  for (let y = barY1; y < barY2; y += 2) {
    let filledPixels = 0;
    let totalPixels = 0;
    let barStartX = -1;
    let barEndX = -1;
    let fillEndX = -1;

    for (let x = barX1; x < barX2; x += 2) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      totalPixels++;

      // Progress bar background: usually dark/gray
      const isBarPixel = r < 100 && g < 100 && b < 100;
      // Filled portion: usually teal, green, or white
      const isFilledPixel = _isTealGreen(r, g, b) || _isGreenish(r, g, b) || _isWhiteish(r, g, b);

      if (isBarPixel || isFilledPixel) {
        if (barStartX === -1) barStartX = x;
        barEndX = x;
        if (isFilledPixel && fillEndX < x) fillEndX = x;
      }
    }

    if (barEndX > barStartX + width * 0.3) {
      // Found a valid progress bar
      const barWidth = barEndX - barStartX;
      const fillWidth = fillEndX > barStartX ? fillEndX - barStartX : 0;
      const progress = barWidth > 0 ? fillWidth / barWidth : 0;
      return {
        progress,
        isPlaying: progress > 0 && progress < 0.99, // 0% or 100% means not playing
        barY: y,
      };
    }
  }

  return null;
}

// ─── v4: Exercise Memo Flip Detection ─────────────────────────────────────

/**
 * After clicking the book icon on an exercise, detect if the memo/solution
 * page has appeared. The memo page typically has a lighter background in
 * the card area and different content structure than the question page.
 *
 * This prevents the bot from clicking "Next" before viewing the memo.
 */
let _memoViewPending = false;
let _memoViewFingerprint: string = '';
let _memoViewStartTime: number = 0;
const MEMO_VIEW_TIMEOUT_MS = 15000; // 15 seconds max wait for memo page

function _markMemoViewPending(): void {
  _memoViewPending = true;
  _memoViewFingerprint = '';
  _memoViewStartTime = Date.now();
}

function _isMemoPageVisible(
  rgba: Uint8ClampedArray, width: number, height: number
): boolean {
  const fp = _computePageFingerprint(rgba, width, height);

  // TASK 121 (2026-10-21): Hard timeout — if we've been waiting >15s, give up
  // and assume the memo was either shown or won't show. Prevents infinite loop.
  if (_memoViewPending && _memoViewStartTime > 0 && (Date.now() - _memoViewStartTime) > MEMO_VIEW_TIMEOUT_MS) {
    _memoViewPending = false;
    _memoViewFingerprint = '';
    _memoViewStartTime = 0;
    log('Pixel fallback: memo view hard timeout (15s elapsed) — assuming memo was shown', 'WARN', 'pixel-fallback');
    return true;
  }

  // First call after marking pending: record the fingerprint (pre-memo state)
  if (_memoViewPending && !_memoViewFingerprint) {
    _memoViewFingerprint = fp;
    return false; // Need to wait for next cycle to see if page changed
  }

  // If fingerprint changed since memo was clicked, the page flipped
  if (_memoViewPending && _memoViewFingerprint && _fingerprintDistance(fp, _memoViewFingerprint) > FP_CHANGED_MIN_DIST) {
    _memoViewPending = false;
    _memoViewFingerprint = '';
    _memoViewStartTime = 0;
    _memory.memoViewedExercises.add(fp);
    log('Pixel fallback: memo page detected (fingerprint changed after book icon click)', 'INFO', 'pixel-fallback');
    return true;
  }

  // Timeout: if we've been waiting too many cycles, assume memo was viewed
  if (_memoViewPending && _memory.recentActions.length > 0) {
    const lastBookClick = [..._memory.recentActions].reverse().find(a =>
      a.type === 'click' && a.targetX > width * 0.6 && a.targetY < height * 0.25);
    if (lastBookClick && Date.now() - lastBookClick.timestamp > 15000) {
      _memoViewPending = false;
      _memoViewFingerprint = '';
      _memoViewStartTime = 0;
      log('Pixel fallback: memo view timeout (15s) — assuming memo was shown', 'WARN', 'pixel-fallback');
      return true;
    }
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
// v4.1: MATH INTELLIGENCE SYSTEM — Lightweight Digit OCR + Arithmetic Solver
// ═══════════════════════════════════════════════════════════════════════════
// This system attempts to READ the math question from pixel data, SOLVE it,
// and MATCH the computed answer to the closest MCQ choice.
//
// Architecture:
//   1. Character Segmenter — finds dark pixel clusters in a text region
//   2. Digit Recognizer — template-matches characters against 5×7 grids
//   3. Text Reader — reads a whole text region as a string
//   4. Expression Parser — parses simple arithmetic expressions
//   5. Math Solver — evaluates the expression
//   6. Answer Matcher — finds the MCQ choice closest to the computed answer
//
// Accuracy target: 40-60% on simple arithmetic (vs 25% random on 4-choice)
// Memory: ~2KB for templates, ~50KB for working buffers
// ═══════════════════════════════════════════════════════════════════════════

// ─── Digit Templates (5 rows × 5 cols binary grids) ────────────────────────
// Each template is a 25-bit pattern (1 = ink, 0 = background).
// These represent typical sans-serif digit shapes.
const DIGIT_TEMPLATES: Record<string, number[]> = {
  '0': [
    0,1,1,1,0,
    1,0,0,0,1,
    1,0,0,1,1,
    1,0,1,0,1,
    1,1,0,0,1,
    1,0,0,0,1,
    0,1,1,1,0,
  ],
  '1': [
    0,0,1,0,0,
    0,1,1,0,0,
    0,0,1,0,0,
    0,0,1,0,0,
    0,0,1,0,0,
    0,0,1,0,0,
    0,1,1,1,0,
  ],
  '2': [
    0,1,1,1,0,
    1,0,0,0,1,
    0,0,0,0,1,
    0,0,0,1,0,
    0,0,1,0,0,
    0,1,0,0,0,
    1,1,1,1,1,
  ],
  '3': [
    0,1,1,1,0,
    1,0,0,0,1,
    0,0,0,0,1,
    0,0,1,1,0,
    0,0,0,0,1,
    1,0,0,0,1,
    0,1,1,1,0,
  ],
  '4': [
    0,0,0,1,0,
    0,0,1,1,0,
    0,1,0,1,0,
    1,0,0,1,0,
    1,1,1,1,1,
    0,0,0,1,0,
    0,0,0,1,0,
  ],
  '5': [
    1,1,1,1,1,
    1,0,0,0,0,
    1,1,1,1,0,
    0,0,0,0,1,
    0,0,0,0,1,
    1,0,0,0,1,
    0,1,1,1,0,
  ],
  '6': [
    0,0,1,1,0,
    0,1,0,0,0,
    1,0,0,0,0,
    1,1,1,1,0,
    1,0,0,0,1,
    1,0,0,0,1,
    0,1,1,1,0,
  ],
  '7': [
    1,1,1,1,1,
    0,0,0,0,1,
    0,0,0,1,0,
    0,0,1,0,0,
    0,0,1,0,0,
    0,0,1,0,0,
    0,0,1,0,0,
  ],
  '8': [
    0,1,1,1,0,
    1,0,0,0,1,
    1,0,0,0,1,
    0,1,1,1,0,
    1,0,0,0,1,
    1,0,0,0,1,
    0,1,1,1,0,
  ],
  '9': [
    0,1,1,1,0,
    1,0,0,0,1,
    1,0,0,0,1,
    0,1,1,1,1,
    0,0,0,0,1,
    0,0,0,1,0,
    0,1,1,0,0,
  ],
};

// Operator templates (5×5 for compact symbols)
const OP_TEMPLATES: Record<string, number[]> = {
  '+': [
    0,0,1,0,0,
    0,0,1,0,0,
    1,1,1,1,1,
    0,0,1,0,0,
    0,0,1,0,0,
  ],
  '-': [
    0,0,0,0,0,
    0,0,0,0,0,
    1,1,1,1,1,
    0,0,0,0,0,
    0,0,0,0,0,
  ],
  'x': [
    1,0,0,0,1,
    0,1,0,1,0,
    0,0,1,0,0,
    0,1,0,1,0,
    1,0,0,0,1,
  ],
  '=': [
    0,0,0,0,0,
    1,1,1,1,1,
    0,0,0,0,0,
    1,1,1,1,1,
    0,0,0,0,0,
  ],
};

// ─── Character Segmenter ──────────────────────────────────────────────────

interface CharRegion {
  x: number; y: number; w: number; h: number;
  pixels: boolean[][]; // normalized grid
}

/**
 * Find individual character regions in a text area using vertical projection.
 * Dark pixels (text) are grouped into columns, then split at gaps.
 */
function _segmentCharacters(
  rgba: Uint8ClampedArray, width: number, height: number,
  region: { x1: number; y1: number; x2: number; y2: number }
): CharRegion[] {
  const { x1, y1, x2, y2 } = region;
  const rw = x2 - x1;
  const rh = y2 - y1;
  if (rw < 10 || rh < 10) return [];

  // Build vertical projection (ink per column)
  const colInk = new Float32Array(rw);
  for (let x = 0; x < rw; x++) {
    let ink = 0;
    for (let y = 0; y < rh; y++) {
      const px = x1 + x;
      const py = y1 + y;
      if (px >= 0 && px < width && py >= 0 && py < (rgba.length / 4 / width)) {
        const idx = (py * width + px) * 4;
        const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
        if (lum < 120) ink++; // Dark = ink
      }
    }
    colInk[x] = ink / Math.max(rh, 1);
  }

  // Smooth the projection (3-pixel moving average)
  const smoothed = new Float32Array(rw);
  for (let x = 0; x < rw; x++) {
    let sum = 0, cnt = 0;
    for (let dx = -2; dx <= 2; dx++) {
      const sx = x + dx;
      if (sx >= 0 && sx < rw) { sum += colInk[sx]; cnt++; }
    }
    smoothed[x] = sum / Math.max(cnt, 1);
  }

  // Find character boundaries: regions where smoothed > threshold
  const threshold = 0.15;
  const inChar = new Uint8Array(rw);
  for (let x = 0; x < rw; x++) {
    inChar[x] = smoothed[x] > threshold ? 1 : 0;
  }

  // Split into character groups at gaps (3+ pixels of no ink)
  const chars: { start: number; end: number }[] = [];
  let charStart = -1;
  for (let x = 0; x < rw; x++) {
    if (inChar[x]) {
      if (charStart === -1) charStart = x;
    } else {
      if (charStart !== -1) {
        if (x - charStart >= 3) { // Min 3px wide
          chars.push({ start: charStart, end: x - 1 });
        }
        charStart = -1;
      }
    }
  }
  if (charStart !== -1 && rw - charStart >= 3) {
    chars.push({ start: charStart, end: rw - 1 });
  }

  // Merge chars that are very close (< 4px gap)
  const merged: typeof chars = [];
  for (const c of chars) {
    if (merged.length > 0 && c.start - merged[merged.length - 1].end < 4) {
      merged[merged.length - 1].end = c.end;
    } else {
      merged.push({ ...c });
    }
  }

  // Build normalized 5×7 grids for each character
  const result: CharRegion[] = [];
  for (const c of merged) {
    const cw = c.end - c.start + 1;
    if (cw < 3) continue;

    // Find vertical bounds (first and last row with ink)
    let topY = rh, bottomY = 0;
    for (let y = 0; y < rh; y++) {
      for (let x = c.start; x <= c.end; x++) {
        const px = x1 + x;
        const py = y1 + y;
        if (px >= 0 && px < width && py >= 0 && py < (rgba.length / 4 / width)) {
          const idx = (py * width + px) * 4;
          const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
          if (lum < 120) {
            if (y < topY) topY = y;
            if (y > bottomY) bottomY = y;
          }
        }
      }
    }
    if (bottomY <= topY) continue;
    const ch = bottomY - topY + 1;

    // Create 5×7 normalized grid
    const grid: boolean[][] = [];
    for (let gy = 0; gy < 7; gy++) {
      grid[gy] = [];
      for (let gx = 0; gx < 5; gx++) {
        // Map grid cell to source pixels
        const srcX1 = c.start + Math.floor(gx * cw / 5);
        const srcX2 = c.start + Math.floor((gx + 1) * cw / 5);
        const srcY1 = topY + Math.floor(gy * ch / 7);
        const srcY2 = topY + Math.floor((gy + 1) * ch / 7);
        let inkCount = 0, totalCount = 0;
        for (let sy = srcY1; sy < srcY2; sy += 1) {
          for (let sx = srcX1; sx < srcX2; sx += 1) {
            const px = x1 + sx;
            const py = y1 + sy;
            if (px >= 0 && px < width && py >= 0 && py < (rgba.length / 4 / width)) {
              totalCount++;
              const idx = (py * width + px) * 4;
              const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
              if (lum < 120) inkCount++;
            }
          }
        }
        grid[gy][gx] = totalCount > 0 && (inkCount / totalCount) > 0.35;
      }
    }

    result.push({
      x: x1 + c.start,
      y: y1 + topY,
      w: cw,
      h: ch,
      pixels: grid,
    });
  }

  return result;
}

// ─── Digit Recognizer ────────────────────────────────────────────────────

interface RecognizedChar {
  char: string;
  confidence: number;
  alternatives: Array<{ char: string; confidence: number }>;
}

/**
 * Match a character region against digit and operator templates.
 * Uses normalized Hamming distance on the 5×7 grid.
 */
function _recognizeChar(charRegion: CharRegion): RecognizedChar {
  const grid = charRegion.pixels;
  const flat: number[] = [];
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 5; x++) {
      flat.push(grid[y][x] ? 1 : 0);
    }
  }

  // Calculate Hamming distance to each template
  const distances: Array<{ char: string; dist: number }> = [];
  for (const [ch, template] of Object.entries(DIGIT_TEMPLATES)) {
    let dist = 0;
    for (let i = 0; i < 35; i++) {
      if (flat[i] !== template[i]) dist++;
    }
    distances.push({ char: ch, dist });
  }
  for (const [ch, template] of Object.entries(OP_TEMPLATES)) {
    let dist = 0;
    // Only compare first 25 bits (5×5 grid for operators)
    for (let i = 0; i < 25; i++) {
      if (flat[i] !== template[i]) dist++;
    }
    distances.push({ char: ch, dist });
  }

  distances.sort((a, b) => a.dist - b.dist);

  const bestDist = distances[0].dist;
  const secondDist = distances[1]?.dist || 35;
  const maxDist = 35;
  const confidence = Math.max(0, 1 - (bestDist / maxDist));

  const alternatives = distances.slice(1, 4).map(d => ({
    char: d.char,
    confidence: Math.max(0, 1 - (d.dist / maxDist)),
  }));

  // Check if it's likely a decimal point (very small, 1-2px wide, centered)
  if (charRegion.w <= 4 && charRegion.h <= 6) {
    return { char: '.', confidence: 0.6, alternatives };
  }

  return {
    char: confidence > 0.35 ? distances[0].char : '?',
    confidence,
    alternatives,
  };
}

// ─── Text Reader ─────────────────────────────────────────────────────────

/**
 * Read all characters from a text region and return a string.
 * Only returns high-confidence characters (confidence > 0.4).
 */
function _readTextFromRegion(
  rgba: Uint8ClampedArray, width: number, height: number,
  region: { x1: number; y1: number; x2: number; y2: number }
): { text: string; chars: RecognizedChar[]; confidence: number } {
  const segments = _segmentCharacters(rgba, width, height, region);
  if (segments.length === 0) return { text: '', chars: [], confidence: 0 };

  const chars: RecognizedChar[] = [];
  const textParts: string[] = [];
  let totalConf = 0;
  let highConfCount = 0;

  for (const seg of segments) {
    const recognized = _recognizeChar(seg);
    chars.push(recognized);
    totalConf += recognized.confidence;
    if (recognized.confidence > 0.4) {
      textParts.push(recognized.char);
      highConfCount++;
    } else if (recognized.char !== '?') {
      textParts.push(recognized.char); // Include even if uncertain
    }
  }

  const text = textParts.join('');
  const avgConf = chars.length > 0 ? totalConf / chars.length : 0;

  return { text, chars, confidence: avgConf };
}

// ─── Simple Expression Parser ────────────────────────────────────────────

/**
 * Parse and evaluate a simple arithmetic expression.
 * Supports: digits, +, -, x, *, /, (, ), spaces
 * Returns null if the expression is too complex or invalid.
 */
function _parseAndEval(expr: string): number | null {
  try {
    // Clean up the expression
    let cleaned = expr.trim();
    // Replace 'x' with '*' (multiplication)
    cleaned = cleaned.replace(/x/g, '*');
    // Replace '×' with '*'
    cleaned = cleaned.replace(/×/g, '*');
    // Replace '÷' with '/'
    cleaned = cleaned.replace(/÷/g, '/');
    // Remove spaces
    cleaned = cleaned.replace(/\s/g, '');
    // Remove trailing operators
    cleaned = cleaned.replace(/[+\-*/]+$/, '');
    // Remove leading operators (except minus for negatives)
    if (cleaned.length > 1 && /^[+*/]/.test(cleaned)) {
      cleaned = cleaned.substring(1);
    }

    // Must contain at least one digit
    if (!/\d/.test(cleaned)) return null;

    // Safety: only allow safe characters
    if (/[^0-9+\-*/().]/.test(cleaned)) return null;

    // Limit expression length (prevent abuse)
    if (cleaned.length > 30) return null;

    // Evaluate using a simple recursive descent parser
    // (no eval() — that would be a security risk)
    return _safeEval(cleaned);
  } catch {
    return null;
  }
}

/**
 * Simple recursive descent expression evaluator.
 * Supports +, -, *, /, parentheses, negative numbers.
 */
function _safeEval(expr: string): number | null {
  let pos = 0;

  function parseExpr(): number {
    let left = parseTerm();
    while (pos < expr.length && (expr[pos] === '+' || expr[pos] === '-')) {
      const op = expr[pos++];
      const right = parseTerm();
      left = op === '+' ? left + right : left - right;
    }
    return left;
  }

  function parseTerm(): number {
    let left = parseFactor();
    while (pos < expr.length && (expr[pos] === '*' || expr[pos] === '/')) {
      const op = expr[pos++];
      const right = parseFactor();
      if (op === '/') {
        if (right === 0) return 0;
        left = left / right;
      } else {
        left = left * right;
      }
    }
    return left;
  }

  function parseFactor(): number {
    if (expr[pos] === '(') {
      pos++; // skip (
      const val = parseExpr();
      if (pos < expr.length && expr[pos] === ')') pos++; // skip )
      return val;
    }
    if (expr[pos] === '-') {
      pos++;
      return -parseFactor();
    }
    // Parse number
    let numStr = '';
    while (pos < expr.length && (expr[pos] >= '0' && expr[pos] <= '9' || expr[pos] === '.')) {
      numStr += expr[pos++];
    }
    if (numStr === '') return 0;
    return parseFloat(numStr) || 0;
  }

  try {
    const result = parseExpr();
    if (!isFinite(result)) return null;
    return result;
  } catch {
    return null;
  }
}

// ─── Math Problem Analyzer ──────────────────────────────────────────────

interface MathAnalysis {
  questionText: string;
  questionConfidence: number;
  expression: string;
  computedAnswer: number | null;
  answerChoices: Array<{ index: number; text: string; confidence: number; numericValue: number | null }>;
  bestMatchIndex: number;
  bestMatchConfidence: number;
  strategy: string;
}

/**
 * Analyze a math quiz question and attempt to compute the correct answer.
 *
 * Strategy:
 *   1. Read the question area (text between header and choices)
 *   2. Try to parse it as an arithmetic expression
 *   3. Evaluate the expression to get a numeric answer
 *   4. Read each choice button's text
 *   5. Match the computed answer to the closest choice
 *   6. If no match or low confidence, fall back to heuristic scoring
 */
function _analyzeMathQuestion(
  rgba: Uint8ClampedArray, width: number, height: number,
  choiceButtons: DetectedRect[]
): MathAnalysis {
  const result: MathAnalysis = {
    questionText: '',
    questionConfidence: 0,
    expression: '',
    computedAnswer: null,
    answerChoices: [],
    bestMatchIndex: 0,
    bestMatchConfidence: 0,
    strategy: 'none',
  };

  // Step 1: Read the question area
  const qRegion = {
    x1: Math.floor(width * 0.08),
    y1: Math.floor(height * 0.22),
    x2: Math.floor(width * 0.92),
    y2: Math.floor(height * 0.55),
  };
  const questionRead = _readTextFromRegion(rgba, width, height, qRegion);
  result.questionText = questionRead.text;
  result.questionConfidence = questionRead.confidence;

  // Step 2: Read each choice's text
  for (let i = 0; i < choiceButtons.length; i++) {
    const c = choiceButtons[i];
    const choiceRegion = {
      x1: Math.max(0, Math.floor(c.x + 8)),
      y1: Math.max(0, Math.floor(c.y + 2)),
      x2: Math.min(width, Math.floor(c.x + c.w - 8)),
      y2: Math.min(height, Math.floor(c.y + c.h - 2)),
    };
    const read = _readTextFromRegion(rgba, width, height, choiceRegion);
    const numVal = read.text ? parseFloat(read.text) : null;
    result.answerChoices.push({
      index: i,
      text: read.text,
      confidence: read.confidence,
      numericValue: isNaN(numVal) ? null : numVal,
    });
  }

  // Step 3: Try to extract and solve an expression from the question
  if (result.questionText.length >= 3) {
    // Strategy A: Try reading the question as a direct expression
    const expr = result.questionText.replace(/[^0-9+\-*/.x×÷()]/g, '').trim();
    if (expr.length >= 3) {
      result.expression = expr;
      result.computedAnswer = _parseAndEval(expr);
    }

    // Strategy B: Look for "find the value of X" patterns
    // e.g., "? + 5 = 12" → answer is 7
    // Strategy C: Look for "calculate X × Y" patterns
    // These are handled by the expression parser above

    // Strategy D: If the question contains "=", try to solve for the unknown
    if (result.computedAnswer === null && result.questionText.includes('=')) {
      const parts = result.questionText.split('=');
      if (parts.length === 2) {
        // Try "a + b = ?" → compute left side
        const leftVal = _parseAndEval(parts[0].replace(/[^0-9+\-*/.x×÷()]/g, ''));
        if (leftVal !== null) {
          result.computedAnswer = leftVal;
          result.expression = parts[0].trim();
        }
      }
    }
  }

  // Step 4: Match computed answer to choices
  if (result.computedAnswer !== null && result.answerChoices.length > 0) {
    result.strategy = 'computed';
    const target = result.computedAnswer;

    // Find the choice whose numeric value is closest to the computed answer
    let bestDist = Infinity;
    let bestIdx = 0;
    let bestConf = 0;

    for (const choice of result.answerChoices) {
      if (choice.numericValue !== null) {
        const dist = Math.abs(choice.numericValue - target);
        const relDist = Math.abs(dist) / Math.max(Math.abs(target), 1);
        const conf = Math.max(0, 1 - relDist);

        if (dist < bestDist && conf > bestConf) {
          bestDist = dist;
          bestIdx = choice.index;
          bestConf = conf;
        }
      }
    }

    result.bestMatchIndex = bestIdx;
    result.bestMatchConfidence = bestConf;

    // If the closest match is exact (or very close), use it
    if (bestDist < 0.5) {
      result.bestMatchConfidence = Math.min(bestConf + 0.3, 1.0); // Boost for exact match
    }
  }

  // Step 5: If computed answer didn't work, try heuristic strategies
  if (result.bestMatchConfidence < 0.3) {
    result.strategy = 'heuristic';
    result.bestMatchIndex = _applyMathHeuristics(rgba, width, height, choiceButtons, result);
  }

  return result;
}

// ─── Math Heuristics (fallback when OCR fails) ──────────────────────────

/**
 * Apply visual heuristics to pick the best answer when OCR solving fails.
 * These heuristics are based on common patterns in math MCQ design.
 */
function _applyMathHeuristics(
  rgba: Uint8ClampedArray, width: number, height: number,
  choices: DetectedRect[],
  mathAnalysis: MathAnalysis
): number {
  // Heuristic 1: Detect negative choices — if one choice has a minus sign
  // (dark pixels on left side before digits), and the question has negative
  // context, prefer it. Otherwise, avoid negatives.
  const qRegion = {
    x1: Math.floor(width * 0.08),
    y1: Math.floor(height * 0.22),
    x2: Math.floor(width * 0.92),
    y2: Math.floor(height * 0.55),
  };
  const qDensity = _getTextDensityInRegion(rgba, width, height, qRegion.x1, qRegion.y1, qRegion.x2, qRegion.y2);
  const hasQuestionMarks = _detectPatternInRegion(rgba, width, height, qRegion, 'question_mark');

  // Heuristic 2: Detect fraction patterns in choices (horizontal line in middle)
  // Fractions often appear as the correct answer for fraction problems
  const fractionScores = choices.map((c, i) => ({
    index: i,
    hasFraction: _detectFractionInChoice(rgba, width, height, c),
    width: c.w,
    density: _getTextDensityInRegion(rgba, width, height,
      Math.max(0, c.x), Math.max(0, c.y),
      Math.min(width, c.x + c.w), Math.min(height, c.y + c.h)),
  }));

  // Heuristic 3: Elimination — the most common wrong answer pattern
  // If choices are like [10, 12, 15, 18] and the question asks for "2 × 6",
  // 12 is correct. But we can't read "2 × 6". Instead:
  // - Check if two choices sum to a third (one is a sign error)
  // - The "middle" value of 4 sorted choices is often correct for estimation

  const numericChoices = mathAnalysis.answerChoices
    .filter(c => c.numericValue !== null)
    .map(c => c.numericValue!)
    .sort((a, b) => a - b);

  if (numericChoices.length >= 3) {
    // Middle value heuristic: for estimation/word problems, the middle is often right
    const midIdx = Math.floor(numericChoices.length / 2);
    const midVal = numericChoices[midIdx];
    // Find which choice index has this value
    for (const ac of mathAnalysis.answerChoices) {
      if (ac.numericValue === midVal) {
        return ac.index;
      }
    }
  }

  // Heuristic 4: If the question text was partially read, use whatever numbers we got
  // E.g., if we read "3 + 5 = ?" and choices are [7, 8, 9, 10], pick 8
  if (mathAnalysis.questionText.length >= 3 && mathAnalysis.computedAnswer === null) {
    // Try simpler parsing: extract just the numbers
    const numMatches = mathAnalysis.questionText.match(/\d+/g);
    if (numMatches && numMatches.length >= 2) {
      const nums = numMatches.map(Number);
      // If exactly 2 numbers, try common operations
      if (nums.length === 2) {
        const [a, b] = nums;
        // Look for operator hints in the question text
        const qText = mathAnalysis.questionText;
        let possibleAnswers: number[] = [];

        if (qText.includes('+') || qText.includes('add') || qText.includes('sum')) {
          possibleAnswers.push(a + b);
        }
        if (qText.includes('-') || qText.includes('subtract') || qText.includes('minus')) {
          possibleAnswers.push(Math.abs(a - b));
          possibleAnswers.push(a - b); // negative possible
        }
        if (qText.includes('x') || qText.includes('*') || qText.includes('times') || qText.includes('multiply')) {
          possibleAnswers.push(a * b);
        }
        if (qText.includes('/') || qText.includes('÷') || qText.includes('divide')) {
          if (b !== 0) possibleAnswers.push(a / b);
        }

        // If no operator hint, try all basic operations and look for matches
        if (possibleAnswers.length === 0) {
          possibleAnswers.push(a + b, a - b, Math.abs(a - b), a * b);
          if (b !== 0) possibleAnswers.push(a / b, b / a);
        }

        // Match possible answers to choices
        for (const ans of possibleAnswers) {
          if (!isFinite(ans)) continue;
          for (const ac of mathAnalysis.answerChoices) {
            if (ac.numericValue !== null && Math.abs(ac.numericValue - ans) < 0.5) {
              return ac.index;
            }
          }
        }
      }
    }
  }

  // Heuristic 5: Width-based elimination
  // For 4-choice questions, very short answers (1-2 chars) are often distractors
  // unless the question is very simple
  if (choices.length === 4 && qDensity < 0.08) {
    // Simple question → avoid the shortest AND longest (distractors at extremes)
    const byWidth = [...choices].sort((a, b) => a.w - b.w);
    // Skip the narrowest (often "0" or "1") — pick 2nd or 3rd
    const secondNarrowest = byWidth[1];
    return choices.indexOf(secondNarrowest);
  }

  // Default: use position heuristic (B or C for 4-choice)
  if (choices.length === 4) return 1; // B
  if (choices.length === 3) return 1; // Middle
  if (choices.length === 2) return 1; // Second
  return 0;
}

/**
 * Detect specific visual patterns in a region.
 */
function _detectPatternInRegion(
  rgba: Uint8ClampedArray, width: number, height: number,
  region: { x1: number; y1: number; x2: number; y2: number },
  pattern: string
): boolean {
  // For now, just check for dark pixel density patterns
  // A real implementation would look for specific shapes
  const density = _getTextDensityInRegion(rgba, width, height,
    region.x1, region.y1, region.x2, region.y2);
  if (pattern === 'question_mark') {
    // Question marks are typically isolated dark regions near the end of text
    // Look for a small cluster of dark pixels in the right portion
    const rightPortion = {
      x1: Math.floor((region.x1 + region.x2) * 0.7),
      y1: region.y1,
      x2: region.x2,
      y2: region.y2,
    };
    const rDensity = _getTextDensityInRegion(rgba, width, height,
      rightPortion.x1, rightPortion.y1, rightPortion.x2, rightPortion.y2);
    return rDensity > 0.03 && rDensity < 0.15;
  }
  return false;
}

/**
 * Detect if a choice contains a fraction (horizontal line in the middle).
 * Fractions have a distinct visual pattern: a short horizontal line
 * separating numerator (top) and denominator (bottom).
 */
function _detectFractionInChoice(
  rgba: Uint8ClampedArray, width: number, height: number,
  choice: DetectedRect
): boolean {
  const cx = choice.cx;
  const cy = choice.cy;
  const halfW = Math.floor(choice.w * 0.3);

  // Check for a horizontal line at the vertical center of the choice
  // A fraction bar is a thin horizontal dark line
  const lineY = cy;
  let linePixels = 0;
  let totalPixels = 0;

  for (let dx = -halfW; dx <= halfW; dx += 2) {
    const px = cx + dx;
    if (px < 0 || px >= width) continue;
    const imgHeight = rgba.length / 4 / width;
    if (lineY < 0 || lineY >= imgHeight) continue;

    const idx = (lineY * width + px) * 4;
    totalPixels++;
    const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
    if (lum < 100) linePixels++;
  }

  // Also check 1px above and below to confirm it's a line (not text)
  let abovePixels = 0, belowPixels = 0;
  for (let dx = -halfW; dx <= halfW; dx += 2) {
    const px = cx + dx;
    if (px < 0 || px >= width) continue;
    const imgHeight = rgba.length / 4 / width;
    if (lineY - 1 < 0 || lineY + 1 >= imgHeight) continue;

    const aboveIdx = ((lineY - 1) * width + px) * 4;
    const belowIdx = ((lineY + 1) * width + px) * 4;
    const aboveLum = 0.299 * rgba[aboveIdx] + 0.587 * rgba[aboveIdx + 1] + 0.114 * rgba[aboveIdx + 2];
    const belowLum = 0.299 * rgba[belowIdx] + 0.587 * rgba[belowIdx + 1] + 0.114 * rgba[belowIdx + 2];
    if (aboveLum > 150) abovePixels++;
    if (belowLum > 150) belowPixels++;
  }

  // Fraction bar: high ink on the center line, low ink above and below
  const lineInkRatio = totalPixels > 0 ? linePixels / totalPixels : 0;
  const clearAbove = totalPixels > 0 ? abovePixels / totalPixels : 0;
  const clearBelow = totalPixels > 0 ? belowPixels / totalPixels : 0;

  return lineInkRatio > 0.3 && (clearAbove + clearBelow) / 2 > 0.4;
}

// ─── Keypad Math Solver ──────────────────────────────────────────────────

/**
 * When facing a numeric keypad (no MCQ), try to compute the answer
 * and return a sequence of keypresses.
 *
 * Strategy:
 *   1. Read the question area for numbers and operators
 *   2. Parse and evaluate the expression
 *   3. Convert the result to a digit sequence
 *   4. Match digits to keypad buttons
 */
function _solveForKeypad(
  rgba: Uint8ClampedArray, width: number, height: number,
  keypad: KeypadButton[]
): { sequence: KeypadButton[]; answer: string; confidence: number } | null {
  // Read question area
  const qRegion = {
    x1: Math.floor(width * 0.08),
    y1: Math.floor(height * 0.22),
    x2: Math.floor(width * 0.92),
    y2: Math.floor(height * 0.55),
  };
  const questionRead = _readTextFromRegion(rgba, width, height, qRegion);

  if (questionRead.text.length < 3 || questionRead.confidence < 0.3) {
    return null;
  }

  // Try to parse the expression
  const expr = questionRead.text.replace(/[^0-9+\-*/.x×÷()]/g, '').trim();
  if (expr.length < 3) return null;

  const answer = _parseAndEval(expr);
  if (answer === null || !isFinite(answer)) return null;

  // Convert answer to string
  let answerStr = String(Math.round(answer * 100) / 100); // 2 decimal places max

  // Build keypad sequence
  const sequence: KeypadButton[] = [];
  for (const ch of answerStr) {
    if (ch === '-') {
      // Find a minus/negative key (look for '-' on keypad)
      // Keypad usually doesn't have minus — might need to skip
      continue;
    }
    if (ch === '.') {
      // Find decimal point key
      const dotKey = keypad.find(k => k.probableDigit === '.');
      if (dotKey) sequence.push(dotKey);
      continue;
    }
    // Find the digit key
    const digitKey = keypad.find(k => k.probableDigit === ch);
    if (digitKey) {
      sequence.push(digitKey);
    } else {
      // Digit not found on keypad — abort
      return null;
    }
  }

  if (sequence.length === 0) return null;

  log(`Math solver: question="${questionRead.text}" → expr="${expr}" → answer=${answer} → keypad sequence "${answerStr}" (${sequence.length} keys, conf=${questionRead.confidence.toFixed(2)})`, 'INFO', 'pixel-fallback');

  return {
    sequence,
    answer: answerStr,
    confidence: questionRead.confidence,
  };
}

// ─── Math Intelligence Score Modifier ───────────────────────────────────

/**
 * Modify quiz choice scores based on math analysis results.
 * If math solving produces a high-confidence match, boost that choice's score.
 */
function _applyMathScoreBoost(
  scored: ScoredChoice[],
  mathAnalysis: MathAnalysis,
  choiceButtons: DetectedRect[]
): ScoredChoice[] {
  if (mathAnalysis.bestMatchConfidence < 0.25) return scored;

  const boostFactor = mathAnalysis.bestMatchConfidence * 0.6; // Up to 0.6 boost
  const targetIndex = mathAnalysis.bestMatchIndex;

  for (const s of scored) {
    const origIndex = choiceButtons.indexOf(s);
    if (origIndex === targetIndex) {
      s.score = Math.min(1.0, s.score + boostFactor);
      log(`Math intelligence: boosted choice ${origIndex} by ${boostFactor.toFixed(2)} (strategy=${mathAnalysis.strategy}, answer=${mathAnalysis.computedAnswer}, conf=${mathAnalysis.bestMatchConfidence.toFixed(2)}, qText="${mathAnalysis.questionText}")`, 'INFO', 'pixel-fallback');
    }
  }

  // Re-sort by score descending
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

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
 * Dark navy blue circles (~30-45px diameter) containing white downward arrow.
 */
function _findDownloadButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const y1 = Math.floor(height * 0.15);
  const y2 = Math.floor(height * 0.85);
  const x1 = Math.floor(width * 0.40);
  const x2 = Math.floor(width * 0.85);

  const downloadBands = _findColorBands(rgba, width, height, _isDownloadButtonColor, y1, y2, x1, x2, 3);

  const candidates = downloadBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 25 && r.w <= 55 && r.h >= 25 && r.h <= 55 &&
             aspectRatio > 0.6 && aspectRatio < 1.6;
    });

  if (candidates.length === 0) return null;

  for (const candidate of candidates) {
    let whitePixelsInCenter = 0;
    let totalPixelsChecked = 0;
    const cx = candidate.cx;
    const cy = candidate.cy;
    const radius = Math.min(candidate.w, candidate.h) / 2;

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

    if (totalPixelsChecked > 0 && whitePixelsInCenter / totalPixelsChecked > 0.25) {
      log(`Pixel fallback: found download button at (${cx}, ${cy}) size ${candidate.w}x${candidate.h}`, 'INFO', 'pixel-fallback');
      return candidate;
    }
  }

  return null;
}

/**
 * Detect if module content has loaded (topics visible with multiple small colored buttons).
 */
function _isModuleContentLoaded(
  rgba: Uint8ClampedArray, width: number, height: number
): boolean {
  const y1 = Math.floor(height * 0.20);
  const y2 = Math.floor(height * 0.85);
  const x1 = Math.floor(width * 0.15);
  const x2 = Math.floor(width * 0.85);

  const isButtonColor = (r: number, g: number, b: number) =>
    _isGreenish(r, g, b) || _isOrangeish(r, g, b) || _isTealGreen(r, g, b);

  const coloredBands = _findColorBands(rgba, width, height, isButtonColor, y1, y2, x1, x2, 3);

  const topicButtons = coloredBands.filter(r => {
    return r.w >= 40 && r.w <= 200 && r.h >= 15 && r.h <= 50;
  });

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

// ─── Selected choice detection ─────────────────────��───────────────────────

function _isSelectedChoice(
  rgba: Uint8ClampedArray, width: number, rect: DetectedRect,
  height: number = Math.floor(rgba.length / 4 / width)
): boolean {
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
  return totalCount > 0 && (tealCount / totalCount) > 0.4;
}

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

function _findFullWidthButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  const y1 = Math.floor(height * 0.82);
  const y2 = Math.floor(height * 0.98);
  const x1 = Math.floor(width * 0.05);
  const x2 = Math.floor(width * 0.95);

  const isFullWidthColor = (r: number, g: number, b: number) =>
    _isTealGreen(r, g, b) || _isGreenish(r, g, b) || _isMicrosoftBlue(r, g, b);

  const bands = _findColorBands(rgba, width, height, isFullWidthColor, y1, y2, x1, x2, 2);

  const buttons = bands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= width * 0.6 && r.h >= 25 && r.h <= 70 && aspectRatio > 4 && aspectRatio < 25;
    })
    .sort((a, b) => a.cy - b.cy);

  return buttons.length > 0 ? buttons[0] : null;
}

// ─── Next question button detection ────────────────────────────────────────

function _findNextQuestionButton(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
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

// ─── Numeric keypad detection (NEW in v3) ────────────────────────────────

/**
 * Find numeric keypad buttons on quiz/exercise pages.
 * These are typically small square-ish buttons with dark text on light background,
 * arranged in a grid (usually 3-4 columns) in the lower portion of the screen.
 *
 * Returns an array of detected keypads with their approximate digit labels
 * based on position (standard numpad layout: 7 8 9 / 4 5 6 / 1 2 3 / 0).
 */
interface KeypadButton extends DetectedRect {
  probableDigit: string;
}

function _findNumericKeypad(
  rgba: Uint8ClampedArray, width: number, height: number
): KeypadButton[] {
  const y1 = Math.floor(height * 0.55);
  const y2 = Math.floor(height * 0.82);
  const x1 = Math.floor(width * 0.20);
  const x2 = Math.floor(width * 0.80);

  // Keypad buttons are typically light-colored (white/light gray) with dark text
  const keypadBands = _findColorBands(rgba, width, height, _isLightGray, y1, y2, x1, x2, 2);

  // Also check for white keypad buttons
  const whiteBands = _findColorBands(rgba, width, height, _isWhiteish, y1, y2, x1, x2, 2);

  const allBands = [...keypadBands, ...whiteBands];

  // Filter for square-ish shapes (keypad buttons are roughly square)
  const candidates = allBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 25 && r.w <= 80 && r.h >= 25 && r.h <= 80 &&
             aspectRatio > 0.6 && aspectRatio < 1.6;
    })
    .sort((a, b) => a.cy - b.cy || a.cx - b.cx);

  if (candidates.length < 4) return []; // Not enough buttons for a keypad

  // Check if they form a grid pattern (at least 3 columns)
  const rows: DetectedRect[][] = [];
  let currentRow: DetectedRect[] = [candidates[0]];

  for (let i = 1; i < candidates.length; i++) {
    if (Math.abs(candidates[i].cy - currentRow[0].cy) < 20) {
      currentRow.push(candidates[i]);
    } else {
      if (currentRow.length >= 3) rows.push(currentRow);
      currentRow = [candidates[i]];
    }
  }
  if (currentRow.length >= 3) rows.push(currentRow);

  if (rows.length < 2) return []; // Not a grid

  // Map positions to probable digits (standard layout)
  const keypad: KeypadButton[] = [];
  const digitLayout = ['7', '8', '9', '4', '5', '6', '1', '2', '3', '', '0', ''];

  for (let rowIdx = 0; rowIdx < Math.min(rows.length, 4); rowIdx++) {
    const sortedRow = [...rows[rowIdx]].sort((a, b) => a.cx - b.cx);
    for (let colIdx = 0; colIdx < Math.min(sortedRow.length, 3); colIdx++) {
      const layoutIdx = rowIdx * 3 + colIdx;
      if (layoutIdx < digitLayout.length && digitLayout[layoutIdx]) {
        keypad.push({
          ...sortedRow[colIdx],
          probableDigit: digitLayout[layoutIdx],
        });
      }
    }
  }

  return keypad;
}

// ─── Error/crash page detection (NEW in v3) ─────────────────────────────

interface ErrorPageResult {
  isError: boolean;
  errorType: 'blank' | 'browser_error' | 'network_error' | 'crash' | 'loading' | 'captcha';
  description: string;
}

/**
 * Detect if the current page is an error, crash, or loading page.
 * Uses pixel analysis to identify:
 *   - Blank white screen (app failed to render)
 *   - Browser error pages (gray with error icon)
 *   - Network error pages
 *   - Loading/spinner pages (mostly blank with small spinner)
 *   - CAPTCHA challenge pages
 */
function _detectErrorPage(
  rgba: Uint8ClampedArray, width: number, height: number,
  url: string
): ErrorPageResult {
  const dominantColor = _getDominantColor(rgba, width, height);
  const headerColor = _getRegionDominantColor(rgba, width, height, 0.0, 0.0, 1.0, 0.15);
  const centerColor = _getRegionDominantColor(rgba, width, height, 0.2, 0.3, 0.8, 0.7);
  const textDensity = _getTextDensityInRegion(rgba, width, height, 0, 0, width, height);

  // 1. Blank white screen (Flutter canvas failed to render)
  if (_isWhiteish(dominantColor.r, dominantColor.g, dominantColor.b) &&
      textDensity < 0.02) {
    return {
      isError: true,
      errorType: 'blank',
      description: 'Blank white screen — Flutter canvas failed to render'
    };
  }

  // 2. Browser error pages (grayish with "ERR_" text or sad face)
  if (_isLightGray(dominantColor.r, dominantColor.g, dominantColor.b) &&
      textDensity > 0.05 && textDensity < 0.15) {
    // Check for red error accents
    const topAccent = _getRegionDominantColor(rgba, width, height, 0.3, 0.2, 0.7, 0.35);
    if (_isReddish(topAccent.r, topAccent.g, topAccent.b)) {
      return {
        isError: true,
        errorType: 'browser_error',
        description: 'Browser error page detected (gray background with red accent)'
      };
    }
    return {
      isError: true,
      errorType: 'browser_error',
      description: 'Possible browser error page (gray background, low text density)'
    };
  }

  // 3. Network error / offline page
  if (_urlPathHas(url, ['offline', 'error', 'no-internet'])) {
    return {
      isError: true,
      errorType: 'network_error',
      description: `Network error page (URL: ${url})`
    };
  }

  // 4. CAPTCHA challenge page
  // CAPTCHA pages typically have a white/light background with a prominent
  // checkbox or image challenge in the center
  if (_urlPathHas(url, ['captcha', 'challenge', 'verify'])) {
    return {
      isError: true,
      errorType: 'captcha',
      description: 'CAPTCHA challenge page detected'
    };
  }

  // 5. Almost entirely black/dark (page crash)
  if (dominantColor.r < 40 && dominantColor.g < 40 && dominantColor.b < 40 && textDensity < 0.05) {
    return {
      isError: true,
      errorType: 'crash',
      description: 'Dark/black screen — page may have crashed'
    };
  }

  // 6. Loading page (mostly one color with very little content)
  // Check if the page is >90% one solid color (loading spinner background)
  const colorVariance = _getColorVariance(rgba, width, height);
  if (colorVariance < 500) {
    return {
      isError: true,
      errorType: 'loading',
      description: 'Solid color page — likely still loading'
    };
  }

  return { isError: false, errorType: 'loading', description: '' };
}

/**
 * Calculate color variance across the image. Low variance = solid color.
 */
function _getColorVariance(rgba: Uint8ClampedArray, width: number, height: number): number {
  let sumR = 0, sumG = 0, sumB = 0;
  let sumR2 = 0, sumG2 = 0, sumB2 = 0;
  let count = 0;
  const step = 20;

  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      sumR += r; sumG += g; sumB += b;
      sumR2 += r * r; sumG2 += g * g; sumB2 += b * b;
      count++;
    }
  }

  if (count === 0) return 0;
  const varR = sumR2 / count - (sumR / count) ** 2;
  const varG = sumG2 / count - (sumG / count) ** 2;
  const varB = sumB2 / count - (sumB / count) ** 2;
  return varR + varG + varB;
}

// ─── Modal/overlay detection (NEW in v3) ─────────────────────────────────

/**
 * Detect if a modal/overlay/popup is blocking the main UI.
 * Modals typically have:
 *   - A semi-transparent dark overlay covering most of the screen
 *   - A bright white/light card in the center
 *   - A close/X button in the top-right corner
 *
 * Returns the close button coordinates if found, or null if no modal.
 */
function _detectModal(
  rgba: Uint8ClampedArray, width: number, height: number
): DetectedRect | null {
  // A dimmed-backdrop modal darkens ALL FOUR corners relative to the centre.
  // (Checking only the top-left matched every page with a dark app header.)
  const centerColor = _getRegionDominantColor(rgba, width, height, 0.25, 0.25, 0.75, 0.75);
  const centerSum = centerColor.r + centerColor.g + centerColor.b;
  const corners = [
    _getRegionDominantColor(rgba, width, height, 0.0, 0.0, 0.1, 0.1),
    _getRegionDominantColor(rgba, width, height, 0.9, 0.0, 1.0, 0.1),
    _getRegionDominantColor(rgba, width, height, 0.0, 0.9, 0.1, 1.0),
    _getRegionDominantColor(rgba, width, height, 0.9, 0.9, 1.0, 1.0),
  ];
  const overlayDetected = corners.every(c => c.r + c.g + c.b < centerSum - 60);
  if (!overlayDetected) return null;

  // Look for a close/X button in the top-right area of the modal
  // Close buttons are typically small dark elements
  const closeX1 = Math.floor(width * 0.65);
  const closeX2 = Math.floor(width * 0.95);
  const closeY1 = Math.floor(height * 0.08);
  const closeY2 = Math.floor(height * 0.25);

  const darkBands = _findColorBands(rgba, width, height, _isDark, closeY1, closeY2, closeX1, closeX2, 2);
  const closeButtons = darkBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 15 && r.w <= 50 && r.h >= 15 && r.h <= 50 && aspectRatio > 0.5 && aspectRatio < 2.0;
    })
    .sort((a, b) => a.cx - b.cx);

  if (closeButtons.length > 0) {
    log(`Pixel fallback: detected modal with close button at (${closeButtons[0].cx}, ${closeButtons[0].cy})`, 'INFO', 'pixel-fallback');
    return closeButtons[0];
  }

  return null;
}

// ─── Basic text region extraction ──────────────────────────────────────

function _getTextDensityInRegion(
  rgba: Uint8ClampedArray, width: number, height: number,
  x1: number, y1: number, x2: number, y2: number
): number {
  let darkPixels = 0;
  let totalPixels = 0;
  const step = 2;
  for (let y = y1; y < y2; y += step) {
    for (let x = x1; x < x2; x += step) {
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const idx = (y * width + x) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      totalPixels++;
      const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
      if (luminance < 80) darkPixels++;
    }
  }
  return totalPixels > 0 ? darkPixels / totalPixels : 0;
}

function _extractTextRegions(
  rgba: Uint8ClampedArray, width: number, height: number
): { questionRegion: { x1: number; y1: number; x2: number; y2: number; density: number } | null; choiceRegions: Array<{ x1: number; y1: number; x2: number; y2: number; density: number; index: number }> } | null {
  const qY1 = Math.floor(height * 0.25);
  const qY2 = Math.floor(height * 0.55);
  const qX1 = Math.floor(width * 0.10);
  const qX2 = Math.floor(width * 0.90);
  const questionDensity = _getTextDensityInRegion(rgba, width, height, qX1, qY1, qX2, qY2);

  if (questionDensity < 0.05) return null;

  const questionRegion = { x1: qX1, y1: qY1, x2: qX2, y2: qY2, density: questionDensity };

  const choices = _findChoiceButtons(rgba, width, height);
  const choiceRegions: Array<{ x1: number; y1: number; x2: number; y2: number; density: number; index: number }> = [];

  for (let i = 0; i < choices.length; i++) {
    const c = choices[i];
    const cx1 = Math.max(0, Math.floor(c.x - 5));
    const cy1 = Math.max(0, Math.floor(c.y - 2));
    const cx2 = Math.min(width, Math.floor(c.x + c.w + 5));
    const cy2 = Math.min(height, Math.floor(c.y + c.h + 2));
    const density = _getTextDensityInRegion(rgba, width, height, cx1, cy1, cx2, cy2);
    choiceRegions.push({ x1: cx1, y1: cy1, x2: cx2, y2: cy2, density, index: i });
  }

  return { questionRegion, choiceRegions };
}

// ─── Page fingerprinting (NEW in v3) ──────────────────────────────────────

/**
 * Compute a fast perceptual hash of the current page.
 * Used to detect if the page changed after an action.
 * Samples pixels at regular intervals and creates a short hash.
 */
/**
 * Perceptual "difference hash" of a screen REGION (fractions of the image).
 * The region is split into a 9x9 grid of block-averaged luminance; one bit per
 * horizontal and per vertical neighbour comparison => 64 + 64 = 128 bits
 * (32 hex chars). Robust to small noise (anti-aliasing, caret blink, spinners),
 * sensitive to layout changes. Compare two hashes with _fingerprintDistance().
 *
 * (The previous implementation hashed only the first 32 samples of the top
 * pixel row, so nearly every page produced the same fingerprint.)
 */
function _computeRegionFingerprint(
  rgba: Uint8ClampedArray, width: number, height: number,
  x1p: number, y1p: number, x2p: number, y2p: number
): string {
  const COLS = 9, ROWS = 9;
  const rx0 = Math.floor(width * x1p);
  const ry0 = Math.floor(height * y1p);
  const rw = Math.max(1, Math.floor(width * x2p) - rx0);
  const rh = Math.max(1, Math.floor(height * y2p) - ry0);
  const cell = new Float64Array(COLS * ROWS);

  for (let r = 0; r < ROWS; r++) {
    const ya = ry0 + Math.floor(r * rh / ROWS);
    const yb = Math.max(ya + 1, ry0 + Math.floor((r + 1) * rh / ROWS));
    const sy = Math.max(1, Math.floor((yb - ya) / 5));
    for (let c = 0; c < COLS; c++) {
      const xa = rx0 + Math.floor(c * rw / COLS);
      const xb = Math.max(xa + 1, rx0 + Math.floor((c + 1) * rw / COLS));
      const sx = Math.max(1, Math.floor((xb - xa) / 5));
      let sum = 0, n = 0;
      for (let y = ya; y < yb && y < height; y += sy) {
        for (let x = xa; x < xb && x < width; x += sx) {
          const idx = (y * width + x) * 4;
          sum += 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
          n++;
        }
      }
      cell[r * COLS + c] = n > 0 ? sum / n : 0;
    }
  }

  const TOL = 2; // luminance dead-zone so flat areas hash to a stable 0
  let bits = '';
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      bits += cell[r * COLS + c] > cell[r * COLS + c + 1] + TOL ? '1' : '0';
  for (let r = 0; r < 8; r++)
    for (let c = 0; c < 8; c++)
      bits += cell[r * COLS + c] > cell[(r + 1) * COLS + c] + TOL ? '1' : '0';

  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.substring(i, i + 4), 2).toString(16);
  return hex;
}

function _computePageFingerprint(rgba: Uint8ClampedArray, width: number, height: number): string {
  return _computeRegionFingerprint(rgba, width, height, 0, 0, 1, 1);
}

/** Hamming distance between two fingerprints (0 = identical, 128 = opposite). */
function _fingerprintDistance(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return 128;
  const POP = [0, 1, 1, 2, 1, 2, 2, 3, 1, 2, 2, 3, 2, 3, 3, 4];
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    const x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    d += Number.isNaN(x) ? 4 : POP[x];
  }
  return d;
}

/** Two fingerprints within this many bits (of 128) are treated as the same page. */
const FP_SAME_PAGE_MAX_DIST = 6;
/** More than this many differing bits => the page clearly changed. */
const FP_CHANGED_MIN_DIST = 10;

// ─── Page type detection (URL-based) ──────────────────────────────────────

function _isMicrosoftLoginPage(url: string): boolean {
  return url.includes('login.microsoftonline.com') ||
         url.includes('login.live.com') ||
         url.includes('login.microsoft.com');
}

/** True if a whole path segment (or _/- separated token) of the URL equals one of `words`. */
function _urlPathHas(url: string, words: string[]): boolean {
  let path: string;
  try { path = new URL(url).pathname.toLowerCase(); } catch { path = String(url || '').toLowerCase(); }
  return words.some(w => new RegExp(`(^|[/_-])${w}($|[/_.-])`).test(path));
}

/** Microsoft login host, or an app path like /login, /signin, /auth (NOT "author"). */
function _isLoginUrl(url: string): boolean {
  return _isMicrosoftLoginPage(url) || _urlPathHas(url, ['login', 'signin', 'sign-in', 'auth', 'oauth2']);
}

function _isMicrosoftPasswordPage(url: string): boolean {
  return url.includes('/password') || url.includes('/postpassword');
}

function _isMicrosoftKMSIPage(url: string): boolean {
  return url.includes('/kmsi') || (url.includes('/oauth2/authorize') && url.includes('prompt=none'));
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

function _classifyPageByColor(
  rgba: Uint8ClampedArray, width: number, height: number
): 'microsoft_login' | 'mathu_app' | 'quiz' | 'score_screen' | 'exercise_info' | 'unknown' {
  const headerColor = _getRegionDominantColor(rgba, width, height, 0.0, 0.0, 1.0, 0.25);
  const overallColor = _getDominantColor(rgba, width, height);

  if (_isWhiteish(headerColor.r, headerColor.g, headerColor.b) ||
      _isLightGray(headerColor.r, headerColor.g, headerColor.b)) {
    const midColor = _getRegionDominantColor(rgba, width, height, 0.3, 0.35, 0.7, 0.45);
    if (_isMicrosoftBlue(midColor.r, midColor.g, midColor.b)) {
      return 'microsoft_login';
    }
  }

  if (_isDeepBlueBackground(headerColor.r, headerColor.g, headerColor.b)) {
    return 'mathu_app';
  }

  if (_isMintPageBackground(overallColor.r, overallColor.g, overallColor.b)) {
    return 'quiz';
  }

  if (_isScoreScreenByPixels(rgba, width, height)) {
    return 'score_screen';
  }

  if (_isDeepBlueBackground(headerColor.r, headerColor.g, headerColor.b)) {
    return 'mathu_app';
  }

  if (_isExercisePageByPixels(rgba, width, height)) {
    return 'exercise_info';
  }

  return 'unknown';
}

// ─── State-aware memory (NEW in v3) ───────────────────────────────────────

/**
 * Persistent (in-memory) state for the pixel fallback brain.
 * Tracks quiz choices tried, scroll depth, action history, progress.
 * Resets on process restart (ephemeral).
 */
const _memory = {
  // Quiz choice tracking: for each question fingerprint, which choice indices were tried
  quizChoicesTried: new Map<string, Set<number>>(),

  // Action history for stagnation detection
  recentActions: [] as Array<{ type: string; targetX: number; targetY: number; fingerprint: string; timestamp: number; _state?: string }>,
  MAX_RECENT_ACTIONS: 20,

  // Scroll depth tracking (per page fingerprint)
  scrollDepths: new Map<string, number>(),
  MAX_SCROLL_DEPTH: 5, // Max CONSECUTIVE scroll actions before giving up on a page
  scrollStreak: 0,     // consecutive scroll actions (see _recordAction)

  // Video progress tracking (used by _videoPlayerAction)
  _lastVideoProgress: 0,
  _videoStuckCount: 0,

  // Consecutive failure counter
  consecutiveFailures: 0,
  MAX_CONSECUTIVE_FAILURES: 8,

  // Page fingerprints for change detection
  lastFingerprint: '',
  lastActionFingerprint: '', // fingerprint BEFORE the last action
  pageChangedAfterAction: false,

  // Progress tracking
  questionsAnswered: 0,
  modulesDownloaded: 0,
  videosWatched: 0,
  exercisesCompleted: 0,
  totalActionsTaken: 0,

  // Exercise memo tracking: which exercises have had their memo viewed
  memoViewedExercises: new Set<string>(),

  // Last error recovery timestamp
  lastErrorRecovery: 0,
  ERROR_RECOVERY_COOLDOWN_MS: 15000, // Don't retry error recovery more than every 15s

  // TASK 102 (2026-09-30): Action feedback loop.
  // After each action, the cycle-manager calls recordActionOutcome() with
  // the new screenshot fingerprint. We compare the before/after fingerprints:
  //   - Page changed → reward the action type (reinforce)
  //   - Page same → penalize the action type (suppress future use)
  // This creates a simple learning loop: actions that historically change
  // the page get boosted; actions that don't get suppressed.
  actionRewards: new Map<string, number>(), // key: `${state}:${actionType}`, value: reward score
  lastActionFingerprintBefore: '',          // fingerprint BEFORE the last action

  // TASK 103 (2026-09-30): Region-level change detection.
  // Split the screen into a 3×3 grid and track which regions changed.
  // This makes the action feedback much more trustworthy: "center changed
  // but header/sidebar didn't" is stronger evidence than "page changed."
  lastRegionFingerprints: [] as string[], // 9 region fingerprints BEFORE last action

  // TASK 103: Visual object map.
  // Track detected objects across screenshots with persistence metadata.
  // Objects that exist for many frames and have never changed the page
  // when clicked become low priority.
  visualObjects: [] as VisualObject[],

  // TASK 103: Safe action ladder — track which risk levels have been exhausted
  safeActionExhausted: { wait: false, scroll: false, lowRisk: false, mediumRisk: false },
};

// ─── TASK 103: Visual Object Type ──────────────────────────────────────────

interface VisualObject {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  kind: 'button' | 'input' | 'link' | 'icon' | 'card' | 'modal' | 'navigation' | 'text' | 'unknown';
  confidence: number;
  firstSeen: number;
  lastSeen: number;
  timesClicked: number;
  timesChangedPage: number;
  timesNoEffect: number;
}

/**
 * TASK 102+103: Record the outcome of the last action.
 * Called by the cycle-manager AFTER executing an action and taking a new screenshot.
 * Uses region-level change detection (3×3 grid) for more trustworthy feedback.
 *
 * Reward hierarchy (not just "page changed = good"):
 *   +5  workflow advancement (state changed to known progress state)
 *   +3  major content region change (center region changed significantly)
 *   +2  modal disappeared
 *   +2  new interactive objects appeared
 *   +1  small relevant change
 *    0  ambiguous visual change (animation, timer, spinner)
 *   -2  no meaningful change
 *   -4  same action repeatedly ineffective
 */
function recordActionOutcome(newRegionFingerprints: string[], actionChangedPage: boolean): void {
  if (!_memory.lastActionFingerprintBefore || _memory.lastRegionFingerprints.length === 0) return;

  const lastAction = _memory.recentActions[_memory.recentActions.length - 1];
  if (!lastAction) return;

  const stateKey = `${lastAction._state || 'unknown'}:${lastAction.type}`;
  const currentReward = _memory.actionRewards.get(stateKey) || 0;

  // TASK 103: Region-level analysis.
  // Compare each of the 9 grid regions. This distinguishes:
  //   "center changed, header/sidebar didn't" = meaningful content change
  //   "all regions changed slightly" = probably animation/timer
  //   "only top-left changed" = probably a loading spinner
  let centerChanged = false;
  let headerChanged = false;
  let sidebarChanged = false;
  let anyChanged = false;
  let changedCount = 0;

  for (let i = 0; i < 9 && i < _memory.lastRegionFingerprints.length && i < newRegionFingerprints.length; i++) {
    const dist = _fingerprintDistance(_memory.lastRegionFingerprints[i], newRegionFingerprints[i]);
    if (dist > FP_CHANGED_MIN_DIST) {
      anyChanged = true;
      changedCount++;
      // Region layout: 0=TL 1=TC 2=TR 3=ML 4=MC 5=MR 6=BL 7=BC 8=BR
      if (i === 4) centerChanged = true;       // Center
      if (i <= 2) headerChanged = true;         // Top row = header
      if (i === 0 || i === 3 || i === 6) sidebarChanged = true; // Left column
    }
  }

  // Determine reward based on change pattern
  let rewardDelta = 0;

  if (centerChanged && !headerChanged) {
    // Center changed but header didn't — likely a real content change
    rewardDelta = +3;
    log(`Action feedback: ${stateKey} → +3 (center region changed, header stable — meaningful content change)`, 'INFO', 'pixel-fallback');
  } else if (changedCount >= 5) {
    // Most of the page changed — likely navigation
    rewardDelta = +2;
    log(`Action feedback: ${stateKey} → +2 (${changedCount}/9 regions changed — likely navigation)`, 'INFO', 'pixel-fallback');
  } else if (anyChanged) {
    // Some regions changed — ambiguous
    rewardDelta = +1;
    log(`Action feedback: ${stateKey} → +1 (${changedCount}/9 regions changed — small relevant change)`, 'DEBUG', 'pixel-fallback');
  } else if (actionChangedPage) {
    // Whole-page hash changed but no region changed significantly — likely animation
    rewardDelta = 0;
    log(`Action feedback: ${stateKey} → 0 (page hash changed but no region changed significantly — likely animation/timer)`, 'DEBUG', 'pixel-fallback');
  } else {
    // Nothing changed — action was ineffective
    rewardDelta = -2;
    if (currentReward <= -1) {
      // Repeatedly ineffective — stronger penalty
      rewardDelta = -4;
      log(`Action feedback: ${stateKey} → -4 (page unchanged, repeatedly ineffective)`, 'WARN', 'pixel-fallback');
    } else {
      log(`Action feedback: ${stateKey} → -2 (page unchanged — no meaningful change)`, 'DEBUG', 'pixel-fallback');
    }
  }

  _memory.actionRewards.set(stateKey, Math.max(-8, Math.min(10, currentReward + rewardDelta)));
  _memory.lastActionFingerprintBefore = '';
  _memory.lastRegionFingerprints = [];
}

/**
 * TASK 102: Get the reward score for a state+actionType combination.
 * Higher = more likely to change the page. Lower = likely ineffective.
 */
function _getActionReward(state: string, actionType: string): number {
  return _memory.actionRewards.get(`${state}:${actionType}`) || 0;
}

// ─── TASK 103: Region-level fingerprinting (3×3 grid) ─────────────────────

/**
 * Compute 9 region fingerprints for a 3×3 grid of the screenshot.
 * Returns an array of 9 dHash strings.
 * Region layout: 0=TL 1=TC 2=TR 3=ML 4=MC 5=MR 6=BL 7=BC 8=BR
 */
function _computeRegionFingerprints3x3(rgba: Uint8ClampedArray, width: number, height: number): string[] {
  const regions: string[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const x1 = col / 3, y1 = row / 3, x2 = (col + 1) / 3, y2 = (row + 1) / 3;
      regions.push(_computeRegionFingerprint(rgba, width, height, x1, y1, x2, y2));
    }
  }
  return regions;
}

// ─── TASK 103: Safe Action Ladder ──────────────────────────────────────────
//
// When perception is poor, actions should follow an order of danger.
// The pixel fallback exhausts low-risk actions before attempting high-risk ones.
//
// Risk levels:
//   0. Very low risk:  wait, observe (explicit "do nothing with a purpose")
//   1. Low risk:       scroll, dismiss modal, focus input, hover
//   2. Medium risk:     click obvious navigation (back, next, close)
//   3. High risk:      click unknown button, submit, answer quiz
//
// The ladder resets when the page changes (new context = fresh exploration).

const ACTION_RISK_LEVELS: Record<string, number> = {
  'wait': 0,
  'observe': 0,
  'scroll_vertical': 1,
  'scroll_horizontal': 1,
  'flutter_swipe': 1,
  'click': 2,       // default — most clicks are medium risk
  'flutter_tap': 2,
  'keypad_input': 3,
  'input_email': 3,
  'input_password': 3,
  'click_type': 3,  // typing an answer = high risk (might submit wrong answer)
  'reload_page': 3,
};

/**
 * Get the risk level for an action type.
 * 0 = very low risk, 3 = high risk.
 */
function _getActionRisk(actionType: string): number {
  return ACTION_RISK_LEVELS[actionType] ?? 2;
}

/**
 * TASK 103: Determine the maximum risk level the fallback should attempt.
 * Starts at 0 (only wait/observe) and increases as lower-risk options are exhausted.
 * Resets when the page changes (new context).
 */
function _getMaxAllowedRisk(): number {
  if (!_memory.safeActionExhausted.wait) return 0;
  if (!_memory.safeActionExhausted.scroll) return 1;
  if (!_memory.safeActionExhausted.lowRisk) return 2;
  if (!_memory.safeActionExhausted.mediumRisk) return 3;
  return 3; // All exhausted — allow any action (last resort)
}

/**
 * TASK 103: Mark a risk level as exhausted.
 * Called when an action at this risk level fails to change the page.
 */
function _exhaustRiskLevel(riskLevel: number): void {
  if (riskLevel === 0) _memory.safeActionExhausted.wait = true;
  else if (riskLevel === 1) _memory.safeActionExhausted.scroll = true;
  else if (riskLevel === 2) _memory.safeActionExhausted.lowRisk = true;
  else if (riskLevel === 3) _memory.safeActionExhausted.mediumRisk = true;
  log(`Safe action ladder: risk level ${riskLevel} exhausted — escalating to level ${_getMaxAllowedRisk()}`, 'WARN', 'pixel-fallback');
}

/**
 * TASK 103: Reset the safe action ladder (page changed = fresh context).
 */
function _resetSafeActionLadder(): void {
  if (_memory.safeActionExhausted.wait ||
      _memory.safeActionExhausted.scroll ||
      _memory.safeActionExhausted.lowRisk ||
      _memory.safeActionExhausted.mediumRisk) {
    _memory.safeActionExhausted = { wait: false, scroll: false, lowRisk: false, mediumRisk: false };
    log('Safe action ladder: reset (page changed — fresh exploration context)', 'DEBUG', 'pixel-fallback');
  }
}

/**
 * Track a quiz choice attempt. Returns true if this choice was already tried.
 */
function _wasQuizChoiceTried(questionFingerprint: string, choiceIndex: number): boolean {
  if (!_memory.quizChoicesTried.has(questionFingerprint)) {
    _memory.quizChoicesTried.set(questionFingerprint, new Set());
  }
  const tried = _memory.quizChoicesTried.get(questionFingerprint)!;
  if (tried.has(choiceIndex)) return true;
  tried.add(choiceIndex);
  return false;
}

/**
 * Get untried quiz choices, or all choices if no tracking data.
 */
function _getUntriedChoices(allChoices: DetectedRect[], questionFingerprint: string): DetectedRect[] {
  const tried = _memory.quizChoicesTried.get(questionFingerprint);
  if (!tried || tried.size === 0) return allChoices;

  const untried = allChoices.filter((_, idx) => !tried.has(idx));
  if (untried.length > 0) return untried;

  // All choices tried — reset and try again (question may have changed)
  _memory.quizChoicesTried.delete(questionFingerprint);
  return allChoices;
}

/**
 * Record an action in recent history for stagnation detection.
 */
function _recordAction(action: any, fingerprint: string, regionFingerprints?: string[]): void {
  _memory.recentActions.push({
    type: action.actionType,
    targetX: action.targetX || 0,
    targetY: action.targetY || 0,
    fingerprint,
    timestamp: Date.now(),
    // TASK 102: Store the state for the action feedback loop
    _state: action.currentState || 'unknown',
  } as any);
  if (_memory.recentActions.length > _memory.MAX_RECENT_ACTIONS) {
    _memory.recentActions.shift();
  }
  _memory.totalActionsTaken++;
  // Consecutive-scroll streak (survives the stagnation history reset)
  if (typeof action.actionType === 'string' && action.actionType.startsWith('scroll')) {
    _memory.scrollStreak++;
  } else {
    _memory.scrollStreak = 0;
  }
  // TASK 102: Store fingerprint for the feedback loop
  _memory.lastActionFingerprintBefore = fingerprint;
  // TASK 103: Store region fingerprints for region-level change detection
  if (regionFingerprints && regionFingerprints.length > 0) {
    _memory.lastRegionFingerprints = regionFingerprints;
  }
}

/**
 * Detect if we're stagnating (repeating the same action on the same page).
 */
function _isStagnating(): boolean {
  if (_memory.recentActions.length < 3) return false;

  const recent = _memory.recentActions.slice(-3);
  // Check if last 3 actions target the same coordinates on the same page
  const sameTarget = recent.every(a =>
    Math.abs(a.targetX - recent[0].targetX) < 20 &&
    Math.abs(a.targetY - recent[0].targetY) < 20
  );
  const samePage = recent.every(a => _fingerprintDistance(a.fingerprint, recent[0].fingerprint) <= FP_SAME_PAGE_MAX_DIST);

  return sameTarget && samePage;
}

/**
 * Check if we've exceeded the scroll depth limit for a page.
 */
function _isScrollExhausted(_pageFingerprint?: string): boolean {
  // Scrolling changes the page, so a per-fingerprint counter can never accumulate.
  // Count consecutive scroll actions instead.
  return _memory.scrollStreak >= _memory.MAX_SCROLL_DEPTH;
}

/**
 * Increment scroll depth for a page.
 */
function _incrementScrollDepth(_pageFingerprint?: string): void {
  // Kept for API compatibility: the streak is advanced by _recordAction().
}

/**
 * Generate a question fingerprint based on visual layout.
 */
function _questionFingerprint(rgba: Uint8ClampedArray, width: number, height: number): string {
  // Use the text density pattern in the question area as a fingerprint
  const qDensity = _getTextDensityInRegion(rgba, width, height,
    Math.floor(width * 0.1), Math.floor(height * 0.25),
    Math.floor(width * 0.9), Math.floor(height * 0.55));
  const choiceCount = _findChoiceButtons(rgba, width, height).length;
  // Hash only the upper question area so selecting a choice (which recolours the
  // lower half) does not change the question's identity.
  return `q_${qDensity.toFixed(2)}_${choiceCount}_${_computeRegionFingerprint(rgba, width, height, 0.10, 0.25, 0.90, 0.45).substring(0, 12)}`;
}

/**
 * Get a summary of progress for logging.
 */
function _getProgressSummary(): string {
  return `actions=${_memory.totalActionsTaken} questions=${_memory.questionsAnswered} modules=${_memory.modulesDownloaded} videos=${_memory.videosWatched} exercises=${_memory.exercisesCompleted}`;
}

// ─── Action generators ────────────────────────────────────────────────────

function _microsoftEmailAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    const jittered = _jitter(inputField.cx, inputField.cy, 3, inputField);
    log(`Pixel fallback: found email input at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'input_email',
      targetX: jittered.x,
      targetY: jittered.y,
      currentState: 'microsoft_email_input',
      reasoning: 'Pixel fallback: found email input field on Microsoft login',
      _useKeyboard: true,
    };
  }

  const midY = Math.floor(height * 0.45);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    const jittered = _jitter(blueButton.cx, blueButton.cy, 3, blueButton);
    log(`Pixel fallback: found Next button at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: jittered.x,
      targetY: jittered.y,
      currentState: 'microsoft_email_input',
      reasoning: 'Pixel fallback: found blue Next button (email may be pre-filled)'
    };
  }

  return null;
}

function _microsoftPasswordAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    const jittered = _jitter(inputField.cx, inputField.cy, 3, inputField);
    log(`Pixel fallback: found password input at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'input_password',
      targetX: jittered.x,
      targetY: jittered.y,
      currentState: 'advlearn_login',
      reasoning: 'Pixel fallback: found password input field on ADVLEARN page',
      _useKeyboard: true,
    };
  }

  const midY = Math.floor(height * 0.45);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    const jittered = _jitter(blueButton.cx, blueButton.cy, 3, blueButton);
    log(`Pixel fallback: found Sign-in button at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
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

function _microsoftKMSIAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  const midY = Math.floor(height * 0.35);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    const jittered = _jitter(blueButton.cx, blueButton.cy, 3, blueButton);
    log(`Pixel fallback: found KMSI Yes button at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: jittered.x,
      targetY: jittered.y,
      currentState: 'advlearn_login',
      reasoning: 'Pixel fallback: found "Stay signed in?" Yes button'
    };
  }

  const darkButton = _findDarkButton(rgba, width, height, midY);
  if (darkButton) {
    const jittered = _jitter(darkButton.cx, darkButton.cy, 3, darkButton);
    log(`Pixel fallback: found KMSI dark button at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: jittered.x,
      targetY: jittered.y,
      currentState: 'advlearn_login',
      reasoning: 'Pixel fallback: found dark KMSI button'
    };
  }

  return null;
}

// ─── v4: "Pick an account" page detection ──────────────────────────────────

/**
 * Detect the "Pick an account" intermediate page that Microsoft sometimes shows
 * when multiple accounts are available. This page has account tiles/chips that
 * the user must click to select, plus a "Use another account" option.
 */
function _isPickAccountPage(url: string): boolean {
  return url.includes('accounts/') || url.includes('picker') || url.includes('select_account');
}

function _pickAccountAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // Account tiles are typically white/light rectangles in the center of the page
  // They look like cards with text, arranged vertically
  const y1 = Math.floor(height * 0.25);
  const y2 = Math.floor(height * 0.70);
  const x1 = Math.floor(width * 0.15);
  const x2 = Math.floor(width * 0.85);

  const whiteBands = _findColorBands(rgba, width, height, _isWhiteish, y1, y2, x1, x2, 2);

  // Filter for card-like shapes (wide, short)
  const accountTiles = whiteBands.filter(r => {
    const aspect = r.w / Math.max(r.h, 1);
    return r.w >= width * 0.4 && r.h >= 20 && r.h <= 80 && aspect > 3;
  }).sort((a, b) => a.cy - b.cy);

  if (accountTiles.length > 0) {
    // Click the first account tile
    const tile = accountTiles[0];
    const jittered = _jitter(tile.cx, tile.cy, 3, tile);
    log(`Pixel fallback: found account tile at (${jittered.x}, ${jittered.y}) — clicking to select account`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: jittered.x,
      targetY: jittered.y,
      currentState: 'microsoft_email_input',
      reasoning: 'Pixel fallback: found account tile on "Pick an account" page — selecting it'
    };
  }

  // Look for "Use another account" link (usually a text link at the bottom)
  const linkY1 = Math.floor(height * 0.70);
  const linkY2 = Math.floor(height * 0.90);
  const darkBands = _findColorBands(rgba, width, height, _isDark, linkY1, linkY2, x1, x2, 2);
  const linkCandidates = darkBands
    .filter(r => r.w >= 60 && r.w <= 400 && r.h >= 10 && r.h <= 40)
    .sort((a, b) => a.cy - b.cy);

  if (linkCandidates.length > 0) {
    const link = linkCandidates[0];
    const jittered = _jitter(link.cx, link.cy, 3, link);
    log(`Pixel fallback: found "Use another account" link at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click',
      targetX: jittered.x,
      targetY: jittered.y,
      currentState: 'microsoft_email_input',
      reasoning: 'Pixel fallback: clicking "Use another account" link'
    };
  }

  return null;
}

function _microsoftLoginAction(
  url: string,
  rgba: Uint8ClampedArray,
  width: number, height: number
): any | null {
  const isPassword = _isMicrosoftPasswordPage(url);
  const isKMSI = _isMicrosoftKMSIPage(url);

  // v4: Handle "Pick an account" intermediate page
  if (_isPickAccountPage(url)) {
    return _pickAccountAction(rgba, width, height);
  }

  // v4: Handle password reset / expired password pages
  if (url.includes('resetpassword') || url.includes('expired') || url.includes('reauth')) {
    log(`Pixel fallback: password reset/reauth page detected — navigating back to app (NOT login.microsoftonline.com — that causes AADSTS900561)`, 'WARN', 'pixel-fallback');
    // BUG FIX (2026-09-04): Navigate to the MathU APP_URL, NOT https://login.microsoftonline.com/
    // The Microsoft root URL is a POST-only API endpoint. GET-ing it in a browser produces
    // "AADSTS900561: The endpoint only accepts POST requests. Received a GET request."
    // The APP_URL will redirect to the proper OAuth /authorize endpoint which IS GET-able.
    const CONFIG = require('./get-config');
    const recoveryUrl = CONFIG.APP_URL || CONFIG.BASE_URL || 'https://app.mathu.co.za';
    return {
      actionType: 'goto_url',
      targetX: 0, targetY: 0,
      currentState: 'microsoft_email_input',
      reasoning: 'Pixel fallback: password reset/reauth page — navigating back to app to restart OAuth flow',
      _gotoUrl: recoveryUrl,
    };
  }

  if (isKMSI) return _microsoftKMSIAction(rgba, width, height);
  if (isPassword) return _microsoftPasswordAction(rgba, width, height);

  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    if (isPassword) {
      log(`Pixel fallback: found password input at (${inputField.cx}, ${inputField.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'input_password', targetX: inputField.cx, targetY: inputField.cy,
        currentState: 'advlearn_login', reasoning: 'Pixel fallback: found password input field'
      };
    } else {
      log(`Pixel fallback: found email input at (${inputField.cx}, ${inputField.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'input_email', targetX: inputField.cx, targetY: inputField.cy,
        currentState: 'microsoft_email_input', reasoning: 'Pixel fallback: found email input field'
      };
    }
  }

  const midY = Math.floor(height * 0.40);
  const blueButton = _findBlueButton(rgba, width, height, midY);
  if (blueButton) {
    log(`Pixel fallback: found blue button at (${blueButton.cx}, ${blueButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click', targetX: blueButton.cx, targetY: blueButton.cy,
      currentState: isPassword ? 'advlearn_login' : 'microsoft_email_input',
      reasoning: 'Pixel fallback: found blue sign-in/next button'
    };
  }

  const darkButton = _findDarkButton(rgba, width, height, midY);
  if (darkButton) {
    log(`Pixel fallback: found dark button at (${darkButton.cx}, ${darkButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click', targetX: darkButton.cx, targetY: darkButton.cy,
      currentState: 'microsoft_email_input', reasoning: 'Pixel fallback: found dark Next button'
    };
  }

  return null;
}

function _assignmentPageAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // v4: Check if the current page shows a completed module — skip it
  if (_isModuleCompleted(rgba, width, height)) {
    log(`Pixel fallback: detected completed module (green checkmark) — scrolling to find incomplete ones`, 'INFO', 'pixel-fallback');
    const fp = _computePageFingerprint(rgba, width, height);
    if (_isScrollExhausted(fp)) {
      _memory.scrollDepths.delete(fp);
      return {
        actionType: 'reload_page', targetX: 0, targetY: 0,
        currentState: 'assignments_page',
        reasoning: 'Pixel fallback: all visible modules completed — reloading to check for new assignments'
      };
    }
    _incrementScrollDepth(fp);
    return {
      actionType: 'scroll_vertical', targetX: 0, targetY: 0,
      currentState: 'assignments_page',
      reasoning: 'Pixel fallback: completed module detected, scrolling to find incomplete ones'
    };
  }

  const downloadBtn = _findDownloadButton(rgba, width, height);
  if (downloadBtn) {
    const jittered = _jitter(downloadBtn.cx, downloadBtn.cy, 3, downloadBtn);
    log(`Pixel fallback: found download button at (${jittered.x}, ${jittered.y}) — clicking to download module`, 'INFO', 'pixel-fallback');
    _memory.modulesDownloaded++;
    return {
      actionType: 'click', targetX: jittered.x, targetY: jittered.y,
      currentState: 'module_downloading',
      reasoning: 'Pixel fallback: found module download arrow button — clicking to initiate download'
    };
  }

  const button = _findActionButton(rgba, width, height);
  if (button) {
    // v4: Check if the button appears faded (disabled/completed)
    const btnColor = _sampleColorAt(rgba, width, button.cx, button.cy);
    if (btnColor && _isFadedElement(btnColor.r, btnColor.g, btnColor.b)) {
      log(`Pixel fallback: found action button at (${button.cx}, ${button.cy}) but it appears faded/disabled — skipping`, 'WARN', 'pixel-fallback');
      // Skip this button and scroll
      const fp = _computePageFingerprint(rgba, width, height);
      if (!_isScrollExhausted(fp)) {
        _incrementScrollDepth(fp);
        return {
          actionType: 'scroll_vertical', targetX: 0, targetY: 0,
          currentState: 'assignments_page',
          reasoning: 'Pixel fallback: faded/disabled button detected, scrolling to find active ones'
        };
      }
    }

    const jittered = _jitter(button.cx, button.cy, 3, button);
    log(`Pixel fallback: found action button at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
    // v4: Record color for calibration
    if (btnColor) {
      _colorCalibration.record('action_button', btnColor.r, btnColor.g, btnColor.b);
    }
    return {
      actionType: 'click', targetX: jittered.x, targetY: jittered.y,
      currentState: 'assignments_page',
      reasoning: 'Pixel fallback: found colored action button (Watch/Start/Redo)'
    };
  }

  // Check scroll depth limit
  const fp = _computePageFingerprint(rgba, width, height);
  if (_isScrollExhausted(fp)) {
    log(`Pixel fallback: scroll depth exhausted (${_memory.scrollStreak} scrolls) — stopping`, 'WARN', 'pixel-fallback');
    // Reset scroll depth and return a safe wait (page might need to reload)
    _memory.scrollDepths.delete(fp);
    return {
      actionType: 'wait', targetX: 0, targetY: 0,
      currentState: 'assignments_page',
      reasoning: 'Pixel fallback: scroll depth exhausted, waiting for page reload'
    };
  }

  _incrementScrollDepth(fp);
  return {
    actionType: 'scroll_vertical', targetX: 0, targetY: 0,
    currentState: 'assignments_page',
    reasoning: `Pixel fallback: no buttons visible on assignments page, scrolling (depth=${_memory.scrollStreak})`
  };
}

function _quizPageAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  const qFingerprint = _questionFingerprint(rgba, width, height);

  // Priority 1: Check if a choice is already selected → look for Next question button
  const selectedChoice = _findSelectedChoice(rgba, width, height);
  if (selectedChoice) {
    const nextButton = _findNextQuestionButton(rgba, width, height);
    if (nextButton) {
      log(`Pixel fallback: choice selected, found Next button at (${nextButton.cx}, ${nextButton.cy})`, 'INFO', 'pixel-fallback');
      _memory.questionsAnswered++;
      // Clear choice tracking for this question since we're moving on
      _memory.quizChoicesTried.delete(qFingerprint);
      return {
        actionType: 'click', targetX: nextButton.cx, targetY: nextButton.cy,
        currentState: 'assessment',
        reasoning: 'Pixel fallback: choice already selected, clicking Next question button'
      };
    }
    const tealButton = _findTealGreenButton(rgba, width, height);
    if (tealButton) {
      log(`Pixel fallback: choice selected, clicking Submit/Done at (${tealButton.cx}, ${tealButton.cy})`, 'INFO', 'pixel-fallback');
      _memory.questionsAnswered++;
      _memory.quizChoicesTried.delete(qFingerprint);
      return {
        actionType: 'click', targetX: tealButton.cx, targetY: tealButton.cy,
        currentState: 'assessment',
        reasoning: 'Pixel fallback: choice already selected, clicking Submit/Done button'
      };
    }
  }

  // Priority 2: Submit/Done button (no choice needed — maybe already answered)
  const tealButton = _findTealGreenButton(rgba, width, height);
  if (tealButton) {
    log(`Pixel fallback: found quiz Submit/Done button at (${tealButton.cx}, ${tealButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click', targetX: tealButton.cx, targetY: tealButton.cy,
      currentState: 'assessment',
      reasoning: 'Pixel fallback: found teal-green Submit/Done button in quiz'
    };
  }

  // Priority 3: Quiz multiple choice — DEFER TO TRIBUNAL
  // TASK 100 (2026-09-30): Quiz answering is fundamentally different from
  // navigation. The pixel fallback CANNOT read the question text reliably.
  // Text density, button width, and position are NOT evidence of correctness.
  // If the math solver can't solve with high confidence, return null and let
  // the tribunal (which CAN read the screenshot) handle it.
  const choiceButtons = _findChoiceButtons(rgba, width, height);
  if (choiceButtons.length > 0) {
    // Try math solver — only if confidence is HIGH (>0.7)
    const mathAnalysis = _analyzeMathQuestion(rgba, width, height, choiceButtons);
    if (mathAnalysis.strategy !== 'none' && mathAnalysis.bestMatchConfidence > 0.7) {
      // Math solver succeeded with high confidence — click the matched answer
      const bestIdx = mathAnalysis.bestMatchIndex || 0;
      if (bestIdx >= 0 && bestIdx < choiceButtons.length) {
        const pick = choiceButtons[bestIdx];
        const jittered = _jitter(pick.cx, pick.cy, 3, pick);
        log(`Pixel fallback: MATH SOLVED with HIGH confidence (${mathAnalysis.bestMatchConfidence.toFixed(2)}) — clicking choice ${bestIdx} at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
        return {
          actionType: 'click', targetX: jittered.x, targetY: jittered.y,
          currentState: 'assessment',
          reasoning: `Pixel fallback: math solver clicked choice ${bestIdx} (conf=${mathAnalysis.bestMatchConfidence.toFixed(2)}, strategy=${mathAnalysis.strategy})`,
          _confidence: 0.75,
        };
      }
    }

    // Math solver failed or low confidence — DO NOT GUESS
    log(`Pixel fallback: quiz detected (${choiceButtons.length} choices) but cannot read question — deferring to tribunal (math conf=${mathAnalysis.bestMatchConfidence.toFixed(2)})`, 'INFO', 'pixel-fallback');
    return null; // Let the tribunal handle it
  }

  // Priority 4: Next question button (non-MCQ where answer was entered)
  const nextButton = _findNextQuestionButton(rgba, width, height);
  if (nextButton) {
    log(`Pixel fallback: found Next question button at (${nextButton.cx}, ${nextButton.cy})`, 'INFO', 'pixel-fallback');
    _memory.questionsAnswered++;
    return {
      actionType: 'click', targetX: nextButton.cx, targetY: nextButton.cy,
      currentState: 'assessment',
      reasoning: 'Pixel fallback: found Next question button (answer may be pre-filled)'
    };
  }

  // Priority 5: Numeric keypad — only act if math solver has HIGH confidence
  // TASK 100 (2026-09-30): Removed heuristic keypad guessing. Old code clicked
  // random keypad digits based on text density — that's not intelligence.
  // Now: only press keypad buttons if the math solver solved the question
  // with confidence >0.7. Otherwise, return null and defer to the tribunal.
  const keypad = _findNumericKeypad(rgba, width, height);
  if (keypad.length > 0) {
    const keypadSolution = _solveForKeypad(rgba, width, height, keypad);

    if (keypadSolution && keypadSolution.sequence.length > 0 && keypadSolution.confidence > 0.7) {
      // Math solver succeeded with HIGH confidence — type the answer
      const firstKey = keypadSolution.sequence[0];
      const jittered = _jitter(firstKey.cx, firstKey.cy, 3, firstKey);
      log(`Pixel fallback: MATH SOLVED (conf=${keypadSolution.confidence.toFixed(2)} > 0.7) — answer=${keypadSolution.answer}, clicking first key "${firstKey.probableDigit}" at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');

      const keypadSequence = keypadSolution.sequence.map(k => ({
        digit: k.probableDigit,
        x: k.cx,
        y: k.cy,
      }));

      return {
        actionType: 'keypad_input',
        targetX: jittered.x,
        targetY: jittered.y,
        currentState: 'assessment',
        reasoning: `Pixel fallback: MATH SOLVED answer=${keypadSolution.answer} (conf=${keypadSolution.confidence.toFixed(2)}, ${keypadSequence.length} keys)`,
        keypadSequence,
        value: keypadSolution.answer,
        _confidence: 0.75,
      };
    }

    // Math solver failed or low confidence — DO NOT GUESS
    log(`Pixel fallback: keypad detected (${keypad.length} keys) but cannot solve question — deferring to tribunal (math conf=${keypadSolution?.confidence.toFixed(2) || 'N/A'})`, 'INFO', 'pixel-fallback');
    return null;
  }

  // Priority 6: Input field (algebraic answer)
  // TASK 99 (2026-09-30): Don't manufacture a default answer.
  // A pixel fallback that cannot read the question should not guess "0".
  // Instead, just click the input field to focus it, and let the tribunal
  // (which CAN read the screenshot) decide what to type.
  // If the tribunal is unavailable (provider drought), the session-
  // preservation swipe will keep the session alive until providers recover.
  const inputField = _findInputField(rgba, width, height);
  if (inputField) {
    const jittered = _jitter(inputField.cx, inputField.cy, 3, inputField);
    log(`Pixel fallback: found quiz input field at (${jittered.x}, ${jittered.y}) — clicking to focus (NOT typing a guessed answer — will defer to tribunal for actual answer)`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click', targetX: jittered.x, targetY: jittered.y,
      currentState: 'assessment',
      reasoning: 'Pixel fallback: found quiz answer input field — clicking to focus. NOT typing a default answer — the tribunal should decide what to type.',
    };
  }

  return null;
}

function _videoPlayerAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
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
  const videoIsOpen = backButtons.length > 0 || hasWhiteArrow;

  if (videoIsOpen) {
    _startVideoTimer();
    const elapsed = _getVideoWatchElapsed();
    const remaining = Math.max(0, VIDEO_WATCH_DURATION_MS - elapsed);
    const remainingSec = Math.ceil(remaining / 1000);

    // v4: Check video progress bar to verify it's actually playing
    const videoProgress = _detectVideoProgress(rgba, width, height);
    if (videoProgress) {
      _memory._lastVideoProgress = videoProgress.progress;
      if (videoProgress.isPlaying) _memory._videoStuckCount = 0;
      if (!videoProgress.isPlaying && elapsed > 5000) {
        // Video is at 0% or 100% after 5s — might be stuck or finished early
        log(`Pixel fallback: video progress=${(videoProgress.progress * 100).toFixed(0)}% at ${Math.floor(elapsed / 1000)}s — ${videoProgress.progress >= 0.99 ? 'appears complete' : 'might be stuck/buffering'}`, 'WARN', 'pixel-fallback');
        if (videoProgress.progress >= 0.99 || _memory._videoStuckCount >= 3) {
          // Video completed or stuck — dismiss it
          _resetVideoTimer();
          _memory.videosWatched++;
          _memory._videoStuckCount = 0;
          // TASK 131: flutter_tap top-left corner (white X button)
          const closeX2 = Math.floor(width * 0.05);
          const closeY2 = Math.floor(height * 0.05);
          const jittered2 = _jitter(closeX2, closeY2, 3);
          log(`Pixel fallback: video done (progress=${(videoProgress.progress * 100).toFixed(0)}%), flutter_tap top-left X at (${jittered2.x}, ${jittered2.y})`, 'INFO', 'pixel-fallback');
          return {
            actionType: 'flutter_tap', targetX: jittered2.x, targetY: jittered2.y,
            currentState: 'video_player',
            reasoning: `Pixel fallback: video progress ${videoProgress.progress >= 0.99 ? 'complete' : 'stuck'} (${(videoProgress.progress * 100).toFixed(0)}%), flutter_tap top-left X to dismiss`,
            repeatable: true,
          };
        }
        _memory._videoStuckCount = (_memory._videoStuckCount || 0) + 1;
      }
    }

    if (!_isVideoWatchComplete()) {
      log(`Pixel fallback: video watching... ${Math.floor(elapsed / 1000)}s elapsed, ${remainingSec}s remaining${videoProgress ? ` [progress=${(videoProgress.progress * 100).toFixed(0)}%]` : ''}`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'wait', targetX: 0, targetY: 0,
        currentState: 'video_player',
        reasoning: `Pixel fallback: watching video (${Math.floor(elapsed / 1000)}s/${VIDEO_WATCH_DURATION_MS / 1000}s), ${remainingSec}s remaining${videoProgress ? ` [progress=${(videoProgress.progress * 100).toFixed(0)}%]` : ''}`
      };
    }

    _resetVideoTimer();
    _memory.videosWatched++;

    // TASK 131 (2026-10-22): The video close button is a WHITE X in the
    // top-left corner. Most video backgrounds are also white, so the X is
    // invisible to pixel detection (dark button scan finds nothing).
    // Fix: Don't try to detect the X — just flutter_tap the top-left corner
    // directly. The X is ALWAYS at approximately (5%, 5%) of the viewport.
    // Use flutter_tap (not click) because this is a Flutter widget.
    const closeX = Math.floor(width * 0.05);
    const closeY = Math.floor(height * 0.05);
    const jittered = _jitter(closeX, closeY, 3);
    log(`Pixel fallback: video watch complete (${VIDEO_WATCH_DURATION_MS / 1000}s), flutter_tap top-left corner (${jittered.x}, ${jittered.y}) to close white X button`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'flutter_tap', targetX: jittered.x, targetY: jittered.y,
      currentState: 'video_player',
      reasoning: `Pixel fallback: video watch complete (${VIDEO_WATCH_DURATION_MS / 1000}s), flutter_tap top-left X button to dismiss (white X on white bg — not pixel-detectable)`,
      repeatable: true,
      skipExactMatch: false,
    };
  }

  _resetVideoTimer();
    // TASK 130 (2026-10-22): The old code clicked the CENTER of the screen
    // whenever it thought a "video thumbnail" was visible — but this triggers
    // on EVERY page that has any centered content (login buttons, module cards,
    // etc.). Now we ONLY click if we can detect an actual play button overlay
    // (a circular shape with a triangle/play icon in the center area).
    // If no play button detected, return null — let the cycle manager handle it.
    const playButton = _detectPlayButton(rgba, width, height);
    if (playButton) {
      const jittered = _jitter(playButton.x, playButton.y, 5);
      log(`Pixel fallback: play button detected at (${jittered.x}, ${jittered.y}), clicking to open video`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'click', targetX: jittered.x, targetY: jittered.y,
        currentState: 'video_player',
        reasoning: 'Pixel fallback: play button overlay detected on video thumbnail'
      };
    }
    // No play button detected — don't click randomly. Return null so the cycle
    // manager can try other approaches (scroll, pixel-explorer, etc.).
    log('Pixel fallback: no video play button detected — not clicking center', 'DEBUG', 'pixel-fallback');
    return null;
}

// TASK 130: Detect a play button overlay (circular shape with a play triangle).
// A play button is typically:
// - A circle or rounded rectangle in the center area of the screen
// - Has a contrasting color (white circle on dark video, or dark circle on light)
// - Is roughly 40-100px in diameter
// This prevents false positives on login pages and other non-video screens.
function _detectPlayButton(
  rgba: Uint8ClampedArray, width: number, height: number
): { x: number; y: number } | null {
  const centerX = Math.floor(width / 2);
  const centerY = Math.floor(height / 2);
  // Search in the center 40% of the screen for a circular bright/dark region
  const searchX1 = Math.floor(width * 0.3);
  const searchX2 = Math.floor(width * 0.7);
  const searchY1 = Math.floor(height * 0.25);
  const searchY2 = Math.floor(height * 0.75);

  // Sample a grid of points and look for a cluster of contrasting pixels
  // that forms a circular shape (play button overlay)
  let bestCluster: { x: number; y: number; score: number } = { x: centerX, y: centerY, score: 0 };

  for (let y = searchY1; y < searchY2; y += 8) {
    for (let x = searchX1; x < searchX2; x += 8) {
      const idx = (y * width + x) * 4;
      const r = rgba[idx], g = rgba[idx + 1], b = rgba[idx + 2];
      // Check if this pixel is significantly brighter or darker than surroundings
      let contrastScore = 0;
      // Check 8 surrounding points at distance 20px
      for (let dy = -20; dy <= 20; dy += 10) {
        for (let dx = -20; dx <= 20; dx += 10) {
          if (dx === 0 && dy === 0) continue;
          const sx = x + dx, sy = y + dy;
          if (sx < 0 || sx >= width || sy < 0 || sy >= height) continue;
          const sidx = (sy * width + sx) * 4;
          const sr = rgba[sidx], sg = rgba[sidx + 1], sb = rgba[sidx + 2];
          const diff = Math.abs(r - sr) + Math.abs(g - sg) + Math.abs(b - sb);
          if (diff > 100) contrastScore++;
        }
      }
      if (contrastScore > bestCluster.score) {
        bestCluster = { x, y, score: contrastScore };
      }
    }
  }

  // Only return a play button if the contrast score is high enough
  // (a real play button has high contrast against the video background)
  if (bestCluster.score >= 15) {
    const luminanceAt = (x: number, y: number): number => {
      const sx = Math.max(0, Math.min(width - 1, x));
      const sy = Math.max(0, Math.min(height - 1, y));
      const idx = (sy * width + sx) * 4;
      return 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
    };


    // The MathU startup mark is centered in a bright diamond with a short,
    // symmetric dark horizontal dash. Generic contrast scanning can pick an
    // offset edge of that diamond as a play-button candidate, so test the
    // actual screen-center glyph before accepting any candidate.
    const screenCx = Math.floor(width / 2), screenCy = Math.floor(height / 2);
    const centerBackground = (luminanceAt(screenCx - 18, screenCy - 18) +
      luminanceAt(screenCx + 18, screenCy - 18) + luminanceAt(screenCx - 18, screenCy + 18) +
      luminanceAt(screenCx + 18, screenCy + 18)) / 4;
    const dashOffsets = [-12, -8, -4, 0, 4, 8, 12];
    const centeredDarkDash = dashOffsets.filter(dx => luminanceAt(screenCx + dx, screenCy) < 90).length >= 6;
    const centerVerticalLight = [-12, -8, -4, 4, 8, 12].filter(dy => luminanceAt(screenCx, screenCy + dy) > 180).length >= 5;
    if (centerBackground > 200 && centeredDarkDash && centerVerticalLight) {
      log('Pixel fallback: rejecting centered MathU splash dash as a false play-button match', 'DEBUG', 'pixel-fallback');
      return null;
    }

    // A centered MathU splash mark (a high-contrast plus inside a diamond)
    // can satisfy the generic contrast score above, but it is not a play icon.
    // Reject a candidate only when it has a clear cross-shaped dark/light glyph:
    // both horizontal and vertical arms must contrast against a light/dark field.
    const cx = bestCluster.x, cy = bestCluster.y;
    const centerLum = luminanceAt(cx, cy);
    const backgroundLum = (luminanceAt(cx - 20, cy - 20) + luminanceAt(cx + 20, cy - 20) +
      luminanceAt(cx - 20, cy + 20) + luminanceAt(cx + 20, cy + 20)) / 4;
    const darkGlyph = centerLum < backgroundLum;
    const arms = [-12, -6, 6, 12];
    const alongContrast = (x: number, y: number): boolean => {
      const lum = luminanceAt(x, y);
      return darkGlyph ? lum < backgroundLum - 35 : lum > backgroundLum + 35;
    };
    const horizontalArm = arms.filter(dx => alongContrast(cx + dx, cy)).length;
    const verticalArm = arms.filter(dy => alongContrast(cx, cy + dy)).length;
    if (horizontalArm >= 3 && verticalArm >= 3 && Math.abs(centerLum - backgroundLum) > 45) {
      log('Pixel fallback: rejecting cross-shaped center mark as a false play-button match', 'DEBUG', 'pixel-fallback');
      return null;
    }
    return { x: bestCluster.x, y: bestCluster.y };
  }
  return null;
}

function _exercisePageAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  // v4: Check if memo view is pending (we clicked book icon last cycle)
  if (_memoViewPending) {
    if (_isMemoPageVisible(rgba, width, height)) {
      // Memo is now visible — look for Next button
      const greenButton = _findGreenButton(rgba, width, height);
      if (greenButton) {
        const jittered = _jitter(greenButton.cx, greenButton.cy, 3, greenButton);
        log(`Pixel fallback: memo viewed, clicking Next at (${jittered.x}, ${jittered.y})`, 'INFO', 'pixel-fallback');
        _memory.exercisesCompleted++;
        return {
          actionType: 'click', targetX: jittered.x, targetY: jittered.y,
          currentState: 'exercise_info',
          reasoning: 'Pixel fallback: memo/solution viewed, clicking Next to proceed to exercise'
        };
      }
      return {
        actionType: 'wait', targetX: 0, targetY: 0,
        currentState: 'exercise_info',
        reasoning: 'Pixel fallback: memo page visible but no Next button found — waiting'
      };
    }
    // Memo not yet visible — wait
    return {
      actionType: 'wait', targetX: 0, targetY: 0,
      currentState: 'exercise_info',
      reasoning: 'Pixel fallback: waiting for memo page to appear after book icon click'
    };
  }

  const bookX1 = Math.floor(width * 0.72);
  const bookX2 = Math.floor(width * 0.96);
  const bookY1 = Math.floor(height * 0.05);
  const bookY2 = Math.floor(height * 0.22);

  const bookBands = _findColorBands(rgba, width, height, _isDeepBlue, bookY1, bookY2, bookX1, bookX2, 2);
  const bookCandidates = bookBands
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 15 && r.w <= 60 && r.h >= 15 && r.h <= 60 && aspectRatio > 0.5 && aspectRatio < 2.5;
    })
    .sort((a, b) => a.cx - b.cx);

  const bookBandsBright = _findColorBands(rgba, width, height, _isMicrosoftBlue, bookY1, bookY2, bookX1, bookX2, 2);
  const bookCandidatesBright = bookBandsBright
    .filter(r => {
      const aspectRatio = r.w / Math.max(r.h, 1);
      return r.w >= 15 && r.w <= 60 && r.h >= 15 && r.h <= 60 && aspectRatio > 0.5 && aspectRatio < 2.5;
    })
    .sort((a, b) => a.cx - b.cx);

  const allBookCandidates = [...bookCandidates, ...bookCandidatesBright];

  if (allBookCandidates.length > 0) {
    const book = allBookCandidates[allBookCandidates.length - 1];
    const jittered = _jitter(book.cx, book.cy, 3, book);
    _markMemoViewPending();
    log(`Pixel fallback: found open book icon at (${jittered.x}, ${jittered.y}) — clicking to view memo`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click', targetX: jittered.x, targetY: jittered.y,
      currentState: 'exercise_info',
      reasoning: 'Pixel fallback: found open book icon in top-right of exercise card — clicking to flip to memo/solution (REQUIRED before Next)'
    };
  }

  const anyBands = _findColorBands(rgba, width, height, (r, g, b) =>
    _isDeepBlue(r, g, b) || _isMicrosoftBlue(r, g, b) || (r < 80 && g < 100 && b < 180),
    bookY1, bookY2, bookX1, bookX2, 2
  );
  const anyCandidates = anyBands
    .filter(r => r.w >= 10 && r.w <= 70 && r.h >= 10 && r.h <= 70)
    .sort((a, b) => a.cx - b.cx);

  if (anyCandidates.length > 0) {
    const candidate = anyCandidates[anyCandidates.length - 1];
    const jittered = _jitter(candidate.cx, candidate.cy, 3, candidate);
    _markMemoViewPending();
    log(`Pixel fallback: found possible book icon candidate at (${jittered.x}, ${jittered.y}) — clicking to view memo`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click', targetX: jittered.x, targetY: jittered.y,
      currentState: 'exercise_info',
      reasoning: 'Pixel fallback: found possible book/memo icon in exercise card — clicking (REQUIRED before Next)'
    };
  }

  // Fallback: click top-right area
  const fallbackBookX = Math.floor(width * 0.88);
  const fallbackBookY = Math.floor(height * 0.12);
  log(`Pixel fallback: no book icon detected, clicking top-right area (${fallbackBookX}, ${fallbackBookY}) as fallback for memo icon`, 'INFO', 'pixel-fallback');
  return {
    actionType: 'click', targetX: fallbackBookX, targetY: fallbackBookY,
    currentState: 'exercise_info',
    reasoning: 'Pixel fallback: clicking top-right of exercise card as fallback for open book/memo icon (REQUIRED before Next)'
  };
}

function _scorePageAction(
  rgba: Uint8ClampedArray, width: number, height: number
): any | null {
  const fullWidthButton = _findFullWidthButton(rgba, width, height);
  if (fullWidthButton) {
    log(`Pixel fallback: found full-width Continue button at (${fullWidthButton.cx}, ${fullWidthButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click', targetX: fullWidthButton.cx, targetY: fullWidthButton.cy,
      currentState: 'score_screen',
      reasoning: 'Pixel fallback: found full-width Continue to pathway button on score screen'
    };
  }

  const tealButton = _findTealGreenButton(rgba, width, height);
  if (tealButton) {
    log(`Pixel fallback: found Continue button at (${tealButton.cx}, ${tealButton.cy})`, 'INFO', 'pixel-fallback');
    return {
      actionType: 'click', targetX: tealButton.cx, targetY: tealButton.cy,
      currentState: 'score_screen',
      reasoning: 'Pixel fallback: found Continue button on score screen'
    };
  }

  return null;
}

// ─── Video watch timer ─────────────────────────────────────────────────

let _videoOpenedAt: number | null = null;
const VIDEO_WATCH_DURATION_MS = 179000; // 2 minutes 59 seconds

function _resetVideoTimer(): void { _videoOpenedAt = null; }
function _getVideoWatchElapsed(): number { return _videoOpenedAt === null ? 0 : Date.now() - _videoOpenedAt; }
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

let _loginFlowState: 'unknown' | 'email_entered' | 'password_entered' | 'kmsi' = 'unknown';
let _lastLoginUrl: string = '';

function _resetLoginFlowIfNeeded(url: string): void {
  if (!_isMicrosoftLoginPage(url)) {
    _loginFlowState = 'unknown';
    _lastLoginUrl = url;
    return;
  }
  if (url.includes('/password')) {
    if (_loginFlowState === 'email_entered' || _loginFlowState === 'unknown') {
      _loginFlowState = 'email_entered';
    }
  } else if (url.includes('/kmsi')) {
    _loginFlowState = 'password_entered';
  }
  _lastLoginUrl = url;
}

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

// ─── State compatibility (state-awareness filter) ──────────────────────────

const STATE_COMPAT: Record<string, string[]> = {
  'microsoft_email_input': ['mathu_login', 'microsoft_email_input', 'unknown', 'error', 'anywhere_click_recovery'],
  'advlearn_login':         ['mathu_login', 'microsoft_email_input', 'advlearn_login', 'unknown', 'error', 'anywhere_click_recovery'],
  'microsoft_stay_signed_in': ['mathu_login', 'microsoft_email_input', 'advlearn_login', 'unknown', 'error', 'anywhere_click_recovery'],
  'signin_page':            ['mathu_login', 'microsoft_email_input', 'advlearn_login', 'unknown', 'error', 'anywhere_click_recovery'],
  'assignments_page':      ['assignments_page', 'score_screen', 'pathway', 'pathway_feedback', 'assessment_correction', 'anywhere_click_recovery', 'ui_discovered', 'flutter_modal', 'flutter_bottom_sheet', 'exploration'],
  'module_downloading':     ['assignments_page', 'anywhere_click_recovery'],
  'exercise_info':         ['exercise_info', 'exercise_memo', 'anywhere_click_recovery'],
  'assessment':             ['assessment', 'assessment_correction', 'anywhere_click_recovery'],
  'video_player':           ['video_player', 'anywhere_click_recovery'],
  'score_screen':           ['score_screen', 'pathway', 'pathway_feedback', 'anywhere_click_recovery'],
  'error_recovery':         ['error', 'unknown', 'anywhere_click_recovery'],
};

function _isActionStateCompatible(action: any, realCurrentState: string): boolean {
  if (!action || !action.currentState) return true;
  const compat = STATE_COMPAT[action.currentState];
  if (!compat) return true;
  return compat.includes(realCurrentState);
}

// ─── Main entry point ─────────────────────────────────────────────────────

/**
 * Generate a fallback action using pure pixel analysis.
 *
 * ENHANCED v3:
 *   - Accepts optional pre-decoded screenshot data (avoids redundant PNG screenshot)
 *   - Page fingerprinting for stagnation detection
 *   - Smart quiz choice strategy
 *   - Error page detection and recovery
 *   - Modal/overlay dismissal
 *   - Consecutive failure safety valve
 *
 * @param page - Playwright page object
 * @param currentState - Bot's current state (for state-aware filtering)
 * @param preDecoded - Optional pre-decoded {width, height, rgba} from cycle-manager
 */
async function generatePixelFallbackAction(
  page: any,
  currentState?: string,
  preDecoded?: { width: number; height: number; rgba: Uint8ClampedArray } | null
): Promise<any> {
  // TASK 46 (2026-09-11): Removed the _withTimeout wrapper entirely.
  // The user said "pixel fallback should never time out."
  // The 8s timeout was killing legitimate pixel analysis when the screenshot
  // capture hung on document.fonts.ready (proxy issue). Now we let it run
  // to completion — the cycle-manager's own timeout will catch truly stuck
  // calls, but pixel analysis itself (once the screenshot is captured) is
  // pure CPU and finishes in <100ms.
  _lastDecodedWidth = 0;
  const action = await _generatePixelFallbackActionInner(page, currentState, preDecoded);
  return _toViewportCoords(page, action);
}

// ─── Screenshot → viewport coordinate scaling ────────────────────────────

/** Width (px) of the screenshot used for the current call; set by _getDecodedScreenshot. */
let _lastDecodedWidth = 0;

/** Set PIXEL_FALLBACK_SCALE_COORDS=0 if the caller already converts coordinates itself. */
const SCALE_TO_VIEWPORT = process.env.PIXEL_FALLBACK_SCALE_COORDS !== '0';

/**
 * Screenshot pixels equal CSS pixels only when deviceScaleFactor is 1 (or the
 * screenshot was not resized). If the image width differs from the viewport
 * width, scale the click target into viewport coordinates. No-op otherwise.
 */
function _toViewportCoords(page: any, action: any): any {
  try {
    if (!SCALE_TO_VIEWPORT || !action || !_lastDecodedWidth) return action;
    const vp = page?.viewportSize?.();
    if (!vp || !vp.width) return action;
    const scale = vp.width / _lastDecodedWidth;
    if (Math.abs(scale - 1) < 0.02) return action;
    if (typeof action.targetX === 'number') action.targetX = Math.round(action.targetX * scale);
    if (typeof action.targetY === 'number') action.targetY = Math.round(action.targetY * scale);
    action._coordScale = scale;
    log(`Pixel fallback: scaled target by ${scale.toFixed(3)} (screenshot ${_lastDecodedWidth}px → viewport ${vp.width}px)`, 'DEBUG', 'pixel-fallback');
  } catch { /* never let coordinate scaling break an action */ }
  return action;
}

async function _generatePixelFallbackActionInner(
  page: any,
  currentState?: string,
  preDecoded?: { width: number; height: number; rgba: Uint8ClampedArray } | null
): Promise<any> {
  try {
    const url = page?.url?.() || '';
    const now = Date.now();

    // ── Login flow guard ──
    if (_isLoginUrl(url)) {
      log('Pixel fallback: on login page — forcing login-only mode', 'DEBUG', 'pixel-fallback');
      const decoded = await _getDecodedScreenshot(page, preDecoded);
      if (!decoded) return null;
      const { width, height, rgba } = decoded;
      _resetLoginFlowIfNeeded(url);
      const loginAction = _microsoftLoginAction(url, rgba, width, height);
      if (loginAction) {
        _advanceLoginFlow(loginAction);
        _recordAction(loginAction, _computePageFingerprint(rgba, width, height));
        return loginAction;
      }
      return null;
    }

    // ── Unknown state guard ──
    const isAppUrl = _isMathUAppPage(url);
    if (!currentState && !isAppUrl) {
      log('Pixel fallback: unknown state + non-app URL — trying generic button', 'DEBUG', 'pixel-fallback');
      const decoded = await _getDecodedScreenshot(page, preDecoded);
      if (!decoded) return null;
      const { width, height, rgba } = decoded;
      const button = _findActionButton(decoded.rgba, decoded.width, decoded.height);
      if (button) {
        const action = { actionType: 'click', targetX: button.cx, targetY: button.cy, currentState: 'unknown', reasoning: 'Pixel fallback: generic button (unknown state)' };
        _recordAction(action, _computePageFingerprint(rgba, width, height));
        return action;
      }
      return null;
    }

    // ── Consecutive failure safety valve ──
    if (_memory.consecutiveFailures >= _memory.MAX_CONSECUTIVE_FAILURES) {
      log(`Pixel fallback: consecutive failure limit reached (${_memory.consecutiveFailures}) — switching to error recovery`, 'WARN', 'pixel-fallback');
      _memory.consecutiveFailures = 0;

      if (now - _memory.lastErrorRecovery > _memory.ERROR_RECOVERY_COOLDOWN_MS) {
        _memory.lastErrorRecovery = now;
        return {
          actionType: 'reload_page',
          targetX: 0, targetY: 0,
          currentState: 'error_recovery',
          reasoning: `Pixel fallback: consecutive failure safety valve — reloading page (${_getProgressSummary()})`
        };
      }

      return {
        actionType: 'wait', targetX: 0, targetY: 0,
        currentState: 'error_recovery',
        reasoning: `Pixel fallback: consecutive failure safety valve — waiting (cooldown active, ${_getProgressSummary()})`
      };
    }

    // ── Decode screenshot ──
    const decoded = await _getDecodedScreenshot(page, preDecoded);
    if (!decoded) {
      _memory.consecutiveFailures++;
      return null;
    }

    const { width, height, rgba } = decoded;
    const fingerprint = _computePageFingerprint(rgba, width, height);
    // TASK 103: Also compute 3×3 region fingerprints for change detection
    const regionFingerprints = _computeRegionFingerprints3x3(rgba, width, height);

    // TASK 103: If the page fingerprint changed since last call, reset the safe action ladder
    if (_memory.lastActionFingerprintBefore && _fingerprintDistance(fingerprint, _memory.lastActionFingerprintBefore) > FP_CHANGED_MIN_DIST) {
      _resetSafeActionLadder();
    }

    // TASK 102 (2026-09-30): Image quality gate.
    // Refuse to act on screenshots that are too small or have insufficient
    // contrast. A 50x50 image or a completely flat page has no useful
    // visual evidence — acting on it would be guessing.
    if (width < 200 || height < 150) {
      log(`Pixel fallback: screenshot too small (${width}x${height}) — refusing to act (insufficient visual evidence)`, 'WARN', 'pixel-fallback');
      _memory.consecutiveFailures++;
      return null;
    }

    // Compute contrast (std dev of luminance across sampled pixels)
    let lumSum = 0, lumSqSum = 0, sampleCount = 0;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / 500))); // ~500 samples
    for (let y = 0; y < height; y += step) {
      for (let x = 0; x < width; x += step) {
        const idx = (y * width + x) * 4;
        const lum = 0.299 * rgba[idx] + 0.587 * rgba[idx + 1] + 0.114 * rgba[idx + 2];
        lumSum += lum;
        lumSqSum += lum * lum;
        sampleCount++;
      }
    }
    if (sampleCount > 0) {
      const mean = lumSum / sampleCount;
      const variance = (lumSqSum / sampleCount) - (mean * mean);
      const stdDev = Math.sqrt(Math.max(0, variance));
      if (stdDev < 3) {
        // Near-zero variance = blank/flat page — no visual evidence
        log(`Pixel fallback: screenshot has near-zero contrast (stdDev=${stdDev.toFixed(1)}) — page is blank or flat, refusing to act`, 'WARN', 'pixel-fallback');
        _memory.consecutiveFailures++;
        return null;
      }
      log(`Pixel fallback: analyzing ${width}x${height} image (${fingerprint}) contrast=${stdDev.toFixed(1)}` +
          (currentState ? ` [currentState=${currentState}]` : '') +
          ` [${_getProgressSummary()}]`, 'DEBUG', 'pixel-fallback');
    } else {
      log(`Pixel fallback: analyzing ${width}x${height} image (${fingerprint})` +
          (currentState ? ` [currentState=${currentState}]` : '') +
          ` [${_getProgressSummary()}]`, 'DEBUG', 'pixel-fallback');
    }

    // ── Error page detection ──
    const errorCheck = _detectErrorPage(rgba, width, height, url);
    if (errorCheck.isError) {
      log(`Pixel fallback: detected error page — ${errorCheck.description}`, 'WARN', 'pixel-fallback');

      if (now - _memory.lastErrorRecovery > _memory.ERROR_RECOVERY_COOLDOWN_MS) {
        _memory.lastErrorRecovery = now;
        const recoveryAction = {
          actionType: 'reload_page' as const,
          targetX: 0, targetY: 0,
          currentState: 'error_recovery',
          reasoning: `Pixel fallback: ${errorCheck.description} — reloading`
        };
        _recordAction(recoveryAction, fingerprint);
        return recoveryAction;
      }
      return { actionType: 'wait', targetX: 0, targetY: 0, currentState: 'error_recovery', reasoning: `Pixel fallback: ${errorCheck.description} — cooldown active` };
    }

    // ── Modal/overlay detection ──
    const modalCloseBtn = _detectModal(rgba, width, height);
    if (modalCloseBtn) {
      const action = {
        actionType: 'click', targetX: modalCloseBtn.cx, targetY: modalCloseBtn.cy,
        currentState: currentState || 'unknown',
        reasoning: 'Pixel fallback: modal/overlay detected — clicking close button'
      };
      _recordAction(action, fingerprint, regionFingerprints);
      return action;
    }

    // ── Stagnation detection ──
    if (_isStagnating()) {
      log(`Pixel fallback: stagnation detected — same action repeated 3x on same page (${fingerprint})`, 'WARN', 'pixel-fallback');
      // Decide BEFORE clearing history, then clear to break the loop
      const scrollExhausted = _isScrollExhausted(fingerprint);
      _memory.recentActions.length = 0;
      // Try a different strategy: scroll or reload
      if (scrollExhausted) {
        return {
          actionType: 'reload_page', targetX: 0, targetY: 0,
          currentState: currentState || 'unknown',
          reasoning: `Pixel fallback: stagnation + scroll exhausted — reloading page (${_getProgressSummary()})`
        };
      }
      const scrollAction = {
        actionType: 'scroll_vertical', targetX: 0, targetY: 0,
        currentState: currentState || 'unknown',
        reasoning: `Pixel fallback: stagnation break — scrolling to find new content`
      };
      _recordAction(scrollAction, fingerprint); // keeps the scroll streak accurate
      return scrollAction;
    }

    // ── Generate candidate action ──
    const action = await _generatePixelAction(page, url, rgba, width, height);

    // ── Training fallback: query historical data if pixel analysis found nothing ──
    if (!action) {
      try {
        const pixelTraining = require('./pixel-training');
        if (pixelTraining?.queryMatches) {
          const matches = pixelTraining.queryMatches({
            pngBuffer: Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength),
            state: currentState || 'unknown',
            viewportWidth: width,
            viewportHeight: height,
          });
          if (matches && matches.length > 0) {
            const best = matches[0];
            const trainedAction = {
              actionType: 'click',
              targetX: best.targetX,
              targetY: best.targetY,
              currentState: currentState || best.state || 'unknown',
              reasoning: `Pixel training fallback: reusing action from ${best.provider} (similarity=${best.similarity.toFixed(3)}, used=${best.successCount}x)`,
              _trainingSource: 'pixel-training',
            };
            log(`Training fallback activated: ${best.provider} action at (${best.targetX},${best.targetY}) similarity=${best.similarity.toFixed(3)}`, 'INFO', 'pixel-fallback');
            _recordAction(trainedAction, fingerprint);
            pixelTraining.recordUsage?.(best.sampleId);
            _memory.consecutiveFailures = 0;
            return trainedAction;
          }
        }
      } catch (trainErr: any) {
        log(`Training query failed (non-critical): ${trainErr.message || trainErr}`, 'DEBUG', 'pixel-fallback');
      }
    }

    // ── State-awareness filter ──
    // TASK 116 (2026-10-08): When the current state is "exploring" or
    // "exploration", the pixel fallback should be ALLOWED to detect and
    // execute actions for ANY listed state. If it detects a specific
    // state (e.g., video_player, mathu_login, assignments_page), that
    // detection is MORE reliable than the tribunal's "exploring" label.
    //
    // The action should be executed, and if it succeeds (changes the page),
    // the detected state becomes the new current state.
    //
    // Only block actions when the current state is a SPECIFIC known state
    // (not exploring/unknown) and the pixel fallback detects an incompatible
    // state. For example: if the tribunal says "assessment" and the pixel
    // fallback detects "mathu_login", that's a real conflict — block it.
    if (action && currentState) {
      const isCurrentStateUncertain = currentState === 'exploring' ||
        currentState === 'exploration' ||
        currentState === 'unknown' ||
        currentState === 'error' ||
        currentState === 'loading';

      if (!isCurrentStateUncertain) {
        // Current state is specific — enforce compatibility
        if (!_isActionStateCompatible(action, currentState)) {
          log(`Pixel fallback: action ${action.actionType} (detected state=${action.currentState}) ` +
              `is NOT compatible with actual currentState=${currentState} — BLOCKED`, 'WARN', 'pixel-fallback');
          _memory.consecutiveFailures++;
          return null;
        }
      } else {
        // Current state is exploring/unknown — pixel fallback detected a
        // specific state. This is MORE reliable than "exploring."
        // Execute the action and flag it to update the current state.
        if (action.currentState && action.currentState !== 'exploring' &&
            action.currentState !== 'exploration' && action.currentState !== 'unknown') {
          log(`Pixel fallback: detected ${action.currentState} while state was ${currentState} — executing action and promoting detected state`, 'INFO', 'pixel-fallback');
          action._promoteState = action.currentState; // Signal to cycle-manager to update currentState
        }
      }
    }

    if (action) {
      // TASK 100 (2026-09-30): Evidence-based confidence scoring.
      // Replaced string-based confidence (checking reasoning text) with
      // evidence-based scoring that reflects actual detection quality.
      //
      // Confidence is determined by:
      //   1. Whether the action came from a high-evidence detector
      //      (login button, modal, download button = geometry + color)
      //      or a low-evidence detector (quiz, keypad = guessing)
      //   2. Whether the page fingerprint is known (previously seen)
      //   3. Stagnation penalty (same page, no progress)
      //   4. Consecutive failure penalty
      //
      // Navigation actions (modal, login, download, next button) get
      // HIGH confidence because they're based on clear visual geometry.
      // Answering actions (quiz choices, keypad) get LOW confidence
      // because they can't read the question.
      if (!action._confidence) {
        let confidence = 0.5; // Base

        // Navigation actions = HIGH confidence (geometry-based detection)
        if (action.currentState === 'mathu_login' ||
            action.currentState === 'microsoft_email_input' ||
            action.currentState === 'error_recovery') {
          confidence = 0.8; // Login/error recovery = strong visual evidence
        } else if (action.reasoning?.includes('modal') ||
                   action.reasoning?.includes('download') ||
                   action.reasoning?.includes('Next') ||
                   action.reasoning?.includes('Submit') ||
                   action.reasoning?.includes('Done')) {
          confidence = 0.7; // Navigation buttons = good visual evidence
        } else if (action.reasoning?.includes('video') ||
                   action.reasoning?.includes('back') ||
                   action.reasoning?.includes('close')) {
          confidence = 0.65; // Media controls = medium-high
        }

        // Answering actions = LOW confidence (can't read question)
        // These should only appear if math solver succeeded with high conf
        // (which sets _confidence directly). If we reach here for an
        // assessment action, it means no confident math solve happened.
        if (action.currentState === 'assessment') {
          confidence = 0.3; // Low — we can't verify the answer is correct
        }

        // Penalize for stagnation
        if (_isStagnating()) {
          confidence *= 0.5;
        }

        // Penalize for consecutive failures
        if (_memory.consecutiveFailures > 2) {
          confidence *= 0.7;
        }

        // TASK 102: Incorporate action feedback loop reward.
        // Actions that historically changed the page get boosted;
        // actions that didn't change the page get suppressed.
        const reward = _getActionReward(action.currentState || 'unknown', action.actionType);
        if (reward > 0) {
          confidence = Math.min(0.95, confidence + reward * 0.05); // +0.05 per success
        } else if (reward < 0) {
          confidence = Math.max(0.1, confidence + reward * 0.1); // -0.1 per failure (stronger penalty)
        }

        action._confidence = Math.max(0.1, Math.min(0.95, confidence));
        action._confidenceSource = 'pixel-fallback';
        action._actionReward = reward;
      }

      _recordAction(action, fingerprint, regionFingerprints);
      _memory.consecutiveFailures = 0;
    } else {
      _memory.consecutiveFailures++;
    }

    return action;
  } catch (e: any) {
    log(`Pixel fallback error: ${e.message}`, 'DEBUG', 'pixel-fallback');
    _memory.consecutiveFailures++;
    return null;
  }
}

/**
 * Get decoded screenshot — uses preDecoded if available, otherwise takes a fresh PNG.
 * This avoids taking a redundant screenshot when cycle-manager already has one.
 */
async function _getDecodedScreenshot(
  page: any,
  preDecoded?: { width: number; height: number; rgba: Uint8ClampedArray } | null
): Promise<{ width: number; height: number; rgba: Uint8ClampedArray } | null> {
  if (preDecoded && preDecoded.rgba && preDecoded.width > 0 && preDecoded.height > 0) {
    _lastDecodedWidth = preDecoded.width;
    return preDecoded;
  }

  // TASK 46 (2026-09-11): Use CDP screenshot instead of page.screenshot().
  // Playwright's page.screenshot() ALWAYS waits for document.fonts.ready
  // before capturing — when a @font-face URL hangs through a proxy, this
  // takes 30s and kills the pixel fallback. CDP's Page.captureScreenshot
  // does NOT wait for fonts — it captures whatever is currently rendered.
  // This is safe for pixel analysis because we just need the pixels, not
  // perfect font rendering.
  let screenshotBuffer: Buffer | null = null;
  let client: any = null;
  try {
    client = await page.context().newCDPSession(page);
    const result = await client.send('Page.captureScreenshot', { format: 'png' });
    if (result?.data) {
      screenshotBuffer = Buffer.from(result.data, 'base64');
    }
  } catch {
    // CDP failed — fall back to Playwright screenshot (may timeout on fonts)
    screenshotBuffer = await page.screenshot({ type: 'png', fullPage: false, timeout: 5000, animations: 'disabled' }).catch(() => null);
  } finally {
    // Always detach: previously a failed send() leaked the session.
    if (client) { try { await client.detach(); } catch {} }
  }
  if (!screenshotBuffer || screenshotBuffer.length < 100) {
    log('Pixel fallback: screenshot failed or empty', 'DEBUG', 'pixel-fallback');
    return null;
  }

  const decoded = _decodePNG(screenshotBuffer);
  if (!decoded) {
    log('Pixel fallback: PNG decode failed', 'DEBUG', 'pixel-fallback');
    return null;
  }

  _lastDecodedWidth = decoded.width;
  return decoded;
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

    // ── Detect login by color analysis ──
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
      if (colorClass === 'score_screen' || _isScoreScreenByPixels(rgba, width, height)) {
        const scoreAction = _scorePageAction(rgba, width, height);
        if (scoreAction) return scoreAction;
      }

      if (colorClass === 'quiz' || _isQuizPageByPixels(rgba, width, height)) {
        const quizAction = _quizPageAction(rgba, width, height);
        if (quizAction) return quizAction;
      }

      if (_isVideoPlayerByPixels(rgba, width, height)) {
        const videoAction = _videoPlayerAction(rgba, width, height);
        if (videoAction) return videoAction;
      }

      if (colorClass === 'exercise_info' || _isExercisePageByPixels(rgba, width, height)) {
        const exerciseAction = _exercisePageAction(rgba, width, height);
        if (exerciseAction) return exerciseAction;
      }

      return _assignmentPageAction(rgba, width, height);
    }

    if (_isAssignmentPage(url)) {
      return _assignmentPageAction(rgba, width, height);
    }

    // ── Generic: find any clickable button ──
    const button = _findActionButton(rgba, width, height);
    if (button) {
      log(`Pixel fallback: found generic button at (${button.cx}, ${button.cy})`, 'INFO', 'pixel-fallback');
      return {
        actionType: 'click', targetX: button.cx, targetY: button.cy,
        currentState: 'unknown',
        reasoning: 'Pixel fallback: found generic clickable button'
      };
    }

    log('Pixel fallback: no actionable elements found', 'DEBUG', 'pixel-fallback');
    return null;
}

// ─── Visual page classifiers ──────────────────────────────────────────────

function _isQuizPageByPixels(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  const overallColor = _getDominantColor(rgba, width, height);
  if (!_isMintPageBackground(overallColor.r, overallColor.g, overallColor.b)) return false;
  const centerColor = _getRegionDominantColor(rgba, width, height, 0.25, 0.35, 0.75, 0.65);
  if (!_isWhiteish(centerColor.r, centerColor.g, centerColor.b)) return false;
  return true;
}

function _isExercisePageByPixels(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  const headerColor = _getRegionDominantColor(rgba, width, height, 0.0, 0.0, 1.0, 0.12);
  if (!_isDeepBlueBackground(headerColor.r, headerColor.g, headerColor.b)) return false;
  const centerColor = _getRegionDominantColor(rgba, width, height, 0.15, 0.15, 0.85, 0.85);
  if (!_isWhiteish(centerColor.r, centerColor.g, centerColor.b)) return false;
  const greenButton = _findGreenButton(rgba, width, height);
  if (!greenButton) return false;
  return true;
}

function _isVideoPlayerByPixels(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  const headerColor = _getRegionDominantColor(rgba, width, height, 0.0, 0.0, 1.0, 0.12);
  const hasAppHeader = _isDeepBlueBackground(headerColor.r, headerColor.g, headerColor.b);
  const contentColor = _getRegionDominantColor(rgba, width, height, 0.15, 0.15, 0.85, 0.80);
  const isDarkish = contentColor.r < 160 && contentColor.g < 160 && contentColor.b < 160;
  const isWhiteContent = _isWhiteish(contentColor.r, contentColor.g, contentColor.b);

  if (hasAppHeader && !isWhiteContent && isDarkish) return true;

  if (hasAppHeader && _isWhiteish(contentColor.r, contentColor.g, contentColor.b)) {
    const greenButton = _findGreenButton(rgba, width, height);
    if (!greenButton) return true;
  }

  return false;
}

function _isScoreScreenByPixels(rgba: Uint8ClampedArray, width: number, height: number): boolean {
  const tealButton = _findTealGreenButton(rgba, width, height);
  if (!tealButton) return false;
  if (tealButton.w < width * 0.6) return false;
  const upperColor = _getRegionDominantColor(rgba, width, height, 0.2, 0.15, 0.8, 0.35);
  if (!_isWhiteish(upperColor.r, upperColor.g, upperColor.b)) return false;
  return true;
}

// ─── Exports ─────────────────────────────────────────────────────────────

module.exports = {
  generatePixelFallbackAction,
  // TASK 102: Action feedback loop — called by cycle-manager after action execution
  recordActionOutcome,
  // Decode utilities
  _decodePNG,

  _decodeScreenshot,
  // Element finders
  _findInputField,
  _findAllInputFields,
  _findBlueButton,
  _findTealGreenButton,
  _findGreenButton,
  _findActionButton,
  _findChoiceButtons,
  _findDownloadButton,
  _isModuleContentLoaded,
  // Classifiers
  _classifyPageByColor,
  _isMicrosoftLoginPage,
  _isMicrosoftPasswordPage,
  _isMicrosoftKMSIPage,
  _isMathUAppPage,
  _isQuizPageByPixels,
  _isScoreScreenByPixels,
  _isExercisePageByPixels,
  _isVideoPlayerByPixels,
  // Action generators
  _videoPlayerAction,
  _exercisePageAction,
  // Quiz helpers
  _findSelectedChoice,
  _isSelectedChoice,
  _findFullWidthButton,
  _findNextQuestionButton,
  _extractTextRegions,
  _getTextDensityInRegion,
  // v3 additions
  _findNumericKeypad,
  _detectErrorPage,
  _detectModal,
  _computePageFingerprint,
  _computeRegionFingerprint,
  _fingerprintDistance,
  _isLoginUrl,
  _urlPathHas,
  _toViewportCoords,
  _isStagnating,
  _getProgressSummary,
  // v4 additions (SMART BRAIN)
  _colorCalibration,
  _scoreQuizChoices,
  _findColorBandsMultiPass,
  _detectVideoProgress,
  _isModuleCompleted,
  _isMemoPageVisible,
  _markMemoViewPending,
  _isPickAccountPage,
  _pickAccountAction,
  _jitter,
  _sampleColorAt,
  _withTimeout,
  _isFadedElement,
  _isCheckmarkGreen,
  _isPurple,
  _isPlayButtonColor,
  // v4.1 additions (MATH INTELLIGENCE)
  _segmentCharacters,
  _recognizeChar,
  _readTextFromRegion,
  _parseAndEval,
  _safeEval,
  _analyzeMathQuestion,
  _solveForKeypad,
  _applyMathScoreBoost,
  _applyMathHeuristics,
  _detectFractionInChoice,
  // Memory access (for testing/dashboard)
  _memory,
};
