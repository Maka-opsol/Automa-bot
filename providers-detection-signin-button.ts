'use strict';

const { runVisionPipeline } = require('./providers-vision-pipeline');

const SIGNIN_BUTTON_PROMPT = `You are given a screenshot of the MathU landing page. The page contains a button labeled "Sign in with Microsoft". Find the center coordinates of that button as percentages of the viewport width/height. Return ONLY a JSON object with "x" and "y" properties (values between 0 and 1). Example: {"x": 0.5, "y": 0.4} Do NOT include any extra text.`;

async function findSignInButtonCoordinates(base64Image: any, signal: any) { 
  const res = await runVisionPipeline(base64Image, SIGNIN_BUTTON_PROMPT, {
    validator: (parsed: any) => { if (typeof parsed.x === 'number' && typeof parsed.y === 'number' && parsed.x >= 0 && parsed.x <= 1 && parsed.y >= 0 && parsed.y <= 1) return parsed; throw new Error('Invalid coordinates'); },
    timeoutMs: 10000,
    signal,
  });
  return res ? res.result : null;
}

module.exports = { findSignInButtonCoordinates };
