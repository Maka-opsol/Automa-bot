'use strict';
// Last modified: 2026-08-11 — Replaced Mathpix with Pix2Tex (free, local)

// ═══════════════════════════════════════════════════════════════════════════════
// Pix2Tex OCR Client — Free, local math OCR via Python pix2text package
//
// General vision models (Gemma, Qwen) are decent at reading text but terrible
// at math notation — they confuse superscripts, subscripts, fractions, Greek
// letters, integral signs, etc. Pix2Tex is purpose-built for math OCR.
//
// Key differences from Mathpix:
//   - 100% FREE (no API keys, no rate limits, no monthly quotas)
//   - Runs locally via Python child process (p2t CLI)
//   - No network dependency — works offline
//   - Requires: pip install pix2text (Python package)
//
// Prerequisites (one-time setup on the server):
//   pip install pix2text
//
// Graceful disable: no-op if `p2t` binary not found in PATH
// ═══════════════════════════════════════════════════════════════════════════════

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

let _deps: Record<string, any> = {};

function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function log(msg: string, level?: string, mod?: string) { _deps.logger?.log?.(msg, level, mod) ?? console.log(msg); }
function logError(msg: string, err: Error, ctx?: any) { _deps.logger?.logError?.(msg, err, ctx) ?? console.error(msg, err); }

function getDb() { return _deps.database?.db; }

// ─── Configuration ──────────────────────────────────────────────────────────

const P2T_TIMEOUT_MS = parseInt(process.env.PIX2TEX_TIMEOUT_MS || '30000', 10);
const ENABLE_LOCAL_VLM_FALLBACK = process.env.ENABLE_LOCAL_VLM !== 'false'; // default true

// ─── State ─────────────────────────────────────────────────────────────────

let _p2tAvailable: boolean | null = null; // null = not yet checked
let _p2tPath: string | null = null;
let _checkPromise: Promise<boolean> | null = null; // Guard against concurrent availability checks
let _callCount = 0;
let _failCount = 0;

// ─── Availability Check ───────────────────────────────────────────────────

/**
 * Check if p2t CLI is available. Cached after first check.
 * Uses a promise guard to prevent concurrent spawn storms.
 */
async function checkAvailability(): Promise<boolean> {
  if (_p2tAvailable !== null) return _p2tAvailable;
  if (_checkPromise) return _checkPromise;

  _checkPromise = new Promise<boolean>((resolve) => {
    const p2t = spawn('p2t', ['--help'], { timeout: 10000 });
    let stderr = '';
    p2t.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });
    p2t.on('close', (code) => {
      if (code === 0 || code === 2) { // exit 2 = invalid args but binary works
        _p2tAvailable = true;
        _p2tPath = 'p2t';
        log('Pix2Tex (p2t) CLI detected and available', 'INFO', 'pix2tex');
      } else {
        _p2tAvailable = false;
        log(`Pix2Tex (p2t) CLI not available (exit code ${code}). Install with: pip install pix2text`, 'WARN', 'pix2tex');
      }
      resolve(_p2tAvailable);
    });
    p2t.on('error', (err: Error) => {
      _p2tAvailable = false;
      log(`Pix2Tex (p2t) CLI not found: ${err.message}. Install with: pip install pix2text`, 'WARN', 'pix2tex');
      resolve(false);
    });
  });
  return _checkPromise;
}

/**
 * Synchronous check (for fast path when availability is already known).
 */
function isAvailable(): boolean {
  return _p2tAvailable === true;
}

// ─── Core API ──────────────────────────────────────────────────────────────

interface Pix2TexOCRResult {
  text: string;
  latex: string;
  confidence: number;
  error?: string;
}

/**
 * Write a base64 image to a temp file, run p2t on it, return the result.
 */
async function ocrMath(base64Image: string): Promise<Pix2TexOCRResult> {
  // Check availability first
  const available = await checkAvailability();
  if (!available) {
    return { text: '', latex: '', confidence: 0, error: 'Pix2Tex (p2t) not available' };
  }

  // Write base64 image to temp file
  let tmpPath: string | null = null;
  try {
    // Strip data URI prefix if present
    let rawBase64 = base64Image;
    if (base64Image.startsWith('data:')) {
      const commaIdx = base64Image.indexOf(',');
      if (commaIdx >= 0) rawBase64 = base64Image.substring(commaIdx + 1);
    }

    const buffer = Buffer.from(rawBase64, 'base64');

    // Write to temp directory (use /tmp on Render for writability)
    const tmpDir = process.env.RENDER ? '/tmp' : os.tmpdir();
    tmpPath = path.join(tmpDir, `p2t_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.png`);
    fs.writeFileSync(tmpPath, buffer);

    log(`Pix2Tex: Processing image (${(buffer.length / 1024).toFixed(1)}KB) via p2t...`, 'DEBUG', 'pix2tex');

    // Spawn p2t process
    const result = await new Promise<string>((resolve, reject) => {
      const p2t = spawn('p2t', ['--img-path', tmpPath], {
        timeout: P2T_TIMEOUT_MS,
        env: { ...process.env },
      });

      let stdout = '';
      let stderr = '';

      p2t.stdout.on('data', (data: Buffer) => { stdout += data.toString(); });
      p2t.stderr.on('data', (data: Buffer) => { stderr += data.toString(); });

      p2t.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`p2t exited with code ${code}: ${stderr.substring(0, 300)}`));
        } else {
          resolve(stdout.trim());
        }
      });

      p2t.on('error', (err: Error) => {
        reject(new Error(`p2t spawn failed: ${err.message}`));
      });
    });

    _callCount++;

    // Pix2Tex outputs text with LaTeX math notation
    const text = result;
    const latex = _extractLatex(text);

    // Confidence: based on output length and presence of math notation
    const confidence = _estimateConfidence(text);

    log(`Pix2Tex OCR success: ${text.length} chars text, ${latex.length} chars LaTeX (${confidence}% conf)`, 'INFO', 'pix2tex');

    return { text, latex, confidence };
  } catch (err: any) {
    _failCount++;
    logError('Pix2Tex OCR failed', err);
    return { text: '', latex: '', confidence: 0, error: err.message };
  } finally {
    // Clean up temp file
    if (tmpPath) {
      try { fs.unlinkSync(tmpPath); } catch { /* non-critical */ }
    }
  }
}

