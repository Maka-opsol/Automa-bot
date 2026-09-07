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
  // Coordinate-based
  'click', 'flutter_tap', 'double_click', 'hover', 'long_press',
  // Text input
  'input_email', 'input_password', 'type_text', 'keypad_input',
  // Gesture
  'flutter_swipe', 'drag', 'scroll_vertical', 'scroll_horizontal',
  // Keyboard
  'press_key',
  // Navigation
  'navigate_back', 'select_option',
  // Timing
  'wait',
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

AUTH RULE (HIGHEST PRIORITY — overrides all other instructions):
- If you see the MathU login page, set currentState to "mathu_login" and click "Sign in with Microsoft".
- NEVER type in a phone number field. The bot does NOT use phone sign-in.
- After Microsoft sign-in, if you see email/password fields, set currentState to "microsoft_email_input".

Viewport: ${width}x${height} px.
All coordinates are fractions of viewport width/height (0.0--1.0).

AVAILABLE ACTIONS:
- click/flutter_tap: Single click at (targetX, targetY).
- double_click: Double-click at (targetX, targetY). Use for elements that need two clicks to activate.
- hover: Move mouse to (targetX, targetY) WITHOUT clicking. Use to reveal tooltips or hover states before deciding.
- long_press: Press and hold at (targetX, targetY) for 600ms. Use for context menus.
- type_text: Click (targetX, targetY) to focus a field, then type the text in "value". Set clearFirst=false to append instead of replace.
- input_email/input_password: Specialized text input for auth (auto-fills credentials).
- keypad_input: Tap a sequence of on-screen keys. Each key in keypadSequence has {x, y}. Submit button at (submitX, submitY).
- press_key: Press a keyboard key. Put the key name in "value" (e.g. "Enter", "Tab", "Escape", "ArrowDown", "Control+a", "Shift+Tab"). No coordinates needed.
- flutter_swipe: Swipe from (targetX, targetY) to (targetX2, targetY2).
- drag: Drag from (targetX, targetY) to (targetX2, targetY2). Like swipe but holds down.
- scroll_vertical/scroll_horizontal: Scroll the page by a fixed amount.
- navigate_back: Go back in browser history. No coordinates needed.
- select_option: Click dropdown at (targetX, targetY), then click the option at (targetX2, targetY2).
- reload_browser: Reload the current page (like pressing F5). Use this when the page is stuck, shows an error, or a CAPTCHA that can't be solved. No coordinates needed.
- wait: Wait before taking the next action.

CAPTCHA DETECTION (YOU decide — do NOT assume):
- Look at the screenshot carefully. If you see a CAPTCHA challenge (image puzzle, "Prove you're human", distorted text, checkbox "I'm not a robot", FunCaptcha, hCaptcha, etc.), set currentState to "captcha" and use the "wait" action. Do NOT try to solve the CAPTCHA yourself — the bot has a separate CAPTCHA solver. Just report it and wait.
- If you do NOT see a CAPTCHA, do NOT report one. Many Microsoft login pages have security elements that are NOT captchas (e.g. "Stay signed in?" prompts, MFA prompts). Only report a CAPTCHA if you see an actual puzzle/challenge image.
- If the page shows a CAPTCHA that has been there for multiple cycles (stuck), use "reload_browser" to reload the page and get a fresh CAPTCHA.

FLUTTER WEB PREFERENCES (when logged into MathU — NOT on login/Microsoft pages):
- The MathU app is built with Flutter Web. Flutter UI elements respond better to "flutter_tap" than "click".
- When you are on the assignments_page, video_player, exercise_info, exercise_memo, assessment, score_screen, or pathway states (i.e. logged in and using the app), prefer using "flutter_tap" instead of "click" for all button presses, card taps, and element interactions.
- On the login page (mathu_login, microsoft_email_input) and Microsoft pages, use "click" — flutter_tap may not work correctly on non-Flutter pages.
- For scrolling on Flutter pages, prefer "flutter_swipe" over "scroll_vertical" — Flutter gesture recognition is more reliable with swipe.
- For the download button tap mentioned above, use "flutter_tap" — the download button is a Flutter widget, not an HTML element.

Return ONLY a JSON object with:
{
  "reasoning": "Brief explanation of what you see and why you choose this action.",
  "currentState": "mathu_login | microsoft_email_input | assignments_page | video_player | exercise_info | exercise_memo | assessment | score_screen | pathway | error | captcha | flutter_modal | flutter_bottom_sheet | exploration",
  "actionType": "${ACTION_TYPE_STRING}",
  "targetX": 0.5,
  "targetY": 0.5,
  "targetX2": 0.5,
  "targetY2": 0.5,
  "keypadSequence": [],
  "submitX": 0.5,
  "submitY": 0.5,
  "value": "",
  "clearFirst": true
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

MODULE DOWNLOAD AND NAVIGATION (CRITICAL — modules do NOT load automatically):
- Modules on the assignments page are NOT pre-loaded. You MUST click the dark blue download arrow button on a module card BEFORE you can do anything with that module's content.
- Do NOT expect module content to appear automatically — the module will sit at 0% with a download button until you explicitly click the download button.
- IMPORTANT: When clicking the download button, use "flutter_tap" (not "click"). The download button is a Flutter widget and responds better to flutter_tap than a regular click.
- After clicking download: WAIT for the progress bar to reach 100% and the download button to be replaced by Watch/Start buttons. Only then click Watch or Start on the first topic.
- If you see a progress bar at 0% with no Watch/Start buttons visible, the module has NOT been downloaded yet — look for a download arrow button on the card and click it.
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
- When on the assignments page, you will see module cards. Each card may have a download button, a progress bar, and topic buttons (Watch/Start/Redo). Remember: you MUST click the download button on a card before its topic buttons become usable.
- Scrolling works normally even though the URL does not change.

APP ERROR DETECTION (CRITICAL — HIGHEST PRIORITY):
- If you see ANY error dialog, error message, warning popup, or maintenance notice on screen (e.g. "Something went wrong", "maintenance mode", "error occurred", "try again later", "session expired"), you MUST set currentState to exactly "app_error".
- Do NOT attempt to click anything on an error dialog. Do NOT try to work around it. The bot will handle recovery automatically.
- This takes priority over ALL other instructions. If you see an error message, the only correct action is to report it.
- Example: {"reasoning": "Error dialog visible: Something went wrong with maintenance mode", "actionType": "wait", "currentState": "app_error", "targetX": 0.5, "targetY": 0.5, "targetX2": 0.5, "targetY2": 0.5, "keypadSequence": [], "submitX": 0.5, "submitY": 0.5, "value": "", "clearFirst": true}

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
