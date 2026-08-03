'use strict';

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { extractJSON, validateActionResponse, getProviderConfig, retryWithBackoff } = require('./providers-base');

function GeminiProvider() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  const genAI = new GoogleGenerativeAI(apiKey);
  return async (base64Image: any, prompt: any, signal: any, options: any = {}) => {
    const config = getProviderConfig('Gemini');
    const model = genAI.getGenerativeModel({ model: config.model });
    try {
      const result = await retryWithBackoff(async () => {
        let _abortHandler = null;
        const abortPromise = signal ? new Promise((_, reject) => {
          _abortHandler = () => reject(new Error('Aborted'));
          signal.addEventListener('abort', _abortHandler, { once: true });
        }) : null;
        try {
          const parts = [{ text: prompt }];
          if (base64Image) { parts.push({ inlineData: { mimeType: 'image/jpeg', data: base64Image } } as any); }
          const generatePromise = model.generateContent(parts);
          return abortPromise ? await Promise.race([generatePromise, abortPromise]) : await generatePromise;
        } finally {
          if (_abortHandler && signal) { try { signal.removeEventListener('abort', _abortHandler); } catch {} }
        }
      });
      const response = result.response;
      if (!response) throw new Error('Gemini: Empty SDK result');
      const text = response.text();
      if (!text) throw new Error('EMPTY_RESPONSE');
      if (options.validate === false) return text;
      return validateActionResponse(extractJSON(text, 'Gemini'), 'Gemini');
    } catch (err: any) {
      throw err;
    }
  };
}

module.exports = { GeminiProvider };
