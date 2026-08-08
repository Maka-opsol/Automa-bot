'use strict';
// Last modified: 2026-08-08 — Response 4: Mathpix OCR API client with budget management

// ═══════════════════════════════════════════════════════════════════════════════
// Mathpix OCR Client — High-quality math OCR for screenshots
//
// General vision models (Gemma, Qwen) are decent at reading text but terrible
// at math notation — they confuse superscripts, subscripts, fractions, Greek
// letters, integral signs, etc. Mathpix is purpose-built for math OCR.
//
// Budget management:
//   - Free tier: ~100 calls/month
//   - Daily cap: 5 calls/day (spread across the month)
//   - Persisted to /tmp + DB calibration (same pattern as OR rate limiter)
//   - NOT used for every problem — only when OCR quality is low or notation
//     density is high (CALCULUS, PROOF types)
//
// Graceful disable: no-op if MATHPIX_APP_ID / MATHPIX_APP_KEY env vars missing
// ═══════════════════════════════════════════════════════════════════════════════

const https = require('https');
const http = require('http');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }

// ─── Configuration ──────────────────────────────────────────────────────────

const APP_ID = process.env.MATHPIX_APP_ID || '';
const APP_KEY = process.env.MATHPIX_APP_KEY || '';
const API_ENDPOINT = process.env.MATHPIX_ENDPOINT || 'https://api.mathpix.com/v3/text';

const DAILY_LIMIT = parseInt(process.env.MATHPIX_DAILY_LIMIT || '5', 10);
const ENABLED = APP_ID.length > 0 && APP_KEY.length > 0;

// ─── State ─────────────────────────────────────────────────────────────────

interface DayState {
  date: string;       // YYYY-MM-DD (UTC)
  used: number;
  lastCallAt: number;
}

let _state: DayState = {
  date: _todayUTC(),
  used: 0,
  lastCallAt: 0,
};

// ─── Persistence (/tmp + DB) ─────────────────────────────────────────────────

const _TMP_FILE = '/tmp/mathpix-rate-limit.json';

function _persistToTmp() {
  try {
    require('fs').writeFileSync(_TMP_FILE, JSON.stringify(_state), 'utf8');
  } catch { /* non-critical */ }
}

function _persistToDb() {
  try {
    const db = getDb();
    if (!db?.upsertCalibration) return;
    db.upsertCalibration.run('mathpix_rl_state', JSON.stringify(_state), Date.now());
  } catch { /* non-critical */ }
}

function _persist() {
  _persistToTmp();
  _persistToDb();
}

function _restore() {
  // Try /tmp first (fastest, most recent)
  try {
    const fs = require('fs');
    if (fs.existsSync(_TMP_FILE)) {
      const data = JSON.parse(fs.readFileSync(_TMP_FILE, 'utf8') || '{}');
      if (data.date === _todayUTC()) {
        _state = data;
        log(`Mathpix rate limiter restored from /tmp: ${_state.used}/${DAILY_LIMIT} used`, 'INFO', 'mathpix');
        return;
      }
    }
  } catch {}

  // Try DB
  try {
    const db = getDb();
    const row = db?.selectCalibration?.get('mathpix_rl_state');
    if (row?.value) {
      const data = JSON.parse(row.value);
      if (data.date === _todayUTC()) {
        _state = data;
        log(`Mathpix rate limiter restored from DB: ${_state.used}/${DAILY_LIMIT} used`, 'INFO', 'mathpix');
        return;
      }
    }
  } catch {}

  // Fresh day or no state
  _state = { date: _todayUTC(), used: 0, lastCallAt: 0 };
}

// ─── Date helpers ────────────────────────────────────────────────────────────

function _todayUTC(): string {
  return new Date().toISOString().slice(0, 10);
}

function _ensureDate() {
  if (_state.date !== _todayUTC()) {
    const yesterday = _state.date;
    _state = { date: _todayUTC(), used: 0, lastCallAt: 0 };
    _persist();
    log(`Mathpix rate limiter: new day reset (${yesterday} → ${_state.date}). Budget: ${DAILY_LIMIT} calls`, 'INFO', 'mathpix');
  }
}

// ─── Budget Check ──────────────────────────────────────────────────────────

