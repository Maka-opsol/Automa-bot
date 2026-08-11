'use strict';

// ═════════════════════════════════════════════════════════════
// Collapsed Cards Detection — Finds collapsed module card headers
// that need to be expanded on the MathU assignments page.
// ═════════════════════════════════════════════════════════════

const { runVisionPipeline } = require('./providers-vision-pipeline');
const { log } = require('./logger');

// BUG FIX (Response 19): Timeout for vision pipeline
const VISION_TIMEOUT_MS = 120000;

// BUG FIX (Response 19): Maximum number of collapsed cards to return
const MAX_COLLAPSED_CARDS = 10;

const COLLAPSED_CARDS_PROMPT = `You are given a screenshot of the MathU assignments page. The page contains module cards. Some cards are collapsed and have a down-arrow or chevron icon on the right side. Return a JSON array of objects with "x" and "y" coordinates as percentages of viewport (0-1) for the collapsed card headers. If none, return an empty array. Example: [{"x": 0.1, "y": 0.2}, {"x": 0.3, "y": 0.4}]`;

/**
 * Find coordinates of collapsed card headers.
 *
 * @param base64Image - Base64-encoded screenshot
 * @param signal - Optional AbortSignal
 * @returns Array of {x, y} coordinates, or empty array on failure
 */
async function findCollapsedCardsCoordinates(base64Image: any, signal: any) {
  if (!base64Image) {
    log('findCollapsedCardsCoordinates: missing image', 'WARN', 'detection-collapsed');
    return [];
  }

  try {
    const res = await runVisionPipeline(base64Image, COLLAPSED_CARDS_PROMPT, {
      validator: (parsed: any) => {
        if (!Array.isArray(parsed)) throw new Error('Not an array');
        // BUG FIX (Response 19): Validate each coordinate and cap count
        const valid = parsed
          .filter((c: any) => typeof c?.x === 'number' && typeof c?.y === 'number')
          .filter((c: any) => c.x >= 0 && c.x <= 1 && c.y >= 0 && c.y <= 1)
          .slice(0, MAX_COLLAPSED_CARDS);
        return valid;
      },
      timeoutMs: VISION_TIMEOUT_MS,
      signal,
    });
    return res ? res.result : [];
  } catch (e: any) {
    log(`Collapsed cards detection failed: ${e.message}`, 'WARN', 'detection-collapsed');
    return [];
  }
}

module.exports = { findCollapsedCardsCoordinates };
