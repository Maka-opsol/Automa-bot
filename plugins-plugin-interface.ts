'use strict';

let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
const getCONFIG: any = new Proxy({}, { get: (_, prop) => _deps.config?.[prop] });
const log = (...args: any[]) => _deps.logger?.log?.(...args) ?? console.log(...args);
const logError = (...args: any[]) => _deps.logger?.logError?.(...args) ?? console.error(...args);


class PluginAPI {
  stateDetectors: any;
  selectorOverrides: any;
  registeredPlugins: any;
  actions: any;
  hooks: any;

  constructor() {
    this.actions = new Map();
    this.stateDetectors = new Map();
    this.selectorOverrides = new Map();
    this.hooks = { preAction: [], postAction: [], onError: [] };
    this.registeredPlugins = [];
  }

  registerAction(name: any, handler: any) { 
    if (typeof name !== 'string' || typeof handler !== 'function') {
      throw new Error('Invalid action registration');
    }
    this.actions.set(name, handler);
    log(`Registered plugin action: ${name}`, 'DEBUG', 'plugin-api');
  }

  registerStateDetector(domain: any, detectorFn: any) { 
    if (typeof domain !== 'string' || typeof detectorFn !== 'function') {
      throw new Error('Invalid state detector registration');
    }
    this.stateDetectors.set(domain, detectorFn);
    log(`Registered state detector for: ${domain}`, 'DEBUG', 'plugin-api');
  }

  registerSelectorOverrides(domain: any, selectors: any) { 
    if (typeof domain !== 'string' || typeof selectors !== 'object') {
      throw new Error('Invalid selector override registration');
    }
    this.selectorOverrides.set(domain, selectors);
    log(`Registered selector overrides for: ${domain}`, 'DEBUG', 'plugin-api');
  }

  registerHook(type: any, handler: any) { 
    if (!this.hooks[type]) {
      throw new Error(`Unknown hook type: ${type}`);
    }
    this.hooks[type].push(handler);
  }

  getAction(name: any) { 
    return this.actions.get(name) || null;
  }

  getStateDetector(url: any) { 
    for (const [domain, detector] of this.stateDetectors) {
      if (url.includes(domain)) {
        return detector;
      }
    }
    return null;
  }

  getSelectorOverrides(domain: any) { 
    for (const [d, selectors] of this.selectorOverrides) {
      if (domain.includes(d) || d.includes(domain)) {
        return selectors;
      }
    }
    return null;
  }

  runHooks(type: any, context: any) { 
    const hooks = this.hooks[type] || [];
    for (const hook of hooks) {
      try {
        hook(context);
      } catch (err: any) {
        logError(`Plugin hook (${type}) failed`, err);
      }
    }
  }

  registerPlugin(name: any, version: any, _api: any) { 
    this.registeredPlugins.push({ name, version, registeredAt: Date.now() });
    log(`Plugin registered: ${name} v${version}`, 'INFO', 'plugin-api');
  }

  getRegisteredPlugins() { 
    return [...this.registeredPlugins];
  }
}

const pluginAPI = new PluginAPI();

module.exports = { pluginAPI, _injectDependencies };
