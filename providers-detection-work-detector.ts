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
    return 'FLUTTER_WEB_CANVAS';
  }

  // Fallback to default detection
  if (window.location.href.includes('app.mathu.co.za')) {
    return 'MATHU_APP';
  }

  return 'UNKNOWN';
}

module.exports = {
  _injectDependencies,
  detectWorkEnvironment
};
