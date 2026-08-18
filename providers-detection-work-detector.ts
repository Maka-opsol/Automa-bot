const _deps = {};

function _injectDependencies(deps) {
  Object.assign(_deps, deps);
}

function detectWorkEnvironment() {
  // Check for Flutter Web canvas rendering
  if (document.querySelector('canvas#flutterCanvas')) {
    return 'FLUTTER_WEB';
  }
  
  // Fallback to default detection
  if (document.body.innerText.includes('MathU Infinity')) {
    return 'MATHU_APP';
  }
  
  return 'UNKNOWN';
}

module.exports = {
  _injectDependencies,
  detectWorkEnvironment
};
