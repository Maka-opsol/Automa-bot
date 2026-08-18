const _deps = {};

function _injectDependencies(deps) {
  Object.assign(_deps, deps);
}

function detectWorkPage() {
  // Check for Flutter Web canvas rendering
  const canvas = document.querySelector('canvas');
  if (canvas && canvas.id === 'flutterCanvas') {
    return true;
  }

  // Fallback to URL check
  return window.location.pathname.includes('/assignments');
}

module.exports = {
  _injectDependencies,
  detectWorkPage
};