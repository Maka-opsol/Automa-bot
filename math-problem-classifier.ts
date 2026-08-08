'use strict';
// Last modified: 2026-08-08 — Response 4: Problem-type classification + prompt strategies

// ═══════════════════════════════════════════════════════════════════════════════
// Math Problem Classifier — Classifies screenshots into math problem types
// and provides tailored solving prompts for each type.
//
// Classification uses TWO methods:
//   1. Fast path (regex): Scan OCR text for keyword patterns
//   2. LLM path (only if fast = UNKNOWN): Ask vision model for type
//
// Also includes:
//   - LaTeX-to-plain-text simplifier for Mathpix output
//   - OCR quality heuristics (detect garbled text from vision models)
//   - Model-type affinity tracking (which models are best at which types)
// ═══════════════════════════════════════════════════════════════════════════════

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }

// ─── Problem Types ──────────────────────────────────────────────────────────

export type ProblemType =
  | 'LINEAR_EQUATION'
  | 'QUADRATIC'
  | 'CALCULUS'
  | 'GEOMETRY'
  | 'WORD_PROBLEM'
  | 'STATISTICS'
  | 'PROOF'
  | 'GRAPHING'
  | 'SYSTEM_OF_EQUATIONS'
  | 'FRACTIONS'
  | 'EXPONENTS'
  | 'ALGEBRAIC_EXPRESSION'
  | 'NUMBER_PATTERN'
  | 'UNKNOWN';

const PROBLEM_TYPES: ProblemType[] = [
  'LINEAR_EQUATION', 'QUADRATIC', 'CALCULUS', 'GEOMETRY',
  'WORD_PROBLEM', 'STATISTICS', 'PROOF', 'GRAPHING',
  'SYSTEM_OF_EQUATIONS', 'FRACTIONS', 'EXPONENTS',
  'ALGEBRAIC_EXPRESSION', 'NUMBER_PATTERN', 'UNKNOWN',
];

// ─── Regex Patterns (Fast Path) ─────────────────────────────────────────────

