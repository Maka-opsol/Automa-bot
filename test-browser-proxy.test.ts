import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import http from 'node:http';
import { chromium } from 'playwright';
import { browserProxy, configuredProxyUrl, proxyLaunchOptions, proxyContextOptions, safeBrowserError } from './browser-proxy';

require('tsx/cjs/api').register();
const coordinator = require('./parallel-coordinator');
const phoenix = require('./browser-phoenix');
const browserModule = require('./browser');
const selfHeal = require('./self-heal');
const executablePath = process.env.TEST_CHROMIUM_PATH || '/usr/bin/chromium';
const logs: string[] = [];
let target: http.Server, proxy: http.Server;
let targetPort = 0, proxyPort = 0, proxyHits = 0, targetHits = 0, authenticatedHits = 0;
const username = 'u-proxy-test', password = 'p-proxy-test';
const listen = (server: http.Server) => new Promise<number>(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as any).port)));
const close = (server: http.Server) => new Promise<void>(resolve => server.close(() => resolve()));
let browser: any;

beforeAll(async () => {
  target = http.createServer((_req, res) => { targetHits++; res.end('direct-target'); });
  proxy = http.createServer((req, res) => {
    proxyHits++;
    if (req.headers['proxy-authorization'] !== 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64')) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="local"' }); res.end('auth required'); return;
    }
    authenticatedHits++;
    res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('routed-via-proxy');
  });
  targetPort = await listen(target); proxyPort = await listen(proxy);
});
afterEach(async () => {
  if (browser) { await browser.close(); browser = null; }
  delete process.env.BROWSER_PROXY_URL; delete process.env.PROXY_URLS;
  delete (globalThis as any).__proxyDisabled; logs.length = 0;
});
afterAll(async () => { await close(proxy); await close(target); });

const cfg = () => ({ BROWSER_PROXY_URL: `http://${username}:${password}@127.0.0.1:${proxyPort}`, CHROMIUM_EXECUTABLE_PATH: executablePath });
const targetUrl = () => `http://127.0.0.1:${targetPort}/test`;
const logger = { log: (s: string) => logs.push(s), logError: (s: string, e: any) => logs.push(s + String(e)) };

