'use strict';

const { runVisionPipeline } = require('./providers-vision-pipeline');

const DETECTION_PROMPT = `
You are a scanner for an educational platform assignments page.
Look at the screenshot carefully.
Your ONLY job is to determine if there are any actionable items on the screen.
Look specifically for buttons or text labels that say EXACTLY: "Watch", "Start", "Redo".
Return ONLY raw JSON formatting data:
{ "hasActionableItems": boolean, "reason": "Brief explanation of what you see" }
`;

async function detectNewWork(base64Image: any, signal: any) { 
  const res = await runVisionPipeline(base64Image, DETECTION_PROMPT, {
    validator: (parsed: any) => { if (typeof parsed.hasActionableItems !== 'boolean') throw new Error('Invalid response'); return { hasActionableItems: parsed.hasActionableItems, reason: parsed.reason || '' }; },
    timeoutMs: 15000,
    signal,
  });
  if (!res) return { hasActionableItems: true, reason: 'Detection failed, assuming true' };
  return res.result;
}

module.exports = { detectNewWork };
