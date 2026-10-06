'use strict';

// Lazy config access to avoid file-level circular require
// (config → config-remote-config → utils-fetch → config would yield empty {})
let _cachedConfig: any = null;
function _getConfig(): any {
  if (!_cachedConfig) _cachedConfig = require('./get-config');
  return _cachedConfig;
}
const nativeFetch: any = globalThis.fetch;

// Lazy logger to avoid top-level circular dependency:
// config → config-remote-config → utils-fetch → logger → config (cycle)
let _logger: any = null;
function _getLogger() { if (!_logger) _logger = require('./logger'); return _logger; }

async function fetchWithTimeout(url: any, options: any = {}, timeoutMs?: number) {
  const config = _getConfig();
  const effectiveTimeout = timeoutMs ?? config.REQUEST_TIMEOUT_MS ?? 30000;
  // TASK 108 (2026-10-03): If timeout is 0, don't set a timer at all.
  // This allows codegen providers to run without any fetch-level timeout.
  // The caller's own signal (if any) still controls abort.
  const useTimeout = effectiveTimeout > 0;
  const controller = new AbortController();
  const timeoutId = useTimeout ? setTimeout(() => controller.abort(), effectiveTimeout) : null;
  let externalAbortHandler;
  if (options.signal) { 
    externalAbortHandler = () => controller.abort(); 
    options.signal.addEventListener('abort', externalAbortHandler, { once: true }); 
    // Forward already-aborted signal immediately
    if (options.signal.aborted) { controller.abort(); }
  }
  if (!nativeFetch) {
    if (timeoutId) clearTimeout(timeoutId);
    if (options.signal && externalAbortHandler) { options.signal.removeEventListener('abort', externalAbortHandler); }
    throw new Error('No fetch implementation available (Node ≥ 20.6.0 required)');
  }
  try {
    const response = await nativeFetch(url, { ...options, signal: controller.signal });
    return response;
  } finally { 
    if (timeoutId) clearTimeout(timeoutId); 
    if (options.signal && externalAbortHandler) { options.signal.removeEventListener('abort', externalAbortHandler); }
  }
}

async function fetchJSON(url: any, options: any = {}, timeoutMs?: number) {
  const response = await fetchWithTimeout(url, options, timeoutMs);
  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    // v5-fix L2: Use targeted redaction (hex keys 32+, base64-ish 40+) instead of
    // the old aggressive pattern that redacted any 20+ char alphanumeric string
    // (which matched filenames, URLs, model names, etc.)
    const sanitized = errorText
      .replace(/(?:^|[\s:="'])[a-fA-F0-9]{32,}(?:[\s"'])/g, (match) => {
        return match.slice(0, -1) + '[REDACTED]';
      })
      .replace(/[A-Za-z0-9+/=]{40,}/g, '[REDACTED_BASE64]');
    throw new Error(`HTTP_ERROR_${response.status}: ${sanitized.substring(0, 200)}`);
  }
  return response.json();
}

module.exports = { fetchWithTimeout, fetchJSON };
