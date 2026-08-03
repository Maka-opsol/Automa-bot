'use strict';

const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { fetchJSON } = require('./utils-fetch');

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getLog(): (msg: string, level?: string, _module?: string) => void {
  return _deps.logger?.log || console.log;
}
function getLogError(): (msg: string, err: Error, ctx?: any) => void {
  return _deps.logger?.logError || ((msg: string, err: Error) => console.error(msg, err));
}

let onnx: any = null;
let sharp: any = null;

function _loadOptionalDeps() {
  const log = getLog();
  if (!onnx) { try { onnx = require('onnxruntime-node'); } catch (e: any) { log('onnxruntime-node not available (optional)', 'INFO', 'quota'); } }
  if (!sharp) { try { sharp = require('sharp'); } catch (e: any) { log('sharp not available (optional)', 'INFO', 'quota'); } }
}

_loadOptionalDeps();

class QuotaBargainManager {
  budgets: Map<string, number>;
  localModel: any;

  constructor() {
    this.budgets = new Map();
    this.localModel = null;
    this.loadQuotas();
    this.initLocalONNX();
  }

  loadQuotas() {
    const keys = ['openrouter', 'mistral', 'github'];
    for (const key of keys) {
      const envKey = `PROVIDER_BUDGET_${key.toUpperCase()}`;
      if (process.env[envKey]) { this.budgets.set(key, parseFloat(process.env[envKey])); }
    }
  }

  canUseProvider(providerName: string) { 
    const db = _deps.database;
    if (!db?.selectCalibration) return true;
    const budget = this.budgets.get(providerName);
    if (budget === undefined) return true;
    const spent = parseFloat(db.selectCalibration.get(`spent_${providerName}`)?.value || '0');
    return spent < budget * 0.8;
  }

  recordSpend(providerName: string, tokens: number, costPerToken: number) { 
    const log = getLog();
    const db = _deps.database;
    if (!db?.upsertCalibration || !db?.selectCalibration) return;
    const cost = tokens * costPerToken;
    const row = db.selectCalibration.get(`spent_${providerName}`);
    const spent = parseFloat(row?.value || '0');
    const recordedAt = row?.updated_at || 0;
    if (recordedAt && Date.now() - recordedAt > 24 * 60 * 60 * 1000) {
      db.upsertCalibration.run(`spent_${providerName}`, String(cost), Date.now());
      log(`Quota spent counter reset for ${providerName} (was ${spent.toFixed(4)}, now ${cost.toFixed(4)})`, 'INFO', 'quota');
    } else {
      db.upsertCalibration.run(`spent_${providerName}`, String(spent + cost), Date.now());
    }
  }

  async findNewFreeModels() { 
    const log = getLog();
    const logError = getLogError();
    try {
      const data = await fetchJSON('https://openrouter.ai/api/v1/models', {}, 10000);
      const freebies = (data.data || []).filter((m: any) => m.pricing?.prompt === '0' && m.pricing?.completion === '0');
      const topCandidates = freebies.slice(0, 5).map((m: any) => m.id);
      log(`Bargain hunter found fresh free models: ${topCandidates.join(', ')}`, 'INFO', 'quota');
      const db = _deps.database;
      const providersRegistry = _deps.providers || require('./providers-registry');
      const providersBase = _deps.providersBase || require('./providers-base');
      const { upsertModel } = db || require('./database');
      for (const id of topCandidates) {
        if (upsertModel) upsertModel.run('openrouter', id, 1, 0, 'candidate', Date.now(), null, 0);
        const modelId = id;
        const existingProviders = await providersRegistry.getAvailableProviders();
        const alreadyRegistered = existingProviders.some((p: any) => p.name === `bargain-${modelId}`);
        if (alreadyRegistered) continue;

        providersRegistry.registerDynamicProvider(`bargain-${modelId}`, async (base64Image: string, prompt: string, signal: any, options: any = {}) => {
          try {
            const endpoint = `https://openrouter.ai/api/v1/chat/completions`;
            const apiKey = process.env.OPENROUTER_API_KEY;
            if (!apiKey) {
              return { actionType: 'wait', currentState: 'error', reasoning: 'No OPENROUTER_API_KEY configured', targetX: 0, targetY: 0 };
            }
            const result = await providersBase.callChatCompletion(endpoint, apiKey, modelId, base64Image, prompt, {
              ...options,
              maxTokens: options.maxTokens || 4096,
              temperature: options.temperature || 0.1,
              signal,
            });
            return providersBase.validateActionResponse(result, `Bargain(${modelId})`);
          } catch (err: any) {
            providersRegistry.recordProviderResult(`bargain-${modelId}`, false, 0);
            throw err;
          }
        });
        log(`Registered bargain provider: bargain-${id}`, 'INFO', 'quota');
      }
      return topCandidates;
    } catch (e: any) { logError('Bargain hunter failed', e as Error); return []; }
  }

  async initLocalONNX() { 
    const log = getLog();
    if (!onnx || !sharp) {
      log('Local ONNX fallback skipped (onnxruntime or sharp not installed)', 'INFO', 'quota');
      return;
    }
    try {
      const modelPath = process.env.ONNX_MODEL_PATH || path.join(PROJECT_ROOT, 'models', 'tiny-ui-classifier.onnx');
      const session = await onnx.InferenceSession.create(modelPath);
      this.localModel = session;
      log('Local ONNX fallback loaded.', 'INFO', 'quota');
    } catch (e: any) { log('Local ONNX failed to load (ignoring).', 'WARN', 'quota'); }
  }

  async predictLocal(base64Image: string, viewportWidth = 1920, viewportHeight = 1080) { 
    if (!this.localModel || !sharp || !onnx) return null;
    try {
      const buffer = Buffer.from(base64Image, 'base64');
      const resized = await sharp(buffer).resize(224, 224).removeAlpha().raw().toBuffer();
      const floatData = new Float32Array(224 * 224 * 3);
      const pixels = resized.length / 3;
      for (let i = 0; i < pixels; i++) {
        floatData[i] = resized[i * 3] / 255.0;
        floatData[pixels + i] = resized[i * 3 + 1] / 255.0;
        floatData[2 * pixels + i] = resized[i * 3 + 2] / 255.0;
      }
      const tensor = new onnx.Tensor('float32', floatData, [1, 3, 224, 224]);
      const results = await this.localModel.run({ input: tensor });
      const output = results.output?.data;
      if (!output || output.length < 2) return null;
      const x = Math.max(0, Math.min(viewportWidth, Number(output[0]) || 0));
      const y = Math.max(0, Math.min(viewportHeight, Number(output[1]) || 0));
      return { actionType: 'click', targetX: x, targetY: y };
    } catch (e: any) { return null; }
  }
}

const _instance = new QuotaBargainManager();

module.exports = Object.assign(_instance, { _injectDependencies });
