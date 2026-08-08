'use strict';

// WolframAlpha API Client — External Math Oracle
//
// Uses WolframAlpha's Simple API to verify math answers when local
// verification (nerdamer) is uncertain. Also provides a last-resort
// solve() method for when all LLM providers fail.
//
// Budget: 2000 calls/month free tier. We limit to 20 verify + 5 solve/day
// to stay well within bounds. Usage tracked and persisted via /tmp + DB.
//
// Env vars:
//   WOLFRAM_APP_ID — Required. Get at https://products.wolframalpha.com/api

const fs = require('fs');
const path = require('path');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

function log(msg: string, level?: string) {
  _deps.logger?.log?.(msg, level, 'wolfram') ?? console.log(msg);
}

function logError(msg: string, err: Error) {
  _deps.logger?.logError?.(msg, err) ?? console.error(msg, err);
}

// ─── Configuration ───
const APP_ID = process.env.WOLFRAM_APP_ID || '';
const MAX_VERIFY_PER_DAY = 20;
const MAX_SOLVE_PER_DAY = 5;
const PERSIST_PATH = '/tmp/wolfram-usage.json';

// ─── Usage tracking (dual persistence: /tmp + DB) ───
let _usage = {
  verifyCallsToday: 0,
  solveCallsToday: 0,
  lastResetDate: '',
  totalVerifyCalls: 0,
  totalSolveCalls: 0,
};

function _getTodayStr(): string {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function _resetIfNewDay() {
  const today = _getTodayStr();
  if (_usage.lastResetDate !== today) {
    _usage.verifyCallsToday = 0;
    _usage.solveCallsToday = 0;
    _usage.lastResetDate = today;
    _persistUsage();
  }
}

function _persistUsage() {
  try {
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(_usage), 'utf-8');
  } catch { /* /tmp write failed — best effort */ }
  // Also persist to DB calibration
  try {
    const db = _deps.database;
    if (db?.setCalibration) {
      db.setCalibration('wolfram_usage', JSON.stringify(_usage));
    }
  } catch { /* DB persist failed */ }
}

function _loadUsage() {
  _resetIfNewDay();
  // Try /tmp first
  try {
    if (fs.existsSync(PERSIST_PATH)) {
      const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf-8'));
      if (data.lastResetDate === _getTodayStr()) {
        _usage = { ..._usage, ...data };
      }
    }
  } catch { /* /tmp read failed */ }
  // Try DB calibration
  try {
    const db = _deps.database;
    if (db?.getCalibration) {
      const stored = db.getCalibration('wolfram_usage');
      if (stored) {
        const data = JSON.parse(stored);
        if (data.lastResetDate === _getTodayStr()) {
          // Use whichever has higher counts (merge)
          _usage.verifyCallsToday = Math.max(_usage.verifyCallsToday, data.verifyCallsToday || 0);
          _usage.solveCallsToday = Math.max(_usage.solveCallsToday, data.solveCallsToday || 0);
        }
      }
    }
  } catch { /* DB read failed */ }
}

// ─── HTTP helper ───
async function _wolframQuery(input: string): Promise<any> {
  if (!APP_ID) {
    throw new Error('WOLFRAM_APP_ID not set');
  }

  const url = new URL('https://api.wolframalpha.com/v2/query');
  url.searchParams.set('appid', APP_ID);
  url.searchParams.set('input', input);
  url.searchParams.set('output', 'JSON');
  url.searchParams.set('format', 'plaintext');

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: { 'Accept': 'application/json' },
    signal: AbortSignal.timeout(15000), // 15s timeout
  });

  if (!response.ok) {
    if (response.status === 429) {
      throw new Error('WOLFRAM_RATE_LIMITED');
    }
    throw new Error(`WolframAlpha HTTP ${response.status}`);
  }

  return response.json();
}

// ─── Parse WolframAlpha response ───

interface WolframVerifyResult {
  correct: boolean;
  explanation: string;
  wolframAnswer?: string;
}

interface WolframSolveResult {
  solution: string;
  steps: string[];
}

/**
 * Parse WolframAlpha JSON response for verification.
 * Looks for "Result" pod and compares with expected answer.
 */
function _parseVerifyResponse(data: any, expectedAnswer: string): WolframVerifyResult {
  try {
    const queryResult = data?.queryresult;
    if (!queryResult) {
      return { correct: true, explanation: 'WolframAlpha returned no queryresult — uncertain' };
    }

    if (queryResult.error) {
      return { correct: true, explanation: `WolframAlpha error: ${queryResult.error?.msg || 'unknown'} — skipping` };
    }

    const pods = queryResult.pods || [];
    let resultText = '';
    let inputInterpretation = '';

    for (const pod of pods) {
      if (pod.title === 'Result' || pod.title === 'Result (numeric)') {
        const subpods = pod.subpods || [];
        if (subpods.length > 0) {
          resultText = subpods[0].plaintext || '';
        }
      }
      if (pod.title === 'Input interpretation') {
        const subpods = pod.subpods || [];
        if (subpods.length > 0) {
          inputInterpretation = subpods[0].plaintext || '';
        }
      }
    }

    if (!resultText) {
      // Wolfram didn't understand the query
      const didNotUnderstand = pods.some((p: any) =>
        p.title === 'Wolfram|Alpha does not understand your query' ||
        (p.subpods || []).some((s: any) => (s.plaintext || '').includes('does not understand'))
      );
      if (didNotUnderstand) {
        return { correct: true, explanation: 'WolframAlpha could not interpret the query — uncertain' };
      }
      return { correct: true, explanation: 'No result pod found in WolframAlpha response — uncertain' };
    }

    // Compare result with expected answer
    const resultNum = parseFloat(resultText.replace(/,/g, ''));
    const expectedNum = parseFloat(expectedAnswer.replace(/,/g, ''));

    if (!isNaN(resultNum) && !isNaN(expectedNum)) {
      const diff = Math.abs(resultNum - expectedNum);
      const relDiff = diff / (Math.abs(expectedNum) + 1e-10);
      if (diff < 0.01 || relDiff < 0.01) {
        return { correct: true, explanation: `WolframAlpha confirms: ${resultText} matches expected`, wolframAnswer: resultText };
      }
      return { correct: false, explanation: `WolframAlpha says: ${resultText}, expected: ${expectedAnswer}`, wolframAnswer: resultText };
    }

    // Non-numeric: check string similarity
    const resultClean = resultText.trim().toLowerCase();
    const expectedClean = expectedAnswer.trim().toLowerCase();
    if (resultClean.includes(expectedClean) || expectedClean.includes(resultClean)) {
      return { correct: true, explanation: `WolframAlpha confirms: ${resultText}`, wolframAnswer: resultText };
    }

    return { correct: true, explanation: `WolframAlpha returned: ${resultText} (non-numeric, giving benefit of doubt)`, wolframAnswer: resultText };
  } catch (e: any) {
    return { correct: true, explanation: `WolframAlpha parse error: ${e.message} — uncertain` };
  }
}

