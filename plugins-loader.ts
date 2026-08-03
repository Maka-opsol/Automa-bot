'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

let _allPluginTimerIds: (NodeJS.Timeout | undefined)[] = [];

const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');
const vm = require('vm');
const { log, logError } = require('./logger');
function getPluginInterface() { return _deps.pluginAPI || require('./plugins-plugin-interface'); }

const PLUGIN_DIR = path.join(PROJECT_ROOT, 'plugins');
const ALLOWED_PLUGIN_NAMES = /^[a-zA-Z0-9_-]+\.js$/;

// C3 FIX: Maximum timers a single plugin can register (prevents resource exhaustion)
const MAX_TIMERS_PER_PLUGIN = 5;

/**
 * Create a safe console proxy that only exposes logging methods.
 * The real console object exposes _stdout, _stderr, and other internal
 * properties that plugins could abuse to escape the sandbox.
 */
function createSafeConsole(pluginName: string) {
  return Object.create(null, {
    log:    { value: (...args: any[]) => log(`[plugin:${pluginName}]`, ...args), writable: false, enumerable: true },
    info:   { value: (...args: any[]) => log(`[plugin:${pluginName}]`, 'INFO', ...args), writable: false, enumerable: true },
    warn:   { value: (...args: any[]) => log(`[plugin:${pluginName}]`, 'WARN', ...args), writable: false, enumerable: true },
    error:  { value: (...args: any[]) => logError(`[plugin:${pluginName}]`, ...args), writable: false, enumerable: true },
    debug:  { value: (...args: any[]) => log(`[plugin:${pluginName}]`, 'DEBUG', ...args), writable: false, enumerable: true },
  });
}

