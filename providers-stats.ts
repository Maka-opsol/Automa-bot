'use strict';

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

const stats = {
  cycleCount: 0,
  totalActions: 0,
  questionsCompleted: 0,
  lastCycleStart: null,
  lastActionTime: null,
  currentStatus: 'initializing',
  errors: 0,
  currentState: null,
  lastCompletionTime: null,
  consecutiveFailures: 0,
};

function getStats() {  return { ...stats }; }

function updateStats(updates: any) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return;
  const prevQuestions = stats.questionsCompleted;
  Object.assign(stats, updates);
  const actionFields = ['cycleCount', 'totalActions', 'questionsCompleted', 'errors', 'consecutiveFailures', 'currentStatus', 'currentState'];
  if (actionFields.some(f => updates[f] !== undefined)) {
    (stats as any).lastActionTime = new Date().toISOString();
  }
  if (updates.questionsCompleted !== undefined && typeof updates.questionsCompleted === 'number' && updates.questionsCompleted > prevQuestions) { (stats as any).lastCompletionTime = new Date().toISOString(); }
}

module.exports = { getStats, updateStats, _injectDependencies };
