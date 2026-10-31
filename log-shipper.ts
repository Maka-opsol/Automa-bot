// ═══════════════════════════════════════════════════════════════════════
// Log Shipper — sends bot logs to an external log viewer (Replit)
// ═══════════════════════════════════════════════════════════════════════
//
// Hooks into the bot's logger and sends each log line to LOG_VIEWER_URL
// via HTTP POST. The log viewer (running on Replit) displays them live.
//
// CONFIG:
//   LOG_VIEWER_URL=https://your-replit-url.repl.co  (required)
//   LOG_VIEWER_KEY=your-secret-key  (must match the Replit server)
//
// If LOG_VIEWER_URL is not set, this module does nothing (no-op).
// ═══════════════════════════════════════════════════════════════════════

'use strict';

const http = require('http');
const https = require('https');

const VIEWER_URL = process.env.LOG_VIEWER_URL || '';
const API_KEY = process.env.LOG_VIEWER_KEY || 'mathu-logs-shared-key';

// Buffer logs and send in batches every 3 seconds (reduces HTTP calls)
const FLUSH_INTERVAL_MS = 3000;
const MAX_BATCH_SIZE = 50;

let logBuffer: any[] = [];
let flushTimer: any = null;
let totalShipped = 0;
let shipErrors = 0;

function _sendBatch(logs: any[]) {
  if (!VIEWER_URL || logs.length === 0) return;

  const url = new URL('/logs', VIEWER_URL);
  const isHttps = url.protocol === 'https:';
  const lib: any = isHttps ? https : http;

  const body = JSON.stringify({ logs });

  const options = {
    method: 'POST',
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': API_KEY,
      'Content-Length': Buffer.byteLength(body),
    },
    timeout: 10000, // 10s timeout — don't block the bot
  };

  const req = lib.request(options, (res: any) => {
    // Consume the response to free up memory
    res.on('data', () => {});
    res.on('end', () => {
      totalShipped += logs.length;
    });
  });

  req.on('error', (err: any) => {
    shipErrors++;
    // Don't log the error to avoid infinite recursion
    // Just silently fail — the bot continues without log shipping
  });

  req.on('timeout', () => {
    req.destroy();
  });

  req.write(body);
  req.end();
}

function _flushBuffer() {
  if (logBuffer.length === 0) return;

  // Send in chunks of MAX_BATCH_SIZE
  while (logBuffer.length > 0) {
    const batch = logBuffer.splice(0, MAX_BATCH_SIZE);
    _sendBatch(batch);
  }
}

function _ensureTimer() {
  if (flushTimer) return;
  flushTimer = setInterval(_flushBuffer, FLUSH_INTERVAL_MS);
  flushTimer.unref?.(); // Don't keep the process alive for this
}

/**
 * Ship a single log line to the external viewer.
 * Called by the logger module on every log() call.
 */
function shipLog(level: string, msg: string, module?: string) {
  if (!VIEWER_URL) return; // No-op if not configured

  logBuffer.push({
    timestamp: new Date().toISOString(),
    level: level || 'INFO',
    module: module || 'unknown',
    msg: msg,
  });

  _ensureTimer();

  // If buffer is getting large, flush immediately
  if (logBuffer.length >= MAX_BATCH_SIZE * 2) {
    _flushBuffer();
  }
}

/**
 * Get shipper stats.
 */
function getStats() {
  return {
    enabled: !!VIEWER_URL,
    url: VIEWER_URL ? VIEWER_URL.replace(/\/$/, '') : null,
    buffered: logBuffer.length,
    totalShipped,
    shipErrors,
  };
}

/**
 * Flush remaining logs immediately (call before process exit).
 */
async function flushNow() {
  _flushBuffer();
}

module.exports = { shipLog, getStats, flushNow };
