'use strict';

// Optional, passive metadata only. Never pass through URL, hostname, pathname,
// exception text, headers, page content or credentials to the logger.
const PHASES = new Set(['login_check', 'entry_domcontentloaded', 'entry_late_load_wait', 'post_entry_wait', 'login_decision', 'guard_handoff', 'auth_handoff', 'assignments_load', 'assignments_return_load']);
const OUTCOMES = new Set(['legacy_true_app_unverified', 'legacy_true_external_unverified', 'legacy_true_other_unverified', 'guard_returned_false', 'guard_returned_nonfalse_unverified', 'auth_returned_unverified', 'no_auth_module', 'exception', 'completed', 'failed']);
const CODES = new Set(['ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_NAME_NOT_RESOLVED', 'ERR_PROXY_CONNECTION_FAILED', 'ERR_TUNNEL_CONNECTION_FAILED', 'ERR_CERT_AUTHORITY_INVALID', 'ERR_CERT_DATE_INVALID', 'ERR_ABORTED', 'ERR_NETWORK_CHANGED', 'ERR_INTERNET_DISCONNECTED', 'ERR_SSL_PROTOCOL_ERROR']);
function errorCode(error) {
  try {
    const text = typeof error === 'string' ? error : typeof error?.message === 'string' ? error.message : '';
    // Ignore user-controlled suffixes: emit only a matching fixed token.
    const hits = text.slice(0, 16384).match(/\bERR_[A-Z_]+\b/g) || [];
    const code = hits.find(c => CODES.has(c));
    if (code) return code;
    if (error?.name === 'TimeoutError' || error?.constructor?.name === 'TimeoutError') return 'TIMEOUT';
    return 'OTHER';
  } catch { return 'OTHER'; }
}
function location(value, appUrl) {
  try {
    const u = new URL(value);
    if (u.protocol === 'chrome-error:') return { host: 'browser_error', route: 'browser_error' };
    if (!['http:', 'https:'].includes(u.protocol)) return { host: 'other_scheme', route: 'other' };
    let host = 'external';
    try { const app = new URL(appUrl); if (['http:', 'https:'].includes(app.protocol) && u.origin === app.origin) host = 'app_origin'; } catch {}
    if (host !== 'app_origin' && ['login.microsoftonline.com', 'login.live.com', 'login.microsoft.com'].includes(u.hostname.toLowerCase())) host = 'microsoft_login';
    let route = 'other';
    const p = u.pathname.toLowerCase().replace(/\/+$/, '') || '/';
    if (p === '/') route = 'root';
    else if (host === 'app_origin' && (p === '/assignments' || p.startsWith('/assignments/'))) route = 'assignments';
    else if (/\/(?:oauth2|oauth2\/v2\.0)\/authorize$/.test(p)) route = 'authorize';
    else if (/\/(?:login|signin|sign-in)$/.test(p)) route = 'login';
    return { host, route };
  } catch { return { host: 'unknown', route: 'unknown' }; }
}
function statusGroup(n) {
  if (n === 401) return '401'; if (n === 403) return '403'; if (n === 429) return '429';
  if (n >= 200 && n < 300) return '2xx'; if (n >= 300 && n < 400) return '3xx';
  if (n >= 400 && n < 500) return 'other_4xx'; if (n >= 500 && n < 600) return '5xx'; return 'other';
}
function attachAuthNetDiagnostics(page, workerId, appUrl, proxyDisabled, log) {
  // Even if the logger or page object is faulty, telemetry must not affect work.
  try {
    const id = Number.isInteger(workerId) && workerId >= 0 && workerId <= 100000 ? workerId : 0;
    let seq = 0, span = null, windowStart = Date.now(), count = 0;
    const seen = new Map();
    function emit(event, extra = {}) {
      try {
        const now = Date.now();
        if (now - windowStart >= 60000 || now < windowStart) { windowStart = now; count = 0; seen.clear(); }
        const payload = { event, worker: id, attempt: span?.id || 0, phase: span?.phase || 'unscoped',
          elapsed_ms: span ? Math.min(300000, Math.max(0, Math.round((now - span.started) / 100) * 100)) : 0,
          proxy_disabled_flag: proxyDisabled ? 'true' : 'false', ...extra };
        // Deduplicate identical classifications for 2s without treating elapsed time as unique.
        const key = JSON.stringify({ ...payload, elapsed_ms: 0 });
        if (count >= 60 || (seen.has(key) && now - seen.get(key) < 2000)) return;
        count++; seen.set(key, now); if (seen.size > 60) seen.delete(seen.keys().next().value);
        log(`[authnet-diag] ${JSON.stringify(payload)}`, 'INFO', 'parallel');
      } catch {}
    }
    const safeLocation = () => { try { return location(page.url(), appUrl); } catch { return {host:'unknown', route:'unknown'}; } };
    function mainRequest(request) { try { return request.isNavigationRequest() && request.frame() === page.mainFrame(); } catch { return false; } }
    try {
      page.on('request', request => { try { if (!mainRequest(request)) return; emit('request', { ...location(request.url(), appUrl), redirected: request.redirectedFrom() ? 'yes' : 'no' }); } catch {} });
      page.on('response', response => { try { const req = response.request(); if (!mainRequest(req)) return; emit('response', { ...location(response.url(), appUrl), status: statusGroup(response.status()), redirected: req.redirectedFrom() ? 'yes' : 'no' }); } catch {} });
      page.on('requestfailed', request => { try { if (!mainRequest(request)) return; emit('request_failed', { ...location(request.url(), appUrl), error_code: errorCode(request.failure()?.errorText) }); } catch {} });
      page.on('framenavigated', frame => { try { if (frame === page.mainFrame()) emit('commit', location(frame.url(), appUrl)); } catch {} });
    } catch {}
    return {
      begin(phase) { try { span = { id: (seq = (seq % 1000000) + 1), phase: PHASES.has(phase) ? phase : 'unknown', started: Date.now() }; emit('begin', safeLocation()); } catch {} },
      step(phase) { try { if (!span) return; span.phase = PHASES.has(phase) ? phase : 'unknown'; emit('step', safeLocation()); } catch {} },
      finish(outcome, error) { try { if (!span) return; emit('end', { ...safeLocation(), outcome: OUTCOMES.has(outcome) ? outcome : 'unknown', ...(error ? { error_code: errorCode(error) } : {}) }); span = null; } catch { span = null; } },
      classify() { return safeLocation().host; }
    };
  } catch { return null; }
}
module.exports = { attachAuthNetDiagnostics, errorCode, location, statusGroup };
