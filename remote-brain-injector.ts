'use strict';
let _deps: Record<string, any> = {};
function _injectDependencies(deps: Record<string, any>) { _deps = deps; }
function getUpsertCalibration() { return _deps.database?.upsertCalibration; }
function getSelectCalibration() { return _deps.database?.selectCalibration; }

const { fetchJSON } = require('./utils-fetch');
const { log, logError } = require('./logger');

const REMOTE_BRAIN_URL = process.env.REMOTE_BRAIN_URL || null;

/**
 * Normalize unicode to prevent bypass via homoglyphs, zero-width chars, etc.
 * Strips control characters, zero-width sequences, and normalizes to NFC.
 */
function normalizeInstruction(raw: string): string {
  // Strip zero-width characters (ZWSP, ZWNJ, ZWJ, BOM, etc.)
  let cleaned = raw.replace(/[\u200B-\u200F\u2028-\u202F\u2060-\u206F\uFEFF\u00AD]/g, '');
  // Strip control characters except basic whitespace
  cleaned = cleaned.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Normalize unicode
  if (typeof cleaned.normalize === 'function') {
    cleaned = cleaned.normalize('NFC');
  }
  return cleaned;
}

/**
 * Validate a remote instruction against prompt-injection patterns.
 *
 * Defense-in-depth approach:
 * 1. Type + length check
 * 2. Unicode normalization to prevent bypass
 * 3. Pattern-based detection (expanded blocklist + regex)
 * 4. Structural limits (no raw URLs, no base64 blobs, line limit)
 */
function validateInstruction(instruction: any): boolean {
  if (typeof instruction !== 'string') return false;
  if (instruction.length > 500 || instruction.length === 0) return false;

  const normalized = normalizeInstruction(instruction);
  const lower = normalized.toLowerCase();

  // Expanded pattern list — covers direct commands, social engineering, and code injection
  const blockedPatterns = [
    // Direct override commands
    /ignore\s+(all\s+)?(previous|above|prior)/i,
    /new\s+instructions?/i,
    /system\s+prompt/i,
    /you\s+are\s+now/i,
    /pretend\s+(you\s+are|to\s+be)/i,
    /act\s+as\s+(if|a|an)/i,
    /roleplay\s+as/i,
    /forget\s+(everything|all|previous|your)/i,
    /disregard\s+(all\s+)?(previous|above|prior|your)/i,
    /override\s+(your|the|all)/i,

    // Code execution injection
    /child_process/i,
    /\beval\s*\(/i,
    /\brequire\s*\(/i,
    /process\.env/i,
    /\bexec\s*\(/i,
    /\bFunction\s*\(/i,
    /\bspawn\s*\(/i,

    // Prototype pollution
    /__proto__/i,
    /constructor\s*\[/i,
    /prototype\s*\[/i,

    // Obfuscation attempts
    /\\u[0-9a-f]{4}/i,           // Unicode escapes
    /\\x[0-9a-f]{2}/i,           // Hex escapes
    /base64/i,                     // Base64 encoded payloads
    /atob\s*\(/i,                 // Base64 decode
    /btoa\s*\(/i,                 // Base64 encode
    /fromCharCode/i,               // Char code obfuscation

    // URL / external resource injection
    /https?:\/\/[\S]{20,}/i,     // Long URLs (likely external references)
  ];

  for (const pattern of blockedPatterns) {
    if (pattern.test(normalized)) {
      log(`Remote brain instruction rejected: matched blocked pattern`, 'WARN', 'brain');
      return false;
    }
  }

  // Structural limits
  const lineCount = normalized.split('\n').length;
  if (lineCount > 10) {
    log('Remote brain instruction rejected: too many lines', 'WARN', 'brain');
    return false;
  }

  // Block if it contains more than 2 URLs (likely external resource injection)
  const urlCount = (normalized.match(/https?:\/\//g) || []).length;
  if (urlCount > 2) {
    log('Remote brain instruction rejected: too many URLs', 'WARN', 'brain');
    return false;
  }

  return true;
}

class RemoteBrainInjector {
  async fetchStrategy() {
    if (!REMOTE_BRAIN_URL) return null;
    try {
      const headers: Record<string, string> = {};
      if (process.env.BRAIN_API_KEY) { headers['X-Api-Key'] = process.env.BRAIN_API_KEY; }
      const data = await fetchJSON(REMOTE_BRAIN_URL, { headers }, 5000);
      if (data && data.instruction && validateInstruction(data.instruction)) {
        getUpsertCalibration()?.run('active_remote_instruction', data.instruction, Date.now());
        log(`Remote Brain updated: ${data.instruction.substring(0, 50)}...`, 'INFO', 'brain');
        return data.instruction;
      } else if (data && data.instruction) {
        log('Remote Brain instruction failed validation, ignoring', 'WARN', 'brain');
      }
    } catch (e: any) { logError('Remote Brain fetch failed', e); }
    return null;
  }

  getActiveInstruction() {
    const row = getSelectCalibration()?.get('active_remote_instruction');
    return row ? row.value : null;
  }

  augmentPrompt(basePrompt: any) {
    const instruction = this.getActiveInstruction();
    if (instruction) { return `${basePrompt}\n\n[REMOTE OVERRIDE]: ${instruction}`; }
    return basePrompt;
  }
}

module.exports = Object.assign(new RemoteBrainInjector(), { _injectDependencies, validateInstruction });
