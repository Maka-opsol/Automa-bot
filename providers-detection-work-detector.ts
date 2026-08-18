const _deps = {};

function _injectDependencies(deps) {
  Object.assign(_deps, deps);
}

function detectWorkPage() {
  const url = window.location.href;
  const isAssignmentsPage = url.includes('/assignments');
  
  if (isAssignmentsPage) {
    _deps.logger.debug('Detected MathU Infinity assignments page');
    return {
      type: 'work',
      context: 'assignments'
    };
  }
  
  return null;
}

module.exports = {
  _injectDependencies,
  detectWorkPage
};
