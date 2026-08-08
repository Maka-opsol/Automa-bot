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
// BetterStack Logtail — ships all logs to BetterStack
// ═══════════════════════════════════════════════════════════════
let logtail: any = null;
try {
  const { Node: Logtail } = require('@logtail/js');
  logtail = new Logtail('NHp5ngRUznwzrAZBsi2NZYpZ', {
    endpoint: 'https://s2663647.eu-central-1a.betterstackdata.com',
  });
} catch (e: any) {
  console.error(`[logger] BetterStack Logtail not available: ${e.message}`);
}

// pino destination that forwards to BetterStack
const logtailDestination = logtail ? pino.destination({
  write: (data: string) => {
    try {
      const parsed = JSON.parse(data);
      logtail.log(parsed.message || data, {
        level: parsed.level || 'info',
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
      rollDest.then((dest: any) => { logStream = dest; }).catch(() => {});
    } else if (rollDest && typeof rollDest.write === 'function') {
      logStream = rollDest;
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
  if (Array.isArray(obj)) return obj.map(item => deepRedact(item, depth + 1, maxDepth));
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
const streams = [logStream];
if (logtailDestination) streams.push(logtailDestination);

const logger = pino({
  level: parseLogLevel(process.env.LOG_LEVEL),
  formatters: {
    level: (label: any) => ({ level: label.toUpperCase() }),
    bindings: (bindings: any) => bindings ? { pid: bindings.pid, host: bindings.hostname?.substring(0, 50) || 'unknown' } : {}
  },
  timestamp: () => `,"timestamp":"${new Date().toISOString()}"`,
  base: undefined,
  serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
  redact: { paths: ['req.headers.authorization', 'req.headers.cookie'], censor: '[REDACTED]' }
}, logtailDestination
  ? pino.multistream(streams)
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
  logtail,
};
