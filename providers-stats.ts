'use strict';

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

const stats = {
  cycleCount: 0,
  totalActions: 0,
  questionsCompleted: 0,
  lastCycleStart: null as string | null,
  lastActionTime: null as string | null,
  currentStatus: 'initializing',
  errors: 0,
  currentState: null as string | null,
  lastCompletionTime: null as string | null,
  consecutiveFailures: 0,
};

/** Fields that trigger a lastActionTime update */
const ACTION_FIELDS = new Set([
  'cycleCount', 'totalActions', 'questionsCompleted',
  'errors', 'consecutiveFailures', 'currentStatus', 'currentState',
]);

/**
 * Maximum consecutiveFailures before capping.
 * On Render free plan, a permanently stuck bot would increment this
 * indefinitely. Capping prevents unbounded growth.
 */
const MAX_CONSECUTIVE_FAILURES = 10000;

/**
 * Fields that must be numeric. Silently coerced to numbers on update.
 * Prevents stats corruption from callers passing strings or null.
 */
const NUMERIC_FIELDS = new Set([
  'cycleCount', 'totalActions', 'questionsCompleted', 'errors', 'consecutiveFailures',
]);

function getStats() {
  return { ...stats };
}

/**
 * Update stats with validation.
 *
 * Guards:
 *   - Non-object / array / null updates are silently ignored
 *   - Numeric fields are coerced to numbers (NaN → 0)
 *   - consecutiveFailures is capped at MAX_CONSECUTIVE_FAILURES
 *   - lastActionTime is set when any ACTION_FIELD changes
 *   - lastCompletionTime is set when questionsCompleted increases
 *
 * On Render free plan:
 *   - new Date().toISOString() is only called when an action field actually
 *     changes, avoiding unnecessary string allocations on no-op updates
 */
function updateStats(updates: any) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return;

  const prevQuestions = stats.questionsCompleted;
  let hasActionField = false;

  for (const key of Object.keys(updates)) {
    const value = updates[key];

    // Validate numeric fields
    if (NUMERIC_FIELDS.has(key) && typeof value !== 'number') {
      const coerced = Number(value);
      (stats as any)[key] = isNaN(coerced) ? 0 : coerced;
    } else {
      (stats as any)[key] = value;
    }

    if (ACTION_FIELDS.has(key)) hasActionField = true;
  }

  // Only allocate ISO string if an action field actually changed
  if (hasActionField) {
    stats.lastActionTime = new Date().toISOString();
  }

  // Cap consecutiveFailures
  if (stats.consecutiveFailures > MAX_CONSECUTIVE_FAILURES) {
    stats.consecutiveFailures = MAX_CONSECUTIVE_FAILURES;
  }

  // Track completion time
  if (typeof updates.questionsCompleted === 'number'
      && updates.questionsCompleted > prevQuestions
      && updates.questionsCompleted > 0) {
    stats.lastCompletionTime = new Date().toISOString();
  }
}

module.exports = { getStats, updateStats, _injectDependencies };
