// Optional passive diagnostics. Never log URL, origin, path, header value, or raw error.
// All output values are from fixed allowlists; no page content is collected.
export function attachRenderDiagnostics(page: any, workerId: number, log: any): void {
  let emitted = 0;
  const safeId = Number.isSafeInteger(workerId) && workerId >= 0 && workerId <= 999 ? workerId : 0;
  const maxEvents = 20;
  function emit(message: string): void {
    if (emitted >= maxEvents) return;
    emitted++;
    try { log(`[WORKER-${safeId}] [render-diag] ${message}`, 'DEBUG', 'parallel'); } catch {}
  }
  // WARN-level emitter (visible in INFO/WARN log views; emit() is DEBUG-filtered
  // so its lines never reach the dashboard). Used for pageerror + flutter-script
  // load failures — the bot's mounting failure (bodyLen=1478 stuck, scripts=8)
  // is an uncaught JS error during _flutter.loader.loadEntrypoint / main.dart.js
  // execution, which was previously invisible (no pageerror capture + DEBUG
  // events filtered). Uncapped: pageerrors are rare + critical.
  function emitWarn(message: string): void {
    try { log(`[WORKER-${safeId}] [render-diag] ${message}`, 'WARN', 'parallel'); } catch {}
  }
  function kind(url: string, resourceType: string): string | null {
    try {
      const path = new URL(url).pathname.toLowerCase();
      const name = path.slice(path.lastIndexOf('/') + 1);
      // Classification only; none of the path is ever returned or logged.
      if (/^(?:pdf(?:js|\.worker)?)(?:\.min)?\.(?:js|mjs)$/.test(name)) return 'pdf-script';
      if (/^(?:flutter(?:_bootstrap)?|main\.dart|canvaskit)\.js$/.test(name)) return 'flutter-script';
      return resourceType === 'script' ? 'other-script' : null;
    } catch { return resourceType === 'script' ? 'other-script' : null; }
  }
  function origin(request: any): string {
    try {
      const target = new URL(request.url());
      const frame = new URL(request.frame().url());
      if (!['http:', 'https:'].includes(target.protocol) || !['http:', 'https:'].includes(frame.protocol)) return 'unknown';
      return target.origin === frame.origin ? 'same' : 'external';
    } catch { return 'unknown'; }
  }
  function statusGroup(status: number): string {
    if (status >= 200 && status < 300) return '2xx';
    if (status >= 300 && status < 400) return '3xx';
    if (status >= 400 && status < 500) return '4xx';
    if (status >= 500 && status < 600) return '5xx';
    return 'other';
  }
  function failureGroup(text: any): string {
    // Exact, fixed error names only. Never emit the input, even on malformed data.
    const codes: Record<string, string> = {
      'net::ERR_ABORTED': 'aborted', 'net::ERR_BLOCKED_BY_CLIENT': 'client-block',
      'net::ERR_BLOCKED_BY_RESPONSE': 'response-block', 'net::ERR_BLOCKED_BY_CSP': 'csp-block',
      'net::ERR_NAME_NOT_RESOLVED': 'dns', 'net::ERR_TIMED_OUT': 'timeout',
      'net::ERR_CONNECTION_TIMED_OUT': 'timeout', 'net::ERR_CONNECTION_REFUSED': 'connection',
      'net::ERR_CONNECTION_RESET': 'connection', 'net::ERR_CONNECTION_CLOSED': 'connection',
      'net::ERR_CERT_AUTHORITY_INVALID': 'tls', 'net::ERR_CERT_DATE_INVALID': 'tls'
    };
    return typeof text === 'string' && Object.prototype.hasOwnProperty.call(codes, text) ? codes[text] : 'other';
  }
  function cspFlags(value: any): string {
    if (typeof value !== 'string' || !value) return 'absent';
    const names = new Set(value.slice(0, 16384).split(';').slice(0, 100).map(v => v.trim().split(/\s+/, 1)[0].toLowerCase()));
    return `present,script-src=${names.has('script-src') ? 1 : 0},script-src-elem=${names.has('script-src-elem') ? 1 : 0},default-src=${names.has('default-src') ? 1 : 0}`;
  }
  try {
    // A browser-console CSP violation is a hint, not proof: page code can forge console text.
    // Inspect only a bounded prefix and emit neither the text nor any policy values.
    page.on('console', (msg: any) => {
      try {
        if (msg.type() !== 'error') return;
        const text = msg.text().slice(0, 4096);
        if (text.includes('violates the following Content Security Policy directive'))
          emit(`csp-violation hint=console kind=${text.includes('script-src') ? 'script' : 'other'}`);
      } catch {}
    });
    page.on('requestfailed', (request: any) => {
      try {
        const type = request.resourceType();
        const label = kind(request.url(), type);
        if (!label) return;
        emitWarn(`request-failed kind=${label} origin=${origin(request)} reason=${failureGroup(request.failure()?.errorText)}`);
      } catch {}
    });
    page.on('response', (response: any) => {
      try {
        const request = response.request();
        const type = request.resourceType();
        if (type === 'document' && request.frame() === page.mainFrame()) {
          // Asynchronous metadata only. The app is never delayed by header collection.
          Promise.resolve(response.headers()).then((headers: any) => {
            try { emit(`csp enforced=${cspFlags(headers?.['content-security-policy'])} report-only=${cspFlags(headers?.['content-security-policy-report-only'])}`); } catch {}
          }).catch(() => {});
        }
        const label = kind(request.url(), type);
        if (!label) return;
        const status = Number(response.status());
        // Successes for generic scripts are noise; preserve PDF/Flutter status.
        if (label === 'other-script' && status < 400) return;
        // Elevate non-2xx flutter/pdf responses to WARN (visible) — a 4xx/5xx on
        // main.dart.js / canvaskit / flutter.js / pdf.min.mjs explains a
        // non-mounting app (the bundle loaded-but-failed).
        if (status >= 400) emitWarn(`response kind=${label} origin=${origin(request)} status=${statusGroup(status)}`);
        else emit(`response kind=${label} origin=${origin(request)} status=${statusGroup(status)}`);
      } catch {}
    });
    // pageerror (2026-11-25): uncaught JS errors. The bot's mounting failure
    // (flutterLoaded=true, flutterBootstrap=true, scripts=8, bodyLen=1478) means
    // flutter.js ran + _flutter was set, but _flutter.loader.loadEntrypoint never
    // loaded main.dart.js — most likely because loadEntrypoint or main.dart.js
    // THREW an uncaught error. This was previously invisible (no pageerror
    // capture). Emit a CLASSIFIED summary only (type + token hints) — never the
    // raw message, which may contain URLs/page content.
    page.on('pageerror', (err: any) => {
      try {
        const msg = String((err && err.message) || err || '').slice(0, 4096);
        const type = err instanceof Error ? err.constructor.name : 'Error';
        const lower = msg.toLowerCase();
        const hints: string[] = [];
        if (/pdfjslib/.test(lower)) hints.push('pdfjsLib');
        if (/loadentrypoint/.test(lower)) hints.push('loadEntrypoint');
        if (/_flutter/.test(lower)) hints.push('_flutter');
        if (/canvaskit/.test(lower)) hints.push('canvaskit');
        if (/main\.dart/.test(lower)) hints.push('main.dart');
        if (/is not defined/.test(lower)) hints.push('not-defined');
        if (/unexpected token/.test(lower)) hints.push('syntax');
        if (/failed to fetch/.test(lower)) hints.push('fetch-failed');
        emitWarn(`pageerror type=${type}${hints.length ? ' hints=' + hints.join(',') : ''}`);
      } catch {}
    });
  } catch {}
}