const TYPE_PATTERNS: Array<{ type: ProblemType; patterns: RegExp[]; weight: number }> = [
  {
    type: 'CALCULUS',
    weight: 10,
    patterns: [
      /\b(derivative|differentiate|d\/dx|f'[(\s]|integral|antiderivative|definite integral|indefinite integral)\b/i,
      /\b(calculus|limit|continuity|riemann|taylor|maclaurin)\b/i,
      /(?:∫|\\int|\\sum)/,  // LaTeX integral/sum symbols
      /\b(find|determine|compute)\s+(the\s+)?(derivative|rate\s+of\s+change|slope)\b/i,
    ],
  },
  {
    type: 'PROOF',
    weight: 10,
    patterns: [
      /\b(prove|show\s+that|demonstrate|verify|justify)\b/i,
      /\b(given\s+that|assume|suppose|it\s+follows)\b/i,
      /\b(QED|therefore|hence|thus)\s/i,
      /\b(contradiction|induction|direct\s+proof|proof\s+by)\b/i,
    ],
  },
  {
    type: 'GEOMETRY',
    weight: 8,
    patterns: [
      /\b(area|perimeter|circumference|volume|surface\s+area)\b/i,
      /\b(triangle|rectangle|circle|sphere|cylinder|cone|pyramid)\b/i,
      /\b(Pythagorean|hypotenuse|altitude|bisect|perpendicular|parallel)\b/i,
      /\b(angle|degrees|radians|sin|cos|tan)\b/i,
      /\b(coordinate|plane|slope|midpoint|distance\s+formula)\b/i,
    ],
  },
  {
    type: 'STATISTICS',
    weight: 8,
    patterns: [
      /\b(mean|median|mode|range|standard\s+deviation|variance)\b/i,
      /\b(probability|combination|permutation|factorial)\b/i,
      /\b(histogram|frequency|distribution|normal|bell\s+curve)\b/i,
      /\b(outlier|quartile|percentile|interquartile)\b/i,
    ],
  },
  {
    type: 'GRAPHING',
    weight: 7,
    patterns: [
      /\b(plot|graph|sketch|draw)\b/i,
      /\b(axis|coordinate\s+plane|quadrant|vertex|parabola)\b/i,
      /\b(intercept|x-intercept|y-intercept|asymptote)\b/i,
      /\b(increasing|decreasing|maximum|minimum|turning\s+point)\b/i,
    ],
  },
  {
    type: 'SYSTEM_OF_EQUATIONS',
    weight: 9,
    patterns: [
      /\b(system|simultaneous|solve\s+(the\s+)?(for|the\s+system))\b/i,
      /\b(substitution|elimination|matrix|cramer/i,
      /\{[^}]*,[^}]*\}/,  // { eq1, eq2 } pattern
    ],
  },
  {
    type: 'QUADRATIC',
    weight: 7,
    patterns: [
      /\b(quadratic|parabola|discriminant|vertex\s+form)\b/i,
      /\b(factorise|factorize|complete\s+the\s+square)\b/i,
      /\b(ax\s*\^?\s*2|ax2|x\s*2\s*[+\-=])/,  // x^2 or x2 patterns
      /(?:x\s*[+\-]\s*\d+\s*[+\-]?\s*\d+)/,  // polynomial-like
    ],
  },
  {
    type: 'EXPONENTS',
    weight: 6,
    patterns: [
      /\b(exponent|power|index|indices)\b/i,
      /\b(scientific\s+notation|standard\s+form)\b/i,
      /\b(simplify|evaluate).*\^/i,
      /\d+\s*\^\s*\d+/,  // 2^3 pattern
    ],
  },
  {
    type: 'FRACTIONS',
    weight: 5,
    patterns: [
      /\b(fraction|numerator|denominator|improper|mixed\s+number)\b/i,
      /\b(simplify|add|subtract|multiply|divide)\s+(the\s+)?(fraction|fractions)\b/i,
      /\\frac\{/,  // LaTeX fraction
    ],
  },
  {
    type: 'LINEAR_EQUATION',
    weight: 5,
    patterns: [
      /\b(solve\s+(for|the\s+equation))\b/i,
      /\b(find\s+x|find\s+the\s+value|determine\s+x)\b/i,
      /[=].*[xX].*[+\-\*\/].*\d/,  // equation with x and number
      /\b(equation|expression|formula)\b/i,
    ],
  },
  {
    type: 'NUMBER_PATTERN',
    weight: 5,
    patterns: [
      /\b(pattern|sequence|series|nth\s+term|arithmetic|geometric)\b/i,
      /\b(next\s+term|find\s+the\s+next|continue\s+the)\b/i,
      /\b(fibonacci|triangular|square\s+numbers)\b/i,
    ],
  },
  {
    type: 'WORD_PROBLEM',
    weight: 3,
    patterns: [
      /\b(if\s+|when\s+|each\s+|total\s+|how\s+many|how\s+much)\b/i,
      /\b(costs?\s+\$|percent|percentage|rate|per|ratio)\b/i,
      /\b(more\s+than|less\s+than|twice|half|double|triple)\b/i,
    ],
  },
  {
    type: 'ALGEBRAIC_EXPRESSION',
    weight: 4,
    patterns: [
      /\b(simplify|expand|collect|factor)\b/i,
      /\b(algebraic\s+expression|polynomial|binomial|trinomial)\b/i,
      /\b(like\s+terms|coefficients|variables)\b/i,
    ],
  },
];

// ─── Prompt Strategies ──────────────────────────────────────────────────────

const TYPE_PROMPTS: Record<string, string> = {
  LINEAR_EQUATION: `Solve this linear equation step by step. Show all working.
Steps:
1. Identify the variable and constants
2. Isolate the variable on one side
3. Perform inverse operations
4. State the final answer clearly as x = [value]`,

  QUADRATIC: `Solve this quadratic equation step by step.
Choose the best method: factoring, quadratic formula, or completing the square.
Show all working and state both solutions if applicable.`,

  CALCULUS: `Compute this calculus problem step by step.
Show all working with proper mathematical notation.
State the final answer clearly.`,

  GEOMETRY: `Solve this geometry problem step by step.
1. Identify all given values and what to find
2. State the relevant formula
3. Show substitution of values
4. Include units in the final answer`,

  WORD_PROBLEM: `Read this word problem carefully.
1. Identify what is being asked (the unknown)
2. Extract all numerical information
3. Set up the equation or expression
4. Solve step by step
5. Check that the answer makes sense in context`,

  STATISTICS: `Solve this statistics problem step by step.
1. Identify the data and what is being asked
2. Apply the correct formula or method
3. Show all calculations
4. Interpret the result`,

  PROOF: `Provide a clear mathematical proof.
1. State what is given
2. State what needs to be proved
3. Provide logical step-by-step reasoning
4. End with a clear conclusion (QED or "Therefore, ...")`,

  GRAPHING: `Analyze this graphing problem step by step.
1. Identify the type of function or relationship
2. Find key features (intercepts, vertex, asymptotes)
3. Describe the graph's behavior
4. If asked to sketch, provide the key points`,

  SYSTEM_OF_EQUATIONS: `Solve this system of equations step by step.
Use substitution or elimination method.
Show all working and verify your solution satisfies both equations.`,

  FRACTIONS: `Solve this fraction problem step by step.
1. Identify the operation needed
2. Find common denominators if required
3. Perform the operation
4. Simplify the result to lowest terms`,

  EXPONENTS: `Solve this exponent problem step by step.
Apply the exponent rules correctly.
Show all simplification steps.`,

  ALGEBRAIC_EXPRESSION: `Simplify this algebraic expression step by step.
1. Expand brackets if needed
2. Collect like terms
3. Factor if possible
4. Show the final simplified form`,

  NUMBER_PATTERN: `Find the pattern in this number sequence.
1. Look at the differences between consecutive terms
2. Identify if arithmetic, geometric, or other pattern
3. State the general rule
4. Find the requested term(s)`,

  UNKNOWN: `Analyze this problem and solve step by step. Show all working.`,
};

// ─── LaTeX Simplifier ──────────────────────────────────────────────────────

/**
 * Converts common LaTeX notation to plain text for models
 * that don't handle LaTeX well.
 */
function simplifyLatex(text: string): string {
  let result = text;
  // Fractions: \frac{a}{b} → (a/b)
  result = result.replace(/\\frac\{([^}]*)\}\{([^}]*)\}/g, '($1/$2)');
  // Square root: \sqrt{x} → sqrt(x)
  result = result.replace(/\\sqrt\{([^}]*)\}/g, 'sqrt($1)');
  // nth root: \sqrt[n]{x} → nth_root(x)
  result = result.replace(/\\sqrt\[([^\]]*)\]\{([^}]*)\}/g, '$1th_root($2)');
  // Superscripts: x^{n} → x^n
  result = result.replace(/\^{([^}]*)}/g, '^$1');
  // Subscripts: x_{n} → x_n
  result = result.replace(/_{([^}]*)}/g, '_$1');
  // Greek letters
  result = result.replace(/\\alpha/g, 'alpha');
  result = result.replace(/\\beta/g, 'beta');
  result = result.replace(/\\gamma/g, 'gamma');
  result = result.replace(/\\delta/g, 'delta');
  result = result.replace(/\\theta/g, 'theta');
  result = result.replace(/\\pi/g, 'pi');
  result = result.replace(/\\sigma/g, 'sigma');
  result = result.replace(/\\omega/g, 'omega');
  // Common math symbols
  result = result.replace(/\\times/g, 'x');
  result = result.replace(/\\div/g, '/');
  result = result.replace(/\\pm/g, '+/-');
  result = result.replace(/\\leq/g, '<=');
  result = result.replace(/\\geq/g, '>=');
  result = result.replace(/\\neq/g, '!=');
  result = result.replace(/\\approx/g, '~');
  result = result.replace(/\\infty/g, 'infinity');
  result = result.replace(/\\rightarrow/g, '->');
  // Integral/sum
  result = result.replace(/\\int/g, 'integral');
  result = result.replace(/\\sum/g, 'sum');
  result = result.replace(/\\prod/g, 'product');
  // Remove remaining backslash commands
  result = result.replace(/\\[a-zA-Z]+/g, '');
  // Clean up extra spaces
  result = result.replace(/\s{2,}/g, ' ').trim();
  return result;
}

