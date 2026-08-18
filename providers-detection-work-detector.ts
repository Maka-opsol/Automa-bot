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
  if (document.querySelector('canvas#flutterCanvas')) {
    return 'FLUTTER_WEB';
  }

  // Existing detection logic
  if (window.location.href.includes('assignments')) {
    return 'ASSIGNMENTS_PAGE';
  }

  return 'UNKNOWN';
}

module.exports = {
  _injectDependencies,
  detectWorkEnvironment
};
