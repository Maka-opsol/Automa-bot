'use strict';

// ═══════════════════════════════════════════════════════════════════════════
// CIRCULAR DEPENDENCY GUARD
// ═══════════════════════════════════════════════════════════════════════════
// This module MUST NOT require './config' at the top level.
// config.ts is loaded via the lazy CONFIG() function below to break
// the cycle: container-container → logger → config (lazy, not eager).
//
// If you add an eager require('./config') here, you WILL create a hard
// circular dependency crash. Always use the CONFIG() accessor instead.
// ═══════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const os = require('os');
const pino = require('pino');
const pinoRoll = require('pino-roll');

// ═══════════════════════════════════════════════════════════════
// BetterStack Logtail — ships logs to BetterStack via logging-betterstack.ts
// FIX: Replaced @logtail/js SDK with direct logging-betterstack.ts usage.
// The @logtail/js Node SDK internally echoes output to console/stdout,
// which caused every log line to appear twice (once from pino stdout,
// once from the SDK's internal console output). logging-betterstack.ts uses
// raw HTTPS POST with in-memory buffering — no stdout side-effects.
let _betterstack: any = null;
let _betterstackAvailable = false;
try {
  _betterstack = require('./logging-betterstack');
  _betterstackAvailable = !!_betterstack && !!process.env.BETTERSTACK_SOURCE_TOKEN;
} catch { /* logging-betterstack not available */ }

// pino destination that forwards to BetterStack via logging-betterstack.ts (direct HTTPS)
const logtailDestination = _betterstackAvailable ? pino.destination({
  write: (data: string) => {
    try {
      const parsed = JSON.parse(data);
      _betterstack.send({
        level: parsed.level || 'info',
        message: parsed.msg || parsed.message || data,
        module: parsed.module || 'main',
        timestamp: parsed.timestamp || new Date().toISOString(),
        pid: parsed.pid,
        host: parsed.host,
      });
    } catch { /* best effort */ }
  },
  sync: false,
}) : null;

const VALID_LOG_LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_PER_WINDOW = 100;

// v5-fix: Lazy-load CONFIG to avoid circular dependency.
// DO NOT convert this to a top-level require — see guard above.
let _CONFIG: any = null;
function CONFIG() { if (!_CONFIG) _CONFIG = require('./config'); return _CONFIG; }

function checkRateLimit(key = 'default') { 
  const now = Date.now();
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX_PER_WINDOW) return false;
  entry.count++;
  return true;
}

// LOG_DIR and logStream are initialized lazily to avoid circular dependency with config
let LOG_DIR = path.join(os.tmpdir(), 'mathu-bot-logs');
let logStream = process.stdout;
let _logInitDone = false;

// FIX: Track whether file stream was successfully initialized
let _fileStreamReady = false;

function _initLogStream() { 
  if (_logInitDone) return;
  _logInitDone = true;
  try {
    const cfg = CONFIG();
    if (cfg.LOG_DIR) LOG_DIR = cfg.LOG_DIR;
    if (!fs.existsSync(LOG_DIR)) {
      try { fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o750 }); }
      catch { LOG_DIR = path.join(os.tmpdir(), 'mathu-bot-logs'); }
    }
    try { fs.accessSync(LOG_DIR, fs.constants.W_OK); }
    catch {
      LOG_DIR = path.join(os.tmpdir(), 'mathu-bot-logs');
      try { fs.mkdirSync(LOG_DIR, { recursive: true, mode: 0o750 }); } catch {}
    }
    const rollDest = pinoRoll({
      file: path.join(LOG_DIR, 'daemon.log'),
      size: `${cfg.LOG_MAX_SIZE_MB || 50}M`,
      interval: cfg.LOG_ROTATE_INTERVAL || '1d',
      max: cfg.LOG_MAX_FILES || 5,
    });
    if (rollDest && typeof rollDest.then === 'function') {
      rollDest.then((dest: any) => {
        logStream = dest;
        _fileStreamReady = true;
        // When both BetterStack and file are ready, wrap the logtail
        // destination to also forward to the file stream.
        if (logtailDestination) {
          const fileDest = dest;
          const origLogtailWrite = logtailDestination.write.bind(logtailDestination);
          logtailDestination.write = function(chunk: string, enc: string, cb: Function) {
            origLogtailWrite(chunk, enc, cb);
            // Also write to file
            try { fileDest.write(chunk, enc, cb); } catch {}
          };
        }
      }).catch(() => {});
    } else if (rollDest && typeof rollDest.write === 'function') {
      logStream = rollDest;
      _fileStreamReady = true;
    }
    // Also ensure CONFIG.LOG_DIR exists (failsafe health check needs it)
    if (cfg.LOG_DIR && cfg.LOG_DIR !== LOG_DIR && !fs.existsSync(cfg.LOG_DIR)) {
      try { fs.mkdirSync(cfg.LOG_DIR, { recursive: true, mode: 0o750 }); } catch {}
    }
  } catch (err: any) {
    console.error(`Log file init failed, using stdout: ${err.message}`);
  }
}