// ─── OCR Quality Heuristics ────────────────────────────────────────────────

/**
 * Estimate OCR text quality. Returns 0-100 confidence score.
 * Low scores indicate garbled text that might benefit from Mathpix OCR.
 */
function estimateOCRQuality(text: string): number {
  if (!text || text.trim().length === 0) return 0;

  let score = 70; // Base confidence for any text

  const len = text.trim().length;

  // Very short text is likely incomplete
  if (len < 10) score -= 20;

  // Count suspicious characters that indicate OCR failure
  const suspiciousChars = (text.match(/[?□▪▭◼○●□■▫▬▲▼△▽⊕⊗⊕⊙⊘]/g) || []).length;
  score -= suspiciousChars * 10;

  // Count replacement characters (U+FFFD)
  const replacementChars = (text.match(/\uFFFD/g) || []).length;
  score -= replacementChars * 15;

  // Count excessive whitespace (sign of garbled layout)
  const whitespaceRatio = (text.match(/\s/g) || []).length / Math.max(len, 1);
  if (whitespaceRatio > 0.5) score -= 10;

  // LaTeX commands present = good quality (model understood the math)
  if (/\\frac|\\sqrt|\\int|\\sum|\\alpha/.test(text)) score += 15;

  // Mathematical notation present = good
  if (/[=+\-*/^]/.test(text) && /[a-zA-Z]/.test(text)) score += 5;

  // Clamp
  return Math.max(0, Math.min(100, score));
}

// ─── Classification ──────────────────────────────────────────────────────────

interface ClassificationResult {
  type: ProblemType;
  confidence: number;
  method: 'regex' | 'llm' | 'fallback';
  prompt: string;
  ocrQuality: number;
}

/**
 * Classify a math problem from its OCR text (fast path — regex only).
 * Returns UNKNOWN if no pattern matches.
 */
