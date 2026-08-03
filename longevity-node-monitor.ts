'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getDb() { return _deps.database?.db; }
function getUpsertRuntimeVersion() { return _deps.database?.upsertRuntimeVersion; }
function getSendAlert() { return _deps.alerting?.sendAlert || (() => {}); }

const { log, logError } = require('./logger');
const CONFIG = require('./get-config');
// Node.js release schedule (major -> EOL date)
// Source: https://nodejs.org/en/about/releases/
const NODE_EOL_SCHEDULE = {
  18: '2025-04-30',
  19: '2025-06-01',  // Not an LTS
  20: '2026-04-30',
  21: '2025-10-01',  // Not an LTS
  22: '2027-04-30',
  23: '2026-06-01',  // Not an LTS
  24: '2028-04-30',
};

const NODE_LTS_VERSIONS = new Set([18, 20, 22, 24]);

function getNodeMajor() { 
  return parseInt(process.version.replace('v', '').split('.')[0], 10);
}

function getNodeEOLInfo() { 
  const major = getNodeMajor();
  const eolStr = (NODE_EOL_SCHEDULE as any)[major] || 'unknown';
  const eolDate = eolStr !== 'unknown' ? new Date(eolStr) : null;
  const isLTS = NODE_LTS_VERSIONS.has(major);
  const now = new Date();
// @ts-expect-error
  const daysUntilEOL = eolDate ? Math.ceil((eolDate - now) / (1000 * 60 * 60 * 24)) : null;
  return { major, version: process.version, eolDate: eolStr, isLTS, daysUntilEOL };
}

function checkNodeVersion() { 
  const info = getNodeEOLInfo();
  getUpsertRuntimeVersion()?.run('node', info.version, Date.now());

  if (info.daysUntilEOL !== null && info.daysUntilEOL < 0) {
    const msg = `Node.js ${info.version} reached EOL on ${info.eolDate}! Upgrade ASAP.`;
    log(msg, 'ERROR', 'node-monitor');
    if (CONFIG.ALERT_ON_ERROR) getSendAlert()(msg).catch(() => {});
  } else if (info.daysUntilEOL !== null && info.daysUntilEOL < 90) {
    const msg = `Node.js ${info.version} reaches EOL in ${info.daysUntilEOL} days (${info.eolDate}). Plan upgrade.`;
    log(msg, 'WARN', 'node-monitor');
  } else if (info.daysUntilEOL !== null) {
    log(`Node.js ${info.version} - ${info.isLTS ? 'LTS' : 'Current'}, EOL in ${info.daysUntilEOL} days. OK.`, 'INFO', 'node-monitor');
  }

  if (info.major < 18) {
    log(`Node.js ${info.version} is below minimum v18.0.0. Many features may not work.`, 'ERROR', 'node-monitor');
  }

  return info;
}

function startNodeVersionMonitor() { 
  // Re-check every 24 hours
  const interval = setInterval(() => { try { checkNodeVersion(); } catch (e: any) { try { logError('Periodic node version check failed', e); } catch {} } }, 24 * 60 * 60 * 1000);
  if (interval.unref) interval.unref();
  log('Node.js version monitor started.', 'INFO', 'node-monitor');
}

function getStatus() { 
  return getNodeEOLInfo();
}

module.exports = { startNodeVersionMonitor, checkNodeVersion, getStatus, getNodeEOLInfo ,
  _injectDependencies,
};