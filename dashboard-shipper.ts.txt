// ═══════════════════════════════════════════════════════════════════════
// Dashboard Shipper — sends telemetry to Render dashboard
// ═══════════════════════════════════════════════════════════════════════
//
// Sends logs, stats, screenshots, and actions to the Render dashboard.
// Non-blocking, non-fatal — if the dashboard is down, the bot continues.
//
// ENV:
//   DASHBOARD_URL=https://mathu-bot.onrender.com  (required)
//   DASHBOARD_KEY=shared-secret  (must match dashboard's DASHBOARD_KEY)
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const http = require('http');
const https = require('https');

const DASHBOARD_URL = process.env.DASHBOARD_URL || '';
const API_KEY = process.env.DASHBOARD_KEY || 'mathu-dashboard-key';

const FLUSH_INTERVAL_MS = 3000;
const MAX_BATCH_SIZE = 50;

let logBuffer = [];
let flushTimer = null;
let totalShipped = 0;
let shipErrors = 0;
let lastHeartbeat = 0;

function _post(pathname, data) {
  if (!DASHBOARD_URL) return;
  try {
    const url = new URL(pathname, DASHBOARD_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;
    const body = JSON.stringify(data);
    const req = lib.request({
      method: 'POST',
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY, 'Content-Length': Buffer.byteLength(body) },
      timeout: 10000,
    }, () => {});
    req.on('error', () => { shipErrors++; });
    req.on('timeout', () => req.destroy());
    req.write(body);
    req.end();
  } catch {}
}

function _flushLogs() {
  if (logBuffer.length === 0) return;
  const batch = logBuffer.splice(0, MAX_BATCH_SIZE * 2);
  _post('/api/logs', { logs: batch });
  totalShipped += batch.length;
}

function _ensureTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(_flushLogs, FLUSH_INTERVAL_MS);
  flushTimer.unref?.();
}

// ─── Public API ───

function shipLog(level, msg, module) {
  if (!DASHBOARD_URL) return;
  logBuffer.push({
    timestamp: new Date().toISOString(),
    level: level || 'INFO',
    module: module || 'unknown',
    msg: String(msg).substring(0, 10000),
  });
  _ensureTimer();
  if (logBuffer.length >= MAX_BATCH_SIZE * 2) _flushLogs();
}

function shipStats(stats) {
  _post('/api/stats', { ...stats, runId: process.env.GITHUB_RUN_ID });
}

function shipScreenshot(base64, label) {
  if (!DASHBOARD_URL || !base64) return;
  _post('/api/screenshot', {
    base64: base64,
    label: label || 'screenshot',
    runId: process.env.GITHUB_RUN_ID,
    timestamp: new Date().toISOString(),
  });
}

function shipAction(action) {
  _post('/api/action', { ...action, timestamp: action.timestamp || new Date().toISOString() });
}

function shipHeartbeat(stats) {
  // Send heartbeat at most every 30 seconds
  const now = Date.now();
  if (now - lastHeartbeat < 30000) return;
  lastHeartbeat = now;
  _post('/api/heartbeat', { ...stats, runId: process.env.GITHUB_RUN_ID });
}

function shipCycleComplete(questionsCompleted) {
  _post('/api/cycle-complete', { questionsCompleted });
}

function getStats() {
  return {
    enabled: !!DASHBOARD_URL,
    url: DASHBOARD_URL || null,
    buffered: logBuffer.length,
    totalShipped,
    shipErrors,
  };
}

async function flushNow() {
  _flushLogs();
}

module.exports = {
  shipLog, shipStats, shipScreenshot, shipAction,
  shipHeartbeat, shipCycleComplete, getStats, flushNow,
};
