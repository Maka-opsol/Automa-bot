'use strict';

// ─── NVIDIA Provider ──────────────────────────────────────────────────────────
//
// Uses NVIDIA NIM API with meta/llama-3.2-11b-vision-instruct (free tier).
// OpenAI-compatible API. Supports vision (all providers now vision-capable).
//
// TASK 117 (2026-10-11): The llama-3.2-11b-vision-instruct model is a small
// 11B parameter model that often returns prose descriptions instead of JSON.
// Fix: Add a dedicated system message with a STRONG JSON-only instruction,
// and try response_format: { type: 'json_object' }. The 422 handler in
// callChatCompletionWithRollback will retry without response_format if
// NVIDIA's API doesn't support it.
//
// TASK 127 (2026-10-22): The 11B model STILL returns prose despite the system
// message — it writes "**Step 1:** Identify the Current State..." instead of
// JSON. Fix: Made the system message even more aggressive (forbid step-by-step
// reasoning, forbid markdown headers). Also improved the fallback extraction
// to find JSON anywhere in the response (the model sometimes writes reasoning
// steps THEN outputs JSON at the end).
//
// P1: Content serialization handled by providers-base/serializers.
//     responseFormat is now passed (TASK 117) — if unsupported, 422 handler retries.
// P7: providerName passed to retryWithBackoff for health-aware retries.

const { extractJSON, validateActionResponse, callChatCompletionWithRollback, getProviderConfig, retryWithBackoff } = require('./providers-base');

// TASK 127+128 (2026-10-22): The 11B model was returning prose AND misclassifying
// states — it saw "Sign in with Microsoft" but set currentState to "exploration"
// because the model is too small to understand the state mapping from the user
// prompt alone. Fix: add EXPLICIT visual cue → state mappings directly in the
// system message so the model can pattern-match without reasoning.
const NVIDIA_SYSTEM_MESSAGE = `You are a JSON API endpoint. You output ONLY JSON. Not a chatbot, not an assistant — a JSON API.

FORBIDDEN: prose, explanations, step-by-step reasoning, markdown headers (**Step 1:**, **Step 2:**), bullet points, ANY text before or after the JSON.

VISUAL CUE → STATE MAPPING (memorize these — do NOT use "exploration" if ANY of these cues are visible):
- "Sign in with Microsoft" button visible → currentState = "mathu_login", actionType = "click" on that button
- Email input field on Microsoft page → currentState = "microsoft_email_input", actionType = "input_email"
- Password input field on Microsoft page → currentState = "microsoft_password_input", actionType = "input_password"
- "Stay signed in?" popup → currentState = "microsoft_kmsi", actionType = "click" on "Yes"
- Module cards / assignment list → currentState = "assignments_page"
- Video playing / video player controls → currentState = "video_player", actionType = "wait" with duration 179
- Math question / exercise → currentState = "exercise_info"
- Memo / solution visible → currentState = "exercise_memo"
- Score / results screen → currentState = "score_screen"
- Error dialog → currentState = "app_error"

NEVER set currentState to "exploration" if you can see ANY of the cues above. "exploration" means NONE of the above cues are visible.

Your ENTIRE response must be a single JSON object starting with { and ending with }.

Example: if you see "Sign in with Microsoft":
{"reasoning":"Login page with Sign in with Microsoft button","currentState":"mathu_login","actionType":"click","targetX":0.5,"targetY":0.6,"targetX2":0.5,"targetY2":0.5,"keypadSequence":[],"submitX":0.5,"submitY":0.5,"value":"","clearFirst":true,"repeatable":true,"skipExactMatch":false}

If you truly cannot determine the action:
{"reasoning":"cannot determine","currentState":"unknown","actionType":"wait","targetX":0,"targetY":0,"targetX2":0,"targetY2":0,"keypadSequence":[],"submitX":0,"submitY":0,"value":"","clearFirst":true,"repeatable":false,"skipExactMatch":false}

Output the JSON now. Nothing else.`;

