'use strict';

const { runVisionPipeline } = require('./providers-vision-pipeline');

const COLLAPSED_CARDS_PROMPT = `You are given a screenshot of the MathU assignments page. The page contains module cards. Some cards are collapsed and have a down-arrow or chevron icon on the right side. Return a JSON array of objects with "x" and "y" coordinates as percentages of viewport (0-1) for the collapsed card headers. If none, return an empty array. Example: [{"x": 0.1, "y": 0.2}, {"x": 0.3, "y": 0.4}]`;

async function findCollapsedCardsCoordinates(base64Image: any, signal: any) { 
  const res = await runVisionPipeline(base64Image, COLLAPSED_CARDS_PROMPT, {
    validator: (parsed: any) => { if (Array.isArray(parsed) && parsed.every(c => typeof c?.x === 'number' && typeof c?.y === 'number')) return parsed; throw new Error('Invalid collapsed card coordinates array'); },
    timeoutMs: 10000,
    signal,
  });
  return res ? res.result : [];
}

module.exports = { findCollapsedCardsCoordinates };
