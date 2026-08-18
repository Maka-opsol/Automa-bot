const _deps = {};

function _injectDependencies(deps) {
  Object.assign(_deps, deps);
}

function detectWorkInProgress() {
  // Check for Flutter Web canvas rendering
  const canvas = document.querySelector('canvas');
  if (canvas && canvas.getContext) {
    _deps.logger.debug('Detected Flutter Web canvas rendering');
    return true;
  }

  // Fallback to original detection logic
  const baseElement = document.querySelector('base[href]');
  if (baseElement) {
    _deps.logger.debug('Detected base href element');
    return true;
  }

  return false;
}

module.exports = {
  _injectDependencies,
  detectWorkInProgress
};
