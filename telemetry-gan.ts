'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getCONFIG(): Record<string, any> { return _deps.config || require('./get-config'); }

let InferenceSession: any, Tensor: any;
try { ({ InferenceSession, Tensor } = require('onnxruntime-node')); } catch (e: any) { /* onnxruntime-node not installed */ }
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const { log, logError } = require('./logger');

class TelemetryGAN {
  session: any;
  initialized: any;
  useFallback: boolean;

  constructor() {
    this.session = null;
    this.initialized = false;
    this.useFallback = false;
  }

  async init() {
    if (this.initialized) return;
    if (!InferenceSession) {
      log('Telemetry GAN: onnxruntime-node not installed — using math fallback', 'WARN', 'gan');
      this.useFallback = true;
      this.initialized = true;
      return;
    }
    try {
      const modelPath = getCONFIG().GAN_MODEL_PATH || path.join(PROJECT_ROOT, 'models', 'mouse-gan.onnx');
      const fs = require('fs');
      if (!fs.existsSync(modelPath)) {
        log('Telemetry GAN: model file not found — using math fallback (Bézier curves + noise)', 'INFO', 'gan');
        this.useFallback = true;
        this.initialized = true;
        return;
      }
      this.session = await InferenceSession.create(modelPath);
      this.initialized = true;
      log('Telemetry GAN model loaded.', 'INFO', 'gan');
    } catch (e: any) {
      log('Telemetry GAN init failed — using math fallback: ' + e.message, 'WARN', 'gan');
      this.useFallback = true;
      this.initialized = true;
    }
  }

  async generateTrajectory(startX: any, startY: any, endX: any, endY: any, duration: any, hardware: any) {
    if (!this.initialized) throw new Error('GAN not initialized');

    // If we have the ONNX model, use it
    if (!this.useFallback && this.session) {
      try {
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
      } catch (e: any) {
        log('GAN inference failed, using math fallback: ' + e.message, 'WARN', 'gan');
      }
    }

    // MATH FALLBACK — Bézier curve + noise (no ONNX model needed)
    // Generates a natural-looking mouse trajectory with:
    //   - Curved path (cubic Bézier with random control points)
    //   - Acceleration/deceleration (ease-in-out)
    //   - Micro-jitter (simulates hand tremor)
    return this._generateBezierTrajectory(startX, startY, endX, endY, duration);
  }

  // ─── Math-based trajectory generation (no ONNX needed) ───
  // Uses a cubic Bézier curve with random control points for natural curvature,
  // ease-in-out timing for acceleration/deceleration, and Gaussian noise for
  // micro-jitter that simulates hand tremor.
  _generateBezierTrajectory(startX: number, startY: number, endX: number, endY: number, duration: number) {
    const numPoints = Math.max(10, Math.min(50, Math.floor(duration / 16))); // ~60fps
    const points: Array<{ x: number; y: number }> = [];

    // Distance between start and end
    const dx = endX - startX;
    const dy = endY - startY;
    const distance = Math.sqrt(dx * dx + dy * dy);

    // Random control points for Bézier curve (offset perpendicular to the path)
    // This creates a natural curve — humans don't move in straight lines
    const perpX = -dy / (distance || 1);
    const perpY = dx / (distance || 1);
    const curveAmount = (Math.random() - 0.5) * Math.min(distance * 0.3, 100);

    const cp1x = startX + dx * 0.3 + perpX * curveAmount;
    const cp1y = startY + dy * 0.3 + perpY * curveAmount;
    const cp2x = startX + dx * 0.7 + perpX * curveAmount * 0.5;
    const cp2y = startY + dy * 0.7 + perpY * curveAmount * 0.5;

    for (let i = 0; i <= numPoints; i++) {
      // Ease-in-out timing (smooth acceleration and deceleration)
      const linearT = i / numPoints;
      const t = linearT < 0.5
        ? 2 * linearT * linearT  // ease-in
        : 1 - Math.pow(-2 * linearT + 2, 2) / 2;  // ease-out

      // Cubic Bézier curve: B(t) = (1-t)³P₀ + 3(1-t)²tP₁ + 3(1-t)t²P₂ + t³P₃
      const u = 1 - t;
      const x = u*u*u * startX + 3*u*u*t * cp1x + 3*u*t*t * cp2x + t*t*t * endX;
      const y = u*u*u * startY + 3*u*u*t * cp1y + 3*u*t*t * cp2y + t*t*t * endY;

      // Micro-jitter (Gaussian noise — simulates hand tremor)
      // The jitter decreases near the endpoints (more precise at start/end)
      const jitterScale = Math.sin(linearT * Math.PI) * 2; // 0 at endpoints, 2 at middle
      const jitterX = (Math.random() - 0.5) * jitterScale;
      const jitterY = (Math.random() - 0.5) * jitterScale;

      points.push({ x: x + jitterX, y: y + jitterY });
    }

    return points;
  }
}

module.exports = new TelemetryGAN();
module.exports._injectDependencies = _injectDependencies;