describe('browser proxy policy', () => {
  it('uses direct by default, handles credentials and precedence', () => {
    expect(browserProxy({})).toBeUndefined();
    expect(browserProxy({ BROWSER_PROXY_URL: 'http://user%40name:p%3Ass@[::1]:3128', PROXY_URLS: 'http://other:9' })).toEqual({server:'http://[::1]:3128', username:'user@name', password:'p:ss'});
    expect(configuredProxyUrl({ PROXY_URLS: 'http://first:1,http://second:2' })).toBe('http://first:1');
  });
  it('rejects bad URLs and authenticated SOCKS without printing secrets', () => {
    for (const value of ['socks5://sensitive-user:sensitive-pass@localhost:1080', 'not-a-url-sensitive-pass', 'http://user:secret@host/path']) {
      let error = ''; try { browserProxy({ BROWSER_PROXY_URL: value }); } catch (e) { error = String(e); }
      expect(error).toBeTruthy(); expect(error).not.toContain('sensitive'); expect(error).not.toContain('secret');
    }
    expect(() => browserProxy({BROWSER_PROXY_URL:'socks5://u:p@host:1080'})).toThrow('Authenticated SOCKS');
    expect(safeBrowserError(new Error('bad secret'), cfg())).not.toContain('secret');
  });
  it('redacts diagnostic network errors', () => {
    const c=cfg(); const rotator=require('./network-ip-rotator'); rotator._injectDependencies({config:c, logger});
    rotator.recordNetworkError(new Error(c.BROWSER_PROXY_URL));
    expect(JSON.stringify(rotator.getLatestNetworkError())).not.toContain(password);
    expect(logs.join('\n')).not.toContain(password);
  });
  it('classifies original network errors while withholding secrets everywhere', () => {
    const c = cfg(); const rotator = require('./network-ip-rotator'); rotator._injectDependencies({config:c, logger});
    for (const [message, expected] of [['net::ERR_PROXY_CONNECTION_FAILED', 'ERR_PROXY_CONNECTION_FAILED'], ['net::ERR_TUNNEL_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED'], ['Timeout 30000ms exceeded', 'NAV_TIMEOUT']]) {
      rotator.recordNetworkError(new Error(message + ' ' + c.BROWSER_PROXY_URL), {url:c.BROWSER_PROXY_URL});
      const record = rotator.getLatestNetworkError();
      expect(record.errorType).toBe(expected); expect(JSON.stringify(record)).not.toContain(password);
    }
    expect(logs.join('\n')).not.toContain(password);
  });
  it('redacts login and worker loop failures', async () => {
    const c = cfg(); coordinator._injectDependencies({config:c, logger});
    const instance = new coordinator.ParallelCoordinator();
    const worker = {page:{goto:async()=>{throw new Error(c.BROWSER_PROXY_URL)}}, currentModule:null, errors:0};
    expect(await instance._ensureLoggedIn(worker, 0)).toBe(false);
    instance.workers.set(0, worker); instance.running = true;
    instance._ensureLoggedIn = async()=>{throw new Error(c.BROWSER_PROXY_URL)};
    instance._sleep = async()=>{instance.running = false};
    await instance._runWorkerLoop(0);
    expect(worker.errors).toBe(1); expect(logs.join('\n')).not.toContain(password);
    expect(logs.join('\n')).toContain('details withheld');
  });
  it('redacts retry errors in logs and the thrown error', async () => {
    const c = cfg(); browserModule._injectDependencies({config:c, logger});
    const manager = browserModule.browserManager;
    const originalLaunch = manager.launch, originalCleanup = manager.cleanup;
    try {
      manager.launch = async () => ({});
      manager.cleanup = async () => {};
      let thrown: any;
      try { await manager.withBrowserRetry(async () => { throw new Error('retry ' + c.BROWSER_PROXY_URL); }, 2); } catch (e) { thrown = e; }
      expect(String(thrown)).toContain('details withheld');
      expect(String(thrown.stack)).not.toContain(password);
      expect(logs.join('\n')).not.toContain(username);
      expect(logs.join('\n')).not.toContain(password);
    } finally { manager.launch = originalLaunch; manager.cleanup = originalCleanup; }
  });
  it('redacts browser, page and popup handler errors', async () => {
    const c = cfg(); const captured: string[] = [];
    const stackLogger = { log: (s: string) => logs.push(s), logError: (s: string, e: any) => { logs.push(s + String(e)); captured.push(String(e.stack)); } };
    browserModule._injectDependencies({config:c, logger:stackLogger, cache:{loadSession:()=>null}});
    const manager = browserModule.browserManager;
    const saved = {browser:manager.browserInstance, context:manager.contextInstance, page:manager.pageInstance, calibrate:manager.calibrateViewport};
    const handlers: Record<string, any> = {}, pageHandlers: Record<string, any> = {}, contextHandlers: Record<string, any> = {};
    const fakePage = {setDefaultTimeout(){}, setDefaultNavigationTimeout(){}, addInitScript:async()=>{}, on:(name:string, fn:any)=>pageHandlers[name]=fn, viewportSize:()=>({width:1280,height:720})};
    const context = {on:(name:string, fn:any)=>contextHandlers[name]=fn, newPage:async()=>fakePage};
    manager.browserInstance = {on:(name:string, fn:any)=>handlers[name]=fn, newContext:async()=>context};
    manager.calibrateViewport = async()=>null;
    try {
      manager.setupBrowserHandlers();
      await manager.setupContext(); await manager.configurePage();
      handlers.error(new Error(c.BROWSER_PROXY_URL));
      pageHandlers.error(new Error(c.BROWSER_PROXY_URL));
      await contextHandlers.page({close:async()=>{throw new Error(c.BROWSER_PROXY_URL)}});
      const output = logs.join('\n');
      expect(output).toContain('Browser process error'); expect(output).toContain('Page error'); expect(output).toContain('Failed to close popup');
      expect(output).not.toContain(username); expect(output).not.toContain(password);
      expect(captured).toHaveLength(3); expect(captured.join('\n')).not.toContain(username); expect(captured.join('\n')).not.toContain(password);
    } finally { manager.browserInstance=saved.browser; manager.contextInstance=saved.context; manager.pageInstance=saved.page; manager.calibrateViewport=saved.calibrate; }
  });
  it('fails closed when disabled', () => {
    (globalThis as any).__proxyDisabled = true;
    expect(() => browserProxy(cfg())).toThrow('refusing direct connection');
  });
  it('preserves independent HTTP proxy environment variables when bypassing', () => {
    const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY'] as const;
    const saved = names.map(name => process.env[name]);
    try {
      names.forEach((name, i) => { process.env[name] = ['http://independent:81', 'http://independent:82', 'example.test'][i]; });
      const rotator = require('./network-ip-rotator');
      rotator._injectDependencies({config:cfg(), logger});
      rotator.bypassProxy('test');
      expect(names.map(name => process.env[name])).toEqual(['http://independent:81', 'http://independent:82', 'example.test']);
      expect(() => browserProxy(cfg())).toThrow('refusing direct connection');
    } finally {
      names.forEach((name, i) => { if (saved[i] === undefined) delete process.env[name]; else process.env[name] = saved[i]; });
    }
  });
});

