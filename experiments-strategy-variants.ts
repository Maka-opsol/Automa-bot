'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }

const { log, logError } = require('./logger');
const { updateConfig: _updateConfig } = require('./get-config');
const CONFIG = require('./get-config');


const VARIANT_DEFINITIONS = [
  {
    id: 'provider_order_alt',
    name: 'Provider Order Alt',
    description: 'Try z.ai and Groq before GitHub GPT',
    apply: async (context: any) => {
      const providers = await context.getAvailableProviders();
      const reordered = [...providers].sort((a, b) => {
        const order = ['z.ai', 'Groq', 'GitHub GPT', 'Agnes', 'NVIDIA', 'Cloudflare', 'Cerebras', 'Gemini'];
        const getOrder = (name: any) => { const idx = order.indexOf(name); return idx === -1 ? order.length : idx; };
        return getOrder(a.name) - getOrder(b.name);
      });
      context.setProviderOrder(reordered);
    },
    revert: (context: any) => {
      context.resetProviderOrder();
    },
  },
  {
    id: 'click_jitter_high',
    name: 'High Click Jitter',
    description: 'Use 5px jitter instead of 3px',
    apply: (context: any) => {
      context.setJitterPx(5);
    },
    revert: (context: any) => {
      context.setJitterPx(CONFIG.HUMAN_MOUSE_JITTER_PX || 3);
    },
  },
  {
    id: 'wait_multiplier_08',
    name: 'Faster Waits (0.8x)',
    description: 'Reduce wait times by 20%',
    apply: (context: any) => {
      context.setWaitMultiplier(0.8);
    },
    revert: (context: any) => {
      context.setWaitMultiplier(1.0);
    },
  },
  {
    id: 'wait_multiplier_12',
    name: 'Slower Waits (1.2x)',
    description: 'Increase wait times by 20%',
    apply: (context: any) => {
      context.setWaitMultiplier(1.2);
    },
    revert: (context: any) => {
      context.setWaitMultiplier(1.0);
    },
  },
  {
    id: 'vision_fallback_first',
    name: 'Vision Fallback First',
    description: 'Try local VLM before cloud providers',
    apply: (context: any) => {
      context.setVisionPriority(['local-vlm', 'onnx', 'cloud']);
    },
    revert: (context: any) => {
      context.setVisionPriority(['cloud', 'local-vlm', 'onnx']);
    },
  },
];

class ExperimentContext {
  _providerOrder: any;
  _waitMultiplier: any;
  _visionPriority: any;
  _jitterPx: any;
  _originalProviderOrder: any;
  _originalJitterPx: any;
  _originalWaitMultiplier: any;
  _originalVisionPriority: any;

  constructor() {
    this._providerOrder = null;
    this._jitterPx = CONFIG.HUMAN_MOUSE_JITTER_PX || 3;
    this._waitMultiplier = 1.0;
    this._visionPriority = ['cloud', 'local-vlm', 'onnx'];
    this._originalProviderOrder = null;
    this._originalJitterPx = this._jitterPx;
    this._originalWaitMultiplier = this._waitMultiplier;
    this._originalVisionPriority = [...this._visionPriority];
  }

  async getAvailableProviders() { 
    const { getAvailableProviders } = require('./providers-registry');
    return getAvailableProviders();
  }

  setProviderOrder(order: any) { 
    this._providerOrder = order;
  }

  resetProviderOrder() { 
    this._providerOrder = null;
  }

  setJitterPx(px: any) { 
    this._jitterPx = px;
  }

  setWaitMultiplier(mult: any) { 
    this._waitMultiplier = mult;
  }

  setVisionPriority(priority: any) { 
    this._visionPriority = priority;
  }

  getJitterPx() {  return this._jitterPx; }
  getWaitMultiplier() {  return this._waitMultiplier; }
  getVisionPriority() {  return this._visionPriority; }
}

let activeExperiment: any = null;

function getActiveExperiment() {  return activeExperiment; }

async function setActiveExperiment(id: any) { 
  const variant = VARIANT_DEFINITIONS.find(v => v.id === id);
  if (!variant) {
    log(`Unknown variant: ${id}`, 'WARN', 'experiments');
    return false;
  }
  if (activeExperiment) {
    revertExperiment(activeExperiment);
  }
  const context = new ExperimentContext();
  try {
    await variant.apply(context);
    activeExperiment = { id: variant.id, context, startTime: Date.now(), results: { attempts: 0, successes: 0, latencies: [] } };
    log(`Started experiment: ${variant.name}`, 'INFO', 'experiments');
    return true;
  } catch (err: any) {
    logError(`Failed to start experiment ${variant.id}`, err);
    return false;
  }
}

function revertExperiment(experiment: any) { 
  if (!experiment) return;
  const variant = VARIANT_DEFINITIONS.find(v => v.id === experiment.id);
  if (variant) {
    try {
      variant.revert(experiment.context);
      log(`Reverted experiment: ${variant.name}`, 'INFO', 'experiments');
    } catch (err: any) {
      logError(`Failed to revert experiment ${experiment.id}`, err);
    }
  }
  activeExperiment = null;
}

function recordExperimentResult(success: any, latency: any) { 
  if (!activeExperiment) return;
  activeExperiment.results.attempts++;
  if (success) activeExperiment.results.successes++;
  activeExperiment.results.latencies.push(latency);
}

