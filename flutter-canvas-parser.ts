'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);

let sharp: any;
try { sharp = require('sharp'); } catch (e: any) { sharp = null; }
let Tesseract: any;
try { Tesseract = require('tesseract.js'); } catch (e: any) { Tesseract = null; }

class FlutterCanvasParser {
  async parseTextAndButtons(base64Image: any) { 
    if (!sharp || !Tesseract) { log('Canvas parser unavailable (sharp/tesseract missing)', 'DEBUG', 'canvas'); return { all: [] }; }
    try {
      const buffer = Buffer.from(base64Image, 'base64');
      const { data, info } = await sharp(buffer).greyscale().threshold(128).raw().toBuffer({ resolveWithObject: true });
      const width = info.width;
      const height = info.height;
      const rows = [];
      for (let y = 0; y < height; y += 5) {
        const rowStart = y * width;
        let darkCount = 0;
        for (let x = 0; x < width; x += 5) { if (data[rowStart + x] < 128) darkCount++; }
        if (darkCount / (width / 5) > 0.3) rows.push(y);
      }
      const boxes = [];
      let startY = rows[0] || 0;
      for (let i = 1; i < rows.length; i++) {
        if (rows[i] - rows[i-1] > 20) { boxes.push({ y: startY, height: rows[i-1] - startY }); startY = rows[i]; }
      }
      if (boxes.length === 0) boxes.push({ y: 0, height: height });
      const results = [];
      for (const box of boxes) {
        try {
          if (box.height <= 0) continue;
          const crop = await sharp(buffer).extract({ left: 0, top: box.y, width: width, height: box.height }).toBuffer();
          const { data: { text } } = await Tesseract.recognize(crop, 'eng');
          if (text.trim().length > 0) { results.push({ text: text.trim(), y: box.y, height: box.height, centerX: width / 2, centerY: box.y + box.height / 2 }); }
        } catch (_e: any) { /* non-critical, suppressed */ }
      }
      const watchButton = results.find(r => r.text.toLowerCase().includes('watch'));
      const startButton = results.find(r => r.text.toLowerCase().includes('start'));
      log(`📝 Canvas parser found ${results.length} text blocks.`, 'DEBUG', 'canvas');
      return { watchButton, startButton, all: results };
    } catch (e: any) { logError('Canvas parsing failed', e); return { all: [] }; }
  }
}

module.exports = Object.assign(new FlutterCanvasParser(), { _injectDependencies });