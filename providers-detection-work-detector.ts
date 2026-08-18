const _deps = {};

function _injectDependencies(deps) {
  Object.assign(_deps, deps);
}

function detectWork() {
  // Check for Flutter Web canvas rendering
  const canvas = document.querySelector('canvas');
  if (canvas && canvas.getContext) {
    _deps.logger.debug('Detected Flutter Web canvas rendering');
    return true;
  }

  // Fallback to existing detection logic
  const workIndicators = [
    'assignment',
    'exercise',
    'problem',
    'question',
    'quiz',
    'test'
  ];

  const pageContent = document.body.innerText.toLowerCase();
  return workIndicators.some(indicator => pageContent.includes(indicator));
}

module.exports = {
  _injectDependencies,
  detectWork
};