function loadPlugins() { 
  if (!fs.existsSync(PLUGIN_DIR)) {
    fs.mkdirSync(PLUGIN_DIR, { recursive: true });
    log(`Created plugin directory: ${PLUGIN_DIR}`, 'INFO', 'plugin-loader');
    return;
  }
  const files = fs.readdirSync(PLUGIN_DIR).filter((f: any) => ALLOWED_PLUGIN_NAMES.test(f));
  for (const file of files) {
    const timerIds: (NodeJS.Timeout | undefined)[] = [];
    try {
      const filePath = path.join(PLUGIN_DIR, file);
      const code = fs.readFileSync(filePath, 'utf8');

      // C3 FIX: Limit code size to prevent oversized plugin attacks
      const MAX_PLUGIN_SIZE = 100 * 1024; // 100KB
      if (Buffer.byteLength(code, 'utf8') > MAX_PLUGIN_SIZE) {
        logError(`Plugin ${file} exceeds maximum size (${MAX_PLUGIN_SIZE / 1024}KB), skipping`);
        continue;
      }

      // C3 FIX: Use Object.create(null) as the base so the sandbox
      // has NO prototype chain to the host's Object. This prevents
      // plugins from walking up the prototype chain to access host objects.
      const sandbox: Record<string, any> = Object.create(null);

      // C3 FIX: Replace real console with a safe proxy (no _stdout, _stderr, etc.)
      sandbox.console = createSafeConsole(file);

      // C3 FIX: Wrap timer functions to track and limit them.
      // Each plugin is limited to MAX_TIMERS_PER_PLUGIN timers.
      sandbox.setTimeout = (fn: any, ms: number, ...args: any[]) => {
        if (timerIds.length >= MAX_TIMERS_PER_PLUGIN) {
          throw new Error(`Plugin ${file}: timer limit (${MAX_TIMERS_PER_PLUGIN}) reached`);
        }
        if (typeof fn !== 'function') throw new TypeError('setTimeout callback must be a function');
        const id = setTimeout(() => {
          const idx = timerIds.indexOf(id);
          if (idx >= 0) timerIds.splice(idx, 1);
          try { fn(...args); } catch (timerErr: any) {
            logError(`Plugin ${file} timer callback error`, timerErr);
          }
        }, ms);
        timerIds.push(id);
        return id;
      };
      sandbox.setInterval = (fn: any, ms: number, ...args: any[]) => {
        if (timerIds.length >= MAX_TIMERS_PER_PLUGIN) {
          throw new Error(`Plugin ${file}: timer limit (${MAX_TIMERS_PER_PLUGIN}) reached`);
        }
        if (typeof fn !== 'function') throw new TypeError('setInterval callback must be a function');
        const id = setInterval(() => {
          try { fn(...args); } catch (timerErr: any) {
            logError(`Plugin ${file} interval callback error`, timerErr);
          }
        }, ms);
        timerIds.push(id);
        return id;
      };
      sandbox.clearTimeout = (id: any) => { clearTimeout(id); const idx = timerIds.indexOf(id); if (idx >= 0) timerIds.splice(idx, 1); };
      sandbox.clearInterval = (id: any) => { clearInterval(id); const idx = timerIds.indexOf(id); if (idx >= 0) timerIds.splice(idx, 1); };

      // Safe built-in globals (no access to process, require, Buffer, etc.)
      sandbox.Promise = Promise;
      sandbox.Date = Date;
      sandbox.Math = Math;
      sandbox.JSON = JSON;
      sandbox.Array = Array;
      sandbox.Object = Object;
      sandbox.String = String;
      sandbox.Number = Number;
      sandbox.Boolean = Boolean;
      sandbox.RegExp = RegExp;
      sandbox.Map = Map;
      sandbox.Set = Set;
      sandbox.Error = Error;
      sandbox.TypeError = TypeError;
      sandbox.RangeError = RangeError;

      // C3 FIX: Restricted require — only allow safe, read-only built-in modules.
      // This require is a wrapper, NOT the real require, so plugins cannot
      // use prototype chain tricks on it.
      sandbox.require = Object.create(null, {
        [Symbol.toPrimitive]: { value: () => { throw new Error('Plugin require is not a function'); } },
      });
      // Use a function property to intercept calls
      const restrictedRequire = (mod: string) => {
        const allowed = new Set(['path', 'util', 'crypto', 'stream', 'events']);
        if (allowed.has(mod)) {
          return require(mod);
        }
        throw new Error(`Plugin cannot require: ${mod}`);
      };
      // Make it non-constructable and non-extensible
      Object.defineProperty(sandbox, 'require', {
        value: Object.freeze(restrictedRequire),
        writable: false,
        enumerable: true,
        configurable: false,
      });

      // C3 FIX: Do NOT expose module/exports — instead, capture the return value
      // of the script execution. The old approach of passing sandbox.module.exports
      // shared an object between the sandbox and the host, allowing escape.
      // Instead, plugins export their API by assigning to a variable we detect after execution.
      sandbox.__pluginExports = undefined;

      const script = new vm.Script(code, {
        filename: file,
        timeout: 5000,
      });
      const context = vm.createContext(sandbox, {
        codeGeneration: {
          strings: false,   // C3 FIX: Disallow eval() and Function() inside the sandbox
          wasm: false,      // C3 FIX: Disallow WebAssembly
        },
      });
      const result = script.runInContext(context, { timeout: 5000 });

      // C3 FIX: Check for exports via the __pluginExports escape hatch OR
      // via a CommonJS pattern detected by scanning the result.
      // If the plugin sets module.exports or exports.init, it won't work
      // because we no longer provide those objects. Instead, the plugin
      // should use the pluginAPI passed via init.
      //
      // Support two patterns:
      //   Pattern 1 (recommended): Plugin calls pluginAPI.<method> directly
      //   Pattern 2 (legacy compat): Plugin returns an object with init()
      const exports = sandbox.__pluginExports !== undefined ? sandbox.__pluginExports : result;

      if (exports && typeof exports === 'object' && typeof exports.init === 'function') {
        // Run init with pluginAPI, but wrap in try-catch to prevent
        // a buggy plugin init from crashing the host.
        try {
          exports.init(getPluginInterface().pluginAPI);
          log(`Loaded plugin: ${file}`, 'INFO', 'plugin-loader');
        } catch (initErr: any) {
          logError(`Plugin ${file} init() threw an error`, initErr);
          // Clean up any timers the plugin registered during failed init
          for (const tid of timerIds) { clearTimeout(tid); clearInterval(tid); }
        }
      } else if (typeof exports === 'function') {
        try {
          exports(getPluginInterface().pluginAPI);
          log(`Loaded plugin (export function): ${file}`, 'INFO', 'plugin-loader');
        } catch (fnErr: any) {
          logError(`Plugin ${file} export function threw an error`, fnErr);
          for (const tid of timerIds) { clearTimeout(tid); clearInterval(tid); }
        }
      } else {
        log(`Plugin ${file} has no init function, skipping`, 'WARN', 'plugin-loader');
        // Still clean up any timers that may have been set during script execution
        for (const tid of timerIds) { clearTimeout(tid); clearInterval(tid); }
      }
    } catch (err: any) {
      logError(`Failed to load plugin ${file}`, err);
    }
    // Track surviving plugin timers for cleanup on reload
    _allPluginTimerIds.push(...timerIds);
  }
}

function reloadPlugins() { 
  for (const id of _allPluginTimerIds) { if (id !== undefined) { clearTimeout(id); clearInterval(id); } }
  _allPluginTimerIds = [];
  const pluginAPI = getPluginInterface().pluginAPI;
  pluginAPI.actions.clear();
  pluginAPI.stateDetectors.clear();
  pluginAPI.selectorOverrides.clear();
  pluginAPI.hooks.preAction = [];
  pluginAPI.hooks.postAction = [];
  pluginAPI.hooks.onError = [];
  loadPlugins();
}

module.exports = { loadPlugins, reloadPlugins, _injectDependencies };
