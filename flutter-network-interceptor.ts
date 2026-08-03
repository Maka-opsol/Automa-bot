'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getInsertNetworkLog() { return _deps.database?.insertNetworkLog; }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');
class FlutterNetworkInterceptor {
  capturedRequests: any;
  apiEndpoints: any;
  status: any;

  constructor() {
    this.capturedRequests = [];
    this.apiEndpoints = new Set();
  }

  async setupInterception(page: any) { 
    await page.route('**/*', (route: any) => {
      const request = route.request();
      const url = request.url();
      if (url.includes(CONFIG.APP_URL) && (url.includes('/api/') || url.includes('graphql'))) {
        if (request.method() === 'POST') {
          const postData = request.postData();
          const headers = request.headers();
          this.capturedRequests.push({ url, method: 'POST', data: postData, headers, timestamp: Date.now() });
          if (this.capturedRequests.length > 100) this.capturedRequests.shift();
          try { getInsertNetworkLog()?.run(url, 'POST', postData || '', JSON.stringify(headers), Date.now(), 0); } catch (_e: any) { /* network log insert failed */ }
          log(`📡 Intercepted API call: ${url}`, 'DEBUG', 'network');
        }
      }
      route.continue();
    });
    page.on('response', (response: any) => {
      if (response.url().includes('/complete') && response.status() === 200) { log('✅ Module completion API call succeeded!', 'INFO', 'network'); }
    });
    log('🌐 Network interceptor active.', 'INFO', 'network');
  }

  getLastSubmission(urlContains = 'submit') { 
    return [...this.capturedRequests].reverse().find(req => req.url.includes(urlContains));
  }

  async replayRequest(page: any, capturedReq: any) { 
    if (!capturedReq) return false;
    log(`🔄 Replaying intercepted request to ${capturedReq.url}`, 'INFO', 'network');
    try {
      const FORBIDDEN = new Set(['host', 'origin', 'referer', 'cookie', 'connection', 'content-length']);
      const safeHeaders = {};
      for (const [k, v] of Object.entries(capturedReq.headers || {})) {
        if (!FORBIDDEN.has(k.toLowerCase())) (safeHeaders as any)[k] = v;
      }
      const response = await page.evaluate(async (req: any) => {
        const res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.data });
        return (res as any).status;
      }, { ...capturedReq, headers: safeHeaders });
      return response === 200 || response === 201;
    } catch (e: any) { logError('Network replay failed', e); return false; }
  }
}

module.exports = Object.assign(new FlutterNetworkInterceptor(), { _injectDependencies });