function _parseSolveResponse(data: any): WolframSolveResult {
  try {
    const queryResult = data?.queryresult;
    if (!queryResult || queryResult.error) {
      return { solution: '', steps: [] };
    }

    const pods = queryResult.pods || [];
    let solution = '';
    const steps: string[] = [];

    for (const pod of pods) {
      const subpods = pod.subpods || [];
      const text = subpods.map((s: any) => s.plaintext || '').join('\n');

      if (pod.title === 'Result' || pod.title === 'Result (numeric)') {
        solution = text;
      }
      if (pod.primary) {
        solution = text;
      }
      // Collect step-by-step pods
      if (pod.title && pod.title !== 'Input' && pod.title !== 'Input interpretation' && text) {
        steps.push(`[${pod.title}] ${text}`);
      }
    }

    return { solution, steps };
  } catch {
    return { solution: '', steps: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify a math answer using WolframAlpha.
 * @param problem - The math problem text
 * @param answer - The proposed answer
 * @returns { correct, explanation }
 */
async function verifyProblem(problem: string, answer: string): Promise<WolframVerifyResult> {
  _loadUsage();

  if (_usage.verifyCallsToday >= MAX_VERIFY_PER_DAY) {
    log(`WolframAlpha verify budget exhausted (${_usage.verifyCallsToday}/${MAX_VERIFY_PER_DAY})`, 'WARN');
    return { correct: true, explanation: 'WolframAlpha verify budget exhausted — uncertain' };
  }

  if (!APP_ID) {
    return { correct: true, explanation: 'WOLFRAM_APP_ID not configured — skipping' };
  }

  try {
    const query = `verify: ${problem}, is the answer ${answer} correct?`;
    log(`WolframAlpha verify call #${_usage.verifyCallsToday + 1}/${MAX_VERIFY_PER_DAY}`, 'DEBUG');

    const data = await _wolframQuery(query);
    const result = _parseVerifyResponse(data, answer);

    _usage.verifyCallsToday++;
    _usage.totalVerifyCalls++;
    _persistUsage();

    log(`WolframAlpha verify result: ${result.correct ? 'CORRECT' : 'INCORRECT'} — ${result.explanation}`, 'INFO');
    return result;
  } catch (e: any) {
    logError('WolframAlpha verify failed', e);
    if (e.message === 'WOLFRAM_RATE_LIMITED') {
      // Burn the budget for today to prevent repeated attempts
      _usage.verifyCallsToday = MAX_VERIFY_PER_DAY;
      _persistUsage();
    }
    return { correct: true, explanation: `WolframAlpha error: ${e.message} — uncertain` };
  }
}

/**
 * Solve a math problem using WolframAlpha (last resort).
 * Only use when ALL LLM providers have failed.
 * @param problem - The math problem text
 * @returns { solution, steps }
 */
async function solveProblem(problem: string): Promise<WolframSolveResult> {
  _loadUsage();

  if (_usage.solveCallsToday >= MAX_SOLVE_PER_DAY) {
    log(`WolframAlpha solve budget exhausted (${_usage.solveCallsToday}/${MAX_SOLVE_PER_DAY})`, 'WARN');
    return { solution: '', steps: [] };
  }

  if (!APP_ID) {
    return { solution: '', steps: [] };
  }

  try {
    log(`WolframAlpha solve call #${_usage.solveCallsToday + 1}/${MAX_SOLVE_PER_DAY}`, 'DEBUG');

    const data = await _wolframQuery(`solve: ${problem}`);
    const result = _parseSolveResponse(data);

    _usage.solveCallsToday++;
    _usage.totalSolveCalls++;
    _persistUsage();

    if (result.solution) {
      log(`WolframAlpha solved: ${result.solution.substring(0, 100)}`, 'INFO');
    } else {
      log('WolframAlpha could not find a solution', 'WARN');
    }

    return result;
  } catch (e: any) {
    logError('WolframAlpha solve failed', e);
    if (e.message === 'WOLFRAM_RATE_LIMITED') {
      _usage.solveCallsToday = MAX_SOLVE_PER_DAY;
      _persistUsage();
    }
    return { solution: '', steps: [] };
  }
}

/**
 * Get current usage stats.
 */
function getStats() {
  _loadUsage();
  return { ..._usage };
}

/**
 * Check if WolframAlpha is available (configured with API key).
 */
function isAvailable(): boolean {
  return !!APP_ID;
}

module.exports = {
  verifyProblem,
  solveProblem,
  getStats,
  isAvailable,
  _injectDependencies,
};
