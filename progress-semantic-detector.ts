// Resilience R9: Semantic Progress Detection — mathu-bot-resilience-worklog.md
'use strict';

// ═══════════════════════════════════════════════════════════════
// progress-semantic-detector.ts — P1 Semantic Progress Detection
// ═══════════════════════════════════════════════════════════════
// The bot can loop forever if the cycle manager doesn't detect
// that it's making no forward progress. Screenshot-based detection
// misses text changes (e.g., "Question 3" → "Question 4" with the
// same visual layout). This module extracts visible text from the
// page and tracks semantic state transitions.
//
// Features:
//   1. Extract visible text via page.evaluate(document.body.innerText)
//   2. Parse for mathematical progress indicators:
//      - "Question X of Y", "Score:", "Correct!", "Module X"
//   3. Track semantic state transitions: if semantic state doesn't
//      change after N actions, force skip
//   4. Detect score screens, completion screens, error screens
//   5. Complementary to screenshot-based stagnation detection
//   6. Provides getSemanticState(page) → structured state object
//
// Integration:
//   - cycle-cycle-manager.ts calls getSemanticState() in main loop
//   - cycle-cycle-manager.ts checks hasProgress() alongside screenshot check
//
// Config:
//   SEMANTIC_DETECTOR_STAGNATION_ACTIONS — number of actions without
//     semantic change before declaring stagnation (default 8)
// ═══════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): Record<string, any> {
  return (_deps as any).config || {};
}

function log(msg: string, level: string = 'INFO', mod: string = 'semantic-detector') {
  try {
    const logger = (_deps as any).logger;
    if (logger?.log) { logger.log(msg, level, mod); return; }
  } catch { /* fall through */ }
  console.log(`[${level}] [${mod}] ${msg}`);
}

// ─── Types ───
interface SemanticState {
  questionNumber: number | null;
  totalQuestions: number | null;
  module: string | null;
  score: number | null;
  maxScore: number | null;
  isScoreScreen: boolean;
  isCompletionScreen: boolean;
  isErrorScreen: boolean;
  isAuthScreen: boolean;
  isAssignmentsScreen: boolean;
  rawText: string;
  textHash: string;
  timestamp: number;
}

interface StagnationRecord {
  actionCount: number;
  lastStateHash: string;
  lastChangeTime: number;
  declaredStagnant: boolean;
}

// ─── Constants ───
const DEFAULT_STAGNATION_ACTIONS = 8;

// ─── State ───
let _lastState: SemanticState | null = null;
let _stateHistory: SemanticState[] = [];         // last 20 states
let _stagnationRecord: StagnationRecord = {
  actionCount: 0,
  lastStateHash: '',
  lastChangeTime: Date.now(),
  declaredStagnant: false,
};
let _started = false;

// ─── Helpers ───

function _getStagnationThreshold(): number {
  const CONFIG = getCONFIG();
  const val = Number(CONFIG.SEMANTIC_DETECTOR_STAGNATION_ACTIONS);
  return (val > 0 && Number.isFinite(val)) ? val : DEFAULT_STAGNATION_ACTIONS;
}

/**
 * Simple hash of text content for change detection.
 * Not cryptographic — just for fast comparison.
 */
function _hashText(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash; // Convert to 32-bit integer
  }
  return hash.toString(36);
}

/**
 * Parse question number from text patterns.
 */
function _parseQuestionNumber(text: string): { question: number | null; total: number | null } {
  // Patterns: "Question 3 of 10", "Question 3/10", "Q.3", "#3", "Problem 3"
  const patterns = [
    /(?:question|problem|q\.?)\s*(\d+)\s*(?:of|\/|out\s*of)\s*(\d+)/i,
    /(\d+)\s*(?:of|\/|out\s*of)\s*(\d+)\s*(?:questions?|problems?)/i,
    /(?:question|problem|q\.?)\s*(\d+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      return {
        question: parseInt(match[1], 10),
        total: match[2] ? parseInt(match[2], 10) : null,
      };
    }
  }

  return { question: null, total: null };
}

/**
 * Parse score from text patterns.
 */
function _parseScore(text: string): { score: number | null; maxScore: number | null } {
  const patterns = [
    /(?:score|grade|result)[:\s]*(\d+)(?:\s*[\/%]\s*|\s*out\s*of\s*)(\d+)/i,
    /(\d+)\s*[\/%]\s*(\d+)\s*(?:correct|score|grade|points)/i,
    /(\d+)\s*(?:out\s*of)\s*(\d+)/i,
    /(\d+(?:\.\d+)?)\s*%/i,  // "85%" — treat as score out of 100
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      if (pattern.source.includes('%') && !match[2]) {
        // Percentage pattern without max
        return { score: parseFloat(match[1]), maxScore: 100 };
      }
      return {
        score: parseFloat(match[1]),
        maxScore: parseFloat(match[2]),
      };
    }
  }

  return { score: null, maxScore: null };
}

/**
 * Detect module name from text.
 */
function _parseModule(text: string): string | null {
  const patterns = [
    /(?:module|chapter|unit|section|topic)[:\s]*([^\n,.]+)/i,
    /(?:now\s+(?:working\s+on|practicing|studying)[:\s]*)([^\n,.]+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1].trim().length > 0 && match[1].trim().length < 100) {
      return match[1].trim();
    }
  }

  return null;
}

