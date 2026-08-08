'use strict';

// Math Verification Module
// Catches the #1 failure mode: LLMs returning confidently wrong math answers.
//
// Three-tier verification:
//   Tier 0 (instant, free): Numeric equality check
//   Tier 1 (fast, free):    nerdamer symbolic verification
//   Tier 2 (slow, costs 1 Wolfram call): WolframAlpha oracle (external)
//
// The cycle manager calls verifyAnswer() before submitting. If verification
// fails, the cycle can retry with a different approach or skip the question.

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

function log(msg: string, level?: string) {
  _deps.logger?.log?.(msg, level, 'math-verify') ?? console.log(msg);
}

// ─── nerdamer (lazy load — only when needed) ───
let _nerdamer: any = null;
function _getNerdamer() {
  if (_nerdamer) return _nerdamer;
  try {
    _nerdamer = require('nerdamer');
    // Load additional modules for solve, trig, etc.
    try { require('nerdamer/Algebra'); } catch { /* optional */ }
    try { require('nerdamer/Calculus'); } catch { /* optional */ }
    try { require('nerdamer/Solve'); } catch { /* optional */ }
    try { require('nerdamer/Trig'); } catch { /* optional */ }
    log('nerdamer loaded successfully', 'DEBUG');
  } catch (e: any) {
    log(`nerdamer not available: ${e.message}. Tier 1 verification disabled.`, 'WARN');
    _nerdamer = false; // mark as permanently unavailable
  }
  return _nerdamer;
}

// ─── WolframAlpha service (lazy load from DI) ───
function _getWolfram(): any {
  return _deps.wolfram || null;
}

// ─── Result type ───
interface VerifyResult {
  correct: boolean;
  confidence: number;    // 0-1, how sure we are about this result
  method: string;       // 'numeric' | 'nerdamer' | 'wolfram' | 'unknown'
  explanation: string;
}

// ─── Stats tracking ───
let _stats = {
  totalChecks: 0,
  numericPassed: 0,
  nerdamerPassed: 0,
  nerdamerFailed: 0,
  nerdamerUncertain: 0,
  wolframPassed: 0,
  wolframFailed: 0,
  wolframSkipped: 0,
};

function getStats() { return { ..._stats }; }

// ═══════════════════════════════════════════════════════════════════════════
// Tier 0: Numeric Equality Check (instant, zero-cost)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract a numeric answer from text. Handles:
 *   - Plain numbers: "42", "-3.14"
 *   - Fractions: "3/4" → 0.75
 *   - Percentages: "50%" → 50
 *   -/pi, e constants: "3.14" (approximate matching)
 *   - Comma-separated: "1,234" → 1234
 */
function _extractNumeric(text: string): number | null {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.trim()
    .replace(/,/g, '')
    .replace(/\s/g, '');

  // Try direct parseFloat
  const num = parseFloat(cleaned);
  if (!isNaN(num) && isFinite(num)) return num;

  // Try fraction: "3/4"
  const fracMatch = cleaned.match(/^(-?\d+)\/(\d+)$/);
  if (fracMatch) {
    const result = parseFloat(fracMatch[1]) / parseFloat(fracMatch[2]);
    if (isFinite(result)) return result;
  }

  // Try percentage: "50%"
  const pctMatch = cleaned.match(/^(-?\d+(?:\.\d+)?)%$/);
  if (pctMatch) return parseFloat(pctMatch[1]);

  return null;
}

/**
 * Compare two numeric answers with tolerance.
 * Returns: true if within tolerance, false if clearly different, null if can't compare.
 */
function _numericEquals(a: number, b: number, tolerance: number = 0.01): boolean | null {
  // Exact match
  if (a === b) return true;

  // Relative tolerance for large numbers, absolute for small
  const absDiff = Math.abs(a - b);
  const relDiff = absDiff / (Math.abs(a) + Math.abs(b) + 1e-10);

  if (absDiff < tolerance) return true;
  if (relDiff < 0.01) return true; // 1% relative tolerance

  // Clearly different
  if (absDiff > tolerance * 10 && relDiff > 0.05) return false;

  // Ambiguous — too close to call
  return null;
}

