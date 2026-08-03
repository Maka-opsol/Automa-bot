'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

let InferenceSession: any,   Tensor: any,   sharp;
try { ({ InferenceSession, Tensor } = require('onnxruntime-node')); } catch (e: any) { /* onnxruntime-node not installed */ }
try { sharp = require('sharp'); } catch (e: any) { /* sharp not installed */ }
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, logError } = require('./logger');

class TelemetryGAN {
  session: any;
  initialized: any;

  constructor() {
    this.session = null;
    this.initialized = false;
  }

  async init() { 
    if (this.initialized) return;
    if (!InferenceSession) { log('Telemetry GAN: onnxruntime-node not installed, skipping init', 'WARN', 'gan'); return; }
    try {
      const modelPath = getCONFIG().GAN_MODEL_PATH || path.join(PROJECT_ROOT, 'models', 'mouse-gan.onnx');
      this.session = await InferenceSession.create(modelPath);
      this.initialized = true;
      log('Telemetry GAN model loaded.', 'INFO', 'gan');
    } catch (e: any) { logError('Telemetry GAN init failed', e); }
  }

  async generateTrajectory(startX: any, startY: any, endX: any, endY: any, duration: any, hardware: any) { 
    if (!this.initialized) throw new Error('GAN not initialized');
    const inputs = {
      start: new Tensor('float32', new Float32Array([startX, startY]), [1, 2]),
      end: new Tensor('float32', new Float32Array([endX, endY]), [1, 2]),
      duration: new Tensor('float32', new Float32Array([duration / 1000]), [1, 1]),
      hardware: new Tensor('float32', new Float32Array([hardware.dpr || 1, hardware.platform === 'darwin' ? 1 : 0]), [1, 2])
    };
    const results = await this.session.run(inputs);
    if (!results || !results.output) throw new Error('ONNX inference returned no output');
    const output = results.output.data;
    const points = [];
    for (let i = 0; i < output.length; i += 2) { points.push({ x: output[i], y: output[i+1] }); }
    return points;
  }
}

module.exports = new TelemetryGAN();
module.exports._injectDependencies = _injectDependencies;
