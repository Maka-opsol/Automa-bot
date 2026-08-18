const _deps = {};

function _injectDependencies(deps) {
  Object.assign(_deps, deps);
}

function detectWorkInProgress() {
  // Check for Flutter Web canvas rendering
  const canvas = document.querySelector('canvas');
  if (canvas && canvas.style.display !== 'none') {
    return true;
  }

  // Fallback to URL-based detection
  const currentUrl = window.location.href;
  if (currentUrl.includes('/assignments')) {
    return true;
  }

  return false;
}

module.exports = {
  _injectDependencies,
  detectWorkInProgress
};