/**
 * Detect screen type from text content.
 */
function _detectScreenType(text: string): {
  isScoreScreen: boolean;
  isCompletionScreen: boolean;
  isErrorScreen: boolean;
  isAuthScreen: boolean;
  isAssignmentsScreen: boolean;
} {
  const lower = text.toLowerCase();

  return {
    isScoreScreen: /(?:your\s+score|score:|grade:|results?|performance|summary)/i.test(lower) &&
                   /(?:\d+\s*[\/%]\s*\d+|\d+\s*out\s*of)/i.test(lower),
    isCompletionScreen: /(?:congratulations|complete!|well\s+done|finished|all\s+done|module\s+complete|unit\s+complete)/i.test(lower),
    isErrorScreen: /(?:error|oops|something\s+went\s+wrong|page\s+not\s+found|500|404|forbidden|access\s+denied)/i.test(lower),
    isAuthScreen: /(?:sign\s*in|log\s*in|login|password|enter\s+your|authentication)/i.test(lower) &&
                 !/sign\s*out|log\s*out/i.test(lower),
    isAssignmentsScreen: /(?:assignments?|homework|tasks?|due|upcoming|your\s+(?:assignments?|work|tasks))/i.test(lower),
  };
}

// ─── Core API ───

/**
 * Extract semantic state from a Playwright page.
 * Returns a structured object with parsed progress indicators.
 */
async function getSemanticState(page: any): Promise<SemanticState | null> {
  if (!page || typeof page.evaluate !== 'function') {
    return null;
  }

  try {
    const rawText = await page.evaluate(() => {
      try {
        // Get visible text only (exclude script/style content)
        const body = document.body;
        if (!body) return '';
        const clone = body.cloneNode(true) as HTMLElement;
        const scripts = clone.querySelectorAll('script, style, noscript');
        scripts.forEach(s => s.remove());
        return clone.innerText || body.innerText || '';
      } catch {
        return document.body?.innerText || '';
      }
    });

    if (!rawText || rawText.trim().length === 0) {
      return null;
    }

    const { question, total } = _parseQuestionNumber(rawText);
    const { score, maxScore } = _parseScore(rawText);
    const module = _parseModule(rawText);
    const screenType = _detectScreenType(rawText);
    const textHash = _hashText(rawText);

    const state: SemanticState = {
      questionNumber: question,
      totalQuestions: total,
      module,
      score,
      maxScore,
      isScoreScreen: screenType.isScoreScreen,
      isCompletionScreen: screenType.isCompletionScreen,
      isErrorScreen: screenType.isErrorScreen,
      isAuthScreen: screenType.isAuthScreen,
      isAssignmentsScreen: screenType.isAssignmentsScreen,
      rawText: rawText.substring(0, 500),  // Store truncated raw text
      textHash,
      timestamp: Date.now(),
    };

    // Update internal state
    _lastState = state;
    _stateHistory.push(state);
    if (_stateHistory.length > 20) _stateHistory.shift();

    // Check for state change and update stagnation record
    if (state.textHash !== _stagnationRecord.lastStateHash) {
      _stagnationRecord = {
        actionCount: 0,
        lastStateHash: state.textHash,
        lastChangeTime: Date.now(),
        declaredStagnant: false,
      };
    }

    return state;
  } catch (err: any) {
    log(`getSemanticState failed: ${err?.message || err}`, 'WARN', 'semantic-detector');
    return null;
  }
}

/**
 * Record that an action was taken. Updates stagnation counter.
 * Returns true if stagnation has been declared.
 */
function recordAction(): boolean {
  _stagnationRecord.actionCount++;
  const threshold = _getStagnationThreshold();

  if (
    !_stagnationRecord.declaredStagnant &&
    _stagnationRecord.actionCount >= threshold
  ) {
    _stagnationRecord.declaredStagnant = true;
    log(
      `Semantic stagnation declared after ${_stagnationRecord.actionCount} actions without change (threshold: ${threshold})`,
      'WARN', 'semantic-detector'
    );
    return true;
  }

  return false;
}

/**
 * Check whether semantic progress has been made since the last call.
 * Compares current lastState hash against the previous one.
 */
function hasProgress(): boolean {
  if (_stateHistory.length < 2) return true; // Not enough data to declare stagnation
  const prev = _stateHistory[_stateHistory.length - 2];
  const curr = _stateHistory[_stateHistory.length - 1];
  return prev.textHash !== curr.textHash;
}

/**
 * Reset internal state (e.g., on new session or module change).
 */
function reset(): void {
  _lastState = null;
  _stateHistory = [];
  _stagnationRecord = {
    actionCount: 0,
    lastStateHash: '',
    lastChangeTime: Date.now(),
    declaredStagnant: false,
  };
  _started = false;
}

/**
 * Start the detector (mark as active). No-op if already started.
 */
function start(): void {
  if (!_started) {
    _started = true;
    log('Semantic progress detector started', 'INFO', 'semantic-detector');
  }
}

// ─── Module Exports ───
export {
  _injectDependencies,
  getSemanticState,
  recordAction,
  hasProgress,
  reset,
  start,
};
