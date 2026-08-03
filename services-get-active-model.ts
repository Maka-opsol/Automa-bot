'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

function getCurrentModel() { 
  try {
    // Use DI-injected database if available (safe after container init)
    const getActiveModel = _deps.database?.getActiveModel;
    if (getActiveModel) {
      const active = getActiveModel.get();
      if (active && active.model_id) return active.model_id;
    }
  } catch { /* database not ready yet */ }

  // Fallback to config default
  const CONFIG = _deps.config || require('./get-config');
  return CONFIG.CODE_GEN_MODEL_OPENROUTER || 'openrouter/free';
}

module.exports = { getCurrentModel, _injectDependencies };