'use strict';

/**
 * Lazy config accessor — defers require('./config') until first property access.
 *
 * This replaces direct require('./config') in all modules so that config is
 * only loaded when actually needed, not at import time. The returned Proxy
 * is transparent: `const CONFIG = require('./get-config')` works identically
 * to `const CONFIG = require('./config')` for all property reads.
 *
 * Benefits:
 * - Modules that never access CONFIG don't trigger config loading.
 * - Circular dependency issues during early boot are avoided.
 * - Config validation errors are deferred to first actual use.
 */

let _cached: any = null;

function _load(): any {
  if (!_cached) {
    _cached = require('./config');
  }
  return _cached;
}

const handler: ProxyHandler<object> = {
  get(_target: any, prop: string | symbol): any {
    return _load()[prop as string];
  },
  has(_target: any, prop: string | symbol): boolean {
    return prop in _load();
  },
  ownKeys(): ArrayLike<string | symbol> {
    return Reflect.ownKeys(_load());
  },
  getOwnPropertyDescriptor(_target: any, prop: string | symbol): PropertyDescriptor | undefined {
    return Object.getOwnPropertyDescriptor(_load(), prop);
  },
};

module.exports = new Proxy({}, handler);
