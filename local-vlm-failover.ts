'use strict';

// ─── Local VLM Failover ─────────────────────────────────────────────────────
//
// Phi-3.5-vision-instruct (ONNX) for local inference when all cloud
// providers fail. Disabled on Render free plan (512MB RAM) — Phi-3.5-vision
// requires ~2GB+ for model weights alone.
//
// On Render, this module logs a clear WARN at load time explaining why
// local VLM is unavailable, rather than silently failing later.

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

let pipeline: any;
try { pipeline = require('@xenova/transformers').pipeline; } catch (_e: any) { pipeline = null; }
const { log, safeLog, logError } = require('./logger');

/**
 * Detect if running on Render free plan (limited RAM).
 * Checks for RENDER env var and RENDER_SERVICE_ID (always set on Render).
 * Also checks available memory if possible.
 */
function isRenderFreePlan(): boolean {
  if (process.env.RENDER && process.env.RENDER_SERVICE_ID) {
    // Render free plan typically has 512MB RAM
    // If RENDER_INSTANCE_ID is set, we're actually running (not building)
    return !!process.env.RENDER_INSTANCE_ID;
  }
  return false;
}

class LocalVLM {
  pipe: any;
  initialized: any;
  disabledReason: string | null;

  constructor() {
    this.pipe = null;
    this.initialized = false;
    this.disabledReason = null;

    // Pre-check: detect known-incompatible environments
    if (isRenderFreePlan()) {
      this.disabledReason = 'Render free plan (512MB RAM insufficient for Phi-3.5-vision ~2GB)';
      log(`Local VLM DISABLED: ${this.disabledReason}`, 'WARN', 'local-vlm');
      log('Cloud vision providers (z.ai GLM-4.6V, DeepInfra Qwen2.5-VL) are the primary vision pipeline.', 'INFO', 'local-vlm');
    } else if (!pipeline) {
      this.disabledReason = '@xenova/transformers not installed';
      log(`Local VLM DISABLED: ${this.disabledReason}`, 'WARN', 'local-vlm');
    }
  }

  async init() { 
    if (this.initialized) return;
    if (this.disabledReason) {
      log(`Local VLM init skipped: ${this.disabledReason}`, 'DEBUG', 'local-vlm');
      return;
    }
    try {
      const modelName = getCONFIG().LOCAL_VLM_MODEL || 'onnx-community/Phi-3.5-vision-instruct-ONNX';
      this.pipe = await pipeline('image-to-text', modelName);
      this.initialized = true;
      log('Local VLM initialized.', 'INFO', 'local-vlm');
    } catch (e: any) { 
      logError('Local VLM init failed', e); 
      this.disabledReason = `Init failed: ${e.message}`;
    }
  }

  async predict(base64Image: any, prompt: any) { 
    if (this.disabledReason) {
      log(`Local VLM prediction skipped: ${this.disabledReason}`, 'DEBUG', 'local-vlm');
      return null;
    }
    if (!this.initialized) throw new Error('Local VLM not initialized');
    try {
      const result = await this.pipe(base64Image, { prompt, max_new_tokens: 50 });
      const text = result[0]?.generated_text || '';
      const jsonMatch = text.match(/\{.*\}/s);
      if (jsonMatch) { return JSON.parse(jsonMatch[0]); }
      return { actionType: 'wait', currentState: 'error', reasoning: 'Local VLM fallback' };
    } catch (e: any) { logError('Local VLM prediction failed', e); return null; }
  }

  /** Check if local VLM is available for use. */
  isAvailable(): boolean {
    return this.initialized && !this.disabledReason;
  }

  /** Get reason why local VLM is disabled, if any. */
  getDisabledReason(): string | null {
    return this.disabledReason;
  }
}

module.exports = new LocalVLM();
module.exports._injectDependencies = _injectDependencies;
