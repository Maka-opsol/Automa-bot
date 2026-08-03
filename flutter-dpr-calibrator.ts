'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }
function getSelectCalibration() { return _deps.database?.selectCalibration; }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');

class FlutterDPRCalibrator {
  dpr: any;
  cssToPhysicalScale: any;

  constructor() {
    this.dpr = 1.0;
    this.cssToPhysicalScale = 1.0;
    this.loadCalibration();
  }

  loadCalibration() { 
    const row = getSelectCalibration()?.get('flutter_dpr_scale');
    if (row) this.cssToPhysicalScale = parseFloat(row.value) || 1.0;
  }

  async calibrate(page: any) { 
    try {
      const dpr = await page.evaluate(() => window.devicePixelRatio);
      this.dpr = dpr || 1.0;
      const viewport = await page.evaluate(() => ({
        innerWidth: window.innerWidth,
        devicePixelRatio: window.devicePixelRatio,
        flutterScale: document.querySelector('flutter-view')?.style?.transform?.match(/scale\(([\d.]+)\)/)?.[1] || 1.0
      }));
      const scale = viewport.devicePixelRatio * parseFloat(viewport.flutterScale);
      this.cssToPhysicalScale = scale;
      getUpsertCalibration()?.run('flutter_dpr_scale', String(scale), Date.now());
      log(`📐 Flutter DPR Calibration: scale = ${scale.toFixed(3)} (DPR: ${dpr})`, 'INFO', 'dpr');
      return scale;
    } catch (e: any) { logError('DPR calibration failed', e); return this.cssToPhysicalScale; }
  }

  toPhysical(cssX: any, cssY: any) { 
    return { x: cssX * this.cssToPhysicalScale, y: cssY * this.cssToPhysicalScale };
  }

  getJitteredClick(cssX: any, cssY: any) {
    const jitter = CONFIG.HUMAN_MOUSE_JITTER_PX || 3;
    return { x: cssX + (Math.random() - 0.5) * jitter, y: cssY + (Math.random() - 0.5) * jitter };
  }
}

module.exports = Object.assign(new FlutterDPRCalibrator(), { _injectDependencies });
