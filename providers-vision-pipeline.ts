'use strict';

// ─── Vision Pipeline ─────────────────────────────────────────────────────────
//
// Orchestrates vision analysis across multiple providers with:
//   - Local ONNX pre-processing (optional)
//   - Local VLM fallback (optional, @xenova/transformers)
//   - Cloud provider parallel execution via tribunal
//   - Response caching
//   - Automatic fallback from cloud → local on total failure
//
// Design notes:
//   - Uses DI deps (providerRegistry, providersBase) rather than direct
//     requires to avoid circular dependency chains
//   - recordProviderResult is called explicitly for DB persistence.
//     safeCall already records to providers-health internally, so this
//     is a second write for long-term stats only (not a bug).
//   - Groq priority is preserved for speed (Groq uses LPU inference
//     and is typically the fastest vision provider)

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

/**
 * Run local VLM inference as a fallback when all cloud providers fail.
 * Returns parsed result or null.
 */
async function tryLocalVLM(
  compressedBase64: string,
  prompt: string,
  validator: any,
  setCachedVisionResponse: (prompt: string, image: string, result: any) => void,
  base64Image: string
): Promise<any> {
  const log = getLog();
  const logError = getLogError();
  const CONFIG = getCONFIG();

  if (!CONFIG.ENABLE_LOCAL_VLM) return null;

  const vlm = await loadLocalVLM();
  if (!vlm) {
    log('Local VLM not available (load failed or disabled)', 'DEBUG', 'vision');
    return null;
  }

  try {
    const buf = Buffer.from(compressedBase64, 'base64');
    const result = await vlm(buf, { prompt, max_new_tokens: 50 });
    const text = result[0]?.generated_text || '';
    const jsonMatch = text.match(/\{(?:[^{}]|\{[^{}]*\})*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const validated = validator ? validator(parsed) : parsed;
      setCachedVisionResponse(prompt, base64Image, { result: validated, provider: 'local-vlm' });
      log('Local VLM fallback succeeded', 'INFO', 'vision');
      return { result: validated, provider: 'local-vlm' };
    }
    log('Local VLM returned non-JSON output', 'DEBUG', 'vision');
  } catch (e: any) {
    logError('Local VLM inference failed', e as Error);
  }
  return null;
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

  // Check cache
  const cached = getCachedVisionResponse(prompt, base64Image);
  if (cached) { log('Using cached vision response', 'DEBUG', 'vision'); return cached; }

  const compressedBase64 = await compressScreenshot(base64Image, 640, 15);

  // ─── Optional: Local ONNX pre-processing ───
  // This runs ONNX inference but doesn't use the result directly —
  // it's a pre-processing step that may inform future analysis.
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
      try {
        await Promise.race([
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
      } finally {
        clearTimeout(onnxTimeoutId);
      }
    } catch (e: any) {
      log(`Local ONNX inference failed: ${e.message || e}`, 'DEBUG', 'vision');
    }
  }

  // ─── Cloud provider execution ───
  let providers = await getAvailableProviders();

  // Groq priority: move Groq to front for speed (LPU inference is fastest).
  // This is intentional — Groq's llama-3.2-11b-vision is both fast and good at OCR.
  // The registry returns health-sorted providers, but we override for vision-specific speed.
  const groqProvider = providers.find((p: any) => p.name === 'Groq');
  const otherProviders = providers.filter((p: any) => p.name !== 'Groq');
  const orderedProviders = groqProvider ? [groqProvider, ...otherProviders] : providers;

  if (orderedProviders.length === 0) {
    log('No cloud providers available, falling back to local VLM...', 'WARN', 'vision');
    return await tryLocalVLM(compressedBase64, prompt, validator, setCachedVisionResponse, base64Image);
  }

  // Execute all providers in parallel
  const promises = orderedProviders.map(async (provider: any) => {
    if (signal?.aborted) throw new Error('Aborted');
    const start = Date.now();
    try {
      const raw = await safeCall(
        (sig: any) => provider.fn(compressedBase64, prompt, sig, { validate: false }),
        `Vision ${provider.name}`,
        { timeoutMs, url: provider.name, maxRetries: 1, signal }
      );
      const latency = Date.now() - start;

      // Parse response
      let parsed: any;
      let rawClean = (raw || '').trim();
      if (rawClean.startsWith('```')) rawClean = rawClean.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '').trim();
      try {
        parsed = JSON.parse(rawClean);
      } catch (e: any) {
        log(`Provider ${provider.name} returned invalid JSON: ${e.message}`, 'DEBUG', 'vision');
        recordProviderResult(provider.name, false, latency);
        return null;
      }

      // Validate
      let result = parsed;
      if (validator) {
        try { result = validator(parsed); }
        catch (e: any) {
          log(`Provider ${provider.name} validation failed: ${e.message}`, 'DEBUG', 'vision');
          recordProviderResult(provider.name, false, latency);
          return null;
        }
      }

      recordProviderResult(provider.name, true, latency);
      return { result, provider: provider.name };
    } catch (err: any) {
      const latency = Date.now() - start;
      // Only log at DEBUG — the safeCall already logged at WARN with structured details
      log(`Provider ${provider.name} vision failed: ${err.message || err}`, 'DEBUG', 'vision');
      recordProviderResult(provider.name, false, latency);
      return null;
    }
  });

  const results = await Promise.allSettled(promises);

  // Return first successful result (providers are ordered by health + Groq priority)
  const failedCount = results.filter(r => r.status === 'rejected' || r.value === null).length;
  for (const r of results) {
    if (r.status === 'fulfilled' && r.value !== null) {
      if (failedCount > 0) {
        log(`Vision pipeline: ${failedCount}/${results.length} providers failed, using ${r.value.provider}`, 'INFO', 'vision');
      }
      setCachedVisionResponse(prompt, base64Image, r.value);
      return r.value;
    }
  }

  // ─── All cloud providers failed → local VLM fallback ───
  log(`All ${results.length} cloud providers failed for vision, attempting local VLM fallback`, 'WARN', 'vision');
  return await tryLocalVLM(compressedBase64, prompt, validator, setCachedVisionResponse, base64Image);
}

module.exports = { runVisionPipeline, _injectDependencies };
