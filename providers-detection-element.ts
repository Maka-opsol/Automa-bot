'use strict';

// ═════════════════════════════════════════════════════════════
// Element Detection — Finds an arbitrary named element (input field,
// button, etc.) on a page via vision AI. Used to drive the Microsoft
// login form visually (email field, password field, KMSI "Yes" button)
// instead of DOM CSS selectors, which commonly fail on real Microsoft
// pages. Mirrors findSignInButtonCoordinates / findCollapsedCardsCoordinates.
// ═════════════════════════════════════════════════════════════

const { runVisionPipeline } = require('./providers-vision-pipeline');
const { log } = require('./logger');

const VISION_TIMEOUT_MS = 120000;

/**
 * Build the VLM prompt for locating a named element.
 * @param elementDescription - e.g. 'the email input field', 'the password input field',
 *                              'the "Yes" button on the "Stay signed in" page'
 */
function _prompt(elementDescription: string): string {
  return `You are given a screenshot of a web page. Find the center coordinates of ${elementDescription} as percentages of the viewport width/height. Return ONLY a JSON object with "x" and "y" properties (values between 0 and 1). If the element is not visible on the page, return {"x": -1, "y": -1}. Example: {"x": 0.5, "y": 0.4} Do NOT include any extra text.`;
}

/**
 * Find the center coordinates of a named element on the page.
 *
 * @param base64Image - Base64-encoded screenshot
 * @param elementDescription - Human description of the element to locate
 * @param signal - Optional AbortSignal
 * @returns {x, y} coordinates (0-1 range), or null on failure / not found
 */
async function findElementCoordinates(base64Image: any, elementDescription: any, signal: any) {
  if (!base64Image) {
    log(`findElementCoordinates: missing image (${elementDescription})`, 'WARN', 'detection-element');
    return null;
  }
  if (!elementDescription) {
    log('findElementCoordinates: missing element description', 'WARN', 'detection-element');
    return null;
  }

  try {
    const res = await runVisionPipeline(base64Image, _prompt(String(elementDescription)), {
      validator: (parsed: any) => {
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Response is not an object');
        }
        if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
          throw new Error('Missing numeric x/y properties');
        }
        // Sentinel {-1, -1} means "not found" — return null so callers fall through.
        if (parsed.x === -1 && parsed.y === -1) {
          return null;
        }
        if (parsed.x < 0 || parsed.x > 1 || parsed.y < 0 || parsed.y > 1) {
          throw new Error(`Coordinates out of range: x=${parsed.x}, y=${parsed.y}`);
        }
        return parsed;
      },
      timeoutMs: VISION_TIMEOUT_MS,
      signal,
    });
    return res ? res.result : null;
  } catch (e: any) {
    log(`Element detection failed (${elementDescription}): ${e.message}`, 'WARN', 'detection-element');
    return null;
  }
}

module.exports = { findElementCoordinates };
