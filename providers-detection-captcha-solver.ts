'use strict';

const { runVisionPipeline } = require('./providers-vision-pipeline');

const CAPTCHA_SOLVE_PROMPT = `
You are a CAPTCHA image solver. You are given a screenshot of a reCAPTCHA image grid.
The instruction is: "%INSTRUCTION%".
Your task is to identify ALL images that match the instruction.
Return ONLY a JSON array of objects with "x" and "y" -- the pixel coordinates (from the top-left of the screenshot) of the CENTER of each matching image.
If no images match, return an empty array.
Example: [{"x": 120, "y": 240}, {"x": 380, "y": 240}]
Do NOT include any extra text, markdown, or code fences.
`;

async function solveCaptchaWithVision(base64Image: any, instruction: any, signal: any) { 
  const prompt = CAPTCHA_SOLVE_PROMPT.replace(/%INSTRUCTION%/g, instruction);
  const res = await runVisionPipeline(base64Image, prompt, {
    validator: (parsed: any) => { if (Array.isArray(parsed) && parsed.every(c => typeof c?.x === 'number' && typeof c?.y === 'number')) return parsed; throw new Error('Invalid coords array'); },
    timeoutMs: 20000,
    signal,
  });
  return res ? res.result : [];
}

module.exports = { solveCaptchaWithVision };
