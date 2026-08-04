'use strict';

// ═══════════════════════════════════════════════
// CAPTCHA Text Extractor — Extracts distorted text from
// Microsoft CAPTCHA images using vision AI or OCR fallback.
//
// Render-aware: OCR fallback (tesseract.js) is only
// attempted if explicitly enabled (it's heavy).
// ═══════════════════════════════════════════════

const { runVisionPipeline } = require('./providers-vision-pipeline');
const { log, logError } = require('./logger');

// BUG FIX (Response 19): Lazy CONFIG to avoid circular require
let _config: any = null;
function _getCONFIG(): any {
  if (!_config) {
    try { _config = require('./get-config'); } catch { _config = { OCR_FALLBACK_ENABLED: false }; }
  }
  return _config;
}

// BUG FIX (Response 19): Timeout for vision pipeline
const VISION_TIMEOUT_MS = 10000;

// BUG FIX (Response 19): Timeout for OCR fallback
const OCR_TIMEOUT_MS = 15000;

// Maximum length of extracted text
const MAX_EXTRACTED_LENGTH = 20;

const MICROSOFT_CAPTCHA_EXTRACT_PROMPT = `You are given a screenshot of a CAPTCHA image from Microsoft's account recovery page. It contains distorted letters and/or numbers. Your task is to extract the exact characters as they appear. Return ONLY the characters, without any extra text, spaces, or punctuation. Example: if the image shows "A3B9", return "A3B9".`;

/**
 * Extract CAPTCHA text from a Microsoft account recovery image.
 *
 * @param base64Image - Base64-encoded CAPTCHA image
 * @param signal - Optional AbortSignal
 * @returns Extracted text string, or null on failure
 */
async function extractMicrosoftCaptchaText(base64Image: any, signal: any) {
  if (!base64Image) {
    log('extractMicrosoftCaptchaText: missing image', 'WARN', 'captcha-extractor');
    return null;
  }

  // Try vision pipeline first
  try {
    const res = await runVisionPipeline(base64Image, MICROSOFT_CAPTCHA_EXTRACT_PROMPT, {
      validator: (raw: any) => {
        const str = typeof raw === 'string'
          ? raw
          : (raw && raw.text ? String(raw.text) : '');
        const cleaned = str.trim().replace(/^["']|["']$/g, '').replace(/\s/g, '');
        // BUG FIX (Response 19): Cap length to prevent garbage
        if (cleaned.length > MAX_EXTRACTED_LENGTH) return cleaned.substring(0, MAX_EXTRACTED_LENGTH);
        return cleaned;
      },
      timeoutMs: VISION_TIMEOUT_MS,
      signal,
    });
    if (res) return res.result;
  } catch (e: any) {
    logError('Vision CAPTCHA extraction failed', e);
  }

  // OCR fallback (tesseract.js) — heavy, only if enabled
  const config = _getCONFIG();
  if (config.OCR_FALLBACK_ENABLED) {
    try {
      log('Attempting OCR fallback for CAPTCHA text', 'DEBUG', 'captcha-extractor');
      const Tesseract = require('tesseract.js');
      // BUG FIX (Response 19): Race OCR against timeout
      const ocrPromise = Tesseract.recognize(
        Buffer.from(base64Image, 'base64'),
        'eng',
      );
      const ocrTimeout = new Promise<null>(resolve =>
        setTimeout(() => resolve(null), OCR_TIMEOUT_MS),
      );
      const result = await Promise.race([ocrPromise, ocrTimeout]);
      if (!result) {
        log('OCR fallback timed out', 'WARN', 'captcha-extractor');
        return null;
      }
      const cleaned = result.data.text.trim().replace(/\s/g, '');
      if (cleaned) return cleaned;
    } catch (e: any) {
      logError('OCR fallback failed', e);
    }
  }

  return null;
}

module.exports = { extractMicrosoftCaptchaText };
