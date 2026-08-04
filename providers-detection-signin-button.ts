'use strict';

// ═════════════════════════════════════════════════════════════
// Sign-in Button Detection — Finds the "Sign in with Microsoft"
// button on the MathU landing page via vision AI.
// ═════════════════════════════════════════════════════════════

const { runVisionPipeline } = require('./providers-vision-pipeline');
const { log } = require('./logger');

// BUG FIX (Response 19): Timeout for vision pipeline
const VISION_TIMEOUT_MS = 10000;

const SIGNIN_BUTTON_PROMPT = `You are given a screenshot of the MathU landing page. The page contains a button labeled "Sign in with Microsoft". Find the center coordinates of that button as percentages of the viewport width/height. Return ONLY a JSON object with "x" and "y" properties (values between 0 and 1). Example: {"x": 0.5, "y": 0.4} Do NOT include any extra text.`;

/**
 * Find the "Sign in with Microsoft" button coordinates.
 *
 * @param base64Image - Base64-encoded screenshot
 * @param signal - Optional AbortSignal
 * @returns {x, y} coordinates (0-1 range), or null on failure
 */
async function findSignInButtonCoordinates(base64Image: any, signal: any) {
  if (!base64Image) {
    log('findSignInButtonCoordinates: missing image', 'WARN', 'detection-signin');
    return null;
  }

  try {
    const res = await runVisionPipeline(base64Image, SIGNIN_BUTTON_PROMPT, {
      validator: (parsed: any) => {
        // BUG FIX (Response 19): Strict validation with descriptive errors
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Response is not an object');
        }
        if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') {
          throw new Error('Missing numeric x/y properties');
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
    log(`Sign-in button detection failed: ${e.message}`, 'WARN', 'detection-signin');
    return null;
  }
}

module.exports = { findSignInButtonCoordinates };
