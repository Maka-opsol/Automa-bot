'use strict';

let sharp: any;
try { sharp = require('sharp'); } catch (e: any) { sharp = null; }

// ─── Dependency Injection ───
let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) {
  _deps = deps;
}

function getCONFIG(): any { return _deps.config || {}; }
function getLog(): (msg: string, level?: string, _module?: string) => void {
  return _deps.logger?.log || console.log;
}
function getLogError(): (msg: string, err: Error, ctx?: any) => void {
  return _deps.logger?.logError || ((msg: string, err: Error) => console.error(msg, err));
}

let localVLM: any = null;
let onnxSession: any = null;

async function loadLocalVLM() { 
  const CONFIG = getCONFIG();
  const log = getLog();
  const logError = getLogError();
  if (!localVLM && CONFIG.ENABLE_LOCAL_VLM) {
    try {
      const { pipeline } = await import('@xenova/transformers');
      localVLM = await pipeline('image-to-text', CONFIG.LOCAL_VLM_MODEL);
      log('Local VLM loaded.', 'INFO', 'vision');
    } catch (e: any) { logError('Local VLM load failed', e as Error); }
  }
  return localVLM;
}

async function loadONNX() { 
  const CONFIG = getCONFIG();
  const log = getLog();
  const logError = getLogError();
  if (!onnxSession && CONFIG.ENABLE_LOCAL_VLM) {
    try {
      const onnx = await import('onnxruntime-node');
      onnxSession = await onnx.InferenceSession.create(CONFIG.GAN_MODEL_PATH);
      log('ONNX session loaded.', 'INFO', 'vision');
    } catch (e: any) { logError('ONNX load failed', e as Error); }
  }
  return onnxSession;
}

