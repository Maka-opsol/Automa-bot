'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);
const CONFIG = require('./get-config');

function _getFetch(): any {
  return globalThis.fetch;
}

let captchaQueue: any[] = [];
let processingQueue = false;

async function processQueue() { 
  if (processingQueue || captchaQueue.length === 0) return;
  processingQueue = true;
  while (captchaQueue.length > 0) {
    const { base64Image, instruction, resolve, reject } = captchaQueue.shift();
    try { const result = await solveCaptchaExternalInternal(base64Image, instruction); resolve(result); } catch (e: any) { reject(e); }
  }
  processingQueue = false;
}

function enqueueCaptcha(base64Image: any, instruction: any) { 
  if (captchaQueue.length >= (CONFIG.CAPTCHA_QUEUE_MAX || 10)) {
    return Promise.reject(new Error('Captcha queue full'));
  }
  return new Promise((resolve, reject) => {
    captchaQueue.push({ base64Image, instruction, resolve, reject });
    processQueue();
  });
}

async function solveCaptchaExternal(base64Image: any, instruction = null) { 
  return enqueueCaptcha(base64Image, instruction);
}

async function solveCaptchaExternalInternal(base64Image: any, instruction = null) { 
  const fetchFn = _getFetch();
  if (!fetchFn) { log('No fetch implementation available', 'ERROR', 'captcha'); return null; }
  if (CONFIG.CAPTCHA_SERVICE === '2captcha' && CONFIG.CAPTCHA_API_KEY) {
    log('🔧 Solving CAPTCHA via 2Captcha...', 'INFO', 'captcha');
    try {
      const formData = new URLSearchParams();
      formData.append('key', CONFIG.CAPTCHA_API_KEY);
      formData.append('method', 'base64');
      formData.append('body', base64Image);
      formData.append('json', '1');
      if (instruction) { formData.append('instructions', instruction); }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      const response = await fetchFn('https://2captcha.com/in.php', { method: 'POST', body: formData, signal: controller.signal });
      clearTimeout(timer);
      const data = await response.json();
      if (data.status === 1 && data.request) {
        const captchaId = data.request;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const pollController = new AbortController();
          const pollTimer = setTimeout(() => pollController.abort(), 10000);
          try {
            const pollRes = await fetchFn(`https://2captcha.com/res.php?key=${encodeURIComponent(CONFIG.CAPTCHA_API_KEY)}&action=get&id=${captchaId}&json=1`, { signal: pollController.signal });
            clearTimeout(pollTimer);
            const pollData = await pollRes.json();
            if (pollData.status === 1) { return pollData.request; } else if (pollData.request === 'CAPTCHA_NOT_READY') { continue; } else { log(`2Captcha error: ${pollData.request}`, 'WARN', 'captcha'); return null; }
          } catch (pollErr: any) { clearTimeout(pollTimer); if (pollErr.name === 'AbortError') { log('2Captcha poll timed out, retrying...', 'WARN', 'captcha'); continue; } throw pollErr; }
        }
      } else { log(`2Captcha error: ${data.request}`, 'WARN', 'captcha'); return null; }
    } catch (e: any) { logError('2Captcha failed', e); return null; }
  } else if (CONFIG.CAPTCHA_SERVICE === 'anticaptcha' && CONFIG.CAPTCHA_API_KEY) {
    log('🔧 Solving CAPTCHA via AntiCaptcha...', 'INFO', 'captcha');
    try {
      const payload = { clientKey: CONFIG.CAPTCHA_API_KEY, task: { type: 'ImageToTextTask', body: base64Image, module: 'ocr', case: true } };
      const controller2 = new AbortController();
      const timer2 = setTimeout(() => controller2.abort(), 15000);
      const response = await fetchFn('https://api.anti-captcha.com/createTask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller2.signal });
      clearTimeout(timer2);
      const data = await response.json();
      if (data.errorId === 0 && data.taskId) {
        const taskId = data.taskId;
        for (let i = 0; i < 20; i++) {
          await new Promise(r => setTimeout(r, 5000));
          const pollController = new AbortController();
          const pollTimer = setTimeout(() => pollController.abort(), 10000);
          try {
            const pollRes = await fetchFn('https://api.anti-captcha.com/getTaskResult', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ clientKey: CONFIG.CAPTCHA_API_KEY, taskId }), signal: pollController.signal });
            clearTimeout(pollTimer);
            const pollData = await pollRes.json();
            if (pollData.status === 'ready') { return pollData.solution.text; } else if (pollData.status === 'processing') { continue; } else { log(`AntiCaptcha error: ${pollData.errorDescription}`, 'WARN', 'captcha'); return null; }
          } catch (pollErr: any) { clearTimeout(pollTimer); if (pollErr.name === 'AbortError') { log('AntiCaptcha poll timed out, retrying...', 'WARN', 'captcha'); continue; } throw pollErr; }
        }
      } else { log(`AntiCaptcha error: ${data.errorDescription}`, 'WARN', 'captcha'); return null; }
    } catch (e: any) { logError('AntiCaptcha failed', e); return null; }
  }
  return null;
}

module.exports = { solveCaptchaExternal, _injectDependencies };
