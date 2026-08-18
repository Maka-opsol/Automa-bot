const _deps = {};

function _injectDependencies(deps) {
  Object.assign(_deps, deps);
}

function detectWorkEnvironment() {
  // Check for Flutter Web canvas environment
  if (document.querySelector('canvas#flutterCanvas')) {
    return 'flutter-web-canvas';
  }
  
  // Fallback to default detection
  if (document.body.innerHTML.includes('flutter')) {
    return 'flutter-web';
  }
  
  return 'unknown';
}

module.exports = {
  _injectDependencies,
  detectWorkEnvironment
};
