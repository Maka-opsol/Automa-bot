'use strict';

// Browser-only proxy policy. Never log or return the original URL in errors.
export interface BrowserProxy { server: string; username?: string; password?: string }

export function configuredProxyUrl(config: Record<string, any> = {}): string | null {
  const explicit = String(config.BROWSER_PROXY_URL || process.env.BROWSER_PROXY_URL || '').trim();
  if (explicit) return explicit;
  const legacy = String(config.PROXY_URLS || process.env.PROXY_URLS || '').trim();
  if (!legacy) return null;
  return legacy.split(',')[0].trim() || legacy;
}

export function browserProxy(config: Record<string, any> = {}): BrowserProxy | undefined {
  const raw = configuredProxyUrl(config);
  if (!raw) return undefined;
  if ((globalThis as any).__proxyDisabled) throw new Error('Browser proxy is configured but proxy use is disabled by runtime policy; refusing direct connection');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid browser proxy URL'); }
  if (!['http:', 'https:', 'socks4:', 'socks5:'].includes(url.protocol) || !url.hostname || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new Error('Invalid browser proxy URL: use an HTTP(S) or SOCKS URL without a path, query or fragment');
  }
  if ((url.protocol === 'socks4:' || url.protocol === 'socks5:') && (url.username || url.password)) {
    throw new Error('Authenticated SOCKS proxies are not supported by Playwright Chromium');
  }
  const result: BrowserProxy = { server: `${url.protocol}//${url.host}` };
  try {
    if (url.username) result.username = decodeURIComponent(url.username);
    if (url.password) result.password = decodeURIComponent(url.password);
  } catch { throw new Error('Invalid percent-encoded browser proxy credentials'); }
  return result;
}

// Proxy errors may contain arbitrary strings (including malformed URLs); do not
// pass them to loggers, telemetry or callers when a proxy is configured.
export function safeBrowserError(err: unknown, config: Record<string, any> = {}): string {
  return configuredProxyUrl(config) ? 'browser operation failed with a configured proxy (details withheld)' : (err instanceof Error ? err.message : String(err));
}

export function proxyLaunchOptions(config: Record<string, any> = {}): Record<string, any> {
  // Chromium needs per-context proxy mode for context-level proxies on Linux.
  return browserProxy(config) ? { proxy: { server: 'per-context' } } : {};
}

export function proxyContextOptions(config: Record<string, any> = {}): Record<string, any> {
  const proxy = browserProxy(config);
  return proxy ? { proxy } : {};
}
