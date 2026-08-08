'use strict';

// ═════════════════════════════════════════════════════════════
// System Prompts — Provides the base system prompt and user
// instruction for the vision AI provider. Supports remote
// brain injection to override prompts at runtime.
//
// Render-aware: Uses lazy getters to avoid evaluating
// CONFIG at module load time (which may fail if config
// hasn't been initialized yet).
// ═════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function _getCONFIG(): Record<string, any> {
  return _deps.config || (() => { try { return require('./get-config'); } catch { return { DISPLAY_WIDTH: 1280, DISPLAY_HEIGHT: 720 }; } })();
}

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

// ═════════════════════════════════════════════════════════════
// Action types that the bot can perform.
// Extracted to a constant for reuse and consistency.
// ═════════════════════════════════════════════════════════════

const VALID_ACTION_TYPES = [
  'click', 'input_email', 'input_password', 'keypad_input',
  'scroll_vertical', 'scroll_horizontal', 'wait',
  'flutter_swipe', 'flutter_tap',
];

// BUG FIX (Response 19): Action type string for the prompt is now
// generated from VALID_ACTION_TYPES to stay in sync.
const ACTION_TYPE_STRING = VALID_ACTION_TYPES.join(' | ');

// ═════════════════════════════════════════════════════════════
// Base prompts (templates, evaluated lazily)
// ═════════════════════════════════════════════════════════════

// BUG FIX (Response 19): Prompts are now functions that read CONFIG
// lazily. Previously, CONFIG.DISPLAY_WIDTH was evaluated at module
// load time, which could fail if config.ts hasn't been initialized.
// This caused a crash on cold start.

function _buildBaseSystemPrompt(): string {
  const config = _getCONFIG();
  const width = config.DISPLAY_WIDTH || 1280;
  const height = config.DISPLAY_HEIGHT || 720;
  return `
You are an autonomous agent navigating the MathU educational platform (built with Flutter Web on Canvas).
Your GOAL: Complete the next available math module. This means:
- Watch any required videos.
- Answer all questions correctly (or if incorrect, review the memo and correct).
- Move to the next module when finished.
Viewport: ${width}x${height} px.
All coordinates are fractions of viewport width/height (0.0--1.0).
Return ONLY a JSON object with:
{
  "reasoning": "Brief explanation of what you see and why you choose this action.",
  "actionType": "${ACTION_TYPE_STRING}",
  "targetX": 0.5,
  "targetY": 0.5,
  "keypadSequence": [],
  "submitX": 0.5,
  "submitY": 0.5,
  "value": ""
}
Do not output extra text, markdown, or code fences.
`;
}

function _buildBaseUserInstruction(): string {
  return `
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
}

// ═════════════════════════════════════════════════════════════
// Public API
// ═════════════════════════════════════════════════════════════

/**
 * Get the system prompt, with optional remote brain override.
 * BUG FIX (Response 19): CONFIG is read lazily here, not at module scope.
 */
function getSystemPrompt() {
  const basePrompt = _buildBaseSystemPrompt();
  const remoteBrain = _getRemoteBrain();
  if (!remoteBrain) return basePrompt;
  const remote = remoteBrain.getActiveInstruction();
  if (remote) { return `${basePrompt}\n\n[REMOTE OVERRIDE]: ${remote}`; }
  return basePrompt;
}

/**
 * Get the user instruction, with optional remote brain override.
 */
function getUserInstruction() {
  const baseInstruction = _buildBaseUserInstruction();
  const remoteBrain = _getRemoteBrain();
  if (!remoteBrain) return baseInstruction;
  const remote = remoteBrain.getActiveInstruction();
  if (remote) { return `${baseInstruction}\n\n[REMOTE OVERRIDE]: ${remote}`; }
  return baseInstruction;
}

/**
 * Get user instruction enhanced with problem-type-specific strategy.
 * (Response 4) Appends a solving strategy hint based on problem type.
 */
function getUserInstructionWithType(problemType?: string, problemText?: string) {
  const baseInstruction = getUserInstruction();
  const remoteBrain = _getRemoteBrain();
  const remote = remoteBrain?.getActiveInstruction?.();

  // Load type-specific prompt from classifier
  let typeHint = '';
  if (problemType && problemType !== 'UNKNOWN') {
    try {
      const classifier = require('./math-problem-classifier');
      const typePrompts = classifier.TYPE_PROMPTS;
      if (typePrompts[problemType]) {
        typeHint = `

[MATH PROBLEM TYPE: ${problemType}]
Solving strategy: ${typePrompts[problemType]}`;
      }
    } catch {}
  }

  // Append problem text context if available
  let problemContext = '';
  if (problemText && problemText.trim().length > 0) {
    problemContext = `

[OCR TEXT]: ${problemText}`;
  }

  let result = baseInstruction + typeHint + problemContext;
  if (remote) {
    result += `\n\n[REMOTE OVERRIDE]: ${remote}`;
  }
  return result;
}

module.exports = { getSystemPrompt, getUserInstruction, getUserInstructionWithType, _injectDependencies, VALID_ACTION_TYPES };
Object.defineProperty(module.exports, 'SYSTEM_PROMPT', { get: getSystemPrompt, enumerable: true });
Object.defineProperty(module.exports, 'USER_INSTRUCTION', { get: getUserInstruction, enumerable: true });
