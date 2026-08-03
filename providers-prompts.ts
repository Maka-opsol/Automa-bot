'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

// Lazy remote-brain-injector — loaded on first call to getSystemPrompt/getUserInstruction
// Avoids eager evaluation at module scope which may fail if dependencies aren't ready.
let _remoteBrain: any = null;
let _remoteBrainChecked = false;
function _getRemoteBrain() {
  if (!_remoteBrainChecked) {
    _remoteBrainChecked = true;
    try { _remoteBrain = require('./remote-brain-injector'); } catch { _remoteBrain = null; }
  }
  return _remoteBrain;
}

const BASE_SYSTEM_PROMPT = `
You are an autonomous agent navigating the MathU educational platform (built with Flutter Web on Canvas).
Your GOAL: Complete the next available math module. This means:
- Watch any required videos.
- Answer all questions correctly (or if incorrect, review the memo and correct).
- Move to the next module when finished.
Viewport: ${getCONFIG().DISPLAY_WIDTH}×${getCONFIG().DISPLAY_HEIGHT} px.
All coordinates are fractions of viewport width/height (0.0--1.0).
Return ONLY a JSON object with:
{
  "reasoning": "Brief explanation of what you see and why you choose this action.",
  "actionType": "click | input_email | input_password | keypad_input | scroll_vertical | scroll_horizontal | wait | flutter_swipe | flutter_tap",
  "targetX": 0.5,
  "targetY": 0.5,
  "keypadSequence": [],
  "submitX": 0.5,
  "submitY": 0.5,
  "value": ""
}
Do not output extra text, markdown, or code fences.
`;

const BASE_USER_INSTRUCTION = `
Look at the screenshot. What is the next logical action to advance toward completing the module?
Consider:
- If you see "Sign in with Microsoft", click it.
- If you see email/password fields, fill them.
- If you see a video, wait for it to finish.
- If you see a question, click the correct answer or use the on-screen keypad.
- If you see a "Next" or "Continue" button, click it.
- If you get stuck, try scrolling.
Return the JSON as specified.
`;

function getSystemPrompt() { 
  const remoteBrain = _getRemoteBrain();
  if (!remoteBrain) return BASE_SYSTEM_PROMPT;
  const remote = remoteBrain.getActiveInstruction();
  if (remote) { return `${BASE_SYSTEM_PROMPT}\n\n[REMOTE OVERRIDE]: ${remote}`; }
  return BASE_SYSTEM_PROMPT;
}

function getUserInstruction() { 
  const remoteBrain = _getRemoteBrain();
  if (!remoteBrain) return BASE_USER_INSTRUCTION;
  const remote = remoteBrain.getActiveInstruction();
  if (remote) { return `${BASE_USER_INSTRUCTION}\n\n[REMOTE OVERRIDE]: ${remote}`; }
  return BASE_USER_INSTRUCTION;
}

module.exports = { getSystemPrompt, getUserInstruction, _injectDependencies };
Object.defineProperty(module.exports, 'SYSTEM_PROMPT', { get: getSystemPrompt, enumerable: true });
Object.defineProperty(module.exports, 'USER_INSTRUCTION', { get: getUserInstruction, enumerable: true });
