'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

let pipeline: any;
try { pipeline = require('@xenova/transformers').pipeline; } catch (e: any) { pipeline = null; }
const { log, safeLog, logError } = require('./logger');

class LocalVLM {
  pipe: any;
  initialized: any;

  constructor() {
    this.pipe = null;
    this.initialized = false;
  }

  async init() { 
    if (this.initialized) return;
    try {
      const modelName = getCONFIG().LOCAL_VLM_MODEL || 'onnx-community/Phi-3.5-vision-instruct-ONNX';
      this.pipe = await pipeline('image-to-text', modelName);
      this.initialized = true;
      log('Local VLM initialized.', 'INFO', 'local-vlm');
    } catch (e: any) { logError('Local VLM init failed', e); }
  }

  async predict(base64Image: any, prompt: any) { 
    if (!this.initialized) throw new Error('Local VLM not initialized');
    try {
      const result = await this.pipe(base64Image, { prompt, max_new_tokens: 50 });
      const text = result[0]?.generated_text || '';
      const jsonMatch = text.match(/\{.*\}/s);
      if (jsonMatch) { return JSON.parse(jsonMatch[0]); }
      return { actionType: 'wait', currentState: 'error', reasoning: 'Local VLM fallback' };
    } catch (e: any) { logError('Local VLM prediction failed', e); return null; }
  }
}

module.exports = new LocalVLM();
module.exports._injectDependencies = _injectDependencies;