function classifyByRegex(text: string): { type: ProblemType; confidence: number } | null {
  if (!text || text.trim().length === 0) return null;

  let bestMatch: { type: ProblemType; confidence: number } | null = null;

  for (const entry of TYPE_PATTERNS) {
    let matchCount = 0;
    for (const pattern of entry.patterns) {
      if (pattern.test(text)) {
        matchCount++;
      }
    }
    if (matchCount > 0) {
      const confidence = Math.min(95, (matchCount / entry.patterns.length) * 100 * (entry.weight / 10));
      if (!bestMatch || confidence > bestMatch.confidence) {
        bestMatch = { type: entry.type, confidence };
      }
    }
  }

  return bestMatch;
}

/**
 * Classify a problem from OCR text. Uses regex fast path,
 * falls back to UNKNOWN (LLM classification would need vision model).
 */
function classifyProblem(text: string): ClassificationResult {
  const ocrQuality = estimateOCRQuality(text);

  // Fast path: regex classification
  const regexResult = classifyByRegex(text);
  if (regexResult && regexResult.confidence > 30) {
    return {
      type: regexResult.type,
      confidence: regexResult.confidence,
      method: 'regex',
      prompt: TYPE_PROMPTS[regexResult.type] || TYPE_PROMPTS.UNKNOWN,
      ocrQuality,
    };
  }

  // Fallback: UNKNOWN
  return {
    type: 'UNKNOWN',
    confidence: 20,
    method: 'fallback',
    prompt: TYPE_PROMPTS.UNKNOWN,
    ocrQuality,
  };
}

/**
 * Check if OCR text should be sent to Mathpix for re-OCR.
 * Returns true when:
 *   - OCR quality is low (< 50)
 *   - Problem type is CALCULUS or PROOF (high notation density)
 *   - previousAttemptFailed is true (likely OCR error)
 */
function shouldUseMathpix(text: string, problemType: ProblemType, previousAttemptFailed: boolean = false): boolean {
  const ocrQuality = estimateOCRQuality(text);

  // Low OCR quality — Mathpix might help
  if (ocrQuality < 50) return true;

  // High notation density types — Mathpix excels at these
  if (problemType === 'CALCULUS' || problemType === 'PROOF') return true;

  // Previous attempt failed — OCR error might be the cause
  if (previousAttemptFailed) return true;

  return false;
}

// ─── Model-Type Affinity Tracking ───────────────────────────────────────────

/**
 * Record a solve attempt result for model-type affinity tracking.
 * Tracks which models are best at which problem types.
 */
function recordModelTypeAffinity(problemType: ProblemType, modelName: string, success: boolean) {
  try {
    const db = getDb();
    if (!db) return;

    const key = `model_type_affinity_${problemType}_${modelName}`;
    const existing = db.prepare("SELECT value FROM calibration WHERE key = ?").get(key);

    let data: { success: number; fail: number; total: number };
    if (existing && existing.value) {
      data = JSON.parse(existing.value);
    } else {
      data = { success: 0, fail: 0, total: 0 };
    }

    if (success) data.success++;
    else data.fail++;
    data.total++;

    db.prepare('INSERT OR REPLACE INTO calibration (key, value, updated_at) VALUES (?, ?, ?)')
      .run(key, JSON.stringify(data), Date.now());
  } catch (e: any) {
    // Non-critical
  }
}

/**
 * Get the best model for a given problem type based on historical affinity.
 * Returns the model name or null if no data available.
 */
function getBestModelForType(problemType: ProblemType): string | null {
  try {
    const db = getDb();
    if (!db) return null;

    const rows = db.prepare("SELECT key, value FROM calibration WHERE key LIKE ?")
      .all(`model_type_affinity_${problemType}_%`);

    if (!rows || rows.length === 0) return null;

    let bestModel: string | null = null;
    let bestRate = 0;

    for (const row of rows) {
      const data = JSON.parse(row.value);
      if (data.total >= 2) { // Need at least 2 attempts
        const rate = data.success / data.total;
        if (rate > bestRate) {
          bestRate = rate;
          // Extract model name from key: model_type_affinity_LINEAR_EQUATION_Groq
          const parts = row.key.split('_');
          // Remove 'model', 'type', 'affinity', problem_type parts
          const modelName = parts.slice(3).join('_');
          bestModel = modelName;
        }
      }
    }

    return bestModel;
  } catch (e: any) {
    return null;
  }
}

module.exports = {
  // Core classification
  classifyProblem,
  classifyByRegex,
  shouldUseMathpix,

  // OCR quality
  estimateOCRQuality,

  // LaTeX
  simplifyLatex,

  // Prompt strategies
  TYPE_PROMPTS,
  PROBLEM_TYPES,
  ProblemType: undefined, // Type only, not a runtime value

  // Affinity tracking
  recordModelTypeAffinity,
  getBestModelForType,

  // DI
  _injectDependencies,
};
