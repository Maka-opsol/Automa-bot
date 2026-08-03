'use strict';

const { runVisionPipeline } = require('./providers-vision-pipeline');

const MODULE_COMPLETION_PROMPT = `You are given a screenshot of a module card from an educational platform. The module card has a horizontal progress bar. Look carefully at the progress bar. If it is completely filled with yellow or blue colour and extends all the way to the right edge, then the module is 100% completed. Also look for "100%" text, "Completed", "Done", or a checkmark. Return ONLY a JSON object: {"completed": true/false, "reason": "brief reason"}`;

async function checkModuleCompletionViaVision(base64Image: any, signal: any) { 
  const res = await runVisionPipeline(base64Image, MODULE_COMPLETION_PROMPT, {
    validator: (parsed: any) => { if (typeof parsed.completed === 'boolean') return parsed.completed; throw new Error('Invalid completion boolean'); },
    timeoutMs: 10000,
    signal,
  });
  return res ? res.result : null;
}

module.exports = { checkModuleCompletionViaVision };