const REDACTION_PATTERNS = [
  { pattern: /((?:api[_\-]?key|apikey|token|secret|password|passwd))\s*[=:]\s*["']?[a-zA-Z0-9_\-\.]{8,}["']?/gi, replacement: '$1=[REDACTED]' },
  { pattern: /Bearer\s+[a-zA-Z0-9_\-\.]+/gi, replacement: 'Bearer [REDACTED]' },
  { pattern: /(?:=|:)\s*["']?[a-zA-Z0-9_\-]{60,}["']?/g, replacement: '=[REDACTED_LONG_STRING]' },
  { pattern: /(mongodb|postgres|mysql|redis):\/\/[^\s]+/gi, replacement: '$1://[REDACTED_CONNECTION_STRING]' },
  { pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  { pattern: /\/(?:home|opt|app|var|srv|usr)\/[\w\-\.]+\/[\w\-\.]+\//g, replacement: '[REDACTED_PATH]/' },
  { pattern: /(?:file:\/\/).*?\.js:\d+:\d+/g, replacement: '[REDACTED_FILE]' },
  { pattern: /eyJ[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+\.[a-zA-Z0-9_\-]+/g, replacement: '[REDACTED_JWT]' },
];

function redactSensitive(text: any) { 
  if (typeof text !== 'string') return String(text);
  let redacted = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }
  return redacted;
}

function deepRedact(obj: any, depth = 0, maxDepth = 5) { 
  if (depth > maxDepth) return '[MAX_DEPTH]';
  if (obj === null || obj === undefined) return obj;
  const sensitiveKeys = new Set([
    'password', 'passwd', 'pass', 'secret', 'token', 'apikey', 'api_key',
    'accesstoken', 'access_token', 'refreshtoken', 'refresh_token',
    'privatekey', 'private_key', 'credential', 'authorization'
  ]);
  if (typeof obj === 'string') return redactSensitive(obj);
  // Defensive: use Object.prototype.toString when Array.isArray is corrupted
  // (happens under memory pressure on Render when global Array is shadowed)
  const isArray = typeof Array.isArray === 'function'
    ? Array.isArray(obj)
    : Object.prototype.toString.call(obj) === '[object Array]';
  if (isArray) return obj.map(item => deepRedact(item, depth + 1, maxDepth));
  if (typeof obj === 'object') {
    const redacted = {};
    for (const [key, value] of Object.entries(obj)) {
      const keyLower = key.toLowerCase().replace(/[_-]/g, '');
      if (sensitiveKeys.has(keyLower) || keyLower.includes('password') || keyLower.includes('secret')) {
        (redacted as any)[key] = '[REDACTED]';
      } else if (typeof value === 'string' && value.length > 50) {
        (redacted as any)[key] = redactSensitive(value);
      } else {
        (redacted as any)[key] = deepRedact(value, depth + 1, maxDepth);
      }
    }
    return redacted;
  }
  return obj;
}

function parseLogLevel(level: any) { 
  if (typeof level !== 'string') return 'info';
  const normalized = level.toLowerCase().trim();
  return VALID_LOG_LEVELS.has(normalized) ? normalized : 'info';
}

// Start with stdout; _initLogStream() is called after config is fully loaded
// (called from config.js or agent.js) to switch to file logging
// If BetterStack Logtail is available, use multi-stream to ship logs to both file and BetterStack
// FIX: Capture real Array at module load so pino internals can be
// repaired when the global is corrupted under Render memory pressure.
const _realArray = Array;

// FIX: Dedup wrapper — prevents duplicate log lines when pino multistream
// fans out to multiple destinations that both resolve to stdout.
const _lastLogMsg = new Map<string, number>();
const _DEDUP_WINDOW_MS = 500;
function _dedupWrite(originalWrite: any) {
  return function(chunk: string, enc: string, cb: Function) {
    try {
      const key = chunk.substring(0, 200);
      const now = Date.now();
      const last = _lastLogMsg.get(key);
      if (last && now - last < _DEDUP_WINDOW_MS) {
        if (typeof cb === 'function') cb();
        return; // suppress duplicate
      }
      _lastLogMsg.set(key, now);
      // Prune old entries periodically
      if (_lastLogMsg.size > 50) {
        for (const [k, t] of _lastLogMsg) { if (now - t > _DEDUP_WINDOW_MS) _lastLogMsg.delete(k); }
      }
    } catch { /* non-critical */ }
    return originalWrite.call(this, chunk, enc, cb);
  };
}

// FIX: When BetterStack is active, do NOT include stdout in the multistream.
// Previously [stdout, logtailDestination] was used, and @logtail/js echoed back
// to stdout — every line appeared twice. Now only BetterStack stream is in
// multistream; stdout gets a single copy via the file path or is excluded.
// When BetterStack is absent, stdout is the sole destination (normal).
const streams: any[] = [];
if (logtailDestination) {
  // BetterStack-only mode: no stdout (avoids duplication)
  streams.push(logtailDestination);
} else {
  // Fallback: write to stdout (or file once _initLogStream swaps logStream)
  streams.push(logStream);
}

// Wrap each stream with dedup to prevent double-output
const dedupStreams = streams.map((s: any) => {
  if (s && typeof s.write === 'function' && s !== process.stdout) {
    const origWrite = s.write.bind(s);
    s.write = _dedupWrite(origWrite);
  }
  return s;
});

const logger = pino({
  level: parseLogLevel(process.env.LOG_LEVEL),
  formatters: {
    level: (label: any) => ({ level: label.toUpperCase() }),
    bindings: (bindings: any) => bindings ? { pid: bindings.pid, host: bindings.hostname?.substring(0, 50) || 'unknown' } : {}
  },
  timestamp: () => {
  // SAST = UTC+2 — shift the time and use +02:00 offset instead of Z
  const d = new Date(Date.now() + 2 * 3600000);
  const iso = d.toISOString();
  return `,"timestamp":"${iso.replace('Z', '+02:00')}"`;
},
  base: undefined,
  serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[REDACTED]' }
}, logtailDestination
  ? pino.multistream(dedupStreams)
  : logStream
);

logger.on('error', (err: any) => { console.error(`Logger error: ${err.message}`); });

function createChildLogger(moduleName: any) { 
  if (typeof moduleName !== 'string' || moduleName.length > 50) moduleName = 'unknown';
  const sanitized = moduleName.replace(/[^a-zA-Z0-9_\-]/g, '_');
  return logger.child({ module: sanitized });
}

const _childLoggerCache = new Map();

function log(message: any, level = 'INFO', module = 'main') { 
  try {
    // Auto-initialize file logging on first call
    if (!_logInitDone) _initLogStream();
    const levelMap = { 'DEBUG': 'debug', 'INFO': 'info', 'WARN': 'warn', 'ERROR': 'error', 'FATAL': 'fatal', 'TRACE': 'trace' };
    const lvl = (levelMap as any)[level?.toUpperCase()] || 'info';
    const safeModule = (typeof module === 'string' ? module : 'main').replace(/[^a-zA-Z0-9_\-]/g, '_').substring(0, 50);
    if (lvl === 'debug' && !checkRateLimit(safeModule)) return;
    let safeMessage;
    if (typeof message === 'string') {
      safeMessage = message.substring(0, 10000);
    } else if (message instanceof Error) {
      safeMessage = `${message.message}\n${message.stack?.substring(0, 5000) || ''}`;
    } else {
      try { safeMessage = JSON.stringify(message)?.substring(0, 10000) || String(message); } catch { safeMessage = '[UNSTRINGIFIABLE_MESSAGE]'; }
    }
    // FIX: Repair corrupted global Array before pino touches it.
    // Pino internally calls Array.isArray during serialization;
    // under Render memory pressure this global can be corrupted.
    if (typeof Array.isArray !== 'function') {
      try { (globalThis as any).Array = _realArray; } catch { /* best effort */ }
    }
    let child = _childLoggerCache.get(safeModule);
    if (!child) { child = logger.child({ module: safeModule }); _childLoggerCache.set(safeModule, child); }
    child[lvl](safeMessage);
  } catch (err: any) {
    console.error(`Log failure: ${err.message}`, { originalMessage: String(message)?.substring(0, 100) });
  }
}

function safeLog(message: any, level = 'INFO', module = 'main') { 
  if (typeof message === 'object' && message !== null) {
    const redacted = deepRedact(message);
    log(redacted, level, module);
  } else {
    const redacted = redactSensitive(String(message));
    log(redacted, level, module);
  }
}

function setLogLevel(level: any) { 
  const parsed = parseLogLevel(level);
  logger.level = parsed;
  log(`Log level changed to: ${parsed}`, 'INFO', 'logger');
}

function logError(operation: any, error: any, context = {}) { 
  safeLog({
    operation,
    error: {
      name: error?.name,
      message: error?.message,
      code: error?.code,
      stack: error?.stack?.split('\n')?.slice(0, 5),
    },
    ...context,
  }, 'ERROR', (context as any).module || 'main');
}

function logMetric(name: any, value: any, unit = '') { 
  safeLog({ metric: name, value, unit }, 'INFO', 'metrics');
}

function logAudit(action: any, details = {}) { 
  safeLog({ action, ...details, timestamp: new Date().toISOString() }, 'INFO', 'audit');
}

module.exports = {
  log,
  safeLog,
  logError,
  logMetric,
  logAudit,
  setLogLevel,
  createChildLogger,
  logger,
  redactSensitive,
  deepRedact,
  initFileLogging: _initLogStream,
  // logtail removed: replaced by logging-betterstack.ts (no stdout side-effects)
  _betterstackAvailable,
};
