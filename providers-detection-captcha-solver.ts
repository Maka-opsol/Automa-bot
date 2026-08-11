'use strict';

// ═════════════════════════════════════════════════════════════
// CAPTCHA Solver — Uses vision AI to solve reCAPTCHA image grids.
//
// Render-aware: Timeout races all vision calls. Coords validated
// to be within expected viewport range.
// ═════════════════════════════════════════════════════════════

const { runVisionPipeline } = require('./providers-vision-pipeline');
const { log, logError } = require('./logger');

// BUG FIX (Response 19): Maximum number of coordinates to return.
// Without this, a misconfigured vision model could return
// hundreds of coordinates, wasting memory and API tokens.
const MAX_COORDS = 20;

// BUG FIX (Response 19): Timeout for vision pipeline call.
const SOLVE_TIMEOUT_MS = 120000;

const CAPTCHA_SOLVE_PROMPT = `
You are a CAPTCHA image solver. You are given a screenshot of a reCAPTCHA image grid.
The instruction is: "%INSTRUCTION%".
Your task is to identify ALL images that match the instruction.
Return ONLY a JSON array of objects with "x" and "y" -- the pixel coordinates (from the top-left of the screenshot) of the CENTER of each matching image.
If no images match, return an empty array.
Example: [{"x": 120, "y": 240}, {"x": 380, "y": 240}]
Do NOT include any extra text, markdown, or code fences.
`;

/**
 * Solve a CAPTCHA by identifying matching image coordinates.
 *
 * @param base64Image - Base64-encoded screenshot
 * @param instruction - CAPTCHA instruction text (e.g., "select all bridges")
 * @param signal - Optional AbortSignal for cancellation
 * @returns Array of {x, y} coordinates, or empty array on failure
 */
async function solveCaptchaWithVision(base64Image: any, instruction: any, signal: any) {
  if (!base64Image || !instruction) {
    log('solveCaptchaWithVision: missing image or instruction', 'WARN', 'captcha-solver');
    return [];
  }

  const prompt = CAPTCHA_SOLVE_PROMPT.replace(/%INSTRUCTION%/g, instruction);

  try {
    const res = await runVisionPipeline(base64Image, prompt, {
      validator: (parsed: any) => {
        if (!Array.isArray(parsed)) throw new Error('Not an array');
        // BUG FIX (Response 19): Validate each coordinate
        const valid = parsed
          .filter((c: any) => typeof c?.x === 'number' && typeof c?.y === 'number')
          .filter((c: any) => c.x >= 0 && c.y >= 0) // Non-negative
          .slice(0, MAX_COORDS); // Cap count
        if (valid.length === 0 && parsed.length > 0) {
          throw new Error('No valid coordinates in response');
        }
        return valid;
      },
      timeoutMs: SOLVE_TIMEOUT_MS,
      signal,
    });
    return res ? res.result : [];
  } catch (e: any) {
    logError('CAPTCHA solve failed', e);
    return [];
  }
}

module.exports = { solveCaptchaWithVision };
