'use strict';

// ═════════════════════════════════════════════════════════════
// Work Detector — Scans the MathU assignments page to check
// if there are actionable items (Watch/Start/Redo buttons).
// ═════════════════════════════════════════════════════════════

const { runVisionPipeline } = require('./providers-vision-pipeline');
const { log } = require('./logger');

// BUG FIX (Response 19): Timeout for vision pipeline
const VISION_TIMEOUT_MS = 120000;

const DETECTION_PROMPT = `
You are a scanner for an educational platform assignments page.
Look at the screenshot carefully.
Your ONLY job is to determine if there are any actionable items on the screen.
Look specifically for buttons or text labels that say EXACTLY: "Watch", "Start", "Redo".
Return ONLY raw JSON formatting data:
{ "hasActionableItems": boolean, "reason": "Brief explanation of what you see" }
`;

/**
 * Detect whether the assignments page has actionable work items.
 *
 * @param base64Image - Base64-encoded screenshot
 * @param signal - Optional AbortSignal
 * @returns Object with hasActionableItems and reason
 */
async function detectNewWork(base64Image: any, signal: any) {
  if (!base64Image) {
    log('detectNewWork: missing image, assuming true', 'WARN', 'detection-work');
    return { hasActionableItems: true, reason: 'No image provided, assuming true' };
  }

  try {
    const res = await runVisionPipeline(base64Image, DETECTION_PROMPT, {
      validator: (parsed: any) => {
        // BUG FIX (Response 19): Strict validation
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Response is not an object');
        }
        if (typeof parsed.hasActionableItems !== 'boolean') {
          throw new Error('Missing boolean hasActionableItems');
        }
        return {
          hasActionableItems: parsed.hasActionableItems,
          reason: parsed.reason || '',
        };
      },
      timeoutMs: VISION_TIMEOUT_MS,
      signal,
    });
    if (!res) {
      return { hasActionableItems: true, reason: 'Detection failed, assuming true' };
    }
    return res.result;
  } catch (e: any) {
    log(`Work detection failed: ${e.message}`, 'WARN', 'detection-work');
    return { hasActionableItems: true, reason: 'Detection error, assuming true' };
  }
}

module.exports = { detectNewWork };
