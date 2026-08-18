const _deps = { logger: null, config: null, browser: null };

function _injectDependencies(deps) {
  _deps.logger = deps.logger;
  _deps.config = deps.config;
  _deps.browser = deps.browser;
}

function detectWorkPage() {
  const currentUrl = _deps.browser.getCurrentUrl();
  const isAssignmentsPage = currentUrl.includes('https://app.mathu.co.za/assignments');

  if (isAssignmentsPage) {
    _deps.logger.debug('Detected MathU assignments page');
    return true;
  }

  return false;
}

module.exports = {
  _injectDependencies,
  detectWorkPage
};