function checkBudget(): { allowed: boolean; remaining: number; reason?: string } {
  if (!ENABLED) return { allowed: false, remaining: 0, reason: 'Mathpix not configured (missing API keys)' };
  _ensureDate();
  const remaining = DAILY_LIMIT - _state.used;
  if (remaining <= 0) {
    return { allowed: false, remaining: 0, reason: `Daily limit exhausted (${DAILY_LIMIT}/${DAILY_LIMIT})` };
  }
  return { allowed: true, remaining };
}

function recordUsage() {
  _ensureDate();
  _state.used++;
  _state.lastCallAt = Date.now();
  _persist();
}

// ─── HTTP Request Helper ────────────────────────────────────────────────────

function _httpsPost(urlStr: string, body: string, headers: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
    }, (res: any) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Mathpix HTTP ${res.statusCode}: ${data.substring(0, 200)}`));
        } else {
          resolve(data);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Mathpix request timeout (30s)')); });
    req.write(body);
    req.end();
  });
}

// ─── Core API ──────────────────────────────────────────────────────────────

interface MathpixOCRResult {
  text: string;
  latex: string;
  confidence: number;
  error?: string;
}

/**
 * Send a base64 image to Mathpix for math OCR.
 * Returns both plain text and LaTeX representation.
 */
async function ocrMath(base64Image: string): Promise<MathpixOCRResult> {
  // Budget check
  const budget = checkBudget();
  if (!budget.allowed) {
    log(`Mathpix OCR skipped: ${budget.reason}`, 'WARN', 'mathpix');
    return { text: '', latex: '', confidence: 0, error: budget.reason };
  }

  // Ensure image has data URI prefix
  let imageSrc = base64Image;
  if (!base64Image.startsWith('data:')) {
    // Detect format from the base64 header or default to jpeg
    imageSrc = `data:image/jpeg;base64,${base64Image}`;
  }

  const requestBody = JSON.stringify({
    src: imageSrc,
    ocr: ['math', 'text'],
    math_inline_delimiters: ['$$', '$'],
    include_text_in_image_output: true,
    formats: ['text', 'data'],
  });

  try {
    const responseStr = await _httpsPost(API_ENDPOINT, requestBody, {
      'app_id': APP_ID,
      'app_key': APP_KEY,
    });

    recordUsage();

    const response = JSON.parse(responseStr);

    // Extract text and LaTeX from response
    // Mathpix v3 returns { text_lines: [...], data: [...] }
    const textLines = response.text_lines || [];
    const text = textLines
      .map((l: any) => l.text || '')
      .filter((t: string) => t.length > 0)
      .join('\n');

    // LaTeX from data array
    let latex = '';
    if (response.data && Array.isArray(response.data)) {
      const mathItems = response.data.filter((d: any) => d.type === 'math');
      latex = mathItems.map((m: any) => m.value || m.latex || '').join('\n');
    }

    // Confidence: based on whether we got substantial text back
    const confidence = text.length > 10 ? Math.min(95, 50 + text.length / 5) : 20;

    log(`Mathpix OCR success: ${text.length} chars text, ${latex.length} chars LaTeX (${confidence}% conf)`, 'INFO', 'mathpix');

    return { text, latex, confidence };
  } catch (err: any) {
    // Don't record usage on failure (allow retry)
    logError('Mathpix OCR failed', err);
    return { text: '', latex: '', confidence: 0, error: err.message };
  }
}

// ─── Query API ──────────────────────────────────────────────────────────────

function getStatus(): {
  enabled: boolean;
  dailyLimit: number;
  used: number;
  remaining: number;
  date: string;
  lastCallAt: number;
} {
  _ensureDate();
  return {
    enabled: ENABLED,
    dailyLimit: DAILY_LIMIT,
    used: _state.used,
    remaining: DAILY_LIMIT - _state.used,
    date: _state.date,
    lastCallAt: _state.lastCallAt,
  };
}

// ─── Initialization ──────────────────────────────────────────────────────────

function init() {
  if (!ENABLED) {
    log('Mathpix OCR disabled: MATHPIX_APP_ID or MATHPIX_APP_KEY not set', 'INFO', 'mathpix');
    return;
  }
  _restore();
  log(`Mathpix OCR initialized (daily limit: ${DAILY_LIMIT}, ${_state.used} used today)`, 'INFO', 'mathpix');
}

// Auto-initialize on first require
init();

module.exports = {
  // Core API
  ocrMath,
  checkBudget,
  recordUsage,

  // Query API
  getStatus,

  // Init
  init,

  // DI
  _injectDependencies,

  // Constants
  ENABLED,
  DAILY_LIMIT,
};
