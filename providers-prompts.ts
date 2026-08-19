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
- Click on any required videos to open them, then watch for exactly 2 minutes 59 seconds before clicking the back arrow or X button to close them.
- For exercises, you MUST click the open book icon to view the memo before clicking Next.
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
- AUTH: If you see a login page, ALWAYS click "Sign in with Microsoft". NEVER type in a phone number field — the bot does not use phone sign-in. If you see email/password fields after Microsoft sign-in, fill them using input_email/input_password.
- If you see a video thumbnail/poster (with a play button overlay), CLICK on the video to open it. Once the video player appears with playback controls, you MUST WAIT for exactly 2 minutes 59 seconds before taking any action. After waiting, look for a back arrow (<) in the top-left corner of the video player or an X button — click it to dismiss/close the video and return to the exercise or topic list.
- If you see a question, click the correct answer or use the on-screen keypad.
- If you see a "Next" or "Continue" button, click it.
- If you get stuck, try scrolling.

MODULE DOWNLOAD AND NAVIGATION:
- If you see assignment cards with a dark blue download arrow button, click the download button first. Wait for the module content to load, then click Watch or Start on the first topic.
- If you see a progress bar at 0% with no Watch/Start buttons visible, the module may need to be downloaded first — look for a download arrow button on the card.
- If you see a list of topics (videos, exercises, assessments) under a module header, work through them in order: watch videos first, then start exercises, then take assessments.
- After completing a topic, look for a "Next" button or a back button to return to the topic list, then proceed to the next uncompleted topic.

EXERCISE PAGES (CRITICAL):
- On exercise pages, you will see a white card with a math question and navigation buttons (Previous/Next) at the bottom.
- In the TOP-RIGHT CORNER of the white card, there is a small OPEN BOOK icon. You MUST click this book icon BEFORE clicking Next. Clicking the book flips the card to show the memo/solution. If you do not view the memo first, the Next button will NOT work — the app requires you to see the memo before proceeding.
- The workflow for each exercise question is: (1) Read the question, (2) Click the open book icon in the top-right to flip to the memo/solution, (3) Click the green "Next" button to advance to the next question.

VIDEO PAGES (CRITICAL):
- On pages with video content, you will see a video thumbnail/poster (often with a play button circle in the center). Click on the video to open the video player.
- Once the video player is open (you'll see playback controls at the bottom), you MUST wait for exactly 2 minutes 59 seconds. Do NOT click anything during this time — just wait.
- After 2 minutes 59 seconds, look for a BACK ARROW (<) in the top-left corner of the video, or an X button — click it to close/dismiss the video.
- The required watch time is 2 minutes 59 seconds (179 seconds). Do not dismiss the video before this time has elapsed.

SPA NAVIGATION:
- This is a Single Page Application (Flutter Web). The browser URL may NOT change between pages — do not rely on URL alone to determine the current state.
- Rely on the visual content in the screenshot to determine what page you are on and what action to take.
- The main dashboard has a sidebar with navigation items: "Assignments" (with a book icon) and "Courses" (with a folder icon).
- When on the assignments page, you will see module cards. Each card may have a download button, a progress bar, and topic buttons (Watch/Start/Redo).
- Scrolling works normally even though the URL does not change.

APP ERROR DETECTION (CRITICAL — HIGHEST PRIORITY):
- If you see ANY error dialog, error message, warning popup, or maintenance notice on screen (e.g. "Something went wrong", "maintenance mode", "error occurred", "try again later", "session expired"), you MUST set currentState to exactly "app_error".
- Do NOT attempt to click anything on an error dialog. Do NOT try to work around it. The bot will handle recovery automatically.
- This takes priority over ALL other instructions. If you see an error message, the only correct action is to report it.
- Example: {"reasoning": "Error dialog visible: Something went wrong with maintenance mode", "actionType": "wait", "currentState": "app_error", "targetX": 0.5, "targetY": 0.5, "keypadSequence": [], "submitX": 0.5, "submitY": 0.5, "value": ""}

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