async function runVisionPipeline(base64Image: string, prompt: string, { validator = null, timeoutMs = 15000, signal }: any = {}) {
  const CONFIG = getCONFIG();
  const log = getLog();
  const logError = getLogError();
  const cache = _deps.cache || {};
  const browser = _deps.browser || {};
  const providersRegistry = _deps.providerRegistry;
  const providersBase = _deps.providersBase;
  if (!providersRegistry || !providersBase) {
    log('Vision pipeline missing required deps (providerRegistry or providersBase), aborting', 'ERROR', 'vision');
    return null;
  }

  const getCachedVisionResponse = cache.getCachedVisionResponse || (() => null);
  const setCachedVisionResponse = cache.setCachedVisionResponse || (() => {});
  const compressScreenshot = browser.compressScreenshot || ((b: string) => b);
  const getAvailableProviders = providersRegistry.getAvailableProviders;
  const recordProviderResult = providersRegistry.recordProviderResult;
  const safeCall = providersBase.safeCall;

  const cached = getCachedVisionResponse(prompt, base64Image);
  if (cached) { log('Using cached vision response', 'DEBUG', 'vision'); return cached; }
  const compressedBase64 = await compressScreenshot(base64Image, 640, 15);
  const session = await loadONNX();
  if (session) {
    try {
      if (!sharp) throw new Error('sharp not available');
      const buf = Buffer.from(compressedBase64, 'base64');
      const { data, info } = await sharp(buf).removeAlpha().resize(224, 224).raw().toBuffer({ resolveWithObject: true });
      const pixelCount = info.width * info.height;
      const floatData = new Float32Array(3 * pixelCount);
      for (let i = 0; i < pixelCount; i++) {
        floatData[i] = data[i * 3] / 255.0;
        floatData[pixelCount + i] = data[i * 3 + 1] / 255.0;
        floatData[2 * pixelCount + i] = data[i * 3 + 2] / 255.0;
      }
      let onnxTimeoutId: any;
      let result: any;
      try {
        result = await Promise.race([
          (async () => {
            const ort = require('onnxruntime-node');
            const tensor = new ort.Tensor('float32', floatData, [1, 3, info.height, info.width]);
            try {
              return await session.run({ input: tensor });
            } finally {
              tensor.dispose();
            }
          })(),
          new Promise((_, reject) => { onnxTimeoutId = setTimeout(() => reject(new Error('ONNX inference timed out')), 5000); })
        ]);
      } catch (e: any) {
        clearTimeout(onnxTimeoutId);
        throw e;
      }
      clearTimeout(onnxTimeoutId);
      if (result && result.output) {
        log('Local ONNX produced output, falling through to cloud providers', 'DEBUG', 'vision');
      }
    } catch (e: any) { log('Local ONNX inference failed', 'DEBUG', 'vision'); }
  }

  let providers = await getAvailableProviders();
  const priority = CONFIG.VISION_PRIORITY || 'cloud';
  if (priority === 'local-first') {
    providers = [...providers].sort((a: any, b: any) => {
      if (a.name === 'local-vlm') return -1;
      if (b.name === 'local-vlm') return 1;
      return 0;
    });
  }
  const groqProvider = providers.find((p: any) => p.name === 'Groq');
  const otherProviders = providers.filter((p: any) => p.name !== 'Groq');
  const orderedProviders = groqProvider ? [groqProvider, ...otherProviders] : providers;

  if (orderedProviders.length === 0) {
    log('No vision providers available, trying local fallback...', 'WARN', 'vision');
    if (CONFIG.ENABLE_LOCAL_VLM) {
      const vlm = await loadLocalVLM();
      if (vlm) {
        try {
          const buf = Buffer.from(compressedBase64, 'base64');
          const result = await vlm(buf, { prompt, max_new_tokens: 50 });
          const text = result[0]?.generated_text || '';
          const jsonMatch = text.match(/\{(?:[^{}]|\{[^{}]*\})*\}/);
          if (jsonMatch) {
            const parsed = JSON.parse(jsonMatch[0]);
            const validated = validator ? validator(parsed) : parsed;
            setCachedVisionResponse(prompt, base64Image, { result: validated, provider: 'local-vlm' });
            return { result: validated, provider: 'local-vlm' };
          }
        } catch (e: any) { logError('Local VLM inference failed', e as Error); }
      }
    }
    return null;
  }

  const promises = orderedProviders.map(async (provider: any) => {
    if (signal?.aborted) throw new Error('Aborted');
    const start = Date.now();
    try {
      const raw = await safeCall((sig: any) => provider.fn(compressedBase64, prompt, sig, { validate: false }), `Vision ${provider.name}`, { timeoutMs, url: provider.name, maxRetries: 1, signal });
      const latency = Date.now() - start;
      let parsed: any;
      let rawClean = (raw || '').trim();
      if (rawClean.startsWith('```')) rawClean = rawClean.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      try { parsed = JSON.parse(rawClean); } catch (e: any) { log(`Provider ${provider.name} returned invalid JSON: ${e.message}`, 'DEBUG', 'vision'); recordProviderResult(provider.name, false, latency); return null; }
      let result = parsed;
      if (validator) { try { result = validator(parsed); } catch (e: any) { log(`Provider ${provider.name} validation failed: ${e.message}`, 'DEBUG', 'vision'); recordProviderResult(provider.name, false, latency); return null; } }
      recordProviderResult(provider.name, true, latency);
      return { result, provider: provider.name };
    } catch (err: any) {
      log(`Provider ${provider.name} vision failed: ${err.message}`, 'DEBUG', 'vision');
      recordProviderResult(provider.name, false, Date.now() - start);
      return null;
    }
  });

  const results = await Promise.allSettled(promises);
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value !== null) {
      setCachedVisionResponse(prompt, base64Image, r.value);
      return r.value;
    }
  }
  if (CONFIG.ENABLE_LOCAL_VLM) {
    const vlm = await loadLocalVLM();
    if (vlm) {
      try {
        const buf = Buffer.from(compressedBase64, 'base64');
        const result = await vlm(buf, { prompt, max_new_tokens: 50 });
        const text = result[0]?.generated_text || '';
        const jsonMatch = text.match(/\{(?:[^{}]|\{[^{}]*\})*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          const validated = validator ? validator(parsed) : parsed;
          setCachedVisionResponse(prompt, base64Image, { result: validated, provider: 'local-vlm' });
          return { result: validated, provider: 'local-vlm' };
        }
      } catch (e: any) { logError('Local VLM fallback failed', e as Error); }
    }
  }
  return null;
}

module.exports = { runVisionPipeline, _injectDependencies };
