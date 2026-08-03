'use strict';

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};
let _authManager: any = null;

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
  // Initialize auth-manager now that DI deps are available.
  // Auth-manager uses lazy loggers so it's safe to construct,
  // but we call init() to load strategies (which needs logger).
  if (!_authManager) {
    _authManager = require('./auth-auth-manager');
  }
  _authManager._injectDependencies(deps);
  if (_authManager.init) {
    _authManager.init();
  }
}

function getCONFIG(): any { return _deps.config || {}; }

function getAuthManager(): any {
  if (!_authManager) {
    _authManager = require('./auth-auth-manager');
  }
  return _authManager;
}

module.exports = {
  authenticate: async (page: any) => {
    const CONFIG = getCONFIG();
    const credentials = {
      email: CONFIG.getMicrosoftEmail?.() || CONFIG.MICROSOFT_EMAIL,
      password: CONFIG.getMicrosoftPassword?.() || CONFIG.MICROSOFT_PASSWORD
    };
    return getAuthManager().authenticate(page, credentials);
  },
  detectCaptcha: (page: any) => getAuthManager().detectCaptcha(page),
  solveCaptcha: (page: any) => getAuthManager().solveCaptcha(page),
  refreshSession: (page: any) => getAuthManager().refreshSession(page),
  _injectDependencies,
};