/**
 * Tier 0: Quick numeric comparison.
 * Returns VerifyResult or null if non-numeric (skip to Tier 1).
 */
function _verifyNumeric(answer: string, expected: string): VerifyResult | null {
  const ansNum = _extractNumeric(answer);
  const expNum = _extractNumeric(expected);

  if (ansNum === null || expNum === null) return null; // can't compare numerically

  const result = _numericEquals(ansNum, expNum);
  if (result === null) {
    return {
      correct: true, // too close to call — give benefit of doubt
      confidence: 0.3,
      method: 'numeric',
      explanation: `Numeric comparison ambiguous: ${ansNum} vs ${expNum} (within tolerance)`,
    };
  }

  _stats.totalChecks++;
  if (result) _stats.numericPassed++;

  return {
    correct: result,
    confidence: 0.95,
    method: 'numeric',
    explanation: result
      ? `Numeric match: ${ansNum} = ${expNum}`
      : `Numeric mismatch: ${ansNum} != ${expNum}`,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tier 1: nerdamer Symbolic Verification (fast, free, local)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Extract a math expression from natural language text.
 * Handles patterns like:
 *   "x = 3"        → "x=3"
 *   "2x + 1 = 7"   → "2*x+1=7"
 *   "the answer is 42" → "42"
 *   "3/4"          → "3/4"
 */
function _extractExpression(text: string): string | null {
  if (!text || typeof text !== 'string') return null;
  const cleaned = text.trim();

  // Direct equation pattern: "x = 3", "2x+1=7", "y = 2x + 3"
  const eqMatch = cleaned.match(/(?:the\s+(?:answer|solution|result|value)\s+(?:is|equals?)\s+)?(.+)/i);
  if (eqMatch) {
    let expr = eqMatch[1].trim();
    // Remove trailing punctuation
    expr = expr.replace(/[.,;:!]+$/, '').trim();
    if (expr.length > 0 && expr.length < 200) return expr;
  }

  // If the whole thing looks like a math expression, use it directly
  const mathPattern = /^[\d\s\w\+\-\*\/\^\(\)\.\,=<>]+$/;
  if (mathPattern.test(cleaned) && cleaned.length < 200) return cleaned;

  return null;
}

/**
 * Try to verify using nerdamer symbolic math.
 * Returns 'correct', 'incorrect', or 'uncertain'.
 */
function _verifyNerdamer(problem: string, answer: string): 'correct' | 'incorrect' | 'uncertain' {
  const nerdamer = _getNerdamer();
  if (!nerdamer) return 'uncertain';

  try {
    // Strategy 1: If the problem is an equation and answer is a value,
    // substitute the answer back and check if it holds.
    const eqMatch = problem.match(/(?:solve|find|what is)\s+(.+)/i) ||
                    problem.match(/(.+?)\s*[=]\s*(.+)/);

    if (eqMatch) {
      const expr = _extractExpression(answer);
      if (!expr) return 'uncertain';

      // Try to substitute and verify
      // e.g., problem="2x+1=7", answer="x=3" → check 2(3)+1=7
      try {
        // Extract variable and value from answer
        const varMatch = expr.match(/([a-zA-Z])\s*=\s*(.+)/);
        if (varMatch) {
          const variable = varMatch[1];
          const value = varMatch[2];

          // Substitute into the problem equation
          let problemExpr = problem.replace(/^(?:solve|find|what is)\s+/i, '').trim();

          // Replace variable with value
          const substituted = problemExpr.replace(new RegExp(variable, 'g'), `(${value})`);

          // Evaluate both sides
          const sides = substituted.split('=');
          if (sides.length === 2) {
            const left = nerdamer(sides[0].trim()).evaluate();
            const right = nerdamer(sides[1].trim()).evaluate();
            const leftNum = parseFloat(left.text());
            const rightNum = parseFloat(right.text());

            if (!isNaN(leftNum) && !isNaN(rightNum)) {
              const diff = Math.abs(leftNum - rightNum);
              if (diff < 0.01) return 'correct';
              if (diff > 0.1) return 'incorrect';
            }
          }
        }
      } catch { /* substitution failed, try next strategy */ }

      // Strategy 2: Use nerdamer's solve to find the actual answer
      try {
        const solveExpr = problem.replace(/^(?:solve|find|what is|calculate)\s+/i, '').trim();
        // nerdamer can solve equations of the form "expr=0"
        let nerdamerExpr = solveExpr;
        if (solveExpr.includes('=')) {
          const sides = solveExpr.split('=');
          nerdamerExpr = `(${sides[0].trim()})-(${sides[1].trim()})`;
        }

        const solutions = nerdamer.solve(nerdamerExpr, 'x');
        const solutionText = solutions.text();

        // Extract numeric solutions
        const solNums: number[] = [];
        const numMatches = solutionText.match(/-?\d+\.?\d*/g);
        if (numMatches) {
          for (const m of numMatches) {
            const n = parseFloat(m);
            if (!isNaN(n) && isFinite(n)) solNums.push(n);
          }
        }

        // Compare with the provided answer
        const ansNum = _extractNumeric(answer);
        if (ansNum !== null && solNums.length > 0) {
          for (const sol of solNums) {
            if (_numericEquals(ansNum, sol) === true) return 'correct';
          }
          // None matched
          return 'incorrect';
        }
      } catch { /* solve failed */ }
    }

    // Strategy 3: Direct expression evaluation comparison
    // If both problem and answer are expressions, evaluate and compare
    const probExpr = _extractExpression(problem);
    const ansExpr = _extractExpression(answer);
    if (probExpr && ansExpr) {
      try {
        const probVal = nerdamer(probExpr).evaluate();
        const ansVal = nerdamer(ansExpr).evaluate();
        const probNum = parseFloat(probVal.text());
        const ansNum = parseFloat(ansVal.text());

        if (!isNaN(probNum) && !isNaN(ansNum)) {
          const result = _numericEquals(probNum, ansNum);
          if (result === true) return 'correct';
          if (result === false) return 'incorrect';
        }
      } catch { /* evaluation failed */ }
    }

    return 'uncertain';
  } catch (e: any) {
    log(`nerdamer verification error: ${e.message}`, 'WARN');
    return 'uncertain';
  }
}

/**
 * Tier 1: Verify using nerdamer symbolic math.
 * Returns null if nerdamer is unavailable or result is uncertain.
 */
function _verifyTier1(problem: string, answer: string): VerifyResult | null {
  const nerdamer = _getNerdamer();
  if (!nerdamer) return null;

  const result = _verifyNerdamer(problem, answer);
  _stats.totalChecks++;

  if (result === 'correct') {
    _stats.nerdamerPassed++;
    return {
      correct: true,
      confidence: 0.85,
      method: 'nerdamer',
      explanation: 'Symbolic verification: answer confirmed by nerdamer',
    };
  }
  if (result === 'incorrect') {
    _stats.nerdamerFailed++;
    return {
      correct: false,
      confidence: 0.85,
      method: 'nerdamer',
      explanation: 'Symbolic verification: answer contradicted by nerdamer',
    };
  }

  _stats.nerdamerUncertain++;
  return null; // uncertain — escalate to Tier 2
}

// ═══════════════════════════════════════════════════════════════════════════
// Combined verifyAnswer() — the main entry point
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify a math answer against a problem.
 *
 * @param problemText - The math problem (e.g., "Solve 2x + 1 = 7")
 * @param proposedAnswer - The LLM's proposed answer (e.g., "x = 3")
 * @param options
 *   - useWolfram: boolean (default true) — whether to escalate to WolframAlpha
 *   - maxWolframCalls: number (default 20) — daily Wolfram call budget
 * @returns VerifyResult with correct/confidence/method/explanation
 */
async function verifyAnswer(
  problemText: string,
  proposedAnswer: string,
  options: { useWolfram?: boolean; maxWolframCalls?: number } = {}
): Promise<VerifyResult> {
  const { useWolfram = true, maxWolframCalls = 20 } = options;

  if (!problemText || !proposedAnswer) {
    return {
      correct: true, // can't verify, allow it
      confidence: 0,
      method: 'unknown',
      explanation: 'Empty problem or answer — skipped verification',
    };
  }

  // Tier 0: Numeric check (instant)
  const numericResult = _verifyNumeric(proposedAnswer, problemText);
  if (numericResult && numericResult.confidence >= 0.9) {
    return numericResult;
  }

  // Tier 1: nerdamer symbolic (fast, free)
  const nerdamerResult = _verifyTier1(problemText, proposedAnswer);
  if (nerdamerResult && nerdamerResult.confidence >= 0.8) {
    return nerdamerResult;
  }

  // Tier 2: WolframAlpha oracle (slow, costs API call)
  if (useWolfram) {
    const wolfram = _getWolfram();
    if (wolfram) {
      // Check daily budget
      const wolframStats = wolfram.getStats?.() || { verifyCallsToday: 0 };
      if (wolframStats.verifyCallsToday < maxWolframCalls) {
        try {
          const wolframResult = await wolfram.verifyProblem(problemText, proposedAnswer);
          _stats.totalChecks++;
          if (wolframResult.correct) {
            _stats.wolframPassed++;
          } else {
            _stats.wolframFailed++;
          }
          return {
            correct: wolframResult.correct,
            confidence: 0.95,
            method: 'wolfram',
            explanation: `WolframAlpha: ${wolframResult.explanation}`,
          };
        } catch (e: any) {
          log(`WolframAlpha verification failed: ${e.message}`, 'WARN');
          _stats.wolframSkipped++;
        }
      } else {
        log(`WolframAlpha daily budget exhausted (${wolframStats.verifyCallsToday}/${maxWolframCalls})`, 'WARN');
        _stats.wolframSkipped++;
      }
    }
  }

  // All tiers exhausted or uncertain — give benefit of doubt
  return {
    correct: true,
    confidence: 0.3,
    method: 'unknown',
    explanation: 'Could not verify answer — all verification tiers exhausted or uncertain',
  };
}

/**
 * Quick check: should we even attempt verification?
 * Returns false for non-math states (score_screen, menu, etc.)
 */
function shouldVerify(currentState: string): boolean {
  const mathStates = [
    'solving',
    'problem_visible',
    'answering',
    'input_visible',
    'keypad_visible',
    'assessment',
  ];
  // If currentState contains math-related keywords
  const lower = currentState.toLowerCase();
  if (lower.includes('solv') || lower.includes('problem') ||
      lower.includes('answer') || lower.includes('input') ||
      lower.includes('keypad') || lower.includes('math') ||
      lower.includes('assess') || lower.includes('quiz')) {
    return true;
  }
  return mathStates.some(s => lower.includes(s));
}

// ═══════════════════════════════════════════════════════════════════════════
// Cached Solution Verification (Response 5)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Verify a cached solution before reusing it.
 * Uses only Tier 0 (numeric) and Tier 1 (nerdamer) — skips WolframAlpha
 * to save budget on cache hits (the whole point of caching is to save resources).
 *
 * @param problemText - The current problem text
 * @param cachedAnswer - The cached answer to verify
 * @returns VerifyResult with correct/confidence/method
 */
async function verifyCachedSolution(problemText: string, cachedAnswer: string): Promise<VerifyResult> {
  if (!problemText || !cachedAnswer) {
    return { correct: true, confidence: 0.1, method: 'unknown', explanation: 'Empty inputs — skipped' };
  }

  // Tier 0: Numeric check (instant)
  const numericResult = _verifyNumeric(cachedAnswer, problemText);
  if (numericResult && numericResult.confidence >= 0.9) {
    return numericResult;
  }

  // Tier 1: nerdamer symbolic (fast, free) — but no Wolfram escalation
  const nerdamerResult = _verifyTier1(problemText, cachedAnswer);
  if (nerdamerResult && nerdamerResult.confidence >= 0.8) {
    return nerdamerResult;
  }

  // Can't verify with free tiers — allow with low confidence
  return {
    correct: true,
    confidence: 0.2,
    method: 'unknown',
    explanation: 'Cached solution could not be verified with free tiers — allowing reuse',
  };
}

module.exports = {
  verifyAnswer,
  verifyCachedSolution,
  shouldVerify,
  getStats,
  _injectDependencies,
};
