const _deps = {
  logger: null,
  config: null,
  browser: null
};

function _injectDependencies(deps) {
  _deps.logger = deps.logger;
  _deps.config = deps.config;
  _deps.browser = deps.browser;
}

function detectWorkEnvironment() {
  // Check for Flutter Web canvas environment
  if (document.querySelector('canvas') && document.body.innerText.trim() === '') {
    _deps.logger.debug('Detected Flutter Web canvas rendering environment');
    return 'flutter-web-canvas';
  }

  // Existing detection logic...
  if (_deps.browser.isMobile()) {
    return 'mobile';
  }

  return 'desktop';
}

module.exports = {
  _injectDependencies,
  detectWorkEnvironment
};