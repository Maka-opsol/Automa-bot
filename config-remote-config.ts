'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }

const { fetchJSON } = require('./utils-fetch');
const { log, logError } = require('./logger');
const fs = require('fs');
const path = require('path');
const { PROJECT_ROOT } = require('./project-root');

const REMOTE_CONFIG_URL = process.env.REMOTE_CONFIG_URL || null;
const REMOTE_CONFIG_CACHE = path.join(PROJECT_ROOT, '.remote-config.json');
const REMOTE_CONFIG_TTL = 4 * 60 * 60 * 1000;

let remoteConfig: any = null;

async function loadRemoteConfig() { 
  if (!REMOTE_CONFIG_URL) return null;
  try {
    if (fs.existsSync(REMOTE_CONFIG_CACHE)) {
      const stat = fs.statSync(REMOTE_CONFIG_CACHE);
      if (Date.now() - stat.mtimeMs < REMOTE_CONFIG_TTL) {
        const cached = JSON.parse(fs.readFileSync(REMOTE_CONFIG_CACHE, 'utf8'));
        if (isValidRemoteConfig(cached)) {
          remoteConfig = cached;
          return cached;
        }
        log('Cached remote config failed validation, re-fetching', 'WARN', 'remote-config');
      }
    }
  } catch {}
  try {
    // Reduced from 15s to 5s — at startup, 15s blocks the entire boot sequence
    // and triggers the config-reconciler's "Timed out waiting for remote config"
    // message. If the remote config server can't respond in 5s, it won't in 15s either.
    const config = await fetchJSON(REMOTE_CONFIG_URL, {}, 5000);
    if (!isValidRemoteConfig(config)) { log('Invalid remote config structure', 'WARN', 'remote-config'); return null; }
    fs.writeFileSync(REMOTE_CONFIG_CACHE, JSON.stringify(config, null, 2));
    remoteConfig = config;
    log('Loaded remote configuration', 'INFO', 'remote-config');
    return config;
  } catch (err: any) {
    // Tag with module name so it doesn't appear as unattributed output
    logError('Failed to load remote config, using local/cached fallback', err, { module: 'remote-config' });
    try { if (fs.existsSync(REMOTE_CONFIG_CACHE)) { const cached = JSON.parse(fs.readFileSync(REMOTE_CONFIG_CACHE, 'utf8')); if (typeof isValidRemoteConfig === 'function' && !isValidRemoteConfig(cached)) { log('Stale remote config cache failed validation, discarding', 'WARN', 'remote-config'); return null; } return cached; } } catch {}
    return null;
  }
}

function isValidRemoteConfig(config: any) { 
  if (!config || typeof config !== 'object' || Array.isArray(config)) return false;
  if (config.version === undefined || typeof config.version !== 'string') return false;
  if (config.updatedAt === undefined || typeof config.updatedAt !== 'number') return false;
  // Reject configs with suspicious keys (injection vectors)
  if (config.overrides && typeof config.overrides === 'object') {
    const FORBIDDEN_OVERRIDE_KEYS = ['__proto__', 'constructor', 'prototype'];
    for (const key of Object.keys(config.overrides)) {
      if (FORBIDDEN_OVERRIDE_KEYS.includes(key)) return false;
      if (typeof key !== 'string' || key.length > 100) return false;
    }
  }
  return true;
}

function getRemoteValue(key: any, defaultValue = null) { 
  if (!remoteConfig) return defaultValue;
  return remoteConfig[key] ?? defaultValue;
}

function getRemoteModels(providerName: any) { 
  if (!remoteConfig?.models) return null;
  return remoteConfig.models[providerName] || null;
}

function getRemoteSelectors(componentName: any) { 
  if (!remoteConfig?.selectors) return null;
  return remoteConfig.selectors[componentName] || null;
}

function getRemoteOverrides() { 
  if (!remoteConfig?.overrides) return {};
  return remoteConfig.overrides;
}

module.exports = {
  loadRemoteConfig,
  getRemoteValue,
  getRemoteModels,
  getRemoteSelectors,
  getRemoteOverrides,
  get remoteConfig() { return remoteConfig; },
  _injectDependencies,
};