function NvidiaProvider() {
  const apiKey = process.env.NVIDIA_API_KEY;
  if (!apiKey) {
    return null;
  }

  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('NVIDIA');

    // TASK 117+127: Pass systemMessage to force JSON output from the small
    // vision model. Also try response_format: { type: 'json_object' } —
    // if NVIDIA's API doesn't support it, the 422 handler in
    // callChatCompletionWithRollback will retry without it.
    const rawContent = await retryWithBackoff(
      () => callChatCompletionWithRollback(
        config.endpoint, apiKey, config.model, base64Image, prompt, 'NVIDIA',
        {
          signal,
          systemMessage: NVIDIA_SYSTEM_MESSAGE,
          responseFormat: { type: 'json_object' },
        }
      ),
      { providerName: 'NVIDIA', signal, maxRetries: options.maxRetries }
    );

    if (options.validate === false) return rawContent;

    let parsed = extractJSON(rawContent, 'NVIDIA');

    if (!parsed) {
      // TASK 127: The model may have written reasoning steps BEFORE the JSON.
      // Try to find a JSON block anywhere in the response — not just the first
      // { match. The model sometimes writes:
      //   "**Step 1:** ... **Step 2:** ... {"reasoning":"...","actionType":"click",...}"
      // We need to find the LAST JSON object in the text (the actual action).
      const jsonMatches = rawContent.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g);
      if (jsonMatches && jsonMatches.length > 0) {
        // Try each match, starting from the last one (the model often writes
        // reasoning first, then the actual JSON at the end)
        for (let i = jsonMatches.length - 1; i >= 0; i--) {
          try {
            const candidate = JSON.parse(jsonMatches[i]);
            if (candidate && typeof candidate === 'object') {
              parsed = candidate;
              break;
            }
          } catch {}
        }
      }
    }

    if (!parsed) {
      // TASK 127: Try to extract action info from prose as a last resort.
      // The model wrote something like "click on the Sign in with Microsoft button"
      // — try to infer the action type and state from keywords.
      const lowerContent = rawContent.toLowerCase();
      let inferredAction: any = null;

      // Detect action type from keywords
      if (lowerContent.includes('click') || lowerContent.includes('tap') || lowerContent.includes('press')) {
        inferredAction = { actionType: 'click', currentState: 'unknown' };
      } else if (lowerContent.includes('type') || lowerContent.includes('input') || lowerContent.includes('enter email') || lowerContent.includes('enter password')) {
        inferredAction = { actionType: 'wait', currentState: 'unknown' };
      } else if (lowerContent.includes('wait')) {
        inferredAction = { actionType: 'wait', currentState: 'unknown' };
      } else if (lowerContent.includes('scroll') || lowerContent.includes('swipe')) {
        inferredAction = { actionType: 'scroll_vertical', currentState: 'unknown' };
      }

      // Detect state from keywords
      if (lowerContent.includes('login') || lowerContent.includes('sign in')) {
        if (inferredAction) inferredAction.currentState = 'mathu_login';
      } else if (lowerContent.includes('email') && lowerContent.includes('microsoft')) {
        if (inferredAction) inferredAction.currentState = 'microsoft_email_input';
      } else if (lowerContent.includes('password')) {
        if (inferredAction) inferredAction.currentState = 'microsoft_password_input';
      } else if (lowerContent.includes('assignment') || lowerContent.includes('module')) {
        if (inferredAction) inferredAction.currentState = 'assignments_page';
      } else if (lowerContent.includes('video') || lowerContent.includes('player')) {
        if (inferredAction) inferredAction.currentState = 'video_player';
      } else if (lowerContent.includes('exercise') || lowerContent.includes('question')) {
        if (inferredAction) inferredAction.currentState = 'exercise_info';
      }

      if (inferredAction) {
        const log = require('./logger').log;
        log(`NVIDIA: inferred action from prose: ${inferredAction.actionType} / ${inferredAction.currentState}`, 'INFO', 'nvidia');
        return validateActionResponse({
          ...inferredAction,
          reasoning: `NVIDIA prose response (inferred): ${rawContent.substring(0, 200)}`,
          targetX: 0.5, targetY: 0.5, targetX2: 0.5, targetY2: 0.5,
          keypadSequence: [], submitX: 0.5, submitY: 0.5,
          value: '', clearFirst: true, repeatable: false, skipExactMatch: false,
        }, 'NVIDIA');
      }

      // No JSON found, no keywords matched. Return wait.
      const log = require('./logger').log;
      log(`NVIDIA: no JSON in response, returning wait. Preview: ${rawContent.substring(0, 100)}`, 'WARN', 'nvidia');
      return { actionType: 'wait', currentState: 'unknown', reasoning: `NVIDIA text response (no JSON): ${rawContent.substring(0, 200)}`, targetX: 0, targetY: 0 };
    }

    return validateActionResponse(parsed, 'NVIDIA');
  };
}

module.exports = { NvidiaProvider };
