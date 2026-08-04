'use strict';

// ═════════════════════════════════════════════════════════════
// Module Completion Detection — Checks if a module card's
// progress bar is 100% complete via vision AI.
// ═════════════════════════════════════════════════════════════

const { runVisionPipeline } = require('./providers-vision-pipeline');
const { log } = require('./logger');

// BUG FIX (Response 19): Timeout for vision pipeline
const VISION_TIMEOUT_MS = 10000;

const MODULE_COMPLETION_PROMPT = `You are given a screenshot of a module card from an educational platform. The module card has a horizontal progress bar. Look carefully at the progress bar. If it is completely filled with yellow or blue colour and extends all the way to the right edge, then the module is 100% completed. Also look for "100%" text, "Completed", "Done", or a checkmark. Return ONLY a JSON object: {"completed": true/false, "reason": "brief reason"}`;

/**
 * Check if a module is 100% complete via vision analysis.
 *
 * @param base64Image - Base64-encoded screenshot of the module card
 * @param signal - Optional AbortSignal
 * @returns true if complete, false if not, or null on failure
 */
async function checkModuleCompletionViaVision(base64Image: any, signal: any) {
  if (!base64Image) {
    log('checkModuleCompletionViaVision: missing image', 'WARN', 'detection-completion');
    return null;
  }

  try {
    const res = await runVisionPipeline(base64Image, MODULE_COMPLETION_PROMPT, {
      validator: (parsed: any) => {
        // BUG FIX (Response 19): Strict validation
        if (!parsed || typeof parsed !== 'object') {
          throw new Error('Response is not an object');
        }
        if (typeof parsed.completed !== 'boolean') {
          throw new Error('Missing boolean "completed" property');
        }
        return parsed.completed;
      },
      timeoutMs: VISION_TIMEOUT_MS,
      signal,
    });
    return res ? res.result : null;
  } catch (e: any) {
    log(`Module completion detection failed: ${e.message}`, 'WARN', 'detection-completion');
    return null;
  }
}

module.exports = { checkModuleCompletionViaVision };

