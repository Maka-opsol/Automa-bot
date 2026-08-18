const _deps = {};

function _injectDependencies(deps) {
  Object.assign(_deps, deps);
}

function detectWorkPage() {
  const url = _deps.browser.getCurrentUrl();
  return url.includes('app.mathu.co.za/assignments');
}

module.exports = {
  _injectDependencies,
  detectWorkPage
};