function shouldPromoteExperiment() { 
  if (!activeExperiment) return false;
  const { attempts, successes, latencies } = activeExperiment.results;
  if (attempts < 10) return false;
  // Measure baseline from actual provider stats, not hardcoded values
  let baselineSuccessRate = 0.7;
  let baselineLatency = 2000;
  try {
    const stats = require('./providers-stats').getStats();
    if (stats && stats.totalActions > 0) {
      baselineSuccessRate = 1 - (stats.errors / stats.totalActions);
    }
  } catch (_e: any) { /* fallback to defaults */ }
  const successRate = successes / attempts;
  const avgLatency = latencies.length > 0 ? latencies.reduce((a: any, b: any) => a + b, 0) / latencies.length : 0;
  if (successRate > baselineSuccessRate && avgLatency < baselineLatency * 1.1) {
    return true;
  }
  return false;
}

function promoteActiveExperiment() { 
  if (!activeExperiment) return false;
  if (!shouldPromoteExperiment()) {
    log(`Experiment ${activeExperiment.id} did not meet promotion criteria`, 'INFO', 'experiments');
    return false;
  }
  const variant = VARIANT_DEFINITIONS.find(v => v.id === activeExperiment.id);
  if (!variant) return false;
  log(`Promoting experiment: ${variant.name}`, 'INFO', 'experiments');
  const result = {
    variantId: activeExperiment.id,
    promotedAt: Date.now(),
    successRate: activeExperiment.results.successes / activeExperiment.results.attempts,
    avgLatency: activeExperiment.results.latencies.length > 0 ? activeExperiment.results.latencies.reduce((a: any, b: any) => a + b, 0) / activeExperiment.results.latencies.length : 0,
    attempts: activeExperiment.results.attempts,
  };
  try {
    getUpsertCalibration()?.run(`experiment_promoted_${activeExperiment.id}`, JSON.stringify(result), Date.now());
  } catch (err: any) {
    logError('Failed to save experiment promotion', err);
  }
  const variantConfig = getVariantConfig(activeExperiment.id);
  if (variantConfig) {
    applyVariantConfigToSystem(variantConfig);
  }
  activeExperiment = null;
  return true;
}

function getVariantConfig(variantId: any) { 
  const map = {
    'provider_order_alt': { key: 'PROVIDER_ORDER', value: 'alt' },
    'click_jitter_high': { key: 'HUMAN_MOUSE_JITTER_PX', value: 5 },
    'wait_multiplier_08': { key: 'WAIT_MULTIPLIER', value: 0.8 },
    'wait_multiplier_12': { key: 'WAIT_MULTIPLIER', value: 1.2 },
    'vision_fallback_first': { key: 'VISION_PRIORITY', value: 'local-first' },
  };
// @ts-expect-error
  return map[variantId] || null;
}

function applyVariantConfigToSystem(config: any) { 
  if (config.key === 'PROVIDER_ORDER') {
    process.env.PROVIDER_ORDER = config.value;
  } else if (config.key === 'HUMAN_MOUSE_JITTER_PX') {
    _updateConfig('HUMAN_MOUSE_JITTER_PX', config.value);
  } else if (config.key === 'WAIT_MULTIPLIER') {
    _updateConfig('WAIT_MULTIPLIER', config.value);
  } else if (config.key === 'VISION_PRIORITY') {
    process.env.VISION_PRIORITY = config.value;
  }
  log(`Applied variant config: ${config.key}=${config.value}`, 'INFO', 'experiments');
}

function getExperimentStats() { 
  return {
    activeExperiment: activeExperiment ? {
      id: activeExperiment.id,
      startTime: activeExperiment.startTime,
      attempts: activeExperiment.results.attempts,
      successes: activeExperiment.results.successes,
      avgLatency: activeExperiment.results.latencies.length > 0 ?
        activeExperiment.results.latencies.reduce((a: any, b: any) => a + b, 0) / activeExperiment.results.latencies.length : 0,
    } : null,
    promoted: getPromotedExperiments(),
  };
}

function getPromotedExperiments() { 
  try {
    const { db } = require('./database');
    const rows = db.prepare("SELECT key, value FROM calibration WHERE key LIKE 'experiment_promoted_%'").all();
    const results = [];
    for (const row of rows) {
      try { results.push(JSON.parse(row.value)); } catch (_e: any) { log(`Skipping malformed experiment data for key ${row.key}`, 'WARN', 'experiments'); }
    }
    return results;
  } catch (err: any) {
    return [];
  }
}

async function startRandomExperiment() {
  if (activeExperiment) return;
  const available = VARIANT_DEFINITIONS.filter(v => {
    const promoted = getPromotedExperiments();
    return !promoted.some(p => p.variantId === v.id);
  });
  if (available.length === 0) {
    log('No available experiments to run', 'DEBUG', 'experiments');
    return;
  }
  const variant = available[Math.floor(Math.random() * available.length)];
  await setActiveExperiment(variant.id);
}

  let _experimentTimer: any = null;

function runExperimentScheduler() { 
  _experimentTimer = setInterval(() => {
    if (activeExperiment) {
      if (shouldPromoteExperiment()) {
        promoteActiveExperiment();
      } else if (activeExperiment.results.attempts > 30) {
        log(`Experiment ${activeExperiment.id} did not meet criteria after 30 attempts, reverting`, 'INFO', 'experiments');
        revertExperiment(activeExperiment);
      }
    } else {
      startRandomExperiment();
    }
  }, 10 * 60 * 1000);
  if (_experimentTimer && typeof _experimentTimer.unref === 'function') {
    _experimentTimer.unref();
  }
}

module.exports = {
  VARIANT_DEFINITIONS,
  ExperimentContext,
  getActiveExperiment,
  setActiveExperiment,
  revertExperiment,
  recordExperimentResult,
  shouldPromoteExperiment,
  promoteActiveExperiment,
  getExperimentStats,
  startRandomExperiment,
  runExperimentScheduler,
  stopExperimentScheduler: () => { if (_experimentTimer) { clearInterval(_experimentTimer); _experimentTimer = null; } },
  _injectDependencies,
};
