'use strict';

const { runVisionPipeline } = require('./providers-vision-pipeline');
const CONFIG = require('./get-config');
const { log, safeLog, logError } = require('./logger');

const MICROSOFT_CAPTCHA_EXTRACT_PROMPT = `You are given a screenshot of a CAPTCHA image from Microsoft's account recovery page. It contains distorted letters and/or numbers. Your task is to extract the exact characters as they appear. Return ONLY the characters, without any extra text, spaces, or punctuation. Example: if the image shows "A3B9", return "A3B9".`;

async function extractMicrosoftCaptchaText(base64Image: any, signal: any) { 
  const res = await runVisionPipeline(base64Image, MICROSOFT_CAPTCHA_EXTRACT_PROMPT, {
    validator: (raw: any) => {
      const str = typeof raw === 'string' ? raw : (raw && raw.text ? String(raw.text) : '');
      return str.trim().replace(/^["']|["']$/g, '').replace(/\s/g, '');
    },
    timeoutMs: 10000,
    signal,
  });
  if (res) return res.result;
  if (CONFIG.OCR_FALLBACK_ENABLED) {
    try {
      const Tesseract = require('tesseract.js');
      const { data: { text } } = await Tesseract.recognize(Buffer.from(base64Image, 'base64'), 'eng');
      const cleaned = text.trim().replace(/\s/g, '');
      if (cleaned) return cleaned;
    } catch (e: any) { logError('OCR fallback failed', e); }
  }
  return null;
}

module.exports = { extractMicrosoftCaptchaText };