describe('actual Chromium routes through local authenticated proxy', () => {
  it('routes the manager context and worker contexts, while direct control reaches target', async () => {
    const c = cfg();
    browser = await chromium.launch({executablePath, headless:true, args:['--no-sandbox'], ...proxyLaunchOptions(c)});
    const directBrowser = await chromium.launch({executablePath, headless:true, args:['--no-sandbox']});
    try {
      const page = await directBrowser.newPage();
      expect(await (await page.goto(targetUrl()))!.text()).toBe('direct-target');
    } finally { await directBrowser.close(); }
    const beforeTarget = targetHits, beforeAuth = authenticatedHits;
    browserModule._injectDependencies({config:c, logger, cache:{loadSession:()=>null}});
    const manager = browserModule.browserManager;
    manager.browserInstance = browser;
    await manager.setupContext();
    const mainPage = await manager.contextInstance.newPage();
    expect(await (await mainPage.goto(targetUrl()))!.text()).toBe('routed-via-proxy');
    coordinator._injectDependencies({config:c, logger});
    const workerCoordinator = new coordinator.ParallelCoordinator();
    workerCoordinator.browser = browser;
    await workerCoordinator._createWorker(0); await workerCoordinator._createWorker(1);
    for (const worker of workerCoordinator.workers.values()) {
      expect(await (await worker.page.goto(targetUrl()))!.text()).toBe('routed-via-proxy');
    }
    expect(authenticatedHits - beforeAuth).toBeGreaterThanOrEqual(3);
    expect(targetHits).toBe(beforeTarget);
    expect(logs.join('\n')).not.toContain(password);
  }, 30000);
  it('routes the config updater context via the authenticated proxy', async () => {
    const c = cfg(); process.env.BROWSER_PROXY_URL = c.BROWSER_PROXY_URL;
    browser = await chromium.launch({executablePath, headless:true, args:['--no-sandbox'], ...proxyLaunchOptions(c)});
    const contexts = browser.newContext.bind(browser);
    const beforeTarget = targetHits, beforeAuth = authenticatedHits;
    let received: any, body = '';
    browserModule.browserManager.browserInstance = {
      isConnected: () => true,
      newContext: async (options: any) => {
        received = options;
        const context = await contexts(options);
        const newPage = context.newPage.bind(context);
        context.newPage = async () => {
          const page = await newPage();
          const goto = page.goto.bind(page);
          page.goto = async () => {
            const response = await goto(targetUrl(), {timeout:5000});
            body = await response!.text();
            throw new Error('stop updater after test');
          };
          return page;
        };
        return context;
      },
    };
    try {
      const updater = require('./cycle-config-updater');
      await updater.discoverAndUpdateProvider('Groq');
      expect(received).toEqual(proxyContextOptions(c));
      expect(body).toBe('routed-via-proxy');
      expect(authenticatedHits).toBeGreaterThan(beforeAuth);
      expect(targetHits).toBe(beforeTarget);
    } finally { browserModule.browserManager.browserInstance = null; }
  }, 30000);
  it('blocks updater context creation when proxy use is disabled', async () => {
    const c = cfg(); process.env.BROWSER_PROXY_URL = c.BROWSER_PROXY_URL;
    (globalThis as any).__proxyDisabled = true;
    let created = false;
    browserModule.browserManager.browserInstance = {
      isConnected: () => true,
      newContext: async () => { created = true; throw new Error('unexpected context'); },
    };
    try {
      await require('./cycle-config-updater').discoverAndUpdateProvider('Groq');
      expect(created).toBe(false);
    } finally { browserModule.browserManager.browserInstance = null; }
  });
  it('routes isolated self-heal fallback via proxy, without reaching target', async () => {
    const c = {...cfg(), APP_URL:`http://127.0.0.1:${targetPort}`};
    selfHeal._injectDependencies({config:c, logger, browser:{getPage:()=>null}});
    const beforeTarget=targetHits, beforeAuth=authenticatedHits;
    const result=await selfHeal.investigatePage();
    expect(result).not.toBeNull(); expect(authenticatedHits).toBeGreaterThan(beforeAuth);
    expect(targetHits).toBe(beforeTarget); expect(logs.join('\n')).not.toContain(password);
  }, 30000);
  it('fails closed in isolated self-heal when proxy is unavailable', async () => {
    const dead=http.createServer(); const port=await listen(dead); await close(dead);
    const c={BROWSER_PROXY_URL:`http://${username}:${password}@127.0.0.1:${port}`,CHROMIUM_EXECUTABLE_PATH:executablePath,APP_URL:`http://127.0.0.1:${targetPort}`};
    selfHeal._injectDependencies({config:c, logger, browser:{getPage:()=>null}});
    const beforeTarget=targetHits;
    expect(await selfHeal.investigatePage()).toBeNull(); expect(targetHits).toBe(beforeTarget);
    expect(logs.join('\n')).not.toContain(password);
  }, 30000);
  it('routes Phoenix tier 2 and tier 3 through proxy', async () => {
    const c = cfg(); phoenix._injectDependencies({config:c, logger});
    const beforeTarget = targetHits, beforeAuth = authenticatedHits;
    for (const tier of [2,3]) {
      const result = await phoenix._launchWithFlags({}, ['--no-sandbox'], tier);
      try { expect(await (await result.page.goto(targetUrl()))!.text()).toBe('routed-via-proxy'); }
      finally { await result.browser.close(); }
    }
    expect(authenticatedHits - beforeAuth).toBeGreaterThanOrEqual(2);
    expect(targetHits).toBe(beforeTarget);
  }, 30000);
  it('does not reach the target when proxy authentication fails', async () => {
    const c = {BROWSER_PROXY_URL:`http://wrong:wrong@127.0.0.1:${proxyPort}`};
    browser = await chromium.launch({executablePath,headless:true,args:['--no-sandbox'],...proxyLaunchOptions(c)});
    const page = await (await browser.newContext(proxyContextOptions(c))).newPage();
    const beforeTarget = targetHits, beforeProxy = proxyHits, beforeAuth = authenticatedHits;
    let response: any = null;
    try { response = await page.goto(targetUrl(), {timeout:5000}); } catch { /* Chromium may reject navigation on proxy auth failure */ }
    if (response) expect(response.status()).toBe(407);
    expect(proxyHits).toBeGreaterThan(beforeProxy); expect(authenticatedHits).toBe(beforeAuth); expect(targetHits).toBe(beforeTarget);
  }, 15000);
  it('never falls back directly when configured proxy is unreachable', async () => {
    const dead = http.createServer(); const port = await listen(dead); await close(dead);
    const c = {BROWSER_PROXY_URL:`http://127.0.0.1:${port}`};
    browser = await chromium.launch({executablePath,headless:true,args:['--no-sandbox'],...proxyLaunchOptions(c)});
    const context = await browser.newContext(proxyContextOptions(c)); const page = await context.newPage();
    const beforeTarget = targetHits;
    await expect(page.goto(targetUrl(), {timeout:5000})).rejects.toThrow();
    expect(targetHits).toBe(beforeTarget);
  }, 15000);
  it('sanitizes worker creation errors instead of exposing proxy credentials', async () => {
    const c=cfg(); coordinator._injectDependencies({config:c, logger});
    const instance = new coordinator.ParallelCoordinator();
    instance.browser = {newContext: async () => {throw new Error(c.BROWSER_PROXY_URL);}};
    await expect(instance._createWorker(0)).rejects.toThrow('details withheld');
    expect(logs.join('\n')).not.toContain(password);
  });
});
