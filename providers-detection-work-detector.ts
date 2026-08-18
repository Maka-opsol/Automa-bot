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
  const activeElements = document.querySelectorAll('[aria-busy="true"], [data-loading="true"]');
  if (activeElements.length > 0) {
    _deps.logger.debug(`Detected ${activeElements.length} active elements`);
    return true;
  }

  return false;
}

module.exports = {
  _injectDependencies,
  detectWorkInProgress
};