/**
 * Extract LaTeX expressions from Pix2Tex output.
 * Pix2Tex typically returns Markdown with inline/block LaTeX.
 */
function _extractLatex(text: string): string {
  if (!text) return '';

  const latexParts: string[] = [];

  // Extract block LaTeX: $$...$$
  const blockRegex = /\$\$([\s\S]*?)\$\$/g;
  let match;
  while ((match = blockRegex.exec(text)) !== null) {
    latexParts.push(match[1].trim());
  }

  // Extract inline LaTeX: $...$
  const inlineRegex = /(?<!\$)\$(?![\$])([^$]+)\$(?!\$)/g;
  while ((match = inlineRegex.exec(text)) !== null) {
    latexParts.push(match[1].trim());
  }

  // If no LaTeX delimiters found, check if the entire output is LaTeX
  if (latexParts.length === 0 && text.length > 0) {
    // Heuristic: if text contains LaTeX commands, treat the whole thing as LaTeX
    if (/\\frac|\\sqrt|\\int|\\sum|\\alpha|\\beta|\\theta|\\pi|\\left|\\right/.test(text)) {
      // Strip markdown formatting and return as LaTeX
      return text.replace(/^\$|\$$/g, '').trim();
    }
  }

  return latexParts.join('\n');
}

/**
 * Estimate confidence of Pix2Tex output.
 */
function _estimateConfidence(text: string): number {
  if (!text || text.trim().length === 0) return 0;

  let score = 50; // Base confidence

  const len = text.trim().length;

  // Longer output = more content extracted = higher confidence
  if (len > 20) score += 15;
  if (len > 50) score += 10;
  if (len > 100) score += 10;

  // LaTeX commands present = good quality (Pix2Tex understood the math)
  if (/\\frac|\\sqrt|\\int|\\sum|\\alpha|\\beta|\\theta/.test(text)) score += 15;

  // Mathematical notation present
  if (/[=+\-*/^]/.test(text) && /[a-zA-Z]/.test(text)) score += 5;

  // Penalty for suspicious characters
  const suspiciousChars = (text.match(/[?□▪▭◼○●■]/g) || []).length;
  score -= suspiciousChars * 10;

  return Math.max(0, Math.min(95, score));
}

// ─── Query API ──────────────────────────────────────────────────────────────

function getStatus(): {
  enabled: boolean;
  available: boolean;
  totalCalls: number;
  failedCalls: number;
  timeout: number;
} {
  return {
    enabled: isAvailable(),
    available: _p2tAvailable ?? false,
    totalCalls: _callCount,
    failedCalls: _failCount,
    timeout: P2T_TIMEOUT_MS,
  };
}

// ─── Initialization ──────────────────────────────────────────────────────────

async function init(): Promise<void> {
  await checkAvailability();
  if (_p2tAvailable) {
    log(`Pix2Tex OCR initialized (timeout: ${P2T_TIMEOUT_MS}ms, no rate limits)`, 'INFO', 'pix2tex');
  } else {
    log('Pix2Tex OCR disabled: p2t CLI not found. Install with: pip install pix2text', 'WARN', 'pix2tex');
  }
}

// Auto-initialize on first require
init().catch(() => {});

module.exports = {
  // Core API (same interface as services-mathpix for drop-in compatibility)
  ocrMath,
  checkBudget: () => ({ allowed: isAvailable(), remaining: Infinity, reason: isAvailable() ? undefined : 'p2t CLI not available' }),
  recordUsage: () => {}, // No rate limiting needed

  // Query API
  getStatus,

  // Init
  init,

  // Availability
  checkAvailability,
  isAvailable,

  // DI
  _injectDependencies,

  // Constants (compatibility)
  ENABLED: true, // Always "enabled" if p2t is installed; actual check is async
  DAILY_LIMIT: Infinity, // No rate limits
};
