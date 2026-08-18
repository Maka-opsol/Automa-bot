const _deps = { logger: null, config: null, browser: null };

function _injectDependencies(deps) {
  _deps.logger = deps.logger;
  _deps.config = deps.config;
  _deps.browser = deps.browser;
}

function detectWorkInProgress() {
  // Check for Flutter Web canvas rendering
  const canvas = document.querySelector('canvas');
  if (canvas && canvas.getContext) {
    _deps.logger.debug('Detected Flutter Web canvas rendering');
    return true;
  }

  // Fallback to existing detection logic
  const activeElement = document.activeElement;
  if (activeElement && activeElement.tagName === 'INPUT') {
    return true;
  }

  return false;
}

module.exports = {
  _injectDependencies,
  detectWorkInProgress
};
