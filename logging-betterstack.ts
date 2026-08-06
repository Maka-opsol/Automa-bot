'use strict';

// ─── BetterStack Logtail Integration ─────────────────────────────────────────
//
// Sends structured logs to BetterStack's Logtail service via HTTPS POST.
// Works as a lightweight pino "transport" target — no pino-pretty needed.
//
// Why BetterStack:
//   - Free tier: 1 GB/month log ingestion, 3-day retention
//   - Logtail endpoint is a simple HTTPS POST (no SDK required)
//   - Structured JSON logs with levels, timestamps, and metadata
//   - Real-time log explorer, alerts, and dashboards
//   - Perfect for Render free tier (ephemeral disk = no persistent logs)
//
// Architecture:
//   - Pino logs → this module → batches → HTTPS POST to BetterStack
//   - Buffered: logs batched in memory, flushed every 5 seconds OR when
//     buffer reaches 50 messages (whichever comes first)
//   - Non-blocking: all I/O is async, errors are logged but never thrown
//   - Graceful disable: if BETTERSTACK_SOURCE_TOKEN is missing, this is a no-op
//
// Environment variables:
//   BETTERSTACK_SOURCE_TOKEN — Your Logtail source token (from BetterStack dashboard)
//   BETTERSTACK_ENDPOINT     — Override the ingest URL (default: https://in.logs.betterstack.com)
//   BETTERSTACK_FLUSH_MS      — Flush interval in ms (default: 5000)
//   BETTERSTACK_BATCH_SIZE    — Max messages per batch (default: 50)
//
// If BETTERSTACK_SOURCE_TOKEN is missing, this module is a no-op.

const https = require('https');
const http = require('http');

let _token: string | null = null;
let _endpoint: string = 'https://in.logs.betterstack.com';
let _flushMs = 5000;
let _batchSize = 50;
let _buffer: any[] = [];
let _flushTimer: any = null;
let _started = false;
let _totalSent = 0;
let _totalErrors = 0;
let _totalDropped = 0;

function _log(msg: string, level: string = 'INFO') {
  try { console.log(`[${new Date().toISOString()}] [betterstack:${level}] ${msg}`); }
  catch { /* silent */ }
}

function _init() {
  if (_started) return;
  _started = true;

  _token = process.env.BETTERSTACK_SOURCE_TOKEN || null;
  _endpoint = process.env.BETTERSTACK_ENDPOINT || 'https://in.logs.betterstack.com';
  _flushMs = parseInt(process.env.BETTERSTACK_FLUSH_MS || '5000', 10);
  _batchSize = parseInt(process.env.BETTERSTACK_BATCH_SIZE || '50', 10);

  if (!_token) {
    _log('BetterStack not configured (missing BETTERSTACK_SOURCE_TOKEN). Log shipping disabled.', 'INFO');
    return;
  }

  // Start flush timer
  _flushTimer = setInterval(() => {
    flush().catch(() => {});
  }, _flushMs);
  if (_flushTimer?.unref) _flushTimer.unref();

  // Flush on process exit
  process.on('exit', () => {
    try {
      // Synchronous best-effort flush on exit — fire and forget
      if (_buffer.length > 0) {
        const payload = JSON.stringify(_buffer);
        _buffer = [];
        _send(payload);
      }
    } catch { /* best effort */ }
  });

  _log(`BetterStack Logtail initialized (endpoint: ${_endpoint}, flush: ${_flushMs}ms, batch: ${_batchSize})`);
}

/**
 * Send a log entry to BetterStack.
 * The entry is buffered and flushed periodically.
 */
function send(entry: any): void {
  if (!_token) return;

  try {
    // Ensure the entry has required Logtail fields
    const logEntry = {
      timestamp: entry.timestamp || new Date().toISOString(),
      level: normalizeLevel(entry.level || 'info'),
      message: typeof entry.message === 'string' ? entry.message : JSON.stringify(entry.message),
      ...entry,
    };

    // Remove duplicate timestamp/message if already set at top level
    delete (logEntry as any).ts;
    delete (logEntry as any).time;

    _buffer.push(logEntry);

    // Flush if batch is full
    if (_buffer.length >= _batchSize) {
      flush().catch(() => {});
    }
  } catch {
    _totalDropped++;
  }
}

function normalizeLevel(level: string | number): string {
  // Pino levels: 10=trace, 20=debug, 30=info, 40=warn, 50=error, 60=fatal
  if (typeof level === 'number') {
    if (level >= 60) return 'fatal';
    if (level >= 50) return 'error';
    if (level >= 40) return 'warn';
    if (level >= 30) return 'info';
    if (level >= 20) return 'debug';
    return 'trace';
  }
  const normalized = String(level).toLowerCase();
  const valid = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  return valid.includes(normalized) ? normalized : 'info';
}

/**
 * Flush the current buffer to BetterStack.
 */
async function flush(): Promise<void> {
  if (_buffer.length === 0) return;
  if (!_token) return;

  // Swap buffer atomically
  const batch = _buffer;
  _buffer = [];

  try {
    const payload = JSON.stringify(batch);
    await _send(payload);
    _totalSent += batch.length;
  } catch (err: any) {
    _totalErrors += batch.length;
    // Re-add failed messages to buffer (up to a limit to prevent memory leak)
    if (_buffer.length < _batchSize * 3) {
      _buffer.push(...batch);
    } else {
      _totalDropped += batch.length;
      _log(`Buffer overflow — dropped ${batch.length} messages`, 'WARN');
    }
  }
}

/**
 * Send a JSON payload to BetterStack via HTTPS POST.
 * Returns a promise that resolves on success or rejects on failure.
 */
function _send(payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!_token) { reject(new Error('No token')); return; }

    const url = new URL(_endpoint);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? https : http;

    const postData = Buffer.from(payload, 'utf-8');
    const options = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname || '/',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(postData.length),
        'Authorization': `Bearer ${_token}`,
      },
      timeout: 10000, // 10 second timeout
    };

    const req = transport.request(options, (res: any) => {
      let body = '';
      res.on('data', (chunk: any) => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`HTTP ${res.statusCode}: ${body.substring(0, 200)}`));
        }
      });
    });

    req.on('error', (err: any) => {
      reject(err);
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Request timed out'));
    });

    req.write(postData);
    req.end();
  });
}

/**
 * Start the BetterStack logging service.
 * Must be called once during application startup.
 */
function startBetterStackLogging(): void {
  _init();
}

/**
 * Stop the BetterStack logging service.
 * Flushes remaining logs before stopping.
 */
async function stopBetterStackLogging(): Promise<void> {
  if (_flushTimer) {
    clearInterval(_flushTimer);
    _flushTimer = null;
  }
  await flush();
}

/**
 * Get BetterStack status for monitoring/dashboard.
 */
function getBetterStackStatus(): {
  enabled: boolean;
  tokenSet: boolean;
  totalSent: number;
  totalErrors: number;
  totalDropped: number;
  bufferSize: number;
  endpoint: string;
} {
  return {
    enabled: !!_token,
    tokenSet: !!_token,
    totalSent: _totalSent,
    totalErrors: _totalErrors,
    totalDropped: _totalDropped,
    bufferSize: _buffer.length,
    endpoint: _token ? _endpoint.replace(/\/\/.*@/, '//***@') : 'not configured',
  };
}

module.exports = {
  startBetterStackLogging,
  stopBetterStackLogging,
  send,
  flush,
  getBetterStackStatus,
};
